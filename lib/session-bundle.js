/**
 * 会话包：把一个会话**能带走的一切**打成一个 zip，以及从 zip 还原。
 *
 * 为什么需要：会话配置在 `~/.dsh/data/dsh-rp-tools/sessions/`，而世界书、资源库图、导入卡产物
 * 都在**工作区**的 `rp-sessions/<id>/` 下 —— 两处分离，用户手工备份必然漏一半。
 *
 * 包里装什么（**只装插件自己拥有/使用的文件**，不把用户在会话目录里随手放的东西一起卷进来）：
 *
 * ```
 * MANIFEST.json          格式与版本 / 导出时间 / 原会话 id / 每个文件的 sha256
 * session.json          会话配置（来自全局数据目录）
 * rp-worldbook.md       世界书（可能不存在）
 * assets.json           资源库索引（可能不存在）
 * assets/<分类>/<id>.<ext>   出过的图与导入的图（1.13.0 起真存了一份，所以包是自包含的）
 * cards/<slug>.{md,json,launch.md,png}  导入卡产物（含卡面与开局引导）
 * ```
 *
 * **不装**：`snapshots/`（那是快照自己，套娃没有意义）、ComfyUI 的 `output/`（我们已经有副本）。
 *
 * 安全上只有一条规则：**写盘前每个条目名都过 `safeEntryName()`，落盘时再做一次前缀校验**。
 * zip 是外部输入，`../` 条目名（zip-slip）能让文件落到会话目录之外。
 */

import { readFileSync, readdirSync, existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { writeZip, readZip, safeEntryName } from './zip.js';
import { MAP_FILE, MAP_STATE_FILE } from './rp-map.js';

export const BUNDLE_FORMAT = 'dsh-rp-tools/session-bundle';
export const BUNDLE_VERSION = 1;
/** 会话配置在包里的固定名字（还原时要写到全局数据目录，不是会话目录）。 */
export const BUNDLE_SESSION_FILE = 'session.json';
/** 单个会话包里最多多少个文件（挡住「有人把整个工作区打进来了」）。 */
export const BUNDLE_MAX_FILES = 5000;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** 递归列出目录下的文件，返回相对路径（`/` 分隔）。目录不存在返回空数组。 */
function walkFiles(root, prefix = '') {
  if (!existsSync(root)) return [];
  const out = [];
  for (const name of readdirSync(root)) {
    const abs = join(root, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) {
      if (name === 'snapshots') continue;
      out.push(...walkFiles(abs, rel));
    } else if (st.isFile()) {
      out.push({ rel, abs, bytes: st.size });
    }
    if (out.length > BUNDLE_MAX_FILES) break;
  }
  return out;
}

/**
 * 收集一个会话要打包的文件（不含 `session.json`，那份来自全局数据目录）。
 *
 * @param sessionDir `rp-sessions/<会话 id>/`
 */
export function collectBundleFiles(sessionDir) {
  const files = [];
  // ⚠️ 这份名单是**写死**的：新增任何「会话级文件」都必须加到这里，否则它会从导出与快照里
  // **静默消失**（地图就是这样漏过一次 —— 实测导出包里根本没有 rp-map.json）。
  for (const name of ['rp-worldbook.md', 'assets.json', MAP_FILE, MAP_STATE_FILE]) {
    const abs = join(sessionDir, name);
    if (existsSync(abs) && statSync(abs).isFile()) files.push({ rel: name, abs });
  }
  for (const sub of ['assets', 'cards']) {
    for (const f of walkFiles(join(sessionDir, sub), sub)) files.push({ rel: f.rel, abs: f.abs });
  }
  return files;
}

/**
 * 打一个会话包。
 *
 * @param sessionId     会话 id（写进清单）
 * @param sessionDir    `rp-sessions/<会话 id>/` 的绝对路径
 * @param sessionConfig 会话配置对象（会被原样写进 `session.json`）
 * @param now           时间戳（测试用固定值）
 * @returns `{ buffer, manifest, files }`
 */
export function buildBundle({ sessionId, sessionDir, sessionConfig, now = new Date() }) {
  const collected = collectBundleFiles(sessionDir);
  if (collected.length > BUNDLE_MAX_FILES) {
    throw new Error(`会话包文件太多（${collected.length} > ${BUNDLE_MAX_FILES}）`);
  }
  const entries = [];
  const manifestFiles = [];
  const add = (name, data) => {
    const safe = safeEntryName(name);
    if (!safe) throw new Error(`会话包：条目名不合法：${name}`);
    entries.push({ name: safe, data });
    manifestFiles.push({ name: safe, bytes: data.length, sha256: sha256(data) });
  };

  add(BUNDLE_SESSION_FILE, Buffer.from(`${JSON.stringify(sessionConfig ?? {}, null, 1)}\n`, 'utf8'));
  for (const f of collected) add(f.rel, readFileSync(f.abs));

  const manifest = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: now.toISOString(),
    sessionId: String(sessionId ?? ''),
    files: manifestFiles,
  };
  // 清单放最前面：解包时先看它，能一眼判断「这是不是我们的包」。
  // 注意它**不进清单自己的 files 列表**（清单不是会话内容，是元信息；列进去会变成自指哈希）。
  entries.unshift({ name: 'MANIFEST.json', data: Buffer.from(`${JSON.stringify(manifest, null, 1)}\n`, 'utf8') });

  return { buffer: writeZip(entries, now), manifest, files: entries };
}

/**
 * 解一个会话包。
 *
 * 校验顺序（都失败得**明确**，不静默跳过）：
 *   ① 是 zip 且是 STORE；② 有 MANIFEST 且格式/版本认识；③ 每个条目名安全；
 *   ④ 每个条目的 sha256 与清单一致（挡住「CRC 对但内容被替换/清单被改」）。
 *
 * @returns `{ manifest, sessionConfig, entries, sessionId }`；entries 是安全的相对路径 + bytes
 */
export function parseBundle(buffer) {
  const raw = readZip(buffer);
  const byName = new Map();
  for (const entry of raw) {
    const safe = safeEntryName(entry.name);
    if (!safe) throw new Error(`会话包：条目名不合法（可能是越界路径）：${entry.name}`);
    byName.set(safe, entry.data);
  }

  const manifestBuf = byName.get('MANIFEST.json');
  if (!manifestBuf) throw new Error('这不是本插件的会话包（缺少 MANIFEST.json）');
  let manifest;
  try { manifest = JSON.parse(manifestBuf.toString('utf8')); } catch { throw new Error('会话包：MANIFEST.json 不是合法 JSON'); }
  if (manifest?.format !== BUNDLE_FORMAT) throw new Error(`会话包：格式不认识（${manifest?.format ?? '空'}）`);
  if (Number(manifest.version) > BUNDLE_VERSION) {
    throw new Error(`会话包：版本 ${manifest.version} 比本插件支持的 ${BUNDLE_VERSION} 新，请先升级插件`);
  }

  // 逐条校验 sha256：清单里列了但包里没有、或哈希不符，都要报出来（不静默跳过）
  const checked = new Set();
  for (const f of Array.isArray(manifest.files) ? manifest.files : []) {
    const name = safeEntryName(f?.name);
    if (!name) throw new Error(`会话包：清单里的条目名不合法：${f?.name}`);
    const data = byName.get(name);
    if (!data) throw new Error(`会话包：清单里列了 ${name}，但包里没有这个文件`);
    if (f.sha256 && sha256(data) !== f.sha256) throw new Error(`会话包：${name} 的内容与清单不符（包已损坏或被改过）`);
    checked.add(name);
  }
  for (const name of byName.keys()) {
    if (name !== 'MANIFEST.json' && !checked.has(name)) {
      throw new Error(`会话包：${name} 不在清单里（拒绝来路不明的文件）`);
    }
  }

  const sessionBuf = byName.get(BUNDLE_SESSION_FILE);
  let sessionConfig = null;
  if (sessionBuf) {
    try { sessionConfig = JSON.parse(sessionBuf.toString('utf8')); } catch { throw new Error('会话包：session.json 不是合法 JSON'); }
  }
  const entries = [...byName.entries()]
    .filter(([name]) => name !== 'MANIFEST.json')
    .map(([name, data]) => ({ name, data }));

  return { manifest, sessionConfig, entries, sessionId: String(manifest.sessionId ?? '') };
}

/**
 * 把解出来的条目落到目标会话目录。
 *
 * **只写 `session.json` 之外的条目**（会话配置由调用方写到全局数据目录），并且：
 * 每个目标路径都要 `resolve` 后**前缀校验**，越界一律拒绝 —— 这是防 zip-slip 的第二道锁
 * （第一道是 `safeEntryName`，两道都留着：单点失效不至于直接写穿）。
 */
export function restoreBundleEntries(entries, targetDir, { skip = [BUNDLE_SESSION_FILE] } = {}) {
  const root = String(targetDir ?? '');
  if (!root) throw new Error('会话包：没有目标目录');
  const skipSet = new Set(skip);
  let written = 0;
  let bytes = 0;
  const names = [];
  for (const entry of entries ?? []) {
    const name = safeEntryName(entry?.name);
    // 名字不合法就**报错**而不是跳过：parseBundle 已经挡过一道，能走到这里说明有 bug，
    // 静默跳过会让「还原少了一个文件」变成没人知道的事（这个仓库反复吃过静默的亏）。
    if (!name) throw new Error(`会话包：条目名不合法，拒绝还原：${entry?.name}`);
    if (skipSet.has(name)) continue;
    const abs = join(root, ...name.split('/'));
    if (!abs.startsWith(root.endsWith(sep) ? root : root + sep)) {
      throw new Error(`会话包：拒绝写到会话目录之外：${name}`);
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, entry.data);
    written += 1;
    bytes += entry.data.length;
    names.push(name);
  }
  return { written, bytes, names };
}

export default { buildBundle, parseBundle, collectBundleFiles, restoreBundleEntries, BUNDLE_FORMAT, BUNDLE_VERSION };
