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
  local docker_cmd="docker" state
  if ! docker info >/dev/null 2>&1; then
    if command_exists sudo && sudo -n docker info >/dev/null 2>&1; then
      docker_cmd="sudo docker"
    else
      printf '%s Docker nicht erreichbar (Berechtigung oder Dienst)' "$(status_badge off)"
      return 0
    fi
  fi
  state="$($docker_cmd inspect -f '{{.State.Status}}' dart-dashboard 2>/dev/null || printf 'nicht gefunden')"
  case "$state" in
    running)   printf '%s Container laeuft' "$(status_badge ok)" ;;
    exited)    printf '%s Container gestoppt' "$(status_badge warn)" ;;
    restarting) printf '%s Container startet neu' "$(status_badge warn)" ;;
    *)         printf '%s Container %s' "$(status_badge off)" "$state" ;;
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
  local port api_base payload client
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
  if printf '%s' "$payload" | grep -Eq '"connected"[[:space:]]*:[[:space:]]*true'; then
    printf '%s Arduino verbunden' "$(status_badge ok)"
  else
    printf '%s Arduino nicht verbunden' "$(status_badge warn)"
  fi
}

branch_menu_status() {
  local branch commit dirty_count
  if ! command_exists git || ! git -C "$SCRIPT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    printf 'Branch unbekannt'
    return 0
  fi
  branch="$(git -C "$SCRIPT_DIR" branch --show-current 2>/dev/null || true)"
  [[ -z "$branch" ]] && branch='detached'
  commit="$(git -C "$SCRIPT_DIR" rev-parse --short HEAD 2>/dev/null || printf '?')"
  dirty_count="$(git -C "$SCRIPT_DIR" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  printf '%s @ %s' "$branch" "$commit"
  if [[ "${dirty_count:-0}" =~ ^[0-9]+$ ]] && (( dirty_count > 0 )); then
    printf ' (+%s lokale Aenderung(en))' "$dirty_count"
  fi
}

menu_status_line()   { printf '%s | %s | %s | %s' "$(docker_menu_status)" "$(api_menu_status)" "$(storage_menu_status)" "$(arduino_menu_status)"; }
docker_status_line() { printf '%s | %s' "$(docker_menu_status)" "$(api_menu_status)"; }
diag_status_line()   { printf '%s | %s | %s' "$(api_menu_status)" "$(storage_menu_status)" "$(arduino_menu_status)"; }

print_line() { printf '%s\n' "------------------------------------------------------------"; }

print_header() {
  clear || true; print_line
  printf ' Loewen Dart Dashboard - Menue\n'; print_line
  printf ' Branch: %s\n' "$(branch_menu_status)"
  printf ' Live-Spielstand, Spieler, Highscores & Arduino\n\n'
}

run_action() { "$INSTALL_SCRIPT" "$1"; }

action_label() {
  case "$1" in
    quickstart)         printf 'Schnellstart-Assistent' ;;
    check)              printf 'Systemcheck + Auto-Installation' ;;
    pin-hash)           printf 'Admin-PIN-Assistent' ;;
    system-update)      printf 'Systempakete aktualisieren' ;;
    raspi-update)       printf 'Raspberry-Pi-Firmware (erweitert) aktualisieren' ;;
    build-start)        printf 'Install/Update + Build + Start' ;;
    dev-build-start)    printf 'Dev-Pull + Build + Start' ;;
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
    overview)           printf 'Einrichtungsstatus & Versionen' ;;
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
  local action="$1" error_file="${2:-}" exit_code="${3:-1}" details='Keine weiteren Details vorhanden.' action_command
  if [[ -n "$error_file" && -f "$error_file" ]]; then
    details="$(tail -n 120 "$error_file" 2>/dev/null || true)"
    [[ -z "$details" ]] && details='Die Aktion hat keine Ausgabe erzeugt.'
  fi
  action_command="./install.sh ${action}"
  {
    printf 'Aktion fehlgeschlagen: %s\n' "$(action_label "$action")"
    printf 'Exit-Code: %s\n' "$exit_code"
    printf 'Zeitpunkt: %s\n\n' "$(date '+%Y-%m-%d %H:%M:%S' 2>/dev/null || printf 'unbekannt')"
    printf 'Letzte Meldungen:\n%s\n\n' "$details"
    printf 'Manuell wiederholen mit:\n%s\n' "$action_command"
  } > "${error_file}.display" 2>/dev/null || true
  local display_file="${error_file}.display"
  if [[ "$USE_WHIPTAIL" -eq 1 ]]; then
    whiptail --title "Fehlerdiagnose" --scrolltext --textbox "$display_file" 26 100
  else
    msg_fail "Aktion fehlgeschlagen: $(action_label "$action") (Exit-Code ${exit_code})"
    printf '%s\n' "$details"
    printf '\nManuell wiederholen mit: %s\n' "$action_command"
    ui_pause
  fi
  rm -f "$display_file" 2>/dev/null || true
}

execute_action() {
  local action="$1" pause_after="${2:-1}" label
  label="$(action_label "$action")"; msg_run "$label"

  local tmp action_status
  tmp="$(mktemp)"
  set +e
  run_action "$action" 2>&1 | tee "$tmp"
  action_status="${PIPESTATUS[0]}"
  set -e

  if [[ "$action_status" -ne 0 ]]; then
    show_action_error "$action" "$tmp" "$action_status" || true
    rm -f "$tmp"
    msg_warn 'Das Menue bleibt geoeffnet. Details stehen in der Fehleranzeige.'
    return 0
  fi
  rm -f "$tmp"
  if [[ "$pause_after" -eq 1 ]]; then show_action_success "$action" || true; fi
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
    choice="$(whiptail --title "Loewen Dart | Einrichtung" --menu "$(printf 'Empfohlen: komplette Einrichtung. Alternativ nur Voraussetzungen installieren.\n\nENTER = ausfuehren   ESC = zurueck')" 18 84 5 \
      "1" "Komplette Einrichtung (empfohlen)" \
      "2" "Nur Systemvoraussetzungen pruefen/installieren" \
      "0" "Zurueck" \
      3>&1 1>&2 2>&3)" || return 0
    case "$choice" in
      1) execute_action quickstart ;;
      2) execute_action check ;;
      0|"") return 0 ;;
    esac
  done
}

submenu_updates_whiptail() {
  while true; do
    local choice
    choice="$(whiptail --title "Loewen Dart | Updates" --menu "Raspberry Pi OS oder Dashboard aktualisieren.\nDie Testversion ist nur fuer Tests gedacht.\n\nENTER = ausfuehren   ESC = zurueck" 18 84 5 \
      "1" "Raspberry Pi OS: normale Paketupdates" \
      "2" "Dashboard: stabile Version installieren/aktualisieren" \
      "3" "Dashboard: Testversion (Dev-Branch, erweitert)" \
      "0" "Zurueck" \
      3>&1 1>&2 2>&3)" || return 0
    case "$choice" in
      1) execute_action system-update 0 ;;
      2) execute_action build-start ;;
      3) execute_action dev-build-start 1 0 ;;
      0|"") return 0 ;;
    esac
  done
}

submenu_docker_whiptail() {
  while true; do
    local choice status_line; status_line="$(docker_status_line)"
    choice="$(whiptail --title "Loewen Dart | Container verwalten" --menu "${status_line}\n\nContainer starten, stoppen oder Logs pruefen.\nNeuinstallation entfernt den Container und das Image, Daten bleiben erhalten.\n\nENTER = ausfuehren   ESC = zurueck" 20 88 7 \
      "1" "Container starten" \
      "2" "Container stoppen" \
      "3" "Container neu starten" \
      "4" "Letzte Container-Logs anzeigen" \
      "5" "Container-Logs live verfolgen (Ctrl+C)" \
      "6" "Container + Image entfernen (Daten bleiben)" \
      "7" "Neu installieren (Entfernen + Neuaufbau)" \
      "0" "Zurueck" \
      3>&1 1>&2 2>&3)" || return 0
    case "$choice" in
      1) execute_action start ;;
      2) execute_action stop ;;
      3) execute_action restart ;;
      4) execute_action logs 0 ;;
      5) execute_action logs-follow 0 ;;
      6) execute_action uninstall ;;
      7) execute_action reinstall ;;
      0|"") return 0 ;;
    esac
  done
}

submenu_monitoring_whiptail() {
  while true; do
    local choice status_line; status_line="$(diag_status_line)"
    choice="$(whiptail --title "Loewen Dart | Status & Arduino" --menu "${status_line}\n\nSystem pruefen und Arduino-Verbindung verwalten.\n\nENTER = ausfuehren   ESC = zurueck" 20 84 7 \
      "1" "Systemdiagnose (Schnellcheck)" \
      "2" "Detaillierten Gesamtstatus anzeigen" \
      "3" "Arduino-Verbindung pruefen" \
      "4" "Arduino verbinden / neu verbinden" \
      "5" "Arduino trennen" \
      "6" "Gefuehrte Funktionstests" \
      "0" "Zurueck" \
      3>&1 1>&2 2>&3)" || return 0
    case "$choice" in
      1) execute_action health 0 ;; 2) execute_action status 0 ;;
      3) execute_action arduino-status 0 ;; 4) execute_action arduino-connect ;;
      5) execute_action arduino-disconnect ;; 6) execute_action test 0 ;;
      0|"") return 0 ;; esac
  done
}

# ── Text-Menüs (Fallback ohne whiptail) ────────────────────────────────────

submenu_einrichtung_text() {
  while true; do
    printf '\n-- Einrichtung --------------------------------\n'
    printf '1) Schnellstart-Assistent (komplette Einrichtung)\n'
    printf '2) Systemcheck + Auto-Installation\n'
    printf '0) Zurueck\n\n'
    read -r -p 'Option [0-2]: ' c
    case "$c" in
      1) execute_action quickstart ;;
      2) execute_action check ;;
      0|'') return 0 ;;
    esac
  done
}

submenu_updates_text() {
  while true; do
    printf '\n-- Updates ------------------------------------\n'
    printf '1) Raspberry Pi OS: normale Paketupdates\n'
    printf '2) Dashboard: stabile Version installieren/aktualisieren\n'
    printf '3) Dashboard: Testversion (Dev-Branch, erweitert) (%s)\n' "${DART_DEV_BRANCH:-refactor-central-data}"
    printf '0) Zurueck\n\n'
    read -r -p 'Option [0-3]: ' c
    case "$c" in
      1) execute_action system-update 0 ;;
      2) execute_action build-start ;;
      3) execute_action dev-build-start 1 0 ;;
      0|'') return 0 ;;
    esac
  done
}

submenu_docker_text() {
  while true; do
    printf '\n-- Container verwalten ------------------------\n'
    printf '%s\n' "$(docker_status_line)"
    printf 'Container starten, stoppen oder Logs pruefen.\nNeuinstallation entfernt Container und Image, Daten bleiben erhalten.\n\n'
    printf '1) Container starten\n2) Container stoppen\n3) Container neu starten\n4) Letzte Container-Logs anzeigen\n5) Container-Logs live verfolgen (Ctrl+C)\n6) Container + Image entfernen (Daten bleiben)\n7) Neu installieren (Entfernen + Neuaufbau)\n0) Zurueck\n\n'
    read -r -p 'Option [0-7]: ' c
    case "$c" in
      1) execute_action start ;;
      2) execute_action stop ;;
      3) execute_action restart ;;
      4) execute_action logs 0 ;;
      5) execute_action logs-follow 0 ;;
      6) execute_action uninstall ;;
      7) execute_action reinstall ;;
      0|'') return 0 ;;
    esac
  done
}

submenu_monitoring_text() {
  while true; do
    printf '\n-- Status & Arduino ---------------------------\n'
    printf '%s\n' "$(diag_status_line)"
    printf '1) Systemdiagnose (Schnellcheck)\n2) Detaillierten Gesamtstatus anzeigen\n3) Arduino-Verbindung pruefen\n4) Arduino verbinden / neu verbinden\n5) Arduino trennen\n6) Detaillierte Funktionstests\n0) Zurueck\n\n'
    read -r -p 'Option [0-6]: ' c
    case "$c" in 1) execute_action health 0 ;; 2) execute_action status 0 ;; 3) execute_action arduino-status 0 ;; 4) execute_action arduino-connect ;; 5) execute_action arduino-disconnect ;; 6) execute_action test 0 ;; 0|'') return 0 ;; esac
  done
}

submenu_system_whiptail() {
  while true; do
    local choice
    choice="$(whiptail --title "Loewen Dart | Sicherheit & Systempflege" --menu "PIN einrichten oder erweiterte Wartung starten.\nFirmware-Updates sind optional und koennen einen Neustart erfordern.\n\nENTER = ausfuehren   ESC = zurueck" 18 88 5 \
      "1" "Admin-PIN einrichten/aendern" \
      "2" "Raspberry-Pi-Firmware aktualisieren (erweitert)" \
      "3" "Repo in einen anderen Ordner klonen" \
      "0" "Zurueck" \
      3>&1 1>&2 2>&3)" || return 0
    case "$choice" in
      1) execute_action pin-hash ;;
      2) execute_action raspi-update 0 ;;
      3) execute_action clone ;;
      0|"") return 0 ;;
    esac
  done
}

submenu_system_text() {
  while true; do
    printf '\n-- Sicherheit & Systempflege ------------------\n'
    printf 'PIN einrichten oder erweiterte Wartung starten.\n'
    printf 'Firmware-Updates sind optional und koennen einen Neustart erfordern.\n\n'
    printf '1) Admin-PIN einrichten/aendern\n'
    printf '2) Raspberry-Pi-Firmware aktualisieren (erweitert)\n'
    printf '3) Repo in einen anderen Ordner klonen\n'
    printf '0) Zurueck\n\n'
    read -r -p 'Option [0-3]: ' c
    case "$c" in
      1) execute_action pin-hash ;;
      2) execute_action raspi-update 0 ;;
      3) execute_action clone ;;
      0|"") return 0 ;;
    esac
  done
}

# ── Hauptmenü ──────────────────────────────────────────────────────────────

main_menu_whiptail() {
  while true; do
    local choice status_line; status_line="$(menu_status_line)"
    choice="$(whiptail --title "Loewen Dart Dashboard | $(hostname)" --menu "${status_line}\nBranch: $(branch_menu_status)\n\nWaehle einen Bereich:\nENTER = oeffnen   ESC = beenden" 22 88 9 \
      "1" "Einrichtung >" \
      "2" "Updates >" \
      "3" "Status & Monitoring >" \
      "4" "Einrichtungsstatus & Versionen" \
      "5" "Container verwalten >" \
      "6" "Sicherheit & Systempflege >" \
      "7" "Hilfe fuer Einsteiger" \
      "8" "Beenden" \
      3>&1 1>&2 2>&3)" || exit 0
    case "$choice" in
      1) submenu_einrichtung_whiptail ;;
      2) submenu_updates_whiptail ;;
      3) submenu_monitoring_whiptail ;;
      4) execute_action overview 0 ;;
      5) submenu_docker_whiptail ;;
      6) submenu_system_whiptail ;;
      7) execute_action help-guide ;;
      8) printf 'Beendet.\n'; exit 0 ;;
      *) printf 'Ungueltige Auswahl.\n' ;;
    esac
  done
}

main_menu_text() {
  while true; do
    print_header
    printf ' Status: %s\n\n' "$(menu_status_line)"
    printf ' 1) Einrichtung >\n'
    printf ' 2) Updates >\n'
    printf ' 3) Status & Monitoring >\n'
    printf ' 4) Einrichtungsstatus & Versionen\n'
    printf ' 5) Container verwalten >\n'
    printf ' 6) Sicherheit & Systempflege >\n'
    printf ' 7) Hilfe fuer Einsteiger\n'
    printf ' 8) Beenden\n\n'
    read -r -p 'Option [1-8]: ' c
    case "$c" in
      1) submenu_einrichtung_text ;;
      2) submenu_updates_text ;;
      3) submenu_monitoring_text ;;
      4) execute_action overview 0 ;;
      5) submenu_docker_text ;;
      6) submenu_system_text ;;
      7) execute_action help-guide ;;
      8) printf 'Beendet.\n'; exit 0 ;;
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