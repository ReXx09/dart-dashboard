function roundAverage(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function normalizeSlots(input = []) {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.map(Number).filter(Number.isInteger).filter(slot => slot > 0).sort((a, b) => a - b))];
}

function filterMatchingDuels(duels = [], slots = [], category = 'all', exactGroup = false) {
  const normalizedSlots = normalizeSlots(slots);
  const wanted = normalizedSlots.join('-');
  return duels.filter(duel => {
    if (category !== 'all' && duel.category !== category) return false;
    const participantSlots = (duel.players || []).map(player => Number(player.player_slot)).filter(Number.isInteger).sort((a, b) => a - b);
    const key = participantSlots.join('-');
    if (!normalizedSlots.length) return true;
    return exactGroup ? key === wanted : normalizedSlots.every(slot => participantSlots.includes(slot));
  });
}

function aggregateDuelStats({ duels = [], slots = [], category = 'all', exactGroup = false } = {}) {
  const normalizedSlots = normalizeSlots(slots);
  const matching = filterMatchingDuels(duels, normalizedSlots, category, exactGroup);
  const aggregate = new Map();
  let totalLegs = 0;

  for (const duel of matching) {
    for (const leg of duel.legs || []) {
      totalLegs += 1;
      for (const player of leg.players || []) {
        if (normalizedSlots.length && !normalizedSlots.includes(Number(player.player_slot))) continue;
        const key = Number(player.player_slot);
        const current = aggregate.get(key) || {
          slot: key,
          name: player.player_name,
          legs: 0,
          wins: 0,
          darts: 0,
          scored: 0,
          average: 0,
          bestTurn: 0,
          bestLeg: null,
          highestCheckout: 0,
          count60plus: 0,
          count80plus: 0,
          count100plus: 0,
          count140plus: 0,
          count180: 0,
          checkoutAttempts: 0,
          checkoutSuccess: 0,
          busts: 0
        };

        current.legs += 1;
        current.wins += Number(player.won || 0);
        current.darts += Number(player.darts || 0);
        current.scored += Number(player.scored || 0);
        current.bestTurn = Math.max(current.bestTurn, Number(player.best_turn || 0));
        current.count60plus += Number(player.count_60plus || 0);
        current.count80plus += Number(player.count_80plus || 0);
        current.highestCheckout = Math.max(current.highestCheckout, Number(player.checkout_highest || 0));
        if (Number(player.won || 0) && Number(player.darts || 0) > 0) {
          current.bestLeg = current.bestLeg === null
            ? Number(player.darts)
            : Math.min(current.bestLeg, Number(player.darts));
        }
        current.count100plus += Number(player.count_100plus || 0);
        current.count140plus += Number(player.count_140plus || 0);
        current.count180 += Number(player.count_180 || 0);
        current.checkoutAttempts += Number(player.checkout_attempts || 0);
        current.checkoutSuccess += Number(player.checkout_success || 0);
        current.busts += Number(player.busts || 0);
        current.average = current.darts > 0 ? roundAverage((current.scored / current.darts) * 3) : 0;

        aggregate.set(key, current);
      }
    }
  }

  return {
    category,
    playerSlots: normalizedSlots,
    exactGroup: !!exactGroup,
    duels: matching.length,
    legs: totalLegs,
    players: Array.from(aggregate.values())
  };
}

module.exports = {
  normalizeSlots,
  filterMatchingDuels,
  aggregateDuelStats
};
