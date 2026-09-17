#!/usr/bin/env node
/**
 * 把 dm 预设装进本机：`node tools/install-preset.mjs`
 *
 * 为什么需要这一步（而不是「插件装完就完事」）：
 * DSH 的 **agent 预设只能是文件系统目录**（`@deepseek-ai/dsh-agent-presets` 的 discovery 只扫
 * 随包发布的内置预设与 `$DSH_HOME/.agent-presets/<id>/`），插件的 bundle manifest **声明不了预设**。
 * 而本插件的 8 个 `rp_*` 工具与两条提示词注入通道**故意**只在 dm 预设作用域注册（作用域隔离 =
 * 只有 DM 会话看得到、会话之间不串台），所以预设目录必须存在，否则工具一个都不生效。
 *
 * 这个脚本把 `preset/` 下那几份文件拷到 `<DSH_HOME>/.agent-presets/dm/`，并且：
 *   · 幂等（重复跑就是覆盖成当前仓库的版本 —— 改了预设后重跑一次即可）
 *   · 动手前把已有内容备份成 `.bak-<时间戳>`（不静默覆盖用户可能自己改过的东西）
 *   · 只写这一个目录，不碰 profile、不碰别的预设
 *   · 用 `--dry` 只报告计划、不落盘；用 `--yes` 跳过确认
 *
 * 用法：
 *   node tools/install-preset.mjs            # 正常安装（有已存在文件时问一句）
 *   node tools/install-preset.mjs --dry      # 只看会做什么
 *   node tools/install-preset.mjs --yes      # 不问，直接做（CI / 脚本）
 *   node tools/install-preset.mjs --id mydm  # 装成别的预设 id（默认 dm）
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PRESET_SRC = join(REPO, 'preset');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const YES = argv.includes('--yes');
const idAt = argv.indexOf('--id');
const PRESET_ID = idAt >= 0 ? String(argv[idAt + 1] ?? '').trim() : 'dm';
if (!/^[a-z][a-z0-9_-]*$/.test(PRESET_ID)) {
  console.error(`预设 id 不合法：${PRESET_ID || '(空)'}（allowed: 小写字母开头 + 小写字母/数字/下划线/横线）`);
  process.exit(2);
}

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const DEST = join(DSH_HOME, '.agent-presets', PRESET_ID);

/** 预设目录必须齐的几份文件 —— 缺一份就是「装了但工具不出现」那种难查的失败。 */
const FILES = ['agent.cordis.yml', 'preset.yml', 'rp-bridge.mjs', 'session-filter-v2.mjs'];

console.log(`仓库：${REPO}`);
console.log(`DSH_HOME：${DSH_HOME}`);
console.log(`预设目录：${DEST}`);
console.log(`预设 id：${PRESET_ID}${PRESET_ID === 'dm' ? '（客户端按这个名字识别 DM 会话）' : ' ⚠️ 非 dm：界面上的「🎲 RP」入口按 dm 判定'}`);
console.log('');

// ── 前置检查：源文件齐不齐 ────────────────────────────────────────────────
const missingSrc = FILES.filter((f) => !existsSync(join(PRESET_SRC, f)));
if (missingSrc.length) {
  console.error(`✗ 源目录缺文件：${missingSrc.join(', ')}（看错仓库了？）`);
  process.exit(1);
}

// ── 目标现状 ──────────────────────────────────────────────────────────────
const existing = existsSync(DEST) ? readdirSync(DEST) : [];
const hasExisting = existing.length > 0;
const sameFiles = FILES.every((f) => {
  try { return readFileSync(join(DEST, f), 'utf8') === readFileSync(join(PRESET_SRC, f), 'utf8'); } catch { return false; }
});

if (hasExisting) {
  console.log(`目标目录已存在（${existing.length} 项）：${sameFiles ? '内容与本仓库**一致**' : '内容与本仓库**有差异**'}`);
  if (!sameFiles) {
    console.log('  差异文件：' + FILES.filter((f) => {
      try { return readFileSync(join(DEST, f), 'utf8') !== readFileSync(join(PRESET_SRC, f), 'utf8'); } catch { return true; }
    }).join('、'));
  }
  console.log('');
}

if (DRY) {
  console.log('[dry] 会做这些事：');
  for (const f of FILES) console.log(`  ${existsSync(join(DEST, f)) ? 'overwrite' : 'create   '}  ${join(DEST, f)}`);
  if (hasExisting && !sameFiles) console.log(`  backup     ${DEST} → ${DEST}.bak-<时间戳>（覆盖前先备份）`);
  console.log('\n[dry] 未落盘。');
  process.exit(0);
}

// ── 确认 ──────────────────────────────────────────────────────────────────
if (hasExisting && !sameFiles && !YES) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`覆盖 ${DEST} 里的 ${FILES.length} 个文件？(会先备份) [y/N] `);
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) {
    console.log('已取消 —— 什么都没改。');
    process.exit(0);
  }
}

// ── 备份 ──────────────────────────────────────────────────────────────────
if (hasExisting && !sameFiles) {
  // 只备份这几份文件（不整目录拷：用户可能在里面放了自己的东西，那些不该被我们动）
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const f of FILES) {
    const cur = join(DEST, f);
    if (!existsSync(cur)) continue;
    copyFileSync(cur, `${cur}.bak-${stamp}`);
  }
  console.log(`已备份原文件：*.bak-${stamp}`);
}

// ── 落盘 ──────────────────────────────────────────────────────────────────
mkdirSync(DEST, { recursive: true });
for (const f of FILES) {
  copyFileSync(join(PRESET_SRC, f), join(DEST, f));
  console.log(`  ✓ ${f}`);
}

// ── 装完自检：让「装了但没生效」当场暴露 ──────────────────────────────────
console.log('\n自检：');
let problems = 0;

// ① 插件装进 profile 了吗（桥接要靠它把工具挂上）
const profilePkg = process.env.DSH_RP_PROFILE_PACKAGE
  || join(DSH_HOME, 'profiles', 'web', 'package.json');
let pluginPath = null;
try {
  const { createRequire } = await import('node:module');
  pluginPath = createRequire(profilePkg).resolve('dsh-rp-tools');
} catch { /* 下面统一报 */ }
if (pluginPath) {
  console.log(`  ✓ 插件已装进 profile：${pluginPath}`);
  if (resolve(pluginPath).startsWith(REPO)) console.log('    （指向本仓库 = 链接安装，改代码直接生效）');
} else {
  problems += 1;
  console.log(`  ✗ 插件**没装进** profile（找的是 ${profilePkg}）`);
  console.log('    桥接会打印「注册 RP 工具失败」，8 个工具一个都不出现。先装插件：');
  console.log(`      dsh plugin --profile ${process.env.DSH_RP_PROFILE || 'web'} add github:SiriusWJ/dsh-rp-tools`);
  console.log('      （或本地链接：dsh plugin --profile web add ' + REPO + '）');
}

// ② 预设目录里 agent.cordis.yml 的 rp-bridge 行在不在（桥接是靠它挂上的）
try {
  const comp = readFileSync(join(DEST, 'agent.cordis.yml'), 'utf8');
  if (/rp-bridge\.mjs/.test(comp)) console.log('  ✓ 预设里引用了 rp-bridge.mjs（工具与注入的挂载点）');
  else { problems += 1; console.log('  ✗ 预设里没有 rp-bridge 那一行 —— 工具不会注册'); }
  if (/session-filter-v2\.mjs/.test(comp)) console.log('  ✓ 预设里引用了 session-filter-v2.mjs（全局工具过滤）');
  else { problems += 1; console.log('  ✗ 预设里没有 dm-filter 那一行'); }
} catch (error) {
  problems += 1;
  console.log(`  ✗ 读不到装好的预设：${error?.message ?? error}`);
}

console.log('');
if (problems) {
  console.log(`装好了，但还有 ${problems} 个前置条件没满足（见上面的 ✗）—— 现在开 DM 会话工具不会出现。`);
  process.exit(1);
}
console.log('完成。下一步：');
console.log(`  1) 重启 dsh web（预设是启动时读的；已经跑着的进程看不到新目录）`);
console.log(`  2) 新开一个会话，在预设选择器里选「${PRESET_ID === 'dm' ? 'DM / 跑团' : PRESET_ID}」`);
console.log('  3) 试试让它掷骰（它应该调用 rp_random）—— 工具出现了就说明接上了');
