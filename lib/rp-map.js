/**
 * 轻量 DM 地图：读静态图 + 动态状态，校验引用完整性，渲染成一行注入文本。
 *
 * ## 为什么状态不放进 `rp_state.flags`
 *
 * 设计初稿把动态状态（已揭示节点、边状态、标记位置）放 `rp_state.flags`。那样**跑不起来**：
 * `applyStateUpdates` 写旗标时是 `String(value)` → 对象直接变成 `"[object Object]"`（写进去了、
 * 不报错、永久丢失），数组被压成逗号串；再叠上 `FLAG_VALUE_CHARS = 120` 的截断与
 * `FLAGS_MAX_SHOWN = 16` 的显示上限（20 个地图键会把剧情旗标挤到看不见）。实测数据：
 *
 * ```
 * 写 flags：map_edge_states=[object Object]；map_tokens=[object Object]   ← 第一回合就死
 * ```
 *
 * 所以动态状态放**自己的 JSON 文件**（无类型强转、无 120 字上限、无键数上限），
 * 并且有个额外好处：宿主的 fs 策略要求「覆盖前必先读」，DM 结构上无法盲覆盖。
 *
 * ## 两个文件
 *
 * - `rp-map.json`      静态图：节点 / 连接 / 默认可见性，**只增改结构，不写运行时变化**
 * - `rp-map-state.json` 动态状态：当前节点 / 已揭示 / 变化的边 / 标记位置
 *
 * 本模块**只读**：写盘由 DM 用通用的 write/edit 工具做（首版不加 `rp_map` 工具，
 * 见 docs/STATUS.md 里「何时才升级」的条件）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const MAP_FILE = 'rp-map.json';
export const MAP_STATE_FILE = 'rp-map-state.json';

/** id 规则：要进 GenUI action 名，所以只允许 ASCII 小写/数字/下划线。 */
export const MAP_ID_RE = /^[a-z0-9_]{1,32}$/;

const EDGE_STATES = new Set(['open', 'locked', 'blocked']);
const STATE_MARK = { open: '', locked: '🔒', blocked: '⛔' };
/** 一行里每类最多列几个，多了就 `…` —— 注入文本必须有个上限，否则一张大地图会吃掉半屏。 */
const LIST_CAP = 8;
/** tokens 最多列几个。 */
const TOKEN_CAP = 8;

const cap = (list, n = LIST_CAP) => (list.length > n ? `${list.slice(0, n).join('、')}…+${list.length - n}` : list.join('、'));

/** 边的另一端。 */
const other = (edge, nodeId) => (edge.a === nodeId ? edge.b : edge.a);

/**
 * 校验静态图。只报**无歧义**的错误（引用不存在、id 非法、状态值不认识）——
 * `public` 与 `revealed` 的关系不报：前者是初始可见性提示，后者才是权威，
 * 一个 `public: true` 但尚未揭示的节点是合法用法。
 */
export function validateMap(map) {
  const out = [];
  if (!map || typeof map !== 'object' || Array.isArray(map)) return ['rp-map.json 的内容不是对象'];
  if (!MAP_ID_RE.test(String(map.id ?? ''))) {
    out.push(`地图 id ${JSON.stringify(map.id ?? '')} 不合法（只能用小写字母/数字/下划线，1~32 位）—— 它要进按钮 action 名`);
  }
  const nodes = Array.isArray(map.nodes) ? map.nodes : null;
  if (!nodes || !nodes.length) return [...out, 'rp-map.json 里没有 nodes 数组（至少要有起点）'];
  const ids = new Set();
  for (const n of nodes) {
    const id = String(n?.id ?? '');
    if (!MAP_ID_RE.test(id)) out.push(`节点 id ${JSON.stringify(id)} 不合法`);
    else if (ids.has(id)) out.push(`节点 id 重复：${id}`);
    else ids.add(id);
  }
  if (map.start !== undefined && !ids.has(String(map.start))) out.push(`start="${map.start}" 不在 nodes 里`);
  const edgeIds = new Set();
  const edges = Array.isArray(map.edges) ? map.edges : [];
  for (const e of edges) {
    const id = String(e?.id ?? '');
    if (!MAP_ID_RE.test(id)) out.push(`连接 id ${JSON.stringify(id)} 不合法`);
    else if (edgeIds.has(id)) out.push(`连接 id 重复：${id}`);
    else edgeIds.add(id);
    if (!ids.has(String(e?.a))) out.push(`连接 ${id} 的 a="${e?.a}" 不是已知节点`);
    if (!ids.has(String(e?.b))) out.push(`连接 ${id} 的 b="${e?.b}" 不是已知节点`);
    if (e?.state !== undefined && !EDGE_STATES.has(String(e.state))) {
      out.push(`连接 ${id} 的 state="${e.state}" 不认识（只能是 open / locked / blocked）`);
    }
  }
  return out;
}

/** 校验动态状态与静态图是否自洽。 */
export function validateState(map, state) {
  const out = [];
  if (!state || typeof state !== 'object' || Array.isArray(state)) return ['rp-map-state.json 的内容不是对象'];
  const ids = new Set((Array.isArray(map?.nodes) ? map.nodes : []).map((n) => String(n?.id ?? '')));
  const edgeIds = new Set((Array.isArray(map?.edges) ? map.edges : []).map((e) => String(e?.id ?? '')));
  if (!state.map_id) out.push(`状态文件缺 map_id（应为 "${map?.id ?? ''}"）`);
  else if (map?.id && String(state.map_id) !== String(map.id)) {
    out.push(`状态文件的 map_id="${state.map_id}" 与 rp-map.json 的 id="${map.id}" 不一致 —— 是不是拿了另一张地图的状态？`);
  }
  if (!state.node) out.push('状态文件缺 node（队伍当前所在节点）');
  else if (!ids.has(String(state.node))) out.push(`node="${state.node}" 不是 rp-map.json 里的节点`);
  for (const r of Array.isArray(state.revealed) ? state.revealed : []) {
    if (!ids.has(String(r))) out.push(`revealed 里的 "${r}" 不是已知节点`);
  }
  for (const [eid, st] of Object.entries(state.edges ?? {})) {
    if (!edgeIds.has(eid)) out.push(`edges 里的 "${eid}" 不是已知连接`);
    else if (!EDGE_STATES.has(String(st))) out.push(`edges["${eid}"]="${st}" 不认识（只能是 open / locked / blocked）`);
  }
  for (const [who, at] of Object.entries(state.tokens ?? {})) {
    if (!ids.has(String(at))) out.push(`tokens["${who}"]="${at}" 不是已知节点`);
  }
  if (!state.tokens || !state.tokens.party) out.push('tokens 里缺 party（队伍在那个节点）');
  return out;
}

/** 合并静态默认与动态覆盖，得到每条边的当前状态。 */
export function effectiveEdges(map, state) {
  const out = {};
  for (const e of Array.isArray(map?.edges) ? map.edges : []) out[e.id] = String(e.state ?? 'open');
  for (const [id, st] of Object.entries(state?.edges ?? {})) {
    if (id in out) out[id] = String(st);
  }
  return out;
}

/** 从当前节点出发**可走**的邻居（边是 open 且目标已揭示）。按钮只该按这个列表生成。 */
export function walkableFrom(map, state) {
  const es = effectiveEdges(map, state);
  const revealed = new Set(state?.revealed ?? []);
  return (Array.isArray(map?.edges) ? map.edges : [])
    .filter((e) => e.a === state?.node || e.b === state?.node)
    .filter((e) => es[e.id] === 'open' && revealed.has(other(e, state.node)))
    .map((e) => other(e, state.node));
}

/**
 * 读两个文件。**文件不存在不是错误**（本会话没用地图）。
 *
 * @returns `{ map, state, problems, mapFile, stateFile }`；`problems` 是人话，会原样注入给 DM。
 */
export function loadMap(dir) {
  const mapFile = join(String(dir ?? ''), MAP_FILE);
  const stateFile = join(String(dir ?? ''), MAP_STATE_FILE);
  const base = { map: null, state: null, problems: [], mapFile, stateFile };
  if (!dir || !existsSync(mapFile)) return base;

  let map = null;
  try {
    map = JSON.parse(readFileSync(mapFile, 'utf8'));
  } catch (error) {
    // **不能静默变成「没有地图」**：文件在、内容坏，DM 必须知道，否则它会以为这场团压根没地图
    return { ...base, problems: [`${MAP_FILE} 不是合法 JSON：${error?.message ?? error}`] };
  }
  const problems = validateMap(map);
  if (!existsSync(stateFile)) return { ...base, map, problems, stateExists: false };

  let state = null;
  try {
    state = JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch (error) {
    return {
      ...base, map, stateExists: true,
      problems: [...problems, `${MAP_STATE_FILE} 不是合法 JSON：${error?.message ?? error}`],
    };
  }
  return { map, state, stateExists: true, problems: [...problems, ...validateState(map, state)], mapFile, stateFile };
}

/**
 * 渲染成注入文本。**没有地图返回 `''`**（绝大多数会话不该被地图内容打扰）；
 * 但只要有一丁点问题就一定会出声 —— 「静默」是这个仓库反复踩过的坑。
 *
 * 两条纪律（都是踩出来的）：
 * - **文件坏了 ≠ 还没建**：状态文件存在但 JSON 坏了，不能说「还没初始化」，否则 DM 会去
 *   覆盖一份本来能救回来的文件。
 * - **坏数据不渲染摘要**：`node` 不是已知节点时只出 ⚠ 行 —— 拿垃圾状态画出一行
 *   看起来正常的地图，比什么都不显示更危险（DM 会照着它叙事）。
 *
 * 形如：
 *   【地图】旧钟旅店·大堂｜已揭示 4/5｜可走：厨房（木门）｜队伍@大堂、老板@大堂
 *   【地图】⚠ node="nope" 不是 rp-map.json 里的节点
 */
export function renderMapContext({ map, state, problems = [], stateExists = true } = {}) {
  if (!map && !problems.length) return '';
  const lines = [];
  const nodes = Array.isArray(map?.nodes) ? map.nodes : [];
  const known = new Set(nodes.map((n) => String(n?.id ?? '')));
  const labelOf = (id) => nodes.find((n) => String(n?.id) === String(id))?.label || String(id);
  const anchored = Boolean(map && state && state.node && known.has(String(state.node)));

  if (anchored) {
    const revealed = new Set((state.revealed ?? []).map(String).filter((id) => known.has(id)));
    const es = effectiveEdges(map, state);
    const adjacent = (Array.isArray(map.edges) ? map.edges : []).filter((e) => e.a === state.node || e.b === state.node);
    const open = adjacent.filter((e) => es[e.id] === 'open' && revealed.has(other(e, state.node)))
      .map((e) => (e.label ? `${labelOf(other(e, state.node))}（${e.label}）` : labelOf(other(e, state.node))));
    // 只列**当前节点这一端**不通的路：站在厨房时报「大堂的暗门锁着」是噪音
    const shut = adjacent.filter((e) => es[e.id] !== 'open')
      .map((e) => `${STATE_MARK[es[e.id]] ?? '?'}${labelOf(other(e, state.node))}${e.label ? `（${e.label}）` : ''}`);
    const tokens = Object.entries(state.tokens ?? {}).filter(([, at]) => at)
      .map(([who, at]) => `${who === 'party' ? '队伍' : who}@${labelOf(at)}`);
    lines.push(`【地图】${map.name || map.id}·${labelOf(state.node)}`
      + `｜已揭示 ${revealed.size}/${nodes.length}`
      + `｜可走：${cap(open) || '无'}`
      + (shut.length ? `｜此端不通：${cap(shut)}` : '')
      + (tokens.length ? `｜${cap(tokens, TOKEN_CAP)}` : ''));
  } else if (map && !state && !stateExists) {
    const start = String(map.start ?? nodes[0]?.id ?? '');
    const initial = {
      map_id: map.id,
      node: start,
      revealed: nodes.filter((n) => n.public).map((n) => n.id),
      edges: {},
      tokens: { party: start },
    };
    lines.push(`【地图】${map.name || map.id}（${nodes.length} 个地点）`
      + `｜⚠ 还没有 ${MAP_STATE_FILE} —— 队伍位置还没初始化。`
      + `用 write 建一份（把 node / revealed / tokens 改成实际值）：${JSON.stringify(initial)}`);
  }
  for (const p of problems) lines.push(`【地图】⚠ ${p}`);
  return lines.join('\n');
}

/** 一站式的：给目录，返回可直接注入的文本（读不动就返回问题行）。 */
export function mapContextForDir(dir) {
  const loaded = loadMap(dir);
  return renderMapContext(loaded);
}

/**
 * 由世界书路径推出地图两件套的绝对路径（与会话目录同源，调用方不用再解析一次会话目录）。
 * 静态图存在才算「本会话有地图」。
 */
export function mapFilePaths(loreFile) {
  const dir = dirname(String(loreFile ?? ''));
  return {
    dir,
    mapFile: join(dir, MAP_FILE),
    stateFile: join(dir, MAP_STATE_FILE),
    exists: Boolean(loreFile) && existsSync(join(dir, MAP_FILE)),
  };
}

export default { loadMap, renderMapContext, mapContextForDir, mapFilePaths, validateMap, validateState, effectiveEdges, walkableFrom };
