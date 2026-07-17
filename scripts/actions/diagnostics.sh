#!/usr/bin/env bash

dashboard_api_base() {
  local public_port
  public_port="$(get_env_value PUBLIC_PORT 3100)"
  printf 'http://localhost:%s' "$public_port"
}

json_bool_field() {
  local json="$1" field="$2"
  printf '%s' "$json" | sed -n "s/.*\"${field}\"[[:space:]]*:[[:space:]]*\(true\|false\).*/\1/p" | head -n 1
}

json_string_field() {
  local json="$1" field="$2"
  printf '%s' "$json" | sed -n "s/.*\"${field}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -n 1
}

json_number_field() {
  local json="$1" field="$2"
  printf '%s' "$json" | sed -n "s/.*\"${field}\"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p" | head -n 1
}

json_path_field() {
  local json="$1" path="$2"
  node -e '
    const data = JSON.parse(process.argv[1]);
    const path = process.argv[2].split(".");
    let value = data;
    for (const key of path) {
      if (value == null || !Object.prototype.hasOwnProperty.call(value, key)) { value = undefined; break; }
      value = value[key];
    }
    if (value === undefined || value === null) process.exit(0);
    if (typeof value === "object") process.stdout.write(JSON.stringify(value));
    else process.stdout.write(String(value));
  ' "$json" "$path" 2>/dev/null
}

prompt_arduino_port() {
  local current_port="$1" value=""
  if [[ "$USE_WHIPTAIL" -eq 1 ]]; then
    value="$(whiptail --title "Arduino-Port" --inputbox "Optional manuellen Serial-Port angeben.\nLeer lassen = automatische Erkennung.\n\nBeispiele: /dev/ttyACM0 oder COM3" 13 82 "$current_port" 3>&1 1>&2 2>&3)" || return 1
  else
    printf '\nArduino-Port manuell setzen? Leer lassen fuer automatische Erkennung.\n'
    read -r -p 'Serial-Port: ' value
  fi
  printf '%s' "$value"
}

show_arduino_status() {
  local state_json report="" connected enabled port baud error active_count last_line

  if ! command_exists curl; then
    show_textbox "Arduino-Status" "curl fehlt. Arduino-Status kann nicht abgefragt werden."
    return 1
  fi

  state_json="$(curl -fsS --max-time 4 "$(dashboard_api_base)/api/arduino/state" 2>/dev/null || true)"
  if [[ -z "$state_json" ]]; then
    show_textbox "Arduino-Status" "Arduino-Status nicht erreichbar.\nPruefe, ob der Dienst laeuft."
    return 1
  fi

  connected="$(json_path_field "$state_json" connection.connected)"
  enabled="$(json_path_field "$state_json" connection.enabled)"
  port="$(json_path_field "$state_json" connection.port)"
  baud="$(json_path_field "$state_json" connection.baudRate)"
  error="$(json_path_field "$state_json" connection.error)"
  active_count="$(json_path_field "$state_json" telemetry.activeCount)"
  last_line="$(json_path_field "$state_json" latest.line)"

  [[ -z "$enabled" ]] && enabled='false'
  [[ -z "$connected" ]] && connected='false'
  [[ -z "$port" ]] && port='auto / nicht erkannt'
  [[ -z "$baud" ]] && baud='115200'
  [[ -z "$active_count" ]] && active_count='0'
  [[ -z "$last_line" ]] && last_line='keine Daten'
  [[ -z "$error" ]] && error='kein Fehler'

  report+="Arduino-Status\n\n"
  report+="Monitor aktiv: ${enabled}\n"
  report+="Verbunden: ${connected}\n"
  report+="Port: ${port}\n"
  report+="Baudrate: ${baud}\n"
  report+="Aktive Kontakte: ${active_count}\n"
  report+="Letzte Zeile: ${last_line}\n"
  report+="Fehler: ${error}\n"
  show_textbox "Arduino-Status" "$(printf '%b' "$report")"
}

connect_arduino_monitor() {
  local api_base port payload
  api_base="$(dashboard_api_base)"

  if ! command_exists curl; then
    msg_fail 'curl fehlt.'; return 1
  fi

  port="$(prompt_arduino_port "$(curl -fsS --max-time 2 "${api_base}/api/settings" 2>/dev/null | sed -n 's/.*"arduinoPort"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')")"
  payload="$(curl -sS --max-time 5 -X POST "${api_base}/api/arduino/connect" -H 'Content-Type: application/json' -d "{\"port\":\"${port}\"}" 2>/dev/null || true)"

  if echo "$payload" | grep -q '"ok":true'; then
    msg_ok 'Arduino-Monitor verbunden.'
  else
    msg_warn 'Verbindung moeglicherweise fehlgeschlagen.'
    msg_info "Antwort: ${payload}"
  fi
}

disconnect_arduino_monitor() {
  local api_base payload
  api_base="$(dashboard_api_base)"

  if ! command_exists curl; then
    msg_fail 'curl fehlt.'; return 1
  fi

  payload="$(curl -sS --max-time 5 -X POST "${api_base}/api/arduino/disconnect" -H 'Content-Type: application/json' 2>/dev/null || true)"

  if echo "$payload" | grep -q '"ok":true'; then
    msg_ok 'Arduino-Monitor getrennt.'
  else
    msg_warn 'Trennen fehlgeschlagen.'
  fi
}

run_health_checks() {
  local api_base port report="" api_ok=false storage_ok=false arduino_ok=false
  port="$(get_env_value PUBLIC_PORT 3100)"
  api_base="http://localhost:${port}"

  if ! command_exists curl; then
    show_textbox "Health-Check" "curl nicht gefunden."
    return 1
  fi

  report+="=== Loewen Dart Dashboard - Health-Check ===\n\n"

  # API live/state
  if curl -fsS --max-time 3 "${api_base}/api/live/state" >/dev/null 2>&1; then
    report+="[OK] Live-State API erreichbar\n"
    api_ok=true
  else
    report+="[FAIL] Live-State API nicht erreichbar\n"
  fi

  # Storage
  local storage_info
  storage_info="$(curl -fsS --max-time 3 "${api_base}/api/storage/info" 2>/dev/null || true)"
  if [[ -n "$storage_info" ]]; then
    local client; client="$(printf '%s' "$storage_info" | sed -n 's/.*"client"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
    report+="[OK] Storage (${client})\n"
    storage_ok=true
  else
    report+="[FAIL] Storage nicht erreichbar\n"
  fi

  # Arduino
  local arduino_info
  arduino_info="$(curl -fsS --max-time 3 "${api_base}/api/arduino/state" 2>/dev/null || true)"
  if [[ -n "$arduino_info" ]]; then
    local connected; connected="$(json_path_field "$arduino_info" connection.connected)"
    if [[ "$connected" == "true" ]]; then
      report+="[OK] Arduino verbunden\n"
    else
      report+="[INFO] Arduino nicht verbunden (normal, wenn kein Arduino angeschlossen)\n"
    fi
    arduino_ok=true
  else
    report+="[FAIL] Arduino-Status nicht erreichbar\n"
  fi

  # Docker
  if command_exists docker; then
    local container_state
    container_state="$(docker inspect -f '{{.State.Status}}' dart-dashboard 2>/dev/null || echo 'nicht gefunden')"
    report+="\nDocker Container 'dart-dashboard': ${container_state}\n"
  fi

  # Highscores
  if curl -fsS --max-time 3 "${api_base}/api/highscores" >/dev/null 2>&1; then
    report+="[OK] Highscores-API erreichbar\n"
  else
    report+="[FAIL] Highscores-API nicht erreichbar\n"
  fi

  report+="\n--- Zusammenfassung ---\n"
  $api_ok && report+="Dashboard: OK\n" || report+="Dashboard: FEHLER\n"

  show_textbox "Health-Check" "$(printf '%b' "$report")"
}

run_guided_tests() {
  local api_base port report="" failures=0
  port="$(get_env_value PUBLIC_PORT 3100)"
  api_base="http://localhost:${port}"

  if ! command_exists curl; then
    show_textbox "Test" "curl nicht gefunden."; return 1
  fi

  report+="=== Gefuehrte Funktionstests ===\n\n"

  report+="Test 1/6: Live-State API\n"
  local state
  state="$(curl -fsS --max-time 3 "${api_base}/api/live/state" 2>/dev/null || true)"
  if [[ -n "$state" ]]; then
    local player_count
    player_count="$(printf '%s' "$state" | sed -n 's/.*"players"[[:space:]]*:\[\([^]]*\).*/\1/p' | grep -o '"name"' | wc -l)"
    report+="  OK - ${player_count} Spieler geladen\n"
  else
    report+="  FAIL - Keine Antwort\n"; failures=$((failures + 1))
  fi

  report+="\nTest 2/6: Spieler-API\n"
  local players
  players="$(curl -fsS --max-time 3 "${api_base}/api/players" 2>/dev/null || true)"
  if [[ -n "$players" ]]; then
    report+="  OK - Spieler geladen\n"
  else
    report+="  FAIL - Keine Antwort\n"; failures=$((failures + 1))
  fi

  report+="\nTest 3/6: Highscores-API\n"
  local highscores
  highscores="$(curl -fsS --max-time 3 "${api_base}/api/highscores" 2>/dev/null || true)"
  if [[ -n "$highscores" ]]; then
    report+="  OK - Highscores geladen\n"
  else
    report+="  FAIL - Keine Antwort\n"; failures=$((failures + 1))
  fi

  report+="\nTest 4/6: Storage-Info\n"
  if curl -fsS --max-time 3 "${api_base}/api/storage/info" >/dev/null 2>&1; then
    report+="  OK\n"
  else
    report+="  FAIL\n"; failures=$((failures + 1))
  fi

  report+="\nTest 5/6: Arduino-Status\n"
  local ard_state
  ard_state="$(curl -fsS --max-time 3 "${api_base}/api/arduino/state" 2>/dev/null || true)"
  if [[ -n "$ard_state" ]]; then
    report+="  OK - Arduino-Status erreichbar\n"
  else
    report+="  INFO - Arduino-Status nicht erreichbar (normal wenn kein Arduino dran)\n"
  fi

  report+="\nTest 6/6: Dashboard-Startseite\n"
  if curl -fsS --max-time 3 "${api_base}/" >/dev/null 2>&1; then
    report+="  OK - Startseite erreichbar\n"
  else
    report+="  FAIL\n"; failures=$((failures + 1))
  fi

  report+="\n--- Ergebnis ---\n"
  if [[ "$failures" -eq 0 ]]; then
    report+="Alle Tests bestanden!\n"
  else
    report+="${failures} Test(s) fehlgeschlagen.\n"
  fi

  show_textbox "Funktionstests" "$(printf '%b' "$report")"
}