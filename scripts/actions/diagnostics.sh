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
  if command_exists python3; then
    printf '%s' "$json" | python3 -c '
import json, sys
value = json.load(sys.stdin)
for key in sys.argv[1].split("."):
    value = value.get(key) if isinstance(value, dict) else None
if value is not None:
    print(json.dumps(value, separators=(",", ":")) if isinstance(value, (dict, list)) else str(value).lower() if isinstance(value, bool) else str(value))
' "$path"
  elif command_exists node; then
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
  else
    msg_fail 'Python 3 oder Node.js wird zum Auslesen der Statusdaten benoetigt.'
    return 1
  fi
}

show_setup_overview() {
  local report="" branch commit dirty_count app_version dev_branch
  local os_name model kernel uptime temp memory disk
  local docker_cmd="" docker_version="nicht verfuegbar" compose_version="nicht verfuegbar"
  local container_state="nicht gefunden" container_image="" container_app_version="nicht verfuegbar" container_node_version="nicht verfuegbar"
  local api_base public_port firetv_port api_info firetv_ok=false db_info db_ok=false
  local arduino_info arduino_connected arduino_enabled arduino_port arduino_firmware arduino_device
  local auth_info auth_configured auth_enabled

  branch="$(git -C "$SCRIPT_DIR" branch --show-current 2>/dev/null || true)"
  [[ -z "$branch" ]] && branch='detached / unbekannt'
  commit="$(git -C "$SCRIPT_DIR" rev-parse --short HEAD 2>/dev/null || printf 'unbekannt')"
  dirty_count="$(git -C "$SCRIPT_DIR" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  app_version="$(sed -n 's/.*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$SCRIPT_DIR/package.json" | head -n 1)"
  [[ -z "$app_version" ]] && app_version='unbekannt'
  dev_branch="${DART_DEV_BRANCH:-refactor-central-data}"

  os_name="$(sed -n 's/^PRETTY_NAME=//p' /etc/os-release 2>/dev/null | head -n 1 | tr -d '"')"
  [[ -z "$os_name" ]] && os_name="$(uname -s 2>/dev/null || printf 'unbekannt')"
  model=''
  if [[ -r /proc/device-tree/model ]]; then model="$(tr -d '\0' < /proc/device-tree/model 2>/dev/null || true)"; fi
  [[ -z "$model" ]] && model='Raspberry-Pi-Modell nicht erkannt'
  kernel="$(uname -r 2>/dev/null || printf 'unbekannt')"
  uptime="$(uptime -p 2>/dev/null || true)"
  [[ -z "$uptime" ]] && uptime='nicht verfuegbar'
  temp=''
  if [[ -r /sys/class/thermal/thermal_zone0/temp ]]; then
    temp="$(awk '{printf "%.1f °C", $1 / 1000}' /sys/class/thermal/thermal_zone0/temp 2>/dev/null || true)"
  fi
  [[ -z "$temp" ]] && temp='nicht verfuegbar'
  memory="$(awk '/MemTotal:/ {total=int($2/1024)} /MemAvailable:/ {available=int($2/1024)} END {if (total) printf "%d MiB gesamt, %d MiB verfuegbar", total, available}' /proc/meminfo 2>/dev/null)"
  [[ -z "$memory" ]] && memory='nicht verfuegbar'
  disk="$(df -hP "$SCRIPT_DIR" 2>/dev/null | awk 'NR == 2 {printf "%s frei, %s belegt", $4, $5}')"
  [[ -z "$disk" ]] && disk='nicht verfuegbar'

  if command_exists docker; then
    if docker info >/dev/null 2>&1; then
      docker_cmd='docker'
    elif command_exists sudo && sudo -n docker info >/dev/null 2>&1; then
      docker_cmd='sudo docker'
    fi
  fi
  if [[ -n "$docker_cmd" ]]; then
    docker_version="$($docker_cmd version --format '{{.Server.Version}}' 2>/dev/null || printf 'nicht verfuegbar')"
    if detect_compose_cmd; then
      compose_version="$($COMPOSE_CMD version --short 2>/dev/null || $COMPOSE_CMD version 2>/dev/null | head -n 1 || printf 'nicht verfuegbar')"
    fi
    container_state="$($docker_cmd inspect -f '{{.State.Status}}' dart-dashboard 2>/dev/null || printf 'nicht gefunden')"
    container_image="$($docker_cmd inspect -f '{{.Config.Image}}' dart-dashboard 2>/dev/null || true)"
    if [[ "$container_state" == 'running' ]]; then
      container_app_version="$($docker_cmd exec dart-dashboard node -p "require('./package.json').version" 2>/dev/null || printf 'nicht verfuegbar')"
      container_node_version="$($docker_cmd exec dart-dashboard node --version 2>/dev/null || printf 'nicht verfuegbar')"
    fi
  fi

  public_port="$(get_env_value PUBLIC_PORT 3100)"
  firetv_port="$(get_env_value FIRETV_PORT 3200)"
  api_base="http://localhost:${public_port}"
  api_info="$(curl -fsS --max-time 3 "${api_base}/api/server-info" 2>/dev/null || true)"
  firetv_ok=false
  if curl -fsS --max-time 3 "http://localhost:${firetv_port}/panels/firetv-dashboard.html" >/dev/null 2>&1; then firetv_ok=true; fi
  db_info="$(curl -fsS --max-time 3 "${api_base}/api/storage/status" 2>/dev/null || true)"
  db_ok=false
  if [[ -n "$db_info" ]]; then db_ok=true; fi

  arduino_info="$(curl -fsS --max-time 3 "${api_base}/api/arduino/state" 2>/dev/null || true)"
  arduino_connected="$(json_path_field "$arduino_info" connection.connected 2>/dev/null || true)"
  arduino_enabled="$(json_path_field "$arduino_info" connection.enabled 2>/dev/null || true)"
  arduino_port="$(json_path_field "$arduino_info" connection.port 2>/dev/null || true)"
  arduino_firmware="$(json_path_field "$arduino_info" latest.firmware.name 2>/dev/null || true)"
  arduino_device="$(get_env_value ARDUINO_DEVICE)"

  auth_info="$(curl -fsS --max-time 3 "${api_base}/api/admin/auth/status" 2>/dev/null || true)"
  auth_configured="$(json_path_field "$auth_info" configured 2>/dev/null || true)"
  auth_enabled="$(json_path_field "$auth_info" enabled 2>/dev/null || true)"

  report+="=== EINRICHTUNGS-STATUS ===\n\n"
  report+="VERSION & GIT\n"
  report+="Branch: ${branch}  |  Commit: ${commit}\n"
  report+="Arbeitskopie: $([[ "${dirty_count:-0}" =~ ^[0-9]+$ ]] && (( dirty_count > 0 )) && printf '%s lokale Aenderung(en)' "$dirty_count" || printf 'sauber')\n"
  report+="Dev-Update-Ziel: ${dev_branch}\n"
  report+="Dashboard-Version (Quellcode): ${app_version}\n"
  report+="Dashboard-Version (Container): ${container_app_version}\n"
  report+="Node.js im Container: ${container_node_version}\n\n"

  report+="RASPBERRY PI / HOST\n"
  report+="Modell: ${model}\n"
  report+="Betriebssystem: ${os_name}\n"
  report+="Kernel: ${kernel}\n"
  report+="Laufzeit: ${uptime}  |  Temperatur: ${temp}\n"
  report+="Arbeitsspeicher: ${memory}\n"
  report+="Speicherplatz: ${disk}\n\n"

  report+="DIENSTE & GERAETE\n"
  if [[ -n "$docker_cmd" ]]; then
    report+="[OK] Docker Engine ${docker_version}  |  Compose ${compose_version}\n"
  elif command_exists docker; then
    report+="[FEHLER] Docker nicht erreichbar (Dienst/Berechtigung pruefen)\n"
  else
    report+="[FEHLER] Docker ist nicht installiert\n"
  fi
  case "$container_state" in
    running) report+="[OK] Dashboard-Container laeuft (${container_image:-Image unbekannt})\n" ;;
    *) report+="[FEHLER] Dashboard-Container: ${container_state}\n" ;;
  esac
  if [[ -n "$api_info" ]]; then
    report+="[OK] Dashboard-API erreichbar auf Port ${public_port}\n"
  else
    report+="[FEHLER] Dashboard-API nicht erreichbar auf Port ${public_port}\n"
  fi
  if $firetv_ok; then
    report+="[OK] Fire-TV-Ansicht erreichbar auf Port ${firetv_port}\n"
  else
    report+="[FEHLER] Fire-TV-Ansicht nicht erreichbar auf Port ${firetv_port}\n"
  fi
  if $db_ok; then
    report+="[OK] Datenbank: $(json_path_field "$db_info" client 2>/dev/null || printf 'Typ unbekannt')\n"
  else
    report+="[FEHLER] Datenbankstatus nicht erreichbar\n"
  fi
  if [[ "$auth_configured" == 'true' && "$auth_enabled" == 'true' ]]; then
    report+="[OK] Admin-PIN eingerichtet und Anmeldung aktiv\n"
  elif [[ "$auth_configured" == 'true' ]]; then
    report+="[WARN] Admin-PIN vorhanden, Anmeldung aber deaktiviert\n"
  elif [[ -n "$auth_info" ]]; then
    report+="[FEHLER] Admin-PIN nicht eingerichtet\n"
  else
    report+="[FEHLER] Authentifizierungsstatus nicht erreichbar\n"
  fi
  if [[ "$arduino_connected" == 'true' ]]; then
    report+="[OK] Arduino verbunden: ${arduino_port:-Port unbekannt}\n"
    report+="Firmware: ${arduino_firmware:-noch nicht erkannt}\n"
  elif [[ -n "$arduino_device" ]]; then
    report+="[FEHLER] Arduino konfiguriert, aber nicht verbunden: ${arduino_device}\n"
  elif [[ -n "$arduino_info" ]]; then
    report+="[INFO] Kein Arduino konfiguriert (Dashboard bleibt nutzbar)\n"
  else
    report+="[FEHLER] Arduino-Status nicht erreichbar\n"
  fi

  show_textbox "Einrichtungsstatus & Versionen" "$(printf '%b' "$report")"
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
  local api_base port firetv_port report="" api_ok=false storage_ok=false highscores_ok=false firetv_ok=false arduino_ok=true
  port="$(get_env_value PUBLIC_PORT 3100)"
  firetv_port="$(get_env_value FIRETV_PORT 3200)"
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
  local arduino_info arduino_device
  arduino_device="$(get_env_value ARDUINO_DEVICE)"
  arduino_info="$(curl -fsS --max-time 3 "${api_base}/api/arduino/state" 2>/dev/null || true)"
  if [[ -n "$arduino_info" ]]; then
    local connected; connected="$(json_path_field "$arduino_info" connection.connected)"
    if [[ "$connected" == "true" ]]; then
      report+="[OK] Arduino verbunden\n"
    elif [[ -n "$arduino_device" ]]; then
      report+="[FAIL] Konfiguriertes Arduino-Geraet nicht verbunden (${arduino_device})\n"
      arduino_ok=false
    else
      report+="[INFO] Arduino nicht verbunden (normal, wenn kein Arduino angeschlossen)\n"
    fi
  elif [[ -n "$arduino_device" ]]; then
    report+="[FAIL] Arduino-Status nicht erreichbar, obwohl ein Geraet konfiguriert ist\n"
    arduino_ok=false
  else
    report+="[INFO] Arduino-Status nicht erreichbar (Installation ohne Arduino)\n"
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
    highscores_ok=true
  else
    report+="[FAIL] Highscores-API nicht erreichbar\n"
  fi

  if curl -fsS --max-time 3 "http://localhost:${firetv_port}/panels/firetv-dashboard.html" >/dev/null 2>&1; then
    report+="[OK] Fire-TV-Ansicht erreichbar (Port ${firetv_port})\n"
    firetv_ok=true
  else
    report+="[FAIL] Fire-TV-Ansicht nicht erreichbar (Port ${firetv_port})\n"
  fi

  report+="\n--- Zusammenfassung ---\n"
  $api_ok && report+="Dashboard: OK\n" || report+="Dashboard: FEHLER\n"
  $storage_ok && report+="Storage: OK\n" || report+="Storage: FEHLER\n"
  $highscores_ok && report+="Highscores: OK\n" || report+="Highscores: FEHLER\n"
  $firetv_ok && report+="Fire TV: OK\n" || report+="Fire TV: FEHLER\n"
  $arduino_ok && report+="Arduino: OK oder optional\n" || report+="Arduino: FEHLER\n"

  show_textbox "Health-Check" "$(printf '%b' "$report")"
  if $api_ok && $storage_ok && $highscores_ok && $firetv_ok && $arduino_ok; then return 0; fi
  return 1
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
    player_count="$(printf '%s' "$state" | grep -o '"name"[[:space:]]*:' | wc -l || true)"
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
  [[ "$failures" -eq 0 ]]
}