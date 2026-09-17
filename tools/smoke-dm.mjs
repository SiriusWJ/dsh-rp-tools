// RP 插件宿主半侧冒烟测试：伪造 ctx，跑通 apply + registerRpTools + dm 判定路径。
// 约定：ctx.inject(names, fn) 会把「注入后的 ctx」作为参数回调（installRoutes 就是这么用的）。
//
// ⚠️ 用法（见文件末尾）：DSH_HOME 被指向临时目录，所以**绝不碰真实数据目录**。
//    早期版本直接写 ~/.dsh/data/dsh-rp-tools/，测试记录会混进真实会话登记表，
//    清理时极易误删真实会话 —— 别再改回去。
import crypto from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, renameSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

const TEST_HOME = mkdtempSync(join(tmpdir(), 'dsh-rp-smoke-'));
process.env.DSH_HOME = TEST_HOME;

/** 本文件所在目录（tools/），用来 import png-fixture.mjs。 */
const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

// 插件依赖 @deepseek-ai/dsh-tools 等，只有 profile 的 node_modules 里有 ——
// 从那里解析（与 dm/rp-bridge.mjs 同一个办法），所以本文件可以在仓库里直接跑。
const PROFILE_PACKAGE = process.env.DSH_RP_PROFILE_PACKAGE
  || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'profiles', 'web', 'package.json');
let entry;
try {
  entry = createRequire(PROFILE_PACKAGE).resolve('dsh-rp-tools');
} catch (error) {
  console.error(`解析 dsh-rp-tools 失败（profile=${PROFILE_PACKAGE}）：${error?.message ?? error}`);
  console.error('先同步源码到 profile，或用 DSH_RP_PROFILE_PACKAGE 指定 profile 的 package.json。');
  rmSync(TEST_HOME, { recursive: true, force: true });
  process.exit(2);
}
console.log(`被测模块: ${entry}\n`);
const mod = await import(pathToFileURL(entry).href);

const routes = new Map();
const tools = new Map();
// Cordis 允许同一事件挂多个监听器 —— 桩必须存数组，
// 否则后注册的监听器会把先注册的覆盖掉（这个桩缺陷一度让 fork 继承的用例全假失败）。
const events = new Map();
// Cordis 允许同一事件挂多个监听器 —— 桩必须存数组，
// 否则后注册的监听器会把先注册的覆盖掉（这个桩缺陷一度让 fork 继承的用例全假失败）。
let assembleOnCalls = 0;
const on = (evt, fn) => {
  if (evt === 'system-prompt/assemble') assembleOnCalls++;
  if (!events.has(evt)) events.set(evt, []);
  events.get(evt).push(fn);
  // 与真实 Cordis 一致：返回一个 disposer
  return () => {
    const list = events.get(evt) ?? [];
    const at = list.indexOf(fn);
    if (at >= 0) list.splice(at, 1);
  };
};
const emit = (evt, ...args) => {
  for (const fn of events.get(evt) ?? []) fn(...args);
};

// 这个会话 id 会被 agentCtx.agent.id 引用（注入按作用域自带的身份定位本会话）
const SMOKE_AGENT_SESSION = crypto.randomUUID();

// systemPrompt 桩：记录注册的段 / context / 变量，并让我们能手动触发一次装配，验证注入真的落进 assembly
const promptSections = new Map();
const promptContexts = new Map();
const promptVars = new Map();
const systemPromptStub = {
  section: (s) => { promptSections.set(s.name, s); return () => {}; },
  context: (c) => { promptContexts.set(c.name, c); return () => {}; },
  variable: (name, provider) => { promptVars.set(name, provider); return () => {}; },
};
/**
 * 真机装配上下文的形状（`assembleContextFor(agent, signal)`，见 dsh-agent）：
 * `{ agent, scope: agent }`，而 `agent.id` 就等于 `agent.session.id`。
 * 会话 id 只能从这里取 —— 插件作用域 ctx 上没有 `agent`。
 */
const fakeAgent = (sessionId) => ({ id: `session-${sessionId}`, session: { id: sessionId } });
const assembleCtx = (sessionId) => {
  const agent = fakeAgent(sessionId);
  return { agent, scope: agent, signal: undefined };
};
/**
 * 造一份「宿主已经收集好 variables」的 assembly。
 *
 * 真机 `assemble()` 的顺序是：**先**收集 variables（逐个调 provider），**再**跑 waterfall。
 * 桩必须照这个顺序，否则「这一轮刚注册的宏不在 variables 快照里 → 必须中和」这条
 * 关键安全性就测不出来。
 */
const mkAssembly = (sections, sessionId) => {
  const context = assembleCtx(sessionId);
  const variables = {};
  for (const [name, provider] of promptVars) variables[name] = provider(context);
  return {
    sections: sections ?? [...promptSections.values()].map((s) => ({ name: s.name, text: s.text })),
    contexts: [...promptContexts.values()].map((c) => ({ name: c.name, text: c.text })),
    tools: [],
    variables,
    context,
  };
};
/**
 * 水位的 `next` 是**无参**的，返回上一段处理后的 assembly（宿主实现是
 * `() => Promise.resolve(assembly)`）。桩写成 `async (a) => a` 会让 `next()` 得到
 * `undefined`，于是「注入有没有生效」这类断言会因为 result 变成 undefined 而假通过/假失败 ——
 * 别改成带参形式。
 */
const nextOf = (asm) => async () => asm;

// 全局作用域：故意**不给** systemPrompt stub —— 用来证明全局 apply() 不做提示词注入。
// （这是架构约束的回归测试：注入只允许发生在 dm 预设的 agent 作用域。）
// 同时记录全局注册了哪些工具：**必须是零个**。
const globalTools = [];
// 宿主会话注册表桩（`ctx.get('sessions')`）：模拟「这个会话在本进程里活着」的情况。
// 插件的 liveSessionCwd 会来这里按 id 查 `session.header.cwd` —— 真机上这是补住
// 「重启后内存 Map 里没有该会话」空档的一级兜底。
const liveSessions = new Map();
// 会话投影桩（`ctx.get('sessionProjections').stateOf(session, key)`）：闸门会用它拿
// 「当前预设」与「有没有开局」；真机上这是宿主自己算的那份权威状态。
const fakeProjections = { stateOf: (session, key) => (session?.proj ?? {})[key] };
// 全局工具注册表桩：`GET /rp-tools/global-tools` 靠 `tools.schemas()`（**省略 scope = 全局视图**）
// 列出「本机真实存在哪些全局工具」供设置页勾选。这里放几个真机上会有的名字，
// 其中 `my_image_plugin` 代表「用户装了别的生图插件」。
const fakeGlobalToolNames = ['render_ui', 'validate_dsh_ui', 'web_search', 'generate_image', 'edit_image', 'web_fetch', 'canvas_state', 'my_image_plugin'];
const hostToolsService = {
  schemas: () => fakeGlobalToolNames.map((name) => ({ name })),
  register: (t) => { tools.set(t.name, t); globalTools.push(t.name); },
};
const hostCtx = {
  tools: hostToolsService,
  on,
  effect: (fn) => { fn(); },
  webServer: { register: (r) => { routes.set(r.path, r); } },
  inject: (names, fn) => { fn(hostCtx); },
  get: (name) => {
    if (name === 'sessions') return { get: (id) => liveSessions.get(id) };
    if (name === 'sessionProjections') return fakeProjections;
    return undefined;
  },
};
mod.apply(hostCtx);

// agent 作用域：就是 dm 预设的 rp-bridge 调用 registerRpTools 的那个上下文。
// ⚠️ 这里**故意不放 `agent`** —— 真实宿主的作用域 ctx 上就没有这个属性，
//    当初正是测试桩凭空给了 `ctx.agent`，才让「注入永远读 default 会话」这个重大缺陷
//    在 400 多条断言全绿的情况下溜进了生产（会话日志 + 探针文件才抓到）。
const agentCtx = {
  tools: { register: (t) => { tools.set(t.name, t); } },
  on,
  effect: (fn) => { fn(); },
  webServer: { register: (r) => { routes.set(r.path, r); } },
  inject: (names, fn) => { fn(agentCtx); },
  get: (name) => (name === 'systemPrompt' ? systemPromptStub : undefined),
};
mod.registerRpTools(agentCtx);

console.log('注册的工具:', [...tools.keys()].join(', '));
console.log('注册的路由:', [...routes.keys()].sort().join(', '));
console.log('监听的事件:', [...events.entries()].map(([k, list]) => k + '(' + list.length + ')').join(', '), '\n');

function mkRes() {
  const out = { status: 0, body: '' };
  return {
    out,
    writeHead: (s) => { out.status = s; },
    setHeader: () => {},
    end: (b) => {
      // 图片路由发的是二进制：utf8 转字符串会毁掉字节，所以额外留一份原始 Buffer
      if (Buffer.isBuffer(b)) { out.raw = b; out.body = b.toString('utf8'); }
      else { out.raw = Buffer.from(b ?? '', 'utf8'); out.body = typeof b === 'string' ? b : String(b ?? ''); }
    },
    on: () => {},
  };
}
async function callGet(path, query = '') {
  const route = routes.get(path);
  const res = mkRes();
  await route.handler({ method: 'GET', url: `${path}${query}`, headers: {} }, res);
  return { status: res.out.status, json: JSON.parse(res.out.body || '{}') };
}
async function callPost(path, body, origin = 'http://127.0.0.1:3080', host = '127.0.0.1:3080') {
  const route = routes.get(path);
  const res = mkRes();
  // readJsonBody 用 `for await (const chunk of request)` —— 必须给真正的 Readable 流。
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = 'POST';
  req.url = path;
  // sameOrigin 比对 new URL(origin).host 与 headers.host —— 两个都要给。
  req.headers = { origin, host, 'content-type': 'application/json' };
  await route.handler(req, res);
  return { status: res.out.status, json: JSON.parse(res.out.body || '{}') };
}
/** 取二进制响应（图片路由用；mkRes 已经按 buffer 存了原始字节）。 */
async function callGetRaw(pathAndQuery) {
  const [path, query = ''] = String(pathAndQuery).split(/\?(?=[^]*$)/);
  const route = routes.get(path);
  const res = mkRes();
  await route.handler({ method: 'GET', url: `${path}${query ? `?${query}` : ''}`, headers: {} }, res);
  return { status: res.out.status, bytes: Buffer.isBuffer(res.out.raw) ? res.out.raw : Buffer.from(res.out.body, 'utf8') };
}

// 全部用随机 id：数据目录是本次运行的临时目录，没有任何历史记录会干扰断言。
const DM = crypto.randomUUID();
const TEST = crypto.randomUUID();
const VIA_TOOL = crypto.randomUUID();
const VIA_PRESET = crypto.randomUUID();
const NOT_DM = crypto.randomUUID();

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  got=${JSON.stringify(got)}${ok ? '' : `  want=${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

// 先经由 dm-mark 登记一个会话，后面所有「已登记」断言都基于它
check('POST dm-mark 同源登记', (await callPost('/rp-tools/dm-mark', { sessionId: DM, preset: 'dm' })).json.ok, true);

check('GET session(已登记 dm).isDm', (await callGet('/rp-tools/session', `?sessionId=${DM}`)).json.isDm, true);
check('GET session(session- 前缀).isDm', (await callGet('/rp-tools/session', `?sessionId=session-${DM}`)).json.isDm, true);
check('GET session(未登记).isDm', (await callGet('/rp-tools/session', `?sessionId=${TEST}`)).json.isDm, false);
// 真实的跨站攻击形态：浏览器会强制把 Host 设成被攻击站点，只有 Origin 指向攻击者。
check('POST dm-mark 跨域被拒', (await callPost('/rp-tools/dm-mark', { sessionId: TEST }, 'http://evil.example', '127.0.0.1:3080')).status, 403);
check('POST dm-mark 同源登记（第二个会话）', (await callPost('/rp-tools/dm-mark', { sessionId: TEST, preset: 'dm' })).json.ok, true);
check('登记后 isDm', (await callGet('/rp-tools/session', `?sessionId=${TEST}`)).json.isDm, true);
check('重复登记幂等', (await callPost('/rp-tools/dm-mark', { sessionId: TEST, preset: 'dm' })).json.ok, true);
check('登记后 GET 回读 preset', (await callGet('/rp-tools/session', `?sessionId=${TEST}`)).json.preset, 'dm');

// 工具调用保底登记：调用 rp_* 时把会话登记为 dm
const rpTable = tools.get('rp_table');
if (rpTable) {
  await rpTable.execute({ action: 'set', name: '冒烟表', entries: ['甲', '乙'] }, { agent: { id: `session-${VIA_TOOL}` } });
  check('工具调用保底登记', (await callGet('/rp-tools/session', `?sessionId=${VIA_TOOL}`)).json.isDm, true);
} else { console.log('WARN: rp_table 未注册'); fail++; }

// ── 并发：写会话/配置的工具不能声明并发安全（read-modify-write 会互相覆盖）────────
// 宿主 `executionMode()` 只认 `isConcurrencySafe(args) === true`，其余一律 exclusive。
// **本插件已经没有出图工具**：出图交给宿主的 `generate_image`，所以这里只剩「该串行的必须串行」
// 这一半；「已删工具不存在」由文件末尾的「工具面」一段统一钉住。
{
  const safe = (n, args) => {
    const t = tools.get(n);
    if (!t || typeof t.isConcurrencySafe !== 'function') return false;
    try { return t.isConcurrencySafe(args) === true; } catch { return false; }
  };
  check('并发：写会话的工具不声明（fail-closed）', safe('rp_session', { action: 'get' }), false);
  check('并发：写角色的工具不声明', safe('rp_character', { action: 'list' }), false);
  check('并发：写配置的工具不声明', safe('rp_config', { action: 'get' }), false);
}

// ── 外部导入立绘（用户要求「也支持用户用外部导入立绘」）────────────────────
// 生图很慢且靠抽卡：用户手里有现成的图时应该能直接用。浏览器读成 data URL（拿不到本地路径），
// 宿主落进会话目录，再经同源路由取回。
{
  const D = mod.__debug;
  const { imagePng } = await import(pathToFileURL(join(here, 'png-fixture.mjs')).href);
  const sid = crypto.randomUUID();
  const ws4 = join(TEST_HOME, 'ws-portrait-import');
  mkdirSync(ws4, { recursive: true });
  D.setSessionCwd(sid, ws4);
  const png = imagePng(6, 6, (x, y) => [x * 40, y * 40, 90, 255]);
  const dataUrl = `data:image/png;base64,${png.toString('base64')}`;

  // 文件名由宿主生成（`newAssetId`），**用户给的名字永不进路径** —— 早期那个 slug 函数
  // 已经删掉（留着会让人误以为路径里还有用户输入）。用一个带路径分隔符的角色名钉住新约定。
  {
    const sidEvil = crypto.randomUUID();
    const wsEvil = join(TEST_HOME, 'ws-portrait-evil');
    mkdirSync(wsEvil, { recursive: true });
    D.setSessionCwd(sidEvil, wsEvil);
    const evil = await callPost('/rp-tools/portrait-upload', { sessionId: sidEvil, name: '../../evil/名', dataUrl });
    check('导入立绘：恶意角色名不会进路径',
      /^assets\/portraits\/[0-9a-f]{10}\.png$/.test(String(evil.json.file)), true);
    check('导入立绘：恶意名字只当索引字段（读得回来）',
      D.loadSession(sidEvil).portraits?.['../../evil/名']?.imported?.file, evil.json.file);
    check('导入立绘：没在磁盘上按那个名字造出目录', existsSync(join(wsEvil, 'evil')), false);
  }

  check('导入立绘：只收 png/jpeg/webp',
    (await callPost('/rp-tools/portrait-upload', { sessionId: sid, name: '祁俊', dataUrl: 'data:image/gif;base64,R0lGODlh' })).status, 400);
  check('导入立绘：不是 data URL 就拒',
    (await callPost('/rp-tools/portrait-upload', { sessionId: sid, name: '祁俊', dataUrl: 'https://example.com/a.png' })).status, 400);
  check('导入立绘：缺角色名被拒',
    (await callPost('/rp-tools/portrait-upload', { sessionId: sid, dataUrl })).status, 400);
  check('导入立绘：缺 sessionId 被拒',
    (await callPost('/rp-tools/portrait-upload', { name: '祁俊', dataUrl })).status, 400);
  check('导入立绘：跨源被拒',
    (await callPost('/rp-tools/portrait-upload', { sessionId: sid, name: '祁俊', dataUrl }, 'http://evil.example', '127.0.0.1:3080')).status, 403);

  const up = await callPost('/rp-tools/portrait-upload', { sessionId: sid, name: '祁俊', dataUrl });
  check('导入立绘：写入成功', up.status, 200);
  // 1.13.0 起导入走**资源库**：文件名是宿主生成的 id，放在 assets/<分类>/ 下（用户要求分文件夹）。
  // 「重导同名立绘」再也不会撞缓存，所以 1.12.10 那套 `v=` 补丁不需要了。
  check('导入立绘：落进 assets/portraits/、文件名是宿主生成的 id',
    up.json.file, `assets/portraits/${up.json.asset?.id}.png`);
  check('导入立绘：返回资源库地址（按 id 取）',
    String(up.json.url).startsWith('/rp-tools/asset-image?') && String(up.json.url).includes(`id=${up.json.asset?.id}`), true);
  const sessionDir = join(ws4, 'rp-sessions', sid);
  const onDisk = join(sessionDir, up.json.file);
  check('导入立绘：文件真的落盘了', existsSync(onDisk), true);
  check('导入立绘：字节与原图一致', readFileSync(onDisk).equals(png), true);
  check('导入立绘：会话配置里记的是相对路径（可整体搬走）',
    D.loadSession(sid).portraits?.祁俊?.imported?.file, up.json.file);
  check('导入立绘：没有顺手编一张 generated（两件事分开）',
    D.loadSession(sid).portraits?.祁俊?.generated, undefined);

  // 取回：只有会话配置里记下的那张才发
  const got = await callGetRaw(`/rp-tools/portrait-image?sessionId=${sid}&name=${encodeURIComponent('祁俊')}`);
  check('导入立绘：取回 200', got.status, 200);
  check('导入立绘：取回的字节一致', got.bytes.equals(png), true);
  check('导入立绘：没登记过的角色 404',
    (await callGetRaw(`/rp-tools/portrait-image?sessionId=${sid}&name=${encodeURIComponent('查无此人')}`)).status, 404);
  check('导入立绘：缺参数 400', (await callGetRaw('/rp-tools/portrait-image')).status, 400);
  check('导入立绘：只认 GET',
    (await callPost('/rp-tools/portrait-image', { sessionId: sid, name: '祁俊' })).status, 405);

  // **路径穿越**：把配置里的相对路径改成往外跳，路由必须挡住（前缀校验）
  // 这一条就是「只认会话配置里记的那张」之外的**第二道锁**：配置本身被改坏时也不能读到外面。
  {
    const sess = D.loadSession(sid);
    sess.portraits.祁俊.imported.file = 'portraits/../../outside.png';
    D.saveSession(sess);
    const esc = await callGet('/rp-tools/portrait-image', `?sessionId=${sid}&name=${encodeURIComponent('祁俊')}`);
    check('导入立绘：配置被改成越界路径后拒绝', esc.status, 400);
    check('导入立绘：拒绝理由是路径越界', esc.json.error, '路径越界');
  }

  // `POST /rp-tools/portrait` 现在**只剩 clear**：本插件不再出图，「生成并登记立绘」那条路
  // 整个删掉了。缺 action 不能默认成 clear（那会把用户的立绘悄悄清掉），
  // 带 file/subfolder/type/style/elapsedMs 这些「出图产物」字段的请求也必须明确拒绝 ——
  // 否则老客户端（还在 POST 三要素）会以为登记成功了，实际什么也没发生。
  {
    const sidClear = crypto.randomUUID();
    const wsClear = join(TEST_HOME, 'ws-portrait-clear');
    mkdirSync(wsClear, { recursive: true });
    D.setSessionCwd(sidClear, wsClear);
    await callPost('/rp-tools/portrait-upload', { sessionId: sidClear, name: '祁俊', dataUrl });
    check('立绘路由：clear 前有立绘', Boolean(D.loadSession(sidClear).portraits?.祁俊?.imported?.file), true);
    check('立绘路由：缺 action 被拒（不许默认成 clear）',
      (await callPost('/rp-tools/portrait', { sessionId: sidClear, name: '祁俊' })).status, 400);
    check('立绘路由：缺 action 时立绘还在（拒绝是有效的，不是先清后拒）',
      Boolean(D.loadSession(sidClear).portraits?.祁俊?.imported?.file), true);
    check('立绘路由：带出图产物（file）被拒',
      (await callPost('/rp-tools/portrait', { sessionId: sidClear, name: '祁俊', action: 'save', file: 'x.png' })).status, 400);
    check('立绘路由：显式 save 被拒',
      (await callPost('/rp-tools/portrait', { sessionId: sidClear, name: '祁俊', action: 'save' })).status, 400);
    check('立绘路由：显式 clear 成功',
      (await callPost('/rp-tools/portrait', { sessionId: sidClear, name: '祁俊', action: 'clear' })).status, 200);
    // clear 清的是**老版本的 generated 死引用**；用户导入的立绘（imported）是另一份东西，
    // 清除不许动它（否则「清理死引用」会顺手删掉用户真实的图）。
    check('立绘路由：clear 只抹 generated，保留导入的立绘',
      Boolean(D.loadSession(sidClear).portraits?.祁俊?.imported?.file), true);
    check('立绘路由：clear 后没有 generated', D.loadSession(sidClear).portraits?.祁俊?.generated, undefined);
  }

  // 常驻段：导入的立绘要出现在「已有可用图」里（DM 才不会又出一张）
  {
    const sid2 = crypto.randomUUID();
    const ws5 = join(TEST_HOME, 'ws-portrait-import-standing');
    mkdirSync(ws5, { recursive: true });
    D.setSessionCwd(sid2, ws5);
    await callPost('/rp-tools/portrait-upload', { sessionId: sid2, name: '祝婉宁', dataUrl });
    const standing = D.buildStandingText({
      ...D.loadSession(sid2), sessionId: sid2, characters: [{ name: '祝婉宁' }],
    }, {});
    check('导入立绘：常驻段里给了可复用地址', standing.includes('/rp-tools/portrait-image?'), true);
    check('导入立绘：常驻段标注了「导入的立绘」', standing.includes('（导入的立绘）'), true);
    // 「已有可用图」那行的口径：**先在下面找，有就直接展示**（旧措辞是「不要再生成」，
    // 1.14.0 改成「不要再重新生成」—— 因为出图本身已经归宿主的 generate_image 了）
    check('导入立绘：常驻段仍写明「有就直接展示」', standing.includes('有就直接展示'), true);
  }
}

// ── 资源库（1.13.0）────────────────────────────────────────────────────────
// 以前**只有立绘**留档：场景图/群像图/道具图/整幕多格出完就只在当轮消息里，宿主侧没有索引 ——
// 想让「雨夜客栈」再出现一次只能重新抽卡。现在：真存一份字节 + 按分类分文件夹 + 可检索。
{
  const D = mod.__debug;
  const { imagePng } = await import(pathToFileURL(join(here, 'png-fixture.mjs')).href);
  const sid = crypto.randomUUID();
  const ws = join(TEST_HOME, 'ws-assets');
  mkdirSync(ws, { recursive: true });
  D.setSessionCwd(sid, ws);
  const sessionDir = join(ws, 'rp-sessions', sid);
  // 用 128×128 的真图：缩略图那几条要能真的降到更小。注意 `width` 有 **48 的下限**
  // （和卡面缩略图同一套参数），所以请求 16 会被夹到 48 —— 想断言「变小」得让原图足够大。
  const png = imagePng(128, 128, (x, y) => [x * 2, y * 2, 120, 255]);

  // 分类 → 目录名：用户要求「按场景、角色、道具等分内部文件夹」
  check('资源库：有四个分类', D.ASSET_KINDS.join(','), 'portrait,scene,item,other');
  check('资源库：分类各自一个子目录',
    ['portrait', 'scene', 'item', 'other'].map((k) => D.ASSET_KIND_DIR[k]).join(','),
    'portraits,scenes,items,other');
  check('资源库：路径按分类分目录', D.assetRelPath('scene', 'abc123', 'png'), 'assets/scenes/abc123.png');
  check('资源库：非法分类落到 other', D.assetRelPath('乱写', 'abc123', 'png'), 'assets/other/abc123.png');
  check('资源库：未知分类归一成 other', D.assetKindOf('???'), 'other');
  // 标签解析：模型更常给「逗号分隔的字符串」而不是数组，两种都要收
  check('资源库：标签能吃数组', D.parseAssetTags(['客栈', '雨夜']).join(','), '客栈,雨夜');
  check('资源库：标签也能吃逗号/顿号/空格分隔的字符串',
    D.parseAssetTags('客栈, 雨夜、室内 黄昏').join(','), '客栈,雨夜,室内,黄昏');
  check('资源库：标签去重', D.parseAssetTags('a,a,b').join(','), 'a,b');

  // 归档：写盘 + 追加索引
  const one = await D.archiveAsset(sid, {
    bytes: png, kind: 'scene', ext: 'png', width: 768, height: 432,
    label: '雨夜客栈大堂', tags: '客栈,雨夜', characters: ['祁俊'], style: 'manga', styleLabel: '黑白漫画',
    source: 'generated', group: 'g1', prompt: '雨夜里的客栈大堂',
  });
  check('资源库：归档返回一条记录', Boolean(one?.id), true);
  check('资源库：文件落在 scenes/ 下', one.file, `assets/scenes/${one.id}.png`);
  check('资源库：字节真的写进磁盘了', readFileSync(join(sessionDir, one.file)).equals(png), true);
  check('资源库：索引读得回来', D.loadAssets(sid).assets.length, 1);
  check('资源库：标签存下来了', (one.tags ?? []).join(','), '客栈,雨夜');
  check('资源库：分类计数', JSON.stringify(D.assetCounts(D.loadAssets(sid))),
    JSON.stringify({ portrait: 0, scene: 1, item: 0, other: 0 }));

  // 再放两张（不同分类），测过滤。
  // ⚠️ **必须是各不相同的字节**：1.13.2 起查重是**内容优先**的（同一份字节就是同一张图，
  // 与调用方这次报的 kind 无关）。喂同一张图会被合并成 1 条，那样下面「按分类能筛出 3 类」
  // 就不再检验过滤，而会变成一条假绿。同字节跨分类合并另有一段专门的用例。
  const pngPortrait = imagePng(96, 96, (x, y) => [200, x, y, 255]);
  const pngItem = imagePng(64, 64, (x, y) => [x, 255, y, 255]);
  const two = await D.archiveAsset(sid, { bytes: pngPortrait, kind: 'portrait', ext: 'png', label: '祁俊立绘', characters: ['祁俊'], tags: '立绘' });
  const three = await D.archiveAsset(sid, { bytes: pngItem, kind: 'item', ext: 'png', label: '青铜钥匙', tags: '道具,钥匙' });
  check('资源库：三次归档都在', D.loadAssets(sid).assets.length, 3);
  check('资源库：id 不重复', new Set([one.id, two.id, three.id]).size, 3);

  check('资源库：按分类筛', D.queryAssets(sid, { kind: 'portrait' }).total, 1);
  check('资源库：按角色筛', D.queryAssets(sid, { characters: ['祁俊'] }).total, 2);
  check('资源库：按标签筛（要全部命中）', D.queryAssets(sid, { tags: '客栈,雨夜' }).total, 1);
  check('资源库：按关键词搜名字', D.queryAssets(sid, { q: '钥匙' }).total, 1);
  check('资源库：关键词也搜标签', D.queryAssets(sid, { q: '客栈' }).total, 1);
  check('资源库：搜不到就是 0', D.queryAssets(sid, { q: '不存在的东西' }).total, 0);
  check('资源库：新图排在前面（最近出的更可能想复用）',
    D.queryAssets(sid, { limit: 1 }).assets[0].id, three.id);
  check('资源库：limit 生效', D.queryAssets(sid, { limit: 2 }).assets.length, 2);
  check('资源库：分类计数跟着变', JSON.stringify(D.queryAssets(sid, {}).counts),
    JSON.stringify({ portrait: 1, scene: 1, item: 1, other: 0 }));

  // **并发写**：出图是并发的（宿主并行池最多 10 个在飞），索引 read-modify-write 会丢记录 ——
  // 「出了 20 张，库里只有 2 张」这种丢法不报错，只能靠这条断言钉住那把写队列。
  {
    const sid2 = crypto.randomUUID();
    const ws2 = join(TEST_HOME, 'ws-assets-concurrent');
    mkdirSync(ws2, { recursive: true });
    D.setSessionCwd(sid2, ws2);
    // ⚠️ 必须用**各不相同的字节**：1.13.2 加了内容去重之后，喂同一张图会被合并成 1 条，
    // 那样这条用例就不再检验「写队列丢不丢记录」了（会假绿）。同字节的并发去重另有用例。
    await Promise.all(Array.from({ length: 20 }, (_, i) => D.archiveAsset(sid2, {
      bytes: Buffer.from(`PNG-${i}-`.repeat(40)), kind: 'scene', ext: 'png', label: `并发 ${i}`,
    })));
    check('资源库：20 个并发归档一条都不丢', D.loadAssets(sid2).assets.length, 20);
    check('资源库：20 条 id 互不相同', new Set(D.loadAssets(sid2).assets.map((a) => a.id)).size, 20);
  }

  // 归档的**字段契约**：一条资源记录要带上调用方当时知道的全部上下文
  // （风格标签、尺寸、提示词原文、来源、分组），否则事后没法按内容补救标签。
  // 旧版这里是打桩 `globalThis.fetch` 走 ComfyUI `/view` 抓字节那条路 —— 生图整块搬走后
  // 那条路连同 `archiveGeneratedImages` 一起删了，现在入库只剩一个入口：宿主出的图
  // 由 DM 用 `rp_assets(action:"import")` 收进来（见下面「导入」那段）。
  {
    const sid4 = crypto.randomUUID();
    const ws4b = join(TEST_HOME, 'ws-assets-archive');
    mkdirSync(ws4b, { recursive: true });
    D.setSessionCwd(sid4, ws4b);
    const made = await D.archiveAsset(sid4, {
      bytes: png, kind: 'scene', ext: 'png', width: 768, height: 432,
      label: '雨夜客栈前台', tags: '客栈,雨夜', characters: ['祁俊'],
      style: 'manga', styleLabel: '黑白漫画', source: 'generated', group: 'g9',
      prompt: '雨夜里的客栈前台',
    });
    check('资源库：入库一张', Boolean(made?.id), true);
    check('资源库：入库的分类来自调用方', made?.kind, 'scene');
    check('资源库：入库带上风格与尺寸', `${made?.styleLabel}|${made?.width}×${made?.height}`, '黑白漫画|768×432');
    check('资源库：入库带上提示词原文（事后能补救标签）', made?.prompt, '雨夜里的客栈前台');
    check('资源库：入库落在 scenes/ 下', String(made?.file).startsWith('assets/scenes/'), true);
    check('资源库：入库的 source 是 generated', made?.source, 'generated');
    check('资源库：入库带上 group（整幕多格归一组）', made?.group, 'g9');
    // 字节非法（空 / 非 Buffer）→ 返回 null 而不是抛：一次归档失败不该炸掉调用方
    check('资源库：空字节不建档、也不抛', await D.archiveAsset(sid4, { bytes: Buffer.alloc(0), kind: 'scene' }), null);
    check('资源库：空字节时库里条数不变', D.loadAssets(sid4).assets.length, 1);
  }

  // HTTP：列表接口（面板图墙用它）
  {
    const list = await callGet('/rp-tools/assets', `?sessionId=${sid}`);
    check('资源库：列表 200', list.status, 200);
    check('资源库：列表总数', list.json.total, 3);
    check('资源库：列表按分类给了中文名与条数',
      (list.json.kinds ?? []).map((k) => `${k.key}=${k.label}:${k.count}`).join(','),
      'portrait=角色:1,scene=场景:1,item=道具:1,other=其他:0');
    check('资源库：每条都带展示地址与缩略图地址',
      String(list.json.assets[0].url).startsWith('/rp-tools/asset-image?')
      && String(list.json.assets[0].previewUrl).includes('thumb=1'), true);
    check('资源库：列表按分类过滤', (await callGet('/rp-tools/assets', `?sessionId=${sid}&kind=item`)).json.total, 1);
    check('资源库：列表按关键词过滤', (await callGet('/rp-tools/assets', `?sessionId=${sid}&q=${encodeURIComponent('钥匙')}`)).json.total, 1);
    check('资源库：缺 sessionId 400', (await callGet('/rp-tools/assets')).status, 400);
  }

  // HTTP：取图（含服务端降采样）+ 路径穿越
  {
    const img = await callGetRaw(`/rp-tools/asset-image?sessionId=${sid}&id=${one.id}`);
    check('资源库：取图 200', img.status, 200);
    check('资源库：取回的字节一致', img.bytes.equals(png), true);
    const thumb = await callGetRaw(`/rp-tools/asset-image?sessionId=${sid}&id=${one.id}&thumb=1&width=48`);
    check('资源库：缩略图也是 200', thumb.status, 200);
    check('资源库：缩略图比原图小（真的降采样了）', thumb.bytes.length < png.length, true);
    // 面板图墙必须走缩略图地址，不能原图直出（一张几百 KB × 上百张会拖死面板）
    check('资源库：列表给的是缩略图地址（thumb=1）',
      String((await callGet('/rp-tools/assets', `?sessionId=${sid}`)).json.assets[0].previewUrl).includes('thumb=1'), true);
    check('资源库：不存在的 id 404',
      (await callGetRaw(`/rp-tools/asset-image?sessionId=${sid}&id=deadbeef`)).status, 404);
    check('资源库：缺 id 400', (await callGetRaw(`/rp-tools/asset-image?sessionId=${sid}`)).status, 400);
    check('资源库：只认 GET',
      (await callPost('/rp-tools/asset-image', { sessionId: sid, id: one.id })).status, 405);
    // 把索引里的相对路径改成往外跳 —— 前缀校验必须挡住（第二道锁）
    const idx = D.loadAssets(sid);
    idx.assets.find((a) => a.id === one.id).file = 'assets/scenes/../../../../outside.png';
    D.saveAssets(sid, idx);
    const esc = await callGet('/rp-tools/asset-image', `?sessionId=${sid}&id=${one.id}`);
    check('资源库：越界路径被拒', esc.status, 400);
    check('资源库：拒绝理由是路径越界', esc.json.error, '路径越界');
    // 改回去，后面还要用它
    const idx2 = D.loadAssets(sid);
    idx2.assets.find((a) => a.id === one.id).file = one.file;
    D.saveAssets(sid, idx2);
  }

  // HTTP：改标签 / 设为立绘 / 删除
  {
    const upd = await callPost('/rp-tools/assets', { sessionId: sid, action: 'update', id: three.id, label: '青铜钥匙·改', tags: '道具,钥匙,要紧' });
    check('资源库：改标签成功', upd.status, 200);
    check('资源库：改后的名字读得回来', D.loadAssets(sid).assets.find((a) => a.id === three.id).label, '青铜钥匙·改');
    check('资源库：改后的标签读得回来',
      (D.loadAssets(sid).assets.find((a) => a.id === three.id).tags ?? []).join(','), '道具,钥匙,要紧');
    check('资源库：改不存在的 id 404',
      (await callPost('/rp-tools/assets', { sessionId: sid, action: 'update', id: 'nope' })).status, 404);
    check('资源库：跨源写被拒',
      (await callPost('/rp-tools/assets', { sessionId: sid, action: 'update', id: three.id }, 'http://evil.example', '127.0.0.1:3080')).status, 403);
    check('资源库：缺 id 400',
      (await callPost('/rp-tools/assets', { sessionId: sid, action: 'update' })).status, 400);

    // 设为立绘：必须**清掉旧的 generated**，否则读取端优先用 generated，用户点了没反应（静默失效）
    const legacy = D.loadSession(sid);
    legacy.portraits = { ...(legacy.portraits ?? {}), 祁俊: { generated: { file: 'old.png', subfolder: '', type: 'output' } } };
    D.saveSession(legacy);
    const use = await callPost('/rp-tools/assets', { sessionId: sid, action: 'useAsPortrait', id: two.id, name: '祁俊' });
    check('资源库：设为立绘成功', use.status, 200);
    check('资源库：立绘指向资源文件', D.loadSession(sid).portraits?.祁俊?.imported?.file, two.file);
    check('资源库：设为立绘会清掉旧的生成立绘（否则永远显示旧那张）',
      D.loadSession(sid).portraits?.祁俊?.generated, undefined);
    check('资源库：设为立绘时缺 name 被拒',
      (await callPost('/rp-tools/assets', { sessionId: sid, action: 'useAsPortrait', id: two.id })).status, 400);

    // 删除：连磁盘文件一起删，并解除指向它的立绘引用
    const del = await callPost('/rp-tools/assets', { sessionId: sid, action: 'delete', id: two.id });
    check('资源库：删除成功', del.status, 200);
    check('资源库：磁盘文件也没了', del.json.fileGone, true);
    // **别只信返回的 fileGone，回到磁盘确认一次** —— 这一条以前只断言那个布尔量，
    // 而它是「rmSync 没抛错」推出来的；本机实测 rmSync 对中文名会静默失败。
    check('资源库：磁盘上确实没有那个文件了', existsSync(join(sessionDir, two.file)), false);
    check('资源库：索引里也删了', D.loadAssets(sid).assets.some((a) => a.id === two.id), false);
    check('资源库：删掉的图不再有立绘引用（不留死链）', (del.json.droppedPortraits ?? []).join(','), '祁俊');
    check('资源库：那条立绘真的被解除了', D.loadSession(sid).portraits?.祁俊, undefined);
  }

  // 通用导入：外部图也能进任意分类（用户要求「外部图片都保存下来」）
  {
    const sid3 = crypto.randomUUID();
    const ws3 = join(TEST_HOME, 'ws-assets-import');
    mkdirSync(ws3, { recursive: true });
    D.setSessionCwd(sid3, ws3);
    const imp = await callPost('/rp-tools/asset-upload', {
      sessionId: sid3, kind: 'item', dataUrl: `data:image/png;base64,${png.toString('base64')}`, label: '外部掉落图', tags: '道具',
    });
    check('资源库：通用导入成功', imp.status, 200);
    check('资源库：导入的分类生效', imp.json.asset.kind, 'item');
    check('资源库：导入落进 items/', String(imp.json.file).startsWith('assets/items/'), true);
    check('资源库：导入的 source 标成 imported', imp.json.asset.source, 'imported');
    check('资源库：导入也能列出来', (await callGet('/rp-tools/assets', `?sessionId=${sid3}&kind=item`)).json.total, 1);
    check('资源库：导入角色图缺 name 被拒',
      (await callPost('/rp-tools/asset-upload', {
        sessionId: sid3, kind: 'portrait', dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      })).status, 400);
  }

  // 工具：rp_assets（DM 侧的浏览入口）
  {
    const tool = tools.get('rp_assets');
    check('资源库：注册了 rp_assets 工具', Boolean(tool), true);
    check('资源库：rp_assets 不声明并发安全（tag 要写索引，read-modify-write）',
      typeof tool?.isConcurrencySafe === 'function' ? tool.isConcurrencySafe({}) : false, false);
    const ctx = { agent: { id: sid } };
    const listed = await tool.execute({ action: 'list' }, ctx);
    check('资源库：工具列出条数', listed.total, 2);
    check('资源库：工具的行里带 id', listed.lines.join('\n').includes(`id=${one.id}`), true);
    check('资源库：工具的行里带可直接展示的地址', listed.lines.join('\n').includes('/rp-tools/asset-image?'), true);
    check('资源库：工具的行里带中文分类', listed.lines.join('\n').includes('[场景]'), true);
    check('资源库：工具按分类过滤', (await tool.execute({ action: 'list', kind: 'scene' }, ctx)).total, 1);
    const tagged = await tool.execute({ action: 'tag', id: one.id, label: '雨夜客栈（改）', tags: '客栈' }, ctx);
    check('资源库：工具能补标签', tagged.ok, true);
    check('资源库：补的标签落盘了', D.loadAssets(sid).assets.find((a) => a.id === one.id).label, '雨夜客栈（改）');
    check('资源库：工具 get 单张给出提示词原文',
      (await tool.execute({ action: 'get', id: one.id }, ctx)).lines.join('\n').includes('提示词原文'), true);
  }

  // 常驻段：只报条数 + 指向 rp_assets（**不能**把上百条列进来，那是每轮都发的）
  {
    const standing = D.buildStandingText({ ...D.loadSession(sid), sessionId: sid, characters: [] }, {});
    check('资源库：常驻段有摘要行', standing.includes('资源库：本会话已有'), true);
    check('资源库：摘要里报的是「张图」', standing.includes('张图'), true);
    check('资源库：摘要指向 rp_assets', standing.includes('先用 `rp_assets` 按标签或角色查一遍'), true);
    check('资源库：摘要里**没有**逐张清单（否则每轮白烧几千字）',
      standing.includes('/rp-tools/asset-image?'), false);
  }
}

// ── 配图入库（1.14.0）：宿主出的图怎么收进资源库 ───────────────────────────────
// 本地生图搬走后，**新图入库只剩一个入口**：`rp_assets(action:"import")`。
// 它的两条来源（`path` / `attachment_id`）与安全边界（只读、限工作区、限图片扩展名）
// 都必须有断言 —— 这是模型每出一张图都要走的路，坏掉的话图就永远进不了库。
{
  const D = mod.__debug;
  const { imagePng } = await import(pathToFileURL(join(here, 'png-fixture.mjs')).href);
  const sid = crypto.randomUUID();
  const ws = join(TEST_HOME, 'ws-asset-import');
  mkdirSync(ws, { recursive: true });
  D.setSessionCwd(sid, ws);
  const ctx = { agent: { id: sid } };
  const assets = tools.get('rp_assets');
  const imgDir = join(ws, 'dsh-image-gen');
  mkdirSync(imgDir, { recursive: true });
  const png = imagePng(80, 80, (x, y) => [x * 3, 90, y * 3, 255]);
  writeFileSync(join(imgDir, 'image-0001.png'), png);
  writeFileSync(join(imgDir, 'note.txt'), '这不是图');
  writeFileSync(join(ws, 'outside-ok.png'), imagePng(8, 8, () => [1, 2, 3, 255]));

  // ① 工作区相对路径（= 宿主生图工具返回的 `savedTo`）——最常用的一条
  {
    const rel = 'dsh-image-gen/image-0001.png';
    const r = await D.readImageForImport(sid, ws, ctx, { path: rel });
    check('配图入库：相对路径读得到', r.ok, true);
    check('配图入库：from 里给出的是相对路径', r.from, `工作区 ${rel}`);
    check('配图入库：字节与原图一致', r.bytes.equals(png), true);
    check('配图入库：认得出扩展名', r.ext, 'png');
  }

  // ② 只给文件名 → 回退到 `dsh-image-gen/` 下再找一次（模型常只抄文件名）
  {
    const r = await D.readImageForImport(sid, ws, ctx, { path: 'image-0001.png' });
    check('配图入库：只给文件名也能找到', r.ok, true);
    check('配图入库：回退找的就是 dsh-image-gen/ 下那张', r.from, '工作区 dsh-image-gen/image-0001.png');
  }

  // ③ 安全边界：工作区里但不在 dsh-image-gen/ 下也能读（savedTo 可能是别处），
  //    但**越出工作区**一律拒绝，且要在解析后的绝对路径上判（不能只查入参字符串）
  {
    // 越界用例必须让**文件真的存在**，否则撞上的是「文件不存在」那条早退分支，
    // 测不到越界校验（那会是假绿）。
    writeFileSync(join(TEST_HOME, 'secret.png'), imagePng(8, 8, () => [9, 9, 9, 255]));
    check('配图入库：工作区里的其它位置也能读',
      (await D.readImageForImport(sid, ws, ctx, { path: 'outside-ok.png' })).ok, true);
    const esc = await D.readImageForImport(sid, ws, ctx, { path: '../secret.png' });
    check('配图入库：越出工作区被拒', esc.ok, false);
    check('配图入库：拒绝理由是越界', String(esc.error).includes('越出'), true);
    // 绝对路径指到工作区外（Windows 上盘符路径同样要挡）
    const abs = await D.readImageForImport(sid, ws, ctx, { path: join(TEST_HOME, 'outside-ok.png') });
    check('配图入库：库外绝对路径被拒', abs.ok, false);
  }

  // ④ 非图片扩展名拒绝（别把 txt / exe 收进图墙）
  {
    const r = await D.readImageForImport(sid, ws, ctx, { path: 'dsh-image-gen/note.txt' });
    check('配图入库：非图片扩展名被拒', r.ok, false);
    check('配图入库：拒绝理由点名只认 png/jpeg/webp', String(r.error).includes('只认 png'), true);
  }

  // ⑤ 找不到文件时报错要带「找过哪些路径」，省一轮瞎猜
  {
    const r = await D.readImageForImport(sid, ws, ctx, { path: 'dsh-image-gen/nope.png' });
    check('配图入库：文件不存在时报错', r.ok, false);
    check('配图入库：报错里列出找过的两个候选',
      String(r.error).includes('工作区里没有这个文件') && String(r.error).includes('与'), true);
  }

  // ⑥ 两个来源都没给 → 拒绝，并把**最近生成的那几张**列出来（可复制进 path）
  {
    const direct = await D.readImageForImport(sid, ws, ctx, {});
    check('配图入库：不给 path/attachment_id 时拒绝', direct.ok, false);
    check('配图入库：拒绝理由说清需要什么', direct.error, '需要 path 或 attachment_id');
    // 候选清单：只收图片、按 mtime 倒序、给的是工作区相对路径
    const recent = D.recentWorkspaceImages(ws);
    check('配图入库：候选里只有图片', recent.every((p) => /\.(png|jpe?g|webp)$/i.test(p)), true);
    check('配图入库：候选是工作区相对路径', recent.includes('dsh-image-gen/image-0001.png'), true);
    check('配图入库：候选不含非图片文件', recent.includes('dsh-image-gen/note.txt'), false);
    check('配图入库：没有工作区时候选为空数组（不抛）', JSON.stringify(D.recentWorkspaceImages('')), '[]');
    check('配图入库：工作区里没有那个子目录时也返回空数组（不抛）',
      JSON.stringify(D.recentWorkspaceImages(join(TEST_HOME, '不存在的目录'))), '[]');
    // 工具的报错必须把候选列进去（「只回一句『需要 path』」正是真机复测投诉过的那种错）
    let msg = '';
    try { await assets.execute({ action: 'import' }, ctx); } catch (error) { msg = String(error?.message ?? error); }
    check('配图入库：工具报错要求 path 或 attachment_id', msg.includes('需要 path 或 attachment_id'), true);
    check('配图入库：工具报错里列出最近生成的候选',
      msg.includes('dsh-image-gen/') && msg.includes('image-0001.png'), true);
  }

  // ⑦ 真的走一遍工具：path → 归档 + 索引，label/tags/kind/characters 都落盘
  {
    const registered = await tools.get('rp_character').execute({
      action: 'set', name: '祁俊', appearance: '少年，短发',
    }, ctx);
    check('配图入库：前置——角色登记成功', registered.ok, true);
    const made = await assets.execute({
      action: 'import', path: 'dsh-image-gen/image-0001.png', kind: 'scene',
      label: '雨夜客栈大堂', tags: '客栈,雨夜', prompt: '祁俊在雨夜里的客栈大堂',
    }, ctx);
    check('配图入库：工具导入成功', made.ok, true);
    check('配图入库：note 说清来源与 id', made.note.includes('已收进资源库') && made.note.includes('id='), true);
    const entry = D.loadAssets(sid).assets[0];
    check('配图入库：索引里一条', D.loadAssets(sid).assets.length, 1);
    check('配图入库：分类落盘', entry?.kind, 'scene');
    check('配图入库：标签落盘', (entry?.tags ?? []).join(','), '客栈,雨夜');
    check('配图入库：提示词原文落盘（事后能补救标签）', entry?.prompt, '祁俊在雨夜里的客栈大堂');
    check('配图入库：source 标成 imported', entry?.source, 'imported');
    // 画面里的角色由**复数**的 charactersInPrompt 扫出来（单数的 characterInPrompt 已随固定种子删除）
    check('配图入库：按提示词里的角色名自动归类',
      (entry?.characters ?? []).join(','), '祁俊');
    check('配图入库：库地址可用', String(made.lines[0]).includes('/rp-tools/asset-image?'), true);

    // ⑧ **同一份字节再导一次 → 还是一条**（内容优先去重；这是真机修过的 bug）
    const again = await assets.execute({
      action: 'import', path: 'dsh-image-gen/image-0001.png', kind: 'item', label: '第二次导入',
    }, ctx);
    check('配图入库：同字节再导不新增', D.loadAssets(sid).assets.length, 1);
    check('配图入库：note 说明库里已经有了', again.note.includes('库里已经有了'), true);
    check('配图入库：同字节再导返回同一个 id', D.loadAssets(sid).assets[0]?.id, entry?.id);
    // 换 kind 收同一张图**也必须合并**（按 kind 查重会把同一张图存成两份 —— 那个 bug 就是这个）
    const crossKind = await assets.execute({
      action: 'import', path: 'dsh-image-gen/image-0001.png', kind: 'portrait', label: '同一张算立绘',
    }, ctx);
    check('配图入库：换 kind 收同一张图仍然只有一条', D.loadAssets(sid).assets.length, 1);
    check('配图入库：换 kind 也标成已存在', crossKind.note.includes('库里已经有了'), true);
  }
}

// ── 卡库配置补丁（工具与设置页共用一份规则）──────────────────────────────────
// `applyCardConfigPatch` 是 `rp_config` 的 action:"set" 与 `POST /rp-tools/config`
// 共用的**唯一**一份归一化规则。规则只有一处，所以它值得单独钉住：
// 非法宏名要丢、空值要丢（留空行等于界面噪音）、`userLabel` 跟着 `user` 走、打完补丁要标记 seeded。
{
  const D = mod.__debug;
  const base = { cards: { root: '/old', userLabel: '旧称呼', macros: { user: '旧' }, macrosSeeded: false }, extra: 1 };

  // ① 合法宏名 + 非空值 → 收；非法名 / 空值 → 丢
  const patched = D.applyCardConfigPatch(base, { macros: { user: '玩家', place: '长安', 'BAD KEY': 'x', '1bad': 'y', UPPER: 'z', empty: '   ' } });
  check('卡库补丁：合法宏名保留（含大写归一成小写）',
    Object.keys(patched.macros).sort().join(','), 'place,upper,user');
  check('卡库补丁：非法宏名被丢掉', Object.hasOwn(patched.macros, 'BAD KEY'), false);
  check('卡库补丁：数字开头的宏名被丢掉', Object.hasOwn(patched.macros, '1bad'), false);
  check('卡库补丁：空值被丢掉（不留空行）', Object.hasOwn(patched.macros, 'empty'), false);
  check('卡库补丁：值保留原文', patched.macros.user, '玩家');
  check('卡库补丁：大写宏名归一成小写', patched.macros.upper, 'z');

  // ② userLabel 与 macros.user 保持同步（它只是 1.8.7 之前的老字段，不能说两套话）
  check('卡库补丁：userLabel 跟着 user 走', patched.userLabel, '玩家');
  check('卡库补丁：user 为空串时 userLabel 也清空',
    D.applyCardConfigPatch(base, { macros: { place: '长安' } }).userLabel, '');
  // ③ seeded 标记：用户动过这个列表，之后不再自动补 `user -> 玩家`
  check('卡库补丁：打上 macrosSeeded', patched.macrosSeeded, true);

  // ④ root：传了就换、没传保持原值（只改宏不该把卡库目录弄丢）
  check('卡库补丁：root 传了就换', D.applyCardConfigPatch(base, { root: '/new' }).root, '/new');
  check('卡库补丁：root 没传就保持', D.applyCardConfigPatch(base, { macros: { user: 'x' } }).root, '/old');
  check('卡库补丁：root 两边的空白裁掉', D.applyCardConfigPatch(base, { root: '  /x  ' }).root, '/x');
  check('卡库补丁：不传 root 也不传 macros 时清空宏表（界面提交的就是全量）',
    Object.keys(D.applyCardConfigPatch(base, {}).macros).length, 0);

  // ⑤ 只返回 `cards` 那一份配置（**不是**整份 cfg）—— 调用方必须自己包回 `cards`
  check('卡库补丁：返回的是 cards 那一层（没有 cards 包装）',
    Object.keys(D.applyCardConfigPatch(base, {})).sort().join(','), 'macros,macrosSeeded,root,userLabel');
  check('卡库补丁：不改原对象', Object.keys(base.cards.macros).join(','), 'user');
  check('卡库补丁：原对象其它字段原样', base.extra, 1);

  // ⑥ HTTP 路由（设置页/面板提交的那条）：合法补丁必须**真的落盘**且读得回来。
  //    这一条还顺手锁住「落盘形状必须是 { cards: {...} }」——`rp_config` 工具那条路
  //    在这里踩过坑（见下面 ⑦ 的说明）。
  {
    const before = await callGet('/rp-tools/state');
    const keptMacros = before.json.config?.cards?.macros ?? {};
    const applied = await callPost('/rp-tools/config', {
      cards: { root: before.json.config?.cards?.root ?? '', macros: { ...keptMacros, smoke_route: '路由值', 'BAD KEY': 'x' } },
    });
    check('卡库配置：路由返回 ok', applied.json.ok, true);
    check('卡库配置：非法宏名被丢掉', Object.hasOwn(applied.json.config?.cards?.macros ?? {}, 'BAD KEY'), false);
    check('卡库配置：合法宏名写进去了', applied.json.config?.cards?.macros?.smoke_route, '路由值');
    // 读回来（走磁盘，不是内存）——落盘形状错了这里就会变成出厂默认值
    const reread = await callGet('/rp-tools/state');
    check('卡库配置：重新读一次还在（落盘形状是对的）',
      reread.json.config?.cards?.macros?.smoke_route, '路由值');
    check('卡库配置：userLabel 与 user 同步', reread.json.config?.cards?.userLabel, reread.json.config?.cards?.macros?.user ?? '');
    // 还回去，别影响后面的用例
    await callPost('/rp-tools/config', { cards: { root: before.json.config?.cards?.root ?? '', macros: keptMacros } });
  }

  // ⑦ `rp_config` 工具的 get / 参数校验（写路径见下面的 ★ 说明）
  {
    const cfg = tools.get('rp_config');
    check('rp_config：注册了工具', Boolean(cfg), true);
    const listed = await cfg.execute({ action: 'get' });
    check('rp_config：get 报出卡库根目录那一行',
      listed.lines.some((l) => l.startsWith('卡库根目录：')), true);
    check('rp_config：get 报出默认宏列表条数',
      listed.lines.some((l) => l.startsWith('默认宏（')), true);
    check('rp_config：get 指向宿主 generate_image 与 rp_assets 入库',
      listed.lines.some((l) => l.includes('generate_image') && l.includes('rp_assets')), true);
    check('rp_config：get 给出配置文件路径（可直接 read/write）',
      listed.lines.some((l) => l.includes('styles.json')), true);
    const errOfCfg = async (args) => {
      try { await cfg.execute(args); return ''; } catch (error) { return String(error?.message ?? error); }
    };
    check('rp_config：未知 action 报错', (await errOfCfg({ action: 'nonsense' })).includes('未知 action'), true);
    check('rp_config：非法宏名报错',
      (await errOfCfg({ action: 'set', macro_name: 'bad name', macro_value: 'x' })).includes('不合法'), true);
    // ★ 回归（曾真坏过，且是**静默丢用户配置**那一类）：`set` 之后必须真的读得回来。
    //   旧实现工具那条路写成 `cfg = applyCardConfigPatch(cfg, patch)`，而该函数返回的是
    //   **cards 那一层** —— 盘上被写成 `{root,userLabel,macros,macrosSeeded}`（少了 `cards` 壳），
    //   下一次 `loadStyles()` 认不出来就退回出厂默认（用户的默认宏列表/卡库目录无声消失），
    //   而工具照样回「✅ 已更新」。所以这里必须三面都钉：读得回来、盘上有 `cards`、形状对。
    {
      const set = await cfg.execute({ action: 'set', macro_name: 'place', macro_value: '广寒宫' });
      check('rp_config：set 回显成功', String(set.note).includes('已更新'), true);
      const after = await cfg.execute({ action: 'get' });
      check('rp_config：set 之后 get 读得回来（默认宏里有 place）',
        after.lines.some((l) => l.startsWith('默认宏（') && l.includes('place') && l.includes('广寒宫')), true);
      // 直接看盘：形状必须是 { cards: { root, userLabel, macros, macrosSeeded } }
      const onDisk = JSON.parse(readFileSync(join(TEST_HOME, 'data', 'dsh-rp-tools', 'styles.json'), 'utf8'));
      check('rp_config：盘上保留了 cards 这一层', Boolean(onDisk.cards && typeof onDisk.cards === 'object'), true);
      check('rp_config：盘上没有把 cards 摊平到顶层',
        ['root', 'userLabel', 'macros', 'macrosSeeded'].every((k) => !(k in onDisk)), true);
      check('rp_config：盘上的宏真的写进去了', onDisk.cards?.macros?.place, '广寒宫');
      check('rp_config：userLabel 跟着 macros.user 走（老字段不说两套话）', onDisk.cards?.userLabel, '玩家');
      // 擦掉，免得影响后面读同一份配置的用例
      await cfg.execute({ action: 'set', macro_name: 'place', macro_value: '' });
      const cleaned = JSON.parse(readFileSync(join(TEST_HOME, 'data', 'dsh-rp-tools', 'styles.json'), 'utf8'));
      check('rp_config：空值等于删掉这条宏', 'place' in (cleaned.cards?.macros ?? {}), false);
    }
  }

  // ── 全局工具放行名单（1.15.0 起可配置）─────────────────────────────────────
  // 背景：本插件不出图，DM 配图靠宿主的**全局**工具，而 dm-filter 会 deny 不在名单里的全局工具。
  // 名单可配置才有意义 —— **每个 DSH 装的生图插件可能不同、工具名也不同**。
  // 这一组钉住：发现能力（列出本机真实存在的全局工具）、勾选持久化、非法值剔除、底线不可取消。
  {
    // ① 发现：GET 要列出桩里那些全局工具，并标出哪些已勾选 / 哪些是底线
    const listed = await callGet('/rp-tools/global-tools');
    check('全局工具：GET ok', listed.status, 200);
    check('全局工具：报出底线三项', (listed.json.base ?? []).join(','), 'render_ui,validate_dsh_ui,web_search');
    check('全局工具：默认额外放行 = 宿主生图工具', (listed.json.allow ?? []).join(','), 'generate_image,edit_image');
    check('全局工具：列出了本机真实存在的全局工具',
      (listed.json.available ?? []).map((a) => a.name).sort().join(','),
      'canvas_state,edit_image,generate_image,my_image_plugin,render_ui,validate_dsh_ui,web_fetch,web_search'.split(',').sort().join(','));
    check('全局工具：默认项标记为已勾选',
      (listed.json.available ?? []).filter((a) => a.checked).map((a) => a.name).sort().join(','), 'edit_image,generate_image');
    check('全局工具：底线项标记为 locked（界面不可取消）',
      (listed.json.available ?? []).filter((a) => a.locked).map((a) => a.name).sort().join(','), 'render_ui,validate_dsh_ui,web_search');
    check('全局工具：生图类工具被标成 imageLike（界面好找）',
      (listed.json.available ?? []).filter((a) => a.imageLike).map((a) => a.name).sort().join(','),
      'edit_image,generate_image,my_image_plugin');
    check('全局工具：默认没有「未注册」的项', (listed.json.missing ?? []).length, 0);

    // ② 换生图插件：把 my_image_plugin 勾上、去掉 generate_image
    const saved = await callPost('/rp-tools/global-tools', { allow: ['my_image_plugin', 'edit_image'] });
    check('全局工具：POST ok', saved.status, 200);
    check('全局工具：勾选结果落库', (saved.json.allow ?? []).join(','), 'my_image_plugin,edit_image');
    const reread = await callGet('/rp-tools/global-tools');
    check('全局工具：重读得到同样的勾选', (reread.json.allow ?? []).join(','), 'my_image_plugin,edit_image');
    check('全局工具：重读后勾选状态跟着变',
      (reread.json.available ?? []).filter((a) => a.checked).map((a) => a.name).sort().join(','), 'edit_image,my_image_plugin');

    // ③ 盘上确实是 styles.json 的 globalToolsAllow（过滤器就是读这个键）
    const onDiskGt = JSON.parse(readFileSync(join(TEST_HOME, 'data', 'dsh-rp-tools', 'styles.json'), 'utf8'));
    check('全局工具：落盘在 globalToolsAllow 键上',
      (onDiskGt.globalToolsAllow ?? []).join(','), 'my_image_plugin,edit_image');

    // ④ 非法值 / 底线名要被剔除（这个值有一条写入路径来自模型，不能因为脏值整份写不进去）
    const dirty = await callPost('/rp-tools/global-tools', { allow: ['generate_image', 'render_ui', 'BAD NAME', 'ok_tool', 'ok_tool', 'tool.with.dot'] });
    check('全局工具：剔除底线名与非法名、去重', (dirty.json.allow ?? []).join(','), 'generate_image,ok_tool');
    const notArray = await callPost('/rp-tools/global-tools', { allow: 'generate_image' });
    check('全局工具：allow 不是数组 → 400', notArray.status, 400);

    // ⑤ 配置里有、但注册表里没有的名字要能被看见（否则用户只看到「为什么没生效」）
    await callPost('/rp-tools/global-tools', { allow: ['not_installed_yet'] });
    const missing = await callGet('/rp-tools/global-tools');
    check('全局工具：未注册的名字列进 missing', (missing.json.missing ?? []).join(','), 'not_installed_yet');

    // ⑥ 工具侧的等价入口（`rp_config(action:"set_global_tools")`，参数是逗号分隔字符串）
    const cfg2 = tools.get('rp_config');
    const setGt = await cfg2.execute({ action: 'set_global_tools', global_tools: 'generate_image, edit_image , my_image_plugin' });
    check('rp_config：set_global_tools 回显成功', String(setGt.note).includes('已更新'), true);
    check('rp_config：set_global_tools 剔除已删/非法并归一',
      JSON.parse(readFileSync(join(TEST_HOME, 'data', 'dsh-rp-tools', 'styles.json'), 'utf8')).globalToolsAllow.join(','),
      'generate_image,edit_image,my_image_plugin');
    const getGt = await cfg2.execute({ action: 'get' });
    check('rp_config：get 报出放行名单那一行',
      getGt.lines.some((l) => l.startsWith('放行给 DM 会话的全局工具：') && l.includes('generate_image')), true);
    check('rp_config：get 报出本机实际存在的全局工具（供核对名字）',
      getGt.lines.some((l) => l.includes('本机实际存在的全局工具：') && l.includes('my_image_plugin')), true);

    // ⑦ 复原成默认，免得影响后面读同一份配置的用例
    await callPost('/rp-tools/global-tools', { allow: ['generate_image', 'edit_image'] });
    check('全局工具：复原为出厂默认',
      JSON.parse(readFileSync(join(TEST_HOME, 'data', 'dsh-rp-tools', 'styles.json'), 'utf8')).globalToolsAllow.join(','),
      'generate_image,edit_image');
  }
}

// ── 工具面：删干净了没有 ─────────────────────────────────────────────────────
// 本地生图搬走后，工具从 11 个降到 8 个。这一条是**正面**断言：
// 已删的三个必须真的不在注册表里（模型去调它会得到「工具不存在」），
// 剩下的八个必须在。少一个 = 功能没了；多一个 = 有东西没删干净。
{
  const REMOVED = ['rp_styles', 'rp_illustrate', 'rp_scenes'];
  const KEPT = ['rp_random', 'rp_character', 'rp_state', 'rp_lore', 'rp_session', 'rp_assets', 'rp_config', 'rp_table'];
  for (const name of REMOVED) {
    check(`工具面：已删的 ${name} 未注册`, tools.has(name), false);
  }
  for (const name of KEPT) {
    check(`工具面：${name} 仍注册`, tools.has(name), true);
  }
  check('工具面：一共正好 8 个工具', [...tools.keys()].sort().join(','), KEPT.slice().sort().join(','));
  // 全局半侧**一个工具都不注册**（架构约束：rp_* 只出现在 dm 预设作用域）
  check('工具面：全局不注册任何模型工具', globalTools.join(',') || '（零个）', '（零个）');
}

// ── 随机核心：骰式解析与 count 契约 ────────────────────────────────────────
// 真机测试报告（会话 afdca15e）在这里抓到三条，而**这一段此前零覆盖** ——
// 现有断言里没有一条碰过 parseDice。所以 `2dd6` 被静默吃成「2 + 1d6」、
// `count:21` 被静默截成 20 这种事一直没人发现。下面每条都是那次报告里的**具体输入**。
{
  const D = mod.__debug;
  const tool = tools.get('rp_random');
  const run = (args) => tool.execute(args);
  /** 跑一次，返回错误信息（没抛就返回空串）—— 比到处写 try/catch 好读。 */
  const errOf = async (args) => {
    try { await run(args); return ''; } catch (error) { return String(error?.message ?? error); }
  };

  // ① 合法表达式照常
  check('骰式：d20 省略颗数时算 1 颗', D.parseDice('d20').dice[0].count, 1);
  check('骰式：2d6+3 的常数', D.parseDice('2d6+3').totalConst, 3);
  check('骰式：3d8+1d4-2 有两组骰', D.parseDice('3d8+1d4-2').dice.length, 2);
  check('骰式：3d8+1d4-2 的常数是 -2', D.parseDice('3d8+1d4-2').totalConst, -2);
  check('骰式：负骰组带负号', D.parseDice('1d20-1d4').dice[1].sign, -1);
  check('骰式：+2d6 的正号不影响结果', D.parseDice('+2d6').dice[0].count, 2);

  // ② **非法表达式必须整串拒绝**（报告 BUG-03）。
  //    旧实现是扫描式的：匹配不上的字符被跳过，于是 `2dd6` 变成「常数 2 + d6」照跑。
  for (const bad of ['2dd6', '2d6++3', '2d6+', '2d6+3+', 'd', 'abc', '+', '-', '2d6x3']) {
    check(`骰式：拒绝 "${bad}"`, await errOf({ dice: bad }),
      `rp_random: dice expression "${bad}" is invalid — expected something like "2d6+3" or "d20"`);
  }
  check('骰式：拒绝 d0（面数下限）', (await errOf({ dice: 'd0' })).includes('invalid sides'), true);
  check('骰式：拒绝 0d6（颗数下限）', (await errOf({ dice: '0d6' })).includes('invalid number of dice'), true);
  check('骰式：拒绝 101d6（颗数上限）', (await errOf({ dice: '101d6' })).includes('invalid number of dice'), true);
  // 报告漏掉的一条：`1d1000000000` 语法上「合法」，但掷出来是个十位数
  check('骰式：拒绝 1d1000000000（面数上限）', (await errOf({ dice: '1d1000000000' })).includes('invalid sides'), true);
  check('骰式：合法的不受影响（2d6+3 仍能跑）', (await run({ dice: '2d6+3', seed: 'ok' })).values.length, 1);

  // ③ count 越界**报错**，不静默截断（报告 BUG-04）
  check('count：缺省 = 1 个结果', (await run({ kind: 'integer' })).values.length, 1);
  check('count：20 是上界且允许', (await run({ kind: 'integer', count: 20 })).values.length, 20);
  check('count：21 报错（以前静默给 20）', await errOf({ kind: 'integer', count: 21 }), 'rp_random: count must be between 1 and 20 (got 21)');
  check('count：0 报错（以前静默抬成 1）', await errOf({ kind: 'integer', count: 0 }), 'rp_random: count must be between 1 and 20 (got 0)');
  check('count：负数报错', await errOf({ kind: 'integer', count: -3 }), 'rp_random: count must be between 1 and 20 (got -3)');
  check('count：小数报错', (await errOf({ kind: 'integer', count: 2.5 })).includes('must be an integer'), true);
  check('count：骰子模式同样受约束', (await errOf({ dice: '2d6', count: 99 })).includes('count must be between'), true);

  // ④ 每一掷都要有**可核对的**明细（报告 BUG-05；根因不是「复杂骰式」，是 count>1 覆盖了 note）
  const one = await run({ kind: 'dice', dice: '2d6+3', seed: 'detail-1' });
  check('明细：单掷带逐颗明细', /^2d6\+3 → \d+（2d6\[\d+,\d+\] \+ 3）$/.test(one.note), true);
  const m = /2d6\[(\d+),(\d+)\] \+ 3/.exec(one.note);
  check('明细：总和 = 逐颗之和 + 常数（能对上账）', Number(one.values[0]), Number(m[1]) + Number(m[2]) + 3);
  const many = await run({ kind: 'dice', dice: '2d6+3', count: 3, seed: 'detail-3' });
  check('明细：多掷时**每一掷**都有明细', (many.note.match(/2d6\[/g) ?? []).length, 3);
  check('明细：多掷时常数也出现在每一掷里', (many.note.match(/\+ 3）/g) ?? []).length, 3);
  const cx = await run({ kind: 'dice', dice: '3d8+1d4-2', count: 2, seed: 'detail-cx' });
  check('明细：复杂骰式多掷有明细', (cx.note.match(/3d8\[/g) ?? []).length, 2);
  check('明细：负常数带负号', cx.note.includes('- 2'), true);
  check('明细：第二组正骰带 + 号（否则两组看起来粘在一起）', /3d8\[[\d,]*\] \+ 1d4\[/.test(cx.note), true);
  check('明细：负骰组带负号', (await run({ kind: 'dice', dice: '1d20-1d4', seed: 'detail-neg' })).note.includes('- 1d4['), true);

  // ⑤ 随机表与面板掷表走**同一个** count 契约（否则两个入口行为不一致）
  const tsid = crypto.randomUUID();
  const tws = join(TEST_HOME, 'ws-dice-table');
  mkdirSync(tws, { recursive: true });
  D.setSessionCwd(tsid, tws);
  const tctx = { agent: { id: tsid } };
  const table = tools.get('rp_table');
  await table.execute({ action: 'set', name: 'QA骰表', dice: '1d4', entries: ['A', 'B', 'C', 'D'] }, tctx);
  check('随机表：count=3 掷三次', (await table.execute({ action: 'roll', name: 'QA骰表', count: 3, seed: 't' }, tctx)).lines.length, 3);
  check('随机表：count=21 同样报错（不再静默截断）', (await (async () => {
    try { await table.execute({ action: 'roll', name: 'QA骰表', count: 21 }, tctx); return ''; } catch (e) { return String(e.message); }
  })()).includes('count must be between'), true);
  check('随机表：掷表结果也带逐颗明细',
    (await table.execute({ action: 'roll', name: 'QA骰表', seed: 't' }, tctx)).lines[0].includes('1d4['), true);
  // HTTP 那条（面板「掷」按钮）也必须一致
  check('随机表：HTTP 路由 count=21 也拒绝',
    (await callPost('/rp-tools/roll', { sessionId: tsid, name: 'QA骰表', count: 21 })).status, 400);
  check('随机表：HTTP 路由正常掷',
    (await callPost('/rp-tools/roll', { sessionId: tsid, name: 'QA骰表', count: 2 })).json.lines.length, 2);
}

// ── 空白会话的常驻段必须**明说「没有」**（报告 BUG-01/02 的种子）─────────────
// 报告把「persona 里的规矩」读成了「本会话已有的事实」。根因不是后端不一致，而是
// 空会话的注入里**什么都不出现** —— 「没出现」很容易被读成「已经有了」。现在空就直说。
{
  const D = mod.__debug;
  const sid = crypto.randomUUID();
  const ws = join(TEST_HOME, 'ws-empty-standing');
  mkdirSync(ws, { recursive: true });
  D.setSessionCwd(sid, ws);
  const loreFile = join(ws, 'rp-sessions', sid, 'rp-worldbook.md');
  const text = D.buildStandingText({ ...D.loadSession(sid), sessionId: sid }, { loreFile });
  check('空会话常驻段：明说还没有角色', text.includes('【人物】本会话还没有登记任何角色'), true);
  check('空会话常驻段：明说资源库是空的', text.includes('资源库：本会话**还没有任何图**'), true);
  check('空会话常驻段：明说世界书文件还不存在', text.includes('**这份文件还不存在**'), true);
  check('空会话常驻段：给出建模板的办法', text.includes('rp_lore(action:"template")'), true);
  // 文件存在之后必须换回「正常」措辞（否则每轮都像在报错）
  mkdirSync(dirname(loreFile), { recursive: true });
  writeFileSync(loreFile, '# 世界书\n\n## 世界总纲\nconstant\n\n测试。\n');
  const text2 = D.buildStandingText({ ...D.loadSession(sid), sessionId: sid }, { loreFile });
  check('世界书存在后：不再说「还不存在」', text2.includes('**这份文件还不存在**'), false);
  check('世界书存在后：给出读写说明', text2.includes('用 read 读、用 write/edit 增改'), true);
}

// ── 复测报告（RETEST-01/02/03）+ launch 文件入常驻段 + 资源库去重 ─────────────
// 这一批全部来自第二次真机复测（会话 afdca15e，报告 RP_PLUGIN_TEST_REPORT_RETEST.md）：
// 三条新问题，外加一条复核里提出、复测未覆盖的结构性修法（launch 路径进常驻段）。
{
  const D = mod.__debug;
  const errOf = async (fn) => { try { await fn(); return ''; } catch (error) { return String(error?.message ?? error); } };

  // ① RETEST-01：`rp_table remove` 的回显不能是删除前的列表
  {
    const sid = crypto.randomUUID();
    const ws = join(TEST_HOME, 'ws-retest-table');
    mkdirSync(ws, { recursive: true });
    D.setSessionCwd(sid, ws);
    const ctx = { agent: { id: sid } };
    const table = tools.get('rp_table');
    await table.execute({ action: 'set', name: '甲表', dice: '1d4', entries: ['A', 'B', 'C', 'D'] }, ctx);
    await table.execute({ action: 'set', name: '乙表', dice: '1d6', entries: ['X', 'Y'] }, ctx);
    const rm = await table.execute({ action: 'remove', name: '甲表' }, ctx);
    check('RETEST-01：删除后回显只剩剩下的表', rm.lines.length, 1);
    check('RETEST-01：回显里不再出现刚删掉的那张', rm.lines.join('｜').includes('甲表'), false);
    check('RETEST-01：note 写明删了哪一张', rm.note.includes('甲表'), true);
    check('RETEST-01：剩下的表是对的', rm.lines[0].startsWith('乙表'), true);
    // 删一张不存在的表也不能谎报成功（同一类问题：回显与事实不符）
    const miss = await errOf(() => table.execute({ action: 'remove', name: '没有这张' }, ctx));
    check('RETEST-01：删不存在的表报错而不是「已删除」', miss.includes('没有名为 "没有这张" 的表'), true);
    check('RETEST-01：报错里列出实际有哪些表', miss.includes('甲表') || miss.includes('乙表'), true);
    check('RETEST-01：删完之后再删同一张也会报错（幂等失败要说出来）',
      (await errOf(() => table.execute({ action: 'remove', name: '甲表' }, ctx))).includes('没有名为'), true);
  }

  // ② RETEST-02：场景 id 的字段契约
  {
    check('RETEST-02：约定字段优先', D.sceneIdOf({ scene_id: 'A', id: 'B' }), 'A');
    check('RETEST-02：id 别名兜底', D.sceneIdOf({ id: 'S01' }), 'S01');
    check('RETEST-02：sceneId 别名兜底', D.sceneIdOf({ sceneId: 'S02' }), 'S02');
    check('RETEST-02：title 兜底', D.sceneIdOf({ title: '第一幕' }), '第一幕');
    check('RETEST-02：什么都没有给 ?', D.sceneIdOf({}), '?');
    check('RETEST-02：分镜 id 也认 id 别名', D.panelIdOf({ id: 'p9' }), 'p9');
    check('RETEST-02：分镜约定字段优先', D.panelIdOf({ panel_id: 'p1', id: 'p2' }), 'p1');

    // ⚠️ 这一段的 `rp_scenes`（整幕多格出图）已随本地生图一起删除：原先那几条「筛不到场景要报错
    // 而不是静默 0/0」的断言测的是那个工具的参数校验，工具没了就不能再断言 ——
    // 修的是它，不是这条契约；契约随工具一起作废（`rp_scenes` 不存在由「工具面」一段钉住）。
  }

  // ③ RETEST-03：`rp_assets get` / `tag` 的错误信息要分清「没传」和「不存在」
  {
    const sid = crypto.randomUUID();
    const ws = join(TEST_HOME, 'ws-retest-assets-err');
    mkdirSync(ws, { recursive: true });
    D.setSessionCwd(sid, ws);
    const ctx = { agent: { id: sid } };
    const assets = tools.get('rp_assets');
    const noId = await errOf(() => assets.execute({ action: 'get' }, ctx));
    const badId = await errOf(() => assets.execute({ action: 'get', id: 'deadbeef00' }, ctx));
    check('RETEST-03：没传 id 时说「需要 id」', noId.includes('需要 id'), true);
    check('RETEST-03：id 不存在时**不说**「需要 id」（以前两句一模一样）', badId.includes('需要 id'), false);
    check('RETEST-03：id 不存在时明确说没有这条', badId.includes('没有 id=deadbeef00 这条资源'), true);
    check('RETEST-03：报错里带上现有条数便于自查', badId.includes('本会话共'), true);
    const tagBad = await errOf(() => assets.execute({ action: 'tag', id: 'nope', label: 'x' }, ctx));
    check('RETEST-03：tag 的错误信息与 get 一致', tagBad.includes('没有 id=nope 这条资源'), true);
    // 存在的 id 仍然正常
    const made = await D.archiveAsset(sid, { bytes: Buffer.from([1, 2, 3, 4]), kind: 'scene', ext: 'png', label: '有这张' });
    check('RETEST-03：存在的 id 照常能 get',
      (await assets.execute({ action: 'get', id: made.id }, ctx)).lines[0].includes('有这张'), true);
  }

  // ④ launch 文件路径进常驻段 —— M-3 的正解：让 DM **不必去找**
  {
    const sid = crypto.randomUUID();
    const ws = join(TEST_HOME, 'ws-launch-standing');
    mkdirSync(ws, { recursive: true });
    D.setSessionCwd(sid, ws);
    const loreFile = join(ws, 'rp-sessions', sid, 'rp-worldbook.md');
    const cardsDir = join(ws, 'rp-sessions', sid, 'cards');
    const session = () => ({ ...D.loadSession(sid), sessionId: sid });
    const noLaunch = D.buildStandingText(session(), { loreFile });
    check('launch：没有时明说没有', noLaunch.includes('【开局文件】本会话没有'), true);
    check('launch：没有时给出「不要找别人的」', noLaunch.includes('不要在别处找别人的 launch 文件'), true);
    // 放一份 launch 文件进去 → 常驻段直接给路径
    mkdirSync(cardsDir, { recursive: true });
    writeFileSync(join(cardsDir, '某种卡.launch.md'), '# 开局引导\n\n选定开场：第一幕\n');
    const withLaunch = D.buildStandingText(session(), { loreFile });
    check('launch：有给出绝对路径', withLaunch.includes(join(cardsDir, '某种卡.launch.md')), true);
    check('launch：不再说「本会话没有」', withLaunch.includes('【开局文件】本会话没有'), false);
    check('launch：明确说不要再 glob 找它', withLaunch.includes('不要再 glob 找它'), true);
    // **只认本会话自己的 cards 目录**：别处的 launch 文件不该被列进来
    const otherDir = join(ws, 'rp-sessions', '另一个会话', 'cards');
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(join(otherDir, '别人的卡.launch.md'), '# 别人的开局\n');
    const still = D.buildStandingText(session(), { loreFile });
    check('launch：不会把别的会话的 launch 列进来', still.includes('别人的卡.launch.md'), false);
    check('launch：helper 只扫本会话目录', D.listLaunchFiles(loreFile).length, 1);
  }

  // ⑤ 资源库内容去重：同字节不再存第二份
  {
    const sid = crypto.randomUUID();
    const ws = join(TEST_HOME, 'ws-asset-dedup');
    mkdirSync(ws, { recursive: true });
    D.setSessionCwd(sid, ws);
    const bytesA = Buffer.from('PNG-A-'.repeat(40));
    const bytesB = Buffer.from('PNG-B-'.repeat(40));
    const one = await D.archiveAsset(sid, { bytes: bytesA, kind: 'scene', ext: 'png', label: '甲场景', tags: '甲' });
    check('去重：第一次正常入库', one.deduped, undefined);
    const again = await D.archiveAsset(sid, { bytes: bytesA, kind: 'scene', ext: 'png', label: '甲场景（第二次）', tags: '乙' });
    check('去重：同字节第二次不新增条目', D.loadAssets(sid).assets.length, 1);
    check('去重：返回的是已有那条（同一个 id）', again.id, one.id);
    check('去重：标记 deduped', again.deduped, true);
    check('去重：新标签并进已有那条', (again.tags ?? []).slice().sort().join(','), '乙,甲');
    check('去重：磁盘上只有一份文件', readdirSync(join(ws, 'rp-sessions', sid, 'assets', 'scenes')).length, 1);
    // ⚠️ **同一份字节、换一个 kind 再收，也还是同一张图** —— 这是「内容优先查重」那条真 bug 的
    // 回归闸门：旧实现按 `kind + 字节数` 查重，于是同一张图先当 scene 收一次、再被
    // `rp_assets(action:"import", kind:"item")` 收一次就会存成两份（图墙里看着是两张，实际同图）。
    // 现在「字节相同就是同一张」，与调用方这次报的 kind 无关。
    const crossKind = await D.archiveAsset(sid, { bytes: bytesA, kind: 'portrait', ext: 'png', label: '同一张但算立绘' });
    check('去重：同字节换 kind 也不新增条目', D.loadAssets(sid).assets.length, 1);
    check('去重：换 kind 时返回已有那条', crossKind.id, one.id);
    check('去重：换 kind 也标 deduped', crossKind.deduped, true);
    // 原来那条已经明确是 scene（不是兜底的 other）→ 不被后来的 portrait 改掉
    check('去重：不因后来的 kind 改掉原分类', crossKind.kind, 'scene');
    // 「不同字节」仍然各占一条：字节不同就是不同的图
    await D.archiveAsset(sid, { bytes: bytesB, kind: 'scene', ext: 'png', label: '乙场景' });
    check('去重：字节不同照常新增', D.loadAssets(sid).assets.length, 2);
    check('去重：索引里记了 sha256', Boolean(D.loadAssets(sid).assets[0].sha256), true);
    // **并发**归档同一张图也只能留一条（查重必须在写锁里，锁外查会双双通过）
    const sid2 = crypto.randomUUID();
    const ws2 = join(TEST_HOME, 'ws-asset-dedup-concurrent');
    mkdirSync(ws2, { recursive: true });
    D.setSessionCwd(sid2, ws2);
    await Promise.all(Array.from({ length: 8 }, () => D.archiveAsset(sid2, { bytes: bytesA, kind: 'scene', ext: 'png', label: '并发同图' })));
    check('去重：8 个并发归档同一张图只留一条', D.loadAssets(sid2).assets.length, 1);
  }
}

// ── P0：队伍局部更新（修「照文档用就会丢数据」）────────────────────────────
// 这是本轮最重要的一条。改动前实测：party 里两人，按工具说明「只列你要更新的人」提交
// `[{character:'祁俊', conditions:''}]` 之后 —— 祝婉宁整行消失，祁俊自己的 status 与 inventory
// 也没了。文档承诺的是局部更新，实现是整组替换，两边不一致且失败是静默的。
{
  const D = mod.__debug;
  const two = () => D.applyStateUpdates(D.normalizeState({}), {
    party: [
      { character: '祁俊', status: '警戒', inventory: '腰刀、短枪', conditions: '左臂擦伤' },
      { character: '祝婉宁', status: '疲惫', inventory: '药箱' },
    ],
  });
  const names = (st) => (st.party ?? []).map((r) => r.character).join(',');
  const row = (st, name) => (st.party ?? []).find((r) => r.character === name) ?? {};

  // ① 核心场景：只提交一个字段的变化
  const hurt = D.applyStateUpdates(two(), { party: [{ character: '祁俊', conditions: '' }] });
  check('P0：局部更新不动队友', names(hurt), '祁俊,祝婉宁');
  check('P0：局部更新不动同一行的其它字段', row(hurt, '祁俊').inventory, '腰刀、短枪');
  check('P0：传空串清掉那个字段', row(hurt, '祁俊').conditions, undefined);
  check('P0：队友那一行完全没动', JSON.stringify(row(hurt, '祝婉宁')), JSON.stringify({ character: '祝婉宁', status: '疲惫', inventory: '药箱' }));

  // ② 改值 / 追加新人 / 顺序
  const changed = D.applyStateUpdates(two(), { party: [{ character: '祁俊', status: '重伤' }, { character: '新同伴', status: '警戒' }] });
  check('P0：改值不动其它字段', row(changed, '祁俊').inventory, '腰刀、短枪');
  check('P0：新人在末尾追加', names(changed), '祁俊,祝婉宁,新同伴');
  check('P0：已有成员的顺序不变', names(two()), '祁俊,祝婉宁');

  // ③ party_remove：不用重发全组就能删人
  const removed = D.applyStateUpdates(two(), { partyRemove: '祝婉宁' });
  check('P0：party_remove 只删指定的人', names(removed), '祁俊');
  check('P0：party_remove 也吃逗号串', names(D.applyStateUpdates(two(), { partyRemove: '祝婉宁,祁俊' })), '');
  check('P0：party_remove 与 party 可同时用',
    names(D.applyStateUpdates(two(), { partyRemove: '祝婉宁', party: [{ character: '祁俊', status: '重伤' }] })), '祁俊');

  // ④ 空数组仍然清空（文档承诺过，不能因为改成 merge 就失效）
  check('P0：party:[] 两种模式下都清空', names(D.applyStateUpdates(two(), { party: [] })), '');
  check('P0：party:[] + replace 也清空', names(D.applyStateUpdates(two(), { party: [], partyMode: 'replace' })), '');

  // ⑤ replace：想删人/重排顺序时的显式出口
  const rep = D.applyStateUpdates(two(), { party: [{ character: '祝婉宁', status: '精神' }], partyMode: 'replace' });
  check('P0：replace 整组替换（没列的人真的没了）', names(rep), '祝婉宁');
  check('P0：replace 时该行只留传了的字段', JSON.stringify(row(rep, '祝婉宁')), JSON.stringify({ character: '祝婉宁', status: '精神' }));

  // ⑥ 错误路径要明确，不能猜
  const badMode = (() => { try { D.applyStateUpdates(two(), { party: [{ character: 'x' }], partyMode: 'patch' }); return ''; } catch (e) { return String(e.message); } })();
  check('P0：partyMode 非法时报错并给出可选值', badMode.includes('只能是 "merge"'), true);
  const noName = (() => { try { D.applyStateUpdates(two(), { party: [{ status: '全员警戒' }] }); return ''; } catch (e) { return String(e.message); } })();
  check('P0：merge 时缺 character 报错（而不是塞一行删不掉的匿名记录）', noName.includes('每项都要有 character'), true);
  check('P0：replace 时缺 character 不报错（整组替换不需要按名字定位）',
    D.applyStateUpdates(two(), { party: [{ status: '全员警戒' }], partyMode: 'replace' }).party.length, 1);

  // ⑦ 走工具入口（参数映射：party_mode / party_remove → patch.partyMode / patch.partyRemove）
  {
    const sid = crypto.randomUUID();
    const ws = join(TEST_HOME, 'ws-p0-party');
    mkdirSync(ws, { recursive: true });
    D.setSessionCwd(sid, ws);
    const exec = { agent: { id: sid } };
    const rpState = tools.get('rp_state');
    await rpState.execute({ action: 'set', party: two().party }, exec);
    await rpState.execute({ action: 'set', party: [{ character: '祁俊', conditions: '' }] }, exec);
    const after = D.loadSession(sid).state;
    check('P0：经工具调用也是局部更新', (after.party ?? []).length, 2);
    check('P0：经工具调用清字段也生效', after.party[0].conditions, undefined);
    await rpState.execute({ action: 'set', party_remove: '祝婉宁' }, exec);
    check('P0：经工具调用 party_remove 生效', (D.loadSession(sid).state.party ?? []).length, 1);
    // 工具说明必须与实现一致 —— 这条是本次修 bug 的根因，钉住它。
    // 注意 `defineTool` 暴露的 `parameters` 是 **JSON schema 形态**（properties 里才是各参数）。
    const partyDesc = String(rpState.parameters?.properties?.party?.description ?? '');
    check('P0：工具说明写明是局部更新', partyDesc.includes('默认是局部更新'), true);
    check('P0：工具说明写明不要漏掉队友', partyDesc.includes('更不要把队友漏掉'), true);
    check('P0：工具说明写明空数组清空', partyDesc.includes('清空全部'), true);
    check('P0：注册了 party_mode 与 party_remove 两个参数',
      Boolean(rpState.parameters?.properties?.party_mode) && Boolean(rpState.parameters?.properties?.party_remove), true);
  }
}

// ── P1：会话包（导出 / 快照 / 列表 / 导入）──────────────────────────────────
// 会话配置在全局数据目录、世界书与资源图在**工作区** —— 两处分离，手工备份必漏一半。
// 这里把「一个会话能带走的一切」打成一个 STORE-only zip，并验四件事：
// 包是完整的、快照会修剪、导入默认不覆盖、覆盖前自动兜底。
{
  const D = mod.__debug;
  const bundleMod = await import(pathToFileURL(join(here, '..', 'lib', 'session-bundle.js')).href);
  const zipMod = await import(pathToFileURL(join(here, '..', 'lib', 'zip.js')).href);

  // ① zip 本身：往返 + 拒绝（这一层是 P1 的地基，先钉死）
  {
    const files = [
      { name: 'a.txt', data: Buffer.from('hello') },
      { name: 'dir/b.bin', data: Buffer.from([0, 1, 2, 255]) },
      { name: '中文名.md', data: Buffer.from('中文内容', 'utf8') },
    ];
    const zip = zipMod.writeZip(files, new Date('2026-09-13T01:00:00Z'));
    const back = zipMod.readZip(zip);
    check('会话包：zip 条目数与顺序', back.map((e) => e.name).join('|'), 'a.txt|dir/b.bin|中文名.md');
    check('会话包：zip 字节一致', back.every((e, i) => e.data.equals(files[i].data)), true);
    check('会话包：中文内容不乱码', back[2].data.toString('utf8'), '中文内容');
    check('会话包：空 zip 也能读', zipMod.readZip(zipMod.writeZip([])).length, 0);
    // 数据被改 → CRC 必须报错（本地头 30 + 文件名 5 = 数据从 35 开始）
    const bad = Buffer.from(zipMod.writeZip([{ name: 'a.txt', data: Buffer.from('payload') }]));
    bad[37] ^= 0xff;
    check('会话包：内容被改时报 CRC 不符', (() => { try { zipMod.readZip(bad); return ''; } catch (e) { return String(e.message); } })().includes('校验和不符'), true);
    check('会话包：截断的包被拒', (() => { try { zipMod.readZip(zip.subarray(0, 40)); return ''; } catch (e) { return String(e.message); } })().includes('中央目录'), true);
    check('会话包：不是 zip 被拒', (() => { try { zipMod.readZip(Buffer.from('hello')); return ''; } catch (e) { return String(e.message); } })().includes('不是有效的 zip'), true);
    // 路径穿越（zip-slip）：写与读两侧都要挡
    check('会话包：safeEntryName 拒 ../', zipMod.safeEntryName('../x.txt'), null);
    check('会话包：safeEntryName 拒绝对路径', zipMod.safeEntryName('/abs.txt'), null);
    check('会话包：safeEntryName 拒盘符', zipMod.safeEntryName('C:\\win.txt'), null);
    check('会话包：safeEntryName 规范化多余斜杠', zipMod.safeEntryName('a//b'), 'a/b');
    check('会话包：写越界名直接报错', (() => { try { zipMod.writeZip([{ name: '../e', data: Buffer.from('x') }]); return ''; } catch (e) { return String(e.message); } })().includes('条目名不合法'), true);
  }

  // ② 打包：装什么、不装什么
  const sid = crypto.randomUUID();
  const ws = join(TEST_HOME, 'ws-bundle');
  mkdirSync(ws, { recursive: true });
  D.setSessionCwd(sid, ws);
  const dir = join(ws, 'rp-sessions', sid);
  mkdirSync(join(dir, 'assets', 'scenes'), { recursive: true });
  mkdirSync(join(dir, 'cards'), { recursive: true });
  mkdirSync(join(dir, 'snapshots'), { recursive: true });
  writeFileSync(join(dir, 'rp-worldbook.md'), '# 世界书\n\n## 世界总纲\nconstant\n\n测试世界。\n');
  writeFileSync(join(dir, 'assets.json'), JSON.stringify({ version: 1, assets: [] }));
  writeFileSync(join(dir, 'assets', 'scenes', 's1.png'), Buffer.from([9, 8, 7, 6]));
  writeFileSync(join(dir, 'cards', '某卡.launch.md'), '# 开局引导\n');
  // 两个「不是我们放的」文件：ASCII 一个、中文名一个（中文名那个还顺带钉住 rmSync 的静默失败）
  writeFileSync(join(dir, 'snapshots', 'user-backup.zip'), Buffer.from('不该被当成快照'));
  writeFileSync(join(dir, 'snapshots', '用户自己的.zip'), Buffer.from('不该被当成快照'));
  writeFileSync(join(dir, '用户自己放的东西.txt'), '不该进包');
  await callPost('/rp-tools/session', {
    sessionId: sid, world: '测试世界', characters: [{ name: '祁俊', appearance: '白衣长剑' }],
    state: { scene: '雨夜客栈', party: [{ character: '祁俊', inventory: '腰刀' }] },
  });
  {
    const exported = await callGetRaw(`/rp-tools/export?sessionId=${sid}`);
    check('会话包：导出返回 200', exported.status, 200);
    const names = zipMod.readZip(exported.bytes).map((e) => e.name);
    check('会话包：含会话配置', names.includes('session.json'), true);
    check('会话包：含世界书', names.includes('rp-worldbook.md'), true);
    check('会话包：含资源库图', names.includes('assets/scenes/s1.png'), true);
    check('会话包：含导入卡产物', names.includes('cards/某卡.launch.md'), true);
    check('会话包：**不含** snapshots（套娃没意义）', names.some((n) => n.startsWith('snapshots/')), false);
    check('会话包：**不含**用户自己放的文件', names.includes('用户自己放的东西.txt'), false);
    const parsed = bundleMod.parseBundle(exported.bytes);
    check('会话包：清单格式与版本', parsed.manifest.format, 'dsh-rp-tools/session-bundle');
    check('会话包：清单记了原会话 id', parsed.sessionId, sid);
    check('会话包：配置里的角色带过去了', parsed.sessionConfig.characters[0].name, '祁俊');
    check('会话包：导出缺 sessionId 时 400', (await callGetRaw('/rp-tools/export')).status, 400);
    check('会话包：导出只认 GET', (await callPost('/rp-tools/export', { sessionId: sid })).status, 405);
  }

  // ③ 快照：落盘 + 只留最近 5 个
  {
    const made = await callPost('/rp-tools/snapshot', { sessionId: sid });
    check('会话包：快照 200', made.status, 200);
    check('会话包：快照落到 snapshots/', String(made.json.file).includes('snapshots'), true);
    check('会话包：快照文件真的存在', existsSync(made.json.file), true);
    check('会话包：快照是合法的会话包', bundleMod.parseBundle(readFileSync(made.json.file)).sessionId, sid);
    for (let i = 0; i < 6; i += 1) {
      // 时间戳精度到毫秒，连着打会撞名 —— 撞了就覆盖，所以这里用最小的间隔错开
      await new Promise((r) => setTimeout(r, 5));
      const each = await callPost('/rp-tools/snapshot', { sessionId: sid });
      // **每一步都不能超**：修剪要是漏了一次，后面永远补不回来（只留最近 N 个是硬约束）
      check(`会话包：第 ${i + 2} 次快照后仍不超过 5 个`, (each.json.items ?? []).length <= 5, true);
      check(`会话包：第 ${i + 2} 次快照没有删不掉的`, (each.json.failed ?? []).length, 0);
    }
    const list = await callGet('/rp-tools/snapshots', `?sessionId=${sid}`);
    check('会话包：快照列表 200', list.status, 200);
    check('会话包：快照只保留最近 5 个', list.json.total, 5);
    check('会话包：保留数写在返回里（面板要显示）', list.json.keep, 5);
    check('会话包：磁盘上的 snapshot-*.zip 也只剩 5 个',
      readdirSync(join(dir, 'snapshots')).filter((n) => n.startsWith('snapshot-')).length, 5);
    // 用户自己放进 snapshots/ 的包：既不算快照、也**绝不能**被修剪删掉
    check('会话包：用户自己的包不算快照', list.json.items.some((it) => it.name === 'user-backup.zip'), false);
    check('会话包：ASCII 的用户包没被删', existsSync(join(dir, 'snapshots', 'user-backup.zip')), true);
    check('会话包：中文名的用户包没被删', existsSync(join(dir, 'snapshots', '用户自己的.zip')), true);
    check('会话包：新的排在前面', String(list.json.items[0].name) > String(list.json.items[4].name), true);
    check('会话包：快照列表缺 sessionId 时 400', (await callGet('/rp-tools/snapshots')).status, 400);
    check('会话包：快照要 POST', (await callGet('/rp-tools/snapshot', `?sessionId=${sid}`)).status, 405);
  }

  // ③b rmSync 对中文名静默失败 —— 这是本机实测的坑，插件所有删除都必须走「验证过的删除」
  {
    const probe = join(TEST_HOME, 'ws-rm-verified');
    mkdirSync(probe, { recursive: true });
    const cjk = join(probe, '中文文件.txt');
    writeFileSync(cjk, 'x');
    check('删除：中文名文件被真正删掉（rmSync 会静默失败）', D.removeFileVerified(cjk), true);
    check('删除：确认磁盘上确实没了', existsSync(cjk), false);
    const ascii = join(probe, 'plain.txt');
    writeFileSync(ascii, 'x');
    check('删除：ASCII 名也正常', D.removeFileVerified(ascii), true);
    check('删除：不存在的文件算已删除（幂等）', D.removeFileVerified(join(probe, 'never.txt')), true);
  }

  // ④ 导入：默认不覆盖 → 显式覆盖 → 自动兜底快照
  {
    const target = crypto.randomUUID();
    const ws2 = join(TEST_HOME, 'ws-bundle-target');
    mkdirSync(ws2, { recursive: true });
    D.setSessionCwd(target, ws2);
    const targetDir = join(ws2, 'rp-sessions', target);
    mkdirSync(targetDir, { recursive: true });
    // 把包放进**会话目录**（接口只允许导这里面的包）
    const exported = await callGetRaw(`/rp-tools/export?sessionId=${sid}`);
    writeFileSync(join(targetDir, 'backup.zip'), exported.bytes);

    // 目标会话先放点东西，测「默认不覆盖」
    await callPost('/rp-tools/session', { sessionId: target, world: '原有世界', characters: [{ name: '原有角色' }] });
    const refused = await callPost('/rp-tools/import', { sessionId: target, path: 'backup.zip' });
    check('会话包：目标有内容时默认拒绝覆盖（409）', refused.status, 409);
    check('会话包：拒绝时说明要传 overwrite', refused.json.needsOverwrite, true);
    check('会话包：拒绝时不动目标的世界设定',
      D.loadSession(target).world, '原有世界');

    const done = await callPost('/rp-tools/import', { sessionId: target, path: 'backup.zip', overwrite: true });
    check('会话包：显式覆盖后 200', done.status, 200);
    check('会话包：覆盖前自动拍了快照', String(done.json.snapshot ?? '').startsWith('snapshot-'), true);
    check('会话包：还原了文件', done.json.files >= 3, true);
    check('会话包：世界书还原到目标目录', existsSync(join(targetDir, 'rp-worldbook.md')), true);
    check('会话包：图片字节还原一致',
      readFileSync(join(targetDir, 'assets', 'scenes', 's1.png')).equals(Buffer.from([9, 8, 7, 6])), true);
    check('会话包：配置被覆盖成包里的', D.loadSession(target).world, '测试世界');
    check('会话包：配置里的 sessionId 改成目标 id（自我指涉字段）', D.loadSession(target).sessionId, target);
    check('会话包：包里的相对路径不用改写', readFileSync(join(targetDir, 'assets.json'), 'utf8').includes('"version"'), true);

    // 空目标：不该要 overwrite
    const fresh = crypto.randomUUID();
    const ws3 = join(TEST_HOME, 'ws-bundle-fresh');
    mkdirSync(ws3, { recursive: true });
    D.setSessionCwd(fresh, ws3);
    mkdirSync(join(ws3, 'rp-sessions', fresh), { recursive: true });
    writeFileSync(join(ws3, 'rp-sessions', fresh, 'backup.zip'), exported.bytes);
    const direct = await callPost('/rp-tools/import', { sessionId: fresh, path: 'backup.zip' });
    check('会话包：空会话直接导入，不需要 overwrite', direct.status, 200);
    check('会话包：空会话导入不拍无意义的快照', direct.json.snapshot, null);

    // 拒绝路径
    check('会话包：不允许导会话目录之外的文件',
      (await callPost('/rp-tools/import', { sessionId: fresh, path: '../../../etc/hosts' })).status, 400);
    check('会话包：找不到的包 404',
      (await callPost('/rp-tools/import', { sessionId: fresh, path: '没有这个.zip' })).status, 404);
    check('会话包：dataUrl 只认 zip',
      (await callPost('/rp-tools/import', { sessionId: fresh, dataUrl: 'data:image/png;base64,QUJD' })).status, 400);
    check('会话包：什么都不给 400',
      (await callPost('/rp-tools/import', { sessionId: fresh })).status, 400);
    check('会话包：损坏的包被拒（不是静默成功）',
      (await callPost('/rp-tools/import', { sessionId: fresh, dataUrl: `data:application/zip;base64,${Buffer.from('这不是zip').toString('base64')}` })).status, 400);
    check('会话包：跨源导入被拒',
      (await callPost('/rp-tools/import', { sessionId: fresh, path: 'backup.zip' }, 'http://evil.example', '127.0.0.1:3080')).status, 403);

    // data URL 那条也要能走通（面板选文件就是这条路）
    const viaData = crypto.randomUUID();
    const ws4 = join(TEST_HOME, 'ws-bundle-data');
    mkdirSync(ws4, { recursive: true });
    D.setSessionCwd(viaData, ws4);
    const okData = await callPost('/rp-tools/import', {
      sessionId: viaData, dataUrl: `data:application/zip;base64,${exported.bytes.toString('base64')}`,
    });
    check('会话包：dataUrl 导入成功', okData.status, 200);
    check('会话包：dataUrl 导入后世界书到位', existsSync(join(ws4, 'rp-sessions', viaData, 'rp-worldbook.md')), true);
  }

  // ⑤ 还原层自己也要挡越界名（第二道锁，不依赖 parseBundle）
  {
    const targetDir = join(TEST_HOME, 'ws-bundle-restore');
    mkdirSync(targetDir, { recursive: true });
    const bad = (() => { try { bundleMod.restoreBundleEntries([{ name: '../evil.txt', data: Buffer.from('x') }], targetDir); return ''; } catch (e) { return String(e.message); } })();
    check('会话包：还原层拒绝越界条目名', bad.includes('条目名不合法'), true);
    check('会话包：越界文件没被写出去', existsSync(join(TEST_HOME, 'evil.txt')), false);
    check('会话包：还原层会跳过 session.json（配置另写）',
      bundleMod.restoreBundleEntries([{ name: 'session.json', data: Buffer.from('{}') }], targetDir).written, 0);
  }
}

// ── 轻量 DM 地图：一行摘要 + 格式诊断 + 进备份 ─────────────────────────────
// 设计依据见 docs/STATUS.md 1.14.1。两条纪律来自实测踩坑：
//   ① 文件坏了 ≠ 还没建（否则 DM 会覆盖一份本可救回的文件）
//   ② 坏数据不渲染摘要（拿 node="nope" 画出一行正常地图比什么都不显示更危险）
{
  const D = mod.__debug;
  const MAPMOD = await import(pathToFileURL(join(here, '..', 'lib', 'rp-map.js')).href);
  const sid = crypto.randomUUID();
  const ws = join(TEST_HOME, 'ws-map');
  mkdirSync(ws, { recursive: true });
  D.setSessionCwd(sid, ws);
  const dir = join(ws, 'rp-sessions', sid);
  mkdirSync(dir, { recursive: true });
  const loreFile = join(dir, 'rp-worldbook.md');
  const MAP = {
    version: 1, id: 'old_inn', name: '旧钟旅店', start: 'hall',
    nodes: [
      { id: 'hall', label: '大堂', public: true },
      { id: 'kitchen', label: '厨房', public: true },
      { id: 'rooms', label: '二楼客房', public: true },
      { id: 'cellar', label: '地窖', public: false },
      { id: 'yard', label: '后院', public: true },
    ],
    edges: [
      { id: 'hall_kitchen', a: 'hall', b: 'kitchen', label: '木门', state: 'open' },
      { id: 'hall_rooms', a: 'hall', b: 'rooms', label: '楼梯', state: 'open' },
      { id: 'hall_cellar', a: 'hall', b: 'cellar', label: '暗门', state: 'locked' },
      { id: 'kitchen_yard', a: 'kitchen', b: 'yard', label: '后门', state: 'open' },
    ],
  };
  const writeMap = () => writeFileSync(join(dir, 'rp-map.json'), `${JSON.stringify(MAP, null, 1)}\n`);
  const writeState = (s) => writeFileSync(join(dir, 'rp-map-state.json'), typeof s === 'string' ? s : `${JSON.stringify(s, null, 1)}\n`);
  const ctx = () => D.buildTurnContext({ ...D.loadSession(sid), sessionId: sid }, '', { sessionId: sid, turn: 1, loreFile });
  const mapLines = (text) => text.split('\n').filter((l) => l.startsWith('【地图】'));

  // ① 没有地图 → 一个字都不注入（绝大多数会话不该被地图打扰）
  check('地图：没有地图时不注入任何内容', D.mapContextForDir(dir), '');
  check('地图：没有地图时 turn context 里也没有地图行', mapLines(ctx()).length, 0);

  // ② 有图、状态还没建 → 给出**可直接抄**的初始化 JSON
  writeMap();
  const hint = D.mapContextForDir(dir);
  check('地图：未初始化时明确说「还没建状态文件」', hint.includes('还没有 rp-map-state.json'), true);
  check('地图：未初始化时给出建议 JSON', hint.includes('"tokens":{"party":"hall"}'), true);
  check('地图：建议里把 public 节点作为初始已揭示', hint.includes('"revealed":["hall","kitchen","rooms","yard"]'), true);

  // ③ 正常：一行说清「我在哪 / 能去哪 / 哪条不通」
  writeState({ map_id: 'old_inn', node: 'hall', revealed: ['hall', 'kitchen', 'rooms'], edges: {}, tokens: { party: 'hall', innkeeper: 'hall' } });
  const atHall = D.mapContextForDir(dir);
  check('地图：报当前位置', atHall.includes('旧钟旅店·大堂'), true);
  check('地图：报已揭示数', atHall.includes('已揭示 3/5'), true);
  check('地图：报可走方向（带路名）', atHall.includes('可走：厨房（木门）、二楼客房（楼梯）'), true);
  check('地图：报**本端**不通的路', atHall.includes('此端不通：🔒地窖（暗门）'), true);
  check('地图：报标记位置', atHall.includes('队伍@大堂'), true);
  check('地图：一行装完（不换行）', atHall.split('\n').length, 1);
  check('地图：长度可控（<160 字）', atHall.length < 160, true);

  // ④ 站在厨房时不该报「大堂的暗门锁着」——那是噪音
  writeState({ map_id: 'old_inn', node: 'kitchen', revealed: ['hall', 'kitchen', 'rooms'], edges: {}, tokens: { party: 'kitchen' } });
  const atKitchen = D.mapContextForDir(dir);
  check('地图：只报当前节点这一端不通的路', atKitchen.includes('此端不通'), false);

  // ⑤ 未揭示的目标不算「可走」
  writeState({ map_id: 'old_inn', node: 'kitchen', revealed: ['hall', 'kitchen'], edges: {}, tokens: { party: 'kitchen' } });
  check('地图：未揭示的后院不算可走', D.mapContextForDir(dir).includes('后院'), false);
  check('地图：walkableFrom 也排除未揭示', MAPMOD.walkableFrom(MAP, { node: 'kitchen', revealed: ['hall', 'kitchen'] }).join(','), 'hall');
  check('地图：锁着的边不算可走', MAPMOD.walkableFrom(MAP, { node: 'hall', revealed: ['hall', 'cellar'] }).includes('cellar'), false);
  check('地图：开锁后就算可走', MAPMOD.walkableFrom(MAP, { node: 'hall', revealed: ['hall', 'cellar'], edges: { hall_cellar: 'open' } }).includes('cellar'), true);

  // ⑥ 文件坏了 ≠ 还没建（这条差点写错：两种情况的 state 都是 null）
  writeState('{ 坏掉的 json');
  const broken = D.mapContextForDir(dir);
  check('地图：状态文件坏掉时报 JSON 错误', broken.includes('不是合法 JSON'), true);
  check('地图：坏掉时**不**说「还没初始化」（否则 DM 会覆盖它）', broken.includes('还没初始化'), false);
  writeMap();
  writeFileSync(join(dir, 'rp-map.json'), '{ 也坏掉');
  check('地图：静态图坏掉时也不静默成「没有地图」', D.mapContextForDir(dir).includes('rp-map.json 不是合法 JSON'), true);

  // ⑦ 状态与静态图不自洽 → **不渲染基于垃圾的摘要**
  writeMap();
  writeState({ map_id: 'other_map', node: 'nope', revealed: ['hall', 'ghost'], edges: { no_such_edge: 'open', hall_rooms: 'nailed' }, tokens: { party: 'nowhere' } });
  const bad = D.mapContextForDir(dir);
  check('地图：node 不认识时不画摘要（只报警）', bad.includes('旧钟旅店·'), false);
  check('地图：报 map_id 不一致', bad.includes('map_id="other_map"'), true);
  check('地图：报 node 不认识', bad.includes('node="nope"'), true);
  check('地图：报 revealed 里的幽灵节点', bad.includes('revealed 里的 "ghost"'), true);
  check('地图：报不存在的连接', bad.includes('edges 里的 "no_such_edge"'), true);
  check('地图：报不认识的边状态', bad.includes('"nailed"'), true);
  check('地图：报不认识的标记位置', bad.includes('tokens["party"]="nowhere"'), true);

  // ⑧ 小毛病（只缺 tokens.party）仍给摘要 + 一条警告
  writeState({ map_id: 'old_inn', node: 'hall', revealed: ['hall', 'kitchen'], edges: {} });
  const minor = D.mapContextForDir(dir);
  check('地图：小毛病时仍给摘要', minor.includes('旧钟旅店·大堂'), true);
  check('地图：小毛病时附一条警告', minor.includes('tokens 里缺 party'), true);

  // ⑨ 静态图校验：引用完整性
  check('地图校验：id 非法', MAPMOD.validateMap({ id: '带中文', nodes: [{ id: 'a', label: 'A' }] })[0].includes('不合法'), true);
  check('地图校验：节点 id 重复', MAPMOD.validateMap({ id: 'm', nodes: [{ id: 'a' }, { id: 'a' }] }).some((p) => p.includes('重复')), true);
  check('地图校验：边的端点不存在', MAPMOD.validateMap({ id: 'm', nodes: [{ id: 'a' }], edges: [{ id: 'e', a: 'a', b: 'zz' }] }).some((p) => p.includes('b="zz"')), true);
  check('地图校验：边状态不认识', MAPMOD.validateMap({ id: 'm', nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ id: 'e', a: 'a', b: 'b', state: '半开' }] }).some((p) => p.includes('半开')), true);
  check('地图校验：start 不在 nodes 里', MAPMOD.validateMap({ id: 'm', start: 'zz', nodes: [{ id: 'a' }] }).some((p) => p.includes('start="zz"')), true);
  check('地图校验：没有 nodes', MAPMOD.validateMap({ id: 'm' }).some((p) => p.includes('没有 nodes')), true);
  check('地图校验：public 与 revealed 的关系**不报**（合法用法）',
    MAPMOD.validateMap({ id: 'm', start: 'a', nodes: [{ id: 'a', public: true }, { id: 'b', public: true }], edges: [] }).length, 0);

  // ⑩ 注入接线：standing 给文件指针、turn 给摘要
  writeMap();
  writeState({ map_id: 'old_inn', node: 'hall', revealed: ['hall', 'kitchen'], edges: {}, tokens: { party: 'hall' } });
  const standing = D.buildStandingText({ ...D.loadSession(sid), sessionId: sid }, { loreFile });
  check('地图：standing 里给出静态图路径', standing.includes(join(dir, 'rp-map.json')), true);
  check('地图：standing 里给出状态文件路径', standing.includes(join(dir, 'rp-map-state.json')), true);
  check('地图：standing 里说明「不要写回静态图」', standing.includes('不要写回静态图'), true);
  check('地图：standing 里说明位置每轮自动注入', standing.includes('每轮自动注入'), true);
  check('地图：turn context 里排在状态之后', (() => {
    const s2 = { ...D.loadSession(sid), sessionId: sid, state: { scene: '旧钟旅店大堂' } };
    const text = D.buildTurnContext(s2, '', { sessionId: sid, turn: 1, loreFile });
    return text.indexOf('本场当前状态') < text.indexOf('【地图】');
  })(), true);
  // 没有地图的会话，standing 里不该冒出【地图】
  {
    const sid2 = crypto.randomUUID();
    const ws2 = join(TEST_HOME, 'ws-map-none');
    mkdirSync(ws2, { recursive: true });
    D.setSessionCwd(sid2, ws2);
    const lore2 = join(ws2, 'rp-sessions', sid2, 'rp-worldbook.md');
    const st2 = D.buildStandingText({ ...D.loadSession(sid2), sessionId: sid2 }, { loreFile: lore2 });
    check('地图：没有地图的会话，standing 里没有【地图】', st2.includes('【地图】'), false);
    check('地图：没有地图的会话，turn context 里没有【地图】',
      D.buildTurnContext({ ...D.loadSession(sid2), sessionId: sid2 }, '', { sessionId: sid2, turn: 1, loreFile: lore2 }).includes('【地图】'), false);
  }

  // ⑪ 进备份：两个文件都要进包、也要能还原
  {
    const bundleMod = await import(pathToFileURL(join(here, '..', 'lib', 'session-bundle.js')).href);
    const built = bundleMod.buildBundle({ sessionId: sid, sessionDir: dir, sessionConfig: { sessionId: sid }, now: new Date() });
    check('地图：rp-map.json 进备份', built.manifest.files.some((f) => f.name === 'rp-map.json'), true);
    check('地图：rp-map-state.json 进备份', built.manifest.files.some((f) => f.name === 'rp-map-state.json'), true);
    const parsed = bundleMod.parseBundle(built.buffer);
    const dir2 = join(ws, 'rp-sessions', 'restored');
    bundleMod.restoreBundleEntries(parsed.entries, dir2);
    check('地图：还原后静态图在位', existsSync(join(dir2, 'rp-map.json')), true);
    check('地图：还原后状态文件在位', existsSync(join(dir2, 'rp-map-state.json')), true);
    check('地图：还原内容一致', D.mapContextForDir(dir2), D.mapContextForDir(dir));
  }
}

// agent/created：宿主侧能否直接识别预设并自动登记
const onCreated = (payload) => emit('agent/created', payload);
if (onCreated) {
  onCreated({ agent: { id: `session-${VIA_PRESET}`, options: { preset: 'dm' }, session: { id: VIA_PRESET } } });
  check('agent/created 自动识别 dm 预设', (await callGet('/rp-tools/session', `?sessionId=${VIA_PRESET}`)).json.isDm, true);
  // 非 dm 预设不该被误登记
  onCreated({ agent: { id: `session-${NOT_DM}`, options: { preset: 'standard' } } });
  check('agent/created 不误登记非 dm', (await callGet('/rp-tools/session', `?sessionId=${NOT_DM}`)).json.isDm, false);
} else { console.log('WARN: 未捕获 agent/created 监听'); fail++; }

// ── fork 会话继承 RP 配置 ────────────────────────────────────────────────
// 依据 DSH 给的会话头：parentSession（fork 来源）+ isSeeded（含继承前缀）。
const onSessionCreated = (payload) => emit('session/created', payload);
if (onSessionCreated) {
  const PARENT = crypto.randomUUID();
  const CHILD = crypto.randomUUID();
  const NOT_FORK = crypto.randomUUID();
  const CHILD_KEEPS = crypto.randomUUID();
  const CHILD_KEYS = crypto.randomUUID();

  // 父会话：写一份 DM 配置（世界 + 角色卡 + 随机表）
  // ⚠️ `styleNotes`（风格备注）不再解析 —— 本地生图搬走后它没有消费者，
  //    所以这里也不再断言它被继承（送了也只会被忽略，断言它等于断言一个不存在的行为）。
  await callPost('/rp-tools/session', {
    sessionId: PARENT,
    world: '灰烬纪元：诸神陨落后的第三百年',
    campaign: { name: '灰烬纪元', prompt_prefix: 'cinematic lighting' },
    characters: [{ name: '凯尔', appearance: '十七岁少年，凌乱短发，黑色斗篷' }],
    tables: [{ name: '遭遇表', dice: '1d6', entries: ['狼群', '盗匪', '幽灵'] }],
  });
  await callPost('/rp-tools/dm-mark', { sessionId: PARENT, preset: 'dm' });

  // ① 真正的 fork：parentSession 有值 + isSeeded
  onSessionCreated({ id: CHILD, header: { id: CHILD, parentSession: PARENT, isSeeded: true } });
  const child = (await callGet('/rp-tools/session', `?sessionId=${CHILD}`)).json;
  check('fork：世界设定被继承', child.session.world, '灰烬纪元：诸神陨落后的第三百年');
  check('fork：战役名被继承', child.session.campaign?.name, '灰烬纪元');
  check('fork：提示词前缀被继承', child.session.campaign?.prompt_prefix, 'cinematic lighting');
  check('fork：角色卡被继承', child.session.characters?.[0]?.name, '凯尔');
  check('fork：随机表被继承', child.session.tables?.[0]?.entries?.length, 3);
  check('fork：子会话仍是 DM 会话', child.isDm, true);
  check('fork：父子是两份独立数据（改子不影响父）', (await callGet('/rp-tools/session', `?sessionId=${PARENT}`)).json.session.characters?.[0]?.name, '凯尔');

  // ② resume（有 parentSession 但 isSeeded=false）不该被当成 fork
  onSessionCreated({ id: NOT_FORK, header: { id: NOT_FORK, parentSession: PARENT, isSeeded: false } });
  check('非 fork（isSeeded=false）不继承', (await callGet('/rp-tools/session', `?sessionId=${NOT_FORK}`)).json.session.world, '');

  // ③ 没有 parentSession 的普通新会话不受影响
  onSessionCreated({ id: CHILD_KEYS, header: { id: CHILD_KEYS, isSeeded: false } });
  check('普通新会话不继承', (await callGet('/rp-tools/session', `?sessionId=${CHILD_KEYS}`)).json.session.world, '');

  // ④ 子会话已有自己的配置时不覆盖
  await callPost('/rp-tools/session', { sessionId: CHILD_KEEPS, world: '我自己写的世界' });
  onSessionCreated({ id: CHILD_KEEPS, header: { id: CHILD_KEEPS, parentSession: PARENT, isSeeded: true } });
  check('fork：子会话已有配置则不覆盖', (await callGet('/rp-tools/session', `?sessionId=${CHILD_KEEPS}`)).json.session.world, '我自己写的世界');
} else { console.log('WARN: 未捕获 session/created 监听'); fail++; }

// ── 提示词注入（standing）：世界设定必须真的进系统提示词 ────────────────────
{
  // 架构约束：全部 rp_* 工具与提示词注入**只允许**发生在 dm 预设的 agent 作用域。
  check('全局不注册任何模型工具', globalTools.join(',') || '（零个）', '（零个）');
  // 证据链：全局 apply() 那次故意没给 systemPrompt 桩，所以段与通道只可能由 registerRpTools 注册。
  check('注入只由 agent 作用域注册（全局不注册）', promptSections.has('rp:standing'), true);
  check('turn 通道也只由 agent 作用域注册', promptContexts.has('rp:turn'), true);
  // 身份宏：{{user}} 注册成宿主变量（DSH 原生插值），未注册的宏仍然中性化
  check('注册了 {{user}} 宿主变量', promptVars.has('user'), true);
  check('{{user}} 变量返回玩家称呼', promptVars.get('user')?.({}), '玩家');
  const nm = mod.__debug.neutralizeMustache('{{user}} 拉着 {{char}} 的手，还有 {{unknown}}');
  check('{{user}} 原样留给宿主插值', nm.includes('{{user}}'), true);
  check('其它宏仍被中和（不会让装配抛错）', nm.includes('{{char}}') || nm.includes('{{unknown}}'), false);
  check('中文冒号与普通文本不受影响', mod.__debug.neutralizeMustache('他说道：你好').includes('他说道：你好'), true);
  const sec = promptSections.get('rp:standing');
  check('standing 段序为 210（工具说明 100–199 之后）', sec?.order, 210);
  check('未配置时注入固定短文案而非空段', typeof sec?.text === 'string' && sec.text.length > 0, true);

  // 注意：监听器是 async 的，桩必须真的 await —— 否则拿到的是 Promise，
  // 下面读 out?.sections 会静默落成 undefined（这个桩缺陷一度让我误判注入失效）。
  const onAssemble = async (...a) => {
    for (const fn of events.get('system-prompt/assemble') ?? []) return await fn(...a);
    return undefined;
  };
  if (onAssemble) {
    const SID = crypto.randomUUID();
    const SID2 = crypto.randomUUID();
    // 注入按**装配上下文里的 agent** 定位会话；这里让 agent 指向 SID，模拟真实装配。
    onSessionCreated({ id: SID, header: { id: SID } });
    await callPost('/rp-tools/session', {
      sessionId: SID,
      world: '灰烬纪元：诸神陨落后的第三百年，整个世界被永夜笼罩。',
      campaign: { name: '灰烬纪元' },
      characters: [{ name: '凯尔', appearance: '十七岁少年，黑色斗篷' }],
      tables: [{ name: '遭遇表', dice: '1d6', entries: ['狼群'] }],
    });

    // 模拟宿主装配：初始 assembly 里只有我们注册的那段占位短文案
    // 模拟宿主装配：初始 assembly 里只有我们注册的那段占位短文案
    const assembly = mkAssembly([
      { name: 'rp:standing', text: sec.text },
      { name: 'other', text: 'x' },
    ], SID);
    const base = nextOf(assembly);
    const out = await onAssemble(assembly, assembly.context, base);
    const mine = (out?.sections ?? []).find((s) => s?.name === 'rp:standing');
    check('注入后 rp:standing 段仍在', Boolean(mine), true);
    check('世界设定真的进了系统提示词', mine?.text?.includes('诸神陨落后的第三百年'), true);
    check('战役名进了系统提示词', mine?.text?.includes('灰烬纪元'), true);
    check('角色卡进了系统提示词', mine?.text?.includes('凯尔'), true);
    check('随机表目录进了系统提示词', mine?.text?.includes('遭遇表'), true);
    check('其它段未被破坏', (out?.sections ?? []).length, 2);
    // 会话 id 必须来自**装配上下文**（曾经写成 ctx.agent.id，于是每次都读 default 会话：
    // 世界设定/世界书在生产里从来没注入过，探针文件里 sessionId 是 "default"）
    check('装配上下文里的 agent 决定注入哪个会话（插件 ctx 上没有 agent）', agentCtx.agent === undefined, true);
    // 裸装配（没有 scope/agent）必须原样返回：既不注入，也不能猜成别的会话
    const bareAsm = mkAssembly(null, SID);
    const bare = await onAssemble(bareAsm, {}, nextOf(bareAsm));
    check('拿不到 agent 的裸装配不注入（保持占位文案）',
      bare?.sections?.find((s) => s?.name === 'rp:standing')?.text === sec.text, true);

    // ── 常驻世界书条目：进 **standing（系统提示）**，本来每轮都一样的全文不该塞进每轮快照 ──
    {
      const wsC = join(TEST_HOME, 'ws-const');
      mkdirSync(wsC, { recursive: true });
      mod.__debug.setSessionCwd(SID, wsC);
      await callPost('/rp-tools/lore', {
        sessionId: SID, workspace: wsC, action: 'add',
        entry: { title: '世界总纲', keys: [], constant: true, body: '永夜笼罩的第三百年。' },
      });
      await callPost('/rp-tools/lore', {
        sessionId: SID, workspace: wsC, action: 'add',
        entry: { title: '长安城', keys: ['长安'], constant: false, body: '天宝年间的坊市分明。' },
      });
      // 语料里有「长安」→ 非常驻那条应当命中
      onSessionCreated({
        id: SID,
        header: { id: SID },
        deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: '我们去长安' }] }],
      });
      const asmC = mkAssembly(null, SID);
      const outC = await onAssemble(asmC, asmC.context, nextOf(asmC));
      const standingC = outC.sections.find((s) => s.name === 'rp:standing')?.text ?? '';
      const turnC = outC.contexts.find((c) => c.name === 'rp:turn')?.text ?? '';
      check('常驻条目进了系统提示（standing）', standingC.includes('永夜笼罩的第三百年'), true);
      check('常驻条目在系统提示里带来源标签', standingC.includes('【世界书·常驻】'), true);
      check('常驻条目不再进每轮快照（否则每轮都往历史里追加一份全文）',
        turnC.includes('永夜笼罩的第三百年'), false);
      check('非常驻条目命中后仍进每轮快照', turnC.includes('天宝年间的坊市分明'), true);
      // 空壳条目：连系统提示都不该进
      await callPost('/rp-tools/lore', {
        sessionId: SID, workspace: wsC, action: 'add',
        entry: { title: '空壳', keys: [], constant: true, body: '1.\n```markdown\n```' },
      });
      const asmD = mkAssembly(null, SID);
      const outD = await onAssemble(asmD, asmD.context, nextOf(asmD));
      const standingD = outD.sections.find((s) => s.name === 'rp:standing')?.text ?? '';
      check('空壳条目进不了系统提示', standingD.includes('### 空壳'), false);
    }

    // ── 默认宏列表（设置页的键值对预设）────────────────────────────────
    // 语义：**只提供默认值**，会话里填过的同名键优先。原先只有「玩家称呼」一个字段
    // 能给 `{{user}}` 当默认值，现在推广到所有名字。
    {
      const clean = mod.__debug.globalMacros({
        cards: { macros: { user: '阿岚', place: '长安', 'bad name': 'x', ok2: '   ' } },
      });
      check('默认宏列表：收下合法名字', clean.place, '长安');
      check('默认宏列表：丢掉非法名字', Object.hasOwn(clean, 'bad name'), false);
      check('默认宏列表：丢掉空值（界面还没填完的行）', Object.hasOwn(clean, 'ok2'), false);
      const merged = mod.__debug.mergedMacros(
        { cards: { macros: { user: '默认', place: '长安' } } },
        { place: '洛阳' },
      );
      check('默认宏列表：会话值优先', merged.place, '洛阳');
      check('默认宏列表：会话没填的键用默认值', merged.user, '默认');
      check('玩家称呼仍能从默认宏列表里取（老字段兼容）', mod.__debug.cardUserLabel({ cards: { macros: { user: '阿岚' } } }), '阿岚');
      check('玩家称呼老字段也认', mod.__debug.cardUserLabel({ cards: { userLabel: '旧玩家' } }), '旧玩家');
      check('都没填时回落「玩家」', mod.__debug.cardUserLabel({ cards: {} }), '玩家');
    }

    // 端到端：在设置页加一条默认宏 → 下一轮装配就该注册成宿主变量并给出默认值
    {
      const stateBefore = await callGet('/rp-tools/state');
      await callPost('/rp-tools/config', {
        cards: {
          root: stateBefore.json.config?.cards?.root ?? '',
          macros: { user: '阿岚', era: '天宝年间', 'bad name': '丢掉', empty: '' },
        },
      });
      const stateAfter = await callGet('/rp-tools/state');
      check('设置页：默认宏列表落盘', stateAfter.json.config?.cards?.macros?.era, '天宝年间');
      check('设置页：userLabel 跟着 user 同步（老字段）', stateAfter.json.config?.cards?.userLabel, '阿岚');
      check('设置页：非法名字被丢掉', Object.hasOwn(stateAfter.json.config?.cards?.macros ?? {}, 'bad name'), false);
      check('设置页：空值被丢掉', Object.hasOwn(stateAfter.json.config?.cards?.macros ?? {}, 'empty'), false);

      const asm2 = mkAssembly(null, SID);
      await onAssemble(asm2, asm2.context, nextOf(asm2));
      check('默认宏：装配后被注册成宿主变量', promptVars.has('era'), true);
      check('默认宏：变量值就是默认值', promptVars.get('era')?.(assembleCtx(SID)), '天宝年间');
      check('默认宏：{{user}} 用新的默认值', promptVars.get('user')?.(assembleCtx(SID)), '阿岚');
      // 会话宏表里填过的同名键仍然优先（这条是「默认值」语义的核心）
      await callPost('/rp-tools/session', { sessionId: SID, macros: { era: '开元' } });
      const asm3 = mkAssembly(null, SID);
      await onAssemble(asm3, asm3.context, nextOf(asm3));
      check('默认宏：会话值覆盖默认值', promptVars.get('era')?.(assembleCtx(SID)), '开元');

      // 刚重启那一轮：会话宏表只在盘上、还没被任何路由写过内存缓存 ——
      // provider 必须自己补读一次盘，否则面板里填过会话值的宏会退回全局默认值。
      const SID_DISK = crypto.randomUUID();
      mkdirSync(join(TEST_HOME, 'data', 'dsh-rp-tools', 'sessions'), { recursive: true });
      writeFileSync(
        join(TEST_HOME, 'data', 'dsh-rp-tools', 'sessions', `${SID_DISK}.json`),
        JSON.stringify({ sessionId: SID_DISK, macros: { era: '只在盘上' } }),
      );
      check('冷启动：宏值从磁盘补读（没经过任何路由）', promptVars.get('era')?.(assembleCtx(SID_DISK)), '只在盘上');

      // ── 出厂默认：列表里就该有一条 `user -> 玩家`（用户要求：不要给个空列表看不懂）──
      await callPost('/rp-tools/reset', {});
      const fresh = await callGet('/rp-tools/state');
      check('出厂配置：默认宏列表自带 user', fresh.json.config?.cards?.macros?.user, '玩家');
      check('出厂配置：userLabel 与之同源', fresh.json.config?.cards?.userLabel, '玩家');

      // 用户删掉这一条之后**不该又被塞回来**（macrosSeeded 一次性迁移）
      await callPost('/rp-tools/config', { cards: { root: '', macros: {} } });
      const cleared = await callGet('/rp-tools/state');
      check('删掉 user 之后不再自动补回', Object.hasOwn(cleared.json.config?.cards?.macros ?? {}, 'user'), false);
      check('删掉后 userLabel 也跟着空', cleared.json.config?.cards?.userLabel, '');
      // 但玩家称呼本身仍要有兜底：什么默认值都没有时回落「玩家」
      check('没默认值时 {{user}} 仍回落「玩家」', mod.__debug.cardUserLabel(cleared.json.config ?? {}), '玩家');
    }

    // 双花括号必须被中和，否则宿主插值会把 {{宏}} 当变量而抛错
    // （注意：这里必须先做断言再切会话 —— currentStandingSessionId 取的是「最近活动的会话」）
    await callPost('/rp-tools/session', { sessionId: SID, world: '她轻声说 {{user}} 你来了' });
    // （不再需要模拟装配断言的调试输出：注入逻辑已改为走纯函数 __debug.injectFor）
    // 双花括号必须被中和，否则宿主插值会把 {{宏}} 当变量而抛错。
    // 这里直接走纯函数：loadSession 依赖模块加载时定下的数据目录（真实 ~/.dsh），
    // 在临时 DSH_HOME 下用不了 —— 纯函数既避开这个陷阱，也正是要断言的逻辑。
    const t2 = mod.__debug.injectFor({ world: '她轻声说 {{user}} 你来了，还提到 {{mystery}}', characters: [], tables: [] });
    // ⚠️ 语义变了：{{user}} 现在是**我们注册过的宿主变量**，要原样留给宿主插值（见 neutralizeMustache）；
    // 只有没注册的宏才需要中和 —— 否则 renderPrompt 会因为未知变量直接抛错。
    check('未注册的宏被中和（不残留半角双花括号）', t2.includes('{{mystery}}'), false);
    check('注册过的 {{user}} 原样保留', t2.includes('{{user}}'), true);
    check('中和后内容仍可读', t2.includes('你来了'), true);
    check('中和只动花括号、不动其它字符', t2.includes('｛｛mystery｝｝'), true);

    // 未配置世界设定的会话 → 回落固定短文案，不应把上一个会话的内容泄露过去
    onSessionCreated({ id: SID2, header: { id: SID2 } });
    const out3 = await onAssemble(mkAssembly(null, SID2), assembleCtx(SID2), nextOf(mkAssembly(null, SID2)));
    const t3 = (out3?.sections ?? []).find((s) => s?.name === 'rp:standing')?.text ?? '';
    check('无配置会话不泄露上一会话的设定', t3.includes('诸神陨落'), false);
    check('无配置会话仍带占位文案（段没被清掉）', t3.length > 0, true);
  } else { console.log('WARN: 未捕获 system-prompt/assemble 监听'); fail++; }
}

// ── 角色卡字段（学 hermes 的字段设计，不导入 ST 格式） ──────────────────────
{
  const SID = crypto.randomUUID();
  const rpCharacter = tools.get('rp_character');
  if (rpCharacter) {
    const exec = { agent: { id: `session-${SID}` } };
    // ① set 写入全部字段
    await rpCharacter.execute({
      action: 'set', name: '祁俊',
      appearance: '十九岁少年，虎背熊腰、面容俊朗，青色布袍束腰',
      personality: '心性方正，重情义，遇事先动手再动脑',
      speech: '句子短，爱用反问，管长辈称「您」',
      behavior: '紧张时摩挲腰间枪头',
      relations: '祝婉宁的徒弟，亦师亦母',
      first_mes: '雨打芭蕉。祁俊推门进来，浑身湿透：「师父，我回来了。」',
      mes_example: '祝婉宁：又闯祸了？\n祁俊：没有。',
    }, exec);
    const after = (await callGet('/rp-tools/session', `?sessionId=${SID}`)).json.session.characters[0];
    check('角色卡：personality 落盘', after?.personality, '心性方正，重情义，遇事先动手再动脑');
    check('角色卡：speech 落盘', after?.speech, '句子短，爱用反问，管长辈称「您」');
    check('角色卡：first_mes 落盘', String(after?.first_mes ?? '').includes('雨打芭蕉'), true);
    check('角色卡：relations 落盘', after?.relations, '祝婉宁的徒弟，亦师亦母');
    check('角色卡：字段集固定（无多余键）', Object.keys(after ?? {}).sort().join(','),
      'appearance,behavior,first_mes,mes_example,name,personality,relations,speech');

    // ② 只改一个字段时，其余字段不能被清掉（最容易回归的一条）
    await rpCharacter.execute({ action: 'set', name: '祁俊', speech: '改成了爱用感叹句' }, exec);
    const patched = (await callGet('/rp-tools/session', `?sessionId=${SID}`)).json.session.characters[0];
    check('角色卡：局部更新只改传入字段', patched?.speech, '改成了爱用感叹句');
    check('角色卡：局部更新不动其它字段', patched?.personality, '心性方正，重情义，遇事先动手再动脑');
    check('角色卡：局部更新不动 first_mes', String(patched?.first_mes ?? '').includes('雨打芭蕉'), true);

    // ③ 渲染：只输出填过的字段；样本字段带用途标注
    const rendered = mod.__debug.renderCharacter(patched);
    check('渲染含性格', rendered.includes('性格：'), true);
    check('渲染含说话方式', rendered.includes('说话方式：'), true);
    check('渲染标注了文风范本的用途', rendered.includes('文风范本') && rendered.includes('不要照抄内容'), true);
    check('渲染不含空字段噪音', rendered.includes('（未填）'), false);

    // ④ first_mes 超长要截断（避免把系统提示词撑爆）
    const r2 = mod.__debug.renderCharacter({ name: '测试', first_mes: '甲'.repeat(500) });
    check('first_mes 截断到预算长度', (r2.match(/甲/g) ?? []).length, 300);
    check('first_mes 截断处有省略号', r2.includes('…'), true);

    // ⑤ B 之后：常驻段只放**索引**，详细卡片进每轮注入的 turn 通道
    const session = { characters: [patched], world: '', tables: [] };
    const standing = mod.__debug.injectFor(session);
    check('常驻段只放角色名（索引）', standing.includes('祁俊'), true);
    check('常驻段不含详细设定（省 token）', standing.includes('心性方正'), false);
    check('常驻段不含 first_mes', standing.includes('雨打芭蕉'), false);

    // 出场时才展开详细卡片
    const onStage = mod.__debug.buildTurnContext(session, '祁俊推门进来', {});
    check('角色出场时展开详细设定', onStage.includes('心性方正'), true);
    check('角色出场时带上 first_mes', onStage.includes('雨打芭蕉'), true);
    const offStage = mod.__debug.buildTurnContext(session, '街上空无一人', {});
    check('角色未出场时不展开', offStage.includes('心性方正'), false);
    // 标了 always 的角色每轮都展开（主角用）
    const alwaysSession = { characters: [patched], characterIndex: [{ name: '祁俊', always: true }] };
    check('always 的角色每轮都展开',
      mod.__debug.buildTurnContext(alwaysSession, '街上空无一人', {}).includes('心性方正'), true);
    check('索引里标注了 always', mod.__debug.injectFor(alwaysSession).includes('[常驻展开]'), true);
    // 索引 brief 自定义
    const briefSession = { characters: [patched], characterIndex: [{ name: '祁俊', brief: '玉面飞龙' }] };
    check('索引 brief 可自定义', mod.__debug.injectFor(briefSession).includes('玉面飞龙'), true);
  } else { console.log('WARN: rp_character 未注册'); fail++; }
}

// ── 世界书：解析 / 激活 / 预算 / 确定性概率（纯函数） ────────────────────────
{
  const D = mod.__debug;
  const md = [
    '# 我的跑团世界书',
    '（这是文件头的说明，不属于任何条目）',
    '',
    '## 广寒宫（纯女门派）',
    '<!-- keys: 广寒宫, 祝婉宁, 无双夫人 | order: 80 -->',
    '天宫门下辖纯女门派，掌门祝婉宁，与爱徒祁俊有师徒情事。',
    '',
    '## 永夜纪元',
    '<!-- constant -->',
    '诸神陨落后的第三百年，整个世界被永夜笼罩。',
    '',
    '## 玉湖山庄',
    '<!-- prob: 50 -->',
    '玉山脚下，藏有天下行军地图。',
    '',
    '## 空条目',
    '',
  ].join('\n');

  const entries = D.parseLoreMarkdown(md);
  check('世界书：解析出条目数（空正文的不算）', entries.length, 3);
  check('世界书：显式 keys 被解析', entries[0].keys.join('、'), '广寒宫、祝婉宁、无双夫人');
  check('世界书：order 被解析', entries[0].order, 80);
  check('世界书：constant 被解析', entries[1].constant, true);
  check('世界书：prob 被解析', entries[2].probability, 50);
  check('世界书：标题即触发词（无 keys 时拆标题、去括号）',
    D.parseLoreMarkdown('## 玉湖山庄（含图）\n正文').map((e) => e.keys.join('|'))[0], '玉湖山庄');

  // 激活：命中 / 常驻 / 不命中
  const corpus = D.buildLoreCorpus([
    { role: 'user', content: [{ type: 'text', text: '我们去广寒宫找祝婉宁' }] },
  ]);
  const a1 = D.activateLore(entries, corpus, { sessionId: 's1', turn: 1 });
  const titles1 = a1.active.map((e) => e.title);
  check('世界书：命中的条目被激活', titles1.includes('广寒宫（纯女门派）'), true);
  check('世界书：常驻条目不靠关键词也激活', titles1.includes('永夜纪元'), true);
  check('世界书：未命中的不激活', titles1.includes('玉湖山庄'), false);

  const a2 = D.activateLore(entries, '风平浪静', { sessionId: 's1', turn: 1 });
  check('世界书：无命中时只剩常驻', a2.active.map((e) => e.title).join(), '永夜纪元');

  check('世界书：只扫最近 N 条（超过深度的旧消息不参与匹配）',
    D.buildLoreCorpus([
      { role: 'user', content: [{ type: 'text', text: '很久以前提过广寒宫' }] },
      { role: 'assistant', content: [{ type: 'text', text: '嗯' }] },
      { role: 'user', content: [{ type: 'text', text: '现在说别的' }] },
    ]).includes('广寒宫'), false);

  // 概率：确定性 + 可复现
  const roll1 = D.seededRoll('s1', 7, '玉湖山庄');
  const roll2 = D.seededRoll('s1', 7, '玉湖山庄');
  check('世界书：概率掷点可复现（同输入同结果）', roll1, roll2);
  check('世界书：不同轮次掷点不同（避免永远同一结果）',
    D.seededRoll('s1', 7, '玉湖山庄') === D.seededRoll('s1', 8, '玉湖山庄'), false);
  check('世界书：掷点在 [0,1) 区间', roll1 >= 0 && roll1 < 1, true);

  // 预算：超预算的进 dropped 而不是静默丢弃
  const big = [
    { title: 'A', keys: ['x'], body: '甲'.repeat(4000), constant: false, order: 0, probability: 100 },
    { title: 'B', keys: ['x'], body: '乙'.repeat(4000), constant: false, order: 0, probability: 100 },
  ];
  const a3 = D.activateLore(big, 'x', { sessionId: 's', turn: 1, budgetChars: 5000 });
  check('世界书：预算内只留一部分', a3.active.length, 1);
  check('世界书：被裁的计入 dropped（不静默丢弃）', a3.dropped.length, 1);
  const rendered = D.renderLore(a3.active, a3.dropped);
  check('世界书：注入文本带来源标签', rendered.includes('【世界书·'), true);
  check('世界书：被裁条目在文本里列出标题',
    rendered.includes('因预算未展开') && rendered.includes(a3.dropped[0].title), true);
  check('世界书：常驻条目带「常驻」标签',
    D.renderLore(a2.active, []).includes('【世界书·常驻】'), true);

  // 条目数上限
  const many = Array.from({ length: 20 }, (_, i) => ({ title: `T${i}`, keys: ['k'], body: 'x', constant: false, order: 0, probability: 100 }));
  const a4 = D.activateLore(many, 'k', { sessionId: 's', turn: 1, maxEntries: 5, budgetChars: 1e6 });
  check('世界书：条目数上限生效', a4.active.length, 5);

  // 空壳条目：解析时就打上 `empty`（面板据此折叠、注入时据此跳过）
  // —— 真卡里「足 / 14 字」那条正文就是 `1.` + 空 markdown 代码块
  const junkMd = [
    '## 足',
    '<!-- constant -->',
    '1.',
    '```markdown',
    '```',
    '',
    '## 前情提要',
    '<!-- constant -->',
    '三天前主角刚进城。',
    '',
  ].join('\n');
  const junkEntries = D.parseLoreMarkdown(junkMd);
  check('世界书：空壳条目被标 empty', junkEntries[0].empty, true);
  check('世界书：正常条目不是 empty', junkEntries[1].empty, false);
  check('世界书：类别标成 历史', junkEntries[1].kind, '历史');
  const a5 = D.activateLore(junkEntries, '随便说点什么', { sessionId: 's', turn: 1 });
  check('世界书：空壳条目**不注入**（即便是常驻）', a5.active.map((e) => e.title).join(), '前情提要');
  check('世界书：空壳条数被记下来', a5.emptySkipped, 1);

  // 总览数字：面板顶部那行 / 常驻体积（用户问过「常驻到底占了多少上下文」）
  const ov = D.loreOverview(junkEntries);
  check('总览：条目总数', ov.total, 2);
  // 常驻口径 = **真的会进系统提示的**：空壳常驻不进 standing（它本来就不注入），
  // 所以这里是 1 条 / 21 字，而不是「文件里标了 constant 的条数」（那会把不注入的也算进去）。
  check('总览：常驻条数（只数真的进 standing 的）', ov.constant, 1);
  check('总览：空壳条数', ov.empty, 1);
  check('总览：空壳字数', ov.emptyChars, 18);           // "1.\n```markdown\n```"
  // 常驻体积 = Σ(标题 + 正文 + 8)，与注入时的成本口径**必须一致**
  check('总览：常驻体积按注入口径算', ov.constantChars, (4 + 9 + 8));
  // 空壳常驻不进 standing，但也不谎报成「按需注入」—— 它本来就不注入（面板另有空条目提示）
  check('总览：空壳常驻不计入常驻也不谎报降级', ov.demoted.length, 0);
  check('总览：类别计数', JSON.stringify(ov.kinds), JSON.stringify({ 设定: 1, 规则: 0, 状态: 0, 历史: 1 }));

  // ── 注入规划（计划 §3.1）：导入的常驻不得自动获得 system 权限；standing 有总预算 ──
  {
    const mk = (title, body, extra = {}) => ({ title, keys: [title], constant: true, order: 0, body, empty: false, source: '', ...extra });
    const plan = D.planLoreInjection([
      mk('手写核心', '短的常驻'),
      mk('导入的人物', '这是从卡里导进来的大段人物正文', { source: 'card' }),
    ]);
    check('规划：手写常驻进 standing', plan.standing.map((e) => e.title).join(), '手写核心');
    check('规划：导入的常驻被降级（不给 system 权限）', plan.runtime.map((e) => e.title).sort().join(), '导入的人物');
    check('规划：降级原因记为 imported', plan.demoted.find((d) => d.title === '导入的人物')?.reason, 'imported');
    check('规划：降级后 constant 被清掉（改按触发词命中）', plan.runtime[0].constant, false);
    check('规划：standing 字数按注入口径上报', plan.standingChars, 4 + 4 + 8);
    // 预算：手写常驻超预算 → 降级（不截断、不残句）
    const big = D.planLoreInjection([mk('巨大设定', 'x'.repeat(20000))]);
    check('规划：手写常驻超预算也降级', big.standing.length === 0 && big.demoted[0]?.reason === 'budget', true);
    check('规划：降级条目的正文一字不动（不截断）', big.runtime[0].body.length, 20000);
    // 注入侧：导入的常驻改为**按触发词**进 runtime；**条目名**是本轮已展开的人物时跳过（§3.3 去重）
    const a = D.activateLore([mk('诸葛大力', '人物正文')], '诸葛大力走进来', { sessionId: 's', turn: 1, skipTitles: new Set(['诸葛大力']) });
    check('规划：命中的条目若人物已展开则跳过', a.active.length, 0);
    check('规划：跳过原因写进诊断', a.skipped[0]?.reason, 'character-duplicate');
    // 只看条目名：条目名不同、只是触发词撞上人物名 → **照常注入**（用户口径：键不用管）
    const a2 = D.activateLore([mk('室友', '人物正文')], '诸葛大力', { sessionId: 's', turn: 1, skipTitles: new Set(['诸葛大力']) });
    check('规划：触发词撞上人物名不算重复（只看条目名）', a2.active.length, 1);
    const b = D.activateLore([mk('诸葛大力', '人物正文')], '诸葛大力走进来', { sessionId: 's', turn: 1 });
    check('规划：人物没展开时照常注入', b.active.length, 1);
  }

  // 模板：DM 一键生成 → 生成出来的文件必须能被自己解析（闭环）
  const rpLore2 = tools.get('rp_lore');
  if (rpLore2) {
    const SID = crypto.randomUUID();
    const cwd = join(TEST_HOME, 'workspace');
    mkdirSync(cwd, { recursive: true });
    mod.__debug.setSessionCwd(SID, cwd);
    const exec = { agent: { id: `session-${SID}` } };
    const t = await rpLore2.execute({ action: 'template' }, exec);
    check('rp_lore template：生成成功', t.ok === true && existsSync(t.file), true);

    const parsed = mod.__debug.parseLoreMarkdown(readFileSync(t.file, 'utf8'));
    check('rp_lore template：模板自身可被解析出条目', parsed.length, 5);
    check('rp_lore template：模板里的常驻标记被识别', parsed.filter((e) => e.constant).length, 1);
    check('rp_lore template：模板里的 prob 被识别', parsed.filter((e) => e.probability === 40).length, 1);
    check('rp_lore template：模板的说明注释不当成条目', parsed.some((e) => e.title.includes('世界书')), false);

    // 已存在时不覆盖（避免把用户写好的世界书冲掉）
    const again = await rpLore2.execute({ action: 'template' }, exec);
    check('rp_lore template：已存在时不覆盖', String(again.note).includes('已存在'), true);

    // 目录与按条读取
    const dir = await rpLore2.execute({ action: 'list' }, exec);
    check('rp_lore list：列出条目数与文件里的条数一致', dir.total, parsed.length);
    const found = await rpLore2.execute({ query: '主要势力' }, exec);
    check('rp_lore find：能按标题取到正文', found.lines.length > 0 && String(found.lines[0]).includes('立场'), true);
    const miss = await rpLore2.execute({ query: '不存在的条目xyz' }, exec);
    check('rp_lore find：未命中时给出说明而非报错', String(miss.note).includes('没有匹配'), true);
  } else { console.log('WARN: rp_lore 未注册'); fail++; }
}

// ── 世界书边界：**只有** `##` 是新条目，`###` 属于上一条的正文 ─────────────
// 历史 bug：解析器用 `#{2,6}`，于是卡正文里的 `### 外貌` 也变成条目 ——
// 《爱情公寓》那张卡 29 个顶级条目被解析成 44 个，世界书体积与面板条数一起虚高。
{
  const D = mod.__debug;
  const md = [
    '# 文件标题（不是条目）',
    '',
    '## 诸葛大力',
    '<!-- keys: 大力 | source: card -->',
    '正文开头。',
    '### 外貌',
    '短发，戴眼镜。',
    '### 关系',
    '胡一菲的室友。',
    '',
    '## 胡一菲',
    '<!-- constant -->',
    '正文二。',
    '',
  ].join('\n');
  const parsed = D.parseLoreMarkdown(md);
  const topLevel = (md.match(/^## /gm) ?? []).length;
  check('边界：顶级条目数 == 解析条目数', parsed.length, topLevel);
  check('边界：`###` 不再自成一个条目', parsed.map((e) => e.title).join(), '诸葛大力,胡一菲');
  check('边界：`###` 留在上一条正文里', parsed[0].body.includes('### 外貌') && parsed[0].body.includes('短发，戴眼镜。'), true);
  check('边界：`#` 文件标题不成条目', parsed.some((e) => e.title.includes('文件标题')), false);
  check('边界：无 keys 时标题当触发词', parsed[0].keys.join(), '大力');
  check('边界：source: card 被解析出来', parsed[0].source, 'card');
  // 编辑一条导入来的条目时必须把来源标记写回去，否则它会「变回手写」并重新拿到 system 权限
  const block = D.renderLoreEntryBlock(parsed[0]);
  check('边界：编辑后 source: card 仍在', block.includes('source: card'), true);
  const round = D.parseLoreMarkdown(block)[0];
  check('边界：往返一致（标题/标记/正文）',
    `${round.title}|${round.source}|${round.constant}|${round.body}`, `${parsed[0].title}|card|false|${parsed[0].body}`);
}

// ── 诊断：**只看条目名**与人物卡重不重名（键一律不管 —— 用户口径）────────────────
{
  const D = mod.__debug;
  check('key 规范化：全角与空白与标点都归一', D.normalizeLoreKey(' 诸葛大力： '), D.normalizeLoreKey('诸葛大力'));
  check('key 规范化：大小写归一', D.normalizeLoreKey('Lisa榕'), D.normalizeLoreKey('lisa榕'));
  const diag = D.loreNameConflicts([
    { title: '诸葛大力', keys: ['大力', '诸葛大力'], body: 'A', empty: false },
    { title: '大力（旧版）', keys: ['诸葛大力'], body: 'B', empty: false },
    { title: '广寒宫', keys: ['广寒宫'], body: 'C', empty: false },
  ], { characterNames: ['广寒宫'] });
  // 两条条目共用 key「诸葛大力」→ 不报；条目名与人物名不同 → 也不报
  check('诊断：不再产出 duplicateKeys', diag.duplicateKeys, undefined);
  check('诊断：只有条目名 == 人物名才报', diag.characterOverlap.map((o) => o.title).join(), '广寒宫');
  check('诊断：条目级说明可直接显示', String(diag.byTitle['广寒宫']).includes('人物卡'), true);
  check('诊断：只认条目名（条目名不同、触发词带人物名 → 不报）',
    D.loreNameConflicts([{ title: '室友', keys: ['诸葛大力'], body: 'D', empty: false }], { characterNames: ['诸葛大力'] })
      .characterOverlap.length, 0);
  check('诊断：条目名的全半角/标点差异仍算重名',
    D.loreNameConflicts([{ title: '广寒宫：', keys: [], body: 'E', empty: false }], { characterNames: ['广寒宫'] })
      .characterOverlap.length, 1);
  check('诊断：空壳条目不参与诊断',
    D.loreNameConflicts([{ title: '足', keys: ['足'], body: '1.', empty: true }], { characterNames: ['足'] }).characterOverlap.length, 0);
}

// ── 给无名条目重命名（老导入器把没名字的条目编成「条目 4」…）──────────────────
{
  const sid = crypto.randomUUID();
  const ws = join(TEST_HOME, 'ws-rename');
  const loreFile = join(ws, 'rp-sessions', sid, 'rp-worldbook.md');
  mkdirSync(dirname(loreFile), { recursive: true });
  writeFileSync(loreFile, [
    '# 测试世界书',
    '',
    '## 世界总纲',
    '<!-- constant -->',
    '时代与基调。',
    '',
    '## 条目名单',
    '<!-- keys: 名单 -->',
    '用户自己起的名，不许动。',
    '',
    '## 条目 4',
    '<!-- keys: --战斗、--b | source: card -->',
    '<rule>',
    '中文输出',
    'D4=1-4',
    '',
    '## 条目 5',
    '<!-- keys: --营地、--派系 | source: card -->',
    '<tfau>',
    '中文输出',
    '',
  ].join('\n'), 'utf8');
  mod.__debug.setSessionCwd(sid, ws);
  const res = await callPost('/rp-tools/lore', { sessionId: sid, workspace: ws, action: 'renameUnnamed' });
  check('重命名：ok', res.json.ok, true);
  check('重命名：改了两条', res.json.changed, 2);
  check('重命名：按触发词起名',
    (res.json.renamed ?? []).map((r) => `${r.from}→${r.to}`).join(','), '条目 4→战斗,条目 5→营地');
  const text = readFileSync(loreFile, 'utf8');
  check('重命名：文件里出现新标题', text.includes('## 战斗') && text.includes('## 营地'), true);
  check('重命名：不再有编号标题', /^## 条目 \d+/m.test(text), false);
  check('重命名：用户自己起的名一字不动', text.includes('## 条目名单'), true);
  check('重命名：触发词原样保留', text.includes('keys: --战斗、--b'), true);
  check('重命名：source 标记保留（否则导入条目会变回「手写」拿到 system 权限）',
    (text.match(/source: card/g) ?? []).length, 2);
  check('重命名：正文没被重写', text.includes('D4=1-4') && text.includes('用户自己起的名，不许动。'), true);
  // 幂等：再跑一次没事可做，也不许报错
  const again = await callPost('/rp-tools/lore', { sessionId: sid, workspace: ws, action: 'renameUnnamed' });
  check('重命名：重复执行幂等', again.json.changed, 0);
  check('重命名：列表里能看到新名字',
    (again.json.entries ?? []).some((e) => e.title === '战斗'), true);
}

// ── rp_lore 的 localize / rename_unnamed：DM 开局时一次调用做完（见 launch 文件）──
// 面板上不再有「属性中文化」「重命名无名条目」按钮 —— 这两件事改由 DM 按初始引导文件做，
// 所以**工具侧必须有对应动作**，否则那条路走不通。
{
  const sid = crypto.randomUUID();
  const ws = join(TEST_HOME, 'ws-lore-tools');
  const loreFile = join(ws, 'rp-sessions', sid, 'rp-worldbook.md');
  mkdirSync(dirname(loreFile), { recursive: true });
  writeFileSync(loreFile, [
    '# 世界书',
    '',
    '## 条目 7',
    '<!-- keys: --配方、--recipe | source: card -->',
    'name: 配方',
    'gender: Female',
    '放进合成台就能做东西。',
    '',
  ].join('\n'), 'utf8');
  mod.__debug.setSessionCwd(sid, ws);
  const rpLore3 = tools.get('rp_lore');
  if (rpLore3) {
    const exec = { agent: { id: `session-${sid}` } };
    const rn = await rpLore3.execute({ action: 'rename_unnamed' }, exec);
    check('rp_lore rename_unnamed：列出一条改名', rn.lines.length, 1);
    check('rp_lore rename_unnamed：说清改了什么', String(rn.note).includes('已重命名 1 条'), true);
    const lz = await rpLore3.execute({ action: 'localize' }, exec);
    check('rp_lore localize：列出一处中文化', lz.lines.length, 1);
    check('rp_lore localize：说清改了哪几行', String(lz.note).includes('行英文属性键'), true);
    const text = readFileSync(loreFile, 'utf8');
    check('rp_lore：标题按触发词改名', text.includes('## 配方'), true);
    check('rp_lore：属性标签中文化', text.includes('名称：配方') && text.includes('性别：女'), true);
    check('rp_lore：来源标记与触发词保留', text.includes('keys: --配方、--recipe') && text.includes('source: card'), true);
    check('rp_lore：正文没被改', text.includes('放进合成台就能做东西。'), true);
    // 两个动作都幂等：再来一次无事可做、也不报错
    check('rp_lore rename_unnamed：再跑无事可做', (await rpLore3.execute({ action: 'rename_unnamed' }, exec)).lines.length, 0);
    check('rp_lore localize：再跑无事可做', (await rpLore3.execute({ action: 'localize' }, exec)).lines.length, 0);
  } else { console.log('WARN: rp_lore 未注册'); fail++; }
}

// ── rp_session：DM 设定 / 战役名（Agent 与面板共用同一份配置）────────────────
// ⚠️ 原先这一段还测「本会话生图策略」（`images_enabled` / `images_first_appearance` /
// `images_key_scenes`）：本地生图整块搬走后，这些参数与 `session.dm.images` 都不再解析，
// 相关断言随之删除。**保留下来的是同一条真事故的回归闸门**：这几个开关当年和 DM 正文
// 同在 `session.dm` 下，写错一次就会在改开关时把 DM 正文清空。现在最容易踩到同一脚的
// 是 `campaign_name` / `prompt_prefix`，所以改成用它们来验「改一个键不清掉正文」。
{
  const D = mod.__debug;
  const rpSession = tools.get('rp_session');
  if (rpSession) {
    const SID = crypto.randomUUID();
    const cwd = join(TEST_HOME, 'ws-session-tool');
    mkdirSync(cwd, { recursive: true });
    D.setSessionCwd(SID, cwd);
    const exec = { agent: { id: `session-${SID}` } };
    const read = () => D.loadSession(SID);
    const DM_PROMPT = 'DM 规则：扮演所有 NPC，第二人称叙述。';

    await rpSession.execute({ action: 'set', dm_prompt: DM_PROMPT }, exec);
    check('rp_session：dm_prompt 落盘', read().dm?.prompt, DM_PROMPT);

    // 只改别的键**不能**把 DM 正文清掉（它们同在 session.dm / session.campaign 下，最容易写错）
    await rpSession.execute({ action: 'set', campaign_name: '长安十二时辰' }, exec);
    check('rp_session：改战役名后 DM 正文还在', read().dm?.prompt, DM_PROMPT);
    check('rp_session：战役名落盘', read().campaign?.name, '长安十二时辰');
    await rpSession.execute({ action: 'set', prompt_prefix: '国风、水墨、暖色' }, exec);
    check('rp_session：改提示词前缀后 DM 正文仍在', read().dm?.prompt, DM_PROMPT);
    check('rp_session：提示词前缀落盘', read().campaign?.prompt_prefix, '国风、水墨、暖色');

    // 反证：已删除的生图参数**不再写进会话配置**（写了会让「这插件还能出图」的假象留在盘上）
    await rpSession.execute({ action: 'set', images_enabled: true, images_key_scenes: false }, exec);
    check('rp_session：已删的生图开关不再落盘', read().dm?.images, undefined);
    check('rp_session：传了已删参数也不影响 DM 正文', read().dm?.prompt, DM_PROMPT);

    // 面板与工具共用同一份配置：常驻段渲染要跟着变
    const setup = D.renderDmSetup(read());
    check('rp_session：常驻段带上 DM 设定正文', setup.includes('DM 规则：扮演所有 NPC'), true);
    // 「生图：开/关」那行没了 —— 出图不是本插件的事了，常驻段只留一句配图指路
    check('rp_session：常驻段不再有生图开关行', setup.includes('生图：'), false);
    check('rp_session：常驻段指向宿主的 generate_image',
      setup.includes('本插件不出图') && setup.includes('generate_image'), true);

    // get 的输出要把设过的都报出来（不然 DM 只能靠猜自己设过什么）
    const got = await rpSession.execute({ action: 'get' }, exec);
    check('rp_session：get 报告 DM 设定字数', got.lines.some((l) => l.includes('DM 设定：')), true);
    check('rp_session：get 报告战役名', got.lines.some((l) => l.includes('长安十二时辰')), true);
    check('rp_session：get 给出全局卡库配置文件路径', got.lines.some((l) => l.includes('全局卡库配置：')), true);
    check('rp_session：get 指向 generate_image 与 rp_assets 入库',
      got.lines.some((l) => l.includes('generate_image') && l.includes('rp_assets')), true);
    check('rp_session：get 不再报告本会话生图', got.lines.some((l) => l.startsWith('本会话生图')), false);
  } else { console.log('WARN: rp_session 未注册'); fail++; }
}


// ── 状态追踪（rp_state）────────────────────────────────────────────────────
{
  const D = mod.__debug;
  const SID = crypto.randomUUID();
  const rpState = tools.get('rp_state');
  if (rpState) {
    const exec = { agent: { id: `session-${SID}` } };

    // ① 提交核心字段 + 队伍 + 旗标
    await rpState.execute({
      action: 'set',
      scene: '雨夜客栈', time: '三更', location: '玉湖山庄·东厢',
      present: '祝婉宁、两名麒麟卫',
      clues: '地图在西厢夹墙内',
      party: [{
        character: '祁俊', status: '警戒',
        abilities: '短枪枪法·乱星、听声辨位',
        inventory: '短枪枪头、腰刀', conditions: '左臂擦伤', goal: '找到地图',
      }],
      flags: { 伏笔_黑猫: '已埋', 义王_好感: '警惕' },
    }, exec);
    const after = (await callGet('/rp-tools/session', `?sessionId=${SID}`)).json.session.state;
    check('状态：场景落盘', after?.scene, '雨夜客栈');
    check('状态：队伍成员状态落盘', after?.party?.[0]?.conditions, '左臂擦伤');
    // 技能/能力与持有物都是**动态值**（会学新的、会换装备），所以住在状态层而不是人物卡
    check('状态：能力/技能落盘', after?.party?.[0]?.abilities, '短枪枪法·乱星、听声辨位');
    check('状态：持有/装备落盘', after?.party?.[0]?.inventory, '短枪枪头、腰刀');
    check('状态：旗标落盘', after?.flags?.伏笔_黑猫, '已埋');

    // ② 局部更新：没传的字段保持原值
    await rpState.execute({ action: 'set', location: '西厢' }, exec);
    const partial = (await callGet('/rp-tools/session', `?sessionId=${SID}`)).json.session.state;
    check('状态：局部更新只改传入字段', partial?.location, '西厢');
    check('状态：局部更新不动其它字段', partial?.scene, '雨夜客栈');
    check('状态：局部更新不动旗标', partial?.flags?.伏笔_黑猫, '已埋');

    // ③ 空串 = 清除（伤势好了/东西用掉了），不留幽灵键
    // ⚠️ 这里曾经是一条**死断言**：传的是顶层 `conditions: ''`，而 `conditions` 是**队伍行的字段**，
    //    顶层根本没有这个键 —— 于是 `'conditions' in state` 恒为 false，测了个寂寞。
    //    现在按队伍字段的正确用法测（1.13.3 起 party 支持局部更新）。
    await rpState.execute({ action: 'set', party: [{ character: '祁俊', conditions: '' }], flags: { 伏笔_黑猫: '' } }, exec);
    const cleared = (await callGet('/rp-tools/session', `?sessionId=${SID}`)).json.session.state;
    check('状态：空串清掉队伍行的那个字段', cleared?.party?.[0]?.conditions, undefined);
    check('状态：清一个字段不动同行的其它字段', cleared?.party?.[0]?.inventory, '短枪枪头、腰刀');
    check('状态：空串删除旗标键', '伏笔_黑猫' in (cleared?.flags ?? {}), false);
    check('状态：植入的旗标仍在', cleared?.flags?.义王_好感, '警惕');

    // ④ 注入：状态在最前、带权威标注；队伍行要带上**能力**与**持有**（都是动态值）
    const session = { state: after, world: '', tables: [], characters: [] };
    const turn = D.buildTurnContext(session, '没什么特别的', {});
    check('状态：进了每轮注入', turn.includes('本场当前状态'), true);
    check('状态：注入带「唯一权威」标注', turn.includes('唯一权威'), true);
    check('状态：注入在最前（先于世界书）', turn.indexOf('本场当前状态') < (turn.indexOf('世界书') === -1 ? Infinity : turn.indexOf('世界书')), true);
    check('状态：注入里带能力/技能字段', turn.includes('能力/技能=短枪枪法·乱星'), true);
    check('状态：注入里带持有/装备字段', turn.includes('持有/装备=短枪枪头、腰刀'), true);
    check('状态：没有任何状态时不注入空段', D.buildTurnContext({ state: {} }, '', {}).includes('本场当前状态'), false);

    // ⑤ 陈旧提醒：状态多轮未更新时提示模型去更新（防静默漂移）
    const stale = D.renderState({ scene: '旧场景', updatedSeq: 3 }, 3 + 20);
    check('状态：多轮未更新时给出提醒', stale.includes('多轮未更新'), true);
    const fresh = D.renderState({ scene: '新场景', updatedSeq: 100 }, 100);
    check('状态：刚更新过不打扰', fresh.includes('多轮未更新'), false);

    // ⑥ 成本护栏：旗标值截断、条数上限
    const many = {};
    for (let i = 0; i < 30; i++) many[`k${i}`] = 'v'.repeat(200);
    const capped = D.normalizeState({ flags: many });
    check('状态：旗标值被截断', Object.values(capped.flags)[0].length <= 121, true);
    check('状态：注入的旗标条数有上限', (D.renderState({ flags: many }).match(/k\d+=/g) ?? []).length <= 16, true);
    check('状态：超出上限时说明还有多少项', D.renderState({ flags: many }).includes('另有'), true);

    // ⑦ 字段与显示名必须一一对应 —— 漏一个就会让注入里出现 `undefined：…`（真实踩过）
    const missingLabels = D.STATE_FIELDS.filter((f) => !D.STATE_LABELS[f]);
    check('状态：每个字段都有显示名', missingLabels.join(',') || '（无缺失）', '（无缺失）');
    const missingPartyLabels = D.PARTY_FIELDS.filter((f) => !D.STATE_LABELS[f]);
    check('状态：队伍字段也都有显示名', missingPartyLabels.join(',') || '（无缺失）', '（无缺失）');
    // 全字段渲染一遍，绝不允许出现 undefined
    const allFilled = {};
    for (const f of D.STATE_FIELDS) allFilled[f] = 'x';
    allFilled.party = [Object.fromEntries(D.PARTY_FIELDS.map((f) => [f, 'y']))];
    const rendered = D.renderState(allFilled);
    check('状态：渲染结果不含 undefined', rendered.includes('undefined'), false);
    check('状态：线索有中文标签', rendered.includes('线索：x'), true);

    // ⑧ get 动作
    const got = await rpState.execute({ action: 'get' }, exec);
    check('状态：get 返回内容', got.ok === true && got.lines.length > 0, true);
    // 未知 action 要明确报错而不是静默
    let threw = false;
    try { await rpState.execute({ action: 'nonsense' }, exec); } catch { threw = true; }
    check('状态：未知 action 明确报错', threw, true);
  } else { console.log('WARN: rp_state 未注册'); fail++; }
}

// ── 路由体检：每条 GET 路由都要「真的能应答」────────────────────────────────
// 补一个真实的测试盲区：曾把全局 tools 数组删掉后漏改了 `/rp-tools/tools` 里的
// `[...tools, ...rpTools]`，那条路由直接 400 —— 而当时所有断言都是绿的，
// 因为它们只测工具定义与纯函数，从没**真的打过路由**。
{
  const GET_ROUTES = [
    ['/rp-tools/state', ''],
    ['/rp-tools/tools', ''],
    // ⚠️ `/rp-tools/check` 与 `/rp-tools/loras` 已随本地生图一起删除（ComfyUI 连通性与 LoRA 清单
    // 都只有出图才用得上），`/rp-tools/media` 与 `/rp-tools/preview` 同理 —— 这几条不该再出现，
    // 「删干净了」由下面「已删路由不存在」那一段正面钉住，而不是在这里少列两行。
    ['/rp-tools/inject', ''],
    ['/rp-tools/cards', '?limit=5'],
    ['/rp-tools/session', `?sessionId=${crypto.randomUUID()}`],
    // 全局工具放行名单（1.15.0 起）：GET 要能列出本机存在的全局工具供设置页勾选
    ['/rp-tools/global-tools', ''],
  ];
  for (const [routePath, query] of GET_ROUTES) {
    let status = -1; let detail = '';
    try {
      const res = await callGet(routePath, query);
      status = res.status; detail = JSON.stringify(res.json).slice(0, 140);
    } catch (error) {
      detail = String(error?.message ?? error);
    }
    check(`路由体检 ${routePath} 返回 2xx`, status >= 200 && status < 300, true);
    if (!(status >= 200 && status < 300)) console.log(`       ↳ status=${status} body=${detail}`);
  }
  // 已删的四条路由必须**真的不在**注册表里：`routes.get()` 拿不到就是没有。
  // 只断言「上面的清单里没列」是假绿 —— 路由还在、只是没人打它而已。
  for (const gone of ['/rp-tools/media', '/rp-tools/preview', '/rp-tools/loras', '/rp-tools/check']) {
    check(`已删路由 ${gone} 未注册`, routes.has(gone), false);
  }
}


// ── PNG 故事书：卡库列表 / 解析 / 导入 / 卡面 ──────────────────────────────
// 用临时目录当卡库（含一张真 PNG），并顺手验证路径逃逸被挡 ——
// 这条路由会把磁盘内容交给浏览器，路径校验是它的安全边界，必须有断言。
{
  const { simpleCardPng } = await import(pathToFileURL(join(here, 'png-fixture.mjs')).href);
  const libRoot = join(TEST_HOME, 'cards-lib');
  mkdirSync(join(libRoot, 'cards', '测试分类'), { recursive: true });
  mkdirSync(join(libRoot, 'cards', '解压密码Wait'), { recursive: true });
  writeFileSync(
    join(libRoot, 'cards', '测试分类', '烟测卡.card.png'),
    simpleCardPng('烟测卡', {
      description: '设定正文',
      // 占位符：导入时必须**就地展开**（{{user}} → 玩家，{{char}} → 卡名）。
      // 留给注入端的话，neutralizeMustache 会把它变成全角括号，DM 看到的是一串 ｛｛user｝｝。
      scenario: '{{char}}的情境正文：{{user}}站在门外',
      character_book: { entries: [{ name: '烟测条目', keys: ['烟测'], content: '{{user}}来到{{char}}的门前。' }] },
    }),
  );
  writeFileSync(join(libRoot, 'cards', '解压密码Wait', '坏卡.png'), simpleCardPng('坏卡'));

  // ★ 卡库目录默认 = **会话工作区下的 rp-cards/**（不配 cards.root 时）
  {
    const wsLib = join(TEST_HOME, 'ws-lib-default');
    mkdirSync(join(wsLib, 'rp-cards'), { recursive: true });
    writeFileSync(join(wsLib, 'rp-cards', '工作区卡.png'), simpleCardPng('工作区卡'));
    const reset = await callPost('/rp-tools/config', { cards: { root: '' } });
    check('卡库：清空配置后回到默认', reset.json.config?.cards?.root, '');
    const def = await callGet('/rp-tools/cards', `?limit=5&workspace=${encodeURIComponent(wsLib)}`);
    check('卡库：默认指向工作区的 rp-cards', def.json.root, join(wsLib, 'rp-cards'));
    check('卡库：来源标为 workspace', def.json.rootSource, 'workspace');
    check('卡库：能列到工作区里的卡', def.json.items?.some((i) => i.name === '工作区卡'), true);
    // 拿不到工作区、配置也没写根目录时：不再猜路径，直接说清「缺工作区」
    const noWs = await callGet('/rp-tools/cards', '?limit=1');
    check('卡库：无工作区时不猜路径', noWs.json.root, '');
    check('卡库：无工作区时来源标为 none', noWs.json.rootSource, 'none');
    check('卡库：无工作区时给出提示', String(noWs.json.hint).includes('工作区'), true);

    // ★ 回归：这种「空根目录」状态下解析某张卡，必须是明确的 400 提示，
    // 而不是把 '' resolve 成进程 cwd 后报 ENOENT（'<AppData>/同人/某卡.png'）。
    // 之前真机上就是这么炸的：客户端没传 workspace → 后端 stat 了一个人类看不懂的路径。
    const noRoot = await callGet('/rp-tools/card', `?path=${encodeURIComponent('同人/SCP-C收容设施.png')}`);
    check('card：无工作区无根目录时明确报错', noRoot.status, 400);
    check('card：错误提示指向工作区', String(noRoot.json.error).includes('工作区'), true);
    check('card：错误里没有 cwd 拼出来的路径', /ENOENT|AppData/.test(String(noRoot.json.error)), false);
    // 同一个相对路径，带上工作区就能解析到 <工作区>/rp-cards 下
    mkdirSync(join(wsLib, 'rp-cards', '同人'), { recursive: true });
    writeFileSync(join(wsLib, 'rp-cards', '同人', 'SCP-C收容设施.png'), simpleCardPng('SCP-C收容设施'));
    const withWs = await callGet('/rp-tools/card', `?path=${encodeURIComponent('同人/SCP-C收容设施.png')}&workspace=${encodeURIComponent(wsLib)}`);
    check('card：带上工作区后同一相对路径可解析', withWs.json.name, 'SCP-C收容设施');

    // 相对路径的 cards.root 按工作区解析
    await callPost('/rp-tools/config', { cards: { root: 'my-cards' } });
    const relRoot = await callGet('/rp-tools/cards', `?limit=1&workspace=${encodeURIComponent(wsLib)}`);
    check('卡库：相对路径配置按工作区解析', relRoot.json.root, join(wsLib, 'my-cards'));
    check('卡库：来源标为 config', relRoot.json.rootSource, 'config');
  }
  // ★ 回归：卡库在插件运行期间被重命名/移动/删除后，扫描缓存必须自行失效。
  // 真机事故是「刷新」仍列旧的英文长文件名，点进去 stat 那条死路径 → ENOENT。
  {
    const mutableRoot = join(TEST_HOME, 'cards-lib-mutable');
    const mutableDir = join(mutableRoot, '新下载');
    const oldFile = join(mutableDir, '旧文件名.png');
    const newFile = join(mutableDir, '新文件名.png');
    mkdirSync(mutableDir, { recursive: true });
    writeFileSync(oldFile, simpleCardPng('可变卡'));
    await callPost('/rp-tools/config', { cards: { root: mutableRoot } });

    const beforeMove = await callGet('/rp-tools/cards', '?limit=10');
    check('卡库变更：初次扫描列出旧文件名', beforeMove.json.items?.some((i) => i.path === '新下载/旧文件名.png'), true);
    // 拉开目录 mtime，避免低精度文件系统把「扫描」与「重命名」记成同一个时间戳。
    await new Promise((done) => setTimeout(done, 20));
    renameSync(oldFile, newFile);

    const afterMove = await callGet('/rp-tools/cards', '?limit=10');
    check('卡库变更：目录 mtime 变化后自动列出新文件名', afterMove.json.items?.some((i) => i.path === '新下载/新文件名.png'), true);
    check('卡库变更：自动刷新后不再保留旧路径', afterMove.json.items?.some((i) => i.path === '新下载/旧文件名.png'), false);

    const stalePick = await callGet('/rp-tools/card', `?path=${encodeURIComponent('新下载/旧文件名.png')}`);
    check('卡库变更：点旧路径返回 400', stalePick.status, 400);
    check('卡库变更：点旧路径返回可识别错误码', stalePick.json.code, 'CARD_LIBRARY_CHANGED');
    check('卡库变更：错误提示不再暴露 ENOENT', String(stalePick.json.error).includes('ENOENT'), false);

    // 显式刷新必须无条件绕过缓存，即使文件系统时间戳碰巧没有变化。
    writeFileSync(join(mutableDir, '刚加入.png'), simpleCardPng('刚加入'));
    const forced = await callGet('/rp-tools/cards', '?limit=10&refresh=1');
    check('卡库变更：refresh=1 强制重扫', forced.json.items?.some((i) => i.path === '新下载/刚加入.png'), true);
  }

  const setRoot = await callPost('/rp-tools/config', { cards: { root: libRoot } });
  check('卡库根目录可配置', setRoot.json.config?.cards?.root, libRoot);

  const listed = await callGet('/rp-tools/cards', '?limit=10');
  check('cards 路由 status=200', listed.status, 200);
  check('cards：读到临时卡库', listed.json.librarySize, 1);
  check('cards：扫描来源是目录扫描（临时库没有私有索引）', listed.json.indexSource, 'scan');
  check('cards：卡名取自文件名', listed.json.items?.[0]?.name, '烟测卡.card');
  check('cards：分类取自路径第二段', listed.json.items?.[0]?.category, '测试分类');
  check('cards：分类清单含测试分类', listed.json.categories?.some((c) => c.name === '测试分类'), true);
  check('cards：加密目录被跳过', listed.json.items?.some((i) => i.name === '坏卡'), false);

  // ── 工作区解析链：内存 → 宿主会话注册表 → 落盘 → 请求参数 ────────────────
  // ★ 真事故回归：卡库/世界书都挂在「会话的工作区」上，而插件对工作区的记忆
  //   曾经**只有进程内存**（session/created 时填）。重启后恢复的会话不在内存里，
  //   界面又只传 sessionId 时，根目录落空 → resolve('') = 进程 cwd → 用户看到
  //   `stat '<AppData>\同人\某卡.png'` 这种莫名其妙的 ENOENT。
  {
    // 这一段要验证「卡库默认跟着会话工作区」，所以先清掉显式配置的卡库根
    await callPost('/rp-tools/config', { cards: { root: '' } });
    const id = crypto.randomUUID();
    const wsLive = join(TEST_HOME, 'ws-live');
    mkdirSync(join(wsLive, 'rp-cards', '同人'), { recursive: true });
    writeFileSync(join(wsLive, 'rp-cards', '同人', '活着的卡.png'), simpleCardPng('活着的卡'));
    // ① 宿主注册表认识它（= 本进程加载过这个会话）：只给 sessionId 就够
    liveSessions.set(`session-${id}`, { header: { cwd: wsLive } });
    const viaLive = await callGet('/rp-tools/card', `?sessionId=${id}&path=${encodeURIComponent('同人/活着的卡.png')}`);
    check('card：只给 sessionId 也能解析（宿主注册表现查）', viaLive.json.name, '活着的卡');
    const sessGet = await callGet('/rp-tools/session', `?sessionId=${id}`);
    check('session：GET 返回 cwd（界面 ensureCwd 的兜底来源）', sessGet.json.cwd, wsLive);
    check('card：解析顺手把 cwd 落盘（会话配置）', JSON.parse(readFileSync(join(TEST_HOME, 'data', 'dsh-rp-tools', 'sessions', `${id}.json`), 'utf8')).cwd, wsLive);

    // ② 模拟重启：内存清空、宿主注册表也不认识它 —— 只剩落盘那份
    liveSessions.delete(`session-${id}`);
    mod.__debug.forgetSessionCwd(id);
    const afterRestart = await callGet('/rp-tools/card', `?sessionId=${id}&path=${encodeURIComponent('同人/活着的卡.png')}`);
    check('card：重启后也能靠落盘的 cwd 解析', afterRestart.json.name, '活着的卡');
    check('workspace 解析链：落盘命中', mod.__debug.resolveWorkspaceDir(id, ''), wsLive);

    // ③ 四级全落空 → null（调用方据此报「拿不到工作区」，而不是猜一个进程 cwd）
    const stranger = crypto.randomUUID();
    check('workspace 解析链：完全不知道时返回 null', mod.__debug.resolveWorkspaceDir(stranger, ''), null);
    // ④ 调用方给的绝对路径仍然有效，并且会被记住
    check('workspace 解析链：请求参数兜底', mod.__debug.resolveWorkspaceDir(stranger, wsLive), wsLive);
    check('workspace 解析链：兜底后也记住了', mod.__debug.resolveWorkspaceDir(stranger, ''), wsLive);
    // 还原后面用例依赖的显式卡库根
    await callPost('/rp-tools/config', { cards: { root: libRoot } });
  }

  // ── 会话闸门：界面据此决定「导入入口要不要出现」──────────────────────────
  // ★ 真事故：入口的可见性原先只看客户端投影，而切预设会重建投影基线、清掉没有的键
  //   （`projectionValues.agentPreset` 变空）→ 判定「不是 DM」→ 入口永久消失。
  //   宿主手里是活着的会话对象 + 自己的投影状态，所以这条路由必须给出确定答案。
  {
    const wire = (session) => {
      const id = crypto.randomUUID();
      liveSessions.set(`session-${id}`, session);
      return id;
    };
    const base = (extra = {}) => ({ header: { agentPreset: 'dm', cwd: TEST_HOME }, log: [], deriveMessages: () => [], ...extra });

    const fresh = wire(base());
    const g1 = await callGet('/rp-tools/gate', `?sessionId=${fresh}`);
    check('gate：dm 新会话', g1.json.dm, true);
    check('gate：dm 新会话未开局', g1.json.started, false);
    check('gate：报名预设', g1.json.preset, 'dm');

    // 投影优先于 header（切预设后 header 可能还是建会话时的值）
    const switched = wire(base({ proj: { agentPreset: 'novelist' } }));
    const g2 = await callGet('/rp-tools/gate', `?sessionId=${switched}`);
    check('gate：切走后不是 dm（投影优先）', g2.json.dm, false);
    check('gate：报出真实预设', g2.json.preset, 'novelist');

    // 开过轮 → 已开局（入口该消失）
    const ran = wire(base({ log: [{ type: 'turn/start' }] }));
    const g3 = await callGet('/rp-tools/gate', `?sessionId=${ran}`);
    check('gate：跑过一轮就是已开局', g3.json.started, true);

    // 只有用户消息（日志窗口里 turn/start 被裁掉）也算已开局
    const asked = wire(base({ log: [{ type: 'user/message', data: { source: { kind: 'user' } } }] }));
    const g4 = await callGet('/rp-tools/gate', `?sessionId=${asked}`);
    check('gate：有用户消息也算已开局', g4.json.started, true);

    // sessionListMetadata 投影存在时以它为准（它就是宿主算 blank 的那份状态）
    const meta = wire(base({ log: [{ type: 'turn/start' }], proj: { sessionListMetadata: { blank: true, lastPromptAt: null } } }));
    const g5 = await callGet('/rp-tools/gate', `?sessionId=${meta}`);
    check('gate：有投影时以投影为准', g5.json.started, false);

    // 会话不在本进程里、插件也没登记过 → 不是 dm（界面据此不显示入口）
    const unknown = crypto.randomUUID();
    const g6 = await callGet('/rp-tools/gate', `?sessionId=${unknown}`);
    check('gate：完全不认识 → 不是 dm', g6.json.dm, false);
    check('gate：完全不认识 → 活的会话为假', g6.json.live, false);

    // 插件登记过的 dm 会话（拿不到活的会话时的兜底）仍然算 dm
    const marked = crypto.randomUUID();
    await callPost('/rp-tools/dm-mark', { sessionId: marked, preset: 'dm' });
    const g7 = await callGet('/rp-tools/gate', `?sessionId=${marked}`);
    check('gate：dm 登记表兜底', g7.json.dm, true);

    const noId = await callGet('/rp-tools/gate', '');
    check('gate：缺 sessionId → 400', noId.status, 400);
  }

  // ── 立绘清理：老版本的 generated 引用由 clear 抹掉 ───────────────────────
  // ★ 用户报的「角色卡生成的立绘下次打开面板就消失」那条链路的**残留部分**：
  //   老版本把 (file, subfolder, type) 三要素记进会话配置（不记 URL：origin 会变）。
  //   本地生图搬走后那些三要素全成了死引用（指向 ComfyUI 的 output 目录），
  //   所以 `POST /rp-tools/portrait` 只剩 clear 一个动作，且**连 style/elapsedMs/at 一起抹**。
  //   注意 `card`（卡面）与 `imported`（玩家导入）不是一回事，清除时不许动它们。
  {
    const sid = crypto.randomUUID();
    // 直接落一份「老配置」到盘上（含 generated + style + elapsedMs + card 并存）
    const legacyFile = join(TEST_HOME, 'data', 'dsh-rp-tools', 'sessions', `${sid}.json`);
    mkdirSync(dirname(legacyFile), { recursive: true });
    writeFileSync(legacyFile, JSON.stringify({
      sessionId: sid,
      characters: [{ name: '阿岚' }],
      portraits: {
        阿岚: {
          generated: { file: 'rp-portrait-1.png', subfolder: 'rp', type: 'output' },
          style: '二次元', elapsedMs: 18300, at: '2026-09-12T01:00:00.000Z',
          card: 'cards/古风/长安.card.png',
        },
      },
    }, null, 2), 'utf8');

    const cleared = await callPost('/rp-tools/portrait', { sessionId: sid, name: '阿岚', action: 'clear' });
    check('portrait：clear 成功', cleared.status, 200);
    check('portrait：清除后没有 generated', cleared.json.portraits?.['阿岚']?.generated, undefined);
    check('portrait：连 style / elapsedMs 一起抹掉（不留半条死引用）',
      `${cleared.json.portraits?.['阿岚']?.style}|${cleared.json.portraits?.['阿岚']?.elapsedMs}`, 'undefined|undefined');
    check('portrait：卡面不受清除影响', cleared.json.portraits?.['阿岚']?.card, 'cards/古风/长安.card.png');
    // 落盘了才算数（重启后 / 下次打开面板靠它）
    const onDisk = JSON.parse(readFileSync(legacyFile, 'utf8'));
    check('portrait：确实写进了会话配置文件', onDisk.portraits?.['阿岚']?.generated, undefined);
    check('portrait：卡面也落盘保留', onDisk.portraits?.['阿岚']?.card, 'cards/古风/长安.card.png');

    // 参数缺失要明确报错，别静默当成功
    check('portrait：缺 sessionId → 400', (await callPost('/rp-tools/portrait', { name: 'x', action: 'clear' })).status, 400);
    check('portrait：缺 name → 400', (await callPost('/rp-tools/portrait', { sessionId: sid, action: 'clear' })).status, 400);
    check('portrait：缺 action → 400（不许默认成 clear）',
      (await callPost('/rp-tools/portrait', { sessionId: sid, name: 'x' })).status, 400);
    check('portrait：带 file 的请求 → 400（只有 clear 一条路）',
      (await callPost('/rp-tools/portrait', { sessionId: sid, name: 'x', file: 'a.png' })).status, 400);
  }

  const rel = 'cards/测试分类/烟测卡.card.png';
  const searched = await callGet('/rp-tools/cards', `?q=${encodeURIComponent('烟测')}&limit=10`);
  check('cards：搜索命中', searched.json.total, 1);
  const missed = await callGet('/rp-tools/cards', '?q=绝对不存在的卡名&limit=10');
  check('cards：搜索未命中返回 0', missed.json.total, 0);

  const preview = await callGet('/rp-tools/card', `?path=${encodeURIComponent(rel)}`);
  check('card 解析 status=200', preview.status, 200);
  check('card：卡名', preview.json.name, '烟测卡');
  check('card：规范识别 v3', preview.json.kind, 'v3');
  check('card：世界书一条', preview.json.stats?.entries, 1);
  check('card：情境进了 world 预览', String(preview.json.world).includes('情境正文'), true);
  check('card：{{user}} 原样保留（由宿主变量插值，面板改值立刻生效）', String(preview.json.world).includes('{{user}}站在门外'), true);
  check('card：{{char}} 已展开成卡名', String(preview.json.world).includes('烟测卡的情境正文'), true);
  check('card：预览里没有其它未处理的占位符', /\{\{(?!user\})/.test(String(preview.json.world)), false);
  check('card：返回占位符统计', (preview.json.placeholders?.counts?.['{{user}}'] ?? 0) >= 1, true);

  // 路径逃逸：卡库之外、非 .png、不存在的文件都必须是 400
  const escape = await callGet('/rp-tools/card', '?path=../../../../Windows/win.ini');
  check('card：路径逃逸被拒', escape.status, 400);
  const abs = await callGet('/rp-tools/card', `?path=${encodeURIComponent(join(TEST_HOME, 'x.png'))}`);
  check('card：库外绝对路径被拒', abs.status, 400);
  const notPng = await callGet('/rp-tools/card', '?path=cards%2F测试分类%2F烟测卡.card.txt');
  check('card：非 png 被拒', notPng.status, 400);
  const missing = await callGet('/rp-tools/card', '?path=cards%2Fnope.png');
  check('card：不存在的文件报错', missing.status, 400);

  // 导入：写工作区（世界书 + 全文 + 卡 JSON + 卡面）并更新会话配置
  const ws = join(TEST_HOME, 'ws-import');
  mkdirSync(ws, { recursive: true });
  const IMPORT_SID = crypto.randomUUID();
  // 世界书按会话隔离：<工作区>/rp-sessions/<会话 id>/rp-worldbook.md
  const LORE_FILE = join(ws, 'rp-sessions', IMPORT_SID, 'rp-worldbook.md');
  // ① 用户**手写**的条目直接放进本会话的世界书里（导入前就存在 → 验「追加而不是覆盖」）
  mkdirSync(dirname(LORE_FILE), { recursive: true });
  writeFileSync(LORE_FILE, '# 我的手写世界书\n\n## 我自己的条目\n<!-- keys: 自有 -->\n别动我。\n', 'utf8');
  // ② 另外在工作区**根目录**留一份旧版共享世界书（历史遗留：谁都能往里写，混着好几个会话的条目）。
  //    它**绝不能被任何会话自动继承** —— 这正是「新会话也有别人词条」那次的根因。
  const LEGACY_FILE = join(ws, 'rp-worldbook.md');
  writeFileSync(LEGACY_FILE, '# 旧版共享世界书\n\n## 别人的条目\n<!-- keys: 别人 -->\n这是别的会话写的。\n', 'utf8');
  await callPost('/rp-tools/dm-mark', { sessionId: IMPORT_SID, preset: 'dm' });

  const imported = await callPost('/rp-tools/card-import', { sessionId: IMPORT_SID, workspace: ws, path: rel });
  check('card-import status=200', imported.status, 200);
  check('导入：ok', imported.json.ok, true);
  check('导入：角色名', imported.json.character?.name, '烟测卡');
  check('导入：世界书新增 1 条', imported.json.lore?.added, 1);
  check('导入：世界书写进本会话自己的目录', imported.json.files?.world, `rp-sessions/${IMPORT_SID}/rp-worldbook.md`);
  check('导入：世界书文件真的在会话目录里', existsSync(LORE_FILE), true);
  check('导入：旧的共享世界书没被改写', readFileSync(LEGACY_FILE, 'utf8').includes('烟测条目'), false);
  check('导入：旧共享文件的条目没被自动继承', readFileSync(LORE_FILE, 'utf8').includes('别人的条目'), false);
  check('导入：全文文件已写出（写在会话目录里）', existsSync(join(ws, 'rp-sessions', IMPORT_SID, 'cards', '烟测卡.card.md')), true);
  check('导入：卡 JSON 已写出', existsSync(join(ws, 'rp-sessions', IMPORT_SID, 'cards', '烟测卡.card.json')), true);
  check('导入：卡面已复制（当立绘）', existsSync(join(ws, 'rp-sessions', IMPORT_SID, 'cards', '烟测卡.card.png')), true);
  check('导入：立绘登记在会话里', imported.json.files?.image, `rp-sessions/${IMPORT_SID}/cards/烟测卡.card.png`);
  // 开局消息：**只发一个指针**（计划 §4）—— 不内联开场白、不附全量整理任务
  check('导入：返回开场指令', String(imported.json.opening).includes('【开局】'), true);
  check('导入：开场指令指向 launch 文件',
    String(imported.json.opening).includes(`rp-sessions/${IMPORT_SID}/cards/烟测卡.card.launch.md`), true);
  check('导入：开场指令很短（<500 字）', String(imported.json.opening).length < 500, true);
  check('导入：开场指令不内联开场白原文', String(imported.json.opening).includes('开场白一'), false);
  check('导入：开局消息里不出现全量整备', String(imported.json.opening).includes('【设定整备】'), false);

  const wbText = readFileSync(LORE_FILE, 'utf8');
  check('导入：本会话原有的手写条目还在', wbText.includes('我自己的条目'), true);
  check('导入：新条目被追加', wbText.includes('烟测条目'), true);
  check('导入：原有条目只出现一次', wbText.split('我自己的条目').length - 1, 1);

  const sess = await callGet('/rp-tools/session', `?sessionId=${IMPORT_SID}`);
  check('导入：会话角色卡已写入', sess.json.session?.characters?.[0]?.name, '烟测卡');
  check('导入：会话世界已写入', String(sess.json.session?.world).includes('情境正文'), true);
  check('导入：会话世界里保留 {{user}} 交给宿主插值', String(sess.json.session?.world).includes('{{user}}站在门外'), true);
  check('导入：返回占位符统计', (imported.json.placeholders?.total ?? 0) >= 2, true);
  // 开场白引导文件：全部开场白都写进去（不截断），DM 需要时自己 read
  check('导入：写出开场白引导文件', existsSync(join(ws, 'rp-sessions', IMPORT_SID, 'cards', '烟测卡.card.opening.md')), true);
  check('导入：结果里有引导文件路径', imported.json.files?.opening, `rp-sessions/${IMPORT_SID}/cards/烟测卡.card.opening.md`);
  // 开局引导文件（§4）：launch 文件真的落盘，且含「选定开场 + 文件清单 + 不要再问世界从哪来」
  check('导入：写出开局引导文件', existsSync(join(ws, 'rp-sessions', IMPORT_SID, 'cards', '烟测卡.card.launch.md')), true);
  check('导入：结果里有 launch 路径', imported.json.files?.launch, `rp-sessions/${IMPORT_SID}/cards/烟测卡.card.launch.md`);
  {
    const launchText = readFileSync(join(ws, 'rp-sessions', IMPORT_SID, 'cards', '烟测卡.card.launch.md'), 'utf8');
    check('导入：launch 含选定开场', launchText.includes('## 选定开场'), true);
    check('导入：launch 给出全部开场白文件', launchText.includes('烟测卡.card.opening.md'), true);
    check('导入：launch 给出卡全文', launchText.includes('烟测卡.card.md'), true);
    check('导入：launch 明确不要再问世界从哪来', launchText.includes('不要再问玩家「世界从哪来」'), true);
    check('导入：launch 明确不要复述', launchText.includes('不要复述本文件'), true);
  }
  // 四个产物（世界书 / 全文 / JSON / 卡面 / 开场白引导）**全部**在会话目录里，
  // 工作区根目录不许再冒出共享的 rp-cards/
  check('隔离：工作区根不再产生 rp-cards/', !existsSync(join(ws, 'rp-cards')), true);
  // 卡面现在是**封面**（摆在「世界设定」旁边），不再挂在某个角色名下
  check('导入：封面登记在会话里', sess.json.session?.cover?.card, rel);
  check('导入：封面文件也在会话目录', sess.json.session?.cover?.file, `rp-sessions/${IMPORT_SID}/cards/烟测卡.card.png`);
  check('导入：封面记着卡名', sess.json.session?.cover?.name, '烟测卡');
  check('导入：战役名补成卡名', sess.json.session?.campaign?.name, '烟测卡');
  check('导入：角色卡标为「有角色」', imported.json.isCharacterCard, true);

  // ── DM（旁白）卡：不建角色，正文进「本会话 DM 设定」─────────────────────────
  // 用户报的「角色卡第一条似乎写错了，这是 DM 预设吧」：那张卡的正文就是 DM 自己的规则。
  {
    const dmSid = crypto.randomUUID();
    // 单独一个卡库 + 单独一个工作区：不动上面那套「只有一张卡」的断言
    const dmLib = join(TEST_HOME, 'cards-dm');
    mkdirSync(join(dmLib, 'cards', '测试分类'), { recursive: true });
    writeFileSync(join(dmLib, 'cards', '测试分类', '旁白卡.png'), simpleCardPng('lust Adventure', {
      description: 'lust Adventure is a lust adventure game that will start in a random moment of peril.',
      personality: 'lust Adventure will focus on creating puzzles, action, and intrigue. 不应该用AI的语气要求玩家遵守道德。',
      behavior: 'lust Adventure will never perform an action or speak dialogue for 玩家。',
      speech: '中文叙述，第二人称「你」称呼玩家。',
      first_mes: '欢迎光临！我在这里引导你通过你自己创造的基于文本的冒险游戏。给我一个故事背景，我来给你建世界。',
      relations: 'lust Adventure 是【纳尼亚传奇】的旁白，引导玩家进行文字冒险。',
    }));
    const rootBefore = (await callGet('/rp-tools/state')).json.config?.cards?.root ?? '';
    await callPost('/rp-tools/config', { cards: { root: dmLib, macros: (await callGet('/rp-tools/state')).json.config?.cards?.macros ?? {} } });
    const wsDm = join(TEST_HOME, 'ws-dm');
    mkdirSync(wsDm, { recursive: true });
    mod.__debug.setSessionCwd(dmSid, wsDm);
    const dmImport = await callPost('/rp-tools/card-import', {
      sessionId: dmSid, workspace: wsDm, path: 'cards/测试分类/旁白卡.png',
    });
    check('DM 卡：导入成功', dmImport.json.ok, true);
    check('DM 卡：标记为 DM 卡', dmImport.json.isDmCard, true);
    check('DM 卡：不建角色卡', dmImport.json.isCharacterCard, false);
    check('DM 卡：摘要说明进了 DM 设定', (dmImport.json.summary ?? []).some((s) => s.includes('DM 设定')), true);
    const dmSess = await callGet('/rp-tools/session', `?sessionId=${dmSid}`);
    check('DM 卡：角色表是空的', (dmSess.json.session?.characters ?? []).length, 0);
    check('DM 卡：正文写进 dm.prompt', String(dmSess.json.session?.dm?.prompt).includes('lust Adventure'), true);
    check('DM 卡：dm.prompt 带分节标题', String(dmSess.json.session?.dm?.prompt).includes('## 语气与叙述'), true);
    check('DM 卡：战役名用卡名兜底', dmSess.json.session?.campaign?.name, 'lust Adventure');
    await callPost('/rp-tools/config', { cards: { root: rootBefore, macros: (await callGet('/rp-tools/state')).json.config?.cards?.macros ?? {} } });

    // 老数据迁移：把 DM 卡当成角色存下来的会话，读出来时应当自动挪到 dm.prompt
    const legacy = {
      sessionId: 'legacy-dm-card', characters: [
        { name: 'lust Adventure', personality: 'lust Adventure will focus on creating puzzles. 不应该用AI的语气。' },
        { name: '弥珥·索兰', personality: '安静、守规矩的候补圣女。' },
      ],
    };
    mkdirSync(join(TEST_HOME, 'data', 'dsh-rp-tools', 'sessions'), { recursive: true });
    writeFileSync(join(TEST_HOME, 'data', 'dsh-rp-tools', 'sessions', 'legacy-dm-card.json'), JSON.stringify(legacy));
    const migrated = mod.__debug.loadSession('legacy-dm-card');
    check('迁移：DM 卡不再占角色表', migrated.characters.map((c) => c.name).join(), '弥珥·索兰');
    check('迁移：正文挪进了 dm.prompt', migrated.dm.prompt.includes('lust Adventure'), true);
    check('迁移：记下迁移了哪条（界面要提示）', (migrated.dm.migrated ?? []).join(), 'lust Adventure');
    check('迁移：正常角色不受影响', mod.__debug.isDmCardData({ name: '弥珥·索兰', personality: '安静、守规矩的候补圣女。' }), false);
  }

  // ── DM 设定（会话隔离）：正文读写与注入 ───────────────────────────────────
  {
    const dmSid2 = crypto.randomUUID();
    mod.__debug.setSessionCwd(dmSid2, ws);
    const put = await callPost('/rp-tools/session', {
      sessionId: dmSid2,
      dm: { prompt: '本会话的 DM 规则：中立裁决，每轮结尾给 3 个选项。', images: { enabled: true, firstAppearance: true, keyScenes: false } },
    });
    check('DM 设定：保存成功', put.json.ok, true);
    check('DM 设定：正文落盘', String(put.json.session?.dm?.prompt).includes('中立裁决'), true);
    // `dm.images`（本会话生图开关）已随本地生图一起作废：老数据里可能还留着，
    // 但 `loadSession` 不再解析它，所以送上来也不该再出现（留着会让「这插件还能出图」的假象留在盘上）。
    check('DM 设定：已删的生图开关不再落盘', put.json.session?.dm?.images, undefined);
    const back = await callGet('/rp-tools/session', `?sessionId=${dmSid2}`);
    check('DM 设定：读回来一致', String(back.json.session?.dm?.prompt).includes('中立裁决'), true);
    // 注入：已有立绘地址 + DM 正文都要进常驻段（DM 才知道该用哪张图、按什么规则带团）
    const sessObj = { ...back.json.session, portraits: { 弥珥: { card: 'x/弥珥.png' } } };
    const standing = mod.__debug.buildStandingText(sessObj, {});
    check('DM 设定：进了常驻段', standing.includes('【本会话设定】'), true);
    check('DM 设定：正文进常驻段', standing.includes('中立裁决'), true);
    // 「生图：开/关」那行没了；取而代之的是一句配图指路（本插件不出图）
    check('DM 设定：常驻段不再有生图开关行', standing.includes('生图：'), false);
    check('DM 设定：常驻段指向宿主的 generate_image', standing.includes('generate_image'), true);
    check('DM 设定：已有立绘给出可直接用的地址', standing.includes('/rp-tools/card-image?path=x%2F%E5%BC%A5%E7%8F%A5.png'), true);
    check('DM 设定：明说先找现成的、不要再生成', standing.includes('有就直接展示，不要重新生成'), true);
    // **立绘复用**（用户要求）：导入卡的卡面就是它的立绘 —— 常驻段要把它列成可用图，
    // DM 第一次出场直接展示这张，不再花 15~25 秒重出一张。
    {
      const withCover = mod.__debug.buildStandingText({
        ...sessObj,
        portraits: {},
        characters: [{ name: '星渊', appearance: '黑发红斗篷' }],
        cover: { card: '2025/RPG/星渊.png', file: 'rp-sessions/x/cards/星渊.png', name: '星渊' },
      }, {});
      check('立绘复用：卡面被列成可用图（认给同名角色）', withCover.includes('星渊（卡面＝立绘）'), true);
      check('立绘复用：给的是卡面路由地址', withCover.includes('/rp-tools/card-image?path=2025%2FRPG%2F%E6%98%9F%E6%B8%8A.png'), true);
      // 卡名与角色名不同、但只有一个角色 → 也认给它（一对一的角色卡最常见）
      const oneChar = mod.__debug.buildStandingText({
        ...sessObj,
        portraits: {},
        characters: [{ name: '星渊' }],
        cover: { card: 'a/b.png', name: '某个卡名' },
      }, {});
      check('立绘复用：只有一个角色时也算它的', oneChar.includes('星渊（卡面＝立绘）'), true);
      // 故事书（多个角色、卡名对不上）→ 不硬塞给某个角色，只当一张可用图列出
      const multi = mod.__debug.buildStandingText({
        ...sessObj,
        portraits: {},
        characters: [{ name: '甲' }, { name: '乙' }],
        cover: { card: 'a/b.png', name: '某故事书' },
      }, {});
      check('立绘复用：认不出归属时只列成卡面', multi.includes('卡面《某故事书》'), true);
      check('立绘复用：认不出归属时不硬塞给角色', multi.includes('（卡面＝立绘）'), false);
      // ⚠️ 「已经有 generated 立绘时不再列卡面」这条断言**已作废**：`generated`（老版本存的
      // ComfyUI 三要素）媒体代理删掉之后就是死引用，`renderDmSetup` 只认 `imported` 与 `card`。
      // 所以现在「只有 generated」等于「一张可用图都没有」→ 卡面照样列出来，这是**对的**
      // （否则老会话会变成一张图都不给 DM，而它磁盘上其实有那张卡面）。
      const legacyGen = mod.__debug.buildStandingText({
        ...sessObj,
        portraits: { 星渊: { generated: { file: 'p.png', subfolder: '', type: 'output' } } },
        characters: [{ name: '星渊' }],
        cover: { card: 'a/b.png', name: '星渊' },
      }, {});
      check('立绘复用：只有死引用 generated 时仍列出卡面', legacyGen.includes('星渊（卡面＝立绘）'), true);
      check('立绘复用：死引用 generated 不会被当成可用图', legacyGen.includes('/rp-tools/media?'), false);
    }
    // 没有任何世界观内容时，标题不该是「世界观已确立」
    const bare = mod.__debug.buildStandingText({ sessionId: 'x', dm: { prompt: '' } }, {});
    check('只有 DM 设定时不谎称世界观已确立', bare.includes('本场跑团的世界观'), false);
    check('只有 DM 设定时仍有「本会话设定」', bare.includes('## 本会话设定'), true);
  }

  // ── 故事书：卡里没有角色字段 → **不建人物**（别把书名当人物）────────────────
  // 用户报的「标题不是角色卡」：`下班，然后成为魔法少女` 那种书名原先会进人物列表。
  {
    const storyRel = 'cards/测试分类/故事书.png';
    writeFileSync(join(libRoot, 'cards', '测试分类', '故事书.png'), simpleCardPng('下班，然后成为魔法少女', {
      scenario: '都市夜景，魔法少女在加班。',
      character_book: { entries: [{ name: '世界观', keys: ['魔法'], content: '魔法少女也要打卡。' }] },
    }));
    const storySid = crypto.randomUUID();
    await callPost('/rp-tools/dm-mark', { sessionId: storySid, preset: 'dm' });
    const story = await callPost('/rp-tools/card-import', { sessionId: storySid, workspace: ws, path: storyRel });
    check('故事书：导入成功', story.status, 200);
    check('故事书：标为「不是角色卡」', story.json.isCharacterCard, false);
    check('故事书：世界书照常导入', story.json.lore?.added, 1);
    const storySess = await callGet('/rp-tools/session', `?sessionId=${storySid}`);
    check('故事书：没有建人物', (storySess.json.session?.characters ?? []).length, 0);
    check('故事书：也没登记立绘（没有人物可挂）', Object.keys(storySess.json.session?.portraits ?? {}).length, 0);
    // 源文件名是 故事书.png（没有 .card 标记）→ slug 就是「故事书」，落到 故事书.png
    check('故事书：卡面仍然复制到会话目录', existsSync(join(ws, 'rp-sessions', storySid, 'cards', '故事书.png')), true);
    check('故事书：世界设定里标的是「故事书」', String(story.json.world).includes('【故事书】'), true);
    check('故事书：summary 说明了原因', String(story.json.summary).includes('不建角色卡'), true);
    check('故事书：封面照样登记（世界设定旁边那张图）', story.json.cover?.card, storyRel);
    check('故事书：封面文件也在会话目录', existsSync(join(ws, 'rp-sessions', storySid, 'cards', '故事书.png')), true);
    // ★ 真事故那张卡的形状：只有 first_mes（故事开场白）+ 世界书 → **不能**建角色卡
    const openingRel = 'cards/测试分类/只有开场白.png';
    writeFileSync(join(libRoot, 'cards', '测试分类', '只有开场白.png'), simpleCardPng('下班，然后成为魔法少女。', {
      first_mes: '（206 字的故事开场）',
      character_book: { entries: [{ name: '世界观', keys: ['魔法'], content: '魔法少女也要打卡。' }] },
    }));
    const openSid = crypto.randomUUID();
    await callPost('/rp-tools/dm-mark', { sessionId: openSid, preset: 'dm' });
    const opening = await callPost('/rp-tools/card-import', { sessionId: openSid, workspace: ws, path: openingRel });
    check('只有开场白的卡：也没建角色卡', opening.json.isCharacterCard, false);
    check('只有开场白的卡：角色表为空', ((await callGet('/rp-tools/session', `?sessionId=${openSid}`)).json.session?.characters ?? []).length, 0);
  }

  // 同一个会话再导一次：同名条目不该重复（幂等）
  const again = await callPost('/rp-tools/card-import', { sessionId: IMPORT_SID, workspace: ws, path: rel });
  check('重复导入：新增 0 条', again.json.lore?.added, 0);
  check('重复导入：跳过 1 条', again.json.lore?.skipped, 1);
  check('重复导入：角色不重复', (await callGet('/rp-tools/session', `?sessionId=${IMPORT_SID}`)).json.session.characters.length, 1);

  // 拿不到工作区时必须明确报错（不能闷头写到别处）
  const nowhere = await callPost('/rp-tools/card-import', { sessionId: crypto.randomUUID(), path: rel });
  check('导入：没有工作区时报 400', nowhere.status, 400);
  check('导入：错误说明缺工作区', String(nowhere.json.error).includes('工作区'), true);

  // ★ 闭环断言：导入的世界书**真的会进本轮注入**
  // 缺了这条，前面全绿也可能只是「文件写对了、但装配时根本没读它」——
  // 世界书路径 / 会话工作区 / 触发词三者只要有一处对不上，导入就是白导。
  mod.__debug.setSessionCwd(IMPORT_SID, ws);
  const sessObj = (await callGet('/rp-tools/session', `?sessionId=${IMPORT_SID}`)).json.session;
  const turnHit = mod.__debug.buildTurnContext(sessObj, '我们来聊聊烟测这件事', { sessionId: IMPORT_SID, turn: 3 });
  check('导入的世界书按触发词进注入', turnHit.includes('{{user}}来到烟测卡的门前'), true);
  const turnMiss = mod.__debug.buildTurnContext(sessObj, '完全无关的一句话', { sessionId: IMPORT_SID, turn: 3 });
  check('没命中触发词就不注入该条目', turnMiss.includes('烟测卡的门前'), false);
  const standing = mod.__debug.buildStandingText(sessObj);
  check('导入的世界设定进了常驻段', standing.includes('情境正文'), true);
  check('导入的角色卡进了角色索引', standing.includes('烟测卡'), true);
  // 注入端只放行**已注册**的宏（user / 本会话宏表），其余一律中和成安全文本
  check('注入文本里只留已注册的 {{user}}', /\{\{(?!user\})/.test(`${turnHit}${standing}`), false);

  // ── 世界书面板数据源：/rp-tools/lore ────────────────────────────────
  const loreRes = await callGet('/rp-tools/lore', `?sessionId=${IMPORT_SID}&workspace=${encodeURIComponent(ws)}`);
  check('lore 路由 status=200', loreRes.status, 200);
  check('lore：条数与文件一致', loreRes.json.total, 2);   // 用户手写 1 条 + 导入 1 条
  check('lore：能列出导入的条目', loreRes.json.entries?.some((e) => e.title === '烟测条目'), true);
  const loreEntry = loreRes.json.entries?.find((e) => e.title === '烟测条目');
  check('lore：条目带触发词', loreEntry?.keys, ['烟测']);
  check('lore：正文里保留 {{user}}', String(loreEntry?.preview).includes('{{user}}来到烟测卡的门前'), true);
  check('lore：能列出用户手写的条目', loreRes.json.entries?.some((e) => e.title === '我自己的条目'), true);
  check('lore：给出文件绝对路径', typeof loreRes.json.file === 'string' && loreRes.json.file.endsWith('rp-worldbook.md'), true);
  check('lore：文件在会话自己的目录里（不是工作区根）', String(loreRes.json.file).includes(IMPORT_SID), true);
  // 面板顶部那行数字：常驻体积（每轮注入）与空壳条目（被过滤掉的）都要能从响应里拿到
  check('lore：回传每轮注入的常驻体积（此刻没有常驻条目 → 0）', loreRes.json.constantChars, 0);
  check('lore：回传空壳条数', loreRes.json.empty, 0);
  check('lore：每条都带 empty 标记', loreEntry?.empty, false);
  check('lore：每条都带类别标签', typeof loreEntry?.kind === 'string' && loreEntry.kind.length > 0, true);
  const loreMissing = await callGet('/rp-tools/lore', `?sessionId=${crypto.randomUUID()}`);
  check('lore：拿不到工作区时不报错、只说明', loreMissing.json.exists, false);

  // ── 设定整备指令（面板「整理设定」按钮的数据源）────────────────────────
  // 导入是**规则解码**：「当前进度 / 前情提要 / 物品清单」这类会过期的条目也会被导进来，
  // 得让 DM 做一次整理（用户要求：「开局第一轮提示 DM 完善角色卡和世界书」）。
  {
    const tidy = await callPost('/rp-tools/tidy', { sessionId: IMPORT_SID });
    check('tidy 路由：200', tidy.status, 200);
    check('tidy：说明只做这一件事（不是开局场景）', String(tidy.json.text).includes('只做这一件事'), true);
    check('tidy：带上本会话的世界书路径', String(tidy.json.text).includes(String(IMPORT_SID)), true);
    check('tidy：列出条目名供对照', String(tidy.json.text).includes('烟测条目'), true);
    check('tidy：要求角色字段归位', String(tidy.json.text).includes('appearance'), true);
    check('tidy：给出条目数', tidy.json.entries, 2);
    const badTidy = await callPost('/rp-tools/tidy', { sessionId: IMPORT_SID }, 'http://evil.example');
    check('tidy：跨域被拒', badTidy.status, 403);
  }

  // ── 世界书编辑（面板里的「编辑 / 常驻开关 / 新建 / 删除」走这条路由）──────
  {
    const read = () => readFileSync(LORE_FILE, 'utf8');
    // ① 取单条完整正文（列表只给 160 字预览，编辑器要全文）
    const one = await callGet('/rp-tools/lore', `?sessionId=${IMPORT_SID}&title=${encodeURIComponent('烟测条目')}`);
    check('lore 详情：取到完整正文', String(one.json.entry?.body).includes('{{user}}来到烟测卡的门前'), true);
    check('lore 详情：带触发词', one.json.entry?.keys?.[0], '烟测');
    const notFound = await callGet('/rp-tools/lore', `?sessionId=${IMPORT_SID}&title=${encodeURIComponent('不存在的条目')}`);
    check('lore 详情：找不到时报 404', notFound.status, 404);

    // ② 改「常驻」+ 触发词 + order + 概率 + 正文（就地开关走的就是这条路径）
    const upd = await callPost('/rp-tools/lore', {
      sessionId: IMPORT_SID, action: 'update', title: '烟测条目',
      entry: { title: '烟测条目', keys: '烟测、烟测别名', constant: true, order: 5, probability: 60, body: '改过的正文。' },
    });
    check('lore 编辑：update 成功', upd.json.ok, true);
    check('lore 编辑：回传最新条目数', upd.json.total, 2);
    const after = mod.__debug.parseLoreMarkdown(read()).find((e) => e.title === '烟测条目');
    check('lore 编辑：常驻已写入', after?.constant, true);
    check('lore 编辑：触发词已写入（顿号分隔也认）', after?.keys, ['烟测', '烟测别名']);
    check('lore 编辑：order 已写入', after?.order, 5);
    check('lore 编辑：概率已写入', after?.probability, 60);
    check('lore 编辑：正文已写入', after?.body, '改过的正文。');
    check('lore 编辑：用户手写的条目还在', read().includes('别动我。'), true);
    check('lore 编辑：手写条目的注释头原样保留', read().includes('<!-- keys: 自有 -->'), true);

    // ③ 新建 / 重名挡住 / 改名
    const add = await callPost('/rp-tools/lore', {
      sessionId: IMPORT_SID, action: 'add',
      entry: { title: '新增条目', keys: [], constant: false, body: '新正文' },
    });
    check('lore 编辑：add 成功', add.json.ok, true);
    check('lore 编辑：条目数 +1', add.json.total, 3);
    const dup = await callPost('/rp-tools/lore', { sessionId: IMPORT_SID, action: 'add', entry: { title: '新增条目', body: 'x' } });
    check('lore 编辑：重名 add 被拒', dup.status, 400);
    const noTitle = await callPost('/rp-tools/lore', { sessionId: IMPORT_SID, action: 'add', entry: { body: 'x' } });
    check('lore 编辑：无标题 add 被拒', noTitle.status, 400);
    const rename = await callPost('/rp-tools/lore', {
      sessionId: IMPORT_SID, action: 'update', title: '新增条目',
      entry: { title: '改名后的条目', body: '新正文' },
    });
    check('lore 编辑：改名成功', rename.json.ok, true);
    check('lore 编辑：旧名已消失', read().includes('## 新增条目'), false);
    check('lore 编辑：新名已就位', read().includes('## 改名后的条目'), true);

    // ④ 删除只删这一条；跨域写入必须被挡
    const del = await callPost('/rp-tools/lore', { sessionId: IMPORT_SID, action: 'delete', title: '改名后的条目' });
    check('lore 编辑：delete 成功', del.json.ok, true);
    check('lore 编辑：条目数回到 2', del.json.total, 2);
    check('lore 编辑：正文里也没有残留', read().includes('新正文'), false);
    const delMissing = await callPost('/rp-tools/lore', { sessionId: IMPORT_SID, action: 'delete', title: '早就不在了' });
    check('lore 编辑：删不存在的条目报 400', delMissing.status, 400);
    const crossOrigin = await callPost('/rp-tools/lore', { sessionId: IMPORT_SID, action: 'delete', title: '我自己的条目' }, 'http://evil.example');
    check('lore 编辑：跨域写入被拒', crossOrigin.status, 403);
    check('lore 编辑：跨域那次没删掉', read().includes('我自己的条目'), true);

    // ⑤ 属性中文化：把老世界书里的 name: / gender: Female 一次性改成中文
    const twisted = await callPost('/rp-tools/lore', {
      sessionId: IMPORT_SID, action: 'update', title: '烟测条目',
      entry: { title: '烟测条目', keys: '烟测', body: 'name: 慕容嫣\ngender: Female\nage: 17' },
    });
    check('属性中文化：先造一条英文键的正文', twisted.json.ok, true);
    const loc = await callPost('/rp-tools/lore', { sessionId: IMPORT_SID, action: 'localize' });
    check('属性中文化：执行成功', loc.json.ok, true);
    check('属性中文化：只动改了的那条', loc.json.changed, 1);
    check('属性中文化：统计改写行数', loc.json.lines, 3);
    const locText = read();
    check('属性中文化：name → 名称', locText.includes('名称：慕容嫣'), true);
    check('属性中文化：gender 值也翻了', locText.includes('性别：女'), true);
    check('属性中文化：不再有英文键', /^gender:/m.test(locText), false);
    check('属性中文化：触发词注释没被动', locText.includes('keys: 烟测'), true);
    check('属性中文化：用户手写条目仍在', locText.includes('我自己的条目'), true);
    // 再跑一次：没有可改的了，不许报错
    const loc2 = await callPost('/rp-tools/lore', { sessionId: IMPORT_SID, action: 'localize' });
    check('属性中文化：重复执行是幂等的', loc2.json.changed, 0);
  }

  // ── ★ 会话隔离回归：同工作区的两个会话绝不能共享世界书 ──────────────────
  // 用户报过的事故：世界书原先放在**工作区根目录**，而工作区是按目录共享的，
  // 于是 A 会话导入的卡组条目出现在了 B 会话的上下文里（两个会话混在一起）。
  {
    const sidB = crypto.randomUUID();
    await callPost('/rp-tools/dm-mark', { sessionId: sidB, preset: 'dm' });
    const loreB = await callGet('/rp-tools/lore', `?sessionId=${sidB}&workspace=${encodeURIComponent(ws)}`);
    check('隔离：B 会话拿到的是自己的世界书文件', String(loreB.json.file).includes(sidB), true);
    check('隔离：B 会话看不到 A 会话导入的条目', loreB.json.entries?.some((e) => e.title === '烟测条目'), false);
    check('隔离：B 会话看不到 A 手写的条目', loreB.json.entries?.some((e) => e.title === '我自己的条目'), false);
    // ★ 这条是「新会话被污染」那次的回归：工作区根目录的旧共享世界书**不许自动继承**，
    //   新会话的世界书必须是空的（只提示旧文件存在，要不要并进来由用户点）。
    check('隔离：新会话的世界书是空的（旧共享文件不自动继承）', loreB.json.total, 0);
    check('隔离：提示存在旧版共享世界书', loreB.json.legacyExists, true);
    check('隔离：给出旧文件路径', String(loreB.json.legacy).endsWith('rp-worldbook.md'), true);
    // 用户显式点「并入本会话」时才把旧条目搬过来
    const mergeB = await callPost('/rp-tools/lore', { sessionId: sidB, workspace: ws, action: 'importLegacy', legacyFile: LEGACY_FILE });
    check('隔离：显式并入旧世界书成功', mergeB.json.ok, true);
    check('隔离：并入了 1 条', mergeB.json.imported, 1);
    check('隔离：并入后能看到旧条目', mergeB.json.entries?.some((e) => e.title === '别人的条目'), true);
    check('隔离：A 那边不受影响（没有别人的条目）', (await callGet('/rp-tools/lore', `?sessionId=${IMPORT_SID}&workspace=${encodeURIComponent(ws)}`)).json.entries?.some((e) => e.title === '别人的条目'), false);

    // B 自己建一条，A 那边不受影响
    const addB = await callPost('/rp-tools/lore', {
      sessionId: sidB, workspace: ws, action: 'add',
      entry: { title: 'B会话的条目', keys: ['只有B'], body: 'B 的正文' },
    });
    check('隔离：B 能写自己的世界书', addB.json.ok, true);
    check('隔离：B 的文件在自己的目录里', String(addB.json.file).includes(sidB), true);
    const loreA = await callGet('/rp-tools/lore', `?sessionId=${IMPORT_SID}&workspace=${encodeURIComponent(ws)}`);
    check('隔离：A 的条目列表里没有 B 的条目', loreA.json.entries?.some((e) => e.title === 'B会话的条目'), false);
    check('隔离：A 的条目数没变', loreA.json.total, 2);

    // 注入层也要隔离：B 的装配不该命中 A 的世界书
    mod.__debug.setSessionCwd(sidB, ws);
    const sessB = (await callGet('/rp-tools/session', `?sessionId=${sidB}`)).json.session;
    const turnB = mod.__debug.buildTurnContext(sessB, '我们来聊聊烟测这件事', { sessionId: sidB, turn: 3 });
    check('隔离：B 的本轮注入里没有 A 的世界书条目', turnB.includes('烟测'), false);
    const standB = mod.__debug.buildStandingText(sessB, { loreFile: join(ws, 'rp-sessions', sidB, 'rp-worldbook.md') });
    check('隔离：常驻段会给出本会话自己的世界书路径', standB.includes(sidB), true);
  }

  // ── 宏表（按会话隔离）：面板/导入表单写进来的值 ──────────────────────
  {
    const sid = crypto.randomUUID();
    await callPost('/rp-tools/dm-mark', { sessionId: sid, preset: 'dm' });
    const saved = await callPost('/rp-tools/session', {
      sessionId: sid, world: '去{{place}}找{{rival}}，{{user}}',
      macros: { user: '阿岚', place: '广寒宫' },
    });
    check('宏：写入会话成功', saved.json.ok, true);
    check('宏：回读 user', saved.json.session.macros.user, '阿岚');
    check('宏：回读 place', saved.json.session.macros.place, '广寒宫');
    const bad = await callPost('/rp-tools/session', { sessionId: sid, macros: { '坏 名字': 'x', Good: 'y' } });
    // 会话路由的语义是**整体替换**（面板提交的就是完整表）；非法名字被丢掉、大写被规范化
    check('宏：非法名字被丢掉', Object.keys(bad.json.session.macros).sort().join(','), 'good');
    check('宏：大写名字被规范化', bad.json.session.macros.good, 'y');
    // 注入文本里，已注册的宏保留原文（交给宿主变量），未注册的中和
    const sess = (await callGet('/rp-tools/session', `?sessionId=${sid}`)).json.session;
    const stand = mod.__debug.buildStandingText(sess, { macros: new Set(['user', 'place']) });
    check('宏：已注册的 {{user}} 保留', stand.includes('{{user}}'), true);
    check('宏：已注册的 {{place}} 保留', stand.includes('{{place}}'), true);
    const stand2 = mod.__debug.buildStandingText(sess, { macros: new Set(['user']) });
    check('宏：未注册的 {{place}} 被中和', /｛｛place｝｝/.test(stand2), true);
    check('宏：中和后 {{user}} 仍在', stand2.includes('{{user}}'), true);
    // 自动宏（time/date/…）：永远注册、值当场算，用户不用填
    check('宏：自动宏默认放行', /\{\{time\}\}/.test(mod.__debug.neutralizeMustache('现在是 {{time}}')), true);
    check('宏：自动宏 date 算出日期', /^\d{4}-\d{2}-\d{2}$/.test(mod.__debug.autoMacroValue('date')), true);
    check('宏：自动宏 time 算出时刻', /^\d{2}:\d{2}$/.test(mod.__debug.autoMacroValue('time')), true);
    check('宏：宏表里的固定值覆盖自动宏（钉死游戏内时间）', mod.__debug.autoMacroValue('time', { time: '子时三刻' }), '子时三刻');
    check('宏：自动宏清单里有 time/date', mod.__debug.AUTO_MACROS.includes('time') && mod.__debug.AUTO_MACROS.includes('date'), true);
    // 未注册的宏进不了 renderPrompt（宿主严格插值会抛错），所以中和是必须的兜底
    check('宏：中和函数把不认识的宏全转全角', /\{\{/.test(mod.__debug.neutralizeMustache('{{a}} {{b}}', new Set())), false);
  }

  // 卡面路由：只服务卡库内的 png
  const imgRoute = routes.get('/rp-tools/card-image');
  const imgRes = mkRes();
  imgRoute.handler({ method: 'GET', url: `/rp-tools/card-image?path=${encodeURIComponent(rel)}`, headers: {} }, imgRes);
  check('卡面路由 status=200', imgRes.out.status, 200);
  const imgEscape = mkRes();
  imgRoute.handler({ method: 'GET', url: '/rp-tools/card-image?path=..%2F..%2Fsecret.png', headers: {} }, imgEscape);
  check('卡面路由：路径逃逸被拒', imgEscape.out.status, 400);

  // ── 缩略图（预览区选中卡片时只看一眼封面；卡 PNG 单张可能几 MB）──────────
  {
    const { cardImagePng } = await import(pathToFileURL(join(here, 'png-fixture.mjs')).href);
    const bigRel = 'cards/测试分类/大图卡.png';
    writeFileSync(join(libRoot, 'cards', '测试分类', '大图卡.png'), cardImagePng('大图卡', 128, 128));
    const full = await callGetRaw(`/rp-tools/card-image?path=${encodeURIComponent(bigRel)}`);
    // 取 width=64：源图 128 → 整数倍 2 → 结果 64（宿主对 width 有 48 的下限，别取更小）
    const small = await callGetRaw(`/rp-tools/card-image?path=${encodeURIComponent(bigRel)}&thumb=1&width=64`);
    check('缩略图：原图能取到', full.status, 200);
    check('缩略图：源图尺寸就是 128', full.bytes.readUInt32BE(16), 128);
    check('缩略图：thumb=1 返回成功', small.status, 200);
    check('缩略图：体积比原图小', small.bytes.length < full.bytes.length, true);
    check('缩略图：仍然是一张 PNG', small.bytes.subarray(0, 4).toString('latin1'), '\u0089PNG');
    // 宽度对齐：thumb 的 IHDR 在签名(8)+长度(4)+类型(4)=16 偏移处放宽度
    check('缩略图：宽度按 width 降采样', small.bytes.readUInt32BE(16), 64);
    // 请求的宽度比源图还大 → 没必要缩放，回退原图（同样是 200，字节等于原图）
    const noNeed = await callGetRaw(`/rp-tools/card-image?path=${encodeURIComponent(bigRel)}&thumb=1&width=1000`);
    check('缩略图：本来就够大则回退原图', noNeed.bytes.length, full.bytes.length);
    // 没有像素数据的卡（夹具的 simpleCardPng）→ 回退原图，不许报错
    const plainFull = await callGetRaw(`/rp-tools/card-image?path=${encodeURIComponent(rel)}`);
    const plainThumb = await callGetRaw(`/rp-tools/card-image?path=${encodeURIComponent(rel)}&thumb=1&width=64`);
    check('缩略图：解不了就回退原图（不报错）', plainThumb.status, 200);
    check('缩略图：回退时字节数与原图一致', plainThumb.bytes.length, plainFull.bytes.length);
  }
}

// ── 老配置迁移（放最后：它会**直接改写 styles.json**，前面那些用例依赖完整配置）──
// 1.8.8 之前存的配置没有 `macrosSeeded`：打开一次就该补上 `user -> 玩家`，
// 而且是**一次性**的 —— 用户删掉这条之后不会再被塞回来。
{
  writeFileSync(
    join(TEST_HOME, 'data', 'dsh-rp-tools', 'styles.json'),
    JSON.stringify({ cards: { root: '', userLabel: '', macros: {} } }, null, 2),
    'utf8',
  );
  const migrated = await callGet('/rp-tools/state');
  check('老配置打开后补上 user -> 玩家', migrated.json.config?.cards?.macros?.user, '玩家');
  check('迁移是一次性的（打上标记）', migrated.json.config?.cards?.macrosSeeded, true);
  await callPost('/rp-tools/config', { cards: { root: '', macros: {} } });
  const again = await callGet('/rp-tools/state');
  check('迁移过之后删除不再补回', Object.hasOwn(again.json.config?.cards?.macros ?? {}, 'user'), false);
}


// ── 自动宏：日期/时间及其**分量**都由宿主现算（用户不用填）────────────────────
// 用户反馈「很多宏其实可以自动设置」——`{{year}}年{{month}}月{{day}}日` 这种写法在卡里
// 很常见，以前要手填。现在它们全在 AUTO_MACROS 里，导入界面会标「自动」。
{
  const discovered = mod.__debug.discoverMacros('{{year}}年{{month}}月{{day}}日 {{time}} {{location}}');
  const byName = Object.fromEntries(discovered.map((m) => [m.name, m]));
  check('自动宏：year 判为自动', byName.year?.auto, true);
  check('自动宏：month 判为自动', byName.month?.auto, true);
  check('自动宏：day 判为自动', byName.day?.auto, true);
  check('自动宏：非时间类不算自动', byName.location?.auto, false);
  check('自动宏：自动的排在前面', discovered[0]?.auto, true);

  const now = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  check('自动宏：year 取当前年份', mod.__debug.autoMacroValue('year'), String(now.getFullYear()));
  check('自动宏：month 两位补零', mod.__debug.autoMacroValue('month'), p2(now.getMonth() + 1));
  check('自动宏：day 两位补零', mod.__debug.autoMacroValue('day'), p2(now.getDate()));
  check('自动宏：宏表给了固定值就优先（可以钉死游戏内年份）', mod.__debug.autoMacroValue('year', { year: '1987' }), '1987');
  check('自动宏：未知名字返回空串', mod.__debug.autoMacroValue('nope'), '');

  // 设置页要能拿到这份名单（界面据此提示「哪些宏不用填」）
  const st = await callGet('/rp-tools/state');
  check('设置页：宿主给出自动宏名单', Array.isArray(st.json.autoMacros) && st.json.autoMacros.includes('year'), true);
}


// ── 封面迁移：老数据里卡面挂在「卡名」这个假角色名下 ────────────────────────
// 1.10.2 之前导入会把卡面登记成 `portraits[卡名] = { card }`，而那个「卡名」往往根本不是角色
// （真事故：`下班，然后成为魔法少女。`）。现在把这类条目认成**封面**，用户不必重导。
{
  const id = crypto.randomUUID();
  const file = join(TEST_HOME, 'data', 'dsh-rp-tools', 'sessions', `${id}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({
    sessionId: id,
    characters: [{ name: '翠雀', personality: '冷淡' }],
    portraits: {
      '下班，然后成为魔法少女。': { card: '女性视角/下班。然后变成魔法少女.png', file: 'rp-sessions/x/cards/y.png' },
    },
  }, null, 2), 'utf8');
  const got = await callGet('/rp-tools/session', `?sessionId=${id}`);
  check('封面迁移：认出「不在角色表里」的卡面', got.json.session?.cover?.card, '女性视角/下班。然后变成魔法少女.png');
  check('封面迁移：名字取那个键', got.json.session?.cover?.name, '下班，然后成为魔法少女。');
  // 但如果那张卡面确实属于某个角色（键在角色表里），就**不算**封面
  const id2 = crypto.randomUUID();
  const file2 = join(TEST_HOME, 'data', 'dsh-rp-tools', 'sessions', `${id2}.json`);
  writeFileSync(file2, JSON.stringify({
    sessionId: id2,
    characters: [{ name: '翠雀', personality: '冷淡' }],
    portraits: { 翠雀: { card: 'cards/x.png' } },
  }, null, 2), 'utf8');
  const got2 = await callGet('/rp-tools/session', `?sessionId=${id2}`);
  check('封面迁移：属于角色的卡面不当封面', got2.json.session?.cover, null);
}

// ── dm 预设本身：渲染方案与过滤开关（真机踩过坑，放这里当回归闸门）────────────
// 用户实测：导入的卡自带的 ASCII「状态面板 / 战斗面板」被 DM 当成模板照抄，
// 于是回复里全是代码块画的方框 —— 预设必须明确「一律用 GenUI 组件重画」。
{
  let yaml = null;
  // js-yaml 是宿主的依赖，不一定在被测的那份 profile 里（用临时 profile 跑源码时会缺）——
  // 先问被测 profile，再退回默认 profile，都拿不到才跳过（别让套件因为解析器缺失而红）。
  for (const pkg of [PROFILE_PACKAGE, join(homedir(), '.dsh', 'profiles', 'web', 'package.json')]) {
    try { yaml = createRequire(pkg)('js-yaml'); break; } catch { /* 换下一个 */ }
  }
  if (!yaml) { console.log('WARN: 拿不到 js-yaml，跳过 dm 预设断言'); }
  else {
    const presetFile = join(here, '..', 'preset', 'agent.cordis.yml');
    const doc = yaml.load(readFileSync(presetFile, 'utf8'));
    const rows = Array.isArray(doc) ? doc : [];
    const persona = rows.find((row) => row?.id === 'persona');
    const prefix = String(persona?.config?.prefix ?? '');
    check('预设：persona 段存在', Boolean(persona), true);
    check('预设：有「渲染方案」小节', prefix.includes('## 渲染方案'), true);
    check('预设：点明不要照抄卡里的 ASCII 面板', prefix.includes('不要照抄卡里的画法'), true);
    check('预设：给了替代组件（keyvalue/progress/table）',
      ['`keyvalue`', '`progress`', '`table`'].every((k) => prefix.includes(k)), true);
    check('预设：把「必须输出面板」解释成「必须给出数据」', prefix.includes('不是必须用代码块'), true);
    check('预设：禁止同一批数据发两份', prefix.includes('同一批数据只出现一次'), true);
    check('预设：图片用 image 组件且不许贴裸 URL',
      prefix.includes('图片一律用 `image` 组件') && prefix.includes('不要贴裸 URL'), true);
    // 多张图必须挤进同一个围栏（每张单发一次 = 一串碎卡片）
    check('预设：多张图放同一个围栏', prefix.includes('多张放**同一个**围栏'), true);
    // ── 配图（1.14.0 起）──────────────────────────────────────────────────────
    // 本地生图（ComfyUI）整块从插件里搬走了：出图改由**宿主的 `generate_image`** 负责，
    // 插件只负责「用完怎么收进资源库复用」。所以这里断言的是一份**新的**口径，
    // 不是老「## 插画（本地生图可用时）」那一节。
    check('预设：配图小节取代了老的插画小节',
      prefix.includes('## 配图') && !prefix.includes('## 插画'), true);
    check('预设：明说本插件不提供出图能力', prefix.includes('本插件不提供出图能力'), true);
    // ⚠️ **不要在这三个已删工具的名字上做断言**（两个方向都不行）：
    //   · 断「预设里不出现它们」—— 老实现曾靠**点名**让模型别去找，那样断言会失败；
    //   · 断「预设里点名让模型别去找」—— 现在改成不复述名字了（见下一条）。
    // 正确的口径：预设**不再提到**这些名字（模型看不到这些工具，提名字只会把注意力引到不存在的工具上），
    // 而是正面说清「本插件不提供出图能力 + 要图就用 generate_image」。这一条就是那个闸门。
    check('预设：不再复述已删工具的旧名字',
      ['rp_illustrate', 'rp_styles', 'rp_scenes'].every((n) => !prefix.includes(n)), true);
    check('预设：指向宿主的 generate_image 与 edit_image',
      prefix.includes('`generate_image`') && prefix.includes('`edit_image`'), true);
    // 出图慢 → 必须提醒 DM **一次发多个调用**，别一张一张串行等
    check('预设：提醒并发出图', prefix.includes('一次要几张就一次发几个 `generate_image` 调用'), true);
    check('预设：串行的代价说清楚了', prefix.includes('串行'), true);
    // 刚生成的图会**自动作为附件**挂在对话里（工具结果带 image 内容块）—— DM 不许再去编地址。
    // 这条是坏指导的回归闸门：早先预设让模型「拿到之后必须用 dsh-ui 的 image 组件显示出来」，
    // 可模型手上根本没有可用的 src（GenUI 的 image 只认 src 字符串，不认附件 id）。
    check('预设：说明刚生成的图会自动挂附件、不用模型自己显示',
      prefix.includes('自动作为附件挂在对话里'), true);
    check('预设：只有从资源库重放才需要 dsh-ui 的 image 组件',
      prefix.includes('只有从资源库重放的图'), true);
    // 立绘复用：先查「已有可用图」，导入卡的卡面就是角色卡的立绘，别重复生成
    check('预设：先查已有可用图再生成', prefix.includes('先查已有可用图再生成'), true);
    check('预设：可复用的图包含玩家导入的立绘与导入卡的卡面',
      prefix.includes('（玩家导入的立绘、导入卡的卡面）'), true);
    // 新图要能复用 → 唯一入口是 rp_assets(action:"import")，且必须带 label/tags
    check('预设：新图入库走 rp_assets import',
      prefix.includes('rp_assets(action:"import"'), true);
    check('预设：要求填 label 和 tags（否则以后找不到）',
      prefix.includes('一定填 `label` 和 `tags`') && prefix.includes('否则以后搜不到'), true);
    check('预设：说明 rp_assets 能按 kind/characters/tags/q 查',
      prefix.includes('按 `kind` / `characters` / `tags` / `q`'), true);
    check('预设：画面描述要带上人物卡的 appearance（跨场景一致性）',
      prefix.includes('appearance'), true);
    // ⚠️ 这条断言换过口径：早先要求「生成的图必须用 image 组件显示出来」，那是**坏指导** ——
    //    `generate_image` 的图会**自动作为附件**挂在对话里（工具结果带 image 内容块），
    //    而 GenUI 的 image 只认 `src` 字符串、不认附件 id，模型手上根本没有可用的 src。
    //    现在正确口径：刚生成的图不用模型操心显示，**只有从资源库重放的图**才用 image 组件。
    check('预设：生成的图自动挂附件（不是让模型自己显示）',
      prefix.includes('自动作为附件挂在对话里'), true);
    check('预设：只有资源库重放才用 image 组件',
      prefix.includes('只有从资源库重放的图') && prefix.includes('`dsh-ui` 的 image 组件'), true);
    // 跨会话串档（真机日志里 `glob **/*.launch.md` 一次捞出 4 个别会话的 launch 文件）。
    // 1.13.2 起不再靠「警告 DM 别找错地方」，而是**把 launch 路径直接印进常驻段**——
    // 宿主知道该去哪找，DM 就不必去找了。persona 里那句「会捞到别的会话」的警告保留作第二道。
    check('预设：不要自己去 glob 找 launch 文件或世界书',
      prefix.includes('不要用 `glob` 去找 launch 文件或世界书'), true);
    check('预设：点明根目录 glob 会捞到别的会话',
      prefix.includes('**别的会话的** launch 文件'), true);
    check('预设：点明读错 launch 不会报错',
      prefix.includes('读了就会拿别人的世界观开团，而且不会报错'), true);
    check('预设：说明宿主已经把两行事实印在系统提示里',
      prefix.includes('宿主已经把该给的两行都印在系统提示里了'), true);
    // 地图（可选功能）：约定的每一条都是为了不再犯已经犯过的错
    check('预设：有「地图」小节', prefix.includes('## 地图（**可选**'), true);
    check('预设：强调没地图就别硬造', prefix.includes('不要给每个场景临时造一张图'), true);
    check('预设：运行时变化不写回静态图', prefix.includes('运行时变化绝不写回 rp-map.json'), true);
    check('预设：mermaid 节点 ID 必须 ASCII', prefix.includes('**必须 ASCII**'), true);
    check('预设：按钮只从当前节点的邻接边生成', prefix.includes('按钮只从「当前节点的邻接边」生成'), true);
    check('预设：点明跨端生成按钮会被判相邻失败', prefix.includes('点了必然被判「两点不相邻」而失败'), true);
    check('预设：地图走面板原地更新', prefix.includes('地图走面板'), true);
    check('预设：收到地图 action 先校验再写状态', prefix.includes('非法就说明原因并重绘当前地图，**不要写状态**'), true);
    // 约定 ≠ 状态（报告 BUG-01/02 的种子）
    check('预设：说明「常驻条目 / 已有可用图」是规则而不是已有状态',
      prefix.includes('是**规则说明**；本会话真的有没有，看它下面列的东西'), true);
    // 围栏必须成对：奇数个三反引号会让模型把后文当代码块（persona 里踩过）
    const ticks = prefix.split('```').length - 1;
    check('预设：三反引号成对出现（不留未闭合围栏）', ticks % 2, 0);
    // 每轮注入通道**不能**被关掉（关掉 = 世界书命中/在场角色静默丢失）
    const filter = rows.find((row) => row?.id === 'dm-filter');
    check('预设：dm-filter 显式 suppressRuntimeContext=false', filter?.config?.suppressRuntimeContext, false);
    check('预设：保留 validate_dsh_ui（围栏自检靠它）',
      (filter?.config?.keepGlobalTools ?? []).includes('validate_dsh_ui'), true);
    // ⚠️ **跨文件契约的闸门**（1.15.0 起可配置，见 docs/REMOVE-IMAGE-GEN.md §10.1 与 README）：
    // 本插件不出图，DM 配图靠宿主的**全局**工具 `generate_image` / `edit_image`；而 dm-filter 会把
    // 不在放行名单里的全局工具全部 deny。铁律是「persona 让调的工具必须真的可见」，但**名单放在哪**
    // 经历了两次修正：先写死在 YAML（换插件就得改预设，而预设重装会被覆盖）→ 现在改为
    // **用户可勾选的设置**（`styles.json` 的 `globalToolsAllow`，出厂默认这两条），过滤器读它合并。
    // 所以这里钉三件事：① YAML 只留预设底线；② 默认值在**共享模块**里（两边同源，不会走散）；
    // ③ 过滤器确实去读了那份配置。任何一条断了，DM 就会静默看不见生图工具。
    const keep = filter?.config?.keepGlobalTools ?? [];
    check('预设：keepGlobalTools 只留预设底线（不再写死某个生图插件）',
      keep.includes('render_ui') && keep.includes('validate_dsh_ui') && keep.includes('web_search'), true);
    check('预设：keepGlobalTools 不含 generate_image（默认值改由配置提供）', keep.includes('generate_image'), false);
    check('预设：keepGlobalTools 不含 edit_image', keep.includes('edit_image'), false);
    // 共享默认值模块：插件与预设过滤器**同一份**（各自硬编码会走散 —— 底线少一项就是卡片渲染静默坏掉）
    const gtDefaultsFile = join(here, '..', 'lib', 'global-tools-defaults.js');
    const gtSrc = readFileSync(gtDefaultsFile, 'utf8');
    check('共享默认值：文件存在且导出底线与默认放行', /GLOBAL_TOOLS_BASE/.test(gtSrc) && /GLOBAL_TOOLS_ALLOW_DEFAULT/.test(gtSrc), true);
    const gtMod = await import(pathToFileURL(gtDefaultsFile).href);
    check('共享默认值：底线三项', gtMod.GLOBAL_TOOLS_BASE.join(','), 'render_ui,validate_dsh_ui,web_search');
    check('共享默认值：默认额外放行 = 宿主生图工具',
      gtMod.GLOBAL_TOOLS_ALLOW_DEFAULT.join(','), 'generate_image,edit_image');
    check('共享默认值：归一会剔非法名与底线名并去重',
      gtMod.normalizeGlobalToolsAllow(['generate_image', 'generate_image', 'render_ui', 'BAD NAME', 'my_pic', '']).join(','),
      'generate_image,my_pic');
    // 过滤器必须去读那份配置（否则设置页勾了也没用）
    const filterSrc = readFileSync(join(here, '..', 'preset', 'session-filter-v2.mjs'), 'utf8');
    check('过滤器：读 styles.json 的 globalToolsAllow', /globalToolsAllow/.test(filterSrc) && /styles\.json/.test(filterSrc), true);
    check('过滤器：与插件共用同一份默认值模块', /global-tools-defaults\.js/.test(filterSrc), true);
  }
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
console.log(`数据目录（临时，即将删除）: ${TEST_HOME}`);
rmSync(TEST_HOME, { recursive: true, force: true });
console.log('临时目录已删除 —— 真实 ~/.dsh/data/dsh-rp-tools 未被触碰。');

// 不要同步 process.exit：Windows 上 libuv 会在句柄收尾途中断言失败
// （Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)），
// 那是收尾时序问题、不是测试结果问题。让事件循环跑完再设退出码。
process.exitCode = fail ? 1 : 0;
