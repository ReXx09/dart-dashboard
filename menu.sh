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

status_badge() {
  local state="$1"
  case "$state" in
    ok) printf '[OK]' ;;
    warn) printf '[WARN]' ;;
    off) printf '[OFF]' ;;
    *) printf '[INFO]' ;;
  esac
}

docker_menu_status() {
  if ! command_exists docker; then
    printf '%s Docker fehlt' "$(status_badge off)"
    return 0
  fi

  local state
  state="$(docker inspect -f '{{.State.Status}}' dart-dashboard 2>/dev/null || printf 'nicht gefunden')"
  case "$state" in
    running) printf '%s Container running' "$(status_badge ok)" ;;
    exited) printf '%s Container exited' "$(status_badge warn)" ;;
    restarting) printf '%s Container restarting' "$(status_badge warn)" ;;
    *) printf '%s Container %s' "$(status_badge off)" "$state" ;;
  esac
}

api_menu_status() {
  if ! command_exists curl; then
    printf '%s API curl fehlt' "$(status_badge off)"
    return 0
  fi

  local port api_base
  port="$(get_env_value_local PUBLIC_PORT 3100)"
  api_base="http://localhost:${port}"

  if curl -fsS --max-time 2 "${api_base}/api/live/state" >/dev/null 2>&1; then
    printf '%s API erreichbar' "$(status_badge ok)"
  else
    printf '%s API nicht erreichbar' "$(status_badge off)"
  fi
}

storage_menu_status() {
  if ! command_exists curl; then
    printf '%s DB unbekannt' "$(status_badge off)"
    return 0
  fi

  local port api_base payload client external mode
  port="$(get_env_value_local PUBLIC_PORT 3100)"
  api_base="http://localhost:${port}"
  payload="$(curl -fsS --max-time 2 "${api_base}/api/storage/info" 2>/dev/null || true)"
  if [[ -z "$payload" ]]; then
    printf '%s DB offline' "$(status_badge off)"
    return 0
  fi

  client="$(printf '%s' "$payload" | sed -n 's/.*"client"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
  external="$(printf '%s' "$payload" | sed -n 's/.*"external"[[:space:]]*:[[:space:]]*\(true\|false\).*/\1/p' | head -n 1)"
  [[ -z "$client" ]] && client='unknown'
  [[ "$external" == "true" ]] && mode='extern' || mode='lokal'
  printf '%s DB %s (%s)' "$(status_badge ok)" "$client" "$mode"
}

arduino_menu_status() {
  if ! command_exists curl; then
    printf '%s Arduino unbekannt' "$(status_badge off)"
    return 0
  fi

  local port api_base payload connected
  port="$(get_env_value_local PUBLIC_PORT 3100)"
  api_base="http://localhost:${port}"
  payload="$(curl -fsS --max-time 2 "${api_base}/api/arduino/state" 2>/dev/null || true)"
  if [[ -z "$payload" ]]; then
    printf '%s Arduino offline' "$(status_badge off)"
    return 0
  fi

  connected="$(printf '%s' "$payload" | sed -n 's/.*"connected"[[:space:]]*:[[:space:]]*\(true\|false\).*/\1/p' | head -n 1)"
  if [[ "$connected" == "true" ]]; then
    printf '%s Arduino connected' "$(status_badge ok)"
  else
    printf '%s Arduino disconnected' "$(status_badge warn)"
  fi
}

menu_status_line() {
  printf '%s | %s | %s | %s' "$(docker_menu_status)" "$(api_menu_status)" "$(storage_menu_status)" "$(arduino_menu_status)"
}

menu_subtitle() {
  local heading="$1"
  printf '%s\n\nENTER = ausfuehren   ESC = zurueck' "$heading"
}

docker_status_line() {
  printf '%s | %s' "$(docker_menu_status)" "$(api_menu_status)"
}

diagnostics_status_line() {
  printf '%s | %s | %s' "$(api_menu_status)" "$(storage_menu_status)" "$(arduino_menu_status)"
}

monitoring_status_line() {
  printf '%s | %s | %s' "$(docker_menu_status)" "$(api_menu_status)" "$(storage_menu_status)"
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
    arduino-status) printf 'Arduino-Status' ;;
    arduino-connect) printf 'Arduino verbinden / neu verbinden' ;;
    arduino-disconnect) printf 'Arduino trennen' ;;
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
    whiptail --title "Erfolg" --msgbox "Aktion erfolgreich:\n${label}\n\nMit OK zur vorherigen Menueebene." 11 72
  else
    printf '\n[OK] Aktion erfolgreich: %s\n' "$label"
    printf 'Weiter mit Enter zur vorherigen Menueebene...\n'
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

default_action_pause() {
  local action="$1"
  case "$action" in
    logs|logs-follow|status|health|test|arduino-status)
      printf '0'
      ;;
    *)
      printf '1'
      ;;
  esac
}

default_action_capture_mode() {
  local action="$1"
  case "$action" in
    logs|logs-follow|status|health|test|arduino-status)
      # Diese Aktionen haben eigene UI/Streaming-Ausgabe.
      printf '0'
      ;;
    *)
      # Standard: live anzeigen UND fuer Fehlerdiagnose mitschneiden.
      printf '2'
      ;;
  esac
}

execute_action() {
  local action="$1"
  local pause_after="${2:-$(default_action_pause "$action")}" 
  local capture_output="${3:-$(default_action_capture_mode "$action")}" 

  if [[ "$capture_output" -eq 0 ]]; then
    if ! run_action "$action"; then
      show_action_error "$action"
      return 1
    fi
  elif [[ "$capture_output" -eq 2 ]]; then
    local tmp_output
    tmp_output="$(mktemp)"
    if ! run_action "$action" 2>&1 | tee "$tmp_output"; then
      show_action_error "$action" "$tmp_output"
      rm -f "$tmp_output"
      return 1
    fi
    rm -f "$tmp_output"
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
  while true; do
    local choice
    choice="$(whiptail --title "Loewen Dart | Einrichtung" --menu "$(menu_subtitle 'System vorbereiten oder den Dienst neu bauen und starten.')" 18 78 6 \
      "1" "Systemcheck + Auto-Installation" \
      "2" "Install/Update + Build + Start" \
      "0" "Zurueck" \
      3>&1 1>&2 2>&3)" || return 0
    case "$choice" in
      1) execute_action check 1 0 ;;
      2) execute_action build-start 1 0 ;;
      0|"") return 0 ;;
    esac
  done
}

submenu_docker_whiptail() {
  while true; do
    local choice
    local status_line
    status_line="$(docker_status_line)"
    choice="$(whiptail --title "Loewen Dart | Docker" --menu "${status_line}\n\n$(menu_subtitle 'Container steuern, Logs ansehen oder den Dienst sauber neu aufsetzen.')" 22 82 9 \
      "1" "Start" \
      "2" "Stop" \
      "3" "Restart" \
      "4" "ps  (Status anzeigen)" \
      "5" "Logs anzeigen  (Snapshot)" \
      "6" "Logs verfolgen  (Live, Ctrl+C)" \
      "7" "Uninstall  (Container + Image entfernen)" \
      "8" "Reinstall  (Uninstall + Neustart)" \
      "0" "Zurueck" \
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
      0|"") return 0 ;;
    esac
  done
}

submenu_monitoring_whiptail() {
  while true; do
    local choice
    local status_line
    status_line="$(monitoring_status_line)"
    choice="$(whiptail --title "Loewen Dart | Status & Monitoring" --menu "${status_line}\n\n$(menu_subtitle 'Status pruefen, Gesamtansicht oeffnen oder Logs direkt beobachten.')" 24 84 10 \
      "1" "Gesamtstatus  (Compose + Logs + Netz)" \
      "2" "Container Status (ps)" \
      "3" "Schnell-Diagnose (Health-Checks)" \
      "4" "Arduino-Status" \
      "5" "Arduino verbinden / neu verbinden" \
      "6" "Arduino trennen" \
      "7" "Docker-Logs Snapshot" \
      "8" "Docker-Logs Live (Ctrl+C)" \
      "0" "Zurueck" \
      3>&1 1>&2 2>&3)" || return 0
    case "$choice" in
      1) execute_action status 0 0 ;;
      2) execute_action ps ;;
      3) execute_action health 0 0 ;;
      4) execute_action arduino-status 0 0 ;;
      5) execute_action arduino-connect ;;
      6) execute_action arduino-disconnect ;;
      7) execute_action logs 0 0 ;;
      8) execute_action logs-follow 0 0 ;;
      0|"") return 0 ;;
    esac
  done
}

submenu_diagnose_advanced_whiptail() {
  while true; do
    local choice
    local status_line
    status_line="$(diagnostics_status_line)"
    choice="$(whiptail --title "Loewen Dart | Diagnose (Erweitert)" --menu "${status_line}\n\n$(menu_subtitle 'Detailansichten fuer Status, Logs und Schritt-fuer-Schritt-Tests.')" 21 82 8 \
      "1" "Gefuehrte Funktionstests  (Schritt fuer Schritt)" \
      "2" "Gesamtstatus  (Compose + Logs + Netz)" \
      "3" "Docker-Logs Snapshot" \
      "4" "Docker-Logs Live (Ctrl+C)" \
      "0" "Zurueck" \
      3>&1 1>&2 2>&3)" || return 0
    case "$choice" in
      1) execute_action test 0 0 ;;
      2) execute_action status 0 0 ;;
      3) execute_action logs 0 0 ;;
      4) execute_action logs-follow 0 0 ;;
      0|"") return 0 ;;
    esac
  done
}

submenu_diagnose_whiptail() {
  while true; do
    local choice
    local status_line
    status_line="$(diagnostics_status_line)"
    choice="$(whiptail --title "Loewen Dart | Diagnose" --menu "${status_line}\n\n$(menu_subtitle 'Erst Schnell-Diagnose, danach bei Bedarf in die Detailansicht wechseln.')" 19 82 6 \
      "1" "Schnell-Diagnose (Health-Checks, empfohlen)" \
      "2" "Erweiterte Diagnose  >" \
      "0" "Zurueck" \
      3>&1 1>&2 2>&3)" || return 0
    case "$choice" in
      1) execute_action health 0 0 ;;
      2) submenu_diagnose_advanced_whiptail ;;
      0|"") return 0 ;;
    esac
  done
}

# ── Hauptmenue whiptail ────────────────────────────────────────────────────

main_menu_whiptail() {
  while true; do
    local choice
    local status_line
    status_line="$(menu_status_line)"

    choice="$(whiptail --title "Loewen Dart Dashboard | $(hostname)" --menu "${status_line}\n\nWaehle einen Bereich:\nENTER = oeffnen   ESC = beenden" 22 86 9 \
      "0" "Schnellstart-Assistent  (komplette Einrichtung)" \
      "1" "Einrichtung  >" \
      "2" "Status & Monitoring  >" \
      "3" "Docker  >" \
      "4" "Diagnose  >" \
      "5" "Repo: in anderen Ordner klonen" \
      "6" "Hilfe fuer Einsteiger" \
      "7" "Beenden" \
      3>&1 1>&2 2>&3)" || exit 0

    case "$choice" in
      0) execute_action quickstart 1 0 ;;
      1) submenu_einrichtung_whiptail ;;
      2) submenu_monitoring_whiptail ;;
      3) submenu_docker_whiptail ;;
      4) submenu_diagnose_whiptail ;;
      5) execute_action clone 1 0 ;;
      6) execute_action help-guide ;;
      7) printf 'Beendet.\n'; exit 0 ;;
      *) printf 'Ungueltige Auswahl.\n' ;;
    esac
  done
}

# ── Hauptmenue Text (Fallback ohne whiptail) ───────────────────────────────

submenu_einrichtung_text() {
  while true; do
    printf '\n-- Einrichtung --------------------------------\n'
    printf 'System vorbereiten oder den Dienst neu bauen und starten.\n'
    printf '1) Systemcheck + Auto-Installation\n'
    printf '2) Install/Update + Build + Start\n'
    printf '0) Zurueck\n\n'
    read -r -p 'Option [0-2]: ' c
    case "$c" in
      1) execute_action check 1 0 ;;
      2) execute_action build-start 1 0 ;;
      0|'') return 0 ;;
    esac
  done
}

submenu_docker_text() {
  while true; do
    printf '\n-- Docker -------------------------------------\n'
    printf '%s\n' "$(docker_status_line)"
    printf 'Container steuern, Logs ansehen oder den Dienst sauber neu aufsetzen.\n'
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
      0|'') return 0 ;;
    esac
  done
}

submenu_monitoring_text() {
  while true; do
    printf '\n-- Status & Monitoring ------------------------\n'
    printf '%s\n' "$(monitoring_status_line)"
    printf 'Status pruefen, Gesamtansicht oeffnen oder Logs direkt beobachten.\n'
    printf '1) Gesamtstatus\n'
    printf '2) Container Status (ps)\n'
    printf '3) Schnell-Diagnose (Health-Checks)\n'
    printf '4) Arduino-Status\n'
    printf '5) Arduino verbinden / neu verbinden\n'
    printf '6) Arduino trennen\n'
    printf '7) Docker-Logs (Snapshot)\n'
    printf '8) Docker-Logs (Live)\n'
    printf '0) Zurueck\n\n'
    read -r -p 'Option [0-8]: ' c
    case "$c" in
      1) execute_action status 0 0 ;;
      2) execute_action ps ;;
      3) execute_action health 0 0 ;;
      4) execute_action arduino-status 0 0 ;;
      5) execute_action arduino-connect ;;
      6) execute_action arduino-disconnect ;;
      7) execute_action logs 0 0 ;;
      8) execute_action logs-follow 0 0 ;;
      0|'') return 0 ;;
    esac
  done
}

submenu_diagnose_advanced_text() {
  while true; do
    printf '\n-- Diagnose (Erweitert) ------------------------\n'
    printf '%s\n' "$(diagnostics_status_line)"
    printf 'Detailansichten fuer Status, Logs und Schritt-fuer-Schritt-Tests.\n'
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
      0|'') return 0 ;;
    esac
  done
}

submenu_diagnose_text() {
  while true; do
    printf '\n-- Diagnose -----------------------------------\n'
    printf '%s\n' "$(diagnostics_status_line)"
    printf 'Erst Schnell-Diagnose, danach bei Bedarf in die Detailansicht wechseln.\n'
    printf '1) Schnell-Diagnose (Health-Checks)\n'
    printf '2) Erweiterte Diagnose >\n'
    printf '0) Zurueck\n\n'
    read -r -p 'Option [0-2]: ' c
    case "$c" in
      1) execute_action health 0 0 ;;
      2) submenu_diagnose_advanced_text ;;
      0|'') return 0 ;;
    esac
  done
}

main_menu_text() {
  while true; do
    print_header
    printf '%s\n\n' "$(menu_status_line)"
    printf 'Aktueller Ordner: %s\n\n' "$SCRIPT_DIR"
    printf '0) Schnellstart-Assistent\n'
    printf '1) Einrichtung >\n'
    printf '2) Status & Monitoring >\n'
    printf '3) Docker >\n'
    printf '4) Diagnose >\n'
    printf '5) Repo: klonen\n'
    printf '6) Hilfe\n'
    printf '7) Beenden\n\n'
    read -r -p 'Option [0-7]: ' choice
    case "$choice" in
      0) execute_action quickstart 1 0 ;;
      1) submenu_einrichtung_text ;;
      2) submenu_monitoring_text ;;
      3) submenu_docker_text ;;
      4) submenu_diagnose_text ;;
      5) execute_action clone 1 0 ;;
      6) execute_action help-guide ;;
      7) printf 'Beendet.\n'; exit 0 ;;
      *) printf 'Ungueltige Auswahl.\n' ;;
    esac
  done
}

if [[ "$USE_WHIPTAIL" -eq 1 ]]; then
  main_menu_whiptail
else
  main_menu_text
fi
