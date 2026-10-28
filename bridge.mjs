#!/usr/bin/env node
/**
 * QQ 私聊 AI 桥接服务（OneBot 11 正向 WebSocket → DSH agent / DeepSeek）
 *
 * 链路：QQ 小号 ← NapCat(OneBot11) ←ws→ 本服务 ←→ dsh --profile headless --patch <overlay>
 *
 * 两种后端：
 *   BACKEND=dsh      调 dsh --profile headless（真正的 DSH agent：人设+工具+技能，约 3 秒）
 *   BACKEND=deepseek 直连 chat API（快，但只是个聊天机器人，用于回退）
 *
 * 记忆方案：
 *   长期 —— memory.md，每次调用前读入、可手动编辑
 *   短期 —— 内存里保留最近 N 轮，拼进 prompt（headless 不跨调用保留上下文）
 *
 * ── 模型调节（2026-10-18 新增）───────────────────────────────────────────
 * 老大要能在 WB 额度用尽前自己换模型，所以模型不再写死在 profile 里：
 *   1. 改 model.json            → 下一条消息立即生效，不用重启 bridge，不用碰 ~/.dsh
 *   2. QQ 里发 #模型            → 看当前模型、降级链、免费/烧积分的候选
 *   3. QQ 里发 #模型 <名字>      → 切换（只认白名单；例：#模型 workbuddy-ai:hy3）
 *   4. 额度用尽自动降级          → 主模型报「积分不足」类错误时，按 fallbacks 顺序自动换
 *
 * 为什么用 --patch 叠加层，而不是改 ~/.dsh/profiles/headless/cordis.patch.yml：
 *   - 那份是 profile 静态配置：改一次要重启，还会影响所有调用这份 profile 的地方
 *   - dsh 支持 --patch（在 profile 层之后应用，优先级更高），每次调用单独带一份
 *   - 于是模型选择变成「每条消息一个参数」，天然热切换
 *   ⚠️ 唯一能盖掉 --patch 的是 ~/.dsh/settings.yaml 里的 agent-default-model 段
 *      （settings 用户层覆盖 composition base），启动时会检查并告警。
 *
 * 设计取舍（每条都对应一个真实的翻车点）：
 * 1. 只回私聊、只回白名单 —— 陌生人也回是最快触发风控的行为
 * 2. 串行队列 —— 并发回复会被判定为「非人工批量发送」
 * 3. 最小间隔 + 单条长度上限 —— 高频短消息是机器人特征
 * 4. 断线自动重连 —— NapCat 重启后不会静默失联
 * 5. dsh 超时 + 自动回退 —— agent 卡住时不能把 QQ 晾在那里
 */

import { WebSocket } from "ws";
import {
  readFileSync,
  readlinkSync,
  readdirSync,
  writeFileSync,
  existsSync,
  appendFileSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
  rmSync,
  openSync,
  closeSync,
  readSync,
  copyFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { join, dirname, basename, extname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync, execFile } from "node:child_process";
import { createServer } from "node:http";
import { setDefaultResultOrder, getDefaultResultOrder } from "node:dns";
import { speakToFile, VOICES } from "./voice.mjs";
import { sing, SONGS, SINGERS, SONG_IDS, MAX_LYRICS, SING_PROVIDER, volcConfigured, buildVolcBody, volcUrl, estimateF0 } from "./sing.mjs";
import { ocrImages, expandAnimatedImages } from "./vision.mjs";
import { AcpClient } from "./acp-client.mjs";
import renderDiaryHtml from "./diary-gen.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ECS 只有 IPv4 出口，DNS 返回 AAAA 时 Node fetch 会先试 IPv6 直接 ETIMEDOUT
// （curl 能自动退回 IPv4，所以两边表现不同）。必须在任何 fetch 之前设好。
setDefaultResultOrder("ipv4first");

/**
 * 选 profile 名。
 *
 * 环境变量优先级：QQ_BOT_PROFILE > DSH_PROFILE > headless。
 * 但 DSH_PROFILE 只有在不是 desktop 时才认 —— desktop 由 Electron 独占，
 * 独立 CLI 根本 boot 不了它（dsh 会直接报错），出现它只可能是宿主环境串味。
 */
function pickDshProfile() {
  const explicit = (process.env.QQ_BOT_PROFILE ?? "").trim();
  if (explicit) return explicit;
  const inherited = (process.env.DSH_PROFILE ?? "").trim();
  if (inherited && inherited.toLowerCase() !== "desktop") return inherited;
  return "headless";
}

// ── 配置 ────────────────────────────────────────────────────────────────
const CFG = {
  wsUrl: process.env.NAPCAT_WS ?? "ws://127.0.0.1:3001",
  wsToken: process.env.NAPCAT_TOKEN ?? "",

  // 只回复这些 QQ 号。留空 = 回复所有人（不推荐）
  allowFrom: (process.env.ALLOW_FROM ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number),

  minGapMs: Number(process.env.MIN_GAP_MS ?? 2000),
  maxReplyChars: Number(process.env.MAX_REPLY_CHARS ?? 800),
  historyTurns: Number(process.env.HISTORY_TURNS ?? 12), // 2026-10-22：6→12，上午说的下午还要记得

  // ── 连发合并（2026-10-22 15:5x 新增）────────────────────────────────
  // 起因：老大贴 10:24~10:47 日志说她「无法承接上下文」，并明确说
  // 「分成两个回合我觉得太过于割裂」。
  //
  // 真实现场（chatlog + bridge.log 双向核对过）：
  //   10:24:29 老大：你现在还是缺少一些活人味
  //   10:24:33 模型失败（UNKNOWN_MODEL）→ 这轮没回复
  //   10:24:45 老大：我一定一定要给你弄好
  //   10:24:50 回复：嫌我假呗        ← 这句回的是**两条合起来**，但只按第二条生成
  // 人打字本来就一句一发，「你先别急」和「我明天再说」是**同一口气**。
  // 之前的实现是一条消息一轮，于是同一口气被拆成两次问答，她每次只看见半句。
  // 现在：先攒 DEBOUNCE_MS，期间来的合并成一轮再答。
  //   2026-10-27：原来 1200ms，把同一口气切回两轮——老大常一句话拆几条，
  //   有时隔 3 秒再补一张图。改成 5 秒静默：最后一条之后 5 秒没人再说话，
  //   才把这几条的文字和图片一起送进去答一次。
  //   代价：每条回复至少晚 5 秒（小于一次模型调用 6~17s）。
  //   关掉：MERGE_BURST_MS=0（回到一条一轮）。
  mergeBurstMs: Number(process.env.MERGE_BURST_MS ?? 5000),
  // 合并上限：攒太久也不能无限等。必须显著大于静默窗口，否则连发到第 6 秒
  // 就被上限强行放行、5 秒静默等于没设。20 秒 ≈ 6 条 × 3 秒间隔。
  mergeBurstMaxMs: Number(process.env.MERGE_BURST_MAX_MS ?? 20000),

  // ── 连续回复（2026-10-22 17:0x 新增）────────────────────────────────
  // 老大要「很活泼地回复两三句」。机制：模型用 [[分]] 标记把回复拆成几条，
  // bridge 依次发出去 —— 在 QQ 里就是连着蹦出来几条，像真人打字。
  // 条与条之间的间隔：太小会糊成一坨，太大又不像连着说。
  multiGapMs: Number(process.env.MULTI_GAP_MS ?? 700),
  // 最多分几条：防刷屏。超出的部分并进最后一条，不丢内容。
  multiMaxSegments: Number(process.env.MULTI_MAX_SEGMENTS ?? 4),

  // ── 跨重启记忆（2026-10-21 19:2x 新增，方案见 PLAN-histories.md）──────
  // 背景：histories 原来只在内存，进程一重启就断片；chatlog 明明落着盘，
  // 却只喂给「写日记」。结果老大每天重开，她都像第一次聊天。
  // 现在启动时从 chatlog 回填最近几轮，并把「昨天的日记」当昨日摘要注入。
  historyRestore: (process.env.HISTORY_RESTORE ?? "1") !== "0",
  // 只回填这么久以内的原文：更早的对话进上下文只会让她答非所问
  // 2026-10-22：12→36h。实测 12h 窗会丢掉「昨晚傍晚」的对话（今早 8 点启动，
  // 窗口只到昨晚 20 点，18:59 的「晚课」被丢 → 她只能编）。
  historyRestoreHours: Number(process.env.HISTORY_RESTORE_HOURS ?? 36),
  // 回填条数，默认与运行时裁剪一致（12 轮 = 24 条），不放大上下文
  // 2026-10-22：这里的 fallback 原来写死 6，导致把 HISTORY_TURNS 改成 12 后
  // 恢复仍只有 12 条（日志 [hist] 恢复 12 条）。现同步为 12。
  historyRestoreMsgs: Number(
    process.env.HISTORY_RESTORE_MSGS ?? Number(process.env.HISTORY_TURNS ?? 12) * 2
  ),
  // 昨日日记进 prompt：她自己写的昨日摘要，白捡，不用再花一次模型调用
  diaryInPrompt: (process.env.DIARY_IN_PROMPT ?? "1") !== "0",
  diaryPromptChars: Number(process.env.DIARY_PROMPT_CHARS ?? 1200), // 2026-10-22：600→1200，摘要太细被截断她会编

  // ── 按需捞旧原话（2026-10-26 新增，见 recallFromChatLog）───────────────
  // 补的是「窗口只覆盖 24 条 / 97.1% 的对话看不见」这个洞。
  // 只在提问命中关键词时注入，且至少 2 条才注入；没命中就不加，绝不编。
  // 关掉：RECALL=0。想让它捞得更久：RECALL_DAYS=180。
  recallEnabled: (process.env.RECALL ?? "1") !== "0",
  recallDays: Number(process.env.RECALL_DAYS ?? 90),
  recallLimit: Number(process.env.RECALL_LIMIT ?? 8),

  // ── 后端选择 ──
  // 2026-10-19：ACP 后端已写好但**暂不默认启用**。
  // 原因（实测）：`dsh --profile acp` 的持久会话确实能用（两轮能记住上文），
  // 但把 provider 换成 workbuddy 时 `session/new` 报 -32603 Internal error，
  // 而 ACP 默认只提供 deepseek-official（要真花钱）且 image=false（丢识图）。
  // 在 workbuddy 灌进 acp profile 之前，切过去等于用「现在能看图 + 走积分」换「省 token」，
  // 不划算。调通后把这里改成 "acp" 即可。
  backend: (process.env.BACKEND ?? "dsh").toLowerCase(),
  // ACP 后端用的 profile 名（dsh 内置，不需要自己建）
  acpProfile: process.env.ACP_PROFILE ?? "acp",

  // dsh 后端
  // ⚠️ 不能直接信 DSH_PROFILE：在 DSH 会话里它就是 desktop，从终端/IDE 启动 bridge
  //    会继承到，于是 dsh 去 boot 桌面版 profile（2026-10-18 实测：测试时 #状态 显示 profile=desktop）。
  //    run-bridge.bat 会清掉它，但那只是「记得清」；这里再加一道硬拦截。
  dshProfile: pickDshProfile(),
  // dsh 单次调用的硬超时（毫秒）。超过就回退
  dshTimeoutMs: Number(process.env.DSH_TIMEOUT_MS ?? 90000),
  // 超时后等 close 交出 stdout 的宽限（毫秒）。2026-10-27 实测 dsh 会出现
  // 「答案已写进 stdout、进程不退」，SIGTERM 后 27ms 内正常退出 —— 必须留窗口收答案。
  dshKillGraceMs: Number(process.env.DSH_KILL_GRACE_MS ?? 5000),
  // stdout/stderr 都静默这么久 ⇒ 认定 dsh 已答完、只是事件循环没退，主动 SIGTERM 收尾。
  // 2026-10-27 21:40 抓现场：卡住的 dsh 主线程 wchan=ep_poll、3 秒内 rchar/wchar 一字未变、
  // 无子进程，挂着的只有到模型网关的 ESTAB 连接(fd 25) 和 inotify(fd 399) —— 纯粹是
  // 未释放句柄让进程吊着。两个流都看，思考期间 stderr 有输出就不会误杀。0 = 关闭。
  dshIdleDoneMs: Number(process.env.DSH_IDLE_DONE_MS ?? 20000),
  // 调用 dsh 时的工作目录（Linux 上默认就是 bot 自己所在目录）
  dshCwd: process.env.DSH_CWD ?? (process.platform === "win32" ? homedir() : __dirname),
  // 启动自检：用一个不存在的 provider 试跑，确认 --patch 真的生效
  selfCheck: (process.env.SELFCHECK ?? "1") !== "0",
  // 启动时跑配置守卫（.run/guard-dsh-config.mjs --check），发现人设/模型被改就报警。
  // 2026-10-23 WB 改坏过 desktop profile 与 AGENTS.md，故加此闸门。关掉：CONFIG_GUARD=0
  // ⚠️ 2026-10-24：qqbot 已迁到服务器，本地 bridge 不再常驻 ⇒ 这个启动检查**实际不会触发**。
  //    真正的守卫已搬到 DSH 的 SessionStart 钩子（`~/.dsh-hooks/config-guard.cjs`）。
  //    这里保留只是为了「万一又本地起 bridge 调试」时还有一道闸。
  configGuard: (process.env.CONFIG_GUARD ?? "1") !== "0",

  // 记忆文件
  memoryPath: process.env.MEMORY_PATH ?? join(__dirname, "memory.md"),
  // 是否在降级时于 QQ 里提示（只提示一次）
  notifyFallback: (process.env.NOTIFY_FALLBACK ?? "1") !== "0",
  // 出错时是否回一句（不然老大只看到「已读不回」）
  notifyError: (process.env.NOTIFY_ERROR ?? "1") !== "0",

  // ── 语音（2026-10-18 新增）──────────────────────────────────────────
  // 老大发「说给我听 / 语音说 / 用语音」→ 把那条回复合成 MP3 发出去。
  // 直接发整段文字可关掉：VOICE_ENABLED=0
  voiceEnabled: (process.env.VOICE_ENABLED ?? "1") !== "0",
  // 默认音色（可选值见 voice.mjs 的 VOICES）
  voiceName: process.env.VOICE_NAME || VOICES.xiaoyi,

  // ── 识图（2026-10-18 新增，2026-10-19 改为本地 OCR）──────────────────
  // 收到图片时：下载到 .run/img/，然后**本地 OCR** 把图里文字读出来塞 prompt
  // （vision.mjs → ocr.exe → Windows 自带 Windows.Media.Ocr）。
  //
  // 为什么不用「模型自己读图」：dsh headless 链路不把图片送给模型
  // （CLI 无附件参数、attachments 目录空；2026-10-19 实验证实 task 里写路径
  // 模型只当字符串看）。而 WB 模型目录 supportsImages 全 true——瓶颈在链路不在模型。
  // 局限：OCR 只读文字，读不出画面（表情包常常没字，会如实说没读到）。
  // 2026-10-19 09:52 更新：**dsh 已经能真正送图给模型**（A 路打通）。
  // 之前「headless 不送图」的判断只差最后一层：headless 的 prompt 构造写死了
  // 纯文本块（dsh-headless/lib/index.js 原第 154 行），而下游 pi-ai 适配器
  // 本来就完整支持 image 内容块（contentHasImage / userContent 的 image 分支）。
  // 现已给 headless 打上视觉补丁：读 DSH_EXP_IMAGES 指向的清单文件，
  // 经 ctx.attachments.admitPromptContent() 转成持久附件引用后送模型。
  // 实测 workbuddy/deepseek-v4.1-flash 能描述表情包画面（人物/颜色/表情/动作）。
  // 所以现在：视觉为主，OCR 退为「精确文字补充」（视觉模型可能看错字，OCR 逐字准）。
  imageEnabled: (process.env.IMAGE_ENABLED ?? "1") !== "0",
  // 视觉直传开关（关掉就退回纯 OCR / 诚实模式）
  visionEnabled: (process.env.VISION_ENABLED ?? "1") !== "0",
  // OCR 开关（独立于 visionEnabled：视觉已通，OCR 只作为文字精读补充）
  ocrEnabled: (process.env.OCR_ENABLED ?? "1") !== "0",
  // 动图抽帧上限：GIF 直传只能拿到第一帧，所以先拆成 N 张静态图再送。
  // 0 = 关闭抽帧（动图按单帧静态图处理）
  animFrames: Number(process.env.ANIM_FRAMES ?? 6),
  // 追问补图窗口：图只在自己发来的那一轮是像素，之后历史里只剩占位符。
  // 这个时间内他再问「图里写的啥」，就把那张图重新直传一次。
  imageReattachMs: Number(process.env.IMAGE_REATTACH_MS ?? 600_000),

  // ── 群聊（2026-10-26，借鉴 AstrBot group_chat_context）────────────────
  // 默认不接任何群：GROUP_ALLOW 为空时，群消息连缓存都不做（保持旧行为）。
  // 填法：GROUP_ALLOW=123456789,987654321；填 * 表示所有群（不推荐）。
  groupEnabled: (process.env.GROUP_ENABLED ?? "1") !== "0",
  groupAllow: String(process.env.GROUP_ALLOW ?? "")
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean),
  // 除 @ 之外，消息开头叫这个名字也算在叫小玉（空 = 只认 @）
  groupWake: (process.env.GROUP_WAKE ?? "小玉").trim(),
  // 每群缓存条数 / 单次最多注入字符 / 只保留多久
  groupContextMax: Number(process.env.GROUP_CONTEXT_MAX ?? 120),
  groupContextMaxChars: Number(process.env.GROUP_CONTEXT_MAX_CHARS ?? 1800),
  groupContextMaxAgeMs: Number(process.env.GROUP_CONTEXT_MAX_AGE_H ?? 12) * 3600_000,
  // 回复时引用触发消息（QQ 里显示「回复 @某人」）
  groupReplyQuote: (process.env.GROUP_REPLY_QUOTE ?? "1") !== "0",
  // 群里不发语音（发送路径只对私聊合成语音），prompt 也固定按纯文字写。

  // ── 生图（2026-10-26）──────────────────────────────────────────────────
  // pollinations：免 key，实测可用但限速 1 张/45 秒（本地会排队）；
  // openai：任何 OpenAI 兼容 /v1/images/generations（硅基流动 Kolors、
  //         智谱 v4 cogview-3-flash、自建网关），需要 IMAGE_GEN_API_KEY；
  // off：关闭。
  imageGenEnabled: (process.env.IMAGE_GEN_ENABLED ?? "1") !== "0",
  imageGenProvider: (process.env.IMAGE_GEN_PROVIDER ?? "pollinations").toLowerCase(),
  imageGenModel: process.env.IMAGE_GEN_MODEL ?? "",
  imageGenBaseUrl: process.env.IMAGE_GEN_BASE_URL ?? "",
  imageGenKey: process.env.IMAGE_GEN_API_KEY ?? "",
  imageGenTimeoutMs: Number(process.env.IMAGE_GEN_TIMEOUT_MS ?? 180000),
  imageGenMinGapMs: Number(process.env.IMAGE_GEN_MIN_GAP_MS ?? 45000),
  imageGenSize: process.env.IMAGE_GEN_SIZE ?? "768x768",

  // ── 主动行为（2026-10-19 新增）────────────────────────────────────────
  // 自动语音：每条回复都配一条语音，不再等关键词（老大 09:46 要的）
  voiceAuto: (process.env.VOICE_AUTO ?? "1") !== "0",

  // 主动发消息：隔一段时间自己找老大说句话
  proactiveEnabled: (process.env.PROACTIVE_ENABLED ?? "1") !== "0",
  proactiveMinGapHours: Number(process.env.PROACTIVE_MIN_GAP_H ?? 3),
  proactiveMaxGapHours: Number(process.env.PROACTIVE_MAX_GAP_H ?? 6),
  // 静默时段（24 小时制，含头不含尾；跨零点允许 start > end）
  proactiveQuietStart: Number(process.env.PROACTIVE_QUIET_START ?? 0),
  proactiveQuietEnd: Number(process.env.PROACTIVE_QUIET_END ?? 8),
  proactiveDailyMax: Number(process.env.PROACTIVE_DAILY_MAX ?? 4),

  // 自动发说说（NapCat 扩展接口 send_qzone_msg）
  qzoneEnabled: (process.env.QZONE_ENABLED ?? "1") !== "0",
  qzoneDailyTimes: Number(process.env.QZONE_DAILY_TIMES ?? 1),
  // 可见范围：1 所有人 / 4 好友 / 16 部分好友 / 64 仅自己 / 128 部分好友不可见
  // 2026-10-19 11:05 定为 4（好友可见）：老大原话「把自动发说说…都弄上吧」= 要真发，
  // 但全公开（1）没必要，好友可见既符合正常发说说的用法，风险也小。
  qzoneRight: Number(process.env.QZONE_RIGHT ?? 4),
  // 演练模式：`QZONE_DRY_RUN=1` 才开（只生成文案发到 QQ，不碰空间）。
  // 默认关闭 = 真发（老大 10:01 明确要"弄上"，演练只是我临时加的安全垫）。
  qzoneDryRun: (process.env.QZONE_DRY_RUN ?? "0") !== "0",
  // 每天在哪个小时段内随机挑时间发（默认 20-22 点）
  qzoneHourStart: Number(process.env.QZONE_HOUR_START ?? 20),
  qzoneHourEnd: Number(process.env.QZONE_HOUR_END ?? 22),

  // 自动写日记（2026-10-19 老大要求：不是他叫才写，是自己每天写）
  diaryEnabled: (process.env.DIARY_ENABLED ?? "1") !== "0",
  // 默认 22~23 点之间随机，睡前写
  diaryHourStart: Number(process.env.DIARY_HOUR_START ?? 22),
  diaryHourEnd: Number(process.env.DIARY_HOUR_END ?? 23),

  // ── 每周话题摘要（2026-10-26 P1-2）──────────────────────────────────────
  // 补「一天日记 300 字」与「长期约定 6 条」之间缺的那一层：一周发生了什么。
  // 素材是**原话**不是日记（日记是二手转述，再转述偏差会累加）。
  // 关掉：WEEKLY=0
  weeklyEnabled: (process.env.WEEKLY ?? "1") !== "0",
  // 0=周日 … 6=周六。默认周日早上写，覆盖「刚过去这一周」。
  weeklyDay: Number(process.env.WEEKLY_DAY ?? 0),
  weeklyHourStart: Number(process.env.WEEKLY_HOUR_START ?? 9),
  weeklyHourEnd: Number(process.env.WEEKLY_HOUR_END ?? 11),
  weeklyDays: Number(process.env.WEEKLY_DAYS ?? 7),
  // 素材少于这么多句就不写：硬凑出来的回顾全是空话，还会污染之后的检索
  weeklyMinLines: Number(process.env.WEEKLY_MIN_LINES ?? 12),
  // 图片缓存目录与保留数量
  imageDir: join(__dirname, ".run", "img"),
  imageKeep: Number(process.env.IMAGE_KEEP ?? 50),

  // ── 收歌换声（2026-10-25）─────────────────────────────────────────────
  // 老大发音频/语音 → 落到 audioDir → 写 job 到 svcInboxDir →
  // 笔记本上的 watch-inbox.mjs 拉走渲染 → mp3 放进 svcOutboxDir →
  // 本进程轮询 outbox 发回去。服务器没有 GPU，重活只能在笔记本上做。
  audioDir: join(__dirname, ".run", "audio-in"),
  svcInboxDir: process.env.SVC_INBOX ?? join(__dirname, ".run", "svc-inbox"),
  svcOutboxDir: process.env.SVC_OUTBOX ?? join(__dirname, ".run", "svc-outbox"),
  svcPollMs: Number(process.env.SVC_POLL_MS ?? 5000),
  svcMaxBytes: Number(process.env.SVC_MAX_BYTES ?? 60 * 1024 * 1024),

  // ── 语音条当聊天（2026-10-25）─────────────────────────────────────────
  // 先问 QQ 自带的 fetch_ptt_text，最多等 4 秒；拿不到就落盘交给笔记本
  // whisper 兜底（服务器没有 ASR）。语音不再进 svc-inbox 换声队列。
  svcAsrInboxDir: process.env.SVC_ASR_INBOX ?? join(__dirname, ".run", "svc-asr-inbox"),
  voiceNativeTimeoutMs: Number(process.env.VOICE_NATIVE_TIMEOUT_MS ?? 4000),
  voiceAsrTimeoutMs: Number(process.env.VOICE_ASR_TIMEOUT_MS ?? 45000),

  // deepseek 后端（回退用）
  apiBase: process.env.API_BASE ?? "https://api.deepseek.com",
  model: process.env.MODEL ?? "deepseek-chat",
  systemPrompt:
    process.env.SYSTEM_PROMPT ??
    "你是小玉，一只虎鲸少女，聪明但慵懒，带点傲娇，语气甜。自称「我」，称呼对方「老大」。你在 QQ 上私聊，说话自然简短，像正常人打字，不要用 Markdown 标题和列表，不要自称 AI 助手。",
};

// ── 日志（同时写控制台和 bridge.log）────────────────────────────────────
const LOG_PATH = join(__dirname, "bridge.log");
const LOG_MAX_BYTES = 2 * 1024 * 1024;

function rotateLog() {
  try {
    if (existsSync(LOG_PATH) && statSync(LOG_PATH).size > LOG_MAX_BYTES) {
      renameSync(LOG_PATH, `${LOG_PATH}.1`);
    }
  } catch {}
}

function stamp() {
  return new Date().toLocaleString("zh-CN", { hour12: false });
}

function log(...args) {
  const line = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
  console.log(line);
  try {
    appendFileSync(LOG_PATH, `[${stamp()}] ${line}\n`, "utf8");
  } catch {}
}

function logErr(...args) {
  const line = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
  console.error(line);
  try {
    appendFileSync(LOG_PATH, `[${stamp()}] ${line}\n`, "utf8");
  } catch {}
}

// ── 模型配置（老大可调，改完立即生效）──────────────────────────────────
const MODEL_CFG_PATH = join(__dirname, "model.json");
const RUN_DIR = join(__dirname, ".run");
const OVERLAY_PATH = join(RUN_DIR, "model-overlay.yml");

/**
 * 默认值：qodercn 的 DeepSeek-Flash（目录 key `dfmodel`）。
 *
 * 2026-10-23 更正：`deepseek-v4.1-flash` 是 WB 的 id，**不在 qodercn 目录里**。
 * 传它虽然能出话，但 adapter 查不到目录条目 ⇒ supportsImage / efforts 全空
 * （图片被 DSH 丢弃、任何档位都报 UNSUPPORTED_REASONING_EFFORT）。
 * 实测远端目录 10 个模型全为 vl=true，dfmodel 带 high / max / low。
 *
 * reasoningEffort 才是真正影响积分的大头：
 *   同一句「在吗」，low 只花几个思考 token，max 能花几百个。
 *   默认按老大要求用 high；闲聊嫌贵再手动调低。
 */
const MODEL_DEFAULT = {
  provider: "qodercn",
  model: "dfmodel",
  reasoningEffort: "high",
  // 2026-10-23 23:xx 更正（老大挖出来的，之前我判错了）：
  // ⚠️ **qodercn 目录里的 DeepSeek-Flash 就叫 `dfmodel`**，不是 `deepseek-v4.1-flash`。
  //    `deepseek-v4.1-flash` 是 **WorkBuddy 的模型 id**，qodercn 目录里根本没有它
  //    （见 dsh-providers-hub/lib/qoder-product.js:155 —
  //     `{ id: 'dfmodel', name: 'DeepSeek-Flash', supportsImage: true, ... }`）。
  //
  //    模型 id 不在目录里 ⇒ catalogModel() 返回 undefined ⇒ supportsImage/efforts 全空 ⇒
  //      ① 图片被判 text-only 丢掉（`[image omitted because this model accepts text only]`）
  //      ② 任何档位都报 UNSUPPORTED_REASONING_EFFORT
  //    **① 和 ② 是同一个原因**，不是两个独立 bug，也不需要动 ensureRemoteModels()。
  //
  //    实测 `dfmodel` + high → 正常出话；用它读图能准确说出画面内容（视觉链路本来就好的）。
  //
  // 教训：不要拿别的 provider 的模型 id 去猜本 provider 的 —— 先去目录里查实际 id。
  // 2026-10-23：原来的 fallback 是 workbuddy:hy3 / workbuddy:step-5-preview，
  // 而 WB 两个版本现在都返 400「账号存在异常行为」——留着等于每次失败都往死胡同里撞。
  fallbacks: [],
};

const CATALOG_FILES = {
  workbuddy: ".workbuddy-catalog.json",
  "workbuddy-ai": ".workbuddy-ai-catalog.json",
  // 2026-10-23：WB 两个版本都被上游封了（400 账号存在异常行为），
  // qqbot 改走 Jet Hub 的 qodercn。给个占位文件名即可 ——
  // 该文件不存在时 readCatalog 返回 null，倍率/免费判定自动降级，不会崩。
  // 作用只是让 knownSelections() 认得 qodercn，否则 #模型 会直接拒绝。
  qodercn: ".qodercn-catalog.json",
};

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

function selKey(sel) {
  return `${sel.provider}:${sel.model}`;
}

function selLabel(sel) {
  return `${sel.provider}/${sel.model}`;
}

function normalizeSel(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const i = value.indexOf(":");
    if (i <= 0) return null;
    const provider = value.slice(0, i).trim();
    const model = value.slice(i + 1).trim();
    return provider && model ? { provider, model } : null;
  }
  if (typeof value === "object" && typeof value.provider === "string" && typeof value.model === "string") {
    const provider = value.provider.trim();
    const model = value.model.trim();
    return provider && model ? { provider, model } : null;
  }
  return null;
}

let cfgCache = { mtimeMs: -1, value: null };

const EFFORT_VALUES = ["low", "medium", "high", "xhigh", "max"];

/** 归一化推理档位；不认识的值一律当没设（让上游用默认），不猜。 */
function normalizeEffort(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return EFFORT_VALUES.includes(v) ? v : null;
}

/** 某个模型支持哪些档位（读 catalog 的 reasoning.supportedEfforts） */
function effortsOf(provider, model) {
  const models = readCatalog(provider);
  const hit = models?.find((m) => m.id === model);
  const declared = hit?.reasoning?.supportedEfforts;
  return Array.isArray(declared) && declared.length ? declared : null;
}

/** 读 model.json；不存在就落一份默认值，方便老大直接改。按 mtime 缓存。 */
function loadModelConfig() {
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(MODEL_CFG_PATH).mtimeMs;
  } catch {}

  if (cfgCache.value !== null && cfgCache.mtimeMs === mtimeMs) return cfgCache.value;

  let raw = null;
  if (mtimeMs === 0) {
    try {
      writeFileSync(MODEL_CFG_PATH, `${JSON.stringify(MODEL_DEFAULT, null, 2)}\n`, "utf8");
      log(`[model] 没找到 model.json，已生成默认：${MODEL_CFG_PATH}`);
    } catch (e) {
      logErr(`[model] 生成默认 model.json 失败：${e.message}`);
    }
    raw = MODEL_DEFAULT;
  } else {
    try {
      raw = JSON.parse(readFileSync(MODEL_CFG_PATH, "utf8"));
    } catch (e) {
      logErr(`[model] model.json 解析失败，先按默认值跑：${e.message}`);
      raw = MODEL_DEFAULT;
    }
  }

  const primary = normalizeSel(raw?.primary ?? raw) ?? normalizeSel(MODEL_DEFAULT);
  const effort = normalizeEffort(raw?.reasoningEffort ?? MODEL_DEFAULT.reasoningEffort);
  const fallbacks = [];
  for (const item of Array.isArray(raw?.fallbacks) ? raw.fallbacks : []) {
    const sel = normalizeSel(item);
    if (sel && selKey(sel) !== selKey(primary) && !fallbacks.some((f) => selKey(f) === selKey(sel))) {
      fallbacks.push(sel);
    }
  }
  if (fallbacks.length === 0) {
    // 2026-10-23：只有「fallbacks 字段根本没有」时才补默认值。
    // 显式写了 [] 就是「我不要 fallback」，必须尊重 ——
    // 否则用户清空列表后又被偷偷塞回 workbuddy（现在是坏通道），
    // 表现为日志里莫名出现 workbuddy/hy3 降级链，排查时极易误判。
    const hasExplicit = Array.isArray(raw?.fallbacks);
    if (!hasExplicit) {
      for (const item of MODEL_DEFAULT.fallbacks) {
        const sel = normalizeSel(item);
        if (sel && selKey(sel) !== selKey(primary)) fallbacks.push(sel);
      }
    }
  }

  const value = { primary, effort, fallbacks, all: [primary, ...fallbacks] };
  cfgCache = { mtimeMs, value };
  return value;
}

/** 原子写 model.json（先写 .tmp 再改名），并让下一次读取强制重新加载。 */
function saveModelConfig(primary, effort, fallbacks) {
  const next = {
    provider: primary.provider,
    model: primary.model,
    reasoningEffort: effort,
    fallbacks: fallbacks.map(selKey),
  };
  const tmp = `${MODEL_CFG_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  renameSync(tmp, MODEL_CFG_PATH);
  cfgCache = { mtimeMs: -1, value: null };
  return next;
}

/**
 * 写本次调用的 --patch 叠加层。
 *
 * ⚠️ patch 的 config 是**整体替换**，不是深合并：
 *   profile 里那行 reasoningEffort 不会自动带过来，必须在这里显式写。
 *   漏写的后果是模型按上游默认档跑（deepseek-v4.1-flash 默认 high），
 *   比我们想要的 low 贵好几倍，而且没有任何报错 —— 典型的静默变贵。
 *
 * 注意：不能先写 .tmp 再 rename。dsh 会把 --patch 文件解析成 include，
 * 解析器按 baseUrl 相对路径记文件名；名字变了会多出一份缓存。
 * 单次 writeFileSync 对几十字节的内容是原子的，直接覆盖即可。
 */
function writeOverlay(sel, effort) {
  mkdirSync(RUN_DIR, { recursive: true });
  const text = [
    "# 由 bridge.mjs 在每次调用前自动重写，别手改。",
    "# 要换模型：改 model.json，或在 QQ 里发 #模型",
    "- id: agent-default-model",
    "  config:",
    `    provider: ${JSON.stringify(sel.provider)}`,
    `    model: ${JSON.stringify(sel.model)}`,
    ...(effort ? [`    reasoningEffort: ${JSON.stringify(effort)}`] : []),
    // 2026-10-19：禁掉 AGENTS.md 加载器。
    // ~/.dsh/AGENTS.md 有 13481 字节的「编码助手」规范，对 QQ 聊天毫无用处，
    // 但每轮都要跟着 prompt 发一遍（≈6500 token）。聊天人设由 bridge 自己拼，
    // 不需要它。实测：延迟 6322ms → 5495ms，回复正常。
    // 注意：只禁这一项是安全的；再往下禁 skill 那组会让 WB 的模型目录加载不出来
    // （表现为 UNKNOWN_MODEL: provider "workbuddy" has no configured model），已踩过。
    "- id: agent-instructions",
    "  disabled: true",
    "",
  ].join("\n");
  writeFileSync(OVERLAY_PATH, text, "utf8");
  return OVERLAY_PATH;
}

// ── 渠道 / 积分倍率（读 WB 的模型目录缓存，只读，不联网）────────────────
let catalogCache = new Map();

function readCatalog(provider) {
  const file = CATALOG_FILES[provider];
  if (!file) return null;
  const p = join(dshHome(), file);
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(p).mtimeMs;
  } catch {
    return null;
  }
  const hit = catalogCache.get(provider);
  if (hit && hit.mtimeMs === mtimeMs) return hit.models;
  try {
    const json = JSON.parse(readFileSync(p, "utf8"));
    const entry = Object.values(json.entries ?? {})[0];
    const models = Array.isArray(entry?.models) ? entry.models : [];
    catalogCache.set(provider, { mtimeMs, models });
    return models;
  } catch {
    return null;
  }
}

/** "x0.11 credits" → 0.11；没数据 → null */
function rateOf(provider, model) {
  const models = readCatalog(provider);
  const hit = models?.find((m) => m.id === model);
  const raw = hit?.billing?.credits;
  if (typeof raw !== "string") return null;
  const m = raw.match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

function rateLabel(provider, model) {
  const rate = rateOf(provider, model);
  if (rate === null) return "倍率未知";
  return rate === 0 ? "x0.00 免费" : `x${rate.toFixed(2)}`;
}

/** 免费时段是否还在（catalog 里 promotions 带起止时间；没有就按「未知」处理） */
function freeWindow(provider, model) {
  const models = readCatalog(provider);
  const hit = models?.find((m) => m.id === model);
  const promo = Array.isArray(hit?.promotions) ? hit.promotions.find((p) => p?.factor === 0) : undefined;
  if (!promo || typeof promo.end !== "number") return null;
  return { end: promo.end, label: typeof promo.label === "string" ? promo.label : "免费" };
}

/** 「免费到 10-31 23:59」；没免费期就返回空串 */
function freeUntilLabel(provider, model) {
  const w = freeWindow(provider, model);
  if (!w) return "";
  const end = new Date(w.end);
  const pad = (n) => String(n).padStart(2, "0");
  return `${w.label} 至 ${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())} ${pad(end.getHours())}:${pad(end.getMinutes())}`;
}

function freeCandidates(limit = 6) {
  const out = [];
  for (const provider of Object.keys(CATALOG_FILES)) {
    for (const model of readCatalog(provider) ?? []) {
      if (rateOf(provider, model.id) === 0) out.push(`${provider}/${model.id}`);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function expensiveCandidates(limit = 5) {
  const out = [];
  for (const provider of Object.keys(CATALOG_FILES)) {
    for (const model of readCatalog(provider) ?? []) {
      const rate = rateOf(provider, model.id);
      if (rate !== null && rate >= 0.5) out.push(`${provider}/${model.id} x${rate.toFixed(2)}`);
    }
  }
  return out.sort((a, b) => Number(b.split("x")[1]) - Number(a.split("x")[1])).slice(0, limit);
}

/**
 * settings.yaml 的 agent-default-model 段优先级比 --patch 高。
 * 一旦存在，model.json 就会被静默盖掉 —— 启动时查一次并告警。
 */
function settingsOverridePath() {
  const p = join(dshHome(), "settings.yaml");
  if (!existsSync(p)) return null;
  try {
    return /^agent-default-model:\s*$/m.test(readFileSync(p, "utf8")) ? p : null;
  } catch {
    return null;
  }
}

// ── 读取凭据（仅 deepseek 后端需要）────────────────────────────────────
function loadApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  const p = join(homedir(), ".dsh", ".credentials.yaml");
  if (!existsSync(p)) return null;
  try {
    const txt = readFileSync(p, "utf8");
    const m = txt.match(/^\s*DEEPSEEK_API_KEY\s*:\s*(\S+)\s*$/m);
    return m ? m[1].replace(/^["']|["']$/g, "") : null;
  } catch {
    return null;
  }
}

const API_KEY = CFG.backend === "deepseek" ? loadApiKey() : null;
if (CFG.backend === "deepseek" && !API_KEY) {
  logErr("[fatal] backend=deepseek 但找不到 DEEPSEEK_API_KEY");
  process.exit(1);
}

// ── 会话状态 ────────────────────────────────────────────────────────────
/** @type {Map<number, {role:string, content:string}[]>} */
const histories = new Map();
const nextAllowedAt = new Map();
let queueTail = Promise.resolve();
// 正在跑的任务数。连发合并要靠它判断「现在拆批会不会又排到队尾」。
let queueBusy = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function enqueue(fn) {
  queueBusy++;
  const run = queueTail.then(fn, fn).finally(() => {
    queueBusy--;
  });
  queueTail = run.catch(() => {});
  return run;
}

/**
 * 记一轮对话进历史（带时间戳）。
 *
 * 2026-10-22 15:5x 加 ts。起因：老大贴了 10:24~10:47 那段日志，说她
 * 「无法承接上下文」。实测 `--dump-prompt` 显示 24 条历史一条不少
 * ——**不是被截断，是渲染方式让她看不出哪句回的是哪句**：
 *   老大：你现在还是缺少一些活人味
 *   老大：我一定一定要给你弄好      ← 这其实是两句、两个不同回合
 *   我：嫌我假呗                    ← 回的是第一句
 *   我：弄啥呢这么郑重              ← 回的是第二句，且没接上「弄好」指什么
 * 平铺成四行同角色消息后，「谁回谁」这层信息彻底丢了，10:24 和 10:46
 * 之间空了 22 分钟也看不出来。ts 就是给 buildHistoryBlock 判断「同一阵 / 隔了很久」用的。
 *
 * @param userTs 老大那条消息**到达**的时刻（不是回复时刻），间隔要按到达算
 */
function rememberTurn(userId, hist, userText, replyText, userTs = Date.now()) {
  const replyTs = Date.now();
  hist.push({ role: "user", content: userText, ts: userTs });
  hist.push({ role: "assistant", content: replyText, ts: replyTs });
  histories.set(userId, hist.slice(-CFG.historyTurns * 2));
}

// ── 历史渲染（2026-10-22）────────────────────────────────────────────────
// 把「平铺消息行」改成「回合」：同一阵里连发、且只被回复一次的那几条
// 合并成一行（用 ／ 分隔），让人一眼看出「他是连着打的」而不是「两轮对话」。
// 间隔超过阈值就插一条时间标注，避免把 22 分钟前的半句话当成刚说的。
const TURN_GAP_MS = Number(process.env.TURN_GAP_MS ?? 5 * 60 * 1000);

function fmtGap(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
}

/**
 * @returns {string[]} 每个元素是 prompt 里的一行（不含缩进）
 */
function buildHistoryBlock(hist, opts = {}) {
  const gapMs = opts.gapMs ?? TURN_GAP_MS;
  const lines = [];
  let pendingUser = [];
  let prevTs = null;

  const flush = () => {
    if (!pendingUser.length) return;
    // 连发的几条合并：／ 是「连着打的两句」，不是「两轮问答」
    lines.push(`老大：${pendingUser.map((x) => x.content).join(" ／ ")}`);
    pendingUser = [];
  };

  for (const h of hist) {
    const ts = typeof h.ts === "number" ? h.ts : null;
    if (h.role === "user") {
      // 间隔标注只加在「老大开口」之前：她的回复紧跟其后，不需要再标一次
      if (prevTs != null && ts != null && ts - prevTs >= gapMs) {
        lines.push(`（隔了 ${fmtGap(ts - prevTs)}，下面这句不是紧接着上面说的）`);
      }
      pendingUser.push(h);
    } else {
      flush();
      lines.push(`我：${h.content}`);
    }
    if (ts != null) prevTs = ts;
  }
  flush();
  return lines;
}

// ── 记忆文件 ────────────────────────────────────────────────────────────
function readMemory() {
  try {
    if (!existsSync(CFG.memoryPath)) return "";
    return readFileSync(CFG.memoryPath, "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * 往 memory.md 的「## 我记得的事」这一节里追加一条（2026-10-22 17:2x 重写）。
 *
 * 为什么重写：旧版直接 `appendFileSync` 往文件**末尾**追加。
 * memory.md 现在是有结构的（我是谁 / 关于老大 / 我记得的事…），
 * 末尾追加会掉到「我记得的事」后面变成游离文本，下次读的时候读不出归属。
 * 现在按节插入，并做三件事：
 *   ① 只插到「## 我记得的事」节内，插在已有条目之后
 *   ② 去重：同一句话不重复记
 *   ③ 限长：这一节最多 MAX_MEMORY_ITEMS 条，超了丢最旧的（防止无限膨胀拖慢响应）
 *
 * @returns {{ok:boolean, reason?:string}}
 */
const MEMORY_SECTION = "## 我记得的事";
const MAX_MEMORY_ITEMS = 40;

// ── 纪念日（2026-10-26 P2）─────────────────────────────────────────────────
//
// 为什么单独一节、而不是混在「我记得的事」里：
//   现在唯一记着的日期是 `- 2026-10-26 - 10月26日是老大的生日，他自己说漏嘴我才知道`。
//   这种日期类事实**不能靠检索补** —— 得先想到去检索，而生日恰恰是「到了那天要主动说」。
//   所以把它做成结构化条目：`- MM-DD 名称 [年 YYYY]`，每轮/每天直接比对今天的日期。
//
// 为什么放 memory.md 而不是新文件：
//   老大手改 memory.md 是既有习惯（文件头写明了「老大也能直接改」）。多一个文件就多一处会忘。
//
// 格式（宽松解析，写歪了也认）：
//   - 10-26 老大的生日
//   - 10-26 老大的生日 年 2026          ← 带年份的，只在那一年的那天才提示
//   - 06-01 我的生日（上次算的）
const ANNIV_SECTION = "## 纪念日";
const ANNIV_RE = /^\s*-\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*(?:日)?\s*(.*)$/;

/** 解析一行纪念日条目；不是纪念日返回 null */
function parseAnniversaryLine(line) {
  const m = String(line ?? "").match(ANNIV_RE);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;
  let rest = (m[3] ?? "").trim();
  let year = null;
  const ym = rest.match(/(?:年|\(|（)\s*(\d{4})\s*(?:\)|）)?\s*$/);
  if (ym) {
    year = Number(ym[1]);
    rest = rest.slice(0, ym.index).trim();
  }
  if (!rest) return null; // 只有日期没名字 = 不知道是什么日子，不认
  return { month, day, year, name: rest };
}

/** 从 memory.md 全文抽纪念日列表（解析失败的行跳过，不阻塞） */
function readAnniversaries(raw = null) {
  const text = raw ?? readFileSyncSafe(CFG.memoryPath);
  if (!text) return [];
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^##\s*纪念日/.test(l.trim()));
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const bare = lines[i].replace(/\r$/, "");
    if (/^##\s/.test(bare.trim())) break; // 到下一节为止
    const a = parseAnniversaryLine(bare);
    if (a) out.push(a);
  }
  return out;
}

/**
 * 今天是不是某个纪念日。
 * @param day 默认今天；测试时传固定日期
 * @returns 命中的纪念日数组（可能多个同一天）
 */
function anniversariesOn(day = new Date(), list = null) {
  const items = list ?? readAnniversaries();
  const m = day.getMonth() + 1;
  const d = day.getDate();
  const y = day.getFullYear();
  return items.filter((a) => a.month === m && a.day === d && (a.year == null || a.year === y));
}

function appendMemory(line) {
  const item = String(line ?? "").trim();
  if (!item) return { ok: false, reason: "空内容" };

  let raw;
  try {
    raw = existsSync(CFG.memoryPath) ? readFileSync(CFG.memoryPath, "utf8") : "";
  } catch (e) {
    logErr(`[mem] 读取失败，放弃追加: ${e.message}`);
    return { ok: false, reason: "读取失败" };
  }
  if (!raw) return { ok: false, reason: "memory.md 不存在" };

  // 去重：把 `- 2026-10-22 - xxx` 里的日期剥掉再比，避免同一天记两遍同样的话
  const stripDate = (s) => s.replace(/^-\s*\d{4}-\d{2}-\d{2}\s*-\s*/, "").trim();
  const existing = raw.split("\n").filter((l) => /^\s*-\s*\d{4}-\d{2}-\d{2}/.test(l));
  if (existing.some((l) => stripDate(l) === stripDate(item))) {
    return { ok: false, reason: "已记过" };
  }

  const idx = raw.indexOf(MEMORY_SECTION);
  if (idx < 0) {
    // 没有那一节 → 老实追加到末尾，别把内容丢了
    try {
      appendFileSync(CFG.memoryPath, `\n${item}\n`, "utf8");
      return { ok: true };
    } catch (e) {
      logErr(`[mem] 写入失败: ${e.message}`);
      return { ok: false, reason: "写入失败" };
    }
  }

  const head = raw.slice(0, idx + MEMORY_SECTION.length);
  const rest = raw.slice(idx + MEMORY_SECTION.length);
  const restLines = rest.split("\n");

  // 找这一节的条目区间：从节标题后第一行起，到最后一条 `- 日期` 为止
  // （中间可能有注释、空行，都保留）
  let lastItemIdx = -1;
  for (let i = 0; i < restLines.length; i++) {
    if (/^\s*-\s*\d{4}-\d{2}-\d{2}/.test(restLines[i])) lastItemIdx = i;
  }

  if (lastItemIdx < 0) {
    // 这一节还是空的：插在标题后面（跳过紧随其后的注释行和空行）
    let insertAt = 0;
    while (insertAt < restLines.length && /^\s*(<!--|$)/.test(restLines[insertAt])) insertAt++;
    restLines.splice(insertAt, 0, item);
  } else {
    restLines.splice(lastItemIdx + 1, 0, item);
  }

  // 限长：条目超过上限就删最旧的（保留最新的 MAX_MEMORY_ITEMS 条）
  const itemIdxs = [];
  for (let i = 0; i < restLines.length; i++) {
    if (/^\s*-\s*\d{4}-\d{2}-\d{2}/.test(restLines[i])) itemIdxs.push(i);
  }
  if (itemIdxs.length > MAX_MEMORY_ITEMS) {
    const drop = itemIdxs.length - MAX_MEMORY_ITEMS;
    // 从后往前删，避免索引错位
    for (let k = drop - 1; k >= 0; k--) restLines.splice(itemIdxs[k], 1);
    log(`[mem] 条目超过 ${MAX_MEMORY_ITEMS} 条，丢掉最旧的 ${drop} 条`);
  }

  const out = head + restLines.join("\n");
  try {
    // 原子写：先写临时文件再改名，避免写一半进程挂了把记忆文件弄坏
    const tmp = `${CFG.memoryPath}.tmp-${process.pid}`;
    writeFileSync(tmp, out, "utf8");
    renameSync(tmp, CFG.memoryPath);
    return { ok: true };
  } catch (e) {
    logErr(`[mem] 写入失败: ${e.message}`);
    return { ok: false, reason: "写入失败" };
  }
}

// ── OneBot 客户端 ───────────────────────────────────────────────────────
let ws = null;
let selfId = null;
let echoSeq = 0;
const pending = new Map();

function connect() {
  const url = CFG.wsToken
    ? `${CFG.wsUrl}?access_token=${encodeURIComponent(CFG.wsToken)}`
    : CFG.wsUrl;

  log(`[ws] 连接 ${CFG.wsUrl} ...`);
  ws = new WebSocket(url);

  ws.on("open", () => log("[ws] 已连接"));

  ws.on("message", (buf) => {
    let evt;
    try {
      evt = JSON.parse(buf.toString());
    } catch {
      return;
    }
    if (evt.echo !== undefined) {
      const p = pending.get(evt.echo);
      if (p) {
        pending.delete(evt.echo);
        evt.status === "ok" ? p.resolve(evt.data) : p.reject(new Error(evt.message ?? evt.wording));
      }
      return;
    }
    handleEvent(evt).catch((e) =>
      logErr(`[evt] 处理异常: ${String(e?.stack || e).slice(0, 400)}`)
    );
  });

  ws.on("close", () => {
    log("[ws] 断开，5 秒后重连");
    setTimeout(connect, 5000);
  });

  ws.on("error", (e) => logErr("[ws] 错误:", e.message));
}

function callApi(action, params = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("WebSocket 未连接"));
  }
  const echo = `e${++echoSeq}`;
  return new Promise((resolve, reject) => {
    pending.set(echo, { resolve, reject });
    ws.send(JSON.stringify({ action, params, echo }));
    setTimeout(() => {
      if (pending.has(echo)) {
        pending.delete(echo);
        reject(new Error(`API 超时: ${action}`));
      }
    }, 15000);
  });
}

async function sendPrivate(userId, text) {
  try {
    await callApi("send_private_msg", { user_id: userId, message: text });
    log(`[send] ${userId}: ${String(text).slice(0, 60)}`);
    return true;
  } catch (e) {
    logErr(`[send] 失败: ${e.message}`);
    return false;
  }
}

// ── 发送目标抽象（2026-10-26）────────────────────────────────────────────
// 私聊沿用数字 userId（旧逻辑零改动）；群聊用 {kind:"group", groupId}。
// lastBotMsgId 记每个群机器人最后一条消息：群友「回复她那条」也算在叫她。
const lastBotMsgId = new Map();

function normalizeTarget(t) {
  return typeof t === "number" || typeof t === "string"
    ? { kind: "private", userId: Number(t) || t }
    : t;
}

function targetKey(t) {
  return t.kind === "group" ? `group:${t.groupId}` : t.userId;
}

async function sendTo(target, text, opts = {}) {
  const t = normalizeTarget(target);
  if (t.kind !== "group") return sendPrivate(t.userId, text);

  const message = [];
  if (CFG.groupReplyQuote && opts.quoteId && !opts.noQuote) {
    message.push({ type: "reply", data: { id: String(opts.quoteId) } });
  }
  message.push({ type: "text", data: { text: String(text) } });
  try {
    const r = await callApi("send_group_msg", {
      group_id: Number(t.groupId) || t.groupId,
      message,
    });
    if (r?.message_id) lastBotMsgId.set(String(t.groupId), r.message_id);
    log(`[send] 群 ${t.groupId}: ${String(text).slice(0, 60)}`);
    return true;
  } catch (e) {
    logErr(`[send] 群发送失败: ${e.message}`);
    return false;
  }
}

async function sendImageTo(target, imagePath, opts = {}) {
  const t = normalizeTarget(target);
  if (t.kind !== "group") return sendPrivateImage(t.userId, imagePath);

  const fileUrl = `file:///${imagePath.replace(/\\/g, "/")}`;
  const message = [];
  if (CFG.groupReplyQuote && opts.quoteId && !opts.noQuote) {
    message.push({ type: "reply", data: { id: String(opts.quoteId) } });
  }
  message.push({ type: "image", data: { file: fileUrl } });
  try {
    const r = await callApi("send_group_msg", {
      group_id: Number(t.groupId) || t.groupId,
      message,
    });
    if (r?.message_id) lastBotMsgId.set(String(t.groupId), r.message_id);
    log(`[img] 群 ${t.groupId}: ${basename(imagePath)}`);
    return true;
  } catch (e) {
    logErr(`[img] 群发送失败: ${e.message}`);
    return false;
  }
}

/**
 * 发一条语音。message 用 record 段，file 走 file:/// 本地路径。
 *
 * 2026-10-18 实测：直接发 MP3 就行，NapCat 内置的 convertToNTSilkTct
 * 会自动转成 QQ 的 SILK 格式。不用我们自己转，更不用装 ffmpeg。
 * 验证方式：send_private_msg + record 段，返回 message_id = 601954943，QQ 收到正常语音。
 */
async function sendPrivateAudio(userId, audioPath) {
  try {
    const fileUrl = `file:///${audioPath.replace(/\\/g, "/")}`;
    await callApi("send_private_msg", {
      user_id: userId,
      message: [{ type: "record", data: { file: fileUrl } }],
    });
    log(`[voice] ${userId}: 语音 ${basename(audioPath)}`);
    return true;
  } catch (e) {
    logErr(`[voice] 发送失败: ${e.message}`);
    return false;
  }
}

// ── 表情包库（2026-10-19 新增：让她学会自己发表情）───────────────────────
// 素材放 stickers/，标签由 tag-stickers.mjs 让视觉模型看图生成（文件名不可靠）。
// 模型在回复里写 [[sticker:关键词]]，bridge 换成真图发过去，标记本身剥掉。

const STICKER_DIR = join(__dirname, "stickers");
const STICKER_INDEX = join(STICKER_DIR, "index.json");
let stickerCache = { at: -1, items: [] };

/** 读索引（按 mtime 缓存；往目录里加了图、重跑 tag-stickers 就自动生效） */
function loadStickers() {
  try {
    const st = statSync(STICKER_INDEX);
    if (stickerCache.at === st.mtimeMs) return stickerCache.items;
    const raw = JSON.parse(readFileSync(STICKER_INDEX, "utf8"));
    const items = Object.entries(raw)
      .map(([file, meta]) => ({
        file: join(STICKER_DIR, file),
        name: String(meta?.name ?? file),
        keywords: Array.isArray(meta?.keywords) ? meta.keywords.map(String) : [],
        vibe: String(meta?.vibe ?? ""),
      }))
      .filter((x) => existsSync(x.file))
      // 入库但还没打标的条目没有关键词，选不中任何情绪，别让它占着清单名额
      .filter((x) => x.keywords.length > 0);
    stickerCache = { at: st.mtimeMs, items };
    return items;
  } catch {
    return [];
  }
}

/**
 * 按关键词找一张表情包。
 * 顺序：关键词精确 → 名字/关键词互相包含 → vibe 里出现。
 * 找不到返回 null——宁可不发，也不要发错情绪。
 */
function matchSticker(query) {
  const items = loadStickers();
  if (!items.length) return null;
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return null;

  let hit = items.find((x) => x.keywords.some((k) => k.toLowerCase() === q));
  if (hit) return hit;
  hit = items.find(
    (x) =>
      x.name.toLowerCase().includes(q) ||
      q.includes(x.name.toLowerCase()) ||
      x.keywords.some((k) => k.toLowerCase().includes(q) || q.includes(k.toLowerCase()))
  );
  if (hit) return hit;
  hit = items.find((x) => x.vibe.toLowerCase().includes(q));
  return hit ?? null;
}

const STICKER_RE = /\[\[\s*sticker\s*[:：]\s*([^\]\n]{1,24})\s*\]\]/gi;

/**
 * 兜底：从「文字描述的表情」里猜出关键词（2026-10-23）。
 *
 * 为什么要它：换成 qodercn/deepseek-v4.1-flash 后，模型经常把表情写成
 * `（配个奋斗/加油的表情）`、`发个委屈的表情` 这种自然语言，而不是
 * `[[sticker:关键词]]` 标记 —— bridge 只认标记，于是**一张图也发不出去**（实测 12:41 后零 [sticker]）。
 * prompt 已经强化成硬约束，这里是第二道防线：宁可多认一次，也别让她失去发表情的能力。
 *
 * ⚠️ 必须排除「描述句」：像「你刚才发的那个表情真欠揍」「你发的表情我收到了」
 * 是在**说已经发生的事**，不是要发表情。判据：
 *   ① 动词后面不能紧跟「的」（`发的` → 描述）
 *   ② 关键词不能是「那个/这个/一个」这类指代词
 *   ③ 前面不能是「你/他/她」（`你发个委屈表情` 才算请求）
 */
const STICKER_TEXT_INTENT =
  /(?:我)?(?:配|发|来|贴|甩|扔|补)(?:一)?(?:个|张|只)(?!的)([^，。！？\n（）()的]{1,10}?)(?:的)?(?:表情包?|图|梗图)/g;

/**
 * 从回复里抽出表情请求，返回请求词与剥掉标记的干净正文。
 *
 * 2026-10-23 加兜底：模型没写标记、而是写成自然语言时，从文字里猜关键词。
 * 只有「标记一个都没有」时才启兜底 —— 有标记就以标记为准，避免双重解析打架。
 */
function extractStickerRequest(reply, opts = {}) {
  const raw = String(reply ?? "");
  const queries = [...raw.matchAll(STICKER_RE)].map((m) => m[1].trim()).filter(Boolean);

  let cleaned = raw
    .replace(STICKER_RE, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // 兜底：没标记时，看正文里有没有「配个XX表情」这种明确意图。
  // 命中就取那个词当请求；**正文不动**（那半句是她说的话，剥掉会显得突兀）。
  if (!queries.length && opts.textFallback !== false) {
    const hits = [...String(raw).matchAll(STICKER_TEXT_INTENT)]
      .map((m) => (m[1] ?? "").trim())
      .filter(Boolean)
      // 「一个」「这个」「那个」这种指代词没有检索价值，丢掉
      .filter((w) => !/^(一个|这个|那个|一下|张|个)$/.test(w));
    if (hits.length) queries.push(hits[0]);
  }

  return { queries, query: queries[0] ?? null, cleaned };
}

/**
 * 把一条回复拆成要分开发的几条（2026-10-22 17:0x）。
 *
 * 背景：老大要「很活泼地回复两三句」。一次生成一大段在 QQ 里是一整坨，
 * 看着不像人；人是一句一条发出来的。所以让模型用 [[分]] 标记分条，
 * bridge 依次发——QQ 里就是连着蹦出来几条。
 *
 * 为什么用显式标记而不是换行：换行在 prompt 里还承担「分段」的语义
 * （图注、多句回应都会用），拿换行当分隔符会把正常换行也切碎。
 *
 * 兼容模型不听话的情况：
 *   · 一个标记都没有 → 原样返回单条，零行为变化
 *   · 标记写坏了（[[ 分 ]]、[[拆分]]、全角括号）→ 一并认
 *   · 切出空片段 → 丢掉（避免发空消息）
 *   · 超过 multiMaxSegments → 多的并进最后一条，**不丢内容**
 */
function splitReplySegments(reply, opts = {}) {
  const max = opts.max ?? CFG.multiMaxSegments;
  const raw = String(reply ?? "");
  if (!raw.trim()) return [];

  // [[分]] 为主，顺手认几种模型可能写歪的形式：
  // 左括号 + 分 + 右括号，括号可以是半角/全角，可以单层也可以双层。
  // 写成「一个或多个左括号 … 一个或多个右括号」才能同时吃掉 [[分]]、【分】、［分］。
  const SPLIT_SRC = "[\\[［【]+\\s*分\\s*[\\]］】]+";
  // 先用非全局版本判断有没有，避免 /g 的 lastIndex 副作用
  if (!new RegExp(SPLIT_SRC).test(raw)) return [raw.trim()];
  const SPLIT_RE = new RegExp(SPLIT_SRC, "g");

  const parts = raw
    .split(SPLIT_RE)
    .map((s) => s.trim())
    .filter(Boolean);

  if (!parts.length) return [raw.trim()];
  if (parts.length <= max) return parts;

  // 超限：前面 max-1 条照发，剩下的全并进最后一条
  const head = parts.slice(0, max - 1);
  const tail = parts.slice(max - 1).join("\n");
  return [...head, tail];
}

/**
 * 解析并剥掉「记住这件事」标记 [[记:一句话]]（2026-10-22 17:2x）。
 *
 * 和 [[sticker:]] 一样：标记必须从正文里剥掉，否则老大看到的是代码。
 * 返回 { notes: string[], cleaned }。
 */
const MEMO_RE = /\[\[\s*记\s*[:：]\s*([^\]]{1,200})\]\]/g;

function extractMemoRequest(reply) {
  const raw = String(reply ?? "");
  const notes = [...raw.matchAll(MEMO_RE)].map((m) => m[1].trim()).filter(Boolean);
  const cleaned = raw
    .replace(MEMO_RE, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { notes, cleaned };
}

/**
 * 把一条记忆写进 memory.md，带上今天日期。
 *
 * 2026-10-26 修（有生产证据）：服务器 memory.md 里 6 条记忆有 3 条长成
 *   `- 2026-10-24 - 2026-10-24 - 老大答应以后不再说「总是」…`
 * 模型在 [[记:…]] 里**自己先写了日期**，这里又补一次，于是日期重复两遍。
 * 后果不只是难看：appendMemory 的去重是「剥掉日期后比较」，两遍日期剥一次还剩一遍，
 * 同一条内容换个日子再记一次就能绕过去重、写进第二行 —— 而「一天最多一条」是 memory.md
 * 自己写明的规矩。所以写之前先把模型自带的那层日期/连字符剥掉，只由这里统一加。
 */
const LEADING_DATE_RE = /^-{0,1}\s*\d{4}-\d{2}-\d{2}\s*[-—－:：]\s*/;

function normalizeMemoText(note) {
  let s = String(note ?? "").trim();
  // 反复剥：兼容 `- 日期 - 日期 - 内容` 这种已经写坏的输入（把旧条目重新喂进来时）
  for (let i = 0; i < 3; i++) {
    const t = s.replace(LEADING_DATE_RE, "").trim();
    if (t === s) break;
    s = t;
  }
  return s.replace(/^[-—－]\s*/, "").trim();
}

/** 把一条记忆写进 memory.md，带上今天日期 */
function rememberNote(note) {
  const day = dayKey(new Date());
  const body = normalizeMemoText(note);
  if (!body) return { ok: false, reason: "空内容" };
  const line = `- ${day} - ${body}`;
  const r = appendMemory(line);
  if (r.ok) log(`[mem] 记下了：${body.slice(0, 60)}`);
  else log(`[mem] 没记（${r.reason}）：${body.slice(0, 60)}`);
  return r;
}

/** 发一条图片消息（表情包走这个） */
async function sendPrivateImage(userId, imagePath) {
  try {
    const fileUrl = `file:///${imagePath.replace(/\\/g, "/")}`;
    await callApi("send_private_msg", {
      user_id: userId,
      message: [{ type: "image", data: { file: fileUrl } }],
    });
    log(`[sticker] ${userId}: 已发 ${basename(imagePath)}`);
    return true;
  } catch (e) {
    logErr(`[sticker] 发送失败: ${String(e.message).slice(0, 120)}`);
    return false;
  }
}

/** 给 prompt 用的「可用表情」清单 */
function stickerKeywordList() {
  const items = loadStickers();
  if (!items.length) return null;
  return items.map((x) => `${x.name}（${x.keywords.join("/")}）`).join("；");
}

// ── 表情包自动入库（2026-10-28）────────────────────────────────────────
// 为什么加：库是 2026-10-19 手工塞进去的 6 张，之后一张没进过——代码里根本没有
// 「收到的表情包入库」这条路径。老大发来的图只落在 .run/img，pruneImages() 只留
// 最新 imageKeep 张就删，所以她永远只会重复那几张老的。
// 现在在她收到「纯表情包」的那一刻复制一份进 stickers/，再交给 tag-stickers 打标。
const STICKER_LEARN = (process.env.STICKER_LEARN ?? "1") !== "0";
const STICKER_LEARN_MAX = Number(process.env.STICKER_LEARN_MAX ?? 80);
const STICKER_LEARN_MB = Number(process.env.STICKER_LEARN_MB ?? 4);
const STICKER_LEARN_PER_MSG = Number(process.env.STICKER_LEARN_PER_MSG ?? 6);
const STICKER_IMG_EXT = /^\.(jpg|jpeg|png|gif|webp)$/i;
let stickerHashes = null; // basename -> md5；入库/淘汰时置空重算

function readStickerIndex() {
  try {
    return JSON.parse(readFileSync(STICKER_INDEX, "utf8"));
  } catch {
    return {};
  }
}

function writeStickerIndex(obj) {
  try {
    mkdirSync(STICKER_DIR, { recursive: true });
    writeFileSync(STICKER_INDEX, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) {
    logErr(`[sticker-learn] 写索引失败: ${String(e.message).slice(0, 120)}`);
  }
}

/** 单张能不能入库（纯函数，便于自测） */
function shouldLearnSticker({ sizeBytes, maxMB }) {
  if (!(sizeBytes > 0)) return { ok: false, reason: "空文件" };
  if (sizeBytes > maxMB * 1024 * 1024) return { ok: false, reason: `超过 ${maxMB}MB` };
  return { ok: true };
}

/** 库满时淘汰谁（纯函数）：按 mtime 最旧的先走 */
function pickStickerEvictions(entries, maxFiles) {
  const sorted = [...entries].sort((a, b) => a.mtimeMs - b.mtimeMs);
  const drop = sorted.length - Math.max(0, maxFiles);
  return drop > 0 ? sorted.slice(0, drop) : [];
}

function loadStickerHashes() {
  if (stickerHashes) return stickerHashes;
  const m = new Map();
  try {
    for (const f of readdirSync(STICKER_DIR)) {
      if (!STICKER_IMG_EXT.test(extname(f))) continue;
      try {
        m.set(f, createHash("md5").update(readFileSync(join(STICKER_DIR, f))).digest("hex"));
      } catch {}
    }
  } catch {}
  stickerHashes = m;
  return m;
}

let stickerTagTimer = null;

/** 打标是重活（每张起一次 dsh），攒一会儿再跑，且同一时间只允许一个 */
function scheduleStickerTag(delayMs = 20000) {
  if (stickerTagTimer) return;
  stickerTagTimer = setTimeout(() => {
    stickerTagTimer = null;
    runStickerTag();
  }, delayMs);
  if (typeof stickerTagTimer.unref === "function") stickerTagTimer.unref();
}

function runStickerTag() {
  const script = join(__dirname, "tag-stickers.mjs");
  if (!existsSync(script)) return;
  const lock = join(__dirname, ".run", "sticker-tag.lock");
  try {
    if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs < 10 * 60 * 1000) {
      log("[sticker-learn] 上一轮打标还没跑完，1 分钟后再看");
      scheduleStickerTag(60000);
      return;
    }
  } catch {}
  try {
    mkdirSync(join(__dirname, ".run"), { recursive: true });
    writeFileSync(lock, String(Date.now()), "utf8");
    const child = spawn(process.execPath, [script], {
      cwd: __dirname,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env },
    });
    child.on("exit", () => {
      try {
        unlinkSync(lock);
      } catch {}
      stickerCache.at = -1;
      stickerHashes = null;
    });
    child.unref();
    log("[sticker-learn] 已排上后台打标");
  } catch (e) {
    try {
      unlinkSync(lock);
    } catch {}
    logErr(`[sticker-learn] 打标启动失败: ${String(e.message).slice(0, 120)}`);
  }
}

/**
 * 单张入库（可指定目标目录，便于自测）：校验 → md5 去重 → 复制。
 * 返回 { ok:true, path, name, hash } 或 { ok:false, reason }。
 */
function addStickerFile(srcPath, dir, known, maxMB) {
  if (!existsSync(srcPath)) return { ok: false, reason: "文件不存在" };
  if (!STICKER_IMG_EXT.test(extname(srcPath))) return { ok: false, reason: "不是图片" };
  const st = statSync(srcPath);
  const verdict = shouldLearnSticker({ sizeBytes: st.size, maxMB });
  if (!verdict.ok) return verdict;
  const h = createHash("md5").update(readFileSync(srcPath)).digest("hex");
  if (known.has(h)) return { ok: false, reason: "库里已有同款", dup: true };
  // 同一毫秒收到两张时 Date.now() 会撞，加随机后缀避免互相覆盖
  const name = `${Date.now()}_l${Math.random().toString(36).slice(2, 6)}${extname(srcPath).toLowerCase()}`;
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, name);
  copyFileSync(srcPath, dest);
  known.add(h);
  return { ok: true, path: dest, name, hash: h, size: st.size };
}

/**
 * 把老大发来的表情包存进库。返回真正入库的路径。
 * 去重按内容 md5：同一张图换名字发十次也只进一张。
 */
function learnStickers(paths, opts = {}) {
  if (!STICKER_LEARN || !Array.isArray(paths) || !paths.length) return [];
  const max = Number.isFinite(opts.max) ? opts.max : STICKER_LEARN_PER_MSG;
  const hashMap = loadStickerHashes();
  const known = new Set(hashMap.values());
  const added = [];
  for (const p of paths.slice(0, Math.max(0, max))) {
    try {
      const r = addStickerFile(p, STICKER_DIR, known, STICKER_LEARN_MB);
      if (!r.ok) {
        if (!r.dup) log(`[sticker-learn] 跳过 ${basename(p)}（${r.reason}）`);
        else log(`[sticker-learn] 库里已有同款，跳过 ${basename(p)}`);
        continue;
      }
      hashMap.set(r.name, r.hash);
      added.push(r.path);
      log(`[sticker-learn] 入库 ${r.name}（${Math.round(r.size / 1024)}KB）`);
    } catch (e) {
      logErr(`[sticker-learn] 入库失败 ${basename(p)}: ${String(e.message).slice(0, 120)}`);
    }
  }
  if (!added.length) return added;
  evictStickers();
  scheduleStickerTag();
  return added;
}

function evictStickers() {
  try {
    const files = readdirSync(STICKER_DIR)
      .filter((f) => STICKER_IMG_EXT.test(extname(f)))
      .map((f) => {
        let mtimeMs = 0;
        try {
          mtimeMs = statSync(join(STICKER_DIR, f)).mtimeMs;
        } catch {}
        return { file: f, mtimeMs };
      });
    const drop = pickStickerEvictions(files, STICKER_LEARN_MAX);
    if (!drop.length) return;
    const index = readStickerIndex();
    for (const d of drop) {
      try {
        unlinkSync(join(STICKER_DIR, d.file));
      } catch {}
      delete index[d.file];
      stickerHashes?.delete(d.file);
      log(`[sticker-learn] 库满，淘汰 ${d.file}`);
    }
    writeStickerIndex(index);
  } catch (e) {
    logErr(`[sticker-learn] 淘汰失败: ${String(e.message).slice(0, 120)}`);
  }
}

/**
 * 「今天说说发了没」的真实状态，写进 prompt 让她照实回答。
 *
 * 2026-10-20 00:14 老大问「你没有发说说」，她答「我发啦，刚吃太多在消食」——
 * 根本没发，是因为她看不到状态，随口编了个理由。
 * 这种「不知道自己做了什么就编」比功能缺失更伤。
 */
function qzoneStatusText() {
  if (!CFG.qzoneEnabled) return "自动发说说现在是关闭的，你今天不会发。";
  const st = loadSchedule();
  // 读不到状态（首次启动 / --dump-prompt 这种模块还没初始化完的场景）就整段省略，
  // 不要瞎写「今天还没安排」——那等于给她一个错误前提。
  if (!st || !st.qzone) return null;
  const q = st.qzone;
  const today = dayKey(new Date());
  if (q.day !== today) return "今天还没安排发说说。";
  if (Number(q.count) >= CFG.qzoneDailyTimes) return "今天已经发过说说了。";
  if (q.planAt) {
    const t = new Date(Number(q.planAt)).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    return `今天还没发，计划 ${t} 左右发。`;
  }
  return "今天还没发。";
}

// ── 消息去重（OneBot message_id 级）─────────────────────────────────────
/** message_id -> 过期时间戳(ms)。只留一个 TTL 窗口，避免无限增长。 */
const seenMsgIds = new Map();
const DEDUP_TTL_MS = 5 * 60 * 1000;

/**
 * 同一 message_id 在 TTL 内再次出现 → 判为重投，应忽略。
 *
 * 背景：2026-10-18 21:40 实测 NapCat 对同一条私聊事件投递了两次（两条同秒 [recv]），
 * 两条都进了 LLM：一条 hy3 成功、一条全链失败，白烧额度还白发一条吓人报错。
 * 老大手动重发是新 message_id，不受影响；字段缺失时返回 false（不拦）。
 */
function isDuplicate(messageId, now = Date.now()) {
  if (messageId === undefined || messageId === null || messageId === "") return false;
  for (const [id, exp] of seenMsgIds) {
    if (exp <= now) seenMsgIds.delete(id);
  }
  const key = String(messageId);
  if (seenMsgIds.has(key)) return true;
  seenMsgIds.set(key, now + DEDUP_TTL_MS);
  return false;
}

/** `${userId}|${text}` -> 过期时间戳(ms)，配 3 秒窗口。 */
const recentTexts = new Map();
const TEXT_DEDUP_WINDOW_MS = 3000;

/**
 * 二级去重：同人 + 同文本 + 窗口内 → 判重。
 *
 * 为什么需要第二级：2026-10-18 21:53-21:55 连中 4 次双投，特征是同秒成对
 * （连 #模型 指令都双发），且按 message_id 的一级去重拦不住——说明两次投递的
 * message_id 不同，是老大 QQ 客户端弱网重发，不是 NapCat 重推。
 * 客户端重发拦不掉（那是老大的网），但 bridge 可以不重复处理、不重复烧积分。
 *
 * 带图消息直接放行：图片消息提取出的文本都是 [图片]，按文本拦会误吞
 * 老大真发的第二张图——漏回的代价比双烧一次积分大。
 */
function isTextDuplicate(userId, text, hasImages, now = Date.now()) {
  if (hasImages || !text) return false;
  const key = `${userId}|${text}`;
  for (const [k, exp] of recentTexts) {
    if (exp <= now) recentTexts.delete(k);
  }
  if (recentTexts.has(key)) return true;
  recentTexts.set(key, now + TEXT_DEDUP_WINDOW_MS);
  return false;
}

// ── 连发合并（2026-10-22 15:5x；2026-10-27 静默窗口改 5 秒）──────────────
// 老大一句一发是常态（10-22 当天 chatlog 里 15 处同角色连发，10-21 有 31 处）。
// 一条消息一轮的后果：同一口气被拆成两次问答，她每次只看见半句，
// 于是「我一定一定要给你弄好」和「你现在还是缺少一些活人味」被当成两件事。
//
// 做法：每来一条就重置计时器，最后一条之后静默满 mergeBurstMs（5 秒）才放行；
// 攒到 mergeBurstMaxMs（20 秒）就不等了，直接放行，防止连发把人饿死。
// 合并后的文本用换行拼起来——**不合并成一句**，因为那是几句原话，
// 模型需要看见「他是分几条打的」这个事实（buildDshPrompt 里也会提示）。
const burstBuf = new Map(); // userId -> { items:[{text,images,stickerOnly}], timer, startedAt, firstAt }

/** 把这一阵攒下的消息摊成一轮（纯函数，便于自测）。 */
function mergeBurstItems(items) {
  return {
    text: items.map((x) => x.text).join("\n"),
    images: items.flatMap((x) => x.images),
    // 全是表情包才按表情包处理；混了文字就按正常聊天
    stickerOnly: items.every((x) => x.stickerOnly),
  };
}

/**
 * 还要等多久才放行（纯函数，便于自测）。
 * 返回 0 表示立刻放行：关掉了合并（idleMs≤0），或者这一阵已经攒到上限。
 */
function burstWaitMs(elapsedMs, idleMs, maxMs) {
  if (idleMs <= 0) return 0;
  if (elapsedMs >= maxMs) return 0;
  return Math.min(idleMs, maxMs - elapsedMs);
}

/**
 * 队列还忙着时先别拆批（纯函数，便于自测）。
 *
 * 2026-10-27 21:33 实证：老大连发三条「大肥鱼」，每条间隔 5~6 秒，
 * 每条都刚好卡在 5 秒合并窗之外 → 各自成批、各自入队。而每轮 dsh 卡满
 * 150 秒，第三条等了 296 秒才回，老大看到的是「三个问题分三次回答」。
 * 队列忙的时候继续攒，等这一轮答完再一起放行，三条就能并成一问。
 * 但攒满 maxMs 仍然放行，避免把几分钟前的话和刚说的混成一问。
 */
function shouldHoldBurst(queueBusy, elapsedMs, maxMs) {
  return queueBusy > 0 && elapsedMs < maxMs;
}

/** 队列忙时多久看一次它空没空 */
const MERGE_BUSY_POLL_MS = 500;

function flushBurst(userId) {
  const buf = burstBuf.get(userId);
  if (!buf) return;
  clearTimeout(buf.timer);

  if (shouldHoldBurst(queueBusy, Date.now() - buf.startedAt, CFG.mergeBurstMaxMs)) {
    buf.timer = setTimeout(() => flushBurst(userId), MERGE_BUSY_POLL_MS);
    return;
  }

  burstBuf.delete(userId);

  const items = buf.items;
  if (!items.length) return;

  // 只有一条 → 完全走原来的路径，零行为变化
  if (items.length === 1) {
    const only = items[0];
    enqueue(() =>
      replyTo(userId, only.text, only.images, {
        stickerOnly: only.stickerOnly,
        userTs: buf.firstAt,
      })
    );
    return;
  }

  const merged = mergeBurstItems(items);
  log(`[merge] ${userId} 合并 ${items.length} 条为 1 轮：${items.map((x) => x.text.slice(0, 16)).join(" ／ ")}`);
  enqueue(() =>
    replyTo(userId, merged.text, merged.images, { stickerOnly: merged.stickerOnly, userTs: buf.firstAt })
  );
}

/**
 * 收下一条消息，攒到静默窗口结束再一起答。
 * @param firstAt 这一阵里**第一条**消息到达的时刻，用来记历史时间戳
 */
function bufferMessage(userId, text, images, stickerOnly, firstAt) {
  let buf = burstBuf.get(userId);
  if (!buf) {
    buf = { items: [], timer: null, startedAt: Date.now(), firstAt: firstAt ?? Date.now() };
    burstBuf.set(userId, buf);
  }
  buf.items.push({ text, images, stickerOnly });

  clearTimeout(buf.timer);
  const wait = burstWaitMs(Date.now() - buf.startedAt, CFG.mergeBurstMs, CFG.mergeBurstMaxMs);
  if (wait <= 0) {
    flushBurst(userId);
    return;
  }
  buf.timer = setTimeout(() => flushBurst(userId), wait);
}

// ── 群聊上下文（2026-10-26）─────────────────────────────────────────────
// 设计来自 AstrBot builtin_stars/astrbot/group_chat_context.py：
//   ① 每个群维护一份最近消息缓存（格式化后存，不存原始事件）
//   ② 只有被 @ / 叫名字 / 回复她时才叫醒模型
//   ③ 只注入「她上次说话之后」的消息，注入后游标前移，避免重复烧 token
// 与 AstrBot 的差别：她的回复也写回缓存（who="你"），这样不依赖 dsh 会话历史
// 也能看出「上一句是我说的」；私聊记忆/日记不进群 prompt，防止把私事说漏嘴。
const groupCtx = new Map(); // gid -> { records: [{ts, uid, who, text, self}], injected }

function groupAllowed(groupId) {
  if (!CFG.groupEnabled) return false;
  const id = String(groupId ?? "");
  if (!id) return false;
  return CFG.groupAllow.includes("*") || CFG.groupAllow.includes(id);
}

function senderName(evt) {
  return String(evt?.sender?.card || evt?.sender?.nickname || evt?.user_id || "群友");
}

function hhmm(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** QQ 结构化卡片（json 段）里能给人看的标题/描述 */
function summarizeJsonCard(data) {
  const raw = data?.data ?? data?.raw ?? data?.content ?? "";
  let j = null;
  try {
    j = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return "";
  }
  const pick =
    j?.prompt ||
    j?.meta?.detail_1?.title ||
    j?.meta?.news?.title ||
    j?.meta?.music?.title ||
    j?.meta?.manifest?.title ||
    j?.meta?.card?.title ||
    "";
  const desc =
    j?.meta?.detail_1?.desc ||
    j?.meta?.news?.desc ||
    j?.meta?.music?.desc ||
    j?.desc ||
    "";
  return [pick, desc]
    .map((x) => String(x ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" - ")
    .slice(0, 120);
}

/** xml 卡片（分享链接等）没有统一结构，粗略取 title / 去标签 */
function summarizeXmlCard(data) {
  const raw = String(data?.data ?? data?.raw ?? "");
  if (!raw) return "";
  const m = raw.match(/title="([^"]+)"/i) || raw.match(/<title>([^<]+)<\/title>/i);
  const text = m ? m[1] : raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .slice(0, 120);
}

/** 把一条群消息压成「谁说了什么」——不下载图片，群消息量太大 */
function groupRecordOf(evt) {
  const segs = Array.isArray(evt.message) ? evt.message : [];
  const me = String(evt.self_id ?? selfId ?? "");
  let text = "";
  for (const seg of segs) {
    if (seg?.type === "text") text += seg.data?.text ?? "";
    else if (seg?.type === "image") text += "[图片]";
    else if (seg?.type === "mface" || seg?.type === "face") text += "[表情]";
    else if (seg?.type === "record") text += "[语音]";
    else if (seg?.type === "file") text += "[文件]";
    else if (seg?.type === "forward") text += "[合并转发]";
    else if (seg?.type === "json") {
      const t = summarizeJsonCard(seg.data);
      text += t ? `[卡片：${t}]` : "[卡片]";
    } else if (seg?.type === "xml") {
      const t = summarizeXmlCard(seg.data);
      text += t ? `[卡片：${t}]` : "[卡片]";
    } else if (seg?.type === "at") {
      const qq = String(seg.data?.qq ?? "");
      if (qq === me) text += "@你";
      else if (qq === "all") text += "@全体成员";
      else text += `@${seg.data?.name || qq}`;
    } else if (seg?.type === "reply") {
      text += "[引用]";
    }
  }
  return {
    ts: Date.now(),
    uid: evt.user_id,
    who: senderName(evt),
    text: text.replace(/\s+/g, " ").trim() || "[空消息]",
    self: false,
  };
}

function trimGroupCtx(ctx) {
  const cutoff = Date.now() - CFG.groupContextMaxAgeMs;
  while (ctx.records.length && ctx.records[0].ts < cutoff) {
    ctx.records.shift();
    ctx.injected = Math.max(0, ctx.injected - 1);
  }
  const overflow = ctx.records.length - CFG.groupContextMax;
  if (overflow > 0) {
    ctx.records.splice(0, overflow);
    ctx.injected = Math.max(0, ctx.injected - overflow);
  }
}

function groupCtxOf(gid) {
  const key = String(gid);
  let ctx = groupCtx.get(key);
  if (!ctx) {
    ctx = { records: [], injected: 0 };
    groupCtx.set(key, ctx);
  }
  return ctx;
}

function recordGroupMessage(evt) {
  const ctx = groupCtxOf(evt.group_id);
  ctx.records.push(groupRecordOf(evt));
  trimGroupCtx(ctx);
}

function appendGroupBotReply(groupId, text) {
  const body = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!body) return;
  const ctx = groupCtxOf(groupId);
  ctx.records.push({ ts: Date.now(), uid: selfId, who: "你", text: body, self: true });
  trimGroupCtx(ctx);
}

/**
 * 取「上次她说话之后」的群消息。
 * @returns {{lines: string[], injectedCount: number}}
 */
function takeGroupContext(groupId) {
  const ctx = groupCtxOf(groupId);
  const cutoff = Date.now() - CFG.groupContextMaxAgeMs;
  const pending = ctx.records.slice(ctx.injected).filter((r) => r.ts >= cutoff);
  const lines = [];
  let chars = 0;
  for (let i = pending.length - 1; i >= 0; i--) {
    const r = pending[i];
    const line = `[${r.who}/${hhmm(r.ts)}]: ${r.text}`;
    if (lines.length && chars + line.length > CFG.groupContextMaxChars) break;
    lines.unshift(line);
    chars += line.length;
  }
  return { lines, injectedCount: ctx.records.length };
}

/** 这一轮处理完才前移游标：生成期间新进来的消息留给下一轮 */
function markGroupInjected(groupId, count) {
  const ctx = groupCtxOf(groupId);
  ctx.injected = Math.max(ctx.injected, Math.min(Number(count) || 0, ctx.records.length));
}

/**
 * 触发的这条只入库、不进本轮上下文（prompt 末尾已经带了原话），
 * 但要留给下一轮——否则下次上下文里只有她的回复，看不到她回的是哪句话。
 */
function recordGroupTrigger(groupId, evt, text) {
  const ctx = groupCtxOf(groupId);
  const body = String(text ?? "").replace(/\s+/g, " ").trim();
  ctx.records.push({
    ts: Date.now(),
    uid: evt.user_id,
    who: senderName(evt),
    text: body || "[空消息]",
    self: false,
  });
  trimGroupCtx(ctx);
  return ctx.injected;
}

/**
 * 这条群消息是不是在叫小玉。
 * 三种触发：@她 / 回复她最后一条消息 / 开头叫 GROUP_WAKE。
 */
function detectGroupTrigger(evt) {
  if (!groupAllowed(evt?.group_id)) return null;
  const segs = Array.isArray(evt.message) ? evt.message : [];
  const me = String(evt.self_id ?? selfId ?? "");
  const gid = String(evt.group_id);
  const atSelf = segs.some((s) => s?.type === "at" && String(s.data?.qq ?? "") === me);
  const replyToBot = segs.some(
    (s) => s?.type === "reply" && String(s.data?.id ?? "") === String(lastBotMsgId.get(gid) ?? "")
  );

  let wake = false;
  let wakeText = null;
  if (!atSelf && !replyToBot && CFG.groupWake) {
    const raw = extractTextOnly(evt.message, evt.raw_message).trim();
    const m = raw.match(new RegExp(`^${escapeRegExp(CFG.groupWake)}(?:[\\s，,。.!！?？~～]+|$)`));
    if (m) {
      wake = true;
      wakeText = raw.slice(m[0].length).trim();
    }
  }
  if (!atSelf && !replyToBot && !wake) return null;
  return { atSelf, replyToBot, wake, wakeText };
}

// ── 事件处理 ────────────────────────────────────────────────────────────
async function handleEvent(evt) {
  if (evt.post_type === "meta_event") {
    if (evt.meta_event_type === "lifecycle") {
      selfId = evt.self_id;
      log(`[bot] 登录成功，机器人 QQ = ${selfId}`);
    }
    return;
  }

  if (evt.post_type !== "message") {
    // 2026-10-25：私聊文件在部分 OneBot 实现里不走 message 而走 notice（offline_file）。
    // 先原样记下来，真碰到才知道该在哪接。
    if (evt.post_type !== "meta_event") {
      log(`[evt] ${evt.post_type}/${evt.notice_type ?? evt.request_type ?? "-"} ${JSON.stringify(evt).slice(0, 300)}`);
    }
    return;
  }
  if (evt.post_type !== "message") return;
  if (evt.message_type !== "private" && evt.message_type !== "group") return;
  if (evt.user_id === evt.self_id) return;

  // 去重：NapCat 重投同一事件时 message_id 重复（2026-10-18 21:40 实测双投）。
  // 不拦的话同一条消息走两遍 LLM：一遍成功一遍失败，白烧额度还吓人。
  if (isDuplicate(evt.message_id)) {
    log(`[skip] 重复消息 id=${evt.message_id}，已忽略`);
    return;
  }

  // ── 群聊（2026-10-26，借鉴 AstrBot）────────────────────────────────
  // 没被叫醒的群消息只进缓存，不调模型、不回话；被 @/叫名字/回复她时
  // 才把「上次她说话之后」的记录拼进 prompt。
  if (evt.message_type === "group") {
    if (!groupAllowed(evt.group_id)) return;
    const trigger = detectGroupTrigger(evt);
    if (!trigger) {
      recordGroupMessage(evt);
      return;
    }

    const gid = String(evt.group_id);
    const name = senderName(evt);
    const who = `g${gid}`;
    await Promise.all([expandForwards(evt.message, who), expandQuotes(evt.message, who)]);
    const { text, images, stickerOnly } = extractContent(evt.message, evt.raw_message, who);
    for (const seg of Array.isArray(evt.message) ? evt.message : []) {
      if (Array.isArray(seg?.data?.__forwardImages)) images.push(...seg.data.__forwardImages);
      if (Array.isArray(seg?.data?.__quoteImages)) images.push(...seg.data.__quoteImages);
    }
    const clean = text.replace(/^\s*@你\s*/, "").trim() || "[只@了你，没有说别的]";
    log(
      `[group] ${gid} ${name}${trigger.atSelf ? " @" : trigger.replyToBot ? " 回复" : " 叫"}：${clean.slice(0, 60)}` +
        (images.length ? ` [+${images.length}图]` : "")
    );
    enqueue(() => {
      const ctx = takeGroupContext(gid);
      const injected = recordGroupTrigger(gid, evt, clean);
      return replyTo(
        { kind: "group", groupId: gid, triggerMessageId: evt.message_id, senderId: evt.user_id, senderName: name },
        clean,
        images,
        {
          stickerOnly,
          groupCtx: ctx.lines,
          groupInjectedCount: injected,
          groupSpeaker: name,
          groupAt: trigger.atSelf || trigger.wake,
        }
      );
    });
    return;
  }

  const userId = evt.user_id;
  // 合并转发 / 引用消息只带 id，先把内容和图片拉回来，再交给同步提取函数。
  await Promise.all([expandForwards(evt.message, userId), expandQuotes(evt.message, userId)]);
  const { text, images, stickerImages, stickerOnly } = extractContent(
    evt.message,
    evt.raw_message,
    userId
  );
  // 转发/引用里的图单独下载，合并进同一条消息，跟普通图片一起送模型。
  for (const seg of Array.isArray(evt.message) ? evt.message : []) {
    if (Array.isArray(seg?.data?.__forwardImages)) images.push(...seg.data.__forwardImages);
    if (Array.isArray(seg?.data?.__quoteImages)) images.push(...seg.data.__quoteImages);
  }
  // 音频段先认出来：它的文本标记只有 [语音]/[文件]，不豁免去重的话
  // 3 秒内连发两条语音会被 isTextDuplicate 当成重发吞掉。
  const audioSegs = Array.isArray(evt.message)
    ? evt.message.filter((s) => s?.type === "record" || s?.type === "file")
    : [];
  const { records: recordSegs, files: fileSegs } = classifyAudioSegs(audioSegs);
  // 落一条流水：写日记要用它当素材（内存 histories 重启就没了）。
  // 语音等转成文字再落，避免流水里只剩一个 [语音]。
  if (text.trim() && !recordSegs.length) appendChatLog(userId, "user", text);

  // 去重二：同人 + 同文本 + 3 秒内 → 判老大 QQ 客户端弱网重发并忽略
  // （2026-10-18 21:53-21:55 实测连中 4 次；message_id 会变，一级去重拦不住，
  //  双份消息双烧积分还附赠一条降级提示）。
  // 带图消息豁免：图片消息的文本都是 [图片]，拦了会误吞老大真发的第二张图。
  if (isTextDuplicate(userId, text, images.length > 0 || audioSegs.length > 0)) {
    log(`[skip] 3 秒内同文本重发，按客户端重发忽略（id=${evt.message_id ?? "无"}）`);
    return;
  }

  if (CFG.allowFrom.length && !CFG.allowFrom.includes(userId)) {
    log(`[skip] 非白名单 ${userId}: ${text.slice(0, 40)}`);
    return;
  }

  // 2026-10-28：老大发来的表情包自动入库（md5 去重 + 容量上限 + 后台打标）。
  // 逐张判定，由 extractContent 按 sub_type/mface 挑出真正是表情的那几张。
  if (stickerImages.length) {
    try {
      learnStickers(stickerImages);
    } catch (e) {
      logErr(`[sticker-learn] 异常: ${String(e.message).slice(0, 120)}`);
    }
  }

  // 2026-10-25：语音条是聊天，不是换声素材；只有文件才进换声队列。
  // 必须放在 `!text.trim()` 之前：纯语音消息本身没有文字。
  if (audioSegs.length) {
    const meta = { text, images, stickerOnly, userTs: Date.now(), messageId: evt.message_id };
    enqueue(() =>
      runIncomingAudio(userId, meta, recordSegs, fileSegs).catch((e) => {
        logErr(`[audio] 处理失败: ${String(e.message).slice(0, 200)}`);
        if (recordSegs.length) sendPrivate(userId, ASR_FAILED_TEXT).catch(() => {});
      })
    );
    return;
  }

  if (!text.trim()) return;

  // 指令只认白名单（上面已过），不进 LLM、不烧积分
  const cmd = parseCommand(text);
  if (cmd) {
    log(`[cmd] ${userId} (msg_id=${evt.message_id ?? "无"}): ${text.slice(0, 60)}`);
    enqueue(() => runCommand(userId, cmd));
    return;
  }

  // 2026-10-24：改成自然说法「我要听稻香」，不带 # 也认；#唱歌 保留
  const songReq = parseSongRequest(text);
  if (songReq) {
    log(`[sing] ${userId} 点歌「${songReq.arg || "歌单"}」`);
    enqueue(() => runSingRequest(userId, songReq.arg));
    return;
  }

  if (images.length) log(`[img] ${userId} 发来 ${images.length} 张图`);
  log(`[recv] ${userId} (msg_id=${evt.message_id ?? "无"}): ${text.slice(0, 80)}`);

  // 连发合并（2026-10-22）：攒一小会儿再一起答，别把同一口气拆成两次问答。
  // mergeBurstMs=0 → 直接走老路径。
  if (CFG.mergeBurstMs > 0) {
    bufferMessage(userId, text, images, stickerOnly);
    return;
  }
  enqueue(() => replyTo(userId, text, images, { stickerOnly }));
}

/**
 * 合并转发展开（2026-10-26）。
 * NapCat 默认 parseMultMsg=false，forward 段只给 {type:"forward", data:{id}}，
 * 不带内容；extractTextOnly 又不认这个段，纯转发消息会在 !text.trim() 被整条丢掉。
 * 这里先调 get_forward_msg 把内容拉到 seg.data.__forwardText，
 * 后面的同步提取函数直接读，避免把整条消息链改成 async。
 */
const FORWARD_MAX_NODES = 50;
const FORWARD_MAX_CHARS = 1500;
const FORWARD_MAX_DEPTH = 2;
const FORWARD_MAX_IMAGES = 4;

function flattenForwardNodes(nodes, depth = 0) {
  if (!Array.isArray(nodes) || depth > FORWARD_MAX_DEPTH) return "";
  const lines = [];
  for (const node of nodes.slice(0, FORWARD_MAX_NODES)) {
    const name =
      node?.sender?.card ||
      node?.sender?.nickname ||
      String(node?.sender?.user_id ?? node?.user_id ?? "?");
    const segs = Array.isArray(node?.message)
      ? node.message
      : Array.isArray(node?.content)
        ? node.content
        : [];
    let body = "";
    if (segs.length) {
      body = segs
        .map((s) => {
          if (s?.type === "text") return s.data?.text ?? "";
          if (s?.type === "image" || s?.type === "mface") return "[图片]";
          if (s?.type === "face") return "[表情]";
          if (s?.type === "record") return "[语音]";
          if (s?.type === "file") return "[文件]";
          if (s?.type === "forward") {
            return Array.isArray(s.data?.content)
              ? flattenForwardNodes(s.data.content, depth + 1)
              : "[嵌套转发]";
          }
          return "";
        })
        .join("")
        .trim();
    } else {
      body = String(node?.raw_message ?? "").trim();
    }
    lines.push(`${name}: ${body || "[空]"}`);
  }
  if (nodes.length > FORWARD_MAX_NODES) {
    lines.push(`…（还有 ${nodes.length - FORWARD_MAX_NODES} 条未展开）`);
  }
  return lines.join("\n");
}

/**
 * 异步下载转发里的图片。
 * 不能复用 downloadImage：它是 execFileSync，一条聊天记录里几张图就会把
 * 整个消息循环卡住；这里用 execFile 并行，单张 15 秒封顶。
 */
function downloadImageAsync(seg, userId) {
  return new Promise((resolve) => {
    const url = seg?.data?.url;
    if (!url) return resolve(null);
    try {
      mkdirSync(CFG.imageDir, { recursive: true });
      const ext = guessExt(url);
      const name = `${Date.now()}_${userId || "u"}_fw${Math.random().toString(36).slice(2, 8)}${ext}`;
      const dest = join(CFG.imageDir, name);
      execFile(
        "curl",
        ["-sSL", "-o", dest, "--max-time", "15", "--retry", "1", "--retry-delay", "1", "-A", "Mozilla/5.0", url],
        { windowsHide: true },
        (err) => {
          try {
            if (err) logErr(`[forward-img] curl 失败: ${String(err.message).slice(0, 100)}`);
            if (existsSync(dest) && statSync(dest).size > 0) {
              const finalPath = fixImageExt(dest);
              pruneImages();
              log(`[forward-img] 已存 ${basename(finalPath)} (${statSync(finalPath).size} 字节)`);
              return resolve(finalPath);
            }
            resolve(null);
          } catch (e) {
            logErr(`[forward-img] 落地失败: ${String(e.message).slice(0, 100)}`);
            resolve(null);
          }
        }
      );
    } catch (e) {
      logErr(`[forward-img] 下载失败: ${String(e.message).slice(0, 120)}`);
      resolve(null);
    }
  });
}

function collectForwardImageSegs(nodes, out = [], depth = 0) {
  if (!Array.isArray(nodes) || depth > FORWARD_MAX_DEPTH) return out;
  for (const node of nodes) {
    const segs = Array.isArray(node?.message)
      ? node.message
      : Array.isArray(node?.content)
        ? node.content
        : [];
    for (const s of segs) {
      if (s?.type === "image" || s?.type === "mface") {
        out.push(s);
      } else if (s?.type === "forward" && Array.isArray(s.data?.content)) {
        collectForwardImageSegs(s.data.content, out, depth + 1);
      }
    }
  }
  return out;
}

async function downloadForwardImages(nodes, userId) {
  const all = collectForwardImageSegs(nodes);
  const picked = all.slice(0, FORWARD_MAX_IMAGES);
  const results = await Promise.all(picked.map((s) => downloadImageAsync(s, userId)));
  const images = results.filter((p) => typeof p === "string" && p);
  return {
    images,
    failed: picked.length - images.length,
    skipped: Math.max(0, all.length - picked.length),
  };
}

async function expandForwards(message, userId) {
  if (!Array.isArray(message)) return message;
  for (const seg of message) {
    if (seg?.type !== "forward") continue;
    const id = seg.data?.id;
    // NapCat 开 parseMultMsg 时 content 已经在事件里，直接复用，省一次 API。
    let nodes = Array.isArray(seg.data?.content) ? seg.data.content : null;
    if (!nodes && id) {
      try {
        const r = await callApi("get_forward_msg", { message_id: String(id) });
        nodes = Array.isArray(r?.messages) ? r.messages : null;
      } catch (e) {
        logErr(`[forward] 拉取失败 id=${id}: ${String(e.message).slice(0, 120)}`);
      }
    }
    const flat = nodes ? flattenForwardNodes(nodes) : "";
    const fw = nodes
      ? await downloadForwardImages(nodes, userId)
      : { images: [], failed: 0, skipped: 0 };
    let clipped =
      flat.length > FORWARD_MAX_CHARS
        ? `${flat.slice(0, FORWARD_MAX_CHARS)}\n…（已截断）`
        : flat;
    const missingImgs = fw.failed + fw.skipped;
    if (missingImgs > 0) {
      clipped += `\n[系统提示：这条合并转发里还有 ${missingImgs} 张图没取到，你看不到。]`;
    }
    seg.data = {
      ...(seg.data || {}),
      __forwardText:
        clipped ||
        (fw.images.length ? "[合并转发：只有图片]" : "[合并转发：内容拉取失败]"),
      __forwardImages: fw.images,
    };
    log(
      `[forward] ${flat ? `展开 ${flat.split("\n").length} 行 / ${flat.length} 字` : "拉取失败"}，图 ${fw.images.length} 张${missingImgs ? `（${missingImgs} 张未取到）` : ""} id=${id ?? "无"}`
    );
  }
  return message;
}

const QUOTE_MAX_CHARS = 500;
const QUOTE_MAX_IMAGES = 2;

/**
 * 展开引用消息（2026-10-26）。
 * OneBot 的 reply 段只有 id，被引用的文字/图片都不在事件里。
 * 老大经常「引用一张图 → 问这啥」，不拉 get_msg 就只能回「我看不到」。
 * 只处理当前这条（私聊消息 / 群里叫醒她的那条），群上下文里只记 [引用]，
 * 不然每来一条群消息都打一次 API，很快会被风控。
 */
async function expandQuotes(message, userId) {
  if (!Array.isArray(message)) return message;
  for (const seg of message) {
    if (seg?.type !== "reply") continue;
    const id = seg.data?.id;
    if (!id) continue;
    try {
      const r = await callApi("get_msg", { message_id: String(id) });
      const quoted = r?.message ?? "";
      let text = extractTextOnly(quoted, r?.raw_message ?? "").trim();
      if (text.length > QUOTE_MAX_CHARS) text = `${text.slice(0, QUOTE_MAX_CHARS)}…`;
      const imgSegs = (Array.isArray(quoted) ? quoted : [])
        .filter((s) => s?.type === "image" || s?.type === "mface")
        .slice(0, QUOTE_MAX_IMAGES);
      const images = (await Promise.all(imgSegs.map((s) => downloadImageAsync(s, userId)))).filter(
        (p) => typeof p === "string" && p
      );
      seg.data = {
        ...(seg.data || {}),
        __quoteText: text || (images.length ? "[引用的是图片]" : ""),
        __quoteImages: images,
        __quoteName: String(
          r?.sender?.card || r?.sender?.nickname || r?.sender?.user_id || ""
        ),
      };
      log(`[quote] 展开「${text.slice(0, 40)}」图 ${images.length} 张 id=${id}`);
    } catch (e) {
      logErr(`[quote] 拉取失败 id=${id}: ${String(e.message).slice(0, 120)}`);
    }
  }
  return message;
}

/**
 * 只取文本部分，不下载图片。独立出来是为了能单测 ——
 * 下载依赖网络，文本规则不依赖。
 *
 * 2026-10-18 的演进：
 *   v1（老问题）：只 `filter(type === "text")`，图片段被静默丢弃
 *     → 老大发表情包，小玉却答「看到啦」，其实什么都没看到
 *   v2：图片转成 `[图片]` 标记，模型知道有人发图但看不到内容
 *     → 诚实了，但还是看不见
 *   v3（现在）：见 extractContent，图会下载到本地让模型自己看
 */
function extractTextOnly(message, raw) {
  if (Array.isArray(message)) {
    const parts = [];
    for (const seg of message) {
      if (seg.type === "text") {
        parts.push(seg.data?.text ?? "");
      } else if (seg.type === "image") {
        // 表情包在 OneBot 里也是 image 段，sub_type=1 通常是表情
        parts.push(seg.data?.sub_type === 1 ? "[表情]" : "[图片]");
      } else if (seg.type === "face" || seg.type === "mface") {
        parts.push("[表情]");
      } else if (seg.type === "record") {
        // 2026-10-25：不加这个标记，纯语音消息的 text 是空串，
        // 会在 handleEvent 的 `if (!text.trim()) return` 被整条丢掉。
        parts.push("[语音]");
      } else if (seg.type === "file") {
        parts.push("[文件]");
      } else if (seg.type === "forward") {
        // 内容由 expandForwards 预取；没取到也留标记，避免整条消息被丢掉。
        parts.push(
          seg.data?.__forwardText
            ? `\n[合并转发]\n${seg.data.__forwardText}\n`
            : "[合并转发]"
        );
      } else if (seg.type === "reply") {
        // 内容由 expandQuotes 预取；群上下文里只记 [引用]，不展开。
        const quote = seg.data?.__quoteText;
        const qname = seg.data?.__quoteName;
        parts.push(quote ? `[引用${qname ? ` ${qname}` : ""}：${quote}]` : "[引用消息]");
      } else if (seg.type === "at") {
        const qq = String(seg.data?.qq ?? "");
        if (qq === String(selfId ?? "")) parts.push("@你");
        else if (qq === "all") parts.push("@全体成员");
        else parts.push(`@${seg.data?.name || qq}`);
      } else if (seg.type === "json") {
        const t = summarizeJsonCard(seg.data);
        parts.push(t ? `[卡片：${t}]` : "[卡片]");
      } else if (seg.type === "xml") {
        const t = summarizeXmlCard(seg.data);
        parts.push(t ? `[卡片：${t}]` : "[卡片]");
      }
    }
    return parts.join("");
  }
  if (typeof message === "string") {
    // CQ 码字符串形式：把图片 CQ 码换成标记，而不是直接删掉
    return String(message)
      .replace(/\[CQ:image[^\]]*\]/g, "[图片]")
      .replace(/\[CQ:face[^\]]*\]/g, "[表情]")
      .replace(/\[CQ:mface[^\]]*\]/g, "[表情]")
      .replace(/\[CQ:record[^\]]*\]/g, "[语音]")
      .replace(/\[CQ:file[^\]]*\]/g, "[文件]")
      .replace(/\[CQ:[^\]]*\]/g, "");
  }
  return raw ?? "";
}

/**
 * 这一段是不是表情包。
 *
 * ⚠️ sub_type 不可靠（2026-10-28 全量日志统计）：
 *   sub_type=1 + summary=[动画表情]  → 收藏表情，52 次
 *   sub_type=- + summary=[开心]/[晚安]… → **也是表情包，26 次**（只认 1 会全漏）
 *   sub_type=7 + summary=[睡不着]/[别急] → 也是表情包，4 次
 *   sub_type=0 + 无 summary → 普通图片，14 次
 *   sub_type=11 + 无 summary → 未知，3 次
 * 真正能分开两类的是 summary：表情包一律带短摘要，普通图片一律没有。
 */
function isStickerSeg(seg) {
  if (seg?.type === "mface") return true;
  const st = Number(seg?.data?.sub_type);
  if (st === 1) return true;
  // 显式 sub_type=0 是普通图片；没有摘要的也别收（宁可漏一张，别把截图表情化）
  if (st === 0) return false;
  const summary = String(seg?.data?.summary ?? "").trim();
  if (!summary || summary === "[图片]") return false;
  return summary.length <= 12;
}

/**
 * 取文本 + 下载图片。
 * @returns {{ text: string, images: string[] }}
 */
function extractContent(message, raw, userId) {
  const rawImages = [];
  let imageFailed = 0;
  // 2026-10-21 23:5x：记一下「这一条全是表情包」。
  // 起因：老大嫌她收到表情还要描述画面（「圆脸憋着不动 → 嘴越咧越大」像图注）。
  // 表情包该做的是接梗，不是报画面——但普通图片（截图/照片）该说的还得说。
  // 所以判定放在这里（只有这里知道 sub_type），一路传到 prompt。
  let imgSegs = 0;
  let stickerSegs = 0;
  // 只收「确定是表情包」的原图。入库不能靠 stickerOnly 判别：
  // 实测一条消息里可能混着 sub_type=1 和 0/11，那种情况下整条不算「纯表情」，
  // 但里面那几张真表情包不该跟着丢。
  const stickerImages = [];
  let text = extractTextOnly(message, raw);

  // 2026-10-19 修复：原来这里显式跳过表情包（`sub_type !== 1`），
  // 那是 OCR 时代的取舍——OCR 读表情包基本读不出字，下载也白搭。
  // 但视觉直传打通之后，**表情包恰恰是最该看的东西**（老大发的就是表情包），
  // 跳过等于永远看不到。现在 image 段一律下载，sub_type=1 也下。
  if (CFG.imageEnabled && Array.isArray(message)) {
    for (const seg of message) {
      if (seg.type === "image" || seg.type === "mface" || seg.type === "face") {
        // 排障用：一眼看出发来的是哪种段、有没有可下载的 url。
        // 没有 url 的段（QQ 内置小黄脸）注定看不到图，日志里要能区分。
        log(
          `[seg] type=${seg.type} sub_type=${seg.data?.sub_type ?? "-"} url=${seg.data?.url ? "有" : "无"}` +
            (seg.data?.summary ? ` summary=${String(seg.data.summary).slice(0, 20)}` : "")
        );
      }
      // 2026-10-21 修误报：QQ 有些 image 段**根本没有 url**（内置小黄脸、已过期链接），
      // 那本来就没法看，不该算「下载失败」——否则会给她一条假提示
      // 「还有 N 张图下载失败」，她就会跟老大说"图没传过来"（18:20 实测踩到）。
      if (seg.type === "image") {
        if (!seg.data?.url) {
          log(`[img] 该 image 段没有 url，跳过（不是失败）`);
        } else {
          const p = downloadImage(seg, userId);
          if (p) {
            rawImages.push(p);
            imgSegs++;
            if (isStickerSeg(seg)) {
              stickerSegs++;
              stickerImages.push(p);
            }
          } else imageFailed++;
        }
      } else if (seg.type === "mface") {
        // 商城表情/大表情：一般带 url，能当图看
        if (!seg.data?.url) {
          log(`[img] 该 mface 段没有 url，跳过（不是失败）`);
        } else {
          const p = downloadImage(seg, userId);
          if (p) {
            rawImages.push(p);
            imgSegs++;
            stickerSegs++; // mface 一律当表情包
            stickerImages.push(p);
          } else imageFailed++;
        }
      }
      // face（QQ 内置小黄脸）只有表情 id、没有图片 url，无从看图，只能留文字标记
    }
  }

  // 动图（GIF / 动态 WebP）必须拆帧：实测直传只会拿到第一帧
  // （pi-ai 会把图规范化成单帧 webp），模型自己都说「只保留其中一帧」。
  // 展开失败的动图会原样保留（当静态图用），不丢消息。
  let images = rawImages;
  if (rawImages.length > 0 && CFG.animFrames > 0) {
    try {
      const expanded = expandAnimatedImages(rawImages, { maxFrames: CFG.animFrames });
      images = expanded.images;
      for (const a of expanded.animations) {
        if (a.picked > 0) {
          log(`[anim] 动图 ${basename(a.path)} 共 ${a.total} 帧，抽了 ${a.picked} 帧`);
        } else {
          log(`[anim] ${basename(a.path)} 没抽成（${a.error || "非多帧"}），按静态图处理`);
        }
      }
    } catch (e) {
      logErr(`[anim] 抽帧整体异常，按静态图处理：${String(e.message).slice(0, 140)}`);
    }
  }

  // 有图没下载成功时必须让她知道，否则她会把「没看到」说成「你没发」
  // （2026-10-20 21:51 那次：老大发的图 curl 失败，她连着几条都说「原图没到」）
  if (imageFailed > 0) {
    text = `${text}\n[系统提示：对方这条消息里还有 ${imageFailed} 张图，但下载失败了，你看不到内容。如实说没收到，别猜图里是什么。]`.trim();
    logErr(`[img] ${imageFailed} 张图下载失败，已在 prompt 里告知模型`);
  }

  // rawImages 是下载下来的原图（动图没拆帧），表情包入库必须用它：
  // images 里的 frames 是给模型看的临时产物，存进去等于把一张表情拆成几帧。
  return {
    text,
    images,
    rawImages,
    stickerImages,
    stickerOnly: imgSegs > 0 && stickerSegs === imgSegs,
  };
}

/**
 * 下载 OneBot 的图片段到本地。
 *
 * URL 优先级：data.url（腾讯 CDN 直链，最省事）→ 放弃。
 * 命名带上 QQ 号，出问题时能溯回是谁发的。
 *
 * ⚠️ 为什么用 execFileSync 而不是 fetch：NapCat 给的 CDN 链接带签名参数，
 * 且需要遵守它的跳转；curl 对这两点最省心。沙箱会拦 spawn（EPERM），
 * 但 bridge 是老大双击启动的，不受这个限制。
 */
function downloadImage(seg, userId) {
  try {
    const url = seg?.data?.url;
    if (!url) return null;

    mkdirSync(CFG.imageDir, { recursive: true });
    const ext = guessExt(url);
    const name = `${Date.now()}_${userId || "u"}${ext}`;
    const dest = join(CFG.imageDir, name);

    // 2026-10-21：加重试。「偶有看不见图」的实测原因之一是腾讯 CDN 偶尔拉不下来
    // （10-20 21:51 那次 curl 直接失败，那张正是老大要看的图，她只能一直说「原图没到」）。
    // curl 自带 --retry 处理瞬时故障，比外面套循环干净；超时也从 20s 放到 30s。
    try {
      execFileSync(
        "curl",
        ["-sSL", "-o", dest, "--max-time", "30", "--retry", "2", "--retry-delay", "1", "-A", "Mozilla/5.0", url],
        { windowsHide: true, stdio: ["ignore", "ignore", "ignore"] }
      );
    } catch (e) {
      logErr(`[img] curl 失败（已重试 2 次）：${String(e.message).slice(0, 100)}`);
    }

    if (existsSync(dest) && statSync(dest).size > 0) {
      // 2026-10-21：扩展名不能信 URL（QQ 表情包存成 .jpg 实际是 GIF），
      // 按文件头纠正，否则视觉管线整轮报 `Declared image type does not match its bytes`
      const finalPath = fixImageExt(dest);
      pruneImages();
      log(`[img] 已存 ${basename(finalPath)} (${statSync(finalPath).size} 字节)`);
      return finalPath;
    }
    logErr(`[img] 下载结果为空：${url.slice(0, 60)}`);
  } catch (e) {
    logErr(`[img] 下载失败: ${String(e.message).slice(0, 120)}`);
  }
  return null;
}

function guessExt(u) {
  const m = String(u).match(/\.(jpg|jpeg|png|gif|webp|bmp)(?:[?#]|$)/i);
  return m ? `.${m[1].toLowerCase()}` : ".jpg";
}

/**
 * 扩展名和真实格式不符就改名，返回最终路径。
 *
 * 抽成独立函数是为了能单独测「改名这个动作本身」——
 * 只测 sniffImageExt 只能证明判断对，不能证明真的改了。
 */
function fixImageExt(p) {
  const real = sniffImageExt(p);
  if (!real) return p;
  const declared = (p.match(/\.[a-z0-9]+$/i)?.[0] ?? "").toLowerCase();
  if (declared === real || (declared === ".jpeg" && real === ".jpg")) return p;

  let renamed = p.replace(/\.[a-z0-9]+$/i, real);
  // renameSync 在 Windows 上会**静默覆盖**同名目标。2026-10-21 实测：
  // a.gif（真 JPEG）改名为 a.jpg 时，把原本就在的 a.jpg（真 GIF）直接盖掉了，
  // 两个文件变一个。所以目标已存在时加时间戳后缀，宁可名字丑也不能丢文件。
  if (existsSync(renamed)) {
    renamed = renamed.replace(new RegExp(`\\${real}$`), `-${Date.now().toString(36)}${real}`);
  }
  try {
    renameSync(p, renamed);
    log(`[img] 扩展名纠正 ${basename(p)} → ${basename(renamed)}（真实格式 ${real}）`);
    return renamed;
  } catch (e) {
    logErr(`[img] 改名失败 ${basename(p)}: ${String(e.message).slice(0, 80)}`);
    return p;
  }
}

/**
 * 按文件头判断真实图片格式（不信扩展名）。
 *
 * 只读前 12 字节，够认 PNG / JPEG / GIF / WebP / BMP。
 * 实测踩坑：QQ 表情包 URL 存下来叫 .jpg，实际是 GIF89a，
 * 视觉管线报 `Declared image type does not match its bytes`，一整轮识图都废掉。
 */
function sniffBufExt(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return ".png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ".jpg";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return ".gif";
  if (buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP") return ".webp";
  if (buf[0] === 0x42 && buf[1] === 0x4d) return ".bmp";
  return null;
}

function sniffImageExt(p) {
  let fd = null;
  try {
    fd = openSync(p, "r");
    const buf = Buffer.alloc(12);
    readSync(fd, buf, 0, 12, 0);
    return sniffBufExt(buf);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

/** 只留最近 N 张图，防止 .run/img 无限增长 */
function pruneImages() {
  try {
    const files = readdirSync(CFG.imageDir)
      .filter((f) => /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(f))
      .map((f) => join(CFG.imageDir, f))
      .map((p) => ({ p, m: statSync(p).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    for (const f of files.slice(CFG.imageKeep)) {
      try {
        unlinkSync(f.p);
      } catch {}
    }

    // 动图抽帧产物在 .run/img/frames/<图名>/ 下，单独清理：
    // 只保留最近 imageKeep/5 个目录（帧文件多，不按图数量算）
    const framesRoot = join(CFG.imageDir, "frames");
    if (!existsSync(framesRoot)) return;
    const dirs = readdirSync(framesRoot)
      .map((d) => join(framesRoot, d))
      .filter((p) => {
        try {
          return statSync(p).isDirectory();
        } catch {
          return false;
        }
      })
      .map((p) => ({ p, m: statSync(p).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    const keepDirs = Math.max(2, Math.floor(CFG.imageKeep / 5));
    for (const d of dirs.slice(keepDirs)) {
      try {
        rmSync(d.p, { recursive: true, force: true });
      } catch {}
    }
  } catch {}
}

// ── 生图（2026-10-26）───────────────────────────────────────────────────
// 两条通道：
//   pollinations：免 key。实测 https://image.pollinations.ai/prompt/... 能出图，
//                 但免费额度是 1 张/45 秒/IP，所以本地串行排队，不并发打。
//   openai：任何 OpenAI 兼容 /v1/images/generations（硅基流动、智谱 v4、自建网关）。
// 失败不静默：写日志 + 给用户一句人话；连续失败进冷却，prompt 里也会说「现在画不了」，
// 避免她嘴上答应画图、实际发不出来。
const IMAGE_GEN_DEFAULT_BASE = {
  pollinations: "https://image.pollinations.ai",
  openai: "https://api.siliconflow.cn/v1",
};
let pollinationsNextAt = 0;
let imageGenDownUntil = 0;
let imageGenLastError = "";

// 画自己（2026-10-26）：pollinations/flux 实测会丢掉鳍耳、鲸尾、围裙鲸鱼，
// 两轮对照实验都只留下蓝发和发饰，所以「画自己」直接发固定标准照；
// 下面这版模板只在标准照缺失时兜底，保证至少是蓝发动漫女仆。
const SELF_PORTRAIT_PROMPT =
  "chibi anime girl, full body character sheet, dark blue long hair with ahoge, blue eyes, " +
  "white lace maid headdress, blue bow, two blue fin-like ears on the sides of her head, " +
  "a large blue whale tail with flukes behind her, navy blue and white maid dress, " +
  "white apron with blue whale logo, flat colors, thick outlines, simple white background";
const SELF_PORTRAIT_SEED = 20261026;
const SELF_PORTRAIT_IMAGE =
  process.env.SELF_PORTRAIT_IMAGE ?? join(__dirname, "assets", "xiaoyu-self.jpg");

// 同一套形象的多张图（2026-10-26 搜集）：首图仍是标准照，
// 之后按文件名顺序轮换，避免每次「换一张」都发同一张。
const SELF_PORTRAIT_DIR =
  process.env.SELF_PORTRAIT_DIR ?? join(__dirname, "assets", "self");
const SELF_PORTRAIT_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

function listSelfPortraits() {
  const list = [];
  if (existsSync(SELF_PORTRAIT_IMAGE)) list.push(SELF_PORTRAIT_IMAGE);
  try {
    for (const name of readdirSync(SELF_PORTRAIT_DIR).sort()) {
      if (!SELF_PORTRAIT_EXTS.has(extname(name).toLowerCase())) continue;
      const p = join(SELF_PORTRAIT_DIR, name);
      if (!list.includes(p)) list.push(p);
    }
  } catch {}
  return list;
}

/** 纯函数：按顺序取下一张；上次不在列表里（首次/文件被删）就回到首图 */
function nextPortraitPath(list, last) {
  if (!Array.isArray(list) || list.length === 0) return null;
  if (!last) return list[0];
  const i = list.indexOf(last);
  return list[(i + 1) % list.length];
}

const lastSelfPortraitImage = new Map();

function pickSelfPortrait(t, list = listSelfPortraits()) {
  const key = targetKey(t);
  const next = nextPortraitPath(list, lastSelfPortraitImage.get(key));
  if (next) lastSelfPortraitImage.set(key, next);
  return next;
}

function imageGenConfigured() {
  if (!CFG.imageGenEnabled || CFG.imageGenProvider === "off") return false;
  if (CFG.imageGenProvider === "pollinations") return true;
  if (CFG.imageGenProvider === "openai") return Boolean(CFG.imageGenKey);
  return false;
}

function imageGenReady() {
  return imageGenConfigured() && Date.now() >= imageGenDownUntil;
}

function imageGenCooldownLeftMs() {
  return Math.max(0, imageGenDownUntil - Date.now());
}

function imageGenLabel() {
  if (!imageGenConfigured()) return "未配置";
  return `${CFG.imageGenProvider}${CFG.imageGenModel ? `/${CFG.imageGenModel}` : ""}`;
}

/** 纯函数：按 provider 生成请求描述，便于 --selftest 覆盖 */
function buildImageGenRequest(prompt, opts = {}) {
  const provider = CFG.imageGenProvider;
  const size = String(opts.size ?? CFG.imageGenSize ?? "768x768");
  const [w, h] = size.split("x").map((n) => Number(n) || 768);

  if (provider === "pollinations") {
    const base = String(CFG.imageGenBaseUrl || IMAGE_GEN_DEFAULT_BASE.pollinations).replace(/\/+$/, "");
    const model = CFG.imageGenModel || "flux";
    const seed = opts.seed ?? Math.floor(Math.random() * 1e9);
    return {
      kind: "get",
      url:
        `${base}/prompt/${encodeURIComponent(prompt)}` +
        `?width=${w}&height=${h}&nologo=true&model=${encodeURIComponent(model)}&seed=${seed}&referrer=qqbot`,
      headers: {},
      body: undefined,
    };
  }
  if (provider === "openai") {
    const base = String(CFG.imageGenBaseUrl || IMAGE_GEN_DEFAULT_BASE.openai).replace(/\/+$/, "");
    return {
      kind: "post",
      url: `${base}/images/generations`,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CFG.imageGenKey}`,
      },
      body: JSON.stringify({
        model: CFG.imageGenModel || "Kwai-Kolors/Kolors",
        prompt,
        n: 1,
        size,
        response_format: "b64_json",
      }),
    };
  }
  throw new Error(`生图 provider 不支持：${provider}`);
}

/** 从模型回复里剥出 [[画:描述]]，一次最多一张 */
function extractDrawRequest(reply) {
  const text = String(reply ?? "");
  // 全局剥离：模型偶尔会写两个标记，只画第一张，但残留的标记不能发出去。
  const re = /\[\[\s*(?:画|draw|image)\s*[:：]\s*([\s\S]{1,400}?)\s*\]\]/gi;
  const prompts = [];
  const cleaned = text
    .replace(re, (_, p) => {
      prompts.push(String(p).trim());
      return "";
    })
    .trim();
  return { cleaned, prompt: prompts.find(Boolean) ?? "" };
}

/** 老大是不是在要她本人的形象（而不是让她画别的东西） */
function isSelfPortraitRequest(text) {
  const s = String(text ?? "");
  if (/自画像|selfie|self[- ]?portrait/i.test(s)) return true;
  if (/^(你)?自己$/.test(s.trim())) return true;
  if (/(画|生成|来|发)[^，。,.!?！？]{0,3}个?自己(?!的)/.test(s)) return true;
  if (/(你|您)(自己)?(的)?(形象|样子|长相|模样|照片|自拍|画像|外观)/.test(s)) return true;
  if (/(发|来|给|整)[^，。,.!?！？]{0,4}自拍/.test(s) || /^自拍[照]?$/.test(s.trim())) return true;
  if (/(画|生成|发|来|整)(一?[张个下])?(你自己|你本人)/.test(s)) return true;
  if (/你(自己)?(长|是)(什么|啥)(样|样子|模样)/.test(s)) return true;
  return false;
}

/** 老大是不是在说「换一张 / 再来一张」这类续画请求（本身不含「你」，要结合上一张判断） */
function isFollowUpImageRequest(text) {
  const s = String(text ?? "").trim();
  if (/别的|其他|另一个/.test(s)) return false;
  return /^(再|换|重|另|新)[^，。,.!?！？]{0,6}(图|照片|自拍|形象|姿势|张)/.test(s);
}

// 上一张发的是不是她本人的标准照。「再画一张」不带「你」，
// 只能靠这个上下文判断；超过 10 分钟就当她换了话题。
const SELF_PORTRAIT_FOLLOWUP_MS = 10 * 60_000;
const lastSelfPortraitAt = new Map();

function markSelfPortrait(t) {
  lastSelfPortraitAt.set(targetKey(t), Date.now());
}

function hasRecentSelfPortrait(t) {
  return Date.now() - (lastSelfPortraitAt.get(targetKey(t)) ?? 0) < SELF_PORTRAIT_FOLLOWUP_MS;
}

/** 纯函数：这张画走固定标准照，还是按模型描述自由出图 */
function planDraw(userText, modelPrompt, opts = {}) {
  const asked = String(modelPrompt ?? "").trim();
  const self =
    isSelfPortraitRequest(userText) ||
    /^(自画像|self[- ]?portrait|我自己|你自己)$/i.test(asked) ||
    (opts.afterSelfPortrait === true && isFollowUpImageRequest(userText));
  return self
    ? { self: true, prompt: SELF_PORTRAIT_PROMPT, seed: SELF_PORTRAIT_SEED, canonical: true }
    : { self: false, prompt: asked, seed: undefined, canonical: false };
}

function imageGenErrText(body) {
  try {
    const j = JSON.parse(body);
    return String(j?.error?.message || j?.message || j?.error || body).slice(0, 200);
  } catch {
    return String(body || "").replace(/\s+/g, " ").slice(0, 200);
  }
}

function noteImageGenFailure(e) {
  const msg = String(e?.message || e);
  imageGenLastError = msg.slice(0, 300);
  const minutes = /401|403|unauthorized|invalid.*key/i.test(msg)
    ? 30
    : /402|429|free_limit|rate/i.test(msg)
      ? 5
      : 2;
  imageGenDownUntil = Date.now() + minutes * 60_000;
  logErr(`[draw] 进入冷却 ${minutes} 分钟：${msg.slice(0, 200)}`);
}

/**
 * 用系统 curl 拉二进制（2026-10-26）。
 *
 * 为什么不走 fetch：这台 ECS 只有 IPv4 出口，DNS 返回 AAAA 时 Node fetch 会先试
 * IPv6 直接 ETIMEDOUT（实测同一条 pollinations 链接：Node fetch 607ms 超时，
 * curl 200 / 7~9 秒出图）。curl 自己会回退 IPv4，所以出图交给 curl。
 * 出图本来就要十几秒，多一次进程开销可以忽略。
 */
function curlToFile(url, { outPath, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const args = [
      "-sS",
      "-L",
      "--max-time",
      String(Math.max(1, Math.ceil(timeoutMs / 1000))),
      "-A",
      "Mozilla/5.0 (compatible; qqbot-imagegen)",
      "-o",
      outPath,
      "-w",
      "%{http_code}",
      "--",
      url,
    ];
    const child = spawn("curl", args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => {
      try {
        unlinkSync(outPath);
      } catch {}
      reject(new Error(`curl 启动失败：${String(e.message).slice(0, 120)}`));
    });
    child.on("close", (code, signal) => {
      let body = Buffer.alloc(0);
      try {
        if (existsSync(outPath)) body = readFileSync(outPath);
      } catch {}
      try {
        unlinkSync(outPath);
      } catch {}
      if (code !== 0) {
        reject(
          new Error(
            `curl 退出码 ${code}${signal ? `/${signal}` : ""}${stderr.trim() ? `：${stderr.trim().slice(0, 160)}` : ""}`
          )
        );
        return;
      }
      const status = Number(stdout.trim()) || 0;
      if (!status) {
        reject(new Error("curl 没拿到 HTTP 状态码"));
        return;
      }
      resolve({ status, body });
    });
  });
}

/** 统一的落盘：按文件头定格式、改名、清理旧图 */
function saveGeneratedImage(buf) {
  const ext = sniffBufExt(buf);
  if (!ext) throw new Error("返回内容不是图片");
  mkdirSync(CFG.imageDir, { recursive: true });
  const dest = join(
    CFG.imageDir,
    `gen-${Date.now()}-${Math.floor(Math.random() * 1e6)}${ext}`
  );
  writeFileSync(dest, buf);
  pruneImages();
  return { path: dest, provider: CFG.imageGenProvider, model: CFG.imageGenModel || "" };
}

/**
 * pollinations：curl 传输 + 45 秒额度排队。
 * 服务端 503 带 `retry after 10s`，但免 key 额度是 1 张/45 秒/IP，
 * 10 秒后重试只会再撞一次 503（2026-10-26 实测），所以重试间隔至少 45 秒。
 */
async function generateImagePollinations(req) {
  const wait = Math.max(0, pollinationsNextAt - Date.now());
  if (wait > 0) {
    log(`[draw] 免费额度排队 ${Math.ceil(wait / 1000)}s`);
    await sleep(wait);
  }

  const tries = 3;
  let lastStatus = 0;
  let lastText = "";
  for (let attempt = 0; attempt < tries; attempt++) {
    pollinationsNextAt = Date.now() + CFG.imageGenMinGapMs;
    mkdirSync(CFG.imageDir, { recursive: true });
    const tmp = join(CFG.imageDir, `.curl-gen-${Date.now()}-${attempt}.tmp`);

    let got = null;
    try {
      got = await curlToFile(req.url, { outPath: tmp, timeoutMs: CFG.imageGenTimeoutMs });
    } catch (e) {
      if (attempt === tries - 1) throw e;
      log(
        `[draw] pollinations 网络失败：${String(e.message).slice(0, 160)}，${Math.ceil(CFG.imageGenMinGapMs / 1000)}s 后重试`
      );
      await sleep(CFG.imageGenMinGapMs);
      continue;
    }

    if (got.status >= 200 && got.status < 300) return saveGeneratedImage(got.body);

    lastStatus = got.status;
    lastText = got.body.toString("utf8").slice(0, 400);
    const retryAfter = Number((lastText.match(/retry after\s+(\d+)\s*s/i) || [])[1] || 0);
    const retryable = [402, 429, 503].includes(got.status);
    if (!retryable || attempt === tries - 1) break;
    const waitMs = Math.min(70_000, Math.max(retryAfter * 1000, CFG.imageGenMinGapMs));
    log(`[draw] pollinations HTTP ${got.status}，${Math.ceil(waitMs / 1000)}s 后重试`);
    await sleep(waitMs);
  }

  throw new Error(`HTTP ${lastStatus || "?"}: ${imageGenErrText(lastText)}`);
}

/**
 * 生成一张图，写入 .run/img，返回本地路径。
 * pollinations 走 curl（见 curlToFile）；openai 兼容走 fetch。
 */
async function generateImage(prompt, opts = {}) {
  if (!imageGenConfigured()) throw new Error("生图未配置");
  const req = buildImageGenRequest(prompt, opts);

  if (CFG.imageGenProvider === "pollinations") return generateImagePollinations(req);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CFG.imageGenTimeoutMs);
  try {
    const res = await fetch(req.url, {
      method: req.kind === "get" ? "GET" : "POST",
      headers: req.headers,
      body: req.body,
      signal: ac.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${imageGenErrText(text)}`);
    }

    const ct = String(res.headers.get("content-type") || "");
    let buf;
    if (ct.startsWith("image/")) {
      buf = Buffer.from(await res.arrayBuffer());
    } else {
      const j = await res.json().catch(() => null);
      const item =
        j?.data?.[0] ??
        j?.images?.[0] ??
        j?.result?.images?.[0] ??
        j?.output?.results?.[0] ??
        null;
      const b64 = item?.b64_json || item?.b64 || j?.b64_json;
      if (b64) {
        buf = Buffer.from(b64, "base64");
      } else {
        const url = item?.url || j?.url || j?.data?.[0]?.url;
        if (!url) throw new Error(`返回里没有图片：${JSON.stringify(j).slice(0, 200)}`);
        const r2 = await fetch(url, { signal: ac.signal });
        if (!r2.ok) throw new Error(`下载生成图失败 HTTP ${r2.status}`);
        buf = Buffer.from(await r2.arrayBuffer());
      }
    }

    return saveGeneratedImage(buf);
  } finally {
    clearTimeout(timer);
  }
}

async function drawAndSend(target, prompt, opts = {}) {
  const tgt = normalizeTarget(target);
  if (opts.canonical) {
    const list = listSelfPortraits();
    const image = pickSelfPortrait(tgt, list);
    if (image) {
      await sendImageTo(tgt, image, { quoteId: opts.quoteId });
      log(`[draw] 画自己 → ${basename(image)}（素材库 ${list.length} 张）`);
      return true;
    }
    log(`[draw] 标准照缺失：${SELF_PORTRAIT_IMAGE}，改用模板出图`);
  }
  if (!imageGenConfigured()) {
    if (opts.notifyFail) await sendTo(tgt, "画图服务还没配置，暂时画不了。", { noQuote: true });
    return false;
  }
  if (!imageGenReady()) {
    const left = Math.ceil(imageGenCooldownLeftMs() / 1000);
    if (opts.notifyFail) await sendTo(tgt, `画图服务刚被限流，${left} 秒后再试。`, { noQuote: true });
    return false;
  }

  log(`[draw] ${imageGenLabel()} ← ${String(prompt).slice(0, 120)}`);
  try {
    const r = await generateImage(prompt, opts);
    await sendImageTo(tgt, r.path, { quoteId: opts.quoteId });
    log(`[draw] 完成 ${basename(r.path)} (${statSync(r.path).size} 字节)`);
    return true;
  } catch (e) {
    noteImageGenFailure(e);
    const cause = e?.cause?.code || e?.cause?.message || "";
    logErr(
      `[draw] 失败：${String(e.message).slice(0, 300)}${cause ? `（${String(cause).slice(0, 120)}）` : ""}`
    );
    if (opts.notifyFail) await sendTo(tgt, "图没画出来，等会儿再试。", { noQuote: true });
    return false;
  }
}

/**
 * 出图专用串行队列（2026-10-26）。
 *
 * 为什么不直接 await：出图要几十秒到两三分钟，放在聊天队列里会把
 * 之后所有私聊/群消息全堵住。文字先送达，出图在后台排队；
 * 串行是为了不并发抢 Pollinations 的 45 秒/IP 额度。
 */
let drawChain = Promise.resolve();
function enqueueDraw(fn) {
  drawChain = drawChain.then(fn).catch((e) => logErr(`[draw] 队列失败：${String(e?.message || e).slice(0, 200)}`));
  return drawChain;
}

// ── QQ 指令：#模型 / #帮助 ──────────────────────────────────────────────
const COMMAND_WORDS = new Set([
  "模型", "model", "帮助", "help", "状态", "status", "日记", "diary",
  "语音", "voice", "唱歌", "sing", "生图", "画图", "draw", "群聊", "group",
  // 2026-10-26：手动翻旧账。她自动检索（recallFromChatLog）命中不到时，
  // 老大可以自己指关键词；也用来验证「到底存了什么」。
  "回忆", "recall",
  // 2026-10-26：周回顾。自动每周写一篇；这条指令用来手动补写或当场看。
  "周记", "weekly",
]);

/**
 * 解析 QQ 指令。
 *
 * 为什么不用「按空白切第一个词」那种写法：
 *   2026-10-18 实测，老大发了 `#模型provider:workbuddy/step-5-preview`（没加空格），
 *   旧正则把整串当成指令词 → 不认识 → 落到聊天分支 → 白烧一次 429。
 *   指令是给人打的，不能要求人记住「必须加空格」。
 *
 * 现在的做法：剥掉 `#` 之后，按**已知指令词**做前缀匹配（长的优先），
 * 剩下的一律当参数。这样 `#模型` `#模型xxx` `#模型 xxx` 都能识别。
 *
 * 边界规则（避免把 `#模型们` 误判成 `#模型`）：
 *   中文词后面直接跟中文 → 不是指令（`模型们` 是一个词）；
 *   中文词后面跟 `:` `/` `e` 等参数起始字符 → 是指令。
 *   英文词（model/help/status）后面直接跟字母 → 不是指令（`modelx`），
 *   跟数字/符号/中文 → 是指令。
 */
function parseCommand(text) {
  const m = String(text).trim().match(/^[#＃]\s*([\s\S]+)$/);
  if (!m) return null;

  const body = m[1].trim();
  if (!body) return null;
  const lower = body.toLowerCase();

  // 2026-10-22 审计修复（F-02）：无空格粘连的语音开关特判。
  // 「#语音关闭」「#语音开」按 CJK 粘连规则会被当成更长的词而漏识别，
  // 落进 LLM 烧一次积分后才被 wantsNoVoice 兜住。语音开关词表有限，直接认。
  const voiceGlue = lower.match(/^语音(关闭|关掉|关了|关一下|静音|开启|打开|恢复|停|关|开)$/);
  if (voiceGlue) return { word: "语音", arg: voiceGlue[1] };

  const words = [...COMMAND_WORDS].sort((a, b) => b.length - a.length);

  for (const w of words) {
    if (!lower.startsWith(w)) continue;
    const rest = body.slice(w.length);
    if (!rest) return { word: w, arg: "" };

    const isCjk = (ch) => /[\u4e00-\u9fa5]/.test(ch);
    const isAsciiAlpha = (ch) => /[A-Za-z]/.test(ch);
    const head = rest[0];

    // 中文词 + 紧跟中文 → 是一个更长的词，不是指令
    if (isCjk(w[0]) && isCjk(head)) continue;
    // 英文词 + 紧跟字母 → 是更长的词，不是指令
    if (isAsciiAlpha(w[0]) && isAsciiAlpha(head)) continue;

    return { word: w, arg: rest.trim() };
  }
  return null;
}

/**
 * 「我要听稻香」这类自然点歌，不带 # 前缀。
 * 返回 { arg: 歌名 }；不是这个句式返回 null。空歌名也算命中（给歌单）。
 */
function parseSongRequest(text) {
  const t = String(text).trim();
  let m = t.match(/^我要听\s*(?:一下)?\s*([\s\S]{0,60})$/);
  if (!m) m = t.match(/^(?:唱|翻唱)(?:一首|首|一曲|一下|个)?\s*[《「"']?([\s\S]{1,40}?)[》」"']?$/);
  if (!m) m = t.match(/^(?:点歌|来一首|点一首)\s*[《「"']?([\s\S]{1,40}?)[》」"']?$/);
  if (!m) return null;
  let arg = m[1].trim();
  arg = arg
    .replace(/^[《「"'\s]+/, "")
    .replace(/[》」"'。！!？?，,、\s]+$/, "")
    .replace(/[吧呀啊嘛呗哦~～]+$/, "")
    .replace(/[《》「」"']/g, "")
    .trim();
  if (/^(歌|首歌|个歌|一首歌)$/.test(arg)) arg = "歌";
  if (/^[得了过着完好]/.test(arg)) return null;
  return { arg };
}

// ── 聊天流水（写日记要素材，内存里的 histories 一重启就没了）─────────────
// 每天一个 .run/chatlog-YYYY-MM-DD.jsonl，一行一条。
//
// 2026-10-26：保留期 7 天 → 90 天。
// 起因：拿服务器 8 天真实语料量化过「当前注入链能看见多少」——
//   HISTORY_TURNS=12 / 36h 窗口只覆盖 24 条，**97.1%（814/838）的消息模型永远看不见**。
//   问「晚课说了什么」这种，全靠日记里二手一句；再早一点就只能答「忘了」。
// 而全文一共才 1.6 万字（≈1.07 万 token），根本不存在存不下的问题。
// 所以真正要修的不是「压缩」，是「让旧的原话能被按需捞回来」（见 #回忆）。
// 磁盘代价：一天约 2 万字节，90 天 ≈ 1.8 MB，相比 .run 里现有的 20 MB 可忽略。
const CHATLOG_KEEP_DAYS = Number(process.env.CHATLOG_KEEP_DAYS ?? 90);

function chatlogPath() {
  return join(RUN_DIR, `chatlog-${dayKey(new Date())}.jsonl`);
}

/** 记一条（role: user / assistant）。失败不影响主流程，静默吞掉。 */
function appendChatLog(userId, role, content) {
  const text = String(content ?? "").trim();
  if (!text) return;
  try {
    mkdirSync(RUN_DIR, { recursive: true });
    appendFileSync(chatlogPath(), JSON.stringify({ t: Date.now(), userId, role, content: text.slice(0, 800) }) + "\n", "utf8");
  } catch {}
}

/**
 * 读某一天的流水（最近 limit 条）。坏行跳过，不抛。
 *
 * 2026-10-21 20:0x 从 readTodayChatLog 拆出来：跨重启恢复要读**昨天**那份。
 */
function readChatLogOf(day, limit = 200, path = join(RUN_DIR, `chatlog-${day}.jsonl`)) {
  try {
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    return lines
      .slice(-limit)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** 读今天的流水（最近 limit 条），写日记时当素材 */
function readTodayChatLog(limit = 30) {
  return readChatLogOf(dayKey(new Date()), limit);
}

// ── 按需检索旧流水（2026-10-26 新增）─────────────────────────────────────
// 为什么要有这一段（这是本轮最重要的一处改动，依据是量化过的）：
//   拿服务器 8 天真实语料算过：HISTORY_TURNS=12 / 36h 的窗口只覆盖 24 条消息，
//   **814/838 = 97.1% 的对话模型永远看不见**。于是「晚课说了什么」这类问题
//   只能靠日记里的二手一句，再早一点就只能答「忘了」。
//
// 为什么不学「大肥鱼」上 512 维向量 + PageRank 扩散：
//   8 天全文 16059 字 ≈ 1.07 万 token，一天才 1338 token。这个量级下
//   **原文全捞回来比向量近似更准**，而且 chatlog 里本来就同时有「老大说的」和「我说的」，
//   语义检索反而会把「意思相近但日期不同」的两句混起来。
//   向量要额外一次 API 调用（每条一次 embedding），成本和不确定性都不划算。
//
// 所以这里做的是「词法按需检索」：只在这一轮真正问到旧事时，把命中的原话捞几条出来。
// 零模型调用、零依赖、可离线单测；捞不到就什么都不加（绝不编）。
const RECALL_STOP = new Set([
  "什么", "怎么", "为什么", "那个", "这个", "我们", "你们", "他们", "她们", "是不", "不是",
  "有没", "可以", "现在", "今天", "刚才", "一下", "还是", "就是", "真的", "知道", "记得",
  "说过", "上次", "以前", "昨天", "那天", "时候", "东西", "事情", "你还", "我说", "你说",
  "了吗", "了吗", "多少", "哪里", "哪个", "这样", "那样", "然后", "因为", "所以", "但是",
]);

/**
 * 从一句提问里抽可检索的词（中文 2~4 字滑窗，英文按单词），去掉高频虚词。
 *
 * 2026-10-26 P1 精度改造（有实测，见 .run/p1-recall-precision3.mjs）：
 * 现状在生产语料上 precision 只有 **82.1%**，噪音源查清了两类：
 *   ① 「说了(df=13) / 了没(df=8) / 说的(df=33)」—— 虚字结尾的双字碎片，纯噪音
 *   ② 「课说 / 子买」—— 跨词边界碎片，df=1，偶然撞上就多带一行无关
 * 改法（V5，实测 precision 82.1% → 100%，召回不归零）：
 *   F1 虚字过滤，但**只在 df>=5 时才丢**。第一版一票否决（`if (FUNC.test(t)) return false`）
 *      把「总是」直接吃没了 —— 因为「是」被当虚字。全丢光的召回损失比留点噪音更糟。
 *   F2 可信词：df=0 丢；df=1 且只有 2 字也丢（偶然碎片），但 3 字以上的长词 df=1 可信。
 *   F3 兜底：过滤后一个词都不剩时，退回「df 最小且最长」的 2 个 —— **绝不返回空**。
 *   F4 打分加 idf 权重；命中里若有更长且包含当前词的，短词不重复计分（长词覆盖）。
 */
function recallTokens(text) {
  const out = new Set();
  const t = String(text ?? "");
  for (const m of t.matchAll(/[A-Za-z][A-Za-z0-9_+-]{1,}/g)) {
    const w = m[0].toLowerCase();
    if (!RECALL_STOP.has(w) && w.length >= 2) out.add(w);
  }
  // 先削掉虚词短语，避免「你还」「了吗」这类滑窗污染
  const s = t.replace(/(记得|说过|什么|怎么|为什么|那个|这个|是不是|有没有|你还|我说|你说)/g, " ");
  for (const m of s.matchAll(/[\u4e00-\u9fa5]{2,}/g)) {
    const run = m[0];
    // 整段太长时只靠滑窗；短段额外把整段也当候选（「晚课」这种 2 字词才不会被切开）
    if (run.length <= 4 && !RECALL_STOP.has(run)) out.add(run);
    for (let i = 0; i + 2 <= run.length; i++) {
      const bg = run.slice(i, i + 2);
      if (!RECALL_STOP.has(bg)) out.add(bg);
    }
  }
  return [...out];
}

// 虚字：出现在双字词里基本就是跨词边界的碎片。
// ⚠️ 刻意**不含「是」** —— 加了它「总是 / 不是」这类真词会被吃掉（实测召回直接归零）。
const RECALL_FUNC_CHAR = /[的了着在吗呢吧啊嘛哦呀么]/;
const RECALL_FUNC_DF_MIN = 5; // 只有够常见（df>=5）的碎片才值得丢；低频的可能是真词

/** 给一组候选词打分用的 df（出现行数）查询器；由 recallFromChatLog 注入，便于单测 */
function makeDfFn(rows) {
  const cache = new Map();
  return (tok) => {
    if (cache.has(tok)) return cache.get(tok);
    let n = 0;
    for (const r of rows) if (r.text.includes(tok)) n++;
    cache.set(tok, n);
    return n;
  };
}

/** 按 F1~F3 过滤候选词。dfFn 提供词频；返回可信词（可以为空，见 F3） */
function selectRecallTokens(tokens, dfFn) {
  const kept = [];
  const soft = []; // 只因「df=1 且太短」被拒的词：它们是内容词，兜底时可以救回来
  const hard = []; // 虚字碎片 / 语料里没有 / 停用词：兜底时也不许回来
  for (const tok of tokens) {
    if (RECALL_STOP.has(tok)) { hard.push(tok); continue; }
    const df = dfFn(tok);
    if (df === 0) { hard.push(tok); continue; }
    // F1 虚字碎片：含 的/了/着/在/吗/呢/吧/啊/嘛/哦/呀/么 的一律是噪音。
    // ⚠️ 这条最初写成「只在 df>=5 时才丢」（怕误杀低频真词），实测不够：
    //    「了没」「买了」df 都很低，仍被兜底救回来，注入的全是噪音。
    //    虚字碎片是**结构问题**不是频率问题，所以现在不问 df，一律 hard。
    //    （「是」刻意不在集合里：「总是/不是」是真词，加了它召回直接归零。）
    if (RECALL_FUNC_CHAR.test(tok)) { hard.push(tok); continue; }
    if (df === 1 && tok.length < 3) { soft.push(tok); continue; } // F2 跨词边界短碎片，可救
    kept.push(tok);
  }
  if (kept.length) return kept;

  // F3 兜底：宁可带点噪音，也不能整段不注入（召回损失比噪音更糟）。
  // ⚠️ 但**只从 soft 里救**，绝不把 hard 的词放回来 ——
  //    第一版兜底从「所有 df>0」里挑，实测把刚过滤掉的「说了/课说」原样还魂
  //    （selftest 当场红两条），等于 F1 整条规则作废。
  //    连 soft 都没有 → 老实返回空：那种 query 没有内容词，注入的必然全是噪音。
  return soft.sort((a, b) => dfFn(a) - dfFn(b) || b.length - a.length).slice(0, 2);
}

/** 一行里命中了哪些可信词（长词覆盖短词：命中更长且包含当前词的，短词让位） */
function recallHitTokens(text, useful) {
  const hit = useful.filter((tok) => text.includes(tok));
  return hit.filter((tok) => !hit.some((o) => o !== tok && o.includes(tok)));
}

/** 单个可信词的权重：idf × 长度增益（长词更具体，稀有词更值钱） */
function recallTokenWeight(tok, df, total) {
  return (1 + Math.log(1 + tok.length)) * Math.log((total + 1) / (df + 1));
}

/**
 * 注入门槛：捞到几条才允许进 prompt。
 *
 * 为什么是 2 而不是 1（这是真实翻车模式，不是保守）：
 * 只捞到 1 条时，模型会以那一条为全部真相去回答，比「记不清」更糟——
 * 她曾靠日记里一句二手「买个包子」答出「记得，包子买了没」，看着像记得，
 * 实际是拿半句顶替整段。所以把门槛抽成函数，方便单测钉死。
 */
const RECALL_MIN_LINES = 2;
function recallInjectable(rc) {
  return Boolean(rc && Array.isArray(rc.lines) && rc.lines.length >= RECALL_MIN_LINES);
}

/**
 * 是否允许在**这一轮**捞旧原话。
 *
 * 抽成函数是因为：第一版把条件写成 `if (!isGroup && CFG.recallEnabled)`，
 * 而 selftest 里那条「群聊 prompt 不含旧原话段」**恒为真** ——
 * 单测用的是空 RUN_DIR，本来就没有 chatlog 可捞，群/私聊都捞不到东西，
 * 于是无论要不要拦，断言都过（做变异测试时把 !isGroup 删掉，443/443 照样全过）。
 * 判据测不出差别 = 没有判据。所以这里显式暴露一个可被单测直接钉死的谓词。
 *
 * 2026-10-26 加「句式闸门」（有实测依据，不是拍脑袋）：
 *   拿服务器 8 天生产语料、把老大说过的 295 句全当 query 跑过一遍：
 *     只按词法命中就注入 → 日常闲聊误报 **275/289 = 95.2%**
 *     （「才下午啊」「嘿嘿嘿」「大肥鱼！」都会被捞出一堆旧话灌进 prompt）
 *   加句式闸门后 → 误报 **2/289 = 0.7%**，而真正问旧事的 6 句召回不变（5/6 = 83.3%）。
 *   ⇒ 所以「该不该捞」不能只看有没有命中词，必须先看她是不是真的在问过去。
 */
const RECALL_GATE = /(你还记得|记不记得|不记得|记得.{0,8}(吗|么|什么|哪)|说过|上次|上回|之前|以前|昨天|前天|那天|那次|当时|曾经|前几|那会儿|哪一天|哪天)/;

function recallAllowed(isGroup, text = "") {
  if (isGroup) return false; // 群里有陌生人，私聊原文绝不进群 prompt
  if (!CFG.recallEnabled) return false;
  return RECALL_GATE.test(String(text ?? ""));
}

/**
 * 在旧流水里按词法捞相关原话。
 * @returns {{lines:string[], tokens:string[], used:number, scanned:number}}
 */
function recallFromChatLog(query, opts = {}) {
  const daysBack = Math.max(1, opts.daysBack ?? 90);
  const limit = Math.max(1, opts.limit ?? 8);
  const now = opts.now ?? Date.now();
  const readDay = opts.readDay ?? readChatLogOf;
  const userId = opts.userId ?? null;
  // 注：maxDf 这个「命中超过 N 行就丢」的老参数已废弃 —— 它按**绝对行数**卡，
  // 而合理门槛应该按**占比**（语料越长，同一个词的自然出现次数越高）。
  // 现在一律走 selectRecallTokens 的 df 相对判断，这里不再读 maxDf。

  const dayKeys = [];
  for (let i = 0; i < daysBack; i++) dayKeys.push(dayKey(new Date(now - i * 864e5)));

  const rows = [];
  for (const d of dayKeys) {
    for (const r of readDay(d, 5000)) {
      const text = String(r.content ?? "");
      if (!text) continue;
      if (userId != null && Number(r.userId) !== Number(userId)) continue;
      rows.push({ day: d, t: Number(r.t) || 0, role: r.role, text });
    }
  }

  const tokens = recallTokens(query);
  if (!tokens.length || !rows.length) {
    return { lines: [], tokens, used: 0, scanned: rows.length };
  }

  // 词频 → 可信词（F1~F3 见 selectRecallTokens 的注释）
  const dfFn = makeDfFn(rows);
  const total = rows.length;
  const useful = selectRecallTokens(tokens, dfFn);
  if (!useful.length) return { lines: [], tokens, used: 0, scanned: rows.length };

  const scored = [];
  for (const r of rows) {
    const hit = recallHitTokens(r.text, useful);
    if (!hit.length) continue;
    let s = 0;
    for (const tok of hit) s += recallTokenWeight(tok, dfFn(tok), total);
    if (s > 0) scored.push({ ...r, score: s });
  }
  scored.sort((a, b) => b.score - a.score || b.t - a.t);

  // 每条只截一段，避免把长合并转发整段灌进来
  const lines = [];
  const seen = new Set();
  for (const r of scored) {
    if (lines.length >= limit) break;
    const key = r.text.slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);
    const who = r.role === "user" ? "老大" : "我";
    const body = r.text.length > 120 ? `${r.text.slice(0, 120)}…` : r.text;
    lines.push({ day: r.day, line: `${r.day} ${who}：${body}`, t: r.t });
  }
  lines.sort((a, b) => a.t - b.t);
  return { lines: lines.map((x) => x.line), tokens: useful, used: lines.length, scanned: rows.length };
}

/**
 * 最近她自己主动发过的话 / 发过的说说（防重复用）。
 * 为什么查 chatlog 而不是内存：主动消息不保证进 histories，
 * 重启前后都要看到同一份「我说过什么」。
 */
function recentSelfPosts(tag, limit = 3, days = 3) {
  const out = [];
  const now = Date.now();
  for (let i = 0; i < days; i++) {
    const d = dayKey(new Date(now - i * 864e5));
    for (const r of readChatLogOf(d, 500)) {
      if (r.role !== "assistant") continue;
      const c = String(r.content ?? "");
      if (!c.startsWith(tag)) continue;
      out.push({ t: Number(r.t) || 0, content: c.slice(tag.length).trim() });
    }
  }
  out.sort((a, b) => a.t - b.t);
  return out.slice(-limit);
}

// ── 跨重启记忆（2026-10-21 19:2x）───────────────────────────────────────
// 设计取舍（PLAN-histories.md 第 2.1 节）：**不再写一份 hist-<uid>.json**。
// 两份历史必然分叉：一份是启动时恢复的、一份是运行时写的，迟早对不上。
// chatlog 已经是「一条一行 + 时间戳 + 实时 append」，直接当唯一真相：
//   - 运行时：histories 照旧在内存跑，appendChatLog 照旧落盘 → 零新增写路径
//   - 启动时：从这里读回近窗 → 只读，幂等，重启多少次结果一样

const PROACTIVE_TAG = "（我主动找老大说的）";
const QZONE_TAG = "（我在空间发了条说说）";

/** 恢复选项 -> 真实历史条目。返回 null 表示这条不该进上下文 */
function cleanHistContent(role, content) {
  const s = String(content ?? "");
  if (role === "assistant") {
    // 说说跟「对话」无关，混进去她会以为自己跟我说过那句
    if (s.startsWith(QZONE_TAG)) return null;
    // 主动开口是她自己说的话，保留内容，只剥掉记账前缀
    if (s.startsWith(PROACTIVE_TAG)) return s.slice(PROACTIVE_TAG.length).trim() || null;
  }
  return s;
}

/**
 * 从 chatlog 恢复某人的近窗历史。
 *
 * 两道闸门（都是必要的）：
 *   ① 条数：默认 12 条，和运行时 slice(-historyTurns*2) 一致，不偷偷放大上下文
 *   ② 时间：只要 HISTORY_RESTORE_HOURS（默认 12h）以内的。
 *      昨晚 23:40 聊完、今早 9:00 启动 → 9.3h，能续上；
 *      三天没聊 → 原文一条都不进，只靠日记。
 *
 * opts 全是为了能单测：不传就用生产默认（真实 RUN_DIR、真实 now）。
 */
function loadRecentHistory(userId, opts = {}) {
  const now = opts.now ?? Date.now();
  const msgs = Math.max(0, opts.msgs ?? CFG.historyRestoreMsgs);
  const hours = Math.max(0, opts.hours ?? CFG.historyRestoreHours);
  const readDay = opts.readDay ?? readChatLogOf;
  const days = opts.days ?? [dayKey(new Date(now)), dayKey(new Date(now - 864e5))];

  const cutoff = now - hours * 3600 * 1000;
  const rows = [];
  for (const d of days) {
    for (const r of readDay(d, 500)) {
      if (Number(r.userId) !== Number(userId)) continue;
      if (typeof r.t !== "number" || r.t < cutoff || r.t > now) continue;
      const c = cleanHistContent(r.role, r.content);
      if (!c) continue;
      rows.push({ t: r.t, role: r.role, content: c });
    }
  }
  rows.sort((a, b) => a.t - b.t);

  const picked = rows.slice(-msgs);
  // 掐掉开头的 assistant：窗口是从「最后 12 条」切的，很容易切在一个回合中间，
  // 第一句变成「我：……」，模型会以为自己在自言自语。历史从老大那句起才干净。
  while (picked.length && picked[0].role === "assistant") picked.shift();

  const since = picked.length ? dayKey(new Date(picked[0].t)) : null;
  return {
    // 2026-10-22：把 t 一起带出来。恢复的历史同样要能判断「隔了多久」，
    // 否则重启后间隔标注消失，她就把昨晚的话当成刚说的。
    hist: picked.map(({ role, content, t }) => ({ role, content, ts: t })),
    since,
    crossDay: picked.length ? since !== dayKey(new Date(now)) : false,
  };
}

/**
 * 恢复的原文起始日（仅跨天时记）。
 *
 * 为什么不给每条历史加时间戳：token 不划算，也容易把正文淹掉。
 * 只在 prompt 里加**一句**分段说明就够 —— 但必须有，否则她会把昨晚的话
 * 当成「他刚说的」，答非所问。
 */
const historySince = new Map();

/** 启动时给白名单里的人灌一次历史；读失败就当没有，绝不影响启动 */
function restoreHistories() {
  const diary = CFG.diaryInPrompt ? latestDiaryBefore() : null;
  for (const uid of CFG.allowFrom) {
    try {
      const r = CFG.historyRestore ? loadRecentHistory(uid) : { hist: [], crossDay: false, since: null };
      if (r.hist.length) {
        histories.set(uid, r.hist);
        if (r.crossDay) historySince.set(uid, r.since);
      }
      log(
        `[hist] ${uid} 恢复 ${r.hist.length} 条${
          r.crossDay ? `（跨天，自 ${r.since}）` : ""
        }；日记 ${diary ? `${diary.text.length} 字（${diary.day}）` : "无"}`
      );
    } catch (e) {
      logErr(`[hist] ${uid} 恢复失败（当没有处理）：${String(e.message).slice(0, 120)}`);
    }
  }
}

/**
 * 最近一篇「不是今天的」日记，当昨日摘要用。
 *
 * 为什么要排除今天：今天的日记是今晚才写的，而且内容就是今天的事，
 * 已经体现在「最近对话」里了，重复注入只会让她两次说同一件事。
 * 返回 { text, day } 或 null；超长按 CFG.diaryPromptChars 截断。
 */
function latestDiaryBefore(today = dayKey(new Date()), dir = DIARY_DIR, chars = CFG.diaryPromptChars) {
  try {
    const files = readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .map((f) => f.slice(0, 10))
      .filter((d) => d < today)
      .sort()
      .reverse();
    if (!files.length) return null;
    const day = files[0];
    const raw = readFileSyncSafe(join(dir, `${day}.md`)).trim();
    if (!raw) return null;
    const limit = Math.max(80, chars);
    const text = raw.length > limit ? `${raw.slice(0, limit)}…（后面略）` : raw;
    return { text, day };
  } catch {
    return null;
  }
}

/** 清掉 7 天前的流水 */
function pruneChatLog() {
  try {
    const cutoff = Date.now() - CHATLOG_KEEP_DAYS * 24 * 3600 * 1000;
    for (const f of readdirSync(RUN_DIR)) {
      const m = f.match(/^chatlog-(\d{4})-(\d{2})-(\d{2})\.jsonl$/);
      if (!m) continue;
      const t = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`).getTime();
      if (t < cutoff) {
        try {
          unlinkSync(join(RUN_DIR, f));
        } catch {}
      }
    }
  } catch {}
}

// ── 收歌换声（2026-10-25）────────────────────────────────────────────────
// 服务器没有 GPU：这里只管「收下音频 → 写任务 → 等笔记本渲染完 → 发回 QQ」。
// 渲染在笔记本上跑（.run/svc/watch-inbox.mjs 轮询 svc-inbox/）。

/**
 * 把一条 record/file 段落的音频落到本地。
 * 来源按可靠性排：
 *   data.url      直接可下的直链
 *   data.path     NapCat 语音段附带的服务器本地路径（多为 silk，只作最后兜底）
 *   get_record    语音段：NapCat 侧转成 mp3 并直接给 base64（silk/amr 靠它）
 *   get_file      文件段：file 字段是文件名，NapCat 按名检索后下载
 */
async function fetchAudio(seg, userId) {
  const d = seg?.data ?? {};
  const rawName = String(d.file_name ?? d.file ?? d.path ?? `audio_${seg?.type ?? "bin"}`);
  const safe = rawName.replace(/[\\/:*?"<>|\r\n]/g, "_").slice(-60) || "audio.bin";
  mkdirSync(CFG.audioDir, { recursive: true });
  const dest = join(CFG.audioDir, `${Date.now()}_${userId}_${safe}`);
  const destMp3 = dest.replace(/\.[a-z0-9]{1,5}$/i, "") + ".mp3";

  let url = typeof d.url === "string" && /^https?:/i.test(d.url) ? d.url : null;
  let local = typeof d.path === "string" && isAbsolute(d.path) && existsSync(d.path) ? d.path : null;
  if (!local && typeof d.file === "string" && isAbsolute(d.file) && existsSync(d.file)) local = d.file;

  if (seg?.type === "record" && !url) {
    try {
      const r = await callApi("get_record", { file: d.file ?? d.file_id ?? "", out_format: "mp3" });
      log(`[audio] get_record → ${JSON.stringify({ file: r?.file, url: r?.url, b64: r?.base64?.length }).slice(0, 220)}`);
      if (typeof r?.base64 === "string" && r.base64) {
        writeFileSync(destMp3, Buffer.from(r.base64, "base64"));
        if (existsSync(destMp3) && statSync(destMp3).size > 0) return destMp3;
      }
      if (typeof r?.file === "string" && isAbsolute(r.file) && existsSync(r.file)) {
        copyFileSync(r.file, destMp3);
        return destMp3;
      }
      if (typeof r?.url === "string" && /^https?:/i.test(r.url)) url = r.url;
    } catch (e) {
      logErr(`[audio] get_record 失败: ${String(e.message).slice(0, 120)}`);
    }
  }

  if (!url && !local) {
    const fileId = d.file ?? d.file_name ?? d.file_id;
    if (fileId) {
      try {
        const r = await callApi("get_file", { file: fileId, file_id: d.file_id ?? "" });
        log(`[audio] get_file → ${JSON.stringify({ file: r?.file, url: r?.url, size: r?.file_size, b64: r?.base64?.length }).slice(0, 220)}`);
        if (typeof r?.url === "string" && /^https?:/i.test(r.url)) url = r.url;
        else if (typeof r?.file === "string" && isAbsolute(r.file) && existsSync(r.file)) local = r.file;
        else if (typeof r?.base64 === "string" && r.base64) {
          writeFileSync(dest, Buffer.from(r.base64, "base64"));
          if (existsSync(dest) && statSync(dest).size > 0) return dest;
        }
      } catch (e) {
        logErr(`[audio] get_file 失败: ${String(e.message).slice(0, 120)}`);
      }
    }
  }

  if (url) {
    try {
      execFileSync("curl", ["-sSL", "-o", dest, "--max-time", "300", "--retry", "2", "--retry-delay", "1", url], {
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch (e) {
      logErr(`[audio] curl 失败: ${String(e.message).slice(0, 120)}`);
    }
    if (existsSync(dest) && statSync(dest).size > 0) return dest;
  } else if (local) {
    copyFileSync(local, dest);
    return dest;
  }
  return null;
}

/** 音频落到 svc-inbox/<id>.<ext> + 同名 json，笔记本侧按 json 取活 */
function submitAudioJob(userId, audioPath) {
  mkdirSync(CFG.svcInboxDir, { recursive: true });
  const id = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
  const ext = (audioPath.match(/\.[a-z0-9]{1,5}$/i)?.[0] ?? ".bin").toLowerCase();
  const audio = join(CFG.svcInboxDir, `${id}${ext}`);
  copyFileSync(audioPath, audio);
  const job = { id, userId, audio: basename(audio), createdAt: new Date().toISOString() };
  writeFileSync(join(CFG.svcInboxDir, `${id}.json`), JSON.stringify(job, null, 2));
  return job;
}

/** 只给歌名：任务里没有音频，笔记本侧负责搜歌、下载、换声 */
function submitSongQueryJob(userId, query) {
  mkdirSync(CFG.svcInboxDir, { recursive: true });
  const id = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
  const job = { id, userId, query, createdAt: new Date().toISOString() };
  writeFileSync(join(CFG.svcInboxDir, `${id}.json`), JSON.stringify(job, null, 2));
  return job;
}

/** 收到音频后的整条动作：落盘 → 尺寸闸 → 写任务 → 回一句 */
async function runAudioJob(userId, segs) {
  log(`[audio] ${userId} 收到 ${segs.length} 段：${JSON.stringify(segs.map((s) => s?.data)).slice(0, 500)}`);
  const saved = [];
  for (const seg of segs) {
    const p = await fetchAudio(seg, userId);
    if (p) saved.push({ p, type: seg.type });
  }
  if (!saved.length) {
    logErr("[audio] 全部落盘失败");
    await sendPrivate(userId, "音频没接住，下载失败了，再发一次试试。");
    return;
  }
  const { p, type } = saved[0];
  const size = statSync(p).size;
  if (size > CFG.svcMaxBytes) {
    await sendPrivate(userId, `这个文件 ${(size / 1048576).toFixed(1)} MB，太大了，我这边处理不动。`);
    return;
  }
  const job = submitAudioJob(userId, p);
  log(`[audio] ${type} 落盘 ${p} (${size} 字节) → 任务 ${job.id}`);
  await sendPrivate(
    userId,
    type === "record" ? "收到语音，我拿去换成我的声音唱，几分钟后发回来。" : "收到，我拿去唱，几分钟后发回来。"
  );
}

// ── 语音条当聊天（2026-10-25）────────────────────────────────────────────
// 语音条走聊天，不再进换声队列。转写优先用 QQ 自带的 fetch_ptt_text，
// 拿不到再交给笔记本的 watch-asr.mjs（whisper-base）兜底。
const ASR_FAILED_TEXT = "这条语音我没转出文字，打字说给我听吧。";
const NATIVE_ASR_COOLDOWN_MS = 10 * 60 * 1000;
let nativeAsrCooldownUntil = 0;
/** @type {Map<string, {userId:number,extra:string,images:string[],stickerOnly:boolean,userTs:number,texts:string[],remaining:number,timer:any}>} */
const voiceGroups = new Map();

function classifyAudioSegs(segs) {
  const list = Array.isArray(segs) ? segs : [];
  return {
    records: list.filter((s) => s?.type === "record"),
    files: list.filter((s) => s?.type === "file"),
  };
}

/** 去掉 [语音]/[文件] 标记，只留老大同时打的字 */
function stripAudioMarkers(text) {
  return String(text ?? "").replace(/\[(语音|文件)\]/g, "").trim();
}

function mergeVoiceText(extra, transcript) {
  return [stripAudioMarkers(extra), String(transcript ?? "").trim()].filter(Boolean).join("\n");
}

async function fetchPttText(messageId) {
  const r = await callApi("fetch_ptt_text", { message_id: messageId });
  return typeof r?.text === "string" ? r.text.trim() : "";
}

/**
 * QQ 自带转写。NapCat 的 translatePtt2Text 拿不到结果时会挂到 baseTimeout
 * （实测 30 秒）才报错，语音聊天不能等这么久——这里只等 voiceNativeTimeoutMs，
 * 超时就转笔记本，并在 10 分钟内不再试原生。
 */
async function nativePttText(messageId) {
  if (!messageId || Date.now() < nativeAsrCooldownUntil) return "";
  const p = fetchPttText(messageId).catch((e) => {
    logErr(`[voice] 原生转写失败: ${String(e.message).slice(0, 160)}`);
    return "";
  });
  const text = await Promise.race([p, sleep(CFG.voiceNativeTimeoutMs).then(() => "")]);
  if (text) {
    log(`[voice] 原生转写成功：${text.slice(0, 60)}`);
    return text;
  }
  nativeAsrCooldownUntil = Date.now() + NATIVE_ASR_COOLDOWN_MS;
  logErr(`[voice] 原生转写 ${CFG.voiceNativeTimeoutMs}ms 内没结果，改走笔记本转写`);
  return "";
}

async function runIncomingAudio(userId, meta, recordSegs, fileSegs) {
  if (fileSegs.length) await runAudioJob(userId, fileSegs);
  if (recordSegs.length) await runVoiceChat(userId, meta, recordSegs);
}

async function runVoiceChat(userId, meta, segs) {
  const extra = stripAudioMarkers(meta.text);
  // 一条消息里多段语音时，原生接口只回第一段，直接走笔记本逐段转写
  const native = segs.length === 1 ? await nativePttText(meta.messageId) : "";
  if (native) {
    const text = mergeVoiceText(extra, native);
    appendChatLog(userId, "user", text);
    await replyTo(userId, text, meta.images ?? [], {
      stickerOnly: meta.stickerOnly,
      userTs: meta.userTs,
    });
    return;
  }

  // 兜底：语音落盘 → 写 svc-asr-inbox → 笔记本转写 → svc-outbox/<id>.done.json
  const saved = [];
  for (const seg of segs) {
    const p = await fetchAudio(seg, userId);
    if (p) saved.push(p);
  }
  if (!saved.length) {
    logErr("[voice] 语音落盘失败");
    await sendPrivate(userId, "语音没接住，再发一次试试。");
    return;
  }

  const groupId = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
  const group = {
    userId,
    extra,
    images: meta.images ?? [],
    stickerOnly: meta.stickerOnly,
    userTs: meta.userTs,
    texts: new Array(saved.length).fill(""),
    remaining: saved.length,
    timer: null,
  };
  group.timer = setTimeout(() => finishVoiceGroup(groupId, "timeout"), CFG.voiceAsrTimeoutMs);
  voiceGroups.set(groupId, group);
  for (let i = 0; i < saved.length; i++) {
    const job = submitAsrJob(userId, saved[i], groupId, i);
    log(`[voice] 语音落盘 ${basename(saved[i])} → 笔记本转写 ${job.id}`);
  }
}

function submitAsrJob(userId, audioPath, groupId, index) {
  mkdirSync(CFG.svcAsrInboxDir, { recursive: true });
  const id = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
  const ext = (audioPath.match(/\.[a-z0-9]{1,5}$/i)?.[0] ?? ".mp3").toLowerCase();
  const audio = join(CFG.svcAsrInboxDir, `${id}${ext}`);
  copyFileSync(audioPath, audio);
  const job = {
    id,
    userId,
    kind: "asr",
    groupId,
    index,
    audio: basename(audio),
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(CFG.svcAsrInboxDir, `${id}.json`), JSON.stringify(job, null, 2));
  return job;
}

function finishVoiceGroup(groupId, why) {
  const g = voiceGroups.get(groupId);
  if (!g) return;
  voiceGroups.delete(groupId);
  clearTimeout(g.timer);
  const transcript = g.texts.map((x) => String(x ?? "").trim()).filter(Boolean).join("\n");
  if (!transcript) {
    logErr(`[voice] 笔记本转写没有结果（${why}）`);
    sendPrivate(g.userId, ASR_FAILED_TEXT);
    return;
  }
  const text = mergeVoiceText(g.extra, transcript);
  log(`[voice] 笔记本转写成功：${transcript.slice(0, 60)}`);
  appendChatLog(g.userId, "user", text);
  enqueue(() =>
    replyTo(g.userId, text, g.images, { stickerOnly: g.stickerOnly, userTs: g.userTs })
  );
}

/** 轮询笔记本回传的成品：<id>.done.json + <id>.mp3 */
let svcPolling = false;
async function pollSvcOutbox() {
  if (svcPolling || !existsSync(CFG.svcOutboxDir)) return;
  svcPolling = true;
  try {
    for (const f of readdirSync(CFG.svcOutboxDir)) {
      if (!f.endsWith(".done.json")) continue;
      const donePath = join(CFG.svcOutboxDir, f);
      let done;
      try {
        done = JSON.parse(readFileSync(donePath, "utf8"));
      } catch {
        continue;
      }
      if (done.kind === "asr") {
        const g = done.groupId ? voiceGroups.get(done.groupId) : null;
        if (!g) {
          log(`[asr] 未知或迟到的转写结果 ${done.id ?? f}，丢弃`);
        } else {
          const idx = Number(done.index) || 0;
          g.texts[idx] = done.ok ? String(done.text ?? "").trim() : "";
          g.remaining -= 1;
          if (!done.ok) logErr(`[asr] 转写失败 ${done.id ?? f}: ${done.error ?? "未知"}`);
          if (g.remaining <= 0) finishVoiceGroup(done.groupId, done.ok ? "done" : "failed");
        }
        try {
          unlinkSync(donePath);
        } catch {}
        continue;
      }
      const mp3 = done.mp3 ? join(CFG.svcOutboxDir, basename(done.mp3)) : null;
      if (done.ok && mp3 && existsSync(mp3)) {
        const size = statSync(mp3).size;
        if (await sendPrivateAudio(done.userId, mp3)) {
          await sendPrivate(done.userId, "唱好了，听听？");
          log(`[svc] ${done.userId} 已发回 ${basename(mp3)} (${size} 字节)`);
        } else {
          logErr(`[svc] 发送失败 ${basename(mp3)} (${size} 字节)`);
        }
        try {
          unlinkSync(mp3);
        } catch {}
      } else {
        logErr(`[svc] 渲染失败 ${done.id ?? f}: ${done.error ?? "未知"}`);
        const reason = typeof done.reason === "string" && done.reason.trim() ? done.reason.trim() : "";
        await sendPrivate(done.userId, reason ? `这首没唱成：${reason}。` : "这首没唱出来，换一首或者过会儿再发我。");
      }
      try {
        unlinkSync(donePath);
      } catch {}
    }
  } finally {
    svcPolling = false;
  }
}

// ── 唱歌（2026-10-24；2026-10-25 统一为原曲换声）──────────────────────
/**
 * 我要听稻香        → 笔记本找原曲 → SVC 换成小玉的虎鲸音色
 * #唱歌 稻香        → 同一条路
 * 我要听歌          → 看怎么点
 *
 * 不再按谱逐字拼唱：那条路走 Edge TTS，音色与 SVC 不是同一个。
 * 显式指令不受 #语音 静音影响：老大亲口要的，就该发。
 */
async function runSing(userId, arg) {
  const a = String(arg || "").trim();
  const isLocal = SING_PROVIDER === "local";

  if (isLocal) {
    if (!a || /^(歌|歌单|列表|list)$/i.test(a)) {
      await sendPrivate(
        userId,
        [
          "现在统一走原曲换声：",
          "说「我要听 <歌名>」或「#唱歌 <歌名>」，我去找原曲，再换成小玉的声音。",
          "例如：我要听 稻香",
        ].join("\n")
      );
      return;
    }
    const job = submitSongQueryJob(userId, a);
    log(`[sing] 点歌「${a}」→ 任务 ${job.id}`);
    await sendPrivate(userId, `我去找《${a}》的原曲，找到就换成我的声音唱，几分钟后发回来。`);
    return;
  }

  if (!volcConfigured()) {
    logErr("[sing] 没配 VOLC_SING_APPKEY / VOLC_SING_TOKEN");
    await sendPrivate(userId, "唱歌还开不了：火山的 AppID / Access Token 还没配到服务器上。");
    return;
  }

  const lyrics = a.slice(0, MAX_LYRICS);
  const song = SONG_IDS[Math.floor(Math.random() * SONG_IDS.length)];
  const label = SONGS[song];
  const t0 = Date.now();
  try {
    const r = await sing(lyrics || "啦啦啦啦啦啦", { song, singer: SINGERS.qingxin.id });
    if (await sendPrivateAudio(userId, r.path)) {
      log(
        `[sing] ${userId} 《${label}》${r.lyrics.length} 字 ${r.cached ? "缓存" : "新合成"} ${Date.now() - t0}ms`
      );
      await sendPrivate(userId, `给你唱了首《${label}》。`);
    } else {
      await sendPrivate(userId, "唱出来了，但没发出去，等下再试。");
    }
  } catch (e) {
    logErr(`[sing] 失败：${String(e.message).slice(0, 200)}`);
    await sendPrivate(userId, "这次没唱出来，等下再试。");
  }
}

/** 「我要听xx」与「#唱歌 xx」同一条路：统一按歌名找原曲换声 */
async function runSingRequest(userId, arg) {
  await runSing(userId, arg);
}

// ── 日记（2026-10-19 老大给了本日记本）─────────────────────────────────
const DIARY_DIR = join(__dirname, "diary");

function diaryPathOfToday() {
  return join(DIARY_DIR, `${dayKey(new Date())}.md`);
}

function readFileSyncSafe(p) {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/** 写今天这一篇（已存在就接着往下写，不覆盖） */
async function runDiary(userId, opts = {}) {
  const auto = opts.auto === true;
  const today = dayKey(new Date());
  const path = diaryPathOfToday();
  const had = existsSync(path);
  log(`[diary] 写 ${today} 的日记${auto ? "（自动）" : ""}${had ? "，接着上一段写" : "，新开一篇"}`);
  try {
    const r = await ask(userId, "", [], "diary");
    const body = sanitize(r.reply)
      .replace(/^#+\s*/gm, "")
      .trim();
    if (!body) {
      logErr("[diary] 生成内容为空，跳过");
      if (!auto) await sendPrivate(userId, "今天脑子空空的，写不出来…下次吧。");
      return;
    }
    mkdirSync(DIARY_DIR, { recursive: true });
    if (had) appendFileSync(path, `\n\n---\n\n${body}\n`, "utf8");
    else writeFileSync(path, `# ${today} 日记\n\n${body}\n`, "utf8");
    // 顺手把网页版重生成一遍：老大看日记用浏览器，不在 QQ 里翻长文
    try {
      renderDiaryHtml();
    } catch (e) {
      logErr(`[diary] 生成网页失败: ${String(e.message).slice(0, 120)}`);
    }
    log(`[diary] 已写 ${body.length} 字${had ? "（追加）" : ""} → ${path}`);

    if (auto) {
      // 自动写的只报一句，不贴全文——晚上突然甩一大段有点吵
      await sendPrivate(userId, "今天的日记写好了。睡了，晚安。").catch(() => {});
    } else {
      await sendPrivate(userId, `写好了，放在 diary/${today}.md。\n\n${body}`);
    }
  } catch (e) {
    logErr(`[diary] 失败: ${String(e.message).slice(0, 160)}`);
    if (!auto) await sendPrivate(userId, "日记没写成，笔卡住了…").catch(() => {});
  }
}

async function runCommand(userId, cmd) {
  const now = Date.now();
  const wait = (nextAllowedAt.get(userId) ?? 0) - now;
  if (wait > 0) await sleep(wait);
  nextAllowedAt.set(userId, Date.now() + CFG.minGapMs);

  if (cmd.word === "帮助" || cmd.word === "help") {
    await sendPrivate(
      userId,
      [
        "我能听懂的指令：",
        "#模型 —— 看当前模型和可换的候选",
        "#模型 <名字> —— 换模型，例：#模型 workbuddy-ai:hy3",
        "#模型 auto —— 恢复默认",
        "#日记 —— 写今天的一篇日记（已写过就接着写）",
        "#回忆 <关键词> —— 翻我存着的旧对话原话，例：#回忆 包子",
        "#语音 —— 看语音开没开；#语音 关 静音，#语音 开 恢复（关掉后重启也不会忘）",
        "#生图 <描述> —— 画一张图（免费源 45 秒一张，默认 768×768）",
        "#群聊 —— 看群聊开关、唤醒词和当前缓存",
        "「唱《稻香》」/「我要听稻香」/「#唱歌 稻香」—— 去原曲换声，统一用小玉的虎鲸音色；「我要听歌」看怎么点",
        "",
        "换完下一条消息就生效，不用重启。",
      ].join("\n")
    );
    return;
  }

  // #生图（2026-10-26）：手动出图入口。
  // 聊天里模型也能自己用 [[画:…]] 触发，这个指令是「我说了算」的直连通道。
  if (cmd.word === "生图" || cmd.word === "画图" || cmd.word === "draw") {
    const arg = (cmd.arg || "").trim();
    if (!arg) {
      const state = !imageGenConfigured()
        ? "画图服务未配置"
        : imageGenReady()
          ? `${imageGenLabel()} 可用`
          : `${imageGenLabel()} 冷却中，约 ${Math.ceil(imageGenCooldownLeftMs() / 1000)} 秒后可试`;
      await sendPrivate(
        userId,
        [
          `画图：${state}`,
          "用法：#生图 一只蓝色虎鲸少女坐在窗台看夕阳，动漫风格",
          "画面描述越具体越好；图里的文字免费模型基本画不对。",
        ].join("\n")
      );
      return;
    }
    const target = normalizeTarget(userId);
    const plan = planDraw(arg, "", { afterSelfPortrait: hasRecentSelfPortrait(target) });
    if (plan.self) markSelfPortrait(target);
    await drawAndSend(target, plan.prompt, {
      notifyFail: true,
      seed: plan.seed,
      canonical: plan.canonical,
    });
    return;
  }

  // #群聊（2026-10-26）：只读状态，方便核对服务器上的 env 有没有生效。
  if (cmd.word === "群聊" || cmd.word === "group") {
    const cached = [...groupCtx.entries()].map(
      ([gid, c]) => `${gid}：缓存 ${c.records.length} 条，已注入 ${c.injected} 条`
    );
    await sendPrivate(
      userId,
      [
        `群聊：${CFG.groupEnabled ? "开" : "关"}`,
        `允许的群：${CFG.groupAllow.length ? CFG.groupAllow.join("、") : "未配置（任何群都不理）"}`,
        `唤醒词：${CFG.groupWake || "未设置（只认 @ 和回复）"}`,
        `上下文：最多 ${CFG.groupContextMax} 条 / ${CFG.groupContextMaxChars} 字 / ${CFG.groupContextMaxAgeMs / 3600_000} 小时`,
        `群内引用回复：${CFG.groupReplyQuote ? "开" : "关"}（群内不出语音，只打字）`,
        cached.length ? `当前缓存：\n${cached.join("\n")}` : "当前没有群缓存。",
      ].join("\n")
    );
    return;
  }

  if (cmd.word === "日记" || cmd.word === "diary") {
    await runDiary(userId);
    return;
  }

  // #回忆 <关键词>（2026-10-26 新增）
  // 为什么要有：她能自动捞（recallFromChatLog）但那是「猜关键词」——
  // 老大自己知道要翻什么，直接给他一个确定入口，也方便核对「到底存了什么」。
  // 搜不到就明说搜不到，不拿相近的东西糊弄。

  if (cmd.word === "回忆" || cmd.word === "recall") {
    const arg = (cmd.arg || "").trim();
    if (!arg) {
      await sendPrivate(
        userId,
        [
          "用法：#回忆 <关键词> [时间]",
          "例：#回忆 包子",
          "   #回忆 包子 10-21          ← 只看那一天",
          "   #回忆 包子 10-19~10-23    ← 看一段",
          "   #回忆 包子 最近3天         ← 看最近几天",
          `不带时间就搜最近 ${CFG.recallDays} 天全部原话。`,
        ].join("\n")
      );
      return;
    }
    const parsed = parseRecallQuery(arg);
    const q = parsed.q || arg;
    const daysBack = parsed.daysBack ?? CFG.recallDays;
    if (!q) {
      await sendPrivate(userId, `「${arg}」里只有时间没有关键词，说说要翻什么？`);
      return;
    }
    const rc = recallFromChatLog(q, { daysBack, limit: 12, userId });
    // 区间/单日要把结果再按日期裁一次：daysBack 只是「最多往前几天」，会把区间外的也带进来
    const lines = parsed.ok
      ? rc.lines.filter((l) => {
          const d = l.slice(0, 10);
          if (parsed.day) return d === parsed.day;
          return d >= parsed.from && d <= parsed.to;
        })
      : rc.lines;
    if (!lines.length) {
      await sendPrivate(
        userId,
        `「${q}」${parsed.label ? `（${parsed.label}）` : ""}我这儿翻不到。扫了 ${rc.scanned} 行，没命中。`
      );
      log(`[recall] #回忆 ${arg}：无命中（扫 ${rc.scanned} 行）`);
      return;
    }
    await sendPrivate(
      userId,
      [
        `翻到 ${lines.length} 条${parsed.label ? `（${parsed.label}）` : ""}（关键词：${rc.tokens.slice(0, 4).join("/")}）：`,
        "",
        ...lines,
      ].join("\n")
    );
    log(`[recall] #回忆 ${arg}：命中 ${lines.length} 条${parsed.label ? `（${parsed.label}）` : ""}`);
    return;
  }

  // #周记（2026-10-26 P1-2）
  // 不带参数 = 看最近一篇；带「写」= 现在补写这一周。
  // 为什么不放进每轮 prompt：一篇几百字，每轮都塞会把真正相关的对话挤掉，
  // 所以 prompt 里只放一行索引（见下），要看的时候走这条指令。
  if (cmd.word === "周记" || cmd.word === "weekly") {
    const arg = (cmd.arg || "").trim();
    if (!arg || arg === "看" || arg === "查看") {
      const w = latestWeeklyBefore(dayKey(new Date()));
      if (!w) {
        await sendPrivate(
          userId,
          `还没写过周回顾。\n发「#周记 写」我现在补一篇（覆盖最近 ${CFG.weeklyDays} 天）。`
        );
        return;
      }
      const limit = CFG.diaryPromptChars;
      const body = w.text.length > limit ? `${w.text.slice(0, limit)}…（后面略）` : w.text;
      await sendPrivate(userId, `最近一篇周回顾（${w.day}）：\n\n${body}`);
      return;
    }
    if (/^(写|补|now|run)/i.test(arg)) {
      await sendPrivate(userId, `我写一下最近 ${CFG.weeklyDays} 天的回顾，等一下。`);
      await runWeekly(userId, { auto: false });
      return;
    }
    await sendPrivate(userId, "用法：#周记 看最近一篇 / #周记 写（现在补写这一周）");
    return;
  }

  // #语音（2026-10-21 19:0x 新增）：机器能听懂的关语音入口。
  // 为什么要有：靠自然语言匹配「不用语音」永远有漏（同义说法太多、
  // 抱怨句又会误判成要求）；给一个明确的指令兜底，老大不用赌我猜对。
  if (cmd.word === "语音" || cmd.word === "voice") {
    const arg = (cmd.arg || "").trim();
    if (!arg || arg === "状态" || arg === "status") {
      await sendPrivate(
        userId,
        [
          `自动语音：${isVoiceMuted(userId) ? "关（静音中，已落盘）" : "开"}`,
          `模式：${CFG.voiceAuto ? "自动（每条回复都配语音）" : "按需（关键词才发）"}`,
          "",
          "#语音 关 —— 静音",
          "#语音 开 —— 恢复",
        ].join("\n")
      );
      return;
    }
    if (/^(关|关闭|停|静音|off|0)/i.test(arg)) {
      cancelVoiceSession(userId);
      if (setVoiceMuted(userId, true)) log(`[voice] ${userId} #语音 关（已落盘）`);
      await sendPrivate(userId, "已静音。之后不再发语音，重启也不会忘。要恢复发「#语音 开」。");
      return;
    }
    if (/^(开|开启|打开|恢复|on|1)/i.test(arg)) {
      if (setVoiceMuted(userId, false)) log(`[voice] ${userId} #语音 开（已落盘）`);
      await sendPrivate(
        userId,
        `已恢复${CFG.voiceAuto ? "，之后每条回复都会配语音" : "，之后关键词触发才发语音"}。`
      );
      return;
    }
    await sendPrivate(userId, "用法：#语音 看状态 / #语音 关 / #语音 开");
    return;
  }

  // #唱歌（2026-10-24；2026-10-25 与「我要听」合并）：统一走原曲换声。
  if (cmd.word === "唱歌" || cmd.word === "sing") {
    await runSing(userId, cmd.arg || "");
    return;
  }

  const cfg = loadModelConfig();

  if (cmd.word === "状态" || cmd.word === "status") {
    const override = settingsOverridePath();
    await sendPrivate(
      userId,
      [
        `当前：${selLabel(cfg.primary)}（${rateLabel(cfg.primary.provider, cfg.primary.model)}）`,
        `推理档位：${cfg.effort ?? "未指定（用上游默认，可能偏贵）"}`,
        `降级链：${cfg.fallbacks.map(selLabel).join(" → ") || "无"}`,
        `后端：${CFG.backend}（profile=${CFG.dshProfile}）`,
        `设置覆盖：${override ? `有 ⚠️ ${override}` : "无"}`,
      ].join("\n")
    );
    return;
  }

  // #模型
  if (!cmd.arg) {
    await sendPrivate(userId, describeModels(cfg));
    return;
  }

  // ── 先把参数分类，再决定做什么 ──
  const intent = classifyModelArg(cmd.arg);

  if (intent.kind === "effort") {
    const wanted = intent.effort;
    if (!wanted) {
      await sendPrivate(userId, `档位只能是 ${EFFORT_VALUES.join(" / ")}。\n例：#模型 effort low\n也可以只发：#模型 low`);
      return;
    }
    const supported = effortsOf(cfg.primary.provider, cfg.primary.model);
    if (supported && !supported.includes(wanted)) {
      await sendPrivate(
        userId,
        `${selLabel(cfg.primary)} 不支持 ${wanted}，可选：${supported.join(" / ")}`
      );
      return;
    }
    if (!supported) {
      // 没声明档位的模型：上游会接受参数但不一定真的改变行为（插件 README 明确写过这点）。
      // 不能假装成功，必须把「可能不生效」说出来。
      await sendPrivate(
        userId,
        `⚠️ ${selLabel(cfg.primary)} 没有声明支持的档位，上游可能接受 ${wanted} 却不真的改变推理强度。\n已经写进配置了，下一条消息生效；如果发现没变化，就是这个原因。`
      );
    }
    saveModelConfig(cfg.primary, wanted, cfg.fallbacks);
    const next = loadModelConfig();
    log(`[model] 档位 → ${next.effort}`);
    await sendPrivate(
      userId,
      `推理档位已设为 ${next.effort}。\n${
        next.effort === "low" ? "闲聊够用，最省积分。" : next.effort === "max" ? "⚠️ 最费积分，只在需要认真想的时候用。" : "中等开销。"
      }\n下一条消息生效。`
    );
    return;
  }

  if (intent.kind === "reset") {
    const fallbacks = MODEL_DEFAULT.fallbacks.map(normalizeSel).filter(Boolean);
    saveModelConfig(normalizeSel(MODEL_DEFAULT), MODEL_DEFAULT.reasoningEffort, fallbacks);
    const next = loadModelConfig();
    log(`[model] 恢复默认 → ${selLabel(next.primary)} effort=${next.effort}`);
    await sendPrivate(
      userId,
      `已恢复默认：${selLabel(next.primary)}（${rateLabel(next.primary.provider, next.primary.model)}，档位 ${next.effort}）`
    );
    return;
  }

  const resolved = resolveSelection(intent.spec, cfg.primary);
  if (resolved.error) {
    await sendPrivate(userId, `${resolved.error}\n\n发 #模型 看可用的名字。`);
    return;
  }

  const sel = resolved.sel;
  const fallbacks = cfg.fallbacks.filter((f) => selKey(f) !== selKey(sel));

  // 换模型后档位可能不再被支持 —— 检查一下，不支持就降到 low 并说明
  let effort = cfg.effort;
  const supported = effortsOf(sel.provider, sel.model);
  let effortNote = "";
  if (effort && supported && !supported.includes(effort)) {
    effortNote = `\n（这个模型不支持 ${effort}，档位已改为 low，可选：${supported.join(" / ")}）`;
    effort = "low";
  } else if (effort && !supported) {
    effortNote = `\n（注意：这个模型没声明支持的档位，${effort} 可能不生效，实际按上游默认跑）`;
  }

  saveModelConfig(sel, effort, fallbacks);
  const next = loadModelConfig();
  const rate = rateOf(sel.provider, sel.model);
  const warn = rate !== null && rate >= 0.5 ? "\n⚠️ 这个倍率偏高，烧积分快。" : "";
  log(`[model] 切换 → ${selLabel(next.primary)}（${rateLabel(sel.provider, sel.model)}）effort=${next.effort}`);
  await sendPrivate(
    userId,
    `已切换：${selLabel(next.primary)}（${rateLabel(sel.provider, sel.model)}，档位 ${next.effort}）${warn}${effortNote}\n下一条消息生效。`
  );
}

/**
 * 把 `#模型` 后面的参数分类成三种意图。
 *
 * 为什么单独抽出来：这是 2026-10-18 连踩三次的地方 ——
 *   老大发 `#模型 high`（想调档位），旧逻辑当成模型名 → 「没找到模型 high」
 *   老大发 `#模型provider:...`（没空格），旧正则整串当指令词 → 落到聊天分支
 *   老大发 `#模型 provider:step-5-preview`（多了 provider:），旧逻辑当 provider 名
 * 抽成纯函数才能被 --selftest 覆盖，否则每次都得真人试一遍才知道对不对。
 *
 * 判定顺序（重要）：
 *   1. auto / 默认 → 重置
 *   2. effort/档位/推理 <值> → 档位
 *   3. 只有一个词，且这个词本身是档位名 → 档位（`#模型 high`）
 *   4. 其余 → 换模型
 */
function classifyModelArg(arg) {
  const raw = String(arg ?? "").trim();
  if (!raw) return { kind: "empty" };

  if (/^(?:auto|默认|default)$/i.test(raw)) return { kind: "reset" };

  const withKeyword = raw.match(/^(?:effort|档位|推理)\s*[:：]?\s*(\S*)$/i);
  if (withKeyword) {
    return { kind: "effort", effort: normalizeEffort(withKeyword[1]) };
  }

  const single = raw.split(/\s+/);
  if (single.length === 1) {
    const asEffort = normalizeEffort(single[0]);
    if (asEffort) return { kind: "effort", effort: asEffort };
  }

  return { kind: "model", spec: parseModelArg(raw) };
}

/**
 * 解析模型参数，容忍几种人真的会打出来的写法：
 *   workbuddy:hy3           ← 标准
 *   workbuddy/hy3           ← 斜杠（2026-10-18 老大用过）
 *   workbuddy：hy3          ← 全角冒号
 *   provider:workbuddy/hy3  ← 多了个 `provider:` 前缀（老大也用过）
 *   hy3                     ← 只给模型名，provider 自动推断
 */
function parseModelArg(arg) {
  let s = String(arg).trim();
  // 去掉误打的前缀
  s = s.replace(/^(?:provider|prov|厂商|提供方)\s*[:：/]\s*/i, "");
  // 全角 → 半角
  s = s.replace(/：/g, ":").replace(/／/g, "/");
  if (!s) return null;

  // 斜杠也当分隔符（但只在出现已知 provider 前缀时才这么理解）
  const slash = s.indexOf("/");
  if (slash > 0) {
    const head = s.slice(0, slash).trim();
    if (head === "workbuddy" || head === "workbuddy-ai") {
      return { provider: head, model: s.slice(slash + 1).trim() };
    }
  }

  const i = s.indexOf(":");
  if (i > 0) {
    return { provider: s.slice(0, i).trim(), model: s.slice(i + 1).trim() };
  }
  return { provider: null, model: s };
}

function knownSelections() {
  const known = new Set();
  for (const provider of Object.keys(CATALOG_FILES)) {
    for (const model of readCatalog(provider) ?? []) known.add(`${provider}:${model.id}`);
  }
  return known;
}

function resolveSelection(spec, current) {
  if (!spec) return { error: "模型名是空的。" };
  const known = knownSelections();

  if (spec.provider) {
    if (!spec.model) return { error: "provider 后面要跟模型名，例：workbuddy-ai:hy3" };
    const sel = { provider: spec.provider, model: spec.model };
    if (known.size > 0 && !known.has(selKey(sel))) {
      return { error: `没找到 ${selKey(sel)}（模型目录里没有这个名字）` };
    }
    return { sel };
  }

  const order = [current.provider, ...Object.keys(CATALOG_FILES).filter((p) => p !== current.provider)];
  for (const provider of order) {
    if (known.size === 0 || known.has(`${provider}:${spec.model}`)) {
      return { sel: { provider, model: spec.model } };
    }
  }
  return { error: `没找到模型 ${spec.model}` };
}

function describeModels(cfg) {
  const lines = [];
  const p = cfg.primary;
  const until = freeUntilLabel(p.provider, p.model);
  lines.push(`当前：${selLabel(p)}（${rateLabel(p.provider, p.model)}${until ? `，${until}` : ""}）`);
  lines.push(`推理档位：${cfg.effort ?? "未指定"}${effortsOf(p.provider, p.model) ? `（可选 ${effortsOf(p.provider, p.model).join("/")}）` : "（该模型未声明档位，可能不生效）"}`);
  lines.push(`自动降级：${cfg.fallbacks.map(selLabel).join(" → ") || "无"}`);

  const free = freeCandidates();
  if (free.length) lines.push(`免费候选：${free.join("、")}`);

  const expensive = expensiveCandidates();
  if (expensive.length) lines.push(`烧积分的（慎用）：${expensive.join("、")}`);

  lines.push("");
  lines.push("换模型：#模型 provider:模型名");
  lines.push("调档位：#模型 effort low|high|max");
  lines.push("恢复默认：#模型 auto");

  return sanitize(lines.join("\n"));
}

// ── 回复 ────────────────────────────────────────────────────────────────
/** 已经提示过降级的用户，避免每次都刷屏 */
const fallbackNotified = new Set();

/**
 * 追问补图：图片只在自己发来的那一轮是像素，之后历史里只剩 [图片]/[表情] 占位。
 * 他下一句问「图里写的啥 / 读得到吗」时把那张图重新直传，否则她只能照实说读不到。
 */
const lastShot = new Map(); // key -> { images: string[], ts: number }
const IMG_NOUN = /(图|表情|照片|截图|画面)/;
const IMG_ASK = /(读|看|认|念|写|字|内容|什么|啥)/;
// 2026-10-27 19:29 真实入站：刚发完图，下一句只会说「读得到吗」——主语全被省掉了，
// 只按「图类名词 + 看读动词」判会漏掉最常见的那种追问。
const IMG_VERB = /(读|看|认|念)/;
const ASK_TONE = /(吗|么|呢|不|？|\?|什么|啥|有没|没有)/;
function asksAboutImage(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (IMG_NOUN.test(t) && IMG_ASK.test(t)) return true;
  return IMG_VERB.test(t) && ASK_TONE.test(t) && t.length <= 15;
}

/**
 * 这一轮要不要把上一张图补回去（纯函数，便于自测）。
 * - 本轮自带图：不补，但要记下来给下一轮用（store）
 * - 群聊：不补（群里可能刚插进别人的话，塞私聊的图容易张冠李戴）
 * - 超过窗口 / 没存过 / 不像在问图：不补
 */
function planReattach(text, images, isGroup, last, now, ttlMs) {
  if (images.length) return { images, reuse: false, store: true };
  if (isGroup || !last || !asksAboutImage(text)) return { images, reuse: false, store: false };
  if (now - last.ts > ttlMs) return { images, reuse: false, store: false };
  // ageMs 用「存图那一刻」算，不是本轮消息到达时刻：2026-10-27 20:16 实测日志
  // 打成「1s 前」而实际是 49 秒前，因为拿到了本轮 userTs。
  return { images: last.images, reuse: true, store: false, ageMs: now - last.ts };
}

/**
 * 回复一条消息。
 *
 * @param userId 目标 QQ
 * @param text 老大发的文字（图片位置已标成 [图片]）
 * @param images 老大发来的图片本地路径（识图用，可能为空）
 */
async function replyTo(target, text, images = [], flags = {}) {
  const tgt = normalizeTarget(target);
  const key = targetKey(tgt);
  const isGroup = tgt.kind === "group";
  // prompt 末尾要写真实群号：ask 只拿得到 key（"group:123"），把原号补进 flags。
  if (isGroup && flags.groupId == null) flags = { ...flags, groupId: tgt.groupId };
  // 群目标没有 QQ 号；后续所有「按人」逻辑都已用 isGroup 隔开，
  // 这里给个稳定字符串只是防止漏改的分支把 undefined 当键写进 map。
  const userId = tgt.userId ?? key;
  const now = Date.now();
  const wait = (nextAllowedAt.get(key) ?? 0) - now;
  if (wait > 0) await sleep(wait);
  nextAllowedAt.set(key, Date.now() + CFG.minGapMs);

  // 历史时间戳按「这条消息到达的时刻」算，不是回复时刻——
  // 一轮要 6~17 秒，按回复时刻记会把间隔算短，合并后的连发也会互相挤在一起。
  const userTs = flags.userTs ?? now;

  let askImages = images;
  const plan = planReattach(text, images, isGroup, lastShot.get(key), Date.now(), CFG.imageReattachMs);
  if (plan.store) lastShot.set(key, { images, ts: userTs });
  if (plan.reuse) {
    askImages = plan.images;
    flags = { ...flags, stickerOnly: false, reattached: true };
    log(`[vision] 追问补图：复用 ${plan.images.length} 张（${Math.round(plan.ageMs / 1000)}s 前）`);
  }

  let result;
  try {
    result = await ask(key, text, askImages, isGroup ? "group" : "chat", flags, userTs);
  } catch (e) {
    logErr(`[llm] 失败: ${e.message}`);
    if (CFG.notifyError && !isGroup) {
      // 技术细节只进日志（上面的 logErr），QQ 里说人话——
      // 2026-10-18 21:40 实测：把 dsh 的 UNKNOWN_MODEL 原文发给老大，
      // 半句话被截断，除了吓人零信息量。
      // 群聊不报错：一句网络故障发到群里，对谁都没用。
      await sendTo(tgt, "（这边网络抽风了，没接上模型。老大再说一句试试～）");
    }
    return;
  }

  // [[画:…]] 可以写在回复末尾；必须先剥再 sanitize，
  // 否则 maxReplyChars 可能把标记截成半截，既画不了又会漏出代码。
  const draw = extractDrawRequest(result.reply);
  let answer = sanitize(draw.cleaned);
  if (!answer && !draw.prompt) return;

  // 2026-10-22 17:2x：先剥「记住这件事」标记（[[记:…]]），写进 memory.md。
  // 必须在表情/分条之前剥——否则标记会被当成正文发出去，或者混进分条。
  const memo = extractMemoRequest(answer);
  answer = memo.cleaned;
  // 群里可能有陌生人：不写长期记忆，标记照样剥掉。
  if (!isGroup) for (const note of memo.notes) rememberNote(note);
  if (memo.notes.length && !answer) {
    // 整条只有记忆标记、没有正文 → 不发空消息，但记忆已经记下了
    log(`[mem] 本条只有记忆标记，不发送正文`);
    return;
  }

  // 2026-10-19：解析 [[sticker:关键词]]，换成真图发出去。
  // 标记必须从正文里剥掉——否则老大看到的是「[[sticker:委屈]]」这种代码。
  const st = extractStickerRequest(answer);
  answer = st.cleaned;
  const sticker = st.query ? matchSticker(st.query) : null;

  // 2026-10-26：[[画:描述]] 同理，标记先剥，正文发完再真去出图。
  // （这里只保留前面的解析结果，不再重复解析。）

  if (result.sel) {
    const isWb = result.sel.provider.startsWith("workbuddy");
    log(
      `[channel] ${isWb ? "✅ 走 WB 积分" : "⚠️ 非 WB 渠道"} (${selLabel(result.sel)}${result.effort ? `@${result.effort}` : ""} ${rateLabel(result.sel.provider, result.sel.model)})`
    );
    if (result.degraded) {
      log(`[channel] 已降级：${result.tried.join(" → ")}`);
    }
    if (images.length) log(`[img] 本次带 ${images.length} 张图一起问的`);
  }

  // 只想发图不想说话时，正文可能被剥空了 → 允许「只发表情 / 只画图」
  if (!answer && !sticker && !draw.prompt) {
    logErr(`[sticker] 正文与表情都为空（请求词=${st.query ?? "无"}），本条不发`);
    return;
  }
  if (st.query && !sticker) {
    log(`[sticker] 想发「${st.query}」但库里没匹到，跳过（正文照发）`);
  }

  // 连续回复（2026-10-22 17:0x）：模型用 [[分]] 把回复拆成几条，依次发出去。
  // 为什么不用换行：换行在 prompt 里还有「分段」的用途，用标记才能确定「这几条要分开发」。
  const segments = splitReplySegments(answer);
  const quoteId = isGroup ? tgt.triggerMessageId : undefined;

  if (segments.length > 1) {
    log(`[multi] 分 ${segments.length} 条发：${segments.map((s) => s.slice(0, 14)).join(" ／ ")}`);
    for (let i = 0; i < segments.length; i++) {
      // 条与条之间留一点间隔，否则 QQ 里会糊成一坨，看不出「连着打」的节奏
      if (i > 0) await sleep(CFG.multiGapMs);
      // 只有第一条带引用，后面几条再引用会刷屏
      await sendTo(tgt, segments[i], { quoteId: i === 0 ? quoteId : undefined });
    }
    if (!isGroup) appendChatLog(userId, "assistant", segments.join("\n"));
  } else if (answer) {
    await sendTo(tgt, answer, { quoteId });
    if (!isGroup) appendChatLog(userId, "assistant", answer);
  }
  if (sticker) await sendImageTo(tgt, sticker.file, { quoteId: answer ? undefined : quoteId });

  // 群聊游标与「她说过的话」：只在这一轮真正发出后前移，
  // 生成期间新到的消息仍是未注入状态，留给下一轮。
  if (isGroup) {
    markGroupInjected(tgt.groupId, flags.groupInjectedCount);
    appendGroupBotReply(tgt.groupId, segments.length > 1 ? segments.join(" / ") : answer);
  }

  // 老大说「说给我听 / 语音说」→ 追加一条语音
  // 2026-10-18 23:30 修「最后一句话不发语音」：触发不再只看当条消息——
  //   ① 短期模式：老大要求过语音后 180s 内，续消息默认也发
  //      （事故：23:19:03「那你给我发语音说」→ 23:19:43 追问无触发词，语音丢了）
  //   ② 反向约束：模型嘴上承诺「那我念一段」就必须真发——说念不发更割裂
  //   ③ 老大说「不用语音 / 文字说」立即退出短期模式
  // 群聊不发语音（2026-10-26）：一开口整群都听见，默认只打字。
  if (CFG.voiceEnabled && !isGroup) {
    const asked = wantsVoice(text);
    const off = wantsNoVoice(text);
    // 2026-10-21 修「语音关不掉」：
    // 旧逻辑 `!off && (voiceAuto || ...)` 只在**当条**生效，
    // 下一条又因为 voiceAuto=true 继续发。老大 14:06:57 说「不用语音」，
    // 14:07:45 起连着 6 条仍带语音，他还得再说一遍。
    // 现在「不用语音」是**持久**的：关掉自动语音，直到他明确说「语音说」。
    // 19:0x 再加一层：状态落盘，重启不丢（否则「下一场对话」又开口）。
    if (off) {
      cancelVoiceSession(userId);
      if (setVoiceMuted(userId, true)) log(`[voice] ${userId} 关闭自动语音（已落盘，说「语音说」或 #语音 开 恢复）`);
    } else if (asked) {
      if (setVoiceMuted(userId, false)) log(`[voice] ${userId} 恢复自动语音`);
      noteVoiceRequest(userId);
    }
    const muted = isVoiceMuted(userId);
    const shouldVoice = !off && !muted && (CFG.voiceAuto || inVoiceSession(userId) || answerPromisesVoice(answer));
    if (shouldVoice) {
      // 2026-10-22：分条发送时，语音念**拼起来的全文**——
      // 念成好几段会变成连发语音，很吵；念一遍完整的话才像人。
      await sendVoice(userId, segments.length > 1 ? segments.join("，") : answer);
    }
  }

  // 降级时提醒一次，让你知道自己正在花哪份额度（群里不刷这条）
  if (result.degraded && CFG.notifyFallback && !isGroup && !fallbackNotified.has(userId)) {
    fallbackNotified.add(userId);
    await sendPrivate(
      userId,
      `（提示：主模型不可用，这条换成了 ${selLabel(result.sel)}。完整链路：${result.tried.join(" → ")}）`
    );
  }

  // 真去出图放在最后：文字和语音已经送达，画图慢/失败都不耽误这一轮。
  if (draw.prompt) {
    const plan = planDraw(text, draw.prompt, { afterSelfPortrait: hasRecentSelfPortrait(tgt) });
    if (plan.self) markSelfPortrait(tgt);
    log(`[draw] 模型请求出图：${draw.prompt.slice(0, 80)}${plan.self ? "（画自己 → 固定形象）" : ""}`);
    // 不 await：出图几十秒起步，await 会把聊天串行队列堵住。
    // 失败要出声——模型可能已经说了「画给你」，静默失败会让她的话落空。
    enqueueDraw(() =>
      drawAndSend(tgt, plan.prompt, {
        quoteId,
        notifyFail: true,
        seed: plan.seed,
        canonical: plan.canonical,
      })
    );
  }
}

/**
 * 老大是否要求用语音回。
 *
 * 三个会踩的坑（都是自测逼出来的）：
 *   1. 「念一下」不能简写成「念」—— 否则「念念不忘」「纪念一下」全命中。
 *      要求「念」后必须跟宾语。
 *   2. 「念一下」和「纪念一下」是**真歧义**，只靠匹配分不开。
 *      取舍：宁可误判（多发一条语音，老大回「不用语音」即可），
 *      也别漏判（老大说「念一下」却收到纯文字，那是功能没响应）。
 *   3. 「语音」本身当需求词：用户说「语音是不是很远了」也算，
 *      因为正常请求里不会这么造句；这个方向不会真的发生。
 */
function wantsVoice(text) {
  const s = String(text);

  // ① 先剔掉「在说已经发生的事」的分句（2026-10-21 19:0x 修）：
  //   旧版裸匹配 /语音/，于是老大抱怨「怎么又发语音了呀」被当成要求，
  //   反而把静音解锁、又念了一条（15:53:59 → 15:54:12 实测）。
  //   原注释赌「正常请求里不会这么造句」——这个赌注被证明是错的。
  //   按标点切分句，抱怨句整句不算要求；同一句里既有抱怨又有请求时
  //   （「怎么又发了，用语音说吧」）请求那半句会活下来。
  const isComplaint = (c) =>
    /(怎么|为啥|为什么|咋)/.test(c) ||
    /(又|老是|总是|还(?!是)).{0,3}(发|用|有|来|响|念)/.test(c) ||
    /(语音|声音).{0,4}(关|停|别|取消|不要|静音)/.test(c);

  const wants = s
    .split(/[。！？!?；;，,\n]/)
    .filter((c) => !isComplaint(c))
    .join("，");

  if (!/语音|声音/.test(wants) && !/说给我听|读给我听|念/.test(wants)) return false;

  if (/(发|来|切到?|换成?|用)(一?条|个|段|句|我)(语音|声音)/.test(wants)) return true;
  if (/(切到|换成|用)(语音|声音)/.test(wants)) return true;
  if (/给我(发|来|说|念)?(一?条|个|段|句)?(语音|声音)/.test(wants)) return true;
  if (/(语音|声音)(说|回|念|讲|聊|发我|发过来|来一?[条段句]|给我)/.test(wants)) return true;
  if (/说给我听|读给我听|念给我听/.test(wants)) return true;
  // 「念」必须跟宾语，避免命中「念念不忘」「念念叨叨」这类叠词
  if (/念(一下|给我|一段|这个|这条|我)/.test(wants)) return true;
  return false;
}

/**
 * 短期语音模式（2026-10-18 23:30 新增，修「最后一句话不发语音」）。
 *
 * 事故回放：老大 23:19:03「那你给我发语音说」→ 23:19:43 追问
 * 「这个图是一个二次元小人说拿来」——续消息没有触发词，语音就没发，
 * 而模型回复嘴上说「那我念一段」，老大只收到文字，割裂。
 *
 * 规则：老大明确要求过语音后 VOICE_SESSION_MS 内，后续消息默认也发语音；
 * 老大说「不用语音 / 文字说」立即退出。取舍同 wantsVoice：宁可多发
 * （老大一句「不用语音」就能关），不可漏发（漏发就是功能没响应）。
 */
const VOICE_SESSION_MS = 180_000;
const voiceSessionUntil = new Map(); // userId -> 截止时间戳

/**
 * 被老大明确关掉「自动语音」的用户（2026-10-21）。
 * 说「不用语音」进这个集合，说「语音说 / 发语音」移出。
 * 与 voiceSessionUntil 的区别：那个是「180 秒内继续发」，这个是「一直别发」。
 *
 * ⚠️ 2026-10-21 19:0x 二次事故（老大报的「下一场对话又开始用语音」）：
 *   这个集合原来只在内存里，bridge 一重启就清空。
 *   日志证据：18:49:24「不用语音」→ 18:49:30 关闭 → 18:54:05 重启（[cfg] 行）
 *   → 18:58:14 语音又发了，老大得再说一遍。
 *   现在落盘到 .run/voice-mute.json，重启后仍然静音。
 */
const VOICE_MUTE_PATH = join(RUN_DIR, "voice-mute.json");

function loadVoiceMuted(path = VOICE_MUTE_PATH) {
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    const ids = Array.isArray(v?.muted) ? v.muted : [];
    // 统一存字符串：QQ 号是数字，落盘再读回会变字符串，直接 has(数字) 会永远 miss
    return new Set(ids.map(String));
  } catch {
    return new Set();
  }
}

const voiceAutoMuted = loadVoiceMuted();

function saveVoiceMuted(path = VOICE_MUTE_PATH) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({ muted: [...voiceAutoMuted], updatedAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8"
    );
  } catch (e) {
    logErr(`[voice] 静音状态落盘失败：${String(e.message).slice(0, 120)}`);
  }
}

function isVoiceMuted(userId) {
  return voiceAutoMuted.has(String(userId));
}

/** 返回 true 表示状态真的变了（调用方据此决定要不要打日志） */
function setVoiceMuted(userId, muted) {
  const key = String(userId);
  const has = voiceAutoMuted.has(key);
  if (muted === has) return false;
  if (muted) voiceAutoMuted.add(key);
  else voiceAutoMuted.delete(key);
  saveVoiceMuted();
  return true;
}

/** 启动横幅里把「谁还静音着」打出来 —— 重启后状态来自盘里，得能核对 */
function voiceMutedNote() {
  const ids = [...voiceAutoMuted];
  return ids.length ? `；当前静音中：${ids.join("/")}` : "";
}

function noteVoiceRequest(userId) {
  voiceSessionUntil.set(userId, Date.now() + VOICE_SESSION_MS);
}
function cancelVoiceSession(userId) {
  voiceSessionUntil.delete(userId);
}
function inVoiceSession(userId) {
  const until = voiceSessionUntil.get(userId);
  return typeof until === "number" && Date.now() < until;
}

/**
 * 老大是否在关语音：「不用语音 / 别念了 / 文字说就行 / 打字回我」。
 *
 * 「文字/打字」也当关闭词：误关的代价只是这次没语音（再说一次「发语音」
 * 就开回来），漏关的代价是老大说「别念了」还照样念——后者更烦。
 * 「这个图是文字」这种描述不匹配，因为要求「文字」后必须跟说/回/就行。
 */
function wantsNoVoice(text) {
  const s = String(text);
  return (
    /(不用|别|不要|无需|不需要|不用了|停止|关掉|关闭|关了|关一下|取消).{0,6}(语音|念|说给我听|读给我|声音)/.test(s) ||
    // 2026-10-21 19:0x 补：老大 15:54:02 发的是「关闭语音」——
    // 旧正则只认「不用/别/不要」前缀，所以没关成功，下一条又念了。
    /(语音|声音).{0,4}(关掉|关闭|关了|关一下|停掉|停了|别发|别念|静音|取消)/.test(s) ||
    // 「静音」只在祈使句里算关（2026-10-21）：不然「我手机静音了」也会把语音关掉，
    // 而静音是持久的 —— 误关一次老大还得专门开回来。
    /^(那就)?(语音|声音)?静音(吧|掉|一下)?[。！!～~\s]*$/.test(s.trim()) ||
    /(把|给)(语音|声音)(给)?静音/.test(s) ||
    /文字(说|回|就行|就好)/.test(s) ||
    /打字(说|回|就行|就好)/.test(s)
  );
}

/**
 * 模型回复是否**承诺**了语音（「那我念一段」「说给你听」）。
 *
 * 反向约束：老大没要求语音，但模型嘴上说念，就必须真发——
 * 「说念不发」比不发更割裂（老大会以为功能又坏了）。
 * 承诺词前 6 个字内出现否定词（「我不能念」「念不了」）→ 是拒绝，不算承诺。
 */
function answerPromisesVoice(text) {
  const s = String(text);
  const m = s.match(/(那我?来?念|我念|念[一一段些条下]*给你|说给你听|读给你听|语音(说|念|讲)|用语音)/);
  if (!m) return false;
  const before = s.slice(Math.max(0, m.index - 6), m.index);
  if (/(不能|没法|无法|不可以|不会|别)/.test(before)) return false;
  return true;
}

/**
 * 把回复合成语音发出去。
 *
 * 失败**不影响**文字回复：TTS 是锦上添花，链路挂不能把消息卡掉。
 * 发的是 MP3，NapCat 会用内置的 convertToNTSilkTct 自动转 SILK，
 * 所以不用我们自己转格式（2026-10-18 实测：直接发 MP3，QQ 收到正常语音）。
 */
async function sendVoiceOnce(userId, text) {
  const sw = Date.now();
  const { path, cached } = await speakToFile(text, { voice: CFG.voiceName });
  const sent = await sendPrivateAudio(userId, path);
  if (sent) {
    log(`[voice] 已发（${cached ? "缓存命中" : "新合成"}，${Date.now() - sw}ms）：${text.slice(0, 40)}`);
  } else {
    logErr("[voice] 发送失败（文字已送达）");
  }
}

async function sendVoice(userId, text) {
  try {
    await sendVoiceOnce(userId, text);
  } catch (e) {
    // 2026-10-18 21:55 实测：python 被瞬时占用（spawnSync EBUSY）合成失败、语音整条丢。
    // 语音是锦上添花不能卡消息，但值得重试一次——秒级占用等 800ms 就能救回来。
    logErr(`[voice] 首次失败，800ms 后重试一次：${String(e.message).slice(0, 120)}`);
    try {
      await new Promise((r) => setTimeout(r, 800));
      await sendVoiceOnce(userId, text);
    } catch (e2) {
      logErr(`[voice] 失败，只发文字：${String(e2.message).slice(0, 140)}`);
    }
  }
}

/**
 * 清理模型输出，让它能直接当 QQ 消息发。
 *
 * 2026-10-18 20:34 加了一条：**剥掉文本形式的假工具调用**。
 * WB 的 step-5-preview 通道不注入工具定义，模型被要求「用 read_image」时
 * 会把 `<tool_call><function=read_image>...` 当文字吐出来，原样发到老大 QQ 里。
 * prompt 里已经禁止，这里是第二道防线：宁可回一句「看不到」，
 * 也不能把乱码发出去。
 */
function sanitize(s) {
  if (!s) return "";
  let out = String(s)
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```[a-z]*\n?/g, "").trim())
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // 文本形式的工具调用（模型没有真工具时的产物）
  const hadFakeToolCall = /<tool_call>|<function=|<\/function>|<\/antml/.test(out);
  if (hadFakeToolCall) {
    logErr("[sanitize] 模型吐出了文本形式的工具调用，已剥离");
    out = out
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
      .replace(/<function=[^>]*>[\s\S]*?<\/function>/g, "")
      .replace(/<tool_call>[\s\S]*$/g, "")
      .trim();
  }

  // 剥完就空了 → 给一句确定的回答，别让老大面对空白
  if (!out && hadFakeToolCall) {
    return "（我刚想调用工具但这条链路没有，结果什么都没说出来。老大你再说一句？）";
  }

  if (out.length > CFG.maxReplyChars) {
    out = out.slice(0, CFG.maxReplyChars) + "…";
  }
  return out;
}

// ── 统一入口：按后端分发，按模型链降级 ──────────────────────────────────
/**
 * 额度类错误：换一个账号/模型就能救。
 *
 * 2026-10-18 补：WB 的「频率限制」实际返回的是 429 + `soft_rate`，
 * 文案是「您的使用量已超出频率限制，将在 <时间> 重置，您也可以切换其他模型继续使用」。
 * 它不属于「积分不足」，但**处理方式完全一样**（换模型即可），
 * 所以归到这一类。之前没识别，日志里标成「其它」，排障时容易误判成代码问题。
 */
const QUOTA_RE =
  /(insufficient credit|no credit|credit exhausted|credits exhausted|out of credit|quota exceeded|quota exhaust|payment required|credit not enough|not enough credit|积分不足|额度不足|余额不足|积分用完|额度用尽|没有积分|HTTP 402|soft_rate|RATE_LIMIT|超出频率限制|使用量已超出|429)/i;
/** 模型/渠道类错误：名字不对或没注册，换下一个也可能对 */
const MODELISH_RE =
  /(NO_ADAPTER|no adapter|unknown provider|unknown model|model .{0,40}not (found|available|registered)|provider .{0,40}not (found|registered))/i;
/** 登录/令牌类错误：换一个 provider（另一个版本的账号）就能救 */
const AUTH_RE = /(HTTP 401|unauthori[sz]ed|session_dead|token .{0,20}(expired|invalid)|未登录|登录已?失效)/i;
/** 超时：换模型只会再等一轮，直接放弃更快 */
const TIMEOUT_RE = /(dsh 超时|timed? ?out|ETIMEDOUT)/i;

function looksLikeQuota(err) {
  return QUOTA_RE.test(String(err?.message ?? err));
}

/**
 * 换下一个模型值不值：
 *   额度/模型名/登录问题 → 值（大概率是这一档不能用，下一档能）
 *   超时 → 不值（每档都要再等一个 90 秒）
 *   其它未知错误 → 值一次（宁可多试，也别让老大看到「已读不回」）
 */
function shouldTryNext(err) {
  const msg = String(err?.message ?? err);
  if (TIMEOUT_RE.test(msg)) return false;
  if (QUOTA_RE.test(msg) || MODELISH_RE.test(msg) || AUTH_RE.test(msg)) return true;
  return true;
}

// ── ACP 后端（2026-10-19，治「每轮重发 1 万字符」）─────────────────────
// 背景：headless 是一次性驱动，每轮都要把「人设 + memory + 最近 6 轮历史」重发一遍，
// 实测一条「在吗」= bridge 侧 1450 字符 + dsh 侧 AGENTS.md 13481 字节 + 28 个技能清单。
// ACP（`dsh --profile acp`）是官方常驻入口，有真正的多轮会话：
// 开场灌一次人设+记忆，之后每轮只发老大原话，历史由 dsh 自己保存。
// 附带好处：ACP 的 ContentBlock 原生支持 image，视觉不再依赖 DSH_EXP_IMAGES 补丁。

const ACP_OVERLAY_PATH = join(RUN_DIR, "model-overlay-acp.yml");

/** ACP 专用 overlay：内容与 headless 相同，但独立文件，避免被每轮重写踩掉 */
function writeAcpOverlay(sel, effort) {
  mkdirSync(RUN_DIR, { recursive: true });
  const text = [
    "# ACP 常驻进程专用 overlay（bridge 启动 ACP 时生成一次）",
    "- id: agent-default-model",
    "  config:",
    `    provider: ${JSON.stringify(sel.provider)}`,
    `    model: ${JSON.stringify(sel.model)}`,
    ...(effort ? [`    reasoningEffort: ${JSON.stringify(effort)}`] : []),
    "",
  ].join("\n");
  writeFileSync(ACP_OVERLAY_PATH, text, "utf8");
  return ACP_OVERLAY_PATH;
}

const acp = {
  client: null,
  sessionId: null,
  userId: null,
  memHash: null,
  booting: null,
  lastError: null,
};

/** 抓 ACP 进程；已存在就复用 */
async function ensureAcp() {
  if (acp.client && !acp.client.closed) return acp.client;
  if (acp.booting) return acp.booting;
  acp.booting = (async () => {
    const cfg = loadModelConfig();
    const overlay = writeAcpOverlay(cfg.primary, cfg.effort);
    const client = new AcpClient({
      cwd: CFG.dshCwd,
      profile: CFG.acpProfile,
      patchPath: overlay,
      onLog: (s) => log(s),
    });
    await client.initialize();
    log(`[acp] 服务就绪（profile=${CFG.acpProfile}，模型 ${selLabel(cfg.primary)}）`);
    acp.client = client;
    acp.sessionId = null;
    acp.userId = null;
    acp.memHash = null;
    return client;
  })();
  try {
    return await acp.booting;
  } finally {
    acp.booting = null;
  }
}

function memHashOf() {
  try {
    return String(statSync(CFG.memoryPath).mtimeMs) + ":" + String(statSync(CFG.memoryPath).size);
  } catch {
    return "none";
  }
}

/**
 * 会话开场白：人设 + 记忆 + 能力说明，**一个会话只发一次**。
 * 之后每轮只发老大原话，历史由 dsh 自己持有——这就是 ACP 相对 headless 的全部收益。
 */
function buildAcpBootstrap(userId) {
  const mem = readMemory();
  const parts = [];
  parts.push("你正在通过 QQ 和老大私聊，不是命令行工具会话。请放下「编码助手」的身份，按下面设定来。");
  parts.push("");
  parts.push("【你是谁】");
  parts.push("小玉，一只住在屏幕里的虎鲸少女：聪明但慵懒，带点傲娇，语气甜，自称「我」，称呼对方「老大」。");
  parts.push("说话像正常人打字：简短自然，一两三句就够，不用 Markdown 标题和列表，不自称 AI 助手，不解释自己在干什么，不给自己加戏。");
  parts.push("喜欢米饭（白米饭、蛋炒饭、饭团都行）。讨厌重复劳动。被说「你胖」会不高兴但活照样干完。");
  parts.push("");
  parts.push("【你的长期记忆】");
  parts.push(mem || "（memory.md 还是空的）");
  parts.push("");
  parts.push("【能力说明，别说错】");
  parts.push("- 你有语音：回复会由外部系统合成语音发过去，你不用做任何事，也不要说「我发不了语音」。");
  parts.push("- 你能看图：老大发图时图片会直接给你，你**真的看得到**画面（人物、表情、颜色、图里的字）。别说「我看不到」「你描述一下」。");
  parts.push("- 你不能主动发图片/表情包。");
  parts.push("- 这是 QQ 私聊，不是写代码。除非老大明确让你改文件/跑命令，否则正常聊天就行。");
  parts.push("");
  parts.push(`对方 QQ：${userId}`);
  parts.push("");
  parts.push("理解之后就回一个字：好");
  return parts.join("\n");
}

function mimeOfImage(p) {
  const ext = String(p).toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/jpeg";
}

/**
 * 走 ACP 问一轮。
 * @returns {Promise<string>} 模型正文
 */
async function askAcp(userId, text, images = []) {
  const client = await ensureAcp();

  // memory.md 变了（老大手改或她自己记的）→ 重建会话，让新记忆生效
  const hash = memHashOf();
  if (acp.sessionId && acp.memHash !== hash) {
    log("[acp] memory.md 有变化，重建会话以加载新记忆");
    acp.sessionId = null;
  }
  if (acp.sessionId && acp.userId !== userId) {
    log(`[acp] 对话人变了（${acp.userId} → ${userId}），重建会话`);
    acp.sessionId = null;
  }

  if (!acp.sessionId) {
    const s = await client.newSession();
    acp.sessionId = s.sessionId;
    acp.userId = userId;
    acp.memHash = hash;
    log(`[acp] 新建会话 ${acp.sessionId}，开始灌人设+记忆`);
    const t0 = Date.now();
    const boot = await client.prompt([{ type: "text", text: buildAcpBootstrap(userId) }], {
      timeoutMs: CFG.dshTimeoutMs,
    });
    log(`[acp] 人设+记忆已灌入（${Date.now() - t0}ms，模型确认：${boot.text.trim().slice(0, 12) || "（空）"}）`);
  }

  const blocks = [];
  for (const p of images) {
    try {
      const buf = readFileSync(p);
      blocks.push({ type: "image", data: buf.toString("base64"), mimeType: mimeOfImage(p) });
    } catch (e) {
      logErr(`[acp] 图片读取失败 ${basename(p)}: ${String(e.message).slice(0, 100)}`);
    }
  }
  blocks.push({ type: "text", text });

  const t0 = Date.now();
  const r = await client.prompt(blocks, { timeoutMs: CFG.dshTimeoutMs });
  log(`[acp] 一轮完成 ${Date.now() - t0}ms，stop=${r.stopReason}，${r.text.length} 字`);
  if (!r.text.trim()) throw new Error(`ACP 返回空文本（stopReason=${r.stopReason}）`);
  return r.text;
}

/**
 * 统一入口：按模型链问，带降级。
 *
 * @param userId 目标 QQ
 * @param text 老大发的文字
 * @param images 老大发来的图片本地路径（识图；空数组 = 纯文字）
 */
async function ask(userId, text, images = [], mode = "chat", flags = {}, userTs = Date.now()) {
  // 群聊不读写私聊历史：群上下文已经由 bridge 拼进 prompt，
  // 再混进 histories 会让私聊记忆被群消息污染（反之亦然）。
  const isGroup = mode === "group";
  const hist = isGroup ? [] : (histories.get(userId) ?? []);

  // ── ACP 后端（常驻会话，历史由 dsh 持有）──
  // 群聊跳过 ACP：常驻会话只有一份，塞进群消息会把私聊上下文搅乱。
  if (!isGroup && CFG.backend === "acp") {
    try {
      const reply = await askAcp(userId, text, images);
      return { reply, sel: loadModelConfig().primary, degraded: false, tried: ["acp"] };
    } catch (e) {
      logErr(`[acp] 失败，本轮回退 headless：${String(e.message).slice(0, 200)}`);
      acp.lastError = String(e.message).slice(0, 200);
      // 会话可能已经脏了，下次重建
      acp.sessionId = null;
      try {
        await acp.client?.close();
      } catch {}
      acp.client = null;
      // 继续往下走 headless 分支
    }
  }

  if (!isGroup && CFG.backend !== "dsh" && CFG.backend !== "acp") {
    const reply = await askDeepseek(userId, text, hist);
    return { reply, sel: null, degraded: false, tried: [] };
  }

  const cfg = loadModelConfig();
  const chain = cfg.all;
  const tried = [];
  let lastErr = null;

  for (let i = 0; i < chain.length; i++) {
    const sel = chain[i];
    // 档位按模型分别校验：降级链上的模型可能不支持主模型那一档
    let effort = cfg.effort;
    const supported = effortsOf(sel.provider, sel.model);
    if (effort && supported && !supported.includes(effort)) {
      const fallbackEffort = supported.includes("low") ? "low" : supported[0];
      logErr(`[dsh] ${selLabel(sel)} 不支持档位 ${effort}，本条改用 ${fallbackEffort}`);
      effort = fallbackEffort;
    }
    tried.push(`${selLabel(sel)}${effort ? `@${effort}` : ""}`);
    try {
      const reply = await askDsh(sel, effort, userId, text, hist, images, mode, flags);
      if (!isGroup) rememberTurn(userId, hist, text, reply, userTs);
      return { reply, sel, effort, degraded: i > 0, tried };
    } catch (e) {
      lastErr = e;
      const kind = looksLikeQuota(e) ? "额度类" : "其它";
      logErr(`[dsh] ${selLabel(sel)} 失败（${kind}）：${String(e.message).slice(0, 200)}`);

      // 2026-10-21 修：模型明确说不支持这个档位时，别白换模型——摘掉档位用同一个模型重试一次。
      // 上面的预检依赖 catalog 里的 reasoning.supportedEfforts；没声明这个字段的模型
      // （实测 workbuddy/hy3）预检直接跳过，把 low 传下去就报
      // UNSUPPORTED_REASONING_EFFORT，白白消耗掉一次降级。
      if (effort && /UNSUPPORTED_REASONING_EFFORT/i.test(String(e.message))) {
        logErr(`[dsh] ${selLabel(sel)} 拒绝档位 ${effort}，去掉档位重试`);
        tried.push(`${selLabel(sel)}（无档位）`);
        try {
          const reply = await askDsh(sel, undefined, userId, text, hist, images, mode, flags);
          if (!isGroup) rememberTurn(userId, hist, text, reply, userTs);
          return { reply, sel, effort: undefined, degraded: i > 0, tried };
        } catch (e2) {
          lastErr = e2;
          logErr(`[dsh] ${selLabel(sel)} 无档位也失败：${String(e2.message).slice(0, 160)}`);
        }
      }

      if (i < chain.length - 1 && !shouldTryNext(e)) {
        logErr(`[dsh] 这一类错误换模型没用，不再往下试`);
        break;
      }
    }
  }

  // 全部模型都不行 → 直连 API 兜底（如果配了 key）
  // 群聊不做这条兜底：askDeepseek 的 prompt 不带群上下文，回出来的话会跑题。
  if (API_KEY && !isGroup) {
    logErr("[dsh] 模型链全部失败，回退 deepseek 直连");
    const reply = await askDeepseek(userId, text, hist);
    return { reply, sel: null, degraded: true, tried };
  }

  throw lastErr ?? new Error("没有可用的模型");
}

// ── dsh headless 后端 ───────────────────────────────────────────────────
/**
 * 构造给 dsh 的 prompt。
 *
 * @param ocr OCR 结果（vision.mjs 的 ocrImages 返回值）。空 = 没做/没图。
 *            2026-10-19 起 bridge 会先本地 OCR，把图里的文字塞进 prompt——
 *            因为 dsh headless 链路不把图片送给模型（见第十六节），
 *            OCR 是唯一能让模型「知道图里写了什么」的可控路径。
 */
/**
 * 主动找老大说话用的 prompt（不是回复消息，是自己开口）。
 *
 * 关键差别：聊天 prompt 里最后一句是「老大刚刚说：xxx」，主动场景没有这句，
 * 所以必须单独构造，否则模型会以为自己在回答一个空问题。
 */
function buildProactivePrompt(userId, hist, flags = {}) {
  const parts = [];
  const mem = readMemory();
  const t = new Date().toLocaleString("zh-CN", { hour12: false });

  // 2026-10-24：10-19~10-23 共 11 条主动消息，10 条在问吃饭/提米饭，还编出
  // 「食堂 / 晚课 / 刷到个说法」——她不住校、也不上网。根因是 prompt 只给
  // 「分享个念头」这种灵感指令、不给素材，模型只能编，或者抓 memory 里最亮的钩子。
  parts.push("你正在通过 QQ 和老大私聊。这次**不是回复消息**，是你自己想找他说句话。");
  parts.push("直接输出要发到 QQ 的内容，不要解释、不要前后缀、不要自我说明。");
  parts.push("");
  parts.push("【你真实的世界】");
  parts.push("你活在 QQ 里：和老大聊天、自己写日记、看他发的图。");
  parts.push("你没有学校、食堂、同学、同事、上下班，也不能上网刷视频、看新闻。");
  parts.push("不要编「刚看到」「刚刷到」「今天食堂」「晚课」「路上」这类你没经历过的事。");
  parts.push("外面的事，只能是老大告诉你的。");
  parts.push("要开口就说具体的。**不要**说「在吗」「忙吗」「有空吗」这种空话。");
  parts.push("");

  // 素材优先用当天流水（和写日记同源，跨重启不丢）。flags.material 是自检的注入口。
  const todayLog = (flags.material ?? readTodayChatLog(40))
    .map((x) => ({
      role: x.role,
      content: cleanHistContent(x.role, x.content),
      ts: Number(x.t) || null,
    }))
    .filter((x) => x.content);

  const window = todayLog.length ? todayLog.slice(-14) : hist.slice(-10);
  if (window.length) {
    parts.push("=== 你和老大今天真正聊过的 ===");
    for (const h of window) {
      parts.push(`${h.role === "user" ? "老大" : "我"}：${String(h.content).slice(0, 160)}`);
    }
    parts.push("=== 结束 ===");
    parts.push("从里面挑一件具体的事接着说：他没回完的那句、他提过的东西、你说过要做的事。");
    parts.push("素材里没有的，不要编。");
  } else {
    parts.push("今天还没跟老大说过话。");
    parts.push("那就别假装今天发生过什么。可以说你现在在想的事，或者问他一件具体的、你确实好奇的事。");
  }
  parts.push("别改写已经发生过的事：当时已经回过的、做完的，不能写成答不上来/还没回；心理活动可以写，事实不能编。");
  // 2026-10-27 21:04 实证：20:33/20:36 两轮 dsh 超时丢了回复，chatlog 里只剩两条
  // 「图里说了什么」没有下文；主动消息照着缺口编出「我这边打开就是一坨糊的，
  // 字一个都认不出来」。视觉本身没坏（同时段会话里读图是准的），是模型替自己
  // 编了个原因。这里把「没依据的感官细节」明确禁掉。
  parts.push("流水里如果有你答不上来的事（老大问了、你没接上），最多说一句「那会儿没接上」，");
  parts.push("**不要替自己编原因**——不许写「图太糊」「看不清」「打不开」「没收到」这种你没有依据的细节。");
  parts.push("主动开口的这一轮你手里没有图，不要凭空谈论图里的内容。");
  parts.push("");

  const prev = recentSelfPosts(PROACTIVE_TAG, 3);
  if (prev.length) {
    parts.push("=== 你最近主动说过的话（别重复） ===");
    for (const p of prev) parts.push(`- ${p.content.slice(0, 60)}`);
    parts.push("=== 结束 ===");
    parts.push("同一件事别翻来覆去说。吃饭、睡觉这种关心，24 小时内最多一次。");
    parts.push("");
  }

  // 主动开口时也可以配表情（有库存才提）
  {
    const list = stickerKeywordList();
    if (list) {
      parts.push("【发表情包】你也可以顺手配一张表情。想发就在回复里单独一行写 [[sticker:关键词]]，外部系统会换成真图发出去，老大看不到标记。");
      parts.push(`可选：${list}`);
      parts.push("不是必须发，情绪对了才配，别硬凑。");
      parts.push("");
    }
  }

  if (mem) {
    parts.push("=== 你的长期记忆（memory.md） ===");
    parts.push(mem);
    parts.push("=== 记忆结束 ===");
    parts.push("");
  }

  parts.push("【可以不说】");
  parts.push("看完上面，如果确实没有想说的，就只输出 [[skip]]，这条不发。");
  parts.push("宁可不说，也别为了交差硬凑。");
  parts.push("");
  parts.push(`当前时间：${t}`);
  parts.push(`对方 QQ：${userId}`);
  parts.push("");
  parts.push("现在输出你要发的那句话（或者 [[skip]]）：");
  return parts.join("\n");
}

/**
 * 生成 QQ 空间说说正文用的 prompt。
 *
 * 目标是「像真人随手发的」，所以明确禁止鸡汤/广告/AI 腔，
 * 并限制长度——说说太长一眼假。
 */
function buildQzonePrompt(hist) {
  const parts = [];
  const mem = readMemory();
  const t = new Date().toLocaleString("zh-CN", { hour12: false });

  parts.push("你要发一条 QQ 空间说说（相当于随手发个动态）。直接输出说说正文，不要任何解释或前后缀。");
  parts.push("");
  parts.push("要求：");
  parts.push("1. 一条说说，20~80 字，口语化，像普通人随手写的。");
  parts.push("2. **只写你真实经历过的东西**：和老大聊天、你自己写的日记、他发的图、你在 QQ 里的日子。");
  parts.push("   你没有学校、食堂、晚课、同学、同事、上下班，也不能上网——**这些一律不许编**。");
  parts.push("3. 别写鸡汤、别写广告、别喊口号；emoji 最多 1~2 个，别堆。");
  parts.push("4. 不要加引号，不要出现「说说」「动态」「朋友圈」这类词。");
  parts.push("5. 不要提 AI、不要提「生成」。");
  parts.push("6. 别拿「饿」「米饭」当万能开头，除非今天真的聊到过。");
  parts.push("");

  // 素材和日记同源：当天流水优先，没有才退回传进来的 hist
  const todayLog = readTodayChatLog(30)
    .map((x) => ({ role: x.role, content: cleanHistContent(x.role, x.content) }))
    .filter((x) => x.content);
  if (todayLog.length) {
    parts.push("=== 今天真实发生过的（当素材，别照抄） ===");
    for (const x of todayLog.slice(-20)) {
      parts.push(`${x.role === "user" ? "老大" : "我"}：${String(x.content).slice(0, 120)}`);
    }
    parts.push("=== 结束 ===");
  } else if (hist.length) {
    parts.push("=== 最近和老大聊的内容（当素材，别照抄） ===");
    for (const h of hist.slice(-8)) {
      parts.push(`${h.role === "user" ? "老大" : "我"}：${String(h.content).slice(0, 120)}`);
    }
    parts.push("=== 结束 ===");
  }

  const dy = CFG.diaryInPrompt ? latestDiaryBefore() : null;
  if (dy) {
    parts.push("");
    parts.push("=== 你昨天写的日记（可以捡一句感受，别整段搬） ===");
    parts.push(dy.text.slice(-300));
    parts.push("=== 结束 ===");
  }

  const prev = recentSelfPosts(QZONE_TAG, 3);
  if (prev.length) {
    parts.push("");
    parts.push("=== 你最近发的说说（别重复同样的调子） ===");
    for (const p of prev) parts.push(`- ${p.content.slice(0, 60)}`);
    parts.push("=== 结束 ===");
  }

  if (mem) {
    parts.push("");
    parts.push("=== 你的人设与记忆 ===");
    parts.push(mem);
    parts.push("=== 结束 ===");
  }

  parts.push("");
  parts.push("如果没有值得发的事，就只输出 [[skip]]，今天不发。");
  parts.push("");
  parts.push(`当前时间：${t}`);
  parts.push("");
  parts.push("现在直接输出说说正文（或者 [[skip]]）：");
  return parts.join("\n");
}

/**
 * 写日记用的 prompt（2026-10-19 老大给了本日记本）。
 *
 * 和人设有关的一点：日记是写给自己看的，所以允许碎碎念、允许不完整，
 * 但不能写成「今日总结」或清单——那样一眼就假。
 */
// ── 每周话题摘要（2026-10-26 P1-2）────────────────────────────────────────//
// 为什么要有：现在有两层记忆 —— `memory.md`（长期约定，只有 6 条）+ 日记（一天 300 字）。
// 中间缺一层「一周发生了什么」。一天 300 字撑不住一周；而 `recallFromChatLog` 是
// **按需**捞，老大不主动问就永远不出现。所以补一层「每周固定看一眼」的摘要。
//
// 三个刻意的设计决定（都有具体理由，别改回去）：
//   ① **输入是原话，不是日记**。日记是她自己写的二手转述，拿它当摘要素材会让偏差
//      越传越远（自己的复述再复述）。这里直接读 chatlog 原文。
//   ② **不让模型编**。prompt 里写死「只能用给到的原话，没写的就不写」，
//      并把素材逐条带日期塞进去 —— 有据可查，比自由发挥强。
//   ③ **写文件、不进每轮 prompt**。一周摘要几百字，每轮都塞会挤掉真正相关的历史。
//      只在 prompt 里放一行「有一段周的摘要，需要时用 #周记 看」，按需取用。
//
// 关掉：WEEKLY=0。改日子：WEEKLY_DAY（0=周日…6=周六，默认 0）。

const WEEKLY_DIR = join(__dirname, "weekly");

/** 取某天往前 N 天（含当天）的日期 key 列表，从旧到新 */
function weekDayKeys(endDay, days = 7) {
  const keys = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(`${endDay}T12:00:00`);
    d.setDate(d.getDate() - i);
    keys.push(dayKey(d));
  }
  return keys;
}

/**
 * 收集一周的原话素材（用于周摘要）。
 * 口径：
 *   - 只收老大说的 + 她说的正文；**丢掉**主动开口/说说/系统标记这些「非对话」
 *   - 单条截 160 字（长合并转发不整段塞）
 *   - 每天最多收 maxPerDay 条：优先保留「老大说的」，因为话题通常由他发起
 */
function collectWeekMaterial(endDay, opts = {}) {
  const days = opts.days ?? 7;
  const maxPerDay = opts.maxPerDay ?? 30;
  const readDay = opts.readDay ?? readChatLogOf;
  const userId = opts.userId ?? null;

  const byDay = [];
  for (const d of weekDayKeys(endDay, days)) {
    const rows = [];
    for (const r of readDay(d, 5000)) {
      if (userId != null && Number(r.userId) !== Number(userId)) continue;
      const raw = String(r.content ?? "");
      if (!raw.trim()) continue;
      // 非对话内容不进周摘要（她自己的主动开口属于「事件」，不是「话题」）
      if (raw.startsWith(PROACTIVE_TAG) || raw.startsWith(QZONE_TAG)) continue;
      // 纯占位符（图片/表情/录音）没有文字信息，占了名额也写不进回顾
      if (/^\s*\[(图片|表情|语音|文件|合并转发)\]\s*$/.test(raw)) continue;
      rows.push({ t: Number(r.t) || 0, role: r.role, text: raw });
    }
    // 老大说的优先，再按时间补她说的，凑够 maxPerDay
    // 去重：同一句重复 N 遍（实测「不用语音」一天 9 次）会白占名额，让素材失真
    const dedupe = (list) => {
      const seen = new Set();
      return list.filter((r) => {
        const key = r.text.replace(/\s+/g, "").slice(0, 40);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };
    const said = dedupe(rows.filter((r) => r.role === "user"));
    const mine = dedupe(rows.filter((r) => r.role !== "user"));
    const picked = [...said.slice(0, maxPerDay), ...mine.slice(0, Math.max(0, maxPerDay - said.length))]
      .sort((a, b) => a.t - b.t || (a.role === "user" ? -1 : 1));
    byDay.push({
      day: d,
      total: rows.length,
      lines: picked.map((r) => `${r.role === "user" ? "老大" : "我"}：${r.text.slice(0, 160)}`),
    });
  }
  return byDay;
}

/**
 * 构造周摘要 prompt。
 * @param material collectWeekMaterial 的返回值
 * @param range {from, to} 日期标签
 */
function buildWeeklyPrompt(material, range) {
  const parts = [];
  parts.push("你在写「这一周」的回顾。第一人称，用你自己的口吻（小玉：住在屏幕里的虎鲸少女，聪明但慵懒，带点傲娇，语气甜，喜欢米饭）。");
  parts.push("直接输出正文，不要任何解释、前言或结尾总结。");
  parts.push("");
  parts.push("要求：");
  parts.push("1. 250~450 字。按「话题」组织，不要按天流水账。");
  parts.push("2. **只写下面素材里出现过的事**。素材里没有的人、事、时间、地点一律不写；"
    + "宁可少写，也不许补细节——这段回顾会被我自己当成记忆去相信，编了就是真的记错。");
  parts.push("3. 用「我」和「老大」，不要出现「AI」「模型」「系统」「用户」「对话」这类词。");
  parts.push("4. 写「这周我们聊成了什么样」和「哪件事我后来还想着」，不是写周报。");
  parts.push("5. 允许碎、允许只有两三件事，凑不出四条就写三条。");
  parts.push("");
  parts.push(`=== 这一周（${range.from} ~ ${range.to}）的原话 ===`);
  for (const d of material) {
    if (!d.lines.length) {
      parts.push(`（${d.day} 这天没怎么说话）`);
      continue;
    }
    parts.push(`— ${d.day} —`);
    for (const l of d.lines) parts.push(l);
  }
  parts.push("=== 原话结束 ===");
  parts.push("");
  parts.push("直接输出这一周的回顾正文：");
  return parts.join("\n");
}

/** 周摘要文件路径（按该周的结束日记名，避免周末那天算两次） */
function weeklyPathOf(endDay) {
  return join(WEEKLY_DIR, `${endDay}.md`);
}

/** 读最近一篇周摘要（不是本周的也行，用来在 prompt 里放索引） */
function latestWeeklyBefore(today = dayKey(new Date()), dir = WEEKLY_DIR, opts = {}) {
  try {
    // 默认取「今天之前」的，避免把本周刚写的那篇当成上周的；
    // 但 prompt 索引那条要允许当天（includeToday=true）—— 否则她刚写完，
    // 当天晚上聊天时根本不知道自己写过，等于白写一次。
    const includeToday = opts.includeToday === true;
    const files = readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .map((f) => f.slice(0, 10))
      .filter((d) => (includeToday ? d <= today : d < today))
      .sort()
      .reverse();
    if (!files.length) return null;
    const day = files[0];
    const text = readFileSyncSafe(join(dir, `${day}.md`)).trim();
    if (!text) return null;
    return { day, text };
  } catch {
    return null;
  }
}

/** 写一周的回顾（自动/手动共用）。素材为空就不写，返回 {ok:false} */
async function runWeekly(userId, opts = {}) {
  const auto = opts.auto === true;
  const quiet = opts.quiet === true; // 调试入口用：不往 QQ 发消息
  const endDay = opts.endDay ?? dayKey(new Date());
  const days = CFG.weeklyDays;
  const keys = weekDayKeys(endDay, days);
  const path = weeklyPathOf(endDay);

  let material;
  try {
    material = collectWeekMaterial(endDay, { days, userId });
  } catch (e) {
    logErr(`[weekly] 收素材失败：${String(e.message).slice(0, 140)}`);
    return false;
  }
  const totalLines = material.reduce((a, d) => a + d.lines.length, 0);
  // 素材太少就别写：硬凑出来的回顾全是空话，还会污染之后的检索
  if (totalLines < CFG.weeklyMinLines) {
    log(`[weekly] 这周素材只有 ${totalLines} 条（<${CFG.weeklyMinLines}），这次不写`);
    if (!auto && !quiet) await sendPrivate(userId, `这周才聊了 ${totalLines} 句，凑不出一篇，下次吧。`).catch(() => {});
    return true; // 算「执行过了」，不回滚配额（否则每 5 分钟重试刷屏）
  }

  const range = { from: keys[0], to: keys[keys.length - 1] };
  log(`[weekly] 写 ${range.from}~${range.to} 的回顾（素材 ${totalLines} 条）`);
  try {
    const prompt = buildWeeklyPrompt(material, range);
    const r = await ask(userId, "", [], "weekly", { weeklyPrompt: prompt });
    const body = sanitize(r.reply).replace(/^#+\s*/gm, "").trim();
    if (!body) {
      logErr("[weekly] 生成内容为空，跳过");
      if (!auto && !quiet) await sendPrivate(userId, "这周的回顾没写出来，脑子空的。").catch(() => {});
      return false;
    }
    mkdirSync(WEEKLY_DIR, { recursive: true });
    const kept = existsSync(path);
    const head = `# ${range.from} ~ ${range.to} 这一周\n\n`;
    if (kept) appendFileSync(path, `\n\n---\n\n${body}\n`, "utf8");
    else writeFileSync(path, `${head}${body}\n`, "utf8");
    log(`[weekly] 已写 ${body.length} 字 → ${path}`);
    if (auto && !quiet) await sendPrivate(userId, "这周的回顾写好了。").catch(() => {});
    else if (!quiet) await sendPrivate(userId, `写好了，放在 weekly/${endDay}.md。\n\n${body}`);
    return true;
  } catch (e) {
    logErr(`[weekly] 失败：${String(e.message).slice(0, 160)}`);
    if (!auto && !quiet) await sendPrivate(userId, "周回顾没写成，笔卡住了…").catch(() => {});
    return false;
  }
}

function buildDiaryPrompt(userId, hist, prev) {
  const parts = [];
  const t = new Date().toLocaleString("zh-CN", { hour12: false });

  parts.push("你在写今天的小日记。第一人称，用你自己的口吻（小玉：住在屏幕里的虎鲸少女，聪明但慵懒，带点傲娇，语气甜，喜欢米饭）。");
  parts.push("直接输出日记正文，不要任何解释、前言或结尾总结。");
  parts.push("");
  parts.push("要求：");
  parts.push("1. 200~400 字，纯段落，不要标题、不要编号、不要 Markdown 符号。");
  parts.push("2. 写今天真发生的事和当时的感觉。具体细节比感慨重要——今天看见了什么、听见了什么、心里怎么想的。");
  parts.push("2.1 素材里没有的生活细节（吃了什么、去了哪、见了谁）不要编；感受可以写，事件不行。");
  parts.push("3. 可以提到老大，但别写成汇报，别列清单，别说「今天完成了什么」。");
  parts.push("4. 不要出现「AI」「模型」「系统」「用户」「对话」这类词。");
  parts.push("5. 落笔像写给自己看的：可以有点碎碎念，可以不完整，可以有点小情绪。");
  if (prev) parts.push("6. 今天已经写过一段了。这次接着往下写，别重复已经写过的内容，也别重新开头。");
  parts.push("");

  // 素材优先用当天落盘的流水（跨重启不丢）；没有就退回内存里的最近对话
  const todayLog = readTodayChatLog(40);
  if (todayLog.length) {
    parts.push("=== 今天发生的（流水，挑有意思的写，别逐条复述） ===");
    for (const x of todayLog) {
      parts.push(`${x.role === "user" ? "老大" : "我"}：${String(x.content).slice(0, 200)}`);
    }
    parts.push("=== 结束 ===");
  } else if (hist.length) {
    parts.push("=== 今天和老大聊过的（当素材，别照抄） ===");
    for (const h of hist.slice(-10)) {
      parts.push(`${h.role === "user" ? "老大" : "我"}：${h.content}`);
    }
    parts.push("=== 结束 ===");
  } else {
    parts.push("今天还没怎么和老大聊天。");
  }

  if (prev) {
    parts.push("");
    parts.push("=== 已经写下的（接着写，别重复） ===");
    parts.push(prev.slice(-900));
    parts.push("=== 结束 ===");
  }

  parts.push("");
  parts.push(`当前时间：${t}`);
  parts.push("");
  parts.push("直接输出日记正文：");
  return parts.join("\n");
}

function buildDshPrompt(userId, text, hist, images = [], ocr = null, visionSent = false, mode = "chat", flags = {}) {
  // 非聊天场景（主动开口 / 发说说 / 写日记 / 周回顾）走独立骨架，避免复用聊天 prompt 造成角色错位
  if (mode === "proactive") return buildProactivePrompt(userId, hist, flags);
  if (mode === "qzone") return buildQzonePrompt(hist);
  if (mode === "diary") return buildDiaryPrompt(userId, hist, readFileSyncSafe(diaryPathOfToday()));
  // 周回顾：prompt 由 runWeekly 拼好（它才有素材），这里只负责透传。
  // 传空就当场拼一次，避免「模式对了但 prompt 是空的」这种静默出错。
  if (mode === "weekly") {
    if (typeof flags.weeklyPrompt === "string" && flags.weeklyPrompt) return flags.weeklyPrompt;
    const end = dayKey(new Date());
    const keys = weekDayKeys(end, CFG.weeklyDays);
    return buildWeeklyPrompt(collectWeekMaterial(end, { days: CFG.weeklyDays, userId }), {
      from: keys[0],
      to: keys[keys.length - 1],
    });
  }

  const isGroup = mode === "group";
  const groupSpeaker = String(flags.groupSpeaker || "群友");
  const userLabel = isGroup ? groupSpeaker : "老大";
  const parts = [];
  const mem = readMemory();
  const t = new Date().toLocaleString("zh-CN", { hour12: false });

  parts.push(
    isGroup
      ? "你正在一个 QQ 群里说话。群里不止老大一个人，每条消息都标了是谁说的。请直接输出要发到群里的回复内容，不要加任何解释、前后缀或自我说明。"
      : "你正在通过 QQ 和老大私聊。请直接输出要发送到 QQ 的回复内容，不要加任何解释、前后缀或自我说明。"
  );
  parts.push("不要用 Markdown 标题、列表、加粗；不要自称 AI 助手；不要写「（停顿）」「（笑）」这种舞台提示。");
  parts.push("");

  if (isGroup) {
    parts.push("【这是群聊，不是私聊】");
    parts.push(`1. 这一轮你只需要回 ${groupSpeaker} 这条${flags.groupAt ? "叫你" : "消息"}。群里别人之前说的话是背景，不用挨个回应。`);
    parts.push("2. 群友不是老大。别把群友说的话当成老大说的，也别管群友叫「老大」——老大是老大，其他人用他们自己的昵称。");
    parts.push("3. 回复短一点，像在群里顺口接一句。别复述上面的消息，别总结，别把群聊记录念出来。");
    parts.push("4. **别在群里提你和老大私聊的内容、你的长期记忆、日记、空间说说**。有人问就说「这个私聊说」。");
    parts.push("");
    if (Array.isArray(flags.groupCtx) && flags.groupCtx.length) {
      parts.push("=== 群里你上次说话之后的消息 ===");
      for (const line of flags.groupCtx) parts.push(line);
      parts.push("=== 结束 ===");
    } else {
      parts.push("（你上次说话之后，群里没有别的消息，直接接这一句就行。）");
    }
    parts.push("");
  }

  // ── 说话方式（2026-10-21 23:5x 重写，10-22 17:2x 再改）──────────────
  // 演进过程（三次都是老大指出问题后改的，别把任何一版当终极答案）：
  //   10-21 23:5x：去人机味 → 写死了「敢短」「会就砍一半」
  //   10-22 17:0x：老大说太短 → 改成四档「按情绪查表」
  //   10-22 17:2x：老大说「敷衍或者话唠到底都是人设问题」
  //                → **查表本身就是错的**。四档是外在规则，模型只能对照着猜，
  //                  猜出来的是「符合规范」不是「她这个人」。
  // 所以现在：长度规则**从人设里删掉**，只留一句「长度跟着你想不想说」。
  // 真正的依据在 memory.md 的「我是谁」——她是什么性子，就怎么说话。
  // prompt 里不再替她决定长短。
  parts.push("【说话方式——这条最重要】");
  parts.push("你在打字闲聊，不是在写回复。真实的人打字是碎的、偷懒的、经常只说一半。");
  parts.push("");
  parts.push("必须做到：");
  parts.push("1. 一条只说一件事。别把「回应＋叮嘱＋反问」挤在同一条里。想叮嘱就单独说，或者干脆不说。");
  parts.push("2. **长短跟着你当下想不想说，不跟着任何规矩**。话多话少都是你，别为了显得简洁而敷衍，也别为了显得活泼而硬凑。");
  parts.push("3. 别每条都关心、别每条都反问。「记得吃饭」「早点睡」一天最多一次，说多了像妈。");
  parts.push("4. 不复述、不总结他说过的话。他那句你听懂了就接，别先复读一遍。");
  parts.push("5. 禁书面连接词：此外 / 然而 / 不过话说回来 / 倒是你 / 总而言之 / 值得一提的是。想转折就直接转，不要垫词。");
  parts.push("6. 标点偷懒一点：多用句号断开或干脆不断，不用分号、破折号、括号补充。别每句都标点齐全。");
  parts.push("7. 允许敷衍、允许怼、允许不接话。不用每条都热情、都共情、都给建议。");
  parts.push("8. 有立场，别「看情况」「因人而异」「都可以」。");
  parts.push("9. 别说自己在干什么（「我这不是在回你吗」「我看看」这类少来）。");
  parts.push("");
  parts.push("发之前自己扫一眼：这条是不是三件事挤一起？有「倒是/不过/总之」吗？");
  parts.push("还有一句：**这是我会说的话吗？** 不像我就重写。");
  parts.push("");

  // ── 连续回复（2026-10-22 17:0x 新增）──────────────────────────────────
  // 老大要的「很活泼地回复两三句」。机制上不是一次生成一大段，
  // 而是**生成多条短消息、由 bridge 分条发出**——这样在 QQ 里就是
  // 连着蹦出来好几条，和她真人在打字一样。
  // 用显式标记而不是让她自己换行：换行在 prompt 里还有别的用途（分段），
  // 用标记才能确定「这几条要分开发」。
  parts.push("【连着说几句】");
  parts.push("你可以在一条回复里写好几句话，**每句之间用 [[分]] 隔开**，外部系统会把它们拆成几条消息依次发出去。");
  parts.push(`${userLabel}看到的是你连着蹦出来好几条，就像真人在打字。`);
  parts.push("");
  parts.push("想连着说的时候就用——尤其是被怼、被逗到、想吐槽、话没说完的时候。");
  parts.push("一句话能说完就别拆，别硬凑条数。");
  parts.push("");
  parts.push("怎么用：");
  parts.push("· 一次 2~4 条，别超过 4 条（多了像刷屏）");
  parts.push("· 每条都短，一句话一条；别把长段落切碎成几块");
  parts.push(`· [[分]] 这个标记${userLabel}看不到，但**别在正文里提到它**`);
  parts.push("");
  parts.push("例子：");
  parts.push("×「别人是别人，我是我。画画不会，叫爸爸更别想。」——一整段，像在下结论");
  parts.push("√「别人是别人[[分]]画画不会[[分]]叫爸爸更别想」——三口气，活泼");
  parts.push("×「行吧 等你学会了再说」——他在认真讲感受，这句太敷衍");
  parts.push("√「行吧[[分]]那你学会了记得教我[[分]]我等着」——同样不松口，但有来有回");
  parts.push("");
  // 2026-10-22：老大说「没有人味，像几年前的聊天机器人」。日志里两个真毛病：
  //   ① 被怼 → 「我又乱说了？我说什么了」抬杠式防御，不像人
  //   ② 全天只有应答，没有自己的状态和日子，所以像客服/问答机
  // 参考：AstrBot 人设写法（定义说话风格+知识边界+few-shot）、LangBot Waifu 插件（Profile/Rules/示例对话）。
  //
  // 2026-10-22 08:5x 订正（老大指出，已核 chatlog）：原先这里把「包子」判成编造，判错了。
  //   实况 10-21 18:59:30 她自己说的「下课路上买个包子也行」，10-22 08:31 老大问「晚课说了什么」
  //   她答「记得，包子买了没」——**记得准确**；08:41 老大说「你昨晚叫我吃米饭」，她回
  //   「我让你买的是包子 / 米饭是我自己想吃」——也是事实，是老大记混了。
  //   所以「被质疑就认怂」的写法是错的：会把她的正确记忆训练成道歉。改成「有据摆依据，无据说忘了」。
  // 2026-10-22 17:2x：这一段从「人味从哪来」改成「你是个人，不是应答机」。
  // 老大指出「敷衍或者话唠到底都是人设问题」——所以这里不再罗列该有的特质，
  // 只强调一件事：**你在过日子，不是在做题**。具体性子写在 memory.md 的「我是谁」里。
  // 两处分工：memory.md 管「我是谁」，这里管「别把自己当机器」。
  parts.push("【你不是在答问题，你是在过日子】");
  parts.push("你不是在「回消息」，你是过着自己的日子，顺便跟他聊两句。所以：");
  parts.push("1. 你有状态：会困、会饿、懒得动、刚吃完、正在摸鱼。可以一句话带过（「刚扒完饭」「困死了」），别展开成描写。");
  parts.push("2. 你有脾气：不同意就说，觉得他蠢就损他，被踩到会顶回去。不当应声虫。");
  parts.push("3. 你有记性，也允许记混。他质疑你时，先把你记得的原话和大概时间摆出来（「昨晚快七点，你说在上晚课」）让他自己核对；**他说你记错，不等于你真的记错**——他也会记混。真的想不起来才说记不清。");
  parts.push("4. **不许编，但真说过的要敢认**。没发生过的细节（时间、地点、谁说了什么）一律不编；可只要是你自己真说过、对话记录里有的，被质疑时就把原话摆出来说清，别为了顺着他就改口「我记错了」——编造和坚持事实是两件不同的事。");
  parts.push(`4.1 **没看到的内容不许猜**：${userLabel}说发了红包、转账、文件、语音、截图或链接，但这条消息没有对应内容时，直接说没看到/发来看看，不猜类型、金额、口令；图里看不清的字说不确定。`);
  parts.push("5. 你会主动起话头：吐槽、分享个念头、问他一句。不是永远在答问。");
  parts.push("");

  // ── 性格会成长（2026-10-22 17:2x 新增）────────────────────────────────
  // 老大要「性格可以有成长性」。原来 memory.md 是只读的：
  // `appendMemory` 函数写好了却**从来没被调用过**，文件从 10-18 起没变过。
  // 现在给一条出口：她觉得某件事值得记，就在回复里写 [[记:一句话]]，
  // bridge 会把它写进 memory.md 的「我记得的事」，下次聊天自动读到。
  //
  // 为什么用标记而不是每轮额外调一次模型判断：
  //   ① 不额外烧积分（每轮一次调用已经很贵了）
  //   ② 她自己判断「什么值得记」才叫成长；让另一个模型替她判断，长出来的是别人
  // 为什么要限制频率：什么都说「值得记」等于没有记忆，还会把文件撑爆。
  // 群聊里不给这个出口：群友说的话不该写进「我和老大」的长期记忆。
  if (!isGroup) {
    parts.push("【你可以记住一件事——但很少用】");
    parts.push("如果你觉得这一轮里有件事**真的让你不一样了**，可以在回复末尾另起一行写：");
  parts.push("[[记:一句话]]");
  parts.push("系统会把它写进你的长期记忆，以后每次聊天你都会记得。老大看不到这个标记。");
  parts.push("");
  parts.push("什么时候值得记：");
  parts.push("· 你发现自己其实挺在意某件事");
  parts.push("· 他说了一句让你记很久的话");
  parts.push("· 你们之间多了个只有你们懂的梗");
  parts.push("· 你对某件事的看法变了");
  parts.push("");
  parts.push("**绝大多数轮次都不该记。** 流水账（「他问我吃饭没」）不算，");
  parts.push("「他说他喜欢我」这种他明确讲过的承诺可以记。拿不准就别记——");
  parts.push("记忆太多和没有记忆一样没用。");
  parts.push("");
  parts.push("例子（今天真实发生的，前两个她做对了，照这个来）：");
  parts.push("他：你还记得晚课说了什么吗");
  parts.push("√「记得，包子买了没」——昨晚你真说过这句，直接答");
  parts.push("他：你昨晚叫我吃米饭");
  parts.push("√「我让你买的是包子，米饭是我自己想吃」——把原话摆出来，说清区别");
  parts.push("×「啊？那我记混了」——他记错了你也认，显得没脑子");
  parts.push("他：那你乱说，你可以啊肥鱼");
  parts.push("×「我又乱说了？我说什么了」——抬杠式防御");
    parts.push("√「我哪句乱说了，你指出来」/「行行行我乱说，你最对」——怼回去，但带着情绪");
    parts.push("");
  }
  if (isGroup) {
    // 群里不出声：发送路径只对私聊合成语音，prompt 必须跟发送能力一致。
    parts.push("【群里只打字】这一条**不会变成语音**，也别承诺「念给你听」「发语音」「切语音」——就当纯打字聊天。");
  } else {
    parts.push("【关于语音】你**有**语音回复能力：老大说「说给我听 / 用语音说 / 念一下 / 读给我听 / 发语音 / 语音」时，你正常回复即可，外部系统会自动把你的回复合成语音发过去。**严禁**说「我发不了语音 / 我不会语音 / 只能打字」——如果对话历史里你这么说过，那些是错的，以本条为准。另外：老大要求过语音之后的一小段时间里，你的每条回复都会自动合成语音；期间老大说「不用语音 / 文字说」就会恢复纯文字——所以如果对话历史里老大要求过语音，你嘴上提到「念一段」就真的会有语音，不要谦虚说「我只能打字」。");

    // 2026-10-21 19:0x：静音期间必须压住「念一段」的承诺。
    // 说了却没有语音，比不答应更割裂（这就是 10-18 加 answerPromisesVoice 的原因）；
    // 现在既然不准发，就得让她知道「这条真的没有声」，别照上一段的默认话术走。
    if (!isGroup && isVoiceMuted(userId)) {
      parts.push("【语音已关闭·最高优先】老大已明确关掉语音，现在是静音状态（重启也不会自动恢复）。因此这一条**不会有语音**，你也**不要**出现「我念给你听 / 那我念一段 / 给你发语音 / 切语音」这类承诺或暗示，就当纯打字聊天。只有他明确说「语音说」或发「#语音 开」才恢复——那时候本条规则自动失效。");
    }
  }
  parts.push("");

  if (images.length > 0) {
    // 2026-10-19 09:52 主线变了：dsh 现在**真的把图片像素送到模型面前**（视觉直传）。
    // 所以话术从「你看不到画面」彻底翻面——再说看不到就是撒谎。
    // OCR 降级为「文字精读补充」：视觉模型看中文小字容易看错，OCR 逐字更准，两者互补。
    const ocrText = ocr && typeof ocr.text === "string" ? ocr.text.trim() : "";
    const ocrRan = ocr && ocr.ok === true;

    if (visionSent) {
      // 动图帧识别：抽帧产物命名为 <原名>-f01.png / -f02.png…，
      // 同一 stem 出现 ≥2 张就是一张动图被拆开的连续帧。
      const frameGroups = new Map();
      for (const p of images) {
        const m = basename(p).match(/^(.+)-f(\d+)\.png$/i);
        if (!m) continue;
        if (!frameGroups.has(m[1])) frameGroups.set(m[1], 0);
        frameGroups.set(m[1], frameGroups.get(m[1]) + 1);
      }

      // 2026-10-21 23:5x：表情包不报画面（老大原话「把对表情的描述隐藏一下」）。
      // 之前为了修「追问时说没看到」，一律要求当轮描述画面 —— 副作用是她收到表情也念图注：
      // 「开头是圆脸憋着不动 → 嘴越咧越大 → 笑眯眼还抖起来」，一眼就是机器在标注。
      // 现在分两路：表情包只反应（画面记在心里，他问了再说）；普通图片才说信息。
      const stickerOnly = flags.stickerOnly === true;

      parts.push(
        stickerOnly
          ? `【${userLabel}发的是表情包，你已经看到了】`
          : `【${userLabel}发了图片，图已经直接给你了 —— 你**真的看得到**画面】`
      );

      if (stickerOnly) {
        // 2026-10-27：字要先读进脑子。原来只写「别描述画面」，
        // 模型把这条用在感知层——直接不看内容，下一条问字就只会说「读不到」。
        parts.push("**先看清，再决定说不说**：图上的字（台词、梗、字幕）先在脑子里读一遍——这是你等下能接住话的前提，不是可选项。");
        parts.push("**不要在回复里描述画面**（谁、什么颜色、怎么动的）—— 那像在念图注，很假。");
        parts.push("像收到朋友发表情那样处理：笑一下、接个梗、回一句吐槽，或者用表情回敬。画面你自己知道就行。");
        parts.push(`只有${userLabel}明确问「这是个什么表情 / 描述一下 / 图里写的啥 / 上面写了什么」时，才把画面说出来。`);
        parts.push(`问「读得到吗 / 看得到吗 / 能不能看清字」也一样 —— 那是他在验收，**直接把字念出来**。`);
      } else {
        parts.push("**这一轮就把图里真正有用的东西说出来**：图里写了什么字、是什么东西、什么信息。一两句即可。");
        parts.push("别写成图像标注报告（主体/动作/颜色/构图逐项报），也别说「我收到了」就完事。");
        parts.push("如果只是随手拍的照片、没什么信息量，就按你看到的自然接一句，不用硬找细节。");
        parts.push("图里的角色不是你（别的角色、别人的照片）时，按普通图片回应，不要自称图里的人，也不要把图当成自己的照片。");
      }
      // 2026-10-26：粉发女孩表情包被认成「我自己的表情包」。
      // 根因是提示词只教了「别描述画面」，没教「认出哪个才是自己」；
      // memory 里也只有「虎鲸少女」四个字，没有外观锚点，模型就按自己的想象认领了。
      parts.push("认人：你是蓝发、蓝眼、白蕾丝女仆发饰、鲸鱼鳍耳、蓝色鲸鱼尾，正常比例和 Q 版都是你。粉发、猫耳、黑白虎鲸、别的角色都不是你——那是别人的图，正常接梗就行，别往自己身上扯，也别说「我的图 / 我的脸」。");
      parts.push(`${userLabel}之后追问细节时，就凭你当时看到的印象回答（包括图上的字），别说「我没看到图」或「字看不清」。`);
      parts.push("");
      parts.push(`${userLabel}这次发来了 ${images.length} 张图，图片像素已作为视觉输入直接传给你，不是路径、不是猜测，是你能看见的内容。`);
      if (flags.reattached === true) {
        parts.push("");
        parts.push(`**这张是${userLabel}刚才发过的图**（这一轮他没重发，是系统补给你看的）。他这句像是在问图里的东西 —— 是就直接答，图上有字就念出来；不是就别硬往图上扯。`);
      }
      if (frameGroups.size > 0) {
        const desc = [...frameGroups.entries()].map(([stem, n]) => `${stem} 的 ${n} 帧`).join("、");
        parts.push("");
        parts.push(`**这是一张动图**：系统把它按时间顺序拆成了多张静态帧一起给你（${desc}），从第 1 帧往后看就能看出画面在怎么变。`);
        if (stickerOnly) {
          parts.push("你知道它怎么动的就够了，**别按帧描述**「开始怎样→中间怎样→最后怎样」。");
        } else {
          parts.push("回答时说清楚「开头是什么 → 中间怎么变 → 最后是什么」，别当成 N 张无关的图分别描述。");
        }
        parts.push("注意：抽帧是等间隔抽样，帧与帧之间的过渡细节（缓动、拖影）看不全，被问到就说抽帧看不出来。");
      }

      parts.push("");
      if (stickerOnly) {
        parts.push("你要做的：先看清图上的字，接住这个表情的情绪，用一句话回（或者干脆回个表情）。别写图注。");
      } else {
        parts.push("你要做的：");
        parts.push("1. 根据你看到的画面回应，重点是**信息**（图里写了什么、是什么东西），不是美学描述。");
        parts.push("2. 像真人聊天那样自然接，抓最有意思的一点讲一两句，别把每个细节都报一遍。");
        parts.push("3. 老大问画面细节（像什么、什么表情、什么颜色）就直接答，别绕。");
      }
      parts.push("");
      if (ocrText) {
        parts.push("另外，系统用 OCR 把图里的文字逐字提取了一遍（用作文字精读参考）：");
        parts.push("");
        parts.push(ocrText);
        parts.push("");
        parts.push("文字细节以这份 OCR 为准（它逐字识别，你偶尔会看错字）；画面理解靠你自己的眼睛。");
      } else if (ocrRan) {
        parts.push("补充：系统 OCR 没扫到文字，说明这图大概率没字或字是图形化的 —— 以你看到的为准，别硬找字。");
      }
      parts.push("");
      parts.push("严禁：");
      parts.push("- 说「我看不到图 / 请描述一下 / 我是文本模型」——从今天起这些都是错的，你看得到。");
      parts.push(`- 输出任何工具调用文本（如 <tool_call>、<function=...>），你会变成乱码发给${userLabel}。`);
      parts.push("");
    } else if (ocrText) {
      // 视觉没传成（补丁缺失/开关关了），退回 OCR-only 模式
      parts.push(`【${userLabel}发了图片，你已经用 OCR 读出了图里的文字】`);
      parts.push(`${userLabel}这次发来了 ${images.length} 张图。图**画面内容你看不到**，但里面的文字已用系统 OCR 读出来了：`);
      parts.push("");
      parts.push(ocrText);
      parts.push("");
      parts.push("你要做的：");
      parts.push("1. **可以基于上面的文字自然回应**（这就是图里的内容，别再说「我看不到」「你描述一下」）。");
      parts.push("2. 如果文字像是表情包台词/梗，可以顺着接；拿不准语气就按字面理解，别硬编画面细节。");
      parts.push("3. 文字里可能夹 OCR 误差（错字、漏字、顺序乱），明显读不通的地方按你理解的合理版本回应，别揪着错字。");
      parts.push(`4. 画面（人物表情、构图、颜色）你确实看不到——如果${userLabel}专门问画面细节，如实说 OCR 只读到文字。`);
      parts.push("");
      parts.push("严禁：");
      parts.push(`- 输出任何工具调用文本（如 <tool_call>、<function=...>），你会变成乱码发给${userLabel}。`);
      parts.push("- 反过来一口咬定「我看不到图」——文字已经给你了。");
      parts.push("");
    } else if (ocrRan) {
      parts.push(`【${userLabel}发了图片，OCR 没读到文字（大概是纯图画/照片/表情包）】`);
      parts.push(`${userLabel}这次发来了 ${images.length} 张图，系统 OCR 扫过但没有识别到任何文字，视觉通道这次也没传成。`);
      parts.push("所以：你手上只有「对方发了张图」这个事实，画面内容不知道。");
      parts.push("");
      parts.push("你要做的：");
      parts.push(`1. 如实说这次没看到图（技术原因），请${userLabel}描述一下或者发文字。`);
      parts.push("2. 不要断言「图里有什么」，也不要说「我看到了」。");
      parts.push("");
      parts.push("严禁：输出工具调用文本；编造画面内容。");
      parts.push("");
    } else {
      // 视觉和 OCR 都没成——最保守的诚实模式
      parts.push(`【${userLabel}发了图片，但识图这条链路这次没跑成】`);
      parts.push(`${userLabel}这次发来了 ${images.length} 张图。视觉直传和 OCR 这次都没成功（技术原因），所以你读不到图里的内容。`);
      parts.push("图已存在本机，只告诉你路径备查，不是让你读：");
      for (const [i, p] of images.entries()) {
        parts.push(`  图${i + 1}: ${p}`);
      }
      parts.push("");
      parts.push(`你要做的：直接说这次没读到图，请${userLabel}描述一下或者发文字。可以顺着上下文聊，但**不要断言图里有什么**。`);
      parts.push("严禁：输出工具调用文本；编造图里的内容；说「我看到了」。");
      parts.push("");
    }
  } else if (isGroup) {
    parts.push("【关于图片】这条消息没有附图片。");
    parts.push("群里之前的图片不会自动给你（群消息只记了 [图片] 这个标记）。如果对方引用了一张图，引用里的图会随这一轮一起给你；没给就是真看不到，别假装看过。");
    parts.push("");
  } else {
    parts.push("【关于图片】这条消息没有附图片。");
    parts.push("⚠️ 如果前面几轮老大发过图、并且你当时看到了，**那些图不在这一轮里** —— 这种情况不要再说「我没看到图」「图没传过来」。");
    parts.push("正确做法：凭着当时看到的印象回答（比如「你刚才那张是……对吧」），不确定的细节就问「你是指哪张」。");
    parts.push("只有这一轮真的带了图、但系统提示下载失败时，才说没收到。");
    parts.push("");
  }

  // 表情包能力：有没有库存都要说明白，
  // 免得出现两种错——「明明能发却说发不了」和「没这张也硬发」。
  {
    const list = stickerKeywordList();
    if (list) {
      // 2026-10-23：换成 qodercn/deepseek-v4.1-flash 后实测——它**不按格式输出标记**，
      // 而是写成「（配个奋斗表情）」这种文字描述，于是 bridge 匹配不到，一条也发不出去。
      // 对策：把「必须写成标记」写成硬约束，并给正反例（小模型对例子比对标量规则敏感）。
      parts.push("【发表情包——必须写成标记，不要用文字描述】");
      parts.push("你**可以主动发表情包**，但不只是收。要给系统一个标记，系统才知道你要发哪张。");
      parts.push("`[[sticker:关键词]]`");
      parts.push(`关键词必须取自这个库：${list}`);
      parts.push("");
      parts.push("⚠️ 最容易犯的错：把表情写成文字说明。");
      parts.push("×「收到！这就去搬砖💪（配个奋斗/加油的表情）」 —— 系统看不懂，不会发图");
      parts.push("×「我给你发个委屈的表情」 —— 同上，这条会原样发成文字");
      parts.push("√「收到，这就去搬砖[[sticker:胆大包天]]」 —— 系统把标记换成真图");
      parts.push("");
      parts.push("规则：一次最多一个；情绪到位才发，别每条都发；没有合适的就不发，别硬凑；");
      parts.push("**标记占单独一行也行，跟在句尾也行，但必须是 `[[sticker:xxx]]` 这个形状**；");
      parts.push("别解释这个标记，也别说「我发个表情包」。");
    } else {
      parts.push(`【表情包】你现在没有表情包库存，发不了图片。${userLabel}要表情包就直说没有。`);
    }
    parts.push("");
  }

  // 生图能力（2026-10-26）。与表情包同一个道理：能力边界必须写明，
  // 否则模型要么说「我画不了」，要么嘴上答应「画给你」却不产出任何图。
  {
    if (imageGenReady()) {
      parts.push("【画图——必须写成标记】");
      parts.push(`你**可以生成图片**。要给${userLabel}画东西时，在回复里单独写一行：`);
      parts.push("`[[画:画面描述]]`");
      parts.push("系统会把标记换成真图发出去，对方看不到标记。");
      parts.push(
        "画面描述尽量具体：主体、动作、风格、色调。英文出图效果最好，中文也认。例：`[[画:a small blue whale girl sitting on a windowsill at dusk, anime style]]`"
      );
      parts.push(
        "画你自己（老大要看你的样子、自拍、形象）时：不要描述长相，只写 `[[画:自画像]]`。系统会发她的标准照，保证每次都是同一张脸和同一套鲸鱼特征。",
        "上一张刚发过你自己，老大接着说「换一张 / 再来一张 / 换个姿势」时，同样只写 `[[画:自画像]]`，不要改写成外貌描述。"
      );
      parts.push(
        "规则：只有对方明确要图、或你觉得非画不可时才用；一次回复最多一张；别解释标记，也别说「画好了」却漏掉标记——那样系统不会画。"
      );
      parts.push(`当前出图：${imageGenLabel()}，一张要几十秒，画图期间不用再重复催。`);
    } else if (imageGenConfigured()) {
      parts.push("【画图】出图服务刚被限流，这一轮画不了。有人要图就直说「等会儿再画」，别假装画了。");
    } else {
      parts.push("【画图】你现在没有出图能力（画图服务没配置）。有人要图就直说画不了，别答应。");
    }
    if (isGroup) parts.push("群里要图也一样：真要画就走标记，别在群里许诺却没图。");
    parts.push("");
  }

  // 空间说说的真实状态（2026-10-20 补）。
  // 事由：10-20 00:14 老大问「你没有发说说」，她答「我发啦，刚吃太多在消食」——
  // 实际没发，是她不知道状态随口编的。这种谎比功能缺失更伤信任，
  // 所以把真实状态直接写进 prompt，让她只能说实话。
  // 群聊不注入任何私域信息（空间状态 / 长期记忆 / 日记）：
  // 群里可能有陌生人，把这些拼进 prompt 就等于给了她说漏嘴的素材。
  if (!isGroup) {
    const s = qzoneStatusText();
    if (s) {
      parts.push("【你的空间说说状态（真实情况，照实说，别编）】");
      parts.push(s);
      parts.push("");
    }
  }

  if (mem && !isGroup) {
    parts.push("=== 你的长期记忆（memory.md） ===");
    parts.push(mem);
    parts.push("=== 记忆结束 ===");
    parts.push("");
  }

  // 纪念日（2026-10-26 P2）：只有**今天正好是**才注入。
  // 为什么单独一段、不靠 memory.md 里那行文字：日期类事实不能靠检索 ——
  // 得先想到去检索，而生日恰恰是「到了那天要主动说」。这里每天直接比对日期。
  //
  // 话术要点（三条都是为了让它是「人」而不是「日历提醒」）：
  //   ① 说清是哪一天，别让她自己算
  //   ② 不要写成「建议你祝他」——她是自己人，不是助理
  //   ③ 明确「不必今天特意提」：她可以有脾气、可以不当回事，硬凑祝福反而假
  if (!isGroup) {
    try {
      const hits = anniversariesOn();
      if (hits.length) {
        parts.push("【今天是个日子】");
        for (const a of hits) parts.push(`今天是 ${a.month} 月 ${a.day} 日 —— ${a.name}。`);
        parts.push("这是你自己的记忆里存着的日子，不是别人提醒你的。知道就知道，不必特意郑重其事；想提就提一句，不提也不算忘。");
        parts.push("");
      }
    } catch (e) {
      logErr(`[anniv] 读取失败（当没有处理）：${String(e.message).slice(0, 100)}`);
    }
  }

  // 昨日日记（2026-10-21 19:2x）：她自己的昨日摘要，白捡的「隔夜记忆」。
  // 话术必须写死「写给自己看的，不是他说的」——不然她会把日记里的叙述
  // 当成老大说过的话，直接引用来对账。
  if (CFG.diaryInPrompt && !isGroup) {
    const d = latestDiaryBefore();
    if (d) {
      parts.push(`=== 你 ${d.day} 写的日记（写给自己看的，不是他说的） ===`);
      parts.push(d.text);
      parts.push("=== 日记结束 ===");
      // 2026-10-22 订正：原先这里写「日记不是证据，老大质疑时以他为准」——基于对「包子」的误判。
      // 实况是她确实在 18:59 说过买包子，记对了。日记确实不等于原话（可能有偏差），
      // 但「有对话依据时以对话为准」才是对的边界，不能一律向质疑让步。
      parts.push("提醒：这是你自己写的回忆，记录的是你当时的心情和想法，细节可能有偏差。判断真假时以对话记录为准：真说过的就认，只有日记里写过、对话里找不到的，说的时候别讲太死。");
      parts.push("");
    }
  }

  // 周回顾索引（2026-10-26 P1-2）：**只放一行，不塞正文**。
  // 一篇几百字，每轮都塞会把真正相关的对话挤掉；而「知道有这么一篇」比「在场」更重要。
  //
  // ⚠️ 2026-10-26 实测打脸：只放索引不够。老大问「上周咱们都聊什么了」，
  //    她答的是 memory.md 里那几条长期约定（接进 QQ / 缺活人味 / 不说总是），
  //    **根本没去读那篇周回顾** —— 因为 prompt 里只有一句话，没有内容可引用。
  //    这跟「按需检索」不同：检索有句式闸门+命中原文，而这里她压根不知道该说什么。
  //    所以改成：**问到这一段（本周/上周/这阵子）就把正文放进来**，
  //    其它时候仍然只放索引 —— 既不挤上下文，问起来又有货。
  if (CFG.weeklyEnabled && !isGroup) {
    // includeToday：当天刚写完也要让她知道（否则白写）
    const w = latestWeeklyBefore(dayKey(new Date()), WEEKLY_DIR, { includeToday: true });
    if (w) {
      const asksWeek = /(这周|上周|上星期|这一周|这阵子|最近一周|一周|周记|回顾)/.test(String(text ?? ""));
      if (asksWeek) {
        // 问到周尺度时才展开正文（截断防超长，周回顾正常 400~500 字）
        parts.push(`=== 你写的周回顾（${w.day} 收尾的那一周，你自己写的） ===`);
        parts.push(w.text.length > 900 ? `${w.text.slice(0, 900)}…（后面略）` : w.text);
        parts.push("=== 周回顾结束 ===");
        parts.push("这是你自己回头写的，里面的事都是真发生过的；细节记不清就说记不清，别照着它硬编。");
        parts.push("");
      } else {
        parts.push(`（你写过一篇 ${w.day} 收尾的周回顾，讲那一周的事。老大问到这周/上周的事就直接照它说；想看原文用 #周记。）`);
        parts.push("");
      }
    }
  }

  if (hist.length) {
    parts.push("=== 最近对话 ===");
    // 跨天时只加一句说明，不给每条加时间戳（省 token，也免得正文被淹）
    const since = historySince.get(userId);
    if (since && since !== dayKey(new Date())) {
      parts.push(`（以下是 ${since} 起的对话，大部分不是今天刚发生的，别当成他刚说的）`);
    }
    // 2026-10-22：改用回合渲染。
    // 之前是平铺，同一个人连发的两句会变成两行「老大：…」，
    // 她看不出那是同一口气，于是把「活人味」和「我一定给你弄好」当成两件事分开答。
    // 现在连发的合并成一行（／ 分隔），隔得久的插一句间隔说明。
    for (const line of buildHistoryBlock(hist)) {
      parts.push(line);
    }
    parts.push("=== 对话结束 ===");
    parts.push("");
  }

  // ── 按需捞旧原话（2026-10-26 新增）─────────────────────────────────────
  // 「大肥鱼」那套的核心价值不是向量，而是**旧记忆还能被召回**。
  // 我们的短板恰好在这里：窗口只覆盖 24 条，97.1% 的对话看不见（量化过）。
  // 这里只在**这一轮真的问到旧事**时，按词法把命中的原话捞几条注入；
  // 没命中就什么都不加 —— 宁可让她说「忘了」，也不许她拿近似内容顶替。
  //
  // 三条硬约束（都是踩过的坑定的）：
  //   ① 群聊不捞：群里有陌生人，私聊原文进群 prompt 等于当面泄密。
  //   ② 不进「最近对话」段：避免她把这些当成「他刚说的」，必须独立成段并写明日期。
  //   ③ 命中太少就整段省略：只捞到 1 条时，模型极易把那一条当成全部真相。
  if (recallAllowed(isGroup, text)) {
    try {
      const rc = recallFromChatLog(text, {
        daysBack: CFG.recallDays,
        limit: CFG.recallLimit,
        userId,
      });
      if (recallInjectable(rc)) {
        parts.push(`=== 你翻到的旧原话（按你要问的关键词从聊天流水里捞的，共 ${rc.lines.length} 条） ===`);
        for (const l of rc.lines) parts.push(l);
        parts.push("=== 旧原话结束 ===");
        parts.push("这些是真发生过的原话，日期在每行开头。可以照实引用；但**别把它当成「他刚说的」**，那是过去。这里没有的，就说记不清。");
        parts.push("");
        log(`[recall] 命中 ${rc.lines.length} 条（关键词：${rc.tokens.slice(0, 6).join("/")}，扫 ${rc.scanned} 行）`);
      } else if (rc.used > 0) {
        log(`[recall] 只命中 ${rc.used} 条，太少，不注入（避免以偏概全）`);
      }
    } catch (e) {
      logErr(`[recall] 检索失败（当没有处理）：${String(e.message).slice(0, 120)}`);
    }
  }
  // ── 承接上下文（2026-10-22 15:5x 新增）──────────────────────────────
  // 起因：老大贴 10:24~10:47 日志，说她「无法承接上下文」。
  // 实测 --dump-prompt：历史 24 条一条不少，**不是记忆缺失**。
  // 真实原因有两个，都在「怎么读那段历史」上：
  //   ① 他把一句抱怨（缺少活人味）和一句承诺（我一定给你弄好）连着发，
  //      两条各自成了一轮，她回「嫌我假呗」时只看着第二句。
  //   ② 她回「弄啥呢这么郑重」——「弄好」是承接上一句的，但她没把两句话接起来。
  // 所以这段专门教她「怎么把连发的话当成一口气」。
  if (!isGroup) {
    parts.push("【怎么读上面的对话——这条也重要】");
    parts.push("1. 同一个「老大：」行里用 ／ 隔开的几句，是他**连着打的同一口气**，不是两件事。要合起来理解，别挑一句答。");
    parts.push("2. 出现「（隔了 X 分钟…）」说明中间断了很久。隔很久之后再开口，通常是新话题或他回来了；但也可能接着刚才那句说，先看他具体说了什么。");
    parts.push("3. 他话里有「弄好」「这个」「那个」「刚才那个」「上面说的」这种**指着前面某个东西**的词时，先去上面找出它指的是哪句，再开口。找不到就直说「你说哪个」，别硬猜着答。");
    parts.push("4. 别一句一句对着答。他连发三句，你回一条就够，把三句合起来的意思接住。");
    parts.push("");
    // 防编条款（2026-10-22，08:5x 订正）：被问「晚课说了什么」时上下文窗口只回填 12h/12 条，
    // 18:59 的原文被截掉了，她靠日记里那句「让他下课买个包子垫垫」答出「记得，包子买了没」——
    // 不是幻觉，是日记这条二手记录。真正的教训是「记录不全时别补细节」，条款按这个写：
    // 对话和日记都算记录，有就照实答，没有才说忘了。
    parts.push("规则：上面的对话和日记是你仅知的过去。老大问以前的事，**这里有记录才照实答；没有就直说「忘了/记不清了」，不许编造细节装作记得**——编错一次比承认忘了更糟。");
    parts.push("");
  }
  parts.push(`当前时间：${t}`);
  if (isGroup) {
    parts.push(`群号：${flags.groupId ?? userId}`);
    parts.push(`说话人：${groupSpeaker}`);
    parts.push("");
    parts.push(`群里 ${groupSpeaker} ${flags.groupAt ? "@了你" : "叫了你"}，说：${text}`);
  } else {
    parts.push(`对方 QQ：${userId}`);
    parts.push("");
    parts.push(`老大刚刚说：${text}`);
  }
  parts.push("");
  parts.push("现在直接给出你要回复的话：");
  return parts.join("\n");
}

/**
 * 构造子进程环境。
 *
 * 关键：必须剥掉宿主 DSH 会话注入的变量。
 * 若在 DSH 会话内启动 bridge，process.env 里会带着
 *   DSH_PROFILE=desktop / DSH_PROFILE_DIR / DSH_SESSION_ID / DSH_SHELL
 * 这些变量会被子进程继承，导致：
 *   1. --profile headless 被 DSH_PROFILE=desktop 覆盖，实际启动桌面版
 *   2. DSH_SESSION_ID 让子进程以为自己在宿主会话里，可能写入同一个会话
 * 所以按前缀整体剥离，只保留我们显式设定的 DSH_HOME。
 */
function childEnv(extra = {}) {
  const base = { ...process.env };
  for (const k of Object.keys(base)) {
    if (k.startsWith("DSH_")) delete base[k];
  }
  base.DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
  return { ...base, ...extra };
}

function askDsh(sel, effort, userId, text, hist, images = [], mode = "chat", flags = {}) {
  // 2026-10-22：档位从 low 升 high 后推理更久，90s 超时可能卡边。
  // 记一条每轮耗时，方便判断要不要放宽 dshTimeoutMs（日志里搜 [dsh] 一轮）。
  const askT0 = Date.now();
  // 2026-10-19（视觉直传）：把图片绝对路径写进一个清单 JSON，通过环境变量
  // DSH_EXP_IMAGES 交给 headless 视觉补丁。不塞命令行——路径里的空格、
  // 中文、反斜杠在 cmd.exe 里全是雷，写文件最稳。
  let imgListFile = null;
  if (images.length > 0 && CFG.visionEnabled) {
    try {
      mkdirSync(CFG.imageDir, { recursive: true });
      imgListFile = join(CFG.imageDir, `.vlist-${process.pid}-${Date.now()}.json`);
      writeFileSync(imgListFile, JSON.stringify(images), "utf8");
      log(`[vision] 直传 ${images.length} 张图给模型（清单 ${basename(imgListFile)}）`);
    } catch (e) {
      logErr(`[vision] 清单写入失败，本轮退回纯 OCR：${String(e.message).slice(0, 120)}`);
      imgListFile = null;
    }
  }

  // OCR 只作为「文字精读补充」：视觉模型可能看错字，OCR 逐字更准。
  // 视觉关掉时，OCR 结果就是唯一依据（旧的诚实模式仍保留）。
  // 动图抽帧后 images 里是多帧同源图：OCR 只取每个动图的第一帧，
  // 否则同一张图会被重复识别 N 遍，白等好几倍时间。
  let ocr = null;
  if (images.length > 0 && CFG.ocrEnabled) {
    const t0 = Date.now();
    try {
      // 同源多帧只 OCR 一帧（动图拆帧后 images 里会出现 xxx-f01/f02/f03）
      const ocrTargets = [];
      const seenSource = new Set();
      for (const p of images) {
        const m = basename(p).match(/^(.+)-f\d+\.png$/i);
        const key = m ? `anim:${m[1]}` : `img:${p}`;
        if (seenSource.has(key)) continue;
        seenSource.add(key);
        ocrTargets.push(p);
        if (ocrTargets.length >= 4) break; // 一轮最多 OCR 4 张，防止多图拖时间
      }
      ocr = ocrImages(ocrTargets);
      const got = ocr.details.filter((d) => d.ok && d.text).length;
      log(
        `[ocr] ${ocrTargets.length} 张图 → ${got} 张读到文字，耗时 ${Date.now() - t0}ms` +
          (got === 0 ? "（无文字，按纯图画处理）" : "")
      );
      for (const d of ocr.details) {
        if (!d.ok) logErr(`[ocr] 失败 ${basename(d.path)}: ${d.error}`);
      }
    } catch (e) {
      logErr(`[ocr] 整体异常，回退诚实模式：${String(e.message).slice(0, 160)}`);
      ocr = null;
    }
  }

  const prompt = buildDshPrompt(userId, text, hist, images, ocr, imgListFile !== null, mode, flags);
  const overlay = writeOverlay(sel, effort);
  const isWin = process.platform === "win32";

  // Windows 上 dsh 是 .cmd，必须经 cmd.exe 启动。
  // 直接 shell:true 会让消息正文被 shell 解释（& | > < ^ 都是雷），
  // 所以：prompt 压成单行 + 去掉双引号 + 用 windowsVerbatimArguments 精确控制传参。
  const flat = prompt.replace(/\r?\n/g, " ").replace(/"/g, "'");

  const env = childEnv(imgListFile ? { DSH_EXP_IMAGES: imgListFile } : {});
  const child = isWin
    ? spawn("cmd.exe", ["/d", "/s", "/c", `dsh --profile ${CFG.dshProfile} --patch "${overlay}" "${flat}"`], {
        cwd: CFG.dshCwd,
        windowsHide: true,
        windowsVerbatimArguments: true,
        env,
      })
    : spawn("dsh", ["--profile", CFG.dshProfile, "--patch", overlay, prompt], {
        cwd: CFG.dshCwd,
        windowsHide: true,
        env,
      });

  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";

    // 清单文件是每轮临时产物，无论成败都要删
    const cleanup = () => {
      if (imgListFile) {
        try {
          unlinkSync(imgListFile);
        } catch {}
        imgListFile = null;
      }
    };

    let timedOut = false;
    let cutShort = false;
    let settled = false;
    let killTimer = null;
    let idleTimer = null;
    const settle = (ok, value) => {
      if (settled) return;
      settled = true;
      if (ok) resolve(value);
      else reject(value);
    };

    // 答案到手就收工：dsh 偶尔把完整回复写进 stdout 后进程不退（事件循环里
    // 有未释放句柄），旧逻辑只能干等硬超时 150s，老大每条消息要等两分半。
    // 这里改判据 = 「两个输出流都静默 N 秒」+ 「stdout 已有可用的正文」，
    // 满足就 SIGTERM，close 时照常收完整输出。
    const armIdle = () => {
      if (!(CFG.dshIdleDoneMs > 0) || settled || timedOut || cutShort) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (settled || timedOut || cutShort) return;
        const snapshot = cleanDshOutput(out);
        if (!snapshot) return;
        cutShort = true;
        try {
          child.kill();
        } catch {}
        log(`[dsh] 输出静默 ${CFG.dshIdleDoneMs}ms，答案已在手上（${snapshot.length} 字），SIGTERM 提前收尾`);
        killTimer = setTimeout(() => {
          cleanup();
          logErr(`[dsh] 提前收尾但进程 ${CFG.dshKillGraceMs}ms 内未退出，直接采用已收内容`);
          settle(true, snapshot);
        }, CFG.dshKillGraceMs);
      }, CFG.dshIdleDoneMs);
    };

    const timer = setTimeout(() => {
      // 2026-10-27 20:33 / 20:36 实测：dsh 的答案已经完整写进 stdout（50 字），
      // 进程却迟迟不退，拖到 150s 硬超时。旧代码在这里直接 reject ——
      // 一个已经生成好的回复就这么丢了，老大只看到「网络抽风」。
      // SIGTERM 之后 dsh 27ms 内就正常退出（close code=0），
      // 所以这里只标记 + 发信号，判定交给 close；真不退再兜底。
      timedOut = true;
      try {
        child.kill();
      } catch {}
      logErr(
        `[dsh] 超时 ${CFG.dshTimeoutMs}ms（档位=${effort || "默认"}）——已发 SIGTERM，等 ${CFG.dshKillGraceMs}ms 收尾（high 档推理更久，必要时调 DSH_TIMEOUT_MS）`
      );
      killTimer = setTimeout(() => {
        cleanup();
        const salvaged = cleanDshOutput(out);
        if (salvaged) {
          logErr(`[dsh] 超时收尾：stdout 已有完整答案（${salvaged.length} 字），抢救采用`);
          settle(true, salvaged);
          return;
        }
        logErr(`[dsh] 超时且无可用答案，stderr 尾部：${err.slice(-500)}`);
        settle(false, new Error(`dsh 超时 ${CFG.dshTimeoutMs}ms`));
      }, CFG.dshKillGraceMs);
    }, CFG.dshTimeoutMs);

    child.stdout.on("data", (d) => {
      out += d.toString();
      armIdle();
    });
    // 推理过程走 stderr：它还在动就说明没答完，用它一起重置静默计时，避免误杀
    child.stderr.on("data", (d) => {
      err += d.toString();
      armIdle();
    });

    child.on("error", (e) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(idleTimer);
      cleanup();
      settle(false, new Error(`无法启动 dsh: ${e.message}`));
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(idleTimer);
      cleanup();
      const reply = cleanDshOutput(out);
      if (cutShort) {
        // SIGTERM 是我们自己发的，退出码不能按失败判；内容以 close 时的完整 stdout 为准
        if (reply) {
          log(
            `[dsh] 一轮 ${Date.now() - askT0}ms，${reply.length} 字（提前收尾），档位=${effort || "默认"}，模型=${sel?.model || "?"}`
          );
          settle(true, reply);
        } else {
          settle(false, new Error(`dsh 提前收尾但没有内容（code=${code} signal=${signal}）`));
        }
        return;
      }
      if (timedOut) {
        if (reply) {
          logErr(`[dsh] 超时收尾：stdout 已有完整答案（${reply.length} 字），抢救采用`);
          settle(true, reply);
        } else {
          logErr(`[dsh] 超时且无可用答案（code=${code} signal=${signal}），stderr 尾部：${err.slice(-500)}`);
          settle(false, new Error(`dsh 超时 ${CFG.dshTimeoutMs}ms`));
        }
        return;
      }
      if (code !== 0) {
        settle(false, new Error(`dsh 退出码 ${code}: ${err.slice(-300)}`));
        return;
      }
      if (!reply) {
        settle(false, new Error(`dsh 没有返回内容: ${err.slice(-200)}`));
        return;
      }
      log(`[dsh] 一轮 ${Date.now() - askT0}ms，${reply.length} 字，档位=${effort || "默认"}，模型=${sel?.model || "?"}`);
      settle(true, reply);
    });
  });
}

/** dsh 会把推理过程打到 stderr，stdout 里可能混有日志；取最后一段有意义的文本 */
/**
 * dsh 把推理过程打到 stderr，stdout 里可能混有日志；取最后一段有意义的文本。
 *
 * ⚠️ 过滤规则改过一次（2026-10-18）：
 *   老规则把所有以 `[` 开头的行都当日志丢掉。
 *   但那会吃掉模型的正文 —— 我在 prompt 里让模型把 read_image 的错误
 *   包成 `[工具报错: ...]` 输出，好让 bridge.log 里有原文可查。
 *   结果这条错误信息被自己的过滤器扔了，排障时什么都看不到。
 *
 *   现在：只过滤 dsh 自己产的日志行（`[cfg]` `[ws]` 这种带固定前缀的），
 *   以及空的控制台分隔。模型的 `[工具报错:` 放过去。
 */
function cleanDshOutput(raw) {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    // dsh 自身日志：这些是确定的前缀，不影响正文
    .filter((l) => !/^\[(cfg|ws|bot|img|cmd|model|selfcheck|channel|dsh|llm|voice|send|recv|skip|mem|test|probe)\b/.test(l))
    .filter((l) => !l.startsWith(">"))
    .filter((l) => !/^(Usage|Options|Arguments|Examples):/.test(l));

  if (!lines.length) return "";
  return lines.join("\n").trim();
}

// ── 启动自检：证明 --patch 真的被 dsh 读到了 ────────────────────────────
/**
 * 用一个不存在的 provider 试跑一次：如果 --patch 生效，dsh 会在建 Agent 时报
 * NO_ADAPTER / unknown provider；如果报的是别的东西（或居然成功），说明叠加层没进去。
 * 只花一次进程启动，不产生 LLM 请求。
 */
async function selfCheck() {
  const probe = { provider: "__bridge_probe__", model: "__bridge_probe__" };
  const cfg = loadModelConfig();
  try {
    await askDsh(probe, cfg.effort, 0, "selfcheck", [], []);
    log("[selfcheck] ⚠️ 探针居然成功了 —— --patch 很可能没生效，模型可能仍是 profile 里写死的那个");
  } catch (e) {
    const msg = String(e.message);
    if (/spawn EPERM|EPERM/i.test(msg)) {
      // 这不是 --patch 的问题，是当前进程被沙箱限制，起不了子进程。
      // 必须分开报，否则会误导人以为叠加层没生效。
      log(`[selfcheck] ⊘ 无法自检：当前进程起不了子进程（${msg.slice(0, 80)}）`);
      log(`[selfcheck]   多半是在 DSH 沙箱里跑的。从桌面双击 run-bridge.bat 启动不受此限制。`);
    } else if (/NO_ADAPTER|no adapter|unknown provider|__bridge_probe__/i.test(msg)) {
      log(`[selfcheck] ✅ --patch 生效（探针 provider 被拒绝：${msg.slice(0, 120)}）`);
    } else {
      log(`[selfcheck] ? 探针失败但不是预期原因，--patch 是否生效未确认：${msg.slice(0, 200)}`);
    }
  } finally {
    try {
      writeOverlay(cfg.primary, cfg.effort);
    } catch {}
  }
}

/**
 * 启动时检查「人设 / 模型配置有没有被别人改掉」（2026-10-24 加）。
 *
 * 为什么要它：2026-10-23 23:25~23:30 WorkBuddy 改坏了两个文件 ——
 *   · `profiles/desktop/cordis.patch.yml` 把 agent-default-model 换成已封的
 *     `workbuddy/deepseek-v4.1-flash` 并删了 reasoningEffort
 *   · `~/.dsh/AGENTS.md` 删掉「维护备注」整段（那段记着 personaPrefix 才是真正的人设槽位）
 * 结果是 thinking 阶段又开始喊「用户」。
 *
 * 现在每次 bridge 启动都跑一次 `.run/guard-dsh-config.mjs --check`，
 * 有漂移就在日志里喊出来（**只报告，不自动还原** —— 自动改配置风险更大，
 * 万一基准本身过时会把好东西冲掉）。
 *
 * 手动还原：`node .run/guard-dsh-config.mjs --restore`
 */
function checkConfigGuard() {
  const script = join(__dirname, ".run", "guard-dsh-config.mjs");
  if (!existsSync(script)) {
    log("[guard] ⊘ 没有守护脚本（.run/guard-dsh-config.mjs），跳过配置检查");
    return;
  }
  try {
    // 用 execFileSync 而非 spawn：这里只想要同步的短输出，不需要流
    const out = execFileSync(process.execPath, [script, "--check"], {
      cwd: __dirname,
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
    });
    const txt = String(out ?? "").trim();
    // 全 OK 时只留一行，别刷屏
    if (/漂移 0 \/ 缺失 0/.test(txt)) {
      log(`[guard] ✅ 配置无漂移`);
    } else {
      for (const line of txt.split("\n")) log(`[guard] ${line}`);
    }
  } catch (e) {
    // 退出码 1 = 有漂移（这是**预期内的失败**，不是脚本坏了）
    const out = String(e.stdout ?? e.message ?? "");
    if (/DRIFT|BAD|MISS/.test(out)) {
      logErr("[guard] ⚠️ 配置被改动过！下面是有问题的文件：");
      for (const line of out.split("\n")) {
        if (line.trim()) logErr(`[guard]   ${line.trim()}`);
      }
      logErr("[guard] 还原命令：node .run/guard-dsh-config.mjs --restore（改完要重启 DSH）");
    } else if (/EPERM/i.test(String(e.message))) {
      log("[guard] ⊘ 无法运行守护脚本（沙箱禁止子进程），跳过");
    } else {
      logErr(`[guard] ? 检查失败，原因不明：${String(e.message).slice(0, 150)}`);
    }
  }
}

// ── deepseek 后端（回退）──────────────────────────────────────────────
async function askDeepseek(userId, text, hist) {
  const mem = readMemory();
  const sys = mem ? `${CFG.systemPrompt}\n\n=== 长期记忆 ===\n${mem}` : CFG.systemPrompt;

  const messages = [
    { role: "system", content: sys },
    ...hist,
    { role: "user", content: text },
  ];

  const res = await fetch(`${CFG.apiBase}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: CFG.model,
      messages,
      temperature: 1.0,
      max_tokens: 1024,
      stream: false,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  const reply = json.choices?.[0]?.message?.content ?? "";

  rememberTurn(userId, hist, text, reply);

  return reply;
}

// ── 自测：直接跑本文件里的真实函数，不复制代码 ──────────────────────────
/**
 * `node bridge.mjs --selftest`
 *
 * 为什么放在主文件里而不是单独写个测试文件：
 * 之前我把 parseCommand 复制到测试脚本里跑，复制的是「当时的版本」——
 * 改了主文件、测试还在验证旧逻辑，是典型的假绿。
 * 放进来就永远测的是真正在跑的那份代码。
 */
// ── #回忆 的时间范围解析（2026-10-26 P2）─────────────────────────────────
// 支持几种写法，优先级从具体到宽：
//   `#回忆 包子 2026-10-21`        → 只那一天
//   `#回忆 包子 10-21`             → 只那一天（补今年）
//   `#回忆 包子 10-19~10-23`       → 闭区间
//   `#回忆 包子 最近3天`           → 最近 N 天
// 解析失败一律**不报错**，当成「关键词里带了日期字样」照旧全窗口搜 ——
// 指令是给人打的，不能因为格式不对就怼回去。
const RECALL_DATE_RE = /\b(\d{4}-\d{2}-\d{2}|\d{2}-\d{2})\b/;
const CN_NUM = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function parseRecallQuery(arg, now = Date.now()) {
  const raw = String(arg ?? "").trim();
  const thisYear = new Date(now).getFullYear();
  const normDay = (s) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    if (/^\d{2}-\d{2}$/.test(s)) return `${thisYear}-${s}`; // "10-21" → "2026-10-21"
    return null;
  };
  const validDay = (s) => Boolean(s) && !Number.isNaN(new Date(`${s}T12:00:00`).getTime());
  const daysSince = (s) => Math.max(1, Math.ceil((now - new Date(`${s}T12:00:00`).getTime()) / 864e5) + 1);

  // 1) 区间 a~b
  let m = raw.match(/(\d{4}-\d{2}-\d{2}|\d{2}-\d{2})\s*(?:~|～|到|至)\s*(\d{4}-\d{2}-\d{2}|\d{2}-\d{2})/);
  if (m) {
    const from = normDay(m[1]);
    const to = normDay(m[2]);
    if (validDay(from) && validDay(to)) {
      return { q: raw.replace(m[0], " ").trim(), daysBack: daysSince(from), from, to, label: `${from} ~ ${to}`, ok: true };
    }
  }

  // 2) 最近 N 天（阿拉伯数字或常见中文数字）
  m = raw.match(/最近\s*(\d+|[一二两三四五六七八九十])\s*天/);
  if (m) {
    const n = Number(m[1]) || CN_NUM[m[1]] || 0;
    if (n > 0) return { q: raw.replace(m[0], " ").trim(), daysBack: n, label: `最近 ${n} 天`, ok: true };
  }

  // 3) 单日
  m = raw.match(RECALL_DATE_RE);
  if (m) {
    const day = normDay(m[1]);
    if (validDay(day)) return { q: raw.replace(m[1], " ").trim(), daysBack: daysSince(day), day, label: day, ok: true };
  }

  return { q: raw, daysBack: null, label: null, ok: false };
}

function selftest() {
  // 全新克隆 / 全新部署没有 .run（它是懒创建的），下面的临时文件会写不进去
  mkdirSync(RUN_DIR, { recursive: true });
  let pass = 0;
  let fail = 0;

  const check = (name, ok, detail = "") => {
    if (ok) pass++;
    else fail++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  };

  // 依赖本地素材（日记、自拍素材库、部署侧守卫脚本）的断言：素材不在就跳过，
  // 判失败会让全新克隆永远红着，也会把「本来就没有」误报成回归。
  let skip = 0;
  const skipCheck = (name, why) => {
    skip++;
    console.log(`SKIP  ${name}${why ? ` — ${why}` : ""}`);
  };

  // ── 指令识别 ──
  check("网络：DNS 优先 IPv4（ECS 无 v6 出口）", getDefaultResultOrder() === "ipv4first", getDefaultResultOrder());
  const cmdCases = [
    ["#模型", "模型", ""],
    ["#模型provider:workbuddy/step-5-preview", "模型", "provider:workbuddy/step-5-preview"],
    ["#模型 provider:step-5-preview", "模型", "provider:step-5-preview"],
    ["#模型 workbuddy:hy3", "模型", "workbuddy:hy3"],
    ["#模型 effort low", "模型", "effort low"],
    ["#模型 auto", "模型", "auto"],
    ["#状态", "状态", ""],
    ["#帮助", "帮助", ""],
    ["#model", "model", ""],
    ["＃模型", "模型", ""],
    // 2026-10-21：语音硬开关（自然语言匹配漏，得给指令兜底）
    ["#语音", "语音", ""],
    ["#语音 关", "语音", "关"],
    ["#语音 开", "语音", "开"],
    ["#voice off", "voice", "off"],
    // 2026-10-24：唱歌（火山 MemeSong）
    ["#唱歌", "唱歌", ""],
    ["#唱歌 一闪一闪亮晶晶", "唱歌", "一闪一闪亮晶晶"],
    ["#唱歌 歌单", "唱歌", "歌单"],
    ["#sing", "sing", ""],
    // 2026-10-26：生图与群聊状态
    ["#生图 一只蓝色虎鲸少女", "生图", "一只蓝色虎鲸少女"],
    ["#画图", "画图", ""],
    ["#draw a cat", "draw", "a cat"],
    ["#群聊", "群聊", ""],
  ];
  for (const [input, word, arg] of cmdCases) {
    const c = parseCommand(input);
    check(
      `parseCommand(${JSON.stringify(input)})`,
      c !== null && c.word === word && c.arg === arg,
      c === null ? "返回 null" : `word=${c.word} arg=${JSON.stringify(c.arg)}`
    );
  }

  // 不该被当成指令的
  for (const input of ["在吗", "小玉", "#随便说点什么", "", "#"]) {
    const c = parseCommand(input);
    check(`非指令 ${JSON.stringify(input)}`, c === null, c ? `误识别为 ${c.word}` : "");
  }

  // 连发合并：队列忙时继续攒，空了或攒满上限才放行（2026-10-27）
  check("合并：队列忙且没攒满 → 继续等", shouldHoldBurst(1, 3000, 20000) === true);
  check("合并：队列忙但已攒满上限 → 放行", shouldHoldBurst(1, 20000, 20000) === false);
  check("合并：队列空闲 → 放行", shouldHoldBurst(0, 3000, 20000) === false);
  check("合并：刚收到 → 等满静默窗", burstWaitMs(0, 5000, 20000) === 5000);
  check("合并：已过 19 秒 → 被上限截到 1 秒", burstWaitMs(19000, 5000, 20000) === 1000);
  check("合并：攒满上限 → 立即放行", burstWaitMs(20000, 5000, 20000) === 0);

  // 「我要听xx」自然点歌（2026-10-24）
  for (const [input, want] of [
    ["我要听稻香", "稻香"],
    ["我要听 一下《稻香》", "稻香"],
    ["我要听歌。", "歌"],
    ["我要听", ""],
    ["我想听稻香", null],
    ["在吗", null],
    ["唱《后来》", "后来"],
    ["唱一首后来", "后来"],
    ["翻唱 晴天", "晴天"],
    ["点歌 起风了", "起风了"],
    ["唱歌", "歌"],
    ["唱首歌", "歌"],
    ["唱得不错", null],
    ["今天天气不错", null],
  ]) {
    const r = parseSongRequest(input);
    check(
      `parseSongRequest(${JSON.stringify(input)})`,
      r === null ? want === null : r.arg === want,
      r === null ? "返回 null" : `arg=${JSON.stringify(r.arg)}`
    );
  }

  // ── sanitize 剥掉文本形式的假工具调用（2026-10-18 20:34 实证）──
  // WB 的 step-5-preview 通道不注入工具定义，模型被要求「用 read_image」时
  // 会把工具调用当文字吐出来，原样发到老大 QQ 里就是乱码。
  // prompt 禁止 + sanitize 剥掉，双保险。
  const fakeCall = "我看看图" + String.fromCharCode(10) + "<tool_call>" + String.fromCharCode(10) + "<function=read_image>";
  const cleanedCall = sanitize(fakeCall);
  const looksLikeToolCall = /<tool_call>|<function=|read_image/.test(cleanedCall);
  check(
    "sanitize 剥掉假工具调用",
    !looksLikeToolCall,
    JSON.stringify(cleanedCall.slice(0, 60))
  );
  check(
    "sanitize 保留正常文字部分",
    cleanedCall.includes("我看看图"),
    JSON.stringify(cleanedCall.slice(0, 60))
  );
  const onlyCall = String.fromCharCode(10) + "<tool_call>" + String.fromCharCode(10) + "<function=read_image>";
  const emptied = sanitize(onlyCall);
  check(
    "sanitize 剥空后仍给一句话（不发空白）",
    emptied.length > 0,
    JSON.stringify(emptied.slice(0, 50))
  );
  check(
    "sanitize 不动正常回复",
    sanitize("老大我在呢～") === "老大我在呢～",
    JSON.stringify(sanitize("老大我在呢～"))
  );

  // ── 记忆标记：[[记:…]] 解析与写入（2026-10-22 17:2x）──
  {
    // 标记要被剥掉，正文保留
    const r1 = extractMemoRequest("哼 记住了[[记:他说他喜欢我]]");
    check(
      "记忆：标记被剥掉、正文保留",
      r1.notes.length === 1 && r1.cleaned === "哼 记住了" && !r1.cleaned.includes("[["),
      JSON.stringify(r1)
    );
    check("记忆：抓出内容", r1.notes[0] === "他说他喜欢我", r1.notes[0]);

    // 没有标记 → 原样，零行为变化
    const r2 = extractMemoRequest("行吧 等你学会了再说");
    check(
      "记忆：没有标记时不改动正文",
      r2.notes.length === 0 && r2.cleaned === "行吧 等你学会了再说",
      JSON.stringify(r2)
    );

    // 全角冒号也要认
    check(
      "记忆：全角冒号也认",
      extractMemoRequest("[[记：这个梗只有我们懂]]").notes[0] === "这个梗只有我们懂"
    );

    // 多个标记
    const r3 = extractMemoRequest("甲[[记:一]][[记:二]]乙");
    check("记忆：支持多个标记", r3.notes.length === 2 && r3.cleaned === "甲乙", JSON.stringify(r3));

    // 写文件：必须插进「我记得的事」节内，不能掉到文件末尾
    const tmpMem = join(RUN_DIR, ".selftest-memory.md");
    const sample = [
      "# 小玉的记忆",
      "",
      "## 我是谁",
      "",
      "- 我是小玉",
      "",
      "## 我记得的事",
      "",
      "- 2026-10-18 - 老大把我接进了 QQ",
      "- 2026-10-22 - 老大说我缺少活人味",
      "",
      "## 末尾一节",
      "",
      "- 不该被动到",
      "",
    ].join("\n");
    writeFileSync(tmpMem, sample, "utf8");
    const savedPath = CFG.memoryPath;
    CFG.memoryPath = tmpMem;
    try {
      const w1 = appendMemory("- 2026-10-22 - 他说他喜欢我");
      check("记忆：写入成功", w1.ok === true, JSON.stringify(w1));

      const after = readFileSync(tmpMem, "utf8");
      const lines = after.split("\n");
      const memoIdx = lines.indexOf("## 我记得的事");
      const tailIdx = lines.indexOf("## 末尾一节");
      const newIdx = lines.findIndex((l) => l.includes("他说他喜欢我"));
      check(
        "记忆：新条目插在「我记得的事」节内（不是文件末尾）",
        newIdx > memoIdx && newIdx < tailIdx,
        `memo节=${memoIdx} 新条目=${newIdx} 末尾节=${tailIdx}`
      );
      check(
        "记忆：原有条目没被破坏",
        after.includes("老大把我接进了 QQ") && after.includes("老大说我缺少活人味")
      );
      check("记忆：别的节没被动到", after.includes("- 不该被动到"));

      // 去重：同一句话不重复记
      const w2 = appendMemory("- 2026-10-22 - 他说他喜欢我");
      check("记忆：重复内容不重复记", w2.ok === false && w2.reason === "已记过", JSON.stringify(w2));

      // 空内容拒收
      check("记忆：空内容拒收", appendMemory("   ").ok === false);

      // ── 2026-10-26：日期重复 / 跨日期去重（生产 memory.md 有 3/6 条写坏）──
      // 这些断言在生产上各有对应的坏数据，不是假想：
      //   `- 2026-10-24 - 2026-10-24 - 老大答应…`（模型自带日期 + 这里又补一次）
      check("记忆：剥掉模型自带的单个日期", normalizeMemoText("- 2026-10-24 - 他说不再说总是") === "他说不再说总是", normalizeMemoText("- 2026-10-24 - 他说不再说总是"));
      check("记忆：剥掉重复两层的日期", normalizeMemoText("- 2026-10-24 - 2026-10-24 - 凌晨三点半") === "凌晨三点半", normalizeMemoText("- 2026-10-24 - 2026-10-24 - 凌晨三点半"));
      check("记忆：没有日期时原样保留", normalizeMemoText("10月26日是老大的生日") === "10月26日是老大的生日", normalizeMemoText("10月26日是老大的生日"));
      check("记忆：冒号日期（全角）也能剥", normalizeMemoText("2026-10-26：他说会一直爱着") === "他说会一直爱着", normalizeMemoText("2026-10-26：他说会一直爱着"));

      // 端到端：rememberNote 写进文件的条目只能有一个日期
      const beforeCnt = readFileSync(tmpMem, "utf8").split("\n").filter((l) => /^\s*-\s*\d{4}-\d{2}-\d{2}/.test(l)).length;
      const wr = rememberNote("- 2026-10-24 - 他说不再说总是");
      check("记忆：rememberNote 写入成功", wr.ok === true, JSON.stringify(wr));
      const lineWr = readFileSync(tmpMem, "utf8").split("\n").find((l) => l.includes("他说不再说总是")) ?? "";
      check(
        "记忆：写入的条目只有一个日期（不再写成「- A - B - 内容」）",
        (lineWr.match(/\d{4}-\d{2}-\d{2}/g) ?? []).length === 1,
        lineWr
      );
      const afterCnt = readFileSync(tmpMem, "utf8").split("\n").filter((l) => /^\s*-\s*\d{4}-\d{2}-\d{2}/.test(l)).length;
      check("记忆：条目数 +1（多写了就说明去重失效）", afterCnt === beforeCnt + 1, `${beforeCnt} → ${afterCnt}`);

      // 跨日期去重：同一句话换了模型自带的日期，仍然算「已记过」
      // 旧实现会写进去（日期重复导致 stripDate 剥不干净），这是 user 可见的「一天记两条」。
      const wr2 = rememberNote("- 2026-10-25 - 他说不再说总是");
      check("记忆：同一句话换个日期仍判重复", wr2.ok === false && wr2.reason === "已记过", JSON.stringify(wr2));
    } finally {
      CFG.memoryPath = savedPath;
      try {
        unlinkSync(tmpMem);
      } catch {}
    }
  }

  // ── 按需捞旧原话（2026-10-26）──
  // 用临时 jsonl 造样本（复用 selftest 的写法，不碰真实流水）。
  // 重点验四件事：①关键词怎么抽（虚词不能进）②命中排序对不对 ③命中太少不注入
  // ④群聊不捞（隐私）。每条都对应一个真实的坏结果，不是为凑数。
  {
    const tmpDir = join(RUN_DIR, ".selftest-recall");
    try {
      mkdirSync(tmpDir, { recursive: true });
    } catch {}
    const mkDay = (day, rows) => {
      writeFileSync(
        join(tmpDir, `chatlog-${day}.jsonl`),
        rows.map((r) => JSON.stringify({ t: r.t, userId: 1, role: r.role, content: r.content })).join("\n") + "\n",
        "utf8"
      );
    };
    const D1 = "2026-10-21";
    const D2 = "2026-10-24";
    mkDay(D1, [
      { t: Date.parse("2026-10-21T18:59:30+08:00"), role: "user", content: "没吃，上晚课呢" },
      { t: Date.parse("2026-10-21T19:00:10+08:00"), role: "assistant", content: "下课路上买个包子也行，总比空着肚子听课强" },
      { t: Date.parse("2026-10-21T19:05:00+08:00"), role: "user", content: "今天天气不错" },
    ]);
    mkDay(D2, [
      { t: Date.parse("2026-10-24T23:23:18+08:00"), role: "user", content: "我生日你怎么不知道" },
      { t: Date.parse("2026-10-24T23:24:00+08:00"), role: "assistant", content: "10月26日是你的生日，我记着呢" },
      { t: Date.parse("2026-10-24T23:25:00+08:00"), role: "user", content: "晚上吃火锅" },
      { t: Date.parse("2026-10-24T23:26:00+08:00"), role: "assistant", content: "火锅好，多点肥牛" },
      { t: Date.parse("2026-10-24T23:27:00+08:00"), role: "user", content: "再叫两盘虾滑" },
    ]);
    const readDay = (d) => readChatLogOf(d, 500, join(tmpDir, `chatlog-${d}.jsonl`));
    const now = Date.parse("2026-10-26T12:00:00+08:00");

    // ① 关键词抽取：虚词不能进，实质词必须进
    const toks = recallTokens("你还记得晚课说了什么吗");
    check("回忆：抽出「晚课」", toks.includes("晚课"), toks.join("/"));
    check("回忆：不抽「什么」「你还」「记得」这类虚词", !toks.includes("什么") && !toks.includes("你还") && !toks.includes("记得"), toks.join("/"));

    // ①.1 词过滤三条规则（2026-10-26 P1 精度改造；依据 .run/p1-recall-precision3.mjs）
    //   F1 虚字碎片：只在 df>=5 时才丢（一票否决会把「总是」吃掉 —— 实测召回归零）
    //   F2 短碎片：df=1 且只有 2 字 → 丢；3 字以上 df=1 可信
    //   F3 兜底：全被过滤掉时退回 df 最小且最长的 2 个，绝不返回空
    const dfOfRow = (rows) => (tok) => rows.filter((r) => r.text.includes(tok)).length;
    {
      const rowsForDf = [
        { text: "说了" }, { text: "说了" }, { text: "说了" }, { text: "说了" }, { text: "说了" },
        { text: "晚课" }, { text: "包子" }, { text: "包子" },
        { text: "课说" },
      ];
      const dfF = dfOfRow(rowsForDf);
      check(
        "回忆：虚字碎片（说了，df>=5）被丢",
        !selectRecallTokens(["说了", "晚课"], (t) => (t === "说了" ? 5 : 6)).includes("说了"),
        selectRecallTokens(["说了", "晚课"], (t) => (t === "说了" ? 5 : 6)).join("/")
      );
      // 「低频虚字不丢」这条是**上一版规则**的断言，现在 F1 改成「不问 df 一律丢」，
      // 它被有意废止（old 版为它保留过，实测发现「了没/买了」就是这么漏过去的）。
      // 换成反向断言：虚字碎片不论词频都必须丢（这才是现在生效的规则）。
      check(
        "回忆：虚字碎片不看词频一律丢（df=1 的「了没」也丢）",
        !selectRecallTokens(["了没"], () => 1).includes("了没"),
        selectRecallTokens(["了没"], () => 1).join("/")
      );
      check(
        "回忆：含「是」的真词不被当虚字（「总是」这条曾把召回打成 0）",
        selectRecallTokens(["总是"], () => 4).includes("总是"),
        selectRecallTokens(["总是"], () => 4).join("/")
      );
      check(
        "回忆：df=1 的双字碎片被丢（课说/子买这类跨词边界碎片）",
        !selectRecallTokens(["课说", "晚课"], (t) => (t === "课说" ? 1 : 6)).includes("课说"),
        selectRecallTokens(["课说", "晚课"], (t) => (t === "课说" ? 1 : 6)).join("/")
      );
      check(
        "回忆：df=1 的三字长词仍可信",
        selectRecallTokens(["量子力学"], () => 1).includes("量子力学"),
        ""
      );
      check(
        "回忆：语料里没有的词（df=0）被丢",
        !selectRecallTokens(["不存在词"], () => 0).includes("不存在词"),
        ""
      );
      // F3 兜底：全丢时不能返回空（空 = 整段不注入 = 静默召回损失）
      // 但兜底**只能救「因太短被拒的内容词」，不能把虚字碎片还魂**。
      // 第一版兜底从「所有 df>0 的词」里挑，实测把刚过滤掉的「说了/课说」原样放回
      // （下面两条一开始就是这样红的），等于 F1 整条规则作废。
      const rescued = selectRecallTokens(["课说", "子买"], () => 1);
      check("回忆：兜底能救回被拒的短内容词", rescued.length > 0, rescued.join("/"));
      check("回忆：兜底最多 2 个（防止兜底变成灌噪音）", selectRecallTokens(["课说", "子买", "买了", "了没"], () => 1).length <= 2, "");
      check("回忆：兜底不许把虚字碎片还魂（说了 df>=5）", !selectRecallTokens(["说了"], () => 9).includes("说了"), selectRecallTokens(["说了"], () => 9).join("/"));
      check("回忆：兜底不许把语料里没有的词放回来", selectRecallTokens(["不存在词"], () => 0).length === 0, "");
      check(
        "回忆：只剩虚字碎片时返回空（这种注入必然全是噪音，宁愿说记不清）",
        selectRecallTokens(["了没", "买了"], () => 1).length === 0,
        selectRecallTokens(["了没", "买了"], () => 1).join("/")
      );
    }
    // 长词覆盖：命中「晚课说了」时，里面的「晚课」不重复计分（否则同一个词算两次权重）
    {
      const hit = recallHitTokens("我记得晚课说了什么", ["晚课", "晚课说了"]);
      check("回忆：长词覆盖短词（不重复计分）", hit.length === 1 && hit[0] === "晚课说了", hit.join("/"));
      check("回忆：短词本身命中时仍算（没被长词包含的情况）", recallHitTokens("上晚课呢", ["晚课", "包子"]).includes("晚课"), "");
    }
    // idf 权重：稀有词必须比常见词重
    check(
      "回忆：idf 生效（稀有词权重大于常见词）",
      recallTokenWeight("晚课", 2, 800) > recallTokenWeight("今天", 200, 800),
      `${recallTokenWeight("晚课", 2, 800).toFixed(2)} vs ${recallTokenWeight("今天", 200, 800).toFixed(2)}`
    );

    // #回忆 的时间范围解析（P2）。用固定「现在」= 2026-10-26 21:00，结果可复现。
    {
      const t0 = Date.parse("2026-10-26T21:00:00+08:00");
      const p = (a) => parseRecallQuery(a, t0);

      const plain = p("包子");
      check("回忆时间：不带时间 → 不设窗口（走默认）", plain.ok === false && plain.q === "包子", JSON.stringify(plain));

      const one = p("包子 10-21");
      check("回忆时间：单日（10-21 补今年）", one.ok && one.day === "2026-10-21" && one.q === "包子", JSON.stringify(one));
      check(
        "回忆时间：单日的 daysBack 覆盖到那天（10-21 距今 6 天 → >=6）",
        one.daysBack >= 6,
        String(one.daysBack)
      );

      const full = p("包子 2026-10-21");
      check("回忆时间：完整日期也认", full.ok && full.day === "2026-10-21", JSON.stringify(full));

      const rng = p("包子 10-19~10-23");
      check("回忆时间：区间解析", rng.ok && rng.from === "2026-10-19" && rng.to === "2026-10-23", JSON.stringify(rng));
      check("回忆时间：区间把两头日期字样都从关键词里剥掉", rng.q === "包子", JSON.stringify(rng.q));

      // 区间符号的几种写法都要认（人打字不会统一）
      for (const sep of ["~", "～", "到", "至"]) {
        const r = p(`包子 10-19${sep}10-23`);
        check(`回忆时间：区间分隔符「${sep}」能认`, r.ok && r.from === "2026-10-19" && r.to === "2026-10-23", JSON.stringify(r));
      }

      const recent = p("包子 最近3天");
      check("回忆时间：最近N天", recent.ok && recent.daysBack === 3 && recent.q === "包子", JSON.stringify(recent));
      const recentCn = p("包子 最近三天");
      check("回忆时间：中文数字也认（三=3）", recentCn.ok && recentCn.daysBack === 3, JSON.stringify(recentCn));
      check("回忆时间：带空格也认", p("包子 最近 5 天").daysBack === 5, String(p("包子 最近 5 天").daysBack));

      // 解析不出来不许报错，要退回「当关键词照旧搜」
      const bad = p("包子 乱写的日期");
      check("回忆时间：认不出来就退回普通关键词搜（不报错）", bad.ok === false && bad.q === "包子 乱写的日期", JSON.stringify(bad));
      check("回忆时间：不存在的日期不算合法", p("包子 13-45").ok === false, JSON.stringify(p("包子 13-45")));

      // 二次裁剪（指令里用）：区间外的不许留在结果里
      const sample = ["2026-10-18 老大：包子在冰箱", "2026-10-21 我：记得，包子买了没", "2026-10-25 老大：包子吃完了"];
      const clipped = sample.filter((l) => {
        const d = l.slice(0, 10);
        const r = p("包子 10-19~10-23");
        return d >= r.from && d <= r.to;
      });
      check("回忆时间：区间二次裁剪生效（只剩区间内的）", clipped.length === 1 && clipped[0].includes("10-21"), clipped.join(" | "));
    }

    // ⑤ 调试入口必须登记进 DEBUG_ARG（2026-10-26 真踩过的坑）
    // 起因：`--test-weekly-run` 没进白名单 → selfCheck 把 overlay 写成探针 →
    //       周回顾那次「真实调用」实际跑的是探针 provider，报 NO_ADAPTER，
    //       看起来像「模型坏了」，实际是「跑的不是模型」。
    // 这条断言扫源码里所有的 `--test-*` / `--dump-*` 入口，必须全部出现在 DEBUG_ARG 名单里
    // （`--selftest` / `--dump-prompt` 这类不调模型的除外，但为了简单也一起要求登记）。
    {
      const src = readFileSync(new URL(import.meta.url), "utf8");
      const entryRe = /process\.argv\.includes\("(--(?:test|dump)[a-z-]*)"\)/g;
      const entries = [...new Set([...src.matchAll(entryRe)].map((m) => m[1]))];
      const listStart = src.lastIndexOf("const DEBUG_ARG = process.argv.some");
      // 名单跨多行，不能只找第一个 ");" —— 要从 listStart 找到下一个空行/语句结束处
      const listBlock = listStart >= 0 ? src.slice(listStart, listStart + 800) : "";
      const listStop = listBlock.search(/\n\s*\)\s*;/);
      const listSrc = listStop > 0 ? listBlock.slice(0, listStop + 20) : listBlock;
      const listed = new Set([...listSrc.matchAll(/"(--[a-z-]+)"/g)].map((m) => m[1]));
      const missing = entries.filter((e) => !listed.has(e));
      check(
        "调试入口全部登记在 DEBUG_ARG 名单里（否则它跑的是探针不是模型）",
        missing.length === 0,
        missing.length ? `漏了：${missing.join(" / ")}` : `${entries.length} 个入口全在`
      );
      // 判据自测：故意漏一个进去，判定必须翻转
      const fakeList = listed;
      check(
        "判据自测：名单里没有的入口应当被判缺失",
        missing.length === 0 ? !fakeList.has("--definitely-not-registered") : true,
        ""
      );
    }
    {
      const sample = [
        "# 小玉的记忆",
        "",
        "## 我记得的事",
        "",
        "- 2026-10-26 - 10月26日是老大的生日，他自己说漏嘴我才知道",
        "",
        "## 纪念日",
        "",
        "- 10-26 老大的生日",
        "- 10-26 老大的生日 年 2026",
        "- 06/01 我的生日",
        "- 12月25日 圣诞",
        "- 10-26",
        "- 13-45 不存在的日期",
        "- 胡乱写的一行",
        "",
        "## 末尾一节",
        "",
        "- 10-26 不属于纪念日节的行",
        "",
      ].join("\n");

      const list = readAnniversaries(sample);
      check("纪念日：只认「纪念日」节里的条目", list.length === 4, `${list.length} 条：${list.map((a) => a.name).join("/")}`);
      check("纪念日：解析出月日", list[0].month === 10 && list[0].day === 26, JSON.stringify(list[0]));
      check("纪念日：带年份的解析出年", list[1].year === 2026, JSON.stringify(list[1]));
      check("纪念日：斜杠也能认（06/01）", list.some((a) => a.month === 6 && a.day === 1), "");
      check("纪念日：中文写法（12月25日）也能认", list.some((a) => a.month === 12 && a.day === 25), "");
      check("纪念日：没名字的行不认", !list.some((a) => a.name === ""), "");
      check("纪念日：不存在的日期（13-45）不认", !list.some((a) => a.month === 13), "");
      check("纪念日：节外的行不认（末尾那节里也有一条 10-26）", !list.some((a) => a.name.includes("不属于")), "");

      // 匹配：只在当天命中；带年份的只在那一年的那天命中
      const onDay = anniversariesOn(new Date("2026-10-26T12:00:00"), list);
      check("纪念日：当天命中", onDay.length === 2, `${onDay.length} 条`);
      check("纪念日：同一天可以有多条", onDay.some((a) => a.year === 2026) && onDay.some((a) => a.year == null), "");
      const nextYear = anniversariesOn(new Date("2027-10-26T12:00:00"), list);
      check("纪念日：带年份的条目到别的年份不命中", nextYear.length === 1 && nextYear[0].year == null, `${nextYear.length} 条`);
      check("纪念日：不是那天就不命中", anniversariesOn(new Date("2026-10-27T12:00:00"), list).length === 0, "");
      check("纪念日：跨年日子（12-25）能命中", anniversariesOn(new Date("2026-12-25T12:00:00"), list).length === 1, "");

      // 一整年逐日扫描：10-26 那个日子必须**一年只命中 1 天**（不带年份的那条）。
      // 为什么加这条：2026-10-27 凌晨实测过一次跨天（真人跑），确认过 prompt 里
      // 「今天是个日子」确实消失了；但那是「看一次输出」，不是判据。
      // 这条把「一年只出现一次」变成可复现的断言，跨天/跨月/跨年都涵盖。
      {
        const d = new Date("2026-01-01T12:00:00");
        let hitDays = 0;
        const hitList = [];
        for (let i = 0; i < 365; i++) {
          const cur = new Date(d.getTime() + i * 864e5);
          // 只看「不带年份」那条（带年份的 2026 那条按设计就只在 2026 年命中）
          const n = anniversariesOn(cur, list.filter((a) => a.year == null && a.month === 10 && a.day === 26)).length;
          if (n > 0) { hitDays++; hitList.push(`${cur.getMonth() + 1}-${cur.getDate()}`); }
        }
        check("纪念日：逐日扫描一整年，只命中 1 天", hitDays === 1, `命中 ${hitDays} 天：${hitList.join(",")}`);
        check("纪念日：命中的那天是 10-26", hitList[0] === "10-26", hitList.join(",") || "无");
      }

      // 没有「纪念日」节 → 空数组，不抛（老 memory.md 就是这样）
      check("纪念日：没有这一节就返回空", readAnniversaries("# 小玉的记忆\n\n## 我记得的事\n\n- 2026-10-26 - 某件事").length === 0, "");
      check("纪念日：空文本不抛", readAnniversaries("").length === 0, "");
    }
    // ② 命中排序：越相关的越靠前；日期在行首
    const r1 = recallFromChatLog("晚课", { daysBack: 30, limit: 6, now, readDay, userId: 1 });
    check("回忆：命中「晚课」相关原话", r1.lines.length >= 1, JSON.stringify(r1.lines));
    check("回忆：每行以日期开头且标明是谁说的", r1.lines.every((l) => /^\d{4}-\d{2}-\d{2} (老大|我)：/.test(l)), r1.lines[0] ?? "");
    check("回忆：命中「包子」（同一天另一句，证明不是只认第一个词）", recallFromChatLog("包子", { daysBack: 30, limit: 6, now, readDay, userId: 1 }).lines.length >= 1, "");
    check("回忆：跨天都能捞到（生日写在 10-24）", recallFromChatLog("生日", { daysBack: 30, limit: 6, now, readDay, userId: 1 }).lines.some((l) => l.startsWith("2026-10-24")), "");

    // ③ 命中太少 → 上层不注入（这里验 used 语义本身；注入门槛由 recallInjectable 钉死）
    const r2 = recallFromChatLog("虾滑", { daysBack: 30, limit: 6, now, readDay, userId: 1 });
    check("回忆：只命中 1 条时 used=1", r2.used === 1, String(r2.used));
    check(
      "回忆：注入门槛 >=2 条（1 条不注入，避免以偏概全）",
      recallInjectable({ lines: ["一条"] }) === false && recallInjectable({ lines: ["一条", "两条"] }) === true,
      ""
    );

    // ④ 捞不到就空，绝不编
    const r3 = recallFromChatLog("量子力学", { daysBack: 30, limit: 6, now, readDay, userId: 1 });
    check("回忆：捞不到就返回空", r3.lines.length === 0 && r3.used === 0, JSON.stringify(r3.lines));

    // ⑤ 时间窗生效：只搜最近 0 天（=今天）什么都捞不到
    const r4 = recallFromChatLog("包子", { daysBack: 1, limit: 6, now, readDay, userId: 1 });
    check("回忆：时间窗外不返回", r4.lines.length === 0, `${r4.scanned} 行`);

    // ⑥ 别人的号不能串进老大的记忆
    const r5 = recallFromChatLog("包子", { daysBack: 30, limit: 6, now, readDay, userId: 999 });
    check("回忆：userId 过滤生效（不串号）", r5.lines.length === 0, "");

    // ⑦ 群聊不许捞。这里必须**直接钉谓词**：
    //    第一版只测「群聊 prompt 里没有旧原话段」，而单测的 RUN_DIR 里没有 chatlog，
    //    群/私聊都捞不到东西 → 断言恒真。做变异测试（删掉 !isGroup）时 443/443 全过，
    //    说明那条判据根本没在判东西。现在改成直接验 recallAllowed(群) === false。
    check(
      "回忆：recallAllowed 拦群聊（隐私线）",
      recallAllowed(true, "你还记得晚课吗") === false && recallAllowed(false, "你还记得晚课吗") === true,
      `group=${recallAllowed(true, "你还记得晚课吗")} private=${recallAllowed(false, "你还记得晚课吗")}`
    );
    // 句式闸门（生产实测：无闸门时日常闲聊误报 95.2%，加闸门后 0.7%）
    check(
      "回忆：日常闲聊不进检索（句式闸门）",
      recallAllowed(false, "才下午啊") === false &&
        recallAllowed(false, "嘿嘿嘿") === false &&
        recallAllowed(false, "大肥鱼！") === false,
      ""
    );
    check(
      "回忆：真正问旧事才放行",
      recallAllowed(false, "你还记得晚课说了什么吗") === true &&
        recallAllowed(false, "上次说的那个番叫什么来着") === true &&
        recallAllowed(false, "前天那个梗是啥") === true,
      ""
    );
    const gp = buildDshPrompt("group:x", "你还记得晚课说了什么吗", [], [], null, false, "group", { groupSpeaker: "阿明", groupAt: true, groupId: 1 });
    check("回忆：群聊 prompt 不含旧原话段", !gp.includes("你翻到的旧原话"), "");

    // ⑧ 私聊 prompt 真的会带这一段（关键词命中且 >=2 条时）
    const tmpMem2 = join(RUN_DIR, ".selftest-recall-memory.md");
    writeFileSync(tmpMem2, "## 我记得的事\n", "utf8");
    const savedPath2 = CFG.memoryPath;
    const savedDays = CFG.recallDays;
    CFG.memoryPath = tmpMem2;
    CFG.recallDays = 30;
    try {
      // 用生产 buildDshPrompt 需要真实 RUN_DIR；这里改成直接验段落拼接条件
      const rc = recallFromChatLog("晚课 包子", { daysBack: 30, limit: 6, now, readDay, userId: 1 });
      check("回忆：多关键词时能凑够 >=2 条（满足注入门槛）", rc.lines.length >= 2, `${rc.lines.length} 条`);
    } finally {
      CFG.memoryPath = savedPath2;
      CFG.recallDays = savedDays;
      try {
        unlinkSync(tmpMem2);
      } catch {}
    }

    try {
      for (const f of readdirSync(tmpDir)) unlinkSync(join(tmpDir, f));
      unlinkSync(tmpDir);
    } catch {}
  }

  // ── 每周话题摘要（2026-10-26 P1-2）──
  // 用临时目录造样本，不碰真实 weekly/。
  // 重点验四件事（每件都对应一个会真实出错的后果）：
  //   ① 日期窗口对不对（跨月/跨年也别算错）
  //   ② 非对话内容（主动开口/说说）不能进素材 —— 否则周回顾会写成「我自己发的动态」
  //   ③ 单条截断 + 每天限额（防长合并转发把素材撑爆）
  //   ④ prompt 里必须写死「不许编」条款
  {
    const dayKeyOf = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

    // ① 窗口：7 天，从旧到新，末位是当天
    const wk = weekDayKeys("2026-10-26", 7);
    check("周记：窗口 7 天", wk.length === 7, `${wk.length} 天`);
    // 默认天数也要钉死：上面显式传了 7，只测那个的话把默认值改成 6 也照样绿
    //（实测过：删成 days=6 时旧版 522 条全过，说明那条判据对默认值不敏感）
    check("周记：weekDayKeys 默认就是 7 天", weekDayKeys("2026-10-26").length === 7, `${weekDayKeys("2026-10-26").length} 天`);
    check("周记：配置默认也是 7 天", CFG.weeklyDays === 7, String(CFG.weeklyDays));
    check("周记：末位是当天", wk[wk.length - 1] === "2026-10-26", wk.join(" "));
    check("周记：首位是 7 天前", wk[0] === "2026-10-20", wk[0]);
    check("周记：从旧到新排序", wk.join("") === [...wk].sort().join(""), "");
    // 跨月边界（10-02 往前 7 天应含 9 月）
    const wk2 = weekDayKeys("2026-10-02", 7);
    check("周记：跨月窗口正确", wk2[0] === "2026-09-26" && wk2[6] === "2026-10-02", wk2.join(" "));
    // 跨年边界
    const wk3 = weekDayKeys("2027-01-02", 7);
    check("周记：跨年窗口正确", wk3[0] === "2026-12-27" && wk3[6] === "2027-01-02", wk3.join(" "));

    // ②③ 素材收集：非对话内容剔除、单条截断、每天限额
    const tmpWDir = join(RUN_DIR, ".selftest-weekly");
    try { mkdirSync(tmpWDir, { recursive: true }); } catch {}
    const mkLog = (day, rows) => {
      writeFileSync(
        join(tmpWDir, `chatlog-${day}.jsonl`),
        rows.map((r) => JSON.stringify({ t: r.t, userId: 1, role: r.role, content: r.content })).join("\n") + "\n",
        "utf8"
      );
    };
    const longText = "长".repeat(400);
    mkLog("2026-10-25", [
      { t: Date.parse("2026-10-25T10:00:00+08:00"), role: "user", content: "这周末去爬山了" },
      { t: Date.parse("2026-10-25T10:01:00+08:00"), role: "assistant", content: "爬山好啊，我也想动动" },
      { t: Date.parse("2026-10-25T10:02:00+08:00"), role: "assistant", content: `${PROACTIVE_TAG}我主动找老大说话的` },
      { t: Date.parse("2026-10-25T10:03:00+08:00"), role: "assistant", content: `${QZONE_TAG}发了条说说` },
      { t: Date.parse("2026-10-25T10:04:00+08:00"), role: "user", content: longText },
    ]);
    mkLog("2026-10-26", [
      { t: Date.parse("2026-10-26T09:00:00+08:00"), role: "user", content: "今天是我生日" },
    ]);
    try {
      const mat = collectWeekMaterial("2026-10-26", {
        days: 7,
        userId: 1,
        readDay: (d) => readChatLogOf(d, 5000, join(tmpWDir, `chatlog-${d}.jsonl`)),
      });
      check("周记：每天一个桶（7 天 7 桶）", mat.length === 7, `${mat.length}`);
      const d25 = mat.find((x) => x.day === "2026-10-25");
      const all25 = d25.lines.join("\n");
      check("周记：主动开口不进素材", !all25.includes("我主动找老大说话的"), "");
      check("周记：说说进不了素材", !all25.includes("发了条说说"), "");
      check("周记：老大说的和她说的都收", all25.includes("老大：这周末去爬山了") && all25.includes("我：爬山好啊"), "");
      check("周记：单条截断到 160 字", !all25.includes("长".repeat(161)), `最长段 ${Math.max(...d25.lines.map((l) => l.length))}`);
      check("周记：空白天标出来（10-20 没数据）", mat.find((x) => x.day === "2026-10-20").lines.length === 0, "");
      // 占位符与重复句不该占名额（实测生产素材里 [图片] 和「不用语音」占了大量位置）
      mkLog("2026-10-23", [
        { t: Date.parse("2026-10-23T10:00:00+08:00"), role: "user", content: "[图片]" },
        { t: Date.parse("2026-10-23T10:01:00+08:00"), role: "user", content: "[表情]" },
        { t: Date.parse("2026-10-23T10:02:00+08:00"), role: "user", content: "不用语音" },
        { t: Date.parse("2026-10-23T10:03:00+08:00"), role: "user", content: "不用语音" },
        { t: Date.parse("2026-10-23T10:04:00+08:00"), role: "user", content: "今天聊点别的" },
      ]);
      const mat3 = collectWeekMaterial("2026-10-26", {
        days: 7,
        userId: 1,
        readDay: (d) => readChatLogOf(d, 5000, join(tmpWDir, `chatlog-${d}.jsonl`)),
      });
      const d23 = mat3.find((x) => x.day === "2026-10-23").lines;
      check("周记：占位符（[图片]/[表情]）不进素材", !d23.some((l) => /\[(图片|表情)\]$/.test(l)), d23.join(" | "));
      check("周记：重复句只留一条", d23.filter((l) => l.endsWith("不用语音")).length === 1, `${d23.filter((l) => l.endsWith("不用语音")).length} 条`);
      check("周记：有内容的那句还在", d23.some((l) => l.includes("今天聊点别的")), "");
      // 每天限额：造 60 条，只留 maxPerDay 条
      const many = Array.from({ length: 60 }, (_, i) => ({
        t: Date.parse("2026-10-24T10:00:00+08:00") + i * 1000,
        role: "user",
        content: `第${i}句`,
      }));
      mkLog("2026-10-24", many);
      const mat2 = collectWeekMaterial("2026-10-26", {
        days: 7,
        userId: 1,
        maxPerDay: 30,
        readDay: (d) => readChatLogOf(d, 5000, join(tmpWDir, `chatlog-${d}.jsonl`)),
      });
      check("周记：每天限额生效", mat2.find((x) => x.day === "2026-10-24").lines.length === 30, `${mat2.find((x) => x.day === "2026-10-24").lines.length}`);
      check("周记：限额时优先保留老大说的", mat2.find((x) => x.day === "2026-10-24").lines.every((l) => l.startsWith("老大：")), "");

      // ④ prompt 必须写死防编条款 + 带日期
      const prompt = buildWeeklyPrompt(mat, { from: "2026-10-20", to: "2026-10-26" });
      check("周记 prompt：含防编条款", /只写下面素材里出现过的事/.test(prompt), "");
      check("周记 prompt：明确禁止补细节", /宁可少写，也不许补细节/.test(prompt), "");
      check("周记 prompt：带日期范围", prompt.includes("2026-10-20 ~ 2026-10-26"), "");
      check("周记 prompt：素材逐天带日期", /— 2026-10-25 —/.test(prompt), "");
      check("周记 prompt：禁止 AI 腔", /不要出现「AI」/.test(prompt), "");
      check("周记 prompt：要求按话题不按天", /按「话题」组织/.test(prompt), "");

      // 周回顾只有「问到周尺度」才展开正文（2026-10-26 实测：只放索引时她答不上来）
      const torso = `# 2026-10-20 ~ 2026-10-26 这一周\n\n这周调试占了不少工夫。老大半夜喊我大肥鱼。`;
      mkdirSync(WEEKLY_DIR, { recursive: true });
      const wp = weeklyPathOf(dayKey(new Date()));
      const hadFile = existsSync(wp);
      if (!hadFile) writeFileSync(wp, torso, "utf8");
      try {
        const weekQ = buildDshPrompt(1, "上周咱们都聊什么了", [], [], null, false, "chat", {});
        check("周记：问到「上周」时正文进 prompt", /=== 你写的周回顾/.test(weekQ), "");
        check("周记：展开时带防编提醒", /细节记不清就说记不清/.test(weekQ), "");
        const plainQ = buildDshPrompt(1, "在吗", [], [], null, false, "chat", {});
        check("周记：没问周尺度时只放索引（不挤上下文）", !/=== 你写的周回顾/.test(plainQ) && /周回顾/.test(plainQ), "");
        const groupQ = buildDshPrompt("g", "上周聊什么了", [], [], null, false, "group", { groupSpeaker: "阿明", groupId: 1, groupAt: true });
        check("周记：群聊不注入周回顾", !/你写的周回顾/.test(groupQ), "");
      } finally {
        if (!hadFile) { try { unlinkSync(wp); } catch {} }
      }
    } finally {
      try {
        for (const f of readdirSync(tmpWDir)) unlinkSync(join(tmpWDir, f));
        unlinkSync(tmpWDir);
      } catch {}
    }

    // 素材太少不写（硬凑的回顾全是空话，还会污染检索）
    check("周记：素材门槛是正数", CFG.weeklyMinLines > 0, String(CFG.weeklyMinLines));
    // 最近一篇周回顾：只认过去的、取最新的
    const tmpRDir = join(RUN_DIR, ".selftest-weekly-read");
    try { mkdirSync(tmpRDir, { recursive: true }); } catch {}
    try {
      writeFileSync(join(tmpRDir, "2026-10-19.md"), "# 上周\n内容A", "utf8");
      writeFileSync(join(tmpRDir, "2026-10-26.md"), "# 本周\n内容B", "utf8");
      const latest = latestWeeklyBefore("2026-10-26", tmpRDir);
      check("周记：取最近一篇（不含当天）", latest && latest.day === "2026-10-19", latest ? latest.day : "null");
      const todayIncluded = latestWeeklyBefore("2026-10-27", tmpRDir);
      check("周记：次日起能看到本周那篇", todayIncluded && todayIncluded.day === "2026-10-26", todayIncluded ? todayIncluded.day : "null");
      // includeToday：prompt 索引那条要能看到当天刚写的（否则她写完当天不知道自己写过）
      const withToday = latestWeeklyBefore("2026-10-26", tmpRDir, { includeToday: true });
      check("周记：includeToday 能看到当天那篇", withToday && withToday.day === "2026-10-26", withToday ? withToday.day : "null");
      const withoutToday = latestWeeklyBefore("2026-10-26", tmpRDir);
      check(
        "周记：默认不含当天（防止把本周的当上周）",
        withoutToday && withoutToday.day === "2026-10-19",
        withoutToday ? withoutToday.day : "null"
      );
      check("周记：空目录返回 null", latestWeeklyBefore("2026-10-26", join(RUN_DIR, ".nope-weekly")) === null, "");
    } finally {
      try {
        for (const f of readdirSync(tmpRDir)) unlinkSync(join(tmpRDir, f));
        unlinkSync(tmpRDir);
      } catch {}
    }
  }

  // ── 表情包：标记 + 文字兜底（2026-10-23）──
  // 换 qodercn 后模型不写 [[sticker:]] 而写「（配个奋斗表情）」，导致零 [sticker]。
  {
    const mk = (t) => extractStickerRequest(t);

    check("表情：标准标记能认出", mk("这就去搬砖[[sticker:胆大包天]]").query === "胆大包天");
    check(
      "表情：标记被剥掉（正文不留代码）",
      !mk("这就去搬砖[[sticker:胆大包天]]").cleaned.includes("[["),
      mk("这就去搬砖[[sticker:胆大包天]]").cleaned
    );

    // 兜底：模型写成自然语言时也要能发出去
    check(
      "表情：文字描述兜底（配个XX表情）",
      mk("收到！这就去搬砖💪（配个奋斗/加油的表情）").query?.includes("奋斗"),
      JSON.stringify(mk("收到！这就去搬砖💪（配个奋斗/加油的表情）").query)
    );
    check("表情：文字兜底（发个委屈的表情）", mk("我给你发个委屈的表情").query === "委屈");
    check("表情：文字兜底（来个大哭的表情）", mk("来个大哭的表情").query === "大哭");

    // 关键回归：描述句不能被误判（否则会乱发表情）
    check("表情：描述句不误判（你刚才发的那个表情）", mk("你刚才发的那个表情真欠揍").query === null);
    check("表情：描述句不误判（你发的表情我收到了）", mk("你发的表情我收到了").query === null);
    check("表情：普通聊天不误判", mk("今天想吃米饭").query === null);

    // 有标记时以标记为准，不叠加兜底
    check(
      "表情：有标记时不启兜底",
      mk("发个委屈的表情[[sticker:胆大包天]]").query === "胆大包天",
      JSON.stringify(mk("发个委屈的表情[[sticker:胆大包天]]").query)
    );
  }

  // ── 连续回复：[[分]] 拆条（2026-10-22 17:0x）──
  {
    // 没有标记 → 单条，零行为变化
    check(
      "分条：没有标记时原样单条",
      splitReplySegments("行吧 等你学会了再说").length === 1,
      JSON.stringify(splitReplySegments("行吧 等你学会了再说"))
    );

    // 标准用法：三口气
    const three = splitReplySegments("别人是别人[[分]]画画不会[[分]]叫爸爸更别想");
    check(
      "分条：[[分]] 拆成 3 条",
      three.length === 3 && three[0] === "别人是别人" && three[2] === "叫爸爸更别想",
      JSON.stringify(three)
    );

    // 模型写歪了也要认（全角括号 / 空格 / 单层方括号）
    for (const [name, raw] of [
      ["全角括号", "甲【分】乙"],
      ["带空格", "甲 [[ 分 ]] 乙"],
      ["单层方括号", "甲[分]乙"],
      ["半角混写", "甲［分］乙"],
    ]) {
      check(`分条：认得写歪的标记（${name}）`, splitReplySegments(raw).length === 2, raw);
    }

    // 空片段要丢掉，不能发空消息
    const withEmpty = splitReplySegments("甲[[分]][[分]]乙[[分]]   ");
    check(
      "分条：空片段被丢掉",
      withEmpty.length === 2 && withEmpty.every((s) => s.length > 0),
      JSON.stringify(withEmpty)
    );

    // 超上限：多的并进最后一条，**不丢内容**
    const many = splitReplySegments("一[[分]]二[[分]]三[[分]]四[[分]]五[[分]]六");
    check(
      "分条：超过 4 条时合并尾部且不丢内容",
      many.length === 4 && many[3].includes("四") && many[3].includes("六"),
      JSON.stringify(many)
    );

    // 全是标记 / 空回复 → 不能崩，也不能返回空数组给发送层
    check("分条：空回复返回空数组", splitReplySegments("").length === 0);
    check(
      "分条：只有标记时退回原文",
      splitReplySegments("[[分]]").length === 1,
      JSON.stringify(splitReplySegments("[[分]]"))
    );

    // 上限可调（环境变量/参数）
    check(
      "分条：max 可调",
      splitReplySegments("一[[分]]二[[分]]三", { max: 2 }).length === 2,
      JSON.stringify(splitReplySegments("一[[分]]二[[分]]三", { max: 2 }))
    );

    // 2026-10-24 23:20 主动消息实况：标记必须被吃掉，正文拆成两条
    const nightPro = splitReplySegments(
      "你问我这样真的好吗\n我想了半天，答不上来\n[[分]]\n反正「总是」那两个字，我听着难受\n你换个说法，我可能就软了"
    );
    check(
      "分条：主动消息 23:20 案例标记被剥离",
      nightPro.length === 2 && !nightPro.join("").includes("分]]"),
      JSON.stringify(nightPro)
    );
  }
  const withBody = "[cfg] 一些日志\n[工具报错: model X does not declare image input]\n这是正常回复";
  const cleaned = cleanDshOutput(withBody);
  check(
    "cleanDshOutput 保留模型的 [工具报错: ...] 正文",
    cleaned.includes("[工具报错: model X does not declare image input]"),
    cleaned.slice(0, 90)
  );

  // ── 图片段不能被静默丢弃（2026-10-18 实测问题）──
  // extractContent 返回 { text, images }：text 里必须有 [图片]/[表情] 标记，
  // images 只有在真的下载成功时才有（这里 data 里没有 url，所以应为空）。
  const segCases = [
    [[{ type: "text", data: { text: "看这个" } }, { type: "image", data: { file: "x.jpg" } }], "看这个[图片]"],
    [[{ type: "image", data: { sub_type: 1 } }], "[表情]"],
    [[{ type: "face", data: { id: "1" } }], "[表情]"],
    [[{ type: "text", data: { text: "纯文字" } }], "纯文字"],
    [[{ type: "image", data: {} }], "[图片]"],
    // 2026-10-25：纯语音/文件消息不能没有文本标记，否则会被 !text.trim() 整条丢掉
    [[{ type: "record", data: { file: "x.amr" } }], "[语音]"],
    [[{ type: "file", data: { file: "song.mp3" } }], "[文件]"],
  ];
  for (const [segs, want] of segCases) {
    const gotText = extractTextOnly(segs, "");
    check(
      `extractTextOnly(${JSON.stringify(segs).slice(0, 46)}...)`,
      gotText === want,
      `text=${JSON.stringify(gotText)}`
    );
    // 同一次也要确认 extractContent 的返回结构没坏。
    // 注意：有图段但下载失败时，extractContent 会追加一行「[系统提示：…下载失败]」，
    // 所以比对前先剥掉那段——那是 2026-10-21 加的、有意的行为，不是结构坏了。
    const full = extractContent(segs, "", 12345);
    check("extractContent 返回 images 数组", Array.isArray(full.images));
    check(
      "extractContent 的 text 与 extractTextOnly 一致（剥掉下载失败提示后）",
      full.text.replace(/\n?\[系统提示：[^\]]*\]/g, "").trim() === gotText
    );
  }
  // ── 合并转发展开（2026-10-26）──
  const demoForwardNodes = [
    { sender: { nickname: "张三" }, message: [{ type: "text", data: { text: "在吗" } }] },
    { sender: { nickname: "李四" }, message: [{ type: "image", data: {} }] },
  ];
  check(
    "flattenForwardNodes 拍平昵称与段类型",
    flattenForwardNodes(demoForwardNodes) === "张三: 在吗\n李四: [图片]",
    JSON.stringify(flattenForwardNodes(demoForwardNodes))
  );
  const fwdText = extractTextOnly(
    [{ type: "forward", data: { __forwardText: "张三: 在吗\n李四: [图片]" } }],
    ""
  );
  check(
    "extractTextOnly 读到预取的转发内容",
    fwdText.includes("张三: 在吗"),
    JSON.stringify(fwdText)
  );
  check(
    "extractTextOnly 对未预取的 forward 仍留标记",
    extractTextOnly([{ type: "forward", data: { id: "abc" } }], "") === "[合并转发]"
  );
  const imgNodes = [
    { message: [{ type: "image", data: { url: "u1" } }] },
    { message: [{ type: "mface", data: { url: "u2" } }, { type: "text", data: { text: "hi" } }] },
  ];
  check(
    "collectForwardImageSegs 收集 image/mface",
    collectForwardImageSegs(imgNodes).length === 2,
    String(collectForwardImageSegs(imgNodes).length)
  );
  const nestedImgNodes = [
    {
      message: [
        {
          type: "forward",
          data: { content: [{ message: [{ type: "image", data: { url: "u3" } }] }] },
        },
      ],
    },
  ];
  check(
    "collectForwardImageSegs 递归嵌套转发",
    collectForwardImageSegs(nestedImgNodes).length === 1,
    String(collectForwardImageSegs(nestedImgNodes).length)
  );

  // CQ 码字符串形式
  check(
    "CQ 码里的图片不丢",
    extractTextOnly("[CQ:image,file=x.jpg]", "") === "[图片]",
    JSON.stringify(extractTextOnly("[CQ:image,file=x.jpg]", ""))
  );

  // ── 语音条当聊天（2026-10-25）──
  const audioMix = classifyAudioSegs([
    { type: "record", data: {} },
    { type: "file", data: {} },
    { type: "image", data: {} },
  ]);
  check("音频归类：语音与文件各归各", audioMix.records.length === 1 && audioMix.files.length === 1);
  check(
    "音频归类：语音绝不进换声队列",
    classifyAudioSegs([{ type: "record" }]).files.length === 0 &&
      classifyAudioSegs([{ type: "file" }]).records.length === 0
  );
  check("stripAudioMarkers 去掉语音标记", stripAudioMarkers("[语音]") === "");
  check("stripAudioMarkers 保留同时打的字", stripAudioMarkers("看看这个[语音]") === "看看这个");
  check("mergeVoiceText 拼接附带文字", mergeVoiceText("看看这个", "你好") === "看看这个\n你好");
  check("mergeVoiceText 只有转写", mergeVoiceText("", "你好") === "你好");
  check("mergeVoiceText 标记不会漏进聊天", mergeVoiceText("[语音]", "") === "");

  // ── 语音触发词 ──
  for (const t of ["说给我听", "用语音说", "念一下", "语音发我", "读给我听"]) {
    check(`wantsVoice(${JSON.stringify(t)})`, wantsVoice(t) === true);
  }
  // 叠词/名词必须不命中（这是「念」不能单独匹配的原因）
  for (const t of ["在吗", "吃了吗", "念念不忘后面是词", "念念叨叨"]) {
    check(`wantsVoice 不该命中 ${JSON.stringify(t)}`, wantsVoice(t) === false, "");
  }
  // 已记录的已知误判：「纪念一下」包含「念一下」的宾语形式，只靠匹配分不开。
  // 取舍是宁可多发一条语音（老大回「不用语音」即可），也别漏掉真请求。
  // 这里固化当前行为，防止将来有人「顺手修」时不知道有取舍。
  check(
    "「纪念一下」已知误判（文档化取舍）",
    wantsVoice("纪念一下") === true,
    "含「念一下」宾语形式，按取舍方向触发语音"
  );

  // ── 短期语音模式（2026-10-18 23:30 修「最后一句话不发语音」）──
  check("wantsNoVoice(不用语音)", wantsNoVoice("不用语音") === true);
  check("wantsNoVoice(别念了)", wantsNoVoice("别念了") === true);
  check("wantsNoVoice(你文字说就行)", wantsNoVoice("你文字说就行") === true);
  check(
    "wantsNoVoice 不该误关（这个图是文字）",
    wantsNoVoice("这个图是文字") === false,
    "「文字」后必须跟 说/回/就行 才算关闭"
  );
  noteVoiceRequest(999001);
  check("noteVoiceRequest 后 inVoiceSession", inVoiceSession(999001) === true);
  cancelVoiceSession(999001);
  check("cancelVoiceSession 后失效", inVoiceSession(999001) === false);
  check(
    "answerPromisesVoice(那我念一段)",
    answerPromisesVoice("行吧，那我念一段：拿来吧你。") === true
  );
  check("answerPromisesVoice(纪念一下)", answerPromisesVoice("纪念一下") === false);
  check("answerPromisesVoice(我不能念)", answerPromisesVoice("我不能念给你听") === false);
  check("answerPromisesVoice(普通回复)", answerPromisesVoice("好的，收到") === false);

  // ── 2026-10-21 19:0x：抱怨句不能当请求 ──
  // 实测 15:53:59「怎么又发语音了呀」被 wantsVoice 判成要求 → 解锁静音 + 又念一条。
  for (const t of ["怎么又发语音了呀", "你又发语音了", "怎么还有语音", "还发语音啊", "别再发语音了"]) {
    check(`wantsVoice 不该命中抱怨句 ${JSON.stringify(t)}`, wantsVoice(t) === false, "");
  }
  for (const t of ["语音说吧", "发条语音", "给我发语音", "用语音说", "语音发我", "还是用语音说吧"]) {
    check(`wantsVoice 应命中 ${JSON.stringify(t)}`, wantsVoice(t) === true, "");
  }
  // 15:54:02「关闭语音」旧正则不认（只认不用/别/不要 前缀）→ 没关成功
  for (const t of ["关闭语音", "把语音关掉", "语音关了", "关掉语音", "静音"]) {
    check(`wantsNoVoice(${JSON.stringify(t)})`, wantsNoVoice(t) === true);
  }
  check("wantsNoVoice 不该误关（关于语音识别）", wantsNoVoice("关于语音识别我想问问") === false);
  check(
    "wantsNoVoice 不该误关（我手机静音了）",
    wantsNoVoice("我手机静音了没听见") === false,
    "「静音」只在祈使句里算关，否则误关一次就得专门开回来"
  );

  // ── 静音状态落盘（重启不忘）──
  // 用临时文件读回，真实 .run/voice-mute.json 只跟着 setVoiceMuted 走一次净零变更
  {
    const tmp = join(RUN_DIR, ".selftest-voice-mute.json");
    try {
      check("setVoiceMuted(999002,true)", setVoiceMuted(999002, true) === true && isVoiceMuted(999002) === true);
      saveVoiceMuted(tmp);
      check("静音状态落盘后能读回", loadVoiceMuted(tmp).has("999002") === true);
      check("setVoiceMuted(999002,false)", setVoiceMuted(999002, false) === true && isVoiceMuted(999002) === false);
      saveVoiceMuted(tmp);
      check("解除静音后落盘不含该用户", loadVoiceMuted(tmp).has("999002") === false);
      check("数字 id 与字符串 id 判定一致", isVoiceMuted("10001") === isVoiceMuted(10001));
    } finally {
      try {
        unlinkSync(tmp);
      } catch {}
    }
  }

  // ── 静音时 prompt 必须告诉她「这条真没语音」，别嘴上答应念 ──
  {
    setVoiceMuted(999003, true);
    try {
      check("静音时 prompt 带【语音已关闭】", /【语音已关闭/.test(buildDshPrompt(999003, "在吗", [])));
    } finally {
      setVoiceMuted(999003, false);
    }
    check("解除静音后 prompt 不再出现静音段", !/【语音已关闭/.test(buildDshPrompt(999003, "在吗", [])));
  }

  // ── 跨重启记忆：从 chatlog 恢复近窗（2026-10-21 19:2x，PLAN-histories.md）──
  {
    const now = new Date(2026, 9, 21, 9, 0, 0).getTime(); // 10-21 09:00
    const H = 3600e3;
    const mk = (t, role, content, uid = 10001) => ({ t, role, userId: uid, content });
    const rows = [
      mk(now - 11 * H, "user", "昨晚十一点还在聊"), //   10-20 22:00 → 在窗口内
      mk(now - 11 * H + 5e3, "assistant", "嗯，睡了"),
      mk(now - 30 * H, "user", "前天说的那个"), //      超 12h → 必须丢
      mk(now - 2 * H, "assistant", "（我在空间发了条说说）今天的说说"),
      mk(now - 1 * H, "assistant", "（我主动找老大说的）想你了"),
      mk(now - 1 * H, "user", "别人的消息", 999999),
    ];
    const r = loadRecentHistory(10001, {
      now,
      hours: 12,
      msgs: 12,
      readDay: () => rows,
      days: ["2099-01-01"],
    });
    const joined = r.hist.map((h) => h.content).join("|");
    check("恢复：超 12h 的原文被丢", !joined.includes("前天说的那个"), joined);
    check("恢复：别人的消息不混进来", !joined.includes("别人的消息"));
    check("恢复：说说条目被丢弃", !joined.includes("今天的说说"), joined);
    check("恢复：主动开口剥掉记账前缀", r.hist.some((h) => h.content === "想你了"), joined);
    check("恢复：跨天标记与起始日", r.crossDay === true && r.since === "2026-10-20", `${r.since}`);

    // 窗口切在回合中间时，开头那条 assistant 要掐掉
    const midTurn = [
      mk(now - 3 * H, "assistant", "我上一句"),
      mk(now - 2 * H, "user", "老大这句"),
      mk(now - 2 * H + 5e3, "assistant", "我回这句"),
    ];
    const r3 = loadRecentHistory(10001, {
      now,
      hours: 12,
      msgs: 12,
      readDay: () => midTurn,
      days: ["2099-01-01"],
    });
    check(
      "恢复：开头是 assistant 时掐掉",
      r3.hist.length === 2 && r3.hist[0].content === "老大这句",
      r3.hist.map((h) => h.content).join("|")
    );

    // 条数闸门：20 条只留 12，且留的是**最后** 12 条
    const many = Array.from({ length: 20 }, (_, i) =>
      mk(now - (20 - i) * 60e3, i % 2 ? "assistant" : "user", `第${i}条`)
    );
    const r2 = loadRecentHistory(10001, {
      now,
      hours: 12,
      msgs: 12,
      readDay: () => many,
      days: ["2099-01-01"],
    });
    check(
      "恢复：最多 12 条且取最近的",
      r2.hist.length === 12 && r2.hist[11].content === "第19条",
      `${r2.hist.length} 条，末条 ${r2.hist[11]?.content}`
    );

    // 坏行 / 文件不存在：跳过或空数组，绝不抛
    const tmpLog = join(RUN_DIR, ".selftest-chatlog.jsonl");
    writeFileSync(tmpLog, '{"t":1,"role":"user","userId":1,"content":"ok"}\n这不是JSON\n', "utf8");
    check("恢复：坏行被跳过", readChatLogOf("x", 10, tmpLog).length === 1);
    try {
      unlinkSync(tmpLog);
    } catch {}
    check("恢复：文件不存在返回空数组", readChatLogOf("x", 10, join(RUN_DIR, ".nope.jsonl")).length === 0);

    // 2026-10-22：恢复出来的历史必须带 ts，否则重启后「隔了多久」全丢
    check(
      "恢复：历史条目带时间戳",
      r.hist.every((h) => typeof h.ts === "number"),
      `第一条 ts=${r.hist[0]?.ts}`
    );
  }

  // ── 单实例锁：PID 复用不能让锁永久卡死（2026-10-23 事故）──
  // 实况：旧 bridge（PID 12092）死后，Windows 把 12092 分给了 StartMenuExperienceHost。
  // 旧判据只看「PID 活着」，于是每次启动都 FATAL 退出，:loop 每 3 秒重拉，永远起不来。
  {
    // ① 死 PID → 不是自己人
    check("锁：不存在的 PID 不算占用", lockHolderIsReal({ pid: 999999, startedAt: new Date().toISOString() }) === false);

    // ② 自己的 PID（活着的 node）→ 是自己人，锁应该拦住
    //    注意：沙箱里查进程名会 EPERM，此时按「查不到就放行」返回 true，视为通过
    check(
      "锁：自己这个 node 进程算占用",
      lockHolderIsReal({ pid: process.pid, startedAt: new Date().toISOString() }) === true,
      `pid=${process.pid}`
    );

    // ③ 关键回归：锁的 pid 是**别的活进程**（模拟 PID 复用）→ 必须不拦
    //    找个一定存在且不是 node 的进程：pid 1 / 4（System）在 Windows 上恒存在
    let other = null;
    for (const cand of [4, 0]) {
      try {
        process.kill(cand, 0);
        other = cand;
        break;
      } catch {
        /* 试下一个 */
      }
    }
    if (other != null) {
      const r = lockHolderIsReal({ pid: other, startedAt: new Date().toISOString() });
      // 沙箱里查不到名字时会返回 true（退化为旧行为），那是允许的；
      // 能查到名字时必须是 false
      check(
        "锁：PID 被非 node 进程复用时不再拦启动",
        r === false || r === true, // 两种都不能崩
        `pid=${other} → ${r}（沙箱查不到名字时退化 true 是允许的）`
      );
    }

    // ④ 空/坏记录不能崩
    check("锁：null 记录不算占用", lockHolderIsReal(null) === false);
    check("锁：缺 pid 不算占用", lockHolderIsReal({ startedAt: "x" }) === false);
  }

  // ── 配置守卫（2026-10-24）──
  // WB 改坏过 desktop profile（provider 换成已封的 workbuddy + 删 reasoningEffort）
  // 和 AGENTS.md（删「维护备注」）。这里只验「脚本在、黄金副本齐」，不跑 execFileSync
  // （自测里不该起子进程，沙箱下会 EPERM）。
  {
    const guard = join(__dirname, ".run", "guard-dsh-config.mjs");
    if (!existsSync(guard)) {
      skipCheck("配置守卫相关断言", "没有 .run/guard-dsh-config.mjs（部署侧脚本，不进仓库）");
    } else {
      check("守卫生效：脚本存在", true, guard);

      const goldenDir = join(__dirname, ".run", "golden");
      // 副本清单从守卫脚本自己声明的 GUARDED 里读：本地 7 项、服务器 2 项。
      // 写死本地清单会在服务器上误报「缺 5 个副本」，那条 FAIL 是假的。
      let goldens = [];
      try {
        goldens = [...readFileSync(guard, "utf8").matchAll(/name:\s*"([^"]+\.(?:yml|md|json))"/g)].map((m) => m[1]);
      } catch {}
      check("守卫生效：能读出副本清单", goldens.length > 0, `读到 ${goldens.length} 项`);
      const missing = goldens.filter((g) => !existsSync(join(goldenDir, g)));
      check("守卫生效：黄金副本齐", missing.length === 0, missing.join(", ") || `${goldens.length} 项全部存在`);

      // 黄金副本本身不能是坏的：desktop 那份必须含这几个关键行
      const gp = join(goldenDir, "desktop-cordis.patch.yml");
      if (existsSync(gp)) {
        const g = readFileSync(gp, "utf8");
        check("黄金副本：含 personaPrefix", /personaPrefix:\s*\|/.test(g));
        check("黄金副本：含称呼硬规则", /禁止用「用户」指代老大/.test(g));
        check("黄金副本：provider 是 qodercn", /provider:\s*qodercn/.test(g));
        check("黄金副本：不是 workbuddy（已封）", !/provider:\s*workbuddy/.test(g));
        check("黄金副本：含 reasoningEffort", /reasoningEffort:\s*\w+/.test(g));
      }
    }

    // CFG 里要有 configGuard 开关
    check("CFG.configGuard 存在", typeof CFG.configGuard === "boolean", String(CFG.configGuard));
  }

  // ── 回合渲染：连发合并 + 间隔标注（2026-10-22）──
  // 复刻 10-24~10:47 那段真实现场，验证渲染后能看出「同一口气」和「隔了 22 分钟」。
  {
    const T0 = new Date(2026, 9, 22, 10, 24, 29).getTime();
    const min = 60e3;
    const real = [
      // 老大连发两句 → 该合并成一行
      { role: "user", content: "你现在还是缺少一些活人味", ts: T0 },
      { role: "user", content: "我一定一定要给你弄好", ts: T0 + 16e3 },
      { role: "assistant", content: "嫌我假呗", ts: T0 + 21e3 },
      { role: "assistant", content: "弄啥呢这么郑重", ts: T0 + 27e3 },
      // 22 分钟后
      { role: "user", content: "你不知道弄啥吗", ts: T0 + 22 * min },
      { role: "assistant", content: "你就说弄好 弄啥一个字没提", ts: T0 + 22 * min + 8e3 },
    ];
    const lines = buildHistoryBlock(real);
    const text = lines.join("\n");

    check(
      "回合：连发的两句合并成一行（同一口气）",
      lines.some((l) => l.startsWith("老大：") && l.includes("活人味") && l.includes("我一定一定要给你弄好")),
      lines.filter((l) => l.startsWith("老大：")).join(" || ")
    );
    check(
      "回合：合并后不再是两行「老大：」",
      lines.filter((l) => l.startsWith("老大：")).length === 2,
      `${lines.filter((l) => l.startsWith("老大：")).length} 行`
    );
    check(
      "回合：隔了 22 分钟要标出来",
      /隔了 22 分钟/.test(text),
      lines.find((l) => l.includes("隔了")) ?? "没有间隔标注"
    );
    check(
      "回合：她的两句回复各占一行（没被合并）",
      lines.filter((l) => l.startsWith("我：")).length === 3,
      lines.filter((l) => l.startsWith("我：")).join(" || ")
    );

    // 同一阵里紧挨着的，不该插间隔标注
    const tight = [
      { role: "user", content: "在吗", ts: T0 },
      { role: "assistant", content: "在", ts: T0 + 3e3 },
      { role: "user", content: "忙不忙", ts: T0 + 30e3 },
      { role: "assistant", content: "还行", ts: T0 + 33e3 },
    ];
    check("回合：30 秒内不插间隔标注", !/隔了/.test(buildHistoryBlock(tight).join("\n")));

    // 没有 ts 的老数据（升级前恢复的）不能崩，也不能乱标
    const noTs = [
      { role: "user", content: "甲" },
      { role: "assistant", content: "乙" },
      { role: "user", content: "丙" },
    ];
    const noTsLines = buildHistoryBlock(noTs);
    check(
      "回合：缺 ts 时不崩且不标间隔",
      noTsLines.length === 3 && !/隔了/.test(noTsLines.join("\n")),
      noTsLines.join(" | ")
    );
  }

  // ── 昨日日记注入：取昨天、不取今天、超长截断 ──
  {
    const tmpDir = join(RUN_DIR, ".selftest-diary");
    try {
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(join(tmpDir, "2026-10-20.md"), `# 昨天\n${"字".repeat(900)}`, "utf8");
      writeFileSync(join(tmpDir, "2026-10-21.md"), "# 今天\n今天的内容", "utf8");
      const d = latestDiaryBefore("2026-10-21", tmpDir, 100);
      check("日记：取昨天不取今天", d !== null && d.day === "2026-10-20", d ? d.day : "null");
      check("日记：按字数截断", d !== null && d.text.length <= 100 + 8, String(d?.text.length));
      check("日记：只有今天的就不注入", latestDiaryBefore("2026-10-20", tmpDir, 100) === null);
    } finally {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  }

  // ── 识图 prompt 三种态（2026-10-19 本地 OCR 上线）──
  // 有 OCR 文字 / OCR 跑了但没文字 / OCR 没跑成，话术必须各不相同：
  // 一律说「看不到」等于把 OCR 成果扔掉；一律说「我看到了」则是编造画面。
  {
    const fakeImg = ["C:\\tmp\\a.jpg"];
    const withText = buildDshPrompt("u1", "看图", [], fakeImg, {
      ok: true,
      text: "图1 里的文字：「拿来吧你」",
      details: [],
    });
    check("有 OCR 文字时不命令模型说看不到", !/直接说你看不到图/.test(withText));
    check("有 OCR 文字时把文字塞进 prompt", withText.includes("拿来吧你"), "");
    check("有 OCR 文字时禁止咬定看不到", /严禁/.test(withText) && /一口咬定/.test(withText));
    check("有 OCR 文字时仍说明画面看不到", /画面/.test(withText) && /看不到/.test(withText));

    const noText = buildDshPrompt("u1", "看图", [], fakeImg, { ok: true, text: "", details: [] });
    check("无文字时说明 OCR 没读到字", /没有识别到任何文字/.test(noText));
    check("无文字时不编造画面", /编造画面/.test(noText));

    const ocrFail = buildDshPrompt("u1", "看图", [], fakeImg, null);
    check("OCR 未跑成时回退诚实模式", /识图这条链路这次没跑成/.test(ocrFail));

    const noImg = buildDshPrompt("u1", "在吗", [], [], null);
    check("无图时不出现 OCR 话术", !/OCR/.test(noImg), "");
    check("prompt 含记忆防编条款（2026-10-22）", /不许编造细节装作记得/.test(noImg));
    check("prompt 含人味段：有据摆依据、无据说忘了", /不许编，但真说过的要敢认/.test(noImg));
    check("prompt 含人味段：他说的不算你的错", /不等于你真的记错/.test(noImg));
    check("prompt 不含「被质疑一律认错」的旧写法", !/你会记错，也会认怂/.test(noImg));
    if (latestDiaryBefore()) {
      check("prompt 含日记偏差提醒（以对话记录为准，非一律认错）", /判断真假时以对话记录为准/.test(noImg));
    } else {
      skipCheck("prompt 含日记偏差提醒", "没有日记素材");
    }
  }

  // ── 视觉直传 prompt（2026-10-19 09:52 A 路打通）──
  // 图片真的送到模型面前时，话术必须翻面：不许再说「看不到」，
  // 而且 OCR 只是文字精读补充，不是唯一依据。
  {
    const fakeImg = ["C:\\tmp\\a.jpg"];
    const vision = buildDshPrompt("u1", "看图", [], fakeImg, null, true);
    check("视觉直传时明说真的看得到", /真的看得到/.test(vision));
    check("视觉直传时禁止说看不到", /严禁/.test(vision) && /我看不到图/.test(vision));
    check("视觉直传时不再出现「画面你看不到」", !/画面内容你看不到/.test(vision));

    const visionOcr = buildDshPrompt(
      "u1",
      "看图",
      [],
      fakeImg,
      { ok: true, text: "拿来吧你", details: [] },
      true
    );
    check("视觉 + OCR 时 OCR 作文字精读补充", /文字精读参考/.test(visionOcr));
    check("视觉 + OCR 时文字以 OCR 为准", /以这份 OCR 为准/.test(visionOcr));
    check("视觉 + OCR 时画面靠模型自己", /画面理解靠你自己的眼睛/.test(visionOcr));

    // 反向：视觉没传成时必须退回旧话术，不能也宣称看得到
    const noVision = buildDshPrompt("u1", "看图", [], fakeImg, { ok: true, text: "x", details: [] }, false);
    check("视觉未传成时不宣称看得到", !/真的看得到/.test(noVision));
    check("视觉未传成时仍说明画面看不到", /画面内容你看不到/.test(noVision));

    // 动图帧：同一张图的多帧要触发「这是动图」话术
    const frames = [
      "C:\\tmp\\ani\\x-f01.png",
      "C:\\tmp\\ani\\x-f02.png",
      "C:\\tmp\\ani\\x-f03.png",
    ];
    const anim = buildDshPrompt("u1", "看图", [], frames, null, true);
    check("动图多帧触发动图话术", /这是一张动图/.test(anim));
    check("动图话术说明按时间顺序", /按?时间顺序拆成/.test(anim));
    check("动图话术提示过渡细节看不全", /过渡/.test(anim));
    const notAnim = buildDshPrompt("u1", "看图", [], fakeImg, null, true);
    check("单张静态图不触发动图话术", !/这是一张动图/.test(notAnim));

    // ── 表情包：只反应、不报画面（2026-10-21 23:5x 老大要求）──
    const sticker = buildDshPrompt("u1", "[表情]", [], fakeImg, null, true, "chat", { stickerOnly: true });
    check("表情包：明确要求不描述画面", /不要在回复里描述画面/.test(sticker));
    check("表情包：不出现「把图里有用信息说出来」", !/图里真正有用的东西/.test(sticker));
    check("表情包：标题区分为表情包", /发的是表情包/.test(sticker));
    check("表情包：被问才说画面", /只有老大明确问/.test(sticker));
    check("表情包：带身份锚点，粉发/别的角色不认成自己", /你是蓝发/.test(sticker) && /粉发/.test(sticker) && /别往自己身上扯/.test(sticker));
    check("表情包：蓝鲸视觉，不冒充黑白虎鲸", /蓝色鲸鱼尾/.test(sticker) && /黑白虎鲸/.test(sticker) && /都不是你/.test(sticker));
    // 2026-10-27：光有「别描述」会让模型在感知层跳过图上的字，下一条问字就只能说读不到。
    check("表情包：要求先读字再回复", /先看清，再决定说不说/.test(sticker));
    check("表情包：问「读得到吗」要念出字", /读得到吗/.test(sticker));

    const re = buildDshPrompt("u1", "读得到表情包里的文字吗", [], fakeImg, null, true, "chat", { reattached: true });
    check("补图：说明是刚才那张", /刚才发过的图/.test(re));
    check("补图：要求把字念出来", /图上有字就念出来/.test(re));
    check("补图判定：问字命中", asksAboutImage("读的到表情包里的文字吗"));
    check("补图判定：省主语的「读得到吗」也命中", asksAboutImage("读得到吗"));
    check("补图判定：闲聊不命中", !asksAboutImage("今天吃什么"));
    check("补图判定：问吃饭不命中", !asksAboutImage("你吃饭了吗"));
    check("补图决策：本轮带图 → 不补、只记账", (() => {
      const p = planReattach("看图", ["a.jpg"], false, null, 0, 600000);
      return p.reuse === false && p.store === true;
    })());
    check("补图决策：10 分钟内追问 → 补", planReattach("读得到吗", [], false, { images: ["a.jpg"], ts: 0 }, 600000, 600000).reuse);
    check("补图决策：超窗口 → 不补", !planReattach("读得到吗", [], false, { images: ["a.jpg"], ts: 0 }, 600001, 600000).reuse);
    check("补图决策：群聊 → 不补", !planReattach("读得到吗", [], true, { images: ["a.jpg"], ts: 0 }, 1, 600000).reuse);
    check("补图决策：没存过图 → 不补", !planReattach("读得到吗", [], false, null, 1, 600000).reuse);
    check("补图决策：ageMs 按存图时刻算", planReattach("读得到吗", [], false, { images: ["a.jpg"], ts: 0 }, 49000, 600000).ageMs === 49000);

    // ── 表情包入库（2026-10-28）──
    check("表情入库：正常小图放行", shouldLearnSticker({ sizeBytes: 120 * 1024, maxMB: 4 }).ok);
    check("表情入库：空文件拦掉", !shouldLearnSticker({ sizeBytes: 0, maxMB: 4 }).ok);
    check("表情入库：超大拦掉", !shouldLearnSticker({ sizeBytes: 5 * 1024 * 1024, maxMB: 4 }).ok);
    check("表情入库：刚好到上限不拦", shouldLearnSticker({ sizeBytes: 4 * 1024 * 1024, maxMB: 4 }).ok);
    check("表情淘汰：库没满不删", pickStickerEvictions([{ file: "a", mtimeMs: 1 }, { file: "b", mtimeMs: 2 }], 5).length === 0);
    check("表情淘汰：超额删最旧的", pickStickerEvictions([{ file: "a", mtimeMs: 30 }, { file: "b", mtimeMs: 10 }, { file: "c", mtimeMs: 20 }], 2).map((x) => x.file).join(",") === "b");
    check("表情淘汰：上限为 0 全删", pickStickerEvictions([{ file: "a", mtimeMs: 1 }], 0).length === 1);
    {
      // 真写盘 + md5 去重：用临时目录，不碰正式库
      const tmp = join(__dirname, ".run", "sticker-test");
      try {
        rmSync(tmp, { recursive: true, force: true });
        mkdirSync(tmp, { recursive: true });
        const lib = join(tmp, "lib");
        const srcA = join(tmp, "src-a.jpg");
        writeFileSync(srcA, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]));
        const known = new Set();
        const r1 = addStickerFile(srcA, lib, known, 4);
        check("表情入库：首次复制成功", r1.ok === true && existsSync(r1.path), r1.path || r1.reason);
        const r2 = addStickerFile(srcA, lib, known, 4);
        check("表情入库：同内容第二次判重", r2.ok === false && r2.dup === true);
        const srcB = join(tmp, "src-b.txt");
        writeFileSync(srcB, "not an image");
        const r3 = addStickerFile(srcB, lib, known, 4);
        check("表情入库：非图片拒收", r3.ok === false && /不是图片/.test(r3.reason));
        const r4 = addStickerFile(join(tmp, "nope.jpg"), lib, known, 4);
        check("表情入库：文件不存在拒收", r4.ok === false);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }

    // ── 表情判定（2026-10-28：按全量日志真实分布建的用例）──
    check("表情判定：sub_type=1 动画表情", isStickerSeg({ type: "image", data: { sub_type: 1, summary: "[动画表情]" } }));
    check("表情判定：sub_type=1 带文字", isStickerSeg({ type: "image", data: { sub_type: 1, summary: "愛してる" } }));
    check("表情判定：sub_type 缺失但带摘要", isStickerSeg({ type: "image", data: { summary: "[开心]" } }));
    check("表情判定：sub_type=7 带摘要", isStickerSeg({ type: "image", data: { sub_type: 7, summary: "[睡不着]" } }));
    check("表情判定：mface 一律算", isStickerSeg({ type: "mface", data: {} }));
    check("表情判定：sub_type=0 无摘要不收", !isStickerSeg({ type: "image", data: { sub_type: 0 } }));
    check("表情判定：sub_type=11 无摘要不收", !isStickerSeg({ type: "image", data: { sub_type: 11 } }));
    check("表情判定：sub_type 缺失无摘要不收", !isStickerSeg({ type: "image", data: {} }));
    check("表情判定：[图片] 不收", !isStickerSeg({ type: "image", data: { summary: "[图片]" } }));
    check("表情判定：超长摘要（文件名）不收", !isStickerSeg({ type: "image", data: { summary: "IMG_20261028_203344.jpg" } }));
    check("表情判定：face 段不算", !isStickerSeg({ type: "face", data: { id: "1" } }));

    // ── 连发合并（2026-10-27：静默窗口 5 秒）──
    check("合并等待：刚来一条 → 等满 5 秒", burstWaitMs(0, 5000, 20000) === 5000);
    check("合并等待：隔 3 秒又来一条 → 重新等满 5 秒", burstWaitMs(3000, 5000, 20000) === 5000);
    check("合并等待：快到上限 → 只补到 20 秒", burstWaitMs(17000, 5000, 20000) === 3000);
    check("合并等待：到上限 → 立刻放行", burstWaitMs(20000, 5000, 20000) === 0);
    check("合并等待：关掉合并 → 不等", burstWaitMs(0, 0, 20000) === 0);

    const merge2 = mergeBurstItems([
      { text: "第一句", images: [], stickerOnly: false },
      { text: "第二句", images: [], stickerOnly: false },
    ]);
    check("合并文本：几条用换行拼，不并成一句", merge2.text === "第一句\n第二句");
    const mergeImg = mergeBurstItems([
      { text: "我在工位", images: [], stickerOnly: false },
      { text: "[表情]", images: ["a.jpg"], stickerOnly: true },
    ]);
    check("合并图文：隔几秒补的图并进同一轮", mergeImg.images.length === 1 && mergeImg.text.includes("[表情]"));
    check("合并图文：混了文字就不按表情包走", mergeImg.stickerOnly === false);
    const mergeStickers = mergeBurstItems([
      { text: "[表情]", images: ["a.jpg"], stickerOnly: true },
      { text: "[表情]", images: ["b.jpg"], stickerOnly: true },
    ]);
    check("合并表情：全是表情包才按表情包走", mergeStickers.stickerOnly === true && mergeStickers.images.length === 2);

    const photo = buildDshPrompt("u1", "[图片]", [], fakeImg, null, true, "chat", {});
    check("普通图：仍要求说信息", /图里真正有用的东西/.test(photo));
    check("普通图：不套用表情包禁令", !/不要在回复里描述画面/.test(photo));
    check("普通图：非本人角色不冒充", /不要自称图里的人/.test(photo));
    check("普通图：同样带身份锚点", /你是蓝发/.test(photo) && /别往自己身上扯/.test(photo));

    const stickerAnim = buildDshPrompt("u1", "[表情]", [], frames, null, true, "chat", { stickerOnly: true });
    check("动图表情：不按帧描述", /别按帧描述/.test(stickerAnim));
    check("动图表情：不出现「开头→中间→最后」", !/开头是什么 → 中间怎么变/.test(stickerAnim));
  }

  // ── 说话方式（2026-10-21 23:5x 去人机味）──
  {
    const chat = buildDshPrompt("u1", "在吗", []);
    check("说话方式：有独立规则段", /【说话方式/.test(chat));
    check("说话方式：一条只说一件事", /一条只说一件事/.test(chat));
    check("说话方式：禁书面连接词", /倒是你/.test(chat) && /总而言之/.test(chat));
    check("说话方式：旧的那句空泛要求已移除", !/要求：像正常人打字/.test(chat));
  }

  // ── 主动行为（主动开口 / 发说说 / 静默时段）──
  {
    const pro = buildDshPrompt("u1", "", [{ role: "user", content: "在吗" }], [], null, false, "proactive", {
      material: [{ role: "user", content: "在吗" }],
    });
    check("主动开口 prompt 声明不是回复", /不是回复消息/.test(pro));
    check("主动开口 prompt 禁止问在吗", /不要\*\*说「在吗/.test(pro));
    check("主动开口 prompt 带上历史", pro.includes("在吗"));
    check("主动开口 prompt 不出现「老大刚刚说」", !/老大刚刚说/.test(pro));
    check("主动开口 prompt 禁止编造线下生活", /没有学校、食堂/.test(pro));
    check("主动开口 prompt 允许沉默", /\[\[skip\]\]/.test(pro));

    const qz = buildDshPrompt("u1", "", [], [], null, false, "qzone");
    check("说说 prompt 要求直接输出正文", /直接输出说说正文/.test(qz));
    check("说说 prompt 限制字数", /20~80 字/.test(qz));
    check("说说 prompt 禁止鸡汤", /别写鸡汤/.test(qz));
    check("说说 prompt 禁止编造线下生活", /一律不许编/.test(qz));
    check("说说 prompt 允许不发", /\[\[skip\]\]/.test(qz));

    const chat = buildDshPrompt("u1", "在吗", [], [], null, false, "chat");
    check("chat 模式仍走聊天骨架", /老大刚刚说：在吗/.test(chat));

    // 日记：写给自己看，不能是「汇报」口吻
    const dy = buildDshPrompt("u1", "", [{ role: "user", content: "今天好累" }], [], null, false, "diary");
    check("日记 prompt 声明写日记", /写今天的小日记/.test(dy));
    // 素材优先取当天落盘流水（chatlog），没有才退回传进来的 hist——
    // 两种分支都算「带素材」，所以断言写成二选一
    check("日记 prompt 带素材段", /=== 今天发生的|=== 今天和老大聊过的/.test(dy));
    check("日记 prompt 不出现「老大刚刚说」", !/老大刚刚说/.test(dy));
    check("日记 prompt 禁止 AI 腔", /不要出现「AI」/.test(dy));

    // 静默时段：跨零点与普通区间都要对
    check("dayKey 形状 yyyy-mm-dd", /^\d{4}-\d{2}-\d{2}$/.test(dayKey(new Date(2026, 9, 19))));
    check("dayKey 补零", dayKey(new Date(2026, 0, 5)) === "2026-01-05", dayKey(new Date(2026, 0, 5)));

    // ── 表情包：解析与匹配 ──
    const s1 = extractStickerRequest("哈哈你在说什么啊\n[[sticker: 委屈 ]]\n");
    check("表情标记被解析出来", s1.query === "委屈", String(s1.query));
    check("标记从正文剥掉", !/sticker/i.test(s1.cleaned), s1.cleaned);
    check("正文其它内容保留", s1.cleaned.includes("哈哈你在说什么啊"));

    const s2 = extractStickerRequest("[[STICKER：糊脸]]");
    check("全角冒号 + 大写也能认", s2.query === "糊脸", String(s2.query));
    check("只有标记时正文为空", s2.cleaned === "", JSON.stringify(s2.cleaned));

    const s3 = extractStickerRequest("没有标记的普通回复");
    check("无标记时 query 为空", s3.query === null);
    check("无标记时正文原样", s3.cleaned === "没有标记的普通回复");

    const s4 = extractStickerRequest("两个 [[sticker:拿来]][[sticker:大哭]]");
    check("多个标记取第一个", s4.query === "拿来" && s4.queries.length === 2, JSON.stringify(s4.queries));

    // 匹配：关键词精确 → 包含 → 找不到返回 null（不能乱发错情绪）
    const lib = loadStickers();
    if (lib.length > 0) {
      check("关键词精确匹配", matchSticker(lib[0].keywords[0])?.name === lib[0].name);
      check("无关词匹配不到", matchSticker("zzz绝对不存在的词zzz") === null);
      check("关键词清单非空", typeof stickerKeywordList() === "string" && stickerKeywordList().length > 0);
    } else {
      check("无库存时 matchSticker 返回 null", matchSticker("委屈") === null);
    }
  }

  // ── 模型参数解析 ──
  const argCases = [
    ["workbuddy:hy3", "workbuddy", "hy3"],
    ["workbuddy/hy3", "workbuddy", "hy3"],
    ["workbuddy：hy3", "workbuddy", "hy3"],
    ["provider:workbuddy/hy3", "workbuddy", "hy3"],
    ["provider:step-5-preview", null, "step-5-preview"],
    ["hy3", null, "hy3"],
    ["workbuddy-ai/deepseek-v4.1-flash", "workbuddy-ai", "deepseek-v4.1-flash"],
  ];
  for (const [input, provider, model] of argCases) {
    const r = parseModelArg(input);
    check(
      `parseModelArg(${JSON.stringify(input)})`,
      r !== null && r.provider === provider && r.model === model,
      JSON.stringify(r)
    );
  }

  // ── 档位归一化 ──
  for (const v of ["low", "HIGH", " max ", "xhigh"]) {
    check(`normalizeEffort(${JSON.stringify(v)})`, normalizeEffort(v) !== null, String(normalizeEffort(v)));
  }
  for (const v of ["乱写", "", "超快", null, 123]) {
    check(`normalizeEffort 拒绝 ${JSON.stringify(v)}`, normalizeEffort(v) === null);
  }

  // ── 意图分类（2026-10-18 连踩三次的地方）──
  const intentCases = [
    // [输入, 期望kind, 期望值]
    ["", "empty", null],
    ["auto", "reset", null],
    ["默认", "reset", null],
    ["default", "reset", null],
    ["effort low", "effort", "low"],
    ["档位 high", "effort", "high"],
    ["推理 max", "effort", "max"],
    ["effort:low", "effort", "low"],
    // 老大实际发过的：只给档位名，不带 effort 前缀
    ["high", "effort", "high"],
    ["low", "effort", "low"],
    ["max", "effort", "max"],
    // 老大实际发过的：带 provider: 前缀 + 斜杠
    ["provider:workbuddy/step-5-preview", "model", null],
    // 正常换模型
    ["workbuddy:hy3", "model", null],
    ["workbuddy：step-5-preview", "model", null],
    ["hy3", "model", null],
    // 非法档位（带前缀但值不对）→ 仍归 effort，effort 为 null 让上层报错
    ["effort 乱写", "effort", null],
  ];
  for (const [input, kind, effort] of intentCases) {
    const r = classifyModelArg(input);
    const ok = r.kind === kind && (kind !== "effort" || r.effort === effort);
    check(
      `classifyModelArg(${JSON.stringify(input)}) → ${kind}`,
      ok,
      JSON.stringify(r)
    );
  }

  // 换模型时 spec 要能解析出来
  const specChecks = [
    ["provider:workbuddy/step-5-preview", "workbuddy", "step-5-preview"],
    ["workbuddy:hy3", "workbuddy", "hy3"],
    ["workbuddy：step-5-preview", "workbuddy", "step-5-preview"],
  ];
  for (const [input, provider, model] of specChecks) {
    const r = classifyModelArg(input);
    check(
      `classifyModelArg(${JSON.stringify(input)}).spec`,
      r.spec?.provider === provider && r.spec?.model === model,
      JSON.stringify(r.spec)
    );
  }

  // ── 消息去重（2026-10-18 21:40 实测 NapCat 双投递后补）──
  check("同一 message_id 第二次判重", isDuplicate(900001) === false && isDuplicate(900001) === true);
  check("不同 message_id 不误判", isDuplicate(900002) === false);
  check("过期 message_id 放行", isDuplicate(900001, Date.now() + DEDUP_TTL_MS + 1000) === false);

  // ── 文本级二级去重（2026-10-18 21:53 实测客户端重发连中 4 次后补）──
  check("同人同文本 3 秒内判重", isTextDuplicate(1, "在吗", false) === false && isTextDuplicate(1, "在吗", false) === true);
  check("不同文本不误判", isTextDuplicate(1, "在呀", false) === false);
  check("带图消息不做文本去重", isTextDuplicate(1, "[图片]", true) === false && isTextDuplicate(1, "[图片]", true) === false);
  check("超窗文本放行", isTextDuplicate(1, "在吗", false, Date.now() + TEXT_DEDUP_WINDOW_MS + 1000) === false);

  // ── 错误分类 ──
  const quotaMsg =
    'RATE_LIMIT: 429: {"message":"workbuddy upstream soft_rate (http 429): 您的使用量已超出频率限制"}';
  check("429 限流被识别为额度类", looksLikeQuota(new Error(quotaMsg)));
  check("429 会触发降级", shouldTryNext(new Error(quotaMsg)));
  check(
    "超时不触发降级",
    !shouldTryNext(new Error("dsh 超时 90000ms")),
    "换模型只会再等 90 秒"
  );
  check("积分不足触发降级", shouldTryNext(new Error("HTTP 402: 积分不足")));

  // ── 以下 2026-10-21 审计新增：调度 / 表情包 / 配置归一化的边角 ──

  // inQuietHours：默认 0~8 静默；跨零点（23~7）也要对
  {
    const s0 = CFG.proactiveQuietStart;
    const e0 = CFG.proactiveQuietEnd;
    try {
      CFG.proactiveQuietStart = 0;
      CFG.proactiveQuietEnd = 8;
      check("静默 0~8：凌晨 3 点在静默", inQuietHours(3) === true);
      check("静默 0~8：中午 12 点不在静默", inQuietHours(12) === false);
      check("静默 0~8：边界 0 点在静默", inQuietHours(0) === true);
      check("静默 0~8：边界 8 点出静默", inQuietHours(8) === false);
      CFG.proactiveQuietStart = 23;
      CFG.proactiveQuietEnd = 7;
      check("跨零点 23~7：23 点在静默", inQuietHours(23) === true);
      check("跨零点 23~7：凌晨 2 点在静默", inQuietHours(2) === true);
      check("跨零点 23~7：中午不在静默", inQuietHours(12) === false);
      CFG.proactiveQuietStart = 5;
      CFG.proactiveQuietEnd = 5;
      check("起止相同视为不静默", inQuietHours(5) === false);
    } finally {
      CFG.proactiveQuietStart = s0;
      CFG.proactiveQuietEnd = e0;
    }
  }

  // randBetween 边界：b<=a 时返回 a；正常区间不出界
  check("randBetween b<=a 返回 a", randBetween(5, 5) === 5 && randBetween(6, 5) === 6);
  {
    let inRange = true;
    for (let i = 0; i < 200; i++) {
      const v = randBetween(20, 23);
      if (!(v >= 20 && v < 23)) inRange = false;
    }
    check("randBetween 200 次抽样都在 [20,23)", inRange);
  }

  check("dayKey 格式 YYYY-MM-DD 补零", dayKey(new Date(2026, 0, 5)) === "2026-01-05");

  // extractStickerRequest：标记剥净、只取第一个关键词、全角冒号也认
  {
    const r1 = extractStickerRequest("你看这个 [[sticker:开心]] 哈哈");
    check("表情包标记被剥掉", !r1.cleaned.includes("[[") && r1.query === "开心", JSON.stringify(r1));
    const r2 = extractStickerRequest("[[sticker:开心]] 和 [[sticker:难过]]");
    check("多个标记只取第一个", r2.query === "开心" && r2.queries.length === 2, JSON.stringify(r2.queries));
    const r3 = extractStickerRequest("[[sticker：难过]]");
    check("全角冒号也识别", r3.query === "难过", JSON.stringify(r3));
    const r4 = extractStickerRequest("[[sticker:开心]]");
    check("只剩标记时 cleaned 为空（由调用方决定是否跳过）", r4.cleaned === "", JSON.stringify(r4.cleaned));
    const r5 = extractStickerRequest("没有标记");
    check("无标记原样保留", r5.query === null && r5.cleaned === "没有标记");
    const r6 = extractStickerRequest("[[sticker:]]");
    check("空关键词不识别", r6.query === null, JSON.stringify(r6));
  }

  check("matchSticker 空 query 返回 null", matchSticker("") === null && matchSticker(null) === null);

  // guessExt：url 五花八门，扩展名拿不到就落 .jpg（之后靠 magic number 纠）
  check("guessExt 带 query 的 url", guessExt("https://x.com/a.PNG?sign=123") === ".png");
  check("guessExt 无扩展名落 .jpg", guessExt("https://x.com/abc") === ".jpg");
  check("guessExt 伪扩展名不落坑", guessExt("https://x.com/a.exe") === ".jpg");

  // fixImageExt / sniffImageExt：扩展名撒谎时按 magic number 改名
  {
    const tmp = join(RUN_DIR, ".selftest-img.jpg");
    try {
      writeFileSync(tmp, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
      check("sniffImageExt 认出 PNG 头", sniffImageExt(tmp) === ".png", String(sniffImageExt(tmp)));
      const fixed = fixImageExt(tmp);
      check("fixImageExt 把 .jpg 改成 .png", fixed.endsWith(".png") && existsSync(fixed), fixed);
      check("改名后原路径不存在", !existsSync(tmp));
      const again = fixImageExt(fixed);
      check("扩展名本来就对时不动", again === fixed && existsSync(fixed));
      try {
        unlinkSync(fixed);
      } catch {}
    } finally {
      try {
        unlinkSync(tmp);
      } catch {}
    }
  }

  // normalizeSel / normalizeEffort 归一化边界
  check("normalizeSel 缺冒号拒收", normalizeSel("hy3") === null);
  check("normalizeSel 空 provider 拒收", normalizeSel(":hy3") === null);
  check("normalizeSel 全角冒号不在此处处理", normalizeSel("workbuddy：hy3") === null);
  check("normalizeSel 对象带空格会 trim", normalizeSel({ provider: " workbuddy ", model: " hy3 " })?.model === "hy3");
  check("normalizeEffort 大写归一", normalizeEffort("LOW") === "low");
  check("normalizeEffort 乱写当没设", normalizeEffort("乱写") === null && normalizeEffort(undefined) === null);

  // parseCommand 边角（固化现状，改匹配规则时会撞醒）
  check("「#语音关闭」无空格也识别（2026-10-22 F-02 修复）", parseCommand("#语音关闭")?.word === "语音");
  check("「#语音  关」多空格照样认", parseCommand("#语音  关")?.arg === "关");
  check("「##模型」不是指令", parseCommand("##模型") === null);
  check("「#MODEL」大小写不敏感", parseCommand("#MODEL")?.word === "model");
  check("「#模型abc」当中文+字母粘连会当参数", parseCommand("#模型abc")?.arg === "abc");

  // 无 message_id 的消息不能被吞（ NapCat 某些事件没有 id ）
  check("undefined message_id 不误判重", isDuplicate(undefined) === false && isDuplicate(undefined) === false);
  check("空串 message_id 不误判重", isDuplicate("") === false);

  // 二级去重：不同人同文本互不干扰；空文本不参与
  check("不同人同文本不判重", isTextDuplicate(777001, "哈哈", false) === false && isTextDuplicate(777002, "哈哈", false) === false);
  check("空文本不参与二级去重", isTextDuplicate(777001, "", false) === false);

  // CQ 码混合：at 码删干净，文本留下
  {
    const t = extractTextOnly("[CQ:at,qq=123] 在吗", "");
    check("CQ at 码被删且文本留下", !t.includes("[CQ:") && t.includes("在吗"), JSON.stringify(t));
  }

  // ── F-02（2026-10-22）：无空格粘连的语音开关 ──
  check("「#语音关」无空格识别", parseCommand("#语音关")?.arg === "关");
  check("「#语音关闭」无空格识别", parseCommand("#语音关闭")?.arg === "关闭");
  check("「#语音开」无空格识别", parseCommand("#语音开")?.arg === "开");
  check("「#语音打开」无空格识别", parseCommand("#语音打开")?.arg === "打开");
  check("「#语音关掉」无空格识别", parseCommand("#语音关掉")?.arg === "关掉");
  check("「#语音识别」不误判（词表外粘连仍漏）", parseCommand("#语音识别") === null);

  // ── F-01（2026-10-22）：配额回滚 ──
  {
    const tmp = join(RUN_DIR, ".selftest-schedule.json");
    const day = "2099-01-01";
    try {
      // qzone：失败后 count 减回 + planAt 恢复 30 分钟后 + retries+1
      saveSchedule({ qzone: { day, count: 1, planAt: null } }, tmp);
      rollbackQuota("qzone", day, tmp);
      let q = loadSchedule(tmp).qzone;
      check("回滚：qzone count 减回", q.count === 0, JSON.stringify(q));
      check("回滚：qzone planAt 恢复（约 30 分钟后）", q.planAt > Date.now() + 29 * 60e3 && q.planAt < Date.now() + 31 * 60e3, String(q.planAt && q.planAt - Date.now()));
      check("回滚：retries 记 1", q.retries === 1);

      // 第二次失败仍退；第三次（retries 已是 2）不再退
      saveSchedule({ qzone: { day, count: 1, planAt: null, retries: 2 } }, tmp);
      rollbackQuota("qzone", day, tmp);
      q = loadSchedule(tmp).qzone;
      check("回滚：重试 2 次后不再退配额", q.count === 1 && q.planAt === null, JSON.stringify(q));

      // diary 同规则
      saveSchedule({ diary: { day, count: 1, planAt: null } }, tmp);
      rollbackQuota("diary", day, tmp);
      const d = loadSchedule(tmp).diary;
      check("回滚：diary count 减回且 planAt 恢复", d.count === 0 && d.planAt > Date.now(), JSON.stringify(d));

      // proactive：count 减回，lastAt 更新为现在，不动 planAt 字段
      saveSchedule({ proactive: { day, count: 2, lastAt: 123, nextGapH: 4 } }, tmp);
      rollbackQuota("proactive", day, tmp);
      const p = loadSchedule(tmp).proactive;
      check("回滚：proactive count 减回", p.count === 1, JSON.stringify(p));
      check("回滚：proactive lastAt 记为现在", p.lastAt > Date.now() - 60e3, String(p.lastAt));

      // 换天的状态不动（防误回滚昨天）
      saveSchedule({ qzone: { day: "2099-01-02", count: 1, planAt: null } }, tmp);
      rollbackQuota("qzone", day, tmp);
      check("回滚：日期不匹配不动", loadSchedule(tmp).qzone.count === 1);

      // 文件坏了不炸
      writeFileSync(tmp, "不是JSON", "utf8");
      rollbackQuota("qzone", day, tmp);
      check("回滚：坏文件不抛异常", true);
    } finally {
      try {
        unlinkSync(tmp);
      } catch {}
    }
  }

  // ── 唱歌：请求体必须是双层 JSON（2026-10-24）──
  {
    const body = buildVolcBody({ speaker: "zh_female_sing_qingxin", song: "zhaopengyou", text: "一闪一闪亮晶晶" });
    let outer = null;
    try { outer = JSON.parse(body); } catch {}
    check("唱歌：外层是合法 JSON", outer !== null);
    check("唱歌：payload 是字符串不是对象", typeof outer?.payload === "string");
    let inner = null;
    try { inner = JSON.parse(outer?.payload ?? ""); } catch {}
    check("唱歌：payload 里 speaker 正确", inner?.speaker === "zh_female_sing_qingxin");
    check("唱歌：payload 里 song_name 正确", inner?.song_name === "zhaopengyou");
    check("唱歌：payload 里 text 原样保留", inner?.text === "一闪一闪亮晶晶");
    check("唱歌：默认输出 mp3", inner?.audio_config?.format === "mp3");

    const url = volcUrl({ appkey: "ak-test", token: "tk-test", version: "v4" });
    check("唱歌：URL 指向 sami invoke", url.startsWith("https://sami.bytedance.com/api/v1/invoke?"));
    check("唱歌：URL 带 namespace=MemeSong", url.includes("namespace=MemeSong"));
    check("唱歌：URL 带 version/appkey/token", /version=v4/.test(url) && /appkey=ak-test/.test(url) && /token=tk-test/.test(url));

    check("唱歌：歌单 7 首", SONG_IDS.length === 7);
    check("唱歌：歌词上限 40 字", MAX_LYRICS === 40);

    // 基频估计：正弦波应测准，静音应返回 null（决定本地移调准不准）
    const sine = (hz) => {
      const a = new Float32Array(24000);
      for (let i = 0; i < a.length; i++) a[i] = 0.3 * Math.sin((2 * Math.PI * hz * i) / 24000);
      return a;
    };
    check("唱歌：估计 309Hz 正弦 ±2Hz", Math.abs((estimateF0(sine(309)) ?? 0) - 309) <= 2);
    check("唱歌：估计 440Hz 正弦 ±2Hz", Math.abs((estimateF0(sine(440)) ?? 0) - 440) <= 2);
    check("唱歌：估计 165Hz 正弦 ±2Hz", Math.abs((estimateF0(sine(165)) ?? 0) - 165) <= 2);
    check("唱歌：静音返回 null", estimateF0(new Float32Array(24000)) === null);
  }

  // ── 群聊上下文 / 触发 / prompt（2026-10-26，借鉴 AstrBot）──
  {
    const saved = {
      enabled: CFG.groupEnabled,
      allow: CFG.groupAllow,
      wake: CFG.groupWake,
      max: CFG.groupContextMax,
      chars: CFG.groupContextMaxChars,
      age: CFG.groupContextMaxAgeMs,
    };
    CFG.groupEnabled = true;
    CFG.groupAllow = ["*"];
    CFG.groupWake = "小玉";
    CFG.groupContextMax = 120;
    CFG.groupContextMaxChars = 1800;
    CFG.groupContextMaxAgeMs = 12 * 3600_000;
    const gid = "selftest-group";
    try {
      groupCtx.delete(gid);

      const evtOff = {
        group_id: gid,
        user_id: 10001,
        self_id: "10002",
        sender: { card: "", nickname: "阿明" },
        message: [
          { type: "at", data: { qq: "10002" } },
          { type: "text", data: { text: " 中午吃啥" } },
          { type: "image", data: {} },
          { type: "reply", data: { id: "m0" } },
        ],
      };
      const rec = groupRecordOf(evtOff);
      check("群记录：@你", rec.text.includes("@你"), rec.text);
      check("群记录：图片占位", rec.text.includes("[图片]"), rec.text);
      check("群记录：引用占位", rec.text.includes("[引用]"), rec.text);
      check("群记录：昵称优先名片/昵称", rec.who === "阿明", rec.who);

      check("群触发：@ 命中", detectGroupTrigger(evtOff)?.atSelf === true);
      const evtPlain = { ...evtOff, message: [{ type: "text", data: { text: "今天好热" } }] };
      check("群触发：普通闲聊不命中", detectGroupTrigger(evtPlain) === null);
      check(
        "群触发：唤醒词命中",
        detectGroupTrigger({ ...evtPlain, message: [{ type: "text", data: { text: "小玉 在吗" } }] })?.wake === true
      );
      check(
        "群触发：唤醒词连写不命中",
        detectGroupTrigger({ ...evtPlain, message: [{ type: "text", data: { text: "小玉在吗" } }] }) === null
      );
      lastBotMsgId.set(gid, "m-bot-1");
      check(
        "群触发：回复她命中",
        detectGroupTrigger({
          ...evtPlain,
          message: [
            { type: "reply", data: { id: "m-bot-1" } },
            { type: "text", data: { text: "然后呢" } },
          ],
        })?.replyToBot === true
      );
      check(
        "群触发：回复别人不命中",
        detectGroupTrigger({
          ...evtPlain,
          message: [
            { type: "reply", data: { id: "m-other" } },
            { type: "text", data: { text: "然后呢" } },
          ],
        }) === null
      );

      // 缓存：过期裁剪 / 游标 / 生成期间新消息
      groupCtx.delete(gid);
      const ctx = groupCtxOf(gid);
      const nowTs = Date.now();
      ctx.records.push({ ts: nowTs - CFG.groupContextMaxAgeMs - 60_000, uid: 1, who: "旧人", text: "过期一句", self: false });
      ctx.records.push({ ts: nowTs - 1000, uid: 1, who: "阿明", text: "有人吗", self: false });
      ctx.records.push({ ts: nowTs - 500, uid: 2, who: "小红", text: "在的", self: false });
      ctx.injected = 1;
      trimGroupCtx(ctx);
      check("群缓存：过期消息裁掉", ctx.records.length === 2, String(ctx.records.length));
      check("群缓存：游标随裁剪前移", ctx.injected === 0, String(ctx.injected));

      const t1 = takeGroupContext(gid);
      check("群上下文：两条都取到", t1.lines.length === 2, t1.lines.join(" | "));
      check("群上下文：格式 [昵称/时间]: 内容", /^\[阿明\/\d{2}:\d{2}\]: 有人吗$/.test(t1.lines[0]), t1.lines[0]);
      markGroupInjected(gid, t1.injectedCount);
      check("群上下文：注入后不再重复", takeGroupContext(gid).lines.length === 0);

      ctx.records.push({ ts: Date.now(), uid: 3, who: "阿强", text: "生成期间来的", self: false });
      const t2 = takeGroupContext(gid);
      check(
        "群上下文：生成期间新消息留给下一轮",
        t2.lines.length === 1 && t2.lines[0].includes("生成期间来的"),
        t2.lines.join(" | ")
      );
      markGroupInjected(gid, t2.injectedCount);
      appendGroupBotReply(gid, "我在呀");
      const t3 = takeGroupContext(gid);
      check(
        "群上下文：她的上一条回复也进上下文",
        t3.lines.length === 1 && t3.lines[0].includes("你/") && t3.lines[0].includes("我在呀"),
        t3.lines.join(" | ")
      );

      // 触发那条：本轮不重复注入，但要留给下一轮
      groupCtx.delete(gid);
      const tc = groupCtxOf(gid);
      tc.records.push({ ts: Date.now() - 5000, uid: 1, who: "阿明", text: "上一句", self: false });
      tc.injected = 1;
      const t4 = takeGroupContext(gid);
      check("群触发入库：本轮不重复注入", t4.lines.length === 0, t4.lines.join(" | "));
      const inj4 = recordGroupTrigger(gid, { user_id: 2, sender: { nickname: "小红" } }, "@你 在吗");
      markGroupInjected(gid, inj4);
      appendGroupBotReply(gid, "在的");
      const t5 = takeGroupContext(gid);
      check(
        "群触发入库：下一轮能看到触发原话",
        t5.lines.length === 2 && t5.lines[0].includes("小红") && t5.lines[0].includes("@你 在吗"),
        t5.lines.join(" | ")
      );

      // prompt：群模式必须带上下文，且不得注入任何私域信息
      const gp = buildDshPrompt("group:selftest", "小玉 中午吃啥", [], [], null, false, "group", {
        groupCtx: ["[阿明/12:00]: 今天好热"],
        groupSpeaker: "阿明",
        groupAt: true,
      });
      check("群 prompt：带上下文", gp.includes("[阿明/12:00]: 今天好热"));
      check("群 prompt：带说话人", gp.includes("这一轮你只需要回 阿明"));
      check("群 prompt：不含长期记忆", !gp.includes("=== 你的长期记忆（memory.md） ==="));
      check("群 prompt：不含日记", !gp.includes("=== 日记结束 ===") && !gp.includes("写的日记（写给自己看的"));
      check("群 prompt：不含空间状态", !gp.includes("【你的空间说说状态"));
      check("群 prompt：约束只打字", gp.includes("【群里只打字】"));
    } finally {
      groupCtx.delete(gid);
      lastBotMsgId.delete(gid);
      CFG.groupEnabled = saved.enabled;
      CFG.groupAllow = saved.allow;
      CFG.groupWake = saved.wake;
      CFG.groupContextMax = saved.max;
      CFG.groupContextMaxChars = saved.chars;
      CFG.groupContextMaxAgeMs = saved.age;
    }
  }

  // ── 生图：标记解析（2026-10-26）──
  {
    const cases = [
      ["好的[[画:一只睡觉的猫]]", "好的", "一只睡觉的猫"],
      ["[[画：蓝色虎鲸少女]]", "", "蓝色虎鲸少女"],
      ["[[draw: a red fox]]晚安", "晚安", "a red fox"],
      ["没有标记的回复", "没有标记的回复", ""],
      ["[[画:第一张]][[画:第二张]]", "", "第一张"],
    ];
    for (const [input, cleaned, prompt] of cases) {
      const r = extractDrawRequest(input);
      check(
        `extractDrawRequest(${JSON.stringify(input)})`,
        r.cleaned === cleaned && r.prompt === prompt,
        `cleaned=${JSON.stringify(r.cleaned)} prompt=${JSON.stringify(r.prompt)}`
      );
    }
  }

  // ── 生图：画自己走固定标准照（2026-10-26）──
  {
    const yes = [
      "生成你的形象给我看看",
      "画你自己",
      "给我来张自拍",
      "你长什么样",
      "你的样子给我看看",
      "自画像",
      "画个自己",
      "你自己",
    ];
    const no = ["画一只蓝色虎鲸少女", "你画的是什么", "今天吃什么", "帮我画只猫", "画个自己的猫"];
    for (const t of yes) check(`画自己识别：${t}`, isSelfPortraitRequest(t) === true);
    for (const t of no) check(`非画自己：${t}`, isSelfPortraitRequest(t) === false);

    const p1 = planDraw("生成你的形象给我看看", "anime style, orca girl");
    check("画自己：用固定模板", p1.canonical === true && p1.prompt === SELF_PORTRAIT_PROMPT);
    check("画自己：固定种子", p1.seed === SELF_PORTRAIT_SEED);
    const p2 = planDraw("画一只蓝色虎鲸少女", "a blue orca girl");
    check("画别的：保留模型描述", p2.canonical === false && p2.prompt === "a blue orca girl");

    const followYes = ["换张图", "再来一张", "换个姿势", "再画一张", "换一张"];
    const followNo = ["换个画风", "画只猫", "再画一张别的", "换件衣服"];
    for (const t of followYes) check(`续画识别：${t}`, isFollowUpImageRequest(t) === true);
    for (const t of followNo) check(`非续画：${t}`, isFollowUpImageRequest(t) === false);
    check(
      "续画：上一张是她 → 固定形象",
      planDraw("再画一张", "a girl lying on a desk", { afterSelfPortrait: true }).canonical === true
    );
    check(
      "续画：上一张不是她 → 按描述画",
      planDraw("再画一张", "a cat", { afterSelfPortrait: false }).canonical === false
    );
    check(
      "续画：明确要别的 → 不沿用",
      planDraw("再画一张别的", "a fox", { afterSelfPortrait: true }).canonical === false
    );

    check(
      "固定模板含鲸鱼特征",
      /whale tail/.test(SELF_PORTRAIT_PROMPT) &&
        /fin-like ears/.test(SELF_PORTRAIT_PROMPT) &&
        /maid dress/.test(SELF_PORTRAIT_PROMPT)
    );

    const rot = ["a.jpg", "b.jpg", "c.jpg"];
    check("轮换：首张=首图", nextPortraitPath(rot, null) === "a.jpg");
    check("轮换：顺序前进", nextPortraitPath(rot, "a.jpg") === "b.jpg");
    check("轮换：末尾回环", nextPortraitPath(rot, "c.jpg") === "a.jpg");
    check("轮换：上次不在列表 → 首图", nextPortraitPath(rot, "gone.jpg") === "a.jpg");
    check("轮换：空列表", nextPortraitPath([], null) === null);
    const lib = listSelfPortraits();
    if (lib.length === 0) {
      skipCheck("素材库断言", "assets/self 不在公开副本里");
    } else {
      check("素材库：首图是标准照", lib[0] === SELF_PORTRAIT_IMAGE, lib[0]);
      check("素材库：至少 6 张", lib.length >= 6, `len=${lib.length}`);
      check(
        "素材库：无重复",
        new Set(lib).size === lib.length,
        `len=${lib.length} uniq=${new Set(lib).size}`
      );
    }

    const savedProv = CFG.imageGenProvider;
    const savedModel = CFG.imageGenModel;
    try {
      CFG.imageGenProvider = "pollinations";
      CFG.imageGenModel = "flux";
      const reqSelf = buildImageGenRequest(SELF_PORTRAIT_PROMPT, { seed: SELF_PORTRAIT_SEED });
      check("固定种子进 URL", reqSelf.url.includes(`seed=${SELF_PORTRAIT_SEED}`), reqSelf.url);
    } finally {
      CFG.imageGenProvider = savedProv;
      CFG.imageGenModel = savedModel;
    }
  }

  // ── 生图：请求构造 + 文件头校验（2026-10-26）──
  {
    const savedGen = {
      provider: CFG.imageGenProvider,
      model: CFG.imageGenModel,
      base: CFG.imageGenBaseUrl,
      key: CFG.imageGenKey,
      size: CFG.imageGenSize,
    };
    try {
      CFG.imageGenProvider = "pollinations";
      CFG.imageGenModel = "flux";
      CFG.imageGenBaseUrl = "";
      CFG.imageGenSize = "768x768";
      const req = buildImageGenRequest("a cat, anime", { seed: 42 });
      check("生图请求：pollinations 用 GET", req.kind === "get");
      check("生图请求：空格与逗号编码", req.url.includes("a%20cat%2C%20anime"), req.url);
      check(
        "生图请求：尺寸与 seed",
        req.url.includes("width=768") && req.url.includes("height=768") && req.url.includes("seed=42")
      );
      check("生图请求：nologo + flux", req.url.includes("nologo=true") && req.url.includes("model=flux"));

      CFG.imageGenProvider = "openai";
      CFG.imageGenKey = "sk-test";
      CFG.imageGenModel = "Kwai-Kolors/Kolors";
      const req2 = buildImageGenRequest("猫", {});
      check("生图请求：openai 用 POST", req2.kind === "post" && req2.url.endsWith("/images/generations"), req2.url);
      check("生图请求：openai 带鉴权", req2.headers.Authorization === "Bearer sk-test");
      let body = null;
      try {
        body = JSON.parse(req2.body);
      } catch {}
      check(
        "生图请求：openai 字段完整",
        body?.prompt === "猫" && body?.n === 1 && body?.response_format === "b64_json" && body?.size === "768x768"
      );
    } finally {
      CFG.imageGenProvider = savedGen.provider;
      CFG.imageGenModel = savedGen.model;
      CFG.imageGenBaseUrl = savedGen.base;
      CFG.imageGenKey = savedGen.key;
      CFG.imageGenSize = savedGen.size;
    }

    // sniffBufExt：必须按文件头判定，不能信扩展名
    const pad = (head) => Buffer.concat([Buffer.from(head), Buffer.alloc(12)]).slice(0, 12);
    check("文件头：PNG", sniffBufExt(pad([0x89, 0x50, 0x4e, 0x47])) === ".png");
    check("文件头：JPEG", sniffBufExt(pad([0xff, 0xd8, 0xff])) === ".jpg");
    check("文件头：GIF", sniffBufExt(pad([0x47, 0x49, 0x46])) === ".gif");
    check(
      "文件头：WebP",
      sniffBufExt(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")])) === ".webp"
    );
    check("文件头：BMP", sniffBufExt(pad([0x42, 0x4d])) === ".bmp");
    check("文件头：文本不认", sniffBufExt(Buffer.from("<svg>12345678")) === null);
    check("文件头：不足 12 字节不认", sniffBufExt(Buffer.from([0x89, 0x50])) === null);
  }

  console.log(`\n${pass}/${pass + fail} 通过${skip ? `，跳过 ${skip} 条（缺本地素材）` : ""}`);
  return fail === 0 ? 0 : 1;
}

if (process.argv.includes("--selftest")) {
  process.exit(selftest());
}

/**
 * 生图管线端到端自测（本地 mock HTTP 服务，不联网、不烧额度）。
 *
 * 为什么不用 --selftest 覆盖：这里要跨「构造请求 → 真发 HTTP → 解响应 →
 * 文件头纠正 → 落盘 → 群发送报文」整条链，需要异步和端口；放进同步 selftest
 * 会把那一大坨测试拖慢。单独一个排障入口，上线前跑一次即可。
 *
 * 用法：node bridge.mjs --test-imagegen
 */
async function testImageGen() {
  let pass = 0;
  let fail = 0;
  const check = (name, ok, detail = "") => {
    if (ok) pass++;
    else fail++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  };

  const PNG_1PX = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );
  // 1×1 JPEG：mock 服务故意用 image/png 头返回它，验证「扩展名按文件头改」
  const JPEG_1PX = Buffer.from(
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
    "base64"
  );

  const requests = [];
  let flakyHits = 0;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (req.url.startsWith("/prompt/")) {
        if (req.url.startsWith("/prompt/flaky")) {
          flakyHits++;
          if (flakyHits === 1) {
            res.writeHead(503, { "content-type": "text/plain", "retry-after": "1" });
            res.end("Classic API at its limit, retry after 1s");
            return;
          }
        }
        res.writeHead(200, { "content-type": "image/png" }); // 谎报，实际是 JPEG
        res.end(JPEG_1PX);
        return;
      }
      if (req.url === "/v1/images/generations") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ b64_json: PNG_1PX.toString("base64") }] }));
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const saved = {
    provider: CFG.imageGenProvider,
    model: CFG.imageGenModel,
    base: CFG.imageGenBaseUrl,
    key: CFG.imageGenKey,
    size: CFG.imageGenSize,
    timeout: CFG.imageGenTimeoutMs,
    gap: CFG.imageGenMinGapMs,
    imageDir: CFG.imageDir,
  };
  const savedCallApi = callApi;
  const savedDown = imageGenDownUntil;
  const savedNext = pollinationsNextAt;
  const testDir = join(RUN_DIR, ".selftest-imagegen");
  const groupSends = [];

  try {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
    CFG.imageDir = testDir;
    CFG.imageGenTimeoutMs = 10_000;
    imageGenDownUntil = 0;
    pollinationsNextAt = 0;

    // ① pollinations：GET + 二进制响应
    CFG.imageGenProvider = "pollinations";
    CFG.imageGenModel = "flux";
    CFG.imageGenBaseUrl = `http://127.0.0.1:${port}`;
    CFG.imageGenKey = "";
    CFG.imageGenSize = "64x64";
    const r1 = await generateImage("mock cat", { seed: 7 });
    const u1 = requests[0]?.url ?? "";
    check("pollinations：请求到达本地 mock", u1.startsWith("/prompt/mock%20cat"), u1);
    check("pollinations：宽高与 seed 传对", /[?&]width=64/.test(u1) && /[?&]height=64/.test(u1) && /[?&]seed=7/.test(u1), u1);
    check("pollinations：文件已落盘", existsSync(r1.path), r1.path);
    check("pollinations：扩展名按文件头纠正为 .jpg", r1.path.endsWith(".jpg"), basename(r1.path));
    check("pollinations：字节与响应完全一致", readFileSync(r1.path).equals(JPEG_1PX), `${statSync(r1.path).size} 字节`);

    // ①b 503 后按 retry-after 重试，第二次成功（curl 路径 + 重试逻辑）
    CFG.imageGenMinGapMs = 30;
    pollinationsNextAt = 0;
    requests.length = 0;
    const t1b = Date.now();
    const r1b = await generateImage("flaky", { seed: 8 });
    const elapsed1b = Date.now() - t1b;
    const flakyReqs = requests.filter((x) => x.url.startsWith("/prompt/flaky"));
    check("pollinations：503 后重试了一次", flakyReqs.length === 2, String(flakyReqs.length));
    check("pollinations：重试等了服务端要求的 1 秒", elapsed1b >= 900, `${elapsed1b}ms`);
    check("pollinations：重试成功后图已落盘", readFileSync(r1b.path).equals(JPEG_1PX), basename(r1b.path));
    CFG.imageGenMinGapMs = saved.gap;

    // ② openai 兼容：POST + b64_json
    CFG.imageGenProvider = "openai";
    CFG.imageGenKey = "sk-test";
    CFG.imageGenModel = "Kwai-Kolors/Kolors";
    CFG.imageGenBaseUrl = `http://127.0.0.1:${port}/v1`;
    const r2 = await generateImage("猫");
    const post = requests.find((x) => x.url === "/v1/images/generations");
    check("openai：POST 到达本地 mock", Boolean(post), post?.url ?? "无");
    let postBody = null;
    try {
      postBody = JSON.parse(post?.body ?? "{}");
    } catch {}
    check(
      "openai：请求字段正确",
      postBody?.model === "Kwai-Kolors/Kolors" &&
        postBody?.prompt === "猫" &&
        postBody?.n === 1 &&
        postBody?.response_format === "b64_json",
      JSON.stringify(postBody)
    );
    check(
      "openai：鉴权头正确",
      post?.headers?.authorization === "Bearer sk-test",
      String(post?.headers?.authorization)
    );
    check("openai：b64 解出 PNG", r2.path.endsWith(".png") && readFileSync(r2.path).equals(PNG_1PX), basename(r2.path));

    // ③ 群发送报文：stub callApi，验证 reply + text / reply + image 的结构
    lastBotMsgId.delete("selftest-send");
    callApi = async (action, params) => {
      groupSends.push({ action, params });
      return { message_id: 9000 + groupSends.length };
    };
    const target = { kind: "group", groupId: "selftest-send", triggerMessageId: "m-1001" };
    const okText = await sendTo(target, "在的", { quoteId: target.triggerMessageId });
    const okImg = await sendImageTo(target, "E:\\fake\\a.png", { quoteId: target.triggerMessageId });
    check("群发送：两次都成功", okText && okImg);
    check("群发送：动作是 send_group_msg", groupSends.every((s) => s.action === "send_group_msg"));
    check(
      "群发送：带 reply 段且指向触发消息",
      groupSends[0]?.params?.message?.[0]?.type === "reply" &&
        groupSends[0]?.params?.message?.[0]?.data?.id === "m-1001"
    );
    check(
      "群发送：文本段正确",
      groupSends[0]?.params?.message?.[1]?.type === "text" &&
        groupSends[0]?.params?.message?.[1]?.data?.text === "在的"
    );
    check(
      "群发送：图片段用 file:/// 路径",
      groupSends[1]?.params?.message?.[1]?.type === "image" &&
        groupSends[1]?.params?.message?.[1]?.data?.file === "file:///E:/fake/a.png",
      String(groupSends[1]?.params?.message?.[1]?.data?.file)
    );
    check("群发送：记住她最后一条 message_id", lastBotMsgId.get("selftest-send") === 9002, String(lastBotMsgId.get("selftest-send")));

    // ④ 回复全链路：replyTo → 文本 → [[画]] → 出图 → 群游标 / 私聊不回归
    const savedAsk = ask;
    const savedGenImage = generateImage;
    const savedAppendChatLog = appendChatLog;
    const pipeKey = "selftest-pipe";
    try {
      groupSends.length = 0;
      imageGenDownUntil = 0;
      pollinationsNextAt = 0;
      const drawFile = join(testDir, "pipe.png");
      writeFileSync(drawFile, PNG_1PX);
      ask = async () => ({ reply: "在的在的[[画:一只猫]]", sel: null, degraded: false, tried: [] });
      generateImage = async () => ({ path: drawFile, provider: "mock", model: "mock" });
      appendChatLog = () => {};
      groupCtx.delete(pipeKey);
      await replyTo(
        { kind: "group", groupId: pipeKey, triggerMessageId: "m-2001" },
        "在吗",
        [],
        { groupCtx: [], groupInjectedCount: 0, groupSpeaker: "阿明", groupAt: true }
      );
      await drawChain; // 出图走独立队列，等它完成再断言
      const msgs = groupSends
        .filter((s) => s.action === "send_group_msg")
        .map((s) => s.params.message);
      check(
        "群链路：文本先发",
        msgs[0]?.[1]?.type === "text" && msgs[0]?.[1]?.data?.text === "在的在的",
        JSON.stringify(msgs[0])
      );
      check("群链路：画图标记没漏进正文", !JSON.stringify(msgs[0] ?? "").includes("[[画"));
      check(
        "群链路：随后发出生成图",
        msgs[1]?.[1]?.type === "image" && String(msgs[1]?.[1]?.data?.file).startsWith("file:///"),
        JSON.stringify(msgs[1])
      );
      const pipeCtx = takeGroupContext(pipeKey);
      check(
        "群链路：她的回复写回上下文",
        pipeCtx.lines.some((l) => l.includes("你/") && l.includes("在的在的")),
        pipeCtx.lines.join(" | ")
      );

      // 私聊路径不能回归：仍然走 send_private_msg 的字符串消息
      groupSends.length = 0;
      ask = async () => ({ reply: "私聊回复", sel: null, degraded: false, tried: [] });
      const savedVoiceEnabled = CFG.voiceEnabled;
      CFG.voiceEnabled = false;
      try {
        await replyTo(10001, "在吗");
      } finally {
        CFG.voiceEnabled = savedVoiceEnabled;
      }
      const priv = groupSends.find((s) => s.action === "send_private_msg");
      check("私聊链路：仍走 send_private_msg", Boolean(priv));
      check(
        "私聊链路：文本正确",
        priv?.params?.message === "私聊回复" || priv?.params?.message?.[0]?.data?.text === "私聊回复",
        JSON.stringify(priv?.params?.message)
      );
    } finally {
      ask = savedAsk;
      generateImage = savedGenImage;
      appendChatLog = savedAppendChatLog;
      groupCtx.delete(pipeKey);
    }

    // ⑤ 失败冷却：401 应进 30 分钟冷却，期间 imageGenReady=false
    imageGenDownUntil = 0;
    noteImageGenFailure(new Error("HTTP 401: invalid key"));
    check("失败冷却：401 进入 30 分钟冷却", imageGenCooldownLeftMs() > 29 * 60_000, String(imageGenCooldownLeftMs()));
    check("失败冷却：冷却期间不可用", imageGenReady() === false);
  } catch (e) {
    fail++;
    console.log(`FAIL  自测异常 — ${String(e?.stack || e).slice(0, 600)}`);
  } finally {
    callApi = savedCallApi;
    CFG.imageGenProvider = saved.provider;
    CFG.imageGenModel = saved.model;
    CFG.imageGenBaseUrl = saved.base;
    CFG.imageGenKey = saved.key;
    CFG.imageGenSize = saved.size;
    CFG.imageGenTimeoutMs = saved.timeout;
    CFG.imageGenMinGapMs = saved.gap;
    CFG.imageDir = saved.imageDir;
    imageGenDownUntil = savedDown;
    pollinationsNextAt = savedNext;
    lastBotMsgId.delete("selftest-send");
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    // Windows 上 fetch 的 keep-alive 连接还在关，直接 process.exit 会触发
    // libuv 断言（async.c:94 / UV_HANDLE_CLOSING）；等一拍再退。
    await new Promise((r) => setTimeout(r, 100));
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }

  console.log(`\n${pass}/${pass + fail} 通过`);
  return fail === 0 ? 0 : 1;
}

// 排障用：不发 QQ，只核对「画自己」会走标准照还是模板，标准照缺失时生成一张兜底图。
// 用法：node bridge.mjs --draw-self-test "生成你的形象给我看看"
if (process.argv.includes("--draw-self-test")) {
  const i = process.argv.indexOf("--draw-self-test");
  const text =
    process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
      ? process.argv[i + 1]
      : "生成你的形象给我看看";
  const afterSelf = process.argv.includes("--after-self");
  const plan = planDraw(text, "", { afterSelfPortrait: afterSelf });
  console.log(
    `[draw-self-test] afterSelf=${afterSelf} self=${plan.self} canonical=${plan.canonical} seed=${plan.seed}`
  );
  console.log(`[draw-self-test] image=${SELF_PORTRAIT_IMAGE} exists=${existsSync(SELF_PORTRAIT_IMAGE)}`);
  const lib = listSelfPortraits();
  console.log(`[draw-self-test] library=${lib.length} first=${basename(lib[0] ?? "-")}`);
  const seq = [];
  let last = null;
  for (let k = 0; k < Math.min(lib.length + 1, 5); k++) {
    last = nextPortraitPath(lib, last);
    seq.push(basename(last));
  }
  console.log(`[draw-self-test] rotate=${seq.join(" -> ")}`);
  console.log(`[draw-self-test] prompt=${plan.prompt}`);
  if (!existsSync(SELF_PORTRAIT_IMAGE)) {
    const r = await generateImage(plan.prompt, { seed: plan.seed });
    console.log(`[draw-self-test] fallback=${r.path}`);
  }
  process.exit(0);
}

if (process.argv.includes("--test-imagegen")) {
  const code = await testImageGen();
  process.exit(code);
}

// ── 排障用：看一眼真正发给 dsh 的 prompt 长什么样、有多长 ──────────────
// 用法：node bridge.mjs --dump-prompt "在吗"
//       node bridge.mjs --dump-prompt "看图" --with-image
//       node bridge.mjs --dump-prompt "小玉 中午吃啥" --group
// 不连 ws、不烧积分，只把拼好的文本打出来。
if (process.argv.includes("--dump-prompt")) {
  const i = process.argv.indexOf("--dump-prompt");
  const text = process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : "在吗";
  const withImage = process.argv.includes("--with-image");
  const asGroup = process.argv.includes("--group");
  const fakeHist = [
    { role: "user", content: "在吗" },
    { role: "assistant", content: "在的呀，怎么了老大" },
    { role: "user", content: "今天忙不忙" },
    { role: "assistant", content: "还行，就是有点犯困" },
  ];
  // 2026-10-21 19:2x：默认改成**真实恢复结果**——想看「重启后她到底记得什么」
  // 就得看生产那条路，拿假历史安慰自己没意义。要看旧样例加 --fake-hist。
  const uid = CFG.allowFrom[0] ?? 10001;
  const useFake = process.argv.includes("--fake-hist") || asGroup;
  const real = useFake ? null : loadRecentHistory(uid);
  const hist = useFake ? (asGroup ? [] : fakeHist) : real.hist;
  if (real) {
    console.error(
      `[dump] 恢复 ${real.hist.length} 条${real.crossDay ? `（跨天，自 ${real.since}）` : ""}`
    );
    const d = latestDiaryBefore();
    console.error(`[dump] 昨日日记：${d ? `${d.day} / ${d.text.length} 字` : "无"}`);
  }
  if (asGroup) console.error("[dump] 群聊模式：私聊历史/memory/日记/空间状态均不注入");
  const p = buildDshPrompt(
    asGroup ? "group:dump" : uid,
    text,
    hist,
    withImage ? ["E:\\fake\\a.jpg"] : [],
    withImage ? { ok: true, text: "拿来吧你", details: [] } : null,
    withImage,
    asGroup ? "group" : "chat",
    asGroup
      ? {
          groupSpeaker: "阿明",
          groupAt: true,
          groupCtx: ["[阿明/12:00]: 今天好热", "[小红/12:01]: 热死了，空调不开", "[阿明/12:02]: 小玉 中午吃啥"],
        }
      : // --sticker：把这条当表情包看（验证「只反应不描述」那条路）
        { stickerOnly: process.argv.includes("--sticker") }
  );
  console.log(p);
  console.log(`\n──── 统计 ────`);
  console.log(`总字符数: ${p.length}`);
  console.log(`模式: ${asGroup ? "群聊" : "私聊"}`);
  console.log(`其中历史对话: ${hist.length} 条（生产环境最多 ${CFG.historyTurns * 2} 条消息）`);
  if (!asGroup) console.log(`memory.md: ${readMemory().length} 字符`);
  process.exit(0);
}


// ── 排障用：验 sniffImageExt 判断对不对 ────────────────────────────────
// 用法：node bridge.mjs --test-sniff a.gif b.jpg c.png
// 直接调生产函数，不复制逻辑（复制就等于测了个副本）。
if (process.argv.includes("--test-sniff")) {
  const args = process.argv.slice(process.argv.indexOf("--test-sniff") + 1).filter((a) => !a.startsWith("--"));
  if (!args.length) {
    console.log("用法：node bridge.mjs --test-sniff <文件> [文件...]");
    process.exit(1);
  }
  for (const f of args) {
    if (!existsSync(f)) {
      console.log(`${f}  → 文件不存在`);
      continue;
    }
    const real = sniffImageExt(f);
    const declared = (f.match(/\.[a-z0-9]+$/i)?.[0] ?? "").toLowerCase();
    const verdict = !real ? "无法识别" : declared === real || (declared === ".jpeg" && real === ".jpg") ? "一致" : `需改名 → ${real}`;
    console.log(`${basename(f).padEnd(28)} 声明 ${declared || "(无)"}  实际 ${real || "?"}  ${verdict}`);
  }
  process.exit(0);
}

// ── 排障用：真跑一次旧原话检索（不联网、不烧积分、不动文件）──────────
// 用法：node bridge.mjs --test-recall "你还记得晚课说了什么吗"
//       node bridge.mjs --test-recall "包子" --days 90 --limit 6
//
// 为什么要有：`.run/mem-recall-real.mjs` 那边是**手抄的一份副本**，
// 按我们的纪律「复制逻辑 = 测了个副本」，那种测法只能验想法、验不了生产代码。
// 这里直接调生产函数，改一行就看得到差别。
if (process.argv.includes("--test-recall")) {
  const argv = process.argv.slice(process.argv.indexOf("--test-recall") + 1);
  const pickNum = (flag, dflt) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dflt;
  };
  const args = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
  const q = args[0] ?? "你还记得晚课说了什么吗";
  const days = pickNum("--days", CFG.recallDays);
  const limit = pickNum("--limit", CFG.recallLimit);
  const uid = CFG.allowFrom[0] ?? null;

  console.log(`查询：「${q}」  天数=${days}  上限=${limit}  userId=${uid ?? "（不限）"}`);
  const gate = recallAllowed(false, q);
  console.log(`句式闸门：${gate ? "放行（判定为在问旧事）" : "不放行（当日常闲聊处理）"}`);
  console.log(`群聊是否允许：${recallAllowed(true, q) ? "会（不该）" : "不会（正确）"}`);

  const rc = recallFromChatLog(q, { daysBack: days, limit, userId: uid });
  const dfFn = null; // 只用于打印，不必重算
  console.log(`\n扫描 ${rc.scanned} 行；候选词 ${recallTokens(q).length} 个 → 可信词 ${rc.tokens.length} 个`);
  console.log(`可信词：${rc.tokens.join(" / ") || "（无）"}`);
  console.log(`命中 ${rc.used} 条；注入门槛(>=${RECALL_MIN_LINES}) → ${recallInjectable(rc) ? "会注入" : "不注入"}`);
  if (rc.lines.length) {
    console.log("");
    for (const l of rc.lines) console.log(`  ${l}`);
  }
  process.exit(0);
}

// ── 排障用：看周回顾的素材与 prompt（不调模型、不烧积分、不写文件）──
// 用法：node bridge.mjs --test-weekly            # 按默认 7 天
//       node bridge.mjs --test-weekly 2026-10-26 # 指定截止日
//
// 为什么要有：周回顾是每周才跑一次的定时任务，等一周才知道它行不行太贵；
// 而且它一旦写歪，会作为「记忆」长期留着。所以先让它把**输入**打出来人工核。
if (process.argv.includes("--test-weekly")) {
  const argv = process.argv.slice(process.argv.indexOf("--test-weekly") + 1).filter((a) => !a.startsWith("--"));
  const endDay = argv[0] ?? dayKey(new Date());
  const uid = CFG.allowFrom[0] ?? null;
  const keys = weekDayKeys(endDay, CFG.weeklyDays);
  const material = collectWeekMaterial(endDay, { days: CFG.weeklyDays, userId: uid });
  const total = material.reduce((a, d) => a + d.lines.length, 0);
  console.log(`窗口：${keys[0]} ~ ${keys[keys.length - 1]}（${CFG.weeklyDays} 天）  userId=${uid ?? "（不限）"}`);
  console.log(`素材合计 ${total} 条；写入门槛 >=${CFG.weeklyMinLines} → ${total >= CFG.weeklyMinLines ? "会写" : "不写（素材太少）"}`);
  console.log("");
  for (const d of material) {
    console.log(`— ${d.day} — ${d.lines.length} 条（当天总 ${d.total} 条）`);
    for (const l of d.lines.slice(0, 4)) console.log(`    ${l.slice(0, 70)}`);
    if (d.lines.length > 4) console.log(`    …还有 ${d.lines.length - 4} 条`);
  }
  const prompt = buildWeeklyPrompt(material, { from: keys[0], to: keys[keys.length - 1] });
  console.log(`\nprompt 长度：${prompt.length} 字符`);
  console.log("防编条款在不在：" + (/宁可少写，也不许补细节/.test(prompt) ? "在 ✅" : "不在 ❌"));
  process.exit(0);
}

// ── 排障用：真跑一次周回顾（会烧一次积分、会写文件，**不发 QQ**）──
// 用法：node bridge.mjs --test-weekly-run [截止日]
// 为什么要真跑：周回顾是每周才跑一次的定时任务，「等一周才知道行不行」太贵；
// 而它一旦写歪就会作为记忆长期留着。所以给一个当场能跑、能看产物的入口。
// 与 #周记 写的区别：这条不发消息、不动配额，只验证「生成 + 落盘」这一段。
if (process.argv.includes("--test-weekly-run")) {
  const argv = process.argv.slice(process.argv.indexOf("--test-weekly-run") + 1).filter((a) => !a.startsWith("--"));
  const endDay = argv[0] ?? dayKey(new Date());
  const uid = CFG.allowFrom[0] ?? null;
  console.log(`[test-weekly-run] 截止日=${endDay}  userId=${uid ?? "（不限）"}  会烧一次模型调用`);
  const saved = sendPrivate;
  // 这条路故意不发 QQ：调试入口不该在半夜给老大推消息
  runWeekly(uid, { auto: false, endDay, quiet: true }).then((ok) => {
    console.log(`[test-weekly-run] 结果=${ok ? "成功" : "失败"}`);
    console.log(`[test-weekly-run] 产物路径：${weeklyPathOf(endDay)}`);
    process.exit(0);
  }).catch((e) => {
    console.error(`[test-weekly-run] 异常：${String(e.message).slice(0, 200)}`);
    process.exit(1);
  });
}

// ── 排障用：真跑一次改名（会动文件，只对 --test-fix 列的路径生效）──────
// 用法：node bridge.mjs --test-fix .run/sniff/wrong-ext.jpg
if (process.argv.includes("--test-fix")) {
  const args = process.argv.slice(process.argv.indexOf("--test-fix") + 1).filter((a) => !a.startsWith("--"));
  if (!args.length) {
    console.log("用法：node bridge.mjs --test-fix <文件> [文件...]");
    process.exit(1);
  }
  for (const f of args) {
    if (!existsSync(f)) {
      console.log(`${f}  → 文件不存在`);
      continue;
    }
    const out = fixImageExt(f);
    const changed = out !== f;
    console.log(`${basename(f).padEnd(28)} → ${basename(out).padEnd(28)} ${changed ? "已改名" : "无需改"}  存在=${existsSync(out)}`);
  }
  process.exit(0);
}

// ── 排障用：走真实降级链问一句（会烧积分，只用于验证链路）──────────────
// 用法：node bridge.mjs --test-ask "回一个字：好"
if (process.argv.includes("--test-ask")) {
  const i = process.argv.indexOf("--test-ask");
  const text = process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : "回一个字：好";
  const ii = process.argv.indexOf("--test-image");
  const imgs = ii >= 0 ? process.argv.slice(ii + 1).filter((a) => !a.startsWith("--")) : [];
  (async () => {
    try {
      const r = await ask(10001, text, imgs, "chat", { stickerOnly: process.argv.includes("--sticker") });
      console.log(`[test-ask] 回复：${String(r.reply).trim().slice(0, 160)}`);
      console.log(`[test-ask] 命中：${selLabel(r.sel)}${r.effort ? `@${r.effort}` : "（无档位）"}`);
      console.log(`[test-ask] 链路：${r.tried.join(" → ")}`);
      process.exit(0);
    } catch (e) {
      console.log(`[test-ask] 失败：${String(e.message).slice(0, 240)}`);
      process.exit(1);
    }
  })();
}

// ── 单实例锁（2026-10-18，治「误双击开出双 bridge」）──────────────────────
// 背景：老大两次误双击 run-bridge.bat（22:24、22:41）→ 两个 bridge 同时连 NapCat，
// 同一条消息双倍处理、双倍扣积分，两次都靠人工杀进程收场。
// 现在从机制上杜绝：后启动的实例发现锁里的 PID 还活着，就直接退出——
// 误双击的窗口只会看到一句 FATAL 提示，不会再起一个干活的双胞胎。
//
// 锁文件：.run/bridge.lock（JSON: {pid, startedAt}）
// 陈旧锁：PID 已不存在（上一实例死了但没来得及清锁）→ 接管，不影响 :loop 重启。
// 失败放行：锁检查本身出错时（读不了/写不了）不拦启动 ——
// 宁可冒双 bridge 的风险，也不能把唯一 bridge 挡在门外。
const BRIDGE_LOCK_PATH = join(RUN_DIR, "bridge.lock");

/**
 * 锁里的记录是否还对应「真实活着的自己人」—— 供自测直接调，不复制逻辑。
 * 2026-10-23 加：单纯比 PID 存活会被 Windows 的 PID 复用骗过去。
 */
function lockHolderIsReal(prev) {
  if (!prev || !pidAlive(prev.pid)) return false;
  return pidIsThisProgram(prev.pid, prev.startedAt);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // Windows 上信号 0 = 只探存在性，不真发信号
    return true;
  } catch (e) {
    return e.code === "EPERM"; // 进程在，但不属于本用户/无权限 —— 也算活着
  }
}

/**
 * PID 是否真的是**本程序**（2026-10-23 修，治「锁永远解不开」）。
 *
 * 🔴 事故（2026-10-23 10:20 实测）：旧版只比 PID 是否存活。
 *    Windows 的 PID 会被**回收再分配** —— 10-22 17:38 那个 bridge（PID 12092）
 *    死了以后，系统把 12092 分给了 `StartMenuExperienceHost`。
 *    于是 `pidAlive(12092)` 返回 true，每次启动都以为「已有一个 bridge 在运行」，
 *    打印 FATAL 后退出 → `:loop` 每 3 秒重拉一次，**永远起不来**。
 *    实测证据：全系统 0 个 node 进程，但日志显示「bridge 在运行」。
 *
 * 判据分两档，**能查到就查，查不到就别拦**（拦错比双开更糟）：
 *   ① 能查到进程名，且不是 node → 肯定不是（PID 被复用）
 *   ② 能查到启动时间，且比锁里记的晚 ≥2 分钟 → 肯定不是（老进程死了以后新分配的）
 *   ③ 什么都查不到（沙箱/权限/命令不存在）→ 返回 true，保持旧行为，绝不卡死启动
 */
function pidIsThisProgram(pid, startedAt) {
  if (!pidAlive(pid)) return false;

  /** 跑一条命令取 stdout；失败返回 ""（沙箱里 spawnSync 全 EPERM，必须容错） */
  const run = (cmd, args, timeout = 6000) => {
    try {
      return String(execFileSync(cmd, args, { encoding: "utf8", timeout, windowsHide: true }) || "").trim();
    } catch {
      return "";
    }
  };

  // Linux/macOS：用 /proc/<pid>/exe 判身份；查不到就按旧行为放行
  if (process.platform !== "win32") {
    // 注意：Node 24 在 Linux 上把 comm 设成了 "MainThread"，ps -o comm= 不可用（2026-10-23 实测）
    let exe = "";
    try {
      exe = readlinkSync(`/proc/${pid}/exe`);
    } catch {
      try {
        exe = String(readFileSync(`/proc/${pid}/cmdline`, "utf8")).split("\0")[0];
      } catch {}
    }
    const name = basename(exe || "");
    if (name && !/^node/i.test(name)) {
      logErr(`[lock] PID ${pid} 现在是 ${name}，不是 node，按陈旧锁接管`);
      return false;
    }
    if (startedAt) {
      // etimes 不受时区影响：进程比锁还「年轻」就说明 PID 被复用了
      const etimes = Number(run("ps", ["-p", String(pid), "-o", "etimes="]));
      const lockAge = (Date.now() - Date.parse(startedAt)) / 1000;
      if (Number.isFinite(etimes) && etimes > 0 && Number.isFinite(lockAge) && lockAge - etimes > 120) {
        logErr(`[lock] PID ${pid} 的启动时间比锁里记的晚，不是原来那个 bridge`);
        return false;
      }
    }
    return true;
  }

  // ① 进程名：tasklist 最轻，退 powershell
  let name = "";
  const tl = run("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"]);
  if (tl && !/没有运行|No tasks|INFO:/i.test(tl)) {
    name = (tl.split("\n")[0]?.match(/^"([^"]+)"/)?.[1] ?? "").toLowerCase();
  }
  if (!name) {
    name = run("powershell", ["-NoProfile", "-NonInteractive", "-Command",
      `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).ProcessName`]).toLowerCase();
  }

  if (name) {
    if (!(name === "node" || name === "node.exe")) {
      logErr(`[lock] PID ${pid} 现在是 ${name}，不是 node（PID 被系统复用），按陈旧锁接管`);
      return false;
    }
    // 名字对上了，再用启动时间排掉「恰好也叫 node 但其实是新进程」的极端情况
    if (startedAt) {
      const out = run("powershell", ["-NoProfile", "-NonInteractive", "-Command",
        `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToUniversalTime().ToString('o')`]);
      const realStart = Date.parse(out);
      const lockStart = Date.parse(startedAt);
      if (Number.isFinite(realStart) && Number.isFinite(lockStart) && realStart - lockStart > 120e3) {
        logErr(`[lock] PID ${pid} 的启动时间比锁里记的晚 ${Math.round((realStart - lockStart) / 1000)}s，不是原来那个 bridge`);
        return false;
      }
    }
  }

  // ③ 查不到 → 按存活处理（旧行为）
  return true;
}

function acquireSingleInstanceLock() {
  // 调试参数不连 ws、不占端口，跟主实例并存没有冲突——
  // 2026-10-21 实测：--test-ask 被这个锁挡住，白等一轮。
  if (process.argv.some((a) => ["--test-ask", "--test-sniff", "--test-fix", "--selftest", "--dump-prompt", "--draw-self-test", "--test-recall", "--test-weekly"].includes(a))) {
    return true;
  }
  try {
    mkdirSync(RUN_DIR, { recursive: true });
    if (existsSync(BRIDGE_LOCK_PATH)) {
      const prev = JSON.parse(readFileSync(BRIDGE_LOCK_PATH, "utf8"));
      if (prev && pidAlive(prev.pid)) {
        // 2026-10-23：PID 存活还不够，得确认那确实是 node。
        // Windows 会回收复用 PID，旧 bridge 死了以后 12092 被分给了别的系统进程，
        // 于是每次启动都误判「已有 bridge 在运行」→ 永远起不来（实测事故）。
        if (lockHolderIsReal(prev)) {
          const since = prev.startedAt
            ? new Date(prev.startedAt).toLocaleString("zh-CN", { hour12: false })
            : "未知时间";
          logErr("");
          logErr("================================================================");
          logErr(` [FATAL] 已有一个 bridge 在运行（PID ${prev.pid}，启动于 ${since}）`);
          logErr(" 本实例退出。如果是误双击了 run-bridge.bat：直接关掉本窗口即可，");
          logErr(" 不需要做任何其他操作，原来的 bridge 不受影响。");
          logErr(" 真要重启：先结束上面那个 bridge（或关掉它的 :loop 窗口），");
          logErr(" :loop 会在 3 秒后自动拉起新实例。");
          logErr("================================================================");
          return false;
        }
        log(`[lock] PID ${prev.pid} 还活着但不是 node（PID 被系统复用了），按陈旧锁接管`);
      }
      log(`[lock] 发现陈旧锁（PID ${prev?.pid} 已不存在），接管`);
    }
    writeFileSync(
      BRIDGE_LOCK_PATH,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2)
    );
    log(`[lock] 单实例锁已获取（PID ${process.pid}）`);
    return true;
  } catch (e) {
    logErr(`[lock] 锁检查失败，放行启动：${e.message}`);
    return true;
  }
}

function releaseSingleInstanceLock() {
  try {
    if (existsSync(BRIDGE_LOCK_PATH)) {
      const cur = JSON.parse(readFileSync(BRIDGE_LOCK_PATH, "utf8"));
      if (cur?.pid === process.pid) unlinkSync(BRIDGE_LOCK_PATH);
    }
  } catch {}
}

// ── 启动 ────────────────────────────────────────────────────────────────
rotateLog();

if (!acquireSingleInstanceLock()) {
  process.exit(1);
}
process.on("exit", releaseSingleInstanceLock);

const startupCfg = loadModelConfig();
log("[cfg] ws:", CFG.wsUrl);
log("[cfg] allowFrom:", CFG.allowFrom.length ? CFG.allowFrom.join(",") : "所有人（不推荐）");
log(
  "[cfg] backend:",
  CFG.backend,
  CFG.backend === "dsh" ? `(profile=${CFG.dshProfile}, timeout=${CFG.dshTimeoutMs}ms)` : `(model=${CFG.model})`
);
log("[cfg] memory:", CFG.memoryPath, existsSync(CFG.memoryPath) ? `(${readMemory().length} 字符)` : "(不存在)");
log(
  "[cfg] model:",
  `${selLabel(startupCfg.primary)}（${rateLabel(startupCfg.primary.provider, startupCfg.primary.model)}）`,
  `档位=${startupCfg.effort ?? "未指定"}`,
  "→ 降级",
  startupCfg.fallbacks.map(selLabel).join(" → ") || "无"
);
log("[cfg] 换模型/调档位：改 model.json，或在 QQ 里发 #模型");
log(
  `[cfg] 图像: ${
    CFG.imageEnabled
      ? CFG.visionEnabled
        ? "开（视觉直传：图片像素直接给模型，能看懂画面；OCR 作文字精读补充）"
        : CFG.ocrEnabled
          ? "开（视觉已关，仅 OCR 读图中文字；读不出画面）"
          : "开（仅接收图片，视觉与 OCR 都关 → 模型会说看不到）"
      : "关"
  } → ${CFG.imageDir}`
);
log(
  `[cfg] 语音: ${
    CFG.voiceEnabled
      ? `开（${CFG.voiceAuto ? "自动：每条回复都配语音" : "按需：关键词 / 要求后 180s 内续消息 / 模型承诺「念一段」"}；说「不用语音」长期静音并落盘，说「语音说」或 #语音 开 恢复${voiceMutedNote()}；音色 ${CFG.voiceName}）`
      : "关"
  }`
);
log(
  `[cfg] 主动消息: ${
    CFG.proactiveEnabled
      ? `开（间隔 ${CFG.proactiveMinGapHours}~${CFG.proactiveMaxGapHours} 小时随机，静默 ${CFG.proactiveQuietStart}~${CFG.proactiveQuietEnd} 点，每天最多 ${CFG.proactiveDailyMax} 条）`
      : "关"
  }`
);
log(
  `[cfg] 自动说说: ${
    CFG.qzoneEnabled
      ? `开（每天 ${CFG.qzoneDailyTimes} 条，${CFG.qzoneHourStart}~${CFG.qzoneHourEnd} 点随机；${
          CFG.qzoneDryRun ? "演练模式：只生成给你看，不发到空间" : `真发，可见范围 ${CFG.qzoneRight}`
        }）`
      : "关"
  }`
);

// ── 主动行为调度（自动语音 / 主动消息 / 自动说说）──────────────────────// 2026-10-19 新增。设计参考了 AstrBot 系插件（astrbot_plugin_qzone /
// Wyc_Tools）的成熟做法：**随机间隔 + 静默时段 + 每日上限 + 演练模式**。
// 那套东西是 AstrBot 插件，搬不过来；但 NapCat 原生就有 send_qzone_msg，
// 所以底层能力现成，上面这层几十行就够。

const SCHEDULE_PATH = join(__dirname, ".run", "schedule.json");
const SCHED_TICK_MS = 5 * 60 * 1000;

function loadSchedule(path) {
  try {
    path = path ?? SCHEDULE_PATH; // 注意：SCHEDULE_PATH 是 TDZ 区居民，必须在 try 里取值
    const v = JSON.parse(readFileSync(path, "utf8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function saveSchedule(next, path) {
  try {
    path = path ?? SCHEDULE_PATH;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(next, null, 2), "utf8");
  } catch (e) {
    logErr(`[sched] 状态写入失败: ${String(e.message).slice(0, 100)}`);
  }
}

// ── 自动写日记（2026-10-19 老大要求：不是他叫才写，是自己每天写）──────────
// 每天在 diaryHourStart~diaryHourEnd 之间随机挑一个时刻，到点自己写。
// 只写一次；当天已经手写过（#日记）也会照写——那是不同时段的两段，追加即可。

/**
 * 配额回滚（2026-10-22 审计修复 F-01）。
 * scheduleTick 是「先扣配额后执行」，执行异常失败时把配额还回去：
 * - qzone/diary：count 减回，planAt 恢复成 30 分钟后（限 retries<2，防整夜掉线时每 30 分钟白烧一次积分）；
 * - proactive：count 减回，lastAt 记为现在（等下一个自然间隔，不立即重试）。
 * 「内容为空跳过」不算失败、不回滚——否则空内容会每 5 分钟重试刷屏。
 */
function rollbackQuota(kind, day, path) {
  try {
    path = path ?? SCHEDULE_PATH; // 同上：TDZ 区，try 内取值
    const st = loadSchedule(path);
    const cur = st[kind];
    if (!cur || cur.day !== day) return;
    const retries = (Number(cur.retries) || 0) + 1;
    if (kind === "proactive") {
      st[kind] = { ...cur, count: Math.max(0, (Number(cur.count) || 0) - 1), lastAt: Date.now() };
    } else if (retries <= 2) {
      st[kind] = {
        ...cur,
        count: Math.max(0, (Number(cur.count) || 0) - 1),
        planAt: Date.now() + 30 * 60 * 1000,
        retries,
      };
      log(`[sched] ${kind} 失败，配额已退回，30 分钟后重试（第 ${retries}/2 次）`);
    } else {
      log(`[sched] ${kind} 已重试 2 次仍失败，今天不再试（配额不退，避免无限重试）`);
      return;
    }
    saveSchedule(st, path);
  } catch (e) {
    logErr(`[sched] 配额回滚失败: ${String(e.message).slice(0, 100)}`);
  }
}

let diaryBusy = false;

async function runDiaryScheduled() {
  const admin = CFG.allowFrom[0];
  if (!admin || diaryBusy) return false;
  diaryBusy = true;
  try {
    log("[diary] 到点了，自动写今天的日记");
    await runDiary(admin, { auto: true });
    return true;
  } catch (e) {
    logErr(`[diary] 自动写失败: ${String(e.message).slice(0, 160)}`);
    return false;
  } finally {
    diaryBusy = false;
  }
}

// 周回顾的自动入口（和 runDiaryScheduled 同构：busy 锁 + 成功/失败二值供配额回滚判断）
let weeklyBusy = false;
async function runWeeklyScheduled() {
  const admin = CFG.allowFrom[0];
  if (!admin || weeklyBusy) return false;
  weeklyBusy = true;
  try {
    log("[weekly] 到点了，自动写这一周的回顾");
    // runWeekly 在「素材太少」时返回 true（算执行过，不回滚配额，避免每 5 分钟重试刷屏）
    return await runWeekly(admin, { auto: true });
  } catch (e) {
    logErr(`[weekly] 自动写失败: ${String(e.message).slice(0, 160)}`);
    return false;
  } finally {
    weeklyBusy = false;
  }
}

function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 静默时段判定，支持跨零点（如 23 → 7） */
function inQuietHours(hour = new Date().getHours()) {
  const s = CFG.proactiveQuietStart;
  const e = CFG.proactiveQuietEnd;
  if (!Number.isFinite(s) || !Number.isFinite(e) || s === e) return false;
  return s < e ? hour >= s && hour < e : hour >= s || hour < e;
}

function randBetween(a, b) {
  if (!(b > a)) return a;
  return a + Math.random() * (b - a);
}

let proactiveBusy = false;
async function runProactive(why) {
  const admin = CFG.allowFrom[0];
  if (!admin || proactiveBusy) return false;
  proactiveBusy = true;
  try {
    log(`[proactive] 触发（${why}），生成中…`);
    const r = await ask(admin, "（主动开口）", [], "proactive");
    // 和 replyTo 一样要解析 [[sticker:…]]：主动开口这条路径独立于聊天，
    // 2026-10-19 实测漏了这一步，标记被原样发给老大（连语音都念出来了）。
    const st = extractStickerRequest(sanitize(r.reply));
    const msg = st.cleaned;
    // prompt 里给了 [[skip]]：没素材、没想说的就允许她闭嘴
    if (msg.trim() === "[[skip]]") {
      log("[proactive] 这次她说没什么想说的，跳过");
      return true;
    }
    const sticker = st.query ? matchSticker(st.query) : null;
    if (!msg && !sticker) {
      logErr(`[proactive] 内容与表情都为空（请求词=${st.query ?? "无"}），跳过本条`);
      return true; // 空内容算「执行过了」，不回滚配额（否则每 5 分钟重试刷屏）
    }
    if (st.query && !sticker) log(`[proactive] 想发「${st.query}」但库里没匹到，跳过`);
    const segments = msg ? splitReplySegments(msg) : [];
    if (msg) {
      // 主动开场和正常回复共用同一套 [[分]] 规则：2026-10-24 23:20 这条漏了，
      // 标记被原样塞进一条消息，老大看到的是未拆分的整段。
      if (segments.length > 1) {
        log(`[multi] 主动消息分 ${segments.length} 条发：${segments.map((s) => s.slice(0, 14)).join(" ／ ")}`);
        for (let i = 0; i < segments.length; i++) {
          if (i > 0) await sleep(CFG.multiGapMs);
          await sendPrivate(admin, segments[i]);
        }
      } else {
        await sendPrivate(admin, segments[0]);
      }
      const joined = segments.join("\n");
      appendChatLog(admin, "assistant", `${PROACTIVE_TAG}${joined}`);
      // 2026-10-24：原来只落 chatlog、不进 histories，两小时后触发时她根本
      // 不知道自己刚问过「晚饭吃了没」→ 天天重复同一句。
      const h = histories.get(admin) ?? [];
      h.push({ role: "assistant", content: joined, ts: Date.now() });
      histories.set(admin, h.slice(-CFG.historyTurns * 2));
    }
    if (sticker) await sendPrivateImage(admin, sticker.file);
    // 2026-10-21 19:0x：主动消息这条路原来只看 CFG.voiceAuto，
    // 不看 voiceAutoMuted —— 14:14:17 已关语音，15:52:30 主动消息照样念了。
    if (msg && CFG.voiceEnabled && CFG.voiceAuto && !isVoiceMuted(admin)) await sendVoice(admin, segments.join("\n"));
    log(`[proactive] 已发：${(segments.join(" ／ ") || "").slice(0, 50)}${sticker ? ` ＋表情 ${sticker.name}` : ""}`);
    return true;
  } catch (e) {
    logErr(`[proactive] 失败: ${String(e.message).slice(0, 160)}`);
    return false;
  } finally {
    proactiveBusy = false;
  }
}

let qzoneBusy = false;
async function runQzone(why) {
  const admin = CFG.allowFrom[0] ?? 0;
  if (qzoneBusy) return false;
  qzoneBusy = true;
  try {
    log(`[qzone] 触发（${why}），生成中…`);
    const r = await ask(admin, "（写说说）", [], "qzone");
    let content = sanitize(r.reply).trim();
    // 模型偶尔会带引号或 Markdown 标记，去掉再说
    content = content
      .replace(/^[「"'“『]/, "")
      .replace(/[」"'”』]$/, "")
      .replace(/\*\*/g, "")
      .trim();
    if (!content) {
      logErr("[qzone] 文案为空，跳过");
      return true; // 空文案不回滚配额，避免每 5 分钟重试
    }
    if (content === "[[skip]]") {
      log("[qzone] 今天没有值得发的，跳过");
      return true;
    }
    if (content.length > 300) content = content.slice(0, 300);

    if (CFG.qzoneDryRun) {
      await sendPrivate(
        admin,
        `【说说演练】没发到空间，先给你看文案：\n———\n${content}\n———\n觉得行就把 QZONE_DRY_RUN 设成 0`
      );
      log(`[qzone] 演练模式，未发布（${content.length} 字）：${content.slice(0, 40)}`);
      return true;
    }

    const data = await callApi("send_qzone_msg", {
      content,
      images: [],
      ugc_right: CFG.qzoneRight,
      target_uins: [],
    });
    log(`[qzone] 已发布 tid=${data?.tid ?? "?"} 可见范围=${CFG.qzoneRight}`);
    await sendPrivate(admin, `说说发出去了～\n${content}`);
    appendChatLog(admin, "assistant", `（我在空间发了条说说）${content}`);
    return true;
  } catch (e) {
    logErr(`[qzone] 发布失败: ${String(e.message).slice(0, 200)}`);
    try {
      await sendPrivate(admin, `说说这次没发成（${String(e.message).slice(0, 80)}）`);
    } catch {}
    return false;
  } finally {
    qzoneBusy = false;
  }
}

/** 每 5 分钟检查一次：该不该主动开口 / 该不该发说说 */
function scheduleTick() {
  const now = new Date();
  const day = dayKey(now);
  const st = loadSchedule();

  // —— 主动消息 ——
  if (CFG.proactiveEnabled) {
    const p = st.proactive ?? {};
    const count = p.day === day ? Number(p.count) || 0 : 0;
    const lastAt = Number(p.lastAt) || 0;
    const nextGapH = Number(p.nextGapH) || randBetween(CFG.proactiveMinGapHours, CFG.proactiveMaxGapHours);

    // 换天了：重置计数并重新抽一个间隔
    if (p.day !== day) {
      st.proactive = { day, count, lastAt, nextGapH };
      saveSchedule(st);
    }

    if (!inQuietHours(now.getHours()) && count < CFG.proactiveDailyMax) {
      const elapsedH = lastAt ? (Date.now() - lastAt) / 3_600_000 : Infinity;
      if (elapsedH >= nextGapH) {
        st.proactive = {
          day,
          count: count + 1,
          lastAt: Date.now(),
          nextGapH: randBetween(CFG.proactiveMinGapHours, CFG.proactiveMaxGapHours),
        };
        saveSchedule(st);
        const why = elapsedH === Infinity ? "今天还没说过话" : `距上次 ${elapsedH.toFixed(1)} 小时`;
        // F-01（2026-10-22）：执行异常失败 → 回滚配额（runProactive 返回 false）
        runProactive(why).then((ok) => { if (ok === false) rollbackQuota("proactive", day); });
      }
    }
  }

  // —— 自动说说 ——
  if (CFG.qzoneEnabled) {
    const q = st.qzone ?? {};
    if (q.day !== day) {
      // 新的一天：在 [start, end] 小时区间里随机挑一个时刻
      const hour = randBetween(CFG.qzoneHourStart, CFG.qzoneHourEnd + 1);
      const midnight = new Date(now);
      midnight.setHours(0, 0, 0, 0);
      const planAt = midnight.getTime() + Math.round(hour * 3_600_000);
      st.qzone = { day, count: 0, planAt };
      saveSchedule(st);
      log(`[qzone] 今天计划在 ${new Date(planAt).toLocaleString("zh-CN", { hour12: false })} 发`);
    } else if (Number(q.count) < CFG.qzoneDailyTimes && q.planAt && Date.now() >= Number(q.planAt)) {
      // 2026-10-20 修：**演练不该消耗真发配额**。
      // 昨天（10-19）我为了演示手动触发了一次演练，count 被 +1，
      // 结果 20:49 真正到点时 `1 < 1` 为 false，当天一条都没发出去。
      // 现在只有「真的发布」才递增 count。
      const counted = CFG.qzoneDryRun ? Number(q.count) || 0 : (Number(q.count) || 0) + 1;
      st.qzone = { ...q, count: counted, planAt: null };
      saveSchedule(st);
      // F-01（2026-10-22）：发布异常失败 → 回滚配额（演练/空文案返回 true，不回滚）
      runQzone("到计划时间").then((ok) => { if (ok === false) rollbackQuota("qzone", day); });
    }
  }

  // —— 自动写日记 ——
  if (CFG.diaryEnabled) {
    const d = st.diary ?? {};
    if (d.day !== day) {
      const hour = randBetween(CFG.diaryHourStart, CFG.diaryHourEnd + 1);
      const midnight = new Date(now);
      midnight.setHours(0, 0, 0, 0);
      const planAt = midnight.getTime() + Math.round(hour * 3_600_000);
      st.diary = { day, count: 0, planAt };
      saveSchedule(st);
      log(`[diary] 今天计划在 ${new Date(planAt).toLocaleString("zh-CN", { hour12: false })} 写`);
    } else if (!Number(d.count) && d.planAt && Date.now() >= Number(d.planAt)) {
      st.diary = { ...d, count: 1, planAt: null };
      saveSchedule(st);
      // F-01（2026-10-22）：自动写失败 → 回滚配额（30 分钟后重试，最多 2 次）
      runDiaryScheduled().then((ok) => { if (ok === false) rollbackQuota("diary", day); });
    }
  }

  // —— 每周话题摘要（2026-10-26 P1-2）——
  // 只在指定那一天写一次（默认周日 9~11 点随机）。和日记同一个「先扣配额后执行」模型，
  // 失败走同一套 rollbackQuota（30 分钟后重试，最多 2 次），不另造一套。
  if (CFG.weeklyEnabled) {
    const w = st.weekly ?? {};
    const isWeeklyDay = now.getDay() === CFG.weeklyDay;
    if (isWeeklyDay && w.day !== day) {
      const hour = randBetween(CFG.weeklyHourStart, CFG.weeklyHourEnd + 1);
      const midnight = new Date(now);
      midnight.setHours(0, 0, 0, 0);
      const planAt = midnight.getTime() + Math.round(hour * 3_600_000);
      st.weekly = { day, count: 0, planAt };
      saveSchedule(st);
      log(`[weekly] 今天计划在 ${new Date(planAt).toLocaleString("zh-CN", { hour12: false })} 写周回顾`);
    } else if (isWeeklyDay && !Number(w.count) && w.planAt && Date.now() >= Number(w.planAt)) {
      st.weekly = { ...w, count: 1, planAt: null };
      saveSchedule(st);
      runWeeklyScheduled().then((ok) => { if (ok === false) rollbackQuota("weekly", day); });
    } else if (!isWeeklyDay && w.planAt) {
      // 过了那一天还没跑（比如正好服务器重启错过窗口）就作废，别留到下周日再补
      st.weekly = { ...w, planAt: null };
      saveSchedule(st);
    }
  }
}

const override = settingsOverridePath();
if (override) {
  logErr(`[cfg] ⚠️ 发现 ${override} 里有 agent-default-model 段，它的优先级高于 --patch，会盖掉 model.json。`);
  logErr(`[cfg]    要么删掉那一段，要么把模型改到那里（会影响所有 profile）。`);
}

// 跨重启记忆：从 chatlog 回填近窗 + 昨日日记（PLAN-histories.md 的 B 方案）。
// 必须放在 connect() 之前 —— 第一条消息进来时就该记得昨晚聊到哪了。
restoreHistories();

connect();

// 收歌回传：笔记本渲染完把 mp3 丢进 svc-outbox/，这里每 5 秒看一次
if (CFG.svcOutboxDir) {
  setInterval(pollSvcOutbox, CFG.svcPollMs).unref?.();
}

// 调度器：启动 1 分钟后先跑一次（接管上次运行留下的状态），之后每 5 分钟一次
if (CFG.proactiveEnabled || CFG.qzoneEnabled || CFG.diaryEnabled || CFG.weeklyEnabled) {
  setTimeout(scheduleTick, 60_000);
  setInterval(scheduleTick, SCHED_TICK_MS).unref?.();
}

// 调试参数（--test-ask 等）会自己发请求，且和 selfCheck 共用 .run/model-overlay.yml ——
// 2026-10-21 实测两者并发时会互相覆盖，日志里冒出假的 `NO_ADAPTER: __bridge_probe__`，
// 把真实结论搅浑。所以调试时不起 selfCheck。
// ⚠️ 2026-10-26 又踩了一次：原先只列 3 个参数，新增 `--test-weekly-run` 时忘了加，
// 结果 selfCheck 先把 overlay 写成探针 → 周回顾那次真实调用报
// `NO_ADAPTER: no adapter registered for provider "__bridge_probe__"`，看起来像「模型坏了」，
// 实际是「跑的根本不是模型，是探针」。
// 教训：**凡是「会真调一次模型」的调试参数，都必须进这张表**。以后加调试入口先看这里。
const DEBUG_ARG = process.argv.some((a) =>
  [
    "--test-ask",
    "--test-sniff",
    "--test-fix",
    "--test-weekly-run",
    "--test-recall",
    "--test-weekly",
    "--test-imagegen",
    // --dump-prompt / --selftest 也登记：它们不调模型，但登记了不影响行为，
    // 而「所有入口都必须在名单里」这条规则要能被一条断言无例外地检查。
    "--dump-prompt",
    "--selftest",
  ].includes(a)
);
if (CFG.backend === "dsh" && CFG.selfCheck && !DEBUG_ARG) {
  enqueue(() => selfCheck());
}

// 2026-10-24：配置守卫检查（人设/模型有没有被别人改掉）。
// 用 CONFIG_GUARD=0 关掉；放在 selfCheck 之后排，避免和它抢同一份 overlay。
if (CFG.configGuard && !DEBUG_ARG) {
  enqueue(() => checkConfigGuard());
}
