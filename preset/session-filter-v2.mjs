// DM 会话作用域过滤器（随预设目录分发，勿移到别处单独加载）。
//
// 本模块只做机制，所有开关都在 agent.cordis.yml 里本行的 `config:` 下：
// 组合文件每次重新挂载/热更新都会重读，所以调名单改 YAML 就立刻生效；
// 而 .mjs 模块被 Node 按 URL 缓存，进程运行期间改内容不会生效（要换文件名）——
// v2 就是因为改了 suppressRuntimeContext 的默认值而改名的。
//
// 能力（详见 config 注释）：
//   1. keepGlobalTools —— 全局工具只留这些，其余全部 deny。名单对着实时全局
//      注册表计算，所以主机卸载/改名/新增插件都不会造成「unknown global tool」
//      挂载失败，也不会让新插件的工具漏进会话（tools/change 时自动重算）。
//      用 deny 而不是 allow：allow 会连预设自己挂的行一起过滤掉，deny 名单里
//      只有全局工具名，预设自挂的工具始终可见。
//      **1.15.0 起实际名单 = 预设底线（BASE_KEEP）+ YAML 里的 keepGlobalTools
//      + 用户在插件设置页勾选的 `globalToolsAllow`**（见 readExtraKeep）。
//   2. blankPromptSections —— 用同名空章节遮蔽主机注入的全局提示词章节
//      （作用域章节按名字覆盖全局章节，空文本在渲染时被丢弃）。
//   3. suppressRuntimeContext —— 默认**不关**。rp-tools 的每轮注入（当前状态 +
//      命中条目 + 在场角色）走的就是 runtime context 通道；v1 的默认值是
//      `!== false`（不写就关），结果静默丢掉了全部动态内容。现在只有显式
//      `suppressRuntimeContext: true` 才关。

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 放行名单的**默认值**来自与插件共用的那一份（`lib/global-tools-defaults.js`）。
 *
 * 为什么要这层动态解析：预设目录是**整目录拷**到 profile 的，而这个 .mjs 与 `lib/` 的相对位置
 * 取决于安装方式 —— 从仓库直接跑是 `../lib/...`，从 profile 的 node_modules 跑则是包内路径。
 * 两种都试，都失败就用**内联兜底**（宁可名字过时，也不能因为一份文件找不到就让过滤崩掉）。
 */
let DEFAULTS = {
  GLOBAL_TOOLS_BASE: ['render_ui', 'validate_dsh_ui', 'web_search'],
  GLOBAL_TOOLS_ALLOW_DEFAULT: ['generate_image', 'edit_image'],
  normalizeGlobalToolsAllow: (raw) => (Array.isArray(raw) ? raw.map((x) => String(x ?? '').trim()) : [])
    .filter((n) => /^[a-z][a-z0-9_]*$/.test(n)),
}
// 先试包名（**安装后的真实形态**：预设目录是拷贝到 `~/.dsh/.agent-presets/dm/` 的，旁边没有 `lib/`）。
// ⚠️ 这条依赖 `package.json` 的 `exports` 里显式列出 `./global-tools-defaults.js` ——
//    漏了会得到 `ERR_PACKAGE_PATH_NOT_EXPORTED`，然后**静默**退到内联兜底（默认值悄悄变旧）。
// 再试相对路径（从仓库直接跑、或仓库内做测试时）。
try {
  DEFAULTS = await import('dsh-rp-tools/global-tools-defaults.js')
} catch {
  try {
    DEFAULTS = await import('../lib/global-tools-defaults.js')
  } catch { /* 用上面的内联兜底 */ }
}

/** 预设底线（用户不可取消，见共享模块的注释）。 */
const BASE_KEEP = [...DEFAULTS.GLOBAL_TOOLS_BASE]

/** 没有配置文件时的兜底默认（= 宿主的生图工具）。 */
const ALLOW_DEFAULT = [...DEFAULTS.GLOBAL_TOOLS_ALLOW_DEFAULT]

/**
 * 用户在**设置页**勾选的额外放行名单，由插件写在 `$DSH_HOME/data/dsh-rp-tools/styles.json`
 * 的 `globalToolsAllow` 里（默认 `['generate_image','edit_image']` = 宿主的生图工具）。
 *
 * 为什么要读它而不是写死在预设里：**每个 DSH 装的生图插件可能不一样**（工具名自然不同），
 * 而预设目录在重装插件时会被覆盖 —— 用户不该靠改这份 YAML 来适配自己的插件。
 *
 * 读不到就用**出厂默认**（而不是空）：全新安装、还没打开过设置页时，生图工具也该是可用的。
 * 读坏了也退回默认 —— **必须放行的东西绝不能被一份坏配置弄丢**。
 */
function readExtraKeep() {
  try {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    const file = join(home, 'data', 'dsh-rp-tools', 'styles.json')
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const list = raw?.globalToolsAllow
    // 缺字段（老配置）= 出厂默认；显式空数组 = 用户真的一个都不要额外放行。
    if (!Array.isArray(list)) return ALLOW_DEFAULT
    return DEFAULTS.normalizeGlobalToolsAllow(list).filter((n) => !BASE_KEEP.includes(n))
  } catch { return ALLOW_DEFAULT }
}

/** 实际放行名单 = 预设底线 + YAML 里的 keepGlobalTools + 用户在设置页勾选的额外项（去重）。 */
function effectiveKeep(presetKeep) {
  return [...new Set([...BASE_KEEP, ...(Array.isArray(presetKeep) ? presetKeep : []), ...readExtraKeep()])]
}

// PTC 模式的保留传输工具，不允许出现在 restrict 里。
const TRANSPORT_TOOL = 'run_code'

/** 当前要关掉的全局工具名：实时全局注册表减去保留名单。 */
function deniedGlobalTools(ctx, keep) {
  return ctx.tools
    .schemas()
    .map((tool) => tool.name)
    .filter((name) => name !== TRANSPORT_TOOL && !keep.includes(name))
    .sort()
}

/** 施加全局工具掩码，并在全局工具集变化时重算（掩码不变则不动，避免自激循环）。 */
function restrictGlobals(ctx, keep) {
  let applied
  let disposer
  const sync = () => {
    // 每次重算都现读用户配置：设置页改完 → 下次 tools/change（或新会话挂载）即生效，
    // 不必让用户为了一个勾选框去重启进程。
    const deny = deniedGlobalTools(ctx, effectiveKeep(keep))
    const key = deny.join('\u0000')
    if (key === applied) return
    applied = key
    if (disposer !== undefined) {
      disposer()
      disposer = undefined
    }
    disposer = ctx.tools.restrict({ deny })
  }
  sync()
  ctx.on('tools/change', sync)
}

/** 遮蔽全局提示词章节；条目形如 ['harness:identity', -100]。 */
function blankSections(ctx, sections) {
  for (const entry of sections) {
    const name = Array.isArray(entry) ? entry[0] : entry && entry.name
    const order = Array.isArray(entry) ? entry[1] : entry && entry.order
    if (typeof name !== 'string' || !Number.isFinite(order)) continue
    ctx.systemPrompt.section({ name, order, text: '' })
  }
}

export default {
  inject: ['tools', 'systemPrompt'],
  apply(ctx, config) {
    const settings = config ?? {}
    const keep = Array.isArray(settings.keepGlobalTools) ? settings.keepGlobalTools : []
    restrictGlobals(ctx, keep)
    blankSections(ctx, Array.isArray(settings.blankPromptSections) ? settings.blankPromptSections : [])
    // 只有**显式** true 才关（v1 是 `!== false`，漏写即关 —— 那正是注入静默失效的原因之一）
    if (settings.suppressRuntimeContext === true) ctx.systemPrompt.suppressRuntimeContext()
  },
}
