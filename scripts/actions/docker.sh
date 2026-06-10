#!/usr/bin/env bash

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

uninstall_stack() {
  ensure_docker_ready

  printf '\nUninstall - folgende Schritte werden ausgefuehrt:\n'
  printf '  1) Container stoppen und entfernen\n'
  printf '  2) Docker Image entfernen\n'
  printf '  3) Optionales Loeschen der lokalen Datenbankdatei (data/dashboard.db)\n'
  printf '  HINWEIS: .env und data/ (JSON-Overrides, Settings) bleiben erhalten.\n\n'

  if ! ask_yes_no 'Wirklich deinstallieren?' 'n'; then
    printf 'Abgebrochen.\n'
    return
  fi

  printf '\nStoppe und entferne Container...\n'
  $COMPOSE_CMD down --remove-orphans || true

  printf '\nEntferne Docker Image (dart-dashboard)...\n'
  docker rmi ghcr.io/rexx09/loewen-dart-dashboard:latest 2>/dev/null \
    && printf 'Image entfernt.\n' \
    || printf 'Image nicht gefunden oder bereits entfernt.\n'

  if [[ -f data/dashboard.db ]]; then
    if ask_yes_no 'SQL-Datenbankdatei data/dashboard.db ebenfalls loeschen?' 'n'; then
      rm -f data/dashboard.db
      printf 'data/dashboard.db geloescht.\n'
    fi
  fi

  printf '\nDeinstallation abgeschlossen.\n'
  printf 'Tipp: Mit "install.sh reinstall" alles neu aufsetzen.\n'
}

reinstall_stack() {
  printf '\nReinstall - folgende Schritte werden ausgefuehrt:\n'
  printf '  1) Uninstall (Container + Image entfernen)\n'
  printf '  2) Neuestes Image ziehen und Container neu starten\n\n'

  if ! ask_yes_no 'Wirklich neu installieren (Reinstall)?' 'n'; then
    printf 'Abgebrochen.\n'
    return
  fi

  uninstall_stack
  build_and_start
}

restart_stack() {
  ensure_docker_ready
  ensure_env_file
  printf '\nStarte Container neu...\n'
  $COMPOSE_CMD down
  $COMPOSE_CMD up -d
  $COMPOSE_CMD ps
  show_network_hint
}

show_compose_ps() {
  ensure_docker_ready
  printf '\nCompose Status:\n'
  $COMPOSE_CMD ps
}

show_logs() {
  ensure_docker_ready
  local logs
  logs="$(docker logs --tail 120 dart-dashboard 2>&1 || true)"
  if [[ -z "$logs" ]]; then
    logs='Keine Logs verfuegbar (Container noch nicht gestartet?).'
  fi

  show_textbox "Docker-Logs (Snapshot)" "$logs"
}

show_logs_follow() {
  ensure_docker_ready

  clear || true
  printf 'Live-Logs fuer dart-dashboard (Ctrl+C zum Beenden)\n\n'
  docker logs -f --tail 30 dart-dashboard 2>&1 || printf 'Container nicht gefunden oder keine Logs verfuegbar.\n'
  ui_pause
}

show_status() {
  ensure_docker_ready
  local report compose_ps arduino_ports latest_logs host_ip public_port

  compose_ps="$($COMPOSE_CMD ps 2>&1 || true)"
  arduino_ports="$(ls /dev/ttyACM* /dev/ttyUSB* 2>/dev/null || true)"
  latest_logs="$(docker logs --tail 30 dart-dashboard 2>&1 || true)"
  host_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  public_port="$(get_env_value PUBLIC_PORT 3100)"

  [[ -z "$arduino_ports" ]] && arduino_ports='Keine ttyACM/ttyUSB Ports gefunden.'
  [[ -z "$latest_logs" ]] && latest_logs='Keine Logs verfuegbar (Container noch nicht gestartet?).'
  [[ -z "$host_ip" ]] && host_ip='<RASPI-IP>'

  report+="Status\n\n"
  report+="Compose\n"
  report+="${compose_ps}\n\n"
  report+="Arduino Ports\n"
  report+="${arduino_ports}\n\n"
  report+="Letzte Logs (dart-dashboard)\n"
  report+="${latest_logs}\n\n"
  report+="Browser-Aufruf\n"
  report+="http://${host_ip}:${public_port}\n"

  show_textbox "Gesamtstatus" "$(printf '%b' "$report")"
}
