/**
 * dm 预设的 RP 桥接插件（agent 作用域）——两件事：
 *
 * 1. 把 dsh-rp-tools 的「RP 生图 / 会话 / 角色 / 场景 / 表格」工具注册进**本会话**。
 *    因为只在 dm 预设作用域注册，其它预设的会话根本看不到这些工具。
 * 2. 尽力把本会话登记为 DM 会话（POST /rp-tools/dm-mark），供界面识别。
 *
 * 用 createRequire 从 profile 解析已安装的 dsh-rp-tools，避免依赖 loader 的子路径解析。
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const PROFILE_PACKAGE = process.env.DSH_RP_PROFILE_PACKAGE
  || 'C:/Users/75373/.dsh/profiles/web/package.json';
const DSH_ORIGIN = process.env.DSH_RP_COMFY_ORIGIN || 'http://127.0.0.1:3080';

export const name = 'rp-bridge';
export const inject = ['tools'];

/** 从各种可能的上下文位置取会话 id。 */
function findSessionId(ctx) {
  const tries = [
    () => ctx?.agent?.id,
    () => ctx?.agent?.sessionId,
    () => ctx?.session?.id,
    () => ctx?.get?.('sessions')?.current?.id,
    () => ctx?.get?.('session')?.id,
  ];
  for (const t of tries) {
    try {
      const v = t();
      if (typeof v === 'string' && v) return v;
    } catch { /* 忽略 */ }
  }
  return undefined;
}

export async function apply(ctx) {
  // 1) 注册 RP 工具（只在本会话作用域）
  try {
    const require = createRequire(PROFILE_PACKAGE);
    const entry = require.resolve('dsh-rp-tools');
    const mod = await import(pathToFileURL(entry).href);
    if (typeof mod.registerRpTools === 'function') {
      mod.registerRpTools(ctx);
    } else {
      console.error('[rp-bridge] dsh-rp-tools 没有导出 registerRpTools，RP 工具未注册');
    }
  } catch (error) {
    console.error('[rp-bridge] 注册 RP 工具失败:', error?.message ?? error);
  }

  // 2) 登记本会话为 DM 会话（尽力而为）
  const sessionId = findSessionId(ctx);
  if (!sessionId) return;
  try {
    void fetch(`${DSH_ORIGIN}/rp-tools/dm-mark`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: DSH_ORIGIN },
      body: JSON.stringify({ sessionId, preset: 'dm' }),
    }).catch(() => {});
  } catch { /* 尽力而为 */ }
}
