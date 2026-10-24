#!/usr/bin/env node
/**
 * DM 预设自检：`node tools/check-preset.mjs`
 *
 * 为什么要单独一个脚本：**0.2.x 起预设的安装方式变了**。
 *   0.1.x：预设是文件系统目录 `~/.dsh/.agent-presets/<id>/`，要把 `preset/` 下四份文件拷进去
 *          （旧版 `tools/install-preset.mjs` 干的就是这件事）。
 *   0.2.x：`@deepseek-ai/dsh-agent-preset-registry` **不扫描目录**；预设是 bundle patch 里
 *          一条 `@deepseek-ai/dsh-agent-preset` 行，随插件包一起声明（见仓库根 `cordis.patch.yml`）。
 *          装插件 = 装预设，**不再需要往任何目录拷文件**。
 *
 * 所以这个脚本只做「装没装对」的诊断，不改任何东西：
 *   ① 插件装进了哪个 profile；
 *   ② 那个 profile 的 bundle 列表里有本插件吗（patch 才会被应用）；
 *   ③ 装进去的那份 `cordis.patch.yml` 里有没有 `preset-dm`；
 *   ④ 预设引用的两个子插件文件在包里吗（rp-bridge / session-filter-v2）。
 * 任何一条 ✗ 都意味着「新建会话里选不到 DM 预设 / 工具不出现」。
 *
 * 用法：
 *   node tools/check-preset.mjs                 # 自动找 profile
 *   DSH_RP_PROFILE_PACKAGE=<profile>/package.json node tools/check-preset.mjs
 * 退出码：0 = 全绿；1 = 有前置条件没满足。
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

let yaml = null;
try { yaml = await import('js-yaml').then((m) => m.default ?? m); } catch { /* 下面降级 */ }

/** 与预设桥接、冒烟测试共用同一个 profile 解析（认得桌面版的 desktop profile）。 */
async function profilePackage() {
  if (process.env.DSH_RP_PROFILE_PACKAGE) return process.env.DSH_RP_PROFILE_PACKAGE;
  try {
    const bridge = await import(pathToFileURL(join(REPO, 'preset', 'rp-bridge.mjs')).href);
    return bridge.resolveProfilePackage();
  } catch {
    return join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'profiles', 'desktop', 'package.json');
  }
}

const profilePkg = await profilePackage();
console.log(`仓库：${REPO}`);
console.log(`profile：${profilePkg}\n`);

let problems = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg, hint) => {
  problems += 1;
  console.log(`  ✗ ${msg}`);
  if (hint) console.log(`    ${hint}`);
};

// ① 插件装进 profile 了吗
let pluginEntry = null;
try {
  pluginEntry = createRequire(profilePkg).resolve('dsh-rp-tools');
  ok(`插件已装进 profile：${pluginEntry}`);
} catch {
  bad('插件没装进这个 profile',
    '先装插件：dsh plugin --profile <名> add github:SiriusWJ/dsh-rp-tools（或 link: 本地仓库）');
}

// ② profile 的 bundle 列表里有它吗（bundle 不在列表里 = patch 不会应用 = 预设不出现）
if (pluginEntry) {
  try {
    const profile = JSON.parse(readFileSync(profilePkg, 'utf8'));
    const bundles = Array.isArray(profile?.dsh?.profile?.bundles) ? profile.dsh.profile.bundles : [];
    if (bundles.includes('dsh-rp-tools')) ok('profile 的 bundle 列表包含 dsh-rp-tools');
    else bad('profile 的 dsh.profile.bundles 里没有 dsh-rp-tools',
      'bundle 不在列表里时它的 cordis.patch.yml 不会应用（预设也不会注册）。用 dsh plugin ... add 重装一次即可。');
  } catch (error) {
    bad(`读不到 profile 的 package.json：${error?.message ?? error}`);
  }
}

// ③ 装进去的那份 package 的 bundle patch 里有 preset-dm 吗
const pkgRoot = pluginEntry ? resolve(dirname(pluginEntry), '..') : REPO;
const installedPatch = join(pkgRoot, 'cordis.patch.yml');
if (existsSync(installedPatch)) {
  const text = readFileSync(installedPatch, 'utf8');
  const hasPreset = /id:\s*preset-dm/.test(text) && /@deepseek-ai\/dsh-agent-preset/.test(text);
  if (hasPreset) ok('cordis.patch.yml 声明了 preset-dm（@deepseek-ai/dsh-agent-preset）');
  else bad('cordis.patch.yml 里没有 preset-dm 行', '0.1.x 的目录形态预设在本机已失效：更新插件到 0.2.x 版本。');
  // 子插件必须是包内子路径；./ 会被 Loader 按 profile 目录解析
  const rel = text.split('\n').filter((line) => /^\s*-?\s*name:\s*\.\//.test(line));
  if (rel.length === 0) ok('子插件行没有 ./ 相对路径');
  else bad(`子插件行里有 ${rel.length} 个 ./ 相对路径（0.2.x 下会解析到 profile 目录而失败）`);
} else {
  bad(`找不到 ${installedPatch}（插件包不完整？）`);
}

// ④ 预设引用的两个子插件文件在不在
for (const f of ['preset/rp-bridge.mjs', 'preset/session-filter-v2.mjs']) {
  if (existsSync(join(pkgRoot, f))) ok(`子插件文件存在：${f}`);
  else bad(`子插件文件缺失：${f}`);
}

// ⑤ 可选：用 YAML 解析确认结构（拿不到 js-yaml 就跳过）
if (yaml && existsSync(installedPatch)) {
  try {
    const layers = yaml.load(readFileSync(installedPatch, 'utf8'));
    const rows = (Array.isArray(layers) ? layers : []).flatMap((l) => (Array.isArray(l?.insert) ? l.insert : []));
    const preset = rows.find((r) => r?.id === 'preset-dm');
    const count = Array.isArray(preset?.config?.plugins) ? preset.config.plugins.length : 0;
    if (preset?.config?.id === 'dm' && count > 0) ok(`预设结构可解析：id=dm，${count} 个子插件行`);
    else bad('预设行结构不对（缺 config.id=dm 或 plugins 为空）');
  } catch (error) {
    bad(`cordis.patch.yml 不是合法 YAML：${error?.message ?? error}`);
  }
} else if (!yaml) {
  console.log('  · 拿不到 js-yaml，跳过结构解析（不影响其它检查）');
}

console.log('');
if (problems) {
  console.log(`还有 ${problems} 个问题 —— 现在新建会话选不到 DM 预设，或者工具/注入不会生效。`);
  process.exit(1);
}
console.log('全部通过。下一步：重启宿主（patch 在启动时应用），新建会话选「DM 角色扮演主持人」。');
