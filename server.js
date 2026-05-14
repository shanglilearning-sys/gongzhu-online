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
const SUPPORTED_PLAYER_COUNTS = new Set([3, 4, 5]);
const DIRECTION_LABELS_BY_COUNT = {
  3: ["南", "东", "西"],
  4: ["南", "东", "北", "西"],
  5: ["南", "东南", "东北", "西北", "西南"]
};
const REMOVED_CARDS_BY_COUNT = {
  3: ["C2"],
  4: [],
  5: ["C2", "D2"]
};
const SPECIAL_CARDS = ["SQ", "DJ", "C10", "HA"];
const SCORING_CARD_IDS = new Set(["SQ", "DJ", "C10", "H5", "H6", "H7", "H8", "H9", "H10", "HJ", "HQ", "HK", "HA"]);
const DEFAULT_TRICK_SETTLE_DELAY_MS = Number.parseInt(process.env.TRICK_SETTLE_DELAY_MS || "1000", 10);
const DEFAULT_EXPOSE_DURATION_MS = Number.parseInt(process.env.EXPOSE_DURATION_MS || "8000", 10);
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
  const exposeDurationMs = Number.isFinite(options.exposeDurationMs)
    ? options.exposeDurationMs
    : DEFAULT_EXPOSE_DURATION_MS;

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
        scheduleExposeFinish(room);
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

  function createRoom(hostSocketId, hostName, hostClientId, options = {}) {
    const code = makeRoomCode(rooms);
    const clientId = normalizeClientId(hostClientId, hostSocketId);
    const playerCount = normalizePlayerCount(options.playerCount);
    const room = {
      code,
      phase: "lobby",
      playerCount,
      players: [],
      spectators: [],
      hostId: hostSocketId,
      hostClientId: clientId,
      round: null,
      pigKingSeat: null,
      surrenderVote: null,
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
      pushMessage(room, `${player.name} 断开连接。`);
    }
    room.spectators = room.spectators.filter((candidate) => candidate.socketId !== socketId);

    if (room.phase === "lobby") {
      room.players = room.players.filter((candidate) => candidate.socketId !== socketId);
      reseatPlayers(room);
      if (room.players.length > 0) {
        room.hostId = room.players[0].socketId;
        room.hostClientId = room.players[0].clientId;
      }
    }

    if (room.players.length === 0 && room.spectators.length === 0) {
      clearExposeTimer(room);
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

  function clearExposeTimer(room) {
    if (room?.exposeTimer) {
      clearTimeout(room.exposeTimer);
      room.exposeTimer = null;
    }
  }

  function scheduleExposeFinish(room) {
    const round = room.round;
    if (!round || round.phase !== "expose" || !round.exposeEndsAt || room.exposeTimer) return;
    const delay = Math.max(0, round.exposeEndsAt - Date.now());
    room.exposeTimer = setTimeout(() => {
      room.exposeTimer = null;
      if (room.round?.phase !== "expose") {
        persistRooms();
        return;
      }
      finishExpose(room);
      emitRoom(room);
      persistRooms();
    }, delay);
  }

  function close() {
    isShuttingDown = true;
    clearTimeout(persistTimer);
    persistTimer = null;
    for (const room of rooms.values()) {
      clearExposeTimer(room);
      clearPendingTrickTimer(room);
    }
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
      if (!room.round?.pendingTrickResolution || room.round.trick.length !== getPlayerCount(room)) {
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
    socket.on("createRoom", ({ name, clientId, playerCount } = {}, callback = () => {}) => {
      try {
        const room = createRoom(socket.id, name, clientId, { playerCount });
        socket.join(room.code);
        pushMessage(room, `${room.players[0].name} 创建了 ${room.playerCount} 人房间。`);
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
        startRound(room, { exposeDurationMs });
        scheduleExposeFinish(room);
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
        throw new Error("卖牌会在倒计时结束后自动开始出牌");
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

    socket.on("requestSurrender", (payload, callback = () => {}) => {
      try {
        const room = getRoomForSocket(socket);
        if (!room) throw new Error("请先进入房间");
        const player = assertPlayer(socket, room);
        requestSurrender(room, player.seat);
        persistRooms();
        emitRoom(room);
        callback({ ok: true });
      } catch (error) {
        callback({ ok: false, error: error.message });
      }
    });

    socket.on("voteSurrender", ({ approve } = {}, callback = () => {}) => {
      try {
        const room = getRoomForSocket(socket);
        if (!room) throw new Error("请先进入房间");
        const player = assertPlayer(socket, room);
        voteSurrender(room, player.seat, Boolean(approve));
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
        startRound(room, { exposeDurationMs });
        scheduleExposeFinish(room);
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

    socket.on("playerReaction", ({ targetSeat, kind } = {}, callback = () => {}) => {
      try {
        const room = getRoomForSocket(socket);
        if (!room) throw new Error("请先进入房间");
        const sender = room.players.find((candidate) => candidate.socketId === socket.id);
        if (!sender) throw new Error("只有牌桌玩家可以互动");
        const seat = Number.parseInt(targetSeat, 10);
        if (!Number.isInteger(seat) || seat < 0 || seat >= room.players.length) throw new Error("目标玩家不存在");
        const normalizedKind = kind === "flower" ? "like" : kind;
        if (!["egg", "like"].includes(normalizedKind)) throw new Error("未知互动");
        const reaction = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          kind: normalizedKind,
          fromSeat: sender.seat,
          targetSeat: seat,
          fromName: sender.name,
          at: Date.now()
        };
        io.to(room.code).emit("playerReaction", reaction);
        callback({ ok: true });
      } catch (error) {
        callback({ ok: false, error: error.message });
      }
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
    playerCount: getPlayerCount(room),
    players: room.players.map(participantToSnapshot),
    spectators: room.spectators.map(participantToSnapshot),
    hostClientId: room.hostClientId,
    pigKingSeat: Number.isInteger(room.pigKingSeat) ? room.pigKingSeat : null,
    surrenderVote: room.surrenderVote ? surrenderVoteToSnapshot(room.surrenderVote) : null,
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
    socketId: null
  };
}

function firstPigKingSeatForPlayers(players) {
  const winner = players.find((player) => Math.max(0, Number.parseInt(player?.pigCount || 0, 10)) >= 3);
  return Number.isInteger(winner?.seat) ? winner.seat : null;
}

function surrenderVoteToSnapshot(vote) {
  return {
    targetSeat: vote.targetSeat,
    roundNumber: vote.roundNumber,
    requiredApprovals: vote.requiredApprovals,
    approvals: Array.from(vote.approvals || []),
    rejections: Array.from(vote.rejections || []),
    voters: Array.from(vote.voters || []),
    createdAt: vote.createdAt
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
  snapshot.pigSeats = Array.isArray(round.pigSeats) ? round.pigSeats.slice(0, getRoundPlayerCount(round)) : [];
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
  const playerCount = normalizePlayerCount(snapshot.playerCount || snapshot.players.length || 4);
  const players = snapshot.players.slice(0, playerCount).map((player, index) => ({
    socketId: null,
    clientId: normalizeClientId(player.clientId, `restored-${snapshot.code}-${index}`),
    name: String(player.name || "玩家").trim().slice(0, 16) || "玩家",
    seat: index,
    direction: directionForSeat(index, playerCount),
    directionLabel: directionLabelForSeat(index, playerCount),
    pigCount: Number.isFinite(player.pigCount) ? player.pigCount : 0,
    connected: false
  }));
  if (players.length === 0) return null;
  const round = snapshot.round ? roundFromSnapshot(snapshot.round, playerCount) : null;
  if (round?.pendingTrickResolution) {
    if (round.trick.length === playerCount) {
      round.pendingTrickResolution.resolveAt = Math.min(round.pendingTrickResolution.resolveAt, Date.now());
      round.currentPlayer = null;
    } else {
      round.pendingTrickResolution = null;
    }
  }
  const hostClientId = snapshot.hostClientId || players[0].clientId;
  const pigKingSeat = Number.isInteger(snapshot.pigKingSeat)
    ? snapshot.pigKingSeat
    : firstPigKingSeatForPlayers(players);
  const surrenderVote = snapshot.surrenderVote
    ? surrenderVoteFromSnapshot(snapshot.surrenderVote, playerCount)
    : null;
  return {
    code: String(snapshot.code).trim().toUpperCase(),
    phase: snapshot.phase || (round ? "playing" : "lobby"),
    playerCount,
    players,
    spectators: Array.isArray(snapshot.spectators)
      ? snapshot.spectators.map((spectator, index) => ({
        socketId: null,
        clientId: normalizeClientId(spectator.clientId, `restored-spectator-${snapshot.code}-${index}`),
        name: String(spectator.name || "旁观者").trim().slice(0, 16) || "旁观者",
        role: "spectator",
        joinedAt: spectator.joinedAt || Date.now()
      }))
      : [],
    hostId: null,
    hostClientId,
    pigKingSeat,
    surrenderVote,
    round,
    chats: Array.isArray(snapshot.chats) ? snapshot.chats.slice(-80) : [],
    messages: Array.isArray(snapshot.messages) ? snapshot.messages.slice(-50) : [],
    createdAt: snapshot.createdAt || Date.now(),
    trickTimer: null
  };
}

function surrenderVoteFromSnapshot(snapshot, playerCount) {
  const targetSeat = Number.parseInt(snapshot.targetSeat, 10);
  if (!Number.isInteger(targetSeat) || targetSeat < 0 || targetSeat >= playerCount) return null;
  const voters = normalizeSeatList(snapshot.voters, playerCount).filter((seat) => seat !== targetSeat);
  const requiredApprovals = Number.isInteger(snapshot.requiredApprovals)
    ? snapshot.requiredApprovals
    : Math.floor(voters.length / 2) + 1;
  return {
    targetSeat,
    roundNumber: Number.parseInt(snapshot.roundNumber, 10) || null,
    requiredApprovals,
    approvals: new Set(normalizeSeatList(snapshot.approvals, playerCount).filter((seat) => voters.includes(seat))),
    rejections: new Set(normalizeSeatList(snapshot.rejections, playerCount).filter((seat) => voters.includes(seat))),
    voters,
    createdAt: snapshot.createdAt || Date.now()
  };
}

function normalizeSeatList(value, playerCount) {
  return Array.isArray(value)
    ? [...new Set(value.map((seat) => Number.parseInt(seat, 10)).filter((seat) => Number.isInteger(seat) && seat >= 0 && seat < playerCount))]
    : [];
}

function roundFromSnapshot(snapshot, playerCount = 4) {
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
    playerCount,
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
    exposeEndsAt: snapshot.exposeEndsAt || null,
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
    scorePreview: Array.isArray(snapshot.scorePreview) ? snapshot.scorePreview.slice(0, playerCount) : zeroScores(playerCount),
    finishedScores: Array.isArray(snapshot.finishedScores) ? snapshot.finishedScores.slice(0, playerCount) : null,
    pigSeats: Array.isArray(snapshot.pigSeats) ? snapshot.pigSeats.filter((seat) => Number.isInteger(seat)).slice(0, playerCount) : []
  };
  while (round.hands.length < playerCount) round.hands.push([]);
  while (round.taken.length < playerCount) round.taken.push([]);
  round.hands = round.hands.slice(0, playerCount);
  round.taken = round.taken.slice(0, playerCount);
  updateScorePreview(round);
  return round;
}

function normalizeCardMatrix(matrix, maxRows = 5) {
  const rows = Array.isArray(matrix) ? matrix.slice(0, maxRows) : [];
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

function deckForPlayerCount(playerCount) {
  const removed = new Set(REMOVED_CARDS_BY_COUNT[playerCount] || []);
  return makeDeck().filter((card) => !removed.has(card.id));
}

function normalizePlayerCount(value) {
  const count = Number.parseInt(value, 10);
  return SUPPORTED_PLAYER_COUNTS.has(count) ? count : 4;
}

function getPlayerCount(room) {
  return normalizePlayerCount(room?.playerCount || room?.players?.length || 4);
}

function getRoundPlayerCount(round) {
  const explicit = Number.parseInt(round?.playerCount, 10);
  if (SUPPORTED_PLAYER_COUNTS.has(explicit)) return explicit;
  const handCount = Array.isArray(round?.hands) ? round.hands.length : 0;
  if (SUPPORTED_PLAYER_COUNTS.has(handCount)) return handCount;
  const takenCount = Array.isArray(round?.taken) ? round.taken.length : 0;
  if (SUPPORTED_PLAYER_COUNTS.has(takenCount)) return takenCount;
  return 4;
}

function zeroScores(playerCount) {
  return Array.from({ length: playerCount }, () => 0);
}

function seatIndexes(playerCount) {
  return Array.from({ length: playerCount }, (_, seat) => seat);
}

function directionForSeat(seat, playerCount) {
  return `seat-${seat}`;
}

function directionLabelForSeat(seat, playerCount) {
  return DIRECTION_LABELS_BY_COUNT[playerCount]?.[seat] || String(seat + 1);
}

function reseatPlayers(room) {
  const playerCount = getPlayerCount(room);
  room.players.forEach((candidate, index) => {
    candidate.seat = index;
    candidate.direction = directionForSeat(index, playerCount);
    candidate.directionLabel = directionLabelForSeat(index, playerCount);
  });
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

function createTestRoom(hostSocketId, hostName, hostClientId = hostSocketId, options = {}) {
  const rooms = new Map();
  const socketRooms = new Map();
  const code = makeRoomCode(rooms);
  const clientId = normalizeClientId(hostClientId, hostSocketId);
  const playerCount = normalizePlayerCount(options.playerCount);
  const room = {
    code,
    phase: "lobby",
    playerCount,
    players: [],
    spectators: [],
    hostId: hostSocketId,
    hostClientId: clientId,
    round: null,
    pigKingSeat: null,
    surrenderVote: null,
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

  const playerCount = getPlayerCount(room);
  if (room.players.length >= playerCount || room.phase !== "lobby") {
    const spectator = {
      socketId,
      clientId: cleanClientId,
      name: cleanName,
      role: "spectator",
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
    direction: directionForSeat(room.players.length, playerCount),
    directionLabel: directionLabelForSeat(room.players.length, playerCount),
    pigCount: 0,
    connected: true
  };
  room.players.push(player);
  socketRooms?.set(socketId, room.code);
  return player;
}

function publicRoom(room) {
  const playerCount = getPlayerCount(room);
  return {
    code: room.code,
    phase: room.phase,
    playerCount,
    hostId: room.hostId,
    instanceId: INSTANCE_ID,
    pigKingSeat: Number.isInteger(room.pigKingSeat) ? room.pigKingSeat : null,
    surrenderVote: publicSurrenderVote(room),
    players: room.players.map((player) => ({
      socketId: player.socketId,
      name: player.name,
      seat: player.seat,
      direction: player.direction,
      directionLabel: player.directionLabel,
      connected: player.connected,
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
    messages: publicMessagesFor(room)
  };
}

function publicRound(round) {
  const playerCount = getRoundPlayerCount(round);
  return {
    handNumber: round.handNumber,
    playerCount,
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
    exposeEndsAt: round.exposeEndsAt || null,
    serverNow: Date.now(),
    heartsSeen: Boolean(round.heartsSeen),
    exposed: round.exposed,
    protectedSuits: round.protectedSuits,
    trickNumber: round.trickNumber,
    lastTrick: round.lastTrick,
    scorePreview: Array.isArray(round.scorePreview) ? round.scorePreview.slice(0, playerCount) : zeroScores(playerCount),
    finishedScores: Array.isArray(round.finishedScores) ? round.finishedScores.slice(0, playerCount) : null,
    pigSeats: round.pigSeats || []
  };
}

function publicSurrenderVote(room) {
  const vote = room.surrenderVote;
  if (!hasActiveSurrenderVote(room)) return null;
  return {
    targetSeat: vote.targetSeat,
    roundNumber: vote.roundNumber,
    requiredApprovals: vote.requiredApprovals,
    approvals: Array.from(vote.approvals || []),
    rejections: Array.from(vote.rejections || []),
    voters: Array.from(vote.voters || []),
    createdAt: vote.createdAt
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

function pushRoundMessage(room, text, roundId = room.round?.handNumber) {
  const message = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    text,
    at: Date.now(),
    type: "round",
    roundId
  };
  room.messages.push(message);
  room.messages = room.messages.slice(-50);
  return message;
}

function publicMessagesFor(room) {
  const round = room.round;
  if (!round) return room.messages.slice(-4);
  if (round.phase === "lobby") return room.messages.slice(-4);
  const roundMessages = room.messages.filter((message) => message.type === "round" && message.roundId === round.handNumber);
  if (round.phase === "play") {
    return roundMessages.filter((message) => message.trickNumber === round.trickNumber).slice(-4);
  }
  return roundMessages.slice(-6);
}

function startRound(room, options = {}) {
  const playerCount = getPlayerCount(room);
  if (room.players.length !== playerCount) {
    throw new Error(`需要 ${playerCount} 位玩家才能开始`);
  }
  if (room.exposeTimer) {
    clearTimeout(room.exposeTimer);
    room.exposeTimer = null;
  }
  room.players.forEach((player) => {
    if (!Number.isFinite(player.pigCount)) player.pigCount = 0;
  });
  if (!Number.isInteger(room.pigKingSeat)) {
    room.pigKingSeat = firstPigKingSeatForPlayers(room.players);
  }
  room.surrenderVote = null;

  const deck = shuffle(deckForPlayerCount(playerCount));
  const hands = Array.from({ length: playerCount }, () => []);
  deck.forEach((card, index) => {
    hands[index % playerCount].push(card);
  });
  hands.forEach(sortHand);

  const starter = hands.findIndex((hand) => hand.some((card) => card.id === "S2"));
  room.phase = "playing";
  room.round = {
    handNumber: (room.round?.handNumber || 0) + 1,
    playerCount,
    phase: "expose",
    hands,
    taken: Array.from({ length: playerCount }, () => []),
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
    exposeEndsAt: Date.now() + Math.max(0, Number(options.exposeDurationMs ?? DEFAULT_EXPOSE_DURATION_MS)),
    trickNumber: 1,
    lastTrick: null,
    heartsSeen: false,
    scorePreview: zeroScores(playerCount),
    finishedScores: null,
    pigSeats: []
  };
  const removed = REMOVED_CARDS_BY_COUNT[playerCount] || [];
  const removedText = removed.length ? `（移除 ${removed.map(formatCardId).join("、")}）` : "";
  pushRoundMessage(room, `第 ${room.round.handNumber} 局开始，${room.players[starter].name} 持黑桃 2 先出${removedText}。`, room.round.handNumber);
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
    pushRoundMessage(room, `${room.players[seat].name} 卖出 ${uniqueIds.map(formatCardId).join("、")}。`);
  }
}

function finishExpose(room) {
  const round = room.round;
  if (!round || round.phase !== "expose") throw new Error("现在不能开始出牌");
  if (room.exposeTimer) {
    clearTimeout(room.exposeTimer);
    room.exposeTimer = null;
  }
  round.phase = "play";
  round.exposeEndsAt = null;
  pushRoundMessage(room, "卖牌结束，开始出牌。");
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
  if (hasActiveSurrenderVote(room)) throw new Error("认猪投票中，暂时不能出牌");
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
  pushRoundMessage(room, `${room.players[seat].name} 出了 ${formatCard(card)}。`, round.handNumber).trickNumber = round.trickNumber;

  const playerCount = getRoundPlayerCount(round);
  if (round.trick.length === playerCount) {
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
    round.currentPlayer = (round.currentPlayer + 1) % playerCount;
  }
  updateScorePreview(round);
}

function requestSurrender(room, seat) {
  const round = room.round;
  if (!round || round.phase !== "play") throw new Error("只有出牌阶段可以认猪");
  if (round.pendingTrickResolution) throw new Error("本墩正在结算，请稍等");
  if (hasActiveSurrenderVote(room)) throw new Error("已经有认猪投票正在进行");
  room.surrenderVote = null;
  const player = room.players[seat];
  if (!player) throw new Error("玩家不存在");
  const playerCount = getRoundPlayerCount(round);
  const voters = seatIndexes(playerCount).filter((candidate) => candidate !== seat);
  room.surrenderVote = {
    targetSeat: seat,
    roundNumber: round.handNumber,
    requiredApprovals: Math.floor(voters.length / 2) + 1,
    approvals: new Set(),
    rejections: new Set(),
    voters,
    createdAt: Date.now()
  };
  pushRoundMessage(room, `${player.name} 发起认猪投票，其他玩家过半同意后本局立即结束。`, round.handNumber);
}

function voteSurrender(room, seat, approve) {
  const round = room.round;
  const vote = room.surrenderVote;
  if (!hasActiveSurrenderVote(room)) throw new Error("当前没有可投票的认猪");
  if (seat === vote.targetSeat) throw new Error("认猪者不能参与投票");
  if (!vote.voters.includes(seat)) throw new Error("你不能参与这次投票");
  if (vote.approvals.has(seat) || vote.rejections.has(seat)) throw new Error("你已经投过票了");
  if (approve) {
    vote.approvals.add(seat);
  } else {
    vote.rejections.add(seat);
  }
  const voterName = room.players[seat]?.name || `玩家${seat + 1}`;
  pushRoundMessage(room, `${voterName} ${approve ? "同意" : "不同意"}认猪。`, round.handNumber);
  if (vote.approvals.size >= vote.requiredApprovals) {
    finishRoundBySurrender(room, vote.targetSeat);
    return;
  }
  const remaining = vote.voters.length - vote.approvals.size - vote.rejections.size;
  if (vote.approvals.size + remaining < vote.requiredApprovals) {
    const targetName = room.players[vote.targetSeat]?.name || `玩家${vote.targetSeat + 1}`;
    room.surrenderVote = null;
    pushRoundMessage(room, `${targetName} 认猪投票未通过，牌局继续。`, round.handNumber);
  }
}

function hasActiveSurrenderVote(room) {
  return Boolean(room.surrenderVote)
    && room.round?.phase === "play"
    && room.surrenderVote.roundNumber === room.round.handNumber;
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
  const finishedTrickNumber = round.trickNumber;
  pushRoundMessage(room, `${room.players[winnerPlay.seat].name} 收下第 ${finishedTrickNumber} 墩。`).trickNumber = finishedTrickNumber;

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
  const pigSeats = getRoundPigSeats(round, scores);
  round.scorePreview = scores;
  round.finishedScores = scores;
  round.pigSeats = pigSeats;
  round.phase = "finished";
  for (const seat of pigSeats) {
    room.players[seat].pigCount = (room.players[seat].pigCount || 0) + 1;
    if (!Number.isInteger(room.pigKingSeat) && room.players[seat].pigCount >= 3) {
      room.pigKingSeat = seat;
    }
  }
  const pigNames = pigSeats.map((seat) => room.players[seat]?.name).filter(Boolean).join("、") || "无";
  pushRoundMessage(room, `本局结束：${scores.map((score, seat) => `${room.players[seat].name} ${formatScore(score)}`).join("，")}。本局当猪：${pigNames}。`);
  room.surrenderVote = null;
}

function finishRoundBySurrender(room, targetSeat) {
  const round = room.round;
  const playerCount = getRoundPlayerCount(round);
  const scores = zeroScores(playerCount);
  round.scorePreview = scores;
  round.finishedScores = scores;
  round.pigSeats = [targetSeat];
  round.phase = "finished";
  round.currentPlayer = null;
  round.pendingTrickResolution = null;
  if (room.trickTimer) {
    clearTimeout(room.trickTimer);
    room.trickTimer = null;
  }
  room.players[targetSeat].pigCount = (room.players[targetSeat].pigCount || 0) + 1;
  if (!Number.isInteger(room.pigKingSeat) && room.players[targetSeat].pigCount >= 3) {
    room.pigKingSeat = targetSeat;
  }
  const targetName = room.players[targetSeat]?.name || `玩家${targetSeat + 1}`;
  room.surrenderVote = null;
  pushRoundMessage(room, `认猪投票通过，${targetName} 本局认猪判负。`, round.handNumber);
}

function getRoundPigSeats(round, scores = calculateScores(round)) {
  const allHeartsSeat = round.taken.findIndex(hasAllHearts);
  if (allHeartsSeat >= 0) {
    return seatIndexes(getRoundPlayerCount(round)).filter((seat) => seat !== allHeartsSeat);
  }
  const lowest = Math.min(...scores);
  return scores
    .map((score, seat) => ({ score, seat }))
    .filter((item) => item.score === lowest)
    .map((item) => item.seat);
}

function hasAllHearts(cards) {
  const ids = new Set(cards.map((card) => card.id));
  return RANKS.every((rank) => ids.has(`H${rank}`));
}

function scoringCardsFor(cards) {
  return cards
    .filter((card) => SCORING_CARD_IDS.has(card.id))
    .sort((a, b) => cardSortValue(a) - cardSortValue(b));
}

function calculateScores(round) {
  const playerCount = getRoundPlayerCount(round);
  const scores = zeroScores(playerCount);
  for (let seat = 0; seat < playerCount; seat += 1) {
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
  requestSurrender,
  voteSurrender,
  createRoom: createTestRoom,
  createGameServer,
  addPlayerToRoom,
  makeDeck,
  createRoomPersistence,
  getRoundPigSeats
};
