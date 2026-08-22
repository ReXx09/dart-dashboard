const test = require('node:test');
const assert = require('node:assert/strict');

const { addDerivedMetrics, percentage } = require('../lib/highscore-overview');
const { validatePlayerStatUpdates } = require('../server');

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

test('Statistikänderungen weisen unmögliche Zähler ab', () => {
  assert.match(validatePlayerStatUpdates({ games_played: 2, games_won: 3 }), /Matches/);
  assert.match(validatePlayerStatUpdates({ checkout_attempts: 4, checkout_success: 5 }), /Checkout/);
  assert.match(validatePlayerStatUpdates({ games_won: 3 }, { games_played: 2, games_won: 1 }), /Matches/);
  assert.equal(validatePlayerStatUpdates({ legs_played: 5, legs_won: 3 }), null);
});
