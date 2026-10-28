<div align="center">

# qq-ai-bot

**把 QQ 变成一个有记忆、会说话、自己会找你的 AI 伙伴。**

OneBot 11 · DSH agent · 长期记忆 · 语音 · 看图 · 群聊 · 生图 · 唱歌

`Node.js ≥ 20` · `MIT`

</div>

---

## 这是什么

一个自托管的 QQ 机器人。消息经 [NapCat](https://github.com/NapNeko/NapCatQQ)（OneBot 11）进来，交给 DSH agent 处理，再带着人设、长期记忆、语音和表情包回去。

它不是「给聊天 API 套一层 QQ 协议」：后端跑的是真正的 agent —— 能读文件、跑命令、查网页、调用技能；记忆落盘、跨重启不丢；没人说话时，它自己写日记、发说说、隔几个小时来找你聊一句。

> 默认人设是一只叫「小玉」的虎鲸少女，称呼对方「老大」。人设只是一段配置，见 [人设与提示词](#人设与提示词)。

### 和常见的「QQ + 大模型」脚本有什么不同

| | 常见做法 | 本项目 |
|---|---|---|
| 后端 | 直连 chat completions | DSH agent（人设 / 工具 / 技能），失败可回退裸 API |
| 记忆 | 内存里几轮，重启归零 | `memory.md` + 会话回填 + 昨日日记 + `#回忆` 原话检索 |
| 上下文 | 一问一答 | 连发合并成一轮、多段回复、跨重启恢复 36 小时 |
| 输入 | 只接文字 | 文字 / 图片（视觉直传 + OCR）/ 语音条（原生转写 + 兜底 ASR）/ 表情包 |
| 主动行为 | 无 | 定时搭话、自动说说、自动日记、每周摘要 |
| 语音 | 无，或第三方云 API | Edge TTS 直连（10 种常用中文音色）+ 点歌换声 |
| 群聊 | 全局回声 | 群白名单、@ 或唤醒词、上下文缓存、引用回复 |

## 功能特性

### 对话

- **三种后端**：`dsh`（默认，真 agent）/ `acp`（持久会话）/ `deepseek`（裸 API 回退）。
- **模型热切换**：改 `model.json`，或在 QQ 里发 `#模型`，下一条消息立即生效，不用重启进程。
- **额度兜底**：主模型报「积分不足」类错误时，按 `fallbacks` 顺序自动换下一个。
- **连发合并**：最后一条消息之后静默 5 秒才答，把同一口气的几条合成一轮（`MERGE_BURST_MS`）。
- **多段回复**：模型用 `[[分]]` 标记把回复拆成几条依次发出，在 QQ 里像真人连着打字。
- **串行队列 + 最小间隔 + 长度上限**：降低被判定为「非人工批量发送」的风险。

### 记忆

- **长期记忆** `memory.md`：每轮读入，可直接编辑；删掉一条等于让它忘掉。
- **会话回填**：启动时从 chatlog 恢复最近 36 小时原文与最近 12 轮上下文，重启不断片。
- **昨日日记进 prompt**：它自己写的摘要，白捡一段昨日记忆。
- **按需捞原话** `#回忆 <关键词>`：提问命中关键词时从 90 天 chatlog 检索原话注入；没命中就不注入，绝不编。
- **每周摘要**：素材是原话而不是日记（日记是二手转述），覆盖「刚过去这一周」。

### 语音与音乐

- **语音回复**：直连 Edge TTS（`voice.mjs`），「说给我听 / 用语音」触发；`VOICE_AUTO=1` 时每条都配语音。
- **10 种常用中文音色**：`VOICE_NAME` 切换，`node voice.mjs --list` 看全量。
- **静音持久化**：`#语音 关` 之后重启也不会自动恢复。
- **语音条当聊天**：先问 NapCat 原生转写，拿不到就落盘交给外部 ASR 兜底。
- **点歌换声**：「我要听稻香」/ `#唱歌 稻香` → 找原曲 → 换成本项目的音色合成（SoulX-Singer 或 so-vits，需要 GPU 机器，协议见 [docs/remote-render.md](docs/remote-render.md)）。

### 看图与生图

- **视觉直传**：给 dsh headless 打补丁，图片真正进模型（`patch-headless-vision.mjs`）。
- **本地 OCR 补字**：Windows 自带 `Windows.Media.Ocr`（`ocr.cs` → `node build-ocr.mjs`），逐字精读，补视觉看错的字。
- **动图抽帧**：GIF 先拆成多张静态图再送，避免只拿到第一帧。
- **追问补图**：10 分钟内再问「图里写的啥」，会把原图重新直传一次。
- **生图**：`#生图 <描述>`；默认 pollinations（免 key，45 秒一张），也可接任意 OpenAI 兼容 `/v1/images/generations`。

### 群聊

群里的人和老大不是同一个人，这条线专门为此设计。**默认不接任何群**：`GROUP_ALLOW` 为空时，群消息连缓存都不做。

#### 什么时候说话

| 触发 | 判定依据 | 例子 |
|---|---|---|
| @她 | 消息段里有 `at` 指向机器人 QQ | `@小玉 这周末爬山吗` |
| 回复她 | `reply` 段命中她最后一条消息的 id | 长按她的话 → 回复 |
| 叫唤醒词 | 文本**开头**是唤醒词，后面跟分隔符或到结尾 | `小玉 在吗` / `小玉，早` |

`小玉在吗` 这种连写不算：群里每天都有人聊到这两个字，宁可漏一次，也别被叫一声就插话。

没被叫醒的群消息只进缓存，不调模型 —— 群里绝大多数聊天不花额度、不产生回复。

#### 一轮群聊长什么样

下面是按代码实际行为写的示意，不是真实聊天记录：

```text
阿明   这周六有人爬山吗
小美   我我我
阿明   @小玉 你去不去
小玉   ↳ 阿明：去啊，不过我这个体型爬到一半大概要人抬
```

- **只回叫她那条**：上面两条是背景，不挨个回应，也不总结全场
- **引用触发消息**：默认开（`GROUP_REPLY_QUOTE`）；多段回复只有第一条带引用，后面不带，避免刷屏
- **比私聊更短**：用 `[[分]]` 拆成几条依次发，中间留间隔，像群友连着打字
- **发送侧不额外 @ 人**：靠引用定位说话对象
- **认人**：群友不叫「老大」，各按自己的群名片称呼

#### 群里能做 / 不能做

| 能力 | 群聊 | 私聊 |
|---|---|---|
| 聊天、多段回复 | ✅ | ✅ |
| 看图（直传 / 引用消息里的图 / 合并转发里的图 / 表情包） | ✅ | ✅ |
| 主动出图（模型写 `[[画:…]]`） | ✅ | ✅ |
| 发表情包（模型写 `[[sticker:…]]`） | ✅ | ✅ |
| `#` 指令（`#模型` / `#日记` / `#唱歌` …） | ❌ 不解析 | ✅ |
| 语音条 | ❌ 只打字 | ✅ |
| 写长期记忆 | ❌ 标记剥掉但不写 | ✅ |
| 出错 / 降级提示 | ❌ 不刷屏 | ✅ |
| 主动搭话 / 说说 / 日记 | ❌ 只找老大 | ✅ |
| 连发合并（5 秒静默窗） | ❌ 每条 @ 各算一轮 | ✅ |
| 重启后恢复上下文 | ❌ 缓存只在内存 | ✅ 回落 36 小时 chatlog |

群里关掉这些不是没做完：一句「主模型不可用」、一条语音、一段私聊里的记忆，都是发给全群看的。

#### 上下文怎么拼

- 每群最多 **120 条 / 1800 字 / 12 小时**（`GROUP_CONTEXT_MAX` / `GROUP_CONTEXT_MAX_CHARS` / `GROUP_CONTEXT_MAX_AGE_H`）
- 只注入**上次她说话之后**的消息，已经答过的不重复喂
- 生成期间新到的消息不抢：这一轮真发出去之后游标才前移，留给下一轮
- 触发的那条只入库、不进本轮 prompt（prompt 末尾已经带了原话），但留给下一轮做上下文
- 缓存只在内存，重启清零
- 私聊发 `#群聊` 看状态：开关、白名单、唤醒词、每个群缓存了多少条 / 已注入多少条

### 主动行为

- **定时搭话**：间隔 3~6 小时随机，0–8 点静默，每天最多 4 次。
- **自动说说**：每天一次，20–22 点随机，默认好友可见（`QZONE_RIGHT=4`）；可先 `QZONE_DRY_RUN=1` 演练。
- **自动日记**：22–23 点随机写一篇，生成 HTML 归档。
- **每周摘要**：周日早上写，素材少于 12 句就不写（硬凑出来的回顾全是空话）。

## 架构

```
QQ 客户端
   │
   ▼
NapCat ── OneBot 11 正向 WebSocket ──►  bridge.mjs（单进程常驻）
                                          ├─ 指令解析 / 串行队列 / 合并连发
                                          ├─ 记忆 · 日记 · 回忆检索
                                          ├─ voice.mjs   （Edge TTS）
                                          ├─ vision.mjs  （视觉直传 + OCR）
                                          ├─ 生图 · 群聊 · 主动行为
                                          └─ sing.mjs    （点歌换声）
                                                │ spawn（每次调用一个子进程）
                                                ▼
                                      dsh --profile headless --patch <overlay>
                                          └─ agent：人设 / 工具 / 技能 / 模型
```

只有 `bridge.mjs` 一个常驻进程。NapCat 是外部依赖，负责 QQ 协议与登录。

**可选的文件队列**：渲染机轮询 `.run/svc-inbox/`，合成完写回 `.run/svc-outbox/`，由 bridge 发回 QQ —— 服务器没有 GPU 时，重活放另一台机器做。协议见 [docs/remote-render.md](docs/remote-render.md)。

## 快速开始

### 前置

- **Node.js ≥ 20**（生产用 v24）
- **NapCat**（Docker 或独立安装）与一个 QQ 小号
- **后端二选一**：
  - `BACKEND=dsh`（推荐）：`npm install -g @deepseek-ai/dsh`，并把模型凭据放到 `~/.dsh/.credentials.yaml`
  - `BACKEND=deepseek`：一个 DeepSeek API Key（环境变量 `DEEPSEEK_API_KEY`）

### 本地跑起来

```bash
git clone <this-repo> qq-ai-bot
cd qq-ai-bot
npm install

cp .env.example .env
vi .env            # 至少填 ALLOW_FROM（你自己的 QQ 号）

set -a; . ./.env; set +a
node bridge.mjs
```

看到 `[ws] 已连接` 后，用白名单里的 QQ 给小号发一条消息；发 `#帮助` 能看到指令列表。

### 配置 NapCat

在 NapCat 的 `config/onebot11_<你的机器人QQ>.json` 里开一个**正向 WebSocket 服务**（端口默认 3001）：

```json
{
  "network": {
    "httpServers": [],
    "httpClients": [],
    "websocketServers": [
      {
        "name": "local-bridge",
        "enable": true,
        "host": "127.0.0.1",
        "port": 3001,
        "messagePostFormat": "array",
        "reportSelfMessage": false,
        "token": "",
        "enableForcePushEvent": true,
        "debug": false,
        "heartInterval": 30000
      }
    ],
    "websocketClients": [],
    "httpSseServers": [],
    "plugins": []
  },
  "musicSignUrl": "",
  "enableLocalFile2Url": false,
  "parseMultMsg": false
}
```

完整样例见 [`deploy/napcat/onebot11.example.json`](deploy/napcat/onebot11.example.json)。若填了 `token`，bridge 侧的 `NAPCAT_TOKEN` 必须一致。

### 部署到服务器

```bash
sudo bash deploy/bootstrap.sh        # Node + dsh + Docker + swap（幂等）
# 把 .env 放到 /etc/qq-bot.env，然后
sudo cp deploy/qq-bot.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now qq-bot
```

可选的 systemd 定时任务：

| 单元 | 作用 |
|---|---|
| `deploy/napcat-watchdog.timer` | 每 30 秒检查 3001 端口，连续 3 次无监听就重启 NapCat |
| `deploy/qq-bot-cleanup.timer` | 每天 04:17 清理会话回收站里超过 7 天的目录 |

细节见 [`deploy/README.md`](deploy/README.md)。

## 配置

全部通过环境变量（systemd 用 `EnvironmentFile`）。完整清单见 [`.env.example`](.env.example)，下面是常用的部分。

### 基础

| 变量 | 默认 | 说明 |
|---|---|---|
| `NAPCAT_WS` | `ws://127.0.0.1:3001` | OneBot 11 正向 WS 地址 |
| `NAPCAT_TOKEN` | 空 | WS token，与 NapCat 保持一致 |
| `ALLOW_FROM` | 空 | 只回这些 QQ 号，逗号分隔。**留空 = 回所有人，不推荐** |
| `MIN_GAP_MS` | `2000` | 两条回复之间的最小间隔 |
| `MAX_REPLY_CHARS` | `800` | 单条回复字符上限 |
| `HISTORY_TURNS` | `12` | 内存里保留的对话轮数 |

### 后端与模型

| 变量 | 默认 | 说明 |
|---|---|---|
| `BACKEND` | `dsh` | `dsh` / `acp` / `deepseek` |
| `QQ_BOT_PROFILE` | `headless` | 用哪个 dsh profile（优先于继承来的 `DSH_PROFILE`） |
| `DSH_TIMEOUT_MS` | `90000` | 单次 agent 调用硬超时 |
| `DSH_KILL_GRACE_MS` | `5000` | 超时后等 stdout 交完答案的宽限 |
| `DSH_IDLE_DONE_MS` | `20000` | 输出静默这么久就认为答完了，主动收尾（`0` 关闭） |
| `DSH_CWD` | 脚本所在目录（Windows 为用户主目录） | agent 的工作目录 |
| `SELFCHECK` | `1` | 启动时用一个不存在的 provider 自检 `--patch` 是否生效 |
| `API_BASE` / `MODEL` | `https://api.deepseek.com` / `deepseek-chat` | `deepseek` 后端用 |
| `SYSTEM_PROMPT` | 内置 | 裸 API 后端的人设兜底 |

`model.json` 是热切换的模型配置：

```json
{
  "provider": "qodercn",
  "model": "dfmodel",
  "reasoningEffort": "high",
  "fallbacks": []
}
```

`#模型` 查看当前模型与候选，`#模型 <名字>` 切换，`#模型 effort low|medium|high|xhigh|max` 调思考档位，`#模型 auto` 恢复默认。

### 记忆

| 变量 | 默认 | 说明 |
|---|---|---|
| `MEMORY_PATH` | `./memory.md` | 长期记忆文件 |
| `HISTORY_RESTORE` | `1` | 启动时从 chatlog 回填上下文 |
| `HISTORY_RESTORE_HOURS` | `36` | 只回填这么久以内的原文 |
| `DIARY_IN_PROMPT` | `1` | 把昨日日记当摘要注入 |
| `RECALL` / `RECALL_DAYS` / `RECALL_LIMIT` | `1` / `90` / `8` | `#回忆` 原话检索 |

### 语音 / 视觉 / 群聊 / 生图

| 变量 | 默认 | 说明 |
|---|---|---|
| `VOICE_ENABLED` / `VOICE_AUTO` | `1` / `1` | 语音总开关 / 每条回复都配音 |
| `VOICE_NAME` | `zh-CN-XiaoyiNeural` | 音色，见 `voice.mjs` 的 `VOICES` |
| `IMAGE_ENABLED` | `1` | 图片消息总开关 |
| `VISION_ENABLED` | `1` | 图片直传模型 |
| `OCR_ENABLED` | `1` | 本地 OCR 补字（Windows 才有 `ocr.exe`） |
| `ANIM_FRAMES` | `6` | 动图抽帧上限 |
| `GROUP_ALLOW` | 空 | 群白名单，逗号分隔；空 = 不接群 |
| `GROUP_WAKE` | `小玉` | 除 @ 之外的唤醒词 |
| `GROUP_CONTEXT_MAX` / `GROUP_CONTEXT_MAX_CHARS` | `120` / `1800` | 群上下文缓存上限 |
| `IMAGE_GEN_PROVIDER` | `pollinations` | `pollinations` / `openai` / `off` |
| `IMAGE_GEN_API_KEY` | 空 | `openai` 类服务用 |

### 主动行为

| 变量 | 默认 | 说明 |
|---|---|---|
| `PROACTIVE_ENABLED` | `1` | 定时搭话 |
| `PROACTIVE_MORNING_MIN` / `PROACTIVE_MORNING_MAX` | `1` / `2` | 上午条数区间 |
| `PROACTIVE_AFTERNOON_MIN` / `PROACTIVE_EVENING_MIN` | `3` / `2` | 下午 / 晚上保底条数 |
| `PROACTIVE_EXTRA_MIN_GAP_H` / `PROACTIVE_EXTRA_MAX_GAP_H` | `1.5` / `3` | 保底发完后的随机间隔（小时） |
| `PROACTIVE_QUIET_START` / `PROACTIVE_QUIET_END` | `0` / `8` | 静默时段 |
| `PROACTIVE_DAILY_MAX` | `12` | 全天硬上限 |
| `QZONE_ENABLED` / `QZONE_DRY_RUN` | `1` / `0` | 自动说说 / 只演练不真发 |
| `QZONE_RIGHT` | `4` | 1 所有人 / 4 好友 / 64 仅自己 |
| `DIARY_ENABLED` | `1` | 自动写日记 |
| `WEEKLY` | `1` | 每周摘要 |

## 指令

指令以 `#` 开头（全角 `＃` 也认，`#` 后不加空格也行）。点歌也支持自然说法。

| 指令 | 作用 |
|---|---|
| `#帮助` | 指令列表 |
| `#模型` | 看当前模型、降级链与候选 |
| `#模型 <名字>` / `#模型 auto` | 切换模型 / 恢复默认 |
| `#模型 effort low\|medium\|high\|xhigh\|max` | 调思考档位 |
| `#日记` | 写今天的一篇日记（已写过就接着写） |
| `#回忆 <关键词>` | 翻旧对话原话，支持 `#回忆 包子 10-21`、`10-19~10-23`、`最近3天` |
| `#语音` / `#语音 关` / `#语音 开` | 查状态 / 静音 / 恢复（落盘，重启不忘） |
| `#生图 <描述>` | 画一张图 |
| `#群聊` | 群聊开关、唤醒词与缓存状态 |
| `#唱歌 <歌名>` / 「我要听稻香」 | 原曲换声 |

## 目录结构

```
.
├── bridge.mjs                 主进程：WS 接入、指令、队列、记忆、定时任务
├── voice.mjs                  Edge TTS 直连合成
├── vision.mjs                 看图：视觉直传清单 + 本地 OCR
├── sing.mjs                   点歌换声（SoulX / so-vits、词曲处理）
├── acp-client.mjs             ACP 后端客户端
├── diary-gen.mjs              日记 HTML 生成
├── anim.py / asr_transcribe.py           动图抽帧 / 语音转写
├── ocr.cs / ocr.ps1 / build-ocr.mjs      Windows OCR（C# 源码 + 构建脚本）
├── svc_song.py / prompt2soulx.py / score2soulx.py   歌声合成侧工具
├── patch-headless-vision.mjs  给 dsh headless 打视觉直传补丁
├── patch-dsh-sse-cancel.mjs   修 dsh 收到 [DONE] 后不释放连接导致不退出
├── patch-dsh-force-exit.mjs   dsh 收尾兜底（答完即退）
├── dsh-wrapper-guard.sh       dsh 启动前检查补丁是否还在（升级后自动重打）
├── probe-dsh-handles.mjs      只读探针：dump 收尾后仍存活的句柄与创建栈
├── test-sse-cancel.mjs        确定性用例：SSE 消费器是否 cancel 响应体
├── test-bridge-cmds.mjs       指令解析用例
├── test-e2e-shadow.mjs        影子端到端（假 NapCat + 假 dsh）
├── mock-napcat.mjs            本地假 NapCat，调试用
├── tag-stickers.mjs           给表情包打标签（视觉模型看图生成名字与关键词）
├── model.json                 模型配置（热切换）
├── .env.example               环境变量样例
├── memory.example.md          长期记忆的格式样例
├── deploy/                    bootstrap、systemd 单元、看门狗、清理脚本
├── docs/remote-render.md      跨机渲染（点歌 / ASR）协议
└── vendor/                    Edge TTS token 算法（纯标准库）
```

## 实现细节

几个不显然、但踩过的坑（都在代码注释里留了现场）：

- **dsh 答完不退**：SSE 消费器收到 `data: [DONE]` 就 `break`，`finally` 只 `releaseLock()` 不 `cancel()`，undici keep-alive 连接把事件循环吊住。修法是 `patch-dsh-sse-cancel.mjs`；`dsh-wrapper-guard.sh` 在每次启动前检查补丁是否被升级覆盖。
- **超时不能丢答案**：dsh 把答案写进 stdout 之后进程可能不退，所以超时后先等 `DSH_KILL_GRACE_MS` 收完输出再 `SIGTERM`，而不是直接丢。
- **连发合并**：人打字是一句一发，一条一轮会把同一口气拆成两次问答。默认 5 秒静默 + 20 秒上限。
- **IPv4 优先**：只有 IPv4 出口的机器上，`fetch` 拿到 AAAA 会先试 IPv6 然后超时。进程启动第一件事就是 `setDefaultResultOrder("ipv4first")`。
- **人设走 system prompt**：`AGENTS.md` 是以 user 消息注入的，管不住 thinking；真正的槽位是 dsh system-prompt 插件的 `personaPrefix`。
- **`--patch` 叠层**：模型选择放在每次调用的 `--patch` 里，而不是改 profile 静态配置 —— 于是换模型不用重启，也不影响别的调用方。

## 人设与提示词

- 裸 API 后端：`SYSTEM_PROMPT` 环境变量。
- dsh 后端：在 dsh profile 的 `cordis.patch.yml` 里改 `system-prompt` 插件的 `personaPrefix`（本仓库不含该文件，它在 dsh 的 profile 目录下）。
- 长期记忆：直接编辑 `memory.md`。

## 已知限制

- **headless 不跨调用保留上下文**：每次调用都是新会话，记忆靠 `memory.md` + chatlog 回填。
- **OCR 只在 Windows 可用**：`ocr.exe` 调的是 `Windows.Media.Ocr`；Linux 上请设 `OCR_ENABLED=0`，只走视觉直传。
- **唱歌需要另一台有 GPU 的机器**：`sing.mjs` 只负责协议与拼装，真正的合成在渲染机上跑。
- **主动行为有风控风险**：定时消息、说说、群发都按保守默认值设置，请自行评估账号风险。
- **单用户设计**：白名单是主人列表，不是多租户隔离 —— 同一份记忆、同一份人设，不要拿它做公开客服。

## 贡献

欢迎 issue 与 PR。提交前请：

```bash
node bridge.mjs --selftest      # 断言必须全绿（缺本地素材时相关断言会 SKIP）
bash -n deploy/*.sh
```

改动 `bridge.mjs` 的行为时，请同步补一条 `selftest` 断言 —— 这个项目里大多数 bug 都曾经在「看起来没问题」的时候复发过。

## 许可

[MIT](LICENSE)

## 致谢

- [NapCat](https://github.com/NapNeko/NapCatQQ) —— QQ 协议端，OneBot 11 实现
- [AstrBot](https://github.com/AstrBotDevs/AstrBot) —— 群聊上下文与多平台架构的参考
- [LangBot](https://github.com/langbot-app/LangBot) —— 项目组织与文档结构的参考
- [edge-tts](https://github.com/rany2/edge-tts) —— TTS 协议与 token 算法
- SoulX-Singer —— 歌声合成
- DSH（DeepSeek Harness）—— agent 运行时
