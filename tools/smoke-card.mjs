/**
 * 角色卡导入冒烟测试：PNG 解码 + 卡数据映射。
 *
 * 用**手工构造的 PNG 字节**测，而不是 mock 解码结果 ——
 * 这样才会真的覆盖 chunk 遍历、`ccv3` 优先、iTXt 压缩标志、字段摊平这几条踩过的坑。
 * 也被用来挡住调研文档里那三个「会改变设计的实测数字」：
 *   ① `first_mes` 是广告 → 必须丢弃并改用 `alternate_greetings`
 *   ② 正文常在 `character_book` 里 → 导入主战场是世界书
 *   ③ 32% 条目无 keys → 必须补 `constant`，否则导入死条目
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const mod = (p) => import(pathToFileURL(join(here, '..', 'lib', p)).href);
const { readPngTextChunks, decodeCardPng } = await mod('card-png.js');
const { buildImport, worldBookMarkdown, pickGreeting, isAdText, cardToCharacter, cardToMarkdown, buildOpeningPrompt, resolvePlaceholders, describePlaceholders } = await mod('card-import.js');

let pass = 0; let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  got=${JSON.stringify(got)}${ok ? '' : `  want=${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

// ── 构造 PNG ──────────────────────────────────────────────────────────────
// chunk 构造器抽在 tools/png-fixture.mjs（smoke-dm 造卡库时用同一份）。
const { makePng, textChunk, iTXtChunk, zTXtChunk, card } = await import(
  pathToFileURL(join(here, 'png-fixture.mjs')).href
);

// ── 解码：chunk 遍历与优先级 ───────────────────────────────────────────────
{
  const v2 = makePng([textChunk('chara', card({ name: 'v2卡' }))]);
  check('解码 tEXt/chara', decodeCardPng(v2).data.name, 'v2卡');
  check('识别 v2 规范', decodeCardPng(v2).kind, 'v2');

  // ccv3 必须优先：两个块都在时取 ccv3（59.8% 的卡只有 ccv3，只读 chara 会漏）
  const both = makePng([
    textChunk('chara', card({ name: 'v2卡' })),
    textChunk('ccv3', card({ name: 'v3卡' }, 'chara_card_v3')),
  ]);
  check('ccv3 优先于 chara', decodeCardPng(both).data.name, 'v3卡');
  check('识别 v3 规范', decodeCardPng(both).kind, 'v3');
  check('记录用的是哪个块', decodeCardPng(both).chunk, 'ccv3');

  // v1：没有 spec，字段直接铺在顶层
  const v1 = makePng([textChunk('chara', card({ name: 'v1卡', description: '顶层字段' }, null))]);
  check('v1：无 spec 判为 v1', decodeCardPng(v1).kind, 'v1');
  check('v1：顶层字段可用', decodeCardPng(v1).data.description, '顶层字段');

  // iTXt 未压缩
  const itxt = makePng([iTXtChunk('chara', card({ name: 'iTXt卡' }))]);
  check('解码 iTXt（未压缩）', decodeCardPng(itxt).data.name, 'iTXt卡');
  // iTXt 压缩标志 —— 忽略它就会解出乱码
  const itxtZ = makePng([iTXtChunk('chara', card({ name: '压缩iTXt卡' }), { compressed: true })]);
  check('解码 iTXt（压缩标志=1）', decodeCardPng(itxtZ).data.name, '压缩iTXt卡');
  // zTXt
  const ztxt = makePng([zTXtChunk('chara', card({ name: 'zTXt卡' }))]);
  check('解码 zTXt', decodeCardPng(ztxt).data.name, 'zTXt卡');

  // 无卡数据的纯插图：要返回「没有卡数据」而不是抛错
  const plain = makePng([textChunk('Software', 'nothing')]);
  const r = decodeCardPng(plain);
  check('纯插图：ok=false 且不抛错', r.ok, false);
  check('纯插图：给出明确原因', r.error.includes('没有角色卡数据'), true);

  // 坏图容错：截断的 PNG 不能崩
  const broken = makePng([textChunk('chara', card({ name: 'x' }))]).subarray(0, 30);
  let threw = false;
  try { decodeCardPng(broken); } catch { threw = true; }
  check('截断的 PNG 不抛异常', threw, false);
  // 不是 PNG
  check('非 PNG 文件被识别', decodeCardPng(Buffer.from('not a png at all')).ok, false);
}

// ── 映射：广告过滤（调研数字 ①） ─────────────────────────────────────────
{
  const AD = '欢迎使用酒馆专属大模型 Deepseek Tavern Pro，官网 deepseektavern.com 获取更多';
  check('广告指纹被识别', isAdText(AD), true);
  check('正常文本不算广告', isAdText('雨打芭蕉，祁俊推门进来。'), false);

  // 广告 first_mes + 有备用开场白 → 必须用备用
  const g1 = pickGreeting({ first_mes: AD, alternate_greetings: ['靖康二年，汴京残梦。', '第二条备用'] });
  check('丢弃广告 first_mes，改用备用开场白', g1.text, '靖康二年，汴京残梦。');
  check('标注来源为 alternate_greetings', g1.source, 'alternate_greetings');
  check('报告备用开场白条数', g1.alternatives, 2);

  // 只有广告 first_mes、没有备用 → 不导入任何开场白（不能导广告）
  const g2 = pickGreeting({ first_mes: AD, alternate_greetings: [] });
  check('无可用开场白时留空而不是导广告', g2.text, '');
  check('标注来源为 none', g2.source, 'none');

  // 备用开场白里混了广告 → 跳过它取后面的
  const g3 = pickGreeting({ first_mes: AD, alternate_greetings: [AD, '正经开场'] });
  check('备用开场白里的广告也被跳过', g3.text, '正经开场');

  // first_mes 干净时可用
  const g4 = pickGreeting({ first_mes: '干净的正文开场', alternate_greetings: [] });
  check('干净的 first_mes 可以用', g4.text, '干净的正文开场');
  check('标注来源为 first_mes', g4.source, 'first_mes');

  // 角色字段：description + personality 拼接并标注来源
  const ch = cardToCharacter({ name: '祁俊', description: '十九岁少年', personality: '心性方正', first_mes: AD, alternate_greetings: ['开场'] });
  check('角色名映射', ch.name, '祁俊');
  check('description 与 personality 拼接', ch.personality.includes('【设定】') && ch.personality.includes('心性方正'), true);
  check('卡里没有的字段留空（不假装映射）', ch.speech === '' && ch.behavior === '' && ch.relations === '', true);
  check('appearance 留空待 DM 提炼', ch.appearance, '');
}

// ── 世界书映射：无 keys 补 constant（调研数字 ③） ─────────────────────────
{
  const md = worldBookMarkdown([
    { name: '有键条目', keys: ['广寒宫', '祝婉宁'], content: '正文 A', insertion_order: 80 },
    { name: '无键条目', keys: [], content: '正文 B' },
    { name: '原卡常驻', keys: [], constant: true, content: '正文 C' },
    { name: '被禁用条目', keys: ['x'], content: '正文 D', enabled: false },
  ]);
  check('有 keys 的条目写 keys', md.markdown.includes('keys: 广寒宫、祝婉宁'), true);
  check('order 被保留', md.markdown.includes('order: 80'), true);
  check('无 keys 的条目被补上 constant', /## 无键条目\n<!-- constant -->/.test(md.markdown), true);
  check('原卡 constant 保留', /## 原卡常驻\n<!-- constant -->/.test(md.markdown), true);
  check('被禁用的条目不导入', md.markdown.includes('正文 D'), false);
  check('统计被禁用的条数', md.enabledOff, 1);
  check('保留 3 条', md.kept, 3);
  // 注：「导出的世界书能被解析器读回、且无键条目真的会激活」这条往返一致性
  // 由 tools/verify-roundtrip.mjs 在 profile 上下文里验（lib/index.js 依赖 profile 的
  // @deepseek-ai/dsh-tools，从仓库路径直接 import 会解析不到）。

  // 限量：超上限的条目进 dropped 而不是硬塞
  const many = Array.from({ length: 10 }, (_, i) => ({ name: `T${i}`, keys: [`k${i}`], content: 'x'.repeat(100) }));
  const capped = worldBookMarkdown(many, { maxEntries: 3, maxChars: 1e6 });
  check('条目数上限生效', capped.kept, 3);
  check('超上限的进 dropped', capped.skipped, 7);
}

// ── 端到端：一张典型的「广告卡」全流程 ────────────────────────────────────
{
  const AD = '酒馆专属大模型 Deepseek Tavern Pro deepseektavern.com';
  const png = makePng([textChunk('ccv3', card({
    name: '汴京残梦录',
    description: '',
    personality: '',
    scenario: '靖康二年，汴京。',
    first_mes: AD,
    alternate_greetings: ['靖康二年冬，金兵围城。你站在宣德楼下……'],
    mes_example: '',
    character_book: {
      entries: [
        { name: '靖康之变', keys: ['靖康'], content: '金兵南下，汴京陷落。' },
        { name: '世界背景', keys: [], content: '北宋末年，山河破碎。' },
      ],
    },
  }, 'chara_card_v3'))]);

  const decoded = decodeCardPng(png);
  check('端到端：解码成功', decoded.ok, true);
  const imp = buildImport(decoded);
  check('端到端：角色名', imp.character.name, '汴京残梦录');
  check('端到端：开场白来自备用而非广告', imp.character.first_mes.includes('宣德楼下'), true);
  check('端到端：世界书写出两条', imp.stats.kept, 2);
  check('端到端：无键条目被补 constant', /<!-- constant -->/.test(imp.worldBookMarkdown), true);
  check('端到端：情境进了 world', imp.world.includes('靖康二年'), true);
  check('端到端：摘要说明了开场白来源', imp.summary.some((s) => s.includes('备用开场白')), true);
  check('端到端：摘要提示丢广告', imp.summary.some((s) => s.includes('广告')), true);
}

// ── 卡全文导出 + 开场指令 ─────────────────────────────────────────────────
{
  const png = makePng([textChunk('chara', card({
    name: '测试卡',
    description: '描述文本',
    personality: '性格文本',
    scenario: '情境文本',
    first_mes: '广告 deepseektavern.com',
    alternate_greetings: ['开场白一', '开场白二'],
    mes_example: '范例文本',
    creator_notes: '作者注文本',
    character_book: {
      entries: [
        { name: '条目甲', keys: ['甲'], content: '甲正文', insertion_order: 7 },
        { name: '条目乙', keys: [], content: '乙正文', enabled: false },
      ],
    },
  }, 'chara_card_v2'))]);
  const decoded = decodeCardPng(png);
  const md = cardToMarkdown(decoded);

  check('全文：标题是卡名', md.text.startsWith('# 测试卡'), true);
  check('全文：含设定/性格/情境', ['描述文本', '性格文本', '情境文本'].every((s) => md.text.includes(s)), true);
  check('全文：保留原始 first_mes（不因广告丢弃）', md.text.includes('deepseektavern.com'), true);
  check('全文：两条备用开场白都在', md.text.includes('开场白一') && md.text.includes('开场白二'), true);
  check('全文：世界书条目标题与正文都在', md.text.includes('### 条目甲') && md.text.includes('甲正文'), true);
  check('全文：被禁用的条目也保留（带标注）', md.text.includes('原卡已禁用'), true);
  check('全文：无 keys 的条目标成（无 keys）', md.text.includes('（无 keys）'), true);
  check('全文：未截断', md.truncated, false);
  // 截断是「保险丝」——超长卡不该把工作区文件写到没边
  const cut = cardToMarkdown(decoded, { maxChars: 80 });
  check('全文：超上限会截断', cut.truncated, true);
  check('全文：截断后带说明', cut.text.includes('已截断'), true);

  // 开场指令：必须显式拦住 dm persona 的「先问世界从哪来」
  const built = buildImport(decoded);
  const opening = buildOpeningPrompt(built, {
    worldFile: 'rp-worldbook.md', cardFile: 'rp-cards/测试卡.md', imageRel: 'rp-cards/测试卡.png',
  });
  check('开场指令：明说不要再问世界从哪来', opening.includes('不要再问世界从哪来'), true);
  check('开场指令：带卡名', opening.includes('测试卡'), true);
  check('开场指令：带世界书文件名', opening.includes('rp-worldbook.md'), true);
  check('开场指令：带全文文件名', opening.includes('rp-cards/测试卡.md'), true);
  check('开场指令：带立绘路径', opening.includes('rp-cards/测试卡.png'), true);
  check('开场指令：要求给带 action 的选项', opening.includes('action'), true);
  check('开场指令：附上卡组开场白作参考', opening.includes('开场白一'), true);
  const bare = buildOpeningPrompt({ character: { name: '无开场' }, stats: {}, }, {});
  check('开场指令：无开场白时不出现参考段', bare.includes('只作场景与文风参考'), false);
  check('开场指令：缺文件名时有兜底', bare.includes('rp-worldbook.md'), true);
}

// ── 占位符展开（导入时就处理，不留到注入端）─────────────────────────────
{
  const r = resolvePlaceholders('{{user}} 拉着 {{char}} 的手，<USER> 说 <BOT> 笑了。', { userLabel: '阿岚', charLabel: '沈砚' });
  check('占位符：{{user}} → 玩家称呼', r.text.includes('阿岚 拉着'), true);
  check('占位符：{{char}} → 卡名', r.text.includes('沈砚 的手'), true);
  check('占位符：<USER>/<BOT> 也认', r.text.includes('阿岚 说 沈砚 笑了'), true);
  check('占位符：统计 {{user}} 次数', r.counts['{{user}}'], 1);
  check('占位符：统计尖括号写法', (r.counts['<USER>'] ?? 0) + (r.counts['<CHAR>'] ?? 0), 2);
  check('占位符：展开后不再有花括号', /\{\{/.test(r.text), false);
  check('占位符：总数', r.total, 4);

  check('占位符：默认称呼是「玩家」', resolvePlaceholders('{{user}}').text, '玩家');
  check('占位符：给了卡名才会换 {{char}}', resolvePlaceholders('{{char}}', { charLabel: '沈砚' }).text, '沈砚');
  check('占位符：时间类直接删掉', resolvePlaceholders('现在是 {{time}}。').text, '现在是 。');
  check('占位符：未知花括号只去括号留文字', resolvePlaceholders('{{random}}').text, 'random');
  check('占位符：没有占位符时原样返回', resolvePlaceholders('普通文本').text, '普通文本');
  check('占位符：空输入不炸', resolvePlaceholders('').text, '');
  check('占位符：统计文案可读', describePlaceholders({ '{{user}}': 2, '{{char}}': 0 }), '已展开占位符：{{user}}×2');
  check('占位符：没有命中就不出文案', describePlaceholders({}), '');

  // 端到端：字段 / 世界书 / world / 卡全文都要过一遍
  const png = makePng([textChunk('ccv3', card({
    name: '沈砚',
    description: '{{char}}是{{user}}的师兄。',
    first_mes: '广告 deepseektavern.com',
    alternate_greetings: ['{{char}}推门进来，看见{{user}}还在睡。'],
    scenario: '{{user}}拜入{{char}}门下。',
    character_book: { entries: [{ name: '拜师', keys: ['拜师'], content: '{{user}}在{{char}}面前跪了三下。' }] },
  }, 'chara_card_v3'))]);
  const decoded = decodeCardPng(png);
  const imp = buildImport(decoded, { userLabel: '阿岚' });
  check('导入展开：角色字段里没有占位符', /\{\{/.test(imp.character.personality), false);
  check('导入展开：角色字段用上玩家称呼', imp.character.personality.includes('阿岚'), true);
  check('导入展开：开场白里没有占位符', /\{\{/.test(imp.character.first_mes), false);
  check('导入展开：开场白用了两个名字', imp.character.first_mes.includes('沈砚') && imp.character.first_mes.includes('阿岚'), true);
  check('导入展开：世界书正文里没有占位符', /\{\{/.test(imp.worldBookMarkdown), false);
  check('导入展开：世界书正文换成两个名字', imp.worldBookMarkdown.includes('阿岚在沈砚面前跪了三下'), true);
  check('导入展开：world 字段里没有占位符', /\{\{/.test(imp.world), false);
  check('导入展开：给出占位符总数', imp.placeholders.total >= 6, true);
  check('导入展开：摘要里带上统计', imp.summary.some((s) => s.includes('已展开占位符')), true);
  const md = cardToMarkdown(decoded, { userLabel: '阿岚' });
  check('导入展开：卡全文里也没有占位符', /\{\{/.test(md.text), false);
  check('导入展开：卡全文明说占位符已展开', md.text.includes('占位符已展开'), true);
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
