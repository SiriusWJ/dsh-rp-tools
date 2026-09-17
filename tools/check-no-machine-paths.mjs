#!/usr/bin/env node
/**
 * 机台固定路径体检：`node tools/check-no-machine-paths.mjs`
 *
 * 为什么需要它：这个插件栽过一次 —— 某处的默认值是开发机的绝对路径
 * （`C:/Users/<某人>/.dsh/profiles/web/package.json`），换台机器上「注册 RP 工具失败」，
 * **8 个工具与两条注入通道一个都不生效**，而现象看起来像插件本身坏了。
 * 事后 audit 发现同样的写法在仓库里不止一处（同一个坑踩两次，因为两处各自硬编码）。
 *
 * 所以把它变成可执行的闸门：扫**代码文件**（lib / client / preset / tools / cordis.patch.yml），
 * 命中「像某个具体机台的绝对路径」就报错并列出位置。
 *
 * 判定是**允许清单**式的：只报「绝对路径字面量」，并豁免这几类明知道是对的用法 ——
 *   · `http://localhost` 这类 URL 里的冒号
 *   · 故意用来**拒绝**盘符路径的正则 / 用例（zip-slip 防护、`safeEntryName` 的断言）
 *   · 注释里的反例（「早先写死了 C:/Users/xxx」这种教训记录）
 * 豁免靠 `ALLOW` 里的行内标注 `machine-path-ok`，或下面按文件+正则列出的白名单。
 *
 * 用法：node tools/check-no-machine-paths.mjs
 * 退出码：0 = 干净；1 = 有嫌疑路径（详见输出）
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 扫这些地方；只扫代码，不扫 docs（文档里写机台路径当例子是合理的）。 */
const TARGETS = ['lib', 'client', 'preset', 'tools', 'cordis.patch.yml', 'package.json'];

/**
 * 「像机台绝对路径」的形态：
 *   C:\... / C:/...        Windows 盘符（后面必须跟路径分隔符或转义的 `\\`）
 *   /Users/<x>/ /home/<x>/ macOS / Linux 家目录下的绝对路径
 * 注意**不**匹配 `http://x`（冒号后是 `//` 且前面有协议），也不匹配单独的 `C:`。
 */
const SUSPECT = [
  /(?<![A-Za-z0-9])[A-Za-z]:[\\/]{1,2}[^\s'"),;]*[\\/][^\s'"),;]*/, // C:\a\b 或 C:\\a\\b
  /(?<![A-Za-z0-9])[A-Za-z]:[\\/]{1,2}[A-Za-z0-9_.-]+/,             // C:\foo（也覆盖 \\ 形态）
  /\/(?:Users|home)\/[A-Za-z0-9_.-]+\//,                            // /Users/x/ … /home/x/
];

/**
 * 明知是对的用法（文件相对路径 → 命中该正则就跳过）。
 * 每加一条都要写清**为什么它是对的**，否则这个闸门会被「加个白名单」慢慢蛀空。
 */
const ALLOW = [
  // zip-slip 防护：这条正则就是**用来拒绝**盘符路径的，命中的是它的规则本身
  { file: 'lib/zip.js', match: /\^\[\^?[A-Za-z]?-?A-Za-z\]|C:\\\\\.\.\.|C:\/\.\.\./ },
  // 测试里**故意**构造盘符路径来验证「被拒绝」
  { file: 'tools/smoke-dm.mjs', match: /safeEntryName|safeCardPath|拒盘符|zip-slip/i },
  { file: 'tools/smoke-client.mjs', match: /fakepath/ },        // 浏览器 input 的假路径
  // 体检脚本自己（本文件）当然会写出这些模式
  { file: 'tools/check-no-machine-paths.mjs', match: /.*/ },
  // 注释里的**反例**（记录「当初写死了某个绝对路径」这个教训）
  { file: 'preset/rp-bridge.mjs', match: /绝不能写死|早先默认值是/ },
  { file: 'lib/index.js', match: /sillytavernassets|某个固定的/ },
];

function* walk(abs) {
  const st = statSync(abs);
  if (st.isFile()) { yield abs; return; }
  for (const name of readdirSync(abs)) {
    if (name === 'node_modules' || name === '.git') continue;
    yield* walk(join(abs, name));
  }
}

const CODE_EXT = /\.(mjs|js|cjs|json|yml|yaml)$/;
const hits = [];

for (const target of TARGETS) {
  const abs = join(REPO, target);
  let entries;
  try { entries = [...walk(abs)]; } catch { continue; }
  for (const file of entries) {
    if (!CODE_EXT.test(file)) continue;
    const rel = relative(REPO, file).split('\\').join('/');
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (line.includes('machine-path-ok')) return;
      const allowed = ALLOW.some((a) => rel === a.file && a.match.test(line));
      if (allowed) return;
      // URL 里的 host:port 不算路径：把 http(s):// 与 127.0.0.1:port 这两种形态先摘掉
      const probe = line.replace(/https?:\/\/[^\s'")]*/g, '').replace(/\b[\w.-]+:\d{2,5}\b/g, '');
      for (const re of SUSPECT) {
        const m = probe.match(re);
        if (m) { hits.push({ rel, line: i + 1, text: line.trim(), hit: m[0] }); break; }
      }
    });
  }
}

if (hits.length === 0) {
  console.log('✓ 未发现机台固定路径（lib / client / preset / tools / cordis.patch.yml / package.json）');
  process.exit(0);
}

console.error(`✗ 发现 ${hits.length} 处疑似机台固定路径：\n`);
for (const h of hits) {
  console.error(`  ${h.rel}:${h.line}`);
  console.error(`      ${h.text.slice(0, 130)}`);
  console.error(`      → 命中：${h.hit}`);
}
console.error('\n写法建议：');
console.error('  · 要从「某个 profile」解析东西 → 复用 preset/rp-bridge.mjs 的 resolveProfilePackage()');
console.error('  · 要指向「本仓库」→ 用 dirname(fileURLToPath(import.meta.url)) 往上推，别写绝对路径');
console.error('  · 要一个「只是用来演示/测试的路径」→ 用 X:/ws 这类明显中性的假路径，或行内加 machine-path-ok');
console.error('  · 确实是规则的例外 → 在 ALLOW 里加一条**带理由**的白名单');
process.exit(1);
