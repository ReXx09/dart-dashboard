const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DataStore } = require('../db');

test('Wurfdetails speichern Aufnahme, Restscore und Quelle', async () => {
  const sqliteFile = path.join(os.tmpdir(), `dart-dashboard-throws-${process.pid}-${Date.now()}.db`);
  const previousClient = process.env.DB_CLIENT;
  const previousFile = process.env.DB_SQLITE_FILE;
  process.env.DB_CLIENT = 'sqlite';
  process.env.DB_SQLITE_FILE = sqliteFile;
  const store = new DataStore();

  try {
    await store.init({});
    await store.recordThrowSegments([{
      playerSlot: 1,
      segment: 'T20',
      points: 60,
      mode: '501',
      bust: false,
      thrownAt: 1234,
      duelId: 7,
      duelLegId: 3,
      turnId: 4,
      remaining: 441,
      source: 'manual',
      season: '2026'
    }]);

    const row = await store.sqlite.get('SELECT player_slot, segment, points, duel_id, duel_leg_id, turn_id, remaining, source FROM player_throw_segments');
    assert.deepEqual(row, {
      player_slot: 1,
      segment: 'T20',
      points: 60,
      duel_id: 7,
      duel_leg_id: 3,
      turn_id: 4,
      remaining: 441,
      source: 'manual'
    });
  } finally {
    if (store.sqlite) await store.sqlite.close();
    if (previousClient === undefined) delete process.env.DB_CLIENT; else process.env.DB_CLIENT = previousClient;
    if (previousFile === undefined) delete process.env.DB_SQLITE_FILE; else process.env.DB_SQLITE_FILE = previousFile;
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(sqliteFile + suffix, { force: true });
  }
});
