const { getCricketNumbersForMode } = require('./shared');

function defaultPlayerCricketState(mode) {
  const nums = getCricketNumbersForMode(mode);
  if (!nums) return {};
  const hits = {};
  nums.forEach(n => { hits[n] = 0; });
  return { cricketHits: hits, cricketClosed: {}, cricketPoints: 0 };
}

function calculateCricketPoints(player) {
  return Number(player.cricketPoints ?? player.totalScored ?? 0);
}

function applyCricketHit(player, allPlayers, number, hitCount) {
  if (!player.cricketHits) player.cricketHits = {};
  if (!player.cricketClosed) player.cricketClosed = {};

  const oldHits = Number(player.cricketHits[number] || 0);
  const newHits = oldHits + hitCount;
  const opponentHasClosed = allPlayers.some(opponent =>
    opponent.slot !== player.slot && opponent.cricketClosed && opponent.cricketClosed[number]
  );

  player.cricketHits[number] = newHits;
  if (newHits >= 3) player.cricketClosed[number] = true;

  const newlyScoringHits = opponentHasClosed
    ? 0
    : Math.max(0, newHits - 3) - Math.max(0, oldHits - 3);
  const awardedPoints = newlyScoringHits * number;
  player.cricketPoints = Number(player.cricketPoints ?? player.totalScored ?? 0) + awardedPoints;
  player.totalScored = player.cricketPoints;
  return awardedPoints;
}

function checkCricketWin(player, allPlayers) {
  if (!player.cricketClosed) return false;

  const requiredNumbers = [15, 16, 17, 18, 19, 20, 25];
  const allClosed = requiredNumbers.every(n => player.cricketClosed[n] === true);
  if (!allClosed) return false;

  const myPoints = calculateCricketPoints(player, allPlayers);

  for (const opp of allPlayers) {
    if (opp.slot === player.slot) continue;
    const oppPoints = calculateCricketPoints(opp, allPlayers);
    if (oppPoints > myPoints) return false;
  }

  return true;
}

function cricketThrowDetails(throwData) {
  const segment = String(throwData?.segment || '').toUpperCase();
  let number = Number(throwData?.number);
  let hitCount = Number(throwData?.multiplier ?? throwData?.hitCount);
  if (![15, 16, 17, 18, 19, 20, 25].includes(number)) {
    const match = segment.match(/^[SDT](15|16|17|18|19|20)$/);
    if (match) number = Number(match[1]);
    else if (segment === 'S25' || segment === 'DBULL') number = 25;
  }
  if (!Number.isInteger(hitCount) || hitCount < 1 || hitCount > 3) {
    if (segment[0] === 'D') hitCount = 2;
    else if (segment[0] === 'T') hitCount = 3;
    else if (segment === 'DBULL') hitCount = 2;
    else hitCount = 1;
  }
  if (![15, 16, 17, 18, 19, 20, 25].includes(number)) return null;
  if (number === 25 && hitCount > 2) return null;
  return { number, hitCount };
}

function toTimestamp(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function rebuildCricketState(state) {
  const players = Array.isArray(state?.players) ? state.players : [];
  const mode = state?.game?.mode;
  const throws = [];
  players.forEach((player, playerIndex) => {
    const fresh = defaultPlayerCricketState(mode);
    player.cricketHits = fresh.cricketHits;
    player.cricketClosed = fresh.cricketClosed;
    player.cricketPoints = 0;
    player.totalScored = 0;
    (Array.isArray(player.throws) ? player.throws : []).forEach((throwData, throwIndex) => {
      throws.push({ player, playerIndex, throwData, throwIndex, ts: toTimestamp(throwData.ts) });
    });
  });
  throws.sort((left, right) => left.ts - right.ts || left.playerIndex - right.playerIndex || left.throwIndex - right.throwIndex);

  for (const item of throws) {
    const details = cricketThrowDetails(item.throwData);
    if (!details || item.throwData.source === 'manual-miss') {
      item.throwData.cricketPointsAwarded = 0;
      continue;
    }
    item.throwData.number = details.number;
    item.throwData.multiplier = details.hitCount;
    item.throwData.hitCount = details.hitCount;
    item.throwData.cricketPointsAwarded = applyCricketHit(item.player, players, details.number, details.hitCount);
  }
  players.forEach(player => {
    player.totalScored = Number(player.cricketPoints || 0);
  });
  return state;
}

module.exports = {
  defaultPlayerCricketState,
  calculateCricketPoints,
  applyCricketHit,
  checkCricketWin,
  cricketThrowDetails,
  rebuildCricketState
};
