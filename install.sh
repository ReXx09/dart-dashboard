#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

REPO_URL="https://github.com/ReXx09/dart-dashboard.git"
USE_WHIPTAIL=0
COMPOSE_BUILD_ARGS=()

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

run_choice() {
  local choice="$1"
  case "$choice" in
    0)
      run_system_check_and_install
      ;;
    1)
      build_and_start
      ;;
    2)
      start_existing
      ;;
    3)
      show_status
      ;;
    4)
      stop_stack
      ;;
    5)
      clone_repo_elsewhere
      ;;
    6)
      printf 'Beendet.\n'
      exit 0
      ;;
    *)
      printf 'Ungueltige Auswahl.\n'
      ;;
  esac
}

main_menu_whiptail() {
  while true; do
    local choice
    choice="$(whiptail --title "Loewen Dart Dashboard - Setup" --menu "Bitte Option waehlen" 20 78 10 \
      "0" "Systemcheck + Auto-Installation (Docker/Pi-Tools)" \
      "1" "Install/Update + Build + Start (empfohlen)" \
      "2" "Nur Start (ohne Build)" \
      "3" "Status und Logs anzeigen" \
      "4" "Stoppen" \
      "5" "Repo in anderen Ordner klonen" \
      "6" "Beenden" \
      3>&1 1>&2 2>&3)" || exit 0

    run_choice "$choice"
    ui_pause
  done
}

main_menu() {
  if [[ "$USE_WHIPTAIL" -eq 1 ]]; then
    main_menu_whiptail
    return
  fi

  while true; do
    print_header
    printf 'Aktueller Ordner: %s\n\n' "$SCRIPT_DIR"
    printf '0) Systemcheck + Auto-Installation (Docker/Pi-Tools)\n'
    printf '1) Install/Update + Build + Start (empfohlen)\n'
    printf '2) Nur Start (ohne Build)\n'
    printf '3) Status und Logs anzeigen\n'
    printf '4) Stoppen\n'
    printf '5) Repo in anderen Ordner klonen\n'
    printf '6) Beenden\n\n'

    read -r -p 'Bitte Option waehlen [0-6]: ' choice
    run_choice "$choice"
    ui_pause
  done
}

if [[ ! -f docker-compose.yml ]]; then
  printf 'Hinweis: docker-compose.yml nicht im aktuellen Ordner gefunden.\n'
  printf 'Bitte dieses Skript im dart-dashboard Ordner ausfuehren.\n'
fi

detect_ui_mode

main_menu
