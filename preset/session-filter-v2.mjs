// DM 会话作用域过滤器（随预设分发，勿移到别处单独加载）。
//
// 本模块只做三件事，全部**没有用户配置**（用户已要求去掉「第三方工具管理」那套机制）：
//   1. 关掉全部宿主**全局工具** —— DM 会话只看得到本预设自己挂的工具
//      （persona / 文档读写与搜索 / ask_user / web 工具 / rp-bridge 的 rp_*）。
//      做法是对着**实时全局注册表**算 deny 名单（tools/change 时重算），
//      所以主机装/删/改名插件都不会造成「unknown global tool」挂载失败。
//      用 deny 而不是 allow：allow 会把预设自挂的行一起过滤掉；deny 只点名全局层。
//   2. blankPromptSections —— 用同名空章节遮蔽主机注入的全局提示词章节
//      （作用域章节按名字覆盖全局章节，空文本在渲染时被丢弃）。
//   3. blankContexts —— 同理遮蔽全局 runtime context（0.2.x 的 harness:source 等
//      同时注册了 section 和 context，只遮 section 遮不干净）。
//   4. suppressRuntimeContext —— 默认**不关**。rp-tools 的每轮注入（当前状态 +
//      命中条目 + 在场角色）走的就是 runtime context 通道；只有显式 true 才关。
//
// ⚠️ .mjs 模块被 Node 按 URL 缓存，进程运行期间改内容不会生效（要换文件名或重装插件）。
//    历史：v1 的 suppressRuntimeContext 默认值是 `!== false`（不写就关），
//    结果静默丢掉了全部动态内容，所以换成了 v2。

// PTC 模式的保留传输工具，不允许出现在 restrict 里（宿主会直接报错）。
const TRANSPORT_TOOL = 'run_code'

/** 全部宿主全局工具名（排除传输工具）。deny 语义 = 这些在 DM 会话里全部不可见。 */
function deniedGlobalTools(ctx) {
  return ctx.tools
    .schemas()
    .map((tool) => tool.name)
    .filter((name) => name !== TRANSPORT_TOOL)
    .sort()
}

/**
 * 施加全局工具掩码，并在全局工具集变化时重算（掩码不变则不动，避免自激循环）。
 *
 * 为什么每次 `tools/change` 都重算：用户在 DM 会话运行期间装/删插件时，
 * 全局注册表会变；不重算就会留下「新插件工具漏进来 / 已删工具仍在 deny 名单」的偏差。
 * 新装的全局工具会被**下一次重算**收进 deny —— DM 会话永远只看见预设自己挂的工具。
 */
function restrictGlobals(ctx) {
  let applied
  let disposer
  const sync = () => {
    const deny = deniedGlobalTools(ctx)
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

/**
 * 遮蔽全局 **runtime context**；条目形如 ['harness:source', 200]。
 *
 * 为什么单靠 blankPromptSections 不够（0.2.1 起）：宿主有些内容**同名注册了
 * section 和 context 两遍** —— `harness:source`（本机 DSH checkout 路径）与
 * `app:web-surface`（Web GUI URL）都是这样。空 section 只会遮住 section 那一半，
 * 每轮的 context 那一半照样进上下文，DM 就会看到与跑团无关的机器路径。
 * 空 context 在渲染时同样被丢弃，所以「同名空 context」是合法且不越权的遮蔽手段。
 *
 * ⚠️ 不要用 `suppressRuntimeContext()` 代替：那是全局开关，会连带关掉 rp-tools
 * 自己的 `rp:turn` 通道（当前状态 / 世界书命中 / 在场角色）。
 * ⚠️ `working_directory` 是 required 的，遮盖会被注册表按必需项恢复 —— 别配。
 */
function blankContexts(ctx, contexts) {
  for (const entry of contexts) {
    const name = Array.isArray(entry) ? entry[0] : entry && entry.name
    const order = Array.isArray(entry) ? entry[1] : entry && entry.order
    if (typeof name !== 'string' || !Number.isFinite(order)) continue
    ctx.systemPrompt.context({ name, order, text: '' })
  }
}

export default {
  inject: ['tools', 'systemPrompt'],
  apply(ctx, config) {
    const settings = config ?? {}
    // 全局工具一律不放行（用户要求：不提供放行配置）。预设自挂的工具不受影响。
    restrictGlobals(ctx)
    blankSections(ctx, Array.isArray(settings.blankPromptSections) ? settings.blankPromptSections : [])
    blankContexts(ctx, Array.isArray(settings.blankContexts) ? settings.blankContexts : [])
    // 只有**显式** true 才关（v1 是 `!== false`，漏写即关 —— 那正是注入静默失效的原因之一）
    if (settings.suppressRuntimeContext === true) ctx.systemPrompt.suppressRuntimeContext()
  },
}
