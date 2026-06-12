const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { DataStore } = require('./db');

let SerialPortCtor = null;
let ReadlineParserCtor = null;
try {
  ({ SerialPort: SerialPortCtor } = require('serialport'));
  ({ ReadlineParser: ReadlineParserCtor } = require('@serialport/parser-readline'));
} catch (_err) {
  // Optional – Dashboard läuft auch ohne Serial-Monitor.
}

// ──────────────────────────────────────────────
// SSE – alle offenen Dashboard-Clients
// ──────────────────────────────────────────────
const sseClients = new Set();
function broadcastReload() {
  sseClients.forEach(res => { try { res.write('event: reload\ndata: 1\n\n'); } catch { sseClients.delete(res); } });
}

function getLocalIP() {
  if (process.env.SERVER_IP) return process.env.SERVER_IP;
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal && !alias.address.startsWith('169.254.'))
        return alias.address;
    }
  }
  return 'localhost';
}

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR       = path.join(__dirname, 'data');
const SETTINGS_FILE  = path.join(DATA_DIR, 'settings.json');
const PLAYERS_FILE   = path.join(DATA_DIR, 'players.json');
const LIVE_STATE_FILE = path.join(DATA_DIR, 'live-state.json');
const HIGHSCORES_FILE = path.join(DATA_DIR, 'highscores.json');

const DART_VALUE_BY_CHANNEL = {
  '01': 20,
  '02': 1,
  '03': 18,
  '04': 4,
  '05': 13,
  '06': 6,
  '07': 10,
  '08': 15,
  '09': 2,
  '10': 17,
  '11': 3,
  '12': 19,
  '13': 7,
  '14': 16,
  '15': 8,
  '16': 11,
  '17': 14,
  '18': 9,
  '19': 12,
  '20': 5,
  '21': 50,
  '22': 25
};
const ARDUINO_AUTO_THROW_ENABLED = process.env.ARDUINO_AUTO_THROW_ENABLED !== 'false';
const ARDUINO_REQUIRE_THROW_TRIGGER = process.env.ARDUINO_REQUIRE_THROW_TRIGGER !== 'false';
const ARDUINO_THROW_WINDOW_MS = Number(process.env.ARDUINO_THROW_WINDOW_MS || 1200);

const dataStore = new DataStore();

// ──────────────────────────────────────────────
// Hilfsfunktionen
// ──────────────────────────────────────────────
function readJson(file, fallback) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  return fallback;
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function getSettings() {
  const merged = {
    arduinoMonitorEnabled: true,
    arduinoPort: '',
    arduinoBaudRate: 115200,
    ...readJson(SETTINGS_FILE, {})
  };
  return merged;
}
function saveSettings(s) { writeJson(SETTINGS_FILE, s); }

// ──────────────────────────────────────────────
// Arduino Serial Monitor
// ──────────────────────────────────────────────
const arduinoSseClients = new Set();
let arduinoPort = null;
let arduinoParser = null;
let arduinoReconnectTimer = null;
let pendingArduinoThrow = null;
let pendingArduinoThrowTimer = null;
let arduinoThrowLockUntil = 0;
const arduinoRawEventHistory = [];
const arduinoState = {
  enabled: true,
  connected: false,
  port: null,
  baudRate: 115200,
  lastLine: '',
  lastEvent: null,
  lastHeartbeat: null,
  lastTrigger: null,
  pendingThrow: false,
  lastAutoThrow: null,
  lastMiss: null,
  lastAutoThrowError: null,
  activeCount: null,
  lastUpdateMs: null,
  rawHistory: [],
  error: null
};

function broadcastArduinoState() {
  const payload = JSON.stringify(arduinoState);
  arduinoSseClients.forEach((res) => {
    try { res.write(`event: state\ndata: ${payload}\n\n`); }
    catch { arduinoSseClients.delete(res); }
  });
}

function normalizeArduinoStatePatch(patch) {
  Object.assign(arduinoState, patch, { lastUpdateMs: Date.now() });
  broadcastArduinoState();
}

function rememberArduinoLine(line) {
  const entry = { line: String(line || '').trim(), ts: Date.now() };
  arduinoRawEventHistory.unshift(entry);
  while (arduinoRawEventHistory.length > 20) arduinoRawEventHistory.pop();
}

function formatChannel(channel) {
  const key = String(channel || '').replace(/^0+/, '');
  return key ? String(Number(key)).padStart(2, '0') : '';
}

function dartValueFromChannel(channel) {
  const key = formatChannel(channel);
  return Object.prototype.hasOwnProperty.call(DART_VALUE_BY_CHANNEL, key) ? DART_VALUE_BY_CHANNEL[key] : null;
}

function clearPendingArduinoThrow() {
  if (pendingArduinoThrowTimer) clearTimeout(pendingArduinoThrowTimer);
  pendingArduinoThrowTimer = null;
  pendingArduinoThrow = null;
}

async function applyArduinoThrowFromChannel(channel, evt = {}) {
  const value = dartValueFromChannel(channel);
  if (value == null) return { ok: false, reason: 'unknown-channel', channel: formatChannel(channel) };

  const state = await getLiveState();
  if (!Array.isArray(state.players) || state.players.length === 0) return { ok: false, reason: 'no-players' };
  if (state.game.status === 'leg-finished') return { ok: false, reason: 'leg-finished' };

  const targetIndex = Number.isInteger(state.game.activePlayer) ? state.game.activePlayer : 0;
  const player = state.players[targetIndex];
  if (!player) return { ok: false, reason: 'no-active-player' };

  const nextRemaining = player.remaining - value;
  const bust = nextRemaining < 0;

  player.turns = Math.max(0, Number(player.turns || 0)) + 1;
  player.bestTurn = Math.max(Number(player.bestTurn || 0), value);
  if (!bust) {
    player.remaining = nextRemaining;
    player.totalScored = Math.max(0, Number(player.totalScored || 0)) + value;
  }

  if (!Array.isArray(player.currentRoundPoints)) player.currentRoundPoints = [];
  player.currentRoundPoints.push(value);

  if (!Array.isArray(player.throws)) player.throws = [];
  player.throws.push({
    points: value,
    remaining: player.remaining,
    bust,
    ts: Date.now(),
    source: 'arduino',
    channel: formatChannel(channel),
    raw: evt.line || null
  });

  player.average = player.turns > 0 ? Math.round((player.totalScored / (player.turns * 3)) * 100) / 100 : 0;
  state.game.currentThrow = (Number(state.game.currentThrow || 0) || 0) + 1;

  state.lastAction = {
    type: 'throw',
    source: 'arduino',
    playerIndex: targetIndex,
    playerSlot: player.slot,
    player: player.name,
    points: value,
    channel: formatChannel(channel),
    bust,
    remaining: player.remaining,
    roundThrow: state.game.currentThrow,
    ts: Date.now()
  };

  if (player.remaining === 0) {
    player.legs = Math.max(0, Number(player.legs || 0)) + 1;
    await addHighscore(player.name, value, { kind: 'checkout', legWin: true, source: 'arduino' });
    state.game.status = 'leg-finished';
    state.lastAction.legWin = true;
  }

  if (state.game.status !== 'leg-finished' && state.game.currentThrow >= 3) {
    state.game.activePlayer = (state.game.activePlayer + 1) % state.players.length;
    state.game.currentThrow = 0;
    state.game.throwRound = (state.game.throwRound || 1) + 1;
    state.lastAction.autoAdvanced = true;
    state.lastAction.nextPlayer = state.players[state.game.activePlayer].name;
    state.lastAction.nextPlayerSlot = state.players[state.game.activePlayer].slot;
  }

  const saved = await saveLiveState(state);
  broadcastReload();
  return { ok: true, value, player: player.name, playerSlot: player.slot, channel: formatChannel(channel), bust, remaining: player.remaining, state: saved };
}

async function applyArduinoMiss(evt = {}, reason = 'timeout') {
  const state = await getLiveState();
  if (!Array.isArray(state.players) || state.players.length === 0) return { ok: false, reason: 'no-players' };
  if (state.game.status === 'leg-finished') return { ok: false, reason: 'leg-finished' };

  const targetIndex = Number.isInteger(state.game.activePlayer) ? state.game.activePlayer : 0;
  const player = state.players[targetIndex];
  if (!player) return { ok: false, reason: 'no-active-player' };

  player.turns = Math.max(0, Number(player.turns || 0)) + 1;
  if (!Array.isArray(player.currentRoundPoints)) player.currentRoundPoints = [];
  player.currentRoundPoints.push(0);

  if (!Array.isArray(player.throws)) player.throws = [];
  player.throws.push({
    points: 0,
    remaining: player.remaining,
    bust: false,
    ts: Date.now(),
    source: 'arduino-miss',
    reason,
    channel: evt.channel ? formatChannel(evt.channel) : null,
    raw: evt.line || null
  });

  player.average = player.turns > 0 ? Math.round((player.totalScored / (player.turns * 3)) * 100) / 100 : 0;
  state.game.currentThrow = (Number(state.game.currentThrow || 0) || 0) + 1;

  state.lastAction = {
    type: 'miss',
    source: 'arduino',
    reason,
    playerIndex: targetIndex,
    playerSlot: player.slot,
    player: player.name,
    points: 0,
    channel: evt.channel ? formatChannel(evt.channel) : null,
    remaining: player.remaining,
    roundThrow: state.game.currentThrow,
    ts: Date.now()
  };

  if (state.game.currentThrow >= 3) {
    state.game.activePlayer = (state.game.activePlayer + 1) % state.players.length;
    state.game.currentThrow = 0;
    state.game.throwRound = (state.game.throwRound || 1) + 1;
    state.lastAction.autoAdvanced = true;
    state.lastAction.nextPlayer = state.players[state.game.activePlayer].name;
    state.lastAction.nextPlayerSlot = state.players[state.game.activePlayer].slot;
  }

  const saved = await saveLiveState(state);
  broadcastReload();
  return { ok: true, reason, player: player.name, playerSlot: player.slot, remaining: player.remaining, state: saved };
}

function handleArduinoTrigger(evt) {
  if (!ARDUINO_AUTO_THROW_ENABLED) return;
  if (pendingArduinoThrow && !pendingArduinoThrow.applied) return;
  if (Date.now() < arduinoThrowLockUntil) return;

  clearPendingArduinoThrow();
  pendingArduinoThrow = { triggerMs: Number(evt.ms || 0), line: evt.line || '', startedAt: Date.now(), applied: false, timer: null };
  pendingArduinoThrow.timer = setTimeout(() => {
    const pending = pendingArduinoThrow;
    if (!pending || pending.applied) return;
    pendingArduinoThrow = null;
    pendingArduinoThrowTimer = null;
    normalizeArduinoStatePatch({ pendingThrow: false });
    applyArduinoMiss({ line: pending.line || '', ms: pending.triggerMs }, 'timeout')
      .then((result) => normalizeArduinoStatePatch({ lastMiss: result.ok ? result : { ok: false, reason: result.reason } }))
      .catch((err) => normalizeArduinoStatePatch({ lastMiss: { ok: false, reason: err.message }, lastAutoThrowError: err.message }));
  }, ARDUINO_THROW_WINDOW_MS);
  pendingArduinoThrowTimer = pendingArduinoThrow.timer;
  normalizeArduinoStatePatch({ pendingThrow: true, lastAutoThrow: null, lastMiss: null, lastAutoThrowError: null });
}

function handleArduinoActiveEvent(evt) {
  if (!ARDUINO_AUTO_THROW_ENABLED) return;
  if (ARDUINO_REQUIRE_THROW_TRIGGER && (!pendingArduinoThrow || pendingArduinoThrow.applied)) return;
  if (pendingArduinoThrow && Date.now() - pendingArduinoThrow.startedAt > ARDUINO_THROW_WINDOW_MS) return;

  const pending = pendingArduinoThrow;
  clearPendingArduinoThrow();
  normalizeArduinoStatePatch({ pendingThrow: false, lastAutoThrowError: null });

  applyArduinoThrowFromChannel(evt.channel, evt)
    .then((result) => {
      if (pending) pending.applied = result.ok;
      normalizeArduinoStatePatch({ lastAutoThrow: result.ok ? result : { ok: false, reason: result.reason }, lastAutoThrowError: result.ok ? null : result.reason });
    })
    .catch((err) => {
      if (pending) pending.applied = false;
      normalizeArduinoStatePatch({ lastAutoThrow: { ok: false, reason: err.message }, lastAutoThrowError: err.message });
    });
}

function parseArduinoLine(line) {
  const clean = String(line || '').trim();
  if (!clean) return;

  rememberArduinoLine(clean);
  normalizeArduinoStatePatch({ lastLine: clean, error: null });

  const evtMatch = clean.match(/^EVT,(\d+),CH(\d{2}),([A-Z]+)$/i);
  if (evtMatch) {
    const evt = { ms: Number(evtMatch[1]), channel: evtMatch[2], state: evtMatch[3].toUpperCase(), line: clean };
    normalizeArduinoStatePatch({
      lastEvent: { ...evt },
      lastTrigger: evt.state === 'ACTIVE' ? { ...evt, ts: Date.now() } : arduinoState.lastTrigger,
      pendingThrow: arduinoState.pendingThrow
    });

    if (evt.state === 'ACTIVE') handleArduinoActiveEvent(evt);
    else if (evt.state === 'IDLE' && clean.match(/,CH(2[12])$/i)) handleArduinoTrigger(evt);
    return;
  }

  const hbMatch = clean.match(/^HB,(\d+),active=(\d+)$/i);
  if (hbMatch) {
    normalizeArduinoStatePatch({
      activeCount: Number(hbMatch[2]),
      lastHeartbeat: { ms: Number(hbMatch[1]), activeCount: Number(hbMatch[2]), line: clean }
    });
    return;
  }

  const legacyEvent = clean.match(/^CH(\d{2}):\s*(ACTIVE|IDLE)$/i);
  if (legacyEvent) {
    const evt = { ms: null, channel: legacyEvent[1], state: legacyEvent[2].toUpperCase(), line: clean };
    normalizeArduinoStatePatch({
      lastEvent: { ...evt },
      lastTrigger: evt.state === 'ACTIVE' ? { ...evt, ts: Date.now() } : arduinoState.lastTrigger,
      pendingThrow: arduinoState.pendingThrow
    });
    if (evt.state === 'ACTIVE') handleArduinoActiveEvent(evt);
    else if (evt.state === 'IDLE' && clean.match(/^CH(2[12]):/i)) handleArduinoTrigger(evt);
    return;
  }

  const legacyStatus = clean.match(/^STATUS\s+active=(\d+)$/i);
  if (legacyStatus) normalizeArduinoStatePatch({ activeCount: Number(legacyStatus[1]) });
}

function clearArduinoReconnectTimer() {
  if (arduinoReconnectTimer) { clearTimeout(arduinoReconnectTimer); arduinoReconnectTimer = null; }
}

function scheduleArduinoReconnect(delayMs = 4000) {
  if (arduinoReconnectTimer) return;
  arduinoReconnectTimer = setTimeout(() => { arduinoReconnectTimer = null; startArduinoMonitor(); }, delayMs);
}

async function detectArduinoPort(preferredPort) {
  if (preferredPort) return preferredPort;
  if (!SerialPortCtor) return null;

  const fallbackDeviceFromDev = () => {
    try {
      if (!fs.existsSync('/dev')) return null;
      const entries = fs.readdirSync('/dev');
      const devName = entries.find(n => /^tty(ACM|USB)\d+$/i.test(n));
      return devName ? `/dev/${devName}` : null;
    } catch { return null; }
  };

  try {
    const ports = await SerialPortCtor.list();
    const firstKnown = ports.find(p => {
      const pv = (p.path || '').toLowerCase();
      return pv.startsWith('/dev/ttyacm') || pv.startsWith('/dev/ttyusb') || pv.startsWith('com');
    });
    return firstKnown ? firstKnown.path : fallbackDeviceFromDev();
  } catch { return fallbackDeviceFromDev(); }
}

function closeArduinoMonitor() {
  clearArduinoReconnectTimer();
  if (arduinoParser) { arduinoParser.removeAllListeners(); arduinoParser = null; }
  if (arduinoPort) {
    arduinoPort.removeAllListeners();
    try { if (arduinoPort.isOpen) arduinoPort.close(); } catch { }
    arduinoPort = null;
  }
  normalizeArduinoStatePatch({ connected: false });
}

async function startArduinoMonitor() {
  const settings = getSettings();
  const baudRate = Number(settings.arduinoBaudRate || 115200) || 115200;

  if (!settings.arduinoMonitorEnabled) {
    closeArduinoMonitor();
    normalizeArduinoStatePatch({ enabled: false, baudRate, error: 'Arduino-Monitor ist deaktiviert.' });
    return;
  }

  normalizeArduinoStatePatch({ enabled: true, baudRate });

  if (!SerialPortCtor || !ReadlineParserCtor) {
    normalizeArduinoStatePatch({ connected: false, error: 'serialport Modul fehlt. Bitte npm install ausführen.' });
    return;
  }

  if (arduinoPort && arduinoPort.isOpen) return;

  let serialPath = null;
  try { serialPath = await detectArduinoPort(settings.arduinoPort || ''); }
  catch (err) {
    normalizeArduinoStatePatch({ connected: false, error: `Portsuche fehlgeschlagen: ${err.message}` });
    scheduleArduinoReconnect(); return;
  }

  if (!serialPath) {
    normalizeArduinoStatePatch({ connected: false, port: null, error: 'Kein Arduino-Serial-Port gefunden.' });
    return;
  }

  normalizeArduinoStatePatch({ port: serialPath, error: null });

  try {
    const port = new SerialPortCtor({ path: serialPath, baudRate, autoOpen: true });
    const parser = port.pipe(new ReadlineParserCtor({ delimiter: '\n' }));
    arduinoPort = port;
    arduinoParser = parser;

    port.on('open', () => normalizeArduinoStatePatch({ connected: true, port: serialPath, error: null }));
    parser.on('data', (line) => parseArduinoLine(line));
    port.on('error', (err) => normalizeArduinoStatePatch({ connected: false, error: `Serial-Fehler: ${err.message}` }));
    port.on('close', () => {
      if (arduinoPort === port) arduinoPort = null;
      normalizeArduinoStatePatch({ connected: false, error: 'Arduino-Port getrennt.' });
    });
  } catch (err) {
    normalizeArduinoStatePatch({ connected: false, error: `Arduino-Verbindung fehlgeschlagen: ${err.message}` });
    scheduleArduinoReconnect();
  }
}

function restartArduinoMonitor() { closeArduinoMonitor(); startArduinoMonitor(); }

// ──────────────────────────────────────────────
// Spieler / Live-State / Highscores
// ──────────────────────────────────────────────
async function getPlayers() { return dataStore.getPlayers(); }

async function savePlayers(list) {
  await dataStore.savePlayers(list);
  const fresh = await defaultLiveState();
  await dataStore.saveLiveState(fresh);
}

async function getActivePlayersForLive() {
  const players = (await getPlayers()).filter(p => p.active && String(p.name || '').trim());
  return players.map((p, index) => ({
    slot: p.slot, name: String(p.name).trim(),
    color: p.color || ['#e63946','#f4a261','#2a9d8f','#457b9d','#9b5de5','#f77f00'][index % 6]
  }));
}

async function defaultLiveState() {
  const active = await getActivePlayersForLive();
  const fallbackPlayers = active.length > 0
    ? active
    : [{ slot: 1, name: 'Spieler 1', color: '#e63946' }, { slot: 2, name: 'Spieler 2', color: '#f4a261' }];

  return {
    game: { mode: '501', status: 'running', startedAt: Date.now(), updatedAt: Date.now(), activePlayer: 0, throwRound: 1, currentThrow: 0 },
    players: fallbackPlayers.map(p => ({ ...p, remaining: 501, legs: 0, turns: 0, totalScored: 0, bestTurn: 0, average: 0, throws: [], currentRoundPoints: [] })),
    lastAction: null,
    arduino: { connected: false, lastEvent: null, activeCount: 0, heartbeatMs: null }
  };
}

function sanitizePlayerState(player, fallback) {
  const base = fallback || {};
  const name = String(player?.name || base.name || '').trim() || 'Spieler';
  const slot = Number.isFinite(Number(player?.slot)) ? Number(player.slot) : Number(base.slot || 0);
  const legs = Math.max(0, Number(player?.legs || base.legs || 0));
  const turns = Math.max(0, Number(player?.turns || base.turns || 0));
  const totalScored = Math.max(0, Number(player?.totalScored || base.totalScored || 0));
  const bestTurn = Math.max(0, Number(player?.bestTurn || base.bestTurn || 0));
  const remaining = Math.max(0, Number(player?.remaining || base.remaining || 501));
  const color = String(player?.color || base.color || '#e63946');
  const throws = Array.isArray(player?.throws) ? player.throws : [];
  const currentRoundPoints = Array.isArray(player?.currentRoundPoints) ? player.currentRoundPoints : [];
  const average = turns > 0 ? Math.round((totalScored / (turns * 3)) * 100) / 100 : 0;
  return { slot, name, color, remaining, legs, turns, totalScored, bestTurn, throws, currentRoundPoints, average };
}

async function getLiveState() {
  const fallback = await defaultLiveState();
  const saved = await dataStore.getLiveState(fallback);
  const activePlayers = fallback.players;
  const savedPlayers = Array.isArray(saved.players) && saved.players.length > 0 ? saved.players : activePlayers;
  const mergedPlayers = savedPlayers.map((player, index) => sanitizePlayerState(player, activePlayers[index] || activePlayers[0]));

  activePlayers.forEach(player => {
    if (!mergedPlayers.some(p => Number(p.slot) === Number(player.slot)))
      mergedPlayers.push(sanitizePlayerState(player, player));
  });

  mergedPlayers.sort((a, b) => Number(a.slot || 0) - Number(b.slot || 0));

  const state = {
    game: {
      mode: String(saved.game?.mode || fallback.game.mode),
      status: String(saved.game?.status || fallback.game.status),
      startedAt: Number(saved.game?.startedAt || fallback.game.startedAt),
      updatedAt: Number(saved.game?.updatedAt || Date.now()),
      activePlayer: Math.min(Number(saved.game?.activePlayer || 0), mergedPlayers.length - 1),
      throwRound: Number(saved.game?.throwRound || 1),
      currentThrow: Number(saved.game?.currentThrow || 0)
    },
    players: mergedPlayers,
    lastAction: saved.lastAction || null,
    arduino: {
      connected: !!arduinoState.connected,
      lastEvent: arduinoState.lastEvent || null,
      activeCount: Number(arduinoState.activeCount || 0),
      heartbeatMs: arduinoState.lastHeartbeat ? Number(arduinoState.lastHeartbeat.ms || 0) : null,
      rawHistory: arduinoRawEventHistory.slice(0, 20),
      pendingThrow: !!arduinoState.pendingThrow,
      lastTrigger: arduinoState.lastTrigger || null,
      lastAutoThrow: arduinoState.lastAutoThrow || null,
      lastMiss: arduinoState.lastMiss || null,
      lastAutoThrowError: arduinoState.lastAutoThrowError || null,
      dartValueByChannel: DART_VALUE_BY_CHANNEL
    }
  };

  await dataStore.saveLiveState(state);
  return state;
}

async function saveLiveState(state) {
  const safe = { ...state, game: { ...(state.game || {}), updatedAt: Date.now() } };
  await dataStore.saveLiveState(safe);
  return safe;
}

async function getHighscores() { return dataStore.getHighscores(100); }

async function addHighscore(playerName, score, meta = {}) {
  const safeName = String(playerName || '').trim();
  const safeScore = Number(score || 0);
  if (!safeName || !Number.isFinite(safeScore) || safeScore <= 0) return;
  await dataStore.addHighscore({ player: safeName, score: safeScore, ts: Date.now(), legWin: !!meta.legWin, ...meta });
}

// ──────────────────────────────────────────────
// Static Files
// ──────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
  }
}));
app.use(express.json());

// ──────────────────────────────────────────────
// API-Routen
// ──────────────────────────────────────────────

// ── Players ──
app.get('/api/players', async (_req, res) => {
  try { res.json(await getPlayers()); }
  catch (err) { res.status(500).json({ error: 'Spieler konnten nicht geladen werden: ' + err.message }); }
});

app.put('/api/players', async (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Array erwartet' });
  try {
    await savePlayers(req.body);
    broadcastReload();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Spieler konnten nicht gespeichert werden: ' + err.message });
  }
});

// ── Storage-Info ──
app.get('/api/storage/info', (_req, res) => { res.json(dataStore.getInfo()); });

// ── Settings ──
app.get('/api/settings', (_req, res) => res.json(getSettings()));
app.put('/api/settings', (req, res) => {
  const s = { ...getSettings(), ...req.body };
  saveSettings(s);
  restartArduinoMonitor();
  broadcastReload();
  res.json(s);
});

// ── Server-Info ──
app.get('/api/server-info', (_req, res) => {
  res.json({ ip: getLocalIP(), port: PORT, url: 'http://' + getLocalIP() + ':' + PORT });
});

// ── SSE – Live-Push ──
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write('data: connected\n\n');
  sseClients.add(res);
  const ka = setInterval(() => { try { res.write(':ka\n\n'); } catch { clearInterval(ka); sseClients.delete(res); } }, 25000);
  req.on('close', () => { clearInterval(ka); sseClients.delete(res); });
});

// ── Arduino ──
app.get('/api/arduino/state', (_req, res) => { res.json(arduinoState); });

app.post('/api/arduino/connect', (req, res) => {
  const currentSettings = getSettings();
  const requestedPort = typeof req.body?.port === 'string' ? req.body.port.trim() : '';
  saveSettings({ ...currentSettings, arduinoMonitorEnabled: true, arduinoPort: requestedPort });
  restartArduinoMonitor();
  res.json({ ok: true, requestedPort: requestedPort || '', state: arduinoState });
});

app.post('/api/arduino/disconnect', (_req, res) => {
  const currentSettings = getSettings();
  saveSettings({ ...currentSettings, arduinoMonitorEnabled: false });
  closeArduinoMonitor();
  normalizeArduinoStatePatch({ enabled: false, error: 'Arduino-Monitor deaktiviert.' });
  res.json({ ok: true, state: arduinoState });
});

app.get('/api/arduino/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write('event: state\ndata: ' + JSON.stringify(arduinoState) + '\n\n');
  arduinoSseClients.add(res);
  const ka = setInterval(() => { try { res.write(':ka\n\n'); } catch { clearInterval(ka); arduinoSseClients.delete(res); } }, 25000);
  req.on('close', () => { clearInterval(ka); arduinoSseClients.delete(res); });
});

app.post('/api/arduino/command', (req, res) => {
  const command = String((req.body && req.body.command) || '').trim();
  if (!command) return res.status(400).json({ ok: false, error: 'command fehlt.' });
  if (!arduinoPort || !arduinoPort.isOpen) return res.status(409).json({ ok: false, error: 'Arduino nicht verbunden.' });
  arduinoPort.write(command + '\n', (err) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    res.json({ ok: true });
  });
});

app.get('/api/arduino/raw', (_req, res) => {
  res.json({ connected: !!arduinoState.connected, port: arduinoState.port, history: arduinoRawEventHistory.slice(0, 50) });
});

// ── Live-State ──
app.get('/api/live/state', async (_req, res) => {
  try { res.json(await getLiveState()); }
  catch (err) { res.status(500).json({ error: 'Live-State konnte nicht geladen werden: ' + err.message }); }
});

app.post('/api/live/reset', async (req, res) => {
  const carryLegs = !!(req.body && req.body.carryLegs);
  try {
    const prev = await getLiveState();
    const fresh = await defaultLiveState();
    if (carryLegs) {
      fresh.players.forEach((player, index) => {
        if (prev.players[index]) player.legs = prev.players[index].legs;
      });
    }
    res.json(await saveLiveState(fresh));
  } catch (err) { res.status(500).json({ error: 'Live-Reset fehlgeschlagen: ' + err.message }); }
});

app.post('/api/live/throw', async (req, res) => {
  const playerSlot = Number(req.body && req.body.playerSlot);
  const playerIndex = Number(req.body && req.body.playerIndex);
  const points = Number(req.body && req.body.points);

  let targetIndex = -1;
  if (Number.isInteger(playerSlot) && playerSlot > 0) targetIndex = playerSlot - 1;
  else if (Number.isInteger(playerIndex) && playerIndex >= 0) targetIndex = playerIndex;

  if (targetIndex < 0) return res.status(400).json({ error: 'playerSlot oder playerIndex erforderlich.' });
  if (!Number.isFinite(points) || points < 0 || points > 180) return res.status(400).json({ error: 'points muss zwischen 0 und 180 liegen.' });

  try {
    const state = await getLiveState();
    if (targetIndex >= state.players.length) return res.status(400).json({ error: 'Spieler nicht gefunden.' });

    const player = state.players[targetIndex];
    const nextRemaining = player.remaining - points;
    const bust = nextRemaining < 0;

    player.turns += 1;
    player.bestTurn = Math.max(player.bestTurn, points);
    if (!bust) { player.remaining = nextRemaining; player.totalScored += points; }

    if (!Array.isArray(player.currentRoundPoints)) player.currentRoundPoints = [];
    player.currentRoundPoints.push(points);

    if (!Array.isArray(player.throws)) player.throws = [];
    player.throws.push({ points, remaining: player.remaining, bust, ts: Date.now() });

    player.average = player.turns > 0 ? Math.round((player.totalScored / (player.turns * 3)) * 100) / 100 : 0;
    state.game.currentThrow = (state.game.currentThrow || 0) + 1;

    state.lastAction = {
      type: 'throw', playerIndex: targetIndex, playerSlot: player.slot, player: player.name,
      points, bust, remaining: player.remaining, roundThrow: state.game.currentThrow, ts: Date.now()
    };

    if (player.remaining === 0) {
      player.legs += 1;
      await addHighscore(player.name, points, { kind: 'checkout', legWin: true });
      state.game.status = 'leg-finished';
    }

    if (state.game.status !== 'leg-finished' && state.game.currentThrow >= 3) {
      state.game.activePlayer = (state.game.activePlayer + 1) % state.players.length;
      state.game.currentThrow = 0;
      state.game.throwRound = (state.game.throwRound || 1) + 1;
      state.lastAction.autoAdvanced = true;
      state.lastAction.nextPlayer = state.players[state.game.activePlayer].name;
      state.lastAction.nextPlayerSlot = state.players[state.game.activePlayer].slot;
    }

    const saved = await saveLiveState(state);
    broadcastReload();
    res.json(saved);
  } catch (err) { res.status(500).json({ error: 'Wurf konnte nicht gespeichert werden: ' + err.message }); }
});

app.post('/api/live/next-player', async (req, res) => {
  try {
    const state = await getLiveState();
    const currentPlayer = state.players[state.game.activePlayer];
    if (currentPlayer && Array.isArray(currentPlayer.currentRoundPoints)) {
      while (currentPlayer.currentRoundPoints.length < 3) {
        currentPlayer.currentRoundPoints.push(0);
        currentPlayer.turns += 1;
      }
    }
    const nextIndex = (state.game.activePlayer + 1) % state.players.length;
    state.game.activePlayer = nextIndex;
    state.game.currentThrow = 0;
    state.game.throwRound = (state.game.throwRound || 1) + 1;
    state.lastAction = { type: 'next-player', player: state.players[nextIndex].name, playerSlot: state.players[nextIndex].slot, ts: Date.now() };
    const saved = await saveLiveState(state);
    broadcastReload();
    res.json(saved);
  } catch (err) { res.status(500).json({ error: 'Next-Player fehlgeschlagen: ' + err.message }); }
});

app.post('/api/live/undo', async (req, res) => {
  try {
    const state = await getLiveState();
    let lastThrowTime = 0, lastThrowPlayer = -1;

    state.players.forEach((player, idx) => {
      if (Array.isArray(player.throws) && player.throws.length > 0) {
        const lastT = player.throws[player.throws.length - 1];
        if (lastT.ts > lastThrowTime) { lastThrowTime = lastT.ts; lastThrowPlayer = idx; }
      }
    });

    if (lastThrowPlayer === -1) return res.status(400).json({ error: 'Kein Wurf zum Rückgängigmachen vorhanden.' });

    const player = state.players[lastThrowPlayer];
    const lastThrow = player.throws.pop();
    const roundIndex = player.currentRoundPoints ? player.currentRoundPoints.length - 1 : -1;

    if (!lastThrow.bust) { player.remaining += lastThrow.points; player.totalScored -= lastThrow.points; }
    player.turns = Math.max(0, player.turns - 1);
    player.average = player.turns > 0 ? Math.round((player.totalScored / (player.turns * 3)) * 100) / 100 : 0;

    if (roundIndex >= 0 && player.currentRoundPoints) player.currentRoundPoints.pop();

    state.game.currentThrow = Math.max(0, (state.game.currentThrow || 1) - 1);
    state.game.activePlayer = lastThrowPlayer;
    state.lastAction = { type: 'undo', player: player.name, points: lastThrow.points, ts: Date.now() };

    const saved = await saveLiveState(state);
    broadcastReload();
    res.json(saved);
  } catch (err) { res.status(500).json({ error: 'Undo fehlgeschlagen: ' + err.message }); }
});

// ── Highscores ──
app.get('/api/highscores', async (_req, res) => {
  try { res.json(await getHighscores()); }
  catch (err) { res.status(500).json({ error: 'Highscores konnten nicht geladen werden: ' + err.message }); }
});

app.post('/api/highscores', async (req, res) => {
  const player = String(req.body && req.body.player || '').trim();
  const score = Number(req.body && req.body.score);
  if (!player || !Number.isFinite(score) || score <= 0) return res.status(400).json({ error: 'player und positive score erforderlich.' });
  try {
    await addHighscore(player, score, { kind: 'manual' });
    res.json({ ok: true, highscores: await getHighscores() });
  } catch (err) { res.status(500).json({ error: 'Highscore konnte nicht gespeichert werden: ' + err.message }); }
});

// ──────────────────────────────────────────────
// Server-Start
// ──────────────────────────────────────────────
async function startServer() {
  await dataStore.init({
    playersFile: PLAYERS_FILE,
    liveStateFile: LIVE_STATE_FILE,
    highscoresFile: HIGHSCORES_FILE
  });

  const storageInfo = dataStore.getInfo();
  console.log('[Storage] client=' + storageInfo.client + ' external=' + storageInfo.external);
  if (storageInfo.sqliteFile) console.log('[Storage] sqlite=' + storageInfo.sqliteFile);

  app.listen(PORT, () => {
    console.log('Dashboard: http://localhost:' + PORT);
    startArduinoMonitor();
  });
}

startServer().catch((err) => {
  console.error('[Start] Fehlgeschlagen:', err.message);
  process.exit(1);
});
