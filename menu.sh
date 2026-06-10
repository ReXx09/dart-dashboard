#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_SCRIPT="$SCRIPT_DIR/install.sh"

if [[ ! -x "$INSTALL_SCRIPT" ]]; then
  printf 'Fehler: install.sh nicht gefunden oder nicht ausfuehrbar: %s\n' "$INSTALL_SCRIPT"
  exit 1
fi

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

USE_WHIPTAIL=0
if command_exists whiptail && [[ -t 0 ]] && [[ -t 1 ]]; then
  USE_WHIPTAIL=1
fi

get_env_value_local() {
  local key="$1"
  local default_value="${2:-}"
  local env_file="$SCRIPT_DIR/.env"

  if [[ -f "$env_file" ]]; then
    local line
    line="$(grep -E "^${key}=" "$env_file" | tail -n 1 || true)"
    if [[ -n "$line" ]]; then
      printf '%s' "${line#*=}"
      return 0
    fi
  fi

  printf '%s' "$default_value"
}

docker_menu_status() {
  if ! command_exists docker; then
    printf 'Docker: fehlt'
    return 0
  fi

  local state
  state="$(docker inspect -f '{{.State.Status}}' dart-dashboard 2>/dev/null || printf 'nicht gefunden')"
  case "$state" in
    running) printf 'Container: running' ;;
    exited) printf 'Container: exited' ;;
    restarting) printf 'Container: restarting' ;;
    *) printf 'Container: %s' "$state" ;;
  esac
}

api_menu_status() {
  if ! command_exists curl; then
    printf 'API: curl fehlt'
    return 0
  fi

  local port api_base
  port="$(get_env_value_local PUBLIC_PORT 3100)"
  api_base="http://localhost:${port}"

  if curl -fsS --max-time 2 "${api_base}/api/live/state" >/dev/null 2>&1; then
    printf 'API: erreichbar'
  else
    printf 'API: nicht erreichbar'
  fi
}

storage_menu_status() {
  if ! command_exists curl; then
    printf 'DB: unbekannt'
    return 0
  fi

  local port api_base payload client external mode
  port="$(get_env_value_local PUBLIC_PORT 3100)"
  api_base="http://localhost:${port}"
  payload="$(curl -fsS --max-time 2 "${api_base}/api/storage/info" 2>/dev/null || true)"
  if [[ -z "$payload" ]]; then
    printf 'DB: offline'
    return 0
  fi

  client="$(printf '%s' "$payload" | sed -n 's/.*"client"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
  external="$(printf '%s' "$payload" | sed -n 's/.*"external"[[:space:]]*:[[:space:]]*\(true\|false\).*/\1/p' | head -n 1)"
  [[ -z "$client" ]] && client='unknown'
  [[ "$external" == "true" ]] && mode='extern' || mode='lokal'
  printf 'DB: %s (%s)' "$client" "$mode"
}

arduino_menu_status() {
  if ! command_exists curl; then
    printf 'Arduino: unbekannt'
    return 0
  fi

  local port api_base payload connected
  port="$(get_env_value_local PUBLIC_PORT 3100)"
  api_base="http://localhost:${port}"
  payload="$(curl -fsS --max-time 2 "${api_base}/api/arduino/state" 2>/dev/null || true)"
  if [[ -z "$payload" ]]; then
    printf 'Arduino: offline'
    return 0
  fi

  connected="$(printf '%s' "$payload" | sed -n 's/.*"connected"[[:space:]]*:[[:space:]]*\(true\|false\).*/\1/p' | head -n 1)"
  if [[ "$connected" == "true" ]]; then
    printf 'Arduino: connected'
  else
    printf 'Arduino: disconnected'
  fi
}

menu_status_line() {
  printf '%s | %s | %s | %s' "$(docker_menu_status)" "$(api_menu_status)" "$(storage_menu_status)" "$(arduino_menu_status)"
}

print_line() {
  printf '%s\n' "------------------------------------------------------------"
}

print_header() {
  clear || true
  print_line
  printf ' Loewen Dart Dashboard - Menue\n'
  print_line
  printf ' Bereiche: Schnellstart, Einrichtung, Docker, Diagnose, Hilfe.\n\n'
}

run_action() {
  local action="$1"
  "$INSTALL_SCRIPT" "$action"
}

action_label() {
  local action="$1"
  case "$action" in
    quickstart) printf 'Schnellstart-Assistent' ;;
    check) printf 'Systemcheck + Auto-Installation' ;;
    build-start) printf 'Install/Update + Build + Start' ;;
    start) printf 'Container Start' ;;
    stop) printf 'Container Stop' ;;
    restart) printf 'Container Restart' ;;
    ps) printf 'Container Status (ps)' ;;
    logs) printf 'Container Logs (Snapshot)' ;;
    logs-follow) printf 'Container Logs (Live)' ;;
    status) printf 'Gesamtstatus' ;;
    uninstall) printf 'Uninstall' ;;
    reinstall) printf 'Reinstall' ;;
    health) printf 'Schnell-Diagnose (Health-Checks)' ;;
    test) printf 'Gefuehrte Funktionstests' ;;
    clone) printf 'Repo klonen' ;;
    help-guide) printf 'Einsteiger-Hilfe' ;;
    *) printf '%s' "$action" ;;
  esac
}

show_action_success() {
  local action="$1"
  local label
  label="$(action_label "$action")"
  if [[ "$USE_WHIPTAIL" -eq 1 ]]; then
    whiptail --title "Erfolg" --msgbox "Aktion erfolgreich:\n${label}\n\nWeiter mit OK." 11 68
  else
    printf '\n[OK] Aktion erfolgreich: %s\n' "$label"
    ui_pause
  fi
}

show_action_error() {
  local action="$1"
  local error_file="${2:-}"
  local details='Keine weiteren Details vorhanden.'

  if [[ -n "$error_file" && -f "$error_file" ]]; then
    details="$(tail -n 80 "$error_file" 2>/dev/null || true)"
    [[ -z "$details" ]] && details='Keine weiteren Details vorhanden.'
  fi

  if [[ "$USE_WHIPTAIL" -eq 1 ]]; then
    local tmp_file
    tmp_file="$(mktemp)"
    {
      printf 'Aktion fehlgeschlagen: %s\n\n' "$action"
      printf 'Letzte Meldungen:\n%s\n' "$details"
    } > "$tmp_file"
    whiptail --title "Fehler" --scrolltext --textbox "$tmp_file" 24 90
    rm -f "$tmp_file"
  else
    printf '\n[FEHLER] Aktion fehlgeschlagen: %s\n' "$action"
    printf 'Letzte Meldungen:\n%s\n' "$details"
    ui_pause
  fi
}

execute_action() {
  local action="$1"
  local pause_after="${2:-1}"
  local capture_output="${3:-1}"

  if [[ "$capture_output" -eq 0 ]]; then
    if ! run_action "$action"; then
      show_action_error "$action"
      return 1
    fi
  else
    local tmp_output
    tmp_output="$(mktemp)"
    if ! run_action "$action" >"$tmp_output" 2>&1; then
      show_action_error "$action" "$tmp_output"
      rm -f "$tmp_output"
      return 1
    fi
    rm -f "$tmp_output"
  fi

  if [[ "$pause_after" -eq 1 ]]; then
    show_action_success "$action"
  fi
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

# ── Untermenus ─────────────────────────────────────────────────────────────

submenu_einrichtung_whiptail() {
  local choice
  choice="$(whiptail --title "Einrichtung" --menu "Einrichtung & Installation" 16 72 5 \
    "1" "Systemcheck + Auto-Installation" \
    "2" "Install/Update + Build + Start" \
    "3" "Zurueck" \
    3>&1 1>&2 2>&3)" || return 0
  case "$choice" in
    1) execute_action check ;;
    2) execute_action build-start ;;
  esac
}

submenu_docker_whiptail() {
  local choice
  choice="$(whiptail --title "Docker" --menu "Docker-Verwaltung" 20 76 8 \
    "1" "Start" \
    "2" "Stop" \
    "3" "Restart" \
    "4" "ps  (Status anzeigen)" \
    "5" "Logs anzeigen  (Snapshot)" \
    "6" "Logs verfolgen  (Live, Ctrl+C)" \
    "7" "Uninstall  (Container + Image entfernen)" \
    "8" "Reinstall  (Uninstall + Neustart)" \
    "9" "Zurueck" \
    3>&1 1>&2 2>&3)" || return 0
  case "$choice" in
    1) execute_action start ;;
    2) execute_action stop ;;
    3) execute_action restart ;;
    4) execute_action ps ;;
    5) execute_action logs 0 0 ;;
    6) execute_action logs-follow 0 0 ;;
    7) execute_action uninstall ;;
    8) execute_action reinstall ;;
  esac
}

submenu_diagnose_advanced_whiptail() {
  local choice
  choice="$(whiptail --title "Diagnose (Erweitert)" --menu "Diagnose & Checks" 20 76 7 \
    "1" "Gefuehrte Funktionstests  (Schritt fuer Schritt)" \
    "2" "Gesamtstatus  (Compose + Logs + Netz)" \
    "3" "Docker-Logs Snapshot" \
    "4" "Docker-Logs Live (Ctrl+C)" \
    "5" "Zurueck" \
    3>&1 1>&2 2>&3)" || return 0
  case "$choice" in
    1) execute_action test 0 0 ;;
    2) execute_action status 0 0 ;;
    3) execute_action logs 0 0 ;;
    4) execute_action logs-follow 0 0 ;;
  esac
}

submenu_diagnose_whiptail() {
  local choice
  choice="$(whiptail --title "Diagnose" --menu "Diagnose & Checks" 18 76 6 \
    "1" "Schnell-Diagnose (Health-Checks, empfohlen)" \
    "2" "Erweiterte Diagnose  >" \
    "3" "Zurueck" \
    3>&1 1>&2 2>&3)" || return 0
  case "$choice" in
    1) execute_action health 0 0 ;;
    2) submenu_diagnose_advanced_whiptail ;;
  esac
}

# ── Hauptmenue whiptail ────────────────────────────────────────────────────

main_menu_whiptail() {
  while true; do
    local choice
    local status_line
    status_line="$(menu_status_line)"

    choice="$(whiptail --title "Loewen Dart Dashboard" --menu "${status_line}\n\nHauptmenue" 20 78 8 \
      "0" "Schnellstart-Assistent  (komplette Einrichtung)" \
      "1" "Einrichtung  >" \
      "2" "Docker  >" \
      "3" "Diagnose  >" \
      "4" "Repo: in anderen Ordner klonen" \
      "5" "Hilfe fuer Einsteiger" \
      "6" "Beenden" \
      3>&1 1>&2 2>&3)" || exit 0

    case "$choice" in
      0) execute_action quickstart ;;
      1) submenu_einrichtung_whiptail ;;
      2) submenu_docker_whiptail ;;
      3) submenu_diagnose_whiptail ;;
      4) execute_action clone ;;
      5) execute_action help-guide ;;
      6) printf 'Beendet.\n'; exit 0 ;;
      *) printf 'Ungueltige Auswahl.\n' ;;
    esac
  done
}

# ── Hauptmenue Text (Fallback ohne whiptail) ───────────────────────────────

submenu_einrichtung_text() {
  printf '\n-- Einrichtung --------------------------------\n'
  printf '1) Systemcheck + Auto-Installation\n'
  printf '2) Install/Update + Build + Start\n'
  printf '0) Zurueck\n\n'
  read -r -p 'Option [0-2]: ' c
  case "$c" in
    1) execute_action check ;;
    2) execute_action build-start ;;
  esac
}

submenu_docker_text() {
  printf '\n-- Docker -------------------------------------\n'
  printf '1) Start\n'
  printf '2) Stop\n'
  printf '3) Restart\n'
  printf '4) ps\n'
  printf '5) Logs (Snapshot)\n'
  printf '6) Logs (Live)\n'
  printf '7) Uninstall\n'
  printf '8) Reinstall\n'
  printf '0) Zurueck\n\n'
  read -r -p 'Option [0-8]: ' c
  case "$c" in
    1) execute_action start ;;
    2) execute_action stop ;;
    3) execute_action restart ;;
    4) execute_action ps ;;
    5) execute_action logs 0 0 ;;
    6) execute_action logs-follow 0 0 ;;
    7) execute_action uninstall ;;
    8) execute_action reinstall ;;
  esac
}

submenu_diagnose_advanced_text() {
  printf '\n-- Diagnose -----------------------------------\n'
  printf '1) Gefuehrte Funktionstests\n'
  printf '2) Gesamtstatus\n'
  printf '3) Docker-Logs (Snapshot)\n'
  printf '4) Docker-Logs (Live)\n'
  printf '0) Zurueck\n\n'
  read -r -p 'Option [0-4]: ' c
  case "$c" in
    1) execute_action test 0 0 ;;
    2) execute_action status 0 0 ;;
    3) execute_action logs 0 0 ;;
    4) execute_action logs-follow 0 0 ;;
  esac
}

submenu_diagnose_text() {
  printf '\n-- Diagnose -----------------------------------\n'
  printf '1) Schnell-Diagnose (Health-Checks)\n'
  printf '2) Erweiterte Diagnose >\n'
  printf '0) Zurueck\n\n'
  read -r -p 'Option [0-2]: ' c
  case "$c" in
    1) execute_action health 0 0 ;;
    2) submenu_diagnose_advanced_text ;;
  esac
}

main_menu_text() {
  while true; do
    print_header
    printf 'Aktueller Ordner: %s\n\n' "$SCRIPT_DIR"
    printf '0) Schnellstart-Assistent\n'
    printf '1) Einrichtung >\n'
    printf '2) Docker >\n'
    printf '3) Diagnose >\n'
    printf '4) Repo: klonen\n'
    printf '5) Hilfe\n'
    printf '6) Beenden\n\n'
    read -r -p 'Option [0-6]: ' choice
    case "$choice" in
      0) execute_action quickstart ;;
      1) submenu_einrichtung_text ;;
      2) submenu_docker_text ;;
      3) submenu_diagnose_text ;;
      4) execute_action clone ;;
      5) execute_action help-guide ;;
      6) printf 'Beendet.\n'; exit 0 ;;
      *) printf 'Ungueltige Auswahl.\n' ;;
    esac
  done
}

if [[ "$USE_WHIPTAIL" -eq 1 ]]; then
  main_menu_whiptail
else
  main_menu_text
fi
