#!/usr/bin/env bash

clone_repo_elsewhere() {
  if ! command_exists git; then
    printf 'Git ist nicht installiert.\n'
    if ask_yes_no 'Soll git jetzt installiert werden?' 'y'; then
      ensure_sudo
      sudo apt-get update
      sudo apt-get install -y git
    else
      return
    fi
  fi

  local target_dir
  if [[ "$USE_WHIPTAIL" -eq 1 ]]; then
    target_dir="$(whiptail --title "Repo klonen" --inputbox "Zielordner fuer den Clone:" 10 82 "$HOME/loewen-dart-dashboard" 3>&1 1>&2 2>&3)" || return
  else
    read -r -p 'Zielordner fuer den Clone [~/loewen-dart-dashboard]: ' target_dir
  fi
  target_dir="${target_dir:-$HOME/loewen-dart-dashboard}"

  if [[ -e "$target_dir" ]]; then
    printf 'Pfad existiert bereits: %s\n' "$target_dir"
    return
  fi

  printf 'Clone %s nach %s\n' "$REPO_URL" "$target_dir"
  git clone "$REPO_URL" "$target_dir"
  printf 'Fertig. Wechsle dann nach: %s/dart-dashboard\n' "$target_dir"
}
