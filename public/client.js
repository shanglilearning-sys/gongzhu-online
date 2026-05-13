const socket = io({
  transports: ["websocket"],
  upgrade: false
});

const SUIT_SYMBOLS = { S: "♠", H: "♥", D: "♦", C: "♣" };
const SUIT_NAMES = { S: "黑桃", H: "红桃", D: "方块", C: "梅花" };
const SPECIAL_NAMES = { SQ: "猪", DJ: "羊", C10: "变压器", HA: "红桃A" };
const RANK_ORDER = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const CLIENT_ID_KEY = "gongzhuClientId";

let state = null;
let selectedExpose = new Set();
const clientId = getClientId();

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
const speakerButton = document.querySelector("#speaker-button");
const micButton = document.querySelector("#mic-button");
const scoreStrip = document.querySelector("#score-strip");
const trickArea = document.querySelector("#trick-area");
const statusLine = document.querySelector("#status-line");
const lastTrick = document.querySelector("#last-trick");
const tableWrap = document.querySelector(".table-wrap");
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
let speakerEnabled = false;
let micEnabled = false;
let resumeInFlight = false;
const peerConnections = new Map();
const remoteAudio = new Map();
const remoteVoiceStates = new Map();
const pendingIceCandidates = new Map();

const params = new URLSearchParams(window.location.search);
if (params.get("room")) {
  codeInput.value = params.get("room").toUpperCase().slice(0, 4);
}

nameInput.value = localStorage.getItem("gongzhuName") || "";

createButton.addEventListener("click", () => {
  const name = getName();
  socket.emit("createRoom", { name, clientId }, handleJoinResponse);
});

joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const code = codeInput.value.trim().toUpperCase();
  if (!code) {
    entryError.textContent = "请输入房间码，或者点击创建房间。";
    return;
  }
  socket.emit("joinRoom", { code, name: getName(), clientId }, handleJoinResponse);
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

speakerButton.addEventListener("click", () => {
  if (speakerEnabled) stopSpeaker();
  else startSpeaker();
});

micButton.addEventListener("click", () => {
  if (micEnabled) stopMic();
  else startMic();
});

socket.on("state", (nextState) => {
  state = nextState;
  localStorage.setItem("gongzhuLastRoom", nextState.code);
  entry.classList.add("hidden");
  game.classList.remove("hidden");
  render();
  syncVoicePeers();
});

socket.on("connect", () => {
  if (!state?.code || resumeInFlight) return;
  resumeInFlight = true;
  socket.emit("joinRoom", { code: state.code, name: getName(), clientId }, (response) => {
    resumeInFlight = false;
    if (!response?.ok) {
      statusLine.textContent = response?.error || "重连房间失败，请刷新后重新加入";
    }
  });
});

socket.on("chatMessage", (chat) => {
  if (!state) return;
  state.chats = [...(state.chats || []), chat].slice(-80);
  renderChat();
});

socket.on("voiceSignal", async ({ fromId, signal }) => {
  console.log("[voice] received voiceSignal from", fromId, "type:", signal?.type);
  await handleVoiceSignal(fromId, signal);
});

socket.on("voiceState", ({ socketId, enabled, speakerEnabled: remoteSpeakerEnabled, micEnabled: remoteMicEnabled }) => {
  remoteVoiceStates.set(socketId, {
    speakerEnabled: remoteSpeakerEnabled ?? Boolean(enabled),
    micEnabled: remoteMicEnabled ?? Boolean(enabled)
  });
  syncVoicePeers();
  updateVoiceStatus();
});

function getName() {
  const name = nameInput.value.trim() || "玩家";
  localStorage.setItem("gongzhuName", name);
  return name;
}

function getClientId() {
  try {
    const existing = localStorage.getItem(CLIENT_ID_KEY);
    if (existing) return existing;
    const id = window.crypto?.randomUUID
      ? window.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(CLIENT_ID_KEY, id);
    return id;
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
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
    if (player) {
      card.classList.add("inspectable");
      card.title = "查看本轮分牌";
      card.addEventListener("click", () => openScoreCards(seat));
    }
    card.innerHTML = `
      <div class="name">
        <span class="seat-badge">${player?.directionLabel || seat + 1}</span>
        <span class="name-text">${escapeHtml(player?.name || `空位 ${seat + 1}`)}</span>
        <strong>${formatScore(currentScore)}</strong>
      </div>
      <div class="meta">${player ? `本轮 ${formatScore(currentScore)} · 当猪 ${player.pigCount || 0} 局 · 手牌 ${player.handCount || 0}` : "等待加入"}</div>
    `;
    scoreStrip.appendChild(card);
  }
}

function renderSlots() {
  renderTableExposedBadge();
  document.querySelectorAll(".player-slot").forEach((slot) => {
    const seat = Number(slot.dataset.seat);
    const player = state.players[seat];
    const currentScore = currentRoundScore(seat);
    slot.classList.toggle("current", state.round?.currentPlayer === seat);
    slot.classList.toggle("me", state.me?.seat === seat);
    slot.classList.toggle("offline", player?.connected === false);
    slot.classList.toggle("inspectable", Boolean(player));
    slot.title = player ? "查看本轮分牌" : "";
    slot.tabIndex = player ? 0 : -1;
    slot.onclick = player ? () => openScoreCards(seat) : null;
    slot.onkeydown = player ? (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openScoreCards(seat);
      }
    } : null;
    slot.innerHTML = `
      <div class="slot-top">
        <span class="slot-seat">${player?.directionLabel || ""}</span>
        <span class="slot-name">${escapeHtml(player?.name || "空位")}</span>
      </div>
      <div class="slot-meta">${player ? `${formatScore(currentScore)} · 猪 ${player.pigCount || 0} · 手牌 ${player.handCount}` : "等待加入"}</div>
      ${player?.connected === false ? `<div class="slot-alert">断线</div>` : ""}
    `;
  });
}

function renderTableExposedBadge() {
  if (!tableWrap) return;
  tableWrap.querySelector(".table-exposed-badge")?.remove();
  const items = getExposedItems();
  if (!items.length) return;
  const badge = document.createElement("div");
  badge.className = "table-exposed-badge";
  badge.innerHTML = `
    <div class="badge-title">已卖</div>
    <div class="badge-list">
      ${items.map((item) => `<span>${escapeHtml(shortCardLabel(item.id))}<em>${escapeHtml(state.players[item.seat]?.name || "")}</em></span>`).join("")}
    </div>
  `;
  tableWrap.appendChild(badge);
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
  if (state.round?.settlingTrick) {
    statusLine.textContent = "本墩结算中";
  } else if (phase === "play" && state.me?.seat === state.round?.currentPlayer) {
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
  const items = getExposedItems();
  if (!state.round?.exposed) {
    exposedList.innerHTML = `<span class="pill">暂无</span>`;
    return;
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

function getExposedItems() {
  const exposed = state?.round?.exposed;
  if (!exposed) return [];
  const items = [];
  for (const id of ["SQ", "DJ", "C10", "HA"]) {
    if (exposed[id] !== null && exposed[id] !== undefined) items.push({ id, seat: exposed[id] });
  }
  return items.sort((a, b) => compareCardIds(a.id, b.id));
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

function shortCardLabel(id) {
  return SPECIAL_NAMES[id] || `${SUIT_SYMBOLS[id[0]]}${id.slice(1)}`;
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

function openScoreCards(seat) {
  const player = state?.players?.[seat];
  if (!player) return;
  const cards = [...(player.scoreCards || [])].sort(compareCards);
  const score = currentRoundScore(seat);
  modalTitle.textContent = `${player.name} 的本轮分牌`;
  modalBody.innerHTML = `
    <div class="score-detail-head">
      <span>${escapeHtml(player.directionLabel || "")}家</span>
      <strong>本轮分数 ${formatScore(score)}</strong>
    </div>
    ${renderScoreCardGroup("血（红桃）", cards.filter((card) => card.suit === "H"))}
    ${renderScoreCardGroup("猪", cards.filter((card) => card.id === "SQ"))}
    ${renderScoreCardGroup("羊", cards.filter((card) => card.id === "DJ"))}
    ${renderScoreCardGroup("变压器", cards.filter((card) => card.id === "C10"))}
    ${cards.length ? "" : `<p class="empty-note">本轮还没有收到分牌。</p>`}
  `;
  openModal();
}

function renderScoreCardGroup(title, cards) {
  if (!cards.length) return "";
  return `
    <section class="score-card-group">
      <h3>${escapeHtml(title)}</h3>
      <div class="score-card-list">
        ${cards.map((card) => `<span class="score-card-pill ${card.suit === "H" || card.suit === "D" ? "red" : "black"}">${escapeHtml(formatCardId(card.id))}</span>`).join("")}
      </div>
    </section>
  `;
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
      <div><strong>聊天语音</strong><span>先开听筒才能听别人，开麦克风才会把自己的声音发出去。手机端首次开启听筒用于解锁播放。</span></div>
      <div><strong>嘉铭赞助</strong><span>本桌由嘉铭冠名赞助，输赢各凭牌技。</span></div>
    </div>
  `;
  openModal();
}

async function startSpeaker() {
  speakerEnabled = true;
  speakerButton.textContent = "关闭听筒";
  speakerButton.classList.add("voice-on");
  unlockRemoteAudio();
  socket.emit("voiceState", { speakerEnabled: true });
  await syncVoicePeers();
  updateVoiceStatus();
}

function stopSpeaker() {
  speakerEnabled = false;
  speakerButton.textContent = "开启听筒";
  speakerButton.classList.remove("voice-on");
  socket.emit("voiceState", { speakerEnabled: false });
  closeReceiveOnlyConnections();
  for (const audio of remoteAudio.values()) {
    audio.pause();
    audio.srcObject = null;
  }
  updateVoiceStatus();
}

async function startMic() {
  if (!navigator.mediaDevices?.getUserMedia) {
    statusLine.textContent = "当前浏览器不支持麦克风";
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
    for (const track of localVoiceStream.getAudioTracks()) track.enabled = true;
    console.log("[voice] got local stream, tracks:", localVoiceStream.getAudioTracks().length);
    micEnabled = true;
    micButton.textContent = "关闭麦克风";
    micButton.classList.add("voice-on");
    socket.emit("voiceState", { micEnabled: true });
    await syncVoicePeers();
    updateVoiceStatus();
  } catch (e) {
    console.error("[voice] getUserMedia failed:", e);
    statusLine.textContent = "无法开启麦克风，请检查浏览器权限";
  }
}

function stopMic() {
  micEnabled = false;
  micButton.textContent = "开启麦克风";
  micButton.classList.remove("voice-on");
  socket.emit("voiceState", { micEnabled: false });
  if (localVoiceStream) {
    for (const track of localVoiceStream.getTracks()) track.stop();
  }
  localVoiceStream = null;
  closeSendOnlyConnections();
  syncVoicePeers();
  updateVoiceStatus();
}

async function syncVoicePeers() {
  if (!state?.players?.length) return;
  const peers = state.players.filter((player) => player.socketId && player.socketId !== socket.id && player.connected !== false);
  const desiredPeerIds = new Set();
  for (const player of peers) {
    const peerState = getVoiceStateForPlayer(player);
    const shouldConnect = (speakerEnabled && peerState.micEnabled) || (micEnabled && peerState.speakerEnabled);
    if (shouldConnect) {
      desiredPeerIds.add(player.socketId);
      if (!peerConnections.has(player.socketId)) {
        const initiator = micEnabled && peerState.speakerEnabled;
        console.log("[voice] creating desired connection to", player.socketId, "initiator:", initiator);
        await createPeerConnection(player.socketId, initiator);
      } else {
        ensureLocalTracks(peerConnections.get(player.socketId));
      }
    }
  }

  for (const peerId of [...peerConnections.keys()]) {
    if (!desiredPeerIds.has(peerId)) closePeerConnection(peerId);
  }
}

async function handleVoiceSignal(fromId, signal) {
  if (!signal) return;
  console.log("[voice] signal from", fromId, "type:", signal.type);
  const fromPlayer = state?.players?.find((player) => player.socketId === fromId);
  const fromState = fromPlayer ? getVoiceStateForPlayer(fromPlayer) : remoteVoiceStates.get(fromId);
  const shouldAccept = signal.type === "candidate"
    || (speakerEnabled && fromState?.micEnabled)
    || (micEnabled && fromState?.speakerEnabled);
  if (!shouldAccept) {
    console.log("[voice] ignored signal; no matching speaker/mic state");
    return;
  }

  try {
    if (signal.type === "offer") {
      const existing = peerConnections.get(fromId);
      if (existing && existing.signalingState !== "stable") {
        closePeerConnection(fromId);
      }
      const connection = await createPeerConnection(fromId, false);
      await connection.setRemoteDescription(signal.description);
      await flushPendingIce(fromId, connection);
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      console.log("[voice] sending answer to", fromId);
      sendVoiceSignal(fromId, { type: "answer", description: connection.localDescription });
    } else if (signal.type === "answer") {
      const connection = peerConnections.get(fromId);
      if (!connection) return;
      await connection.setRemoteDescription(signal.description);
      await flushPendingIce(fromId, connection);
      console.log("[voice] set remote answer from", fromId);
    } else if (signal.type === "candidate" && signal.candidate) {
      const connection = peerConnections.get(fromId);
      if (connection?.remoteDescription) {
        await connection.addIceCandidate(signal.candidate);
      } else {
        queuePendingIce(fromId, signal.candidate);
      }
    }
  } catch (e) {
    console.error("[voice] signal error:", e);
  }
}

async function createPeerConnection(peerId, initiator) {
  const existing = peerConnections.get(peerId);
  if (existing) {
    ensureLocalTracks(existing);
    return existing;
  }
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
  connection._initiator = initiator;
  peerConnections.set(peerId, connection);
  console.log("[voice] created", initiator ? "initiator" : "answerer", "connection to", peerId);

  ensureLocalTracks(connection);

  connection.onicecandidate = (event) => {
    if (event.candidate) {
      sendVoiceSignal(peerId, { type: "candidate", candidate: event.candidate });
    }
  };

  connection.ontrack = (event) => {
    console.log("[voice] ontrack from", peerId, "streams:", event.streams.length, "tracks:", event.streams[0]?.getAudioTracks().length);
    let audio = remoteAudio.get(peerId);
    if (!audio) {
      audio = document.createElement("audio");
      audio.autoplay = true;
      audio.playsInline = true;
      audio.volume = 1.0;
      document.body.appendChild(audio);
      remoteAudio.set(peerId, audio);
      console.log("[voice] created audio element for", peerId);
    }
    audio.srcObject = event.streams[0];
    if (speakerEnabled) {
      audio.play().catch((e) => {
        console.error("[voice] audio play failed:", e);
        statusLine.textContent = "听筒被浏览器拦截，请再点一次开启听筒";
      });
    }
  };

  connection.onconnectionstatechange = () => {
    console.log("[voice] connection state to", peerId, ":", connection.connectionState);
    if (["closed", "failed", "disconnected"].includes(connection.connectionState)) {
      peerConnections.delete(peerId);
      updateVoiceStatus();
      if (connection.connectionState === "failed") setTimeout(syncVoicePeers, 800);
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

function ensureLocalTracks(connection) {
  const currentTracks = new Set(connection.getSenders().map((sender) => sender.track).filter(Boolean));
  if (!micEnabled || !localVoiceStream) return;
  for (const track of localVoiceStream.getAudioTracks()) {
    if (!currentTracks.has(track)) connection.addTrack(track, localVoiceStream);
  }
}

function closePeerConnection(peerId) {
  const connection = peerConnections.get(peerId);
  if (connection) connection.close();
  peerConnections.delete(peerId);
  pendingIceCandidates.delete(peerId);
  const audio = remoteAudio.get(peerId);
  if (audio) {
    audio.pause();
    audio.srcObject = null;
    audio.remove();
  }
  remoteAudio.delete(peerId);
}

function closeReceiveOnlyConnections() {
  for (const player of state?.players || []) {
    if (player.socketId && getVoiceStateForPlayer(player).micEnabled && !micEnabled) {
      closePeerConnection(player.socketId);
    }
  }
}

function closeSendOnlyConnections() {
  for (const player of state?.players || []) {
    if (player.socketId && getVoiceStateForPlayer(player).speakerEnabled && !speakerEnabled) {
      closePeerConnection(player.socketId);
    }
  }
}

function queuePendingIce(peerId, candidate) {
  if (!pendingIceCandidates.has(peerId)) pendingIceCandidates.set(peerId, []);
  pendingIceCandidates.get(peerId).push(candidate);
}

async function flushPendingIce(peerId, connection) {
  const candidates = pendingIceCandidates.get(peerId) || [];
  pendingIceCandidates.delete(peerId);
  for (const candidate of candidates) {
    await connection.addIceCandidate(candidate);
  }
}

function unlockRemoteAudio() {
  for (const audio of remoteAudio.values()) {
    audio.muted = false;
    audio.play().catch(() => {});
  }
}

function getVoiceStateForPlayer(player) {
  if (!player) return { speakerEnabled: false, micEnabled: false };
  if (player.socketId === socket.id) return { speakerEnabled, micEnabled };
  const runtimeState = remoteVoiceStates.get(player.socketId);
  return {
    speakerEnabled: runtimeState?.speakerEnabled ?? Boolean(player.voiceSpeakerEnabled),
    micEnabled: runtimeState?.micEnabled ?? Boolean(player.voiceMicEnabled)
  };
}

function updateVoiceStatus() {
  const micNames = (state?.players || [])
    .filter((player) => getVoiceStateForPlayer(player).micEnabled)
    .map((player) => player.name);
  const parts = [
    speakerEnabled ? "听筒开" : "听筒关",
    micEnabled ? "麦克风开" : "麦克风关"
  ];
  voiceStatus.textContent = `${parts.join(" · ")}${micNames.length ? ` · 正在说话：${micNames.join("、")}` : ""}`;
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
