#!/usr/bin/env bash

build_and_start() {
  ensure_docker_ready
  ensure_env_file
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

  msg_run 'Ziehe aktuelles Image (falls verfuegbar)...'
  $COMPOSE_CMD pull dart-dashboard 2>/dev/null || msg_warn 'Image-Pull fehlgeschlagen, starte mit lokalem Image.'

  msg_run 'Starte Container...'
  $COMPOSE_CMD up -d
  $COMPOSE_CMD ps
  show_network_hint
}

stop_stack() {
  ensure_docker_ready
  msg_run 'Stoppe Container...'
  $COMPOSE_CMD down
}

restart_stack() {
  ensure_docker_ready
  ensure_env_file
  $COMPOSE_CMD pull dart-dashboard 2>/dev/null || msg_warn 'Image-Pull fehlgeschlagen.'
  $COMPOSE_CMD down
  $COMPOSE_CMD up -d
  $COMPOSE_CMD ps
  show_network_hint
}

show_compose_ps() {
  ensure_docker_ready
  $COMPOSE_CMD ps
}

show_logs() {
  ensure_docker_ready
  $COMPOSE_CMD logs --tail=100
}

show_logs_follow() {
  ensure_docker_ready
  $COMPOSE_CMD logs --tail=50 -f
}

show_status() {
  ensure_docker_ready
  msg_run 'Container Status:'
  $COMPOSE_CMD ps

  msg_run 'Letzte Log-Auszuege:'
  $COMPOSE_CMD logs --tail=20

  msg_run 'Port und Netzwerk:'
  show_network_hint
}

uninstall_stack() {
  ensure_docker_ready
  msg_info 'Uninstall - folgende Schritte:'
  msg_step 1 3 'Container stoppen und entfernen'
  msg_step 2 3 'Docker Image entfernen'
  msg_step 3 3 'SQLite-Datei loeschen (optional)'
  msg_info 'HINWEIS: .env und data/ bleiben erhalten.'

  if ! ask_yes_no 'Wirklich deinstallieren?' 'n'; then
    msg_warn 'Abgebrochen.'; return
  fi

  $COMPOSE_CMD down --remove-orphans || true
  docker rmi ghcr.io/rexx09/loewen-dart-dashboard:latest 2>/dev/null \
    && msg_ok 'Image entfernt.' || msg_warn 'Image nicht gefunden.'

  if [[ -f data/dashboard.db ]] && ask_yes_no 'SQL-Datenbank loeschen?' 'n'; then
    rm -f data/dashboard.db && msg_ok 'Datenbank geloescht.'
  fi
  msg_ok 'Deinstallation abgeschlossen.'
}

reinstall_stack() {
  msg_info 'Reinstall: Uninstall + Neustart'
  if ! ask_yes_no 'Wirklich neu installieren?' 'n'; then
    msg_warn 'Abgebrochen.'; return
  fi
  uninstall_stack
  build_and_start
}