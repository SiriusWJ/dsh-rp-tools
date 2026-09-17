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
import nodeAssert from 'node:assert/strict';

/**
 * 测试夹具里用的**假工作区路径**。
 *
 * 为什么要有这个常量，而不是各处直接写字面量：
 *  ① 这些路径只是喂给桩的输入，**与任何真实机台无关** —— 但只要它长得像某个人的真实目录，
 *     后来的人就分不清「这是夹具还是漏进来的机台路径」。用 `X:` 这种不存在的盘符一眼可辨。
 *  ② 仓库曾经栽在机台固定路径上（某处默认值写死了开发机的 profile 路径，换机器上
 *     8 个工具全不生效），所以新增了 `tools/check-no-machine-paths.mjs` 扫这类字面量。
 *     集中成一处声明后，扫描器只需认这一个带 `machine-path-ok` 标注的位置。
 *  ③ 桩与断言共用同一个值，改的时候不会漏改某一处（拼 URL 的断言尤其容易漏）。
 */
const FAKE_WS = 'X:\\ws';   // machine-path-ok：中性假路径，与真实机台无关

/**
 * 「第三方工具管理」那张表的当前勾选（默认 = 出厂默认全勾）。
 * 测试要改它来模拟「用户取消了某些工具」，所以放在模块级而不是写死在 fetch 桩里。
 */
let globalToolsAllowStub = null;

/**
 * 本文件用 `assert.*`（失败即抛、立刻停），与 smoke-dm 的 `check()` 不同 —— 所以这里
 * 包一层只为**统计通过/失败数**并给出与 smoke-dm 一致的收尾摘要行（失败照旧抛出去）。
 * 行为不变：成功返回原值，失败先加计数再原样抛。
 */
let pass = 0, fail = 0;
const assert = new Proxy({}, {
  get: (t, key) => (...args) => {
    try { const out = nodeAssert[key](...args); pass += 1; return out; }
    catch (error) { fail += 1; throw error; }
  },
});
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
// 分组规则用**与宿主侧同一份**共享模块（桩不自己抄一份，否则映射表改了测试会假绿）
import { GLOBAL_TOOL_SOURCES, GLOBAL_TOOL_SOURCE_FALLBACK } from '../lib/global-tools-defaults.js';
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
/**
 * 重新挂载（等价于把整棵树卸载重来）：先跑**清理函数**，再清掉钩子状态。
 *
 * ⚠️ 早先这里只是把 cleanups 丢掉 —— 于是「卸载时要做什么」这条路径**从来没被走过**。
 *    RP 右栏页签的挂/撤就是靠 effect 清理做的（DM 会话注册、切走撤销），
 *    不跑清理的话那条路测不到、也可能假绿。真实 React 卸载时一定跑清理。
 */
function resetHooks() {
  const pending = rt.cleanups.splice(0);
  for (const cleanup of pending) { try { cleanup(); } catch { /* 清理失败不该让测试挂掉 */ } }
  rt.cellStore.clear();
  rt.cells = [];
  rt.cursor = 0;
  rt.effects = [];
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
    // ⚠️ 依赖变化时还必须**先跑上一次的清理函数**：这里曾经只 push 新 effect、把旧清理丢掉，
    //    于是「依赖变化 / 卸载时的清理」从来没被执行过（和当年测试桩凭空给 ctx.agent 同类）。
    const cells = rt.cells;
    const i = rt.cursor++;
    const prev = cells[i];
    const list = Array.isArray(deps) ? deps : null;
    const changed = !prev
      || (list === null) !== (prev.list === null)
      || (list !== null && (list.length !== prev.list.length || list.some((d, k) => !Object.is(d, prev.list[k]))));
    if (changed) {
      if (typeof prev?.cleanup === 'function') {
        try { prev.cleanup(); } catch { /* 清理失败不该让测试挂掉 */ }
      }
      cells[i] = { list, cleanup: null };
      rt.effects.push(() => {
        const cleanup = fn();
        const cell = cells[i];
        if (cell) cell.cleanup = typeof cleanup === 'function' ? cleanup : null;
        return cleanup;
      });
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
/** 外部导入立绘的 POST 记录（`/rp-tools/portrait-upload`）。 */
const portraitUploads = [];
/** 资源库的写操作记录（改标签 / 删除 / 提成立绘）。 */
const assetWrites = [];
/** 资源库列表桩（`/rp-tools/assets`）：用例可临时替换，测筛选/图墙/详情。 */
let assetStub = [];
/** 会话包的桩：快照列表 / 快照 / 导入。 */
const snapshotPosts = [];
const bundlePosts = [];
let snapStub = { keep: 5, items: [] };
/** 导入第一次回 409（needsOverwrite），第二次成功 —— 用例可切。 */
let importNeedsOverwrite = true;
/**
 * FileReader 桩：真实浏览器里「选文件 → data URL」就是这一步。
 * 测试造的 File 上带一个 `__dataUrl`，读出来即用它（这样断言能对上具体内容）。
 */
globalThis.FileReader = class {
  readAsDataURL(file) {
    this.result = file?.__dataUrl ?? 'data:image/png;base64,AAAA';
    queueMicrotask(() => this.onload?.());
  }
};
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
/** `/rp-tools/session` 回复里的 isDm（宿主登记表的答案）。用例可切，默认是 DM。 */
let sessionReplyIsDm = true;
globalThis.fetch = async (url, options = {}) => {
  const method = options.method ?? 'GET';
  calls.push({ url: String(url), method, body: options.body ? JSON.parse(options.body) : undefined });
  const target = String(url);
  const reply = (json) => ({ ok: true, status: 200, json: async () => json });
  if (target.startsWith('/rp-tools/gate')) return reply(gateReply);
  // 「第三方工具管理」那张表的数据源：设置页挂载时会拉它一次。
  // 分组**用宿主侧那份真逻辑**（import 同一个共享模块），不在这里手写 ——
  // 桩自己抄一份分组规则的话，哪天映射表改了，测试会「绿着」而真机已经不对了。
  if (target.startsWith('/rp-tools/global-tools')) {
    const all = ['render_ui', 'validate_dsh_ui', 'web_search', 'generate_image', 'edit_image', 'view_canvas'];
    const allow = globalToolsAllowStub ?? ['render_ui', 'validate_dsh_ui', 'web_search', 'generate_image', 'edit_image'];
    const imageLike = (name) => /(^|_)(image|img|photo|picture|draw|paint|illustrat)/i.test(name);
    const toolOf = (name) => ({
      name, checked: allow.includes(name), imageLike: imageLike(name),
      hint: name === 'render_ui' ? 'DM 的卡片全靠它渲染；关掉就只能发纯文字' : '',
    });
    // 按映射表分组（与 lib/index.js 的 groupGlobalTools 同源）
    const rest = [];
    const groups = [];
    for (const src of GLOBAL_TOOL_SOURCES) {
      const tools = all.filter((n) => src.match.test(n));
      if (!tools.length) continue;
      groups.push({ key: src.key, label: src.label, tools: tools.slice().sort(), image: src.image === true });
      rest.push(...tools);
    }
    const others = all.filter((n) => !rest.includes(n)).sort();
    if (others.length) groups.push({ ...GLOBAL_TOOL_SOURCE_FALLBACK, tools: others });
    const missing = allow.filter((n) => !all.includes(n)).sort();
    if (missing.length) {
      // 键与「其它」区分（同键会让界面按 key 渲染时两组互相顶掉）
      groups.push({ key: '__missing__', label: '配置里有、本机没注册', missing: true, tools: missing });
    }
    for (const g of groups) {
      g.tools = g.tools.map((t) => (typeof t === 'string' ? toolOf(t) : t));
      g.all = g.tools.every((t) => t.checked);
      g.some = g.tools.some((t) => t.checked);
      g.image = g.image === true || g.tools.every((t) => t.imageLike);
      g.summary = `${g.tools.filter((t) => t.checked).length}/${g.tools.length} · ${g.tools.map((t) => t.name).join('、')}`;
    }
    return reply({
      ok: true,
      allow,
      defaults: ['render_ui', 'validate_dsh_ui', 'web_search', 'generate_image', 'edit_image'],
      max: 32,
      groups,
      available: all.map(toolOf),
      missing,
    });
  }
  if (target.startsWith('/rp-tools/cards')) {
    return reply({
      ok: true, root: `${FAKE_WS}\\cards`, exists: true, indexSource: 'index', librarySize: 3269,
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
      ok: true, exists: true, file: `${FAKE_WS}\\rp-worldbook.md`, relative: 'rp-worldbook.md',
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
      // 宿主登记表说这是不是 DM 会话。**必须可切** —— 组件的兜底判定读的就是它
      // （`useDmSession` 在预设投影还没就绪时问 /rp-tools/session）；写死 true 的话
      // 「切到非 DM 会话」这条路径永远走不到，测试会假绿。
      ok: true, isDm: sessionReplyIsDm, preset: 'dm',
      // 界面 ensureCwd 的兜底来源：会话工作区（真机上是 resolveWorkspaceDir 那四级链的结果）
      cwd: FAKE_WS,
      session: sessionStub,
    });
  }
  // `/rp-tools/portrait` 现在**只支持 action:"clear"**（本地生图搬走后，「登记生成结果」
  // 那条路没了）。桩照真实宿主的行为回：clear 清掉 generated 那类字段，别的字段保留。
  // 旧的 action:"save" 桩**故意不给** —— 界面若还去调它，会落到最后的「未预期的请求」上而红。
  if (target === '/rp-tools/portrait') {
    const body = JSON.parse(options.body ?? '{}');
    portraitPosts.push(body);
    const cur = { ...(sessionStub.portraits?.[body.name] ?? {}) };
    delete cur.generated;
    delete cur.style;
    delete cur.elapsedMs;
    return reply({ ok: true, sessionId: body.sessionId, portraits: { [body.name]: cur } });
  }
  // 外部导入：界面读成 data URL 后 POST 上来，宿主落盘并回一个同源地址。
  // 1.13.0 起统一走 /rp-tools/asset-upload（角色立绘的 kind=portrait + name 会顺带登记成立绘）。
  if (target === '/rp-tools/asset-upload' || target === '/rp-tools/portrait-upload') {
    const body = JSON.parse(options.body ?? '{}');
    portraitUploads.push(body);
    const kind = body.kind ?? 'portrait';
    const dir = kind === 'item' ? 'items' : (kind === 'scene' ? 'scenes' : (kind === 'other' ? 'other' : 'portraits'));
    const assetId = `a${portraitUploads.length}`;
    return reply({
      ok: true, sessionId: body.sessionId, name: body.name, kind,
      file: `assets/${dir}/${assetId}.png`, bytes: 5,
      asset: { id: assetId, kind, label: body.label ?? body.name ?? '', tags: [], characters: body.name ? [body.name] : [] },
      url: `/rp-tools/asset-image?sessionId=${encodeURIComponent(body.sessionId)}&id=${assetId}`,
      portraits: body.name
        ? {
          ...sessionStub.portraits,
          [body.name]: {
            ...(sessionStub.portraits?.[body.name] ?? {}),
            imported: { file: `assets/portraits/${assetId}.png`, bytes: 5, at: '2026-01-01T00:00:00.000Z' },
          },
        }
        : sessionStub.portraits,
    });
  }
  // 会话包：快照列表 / 拍快照 / 导入（导入第一次回 409 让界面走「确认覆盖」那条路）
  if (target.startsWith('/rp-tools/snapshots?')) {
    return reply({ ok: true, sessionId: sessionStub.sessionId, keep: snapStub.keep, total: snapStub.items.length, items: snapStub.items });
  }
  if (target === '/rp-tools/snapshot') {
    const body = JSON.parse(options.body ?? '{}');
    snapshotPosts.push(body);
    snapStub = {
      keep: 5,
      items: [{ name: 'snapshot-2026-09-13T01-00-00-000Z.zip', bytes: 2048, at: '2026-09-13T01:00:00.000Z' }, ...snapStub.items].slice(0, 5),
    };
    return reply({ ok: true, sessionId: body.sessionId, name: 'snapshot-2026-09-13T01-00-00-000Z.zip', bytes: 2048, files: 5, kept: snapStub.items.length, dropped: [], failed: [], items: snapStub.items });
  }
  if (target === '/rp-tools/import') {
    const body = JSON.parse(options.body ?? '{}');
    bundlePosts.push(body);
    if (importNeedsOverwrite && body.overwrite !== true && importNeedsOverwrite !== 'never') {
      return reply({ ok: false, needsOverwrite: true, error: '目标会话已有内容。要覆盖请传 overwrite:true' });
    }
    return reply({ ok: true, sessionId: body.sessionId, from: 'old-session-id', files: 6, bytes: 4096, snapshot: 'snapshot-before.zip' });
  }
  // 资源库列表：面板图墙用它。assetStub 可被用例临时替换。
  if (target.startsWith('/rp-tools/assets?')) {
    const u = new URL(target, 'http://127.0.0.1:3080');
    const kind = u.searchParams.get('kind') ?? '';
    const q = (u.searchParams.get('q') ?? '').toLowerCase();
    const list = assetStub.filter((a) => (!kind || a.kind === kind)
      && (!q || `${a.label} ${(a.tags ?? []).join(' ')} ${(a.characters ?? []).join(' ')}`.toLowerCase().includes(q)));
    const counts = { portrait: 0, scene: 0, item: 0, other: 0 };
    for (const a of assetStub) counts[a.kind] += 1;
    return reply({
      ok: true, sessionId: sessionStub.sessionId, total: list.length, counts,
      // 分类清单由宿主给（界面不自己维护一份映射）
      kinds: [
        { key: 'portrait', label: '角色', count: counts.portrait },
        { key: 'scene', label: '场景', count: counts.scene },
        { key: 'item', label: '道具', count: counts.item },
        { key: 'other', label: '其他', count: counts.other },
      ],
      assets: list.map((a) => ({
        ...a,
        url: `/rp-tools/asset-image?sessionId=${sessionStub.sessionId}&id=${a.id}`,
        previewUrl: `/rp-tools/asset-image?sessionId=${sessionStub.sessionId}&id=${a.id}&thumb=1&width=480`,
      })),
    });
  }
  // 资源库写操作：改标签 / 删除 / 提成某角色的立绘
  if (target === '/rp-tools/assets') {
    const body = JSON.parse(options.body ?? '{}');
    assetWrites.push(body);
    if (body.action === 'delete') {
      assetStub = assetStub.filter((a) => a.id !== body.id);
      return reply({ ok: true, sessionId: body.sessionId, action: 'delete', id: body.id, fileGone: true, droppedPortraits: ['阿岚'] });
    }
    if (body.action === 'useAsPortrait') {
      const one = assetStub.find((a) => a.id === body.id) ?? {};
      return reply({
        ok: true, sessionId: body.sessionId, name: body.name, assetId: body.id,
        portraits: { [body.name]: { imported: { file: one.file ?? 'x.png', bytes: 5, at: '2026-01-01T00:00:00.000Z' } } },
      });
    }
    assetStub = assetStub.map((a) => (a.id === body.id
      ? { ...a, label: body.label ?? a.label, tags: String(body.tags ?? '').split(/[,，、;；\s]+/).filter(Boolean) }
      : a));
    return reply({ ok: true, sessionId: body.sessionId, action: 'update', asset: assetStub.find((a) => a.id === body.id) });
  }
  if (target.startsWith('/rp-tools/state')) {
    return reply({
      ok: true, file: `${FAKE_WS}\\styles.json`,
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
/**
 * 插槽桩。`register` / `inject` 都必须**可撤销**：
 *   · `register` 返回的 disposer 要把注册项从 slotRegs 里摘掉；
 *   · `inject(key, cb)` 返回的 disposer 要跑 cb 返回的清理函数（Cordis 的语义）。
 * 早先两个都返回空操作 —— 于是「运行中撤销一个槽位注册」这条路测试里永远走不到，
 * 而 RP 右栏页签正是靠它按会话挂/撤的。
 */
const slotsStub = {
  inject: (key, cb) => {
    registered.push(key);
    const inner = cb();
    return () => { if (typeof inner === 'function') inner(); };
  },
  register: (spec, component) => {
    const row = { ...spec, component };
    slotRegs.push(row);
    return () => {
      const at = slotRegs.indexOf(row);
      if (at >= 0) slotRegs.splice(at, 1);
    };
  },
};
// ctx 桩：remote / uiWorkspace 都给上，让「切预设」与「新建会话」两条路都能被走到
let startedSessions = 0;
const selectedPresets = [];
// 宿主转发给客户端的事件（`remote.$on`）：预设切换就靠它触发「重新判断入口」
const remoteEventHandlers = new Map();
/** 已注册的右栏页签类型（`register` 返回的撤销函数会把它移出去）。 */
const tabRegistrations = [];
const ctx = {
  slots: slotsStub,
  // 右栏那两个服务：回调要真的跑，否则 `sidebar.right.pane.tab` 不会被注册（面板也就无从渲染）。
  // `register` 必须**可撤销**并记录定义 —— RP 页签类型现在按「本会话是不是 DM」挂/撤，
  // 测试要能断言「非 DM 会话的引导页里没有 RP 那条」。
  inject: (names, fn) => {
    // ⚠️ 必须模拟真实 Cordis 契约：`ctx.inject(deps, cb)` 返回 `{ dispose() }` 的 handle，
    //    不是裸函数。此前桩错误地返回函数，正好掩盖了生产 bug：代码只认函数，导致真机
    //    离开 DM 会话后没有运行 cb 的清理，应用级 RP 页签类型永久残留。
    let inner = null;
    if (typeof fn === 'function' && Array.isArray(names) && names.includes('sidebarRightTabs')) {
      inner = fn({
        slots: slotsStub,
        sidebarRightTabs: {
          register: (def) => {
            tabRegistrations.push(def);
            return () => {
              const at = tabRegistrations.indexOf(def);
              if (at >= 0) tabRegistrations.splice(at, 1);
            };
          },
        },
        sidebarRight: { openTab: () => {}, isExpanded: () => false, active: () => null },
      });
    }
    let disposed = false;
    return {
      dispose() {
        if (disposed) return;
        disposed = true;
        if (typeof inner === 'function') inner();
      },
    };
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
function propsFor({ blank = true, preset = '', cwd = FAKE_WS, sid = SID } = {}) {
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

/**
 * 确保右栏的「RP 面板」页签**已注册**，返回它的注册项。
 *
 * 页签类型不再由 apply 注册，而是跟「当前显示的会话是不是 DM」走 —— 所以任何要渲染
 * 面板本体的用例，都得先把 DM 会话的头部按钮挂上（那正是不变量本身：非 DM 会话没有这个页签）。
 */
async function ensureSidebarTab() {
  const headerReg = slotRegs.find((r) => r.name === 'conversation.session.header.utilities');
  assert.ok(headerReg, '应注册头部入口（页签类型由它按 DM 判定挂载）');
  sessionReplyIsDm = true;
  gateReply = { ok: true, dm: true, started: false };
  let seat = slotRegs.find((r) => r.name === 'sidebar.right.pane.tab');
  for (let i = 0; i < 8 && !seat; i += 1) {
    render(propsFor({ preset: 'dm', blank: false }), headerReg.component);
    await tick(20);
    seat = slotRegs.find((r) => r.name === 'sidebar.right.pane.tab');
  }
  return seat;
}

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
  // 「刷新」不能再只是复用宿主的永久扫描缓存；必须显式要求重扫磁盘。
  const refreshButton = findAll(tree2, (n) => n.type === 'button' && textOf(n) === '刷新')[0];
  assert.ok(refreshButton, '导入面板应有刷新按钮');
  refreshButton.props.onClick();
  await tick(40);
  const forcedRefresh = calls.filter((c) => c.url.startsWith('/rp-tools/cards?')).pop();
  assert.ok(forcedRefresh?.url.includes('refresh=1'), `刷新按钮必须带 refresh=1（实际：${forcedRefresh?.url}）`);

  // ⑤ 导入：切 dm 预设 → POST 导入 → 把开场指令塞进输入框并提交
  importBtn[0].props.onClick();
  await tick(80);
  render(DM_PROPS());   // 编辑器把草稿同步好了 → 组件这一帧提交
  await tick(120);
  assert.equal(selectedPresets.length, 0, '会话已经是 dm 预设 → 不该再重复切一次（入口本来就只在 dm 新会话上出现）');
  assert.equal(importPosts().length, 1, '应 POST /rp-tools/card-import');
  assert.equal(importPosts()[0].body.path, 'cards/古风/长安.card.png', 'POST 应带上选中的卡路径');
  assert.equal(importPosts()[0].body.workspace, FAKE_WS, 'POST 应带上会话工作区（宿主据此落盘）');
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

// ── 右栏页签类型只在 DM 会话注册（用户报的「右侧栏每个会话都有 RP 跑团面板」）──
// 根因：右栏展开时的引导页列的是**所有已注册类型**的条目，而类型注册是**应用级**的
// （`tabs.register` 不按会话）。以前在 apply 里注册一次就再也不撤 —— 非 DM 会话也照样列着。
// 现在由会话头部按钮按「本会话是不是 DM」挂/撤，并带引用计数（重复注册同一 id 会抛错）。
{
  const headerReg = slotRegs.find((r) => r.name === 'conversation.session.header.utilities');
  const tabSeat = () => slotRegs.some((r) => r.name === 'sidebar.right.pane.tab');
  const rpGuide = () => tabRegistrations.filter((d) => d.kind === 'dsh-rp-tools');

  // 从干净状态开始：先卸载（跑清理）→ 应彻底撤掉
  resetHooks();
  assert.equal(rpGuide().length, 0, '没有任何会话头部挂载时，不该注册 RP 页签类型');
  assert.equal(tabSeat(), false, '…也不该留下页签座位');

  // ① DM 会话：挂上头部 → 注册，且引导页里就有 RP 那条
  sessionReplyIsDm = true;
  gateReply = { ok: true, dm: true, started: false };
  render(propsFor({ preset: 'dm', blank: false }), headerReg.component);
  for (let i = 0; i < 8 && rpGuide().length === 0; i += 1) {
    await tick(20);
    render(propsFor({ preset: 'dm', blank: false }), headerReg.component);
  }
  assert.equal(rpGuide().length, 1, 'DM 会话应注册 RP 页签类型');
  assert.ok(rpGuide()[0].guide.some((g) => String(g.title()).includes('RP 跑团面板')),
    '引导页条目里应有「🎲 RP 跑团面板」');
  assert.equal(tabSeat(), true, 'DM 会话要注册页签座位（面板本体才有地方渲染）');

  // ② 切到非 DM 会话（宿主与投影都说不是）→ **先跑清理**，撤掉
  sessionReplyIsDm = false;
  gateReply = { ok: true, dm: false, started: false };
  for (let i = 0; i < 8 && rpGuide().length > 0; i += 1) {
    await tick(20);
    render(propsFor({ preset: 'standard', blank: false, sid: 'session-other' }), headerReg.component);
  }
  assert.equal(rpGuide().length, 0, '切到非 DM 会话应撤销 RP 页签类型');
  assert.equal(tabSeat(), false, '非 DM 会话不该留下页签座位');

  // ③ 再渲染一次不该重复注册（同一个组件重复提交是常态；重复注册同一个 id 会被
  //    页签注册表判为接线错误直接抛错）。引用计数里 >1 的那条分支要「同时挂两个实例」
  //    才走得到，而这个测试桩的钩子槽位按组件类型共享 —— 模拟不出两个实例，如实记在这里。
  sessionReplyIsDm = true;
  gateReply = { ok: true, dm: true, started: false };
  for (let i = 0; i < 8 && rpGuide().length === 0; i += 1) {
    await tick(20);
    render(propsFor({ preset: 'dm', blank: false }), headerReg.component);
  }
  render(propsFor({ preset: 'dm', blank: false }), headerReg.component);
  assert.equal(rpGuide().length, 1, '重复渲染不该注册第二份（注册表会抛错）');

  // ④ 卸载整棵树 → 跑清理 → 撤掉
  resetHooks();
  assert.equal(rpGuide().length, 0, '全部卸载后应撤销 RP 页签类型');
  assert.equal(tabSeat(), false, '全部卸载后座位也要撤掉');
  gateReply = { ok: true, dm: true, started: false };
}

// ── 关键断言 ④：RP 面板要能看到世界书条目（用户提的问题）───────────────────
{
  // RP 页签类型**不再是 apply 时注册的**：它是按「本会话是不是 DM」挂/撤的
  // （否则右栏引导页会在每个会话都列着「🎲 RP 跑团面板」，用户报的就是这个）。
  // 所以这里先把 DM 会话的头部按钮挂上，触发注册，再取页签组件。
  {
    const headerReg = slotRegs.find((r) => r.name === 'conversation.session.header.utilities');
    assert.ok(headerReg, '应注册头部入口（页签类型由它按 DM 判定挂载）');
    resetHooks();
    render(propsFor({ preset: 'dm', blank: false }), headerReg.component);
    await tick(30);
  }
  const tab = await ensureSidebarTab();
  assert.ok(tab, 'DM 会话下应注册右侧栏面板页签（RP 面板本体）');
  resetHooks();
  const store = { current: SID, byId: { [SID]: { blank: false, cwd: FAKE_WS, projectionValues: { agentPreset: 'dm' } } } };
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

  // ★ 角色卡卡片：标题叫「角色卡」，立绘按角色名挂在角色行上当小头像
  {
    assert.ok(text.includes('角色卡（'), '卡片标题应叫「角色卡」');
    assert.equal(text.includes('人物（'), false, '不该叫「人物」');
    // 只有「卡面」没有导入立绘时：卡面也**直接当这个角色的立绘用**（宿主侧 renderDmSetup 同一口径：
    // 「导入卡的卡面就是它的立绘」）。所以角色行要出图，走的是卡面路由。
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
    assert.equal(byClass(cardFaceOnly, 'charbox')[0]?.props['data-hasface'], 'true', '只有卡面时角色行也要出图（卡面＝立绘）');
    const cardFaceImg = findAll(cardFaceOnly, (n) => n.type === 'img'
      && String(n.props.src ?? '').includes('/rp-tools/card-image?'));
    assert.ok(cardFaceImg.length >= 1, '卡面走的是卡面路由（不是已删掉的媒体代理）');
    // 卡面路径是 URL 编码进 query 的，所以断言解码后的值（别拿中文原文去比编码串）
    assert.ok(decodeURIComponent(String(cardFaceImg[0].props.src)).includes('cards/古风/长安.card.png'),
      '取的是会话里那张卡面');
    // 旧版（ComfyUI 三要素）的 `generated` 已经没人认：媒体代理删掉了，它只剩一个死引用，
    // 所以「只有 generated」= 一张可用图都没有 → 出占位头像，也不该去拼 /rp-tools/media。
    sessionStub.portraits = {
      阿岚: {
        generated: { file: 'rp-portrait-1.png', subfolder: 'rp', type: 'output' },
        style: '二次元', elapsedMs: 18300, at: '2026-09-12T01:00:00.000Z',
      },
    };
    resetHooks();
    {
      let legacyFace = render({
        sessionId: SID,
        useSessions: (sel) => sel(store),
        useInput: (sel) => sel({ draft: '' }),
        inputActions,
      }, tab.component);
      for (let i = 0; i < 14 && byClass(legacyFace, 'charbox').length === 0; i++) {
        await tick(30);
        legacyFace = render({
          sessionId: SID,
          useSessions: (sel) => sel(store),
          useInput: (sel) => sel({ draft: '' }),
          inputActions,
        }, tab.component);
      }
      assert.equal(byClass(legacyFace, 'charbox')[0]?.props['data-hasface'], 'false',
        '只有老 generated 时退回占位头像（那张图取不到了）');
      assert.equal(findAll(legacyFace, (n) => n.type === 'img'
        && String(n.props.src ?? '').includes('/rp-tools/media?')).length, 0,
        '绝不能再去拼已删的 /rp-tools/media 地址');
    }
    // 有一张**导入的**立绘 → 图在左、字段在右（DOM 顺序 charavatar → charbody）
    sessionStub.portraits = {
      阿岚: { imported: { file: 'portraits/abc.png', bytes: 5, at: '2026-09-12T01:00:00.000Z' } },
    };
    resetHooks();
    let withFace = render({
      sessionId: SID,
      useSessions: (sel) => sel(store),
      useInput: (sel) => sel({ draft: '' }),
      inputActions,
    }, tab.component);
    for (let i = 0; i < 14 && !findAll(withFace, (n) => n.type === 'img'
      && String(n.props.src ?? '').includes('/rp-tools/portrait-image?')).length; i++) {
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
    // 有图的行里那张图就是头像（导入立绘走 portrait-image、卡面走 card-image；
    // 老版本的 `/rp-tools/media` 代理已随本地生图删除，绝不该再出现）
    const avatarImg = findAll(withFace, (n) => n.type === 'img'
      && /\/rp-tools\/(portrait-image|card-image)\?/.test(String(n.props.src ?? '')));
    assert.ok(avatarImg.length >= 1, '有图时角色行要显示头像图');
    assert.equal(findAll(withFace, (n) => n.type === 'img'
      && String(n.props.src ?? '').includes('/rp-tools/media?')).length, 0,
      '不该再引用已删掉的 /rp-tools/media 代理');
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
    assert.ok(/\.rpt \.chareditform \.facepreview img \{[^}]*max-height:\s*calc\(88vh/.test(style.textContent),
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
    // ★「查看大图」已去掉（用户要求）：立绘在这里就是最大的尺寸，再开一个标签页没意义
    assert.equal(textOf(charModal).includes('看大图'), false, '编辑器里不该再有「看大图」');
    assert.equal(findAll(charForm, (n) => n.type === 'a').length, 0, '编辑器里不该再有外链（看大图）');
    // ★ 「删掉立绘」与「重新生成」都不该再有：立绘现在只有**导入**一条来路
    //   （本地生图（ComfyUI）整块删掉了，出图归宿主的 generate_image），所以这里既不该有
    //   把记录删掉的按钮，也不该有「重新生成」。
    assert.equal(textOf(charModal).includes('删掉立绘'), false, '「删掉立绘」应被去掉');
    assert.equal(findAll(charForm, (n) => typeof n.props?.onClick === 'function'
      && textOf(n) === '重新生成').length, 0, '不该再提供「重新生成」（本插件不出图）');
    assert.equal(textOf(charModal).includes('出图中'), false, '不该再有出图中的忙碌态');
    // ★ 外部导入（用户要求）：一个 file input，只收 png/jpeg/webp
    const fileInput = findAll(charForm, (n) => n.type === 'input' && n.props.type === 'file')[0];
    assert.ok(fileInput, '编辑器里要有导入立绘的 file input');
    assert.equal(fileInput.props.accept, 'image/png,image/jpeg,image/webp', '只收 png/jpeg/webp');
    assert.equal(fileInput.props.disabled, false, '空闲时不该禁用');
    // 真的走一遍：选文件 → FileReader → POST /rp-tools/portrait-upload
    const beforeUploads = portraitUploads.length;
    fileInput.props.onChange({
      target: { value: 'C:\\fakepath\\x.png', files: [{ name: 'x.png', __dataUrl: 'data:image/png;base64,QUJD' }] },
    });
    for (let i = 0; i < 12 && portraitUploads.length === beforeUploads; i++) await tick(30);
    assert.equal(portraitUploads.length, beforeUploads + 1, '选完文件应 POST 一次 portrait-upload');
    assert.equal(portraitUploads.at(-1).name, '阿岚', '导入的图要挂在角色名下');
    assert.equal(portraitUploads.at(-1).kind, 'portrait', '角色编辑器导入走 kind=portrait（顺带登记成立绘）');
    assert.equal(portraitUploads.at(-1).dataUrl, 'data:image/png;base64,QUJD', '传的是 FileReader 读出的 data URL');
    assert.equal(portraitUploads.at(-1).sessionId, SID, '带上会话 id');
    // 导入之后**不许再去调已删的 /rp-tools/preview**（那是老的本地出图路由）
    assert.equal(calls.filter((c) => c.url === '/rp-tools/preview').length, 0,
      '界面不该再去调已删的 /rp-tools/preview');
    // 这一下会往记录里塞条目；后面的立绘持久化用例按**绝对条数**断言，先清干净
    portraitPosts.length = 0;
    portraitUploads.length = 0;
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
  // DM（旁白）卡不是角色卡：它的正文要落在这里。
  // ⚠️ 原先这段还测「本会话生图」三个开关（面板最上面那块）。本地生图搬走后
  //    `session.dm.images` 与那三个开关整块删了，所以这里只留正文相关的断言；
  //    老数据里残留的 `images` 键不该让面板渲染出任何东西（下面钉住这一点）。
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
    // ★ 「本会话生图」整块没了：出图不是本插件的事（配图走宿主的 generate_image）
    assert.equal(textOf(withDm).includes('本会话生图'), false, '不该再有「本会话生图」卡片');
    assert.equal(textOf(withDm).includes('生图配置（本会话）'), false, '不该再有生图配置卡片');
    assert.equal(textOf(withDm).includes('首次出场'), false, '不该再有「首次出场」生图开关');
    assert.equal(textOf(withDm).includes('重要场景'), false, '不该再有「重要场景」生图开关');
    // 老数据里残留的 `dm.images` 也不该被渲染成任何控件
    const dmCardBoxes = findAll(dmCard, (n) => n.type === 'input' && n.props.type === 'checkbox');
    assert.equal(dmCardBoxes.length, 0, 'DM 设定卡里不该有生图开关（连老数据的残留也不渲染）');
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
  //   会话配置里记着的立绘，面板**重新打开**时必须装回来（原先它只活在面板组件的 state 里）。
  //   ⚠️ 1.14.0 起只认两种来路：**玩家导入的**（`imported`，走 /rp-tools/portrait-image）与
  //   **导入卡的卡面**（`card`，走 /rp-tools/card-image）。老版本的 `generated`（ComfyUI 三要素）
  //   连同 `/rp-tools/media` 代理一起删了 —— 它现在只是个死引用（见下面「老 generated 不被认」）。
  {
    const asPanel = () => render({
      sessionId: SID,
      useSessions: (sel) => sel(store),
      useInput: (sel) => sel({ draft: '' }),
      inputActions,
    }, tab.component);

    // ① 会话配置里是一张**导入的**立绘 → 重新挂载（模拟下次打开）时必须装回来
    sessionStub.characters = [{ name: '阿岚', appearance: '白衣长剑' }];
    sessionStub.portraits = {
      阿岚: { imported: { file: 'portraits/abc.png', bytes: 5, at: '2026-09-12T01:00:00.000Z' } },
    };
    resetHooks();
    let reopened = asPanel();
    for (let i = 0; i < 14 && !findAll(reopened, (n) => n.type === 'img'
      && String(n.props.src ?? '').includes('/rp-tools/portrait-image?')).length; i++) {
      await tick(30);
      reopened = asPanel();
    }
    const imgs = findAll(reopened, (n) => n.type === 'img');
    const portraitImg = imgs.find((n) => String(n.props.src ?? '').includes('/rp-tools/portrait-image?'));
    assert.ok(portraitImg, `重新打开面板应显示会话配置里那张立绘（实际 imgs=${JSON.stringify(imgs.map((n) => n.props.src))}）`);
    assert.ok(String(portraitImg.props.src).includes(`name=${encodeURIComponent('阿岚')}`), '导入立绘按角色名取');
    assert.ok(/\.rpt \.charavatar \{[^}]*width:\s*36px/.test(style.textContent), '那张图是**小头像**（36px）');

    // ② 老版本的 `generated`（ComfyUI 三要素）**不再被认**：媒体代理已删，它就是死引用。
    //    面板要退回占位头像，且绝不能拼出 /rp-tools/media 的地址。
    sessionStub.portraits = {
      阿岚: {
        generated: { file: 'rp-portrait-1.png', subfolder: 'rp', type: 'output' },
        style: '二次元', elapsedMs: 18300, at: '2026-09-12T01:00:00.000Z',
      },
    };
    resetHooks();
    let legacyOnly = asPanel();
    for (let i = 0; i < 14 && byClass(legacyOnly, 'charavatar').length === 0; i++) {
      await tick(30);
      legacyOnly = asPanel();
    }
    assert.equal(byClass(legacyOnly, 'charbox')[0]?.props['data-hasface'], 'false',
      '只有老 generated 时角色行退回占位头像（那张图取不到了）');
    assert.equal(findAll(legacyOnly, (n) => n.type === 'img'
      && String(n.props.src ?? '').includes('/rp-tools/media?')).length, 0,
      '绝不能再去拼已删的 /rp-tools/media 地址');
    assert.equal(portraitPosts.length, 0,
      '界面不该再 POST /rp-tools/portrait 去「登记生成结果」（那条路只剩 clear）');

    // ③ 列表里**不再有「大图 / 收起」**：那个「收起」其实会把立绘从会话配置里删掉，
    //    点完就真的看不到了（用户实测）。
    assert.equal(findAll(legacyOnly, (n) => textOf(n) === '收起').length, 0, '列表里不该再有「收起」');
    const charRow = byClass(legacyOnly, 'charbox')[0];
    const rowEdit = findAll(charRow, (n) => typeof n.props?.onClick === 'function' && textOf(n) === '编辑')[0];
    assert.ok(rowEdit, '角色行要有「编辑」');
    await rowEdit.props.onClick();
    await tick(30);
    const withModal2 = asPanel();
    // 「看大图」和「删掉立绘」都按用户要求去掉了：图在浮窗里已经是最大尺寸；
    // 而现在**连「重新生成」也没有了** —— 立绘只能导入（出图归宿主的 generate_image）。
    assert.equal(findAll(withModal2, (n) => textOf(n) === '看大图').length, 0, '编辑浮窗里不该再有「看大图」');
    assert.equal(findAll(withModal2, (n) => textOf(n) === '删掉立绘').length, 0, '不该再有「删掉立绘」');
    assert.equal(findAll(withModal2, (n) => textOf(n) === '重新生成').length, 0,
      '不该再有「重新生成」（本插件不出图）');
    assert.ok(findAll(withModal2, (n) => n.type === 'input' && n.props.type === 'file').length >= 1,
      '编辑浮窗里应有导入立绘的 file input');

    // 立绘记录的清理改由**删角色**兜底（否则会话配置里留一条孤儿记录）
    const delBtn = findAll(charRow, (n) => String(n.props?.className ?? '').split(/\s+/).includes('iconbtn'))[0];
    assert.ok(delBtn, '角色行要有删除按钮');
    delBtn.props.onClick();
    for (let i = 0; i < 14 && !portraitPosts.some((p) => p.action === 'clear'); i++) await tick(30);
    const clearPost = portraitPosts.find((p) => p.action === 'clear');
    assert.ok(clearPost, '删角色时要顺手清掉它的立绘记录');
    assert.equal(clearPost.name, '阿岚', '清除要指名道姓（按角色名）');

    // ★ 外部导入的立绘（用户要求）：会话配置里记的是**相对路径**，界面要拼成
    // /rp-tools/portrait-image?sessionId=&name=&v=（v 用导入时间，同名重导才不会被缓存挡住）
    portraitPosts.length = 0;
    sessionStub.portraits = {
      阿岚: { imported: { file: 'portraits/阿岚.png', bytes: 5, at: '2026-01-01T00:00:00.000Z' } },
    };
    resetHooks();
    let imported = asPanel();
    for (let i = 0; i < 14 && !findAll(imported, (n) => n.type === 'img'
      && String(n.props.src ?? '').includes('/rp-tools/portrait-image?')).length; i++) {
      await tick(30);
      imported = asPanel();
    }
    const importedImg = findAll(imported, (n) => n.type === 'img'
      && String(n.props.src ?? '').includes('/rp-tools/portrait-image?'))[0];
    assert.ok(importedImg, '导入的立绘也要在角色卡上显示出来');
    const importedSrc = String(importedImg.props.src);
    assert.ok(importedSrc.includes(`sessionId=${SID}`), '取导入立绘要带 sessionId（按会话目录取文件）');
    assert.ok(importedSrc.includes(`name=${encodeURIComponent('阿岚')}`), '要按角色名取那张图');
    assert.ok(importedSrc.includes('v=2026-01-01T00%3A00%3A00.000Z') || importedSrc.includes('v=2026-01-01T00:00:00.000Z'),
      `要带 v（导入时间）绕过缓存（实际 ${importedSrc}）`);
    assert.equal(importedSrc.includes('/rp-tools/media?'), false, '导入的图不走已删的 ComfyUI 媒体代理');

    // 还原，免得影响后面的用例
    sessionStub.characters = [];
    sessionStub.portraits = {};
    resetHooks();
  }
}
  // ★ 资源库（1.13.0）：DM 出过的图与导入的图都在图墙里 —— 可筛选、可搜、可显示到对话、
  //   可提成某角色的立绘、可删。**DM 侧不能删**（那是玩家的事），所以删除只出现在这里。
  {
    // 自己拿一次面板页签与 store（上一块的 tab 已经出了作用域）
    const tab = await ensureSidebarTab();
    const store = { current: SID, byId: { [SID]: { blank: false, cwd: FAKE_WS, projectionValues: { agentPreset: 'dm' } } } };
    const asPanel = () => render({
      sessionId: SID,
      useSessions: (sel) => sel(store),
      useInput: (sel) => sel({ draft: '' }),
      inputActions,
    }, tab.component);
    const savedAssets = assetStub;
    const savedChars = sessionStub.characters;
    sessionStub.characters = [{ name: '阿岚', appearance: '白衣长剑' }];
    assetStub = [
      {
        id: 's1', kind: 'scene', label: '雨夜客栈大堂', tags: ['客栈', '雨夜'], characters: ['祁俊'],
        width: 768, height: 432, bytes: 409600, source: 'generated',
        prompt: '雨夜里的客栈大堂', at: '2026-09-13T01:00:00Z',
      },
      {
        id: 'p1', kind: 'portrait', label: '祁俊立绘', tags: ['立绘'], characters: ['祁俊'],
        width: 512, height: 768, bytes: 204800, source: 'generated', at: '2026-09-13T00:00:00Z',
      },
      { id: 'i1', kind: 'item', label: '青铜钥匙', tags: ['道具'], characters: [], bytes: 1024, source: 'imported', at: '2026-09-12T00:00:00Z' },
    ];
    resetHooks();
    let p = asPanel();
    for (let i = 0; i < 16 && byClass(p, 'assettile').length === 0; i++) { await tick(30); p = asPanel(); }
    const card = byClass(p, 'card').find((c) => textOf(c).includes('资源库'));
    assert.ok(card, '面板要有「资源库」卡片');
    const cardText = textOf(card);
    assert.ok(cardText.includes('资源库（3）'), '标题报库里的总数');
    assert.equal(byClass(card, 'assettile').length, 3, '图墙里三张图都要出来');
    // 缩略图必须走服务端降采样：原图直出（一张几百 KB × 上百张）会拖死面板
    const firstImg = findAll(byClass(card, 'assettile')[0], (n) => n.type === 'img')[0];
    assert.ok(String(firstImg.props.src).includes('thumb=1'), '图墙用缩略图地址，不原图直出');
    assert.ok(String(firstImg.props.src).includes('/rp-tools/asset-image?'), '缩略图也走资源库路由');
    assert.equal(firstImg.props.loading, 'lazy', '图墙要懒加载');
    // 筛选条由**宿主给的分类**渲染（界面不自己维护一份映射），带条数
    assert.ok(cardText.includes('全部 3'), '要有「全部」与总数');
    assert.ok(cardText.includes('角色 1') && cardText.includes('场景 1') && cardText.includes('道具 1'),
      `分类按宿主给的 label/count 渲染（实际 ${cardText}）`);
    // 点「场景」→ 只显示那一类；「全部」的计数**不跟着变**（否则看着像图丢了）
    const sceneBtn = findAll(card, (n) => n.type === 'button' && textOf(n) === '场景 1')[0];
    assert.ok(sceneBtn, '分类要是可点的按钮');
    await sceneBtn.props.onClick();
    for (let i = 0; i < 8; i++) await tick(30);
    const filtered = asPanel();
    assert.equal(byClass(filtered, 'assettile').length, 1, '点「场景」后只剩场景图');
    assert.ok(textOf(filtered).includes('全部 3'), '「全部」报的是库里总数，不随筛选变化');
    // 回到「全部」再搜（分类筛选是**持久**的：点过「场景」之后搜「钥匙」当然是 0 条）
    const allBtn = findAll(filtered, (n) => n.type === 'button' && textOf(n) === '全部 3')[0];
    await allBtn.props.onClick();
    for (let i = 0; i < 8; i++) await tick(30);
    const reset = asPanel();
    assert.equal(byClass(reset, 'assettile').length, 3, '点「全部」后三张都回来');
    // 搜索框：输入即按关键词过滤（宿主侧的 q 参数）
    const searchInput = findAll(reset, (n) => n.type === 'input' && n.props.type === 'search')[0];
    assert.ok(searchInput, '资源库要有搜索框');
    searchInput.props.onChange({ target: { value: '钥匙' } });
    for (let i = 0; i < 8; i++) await tick(30);
    const searched = asPanel();
    assert.equal(byClass(searched, 'assettile').length, 1, '搜索「钥匙」只剩道具那张');
    // 关键词也要能命中标签（不只是名字）
    const searchInput2 = findAll(searched, (n) => n.type === 'input' && n.props.type === 'search')[0];
    searchInput2.props.onChange({ target: { value: '雨夜' } });
    for (let i = 0; i < 8; i++) await tick(30);
    assert.equal(byClass(asPanel(), 'assettile').length, 1, '按标签也能搜到');
    const searchInput3 = findAll(asPanel(), (n) => n.type === 'input' && n.props.type === 'search')[0];
    searchInput3.props.onChange({ target: { value: '' } });
    for (let i = 0; i < 8; i++) await tick(30);
    const back = asPanel();
    assert.equal(byClass(back, 'assettile').length, 3, '清空搜索后回到全部');
    // 导入：分类下拉 + file input（选完走 FileReader → POST /rp-tools/asset-upload）
    const kindSel = findAll(back, (n) => n.type === 'select' && String(n.props.className ?? '').includes('assetkindsel'))[0];
    assert.ok(kindSel, '导入要能选分类');
    kindSel.props.onChange({ target: { value: 'item' } });
    const reRendered = asPanel();
    const importInput = findAll(reRendered, (n) => n.type === 'input' && n.props.type === 'file'
      && String(n.props.accept ?? '').includes('image/png'))[0];
    assert.ok(importInput, '资源库要有导入图片的 file input');
    assert.equal(importInput.props.accept, 'image/png,image/jpeg,image/webp', '导入只收 png/jpeg/webp');
    const beforeImports = portraitUploads.length;
    importInput.props.onChange({
      target: { value: 'x.png', files: [{ name: '掉落图.png', __dataUrl: 'data:image/png;base64,QUJD' }] },
    });
    for (let i = 0; i < 12 && portraitUploads.length === beforeImports; i++) await tick(30);
    assert.equal(portraitUploads.length, beforeImports + 1, '选完文件要 POST 一次');
    assert.equal(portraitUploads.at(-1).kind, 'item', '导入时选中的分类要传上去');
    assert.equal(portraitUploads.at(-1).dataUrl, 'data:image/png;base64,QUJD', '传的是 data URL');

    // 点一张图 → 详情浮窗：大图 + 名称/标签 + 三个动作
    resetHooks();
    let withGrid = asPanel();
    for (let i = 0; i < 16 && byClass(withGrid, 'assettile').length === 0; i++) { await tick(30); withGrid = asPanel(); }
    const tile = byClass(withGrid, 'assettile')[0];
    await tile.props.onClick();
    await tick(30);
    const modal = asPanel();
    assert.equal(findAll(modal, (n) => n.type === 'Portal').length, 1, '资源详情要 portal 到页面根级');
    const view = byClass(modal, 'assetview')[0];
    assert.ok(view, '详情里要有 assetview');
    const big = findAll(view, (n) => n.type === 'img')[0];
    assert.ok(String(big.props.src).includes('/rp-tools/asset-image?'), '大图走资源库路由');
    assert.equal(String(big.props.src).includes('thumb=1'), false, '详情看的是原图，不是缩略图');
    const labelInput = findAll(view, (n) => n.type === 'input' && n.props.value === '雨夜客栈大堂')[0];
    assert.ok(labelInput, '名称框要带出当前名字');
    const tagInput = findAll(view, (n) => n.type === 'input' && n.props.value === '客栈,雨夜')[0];
    assert.ok(tagInput, '标签框要带出当前标签（逗号分隔）');
    assert.ok(textOf(view).includes('提示词'), '详情要能看到提示词原文');
    // 「显示到对话」：拼一段 dsh-ui 围栏填进输入框（**不自动发送**，和「整理设定」一个路子）
    const draftsBefore = actions.drafts.length;
    const submittedBefore = actions.submitted;
    const showBtn = findAll(view, (n) => n.type === 'button' && textOf(n) === '显示到对话')[0];
    assert.ok(showBtn, '详情里要有「显示到对话」');
    showBtn.props.onClick();
    assert.equal(actions.drafts.length, draftsBefore + 1, '「显示到对话」要把内容填进输入框');
    const fence = String(actions.drafts.at(-1));
    assert.ok(fence.includes('```dsh-ui'), '填进去的是一段 dsh-ui 围栏');
    assert.ok(fence.includes('"image"') && fence.includes('/rp-tools/asset-image?'), '围栏里是这张图的 image 组件');
    assert.equal(actions.submitted, submittedBefore, '**不自动发送** —— 由用户确认');
    // 「设为立绘」：选角色 → POST useAsPortrait → 面板立绘立刻换掉
    const useSel = findAll(view, (n) => n.type === 'select')[0];
    assert.ok(useSel, '详情里要有「设为某角色的立绘」下拉');
    assert.equal(useSel.props.value, '', '默认不预选角色');
    useSel.props.onChange({ target: { value: '阿岚' } });
    const withSel = asPanel();
    const useBtn = findAll(byClass(withSel, 'assetview')[0], (n) => n.type === 'button' && textOf(n) === '设为立绘')[0];
    assert.ok(useBtn, '要有「设为立绘」按钮');
    const writesBefore = assetWrites.length;
    await useBtn.props.onClick();
    await tick(30);
    assert.equal(assetWrites.length, writesBefore + 1, '「设为立绘」要 POST 一次');
    assert.equal(assetWrites.at(-1).action, 'useAsPortrait', '动作要对');
    assert.equal(assetWrites.at(-1).name, '阿岚', '要指名道姓');
    assert.equal(assetWrites.at(-1).id, 's1', '要带资源 id');
    // 「删除」：confirm 后 POST delete；指向它的立绘引用由宿主解除，界面同步抹掉
    const delBtn = findAll(byClass(asPanel(), 'assetview')[0], (n) => n.type === 'button' && textOf(n) === '删除这张图')[0];
    assert.ok(delBtn, '详情里要有「删除这张图」');
    const writesBefore2 = assetWrites.length;
    await delBtn.props.onClick();
    for (let i = 0; i < 12 && assetWrites.length === writesBefore2; i++) await tick(30);
    assert.equal(assetWrites.at(-1).action, 'delete', '删除动作要对');
    assert.equal(assetWrites.at(-1).id, 's1', '删的是当前这张');
    // 没有资源时整张卡片不渲染（空图墙只是噪音）。
    // 按**卡片标题**判定，不按正文包含「资源库」—— 备份卡片里也提到了「资源库图」。
    assetStub = [];
    resetHooks();
    let empty = asPanel();
    for (let i = 0; i < 10; i++) { await tick(30); empty = asPanel(); }
    const assetCards = byClass(empty, 'card').filter((c) => findAll(c, (n) => n.type === 'h4')
      .some((hh) => textOf(hh).startsWith('资源库')));
    assert.equal(assetCards.length, 0, '没有图时不该渲染空的「资源库」卡片');

    assetStub = savedAssets;
    sessionStub.characters = savedChars;
    resetHooks();
  }

  // ★ 备份 / 会话包（P1）：导出是一个下载链接，快照会更新恢复点清单，导入默认先问「要不要覆盖」。
  {
    const tab = await ensureSidebarTab();
    const store = { current: SID, byId: { [SID]: { blank: false, cwd: FAKE_WS, projectionValues: { agentPreset: 'dm' } } } };
    const asPanel = () => render({
      sessionId: SID,
      useSessions: (sel) => sel(store),
      useInput: (sel) => sel({ draft: '' }),
      inputActions,
    }, tab.component);

    const savedSnapStub = snapStub;
    const savedNeeds = importNeedsOverwrite;
    snapStub = { keep: 5, items: [] };
    snapshotPosts.length = 0;
    bundlePosts.length = 0;
    resetHooks();
    let p = asPanel();
    for (let i = 0; i < 12 && !textOf(p).includes('备份 / 会话包'); i++) { await tick(30); p = asPanel(); }
    const card = byClass(p, 'card').find((c) => textOf(c).includes('备份 / 会话包'));
    assert.ok(card, '面板要有「备份 / 会话包」卡片');
    assert.ok(textOf(card).includes('还没有恢复点'), '没有恢复点时要有一句提示');

    // 导出：必须是 `<a download>`（走浏览器自己存盘，不经过 fetch/base64）
    const dl = findAll(card, (n) => n.type === 'a' && n.props.download !== undefined)[0];
    assert.ok(dl, '导出要是一个带 download 的链接');
    assert.ok(String(dl.props.href).startsWith('/rp-tools/export?'), `导出链接指向 /rp-tools/export（实际 ${dl.props.href}）`);
    assert.ok(String(dl.props.href).includes(`sessionId=${SID}`), '导出链接要带 sessionId');
    assert.equal(findAll(p, (n) => n.type === 'a' && String(n.props.href).includes('/rp-tools/export')).length, 1,
      '导出只该有一个入口，别在别处再放一个');

    // 拍快照：POST 一次 → 恢复点清单出现
    const snapBtn = findAll(card, (n) => n.type === 'button' && textOf(n) === '拍快照')[0];
    assert.ok(snapBtn, '要有「拍快照」按钮');
    await snapBtn.props.onClick();
    for (let i = 0; i < 10 && snapshotPosts.length === 0; i++) await tick(30);
    assert.equal(snapshotPosts.length, 1, '「拍快照」要 POST 一次');
    assert.equal(snapshotPosts[0].sessionId, SID, '快照要带 sessionId');
    assert.equal(snapStub.items.length, 1, '宿主侧多了一个恢复点');

    // 恢复点清单的渲染：**重新挂载**后再看（这个测试桩对「跨 render 的异步 setState」不可靠，
    // 文件开头就记着这个限制；所以断言渲染时给一个已经装了快照的桩，别去赌时序）
    snapshotPosts.length = 0;
    resetHooks();
    let withSnaps = asPanel();
    for (let i = 0; i < 12 && !textOf(withSnaps).includes('恢复点 '); i++) { await tick(30); withSnaps = asPanel(); }
    const card2 = byClass(withSnaps, 'card').find((c) => textOf(c).includes('备份 / 会话包'));
    assert.ok(textOf(card2).includes('恢复点 1/5'), `快照后要显示恢复点数量（实际 ${JSON.stringify(textOf(card2)).slice(0, 120)}）`);
    assert.equal(byClass(card2, 'snaprow').length, 1, '恢复点要逐条列出来');
    assert.ok(byClass(card2, 'snaprow').length >= 1, '恢复点要列出来');

    // 从文件导入：zip input + 409 → confirm → 带 overwrite 再来一次
    const zipInput = findAll(card2, (n) => n.type === 'input' && n.props.type === 'file'
      && String(n.props.accept ?? '').includes('zip'))[0];
    assert.ok(zipInput, '要有导入 zip 的 file input');
    zipInput.props.onChange({
      target: { value: 'b.zip', files: [{ name: 'b.zip', __dataUrl: 'data:application/zip;base64,QUJD' }] },
    });
    for (let i = 0; i < 12 && bundlePosts.length < 2; i++) await tick(30);
    assert.equal(bundlePosts.length, 2, '导入被 409 拒绝后要带 overwrite 再试一次');
    assert.equal(bundlePosts[0].overwrite, false, '第一次不能带 overwrite（先问）');
    assert.equal(bundlePosts[1].overwrite, true, '确认后第二次要带 overwrite');
    assert.equal(bundlePosts[0].sessionId, SID, '导入要指定目标会话');
    assert.ok(String(bundlePosts[0].dataUrl).startsWith('data:application/zip'), '传的是 zip 的 data URL');

    // 取消确认 → 不能有任何第二次请求（不能默默覆盖）
    bundlePosts.length = 0;
    const realConfirm = globalThis.window.confirm;
    globalThis.window.confirm = () => false;
    try {
      const snapPanel = asPanel();
      const zip2 = findAll(snapPanel, (n) => n.type === 'input' && n.props.type === 'file'
        && String(n.props.accept ?? '').includes('zip'))[0];
      zip2.props.onChange({
        target: { value: 'b.zip', files: [{ name: 'b.zip', __dataUrl: 'data:application/zip;base64,QUJD' }] },
      });
      for (let i = 0; i < 8; i++) await tick(30);
      assert.equal(bundlePosts.length, 1, '用户取消后不该再发覆盖请求');
      assert.equal(bundlePosts[0].overwrite, false, '取消时也不能带 overwrite');
    } finally { globalThis.window.confirm = realConfirm; }

    snapStub = savedSnapStub;
    importNeedsOverwrite = savedNeeds;
    resetHooks();
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
  assert.ok(listGet.url.includes('workspace=' + encodeURIComponent(FAKE_WS)),
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
  // 设定 / 工具 两小节。**「图像」那一节整块删了** —— 全局图像尺寸与风格库（含 LoRA）
  // 都只服务于本地出图，ComfyUI 链路搬走后它们没有消费者，界面上也不该再出现。
  assert.ok(text.includes('设定') && text.includes('工具'), '设置页要有设定/工具两小节');
  assert.equal(text.includes('图像'), false, '不该再有「图像」小节（图像尺寸/风格库都没了）');
  assert.equal(byClass(tree, 'szrow').length, 0, '不该再有图像尺寸那三行');
  assert.equal(byClass(tree, 'stylerow').length, 0, '不该再有风格库的行');
  assert.equal(text.includes('新增风格'), false, '不该再有「＋ 新增风格」');
  assert.equal(text.includes('LoRA'), false, '不该再提 LoRA（那是出图参数）');
  assert.equal(text.includes('CFG'), false, '不该再提 CFG（那是出图参数）');
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
  // ⚠️ 以前这里还断言「全局图像尺寸一起提交」。图像尺寸与风格库整块删了
  //    （本地生图搬走），所以提交体里**不该**再有 `imageSizes` —— 老客户端还在发它的话
  //    宿主侧也只是忽略，但新客户端不该发。
  assert.equal(Object.hasOwn(post.body, 'imageSizes'), false, '不该再提交 imageSizes（图像尺寸没了）');
  assert.equal(Object.hasOwn(post.body, 'styles'), false, '不该再提交 styles（风格库没了）');

  // 空列表时要说人话：直接给出 `user -> 玩家` 这个例子，而不是留一个空白块让人猜
  stateStub.cards = { root: '', userLabel: '', macros: {} };
  resetHooks();
  let empty = render(Props, reg.component);
  for (let i = 0; i < 14 && !textOf(empty).includes('默认宏列表'); i++) { await tick(30); empty = render(Props, reg.component); }
  assert.ok(textOf(empty).includes('还没有默认宏'), '空列表要给一句人话引导');
  assert.ok(textOf(empty).includes('名字填 user、值填玩家'), '空列表要给出具体例子（user → 玩家）');
  stateStub.cards = { root: '', userLabel: '阿岚', macros: { user: '阿岚', place: '长安' } };
  resetHooks();
}

// ── 关键断言 ⑧：「第三方工具管理」那张表（用户这轮提的全部要点）────────────────
// 要求：① 原名「DM 会话放行」改成「第三方工具管理」；② **去掉固定放行**，全部可勾选；
//      ③ 一行一个工具；④ 有图片标识；⑤ 已勾选的排前面；⑥ rp_* 工具面板隐藏。
{
  const reg = slotRegs.find((r) => r.name === 'settings.section');
  const Props = {};

  /** 渲染设置页直到这张表出现（它挂载后才拉 /rp-tools/global-tools）。 */
  const renderSettings = async () => {
    resetHooks();
    let tree = render(Props, reg.component);
    for (let i = 0; i < 14 && !textOf(tree).includes('第三方工具管理'); i++) { await tick(30); tree = render(Props, reg.component); }
    return tree;
  };

  globalToolsAllowStub = null;   // = 出厂默认全勾
  let tree = await renderSettings();
  let text = textOf(tree);
  assert.ok(text.includes('第三方工具管理'), '应改名为「第三方工具管理」');
  assert.equal(text.includes('DM 会话放行'), false, '旧名「DM 会话放行」不该再出现');
  assert.equal(text.includes('固定放行'), false, '不该再提「固定放行」');

  // rp_* 工具面板已按要求隐藏：清单不再渲染，但配置文件仍要能看到
  assert.equal(text.includes('这些是 DM 能调用的工具'), false, 'rp_* 工具清单面板应隐藏');
  assert.equal(byClass(tree, 'toollist').length, 0, '不该再渲染 rp_* 的 toollist 列表');
  assert.ok(text.includes('配置文件'), '隐藏清单后，配置文件路径仍要能看到');

  // ③ **按插件聚合**：一行 = 一个插件（用户要求：装的是插件，不是散装工具名）。
  //    桩里的 6 个工具全都在映射表里 → 分成 3 组：genui / image-gen / 搜索。
  //    （未映射的工具会落到「其它」组 —— 那条由 smoke-dm 用 my_image_plugin 覆盖。）
  const rowsOf = (t) => findAll(t, (n) => String(n.props?.className ?? '').split(/\s+/).includes('gtrow'));
  let rows = rowsOf(tree);
  assert.equal(rows.length, 3, `一行一个插件（桩里 3 个来源插件，实际 ${rows.length} 行）`);
  // 每行只有一个勾选框（勾它 = 该插件全部工具一起开/关）
  for (const r of rows) {
    assert.equal(findAll(r, (n) => n.type === 'input' && n.props?.type === 'checkbox').length, 1,
      '一个插件一个勾选框（不是每个工具一个）');
  }
  // 行下方要有具体工具名（只读小字），让勾选自解释
  const toolLines = byClass(tree, 'gttools');
  assert.equal(toolLines.length, 3, '每组下面要列出它带的工具名');
  const genuiRow = rows.find((r) => textOf(r).includes('dsh-genui'));
  assert.ok(genuiRow, '应有 dsh-genui 那一组');
  assert.ok(textOf(genuiRow).includes('render_ui') && textOf(genuiRow).includes('validate_dsh_ui'),
    'genui 那组要列出它的两个工具名');
  // ④ 图片标识：宿主点名「这组是生图插件」就给它「图」标。
  //    ⚠ 断言必须看 **badge 元素**：组名里本来就写着「（生图）」，
  //    只看整行文字的话，有没有标识都会通过 —— 那是假绿。
  const badgesOf = (r) => findAll(r, (n) => String(n.props?.className ?? '').split(/\s+/).includes('badge'))
    .map((n) => textOf(n));
  assert.ok(badgesOf(rows.find((r) => textOf(r).includes('dsh-image-gen'))).includes('图'),
    '生图那组要打「图」标（映射表点名，不靠逐名判断 —— view_canvas 名字里没有 image）');
  assert.equal(badgesOf(genuiRow).includes('图'), false, 'genui 组不该被标成图片类（避免误导）');
  // ② 没有锁定项：不该有 disabled 的勾选框
  const boxes = findAll(tree, (n) => n.type === 'input' && n.props?.type === 'checkbox');
  assert.equal(boxes.some((b) => b.props.disabled === true), false, '不该有不可取消的勾选框（固定放行已取消）');

  // ⑤ 勾选状态与排序（按**本地草稿**算，不是读宿主那份）：
  //    默认名单 5 个工具，桩里本机有 6 个 —— 生图组多一个 view_canvas，
  //    所以「默认」并不等于「每行都满勾」：满勾的组勾上，缺一个的组半勾（indeterminate），
  //    计数如实写 2/3。这是真机的情形（宿主注册的工具比默认放行的多），不能只测全勾那条。
  const boxOf = (r) => findAll(r, (n) => n.type === 'input' && n.props?.type === 'checkbox')[0];
  /** 半勾只是 DOM 属性（React 的 indeterminate 得直接写节点）——调它那个函数式 ref 才看得到。 */
  const indetOf = (r) => { const el = {}; boxOf(r)?.props?.ref?.(el); return el.indeterminate; };
  const rowOf = (t, key) => rowsOf(t).find((r) => textOf(r).includes(key));
  assert.equal(boxOf(rowOf(tree, 'dsh-genui'))?.props.checked, true, 'genui 组默认 2/2，勾选框是勾上的');
  assert.equal(boxOf(rowOf(tree, '联网搜索'))?.props.checked, true, '搜索组默认全勾');
  const imgRow0 = rowOf(tree, 'dsh-image-gen');
  assert.equal(textOf(imgRow0).includes('2/3'), true, '生图组默认 2/3（宿主还注册了 view_canvas，默认不放行）');
  assert.equal(boxOf(imgRow0)?.props.checked, false, '只勾了 2/3 的组，勾选框不该显示满勾');
  assert.equal(indetOf(imgRow0), true, '部分勾选的组要显示半勾（indeterminate）');
  assert.equal(indetOf(rowOf(tree, 'dsh-genui')), false, '全勾 / 全不勾的组不该是半勾');

  // 点一个插件的勾选框 = 该插件全部工具一起开/关（这是「只勾插件」的核心）
  globalToolsAllowStub = ['render_ui', 'validate_dsh_ui', 'web_search', 'generate_image', 'edit_image'];
  tree = await renderSettings();
  rows = rowsOf(tree);
  const imgRow = rows.find((r) => textOf(r).includes('dsh-image-gen'));
  boxOf(imgRow).props.onChange({ target: { checked: false } });      // 关掉整个生图插件
  tree = render(tree, reg.component);                               // 用本地草稿重渲染
  const imgRowAfter = rowsOf(tree).find((r) => textOf(r).includes('dsh-image-gen'));
  assert.ok(imgRowAfter, '关掉某插件后那一组仍要在表里（不能消失）');
  assert.equal(textOf(imgRowAfter).includes('0/3'), true, '关掉后该组计数应变成 0/3');
  assert.equal(boxOf(imgRowAfter)?.props.checked, false, '关掉后该插件的勾选框应取消');
  assert.equal(indetOf(imgRowAfter), false, '一个都没勾不是半勾');
  // 该组因此判定为「未勾」→ 应沉到列表后面（已勾的在前）
  const rowsAfter = rowsOf(tree);
  assert.ok(rowsAfter.findIndex((r) => textOf(r).includes('dsh-image-gen'))
    > rowsAfter.findIndex((r) => textOf(r).includes('dsh-genui')),
  '取消的插件要排到仍勾选的那些后面');
  // 再打开回来 = 该插件**全部**工具一起放行（含默认没勾的 view_canvas —— 用户勾的是插件，不是散装工具名）
  boxOf(rowsOf(tree).find((r) => textOf(r).includes('dsh-image-gen'))).props.onChange({ target: { checked: true } });
  tree = render(tree, reg.component);
  assert.ok(textOf(rowsOf(tree).find((r) => textOf(r).includes('dsh-image-gen'))).includes('3/3'),
    '再勾上应是 3/3（整组一起放行）');

  // 手填「未注册」的名字要显示成一组（否则用户配完没反馈，只会困惑为什么没生效）
  globalToolsAllowStub = ['render_ui', 'ghost_tool'];
  tree = await renderSettings();
  rows = rowsOf(tree);
  const ghost = rows.find((r) => textOf(r).includes('ghost_tool'));
  assert.ok(ghost, '配置里有、本机没注册的名字也要显示成一组');
  assert.ok(textOf(ghost).includes('未注册'), '未注册的那组要标「未注册」');

  // 一个都不勾时的后果要明说（不是阻止，是提醒）
  globalToolsAllowStub = [];
  tree = await renderSettings();
  assert.ok(textOf(tree).includes('一个都没勾'), '全不勾时要给出明确后果提示');

  globalToolsAllowStub = null;
  resetHooks();
}
console.log('客户端冒烟测试通过：');
console.log(`  · bundle id = ${captured.id}`);
console.log(`  · apply 后样式表已注入（${style.textContent.length} 字符，含 .rph-btn / .rpc）`);
console.log(`  · 重复 apply 幂等`);
console.log(`  · 已注册槽位：${[...new Set(registered)].join(', ')}`);
console.log(`  · 故事书导入槽位：id=${dockReg.id} order=${dockReg.order}`);
console.log(`  · 无头渲染全流程通过：portal 进工作区那一行 / 只在未开局的 DM 新会话出现 / 列表 / 预览 / 导入 / 结果留存（共 ${calls.length} 次请求）`);
// 与 smoke-dm 一致的收尾摘要（失败到不了这里 —— assert 失败会直接抛）
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
