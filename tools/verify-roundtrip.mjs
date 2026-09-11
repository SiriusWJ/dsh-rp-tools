/**
 * 往返一致性验证：`card-import.js` 导出的世界书 markdown → `lib/index.js` 的解析器读回
 * → 无 keys 的条目真的是常驻的、没关键词也会激活。
 *
 * 为什么要单独一个脚本：`lib/index.js` 依赖 profile 里的 `@deepseek-ai/dsh-tools`，
 * 从仓库路径直接 import 会 ERR_MODULE_NOT_FOUND。所以这个脚本要在
 * **profile 的 node_modules 目录下**运行（那里解析得到依赖）。
 *
 * 用法（由 tools/verify-roundtrip.mjs 的调用方复制到 profile 后执行）：
 *   node verify-roundtrip.mjs <card-import.js 的绝对路径>
 */
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const PROFILE_PACKAGE = process.env.DSH_RP_PROFILE_PACKAGE
  || 'C:/Users/75373/.dsh/profiles/web/package.json';
const require = createRequire(PROFILE_PACKAGE);
// 从 profile 解析插件入口（依赖齐全），再从它取解析器
const plugin = await import(pathToFileURL(require.resolve('dsh-rp-tools')).href);
const { parseLoreMarkdown, activateLore } = plugin.__debug ?? {};
if (typeof parseLoreMarkdown !== 'function') {
  console.error('拿不到 parseLoreMarkdown —— 插件导出的 __debug 变了？');
  process.exit(2);
}

// 被测的导入器从参数给（仓库里那份，而不是 profile 里的旧拷贝）
const importerPath = process.argv[2];
if (!importerPath) { console.error('用法: node verify-roundtrip.mjs <card-import.js 绝对路径>'); process.exit(2); }
const { worldBookMarkdown } = await import(pathToFileURL(importerPath).href);

const md = worldBookMarkdown([
  { name: '有键条目', keys: ['广寒宫'], content: '正文 A' },
  { name: '无键条目', keys: [], content: '正文 B' },
]);

const entries = parseLoreMarkdown(md.markdown);
const keyless = entries.find((e) => e.title === '无键条目');
const activated = activateLore(entries, '风平浪静毫无关键词');

let pass = 0; let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  got=${JSON.stringify(got)}${ok ? '' : `  want=${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

check('往返：导出的世界书被解析回条目数', entries.length, 2);
check('往返：无键条目导入后是常驻', keyless?.constant, true);
check('往返：无键条目在无关键词时也会激活', activated.active.some((e) => e.title === '无键条目'), true);
check('往返：有键条目保留 keys', keyless !== undefined && entries[0].keys.includes('广寒宫'), true);
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
