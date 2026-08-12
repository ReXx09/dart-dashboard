const test = require('node:test');
const assert = require('node:assert/strict');

const { aggregateDuelStats } = require('../lib/duel-stats');

test('aggregateDuelStats aggregiert Legs, Wins, Busts und Checkout-Werte', () => {
  const result = aggregateDuelStats({
    slots: [1],
    category: 'duel',
    exactGroup: false,
    duels: [{
      category: 'duel',
      players: [{ player_slot: 1 }, { player_slot: 2 }],
      legs: [{
        players: [{
          player_slot: 1,
          player_name: 'Alice',
          won: 1,
          darts: 30,
          scored: 501,
          best_turn: 140,
          checkout_highest: 100,
          count_100plus: 2,
          busts: 1,
          checkout_attempts: 3,
          checkout_success: 1
        }]
      }]
    }]
  });

  assert.equal(result.duels, 1);
  assert.equal(result.legs, 1);
  assert.deepEqual(result.playerSlots, [1]);
  assert.deepEqual(result.players[0], {
    slot: 1,
    name: 'Alice',
    legs: 1,
    wins: 1,
    darts: 30,
    scored: 501,
    average: 50.1,
    bestTurn: 140,
    bestLeg: 30,
    highestCheckout: 100,
    count60plus: 0,
    count80plus: 0,
    count100plus: 2,
    count140plus: 0,
    count180: 0,
    checkoutAttempts: 3,
    checkoutSuccess: 1,
    busts: 1
  });
});

test('aggregateDuelStats unterscheidet exakte Spielergruppen', () => {
  const duels = [
    { category: 'group', players: [{ player_slot: 1 }, { player_slot: 2 }, { player_slot: 3 }], legs: [] },
    { category: 'group', players: [{ player_slot: 1 }, { player_slot: 2 }], legs: [] }
  ];

  assert.equal(aggregateDuelStats({ duels, slots: [1, 2], category: 'group', exactGroup: true }).duels, 1);
  assert.equal(aggregateDuelStats({ duels, slots: [1, 2], category: 'group', exactGroup: false }).duels, 2);
});
