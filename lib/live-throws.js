function findLatestCorrectableThrow(state) {
  let latest = null;

  (Array.isArray(state && state.players) ? state.players : []).forEach((player, playerIndex) => {
    const throws = Array.isArray(player && player.throws) ? player.throws : [];
    for (let throwIndex = throws.length - 1; throwIndex >= 0; throwIndex -= 1) {
      const candidate = throws[throwIndex];
      if (candidate && candidate.source === 'manual-miss') continue;
      if (candidate && (!latest || Number(candidate.ts || 0) > latest.time)) {
        latest = { player, playerIndex, throwIndex, throwData: candidate, time: Number(candidate.ts || 0) };
      }
      break;
    }
  });

  return latest;
}

function syncCurrentRoundPoints(player, turnId) {
  const throws = Array.isArray(player && player.throws) ? player.throws : [];
  if (Number.isFinite(Number(turnId))) {
    player.currentRoundPoints = throws
      .filter(item => Number(item && item.turnId) === Number(turnId) && item.source !== 'manual-miss')
      .map(item => Number(item.points) || 0);
  } else if (Array.isArray(player.currentRoundPoints) && player.currentRoundPoints.length > 0) {
    player.currentRoundPoints.pop();
  } else {
    player.currentRoundPoints = [];
  }
  player.turnScoreRecorded = false;
}

function roundAverage(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function getTurnScoresFromThrows(throws, includePartial = true) {
  const scores = [];
  for (let index = 0; index < throws.length; index += 3) {
    const turn = throws.slice(index, index + 3);
    if (turn.length < 3 && !includePartial) continue;
    scores.push(turn.reduce((sum, item) => sum + (item && item.bust ? 0 : Number(item && item.points || 0)), 0));
  }
  return scores;
}

function summarizePlayerThrows(player) {
  const throws = Array.isArray(player && player.throws) ? player.throws : [];
  const scoredThrows = throws.filter(item => !item?.bust);
  const totalScored = scoredThrows.reduce((sum, item) => sum + (Number(item?.points) || 0), 0);
  const firstNine = throws.slice(0, 9);
  const firstNineScored = firstNine.reduce((sum, item) => sum + (item?.bust ? 0 : Number(item?.points) || 0), 0);
  const completeTurnScores = getTurnScoresFromThrows(throws, false);
  const turnScores = getTurnScoresFromThrows(throws);

  return {
    darts: throws.length,
    totalScored,
    average: throws.length > 0 ? roundAverage(totalScored / throws.length * 3) : 0,
    firstNineAvg: firstNine.length >= 9 ? roundAverage(firstNineScored / 9 * 3) : 0,
    bestTurn: Math.max(...turnScores, 0),
    completeTurnScores,
    count60plus: completeTurnScores.filter(score => score >= 60).length,
    count80plus: completeTurnScores.filter(score => score >= 80).length,
    count100plus: completeTurnScores.filter(score => score >= 100).length,
    count140plus: completeTurnScores.filter(score => score >= 140).length,
    count171plus: completeTurnScores.filter(score => score >= 171).length,
    count180: completeTurnScores.filter(score => score === 180).length,
    busts: throws.filter(item => item?.bust).length
  };
}

function removeLatestThrow(state, { isCricket = false, calculateAverage } = {}) {
  const latest = findLatestCorrectableThrow(state);
  if (!latest) return null;

  const { player, throwIndex, throwData } = latest;
  player.throws.splice(throwIndex, 1);
  const points = Number(throwData.points) || 0;

  if (isCricket) {
    player.totalScored = Math.max(0, Number(player.totalScored || 0) - points);
  } else if (!throwData.bust) {
    player.remaining = Number(player.remaining || 0) + points;
    player.totalScored = Number(player.totalScored || 0) - points;
  }

  player.turns = Math.max(0, Number(player.turns || 0) - 1);
  syncCurrentRoundPoints(player, throwData.turnId);
  if (typeof calculateAverage === 'function') player.average = calculateAverage(player);
  return latest;
}

function correctLatestThrow(state, delta, { checkoutRule, isValidCheckout, pointsToSegment, calculateAverage } = {}) {
  const latest = findLatestCorrectableThrow(state);
  if (!latest) return { error: 'Kein Wurf zum Korrigieren vorhanden.' };

  const { player, throwData } = latest;
  const oldPoints = Number(throwData.points) || 0;
  const oldBust = !!throwData.bust;
  const oldRemaining = Number.isFinite(Number(throwData.remaining))
    ? Number(throwData.remaining)
    : Number(player.remaining || 0);
  const oldSegment = throwData.segment || null;
  const newPoints = oldPoints + Number(delta);
  if (newPoints < 0 || newPoints > 180) return { error: 'Der korrigierte Wurf muss zwischen 0 und 180 liegen.' };

  const remainingBeforeThrow = oldBust
    ? Number(player.remaining || 0)
    : Number(player.remaining || 0) + oldPoints;
  const correctedSegment = newPoints === 0 ? 'MISS' : pointsToSegment(newPoints);
  const correctedBust = !isValidCheckout(remainingBeforeThrow, newPoints, checkoutRule, correctedSegment);

  throwData.points = newPoints;
  throwData.remaining = correctedBust ? remainingBeforeThrow : remainingBeforeThrow - newPoints;
  throwData.bust = correctedBust;
  throwData.segment = correctedSegment;
  throwData.correctedAt = Date.now();

  player.remaining = throwData.remaining;
  player.totalScored = Math.max(0, Number(player.totalScored || 0) - (oldBust ? 0 : oldPoints) + (correctedBust ? 0 : newPoints));
  player.bestTurn = Math.max(0, ...(Array.isArray(player.throws) ? player.throws.map(item => Number(item.points) || 0) : []));
  syncCurrentRoundPoints(player, throwData.turnId);
  if (typeof calculateAverage === 'function') player.average = calculateAverage(player);

  return {
    ...latest,
    oldPoints,
    oldBust,
    oldRemaining,
    oldSegment,
    newPoints,
    correctedBust,
    correctedSegment,
    correctedRemaining: throwData.remaining
  };
}

module.exports = {
  findLatestCorrectableThrow,
  syncCurrentRoundPoints,
  summarizePlayerThrows,
  removeLatestThrow,
  correctLatestThrow
};
