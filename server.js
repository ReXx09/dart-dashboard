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

// Vorläufige 4x16-Matrix-Tabelle für passives Sniffing.
// Mapping: R0..R3 = Rows, C0..C15 = Columns.
// Werte entsprechen aktuell der Tabelle aus dart_matrix_test.ino und können auf dem Pi angepasst werden.
const MATRIX_CODE_BY_ROW_COLUMN = {
  'R0,C0': 212, 'R0,C1': 112, 'R0,C2': 209, 'R0,C3': 109,
  'R0,C4': 214, 'R0,C5': 114, 'R0,C6': 211, 'R0,C7': 111,
  'R0,C8': 208, 'R0,C9': 108, 'R0,C10': 0,   'R0,C11': 312,
  'R0,C12': 309, 'R0,C13': 314, 'R0,C14': 311, 'R0,C15': 308,
  'R1,C0': 216, 'R1,C1': 116, 'R1,C2': 207, 'R1,C3': 107,
  'R1,C4': 219, 'R1,C5': 119, 'R1,C6': 203, 'R1,C7': 103,
  'R1,C8': 217, 'R1,C9': 117, 'R1,C10': 225, 'R1,C11': 316,
  'R1,C12': 307, 'R1,C13': 319, 'R1,C14': 303, 'R1,C15': 317,
  'R2,C0': 202, 'R2,C1': 102, 'R2,C2': 215, 'R2,C3': 115,
  'R2,C4': 210, 'R2,C5': 110, 'R2,C6': 206, 'R2,C7': 106,
  'R2,C8': 213, 'R2,C9': 113, 'R2,C10': 125, 'R2,C11': 302,
  'R2,C12': 315, 'R2,C13': 310, 'R2,C14': 306, 'R2,C15': 313,
  'R3,C0': 204, 'R3,C1': 104, 'R3,C2': 218, 'R3,C3': 118,
  'R3,C4': 201, 'R3,C5': 101, 'R3,C6': 220, 'R3,C7': 120,
  'R3,C8': 205, 'R3,C9': 105, 'R3,C10': 0,   'R3,C11': 304,
  'R3,C12': 318, 'R3,C13': 301, 'R3,C14': 320, 'R3,C15': 305
};
const MATRIX_ROW_COLUMN_VALUES = Object.fromEntries(
  Object.entries(MATRIX_CODE_BY_ROW_COLUMN).map(([key, code]) => [key, { code, points: codeToPoints(code) }])
);

const ARDUINO_AUTO_THROW_ENABLED = process.env.ARDUINO_AUTO_THROW_ENABLED !== 'false';
const ARDUINO_AUTO_THROW_MATRIX_ENABLED = process.env.ARDUINO_AUTO_THROW_MATRIX_ENABLED === 'true';
const ARDUINO_AUTO_THROW_MATRIX_UNMAPPED = process.env.ARDUINO_AUTO_THROW_MATRIX_UNMAPPED === 'true';
const ARDUINO_REQUIRE_THROW_TRIGGER = process.env.ARDUINO_REQUIRE_THROW_TRIGGER !== 'false';
const ARDUINO_EVENT_ACTIVE_STATE_MODE_RAW = String(process.env.ARDUINO_EVENT_ACTIVE_STATE || 'AUTO').trim().toUpperCase();
const ARDUINO_EVENT_ACTIVE_STATE_MODE = ['ACTIVE', 'IDLE', 'AUTO'].includes(ARDUINO_EVENT_ACTIVE_STATE_MODE_RAW)
  ? ARDUINO_EVENT_ACTIVE_STATE_MODE_RAW
  : 'AUTO';
const ARDUINO_THROW_WINDOW_MS = Number(process.env.ARDUINO_THROW_WINDOW_MS || 1200);
const MATRIX_HIT_RELEASE_MS = Number(process.env.MATRIX_HIT_RELEASE_MS || 25);
const MATRIX_HIT_REFRACTORY_MS = Number(process.env.MATRIX_HIT_REFRACTORY_MS || 350);

// ── Spielmodi ──────────────────────────────────
const GAME_MODES = {
  '501':   { label: '501',   type: 'x01',  startScore: 501,  cricketNumbers: null,   description: '501 Double Out' },
  '301':   { label: '301',   type: 'x01',  startScore: 301,  cricketNumbers: null,   description: '301 Double Out' },
  '701':   { label: '701',   type: 'x01',  startScore: 701,  cricketNumbers: null,   description: '701 Double Out' },
  'cricket': { label: 'Cricket', type: 'cricket', startScore: 0, cricketNumbers: [15,16,17,18,19,20,25], description: 'Cricket – Zahlen schließen' },
  'shanghai': { label: 'Shanghai', type: 'shanghai', startScore: 0, cricketNumbers: null, description: 'Shanghai – 1-9 S/D/T' },
  'atc':    { label: 'Around the Clock', type: 'atc', startScore: 0, cricketNumbers: null, description: 'Around the Clock – 1-20 + Bull' },
  'split':  { label: 'Split', type: 'split', startScore: 0, cricketNumbers: null, description: 'Split Score' }
};

const DEFAULT_MODE = '501';

function getStartScoreForMode(mode) {
  const def = GAME_MODES[mode];
  return def ? def.startScore : 501;
}

function getCricketNumbersForMode(mode) {
  const def = GAME_MODES[mode];
  return def && def.type === 'cricket' ? [...def.cricketNumbers] : null;
}

function defaultPlayerCricketState(mode) {
  const nums = getCricketNumbersForMode(mode);
  if (!nums) return {};
  const hits = {};
  nums.forEach(n => { hits[n] = 0; });
  return { cricketHits: hits, cricketClosed: {} };
}

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
let arduinoResolvedActiveState = ARDUINO_EVENT_ACTIVE_STATE_MODE === 'AUTO' ? 'ACTIVE' : ARDUINO_EVENT_ACTIVE_STATE_MODE;
let pendingArduinoThrow = null;
let pendingArduinoThrowTimer = null;
let arduinoThrowLockUntil = 0;
let arduinoProcessingPromise = Promise.resolve();
const arduinoRawEventHistory = [];
const matrixSniffer = {
  activeRows: {},
  activeColumns: {},
  lastMatrixHit: null,
  matrixHitActive: false,
  lastMatrixHitMs: 0,
  lastMatrixHitPairMs: 0,
  lastMatrixHitRow: null,
  lastMatrixHitColumn: null
};
const channelAutoDetect = {
  startedAtMs: null,
  lastHeartbeatMs: null,
  heartbeatCount: 0,
  edgeCounts: {},
  rows: [],
  columns: [],
  status: 'waiting',
  lastUpdatedMs: null
};
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
  matrixSniffer: null,
  activeCount: null,
  lastUpdateMs: null,
  rawHistory: [],
  error: null,
  channelAutoDetect: null,
  activeStateMode: ARDUINO_EVENT_ACTIVE_STATE_MODE,
  activeStateResolved: arduinoResolvedActiveState
};

function isArduinoActiveState(state) {
  const normalized = String(state || '').trim().toUpperCase();
  return normalized === arduinoResolvedActiveState;
}

function maybeInferArduinoActiveState(activeCount, totalSignals = 20) {
  if (ARDUINO_EVENT_ACTIVE_STATE_MODE !== 'AUTO') return;
  const active = Number(activeCount);
  const total = Number(totalSignals);
  if (!Number.isFinite(active) || !Number.isFinite(total) || total <= 0) return;

  // Wenn im Heartbeat die Mehrheit als ACTIVE gemeldet wird, ist das meist der Ruhepegel.
  // Dann ist fuer Treffer-Impulse die Gegenphase (IDLE) die interessantere Aktivphase.
  const inferred = active > (total / 2) ? 'IDLE' : 'ACTIVE';
  if (inferred === arduinoResolvedActiveState) return;

  arduinoResolvedActiveState = inferred;
  normalizeArduinoStatePatch({
    activeStateMode: ARDUINO_EVENT_ACTIVE_STATE_MODE,
    activeStateResolved: arduinoResolvedActiveState
  });
}

function broadcastArduinoState() {
  const payload = JSON.stringify(buildArduinoStateView());
  arduinoSseClients.forEach((res) => {
    try { res.write(`event: state\ndata: ${payload}\n\n`); }
    catch { arduinoSseClients.delete(res); }
  });
}

function normalizeArduinoStatePatch(patch) {
  Object.assign(arduinoState, patch, { lastUpdateMs: Date.now() });
  broadcastArduinoState();
}

function summarizeMatrixHit(hit) {
  if (!hit) return null;

  const row = hit.row != null ? String(hit.row) : null;
  const column = hit.column != null ? String(hit.column) : null;
  const key = hit.key || (row && column ? `${row},${column}` : null);
  const code = Number(hit.code);
  const points = Number(hit.points);
  const ms = Number(hit.ms);
  const ts = Number(hit.ts);

  return {
    row,
    column,
    key,
    code: Number.isFinite(code) ? code : null,
    points: Number.isFinite(points) ? points : null,
    mapped: !!hit.mapped,
    ms: Number.isFinite(ms) ? ms : null,
    ts: Number.isFinite(ts) ? ts : null,
    line: String(hit.line || ''),
    source: String(hit.source || 'arduino-matrix'),
    label: row && column ? `${row}/${column}` : row || column || '-'
  };
}

function buildArduinoStateView() {
  const matrixSnifferView = arduinoState.matrixSniffer ? { ...arduinoState.matrixSniffer } : null;
  const matrixHit = summarizeMatrixHit(matrixSniffer.lastMatrixHit);
  const autoThrowHit = summarizeMatrixHit(arduinoState.lastAutoThrow && arduinoState.lastAutoThrow.hit ? arduinoState.lastAutoThrow.hit : null);
  const normalizedHit = autoThrowHit || matrixHit;
  const normalizedHitPoints = normalizedHit && Number.isFinite(Number(normalizedHit.points))
    ? Number(normalizedHit.points)
    : null;
  const normalizedHitCode = normalizedHit && Number.isFinite(Number(normalizedHit.code))
    ? Number(normalizedHit.code)
    : null;

  const connection = {
    connected: !!arduinoState.connected,
    enabled: !!arduinoState.enabled,
    port: arduinoState.port || null,
    baudRate: Number(arduinoState.baudRate || 115200),
    error: arduinoState.error || null
  };

  const latest = {
    event: arduinoState.lastEvent ? { ...arduinoState.lastEvent } : null,
    heartbeat: arduinoState.lastHeartbeat ? { ...arduinoState.lastHeartbeat } : null,
    trigger: arduinoState.lastTrigger ? { ...arduinoState.lastTrigger } : null,
    line: arduinoState.lastLine || '',
    hit: normalizedHit
  };

  const matrix = {
    sniffer: matrixSnifferView,
    hit: normalizedHit,
    label: normalizedHit ? normalizedHit.label : null,
    code: normalizedHitCode,
    points: normalizedHitPoints
  };

  const automation = {
    pendingThrow: !!arduinoState.pendingThrow,
    lastAutoThrow: arduinoState.lastAutoThrow || null,
    lastMiss: arduinoState.lastMiss || null,
    lastAutoThrowError: arduinoState.lastAutoThrowError || null,
    channelAutoDetect: arduinoState.channelAutoDetect || null
  };

  const telemetry = {
    activeCount: Number(arduinoState.activeCount || 0),
    activeStateMode: arduinoState.activeStateMode,
    activeStateResolved: arduinoState.activeStateResolved,
    rawHistory: arduinoRawEventHistory.slice(0, 20),
    lastUpdateMs: Number(arduinoState.lastUpdateMs || 0) || null
  };

  const lookups = {
    dartValueByChannel: DART_VALUE_BY_CHANNEL,
    matrixCodeByRowColumn: MATRIX_CODE_BY_ROW_COLUMN
  };

  const api = {
    apiVersion: 2,
    connection,
    latest,
    matrix,
    automation,
    telemetry,
    lookups
  };

  return api;
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

function roundAverage(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function calculateCurrentRoundAverage(player) {
  const currentRoundPoints = Array.isArray(player?.currentRoundPoints) ? player.currentRoundPoints : [];
  if (currentRoundPoints.length === 0) return 0;
  const sum = currentRoundPoints.reduce((total, points) => total + (Number(points) || 0), 0);
  return roundAverage(sum / 3);
}

function dartValueFromChannel(channel) {
  const key = formatChannel(channel);
  return Object.prototype.hasOwnProperty.call(DART_VALUE_BY_CHANNEL, key) ? DART_VALUE_BY_CHANNEL[key] : null;
}

function codeToPoints(code) {
  if (code <= 0) return 0;
  if (code == 125) return 25;
  if (code == 225) return 50;

  const base = code % 100;
  const multiplier = code / 100;

  if (base == 0) return 0;
  if (multiplier == 1) return base;
  if (multiplier == 2) return base * 2;
  if (multiplier == 3) return base * 3;

  return 0;
}

function clearPendingArduinoThrow() {
  if (pendingArduinoThrowTimer) clearTimeout(pendingArduinoThrowTimer);
  pendingArduinoThrowTimer = null;
  pendingArduinoThrow = null;
}

async function advanceAfterThreeThrows(state, player, source) {
  if (state.game.status === 'leg-finished' || state.game.currentThrow < 3) return;

  player.currentRoundPoints = [];
  state.game.activePlayer = (state.game.activePlayer + 1) % state.players.length;
  state.game.currentThrow = 0;
  if (state.game.activePlayer === 0) {
    state.game.throwRound = (Number(state.game.throwRound || 1) || 1) + 1;
  }
  state.lastAction.autoAdvanced = true;
  state.lastAction.nextPlayer = state.players[state.game.activePlayer].name;
  state.lastAction.nextPlayerSlot = state.players[state.game.activePlayer].slot;
  state.lastAction.nextSource = source;
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

  const mode = state.game.mode || DEFAULT_MODE;
  const modeDef = GAME_MODES[mode] || GAME_MODES[DEFAULT_MODE];
  const isCricket = modeDef.type === 'cricket';

  let bust = false;
  if (isCricket) {
    player.totalScored = Math.max(0, Number(player.totalScored || 0)) + value;
    const nums = getCricketNumbersForMode(mode);
    if (nums && nums.includes(value)) {
      if (!player.cricketHits) player.cricketHits = {};
      if (!player.cricketClosed) player.cricketClosed = {};
      player.cricketHits[value] = Math.min(3, (player.cricketHits[value] || 0) + 1);
      if (player.cricketHits[value] >= 3) player.cricketClosed[value] = true;
    }
  } else {
    const nextRemaining = player.remaining - value;
    bust = nextRemaining < 0;
    if (!bust) {
      player.remaining = nextRemaining;
      player.totalScored = Math.max(0, Number(player.totalScored || 0)) + value;
    }
  }

  player.turns = Math.max(0, Number(player.turns || 0)) + 1;
  player.bestTurn = Math.max(Number(player.bestTurn || 0), value);

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

  player.average = calculateCurrentRoundAverage(player);
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
    ts: Date.now(),
    mode
  };

  if (!isCricket && player.remaining === 0) {
    player.legs = Math.max(0, Number(player.legs || 0)) + 1;
    await addHighscore(player.name, value, { kind: 'checkout', legWin: true, source: 'arduino' });
    state.game.status = 'leg-finished';
    state.lastAction.legWin = true;
  }

  if (state.game.status !== 'leg-finished' && state.game.currentThrow >= 3) {
    await advanceAfterThreeThrows(state, player, 'arduino');
  }

  await addTurnScoreHighscoreIfNeeded(player, state, 'arduino');

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

  player.average = calculateCurrentRoundAverage(player);
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
    await advanceAfterThreeThrows(state, player, 'arduino-miss');
  }

  await addTurnScoreHighscoreIfNeeded(player, state, 'arduino-miss');

  const saved = await saveLiveState(state);
  broadcastReload();
  return { ok: true, reason, player: player.name, playerSlot: player.slot, remaining: player.remaining, state: saved };
}

function updateMatrixSnifferState(row, column, active, evt = {}) {
  if (row != null) matrixSniffer.activeRows[row] = !!active;
  if (column != null) matrixSniffer.activeColumns[column] = !!active;

  Object.keys(matrixSniffer.activeRows).forEach((key) => {
    if (!matrixSniffer.activeRows[key]) delete matrixSniffer.activeRows[key];
  });
  Object.keys(matrixSniffer.activeColumns).forEach((key) => {
    if (!matrixSniffer.activeColumns[key]) delete matrixSniffer.activeColumns[key];
  });

  const activeRowKeys = Object.keys(matrixSniffer.activeRows).sort((a, b) => Number(a) - Number(b));
  const activeColumnKeys = Object.keys(matrixSniffer.activeColumns).sort((a, b) => Number(a) - Number(b));
  const ms = Number(evt.ms || 0);
  const now = Date.now();

  if (activeRowKeys.length > 0 && activeColumnKeys.length > 0) {
    const row = activeRowKeys[0];
    const column = activeColumnKeys[0];
    const key = `R${row},C${column}`;
    const mapped = MATRIX_ROW_COLUMN_VALUES[key];
    const code = mapped ? mapped.code : null;
    const points = mapped ? mapped.points : 0;

    if (!matrixSniffer.matrixHitActive || matrixSniffer.lastMatrixHitRow !== row || matrixSniffer.lastMatrixHitColumn !== column) {
      matrixSniffer.matrixHitActive = true;
      matrixSniffer.lastMatrixHitRow = row;
      matrixSniffer.lastMatrixHitColumn = column;
      matrixSniffer.lastMatrixHitPairMs = ms;

      if (now - matrixSniffer.lastMatrixHitMs >= MATRIX_HIT_REFRACTORY_MS) {
        matrixSniffer.lastMatrixHitMs = now;
        const hit = { row: `R${row}`, column: `C${column}`, key, code, points, ms, ts: now, line: evt.line || '', mapped: !!mapped };
        matrixSniffer.lastMatrixHit = hit;
        normalizeArduinoStatePatch({ matrixSniffer: { ...matrixSniffer, lastMatrixHit: hit } });

        if (ARDUINO_AUTO_THROW_MATRIX_ENABLED && (mapped || ARDUINO_AUTO_THROW_MATRIX_UNMAPPED)) {
          handleArduinoMatrixHit(hit);
        }
      }
    }
    return;
  }

  if (matrixSniffer.matrixHitActive && ms - matrixSniffer.lastMatrixHitPairMs >= MATRIX_HIT_RELEASE_MS) {
    matrixSniffer.matrixHitActive = false;
    matrixSniffer.lastMatrixHitRow = null;
    matrixSniffer.lastMatrixHitColumn = null;
    normalizeArduinoStatePatch({ matrixSniffer: { ...matrixSniffer, lastMatrixHit: matrixSniffer.lastMatrixHit } });
  }
}

function handleArduinoMatrixHit(hit) {
  if (pendingArduinoThrow && !pendingArduinoThrow.applied) return;
  if (Date.now() < arduinoThrowLockUntil) return;

  arduinoProcessingPromise = arduinoProcessingPromise
    .catch(() => {})
    .then(() => applyArduinoThrowFromMatrix(hit))
    .then((result) => normalizeArduinoStatePatch({ lastAutoThrow: result.ok ? result : { ok: false, reason: result.reason }, lastAutoThrowError: result.ok ? null : result.reason }))
    .catch((err) => normalizeArduinoStatePatch({ lastAutoThrow: { ok: false, reason: err.message }, lastAutoThrowError: err.message }));
}

function resetChannelAutoDetect() {
  channelAutoDetect.startedAtMs = Date.now();
  channelAutoDetect.lastHeartbeatMs = null;
  channelAutoDetect.heartbeatCount = 0;
  channelAutoDetect.edgeCounts = {};
  channelAutoDetect.rows = [];
  channelAutoDetect.columns = [];
  channelAutoDetect.status = 'waiting';
  channelAutoDetect.lastUpdatedMs = null;
  normalizeArduinoStatePatch({ channelAutoDetect: { ...channelAutoDetect } });
}

function runChannelAutoDetect() {
  if (!channelAutoDetect.startedAtMs) return;
  if (!channelAutoDetect.heartbeatCount) return;

  const elapsedMs = Date.now() - channelAutoDetect.startedAtMs;
  const sorted = Object.entries(channelAutoDetect.edgeCounts)
    .map(([channel, edges]) => ({ channel, edges: Number(edges) || 0 }))
    .sort((a, b) => b.edges - a.edges || a.channel.localeCompare(b.channel));

  channelAutoDetect.rows = sorted.slice(0, 4).map((item) => item.channel);
  channelAutoDetect.columns = sorted.slice(4).map((item) => item.channel);
  channelAutoDetect.status = elapsedMs >= 5000 ? 'ready' : 'collecting';
  channelAutoDetect.lastUpdatedMs = Date.now();

  normalizeArduinoStatePatch({ channelAutoDetect: { ...channelAutoDetect } });
}

function handleChannelActiveEvent(evt) {
  if (!channelAutoDetect.startedAtMs) resetChannelAutoDetect();
  if (!channelAutoDetect.edgeCounts[evt.channel]) channelAutoDetect.edgeCounts[evt.channel] = 0;
  channelAutoDetect.edgeCounts[evt.channel]++;
  channelAutoDetect.lastUpdatedMs = Date.now();
  runChannelAutoDetect();
}

async function applyArduinoThrowFromMatrix(hit) {
  const value = Number(hit.points || 0);
  if (!Number.isFinite(value) || value < 0 || value > 180) return { ok: false, reason: 'invalid-points', hit };

  const state = await getLiveState();
  if (!Array.isArray(state.players) || state.players.length === 0) return { ok: false, reason: 'no-players' };
  if (state.game.status === 'leg-finished') return { ok: false, reason: 'leg-finished' };

  const targetIndex = Number.isInteger(state.game.activePlayer) ? state.game.activePlayer : 0;
  const player = state.players[targetIndex];
  if (!player) return { ok: false, reason: 'no-active-player' };

  const mode = state.game.mode || DEFAULT_MODE;
  const modeDef = GAME_MODES[mode] || GAME_MODES[DEFAULT_MODE];
  const isCricket = modeDef.type === 'cricket';

  let bust = false;
  if (isCricket) {
    player.totalScored = Math.max(0, Number(player.totalScored || 0)) + value;
    const nums = getCricketNumbersForMode(mode);
    if (nums && nums.includes(value)) {
      if (!player.cricketHits) player.cricketHits = {};
      if (!player.cricketClosed) player.cricketClosed = {};
      player.cricketHits[value] = Math.min(3, (player.cricketHits[value] || 0) + 1);
      if (player.cricketHits[value] >= 3) player.cricketClosed[value] = true;
    }
  } else {
    const nextRemaining = player.remaining - value;
    bust = nextRemaining < 0;
    if (!bust) {
      player.remaining = nextRemaining;
      player.totalScored = Math.max(0, Number(player.totalScored || 0)) + value;
    }
  }

  player.turns = Math.max(0, Number(player.turns || 0)) + 1;
  player.bestTurn = Math.max(Number(player.bestTurn || 0), value);

  if (!Array.isArray(player.currentRoundPoints)) player.currentRoundPoints = [];
  player.currentRoundPoints.push(value);

  if (!Array.isArray(player.throws)) player.throws = [];
  player.throws.push({
    points: value,
    remaining: player.remaining,
    bust,
    ts: Date.now(),
    source: 'arduino-matrix',
    row: hit.row,
    column: hit.column,
    code: hit.code,
    channel: hit.key,
    raw: hit.line || null
  });

  player.average = calculateCurrentRoundAverage(player);
  state.game.currentThrow = (Number(state.game.currentThrow || 0) || 0) + 1;

  state.lastAction = {
    type: 'throw',
    source: 'arduino-matrix',
    playerIndex: targetIndex,
    playerSlot: player.slot,
    player: player.name,
    points: value,
    row: hit.row,
    column: hit.column,
    code: hit.code,
    channel: hit.key,
    bust,
    remaining: player.remaining,
    roundThrow: state.game.currentThrow,
    ts: Date.now(),
    mode
  };

  if (!isCricket && player.remaining === 0) {
    player.legs = Math.max(0, Number(player.legs || 0)) + 1;
    await addHighscore(player.name, value, { kind: 'checkout', legWin: true, source: 'arduino-matrix' });
    state.game.status = 'leg-finished';
    state.lastAction.legWin = true;
  }

  if (state.game.status !== 'leg-finished' && state.game.currentThrow >= 3) {
    await advanceAfterThreeThrows(state, player, 'arduino-matrix');
  }

  await addTurnScoreHighscoreIfNeeded(player, state, 'arduino-matrix');

  const saved = await saveLiveState(state);
  broadcastReload();
  return { ok: true, value, player: player.name, playerSlot: player.slot, hit, bust, remaining: player.remaining, state: saved };
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

    arduinoProcessingPromise = arduinoProcessingPromise
      .catch(() => {})
      .then(() => applyArduinoMiss({ line: pending.line || '', ms: pending.triggerMs }, 'timeout'))
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

  arduinoProcessingPromise = arduinoProcessingPromise
    .catch(() => {})
    .then(() => applyArduinoThrowFromChannel(evt.channel, evt))
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

  // DIAG-Parsing
  const diagMatch = clean.match(/^DIAG,(\d+),ch=(CH\d+),edges=(\d+)$/i);
  if (diagMatch) {
    normalizeArduinoStatePatch({
      lastDiag: { ms: Number(diagMatch[1]), channel: diagMatch[2], edges: Number(diagMatch[3]), line: clean }
    });
    return;
  }

  // EVT,<ms>,CH00..CH19,ACTIVE|IDLE  (neuer 20CH-Sniffer)
  // Auch CH01..CH22 (alter Sniffer) wird hier erkannt.
  const evtMatch = clean.match(/^EVT,(\d+),CH(\d+),([A-Z]+)$/i);
  if (evtMatch) {
    const ch = Number(evtMatch[2]);
    const chStr = String(ch).padStart(2, '0');
    const state = evtMatch[3].toUpperCase();
    const evt = { ms: Number(evtMatch[1]), channel: chStr, state, line: clean };
    const isActiveEvent = isArduinoActiveState(evt.state);
    normalizeArduinoStatePatch({
      lastEvent: { ...evt },
      lastTrigger: isActiveEvent ? { ...evt, ts: Date.now() } : arduinoState.lastTrigger,
      pendingThrow: arduinoState.pendingThrow
    });

    // Bei aktiver Phase: Auto-Detect zählt mit + fuehrt ggf. Throw aus.
    if (isActiveEvent) {
      if (typeof handleChannelActiveEvent === 'function') handleChannelActiveEvent(evt);
      handleArduinoActiveEvent(evt);
    } else if (ch === 21 || ch === 22) {
      // CH21/CH22 in Gegenphase = Trigger (alte Bull-Logik, aber polaritaetsrobust)
      handleArduinoTrigger(evt);
    }
    return;
  }

  // EVT,<ms>,R#,ACTIVE|IDLE (alter R/C-Sniffer, falls noch verwendet)
  const matrixEvtMatch = clean.match(/^EVT,(\d+),([RC])(\d+),(ACTIVE|IDLE)$/i);
  if (matrixEvtMatch) {
    const kind = matrixEvtMatch[2].toUpperCase();
    const index = Number(matrixEvtMatch[3]);
    const state = matrixEvtMatch[4].toUpperCase();
    const active = isArduinoActiveState(state);
    const evt = { ms: Number(matrixEvtMatch[1]), kind, index, state: matrixEvtMatch[4].toUpperCase(), line: clean };
    normalizeArduinoStatePatch({
      lastEvent: { ...evt },
      lastTrigger: active ? { ...evt, ts: Date.now() } : arduinoState.lastTrigger,
      matrixSniffer: { ...matrixSniffer, lastMatrixHit: matrixSniffer.lastMatrixHit }
    });
    updateMatrixSnifferState(kind === 'R' ? index : null, kind === 'C' ? index : null, active, evt);
    return;
  }

  // HIT/MATRIX,<ms>,R#,C#,CODE,POINTS (passiver Matrix-Sniffer)
  const hitMatch = clean.match(/^(?:HIT|MATRIX),(\d+),R(\d+),C(\d+),(-?\d+),(-?\d+)$/i);
  if (hitMatch) {
    const hit = {
      ms: Number(hitMatch[1]),
      row: `R${Number(hitMatch[2])}`,
      column: `C${Number(hitMatch[3])}`,
      key: `R${Number(hitMatch[2])},C${Number(hitMatch[3])}`,
      code: Number(hitMatch[4]),
      points: Number(hitMatch[5]),
      ts: Date.now(),
      line: clean,
      mapped: true
    };
    matrixSniffer.lastMatrixHit = hit;
    matrixSniffer.lastMatrixHitMs = Date.now();
    normalizeArduinoStatePatch({ matrixSniffer: { ...matrixSniffer, lastMatrixHit: hit } });
    if (ARDUINO_AUTO_THROW_MATRIX_ENABLED) handleArduinoMatrixHit(hit);
    return;
  }

  // HB,<ms>,active=<n>  (neuer 20CH-Sniffer + alter einfacher HB)
  const hbMatch = clean.match(/^HB,(\d+),active=(\d+)$/i);
  if (hbMatch) {
    const activeCount = Number(hbMatch[2]);
    maybeInferArduinoActiveState(activeCount, 20);
    normalizeArduinoStatePatch({
      activeCount,
      lastHeartbeat: { ms: Number(hbMatch[1]), activeCount, line: clean },
      matrixSniffer: { ...matrixSniffer, lastMatrixHit: matrixSniffer.lastMatrixHit },
      activeStateMode: ARDUINO_EVENT_ACTIVE_STATE_MODE,
      activeStateResolved: arduinoResolvedActiveState
    });
    // Auto-Detect nach Heartbeat ausführen
    channelAutoDetect.heartbeatCount++;
    channelAutoDetect.lastHeartbeatMs = Date.now();
    if (typeof runChannelAutoDetect === 'function') runChannelAutoDetect();
    return;
  }

  // HB,<ms>,rows=...,columns=...,active=... (alter R/C-Sniffer)
  const hbRcMatch = clean.match(/^HB,(\d+),rows=(\d+),columns=(\d+),active=(\d+)$/i);
  if (hbRcMatch) {
    const rows = Number(hbRcMatch[2]);
    const columns = Number(hbRcMatch[3]);
    const activeCount = Number(hbRcMatch[4]);
    maybeInferArduinoActiveState(activeCount, Math.max(1, rows + columns));
    normalizeArduinoStatePatch({
      activeCount,
      lastHeartbeat: { ms: Number(hbRcMatch[1]), rows, columns, activeCount, line: clean },
      matrixSniffer: { ...matrixSniffer, lastMatrixHit: matrixSniffer.lastMatrixHit },
      activeStateMode: ARDUINO_EVENT_ACTIVE_STATE_MODE,
      activeStateResolved: arduinoResolvedActiveState
    });
    return;
  }

  // Legacy: CHxx: ACTIVE|IDLE (alter Test-Sketch)
  const legacyEvent = clean.match(/^CH(\d{2}):\s*(ACTIVE|IDLE)$/i);
  if (legacyEvent) {
    const ch = Number(legacyEvent[1]);
    const chStr = String(ch).padStart(2, '0');
    const state = legacyEvent[2].toUpperCase();
    const evt = { ms: null, channel: chStr, state, line: clean };
    const isActiveEvent = isArduinoActiveState(evt.state);
    normalizeArduinoStatePatch({
      lastEvent: { ...evt },
      lastTrigger: isActiveEvent ? { ...evt, ts: Date.now() } : arduinoState.lastTrigger,
      pendingThrow: arduinoState.pendingThrow
    });
    if (isActiveEvent) {
      if (typeof handleChannelActiveEvent === 'function') handleChannelActiveEvent(evt);
      handleArduinoActiveEvent(evt);
    }
    else if (ch === 21 || ch === 22) handleArduinoTrigger(evt);
    return;
  }

  // Legacy: STATUS active=...
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

    port.on('open', () => {
      if (typeof resetChannelAutoDetect === 'function') resetChannelAutoDetect();
      normalizeArduinoStatePatch({ connected: true, port: serialPath, error: null });
    });
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
  const fresh = await defaultLiveState(savedLiveMode);
  await dataStore.saveLiveState(fresh);
}

async function getActivePlayersForLive() {
  const players = (await getPlayers()).filter(p => p.active && String(p.name || '').trim());
  return players.map((p, index) => ({
    slot: p.slot, name: String(p.name).trim(),
    color: p.color || ['#e63946','#f4a261','#2a9d8f','#457b9d','#9b5de5','#f77f00'][index % 6]
  }));
}

async function defaultLiveState(mode) {
  const m = mode || DEFAULT_MODE;
  const active = await getActivePlayersForLive();
  const fallbackPlayers = active.length > 0
    ? active
    : [{ slot: 1, name: 'Spieler 1', color: '#e63946' }, { slot: 2, name: 'Spieler 2', color: '#f4a261' }];
  const startScore = getStartScoreForMode(m);

  return {
    game: { mode: m, status: 'running', startedAt: Date.now(), updatedAt: Date.now(), activePlayer: 0, throwRound: 1, currentThrow: 0 },
    players: fallbackPlayers.map(p => ({ ...p, remaining: startScore, legs: 0, turns: 0, totalScored: 0, bestTurn: 0, average: 0, throws: [], currentRoundPoints: [], ...defaultPlayerCricketState(m) })),
    lastAction: null,
    arduino: { connected: false, lastEvent: null, activeCount: 0, heartbeatMs: null }
  };
}

function roundAverage(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function calculateCurrentRoundAverage(player) {
  const currentRoundPoints = Array.isArray(player?.currentRoundPoints) ? player.currentRoundPoints : [];
  if (currentRoundPoints.length === 0) return 0;
  const sum = currentRoundPoints.reduce((total, points) => total + (Number(points) || 0), 0);
  return roundAverage(sum / 3);
}

function getTurnScoreHighscoreKind(score) {
  if (score === 180) return '180er';
  if (score === 177) return '177er';
  if (score === 174) return '174er';
  if (score === 171) return '171er';
  if (score === 167) return '167er';
  if (score === 164) return '164er';
  if (score === 161) return '161er';
  if (score === 160) return '160er';
  if (score === 157) return '157er';
  if (score === 154) return '154er';
  if (score === 151) return '151er';
  if (score === 150) return '150er';
  if (score >= 140) return '140+';
  if (score >= 100) return '100+';
  return null;
}

async function addTurnScoreHighscoreIfNeeded(player, state, source = 'live') {
  if (state.game.mode === 'cricket') return;
  if (!Array.isArray(player.currentRoundPoints) || player.currentRoundPoints.length !== 3 || player.turnScoreRecorded) return;
  const turnScore = player.currentRoundPoints.reduce((sum, points) => sum + (Number(points) || 0), 0);
  const kind = getTurnScoreHighscoreKind(turnScore);
  if (!kind) return;

  await addHighscore(player.name, turnScore, { kind, source });
  player.turnScoreRecorded = true;
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
  const average = calculateCurrentRoundAverage({ currentRoundPoints });
  const cricketHits = player?.cricketHits || {};
  const cricketClosed = player?.cricketClosed || {};
  return { slot, name, color, remaining, legs, turns, totalScored, bestTurn, throws, currentRoundPoints, average, cricketHits, cricketClosed };
}

function resetLiveState(carryLegs = false, modeOverride) {
  const now = Date.now();
  const basePlayers = savedLiveStateTemplate || [];
  const mode = modeOverride || savedLiveMode || DEFAULT_MODE;
  const startScore = getStartScoreForMode(mode);
  const legsBySlot = carryLegs && Array.isArray(savedLiveStateTemplate)
    ? new Map(savedLiveStateTemplate.map(p => [Number(p.slot || 0), Number(p.legs || 0)]))
    : new Map();

  const players = basePlayers.map((p) => ({
    ...p,
    remaining: startScore,
    legs: Number(legsBySlot.get(Number(p.slot || 0)) || 0),
    turns: 0,
    totalScored: 0,
    bestTurn: 0,
    average: 0,
    throws: [],
    currentRoundPoints: [],
    ...defaultPlayerCricketState(mode)
  }));

  return {
    game: {
      mode,
      status: 'running',
      startedAt: now,
      updatedAt: now,
      activePlayer: 0,
      throwRound: 1,
      currentThrow: 0
    },
    players,
    lastAction: null,
    arduino: { connected: false, lastEvent: null, activeCount: 0, heartbeatMs: null }
  };
}

let savedLiveStateTemplate = [];
let savedLiveMode = DEFAULT_MODE;

async function getLiveState() {
  const mode = savedLiveMode || DEFAULT_MODE;
  const fallback = await defaultLiveState(mode);
  const saved = await dataStore.getLiveState(fallback);
  const arduinoView = buildArduinoStateView();
  const activePlayers = fallback.players;
  const savedMode = String(saved.game?.mode || '');
  if (GAME_MODES[savedMode]) savedLiveMode = savedMode;
  savedLiveStateTemplate = Array.isArray(saved.players) && saved.players.length > 0
    ? saved.players.map(p => ({ ...p, throws: Array.isArray(p.throws) ? p.throws : [], currentRoundPoints: Array.isArray(p.currentRoundPoints) ? p.currentRoundPoints : [] }))
    : activePlayers;
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
    arduino: arduinoView
  };

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

// ── Spielmodi ──
app.get('/api/game/modes', (_req, res) => {
  res.json(GAME_MODES);
});

app.post('/api/game/mode', async (req, res) => {
  const mode = String(req.body?.mode || '').trim();
  if (!GAME_MODES[mode]) return res.status(400).json({ error: `Unbekannter Modus: ${mode}` });
  try {
    savedLiveMode = mode;
    const fresh = resetLiveState(false, mode);
    const saved = await saveLiveState(fresh);
    broadcastReload();
    res.json(saved);
  } catch (err) { res.status(500).json({ error: 'Modus-Wechsel fehlgeschlagen: ' + err.message }); }
});

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
app.get('/api/arduino/state', (_req, res) => { res.json(buildArduinoStateView()); });

app.post('/api/arduino/connect', (req, res) => {
  const currentSettings = getSettings();
  const requestedPort = typeof req.body?.port === 'string' ? req.body.port.trim() : '';
  saveSettings({ ...currentSettings, arduinoMonitorEnabled: true, arduinoPort: requestedPort });
  restartArduinoMonitor();
  res.json({ ok: true, requestedPort: requestedPort || '', state: buildArduinoStateView() });
});

app.post('/api/arduino/disconnect', (_req, res) => {
  const currentSettings = getSettings();
  saveSettings({ ...currentSettings, arduinoMonitorEnabled: false });
  closeArduinoMonitor();
  normalizeArduinoStatePatch({ enabled: false, error: 'Arduino-Monitor deaktiviert.' });
  res.json({ ok: true, state: buildArduinoStateView() });
});

app.get('/api/arduino/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write('event: state\ndata: ' + JSON.stringify(buildArduinoStateView()) + '\n\n');
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
    const mode = savedLiveMode || DEFAULT_MODE;
    const fresh = resetLiveState(carryLegs, mode);
    const saved = await saveLiveState(fresh);
    broadcastReload();
    res.json(saved);
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
    const mode = state.game.mode || DEFAULT_MODE;
    const modeDef = GAME_MODES[mode] || GAME_MODES[DEFAULT_MODE];
    const isCricket = modeDef.type === 'cricket';

    let bust = false;
    if (isCricket) {
      player.totalScored += points;
      player.remaining = 0;
      const dartNumber = Number(req.body?.number || points);
      const multiplier = Number(req.body?.multiplier || 1);
      if (!player.cricketHits) player.cricketHits = {};
      if (!player.cricketClosed) player.cricketClosed = {};
      if ([15,16,17,18,19,20,25].includes(dartNumber)) {
        player.cricketHits[dartNumber] = Math.min(3, (player.cricketHits[dartNumber] || 0) + multiplier);
        if (player.cricketHits[dartNumber] >= 3) player.cricketClosed[dartNumber] = true;
      }
    } else {
      const nextRemaining = player.remaining - points;
      bust = nextRemaining < 0;
      if (!bust) { player.remaining = nextRemaining; player.totalScored += points; }
    }

    player.turns += 1;
    player.bestTurn = Math.max(player.bestTurn, points);

    if (!Array.isArray(player.currentRoundPoints)) player.currentRoundPoints = [];
    player.currentRoundPoints.push(points);

    if (!Array.isArray(player.throws)) player.throws = [];
    player.throws.push({ points, remaining: player.remaining, bust, ts: Date.now(), mode });

    player.average = calculateCurrentRoundAverage(player);
    state.game.currentThrow = (state.game.currentThrow || 0) + 1;

    state.lastAction = {
      type: 'throw', playerIndex: targetIndex, playerSlot: player.slot, player: player.name,
      points, bust, remaining: player.remaining, roundThrow: state.game.currentThrow, ts: Date.now(), mode
    };

    if (!isCricket && player.remaining === 0) {
      player.legs += 1;
      await addHighscore(player.name, points, { kind: 'checkout', legWin: true });
      state.game.status = 'leg-finished';
    }

    if (state.game.status !== 'leg-finished' && state.game.currentThrow >= 3) {
      await advanceAfterThreeThrows(state, player, 'manual');
    }

    await addTurnScoreHighscoreIfNeeded(player, state, 'manual');

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

    const mode = state.game.mode || DEFAULT_MODE;
    const modeDef = GAME_MODES[mode] || GAME_MODES[DEFAULT_MODE];
    const isCricket = modeDef.type === 'cricket';

    if (isCricket) {
      player.totalScored = Math.max(0, Number(player.totalScored || 0) - lastThrow.points);
    } else {
      if (!lastThrow.bust) { player.remaining += lastThrow.points; player.totalScored -= lastThrow.points; }
    }
    player.turns = Math.max(0, player.turns - 1);
    player.average = calculateCurrentRoundAverage(player);

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
