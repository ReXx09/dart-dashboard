const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');

function getLocalIP() {
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

const DATA_DIR     = path.join(__dirname, 'data');
const CUSTOM_FILE  = path.join(DATA_DIR, 'custom-dashboards.json');
const OVERRIDES_FILE = path.join(DATA_DIR, 'fixed-overrides.json');
const SETTINGS_FILE  = path.join(DATA_DIR, 'settings.json');

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
  { id: 'live-spielstand',title: 'Live-Spielstand',  icon: '⚡', description: 'Aktueller Spielstand in Echtzeit',              color: '#f4a261', route: '/panels/live-spielstand.html',                                                   external: false, badge: 'Live'       }
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
function getSettings() { return { hubTitle: 'Löwen Dart – Kiosk Hub', ...readJson(SETTINGS_FILE, {}) }; }
function saveSettings(s){ writeJson(SETTINGS_FILE, s); }

// ── Fixed tiles ──
app.get('/api/dashboards/fixed', (req, res) => res.json(getFixed()));
app.put('/api/dashboards/fixed/:id', (req, res) => {
  const def = fixedDefaults.find(d => d.id === req.params.id);
  if (!def) return res.status(404).json({ error: 'Nicht gefunden' });
  const ov = readJson(OVERRIDES_FILE, {});
  ov[req.params.id] = { ...(ov[req.params.id] || {}), ...req.body };
  writeJson(OVERRIDES_FILE, ov);
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
  res.status(201).json(entry);
});
app.put('/api/dashboards/custom/:id', (req, res) => {
  const list = getCustom();
  const i = list.findIndex(d => d.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'Nicht gefunden' });
  list[i] = { ...list[i], ...req.body, id: list[i].id };
  saveCustom(list);
  res.json(list[i]);
});
app.delete('/api/dashboards/custom/:id', (req, res) => {
  let list = getCustom();
  const before = list.length;
  list = list.filter(d => d.id !== req.params.id);
  if (list.length === before) return res.status(404).json({ error: 'Nicht gefunden' });
  saveCustom(list);
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
  res.json(s);
});

app.listen(PORT, () => {
  console.log('Dashboard: http://localhost:' + PORT);
  console.log('Admin:     http://localhost:' + PORT + '/admin.html');
});
