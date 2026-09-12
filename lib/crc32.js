/**
 * CRC-32（IEEE 802.3，PNG / ZIP 都用这一套多项式）。
 *
 * 单独一个文件是因为**两处都要用**：PNG 的块校验（`png-thumb.js`）与 ZIP 的条目校验（`zip.js`）。
 * 抄成两份迟早会走散（这个仓库已经吃过一次「同一套语义两个入口」的亏），所以只有这一份实现。
 *
 * 表在模块加载时算一次（256 项），之后每次校验就是纯查表 —— 几百 KB 的图/包毫秒级。
 */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

/** 计算 `buf` 的 CRC-32，返回**无符号** 32 位整数（写成 UInt32 用）。 */
export function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export default crc32;
