# Loewen Dart Dashboard

Zentrales Kiosk-Dashboard fuer den Loewen Dart Club.

Das Projekt bietet:
- Hub-Oberflaeche mit festen und eigenen Kacheln
- Admin-Panel fuer Konfiguration
- Optional Fire-TV / ADB Funktionen
- Live-Anzeige fuer Arduino-Serial (EVT/HB) im Hub

## Voraussetzungen

- Node.js 20+
- Docker + Docker Compose (empfohlen fuer Betrieb)

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
