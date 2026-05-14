const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { io: makeClient } = require("socket.io-client");
const { createGameServer, createRoomPersistence } = require("../server");

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(server.address().port);
    });
  });
}

function connectClient(url) {
  const socket = makeClient(url, {
    transports: ["websocket"],
    forceNew: true,
    reconnection: false
  });
  const client = {
    socket,
    state: null,
    waiters: []
  };

  socket.on("state", (state) => {
    client.state = state;
    for (const waiter of [...client.waiters]) {
      if (waiter.predicate(state)) {
        client.waiters = client.waiters.filter((item) => item !== waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(state);
      }
    }
  });

  client.connected = new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });

  client.waitFor = (predicate, label, timeoutMs = 4000) => {
    if (client.state && predicate(client.state)) return Promise.resolve(client.state);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          client.waiters = client.waiters.filter((item) => item !== waiter);
          reject(new Error(`Timed out waiting for ${label}`));
        }, timeoutMs)
      };
      client.waiters.push(waiter);
    });
  };

  client.emit = (event, payload = {}) => new Promise((resolve, reject) => {
    socket.emit(event, payload, (response) => {
      if (!response?.ok) {
        reject(new Error(response?.error || `${event} failed`));
        return;
      }
      resolve(response);
    });
  });

  client.waitForChat = (predicate, label, timeoutMs = 4000) => {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off("chatMessage", handler);
        reject(new Error(`Timed out waiting for chat ${label}`));
      }, timeoutMs);
      const handler = (chat) => {
        if (predicate(chat)) {
          clearTimeout(timer);
          socket.off("chatMessage", handler);
          resolve(chat);
        }
      };
      socket.on("chatMessage", handler);
    });
  };

  return client;
}

async function main() {
  await testProcessRestartRestore();
  await testEmptyPlayingRoomGracePeriod();
  await testStartRequiresConnectedPlayers();
  await testHostKickPlayer();
  await testSpectatorPasswordAndHiddenFullHandView();
  await testPlayerCountModes();
  await testSurrenderVoteFlow();
  await testFullGameFlow();
}

async function testProcessRestartRestore() {
  const filePath = path.join(os.tmpdir(), `gongzhu-rooms-${process.pid}-${Date.now()}.json`);
  const clientIds = ["persist-a", "persist-b", "persist-c", "persist-d"];
  let serverOne = createGameServer({
    trickSettleDelayMs: 80,
    exposeDurationMs: 5000,
    saveDebounceMs: 0,
    persistence: createRoomPersistence({ filePath })
  });
  await serverOne.ready;
  let port = await listen(serverOne.server);
  let url = `http://127.0.0.1:${port}`;
  let clients = Array.from({ length: 4 }, () => connectClient(url));

  await Promise.all(clients.map((client) => client.connected));
  const { code } = await clients[0].emit("createRoom", { name: "甲", clientId: clientIds[0] });
  await clients[1].emit("joinRoom", { code, name: "乙", clientId: clientIds[1] });
  await clients[2].emit("joinRoom", { code, name: "丙", clientId: clientIds[2] });
  await clients[3].emit("joinRoom", { code, name: "丁", clientId: clientIds[3] });
  await clients[0].emit("startGame");
  await Promise.all(clients.map((client) => client.waitFor(
    (state) => state.round?.phase === "expose" && state.hand.length === 13,
    "started before restart"
  )));
  const seatBefore = clients[2].state.me.seat;
  const handBefore = clients[2].state.hand.map((card) => card.id).sort();

  for (const client of clients) client.socket.disconnect();
  await serverOne.close();
  await serverOne.io.close();
  await new Promise((resolve) => serverOne.server.close(resolve));

  const serverTwo = createGameServer({
    trickSettleDelayMs: 80,
    exposeDurationMs: 5000,
    saveDebounceMs: 0,
    persistence: createRoomPersistence({ filePath })
  });
  await serverTwo.ready;
  port = await listen(serverTwo.server);
  url = `http://127.0.0.1:${port}`;
  const restoredClient = connectClient(url);

  try {
    await restoredClient.connected;
    await restoredClient.emit("joinRoom", { code, name: "丙", clientId: clientIds[2] });
    await restoredClient.waitFor(
      (state) => state.me?.seat === seatBefore
        && state.players[seatBefore]?.connected === true
        && state.round?.phase === "expose"
        && state.hand.length === 13,
      "restored room after process restart"
    );
    assert.deepEqual(restoredClient.state.hand.map((card) => card.id).sort(), handBefore);
    assert.equal(serverTwo.rooms.size, 1);
    console.log("restore ok");
  } finally {
    restoredClient.socket.disconnect();
    await serverTwo.close();
    await serverTwo.io.close();
    await new Promise((resolve) => serverTwo.server.close(resolve));
    await fs.rm(filePath, { force: true });
  }
}

async function testFullGameFlow() {
  const { server, io, ready } = createGameServer({ trickSettleDelayMs: 80, exposeDurationMs: 80 });
  await ready;
  const port = await listen(server);
  const url = `http://127.0.0.1:${port}`;
  const clientIds = ["client-a", "client-b", "client-c", "client-d"];
  const clients = Array.from({ length: 4 }, () => connectClient(url));

  try {
    await Promise.all(clients.map((client) => client.connected));

    const { code } = await clients[0].emit("createRoom", { name: "甲", clientId: clientIds[0] });
    assert.match(code, /^[A-Z2-9]{4}$/);

    await clients[1].emit("joinRoom", { code, name: "乙", clientId: clientIds[1] });
    await clients[2].emit("joinRoom", { code, name: "丙", clientId: clientIds[2] });
    await clients[3].emit("joinRoom", { code, name: "丁", clientId: clientIds[3] });
    await Promise.all(clients.map((client) => client.waitFor(
      (state) => state.players.length === 4,
      "four players"
    )));

    const chatSeen = clients[1].waitForChat(
      (chat) => chat.text === "大家好" && chat.senderName === "甲",
      "broadcast"
    );
    await clients[0].emit("chatMessage", { text: "大家好" });
    await chatSeen;

    await clients[0].emit("startGame");
    await Promise.all(clients.map((client) => client.waitFor(
      (state) => state.round?.phase === "expose" && state.hand.length === 13,
      "expose phase"
    )));

    const reconnectSeat = clients[2].state.me.seat;
    const reconnectHand = clients[2].state.hand.map((card) => card.id).sort();
    clients[2].socket.disconnect();
    await clients[0].waitFor(
      (state) => state.players[reconnectSeat]?.connected === false,
      "player disconnect"
    );

    const reconnectedClient = connectClient(url);
    await reconnectedClient.connected;
    await reconnectedClient.emit("joinRoom", { code, name: "丙", clientId: clientIds[2] });
    await reconnectedClient.waitFor(
      (state) => state.me?.seat === reconnectSeat
        && state.players[reconnectSeat]?.connected === true
        && state.hand.length === 13,
      "player reconnect"
    );
    assert.deepEqual(reconnectedClient.state.hand.map((card) => card.id).sort(), reconnectHand);
    clients[2] = reconnectedClient;

    for (const client of clients) {
      await client.emit("exposeCards", { cardIds: client.state.canExpose });
    }

    await Promise.all(clients.map((client) => client.waitFor(
      (state) => state.round?.phase === "play",
      "play phase"
    )));

    const reactionSeen = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for player reaction")), 1000);
      clients[1].socket.once("playerReaction", (reaction) => {
        clearTimeout(timer);
        resolve(reaction);
      });
    });
    await clients[0].emit("playerReaction", { targetSeat: clients[1].state.me.seat, kind: "like" });
    const reaction = await reactionSeen;
    assert.equal(reaction.kind, "like");
    assert.equal(reaction.fromSeat, clients[0].state.me.seat);
    assert.equal(reaction.targetSeat, clients[1].state.me.seat);

    let sawSettlingTrick = false;

    let guard = 0;
    while (clients[0].state.round.phase !== "finished" && guard < 80) {
      if (clients[0].state.round.settlingTrick) {
        sawSettlingTrick = true;
        assert.equal(clients[0].state.round.trick.length, 4);
        await clients[0].waitFor(
          (state) => state.round?.phase === "finished" || !state.round?.settlingTrick,
          "trick settlement"
        );
        continue;
      }
      const currentSeat = clients[0].state.round.currentPlayer;
      const currentClient = clients.find((client) => client.state.me?.seat === currentSeat);
      assert.ok(currentClient, `current client for seat ${currentSeat}`);
      await currentClient.waitFor(
        (state) => state.round?.phase === "play"
          && state.round.currentPlayer === currentSeat
          && state.legalPlays.length > 0,
        `legal play for seat ${currentSeat}`
      );
      await currentClient.emit("playCard", { cardId: currentClient.state.legalPlays[0] });
      if (clients[0].state.round?.settlingTrick) {
        sawSettlingTrick = true;
        assert.equal(clients[0].state.round.trick.length, 4);
      }
      await clients[0].waitFor(
        (state) => state.round?.phase === "finished"
          || state.round?.currentPlayer !== currentSeat
          || state.round?.trick.length === 0,
        "next turn"
      );
      guard += 1;
    }

    assert.equal(clients[0].state.round.phase, "finished");
    assert.equal(sawSettlingTrick, true);
    assert.equal(clients[0].state.players.every((player) => player.handCount === 0), true);
    assert.equal(clients[0].state.round.finishedScores.length, 4);
    assert.ok(clients[0].state.round.pigSeats.length >= 1);
    assert.equal(
      clients[0].state.players.reduce((sum, player) => sum + player.pigCount, 0),
      clients[0].state.round.pigSeats.length
    );
    assert.equal(clients[0].state.players.every((player) => player.totalScore === undefined), true);
    const publicScoreCardIds = clients[0].state.players.flatMap((player) => player.scoreCards.map((card) => card.id));
    for (const id of ["SQ", "DJ", "C10", "H5", "HA"]) {
      assert.ok(publicScoreCardIds.includes(id), `score cards should include ${id}`);
    }
    console.log("online ok");
  } finally {
    for (const client of clients) client.socket.disconnect();
    await io.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function testEmptyPlayingRoomGracePeriod() {
  const { server, io, ready, rooms } = createGameServer({
    trickSettleDelayMs: 10,
    exposeDurationMs: 200,
    emptyPlayingRoomTtlMs: 120
  });
  await ready;
  const port = await listen(server);
  const url = `http://127.0.0.1:${port}`;
  const clientIds = ["empty-0", "empty-1", "empty-2", "empty-3"];
  const clients = Array.from({ length: 4 }, () => connectClient(url));

  try {
    await Promise.all(clients.map((client) => client.connected));
    const { code } = await clients[0].emit("createRoom", { name: "甲", clientId: clientIds[0] });
    for (let index = 1; index < clients.length; index += 1) {
      await clients[index].emit("joinRoom", { code, name: `玩家${index}`, clientId: clientIds[index] });
    }
    await clients[0].emit("startGame");
    await clients[0].waitFor((state) => state.phase === "playing", "playing before empty");

    for (const client of clients) client.socket.disconnect();
    assert.equal(rooms.has(code), true);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(rooms.has(code), true);

    const reconnected = connectClient(url);
    await reconnected.connected;
    await reconnected.emit("joinRoom", { code, name: "甲", clientId: clientIds[0] });
    await reconnected.waitFor((state) => state.code === code && state.me?.seat === 0, "empty room reconnect");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(rooms.has(code), true);
    reconnected.socket.disconnect();

    await new Promise((resolve) => setTimeout(resolve, 160));
    assert.equal(rooms.has(code), false);
    console.log("empty room grace ok");
  } finally {
    for (const client of clients) client.socket.disconnect();
    await io.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function testStartRequiresConnectedPlayers() {
  const { server, io, ready, rooms } = createGameServer({ trickSettleDelayMs: 10, exposeDurationMs: 200 });
  await ready;
  const port = await listen(server);
  const url = `http://127.0.0.1:${port}`;
  const clientIds = ["online-0", "online-1", "online-2", "online-3"];
  const clients = Array.from({ length: 4 }, () => connectClient(url));

  try {
    await Promise.all(clients.map((client) => client.connected));
    const { code } = await clients[0].emit("createRoom", { name: "甲", clientId: clientIds[0] });
    for (let index = 1; index < clients.length; index += 1) {
      await clients[index].emit("joinRoom", { code, name: `玩家${index}`, clientId: clientIds[index] });
    }
    await clients[0].emit("startGame");
    await clients[0].waitFor((state) => state.round?.phase === "expose", "started before disconnect");
    clients[3].socket.disconnect();
    await clients[0].waitFor((state) => state.players[3]?.connected === false, "offline player before new round");
    rooms.get(code).round.phase = "finished";
    await assert.rejects(
      () => clients[0].emit("newRound"),
      /所有玩家在线后才能开始/
    );

    const reconnected = connectClient(url);
    await reconnected.connected;
    await reconnected.emit("joinRoom", { code, name: "玩家3", clientId: clientIds[3] });
    await clients[0].waitFor((state) => state.players[3]?.connected === true, "offline player rejoined before new round");
    await clients[0].emit("newRound");
    await clients[0].waitFor((state) => state.round?.phase === "expose" && state.round.handNumber === 2, "new round after reconnect");
    reconnected.socket.disconnect();
    console.log("connected start guard ok");
  } finally {
    for (const client of clients) client.socket.disconnect();
    await io.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function testHostKickPlayer() {
  const { server, io, ready } = createGameServer({ trickSettleDelayMs: 10, exposeDurationMs: 20 });
  await ready;
  const port = await listen(server);
  const url = `http://127.0.0.1:${port}`;
  const clients = Array.from({ length: 3 }, () => connectClient(url));

  try {
    await Promise.all(clients.map((client) => client.connected));
    const { code } = await clients[0].emit("createRoom", { name: "房主", clientId: "kick-0" });
    await clients[1].emit("joinRoom", { code, name: "乙", clientId: "kick-1" });
    await clients[2].emit("joinRoom", { code, name: "丙", clientId: "kick-2" });
    await clients[0].waitFor((state) => state.players.length === 3 && state.players[0].isHost === true, "host badge");

    await assert.rejects(
      () => clients[1].emit("kickPlayer", { seat: 2 }),
      /只有房主能踢人/
    );

    const kicked = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for kicked event")), 1000);
      clients[2].socket.once("kicked", (payload) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
    await clients[0].emit("kickPlayer", { seat: 2 });
    const payload = await kicked;
    assert.equal(payload.message, "你已被房主移出房间。");
    await clients[0].waitFor((state) => state.players.length === 2 && state.players.every((player) => player.name !== "丙"), "player kicked");
    console.log("host kick ok");
  } finally {
    for (const client of clients) client.socket.disconnect();
    await io.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function testSpectatorPasswordAndHiddenFullHandView() {
  const { server, io, ready } = createGameServer({ trickSettleDelayMs: 10, exposeDurationMs: 200 });
  await ready;
  const port = await listen(server);
  const url = `http://127.0.0.1:${port}`;
  const clients = Array.from({ length: 5 }, () => connectClient(url));

  try {
    await Promise.all(clients.map((client) => client.connected));
    const { code } = await clients[0].emit("createRoom", { name: "甲", clientId: "spectator-0" });
    await clients[1].emit("joinRoom", { code, name: "乙", clientId: "spectator-1" });
    await clients[2].emit("joinRoom", { code, name: "丙", clientId: "spectator-2" });
    await clients[3].emit("joinRoom", { code, name: "丁", clientId: "spectator-3" });
    await clients[0].waitFor((state) => state.players.length === 4, "full room before spectator");
    const messagesBefore = clients[0].state.messages.length;

    await assert.rejects(
      () => clients[4].emit("joinRoom", { code, name: "观众", clientId: "spectator-4" }),
      /观众需要输入正确密码/
    );
    await clients[4].emit("joinRoom", { code, name: "观众", clientId: "spectator-4", spectatorPassword: "2026" });
    await clients[4].waitFor((state) => state.role === "spectator" && state.me === null, "spectator joined");
    await clients[0].waitFor((state) => state.players.length === 4, "players still only see players");
    assert.equal(clients[0].state.spectators, undefined);
    assert.equal(clients[0].state.messages.length, messagesBefore);

    await clients[0].emit("startGame");
    await clients[4].waitFor(
      (state) => state.role === "spectator"
        && state.round?.phase === "expose"
        && state.allHands?.length === 4
        && state.allHands.every((hand) => hand.length === 13),
      "spectator full hand view"
    );
    assert.equal(clients[4].state.hand.length, 0);
    assert.equal(clients[4].state.legalPlays.length, 0);
    assert.equal(clients[4].state.canExpose.length, 0);

    await assert.rejects(
      () => clients[4].emit("chatMessage", { text: "我在看" }),
      /你不在这个房间/
    );
    console.log("spectator ok");
  } finally {
    for (const client of clients) client.socket.disconnect();
    await io.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function testPlayerCountModes() {
  await testModeRoom(3, 17);
  await testModeRoom(5, 10);
}

async function testSurrenderVoteFlow() {
  const { server, io, ready } = createGameServer({ trickSettleDelayMs: 10, exposeDurationMs: 20 });
  await ready;
  const port = await listen(server);
  const url = `http://127.0.0.1:${port}`;
  const clients = Array.from({ length: 4 }, () => connectClient(url));
  try {
    await Promise.all(clients.map((client) => client.connected));
    const { code } = await clients[0].emit("createRoom", { name: "甲", clientId: "surrender-0" });
    await clients[1].emit("joinRoom", { code, name: "乙", clientId: "surrender-1" });
    await clients[2].emit("joinRoom", { code, name: "丙", clientId: "surrender-2" });
    await clients[3].emit("joinRoom", { code, name: "丁", clientId: "surrender-3" });
    await clients[0].emit("startGame");
    await Promise.all(clients.map((client) => client.waitFor(
      (state) => state.round?.phase === "expose",
      "surrender expose"
    )));
    await Promise.all(clients.map((client) => client.waitFor(
      (state) => state.round?.phase === "play",
      "surrender play"
    )));

    await clients[2].emit("requestSurrender");
    await clients[0].waitFor((state) => state.surrenderVote?.targetSeat === clients[2].state.me.seat, "surrender vote open");
    await clients[0].emit("voteSurrender", { approve: true });
    await clients[1].emit("voteSurrender", { approve: true });
    await Promise.all(clients.map((client) => client.waitFor(
      (state) => state.round?.phase === "finished" && state.round.pigSeats.includes(2),
      "surrender finished"
    )));
    assert.equal(clients[2].state.players[2].pigCount, 1);
    assert.equal(clients[0].state.surrenderVote, null);
    console.log("surrender ok");
  } finally {
    for (const client of clients) client.socket.disconnect();
    await io.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function testModeRoom(playerCount, handSize) {
  const { server, io, ready } = createGameServer({ trickSettleDelayMs: 10, exposeDurationMs: 20 });
  await ready;
  const port = await listen(server);
  const url = `http://127.0.0.1:${port}`;
  const clients = Array.from({ length: playerCount }, () => connectClient(url));
  try {
    await Promise.all(clients.map((client) => client.connected));
    const { code } = await clients[0].emit("createRoom", { name: "房主", clientId: `mode-${playerCount}-0`, playerCount });
    for (let index = 1; index < playerCount; index += 1) {
      await clients[index].emit("joinRoom", { code, name: `玩家${index}`, clientId: `mode-${playerCount}-${index}` });
    }
    await Promise.all(clients.map((client) => client.waitFor(
      (state) => state.playerCount === playerCount && state.players.length === playerCount,
      `${playerCount} player lobby`
    )));
    await clients[0].emit("startGame");
    await Promise.all(clients.map((client) => client.waitFor(
      (state) => state.round?.phase === "expose" && state.hand.length === handSize,
      `${playerCount} player expose`
    )));
    assert.equal(clients[0].state.round.playerCount, playerCount);
    assert.equal(clients[0].state.round.scorePreview.length, playerCount);
    console.log(`${playerCount}p mode ok`);
  } finally {
    for (const client of clients) client.socket.disconnect();
    await io.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
