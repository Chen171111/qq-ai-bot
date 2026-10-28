/**
 * Sec-MS-GEC token 生成器 —— edge-tts `drm.py` 的纯 JS 移植（BigInt 直译）。
 *
 * ── 为什么移植（2026-10-18）─────────────────────────────────────────────
 * 原实现靠 spawn Python（vendor/py/gen_token.py）算 token，但本机环境下
 * node 的「管道捕获输出」式 spawn 极不稳定：bridge.log 实测
 *   - 21:40:17 ✓  21:55:14 ✓  21:55:19 ✗  22:38 ✗  22:39 ✗  22:42 ✗/✓
 * 成功率约五成（execFileSync 间歇 EBUSY，疑似杀软/沙箱对 CreateProcess
 * 管道句柄的干扰；stdio:'inherit' 的 spawn 在同一环境却 100% 成功）。
 * token 算法本身是纯整数运算 → 移植后零 spawn、零外部依赖、输出确定，
 * 并可用同一组固定时间戳与 Python 原版逐位比对验证（见
 * vendor/py/test_token_ticks.py）。
 *
 * ── 算法来源────────────────────────────────────────────────────────────
 * vendor/py/edge_tts/drm.py（edge-tts 7.3.1）generate_sec_ms_gec_v2()：
 *   魔改 SHA-256（自定义初始状态/第 14 轮常量/σ 调整）+ 自定义 CS64 摘要，
 *   输入 = f"{windows_ticks}{TRUSTED_CLIENT_TOKEN}"，输出 "<16hex>-<64hex>"。
 *   本文件与 drm.py 逐函数对应；**改算法必须先改 Python 侧，再同步这里**，
 *   并用 test_token_ticks.py 比对确认。
 *
 * 用法：
 *   import { generateSecMsGec } from "./ms-gec.mjs";
 *   generateSecMsGec(Date.now() / 1000);  // → "XXXXXXXX-YYYY…"（80 字符）
 */

const MASK = 0xffffffffn;

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const WIN_EPOCH = 11644473600; // drm.py: WIN_EPOCH（Unix → Windows 纪元秒差）

// drm.py: _SHA256_INITIAL（标准 SHA-256 初始哈希值）
const SHA256_INITIAL = [
  0x6a09e667n, 0xbb67ae85n, 0x3c6ef372n, 0xa54ff53an,
  0x510e527fn, 0x9b05688cn, 0x1f83d9abn, 0x5be0cd19n,
];

// drm.py: _SHA256_STATE（首块的起始工作寄存器，非标准）
const SHA256_STATE = [
  0xfd9fbea2n, 0x91243ce7n, 0xbe499094n, 0xcd2e1e0an,
  0x6c006f49n, 0x04bd35abn, 0xfeb0a7e4n, 0x03effbd2n,
];

// drm.py: _SHA256_SCHEDULE（前 14 个消息扩展字的预置值）
const SHA256_SCHEDULE = [
  0xeb24bf9en, 0x1558691fn, 0xa0c09ee2n, 0x0cfa32ban,
  0xa622ee8cn, 0xd1dd9491n, 0xc0dd25a0n, 0xf9e70ab6n,
  0xf0c31573n, 0x7058ce4en, 0x7188e606n, 0x00e5ab33n,
  0xd258b060n, 0x72766564n,
];

// drm.py: _SHA256_ROUND_CONSTANTS（标准 SHA-256 K 常量，64 个）
const SHA256_ROUND_CONSTANTS = [
  0x428a2f98n, 0x71374491n, 0xb5c0fbcfn, 0xe9b5dba5n, 0x3956c25bn, 0x59f111f1n, 0x923f82a4n, 0xab1c5ed5n,
  0xd807aa98n, 0x12835b01n, 0x243185ben, 0x550c7dc3n, 0x72be5d74n, 0x80deb1fen, 0x9bdc06a7n, 0xc19bf174n,
  0xe49b69c1n, 0xefbe4786n, 0x0fc19dc6n, 0x240ca1ccn, 0x2de92c6fn, 0x4a7484aan, 0x5cb0a9dcn, 0x76f988dan,
  0x983e5152n, 0xa831c66dn, 0xb00327c8n, 0xbf597fc7n, 0xc6e00bf3n, 0xd5a79147n, 0x06ca6351n, 0x14292967n,
  0x27b70a85n, 0x2e1b2138n, 0x4d2c6dfcn, 0x53380d13n, 0x650a7354n, 0x766a0abbn, 0x81c2c92en, 0x92722c85n,
  0xa2bfe8a1n, 0xa81a664bn, 0xc24b8b70n, 0xc76c51a3n, 0xd192e819n, 0xd6990624n, 0xf40e3585n, 0x106aa070n,
  0x19a4c116n, 0x1e376c08n, 0x2748774cn, 0x34b0bcb5n, 0x391c0cb3n, 0x4ed8aa4an, 0x5b9cca4fn, 0x682e6ff3n,
  0x748f82een, 0x78a5636fn, 0x84c87814n, 0x8cc70208n, 0x90befffan, 0xa4506cebn, 0xbef9a3f7n, 0xc67178f2n,
];

// drm.py: _SHA256_BLOCK_CONSTANTS —— 第 14 个轮常量被替换为 _SHA256_ADJUSTMENT
const SHA256_ADJUSTMENT = 0xc9dc06a7n;
const SHA256_BLOCK_CONSTANTS = [
  ...SHA256_ROUND_CONSTANTS.slice(0, 14),
  SHA256_ADJUSTMENT,
  ...SHA256_ROUND_CONSTANTS.slice(15),
];

// drm.py: _SHA256_SIGMA0_ADJUSTMENT / _SHA256_SIGMA1_ADJUSTMENT
const SHA256_SIGMA0_ADJUSTMENT = 0x059c0b80n;
const SHA256_SIGMA1_ADJUSTMENT = 0x000b92c0n;

// drm.py: _CS64_COEFFICIENTS（14 组 (系数, 偏移)）
const CS64_COEFFICIENTS = [
  [0xe82e91b1n, 0xb32700d0n], [0x44de24c6n, 0x88dff51dn], [0x3beb65bcn, 0x29514038n], [0xc89c5933n, 0xb328cbdfn],
  [0x8d1ec211n, 0xd405b4d5n], [0x314ef5d5n, 0x26e55f3cn], [0xe92491b1n, 0x607801c6n], [0xf0a5b9d5n, 0x82b2c1fbn],
  [0x06064cf3n, 0xfa51a3dan], [0xda79fa60n, 0x207cc464n], [0xbed20560n, 0x3c3c74f3n], [0x89f9c9f8n, 0xd2d14b61n],
  [0x35fa38c6n, 0xbb04a2c1n], [0xcb49e3c6n, 0xc5626167n],
];
const CS64_FACTOR = 0x82893933n;
const CS64_ADJUSTMENT0 = 0xf2f90b1an;
const CS64_ADJUSTMENT1 = 0x0b1a0000n;

/** drm.py: _rol16 —— 32 位值循环左移 16 位 */
function rol16(value) {
  return ((value << 16n) | (value >> 16n)) & MASK;
}

/** drm.py: _sigma0 —— SHA-256 小 σ0（移位组合后统一掩码，等价标准 σ0） */
function sigma0(value) {
  return ((value >> 7n) ^ (value << 25n) ^ (value >> 18n) ^ (value << 14n) ^ (value >> 3n)) & MASK;
}

/** drm.py: _sigma1 —— SHA-256 小 σ1 */
function sigma1(value) {
  return ((value >> 17n) ^ (value << 15n) ^ (value >> 19n) ^ (value << 13n) ^ (value >> 10n)) & MASK;
}

/**
 * drm.py: _sha256_rounds —— 64 轮压缩，支持从第 first_round 轮中途恢复。
 * first_round === 14 时用改过的轮常量表（_SHA256_BLOCK_CONSTANTS）。
 */
function sha256Rounds(state, words, firstRound = 0) {
  let [a, b, c, d, e, f, g, h] = state;
  const constants = firstRound === 14 ? SHA256_BLOCK_CONSTANTS : SHA256_ROUND_CONSTANTS;
  const aligned = Math.min(64, Math.floor((firstRound + 7) / 8) * 8);

  // drm.py: 逐轮循环（仅 first_round=14 时会走到，处理第 14、15 轮）
  for (let index = firstRound; index < aligned; index++) {
    const rotE = e * 0x100000001n;
    const rotA = a * 0x100000001n;
    const t1 =
      h +
      ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) +
      (g ^ (e & (f ^ g))) +
      constants[index] +
      words[index];
    const t2 = ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((a & b) | (c & (a | b)));
    const newA = (t1 + t2) & MASK;
    const newE = (d + t1) & MASK;
    // Python 元组赋值：b←a, c←b, d←c, f←e, g←f, h←g
    h = g;
    g = f;
    f = e;
    d = c;
    c = b;
    b = a;
    e = newE;
    a = newA;
  }

  // drm.py: 8 轮一组的展开循环（省掉每轮后的寄存器重命名）
  for (let index = aligned; index < 64; index += 8) {
    {
      const rotE = e * 0x100000001n;
      const rotA = a * 0x100000001n;
      const t1 =
        h +
        ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) +
        (g ^ (e & (f ^ g))) +
        constants[index] +
        words[index];
      d = (d + t1) & MASK;
      h =
        (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((a & b) | (c & (a | b)))) &
        MASK;
    }
    {
      const rotE = d * 0x100000001n;
      const rotA = h * 0x100000001n;
      const t1 =
        g +
        ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) +
        (f ^ (d & (e ^ f))) +
        constants[index + 1] +
        words[index + 1];
      c = (c + t1) & MASK;
      g =
        (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((h & a) | (b & (h | a)))) &
        MASK;
    }
    {
      const rotE = c * 0x100000001n;
      const rotA = g * 0x100000001n;
      const t1 =
        f +
        ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) +
        (e ^ (c & (d ^ e))) +
        constants[index + 2] +
        words[index + 2];
      b = (b + t1) & MASK;
      f =
        (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((g & h) | (a & (g | h)))) &
        MASK;
    }
    {
      const rotE = b * 0x100000001n;
      const rotA = f * 0x100000001n;
      const t1 =
        e +
        ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) +
        (d ^ (b & (c ^ d))) +
        constants[index + 3] +
        words[index + 3];
      a = (a + t1) & MASK;
      e =
        (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((f & g) | (h & (f | g)))) &
        MASK;
    }
    {
      const rotE = a * 0x100000001n;
      const rotA = e * 0x100000001n;
      const t1 =
        d +
        ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) +
        (c ^ (a & (b ^ c))) +
        constants[index + 4] +
        words[index + 4];
      h = (h + t1) & MASK;
      d =
        (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((e & f) | (g & (e | f)))) &
        MASK;
    }
    {
      const rotE = h * 0x100000001n;
      const rotA = d * 0x100000001n;
      const t1 =
        c +
        ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) +
        (b ^ (h & (a ^ b))) +
        constants[index + 5] +
        words[index + 5];
      g = (g + t1) & MASK;
      c =
        (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((d & e) | (f & (d | e)))) &
        MASK;
    }
    {
      const rotE = g * 0x100000001n;
      const rotA = c * 0x100000001n;
      const t1 =
        b +
        ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) +
        (a ^ (g & (h ^ a))) +
        constants[index + 6] +
        words[index + 6];
      f = (f + t1) & MASK;
      b =
        (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((c & d) | (e & (c | d)))) &
        MASK;
    }
    {
      const rotE = f * 0x100000001n;
      const rotA = b * 0x100000001n;
      const t1 =
        a +
        ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) +
        (h ^ (f & (g ^ h))) +
        constants[index + 7] +
        words[index + 7];
      e = (e + t1) & MASK;
      a =
        (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((b & c) | (d & (b | c)))) &
        MASK;
    }
  }
  return [a, b, c, d, e, f, g, h];
}

/** drm.py: _expand_sha256_schedule —— 消息扩展（words 从 16 扩到 64，原地追加） */
function expandSha256Schedule(words, firstWord = 16) {
  for (let index = firstWord; index < 64; index++) {
    const x = words[index - 2];
    const y = words[index - 15];
    const s1 = (x >> 17n) ^ (x << 15n) ^ (x >> 19n) ^ (x << 13n) ^ (x >> 10n);
    const s0 = (y >> 7n) ^ (y << 25n) ^ (y >> 18n) ^ (y << 14n) ^ (y >> 3n);
    words.push((s1 + words[index - 7] + s0 + words[index - 16]) & MASK);
  }
}

/**
 * drm.py: _sha256_init —— 由 token 数据前 7 字节算出首块起始状态。
 * 14 个零字 + data[:3] + data[3:7]，再按魔改规则扩展到 64 字，
 * 从第 14 轮起跑（用 _SHA256_BLOCK_CONSTANTS），最后叠加标准初始值。
 */
function sha256Init(data) {
  const words = new Array(14).fill(0n);
  words.push(BigInt(data.readUIntBE(0, 3)));
  words.push(BigInt(data.readUInt32BE(3)));
  for (let index = 16; index < 30; index++) {
    let value = SHA256_SCHEDULE[index - 16];
    if (index - 2 >= 14) {
      value +=
        index === 16
          ? sigma1(words[index - 2]) ^ SHA256_SIGMA1_ADJUSTMENT
          : sigma1(words[index - 2]);
    }
    if (index - 7 >= 14) value += words[index - 7];
    if (index - 15 >= 14) {
      value +=
        index === 29
          ? sigma0(words[index - 15]) ^ SHA256_SIGMA0_ADJUSTMENT
          : sigma0(words[index - 15]);
    }
    words.push(value & MASK);
  }
  words.push(
    (sigma1(words[28]) +
      words[23] +
      sigma0(words[15]) +
      words[14] +
      SHA256_ADJUSTMENT -
      SHA256_ROUND_CONSTANTS[14]) &
      MASK,
  );
  expandSha256Schedule(words, 31);
  const working = sha256Rounds(SHA256_STATE, words, 14);
  return SHA256_INITIAL.map((x, i) => (x + working[i]) & MASK);
}

/** drm.py: _sha256_digest —— 魔改 SHA-256 摘要（32 字节） */
function sha256Digest(data) {
  if (data.length < 7) throw new Error("Token salt must contain at least seven bytes");
  const length = 57 + data.length;
  // Python 的 % 对负数返回非负，BigInt 的 % 保留符号 —— 这里手动归一
  const padZeros = ((55 - length) % 64 + 64) % 64;
  const padded = Buffer.concat([
    data.subarray(7),
    Buffer.from([0x80]),
    Buffer.alloc(padZeros),
  ]);
  const lenBuf = Buffer.alloc(8);
  lenBuf.writeBigUInt64BE(BigInt(length) * 8n);
  const full = Buffer.concat([padded, lenBuf]);

  let state = sha256Init(data.subarray(0, 7));
  for (let offset = 0; offset < full.length; offset += 64) {
    const words = [];
    for (let i = 0; i < 16; i++) words.push(BigInt(full.readUInt32BE(offset + i * 4)));
    expandSha256Schedule(words);
    const working = sha256Rounds(state, words);
    state = state.map((x, i) => (x + working[i]) & MASK);
  }
  const out = Buffer.alloc(32);
  state.forEach((x, i) => out.writeUInt32BE(Number(x), i * 4));
  return out;
}

/** drm.py: _words_le4_even —— 小端 32 位字拆分，补零到偶数个 */
function wordsLe4Even(data) {
  const pad = (4 - (data.length % 4)) % 4;
  const padded = Buffer.concat([data, Buffer.alloc(pad)]);
  const words = [];
  for (let i = 0; i < padded.length / 4; i++) {
    words.push(BigInt(padded.readUInt32LE(i * 4)));
  }
  if (words.length % 2) words.push(0n);
  return words;
}

/** drm.py: _cs64_digest —— 自定义 CS64 摘要，返回两个 32 位字 */
function cs64Digest(data, digest) {
  let keyA = BigInt(digest.readUInt32LE(0)) | 1n;
  let keyB = BigInt(digest.readUInt32LE(4)) | 1n;
  const factors = [(keyA * CS64_FACTOR) & MASK, (keyB * CS64_FACTOR) & MASK];

  const terms = [];
  const offsets = [];
  CS64_COEFFICIENTS.forEach(([coefficient, offset], index) => {
    terms.push((coefficient * factors[index % 2]) & MASK);
    offsets.push(offset);
  });

  wordsLe4Even(Buffer.concat([Buffer.from([0]), data])).forEach((word, index) => {
    let term = word * (index % 2 === 0 ? keyA : keyB);
    let offset = rol16(word) * (index % 2 === 0 ? 0xef0569fbn : 0xc31713dbn);
    if (index === 0) {
      term += CS64_ADJUSTMENT0 * factors[0];
      offset += CS64_ADJUSTMENT1;
    }
    terms.push(term & MASK);
    offsets.push(offset & MASK);
  });

  let swapAcc = 0n;
  let swapLast = 0n;
  let state = 0n;
  let acc = 0n;
  for (let index = 0; index + 1 < terms.length; index += 2) {
    const x = terms[index];
    const y = terms[index + 1];
    let t = rol16((offsets[index] + x) & MASK);
    let q = (t * 0x76f50f34n) & MASK;
    swapAcc += (rol16(q) * 0xc3efea97n + q) & MASK;
    t = rol16((offsets[index + 1] + y) & MASK);
    q = (t * 0x1881ce3cn) & MASK;
    swapLast = (rol16(q) * 0x35bd1ec9n + q) & MASK;
    swapAcc = (swapAcc + swapLast) & MASK;

    state = (state * keyA + x) & MASK;
    state = (rol16(state) * 0xcf98b111n) & MASK;
    state = (rol16(state) * 0x87085b9fn) & MASK;
    state = (rol16(state) * 0x12ceb96dn) & MASK;
    state = (rol16(state) * 0x257e1d83n) & MASK;
    acc += state;
    t = (state * keyB + y) & MASK;
    t = (rol16(t) * 0xa27416f5n) & MASK;
    t = (rol16(t) * 0xd38396ffn) & MASK;
    state = (rol16((rol16(t) * 0x7c932b89n) & MASK) * 0xbfa49f69n) & MASK;
    acc = (acc + state) & MASK;
  }
  return [swapLast ^ state, swapAcc ^ acc];
}

/** drm.py: _token_hash —— 返回 [cs64hex(16), sha256hex(64)]（均大写） */
function tokenHash(data) {
  const digest = sha256Digest(data);
  const [csA, csB] = cs64Digest(data, digest);
  const csBuf = Buffer.alloc(8);
  csBuf.writeUInt32LE(Number(csA), 0);
  csBuf.writeUInt32LE(Number(csB), 4);
  return [csBuf.toString("hex").toUpperCase(), digest.toString("hex").toUpperCase()];
}

/**
 * drm.py: generate_sec_ms_gec_v2 —— 生成 Sec-MS-GEC token。
 * @param {number} unixTimestamp Unix 秒（可带小数）；不传则取当前时间
 * @returns {string} "<16hex>-<64hex>"
 */
export function generateSecMsGec(unixTimestamp = Date.now() / 1000) {
  let ticks = Number(unixTimestamp) + WIN_EPOCH;
  ticks -= ticks % 300; // 对齐到 300 秒窗口
  ticks *= 1e7; // 秒 → 100ns 刻度（Windows file time）
  const strToHash = Buffer.from(`${ticks.toFixed(0)}${TRUSTED_CLIENT_TOKEN}`, "ascii");
  const [cs64, sha256] = tokenHash(strToHash);
  return `${cs64}-${sha256}`;
}
