#!/bin/bash
# 清理 dsh 会话回收站：删除 sessions-trash 下超过保留期的会话目录。
# 只动回收站，不碰 /root/.dsh/sessions（线上会话库）。
# 用法：cleanup-sessions-trash.sh [--dry-run]
set -u

TRASH=${TRASH_DIR:-/root/.dsh/sessions-trash}
RETENTION_DAYS=${RETENTION_DAYS:-7}
LOG=${LOG_FILE:-/var/log/qq-bot-cleanup.log}
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

log() {
  local msg="$*"
  echo "[$(date '+%F %T')] $msg" >> "$LOG"
  logger -t qq-bot-cleanup "$msg"
}

case "$TRASH" in
  /root/.dsh/sessions-trash|/root/.dsh/sessions-trash/) ;;
  *)
    echo "拒绝执行：TRASH_DIR=$TRASH 不在允许范围内（只允许 /root/.dsh/sessions-trash）" >&2
    exit 2
    ;;
esac

if [ ! -d "$TRASH" ]; then
  log "回收站不存在，跳过：$TRASH"
  exit 0
fi

if [ -f "$LOG" ] && [ "$(stat -c%s "$LOG")" -gt 524288 ]; then
  mv -f "$LOG" "$LOG.1"
fi

before_mb=$(du -sm "$TRASH" 2>/dev/null | cut -f1)
list=$(mktemp)
find "$TRASH" -mindepth 1 -maxdepth 2 -type d -name 'session-*' -mtime +"$RETENTION_DAYS" -print0 > "$list"

n=0
while IFS= read -r -d '' d; do
  size_mb=$(du -sm "$d" 2>/dev/null | cut -f1)
  if [ "$DRY_RUN" = "1" ]; then
    log "[dry-run] 将删除 ${d}（${size_mb}M）"
  else
    rm -rf -- "$d" && log "已删除 ${d}（${size_mb}M）"
  fi
  n=$((n + 1))
done < "$list"
rm -f "$list"

if [ "$DRY_RUN" = "0" ]; then
  while IFS= read -r g; do
    rmdir -- "$g" 2>/dev/null && log "已删除空分组目录 ${g}"
  done < <(find "$TRASH" -mindepth 1 -maxdepth 1 -type d -empty -mtime +"$RETENTION_DAYS")
fi

after_mb=$(du -sm "$TRASH" 2>/dev/null | cut -f1)
if [ "$DRY_RUN" = "1" ]; then
  log "[dry-run] 预演结束：命中 ${n} 个会话目录，未做任何删除；回收站 ${before_mb}M"
elif [ "$n" -eq 0 ]; then
  log "无超过 ${RETENTION_DAYS} 天的会话，回收站保持 ${before_mb}M"
else
  log "清理完成：删除 ${n} 个会话目录，回收站 ${before_mb}M → ${after_mb}M"
fi
