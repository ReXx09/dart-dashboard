const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sqliteFile = path.join(os.tmpdir(), `dart-dashboard-routes-${process.pid}-${Date.now()}.db`);
process.env.DB_CLIENT = 'sqlite';
process.env.DB_SQLITE_FILE = sqliteFile;
process.env.PLAYER_SWITCH_DELAY_MS = '300';

const { app, dataStore } = require('../server');

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function withApp(run) {
  const randomBackup = Math.random;
  Math.random = () => 0;
  await dataStore.init({});
  await dataStore.savePlayers([
    { slot: 1, name: 'Alice', active: true },
    { slot: 2, name: 'Bob', active: true },
    { slot: 3, name: 'Carol', active: true }
  ]);
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
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
    await run(call);
    await wait(400);
  } finally {
    Math.random = randomBackup;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (dataStore.sqlite) await dataStore.sqlite.close();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(sqliteFile + suffix, { force: true });
  }
}

const flow = state => ({
  activePlayer: state.game.activePlayer,
  currentThrow: state.game.currentThrow,
  turnId: state.game.turnId,
  throwRound: state.game.throwRound,
  status: state.game.status
});

test('Wurfkorrektur über die Routen lässt Spielerwechsel, Countdown und Leg unberührt', async () => {
  await withApp(async call => {
    const throwDart = (playerIndex, points) => call('POST', '/api/live/throw', { playerIndex, points });

    // 1) Korrektur während des Wechsel-Countdowns: Countdown läuft weiter, Korrektur geht nicht verloren.
    assert.equal((await call('POST', '/api/live/start', { mode: '501', checkoutRule: 'double', playerSlots: [1, 2] })).status, 200);
    await throwDart(0, 20);
    await throwDart(0, 20);
    const third = await throwDart(0, 20);
    assert.equal(third.body.lastAction.autoAdvancePending, true);

    const corrected = await call('POST', '/api/live/correct-last', { delta: 40 });
    assert.equal(corrected.status, 200);
    assert.deepEqual(flow(corrected.body), { activePlayer: 0, currentThrow: 3, turnId: 1, throwRound: 1, status: 'running' });
    assert.equal(corrected.body.lastAction.autoAdvancePending, true);
    assert.equal(corrected.body.players[0].remaining, 401);
    assert.deepEqual(corrected.body.players[0].currentRoundPoints, [20, 20, 60]);
    const correctedSegments = await dataStore.sqlite.all('SELECT segment FROM player_throw_segments WHERE player_slot = 1 ORDER BY thrown_at');
    assert.deepEqual(correctedSegments.map(row => row.segment), ['D10', 'D10', 'T20']);

    await wait(900);
    const afterCountdown = (await call('GET', '/api/live/state')).body;
    assert.deepEqual(flow(afterCountdown), { activePlayer: 1, currentThrow: 0, turnId: 2, throwRound: 1, status: 'running' });
    assert.equal(afterCountdown.players[0].remaining, 401);
    const persisted = await dataStore.getLiveState(null);
    assert.equal(persisted.players[0].remaining, 401);
    assert.equal(persisted.game.activePlayer, 1);

    // 2) Versehentlicher Fehlwurf-Klick: Wert nachtragen, ohne dass der Spieler wechselt.
    await dataStore.sqlite.run('DELETE FROM player_throw_segments');
    await call('POST', '/api/live/start', { mode: '501', checkoutRule: 'double', playerSlots: [1, 2] });
    await throwDart(0, 20);
    const missClick = await call('POST', '/api/live/next-player');
    assert.deepEqual(flow(missClick.body), { activePlayer: 1, currentThrow: 0, turnId: 2, throwRound: 1, status: 'running' });

    const missingDart = await call('POST', '/api/live/correct-last', { delta: 60 });
    assert.equal(missingDart.status, 200);
    assert.deepEqual(flow(missingDart.body), { activePlayer: 1, currentThrow: 0, turnId: 2, throwRound: 1, status: 'running' });
    assert.equal(missingDart.body.lastAction.type, 'next-player');
    assert.equal(missingDart.body.players[0].remaining, 421);
    assert.deepEqual(missingDart.body.players[0].currentRoundPoints, [20, 0, 60]);
    await wait(100);
    const segments = await dataStore.sqlite.all('SELECT segment, points FROM player_throw_segments WHERE player_slot = 1 ORDER BY thrown_at');
    assert.deepEqual(segments.map(row => row.segment), ['D10', 'T20']);

    // 3) Wurf entfernen setzt Schritt für Schritt auf den Stand vor dem Wurf zurück.
    const undoCorrected = await call('POST', '/api/live/undo');
    assert.equal(undoCorrected.status, 200);
    assert.deepEqual(flow(undoCorrected.body), { activePlayer: 0, currentThrow: 2, turnId: 1, throwRound: 1, status: 'running' });
    assert.equal(undoCorrected.body.players[0].remaining, 481);
    assert.equal(undoCorrected.body.lastAction.autoAdvancePending, undefined);

    const undoMiss = await call('POST', '/api/live/undo');
    assert.deepEqual(flow(undoMiss.body), { activePlayer: 0, currentThrow: 1, turnId: 1, throwRound: 1, status: 'running' });
    assert.equal(undoMiss.body.players[0].throws.length, 1);
    assert.equal(undoMiss.body.players[0].turns, 1);
    assert.equal((await dataStore.getLiveState(null)).game.currentThrow, 1);
    await wait(100);
    assert.deepEqual((await dataStore.sqlite.all('SELECT segment FROM player_throw_segments WHERE player_slot = 1')).map(row => row.segment), ['D10']);

    // 4) Ungültige Korrekturen ändern nichts und liefern eine Fehlermeldung.
    const tooHigh = await call('POST', '/api/live/correct-last', { delta: 170 });
    assert.equal(tooHigh.status, 400);
    assert.equal((await call('GET', '/api/live/state')).body.players[0].remaining, 481);
  });
});

test('Checkout per Korrektur beendet das Leg regelkonform, danach sind Korrekturen gesperrt', async () => {
  await withApp(async call => {
    const throwDart = (playerIndex, points) => call('POST', '/api/live/throw', { playerIndex, points });

    await call('POST', '/api/live/start', { mode: '301', checkoutRule: 'double', playerSlots: [1, 2] });
    await throwDart(0, 180);
    await call('POST', '/api/live/next-player');
    await call('POST', '/api/live/next-player');
    await throwDart(0, 81);
    await call('POST', '/api/live/next-player');

    const overshoot = await call('POST', '/api/live/correct-last', { delta: 60 });
    assert.equal(overshoot.status, 400);
    assert.match(overshoot.body.error, /überworfen/);

    const checkout = await call('POST', '/api/live/correct-last', { delta: 40 });
    assert.equal(checkout.status, 200);
    assert.equal(checkout.body.game.status, 'leg-finished');
    assert.equal(checkout.body.players[0].remaining, 0);
    assert.equal(checkout.body.players[0].legs, 1);
    assert.equal(checkout.body.lastAction.winnerSlot, 1);
    assert.equal(checkout.body.lastAction.legWin, true);

    assert.equal((await call('POST', '/api/live/correct-last', { delta: 1 })).status, 400);
    assert.equal((await call('POST', '/api/live/undo')).status, 400);
  });
});

test('Elimination: Korrektur und Rücknahme folgen den Regeln, ohne den Spielfluss zu ändern', async () => {
  await withApp(async call => {
    const throwDart = (playerIndex, points) => call('POST', '/api/live/throw', { playerIndex, points });

    await call('POST', '/api/live/start', { mode: 'elimination', checkoutRule: 'double', playerSlots: [1, 2, 3] });
    await throwDart(0, 20);
    await throwDart(0, 20);
    await throwDart(0, 20);
    await call('POST', '/api/live/next-player');
    await throwDart(1, 20);
    await throwDart(1, 20);
    const missClick = await call('POST', '/api/live/next-player');
    assert.deepEqual(flow(missClick.body), { activePlayer: 2, currentThrow: 0, turnId: 3, throwRound: 1, status: 'running' });
    assert.equal(missClick.body.players[1].totalScored, 40);

    const corrected = await call('POST', '/api/live/correct-last', { delta: 20 });
    assert.equal(corrected.status, 200);
    assert.deepEqual(flow(corrected.body), { activePlayer: 2, currentThrow: 0, turnId: 3, throwRound: 1, status: 'running' });
    assert.equal(corrected.body.lastAction.type, 'next-player');
    assert.equal(corrected.body.players[1].totalScored, 60);
    assert.equal(corrected.body.players[0].totalScored, 0);
    assert.equal(corrected.body.players[0].eliminatedCount, 1);
    assert.equal(corrected.body.eliminationEvents.length, 1);

    const undone = await call('POST', '/api/live/undo');
    assert.equal(undone.status, 200);
    assert.deepEqual(flow(undone.body), { activePlayer: 1, currentThrow: 2, turnId: 2, throwRound: 1, status: 'running' });
    assert.equal(undone.body.players[0].totalScored, 60);
    assert.equal(undone.body.players[0].eliminatedCount, 0);
    assert.equal(undone.body.players[1].totalScored, 40);
    assert.equal(undone.body.eliminationEvents.length, 0);
  });
});
