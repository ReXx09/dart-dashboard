const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
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

function readRaspberryTemperature() {
  const candidates = [
    '/sys/class/thermal/thermal_zone0/temp',
    '/sys/devices/virtual/thermal/thermal_zone0/temp'
  ];
  for (const filePath of candidates) {
    try {
      const raw = Number(fs.readFileSync(filePath, 'utf8').trim());
      if (Number.isFinite(raw)) return raw > 1000 ? raw / 1000 : raw;
    } catch (_err) {
      // Temperature files are Linux/Raspberry-Pi specific.
    }
  }
  return null;
}

function getSystemDiagnostics() {
  const totalMemory = Number(os.totalmem());
  const freeMemory = Number(os.freemem());
  const memoryUsed = Math.max(0, totalMemory - freeMemory);
  let disk = { totalBytes: null, freeBytes: null, usedBytes: null, usedPercent: null };
  try {
    const stats = fs.statfsSync(DATA_DIR);
    const blockSize = Number(stats.bsize || stats.frsize || 0);
    const totalBytes = blockSize * Number(stats.blocks || 0);
    const freeBytes = blockSize * Number(stats.bavail || stats.bfree || 0);
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    disk = { totalBytes, freeBytes, usedBytes, usedPercent: totalBytes ? Math.round(usedBytes / totalBytes * 1000) / 10 : null };
  } catch (_err) {
    // Filesystem stats are not available on every platform/runtime.
  }
  return {
    host: os.hostname(),
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    cpuCount: os.cpus().length,
    loadAverage: os.loadavg(),
    systemUptimeSec: Math.round(os.uptime()),
    processUptimeSec: Math.round(process.uptime()),
    memory: {
      totalBytes: totalMemory,
      freeBytes: freeMemory,
      usedBytes: memoryUsed,
      usedPercent: totalMemory ? Math.round(memoryUsed / totalMemory * 1000) / 10 : null
    },
    disk,
    temperatureC: readRaspberryTemperature(),
    sampledAt: Date.now()
  };
}

const app = express();
const BROWSER_PORT = Number(process.env.BROWSER_PORT || process.env.PORT || 3100);
const FIRETV_PORT = Number(process.env.FIRETV_PORT || 3200);
const ADMIN_SESSION_TTL_MS = Number(process.env.ADMIN_SESSION_TTL_MS || 15 * 60 * 1000);
const ADMIN_BACKUP_DIR = path.join(__dirname, 'data', 'backups');
const BACKUP_USB_PATH = String(process.env.BACKUP_USB_PATH || '').trim();
const NEXTCLOUD_WEBDAV_URL = String(process.env.NEXTCLOUD_WEBDAV_URL || '').trim();
const NEXTCLOUD_USER = String(process.env.NEXTCLOUD_USER || '').trim();
const NEXTCLOUD_PASSWORD = String(process.env.NEXTCLOUD_PASSWORD || '');
const NEXTCLOUD_BACKUP_PATH = String(process.env.NEXTCLOUD_BACKUP_PATH || 'Dart-Dashboard-Backups').replace(/^\/+|\/+$/g, '');
const adminSessions = new Map();
let adminAuthEnabled = String(process.env.ADMIN_AUTH_ENABLED || 'true').toLowerCase() !== 'false';

const DATA_DIR       = path.join(__dirname, 'data');
const SETTINGS_FILE  = path.join(DATA_DIR, 'settings.json');
const PLAYERS_FILE   = path.join(DATA_DIR, 'players.json');
const LIVE_STATE_FILE = path.join(DATA_DIR, 'live-state.json');
const HIGHSCORES_FILE = path.join(DATA_DIR, 'highscores.json');
const MATRIX_MAPPING_FILE = path.join(DATA_DIR, 'matrix-mapping.json');
const ADMIN_BACKUP_SOURCES = {
  database: null,
  players: PLAYERS_FILE,
  liveState: LIVE_STATE_FILE,
  highscores: HIGHSCORES_FILE,
  settings: SETTINGS_FILE,
  matrixMapping: MATRIX_MAPPING_FILE
};

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
// Werte können auf dem Raspi per JSON-Datei angepasst werden, ohne den Arduino neu zu flashen.
const DEFAULT_MATRIX_CODE_BY_ROW_COLUMN = {
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
let MATRIX_CODE_BY_ROW_COLUMN = loadMatrixMapping();
let MATRIX_ROW_COLUMN_VALUES = buildMatrixValueMap(MATRIX_CODE_BY_ROW_COLUMN);

const ARDUINO_AUTO_THROW_ENABLED = process.env.ARDUINO_AUTO_THROW_ENABLED !== 'false';
const ARDUINO_AUTO_THROW_MATRIX_ENABLED = process.env.ARDUINO_AUTO_THROW_MATRIX_ENABLED === 'true';
const ARDUINO_AUTO_THROW_MATRIX_UNMAPPED = process.env.ARDUINO_AUTO_THROW_MATRIX_UNMAPPED === 'true';
const ARDUINO_MATRIX_RAW_ENABLED = process.env.ARDUINO_MATRIX_RAW_ENABLED !== 'false';
const ARDUINO_REQUIRE_THROW_TRIGGER = process.env.ARDUINO_REQUIRE_THROW_TRIGGER !== 'false';
const ARDUINO_EVENT_ACTIVE_STATE_MODE_RAW = String(process.env.ARDUINO_EVENT_ACTIVE_STATE || 'AUTO').trim().toUpperCase();
const ARDUINO_EVENT_ACTIVE_STATE_MODE = ['ACTIVE', 'IDLE', 'AUTO'].includes(ARDUINO_EVENT_ACTIVE_STATE_MODE_RAW)
  ? ARDUINO_EVENT_ACTIVE_STATE_MODE_RAW
  : 'AUTO';
const ARDUINO_THROW_WINDOW_MS = Number(process.env.ARDUINO_THROW_WINDOW_MS || 1200);
const MATRIX_HIT_RELEASE_MS = Number(process.env.MATRIX_HIT_RELEASE_MS || 25);
const MATRIX_HIT_REFRACTORY_MS = Number(process.env.MATRIX_HIT_REFRACTORY_MS || 80);
const MATRIX_HIT_SUPPRESS_MS = Number(process.env.MATRIX_HIT_SUPPRESS_MS || 0);
const MATRIX_HIT_CLUSTER_WINDOW_MS = Number(process.env.MATRIX_HIT_CLUSTER_WINDOW_MS || 0);
const MATRIX_EVT_PAIR_MAX_SKEW_MS = Number(process.env.MATRIX_EVT_PAIR_MAX_SKEW_MS || 220);
const MATRIX_SAME_KEY_GUARD_MS = Number(process.env.MATRIX_SAME_KEY_GUARD_MS || 50);
const ARDUINO_MATRIX_THROW_LOCK_MS = Number(process.env.ARDUINO_MATRIX_THROW_LOCK_MS || 50);
const THROW_MIN_INTERVAL_MS = Number(process.env.THROW_MIN_INTERVAL_MS || 0);
const PLAYER_SWITCH_DELAY_MS = Number(process.env.PLAYER_SWITCH_DELAY_MS || 20000);
const SINGLE_PLAYER_SWITCH_DELAY_MS = Number(process.env.SINGLE_PLAYER_SWITCH_DELAY_MS || 3000);

let runtimeTuning = {
  arduinoMatrixRawEnabled: ARDUINO_MATRIX_RAW_ENABLED,
  arduinoThrowWindowMs: ARDUINO_THROW_WINDOW_MS,
  matrixHitReleaseMs: MATRIX_HIT_RELEASE_MS,
  matrixHitRefractoryMs: MATRIX_HIT_REFRACTORY_MS,
  matrixHitSuppressMs: MATRIX_HIT_SUPPRESS_MS,
  matrixHitClusterWindowMs: MATRIX_HIT_CLUSTER_WINDOW_MS,
  matrixEvtPairMaxSkewMs: MATRIX_EVT_PAIR_MAX_SKEW_MS,
  matrixSameKeyGuardMs: MATRIX_SAME_KEY_GUARD_MS,
  arduinoMatrixThrowLockMs: ARDUINO_MATRIX_THROW_LOCK_MS,
  throwMinIntervalMs: THROW_MIN_INTERVAL_MS,
  playerSwitchDelayMs: PLAYER_SWITCH_DELAY_MS,
  singlePlayerSwitchDelayMs: SINGLE_PLAYER_SWITCH_DELAY_MS
};

// ── Spielmodi ──────────────────────────────────
const GAME_MODES = {
  '501':   { label: '501',   type: 'x01',  startScore: 501,  cricketNumbers: null,   description: '501' },
  '301':   { label: '301',   type: 'x01',  startScore: 301,  cricketNumbers: null,   description: '301' },
  '701':   { label: '701',   type: 'x01',  startScore: 701,  cricketNumbers: null,   description: '701' },
  'cricket': { label: 'Cricket', type: 'cricket', startScore: 0, cricketNumbers: [15,16,17,18,19,20,25], description: 'Cricket' },
  'elimination': { label: '301-Elimination', type: 'elimination', startScore: 0, targetScore: 301, cricketNumbers: null, description: '301-Elimination: bis 301 oder maximal 10 Aufnahmen' },
  'shanghai': { label: 'Shanghai', type: 'shanghai', startScore: 0, cricketNumbers: null, description: 'Shanghai' },
  'atc':    { label: 'Around the Clock', type: 'atc', startScore: 0, cricketNumbers: null, description: 'Around the Clock' },
  'split':  { label: 'Split', type: 'split', startScore: 0, cricketNumbers: null, description: 'Split Score' }
};

const CHECKOUT_RULES = {
  'single': { label: 'Single Out', description: 'Beliebiger Wurf auf 0' },
  'double': { label: 'Double Out', description: 'Nur Double auf 0' },
  'master': { label: 'Master Out', description: 'Double oder Triple auf 0' }
};

const DEFAULT_MODE = '501';
const DEFAULT_CHECKOUT_RULE = 'double';

function getStartScoreForMode(mode) {
  const def = GAME_MODES[mode];
  return def ? def.startScore : 501;
}

function getCricketNumbersForMode(mode) {
  const def = GAME_MODES[mode];
  return def && def.type === 'cricket' ? [...def.cricketNumbers] : null;
}

function isValidCheckout(remaining, points, rule, segment = null) {
  // remaining = what's left BEFORE this throw
  // points = what was thrown
  const nextRemaining = remaining - points;
  if (nextRemaining < 0) return false; // bust (overthrow)
  if ((rule === 'double' || rule === 'master') && nextRemaining === 1) return false; // Rest 1 ist nicht checkoutbar
  if (nextRemaining === 0) {
    // Checkout attempt – validate the finishing dart
    if (rule === 'single') return true; // any dart can finish
    if (rule === 'double') {
      // Prefer the real segment; point-only requests retain legacy parity behavior.
      return segment ? (/^D\d+$/.test(segment) || segment === 'DBULL') : points % 2 === 0;
    }
    if (rule === 'master') {
      return segment
        ? (/^[DT]\d+$/.test(segment) || segment === 'DBULL')
        : points % 2 === 0 || points % 3 === 0;
    }
    return true;
  }
  return true; // not a checkout attempt, valid
}

function isCheckoutFinishSegment(segment, rule = DEFAULT_CHECKOUT_RULE) {
  const normalized = String(segment || '').toUpperCase();
  if (rule === 'single') return /^(?:S|D|T)(?:[1-9]|1[0-9]|20)$/.test(normalized) || normalized === 'S25' || normalized === 'DBULL';
  if (rule === 'master') return /^(?:D|T)(?:[1-9]|1[0-9]|20)$/.test(normalized) || normalized === 'DBULL';
  return /^D(?:[1-9]|1[0-9]|20)$/.test(normalized) || normalized === 'DBULL';
}

function isCheckoutAttempt(remaining, segment, rule = DEFAULT_CHECKOUT_RULE) {
  const rest = Number(remaining);
  return rest > 0 && rest <= 170 && isCheckoutFinishSegment(segment, rule);
}

function getCheckoutRuleStats(player, rule) {
  const safeRule = ['single', 'double', 'master'].includes(rule) ? rule : DEFAULT_CHECKOUT_RULE;
  if (!player.checkoutByRule || typeof player.checkoutByRule !== 'object') player.checkoutByRule = {};
  if (!player.checkoutByRule[safeRule]) player.checkoutByRule[safeRule] = { attempts: 0, success: 0, highest: 0 };
  return player.checkoutByRule[safeRule];
}

function isDoublePoints(points) {
  // A double value is an even number where points/2 is a valid dart number (1-20, 25)
  if (points <= 0 || points > 50) return false;
  if (points === 50) return true; // bullseye
  if (points % 2 !== 0) return false;
  const base = points / 2;
  return base >= 1 && base <= 20;
}

function isMasterPoints(points) {
  // Master out: double OR triple
  if (isDoublePoints(points)) return true;
  if (points <= 0 || points > 60) return false;
  if (points % 3 !== 0) return false;
  const base = points / 3;
  return base >= 1 && base <= 20;
}

function defaultPlayerCricketState(mode) {
  const nums = getCricketNumbersForMode(mode);
  if (!nums) return {};
  const hits = {};
  nums.forEach(n => { hits[n] = 0; });
  return { cricketHits: hits, cricketClosed: {}, cricketPoints: 0 };
}

// ── Cricket Scoring ──────────────────────────────────
function calculateCricketPoints(player, allPlayers) {
  return Number(player.cricketPoints ?? player.totalScored ?? 0);
}

function applyCricketHit(player, allPlayers, number, hitCount) {
  if (!player.cricketHits) player.cricketHits = {};
  if (!player.cricketClosed) player.cricketClosed = {};

  const oldHits = Number(player.cricketHits[number] || 0);
  const newHits = oldHits + hitCount;
  const opponentHasClosed = allPlayers.some(opponent =>
    opponent.slot !== player.slot && opponent.cricketClosed && opponent.cricketClosed[number]
  );

  player.cricketHits[number] = newHits;
  if (newHits >= 3) player.cricketClosed[number] = true;

  const newlyScoringHits = opponentHasClosed
    ? 0
    : Math.max(0, newHits - 3) - Math.max(0, oldHits - 3);
  const awardedPoints = newlyScoringHits * number;
  player.cricketPoints = Number(player.cricketPoints ?? player.totalScored ?? 0) + awardedPoints;
  player.totalScored = player.cricketPoints;
  return awardedPoints;
}

function checkCricketWin(player, allPlayers) {
  if (!player.cricketClosed) return false;
  
  // ALLE 7 Zahlen (15-20, 25) müssen geschlossen sein
  const requiredNumbers = [15, 16, 17, 18, 19, 20, 25];
  const allClosed = requiredNumbers.every(n => player.cricketClosed[n] === true);
  if (!allClosed) return false;
  
  // Punkte berechnen
  const myPoints = calculateCricketPoints(player, allPlayers);
  
  // Prüfen ob Gegner mehr Punkte haben (auch wenn sie noch nicht alle Zahlen geschlossen haben)
  for (const opp of allPlayers) {
    if (opp.slot === player.slot) continue;
    const oppPoints = calculateCricketPoints(opp, allPlayers);
    if (oppPoints > myPoints) return false;
  }
  
  return true;
}

// ── Elimination Scoring ──────────────────────────────────
function calculateEliminationPoints(player) {
  return Math.max(0, Number(player.totalScored || 0));
}

function checkEliminationWin(state) {
  const modeDef = GAME_MODES[state.game.mode];
  if (!modeDef || modeDef.type !== 'elimination') return false;

  const targetScore = Number(modeDef.targetScore || 301);
  if (state.players.some(player => calculateEliminationPoints(player) >= targetScore)) return true;

  // Nach dem dritten Wurf des letzten Spielers ist die zehnte Aufnahme komplett.
  const lastPlayerIndex = Math.max(0, state.players.length - 1);
  return Number(state.game.throwRound || 0) >= 10
    && Number(state.game.currentThrow || 0) >= 3
    && Number(state.game.activePlayer || 0) === lastPlayerIndex;
}

function getEliminationWinner(state) {
  // Gewinner ist der erste Spieler bei 301, sonst der Punktbeste nach 10 Aufnahmen.
  let winner = null;
  let maxPoints = -1;
  for (const player of state.players) {
    const points = calculateEliminationPoints(player);
    if (points > maxPoints) {
      maxPoints = points;
      winner = player;
    }
  }
  return winner;
}

function applyEliminationThrow(state, player, value) {
  const modeDef = GAME_MODES[state.game.mode] || GAME_MODES.elimination;
  const targetScore = Number(modeDef.targetScore || 301);
  const previousTurnPoints = Array.isArray(player.currentRoundPoints)
    ? player.currentRoundPoints.reduce((sum, points) => sum + (Number(points) || 0), 0)
    : 0;
  const nextScore = calculateEliminationPoints(player) + value;

  if (nextScore > targetScore) {
    // Ein Überwurf macht die komplette laufende Aufnahme ungültig.
    player.totalScored = Math.max(0, nextScore - previousTurnPoints - value);
    return { bust: true, eliminationAction: null };
  }

  player.totalScored = nextScore;
  const eliminated = applyEliminationHit(state, player, value);
  return {
    bust: false,
    eliminationAction: eliminated ? state.lastAction : null
  };
}

function applyEliminationHit(state, player, value) {
  // Fix: Vergleiche den AKTUELLEN Punktestand des werfenden Spielers
  // (nachdem der Wurf addiert wurde) mit allen anderen Spielern
  const currentPlayerScore = calculateEliminationPoints(player);
  
  for (const other of state.players) {
    if (other.slot === player.slot) continue;
    const otherPoints = calculateEliminationPoints(other);
    
    // Elimination: Punktestand des anderen Spielers entspricht MEINEM aktuellen Score
    if (otherPoints === currentPlayerScore) {
      // Nur eliminieren wenn der andere NICHT bereits bei 0 ist
      // (verhindert "Selbst-Elimination" durch Startwert 0)
      if (otherPoints === 0 && currentPlayerScore === 0) continue;
      
      // ELIMINATION! Anderen Spieler auf 0 zurücksetzen
      other.totalScored = 0;
      other.throws = other.throws || [];
      other.throws.push({
        points: 0,
        remaining: 0,
        bust: false,
        eliminated: true,
        eliminatedBy: player.slot,
        ts: Date.now(),
        source: 'elimination'
      });
      state.lastAction = {
        type: 'elimination',
        source: 'elimination',
        playerIndex: state.players.indexOf(other),
        playerSlot: other.slot,
        player: other.name,
        eliminatedBy: player.name,
        eliminatedBySlot: player.slot,
        points: value,
        ts: Date.now()
      };
      return true;
    }
  }
  return false;
}

const dataStore = new DataStore();

// ──────────────────────────────────────────────
// Hilfsfunktionen
// ──────────────────────────────────────────────
function getAdminPinHash() {
  return String(process.env.ADMIN_PIN_HASH || '').trim();
}

function verifyAdminPin(pin) {
  const stored = getAdminPinHash();
  const [salt, expectedHex] = stored.split(':');
  if (!salt || !expectedHex || !/^\d{6,}$/.test(String(pin || '')) || !/^[a-f0-9]{64}$/i.test(expectedHex)) return false;
  const actual = crypto.scryptSync(String(pin), salt, 32);
  const expected = Buffer.from(expectedHex, 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
}

function isLocalOrPrivateAddress(address) {
  const normalized = String(address || '').replace(/^::ffff:/i, '').split('%')[0];
  if (normalized === '::1' || normalized === 'localhost' || normalized === '127.0.0.1') return true;
  const octets = normalized.split('.').map(Number);
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  return octets[0] === 10 || octets[0] === 127 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function createAdminSession() {
  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.set(token, Date.now() + ADMIN_SESSION_TTL_MS);
  return token;
}

function getAdminSession(req) {
  const token = String(req.get('x-admin-token') || req.headers.cookie || '').replace(/^admin_session=/, '').split(';')[0].trim();
  const expiresAt = adminSessions.get(token);
  if (!token || !expiresAt) return null;
  if (expiresAt <= Date.now()) {
    adminSessions.delete(token);
    return null;
  }
  adminSessions.set(token, Date.now() + ADMIN_SESSION_TTL_MS);
  return token;
}

function requireAdmin(req, res, next) {
  if (!isLocalOrPrivateAddress(req.socket.remoteAddress)) return res.status(403).json({ error: 'Admin-Zugriff nur aus dem lokalen Netz.' });
  if (!getAdminPinHash()) return next();
  if (!adminAuthEnabled) return next();
  if (!getAdminSession(req)) return res.status(401).json({ error: 'Admin-Anmeldung erforderlich.' });
  next();
}

function requireLocalNetwork(req, res, next) {
  if (!isLocalOrPrivateAddress(req.socket.remoteAddress)) return res.status(403).json({ error: 'Zugriff nur aus dem lokalen Netz.' });
  next();
}

function requireAdminPinChange(req, res, next) {
  if (!isLocalOrPrivateAddress(req.socket.remoteAddress)) return res.status(403).json({ error: 'Admin-Zugriff nur aus dem lokalen Netz.' });
  if (!verifyAdminPin(req.body?.currentPin)) return res.status(401).json({ error: 'Aktuelle PIN ist ungültig.' });
  next();
}

function normalizeBackupAreas(areas) {
  const requested = Array.isArray(areas) ? areas : Object.keys(ADMIN_BACKUP_SOURCES);
  return [...new Set(requested.map(value => String(value || '').trim()))].filter(value => Object.hasOwn(ADMIN_BACKUP_SOURCES, value));
}

function normalizeBackupDestination(destination) {
  const value = String(destination || 'local').trim().toLowerCase();
  return ['local', 'usb', 'nextcloud'].includes(value) ? value : 'local';
}

function copyDirectoryContents(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const source = path.join(sourceDir, entry.name);
    const target = path.join(targetDir, entry.name);
    if (entry.isDirectory()) copyDirectoryContents(source, target);
    else fs.copyFileSync(source, target);
  }
}

async function uploadBackupToNextcloud(backupId, backupDir, files) {
  if (!NEXTCLOUD_WEBDAV_URL || !NEXTCLOUD_USER || !NEXTCLOUD_PASSWORD) {
    throw new Error('Nextcloud ist nicht konfiguriert. NEXTCLOUD_WEBDAV_URL, NEXTCLOUD_USER und NEXTCLOUD_PASSWORD setzen.');
  }
  const baseUrl = new URL(NEXTCLOUD_WEBDAV_URL.endsWith('/') ? NEXTCLOUD_WEBDAV_URL : NEXTCLOUD_WEBDAV_URL + '/');
  const remoteParts = [NEXTCLOUD_BACKUP_PATH, backupId].filter(Boolean).join('/').split('/').map(encodeURIComponent).join('/');
  const authHeader = 'Basic ' + Buffer.from(NEXTCLOUD_USER + ':' + NEXTCLOUD_PASSWORD).toString('base64');
  const remoteSegments = remoteParts.split('/');
  for (let index = 0; index < remoteSegments.length; index += 1) {
    const directoryUrl = new URL(remoteSegments.slice(0, index + 1).join('/') + '/', baseUrl);
    const directoryResponse = await fetch(directoryUrl, { method: 'MKCOL', headers: { Authorization: authHeader } });
    if (!directoryResponse.ok && directoryResponse.status !== 405) {
      throw new Error('Nextcloud-Ordner konnte nicht angelegt werden (HTTP ' + directoryResponse.status + ').');
    }
  }
  for (const file of files) {
    const fileUrl = new URL(remoteParts + '/' + encodeURIComponent(file.file), baseUrl);
    const response = await fetch(fileUrl, {
      method: 'PUT',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/octet-stream'
      },
      body: fs.readFileSync(path.join(backupDir, file.file))
    });
    if (!response.ok) throw new Error('Nextcloud-Upload fehlgeschlagen (HTTP ' + response.status + ').');
  }
  return { provider: 'nextcloud', path: remoteParts };
}

async function createAdminBackup(areas, destination = 'local') {
  const selectedAreas = normalizeBackupAreas(areas);
  const selectedDestination = normalizeBackupDestination(destination);
  if (!selectedAreas.length) throw new Error('Keine gültigen Backup-Bereiche ausgewählt.');
  if (selectedAreas.includes('database') && !dataStore.isSQLite()) {
    throw new Error('Der Datenbank-Backup ist aktuell nur für SQLite verfügbar.');
  }
  const backupId = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const backupDir = path.join(ADMIN_BACKUP_DIR, backupId);
  fs.mkdirSync(backupDir, { recursive: true });
  const files = [];
  for (const area of selectedAreas) {
    const source = ADMIN_BACKUP_SOURCES[area];
    if (!source) continue;
    if (!fs.existsSync(source)) continue;
    const targetName = path.basename(source);
    fs.copyFileSync(source, path.join(backupDir, targetName));
    files.push({ area, file: targetName, bytes: fs.statSync(source).size });
  }
  if (selectedAreas.includes('database') && dataStore.isSQLite() && dataStore.sqliteFile && fs.existsSync(dataStore.sqliteFile)) {
    await dataStore.sqlite.exec('PRAGMA wal_checkpoint(FULL);');
    const targetName = path.basename(dataStore.sqliteFile);
    fs.copyFileSync(dataStore.sqliteFile, path.join(backupDir, targetName));
    files.push({ area: 'database', file: targetName, bytes: fs.statSync(dataStore.sqliteFile).size });
  }
  const manifest = { id: backupId, createdAt: new Date().toISOString(), areas: selectedAreas, files };
  fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  let delivery = { provider: 'local', path: backupDir };
  if (selectedDestination === 'usb') {
    if (!BACKUP_USB_PATH) throw new Error('USB-Ziel ist nicht konfiguriert. BACKUP_USB_PATH setzen.');
    const targetDir = path.join(BACKUP_USB_PATH, backupId);
    copyDirectoryContents(backupDir, targetDir);
    delivery = { provider: 'usb', path: targetDir };
  }
  manifest.destination = delivery;
  fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  if (selectedDestination === 'nextcloud') {
    delivery = await uploadBackupToNextcloud(backupId, backupDir, [...files, { file: 'manifest.json' }]);
    manifest.destination = delivery;
    fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    await uploadBackupToNextcloud(backupId, backupDir, [...files, { file: 'manifest.json' }]);
  } else if (selectedDestination === 'usb') {
    copyDirectoryContents(backupDir, path.join(BACKUP_USB_PATH, backupId));
  }
  return manifest;
}

function listAdminBackups() {
  if (!fs.existsSync(ADMIN_BACKUP_DIR)) return [];
  return fs.readdirSync(ADMIN_BACKUP_DIR, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => {
    const manifestPath = path.join(ADMIN_BACKUP_DIR, entry.name, 'manifest.json');
    return readJson(manifestPath, { id: entry.name, createdAt: null, areas: [], files: [] });
  }).sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

function readJson(file, fallback) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  return fallback;
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function cloneDefaultMatrixMapping() {
  return { ...DEFAULT_MATRIX_CODE_BY_ROW_COLUMN };
}

function normalizeMatrixMapping(rawMapping) {
  const source = rawMapping && typeof rawMapping === 'object' ? rawMapping : {};
  const normalized = {};

  for (const [key, value] of Object.entries(source)) {
    const code = Number(value);
    if (!Number.isFinite(code)) continue;
    normalized[key] = code;
  }

  return Object.keys(normalized).length > 0 ? normalized : cloneDefaultMatrixMapping();
}

function loadMatrixMapping() {
  if (!fs.existsSync(MATRIX_MAPPING_FILE)) return cloneDefaultMatrixMapping();
  try {
    return normalizeMatrixMapping(JSON.parse(fs.readFileSync(MATRIX_MAPPING_FILE, 'utf8')));
  } catch {
    return cloneDefaultMatrixMapping();
  }
}

function buildMatrixValueMap(mapping) {
  return Object.fromEntries(
    Object.entries(mapping).map(([key, code]) => [key, { code, points: codeToPoints(code) }])
  );
}

function saveMatrixMapping(mapping) {
  const normalized = normalizeMatrixMapping(mapping);
  writeJson(MATRIX_MAPPING_FILE, normalized);
  MATRIX_CODE_BY_ROW_COLUMN = normalized;
  MATRIX_ROW_COLUMN_VALUES = buildMatrixValueMap(normalized);
  normalizeArduinoStatePatch({ matrixMappingUpdatedAt: Date.now() });
  return normalized;
}

function getSettings() {
  const merged = {
    arduinoMonitorEnabled: true,
    arduinoPort: '',
    arduinoBaudRate: 500000,
    arduinoMatrixRawEnabled: runtimeTuning.arduinoMatrixRawEnabled,
    arduinoThrowWindowMs: runtimeTuning.arduinoThrowWindowMs,
    matrixHitReleaseMs: runtimeTuning.matrixHitReleaseMs,
    matrixHitRefractoryMs: runtimeTuning.matrixHitRefractoryMs,
    matrixHitSuppressMs: runtimeTuning.matrixHitSuppressMs,
    matrixHitClusterWindowMs: runtimeTuning.matrixHitClusterWindowMs,
    matrixEvtPairMaxSkewMs: runtimeTuning.matrixEvtPairMaxSkewMs,
    matrixSameKeyGuardMs: runtimeTuning.matrixSameKeyGuardMs,
    arduinoMatrixThrowLockMs: runtimeTuning.arduinoMatrixThrowLockMs,
    throwMinIntervalMs: runtimeTuning.throwMinIntervalMs,
    playerSwitchDelayMs: runtimeTuning.playerSwitchDelayMs,
    singlePlayerSwitchDelayMs: runtimeTuning.singlePlayerSwitchDelayMs,
    ...readJson(SETTINGS_FILE, {})
  };
  return merged;
}
function saveSettings(s) { writeJson(SETTINGS_FILE, s); }

let automaticEncounterCreation = null;

async function ensureAutomaticEncounter(state) {
  if (!state || !state.game || state.game.duelId || state.game.status !== 'running') return state;
  if (getSettings().automaticEncountersEnabled === false) return state;
  if (!['501', '301', '701'].includes(String(state.game.mode || ''))) return state;
  const participants = (Array.isArray(state.players) ? state.players : [])
    .filter(player => Number(player.slot) > 0 && String(player.name || '').trim())
    .slice(0, 8);
  if (participants.length < 2) return state;

  if (!automaticEncounterCreation) {
    automaticEncounterCreation = (async () => {
      const profiles = await dataStore.getProfiles();
      const profileByName = new Map(profiles.map(profile => [String(profile.name || '').trim().toLowerCase(), Number(profile.id)]));
      return dataStore.createDuel({
        mode: state.game.mode,
        players: participants.map(player => ({
          slot: player.slot,
          name: player.name,
          profileId: profileByName.get(String(player.name).trim().toLowerCase()) || null
        }))
      });
    })().finally(() => { automaticEncounterCreation = null; });
  }
  const duel = await automaticEncounterCreation;
  for (const participant of participants) {
    await dataStore.initPlayerStats(participant.slot);
    const stats = await dataStore.getPlayerStats(participant.slot) || {};
    await dataStore.updatePlayerStats(participant.slot, {
      games_played: Number(stats.games_played || 0) + 1
    });
  }
  state.game.duelId = duel.id;
  return state;
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (Number.isFinite(min) && n < min) return min;
  if (Number.isFinite(max) && n > max) return max;
  return n;
}

function refreshRuntimeTuning(settings = getSettings()) {
  runtimeTuning = {
    arduinoMatrixRawEnabled: settings.arduinoMatrixRawEnabled !== false,
    matrixAutoThrowEnabled: settings.matrixAutoThrowEnabled !== false,
    arduinoThrowWindowMs: clampNumber(settings.arduinoThrowWindowMs, ARDUINO_THROW_WINDOW_MS, 100, 4000),
    matrixHitReleaseMs: clampNumber(settings.matrixHitReleaseMs, MATRIX_HIT_RELEASE_MS, 5, 300),
    matrixHitRefractoryMs: clampNumber(settings.matrixHitRefractoryMs, MATRIX_HIT_REFRACTORY_MS, 50, 1200),
    matrixHitSuppressMs: clampNumber(settings.matrixHitSuppressMs, MATRIX_HIT_SUPPRESS_MS, 0, 800),
    matrixHitClusterWindowMs: clampNumber(settings.matrixHitClusterWindowMs, MATRIX_HIT_CLUSTER_WINDOW_MS, 0, 300),
    matrixEvtPairMaxSkewMs: clampNumber(settings.matrixEvtPairMaxSkewMs, MATRIX_EVT_PAIR_MAX_SKEW_MS, 20, 600),
    matrixSameKeyGuardMs: clampNumber(settings.matrixSameKeyGuardMs, MATRIX_SAME_KEY_GUARD_MS, 0, 800),
    arduinoMatrixThrowLockMs: clampNumber(settings.arduinoMatrixThrowLockMs, ARDUINO_MATRIX_THROW_LOCK_MS, 0, 1500),
    throwMinIntervalMs: clampNumber(settings.throwMinIntervalMs, THROW_MIN_INTERVAL_MS, 0, 1200),
    playerSwitchDelayMs: clampNumber(settings.playerSwitchDelayMs, PLAYER_SWITCH_DELAY_MS, 0, 120000),
    singlePlayerSwitchDelayMs: clampNumber(settings.singlePlayerSwitchDelayMs, SINGLE_PLAYER_SWITCH_DELAY_MS, 0, 120000)
  };
}

refreshRuntimeTuning();

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
let matrixHitSuppressUntil = 0;
let matrixLastAcceptedHitAt = 0;
let matrixLastAcceptedKey = '';
let matrixHitClusterTimer = null;
let matrixHitClusterHits = [];
let lastAppliedThrowAt = 0;
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
  lastTelemetry: null,
  lastTrigger: null,
  lastRawHit: null,
  pendingThrow: false,
  lastAutoThrow: null,
  lastMiss: null,
  lastAutoThrowError: null,
  playerSwitch: null,
  matrixSniffer: null,
  activeCount: null,
  lastHeartbeatAt: null,
  lastUpdateMs: null,
  rawHistory: [],
  error: null,
  channelAutoDetect: null,
  activeStateMode: ARDUINO_EVENT_ACTIVE_STATE_MODE,
  activeStateResolved: arduinoResolvedActiveState,
  matrixMappingUpdatedAt: null
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

function shouldQueueMatrixHit(key, nowMs) {
  const now = Number(nowMs || Date.now());
  if (key && key === matrixLastAcceptedKey && (now - matrixLastAcceptedHitAt) < runtimeTuning.matrixSameKeyGuardMs) {
    return false;
  }

  // Blocke nur direkte Nachzuegler auf dasselbe Segment im Suppress-Fenster.
  if (key && key === matrixLastAcceptedKey && now < matrixHitSuppressUntil) {
    return false;
  }

  return true;
}

function scoreMatrixHitCandidate(hit, count) {
  let score = 0;
  if (hit && hit.mapped) score += 4;
  if (hit && Number(hit.points) > 0) score += 3;
  if (hit && Number(hit.code) > 0) score += 1;
  if (hit && String(hit.source || '').includes('evt')) score += 2;
  score += Number(count || 0) * 10;
  return score;
}

function pickFreshestActiveSignal(activeMap) {
  const entries = Object.entries(activeMap || {})
    .map(([index, ts]) => ({ index: Number(index), ts: Number(ts || 0) }))
    .filter((entry) => Number.isFinite(entry.index) && Number.isFinite(entry.ts));

  if (entries.length === 0) return null;
  entries.sort((a, b) => b.ts - a.ts || a.index - b.index);
  return entries[0];
}

function flushMatrixHitCluster() {
  if (matrixHitClusterTimer) {
    clearTimeout(matrixHitClusterTimer);
    matrixHitClusterTimer = null;
  }

  if (!Array.isArray(matrixHitClusterHits) || matrixHitClusterHits.length === 0) {
    matrixHitClusterHits = [];
    return;
  }

  const grouped = new Map();
  for (const entry of matrixHitClusterHits) {
    const hit = entry.hit || {};
    const key = String(hit.key || '').trim();
    if (!key) continue;

    let group = grouped.get(key);
    if (!group) {
      group = { key, count: 0, firstAt: entry.at, bestHit: hit, bestScore: -Infinity };
      grouped.set(key, group);
    }

    group.count += 1;
    if (entry.at < group.firstAt) group.firstAt = entry.at;

    const candidateScore = scoreMatrixHitCandidate(hit, group.count);
    if (candidateScore > group.bestScore) {
      group.bestScore = candidateScore;
      group.bestHit = hit;
    }
  }

  matrixHitClusterHits = [];
  const ranked = [...grouped.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    if (b.bestScore !== a.bestScore) return b.bestScore - a.bestScore;
    return a.firstAt - b.firstAt;
  });

  const winner = ranked[0];
  if (!winner || !winner.bestHit) return;

  const now = Date.now();
  const acceptedHit = {
    ...winner.bestHit,
    ts: now,
    clusterSize: ranked.reduce((sum, g) => sum + g.count, 0),
    clusterCount: winner.count
  };

  matrixLastAcceptedHitAt = now;
  matrixLastAcceptedKey = acceptedHit.key || '';
  matrixHitSuppressUntil = now + runtimeTuning.matrixHitSuppressMs;

  matrixSniffer.lastMatrixHit = acceptedHit;
  matrixSniffer.lastMatrixHitMs = now;
  normalizeArduinoStatePatch({ matrixSniffer: { ...matrixSniffer, lastMatrixHit: acceptedHit } });

  if (runtimeTuning.matrixAutoThrowEnabled !== false && (acceptedHit.mapped || ARDUINO_AUTO_THROW_MATRIX_UNMAPPED)) {
    handleArduinoMatrixHit(acceptedHit);
  }
}

function queueMatrixHitCandidate(hit, nowMs) {
  const now = Number(nowMs || Date.now());
  const key = String((hit && hit.key) || '').trim();
  if (!key) return false;
  if (!shouldQueueMatrixHit(key, now)) return false;

  matrixHitClusterHits.push({ hit, at: now });
  if (!matrixHitClusterTimer) {
    matrixHitClusterTimer = setTimeout(flushMatrixHitCluster, runtimeTuning.matrixHitClusterWindowMs);
  }

  return true;
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
  const rawHit = summarizeMatrixHit(arduinoState.lastRawHit);
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
    hit: normalizedHit,
    rawHit
  };

  const matrix = {
    sniffer: matrixSnifferView,
    hit: normalizedHit,
    rawHit,
    label: normalizedHit ? normalizedHit.label : null,
    code: normalizedHitCode,
    points: normalizedHitPoints
  };

  const automation = {
    pendingThrow: !!arduinoState.pendingThrow,
    lastAutoThrow: arduinoState.lastAutoThrow || null,
    lastMiss: arduinoState.lastMiss || null,
    lastAutoThrowError: arduinoState.lastAutoThrowError || null,
    lastPlayerSwitch: arduinoState.playerSwitch || null,
    channelAutoDetect: arduinoState.channelAutoDetect || null
  };

  const telemetry = {
    activeCount: Number(arduinoState.activeCount || 0),
    uptimeMs: Number(arduinoState.lastHeartbeat?.ms || 0) || null,
    hitCount: Number(arduinoState.lastHeartbeat?.hits || 0) || null,
    isrCount: Number(arduinoState.lastHeartbeat?.isr || 0) || null,
    heartbeatAgeMs: arduinoState.lastHeartbeatAt ? Math.max(0, Date.now() - arduinoState.lastHeartbeatAt) : null,
    ...(arduinoState.lastTelemetry || {}),
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
  const multiplier = Math.floor(code / 100);

  if (base == 0) return 0;
  if (multiplier == 1) return base;
  if (multiplier == 2) return base * 2;
  if (multiplier == 3) return base * 3;

  return 0;
}

function codeToSegment(code) {
  if (!code || code <= 0) return null;
  if (code == 125) return 'S25';
  if (code == 225) return 'DBULL';

  const base = code % 100;
  const multiplier = Math.floor(code / 100);

  if (base == 0 || base > 20) return null;
  if (multiplier == 1) return 'S' + base;
  if (multiplier == 2) return 'D' + base;
  if (multiplier == 3) return 'T' + base;
  return null;
}

function codeToCricketNumber(code) {
  if (code === 125 || code === 225) return 25;
  const base = Number(code) % 100;
  return base >= 1 && base <= 20 ? base : null;
}

function codeToCricketHitCount(code) {
  if (code === 225) return 2;
  const multiplier = Math.floor(Number(code) / 100);
  return multiplier >= 1 && multiplier <= 3 ? multiplier : 0;
}

function pointsToSegment(points) {
  // Bestmögliche Segment-Bezeichnung für manuelle Würfe ermitteln
  if (points <= 0) return null;
  if (points === 50) return 'DBULL';
  if (points === 25) return 'S25';
  // Prüfen ob Triple
  for (let i = 1; i <= 20; i++) {
    if (points === i * 3) return 'T' + i;
  }
  // Prüfen ob Double
  for (let i = 1; i <= 20; i++) {
    if (points === i * 2) return 'D' + i;
  }
  // Single
  if (points >= 1 && points <= 20) return 'S' + points;
  return null;
}

function pointsToCricketNumber(points) {
  // Extrahiert die zugrundeliegende Zahl für Cricket aus dem Punktewert
  // T20=60 → 20, D20=40 → 20, S20=20 → 20, DBULL=50 → 25, S25=25 → 25
  if (points <= 0) return null;
  if (points === 50) return 25;
  if (points === 25) return 25;
  for (let i = 1; i <= 20; i++) {
    if (points === i * 3 || points === i * 2 || points === i) return i;
  }
  return null;
}

function getThrowHitCount(value) {
  // Single=1, Double=2, Triple=3, DBULL=2
  if (value === 50) return 2;
  for (let i = 1; i <= 20; i++) {
    if (value === i * 3) return 3;
    if (value === i * 2) return 2;
  }
  return 1;
}

function getCheckoutValue(player, finalThrowPoints) {
  const previousThrowPoints = Array.isArray(player && player.currentRoundPoints)
    ? player.currentRoundPoints.reduce((sum, points) => sum + (Number(points) || 0), 0)
    : 0;
  return Math.max(0, previousThrowPoints + (Number(finalThrowPoints) || 0));
}

function clearPendingArduinoThrow() {
  if (pendingArduinoThrowTimer) clearTimeout(pendingArduinoThrowTimer);
  pendingArduinoThrowTimer = null;
  pendingArduinoThrow = null;
}

async function recordPlayerLegStats(player, state) {
  try {
    await recordDuelLegIfActive(state, player);
    // Ensure player has stats entry
    await dataStore.initPlayerStats(player.slot);

    // Calculate leg average: (total_scored / darts_thrown) * 3
    const dartsThrawn = Number(player.turns || 0);
    const totalScored = Number(player.totalScored || 0);
    const legAvg = dartsThrawn > 0 ? (totalScored / dartsThrawn * 3) : 0;
    
    // Get current turn history to detect 180s and high scores
    const turns = player.turnHistory || [];
    let count180 = 0, count171 = 0, count140 = 0, count100 = 0;
    let maxScore = 0;
    
    turns.forEach(turn => {
      const score = Number(turn.points || 0);
      if (score === 180) count180++;
      if (score >= 171) count171++;
      if (score >= 140) count140++;
      if (score >= 100) count100++;
      maxScore = Math.max(maxScore, score);
    });

    // Determine checkout amount (initial score - 0)
    const mode = state.game.mode || DEFAULT_MODE;
    const modeDef = GAME_MODES[mode] || GAME_MODES[DEFAULT_MODE];
    const isCricket = modeDef.type === 'cricket';
    const checkout = isCricket || player.remaining !== 0
      ? 0
      : Math.min(170, Number(player.lastCheckoutValue || 0));
    
    // Record leg in history
    const won = player.remaining === 0 ? 1 : 0;
    await dataStore.recordLegHistory(player.slot, legAvg, checkout, won, dartsThrawn);

    // Update player stats
    const currentStats = await dataStore.getPlayerStats(player.slot) || {};
    const isTrackedDuel = Number(state.game?.duelId || 0) > 0;
    const updates = {
      legs_played: (Number(currentStats.legs_played || 0)) + 1,
      legs_won: (Number(currentStats.legs_won || 0)) + (won ? 1 : 0),
      total_darts: (Number(currentStats.total_darts || 0)) + dartsThrawn,
      total_scored: (Number(currentStats.total_scored || 0)) + totalScored,
      highest_leg_avg: Math.max(Number(currentStats.highest_leg_avg || 0), legAvg),
      max_score: Math.max(Number(currentStats.max_score || 0), maxScore),
      count_180: (Number(currentStats.count_180 || 0)) + count180,
      count_171plus: (Number(currentStats.count_171plus || 0)) + count171,
      count_140plus: (Number(currentStats.count_140plus || 0)) + count140,
      count_100plus: (Number(currentStats.count_100plus || 0)) + count100
    };
    if (!isTrackedDuel) {
      updates.games_played = Number(currentStats.games_played || 0) + 1;
      updates.games_won = Number(currentStats.games_won || 0) + (won ? 1 : 0);
    }

    // Add checkout stats if not cricket
    if (!isCricket) {
      updates.checkout_attempts = (Number(currentStats.checkout_attempts || 0)) + Number(player.checkoutAttempts || 0);
      if (Number(player.checkoutSuccess || 0) > 0 && checkout > 0) {
        updates.checkout_success = (Number(currentStats.checkout_success || 0)) + Number(player.checkoutSuccess || 0);
        updates.highest_checkout = Math.max(Number(currentStats.highest_checkout || 0), checkout);
        if (checkout >= 100) updates.checkout_100plus = (Number(currentStats.checkout_100plus || 0)) + 1;
        if (checkout >= 120) updates.checkout_120plus = (Number(currentStats.checkout_120plus || 0)) + 1;
        if (checkout >= 160) updates.checkout_160plus = (Number(currentStats.checkout_160plus || 0)) + 1;
      }
      for (const rule of ['single', 'double', 'master']) {
        const ruleStats = getCheckoutRuleStats(player, rule);
        updates[`checkout_${rule}_attempts`] = Number(currentStats[`checkout_${rule}_attempts`] || 0) + Number(ruleStats.attempts || 0);
        updates[`checkout_${rule}_success`] = Number(currentStats[`checkout_${rule}_success`] || 0) + Number(ruleStats.success || 0);
        updates[`checkout_${rule}_highest`] = Math.max(Number(currentStats[`checkout_${rule}_highest`] || 0), Math.min(170, Number(ruleStats.highest || 0)));
      }
    }

    // Add cricket stats if applicable
    if (isCricket) {
      updates.cricket_legs = (Number(currentStats.cricket_legs || 0)) + 1;
      updates.cricket_won = (Number(currentStats.cricket_won || 0)) + (won ? 1 : 0);
    }

    await dataStore.updatePlayerStats(player.slot, updates);
  } catch (err) {
    console.error('[Stats] Error recording player leg stats:', err);
  }
}

async function recordDuelLegIfActive(state, winner) {
  const duelId = Number(state.game?.duelId || 0);
  const mode = String(state.game?.mode || '');
  if (!duelId || !['501', '301', '701'].includes(mode)) return;
  const profiles = await dataStore.getProfiles();
  const profileByName = new Map(profiles.map(profile => [String(profile.name || '').trim().toLowerCase(), Number(profile.id)]));
  const players = (Array.isArray(state.players) ? state.players : []).map(player => {
    const throws = Array.isArray(player.throws) ? player.throws : [];
    const firstNine = throws.slice(0, 9);
    const firstNineScored = firstNine.reduce((sum, item) => sum + (item.bust ? 0 : Number(item.points || 0)), 0);
    const firstNineAvg = firstNine.length >= 9 ? roundAverage(firstNineScored / 9 * 3) : 0;
    const turnScores = [];
    for (let index = 0; index < throws.length; index += 3) {
      const turn = throws.slice(index, index + 3);
      if (turn.length < 3) continue;
      turnScores.push(turn.reduce((sum, item) => sum + (item.bust ? 0 : Number(item.points || 0)), 0));
    }
    return {
      slot: player.slot,
      profileId: profileByName.get(String(player.name || '').trim().toLowerCase()) || null,
      name: player.name,
      turns: player.turns,
      totalScored: player.totalScored,
      average: Number(player.turns || 0) > 0 ? roundAverage(Number(player.totalScored || 0) / Number(player.turns) * 3) : 0,
      firstNineAvg,
      bestTurn: player.bestTurn,
      count100plus: turnScores.filter(score => score >= 100).length,
      count140plus: turnScores.filter(score => score >= 140).length,
      count180: turnScores.filter(score => score === 180).length,
      checkoutAttempts: player.checkoutAttempts,
      checkoutSuccess: player.checkoutSuccess,
      lastCheckoutValue: player.lastCheckoutValue,
      busts: throws.filter(item => item.bust).length
    };
  });
  await dataStore.recordDuelLeg({
    duelId,
    mode,
    winnerSlot: winner.slot,
    startedAt: Number(state.game.startedAt || Date.now()),
    players
  });
}

async function advanceAfterBust(state, player, source) {
  if (state.game.status === 'leg-finished') return;
  const modeDef = GAME_MODES[state.game.mode] || GAME_MODES[DEFAULT_MODE];
  if (modeDef.type !== 'cricket' && modeDef.type !== 'elimination') {
    const turnPoints = Array.isArray(player.currentRoundPoints) ? player.currentRoundPoints : [];
    const committedPoints = turnPoints.slice(0, -1).reduce((sum, points) => sum + (Number(points) || 0), 0);
    player.remaining = Math.max(0, Number(player.remaining || 0) + committedPoints);
    player.totalScored = Math.max(0, Number(player.totalScored || 0) - committedPoints);
  }
  const playersInLeg = Array.isArray(state.players) ? state.players.length : 0;
  const isSinglePlayerLeg = playersInLeg <= 1;
  const delayMs = isSinglePlayerLeg
    ? Math.max(0, Number(runtimeTuning.singlePlayerSwitchDelayMs || 0))
    : Math.max(0, Number(runtimeTuning.playerSwitchDelayMs || 0));

  if (!state.lastAction) state.lastAction = {};

  state.lastAction.autoAdvancePending = true;
  state.lastAction.autoAdvanceDelayMs = delayMs;
  state.lastAction.autoAdvanceSinglePlayer = isSinglePlayerLeg;
  state.lastAction.autoAdvanceStartedAt = Date.now();
  state.lastAction.nextPlayer = null;
  state.lastAction.nextPlayerSlot = null;
  state.lastAction.nextSource = source;

  await saveLiveState(state);
  broadcastReload();

  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  player.currentRoundPoints = [];
  player.turnScoreRecorded = false;
  state.game.activePlayer = (state.game.activePlayer + 1) % state.players.length;
  state.game.currentThrow = 0;
  state.players[state.game.activePlayer].currentRoundPoints = [];
  state.players[state.game.activePlayer].turnScoreRecorded = false;
  if (state.game.activePlayer === 0) {
    state.game.throwRound = (Number(state.game.throwRound || 1) || 1) + 1;
  }
  state.lastAction.autoAdvancePending = false;
  state.lastAction.autoAdvanced = true;
  state.lastAction.nextPlayer = state.players[state.game.activePlayer].name;
  state.lastAction.nextPlayerSlot = state.players[state.game.activePlayer].slot;
}

async function advanceAfterThreeThrows(state, player, source) {
  if (state.game.status === 'leg-finished' || state.game.currentThrow < 3) return;
  const playersInLeg = Array.isArray(state.players) ? state.players.length : 0;
  const isSinglePlayerLeg = playersInLeg <= 1;
  const delayMs = isSinglePlayerLeg
    ? Math.max(0, Number(runtimeTuning.singlePlayerSwitchDelayMs || 0))
    : Math.max(0, Number(runtimeTuning.playerSwitchDelayMs || 0));

  // lastAction initialisieren falls null (Bugfix: Cannot set properties of null)
  if (!state.lastAction) state.lastAction = {};

  // Pending-Auto-Advance markieren (UI zeigt Countdown)
  state.lastAction.autoAdvancePending = true;
  state.lastAction.autoAdvanceDelayMs = delayMs;
  state.lastAction.autoAdvanceSinglePlayer = isSinglePlayerLeg;
  state.lastAction.autoAdvanceStartedAt = Date.now();
  state.lastAction.nextPlayer = null;
  state.lastAction.nextPlayerSlot = null;
  state.lastAction.nextSource = source;

  // State SOFORT speichern + broadcasten (3. Wurf sichtbar)
  await saveLiveState(state);
  broadcastReload();

  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  // Jetzt den echten Player-Switch durchführen
  player.currentRoundPoints = [];
  player.turnScoreRecorded = false;
  state.game.activePlayer = (state.game.activePlayer + 1) % state.players.length;
  state.game.currentThrow = 0;
  // Neuen aktiven Spieler's currentRoundPoints leeren
  state.players[state.game.activePlayer].currentRoundPoints = [];
  state.players[state.game.activePlayer].turnScoreRecorded = false;
  if (state.game.activePlayer === 0) {
    state.game.throwRound = (Number(state.game.throwRound || 1) || 1) + 1;
  }
  state.lastAction.autoAdvancePending = false;
  state.lastAction.autoAdvanced = true;
  state.lastAction.nextPlayer = state.players[state.game.activePlayer].name;
  state.lastAction.nextPlayerSlot = state.players[state.game.activePlayer].slot;
}

async function applyArduinoThrowFromChannel(channel, evt = {}) {
  const value = dartValueFromChannel(channel);
  if (value == null) return { ok: false, reason: 'unknown-channel', channel: formatChannel(channel) };

  const state = await getLiveState();
  await ensureAutomaticEncounter(state);
  if (!Array.isArray(state.players) || state.players.length === 0) return { ok: false, reason: 'no-players' };
  if (state.game.status === 'leg-finished') return { ok: false, reason: 'leg-finished' };

  const targetIndex = Number.isInteger(state.game.activePlayer) ? state.game.activePlayer : 0;
  const player = state.players[targetIndex];
  if (!player) return { ok: false, reason: 'no-active-player' };

  const mode = state.game.mode || DEFAULT_MODE;
  const modeDef = GAME_MODES[mode] || GAME_MODES[DEFAULT_MODE];
  const isCricket = modeDef.type === 'cricket';
  const isElimination = modeDef.type === 'elimination';
  const checkoutRule = state.game.checkoutRule || DEFAULT_CHECKOUT_RULE;
  const checkoutSegment = evt.segment || codeToSegment(evt.code) || null;
  const checkoutAttempt = !isCricket && !isElimination && isCheckoutAttempt(player.remaining, checkoutSegment, checkoutRule);
  if (checkoutAttempt) {
    player.checkoutAttempts = Number(player.checkoutAttempts || 0) + 1;
    getCheckoutRuleStats(player, checkoutRule).attempts += 1;
  }
  const remainingBeforeThrow = Number(player.remaining || 0);

  let bust = false;
  let eliminationAction = null;
  let cricketPointsAwarded = 0;
  if (isCricket) {
    const rawCode = Number(evt.code);
    const hasCode = Number.isFinite(rawCode) && rawCode >= 0 && rawCode <= 999;
    const cricketNum = hasCode ? codeToCricketNumber(rawCode) : pointsToCricketNumber(value);
    const nums = getCricketNumbersForMode(mode);
    if (nums && cricketNum !== null && nums.includes(cricketNum)) {
      const hitCount = hasCode ? codeToCricketHitCount(rawCode) : getThrowHitCount(value);
      cricketPointsAwarded = applyCricketHit(player, state.players, cricketNum, hitCount);
    }
  } else {
    if (isElimination) {
      const eliminationThrow = applyEliminationThrow(state, player, value);
      bust = eliminationThrow.bust;
      eliminationAction = eliminationThrow.eliminationAction;
    } else {
      const nextRemaining = player.remaining - value;
      bust = !isValidCheckout(player.remaining, value, checkoutRule, checkoutSegment);
      if (!bust) {
        player.remaining = nextRemaining;
        player.totalScored = Math.max(0, Number(player.totalScored || 0)) + value;
      }
    }
  }

  player.turns = Math.max(0, Number(player.turns || 0)) + 1;
  player.bestTurn = Math.max(Number(player.bestTurn || 0), value);

  if (!Array.isArray(player.currentRoundPoints)) player.currentRoundPoints = [];
  player.currentRoundPoints.push(value);

  if (!Array.isArray(player.throws)) player.throws = [];
  const throwSegment = evt.segment || codeToSegment(evt.code) || pointsToSegment(value) || 'MISS';
  player.throws.push({
    points: value,
    cricketPointsAwarded,
    remaining: player.remaining,
    bust,
    ts: Date.now(),
    source: 'arduino',
    segment: throwSegment,
    channel: formatChannel(channel),
    raw: evt.line || null
  });
  await dataStore.recordThrowSegment(player.slot, throwSegment, value, mode, bust, Date.now(), state.game.duelId);

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
    mode,
    cricketPointsAwarded
  };
  if (eliminationAction) Object.assign(state.lastAction, eliminationAction);

  if (!isCricket && !isElimination && player.remaining === 0) {
    player.lastCheckoutValue = getCheckoutValue(player, value);
    player.checkoutSuccess = Number(player.checkoutSuccess || 0) + 1;
    const ruleStats = getCheckoutRuleStats(player, checkoutRule);
    ruleStats.success += 1;
    ruleStats.highest = Math.max(ruleStats.highest, Math.min(170, remainingBeforeThrow));
    player.legs = Math.max(0, Number(player.legs || 0)) + 1;
    await addHighscore(player.name, player.lastCheckoutValue, { kind: 'checkout', legWin: true, source: 'arduino', gameMode: mode, checkoutRule });
    state.game.status = 'leg-finished';
    state.lastAction.legWin = true;
    state.lastAction.winner = player.name;
    state.lastAction.winnerSlot = player.slot;
    // Record stats after leg finish
    await recordPlayerLegStats(player, state);
  } else if (isCricket && checkCricketWin(player, state.players)) {
    player.legs = Math.max(0, Number(player.legs || 0)) + 1;
    await addHighscore(player.name, player.cricketPoints || 0, { kind: 'cricket', legWin: true, source: 'arduino', gameMode: mode });
    state.game.status = 'leg-finished';
    state.lastAction.cricketWin = true;
    state.lastAction.winner = player.name;
    state.lastAction.winnerSlot = player.slot;
    // Record stats after leg finish
    await recordPlayerLegStats(player, state);
  } else if (isElimination && checkEliminationWin(state)) {
    const winner = getEliminationWinner(state);
    if (winner) {
      winner.legs = Math.max(0, Number(winner.legs || 0)) + 1;
      await addHighscore(winner.name, winner.totalScored || 0, { kind: 'elimination', legWin: true, source: 'arduino', gameMode: mode });
      state.game.status = 'leg-finished';
      state.lastAction.eliminationWin = true;
      state.lastAction.winner = winner.name;
      state.lastAction.winnerSlot = winner.slot;
      // Record stats after leg finish
      await recordPlayerLegStats(winner, state);
    }
  }

  if (!bust) await addTurnScoreHighscoreIfNeeded(player, state, 'arduino');

  if (bust && state.game.status !== 'leg-finished') {
    await advanceAfterBust(state, player, 'arduino');
  } else if (state.game.status !== 'leg-finished' && state.game.currentThrow >= 3) {
    await advanceAfterThreeThrows(state, player, 'arduino');
  }

  const saved = await saveLiveState(state);
  broadcastReload();
  return { ok: true, value, player: player.name, playerSlot: player.slot, channel: formatChannel(channel), bust, remaining: player.remaining, state: saved };
}

async function applyArduinoMiss(evt = {}, reason = 'timeout') {
  const state = await getLiveState();
  await ensureAutomaticEncounter(state);
  if (!Array.isArray(state.players) || state.players.length === 0) return { ok: false, reason: 'no-players' };
  if (state.game.status === 'leg-finished') return { ok: false, reason: 'leg-finished' };

  const targetIndex = Number.isInteger(state.game.activePlayer) ? state.game.activePlayer : 0;
  const player = state.players[targetIndex];
  if (!player) return { ok: false, reason: 'no-active-player' };

  player.turns = Math.max(0, Number(player.turns || 0)) + 1;
  if (!Array.isArray(player.currentRoundPoints)) player.currentRoundPoints = [];
  player.currentRoundPoints.push(0);

  if (!Array.isArray(player.throws)) player.throws = [];
  const throwSegment = 'MISS';
  player.throws.push({
    points: 0,
    remaining: player.remaining,
    bust: false,
    ts: Date.now(),
    source: 'arduino-miss',
    reason,
    channel: evt.channel ? formatChannel(evt.channel) : null,
    segment: throwSegment,
    raw: evt.line || null
  });
  await dataStore.recordThrowSegment(player.slot, throwSegment, 0, state.game.mode, false, Date.now(), state.game.duelId);

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

  await addTurnScoreHighscoreIfNeeded(player, state, 'arduino-miss');

  if (state.game.currentThrow >= 3) {
    await advanceAfterThreeThrows(state, player, 'arduino-miss');
  }

  const saved = await saveLiveState(state);
  broadcastReload();
  return { ok: true, reason, player: player.name, playerSlot: player.slot, remaining: player.remaining, state: saved };
}

function updateMatrixSnifferState(row, column, active, evt = {}) {
  const ms = Number(evt.ms || 0);
  const edgeMs = Number.isFinite(ms) && ms > 0 ? ms : Date.now();

  if (row != null) {
    if (active) matrixSniffer.activeRows[row] = edgeMs;
    else delete matrixSniffer.activeRows[row];
  }
  if (column != null) {
    if (active) matrixSniffer.activeColumns[column] = edgeMs;
    else delete matrixSniffer.activeColumns[column];
  }

  const freshestRow = pickFreshestActiveSignal(matrixSniffer.activeRows);
  const freshestColumn = pickFreshestActiveSignal(matrixSniffer.activeColumns);
  const now = Date.now();

  if (freshestRow && freshestColumn) {
    const row = freshestRow.index;
    const column = freshestColumn.index;
    const pairSkew = Math.abs(Number(freshestRow.ts || 0) - Number(freshestColumn.ts || 0));
    if (pairSkew > runtimeTuning.matrixEvtPairMaxSkewMs) return;

    const key = `R${row},C${column}`;
    const mapped = MATRIX_ROW_COLUMN_VALUES[key];
    const code = mapped ? mapped.code : null;
    const points = mapped ? mapped.points : 0;

    if (!matrixSniffer.matrixHitActive || matrixSniffer.lastMatrixHitRow !== row || matrixSniffer.lastMatrixHitColumn !== column) {
      matrixSniffer.matrixHitActive = true;
      matrixSniffer.lastMatrixHitRow = row;
      matrixSniffer.lastMatrixHitColumn = column;
      matrixSniffer.lastMatrixHitPairMs = Number.isFinite(ms) && ms > 0 ? ms : edgeMs;

      if (now - matrixSniffer.lastMatrixHitMs >= runtimeTuning.matrixHitRefractoryMs) {
        const hit = {
          row: `R${row}`,
          column: `C${column}`,
          key,
          code,
          points,
          ms,
          ts: now,
          line: evt.line || '',
          mapped: !!mapped,
          source: 'arduino-matrix-evt'
        };
        queueMatrixHitCandidate(hit, now);
      }
    }
    return;
  }

  if (matrixSniffer.matrixHitActive && ms - matrixSniffer.lastMatrixHitPairMs >= runtimeTuning.matrixHitReleaseMs) {
    matrixSniffer.matrixHitActive = false;
    matrixSniffer.lastMatrixHitRow = null;
    matrixSniffer.lastMatrixHitColumn = null;
    normalizeArduinoStatePatch({ matrixSniffer: { ...matrixSniffer, lastMatrixHit: matrixSniffer.lastMatrixHit } });
  }
}

function handleArduinoMatrixHit(hit) {
  if (pendingArduinoThrow && !pendingArduinoThrow.applied) return;
  if (Date.now() < arduinoThrowLockUntil) return;
  if (runtimeTuning.throwMinIntervalMs > 0 && (Date.now() - lastAppliedThrowAt) < runtimeTuning.throwMinIntervalMs) return;
  if (!runtimeTuning.matrixAutoThrowEnabled) {
    normalizeArduinoStatePatch({
      lastAutoThrow: { ok: false, reason: 'matrix-auto-throw-disabled', hit: summarizeMatrixHit(hit) },
      lastAutoThrowError: 'matrix-auto-throw-disabled'
    });
    return;
  }

  arduinoProcessingPromise = arduinoProcessingPromise
    .catch(() => {})
    .then(() => applyArduinoThrowFromMatrix(hit))
    .then((result) => {
      if (result && result.ok) {
        const now = Date.now();
        lastAppliedThrowAt = now;
        arduinoThrowLockUntil = now + Math.max(0, runtimeTuning.arduinoMatrixThrowLockMs);
      }
      normalizeArduinoStatePatch({ lastAutoThrow: result.ok ? result : { ok: false, reason: result.reason }, lastAutoThrowError: result.ok ? null : result.reason });
    })
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
  const rawCode = Number(hit && hit.code);
  const rawPoints = Number(hit && hit.points);
  const hasCode = Number.isFinite(rawCode) && rawCode >= 0 && rawCode <= 999;
  const hasPoints = Number.isFinite(rawPoints) && rawPoints >= 0 && rawPoints <= 180;
  const decodedCodeValue = hasCode ? codeToPoints(rawCode) : null;
  const value = decodedCodeValue !== null && (decodedCodeValue > 0 || rawCode === 0)
    ? decodedCodeValue
    : (hasPoints ? rawPoints : null);
  if (value === null) return { ok: false, reason: 'invalid-points', hit };
  
  const state = await getLiveState();
  if (!Array.isArray(state.players) || state.players.length === 0) return { ok: false, reason: 'no-players' };
  if (state.game.status === 'leg-finished') return { ok: false, reason: 'leg-finished' };

  const targetIndex = Number.isInteger(state.game.activePlayer) ? state.game.activePlayer : 0;
  const player = state.players[targetIndex];
  if (!player) return { ok: false, reason: 'no-active-player' };

  const mode = state.game.mode || DEFAULT_MODE;
  const modeDef = GAME_MODES[mode] || GAME_MODES[DEFAULT_MODE];
  const isCricket = modeDef.type === 'cricket';
  const isElimination = modeDef.type === 'elimination';
  const checkoutRule = state.game.checkoutRule || DEFAULT_CHECKOUT_RULE;
  const throwSegment = codeToSegment(hit.code) || pointsToSegment(value) || 'MISS';
  const checkoutSegment = codeToSegment(hit.code) || pointsToSegment(value);
  const checkoutAttempt = !isCricket && !isElimination && isCheckoutAttempt(player.remaining, checkoutSegment, checkoutRule);
  if (checkoutAttempt) {
    player.checkoutAttempts = Number(player.checkoutAttempts || 0) + 1;
    getCheckoutRuleStats(player, checkoutRule).attempts += 1;
  }
  const remainingBeforeThrow = Number(player.remaining || 0);

  let bust = false;
  let eliminationAction = null;
  let cricketPointsAwarded = 0;
  if (isCricket) {
    const cricketNum = hasCode ? codeToCricketNumber(rawCode) : pointsToCricketNumber(value);
    const nums = getCricketNumbersForMode(mode);
    if (nums && cricketNum !== null && nums.includes(cricketNum)) {
      const hitCount = hasCode ? codeToCricketHitCount(rawCode) : getThrowHitCount(value);
      cricketPointsAwarded = applyCricketHit(player, state.players, cricketNum, hitCount);
    }
  } else {
    if (isElimination) {
      const eliminationThrow = applyEliminationThrow(state, player, value);
      bust = eliminationThrow.bust;
      eliminationAction = eliminationThrow.eliminationAction;
    } else {
      const checkoutRule = state.game.checkoutRule || DEFAULT_CHECKOUT_RULE;
      const nextRemaining = player.remaining - value;
      bust = !isValidCheckout(player.remaining, value, checkoutRule, checkoutSegment);
      if (!bust) {
        player.remaining = nextRemaining;
        player.totalScored = Math.max(0, Number(player.totalScored || 0)) + value;
      }
    }
  }

  player.turns = Math.max(0, Number(player.turns || 0)) + 1;
  player.bestTurn = Math.max(Number(player.bestTurn || 0), value);

  if (!Array.isArray(player.currentRoundPoints)) player.currentRoundPoints = [];
  player.currentRoundPoints.push(value);

  if (!Array.isArray(player.throws)) player.throws = [];
  player.throws.push({
    points: value,
    cricketPointsAwarded,
    remaining: player.remaining,
    bust,
    ts: Date.now(),
    source: 'arduino-matrix',
    segment: throwSegment,
    row: hit.row,
    column: hit.column,
    code: hit.code,
    channel: hit.key,
    raw: hit.line || null
  });
  await dataStore.recordThrowSegment(player.slot, throwSegment, value, mode, bust, Date.now(), state.game.duelId);

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
    mode,
    cricketPointsAwarded
  };
  if (eliminationAction) Object.assign(state.lastAction, eliminationAction);

  if (!isCricket && !isElimination && player.remaining === 0) {
    player.lastCheckoutValue = getCheckoutValue(player, value);
    player.checkoutSuccess = Number(player.checkoutSuccess || 0) + 1;
    const ruleStats = getCheckoutRuleStats(player, checkoutRule);
    ruleStats.success += 1;
    ruleStats.highest = Math.max(ruleStats.highest, Math.min(170, remainingBeforeThrow));
    player.legs = Math.max(0, Number(player.legs || 0)) + 1;
    await addHighscore(player.name, player.lastCheckoutValue, { kind: 'checkout', legWin: true, source: 'arduino-matrix', gameMode: mode, checkoutRule });
    state.game.status = 'leg-finished';
    state.lastAction.legWin = true;
    // Record stats after leg finish
    await recordPlayerLegStats(player, state);
  } else if (isCricket && checkCricketWin(player, state.players)) {
    player.legs = Math.max(0, Number(player.legs || 0)) + 1;
    await addHighscore(player.name, player.cricketPoints || 0, { kind: 'cricket', legWin: true, source: 'arduino-matrix', gameMode: mode });
    state.game.status = 'leg-finished';
    state.lastAction.cricketWin = true;
    state.lastAction.winner = player.name;
    state.lastAction.winnerSlot = player.slot;
    // Record stats after leg finish
    await recordPlayerLegStats(player, state);
  } else if (isElimination && checkEliminationWin(state)) {
    const winner = getEliminationWinner(state);
    if (winner) {
      winner.legs = Math.max(0, Number(winner.legs || 0)) + 1;
      await addHighscore(winner.name, winner.totalScored || 0, { kind: 'elimination', legWin: true, source: 'arduino-matrix', gameMode: mode });
      state.game.status = 'leg-finished';
      state.lastAction.eliminationWin = true;
      state.lastAction.winner = winner.name;
      state.lastAction.winnerSlot = winner.slot;
      // Record stats after leg finish
      await recordPlayerLegStats(winner, state);
    }
  }

  if (!bust) await addTurnScoreHighscoreIfNeeded(player, state, 'arduino-matrix');

  if (bust && state.game.status !== 'leg-finished') {
    await advanceAfterBust(state, player, 'arduino-matrix');
  } else if (state.game.status !== 'leg-finished' && state.game.currentThrow >= 3) {
    await advanceAfterThreeThrows(state, player, 'arduino-matrix');
  }

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
  }, runtimeTuning.arduinoThrowWindowMs);
  pendingArduinoThrowTimer = pendingArduinoThrow.timer;
  normalizeArduinoStatePatch({ pendingThrow: true, lastAutoThrow: null, lastMiss: null, lastAutoThrowError: null });
}

function handleArduinoActiveEvent(evt) {
  if (!ARDUINO_AUTO_THROW_ENABLED) return;
  if (ARDUINO_REQUIRE_THROW_TRIGGER && (!pendingArduinoThrow || pendingArduinoThrow.applied)) return;
  if (pendingArduinoThrow && Date.now() - pendingArduinoThrow.startedAt > runtimeTuning.arduinoThrowWindowMs) return;

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

  // PLAYER_SWITCH,<ms>
  const psMatch = clean.match(/^PLAYER_SWITCH,(\d+)$/i);
  if (psMatch) {
    const playerSwitchEvt = { ms: Number(psMatch[1]), ts: Date.now(), line: clean };
    normalizeArduinoStatePatch({ playerSwitch: playerSwitchEvt, lastLine: clean });
    arduinoProcessingPromise = arduinoProcessingPromise
      .catch(() => {})
      .then(async () => {
        const state = await getLiveState();
        if (!Array.isArray(state.players) || state.players.length === 0) return;
        const nextIdx = (state.game.activePlayer + 1) % state.players.length;
        state.game.activePlayer = nextIdx;
        state.game.currentThrow = 0;
        state.game.throwRound = (state.game.throwRound || 1) + 1;
        state.lastAction = { type: 'player-switch-btn', player: state.players[nextIdx].name, playerSlot: state.players[nextIdx].slot, ts: Date.now() };
        await saveLiveState(state);
        broadcastReload();
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

  // HIT/MATRIX,<ms>,R#,C#[,CODE,POINTS] (passiver Matrix-Sniffer - altes Format)
// NEUES FORMAT: HIT,<ms>,R#,C#,CODE=<code>,PTS=<pts>,SEG=<name>
  const hitMatch = clean.match(/^(?:HIT|MATRIX),(\d+),R(\d+),C(\d+)(?:,CODE=(-?\d+),PTS=(-?\d+),SEG=[^,]+)?$/i);
  if (hitMatch) {
    if (!runtimeTuning.arduinoMatrixRawEnabled) return;
    const row = `R${Number(hitMatch[2])}`;
    const column = `C${Number(hitMatch[3])}`;
    const key = `${row},${column}`;
    const mapped = MATRIX_ROW_COLUMN_VALUES[key];
    const rawCode = hitMatch[4] != null ? Number(hitMatch[4]) : null;
    const rawPoints = hitMatch[5] != null ? Number(hitMatch[5]) : null;
    const hit = {
      ms: Number(hitMatch[1]),
      row,
      column,
      key,
      code: Number.isFinite(rawCode) ? rawCode : (mapped ? mapped.code : null),
      points: Number.isFinite(rawPoints) ? rawPoints : (mapped ? mapped.points : 0),
      ts: Date.now(),
      line: clean,
      mapped: !!mapped,
      source: 'arduino-matrix-raw'
    };
    normalizeArduinoStatePatch({
      lastLine: clean,
      lastRawHit: { ...hit },
      matrixSniffer: { ...matrixSniffer, lastMatrixHit: matrixSniffer.lastMatrixHit }
    });
    const hitNow = Date.now();
    queueMatrixHitCandidate(hit, hitNow);
    return;
  }

  // Fallback: altes Format HIT,<ms>,R#,C#[,CODE,POINTS]
  const oldHitMatch = clean.match(/^(?:HIT|MATRIX),(\d+),R(\d+),C(\d+)(?:,(-?\d+),(-?\d+))?$/i);
  if (oldHitMatch) {
    if (!runtimeTuning.arduinoMatrixRawEnabled) return;
    const row = `R${Number(oldHitMatch[2])}`;
    const column = `C${Number(oldHitMatch[3])}`;
    const key = `${row},${column}`;
    const mapped = MATRIX_ROW_COLUMN_VALUES[key];
    const rawCode = oldHitMatch[4] != null ? Number(oldHitMatch[4]) : null;
    const rawPoints = oldHitMatch[5] != null ? Number(oldHitMatch[5]) : null;
    const hit = {
      ms: Number(oldHitMatch[1]),
      row,
      column,
      key,
      code: Number.isFinite(rawCode) ? rawCode : (mapped ? mapped.code : null),
      points: Number.isFinite(rawPoints) ? rawPoints : (mapped ? mapped.points : 0),
      ts: Date.now(),
      line: clean,
      mapped: !!mapped,
      source: 'arduino-matrix-raw'
    };
    normalizeArduinoStatePatch({
      lastLine: clean,
      lastRawHit: { ...hit },
      matrixSniffer: { ...matrixSniffer, lastMatrixHit: matrixSniffer.lastMatrixHit }
    });
    const hitNow = Date.now();
    queueMatrixHitCandidate(hit, hitNow);
    return;
  }

  // TEL,key=value,...  (optionale Sensor- und Diagnosewerte)
  const telemetryMatch = clean.match(/^TEL,(.+)$/i);
  if (telemetryMatch) {
    const values = { receivedAt: Date.now(), line: clean };
    telemetryMatch[1].split(',').forEach((part) => {
      const [key, value] = part.split('=');
      if (!key || value == null || !/^[-+]?\d+(?:\.\d+)?$/.test(value)) return;
      values[key.trim()] = Number(value);
    });
    normalizeArduinoStatePatch({ lastTelemetry: values });
    return;
  }

  // HB,<ms>,<key=value>...  (alle Heartbeat-Varianten)
  const hbMatch = clean.match(/^HB,(\d+),(.+)$/i);
  if (hbMatch) {
    const heartbeat = { ms: Number(hbMatch[1]), line: clean };
    hbMatch[2].split(',').forEach((part) => {
      const [key, value] = part.split('=');
      if (!key || value == null || !/^\d+(?:\.\d+)?$/.test(value)) return;
      heartbeat[key.trim()] = Number(value);
    });
    const activeCount = Number.isFinite(heartbeat.active) ? heartbeat.active : null;
    const rows = Number.isFinite(heartbeat.rows) ? heartbeat.rows : null;
    const columns = Number.isFinite(heartbeat.columns) ? heartbeat.columns : null;
    if (activeCount != null) maybeInferArduinoActiveState(activeCount, rows != null && columns != null ? Math.max(1, rows + columns) : 20);
    heartbeat.receivedAt = Date.now();
    normalizeArduinoStatePatch({
      activeCount,
      lastHeartbeatAt: heartbeat.receivedAt,
      lastHeartbeat: heartbeat,
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
  const current = await getLiveState();
  const fresh = await defaultLiveState(savedLiveMode, current.game?.selectedPlayerSlots);
  await dataStore.saveLiveState(fresh);
}

async function getActivePlayersForLive() {
  const players = (await getPlayers()).filter(p => p.active && String(p.name || '').trim());
  return players.map((p, index) => ({
    slot: p.slot, name: String(p.name).trim(),
    color: p.color || ['#e63946','#f4a261','#2a9d8f','#457b9d','#9b5de5','#f77f00'][index % 6]
  }));
}

async function defaultLiveState(mode, selectedPlayerSlots = null) {
  const m = mode || DEFAULT_MODE;
  const active = await getActivePlayersForLive();
  const selected = Array.isArray(selectedPlayerSlots)
    ? active.filter(player => selectedPlayerSlots.includes(Number(player.slot)))
    : active;
  const fallbackPlayers = selected.length > 0
    ? selected
    : active.length > 0
      ? active
      : [{ slot: 1, name: 'Spieler 1', color: '#e63946' }, { slot: 2, name: 'Spieler 2', color: '#f4a261' }];
  const startScore = getStartScoreForMode(m);

  return {
    game: { mode: m, checkoutRule: DEFAULT_CHECKOUT_RULE, status: 'running', startedAt: Date.now(), updatedAt: Date.now(), activePlayer: 0, throwRound: 1, currentThrow: 0, duelId: null },
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

  await addHighscore(player.name, turnScore, { kind, source, gameMode: state.game.mode });
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
  const cricketPoints = Number(player?.cricketPoints ?? player?.totalScored ?? 0);
  const checkoutAttempts = Math.max(0, Number(player?.checkoutAttempts || base.checkoutAttempts || 0));
  const checkoutSuccess = Math.max(0, Number(player?.checkoutSuccess || base.checkoutSuccess || 0));
  const lastCheckoutValue = Math.max(0, Math.min(170, Number(player?.lastCheckoutValue || base.lastCheckoutValue || 0)));
  const checkoutByRule = {};
  for (const rule of ['single', 'double', 'master']) {
    const source = player?.checkoutByRule?.[rule] || base.checkoutByRule?.[rule] || {};
    checkoutByRule[rule] = {
      attempts: Math.max(0, Number(source.attempts || 0)),
      success: Math.max(0, Number(source.success || 0)),
      highest: Math.max(0, Math.min(170, Number(source.highest || 0)))
    };
  }
  return { slot, name, color, remaining, legs, turns, totalScored, bestTurn, throws, currentRoundPoints, average, checkoutAttempts, checkoutSuccess, lastCheckoutValue, checkoutByRule, cricketHits, cricketClosed, cricketPoints, turnScoreRecorded: !!player?.turnScoreRecorded };
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
    checkoutAttempts: 0,
    checkoutSuccess: 0,
    lastCheckoutValue: 0,
    checkoutByRule: {
      single: { attempts: 0, success: 0, highest: 0 },
      double: { attempts: 0, success: 0, highest: 0 },
      master: { attempts: 0, success: 0, highest: 0 }
    },
    throws: [],
    currentRoundPoints: [],
    ...defaultPlayerCricketState(mode)
  }));

  return {
    game: {
      mode,
      checkoutRule: savedCheckoutRule || DEFAULT_CHECKOUT_RULE,
      status: 'running',
      startedAt: now,
      updatedAt: now,
      activePlayer: 0,
      throwRound: 1,
      currentThrow: 0,
      duelId: null,
      selectedPlayerSlots: players.map(player => Number(player.slot))
    },
    players,
    lastAction: null,
    arduino: { connected: false, lastEvent: null, activeCount: 0, heartbeatMs: null }
  };
}

let savedLiveStateTemplate = [];
let savedLiveMode = DEFAULT_MODE;
let savedCheckoutRule = DEFAULT_CHECKOUT_RULE;

async function getLiveState() {
  const mode = savedLiveMode || DEFAULT_MODE;
  const fallback = await defaultLiveState(mode);
  const saved = await dataStore.getLiveState(fallback);
  const arduinoView = buildArduinoStateView();
  const activePlayers = fallback.players;
  let selectedPlayerSlots = Array.isArray(saved.game?.selectedPlayerSlots)
    ? saved.game.selectedPlayerSlots.map(Number).filter(Number.isInteger)
    : activePlayers.map(player => Number(player.slot));
  if (!activePlayers.some(player => selectedPlayerSlots.includes(Number(player.slot)))) {
    selectedPlayerSlots = activePlayers.map(player => Number(player.slot));
  }
  const savedMode = String(saved.game?.mode || '');
  if (GAME_MODES[savedMode]) savedLiveMode = savedMode;
  // Restore or fallback checkout rule
  const savedRule = String(saved.game?.checkoutRule || '');
  if (CHECKOUT_RULES[savedRule]) savedCheckoutRule = savedRule;
  savedLiveStateTemplate = Array.isArray(saved.players) && saved.players.length > 0
    ? saved.players.map(p => ({ ...p, throws: Array.isArray(p.throws) ? p.throws : [], currentRoundPoints: Array.isArray(p.currentRoundPoints) ? p.currentRoundPoints : [] }))
    : activePlayers.filter(player => selectedPlayerSlots.includes(Number(player.slot)));
  const savedPlayers = Array.isArray(saved.players) && saved.players.length > 0 ? saved.players : activePlayers;
  const mergedPlayers = savedPlayers
    .filter(player => selectedPlayerSlots.includes(Number(player.slot)))
    .map((player, index) => sanitizePlayerState(player, activePlayers[index] || activePlayers[0]));

  activePlayers.forEach(player => {
    if (selectedPlayerSlots.includes(Number(player.slot)) && !mergedPlayers.some(p => Number(p.slot) === Number(player.slot)))
      mergedPlayers.push(sanitizePlayerState(player, player));
  });

  mergedPlayers.sort((a, b) => Number(a.slot || 0) - Number(b.slot || 0));

  const state = {
    game: {
      mode: String(saved.game?.mode || fallback.game.mode),
      checkoutRule: savedCheckoutRule || DEFAULT_CHECKOUT_RULE,
      status: String(saved.game?.status || fallback.game.status),
      startedAt: Number(saved.game?.startedAt || fallback.game.startedAt),
      updatedAt: Number(saved.game?.updatedAt || Date.now()),
      activePlayer: Math.min(Number(saved.game?.activePlayer || 0), mergedPlayers.length - 1),
      throwRound: Number(saved.game?.throwRound || 1),
      currentThrow: Number(saved.game?.currentThrow || 0),
      duelId: Number(saved.game?.duelId || 0) || null,
      selectedPlayerSlots: mergedPlayers.map(player => Number(player.slot))
    },
    players: mergedPlayers,
    lastAction: saved.lastAction || null,
    arduino: arduinoView
  };

  return state;
}

async function saveLiveState(state) {
  const safe = { ...state, game: { ...(state.game || {}), updatedAt: Date.now() } };
  // throws[] begrenzen, damit State nicht unendlich wächst (max 150 Würfe pro Spieler)
  if (Array.isArray(safe.players)) {
    safe.players.forEach(p => {
      if (Array.isArray(p.throws) && p.throws.length > 150) {
        p.throws = p.throws.slice(-150);
      }
    });
  }
  await dataStore.saveLiveState(safe);
  return safe;
}

async function getHighscores(gameMode = '') { return dataStore.getHighscores(500, gameMode); }

async function addHighscore(playerName, score, meta = {}) {
  const safeName = String(playerName || '').trim();
  const safeScore = Number(score || 0);
  if (!safeName || !Number.isFinite(safeScore) || safeScore <= 0) return;
  await dataStore.addHighscore({ player: safeName, score: safeScore, ts: Date.now(), legWin: !!meta.legWin, gameMode: meta.gameMode || meta.mode || null, ...meta });
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

// ── Geschützte Admin-Betriebsfunktionen ──
app.get('/api/admin/auth/status', (req, res) => {
  res.json({
    configured: Boolean(getAdminPinHash()),
    enabled: adminAuthEnabled,
    localNetwork: isLocalOrPrivateAddress(req.socket.remoteAddress),
    authenticated: !adminAuthEnabled || Boolean(getAdminSession(req)),
    sessionTtlMs: ADMIN_SESSION_TTL_MS
  });
});

app.post('/api/admin/auth/login', (req, res) => {
  if (!isLocalOrPrivateAddress(req.socket.remoteAddress)) return res.status(403).json({ error: 'Admin-Anmeldung nur aus dem lokalen Netz.' });
  if (!getAdminPinHash()) return res.status(503).json({ error: 'ADMIN_PIN_HASH ist auf dem Server noch nicht konfiguriert.' });
  if (!verifyAdminPin(req.body?.pin)) return res.status(401).json({ error: 'PIN ist ungültig.' });
  const token = createAdminSession();
  res.setHeader('Set-Cookie', `admin_session=${token}; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1000)}; Path=/`);
  res.json({ authenticated: true, expiresInMs: ADMIN_SESSION_TTL_MS });
});

app.post('/api/admin/auth/logout', (req, res) => {
  const token = getAdminSession(req);
  if (token) adminSessions.delete(token);
  res.setHeader('Set-Cookie', 'admin_session=; HttpOnly; SameSite=Strict; Max-Age=0; Path=/');
  res.json({ authenticated: false });
});

app.put('/api/admin/auth/config', requireAdminPinChange, (req, res) => {
  const enabled = req.body?.enabled === true;
  adminAuthEnabled = enabled;
  saveSettings({ ...getSettings(), adminAuthEnabled: enabled });
  res.json({ enabled: adminAuthEnabled });
});

app.get('/api/admin/backups', requireAdmin, (_req, res) => {
  res.json({
    areas: Object.keys(ADMIN_BACKUP_SOURCES),
    destinations: {
      local: true,
      usb: Boolean(BACKUP_USB_PATH),
      nextcloud: Boolean(NEXTCLOUD_WEBDAV_URL && NEXTCLOUD_USER && NEXTCLOUD_PASSWORD)
    },
    backups: listAdminBackups()
  });
});

app.post('/api/admin/backups', requireAdmin, async (req, res) => {
  try {
    const manifest = await createAdminBackup(req.body?.areas, req.body?.destination);
    res.status(201).json(manifest);
  } catch (err) {
    res.status(400).json({ error: 'Backup konnte nicht erstellt werden: ' + err.message });
  }
});

app.get('/api/admin/backups/:id/:file', requireAdmin, (req, res) => {
  const backupId = String(req.params.id || '');
  const fileName = path.basename(String(req.params.file || ''));
  if (!/^[0-9TZ]+$/.test(backupId) || !fileName || fileName !== req.params.file) return res.status(400).json({ error: 'Ungültiger Backup-Pfad.' });
  const manifest = readJson(path.join(ADMIN_BACKUP_DIR, backupId, 'manifest.json'), null);
  if (!manifest || !manifest.files.some(file => file.file === fileName)) return res.status(404).json({ error: 'Backup-Datei nicht gefunden.' });
  res.download(path.join(ADMIN_BACKUP_DIR, backupId, fileName), fileName);
});

// ── Spielmodi ──
app.get('/api/game/modes', (_req, res) => {
  res.json(GAME_MODES);
});

app.get('/api/game/checkout-rules', (_req, res) => {
  res.json(CHECKOUT_RULES);
});

app.post('/api/game/mode', async (req, res) => {
  const mode = String(req.body?.mode || '').trim();
  if (!GAME_MODES[mode]) return res.status(400).json({ error: `Unbekannter Modus: ${mode}` });
  try {
    savedLiveMode = mode;
    const fresh = resetLiveState(false, mode);
    await ensureAutomaticEncounter(fresh);
    const saved = await saveLiveState(fresh);
    broadcastReload();
    res.json(saved);
  } catch (err) { res.status(500).json({ error: 'Modus-Wechsel fehlgeschlagen: ' + err.message }); }
});

app.post('/api/game/checkout-rule', async (req, res) => {
  const rule = String(req.body?.rule || '').trim();
  if (!CHECKOUT_RULES[rule]) return res.status(400).json({ error: `Unbekannte Regel: ${rule}` });
  try {
    savedCheckoutRule = rule;
    // Apply to current state
    const state = await getLiveState();
    state.game.checkoutRule = rule;
    state.game.updatedAt = Date.now();
    const saved = await saveLiveState(state);
    broadcastReload();
    res.json(saved);
  } catch (err) { res.status(500).json({ error: 'Regel-Wechsel fehlgeschlagen: ' + err.message }); }
});

// ── Players ──
app.get('/api/players', async (_req, res) => {
  try { res.json(await getPlayers()); }
  catch (err) { res.status(500).json({ error: 'Spieler konnten nicht geladen werden: ' + err.message }); }
});

app.put('/api/players', requireLocalNetwork, async (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Array erwartet' });
  try {
    await savePlayers(req.body);
    broadcastReload();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Spieler konnten nicht gespeichert werden: ' + err.message });
  }
});

app.post('/api/live/players', async (req, res) => {
  const requested = Array.isArray(req.body?.playerSlots) ? req.body.playerSlots.map(Number) : [];
  const slots = [...new Set(requested)].filter(slot => Number.isInteger(slot) && slot > 0).sort((a, b) => a - b);
  if (slots.length < 1 || slots.length > 8) return res.status(400).json({ error: 'Bitte 1 bis 8 Spieler auswählen.' });
  try {
    const available = await getActivePlayersForLive();
    const availableSlots = new Set(available.map(player => Number(player.slot)));
    if (slots.some(slot => !availableSlots.has(slot))) return res.status(400).json({ error: 'Auswahl enthält keinen aktiven Spieler.' });
    const fresh = await defaultLiveState(savedLiveMode, slots);
    fresh.game.selectedPlayerSlots = slots;
    await ensureAutomaticEncounter(fresh);
    const saved = await saveLiveState(fresh);
    broadcastReload();
    res.json(saved);
  } catch (err) { res.status(500).json({ error: 'Spielerauswahl konnte nicht gespeichert werden: ' + err.message }); }
});

// ── Profile ──
app.get('/api/profiles', async (_req, res) => {
  try { res.json(await dataStore.getProfiles()); }
  catch (err) { res.status(500).json({ error: 'Profile konnten nicht geladen werden: ' + err.message }); }
});

app.put('/api/profiles', requireLocalNetwork, async (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Array erwartet' });
  try {
    await dataStore.saveProfiles(req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Profile konnten nicht gespeichert werden: ' + err.message });
  }
});

// ── Storage-Info ──
app.get('/api/storage/info', (_req, res) => { res.json(dataStore.getInfo()); });
app.get('/api/storage/status', async (_req, res) => {
  try { res.json(await dataStore.getStorageStatus()); }
  catch (err) { res.status(500).json({ error: 'Speicherstatus konnte nicht geladen werden: ' + err.message }); }
});

// ── Settings ──
app.get('/api/settings', (_req, res) => res.json(getSettings()));
app.put('/api/settings', requireAdmin, (req, res) => {
  const current = getSettings();
  const next = req.body && typeof req.body === 'object' ? req.body : {};
  const s = { ...current, ...next };
  saveSettings(s);
  refreshRuntimeTuning(s);
  const shouldRestartArduinoMonitor = [
    'arduinoMonitorEnabled',
    'arduinoPort',
    'arduinoBaudRate'
  ].some((key) => current[key] !== s[key]);
  if (shouldRestartArduinoMonitor) restartArduinoMonitor();
  broadcastReload();
  res.json(s);
});

app.get('/api/matrix-mapping', (_req, res) => {
  res.json({ updatedAt: arduinoState.matrixMappingUpdatedAt || null, mapping: MATRIX_CODE_BY_ROW_COLUMN });
});

app.put('/api/matrix-mapping', requireAdmin, (req, res) => {
  const payload = req.body && typeof req.body === 'object' && !Array.isArray(req.body) && req.body.mapping
    ? req.body.mapping
    : req.body;
  const mapping = saveMatrixMapping(payload);
  broadcastReload();
  res.json({ ok: true, updatedAt: arduinoState.matrixMappingUpdatedAt || Date.now(), mapping });
});

// ── Server-Info ──
app.get('/api/server-info', (_req, res) => {
  const ip = getLocalIP();
  res.json({
    ip,
    port: BROWSER_PORT,
    browserPort: BROWSER_PORT,
    fireTvPort: FIRETV_PORT,
    url: 'http://' + ip + ':' + BROWSER_PORT,
    browserUrl: 'http://' + ip + ':' + BROWSER_PORT,
    fireTvUrl: 'http://' + ip + ':' + FIRETV_PORT
  });
});

app.get('/api/system/diagnostics', (_req, res) => {
  res.json(getSystemDiagnostics());
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

app.get('/api/duels', async (req, res) => {
  const category = String(req.query.category || 'all').trim().toLowerCase();
  if (!['all', 'duel', 'group'].includes(category)) return res.status(400).json({ error: 'category muss all, duel oder group sein.' });
  try {
    const duels = await dataStore.listDuels(req.query.limit || 20);
    res.json(category === 'all' ? duels : duels.filter(duel => duel.category === category));
  }
  catch (err) { res.status(500).json({ error: 'Begegnungen konnten nicht geladen werden: ' + err.message }); }
});

app.get('/api/duels/current', async (_req, res) => {
  try {
    const state = await getLiveState();
    const duel = state.game.duelId ? await dataStore.getDuel(state.game.duelId) : null;
    res.json(duel || null);
  } catch (err) { res.status(500).json({ error: 'Aktuelle Begegnung konnte nicht geladen werden: ' + err.message }); }
});

app.get('/api/duels/top', async (req, res) => {
  try {
    const duels = await dataStore.listDuels(100);
    const top = duels
      .filter(duel => ['501', '301', '701'].includes(String(duel.mode)))
      .sort((a, b) => Number(b.total_legs || 0) - Number(a.total_legs || 0) || Number(b.participant_count || 0) - Number(a.participant_count || 0))
      .slice(0, 20);
    res.json(top);
  } catch (err) { res.status(500).json({ error: 'Top-Begegnungen konnten nicht geladen werden: ' + err.message }); }
});

app.get('/api/duel-stats', async (req, res) => {
  const slots = String(req.query.playerSlots || '').split(',').map(Number).filter(Number.isInteger).filter(slot => slot > 0).sort((a, b) => a - b);
  if (slots.length > 8) return res.status(400).json({ error: 'playerSlots darf höchstens 8 Slots enthalten.' });
  const exactGroup = String(req.query.exact || 'false').toLowerCase() === 'true';
  const category = String(req.query.category || 'all').trim().toLowerCase();
  if (!['all', 'duel', 'group'].includes(category)) return res.status(400).json({ error: 'category muss all, duel oder group sein.' });
  try {
    const duels = await dataStore.listDuels(100);
    const wanted = slots.join('-');
    const matching = duels.filter(duel => {
      if (category !== 'all' && duel.category !== category) return false;
      const participantSlots = (duel.players || []).map(player => Number(player.player_slot)).sort((a, b) => a - b);
      const key = participantSlots.join('-');
      if (!slots.length) return true;
      return exactGroup ? key === wanted : slots.every(slot => participantSlots.includes(slot));
    });
    const aggregate = new Map();
    let totalLegs = 0;
    for (const duel of matching) {
      for (const leg of duel.legs || []) {
        totalLegs += 1;
        for (const player of leg.players || []) {
          if (slots.length && !slots.includes(Number(player.player_slot))) continue;
          const key = Number(player.player_slot);
          const current = aggregate.get(key) || { slot: key, name: player.player_name, legs: 0, wins: 0, darts: 0, scored: 0, average: 0, bestTurn: 0, count100plus: 0, count140plus: 0, count180: 0, checkoutAttempts: 0, checkoutSuccess: 0, busts: 0 };
          current.legs += 1;
          current.wins += Number(player.won || 0);
          current.darts += Number(player.darts || 0);
          current.scored += Number(player.scored || 0);
          current.bestTurn = Math.max(current.bestTurn, Number(player.best_turn || 0));
          current.count100plus += Number(player.count_100plus || 0);
          current.count140plus += Number(player.count_140plus || 0);
          current.count180 += Number(player.count_180 || 0);
          current.checkoutAttempts += Number(player.checkout_attempts || 0);
          current.checkoutSuccess += Number(player.checkout_success || 0);
          current.busts += Number(player.busts || 0);
          current.average = current.darts > 0 ? roundAverage(current.scored / current.darts * 3) : 0;
          aggregate.set(key, current);
        }
      }
    }
    res.json({ category, playerSlots: slots, exactGroup, duels: matching.length, legs: totalLegs, players: Array.from(aggregate.values()) });
  } catch (err) { res.status(500).json({ error: 'Duellstatistik konnte nicht geladen werden: ' + err.message }); }
});

app.get('/api/duels/:id', async (req, res) => {
  try {
    const duel = await dataStore.getDuel(req.params.id);
    if (!duel) return res.status(404).json({ error: 'Begegnung nicht gefunden.' });
    res.json(duel);
  } catch (err) { res.status(500).json({ error: 'Begegnung konnte nicht geladen werden: ' + err.message }); }
});

app.post('/api/duels/start', requireAdmin, async (req, res) => {
  res.status(410).json({ error: 'Begegnungen werden automatisch erkannt und können nicht manuell gestartet werden.' });
});

app.post('/api/duels/:id/finish', requireAdmin, async (req, res) => {
  try {
    const state = await getLiveState();
    if (Number(state.game.duelId) !== Number(req.params.id)) return res.status(409).json({ error: 'Diese Begegnung ist nicht aktiv.' });
    const winnerSlot = Number(req.body?.winnerSlot || 0) || null;
    const duel = await dataStore.finishDuel(req.params.id, winnerSlot);
    if (winnerSlot) {
      await dataStore.initPlayerStats(winnerSlot);
      const winnerStats = await dataStore.getPlayerStats(winnerSlot) || {};
      await dataStore.updatePlayerStats(winnerSlot, {
        games_won: Number(winnerStats.games_won || 0) + 1
      });
    }
    state.game.duelId = null;
    await saveLiveState(state);
    broadcastReload();
    res.json(duel);
  } catch (err) { res.status(500).json({ error: 'Begegnung konnte nicht beendet werden: ' + err.message }); }
});

app.post('/api/live/reset', async (req, res) => {
  const carryLegs = !!(req.body && req.body.carryLegs);
  try {
    const mode = savedLiveMode || DEFAULT_MODE;
    const current = await getLiveState();
    const fresh = resetLiveState(carryLegs, mode);
    const duel = current.game.duelId ? await dataStore.getDuel(current.game.duelId) : null;
    const currentSlots = current.players.map(player => Number(player.slot)).sort((a, b) => a - b).join('-');
    const duelSlots = duel ? duel.players.map(player => Number(player.player_slot)).sort((a, b) => a - b).join('-') : '';
    fresh.game.duelId = duel && currentSlots === duelSlots ? duel.id : null;
    await ensureAutomaticEncounter(fresh);
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
    await ensureAutomaticEncounter(state);
    if (state.game.status === 'leg-finished') return res.status(400).json({ error: 'Spiel ist bereits beendet.' });
    if (targetIndex >= state.players.length) return res.status(400).json({ error: 'Spieler nicht gefunden.' });

    const player = state.players[targetIndex];
    const mode = state.game.mode || DEFAULT_MODE;
    const modeDef = GAME_MODES[mode] || GAME_MODES[DEFAULT_MODE];
    const isCricket = modeDef.type === 'cricket';
    const isElimination = modeDef.type === 'elimination';
    const checkoutRule = state.game.checkoutRule || DEFAULT_CHECKOUT_RULE;
    const incomingSegment = typeof req.body?.segment === 'string' ? req.body.segment.toUpperCase() : pointsToSegment(points);
    const checkoutAttempt = !isCricket && !isElimination && isCheckoutAttempt(player.remaining, incomingSegment, checkoutRule);
    if (checkoutAttempt) {
      player.checkoutAttempts = Number(player.checkoutAttempts || 0) + 1;
      getCheckoutRuleStats(player, checkoutRule).attempts += 1;
    }
    const remainingBeforeThrow = Number(player.remaining || 0);

    let bust = false;
    let eliminationAction = null;
    let cricketPointsAwarded = 0;
    if (isCricket) {
      const dartNumber = Number(req.body?.number || points);
      const multiplier = Number(req.body?.multiplier || 1);
      if ([15,16,17,18,19,20,25].includes(dartNumber)) {
        cricketPointsAwarded = applyCricketHit(player, state.players, dartNumber, multiplier);
      }
    } else {
      if (isElimination) {
        const eliminationThrow = applyEliminationThrow(state, player, points);
        bust = eliminationThrow.bust;
        eliminationAction = eliminationThrow.eliminationAction;
      } else {
        const nextRemaining = player.remaining - points;
        bust = !isValidCheckout(player.remaining, points, checkoutRule, incomingSegment);
        if (!bust) { player.remaining = nextRemaining; player.totalScored += points; }
      }
    }

    player.turns += 1;
    player.bestTurn = Math.max(player.bestTurn, points);

    if (!Array.isArray(player.currentRoundPoints)) player.currentRoundPoints = [];
    player.currentRoundPoints.push(points);

    if (!Array.isArray(player.throws)) player.throws = [];
    const throwSegment = incomingSegment;
    player.throws.push({ points, remaining: player.remaining, bust, ts: Date.now(), mode, segment: throwSegment });
    await dataStore.recordThrowSegment(player.slot, throwSegment, points, mode, bust, Date.now(), state.game.duelId);

    player.average = calculateCurrentRoundAverage(player);
    state.game.currentThrow = (state.game.currentThrow || 0) + 1;

    state.lastAction = {
      type: 'throw', playerIndex: targetIndex, playerSlot: player.slot, player: player.name,
      points, bust, remaining: player.remaining, roundThrow: state.game.currentThrow, ts: Date.now(), mode,
      segment: throwSegment,
      cricketPointsAwarded
    };
    if (eliminationAction) Object.assign(state.lastAction, eliminationAction);

    if (!isCricket && !isElimination && player.remaining === 0) {
      player.lastCheckoutValue = getCheckoutValue(player, points);
      player.checkoutSuccess = Number(player.checkoutSuccess || 0) + 1;
      const ruleStats = getCheckoutRuleStats(player, checkoutRule);
      ruleStats.success += 1;
      ruleStats.highest = Math.max(ruleStats.highest, Math.min(170, remainingBeforeThrow));
      player.legs += 1;
      await addHighscore(player.name, player.lastCheckoutValue, { kind: 'checkout', legWin: true, gameMode: mode, checkoutRule });
      state.game.status = 'leg-finished';
      // Record stats after leg finish
      await recordPlayerLegStats(player, state);
    } else if (isCricket && checkCricketWin(player, state.players)) {
      player.legs += 1;
      await addHighscore(player.name, player.cricketPoints || 0, { kind: 'cricket', legWin: true, gameMode: mode });
      state.game.status = 'leg-finished';
      state.lastAction.cricketWin = true;
      state.lastAction.winner = player.name;
      state.lastAction.winnerSlot = player.slot;
      // Record stats after leg finish
      await recordPlayerLegStats(player, state);
    } else if (isElimination && checkEliminationWin(state)) {
      const winner = getEliminationWinner(state);
      if (winner) {
        winner.legs += 1;
        await addHighscore(winner.name, winner.totalScored || 0, { kind: 'elimination', legWin: true, gameMode: mode });
        state.game.status = 'leg-finished';
        state.lastAction.eliminationWin = true;
        state.lastAction.winner = winner.name;
        state.lastAction.winnerSlot = winner.slot;
        // Record stats after leg finish
        await recordPlayerLegStats(winner, state);
      }
    }

    if (!bust) await addTurnScoreHighscoreIfNeeded(player, state, 'manual');

    if (bust && state.game.status !== 'leg-finished') {
      await advanceAfterBust(state, player, 'manual');
    } else if (state.game.status !== 'leg-finished' && state.game.currentThrow >= 3) {
      await advanceAfterThreeThrows(state, player, 'manual');
    }

    const saved = await saveLiveState(state);
    broadcastReload();
    res.json(saved);
  } catch (err) { res.status(500).json({ error: 'Wurf konnte nicht gespeichert werden: ' + err.message }); }
});

app.post('/api/live/next-player', async (req, res) => {
  try {
    const state = await getLiveState();
    if (state.game.status === 'leg-finished') return res.status(400).json({ error: 'Spiel ist bereits beendet.' });
    const currentPlayer = state.players[state.game.activePlayer];
    if (currentPlayer && Array.isArray(currentPlayer.currentRoundPoints)) {
      while (currentPlayer.currentRoundPoints.length < 3) {
        currentPlayer.currentRoundPoints.push(0);
        currentPlayer.turns += 1;
        if (!Array.isArray(currentPlayer.throws)) currentPlayer.throws = [];
        currentPlayer.throws.push({
          points: 0,
          remaining: currentPlayer.remaining,
          bust: false,
          segment: 'MISS',
          source: 'manual-miss',
          ts: Date.now(),
          mode: state.game.mode
        });
      }
    }
    const nextIndex = (state.game.activePlayer + 1) % state.players.length;
    state.game.activePlayer = nextIndex;
    state.game.currentThrow = 0;
    state.game.throwRound = (state.game.throwRound || 1) + 1;
    // Neuen aktiven Spieler's currentRoundPoints leeren
    state.players[nextIndex].currentRoundPoints = [];
    state.players[nextIndex].turnScoreRecorded = false;
    state.lastAction = { type: 'next-player', player: state.players[nextIndex].name, playerSlot: state.players[nextIndex].slot, ts: Date.now() };
    const saved = await saveLiveState(state);
    broadcastReload();
    res.json(saved);
  } catch (err) { res.status(500).json({ error: 'Next-Player fehlgeschlagen: ' + err.message }); }
});

app.post('/api/live/undo', async (req, res) => {
  try {
    const state = await getLiveState();
    if (state.game.status === 'leg-finished') return res.status(400).json({ error: 'Spiel ist bereits beendet.' });
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
  try { res.json(await getHighscores(_req.query.gameMode)); }
  catch (err) { res.status(500).json({ error: 'Highscores konnten nicht geladen werden: ' + err.message }); }
});

app.post('/api/highscores', requireAdmin, async (req, res) => {
  const player = String(req.body && req.body.player || '').trim();
  const score = Number(req.body && req.body.score);
  if (!player || !Number.isFinite(score) || score <= 0) return res.status(400).json({ error: 'player und positive score erforderlich.' });
  try {
    await addHighscore(player, score, { kind: 'manual' });
    res.json({ ok: true, highscores: await getHighscores() });
  } catch (err) { res.status(500).json({ error: 'Highscore konnte nicht gespeichert werden: ' + err.message }); }
});

app.delete('/api/highscores/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Ungültige ID.' });
  try {
    await dataStore.deleteHighscore(id);
    res.json({ ok: true, highscores: await getHighscores() });
  } catch (err) { res.status(500).json({ error: 'Highscore konnte nicht gelöscht werden: ' + err.message }); }
});

app.put('/api/highscores/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const player = String(req.body?.player || '').trim();
  const score = Number(req.body?.score);
  if (!Number.isFinite(id) || id <= 0 || !player || !Number.isFinite(score) || score <= 0) {
    return res.status(400).json({ error: 'Gültige ID, Spieler und positiver Score erforderlich.' });
  }
  try {
    await dataStore.updateHighscore(id, player, score);
    res.json({ ok: true, highscores: await getHighscores() });
  } catch (err) { res.status(500).json({ error: 'Highscore konnte nicht bearbeitet werden: ' + err.message }); }
});

app.delete('/api/highscores', requireAdmin, async (_req, res) => {
  try {
    await dataStore.clearAllHighscores();
    res.json({ ok: true, highscores: [] });
  } catch (err) { res.status(500).json({ error: 'Highscores konnten nicht gelöscht werden: ' + err.message }); }
});

// ── Täglicher Höchstwert ──
app.get('/api/highscores/daily', async (_req, res) => {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const fromTs = todayStart.getTime();
    const all = await getHighscores();
    const today = all.filter(e => Number(e.ts) >= fromTs).sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || Number(b.ts || 0) - Number(a.ts || 0));
    const best = today.length > 0 ? today[0] : null;
    res.json({ best, count: today.length, list: today });
  } catch (err) { res.status(500).json({ error: 'Daily-Highscore fehlgeschlagen: ' + err.message }); }
});

app.get('/api/highscores/overview', async (_req, res) => {
  try {
    const players = await dataStore.getPlayers();
    const entries = [];
    for (const player of players) {
      if (!player.name) continue;
      if (!player.active) continue;
      const stats = await dataStore.getPlayerStats(player.slot) || {};
      const darts = Number(stats.total_darts || 0);
      const totalScored = Number(stats.total_scored || 0);
      const checkoutAttempts = Number(stats.checkout_attempts || 0);
      const checkoutSuccess = Number(stats.checkout_success || 0);
      const checkoutByRule = {};
      for (const rule of ['single', 'double', 'master']) {
        const attempts = Number(stats[`checkout_${rule}_attempts`] || 0);
        const success = Number(stats[`checkout_${rule}_success`] || 0);
        checkoutByRule[rule] = {
          attempts,
          success,
          rate: attempts > 0 ? Number((success / attempts * 100).toFixed(1)) : 0,
          highest: Math.min(170, Number(stats[`checkout_${rule}_highest`] || 0))
        };
      }
      entries.push({
        profileId: Number(player.slot),
        player: player.name,
        mode: 'gesamt',
        count180: Number(stats.count_180 || 0),
        threeDartAverage: darts > 0 ? Number((totalScored / darts * 3).toFixed(1)) : 0,
        checkoutRate: checkoutAttempts > 0 ? Number((checkoutSuccess / checkoutAttempts * 100).toFixed(1)) : 0,
        checkoutAttempts,
        checkoutSuccess,
        checkoutByRule,
        highestCheckout: Number(stats.highest_checkout || 0),
        gamesPlayed: Number(stats.games_played || 0),
        gamesWon: Number(stats.games_won || 0),
        legsWon: Number(stats.legs_won || 0),
        trackingSince: stats.updated_at ? Number(stats.updated_at) : null
      });
    }
    const ranked = (field, predicate = value => value > 0) => entries
      .filter(entry => predicate(entry[field], entry))
      .sort((a, b) => b[field] - a[field]);
    res.json({ trackingMode: 'gesamt', modes: ['gesamt'], players: entries.map(entry => ({ profileId: entry.profileId, player: entry.player })), metrics: {
      count180: ranked('count180'),
      checkoutRate: ranked('checkoutRate', (_value, entry) => entry.checkoutAttempts > 0),
      checkoutRateSingle: entries.filter(entry => entry.checkoutByRule.single.attempts > 0).map(entry => ({ ...entry, checkoutRateSingle: entry.checkoutByRule.single.rate })).sort((a, b) => b.checkoutRateSingle - a.checkoutRateSingle),
      checkoutRateDouble: entries.filter(entry => entry.checkoutByRule.double.attempts > 0).map(entry => ({ ...entry, checkoutRateDouble: entry.checkoutByRule.double.rate })).sort((a, b) => b.checkoutRateDouble - a.checkoutRateDouble),
      checkoutRateMaster: entries.filter(entry => entry.checkoutByRule.master.attempts > 0).map(entry => ({ ...entry, checkoutRateMaster: entry.checkoutByRule.master.rate })).sort((a, b) => b.checkoutRateMaster - a.checkoutRateMaster),
      threeDartAverage: ranked('threeDartAverage'),
      highestCheckout: ranked('highestCheckout'),
      gamesPlayed: ranked('gamesPlayed'),
      gamesWon: ranked('gamesWon')
    }});
  } catch (err) {
    res.status(500).json({ error: 'Highscore-Übersicht konnte nicht geladen werden: ' + err.message });
  }
});

// ── Player Statistics ──
app.get('/api/players/:id/stats', async (req, res) => {
  try {
    const playerId = Number(req.params.id);
    if (!Number.isInteger(playerId) || playerId < 0) {
      return res.status(400).json({ error: 'Invalid player ID' });
    }
    let stats = await dataStore.getPlayerStats(playerId);
    if (!stats) {
      await dataStore.initPlayerStats(playerId);
      stats = await dataStore.getPlayerStats(playerId);
    }
    res.json(stats || {});
  } catch (err) {
    res.status(500).json({ error: 'Stats konnten nicht geladen werden: ' + err.message });
  }
});

app.get('/api/players/:id/segment-analysis', async (req, res) => {
  try {
    const playerId = Number(req.params.id);
    if (!Number.isInteger(playerId) || playerId < 1) return res.status(400).json({ error: 'Invalid player ID' });
    const mode = String(req.query.mode || '').trim();
    const duelId = Number(req.query.duelId || 0) || null;
    res.json(await dataStore.getSegmentAnalysis(playerId, mode, duelId));
  } catch (err) {
    res.status(500).json({ error: 'Segmentanalyse konnte nicht geladen werden: ' + err.message });
  }
});

app.get('/api/duels/:id/segment-analysis', async (req, res) => {
  try {
    const duelId = Number(req.params.id);
    if (!Number.isInteger(duelId) || duelId < 1) return res.status(400).json({ error: 'Invalid duel ID' });
    const duel = await dataStore.getDuel(duelId);
    if (!duel) return res.status(404).json({ error: 'Begegnung nicht gefunden' });
    const mode = String(req.query.mode || duel.mode || '').trim();
    const players = await Promise.all((duel.players || []).map(async player => ({
      slot: Number(player.player_slot),
      name: player.player_name || 'Spieler',
      analysis: await dataStore.getSegmentAnalysis(Number(player.player_slot), mode, duelId)
    })));
    res.json({ duelId, mode, players });
  } catch (err) {
    res.status(500).json({ error: 'Heatmap-Daten konnten nicht geladen werden: ' + err.message });
  }
});

const EDITABLE_PLAYER_STAT_FIELDS = [
  'games_played', 'games_won', 'legs_played', 'legs_won', 'total_darts', 'total_scored',
  'highest_leg_avg', 'avg_first9', 'checkout_attempts', 'checkout_success', 'highest_checkout',
  'checkout_single_attempts', 'checkout_single_success', 'checkout_single_highest',
  'checkout_double_attempts', 'checkout_double_success', 'checkout_double_highest',
  'checkout_master_attempts', 'checkout_master_success', 'checkout_master_highest',
  'checkout_100plus', 'checkout_120plus', 'checkout_160plus', 'count_180', 'count_171plus',
  'count_140plus', 'count_100plus', 'max_score', 'cricket_legs', 'cricket_won', 'cricket_mpr'
];

app.put('/api/players/:id/stats', requireAdmin, async (req, res) => {
  const playerId = Number(req.params.id);
  if (!Number.isInteger(playerId) || playerId < 1) return res.status(400).json({ error: 'Invalid player ID' });
  try {
    await dataStore.initPlayerStats(playerId);
    const updates = {};
    for (const field of EDITABLE_PLAYER_STAT_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, field)) {
        const value = Number(req.body[field]);
        if (!Number.isFinite(value) || value < 0) return res.status(400).json({ error: `Ungültiger Wert für ${field}` });
        updates[field] = value;
      }
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Keine Statistikfelder angegeben' });
    await dataStore.updatePlayerStats(playerId, updates);
    res.json(await dataStore.getPlayerStats(playerId));
  } catch (err) {
    res.status(500).json({ error: 'Statistik konnte nicht gespeichert werden: ' + err.message });
  }
});

app.post('/api/players/:id/stats/reset', requireAdmin, async (req, res) => {
  const playerId = Number(req.params.id);
  if (!Number.isInteger(playerId) || playerId < 1) return res.status(400).json({ error: 'Invalid player ID' });
  try {
    await dataStore.initPlayerStats(playerId);
    const reset = Object.fromEntries(EDITABLE_PLAYER_STAT_FIELDS.map(field => [field, 0]));
    await dataStore.updatePlayerStats(playerId, reset);
    await dataStore.deletePlayerLegHistory(playerId);
    res.json(await dataStore.getPlayerStats(playerId));
  } catch (err) {
    res.status(500).json({ error: 'Statistik konnte nicht zurückgesetzt werden: ' + err.message });
  }
});

app.get('/api/players/:id/history', async (req, res) => {
  try {
    const playerId = Number(req.params.id);
    const limit = Number(req.query.limit || 50);
    if (!Number.isInteger(playerId) || playerId < 0) {
      return res.status(400).json({ error: 'Invalid player ID' });
    }
    const history = await dataStore.getLegHistory(playerId, Math.min(limit, 100));
    res.json(history || []);
  } catch (err) {
    res.status(500).json({ error: 'History konnte nicht geladen werden: ' + err.message });
  }
});

app.get('/api/players/:id/h2h/:opponentId', async (req, res) => {
  try {
    const playerId = Number(req.params.id);
    const opponentId = Number(req.params.opponentId);
    
    if (!Number.isInteger(playerId) || playerId < 0 || !Number.isInteger(opponentId) || opponentId < 0) {
      return res.status(400).json({ error: 'Invalid player IDs' });
    }

    // Get head-to-head record - for now, just return wins/losses from live state
    const state = await getLiveState();
    
    // Simple H2H: count legs won against each other from recent games
    // This is a simplified version - you could expand to track full history
    const h2h = {
      player_id: playerId,
      opponent_id: opponentId,
      player_wins: 0,
      opponent_wins: 0,
      total_legs: 0
    };
    
    res.json(h2h);
  } catch (err) {
    res.status(500).json({ error: 'H2H konnte nicht geladen werden: ' + err.message });
  }
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

  const storedSettings = readJson(SETTINGS_FILE, {});
  if (typeof storedSettings.adminAuthEnabled === 'boolean') adminAuthEnabled = storedSettings.adminAuthEnabled;

  const storageInfo = dataStore.getInfo();
  console.log('[Storage] client=' + storageInfo.client + ' external=' + storageInfo.external);
  if (storageInfo.sqliteFile) console.log('[Storage] sqlite=' + storageInfo.sqliteFile);

  app.listen(BROWSER_PORT, () => {
    console.log('Dashboard (Browser): http://localhost:' + BROWSER_PORT);
    startFireTvServer();
    startArduinoMonitor();
  });
}

function createFireTvServer() {
  const fireTvApp = express();
  fireTvApp.disable('x-powered-by');

  const panelsDir = path.join(__dirname, 'public', 'panels');
  const allowedPanels = new Set([
    'firetv-dashboard.html',
    'live-spielstand-tv.html',
    'live-spielstand.html',
    'spieler.html',
    'highscores.html',
    'statistics.html'
  ]);

  function proxyToBrowser(req, res) {
    const proxyReq = http.request({
      protocol: 'http:',
      hostname: '127.0.0.1',
      port: BROWSER_PORT,
      method: req.method,
      path: req.originalUrl,
      headers: {
        ...req.headers,
        host: '127.0.0.1:' + BROWSER_PORT
      }
    }, (proxyRes) => {
      res.status(proxyRes.statusCode || 502);
      Object.entries(proxyRes.headers || {}).forEach(([key, value]) => {
        if (value !== undefined) res.setHeader(key, value);
      });
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.status(502).json({ error: 'Fire-TV-Proxy Fehler: ' + err.message });
      } else {
        res.end();
      }
    });

    req.pipe(proxyReq);
  }

  fireTvApp.get('/', (_req, res) => {
    res.redirect('/panels/firetv-dashboard.html');
  });

  fireTvApp.get('/panels/:name', (req, res) => {
    const panel = String(req.params.name || '').trim();
    if (!allowedPanels.has(panel)) {
      res.status(404).send('Diese Seite ist am Fire-TV-Port nicht freigegeben.');
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(panelsDir, panel));
  });

  fireTvApp.use('/api', proxyToBrowser);

  fireTvApp.use((_req, res) => {
    res.status(404).send('Fire-TV-Port: Nur /panels/firetv-dashboard.html und TV-Panels sind verfuegbar.');
  });

  return fireTvApp;
}

function startFireTvServer() {
  if (FIRETV_PORT === BROWSER_PORT) {
    console.log('[FireTV] deaktiviert: FIRETV_PORT ist gleich BROWSER_PORT (' + BROWSER_PORT + ').');
    return;
  }
  const fireTvApp = createFireTvServer();
  fireTvApp.listen(FIRETV_PORT, () => {
    console.log('Dashboard (Fire TV): http://localhost:' + FIRETV_PORT + '/panels/firetv-dashboard.html');
  });
}

startServer().catch((err) => {
  console.error('[Start] Fehlgeschlagen:', err.message);
  process.exit(1);
});
