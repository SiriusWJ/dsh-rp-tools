/**
 * 测试用的合成 PNG 卡构造器。
 *
 * 为什么手写 chunk 而不用现成图片：角色卡解码的坑全在**字节层**（`ccv3` 优先、
 * iTXt 的压缩标志、zTXt、截断容错），喂一张真图测不到这些分支。
 * 两个冒烟测试（smoke-card / smoke-dm）都要造卡，所以抽到这一处，
 * 免得第二份副本慢慢跟第一份走散。
 */
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function textChunk(keyword, text) {
  return chunk('tEXt', Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(text, 'latin1')]));
}

export function iTXtChunk(keyword, text, { compressed = false } = {}) {
  const payload = compressed ? deflateSync(Buffer.from(text, 'utf8')) : Buffer.from(text, 'utf8');
  return chunk('iTXt', Buffer.concat([
    Buffer.from(keyword, 'latin1'), Buffer.from([0]),
    Buffer.from([compressed ? 1 : 0, 0]),      // flag, method
    Buffer.from([0]),                           // lang 空
    Buffer.from([0]),                           // translated 空
    payload,
  ]));
}

export function zTXtChunk(keyword, text) {
  return chunk('zTXt', Buffer.concat([
    Buffer.from(keyword, 'latin1'), Buffer.from([0, 0]), deflateSync(Buffer.from(text, 'utf8')),
  ]));
}

export function makePng(chunks) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), ...chunks, chunk('IEND', Buffer.alloc(0))]);
}

/**
 * 造一张**真的** RGBA 图（带 IDAT 像素数据）。
 *
 * `simpleCardPng` 那种卡只塞文本块、没有像素 —— 测缩略图时必须用这个，
 * 否则「解码 → 降采样 → 重编码」整条路根本没被走到。
 *
 * @param w 宽
 * @param h 高
 * @param fill (x, y) => [r, g, b, a?]
 * @returns 8bit RGBA、非隔行、每行 filter 0 的 PNG
 */
export function imagePng(w, h, fill) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * (stride + 1)] = 0;                      // filter type 0
    for (let x = 0; x < w; x += 1) {
      const [r, g, b, a = 255] = fill(x, y) ?? [0, 0, 0, 255];
      const at = y * (stride + 1) + 1 + x * 4;
      raw[at] = r; raw[at + 1] = g; raw[at + 2] = b; raw[at + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;                          // 8bit RGBA
  return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** 带卡数据的真图（预览/卡面路由的测试用）：在 IHDR 后面插文本块。 */
export function cardImagePng(name, w = 64, h = 64, extra = {}) {
  const img = imagePng(w, h, (x, y) => [
    Math.round(x * (255 / Math.max(1, w - 1))),
    Math.round(y * (255 / Math.max(1, h - 1))),
    128, 255,
  ]);
  const afterIhdr = 8 + 25;                          // 签名(8) + IHDR 块(4+4+13+4)
  return Buffer.concat([
    img.subarray(0, afterIhdr),
    textChunk('ccv3', card({ name, ...extra }, 'chara_card_v3')),
    img.subarray(afterIhdr),
  ]);
}

/** 把卡对象编成 PNG 文本块里的 base64。`spec` 传 null 得到 v1 形状（字段铺在顶层）。 */
export function card(data, spec = 'chara_card_v2') {
  return Buffer.from(JSON.stringify(spec ? { spec, data } : data), 'utf8').toString('base64');
}

/** 一张最省事的可用卡（测试里只关心「能列出来 / 能解析 / 能导入」时用）。 */
export function simpleCardPng(name, extra = {}) {
  return makePng([textChunk('ccv3', card({ name, ...extra }, 'chara_card_v3'))]);
}
