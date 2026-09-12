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
// ⚠️ 槽位必须**按组件类型隔离**：早先所有组件共用一个 cells 数组，于是 A 组件的 state
//    落在 B 组件的槽位上 —— 我加了几个 hook 之后，dock 组件的 `open` 读到了 RP 面板的
//    `lib` 值，测试开始报「面板没打开」这种假失败（查了半天才发现是测试桩的锅）。
const rt = { cells: [], cellStore: new Map(), cursor: 0, effects: [], cleanups: [], dirty: false };
/** 重新挂载（等价于把整棵树卸载重来）：清掉所有组件的钩子状态。 */
function resetHooks() {
  rt.cellStore.clear();
  rt.cells = [];
  rt.cursor = 0;
  rt.effects = [];
  rt.cleanups = [];
  rt.dirty = false;
}
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
    const cells = rt.cells;                 // 捕获**本组件**的槽位数组（setState 可能在别处被调用）
    const i = rt.cursor++;
    if (!(i in cells)) cells[i] = typeof init === 'function' ? init() : init;
    // setState 后要重渲染：render() 靠 dirty 决定是否再跑一趟（模拟 React 的提交+重渲染）
    return [cells[i], (v) => { cells[i] = typeof v === 'function' ? v(cells[i]) : v; rt.dirty = true; }];
  },
  useRef(init) {
    const cells = rt.cells;
    const i = rt.cursor++;
    if (!(i in cells)) cells[i] = { current: init };
    return cells[i];
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
/** 立绘持久化的 POST 记录（面板里点「立绘」/「收起」时写会话配置）。 */
const portraitPosts = [];
/** `/rp-tools/session` 返回的会话配置：立绘用例会临时往里面塞角色与已持久化的立绘。 */
const sessionStub = {
  sessionId: 'session-abc', preset: 'dm', defaultStyle: null,
  campaign: { name: '长安', prompt_prefix: '' }, characters: [], characterIndex: [],
  tables: [], world: '天宝年间。', state: {}, styleNotes: '', portraits: {},
  // 会话宏表（面板的「宏 / 变量」卡片只显示值，不再提供加/删）
  macros: { user: '阿岚', place: '长安' },
};
/** `/rp-tools/state` 返回的全局配置（设置页/导入表单都读它）；空列表那条用例会临时改它。 */
const stateStub = {
  defaultStyle: 'manga', styles: { manga: { label: '黑白漫画' } }, comfyui: {}, negative: '',
  cards: { root: '', userLabel: '阿岚', macros: { user: '阿岚', place: '长安' } },
  // 全局图像尺寸（设置页「图像」里那三行）
  imageSizes: { scene: [1024, 576], portrait: [640, 896], item: [768, 768] },
  // 宿主给的自动宏名单（设置页要提示「哪些宏不用填」）
  autoMacros: ['time', 'date', 'datetime', 'isotime', 'localtime', 'timezone', 'weekday', 'year', 'month', 'day', 'hour', 'minute', 'second'],
};
/**
 * 宿主对「会话闸门」的回答（是不是 dm / 有没有开局）。
 *
 * 现实中这个答案跟着**活着的会话**走；测试里每个场景显式设定，因为要模拟的关键情形
 * 正是「客户端投影坏了、宿主是对的」（切预设会把投影基线重放、清掉没有的键）。
 */
let gateReply = { ok: true, dm: true, started: false };
globalThis.fetch = async (url, options = {}) => {
  const method = options.method ?? 'GET';
  calls.push({ url: String(url), method, body: options.body ? JSON.parse(options.body) : undefined });
  const target = String(url);
  const reply = (json) => ({ ok: true, status: 200, json: async () => json });
  if (target.startsWith('/rp-tools/gate')) return reply(gateReply);
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
      // 卡里扫到的宏名：导入表单只列这些（+ user），值用设置页的默认宏列表预填；
      // `year` 是自动宏（宿主每轮现算），界面要标「自动」而不是让人手填
      macros: [
        { name: 'user', count: 5, auto: false },
        { name: 'year', count: 4, auto: true },
        { name: 'place', count: 2, auto: false },
      ],
      // 占位符统计：预览里要在旁边解释每一类怎么被处理（char 展开 / 时间自动 / 其余已删）
      placeholders: { total: 3, counts: { '{{char}}': 2, '{{user}}': 1 } },
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
      placeholders: { total: 7, counts: { '{{user}}': 5, '{{char}}': 2 } },
      opening: '【开局】已导入卡组《长安》，不要再问世界从哪来，直接开团。',
    });
  }
  // ── 下面是 RP 面板（右侧栏页签）要用的几条 ──────────────────────────
  if (target.startsWith('/rp-tools/lore')) {
    const wanted = new URL(target, 'http://x').searchParams.get('title');
    // ?title= 取单条完整正文（编辑器展开时才要）
    if (wanted === '长安城') {
      return reply({
        ok: true,
        entry: { title: '长安城', keys: ['长安'], constant: false, order: 0, probability: 100, chars: 22, body: '天宝年间的长安城，坊市分明。' },
      });
    }
    if (wanted) return reply({ ok: false, error: `找不到条目：${wanted}` });
    return reply({
      ok: true, exists: true, file: 'D:\\Story\\rp-worldbook.md', relative: 'rp-worldbook.md',
      chars: 1234, total: 2, constant: 1, keyed: 1,
      entries: [
        { title: '长安城', keys: ['长安'], constant: false, order: 0, probability: 100, chars: 22, preview: '天宝年间的长安城，坊市分明。' },
        { title: '世界总纲', keys: [], constant: true, order: 0, probability: 100, chars: 30, preview: '盛唐末年，边镇不稳。' },
      ],
      note: '只有命中的条目才进每轮上下文。',
    });
  }
  if (target.startsWith('/rp-tools/session')) {
    return reply({
      ok: true, isDm: true, preset: 'dm',
      // 界面 ensureCwd 的兜底来源：会话工作区（真机上是 resolveWorkspaceDir 那四级链的结果）
      cwd: 'D:\\Story',
      session: sessionStub,
    });
  }
  if (target === '/rp-tools/portrait') {
    const body = JSON.parse(options.body ?? '{}');
    portraitPosts.push(body);
    const portraits = body.action === 'clear' ? {} : {
      [body.name]: {
        generated: { file: body.file, subfolder: body.subfolder ?? '', type: body.type ?? 'output' },
        style: body.style ?? '', elapsedMs: body.elapsedMs ?? 0,
      },
    };
    return reply({ ok: true, sessionId: body.sessionId, portraits });
  }
  if (target === '/rp-tools/preview') {
    return reply({
      ok: true, styleKey: 'uncensored_anime', styleLabel: '二次元', elapsedMs: 18300,
      media: ['http://127.0.0.1:3080/rp-tools/media?file=rp-portrait-9.png'],
      // 宿主新增：原始三要素，界面据此把立绘记进会话配置（只存 URL 的话换 origin 就失效）
      files: [{ file: 'rp-portrait-9.png', subfolder: '', type: 'output' }],
    });
  }
  if (target.startsWith('/rp-tools/state')) {
    return reply({
      ok: true, file: 'C:\\...\\styles.json',
      // 默认宏列表（设置页）：导入表单的预填值来源。userLabel 是宿主同步出来的老字段。
      // stateStub 可变：空列表那条用例会临时清空它。
      config: stateStub,
      // 自动宏名单（顶层字段，设置页用它提示「哪些宏不用填」）
      autoMacros: stateStub.autoMacros,
      styles: [{ key: 'manga', label: '黑白漫画', builtin: true }],
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
// 宿主转发给客户端的事件（`remote.$on`）：预设切换就靠它触发「重新判断入口」
const remoteEventHandlers = new Map();
const ctx = {
  slots: slotsStub,
  // 右栏那两个服务：回调要真的跑，否则 `sidebar.right.pane.tab` 不会被注册（面板也就无从渲染）
  inject: (names, fn) => {
    if (typeof fn === 'function' && Array.isArray(names) && names.includes('sidebarRightTabs')) {
      fn({
        slots: slotsStub,
        sidebarRightTabs: { register: () => () => {} },
        sidebarRight: { openTab: () => {}, isExpanded: () => false, active: () => null },
      });
    }
    return () => {};
  },
  effect: () => () => {},
  get: (name) => {
    if (name === 'remote') {
      return {
        agentPresets: {
          select: async (id, preset) => { selectedPresets.push([id, preset]); return { ok: true, value: preset }; },
        },
        // 与官方客户端插件同一个用法：ctx.remote.$on(event, listener) → 返回退订函数
        $on: (event, listener) => {
          if (!remoteEventHandlers.has(event)) remoteEventHandlers.set(event, new Set());
          remoteEventHandlers.get(event).add(listener);
          return () => remoteEventHandlers.get(event)?.delete(listener);
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
function propsFor({ blank = true, preset = '', cwd = 'D:\\Story', sid = SID } = {}) {
  const store = { current: sid, byId: { [sid]: { blank, cwd, projectionValues: preset ? { agentPreset: preset } : {} } } };
  return {
    sessionId: sid,
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
    // 每个组件类型有自己的钩子槽位（见 rt 的注释）；游标按组件归零
    const prevCells = rt.cells;
    const prevCursor = rt.cursor;
    if (!rt.cellStore.has(node.type)) rt.cellStore.set(node.type, []);
    rt.cells = rt.cellStore.get(node.type);
    rt.cursor = 0;
    let out;
    try {
      out = node.type({ ...node.props, children: node.children });
    } finally {
      rt.cells = prevCells;
      rt.cursor = prevCursor;
    }
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
  // 闸门答复要跟着场景走（现实中宿主就是活的会话本身，答案自然一致）
  gateReply = { ok: true, dm: false, started: false };
  assert.equal(render(propsFor({ blank: true, preset: 'novelist' })), null, '未开局但不是 DM 预设的会话不该出现入口');
  assert.equal(render(propsFor({ blank: true, preset: '' })), null, '预设还没投影出来时先不出现（避免闪一下又消失）');
  gateReply = { ok: true, dm: true, started: true };
  assert.equal(render(propsFor({ blank: false, preset: 'dm' })), null, '已经开局的 DM 会话不该出现入口');
  gateReply = { ok: true, dm: false, started: true };
  assert.equal(render(propsFor({ blank: false, preset: 'novelist' })), null, '非 DM 且已开局的会话应完全不渲染');

  // ②-b ★ 用户报的 bug：dm → 别的预设 → 切回 dm，入口就不见了。
  // 根因是可见性只信客户端投影，而切预设会重建投影基线、把没有的键清掉。
  {
    gateReply = { ok: true, dm: true, started: false };     // 切回 dm 后宿主看到的事实
    const before = render(DM_PROPS());
    assert.equal(byClass(before, 'rpc-chip').length, 1, '切走之前入口在');
    gateReply = { ok: true, dm: false, started: false };
    assert.equal(render(propsFor({ blank: true, preset: 'novelist' })), null, '切到别的预设后入口应消失（不是 DM 了）');
    gateReply = { ok: true, dm: true, started: false };
    const back = render(DM_PROPS());
    assert.ok(back !== null, '切回 dm 后入口必须回来');
    assert.equal(byClass(back, 'rpc-chip').length, 1, '切回 dm 后应重新出现导入入口');
  }
  gateReply = { ok: true, dm: true, started: false };

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
  // ★ 卡面只在**选中**这张时加载：列表里一张图都不请求，预览里只有这一张。
  //   （用户明确说「选中再看」——几十张几 MB 的卡同时拉会拖死两端。）
  const listImgs = findAll(byClass(tree2, 'list')[0] ?? [], (n) => n.type === 'img');
  assert.equal(listImgs.length, 0, '列表里不该有缩略图（只在选中后加载）');
  const faceImgs = byClass(tree2, 'face');
  assert.equal(faceImgs.length, 1, '预览区应有且仅有一张卡面');
  const faceSrc = String(faceImgs[0].props.src ?? '');
  assert.ok(faceSrc.startsWith('/rp-tools/card-image?'), '卡面要走宿主的卡面路由');
  assert.ok(faceSrc.includes('thumb=1'), '卡面要请求服务端降采样版本（卡 PNG 可能几 MB）');
  assert.ok(faceSrc.includes('width=420'), '降采样宽度要收敛到 420');
  assert.ok(faceSrc.includes(`sessionId=${SID}`), '卡面请求要带会话身份');
  assert.equal(faceImgs[0].props.loading, 'lazy', '卡面要懒加载');
  assert.ok(previewText.includes('世界书 12 条'), '预览应显示世界书条数');
  assert.ok(previewText.includes('备用开场白'), '预览应说明开场白来源（被广告污染的 first_mes 不能用）');
  const importBtn = findAll(tree2, (n) => String(n.props?.className ?? '').includes('primary')
    && textOf(n).includes('导入并开始'));
  assert.equal(importBtn.length, 1, '空白会话上按钮文案应是「导入并开始」');
  // 宏：导入表单按「只填值」来 —— 名字来自卡里的占位符，**不能加也不能删**
  assert.ok(previewText.includes('宏（3）'), '宏区块要显示条数（user + year + place）');
  assert.ok(previewText.includes('{{user}}'), true);
  assert.equal(previewText.includes('＋ 添加宏'), false, '导入表单不再提供「添加宏」');
  assert.equal(findAll(tree2, (n) => typeof n.props?.onClick === 'function' && textOf(n) === '×').length, 0,
    '导入表单不能删宏（名字要和卡对得上）');
  assert.ok(previewText.includes('默认宏列表'), '要说明值来自设置页的默认宏列表');
  // 占位符统计旁边要有「每一类怎么处理」的说明（用户问过「char 是什么、为什么不用填」）
  assert.ok(previewText.includes('{{char}}') && previewText.includes('展开成卡名'), '要说明 {{char}} 已展开成卡名');
  assert.ok(previewText.includes('随机') || previewText.includes('{{random:…}}'), '要说明带参数的占位符会被抽掉');
  assert.ok(previewText.includes('已删除'), '要说明不合法的占位符被删掉');
  // 自动宏（这里是 {{year}}）：标「自动」+ 说明留空即自动，不要求手填
  assert.ok(previewText.includes('{{year}}'), '卡里扫到的自动宏也要列出来');
  assert.ok(previewText.includes('自动'), '自动宏要标出「自动」');
  const yearRow = byClass(tree2, 'macrorow').find((row) => textOf(row).includes('{{year}}'));
  assert.ok(yearRow, '应能找到 year 那一行');
  assert.equal(String(yearRow.props['data-auto']), 'true', '自动宏那行要有 data-auto 标记');
  const yearInput = findAll(yearRow, (n) => n.type === 'input')[0];
  assert.equal(yearInput.props.placeholder, '留空 = 自动', '自动宏的占位提示应说明留空即自动');
  // 导入表单只列**卡里真出现**的宏（+ user），值用设置页「默认宏列表」预填：
  // 卡里扫到 place → 用默认值「长安」；默认列表里其它键不会凭空塞进来。
  assert.ok(previewText.includes('{{place}}'), '卡里扫到的宏要出现在导入表单');
  assert.ok(previewText.includes('预设'), '来自默认宏列表的值要标出「预设」');
  const macroInputs = findAll(tree2, (n) => n.type === 'input' && ['阿岚', '长安'].includes(n.props.value));
  assert.ok(macroInputs.some((n) => n.props.value === '长安'), '进入表单的宏要用默认宏列表预填值');
  assert.ok(macroInputs.some((n) => n.props.value === '阿岚'), 'user 也要带上默认值');

  // ④-b 读盘的卡路由**必须带上会话身份**。
  // ⚠️ 真事故：`API.card` 曾写成 `card: (path) => ...`，把调用点传的 workspace 悄悄吞掉，
  //    请求里只剩 `?path=`，宿主无从判断「哪个会话的卡库」→ 根目录落空 →
  //    `resolve('')` = 进程 cwd → `stat '<AppData>\同人\某卡.png'` 的 ENOENT。
  const cardGets = calls.filter((c) => c.url.startsWith('/rp-tools/card?'));
  assert.ok(cardGets.length >= 1, '预览应发出 /rp-tools/card 请求');
  for (const c of cardGets) {
    assert.ok(c.url.includes(`sessionId=${SID}`), `卡预览必须带 sessionId（实际：${c.url}）`);
    assert.ok(c.url.includes('workspace='), `卡预览必须带 workspace（实际：${c.url}）`);
  }
  const cardListGets = calls.filter((c) => c.url.startsWith('/rp-tools/cards?'));
  assert.ok(cardListGets.length >= 1, '展开面板应拉过卡库列表');
  for (const c of cardListGets) {
    assert.ok(c.url.includes(`sessionId=${SID}`), `卡库列表必须带 sessionId（实际：${c.url}）`);
  }

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

  // ⑥ 导入成功后**面板要自己收起来**（不然开团都开始了，它还占着屏幕中间挡正文）；
  //    会话这时已经不再是新会话，于是入口也一并消失。
  const after = render(propsFor({ blank: false, preset: 'dm' }));
  assert.equal(after, null, '导入成功后入口应消失（既已开局、又不是新会话）');
  // 还在新会话状态下（会话尚未落盘为「已开始」）时，面板也应已收起
  const stillBlank = render(DM_PROPS());
  assert.equal(byClass(stillBlank, 'panel').length, 0, '导入成功后面板应自动收起');
  assert.equal(byClass(stillBlank, 'rpc-chip').length, 1, '新会话上入口还在，用户想再导一张可以直接点开');
  // 结果仍在（再点开能看到），不是把状态丢了
  byClass(stillBlank, 'rpc-chip')[0].props.onClick();
  const reopened = render(DM_PROPS());
  assert.ok(textOf(reopened).includes('rp-worldbook.md'), '再点开仍能看到上一次的导入结果');
}

// ── 关键断言 ③：两种宿主差异都要能贴到那一行 ───────────────────────────────
{
  const DM_PROPS = () => propsFor({ blank: true, preset: 'dm' });

  // ① dock 的条目外面套了一层容器（那一行不是根元素的直接上一兄弟）→ 要逐层往上找
  domVariant = 'wrapped';
  resetHooks();                       // 换一种 DOM 布局 = 重新挂载组件
  const wrapped = render(DM_PROPS());
  const portalsW = findAll(wrapped, (n) => n.type === 'Portal');
  assert.equal(portalsW.length, 1, '套了容器也要能找到那一行（逐层往上找）');
  assert.equal(portalsW[0].props.container, rowEl, 'portal 目标仍应是那一行');
  domVariant = 'direct';
  resetHooks();

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
  resetHooks();
  const noDom = render(DM_PROPS(), dock2.c);   // 注意：渲染的是**第二个实例**的组件
  const chips2 = byClass(noDom, 'rpc-chip');
  assert.equal(chips2.length, 1, '拿不到 react-dom 时 chip 仍要在（不能消失）');
  assert.equal(findAll(noDom, (n) => n.type === 'Portal').length, 0, '没有 react-dom 时不能走 portal');
  assert.equal(chips2[0].props['data-row'], 'true', '应仍按「在那一行里」的样式渲染');
  assert.equal(chips2[0].props.style?.position, 'fixed', '没有 portal 就用量出来的位置贴上去');
  assert.equal(chips2[0].props.style?.left, '306px', '横向应接在那一行最后一个 chip 后面（right+6）');
}

// ── 关键断言 ④：RP 面板要能看到世界书条目（用户提的问题）───────────────────
{
  const tab = slotRegs.find((r) => r.name === 'sidebar.right.pane.tab');
  assert.ok(tab, '应注册右侧栏面板页签（RP 面板本体）');
  resetHooks();
  const store = { current: SID, byId: { [SID]: { blank: false, cwd: 'D:\\Story', projectionValues: { agentPreset: 'dm' } } } };
  const panel = render({
    sessionId: SID,
    useSessions: (sel) => sel(store),
    useInput: (sel) => sel({ draft: '' }),
    inputActions,
  }, tab.component);
  assert.ok(panel, 'DM 会话下 RP 面板应渲染');
  await tick(60);              // 等 reload() 里的 session / state / lore 三个请求回来
  // 注意：**不能**清 rt.cells —— 那是组件自己的 state（draft/lore 都在里面），
  // 清掉等于重新挂载，界面会退回「读取中…」，什么都断言不到。
  const panel2 = render({
    sessionId: SID,
    useSessions: (sel) => sel(store),
    useInput: (sel) => sel({ draft: '' }),
    inputActions,
  }, tab.component);
  const text = textOf(panel2);
  assert.ok(text.includes('世界书（2 条）'), '面板应显示世界书条目数（含导入进来的那些）');
  assert.ok(text.includes('长安城'), '面板应列出世界书条目标题');
  assert.ok(text.includes('世界总纲') && text.includes('常驻'), '面板应标出常驻条目');
  // 折叠态只留一行：名称 / 徽标 / 字数 + 常驻开关 + 详情按钮；触发词与正文都收进详情里
  assert.equal(text.includes('触发词：长安'), false, '折叠态不该铺开触发词行');
  assert.equal(text.includes('天宝年间的长安城，坊市分明。'), false, '折叠态不该铺开正文');
  assert.ok(/\d+ 字/.test(text), '折叠态应显示字数');
  assert.ok(text.includes('rp-worldbook.md'), '面板应给出世界书文件路径');
  // 没有随机表时，那张「RP 表格 / 随机表（0）」卡片不该出现（用户要求去掉）
  assert.equal(text.includes('RP 表格'), false, '没有表时不应渲染「RP 表格 / 随机表（0）」');

  // 每条都要能就地改「常驻」、能打开详情编辑、能新建
  const boxes = findAll(panel2, (n) => n.type === 'input' && n.props.type === 'checkbox');
  assert.ok(boxes.length >= 2, '每个条目应有「常驻」复选框');
  assert.ok(textOf(panel2).includes('＋ 新建条目'), '面板应有新建条目入口');
  const editBtns = findAll(panel2, (n) => typeof n.props?.onClick === 'function' && textOf(n) === '详情 / 编辑');
  assert.equal(editBtns.length, 2, '每个条目应有「详情 / 编辑」按钮');

  // 点「编辑」→ 取回完整正文 → 展示表单（标题/触发词/常驻/order/概率/正文）
  await editBtns[0].props.onClick();
  await tick(60);
  const withForm = render({
    sessionId: SID,
    useSessions: (sel) => sel(store),
    useInput: (sel) => sel({ draft: '' }),
    inputActions,
  }, tab.component);
  const formText = textOf(withForm);
  assert.ok(formText.includes('触发词（逗号分隔）'), '详情里应有触发词输入');
  assert.ok(formText.includes('常驻（不看触发词）'), '详情里应有常驻开关');
  assert.ok(formText.includes('order'), '详情里应有 order');
  assert.ok(formText.includes('概率'), '详情里应有概率');
  // 完整正文在正文输入框里（textarea 的 value 是 prop，textOf 看不到，得直接断言 value）
  const bodyArea = findAll(withForm, (n) => n.type === 'textarea' && String(n.props.className ?? '').includes('lorebody'));
  assert.equal(bodyArea.length, 1, '详情里应有正文输入框');
  assert.equal(bodyArea[0].props.value, '天宝年间的长安城，坊市分明。', '详情里应带出完整正文（不是 160 字预览）');
  assert.ok(formText.includes('触发词：长安'), '详情里应显示触发词');

  // ⚠️ 回归：展开之后按钮要能**收起**（第一版这里永远调 beginLore → 只能展开、收不起来）
  const collapseBtn = findAll(withForm, (n) => typeof n.props?.onClick === 'function'
    && textOf(n) === '收起' && String(n.props.className ?? '').includes('tiny'));
  assert.equal(collapseBtn.length, 1, '展开后该条按钮应变成「收起」');
  collapseBtn[0].props.onClick();
  const collapsed = render({
    sessionId: SID,
    useSessions: (sel) => sel(store),
    useInput: (sel) => sel({ draft: '' }),
    inputActions,
  }, tab.component);
  assert.equal(findAll(collapsed, (n) => n.type === 'textarea' && String(n.props.className ?? '').includes('lorebody')).length, 0,
    '点「收起」后详情表单应消失');
  assert.ok(formText.includes('删除条目'), '详情里应有删除');
  assert.ok(text.includes('世界设定'), '卡片标题应是「世界设定」');
  assert.equal(text.includes('世界 / 战役设定'), false, '不该再出现旧标题');
  // 诊断行：把「界面看到的」和「宿主说的」摆在一起。导入入口两度消失都栽在这两个值不一致上，
  // 留着它下次能一眼看出是哪边不对（这行本身也是「宿主说了算」那条路的现场证据）。
  assert.ok(text.includes('入口判据'), '面板里应有入口判据诊断行');
  assert.ok(text.includes('宿主：预设'), '诊断行要显示宿主侧的预设');
  // 「看不全」那次的教训：右侧栏很窄，正文框必须给足高度，列表也要按视口给高度
  assert.ok(/\.rpt \.loreform textarea\.lorebody \{[^}]*min-height:\s*2\d\dpx/.test(style.textContent),
    '正文输入框要有足够高度（≥200px）');
  assert.ok(/\.rpt \.lorelist \{[^}]*max-height:\s*min\(/.test(style.textContent),
    '条目列表要按视口给高度，不能压成固定 260px');

  // 改「常驻」→ 保存 → 应 PUT 回宿主（POST /rp-tools/lore，action=update）
  const form = findAll(withForm, (n) => n.type === 'input' && n.props.type === 'text'
    && n.props.value === '长安城');
  assert.equal(form.length, 1, '详情里应能改标题');
  const boxes2 = findAll(withForm, (n) => n.type === 'input' && n.props.type === 'checkbox');
  boxes2[0].props.onChange({ target: { checked: true } });      // 勾上常驻
  // 注意：面板顶部还有一个「保存」（保存会话配置），要按 class 区分出表单里的那个
  const saveBtn = findAll(withForm, (n) => typeof n.props?.onClick === 'function'
    && textOf(n) === '保存' && String(n.props.className ?? '').includes('tiny'));
  assert.equal(saveBtn.length, 1, '详情里应有保存按钮');
  await saveBtn[0].props.onClick();
  await tick(60);
  const lorePost = calls.filter((c) => c.url === '/rp-tools/lore' && c.method === 'POST').pop();
  assert.ok(lorePost, '保存应向 /rp-tools/lore 发 POST');
  assert.equal(lorePost.body.action, 'update', '编辑已有条目应走 update');
  assert.equal(lorePost.body.title, '长安城', 'update 应带上原名（改名时用它定位）');
  assert.equal(lorePost.body.entry.constant, true, '勾选状态应写进 constant');

  // ★ 面板里**不再**有故事书导入（用户明确要求去掉）：导入入口只剩工作区那一行的 chip。
  {
    assert.equal(findAll(panel2, (n) => textOf(n) === '展开卡库').length, 0, '面板里不该再出现「展开卡库」');
    assert.equal(text.includes('PNG 故事书导入'), false, '面板里不该再出现「PNG 故事书导入」卡片');
  }

  // ★ 面板里的宏：**只改值**（不许加、不许删）—— 名字来自卡里的占位符 / 设置页的默认宏列表，
  //   在面板里改名或加宏都会与卡对不上；要加宏去设置页「默认宏列表」（那里的名字可改）。
  {
    assert.equal(findAll(panel2, (n) => textOf(n) === '＋ 添加宏').length, 0, '面板里不该再有「＋ 添加宏」');
    assert.equal(text.includes('宏名（小写字母/数字/下划线）'), false, '面板里不该再有宏名输入框');
    const macroRows = byClass(panel2, 'macrorow');
    assert.ok(macroRows.length >= 1, '宏要有行');
    for (const row of macroRows) {
      assert.equal(findAll(row, (n) => n.type === 'button').length, 0, '宏行不该有删除按钮');
      assert.equal(findAll(row, (n) => n.type === 'input').length, 1, '宏行只有值一个输入框');
    }
  }

  // ★ 人物卡片：标题叫「人物」（不叫「角色卡」）；**有立绘就两列、图在左**
  {
    assert.ok(text.includes('人物（'), '卡片标题应叫「人物」');
    assert.equal(text.includes('角色卡（'), false, '不该再叫「角色卡」');
    // 会话里那个角色带了一张**卡面**（登记在 session.portraits[name].card，导入卡时写进去的）
    sessionStub.characters = [{ name: '阿岚', appearance: '白衣长剑' }];
    sessionStub.portraits = { 阿岚: { card: 'cards/古风/长安.card.png' } };
    resetHooks();
    let withFace = render({
      sessionId: SID,
      useSessions: (sel) => sel(store),
      useInput: (sel) => sel({ draft: '' }),
      inputActions,
    }, tab.component);
    for (let i = 0; i < 14 && byClass(withFace, 'charface').length === 0; i++) {
      await tick(30);
      withFace = render({
        sessionId: SID,
        useSessions: (sel) => sel(store),
        useInput: (sel) => sel({ draft: '' }),
        inputActions,
      }, tab.component);
    }
    const box = byClass(withFace, 'charbox')[0];
    assert.ok(box, '应渲染出人物行');
    assert.equal(box.props['data-hasface'], 'true', '有图的人物行要标 data-hasface');
    const face = byClass(withFace, 'charface')[0];
    assert.ok(face, '有图时应有左列 charface');
    const faceImg = findAll(face, (n) => n.type === 'img');
    assert.equal(faceImg.length, 1, '左列恰好一张图');
    assert.ok(String(faceImg[0].props.src).includes('/rp-tools/card-image?'), '图片走卡面路由');
    // 顺序即布局：face 必须在 body 之前（图在左、字在右）
    const kids = (box.children ?? []).map((n) => String(n?.props?.className ?? ''));
    assert.ok(kids.indexOf('charface') >= 0 && kids.indexOf('charbody') > kids.indexOf('charface'),
      `DOM 顺序应是 charface → charbody（实际 ${JSON.stringify(kids)}）`);
    assert.ok(/\.rpt \.charbox\[data-hasface='true'\]/.test(style.textContent), '样式里要有「有图两列」的规则');
    // 还原
    sessionStub.portraits = {
      阿岚: {
        generated: { file: 'rp-portrait-1.png', subfolder: 'rp', type: 'output' },
        style: '二次元', elapsedMs: 18300, at: '2026-09-12T01:00:00.000Z',
      },
    };
    resetHooks();
  }

  // ★ 立绘持久化（用户报的「角色卡生成的立绘下次打开就消失了」）：
  //   会话配置里记着的生成图，面板**重新打开**时必须装回来；出图后也必须写回会话配置，
  //   否则下次打开又没了（原先它只活在面板组件的 state 里）。
  {
    const asPanel = () => render({
      sessionId: SID,
      useSessions: (sel) => sel(store),
      useInput: (sel) => sel({ draft: '' }),
      inputActions,
    }, tab.component);

    // 往会话配置里放「一个角色 + 一张已持久化的立绘」，然后重新挂载面板 —— 模拟下次打开
    sessionStub.characters = [{ name: '阿岚', appearance: '白衣长剑' }];
    sessionStub.portraits = {
      阿岚: {
        generated: { file: 'rp-portrait-1.png', subfolder: 'rp', type: 'output' },
        style: '二次元', elapsedMs: 18300, at: '2026-09-12T01:00:00.000Z',
      },
    };
    resetHooks();
    let reopened = asPanel();
    for (let i = 0; i < 14 && !textOf(reopened).includes('立绘：阿岚'); i++) {
      await tick(30);
      reopened = asPanel();
    }
    const imgs = findAll(reopened, (n) => n.type === 'img');
    const portraitImg = imgs.find((n) => String(n.props.src ?? '').includes('/rp-tools/media?'));
    assert.ok(portraitImg, `重新打开面板应显示会话配置里那张立绘（实际 imgs=${JSON.stringify(imgs.map((n) => n.props.src))}）`);
    assert.ok(String(portraitImg.props.src).includes('file=rp-portrait-1.png'), '立绘图 URL 要用记下的三要素拼');
    assert.ok(String(portraitImg.props.src).includes('subfolder=rp'), 'subfolder 也要带上');

    // 出图 → 必须把三要素 POST 回宿主（否则下次打开又没了）
    const portraitBtn = findAll(reopened, (n) => typeof n.props?.onClick === 'function' && textOf(n) === '立绘');
    assert.equal(portraitBtn.length, 1, '角色卡应有「立绘」按钮');
    await portraitBtn[0].props.onClick();
    let afterGen = asPanel();
    for (let i = 0; i < 14 && portraitPosts.length === 0; i++) { await tick(30); afterGen = asPanel(); }
    assert.equal(portraitPosts.length, 1, '出图后应把立绘记进会话配置（POST /rp-tools/portrait）');
    assert.equal(portraitPosts[0].file, 'rp-portrait-9.png', '要记的是 ComfyUI 的文件名，不是完整 URL');
    assert.equal(portraitPosts[0].name, '阿岚', '要记在角色名下');
    assert.equal(portraitPosts[0].style, '二次元', '风格一起记下来');

    // 点「收起」→ 会话配置那份也要清（否则下次打开又装回来）
    let hidden = afterGen;
    for (let i = 0; i < 14 && !findAll(hidden, (n) => typeof n.props?.onClick === 'function' && textOf(n) === '收起').length; i++) {
      await tick(30);
      hidden = asPanel();
    }
    const hideBtn = findAll(hidden, (n) => typeof n.props?.onClick === 'function' && textOf(n) === '收起');
    assert.ok(hideBtn.length >= 1, '出图后应有「收起」按钮');
    hideBtn[hideBtn.length - 1].props.onClick();
    for (let i = 0; i < 14 && !portraitPosts.some((p) => p.action === 'clear'); i++) await tick(30);
    const clearPost = portraitPosts.find((p) => p.action === 'clear');
    assert.ok(clearPost, '「收起」要同时清掉会话配置里那份立绘');
    assert.equal(clearPost.name, '阿岚', '清除要指名道姓（按角色名）');

    // 还原，免得影响后面的用例
    sessionStub.characters = [];
    sessionStub.portraits = {};
    resetHooks();
  }
}
// ── 关键断言 ⑤：会话工作区「界面不知道」时必须回宿主问 ──────────────────────
// 真机上就是这么没的：会话列表投影里没有 cwd（刚新建 / 列表还没回来 / 重启后恢复），
// 而宿主那边也只记内存。两处都不知道 → 卡库根落空。这里钉住界面这一半的兜底：
// cwd 缺失 → 必须去 /rp-tools/session 问一次，并把拿到的 cwd 用在后续读盘请求上。
{
  const tab = slotRegs.find((r) => r.name === 'conversation.input.dock');
  calls.length = 0;                 // 只关心这一段发出的请求
  resetHooks();                    // 重新挂载，清掉上一步的面板状态
  const noCwd = () => propsFor({ blank: true, preset: 'dm', cwd: '' });
  byClass(render(noCwd(), tab.component), 'rpc-chip')[0].props.onClick();
  // 兜底路径要等「问宿主 → 再拉卡库」两跳，所以轮询到稳定再断言（定长 tick 不够稳）
  let tree = render(noCwd(), tab.component);
  for (let i = 0; i < 12 && !textOf(tree).includes('3269'); i++) {
    await tick(30);
    tree = render(noCwd(), tab.component);
  }
  assert.ok(textOf(tree).includes('3269'), `拿不到 cwd 时面板仍要能列出卡库（实际：${textOf(tree).slice(0, 80)}）`);
  const listGet = calls.filter((c) => c.url.startsWith('/rp-tools/cards?')).pop();
  assert.ok(listGet, '应拉过卡库列表');
  assert.ok(/workspace=D%3A%5CStory|workspace=D:\\Story/.test(listGet.url),
    `cwd 缺失时应先用 /rp-tools/session 问回来再列卡库（实际：${listGet.url}）`);
  assert.ok(calls.some((c) => c.url.startsWith('/rp-tools/session?')), 'cwd 缺失时应问过 /rp-tools/session');
  // 预览请求同样要带上问回来的 cwd
  byClass(tree, 'item')[0].props.onClick();
  await tick(60);
  const prevGet = calls.filter((c) => c.url.startsWith('/rp-tools/card?')).pop();
  assert.ok(prevGet && prevGet.url.includes(`sessionId=${SID}`), '预览要带 sessionId');
  assert.ok(prevGet.url.includes('workspace='), `预览要带上问回来的 cwd（实际：${prevGet.url}）`);
}

// ── 关键断言 ⑥：投影被清空时，靠宿主闸门把入口救回来 ─────────────────────────
// 这是用户报的 bug 的**根因场景**：切预设会重建投影基线、清掉基线里没有的键，
// 于是 `projectionValues.agentPreset` 读成空串 —— 只看投影的判定会让入口永久消失。
// 宿主手里是活着的会话对象，所以它必须能推翻投影。
{
  const tab = slotRegs.find((r) => r.name === 'conversation.input.dock');
  const waitFor = async (view, wanted) => {
    let tree = render(view(), tab.component);
    for (let i = 0; i < 14 && byClass(tree, 'rpc-chip').length !== wanted; i++) {
      await tick(30);
      tree = render(view(), tab.component);
    }
    return tree;
  };

  // ① 投影里预设被清空（切预设后的真实后果）→ 宿主说 dm + 未开局 → 入口要回来
  resetHooks();
  gateReply = { ok: true, dm: true, started: false };
  const noPreset = () => propsFor({ blank: true, preset: '', sid: 'session-cleared-preset' });
  assert.equal(byClass(await waitFor(noPreset, 1), 'rpc-chip').length, 1,
    '投影里没有预设时，宿主说 dm 就该把入口显示出来');

  // ② 摘要被当成「已开局」→ 宿主说还没开局 → 仍以宿主为准
  resetHooks();
  const startedBlank = () => propsFor({ blank: false, preset: 'dm', sid: 'session-blank-cleared' });
  assert.equal(byClass(await waitFor(startedBlank, 1), 'rpc-chip').length, 1,
    '摘要说已开局、宿主说没开局时，应以宿主为准');

  // ③ 两侧都说「已开局」→ 藏起来（别把入口挂在已开局的会话上）
  resetHooks();
  gateReply = { ok: true, dm: true, started: true };
  const reallyStarted = () => propsFor({ blank: false, preset: 'dm', sid: 'session-really-started' });
  assert.equal(byClass(await waitFor(reallyStarted, 0), 'rpc-chip').length, 0,
    '两侧都说已开局 → 入口必须藏起来');

  // ④ 只有一侧说已开局 → **显示**。方向是刻意的：入口少显示一次用户就找不回来
  //    （连着报过两次「按钮不见了」），多显示一次最坏是点进去发现要新建会话。
  resetHooks();
  const splitVerdict = () => propsFor({ blank: true, preset: 'dm', sid: 'session-split-verdict' });
  assert.equal(byClass(await waitFor(splitVerdict, 1), 'rpc-chip').length, 1,
    '界面说未开局、宿主说已开局时宁可显示（用户找不回入口的代价更大）');
  gateReply = { ok: true, dm: true, started: false };

  // ⑤ ★ 用户报的正解：新对话首屏切走预设再切回 dm，**不刷新页面**按钮也要回来。
  // 现象是「值都对、刷新就回来」——说明不是数据错，而是切换后**没有重新判断**：
  // 客户端那份投影在切走之后可能不再更新，组件入参一个都没变 → 不重渲染 → 按钮永久消失。
  // 修法是订阅宿主广播的 `agent-preset/selected`（官方客户端插件也是用 `remote.$on` 收它）。
  {
    resetHooks();
    const SID_SWITCH = 'session-preset-switch';
    // 切回 dm 后的真实状态：宿主说 dm / 未开局；而**客户端投影仍是旧值**（模拟它不更新）
    const stale = () => propsFor({ blank: true, preset: 'novelist', sid: SID_SWITCH });
    gateReply = { ok: true, dm: false, started: false };
    const hidden = await waitFor(stale, 0);
    assert.equal(byClass(hidden, 'rpc-chip').length, 0, '切到别的预设后入口应消失');

    // 现在宿主那边切回了 dm。**先不广播**：只是重渲染（props 完全没变）不该让它出现 ——
    // 这一条是「事件确实是必要的」的反证，否则这个用例可能在测别的东西。
    gateReply = { ok: true, dm: true, started: false };
    for (let i = 0; i < 3; i++) { await tick(30); render(stale, tab.component); }
    assert.equal(byClass(render(stale, tab.component), 'rpc-chip').length, 0,
      '只是重渲染、没有广播事件时，入口不该自己冒出来（说明用例确实在测事件这条通道）');

    // 广播事件 → 客户端必须重新问一次宿主并重新判断
    const handlers = remoteEventHandlers.get('agent-preset/selected');
    assert.ok(handlers && handlers.size >= 1, '客户端应订阅 agent-preset/selected（官方同款事件）');
    for (const fn of [...handlers]) fn(SID_SWITCH, 'dm');
    const back = await waitFor(stale, 1);          // 注意：props 完全没变，全靠事件触发
    assert.equal(byClass(back, 'rpc-chip').length, 1,
      '宿主广播预设切换后，入口要重新判断（不刷新页面也要回来）');
    gateReply = { ok: true, dm: true, started: false };
  }
}

// ── 关键断言 ⑦：设置页的「默认宏列表」（键值对，名字可改）───────────────
// 用户的要求：设置页里的是**预设默认值**，此时还不知道会用哪张卡，所以名字当然要能改；
// 而 RP 面板/导入表单里列出的名字来自卡里的占位符，那边不能改名（改了匹配不上）。
{
  const reg = slotRegs.find((r) => r.name === 'settings.section');
  assert.ok(reg, '应注册设置页');
  resetHooks();
  calls.length = 0;
  const Props = {};
  let tree = render(Props, reg.component);
  for (let i = 0; i < 14 && !textOf(tree).includes('默认宏列表'); i++) { await tick(30); tree = render(Props, reg.component); }
  const text = textOf(tree);
  assert.ok(text.includes('默认宏列表'), '设置页应有「默认宏列表」');
  assert.equal(text.includes('玩家称呼'), false, '「玩家称呼」应已被默认宏列表取代');
  // 三大类：设定 / 图像 / 工具
  assert.ok(text.includes('设定') && text.includes('图像') && text.includes('工具'), '设置页要按设定/图像/工具分三大类');
  // 图像尺寸全局可编辑（三档：场景 / 立绘 / 道具）
  const sizeRows = byClass(tree, 'szrow');
  assert.equal(sizeRows.length, 3, '图像尺寸要开放三档编辑');
  assert.ok(text.includes('场景') && text.includes('立绘') && text.includes('道具'), '三档要有名字');
  const sizeInputs = sizeRows.flatMap((r) => findAll(r, (n) => n.type === 'input' && n.props.type === 'number'));
  assert.equal(sizeInputs.length, 6, '每档两个数字框（宽 × 高）');
  // 风格库：名称不可编辑、没有「新增风格」、参数仍可改
  assert.equal(text.includes('新增风格'), false, '风格库不再提供「＋ 新增风格」');
  // 行尾删除用幽灵图标按钮、添加用整条虚线按钮（用户说「× 不好看、添加按钮太近」）
  const macroRowsFound = byClass(tree, 'macrorow');
  assert.ok(macroRowsFound.length >= 1, '默认宏要有行');
  assert.equal(findAll(macroRowsFound[0], (n) => String(n.props?.className ?? '').split(/\s+/).includes('iconbtn')).length, 1,
    '行尾删除要用 iconbtn（小幽灵按钮），不是带边框的方块');
  assert.equal(findAll(tree, (n) => String(n.props?.className ?? '').split(/\s+/).includes('addbtn')).length, 1,
    '「＋ 添加默认宏」要用 addbtn（整条虚线、与上一行拉开距离）');
  // 控件规格：输入框用宿主 token + 细聚焦环（原来聚焦是一圈又粗又亮的默认 outline）
  assert.ok(/\.rpt input\[type=text\][^{]*\{[^}]*--dsw-alias-bg-layer-1/.test(style.textContent),
    '输入框底色要跟随宿主 token');
  assert.ok(/\.rpt input:focus[^{]*\{[^}]*--dsw-alias-brand-primary/.test(style.textContent),
    '聚焦环要用品牌色（别再出现默认 outline）');
  // ★ 主按钮：底色 button-primary-fill + 文字 label-primary-foreground。
  //   踩过的坑：--dsw-alias-brand-primary 在深色主题下是**近白**，配写死的白色文字
  //   = 白底白字（用户截图里的「保存按钮看不清」）。所以文字必须用前景 token。
  const primaryCss = /\.rpt button\.primary \{([^}]*)\}/.exec(style.textContent)?.[1] ?? '';
  assert.ok(primaryCss.includes('--dsw-alias-button-primary-fill'), '主按钮底色要用 button-primary-fill');
  assert.ok(primaryCss.includes('--dsw-alias-label-primary-foreground'), '主按钮文字要用 label-primary-foreground（深色主题下它是深色）');
  assert.equal(/color:\s*#fff/.test(primaryCss), false, '主按钮不能写死白色文字（深色主题下会白底白字）');
  // CSS 模板串自检：花括号配平（反引号会被 node --check 拦住，花括号不会）
  assert.equal((style.textContent.match(/\{/g) ?? []).length, (style.textContent.match(/\}/g) ?? []).length,
    '样式表花括号要配平');
  const styleRows = byClass(tree, 'stylerow');
  assert.equal(styleRows.length, 1, 'stub 里一个风格就是一行');
  const nameInputs = findAll(styleRows[0], (n) => n.type === 'input' && n.props.type === 'text'
    && ['manga', '黑白漫画'].includes(String(n.props.value)));
  assert.equal(nameInputs.length, 0, '风格名称不可编辑（只显示文本）');
  assert.ok(textOf(styleRows[0]).includes('黑白漫画') && textOf(styleRows[0]).includes('manga'), '名称与 key 要显示出来');
  const paramInputs = findAll(styleRows[0], (n) => n.type === 'input' && n.props.type === 'number');
  assert.equal(paramInputs.length, 2, 'CFG 与步数仍可编辑');
  assert.equal(findAll(styleRows[0], (n) => n.type === 'select').length, 1, 'LoRA 仍可选');
  // 自动宏要在设置页提示出来：哪些宏根本不用填、由宿主现算
  assert.ok(text.includes('自动宏'), '设置页要提示自动宏');
  assert.ok(text.includes('{{year}}') && text.includes('{{time}}'), '自动宏名单要列出来（含年月日分量）');
  // 每条默认宏 = 名称输入框 + 值输入框（名字可改就是「不只是值一个框」的含义）
  const rows = findAll(tree, (n) => String(n.props?.className ?? '').includes('macrorow'));
  assert.equal(rows.length, 2, '两条默认宏应各占一行');
  const nameBoxes = findAll(tree, (n) => n.type === 'input' && ['user', 'place'].includes(n.props.value));
  assert.ok(nameBoxes.length >= 2, '默认宏的名字要出现在输入框里（可改）');
  const valueBoxes = findAll(tree, (n) => n.type === 'input' && ['阿岚', '长安'].includes(n.props.value));
  assert.ok(valueBoxes.length >= 2, '默认宏的值也要能改');
  // 改名：把 user 改成 player → 保存时提交的键要跟着变
  nameBoxes.find((n) => n.props.value === 'user').props.onChange({ target: { value: 'player' } });
  tree = render(Props, reg.component);
  const saveBtn = findAll(tree, (n) => typeof n.props?.onClick === 'function' && textOf(n) === '保存');
  assert.ok(saveBtn.length >= 1, '设置页要有保存');
  await saveBtn[0].props.onClick();
  await tick(60);
  const post = calls.filter((c) => c.url === '/rp-tools/config' && c.method === 'POST').pop();
  assert.ok(post, '保存应 POST /rp-tools/config');
  assert.equal(post.body.cards.macros.player, '阿岚', '改过的名字要按新键提交（值跟着走）');
  assert.equal(post.body.cards.macros.place, '长安', '没动的条目要原样保留');
  assert.equal(Object.hasOwn(post.body.cards.macros, 'user'), false, '改名后不该再提交旧键');
  // 全局图像尺寸也要一起提交（否则界面改了、出图还是旧尺寸）
  assert.deepEqual(post.body.imageSizes.scene, [1024, 576], '图像尺寸要随保存提交（场景）');
  assert.deepEqual(post.body.imageSizes.portrait, [640, 896], '图像尺寸要随保存提交（立绘）');
  assert.deepEqual(post.body.imageSizes.item, [768, 768], '图像尺寸要随保存提交（道具）');

  // 空列表时要说人话：直接给出 `user -> 玩家` 这个例子，而不是留一个空白块让人猜
  stateStub.cards = { root: '', userLabel: '', macros: {} };
  resetHooks();
  let empty = render(Props, reg.component);
  for (let i = 0; i < 14 && !textOf(empty).includes('默认宏列表'); i++) { await tick(30); empty = render(Props, reg.component); }
  assert.ok(textOf(empty).includes('还没有默认宏'), '空列表要给一句人话引导');
  assert.ok(textOf(empty).includes('名字填 user、值填玩家'), '空列表要给出具体例子（user → 玩家）');
  stateStub.cards = { root: '', userLabel: '阿岚', macros: { user: '阿岚', place: '长安' } };
  resetHooks();

  // ★ 尺寸不能显示 0：宿主是旧版（config 里没有 imageSizes）时也要显示内置默认值，
  //   并且保存时把默认值一起交回去（旧宿主不会自己补）。
  {
    const keep = stateStub.imageSizes;
    delete stateStub.imageSizes;
    resetHooks();
    calls.length = 0;
    let legacy = render(Props, reg.component);
    for (let i = 0; i < 14 && !textOf(legacy).includes('图像尺寸'); i++) { await tick(30); legacy = render(Props, reg.component); }
    const vals = byClass(legacy, 'szrow')
      .flatMap((r) => findAll(r, (n) => n.type === 'input' && n.props.type === 'number'))
      .map((n) => Number(n.props.value));
    assert.ok(vals.length === 6 && vals.every((v) => v >= 256), `尺寸不能出现 0（实际 ${JSON.stringify(vals)}）`);
    assert.deepEqual(vals.slice(0, 2), [1024, 576], '缺配置时场景用内置默认值');
    assert.deepEqual(vals.slice(2, 4), [640, 896], '缺配置时立绘用内置默认值');
    const save2 = findAll(legacy, (n) => typeof n.props?.onClick === 'function' && textOf(n) === '保存');
    await save2[0].props.onClick();
    await tick(60);
    const post2 = calls.filter((c) => c.url === '/rp-tools/config' && c.method === 'POST').pop();
    assert.deepEqual(post2?.body?.imageSizes?.scene, [1024, 576], '保存要把默认尺寸交回去（旧宿主不会补）');
    stateStub.imageSizes = keep;
    resetHooks();
  }
}
console.log('客户端冒烟测试通过：');
console.log(`  · bundle id = ${captured.id}`);
console.log(`  · apply 后样式表已注入（${style.textContent.length} 字符，含 .rph-btn / .rpc）`);
console.log(`  · 重复 apply 幂等`);
console.log(`  · 已注册槽位：${[...new Set(registered)].join(', ')}`);
console.log(`  · 故事书导入槽位：id=${dockReg.id} order=${dockReg.order}`);
console.log(`  · 无头渲染全流程通过：portal 进工作区那一行 / 只在未开局的 DM 新会话出现 / 列表 / 预览 / 导入 / 结果留存（共 ${calls.length} 次请求）`);
