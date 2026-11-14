const { GAME_MODES } = require('./shared');

function calculateEliminationPoints(player) {
  return Math.max(0, Number(player.totalScored || 0));
}

function checkEliminationWin(state) {
  const modeDef = GAME_MODES[state.game.mode];
  if (!modeDef || modeDef.type !== 'elimination') return false;

  const targetScore = Number(modeDef.targetScore || 301);
  if (state.players.some(player => calculateEliminationPoints(player) >= targetScore)) return true;

  const throwRound = Number(state.game.throwRound || 0);
  return throwRound > 10;
}

function getEliminationWinner(state) {
  let winner = null;
  let maxPoints = -1;
  for (const player of state.players) {
    const points = calculateEliminationPoints(player);
    if (points > maxPoints) {
      maxPoints = points;
      winner = player;
    }
  }
  return winner;
}

function applyEliminationHit(state, player, value) {
  const currentPlayerScore = calculateEliminationPoints(player);

  for (const other of state.players) {
    if (other.slot === player.slot) continue;
    const otherPoints = calculateEliminationPoints(other);

    if (otherPoints === currentPlayerScore) {
      if (otherPoints === 0 && currentPlayerScore === 0) continue;

      other.totalScored = 0;
      other.eliminatedCount = Number(other.eliminatedCount || 0) + 1;
      if (!Array.isArray(state.eliminationEvents)) state.eliminationEvents = [];
      state.eliminationEvents.push({
        eliminatorSlot: player.slot,
        eliminatorName: player.name,
        eliminatedSlot: other.slot,
        eliminatedName: other.name,
        createdAt: Date.now()
      });
      state.lastAction = {
        type: 'elimination',
        source: 'elimination',
        playerIndex: state.players.indexOf(other),
        playerSlot: other.slot,
        player: other.name,
        eliminatedBy: player.name,
        eliminatedBySlot: player.slot,
        points: value,
        ts: Date.now()
      };
      return true;
    }
  }
  return false;
}

function applyEliminationThrow(state, player, value) {
  const modeDef = GAME_MODES[state.game.mode] || GAME_MODES.elimination;
  const targetScore = Number(modeDef.targetScore || 301);
  const previousTurnPoints = Array.isArray(player.currentRoundPoints)
    ? player.currentRoundPoints.reduce((sum, points) => sum + (Number(points) || 0), 0)
    : 0;
  const nextScore = calculateEliminationPoints(player) + value;

  if (nextScore > targetScore) {
    player.totalScored = Math.max(0, nextScore - previousTurnPoints - value);
    return { bust: true, eliminationAction: null };
  }

  player.totalScored = nextScore;
  const eliminated = applyEliminationHit(state, player, value);
  return {
    bust: false,
    eliminationAction: eliminated ? state.lastAction : null
  };
}

function rebuildEliminationState(state) {
  const players = Array.isArray(state.players) ? state.players : [];
  const savedLastAction = state.lastAction;
  const savedRounds = players.map(player => player.currentRoundPoints);
  const entries = [];

  players.forEach((player, playerIndex) => {
    player.totalScored = 0;
    player.eliminatedCount = 0;
    (Array.isArray(player.throws) ? player.throws : []).forEach((throwData, throwIndex) => {
      if (throwData) entries.push({ player, playerIndex, throwData, throwIndex });
    });
  });
  entries.sort((left, right) =>
    (Number(left.throwData.ts) || 0) - (Number(right.throwData.ts) || 0)
    || left.playerIndex - right.playerIndex
    || left.throwIndex - right.throwIndex);

  state.eliminationEvents = [];
  const visits = new Map();
  for (const { player, throwData } of entries) {
    const turnId = Number(throwData.turnId);
    const visitKey = player.slot + ':' + (Number.isFinite(turnId) ? turnId : 'ohne');
    const visitPoints = visits.get(visitKey) || [];
    const value = Number(throwData.points) || 0;

    // Ein Bust verwirft über currentRoundPoints die bisherigen Darts derselben Aufnahme.
    player.currentRoundPoints = visitPoints.slice();
    const result = applyEliminationThrow(state, player, value);
    throwData.bust = result.bust;
    throwData.elimination = Boolean(result.eliminationAction);
    if (result.eliminationAction) {
      const event = state.eliminationEvents[state.eliminationEvents.length - 1];
      if (event && Number(throwData.ts) > 0) event.createdAt = Number(throwData.ts);
    }
    visitPoints.push(value);
    visits.set(visitKey, visitPoints);
  }

  players.forEach((player, index) => { player.currentRoundPoints = savedRounds[index]; });
  if (savedLastAction === undefined) delete state.lastAction;
  else state.lastAction = savedLastAction;
  return state;
}

module.exports = {
  calculateEliminationPoints,
  checkEliminationWin,
  getEliminationWinner,
  applyEliminationThrow,
  applyEliminationHit,
  rebuildEliminationState
};
