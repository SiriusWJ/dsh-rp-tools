/**
 * 极小的 ZIP 读写（**只支持 STORE，即不压缩**，只用 node:zlib 之外的零依赖手段）。
 *
 * 为什么自己写：这个插件的依赖面刻意保持为零（PNG 解码/编码都是手写的）。
 * 而 STORE-only 的 zip 格式简单到可以放心手写：
 *   [本地文件头 + 原始数据] × N  →  [中央目录]  →  [EOCD]
 *
 * 为什么用 STORE 而不是 deflate：包里装的本来就是 PNG（已经压过一轮），再 deflate 一遍
 * 收益个位数百分比，却要多写压缩流、CRC 与「压缩后大小」两套字段。宁可包大一点。
 *
 * ⚠️ **解包是攻击面**：条目名可能带 `../` 或用绝对路径（zip-slip），让写入落到会话目录之外。
 * 所以 `readZip()` 只负责解析，**落盘前必须过 `safeEntryName()`**（调用方 `session-bundle.js` 用它）。
 */

import { crc32 } from './crc32.js';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
/** zip 的「文件名是 UTF-8」标志位（通用位标记第 11 位）。中文名不加这个会被按 CP437 解成乱码。 */
const FLAG_UTF8 = 0x0800;
/** 单个包的大小上限：会话包实测几 MB，留足余量但挡住「有人塞了个 2GB 的东西进来」。 */
export const ZIP_MAX_BYTES = 256 * 1024 * 1024;

/**
 * 条目名安全化：拒绝绝对路径、盘符、`..`、以及任何反斜杠写法。
 *
 * 返回规范化后的相对路径（用 `/` 分隔），不合法返回 `null`。
 * **不要**靠 `replace('../','')` 这种清洗 —— `....//` 之类的变体会绕过，必须**逐段判定**。
 */
export function safeEntryName(name) {
  const raw = String(name ?? '').trim();
  if (!raw) return null;
  if (raw.startsWith('/') || raw.startsWith('\\')) return null;
  if (/^[A-Za-z]:/.test(raw)) return null;                 // C:\... / C:/...
  const parts = raw.split(/[\\/]+/).filter((s) => s && s !== '.');
  if (!parts.length) return null;
  for (const p of parts) {
    if (p === '..') return null;
    if (p.includes('\u0000')) return null;
  }
  const joined = parts.join('/');
  return joined.length > 512 ? null : joined;
}

/**
 * 打一个 STORE-only 的 zip。
 *
 * @param entries `[{ name, data }]`，name 用 `/` 分隔
 * @param mtime   统一的时间戳（DOS 时间；不给就用当前时间）。写成固定值便于测试与去重。
 * @returns {Buffer}
 */
export function writeZip(entries, mtime = new Date()) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries ?? []) {
    const name = safeEntryName(entry?.name);
    if (!name) throw new Error(`zip: 条目名不合法（不能是绝对路径或含 ..）：${entry?.name}`);
    const data = Buffer.isBuffer(entry?.data) ? entry.data : Buffer.from(entry?.data ?? '');
    const nameBuf = Buffer.from(name, 'utf8');
    const sum = crc32(data);
    const dos = dosDateTime(mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);              // 需要 2.0
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(0, 8);               // 压缩方法 0 = STORE
    local.writeUInt16LE(dos.time, 10);
    local.writeUInt16LE(dos.date, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(data.length, 18);    // 压缩后大小 == 原始大小（STORE）
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);              // 无 extra
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4);            // 创建版本
    central.writeUInt16LE(20, 6);            // 需要版本
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dos.time, 12);
    central.writeUInt16LE(dos.date, 14);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);            // extra
    central.writeUInt16LE(0, 32);            // comment
    central.writeUInt16LE(0, 34);            // 磁盘号
    central.writeUInt16LE(0, 36);            // 内部属性
    central.writeUInt32LE(0, 38);            // 外部属性
    central.writeUInt32LE(offset, 42);       // 本地头偏移
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);                  // 本磁盘号
  eocd.writeUInt16LE(0, 6);                  // 中央目录起始磁盘
  eocd.writeUInt16LE(entries?.length ?? 0, 8);
  eocd.writeUInt16LE(entries?.length ?? 0, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);                 // 注释长度

  return Buffer.concat([...locals, centralBuf, eocd]);
}

/**
 * 解一个 STORE-only 的 zip。
 *
 * **只走中央目录**（这是权威来源；本地头可能带数据描述符，偏移不可靠）。
 * 遇到压缩过的条目直接报错而不是给出乱码 —— 「静默给错数据」是这个仓库反复踩过的坑。
 *
 * @returns `[{ name, data }]`
 */
export function readZip(buf) {
  const buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? []);
  if (buffer.length < 22) throw new Error('zip: 文件太小，不是有效的 zip');
  if (buffer.length > ZIP_MAX_BYTES) throw new Error(`zip: 包太大了（${Math.round(buffer.length / 1048576)}MB）`);

  // EOCD 在末尾，注释最长 65535 → 从后往前找签名
  let eocd = -1;
  const from = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= from; i -= 1) {
    if (buffer.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: 找不到中央目录（文件可能被截断）');

  const count = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralAt = buffer.readUInt32LE(eocd + 16);
  if (centralAt + centralSize > buffer.length) throw new Error('zip: 中央目录越界（文件可能被截断）');
  if (count > 20000) throw new Error(`zip: 条目数异常（${count}）`);

  const out = [];
  let at = centralAt;
  for (let i = 0; i < count; i += 1) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== SIG_CENTRAL) {
      throw new Error(`zip: 中央目录第 ${i + 1} 条损坏`);
    }
    const method = buffer.readUInt16LE(at + 10);
    const sum = buffer.readUInt32LE(at + 16);
    const size = buffer.readUInt32LE(at + 24);
    const nameLen = buffer.readUInt16LE(at + 28);
    const extraLen = buffer.readUInt16LE(at + 30);
    const commentLen = buffer.readUInt16LE(at + 32);
    const localAt = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    at += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;                     // 目录条目，跳过
    if (method !== 0) {
      throw new Error(`zip: 「${name}」用了压缩（方法 ${method}），本插件只支持 STORE 包。`
        + '请用「不压缩 / 存储」模式重新打包。');
    }
    if (localAt + 30 > buffer.length || buffer.readUInt32LE(localAt) !== SIG_LOCAL) {
      throw new Error(`zip: 「${name}」的本地头损坏`);
    }
    const lNameLen = buffer.readUInt16LE(localAt + 26);
    const lExtraLen = buffer.readUInt16LE(localAt + 28);
    const dataAt = localAt + 30 + lNameLen + lExtraLen;
    if (dataAt + size > buffer.length) throw new Error(`zip: 「${name}」的数据越界（文件可能被截断）`);
    const data = buffer.subarray(dataAt, dataAt + size);
    const actual = crc32(data);
    if (actual !== sum) {
      throw new Error(`zip: 「${name}」校验和不符（包已损坏，或不是按 STORE 写的）`);
    }
    out.push({ name, data });
  }
  return out;
}

/** JS Date → DOS 日期/时间（zip 用的老格式：秒只有 2 秒精度）。 */
function dosDateTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}
