#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$SCRIPT_DIR"

REPO_URL="https://github.com/ReXx09/dart-dashboard.git"
USE_WHIPTAIL=0
COMPOSE_BUILD_ARGS=()
COMPOSE_CMD=""

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

ui_pause() {
  stty sane 2>/dev/null || true
  if [[ "$USE_WHIPTAIL" -eq 1 ]]; then
    whiptail --title "Weiter" --msgbox "Aktion abgeschlossen. Weiter mit OK." 9 60
  else
    printf '\n'
    read -r -p 'Enter druecken fuer Hauptmenue...' _
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
  local public_port
  host_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  public_port="$(get_env_value PUBLIC_PORT 3100)"

  printf '\nAufruf im Browser:\n'
  if [[ -n "$host_ip" ]]; then
    printf '  http://%s:%s\n' "$host_ip" "$public_port"
  else
    printf '  http://<RASPI-IP>:%s\n' "$public_port"
  fi
}

git_update_if_possible() {
  if command_exists git && [[ -d .git ]]; then
    printf '\nHole neuesten Stand aus GitHub...\n'
    git pull --ff-only || printf 'Warnung: git pull fehlgeschlagen, fahre mit lokalem Stand fort.\n'
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
