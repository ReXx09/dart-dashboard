const { checkEliminationWin, rebuildEliminationState } = require('../modes/elimination');
const { checkCricketWin, rebuildCricketState } = require('../modes/cricket');

const MAX_VISIT_DARTS = 3;
const MAX_VISIT_POINTS = 180;

const MESSAGES = {
  noCorrectable: 'Kein Wurf zum Korrigieren vorhanden.',
  noRemovable: 'Kein Wurf zum Rückgängigmachen vorhanden.',
  range: 'Der korrigierte Wurf muss zwischen 0 und 180 liegen.',
  visitLimit: 'Eine Aufnahme kann höchstens 180 Punkte ergeben.',
  wasBust: 'Dieser Wurf war ein Überwerfen (Bust). Er lässt sich nur mit „Wurf entfernen“ zurücknehmen.',
  wouldBust: 'Mit diesem Wert wäre die Aufnahme überworfen (Bust). Bitte einen anderen Wert eingeben.',
  cricket: 'Für Cricket bitte Zahl und Trefferart auswählen.'
};

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function hasTurnId(value) {
  if (value === null || value === undefined || value === '') return false;
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function isManualMiss(throwData) {
  return !!throwData && throwData.source === 'manual-miss';
}

function sameVisit(left, right) {
  return !hasTurnId(left && left.turnId) || !hasTurnId(right && right.turnId) || Number(left.turnId) === Number(right.turnId);
}

function getModeType(context) {
  if (context && context.isCricket) return 'cricket';
  return context && (context.modeType === 'elimination' || context.modeType === 'cricket') ? context.modeType : 'x01';
}

function findLatestCorrectableThrow(state, { includeManualMiss = false } = {}) {
  let latest = null;

  (Array.isArray(state && state.players) ? state.players : []).forEach((player, playerIndex) => {
    const throws = Array.isArray(player && player.throws) ? player.throws : [];
    for (let throwIndex = throws.length - 1; throwIndex >= 0; throwIndex -= 1) {
      const candidate = throws[throwIndex];
      if (candidate && candidate.source === 'manual-miss' && !includeManualMiss) continue;
      if (candidate) {
        const time = toNumber(candidate.ts);
        const turnId = hasTurnId(candidate.turnId) ? Number(candidate.turnId) : 0;
        if (!latest || time > latest.time || (time === latest.time && turnId > latest.turnId)) {
          latest = { player, playerIndex, throwIndex, throwData: candidate, time, turnId };
        }
      }
      break;
    }
  });

  return latest;
}

// Alle Darts der Aufnahme, zu der der Wurf gehört (Fehlwurf-Einträge zählen mit).
function getVisitThrows(player, throwData) {
  const throws = Array.isArray(player && player.throws) ? player.throws : [];
  if (hasTurnId(throwData && throwData.turnId)) {
    return throws.filter(item => item && Number(item.turnId) === Number(throwData.turnId));
  }
  const index = throws.indexOf(throwData);
  if (index < 0) return [throwData];
  const roundSize = Array.isArray(player.currentRoundPoints) ? player.currentRoundPoints.length : 0;
  const size = Math.max(1, Math.min(MAX_VISIT_DARTS, roundSize));
  return throws.slice(Math.max(0, index - size + 1), index + 1);
}

function syncCurrentRoundPoints(player, turnId) {
  const throws = Array.isArray(player && player.throws) ? player.throws : [];
  if (hasTurnId(turnId)) {
    player.currentRoundPoints = throws
      .filter(item => item && Number(item.turnId) === Number(turnId))
      .map(item => toNumber(item.points));
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

// Reststand vor dem ersten Dart der Aufnahme, abgeleitet aus den gespeicherten Rest-Werten.
function getX01VisitStart(visit) {
  const first = visit[0];
  if (!first) return 0;
  const remaining = toNumber(first.remaining);
  return first.bust ? remaining : remaining + toNumber(first.points);
}

// Ein Bust macht die gesamte Aufnahme ungültig; der Reststand fällt auf den Aufnahmestart zurück.
function computeX01Visit(visitStart, darts) {
  let remaining = visitStart;
  let counted = 0;
  for (const dart of darts) {
    if (dart.bust) return { remaining: visitStart, counted: 0 };
    remaining -= toNumber(dart.points);
    counted += toNumber(dart.points);
  }
  return { remaining, counted };
}

function adjustCheckoutAttempts(player, rule, delta) {
  player.checkoutAttempts = Math.max(0, toNumber(player.checkoutAttempts) + delta);
  if (!player.checkoutByRule || typeof player.checkoutByRule !== 'object') player.checkoutByRule = {};
  const stats = player.checkoutByRule[rule] || (player.checkoutByRule[rule] = { attempts: 0, success: 0, highest: 0 });
  stats.attempts = Math.max(0, toNumber(stats.attempts) + delta);
}

function refreshPlayerAfterChange(player, visit, calculateAverage) {
  player.bestTurn = Math.max(0, ...(Array.isArray(player.throws) ? player.throws.map(item => toNumber(item && item.points)) : []));
  player.currentRoundPoints = visit.map(item => toNumber(item.points));
  player.turnScoreRecorded = false;
  if (typeof calculateAverage === 'function') player.average = calculateAverage(player);
}

// Stellt Spieler, Dart-Zähler, Aufnahme-ID und Runde auf den Stand vor dem entfernten Wurf zurück.
function rewindFlow(state, ownerIndex, turnId, dartsInVisit) {
  const game = state.game || (state.game = {});
  const players = Array.isArray(state.players) ? state.players : [];
  const currentTurnId = Math.max(1, toNumber(game.turnId, 1));
  const targetTurnId = hasTurnId(turnId) ? Math.min(Number(turnId), currentTurnId) : currentTurnId;
  const startSlot = toNumber(game.startingPlayerSlot);
  const startIndex = startSlot > 0 ? Math.max(0, players.findIndex(player => toNumber(player.slot) === startSlot)) : 0;

  // Jeder zurückgespulte Spielerwechsel auf den Startspieler war ein Rundenwechsel.
  let roundChanges = 0;
  for (let step = 1; step <= currentTurnId - targetTurnId; step += 1) {
    if ((ownerIndex + step) % players.length === startIndex) roundChanges += 1;
  }
  game.throwRound = Math.max(1, toNumber(game.throwRound, 1) - roundChanges);
  game.turnId = targetTurnId;
  game.activePlayer = ownerIndex;
  game.currentThrow = dartsInVisit;
}

function removeLatestThrow(state, context = {}) {
  const modeType = getModeType(context);

  const latest = findLatestCorrectableThrow(state, { includeManualMiss: true });
  if (!latest) return { error: MESSAGES.noRemovable };

  const { player, playerIndex, throwData } = latest;
  const throws = player.throws;
  const visit = getVisitThrows(player, throwData);

  // Fehlwurf-Einträge entstehen gemeinsam durch einen Klick und werden auch gemeinsam entfernt.
  const removed = [throwData];
  if (isManualMiss(throwData)) {
    for (let index = throws.length - 2; index >= 0; index -= 1) {
      if (!isManualMiss(throws[index]) || !sameVisit(throws[index], throwData)) break;
      removed.unshift(throws[index]);
    }
  }

  let visitStart = 0;
  let visitBefore = { remaining: 0, counted: 0 };
  if (modeType === 'x01') {
    visitStart = getX01VisitStart(visit);
    visitBefore = computeX01Visit(visitStart, visit);
    if (typeof context.isCheckoutAttempt === 'function' && context.checkoutRule) {
      let running = visitStart;
      for (const dart of visit) {
        if (removed.includes(dart) && !isManualMiss(dart) && context.isCheckoutAttempt(running, context.checkoutRule)) {
          adjustCheckoutAttempts(player, context.checkoutRule, -1);
        }
        if (dart.bust) break;
        running -= toNumber(dart.points);
      }
    }
  }

  throws.splice(throws.length - removed.length, removed.length);
  player.turns = Math.max(0, toNumber(player.turns) - removed.length);
  const remainingVisit = visit.filter(dart => !removed.includes(dart));

  if (modeType === 'cricket') {
    rebuildCricketState(state);
  } else if (modeType === 'elimination') {
    rebuildEliminationState(state);
  } else {
    const visitAfter = computeX01Visit(visitStart, remainingVisit);
    player.remaining = visitAfter.remaining;
    player.totalScored = Math.max(0, toNumber(player.totalScored) - visitBefore.counted + visitAfter.counted);
  }
  refreshPlayerAfterChange(player, remainingVisit, context.calculateAverage);
  rewindFlow(state, playerIndex, throwData.turnId, remainingVisit.length);

  return { ...latest, removed, removedCount: removed.length, dartsInVisit: remainingVisit.length };
}

function correctCricketThrow(state, latest, visit, context) {
  const { player, throwData } = latest;
  const number = Number(context.cricketNumber);
  const hitCount = Number(context.cricketMultiplier);
  if (![15, 16, 17, 18, 19, 20, 25].includes(number) || !Number.isInteger(hitCount) || hitCount < 1 || hitCount > (number === 25 ? 2 : 3)) {
    return { error: MESSAGES.cricket };
  }
  const oldPoints = toNumber(throwData.points);
  const oldSegment = throwData.segment || null;
  const oldNumber = throwData.number;
  const oldMultiplier = throwData.multiplier ?? throwData.hitCount;
  const correctedSegment = number === 25 ? (hitCount === 2 ? 'DBULL' : 'S25') : `${hitCount === 1 ? 'S' : hitCount === 2 ? 'D' : 'T'}${number}`;
  const correctedPoints = number === 25 ? hitCount * 25 : number * hitCount;

  throwData.points = correctedPoints;
  throwData.segment = correctedSegment;
  throwData.number = number;
  throwData.multiplier = hitCount;
  throwData.hitCount = hitCount;
  throwData.source = isManualMiss(throwData) ? 'manual-correction' : throwData.source;
  throwData.correctedAt = Date.now();
  rebuildCricketState(state);
  refreshPlayerAfterChange(player, visit, context.calculateAverage);

  return {
    ...latest,
    oldPoints,
    oldSegment,
    oldNumber,
    oldMultiplier,
    oldBust: false,
    newPoints: correctedPoints,
    correctedBust: false,
    correctedSegment,
    correctedRemaining: player.remaining,
    cricketNumber: number,
    cricketMultiplier: hitCount,
    cricketPointsAwarded: toNumber(throwData.cricketPointsAwarded),
    legFinished: checkCricketWin(player, state.players)
  };
}

function correctX01Throw(latest, visit, newPoints, context) {
  const { player, throwData } = latest;
  const { checkoutRule, isValidCheckout, pointsToSegment, calculateAverage, isCheckoutAttempt } = context;
  if (throwData.bust) return { error: MESSAGES.wasBust };

  const previousPoints = visit.reduce((sum, item) => sum + (item === throwData ? 0 : toNumber(item.points)), 0);
  const remainingBeforeThrow = getX01VisitStart(visit) - previousPoints;
  const correctedSegment = newPoints === 0 ? 'MISS' : pointsToSegment(newPoints);
  if (newPoints > 0 && !isValidCheckout(remainingBeforeThrow, newPoints, checkoutRule, correctedSegment)) {
    return { error: MESSAGES.wouldBust };
  }

  const oldPoints = toNumber(throwData.points);
  const oldRemaining = Number.isFinite(Number(throwData.remaining)) ? Number(throwData.remaining) : toNumber(player.remaining);
  const oldSegment = throwData.segment || null;
  const wasManualMiss = isManualMiss(throwData);
  const remainingAfter = remainingBeforeThrow - newPoints;

  throwData.points = newPoints;
  throwData.segment = correctedSegment;
  throwData.bust = false;
  throwData.remaining = remainingAfter;
  if (wasManualMiss) throwData.source = 'manual-correction';
  throwData.correctedAt = Date.now();

  player.remaining = remainingAfter;
  player.totalScored = Math.max(0, toNumber(player.totalScored) - oldPoints + newPoints);
  // Ein Fehlwurf-Eintrag war nie als Checkout-Versuch gezählt, der echte Dart schon.
  if (wasManualMiss && typeof isCheckoutAttempt === 'function' && checkoutRule && isCheckoutAttempt(remainingBeforeThrow, checkoutRule)) {
    adjustCheckoutAttempts(player, checkoutRule, 1);
  }
  refreshPlayerAfterChange(player, visit, calculateAverage);

  return {
    ...latest,
    oldPoints,
    oldBust: false,
    oldRemaining,
    oldSegment,
    newPoints,
    correctedBust: false,
    correctedSegment,
    correctedRemaining: remainingAfter,
    remainingBeforeThrow,
    legFinished: remainingAfter === 0
  };
}

function correctEliminationThrow(state, latest, visit, newPoints, context) {
  const { player, playerIndex, throwIndex, throwData } = latest;
  if (throwData.bust) return { error: MESSAGES.wasBust };

  // Probelauf auf einer Kopie: Der Wert darf die Aufnahme nicht überwerfen.
  const trial = JSON.parse(JSON.stringify({
    game: state.game,
    players: state.players,
    eliminationEvents: state.eliminationEvents || []
  }));
  const trialThrow = trial.players[playerIndex].throws[throwIndex];
  trialThrow.points = newPoints;
  rebuildEliminationState(trial);
  if (trialThrow.bust) return { error: MESSAGES.wouldBust };

  const oldPoints = toNumber(throwData.points);
  const oldRemaining = toNumber(throwData.remaining);
  const oldSegment = throwData.segment || null;
  const correctedSegment = newPoints === 0 ? 'MISS' : context.pointsToSegment(newPoints);

  throwData.points = newPoints;
  throwData.segment = correctedSegment;
  if (isManualMiss(throwData)) throwData.source = 'manual-correction';
  throwData.correctedAt = Date.now();

  rebuildEliminationState(state);
  refreshPlayerAfterChange(player, visit, context.calculateAverage);

  return {
    ...latest,
    oldPoints,
    oldBust: false,
    oldRemaining,
    oldSegment,
    newPoints,
    correctedBust: false,
    correctedSegment,
    correctedRemaining: toNumber(throwData.remaining),
    legFinished: checkEliminationWin(state)
  };
}

// Ändert nur den Wert des letzten Darts; Spieler, Dart-Zähler, Aufnahme-ID und Runde bleiben unberührt.
function correctLatestThrow(state, delta, context = {}) {
  const modeType = getModeType(context);

  const latest = findLatestCorrectableThrow(state, { includeManualMiss: true });
  if (!latest) return { error: MESSAGES.noCorrectable };

  if (modeType === 'cricket') {
    const visit = getVisitThrows(latest.player, latest.throwData);
    return correctCricketThrow(state, latest, visit, context);
  }

  const newPoints = toNumber(latest.throwData.points) + Number(delta);
  if (!Number.isInteger(newPoints) || newPoints < 0 || newPoints > MAX_VISIT_POINTS) return { error: MESSAGES.range };

  const visit = getVisitThrows(latest.player, latest.throwData);
  const otherPoints = visit.reduce((sum, item) => sum + (item === latest.throwData ? 0 : toNumber(item.points)), 0);
  if (otherPoints + newPoints > MAX_VISIT_POINTS) return { error: MESSAGES.visitLimit };

  return modeType === 'elimination'
    ? correctEliminationThrow(state, latest, visit, newPoints, context)
    : correctX01Throw(latest, visit, newPoints, context);
}

module.exports = {
  findLatestCorrectableThrow,
  syncCurrentRoundPoints,
  summarizePlayerThrows,
  removeLatestThrow,
  correctLatestThrow
};
