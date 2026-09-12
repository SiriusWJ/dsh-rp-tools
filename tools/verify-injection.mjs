/**
 * 真机验证：RP 注入到底有没有进模型上下文。
 *
 * 为什么需要这个工具：本插件曾经在 **440 条冒烟断言全绿**的情况下，
 * 生产里一次都没注入过 —— 因为测试桩凭空给了 `ctx.agent`，而真实宿主的作用域 ctx
 * 上没有这个属性，于是每次装配都去读 `default` 这个空会话。
 * 代码看一百遍也看不出来，是**读会话日志**读出来的。所以留一个直接读日志的验证脚本。
 *
 * 用法：
 *   node tools/verify-injection.mjs                 # 扫 ~/.dsh/sessions 下所有会话
 *   node tools/verify-injection.mjs <会话目录|.zstd 文件>
 *
 * 输出每行一个会话：
 *   preset=dm  sys=1  promptChars=7004  placeholder=YES  standing=no  世界书=YES  常驻注入=no
 *
 * 判读：
 *   - placeholder=YES 说明我们注册的段进去了，但**没有被真实内容替换** → 注入失效（会话 id 没取到）。
 *   - standing=YES 说明世界设定/角色卡真的注入了系统提示。
 *   - 每轮的 `rp:turn`（状态 + 世界书命中）以 **user 角色快照** 落进会话日志，
 *     所以它不在 system/message 里（`runtimeSnapshots` 才数它，>0 即说明那条通道在工作）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';

const STANDING_PLACEHOLDER = '本会话尚未设置跑团世界设定';
const STANDING_MARK = '本场跑团的世界观';

/**
 * 解开一个会话日志。
 *
 * 日志是**追加写**的 zstd **多帧**文件（每写一批就是一个独立帧），
 * `zstdDecompressSync` 只解第一帧，流式接口也停在第一帧 —— 所以按魔数找帧起点逐个解。
 */
function decodeSessionLog(file) {
  const raw = readFileSync(file);
  const frames = [];
  for (let i = 0; i + 3 < raw.length; i++) {
    if (raw[i] === 0x28 && raw[i + 1] === 0xb5 && raw[i + 2] === 0x2f && raw[i + 3] === 0xfd) frames.push(i);
  }
  let text = '';
  for (const off of frames) {
    try { text += zlib.zstdDecompressSync(raw.subarray(off)).toString('utf8'); } catch { /* 不是帧起点 */ }
  }
  return text;
}

function inspect(text) {
  const lines = text.split('\n').filter(Boolean);
  const header = (() => { try { return JSON.parse(lines[0]); } catch { return {}; } })();
  const out = {
    id: header.id ?? '?',
    preset: header.agentPreset ?? '?',
    events: lines.length,
    sysMsgs: 0,
    promptChars: 0,
    placeholder: false,
    standing: false,
    loreLine: false,
    runtimeSnapshots: 0,
    loreChars: 0,
  };
  for (const line of lines) {
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'system/message') {
      out.sysMsgs++;
      const t = (ev.data?.message?.content ?? []).map((b) => b?.text ?? '').join('');
      out.promptChars = Math.max(out.promptChars, t.length);
      if (t.includes(STANDING_PLACEHOLDER)) out.placeholder = true;
      if (t.includes(STANDING_MARK)) out.standing = true;
      if (t.includes('【世界书】')) out.loreLine = true;
    }
    // 每轮的动态上下文（状态 + 世界书命中）是以 **plugin 来源的 user 快照** 落盘的
    if (ev.type === 'user/message' && ev.data?.message?.source?.plugin === '@deepseek-ai/dsh-system-prompt') {
      out.runtimeSnapshots++;
      const t = (ev.data.message.content ?? []).map((b) => b?.text ?? '').join('');
      out.loreChars = Math.max(out.loreChars, t.length);
    }
  }
  return out;
}

function format(r) {
  const tag = (v, yes) => `${v}=${(yes ? 'YES' : 'no').padEnd(3)}`;
  return [
    `${String(r.id).slice(0, 24).padEnd(26)}`,
    `preset=${String(r.preset).padEnd(8)}`,
    `events=${String(r.events).padStart(4)}`,
    `sys=${r.sysMsgs}`,
    `promptChars=${String(r.promptChars).padStart(6)}`,
    tag('占位', r.placeholder),
    tag('世界设定', r.standing),
    tag('世界书路径', r.loreLine),
    `轮次快照=${r.runtimeSnapshots}`,
    r.runtimeSnapshots ? `(${r.loreChars} 字)` : '',
  ].join('  ');
}

const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const logs = [];
if (arg) {
  const st = statSync(arg);
  if (st.isDirectory()) {
    const nested = join(arg, 'session.v3.jsonl.zstd');
    logs.push(statSync(nested, { throwIfNoEntry: false }) ? nested : null);
    for (const e of readdirSync(arg)) {
      if (!e.startsWith('session-')) continue;
      const p = join(arg, e, 'session.v3.jsonl.zstd');
      if (statSync(p, { throwIfNoEntry: false })) logs.push(p);
    }
  } else {
    logs.push(arg);
  }
} else {
  const root = join(homedir(), '.dsh', 'sessions');
  for (const ws of readdirSync(root)) {
    const dir = join(root, ws);
    if (!statSync(dir).isDirectory()) continue;
    for (const e of readdirSync(dir)) {
      if (!e.startsWith('session-')) continue;
      const p = join(dir, e, 'session.v3.jsonl.zstd');
      if (statSync(p, { throwIfNoEntry: false })) logs.push(p);
    }
  }
}

const rows = [];
for (const file of logs.filter(Boolean)) {
  try { rows.push(inspect(decodeSessionLog(file))); } catch { /* 跳过读不动的日志 */ }
}
// 只关心 DM 会话（其它预设本来就不该有 RP 内容）；`--all` 时全部列出
const rowsWanted = process.argv.includes('--all') ? rows : rows.filter((r) => r.preset === 'dm');
for (const r of rowsWanted.sort((a, b) => b.events - a.events)) console.log(format(r));

const dm = rows.filter((r) => r.preset === 'dm');
const bad = dm.filter((r) => r.placeholder && !r.standing);
console.log(`\nDM 会话 ${dm.length} 个；注入失效（只有占位文案）${bad.length} 个。`);
if (bad.length) {
  console.log('注入失效的会话：', bad.map((r) => r.id).join(', '));
  console.log('排查顺序：① 装配上下文里有没有 agent（session 日志里 system 段是否只有占位）；');
  console.log('          ② _standing-probe.json 里的 sessionId 是不是 "default"；');
  console.log('          ③ 进程是不是还在跑旧代码（比对 profile 里 lib/index.js 的 mtime）。');
}
