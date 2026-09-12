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
  // body 必须存在：共享大编辑器（世界书/角色卡/DM 设定）走 createPortal(content, document.body)，
  // 没有它就永远走「退回原位」那条分支，测出来的不是真实布局。
  body: { children: [] },
  activeElement: null,
  addEventListener: () => {},
  removeEventListener: () => {},
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
  useEffect(fn, deps) {
    // ⚠️ 必须与真实 React 一样**按依赖决定跑不跑**：早先这里无条件 push，于是每次 render()
    //    都把「挂载时的 reload()」又跑一遍 —— 它会把 draft 铺回宿主版本，测试里刚改的字段
    //    被静默冲掉（加角色浮窗用例时就是这么被打中的）。真实 React 不会这样。
    const cells = rt.cells;
    const i = rt.cursor++;
    const prev = cells[i];
    const list = Array.isArray(deps) ? deps : null;
    const changed = !prev
      || (list === null) !== (prev.list === null)
      || (list !== null && (list.length !== prev.list.length || list.some((d, k) => !Object.is(d, prev.list[k]))));
    if (changed) {
      cells[i] = { list };
      rt.effects.push(fn);
    }
  },
  useLayoutEffect(fn, deps) { React.useEffect(fn, deps); },
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
  // 面板里几个破坏性/批量操作都会先 confirm（删除、属性中文化、重命名无名条目）——
  // 无头环境里给个「确定」，否则点击会被静默拦下，测出来的是假的。
  confirm: () => true,
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
      chars: 1234, total: 3, constant: 1, keyed: 1,
      // 总览数字（宿主 loreOverview）：面板顶部要显示「常驻 N 条 ≈ M 字/轮」与「隐藏了几条空壳」
      empty: 1, emptyChars: 18, constantChars: 46,
      kinds: { 设定: 2, 规则: 0, 状态: 0, 历史: 0 },
      // 唯一要显示的诊断：**条目名与人物卡重名**（键一律不管 —— 用户口径）
      characterOverlap: [{ title: '长安城', character: '长安' }],
      entries: [
        { title: '长安城', keys: ['长安'], constant: false, order: 0, probability: 100, chars: 22, preview: '天宝年间的长安城，坊市分明。', empty: false, kind: '设定',
          nameConflict: '与人物卡「长安」同名，正文已由人物卡承载（不会再从世界书重复注入）' },
        { title: '世界总纲', keys: [], constant: true, order: 0, probability: 100, chars: 30, preview: '盛唐末年，边镇不稳。', empty: false, kind: '设定' },
        // 空壳条目：正文只有模板残留 —— 界面要默认藏起来
        { title: '足', keys: [], constant: true, order: 0, probability: 100, chars: 18, preview: '1. ```markdown', empty: true, kind: '设定' },
      ],
      note: '只有命中的条目才进每轮上下文。',
    });
  }
  // 设定整备指令：宿主编好措辞与条目清单，界面只负责填进输入框
  if (target === '/rp-tools/tidy') {
    return reply({
      ok: true,
      entries: 2,
      text: '【设定整备】现在做一次设定整理：只做这一件事，做完回一行摘要，然后停下等玩家。\n① 角色卡字段归位\n② 世界书过滤',
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
  // 左列表要**撑满左列**（与右侧预览等高）—— 用户反馈「左侧列表长一点」：
  // 原来 max-height 300px，5 张卡时只有一百多像素，旁边预览七百多
  assert.ok(/\.rpc \.split \{[^}]*align-items:\s*stretch/.test(style.textContent),
    '两列要等高（align-items: stretch），左列表才会长');
  assert.ok(/\.rpc \.list \{[^}]*min-height:\s*320px/.test(style.textContent), '列表至少 320px 高');
  assert.ok(/\.rpc \.list \{[^}]*max-height:\s*min\(78vh/.test(style.textContent), '列表最高 ~78vh（再多就在列表内滚动）');
  assert.equal(/\.rpc \.list \{[^}]*max-height:\s*300px/.test(style.textContent), false, '不该再封顶 300px');
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
  assert.ok(text.includes('世界书（3 条）'), '面板应显示世界书条目数（含导入进来的那些）');
  assert.ok(text.includes('长安城'), '面板应列出世界书条目标题');
  assert.ok(text.includes('世界总纲') && text.includes('常驻'), '面板应标出常驻条目');
  // 用户要求「智能过滤世界书，无内容的不要」：正文只有模板残留的条目默认不列出，
  // 但**不是**删掉 —— 给一行提示 + 展开开关，方便自己清理
  assert.equal(text.includes('足'), false, '空壳条目默认不在列表里');
  assert.ok(text.includes('已隐藏 1 条空条目'), '应提示隐藏了几条空条目');
  assert.ok(text.includes('显示 / 清理'), '应给一个展开空条目的开关');
  // 常驻体积：用户问过「常驻条目到底占了多少上下文」，只报条数回答不了
  assert.ok(text.includes('常驻 1 条 ≈ 46 字/轮'), '应显示每轮注入的常驻体积');
  assert.equal(text.includes('常驻存疑'), false, '设定类常驻不该被标「常驻存疑」');
  // 折叠态只留一行：名称 / 徽标 / 字数 + 常驻开关 + 详情按钮；触发词与正文都收进详情里
  assert.equal(text.includes('触发词：长安'), false, '折叠态不该铺开触发词行');
  assert.equal(text.includes('天宝年间的长安城，坊市分明。'), false, '折叠态不该铺开正文');
  assert.ok(/\d+ 字/.test(text), '折叠态应显示字数');
  assert.ok(text.includes('rp-worldbook.md'), '面板应给出世界书文件路径');
  // 没有随机表时，那张「RP 表格 / 随机表（0）」卡片不该出现（用户要求去掉）
  assert.equal(text.includes('RP 表格'), false, '没有表时不应渲染「RP 表格 / 随机表（0）」');

  // 每条都要能就地改「常驻」、能打开编辑（单行列表 + 共享大浮窗）、能删除、能新建
  const boxes = findAll(panel2, (n) => n.type === 'input' && n.props.type === 'checkbox');
  assert.ok(boxes.length >= 2, '每个条目应有「常驻」复选框');
  assert.ok(textOf(panel2).includes('＋ 新建条目'), '面板应有新建条目入口');
  const editBtns = findAll(panel2, (n) => typeof n.props?.onClick === 'function' && textOf(n) === '编辑');
  // ≥2：两条非空世界书条目各一个；DM 设定那一行也有一个「编辑」（共用同一只大浮窗）
  assert.ok(editBtns.length >= 2, '每个条目应有「编辑」按钮（空壳条目默认不列）');
  // 单行列表：删掉的是 title/meta 之外不再铺开正文（正文进浮窗）
  const delBtns = findAll(panel2, (n) => typeof n.props?.onClick === 'function' && textOf(n) === '×');
  assert.ok(delBtns.length >= 2, '每个条目应能删除');

  // 诊断只显示一种：**条目与人物卡重名**（key 之间重复不显示 —— 用户拍板「无所谓」）
  assert.ok(text.includes('与人物卡重名的条目'), '要提示与人物卡重名的条目');
  assert.ok(text.includes('长安'), '提示里要带上重名的条目/人物');
  assert.equal(text.includes('重复 key'), false, '不该再显示「重复 key」（条目之间 key 重复无所谓）');
  {
    const badges = findAll(panel2, (n) => String(n.props?.className ?? '').split(/\s+/).includes('badge'));
    assert.ok(badges.some((b) => textOf(b) === '与人物同名'), '重名条目上要有「与人物同名」徽标');
    assert.equal(badges.some((b) => textOf(b) === '重复 key'), false, '不该再有「重复 key」徽标');
  }

  // 「整理设定」按钮：宿主给措辞（含世界书路径与条目清单），界面填进输入框、**不自动发送**
  {
    assert.ok(text.includes('整理设定'), '世界书卡片应有「整理设定」按钮');
    const tidyBtn = findAll(panel2, (n) => typeof n.props?.onClick === 'function' && textOf(n) === '整理设定')[0];
    assert.ok(tidyBtn, '「整理设定」应是个可点按钮');
    const before = actions.drafts.length;
    const submittedBefore = actions.submitted;
    await tidyBtn.props.onClick();
    await tick(50);
    assert.ok(actions.drafts.length > before, '点「整理设定」应把指令填进输入框（setDraft）');
    assert.ok(String(actions.drafts.at(-1)).includes('【设定整备】'), '填进去的是宿主的整备指令正文');
    assert.equal(actions.submitted, submittedBefore, '**不自动发送**：先进输入框让用户确认/修改');
  }

  // 点「显示 / 清理」→ 空条目才出现在列表里（带「空」徽标，标题划线）
  const showBtn = findAll(panel2, (n) => typeof n.props?.onClick === 'function' && textOf(n) === '显示 / 清理')[0];
  assert.ok(showBtn, '应有「显示 / 清理」按钮');
  await showBtn.props.onClick();
  await tick(30);
  const withEmpty = render({
    sessionId: SID,
    useSessions: (sel) => sel(store),
    useInput: (sel) => sel({ draft: '' }),
    inputActions,
  }, tab.component);
  const emptyText = textOf(withEmpty);
  assert.ok(emptyText.includes('足'), '展开后应看到空壳条目');
  assert.ok(emptyText.includes('空'), '空壳条目应带「空」徽标');
  // 复原（组件 state 会跨 render 保留，不还原会影响后面的断言）
  await showBtn.props.onClick();
  await tick(30);

  // 点世界书列表里那条的「编辑」→ 取回完整正文 → 在**共享大浮窗**里展示表单
  // （DM 设定那一行也有「编辑」，所以必须从 loreitem 里取，不能按全局顺序取第一个）
  const firstLoreItem = byClass(panel2, 'loreitem')[0];
  assert.ok(firstLoreItem, '世界书列表里应有条目行');
  const loreEditBtn = findAll(firstLoreItem, (n) => typeof n.props?.onClick === 'function' && textOf(n) === '编辑')[0];
  assert.ok(loreEditBtn, '条目行里应有「编辑」按钮');
  await loreEditBtn.props.onClick();
  await tick(60);
  const withForm = render({
    sessionId: SID,
    useSessions: (sel) => sel(store),
    useInput: (sel) => sel({ draft: '' }),
    inputActions,
  }, tab.component);
  const formText = textOf(withForm);
  assert.ok(formText.includes('触发词（逗号分隔）'), '编辑器里应有触发词输入');
  assert.ok(formText.includes('常驻（不看触发词）'), '编辑器里应有常驻开关');
  assert.ok(formText.includes('order'), '编辑器里应有 order');
  assert.ok(formText.includes('概率'), '编辑器里应有概率');
  // 大浮窗走 portal：节点类型必须是 Portal（列表里不再就地铺开表单）
  assert.equal(findAll(withForm, (n) => n.type === 'Portal').length, 1, '编辑器应 portal 到页面根级');
  // 完整正文在正文输入框里（textarea 的 value 是 prop，textOf 看不到，得直接断言 value）
  const bodyArea = findAll(withForm, (n) => n.type === 'textarea' && String(n.props.className ?? '').includes('lorebody'));
  assert.equal(bodyArea.length, 1, '编辑器里应有正文输入框');
  assert.equal(bodyArea[0].props.value, '天宝年间的长安城，坊市分明。', '编辑器里应带出完整正文（不是 160 字预览）');
  assert.ok(formText.includes('标题（也是默认触发词）'), '编辑器里应有标题输入');

  // ⚠️ 回归：关闭要能真的关掉（而且必须走未保存确认，不能静默丢改动）
  const closeBtn = findAll(withForm, (n) => typeof n.props?.onClick === 'function' && textOf(n) === '关闭')[0];
  assert.ok(closeBtn, '编辑器应有「关闭」');
  closeBtn.props.onClick();
  const closed = render({
    sessionId: SID,
    useSessions: (sel) => sel(store),
    useInput: (sel) => sel({ draft: '' }),
    inputActions,
  }, tab.component);
  assert.equal(findAll(closed, (n) => n.type === 'Portal').length, 0, '点「关闭」后编辑器应消失');
  assert.equal(findAll(closed, (n) => n.type === 'textarea' && String(n.props.className ?? '').includes('lorebody')).length, 0,
    '关闭后正文输入框应消失');
  // 列表始终是**单行**：正文与触发词不该出现在列表本身（只有浮窗里才有）
  assert.equal(textOf(panel2).includes('天宝年间的长安城，坊市分明。'), false, '列表里不该铺开正文');
  assert.ok(text.includes('世界设定'), '卡片标题应是「世界设定」');
  assert.equal(text.includes('世界 / 战役设定'), false, '不该再出现旧标题');
  // 诊断行：把「界面看到的」和「宿主说的」摆在一起。导入入口两度消失都栽在这两个值不一致上，
  // 留着它下次能一眼看出是哪边不对（这行本身也是「宿主说了算」那条路的现场证据）。
  assert.ok(text.includes('入口判据'), '面板里应有入口判据诊断行');
  assert.ok(text.includes('宿主：预设'), '诊断行要显示宿主侧的预设');
  // 「看不全」那次的教训：右侧栏很窄，正文框必须给足高度，列表也要按视口给高度
  // （只要求 ≥3 位数的 px，具体值随版式调整；430 与 200 都算合格）
  assert.ok(/\.rpt \.loreform textarea\.lorebody \{[^}]*min-height:\s*\d{3,}px/.test(style.textContent),
    '正文输入框要有足够高度（≥200px）');
  assert.ok(/\.rpt \.lorelist \{[^}]*max-height:\s*min\(/.test(style.textContent),
    '条目列表要按视口给高度，不能压成固定 260px');

  // ① 列表里的「常驻」开关：点一下就直接 POST update（最常用的那条路）
  // ⚠️ 必须按 class `loreconst` 精确定位：面板顶部现在还有「DM 设定」的三个生图开关，
  //    直接取 findAll(...)[0] 会打到 DM 卡片上（测试就是这么被打中的）。
  const listConstBox = findAll(byClass(withForm, 'loreconst')[0], (n) => n.type === 'input' && n.props.type === 'checkbox')[0];
  assert.ok(listConstBox, '列表里应有「常驻」开关');
  listConstBox.props.onChange({ target: { checked: true } });
  await tick(60);
  const lorePost = calls.filter((c) => c.url === '/rp-tools/lore' && c.method === 'POST').pop();
  assert.ok(lorePost, '改常驻应向 /rp-tools/lore 发 POST');
  if (process.env.RP_DEBUG) console.log('DEBUG lore POSTs:', JSON.stringify(calls.filter((c) => c.url === '/rp-tools/lore' && c.method === 'POST').map((c) => c.body.action)));
  assert.equal(lorePost.body.action, 'update', '编辑已有条目应走 update');
  assert.equal(lorePost.body.title, '长安城', 'update 应带上原名（改名时用它定位）');
  assert.equal(lorePost.body.entry.constant, true, '勾选状态应写进 constant');

  // ② 详情表单里的「常驻（不看触发词）」+ 表单保存：这条走 saveLoreEdit（面板编辑器的正式路径）。
  // 每次改完都要**重新渲染**再点按钮：真实 React 里 onClick 是新建的闭包，拿的是更新后的
  // loreEdit；用旧树上的那个会闭包住改之前的值（桩的实现细节，但结论与真实 React 一致）。
  const props2 = () => ({
    sessionId: SID,
    useSessions: (sel) => sel(store),
    useInput: (sel) => sel({ draft: '' }),
    inputActions,
  });
  const openForm = async () => {
    // 必须用**新渲染出来的**那棵树点「编辑」：旧树上的 onClick 闭包住的是改之前的状态
    // （桩的闭包语义与真实 React 一致）。DM 设定那一行也有「编辑」，所以从 loreitem 里取。
    const tree = render(props2(), tab.component);
    const item = byClass(tree, 'loreitem')[0];
    assert.ok(item, '世界书列表里应有条目行');
    const btn = findAll(item, (n) => typeof n.props?.onClick === 'function' && textOf(n) === '编辑')[0];
    assert.ok(btn, '列表里应有「编辑」');
    await btn.props.onClick();
    await tick(60);
    return render(props2(), tab.component);
  };
  const formTree = await openForm();
  const constLabel = findAll(formTree, (n) => textOf(n).trim() === '常驻（不看触发词）')[0];
  assert.ok(constLabel, '编辑器里应有「常驻（不看触发词）」这一行');
  const constBox = findAll(constLabel, (n) => n.type === 'input' && n.props.type === 'checkbox')[0];
  assert.ok(constBox, '那行里应有复选框');
  constBox.props.onChange({ target: { checked: true } });
  const formTree2 = render(props2(), tab.component);
  // 面板顶部还有一个「保存」（保存会话配置），按 class 区分出编辑器里那个
  const saveBtn = findAll(formTree2, (n) => typeof n.props?.onClick === 'function'
    && textOf(n) === '保存' && String(n.props.className ?? '').includes('lore-save'));
  assert.equal(saveBtn.length, 1, '编辑器里应有保存按钮');
  await saveBtn[0].props.onClick();
  await tick(60);
  const formPost = calls.filter((c) => c.url === '/rp-tools/lore' && c.method === 'POST').pop();
  assert.ok(formPost, '表单保存应向 /rp-tools/lore 发 POST');
  assert.equal(formPost.body.title, '长安城', '表单保存也要带原名');
  assert.equal(formPost.body.entry.constant, true, '表单里的勾选状态也要写进 constant');

  // ── 初始收尾**不再做成面板按钮**（用户拍板）──────────────────────────────
  // 「属性中文化」「重命名无名条目」这两件事统一写进 cards/<slug>.launch.md，
  // 由 DM 开局时自己收拾（它能一次调用 rp_lore 的 localize / rename_unnamed）。
  // 面板上留按钮 = 同一件事两个入口，而规则能判的那几件之外本来也得 DM 看着办。
  {
    const tree = render({
      sessionId: SID,
      useSessions: (sel) => sel(store),
      useInput: (sel) => sel({ draft: '' }),
      inputActions,
    }, tab.component);
    const t = textOf(tree);
    assert.equal(t.includes('属性中文化'), false, '不该再有「属性中文化」按钮（改由开局引导文件交代 DM）');
    assert.equal(t.includes('重命名无名条目'), false, '不该再有「重命名无名条目」按钮（同上）');
    // 但世界书卡片自己的入口还在（新建 / 刷新 / 整理设定）
    assert.ok(t.includes('＋ 新建条目') && t.includes('刷新') && t.includes('整理设定'),
      '世界书卡片的基础入口应保留');
  }

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

  // ★ 角色卡卡片：标题叫「角色卡」；**生成出来的立绘**才挂在角色行上（有图就两列、图在左）
  {
    assert.ok(text.includes('角色卡（'), '卡片标题应叫「角色卡」');
    assert.equal(text.includes('人物（'), false, '不该叫「人物」');
    // 只有「卡面」没有生成立绘时：角色行**不出图**（卡面现在是世界设定旁的封面）
    sessionStub.characters = [{ name: '阿岚', appearance: '白衣长剑', personality: '冷淡' }];
    sessionStub.portraits = { 阿岚: { card: 'cards/古风/长安.card.png' } };
    resetHooks();
    let cardFaceOnly = render({
      sessionId: SID,
      useSessions: (sel) => sel(store),
      useInput: (sel) => sel({ draft: '' }),
      inputActions,
    }, tab.component);
    for (let i = 0; i < 14 && byClass(cardFaceOnly, 'charbox').length === 0; i++) {
      await tick(30);
      cardFaceOnly = render({
        sessionId: SID,
        useSessions: (sel) => sel(store),
        useInput: (sel) => sel({ draft: '' }),
        inputActions,
      }, tab.component);
    }
    assert.equal(byClass(cardFaceOnly, 'charbox')[0]?.props['data-hasface'], 'false', '只有卡面（没生成立绘）时角色行不出图');
    assert.equal(byClass(cardFaceOnly, 'charface').length, 0, '不该把卡面当角色立绘');
    // 有生成立绘 → 两列，图在左（DOM 顺序 charface → charbody）
    sessionStub.portraits = {
      阿岚: {
        generated: { file: 'rp-portrait-1.png', subfolder: 'rp', type: 'output' },
        style: '二次元', elapsedMs: 18300, at: '2026-09-12T01:00:00.000Z',
      },
    };
    resetHooks();
    let withFace = render({
      sessionId: SID,
      useSessions: (sel) => sel(store),
      useInput: (sel) => sel({ draft: '' }),
      inputActions,
    }, tab.component);
    for (let i = 0; i < 14 && byClass(withFace, 'charavatar').length === 0; i++) {
      await tick(30);
      withFace = render({
        sessionId: SID,
        useSessions: (sel) => sel(store),
        useInput: (sel) => sel({ draft: '' }),
        inputActions,
      }, tab.component);
    }
    const box = byClass(withFace, 'charbox')[0];
    assert.equal(box.props['data-hasface'], 'true', '有立绘的角色行要标 data-hasface');
    const kids = (box.children ?? []).map((n) => String(n?.props?.className ?? ''));
    assert.ok(kids.indexOf('charavatar') === 0 && kids.indexOf('charbody') === 1,
      `DOM 顺序应是 charavatar → charbody（实际 ${JSON.stringify(kids)}）`);
    assert.ok(/\.rpt \.charbox\[data-hasface='true'\]/.test(style.textContent), '样式里要有「有头像」的规则');

    // 单行列表（用户重新设计）：**小头像 + 名称 + 简介 + 标记 + 编辑 / 立绘 / 删除**。
    // 完整 8 字段**不在列表里**（5 个角色就把面板撑满），点「编辑」后在大浮窗里改。
    const rowText = textOf(box);
    assert.ok(rowText.includes('阿岚'), '单行里要有角色名');
    assert.ok(rowText.includes('白衣长剑'), '单行里要有简介（缺 brief 时回退外观）');
    assert.ok(/1\/6 已填/.test(rowText), '单行里要报「已填几项」');
    assert.equal(findAll(box, (n) => n.type === 'textarea').length, 0, '列表里不该铺开字段文本框');
    // 头像固定 36px、不发大图、不提供「收起」（「收起」会把立绘从会话配置里删掉，点完反而看不到）
    assert.ok(/\.rpt \.charavatar \{[^}]*width:\s*36px/.test(style.textContent), '头像应是 36px 的小方块');
    assert.ok(/\.rpt \.charavatar img \{[^}]*object-fit:\s*cover/.test(style.textContent), '头像图要铺满裁切');
    assert.equal(textOf(box).includes('大图'), false, '列表里不该再有「大图」');
    assert.equal(textOf(box).includes('收起'), false, '列表里不该再有「收起」（它会删掉立绘）');
    assert.equal(findAll(withFace, (n) => textOf(n) === '收起').length, 0, '整个面板都不该再有「收起」');
    // 有立绘的行里那张图就是头像
    const avatarImg = findAll(withFace, (n) => n.type === 'img' && String(n.props.src ?? '').includes('/rp-tools/media?'));
    assert.ok(avatarImg.length >= 1, '有立绘的角色行要显示头像图');
    // 没有立绘时给占位（名字首字），行高不变
    {
      const savedPortraits = sessionStub.portraits;
      sessionStub.portraits = {};
      resetHooks();
      let noFace = render({
        sessionId: SID,
        useSessions: (sel) => sel(store),
        useInput: (sel) => sel({ draft: '' }),
        inputActions,
      }, tab.component);
      for (let i = 0; i < 14 && byClass(noFace, 'charavatar').length === 0; i++) {
        await tick(30);
        noFace = render({
          sessionId: SID,
          useSessions: (sel) => sel(store),
          useInput: (sel) => sel({ draft: '' }),
          inputActions,
        }, tab.component);
      }
      assert.ok(byClass(noFace, 'charavatar-ph')[0], '没有立绘时要有占位头像（名字首字）');
      assert.equal(byClass(noFace, 'charbox')[0]?.props['data-hasface'], 'false', '没有立绘时 data-hasface=false');
      assert.equal(byClass(noFace, 'charavatar').length, 1, '占位头像也占同一个位置（行高不变）');
      sessionStub.portraits = savedPortraits;
      resetHooks();
    }
    // resetHooks 之后旧树上的 onClick 闭包已经失效 —— 重新挂载 + 重新渲染，再从**新树**取按钮
    let reface = render({
      sessionId: SID,
      useSessions: (sel) => sel(store),
      useInput: (sel) => sel({ draft: '' }),
      inputActions,
    }, tab.component);
    for (let i = 0; i < 14 && byClass(reface, 'charavatar').length === 0; i++) {
      await tick(30);
      reface = render({
        sessionId: SID,
        useSessions: (sel) => sel(store),
        useInput: (sel) => sel({ draft: '' }),
        inputActions,
      }, tab.component);
    }
    const box2 = byClass(reface, 'charbox')[0];
    // 角色**只能由 DM 添加**（用户要求）：不再有「＋ 添加角色」按钮，换成一行说明
    assert.equal(textOf(reface).includes('＋ 添加角色') && textOf(reface).includes('+ 添加角色'), false,
      '不该再有手加角色的按钮');
    assert.ok(textOf(reface).includes('角色由 DM 用 `rp_character` 添加'), '要说明角色由 DM 添加');
    const charEditBtn = findAll(box2, (n) => typeof n.props?.onClick === 'function' && textOf(n) === '编辑')[0];
    assert.ok(charEditBtn, '角色行要有「编辑」');
    await charEditBtn.props.onClick();
    await tick(30);
    const charModal = render({
      sessionId: SID,
      useSessions: (sel) => sel(store),
      useInput: (sel) => sel({ draft: '' }),
      inputActions,
    }, tab.component);
    assert.equal(findAll(charModal, (n) => n.type === 'Portal').length, 1, '角色编辑器要 portal 到页面根级');
    const charForm = byClass(charModal, 'chareditform')[0];
    assert.ok(charForm, '角色编辑器要有 chareditform');
    const fieldLabels = ['名称', '外貌', '性格', '说话方式', '行为习惯', '人物关系', '开场白', '对话范例'];
    for (const f of fieldLabels) {
      assert.ok(textOf(charForm).includes(f), `角色编辑器要有「${f}」字段`);
    }
    // 布局（用户要求）：立绘在**左列**、尽量铺满那一列；字段在右列
    assert.ok(/\.rpt \.chareditform \{[^}]*grid-template-columns:\s*minmax\(280px,\s*46%\)/.test(style.textContent),
      '编辑器要两列（左 46% 立绘 / 右表单）');
    assert.ok(/\.rpt \.chareditform \.facepreview img \{[^}]*max-height:\s*calc\(85vh/.test(style.textContent),
      '立绘要受列高约束、尽量用满左侧空间（max-height）');
    assert.ok(/\.rpt \.chareditform \.facepreview img \{[^}]*max-width:\s*100%/.test(style.textContent),
      '立绘也不能撑破列宽');
    assert.ok(/\.rpt \.chareditform \.charfields \{[^}]*grid-template-columns/.test(style.textContent),
      '右列字段要有 label + 控件的两栏栅格');
    const formKids = (charForm.children ?? []).map((n) => String(n?.props?.className ?? ''));
    assert.ok(formKids.indexOf('facepreview') === 0 && formKids.indexOf('charfields') === 1,
      `立绘列必须在左、字段列在右（实际 ${JSON.stringify(formKids)}）`);
    assert.ok(byClass(charForm, 'facepreview').length === 1, '左列要有立绘');
    const nameInput = findAll(charForm, (n) => n.type === 'input' && n.props.value === '阿岚')[0];
    assert.ok(nameInput, '名称框要带出当前角色名');
    assert.ok(byClass(charForm, 'facepreview').length === 1, '大浮窗里要能看到这个角色的立绘');
    // 改名 → 应用 → 落到会话草稿（保存后才落盘）
    nameInput.props.onChange({ target: { value: '阿岚·改' } });
    const applied = render({
      sessionId: SID,
      useSessions: (sel) => sel(store),
      useInput: (sel) => sel({ draft: '' }),
      inputActions,
    }, tab.component);
    
    const applyBtn = findAll(applied, (n) => typeof n.props?.onClick === 'function' && textOf(n) === '应用')[0];
    assert.ok(applyBtn, '角色编辑器要有「应用」');
    await applyBtn.props.onClick();
    await tick(30);
    const afterApply = render({
      sessionId: SID,
      useSessions: (sel) => sel(store),
      useInput: (sel) => sel({ draft: '' }),
      inputActions,
    }, tab.component);
    assert.equal(findAll(afterApply, (n) => n.type === 'Portal').length, 0, '应用后编辑器应关闭');
    
    assert.ok(textOf(afterApply).includes('阿岚·改'), '应用后列表里应显示新名字');
  }

  // ★ 当前状态卡片：**会变的东西都在这里**（能力/技能、持有/装备也属于会变的）
  {
    sessionStub.state = {
      scene: '雨夜客栈',
      party: [{ character: '祁俊', status: '警戒', abilities: '短枪枪法·乱星', inventory: '腰刀', conditions: '左臂擦伤', goal: '找到地图' }],
    };
    resetHooks();
    let withState = render({
      sessionId: SID,
      useSessions: (sel) => sel(store),
      useInput: (sel) => sel({ draft: '' }),
      inputActions,
    }, tab.component);
    for (let i = 0; i < 14 && !textOf(withState).includes('雨夜客栈'); i++) {
      await tick(30);
      withState = render({
        sessionId: SID,
        useSessions: (sel) => sel(store),
        useInput: (sel) => sel({ draft: '' }),
        inputActions,
      }, tab.component);
    }
    const stText = textOf(withState);
    assert.ok(stText.includes('能力：短枪枪法·乱星'), '队伍行要显示**能力/技能**（动态值，与人物卡分开）');
    assert.ok(stText.includes('持有：腰刀'), '队伍行要显示持有/装备');
    assert.ok(/\.rpt \.partylines/.test(style.textContent), '队伍行要有自己的样式');
    sessionStub.state = {};
    resetHooks();
  }

  // ★ 封面：导入卡的 PNG 摆在「世界设定」旁边（用户要求），不再挂在角色名下
  {
    sessionStub.cover = { card: '女性视角/下班。然后变成魔法少女.png', file: 'x.png', name: '下班，然后成为魔法少女。' };
    resetHooks();
    let withCover = render({
      sessionId: SID,
      useSessions: (sel) => sel(store),
      useInput: (sel) => sel({ draft: '' }),
      inputActions,
    }, tab.component);
    for (let i = 0; i < 14 && byClass(withCover, 'cover').length === 0; i++) {
      await tick(30);
      withCover = render({
        sessionId: SID,
        useSessions: (sel) => sel(store),
        useInput: (sel) => sel({ draft: '' }),
        inputActions,
      }, tab.component);
    }
    const worldCard = byClass(withCover, 'card').find((c) => textOf(c).includes('世界设定'));
    assert.ok(worldCard, '应有世界设定卡片');
    assert.equal(worldCard.props['data-cover'], 'true', '有封面时世界设定卡片要标 data-cover');
    const cover = byClass(withCover, 'cover')[0];
    assert.ok(cover, '世界设定旁应有封面块');
    const coverImg = findAll(cover, (n) => n.type === 'img')[0];
    assert.ok(String(coverImg.props.src).includes('thumb=1&width=240'), '封面也走服务端降采样（卡 PNG 可能几 MB）');
    assert.ok(String(coverImg.props.src).includes(`sessionId=${SID}`), '封面请求要带会话身份');
    assert.ok(textOf(cover).includes('下班，然后成为魔法少女'), '封面下标出卡名');
    assert.ok(/\.rpt \.worldwrap/.test(style.textContent), '样式里要有封面+设定两列的规则');
    // 封面必须在世界设定卡**内部**（与 textarea 同一个 wrap 里），而不是另起一张卡
    assert.equal(byClass(worldCard, 'worldcol').length, 1, '世界设定卡里应有设定那一列');
    assert.equal(byClass(worldCard, 'worldwrap').length, 1, '世界设定卡里应有封面+设定的两列容器');
    // 世界设定的输入框要**拉伸到与封面同高**（用户要求：「世界那个介绍文本框拉大，对齐图片」）：
    // grid 必须 stretch（不能是 start），列内 textarea 要 flex:1 + min-height:150px
    assert.ok(/\.rpt \.worldwrap \{[^}]*align-items:\s*stretch/.test(style.textContent),
      'worldwrap 要对齐拉伸（align-items: stretch），否则文本框和封面不等高');
    assert.ok(/\.rpt \.worldcol textarea \{[^}]*flex:\s*1/.test(style.textContent),
      'worldcol 里的 textarea 要 flex:1 撑满列高');
    assert.ok(/\.rpt textarea\.worldtext \{[^}]*min-height:\s*150px/.test(style.textContent),
      '世界设定 textarea 要有 150px 的最小高度（无封面时也不该只有 62px）');
    const worldArea = findAll(worldCard, (n) => n.type === 'textarea' && String(n.props.className ?? '').includes('worldtext'))[0];
    assert.ok(worldArea, '世界设定卡里的 textarea 要带 worldtext 类（样式靠它定位）');
    sessionStub.cover = null;
    resetHooks();
  }

  // ── DM 设定卡片（用户要求：「在 rp 配置面板添加 DM 设定面板」）────────────────
  // DM（旁白）卡不是角色卡：它的正文要落在这里；生图开关也在这里（会话隔离）。
  {
    sessionStub.dm = {
      prompt: '叙述用第二人称，场景描写整段斜体。',
      migrated: ['lust Adventure'],
      images: { enabled: true, firstAppearance: true, keyScenes: false },
    };
    resetHooks();
    let withDm = render({
      sessionId: SID,
      useSessions: (sel) => sel(store),
      useInput: (sel) => sel({ draft: '' }),
      inputActions,
    }, tab.component);
    await tick(60);
    withDm = render({
      sessionId: SID,
      useSessions: (sel) => sel(store),
      useInput: (sel) => sel({ draft: '' }),
      inputActions,
    }, tab.component);
    const dmText = textOf(withDm);
    const dmCard = byClass(withDm, 'card').find((c) => textOf(c).includes('DM 设定'));
    assert.ok(dmCard, '面板里应有「DM 设定」卡片');
    // 默认**只占一行**（§6）：已配置/未配置 + 字数 + 编辑；正文在大浮窗里改
    assert.ok(textOf(dmCard).includes('已配置'), 'DM 设定行要显示「已配置」');
    assert.ok(/\d+ 字/.test(textOf(dmCard)), 'DM 设定行要显示字数');
    assert.equal(
      findAll(dmCard, (n) => n.type === 'textarea' && String(n.props.className ?? '').includes('dmtext')).length, 0,
      'DM 设定默认不该就地铺开文本框');
    const dmEditBtn = findAll(dmCard, (n) => typeof n.props?.onClick === 'function' && textOf(n) === '编辑')[0];
    assert.ok(dmEditBtn, 'DM 设定行要有「编辑」');
    // 迁移提示：老数据把 DM 卡当角色存过，搬过来之后要告诉用户
    assert.ok(dmText.includes('从角色卡挪到这里'), '要把「从角色卡挪到 DM 设定」这件事说出来');
    assert.ok(dmText.includes('lust Adventure'), '提示里带上被挪的那条名字');
    // 三个生图开关现在在**面板最上面**的「本会话生图」里（§6：会话生图配置合并到顶部，底部不再重复）
    const imgCard = byClass(withDm, 'card').find((c) => textOf(c).includes('本会话生图'));
    assert.ok(imgCard, '面板最上面应有「本会话生图」卡片');
    assert.equal(byClass(withDm, 'card').indexOf(imgCard), 0, '「本会话生图」应是第一块');
    assert.equal(textOf(withDm).includes('生图配置（本会话）'), false, '底部那块重复的生图配置卡片应已删除');
    const dmBoxes = findAll(imgCard, (n) => n.type === 'input' && n.props.type === 'checkbox');
    assert.equal(dmBoxes.length, 3, '生图要有三个开关：总开关 / 首次出场 / 重要场景');
    assert.equal(dmBoxes[0].props.checked, true, '总开关跟随会话配置');
    assert.equal(dmBoxes[2].props.checked, false, '重要场景跟随会话配置（这里是关）');
    // 关掉总开关 → 两个细分开关应当置灰（避免「关了还显示可选」的误解）
    dmBoxes[0].props.onChange({ target: { checked: false } });
    const withDm2 = render({
      sessionId: SID,
      useSessions: (sel) => sel(store),
      useInput: (sel) => sel({ draft: '' }),
      inputActions,
    }, tab.component);
    const imgCard2 = byClass(withDm2, 'card').find((c) => textOf(c).includes('本会话生图'));
    const dmBoxes2 = findAll(imgCard2, (n) => n.type === 'input' && n.props.type === 'checkbox');
    assert.equal(dmBoxes2[1].props.disabled, true, '总开关关掉后，细分开关应置灰');
    assert.ok(/\.rpt textarea\.dmtext \{[^}]*min-height/.test(style.textContent), 'dmtext 要有自己的高度规则');
    // 点「编辑」→ 共享大浮窗里出现文本框，且带出会话里的 DM 正文
    await dmEditBtn.props.onClick();
    await tick(30);
    const dmModal = render({
      sessionId: SID,
      useSessions: (sel) => sel(store),
      useInput: (sel) => sel({ draft: '' }),
      inputActions,
    }, tab.component);
    const dmArea = findAll(dmModal, (n) => n.type === 'textarea' && String(n.props.className ?? '').includes('dmtext'))[0];
    assert.ok(dmArea, 'DM 设定编辑器里要有文本框（dmtext）');
    assert.equal(dmArea.props.value, '叙述用第二人称，场景描写整段斜体。', '文本框要显示会话里的 DM 设定正文');
    assert.equal(findAll(dmModal, (n) => n.type === 'Portal').length, 1, 'DM 编辑器也要 portal 到页面根级');
    sessionStub.dm = { prompt: '', migrated: [], images: { enabled: true, firstAppearance: true, keyScenes: true } };
    resetHooks();
  }

  // ── 自动刷新（用户报：「dm 填完后需要我手动刷新」）──────────────────────────
  // DM 那一轮结束（running 由 true 落回 false）时，面板要自己把宿主的改动拉进来；
  // 触发源是宿主官方那份 `useSessions().byId[id].running`（api-session/status 广播）。
  //
  // ⚠️ 这里断言的是**接线本身**，不是渲染结果：本测试的桩在「跨 render 的异步 setState」上
  // 不可靠（软刷新那次写入会落在上一代 hook cell 里），验证渲染结果会得到一个假失败。
  // 断源码至少能挡住「有人把这段订阅删掉」——删掉即红。
  {
    const src = readFileSync(join(here, '..', 'client', 'client.js'), 'utf8');
    assert.ok(/wasRunning === true && running === false/.test(src),
      '要在 DM 那一轮结束（running 下降沿）触发软刷新');
    assert.ok(/const running = typeof props\?\.useSessions/.test(src),
      '触发源要用宿主官方那份 useSessions().running，而不是自己猜');
    assert.ok(/async function softReload/.test(src), '要有软刷新函数');
    assert.ok(/if \(!dirtyRef\.current\)/.test(src),
      '软刷新必须在「用户没改过」时才覆盖表单，否则会冲掉正在编辑的内容');
    assert.ok(/lastWatchSig/.test(src), '同一状态重复触发要挡住（否则会自激循环刷）');
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
    for (let i = 0; i < 14 && !findAll(reopened, (n) => n.type === 'img' && String(n.props.src ?? '').includes('/rp-tools/media?')).length; i++) {
      await tick(30);
      reopened = asPanel();
    }
    const imgs = findAll(reopened, (n) => n.type === 'img');
    const portraitImg = imgs.find((n) => String(n.props.src ?? '').includes('/rp-tools/media?'));
    assert.ok(portraitImg, `重新打开面板应显示会话配置里那张立绘（实际 imgs=${JSON.stringify(imgs.map((n) => n.props.src))}）`);
    assert.ok(String(portraitImg.props.src).includes('file=rp-portrait-1.png'), '立绘图 URL 要用记下的三要素拼');
    assert.ok(String(portraitImg.props.src).includes('subfolder=rp'), 'subfolder 也要带上');
    assert.ok(/\.rpt \.charavatar \{[^}]*width:\s*36px/.test(style.textContent), '那张图是**小头像**（36px）');

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

    // 列表里**不再有「大图 / 收起」**：那个「收起」其实会把立绘从会话配置里删掉，
    // 点完就真的看不到了（用户实测）。删立绘挪到编辑浮窗里 —— 那里摆着大图，删之前看得见。
    assert.equal(findAll(afterGen, (n) => textOf(n) === '收起').length, 0, '列表里不该再有「收起」');
    const charRow = byClass(afterGen, 'charbox')[0];
    const rowEdit = findAll(charRow, (n) => typeof n.props?.onClick === 'function' && textOf(n) === '编辑')[0];
    assert.ok(rowEdit, '角色行要有「编辑」');
    await rowEdit.props.onClick();
    await tick(30);
    let withModal2 = asPanel();
    for (let i = 0; i < 14 && !findAll(withModal2, (n) => textOf(n) === '删掉立绘').length; i++) {
      await tick(30);
      withModal2 = asPanel();
    }
    assert.ok(findAll(withModal2, (n) => textOf(n) === '看大图').length >= 1, '编辑浮窗里应有「看大图」');
    const clearBtn = findAll(withModal2, (n) => typeof n.props?.onClick === 'function' && textOf(n) === '删掉立绘')[0];
    assert.ok(clearBtn, '编辑浮窗里应有「删掉立绘」');
    clearBtn.props.onClick();
    for (let i = 0; i < 14 && !portraitPosts.some((p) => p.action === 'clear'); i++) await tick(30);
    const clearPost = portraitPosts.find((p) => p.action === 'clear');
    assert.ok(clearPost, '「删掉立绘」要同时清掉会话配置里那份');
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
    // 内置默认值要与宿主 DEFAULT_IMAGE_SIZES 一致（1.12.8 起调小，出图快 ~1/3）
    assert.deepEqual(vals.slice(0, 2), [768, 432], '缺配置时场景用内置默认值');
    assert.deepEqual(vals.slice(2, 4), [512, 768], '缺配置时立绘用内置默认值');
    const save2 = findAll(legacy, (n) => typeof n.props?.onClick === 'function' && textOf(n) === '保存');
    await save2[0].props.onClick();
    await tick(60);
    const post2 = calls.filter((c) => c.url === '/rp-tools/config' && c.method === 'POST').pop();
    assert.deepEqual(post2?.body?.imageSizes?.scene, [768, 432], '保存要把默认尺寸交回去（旧宿主不会补）');
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
