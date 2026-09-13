const test = require('node:test');
const assert = require('node:assert/strict');

const {
  findLatestCorrectableThrow,
  removeLatestThrow,
  correctLatestThrow
} = require('../lib/live-throws');

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

test('correctLatestThrow aktualisiert Wurf, Aufnahme und Restscore', () => {
  const state = createState();
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

test('removeLatestThrow stellt Aufnahme und Spielstand wieder her', () => {
  const state = createState();
  const result = removeLatestThrow(state, {
    calculateAverage: player => player.currentRoundPoints.reduce((sum, points) => sum + points, 0) / 3
  });

  assert.equal(result.throwData.points, 60);
  assert.equal(state.players[0].throws.length, 2);
  assert.equal(state.players[0].remaining, 481);
  assert.equal(state.players[0].totalScored, 20);
  assert.equal(state.players[0].turns, 2);
  assert.deepEqual(state.players[0].currentRoundPoints, [20]);
});
