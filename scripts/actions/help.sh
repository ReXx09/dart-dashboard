#!/usr/bin/env bash

run_quickstart_wizard() {
  local summary
  summary+="Schnellstart-Assistent\n\n"
  summary+="Es werden nacheinander ausgefuehrt:\n"
  summary+="1) Systemcheck + Auto-Installation\n"
  summary+="2) Build + Start des Docker-Containers\n"
  summary+="3) Health-Checks\n"
  summary+="4) Gefuehrte Funktionstests\n\n"
  summary+="Dauer: je nach Internet/Hardware mehrere Minuten."

  show_textbox "Schnellstart" "$(printf '%b' "$summary")"
  if ! ask_yes_no 'Schnellstart jetzt ausfuehren?' 'y'; then return; fi

  run_system_check_and_install
  build_and_start
  run_health_checks

  if ask_yes_no 'Zum Abschluss die gefuehrten Funktionstests anzeigen?' 'y'; then
    run_guided_tests
  fi
}

clone_repo_elsewhere() {
  if ! command_exists git; then
    msg_fail 'Git ist nicht installiert.'
    if ask_yes_no 'Soll git jetzt installiert werden?' 'y'; then
      ensure_sudo; sudo apt-get update; sudo apt-get install -y git
    else return; fi
  fi

  local target_dir
  if [[ "$USE_WHIPTAIL" -eq 1 ]]; then
    target_dir="$(whiptail --title "Repo klonen" --inputbox "Zielordner fuer den Clone:" 10 82 "$HOME/loewen-dart-dashboard" 3>&1 1>&2 2>&3)" || return
  else
    read -r -p 'Zielordner fuer den Clone [~/loewen-dart-dashboard]: ' target_dir
  fi
  target_dir="${target_dir:-$HOME/loewen-dart-dashboard}"

  if [[ -e "$target_dir" ]]; then
    msg_warn "Pfad existiert bereits: ${target_dir}"; return
  fi

  git clone "$REPO_URL" "$target_dir"
  msg_ok "Repo geklont nach: ${target_dir}/dart-dashboard"
}

show_beginner_help() {
  local text=""
  text+="Einsteiger-Anleitung (empfohlene Reihenfolge)\n\n"
  text+="1) Schnellstart-Assistent ausfuehren\n"
  text+="   - Menuepunkt 'Schnellstart-Assistent'\n"
  text+="   - Fuehrt Systemcheck, Installation und Start zusammen\n\n"
  text+="2) Health-Checks ausfuehren\n"
  text+="   - Prueft Docker, Container und APIs\n\n"
  text+="3) Gefuehrte Funktionstests starten\n"
  text+="   - Testet die wichtigsten Endpunkte Schritt fuer Schritt\n\n"
  text+="4) Docker-Untermenue nutzen\n"
  text+="   - Start, Stop, Restart, Logs und Status\n\n"
  text+="5) Ardunio-Anschluss\n"
  text+="   - USB-Kabel verbinden\n"
  text+="   - Im Menue: Status & Monitoring > Arduino verbinden\n\n"
  text+="Direkte Kommandos:\n"
  text+="  ./install.sh quickstart\n"
  text+="  ./install.sh health\n"
  text+="  ./install.sh test\n"
  text+="  ./install.sh docker-logs\n"
  show_textbox "Hilfe" "$(printf '%b' "$text")"
}