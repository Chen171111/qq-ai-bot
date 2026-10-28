#!/bin/sh
# /usr/local/bin/dsh —— dsh 启动器 + 补丁守卫
#
# 2026-10-27：dsh 升级或 profile 依赖重装会覆盖两个补丁，届时 dsh 会重新
# 出现「答完不退」。这里在每次启动前做一次毫秒级 grep 检查，缺失即自动重打。
# 补丁脚本失败不阻塞启动：记日志 + stderr 告警，dsh 照常运行。
export DSH_HOME="${DSH_HOME:-/root/.dsh}"
GUARD_LOG=/var/log/dsh-patch-guard.log
DASH_LIB=/root/.dsh-runtime/node_modules/@deepseek-ai/dsh/lib

core_file() {
  ls "$DASH_LIB"/profile-boot-*.js 2>/dev/null | head -n 1
}
plugin_file() {
  ls "$DSH_HOME"/profiles/*/node_modules/dsh-providers-hub/lib/openai-compat.js 2>/dev/null | head -n 1
}
missing() {
  CORE=$(core_file)
  PLUGIN=$(plugin_file)
  if [ -n "$CORE" ] && ! grep -qs "dsh-force-exit" "$CORE"; then
    return 0
  fi
  if [ -n "$PLUGIN" ] && ! grep -qs "dsh-sse-body-cancel" "$PLUGIN"; then
    return 0
  fi
  return 1
}

if missing; then
  (
    flock -w 10 9 || true
    echo "[$(date '+%F %T')] 检测到补丁缺失，自动重打（pid=$$）"
    /opt/node/bin/node /opt/qq-bot/patch-dsh-force-exit.mjs
    echo "[$(date '+%F %T')] force-exit 退出码=$?"
    /opt/node/bin/node /opt/qq-bot/patch-dsh-sse-cancel.mjs
    echo "[$(date '+%F %T')] sse-cancel 退出码=$?"
  ) 9>>/var/lock/dsh-patch-guard.lock >>"$GUARD_LOG" 2>&1
  if missing; then
    echo "[patch-guard] 补丁重打后仍缺失（dsh 升级可能改了锚点），详见 $GUARD_LOG" >&2
  fi
fi

exec /opt/node/bin/node "$DASH_LIB/bin.js" "$@"
