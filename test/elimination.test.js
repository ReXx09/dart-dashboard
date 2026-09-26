const test = require('node:test');
const assert = require('node:assert/strict');

const { checkEliminationWin } = require('../modes/elimination');

function createState(throwRound, currentThrow, activePlayer, scores = [301, 180, 120]) {
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
  assert.equal(checkEliminationWin(createState(10, 3, 2)), true);
});