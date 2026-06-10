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
  printf ' Menue verwaltet die Aktionen, install.sh fuehrt sie aus.\n\n'
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

main_menu_whiptail() {
  while true; do
    local choice
    choice="$(whiptail --title "Loewen Dart Dashboard - Menue" --menu "Bitte Option waehlen" 20 78 10 \
      "0" "Systemcheck + Auto-Installation (Docker/Pi-Tools)" \
      "1" "Install/Update + Build + Start (empfohlen)" \
      "2" "Nur Start (ohne Build)" \
      "3" "Status und Logs anzeigen" \
      "4" "Stoppen" \
      "5" "Repo in anderen Ordner klonen" \
      "6" "Health-Checks ausfuehren" \
      "7" "Beenden" \
      3>&1 1>&2 2>&3)" || exit 0

    case "$choice" in
      0) run_action check ;;
      1) run_action build-start ;;
      2) run_action start ;;
      3) run_action status ;;
      4) run_action stop ;;
      5) run_action clone ;;
      6) run_action health ;;
      7) printf 'Beendet.\n'; exit 0 ;;
      *) printf 'Ungueltige Auswahl.\n' ;;
    esac

    ui_pause
  done
}

main_menu_text() {
  while true; do
    print_header
    printf 'Aktueller Ordner: %s\n\n' "$SCRIPT_DIR"
    printf '0) Systemcheck + Auto-Installation (Docker/Pi-Tools)\n'
    printf '1) Install/Update + Build + Start (empfohlen)\n'
    printf '2) Nur Start (ohne Build)\n'
    printf '3) Status und Logs anzeigen\n'
    printf '4) Stoppen\n'
    printf '5) Repo in anderen Ordner klonen\n'
    printf '6) Health-Checks ausfuehren\n'
    printf '7) Beenden\n\n'

    read -r -p 'Bitte Option waehlen [0-7]: ' choice
    case "$choice" in
      0) run_action check ;;
      1) run_action build-start ;;
      2) run_action start ;;
      3) run_action status ;;
      4) run_action stop ;;
      5) run_action clone ;;
      6) run_action health ;;
      7) printf 'Beendet.\n'; exit 0 ;;
      *) printf 'Ungueltige Auswahl.\n' ;;
    esac
    ui_pause
  done
}

if [[ "$USE_WHIPTAIL" -eq 1 ]]; then
  main_menu_whiptail
else
  main_menu_text
fi
