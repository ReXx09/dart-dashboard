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

main_menu_whiptail() {
  while true; do
    local choice
    choice="$(whiptail --title "Loewen Dart Dashboard - Menue" --menu "Bitte Bereich waehlen" 24 84 16 \
      "0" "Schnellstart-Assistent (komplette Einrichtung)" \
      "1" "Einrichtung: Systemcheck + Auto-Installation" \
      "2" "Einrichtung: Install/Update + Build + Start" \
      "3" "Docker: Start" \
      "4" "Docker: Stop" \
      "5" "Docker: Restart" \
      "6" "Docker: ps" \
      "7" "Docker: Logs" \
      "8" "Docker: Uninstall (Container + Image entfernen)" \
      "9" "Docker: Reinstall (Uninstall + Neustart)" \
      "10" "Diagnose: Health-Checks" \
      "11" "Diagnose: Gefuehrte Funktionstests" \
      "12" "Diagnose: Gesamtstatus" \
      "13" "Repo: in anderen Ordner klonen" \
      "14" "Hilfe fuer Einsteiger anzeigen" \
      "15" "Beenden" \
      3>&1 1>&2 2>&3)" || exit 0

    case "$choice" in
      0) run_action quickstart ;;
      1) run_action check ;;
      2) run_action build-start ;;
      3) run_action start ;;
      4) run_action stop ;;
      5) run_action restart ;;
      6) run_action ps ;;
      7) run_action logs ;;
      8) run_action uninstall ;;
      9) run_action reinstall ;;
      10) run_action health ;;
      11) run_action test ;;
      12) run_action status ;;
      13) run_action clone ;;
      14) run_action help-guide ;;
      15) printf 'Beendet.\n'; exit 0 ;;
      *) printf 'Ungueltige Auswahl.\n' ;;
    esac

    ui_pause
  done
}

main_menu_text() {
  while true; do
    print_header
    printf 'Aktueller Ordner: %s\n\n' "$SCRIPT_DIR"
    printf '0) Schnellstart-Assistent (komplette Einrichtung)\n'
    printf '1) Einrichtung: Systemcheck + Auto-Installation\n'
    printf '2) Einrichtung: Install/Update + Build + Start\n'
    printf '3) Docker: Start\n'
    printf '4) Docker: Stop\n'
    printf '5) Docker: Restart\n'
    printf '6) Docker: ps\n'
    printf '7) Docker: Logs\n'
    printf '8) Docker: Uninstall (Container + Image entfernen)\n'
    printf '9) Docker: Reinstall (Uninstall + Neustart)\n'
    printf '10) Diagnose: Health-Checks\n'
    printf '11) Diagnose: Gefuehrte Funktionstests\n'
    printf '12) Diagnose: Gesamtstatus\n'
    printf '13) Repo: in anderen Ordner klonen\n'
    printf '14) Hilfe fuer Einsteiger anzeigen\n'
    printf '15) Beenden\n\n'

    read -r -p 'Bitte Option waehlen [0-15]: ' choice
    case "$choice" in
      0) run_action quickstart ;;
      1) run_action check ;;
      2) run_action build-start ;;
      3) run_action start ;;
      4) run_action stop ;;
      5) run_action restart ;;
      6) run_action ps ;;
      7) run_action logs ;;
      8) run_action uninstall ;;
      9) run_action reinstall ;;
      10) run_action health ;;
      11) run_action test ;;
      12) run_action status ;;
      13) run_action clone ;;
      14) run_action help-guide ;;
      15) printf 'Beendet.\n'; exit 0 ;;
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
