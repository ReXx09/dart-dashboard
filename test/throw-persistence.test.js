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

test('Wurfkorrekturen speichern Vorher- und Nachher-Werte', async () => {
  const sqliteFile = path.join(os.tmpdir(), `dart-dashboard-corrections-${process.pid}-${Date.now()}.db`);
  const previousClient = process.env.DB_CLIENT;
  const previousFile = process.env.DB_SQLITE_FILE;
  process.env.DB_CLIENT = 'sqlite';
  process.env.DB_SQLITE_FILE = sqliteFile;
  const store = new DataStore();

  try {
    await store.init({});
    await store.recordThrowCorrection({
      playerSlot: 1,
      turnId: 4,
      duelId: 7,
      originalPoints: 60,
      correctedPoints: 55,
      delta: -5,
      originalRemaining: 441,
      correctedRemaining: 446,
      originalBust: false,
      correctedBust: false,
      originalSegment: 'T20',
      correctedSegment: 'S55',
      correctedAt: 5678,
      season: '2026'
    });

    const row = await store.sqlite.get('SELECT player_slot, turn_id, duel_id, original_points, corrected_points, delta, original_remaining, corrected_remaining, original_segment, corrected_segment, source, corrected_at FROM throw_corrections');
    assert.deepEqual(row, {
      player_slot: 1,
      turn_id: 4,
      duel_id: 7,
      original_points: 60,
      corrected_points: 55,
      delta: -5,
      original_remaining: 441,
      corrected_remaining: 446,
      original_segment: 'T20',
      corrected_segment: 'S55',
      source: 'live-correction',
      corrected_at: 5678
    });
  } finally {
    if (store.sqlite) await store.sqlite.close();
    if (previousClient === undefined) delete process.env.DB_CLIENT; else process.env.DB_CLIENT = previousClient;
    if (previousFile === undefined) delete process.env.DB_SQLITE_FILE; else process.env.DB_SQLITE_FILE = previousFile;
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(sqliteFile + suffix, { force: true });
  }
});

test('Live-State und Korrektur werden atomar gespeichert', async () => {
  const sqliteFile = path.join(os.tmpdir(), `dart-dashboard-atomic-${process.pid}-${Date.now()}.db`);
  const previousClient = process.env.DB_CLIENT;
  const previousFile = process.env.DB_SQLITE_FILE;
  process.env.DB_CLIENT = 'sqlite';
  process.env.DB_SQLITE_FILE = sqliteFile;
  const store = new DataStore();

  try {
    await store.init({});
    const state = { game: { mode: '501' }, players: [], lastAction: { type: 'correction' } };
    await store.saveLiveStateWithCorrection(state, {
      playerSlot: 1,
      originalPoints: 20,
      correctedPoints: 25,
      delta: 5,
      correctedAt: 6789
    });

    const savedState = await store.getLiveState(null);
    const correctionCount = await store.sqlite.get('SELECT COUNT(*) AS count FROM throw_corrections');
    assert.deepEqual(savedState, state);
    assert.equal(Number(correctionCount.count), 1);
  } finally {
    if (store.sqlite) await store.sqlite.close();
    if (previousClient === undefined) delete process.env.DB_CLIENT; else process.env.DB_CLIENT = previousClient;
    if (previousFile === undefined) delete process.env.DB_SQLITE_FILE; else process.env.DB_SQLITE_FILE = previousFile;
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(sqliteFile + suffix, { force: true });
  }
});

test('Undo entfernt Wurfprojektion und schreibt Undo-Audit atomar', async () => {
  const sqliteFile = path.join(os.tmpdir(), `dart-dashboard-undo-${process.pid}-${Date.now()}.db`);
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
      thrownAt: 1234,
      duelId: 7,
      turnId: 4,
      remaining: 441,
      source: 'manual'
    }]);
    await store.saveLiveStateWithUndo({ game: { mode: '501' }, players: [], lastAction: { type: 'undo' } }, {
      playerSlot: 1,
      thrownAt: 1234,
      duelId: 7,
      turnId: 4,
      originalPoints: 60,
      correctedPoints: 0,
      delta: -60,
      originalRemaining: 441,
      correctedRemaining: 501,
      originalSegment: 'T20',
      correctedAt: 6789
    });

    const segmentCount = await store.sqlite.get('SELECT COUNT(*) AS count FROM player_throw_segments');
    const audit = await store.sqlite.get('SELECT action, original_points, corrected_points, source FROM throw_corrections');
    assert.equal(Number(segmentCount.count), 0);
    assert.deepEqual(audit, { action: 'undo', original_points: 60, corrected_points: 0, source: 'live-undo' });
  } finally {
    if (store.sqlite) await store.sqlite.close();
    if (previousClient === undefined) delete process.env.DB_CLIENT; else process.env.DB_CLIENT = previousClient;
    if (previousFile === undefined) delete process.env.DB_SQLITE_FILE; else process.env.DB_SQLITE_FILE = previousFile;
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(sqliteFile + suffix, { force: true });
  }
});

test('Normaler Wurf und Live-State werden atomar gespeichert', async () => {
  const sqliteFile = path.join(os.tmpdir(), `dart-dashboard-throw-atomic-${process.pid}-${Date.now()}.db`);
  const previousClient = process.env.DB_CLIENT;
  const previousFile = process.env.DB_SQLITE_FILE;
  process.env.DB_CLIENT = 'sqlite';
  process.env.DB_SQLITE_FILE = sqliteFile;
  const store = new DataStore();

  try {
    await store.init({});
    const state = { game: { mode: '501' }, players: [{ slot: 1, remaining: 441 }], lastAction: { type: 'throw' } };
    await store.saveLiveStateWithThrow(state, {
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
      source: 'manual'
    });

    const savedState = await store.getLiveState(null);
    const segment = await store.sqlite.get('SELECT player_slot, points, duel_id, duel_leg_id, turn_id, remaining, source FROM player_throw_segments');
    assert.deepEqual(savedState, state);
    assert.deepEqual(segment, { player_slot: 1, points: 60, duel_id: 7, duel_leg_id: 3, turn_id: 4, remaining: 441, source: 'manual' });
  } finally {
    if (store.sqlite) await store.sqlite.close();
    if (previousClient === undefined) delete process.env.DB_CLIENT; else process.env.DB_CLIENT = previousClient;
    if (previousFile === undefined) delete process.env.DB_SQLITE_FILE; else process.env.DB_SQLITE_FILE = previousFile;
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(sqliteFile + suffix, { force: true });
  }
});
