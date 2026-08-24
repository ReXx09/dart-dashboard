const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { DataStore } = require('./db');
const { aggregateDuelStats } = require('./lib/duel-stats');
const { addDerivedMetrics, percentage, resolvePlayerIdentity } = require('./lib/highscore-overview');
const {
  GAME_MODES,
  CHECKOUT_RULES,
  DEFAULT_MODE,
  DEFAULT_CHECKOUT_RULE,
  getStartScoreForMode,
  getCricketNumbersForMode
} = require('./modes');
const {
  isValidCheckout,
  isRestFinishable,
  isCheckoutAttempt,
  getCheckoutRuleStats
} = require('./modes/x01');
const {
  defaultPlayerCricketState,
  applyCricketHit,
  checkCricketWin
} = require('./modes/cricket');

const DEFAULT_STATS_SEASON = String(process.env.DART_SEASON || '2026');
const {
  calculateEliminationPoints,
  checkEliminationWin,
  getEliminationWinner,
  applyEliminationThrow
} = require('./modes/elimination');

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
const LIVE_STATE_WRITE_DEBOUNCE_MS = 250;
const LIVE_DETAIL_FLUSH_DELAY_MS = 35;
const LIVE_DETAIL_BATCH_SIZE = 32;
const LIVE_DISPLAY_THROW_HISTORY_LIMIT = 60;
const LIVE_DISPLAY_THROW_PREFIX_LIMIT = 9;
let liveLifecycleGeneration = 0;
let liveCompletionQueue = Promise.resolve();
let liveDetailPendingSegments = [];
let liveDetailPendingTasks = [];
let liveDetailFlushTimer = null;
let liveDetailWriteRunning = false;
let liveDetailDrainPromise = Promise.resolve();
let liveStateCache = null;
let liveStateWritePending = null;
let liveStateWriteRunning = false;
let liveStateWriteTimer = null;
let liveStateWriteKey = null;
let liveStateBroadcastKey = null;

function cloneLiveState(state) {
  return state ? JSON.parse(JSON.stringify(state)) : null;
}

function getLiveStateSignature(state) {
  const normalized = normalizeLiveStateSnapshot(state || {});
  const players = Array.isArray(normalized.players)
    ? normalized.players.map(player => ({
        slot: Number(player.slot || 0),
        remaining: Number(player.remaining || 0),
        legs: Number(player.legs || 0),
        turns: Number(player.turns || 0),
        totalScored: Number(player.totalScored || 0),
        bestTurn: Number(player.bestTurn || 0),
        currentRoundPoints: Array.isArray(player.currentRoundPoints) ? player.currentRoundPoints.slice(-3) : [],
        throwsLength: Array.isArray(player.throws) ? player.throws.length : 0,
        turnScoreRecorded: !!player.turnScoreRecorded,
        cricketPoints: Number(player.cricketPoints || 0)
      }))
    : [];
  const game = normalized.game || {};
  return JSON.stringify({
    game: {
      mode: game.mode,
      status: game.status,
      activePlayer: game.activePlayer,
      currentThrow: game.currentThrow,
      throwRound: game.throwRound,
      turnId: game.turnId,
      duelId: game.duelId,
      tournamentId: game.tournamentId,
      tournamentMatchId: game.tournamentMatchId,
      tournamentRound: game.tournamentRound,
      tournamentName: game.tournamentName,
      tournamentMatchLabel: game.tournamentMatchLabel,
      matchType: game.matchType,
      bestOf: game.bestOf,
      legsToWin: game.legsToWin,
      checkoutRule: game.checkoutRule
    },
    players,
    lastAction: normalized.lastAction || null
  });
}

function scheduleLiveStateWrite() {
  if (liveStateWriteTimer || liveStateWriteRunning || !liveStateWritePending) return;
  liveStateWriteTimer = setTimeout(() => {
    liveStateWriteTimer = null;
    startLiveStateWriteDrain();
  }, LIVE_STATE_WRITE_DEBOUNCE_MS);
}

function startLiveStateWriteDrain() {
  if (liveStateWriteRunning || !liveStateWritePending) return;
  liveStateWriteRunning = true;
  (async () => {
    while (liveStateWritePending) {
      const pending = liveStateWritePending;
      liveStateWritePending = null;
      if (pending.generation !== liveLifecycleGeneration) continue;
      try {
        await dataStore.saveLiveState(pending.snapshot);
        liveStateWriteKey = pending.generation === liveLifecycleGeneration ? pending.key : null;
      } catch (error) {
        if (!liveStateWritePending) liveStateWriteKey = null;
        console.error('[Live-State] Persistierung fehlgeschlagen:', error);
      }
    }
    liveStateWriteRunning = false;
    scheduleLiveStateWrite();
  })();
}

function queueLiveStateWrite(state, options = {}) {
  const normalized = normalizeLiveStateSnapshot(state || {});
  const key = getLiveStateSignature(normalized);
  if (key === liveStateWriteKey && !liveStateWritePending) return;
  if (liveStateWritePending && liveStateWritePending.key === key) return;

  liveStateWritePending = {
    snapshot: normalized,
    key,
    generation: liveLifecycleGeneration,
    force: options.immediate === true
  };
  liveStateWriteKey = key;
  if (options.immediate === true) {
    if (liveStateWriteTimer) clearTimeout(liveStateWriteTimer);
    liveStateWriteTimer = null;
    startLiveStateWriteDrain();
    return;
  }
  scheduleLiveStateWrite();
}

function scheduleLiveDetailFlush() {
  if (liveDetailFlushTimer || liveDetailWriteRunning) return;
  liveDetailFlushTimer = setTimeout(() => {
    liveDetailFlushTimer = null;
    startLiveDetailDrain();
  }, LIVE_DETAIL_FLUSH_DELAY_MS);
}

function startLiveDetailDrain() {
  if (liveDetailWriteRunning) return liveDetailDrainPromise;
  if (liveDetailPendingSegments.length === 0 && liveDetailPendingTasks.length === 0) return Promise.resolve();

  liveDetailWriteRunning = true;
  liveDetailDrainPromise = (async () => {
    while (liveDetailPendingSegments.length > 0 || liveDetailPendingTasks.length > 0) {
      const segmentBatch = liveDetailPendingSegments.splice(0, LIVE_DETAIL_BATCH_SIZE);
      if (segmentBatch.length > 0) {
        try {
          if (typeof dataStore.recordThrowSegments === 'function') {
            await dataStore.recordThrowSegments(segmentBatch);
          } else {
            for (const segment of segmentBatch) {
              await dataStore.recordThrowSegment(segment.playerSlot, segment.segment, segment.points, segment.mode, segment.bust, segment.thrownAt, segment.duelId);
            }
          }
        } catch (error) {
          console.error('[Live-Detail] Wurfdetails fehlgeschlagen:', error);
        }
      }

      const taskBatch = liveDetailPendingTasks.splice(0, LIVE_DETAIL_BATCH_SIZE);
      for (const entry of taskBatch) {
        try {
          await entry.task();
        } catch (error) {
          console.error('[Live-Detail] ' + entry.label + ' fehlgeschlagen:', error);
        }
      }
    }
  })().finally(() => {
    liveDetailWriteRunning = false;
    if (liveDetailPendingSegments.length > 0 || liveDetailPendingTasks.length > 0) scheduleLiveDetailFlush();
  });
  return liveDetailDrainPromise;
}

function queueLiveThrowSegment(playerSlot, segment, points, mode, bust, thrownAt, duelId) {
  liveDetailPendingSegments.push({
    playerSlot: Number(playerSlot),
    segment: String(segment || 'MISS').toUpperCase(),
    points: Number(points || 0),
    mode: mode ? String(mode) : null,
    bust: !!bust,
    thrownAt: Number(thrownAt) || Date.now(),
    duelId: Number(duelId) > 0 ? Number(duelId) : null
  });
  if (liveDetailPendingSegments.length >= LIVE_DETAIL_BATCH_SIZE) {
    if (liveDetailFlushTimer) clearTimeout(liveDetailFlushTimer);
    liveDetailFlushTimer = null;
    startLiveDetailDrain();
  } else {
    scheduleLiveDetailFlush();
  }
}

function queueLiveDetailWrite(task, label) {
  liveDetailPendingTasks.push({ task, label });
  scheduleLiveDetailFlush();
}

function flushLiveDetailWrites() {
  if (liveDetailFlushTimer) clearTimeout(liveDetailFlushTimer);
  liveDetailFlushTimer = null;
  return startLiveDetailDrain();
}

function isLiveLifecycleCurrent(generation) {
  return Number(generation) === liveLifecycleGeneration;
}

function broadcastReload() {
  sseClients.forEach(res => { try { res.write('event: reload\ndata: 1\n\n'); } catch { sseClients.delete(res); } });
}

function broadcastLiveState(state) {
  const normalized = normalizeLiveStateSnapshot(state || {});
  const signature = getLiveStateSignature(normalized);
  if (signature === liveStateBroadcastKey) return;
  liveStateBroadcastKey = signature;
  const payload = JSON.stringify(getLiveDisplayState(normalized));
  sseClients.forEach(res => { try { res.write('event: live-state\ndata: ' + payload + '\n\n'); } catch { sseClients.delete(res); } });
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
  const processMemory = process.memoryUsage();
  const memoryUsed = Math.max(0, totalMemory - freeMemory);
  const cachedPlayers = Array.isArray(liveStateCache?.players) ? liveStateCache.players : [];
  const cachedThrowCount = cachedPlayers.reduce((sum, player) => sum + (Array.isArray(player.throws) ? player.throws.length : 0), 0);
  const cachedStateBytes = liveStateCache ? Buffer.byteLength(JSON.stringify(liveStateCache), 'utf8') : 0;
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
    processMemory: {
      rssBytes: processMemory.rss,
      heapTotalBytes: processMemory.heapTotal,
      heapUsedBytes: processMemory.heapUsed,
      externalBytes: processMemory.external,
      arrayBuffersBytes: processMemory.arrayBuffers
    },
    liveCache: {
      generation: liveLifecycleGeneration,
      stateBytes: cachedStateBytes,
      players: cachedPlayers.length,
      throws: cachedThrowCount,
      stateWritePending: !!liveStateWritePending,
      stateWriteRunning: liveStateWriteRunning,
      detailSegmentsPending: liveDetailPendingSegments.length,
      detailTasksPending: liveDetailPendingTasks.length,
      detailWriteRunning: liveDetailWriteRunning
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
const MATRIX_STICKY_SIGNAL_WINDOW_MS = Number(process.env.MATRIX_STICKY_SIGNAL_WINDOW_MS || 900);
const MATRIX_STICKY_SIGNAL_REPEAT_LIMIT = Number(process.env.MATRIX_STICKY_SIGNAL_REPEAT_LIMIT || 4);
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
  matrixStickySignalWindowMs: MATRIX_STICKY_SIGNAL_WINDOW_MS,
  matrixStickySignalRepeatLimit: MATRIX_STICKY_SIGNAL_REPEAT_LIMIT,
  arduinoMatrixThrowLockMs: ARDUINO_MATRIX_THROW_LOCK_MS,
  throwMinIntervalMs: THROW_MIN_INTERVAL_MS,
  playerSwitchDelayMs: PLAYER_SWITCH_DELAY_MS,
  singlePlayerSwitchDelayMs: SINGLE_PLAYER_SWITCH_DELAY_MS
};



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

const EVENT_EFFECT_DEFAULTS = {
  t20: { label: 'T20', browserEnabled: true, tvEnabled: true, sound: 'none', animation: 'none', volume: 0.3, durationMs: 900 },
  t19: { label: 'T19', browserEnabled: true, tvEnabled: true, sound: 'none', animation: 'none', volume: 0.3, durationMs: 900 },
  t18: { label: 'T18', browserEnabled: true, tvEnabled: true, sound: 'none', animation: 'none', volume: 0.3, durationMs: 900 },
  t17: { label: 'T17', browserEnabled: true, tvEnabled: true, sound: 'none', animation: 'none', volume: 0.3, durationMs: 900 },
  double: { label: 'Double allgemein', browserEnabled: true, tvEnabled: true, sound: 'none', animation: 'none', volume: 0.3, durationMs: 900 },
  d17: { label: 'D17', browserEnabled: true, tvEnabled: true, sound: 'none', animation: 'none', volume: 0.3, durationMs: 900 },
  d18: { label: 'D18', browserEnabled: true, tvEnabled: true, sound: 'none', animation: 'none', volume: 0.3, durationMs: 900 },
  d19: { label: 'D19', browserEnabled: true, tvEnabled: true, sound: 'none', animation: 'none', volume: 0.3, durationMs: 900 },
  d20: { label: 'D20', browserEnabled: true, tvEnabled: true, sound: 'none', animation: 'none', volume: 0.3, durationMs: 900 },
  bull: { label: 'Bull / 25', browserEnabled: true, tvEnabled: true, sound: 'none', animation: 'none', volume: 0.3, durationMs: 900 },
  dbull: { label: 'dBull', browserEnabled: true, tvEnabled: true, sound: 'none', animation: 'none', volume: 0.3, durationMs: 900 },
  triple: { label: 'Triple allgemein', browserEnabled: true, tvEnabled: true, sound: 'none', animation: 'none', volume: 0.3, durationMs: 900 },
  maximum: { label: '180 / Maximum', browserEnabled: true, tvEnabled: true, sound: 'none', animation: 'none', volume: 0.3, durationMs: 1200 },
  checkout: { label: 'Checkout', browserEnabled: true, tvEnabled: true, sound: 'none', animation: 'none', volume: 0.3, durationMs: 1400 },
  bust: { label: 'BUST', browserEnabled: true, tvEnabled: true, sound: 'bust', animation: 'bust', volume: 0.3, durationMs: 1500 },
  elimination: { label: 'Elimination', browserEnabled: true, tvEnabled: true, sound: 'elimination', animation: 'elimination', volume: 0.4, durationMs: 2000 },
  cricketScore: { label: 'Cricket-Score', browserEnabled: true, tvEnabled: true, sound: 'cricket-score', animation: 'cricket-score', volume: 0.22, durationMs: 1200 },
  winner: { label: 'Winner', browserEnabled: true, tvEnabled: true, sound: 'none', animation: 'winner', volume: 0.3, durationMs: 3000 },
  confetti: { label: 'Confetti', browserEnabled: true, tvEnabled: true, sound: 'none', animation: 'confetti', volume: 0.3, durationMs: 3000 }
};

const EVENT_EFFECT_SOUNDS = [
  'none',
  'bust',
  'elimination',
  'cricket-score',
  'file:t20',
  'file:t19',
  'file:t18',
  'file:t17',
  'file:bull',
  'file:dbull',
  'file:triple',
  'file:maximum',
  'file:checkout',
  'file:winner',
  'file:bust',
  'file:elimination',
  'file:cricket-score'
];
const EVENT_EFFECT_ANIMATIONS = [
  'none',
  'bust',
  'elimination',
  'cricket-score',
  'winner',
  'confetti',
  'fireworks',
  'highlight',
  'flash',
  'celebration',
  'shake'
];

function isValidEventEffectSound(value) {
  if (EVENT_EFFECT_SOUNDS.includes(value)) return true;
  if (value === 'random-files') return true;
  if (typeof value !== 'string') return false;
  if (value.startsWith('random-folder:')) return isSafeSoundRelativePath(value.slice(14));
  return value.startsWith('file:') && isSafeSoundFilePath(value.slice(5));
}

function isSafeSoundRelativePath(value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\')) return false;
  const parts = value.split('/');
  return parts.every(part => part && part !== '.' && part !== '..' && !/[\?%#]/.test(part));
}

function isSafeSoundFilePath(value) {
  return isSafeSoundRelativePath(value) && /\.(?:mp3|ogg)$/i.test(value);
}

function scanSoundDirectory(soundsDirectory) {
  const sounds = [];
  const folders = new Set();
  const visit = (directory, relativeDirectory = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const relativePath = relativeDirectory ? relativeDirectory + '/' + entry.name : entry.name;
      if (entry.isDirectory()) {
        visit(path.join(directory, entry.name), relativePath);
      } else if (entry.isFile() && /\.(mp3|ogg)$/i.test(entry.name)) {
        sounds.push(relativePath);
        if (relativeDirectory) {
          const directoryParts = relativeDirectory.split('/');
          for (let index = 1; index <= directoryParts.length; index += 1) {
            folders.add(directoryParts.slice(0, index).join('/'));
          }
        }
      }
    }
  };
  visit(soundsDirectory);
  const sortedSounds = sounds.sort((left, right) => left.localeCompare(right, 'de', { sensitivity: 'base' }));
  return {
    sounds: sortedSounds,
    folders: [...folders].sort((left, right) => left.localeCompare(right, 'de', { sensitivity: 'base' }))
  };
}

function normalizeEventEffects(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(Object.entries(EVENT_EFFECT_DEFAULTS).map(([key, fallback]) => {
    const item = source[key] && typeof source[key] === 'object' ? source[key] : {};
    const volume = clampNumber(item.volume, fallback.volume, 0, 1);
    const durationMs = clampNumber(item.durationMs, fallback.durationMs, 100, 10000);
    return [key, {
      ...fallback,
      browserEnabled: item.browserEnabled !== false,
      tvEnabled: item.tvEnabled !== false,
      sound: isValidEventEffectSound(item.sound) ? item.sound : fallback.sound,
      animation: EVENT_EFFECT_ANIMATIONS.includes(item.animation) ? item.animation : fallback.animation,
      volume,
      durationMs
    }];
  }));
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
    matrixStickySignalWindowMs: runtimeTuning.matrixStickySignalWindowMs,
    matrixStickySignalRepeatLimit: runtimeTuning.matrixStickySignalRepeatLimit,
    arduinoMatrixThrowLockMs: runtimeTuning.arduinoMatrixThrowLockMs,
    throwMinIntervalMs: runtimeTuning.throwMinIntervalMs,
    playerSwitchDelayMs: runtimeTuning.playerSwitchDelayMs,
    singlePlayerSwitchDelayMs: runtimeTuning.singlePlayerSwitchDelayMs,
    eventEffects: normalizeEventEffects(),
    ...readJson(SETTINGS_FILE, {})
  };
  merged.eventEffects = normalizeEventEffects(merged.eventEffects);
  merged.dailyHighscoreDisplayMode = ['checkout', 'daily-highscore', 'alternate', 'off'].includes(merged.dailyHighscoreDisplayMode)
    ? merged.dailyHighscoreDisplayMode
    : 'alternate';
  merged.dailyHighscoreDisplayIntervalMs = clampNumber(merged.dailyHighscoreDisplayIntervalMs, 5000, 2000, 60000);
  return merged;
}
function saveSettings(s) {
  writeJson(SETTINGS_FILE, {
    ...s,
    eventEffects: normalizeEventEffects(s.eventEffects),
    dailyHighscoreDisplayMode: ['checkout', 'daily-highscore', 'alternate', 'off'].includes(s.dailyHighscoreDisplayMode) ? s.dailyHighscoreDisplayMode : 'alternate',
    dailyHighscoreDisplayIntervalMs: clampNumber(s.dailyHighscoreDisplayIntervalMs, 5000, 2000, 60000)
  });
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
    matrixStickySignalWindowMs: clampNumber(settings.matrixStickySignalWindowMs, MATRIX_STICKY_SIGNAL_WINDOW_MS, 200, 3000),
    matrixStickySignalRepeatLimit: clampNumber(settings.matrixStickySignalRepeatLimit, MATRIX_STICKY_SIGNAL_REPEAT_LIMIT, 3, 12),
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
let arduinoStateBroadcastTimer = null;
let arduinoPort = null;
let arduinoParser = null;
let arduinoReconnectTimer = null;
let arduinoResolvedActiveState = ARDUINO_EVENT_ACTIVE_STATE_MODE === 'AUTO' ? 'ACTIVE' : ARDUINO_EVENT_ACTIVE_STATE_MODE;
let pendingArduinoThrow = null;
let pendingArduinoThrowTimer = null;
let arduinoThrowLockUntil = 0;
let arduinoProcessingPromise = Promise.resolve();
let autoAdvanceTimer = null;
let autoAdvanceToken = 0;
let matrixHitSuppressUntil = 0;
let matrixLastAcceptedHitAt = 0;
let matrixLastAcceptedKey = '';
let matrixHitClusterTimer = null;
let matrixHitClusterHits = [];
let matrixHitClusterGeneration = null;
let matrixStickySignalKey = '';
let matrixStickySignalFirstAt = 0;
let matrixStickySignalCount = 0;
let matrixStickySignalBlockedKey = '';
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

function scheduleArduinoStateBroadcast() {
  if (arduinoStateBroadcastTimer) return;
  arduinoStateBroadcastTimer = setTimeout(() => {
    arduinoStateBroadcastTimer = null;
    broadcastArduinoState();
  }, 50);
}

function normalizeArduinoStatePatch(patch) {
  Object.assign(arduinoState, patch, { lastUpdateMs: Date.now() });
  scheduleArduinoStateBroadcast();
}

function isAutoAdvancePending() {
  return !!(liveStateCache && liveStateCache.lastAction && liveStateCache.lastAction.autoAdvancePending);
}

function shouldQueueMatrixHit(key, nowMs) {
  const now = Number(nowMs || Date.now());
  if (key && key === matrixStickySignalBlockedKey) return false;

  if (key !== matrixStickySignalKey || (now - matrixStickySignalFirstAt) > runtimeTuning.matrixStickySignalWindowMs) {
    matrixStickySignalKey = key;
    matrixStickySignalFirstAt = now;
    matrixStickySignalCount = 1;
  } else {
    matrixStickySignalCount += 1;
    if (matrixStickySignalCount >= runtimeTuning.matrixStickySignalRepeatLimit) {
      matrixStickySignalBlockedKey = key;
      matrixStickySignalKey = '';
      matrixStickySignalFirstAt = 0;
      matrixStickySignalCount = 0;
      return false;
    }
  }

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
  const clusterGeneration = matrixHitClusterGeneration;
  matrixHitClusterGeneration = null;
  if (matrixHitClusterTimer) {
    clearTimeout(matrixHitClusterTimer);
    matrixHitClusterTimer = null;
  }

  if (!Array.isArray(matrixHitClusterHits) || matrixHitClusterHits.length === 0) {
    matrixHitClusterHits = [];
    return;
  }

  if (!isLiveLifecycleCurrent(clusterGeneration)) {
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
    handleArduinoMatrixHit(acceptedHit, clusterGeneration);
  }
}

function queueMatrixHitCandidate(hit, nowMs) {
  const now = Number(nowMs || Date.now());
  const key = String((hit && hit.key) || '').trim();
  if (!key) return false;
  if (isAutoAdvancePending()) return false;
  if (!shouldQueueMatrixHit(key, now)) return false;

  if (matrixHitClusterGeneration == null) matrixHitClusterGeneration = liveLifecycleGeneration;
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

function sanitizeArduinoAutomationResult(result) {
  if (!result || typeof result !== 'object') return result || null;
  const summary = { ...result };
  delete summary.state;
  return summary;
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
    lastAutoThrow: sanitizeArduinoAutomationResult(arduinoState.lastAutoThrow),
    lastMiss: sanitizeArduinoAutomationResult(arduinoState.lastMiss),
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

function getCheckoutValue(player, remainingBeforeThrow) {
  const dartsInTurn = Array.isArray(player && player.currentRoundPoints)
    ? player.currentRoundPoints
    : [];
  return Math.max(0, dartsInTurn.reduce((sum, points) => sum + (Number(points) || 0), 0));
}

function getTurnScoresFromThrows(throws, includePartial = true) {
  const scores = [];
  for (let index = 0; index < throws.length; index += 3) {
    const turn = throws.slice(index, index + 3);
    if (turn.length < 3 && !includePartial) continue;
    scores.push(turn.reduce((sum, item) => sum + (item && item.bust ? 0 : Number(item && item.points || 0)), 0));
  }
  return scores;
}

function clearPendingArduinoThrow() {
  if (pendingArduinoThrowTimer) clearTimeout(pendingArduinoThrowTimer);
  pendingArduinoThrowTimer = null;
  pendingArduinoThrow = null;
}

function invalidateLiveLifecycle() {
  liveLifecycleGeneration += 1;
  cancelScheduledAutoAdvance();
  clearPendingArduinoThrow();
  if (liveStateWriteTimer) clearTimeout(liveStateWriteTimer);
  liveStateWriteTimer = null;
  liveStateWritePending = null;
  liveStateWriteKey = null;
  arduinoProcessingPromise = Promise.resolve();
  arduinoThrowLockUntil = 0;
  matrixHitSuppressUntil = 0;
  matrixLastAcceptedHitAt = 0;
  matrixLastAcceptedKey = '';
  matrixHitClusterGeneration = null;
  if (matrixHitClusterTimer) clearTimeout(matrixHitClusterTimer);
  matrixHitClusterTimer = null;
  matrixHitClusterHits = [];
  matrixStickySignalKey = '';
  matrixStickySignalFirstAt = 0;
  matrixStickySignalCount = 0;
  matrixStickySignalBlockedKey = '';
  matrixSniffer.activeRows = {};
  matrixSniffer.activeColumns = {};
  matrixSniffer.lastMatrixHit = null;
  matrixSniffer.matrixHitActive = false;
  matrixSniffer.lastMatrixHitMs = 0;
  matrixSniffer.lastMatrixHitPairMs = 0;
  matrixSniffer.lastMatrixHitRow = null;
  matrixSniffer.lastMatrixHitColumn = null;
  lastAppliedThrowAt = 0;
  normalizeArduinoStatePatch({
    pendingThrow: false,
    lastAutoThrow: null,
    lastMiss: null,
    lastAutoThrowError: null,
    matrixSniffer: { ...matrixSniffer, lastMatrixHit: null }
  });
  return liveLifecycleGeneration;
}

function queueArduinoProcessing(task, generation = liveLifecycleGeneration) {
  const expectedGeneration = Number(generation);
  arduinoProcessingPromise = arduinoProcessingPromise
    .catch(() => {})
    .then(() => {
      if (!isLiveLifecycleCurrent(expectedGeneration)) return null;
      return task(expectedGeneration);
    });
  return arduinoProcessingPromise;
}

function advanceLiveTurn(state) {
  state.game.turnId = Math.max(1, Number(state.game.turnId || 1) + 1);
  return state.game.turnId;
}

function restoreCurrentRoundPoints(player, turnId) {
  const throws = Array.isArray(player.throws) ? player.throws : [];
  player.currentRoundPoints = throws
    .filter(item => Number(item && item.turnId) === Number(turnId) && item.source !== 'manual-miss')
    .map(item => Number(item.points) || 0);
  player.turnScoreRecorded = false;
}

async function recordPlayerLegStats(player, state, options = {}) {
  try {
    if (!options.skipDuel) await recordDuelLegIfActive(state, player);
    // Ensure player has stats entry
    await dataStore.initPlayerStats(player.slot);

    // Calculate leg average: (total_scored / darts_thrown) * 3
    const dartsThrawn = Number(player.turns || 0);
    const totalScored = Number(player.totalScored || 0);
    const legAvg = dartsThrawn > 0 ? (totalScored / dartsThrawn * 3) : 0;
    
    // Der Live-State speichert einzelne Würfe; daraus werden die Aufnahmen gebildet.
    const throws = Array.isArray(player.throws) ? player.throws : [];
    const firstNine = throws.slice(0, 9);
    const firstNineScored = firstNine.reduce((sum, item) => sum + (item && item.bust ? 0 : Number(item && item.points || 0)), 0);
    const firstNineAvg = firstNine.length >= 9 ? (firstNineScored / 9 * 3) : 0;
    const completeTurns = getTurnScoresFromThrows(throws, false);
    let count180 = 0, count171 = 0, count140 = 0, count100 = 0;
    let maxScore = 0;
    
    completeTurns.forEach(turn => {
      const score = Number(turn || 0);
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
    await dataStore.recordLegHistory(player.slot, legAvg, checkout, won, dartsThrawn, undefined, state.game?.duelId || null);

    // Update player stats
    const currentStats = await dataStore.getPlayerStats(player.slot) || {};
    const isTrackedDuel = Number(state.game?.duelId || 0) > 0;
    const previousFirstNineTotal = Number(currentStats.first_nine_total || 0);
    const previousFirstNineSamples = Number(currentStats.first_nine_samples || 0);
    const firstNineTotal = previousFirstNineTotal + (firstNineAvg > 0 ? firstNineAvg : 0);
    const firstNineSamples = previousFirstNineSamples + (firstNineAvg > 0 ? 1 : 0);
    const updates = {
      legs_played: (Number(currentStats.legs_played || 0)) + 1,
      legs_won: (Number(currentStats.legs_won || 0)) + (won ? 1 : 0),
      total_darts: (Number(currentStats.total_darts || 0)) + dartsThrawn,
      total_scored: (Number(currentStats.total_scored || 0)) + totalScored,
      highest_leg_avg: Math.max(Number(currentStats.highest_leg_avg || 0), legAvg),
      avg_first9: firstNineSamples > 0 ? firstNineTotal / firstNineSamples : 0,
      first_nine_total: firstNineTotal,
      first_nine_samples: firstNineSamples,
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

async function recordCompletedLegStats(state, winner) {
  const completedPlayers = Array.isArray(state.players) ? state.players.map(player => ({ ...player })) : [];
  const completedDuelId = Number(state.game?.duelId || 0) || null;
  const completedMatch = !completedDuelId || Number(winner?.legs || 0) >= Math.max(1, Number(state.game?.legsToWin || 1));
  const tournamentAdvance = await recordDuelLegIfActive(state, winner);
  if (tournamentAdvance?.nextDuel) {
    const nextDuel = tournamentAdvance.nextDuel;
    const nextSlots = nextDuel.players.map(player => Number(player.player_slot));
    const fresh = await defaultLiveState(state.game.mode, nextSlots);
    fresh.game.duelId = nextDuel.id;
    fresh.game.checkoutRule = state.game.checkoutRule;
    fresh.game.selectedPlayerSlots = nextSlots;
    fresh.game.matchType = 'tournament';
    fresh.game.bestOf = state.game.bestOf;
    fresh.game.legsToWin = state.game.legsToWin;
    fresh.game.tournamentId = state.game.tournamentId;
    fresh.game.tournamentMatchId = tournamentAdvance.nextMatch.id;
    fresh.game.tournamentRound = tournamentAdvance.nextMatch.round;
    fresh.game.tournamentMatchLabel = tournamentAdvance.nextMatch.label;
    fresh.game.tournamentName = state.game.tournamentName;
    fresh.lastAction = {
      type: 'tournament-advance',
      tournamentId: state.game.tournamentId,
      completedDuelId,
      previousWinnerSlot: winner.slot,
      previousWinner: winner.name,
      previousLoserSlot: (state.players || []).find(player => Number(player.slot) !== Number(winner.slot))?.slot || null,
      nextMatchLabel: tournamentAdvance.nextMatch.label,
      ts: Date.now()
    };
    state.game = fresh.game;
    state.players = fresh.players;
    state.lastAction = fresh.lastAction;
  } else if (state.game?.tournamentId && tournamentAdvance?.status === 'finished' && Number(winner?.legs || 0) >= Math.max(1, Number(state.game?.legsToWin || 1))) {
    state.lastAction = {
      ...(state.lastAction || {}),
      type: 'tournament-match-finished',
      tournamentId: state.game.tournamentId,
      tournamentMatchId: state.game.tournamentMatchId,
      completedDuelId,
      previousWinnerSlot: winner?.slot || null,
      previousWinner: winner?.name || '',
      tournamentWaiting: true,
      tournamentWinnerSlot: winner.slot,
      ts: Date.now()
    };
  } else if (state.game?.tournamentId && completedMatch) {
    state.lastAction = {
      type: 'tournament-match-finished',
      tournamentId: state.game.tournamentId,
      tournamentMatchId: state.game.tournamentMatchId,
      completedDuelId,
      previousWinnerSlot: winner?.slot || null,
      previousWinner: winner?.name || '',
      ts: Date.now()
    };
  }
  if (completedDuelId) {
    if (completedMatch) {
      const completedDuel = await dataStore.getDuel(completedDuelId);
      if (completedDuel) await recordCompletedDuelPlayerStats(completedDuel);
    }
  } else {
    for (const player of completedPlayers) {
      await recordPlayerLegStats(player, state, { skipDuel: true });
    }
  }
}

function queueCompletedLegStats(state, winner, generation = liveLifecycleGeneration) {
  const snapshot = cloneLiveState(state);
  const winnerSnapshot = cloneLiveState(winner);
  const expectedDuelId = Number(snapshot?.game?.duelId || 0) || null;
  const expectedActionTs = Number(snapshot?.lastAction?.ts || 0);
  liveCompletionQueue = liveCompletionQueue
    .catch(() => {})
    .then(async () => {
      await flushLiveDetailWrites();
      const completionState = cloneLiveState(snapshot);
      await recordCompletedLegStats(completionState, winnerSnapshot);

      if (!expectedDuelId || !isLiveLifecycleCurrent(generation)) return;
      if (Number(completionState?.game?.duelId || 0) === expectedDuelId) return;

      const latest = await getLiveState();
      if (!isLiveLifecycleCurrent(generation)) return;
      if (Number(latest?.game?.duelId || 0) !== expectedDuelId) return;
      if (String(latest?.game?.status || '') !== 'leg-finished') return;
      if (Number(latest?.lastAction?.ts || 0) !== expectedActionTs) return;

      const saved = await saveLiveState(completionState, { immediate: true });
      broadcastLiveState(saved);
    })
    .catch(error => console.error('[Stats] Leg-Abschluss fehlgeschlagen:', error));
  return liveCompletionQueue;
}

async function recordCompletedDuelPlayerStats(duel) {
  const usesCurrentCheckoutStats = Number(duel.checkout_stats_version || 1) >= 2;
  const checkoutRule = ['single', 'double', 'master'].includes(String(duel.checkout_rule || '').toLowerCase())
    ? String(duel.checkout_rule).toLowerCase()
    : null;
  const bySlot = new Map();
  for (const player of duel.players || []) {
    bySlot.set(Number(player.player_slot), {
      playerId: Number(player.player_slot), legs: 0, wins: 0, darts: 0, scored: 0,
      firstNine: [], count180: 0, count171plus: 0, count140plus: 0, count100plus: 0,
      checkoutAttempts: 0, checkoutSuccess: 0, highestCheckout: 0, checkouts: { single: [0, 0, 0], double: [0, 0, 0], master: [0, 0, 0] }
    });
  }
  for (const leg of duel.legs || []) {
    for (const player of leg.players || []) {
      const row = bySlot.get(Number(player.player_slot));
      if (!row) continue;
      row.legs += 1;
      row.wins += Number(player.won || 0);
      row.darts += Number(player.darts || 0);
      row.scored += Number(player.scored || 0);
      if (Number(player.first_nine_avg || 0) > 0) row.firstNine.push(Number(player.first_nine_avg));
      row.count180 += Number(player.count_180 || 0);
      row.count171plus += Number(player.count_171plus || 0);
      row.count140plus += Number(player.count_140plus || 0);
      row.count100plus += Number(player.count_100plus || 0);
      row.checkoutAttempts += Number(player.checkout_attempts || 0);
      row.checkoutSuccess += Number(player.checkout_success || 0);
      row.highestCheckout = Math.max(row.highestCheckout, Number(player.checkout_highest || 0));
      if (checkoutRule) {
        const values = row.checkouts[checkoutRule];
        values[0] += Number(player.checkout_attempts || 0);
        values[1] += Number(player.checkout_success || 0);
        values[2] = Math.max(values[2], Number(player.checkout_highest || 0));
      }
    }
  }
  for (const row of bySlot.values()) {
    const current = await dataStore.getPlayerStats(row.playerId) || {};
    const previousLegs = Number(current.legs_played || 0);
    const previousFirstNineTotal = Number(current.first_nine_total || 0);
    const previousFirstNineSamples = Number(current.first_nine_samples || 0);
    const firstNineTotal = previousFirstNineTotal + row.firstNine.reduce((sum, value) => sum + value, 0);
    const firstNineSamples = previousFirstNineSamples + row.firstNine.length;
    const updates = {
      games_played: Number(current.games_played || 0) + 1,
      games_won: Number(current.games_won || 0) + (Number(duel.winner_slot) === row.playerId ? 1 : 0),
      legs_played: previousLegs + row.legs,
      legs_won: Number(current.legs_won || 0) + row.wins,
      total_darts: Number(current.total_darts || 0) + row.darts,
      total_scored: Number(current.total_scored || 0) + row.scored,
      highest_leg_avg: Math.max(Number(current.highest_leg_avg || 0), ...((duel.legs || []).flatMap(leg => (leg.players || []).filter(player => Number(player.player_slot) === row.playerId).map(player => Number(player.average || 0))))),
      avg_first9: firstNineSamples > 0 ? firstNineTotal / firstNineSamples : 0,
      first_nine_total: firstNineTotal,
      first_nine_samples: firstNineSamples,
      count_180: Number(current.count_180 || 0) + row.count180,
      count_171plus: Number(current.count_171plus || 0) + row.count171plus,
      count_140plus: Number(current.count_140plus || 0) + row.count140plus,
      count_100plus: Number(current.count_100plus || 0) + row.count100plus,
      checkout_attempts: Number(current.checkout_attempts || 0) + (usesCurrentCheckoutStats ? row.checkoutAttempts : 0),
      checkout_success: Number(current.checkout_success || 0) + (usesCurrentCheckoutStats ? row.checkoutSuccess : 0),
      highest_checkout: Math.max(Number(current.highest_checkout || 0), row.highestCheckout)
    };
    if (checkoutRule && usesCurrentCheckoutStats) {
      const values = row.checkouts[checkoutRule];
      updates[`checkout_${checkoutRule}_attempts`] = Number(current[`checkout_${checkoutRule}_attempts`] || 0) + values[0];
      updates[`checkout_${checkoutRule}_success`] = Number(current[`checkout_${checkoutRule}_success`] || 0) + values[1];
      updates[`checkout_${checkoutRule}_highest`] = Math.max(Number(current[`checkout_${checkoutRule}_highest`] || 0), values[2]);
    }
    await dataStore.updatePlayerStats(row.playerId, updates);
    for (const leg of duel.legs || []) {
      const legPlayer = (leg.players || []).find(player => Number(player.player_slot) === row.playerId);
      if (legPlayer) await dataStore.recordLegHistory(row.playerId, Number(legPlayer.average || 0), Number(legPlayer.checkout_highest || 0), Number(legPlayer.won || 0), Number(legPlayer.darts || 0), undefined, duel.id);
    }
  }
}

async function recordDuelLegIfActive(state, winner) {
  const duelId = Number(state.game?.duelId || 0);
  const mode = String(state.game?.mode || '');
  if (!duelId || !GAME_MODES[mode]) return;
  const profiles = await dataStore.getProfiles();
  const profileByName = new Map(profiles.map(profile => [String(profile.name || '').trim().toLowerCase(), Number(profile.id)]));
  const players = (Array.isArray(state.players) ? state.players : []).map(player => {
    const throws = Array.isArray(player.throws) ? player.throws : [];
    const firstNine = throws.slice(0, 9);
    const firstNineScored = firstNine.reduce((sum, item) => sum + (item.bust ? 0 : Number(item.points || 0)), 0);
    const firstNineAvg = firstNine.length >= 9 ? roundAverage(firstNineScored / 9 * 3) : 0;
    const turnScores = getTurnScoresFromThrows(throws);
    const completeTurnScores = getTurnScoresFromThrows(throws, false);
    return {
      slot: player.slot,
      profileId: profileByName.get(String(player.name || '').trim().toLowerCase()) || null,
      name: player.name,
      turns: player.turns,
      totalScored: player.totalScored,
      average: Number(player.turns || 0) > 0 ? roundAverage(Number(player.totalScored || 0) / Number(player.turns) * 3) : 0,
      firstNineAvg,
      bestTurn: Math.max(...turnScores, 0),
      count60plus: completeTurnScores.filter(score => score >= 60).length,
      count80plus: completeTurnScores.filter(score => score >= 80).length,
      count100plus: completeTurnScores.filter(score => score >= 100).length,
      count140plus: completeTurnScores.filter(score => score >= 140).length,
      count171plus: completeTurnScores.filter(score => score >= 171).length,
      count180: completeTurnScores.filter(score => score === 180).length,
      checkoutAttempts: player.checkoutAttempts,
      checkoutSuccess: player.checkoutSuccess,
      lastCheckoutValue: player.lastCheckoutValue,
      busts: throws.filter(item => item.bust).length
    };
  });
  const legsToWin = Math.max(1, Number(state.game?.legsToWin || 1));
  const matchComplete = Number(winner?.legs || 0) >= legsToWin;
  await dataStore.recordDuelLeg({
    duelId,
    mode,
    winnerSlot: winner.slot,
    startedAt: Number(state.game.startedAt || Date.now()),
    players,
    matchComplete
  });
  if (matchComplete && state.game?.tournamentId && state.game?.tournamentMatchId) {
    return dataStore.advanceTournament(state.game.tournamentId, state.game.tournamentMatchId, winner.slot, state.players);
  }
  return null;
}

function cancelScheduledAutoAdvance() {
  autoAdvanceToken += 1;
  if (autoAdvanceTimer) clearTimeout(autoAdvanceTimer);
  autoAdvanceTimer = null;
}

function completeAutoAdvance(state, source) {
  if (!state || !Array.isArray(state.players) || state.players.length === 0) return false;
  const currentIndex = Number.isInteger(state.game.activePlayer) ? state.game.activePlayer : 0;
  const player = state.players[currentIndex];
  if (!player) return false;

  player.currentRoundPoints = [];
  player.turnScoreRecorded = false;
  state.game.activePlayer = (currentIndex + 1) % state.players.length;
  state.game.currentThrow = 0;
  advanceLiveTurn(state);
  state.players[state.game.activePlayer].currentRoundPoints = [];
  state.players[state.game.activePlayer].turnScoreRecorded = false;
  if (state.game.activePlayer === 0) {
    state.game.throwRound = (Number(state.game.throwRound || 1) || 1) + 1;
  }
  state.lastAction.autoAdvancePending = false;
  state.lastAction.autoAdvanced = true;
  state.lastAction.nextSource = source;
  state.lastAction.nextPlayer = state.players[state.game.activePlayer].name;
  state.lastAction.nextPlayerSlot = state.players[state.game.activePlayer].slot;
  return true;
}

function scheduleAutoAdvance(state, source, delayMs) {
  cancelScheduledAutoAdvance();
  if (delayMs <= 0) {
    completeAutoAdvance(state, source);
    return;
  }

  const token = autoAdvanceToken;
  const expectedGeneration = liveLifecycleGeneration;
  const expectedTurnId = Number(state.game.turnId || 1);
  const expectedActivePlayer = Number(state.game.activePlayer || 0);
  const expectedThrow = Number(state.game.currentThrow || 0);
  autoAdvanceTimer = setTimeout(() => {
    autoAdvanceTimer = null;
    if (token !== autoAdvanceToken || !isLiveLifecycleCurrent(expectedGeneration)) return;

    getLiveState()
      .then(async (latest) => {
        if (token !== autoAdvanceToken || !isLiveLifecycleCurrent(expectedGeneration) || latest.game.status === 'leg-finished') return;
        const pending = latest.lastAction && latest.lastAction.autoAdvancePending;
        if (!pending || Number(latest.game.turnId || 1) !== expectedTurnId || Number(latest.game.activePlayer || 0) !== expectedActivePlayer || Number(latest.game.currentThrow || 0) !== expectedThrow) return;
        if (!completeAutoAdvance(latest, source)) return;
        const saved = await saveLiveState(latest);
        broadcastLiveState(saved);
        return saved;
      })
      .catch((error) => console.error('[Live] Auto-Weiter fehlgeschlagen:', error));
  }, delayMs);
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

  scheduleAutoAdvance(state, source, delayMs);
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

  scheduleAutoAdvance(state, source, delayMs);
}

async function applyArduinoThrowFromChannel(channel, evt = {}, generation = liveLifecycleGeneration) {
  if (!isLiveLifecycleCurrent(generation)) return { ok: false, reason: 'stale-lifecycle' };
  const value = dartValueFromChannel(channel);
  if (value == null) return { ok: false, reason: 'unknown-channel', channel: formatChannel(channel) };

  const state = await getLiveState();
  if (!isLiveLifecycleCurrent(generation)) return { ok: false, reason: 'stale-lifecycle' };
  if (!Array.isArray(state.players) || state.players.length === 0) return { ok: false, reason: 'no-players' };
  if (state.game.status === 'leg-finished') return { ok: false, reason: 'leg-finished' };
  if (state.lastAction && state.lastAction.autoAdvancePending) return { ok: false, reason: 'auto-advance-pending' };

  const targetIndex = Number.isInteger(state.game.activePlayer) ? state.game.activePlayer : 0;
  const player = state.players[targetIndex];
  if (!player) return { ok: false, reason: 'no-active-player' };

  const mode = state.game.mode || DEFAULT_MODE;
  const modeDef = GAME_MODES[mode] || GAME_MODES[DEFAULT_MODE];
  const isCricket = modeDef.type === 'cricket';
  const isElimination = modeDef.type === 'elimination';
  const checkoutRule = state.game.checkoutRule || DEFAULT_CHECKOUT_RULE;
  const checkoutSegment = evt.segment || codeToSegment(evt.code) || null;
  const checkoutAttempt = !isCricket && !isElimination && isCheckoutAttempt(player.remaining, checkoutRule);
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
  const thrownAt = Date.now();
  player.throws.push({
    points: value,
    cricketPointsAwarded,
    remaining: player.remaining,
    bust,
    ts: thrownAt,
    source: 'arduino',
    turnId: state.game.turnId || 1,
    segment: throwSegment,
    channel: formatChannel(channel),
    raw: evt.line || null
  });
  queueLiveThrowSegment(player.slot, throwSegment, value, mode, bust, thrownAt, state.game.duelId);

  player.average = calculateCurrentRoundAverage(player);
  state.game.currentThrow = (Number(state.game.currentThrow || 0) || 0) + 1;

  state.lastAction = {
    type: 'throw',
    source: 'arduino',
    playerIndex: targetIndex,
    playerSlot: player.slot,
    player: player.name,
    points: value,
    segment: throwSegment,
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
    player.lastCheckoutValue = getCheckoutValue(player, remainingBeforeThrow);
    player.checkoutSuccess = Number(player.checkoutSuccess || 0) + 1;
    const ruleStats = getCheckoutRuleStats(player, checkoutRule);
    ruleStats.success += 1;
    ruleStats.highest = Math.max(ruleStats.highest, Math.min(170, player.lastCheckoutValue));
    player.legs = Math.max(0, Number(player.legs || 0)) + 1;
    state.game.status = 'leg-finished';
    state.lastAction.legWin = true;
    state.lastAction.winner = player.name;
    state.lastAction.winnerSlot = player.slot;
    queueLiveDetailWrite(
      () => addHighscore(player.name, player.lastCheckoutValue, { kind: 'checkout', legWin: true, source: 'arduino', gameMode: mode, checkoutRule, duelId: state.game.duelId, playerSlot: player.slot }),
      'Leg-Highscore'
    );
    queueCompletedLegStats(state, player, generation);
  } else if (isCricket && checkCricketWin(player, state.players)) {
    player.legs = Math.max(0, Number(player.legs || 0)) + 1;
    state.game.status = 'leg-finished';
    state.lastAction.cricketWin = true;
    state.lastAction.winner = player.name;
    state.lastAction.winnerSlot = player.slot;
    queueLiveDetailWrite(
      () => addHighscore(player.name, player.cricketPoints || 0, { kind: 'cricket', legWin: true, source: 'arduino', gameMode: mode, duelId: state.game.duelId, playerSlot: player.slot }),
      'Leg-Highscore'
    );
    queueCompletedLegStats(state, player, generation);
  } else if (isElimination && checkEliminationWin(state)) {
    const winner = getEliminationWinner(state);
    if (winner) {
      winner.legs = Math.max(0, Number(winner.legs || 0)) + 1;
      state.game.status = 'leg-finished';
      state.lastAction.eliminationWin = true;
      state.lastAction.winner = winner.name;
      state.lastAction.winnerSlot = winner.slot;
      queueLiveDetailWrite(
        () => addHighscore(winner.name, winner.totalScored || 0, { kind: 'elimination', legWin: true, source: 'arduino', gameMode: mode, duelId: state.game.duelId, playerSlot: winner.slot }),
        'Leg-Highscore'
      );
      queueCompletedLegStats(state, winner, generation);
    }
  }

  if (!bust) await addTurnScoreHighscoreIfNeeded(player, state, 'arduino');

  if (bust && state.game.status !== 'leg-finished') {
    await advanceAfterBust(state, player, 'arduino');
  } else if (state.game.status !== 'leg-finished' && state.game.currentThrow >= 3) {
    await advanceAfterThreeThrows(state, player, 'arduino');
  }

  if (!isLiveLifecycleCurrent(generation)) return { ok: false, reason: 'stale-lifecycle' };
  const saved = await saveLiveState(state);
  broadcastLiveState(saved);
  return { ok: true, value, player: player.name, playerSlot: player.slot, channel: formatChannel(channel), bust, remaining: player.remaining };
}

async function applyArduinoMiss(evt = {}, reason = 'timeout', generation = liveLifecycleGeneration) {
  if (!isLiveLifecycleCurrent(generation)) return { ok: false, reason: 'stale-lifecycle' };
  const state = await getLiveState();
  if (!isLiveLifecycleCurrent(generation)) return { ok: false, reason: 'stale-lifecycle' };
  if (!Array.isArray(state.players) || state.players.length === 0) return { ok: false, reason: 'no-players' };
  if (state.game.status === 'leg-finished') return { ok: false, reason: 'leg-finished' };
  if (state.lastAction && state.lastAction.autoAdvancePending) return { ok: false, reason: 'auto-advance-pending' };

  const targetIndex = Number.isInteger(state.game.activePlayer) ? state.game.activePlayer : 0;
  const player = state.players[targetIndex];
  if (!player) return { ok: false, reason: 'no-active-player' };

  player.turns = Math.max(0, Number(player.turns || 0)) + 1;
  if (!Array.isArray(player.currentRoundPoints)) player.currentRoundPoints = [];
  player.currentRoundPoints.push(0);

  if (!Array.isArray(player.throws)) player.throws = [];
  const throwSegment = 'MISS';
  const thrownAt = Date.now();
  player.throws.push({
    points: 0,
    remaining: player.remaining,
    bust: false,
    ts: thrownAt,
    source: 'arduino-miss',
    reason,
    channel: evt.channel ? formatChannel(evt.channel) : null,
    segment: throwSegment,
    raw: evt.line || null
  });
  queueLiveThrowSegment(player.slot, throwSegment, 0, state.game.mode, false, thrownAt, state.game.duelId);

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

  if (!isLiveLifecycleCurrent(generation)) return { ok: false, reason: 'stale-lifecycle' };
  const saved = await saveLiveState(state);
  broadcastLiveState(saved);
  return { ok: true, reason, player: player.name, playerSlot: player.slot, remaining: player.remaining };
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

  const releaseElapsed = Number.isFinite(ms) && ms > 0
    ? ms - matrixSniffer.lastMatrixHitPairMs
    : now - matrixSniffer.lastMatrixHitMs;
  if (matrixSniffer.matrixHitActive && releaseElapsed >= runtimeTuning.matrixHitReleaseMs) {
    matrixSniffer.matrixHitActive = false;
    matrixSniffer.lastMatrixHitRow = null;
    matrixSniffer.lastMatrixHitColumn = null;
    matrixStickySignalBlockedKey = '';
    matrixStickySignalKey = '';
    matrixStickySignalFirstAt = 0;
    matrixStickySignalCount = 0;
    normalizeArduinoStatePatch({ matrixSniffer: { ...matrixSniffer, lastMatrixHit: matrixSniffer.lastMatrixHit } });
  }
}

function handleArduinoMatrixHit(hit, generation = liveLifecycleGeneration) {
  if (!isLiveLifecycleCurrent(generation)) return;
  if (isAutoAdvancePending()) return;
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

  queueArduinoProcessing((taskGeneration) => applyArduinoThrowFromMatrix(hit, taskGeneration), generation)
    .then((result) => {
      if (!result) return;
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

async function applyArduinoThrowFromMatrix(hit, generation = liveLifecycleGeneration) {
  if (!isLiveLifecycleCurrent(generation)) return { ok: false, reason: 'stale-lifecycle' };
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
  if (!isLiveLifecycleCurrent(generation)) return { ok: false, reason: 'stale-lifecycle' };
  if (!Array.isArray(state.players) || state.players.length === 0) return { ok: false, reason: 'no-players' };
  if (state.game.status === 'leg-finished') return { ok: false, reason: 'leg-finished' };
  if (state.lastAction && state.lastAction.autoAdvancePending) return { ok: false, reason: 'auto-advance-pending' };

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
  const checkoutAttempt = !isCricket && !isElimination && isCheckoutAttempt(player.remaining, checkoutRule);
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
  const thrownAt = Date.now();
  player.throws.push({
    points: value,
    cricketPointsAwarded,
    remaining: player.remaining,
    bust,
    ts: thrownAt,
    source: 'arduino-matrix',
    turnId: state.game.turnId || 1,
    segment: throwSegment,
    row: hit.row,
    column: hit.column,
    code: hit.code,
    channel: hit.key,
    raw: hit.line || null
  });
  queueLiveThrowSegment(player.slot, throwSegment, value, mode, bust, thrownAt, state.game.duelId);

  player.average = calculateCurrentRoundAverage(player);
  state.game.currentThrow = (Number(state.game.currentThrow || 0) || 0) + 1;

  state.lastAction = {
    type: 'throw',
    source: 'arduino-matrix',
    playerIndex: targetIndex,
    playerSlot: player.slot,
    player: player.name,
    points: value,
    segment: throwSegment,
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
    player.lastCheckoutValue = getCheckoutValue(player, remainingBeforeThrow);
    player.checkoutSuccess = Number(player.checkoutSuccess || 0) + 1;
    const ruleStats = getCheckoutRuleStats(player, checkoutRule);
    ruleStats.success += 1;
    ruleStats.highest = Math.max(ruleStats.highest, Math.min(170, player.lastCheckoutValue));
    player.legs = Math.max(0, Number(player.legs || 0)) + 1;
    state.game.status = 'leg-finished';
    state.lastAction.legWin = true;
    state.lastAction.winner = player.name;
    state.lastAction.winnerSlot = player.slot;
    queueLiveDetailWrite(
      () => addHighscore(player.name, player.lastCheckoutValue, { kind: 'checkout', legWin: true, source: 'arduino-matrix', gameMode: mode, checkoutRule, duelId: state.game.duelId, playerSlot: player.slot }),
      'Leg-Highscore'
    );
    queueCompletedLegStats(state, player, generation);
  } else if (isCricket && checkCricketWin(player, state.players)) {
    player.legs = Math.max(0, Number(player.legs || 0)) + 1;
    state.game.status = 'leg-finished';
    state.lastAction.cricketWin = true;
    state.lastAction.winner = player.name;
    state.lastAction.winnerSlot = player.slot;
    queueLiveDetailWrite(
      () => addHighscore(player.name, player.cricketPoints || 0, { kind: 'cricket', legWin: true, source: 'arduino-matrix', gameMode: mode, duelId: state.game.duelId, playerSlot: player.slot }),
      'Leg-Highscore'
    );
    queueCompletedLegStats(state, player, generation);
  } else if (isElimination && checkEliminationWin(state)) {
    const winner = getEliminationWinner(state);
    if (winner) {
      winner.legs = Math.max(0, Number(winner.legs || 0)) + 1;
      state.game.status = 'leg-finished';
      state.lastAction.eliminationWin = true;
      state.lastAction.winner = winner.name;
      state.lastAction.winnerSlot = winner.slot;
      queueLiveDetailWrite(
        () => addHighscore(winner.name, winner.totalScored || 0, { kind: 'elimination', legWin: true, source: 'arduino-matrix', gameMode: mode, duelId: state.game.duelId, playerSlot: winner.slot }),
        'Leg-Highscore'
      );
      queueCompletedLegStats(state, winner, generation);
    }
  }

  if (!bust) await addTurnScoreHighscoreIfNeeded(player, state, 'arduino-matrix');

  if (bust && state.game.status !== 'leg-finished') {
    await advanceAfterBust(state, player, 'arduino-matrix');
  } else if (state.game.status !== 'leg-finished' && state.game.currentThrow >= 3) {
    await advanceAfterThreeThrows(state, player, 'arduino-matrix');
  }

  if (!isLiveLifecycleCurrent(generation)) return { ok: false, reason: 'stale-lifecycle' };
  const saved = await saveLiveState(state);
  broadcastLiveState(saved);
  return { ok: true, value, player: player.name, playerSlot: player.slot, hit, bust, remaining: player.remaining };
}

function handleArduinoTrigger(evt) {
  if (!ARDUINO_AUTO_THROW_ENABLED) return;
  if (isAutoAdvancePending()) return;
  if (pendingArduinoThrow && !pendingArduinoThrow.applied) return;
  if (Date.now() < arduinoThrowLockUntil) return;

  clearPendingArduinoThrow();
  pendingArduinoThrow = { triggerMs: Number(evt.ms || 0), line: evt.line || '', startedAt: Date.now(), generation: liveLifecycleGeneration, applied: false, timer: null };
  pendingArduinoThrow.timer = setTimeout(() => {
    const pending = pendingArduinoThrow;
    if (!pending || pending.applied) return;
    pendingArduinoThrow = null;
    pendingArduinoThrowTimer = null;
    normalizeArduinoStatePatch({ pendingThrow: false });

    queueArduinoProcessing((generation) => applyArduinoMiss({ line: pending.line || '', ms: pending.triggerMs }, 'timeout', generation), pending.generation)
      .then((result) => {
        if (!result) return;
        normalizeArduinoStatePatch({ lastMiss: result.ok ? result : { ok: false, reason: result.reason } });
      })
      .catch((err) => normalizeArduinoStatePatch({ lastMiss: { ok: false, reason: err.message }, lastAutoThrowError: err.message }));
  }, runtimeTuning.arduinoThrowWindowMs);
  pendingArduinoThrowTimer = pendingArduinoThrow.timer;
  normalizeArduinoStatePatch({ pendingThrow: true, lastAutoThrow: null, lastMiss: null, lastAutoThrowError: null });
}

function handleArduinoActiveEvent(evt) {
  if (!ARDUINO_AUTO_THROW_ENABLED) return;
  if (isAutoAdvancePending()) return;
  if (ARDUINO_REQUIRE_THROW_TRIGGER && (!pendingArduinoThrow || pendingArduinoThrow.applied)) return;
  if (pendingArduinoThrow && Date.now() - pendingArduinoThrow.startedAt > runtimeTuning.arduinoThrowWindowMs) return;

  const pending = pendingArduinoThrow;
  clearPendingArduinoThrow();
  normalizeArduinoStatePatch({ pendingThrow: false, lastAutoThrowError: null });

  const generation = liveLifecycleGeneration;
  queueArduinoProcessing((taskGeneration) => applyArduinoThrowFromChannel(evt.channel, evt, taskGeneration), generation)
    .then((result) => {
      if (!result) return;
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
    const generation = liveLifecycleGeneration;
    queueArduinoProcessing(async (taskGeneration) => {
        const state = await getLiveState();
        if (!isLiveLifecycleCurrent(taskGeneration)) return null;
        if (!Array.isArray(state.players) || state.players.length === 0) return;
        const nextIdx = (state.game.activePlayer + 1) % state.players.length;
        state.game.activePlayer = nextIdx;
        state.game.currentThrow = 0;
        advanceLiveTurn(state);
        state.game.throwRound = (state.game.throwRound || 1) + 1;
        state.lastAction = { type: 'player-switch-btn', player: state.players[nextIdx].name, playerSlot: state.players[nextIdx].slot, ts: Date.now() };
        const saved = await saveLiveState(state);
        broadcastLiveState(saved);
      }, generation)
      .catch(error => console.error('[Arduino] Spielerwechsel fehlgeschlagen:', error));
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

function chooseStartingPlayer(players) {
  if (!Array.isArray(players) || players.length === 0) return { index: 0, slot: null };
  const index = Math.floor(Math.random() * players.length);
  return { index, slot: Number(players[index].slot) };
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
  const startingPlayer = chooseStartingPlayer(fallbackPlayers);

  return {
    game: { mode: m, checkoutRule: DEFAULT_CHECKOUT_RULE, status: 'running', startedAt: Date.now(), updatedAt: Date.now(), activePlayer: startingPlayer.index, startingPlayerSlot: startingPlayer.slot, throwRound: 1, currentThrow: 0, duelId: null, selectedPlayerSlots: fallbackPlayers.map(player => Number(player.slot)) },
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
  if (score >= 80) return '80+';
  if (score >= 60) return '60+';
  return null;
}

async function addTurnScoreHighscoreIfNeeded(player, state, source = 'live') {
  if (!Array.isArray(player.currentRoundPoints) || player.currentRoundPoints.length !== 3 || player.turnScoreRecorded) return;
  const turnScore = player.currentRoundPoints.reduce((sum, points) => sum + (Number(points) || 0), 0);
  const kind = getTurnScoreHighscoreKind(turnScore);
  if (!kind) return;

  player.turnScoreRecorded = true;
  queueLiveDetailWrite(
    () => addHighscore(player.name, turnScore, { kind, source, gameMode: state.game.mode, duelId: state.game.duelId, playerSlot: player.slot, turnId: state.game.turnId }),
    'Turn-Highscore'
  );
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
  const throws = Array.isArray(player?.throws) ? player.throws.slice(-150) : [];
  const currentRoundPoints = Array.isArray(player?.currentRoundPoints)
    ? player.currentRoundPoints.map(value => Number(value)).filter(value => Number.isFinite(value)).slice(-3)
    : [];
  const average = calculateCurrentRoundAverage({ currentRoundPoints });
  const cricketHits = player?.cricketHits && typeof player.cricketHits === 'object' ? player.cricketHits : {};
  const cricketClosed = player?.cricketClosed && typeof player.cricketClosed === 'object' ? player.cricketClosed : {};
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
  return {
    slot,
    name,
    color,
    remaining,
    legs,
    turns,
    totalScored,
    bestTurn,
    throws,
    currentRoundPoints,
    average,
    checkoutAttempts,
    checkoutSuccess,
    lastCheckoutValue,
    checkoutByRule,
    cricketHits,
    cricketClosed,
    cricketPoints,
    turnScoreRecorded: !!player?.turnScoreRecorded || String(player?.turnScoreRecorded || '').toLowerCase() === 'true'
  };
}

function normalizeLiveStateSnapshot(state) {
  const source = state && typeof state === 'object' ? state : {};
  const mode = String(source.game?.mode || DEFAULT_MODE).trim();
  const safeMode = GAME_MODES[mode] ? mode : DEFAULT_MODE;
  const game = source.game && typeof source.game === 'object' ? source.game : {};
  const players = Array.isArray(source.players)
    ? source.players.map((player, index) => sanitizePlayerState(player, {
        slot: index + 1,
        name: `Spieler ${index + 1}`,
        color: ['#e63946', '#f4a261', '#2a9d8f', '#457b9d', '#9b5de5', '#f77f00'][index % 6],
        remaining: getStartScoreForMode(safeMode),
        legs: 0,
        turns: 0,
        totalScored: 0,
        bestTurn: 0,
        average: 0,
        currentRoundPoints: [],
        throws: [],
        checkoutByRule: {
          single: { attempts: 0, success: 0, highest: 0 },
          double: { attempts: 0, success: 0, highest: 0 },
          master: { attempts: 0, success: 0, highest: 0 }
        },
        cricketHits: {},
        cricketClosed: {},
        cricketPoints: 0
      }))
    : [];

  const normalizedGame = {
    ...(game || {}),
    mode: safeMode,
    status: String(game.status || 'running'),
    activePlayer: Number.isFinite(Number(game.activePlayer)) ? Math.max(0, Number(game.activePlayer)) : 0,
    currentThrow: Math.max(0, Number(game.currentThrow || 0)),
    throwRound: Math.max(1, Number(game.throwRound || 1)),
    turnId: Math.max(1, Number(game.turnId || 1)),
    duelId: Number(game.duelId || 0) || null,
    selectedPlayerSlots: players.map(player => Number(player.slot))
  };

  return {
    ...(source || {}),
    game: normalizedGame,
    players,
    lastAction: source.lastAction || null,
    arduino: source.arduino || { connected: false, lastEvent: null, activeCount: 0, heartbeatMs: null }
  };
}

function getLiveDisplayState(state) {
  const normalized = normalizeLiveStateSnapshot(state || {});
  const displayArduino = normalized.arduino && typeof normalized.arduino === 'object' && normalized.arduino.automation && typeof normalized.arduino.automation === 'object'
    ? {
        ...normalized.arduino,
        automation: {
          ...normalized.arduino.automation,
          lastAutoThrow: sanitizeArduinoAutomationResult(normalized.arduino.automation.lastAutoThrow),
          lastMiss: sanitizeArduinoAutomationResult(normalized.arduino.automation.lastMiss)
        }
      }
    : normalized.arduino;
  return {
    ...normalized,
    arduino: displayArduino,
    players: normalized.players.map(player => {
      const throws = Array.isArray(player.throws) ? player.throws : [];
      if (throws.length <= LIVE_DISPLAY_THROW_PREFIX_LIMIT + LIVE_DISPLAY_THROW_HISTORY_LIMIT) return player;
      return {
        ...player,
        throws: throws.slice(0, LIVE_DISPLAY_THROW_PREFIX_LIMIT).concat(throws.slice(-LIVE_DISPLAY_THROW_HISTORY_LIMIT))
      };
    })
  };
}

function resetLiveState(carryLegs = false, modeOverride, sourceState = null) {
  const now = Date.now();
  const sourcePlayers = Array.isArray(sourceState?.players) && sourceState.players.length > 0
    ? sourceState.players
    : savedLiveStateTemplate;
  const basePlayers = sourcePlayers || [];
  const mode = modeOverride || savedLiveMode || DEFAULT_MODE;
  const startScore = getStartScoreForMode(mode);
  const legsBySlot = carryLegs && Array.isArray(sourcePlayers)
    ? new Map(sourcePlayers.map(p => [Number(p.slot || 0), Number(p.legs || 0)]))
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
  const startingPlayer = chooseStartingPlayer(players);

  return {
    game: {
      mode,
      checkoutRule: savedCheckoutRule || DEFAULT_CHECKOUT_RULE,
      status: 'running',
      startedAt: now,
      updatedAt: now,
      activePlayer: startingPlayer.index,
      startingPlayerSlot: startingPlayer.slot,
      throwRound: 1,
      currentThrow: 0,
      turnId: 1,
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
  if (liveStateCache) {
    const cached = cloneLiveState(liveStateCache);
    cached.arduino = buildArduinoStateView();
    return cached;
  }

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
      turnId: Math.max(1, Number(saved.game?.turnId || 1)),
      duelId: Number(saved.game?.duelId || 0) || null,
      selectedPlayerSlots: mergedPlayers.map(player => Number(player.slot)),
      matchType: String(saved.game?.matchType || ''),
      bestOf: Math.max(1, Number(saved.game?.bestOf || 1)),
      legsToWin: Math.max(1, Number(saved.game?.legsToWin || 1)),
      tournamentName: String(saved.game?.tournamentName || ''),
      tournamentId: Number(saved.game?.tournamentId || 0) || null,
      tournamentMatchId: Number(saved.game?.tournamentMatchId || 0) || null,
      tournamentRound: Number(saved.game?.tournamentRound || 0) || null,
      tournamentMatchLabel: String(saved.game?.tournamentMatchLabel || ''),
      tournamentMatchStartedAt: Number(saved.game?.tournamentMatchStartedAt || 0) || null
    },
    players: mergedPlayers,
    lastAction: saved.lastAction || null,
    arduino: arduinoView
  };

  liveStateCache = cloneLiveState(state);

  return state;
}

async function saveLiveState(state, options = {}) {
  const safe = normalizeLiveStateSnapshot({ ...(state || {}), game: { ...((state && state.game) || {}), updatedAt: Date.now() } });
  liveStateCache = cloneLiveState(safe);
  queueLiveStateWrite(safe, options);
  return safe;
}

async function getHighscores(gameMode = '', options = {}) {
  return dataStore.getHighscores(500, gameMode, options.includeActive === true);
}

async function addHighscore(playerName, score, meta = {}) {
  const safeName = String(playerName || '').trim();
  const safeScore = Number(score || 0);
  if (!safeName || !Number.isFinite(safeScore) || safeScore <= 0) return;
  let playerSlot = Number(meta.playerSlot) > 0 ? Number(meta.playerSlot) : null;
  if (!playerSlot) {
    const matches = (await dataStore.getPlayers()).filter(player => String(player.name || '').trim().toLowerCase() === safeName.toLowerCase());
    if (matches.length === 1) playerSlot = Number(matches[0].slot) || null;
  }
  const duelId = Number(meta.duelId) > 0 ? Number(meta.duelId) : null;
  let eventKey = meta.eventKey || null;
  if (!eventKey && duelId && playerSlot) {
    const duel = await dataStore.getDuel(duelId);
    const legNumber = Number(duel?.total_legs || 0) + 1;
    eventKey = ['duel', duelId, legNumber, playerSlot, meta.kind || 'score', safeScore, meta.turnId || ''].join(':');
  }
  await dataStore.addHighscore({ player: safeName, score: safeScore, ts: Date.now(), legWin: !!meta.legWin, gameMode: meta.gameMode || meta.mode || DEFAULT_MODE, ...meta, playerSlot, eventKey });
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
    invalidateLiveLifecycle();
    savedLiveMode = mode;
    const fresh = resetLiveState(false, mode);
    const saved = await saveLiveState(fresh, { immediate: true });
    broadcastReload();
    res.json(saved);
  } catch (err) { res.status(500).json({ error: 'Modus-Wechsel fehlgeschlagen: ' + err.message }); }
});

app.post('/api/live/start', async (req, res) => {
  const mode = String(req.body?.mode || DEFAULT_MODE).trim();
  const checkoutRule = String(req.body?.checkoutRule || DEFAULT_CHECKOUT_RULE).trim();
  const slots = [...new Set((Array.isArray(req.body?.playerSlots) ? req.body.playerSlots : []).map(Number).filter(Number.isInteger))];
  if (!GAME_MODES[mode]) return res.status(400).json({ error: `Unbekannter Modus: ${mode}` });
  if (!CHECKOUT_RULES[checkoutRule]) return res.status(400).json({ error: `Unbekannte Finish-Regel: ${checkoutRule}` });
  if (slots.length < 1 || slots.length > 8) return res.status(400).json({ error: 'Bitte 1 bis 8 Spieler auswählen.' });
  try {
    const currentState = await getLiveState();
    if (Number(currentState.game?.duelId || 0) > 0) {
      const currentDuel = await dataStore.getDuel(currentState.game.duelId);
      if (currentDuel && currentDuel.status === 'active') await dataStore.cancelDuel(currentDuel.id);
    }
    const availableSlots = new Set((await getActivePlayersForLive()).map(player => Number(player.slot)));
    if (slots.some(slot => !availableSlots.has(slot))) return res.status(400).json({ error: 'Auswahl enthält keinen aktiven Spieler.' });
    invalidateLiveLifecycle();
    const fresh = await defaultLiveState(mode, slots);
    fresh.game.checkoutRule = checkoutRule;
    savedLiveMode = mode;
    savedCheckoutRule = checkoutRule;
    const saved = await saveLiveState(fresh, { immediate: true });
    broadcastReload();
    res.json(saved);
  } catch (err) { res.status(500).json({ error: 'Solospiel konnte nicht gestartet werden: ' + err.message }); }
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
    broadcastLiveState(saved);
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
    invalidateLiveLifecycle();
    const fresh = await defaultLiveState(savedLiveMode, slots);
    fresh.game.selectedPlayerSlots = slots;
    const saved = await saveLiveState(fresh, { immediate: true });
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
app.get('/api/sounds/available', (_req, res) => {
  const soundsDirectory = path.join(__dirname, 'public', 'sounds');
  try {
    res.json(scanSoundDirectory(soundsDirectory));
  } catch (err) {
    if (err.code === 'ENOENT') return res.json({ sounds: [] });
    res.status(500).json({ error: 'Sound-Verzeichnis konnte nicht gelesen werden' });
  }
});
app.put('/api/event-effects', requireLocalNetwork, (req, res) => {
  const current = getSettings();
  const eventEffects = req.body && typeof req.body === 'object' ? req.body.eventEffects : null;
  if (!eventEffects || typeof eventEffects !== 'object' || Array.isArray(eventEffects)) {
    return res.status(400).json({ error: 'eventEffects-Konfiguration erwartet.' });
  }
  const next = { ...current, eventEffects: normalizeEventEffects(eventEffects) };
  saveSettings(next);
  broadcastReload();
  res.json({ eventEffects: next.eventEffects });
});
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
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.json(getLiveDisplayState(await getLiveState()));
  }
  catch (err) { res.status(500).json({ error: 'Live-State konnte nicht geladen werden: ' + err.message }); }
});

app.get('/api/duels', async (req, res) => {
  const category = String(req.query.category || 'all').trim().toLowerCase();
  const requestedStatus = String(req.query.status || 'finished').trim().toLowerCase();
  const status = requestedStatus === 'all' ? '' : requestedStatus;
  if (!['all', 'single', 'duel', 'group', 'tournament'].includes(category)) return res.status(400).json({ error: 'category muss all, single, duel, group oder tournament sein.' });
  if (requestedStatus && !['all', 'active', 'finished', 'canceled'].includes(requestedStatus)) return res.status(400).json({ error: 'status muss all, active, finished oder canceled sein.' });
  try {
    const duels = await dataStore.listDuels(req.query.limit || 20, status);
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
    const duels = await dataStore.listFinishedDuelsForStats();
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
  const status = String(req.query.status || 'finished').trim().toLowerCase();
  if (!['all', 'single', 'duel', 'group', 'tournament'].includes(category)) return res.status(400).json({ error: 'category muss all, single, duel, group oder tournament sein.' });
  if (status !== 'finished') return res.status(400).json({ error: 'Statistiken werden nur für abgeschlossene Begegnungen geführt.' });
  try {
    const duels = await dataStore.listDuels(100, status);
    const payload = aggregateDuelStats({ duels, slots, category, exactGroup });
    res.json(payload);
  } catch (err) { res.status(500).json({ error: 'Duellstatistik konnte nicht geladen werden: ' + err.message }); }
});

app.get('/api/duels/:id', async (req, res) => {
  try {
    const duel = await dataStore.getDuel(req.params.id);
    if (!duel) return res.status(404).json({ error: 'Begegnung nicht gefunden.' });
    res.json(duel);
  } catch (err) { res.status(500).json({ error: 'Begegnung konnte nicht geladen werden: ' + err.message }); }
});

app.delete('/api/duels/:id', requireAdmin, async (req, res) => {
  const duelId = Number(req.params.id);
  if (!Number.isInteger(duelId) || duelId <= 0) return res.status(400).json({ error: 'Ungültige Begegnungs-ID.' });
  try {
    const duel = await dataStore.getDuel(duelId);
    if (!duel) return res.status(404).json({ error: 'Begegnung nicht gefunden.' });
    const state = await getLiveState();
    const isCurrentDuel = Number(state.game?.duelId) === duelId;
    const deleted = await dataStore.deleteDuel(duelId);
    if (!deleted) return res.status(404).json({ error: 'Begegnung nicht gefunden.' });
    if (isCurrentDuel) {
      const fresh = await defaultLiveState(String(state.game?.mode || DEFAULT_MODE), state.game?.selectedPlayerSlots);
      await saveLiveState(fresh);
      broadcastReload();
    }
    res.json({ ok: true, id: duelId });
  } catch (err) { res.status(500).json({ error: 'Begegnung konnte nicht gelöscht werden: ' + err.message }); }
});

app.post('/api/duels/start', async (req, res) => {
  try {
    const currentState = await getLiveState();
    if (Number(currentState.game?.duelId || 0) > 0) {
      const currentDuel = await dataStore.getDuel(currentState.game.duelId);
      if (currentDuel && currentDuel.status === 'active') await dataStore.cancelDuel(currentDuel.id);
    }
    const matchType = ['single', 'direct', 'group', 'tournament'].includes(String(req.body?.matchType)) ? String(req.body.matchType) : 'direct';
    const mode = String(req.body?.mode || '501');
    const checkoutRule = String(req.body?.checkoutRule || 'double');
    const bestOf = Number(req.body?.bestOf || 1);
    const slots = [...new Set((Array.isArray(req.body?.playerSlots) ? req.body.playerSlots : []).map(Number).filter(Number.isInteger))];
    if (!GAME_MODES[mode]) return res.status(400).json({ error: 'Unbekannter Spielmodus für die Begegnung.' });
    if (!CHECKOUT_RULES[checkoutRule]) return res.status(400).json({ error: `Unbekannte Finish-Regel: ${checkoutRule}` });
    if (!Number.isInteger(bestOf) || bestOf < 1 || bestOf > 15 || bestOf % 2 === 0) return res.status(400).json({ error: 'Best-of muss eine ungerade Zahl zwischen 1 und 15 sein.' });
    if ((matchType === 'single' && slots.length < 1) || (matchType === 'direct' && slots.length !== 2) || (matchType !== 'single' && slots.length < 2) || slots.length > (matchType === 'tournament' ? 16 : 8)) return res.status(400).json({ error: matchType === 'single' ? 'Bitte mindestens einen Spieler auswählen.' : 'Bitte 2 bis 16 Spieler auswählen; ein Direktduell benötigt genau 2.' });
    if (matchType === 'tournament' && ![2, 4, 8, 16].includes(slots.length)) return res.status(400).json({ error: 'Ein K.-o.-Turnier benötigt 2, 4, 8 oder 16 Spieler.' });
    const configuredPlayers = await getPlayers();
    const selectedPlayers = slots.map(slot => configuredPlayers.find(player => Number(player.slot) === slot)).filter(player => player && String(player.name || '').trim());
    if (selectedPlayers.length !== slots.length) return res.status(400).json({ error: 'Alle ausgewählten Slots müssen einen Spielernamen haben.' });
    invalidateLiveLifecycle();
    const profiles = await dataStore.getProfiles();
    const profileByName = new Map(profiles.map(profile => [String(profile.name || '').trim().toLowerCase(), Number(profile.id)]));
    const tournamentName = String(req.body?.tournamentName || '').trim();
    const tournamentPlayers = selectedPlayers.map(player => ({ slot: player.slot, name: player.name, profileId: profileByName.get(String(player.name).trim().toLowerCase()) || null }));
    const tournament = matchType === 'tournament'
      ? await dataStore.createTournament({ mode, tournamentName, checkoutRule, players: tournamentPlayers, bestOf })
      : null;
    const duel = tournament ? tournament.duel : await dataStore.createDuel({ mode, matchType, tournamentName, checkoutRule, players: tournamentPlayers });
    const activeSlots = tournament ? duel.players.map(player => Number(player.player_slot)) : slots;
    const fresh = await defaultLiveState(mode, activeSlots);
    fresh.game.duelId = duel.id;
    fresh.game.checkoutRule = checkoutRule;
    fresh.game.selectedPlayerSlots = activeSlots;
    fresh.game.matchType = matchType;
    fresh.game.bestOf = bestOf;
    fresh.game.legsToWin = Math.ceil(bestOf / 2);
    fresh.game.tournamentName = tournamentName;
    if (tournament) {
      fresh.game.tournamentId = tournament.id;
      fresh.game.tournamentMatchId = tournament.matchId;
      fresh.game.tournamentRound = 1;
      fresh.game.tournamentMatchLabel = tournament.matches?.find(match => Number(match.id) === Number(tournament.matchId))?.label || 'Erste Runde';
    }
    savedLiveMode = mode;
    savedCheckoutRule = checkoutRule;
    await saveLiveState(fresh, { immediate: true });
    broadcastReload();
    res.json(fresh);
  } catch (err) { res.status(500).json({ error: 'Begegnung konnte nicht gestartet werden: ' + err.message }); }
});

app.get('/api/tournaments/:id', async (req, res) => {
  try {
    const tournament = await dataStore.getTournament(req.params.id);
    if (!tournament) return res.status(404).json({ error: 'Turnier nicht gefunden.' });
    res.json(tournament);
  } catch (err) { res.status(500).json({ error: 'Turnier konnte nicht geladen werden: ' + err.message }); }
});

app.post('/api/tournaments/:id/matches/:matchId/start', async (req, res) => {
  try {
    const state = await getLiveState();
    const tournamentId = Number(req.params.id);
    const matchId = Number(req.params.matchId);
    if (String(state.game?.matchType) !== 'tournament' || Number(state.game?.tournamentId) !== tournamentId || Number(state.game?.tournamentMatchId) !== matchId) {
      return res.status(409).json({ error: 'Dieses Turnierduell ist nicht aktiv.' });
    }
    if (!Number(state.game?.tournamentMatchStartedAt || 0)) {
      const ts = Date.now();
      state.game.tournamentMatchStartedAt = ts;
      state.lastAction = {
        type: 'tournament-match-start',
        tournamentId,
        tournamentMatchId: matchId,
        ts
      };
      await saveLiveState(state);
      broadcastReload();
      broadcastLiveState(state);
    }
    res.json(state);
  } catch (err) { res.status(500).json({ error: 'Turnierduell konnte nicht gestartet werden: ' + err.message }); }
});

app.post('/api/tournaments/:id/presentation/bracket', async (req, res) => {
  try {
    const state = await getLiveState();
    const tournamentId = Number(req.params.id);
    if (String(state.game?.matchType) !== 'tournament' || Number(state.game?.tournamentId) !== tournamentId) {
      return res.status(409).json({ error: 'Dieses Turnier ist nicht aktiv.' });
    }
    const ts = Date.now();
    const previousAction = state.lastAction || {};
    state.lastAction = {
      ...previousAction,
      type: previousAction.tournamentWaiting ? 'tournament-finished' : 'tournament-bracket-show',
      tournamentId,
      tournamentMatchId: Number(state.game.tournamentMatchId || 0) || null,
      presentation: previousAction.tournamentWaiting ? 'winner-bracket' : 'bracket',
      ts
    };
    await saveLiveState(state);
    broadcastReload();
    broadcastLiveState(state);
    res.json(state);
  } catch (err) { res.status(500).json({ error: 'Turnierbaum konnte nicht angezeigt werden: ' + err.message }); }
});

app.post('/api/duels/:id/presentation/stats-hidden', async (req, res) => {
  try {
    const state = await getLiveState();
    const duelId = Number(req.params.id);
    if (Number(state.game?.duelId) !== duelId) {
      return res.status(409).json({ error: 'Diese Begegnung ist nicht aktiv.' });
    }
    const ts = Date.now();
    state.lastAction = {
      ...(state.lastAction || {}),
      type: 'duel-stats-hide',
      duelId,
      ts
    };
    await saveLiveState(state);
    broadcastReload();
    broadcastLiveState(state);
    res.json(state);
  } catch (err) { res.status(500).json({ error: 'Duellstatistik konnte nicht ausgeblendet werden: ' + err.message }); }
});

app.post('/api/duels/:id/finish', requireAdmin, async (req, res) => {
  try {
    const state = await getLiveState();
    if (Number(state.game.duelId) !== Number(req.params.id)) return res.status(409).json({ error: 'Diese Begegnung ist nicht aktiv.' });
    invalidateLiveLifecycle();
    const winnerSlot = Number(req.body?.winnerSlot || 0) || null;
    const duel = await dataStore.finishDuel(req.params.id, winnerSlot);
    for (const participant of duel?.players || []) {
      const playerId = Number(participant.player_slot);
      if (!Number.isInteger(playerId) || playerId < 1) continue;
      await dataStore.initPlayerStats(playerId);
      const playerStats = await dataStore.getPlayerStats(playerId) || {};
      await dataStore.updatePlayerStats(playerId, {
        games_played: Number(playerStats.games_played || 0) + 1,
        games_won: Number(playerStats.games_won || 0) + (playerId === winnerSlot ? 1 : 0)
      });
    }
    state.game.duelId = null;
    await saveLiveState(state, { immediate: true });
    broadcastReload();
    res.json(duel);
  } catch (err) { res.status(500).json({ error: 'Begegnung konnte nicht beendet werden: ' + err.message }); }
});

app.post('/api/duels/:id/cancel', async (req, res) => {
  try {
    const state = await getLiveState();
    const duelId = Number(req.params.id);
    if (Number(state.game?.duelId) !== duelId) return res.status(409).json({ error: 'Diese Begegnung ist nicht aktiv.' });
    invalidateLiveLifecycle();
    const duel = await dataStore.cancelDuel(duelId);
    const fresh = await defaultLiveState(String(state.game.mode || DEFAULT_MODE), state.game.selectedPlayerSlots);
    savedLiveMode = String(state.game.mode || DEFAULT_MODE);
    await saveLiveState(fresh, { immediate: true });
    broadcastReload();
    res.json({ duel, state: fresh, message: 'Begegnung abgebrochen. Sie wird nicht in Highscores oder Statistiken aufgenommen und kann im Adminbereich gelöscht werden.' });
  } catch (err) { res.status(500).json({ error: 'Begegnung konnte nicht abgebrochen werden: ' + err.message }); }
});

app.post('/api/live/reset', async (req, res) => {
  const carryLegs = !!(req.body && req.body.carryLegs);
  try {
    invalidateLiveLifecycle();
    const mode = savedLiveMode || DEFAULT_MODE;
    const current = await getLiveState();
    if (!carryLegs && Number(current.game?.duelId || 0) > 0) {
      const currentDuel = await dataStore.getDuel(current.game.duelId);
      if (currentDuel && currentDuel.status === 'active') await dataStore.cancelDuel(currentDuel.id);
    }
    const fresh = resetLiveState(carryLegs, mode, current);
    if (carryLegs && Number(current.game?.duelId || 0) > 0) {
      fresh.game.duelId = Number(current.game.duelId);
      fresh.game.matchType = String(current.game.matchType || 'direct');
      fresh.game.bestOf = Math.max(1, Number(current.game.bestOf || 1));
      fresh.game.legsToWin = Math.max(1, Number(current.game.legsToWin || 1));
      fresh.game.checkoutRule = String(current.game.checkoutRule || savedCheckoutRule || DEFAULT_CHECKOUT_RULE);
      fresh.game.selectedPlayerSlots = Array.isArray(current.game.selectedPlayerSlots)
        ? current.game.selectedPlayerSlots.map(Number)
        : fresh.players.map(player => Number(player.slot));
      fresh.game.tournamentName = String(current.game.tournamentName || '');
      fresh.game.tournamentId = Number(current.game.tournamentId || 0) || null;
      fresh.game.tournamentMatchId = Number(current.game.tournamentMatchId || 0) || null;
      fresh.game.tournamentRound = Number(current.game.tournamentRound || 0) || null;
      fresh.game.tournamentMatchLabel = String(current.game.tournamentMatchLabel || '');
    }
    const saved = await saveLiveState(fresh, { immediate: true });
    broadcastReload();
    res.json(saved);
  } catch (err) { res.status(500).json({ error: 'Live-Reset fehlgeschlagen: ' + err.message }); }
});

app.post('/api/live/throw', async (req, res) => {
  const playerSlot = Number(req.body && req.body.playerSlot);
  const playerIndex = Number(req.body && req.body.playerIndex);
  const points = Number(req.body && req.body.points);

  let targetIndex = -1;
  if (Number.isInteger(playerSlot) && playerSlot > 0) {
    targetIndex = Number.isInteger(playerIndex) && playerIndex >= 0
      ? playerIndex
      : -1;
  }
  else if (Number.isInteger(playerIndex) && playerIndex >= 0) targetIndex = playerIndex;

  if (!(Number.isInteger(playerSlot) && playerSlot > 0) && targetIndex < 0) {
    return res.status(400).json({ error: 'playerSlot oder playerIndex erforderlich.' });
  }
  if (!Number.isFinite(points) || points < 0 || points > 180) return res.status(400).json({ error: 'points muss zwischen 0 und 180 liegen.' });

  try {
    const generation = liveLifecycleGeneration;
    const state = await getLiveState();
    if (!isLiveLifecycleCurrent(generation)) return res.status(409).json({ error: 'Das Spiel wurde inzwischen neu gestartet.' });
    if (Number.isInteger(playerSlot) && playerSlot > 0) {
      targetIndex = state.players.findIndex(player => Number(player.slot) === playerSlot);
    }
    if (state.game.status === 'leg-finished') return res.status(400).json({ error: 'Spiel ist bereits beendet.' });
    if (targetIndex < 0 || targetIndex >= state.players.length) return res.status(400).json({ error: 'Spieler nicht gefunden.' });

    const player = state.players[targetIndex];
    const mode = state.game.mode || DEFAULT_MODE;
    const modeDef = GAME_MODES[mode] || GAME_MODES[DEFAULT_MODE];
    const isCricket = modeDef.type === 'cricket';
    const isElimination = modeDef.type === 'elimination';
    const checkoutRule = state.game.checkoutRule || DEFAULT_CHECKOUT_RULE;
    const incomingSegment = typeof req.body?.segment === 'string' ? req.body.segment.toUpperCase() : pointsToSegment(points);
    const checkoutAttempt = !isCricket && !isElimination && isCheckoutAttempt(player.remaining, checkoutRule);
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
    const thrownAt = Date.now();
    player.throws.push({ points, remaining: player.remaining, bust, ts: thrownAt, mode, segment: throwSegment, turnId: state.game.turnId || 1 });
    queueLiveThrowSegment(player.slot, throwSegment, points, mode, bust, thrownAt, state.game.duelId);

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
      player.lastCheckoutValue = getCheckoutValue(player, remainingBeforeThrow);
      player.checkoutSuccess = Number(player.checkoutSuccess || 0) + 1;
      const ruleStats = getCheckoutRuleStats(player, checkoutRule);
      ruleStats.success += 1;
      ruleStats.highest = Math.max(ruleStats.highest, Math.min(170, player.lastCheckoutValue));
      player.legs += 1;
      state.game.status = 'leg-finished';
      state.lastAction.legWin = true;
      state.lastAction.winner = player.name;
      state.lastAction.winnerSlot = player.slot;
      queueLiveDetailWrite(
        () => addHighscore(player.name, player.lastCheckoutValue, { kind: 'checkout', legWin: true, gameMode: mode, checkoutRule, duelId: state.game.duelId, playerSlot: player.slot }),
        'Leg-Highscore'
      );
      queueCompletedLegStats(state, player, generation);
    } else if (isCricket && checkCricketWin(player, state.players)) {
      player.legs += 1;
      state.game.status = 'leg-finished';
      state.lastAction.cricketWin = true;
      state.lastAction.winner = player.name;
      state.lastAction.winnerSlot = player.slot;
      queueLiveDetailWrite(
        () => addHighscore(player.name, player.cricketPoints || 0, { kind: 'cricket', legWin: true, gameMode: mode, duelId: state.game.duelId, playerSlot: player.slot }),
        'Leg-Highscore'
      );
      queueCompletedLegStats(state, player, generation);
    } else if (isElimination && checkEliminationWin(state)) {
      const winner = getEliminationWinner(state);
      if (winner) {
        winner.legs += 1;
        state.game.status = 'leg-finished';
        state.lastAction.eliminationWin = true;
        state.lastAction.winner = winner.name;
        state.lastAction.winnerSlot = winner.slot;
        queueLiveDetailWrite(
          () => addHighscore(winner.name, winner.totalScored || 0, { kind: 'elimination', legWin: true, gameMode: mode, duelId: state.game.duelId, playerSlot: winner.slot }),
          'Leg-Highscore'
        );
        queueCompletedLegStats(state, winner, generation);
      }
    }

    if (!bust) await addTurnScoreHighscoreIfNeeded(player, state, 'manual');

    if (bust && state.game.status !== 'leg-finished') {
      await advanceAfterBust(state, player, 'manual');
    } else if (state.game.status !== 'leg-finished' && state.game.currentThrow >= 3) {
      await advanceAfterThreeThrows(state, player, 'manual');
    }

    if (!isLiveLifecycleCurrent(generation)) return res.status(409).json({ error: 'Das Spiel wurde inzwischen neu gestartet.' });
    const saved = await saveLiveState(state);
    broadcastLiveState(saved);
    res.json(saved);
  } catch (err) { res.status(500).json({ error: 'Wurf konnte nicht gespeichert werden: ' + err.message }); }
});

app.post('/api/live/next-player', async (req, res) => {
  try {
    cancelScheduledAutoAdvance();
    clearPendingArduinoThrow();
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
          mode: state.game.mode,
          turnId: state.game.turnId || 1
        });
      }
    }
    const nextIndex = (state.game.activePlayer + 1) % state.players.length;
    state.game.activePlayer = nextIndex;
    state.game.currentThrow = 0;
    advanceLiveTurn(state);
    state.game.throwRound = (state.game.throwRound || 1) + 1;
    // Neuen aktiven Spieler's currentRoundPoints leeren
    state.players[nextIndex].currentRoundPoints = [];
    state.players[nextIndex].turnScoreRecorded = false;
    state.lastAction = { type: 'next-player', player: state.players[nextIndex].name, playerSlot: state.players[nextIndex].slot, ts: Date.now() };
    const saved = await saveLiveState(state);
    broadcastLiveState(saved);
    res.json(saved);
  } catch (err) { res.status(500).json({ error: 'Next-Player fehlgeschlagen: ' + err.message }); }
});

app.post('/api/live/undo', async (req, res) => {
  try {
    cancelScheduledAutoAdvance();
    const state = await getLiveState();
    if (state.game.status === 'leg-finished') return res.status(400).json({ error: 'Spiel ist bereits beendet.' });
    let lastThrowTime = 0, lastThrowPlayer = -1, lastThrowIndex = -1;

    state.players.forEach((player, idx) => {
      const throws = Array.isArray(player.throws) ? player.throws : [];
      for (let throwIndex = throws.length - 1; throwIndex >= 0; throwIndex -= 1) {
        const candidate = throws[throwIndex];
        if (candidate && candidate.source === 'manual-miss') continue;
        if (candidate && Number(candidate.ts || 0) > lastThrowTime) {
          lastThrowTime = Number(candidate.ts || 0);
          lastThrowPlayer = idx;
          lastThrowIndex = throwIndex;
        }
        break;
      }
    });

    if (lastThrowPlayer === -1) return res.status(400).json({ error: 'Kein Wurf zum Rückgängigmachen vorhanden.' });

    const player = state.players[lastThrowPlayer];
    const lastThrow = player.throws.splice(lastThrowIndex, 1)[0];

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

    if (Number.isFinite(Number(lastThrow.turnId))) {
      restoreCurrentRoundPoints(player, lastThrow.turnId);
    } else if (Array.isArray(player.currentRoundPoints) && player.currentRoundPoints.length > 0) {
      player.currentRoundPoints.pop();
      player.turnScoreRecorded = false;
    } else {
      player.currentRoundPoints = [];
      player.turnScoreRecorded = false;
    }

    state.game.currentThrow = player.currentRoundPoints.length;
    state.game.activePlayer = lastThrowPlayer;
    state.lastAction = { type: 'undo', player: player.name, points: lastThrow.points, ts: Date.now() };

    const saved = await saveLiveState(state);
    broadcastLiveState(saved);
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
    const existing = await dataStore.getHighscore(id);
    if (!existing) return res.status(404).json({ error: 'Highscore nicht gefunden.' });
    if (String(existing.kind || '') !== 'manual') {
      return res.status(409).json({ error: existing.duel_id ? `Automatischer Highscore gehört zu Begegnung #${existing.duel_id}. Bitte dort die Quelldaten korrigieren oder löschen.` : 'Automatische Highscores können nur über ihre Spieldaten korrigiert werden.' });
    }
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
    const existing = await dataStore.getHighscore(id);
    if (!existing) return res.status(404).json({ error: 'Highscore nicht gefunden.' });
    if (String(existing.kind || '') !== 'manual') {
      return res.status(409).json({ error: existing.duel_id ? `Automatischer Highscore gehört zu Begegnung #${existing.duel_id}. Bitte dort die Quelldaten korrigieren.` : 'Automatische Highscores können nur über ihre Spieldaten korrigiert werden.' });
    }
    const matchingPlayers = (await dataStore.getPlayers()).filter(item => String(item.name || '').trim().toLowerCase() === player.toLowerCase());
    const playerSlot = matchingPlayers.length === 1 ? Number(matchingPlayers[0].slot) : null;
    await dataStore.updateHighscore(id, player, score, playerSlot);
    res.json({ ok: true, highscores: await getHighscores() });
  } catch (err) { res.status(500).json({ error: 'Highscore konnte nicht bearbeitet werden: ' + err.message }); }
});

app.delete('/api/highscores', requireAdmin, async (_req, res) => {
  try {
    await dataStore.clearManualHighscores();
    res.json({ ok: true, highscores: await getHighscores() });
  } catch (err) { res.status(500).json({ error: 'Manuelle Highscores konnten nicht gelöscht werden: ' + err.message }); }
});

// ── Täglicher Höchstwert ──
app.get('/api/highscores/daily', async (_req, res) => {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const fromTs = todayStart.getTime();
    const all = await getHighscores('', { includeActive: true });
    const today = all.filter(e => Number(e.ts) >= fromTs).sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || Number(b.ts || 0) - Number(a.ts || 0));
    const best = today.length > 0 ? today[0] : null;
    const checkouts = today.filter(entry => entry.kind === 'checkout');
    const bestCheckout = checkouts.length > 0 ? checkouts[0] : null;
    res.json({ best, bestCheckout, count: today.length, list: today });
  } catch (err) { res.status(500).json({ error: 'Daily-Highscore fehlgeschlagen: ' + err.message }); }
});

app.get('/api/highscores/overview', async (_req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const players = await dataStore.getPlayers();
    const profiles = await dataStore.getProfiles();
    const profileIdsByName = new Map(profiles.map(profile => [String(profile.name || '').trim().toLowerCase(), Number(profile.id)]));
    const entries = [];
    for (const player of players) {
      if (!player.name) continue;
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
        profileId: resolvePlayerIdentity({ name: player.name, slot: player.slot }, profileIdsByName),
        player: player.name,
        mode: 'gesamt',
        category: 'all',
        count180: Number(stats.count_180 || 0),
        count171Plus: Number(stats.count_171plus || 0),
        count140Plus: Number(stats.count_140plus || 0),
        count100Plus: Number(stats.count_100plus || 0),
        threeDartAverage: darts > 0 ? Number((totalScored / darts * 3).toFixed(1)) : 0,
        firstNineAverage: Number(stats.avg_first9 || 0),
        firstNineSamples: Number(stats.first_nine_samples || 0),
        firstNineLegacy: Boolean(Number(stats.first_nine_legacy || 0)),
        checkoutRate: checkoutAttempts > 0 ? Number((checkoutSuccess / checkoutAttempts * 100).toFixed(1)) : 0,
        checkoutAttempts,
        checkoutSuccess,
        checkoutByRule,
        highestCheckout: Number(stats.highest_checkout || 0),
        matchesPlayed: Number(stats.games_played || 0),
        matchesWon: Number(stats.games_won || 0),
        gamesPlayed: Number(stats.games_played || 0),
        gamesWon: Number(stats.games_won || 0),
        legsPlayed: Number(stats.legs_played || 0),
        legsWon: Number(stats.legs_won || 0),
        legWinRate: percentage(stats.legs_won, stats.legs_played),
        matchWinRate: percentage(stats.games_won, stats.games_played),
        checkoutStatsVersion: Number(stats.checkout_stats_version || 1),
        trackingSince: stats.checkout_tracking_since ? Number(stats.checkout_tracking_since) : null
      });
    }

    const grouped = new Map();
    const duels = await dataStore.listFinishedDuelsForStats();
    for (const duel of duels) {
      const category = ['single', 'duel', 'group', 'tournament'].includes(String(duel.category || '')) ? duel.category : 'duel';
      const mode = String(duel.mode || '501');
      for (const player of duel.players || []) {
        const slot = Number(player.player_slot);
        const profileId = resolvePlayerIdentity({ profileId: player.profile_id, name: player.player_name, slot }, profileIdsByName);
        const key = category + ':' + mode + ':' + profileId;
        if (!grouped.has(key)) grouped.set(key, {
          profileId,
          player: player.player_name,
          mode,
          category,
          count180: 0,
          count171Plus: 0,
          count140Plus: 0,
          count100Plus: 0,
          darts: 0,
          totalScored: 0,
          firstNineTotal: 0,
          firstNineCount: 0,
          checkoutAttempts: 0,
          checkoutSuccess: 0,
          highestCheckout: 0,
          checkoutByRule: {
            single: { attempts: 0, success: 0, highest: 0 },
            double: { attempts: 0, success: 0, highest: 0 },
            master: { attempts: 0, success: 0, highest: 0 }
          },
          gamesPlayed: 0,
          gamesWon: 0,
          legsPlayed: 0,
          legsWon: 0
        });
        const entry = grouped.get(key);
        entry.gamesPlayed += 1;
        if (Number(duel.winner_slot) === slot) entry.gamesWon += 1;
        for (const leg of duel.legs || []) {
          const legPlayer = (leg.players || []).find(item => Number(item.player_slot) === slot);
          if (!legPlayer) continue;
          entry.legsPlayed += 1;
          entry.legsWon += Number(legPlayer.won || 0);
          entry.darts += Number(legPlayer.darts || 0);
          entry.totalScored += Number(legPlayer.scored || 0);
          entry.count180 += Number(legPlayer.count_180 || 0);
          entry.count171Plus += Number(legPlayer.count_171plus || 0);
          entry.count140Plus += Number(legPlayer.count_140plus || 0);
          entry.count100Plus += Number(legPlayer.count_100plus || 0);
          entry.checkoutAttempts += Number(legPlayer.checkout_attempts || 0);
          entry.checkoutSuccess += Number(legPlayer.checkout_success || 0);
          entry.highestCheckout = Math.max(entry.highestCheckout, Number(legPlayer.checkout_highest || 0));
          const checkoutRule = Number(duel.checkout_stats_version || 1) >= 2 && ['single', 'double', 'master'].includes(String(duel.checkout_rule || '').toLowerCase())
            ? String(duel.checkout_rule).toLowerCase()
            : null;
          if (checkoutRule) {
            entry.checkoutByRule[checkoutRule].attempts += Number(legPlayer.checkout_attempts || 0);
            entry.checkoutByRule[checkoutRule].success += Number(legPlayer.checkout_success || 0);
            entry.checkoutByRule[checkoutRule].highest = Math.max(entry.checkoutByRule[checkoutRule].highest, Number(legPlayer.checkout_highest || 0));
          }
          if (Number(legPlayer.first_nine_avg || 0) > 0) {
            entry.firstNineTotal += Number(legPlayer.first_nine_avg);
            entry.firstNineCount += 1;
          }
        }
      }
    }
    const groupedEntries = Array.from(grouped.values()).map(entry => addDerivedMetrics({
      ...entry,
      firstNineSamples: entry.firstNineCount,
      matchesPlayed: entry.gamesPlayed,
      matchesWon: entry.gamesWon,
      checkoutRate: entry.checkoutAttempts > 0 ? Number((entry.checkoutSuccess / entry.checkoutAttempts * 100).toFixed(1)) : 0,
      checkoutRateSingle: null,
      checkoutRateDouble: null,
      checkoutRateMaster: null,
      checkoutByRule: Object.fromEntries(['single', 'double', 'master'].map(rule => {
        const values = entry.checkoutByRule[rule];
        return [rule, {
          attempts: values.attempts,
          success: values.success,
          rate: values.attempts > 0 ? Number((values.success / values.attempts * 100).toFixed(1)) : 0,
          highest: Math.min(170, values.highest)
        }];
      })),
      gamesWon: entry.gamesWon,
      trackingSince: null
    }));
    const categoryGroups = new Map();
    for (const entry of groupedEntries) {
      const key = entry.category + ':' + entry.profileId;
      if (!categoryGroups.has(key)) {
        categoryGroups.set(key, {
          profileId: entry.profileId,
          player: entry.player,
          mode: 'gesamt',
          category: entry.category,
          count180: 0,
          count171Plus: 0,
          count140Plus: 0,
          count100Plus: 0,
          darts: 0,
          totalScored: 0,
          firstNineTotal: 0,
          firstNineCount: 0,
          checkoutAttempts: 0,
          checkoutSuccess: 0,
          highestCheckout: 0,
          checkoutByRule: {
            single: { attempts: 0, success: 0, highest: 0 },
            double: { attempts: 0, success: 0, highest: 0 },
            master: { attempts: 0, success: 0, highest: 0 }
          },
          gamesPlayed: 0,
          gamesWon: 0,
          legsPlayed: 0,
          legsWon: 0
        });
      }
      const total = categoryGroups.get(key);
      total.count180 += entry.count180;
      total.count171Plus += entry.count171Plus;
      total.count140Plus += entry.count140Plus;
      total.count100Plus += entry.count100Plus;
      total.darts += entry.darts;
      total.totalScored += entry.totalScored;
      total.firstNineTotal += entry.firstNineAverage * entry.firstNineCount;
      total.firstNineCount += entry.firstNineCount;
      total.checkoutAttempts += entry.checkoutAttempts;
      total.checkoutSuccess += entry.checkoutSuccess;
      total.highestCheckout = Math.max(total.highestCheckout, entry.highestCheckout);
      total.gamesPlayed += entry.gamesPlayed;
      total.gamesWon += entry.gamesWon;
      total.legsPlayed += entry.legsPlayed;
      total.legsWon += entry.legsWon;
      for (const rule of ['single', 'double', 'master']) {
        total.checkoutByRule[rule].attempts += entry.checkoutByRule[rule].attempts;
        total.checkoutByRule[rule].success += entry.checkoutByRule[rule].success;
        total.checkoutByRule[rule].highest = Math.max(total.checkoutByRule[rule].highest, entry.checkoutByRule[rule].highest);
      }
    }
    const categoryEntries = Array.from(categoryGroups.values()).map(entry => addDerivedMetrics({
      ...entry,
      firstNineSamples: entry.firstNineCount,
      matchesPlayed: entry.gamesPlayed,
      matchesWon: entry.gamesWon,
      checkoutByRule: Object.fromEntries(['single', 'double', 'master'].map(rule => {
        const values = entry.checkoutByRule[rule];
        return [rule, {
          ...values,
          rate: values.attempts > 0 ? Number((values.success / values.attempts * 100).toFixed(1)) : 0,
          highest: Math.min(170, values.highest)
        }];
      })),
      checkoutRate: entry.checkoutAttempts > 0 ? Number((entry.checkoutSuccess / entry.checkoutAttempts * 100).toFixed(1)) : 0,
      checkoutRateSingle: entry.checkoutByRule.single.attempts > 0 ? Number((entry.checkoutByRule.single.success / entry.checkoutByRule.single.attempts * 100).toFixed(1)) : null,
      checkoutRateDouble: entry.checkoutByRule.double.attempts > 0 ? Number((entry.checkoutByRule.double.success / entry.checkoutByRule.double.attempts * 100).toFixed(1)) : null,
      checkoutRateMaster: entry.checkoutByRule.master.attempts > 0 ? Number((entry.checkoutByRule.master.success / entry.checkoutByRule.master.attempts * 100).toFixed(1)) : null,
      gamesWon: entry.gamesWon,
      trackingSince: null
    }));
    for (const entry of entries) {
      const categoriesForPlayer = categoryEntries.filter(categoryEntry => categoryEntry.profileId === entry.profileId);
      entry.soloMatchesPlayed = categoriesForPlayer.reduce((sum, item) => sum + Number(item.soloMatchesPlayed || 0), 0);
      entry.duelsPlayed = categoriesForPlayer.reduce((sum, item) => sum + Number(item.duelsPlayed || 0), 0);
      entry.groupMatchesPlayed = categoriesForPlayer.reduce((sum, item) => sum + Number(item.groupMatchesPlayed || 0), 0);
      entry.tournamentMatchesPlayed = categoriesForPlayer.reduce((sum, item) => sum + Number(item.tournamentMatchesPlayed || 0), 0);
    }
    const overviewEntries = entries.concat(groupedEntries, categoryEntries);
    const ranked = (field, predicate = value => value > 0) => overviewEntries
      .filter(entry => predicate(entry[field], entry))
      .sort((a, b) => b[field] - a[field]);
    const modes = ['gesamt', ...new Set(groupedEntries.map(entry => entry.mode))];
    const categories = ['all', ...new Set(groupedEntries.map(entry => entry.category))];
    res.json({ trackingMode: 'gesamt', modes, categories, players: entries.map(entry => ({ profileId: entry.profileId, player: entry.player })), metrics: {
      count180: ranked('count180'),
      count171Plus: ranked('count171Plus'),
      count140Plus: ranked('count140Plus'),
      count100Plus: ranked('count100Plus'),
      checkoutRate: ranked('checkoutRate', (_value, entry) => entry.checkoutAttempts > 0),
      checkoutRateSingle: overviewEntries.filter(entry => entry.checkoutByRule && entry.checkoutByRule.single.attempts > 0).map(entry => ({ ...entry, checkoutRateSingle: entry.checkoutByRule.single.rate })).sort((a, b) => b.checkoutRateSingle - a.checkoutRateSingle),
      checkoutRateDouble: overviewEntries.filter(entry => entry.checkoutByRule && entry.checkoutByRule.double.attempts > 0).map(entry => ({ ...entry, checkoutRateDouble: entry.checkoutByRule.double.rate })).sort((a, b) => b.checkoutRateDouble - a.checkoutRateDouble),
      checkoutRateMaster: overviewEntries.filter(entry => entry.checkoutByRule && entry.checkoutByRule.master.attempts > 0).map(entry => ({ ...entry, checkoutRateMaster: entry.checkoutByRule.master.rate })).sort((a, b) => b.checkoutRateMaster - a.checkoutRateMaster),
      threeDartAverage: ranked('threeDartAverage'),
      firstNineAverage: ranked('firstNineAverage'),
      highestCheckout: ranked('highestCheckout'),
      legsPlayed: ranked('legsPlayed'),
      legWinRate: ranked('legWinRate', value => value !== null),
      matchesPlayed: ranked('matchesPlayed'),
      matchWinRate: ranked('matchWinRate', value => value !== null),
      soloMatchesPlayed: ranked('soloMatchesPlayed'),
      duelsPlayed: ranked('duelsPlayed'),
      groupMatchesPlayed: ranked('groupMatchesPlayed'),
      tournamentMatchesPlayed: ranked('tournamentMatchesPlayed'),
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
    const season = String(req.query.season || '2026').trim();
    if (!/^\d{4}$/.test(season)) return res.status(400).json({ error: 'Invalid season' });
    if (!Number.isInteger(playerId) || playerId < 0) {
      return res.status(400).json({ error: 'Invalid player ID' });
    }
    let stats = await dataStore.getPlayerStats(playerId, season);
    if (!stats) {
      await dataStore.initPlayerStats(playerId, season);
      stats = await dataStore.getPlayerStats(playerId, season);
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
    const duelLegId = Number(req.query.duelLegId || 0) || null;
    const season = String(req.query.season || DEFAULT_STATS_SEASON).trim();
    if (!/^\d{4}$/.test(season)) return res.status(400).json({ error: 'Invalid season' });
    res.json(await dataStore.getSegmentAnalysis(playerId, mode, duelId, season, duelLegId));
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
    const duelLegId = Number(req.query.duelLegId || 0) || null;
    const season = String(req.query.season || DEFAULT_STATS_SEASON).trim();
    if (!/^\d{4}$/.test(season)) return res.status(400).json({ error: 'Invalid season' });
    const players = await Promise.all((duel.players || []).map(async player => ({
      slot: Number(player.player_slot),
      name: player.player_name || 'Spieler',
      analysis: await dataStore.getSegmentAnalysis(Number(player.player_slot), mode, duelId, season, duelLegId)
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

function validatePlayerStatUpdates(updates, current = {}) {
  const pairs = [
    ['games_won', 'games_played', 'Gewonnene Matches dürfen gespielte Matches nicht überschreiten.'],
    ['legs_won', 'legs_played', 'Gewonnene Legs dürfen gespielte Legs nicht überschreiten.'],
    ['checkout_success', 'checkout_attempts', 'Checkout-Erfolge dürfen Checkout-Versuche nicht überschreiten.'],
    ['checkout_single_success', 'checkout_single_attempts', 'Single-Out-Erfolge dürfen Versuche nicht überschreiten.'],
    ['checkout_double_success', 'checkout_double_attempts', 'Double-Out-Erfolge dürfen Versuche nicht überschreiten.'],
    ['checkout_master_success', 'checkout_master_attempts', 'Master-Out-Erfolge dürfen Versuche nicht überschreiten.']
  ];
  for (const [successField, attemptsField, message] of pairs) {
    const success = Number(updates[successField] ?? current[successField]);
    const attempts = Number(updates[attemptsField] ?? current[attemptsField]);
    if (Number.isFinite(success) && Number.isFinite(attempts) && success > attempts) return message;
  }
  return null;
}

app.put('/api/players/:id/stats', requireAdmin, async (req, res) => {
  const playerId = Number(req.params.id);
  const season = String(req.query.season || req.body?.season || DEFAULT_STATS_SEASON).trim();
  if (!Number.isInteger(playerId) || playerId < 1) return res.status(400).json({ error: 'Invalid player ID' });
  if (!/^\d{4}$/.test(season)) return res.status(400).json({ error: 'Invalid season' });
  try {
    await dataStore.initPlayerStats(playerId, season);
    const updates = {};
    for (const field of EDITABLE_PLAYER_STAT_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, field)) {
        const value = Number(req.body[field]);
        if (!Number.isFinite(value) || value < 0) return res.status(400).json({ error: `Ungültiger Wert für ${field}` });
        updates[field] = value;
      }
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Keine Statistikfelder angegeben' });
    const current = await dataStore.getPlayerStats(playerId, season);
    const validationError = validatePlayerStatUpdates(updates, current || {});
    if (validationError) return res.status(400).json({ error: validationError });
    await dataStore.updatePlayerStats(playerId, updates, season);
    res.json(await dataStore.getPlayerStats(playerId, season));
  } catch (err) {
    res.status(500).json({ error: 'Statistik konnte nicht gespeichert werden: ' + err.message });
  }
});

app.post('/api/players/:id/stats/reset', requireAdmin, async (req, res) => {
  const playerId = Number(req.params.id);
  const season = String(req.query.season || req.body?.season || DEFAULT_STATS_SEASON).trim();
  if (!Number.isInteger(playerId) || playerId < 1) return res.status(400).json({ error: 'Invalid player ID' });
  if (!/^\d{4}$/.test(season)) return res.status(400).json({ error: 'Invalid season' });
  try {
    await dataStore.initPlayerStats(playerId, season);
    await dataStore.resetPlayerStats(playerId, EDITABLE_PLAYER_STAT_FIELDS, season);
    res.json(await dataStore.getPlayerStats(playerId, season));
  } catch (err) {
    res.status(500).json({ error: 'Statistik konnte nicht zurückgesetzt werden: ' + err.message });
  }
});

app.post('/api/players/:id/stats/recalculate-games', requireAdmin, async (req, res) => {
  const playerId = Number(req.params.id);
  const season = String(req.query.season || req.body?.season || DEFAULT_STATS_SEASON).trim();
  if (!Number.isInteger(playerId) || playerId < 1) return res.status(400).json({ error: 'Invalid player ID' });
  if (!/^\d{4}$/.test(season)) return res.status(400).json({ error: 'Invalid season' });
  try {
    const gamesPlayed = await dataStore.countPlayerFinishedDuels(playerId);
    const gamesWon = await dataStore.countPlayerWonDuels(playerId);
    await dataStore.initPlayerStats(playerId, season);
    await dataStore.updatePlayerStats(playerId, { games_played: gamesPlayed, games_won: gamesWon }, season);
    res.json(await dataStore.getPlayerStats(playerId, season));
  } catch (err) {
    res.status(500).json({ error: 'Neuberechnung fehlgeschlagen: ' + err.message });
  }
});

app.get('/api/players/:id/history', async (req, res) => {
  try {
    const playerId = Number(req.params.id);
    const limit = Number(req.query.limit || 50);
    const season = String(req.query.season || '2026').trim();
    if (!/^\d{4}$/.test(season)) return res.status(400).json({ error: 'Invalid season' });
    if (!Number.isInteger(playerId) || playerId < 0) {
      return res.status(400).json({ error: 'Invalid player ID' });
    }
    const history = await dataStore.getLegHistory(playerId, Math.min(limit, 100), season);
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

  app.listen(BROWSER_PORT, '0.0.0.0', () => {
    console.log('Dashboard (Browser): http://localhost:' + BROWSER_PORT + ' | http://' + getLocalIP() + ':' + BROWSER_PORT);
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

  fireTvApp.use('/icons', express.static(path.join(__dirname, 'public', 'icons')));
  fireTvApp.use('/sounds', express.static(path.join(__dirname, 'public', 'sounds')));

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
  fireTvApp.listen(FIRETV_PORT, '0.0.0.0', () => {
    console.log('Dashboard (Fire TV): http://localhost:' + FIRETV_PORT + '/panels/firetv-dashboard.html | http://' + getLocalIP() + ':' + FIRETV_PORT + '/panels/firetv-dashboard.html');
  });
}

if (require.main === module) {
  startServer().catch((err) => {
    console.error('[Start] Fehlgeschlagen:', err.message);
    process.exit(1);
  });
}

module.exports = {
  app,
  startServer,
  createFireTvServer,
  startFireTvServer,
  getLocalIP,
  CHECKOUT_RULES,
  DEFAULT_CHECKOUT_RULE,
  getCheckoutRuleStats,
  getCheckoutValue,
  isCheckoutAttempt,
  isRestFinishable,
  isValidCheckout,
  isValidEventEffectSound,
  scanSoundDirectory,
  normalizeLiveStateSnapshot,
  getLiveDisplayState,
  validatePlayerStatUpdates
};
