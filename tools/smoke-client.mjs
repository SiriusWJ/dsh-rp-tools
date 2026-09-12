/**
 * dsh-rp-tools 客户端半侧冒烟测试（无头）。
 *
 * 两件事，都是真的坏过的：
 *
 * ① **样式必须在第一个组件渲染之前注入**。历史 bug：injectStyles() 只在设置页 /
 *    会话面板的 useEffect 里调用，于是首次加载时头部那个「🎲 RP」按钮先以裸 <button>
 *    的默认外观出现（灰底方角），等某个组件挂载后才恢复 ——
 *    用户看到的就是「第一次启动样式不对、后面正常」。
 *
 * ② **组件本身要真的跑一遍**。只断言「槽位注册了」是不够的：注册成功但渲染时抛错，
 *    界面上就是一片空白，只留一行控制台报错。所以这里自带一个极小的 React 运行时
 *    （useState / useRef / useEffect + createElement）与 fetch 桩，把故事书导入组件
 *    **从头到尾渲染一遍**：折叠 → 展开 → 列表 → 预览 → 导入 →（已开局时）新建会话接手。
 *
 * 做法：模块加载器桩捕获 bundle 的 factory，喂给它 require（react 用我们的桩），
 * 调 apply()（此时一个组件都还没渲染）拿到注册的槽位与组件，再手动渲染。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const here = fileURLToPath(new URL('.', import.meta.url));
const bundlePath = join(here, '..', 'client', 'client.js');

// ── 最小 DOM 桩 ────────────────────────────────────────────────────────────
const head = [];
globalThis.document = {
  createElement(tag) {
    const el = { tagName: String(tag).toUpperCase(), dataset: {}, textContent: '', isConnected: false };
    el.setAttribute = (k, v) => { el[k] = v; };
    return el;
  },
  head: { appendChild: (el) => { el.isConnected = true; head.push(el); } },
  querySelector: () => null,
};

// ── 极小 React 运行时 ──────────────────────────────────────────────────────
// 钩子按**调用序号**存槽位（与 React 的规则同源：顺序必须稳定）。
// 槽位提供的 useSessions / useInput 是普通函数（真实实现内部才用 useSyncExternalStore），
// 所以它们不占槽位 —— 桩与真实行为在这一点上一致。
const rt = { cells: [], cursor: 0, effects: [], cleanups: [], dirty: false };
const resetSignals = () => { rt.cursor = 0; rt.effects = []; };
function flushEffects() {
  for (const fn of rt.effects.splice(0)) {
    const cleanup = fn();
    if (typeof cleanup === 'function') rt.cleanups.push(cleanup);
  }
}
const flatten = (list) => list.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== true);
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: flatten(children) }),
  Fragment: Symbol('Fragment'),
  useState(init) {
    const i = rt.cursor++;
    if (!(i in rt.cells)) rt.cells[i] = typeof init === 'function' ? init() : init;
    // setState 后要重渲染：render() 靠 dirty 决定是否再跑一趟（模拟 React 的提交+重渲染）
    return [rt.cells[i], (v) => { rt.cells[i] = typeof v === 'function' ? v(rt.cells[i]) : v; rt.dirty = true; }];
  },
  useRef(init) {
    const i = rt.cursor++;
    if (!(i in rt.cells)) rt.cells[i] = { current: init };
    return rt.cells[i];
  },
  useEffect(fn) { rt.cursor++; rt.effects.push(fn); },
  useLayoutEffect(fn) { rt.cursor++; rt.effects.push(fn); },
  useMemo(fn) { return fn(); },
  useCallback(fn) { return fn; },
};

// ── 假 DOM：让「把入口送进工作区那一行」的逻辑真的被走到 ────────────────────
// 结构照抄真实布局（这一层必须忠实，否则测不出「看错了哪一级兄弟」这类错）：
//   composerStack
//     ├─ heroWorkspaceRow   ← 里面已经有 chip（button）
//     └─ wrapper（dock 每个条目一层容器）
//          └─ .rpc（我们的条目根元素）
//               └─ .rpc-holder（占位）   ← 它的 previousElementSibling 是 null！
// domVariant 用来模拟「那一行是不是根元素的直接上一兄弟」两种宿主实现。
let domVariant = 'direct';
const stackEl = { children: [] };
const rowEl = {
  parentElement: null,
  previousElementSibling: null,
  querySelector: () => ({ tag: 'button' }),
  children: [],
  getBoundingClientRect: () => ({ top: 100, height: 28, left: 20, right: 300, width: 280 }),
};
const wrapperEl = { parentElement: stackEl, previousElementSibling: rowEl, children: [] };
const holderFake = { parentElement: null, previousElementSibling: null };
const rootEl = {
  parentElement: wrapperEl,
  children: [holderFake],
  get previousElementSibling() { return domVariant === 'direct' ? rowEl : null; },
};
holderFake.parentElement = rootEl;
rowEl.parentElement = stackEl;
stackEl.children = [rowEl, wrapperEl];
wrapperEl.children = [rootEl];
const ReactDOM = {
  createPortal: (child, container) => ({ type: 'Portal', props: { container }, children: flatten([child]) }),
};

// ── 模块加载器桩：捕获 factory，喂给它 require ──────────────────────────────
let captured = null;
globalThis.window = {
  __ModuleLoader__: {
    load(spec) { captured = spec; },
  },
};

// fetch 桩：按 URL 回应并记录调用，让导入流程能真的走完
const calls = [];
globalThis.fetch = async (url, options = {}) => {
  const method = options.method ?? 'GET';
  calls.push({ url: String(url), method, body: options.body ? JSON.parse(options.body) : undefined });
  const target = String(url);
  const reply = (json) => ({ ok: true, status: 200, json: async () => json });
  if (target.startsWith('/rp-tools/cards')) {
    return reply({
      ok: true, root: 'D:\\Story\\cards', exists: true, indexSource: 'index', librarySize: 3269,
      categories: [{ name: '古风', count: 133 }], total: 1,
      items: [{
        path: 'cards/古风/长安.card.png', name: '长安', kind: 'v3', creator: '某人',
        tags: ['古风'], bookEntries: 12, bytes: 1024, category: '古风',
      }],
    });
  }
  if (target.startsWith('/rp-tools/card?')) {
    return reply({
      ok: true, path: 'cards/古风/长安.card.png', name: '长安', kind: 'v3', chunk: 'ccv3', bytes: 1024,
      tags: [], creator: '某人',
      stats: { entries: 12, skipped: 3, enabledOff: 0, totalChars: 4321 },
      world: '【角色卡】长安\n\n【情境】天宝年间。',
      character: {
        name: '长安', personality: '【设定】……', first_mes: '开场白',
        greetingSource: 'alternate_greetings', greetingAlternatives: 4,
      },
      summary: [], warnings: [],
    });
  }
  if (target.startsWith('/rp-tools/card-import')) {
    return reply({
      ok: true, sessionId: 'session-abc', name: '长安', previousWorldChars: 0,
      files: {
        world: 'rp-worldbook.md', markdown: 'rp-cards/长安.card.md',
        json: 'rp-cards/长安.card.json', image: 'rp-cards/长安.card.png',
      },
      lore: { added: 12, skipped: 3 }, markdown: { chars: 5000, truncated: false },
      opening: '【开局】已导入卡组《长安》，不要再问世界从哪来，直接开团。',
    });
  }
  return reply({ ok: false, error: `未预期的请求：${target}` });
};

// bundle 是给浏览器写的普通脚本：读出来用 indirect eval 执行，效果落在全局桩上。
const source = readFileSync(bundlePath, 'utf8');
(0, eval)(source);
assert.ok(captured !== null, 'bundle 应通过 window.__ModuleLoader__.load() 注册自己');
assert.equal(captured.id, 'dsh-rp-tools', 'bundle 注册的 id 应为 dsh-rp-tools');

const plugin = captured.factory((name) => {
  if (name === 'react') return React;
  if (name === 'react-dom') return ReactDOM;
  throw new Error(`未预期的 require: ${name}`);
});
assert.equal(plugin.name, 'dsh-rp-tools');
assert.deepEqual(plugin.inject, ['slots']);

// ── 关键断言 ①：apply 一跑，样式就该在 head 里 ─────────────────────────────
const registered = [];
const slotRegs = [];
const slotsStub = {
  inject: (key, cb) => { registered.push(key); cb(); return () => {}; },
  register: (spec, component) => { slotRegs.push({ ...spec, component }); return () => {}; },
};
// ctx 桩：remote / uiWorkspace 都给上，让「切预设」与「新建会话」两条路都能被走到
let startedSessions = 0;
const selectedPresets = [];
const ctx = {
  slots: slotsStub,
  inject: () => () => {},
  effect: () => () => {},
  get: (name) => {
    if (name === 'remote') {
      return {
        agentPresets: {
          select: async (id, preset) => { selectedPresets.push([id, preset]); return { ok: true, value: preset }; },
        },
      };
    }
    if (name === 'uiWorkspace') return { startSession: () => { startedSessions++; } };
    return undefined;
  },
};

assert.equal(head.length, 0, 'apply 之前不应有样式（否则这个测试就没意义了）');
plugin.apply(ctx);
assert.equal(head.length, 1, 'apply 之后必须恰好注入一份样式表');

const style = head[0];
assert.equal(style.tagName, 'STYLE');
assert.equal(style.dataset.plugin, 'dsh-rp-tools', '样式表应带 plugin 标识，便于 devtools 辨认');
assert.ok(style.textContent.includes('.rph-btn'), '样式表里应含头部按钮的 .rph-btn 规则');
assert.ok(style.textContent.includes('.rpc'), '样式表里应含故事书导入的 .rpc 规则');
// 导入面板的两列布局必须随窄视口塌成一列，否则小窗口里列表会被压没
assert.ok(style.textContent.includes('.rpc .split'), '样式表里应含导入面板的 .split 两列布局');
assert.ok(/@media[^{]*\{\s*\.rpc \.split/.test(style.textContent), '.split 应有窄视口的单列降级');
// chip 必须与旁边 Story / DM 两枚官方 chip 同一套规格：无边框、16px 圆角、透明底、hover 用主题 token。
// 而且规则**不能带 .rpc 前缀** —— chip 会被 portal 到那一行里，那时它不在 .rpc 内部，
// 后代选择器一条都不命中，浏览器就给出默认的灰底方角按钮（用户截图里就是这个）。
const chipCss = /\.rpc-chip \{([^}]*)\}/.exec(style.textContent)?.[1] ?? '';
assert.ok(chipCss, '应有独立的 .rpc-chip 规则（不带 .rpc 前缀，portal 后仍命中）');
assert.ok(!/\.rpc \.chip[\s:{]/.test(style.textContent), 'chip 样式不能写成 .rpc .chip 规则（portal 之后不命中）');
assert.ok(/border:\s*none/.test(chipCss), 'chip 不该有边框（官方 chip 是透明底无边框）');
assert.ok(/border-radius:\s*16px/.test(chipCss), 'chip 圆角应与官方 chip 一致（16px）');
assert.ok(/font-weight:\s*500/.test(chipCss), 'chip 字重应与官方 chip 一致（500）');
assert.ok(/min-height:\s*28px/.test(chipCss), 'chip 高度应与官方 chip 一致（28px）');
assert.ok(style.textContent.includes('--dsw-alias-interactive-bg-hover'), 'chip 的 hover 应使用官方主题 token');

// 再调一次不能又插一份（幂等）
plugin.apply(ctx);
assert.equal(head.length, 1, '重复 apply 不应重复注入样式');

// 槽位注册：设置页 + 头部入口 + 输入框上方入口（三个都必须注册上）
assert.ok(registered.includes('settings.section'), '应注册设置页');
assert.ok(registered.includes('conversation.session.header.utilities'), '应注册头部右上角入口');
assert.ok(registered.includes('conversation.input.dock'), '应注册输入框上方的故事书导入入口');

const dockReg = slotRegs.find((r) => r.name === 'conversation.input.dock');
assert.ok(dockReg, 'conversation.input.dock 应有注册项');
assert.equal(dockReg.id, 'rp-card-import', '导入入口的槽位 id 应稳定（界面/测试都按它找）');
assert.equal(typeof dockReg.order, 'number', 'order 必须是数字，否则排序会退化');
assert.equal(typeof dockReg.component, 'function', '槽位必须注册组件本身（只注册 spec 等于没有界面）');

// ── 关键断言 ②：把导入组件真的渲染一遍 ─────────────────────────────────────
const SID = 'session-abc';
const actions = { drafts: [], submitted: 0 };
// 输入框草稿：setDraft 真的改它，useInput 真的读它 ——
// 组件的「等草稿同步再提交」那条路才会被走到（真实实现里 Lexical 编辑器就是这个角色）
const draftBox = { draft: '' };
const inputActions = {
  setDraft: (t) => { actions.drafts.push(t); draftBox.draft = t; },
  submit: () => { actions.submitted++; },
  addAttachments: () => true,
  removeAttachment: () => {},
  pruneAttachments: () => {},
};
function propsFor({ blank = true, preset = '', cwd = 'D:\\Story' } = {}) {
  const store = { current: SID, byId: { [SID]: { blank, cwd, projectionValues: preset ? { agentPreset: preset } : {} } } };
  return {
    sessionId: SID,
    useSessions: (sel) => sel(store),
    useInput: (sel) => sel(draftBox),
    inputActions,
    useWorkspaces: (sel) => sel({ items: [], phase: 'ready' }),
  };
}
const walk = (node, visit) => {
  if (node === null || node === undefined || node === false) return;
  if (Array.isArray(node)) { for (const n of node) walk(n, visit); return; }
  if (typeof node === 'string' || typeof node === 'number') { visit(node); return; }
  if (typeof node !== 'object') return;
  visit(node);
  walk(node.children, visit);
};
const findAll = (tree, pred) => {
  const out = [];
  walk(tree, (n) => { if (n && typeof n === 'object' && pred(n)) out.push(n); });
  return out;
};
const textOf = (tree) => {
  let s = '';
  walk(tree, (n) => { if (typeof n === 'string' || typeof n === 'number') s += String(n); });
  return s;
};
const byClass = (tree, cls) => findAll(tree, (n) => String(n.props?.className ?? '').split(/\s+/).includes(cls));
/**
 * 极小渲染器：槽位注册的是 `(props) => h(组件, props)`，所以拿到的是**元素**而不是
 * 渲染结果 —— 必须真的调用函数组件，才是「组件跑一遍」这件事本身。
 * 宿主元素（div/button…）原样保留子节点，供断言遍历。
 */
function renderNode(node) {
  if (node === null || node === undefined) return node;
  if (Array.isArray(node)) return node.map(renderNode);
  if (typeof node !== 'object') return node;
  if (typeof node.type === 'function') {
    const out = node.type({ ...node.props, children: node.children });
    return renderNode(out);
  }
  // 宿主元素：把 ref 绑到对应的假 DOM 节点上（组件靠它找「上一行」）
  if (node.props?.ref && typeof node.props.ref === 'object') {
    const isRoot = String(node.props.className ?? '').split(/\s+/).includes('rpc');
    try { node.props.ref.current = isRoot ? rootEl : holderFake; } catch { /* 只读 ref 忽略 */ }
  }
  return { type: node.type, props: node.props, children: (node.children ?? []).map(renderNode) };
}
/**
 * 渲染一趟 = 渲染 + 跑副作用 + （有 setState 就）重渲染。
 * React 的 useLayoutEffect 在**绘制前**跑，所以这里循环到稳定，
 * 组件的「先定位、再 portal」两步就都能被观察到。
 */
const render = (props, Component = dockReg.component) => {
  let tree = null;
  for (let pass = 0; pass < 4; pass++) {
    rt.dirty = false;
    resetSignals();
    tree = renderNode(Component(props));
    flushEffects();
    if (!rt.dirty) break;
  }
  return tree;
};
const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));
const importPosts = () => calls.filter((c) => c.url.startsWith('/rp-tools/card-import'));

{
  const DM_PROPS = () => propsFor({ blank: true, preset: 'dm' });

  // ① 折叠态：只有一枚 chip（而且被送进了「工作区 / DM 主持人」那一行）
  const tree = render(DM_PROPS());
  const chips = byClass(tree, 'rpc-chip');
  assert.equal(chips.length, 1, '折叠态应渲染一枚 chip');
  assert.ok(textOf(chips[0]).includes('导入故事书'), 'chip 文案应说明这是导入入口');
  assert.equal(byClass(tree, 'panel').length, 0, '折叠态不该渲染面板');
  const portals = findAll(tree, (n) => n.type === 'Portal');
  assert.equal(portals.length, 1, '入口应 portal 进「工作区 / DM 主持人」那一行');
  assert.equal(portals[0].props.container, rowEl, 'portal 的目标应是紧挨在 dock 之前的那一行');
  assert.equal(chips[0].props['data-row'], 'true', '送进那一行后应用矮一号的样式');

  // ② 只在不曾开局的 DM 新会话上出现
  assert.equal(render(propsFor({ blank: true, preset: 'novelist' })), null, '未开局但不是 DM 预设的会话不该出现入口');
  assert.equal(render(propsFor({ blank: true, preset: '' })), null, '预设还没投影出来时先不出现（避免闪一下又消失）');
  assert.equal(render(propsFor({ blank: false, preset: 'dm' })), null, '已经开局的 DM 会话不该出现入口');
  assert.equal(render(propsFor({ blank: false, preset: 'novelist' })), null, '非 DM 且已开局的会话应完全不渲染');

  // ③ 点开：面板铺开，并自动拉一次卡库
  byClass(render(DM_PROPS()), 'rpc-chip')[0].props.onClick();
  let tree2 = render(DM_PROPS());
  assert.equal(byClass(tree2, 'panel').length, 1, '展开后应渲染面板');
  await tick(40);
  tree2 = render(DM_PROPS());
  assert.ok(textOf(tree2).includes('3269'), '面板应显示卡库规模（fetch 回来之后）');
  const items = byClass(tree2, 'item');
  assert.equal(items.length, 1, '列表应渲染出卡片条目（fetch 桩返回 1 张）');
  assert.ok(textOf(items[0]).includes('长安'), '条目应显示卡名');

  // ④ 选卡 → 预览
  items[0].props.onClick();
  await tick(40);
  tree2 = render(DM_PROPS());
  const previewText = textOf(byClass(tree2, 'prev')[0] ?? tree2);
  assert.ok(previewText.includes('长安'), '预览应显示卡名');
  assert.ok(previewText.includes('世界书 12 条'), '预览应显示世界书条数');
  assert.ok(previewText.includes('备用开场白'), '预览应说明开场白来源（被广告污染的 first_mes 不能用）');
  const importBtn = findAll(tree2, (n) => String(n.props?.className ?? '').includes('primary')
    && textOf(n).includes('导入并开始'));
  assert.equal(importBtn.length, 1, '空白会话上按钮文案应是「导入并开始」');

  // ⑤ 导入：切 dm 预设 → POST 导入 → 把开场指令塞进输入框并提交
  importBtn[0].props.onClick();
  await tick(80);
  render(DM_PROPS());   // 编辑器把草稿同步好了 → 组件这一帧提交
  await tick(120);
  assert.equal(selectedPresets.length, 0, '会话已经是 dm 预设 → 不该再重复切一次（入口本来就只在 dm 新会话上出现）');
  assert.equal(importPosts().length, 1, '应 POST /rp-tools/card-import');
  assert.equal(importPosts()[0].body.path, 'cards/古风/长安.card.png', 'POST 应带上选中的卡路径');
  assert.equal(importPosts()[0].body.workspace, 'D:\\Story', 'POST 应带上会话工作区（宿主据此落盘）');
  assert.equal(actions.drafts.length, 1, '应把开场指令写进输入框');
  assert.ok(actions.drafts[0].includes('不要再问世界从哪来'), '开场指令必须拦住 dm persona 的开场提问');
  assert.equal(actions.submitted, 1, '开场指令应被提交（自动开始游戏）');
  assert.ok(!selectedPresets.some(([, p]) => p !== 'dm'), '只应切到 dm，不该切别的预设');
  assert.equal(startedSessions, 0, '空白 DM 会话上导入不该去新建会话');

  // ⑥ 开场指令一发出去会话就不再是空白 —— 此时面板必须留住（否则用户看不到导入结果）
  const after = render(propsFor({ blank: false, preset: 'dm' }));
  assert.equal(byClass(after, 'panel').length, 1, '导入进行中/刚导完时，即使会话已开局也要留住面板');
  assert.equal(byClass(after, 'rpc-chip').length, 1, '这时入口也还在（收起它之后才会消失）');
  assert.ok(textOf(after).includes('导入完成'), '面板应显示导入结果');
  assert.ok(textOf(after).includes('rp-worldbook.md'), '结果里应写出世界书文件名');

  // ⑦ 收起之后，入口就该彻底消失（会话已经不是新会话了）
  byClass(after, 'rpc-chip')[0].props.onClick();
  assert.equal(render(propsFor({ blank: false, preset: 'dm' })), null, '收起后入口应消失（已开局且非空白）');
}

// ── 关键断言 ③：两种宿主差异都要能贴到那一行 ───────────────────────────────
{
  const DM_PROPS = () => propsFor({ blank: true, preset: 'dm' });

  // ① dock 的条目外面套了一层容器（那一行不是根元素的直接上一兄弟）→ 要逐层往上找
  domVariant = 'wrapped';
  rt.cells = [];                       // 换一种 DOM 布局 = 重新挂载组件
  const wrapped = render(DM_PROPS());
  const portalsW = findAll(wrapped, (n) => n.type === 'Portal');
  assert.equal(portalsW.length, 1, '套了容器也要能找到那一行（逐层往上找）');
  assert.equal(portalsW[0].props.container, rowEl, 'portal 目标仍应是那一行');
  domVariant = 'direct';
  rt.cells = [];

  // ② 拿不到 react-dom → 退回「量出那一行的位置、把 chip 贴上去」，而不是自己占一行
  (0, eval)(source);                   // 再求值一次 bundle，拿一个新的 factory
  const plugin2 = captured.factory((name) => {
    if (name === 'react') return React;
    if (name === 'react-dom') throw new Error('no react-dom in this宿主');
    throw new Error(`未预期的 require: ${name}`);
  });
  const regs2 = [];
  plugin2.apply({
    slots: { inject: (k, cb) => { cb(); return () => {}; }, register: (spec, c) => { regs2.push({ ...spec, c }); return () => {}; } },
    inject: () => () => {},
    effect: () => () => {},
    get: () => undefined,
  });
  const dock2 = regs2.find((r) => r.name === 'conversation.input.dock');
  rt.cells = [];
  const noDom = render(DM_PROPS(), dock2.c);   // 注意：渲染的是**第二个实例**的组件
  const chips2 = byClass(noDom, 'rpc-chip');
  assert.equal(chips2.length, 1, '拿不到 react-dom 时 chip 仍要在（不能消失）');
  assert.equal(findAll(noDom, (n) => n.type === 'Portal').length, 0, '没有 react-dom 时不能走 portal');
  assert.equal(chips2[0].props['data-row'], 'true', '应仍按「在那一行里」的样式渲染');
  assert.equal(chips2[0].props.style?.position, 'fixed', '没有 portal 就用量出来的位置贴上去');
  assert.equal(chips2[0].props.style?.left, '306px', '横向应接在那一行最后一个 chip 后面（right+6）');
}

console.log('客户端冒烟测试通过：');
console.log(`  · bundle id = ${captured.id}`);
console.log(`  · apply 后样式表已注入（${style.textContent.length} 字符，含 .rph-btn / .rpc）`);
console.log(`  · 重复 apply 幂等`);
console.log(`  · 已注册槽位：${[...new Set(registered)].join(', ')}`);
console.log(`  · 故事书导入槽位：id=${dockReg.id} order=${dockReg.order}`);
console.log(`  · 无头渲染全流程通过：portal 进工作区那一行 / 只在未开局的 DM 新会话出现 / 列表 / 预览 / 导入 / 结果留存（共 ${calls.length} 次请求）`);
