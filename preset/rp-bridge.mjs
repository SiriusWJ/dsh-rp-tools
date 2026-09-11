/**
 * dm 预设的 RP 桥接插件（agent 作用域）—— 在**本会话**里挂两样东西：
 *
 *   1. RP 生图 / 会话 / 角色 / 状态 / 场景 / 表格工具；
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
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const PROFILE_PACKAGE = process.env.DSH_RP_PROFILE_PACKAGE
  || 'C:/Users/75373/.dsh/profiles/web/package.json';

export const name = 'rp-bridge';
// systemPrompt 是本作用域需要的服务：拿不到就等待（而不是默默少掉注入）
export const inject = ['tools', 'systemPrompt'];

export async function apply(ctx) {
  try {
    const require = createRequire(PROFILE_PACKAGE);
    const entry = require.resolve('dsh-rp-tools');
    const mod = await import(pathToFileURL(entry).href);
    if (typeof mod.registerRpTools === 'function') {
      // 工具 + 提示词注入都在这一句里挂上（注入用 ctx.agent.id 定位本会话）
      mod.registerRpTools(ctx);
    } else {
      console.error('[rp-bridge] dsh-rp-tools 没有导出 registerRpTools，RP 工具与注入均未注册');
    }
  } catch (error) {
    console.error('[rp-bridge] 注册 RP 工具失败:', error?.message ?? error);
  }
}
