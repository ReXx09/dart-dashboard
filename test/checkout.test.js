const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getCheckoutRuleStats,
  getCheckoutValue,
  isCheckoutAttempt,
  isValidCheckout,
  normalizeLiveStateSnapshot
} = require('../server');

test('Single-Out erlaubt jeden gültigen Abschlussdart', () => {
  assert.equal(isValidCheckout(20, 20, 'single', 'S20'), true);
  assert.equal(isValidCheckout(20, 20, 'single', 'D10'), true);
});

test('Double-Out akzeptiert nur Double oder Bullseye', () => {
  assert.equal(isValidCheckout(40, 40, 'double', 'D20'), true);
  assert.equal(isValidCheckout(50, 50, 'double', 'DBULL'), true);
  assert.equal(isValidCheckout(40, 40, 'double', 'S40'), false);
  assert.equal(isValidCheckout(40, 40, 'double', 'T13'), false);
});

test('Master-Out akzeptiert Double, Triple oder Bullseye', () => {
  assert.equal(isValidCheckout(60, 60, 'master', 'T20'), true);
  assert.equal(isValidCheckout(40, 40, 'master', 'D20'), true);
  assert.equal(isValidCheckout(60, 60, 'master', 'S60'), false);
});

test('Überwerfen und Rest 1 sind Bust', () => {
  assert.equal(isValidCheckout(20, 21, 'single', 'S21'), false);
  assert.equal(isValidCheckout(2, 1, 'double', 'S1'), false);
  assert.equal(isValidCheckout(2, 1, 'master', 'S1'), false);
});

test('Checkout-Versuche zählen nur finishfähige Darts bis 170 Rest', () => {
  assert.equal(isCheckoutAttempt(40, 'D20', 'double'), true);
  assert.equal(isCheckoutAttempt(40, 'S20', 'double'), false);
  assert.equal(isCheckoutAttempt(171, 'D20', 'double'), false);
  assert.equal(isCheckoutAttempt(60, 'T20', 'master'), true);
});

test('Checkout-Wert ist die Summe der gesamten Aufnahme', () => {
  const player = { currentRoundPoints: [60, 1, 40] };
  assert.equal(getCheckoutValue(player, 40), 101);
});

test('Checkout-Statistik wird je Regel getrennt geführt', () => {
  const player = {};
  const doubleStats = getCheckoutRuleStats(player, 'double');
  doubleStats.attempts += 1;
  doubleStats.success += 1;
  doubleStats.highest = 101;

  const masterStats = getCheckoutRuleStats(player, 'master');
  assert.deepEqual(doubleStats, { attempts: 1, success: 1, highest: 101 });
  assert.deepEqual(masterStats, { attempts: 0, success: 0, highest: 0 });
});

test('normalizeLiveStateSnapshot normalisiert den State für Persistenz und reduziert Overhead', () => {
  const state = {
    game: {
      mode: '501',
      status: 'running',
      activePlayer: '1',
      currentThrow: '7',
      throwRound: '2',
      turnId: '3',
      duelId: '0'
    },
    players: [
      {
        slot: 1,
        name: 'Alice',
        remaining: 123,
        turns: '4',
        totalScored: '420',
        bestTurn: '180',
        throws: Array.from({ length: 160 }, (_, index) => ({ points: index + 1, bust: index % 17 === 0 })),
        currentRoundPoints: ['20', '40', '60', '80'],
        turnScoreRecorded: 'yes',
        checkoutByRule: {
          single: { attempts: '2', success: '1', highest: '40' },
          double: { attempts: '1', success: '0', highest: '50' },
          master: { attempts: '0', success: '0', highest: '0' }
        },
        cricketHits: null,
        cricketClosed: null,
        cricketPoints: '0'
      }
    ],
    lastAction: { type: 'throw', points: 20 }
  };

  const normalized = normalizeLiveStateSnapshot(state);

  assert.equal(normalized.game.mode, '501');
  assert.equal(normalized.game.status, 'running');
  assert.equal(normalized.game.activePlayer, 1);
  assert.equal(normalized.game.currentThrow, 7);
  assert.equal(normalized.game.turnId, 3);
  assert.equal(normalized.game.duelId, null);
  assert.equal(Array.isArray(normalized.players), true);
  assert.equal(normalized.players[0].throws.length, 150);
  assert.deepEqual(normalized.players[0].currentRoundPoints, [40, 60, 80]);
  assert.equal(normalized.players[0].turnScoreRecorded, true);
  assert.deepEqual(normalized.players[0].checkoutByRule.single, { attempts: 2, success: 1, highest: 40 });
  assert.deepEqual(normalized.players[0].checkoutByRule.double, { attempts: 1, success: 0, highest: 50 });
  assert.deepEqual(normalized.players[0].checkoutByRule.master, { attempts: 0, success: 0, highest: 0 });
  assert.deepEqual(normalized.lastAction, { type: 'throw', points: 20 });
});