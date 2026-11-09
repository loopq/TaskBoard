#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source deploy/ssh.sh
[[ $(node -p 'process.versions.node.split(".")[0]') == 24 ]] || { echo '请用 Node 24 运行本机门禁' >&2; exit 1; }
(cd api && npm run check)
bash api/test/rules.sh
(cd web && npm run build)
release=$(python3 deploy/package-release.py)
archive="artifacts/$release.tar.gz"
archive_sha=$(shasum -a 256 "$archive" | awk '{print $1}')
ssh_run /dev/null "sudo install -d -m 0700 /opt/taskboard/releases/$release /etc/taskboard"
ssh_run "$archive" "sudo tee /opt/taskboard/releases/$release/source.tar.gz.upload >/dev/null"
ssh_run deploy/server/taskboard-release "sudo bash -s -- '$release' '$archive_sha'"
actual=$(ssh_run /dev/null 'sudo cat /etc/taskboard/current-release')
[[ $actual == "$release" ]] || { echo 'Release marker mismatch' >&2; exit 1; }
printf 'DEPLOYED_RELEASE=%s\n' "$release"
