// RP 插件宿主半侧冒烟测试：伪造 ctx，跑通 apply + registerRpTools + dm 判定路径。
// 约定：ctx.inject(names, fn) 会把「注入后的 ctx」作为参数回调（installRoutes 就是这么用的）。
//
// ⚠️ 用法（见文件末尾）：DSH_HOME 被指向临时目录，所以**绝不碰真实数据目录**。
//    早期版本直接写 ~/.dsh/data/dsh-rp-tools/，测试记录会混进真实会话登记表，
//    清理时极易误删真实会话 —— 别再改回去。
import crypto from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

// systemPrompt 桩：记录注册的段，并让我们能手动触发一次装配，验证注入真的落进 assembly
const promptSections = new Map();
const promptContexts = new Map();
const systemPromptStub = {
  section: (s) => { promptSections.set(s.name, s); return () => {}; },
  context: (c) => { promptContexts.set(c.name, c); return () => {}; },
};

// 全局作用域：故意**不给** systemPrompt stub —— 用来证明全局 apply() 不做提示词注入。
// （这是架构约束的回归测试：注入只允许发生在 dm 预设的 agent 作用域。）
// 同时记录全局注册了哪些工具：**必须是零个**。
const globalTools = [];
const hostCtx = {
  tools: { register: (t) => { tools.set(t.name, t); globalTools.push(t.name); } },
  on,
  effect: (fn) => { fn(); },
  webServer: { register: (r) => { routes.set(r.path, r); } },
  inject: (names, fn) => { fn(hostCtx); },
  get: () => undefined,
};
mod.apply(hostCtx);

// agent 作用域：就是 dm 预设的 rp-bridge 调用 registerRpTools 的那个上下文
const agentCtx = {
  tools: { register: (t) => { tools.set(t.name, t); } },
  on,
  effect: (fn) => { fn(); },
  webServer: { register: (r) => { routes.set(r.path, r); } },
  inject: (names, fn) => { fn(agentCtx); },
  get: (name) => (name === 'systemPrompt' ? systemPromptStub : undefined),
  agent: { id: `session-${SMOKE_AGENT_SESSION}` },
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
    end: (b) => { out.body = typeof b === 'string' ? b : Buffer.from(b ?? '').toString('utf8'); },
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
  await callPost('/rp-tools/session', {
    sessionId: PARENT,
    world: '灰烬纪元：诸神陨落后的第三百年',
    campaign: { name: '灰烬纪元', prompt_prefix: 'cinematic lighting' },
    styleNotes: '暗调高对比',
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
  check('fork：风格备注被继承', child.session.styleNotes, '暗调高对比');
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
    // 注入是按「作用域自带的身份」定位会话的 —— 这正是它不需要猜会话的原因。
    // 测试里把 agent 作用域的身份设成这个会话，模拟 rp-bridge 挂载时的真实情形。
    agentCtx.agent.id = `session-${SID}`;
    onSessionCreated({ id: SID, header: { id: SID } });
    await callPost('/rp-tools/session', {
      sessionId: SID,
      world: '灰烬纪元：诸神陨落后的第三百年，整个世界被永夜笼罩。',
      campaign: { name: '灰烬纪元' },
      characters: [{ name: '凯尔', appearance: '十七岁少年，黑色斗篷' }],
      tables: [{ name: '遭遇表', dice: '1d6', entries: ['狼群'] }],
    });

    // 模拟宿主装配：初始 assembly 里只有我们注册的那段占位短文案
    const assembly = { sections: [{ name: 'rp:standing', text: sec.text }, { name: 'other', text: 'x' }], contexts: [], tools: [], variables: {} };
    const out = await onAssemble(assembly, {}, async () => assembly);
    const mine = (out?.sections ?? []).find((s) => s?.name === 'rp:standing');
    check('注入后 rp:standing 段仍在', Boolean(mine), true);
    check('世界设定真的进了系统提示词', mine?.text?.includes('诸神陨落后的第三百年'), true);
    check('战役名进了系统提示词', mine?.text?.includes('灰烬纪元'), true);
    check('角色卡进了系统提示词', mine?.text?.includes('凯尔'), true);
    check('随机表目录进了系统提示词', mine?.text?.includes('遭遇表'), true);
    check('其它段未被破坏', (out?.sections ?? []).length, 2);

    // 双花括号必须被中和，否则宿主插值会把 {{宏}} 当变量而抛错
    // （注意：这里必须先做断言再切会话 —— currentStandingSessionId 取的是「最近活动的会话」）
    await callPost('/rp-tools/session', { sessionId: SID, world: '她轻声说 {{user}} 你来了' });
    // （不再需要模拟装配断言的调试输出：注入逻辑已改为走纯函数 __debug.injectFor）
    // 双花括号必须被中和，否则宿主插值会把 {{宏}} 当变量而抛错。
    // 这里直接走纯函数：loadSession 依赖模块加载时定下的数据目录（真实 ~/.dsh），
    // 在临时 DSH_HOME 下用不了 —— 纯函数既避开这个陷阱，也正是要断言的逻辑。
    const t2 = mod.__debug.injectFor({ world: '她轻声说 {{user}} 你来了', characters: [], tables: [] });
    check('{{ }} 被中和（不残留半角双花括号）', t2.includes('{{'), false);
    check('中和后内容仍可读', t2.includes('你来了'), true);
    check('中和只动花括号、不动其它字符', t2.includes('｛｛user｝｝'), true);

    // 未配置世界设定的会话 → 回落固定短文案，不应把上一个会话的内容泄露过去
    onSessionCreated({ id: SID2, header: { id: SID2 } });
    const out3 = await onAssemble({ sections: [], contexts: [], tools: [], variables: {} }, {}, async (a) => a);
    const t3 = (out3?.sections ?? []).find((s) => s?.name === 'rp:standing')?.text ?? '';
    check('无配置会话不泄露上一会话的设定', t3.includes('诸神陨落'), false);
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

// ── 角色固定种子（跨场景一致性） ──────────────────────────────────────────
{
  const D = mod.__debug;
  const session = {
    characters: [
      { name: '祁俊', appearance: '少年' },
      { name: '祝婉宁', appearance: '美妇' },
    ],
  };
  check('种子：命中单个角色时识别出名字', D.characterInPrompt(session, '祁俊站在雨里'), '祁俊');
  check('种子：同一角色 → 同一 seed（跨场景稳定）',
    D.characterSeed(session, '祁俊站在雨里'), D.characterSeed(session, '祁俊在酒楼上喝酒'));
  check('种子：不同角色 → 不同 seed',
    D.characterSeed(session, '祁俊出剑') === D.characterSeed(session, '祝婉宁出剑'), false);
  check('种子：seed 是 32 位以内非负整数',
    Number.isInteger(D.characterSeed(session, '祁俊')) && D.characterSeed(session, '祁俊') >= 0 && D.characterSeed(session, '祁俊') < 2147483647, true);

  // 多角色同框：主体说不清，不套任何人的种子（否则等于偏向其中一个）
  check('种子：两个角色同框时不固定', D.characterInPrompt(session, '祁俊与祝婉宁对峙'), '');
  check('种子：两个角色同框时无 seed', D.characterSeed(session, '祁俊与祝婉宁对峙'), undefined);
  check('种子：未登记的角色不参与', D.characterInPrompt(session, '路人甲走过'), '');
  check('种子：空角色表不报错', D.characterSeed({ characters: [] }, '祁俊'), undefined);
  check('种子：session 为空不报错', D.characterSeed(null, '祁俊'), undefined);
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
      party: [{ character: '祁俊', status: '警戒', inventory: '短枪枪头、腰刀', conditions: '左臂擦伤', goal: '找到地图' }],
      flags: { 伏笔_黑猫: '已埋', 义王_好感: '警惕' },
    }, exec);
    const after = (await callGet('/rp-tools/session', `?sessionId=${SID}`)).json.session.state;
    check('状态：场景落盘', after?.scene, '雨夜客栈');
    check('状态：队伍成员状态落盘', after?.party?.[0]?.conditions, '左臂擦伤');
    check('状态：旗标落盘', after?.flags?.伏笔_黑猫, '已埋');

    // ② 局部更新：没传的字段保持原值
    await rpState.execute({ action: 'set', location: '西厢' }, exec);
    const partial = (await callGet('/rp-tools/session', `?sessionId=${SID}`)).json.session.state;
    check('状态：局部更新只改传入字段', partial?.location, '西厢');
    check('状态：局部更新不动其它字段', partial?.scene, '雨夜客栈');
    check('状态：局部更新不动旗标', partial?.flags?.伏笔_黑猫, '已埋');

    // ③ 空串 = 清除（伤势好了/东西用掉了），不留幽灵键
    await rpState.execute({ action: 'set', conditions: '', flags: { 伏笔_黑猫: '' } }, exec);
    const cleared = (await callGet('/rp-tools/session', `?sessionId=${SID}`)).json.session.state;
    check('状态：空串清除字段', 'conditions' in (cleared ?? {}), false);
    check('状态：空串删除旗标键', '伏笔_黑猫' in (cleared?.flags ?? {}), false);
    check('状态：清除后其它旗标仍在', cleared?.flags?.义王_好感, '警惕');

    // ④ 注入：状态在最前、带权威标注
    const session = { state: cleared, world: '', tables: [], characters: [] };
    const turn = D.buildTurnContext(session, '没什么特别的', {});
    check('状态：进了每轮注入', turn.includes('本场当前状态'), true);
    check('状态：注入带「唯一权威」标注', turn.includes('唯一权威'), true);
    check('状态：注入在最前（先于世界书）', turn.indexOf('本场当前状态') < (turn.indexOf('世界书') === -1 ? Infinity : turn.indexOf('世界书')), true);
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
    ['/rp-tools/check', ''],
    ['/rp-tools/loras', ''],
    ['/rp-tools/inject', ''],
    ['/rp-tools/cards', '?limit=5'],
    ['/rp-tools/session', `?sessionId=${crypto.randomUUID()}`],
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
}

// ── 风格库增删 + LoRA 清单 ────────────────────────────────────────────────
const NEWKEY = `smoke-${crypto.randomUUID().slice(0, 8)}`;

// 新增一个风格（带 LoRA），并同时提交字段补丁
{
  const res = await callPost('/rp-tools/config', {
    styleOps: [{ action: 'add', key: NEWKEY }],
    styles: { [NEWKEY]: { label: '冒烟风格', trigger: 'smoke trigger', lora: 'krea2_darkbrush.safetensors', cfg: 1.5, steps: 10 } },
  });
  check('新增风格 ok', res.json.ok, true);
  const st = res.json.config?.styles?.[NEWKEY];
  check('新增风格：label 落盘', st?.label, '冒烟风格');
  check('新增风格：lora 落盘', st?.lora, 'krea2_darkbrush.safetensors');
  check('新增风格：cfg 落盘', st?.cfg, 1.5);
  check('新增风格：模板字段保留 sizes', Array.isArray(st?.sizes?.scene), true);
  check('新增风格：摘要带 builtin=false', res.json.styles?.find((s) => s.key === NEWKEY)?.builtin, false);
  check('新增风格无错误', res.json.styleErrors, []);
}

// 重复 key 应报错且不改动原条目
{
  const res = await callPost('/rp-tools/config', {
    styleOps: [{ action: 'add', key: NEWKEY }],
    styles: { [NEWKEY]: { label: '不该覆盖' } },
  });
  check('重复新增被拒（有错误）', res.json.styleErrors?.length, 1);
  check('重复新增未覆盖原 label', res.json.config?.styles?.[NEWKEY]?.label, '冒烟风格');
}

// 非法 key 被拒
{
  const res = await callPost('/rp-tools/config', { styleOps: [{ action: 'add', key: 'bad key!' }] });
  check('非法 key 被拒', res.json.styleErrors?.length, 1);
}

// 删除
{
  const res = await callPost('/rp-tools/config', { styleOps: [{ action: 'remove', key: NEWKEY }] });
  check('删除风格 ok', res.json.ok, true);
  check('删除风格：已从配置移除', res.json.config?.styles?.[NEWKEY], undefined);
  check('删除风格：removedStyles 记录', res.json.removedStyles, [NEWKEY]);
}

// 内置风格也不能通过接口被删掉（客户端不给按钮，但接口要挡住手抖）
{
  const res = await callPost('/rp-tools/config', { styleOps: [{ action: 'remove', key: 'manga' }] });
  const stillThere = Boolean(res.json.config?.styles?.manga);
  check('内置风格删除被挡（仍在）', stillThere, true);
}

// LoRA 清单：ComfyUI 在线就是真清单，离线则应是结构化失败（不能抛异常）
{
  const res = await callGet('/rp-tools/loras');
  check('loras 路由 status=200', res.status, 200);
  const shapeOk = Array.isArray(res.json.loras) && typeof res.json.ok === 'boolean';
  check('loras 返回结构正确', shapeOk, true);
  if (res.json.ok) {
    check('loras 每项有 name/krea2 字段', typeof res.json.loras[0]?.name === 'string' && typeof res.json.loras[0]?.krea2 === 'boolean', true);
    console.log(`       （ComfyUI 在线，读到 ${res.json.count} 个 LoRA）`);
  } else {
    console.log(`       （ComfyUI 离线：${res.json.error}）`);
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
  check('card：{{user}} 预览时就已展开成玩家称呼', String(preview.json.world).includes('玩家站在门外'), true);
  check('card：{{char}} 已展开成卡名', String(preview.json.world).includes('烟测卡的情境正文'), true);
  check('card：预览里不再有占位符', /\{\{/.test(String(preview.json.world)), false);
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
  // 先写一份「用户自己写的」世界书，验证导入是**追加**而不是覆盖
  writeFileSync(join(ws, 'rp-worldbook.md'), '# 我的手写世界书\n\n## 我自己的条目\n<!-- keys: 自有 -->\n别动我。\n', 'utf8');
  await callPost('/rp-tools/dm-mark', { sessionId: IMPORT_SID, preset: 'dm' });

  const imported = await callPost('/rp-tools/card-import', { sessionId: IMPORT_SID, workspace: ws, path: rel });
  check('card-import status=200', imported.status, 200);
  check('导入：ok', imported.json.ok, true);
  check('导入：角色名', imported.json.character?.name, '烟测卡');
  check('导入：世界书新增 1 条', imported.json.lore?.added, 1);
  check('导入：世界书文件相对路径', imported.json.files?.world, 'rp-worldbook.md');
  check('导入：全文文件已写出', existsSync(join(ws, 'rp-cards', '烟测卡.card.md')), true);
  check('导入：卡 JSON 已写出', existsSync(join(ws, 'rp-cards', '烟测卡.card.json')), true);
  check('导入：卡面已复制（当立绘）', existsSync(join(ws, 'rp-cards', '烟测卡.card.png')), true);
  check('导入：立绘登记在会话里', imported.json.files?.image, 'rp-cards/烟测卡.card.png');
  check('导入：返回开场指令', String(imported.json.opening).includes('不要再问世界从哪来'), true);

  const wbText = readFileSync(join(ws, 'rp-worldbook.md'), 'utf8');
  check('导入：用户原有条目没被覆盖', wbText.includes('我自己的条目'), true);
  check('导入：新条目被追加', wbText.includes('烟测条目'), true);
  check('导入：原有条目只出现一次', wbText.split('我自己的条目').length - 1, 1);

  const sess = await callGet('/rp-tools/session', `?sessionId=${IMPORT_SID}`);
  check('导入：会话角色卡已写入', sess.json.session?.characters?.[0]?.name, '烟测卡');
  check('导入：会话世界已写入', String(sess.json.session?.world).includes('情境正文'), true);
  check('导入：会话世界里的占位符已展开', String(sess.json.session?.world).includes('玩家站在门外'), true);
  check('导入：返回占位符统计', (imported.json.placeholders?.total ?? 0) >= 2, true);
  check('导入：会话立绘已登记', sess.json.session?.portraits?.['烟测卡']?.card, rel);
  check('导入：战役名补成卡名', sess.json.session?.campaign?.name, '烟测卡');

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
  check('导入的世界书按触发词进注入', turnHit.includes('玩家来到烟测卡的门前'), true);
  const turnMiss = mod.__debug.buildTurnContext(sessObj, '完全无关的一句话', { sessionId: IMPORT_SID, turn: 3 });
  check('没命中触发词就不注入该条目', turnMiss.includes('玩家来到烟测卡的门前'), false);
  const standing = mod.__debug.buildStandingText(sessObj);
  check('导入的世界设定进了常驻段', standing.includes('情境正文'), true);
  check('导入的角色卡进了角色索引', standing.includes('烟测卡'), true);
  // 注入端的中和是**兜底**：走到这一步说明导入没展开干净，那就至少别变成全角括号
  check('注入文本里没有残留占位符', /\{\{/.test(`${turnHit}${standing}`), false);

  // ── 世界书面板数据源：/rp-tools/lore ────────────────────────────────
  const loreRes = await callGet('/rp-tools/lore', `?sessionId=${IMPORT_SID}&workspace=${encodeURIComponent(ws)}`);
  check('lore 路由 status=200', loreRes.status, 200);
  check('lore：条数与文件一致', loreRes.json.total, 2);   // 用户手写 1 条 + 导入 1 条
  check('lore：能列出导入的条目', loreRes.json.entries?.some((e) => e.title === '烟测条目'), true);
  const loreEntry = loreRes.json.entries?.find((e) => e.title === '烟测条目');
  check('lore：条目带触发词', loreEntry?.keys, ['烟测']);
  check('lore：正文已展开占位符', String(loreEntry?.preview).includes('玩家来到烟测卡的门前'), true);
  check('lore：能列出用户手写的条目', loreRes.json.entries?.some((e) => e.title === '我自己的条目'), true);
  check('lore：给出文件绝对路径', typeof loreRes.json.file === 'string' && loreRes.json.file.endsWith('rp-worldbook.md'), true);
  const loreMissing = await callGet('/rp-tools/lore', `?sessionId=${crypto.randomUUID()}`);
  check('lore：拿不到工作区时不报错、只说明', loreMissing.json.exists, false);

  // ── 世界书编辑（面板里的「编辑 / 常驻开关 / 新建 / 删除」走这条路由）──────
  {
    const read = () => readFileSync(join(ws, 'rp-worldbook.md'), 'utf8');
    // ① 取单条完整正文（列表只给 160 字预览，编辑器要全文）
    const one = await callGet('/rp-tools/lore', `?sessionId=${IMPORT_SID}&title=${encodeURIComponent('烟测条目')}`);
    check('lore 详情：取到完整正文', String(one.json.entry?.body).includes('玩家来到烟测卡的门前'), true);
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

  // 卡面路由：只服务卡库内的 png
  const imgRoute = routes.get('/rp-tools/card-image');
  const imgRes = mkRes();
  imgRoute.handler({ method: 'GET', url: `/rp-tools/card-image?path=${encodeURIComponent(rel)}`, headers: {} }, imgRes);
  check('卡面路由 status=200', imgRes.out.status, 200);
  const imgEscape = mkRes();
  imgRoute.handler({ method: 'GET', url: '/rp-tools/card-image?path=..%2F..%2Fsecret.png', headers: {} }, imgEscape);
  check('卡面路由：路径逃逸被拒', imgEscape.out.status, 400);
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
console.log(`数据目录（临时，即将删除）: ${TEST_HOME}`);
rmSync(TEST_HOME, { recursive: true, force: true });
console.log('临时目录已删除 —— 真实 ~/.dsh/data/dsh-rp-tools 未被触碰。');

// 不要同步 process.exit：Windows 上 libuv 会在句柄收尾途中断言失败
// （Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)），
// 那是收尾时序问题、不是测试结果问题。让事件循环跑完再设退出码。
process.exitCode = fail ? 1 : 0;
