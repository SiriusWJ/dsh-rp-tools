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
//   2. blankPromptSections —— 用同名空章节遮蔽主机注入的全局提示词章节
//      （作用域章节按名字覆盖全局章节，空文本在渲染时被丢弃）。
//   3. suppressRuntimeContext —— 默认**不关**。rp-tools 的每轮注入（当前状态 +
//      命中条目 + 在场角色）走的就是 runtime context 通道；v1 的默认值是
//      `!== false`（不写就关），结果静默丢掉了全部动态内容。现在只有显式
//      `suppressRuntimeContext: true` 才关。

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
    const deny = deniedGlobalTools(ctx, keep)
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
