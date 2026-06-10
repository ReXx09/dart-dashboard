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

ui_pause() {
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
    1) run_action check ; ui_pause ;;
    2) run_action build-start ; ui_pause ;;
  esac
}

submenu_docker_whiptail() {
  local choice
  choice="$(whiptail --title "Docker" --menu "Docker-Verwaltung" 18 72 7 \
    "1" "Start" \
    "2" "Stop" \
    "3" "Restart" \
    "4" "ps  (Status anzeigen)" \
    "5" "Logs anzeigen" \
    "6" "Uninstall  (Container + Image entfernen)" \
    "7" "Reinstall  (Uninstall + Neustart)" \
    "8" "Zurueck" \
    3>&1 1>&2 2>&3)" || return 0
  case "$choice" in
    1) run_action start ; ui_pause ;;
    2) run_action stop ; ui_pause ;;
    3) run_action restart ; ui_pause ;;
    4) run_action ps ; ui_pause ;;
    5) run_action logs ; ui_pause ;;
    6) run_action uninstall ; ui_pause ;;
    7) run_action reinstall ; ui_pause ;;
  esac
}

submenu_diagnose_whiptail() {
  local choice
  choice="$(whiptail --title "Diagnose" --menu "Diagnose & Checks" 16 72 5 \
    "1" "Health-Checks (API / Storage / Arduino / Fire-TV)" \
    "2" "Gefuehrte Funktionstests  (Schritt fuer Schritt)" \
    "3" "Gesamtstatus  (Compose + Logs + Netz)" \
    "4" "Zurueck" \
    3>&1 1>&2 2>&3)" || return 0
  case "$choice" in
    1) run_action health ; ui_pause ;;
    2) run_action test ; ui_pause ;;
    3) run_action status ; ui_pause ;;
  esac
}

# ── Hauptmenue whiptail ────────────────────────────────────────────────────

main_menu_whiptail() {
  while true; do
    local choice
    choice="$(whiptail --title "Loewen Dart Dashboard" --menu "Hauptmenue" 18 72 8 \
      "0" "Schnellstart-Assistent  (komplette Einrichtung)" \
      "1" "Einrichtung  >" \
      "2" "Docker  >" \
      "3" "Diagnose  >" \
      "4" "Repo: in anderen Ordner klonen" \
      "5" "Hilfe fuer Einsteiger" \
      "6" "Beenden" \
      3>&1 1>&2 2>&3)" || exit 0

    case "$choice" in
      0) run_action quickstart ; ui_pause ;;
      1) submenu_einrichtung_whiptail ;;
      2) submenu_docker_whiptail ;;
      3) submenu_diagnose_whiptail ;;
      4) run_action clone ; ui_pause ;;
      5) run_action help-guide ; ui_pause ;;
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
    1) run_action check ; ui_pause ;;
    2) run_action build-start ; ui_pause ;;
  esac
}

submenu_docker_text() {
  printf '\n-- Docker -------------------------------------\n'
  printf '1) Start\n'
  printf '2) Stop\n'
  printf '3) Restart\n'
  printf '4) ps\n'
  printf '5) Logs\n'
  printf '6) Uninstall\n'
  printf '7) Reinstall\n'
  printf '0) Zurueck\n\n'
  read -r -p 'Option [0-7]: ' c
  case "$c" in
    1) run_action start ; ui_pause ;;
    2) run_action stop ; ui_pause ;;
    3) run_action restart ; ui_pause ;;
    4) run_action ps ; ui_pause ;;
    5) run_action logs ; ui_pause ;;
    6) run_action uninstall ; ui_pause ;;
    7) run_action reinstall ; ui_pause ;;
  esac
}

submenu_diagnose_text() {
  printf '\n-- Diagnose -----------------------------------\n'
  printf '1) Health-Checks\n'
  printf '2) Gefuehrte Funktionstests\n'
  printf '3) Gesamtstatus\n'
  printf '0) Zurueck\n\n'
  read -r -p 'Option [0-3]: ' c
  case "$c" in
    1) run_action health ; ui_pause ;;
    2) run_action test ; ui_pause ;;
    3) run_action status ; ui_pause ;;
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
      0) run_action quickstart ; ui_pause ;;
      1) submenu_einrichtung_text ;;
      2) submenu_docker_text ;;
      3) submenu_diagnose_text ;;
      4) run_action clone ; ui_pause ;;
      5) run_action help-guide ; ui_pause ;;
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
