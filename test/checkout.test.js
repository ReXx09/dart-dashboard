const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getCheckoutRuleStats,
  getCheckoutValue,
  isCheckoutAttempt,
  isValidCheckout
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