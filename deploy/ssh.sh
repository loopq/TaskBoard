#!/usr/bin/env bash
# 每次重试重新打开输入文件，避免上传或远端脚本在断线后只收到后半段。
ssh_run() {
  local input=$1 rc attempt
  shift
  for attempt in 1 2 3 4 5; do
    if ssh -T -o BatchMode=yes -o ControlMaster=no -o ControlPath=none -o ConnectTimeout=12 \
      tencent-seoul-admin "$@" <"$input"; then
      return 0
    else
      rc=$?
    fi
    [[ $rc == 255 ]] || return "$rc"
    echo "SSH 连接中断，重试 $attempt/5" >&2
    sleep "$attempt"
  done
  return "$rc"
}
