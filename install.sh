#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

REPO_URL="https://github.com/ReXx09/dart-dashboard.git"
USE_WHIPTAIL=0
COMPOSE_BUILD_ARGS=()

get_env_value() {
  local key="$1"
  local default_value="${2:-}"

  if [[ -f .env ]]; then
    local line
    line="$(grep -E "^${key}=" .env | tail -n 1 || true)"
    if [[ -n "$line" ]]; then
      printf '%s' "${line#*=}"
      return 0
    fi
  fi

  printf '%s' "$default_value"
}

print_line() {
  printf '%s\n' "------------------------------------------------------------"
}

print_header() {
  clear || true
  print_line
  printf ' Loewen Dart Dashboard - Setup Assistent\n'
  print_line
  printf ' Dieses Skript fuehrt durch Install/Update/Start auf dem Raspi.\n\n'
}

ask_yes_no() {
  local prompt="$1"
  local default="${2:-y}"
  local answer

  if [[ "$USE_WHIPTAIL" -eq 1 ]]; then
    if [[ "$default" == "y" ]]; then
      whiptail --title "Bestaetigung" --yesno "$prompt" 10 72
      return $?
    fi

    whiptail --title "Bestaetigung" --defaultno --yesno "$prompt" 10 72
    return $?
  fi

  if [[ "$default" == "y" ]]; then
    read -r -p "$prompt [Y/n]: " answer
    answer="${answer:-Y}"
  else
    read -r -p "$prompt [y/N]: " answer
    answer="${answer:-N}"
  fi

  [[ "$answer" =~ ^[Yy]$ ]]
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

detect_ui_mode() {
  if command_exists whiptail && [[ -t 0 ]] && [[ -t 1 ]]; then
    USE_WHIPTAIL=1
  else
    USE_WHIPTAIL=0
  fi
}

ui_pause() {
  if [[ "$USE_WHIPTAIL" -eq 1 ]]; then
    whiptail --title "Weiter" --msgbox "Aktion abgeschlossen. Weiter mit OK." 9 60
  else
    printf '\n'
    read -r -p 'Enter druecken fuer Hauptmenue...' _
  fi
}

detect_compose_cmd() {
  if command_exists docker && docker compose version >/dev/null 2>&1; then
    echo "docker compose"
    return 0
  fi

  if command_exists docker-compose; then
    echo "docker-compose"
    return 0
  fi

  return 1
}

init_compose_build_args() {
  COMPOSE_BUILD_ARGS=()
  if [[ -f docker-compose.yml && -f docker-compose.build.yml ]]; then
    COMPOSE_BUILD_ARGS=(-f docker-compose.yml -f docker-compose.build.yml)
  fi
}

ensure_sudo() {
  if ! command_exists sudo; then
    printf 'Fehler: sudo wurde nicht gefunden.\n'
    exit 1
  fi
}

set_or_replace_env() {
  local key="$1"
  local value="$2"

  if grep -q "^${key}=" .env; then
    sed -i "s|^${key}=.*|${key}=${value}|" .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}

write_raspi_env_defaults() {
  local host_ip
  host_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"

  cat > .env <<EOF
SERVER_IP=${host_ip}
FIRESTICK_IP=192.168.8.177
DATA_PATH=./data
ADB_KEYS_PATH=./adb-keys
PUBLIC_PORT=3100
EOF
}

normalize_env_for_raspi() {
  if [[ ! -f .env ]]; then
    return 0
  fi

  local needs_fix=0
  if grep -q '^DATA_PATH=/mnt/user/' .env; then
    needs_fix=1
  fi
  if grep -q '^ADB_KEYS_PATH=/mnt/user/' .env; then
    needs_fix=1
  fi

  if [[ "$needs_fix" -eq 1 ]]; then
    if ask_yes_no 'Unraid-Pfade in .env erkannt. Fuer Raspberry auf lokale Pfade umstellen?' 'y'; then
      set_or_replace_env "DATA_PATH" "./data"
      set_or_replace_env "ADB_KEYS_PATH" "./adb-keys"
      printf '.env wurde auf Raspberry-kompatible Pfade aktualisiert.\n'
    fi
  fi
}

show_textbox() {
  local title="$1"
  local text="$2"

  if [[ "$USE_WHIPTAIL" -eq 1 ]]; then
    local tmp_file
    tmp_file="$(mktemp)"
    printf '%s\n' "$text" > "$tmp_file"
    whiptail --title "$title" --scrolltext --textbox "$tmp_file" 24 90
    rm -f "$tmp_file"
  else
    printf '\n%s\n' "$title"
    print_line
    printf '%s\n' "$text"
  fi
}

build_requirements_report() {
  local report=""
  local missing_count=0

  report+="Setup-Pruefung fuer Raspberry Pi\n\n"

  if command_exists apt-get; then
    report+="[OK] apt-get verfuegbar\n"
  else
    report+="[WARN] apt-get fehlt (nicht Debian/Raspberry Pi OS?)\n"
  fi

  if command_exists docker; then
    report+="[OK] Docker installiert\n"
  else
    report+="[FEHLT] Docker\n"
    missing_count=$((missing_count + 1))
  fi

  if detect_compose_cmd >/dev/null 2>&1; then
    report+="[OK] Docker Compose verfuegbar\n"
  else
    report+="[FEHLT] Docker Compose\n"
    missing_count=$((missing_count + 1))
  fi

  if command_exists git; then
    report+="[OK] Git installiert\n"
  else
    report+="[FEHLT] Git\n"
    missing_count=$((missing_count + 1))
  fi

  if command_exists whiptail; then
    report+="[OK] whiptail installiert\n"
  else
    report+="[OPTIONAL] whiptail fehlt (Textmenue bleibt nutzbar)\n"
  fi

  if command_exists picocom; then
    report+="[OK] picocom installiert\n"
  else
    report+="[OPTIONAL] picocom fehlt (fuer Serial-Tests hilfreich)\n"
  fi

  if command_exists lsusb; then
    report+="[OK] usbutils/lsusb verfuegbar\n"
  else
    report+="[OPTIONAL] usbutils fehlt (USB-Diagnose eingeschraenkt)\n"
  fi

  if groups "$USER" | grep -Eq '(^|[[:space:]])docker($|[[:space:]])'; then
    report+="[OK] Benutzer in docker-Gruppe\n"
  else
    report+="[HINWEIS] Benutzer nicht in docker-Gruppe (evtl. sudo noetig)\n"
  fi

  report+="\nFehlende Kernkomponenten: ${missing_count}\n"
  printf '%b' "$report"
}

install_pi_tools_debian() {
  ensure_sudo
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl gnupg lsb-release git whiptail usbutils picocom jq
}

run_system_check_and_install() {
  local initial_report
  initial_report="$(build_requirements_report)"
  show_textbox "Systemcheck" "$initial_report"

  if ! ask_yes_no 'Fehlende Komponenten jetzt automatisch installieren/aktualisieren?' 'y'; then
    return
  fi

  if ! command_exists apt-get; then
    show_textbox "Hinweis" "Automatische Installation ist nur fuer Debian/Raspberry Pi OS ueber apt-get implementiert."
    return
  fi

  printf '\nInstalliere benoetigte Basis-Tools...\n'
  install_pi_tools_debian

  if ! command_exists docker || ! detect_compose_cmd >/dev/null 2>&1; then
    printf '\nInstalliere/aktualisiere Docker-Stack...\n'
    install_docker_stack_debian
  fi

  detect_ui_mode

  local final_report
  final_report="$(build_requirements_report)"
  show_textbox "Systemcheck nach Installation" "$final_report"
}

install_docker_stack_debian() {
  ensure_sudo
  printf '\nInstalliere Docker und Compose-Plugin (Debian/Raspberry Pi OS)...\n'
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl gnupg lsb-release git whiptail usbutils picocom jq

  if ! command_exists docker; then
    curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
    sudo sh /tmp/get-docker.sh
    rm -f /tmp/get-docker.sh
  fi

  sudo apt-get install -y docker-compose-plugin || true

  if groups "$USER" | grep -Eq '(^|[[:space:]])docker($|[[:space:]])'; then
    :
  else
    sudo usermod -aG docker "$USER" || true
    printf 'Hinweis: Benutzer wurde zur Gruppe docker hinzugefuegt.\n'
    printf 'Bitte danach einmal neu anmelden, falls Docker ohne sudo nicht geht.\n'
  fi
}

ensure_docker_ready() {
  local compose_cmd

  if ! command_exists docker; then
    printf 'Docker ist nicht installiert.\n'
    if ask_yes_no 'Soll Docker jetzt automatisch installiert werden?' 'y'; then
      install_docker_stack_debian
    else
      printf 'Abbruch: Docker wird benoetigt.\n'
      exit 1
    fi
  fi

  if ! compose_cmd="$(detect_compose_cmd)"; then
    printf 'Docker Compose wurde nicht gefunden.\n'
    if ask_yes_no 'Soll Docker Compose Plugin jetzt installiert werden?' 'y'; then
      install_docker_stack_debian
      compose_cmd="$(detect_compose_cmd || true)"
    fi
  fi

  if [[ -z "${compose_cmd:-}" ]]; then
    printf 'Abbruch: Docker Compose ist nicht verfuegbar.\n'
    exit 1
  fi

  COMPOSE_CMD="$compose_cmd"
}

ensure_env_file() {
  if [[ -f .env ]]; then
    normalize_env_for_raspi
    return 0
  fi

  write_raspi_env_defaults
  printf '.env wurde mit Raspberry-Standardwerten erstellt.\n'
}

show_network_hint() {
  local host_ip
  host_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  printf '\nAufruf im Browser:\n'
  if [[ -n "$host_ip" ]]; then
    printf '  http://%s:3100\n' "$host_ip"
  else
    printf '  http://<RASPI-IP>:3100\n'
  fi
}

git_update_if_possible() {
  if command_exists git && [[ -d .git ]]; then
    printf '\nHole neuesten Stand aus GitHub...\n'
    git pull --ff-only || printf 'Warnung: git pull fehlgeschlagen, fahre mit lokalem Stand fort.\n'
  fi
}

build_and_start() {
  ensure_docker_ready
  ensure_env_file
  git_update_if_possible
  init_compose_build_args

  printf '\nBaue Container mit aktuellem Code...\n'
  if [[ ${#COMPOSE_BUILD_ARGS[@]} -gt 0 ]]; then
    $COMPOSE_CMD "${COMPOSE_BUILD_ARGS[@]}" up -d --build
  else
    $COMPOSE_CMD build --no-cache
    printf '\nStarte Container...\n'
    $COMPOSE_CMD up -d
  fi

  printf '\nContainer Status:\n'
  $COMPOSE_CMD ps
  show_network_hint
}

start_existing() {
  ensure_docker_ready
  ensure_env_file

  printf '\nStarte vorhandene Container...\n'
  $COMPOSE_CMD up -d
  $COMPOSE_CMD ps
  show_network_hint
}

stop_stack() {
  ensure_docker_ready
  printf '\nStoppe Container...\n'
  $COMPOSE_CMD down
}

show_status() {
  ensure_docker_ready
  printf '\nStatus:\n'
  $COMPOSE_CMD ps

  printf '\nArduino Ports:\n'
  ls /dev/ttyACM* /dev/ttyUSB* 2>/dev/null || printf '  Keine ttyACM/ttyUSB Ports gefunden.\n'

  printf '\nLetzte Logs (dart-dashboard):\n'
  docker logs --tail 30 dart-dashboard 2>/dev/null || printf '  Keine Logs verfuegbar (Container noch nicht gestartet?).\n'

  show_network_hint
}

clone_repo_elsewhere() {
  if ! command_exists git; then
    printf 'Git ist nicht installiert.\n'
    if ask_yes_no 'Soll git jetzt installiert werden?' 'y'; then
      ensure_sudo
      sudo apt-get update
      sudo apt-get install -y git
    else
      return
    fi
  fi

  local target_dir
  if [[ "$USE_WHIPTAIL" -eq 1 ]]; then
    target_dir="$(whiptail --title "Repo klonen" --inputbox "Zielordner fuer den Clone:" 10 78 "$HOME/loewen-dart-dashboard" 3>&1 1>&2 2>&3)" || return
  else
    read -r -p 'Zielordner fuer den Clone [~/loewen-dart-dashboard]: ' target_dir
  fi
  target_dir="${target_dir:-$HOME/loewen-dart-dashboard}"

  if [[ -e "$target_dir" ]]; then
    printf 'Pfad existiert bereits: %s\n' "$target_dir"
    return
  fi

  printf 'Clone %s nach %s\n' "$REPO_URL" "$target_dir"
  git clone "$REPO_URL" "$target_dir"
  printf 'Fertig. Wechsle dann nach: %s/dart-dashboard\n' "$target_dir"
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
    if compose_output="$($compose_cmd ps 2>&1 || true)"; then
      if printf '%s' "$compose_output" | grep -q 'dart-dashboard'; then
        report+="[OK] Containerstatus abgefragt (dart-dashboard gefunden)\n"
      else
        report+="[WARN] Compose erreichbar, aber dart-dashboard nicht sichtbar\n"
      fi
    else
      report+="[WARN] Compose-Status konnte nicht abgefragt werden\n"
    fi
  else
    report+="[FEHLT] Docker Compose nicht verfuegbar\n"
  fi

  if command_exists curl; then
    local api_base
    api_base="http://localhost:${public_port}"

    if live_json="$(curl -fsS --max-time 4 "${api_base}/api/live/state" 2>/dev/null || true)"; then
      if [[ -n "$live_json" ]]; then
        report+="[OK] API live/state erreichbar (${api_base})\n"
      else
        report+="[WARN] API live/state liefert keine Daten (${api_base})\n"
      fi
    else
      report+="[FEHLT] API live/state nicht erreichbar (${api_base})\n"
    fi

    if storage_json="$(curl -fsS --max-time 4 "${api_base}/api/storage/info" 2>/dev/null || true)"; then
      if [[ -n "$storage_json" ]]; then
        if command_exists jq; then
          local db_client db_external
          db_client="$(printf '%s' "$storage_json" | jq -r '.client // "unknown"' 2>/dev/null || printf 'unknown')"
          db_external="$(printf '%s' "$storage_json" | jq -r '.external // false' 2>/dev/null || printf 'false')"
          report+="[OK] Storage API erreichbar (client=${db_client}, external=${db_external})\n"
        else
          report+="[OK] Storage API erreichbar\n"
        fi
      else
        report+="[WARN] Storage API liefert keine Daten\n"
      fi
    else
      report+="[FEHLT] Storage API nicht erreichbar\n"
    fi

    if arduino_json="$(curl -fsS --max-time 4 "${api_base}/api/arduino/state" 2>/dev/null || true)"; then
      if [[ -n "$arduino_json" ]]; then
        if command_exists jq; then
          local arduino_connected
          arduino_connected="$(printf '%s' "$arduino_json" | jq -r '.connected // false' 2>/dev/null || printf 'false')"
          report+="[OK] Arduino API erreichbar (connected=${arduino_connected})\n"
        else
          report+="[OK] Arduino API erreichbar\n"
        fi
      else
        report+="[WARN] Arduino API liefert keine Daten\n"
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

show_beginner_help() {
  local text=""
  text+="Einsteiger-Anleitung (empfohlene Reihenfolge)\n\n"
  text+="1) Schnellstart-Assistent ausfuehren\n"
  text+="   - Menuepunkt: Schnellstart-Assistent\n"
  text+="   - Dieser fuehrt Systemcheck, Installation und Start zusammen\n\n"
  text+="2) Health-Checks ausfuehren\n"
  text+="   - Prueft Docker, Container, APIs und optional Fire-TV\n\n"
  text+="3) Gefuehrte Funktionstests starten\n"
  text+="   - Testet die wichtigsten Endpunkte Schritt fuer Schritt\n\n"
  text+="4) Bei Fire-TV Problemen\n"
  text+="   - .env pruefen: FIRE_FEATURES_ENABLED=true\n"
  text+="   - FIRESTICK_IP kontrollieren\n"
  text+="   - Dann Health-Checks erneut laufen lassen\n\n"
  text+="Direkte Kommandos:\n"
  text+="  ./install.sh quickstart\n"
  text+="  ./install.sh health\n"
  text+="  ./install.sh test\n"
  show_textbox "Hilfe" "$(printf '%b' "$text")"
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
    if curl -fsS --max-time 4 "${api_base}/api/live/state" >/dev/null 2>&1; then
      report+="[OK] /api/live/state\n"
    else
      report+="[FEHLT] /api/live/state\n"
    fi

    if curl -fsS --max-time 4 "${api_base}/api/highscores" >/dev/null 2>&1; then
      report+="[OK] /api/highscores\n"
    else
      report+="[FEHLT] /api/highscores\n"
    fi

    if curl -fsS --max-time 4 "${api_base}/api/storage/info" >/dev/null 2>&1; then
      report+="[OK] /api/storage/info\n"
    else
      report+="[FEHLT] /api/storage/info\n"
    fi
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

run_quickstart_wizard() {
  local summary=""
  summary+="Schnellstart-Assistent\n\n"
  summary+="Es werden nacheinander ausgefuehrt:\n"
  summary+="1) Systemcheck + Auto-Installation\n"
  summary+="2) Install/Update + Build + Start\n"
  summary+="3) Health-Checks\n"
  summary+="4) Gefuehrte Funktionstests (Auswertung)\n\n"
  summary+="Dauer: je nach Internet/Hardware mehrere Minuten."

  show_textbox "Schnellstart" "$(printf '%b' "$summary")"
  if ! ask_yes_no 'Schnellstart jetzt ausfuehren?' 'y'; then
    return
  fi

  run_system_check_and_install
  build_and_start
  run_health_checks

  if ask_yes_no 'Zum Abschluss die gefuehrten Funktionstests anzeigen?' 'y'; then
    run_guided_tests
  fi
}

run_choice() {
  local choice="$1"
  case "$choice" in
    0) run_quickstart_wizard ;;
    1) run_system_check_and_install ;;
    2) build_and_start ;;
    3) start_existing ;;
    4) run_health_checks ;;
    5) run_guided_tests ;;
    6) show_status ;;
    7) stop_stack ;;
    8) clone_repo_elsewhere ;;
    9) show_beginner_help ;;
    *)
      printf 'Ungueltige Auswahl.\n'
      return 1
      ;;
  esac
}

usage() {
  cat <<'EOF'
Verwendung:
  ./install.sh <action>

Actions:
  menu          Startet das eigenstaendige Menue (menu.sh)
  quickstart    Komplettassistent (Pruefen + Einrichten + Start + Tests)
  check         Systemcheck + Auto-Installation
  build-start   Install/Update + Build + Start
  start         Nur Start (ohne Build)
  health        Health-Checks (API/Storage/Arduino/Fire-TV)
  test          Gefuehrte Funktionstests (Schritt fuer Schritt)
  status        Status und Logs anzeigen
  stop          Container stoppen
  clone         Repo in anderen Ordner klonen
  help-guide    Einsteiger-Hilfe anzeigen

Wenn kein Action-Parameter gesetzt ist, wird automatisch menu.sh gestartet.
EOF
}

action_to_choice() {
  local action="$1"
  case "$action" in
    quickstart) echo 0 ;;
    check) echo 0 ;;
    build-start) echo 2 ;;
    start) echo 3 ;;
    health) echo 4 ;;
    test) echo 5 ;;
    status) echo 6 ;;
    stop) echo 7 ;;
    clone) echo 8 ;;
    help-guide) echo 9 ;;
    *) return 1 ;;
  esac
}

run_action_by_name() {
  local action="$1"

  case "$action" in
    check)
      run_system_check_and_install
      ;;
    *)
      local choice
      choice="$(action_to_choice "$action")"
      run_choice "$choice"
      ;;
  esac
}

if [[ ! -f docker-compose.yml ]]; then
  printf 'Hinweis: docker-compose.yml nicht im aktuellen Ordner gefunden.\n'
  printf 'Bitte dieses Skript im dart-dashboard Ordner ausfuehren.\n'
fi

detect_ui_mode

if [[ $# -eq 0 || "${1:-}" == "menu" ]]; then
  if [[ -x "$SCRIPT_DIR/menu.sh" ]]; then
    exec "$SCRIPT_DIR/menu.sh"
  fi

  printf 'Fehler: menu.sh nicht gefunden oder nicht ausfuehrbar.\n'
  usage
  exit 1
fi

case "${1:-}" in
  quickstart|check|build-start|start|status|stop|clone|health|test|help-guide)
    run_action_by_name "$1"
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    printf 'Unbekannte Action: %s\n\n' "$1"
    usage
    exit 1
    ;;
esac
