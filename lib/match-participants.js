function participantError(message) {
  const error = new Error(message);
  error.code = 'PARTICIPANTS_INVALID';
  return error;
}

// Ordnet die im Startdialog gewählten Teilnehmer (bestehende Slots, Profile oder Gäste) Slots zu.
// Profile behalten ihren bisherigen Slot; neue Teilnehmer belegen zuerst leere, dann inaktive Slots.
function assignParticipantSlots(players, participants, profiles = []) {
  const list = (Array.isArray(players) ? players : []).map(player => ({ ...player }));
  const profilesById = new Map(profiles.map(profile => [Number(profile.id), profile]));
  const profilesByName = new Map(profiles.map(profile => [String(profile.name || '').trim().toLowerCase(), profile]));
  const usedSlots = new Set();
  const resolved = [];
  let changed = false;

  const bySlot = slot => list.find(player => Number(player.slot) === Number(slot));
  const take = player => {
    if (usedSlots.has(Number(player.slot))) throw participantError(`${player.name || 'Slot ' + player.slot} ist doppelt ausgewählt.`);
    usedSlots.add(Number(player.slot));
    if (!player.active) { player.active = true; changed = true; }
    resolved.push(Number(player.slot));
  };
  const pending = [];

  for (const raw of Array.isArray(participants) ? participants : []) {
    const slot = Number(raw?.slot || 0);
    let profileId = Number(raw?.profileId || 0);
    const guestName = String(raw?.name || '').trim().slice(0, 24);
    if (slot > 0) {
      const player = bySlot(slot);
      if (!player || !String(player.name || '').trim()) throw participantError(`Slot ${slot} hat keinen Spielernamen.`);
      take(player);
      continue;
    }
    if (profileId <= 0 && guestName) profileId = Number(profilesByName.get(guestName.toLowerCase())?.id || 0);
    if (profileId > 0) {
      const profile = profilesById.get(profileId);
      if (!profile) throw participantError(`Profil #${profileId} existiert nicht mehr.`);
      const existing = list.find(player => Number(player.profileId) === profileId);
      if (existing) { take(existing); continue; }
      pending.push({ index: resolved.length, name: profile.name, profileId, color: profile.color || null });
      resolved.push(null);
      continue;
    }
    if (!guestName) throw participantError('Teilnehmer ohne Namen.');
    const existingGuest = list.find(player => !player.profileId && String(player.name || '').trim().toLowerCase() === guestName.toLowerCase());
    if (existingGuest) { take(existingGuest); continue; }
    pending.push({ index: resolved.length, name: guestName, profileId: null, color: null });
    resolved.push(null);
  }

  const reserved = new Set(usedSlots);
  const isNamed = player => !!String(player.name || '').trim();
  const open = list.filter(player => !reserved.has(Number(player.slot)));
  // Erst leere Slots, dann inaktive Gast-Slots, zuletzt inaktive Profil-Slots überschreiben.
  // Unbedenklich: Profilstatistiken werden über duel_players.profile_id ausgewertet, nicht über die Slot-Nummer.
  const freeSlots = [
    ...open.filter(player => !isNamed(player)),
    ...open.filter(player => isNamed(player) && !player.active && !player.profileId),
    ...open.filter(player => isNamed(player) && !player.active && player.profileId)
  ];
  if (pending.length > freeSlots.length) {
    throw participantError(`Nicht genug freie Slots: ${pending.length} benötigt, ${freeSlots.length} frei. Bitte in der Spielerverwaltung Slots freigeben.`);
  }
  pending.forEach((entry, position) => {
    const target = freeSlots[position];
    target.name = entry.name;
    target.profileId = entry.profileId;
    target.color = entry.color || null;
    target.active = true;
    usedSlots.add(Number(target.slot));
    resolved[entry.index] = Number(target.slot);
    changed = true;
  });

  return { players: list, slots: resolved, changed };
}

module.exports = { assignParticipantSlots };
