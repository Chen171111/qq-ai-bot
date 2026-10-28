// sse-test.mjs — 确定性验证：SSE 消费器在收到 [DONE] 后是否取消未关闭的响应体
const modPath = process.env.MOD;
if (!modPath) {
  console.error("需要 MOD=openai-compat.js 路径");
  process.exit(2);
}
const { consumeOpenAiSse } = await import(modPath);
const enc = new TextEncoder();

function makeStream(closeAfterDone) {
  let cancelled = false;
  const body = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"收到"}}]}\n\n'));
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      if (closeAfterDone) c.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { body, get cancelled() { return cancelled; } };
}

async function run(closeAfterDone) {
  const s = makeStream(closeAfterDone);
  const response = new Response(s.body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  const chunks = [];
  for await (const ch of consumeOpenAiSse(response, {}, { label: "test", chunkTimeoutMs: 5000, firstTokenTimeoutMs: 5000 })) {
    chunks.push(ch.type);
  }
  await new Promise((r) => setTimeout(r, 50));
  return { chunks, bodyCancelled: s.cancelled };
}

const openEnded = await run(false);
const closedEnd = await run(true);
console.log(JSON.stringify({ openEnded, closedEnd }, null, 2));
