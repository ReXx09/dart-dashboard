#!/usr/bin/env bash

dashboard_api_base() {
  local public_port=""
  public_port="$(get_env_value PUBLIC_PORT 3100)"
  printf 'http://localhost:%s' "$public_port"
}

json_bool_field() {
  local json="$1"
  local field="$2"
  printf '%s' "$json" | sed -n "s/.*\"${field}\"[[:space:]]*:[[:space:]]*\(true\|false\).*/\1/p" | head -n 1
}

json_string_field() {
  local json="$1"
  local field="$2"
  printf '%s' "$json" | sed -n "s/.*\"${field}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -n 1
}

json_number_field() {
  local json="$1"
  local field="$2"
  printf '%s' "$json" | sed -n "s/.*\"${field}\"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p" | head -n 1
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

get_arduino_state_json() {
  local api_base=""
  api_base="$(dashboard_api_base)"
  curl -fsS --max-time 4 "${api_base}/api/arduino/state" 2>/dev/null || true
}

prompt_arduino_port() {
  local current_port="$1"
  local value=""

  if [[ "$USE_WHIPTAIL" -eq 1 ]]; then
    value="$(whiptail --title "Arduino-Port" --inputbox "Optional manuellen Serial-Port angeben.\nLeer lassen = automatische Erkennung.\n\nBeispiele: /dev/ttyACM0 oder COM3" 13 78 "$current_port" 3>&1 1>&2 2>&3)" || return 1
  else
    printf '\nArduino-Port manuell setzen? Leer lassen fuer automatische Erkennung.\n'
    read -r -p 'Serial-Port: ' value
  fi

  printf '%s' "$value"
}

show_arduino_status() {
  local state_json=""
  local report=""
  local connected enabled port baud error active_count last_line

  if ! command_exists curl; then
    show_textbox "Arduino-Status" "curl fehlt. Arduino-Status kann lokal nicht abgefragt werden."
    return 1
  fi

  state_json="$(get_arduino_state_json)"
  if [[ -z "$state_json" ]]; then
    show_textbox "Arduino-Status" "Arduino-Status konnte nicht abgefragt werden.\n\nPruefe, ob der Dienst laeuft und die API erreichbar ist."
    return 1
  fi

  connected="$(json_bool_field "$state_json" connected)"
  enabled="$(json_bool_field "$state_json" enabled)"
  port="$(json_string_field "$state_json" port)"
  baud="$(json_number_field "$state_json" baudRate)"
  error="$(json_string_field "$state_json" error)"
  active_count="$(json_number_field "$state_json" activeCount)"
  last_line="$(json_string_field "$state_json" lastLine)"

  [[ -z "$enabled" ]] && enabled='false'
  [[ -z "$connected" ]] && connected='false'
  [[ -z "$port" ]] && port='auto / nicht erkannt'
  [[ -z "$baud" ]] && baud='115200'
  [[ -z "$active_count" ]] && active_count='0'
  [[ -z "$last_line" ]] && last_line='keine Daten'
  [[ -z "$error" ]] && error='kein Fehler gemeldet'

  report+="Arduino-Status\n\n"
  report+="Monitor aktiv: ${enabled}\n"
  report+="Verbunden: ${connected}\n"
  report+="Port: ${port}\n"
  report+="Baudrate: ${baud}\n"
  report+="Aktive Kontakte: ${active_count}\n"
  report+="Letzte Zeile: ${last_line}\n"
  report+="Fehler: ${error}\n\n"
  report+="Hinweis:\n"
  report+="- Verbinden/Neu verbinden startet den Arduino-Monitor neu.\n"
  report+="- Port leer = automatische Erkennung des ersten passenden Serial-Ports.\n"

  show_textbox "Arduino-Status" "$(printf '%b' "$report")"
}

connect_arduino_monitor() {
  local api_base=""
  local state_json=""
  local current_port=""
  local selected_port=""
  local payload=""
  local response=""

  if ! command_exists curl; then
    printf 'curl fehlt. Arduino-Monitor kann nicht ueber die API gesteuert werden.\n'
    return 1
  fi

  api_base="$(dashboard_api_base)"
  state_json="$(get_arduino_state_json)"
  current_port="$(json_string_field "$state_json" port)"

  if ask_yes_no 'Manuellen Serial-Port setzen? (Nein = automatische Erkennung)' 'n'; then
    selected_port="$(prompt_arduino_port "$current_port")" || return 1
  fi

  payload=$(printf '{"port":"%s"}' "$(json_escape "$selected_port")")
  response="$(curl -fsS --max-time 6 -X POST "${api_base}/api/arduino/connect" -H "Content-Type: application/json" --data "$payload" 2>&1)" || {
    printf 'Arduino-Monitor konnte nicht gestartet werden.\n%s\n' "$response"
    return 1
  }

  show_arduino_status
}

disconnect_arduino_monitor() {
  local api_base=""
  local response=""

  if ! command_exists curl; then
    printf 'curl fehlt. Arduino-Monitor kann nicht ueber die API gesteuert werden.\n'
    return 1
  fi

  api_base="$(dashboard_api_base)"
  response="$(curl -fsS --max-time 6 -X POST "${api_base}/api/arduino/disconnect" -H "Content-Type: application/json" --data '{}' 2>&1)" || {
    printf 'Arduino-Monitor konnte nicht gestoppt werden.\n%s\n' "$response"
    return 1
  }

  show_arduino_status
}

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
