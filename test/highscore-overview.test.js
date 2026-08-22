const test = require('node:test');
const assert = require('node:assert/strict');

const { addDerivedMetrics, percentage } = require('../lib/highscore-overview');

test('Legs und Matches bleiben getrennte Einheiten', () => {
  const result = addDerivedMetrics({
    darts: 60,
    totalScored: 800,
    legsPlayed: 4,
    legsWon: 3,
    matchesPlayed: 1,
    matchesWon: 1
  });

  assert.equal(result.threeDartAverage, 40);
  assert.equal(result.legsPlayed, 4);
  assert.equal(result.legWinRate, 75);
  assert.equal(result.matchesPlayed, 1);
  assert.equal(result.matchWinRate, 100);
});

test('First-9-Average nutzt nur gültige Samples', () => {
  const result = addDerivedMetrics({
    firstNineTotal: 123.4,
    firstNineSamples: 2,
    legsPlayed: 3
  });

  assert.equal(result.firstNineAverage, 61.7);
  assert.equal(result.firstNineSamples, 2);
});

test('Quoten ohne Nenner bleiben unbekannt statt null Prozent', () => {
  assert.equal(percentage(0, 0), null);
  assert.equal(percentage(1, 4), 25);
});
