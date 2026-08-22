function percentage(success, attempts) {
  const safeAttempts = Number(attempts || 0);
  if (safeAttempts <= 0) return null;
  return Number((Number(success || 0) / safeAttempts * 100).toFixed(1));
}

function addDerivedMetrics(entry) {
  const darts = Number(entry.darts ?? entry.totalDarts ?? 0);
  const scored = Number(entry.totalScored || 0);
  const firstNineTotal = Number(entry.firstNineTotal || 0);
  const firstNineSamples = Number(entry.firstNineSamples || 0);
  const legsPlayed = Number(entry.legsPlayed || 0);
  const legsWon = Number(entry.legsWon || 0);
  const matchesPlayed = Number(entry.matchesPlayed ?? entry.gamesPlayed ?? 0);
  const matchesWon = Number(entry.matchesWon ?? entry.gamesWon ?? 0);
  const category = String(entry.category || 'all');

  return {
    ...entry,
    threeDartAverage: darts > 0 ? Number((scored / darts * 3).toFixed(1)) : 0,
    firstNineAverage: firstNineSamples > 0 ? Number((firstNineTotal / firstNineSamples).toFixed(1)) : 0,
    firstNineSamples,
    legsPlayed,
    legsWon,
    legWinRate: percentage(legsWon, legsPlayed),
    matchesPlayed,
    matchesWon,
    matchWinRate: percentage(matchesWon, matchesPlayed),
    soloMatchesPlayed: Number(entry.soloMatchesPlayed ?? (category === 'single' ? matchesPlayed : 0)),
    duelsPlayed: Number(entry.duelsPlayed ?? (category === 'duel' ? matchesPlayed : 0)),
    groupMatchesPlayed: Number(entry.groupMatchesPlayed ?? (category === 'group' ? matchesPlayed : 0)),
    tournamentMatchesPlayed: Number(entry.tournamentMatchesPlayed ?? (category === 'tournament' ? matchesPlayed : 0)),
    gamesPlayed: matchesPlayed,
    gamesWon: matchesWon
  };
}

module.exports = { addDerivedMetrics, percentage };
