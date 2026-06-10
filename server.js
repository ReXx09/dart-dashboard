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
  <title>Loewen Dart – Service</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0a0a0a;
      color: #f1f1f1;
      font-family: "Segoe UI", system-ui, sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    header {
      background: #111;
      border-bottom: 3px solid #e63946;
      padding: 16px 32px;
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .logo { font-size: 2rem; }
    .header-text h1 { font-size: 1.4rem; font-weight: 700; letter-spacing: .5px; }
    .header-text p  { font-size: .78rem; color: #666; margin-top: 2px; }
    main { flex: 1; padding: 28px 32px; max-width: 1100px; width: 100%; margin: 0 auto; }

    .section-hd {
      display: flex; align-items: center; gap: 14px; margin-bottom: 16px; margin-top: 28px;
    }
    .section-hd:first-child { margin-top: 0; }
    .section-label {
      font-size: .72rem; text-transform: uppercase; letter-spacing: 3px;
      color: #555; font-weight: 600; white-space: nowrap;
    }
    .section-line { flex: 1; height: 1px; background: #1e1e1e; }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
      gap: 14px;
    }

    .card {
      position: relative;
      background: #161616;
      border: 2px solid transparent;
      border-radius: 14px;
      padding: 20px 18px 16px;
      text-decoration: none;
      color: inherit;
      display: flex;
      flex-direction: column;
      gap: 8px;
      transition: transform .18s, box-shadow .18s, border-color .18s;
      overflow: hidden;
      cursor: pointer;
    }
    .card::before {
      content: "";
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 3px;
      background: var(--accent, #444);
    }
    .card:hover {
      transform: translateY(-4px);
      box-shadow: 0 12px 36px rgba(0,0,0,.55);
      border-color: var(--accent, #444);
    }
    .card-icon  { font-size: 2rem; line-height: 1; }
    .card-title { font-size: 1rem; font-weight: 700; }
    .card-desc  { font-size: .75rem; color: #888; line-height: 1.45; flex: 1; }
    .card-foot  { display: flex; align-items: center; justify-content: space-between; margin-top: 6px; }
    .badge {
      font-size: .67rem; padding: 3px 9px; border-radius: 20px; font-weight: 700;
      background: var(--accent-bg, #1e1e1e); color: var(--accent, #888);
    }
    .health-pill {
      font-size: .62rem;
      padding: 3px 8px;
      border-radius: 20px;
      border: 1px solid #2b2b2b;
      color: #909090;
      background: #141414;
      letter-spacing: .3px;
      text-transform: uppercase;
      font-weight: 700;
    }
    .health-pill.ok {
      color: #2a9d8f;
      border-color: #1f4f49;
      background: #0d1816;
    }
    .health-pill.warn {
      color: #f4a261;
      border-color: #5b3a1d;
      background: #1c130b;
    }
    .health-pill.err {
      color: #e63946;
      border-color: #5f1a21;
      background: #1c0d10;
    }
    .arrow { font-size: .95rem; opacity: .4; transition: opacity .2s, transform .2s; }
    .card:hover .arrow { opacity: 1; transform: translateX(4px); }

    .status-bar {
      background: #111;
      border: 1px solid #1e1e1e;
      border-radius: 12px;
      padding: 10px 16px;
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: .8rem;
      color: #555;
      margin-bottom: 4px;
    }
    .dot {
      width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0;
      background: #333;
    }
    .dot.live { background: #2a9d8f; box-shadow: 0 0 10px rgba(42,157,143,.7); }

    footer {
      text-align: center;
      padding: 14px;
      font-size: .7rem;
      color: #222;
      border-top: 1px solid #141414;
    }
  </style>
</head>
<body>

<header>
  <span class="logo">🎯</span>
  <div class="header-text">
    <h1>Loewen Dart &ndash; Service</h1>
    <p>Dart-Backend-Service &bull; Panels &bull; Daten-APIs</p>
  </div>
</header>

<main>

  <div class="status-bar" id="statusBar">
    <span class="dot" id="statusDot"></span>
    <span id="statusText">Pruefe Service...</span>
  </div>

  <div class="section-hd">
    <span class="section-label">Panels</span>
    <div class="section-line"></div>
  </div>
  <div class="grid">
    <a class="card" href="/panels/live-spielstand.html" style="--accent:#e63946;--accent-bg:#1f0b0d">
      <span class="card-icon">&#9889;</span>
      <span class="card-title">Live-Spielstand</span>
      <span class="card-desc">Aktueller Spielstand, Punktevergabe und Highscore-Tabelle.</span>
      <div class="card-foot">
        <span class="badge" style="--accent:#e63946;--accent-bg:#1f0b0d">Live</span>
        <span class="arrow">&#8594;</span>
      </div>
    </a>
    <a class="card" href="/panels/spieler.html" style="--accent:#9b5de5;--accent-bg:#160d22">
      <span class="card-icon">&#128100;</span>
      <span class="card-title">Spieler</span>
      <span class="card-desc">Spielerverwaltung &ndash; Slots, Namen und aktive Spieler festlegen.</span>
      <div class="card-foot">
        <span class="badge" style="--accent:#9b5de5;--accent-bg:#160d22">Verwaltung</span>
        <span class="arrow">&#8594;</span>
      </div>
    </a>
    <a class="card" href="/panels/rangliste.html" style="--accent:#f4a261;--accent-bg:#1e1208">
      <span class="card-icon">&#127942;</span>
      <span class="card-title">Rangliste</span>
      <span class="card-desc">Vereins-Rangliste und Saisonuebersicht.</span>
      <div class="card-foot">
        <span class="badge" style="--accent:#f4a261;--accent-bg:#1e1208">Preview</span>
        <span class="arrow">&#8594;</span>
      </div>
    </a>
    <a class="card" href="/panels/spielplan.html" style="--accent:#264653;--accent-bg:#0d1416">
      <span class="card-icon">&#128197;</span>
      <span class="card-title">Spielplan</span>
      <span class="card-desc">Aktuelle Spieltermine und Ligaplanung.</span>
      <div class="card-foot">
        <span class="badge" style="--accent:#457b9d;--accent-bg:#0d1520">Preview</span>
        <span class="arrow">&#8594;</span>
      </div>
    </a>
    <a class="card" href="/panels/spielerstatistiken.html" style="--accent:#457b9d;--accent-bg:#0d1520">
      <span class="card-icon">&#128202;</span>
      <span class="card-title">Statistiken</span>
      <span class="card-desc">Spieler-Statistiken und Auswertungen.</span>
      <div class="card-foot">
        <span class="badge" style="--accent:#457b9d;--accent-bg:#0d1520">Preview</span>
        <span class="arrow">&#8594;</span>
      </div>
    </a>
    <a class="card" href="/panels/privat-dart.html" style="--accent:#2a9d8f;--accent-bg:#0b1714">
      <span class="card-icon">&#127919;</span>
      <span class="card-title">Privat Dart</span>
      <span class="card-desc">Private Spielansicht fuer Vereinsmitglieder.</span>
      <div class="card-foot">
        <span class="badge" style="--accent:#2a9d8f;--accent-bg:#0b1714">Preview</span>
        <span class="arrow">&#8594;</span>
      </div>
    </a>
  </div>

  <div class="section-hd">
    <span class="section-label">Daten-APIs</span>
    <div class="section-line"></div>
  </div>
  <div class="grid">
    <a class="card" href="/api/live/state" style="--accent:#e63946;--accent-bg:#1f0b0d" data-health-endpoint="/api/live/state" data-health-id="health-live">
      <span class="card-icon">&#128268;</span>
      <span class="card-title">Live-State</span>
      <span class="card-desc">Aktueller Spielzustand als JSON.</span>
      <div class="card-foot">
        <span class="badge" style="--accent:#e63946;--accent-bg:#1f0b0d">GET</span>
        <span class="health-pill" id="health-live">Pruefe...</span>
      </div>
    </a>
    <a class="card" href="/api/highscores" style="--accent:#f4a261;--accent-bg:#1e1208" data-health-endpoint="/api/highscores" data-health-id="health-highscores">
      <span class="card-icon">&#127942;</span>
      <span class="card-title">Highscores</span>
      <span class="card-desc">Top-100 Highscores aus der Datenbank.</span>
      <div class="card-foot">
        <span class="badge" style="--accent:#f4a261;--accent-bg:#1e1208">GET</span>
        <span class="health-pill" id="health-highscores">Pruefe...</span>
      </div>
    </a>
    <a class="card" href="/api/players" style="--accent:#9b5de5;--accent-bg:#160d22" data-health-endpoint="/api/players" data-health-id="health-players">
      <span class="card-icon">&#128100;</span>
      <span class="card-title">Spieler-API</span>
      <span class="card-desc">Spieler-Slots lesen und schreiben.</span>
      <div class="card-foot">
        <span class="badge" style="--accent:#9b5de5;--accent-bg:#160d22">GET/PUT</span>
        <span class="health-pill" id="health-players">Pruefe...</span>
      </div>
    </a>
    <a class="card" href="/api/storage/info" style="--accent:#2a9d8f;--accent-bg:#0b1714" data-health-endpoint="/api/storage/info" data-health-id="health-storage">
      <span class="card-icon">&#128190;</span>
      <span class="card-title">Storage-Info</span>
      <span class="card-desc">Aktives Datenbank-Backend und Verbindungsstatus.</span>
      <div class="card-foot">
        <span class="badge" style="--accent:#2a9d8f;--accent-bg:#0b1714">GET</span>
        <span class="health-pill" id="health-storage">Pruefe...</span>
      </div>
    </a>
    <a class="card" href="/api/arduino/state" style="--accent:#457b9d;--accent-bg:#0d1520" data-health-endpoint="/api/arduino/state" data-health-id="health-arduino">
      <span class="card-icon">&#9881;</span>
      <span class="card-title">Arduino-Status</span>
      <span class="card-desc">Verbindungsstatus und letztes Serial-Event.</span>
      <div class="card-foot">
        <span class="badge" style="--accent:#457b9d;--accent-bg:#0d1520">GET</span>
        <span class="health-pill" id="health-arduino">Pruefe...</span>
      </div>
    </a>
  </div>

</main>

<footer>Loewen Dart Club &mdash; Dart-Service &bull; Hub-Verwaltung im Kiosk-Dashboard</footer>

<script>
  function setHealthState(el, state, label) {
    el.classList.remove('ok', 'warn', 'err');
    if (state) el.classList.add(state);
    el.textContent = label;
  }

  async function probeEndpoint(endpoint) {
    try {
      const r = await fetch(endpoint, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) {
        return { ok: false, label: 'HTTP ' + r.status };
      }
      return { ok: true, label: 'OK' };
    } catch (_e) {
      return { ok: false, label: 'Offline' };
    }
  }

  async function refreshApiHealth() {
    const cards = Array.from(document.querySelectorAll('[data-health-endpoint]'));
    const dot = document.getElementById('statusDot');
    const text = document.getElementById('statusText');

    let okCount = 0;
    for (const card of cards) {
      const endpoint = card.getAttribute('data-health-endpoint');
      const targetId = card.getAttribute('data-health-id');
      const badge = document.getElementById(targetId);
      if (!badge) continue;

      setHealthState(badge, null, 'Pruefe...');
      const result = await probeEndpoint(endpoint);
      if (result.ok) {
        okCount += 1;
        setHealthState(badge, 'ok', result.label);
      } else {
        setHealthState(badge, 'err', result.label);
      }
    }

    if (okCount === cards.length) {
      dot.classList.add('live');
      text.textContent = 'API verbunden - alle Endpunkte erreichbar (' + okCount + '/' + cards.length + ')';
      return;
    }

    dot.classList.remove('live');
    if (okCount > 0) {
      text.textContent = 'API teilweise verbunden (' + okCount + '/' + cards.length + ')';
    } else {
      text.textContent = 'API nicht verbunden - keine Endpunkte erreichbar';
    }
  }

  refreshApiHealth();
  setInterval(refreshApiHealth, 10000);
</script>

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
