# 部署

以 Debian / Ubuntu（systemd + Docker）为例，命令用 root 执行。

## 1. 基础环境

```bash
bash deploy/bootstrap.sh
```

装 Node v24、`@deepseek-ai/dsh`、Docker；内存小于 3G 且没有 swap 时补 2G swap。幂等，可重复跑。

## 2. 放代码

```bash
mkdir -p /opt/qq-bot
rsync -a --exclude node_modules ./ /opt/qq-bot/
cd /opt/qq-bot && npm install --omit=dev
```

## 3. 模型凭据

`dsh` 的凭据放在 `~/.dsh/.credentials.yaml`（由 dsh 登录流程生成）。**不要提交到仓库，也不要打进任何压缩包。**

## 4. 环境变量

```bash
cp .env.example /etc/qq-bot.env
vi /etc/qq-bot.env        # 至少填 ALLOW_FROM
chmod 600 /etc/qq-bot.env
```

## 5. systemd

```bash
cp deploy/qq-bot.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now qq-bot
journalctl -u qq-bot -f
```

## 6. NapCat

```bash
mkdir -p /opt/napcat/config /opt/napcat/qq
docker run -d --name napcat --restart unless-stopped --network host \
  -e TZ=Asia/Shanghai -e NAPCAT_UID=1000 -e NAPCAT_GID=1000 \
  -v /opt/napcat/config:/app/napcat/config \
  -v /opt/napcat/qq:/app/.config/QQ \
  mlikiowa/napcat-docker:latest

docker logs -f napcat      # 扫码登录
```

把 [`napcat/onebot11.example.json`](napcat/onebot11.example.json) 复制成 `/opt/napcat/config/onebot11_<机器人QQ>.json`，再 `docker restart napcat`。端口、token 要与 `/etc/qq-bot.env` 里的 `NAPCAT_WS` / `NAPCAT_TOKEN` 一致。

## 7. dsh 补丁

视觉直传和「答完不退」都靠补丁改 dsh 的 `node_modules`：

```bash
node patch-headless-vision.mjs
node patch-dsh-sse-cancel.mjs
```

`dsh` 升级会覆盖这些文件。把 `dsh-wrapper-guard.sh` 装成 `/usr/local/bin/dsh`（见脚本头部注释），它会在每次启动前检查补丁标记，缺失则自动重打。

## 8. 可选定时单元

```bash
cp deploy/napcat-watchdog.* /etc/systemd/system/
cp deploy/cleanup-sessions-trash.sh /usr/local/bin/ && chmod 755 /usr/local/bin/cleanup-sessions-trash.sh
cp deploy/qq-bot-cleanup.* /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now napcat-watchdog.timer qq-bot-cleanup.timer
```

| 单元 | 作用 |
|---|---|
| `napcat-watchdog.timer` | 每 30 秒检查 3001 端口；连续 3 次无监听就重启 NapCat（QQ 客户端挂掉后 NapCat 退化扫码登录时，systemd 的 `Restart=always` 抓不到） |
| `qq-bot-cleanup.timer` | 每天 04:17 清理会话回收站里超过 7 天的目录；支持 `--dry-run` |

## 9. 硬件与网络

- 1 核 2G 能跑，但 `dsh` 每轮会起一个 Node 子进程，建议 2G 内存起步。
- 只有 IPv4 出口的机器不需要额外配置：`bridge.mjs` 启动时已设置 `setDefaultResultOrder("ipv4first")`。
- 唱歌需要 GPU 机器，见 [../docs/remote-render.md](../docs/remote-render.md)。
