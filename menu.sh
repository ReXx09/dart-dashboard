#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_SCRIPT="$SCRIPT_DIR/install.sh"
COMMON_LIB="$SCRIPT_DIR/scripts/lib/common.sh"

if [[ ! -x "$INSTALL_SCRIPT" ]]; then
  printf 'Fehler: install.sh nicht gefunden oder nicht ausfuehrbar: %s\n' "$INSTALL_SCRIPT"
  exit 1
fi

if [[ -f "$COMMON_LIB" ]]; then
  source "$COMMON_LIB"
else
  msg_run()   { printf '\n[RUN]  %s\n' "$1"; }
  msg_ok()    { printf '[OK]   %s\n' "$1"; }
  msg_warn()  { printf '[WARN] %s\n' "$1"; }
  msg_fail()  { printf '[FAIL] %s\n' "$1"; }
  msg_info()  { printf '[INFO] %s\n' "$1"; }
fi

command_exists() { command -v "$1" >/dev/null 2>&1; }

USE_WHIPTAIL=0
if command_exists whiptail && [[ -t 0 ]] && [[ -t 1 ]]; then
  USE_WHIPTAIL=1
fi

get_env_value_local() {
  local key="$1" default_value="${2:-}" line
  if [[ -f "$SCRIPT_DIR/.env" ]]; then
    line="$(grep -E "^${key}=" "$SCRIPT_DIR/.env" | tail -n 1 || true)"
    if [[ -n "$line" ]]; then printf '%s' "${line#*=}"; return 0; fi
  fi
  printf '%s' "$default_value"
}

status_badge() {
  case "${1:-}" in ok) printf '[OK]' ;; warn) printf '[WARN]' ;; off) printf '[OFF]' ;; *) printf '[INFO]' ;; esac
}

docker_menu_status() {
  if ! command_exists docker; then printf '%s Docker fehlt' "$(status_badge off)"; return 0; fi
  local state; state="$(docker inspect -f '{{.State.Status}}' dart-dashboard 2>/dev/null || printf 'nicht gefunden')"
  case "$state" in
    running)   printf '%s Container running'   "$(status_badge ok)" ;;
    exited)    printf '%s Container exited'    "$(status_badge warn)" ;;
    restarting) printf '%s Container restarting' "$(status_badge warn)" ;;
    *)         printf '%s Container %s'         "$(status_badge off)" "$state" ;;
  esac
}

api_menu_status() {
  if ! command_exists curl; then printf '%s API curl fehlt' "$(status_badge off)"; return 0; fi
  local port api_base; port="$(get_env_value_local PUBLIC_PORT 3100)"; api_base="http://localhost:${port}"
  if curl -fsS --max-time 2 "${api_base}/api/live/state" >/dev/null 2>&1; then
    printf '%s API erreichbar' "$(status_badge ok)"
  else
    printf '%s API nicht erreichbar' "$(status_badge off)"
  fi
}

storage_menu_status() {
  if ! command_exists curl; then printf '%s DB unbekannt' "$(status_badge off)"; return 0; fi
  local port api_base payload client mode
  port="$(get_env_value_local PUBLIC_PORT 3100)"; api_base="http://localhost:${port}"
  payload="$(curl -fsS --max-time 2 "${api_base}/api/storage/info" 2>/dev/null || true)"
  if [[ -z "$payload" ]]; then printf '%s DB offline' "$(status_badge off)"; return 0; fi
  client="$(printf '%s' "$payload" | sed -n 's/.*"client"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
  [[ -z "$client" ]] && client='unknown'
  printf '%s DB %s' "$(status_badge ok)" "$client"
}

arduino_menu_status() {
  if ! command_exists curl; then printf '%s Arduino unbekannt' "$(status_badge off)"; return 0; fi
  local port api_base payload connected
  port="$(get_env_value_local PUBLIC_PORT 3100)"; api_base="http://localhost:${port}"
  payload="$(curl -fsS --max-time 2 "${api_base}/api/arduino/state" 2>/dev/null || true)"
  if [[ -z "$payload" ]]; then printf '%s Arduino offline' "$(status_badge off)"; return 0; fi
  connected="$(node -e 'const data = JSON.parse(require("fs").readFileSync(0, "utf8")); process.stdout.write(String(!!(data.connection ? data.connection.connected : data.connected)));' <<<"$payload" 2>/dev/null)"
  if [[ "$connected" == "true" ]]; then printf '%s Arduino connected' "$(status_badge ok)"
  else printf '%s Arduino disconnected' "$(status_badge warn)"; fi
}

menu_status_line()   { printf '%s | %s | %s | %s' "$(docker_menu_status)" "$(api_menu_status)" "$(storage_menu_status)" "$(arduino_menu_status)"; }
docker_status_line() { printf '%s | %s' "$(docker_menu_status)" "$(api_menu_status)"; }
diag_status_line()   { printf '%s | %s | %s' "$(api_menu_status)" "$(storage_menu_status)" "$(arduino_menu_status)"; }

print_line() { printf '%s\n' "------------------------------------------------------------"; }

print_header() {
  clear || true; print_line
  printf ' Loewen Dart Dashboard - Menue\n'; print_line
  printf ' Live-Spielstand, Spieler, Highscores & Arduino\n\n'
}

run_action() { "$INSTALL_SCRIPT" "$1"; }

action_label() {
  case "$1" in
    quickstart)         printf 'Schnellstart-Assistent' ;;
    check)              printf 'Systemcheck + Auto-Installation' ;;
    build-start)        printf 'Install/Update + Build + Start' ;;
    start)              printf 'Container Start' ;;
    stop)               printf 'Container Stop' ;;
    restart)            printf 'Container Restart' ;;
    ps)                 printf 'Container Status (ps)' ;;
    logs)               printf 'Container Logs (Snapshot)' ;;
    logs-follow)        printf 'Container Logs (Live)' ;;
    status)             printf 'Gesamtstatus' ;;
    uninstall)          printf 'Uninstall' ;;
    reinstall)          printf 'Reinstall' ;;
    health)             printf 'Health-Checks' ;;
    test)               printf 'Gefuehrte Funktionstests' ;;
    arduino-status)     printf 'Arduino-Status' ;;
    arduino-connect)    printf 'Arduino verbinden' ;;
    arduino-disconnect) printf 'Arduino trennen' ;;
    clone)              printf 'Repo klonen' ;;
    help-guide)         printf 'Einsteiger-Hilfe' ;;
    *)                  printf '%s' "$1" ;;
  esac
}

show_action_success() {
  local label; label="$(action_label "$1")"
  if [[ "$USE_WHIPTAIL" -eq 1 ]]; then
    whiptail --title "Erfolg" --msgbox "Aktion erfolgreich:\n${label}\n\nMit OK zur vorherigen Menueebene." 11 72
  else
    msg_ok "Aktion erfolgreich: ${label}"; printf 'Weiter mit Enter...\n'; ui_pause
  fi
}

show_action_error() {
  local action="$1" error_file="${2:-}" details='Keine weiteren Details vorhanden.'
  if [[ -n "$error_file" && -f "$error_file" ]]; then
    details="$(tail -n 80 "$error_file" 2>/dev/null || true)"; [[ -z "$details" ]] && details='Keine weiteren Details.'
  fi
  if [[ "$USE_WHIPTAIL" -eq 1 ]]; then
    local tmp; tmp="$(mktemp)"; { printf 'Aktion fehlgeschlagen: %s\n\nLetzte Meldungen:\n%s\n' "$action" "$details"; } > "$tmp"
    whiptail --title "Fehler" --scrolltext --textbox "$tmp" 24 90; rm -f "$tmp"
  else
    msg_fail "Aktion fehlgeschlagen: ${action}"; printf '%s\n' "$details"; ui_pause
  fi
}

execute_action() {
  local action="$1" pause_after="${2:-1}" capture_output="${3:-2}" label
  label="$(action_label "$action")"; msg_run "$label"

  if [[ "$capture_output" -eq 0 ]]; then
    if ! run_action "$action"; then show_action_error "$action"; return 1; fi
  elif [[ "$capture_output" -eq 2 ]]; then
    local tmp; tmp="$(mktemp)"
    if ! run_action "$action" 2>&1 | tee "$tmp"; then show_action_error "$action" "$tmp"; rm -f "$tmp"; return 1; fi
    rm -f "$tmp"
  else
    local tmp; tmp="$(mktemp)"
    if ! run_action "$action" >"$tmp" 2>&1; then show_action_error "$action" "$tmp"; rm -f "$tmp"; return 1; fi
    rm -f "$tmp"
  fi
  [[ "$pause_after" -eq 1 ]] && show_action_success "$action"
}

ui_pause() {
  stty sane 2>/dev/null || true
  if [[ "$USE_WHIPTAIL" -eq 1 ]]; then whiptail --title "Weiter" --msgbox "Aktion abgeschlossen. Weiter mit OK." 9 60
  else printf '\n'; read -r -p 'Enter druecken fuer Hauptmenue...' _; fi
}

# ── Untermenüs ──────────────────────────────────────────────────────────────

submenu_einrichtung_whiptail() {
  while true; do
    local choice
    choice="$(whiptail --title "Loewen Dart | Einrichtung" --menu "$(printf 'System vorbereiten oder den Dienst neu bauen und starten.\n\nENTER = ausfuehren   ESC = zurueck')" 16 76 5 \
      "1" "Systemcheck + Auto-Installation" \
      "2" "Install/Update + Build + Start" \
      "0" "Zurueck" \
      3>&1 1>&2 2>&3)" || return 0
    case "$choice" in 1) execute_action check 1 0 ;; 2) execute_action build-start 1 0 ;; 0|"") return 0 ;; esac
  done
}

submenu_docker_whiptail() {
  while true; do
    local choice status_line; status_line="$(docker_status_line)"
    choice="$(whiptail --title "Loewen Dart | Docker" --menu "${status_line}\n\n$(printf 'Container steuern, Logs ansehen oder neu aufsetzen.\n\nENTER = ausfuehren   ESC = zurueck')" 20 80 8 \
      "1" "Start" \
      "2" "Stop" \
      "3" "Restart" \
      "4" "ps  (Status anzeigen)" \
      "5" "Logs anzeigen (Snapshot)" \
      "6" "Logs verfolgen (Live, Ctrl+C)" \
      "7" "Uninstall (Container + Image entfernen)" \
      "8" "Reinstall (Uninstall + Neustart)" \
      "0" "Zurueck" \
      3>&1 1>&2 2>&3)" || return 0
    case "$choice" in 1) execute_action start ;; 2) execute_action stop ;; 3) execute_action restart ;; 4) execute_action ps ;; 5) execute_action logs 0 0 ;; 6) execute_action logs-follow 0 0 ;; 7) execute_action uninstall ;; 8) execute_action reinstall ;; 0|"") return 0 ;; esac
  done
}

submenu_monitoring_whiptail() {
  while true; do
    local choice status_line; status_line="$(diag_status_line)"
    choice="$(whiptail --title "Loewen Dart | Status & Monitoring" --menu "${status_line}\n\n$(printf 'Status pruefen, Diagnose oder Arduino verbinden.\n\nENTER = ausfuehren   ESC = zurueck')" 20 80 7 \
      "1" "Schnell-Diagnose (Health-Checks)" \
      "2" "Gesamtstatus" \
      "3" "Arduino-Status" \
      "4" "Arduino verbinden / neu verbinden" \
      "5" "Arduino trennen" \
      "6" "Gefuehrte Funktionstests" \
      "0" "Zurueck" \
      3>&1 1>&2 2>&3)" || return 0
    case "$choice" in
      1) execute_action health 0 0 ;; 2) execute_action status 0 0 ;;
      3) execute_action arduino-status 0 0 ;; 4) execute_action arduino-connect ;;
      5) execute_action arduino-disconnect ;; 6) execute_action test 0 0 ;;
      0|"") return 0 ;; esac
  done
}

# ── Text-Menüs (Fallback ohne whiptail) ────────────────────────────────────

submenu_einrichtung_text() {
  while true; do
    printf '\n-- Einrichtung --------------------------------\n'
    printf '1) Systemcheck + Auto-Installation\n'
    printf '2) Install/Update + Build + Start\n'
    printf '0) Zurueck\n\n'
    read -r -p 'Option [0-2]: ' c
    case "$c" in 1) execute_action check 1 0 ;; 2) execute_action build-start 1 0 ;; 0|'') return 0 ;; esac
  done
}

submenu_docker_text() {
  while true; do
    printf '\n-- Docker -------------------------------------\n'
    printf '%s\n' "$(docker_status_line)"
    printf '1) Start\n2) Stop\n3) Restart\n4) ps\n5) Logs (Snapshot)\n6) Logs (Live)\n7) Uninstall\n8) Reinstall\n0) Zurueck\n\n'
    read -r -p 'Option [0-8]: ' c
    case "$c" in 1) execute_action start ;; 2) execute_action stop ;; 3) execute_action restart ;; 4) execute_action ps ;; 5) execute_action logs 0 0 ;; 6) execute_action logs-follow 0 0 ;; 7) execute_action uninstall ;; 8) execute_action reinstall ;; 0|'') return 0 ;; esac
  done
}

submenu_monitoring_text() {
  while true; do
    printf '\n-- Status & Monitoring ------------------------\n'
    printf '%s\n' "$(diag_status_line)"
    printf '1) Health-Checks\n2) Gesamtstatus\n3) Arduino-Status\n4) Arduino verbinden\n5) Arduino trennen\n6) Funktionstests\n0) Zurueck\n\n'
    read -r -p 'Option [0-6]: ' c
    case "$c" in 1) execute_action health 0 0 ;; 2) execute_action status 0 0 ;; 3) execute_action arduino-status 0 0 ;; 4) execute_action arduino-connect ;; 5) execute_action arduino-disconnect ;; 6) execute_action test 0 0 ;; 0|'') return 0 ;; esac
  done
}

# ── Hauptmenü ──────────────────────────────────────────────────────────────

main_menu_whiptail() {
  while true; do
    local choice status_line; status_line="$(menu_status_line)"
    choice="$(whiptail --title "Loewen Dart Dashboard | $(hostname)" --menu "${status_line}\n\nWaehle einen Bereich:\nENTER = oeffnen   ESC = beenden" 20 84 8 \
      "0" "Schnellstart-Assistent (komplette Einrichtung)" \
      "1" "Einrichtung >" \
      "2" "Status & Monitoring >" \
      "3" "Docker >" \
      "4" "Repo in anderen Ordner klonen" \
      "5" "Hilfe fuer Einsteiger" \
      "6" "Beenden" \
      3>&1 1>&2 2>&3)" || exit 0
    case "$choice" in
      0) execute_action quickstart 1 0 ;;
      1) submenu_einrichtung_whiptail ;;
      2) submenu_monitoring_whiptail ;;
      3) submenu_docker_whiptail ;;
      4) execute_action clone 1 0 ;;
      5) execute_action help-guide ;;
      6) printf 'Beendet.\n'; exit 0 ;;
      *) printf 'Ungueltige Auswahl.\n' ;;
    esac
  done
}

main_menu_text() {
  while true; do
    print_header
    printf ' Status: %s\n\n' "$(menu_status_line)"
    printf ' 0) Schnellstart-Assistent\n'
    printf ' 1) Einrichtung >\n'
    printf ' 2) Status & Monitoring >\n'
    printf ' 3) Docker >\n'
    printf ' 4) Repo klonen\n'
    printf ' 5) Hilfe fuer Einsteiger\n'
    printf ' 6) Beenden\n\n'
    read -r -p 'Option [0-6]: ' c
    case "$c" in
      0) execute_action quickstart 1 0 ;;
      1) submenu_einrichtung_text ;;
      2) submenu_monitoring_text ;;
      3) submenu_docker_text ;;
      4) execute_action clone 1 0 ;;
      5) execute_action help-guide ;;
      6) printf 'Beendet.\n'; exit 0 ;;
      *) printf 'Ungueltige Auswahl.\n'; sleep 1 ;;
    esac
  done
}

# ── Start ─────────────────────────────────────────────────────────────────

if [[ "$USE_WHIPTAIL" -eq 1 ]]; then
  main_menu_whiptail
else
  main_menu_text
fi