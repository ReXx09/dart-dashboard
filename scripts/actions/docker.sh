#!/usr/bin/env bash

switch_to_remote_branch() {
  local target_branch="$1"
  if ! command_exists git || ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    msg_warn 'Kein Git-Repository gefunden - nutze lokalen Code ohne Branch-Wechsel.'
    return 0
  fi
  if [[ -n "$(git status --porcelain)" ]]; then
    msg_fail 'Lokale Git-Aenderungen vorhanden. Branch-Wechsel abgebrochen.'
    msg_info 'Bitte zuerst git status pruefen und Aenderungen sichern.'
    return 1
  fi

  msg_run "Hole Branch '${target_branch}' aus GitHub..."
  git fetch origin "$target_branch"
  if git show-ref --verify --quiet "refs/heads/${target_branch}"; then
    git switch "$target_branch"
  else
    git switch --track -c "$target_branch" "origin/${target_branch}"
  fi
  git pull --ff-only origin "$target_branch"
  msg_ok "Branch aktiv: ${target_branch}"
}

build_and_start() {
  ensure_docker_ready
  ensure_env_file

  switch_to_remote_branch master

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

dev_build_and_start() {
  ensure_docker_ready
  ensure_env_file

  local dev_branch="${DART_DEV_BRANCH:-refactor-central-data}"
  switch_to_remote_branch "$dev_branch"

  init_compose_build_args
  msg_run 'Baue Dev-Container mit aktuellem Code...'
  if [[ ${#COMPOSE_BUILD_ARGS[@]} -gt 0 ]]; then
    $COMPOSE_CMD "${COMPOSE_BUILD_ARGS[@]}" up -d --build
  else
    $COMPOSE_CMD build --no-cache
    msg_run 'Starte Dev-Container...'
    $COMPOSE_CMD up -d
  fi

  msg_info 'Container Status:'
  $COMPOSE_CMD ps
  show_network_hint
}

start_existing() {
  ensure_docker_ready
  ensure_env_file

  msg_run 'Starte vorhandenen lokalen Container...'
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
  msg_run 'Starte Docker-Container neu...'
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
    msg_warn 'Abgebrochen.'; return 2
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
    msg_warn 'Abgebrochen.'; return 2
  fi
  if ! uninstall_stack; then
    msg_warn 'Reinstall nach abgebrochener oder fehlgeschlagener Deinstallation beendet.'
    return 1
  fi
  build_and_start
}