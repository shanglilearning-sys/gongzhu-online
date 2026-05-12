const socket = io();

const SUIT_SYMBOLS = { S: "♠", H: "♥", D: "♦", C: "♣" };
const SUIT_NAMES = { S: "黑桃", H: "红桃", D: "方块", C: "梅花" };
const SPECIAL_NAMES = { SQ: "猪", DJ: "羊", C10: "变压器", HA: "红桃A" };
const RANK_ORDER = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];

let state = null;
let selectedExpose = new Set();

const entry = document.querySelector("#entry");
const game = document.querySelector("#game");
const joinForm = document.querySelector("#join-form");
const nameInput = document.querySelector("#name-input");
const codeInput = document.querySelector("#code-input");
const createButton = document.querySelector("#create-button");
const entryError = document.querySelector("#entry-error");
const roomCode = document.querySelector("#room-code");
const phaseTitle = document.querySelector("#phase-title");
const startButton = document.querySelector("#start-button");
const finishExposeButton = document.querySelector("#finish-expose-button");
const newRoundButton = document.querySelector("#new-round-button");
const copyLinkButton = document.querySelector("#copy-link");
const historyButton = document.querySelector("#history-button");
const rulesButton = document.querySelector("#rules-button");
const voiceButton = document.querySelector("#voice-button");
const scoreStrip = document.querySelector("#score-strip");
const trickArea = document.querySelector("#trick-area");
const statusLine = document.querySelector("#status-line");
const lastTrick = document.querySelector("#last-trick");
const handTitle = document.querySelector("#hand-title");
const handEl = document.querySelector("#hand");
const exposeButton = document.querySelector("#expose-button");
const exposedList = document.querySelector("#exposed-list");
const scorePreview = document.querySelector("#score-preview");
const messages = document.querySelector("#messages");
const modal = document.querySelector("#modal");
const modalTitle = document.querySelector("#modal-title");
const modalBody = document.querySelector("#modal-body");
const modalClose = document.querySelector("#modal-close");
const chatList = document.querySelector("#chat-list");
const chatForm = document.querySelector("#chat-form");
const chatInput = document.querySelector("#chat-input");
const voiceStatus = document.querySelector("#voice-status");

let localVoiceStream = null;
let voiceEnabled = false;
const peerConnections = new Map();
const remoteAudio = new Map();
const remoteVoiceStates = new Map();

const params = new URLSearchParams(window.location.search);
if (params.get("room")) {
  codeInput.value = params.get("room").toUpperCase().slice(0, 4);
}

nameInput.value = localStorage.getItem("gongzhuName") || "";

createButton.addEventListener("click", () => {
  const name = getName();
  socket.emit("createRoom", { name }, handleJoinResponse);
});

joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const code = codeInput.value.trim().toUpperCase();
  if (!code) {
    entryError.textContent = "请输入房间码，或者点击创建房间。";
    return;
  }
  socket.emit("joinRoom", { code, name: getName() }, handleJoinResponse);
});

startButton.addEventListener("click", () => {
  emitAction("startGame", {});
});

finishExposeButton.addEventListener("click", () => {
  emitAction("finishExpose", {});
});

newRoundButton.addEventListener("click", () => {
  selectedExpose.clear();
  emitAction("newRound", {});
});

copyLinkButton.addEventListener("click", async () => {
  if (!state?.code) return;
  const url = `${window.location.origin}?room=${state.code}`;
  try {
    await navigator.clipboard.writeText(url);
    copyLinkButton.textContent = "已复制";
    setTimeout(() => {
      copyLinkButton.textContent = "复制邀请链接";
    }, 1200);
  } catch {
    window.prompt("复制邀请链接", url);
  }
});

exposeButton.addEventListener("click", () => {
  const cardIds = [...selectedExpose];
  if (!cardIds.length) return;
  emitAction("exposeCards", { cardIds }, () => selectedExpose.clear());
});

historyButton.addEventListener("click", () => {
  openHistory();
});

rulesButton.addEventListener("click", () => {
  openRules();
});

modalClose.addEventListener("click", closeModal);
modal.addEventListener("click", (event) => {
  if (event.target === modal) closeModal();
});

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  socket.emit("chatMessage", { text }, (response) => {
    if (!response?.ok) {
      statusLine.textContent = response?.error || "发送失败";
      return;
    }
    chatInput.value = "";
  });
});

voiceButton.addEventListener("click", () => {
  if (voiceEnabled) stopVoice();
  else startVoice();
});

socket.on("state", (nextState) => {
  state = nextState;
  entry.classList.add("hidden");
  game.classList.remove("hidden");
  render();
  syncVoicePeers();
});

socket.on("chatMessage", (chat) => {
  if (!state) return;
  state.chats = [...(state.chats || []), chat].slice(-80);
  renderChat();
});

socket.on("voiceSignal", async ({ fromId, signal }) => {
  await handleVoiceSignal(fromId, signal);
});

socket.on("voiceState", ({ socketId, enabled }) => {
  remoteVoiceStates.set(socketId, Boolean(enabled));
  updateVoiceStatus();
});

function getName() {
  const name = nameInput.value.trim() || "玩家";
  localStorage.setItem("gongzhuName", name);
  return name;
}

function handleJoinResponse(response) {
  if (!response?.ok) {
    entryError.textContent = response?.error || "操作失败";
    return;
  }
  entryError.textContent = "";
  if (response.code) {
    window.history.replaceState(null, "", `?room=${response.code}`);
  }
}

function emitAction(event, payload, afterOk) {
  socket.emit(event, payload, (response) => {
    if (!response?.ok) {
      statusLine.textContent = response?.error || "操作失败";
      return;
    }
    afterOk?.();
  });
}

function render() {
  if (!state) return;
  const phase = state.round?.phase || state.phase || "lobby";
  const myTurn = phase === "play" && state.me?.seat === state.round?.currentPlayer;
  game.dataset.phase = phase;
  game.dataset.myTurn = myTurn ? "true" : "false";
  roomCode.textContent = state.code;
  renderTopbar();
  renderScores();
  renderSlots();
  renderTrick();
  renderHand();
  renderSidePanel();
  renderChat();
  updateVoiceStatus();
}

function renderTopbar() {
  const playerCount = state.players.length;
  const phase = state.round?.phase;
  const current = state.players[state.round?.currentPlayer];

  if (state.phase === "lobby") {
    phaseTitle.textContent = `等待玩家 ${playerCount}/4`;
  } else if (phase === "expose") {
    phaseTitle.textContent = "卖牌阶段";
  } else if (phase === "play") {
    phaseTitle.textContent = current ? `轮到 ${current.name} 出牌` : "出牌中";
  } else if (phase === "finished") {
    phaseTitle.textContent = `本局结束 · ${roundSummary()}`;
  }

  const isHost = state.hostId === socket.id;
  startButton.classList.toggle("hidden", state.phase !== "lobby");
  startButton.disabled = !isHost || playerCount !== 4;
  finishExposeButton.classList.toggle("hidden", phase !== "expose");
  const canFinishExpose = isHost || state.me?.seat === state.round?.starter;
  finishExposeButton.disabled = !canFinishExpose;
  newRoundButton.classList.toggle("hidden", phase !== "finished");
  newRoundButton.disabled = !isHost;
}

function renderScores() {
  scoreStrip.innerHTML = "";
  for (let seat = 0; seat < 4; seat += 1) {
    const player = state.players[seat];
    const currentScore = currentRoundScore(seat);
    const card = document.createElement("div");
    card.className = "score-card";
    if (state.round?.currentPlayer === seat) card.classList.add("active");
    if (state.me?.seat === seat) card.classList.add("me");
    card.innerHTML = `
      <div class="name">
        <span class="seat-badge">${player?.directionLabel || seat + 1}</span>
        <span class="name-text">${escapeHtml(player?.name || `空位 ${seat + 1}`)}</span>
        <strong>${formatScore(currentScore)}</strong>
      </div>
      <div class="meta">总分 ${formatScore(player?.totalScore || 0)} · 手牌 ${player?.handCount || 0}</div>
    `;
    scoreStrip.appendChild(card);
  }
}

function renderSlots() {
  document.querySelectorAll(".player-slot").forEach((slot) => {
    const seat = Number(slot.dataset.seat);
    const player = state.players[seat];
    const currentScore = currentRoundScore(seat);
    slot.classList.toggle("current", state.round?.currentPlayer === seat);
    slot.classList.toggle("me", state.me?.seat === seat);
    slot.classList.toggle("offline", player?.connected === false);
    slot.innerHTML = `
      <div class="slot-top">
        <span class="slot-seat">${player?.directionLabel || ""}</span>
        <span class="slot-name">${escapeHtml(player?.name || "空位")}</span>
      </div>
      <div class="slot-meta">${player ? `当前 ${formatScore(currentScore)} · 手牌 ${player.handCount}` : "等待加入"}</div>
      ${player?.connected === false ? `<div class="slot-alert">断线</div>` : ""}
    `;
  });
}

function renderTrick() {
  trickArea.innerHTML = "";
  const trick = state.round?.trick || [];
  for (const play of trick) {
    const wrapper = document.createElement("div");
    wrapper.className = "played-card";
    wrapper.dataset.pos = play.seat;
    wrapper.style.setProperty("--seat", play.seat);
    wrapper.appendChild(makeCard(play.card, { small: true, disabled: true, exposed: play.exposed }));
    trickArea.appendChild(wrapper);
  }

  const phase = state.round?.phase;
  if (phase === "play" && state.me?.seat === state.round?.currentPlayer) {
    statusLine.textContent = "轮到你出牌";
  } else if (phase === "expose") {
    statusLine.textContent = "可选择手里的猪、羊、变压器或红桃 A 卖牌";
  } else if (phase === "finished") {
    statusLine.textContent = "房主可以开始下一局";
  } else {
    statusLine.textContent = "";
  }

  if (state.round?.lastTrick) {
    const cards = state.round.lastTrick.cards.map((play) => formatCard(play.card));
    lastTrick.innerHTML = `
      <span>上一墩 ${escapeHtml(state.round.lastTrick.winnerName)} 收下</span>
      <strong>${cards.map(escapeHtml).join(" · ")}</strong>
    `;
  } else {
    lastTrick.textContent = "";
  }
}

function renderHand() {
  handEl.innerHTML = "";
  const hand = [...(state.hand || [])].sort(compareCards);
  const legal = new Set(state.legalPlays || []);
  const exposable = new Set(state.canExpose || []);
  const phase = state.round?.phase;
  handTitle.textContent = state.me ? `${state.me.directionLabel}家 · ${hand.length} 张` : "旁观中";

  exposeButton.classList.toggle("hidden", phase !== "expose" || exposable.size === 0);
  exposeButton.disabled = selectedExpose.size === 0;

  hand.forEach((card, index) => {
    const canPlay = phase === "play" && legal.has(card.id);
    const canExpose = phase === "expose" && exposable.has(card.id);
    const cardEl = makeCard(card, {
      disabled: phase === "play" ? !canPlay : !canExpose,
      selected: selectedExpose.has(card.id),
      exposable: canExpose,
      legal: canPlay
    });
    cardEl.style.setProperty("--i", index);

    cardEl.addEventListener("click", () => {
      if (phase === "expose") {
        if (!canExpose) return;
        if (selectedExpose.has(card.id)) selectedExpose.delete(card.id);
        else selectedExpose.add(card.id);
        renderHand();
        return;
      }
      if (phase === "play" && canPlay) {
        emitAction("playCard", { cardId: card.id });
      }
    });
    handEl.appendChild(cardEl);
  });
}

function renderSidePanel() {
  renderExposed();
  scorePreview.innerHTML = "";
  const preview = state.round?.scorePreview || [0, 0, 0, 0];
  for (let seat = 0; seat < 4; seat += 1) {
    const row = document.createElement("div");
    row.className = "mini-row";
    row.innerHTML = `<span>${escapeHtml(state.players[seat]?.name || `空位 ${seat + 1}`)}</span><strong>${formatScore(preview[seat] || 0)}</strong>`;
    scorePreview.appendChild(row);
  }

  messages.innerHTML = "";
  for (const message of state.messages || []) {
    const item = document.createElement("div");
    item.className = "message";
    item.textContent = message.text;
    messages.appendChild(item);
  }
  messages.scrollTop = messages.scrollHeight;
}

function renderChat() {
  chatList.innerHTML = "";
  const chats = state?.chats || [];
  if (!chats.length) {
    chatList.innerHTML = `<div class="chat-empty">暂无聊天</div>`;
    return;
  }
  for (const chat of chats) {
    const item = document.createElement("div");
    item.className = "chat-item";
    if (chat.senderId === socket.id) item.classList.add("mine");
    item.innerHTML = `
      <div class="chat-meta">${escapeHtml(chat.senderName || "玩家")} · ${formatTime(chat.at)}</div>
      <div class="chat-text">${escapeHtml(chat.text)}</div>
    `;
    chatList.appendChild(item);
  }
  chatList.scrollTop = chatList.scrollHeight;
}

function renderExposed() {
  exposedList.innerHTML = "";
  const exposed = state.round?.exposed;
  if (!exposed) {
    exposedList.innerHTML = `<span class="pill">暂无</span>`;
    return;
  }
  const items = [];
  for (const id of ["SQ", "DJ", "C10", "HA"]) {
    if (exposed[id] !== null && exposed[id] !== undefined) items.push({ id, seat: exposed[id] });
  }
  if (!items.length) {
    exposedList.innerHTML = `<span class="pill">暂无</span>`;
    return;
  }
  for (const item of items.sort((a, b) => compareCardIds(a.id, b.id))) {
    const pill = document.createElement("span");
    pill.className = "pill";
    pill.textContent = `${formatCardId(item.id)} · ${state.players[item.seat]?.name || ""}`;
    exposedList.appendChild(pill);
  }
}

function makeCard(card, options = {}) {
  const el = document.createElement("div");
  el.className = `card ${card.suit === "H" || card.suit === "D" ? "red" : "black"}`;
  if (options.small) el.classList.add("small");
  if (options.disabled) el.classList.add("disabled");
  if (options.selected) el.classList.add("selected");
  if (options.exposable) el.classList.add("exposable");
  if (options.legal) el.classList.add("legal");
  el.dataset.card = card.id;
  const label = SPECIAL_NAMES[card.id] || (options.exposed ? "已卖" : "");
  el.innerHTML = `
    <div class="rank">${escapeHtml(card.rank)}</div>
    <div class="suit">${SUIT_SYMBOLS[card.suit]}</div>
    <div class="label">${label}</div>
  `;
  return el;
}

function compareCards(a, b) {
  return compareCardIds(a.id, b.id);
}

function compareCardIds(a, b) {
  const suitOrder = { S: 0, H: 1, D: 2, C: 3 };
  const suitDiff = suitOrder[a[0]] - suitOrder[b[0]];
  if (suitDiff) return suitDiff;
  return RANK_ORDER.indexOf(a.slice(1)) - RANK_ORDER.indexOf(b.slice(1));
}

function formatCard(card) {
  return `${SUIT_NAMES[card.suit]}${card.rank}`;
}

function formatCardId(id) {
  return `${SUIT_NAMES[id[0]]}${id.slice(1)}${SPECIAL_NAMES[id] ? ` ${SPECIAL_NAMES[id]}` : ""}`;
}

function formatScore(score) {
  return score > 0 ? `+${score}` : String(score);
}

function currentRoundScore(seat) {
  return state?.round?.scorePreview?.[seat] ?? state?.round?.finishedScores?.[seat] ?? 0;
}

function roundSummary() {
  const scores = state?.round?.finishedScores;
  if (!scores) return "查看历史";
  return scores
    .map((score, seat) => `${state.players[seat]?.name || seat + 1} ${formatScore(score)}`)
    .join(" / ");
}

function openHistory() {
  modalTitle.textContent = "牌局历史";
  const items = state?.messages || [];
  const chats = state?.chats || [];
  modalBody.innerHTML = `
      ${items.length ? `<div class="history-list">${items.map((message) => `
        <div class="history-item">
          <time>${formatTime(message.at)}</time>
          <span>${escapeHtml(message.text)}</span>
        </div>
      `).join("")}</div>` : `<p class="empty-note">暂无牌局动态。</p>`}
      <h3 class="modal-subtitle">聊天记录</h3>
      ${chats.length ? `<div class="history-list">${chats.map((chat) => `
        <div class="history-item">
          <time>${formatTime(chat.at)}</time>
          <span>${escapeHtml(chat.senderName || "玩家")}：${escapeHtml(chat.text)}</span>
        </div>
      `).join("")}</div>` : `<p class="empty-note">暂无聊天记录。</p>`}
  `;
  openModal();
}

function openRules() {
  modalTitle.textContent = "规则速查";
  modalBody.innerHTML = `
    <div class="rules-grid">
      <div><strong>卖牌</strong><span>开局可卖猪、羊、变压器、红桃 A。卖过的牌分值翻倍或变压器翻四倍。</span></div>
      <div><strong>首出</strong><span>持黑桃 2 的玩家首出，第一墩必须先出黑桃 2。</span></div>
      <div><strong>跟牌</strong><span>必须跟首出花色，没有该花色时可以垫任意牌。</span></div>
      <div><strong>分牌</strong><span>猪 -100，羊 +100，红桃 5-A 为负分，变压器单收 +50。</span></div>
      <div><strong>全红</strong><span>收齐全部红桃转为 +200；红桃 A 被卖后为 +400。</span></div>
      <div><strong>聊天语音</strong><span>房间内支持文字聊天和语音。语音需允许浏览器麦克风权限。</span></div>
      <div><strong>嘉铭赞助</strong><span>本桌由嘉铭冠名赞助，输赢各凭牌技。</span></div>
    </div>
  `;
  openModal();
}

async function startVoice() {
  if (!navigator.mediaDevices?.getUserMedia) {
    statusLine.textContent = "当前浏览器不支持语音";
    return;
  }
  try {
    localVoiceStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    });
    voiceEnabled = true;
    voiceButton.textContent = "关闭语音";
    voiceButton.classList.add("voice-on");
    socket.emit("voiceState", { enabled: true });
    await syncVoicePeers();
    updateVoiceStatus();
  } catch {
    statusLine.textContent = "无法开启麦克风，请检查浏览器权限";
  }
}

function stopVoice() {
  voiceEnabled = false;
  voiceButton.textContent = "开启语音";
  voiceButton.classList.remove("voice-on");
  socket.emit("voiceState", { enabled: false });
  if (localVoiceStream) {
    for (const track of localVoiceStream.getTracks()) track.stop();
  }
  localVoiceStream = null;
  for (const [peerId, connection] of peerConnections) {
    connection.close();
    peerConnections.delete(peerId);
  }
  updateVoiceStatus();
}

async function syncVoicePeers() {
  if (!voiceEnabled || !state?.players?.length) return;
  const peers = state.players
    .filter((player) => player.socketId && player.socketId !== socket.id && player.connected !== false)
    .map((player) => player.socketId);
  for (const peerId of peers) {
    if (!peerConnections.has(peerId) && socket.id < peerId) {
      await createPeerConnection(peerId, true);
    }
  }
}

async function handleVoiceSignal(fromId, signal) {
  if (!signal) return;
  if (!voiceEnabled && signal.type !== "state") return;
  const connection = await createPeerConnection(fromId, false);
  if (signal.type === "offer") {
    await connection.setRemoteDescription(signal.description);
    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);
    sendVoiceSignal(fromId, { type: "answer", description: connection.localDescription });
  } else if (signal.type === "answer") {
    await connection.setRemoteDescription(signal.description);
  } else if (signal.type === "candidate" && signal.candidate) {
    try {
      await connection.addIceCandidate(signal.candidate);
    } catch {
      // ICE candidates can arrive after a peer has already closed voice.
    }
  }
}

async function createPeerConnection(peerId, initiator) {
  if (peerConnections.has(peerId)) return peerConnections.get(peerId);
  const connection = new RTCPeerConnection({
    iceServers: [
      { urls: "stun:stun.miwifi.com:3478" },
      { urls: "stun:stun.chat.bilibili.com:3478" },
      { urls: "stun:stun.hitv.com:3478" },
      { urls: "stun:stun.cdnbye.com:3478" },
      {
        urls: "turn:openrelay.metered.ca:80",
        username: "openrelayproject",
        credential: "openrelayproject"
      },
      {
        urls: "turn:openrelay.metered.ca:443",
        username: "openrelayproject",
        credential: "openrelayproject"
      }
    ]
  });
  peerConnections.set(peerId, connection);

  if (localVoiceStream) {
    for (const track of localVoiceStream.getAudioTracks()) {
      connection.addTrack(track, localVoiceStream);
    }
  }

  connection.onicecandidate = (event) => {
    if (event.candidate) {
      sendVoiceSignal(peerId, { type: "candidate", candidate: event.candidate });
    }
  };

  connection.ontrack = (event) => {
    let audio = remoteAudio.get(peerId);
    if (!audio) {
      audio = document.createElement("audio");
      audio.autoplay = true;
      audio.playsInline = true;
      document.body.appendChild(audio);
      remoteAudio.set(peerId, audio);
    }
    audio.srcObject = event.streams[0];
  };

  connection.onconnectionstatechange = () => {
    if (["closed", "failed", "disconnected"].includes(connection.connectionState)) {
      peerConnections.delete(peerId);
      remoteVoiceStates.delete(peerId);
      updateVoiceStatus();
    }
  };

  if (initiator) {
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    sendVoiceSignal(peerId, { type: "offer", description: connection.localDescription });
  }

  return connection;
}

function sendVoiceSignal(targetId, signal) {
  socket.emit("voiceSignal", { targetId, signal }, (response) => {
    if (!response?.ok) {
      statusLine.textContent = response?.error || "语音连接失败";
    }
  });
}

function updateVoiceStatus() {
  const activeNames = (state?.players || [])
    .filter((player) => player.socketId === socket.id ? voiceEnabled : remoteVoiceStates.get(player.socketId))
    .map((player) => player.name);
  voiceStatus.textContent = voiceEnabled
    ? `语音已开启${activeNames.length ? ` · ${activeNames.join("、")}` : ""}`
    : "语音未开启";
}

function openModal() {
  modal.classList.remove("hidden");
}

function closeModal() {
  modal.classList.add("hidden");
}

function formatTime(timestamp) {
  if (!timestamp) return "";
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
