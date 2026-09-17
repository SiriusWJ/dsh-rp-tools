/**
 * 全局工具放行名单的**共享默认值**（dm 预设过滤器与插件共用这一份）。
 *
 * 为什么单独一个文件、而不是各写一份：
 * 这份名单决定「DM 会话能看见哪些**全局**工具」，由两处共同消费 ——
 *   ① `preset/session-filter-v2.mjs`：按它算 deny 名单（放行这些、deny 其余全局工具）；
 *   ② `lib/index.js`：设置页读写它、`rp_config` 改它。
 * 两处各自硬编码就会走散（`BASE_KEEP` 少一项 = DM 的卡片渲染当场坏掉，而且不报错）。
 * 放在 `lib/` 下让两边都能 import：
 *   · 插件侧：`../lib/global-tools-defaults.js`
 *   · 预设侧：预设目录是**整目录拷贝**到 profile 的，所以它先试 `../lib/...`（从仓库跑），
 *     失败再试包名 `dsh-rp-tools/global-tools-defaults.js`（从 profile 的 node_modules 跑）。
 *
 * 本文件**零依赖、零副作用**：只导出常量，import 它不会有任何运行时开销。
 */

/**
 * 预设**底线**：无论用户怎么配都放行，用户不可取消。
 * 去掉任何一个都会当场砸掉功能：
 * - `render_ui` / `validate_dsh_ui` —— GenUI 卡片渲染与围栏自检，DM 的输出形态全靠它们；
 * - `web_search` —— 开局考据（不熟悉的作品先查再写）。
 */
export const GLOBAL_TOOLS_BASE = ['render_ui', 'validate_dsh_ui', 'web_search'];

/**
 * 出厂**默认勾选**的额外全局工具：宿主的生图 / 改图（`dsh-image-gen` 注册的全局工具）。
 *
 * 它们**不写死在预设的 keepGlobalTools 里** —— 那会让「换一个生图插件」的用户被迫改预设文件，
 * 而预设目录在重装插件时会被覆盖。改由设置页勾选（持久化在 `styles.json` 的 `globalToolsAllow`），
 * 这里只是「没有配置文件时」的兜底默认。
 */
export const GLOBAL_TOOLS_ALLOW_DEFAULT = ['generate_image', 'edit_image'];

/** 额外放行的全局工具名上限（防呆：配几千条没有意义）。 */
export const GLOBAL_TOOLS_ALLOW_MAX = 32;

/** 工具名合法性（与宿主命名一致：小写字母开头 + 小写字母/数字/下划线）。 */
export const TOOL_NAME_RE = /^[a-z][a-z0-9_]*$/;

/**
 * 归一化一份额外放行名单：只留合法工具名、去重、剔除底线里的名字（它们在底线上，写进来没意义），
 * 并按上限截断。**非法值一律丢掉而不是抛错** —— 这个值有两条写入路径（设置页 / `rp_config`），
 * 其中一条来自模型，宽容比让整份配置写不进去好。
 */
export function normalizeGlobalToolsAllow(raw) {
  const out = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const name = String(item ?? '').trim();
    if (!TOOL_NAME_RE.test(name)) continue;
    if (GLOBAL_TOOLS_BASE.includes(name)) continue;
    if (out.includes(name)) continue;
    out.push(name);
    if (out.length >= GLOBAL_TOOLS_ALLOW_MAX) break;
  }
  return out;
}
