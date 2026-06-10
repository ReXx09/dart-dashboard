#!/usr/bin/env bash

run_health_checks() {
  local report=""
  local compose_cmd=""
  local public_port=""
  local fire_enabled=""
  local fire_ip=""

  public_port="$(get_env_value PUBLIC_PORT 3100)"
  fire_enabled="$(get_env_value FIRE_FEATURES_ENABLED true | tr '[:upper:]' '[:lower:]')"
  fire_ip="$(get_env_value FIRESTICK_IP 192.168.8.177)"

  report+="Health-Check Loewen Dart Dashboard\n\n"

  if command_exists docker; then
    report+="[OK] Docker vorhanden\n"
  else
    report+="[FEHLT] Docker nicht gefunden\n"
  fi

  if compose_cmd="$(detect_compose_cmd)"; then
    report+="[OK] Docker Compose verfuegbar (${compose_cmd})\n"
    if compose_output="$($compose_cmd ps 2>&1 || true)" && printf '%s' "$compose_output" | grep -q 'dart-dashboard'; then
      report+="[OK] Containerstatus abgefragt (dart-dashboard gefunden)\n"
    else
      report+="[WARN] Compose erreichbar, aber dart-dashboard nicht sichtbar\n"
    fi
  else
    report+="[FEHLT] Docker Compose nicht verfuegbar\n"
  fi

  if command_exists curl; then
    local api_base
    api_base="http://localhost:${public_port}"

    if live_json="$(curl -fsS --max-time 4 "${api_base}/api/live/state" 2>/dev/null || true)" && [[ -n "$live_json" ]]; then
      report+="[OK] API live/state erreichbar (${api_base})\n"
    else
      report+="[FEHLT] API live/state nicht erreichbar (${api_base})\n"
    fi

    if storage_json="$(curl -fsS --max-time 4 "${api_base}/api/storage/info" 2>/dev/null || true)" && [[ -n "$storage_json" ]]; then
      if command_exists jq; then
        local db_client db_external
        db_client="$(printf '%s' "$storage_json" | jq -r '.client // "unknown"' 2>/dev/null || printf 'unknown')"
        db_external="$(printf '%s' "$storage_json" | jq -r '.external // false' 2>/dev/null || printf 'false')"
        report+="[OK] Storage API erreichbar (client=${db_client}, external=${db_external})\n"
      else
        report+="[OK] Storage API erreichbar\n"
      fi
    else
      report+="[FEHLT] Storage API nicht erreichbar\n"
    fi

    if arduino_json="$(curl -fsS --max-time 4 "${api_base}/api/arduino/state" 2>/dev/null || true)" && [[ -n "$arduino_json" ]]; then
      if command_exists jq; then
        local arduino_connected
        arduino_connected="$(printf '%s' "$arduino_json" | jq -r '.connected // false' 2>/dev/null || printf 'false')"
        report+="[OK] Arduino API erreichbar (connected=${arduino_connected})\n"
      else
        report+="[OK] Arduino API erreichbar\n"
      fi
    else
      report+="[WARN] Arduino API nicht erreichbar\n"
    fi
  else
    report+="[WARN] curl fehlt, API-Checks wurden uebersprungen\n"
  fi

  if [[ "$fire_enabled" == "true" ]]; then
    report+="\nFire-TV / ADB Check\n"
    if command_exists ping; then
      if ping -c 1 -W 1 "$fire_ip" >/dev/null 2>&1; then
        report+="[OK] Fire TV per ping erreichbar (${fire_ip})\n"
      else
        report+="[WARN] Fire TV per ping nicht erreichbar (${fire_ip})\n"
      fi
    else
      report+="[WARN] ping nicht verfuegbar\n"
    fi

    if command_exists adb; then
      if adb connect "${fire_ip}:5555" >/dev/null 2>&1; then
        report+="[OK] ADB Verbindung moeglich (${fire_ip}:5555)\n"
      else
        report+="[WARN] ADB Verbindung fehlgeschlagen (${fire_ip}:5555)\n"
      fi
    else
      report+="[WARN] adb nicht im PATH (hostseitiger Test uebersprungen)\n"
    fi
  else
    report+="\n[HINWEIS] FIRE_FEATURES_ENABLED=false, Fire-TV Checks uebersprungen\n"
  fi

  show_textbox "Health-Check" "$(printf '%b' "$report")"
}

run_guided_tests() {
  local api_base=""
  local public_port=""
  local report=""

  public_port="$(get_env_value PUBLIC_PORT 3100)"
  api_base="http://localhost:${public_port}"

  report+="Gefuehrte Funktionstests\n\n"
  report+="Schritt 1: Docker/Compose Verfuegbarkeit\n"
  if command_exists docker && detect_compose_cmd >/dev/null 2>&1; then
    report+="[OK] Docker + Compose sind verfuegbar\n"
  else
    report+="[FEHLT] Docker oder Compose fehlt\n"
    report+="       -> Menue: Systemcheck + Auto-Installation\n"
  fi

  report+="\nSchritt 2: Containerstatus\n"
  if command_exists docker; then
    if docker ps --format '{{.Names}}' | grep -q '^dart-dashboard$'; then
      report+="[OK] Container dart-dashboard laeuft\n"
    else
      report+="[WARN] Container laeuft nicht\n"
      report+="      -> Menue: Install/Update + Build + Start\n"
    fi
  else
    report+="[SKIP] Docker nicht verfuegbar\n"
  fi

  report+="\nSchritt 3: API-Tests (${api_base})\n"
  if command_exists curl; then
    curl -fsS --max-time 4 "${api_base}/api/live/state" >/dev/null 2>&1 && report+="[OK] /api/live/state\n" || report+="[FEHLT] /api/live/state\n"
    curl -fsS --max-time 4 "${api_base}/api/highscores" >/dev/null 2>&1 && report+="[OK] /api/highscores\n" || report+="[FEHLT] /api/highscores\n"
    curl -fsS --max-time 4 "${api_base}/api/storage/info" >/dev/null 2>&1 && report+="[OK] /api/storage/info\n" || report+="[FEHLT] /api/storage/info\n"
  else
    report+="[SKIP] curl nicht verfuegbar\n"
  fi

  report+="\nSchritt 4: Manuelle Browser-Pruefung\n"
  report+="  - Hub/Dienst im Browser oeffnen: http://<RASPI-IP>:${public_port}\n"
  report+="  - Live-Spielstand oeffnen und Punkte buchen\n"
  report+="  - Pruefen, ob Werte nach Reload erhalten bleiben\n"

  report+="\nSchritt 5: Optional Fire-TV\n"
  report+="  - Menue: Health-Checks ausfuehren\n"
  report+="  - Auf Warnungen bei Fire-TV/ADB achten\n"

  show_textbox "Gefuehrte Tests" "$(printf '%b' "$report")"
}
