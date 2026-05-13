const assert = require("node:assert/strict");
const {
  calculateScores,
  getLegalCardIds,
  startRound,
  playCard,
  createRoom,
  finishExpose,
  exposeCards,
  finishRound
} = require("../server");

function card(id) {
  return { suit: id[0], rank: id.slice(1), id };
}

function roundWithTaken(taken, exposed = {}) {
  return {
    taken,
    exposed: {
      SQ: exposed.SQ ?? null,
      DJ: exposed.DJ ?? null,
      C10: exposed.C10 ?? null,
      HA: exposed.HA ?? null
    }
  };
}

function testScoring() {
  assert.deepEqual(calculateScores(roundWithTaken([
    [card("SQ")],
    [card("DJ")],
    [card("C10")],
    [card("H5"), card("HJ"), card("HA")]
  ])), [-100, 100, 50, -80]);

  assert.equal(calculateScores(roundWithTaken([
    [card("SQ"), card("C10")],
    [],
    [],
    []
  ]))[0], -200);

  assert.equal(calculateScores(roundWithTaken([
    [card("SQ"), card("C10")],
    [],
    [],
    []
  ], { SQ: 0, C10: 0 }))[0], -800);

  assert.equal(calculateScores(roundWithTaken([
    ["H2", "H3", "H4", "H5", "H6", "H7", "H8", "H9", "H10", "HJ", "HQ", "HK", "HA"].map(card),
    [],
    [],
    []
  ]))[0], 200);

  assert.equal(calculateScores(roundWithTaken([
    ["H2", "H3", "H4", "H5", "H6", "H7", "H8", "H9", "H10", "HJ", "HQ", "HK", "HA", "SQ", "DJ", "C10"].map(card),
    [],
    [],
    []
  ], { SQ: 0, DJ: 0, C10: 0, HA: 0 }))[0], 3200);
}

function testRoomFlow() {
  const room = createRoom("a", "甲");
  room.players.push({ socketId: "b", clientId: "b", name: "乙", seat: 1, direction: "east", directionLabel: "东", pigCount: 0, connected: true });
  room.players.push({ socketId: "c", clientId: "c", name: "丙", seat: 2, direction: "north", directionLabel: "北", pigCount: 0, connected: true });
  room.players.push({ socketId: "d", clientId: "d", name: "丁", seat: 3, direction: "west", directionLabel: "西", pigCount: 0, connected: true });

  startRound(room);
  assert.equal(room.round.hands.length, 4);
  assert.equal(room.round.hands.every((hand) => hand.length === 13), true);
  assert.equal(room.round.phase, "expose");

  finishExpose(room);
  const starter = room.round.starter;
  assert.deepEqual(getLegalCardIds(room.round, starter), ["S2"]);
  playCard(room, starter, "S2");
  assert.equal(room.round.trick.length, 1);
}

function testBloodLock() {
  const room = createRoom("a", "甲");
  room.players.push({ socketId: "b", clientId: "b", name: "乙", seat: 1, direction: "east", directionLabel: "东", pigCount: 0, connected: true });
  room.players.push({ socketId: "c", clientId: "c", name: "丙", seat: 2, direction: "north", directionLabel: "北", pigCount: 0, connected: true });
  room.players.push({ socketId: "d", clientId: "d", name: "丁", seat: 3, direction: "west", directionLabel: "西", pigCount: 0, connected: true });
  room.phase = "playing";
  room.round = {
    handNumber: 1,
    phase: "expose",
    hands: [
      [card("HA"), card("H5"), card("S2"), card("C3")],
      [card("S3")],
      [card("S4")],
      [card("S5")]
    ],
    taken: [[], [], [], []],
    exposed: { SQ: null, DJ: null, C10: null, HA: null },
    protectedSuits: { S: false, H: false, D: false, C: false },
    currentPlayer: 0,
    starter: 0,
    dealer: null,
    trickLeadSuit: null,
    trick: [],
    pendingTrickResolution: null,
    trickNumber: 2,
    lastTrick: null,
    heartsSeen: false,
    scorePreview: [0, 0, 0, 0],
    finishedScores: null
  };

  exposeCards(room, 0, ["HA"]);
  finishExpose(room);
  assert.deepEqual(getLegalCardIds(room.round, 0).sort(), ["C3", "S2"]);
  assert.throws(() => playCard(room, 0, "H5"), /这张牌现在不能出/);

  room.round.heartsSeen = true;
  assert.ok(getLegalCardIds(room.round, 0).includes("H5"));

  room.round.heartsSeen = false;
  room.round.hands[0] = [card("H5"), card("H6")];
  assert.deepEqual(getLegalCardIds(room.round, 0).sort(), ["H5", "H6"]);
}

function testPigCount() {
  const room = createRoom("a", "甲");
  room.players.push({ socketId: "b", clientId: "b", name: "乙", seat: 1, direction: "east", directionLabel: "东", pigCount: 0, connected: true });
  room.players.push({ socketId: "c", clientId: "c", name: "丙", seat: 2, direction: "north", directionLabel: "北", pigCount: 0, connected: true });
  room.players.push({ socketId: "d", clientId: "d", name: "丁", seat: 3, direction: "west", directionLabel: "西", pigCount: 0, connected: true });
  room.phase = "playing";
  room.round = {
    handNumber: 1,
    phase: "play",
    hands: [[], [], [], []],
    taken: [[card("SQ")], [], [], []],
    exposed: { SQ: null, DJ: null, C10: null, HA: null },
    protectedSuits: { S: false, H: false, D: false, C: false },
    currentPlayer: 0,
    starter: 0,
    dealer: null,
    trickLeadSuit: null,
    trick: [],
    pendingTrickResolution: null,
    trickNumber: 14,
    lastTrick: null,
    heartsSeen: true,
    scorePreview: [0, 0, 0, 0],
    finishedScores: null
  };

  const before = room.players[0].pigCount;
  finishRound(room);
  assert.equal(room.players[0].pigCount, before + 1);
  assert.equal(room.round.phase, "finished");
}

testScoring();
testRoomFlow();
testBloodLock();
testPigCount();
console.log("rules ok");
