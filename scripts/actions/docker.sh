#!/usr/bin/env bash

build_and_start() {
  ensure_docker_ready
  ensure_env_file
  git_update_if_possible
  init_compose_build_args

  msg_run 'Baue Container mit aktuellem Code...'
  if [[ ${#COMPOSE_BUILD_ARGS[@]} -gt 0 ]]; then
    $COMPOSE_CMD "${COMPOSE_BUILD_ARGS[@]}" up -d --build
  else
    $COMPOSE_CMD build --no-cache
    msg_run 'Starte Container...'
    $COMPOSE_CMD up -d
  fi

  msg_info 'Container Status:'
  $COMPOSE_CMD ps
  show_network_hint
}

start_existing() {
  ensure_docker_ready
  ensure_env_file

  msg_run 'Starte vorhandene Container...'
  $COMPOSE_CMD up -d
  $COMPOSE_CMD ps
  show_network_hint
}

stop_stack() {
  ensure_docker_ready
  msg_run 'Stoppe Container...'
  $COMPOSE_CMD down
}

uninstall_stack() {
  ensure_docker_ready

  msg_info 'Uninstall - folgende Schritte werden ausgefuehrt:'
  msg_step 1 3 'Container stoppen und entfernen'
  msg_step 2 3 'Docker Image entfernen'
  msg_step 3 3 'Optionales Loeschen der SQLite-Datei (data/dashboard.db)'
  msg_info 'HINWEIS: .env und data/ (JSON-Overrides, Settings) bleiben erhalten.'

  if ! ask_yes_no 'Wirklich deinstallieren?' 'n'; then
    msg_warn 'Abgebrochen.'
    return
  fi

  msg_run 'Stoppe und entferne Container...'
  $COMPOSE_CMD down --remove-orphans || true

  msg_run 'Entferne Docker Image (dart-dashboard)...'
  docker rmi ghcr.io/rexx09/loewen-dart-dashboard:latest 2>/dev/null \
    && msg_ok 'Image entfernt.' \
    || msg_warn 'Image nicht gefunden oder bereits entfernt.'

  if [[ -f data/dashboard.db ]]; then
    if ask_yes_no 'SQL-Datenbankdatei data/dashboard.db ebenfalls loeschen?' 'n'; then
      rm -f data/dashboard.db
      msg_ok 'data/dashboard.db geloescht.'
    fi
  fi

  msg_ok 'Deinstallation abgeschlossen.'
  msg_info 'Tipp: Mit "install.sh reinstall" alles neu aufsetzen.'
}

reinstall_stack() {
  msg_info 'Reinstall - folgende Schritte werden ausgefuehrt:'
  msg_step 1 2 'Uninstall (Container + Image entfernen)'
  msg_step 2 2 'Neuestes Image ziehen und Container neu starten'

  if ! ask_yes_no 'Wirklich neu installieren (Reinstall)?' 'n'; then
    msg_warn 'Abgebrochen.'
    return
  fi

  uninstall_stack
  build_and_start
}

restart_stack() {
  ensure_docker_ready
  ensure_env_file
  msg_run 'Starte Container neu...'
  $COMPOSE_CMD down
  $COMPOSE_CMD up -d
  $COMPOSE_CMD ps
  show_network_hint
}

show_compose_ps() {
  ensure_docker_ready
  msg_info 'Compose Status:'
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
  msg_run 'Live-Logs: dart-dashboard  (Ctrl+C zum Beenden)'
  docker logs -f --tail 30 dart-dashboard 2>&1 || msg_warn 'Container nicht gefunden oder keine Logs verfuegbar.'
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

  report+="[INFO] Status\n\n"
  report+="[INFO] Compose\n"
  report+="${compose_ps}\n\n"
  report+="[INFO] Arduino Ports\n"
  report+="${arduino_ports}\n\n"
  report+="[INFO] Letzte Logs (dart-dashboard)\n"
  report+="${latest_logs}\n\n"
  report+="[INFO] Browser-Aufruf\n"
  report+="http://${host_ip}:${public_port}\n"

  show_textbox "Gesamtstatus" "$(printf '%b' "$report")"
}
