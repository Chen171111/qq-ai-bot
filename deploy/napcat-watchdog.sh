#!/bin/bash
# NapCat 看门狗：3001 连续 3 次（约 90 秒）没监听就重启 napcat。
# 触发场景：QQ 客户端挂掉后 NapCat 内部重启丢 -q，退化成扫码登录，3001 再也不起来，
# 而 systemd 的 Restart=always 抓不到（xvfb-run 主进程一直活着）。
set -u

PORT=3001
STATE=/run/napcat-watchdog.fail
LAST=/run/napcat-watchdog.lastrestart
THRESHOLD=3
COOLDOWN=300

now=$(date +%s)

if ss -ltnH "sport = :$PORT" 2>/dev/null | grep -q .; then
  echo 0 > "$STATE"
  exit 0
fi

n=$(cat "$STATE" 2>/dev/null || echo 0)
case "$n" in ''|*[!0-9]*) n=0 ;; esac
n=$((n + 1))
echo "$n" > "$STATE"

[ "$n" -lt "$THRESHOLD" ] && exit 0

last=$(cat "$LAST" 2>/dev/null || echo 0)
case "$last" in ''|*[!0-9]*) last=0 ;; esac
if [ $((now - last)) -lt "$COOLDOWN" ]; then
  logger -t napcat-watchdog "端口 $PORT 仍无监听（第 $n 次），距上次重启不足 ${COOLDOWN}s，暂不重启"
  exit 0
fi

logger -t napcat-watchdog "端口 $PORT 连续 $n 次无监听，执行 systemctl restart napcat"
systemctl restart napcat
echo "$now" > "$LAST"
echo 0 > "$STATE"
