const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const { exec, spawn } = require('child_process');
const { DataStore } = require('./db');

let SerialPortCtor = null;
let ReadlineParserCtor = null;
try {
  ({ SerialPort: SerialPortCtor } = require('serialport'));
  ({ ReadlineParser: ReadlineParserCtor } = require('@serialport/parser-readline'));
} catch (_err) {
  // Optional dependency: dashboard still works without serial monitor feature.
}

// SSE-Clients – alle offenen Dashboards sofort benachrichtigen
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
const PUBLIC_PORT = process.env.PUBLIC_PORT || PORT;
const FIRE_FEATURES_ENABLED = String(process.env.FIRE_FEATURES_ENABLED || 'false').toLowerCase() === 'true';
const DART_HUB_ENABLED = String(process.env.DART_HUB_ENABLED || 'false').toLowerCase() === 'true';

const DATA_DIR       = path.join(__dirname, 'data');
const CUSTOM_FILE    = path.join(DATA_DIR, 'custom-dashboards.json');
const OVERRIDES_FILE = path.join(DATA_DIR, 'fixed-overrides.json');
const SETTINGS_FILE  = path.join(DATA_DIR, 'settings.json');
const PLAYERS_FILE   = path.join(DATA_DIR, 'players.json');
const BRAVE_URLS_FILE  = path.join(DATA_DIR, 'brave-urls.json');
const BRAVE_MEDIA_FILE = path.join(DATA_DIR, 'brave-media.json');
const LIVE_STATE_FILE = path.join(DATA_DIR, 'live-state.json');
const HIGHSCORES_FILE = path.join(DATA_DIR, 'highscores.json');

const dataStore = new DataStore();

const DEFAULT_MEDIA = [
  { id: 'm-yt',   title: 'YouTube',     icon: '▶️',  url: 'https://www.youtube.com',   color: '#FF0000' },
  { id: 'm-nf',   title: 'Netflix',     icon: '🎬', url: 'https://www.netflix.com',    color: '#E50914' },
  { id: 'm-tw',   title: 'Twitch',      icon: '🎮', url: 'https://www.twitch.tv',      color: '#00A8E1' },
  { id: 'm-pv',   title: 'Prime Video', icon: '📺', url: 'https://www.primevideo.com', color: '#FF9900' },
  { id: 'm-sp',   title: 'Spotify',     icon: '🎵', url: 'https://open.spotify.com',   color: '#1DB954' },
  { id: 'm-dazn', title: 'DAZN',        icon: '⚽', url: 'https://www.dazn.com',       color: '#FFFC00' },
];

const ADB_DEFAULT = process.env.ADB_PATH || (
  process.platform === 'win32'
    ? 'C:\\Program Files (x86)\\Touch Portal\\plugins\\adb\\platform-tools\\adb.exe'
    : 'adb'
);
const BRAVE_PKG   = 'com.brave.browser';

function resolveAdbPath(rawValue) {
  const candidate = String(rawValue || '').trim();
  const looksLikeWindowsPath = /^[a-zA-Z]:\\/.test(candidate);
  if (!candidate) {
    return ADB_DEFAULT;
  }
  if (process.platform !== 'win32' && looksLikeWindowsPath) {
    return 'adb';
  }
  return candidate;
}

app.get('/', (_req, res, next) => {
  if (DART_HUB_ENABLED) {
    return next();
  }
  res.type('html').send(`<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Loewen Dart - Service</title>
  <style>
    body { margin: 0; font-family: Segoe UI, Arial, sans-serif; background: #0e0e0e; color: #f2f2f2; }
    main { max-width: 900px; margin: 0 auto; padding: 28px; }
    h1 { margin: 0 0 10px; }
    .muted { color: #9b9b9b; margin-bottom: 16px; }
    .row { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
    a { display: block; background: #191919; color: #f2f2f2; text-decoration: none; border: 1px solid #2e2e2e; border-radius: 10px; padding: 12px; }
    a:hover { border-color: #e63946; }
    code { color: #f4a261; }
  </style>
</head>
<body>
  <main>
    <h1>Dart-Dashboard Service</h1>
    <p class="muted">Dieser Service ist getrennt vom Kiosk-Hub. Einstellungen und Kachel-Verwaltung laufen im Hub.</p>
    <div class="row">
      <a href="/panels/live-spielstand.html">Live-Spielstand Panel</a>
      <a href="/panels/spieler.html">Spieler Panel</a>
      <a href="/api/live/state">API: Live-State</a>
      <a href="/api/highscores">API: Highscores</a>
    </div>
    <p class="muted" style="margin-top:16px">Optionaler Legacy-Hub-Modus: <code>DART_HUB_ENABLED=true</code></p>
  </main>
</body>
</html>`);
});

app.get('/admin.html', (req, res, next) => {
  if (DART_HUB_ENABLED) {
    return next();
  }
  res.status(410).json({
    error: 'Admin im dart-dashboard ist deaktiviert. Bitte Hub-Admin im kiosk-dashboard nutzen.'
  });
});

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));
app.use(express.json());

function requireDartHubManagement(_req, res, next) {
  if (DART_HUB_ENABLED) {
    return next();
  }
  return res.status(410).json({
    error: 'Dashboard- und Settings-Verwaltung wurde ins kiosk-dashboard verlagert.'
  });
}

const fixedDefaults = [
  { id: 'privat-dart',       title: 'Privat Dart',        icon: '🎯', description: 'Simulation/Preview fuer Vereins-Ansicht', color: '#e63946', route: '/panels/privat-dart.html',        external: false, badge: 'Preview'   },
  { id: 'live-spielstand',   title: 'Live-Spielstand',    icon: '⚡', description: 'Simulation/Preview fuer Live-Anzeige',    color: '#f4a261', route: '/panels/live-spielstand.html',    external: false, badge: 'Preview'   },
  { id: 'rangliste',         title: 'Rangliste',          icon: '🏆', description: 'Simulation/Preview fuer Rangliste',       color: '#2a9d8f', route: '/panels/rangliste.html',          external: false, badge: 'Preview'   },
  { id: 'spielerstatistiken',title: 'Spielerstatistiken', icon: '📈', description: 'Simulation/Preview fuer Statistiken',     color: '#457b9d', route: '/panels/spielerstatistiken.html', external: false, badge: 'Preview'   },
  { id: 'spielplan',         title: 'Spielplan',          icon: '🗓️', description: 'Simulation/Preview fuer Spielplan',       color: '#264653', route: '/panels/spielplan.html',          external: false, badge: 'Preview'   },
  { id: 'spieler',           title: 'Spieler',            icon: '👤', description: 'Simulation/Preview fuer Spielerverwaltung', color: '#9b5de5', route: '/panels/spieler.html',            external: false, badge: 'Preview'   }
];

const allowedPanelRoutes = new Set(fixedDefaults.map((tile) => tile.route));

function isInternalPanelRoute(route) {
  return typeof route === 'string' && allowedPanelRoutes.has(route);
}

function sanitizeFixedTile(tile, fallback) {
  const safeTile = { ...tile, external: false };
  if (!isInternalPanelRoute(safeTile.route)) {
    safeTile.route = fallback.route;
  }
  return safeTile;
}

function readJson(file, fallback) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  return fallback;
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function getFixed() {
  const ov = readJson(OVERRIDES_FILE, {});
  return fixedDefaults.map((d) => sanitizeFixedTile({ ...d, ...(ov[d.id] || {}) }, d));
}
function getCustom() {
  const list = readJson(CUSTOM_FILE, []);
  return list
    .filter((entry) => isInternalPanelRoute(entry.route))
    .map((entry) => ({ ...entry, external: false }));
}
function saveCustom(l) { writeJson(CUSTOM_FILE, l); }
function getSettings() {
  const merged = {
    hubTitle: 'Löwen Dart – Kiosk Hub',
    autoReloadMinutes: 5,
    screensaverEnabled: true,
    screensaverMinutes: 2,
    arduinoMonitorEnabled: true,
    arduinoPort: '',
    arduinoBaudRate: 115200,
    fireFeaturesEnabled: FIRE_FEATURES_ENABLED,
    adbPath: process.env.ADB_PATH || ADB_DEFAULT,
    firestickIp: process.env.FIRESTICK_IP || '192.168.8.177',
    ...readJson(SETTINGS_FILE, {})
  };
  merged.adbPath = resolveAdbPath(merged.adbPath);
  return merged;
}
function saveSettings(s){ writeJson(SETTINGS_FILE, s); }

const arduinoSseClients = new Set();
let arduinoPort = null;
let arduinoParser = null;
let arduinoReconnectTimer = null;
const arduinoState = {
  enabled: true,
  connected: false,
  port: null,
  baudRate: 115200,
  lastLine: '',
  lastEvent: null,
  lastHeartbeat: null,
  activeCount: null,
  lastUpdateMs: null,
  error: null
};

function broadcastArduinoState() {
  const payload = JSON.stringify(arduinoState);
  arduinoSseClients.forEach((res) => {
    try {
      res.write(`event: state\ndata: ${payload}\n\n`);
    } catch (_err) {
      arduinoSseClients.delete(res);
    }
  });
}

function normalizeArduinoStatePatch(patch) {
  Object.assign(arduinoState, patch, { lastUpdateMs: Date.now() });
  broadcastArduinoState();
}

function parseArduinoLine(line) {
  const clean = String(line || '').trim();
  if (!clean) {
    return;
  }

  normalizeArduinoStatePatch({ lastLine: clean, error: null });

  const hbMatch = clean.match(/^HB,(\d+),active=(\d+)$/i);
  if (hbMatch) {
    normalizeArduinoStatePatch({
      activeCount: Number(hbMatch[2]),
      lastHeartbeat: {
        ms: Number(hbMatch[1]),
        activeCount: Number(hbMatch[2]),
        line: clean
      }
    });
    return;
  }

  const evtMatch = clean.match(/^EVT,(\d+),CH(\d{2}),([A-Z]+)$/i);
  if (evtMatch) {
    normalizeArduinoStatePatch({
      lastEvent: {
        ms: Number(evtMatch[1]),
        channel: evtMatch[2],
        state: evtMatch[3].toUpperCase(),
        line: clean
      }
    });
    return;
  }

  const legacyEvent = clean.match(/^CH(\d{2}):\s*(ACTIVE|IDLE|idle)$/);
  if (legacyEvent) {
    normalizeArduinoStatePatch({
      lastEvent: {
        ms: null,
        channel: legacyEvent[1],
        state: legacyEvent[2].toUpperCase(),
        line: clean
      }
    });
    return;
  }

  const legacyStatus = clean.match(/^STATUS\s+active=(\d+)$/i);
  if (legacyStatus) {
    normalizeArduinoStatePatch({ activeCount: Number(legacyStatus[1]) });
  }
}

function clearArduinoReconnectTimer() {
  if (arduinoReconnectTimer) {
    clearTimeout(arduinoReconnectTimer);
    arduinoReconnectTimer = null;
  }
}

function scheduleArduinoReconnect(delayMs = 4000) {
  if (arduinoReconnectTimer) {
    return;
  }
  arduinoReconnectTimer = setTimeout(() => {
    arduinoReconnectTimer = null;
    startArduinoMonitor();
  }, delayMs);
}

async function detectArduinoPort(preferredPort) {
  if (preferredPort) {
    return preferredPort;
  }
  if (!SerialPortCtor) {
    return null;
  }
  const ports = await SerialPortCtor.list();
  const firstKnown = ports.find((p) => {
    const pathValue = (p.path || '').toLowerCase();
    return pathValue.startsWith('/dev/ttyacm') || pathValue.startsWith('/dev/ttyusb') || pathValue.startsWith('com');
  });
  return firstKnown ? firstKnown.path : null;
}

function closeArduinoMonitor() {
  clearArduinoReconnectTimer();
  if (arduinoParser) {
    arduinoParser.removeAllListeners();
    arduinoParser = null;
  }
  if (arduinoPort) {
    arduinoPort.removeAllListeners();
    try {
      if (arduinoPort.isOpen) {
        arduinoPort.close();
      }
    } catch (_err) {
      // Ignore close errors here.
    }
    arduinoPort = null;
  }
  normalizeArduinoStatePatch({ connected: false });
}

async function startArduinoMonitor() {
  const settings = getSettings();
  const baudRate = Number(settings.arduinoBaudRate || 115200) || 115200;

  if (!settings.arduinoMonitorEnabled) {
    closeArduinoMonitor();
    normalizeArduinoStatePatch({
      enabled: false,
      baudRate,
      error: 'Arduino-Monitor ist in den Einstellungen deaktiviert.'
    });
    return;
  }

  normalizeArduinoStatePatch({ enabled: true, baudRate });

  if (!SerialPortCtor || !ReadlineParserCtor) {
    normalizeArduinoStatePatch({
      connected: false,
      error: 'serialport Modul fehlt. Bitte npm install ausfuehren.'
    });
    return;
  }

  if (arduinoPort && arduinoPort.isOpen) {
    return;
  }

  let serialPath = null;
  try {
    serialPath = await detectArduinoPort(settings.arduinoPort || '');
  } catch (err) {
    normalizeArduinoStatePatch({
      connected: false,
      error: `Portsuche fehlgeschlagen: ${err.message}`
    });
    scheduleArduinoReconnect();
    return;
  }

  if (!serialPath) {
    normalizeArduinoStatePatch({
      connected: false,
      port: null,
      error: 'Kein Arduino-Serial-Port gefunden.'
    });
    scheduleArduinoReconnect();
    return;
  }

  try {
    const port = new SerialPortCtor({ path: serialPath, baudRate, autoOpen: true });
    const parser = port.pipe(new ReadlineParserCtor({ delimiter: '\n' }));

    arduinoPort = port;
    arduinoParser = parser;

    port.on('open', () => {
      normalizeArduinoStatePatch({
        connected: true,
        port: serialPath,
        error: null
      });
    });

    parser.on('data', (line) => {
      parseArduinoLine(line);
    });

    port.on('error', (err) => {
      normalizeArduinoStatePatch({ connected: false, error: `Serial-Fehler: ${err.message}` });
      scheduleArduinoReconnect();
    });

    port.on('close', () => {
      if (arduinoPort === port) {
        arduinoPort = null;
      }
      normalizeArduinoStatePatch({ connected: false, error: 'Arduino-Serial-Port getrennt.' });
      scheduleArduinoReconnect();
    });
  } catch (err) {
    normalizeArduinoStatePatch({ connected: false, error: `Arduino-Verbindung fehlgeschlagen: ${err.message}` });
    scheduleArduinoReconnect();
  }
}

function restartArduinoMonitor() {
  closeArduinoMonitor();
  startArduinoMonitor();
}

async function getPlayers() {
  return dataStore.getPlayers();
}

async function savePlayers(list) {
  await dataStore.savePlayers(list);
}

async function getActivePlayersForLive() {
  const players = (await getPlayers()).filter((p) => p.active && String(p.name || '').trim());
  return players.slice(0, 2).map((p, index) => ({
    slot: p.slot,
    name: String(p.name).trim(),
    color: p.color || (index === 0 ? '#e63946' : '#f4a261')
  }));
}

async function defaultLiveState() {
  const active = await getActivePlayersForLive();
  const p1 = active[0] || { slot: 1, name: 'Spieler 1', color: '#e63946' };
  const p2 = active[1] || { slot: 2, name: 'Spieler 2', color: '#f4a261' };

  return {
    game: {
      mode: '501',
      status: 'running',
      startedAt: Date.now(),
      updatedAt: Date.now()
    },
    players: [
      { ...p1, remaining: 501, legs: 0, turns: 0, totalScored: 0, bestTurn: 0 },
      { ...p2, remaining: 501, legs: 0, turns: 0, totalScored: 0, bestTurn: 0 }
    ],
    lastAction: null,
    arduino: {
      connected: false,
      lastEvent: null,
      activeCount: 0,
      heartbeatMs: null
    }
  };
}

function sanitizePlayerState(player, fallback) {
  const base = fallback || {};
  const name = String(player && player.name ? player.name : base.name || '').trim() || 'Spieler';
  const slot = Number.isFinite(Number(player && player.slot)) ? Number(player.slot) : Number(base.slot || 0);
  const legs = Math.max(0, Number(player && player.legs || base.legs || 0));
  const turns = Math.max(0, Number(player && player.turns || base.turns || 0));
  const totalScored = Math.max(0, Number(player && player.totalScored || base.totalScored || 0));
  const bestTurn = Math.max(0, Number(player && player.bestTurn || base.bestTurn || 0));
  const remaining = Math.max(0, Number(player && player.remaining || base.remaining || 501));
  const color = String(player && player.color ? player.color : base.color || '#e63946');
  return { slot, name, color, remaining, legs, turns, totalScored, bestTurn };
}

async function getLiveState() {
  const fallback = await defaultLiveState();
  const saved = await dataStore.getLiveState(fallback);

  const state = {
    game: {
      mode: String(saved.game && saved.game.mode || fallback.game.mode),
      status: String(saved.game && saved.game.status || fallback.game.status),
      startedAt: Number(saved.game && saved.game.startedAt || fallback.game.startedAt),
      updatedAt: Number(saved.game && saved.game.updatedAt || Date.now())
    },
    players: [
      sanitizePlayerState(saved.players && saved.players[0], fallback.players[0]),
      sanitizePlayerState(saved.players && saved.players[1], fallback.players[1])
    ],
    lastAction: saved.lastAction || null,
    arduino: {
      connected: !!arduinoState.connected,
      lastEvent: arduinoState.lastEvent || null,
      activeCount: Number(arduinoState.activeCount || 0),
      heartbeatMs: arduinoState.lastHeartbeat ? Number(arduinoState.lastHeartbeat.ms || 0) : null
    }
  };

  return state;
}

async function saveLiveState(state) {
  const safe = {
    ...state,
    game: {
      ...(state.game || {}),
      updatedAt: Date.now()
    }
  };
  await dataStore.saveLiveState(safe);
  return safe;
}

async function getHighscores() {
  return dataStore.getHighscores(100);
}

async function addHighscore(playerName, score, meta = {}) {
  const safeName = String(playerName || '').trim();
  const safeScore = Number(score || 0);
  if (!safeName || !Number.isFinite(safeScore) || safeScore <= 0) {
    return;
  }
  await dataStore.addHighscore({
    player: safeName,
    score: safeScore,
    ts: Date.now(),
    legWin: !!meta.legWin,
    ...meta
  });
}

// ── Fixed tiles ──
app.use('/api/dashboards', requireDartHubManagement);
app.use('/api/settings', requireDartHubManagement);
app.use('/api/server-info', requireDartHubManagement);

app.get('/api/dashboards/fixed', (req, res) => res.json(getFixed()));
app.put('/api/dashboards/fixed/:id', (req, res) => {
  const def = fixedDefaults.find(d => d.id === req.params.id);
  if (!def) return res.status(404).json({ error: 'Nicht gefunden' });
  if (req.body.route !== undefined && !isInternalPanelRoute(req.body.route)) {
    return res.status(400).json({ error: 'Nur interne /panels/... Routen sind im dart-dashboard erlaubt.' });
  }
  const ov = readJson(OVERRIDES_FILE, {});
  ov[req.params.id] = { ...(ov[req.params.id] || {}), ...req.body, external: false };
  writeJson(OVERRIDES_FILE, ov);
  broadcastReload();
  res.json(sanitizeFixedTile({ ...def, ...ov[req.params.id] }, def));
});

// ── Custom tiles ──
app.get('/api/dashboards/custom', (req, res) => res.json(getCustom()));
app.post('/api/dashboards/custom', (req, res) => {
  const { title, icon, description, color, route, external, badge } = req.body;
  if (!title || !route) return res.status(400).json({ error: 'title und route erforderlich' });
  if (!isInternalPanelRoute(route)) {
    return res.status(400).json({ error: 'Nur interne /panels/... Routen sind im dart-dashboard erlaubt. Externe Dashboards bitte im kiosk-dashboard verwalten.' });
  }
  const list = getCustom();
  const entry = { id: 'custom-' + Date.now(), title, icon: icon || '🔗', description: description || '', color: color || '#6c757d', route, external: false, badge: badge || 'Custom' };
  list.push(entry);
  saveCustom(list);
  broadcastReload();
  res.status(201).json(entry);
});
app.put('/api/dashboards/custom/:id', (req, res) => {
  const list = getCustom();
  const i = list.findIndex(d => d.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'Nicht gefunden' });
  if (req.body.route !== undefined && !isInternalPanelRoute(req.body.route)) {
    return res.status(400).json({ error: 'Nur interne /panels/... Routen sind im dart-dashboard erlaubt.' });
  }
  list[i] = { ...list[i], ...req.body, external: false, id: list[i].id };
  saveCustom(list);
  broadcastReload();
  res.json(list[i]);
});
app.delete('/api/dashboards/custom/:id', (req, res) => {
  let list = getCustom();
  const before = list.length;
  list = list.filter(d => d.id !== req.params.id);
  if (list.length === before) return res.status(404).json({ error: 'Nicht gefunden' });
  saveCustom(list);
  broadcastReload();
  res.json({ ok: true });
});

// ── Players ──
app.get('/api/players', async (_req, res) => {
  try {
    res.json(await getPlayers());
  } catch (err) {
    res.status(500).json({ error: `Spieler konnten nicht geladen werden: ${err.message}` });
  }
});

app.put('/api/players', async (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Array erwartet' });
  try {
    await savePlayers(req.body);
    broadcastReload();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: `Spieler konnten nicht gespeichert werden: ${err.message}` });
  }
});

app.get('/api/storage/info', (_req, res) => {
  res.json(dataStore.getInfo());
});

// ── Server-Info ──
app.get('/api/server-info', (req, res) => {
  const s = getSettings();
  const detectedIp = getLocalIP();
  const ip = s.serverIp || detectedIp;
  res.json({ ip, detectedIp, port: PORT, kioskUrl: `http://${ip}:${PORT}` });
});

// ── Settings ──
app.get('/api/settings', (req, res) => res.json(getSettings()));
app.put('/api/settings', (req, res) => {
  const s = { ...getSettings(), ...req.body };
  saveSettings(s);
  restartArduinoMonitor();
  broadcastReload();
  res.json(s);
});

// SSE – Live-Push an alle offenen Dashboard-Browser
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write('data: connected\n\n');
  sseClients.add(res);
  // Keepalive alle 25s (verhindert Timeout bei Proxys/Firewalls)
  const ka = setInterval(() => { try { res.write(':ka\n\n'); } catch { clearInterval(ka); sseClients.delete(res); } }, 25000);
  req.on('close', () => { clearInterval(ka); sseClients.delete(res); });
});

app.get('/api/arduino/state', (_req, res) => {
  res.json(arduinoState);
});

app.get('/api/arduino/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  res.write(`event: state\ndata: ${JSON.stringify(arduinoState)}\n\n`);
  arduinoSseClients.add(res);

  const keepAlive = setInterval(() => {
    try {
      res.write(':ka\n\n');
    } catch (_err) {
      clearInterval(keepAlive);
      arduinoSseClients.delete(res);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    arduinoSseClients.delete(res);
  });
});

app.post('/api/arduino/command', (req, res) => {
  const command = String((req.body && req.body.command) || '').trim();
  if (!command) {
    return res.status(400).json({ ok: false, error: 'command fehlt.' });
  }
  if (!arduinoPort || !arduinoPort.isOpen) {
    return res.status(409).json({ ok: false, error: 'Arduino ist aktuell nicht verbunden.' });
  }

  arduinoPort.write(`${command}\n`, (err) => {
    if (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
    res.json({ ok: true });
  });
});

app.get('/api/live/state', async (_req, res) => {
  try {
    res.json(await getLiveState());
  } catch (err) {
    res.status(500).json({ error: `Live-State konnte nicht geladen werden: ${err.message}` });
  }
});

app.post('/api/live/reset', async (req, res) => {
  const carryLegs = !!(req.body && req.body.carryLegs);
  try {
    const prev = await getLiveState();
    const fresh = await defaultLiveState();
    if (carryLegs) {
      fresh.players[0].legs = prev.players[0].legs;
      fresh.players[1].legs = prev.players[1].legs;
    }
    const saved = await saveLiveState(fresh);
    res.json(saved);
  } catch (err) {
    res.status(500).json({ error: `Live-Reset fehlgeschlagen: ${err.message}` });
  }
});

app.post('/api/live/throw', async (req, res) => {
  const playerIndex = Number(req.body && req.body.playerIndex);
  const points = Number(req.body && req.body.points);
  if (![0, 1].includes(playerIndex)) {
    return res.status(400).json({ error: 'playerIndex muss 0 oder 1 sein.' });
  }
  if (!Number.isFinite(points) || points < 0 || points > 180) {
    return res.status(400).json({ error: 'points muss zwischen 0 und 180 liegen.' });
  }

  try {
    const state = await getLiveState();
    const player = state.players[playerIndex];
    const nextRemaining = player.remaining - points;
    const bust = nextRemaining < 0;

    player.turns += 1;
    player.bestTurn = Math.max(player.bestTurn, points);
    if (!bust) {
      player.remaining = nextRemaining;
      player.totalScored += points;
    }

    state.lastAction = {
      type: 'throw',
      playerIndex,
      player: player.name,
      points,
      bust,
      remaining: player.remaining,
      ts: Date.now()
    };

    if (player.remaining === 0) {
      player.legs += 1;
      await addHighscore(player.name, points, { kind: 'checkout', legWin: true });
      state.game.status = 'leg-finished';
    }

    const saved = await saveLiveState(state);
    res.json(saved);
  } catch (err) {
    res.status(500).json({ error: `Wurf konnte nicht gespeichert werden: ${err.message}` });
  }
});

app.get('/api/highscores', async (_req, res) => {
  try {
    res.json(await getHighscores());
  } catch (err) {
    res.status(500).json({ error: `Highscores konnten nicht geladen werden: ${err.message}` });
  }
});

app.post('/api/highscores', async (req, res) => {
  const player = String(req.body && req.body.player || '').trim();
  const score = Number(req.body && req.body.score);
  if (!player || !Number.isFinite(score) || score <= 0) {
    return res.status(400).json({ error: 'player und positive score sind erforderlich.' });
  }
  try {
    await addHighscore(player, score, { kind: 'manual' });
    res.json({ ok: true, highscores: await getHighscores() });
  } catch (err) {
    res.status(500).json({ error: `Highscore konnte nicht gespeichert werden: ${err.message}` });
  }
});

// ── ADB / Brave ──
function getBraveUrls()   { return readJson(BRAVE_URLS_FILE, []); }
function saveBraveUrls(l) { writeJson(BRAVE_URLS_FILE, l); }
function getMediaTiles()  { return fs.existsSync(BRAVE_MEDIA_FILE) ? readJson(BRAVE_MEDIA_FILE, DEFAULT_MEDIA) : DEFAULT_MEDIA; }
function saveMediaTiles(l){ writeJson(BRAVE_MEDIA_FILE, l); }

function requireFireFeatures(req, res, next) {
  if (!FIRE_FEATURES_ENABLED) {
    return res.status(410).json({ ok: false, error: 'Fire-TV Features sind in diesem Deployment deaktiviert.' });
  }
  next();
}

app.use('/api/adb', requireFireFeatures);
app.use('/api/firetv-screenshot', requireFireFeatures);
app.use('/api/firetv-screen.png', requireFireFeatures);
app.use('/api/fully-stop', requireFireFeatures);
app.use('/api/fully-start', requireFireFeatures);
app.use('/api/kiosk-reload', requireFireFeatures);
app.use('/api/set-default-browser', requireFireFeatures);

app.post('/api/adb/launch', (req, res) => {
  const { url } = req.body;
  if (!url || !/^https?:\/\//i.test(url))
    return res.status(400).json({ error: 'Ungültige URL' });
  const s = getSettings();
  const adbPath = `"${(s.adbPath || ADB_DEFAULT).replace(/"/g, '')}"`;
  const device  = `${s.firestickIp || '192.168.8.177'}:5555`;
  const cmd = `${adbPath} -s ${device} shell am start -a android.intent.action.VIEW -d "${url}" ${BRAVE_PKG}`;
  exec(cmd, { timeout: 8000 }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: (stderr || err.message).trim() });
    res.json({ ok: true, output: stdout.trim() });
  });
});

app.post('/api/adb/install', (req, res) => {
  const { apkPath } = req.body;
  if (!apkPath) return res.status(400).json({ error: 'URL oder Pfad fehlt' });
  const s = getSettings();
  const adbBin = `"${(s.adbPath || ADB_DEFAULT).replace(/"/g, '')}"` ;
  const device = `${s.firestickIp || '192.168.8.177'}:5555`;

  const doInstall = (localPath, cleanup) => {
    exec(`${adbBin} -s ${device} install -r "${localPath}"`, { timeout: 120000 }, (err, stdout, stderr) => {
      if (cleanup) fs.unlink(localPath, () => {});
      if (err) return res.status(500).json({ error: (stderr || err.message).trim() });
      res.json({ ok: true, output: stdout.trim() });
    });
  };

  if (/^https?:\/\//i.test(apkPath)) {
    // URL → APK in temporäre Datei herunterladen, dann installieren
    const tmpFile = path.join(os.tmpdir(), 'apk-install-' + Date.now() + '.apk');
    const proto = apkPath.startsWith('https') ? https : http;
    proto.get(apkPath, (response) => {
      if (response.statusCode !== 200) {
        return res.status(500).json({ error: 'Download fehlgeschlagen: HTTP ' + response.statusCode });
      }
      const file = fs.createWriteStream(tmpFile);
      response.pipe(file);
      file.on('finish', () => file.close(() => doInstall(tmpFile, true)));
      file.on('error', (e) => { fs.unlink(tmpFile, () => {}); res.status(500).json({ error: e.message }); });
    }).on('error', (e) => res.status(500).json({ error: 'Download-Fehler: ' + e.message }));
  } else {
    // Lokaler Pfad im Container (nur für Entwicklung)
    if (!apkPath.endsWith('.apk')) return res.status(400).json({ error: 'Kein gültiger APK-Pfad' });
    doInstall(apkPath, false);
  }
});

app.get('/api/brave-urls', (_req, res) => res.json(getBraveUrls()));
app.post('/api/brave-urls', (req, res) => {
  const { title, url, icon } = req.body;
  if (!title || !url || !/^https?:\/\//i.test(url))
    return res.status(400).json({ error: 'title und gültige url erforderlich' });
  const list = getBraveUrls();
  const entry = { id: 'b-' + Date.now(), title, url, icon: icon || '🌐' };
  list.push(entry);
  saveBraveUrls(list);
  res.status(201).json(entry);
});
app.delete('/api/brave-urls/:id', (req, res) => {
  const list = getBraveUrls().filter(e => e.id !== req.params.id);
  saveBraveUrls(list);
  res.json({ ok: true });
});

app.get('/api/brave-media', (_req, res) => res.json(getMediaTiles()));
app.post('/api/brave-media', (req, res) => {
  const { title, url, icon, color } = req.body;
  if (!title || !url || !/^https?:\/\//i.test(url))
    return res.status(400).json({ error: 'title und gültige url erforderlich' });
  const list = getMediaTiles();
  const entry = { id: 'm-' + Date.now(), title, url, icon: icon || '🌐', color: color || '#555555' };
  list.push(entry);
  saveMediaTiles(list);
  res.status(201).json(entry);
});
app.delete('/api/brave-media/:id', (req, res) => {
  const list = getMediaTiles().filter(e => e.id !== req.params.id);
  saveMediaTiles(list);
  res.json({ ok: true });
});

app.post('/api/restart', (_req, res) => {
  if (!DART_HUB_ENABLED) {
    return res.status(410).json({ error: 'Server-Neustart aus dem dart-dashboard-Admin ist deaktiviert.' });
  }
  res.json({ ok: true, message: 'Server wird neu gestartet...' });
  setTimeout(() => process.exit(0), 400);
});

// Brave als Standard-Browser setzen (ohne Interaktion am Fire TV)
app.post('/api/set-default-browser', (_req, res) => {
  const s = getSettings();
  const adbPath = s.adbPath || ADB_DEFAULT;
  const device  = `${s.firestickIp || '192.168.8.177'}:5555`;
  exec(`"${adbPath}" -s ${device} shell cmd package set-default-browser ${BRAVE_PKG}`, (err, stdout, stderr) => {
    if (err) {
      // Fallback: preferred-activity via intent
      exec(`"${adbPath}" -s ${device} shell pm set-preferred-activity --action android.intent.action.VIEW --category android.intent.category.DEFAULT --category android.intent.category.BROWSABLE --scheme http ${BRAVE_PKG}/.app.BraveActivity`, (err2, out2) => {
        res.json({ ok: !err2, stdout: out2, error: err2 ? err2.message : null });
      });
    } else {
      res.json({ ok: true, stdout });
    }
  });
});

// ADB-Tasteneingabe senden (z. B. um Dialoge am Fire TV zu bestätigen)
app.post('/api/adb-key', (req, res) => {
  const { keycode } = req.body || {};
  if (!keycode || !/^\d+$/.test(String(keycode))) {
    return res.status(400).json({ ok: false, error: 'Ungültiger Keycode' });
  }
  const s = getSettings();
  const adbPath = s.adbPath || ADB_DEFAULT;
  const device  = `${s.firestickIp || '192.168.8.177'}:5555`;
  exec(`"${adbPath}" -s ${device} shell input keyevent ${keycode}`, (err, stdout) => {
    res.json({ ok: !err, stdout, error: err ? err.message : null });
  });
});

// Bildschirm-Tap per ADB (für Dialog-Buttons die mit Fernbedienung nicht erreichbar sind)
app.post('/api/adb-tap', (req, res) => {
  const { x, y } = req.body || {};
  const xi = parseInt(x, 10);
  const yi = parseInt(y, 10);
  if (isNaN(xi) || isNaN(yi) || xi < 0 || yi < 0 || xi > 3840 || yi > 2160) {
    return res.status(400).json({ ok: false, error: 'Ungültige Koordinaten' });
  }
  const s = getSettings();
  const adbPath = s.adbPath || ADB_DEFAULT;
  const device  = `${s.firestickIp || '192.168.8.177'}:5555`;
  exec(`"${adbPath}" -s ${device} shell input tap ${xi} ${yi}`, (err, stdout) => {
    res.json({ ok: !err, stdout, error: err ? err.message : null });
  });
});

// Text-Eingabe per ADB (spawn statt exec → kein Shell-Injection-Risiko)
app.post('/api/adb-text', (req, res) => {
  const { text } = req.body || {};
  if (!text || typeof text !== 'string' || text.length > 200) {
    return res.status(400).json({ ok: false, error: 'Ungültiger Text' });
  }
  const s = getSettings();
  const adbPath = s.adbPath || ADB_DEFAULT;
  const device  = `${s.firestickIp || '192.168.8.177'}:5555`;
  // Leerzeichen müssen für Android input text als %s kodiert werden
  const androidText = text.replace(/ /g, '%s');
  const child = spawn(adbPath, ['-s', device, 'shell', 'input', 'text', androidText]);
  child.on('close', (code) => res.json({ ok: code === 0 }));
  child.on('error', (err) => res.status(500).json({ ok: false, error: err.message }));
});

// Screenshot vom Fire TV aufnehmen und als PNG zurückgeben
app.get('/api/firetv-screenshot', (req, res) => {
  const s = getSettings();
  const adbPath = s.adbPath || ADB_DEFAULT;
  const device  = `${s.firestickIp || '192.168.8.177'}:5555`;
  const tmpFile = path.join(DATA_DIR, 'firetv-screen.png');

  // Screenshot auf Gerät aufnehmen, dann zum PC ziehen
  exec(`"${adbPath}" -s ${device} shell screencap -p /sdcard/_dash_screen.png`, (err) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    exec(`"${adbPath}" -s ${device} pull /sdcard/_dash_screen.png "${tmpFile}"`, (err2) => {
      if (err2) return res.status(500).json({ ok: false, error: err2.message });
      // Auflösung des Geräts ermitteln
      exec(`"${adbPath}" -s ${device} shell wm size`, (err3, sizeOut) => {
        const match = (sizeOut || '').match(/(\d+)x(\d+)/);
        const w = match ? parseInt(match[1]) : 1920;
        const h = match ? parseInt(match[2]) : 1080;
        res.json({ ok: true, width: w, height: h, ts: Date.now() });
      });
    });
  });
});

// Fully Kiosk beenden + TV Launcher starten (damit Fernbedienung wieder funktioniert)
app.post('/api/fully-stop', (_req, res) => {
  const s = getSettings();
  const adbPath = s.adbPath || ADB_DEFAULT;
  const device  = `${s.firestickIp || '192.168.8.177'}:5555`;
  exec(`"${adbPath}" -s ${device} shell am force-stop de.ozerov.fully`, (err) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    exec(`"${adbPath}" -s ${device} shell am start -n com.amazon.tv.launcher/.ui.MainActivity`, (err2) => {
      res.json({ ok: !err2, error: err2 ? err2.message : null });
    });
  });
});

// Fully Kiosk starten
app.post('/api/fully-start', (_req, res) => {
  const s = getSettings();
  const adbPath = s.adbPath || ADB_DEFAULT;
  const device  = `${s.firestickIp || '192.168.8.177'}:5555`;
  exec(`"${adbPath}" -s ${device} shell am start -n de.ozerov.fully/.MainActivity`, (err) => {
    res.json({ ok: !err, error: err ? err.message : null });
  });
});

// Gespeichertes Screenshot-Bild ausliefern
app.get('/api/firetv-screen.png', (req, res) => {
  const f = path.join(DATA_DIR, 'firetv-screen.png');
  if (!fs.existsSync(f)) return res.status(404).end();
  res.sendFile(f);
});

async function startServer() {
  await dataStore.init({
    playersFile: PLAYERS_FILE,
    liveStateFile: LIVE_STATE_FILE,
    highscoresFile: HIGHSCORES_FILE
  });

  const storageInfo = dataStore.getInfo();
  console.log(`[Storage] client=${storageInfo.client} external=${storageInfo.external}`);
  if (storageInfo.sqliteFile) {
    console.log('[Storage] sqlite=' + storageInfo.sqliteFile);
  }

  app.listen(PORT, () => {
    console.log('Dashboard: http://localhost:' + PORT);
    console.log('Admin:     http://localhost:' + PORT + '/admin.html');
    startArduinoMonitor();
    if (FIRE_FEATURES_ENABLED) autoLaunchKiosk();
  });
}

startServer().catch((err) => {
  console.error('[Storage] Start fehlgeschlagen:', err.message);
  process.exit(1);
});

function autoLaunchKiosk() {
  const s = getSettings();
  const adbPath = s.adbPath || ADB_DEFAULT;
  const device  = `${s.firestickIp || '192.168.8.177'}:5555`;
  const dashUrl = `http://${s.serverIp || getLocalIP()}:${PUBLIC_PORT}`;
  exec(`"${adbPath}" connect ${device}`, (err, stdout) => {
    if (err || (!stdout.includes('connected') && !stdout.includes('already connected'))) {
      console.log('[Kiosk] Fire Stick nicht erreichbar – Start übersprungen.');
      return;
    }
    // Fully Kiosk mit der aktuellen Dashboard-URL starten
    const cmd = `"${adbPath}" -s ${device} shell am start -n de.ozerov.fully/.MainActivity -d "${dashUrl}"`;
    exec(cmd, (e) => {
      if (e) console.log('[Kiosk] Fully Kiosk Start fehlgeschlagen:', e.message);
      else   console.log('[Kiosk] Fully Kiosk gestartet → ' + dashUrl);
    });
  });
}

// Kiosk-URL manuell neu setzen (nützlich nach Port-Änderungen)
app.post('/api/kiosk-reload', (_req, res) => {
  const s = getSettings();
  const adbPath = s.adbPath || ADB_DEFAULT;
  const device  = `${s.firestickIp || '192.168.8.177'}:5555`;
  const dashUrl = `http://${s.serverIp || getLocalIP()}:${PUBLIC_PORT}`;
  exec(`"${adbPath}" -s ${device} shell am start -n de.ozerov.fully/.MainActivity -d "${dashUrl}"`, (err) => {
    res.json({ ok: !err, url: dashUrl, error: err ? err.message : null });
  });
});
