/**
 * 极小的 PNG 缩略图生成器（**只用 node:zlib**，无第三方依赖）。
 *
 * 为什么需要它：卡库列表要显示角色卡封面。卡 PNG 单张可能几百 KB～数 MB
 * （文本块动辄上百万字），2383 张列表直接给 `<img>` 会把浏览器和后端一起拖死。
 *
 * 设计取舍：
 * - 只支持最常见的 8bit 非隔行扫描、且通道数已知的图（灰度/灰度+A/RGB/RGBA/调色板）。
 *   花哨的（16bit、Adam7 隔行、无 IDAT）一律返回 `null` —— 调用方**回退原图**，
 *   宁可慢一点也不能给出坏图。
 * - 降采样用**整数倍 box 平均**：实现简单、结果稳定，不会引入最近邻的锯齿。
 * - 目标是缩略图，不追求保真：平均色 + 整数倍缩放足够了。
 */

import { deflateSync, inflateSync } from 'node:zlib';
import { crc32 } from './crc32.js';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** 解析出 IHDR / PLTE / IDAT；结构不对或没有像素数据就返回 null。 */
function parsePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 + 12 || !buf.subarray(0, 8).equals(SIG)) return null;
  let at = 8;
  let ihdr = null;
  let plte = null;
  const idats = [];
  while (at + 8 <= buf.length) {
    const len = buf.readUInt32BE(at);
    if (len > buf.length) return null;
    const type = buf.toString('latin1', at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      if (data.length < 13) return null;
      ihdr = {
        w: data.readUInt32BE(0),
        h: data.readUInt32BE(4),
        depth: data[8],
        color: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === 'PLTE') {
      plte = Buffer.from(data);
    } else if (type === 'IDAT') {
      idats.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + len;
  }
  if (!ihdr || !idats.length) return null;
  return { ...ihdr, plte, idat: Buffer.concat(idats) };
}

/** 每像素字节数（8bit）；不认识的色彩类型返回 0。 */
function channelsOf(color) {
  switch (color) {
    case 0: return 1;   // 灰度
    case 2: return 3;   // RGB
    case 3: return 1;   // 调色板索引
    case 4: return 2;   // 灰度 + Alpha
    case 6: return 4;   // RGBA
    default: return 0;
  }
}

/** 反滤波（PNG 的 5 种 filter）。任何未知类型都返回 null。 */
function unfilter(raw, w, h, bpp) {
  const stride = w * bpp;
  if (raw.length < (stride + 1) * h) return null;
  const out = Buffer.alloc(stride * h);
  let at = 0;
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y += 1) {
    const ft = raw[at];
    at += 1;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    raw.copy(cur, 0, at, at + stride);
    at += stride;
    if (ft === 0) { prev = cur; continue; }
    for (let i = 0; i < stride; i += 1) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      if (ft === 1) cur[i] = (cur[i] + a) & 0xff;
      else if (ft === 2) cur[i] = (cur[i] + b) & 0xff;
      else if (ft === 3) cur[i] = (cur[i] + ((a + b) >> 1)) & 0xff;
      else if (ft === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
        cur[i] = (cur[i] + pr) & 0xff;
      } else return null;
    }
    prev = cur;
  }
  return out;
}

/** 把像素缓冲编成 PNG（每行 filter 0，够用且实现简单）。 */
function encodePng(px, w, h, ch) {
  const stride = w * ch;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * (stride + 1)] = 0;
    px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const colorType = ch === 1 ? 0 : ch === 2 ? 4 : ch === 3 ? 2 : 6;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * 生成缩略图。
 *
 * @param buf 原始 PNG
 * @param maxWidth 目标最大宽度（整数倍降采样，实际结果 ≤ 它）
 * @returns 缩略图 PNG Buffer；**不支持/不需要时返回 null**（调用方回退原图）
 */
export function makeThumbnail(buf, maxWidth = 160) {
  const png = parsePng(buf);
  if (!png) return null;
  if (png.depth !== 8 || png.interlace !== 0 || png.compression !== 0 || png.filter !== 0) return null;
  const srcCh = channelsOf(png.color);
  if (!srcCh) return null;
  if (png.color === 3 && !png.plte) return null;
  if (!Number.isFinite(png.w) || !Number.isFinite(png.h) || png.w < 1 || png.h < 1 || png.w * png.h > 40e6) return null;
  const factor = Math.max(1, Math.floor(png.w / Math.max(1, Math.floor(maxWidth))));
  if (factor === 1 && png.w <= maxWidth) return null;   // 本来就够小，没必要重编码
  let px;
  try { px = unfilter(inflateSync(png.idat), png.w, png.h, srcCh); } catch { return null; }
  if (!px) return null;

  const outCh = png.color === 3 ? 3 : srcCh;
  const tw = Math.max(1, Math.floor(png.w / factor));
  const th = Math.max(1, Math.floor(png.h / factor));
  const stride = png.w * srcCh;
  const out = Buffer.alloc(tw * th * outCh);
  for (let y = 0; y < th; y += 1) {
    for (let x = 0; x < tw; x += 1) {
      const acc = new Array(outCh).fill(0);
      let n = 0;
      for (let dy = 0; dy < factor; dy += 1) {
        const sy = y * factor + dy;
        if (sy >= png.h) break;
        for (let dx = 0; dx < factor; dx += 1) {
          const sx = x * factor + dx;
          if (sx >= png.w) break;
          const s = sy * stride + sx * srcCh;
          if (png.color === 3) {
            const p = px[s] * 3;
            for (let c = 0; c < 3; c += 1) acc[c] += png.plte[p + c] ?? 0;
          } else {
            for (let c = 0; c < outCh; c += 1) acc[c] += px[s + c];
          }
          n += 1;
        }
      }
      const d = (y * tw + x) * outCh;
      for (let c = 0; c < outCh; c += 1) out[d + c] = n ? Math.round(acc[c] / n) : 0;
    }
  }
  return encodePng(out, tw, th, outCh);
}

/** 从 PNG 里读尺寸（列表不缩放时也要知道比例；读不到返回 null）。 */
export function pngSize(buf) {
  const png = parsePng(buf);
  return png ? { width: png.w, height: png.h } : null;
}

/**
 * 读出像素（供测试与后续可能的用途；不支持的结构返回 null）。
 *
 * 单独导出而不是只留给 `makeThumbnail` 内部用：缩略图对不对**必须能看到真像素**才算验证过
 * （只断言「尺寸变小了」会漏掉「整张图被压成空白色块」这类错）。
 */
export function readPngPixels(buf) {
  const png = parsePng(buf);
  if (!png || png.depth !== 8 || png.interlace !== 0 || png.compression !== 0 || png.filter !== 0) return null;
  const ch = channelsOf(png.color);
  if (!ch || (png.color === 3 && !png.plte)) return null;
  let px;
  try { px = unfilter(inflateSync(png.idat), png.w, png.h, ch); } catch { return null; }
  if (!px) return null;
  // 调色板展开成 RGB，让调用方拿到的总是「真颜色」
  if (png.color === 3) {
    const out = Buffer.alloc(png.w * png.h * 3);
    for (let i = 0; i < png.w * png.h; i += 1) {
      const p = px[i] * 3;
      out[i * 3] = png.plte[p] ?? 0;
      out[i * 3 + 1] = png.plte[p + 1] ?? 0;
      out[i * 3 + 2] = png.plte[p + 2] ?? 0;
    }
    return { width: png.w, height: png.h, channels: 3, pixels: out };
  }
  return { width: png.w, height: png.h, channels: ch, pixels: px };
}
