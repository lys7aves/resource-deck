#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd "${script_dir}/.." && pwd)"
unit_name="resourcedeck.service"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
unit_path="${unit_dir}/${unit_name}"
config_path="${project_dir}/config/servers.yaml"
executable="${project_dir}/.venv/bin/resourcedeck"
windows_script="${script_dir}/windows-autostart.ps1"

usage() {
  cat <<EOF
Usage: $0 install [--manual|--autostart]
       $0 disable-autostart | start | stop | status | uninstall
EOF
}

sed_escape() { sed -e 's/[\\&|]/\\&/g'; }
unit_escape() { printf "%s" "$1" | sed -e 's/\\/\\\\/g' -e 's/ /\\x20/g'; }

install_unit() {
  [[ -x "$executable" ]] || { echo "Missing executable: $executable" >&2; exit 1; }
  [[ -f "$config_path" ]] || { echo "Missing config: $config_path" >&2; exit 1; }
  mkdir -p "$unit_dir"
  local project_value config_value executable_value
  project_value="$(unit_escape "$project_dir" | sed_escape)"
  config_value="$(unit_escape "$config_path" | sed_escape)"
  executable_value="$(unit_escape "$executable" | sed_escape)"
  sed -e "s|@PROJECT_DIR@|${project_value}|g" -e "s|@CONFIG_PATH@|${config_value}|g" -e "s|@EXECUTABLE@|${executable_value}|g" "${script_dir}/resourcedeck.service" > "$unit_path"
  systemctl --user daemon-reload
  echo "Installed $unit_path"
}

windows_autostart() {
  local action="$1"
  if ! command -v powershell.exe >/dev/null; then
    echo "Windows task was not changed. Run ${windows_script} from Windows PowerShell with -Action ${action}." >&2
    return 0
  fi
  local windows_path distro_name
  windows_path="$(wslpath -w "$windows_script")"
  distro_name="${WSL_DISTRO_NAME:-}"
  [[ -n "$distro_name" ]] || { echo "WSL_DISTRO_NAME is required for Windows autostart." >&2; return 1; }
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$windows_path" -Action "$action" -DistroName "$distro_name"
}

case "${1:-}" in
  install)
    install_unit
    case "${2:---manual}" in
      --manual)
        systemctl --user disable --now "$unit_name" >/dev/null 2>&1 || true
        echo "Manual mode: run systemctl --user start $unit_name when needed."
        ;;
      --autostart)
        loginctl enable-linger "$USER"
        systemctl --user enable --now "$unit_name"
        windows_autostart Install
        echo "Autostart enabled after Windows sign-in."
        ;;
      *) usage; exit 2 ;;
    esac
    ;;
  disable-autostart)
    windows_autostart Remove
    systemctl --user disable --now "$unit_name"
    echo "Autostart disabled. The unit remains available for manual start."
    ;;
  start|stop|status)
    systemctl --user "$1" "$unit_name"
    ;;
  uninstall)
    windows_autostart Remove
    systemctl --user disable --now "$unit_name" >/dev/null 2>&1 || true
    rm -f "$unit_path"
    systemctl --user daemon-reload
    echo "Removed $unit_path. Linger was left unchanged."
    ;;
  *) usage; exit 2 ;;
esac
