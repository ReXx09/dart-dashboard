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

const DART_SEGMENTS = [
  ...Array.from({ length: 20 }, (_, index) => ({ segment: `S${index + 1}`, points: index + 1 })),
  ...Array.from({ length: 20 }, (_, index) => ({ segment: `D${index + 1}`, points: (index + 1) * 2 })),
  ...Array.from({ length: 20 }, (_, index) => ({ segment: `T${index + 1}`, points: (index + 1) * 3 })),
  { segment: 'S25', points: 25 },
  { segment: 'DBULL', points: 50 }
];
const finishableRestCache = new Map();

function isRestFinishable(remaining, rule = DEFAULT_CHECKOUT_RULE, maxDarts = 3) {
  const rest = Number(remaining);
  const safeRule = ['single', 'double', 'master'].includes(rule) ? rule : DEFAULT_CHECKOUT_RULE;
  const darts = Math.max(1, Math.min(3, Number(maxDarts) || 3));
  if (!Number.isInteger(rest) || rest <= 0 || rest > 170) return false;

  const cacheKey = `${safeRule}:${darts}:${rest}`;
  if (finishableRestCache.has(cacheKey)) return finishableRestCache.get(cacheKey);

  const search = (currentRest, dartsLeft) => {
    for (const dart of DART_SEGMENTS) {
      if (!isValidCheckout(currentRest, dart.points, safeRule, dart.segment)) continue;
      const nextRest = currentRest - dart.points;
      if (nextRest === 0) return true;
      if (dartsLeft > 1 && search(nextRest, dartsLeft - 1)) return true;
    }
    return false;
  };

  const result = search(rest, darts);
  finishableRestCache.set(cacheKey, result);
  return result;
}

function isCheckoutAttempt(remaining, rule = DEFAULT_CHECKOUT_RULE) {
  return isRestFinishable(remaining, rule, 3);
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
  isRestFinishable,
  isCheckoutAttempt,
  getCheckoutRuleStats
};
