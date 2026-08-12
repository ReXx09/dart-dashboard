const { GAME_MODES } = require('./shared');

function calculateEliminationPoints(player) {
  return Math.max(0, Number(player.totalScored || 0));
}

function checkEliminationWin(state) {
  const modeDef = GAME_MODES[state.game.mode];
  if (!modeDef || modeDef.type !== 'elimination') return false;

  const targetScore = Number(modeDef.targetScore || 301);
  if (state.players.some(player => calculateEliminationPoints(player) >= targetScore)) return true;

  const lastPlayerIndex = Math.max(0, state.players.length - 1);
  return Number(state.game.throwRound || 0) >= 10
    && Number(state.game.currentThrow || 0) >= 3
    && Number(state.game.activePlayer || 0) === lastPlayerIndex;
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
      other.throws = other.throws || [];
      other.throws.push({
        points: 0,
        remaining: 0,
        bust: false,
        eliminated: true,
        eliminatedBy: player.slot,
        ts: Date.now(),
        source: 'elimination'
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

module.exports = {
  calculateEliminationPoints,
  checkEliminationWin,
  getEliminationWinner,
  applyEliminationThrow,
  applyEliminationHit
};
