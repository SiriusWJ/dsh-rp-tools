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
 * **第三方工具 → 来源插件**的映射（设置页按插件聚合显示、一个插件一个勾选框）。
 *
 * 为什么要自己维护这张表：**宿主没提供工具归属**。实测确认过 ——
 * `tools.register(definition)` 只把定义插进「当前层」（`layers.effect`），而那一层的标签是
 * `tools.register()`，不是插件名；`schemas()` / `knownNames` 都只给工具名。
 * 也就是说「这个工具是哪个插件注册的」在运行时**查不到**，只能靠一份映射表。
 *
 * 维护方式：**数据驱动**，界面与前端都不写死插件名。新装一个插件、发现它没被正确归类时，
 * 往下面加一条即可（`match` 是工具名正则，`label` 是显示名）。
 * 未命中的工具会落在「其它」那一组，而**不是**按名字前缀乱猜 ——
 * 猜错的代价比「先归到其它」更糟：用户会以为自己看的是某个插件，其实不是。
 */
export const GLOBAL_TOOL_SOURCES = [
  {
    key: 'dsh-image-gen',
    label: 'dsh-image-gen（生图）',
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
    key: 'dsh-web-search',
    label: '联网搜索（宿主内置）',
    match: /^web_(search|fetch)$/,
  },
];

/** 未命中 {@link GLOBAL_TOOL_SOURCES} 的工具归到这一组。 */
export const GLOBAL_TOOL_SOURCE_FALLBACK = { key: '__other__', label: '其它' };


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
