const express = require("express");
const fs = require("node:fs/promises");
const http = require("http");
const path = require("node:path");
const { Server } = require("socket.io");
const Redis = require("ioredis");

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
const ROOM_SNAPSHOT_VERSION = 1;
const DEFAULT_ROOM_STATE_KEY = "gongzhu:rooms:v1";

function createGameServer(options = {}) {
  const app = express();
  const server = http.createServer(app);
  let isShuttingDown = false;
  const io = new Server(server, {
    cors: { origin: "*" }
  });
  const rooms = new Map();
  const socketRooms = new Map();
  const persistence = resolveRoomPersistence(options.persistence);
  const envSaveDebounceMs = Number.parseInt(process.env.ROOM_SAVE_DEBOUNCE_MS || "0", 10);
  const saveDebounceMs = Number.isFinite(options.saveDebounceMs)
    ? options.saveDebounceMs
    : (Number.isFinite(envSaveDebounceMs) ? envSaveDebounceMs : 0);
  let persistTimer = null;
  let isReadySettled = false;
  const trickSettleDelayMs = Number.isFinite(options.trickSettleDelayMs)
    ? options.trickSettleDelayMs
    : DEFAULT_TRICK_SETTLE_DELAY_MS;

  let persistQueue = Promise.resolve();
  const persistRooms = () => {
    if (!isReadySettled) return;
    if (saveDebounceMs <= 0) {
      flushRooms();
      return;
    }
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      flushRooms();
    }, saveDebounceMs);
  };

  const flushRooms = () => {
    if (isShuttingDown) return persistQueue;
    persistQueue = persistQueue
      .catch(() => {})
      .then(() => persistence.save(rooms));
    persistQueue.catch((error) => {
      console.warn(`[${INSTANCE_ID}] failed to persist rooms: ${error.message}`);
    });
    return persistQueue;
  };

  const ready = persistence.load()
    .then((restoredRooms) => {
      for (const room of restoredRooms) {
        rooms.set(room.code, room);
        schedulePendingTrick(room);
      }
      if (restoredRooms.length > 0) {
        console.log(`[${INSTANCE_ID}] restored ${restoredRooms.length} room(s) from ${persistence.kind}`);
      }
    })
    .catch((error) => {
      console.warn(`[${INSTANCE_ID}] failed to restore rooms from ${persistence.kind}: ${error.message}`);
    })
    .finally(() => {
      isReadySettled = true;
    });

  app.use(express.static("public"));

  app.get("/health", (request, response) => {
    response.json({
      ok: true,
      instanceId: INSTANCE_ID,
      uptime: Math.round(process.uptime()),
      rooms: rooms.size,
      persistence: persistence.kind,
      persistenceReady: persistence.isReady(),
      restored: isReadySettled
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
        messages: room.messages.length,
        createdAt: room.createdAt
      }))
    });
  });

  function emitRoom(room) {
    for (const player of room.players) {
      if (!player.socketId) continue;
      io.to(player.socketId).emit("state", privateStateFor(room, player.socketId));
    }
    for (const spectator of room.spectators) {
      if (!spectator.socketId) continue;
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
    persistRooms();
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
      persistRooms();
    } else {
      emitRoom(room);
      persistRooms();
    }
  }

  function clearPendingTrickTimer(room) {
    if (room?.trickTimer) {
      clearTimeout(room.trickTimer);
      room.trickTimer = null;
    }
  }

  function close() {
    isShuttingDown = true;
    clearTimeout(persistTimer);
    persistTimer = null;
    const pending = persistQueue
      .catch(() => {})
      .then(() => persistence.save(rooms))
      .finally(() => {
        persistence.close?.();
      });
    return pending;
  }

  function schedulePendingTrick(room) {
    const pending = room.round?.pendingTrickResolution;
    if (!pending || room.trickTimer) return;
    const delay = Math.max(0, pending.resolveAt - Date.now());
    room.trickTimer = setTimeout(() => {
      room.trickTimer = null;
      if (!room.round?.pendingTrickResolution || room.round.trick.length !== 4) {
        persistRooms();
        return;
      }
      finishTrick(room);
      emitRoom(room);
      persistRooms();
    }, delay);
  }

  io.use((socket, next) => {
    ready.then(() => next()).catch(next);
  });

  io.on("connection", (socket) => {
    socket.on("createRoom", ({ name, clientId } = {}, callback = () => {}) => {
      try {
        const room = createRoom(socket.id, name, clientId);
        socket.join(room.code);
        pushMessage(room, `${room.players[0].name} 创建了房间。`);
        console.log(`[${INSTANCE_ID}] create room ${room.code} by ${room.players[0].name}`);
        persistRooms();
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
          const detail = persistence.kind === "memory"
            ? "当前服务器没有启用持久化，服务重启或休眠后旧房间会丢失。"
            : "当前持久化存储里也没有这个房间，可能是房间已结束或存储连接异常。";
          throw new Error(`没有找到这个房间。${detail}请确认所有人打开的是同一个 Render 地址，必要时重新开房。`);
        }
        const participant = addPlayerToRoom(room, socket.id, name, socketRooms, clientId);
        socket.join(room.code);
        const joined = room.players.find((player) => player.socketId === socket.id);
        const displayName = joined?.name || participant?.name || name || "旁观者";
        pushMessage(room, `${displayName} 加入了房间。`);
        console.log(`[${INSTANCE_ID}] join room ${room.code} by ${displayName}`);
        persistRooms();
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
        persistRooms();
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
        persistRooms();
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
        persistRooms();
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
        persistRooms();
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
        persistRooms();
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
        persistRooms();
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
      persistRooms();
      emitRoom(room);
    });

    socket.on("disconnect", () => {
      removeSocketFromRoom(socket.id);
    });
  });

  return { app, server, io, rooms, socketRooms, createRoom, ready, persistence, close };
}

function resolveRoomPersistence(config = {}) {
  if (config && typeof config.load === "function" && typeof config.save === "function") {
    return {
      kind: config.kind || "custom",
      isReady: typeof config.isReady === "function" ? config.isReady : () => true,
      load: config.load,
      save: config.save,
      close: config.close
    };
  }
  return createRoomPersistence(config);
}

function createRoomPersistence(config = {}) {
  const redisUrl = config.redisUrl ?? process.env.REDIS_URL ?? process.env.RENDER_REDIS_URL;
  const filePath = config.filePath ?? process.env.ROOMS_FILE;
  const key = config.key || process.env.ROOMS_KEY || DEFAULT_ROOM_STATE_KEY;
  if (config.disabled || (!redisUrl && !filePath)) {
    return createNoopPersistence();
  }
  if (redisUrl) {
    return createRedisPersistence(redisUrl, key);
  }
  return createFilePersistence(filePath);
}

function createNoopPersistence() {
  return {
    kind: "memory",
    isReady: () => true,
    load: async () => [],
    save: async () => {}
  };
}

function createRedisPersistence(redisUrl, key) {
  let ready = false;
  let readyWait = null;
  const redis = new Redis(redisUrl, {
    commandTimeout: 3000,
    connectTimeout: 3000,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 2,
    retryStrategy(times) {
      return Math.min(2000, times * 200);
    }
  });
  redis.on("ready", () => {
    ready = true;
    console.log(`[${INSTANCE_ID}] room persistence connected to Redis`);
  });
  redis.on("end", () => {
    ready = false;
  });
  redis.on("error", (error) => {
    ready = false;
    console.warn(`[${INSTANCE_ID}] Redis persistence error: ${error.message}`);
  });

  return {
    kind: "redis",
    isReady: () => ready,
    async load() {
      readyWait ||= new Promise((resolve) => {
        if (ready) {
          resolve();
          return;
        }
        const timer = setTimeout(resolve, 3000);
        redis.once("ready", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      await readyWait;
      const raw = await redis.get(key);
      return parsePersistedRooms(raw);
    },
    async save(rooms) {
      await redis.set(key, stringifyRooms(rooms));
    },
    close: () => redis.disconnect()
  };
}

function createFilePersistence(filePath) {
  let ready = false;
  const resolved = path.resolve(filePath);
  return {
    kind: "file",
    isReady: () => ready,
    async load() {
      try {
        const raw = await fs.readFile(resolved, "utf8");
        ready = true;
        return parsePersistedRooms(raw);
      } catch (error) {
        if (error.code === "ENOENT") {
          ready = true;
          return [];
        }
        throw error;
      }
    },
    async save(rooms) {
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      const tmpPath = `${resolved}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
      await fs.writeFile(tmpPath, stringifyRooms(rooms), "utf8");
      await fs.rename(tmpPath, resolved);
      ready = true;
    }
  };
}

function stringifyRooms(rooms) {
  const snapshot = {
    version: ROOM_SNAPSHOT_VERSION,
    savedAt: Date.now(),
    rooms: [...rooms.values()].map(roomToSnapshot)
  };
  return JSON.stringify(snapshot);
}

function parsePersistedRooms(raw) {
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  if (parsed.version !== ROOM_SNAPSHOT_VERSION || !Array.isArray(parsed.rooms)) {
    return [];
  }
  return parsed.rooms
    .map(roomFromSnapshot)
    .filter(Boolean);
}

function roomToSnapshot(room) {
  const snapshot = {
    code: room.code,
    phase: room.phase,
    players: room.players.map(participantToSnapshot),
    spectators: room.spectators.map(participantToSnapshot),
    hostClientId: room.hostClientId,
    round: room.round ? roundToSnapshot(room.round) : null,
    chats: room.chats || [],
    messages: room.messages || [],
    createdAt: room.createdAt
  };
  return snapshot;
}

function participantToSnapshot(participant) {
  return {
    clientId: participant.clientId,
    name: participant.name,
    role: participant.role,
    seat: participant.seat,
    direction: participant.direction,
    directionLabel: participant.directionLabel,
    pigCount: participant.pigCount || 0,
    joinedAt: participant.joinedAt,
    connected: false,
    socketId: null,
    voiceSpeakerEnabled: false,
    voiceMicEnabled: false
  };
}

function roundToSnapshot(round) {
  const snapshot = { ...round };
  snapshot.hands = round.hands.map((hand) => hand.map(cardSnapshot));
  snapshot.taken = round.taken.map((pile) => pile.map(cardSnapshot));
  snapshot.trick = round.trick.filter((play) => play?.card).map((play) => ({
    seat: play.seat,
    card: cardSnapshot(play.card),
    exposed: Boolean(play.exposed)
  }));
  snapshot.lastTrick = round.lastTrick ? {
    winner: round.lastTrick.winner,
    winnerName: round.lastTrick.winnerName,
    cards: round.lastTrick.cards.filter((play) => play?.card).map((play) => ({
      seat: play.seat,
      card: cardSnapshot(play.card),
      exposed: Boolean(play.exposed)
    }))
  } : null;
  return snapshot;
}

function cardSnapshot(card) {
  return {
    suit: card.suit,
    rank: card.rank,
    id: card.id
  };
}

function roomFromSnapshot(snapshot) {
  if (!snapshot?.code || !Array.isArray(snapshot.players)) return null;
  const players = snapshot.players.slice(0, 4).map((player, index) => ({
    socketId: null,
    clientId: normalizeClientId(player.clientId, `restored-${snapshot.code}-${index}`),
    name: String(player.name || "玩家").trim().slice(0, 16) || "玩家",
    seat: index,
    direction: DIRECTIONS[index],
    directionLabel: DIRECTION_LABELS[index],
    pigCount: Number.isFinite(player.pigCount) ? player.pigCount : 0,
    voiceSpeakerEnabled: false,
    voiceMicEnabled: false,
    connected: false
  }));
  if (players.length === 0) return null;
  const round = snapshot.round ? roundFromSnapshot(snapshot.round) : null;
  if (round?.pendingTrickResolution) {
    if (round.trick.length === 4) {
      round.pendingTrickResolution.resolveAt = Math.min(round.pendingTrickResolution.resolveAt, Date.now());
      round.currentPlayer = null;
    } else {
      round.pendingTrickResolution = null;
    }
  }
  const hostClientId = snapshot.hostClientId || players[0].clientId;
  return {
    code: String(snapshot.code).trim().toUpperCase(),
    phase: snapshot.phase || (round ? "playing" : "lobby"),
    players,
    spectators: Array.isArray(snapshot.spectators)
      ? snapshot.spectators.map((spectator, index) => ({
        socketId: null,
        clientId: normalizeClientId(spectator.clientId, `restored-spectator-${snapshot.code}-${index}`),
        name: String(spectator.name || "旁观者").trim().slice(0, 16) || "旁观者",
        role: "spectator",
        voiceSpeakerEnabled: false,
        voiceMicEnabled: false,
        joinedAt: spectator.joinedAt || Date.now()
      }))
      : [],
    hostId: null,
    hostClientId,
    round,
    chats: Array.isArray(snapshot.chats) ? snapshot.chats.slice(-80) : [],
    messages: Array.isArray(snapshot.messages) ? snapshot.messages.slice(-50) : [],
    createdAt: snapshot.createdAt || Date.now(),
    trickTimer: null
  };
}

function roundFromSnapshot(snapshot) {
  const currentPlayer = Number.isFinite(snapshot.currentPlayer)
    ? snapshot.currentPlayer
    : null;
  const exposed = {
    SQ: snapshot.exposed?.SQ ?? null,
    DJ: snapshot.exposed?.DJ ?? null,
    C10: snapshot.exposed?.C10 ?? null,
    HA: snapshot.exposed?.HA ?? null
  };
  const round = {
    handNumber: snapshot.handNumber || 1,
    phase: snapshot.phase || "play",
    hands: normalizeCardMatrix(snapshot.hands),
    taken: normalizeCardMatrix(snapshot.taken),
    exposed,
    protectedSuits: {
      S: Boolean(snapshot.protectedSuits?.S),
      H: Boolean(snapshot.protectedSuits?.H),
      D: Boolean(snapshot.protectedSuits?.D),
      C: Boolean(snapshot.protectedSuits?.C)
    },
    currentPlayer,
    starter: Number.isFinite(snapshot.starter) ? snapshot.starter : null,
    dealer: Number.isFinite(snapshot.dealer) ? snapshot.dealer : null,
    trickLeadSuit: snapshot.trickLeadSuit || null,
    trick: Array.isArray(snapshot.trick)
      ? snapshot.trick.filter((play) => play?.card).map((play) => ({
        seat: play.seat,
        card: cardSnapshot(play.card),
        exposed: Boolean(play.exposed)
      }))
      : [],
    pendingTrickResolution: snapshot.pendingTrickResolution?.resolveAt
      ? { resolveAt: snapshot.pendingTrickResolution.resolveAt }
      : null,
    trickNumber: snapshot.trickNumber || 1,
    lastTrick: snapshot.lastTrick ? {
      winner: snapshot.lastTrick.winner,
      winnerName: snapshot.lastTrick.winnerName,
      cards: Array.isArray(snapshot.lastTrick.cards)
        ? snapshot.lastTrick.cards.filter((play) => play?.card).map((play) => ({
          seat: play.seat,
          card: cardSnapshot(play.card),
          exposed: Boolean(play.exposed)
        }))
        : []
    } : null,
    heartsSeen: Boolean(snapshot.heartsSeen),
    scorePreview: Array.isArray(snapshot.scorePreview) ? snapshot.scorePreview.slice(0, 4) : [0, 0, 0, 0],
    finishedScores: Array.isArray(snapshot.finishedScores) ? snapshot.finishedScores.slice(0, 4) : null
  };
  while (round.hands.length < 4) round.hands.push([]);
  while (round.taken.length < 4) round.taken.push([]);
  updateScorePreview(round);
  return round;
}

function normalizeCardMatrix(matrix) {
  const rows = Array.isArray(matrix) ? matrix.slice(0, 4) : [];
  return rows.map((cards) => Array.isArray(cards) ? cards.filter(Boolean).map(cardSnapshot) : []);
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
  const { server, ready } = createGameServer();
  ready.then(() => {
    server.listen(PORT, HOST, () => {
      console.log(`拱猪服务器已启动：http://${HOST}:${PORT}`);
    });
  }).catch((error) => {
    console.error(`拱猪服务器启动失败：${error.message}`);
    process.exit(1);
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
  makeDeck,
  createRoomPersistence
};
