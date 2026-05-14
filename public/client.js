const socket = io({
  transports: ["websocket"],
  upgrade: false
});

const SUIT_SYMBOLS = { S: "♠", H: "♥", D: "♦", C: "♣" };
const SUIT_NAMES = { S: "黑桃", H: "红桃", D: "方块", C: "梅花" };
const SPECIAL_NAMES = { SQ: "猪", DJ: "羊", C10: "变压器", HA: "红桃A" };
const RANK_ORDER = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const CLIENT_ID_KEY = "gongzhuClientId";
const DESKTOP_ZOOM_KEY = "gongzhuPageZoomV2";
const MOBILE_TABLE_SPREAD_KEY = "gongzhuMobileTableSpreadV1";
const MOBILE_QUERY = window.matchMedia("(max-width: 640px), (pointer: coarse)");

let state = null;
let selectedExpose = new Set();
const clientId = getClientId();

const entry = document.querySelector("#entry");
const game = document.querySelector("#game");
const joinForm = document.querySelector("#join-form");
const nameInput = document.querySelector("#name-input");
const codeInput = document.querySelector("#code-input");
const createButton = document.querySelector("#create-button");
const modeSelect = document.querySelector("#mode-select");
const entryError = document.querySelector("#entry-error");
const roomCode = document.querySelector("#room-code");
const phaseTitle = document.querySelector("#phase-title");
const startButton = document.querySelector("#start-button");
const newRoundButton = document.querySelector("#new-round-button");
const copyLinkButton = document.querySelector("#copy-link");
const historyButton = document.querySelector("#history-button");
const rulesButton = document.querySelector("#rules-button");
const tableModeButton = document.querySelector("#table-mode-button");
const uiScaleInput = document.querySelector("#ui-scale");
const uiScaleLabel = document.querySelector("#ui-scale-label");
const uiScaleValue = document.querySelector("#ui-scale-value");
const scoreStrip = document.querySelector("#score-strip");
const trickArea = document.querySelector("#trick-area");
const statusLine = document.querySelector("#status-line");
const lastTrick = document.querySelector("#last-trick");
const tableWrap = document.querySelector(".table-wrap");
const playerSlots = document.querySelector("#player-slots");
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

let resumeInFlight = false;
let tableModeEnabled = false;
let serverTimeOffset = 0;

const params = new URLSearchParams(window.location.search);
if (params.get("room")) {
  codeInput.value = params.get("room").toUpperCase().slice(0, 4);
}

nameInput.value = localStorage.getItem("gongzhuName") || "";
applyUiScale(getSavedUiScale());

createButton.addEventListener("click", () => {
  const name = getName();
  socket.emit("createRoom", { name, clientId, playerCount: getSelectedPlayerCount() }, handleJoinResponse);
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

tableModeButton.addEventListener("click", toggleTableMode);
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement && tableModeEnabled) {
    setTableMode(false);
  }
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

uiScaleInput?.addEventListener("input", () => {
  const value = clampScale(uiScaleInput.value);
  localStorage.setItem(activeScaleKey(), String(value));
  applyUiScale(value);
  renderSlots();
  renderTrick();
});

window.addEventListener("resize", () => {
  renderSlots();
  renderTrick();
});

screen.orientation?.addEventListener?.("change", () => {
  updateTableModeAvailability();
  renderSlots();
  renderTrick();
});

MOBILE_QUERY.addEventListener?.("change", () => {
  updateTableModeAvailability();
  applyUiScale(getSavedUiScale());
  renderSlots();
  renderTrick();
});

socket.on("state", (nextState) => {
  state = nextState;
  serverTimeOffset = (nextState.round?.serverNow || Date.now()) - Date.now();
  localStorage.setItem("gongzhuLastRoom", nextState.code);
  entry.classList.add("hidden");
  game.classList.remove("hidden");
  render();
});

socket.on("connect", () => {
  if (!state?.code || resumeInFlight) return;
  resumeInFlight = true;
  socket.emit("joinRoom", { code: state.code, name: getName(), clientId }, (response) => {
    resumeInFlight = false;
    if (!response?.ok) {
      statusLine.textContent = roomErrorMessage(response?.error || "重连房间失败，请刷新后重新加入");
    }
  });
});

socket.on("chatMessage", (chat) => {
  if (!state) return;
  state.chats = [...(state.chats || []), chat].slice(-80);
  renderChat();
});

socket.on("playerReaction", (reaction) => {
  showReaction(reaction);
});

setInterval(() => {
  if (state?.round?.phase !== "expose") return;
  renderTopbar();
  renderTrick();
}, 250);

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

function getSavedUiScale() {
  return clampScale(localStorage.getItem(activeScaleKey()) || defaultPageZoom());
}

function defaultPageZoom() {
  return 100;
}

function activeScaleKey() {
  return MOBILE_QUERY.matches ? MOBILE_TABLE_SPREAD_KEY : DESKTOP_ZOOM_KEY;
}

function scaleBounds() {
  return MOBILE_QUERY.matches
    ? { min: 90, max: 120 }
    : { min: 65, max: 120 };
}

function clampScale(value) {
  const { min, max } = scaleBounds();
  const numeric = Number.parseInt(value, 10);
  if (!Number.isFinite(numeric)) return 100;
  return Math.min(max, Math.max(min, numeric));
}

function applyUiScale(value) {
  const scale = clampScale(value);
  const isMobile = MOBILE_QUERY.matches;
  document.documentElement.style.setProperty("--ui-scale", "1");
  document.documentElement.style.setProperty("--mobile-seat-spread", isMobile ? String(scale / 100) : "1");
  document.documentElement.style.setProperty("--page-zoom", isMobile ? "1" : String(scale / 100));
  document.body.classList.toggle("page-zoom-active", !isMobile && scale !== 100);
  if (uiScaleInput) uiScaleInput.value = String(scale);
  if (uiScaleValue) uiScaleValue.textContent = `${scale}%`;
  if (uiScaleLabel) uiScaleLabel.textContent = isMobile ? "牌桌缩放" : "页面缩放";
  updateScaleControlBounds();
}

function updateScaleControlBounds() {
  if (!uiScaleInput) return;
  const { min, max } = scaleBounds();
  uiScaleInput.min = String(min);
  uiScaleInput.max = String(max);
  uiScaleInput.step = "5";
}

function getSelectedPlayerCount() {
  const count = Number.parseInt(modeSelect?.value || "4", 10);
  return [3, 4, 5].includes(count) ? count : 4;
}

function handleJoinResponse(response) {
  if (!response?.ok) {
    entryError.textContent = roomErrorMessage(response?.error || "操作失败");
    return;
  }
  entryError.textContent = "";
  if (response.code) {
    window.history.replaceState(null, "", `?room=${response.code}`);
  }
}

function roomErrorMessage(message) {
  const text = String(message || "");
  if (!text.includes("没有找到这个房间")) return text || "操作失败";
  return `${text} 如果是游戏中途突然出现，多半是服务器刚重启过；请让房主确认 Render 是否重启，并检查 /health 里的 uptime 和 persistence。`;
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
  updateTableModeAvailability();
  const phase = state.round?.phase || state.phase || "lobby";
  const myTurn = phase === "play" && state.me?.seat === state.round?.currentPlayer;
  game.dataset.phase = phase;
  game.dataset.myTurn = myTurn ? "true" : "false";
  game.dataset.playerCount = String(playerCountForState());
  game.style.setProperty("--player-count", String(playerCountForState()));
  roomCode.textContent = state.code;
  renderTopbar();
  renderScores();
  renderSlots();
  renderTrick();
  renderHand();
  renderSidePanel();
  renderChat();
}

function renderTopbar() {
  const playerCount = state.players.length;
  const targetCount = playerCountForState();
  const phase = state.round?.phase;
  const current = state.players[state.round?.currentPlayer];

  if (state.phase === "lobby") {
    phaseTitle.textContent = `等待玩家 ${playerCount}/${targetCount}`;
  } else if (phase === "expose") {
    phaseTitle.textContent = `卖牌阶段 · ${exposeCountdownSeconds()} 秒后开打`;
  } else if (phase === "play") {
    phaseTitle.textContent = current ? `轮到 ${current.name} 出牌` : "出牌中";
  } else if (phase === "finished") {
    phaseTitle.textContent = `本局结束 · ${roundSummary()}`;
  }

  const isHost = state.hostId === socket.id;
  startButton.classList.toggle("hidden", state.phase !== "lobby");
  startButton.disabled = !isHost || playerCount !== targetCount;
  newRoundButton.classList.toggle("hidden", phase !== "finished");
  newRoundButton.disabled = !isHost;
}

function renderScores() {
  scoreStrip.innerHTML = "";
  for (const seat of orderedSeatsForView()) {
    const player = state.players[seat];
    const currentScore = currentRoundScore(seat);
    const pigCount = Math.max(0, Number.parseInt(player?.pigCount || 0, 10));
    const pigMarks = renderPigMarks(pigCount, { compact: true });
    const pigTitle = pigCount > 3 ? `<span class="score-pig-title">猪王</span>` : "";
    const pigText = player ? `当猪 ${pigCount} 局${pigTitle}` : "等待加入";
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
        ${pigMarks}
        <strong>${formatScore(currentScore)}</strong>
      </div>
      <div class="meta">${player ? `当前分数 ${formatScore(currentScore)} · ${pigText}` : "等待加入"}</div>
    `;
    scoreStrip.appendChild(card);
  }
}

function renderSlots() {
  if (!state) return;
  renderTableExposedBadge();
  const seats = orderedSeatsForView();
  playerSlots.innerHTML = "";
  seats.forEach((seat, index) => {
    const slot = document.createElement("div");
    slot.className = "player-slot";
    slot.dataset.viewIndex = String(index);
    slot.dataset.seat = String(seat);
    const point = slotPoint(index, seats.length);
    slot.style.setProperty("--seat-x", `${point.x}%`);
    slot.style.setProperty("--seat-y", `${point.y}%`);
    const player = state.players[seat];
    const currentScore = currentRoundScore(seat);
    const slotMeta = player
      ? `<span>当前分数 ${formatScore(currentScore)}</span>`
      : "等待加入";
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
        <span class="slot-seat">${player?.directionLabel || seat + 1}</span>
        <span class="slot-name">${escapeHtml(player?.name || "空位")}</span>
      </div>
      <div class="slot-meta">${slotMeta}</div>
      ${player ? `
        <div class="slot-actions" aria-label="玩家互动">
          <button type="button" class="reaction-button" data-reaction="egg" title="投鸡蛋">鸡蛋</button>
          <button type="button" class="reaction-button" data-reaction="like" title="点赞">点赞</button>
        </div>
      ` : ""}
      ${player?.connected === false ? `<div class="slot-alert">断线</div>` : ""}
    `;
    slot.querySelectorAll("[data-reaction]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        sendReaction(seat, button.dataset.reaction);
      });
    });
    playerSlots.appendChild(slot);
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
  if (!state) return;
  trickArea.innerHTML = "";
  const trick = state.round?.trick || [];
  for (const play of trick) {
    const wrapper = document.createElement("div");
    wrapper.className = "played-card";
    const point = trickCardPoint(play.seat);
    wrapper.style.setProperty("--play-x", `${point.x}px`);
    wrapper.style.setProperty("--play-y", `${point.y}px`);
    wrapper.appendChild(makeCard(play.card, { small: true, disabled: true, exposed: play.exposed }));
    trickArea.appendChild(wrapper);
  }

  const phase = state.round?.phase;
  if (state.round?.settlingTrick) {
    statusLine.textContent = "本墩结算中";
  } else if (phase === "play" && state.me?.seat === state.round?.currentPlayer) {
    statusLine.textContent = "轮到你出牌";
  } else if (phase === "expose") {
    statusLine.innerHTML = `<span class="countdown-pill">卖牌倒计时 <strong>${exposeCountdownSeconds()}</strong> 秒</span>`;
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
  const legal = new Set(state.legalPlays || []);
  const exposable = new Set(state.canExpose || []);
  const phase = state.round?.phase;
  const hand = sortHandForUse(state.hand || [], legal, exposable, phase);
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
  const preview = state.round?.scorePreview || [];
  for (const seat of orderedSeatsForView()) {
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

function orderedSeatsForView() {
  const baseSeat = Number.isInteger(state?.me?.seat) ? state.me.seat : 0;
  const count = playerCountForState();
  return Array.from({ length: count }, (_, offset) => (baseSeat + offset) % count);
}

function playerCountForState() {
  const count = Number.parseInt(state?.playerCount || state?.round?.playerCount || state?.players?.length || 4, 10);
  return [3, 4, 5].includes(count) ? count : 4;
}

function relativeSeat(seat) {
  const baseSeat = Number.isInteger(state?.me?.seat) ? state.me.seat : 0;
  const count = playerCountForState();
  return ((seat - baseSeat) + count) % count;
}

function seatAngle(relative) {
  const count = playerCountForState();
  return 90 + (360 * relative / count);
}

function trickCardPoint(seat) {
  const seats = orderedSeatsForView();
  const index = seats.indexOf(seat);
  const point = slotPoint(index >= 0 ? index : relativeSeat(seat), seats.length);
  const tableWidth = tableWrap.clientWidth || 1;
  const tableHeight = tableWrap.clientHeight || 1;
  const trickWidth = trickArea.clientWidth || 1;
  const trickHeight = trickArea.clientHeight || 1;
  const tableRect = tableWrap.getBoundingClientRect();
  const trickRect = trickArea.getBoundingClientRect();
  const zoom = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--page-zoom")) || 1;
  const seatX = tableWidth * point.x / 100;
  const seatY = tableHeight * point.y / 100;
  const centerX = (trickRect.left - tableRect.left) / zoom + trickWidth / 2;
  const centerY = (trickRect.top - tableRect.top) / zoom + trickHeight / 2;
  const dx = seatX - centerX;
  const dy = seatY - centerY;
  const distance = Math.hypot(dx, dy) || 1;
  const radius = Math.min(trickWidth, trickHeight) * (MOBILE_QUERY.matches ? 0.32 : 0.34);
  return {
    x: trickWidth / 2 + (dx / distance) * radius,
    y: trickHeight / 2 + (dy / distance) * radius
  };
}

function slotPoint(index, count) {
  if (tableModeEnabled && index === 0) {
    return { x: 50, y: window.innerWidth <= 640 ? 78 : 82 };
  }
  const angle = (Math.PI / 2) + (Math.PI * 2 * index / count);
  const xRadius = count === 5 ? 43 : 41;
  const yRadius = tableModeEnabled ? 43 : (index === 0 ? 37 : 39);
  const spread = mobileSeatSpread();
  const mobileSeatMaps = {
    3: [{ x: 50, y: 88 }, { x: 71 + 12 * spread, y: 40 }, { x: 29 - 12 * spread, y: 40 }],
    4: [{ x: 50, y: 88 }, { x: 71 + 12 * spread, y: 50 }, { x: 50, y: 12 }, { x: 29 - 12 * spread, y: 50 }],
    5: [{ x: 50, y: 88 }, { x: 71 + 12 * spread, y: 66 }, { x: 70, y: 13 }, { x: 30, y: 13 }, { x: 29 - 12 * spread, y: 66 }]
  };
  if (MOBILE_QUERY.matches && mobileSeatMaps[count]?.[index]) {
    return mobileSeatMaps[count][index];
  }
  return {
    x: 50 + Math.cos(angle) * xRadius,
    y: 50 + Math.sin(angle) * yRadius
  };
}

function mobileSeatSpread() {
  if (!MOBILE_QUERY.matches) return 1;
  const value = Number.parseInt(uiScaleInput?.value || defaultPageZoom(), 10);
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, (value - 90) / 30));
}

function renderPigMarks(count, options = {}) {
  const safeCount = Math.max(0, Number.parseInt(count || 0, 10));
  if (!safeCount) return "";
  const visible = Math.min(safeCount, options.compact ? 3 : 5);
  const marks = Array.from({ length: visible }, () => `<span aria-hidden="true">🐽</span>`).join("");
  const extra = safeCount > visible ? `<em>+${safeCount - visible}</em>` : "";
  return `<span class="pig-marks" title="当猪 ${safeCount} 局" aria-label="当猪 ${safeCount} 局">${marks}${extra}</span>`;
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

function exposeCountdownSeconds() {
  const endsAt = Number(state?.round?.exposeEndsAt || 0);
  if (!endsAt) return 0;
  const now = Date.now() + serverTimeOffset;
  return Math.max(0, Math.ceil((endsAt - now) / 1000));
}

function sortHandForUse(hand, legal, exposable, phase) {
  return [...hand].sort((a, b) => {
    const aPriority = cardUsePriority(a, legal, exposable, phase);
    const bPriority = cardUsePriority(b, legal, exposable, phase);
    return aPriority - bPriority || compareCards(a, b);
  });
}

function cardUsePriority(card, legal, exposable, phase) {
  if (phase === "play" && legal.has(card.id)) return 0;
  if (phase === "expose" && exposable.has(card.id)) return 0;
  return 1;
}

function roundSummary() {
  const scores = state?.round?.finishedScores;
  if (!scores) return "查看历史";
  const scoreText = scores
    .map((score, seat) => `${state.players[seat]?.name || seat + 1} ${formatScore(score)}`)
    .join(" / ");
  const pigSeats = state?.round?.pigSeats || [];
  const pigText = pigSeats.length
    ? ` · 本局猪 ${pigSeats.map((seat) => state.players[seat]?.name || seat + 1).join("、")}`
    : "";
  return `${scoreText}${pigText}`;
}

async function toggleTableMode() {
  if (MOBILE_QUERY.matches) {
    statusLine.textContent = "手机版已关闭全屏桌面，横屏后用页面缩放调整视野。";
    return;
  }
  if (tableModeEnabled) {
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => {});
    }
    setTableMode(false);
    return;
  }

  setTableMode(true);
  const target = game || document.documentElement;
  await target.requestFullscreen?.().catch(() => {});
  if (screen.orientation?.lock) {
    await screen.orientation.lock("landscape").catch(() => {});
  }
  showRotateHintIfNeeded();
}

function setTableMode(enabled) {
  tableModeEnabled = enabled;
  game.classList.toggle("table-mode", enabled);
  document.body.classList.toggle("table-mode-active", enabled);
  tableModeButton.textContent = enabled ? "退出桌面" : "全屏桌面";
  if (!enabled) {
    try {
      screen.orientation?.unlock?.();
    } catch {}
  }
}

function updateTableModeAvailability() {
  const isMobile = MOBILE_QUERY.matches;
  tableModeButton.classList.toggle("mobile-hidden", isMobile);
  tableModeButton.disabled = isMobile;
  if (isMobile && tableModeEnabled) {
    setTableMode(false);
  }
}

function showRotateHintIfNeeded() {
  if (!tableModeEnabled) return;
  if (window.innerWidth >= window.innerHeight) return;
  statusLine.textContent = "已进入桌面模式，手机请手动横屏获得最佳视野";
}

function sendReaction(targetSeat, kind) {
  socket.emit("playerReaction", { targetSeat, kind }, (response) => {
    if (!response?.ok) {
      statusLine.textContent = response?.error || "互动失败";
    }
  });
}

function showReaction(reaction) {
  const fromSlot = document.querySelector(`.player-slot[data-seat="${reaction?.fromSeat}"]`);
  const targetSlot = document.querySelector(`.player-slot[data-seat="${reaction?.targetSeat}"]`);
  if (!fromSlot || !targetSlot || !reaction?.kind) return;
  const fromPoint = slotAnchorPoint(fromSlot);
  const targetPoint = slotAnchorPoint(targetSlot);
  const startX = fromPoint.x;
  const startY = fromPoint.y;
  const endX = targetPoint.x;
  const endY = targetPoint.y;
  const lift = Math.max(70, Math.min(170, Math.hypot(endX - startX, endY - startY) * 0.28));
  const drift = (Math.random() - 0.5) * 110;
  const item = document.createElement("div");
  item.className = `reaction-flight ${reaction.kind === "like" ? "like" : "egg"}`;
  item.textContent = reaction.kind === "like" ? "赞" : "蛋";
  item.title = `${reaction.fromName || "玩家"} ${reaction.kind === "like" ? "点赞" : "投鸡蛋"}`;
  item.style.setProperty("--from-x", `${startX}px`);
  item.style.setProperty("--from-y", `${startY}px`);
  item.style.setProperty("--mid-x", `${(startX + endX) / 2 + drift}px`);
  item.style.setProperty("--mid-y", `${Math.min(startY, endY) - lift}px`);
  item.style.setProperty("--to-x", `${endX}px`);
  item.style.setProperty("--to-y", `${endY}px`);
  tableWrap.appendChild(item);
  setTimeout(() => item.remove(), 1150);
}

function slotAnchorPoint(slot) {
  const xPercent = Number.parseFloat(slot.style.getPropertyValue("--seat-x"));
  const yPercent = Number.parseFloat(slot.style.getPropertyValue("--seat-y"));
  if (Number.isFinite(xPercent) && Number.isFinite(yPercent)) {
    return {
      x: tableWrap.clientWidth * xPercent / 100,
      y: tableWrap.clientHeight * yPercent / 100
    };
  }
  const zoom = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--page-zoom")) || 1;
  const tableRect = tableWrap.getBoundingClientRect();
  const slotRect = slot.getBoundingClientRect();
  return {
    x: (slotRect.left + slotRect.width / 2 - tableRect.left) / zoom,
    y: (slotRect.top + slotRect.height / 2 - tableRect.top) / zoom
  };
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
      <div><strong>卖牌</strong><span>开局 8 秒内可卖猪、羊、变压器、红桃 A，倒计时结束后自动开打。</span></div>
      <div><strong>首出</strong><span>持黑桃 2 的玩家首出，第一墩必须先出黑桃 2。</span></div>
      <div><strong>跟牌</strong><span>必须跟首出花色，没有该花色时可以垫任意牌。</span></div>
      <div><strong>分牌</strong><span>黑桃 Q -100，羊 +100，红桃 5-A 为负分，变压器单收 +50。</span></div>
      <div><strong>全红</strong><span>收齐全部红桃转为 +200；红桃 A 被卖后为 +400。</span></div>
      <div><strong>当猪</strong><span>每局最终分数最低者当猪；并列最低一起当猪；有人收全红时，其余三人当猪。</span></div>
      <div><strong>模式</strong><span>创建房间时可选择三人、四人或五人模式；三人移除梅花 2，五人移除梅花 2 和方块 2。</span></div>
      <div><strong>互动</strong><span>点击玩家窗口里的鸡蛋或点赞，全场会看到从你飞向对方的动画。</span></div>
      <div><strong>嘉铭赞助</strong><span>本桌由嘉铭冠名赞助，输赢各凭牌技。</span></div>
    </div>
  `;
  openModal();
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
