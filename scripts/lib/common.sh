#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$SCRIPT_DIR"

REPO_URL="https://github.com/ReXx09/dart-dashboard.git"
USE_WHIPTAIL=0
COMPOSE_BUILD_ARGS=()
COMPOSE_CMD=""
DOCKER_CMD=""

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

print_line() { printf '%s\n' "------------------------------------------------------------"; }

_color_supported() { [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; }

msg_run() {
  local text="$1"
  if _color_supported; then printf "\n\033[1;36m[RUN]\033[0m  %s\n" "$text"; else printf '\n[RUN]  %s\n' "$text"; fi
  printf '%s\n' '------------------------------------------------------------'
}
msg_ok()   { local t="$1"; if _color_supported; then printf "\033[1;32m[OK]\033[0m   %s\n" "$t"; else printf '[OK]   %s\n' "$t"; fi; }
msg_warn() { local t="$1"; if _color_supported; then printf "\033[1;33m[WARN]\033[0m %s\n" "$t"; else printf '[WARN] %s\n' "$t"; fi; }
msg_fail() { local t="$1"; if _color_supported; then printf "\033[1;31m[FAIL]\033[0m %s\n" "$t"; else printf '[FAIL] %s\n' "$t"; fi; }
msg_step() { local s="$1" t="$2" txt="$3"; if _color_supported; then printf "\033[1;34m[%s/%s]\033[0m %s\n" "$s" "$t" "$txt"; else printf '[%s/%s] %s\n' "$s" "$t" "$txt"; fi; }
msg_info() { local t="$1"; if _color_supported; then printf "\033[1;37m[INFO]\033[0m %s\n" "$t"; else printf '[INFO] %s\n' "$t"; fi; }

print_header() {
  clear || true
  print_line
  printf ' Loewen Dart Dashboard - Setup Assistent\n'
  print_line
  printf ' Dieses Skript fuehrt durch Install/Update/Start auf dem Raspi.\n\n'
}

command_exists() { command -v "$1" >/dev/null 2>&1; }

detect_ui_mode() {
  if command_exists whiptail && [[ -t 0 ]] && [[ -t 1 ]]; then
    USE_WHIPTAIL=1
  else
    USE_WHIPTAIL=0
  fi
}

ask_yes_no() {
  local prompt="$1" default="${2:-y}" answer
  if [[ "$USE_WHIPTAIL" -eq 1 ]]; then
    if [[ "$default" == "y" ]]; then
      whiptail --title "Bestaetigung" --yesno "$prompt" 10 72
      return $?
    fi
    whiptail --title "Bestaetigung" --defaultno --yesno "$prompt" 10 72
    return $?
  fi
  if [[ "$default" == "y" ]]; then
    read -r -p "$prompt [Y/n]: " answer; answer="${answer:-Y}"
  else
    read -r -p "$prompt [y/N]: " answer; answer="${answer:-N}"
  fi
  [[ "$answer" =~ ^[Yy]$ ]]
}

ask_input() {
  local title="$1" prompt="$2" default_value="${3:-}" value
  if [[ "$USE_WHIPTAIL" -eq 1 ]]; then
    value="$(whiptail --title "$title" --inputbox "$prompt" 11 78 "$default_value" 3>&1 1>&2 2>&3)" || return 1
  else
    read -r -p "$prompt [$default_value]: " value
    value="${value:-$default_value}"
  fi
  printf '%s' "$value"
}

ui_pause() {
  stty sane 2>/dev/null || true
  if [[ "$USE_WHIPTAIL" -eq 1 ]]; then
    whiptail --title "Weiter" --msgbox "Aktion abgeschlossen. Weiter mit OK." 9 60
  else
    printf '\n'; read -r -p 'Enter druecken fuer Hauptmenue...' _
  fi
}

show_textbox() {
  local title="$1" text="$2"
  if [[ "$USE_WHIPTAIL" -eq 1 ]]; then
    local tmp_file; tmp_file="$(mktemp)"
    printf '%s\n' "$text" > "$tmp_file"
    whiptail --title "$title" --scrolltext --textbox "$tmp_file" 24 90
    rm -f "$tmp_file"
  else
    printf '\n%s\n' "$title"; print_line; printf '%s\n' "$text"
  fi
}

detect_compose_cmd() {
  DOCKER_CMD=""
  if command_exists docker; then
    if docker info >/dev/null 2>&1; then
      DOCKER_CMD="docker"
    elif command_exists sudo && sudo docker info >/dev/null 2>&1; then
      DOCKER_CMD="sudo docker"
    fi
    if [[ -n "$DOCKER_CMD" ]] && $DOCKER_CMD compose version >/dev/null 2>&1; then
      COMPOSE_CMD="$DOCKER_CMD compose"
      return 0
    fi
    if [[ -n "$DOCKER_CMD" ]] && command_exists docker-compose && docker-compose version >/dev/null 2>&1; then
      if [[ "$DOCKER_CMD" == "sudo docker" ]]; then COMPOSE_CMD="sudo docker-compose"
      else COMPOSE_CMD="docker-compose"; fi
      return 0
    fi
  fi
  if command_exists docker-compose && docker-compose version >/dev/null 2>&1; then
    COMPOSE_CMD="docker-compose"
    DOCKER_CMD="docker"
    return 0
  fi
  return 1
}

init_compose_build_args() {
  COMPOSE_BUILD_ARGS=(-f docker-compose.yml)
  if [[ -n "$(get_env_value ARDUINO_DEVICE)" ]]; then
    COMPOSE_BUILD_ARGS+=(-f docker-compose.arduino.yml)
  fi
  if [[ -f docker-compose.build.yml ]]; then COMPOSE_BUILD_ARGS+=(-f docker-compose.build.yml); fi
}

compose() {
  init_compose_build_args
  $COMPOSE_CMD "${COMPOSE_BUILD_ARGS[@]}" "$@"
}

ensure_sudo() {
  if ! command_exists sudo; then
    printf 'Fehler: sudo wurde nicht gefunden.\n'; exit 1
  fi
}

set_or_replace_env() {
  local key="$1" value="$2"
  if grep -q "^${key}=" .env 2>/dev/null; then
    if [[ "$(uname)" == "Darwin" ]]; then
      sed -i '' "s|^${key}=.*|${key}=${value}|" .env
    else
      sed -i "s|^${key}=.*|${key}=${value}|" .env
    fi
  else
    printf '\n%s=%s\n' "$key" "$value" >> .env
  fi
}

ensure_env_file() {
  if [[ ! -f .env ]]; then
    if [[ -f .env.example ]]; then
      cp .env.example .env
      msg_ok '.env aus .env.example erstellt.'
    else
      msg_fail '.env und .env.example fehlen; Konfiguration kann nicht angelegt werden.'
      return 1
    fi
  fi
  chmod 600 .env
}

ensure_docker_ready() {
  if ! command_exists docker; then
    msg_fail 'Docker ist nicht installiert.'
    if ask_yes_no 'Soll Docker jetzt installiert werden?' 'y'; then
      install_docker_stack_debian
    else
      exit 1
    fi
  fi

  if command_exists systemctl && command_exists sudo && ! docker info >/dev/null 2>&1; then
    sudo systemctl enable --now docker || {
      msg_fail 'Der Docker-Dienst konnte nicht gestartet werden.'
      return 1
    }
  fi

  if ! detect_compose_cmd; then
    msg_fail 'Docker Compose ist nicht verfuegbar.'
    if command_exists apt-get && command_exists sudo && ask_yes_no 'Docker Compose jetzt installieren?' 'y'; then
      sudo apt-get update
      sudo apt-get install -y docker-compose-plugin
    fi
    if ! detect_compose_cmd; then
      msg_fail 'Docker Compose konnte nicht bereitgestellt werden. Bitte Installationsausgabe pruefen.'
      return 1
    fi
  fi
  if [[ -z "$DOCKER_CMD" ]] || ! $DOCKER_CMD info >/dev/null 2>&1; then
    msg_fail 'Docker ist installiert, aber der Dienst ist nicht erreichbar.'
    msg_info 'Pruefe den Docker-Dienst und die Benutzerberechtigungen.'
    return 1
  fi
}

show_network_hint() {
  local port firetv_port ip_address count=0 attempt
  port="$(get_env_value PUBLIC_PORT 3100)"
  firetv_port="$(get_env_value FIRETV_PORT 3200)"

  if command_exists curl; then
    for attempt in {1..15}; do
      if curl -fsS --max-time 2 "http://localhost:${port}/api/server-info" >/dev/null 2>&1; then
        break
      fi
      [[ "$attempt" -eq 15 ]] || sleep 2
    done
  fi

  if command_exists curl && curl -fsS --max-time 2 "http://localhost:${port}/api/server-info" >/dev/null 2>&1; then
    msg_info ''
    msg_info '=== Dashboard ist bereit ==='
    msg_info "Spiel-/Admin-Ansicht: http://localhost:${port}"
    msg_info "Fire-TV-Ansicht:      http://localhost:${firetv_port}/panels/firetv-dashboard.html"

    if command_exists ip; then
      while IFS= read -r ip_address; do
        [[ -z "$ip_address" || "$ip_address" == 127.* ]] && continue
        msg_info "Im Heimnetz:    http://${ip_address}:${port}"
        msg_info "Fire TV:        http://${ip_address}:${firetv_port}/panels/firetv-dashboard.html"
        count=$((count + 1))
        [[ "$count" -ge 3 ]] && break
      done < <(ip -4 -o addr show 2>/dev/null | awk '{split($4, address, "/"); print address[1]}')
    fi
    msg_info ''
    return 0
  fi

  msg_warn "Dashboard-Port http://localhost:${port} antwortet noch nicht. Prüfe 'docker compose logs --tail=200' und 'docker ps'."
  return 1
}