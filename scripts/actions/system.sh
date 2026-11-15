#!/usr/bin/env bash

build_requirements_report() {
  local report="" missing_count=0

  report+="Setup-Pruefung fuer Raspberry Pi\n\n"

  if command_exists apt-get; then report+="[OK] apt-get verfuegbar\n"
  else report+="[WARN] apt-get fehlt (nicht Debian/Raspberry Pi OS?)\n"; fi

  if command_exists docker; then report+="[OK] Docker installiert\n"
  else report+="[FEHLT] Docker\n"; missing_count=$((missing_count + 1)); fi

  if detect_compose_cmd >/dev/null 2>&1; then report+="[OK] Docker Compose verfuegbar\n"
  else report+="[FEHLT] Docker Compose\n"; missing_count=$((missing_count + 1)); fi

  if command_exists git; then report+="[OK] Git installiert\n"
  else report+="[FEHLT] Git\n"; missing_count=$((missing_count + 1)); fi

  if command_exists python3; then report+="[OK] Python 3 verfuegbar\n"
  else report+="[FEHLT] Python 3 (wird fuer den sicheren Admin-PIN-Hash benoetigt)\n"; missing_count=$((missing_count + 1)); fi

  if command_exists whiptail; then report+="[OK] whiptail installiert\n"
  else report+="[OPTIONAL] whiptail fehlt (Textmenue bleibt nutzbar)\n"; fi

  if groups "$USER" | grep -Eq '(^|[[:space:]])docker($|[[:space:]])'; then
    report+="[OK] Benutzer in docker-Gruppe\n"
  else
    report+="[HINWEIS] Benutzer nicht in docker-Gruppe (evtl. sudo noetig)\n"
  fi

  report+="\nFehlende Kernkomponenten: ${missing_count}\n"
  printf '%b' "$report"
}

install_docker_stack_debian() {
  ensure_sudo
  printf '\nInstalliere Docker und Compose-Plugin (Debian/Raspberry Pi OS)...\n'
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl gnupg lsb-release git whiptail python3

  if ! command_exists docker; then
    curl -fsSL https://get.docker.com | sudo sh
  fi

  if command_exists systemctl; then sudo systemctl enable --now docker; fi

  if ! docker compose version >/dev/null 2>&1 && ! command_exists docker-compose; then
    if ! sudo apt-get install -y docker-compose-plugin; then
      msg_warn 'Docker-Compose-Plugin konnte nicht aus apt installiert werden; pruefe danach die Docker-Installation.'
    fi
  fi

  local target_user="${SUDO_USER:-${USER:-}}"
  if [[ -n "$target_user" && "$target_user" != "root" ]] && getent group docker >/dev/null 2>&1; then
    if ! id -nG "$target_user" | grep -Eq '(^|[[:space:]])docker($|[[:space:]])'; then
      sudo usermod -aG docker "$target_user"
      printf 'Hinweis: %s wurde zur Docker-Gruppe hinzugefuegt.\n' "$target_user"
      printf 'Die Gruppe wird nach einer erneuten Anmeldung aktiv; der Assistent nutzt bis dahin sudo.\n'
    fi
  fi
}

run_system_check_and_install() {
  local initial_report
  initial_report="$(build_requirements_report)"
  show_textbox "Systemcheck" "$initial_report"

  if ! ask_yes_no 'Fehlende Komponenten jetzt automatisch installieren?' 'y'; then
    msg_warn 'Installation abgebrochen.'
    return 2
  fi

  if ! command_exists apt-get; then
    msg_fail 'apt-get fehlt – bitte manuell Docker installieren: https://docs.docker.com/engine/install/'
    return 1
  fi

  install_docker_stack_debian

  if ! detect_compose_cmd; then
    msg_fail 'Docker Compose ist nach der Installation weiterhin nicht verfuegbar.'
    return 1
  fi
  if ! $DOCKER_CMD info >/dev/null 2>&1; then
    msg_fail 'Der Docker-Dienst ist installiert, aber nicht erreichbar.'
    return 1
  fi

  msg_ok 'Installation abgeschlossen.'
  msg_info 'Docker und Docker Compose sind einsatzbereit.'
}

prompt_dashboard_port() {
  local title="$1" key="$2" default_port="$3" port current_port
  current_port="$(get_env_value "$key" "$default_port")"
  while true; do
    port="$(ask_input "$title" "Portnummer (1024-65535)." "$current_port")" || return 1
    if [[ "$port" =~ ^[0-9]+$ ]] && (( port >= 1024 && port <= 65535 )); then
      if [[ "$port" == "$current_port" ]] && curl -fsS --max-time 1 "http://localhost:${port}/api/server-info" >/dev/null 2>&1; then
        printf '%s' "$port"
        return 0
      fi
      if ! python3 -c 'import socket, sys; sock=socket.socket(); sock.bind(("", int(sys.argv[1]))); sock.close()' "$port" >/dev/null 2>&1; then
        msg_warn "Port ${port} ist bereits belegt. Bitte einen anderen Port waehlen." >&2
        continue
      fi
      printf '%s' "$port"
      return 0
    fi
    msg_warn 'Bitte eine Portnummer zwischen 1024 und 65535 eingeben.' >&2
  done
}

configure_dashboard_ports() {
  local public_port firetv_port
  public_port="$(prompt_dashboard_port 'Spiel- und Admin-Ansicht' PUBLIC_PORT 3100)" || return 1
  while true; do
    firetv_port="$(prompt_dashboard_port 'Fire-TV-Ansicht' FIRETV_PORT 3200)" || return 1
    if [[ "$firetv_port" != "$public_port" ]]; then break; fi
    msg_warn 'Die beiden Ansichten muessen unterschiedliche Ports verwenden.'
  done
  set_or_replace_env PUBLIC_PORT "$public_port"
  set_or_replace_env FIRETV_PORT "$firetv_port"
}

find_arduino_devices() {
  local candidate
  for candidate in /dev/serial/by-id/* /dev/ttyACM* /dev/ttyUSB*; do
    [[ -c "$candidate" ]] && printf '%s\n' "$candidate"
  done
}

choose_arduino_device() {
  local devices=() current_device choice selected="" index default_choice="1"
  current_device="$(get_env_value ARDUINO_DEVICE)"
  while IFS= read -r choice; do
    [[ -n "$choice" ]] && devices+=("$choice")
  done < <(find_arduino_devices)

  if [[ -n "$current_device" && -c "$current_device" ]]; then
    local i
    for i in "${!devices[@]}"; do
      if [[ "${devices[$i]}" == "$current_device" ]]; then default_choice="$((i + 1))"; break; fi
    done
  fi

  if [[ ${#devices[@]} -eq 0 ]]; then
    msg_warn 'Kein Arduino-USB-Geraet erkannt.'
    while [[ ${#devices[@]} -eq 0 ]]; do
      if ! ask_yes_no 'Arduino jetzt verbinden und erneut suchen?' 'y'; then break; fi
      choice="$(ask_input 'Arduino verbinden' 'Arduino per USB verbinden. Enter sucht erneut; q ueberspringt die Suche.' '')" || return 1
      [[ "${choice,,}" == "q" ]] && break
      while IFS= read -r selected; do [[ -n "$selected" ]] && devices+=("$selected"); done < <(find_arduino_devices)
      if [[ ${#devices[@]} -eq 0 ]]; then
        msg_warn 'Es wurde noch kein USB-Seriellgeraet gefunden.'
      fi
    done
  fi

  if [[ ${#devices[@]} -gt 0 ]]; then
    if [[ "$USE_WHIPTAIL" -eq 1 ]]; then
      local options=()
      for index in "${!devices[@]}"; do options+=("$((index + 1))" "${devices[$index]}"); done
      options+=("M" "Geraetepfad manuell eingeben" "0" "Ohne Arduino fortfahren")
      choice="$(whiptail --title 'Arduino verbinden' --menu 'Erkanntes USB-Seriellgeraet auswaehlen.' 18 90 8 "${options[@]}" 3>&1 1>&2 2>&3)" || return 1
    else
      printf '\nErkannte Arduino-/USB-Seriellgeraete:\n'
      for index in "${!devices[@]}"; do printf '  %s) %s\n' "$((index + 1))" "${devices[$index]}"; done
      printf '  M) Geraetepfad manuell eingeben\n  0) Ohne Arduino fortfahren\n'
      read -r -p "Auswahl [${default_choice}]: " choice
      choice="${choice:-$default_choice}"
    fi

    if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#devices[@]} )); then
      selected="${devices[$((choice - 1))]}"
    elif [[ "$choice" == "M" || "$choice" == "m" ]]; then
      selected="$(ask_input 'Arduino-Geraetepfad' 'Host-Pfad eingeben (z. B. /dev/ttyACM0).' "$current_device")" || return 1
    elif [[ "$choice" == "0" ]]; then
      selected=""
    else
      msg_warn 'Ungueltige Auswahl.'
      return 1
    fi
  elif [[ -z "$current_device" ]] || [[ ! -c "$current_device" ]]; then
    selected="$(ask_input 'Arduino-Geraetepfad' 'Optional: Host-Pfad eingeben (z. B. /dev/ttyACM0). Leer lassen = ohne Arduino.' '')" || return 1
  fi

  if [[ -n "$selected" ]]; then
    if [[ "$selected" != /dev/* || ! -c "$selected" ]]; then
      msg_fail 'Der Arduino-Pfad muss ein vorhandenes Geraet unter /dev sein.'
      return 1
    fi
    local dialout_gid
    dialout_gid="$(getent group dialout | cut -d: -f3)"
    if [[ ! "$dialout_gid" =~ ^[0-9]+$ ]]; then
      msg_fail 'Die Linux-Gruppe dialout wurde nicht gefunden; Arduino-Berechtigungen koennen nicht gesetzt werden.'
      return 1
    fi
    set_or_replace_env ARDUINO_DEVICE "$selected"
    set_or_replace_env DIALOUT_GID "$dialout_gid"
    msg_ok "Arduino wird eingebunden: ${selected}"
  else
    set_or_replace_env ARDUINO_DEVICE ''
    set_or_replace_env DIALOUT_GID ''
    msg_warn 'Installation ohne Arduino. Automatische Wurferkennung funktioniert erst nach erneutem Setup mit angeschlossenem Arduino.'
  fi
}

configure_dashboard_installation() {
  ensure_env_file || return 1
  msg_step 1 3 'Ports fuer Browser und Fire TV festlegen.'
  configure_dashboard_ports || return 1
  msg_step 2 3 'Arduino-USB-Geraet erkennen oder Installation ohne Arduino fortsetzen.'
  choose_arduino_device || return 1

  if [[ -z "$(get_env_value ADMIN_PIN_HASH)" ]]; then
    msg_step 3 3 'Admin-PIN sicher einrichten.'
    msg_info 'Die PIN wird nur als sicherer Hash in .env gespeichert.'
    generate_admin_pin_hash || return 1
  else
    msg_info 'Eine Admin-PIN ist bereits eingerichtet.'
  fi
}

generate_admin_pin_hash() {
  bash "$SCRIPT_DIR/scripts/generate-pin-hash.sh"
}

run_system_update() {
  if ! command_exists apt-get; then
    msg_fail 'apt-get wurde auf diesem System nicht gefunden.'
    return 1
  fi
  msg_warn 'Systempakete werden aktualisiert. Ein Neustart kann erforderlich sein.'
  if ! ask_yes_no 'Systempakete jetzt aktualisieren?' 'n'; then
    msg_info 'System-Update abgebrochen.'
    return 0
  fi
  ensure_sudo
  sudo apt-get update
  sudo apt-get upgrade -y
}

run_raspi_update() {
  if ! command_exists rpi-update; then
    msg_fail 'rpi-update wurde auf diesem System nicht gefunden.'
    local os_release=''
    local device_model=''
    if [[ -r /etc/os-release ]]; then
      os_release="$(cat /etc/os-release 2>/dev/null || true)"
    fi
    if [[ -r /proc/device-tree/model ]]; then
      device_model="$(tr -d '\0' < /proc/device-tree/model 2>/dev/null || true)"
    fi
    if printf '%s\n' "$device_model" | grep -Eiq 'Raspberry Pi|Compute Module' || command_exists raspi-config || printf '%s\n' "$os_release" | grep -Eiq 'PRETTY_NAME=.*(Raspberry Pi OS|Raspbian)'; then
      msg_info "Raspberry-Pi-Hardware erkannt: ${device_model:-Modell unbekannt}"
      if command_exists apt-get && ask_yes_no 'Fehlendes Paket rpi-update jetzt installieren?' 'y'; then
        ensure_sudo
        sudo apt-get update
        sudo apt-get install -y rpi-update
        if ! command_exists rpi-update; then
          msg_fail 'rpi-update konnte nicht installiert werden.'
          return 1
        fi
        msg_ok 'rpi-update wurde installiert.'
      else
        msg_info 'Installiere das Werkzeug manuell mit:'
        msg_info 'sudo apt-get update && sudo apt-get install -y rpi-update'
        return 1
      fi
    elif printf '%s\n' "$os_release" | grep -q 'ID=debian'; then
      msg_info 'Dieses System ist Debian, nicht Raspberry Pi OS.'
      msg_info 'Verwende fuer regulare System- und Paketupdates:'
      msg_info 'sudo apt update && sudo apt full-upgrade'
    else
      msg_info 'Diese Funktion ist nur fuer Raspberry Pi OS vorgesehen.'
    fi
    msg_info 'Pruefe das Betriebssystem mit: cat /etc/os-release'
    return 1
  fi
  msg_warn 'rpi-update aktualisiert die Raspberry-Pi-Firmware und kann einen Neustart erfordern.'
  if ! ask_yes_no 'Raspi-Update jetzt starten?' 'n'; then
    msg_info 'Raspi-Update abgebrochen.'
    return 0
  fi
  ensure_sudo
  sudo rpi-update
}