const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SUITS = ["S", "H", "D", "C"];
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const RANK_VALUE = Object.fromEntries(RANKS.map((rank, index) => [rank, index + 2]));
const SUIT_NAMES = { S: "黑桃", H: "红桃", D: "方块", C: "梅花" };
const CARD_NAMES = { SQ: "猪", DJ: "羊", C10: "变压器", HA: "红桃A" };
const DIRECTIONS = ["south", "east", "north", "west"];
const DIRECTION_LABELS = ["南", "东", "北", "西"];
const SPECIAL_CARDS = ["SQ", "DJ", "C10", "HA"];
const INSTANCE_ID = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

function createGameServer() {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: "*" }
  });
  const rooms = new Map();
  const socketRooms = new Map();

  app.use(express.static("public"));

  app.get("/health", (request, response) => {
    response.json({
      ok: true,
      instanceId: INSTANCE_ID,
      uptime: Math.round(process.uptime()),
      rooms: rooms.size
    });
  });

  app.get("/debug/rooms", (request, response) => {
    response.json({
      instanceId: INSTANCE_ID,
      rooms: [...rooms.values()].map((room) => ({
        code: room.code,
        phase: room.phase,
        players: room.players.map((player) => ({
          name: player.name,
          seat: player.seat,
          connected: player.connected
        })),
        spectators: room.spectators.length,
        createdAt: room.createdAt
      }))
    });
  });

  function emitRoom(room) {
    for (const player of room.players) {
      io.to(player.socketId).emit("state", privateStateFor(room, player.socketId));
    }
    for (const spectator of room.spectators) {
      io.to(spectator.socketId).emit("state", privateStateFor(room, spectator.socketId));
    }
  }

  function getRoomForSocket(socket) {
    const code = socketRooms.get(socket.id);
    return code ? rooms.get(code) : null;
  }

  function createRoom(hostSocketId, hostName) {
    const code = makeRoomCode(rooms);
    const room = {
      code,
      phase: "lobby",
      players: [],
      spectators: [],
      hostId: hostSocketId,
      round: null,
      chats: [],
      messages: [],
      createdAt: Date.now()
    };
    rooms.set(code, room);
    addPlayerToRoom(room, hostSocketId, hostName, socketRooms);
    return room;
  }

  function removeSocketFromRoom(socketId) {
    const code = socketRooms.get(socketId);
    if (!code) return;
    const room = rooms.get(code);
    socketRooms.delete(socketId);
    if (!room) return;

    const player = room.players.find((candidate) => candidate.socketId === socketId);
    if (player) {
      player.connected = false;
      player.voiceSpeakerEnabled = false;
      player.voiceMicEnabled = false;
      pushMessage(room, `${player.name} 断开连接。`);
    }
    room.spectators = room.spectators.filter((candidate) => candidate.socketId !== socketId);

    if (room.phase === "lobby") {
      room.players = room.players.filter((candidate) => candidate.socketId !== socketId);
      room.players.forEach((candidate, index) => {
        candidate.seat = index;
        candidate.direction = DIRECTIONS[index];
        candidate.directionLabel = DIRECTION_LABELS[index];
      });
      if (room.players.length > 0) room.hostId = room.players[0].socketId;
    }

    if (room.players.length === 0 && room.spectators.length === 0) {
      rooms.delete(code);
    } else {
      emitRoom(room);
    }
  }

  io.on("connection", (socket) => {
    socket.on("createRoom", ({ name } = {}, callback = () => {}) => {
      try {
        const room = createRoom(socket.id, name);
        socket.join(room.code);
        pushMessage(room, `${room.players[0].name} 创建了房间。`);
        console.log(`[${INSTANCE_ID}] create room ${room.code} by ${room.players[0].name}`);
        emitRoom(room);
        callback({ ok: true, code: room.code });
      } catch (error) {
        callback({ ok: false, error: error.message });
      }
    });

    socket.on("joinRoom", ({ code, name } = {}, callback = () => {}) => {
      try {
        const room = rooms.get(String(code || "").trim().toUpperCase());
        if (!room) {
          const knownRooms = [...rooms.keys()].join(", ") || "none";
          console.warn(`[${INSTANCE_ID}] join failed for ${code}; known rooms: ${knownRooms}`);
          throw new Error("没有找到这个房间。请确认所有人打开的是同一个 Render 地址；如果刚创建就找不到，通常是 Render 多实例或服务重启导致。");
        }
        addPlayerToRoom(room, socket.id, name, socketRooms);
        socket.join(room.code);
        const joined = room.players.find((player) => player.socketId === socket.id);
        pushMessage(room, `${joined?.name || name || "旁观者"} 加入了房间。`);
        console.log(`[${INSTANCE_ID}] join room ${room.code} by ${joined?.name || name || "旁观者"}`);
        emitRoom(room);
        callback({ ok: true, code: room.code });
      } catch (error) {
        callback({ ok: false, error: error.message });
      }
    });

    socket.on("startGame", (payload, callback = () => {}) => {
      try {
        const room = getRoomForSocket(socket);
        if (!room) throw new Error("请先进入房间");
        if (room.hostId !== socket.id) throw new Error("只有房主能开始");
        startRound(room);
        emitRoom(room);
        callback({ ok: true });
      } catch (error) {
        callback({ ok: false, error: error.message });
      }
    });

    socket.on("exposeCards", ({ cardIds } = {}, callback = () => {}) => {
      try {
        const room = getRoomForSocket(socket);
        if (!room) throw new Error("请先进入房间");
        const player = assertPlayer(socket, room);
        exposeCards(room, player.seat, cardIds);
        emitRoom(room);
        callback({ ok: true });
      } catch (error) {
        callback({ ok: false, error: error.message });
      }
    });

    socket.on("finishExpose", (payload, callback = () => {}) => {
      try {
        const room = getRoomForSocket(socket);
        if (!room) throw new Error("请先进入房间");
        const player = assertPlayer(socket, room);
        if (room.hostId !== socket.id && player.seat !== room.round?.starter) {
          throw new Error("房主或首出玩家可以结束卖牌");
        }
        finishExpose(room);
        emitRoom(room);
        callback({ ok: true });
      } catch (error) {
        callback({ ok: false, error: error.message });
      }
    });

    socket.on("playCard", ({ cardId } = {}, callback = () => {}) => {
      try {
        const room = getRoomForSocket(socket);
        if (!room) throw new Error("请先进入房间");
        const player = assertPlayer(socket, room);
        playCard(room, player.seat, cardId);
        emitRoom(room);
        callback({ ok: true });
      } catch (error) {
        callback({ ok: false, error: error.message });
      }
    });

    socket.on("newRound", (payload, callback = () => {}) => {
      try {
        const room = getRoomForSocket(socket);
        if (!room) throw new Error("请先进入房间");
        if (room.hostId !== socket.id) throw new Error("只有房主能开新局");
        startRound(room);
        emitRoom(room);
        callback({ ok: true });
      } catch (error) {
        callback({ ok: false, error: error.message });
      }
    });

    socket.on("chatMessage", ({ text } = {}, callback = () => {}) => {
      try {
        const room = getRoomForSocket(socket);
        if (!room) throw new Error("请先进入房间");
        const sender = room.players.find((candidate) => candidate.socketId === socket.id)
          || room.spectators.find((candidate) => candidate.socketId === socket.id);
        if (!sender) throw new Error("你不在这个房间");
        const cleanText = String(text || "").trim().slice(0, 200);
        if (!cleanText) throw new Error("消息不能为空");
        const chat = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          senderId: socket.id,
          senderName: sender.name,
          text: cleanText,
          at: Date.now()
        };
        room.chats.push(chat);
        room.chats = room.chats.slice(-80);
        io.to(room.code).emit("chatMessage", chat);
        callback({ ok: true });
      } catch (error) {
        callback({ ok: false, error: error.message });
      }
    });

    socket.on("voiceSignal", ({ targetId, signal } = {}, callback = () => {}) => {
      try {
        const room = getRoomForSocket(socket);
        if (!room) throw new Error("请先进入房间");
        const targetInRoom = room.players.some((player) => player.socketId === targetId)
          || room.spectators.some((spectator) => spectator.socketId === targetId);
        if (!targetInRoom) throw new Error("语音目标不在房间");
        io.to(targetId).emit("voiceSignal", {
          fromId: socket.id,
          signal
        });
        callback({ ok: true });
      } catch (error) {
        callback({ ok: false, error: error.message });
      }
    });

    socket.on("voiceState", ({ speakerEnabled, micEnabled } = {}) => {
      const room = getRoomForSocket(socket);
      if (!room) return;
      const participant = room.players.find((player) => player.socketId === socket.id)
        || room.spectators.find((spectator) => spectator.socketId === socket.id);
      if (participant) {
        if (speakerEnabled !== undefined) participant.voiceSpeakerEnabled = Boolean(speakerEnabled);
        if (micEnabled !== undefined) participant.voiceMicEnabled = Boolean(micEnabled);
      }
      io.to(room.code).emit("voiceState", {
        socketId: socket.id,
        speakerEnabled: Boolean(participant?.voiceSpeakerEnabled),
        micEnabled: Boolean(participant?.voiceMicEnabled)
      });
      emitRoom(room);
    });

    socket.on("disconnect", () => {
      removeSocketFromRoom(socket.id);
    });
  });

  return { app, server, io, rooms, socketRooms, createRoom };
}

function makeDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank, id: `${suit}${rank}` });
    }
  }
  return deck;
}

function shuffle(cards) {
  const deck = [...cards];
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [deck[index], deck[swapIndex]] = [deck[swapIndex], deck[index]];
  }
  return deck;
}

function cardSortValue(card) {
  return SUITS.indexOf(card.suit) * 20 + RANK_VALUE[card.rank];
}

function sortHand(hand) {
  return hand.sort((a, b) => cardSortValue(a) - cardSortValue(b));
}

function makeRoomCode(rooms) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    let code = "";
    for (let i = 0; i < 4; i += 1) {
      code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
    }
    if (!rooms.has(code)) return code;
  }
  throw new Error("Unable to create room code");
}

function createTestRoom(hostSocketId, hostName) {
  const rooms = new Map();
  const socketRooms = new Map();
  const code = makeRoomCode(rooms);
  const room = {
    code,
    phase: "lobby",
    players: [],
    spectators: [],
    hostId: hostSocketId,
    round: null,
    messages: [],
    chats: [],
    createdAt: Date.now()
  };
  rooms.set(code, room);
  addPlayerToRoom(room, hostSocketId, hostName, socketRooms);
  return room;
}

function addPlayerToRoom(room, socketId, name, socketRooms = null) {
  const cleanName = String(name || "玩家").trim().slice(0, 16) || "玩家";
  const existing = room.players.find((player) => player.socketId === socketId);
  if (existing) return existing;

  if (room.players.length >= 4 || room.phase !== "lobby") {
    const spectator = {
      socketId,
      name: cleanName,
      role: "spectator",
      voiceSpeakerEnabled: false,
      voiceMicEnabled: false,
      joinedAt: Date.now()
    };
    room.spectators.push(spectator);
    socketRooms?.set(socketId, room.code);
    return spectator;
  }

  const player = {
    socketId,
    name: cleanName,
    seat: room.players.length,
    direction: DIRECTIONS[room.players.length],
    directionLabel: DIRECTION_LABELS[room.players.length],
    totalScore: 0,
    voiceSpeakerEnabled: false,
    voiceMicEnabled: false,
    connected: true
  };
  room.players.push(player);
  socketRooms?.set(socketId, room.code);
  return player;
}

function publicRoom(room) {
  return {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    instanceId: INSTANCE_ID,
    players: room.players.map((player) => ({
      socketId: player.socketId,
      name: player.name,
      seat: player.seat,
      direction: player.direction,
      directionLabel: player.directionLabel,
      connected: player.connected,
      voiceSpeakerEnabled: player.voiceSpeakerEnabled,
      voiceMicEnabled: player.voiceMicEnabled,
      totalScore: player.totalScore,
      handCount: room.round?.hands[player.seat]?.length ?? 0,
      collectedCount: room.round?.taken[player.seat]?.length ?? 0
    })),
    spectators: room.spectators.map((spectator) => ({
      socketId: spectator.socketId,
      name: spectator.name
    })),
    round: room.round ? publicRound(room.round) : null,
    chats: room.chats.slice(-80),
    messages: room.messages.slice(-24)
  };
}

function publicRound(round) {
  return {
    handNumber: round.handNumber,
    phase: round.phase,
    dealer: round.dealer,
    starter: round.starter,
    currentPlayer: round.currentPlayer,
    trickLeadSuit: round.trickLeadSuit,
    trick: round.trick.map((play) => ({
      seat: play.seat,
      card: play.card,
      exposed: play.exposed
    })),
    exposed: round.exposed,
    protectedSuits: round.protectedSuits,
    trickNumber: round.trickNumber,
    lastTrick: round.lastTrick,
    scorePreview: round.scorePreview,
    finishedScores: round.finishedScores
  };
}

function privateStateFor(room, socketId) {
  const state = publicRoom(room);
  const player = room.players.find((candidate) => candidate.socketId === socketId);
  if (player && room.round) {
    state.me = {
      socketId,
      seat: player.seat,
      direction: player.direction,
      directionLabel: player.directionLabel
    };
    state.hand = room.round.hands[player.seat];
    state.legalPlays = getLegalCardIds(room.round, player.seat);
    state.canExpose = room.round.phase === "expose"
      ? getExposableCardIds(room.round, player.seat)
      : [];
  } else {
    state.me = player ? {
      socketId,
      seat: player.seat,
      direction: player.direction,
      directionLabel: player.directionLabel
    } : null;
    state.hand = [];
    state.legalPlays = [];
    state.canExpose = [];
  }
  return state;
}

function pushMessage(room, text) {
  room.messages.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    text,
    at: Date.now()
  });
  room.messages = room.messages.slice(-50);
}

function startRound(room) {
  if (room.players.length !== 4) {
    throw new Error("需要 4 位玩家才能开始");
  }

  const deck = shuffle(makeDeck());
  const hands = [[], [], [], []];
  deck.forEach((card, index) => {
    hands[index % 4].push(card);
  });
  hands.forEach(sortHand);

  const starter = hands.findIndex((hand) => hand.some((card) => card.id === "S2"));
  room.phase = "playing";
  room.round = {
    handNumber: (room.round?.handNumber || 0) + 1,
    phase: "expose",
    hands,
    taken: [[], [], [], []],
    exposed: {
      SQ: null,
      DJ: null,
      C10: null,
      HA: null
    },
    protectedSuits: {
      S: false,
      H: false,
      D: false,
      C: false
    },
    currentPlayer: starter,
    starter,
    dealer: null,
    trickLeadSuit: null,
    trick: [],
    trickNumber: 1,
    lastTrick: null,
    scorePreview: [0, 0, 0, 0],
    finishedScores: null
  };
  pushMessage(room, `第 ${room.round.handNumber} 局开始，${room.players[starter].name} 持黑桃 2 先出。`);
}

function getExposableCardIds(round, seat) {
  const hand = round.hands[seat] || [];
  return hand
    .filter((card) => SPECIAL_CARDS.includes(card.id))
    .map((card) => card.id);
}

function exposeCards(room, seat, cardIds) {
  const round = room.round;
  if (!round || round.phase !== "expose") throw new Error("现在不能卖牌");

  const valid = new Set(getExposableCardIds(round, seat));
  const ids = Array.isArray(cardIds) ? cardIds : [];
  const uniqueIds = [...new Set(ids)].filter((id) => valid.has(id));
  for (const id of uniqueIds) {
    round.exposed[id] = seat;
    round.protectedSuits[id[0]] = true;
  }
  if (uniqueIds.length > 0) {
    pushMessage(room, `${room.players[seat].name} 卖出 ${uniqueIds.map(formatCardId).join("、")}。`);
  }
}

function finishExpose(room) {
  const round = room.round;
  if (!round || round.phase !== "expose") throw new Error("现在不能开始出牌");
  round.phase = "play";
  pushMessage(room, "卖牌结束，开始出牌。");
}

function getLegalCardIds(round, seat) {
  if (!round || round.phase !== "play" || round.currentPlayer !== seat) return [];
  const hand = round.hands[seat];
  if (!round.trickLeadSuit) {
    return getLeadableCards(round, seat).map((card) => card.id);
  }
  const sameSuit = hand.filter((card) => card.suit === round.trickLeadSuit);
  if (!sameSuit.length) return hand.map((card) => card.id);
  return sameSuit
    .filter((card) => !isProtectedExposedCard(round, card, sameSuit.length))
    .map((card) => card.id);
}

function getLeadableCards(round, seat) {
  const hand = round.hands[seat];
  if (round.trickNumber === 1) {
    const s2 = hand.find((card) => card.id === "S2");
    if (s2) return [s2];
  }

  return hand.filter((card) => {
    const suitCount = hand.filter((candidate) => candidate.suit === card.suit).length;
    return !isProtectedExposedCard(round, card, suitCount);
  });
}

function isProtectedExposedCard(round, card, suitCount) {
  if (!round.protectedSuits[card.suit]) return false;
  if (suitCount <= 1) return false;
  return round.exposed[card.id] !== undefined && round.exposed[card.id] !== null;
}

function playCard(room, seat, cardId) {
  const round = room.round;
  if (!round || round.phase !== "play") throw new Error("牌局尚未开始");
  if (round.currentPlayer !== seat) throw new Error("还没轮到你出牌");

  const legal = getLegalCardIds(round, seat);
  if (!legal.includes(cardId)) throw new Error("这张牌现在不能出");

  const hand = round.hands[seat];
  const cardIndex = hand.findIndex((card) => card.id === cardId);
  const [card] = hand.splice(cardIndex, 1);
  const exposed = isCardExposedBy(round, card.id, seat);
  if (!round.trickLeadSuit) round.trickLeadSuit = card.suit;
  round.trick.push({ seat, card, exposed });
  pushMessage(room, `${room.players[seat].name} 出了 ${formatCard(card)}。`);

  if (round.trick.length === 4) {
    finishTrick(room);
  } else {
    round.currentPlayer = (round.currentPlayer + 1) % 4;
  }
  updateScorePreview(round);
}

function isCardExposedBy(round, cardId, seat) {
  return round.exposed[cardId] === seat;
}

function finishTrick(room) {
  const round = room.round;
  const leadSuit = round.trickLeadSuit;
  const winnerPlay = round.trick
    .filter((play) => play.card.suit === leadSuit)
    .sort((a, b) => RANK_VALUE[b.card.rank] - RANK_VALUE[a.card.rank])[0];

  const wonCards = round.trick.map((play) => play.card);
  round.taken[winnerPlay.seat].push(...wonCards);
  round.lastTrick = {
    winner: winnerPlay.seat,
    winnerName: room.players[winnerPlay.seat].name,
    cards: round.trick
  };
  pushMessage(room, `${room.players[winnerPlay.seat].name} 收下第 ${round.trickNumber} 墩。`);

  round.currentPlayer = winnerPlay.seat;
  round.trickLeadSuit = null;
  round.trick = [];
  round.trickNumber += 1;
  round.protectedSuits[leadSuit] = false;

  if (round.hands.every((hand) => hand.length === 0)) {
    finishRound(room);
  }
}

function finishRound(room) {
  const round = room.round;
  const scores = calculateScores(round);
  round.scorePreview = scores;
  round.finishedScores = scores;
  round.phase = "finished";
  room.players.forEach((player, seat) => {
    player.totalScore += scores[seat];
  });
  pushMessage(room, `本局结束：${scores.map((score, seat) => `${room.players[seat].name} ${formatScore(score)}`).join("，")}。`);
}

function calculateScores(round) {
  const scores = [0, 0, 0, 0];
  for (let seat = 0; seat < 4; seat += 1) {
    const cards = round.taken[seat];
    const ids = new Set(cards.map((card) => card.id));
    const hasAllHearts = RANKS.every((rank) => ids.has(`H${rank}`));
    const hasPigSheepFull = ids.has("SQ")
      && ids.has("DJ")
      && ids.has("C10")
      && hasAllHearts;
    let base = 0;
    let hasNonTransformerScoreCard = false;

    if (hasAllHearts) {
      base += allHeartsValue(round);
      hasNonTransformerScoreCard = true;
    } else {
      for (const card of cards) {
        if (card.suit === "H") {
          base += heartValue(card, round);
          if (heartBaseValue(card) !== 0) hasNonTransformerScoreCard = true;
        }
      }
    }

    if (ids.has("SQ")) {
      base += hasPigSheepFull ? pigValue(round) * -1 : pigValue(round);
      hasNonTransformerScoreCard = true;
    }
    if (ids.has("DJ")) {
      base += sheepValue(round);
      hasNonTransformerScoreCard = true;
    }

    if (ids.has("C10")) {
      if (hasNonTransformerScoreCard) {
        scores[seat] = base * transformerMultiplier(round);
      } else {
        scores[seat] = transformerSoloValue(round);
      }
    } else {
      scores[seat] = base;
    }
  }
  return scores;
}

function heartValue(card, round) {
  const base = heartBaseValue(card);
  return round.exposed.HA !== null ? base * 2 : base;
}

function heartBaseValue(card) {
  const baseValues = {
    H2: 0,
    H3: 0,
    H4: 0,
    H5: -10,
    H6: -10,
    H7: -10,
    H8: -10,
    H9: -10,
    H10: -10,
    HJ: -20,
    HQ: -30,
    HK: -40,
    HA: -50
  };
  return baseValues[card.id] ?? 0;
}

function allHeartsValue(round) {
  return round.exposed.HA !== null ? 400 : 200;
}

function pigValue(round) {
  return round.exposed.SQ !== null ? -200 : -100;
}

function sheepValue(round) {
  return round.exposed.DJ !== null ? 200 : 100;
}

function transformerMultiplier(round) {
  return round.exposed.C10 !== null ? 4 : 2;
}

function transformerSoloValue(round) {
  return round.exposed.C10 !== null ? 100 : 50;
}

function updateScorePreview(round) {
  if (!round) return;
  round.scorePreview = calculateScores(round);
}

function formatScore(score) {
  return score > 0 ? `+${score}` : String(score);
}

function formatCard(card) {
  return `${SUIT_NAMES[card.suit]}${card.rank}${CARD_NAMES[card.id] ? `（${CARD_NAMES[card.id]}）` : ""}`;
}

function formatCardId(cardId) {
  const card = { suit: cardId[0], rank: cardId.slice(1), id: cardId };
  return formatCard(card);
}

function assertPlayer(socket, room) {
  const player = room.players.find((candidate) => candidate.socketId === socket.id);
  if (!player) throw new Error("你不是这局的玩家");
  return player;
}

if (require.main === module) {
  const { server } = createGameServer();
  server.listen(PORT, HOST, () => {
    console.log(`拱猪服务器已启动：http://${HOST}:${PORT}`);
  });
}

module.exports = {
  calculateScores,
  getLegalCardIds,
  heartValue,
  startRound,
  playCard,
  exposeCards,
  finishExpose,
  createRoom: createTestRoom,
  createGameServer,
  addPlayerToRoom,
  makeDeck
};
