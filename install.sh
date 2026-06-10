#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

source "$SCRIPT_DIR/scripts/lib/common.sh"
source "$SCRIPT_DIR/scripts/actions/system.sh"
source "$SCRIPT_DIR/scripts/actions/docker.sh"
source "$SCRIPT_DIR/scripts/actions/repo.sh"
source "$SCRIPT_DIR/scripts/actions/diagnostics.sh"
source "$SCRIPT_DIR/scripts/actions/help.sh"

run_action() {
  local action="$1"
  case "$action" in
    quickstart) run_quickstart_wizard ;;
    check) run_system_check_and_install ;;
    build-start) build_and_start ;;
    start) start_existing ;;
    stop) stop_stack ;;
    restart) restart_stack ;;
    ps) show_compose_ps ;;
    logs) show_logs ;;
    status) show_status ;;
    uninstall) uninstall_stack ;;
    reinstall) reinstall_stack ;;
    health) run_health_checks ;;
    test) run_guided_tests ;;
    clone) clone_repo_elsewhere ;;
    help-guide) show_beginner_help ;;
    *)
      printf 'Unbekannte Action: %s\n\n' "$action"
      usage
      exit 1
      ;;
  esac
}

usage() {
  cat <<'EOF'
Verwendung:
  ./install.sh <action>

Actions:
  menu          Startet das eigenstaendige Menue (menu.sh)
  quickstart    Komplettassistent (Pruefen + Einrichten + Start + Tests)
  check         Systemcheck + Auto-Installation
  build-start   Install/Update + Build + Start
  start         Nur Start (ohne Build)
  stop          Container stoppen
  restart       Container neu starten
  ps            Docker Compose Status anzeigen
  logs          Container-Logs anzeigen
  status        Gesamtstatus anzeigen
  uninstall     Container + Image entfernen (Daten bleiben)
  reinstall     Uninstall + sauberer Neustart
  health        Health-Checks (API/Storage/Arduino/Fire-TV)
  test          Gefuehrte Funktionstests (Schritt fuer Schritt)
  clone         Repo in anderen Ordner klonen
  help-guide    Einsteiger-Hilfe anzeigen

Wenn kein Action-Parameter gesetzt ist, wird automatisch menu.sh gestartet.
EOF
}

if [[ ! -f docker-compose.yml ]]; then
  printf 'Hinweis: docker-compose.yml nicht im aktuellen Ordner gefunden.\n'
  printf 'Bitte dieses Skript im dart-dashboard Ordner ausfuehren.\n'
fi

detect_ui_mode

if [[ $# -eq 0 || "${1:-}" == "menu" ]]; then
  if [[ -x "$SCRIPT_DIR/menu.sh" ]]; then
    exec "$SCRIPT_DIR/menu.sh"
  fi

  printf 'Fehler: menu.sh nicht gefunden oder nicht ausfuehrbar.\n'
  usage
  exit 1
fi

case "${1:-}" in
  quickstart|check|build-start|start|stop|restart|ps|logs|status|uninstall|reinstall|clone|health|test|help-guide)
    run_action "$1"
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    printf 'Unbekannte Action: %s\n\n' "$1"
    usage
    exit 1
    ;;
 esac
