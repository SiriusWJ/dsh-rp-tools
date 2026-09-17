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
