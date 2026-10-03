const test = require('node:test');
const assert = require('node:assert/strict');

const { checkEliminationWin, rebuildEliminationState } = require('../modes/elimination');

function createState(throwRound, currentThrow, activePlayer, scores = [200, 180, 120]) {
  return {
    game: {
      mode: 'elimination',
      throwRound,
      currentThrow,
      activePlayer
    },
    players: scores.map((totalScored, index) => ({ slot: index + 1, totalScored }))
  };
}

test('Elimination beendet ein Leg nicht vor der zehnten Aufnahme', () => {
  assert.equal(checkEliminationWin(createState(7, 3, 2)), false);
  assert.equal(checkEliminationWin(createState(8, 3, 2)), false);
  assert.equal(checkEliminationWin(createState(9, 3, 2)), false);
  assert.equal(checkEliminationWin(createState(10, 2, 2)), false);
});

test('Elimination beendet das Leg nach dem letzten Dart der zehnten Aufnahme', () => {
  assert.equal(checkEliminationWin(createState(10, 3, 2)), false);
  assert.equal(checkEliminationWin(createState(10, 3, 0)), false);
  assert.equal(checkEliminationWin(createState(11, 0, 0)), true);
});

test('Elimination beendet das Leg sofort bei Erreichen von 301 Punkten', () => {
  assert.equal(checkEliminationWin(createState(4, 1, 1, [301, 97, 120])), true);
});

test('Elimination rekonstruiert Punkte und Eliminierungen nach einer Wurfkorrektur', () => {
  const state = {
    game: { mode: 'elimination' },
    players: [
      { slot: 1, totalScored: 99, eliminatedCount: 0, throws: [{ points: 20, bust: false, ts: 1 }] },
      { slot: 2, totalScored: 0, eliminatedCount: 1, throws: [{ points: 20, bust: false, ts: 2 }] }
    ],
    eliminationEvents: []
  };

  rebuildEliminationState(state);

  assert.equal(state.players[0].totalScored, 0);
  assert.equal(state.players[1].totalScored, 20);
  assert.equal(state.players[0].eliminatedCount, 1);
  assert.equal(state.eliminationEvents.length, 1);
});

test('Elimination: Neuberechnung verwirft bei einem Bust die gesamte Aufnahme', () => {
  const dart = (points, ts, turnId) => ({ points, ts, turnId, bust: false });
  const state = {
    game: { mode: 'elimination' },
    players: [
      { slot: 1, throws: [dart(100, 1, 1), dart(100, 2, 1), dart(60, 3, 3), dart(60, 4, 3)], currentRoundPoints: [] },
      { slot: 2, throws: [], currentRoundPoints: [] }
    ]
  };

  rebuildEliminationState(state);

  assert.equal(state.players[0].totalScored, 200);
  assert.equal(state.players[0].throws[2].bust, false);
  assert.equal(state.players[0].throws[3].bust, true);
});

test('Elimination: Neuberechnung lässt lastAction und aktuelle Aufnahme unverändert', () => {
  const lastAction = { type: 'next-player', autoAdvancePending: true, ts: 9 };
  const state = {
    game: { mode: 'elimination' },
    players: [
      { slot: 1, throws: [{ points: 20, ts: 1, turnId: 1 }], currentRoundPoints: [20] },
      { slot: 2, throws: [{ points: 20, ts: 2, turnId: 2 }], currentRoundPoints: [20] }
    ],
    lastAction
  };

  rebuildEliminationState(state);

  assert.equal(state.lastAction, lastAction);
  assert.deepEqual(lastAction, { type: 'next-player', autoAdvancePending: true, ts: 9 });
  assert.deepEqual(state.players[0].currentRoundPoints, [20]);
  assert.deepEqual(state.players[1].currentRoundPoints, [20]);
  assert.equal(state.eliminationEvents[0].createdAt, 2);
});