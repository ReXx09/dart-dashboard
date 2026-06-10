# Loewen Dart Dashboard

Zentrales Kiosk-Dashboard fuer den Loewen Dart Club.

Das Projekt bietet:
- Hub-Oberflaeche mit festen und eigenen Kacheln
- Admin-Panel fuer Konfiguration
- Optional Fire-TV / ADB Funktionen
- Live-Anzeige fuer Arduino-Serial (EVT/HB) im Hub

## Verantwortungsgrenze

- `dart-dashboard` verwaltet nur interne Dart-Inhalte unter `/panels/...` (Dart, Live, Rangliste, Spielplan, Spieler, Statistiken).
- Externe Dashboards (Grafana, externe Webseiten, weitere Services) werden ueber `Fire-Stick/kiosk-dashboard` verwaltet.
- API-seitig sind im `dart-dashboard` externe Kachel-Routen bewusst blockiert.
- Neu: Dashboard-/Kachel-/Settings-Verwaltung ist standardmaessig im `dart-dashboard` deaktiviert und in den Hub verlagert.

Aktuell enthaltene interne Panel-Dateien im `dart-dashboard`:
- `/panels/privat-dart.html`
- `/panels/live-spielstand.html`
- `/panels/rangliste.html`
- `/panels/spielerstatistiken.html`
- `/panels/spielplan.html`
- `/panels/spieler.html`

Wichtig:
- Diese Panelseiten sind aktuell Simulation/Preview und noch keine vollstaendig live-angebundenen Spielpanels.
- Live-Spielstand und Highscores sind jetzt API- und SQL-basiert persistent.

## Voraussetzungen

- Node.js 20+
- Docker + Docker Compose (empfohlen fuer Betrieb)

## Gefuehrter Setup-Assistent (install.sh)

Fuer unerfahrene Nutzer gibt es einen interaktiven Assistenten:

```bash
chmod +x install.sh
./install.sh
```

Der Assistent bietet:
- Systemcheck + Auto-Installation fuer Docker/Pi-Tools
- Install/Update + Build + Start (empfohlen)
- Nur Start ohne Build
- Status + Logs
- Stoppen
- Optionales Clone in einen anderen Ordner

Menuepunkte im Assistenten:
- 0 = Systemcheck + Auto-Installation
- 1 = Install/Update + Build + Start
- 2 = Nur Start
- 3 = Status und Logs
- 4 = Stoppen
- 5 = Repo in anderen Ordner klonen
- 6 = Beenden

Hinweis:
- Wenn `whiptail` installiert ist, nutzt `install.sh` automatisch ein Dialog-Menue.
- Ohne `whiptail` nutzt das Skript das normale Textmenue (Fallback).
- Die Auto-Installation ist fuer Debian/Raspberry Pi OS via apt-get ausgelegt.

## Schnellstart (Docker Image)

Wenn du einfach starten willst und das veroeffentlichte Image nutzt:

```bash
docker compose up -d
```

Aufruf im Browser:
- `http://<HOST-IP>:3100`

Stoppen:

```bash
docker compose down
```

## Lokales Build (fuer aktuelle Repo-Aenderungen)

Wenn du lokale Code-Aenderungen im Container sehen willst, baue lokal:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

Status und Logs:

```bash
docker compose ps
docker logs -f dart-dashboard
```

## Lokaler Start ohne Docker

```bash
npm install
npm start
```

Aufruf im Browser:
- `http://localhost:3000`

Entwicklungsmodus:

```bash
npm run dev
```

## Konfiguration

Du kannst Umgebungswerte in einer `.env` Datei neben `docker-compose.yml` setzen (siehe `.env.example`).

Wichtige Variablen:
- `SERVER_IP` = LAN-IP des Hosts (fuer korrekte Kiosk-URL)
- `FIRESTICK_IP` = Fire TV Stick IP
- `DATA_PATH` = Persistente Daten (Settings, Dashboards, etc.)
- `ADB_KEYS_PATH` = Persistente ADB-Keys
- `PUBLIC_PORT` = Externer Port (Standard 3100)
- `DART_HUB_ENABLED` = `false` (empfohlen, klare Trennung), `true` fuer Legacy-Hub/Admin im dart-dashboard

SQL-Storage Variablen:
- `DB_CLIENT` = `sqlite` (Standard), `postgres` oder `mysql`
- `DB_SQLITE_FILE` = Pfad zur SQLite-Datei (nur bei `sqlite`)
- `DB_URL` = Verbindungsstring fuer externe SQL-Datenbank
- `DB_SSL` = `true/false` fuer TLS bei externer DB

Beispiele fuer externe DB:

```bash
# PostgreSQL extern
DB_CLIENT=postgres
DB_URL=postgres://user:pass@db-host:5432/dart_dashboard

# MySQL extern
DB_CLIENT=mysql
DB_URL=mysql://user:pass@db-host:3306/dart_dashboard
```

Hinweis externe DB:
- Bei externer DB liegen Spieler, Live-State und Highscores nicht auf dem Raspberry Pi.
- Der Endpoint `GET /api/storage/info` zeigt aktiv verwendetes Storage-Backend an.

## Getrennter Betriebsmodus (empfohlen)

Standard ist jetzt:
- `DART_HUB_ENABLED=false`

In diesem Modus gilt:
- `dart-dashboard` liefert Dart-Panels und Dart-Daten-APIs.
- Hub-Verwaltung (`/api/dashboards/*`, `/api/settings`, `/api/server-info`) ist im `dart-dashboard` deaktiviert.
- Zentrale Verwaltung erfolgt ueber `Fire-Stick/kiosk-dashboard`.

Optional (Legacy):
- `DART_HUB_ENABLED=true` reaktiviert den alten Hub/Admin im `dart-dashboard`.

## Arduino Live-Monitor

Der Server versucht automatisch einen Arduino-Serial-Port zu nutzen.

Standard:
- `arduinoMonitorEnabled = true`
- `arduinoBaudRate = 115200`
- `arduinoPort = ""` (auto detect)

Die Live-Zeile im Hub zeigt:
- Verbindungsstatus
- Letztes Event (z. B. `CH01 -> ACTIVE`)
- Heartbeat (`active=n`)

Relevante API-Endpunkte:
- `GET /api/arduino/state`
- `GET /api/arduino/events` (SSE)
- `POST /api/arduino/command`

## Projektstruktur

- `server.js` - Express Server und API
- `public/index.html` - Hub
- `public/admin.html` - Admin-Panel
- `data/` - persistente Daten
- `docker-compose.yml` - Standard Deployment
- `docker-compose.build.yml` - lokales Build-Override

## Hinweise

- In Docker muss der Host Zugriff auf den Arduino-USB-Port haben, wenn Live-Serial genutzt wird.
- Wenn kein Arduino gefunden wird, laeuft das Dashboard weiter und zeigt den Verbindungsfehler in der Live-Zeile.
