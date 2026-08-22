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
