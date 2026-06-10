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
  printf ' Einsteiger-Modus: Pruefen, Einrichten, Aktualisieren, Testen.\n\n'
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
      "0" "Schnellstart-Assistent (empfohlen fuer neue Nutzer)" \
      "1" "Systemcheck + Auto-Installation" \
      "2" "Install/Update + Build + Start" \
      "3" "Nur Start (ohne Build)" \
      "4" "Health-Checks ausfuehren" \
      "5" "Gefuehrte Funktionstests (Schritt fuer Schritt)" \
      "6" "Status und Logs anzeigen" \
      "7" "Stoppen" \
      "8" "Repo in anderen Ordner klonen" \
      "9" "Hilfe fuer Einsteiger anzeigen" \
      "10" "Beenden" \
      3>&1 1>&2 2>&3)" || exit 0

    case "$choice" in
      0) run_action quickstart ;;
      1) run_action check ;;
      2) run_action build-start ;;
      3) run_action start ;;
      4) run_action health ;;
      5) run_action test ;;
      6) run_action status ;;
      7) run_action stop ;;
      8) run_action clone ;;
      9) run_action help-guide ;;
      10) printf 'Beendet.\n'; exit 0 ;;
      *) printf 'Ungueltige Auswahl.\n' ;;
    esac

    ui_pause
  done
}

main_menu_text() {
  while true; do
    print_header
    printf 'Aktueller Ordner: %s\n\n' "$SCRIPT_DIR"
    printf '0) Schnellstart-Assistent (empfohlen fuer neue Nutzer)\n'
    printf '1) Systemcheck + Auto-Installation\n'
    printf '2) Install/Update + Build + Start\n'
    printf '3) Nur Start (ohne Build)\n'
    printf '4) Health-Checks ausfuehren\n'
    printf '5) Gefuehrte Funktionstests (Schritt fuer Schritt)\n'
    printf '6) Status und Logs anzeigen\n'
    printf '7) Stoppen\n'
    printf '8) Repo in anderen Ordner klonen\n'
    printf '9) Hilfe fuer Einsteiger anzeigen\n'
    printf '10) Beenden\n\n'

    read -r -p 'Bitte Option waehlen [0-10]: ' choice
    case "$choice" in
      0) run_action quickstart ;;
      1) run_action check ;;
      2) run_action build-start ;;
      3) run_action start ;;
      4) run_action health ;;
      5) run_action test ;;
      6) run_action status ;;
      7) run_action stop ;;
      8) run_action clone ;;
      9) run_action help-guide ;;
      10) printf 'Beendet.\n'; exit 0 ;;
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
