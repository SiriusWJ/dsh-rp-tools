/**
 * dm 预设的 RP 桥接插件（agent 作用域）—— 在**本会话**里挂两样东西：
 *
 *   1. RP 会话 / 角色 / 状态 / 世界书 / 资源库 / 随机表工具；
 *   2. 提示词注入（世界设定 + 当前状态 + 世界书命中）。
 *
 * 两样都只在 dm 预设作用域注册，所以：
 *   - 其它预设的会话看不到这些工具；
 *   - `system-prompt/assemble` 是按作用域过滤的事件，本作用域的回调**只收到本会话的装配**，
 *     于是「只在 DM 会话生效」与「会话隔离」都由 Cordis 的作用域天然保证，**不需要猜会话 id**。
 *
 * 「🎲 RP」按钮怎么知道这是 DM 会话？客户端读 `useSessions()` 的
 * `byId[id].projectionValues.agentPreset`（官方 agent-preset 标签用的同一字段），
 * 等于 `dm` 就渲染按钮，再把判定 POST 给 /rp-tools/dm-mark 落盘。
 *
 * 用 createRequire 从 profile 解析已安装的 dsh-rp-tools，避免依赖 loader 的子路径解析。
 * profile 位置由 `resolveProfilePackage()` 动态解析（见下）——**不要在这里写死任何机台路径**：
 * `tools/verify-roundtrip.mjs` 也复用同一个函数，两处硬编码很容易只改一处。
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * 到哪个 profile 的 `package.json` 去找已安装的 `dsh-rp-tools`。
 *
 * ⚠️ 这里**绝不能写死绝对路径**。早先默认值是某个开发机的 `/Users/...` / `C:/Users/xxx/...`
 * 路径 —— 换台机器上桥接就只打印「注册 RP 工具失败」，**8 个工具与两条注入通道一个都不生效**，
 * 而且看起来像插件本身坏了。解析顺序：
 *   ① `DSH_RP_PROFILE_PACKAGE` 环境变量（多 profile / 非默认位置时用）
 *   ② `<DSH_HOME>/profiles/web/package.json`（默认 profile）
 *   ③ `<DSH_HOME>/profiles/` 下**恰好只有一个** profile 时用它（省掉环境变量）
 * 都不成立就返回第 ② 个候选（保持报错信息里有一条真实路径可看）。
 */
export function resolveProfilePackage() {
  const fromEnv = String(process.env.DSH_RP_PROFILE_PACKAGE ?? '').trim();
  if (fromEnv) return fromEnv;
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const web = join(home, 'profiles', 'web', 'package.json');
  if (existsSync(web)) return web;
  try {
    const dirs = readdirSync(join(home, 'profiles'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(home, 'profiles', d.name, 'package.json'))
      .filter((p) => existsSync(p));
    if (dirs.length === 1) return dirs[0];
  } catch { /* 没有 profiles 目录就退回默认候选 */ }
  return web;
}

const PROFILE_PACKAGE = resolveProfilePackage();

export const name = 'rp-bridge';
// systemPrompt 是本作用域需要的服务：拿不到就等待（而不是默默少掉注入）
export const inject = ['tools', 'systemPrompt'];

/**
 * 生图能力自检：本插件从 1.15.0 起**不再出图**，DM 配图全靠宿主的 `generate_image` / `edit_image`。
 * 而这两个是**全局**工具，`dm-filter`（session-filter-v2.mjs）会 deny 掉不在 `keepGlobalTools`
 * 白名单里的一切 —— 也就是说「白名单漏了」的后果是**静默的能力缺失**：
 * 预设、常驻段、工具说明都还在让 DM 去调一个它根本看不见的工具，没有任何报错。
 *
 * 所以在这里主动查一次（`ctx.tools.schemas()` 读的是**全局注册表**，与 dm-filter 同一份来源），
 * 缺了就打印一条明确的警告，把「该往哪加」直接写出来 —— 这种失败本来就该吵，不该安静。
 */
function warnIfNoImageTools(ctx) {
  try {
    const names = new Set((ctx.tools.schemas() ?? []).map((t) => t?.name).filter(Boolean));
    const has = ['generate_image', 'edit_image'].filter((n) => names.has(n));
    if (has.length) return;
    console.warn(
      '[rp-bridge] ⚠️ 本会话看不到宿主的生图工具（generate_image / edit_image）：'
      + 'DM 的配图说明会变成空话（工具被 dm-filter 挡在外面了）。'
      + '修法：打开「设置 → RP工具 → DM 会话放行」，把宿主的生图工具勾上（默认就该是勾的），'
      + '换一个 DM 会话即生效。若本机根本没装生图插件，这条可以忽略。',
    );
  } catch { /* 自检失败不影响注册 */ }
}

export async function apply(ctx) {
  try {
    const require = createRequire(PROFILE_PACKAGE);
    const entry = require.resolve('dsh-rp-tools');
    const mod = await import(pathToFileURL(entry).href);
    if (typeof mod.registerRpTools === 'function') {
      // 工具 + 提示词注入都在这一句里挂上（注入用 ctx.agent.id 定位本会话）
      mod.registerRpTools(ctx);
      warnIfNoImageTools(ctx);
    } else {
      console.error('[rp-bridge] dsh-rp-tools 没有导出 registerRpTools，RP 工具与注入均未注册');
    }
  } catch (error) {
    // 把「去哪儿找的」印出来：这个失败最常见的两个原因就是「插件没装进那个 profile」
    // 和「profile 路径不对」，只报一句 resolve 失败会让人查很久。
    console.error(
      `[rp-bridge] 注册 RP 工具失败（RP 工具与提示词注入都不会生效）：${error?.message ?? error}\n`
      + `  · 到哪个 profile 找的：${PROFILE_PACKAGE}\n`
      + '  · 先确认那个 profile 里装了插件：dsh plugin --profile <名> add github:SiriusWJ/dsh-rp-tools\n'
      + '  · 多 profile / 非默认位置时用环境变量指定：DSH_RP_PROFILE_PACKAGE=<profile>/package.json',
    );
  }
}
