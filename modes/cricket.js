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

module.exports = {
  defaultPlayerCricketState,
  calculateCricketPoints,
  applyCricketHit,
  checkCricketWin
};
