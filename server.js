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
const SCORING_CARD_IDS = new Set(["SQ", "DJ", "C10", "H5", "H6", "H7", "H8", "H9", "H10", "HJ", "HQ", "HK", "HA"]);
const DEFAULT_TRICK_SETTLE_DELAY_MS = Number.parseInt(process.env.TRICK_SETTLE_DELAY_MS || "1000", 10);
const INSTANCE_ID = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

function createGameServer(options = {}) {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: "*" }
  });
  const rooms = new Map();
  const socketRooms = new Map();
  const trickSettleDelayMs = Number.isFinite(options.trickSettleDelayMs)
    ? options.trickSettleDelayMs
    : DEFAULT_TRICK_SETTLE_DELAY_MS;

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

  function createRoom(hostSocketId, hostName, hostClientId) {
    const code = makeRoomCode(rooms);
    const clientId = normalizeClientId(hostClientId, hostSocketId);
    const room = {
      code,
      phase: "lobby",
      players: [],
      spectators: [],
      hostId: hostSocketId,
      hostClientId: clientId,
      round: null,
      chats: [],
      messages: [],
      createdAt: Date.now()
    };
    rooms.set(code, room);
    addPlayerToRoom(room, hostSocketId, hostName, socketRooms, clientId);
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
      if (room.players.length > 0) {
        room.hostId = room.players[0].socketId;
        room.hostClientId = room.players[0].clientId;
      }
    }

    if (room.players.length === 0 && room.spectators.length === 0) {
      clearPendingTrickTimer(room);
      rooms.delete(code);
    } else {
      emitRoom(room);
    }
  }

  function clearPendingTrickTimer(room) {
    if (room?.trickTimer) {
      clearTimeout(room.trickTimer);
      room.trickTimer = null;
    }
  }

  function schedulePendingTrick(room) {
    const pending = room.round?.pendingTrickResolution;
    if (!pending || room.trickTimer) return;
    const delay = Math.max(0, pending.resolveAt - Date.now());
    room.trickTimer = setTimeout(() => {
      room.trickTimer = null;
      if (!room.round?.pendingTrickResolution || room.round.trick.length !== 4) return;
      finishTrick(room);
      emitRoom(room);
    }, delay);
  }

  io.on("connection", (socket) => {
    socket.on("createRoom", ({ name, clientId } = {}, callback = () => {}) => {
      try {
        const room = createRoom(socket.id, name, clientId);
        socket.join(room.code);
        pushMessage(room, `${room.players[0].name} 创建了房间。`);
        console.log(`[${INSTANCE_ID}] create room ${room.code} by ${room.players[0].name}`);
        emitRoom(room);
        callback({ ok: true, code: room.code });
      } catch (error) {
        callback({ ok: false, error: error.message });
      }
    });

    socket.on("joinRoom", ({ code, name, clientId } = {}, callback = () => {}) => {
      try {
        const room = rooms.get(String(code || "").trim().toUpperCase());
        if (!room) {
          const knownRooms = [...rooms.keys()].join(", ") || "none";
          console.warn(`[${INSTANCE_ID}] join failed for ${code}; known rooms: ${knownRooms}`);
          throw new Error("没有找到这个房间。请确认所有人打开的是同一个 Render 地址；如果刚创建就找不到，通常是 Render 多实例或服务重启导致。");
        }
        const participant = addPlayerToRoom(room, socket.id, name, socketRooms, clientId);
        socket.join(room.code);
        const joined = room.players.find((player) => player.socketId === socket.id);
        const displayName = joined?.name || participant?.name || name || "旁观者";
        pushMessage(room, `${displayName} 加入了房间。`);
        console.log(`[${INSTANCE_ID}] join room ${room.code} by ${displayName}`);
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
        playCard(room, player.seat, cardId, { settleDelayMs: trickSettleDelayMs });
        schedulePendingTrick(room);
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

function createTestRoom(hostSocketId, hostName, hostClientId = hostSocketId) {
  const rooms = new Map();
  const socketRooms = new Map();
  const code = makeRoomCode(rooms);
  const clientId = normalizeClientId(hostClientId, hostSocketId);
  const room = {
    code,
    phase: "lobby",
    players: [],
    spectators: [],
    hostId: hostSocketId,
    hostClientId: clientId,
    round: null,
    messages: [],
    chats: [],
    createdAt: Date.now()
  };
  rooms.set(code, room);
  addPlayerToRoom(room, hostSocketId, hostName, socketRooms, clientId);
  return room;
}

function normalizeClientId(clientId, fallback) {
  const cleanId = String(clientId || "").trim().slice(0, 80);
  return cleanId || `socket:${fallback}`;
}

function clearRoomSocket(room, socketRooms, socketId) {
  if (!socketId) return;
  socketRooms?.delete(socketId);
  room.spectators = room.spectators.filter((spectator) => spectator.socketId !== socketId);
}

function reconnectParticipant(room, participant, socketId, name, socketRooms) {
  const cleanName = String(name || participant.name || "玩家").trim().slice(0, 16) || "玩家";
  const oldSocketId = participant.socketId;
  if (participant.role === "spectator") {
    socketRooms?.delete(oldSocketId);
  } else {
    clearRoomSocket(room, socketRooms, oldSocketId);
  }
  participant.socketId = socketId;
  participant.name = cleanName;
  participant.connected = true;
  participant.voiceSpeakerEnabled = false;
  participant.voiceMicEnabled = false;
  socketRooms?.set(socketId, room.code);
  if (room.hostClientId && participant.clientId === room.hostClientId) {
    room.hostId = socketId;
  }
  return participant;
}

function addPlayerToRoom(room, socketId, name, socketRooms = null, clientId = socketId) {
  const cleanName = String(name || "玩家").trim().slice(0, 16) || "玩家";
  const cleanClientId = normalizeClientId(clientId, socketId);
  const existing = room.players.find((player) => player.socketId === socketId);
  if (existing) {
    existing.clientId = existing.clientId || cleanClientId;
    existing.connected = true;
    existing.name = cleanName;
    socketRooms?.set(socketId, room.code);
    return existing;
  }

  const reconnectingPlayer = room.players.find((player) => player.clientId === cleanClientId);
  if (reconnectingPlayer) {
    return reconnectParticipant(room, reconnectingPlayer, socketId, cleanName, socketRooms);
  }

  const reconnectingSpectator = room.spectators.find((spectator) => spectator.clientId === cleanClientId);
  if (reconnectingSpectator) {
    return reconnectParticipant(room, reconnectingSpectator, socketId, cleanName, socketRooms);
  }

  if (room.players.length >= 4 || room.phase !== "lobby") {
    const spectator = {
      socketId,
      clientId: cleanClientId,
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
    clientId: cleanClientId,
    name: cleanName,
    seat: room.players.length,
    direction: DIRECTIONS[room.players.length],
    directionLabel: DIRECTION_LABELS[room.players.length],
    pigCount: 0,
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
      pigCount: player.pigCount || 0,
      handCount: room.round?.hands[player.seat]?.length ?? 0,
      scoreCards: room.round ? scoringCardsFor(room.round.taken[player.seat] || []) : []
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
    settlingTrick: Boolean(round.pendingTrickResolution),
    heartsSeen: Boolean(round.heartsSeen),
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
  room.players.forEach((player) => {
    if (!Number.isFinite(player.pigCount)) player.pigCount = 0;
  });

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
    pendingTrickResolution: null,
    trickNumber: 1,
    lastTrick: null,
    heartsSeen: false,
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
  if (!round || round.phase !== "play" || round.pendingTrickResolution || round.currentPlayer !== seat) return [];
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

  const protectedFiltered = hand.filter((card) => {
    const suitCount = hand.filter((candidate) => candidate.suit === card.suit).length;
    return !isProtectedExposedCard(round, card, suitCount);
  });
  if (!isBloodLocked(round)) return protectedFiltered;

  const nonHearts = protectedFiltered.filter((card) => card.suit !== "H");
  return nonHearts.length ? nonHearts : protectedFiltered;
}

function isProtectedExposedCard(round, card, suitCount) {
  if (!round.protectedSuits[card.suit]) return false;
  if (suitCount <= 1) return false;
  return round.exposed[card.id] !== undefined && round.exposed[card.id] !== null;
}

function isBloodLocked(round) {
  return round.exposed?.HA !== null && round.exposed?.HA !== undefined && !round.heartsSeen;
}

function playCard(room, seat, cardId, options = {}) {
  const round = room.round;
  if (!round || round.phase !== "play") throw new Error("牌局尚未开始");
  if (round.pendingTrickResolution) throw new Error("本墩正在结算，请稍等");
  if (round.currentPlayer !== seat) throw new Error("还没轮到你出牌");

  const legal = getLegalCardIds(round, seat);
  if (!legal.includes(cardId)) throw new Error("这张牌现在不能出");

  const hand = round.hands[seat];
  const cardIndex = hand.findIndex((card) => card.id === cardId);
  const [card] = hand.splice(cardIndex, 1);
  const exposed = isCardExposedBy(round, card.id, seat);
  if (!round.trickLeadSuit) round.trickLeadSuit = card.suit;
  round.trick.push({ seat, card, exposed });
  if (card.suit === "H") round.heartsSeen = true;
  pushMessage(room, `${room.players[seat].name} 出了 ${formatCard(card)}。`);

  if (round.trick.length === 4) {
    const settleDelayMs = Math.max(0, Number(options.settleDelayMs || 0));
    if (settleDelayMs > 0) {
      round.pendingTrickResolution = {
        resolveAt: Date.now() + settleDelayMs
      };
      round.currentPlayer = null;
    } else {
      finishTrick(room);
    }
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

  round.pendingTrickResolution = null;
  round.currentPlayer = winnerPlay.seat;
  round.trickLeadSuit = null;
  round.trick = [];
  round.trickNumber += 1;
  round.protectedSuits[leadSuit] = false;
  updateScorePreview(round);

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
  const pigSeat = round.taken.findIndex((cards) => cards.some((card) => card.id === "SQ"));
  if (pigSeat >= 0) {
    room.players[pigSeat].pigCount = (room.players[pigSeat].pigCount || 0) + 1;
  }
  pushMessage(room, `本局结束：${scores.map((score, seat) => `${room.players[seat].name} ${formatScore(score)}`).join("，")}。`);
}

function scoringCardsFor(cards) {
  return cards
    .filter((card) => SCORING_CARD_IDS.has(card.id))
    .sort((a, b) => cardSortValue(a) - cardSortValue(b));
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
  finishRound,
  createRoom: createTestRoom,
  createGameServer,
  addPlayerToRoom,
  makeDeck
};
