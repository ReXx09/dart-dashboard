const { DEFAULT_CHECKOUT_RULE } = require('./shared');

function isDoublePoints(points) {
  if (points <= 0 || points > 50) return false;
  if (points === 50) return true;
  if (points % 2 !== 0) return false;
  const base = points / 2;
  return base >= 1 && base <= 20;
}

function isMasterPoints(points) {
  if (isDoublePoints(points)) return true;
  if (points <= 0 || points > 60) return false;
  if (points % 3 !== 0) return false;
  const base = points / 3;
  return base >= 1 && base <= 20;
}

function isValidCheckout(remaining, points, rule, segment = null) {
  const nextRemaining = remaining - points;
  if (nextRemaining < 0) return false;
  if ((rule === 'double' || rule === 'master') && nextRemaining === 1) return false;
  if (nextRemaining === 0) {
    if (rule === 'single') return true;
    if (rule === 'double') {
      const normalizedSegment = String(segment || '').toUpperCase();
      return segment ? (/^D(?:[1-9]|1[0-9]|20)$/.test(normalizedSegment) || normalizedSegment === 'DBULL') : isDoublePoints(points);
    }
    if (rule === 'master') {
      const normalizedSegment = String(segment || '').toUpperCase();
      return segment
        ? (/^[DT](?:[1-9]|1[0-9]|20)$/.test(normalizedSegment) || normalizedSegment === 'DBULL')
        : isMasterPoints(points);
    }
    return true;
  }
  return true;
}

function isCheckoutFinishSegment(segment, rule = DEFAULT_CHECKOUT_RULE) {
  const normalized = String(segment || '').toUpperCase();
  if (rule === 'single') return /^(?:S|D|T)(?:[1-9]|1[0-9]|20)$/.test(normalized) || normalized === 'S25' || normalized === 'DBULL';
  if (rule === 'master') return /^(?:D|T)(?:[1-9]|1[0-9]|20)$/.test(normalized) || normalized === 'DBULL';
  return /^D(?:[1-9]|1[0-9]|20)$/.test(normalized) || normalized === 'DBULL';
}

function isCheckoutAttempt(remaining, segment, rule = DEFAULT_CHECKOUT_RULE) {
  const rest = Number(remaining);
  return rest > 0 && rest <= 170 && isCheckoutFinishSegment(segment, rule);
}

function getCheckoutRuleStats(player, rule) {
  const safeRule = ['single', 'double', 'master'].includes(rule) ? rule : DEFAULT_CHECKOUT_RULE;
  if (!player.checkoutByRule || typeof player.checkoutByRule !== 'object') player.checkoutByRule = {};
  if (!player.checkoutByRule[safeRule]) player.checkoutByRule[safeRule] = { attempts: 0, success: 0, highest: 0 };
  return player.checkoutByRule[safeRule];
}

module.exports = {
  isDoublePoints,
  isMasterPoints,
  isValidCheckout,
  isCheckoutFinishSegment,
  isCheckoutAttempt,
  getCheckoutRuleStats
};
