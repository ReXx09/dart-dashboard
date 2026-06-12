#!/usr/bin/env bash

build_requirements_report() {
  local report="" missing_count=0

  report+="Setup-Pruefung fuer Raspberry Pi\n\n"

  if command_exists apt-get; then report+="[OK] apt-get verfuegbar\n"
  else report+="[WARN] apt-get fehlt (nicht Debian/Raspberry Pi OS?)\n"; fi

  if command_exists docker; then report+="[OK] Docker installiert\n"
  else report+="[FEHLT] Docker\n"; missing_count=$((missing_count + 1)); fi

  if detect_compose_cmd >/dev/null 2>&1; then report+="[OK] Docker Compose verfuegbar\n"
  else report+="[FEHLT] Docker Compose\n"; missing_count=$((missing_count + 1)); fi

  if command_exists git; then report+="[OK] Git installiert\n"
  else report+="[FEHLT] Git\n"; missing_count=$((missing_count + 1)); fi

  if command_exists whiptail; then report+="[OK] whiptail installiert\n"
  else report+="[OPTIONAL] whiptail fehlt (Textmenue bleibt nutzbar)\n"; fi

  if groups "$USER" | grep -Eq '(^|[[:space:]])docker($|[[:space:]])'; then
    report+="[OK] Benutzer in docker-Gruppe\n"
  else
    report+="[HINWEIS] Benutzer nicht in docker-Gruppe (evtl. sudo noetig)\n"
  fi

  report+="\nFehlende Kernkomponenten: ${missing_count}\n"
  printf '%b' "$report"
}

install_docker_stack_debian() {
  ensure_sudo
  printf '\nInstalliere Docker und Compose-Plugin (Debian/Raspberry Pi OS)...\n'
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl gnupg lsb-release git whiptail

  if ! command_exists docker; then
    curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
    sudo sh /tmp/get-docker.sh
    rm -f /tmp/get-docker.sh
  fi

  sudo apt-get install -y docker-compose-plugin || true

  if ! groups "$USER" | grep -Eq '(^|[[:space:]])docker($|[[:space:]])'; then
    sudo usermod -aG docker "$USER" || true
    printf 'Hinweis: Benutzer wurde zur Gruppe docker hinzugefuegt.\n'
    printf 'Bitte danach einmal neu anmelden, falls Docker ohne sudo nicht geht.\n'
  fi
}

run_system_check_and_install() {
  local initial_report
  initial_report="$(build_requirements_report)"
  show_textbox "Systemcheck" "$initial_report"

  if ! ask_yes_no 'Fehlende Komponenten jetzt automatisch installieren?' 'y'; then
    return
  fi

  if ! command_exists apt-get; then
    msg_fail 'apt-get fehlt – bitte manuell Docker installieren: https://docs.docker.com/engine/install/'
    return
  fi

  install_docker_stack_debian
  msg_ok 'Installation abgeschlossen.'
  msg_info 'Tipp: Nach der Installation einmal aus- und einloggen, damit die Docker-Gruppe aktiv wird.'
}