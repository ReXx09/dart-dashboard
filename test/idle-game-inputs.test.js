const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sqliteFile = path.join(os.tmpdir(), `dart-dashboard-idle-inputs-${process.pid}-${Date.now()}.db`);
process.env.DB_CLIENT = 'sqlite';
process.env.DB_SQLITE_FILE = sqliteFile;

const {
  app,
  dataStore,
  applyArduinoThrowFromChannel,
  applyArduinoThrowFromMatrix,
  applyArduinoMiss
} = require('../server');

test('Idle-Spiel verwirft Arduino- und manuelle Eingaben, laufendes Spiel nimmt Würfe an', async () => {
  await dataStore.init({});
  await dataStore.savePlayers([
    { slot: 1, name: 'Alice', active: true },
    { slot: 2, name: 'Bob', active: true }
  ]);
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (method, url, body) => {
    const response = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };

  try {
    const idle = await call('GET', '/api/live/state');
    assert.equal(idle.status, 200);
    assert.equal(idle.body.game.status, 'idle');

    assert.equal((await applyArduinoThrowFromChannel('01')).reason, 'game-not-running');
    assert.equal((await applyArduinoThrowFromMatrix({ code: 120 })).reason, 'game-not-running');
    assert.equal((await applyArduinoMiss()).reason, 'game-not-running');
    assert.equal((await call('POST', '/api/live/throw', { playerSlot: 1, points: 20 })).status, 409);
    assert.equal((await call('POST', '/api/live/next-player')).status, 409);
    assert.equal((await call('POST', '/api/live/undo')).status, 409);
    assert.equal((await call('POST', '/api/live/correct-last', { delta: 20 })).status, 409);
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(Number((await dataStore.sqlite.get('SELECT COUNT(*) AS count FROM player_throw_segments')).count), 0);
    assert.equal(Number((await dataStore.sqlite.get('SELECT COUNT(*) AS count FROM highscores')).count), 0);

    assert.equal((await call('POST', '/api/live/start', { mode: '501', playerSlots: [1, 2] })).status, 200);
    assert.equal((await applyArduinoThrowFromChannel('01')).ok, true);
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(Number((await dataStore.sqlite.get('SELECT COUNT(*) AS count FROM player_throw_segments')).count), 1);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (dataStore.sqlite) await dataStore.sqlite.close();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(sqliteFile + suffix, { force: true });
  }
});
