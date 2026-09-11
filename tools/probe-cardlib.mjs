/**
 * 真卡库探针：拿**本机真实的** 3269 张 PNG 卡跑一遍导入链路。
 *
 * 合成 PNG 的冒烟测试只能测分支，测不到真实数据的脾气（几十万字的卡、坏卡、
 * 奇怪的文件名、密码目录）。所以留这个手动工具：不改任何东西，只读 + 往临时目录写。
 *
 * 用法：node tools/probe-cardlib.mjs [每类抽样数，默认 12]
 * 与冒烟测试同一套桩：被测模块从 profile 的 node_modules 解析（lib/index.js 依赖
 * @deepseek-ai/dsh-tools，从仓库路径直接 import 解析不到）。
 */
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

const SAMPLE_PER_CAT = Math.max(1, Number(process.argv[2]) || 12);
const TEST_HOME = mkdtempSync(join(tmpdir(), 'dsh-rp-probe-'));
process.env.DSH_HOME = TEST_HOME;

const PROFILE_PACKAGE = process.env.DSH_RP_PROFILE_PACKAGE
  || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'profiles', 'web', 'package.json');
let entry;
try {
  entry = createRequire(PROFILE_PACKAGE).resolve('dsh-rp-tools');
} catch (error) {
  console.error(`解析 dsh-rp-tools 失败（profile=${PROFILE_PACKAGE}）：${error?.message ?? error}`);
  rmSync(TEST_HOME, { recursive: true, force: true });
  process.exit(2);
}
const mod = await import(pathToFileURL(entry).href);

const routes = new Map();
const events = new Map();
const on = (evt, fn) => {
  if (!events.has(evt)) events.set(evt, []);
  events.get(evt).push(fn);
  return () => {};
};
const hostCtx = {
  tools: { register: () => {} },
  on,
  effect: (fn) => { fn(); },
  webServer: { register: (r) => { routes.set(r.path, r); } },
  inject: (names, fn) => { fn(hostCtx); },
  get: () => undefined,
};
mod.apply(hostCtx);

function mkRes() {
  const out = { status: 0, body: '' };
  return {
    out,
    writeHead: (s) => { out.status = s; },
    setHeader: () => {},
    end: (b) => { out.body = typeof b === 'string' ? b : Buffer.from(b ?? '').toString('utf8'); },
    on: () => {},
  };
}
async function callGet(path, query = '') {
  const route = routes.get(path);
  const res = mkRes();
  await route.handler({ method: 'GET', url: `${path}${query}`, headers: {} }, res);
  return { status: res.out.status, json: JSON.parse(res.out.body || '{}') };
}
async function callPost(path, body) {
  const route = routes.get(path);
  const res = mkRes();
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = 'POST';
  req.url = path;
  req.headers = { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080', 'content-type': 'application/json' };
  await route.handler(req, res);
  return { status: res.out.status, json: JSON.parse(res.out.body || '{}') };
}

console.log(`被测模块: ${entry}\n临时 HOME: ${TEST_HOME}\n`);

// ── ① 列卡库 ──────────────────────────────────────────────────────────────
const t0 = Date.now();
const first = await callGet('/rp-tools/cards', '?limit=200');
console.log(`卡库根: ${first.json.root}`);
console.log(`读取来源: ${first.json.indexSource}｜库内 ${first.json.librarySize} 张｜分类 ${first.json.categories?.length} 个｜首屏耗时 ${Date.now() - t0}ms`);
if (!first.json.ok || first.json.librarySize === 0) {
  console.error('卡库为空或读取失败 —— 检查「设置 → RP工具 → 卡库目录」');
  rmSync(TEST_HOME, { recursive: true, force: true });
  process.exit(1);
}
console.log('分类（前 8）:', (first.json.categories ?? []).slice(0, 8).map((c) => `${c.name}(${c.count})`).join('、'));

// ── ② 搜索 ────────────────────────────────────────────────────────────────
for (const q of ['剑', '仙子', 'NTR']) {
  const r = await callGet('/rp-tools/cards', `?limit=3&q=${encodeURIComponent(q)}`);
  console.log(`搜索「${q}」→ ${r.json.total} 条，首条：${r.json.items?.[0]?.name ?? '—'}`);
}
const catProbe = (first.json.categories ?? [])[0]?.name;
if (catProbe) {
  const r = await callGet('/rp-tools/cards', `?limit=3&category=${encodeURIComponent(catProbe)}`);
  console.log(`按分类「${catProbe}」→ ${r.json.total} 条`);
}

// ── ③ 抽样解析：每类抓几张真卡 ────────────────────────────────────────────
const cats = (first.json.categories ?? []).slice(0, 8).map((c) => c.name);
const sample = [];
for (const cat of cats) {
  const r = await callGet('/rp-tools/cards', `?limit=${SAMPLE_PER_CAT}&category=${encodeURIComponent(cat)}`);
  for (const it of r.json.items ?? []) sample.push(it);
}
console.log(`\n抽样 ${sample.length} 张（${cats.length} 个分类 × ${SAMPLE_PER_CAT}）`);

let okCount = 0;
const failures = [];
const durations = [];
let totalBookEntries = 0;
let totalChars = 0;
let biggest = { name: '', chars: 0 };
for (const it of sample) {
  const t = Date.now();
  const r = await callGet('/rp-tools/card', `?path=${encodeURIComponent(it.path)}`);
  durations.push(Date.now() - t);
  if (r.json.ok) {
    okCount++;
    totalBookEntries += r.json.stats?.entries ?? 0;
    totalChars += r.json.stats?.totalChars ?? 0;
    const chars = (r.json.world?.length ?? 0) + (r.json.character?.personality?.length ?? 0);
    if (chars > biggest.chars) biggest = { name: r.json.name, chars };
  } else {
    failures.push({ path: it.path, error: r.json.error });
  }
}
durations.sort((a, b) => a - b);
console.log(`解析成功 ${okCount}/${sample.length}｜中位耗时 ${durations[Math.floor(durations.length / 2)]}ms｜最慢 ${durations.at(-1)}ms`);
console.log(`世界书条数合计 ${totalBookEntries}（均 ${(totalBookEntries / Math.max(1, okCount)).toFixed(1)}/张）｜正文合计 ${totalChars} 字`);
console.log(`最大的一张：${biggest.name}（预览字段 ${biggest.chars} 字）`);
if (failures.length) {
  console.log('解析失败：');
  for (const f of failures.slice(0, 10)) console.log(`  · ${f.path} → ${f.error}`);
}

// ── ④ 真导入三张（写进临时工作区）─────────────────────────────────────────
// 刻意挑**世界书条目最多**的几张：0 条目的老卡看不出「条目 → rp-worldbook.md」
// 这条路走不走得通（第一版探针就挑了 3 张 0 条目的卡，等于没测）。
const ws = join(TEST_HOME, 'ws');
mkdirSync(ws, { recursive: true });
const withBooks = sample.slice().sort((a, b) => (b.bookEntries ?? 0) - (a.bookEntries ?? 0));
const importTargets = [...withBooks.slice(0, 2), ...sample.filter((i) => i.bookEntries > 0).slice(-1)];
let imported = 0;
for (const it of importTargets) {
  const sid = `probe-${imported}`;
  await callPost('/rp-tools/dm-mark', { sessionId: sid, preset: 'dm' });
  const r = await callPost('/rp-tools/card-import', { sessionId: sid, workspace: ws, path: it.path });
  if (!r.json.ok) { console.log(`导入失败 ${it.name}：${r.json.error}`); continue; }
  imported++;
  const files = r.json.files ?? {};
  console.log(`导入《${r.json.name}》（卡内 ${it.bookEntries} 条配置）：世界书 +${r.json.lore.added} 条（跳过 ${r.json.lore.skipped}）`
    + `｜全文 ${r.json.markdown.chars} 字${r.json.markdown.truncated ? '（已截断）' : ''}`
    + `｜卡面 ${files.image ? '已复制' : '复制失败'}`
    + `｜开场指令 ${r.json.opening.length} 字`);
}
const wb = join(ws, 'rp-worldbook.md');
if (existsSync(wb)) {
  const text = readFileSync(wb, 'utf8');
  console.log(`\n合并后的世界书：${text.length} 字，${(text.match(/^## /gm) ?? []).length} 个条目`);
}
const importDir = join(ws, 'rp-cards');
if (existsSync(importDir)) {
  console.log(`工作区 rp-cards/ 产物：${readdirSync(importDir).join('、')}`);
}

rmSync(TEST_HOME, { recursive: true, force: true });
console.log(`\n完成（临时目录已删除；真实数据目录未被触碰）`);
process.exitCode = failures.length || imported === 0 ? 1 : 0;
