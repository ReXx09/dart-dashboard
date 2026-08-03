#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$SCRIPT_DIR/scripts/lib/common.sh"

detect_ui_mode
ensure_env_file

print_step() {
  msg_info "$1"
}

read_pin() {
  local title="$1"
  if [[ "$USE_WHIPTAIL" -eq 1 ]]; then
    whiptail --title 'Admin-PIN' --passwordbox "$title" 10 72 3>&1 1>&2 2>&3
  else
    local value
    read -r -s -p "$title " value
    printf '\n' >&2
    printf '%s' "$value"
  fi
}

print_line
printf ' Admin-PIN einrichten\n'
print_line
printf 'Die PIN wird gehasht und nur als ADMIN_PIN_HASH in .env gespeichert.\n'
printf 'Die eigentliche PIN wird nicht gespeichert.\n\n'

if [[ "$USE_WHIPTAIL" -eq 1 ]]; then
  if ! whiptail --title 'Admin-PIN einrichten' --yesno 'Soll jetzt eine neue Admin-PIN eingerichtet werden?' 10 72; then
    msg_info 'Einrichtung abgebrochen.'
    exit 0
  fi
else
  read -r -p 'Einrichtung starten? [Y/n]: ' start_answer
  if [[ -n "$start_answer" && ! "$start_answer" =~ ^[Yy]$ ]]; then
    msg_info 'Einrichtung abgebrochen.'
    exit 0
  fi
fi

while true; do
  pin="$(read_pin 'Neue PIN eingeben (mindestens 6 Ziffern):')"
  if [[ "$pin" =~ ^[0-9]{6,}$ ]]; then break; fi
  msg_fail 'Die PIN muss aus mindestens 6 Ziffern bestehen.'
done

while true; do
  confirmation="$(read_pin 'PIN zur Kontrolle wiederholen:')"
  if [[ "$pin" == "$confirmation" ]]; then break; fi
  msg_fail 'Die PIN-Eingaben stimmen nicht überein.'
  if [[ "$USE_WHIPTAIL" -eq 1 ]]; then
    whiptail --title 'Eingabe pruefen' --msgbox 'Die PINs stimmen nicht überein. Bitte erneut eingeben.' 9 72
  fi
done

print_step 'Schritt 1/3: Prüfe Node.js auf dem Host oder im Dashboard-Container.'
hash_script='const c=require("crypto"); const p=require("fs").readFileSync(0,"utf8"); const s=c.randomBytes(16).toString("hex"); process.stdout.write(s+":"+c.scryptSync(p,s,32).toString("hex"));'
if command_exists node; then
  hash="$(printf '%s' "$pin" | node -e "$hash_script")"
elif command_exists docker && [[ "$(docker inspect -f '{{.State.Running}}' dart-dashboard 2>/dev/null || true)" == 'true' ]]; then
  hash="$(printf '%s' "$pin" | docker exec -i dart-dashboard node -e "$hash_script")"
else
  msg_fail 'Node.js wurde weder auf dem Host noch im laufenden dart-dashboard-Container gefunden.'
  msg_info 'Bitte zuerst den Dashboard-Container starten oder Node.js installieren.'
  exit 1
fi

if [[ ! "$hash" =~ ^[a-f0-9]+:[a-f0-9]{64}$ ]]; then
  msg_fail 'Der PIN-Hash konnte nicht erzeugt werden.'
  exit 1
fi

print_step 'Schritt 2/3: Schreibe den Hash in .env.'
set_or_replace_env ADMIN_PIN_HASH "$hash"
set_or_replace_env ADMIN_SESSION_TTL_MS '900000'

print_step 'Schritt 3/3: Einrichtung abgeschlossen.'
msg_ok 'Admin-PIN-Hash wurde gespeichert. Die PIN selbst wurde nicht gespeichert.'
msg_info 'Die Admin-Session ist standardmäßig 15 Minuten gültig.'
