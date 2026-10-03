const test = require('node:test');
const assert = require('node:assert/strict');

const {
  findLatestCorrectableThrow,
  summarizePlayerThrows,
  removeLatestThrow,
  correctLatestThrow
} = require('../lib/live-throws');
const { isValidCheckout, isCheckoutAttempt } = require('../modes/x01');
const { applyEliminationThrow } = require('../modes/elimination');

const SEGMENTS = { 20: 'S20', 40: 'D20', 50: 'DBULL', 60: 'T20' };
const segmentOf = points => points === 0 ? 'MISS' : SEGMENTS[points] || (points <= 20 ? 'S' + points : null);
const averageOf = player => player.currentRoundPoints.reduce((sum, points) => sum + points, 0) / 3;

function x01Context(overrides = {}) {
  return {
    modeType: 'x01',
    checkoutRule: 'double',
    isValidCheckout,
    isCheckoutAttempt,
    pointsToSegment: segmentOf,
    calculateAverage: averageOf,
    ...overrides
  };
}

const snapshot = value => JSON.parse(JSON.stringify(value));
const flowOf = state => snapshot({ game: state.game, lastAction: state.lastAction });

// Alice warf einen Dart (20); danach wurde versehentlich "Fehlwurf" gedrückt. Zwei Füll-Darts, Bob ist dran.
function createAfterMissClick() {
  const pad = { points: 0, remaining: 481, bust: false, segment: 'MISS', source: 'manual-miss', ts: 200, turnId: 1 };
  return {
    game: { mode: '501', status: 'running', activePlayer: 1, currentThrow: 0, turnId: 2, throwRound: 1, startingPlayerSlot: 1 },
    players: [
      {
        slot: 1, name: 'Alice', remaining: 481, totalScored: 20, turns: 3, bestTurn: 20, currentRoundPoints: [20, 0, 0],
        throws: [{ points: 20, remaining: 481, bust: false, segment: 'S20', source: 'manual', ts: 100, turnId: 1 }, { ...pad }, { ...pad }]
      },
      { slot: 2, name: 'Bob', remaining: 501, totalScored: 0, turns: 0, bestTurn: 0, currentRoundPoints: [], throws: [] }
    ],
    lastAction: { type: 'next-player', player: 'Bob', playerSlot: 2, ts: 300 }
  };
}

// Alice (Rest 40) hat nur einen Füll-Dart in ihrer Aufnahme; Bob ist dran.
function createFinishable(rest = 40) {
  return {
    game: { mode: '501', status: 'running', activePlayer: 1, currentThrow: 0, turnId: 2, throwRound: 1, startingPlayerSlot: 1 },
    players: [
      {
        slot: 1, name: 'Alice', remaining: rest, totalScored: 501 - rest, turns: 1, bestTurn: 0, currentRoundPoints: [0],
        throws: [{ points: 0, remaining: rest, bust: false, segment: 'MISS', source: 'manual-miss', ts: 100, turnId: 1 }]
      },
      { slot: 2, name: 'Bob', remaining: 501, totalScored: 0, turns: 0, bestTurn: 0, currentRoundPoints: [], throws: [] }
    ],
    lastAction: { type: 'next-player', ts: 200 }
  };
}

function createState() {
  return {
    players: [
      {
        slot: 1,
        name: 'Alice',
        remaining: 421,
        totalScored: 80,
        turns: 3,
        currentRoundPoints: [20, 60],
        throws: [
          { points: 20, remaining: 481, bust: false, ts: 100, turnId: 1 },
          { points: 60, remaining: 421, bust: false, ts: 200, turnId: 1 },
          { points: 0, remaining: 421, bust: false, source: 'manual-miss', ts: 300, turnId: 1 }
        ]
      },
      {
        slot: 2,
        name: 'Bob',
        remaining: 501,
        totalScored: 0,
        turns: 0,
        currentRoundPoints: [],
        throws: []
      }
    ]
  };
}

test('findLatestCorrectableThrow überspringt manuelle Fehlwürfe', () => {
  const latest = findLatestCorrectableThrow(createState());
  assert.equal(latest.player.name, 'Alice');
  assert.equal(latest.throwIndex, 1);
  assert.equal(latest.throwData.points, 60);
});

test('summarizePlayerThrows leitet Aufnahme- und Leg-Werte aus Würfen ab', () => {
  const summary = summarizePlayerThrows({
    throws: [
      { points: 60, bust: false },
      { points: 40, bust: false },
      { points: 0, bust: true },
      { points: 100, bust: false },
      { points: 71, bust: false },
      { points: 0, bust: false }
    ]
  });

  assert.equal(summary.darts, 6);
  assert.equal(summary.totalScored, 271);
  assert.equal(summary.average, 135.5);
  assert.equal(summary.bestTurn, 171);
  assert.equal(summary.count100plus, 2);
  assert.equal(summary.busts, 1);
  assert.deepEqual(summary.completeTurnScores, [100, 171]);
});

test('correctLatestThrow aktualisiert Wurf, Aufnahme und Restscore', () => {
  const state = createState();
  state.players[0].throws.pop();
  state.players[0].currentRoundPoints = [20, 60];
  const result = correctLatestThrow(state, -5, {
    checkoutRule: 'single',
    isValidCheckout: (_remaining, points) => points <= 180,
    pointsToSegment: points => points === 0 ? 'MISS' : 'S' + points,
    calculateAverage: player => player.currentRoundPoints.reduce((sum, points) => sum + points, 0) / 3
  });

  assert.equal(result.newPoints, 55);
  assert.equal(state.players[0].throws[1].points, 55);
  assert.equal(state.players[0].throws[1].segment, 'S55');
  assert.equal(state.players[0].remaining, 426);
  assert.equal(state.players[0].totalScored, 75);
  assert.deepEqual(state.players[0].currentRoundPoints, [20, 55]);
  assert.equal(state.players[0].turnScoreRecorded, false);
});

test('correctLatestThrow ersetzt den zuletzt erzeugten Fehlwurf statt den vorherigen Dart', () => {
  const state = createState();
  state.players[0].currentRoundPoints = [20, 60, 0];
  const result = correctLatestThrow(state, 20, {
    checkoutRule: 'single',
    isValidCheckout: (_remaining, points) => points <= 180,
    pointsToSegment: points => points === 0 ? 'MISS' : 'S' + points
  });

  assert.equal(result.newPoints, 20);
  assert.equal(state.players[0].throws[2].points, 20);
  assert.equal(state.players[0].throws[2].source, 'manual-correction');
  assert.equal(state.players[0].remaining, 401);
  assert.equal(state.players[0].totalScored, 100);
  assert.deepEqual(state.players[0].currentRoundPoints, [20, 60, 20]);
});

test('Korrektur nach einem Fehlwurf-Klick ändert nur den Wert und lässt den Spielfluss unberührt', () => {
  const state = createAfterMissClick();
  const flowBefore = flowOf(state);
  const bobBefore = snapshot(state.players[1]);

  const result = correctLatestThrow(state, 60, x01Context());

  assert.equal(result.error, undefined);
  assert.equal(result.legFinished, false);
  assert.equal(state.players[0].throws[2].points, 60);
  assert.equal(state.players[0].throws[2].source, 'manual-correction');
  assert.equal(state.players[0].throws[1].source, 'manual-miss');
  assert.equal(state.players[0].remaining, 421);
  assert.equal(state.players[0].totalScored, 80);
  assert.equal(state.players[0].turns, 3);
  assert.deepEqual(state.players[0].currentRoundPoints, [20, 0, 60]);
  assert.deepEqual(flowOf(state), flowBefore);
  assert.deepEqual(state.players[1], bobBefore);
});

test('Korrektur im laufenden Wurf ändert den Dart-Zähler nicht', () => {
  const state = createAfterMissClick();
  state.players[0].throws.splice(1);
  state.players[0].turns = 1;
  state.players[0].currentRoundPoints = [20];
  state.game.activePlayer = 0;
  state.game.currentThrow = 1;
  state.game.turnId = 1;
  state.lastAction = { type: 'throw', points: 20, ts: 100 };
  const flowBefore = flowOf(state);

  correctLatestThrow(state, 5, x01Context());

  assert.equal(state.players[0].throws[0].points, 25);
  assert.equal(state.players[0].remaining, 476);
  assert.deepEqual(flowOf(state), flowBefore);
});

test('Korrektur lässt einen laufenden Spielerwechsel unangetastet', () => {
  const state = createAfterMissClick();
  state.players[0].throws.splice(0, 3,
    { points: 20, remaining: 481, bust: false, segment: 'S20', source: 'manual', ts: 100, turnId: 1 },
    { points: 20, remaining: 461, bust: false, segment: 'S20', source: 'manual', ts: 110, turnId: 1 },
    { points: 20, remaining: 441, bust: false, segment: 'S20', source: 'manual', ts: 120, turnId: 1 });
  state.players[0].remaining = 441;
  state.players[0].totalScored = 60;
  state.players[0].currentRoundPoints = [20, 20, 20];
  state.game.activePlayer = 0;
  state.game.currentThrow = 3;
  state.game.turnId = 1;
  state.lastAction = { type: 'throw', ts: 120, autoAdvancePending: true, autoAdvanceDelayMs: 5000, autoAdvanceStartedAt: 120 };
  const flowBefore = flowOf(state);

  correctLatestThrow(state, 40, x01Context());

  assert.equal(state.players[0].remaining, 401);
  assert.deepEqual(flowOf(state), flowBefore);
});

test('Korrektur, die zum Überwerfen führt, wird abgelehnt und lässt den Zustand unverändert', () => {
  const state = createFinishable(40);
  const before = snapshot(state);

  const result = correctLatestThrow(state, 60, x01Context());

  assert.match(result.error, /überworfen/);
  assert.deepEqual(state, before);
});

test('Korrektur auf Rest 1 ist bei Double-Out ein Bust und wird abgelehnt', () => {
  const state = createFinishable(40);
  const before = snapshot(state);

  assert.match(correctLatestThrow(state, 39, x01Context()).error, /überworfen/);
  assert.deepEqual(state, before);
});

test('Korrektur zum gültigen Checkout meldet das Leg-Ende ohne den Spielfluss zu ändern', () => {
  const state = createFinishable(40);
  const flowBefore = flowOf(state);

  const result = correctLatestThrow(state, 40, x01Context());

  assert.equal(result.legFinished, true);
  assert.equal(result.remainingBeforeThrow, 40);
  assert.equal(state.players[0].remaining, 0);
  assert.deepEqual(flowOf(state), flowBefore);
});

test('Checkout per Korrektur muss die Out-Regel erfüllen', () => {
  const state = createFinishable(20);

  assert.match(correctLatestThrow(state, 20, x01Context({ checkoutRule: 'double', pointsToSegment: () => 'S20' })).error, /überworfen/);
  assert.equal(correctLatestThrow(state, 20, x01Context({ checkoutRule: 'single', pointsToSegment: () => 'S20' })).legFinished, true);
});

test('Korrektur begrenzt eine Aufnahme auf 180 Punkte', () => {
  const state = createFinishable(381);
  const player = state.players[0];
  player.throws = [
    { points: 60, remaining: 441, bust: false, segment: 'T20', source: 'manual', ts: 50, turnId: 1 },
    { points: 60, remaining: 381, bust: false, segment: 'T20', source: 'manual', ts: 60, turnId: 1 },
    { points: 0, remaining: 381, bust: false, segment: 'MISS', source: 'manual-miss', ts: 100, turnId: 1 }
  ];
  player.currentRoundPoints = [60, 60, 0];

  assert.match(correctLatestThrow(state, 61, x01Context()).error, /höchstens 180/);
  assert.equal(correctLatestThrow(state, 60, x01Context()).newPoints, 60);
  assert.equal(player.remaining, 321);
});

test('Korrektur eines Überwerfens ist nicht möglich', () => {
  const state = createFinishable(100);
  state.players[0].throws = [{ points: 70, remaining: 60, bust: true, segment: null, source: 'manual', ts: 100, turnId: 1 }];

  assert.match(correctLatestThrow(state, -10, x01Context()).error, /Überwerfen/);
});

test('Korrektur eines Fehlwurf-Eintrags am Checkout-Rest zählt als Checkout-Versuch', () => {
  const state = createFinishable(40);

  correctLatestThrow(state, 20, x01Context());

  assert.equal(state.players[0].checkoutAttempts, 1);
  assert.equal(state.players[0].checkoutByRule.double.attempts, 1);
});

test('Wurf entfernen nimmt einen Fehlwurf-Klick vollständig zurück und gibt Alice den Wurf zurück', () => {
  const state = createAfterMissClick();

  const result = removeLatestThrow(state, x01Context());

  assert.equal(result.error, undefined);
  assert.equal(result.removedCount, 2);
  assert.equal(state.players[0].throws.length, 1);
  assert.equal(state.players[0].turns, 1);
  assert.equal(state.players[0].remaining, 481);
  assert.equal(state.players[0].totalScored, 20);
  assert.deepEqual(state.players[0].currentRoundPoints, [20]);
  assert.equal(state.game.activePlayer, 0);
  assert.equal(state.game.currentThrow, 1);
  assert.equal(state.game.turnId, 1);
  assert.equal(state.game.throwRound, 1);
});

test('Wurf entfernen setzt die Runde zurück, wenn der Wechsel eine neue Runde begonnen hat', () => {
  const darts = turnId => [0, 1, 2].map(index => ({ points: 20, remaining: 481 - index * 20, bust: false, segment: 'S20', source: 'manual', ts: turnId * 100 + index, turnId }));
  const player = (slot, throws) => ({ slot, name: 'P' + slot, remaining: throws.length ? 441 : 501, totalScored: throws.length ? 60 : 0, turns: throws.length, bestTurn: 20, currentRoundPoints: throws.length ? [20, 20, 20] : [], throws });
  const state = {
    game: { mode: '501', status: 'running', activePlayer: 0, currentThrow: 0, turnId: 4, throwRound: 2, startingPlayerSlot: 1 },
    players: [player(1, []), player(2, darts(2)), player(3, darts(3))],
    lastAction: { type: 'throw', ts: 302 }
  };

  removeLatestThrow(state, x01Context());

  assert.equal(state.game.activePlayer, 2);
  assert.equal(state.game.currentThrow, 2);
  assert.equal(state.game.turnId, 3);
  assert.equal(state.game.throwRound, 1);
  assert.equal(state.players[2].remaining, 461);
});

test('Wurf entfernen macht ein Überwerfen rückgängig und stellt die Aufnahme wieder her', () => {
  const state = createFinishable(100);
  const player = state.players[0];
  player.totalScored = 401;
  player.turns = 3;
  player.currentRoundPoints = [20, 20, 70];
  player.throws = [
    { points: 20, remaining: 80, bust: false, segment: 'S20', source: 'manual', ts: 100, turnId: 1 },
    { points: 20, remaining: 60, bust: false, segment: 'S20', source: 'manual', ts: 110, turnId: 1 },
    { points: 70, remaining: 60, bust: true, segment: null, source: 'manual', ts: 120, turnId: 1 }
  ];

  removeLatestThrow(state, x01Context());

  assert.equal(player.remaining, 60);
  assert.equal(player.totalScored, 441);
  assert.equal(player.turns, 2);
  assert.equal(state.game.activePlayer, 0);
  assert.equal(state.game.currentThrow, 2);
});

test('Wurf entfernen im laufenden Wurf behält den aktiven Spieler', () => {
  const state = createAfterMissClick();
  const player = state.players[0];
  player.throws = [
    { points: 20, remaining: 481, bust: false, segment: 'S20', source: 'manual', ts: 100, turnId: 3 },
    { points: 60, remaining: 421, bust: false, segment: 'T20', source: 'manual', ts: 110, turnId: 3 }
  ];
  player.remaining = 421;
  player.totalScored = 80;
  player.turns = 2;
  player.currentRoundPoints = [20, 60];
  Object.assign(state.game, { activePlayer: 0, currentThrow: 2, turnId: 3 });

  removeLatestThrow(state, x01Context());

  assert.equal(player.remaining, 481);
  assert.equal(player.totalScored, 20);
  assert.equal(state.game.activePlayer, 0);
  assert.equal(state.game.currentThrow, 1);
  assert.equal(state.game.turnId, 3);
});

test('Wurf entfernen nimmt den Checkout-Versuch eines echten Darts zurück', () => {
  const state = createFinishable(40);
  const player = state.players[0];
  player.checkoutAttempts = 1;
  player.checkoutByRule = { double: { attempts: 1, success: 0, highest: 0 } };
  player.throws = [{ points: 0, remaining: 40, bust: false, segment: 'MISS', source: 'arduino-miss', ts: 100, turnId: 1 }];

  removeLatestThrow(state, x01Context());

  assert.equal(player.checkoutAttempts, 0);
  assert.equal(player.checkoutByRule.double.attempts, 0);
});

test('Wurf entfernen und Korrigieren melden fehlende Würfe und Cricket als Fehler', () => {
  const empty = createFinishable(40);
  empty.players[0].throws = [];

  assert.match(removeLatestThrow(empty, x01Context()).error, /Kein Wurf/);
  assert.match(correctLatestThrow(empty, 5, x01Context()).error, /Kein Wurf/);
  assert.match(removeLatestThrow(createAfterMissClick(), x01Context({ modeType: 'cricket' })).error, /Cricket/);
  assert.match(correctLatestThrow(createAfterMissClick(), 5, x01Context({ modeType: 'cricket' })).error, /Cricket/);
});

// Elimination: Darts werden wie in der Live-Route gespielt, damit die Zustände realistisch sind.
function createEliminationGame() {
  return {
    game: { mode: 'elimination', status: 'running', activePlayer: 0, currentThrow: 0, turnId: 1, throwRound: 1, startingPlayerSlot: 1 },
    players: [1, 2, 3].map(slot => ({ slot, name: 'P' + slot, remaining: 0, totalScored: 0, eliminatedCount: 0, turns: 0, bestTurn: 0, currentRoundPoints: [], throws: [] })),
    eliminationEvents: [],
    lastAction: null
  };
}

let eliminationClock = 1000;

function playEliminationDart(state, playerIndex, points, source = 'manual') {
  const player = state.players[playerIndex];
  const isPad = source === 'manual-miss';
  const result = isPad ? { bust: false, eliminationAction: null } : applyEliminationThrow(state, player, points);
  player.turns += 1;
  player.currentRoundPoints.push(points);
  eliminationClock += 10;
  player.throws.push({ points, remaining: 0, bust: result.bust, elimination: Boolean(result.eliminationAction), ts: eliminationClock, segment: segmentOf(points), turnId: state.game.turnId, source });
  state.game.currentThrow += 1;
}

function endEliminationVisit(state) {
  state.game.activePlayer = (state.game.activePlayer + 1) % state.players.length;
  state.game.currentThrow = 0;
  state.game.turnId += 1;
  if (state.game.activePlayer === 0) state.game.throwRound += 1;
  state.players[state.game.activePlayer].currentRoundPoints = [];
}

function createEliminationAfterMissClick() {
  const state = createEliminationGame();
  [20, 20, 20].forEach(points => playEliminationDart(state, 0, points));
  endEliminationVisit(state);
  [20, 20].forEach(points => playEliminationDart(state, 1, points));
  playEliminationDart(state, 1, 0, 'manual-miss');
  endEliminationVisit(state);
  state.lastAction = { type: 'next-player', ts: 5000 };
  return state;
}

const eliminationContext = () => x01Context({ modeType: 'elimination' });

test('Elimination: Korrektur eines Fehlwurf-Eintrags löst die Elimination regelkonform aus', () => {
  const state = createEliminationAfterMissClick();
  const flowBefore = flowOf(state);
  assert.equal(state.players[0].totalScored, 60);
  assert.equal(state.players[1].totalScored, 40);

  const result = correctLatestThrow(state, 20, eliminationContext());

  assert.equal(result.error, undefined);
  assert.equal(state.players[1].totalScored, 60);
  assert.equal(state.players[0].totalScored, 0);
  assert.equal(state.players[0].eliminatedCount, 1);
  assert.equal(state.eliminationEvents.length, 1);
  assert.equal(state.eliminationEvents[0].eliminatorSlot, 2);
  assert.equal(state.players[1].throws[2].elimination, true);
  assert.equal(state.players[1].throws[2].bust, false);
  assert.deepEqual(flowOf(state), flowBefore);
});

test('Elimination: Wurf entfernen macht die Elimination rückgängig und gibt dem Spieler den Wurf zurück', () => {
  const state = createEliminationAfterMissClick();
  correctLatestThrow(state, 20, eliminationContext());

  const result = removeLatestThrow(state, eliminationContext());

  assert.equal(result.error, undefined);
  assert.equal(state.players[0].totalScored, 60);
  assert.equal(state.players[0].eliminatedCount, 0);
  assert.equal(state.players[1].totalScored, 40);
  assert.equal(state.eliminationEvents.length, 0);
  assert.equal(state.players[1].remaining, 0);
  assert.equal(state.game.activePlayer, 1);
  assert.equal(state.game.currentThrow, 2);
  assert.equal(state.game.turnId, 2);
});

test('Elimination: Wurf entfernen nach dem Fehlwurf-Klick der letzten Spielerin setzt die Runde zurück', () => {
  const state = createEliminationGame();
  [0, 1, 2].forEach(playerIndex => {
    [20, 20, 20].forEach(points => playEliminationDart(state, playerIndex, points + playerIndex));
    endEliminationVisit(state);
  });
  assert.equal(state.game.throwRound, 2);
  assert.equal(state.game.activePlayer, 0);

  removeLatestThrow(state, eliminationContext());

  assert.equal(state.game.throwRound, 1);
  assert.equal(state.game.activePlayer, 2);
  assert.equal(state.game.currentThrow, 2);
  assert.equal(state.game.turnId, 3);
});

test('Elimination: Korrektur über 301 Punkte wird als Bust abgelehnt', () => {
  const state = createEliminationGame();
  state.players = state.players.slice(0, 2);
  [150, 0, 0].forEach(points => playEliminationDart(state, 0, points));
  endEliminationVisit(state);
  playEliminationDart(state, 1, 0, 'manual-miss');
  endEliminationVisit(state);
  [140, 0].forEach(points => playEliminationDart(state, 0, points));
  playEliminationDart(state, 0, 0, 'manual-miss');
  endEliminationVisit(state);
  const before = snapshot(state);

  assert.match(correctLatestThrow(state, 20, eliminationContext()).error, /überworfen/);
  assert.deepEqual(state, before);
});

test('Elimination: Korrektur bis genau 301 Punkte beendet das Leg regelkonform', () => {
  const state = createEliminationGame();
  state.players = state.players.slice(0, 2);
  [150, 0, 0].forEach(points => playEliminationDart(state, 0, points));
  endEliminationVisit(state);
  playEliminationDart(state, 1, 0, 'manual-miss');
  endEliminationVisit(state);
  [141, 0].forEach(points => playEliminationDart(state, 0, points));
  playEliminationDart(state, 0, 0, 'manual-miss');
  endEliminationVisit(state);

  const result = correctLatestThrow(state, 10, eliminationContext());

  assert.equal(state.players[0].totalScored, 301);
  assert.equal(result.legFinished, true);
});
