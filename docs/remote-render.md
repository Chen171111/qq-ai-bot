# 跨机渲染协议（点歌 / 语音转写）

服务器通常没有 GPU，唱歌合成与 whisper 转写放在另一台机器上跑。两边不共享内存，只通过服务器上的两个目录交换文件。

## 目录

```
/opt/qq-bot/.run/svc-inbox/        任务（bridge 写，渲染机读）
/opt/qq-bot/.run/svc-outbox/       结果（渲染机写，bridge 读）
/opt/qq-bot/.run/svc-asr-inbox/    ASR 任务（同上，单独一条队列）
/opt/qq-bot/.run/audio-in/         收到的原始音频
```

写入都是「先写临时名再 rename」，读取方只认最终文件名，避免读到半个文件。

## 任务格式

`svc-inbox/<id>.json`，音频与 json 同名：

```json
{ "id": "1780000000000-abc", "userId": 10001, "audio": "1780000000000-abc.m4a" }
```

只给歌名时没有音频文件：

```json
{ "id": "1780000000001-def", "userId": 10001, "query": "稻香" }
```

## 结果格式

`svc-outbox/<id>.mp3` + `svc-outbox/<id>.done.json`：

```json
{ "id": "1780000000000-abc", "userId": 10001, "ok": true, "mp3": "1780000000000-abc.mp3" }
```

失败：

```json
{ "id": "1780000000000-abc", "userId": 10001, "ok": false, "error": "no_vocal", "reason": "候选里没有人声" }
```

bridge 轮询 `svc-outbox/`，把 mp3 作为语音发回 QQ，然后删掉这一组文件。

## ASR 队列

`svc-asr-inbox/<id>.json`：

```json
{ "id": "1780000000002-ghi", "userId": 10001, "kind": "asr", "groupId": null, "index": 0, "audio": "1780000000002-ghi.silk" }
```

结果写回同一个 `svc-outbox`：

```json
{ "id": "1780000000002-ghi", "userId": 10001, "kind": "asr", "groupId": null, "index": 0, "ok": true, "text": "今天下雨了", "seconds": 3.2 }
```

## 渲染机侧

轮询间隔、单任务超时、拉取与回传方式都由渲染机自己的脚本决定（`scp` / `rsync` 均可）。本仓库不附带渲染机脚本，只要遵守上面的文件名与 json 字段即可对接。

清理：渲染机删掉处理完的 `svc-inbox` 项，bridge 删掉发完的 `svc-outbox` 项。两边都不需要额外状态文件。
