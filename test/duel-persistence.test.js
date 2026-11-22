const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DataStore } = require('../db');

async function withStore(run) {
  const sqliteFile = path.join(os.tmpdir(), `dart-dashboard-${process.pid}-${Date.now()}-${Math.random()}.db`);
  const previousClient = process.env.DB_CLIENT;
  const previousFile = process.env.DB_SQLITE_FILE;
  process.env.DB_CLIENT = 'sqlite';
  process.env.DB_SQLITE_FILE = sqliteFile;
  const store = new DataStore();
  try {
    await store.init({});
    await run(store);
  } finally {
    if (store.sqlite) await store.sqlite.close();
    if (previousClient === undefined) delete process.env.DB_CLIENT; else process.env.DB_CLIENT = previousClient;
    if (previousFile === undefined) delete process.env.DB_SQLITE_FILE; else process.env.DB_SQLITE_FILE = previousFile;
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(sqliteFile + suffix, { force: true });
  }
}

test('Duell speichert Out-Regel und aktuelle Statistikversion', async () => {
  await withStore(async store => {
    await store.initPlayerStats(1);
    const stats = await store.getPlayerStats(1);
    assert.equal(Number(stats.checkout_stats_version), 2);
    assert.ok(Number(stats.checkout_tracking_since) > 0);

    const duel = await store.createDuel({
      mode: '501',
      matchType: 'direct',
      checkoutRule: 'master',
      players: [{ slot: 1, name: 'Alice' }, { slot: 2, name: 'Bob' }]
    });

    assert.equal(duel.checkout_rule, 'master');
    assert.equal(Number(duel.checkout_stats_version), 2);
    const completed = await store.recordDuelLeg({
      duelId: duel.id,
      mode: '501',
      winnerSlot: 1,
      startedAt: Date.now() - 1000,
      players: [
        { slot: 1, name: 'Alice', count171plus: 1, count180: 1 },
        { slot: 2, name: 'Bob' }
      ]
    });
    const aliceLeg = completed.legs[0].players.find(player => Number(player.player_slot) === 1);
    assert.equal(Number(aliceLeg.count_171plus), 1);
    assert.equal(Number(aliceLeg.count_180), 1);
    await store.ensureStatisticsAccuracySchema();
    const reloaded = await store.getDuel(duel.id);
    assert.equal(reloaded.checkout_rule, 'master');
  });
});

test('Statistikabruf ist nicht auf 100 Begegnungen begrenzt', async () => {
  await withStore(async store => {
    for (let index = 0; index < 101; index += 1) {
      const duel = await store.createDuel({
        mode: '501',
        matchType: 'single',
        players: [{ slot: 1, name: 'Alice' }]
      });
      await store.sqlite.run("UPDATE duels SET status = 'finished' WHERE id = ?", [duel.id]);
    }

    const duels = await store.listFinishedDuelsForStats();
    assert.equal(duels.length, 101);
  });
});

test('Abgeschlossene Begegnung wird mit Leg-History vollständig gelöscht', async () => {
  await withStore(async store => {
    const duel = await store.createDuel({
      mode: '501',
      matchType: 'direct',
      players: [{ slot: 1, name: 'Claudia' }, { slot: 2, name: 'Andy' }]
    });
    await store.recordDuelLeg({
      duelId: duel.id,
      mode: '501',
      winnerSlot: 1,
      startedAt: Date.now() - 1000,
      players: [{ slot: 1, name: 'Claudia' }, { slot: 2, name: 'Andy' }]
    });
    await store.recordLegHistory(1, 50.1, 40, 1, 30, '2026', duel.id);

    assert.equal(await store.deleteDuel(duel.id), true);
    assert.equal(await store.getDuel(duel.id), null);
    assert.equal(Number((await store.sqlite.get('SELECT COUNT(*) AS count FROM leg_history WHERE duel_id = ?', [duel.id])).count), 0);
  });
});

test('Abgebrochene Begegnung entfernt Wurf-, Leg-, Highscore- und Statistikdetails', async () => {
  await withStore(async store => {
    const duel = await store.createDuel({
      mode: '501',
      matchType: 'direct',
      players: [{ slot: 1, name: 'Claudia' }, { slot: 2, name: 'Andy' }]
    });
    await store.recordDuelLeg({
      duelId: duel.id,
      mode: '501',
      winnerSlot: 1,
      startedAt: Date.now() - 1000,
      players: [{ slot: 1, name: 'Claudia' }, { slot: 2, name: 'Andy' }],
      matchComplete: false
    });
    await store.recordThrowSegments([{
      playerSlot: 1,
      segment: 'T20',
      points: 60,
      mode: '501',
      thrownAt: Date.now(),
      duelId: duel.id,
      source: 'arduino'
    }]);
    await store.addHighscore({ player: 'Claudia', score: 60, kind: 'turn', duelId: duel.id, playerSlot: 1 });
    await store.recordThrowCorrection({
      playerSlot: 1,
      turnId: 1,
      duelId: duel.id,
      originalPoints: 60,
      correctedPoints: 20,
      delta: -40,
      correctedAt: Date.now()
    });
    await store.recordLegHistory(1, 50.1, 40, 1, 30, '2026', duel.id);

    const canceled = await store.cancelDuel(duel.id);
    assert.equal(canceled.status, 'canceled');
    assert.equal(Number(canceled.total_legs), 0);
    for (const table of ['duel_leg_players', 'duel_legs', 'player_throw_segments', 'throw_corrections', 'highscores', 'duel_eliminations', 'leg_history']) {
      assert.equal(Number((await store.sqlite.get(`SELECT COUNT(*) AS count FROM ${table} WHERE duel_id = ?`, [duel.id])).count), 0, table);
    }
  });
});

test('Statistik-Reset löscht First-9-Basis und Leg-History atomisch', async () => {
  await withStore(async store => {
    await store.initPlayerStats(1);
    await store.updatePlayerStats(1, { avg_first9: 50, first_nine_total: 100, first_nine_samples: 2, first_nine_legacy: 1, legs_played: 2 });
    await store.recordLegHistory(1, 50, 0, 0, 30);
    await store.resetPlayerStats(1, ['avg_first9', 'legs_played']);

    const stats = await store.getPlayerStats(1);
    assert.equal(Number(stats.avg_first9), 0);
    assert.equal(Number(stats.first_nine_total), 0);
    assert.equal(Number(stats.first_nine_samples), 0);
    assert.equal(Number(stats.first_nine_legacy), 0);
    assert.equal(Number(stats.checkout_stats_version), 2);
    assert.ok(Number(stats.checkout_tracking_since) > 0);
    assert.equal(Number((await store.sqlite.get('SELECT COUNT(*) AS count FROM leg_history WHERE player_id = 1')).count), 0);
  });
});

test('Highscore-Verwaltung ändert Spielerzuordnung und löscht nur manuelle Einträge', async () => {
  await withStore(async store => {
    await store.addHighscore({ player: 'Alt', score: 100, kind: 'manual' });
    await store.addHighscore({ player: 'Claudia', score: 120, kind: 'checkout', playerSlot: 2 });
    const manual = (await store.getHighscores()).find(entry => entry.kind === 'manual');

    await store.updateHighscore(manual.id, 'Thomas', 101, 1);
    const updated = await store.getHighscore(manual.id);
    assert.equal(updated.player, 'Thomas');
    assert.equal(Number(updated.player_slot), 1);

    await store.clearManualHighscores();
    const remaining = await store.getHighscores();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].kind, 'checkout');
    assert.equal(remaining[0].player, 'Claudia');
  });
});

test('Profile: Namenssperre, Speichern per ID ohne Duplikat, Nutzungszähler und Löschen', async () => {
  await withStore(async store => {
    const [tobiasId] = await store.saveProfiles([{ name: 'Tobias', color: '#e63946' }]);
    assert.ok(tobiasId > 0);
    await assert.rejects(store.saveProfiles([{ name: ' tobias ', color: '#2ec4b6' }]), { code: 'PROFILE_NAME_EXISTS' });
    assert.equal((await store.getProfiles()).length, 1);

    const ids = await store.saveProfiles([{ id: tobiasId, name: 'Tobias', color: '#ff9f1c' }, { name: 'tobias', color: '#2ec4b6', allowDuplicateName: true }, { name: '  ' }]);
    assert.equal(ids.length, 2);
    assert.equal(ids[0], tobiasId);
    assert.notEqual(ids[1], tobiasId);
    const profiles = await store.getProfiles();
    assert.equal(profiles.length, 2);
    assert.equal(profiles.find(profile => Number(profile.id) === tobiasId).color, '#ff9f1c');

    await store.savePlayers([{ slot: 1, name: 'Tobias', active: true, color: '#ff9f1c', profileId: tobiasId }]);
    await store.createDuel({ mode: '501', matchType: 'direct', players: [{ slot: 1, name: 'Tobias', profileId: tobiasId }, { slot: 2, name: 'Gast' }] });
    await store.addHighscore({ player: 'Tobias', score: 140, kind: '140er', playerSlot: 1, profileId: tobiasId });
    const usage = await store.getProfileUsage();
    assert.equal(usage.get(tobiasId).duels, 1);
    assert.equal(usage.get(tobiasId).highscores, 1);
    assert.deepEqual(usage.get(tobiasId).slots, [1]);
    assert.equal(usage.has(ids[1]), false);

    assert.equal(await store.deleteProfile(tobiasId), true);
    assert.deepEqual((await store.getProfiles()).map(profile => Number(profile.id)), [ids[1]]);
    const slot = (await store.getPlayers()).find(player => Number(player.slot) === 1);
    assert.equal(slot.profileId ?? null, null);
    assert.equal(await store.deleteProfile(tobiasId), false);
  });
});

test('Highscores ab Zeitpunkt filtern vor dem Limit, damit kleine Tages-Checkouts nicht verdrängt werden', async () => {
  await withStore(async store => {
    const todayStart = 1_000_000;
    for (let index = 0; index < 5; index++) {
      await store.addHighscore({ player: 'Alt', score: 180, kind: '180er', ts: todayStart - 1000 - index });
    }
    await store.addHighscore({ player: 'Moni', score: 3, kind: 'checkout', legWin: true, ts: todayStart + 10 });

    assert.equal((await store.getHighscores(5, '', true)).some(entry => entry.player === 'Moni'), false);
    const today = await store.getHighscores(5, '', true, todayStart);
    assert.deepEqual(today.map(entry => [entry.player, entry.score, entry.kind]), [['Moni', 3, 'checkout']]);
  });
});
