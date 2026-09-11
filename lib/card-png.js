/**
 * PNG 角色卡解码器。
 *
 * 数据藏在 PNG 的**标准文本块**里，三层公开约定（不是加密）：
 *   tEXt/iTXt/zTXt → 键名 `chara`(CCv2) 或 `ccv3`(CCv3) → 值是 base64(UTF-8 JSON)
 *
 * 每一条都来自实测踩坑（见 docs/PNG-CARD-DECODE.md）：
 * 1. **`ccv3` 必须优先** —— 本地卡库 59.8% 是 v3，只读 `chara` 会漏掉一大半；
 * 2. **iTXt 有压缩标志**（结构 `keyword\0 flag method lang\0 translated\0 text`，flag=1 时 text 是 zlib）；
 * 3. **zTXt** 结构是 `keyword\0 method zlib(text)`；
 * 4. **字段摊平**：v1 字段在顶层，v2/v3 在 `data` 下 → 统一 `const d = raw.data ?? raw`；
 * 5. 遍历到 `IEND` 停止，**任何越界都要容错** —— 一张坏图不能崩掉整个工具。
 *
 * 只依赖 `node:zlib`，无第三方依赖。
 */
import { inflateSync } from 'node:zlib';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_TEXT_BYTES = 64 * 1024 * 1024;   // 单块解压上限（防压缩炸弹）

/** 读 4 字节长度；越界返回 -1。 */
function readUInt32(buf, at) {
  if (at + 4 > buf.length) return -1;
  return buf.readUInt32BE(at);
}

/** 在 `\0` 处切分；UTF-8 关键字按 Latin-1 读即可（关键字都是 ASCII）。 */
function splitAtNul(buf, from) {
  const at = buf.indexOf(0, from);
  if (at < 0) return null;
  return { head: buf.toString('latin1', from, at), next: at + 1 };
}

/**
 * 扫描 PNG 文本块。返回 `{ chara?: string, ccv3?: string, warnings: string[] }`
 * —— 值是**已解码的文本**（base64 还未解开）。
 */
export function readPngTextChunks(buffer) {
  const out = { warnings: [] };
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) {
    out.warnings.push('文件太小或不是 Buffer');
    return out;
  }
  if (!buffer.subarray(0, 8).equals(PNG_SIG)) {
    out.warnings.push('不是 PNG（签名不符）');
    return out;
  }

  let at = 8;
  while (at + 8 <= buffer.length) {
    const len = readUInt32(buffer, at);
    if (len < 0) { out.warnings.push('块长度越界，停止扫描'); break; }
    const type = buffer.toString('latin1', at + 4, at + 8);
    const dataAt = at + 8;
    const dataEnd = dataAt + len;
    if (dataEnd + 4 > buffer.length) { out.warnings.push(`块 ${type} 越界，停止扫描`); break; }
    const data = buffer.subarray(dataAt, dataEnd);

    try {
      if (type === 'tEXt') {
        const s = splitAtNul(data, 0);
        if (s) {
          const key = s.head;
          if (key === 'chara' || key === 'ccv3') out[key] = data.toString('latin1', s.next);
        }
      } else if (type === 'iTXt') {
        // keyword\0 flag(1) method(1) lang\0 translated\0 text
        const s = splitAtNul(data, 0);
        if (s && (s.head === 'chara' || s.head === 'ccv3')) {
          let p = s.next;
          if (p + 2 > data.length) throw new Error('iTXt 头不完整');
          const compressed = data[p] === 1;
          p += 2;                                  // flag + method
          const lang = splitAtNul(data, p);
          if (!lang) throw new Error('iTXt 缺 lang 分隔');
          const trans = splitAtNul(data, lang.next);
          if (!trans) throw new Error('iTXt 缺 translated 分隔');
          let text = data.subarray(trans.next);
          if (compressed) {
            if (text.length > MAX_TEXT_BYTES) throw new Error('iTXt 压缩块过大');
            text = inflateSync(text);
          }
          out[s.head] = text.toString('utf8');
        }
      } else if (type === 'zTXt') {
        const s = splitAtNul(data, 0);
        if (s && (s.head === 'chara' || s.head === 'ccv3')) {
          const p = s.next + 1;                  // 跳过 method
          if (p > data.length) throw new Error('zTXt 头不完整');
          const z = data.subarray(p);
          if (z.length > MAX_TEXT_BYTES) throw new Error('zTXt 压缩块过大');
          out[s.head] = inflateSync(z).toString('utf8');
        }
      }
    } catch (error) {
      out.warnings.push(`块 ${type} 解码失败：${error?.message ?? error}`);
    }

    if (type === 'IEND') break;
    at = dataEnd + 4;                            // 跳过 CRC
  }
  return out;
}

/** base64 → JSON。返回 `{ raw, warnings }`。 */
function decodeCardJson(text) {
  const warnings = [];
  if (typeof text !== 'string' || !text) return { raw: null, warnings };
  let json;
  try {
    // 有些卡的 base64 里混了空白字符
    json = Buffer.from(text.replace(/\s+/g, ''), 'base64').toString('utf8');
  } catch (error) {
    warnings.push(`base64 解码失败：${error?.message ?? error}`);
    return { raw: null, warnings };
  }
  try {
    const raw = JSON.parse(json);
    if (!raw || typeof raw !== 'object') {
      warnings.push('卡数据不是对象');
      return { raw: null, warnings };
    }
    return { raw, warnings };
  } catch (error) {
    warnings.push(`JSON 解析失败（疑似加密卡或截断）：${error?.message ?? error}`);
    return { raw: null, warnings };
  }
}

/** 判断 spec。v1 没有 `spec`，字段直接铺在顶层。 */
function detectSpec(raw) {
  const spec = typeof raw?.spec === 'string' ? raw.spec : '';
  if (spec === 'chara_card_v3') return 'v3';
  if (spec === 'chara_card_v2') return 'v2';
  if (raw?.data && typeof raw.data === 'object') return 'v2';
  return 'v1';
}

/**
 * 解码一张 PNG 角色卡。
 * @returns {{
 *   ok: boolean, kind: 'v1'|'v2'|'v3'|'none', chunk: string|null,
 *   data: object|null, warnings: string[], error?: string
 * }}
 */
export function decodeCardPng(buffer) {
  const chunks = readPngTextChunks(buffer);
  const warnings = [...(chunks.warnings ?? [])];
  // ccv3 优先（v3 卡占多数；两个块都在时取 ccv3）
  const picked = chunks.ccv3 ? { key: 'ccv3', text: chunks.ccv3 }
    : chunks.chara ? { key: 'chara', text: chunks.chara }
      : null;
  if (!picked) {
    return { ok: false, kind: 'none', chunk: null, data: null, warnings, error: '这张 PNG 里没有角色卡数据（纯插图）' };
  }
  const { raw, warnings: w2 } = decodeCardJson(picked.text);
  warnings.push(...w2);
  if (!raw) {
    return { ok: false, kind: 'none', chunk: picked.key, data: null, warnings, error: '卡数据解不开（疑似加密或损坏）' };
  }
  const kind = detectSpec(raw);
  // 字段摊平：v2/v3 在 data 下，v1 在顶层
  const data = raw.data && typeof raw.data === 'object' ? raw.data : raw;
  return { ok: true, kind, chunk: picked.key, data, warnings };
}
