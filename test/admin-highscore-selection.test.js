const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sqliteFile = path.join(os.tmpdir(), `dart-dashboard-admin-highscores-${process.pid}-${Date.now()}.db`);
process.env.DB_CLIENT = 'sqlite';
process.env.DB_SQLITE_FILE = sqliteFile;
process.env.ADMIN_AUTH_ENABLED = 'false';

const { app, dataStore } = require('../server');

test('Bulk-Löschen akzeptiert nicht zugeordnete automatische Highscores, aber keine Begegnungs-Highscores', async () => {
  await dataStore.init({});
  const duel = await dataStore.createDuel({
    mode: '501',
    matchType: 'direct',
    players: [{ slot: 1, name: 'Alice' }, { slot: 2, name: 'Bob' }]
  });
  await dataStore.addHighscore({ player: 'Alice', score: 180, kind: '180er' });
  await dataStore.addHighscore({ player: 'Alice', score: 140, kind: 'turn', duelId: duel.id, playerSlot: 1 });
  const orphaned = await dataStore.sqlite.get('SELECT id FROM highscores WHERE duel_id IS NULL AND player = ?', ['Alice']);
  const linked = await dataStore.sqlite.get('SELECT id FROM highscores WHERE duel_id = ?', [duel.id]);
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const base = 'http://127.0.0.1:' + server.address().port;

  try {
    const blockedResponse = await fetch(base + '/api/highscores/selected', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [orphaned.id, linked.id] })
    });
    assert.equal(blockedResponse.status, 409);
    assert.ok(await dataStore.getHighscore(orphaned.id));
    assert.ok(await dataStore.getHighscore(linked.id));

    const editResponse = await fetch(base + '/api/highscores/' + orphaned.id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ player: 'Alice', score: 140 })
    });
    assert.equal(editResponse.status, 200);
    const edited = await dataStore.getHighscore(orphaned.id);
    assert.equal(edited.score, 140);
    assert.equal(edited.kind, '140+');

    const deletedResponse = await fetch(base + '/api/highscores/selected', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [orphaned.id] })
    });
    assert.equal(deletedResponse.status, 200);
    assert.equal(await dataStore.getHighscore(orphaned.id), undefined);
    assert.ok(await dataStore.getHighscore(linked.id));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (dataStore.sqlite) await dataStore.sqlite.close();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(sqliteFile + suffix, { force: true });
  }
});
