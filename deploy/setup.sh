#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source deploy/ssh.sh
case "${1:-}" in
  --prepare|--activate-dns-confirmed) ;;
  *) echo '用法：deploy/setup.sh --prepare | --activate-dns-confirmed' >&2; exit 1 ;;
esac
# prepare 安装运维脚本；activate 只有在用户明确确认 DNS 生效后才执行。
ssh_run /dev/null "sudo bash -c 'release=\$(cat /etc/taskboard/current-release); exec bash /opt/taskboard/releases/\$release/source/deploy/server/taskboard-setup $1'"
