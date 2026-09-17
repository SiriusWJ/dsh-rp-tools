/**
 * 全局工具放行名单的**共享默认值**（dm 预设过滤器与插件共用这一份）。
 *
 * 为什么单独一个文件、而不是各写一份：
 * 这份名单决定「DM 会话能看见哪些**全局**工具」，由两处共同消费 ——
 *   ① `preset/session-filter-v2.mjs`：按它算 deny 名单（放行这些、deny 其余全局工具）；
 *   ② `lib/index.js`：设置页读写它、`rp_config` 改它。
 * 两处各自硬编码就会走散（默认名单少一项 = DM 悄悄少一个能力，而且不报错）。
 * 放在 `lib/` 下让两边都能 import：
 *   · 插件侧：`../lib/global-tools-defaults.js`
 *   · 预设侧：预设目录是**整目录拷贝**到 profile 的，所以它先试包名
 *     `dsh-rp-tools/global-tools-defaults.js`（从 profile 的 node_modules 跑），
 *     再试相对路径 `../lib/...`（从仓库直接跑）。
 *
 * 本文件**零依赖、零副作用**：只导出常量，import 它不会有任何运行时开销。
 */

/**
 * 出厂**默认勾选**的全局工具（DM 会话能看见哪些第三方/宿主工具，就由这份名单决定）。
 *
 * 设计取向：**没有「固定放行」这一层** —— 一律是「可勾选 + 默认勾选」。
 * 早先把 `render_ui` / `validate_dsh_ui` / `web_search` 做成用户不可取消的底线，理由是
 * 「去掉会当场砸掉卡片渲染 / 围栏自检 / 开局考据」。但那让「谁在管什么」变得难讲，而且
 * 用户确实可能不需要其中某一项（比如不想要联网搜索）。现在它们只是**默认勾上**：
 * 开箱行为与以前一致，想关就能关。
 *
 * ⚠️ 关掉 `render_ui` / `validate_dsh_ui` 会让 DM 的卡片与围栏自检失效 —— 界面会就此给出提醒，
 * 但不阻止（这是用户自己的机器）。
 *
 * 这份名单同时是**兜底默认**：配置文件缺失/损坏时过滤器就按它放行（见 session-filter-v2.mjs），
 * 所以「读不到配置」不会让 DM 变成什么工具都看不见。
 */
export const GLOBAL_TOOLS_DEFAULT = [
  // GenUI 卡片渲染与围栏自检 —— DM 的输出形态全靠它们（关掉前请三思）
  'render_ui',
  'validate_dsh_ui',
  // 开局考据：不熟悉的作品先查再写（不需要联网就关掉）
  'web_search',
  // 宿主的生图 / 改图（dsh-image-gen）；换生图插件时把它的工具名勾上即可
  'generate_image',
  'edit_image',
];

/** 放行的全局工具名上限（防呆：配几千条没有意义）。 */
export const GLOBAL_TOOLS_ALLOW_MAX = 32;

/**
 * **工具 → 来源插件**的映射（设置页按插件聚合显示、一个插件一个勾选框）。
 *
 * 为什么要自己维护这张表：**宿主没提供工具归属**。实测确认过 ——
 * `tools.register(definition)` 只把定义插进「当前层」（`layers.effect`），而那一层的标签是
 * `tools.register()`，不是插件名；`schemas()` / `knownNames` 都只给工具名，
 * `ctx.inspect` 的 Tool.listTools 也只有 name/description/parameters。
 * 也就是说「这个工具是哪个插件注册的」在运行时**查不到**，只能靠一份映射表。
 *
 * 维护方式：**数据驱动**，界面与前端都不写死插件名。新装一个插件、发现它没被正确归类时，
 * 往下面加一条即可（`match` 是工具名正则，`label` 是显示名）。
 *
 * ⚠️ **不要加「其它」那种大杂烩组**（用户明确要求去掉）：归组要一个一个插件地登记，
 * 装了新插件就补一条。真出现漏网的（映射表还没跟上），它会落在
 * {@link GLOBAL_TOOL_SOURCE_FALLBACK} 那一组，组名是「宿主内置 · 其它」并在行上列出工具名 ——
 * 用户一眼看得出装的是什么，我们也知道该补哪一条，而不是把一堆无关工具糊成「其它」。
 * 但也**不按名字前缀乱猜**：猜错的代价比「先归到内置其它」更糟 —— 用户会以为自己看的是某个插件。
 */
export const GLOBAL_TOOL_SOURCES = [
  {
    key: 'dsh-image-gen',
    label: 'dsh-image-gen（生图 / 画布）',
    match: /^(generate_image|edit_image|canvas_state|view_canvas)$/,
    // 「这组是图片/生图插件」由**映射表**说，而不是逐名判断：
    // 它带的 `view_canvas` / `canvas_state` 名字里没有 image 之类的词，逐名判断会漏掉，
    // 结果就是真正的生图插件反而不打「图」标。有这一位就一眼看得出哪个插件管图片。
    image: true,
  },
  {
    key: 'dsh-genui',
    label: 'dsh-genui（界面卡片）',
    match: /^(render_ui|validate_dsh_ui|genui)$/,
  },
  {
    // 宿主内置：WebSearch/WebFetch 能力（`web_search` 可能被注册在**会话作用域**，
    // 于是它不在全局视图里、显示成「本机没注册」，但归属仍然是宿主内置）。
    key: 'dsh-host-web',
    label: '宿主内置 · 联网搜索',
    match: /^web_(search|fetch)$/,
  },
  {
    key: 'dsh-mcp',
    label: 'dsh-mcp（MCP 工具热注入）',
    match: /^(mcp_tool_search|mcp_servers)$/,
  },
  {
    // 记忆 / 日历 / 定时任务同属一个插件，所以**合成一组**（一个勾选框管这三个能力）。
    key: 'dsh-lite-memory',
    label: 'dsh-lite-memory（记忆 / 日历 / 定时）',
    match: /^(memory_(entry|range|recall|status)|calendar_(add|list|done|remove)|cron_(add|list|remove|run|toggle))$/,
  },
  {
    key: 'dsh-updater-npm',
    label: 'dsh-updater-npm（官方文档索引）',
    match: /^dsh_docs_(read|search)$/,
  },
  {
    key: 'dsh-find-plugin',
    label: 'dsh-find-plugin（插件市场检索）',
    match: /^find_dsh_plugin$/,
  },
];

/**
 * 未命中 {@link GLOBAL_TOOL_SOURCES} 的工具归到这一组。
 *
 * 为什么叫「宿主内置 · 其它」而不是「其它」或「未登记归属」：
 *   · **不叫「其它」** —— 那是个中性大杂烩，用户看不出里面装的是什么（这次就是被它逼着改的）；
 *   · **不叫「未登记归属（映射表缺条目）」** —— 那是写给维护者看的待办，不是给用户的分类
 *     （用户的原话：*未登记的改成系统内置*）；
 *   · 叫「宿主内置」是**有依据**的：映射表已经登记了本机**全部会注册全局工具的插件**
 *     （生图 / genui / mcp / 记忆 / 文档 / 插件检索 / 宿主联网），所以落在这里的
 *     基本只剩宿主自己注册、看不出归属的那些 —— 比「其它」诚实得多。
 *
 * 正常情况下它**应该是空的**；装了新插件、有人还没补映射表时才会冒出来，
 * 而界面会把组里的具体工具名逐个列出来，所以真出现时仍然看得见是哪些。
 */
export const GLOBAL_TOOL_SOURCE_FALLBACK = { key: '__unmapped__', label: '宿主内置 · 其它' };

/**
 * 按**来源插件**把工具名归组（设置页一个插件一个勾选框；`rp_config` 的回显也用它）。
 *
 * 放在**共享模块**里而不是 `lib/index.js`，是为了让客户端冒烟测试的桩调用同一份实现 ——
 * 桩自己抄一遍分组规则的话，映射表改了测试会「绿着」而真机已经不对了（这个仓库真栽过）。
 *
 * 组内按名字排序，组间按 {@link GLOBAL_TOOL_SOURCES} 的声明顺序，兜底那组永远排最后
 * —— 界面顺序稳定，用户扫一眼就能定位。
 *
 * @param names 工具名数组（来自 `listGlobalToolNames()`：全局层 ∪ 会话作用域里已点过名的）
 * @returns `[{ key, label, tools, image? }]`（只含非空组）
 */
export function groupGlobalTools(names) {
  const list = Array.isArray(names) ? names : [];
  const owned = new Set();
  const out = [];
  for (const src of GLOBAL_TOOL_SOURCES) {
    const tools = list.filter((n) => src.match.test(n));
    if (!tools.length) continue;
    // `image` 是映射表的点名：这一组是生图插件（它带的 view_canvas / canvas_state
    // 名字里看不出图片，逐名判断会漏），原样带出去给界面打「图」标。
    out.push({ key: src.key, label: src.label, tools: tools.slice().sort(), image: src.image === true });
    for (const n of tools) owned.add(n);
  }
  const rest = list.filter((n) => !owned.has(n)).sort();
  if (rest.length) out.push({ ...GLOBAL_TOOL_SOURCE_FALLBACK, tools: rest });
  return out;
}

/** 工具名合法性（与宿主命名一致：小写字母开头 + 小写字母/数字/下划线）。 */
export const TOOL_NAME_RE = /^[a-z][a-z0-9_]*$/;

/**
 * 归一化一份放行名单：只留合法工具名、去重，并按上限截断。
 * **非法值一律丢掉而不是抛错** —— 这个值有两条写入路径（设置页 / `rp_config`），
 * 其中一条来自模型，宽容比让整份配置写不进去好。
 */
export function normalizeGlobalToolsAllow(raw) {
  const out = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const name = String(item ?? '').trim();
    if (!TOOL_NAME_RE.test(name)) continue;
    if (out.includes(name)) continue;
    out.push(name);
    if (out.length >= GLOBAL_TOOLS_ALLOW_MAX) break;
  }
  return out;
}
