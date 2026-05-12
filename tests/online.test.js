const assert = require("node:assert/strict");
const { io: makeClient } = require("socket.io-client");
const { createGameServer } = require("../server");

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
  const { server, io } = createGameServer();
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

    await clients[0].emit("finishExpose");
    await Promise.all(clients.map((client) => client.waitFor(
      (state) => state.round?.phase === "play",
      "play phase"
    )));

    let guard = 0;
    while (clients[0].state.round.phase !== "finished" && guard < 80) {
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
      await clients[0].waitFor(
        (state) => state.round?.phase === "finished"
          || state.round?.currentPlayer !== currentSeat
          || state.round?.trick.length === 0,
        "next turn"
      );
      guard += 1;
    }

    assert.equal(clients[0].state.round.phase, "finished");
    assert.equal(clients[0].state.players.every((player) => player.handCount === 0), true);
    assert.equal(clients[0].state.round.finishedScores.length, 4);
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
