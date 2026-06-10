#!/usr/bin/env bash

show_beginner_help() {
  local text=""
  text+="Einsteiger-Anleitung (empfohlene Reihenfolge)\n\n"
  text+="1) Schnellstart-Assistent ausfuehren\n"
  text+="   - Menuepunkt: Schnellstart-Assistent\n"
  text+="   - Dieser fuehrt Systemcheck, Installation und Start zusammen\n\n"
  text+="2) Health-Checks ausfuehren\n"
  text+="   - Prueft Docker, Container, APIs und optional Fire-TV\n\n"
  text+="3) Gefuehrte Funktionstests starten\n"
  text+="   - Testet die wichtigsten Endpunkte Schritt fuer Schritt\n\n"
  text+="4) Docker-Untermenue nutzen\n"
  text+="   - Start, Stop, Restart, Logs und ps sind getrennt gruppiert\n\n"
  text+="5) Bei Fire-TV Problemen\n"
  text+="   - .env pruefen: FIRE_FEATURES_ENABLED=true\n"
  text+="   - FIRESTICK_IP kontrollieren\n"
  text+="   - Dann Health-Checks erneut laufen lassen\n\n"
  text+="Direkte Kommandos:\n"
  text+="  ./install.sh quickstart\n"
  text+="  ./install.sh health\n"
  text+="  ./install.sh test\n"
  text+="  ./install.sh docker-logs\n"
  show_textbox "Hilfe" "$(printf '%b' "$text")"
}

run_quickstart_wizard() {
  local summary=""
  summary+="Schnellstart-Assistent\n\n"
  summary+="Es werden nacheinander ausgefuehrt:\n"
  summary+="1) Systemcheck + Auto-Installation\n"
  summary+="2) Install/Update + Build + Start\n"
  summary+="3) Health-Checks\n"
  summary+="4) Gefuehrte Funktionstests (Auswertung)\n\n"
  summary+="Dauer: je nach Internet/Hardware mehrere Minuten."

  show_textbox "Schnellstart" "$(printf '%b' "$summary")"
  if ! ask_yes_no 'Schnellstart jetzt ausfuehren?' 'y'; then
    return
  fi

  run_system_check_and_install
  build_and_start
  run_health_checks

  if ask_yes_no 'Zum Abschluss die gefuehrten Funktionstests anzeigen?' 'y'; then
    run_guided_tests
  fi
}
