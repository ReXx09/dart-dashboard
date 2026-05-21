const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const { exec, spawn } = require('child_process');

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

const DATA_DIR       = path.join(__dirname, 'data');
const CUSTOM_FILE    = path.join(DATA_DIR, 'custom-dashboards.json');
const OVERRIDES_FILE = path.join(DATA_DIR, 'fixed-overrides.json');
const SETTINGS_FILE  = path.join(DATA_DIR, 'settings.json');
const PLAYERS_FILE   = path.join(DATA_DIR, 'players.json');
const BRAVE_URLS_FILE  = path.join(DATA_DIR, 'brave-urls.json');
const BRAVE_MEDIA_FILE = path.join(DATA_DIR, 'brave-media.json');

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

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));
app.use(express.json());

const fixedDefaults = [
  { id: 'grafana',        title: 'Grafana',         icon: '📊', description: 'Metriken, Graphen & Monitoring',               color: '#f46800', route: 'http://localhost:3001',                                                          external: true,  badge: 'Monitoring' },
  { id: 'wm2026',         title: 'WM 2026',          icon: '🌍', description: 'FIFA Weltmeisterschaft 2026 – Spielplan',       color: '#2a9d8f', route: '/panels/wm2026/index.html',                                                      external: false, badge: 'Lokal'      },
  { id: 'privat-dart',    title: 'Privat Dart',      icon: '🎯', description: 'Vereinsinterne Dart-Liga & Turniere',           color: '#e63946', route: '/panels/privat-dart.html',                                                       external: false, badge: 'Lokal'      },
  { id: 'live-spielstand',title: 'Live-Spielstand',  icon: '⚡', description: 'Aktueller Spielstand in Echtzeit',              color: '#f4a261', route: '/panels/live-spielstand.html',                                                   external: false, badge: 'Live'       },
  { id: 'brave',          title: 'Browser',          icon: '\uD83E\uDD81', description: 'YouTube & Web-Inhalte \xFCber Brave Browser',        color: '#FB542B', route: '/panels/brave.html',                                                             external: false, badge: 'Brave'      }
];

function readJson(file, fallback) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  return fallback;
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function getFixed()    { const ov = readJson(OVERRIDES_FILE, {}); return fixedDefaults.map(d => ({ ...d, ...(ov[d.id] || {}) })); }
function getCustom()   { return readJson(CUSTOM_FILE, []); }
function saveCustom(l) { writeJson(CUSTOM_FILE, l); }
function getSettings() {
  return {
    hubTitle: 'Löwen Dart – Kiosk Hub',
    autoReloadMinutes: 5,
    screensaverEnabled: true,
    screensaverMinutes: 2,
    adbPath: process.env.ADB_PATH || ADB_DEFAULT,
    firestickIp: process.env.FIRESTICK_IP || '192.168.8.177',
    ...readJson(SETTINGS_FILE, {})
  };
}
function saveSettings(s){ writeJson(SETTINGS_FILE, s); }

function getPlayers() {
  const defaults = Array.from({ length: 8 }, (_, i) => ({ slot: i + 1, name: '', active: false }));
  const saved = readJson(PLAYERS_FILE, []);
  return defaults.map(d => { const s = saved.find(p => p.slot === d.slot); return s ? { ...d, ...s } : d; });
}
function savePlayers(list) { writeJson(PLAYERS_FILE, list); }

// ── Fixed tiles ──
app.get('/api/dashboards/fixed', (req, res) => res.json(getFixed()));
app.put('/api/dashboards/fixed/:id', (req, res) => {
  const def = fixedDefaults.find(d => d.id === req.params.id);
  if (!def) return res.status(404).json({ error: 'Nicht gefunden' });
  const ov = readJson(OVERRIDES_FILE, {});
  ov[req.params.id] = { ...(ov[req.params.id] || {}), ...req.body };
  writeJson(OVERRIDES_FILE, ov);
  broadcastReload();
  res.json({ ...def, ...ov[req.params.id] });
});

// ── Custom tiles ──
app.get('/api/dashboards/custom', (req, res) => res.json(getCustom()));
app.post('/api/dashboards/custom', (req, res) => {
  const { title, icon, description, color, route, external, badge } = req.body;
  if (!title || !route) return res.status(400).json({ error: 'title und route erforderlich' });
  const list = getCustom();
  const entry = { id: 'custom-' + Date.now(), title, icon: icon || '🔗', description: description || '', color: color || '#6c757d', route, external: !!external, badge: badge || 'Custom' };
  list.push(entry);
  saveCustom(list);
  broadcastReload();
  res.status(201).json(entry);
});
app.put('/api/dashboards/custom/:id', (req, res) => {
  const list = getCustom();
  const i = list.findIndex(d => d.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'Nicht gefunden' });
  list[i] = { ...list[i], ...req.body, id: list[i].id };
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
app.get('/api/players', (req, res) => res.json(getPlayers()));
app.put('/api/players', (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Array erwartet' });
  savePlayers(req.body);
  broadcastReload();
  res.json({ ok: true });
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

// ── ADB / Brave ──
function getBraveUrls()   { return readJson(BRAVE_URLS_FILE, []); }
function saveBraveUrls(l) { writeJson(BRAVE_URLS_FILE, l); }
function getMediaTiles()  { return fs.existsSync(BRAVE_MEDIA_FILE) ? readJson(BRAVE_MEDIA_FILE, DEFAULT_MEDIA) : DEFAULT_MEDIA; }
function saveMediaTiles(l){ writeJson(BRAVE_MEDIA_FILE, l); }

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

app.listen(PORT, () => {
  console.log('Dashboard: http://localhost:' + PORT);
  console.log('Admin:     http://localhost:' + PORT + '/admin.html');
  autoLaunchKiosk();
});

function autoLaunchKiosk() {
  const s = getSettings();
  const adbPath = s.adbPath || ADB_DEFAULT;
  const device  = `${s.firestickIp || '192.168.8.177'}:5555`;
  const dashUrl = `http://${getLocalIP()}:${PORT}`;
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
  const dashUrl = `http://${getLocalIP()}:${PORT}`;
  exec(`"${adbPath}" -s ${device} shell am start -n de.ozerov.fully/.MainActivity -d "${dashUrl}"`, (err) => {
    res.json({ ok: !err, url: dashUrl, error: err ? err.message : null });
  });
});
