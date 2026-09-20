function roundAverage(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function normalizeSlots(input = []) {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.map(Number).filter(Number.isInteger).filter(slot => slot > 0).sort((a, b) => a - b))];
}

function normalizeProfileIds(input = []) {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.map(Number).filter(Number.isInteger).filter(profileId => profileId > 0).sort((a, b) => a - b))];
}

function filterMatchingDuels(duels = [], slots = [], category = 'all', exactGroup = false, profileIds = []) {
  const normalizedSlots = normalizeSlots(slots);
  const normalizedProfileIds = normalizeProfileIds(profileIds);
  const wanted = normalizedSlots.join('-');
  return duels.filter(duel => {
    if (category !== 'all' && duel.category !== category) return false;
    if (normalizedProfileIds.length) {
      const participantProfiles = (duel.players || []).map(player => Number(player.profile_id)).filter(Number.isInteger).sort((a, b) => a - b);
      if (exactGroup ? participantProfiles.join('-') !== normalizedProfileIds.join('-') : !normalizedProfileIds.every(profileId => participantProfiles.includes(profileId))) return false;
    }
    if (normalizedProfileIds.length) return true;
    const participantSlots = (duel.players || []).map(player => Number(player.player_slot)).filter(Number.isInteger).sort((a, b) => a - b);
    const key = participantSlots.join('-');
    if (!normalizedSlots.length) return true;
    return exactGroup ? key === wanted : normalizedSlots.every(slot => participantSlots.includes(slot));
  });
}

function aggregateDuelStats({ duels = [], slots = [], profileIds = [], category = 'all', exactGroup = false } = {}) {
  const normalizedSlots = normalizeSlots(slots);
  const normalizedProfileIds = normalizeProfileIds(profileIds);
  const matching = filterMatchingDuels(duels, normalizedSlots, category, exactGroup, normalizedProfileIds);
  const aggregate = new Map();
  let totalLegs = 0;

  for (const duel of matching) {
    for (const leg of duel.legs || []) {
      totalLegs += 1;
      const profileBySlot = new Map((duel.players || []).map(player => [Number(player.player_slot), Number(player.profile_id || 0) || null]));
      for (const player of leg.players || []) {
        const slot = Number(player.player_slot);
        const profileId = profileBySlot.get(slot);
        if (normalizedSlots.length && !normalizedSlots.includes(slot)) continue;
        if (normalizedProfileIds.length && !normalizedProfileIds.includes(profileId)) continue;
        const key = profileId || `slot:${slot}`;
        const current = aggregate.get(key) || {
          slot,
          profileId,
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
    profileIds: normalizedProfileIds,
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
