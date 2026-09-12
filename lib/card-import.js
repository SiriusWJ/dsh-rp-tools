/**
 * 角色卡 → 本插件会话配置的映射。
 *
 * 设计依据全部来自 docs/PNG-CARD-DECODE.md 的 3269 张卡实测：
 *
 * ① **`first_mes` 100% 是广告**（3269/3269 含 `deepseektavern.com`，98.9% 是同一段 206 字模板）
 *    → **必须丢弃**，真正的开场白在 `alternate_greetings`（抽查 38 条，含广告 0 条，中位 1126~2310 字）。
 *    否则「文风锚点」导入的全是广告 —— 而我们的 `first_mes` 正是当文风范本用的。
 *
 * ② **40% 的卡正文不在 `description` 里**（931 张 description 完全为空；
 *    1291 张的正文全在 `character_book`），所以**导入的主战场是世界书，不是字段**。
 *
 * ③ **32% 的世界书条目没有 keys**。我们的 `activateLore` 里「无 keys 且非常驻」的条目**永不触发**
 *    → 这类条目**必须补 `constant`**，否则等于导入一堆死条目。
 *
 * ④ 单卡最大 167 万字 → 必须限量（`LORE_IMPORT_MAX_ENTRIES` / `LORE_IMPORT_MAX_CHARS`），
 *    其余写进工作区文件让 DM 按需 `read`，而不是全塞进世界书。
 */

/** 导入广告的指纹。 */
const AD_MARKERS = ['deepseektavern.com', 'Deepseek Tavern', '酒馆专属'];

/** 正文里出现广告的判定（用于 `first_mes` 与备用开场白）。 */
export function isAdText(text) {
  const s = String(text ?? '');
  if (!s.trim()) return false;
  return AD_MARKERS.some((m) => s.includes(m));
}

/** 世界书导入上限：条目数与正文总字数（超出部分写独立文件）。 */
export const LORE_IMPORT_MAX_ENTRIES = 60;
export const LORE_IMPORT_MAX_CHARS = 60000;

/** 角色字段的字数上限（防止把几十万字的设定塞进每轮注入）。 */
const FIELD_CHARS = { first_mes: 1200, mes_example: 1200, personality: 1500, relations: 600 };

/** 玩家称呼的默认值（`{{user}}` 之类占位符会被换成它，可在设置页改）。 */
export const DEFAULT_USER_LABEL = '玩家';

/** 合法的宿主变量名（DSH 要求 `[a-z][a-z0-9_]*`，见 systemPrompt.variable 的契约）。 */
export const MACRO_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;

/** `{{char}}` 系列：导入时按卡名**就地展开**（它不是全局变量，一场戏可能有多个角色）。 */
const CHAR_MACROS = /^(char|char_name|character|bot)$/i;
/** `{{user}}` 系列：注册成宿主变量，注入时由宿主插值 → **保留原文**。 */
const USER_MACROS = /^(user|persona|player)$/i;
/**
 * **自动宏**：卡里写 `{{time}}` 这类，值由宿主在装配时算出来（用户不用填）。
 * 面板里会标成「自动」；用户也可以在宏表里给个固定值覆盖它（例如把游戏内时间钉死）。
 */
export const AUTO_MACROS = [
  // 日期/时间的整串形式
  'time', 'date', 'datetime', 'isotime', 'localtime', 'timezone', 'weekday',
  // 日期/时间的**分量**：`{{year}}年{{month}}月{{day}}日` 这种写法在卡里非常常见，
  // 以前它们要用户手填，其实都能从当前时间算出来。想钉死游戏内年份就填一个值覆盖它。
  'year', 'month', 'day', 'hour', 'minute', 'second',
];
/**
 * 自动宏的当前值（`{{time}}` / `{{date}}` / …）。
 *
 * 放在这个纯模块里，宿主与导出两条路共用同一份实现（导出时也要能填出真值）。
 * 宏表里给了固定值就优先用 —— 用户可以把「游戏内时间」钉死，不必等于真实时间。
 */
export function autoMacroValue(name, table = {}) {
  const fixed = String(table?.[name] ?? '').trim();
  if (fixed) return fixed;
  const now = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
  const time = `${p2(now.getHours())}:${p2(now.getMinutes())}`;
  switch (name) {
    case 'date': return date;
    case 'time':
    case 'localtime': return time;
    case 'datetime': return `${date} ${time}`;
    case 'weekday': return `星期${'日一二三四五六'[now.getDay()]}`;
    case 'isotime': return now.toISOString();
    case 'timezone': return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
    // 分量：两位补零（年份四位），和 `{{date}}` 的写法一致
    case 'year': return String(now.getFullYear());
    case 'month': return p2(now.getMonth() + 1);
    case 'day': return p2(now.getDate());
    case 'hour': return p2(now.getHours());
    case 'minute': return p2(now.getMinutes());
    case 'second': return p2(now.getSeconds());
    default: return '';
  }
}
const TIME_MACROS = new RegExp(`^(${AUTO_MACROS.join('|')})$`, 'i');

/**
 * 处理卡里的占位符。
 *
 * 语义（2026-09-12 定，配合「按会话的宏表」）：
 * - `{{char}}` / `<CHAR>` / `<BOT>` → **就地展开**成卡名（宿主没有这个变量，且一场戏可能多角色）；
 * - `{{user}}` / `<USER>` 与**其它合法名字**的 `{{x}}` → **原样保留**（改成小写），
 *   交给宿主变量插值 —— 值来自**按会话隔离的宏表**（面板可改、导入时可填），
 *   所以以后在面板里改值，已经导入的文本**立刻跟着变**（不再是把值烤进文件里）；
 * - 时间类 → 删掉；名字不合法（含参数、含空格、大写以外的怪写法如 `{{random:1,10}}`）→ 去掉花括号只留文字。
 *
 * `keepMacros: false` 用于「要给人看的导出」（这时把已知宏展开成具体值更易读）。
 */
/**
 * 小而稳的**确定性**随机：同一组（种子 + 序号）永远得到同一个结果。
 *
 * 为什么不用 Math.random：`{{random:a,b}}` / `{{roll:1d6}}` 的结果会被**写进世界书**，
 * 如果每次导入摇出不同结果，同一张卡重导一次就换了个世界（而且没法解释「怎么变了」）。
 * 用确定性随机 + 固定种子（卡路径），同一张卡每次导入得到同样的抽取结果 —— 可复现。
 */
function fnv1a(text) {
  let h = 0x811c9dc5;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `{{random:a,b,c}}`：等概率抽一个（分隔符支持逗号与 `|`）。 */
export function expandRandom(args, rand) {
  const options = String(args ?? '').split(/[,|]/).map((s) => s.trim()).filter(Boolean);
  if (!options.length) return '';
  return options[Math.floor(rand() * options.length)];
}

/** `{{roll:2d6+1}}`：掷一次（`d20` 默认 1 颗；支持 `+N` / `-N`）。 */
export function expandRoll(args, rand) {
  const m = /^(\d*)d(\d+)([+-]\d+)?$/i.exec(String(args ?? '').replace(/\s+/g, ''));
  if (!m) return '';
  const count = m[1] ? Number(m[1]) : 1;
  const faces = Number(m[2]);
  const mod = m[3] ? Number(m[3]) : 0;
  if (!Number.isFinite(count) || !Number.isFinite(faces) || count < 1 || faces < 1 || count > 100) return '';
  let sum = 0;
  for (let i = 0; i < count; i += 1) sum += 1 + Math.floor(rand() * faces);
  return String(sum + mod);
}

export function resolvePlaceholders(text, { userLabel = DEFAULT_USER_LABEL, charLabel = '', keepMacros = true, macros, seed = '' } = {}) {
  const counts = {};
  const bump = (label) => { counts[label] = (counts[label] ?? 0) + 1; };
  const user = String(userLabel ?? '').trim() || DEFAULT_USER_LABEL;
  const char = String(charLabel ?? '').trim();
  // keepMacros=false 时用具体值替换（user 用传入值或宏表里的值）
  const macroValue = (name) => {
    const table = macros && typeof macros === 'object' ? macros : {};
    if (typeof table[name] === 'string' && table[name]) return table[name];
    if (name === 'user') return user;
    if (AUTO_MACROS.includes(name)) return autoMacroValue(name, table);   // 时间/日期：导出时也要有真值
    return '';
  };

  let out = String(text ?? '');
  if (!out) return { text: out, counts, total: 0 };
  // 确定性随机的序号：同一次替换里第几个 `{{random/roll}}`（保证同一个占位符每次得到同一个值）
  let seq = 0;

  // 尖括号写法（STscript 时代的习惯）：宿主不认，一律就地展开
  out = out.replace(/<\s*(user|persona|player)\s*>/gi, () => { bump('<USER>'); return user; });
  if (char) out = out.replace(/<\s*(char|char_name|bot)\s*>/gi, () => { bump('<CHAR>'); return char; });

  // 双花括号：按名字决定「展开 / 保留 / 去括号」
  out = out.replace(/\{\{\s*([^{}]{0,80}?)\s*\}\}/g, (_m, rawName) => {
    const name = String(rawName).trim();
    if (CHAR_MACROS.test(name)) {
      bump('{{char}}');
      return char || name;
    }
    if (TIME_MACROS.test(name)) {
      // 自动宏：保留原文，由宿主变量在装配时填当前时间（面板里标「自动」，用户可不填）
      const autoName = name.toLowerCase();
      bump(`{{${autoName}}}`);
      return keepMacros ? `{{${autoName}}}` : macroValue(autoName);
    }
    const lower = name.toLowerCase();
    if (MACRO_NAME_RE.test(lower)) {
      if (USER_MACROS.test(lower)) { bump('{{user}}'); } else { bump(`{{${lower}}}`); }
      return keepMacros ? `{{${lower}}}` : macroValue(lower);
    }
    // 名字不合法（`{{random:1,10}}`、`{{roll:2d6}}`、`{{//注释}}`、带空格…）：
    // ① 能认的（random / roll）**当场展开**成具体内容 —— 确定性随机，重导同一张卡结果一致；
    // ② 其余**直接删掉**（以前是「去掉花括号只留文字」，于是世界书里会残留 `random:1,10`
    //    这种脏字串；用户明确要求改成删掉）。
    const call = /^(random|roll)\s*:\s*(.+)$/i.exec(name);
    if (call) {
      seq += 1;
      const rand = mulberry32(fnv1a(`${seed}|${call[1].toLowerCase()}|${call[2]}|${seq}`));
      const value = call[1].toLowerCase() === 'random' ? expandRandom(call[2], rand) : expandRoll(call[2], rand);
      if (value !== '') {
        bump(call[1].toLowerCase() === 'random' ? '{{random:…}}' : '{{roll:…}}');
        return value;
      }
    }
    bump('其它 {{…}}（已删）');
    return '';
  });

  return { text: out, counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
}

/**
 * 把一张卡里**所有可能含宏的文本**收集起来（供 discoverMacros 扫描）。
 * 边界要覆盖全：字段 / 开场白（含所有备用）/ 世界书条目 —— 漏一处，界面就少问用户一个值。
 */
export function collectCardText(decoded) {
  const data = decoded?.data ?? {};
  const out = [];
  for (const f of ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes', 'system_prompt', 'post_history_instructions']) {
    if (data?.[f]) out.push(String(data[f]));
  }
  const alts = Array.isArray(data?.alternate_greetings) ? data.alternate_greetings : [];
  for (const g of alts) if (g) out.push(String(g));
  const entries = Array.isArray(data?.character_book?.entries) ? data.character_book.entries : [];
  for (const e of entries) {
    if (e?.name) out.push(String(e.name));
    if (e?.content) out.push(String(e.content));
  }
  return out;
}

/**
 * 扫出一段文本里用到的**宏名**（供导入界面预填「要填哪些值」）。
 * `char` 系列不算（导入时直接展开成卡名）；返回小写名字的数组。
 */
export function discoverMacros(text) {
  const found = new Map();
  const scan = (s) => {
    const src = String(s ?? '');
    for (const m of src.matchAll(/\{\{\s*([^{}]{0,80}?)\s*\}\}/g)) {
      const name = String(m[1]).trim().toLowerCase();
      if (!MACRO_NAME_RE.test(name)) continue;
      if (CHAR_MACROS.test(name)) continue;
      found.set(name, (found.get(name) ?? 0) + 1);
    }
  };
  if (Array.isArray(text)) text.forEach(scan); else scan(text);
  // 自动宏排在前面（界面要把它们标成「自动」，别让用户以为必须手填）
  return [...found.entries()]
    .map(([name, count]) => ({ name, count, auto: AUTO_MACROS.includes(name) }))
    .sort((a, b) => (Number(b.auto) - Number(a.auto)) || (b.count - a.count));
}

/** 把若干次 resolvePlaceholders 的计数合并成一句给人看的话（没有占位符就返回空串）。 */
export function describePlaceholders(counts) {
  const rows = Object.entries(counts ?? {}).filter(([, n]) => n > 0);
  if (!rows.length) return '';
  return `已展开占位符：${rows.map(([k, n]) => `${k}×${n}`).join('、')}`;
}

/**
 * 卡里的属性行（YAML 风格）中文化：`name: 慕容嫣` → `名称：慕容嫣`、`gender: Female` → `性别：女`。
 *
 * 为什么在导入时做：这类行是**卡作者的书写习惯**（ST 圈子大量卡用英文键），
 * 进了世界书/角色卡就是给 DM 看的设定文本 —— 英文键对中文跑团没有价值，
 * 只会留下「性别: Female」这种半中半英的东西。
 *
 * 安全边界（很重要）：只认**行首的 ASCII 键 + 冒号**，且键必须在白名单里；
 * 中文冒号开头的正常叙述、markdown、`<!-- keys: … -->` 这类注释都碰不到；
 * 白名单外的英文键**原样保留**（宁可不动，也不猜）。
 */
const ATTR_LABELS = {
  name: '名称', full_name: '全名', nicknames: '昵称', nickname: '昵称', alias: '别名', aliases: '别名',
  version: '版本', age: '年龄', gender: '性别', sex: '性别', height: '身高', weight: '体重',
  birthday: '生日', birthdate: '生日', blood_type: '血型', zodiac: '星座', race: '种族', species: '种族',
  occupation: '职业', job: '职业', class: '职业', title: '头衔', titles: '头衔',
  identity: '身份', identities: '身份', role: '定位', roles: '定位',
  appearance: '外貌', looks: '外貌', hair: '发型', eyes: '眼睛', body: '体型', clothing: '服饰', outfit: '服饰', accessories: '配饰',
  personality: '性格', character: '性格', traits: '特质', likes: '喜好', dislikes: '讨厌', hobbies: '爱好',
  habits: '习惯', fetishes: '性癖', speech: '说话方式', voice: '声音', behavior: '行为习惯', mannerisms: '小动作',
  skills: '技能', abilities: '能力', powers: '能力', weapon: '武器', equipment: '装备', items: '物品', inventory: '持有',
  relationships: '人物关系', relations: '人物关系', family: '家庭', friends: '朋友', enemies: '敌人',
  affiliation: '所属', faction: '阵营', background: '背景', history: '经历', story: '经历', bio: '简介',
  description: '设定', summary: '概述', notes: '备注', note: '备注', scenario: '情境', setting: '设定',
  location: '地点', world: '世界', timeline: '时间线', tags: '标签', category: '分类', creator: '作者',
  quote: '口头禅', quotes: '台词', example_dialogue: '对话范例', weakness: '弱点', goal: '目标',
  motivation: '动机', secret: '秘密', status: '状态', level: '等级', money: '金钱', age_range: '年龄段',
  pronouns: '代称', first_person: '自称', second_person: '对玩家的称呼',
};

/** 少量枚举值也顺手翻掉（**只对已知键生效**，免得把 `name: Male` 这种怪数据也改掉）。 */
const ATTR_VALUES = {
  gender: { female: '女', male: '男', f: '女', m: '男', other: '其他', 'non-binary': '非二元', none: '无', unknown: '未知' },
  sex: { female: '女', male: '男', f: '女', m: '男', other: '其他', none: '无', unknown: '未知' },
};

/** @returns {{ text: string, count: number }} 中文化后的文本 + 改了多少行 */
export function localizeAttributes(text) {
  let count = 0;
  const out = String(text ?? '').split(/\r?\n/).map((line) => {
    // 允许缩进与列表符号（`- name: x`），但**键必须是行首的 ASCII 词**
    const m = /^(\s*(?:[-*+]\s+)?)([A-Za-z][A-Za-z0-9_ ]{0,24}?)\s*[:：]\s*(.*)$/.exec(line);
    if (!m) return line;
    const [, indent, rawKey, rawValue] = m;
    const key = rawKey.trim().toLowerCase().replace(/\s+/g, '_');
    const label = ATTR_LABELS[key];
    if (!label) return line;
    let value = rawValue;
    const table = ATTR_VALUES[key];
    if (table) {
      const hit = table[value.trim().toLowerCase()];
      if (hit) value = hit;
    }
    count++;
    return `${indent}${label}：${value}`;
  }).join('\n');
  return { text: out, count };
}

/**
 * 按字数截断（**干净地截**：尽量落在句末/换行，末尾只留一个省略号）。
 *
 * ⚠️ 千万别在正文里插「（已截断，全文见…）」这种**元信息**：这些字段会被注入提示词，
 * 模型看见一句「…（已截断，全文见导出的 JSON）」会当成叙事的一部分接着往下写，
 * 于是开场白里就原样冒出了这行字（用户实测踩到过）。
 * 截断这个事实由 `truncatedFields` 记成**数据**，交给界面显示。
 */
function clamp(text, max) {
  const s = String(text ?? '').trim();
  if (!s) return '';
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  // 在最后 20% 里找断点；找不到就硬切
  const tail = head.slice(Math.floor(max * 0.8));
  const at = Math.max(tail.lastIndexOf('\n'), tail.lastIndexOf('。'), tail.lastIndexOf('！'), tail.lastIndexOf('？'), tail.lastIndexOf('. '));
  return at >= 0 ? `${head.slice(0, Math.floor(max * 0.8) + at + 1).trimEnd()}…` : `${head.trimEnd()}…`;
}

/**
 * 把世界书条目转成 `rp-worldbook.md` 的 markdown。
 *
 * 转换规则（对应调研 §4.2）：
 * - 有 keys → 写进 `keys:`；
 * - **无 keys → 补 `constant`**（否则永不触发）；
 * - `constant: true` → 加 `constant`；
 * - `insertion_order` → `order:`；
 * - `enabled: false` → 跳过（不导成生效条目）；
 * - 排序：constant 优先 → 正文长度降序，取前 N 条、总字数不超上限。
 *
 * @returns {{ markdown: string, kept: number, skipped: number, dropped: Array, totalChars: number, enabledOff: number }}
 */
export function worldBookMarkdown(entries, { maxEntries = LORE_IMPORT_MAX_ENTRIES, maxChars = LORE_IMPORT_MAX_CHARS } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const enabledOff = list.filter((e) => e && e.enabled === false).length;
  const usable = list.filter((e) => {
    const body = String(e?.content ?? '').trim();
    return e && e.enabled !== false && body;
  });

  // constant 优先，其次正文长的（信息量大的先保住）
  const ranked = usable.slice().sort((a, b) => {
    const ca = a.constant === true ? 1 : 0;
    const cb = b.constant === true ? 1 : 0;
    if (ca !== cb) return cb - ca;
    return String(b.content ?? '').length - String(a.content ?? '').length;
  });

  const kept = [];
  const dropped = [];
  let total = 0;
  for (const e of ranked) {
    const body = String(e.content ?? '').trim();
    if (kept.length >= maxEntries || total + body.length > maxChars) { dropped.push(e); continue; }
    kept.push(e);
    total += body.length;
  }

  const blocks = kept.map((e) => {
    const rawKeys = (Array.isArray(e.keys) ? e.keys : []).map((k) => String(k ?? '').trim()).filter(Boolean);
    const flags = [];
    if (rawKeys.length) flags.push(`keys: ${rawKeys.join('、')}`);
    // ⚠️ 无 keys 又非常驻 → 补 constant，否则永远不会被触发
    if (e.constant === true || !rawKeys.length) flags.push('constant');
    if (Number.isFinite(Number(e.insertion_order))) flags.push(`order: ${Number(e.insertion_order)}`);
    const title = String(e.name ?? e.comment ?? '').trim() || `条目 ${kept.indexOf(e) + 1}`;
    const meta = flags.length ? `<!-- ${flags.join(' | ')} -->\n` : '';
    return `## ${title}\n${meta}${String(e.content ?? '').trim()}`;
  });

  const header = [
    '# 从角色卡导入的世界书',
    '',
    '<!-- 由 dsh-rp-tools 从 PNG 角色卡导入。可以直接编辑：## 开一个新条目，',
    '     <!-- keys: 触发词1、触发词2 | constant | order: N | prob: N --> 指定触发方式。',
    '     无 keys 的条目已自动补 constant（否则永远不会被触发）。 -->',
    '',
  ].join('\n');

  return {
    markdown: blocks.length ? `${header}${blocks.join('\n\n')}\n` : '',
    kept: kept.length,
    skipped: dropped.length,
    dropped,
    totalChars: total,
    enabledOff,
  };
}

/**
 * 列出卡里**所有**可用的开场白（过滤掉广告污染的），第一条是默认选择。
 *
 * 为什么全都留着：卡常常带 3~10 条备用开场白（相当于几个不同的开局），
 * 用户可能想挑一条；而且它们进了工作区的引导文件之后**不需要截断**。
 *
 * @returns {{ items: Array<{ text: string, source: string, altIndex: number, chars: number }>, picked: object|null }}
 */
export function listGreetings(data) {
  const items = [];
  const first = String(data?.first_mes ?? '').trim();
  if (first && !isAdText(first)) items.push({ text: first, source: 'first_mes', altIndex: -1, chars: first.length });
  const alts = Array.isArray(data?.alternate_greetings) ? data.alternate_greetings : [];
  alts.forEach((g, i) => {
    const text = String(g ?? '').trim();
    if (text && !isAdText(text)) items.push({ text, source: 'alternate_greetings', altIndex: i, chars: text.length });
  });
  // 备用开场白优先当默认（实测 first_mes 基本都被广告污染，能留下来的很少）
  const picked = items.find((it) => it.source === 'alternate_greetings') ?? items[0] ?? null;
  return { items, picked };
}

/** 挑一条可用的开场白：优先备用开场白里第一条非广告的，最后才退回 first_mes（且要非广告）。 */
export function pickGreeting(data) {
  const { items, picked } = listGreetings(data);
  if (!picked) return { text: '', source: 'none', alternatives: items.length };
  return { text: picked.text, source: picked.source, alternatives: items.length };
}

/**
 * 这张卡里到底有没有**角色**？
 *
 * 为什么需要判断：卡有两种。角色卡（roleplay card）里 `name` 就是那个角色；
 * 而**故事书**（novel/scenario card）里 `name` 是**书名**，角色写在正文/世界书里。
 * 早先不管哪种都把 `name` 建一条人物，于是「下班，然后成为魔法少女」这种书名
 * 直接出现在面板的「人物」列表里（用户报的「标题不是角色卡」）。
 *
 * 判定依据只看**角色专属字段**：描述 / 性格 / 对白范例 / 开场白。
 * 刻意**不算** `scenario`（情境是场景描述，故事书也有）与 `creator_notes`（作者注）。
 */
export function hasCharacterFields(data) {
  const has = (v) => String(v ?? '').trim().length > 0;
  if (has(data?.description) || has(data?.personality) || has(data?.mes_example) || has(data?.first_mes)) return true;
  if (Array.isArray(data?.alternate_greetings) && data.alternate_greetings.some(has)) return true;
  return false;
}

/**
 * 角色卡 → 本插件的角色字段（`CHARACTER_FIELDS`）。
 *
 * 诚实说明：`speech` / `behavior` / `relations` **卡里没有** ——
 * 别假装映射成功，留空让 DM 读正文后自己提炼（工具描述里已经教它怎么填）。
 *
 * `opts.fix` 由 buildImport 传入：把每个字段里的 `{{user}}` / `{{char}}` 展开掉
 * （并累计统计）。单独调用时可以不给，那就得到未展开的原文。
 */
export function cardToCharacter(data, { fix } = {}) {
  const apply = typeof fix === 'function' ? fix : (t) => String(t ?? '');
  const greeting = pickGreeting(data);
  const desc = String(data?.description ?? '').trim();
  const personality = String(data?.personality ?? '').trim();
  // description 与 personality 拼接，各自标注来源，方便用户知道哪段来自哪里
  const parts = [];
  if (desc) parts.push(`【设定】\n${desc}`);
  if (personality) parts.push(`【性格】\n${personality}`);
  const fixedPersonality = apply(parts.join('\n\n'));
  const fixedGreeting = apply(greeting.text);
  const fixedExample = apply(String(data?.mes_example ?? '').trim());
  return {
    name: apply(String(data?.name ?? '').trim() || '（未命名角色）'),
    appearance: '',                       // 卡里的 description 常混外貌与设定，交给 DM 提炼后再填
    personality: clamp(fixedPersonality, FIELD_CHARS.personality),
    speech: '',
    behavior: '',
    relations: '',
    first_mes: clamp(fixedGreeting, FIELD_CHARS.first_mes),
    mes_example: clamp(fixedExample, FIELD_CHARS.mes_example),
    _greetingSource: greeting.source,
    _greetingAlternatives: greeting.alternatives,
    // 哪些字段被截断了（**数据**，不是往正文里插一行「已截断」——那样模型会照着念）
    _truncatedFields: [
      fixedPersonality.length > FIELD_CHARS.personality ? '性格' : '',
      fixedGreeting.length > FIELD_CHARS.first_mes ? '开场白' : '',
      fixedExample.length > FIELD_CHARS.mes_example ? '对话范例' : '',
    ].filter(Boolean),
  };
}

/**
 * 汇总一次导入：会话配置片段 + 世界书 markdown + 给用户看的摘要。
 *
 * `userLabel` / `charLabel` 用来展开卡里的 `{{user}}` / `{{char}}` 等占位符（见 resolvePlaceholders）：
 * 卡名默认当 char，玩家称呼默认「玩家」。占位符统计一并返回，界面会在预览与结果里显示。
 *
 * @returns 纯数据（不落盘），由调用方决定写到哪。
 */
export function buildImport(decoded, { maxEntries, maxChars, userLabel, charLabel, macros, keepMacros = true, seed = '' } = {}) {
  const data = decoded?.data ?? {};
  const char = String(charLabel ?? '').trim() || String(data?.name ?? '').trim();
  const ph = { counts: {}, total: 0 };
  const attrs = { count: 0 };
  /** 展开占位符 + 中文化属性行 + 累计统计（字段/世界/世界书正文都要过一遍） */
  const fix = (text) => {
    const r = resolvePlaceholders(text, { userLabel, charLabel: char, macros, keepMacros, seed });
    for (const [k, n] of Object.entries(r.counts)) ph.counts[k] = (ph.counts[k] ?? 0) + n;
    ph.total += r.total;
    const a = localizeAttributes(r.text);
    attrs.count += a.count;
    return a.text;
  };

  // 卡里没有角色字段（故事书）→ **不把书名当人物**，只导世界书/情境；
  // 调用方据此跳过「写进会话人物表」那一步，界面上也会说明原因。
  const isCharacterCard = hasCharacterFields(data);
  const character = cardToCharacter(data, { userLabel, charLabel: char, fix });
  const cardLabel = String(data?.name ?? '').trim() || character.name;
  const entries = Array.isArray(data?.character_book?.entries) ? data.character_book.entries : [];
  const wb = worldBookMarkdown(entries, { maxEntries, maxChars });
  const worldBook = fix(wb.markdown);

  const world = [
    String(data?.name ?? '').trim() ? `${isCharacterCard ? '【角色卡】' : '【故事书】'}${data.name}` : '',
    String(data?.scenario ?? '').trim() ? `【情境】\n${String(data.scenario).trim()}` : '',
    String(data?.creator_notes ?? '').trim() ? `【作者注】\n${String(data.creator_notes).trim()}` : '',
  ].filter(Boolean).join('\n\n');

  const adDropped = isAdText(data?.first_mes) ? 1 : 0;
  const summary = [
    isCharacterCard ? `角色卡：${character.name}` : `故事书：${cardLabel}（卡里没有角色字段，不建人物）`,
    `规范：${decoded?.kind ?? '?'}（${decoded?.chunk ?? '?'} 块）`,
    `开场白来源：${character._greetingSource === 'alternate_greetings'
      ? `备用开场白第 1 条（共 ${character._greetingAlternatives} 条可选）`
      : character._greetingSource === 'first_mes' ? 'first_mes（未检出广告）' : '无'}`,
    adDropped ? '已丢弃被广告污染的 first_mes' : '',
    `世界书：保留 ${wb.kept} 条 / 跳过 ${wb.skipped} 条 / 其中 ${wb.enabledOff} 条原卡已禁用`,
    `世界书正文：${wb.totalChars} 字`,
    `情境：${world ? `${world.length} 字` : '无'}`,
    describePlaceholders(ph.counts),
    attrs.count ? `已把 ${attrs.count} 行属性标签中文化（name→名称、gender: Female→性别：女 …）` : '',
  ].filter(Boolean);

  return {
    character,
    // 这张卡到底有没有角色：false = 故事书（书名为 name，角色在正文里）。
    // 调用方据此决定**要不要**把它写进会话人物表（别把书名当人物）。
    isCharacterCard,
    // 未截断的开场白：角色字段里那份是给提示词用的短版（1200 字），
    // 而开场指令要引用更完整的原文（见 buildOpeningPrompt 的注释）
    greeting: fix(pickGreeting(data).text),
    world: fix(world),
    worldBookMarkdown: worldBook,
    summary,
    stats: wb,
    placeholders: ph,
    attributes: attrs,
    decodedKind: decoded?.kind,
  };
}

/**
 * 卡全文的 markdown 导出（写到工作区 `rp-cards/<slug>.md`）。
 *
 * 为什么需要：世界书有 60 条 / 6 万字的导入预算（超出的条目会被丢掉），
 * 但那些被丢掉的设定不该消失 —— 它们进这个文件，DM 需要时用 `read` 按需取。
 * 这样「导入的体量」与「每轮注入的体量」彻底解耦。
 *
 * @returns {{ text: string, truncated: boolean }}
 */
export function cardToMarkdown(decoded, { maxChars = 400000, userLabel, charLabel, keepMacros = true, macros, seed = '' } = {}) {
  const data = decoded?.data ?? {};
  const char = String(charLabel ?? '').trim() || String(data?.name ?? '').trim();
  // 全文导出也要展开占位符 + 中文化属性标签：
  // DM 会 read 这个文件，`{{user}}` 与 `gender: Female` 留在里面都是谜语
  const fix = (t) => localizeAttributes(resolvePlaceholders(t, { userLabel, charLabel: char, keepMacros, macros, seed }).text).text;
  const out = [
    `# ${fix(String(data?.name ?? '').trim() || '（未命名卡）')}`,
    '',
    `> 由 dsh-rp-tools 从 PNG 角色卡导入（规范 ${decoded?.kind ?? '?'}，来源块 ${decoded?.chunk ?? '?'}）。`,
    '> 世界书只导入了预算内的条目，**这里是全文**；需要细节时按标题查这一段。',
    `> 卡里的 user / char 占位符已展开为「${String(userLabel ?? '').trim() || DEFAULT_USER_LABEL}」/「${char}」。`,
    '',
  ];
  const section = (title, body) => {
    const text = fix(String(body ?? '').trim());
    if (text) out.push(`## ${title}`, '', text, '');
  };
  section('设定（description）', data?.description);
  section('性格（personality）', data?.personality);
  section('情境（scenario）', data?.scenario);
  section('对话范例（mes_example）', data?.mes_example);
  section('作者注（creator_notes）', data?.creator_notes);
  section('系统提示（system_prompt）', data?.system_prompt);
  section('首条消息（first_mes，原始未过滤）', data?.first_mes);

  const alts = Array.isArray(data?.alternate_greetings) ? data.alternate_greetings : [];
  alts.forEach((g, i) => { section(`备用开场白 ${i + 1}`, g); });

  const entries = Array.isArray(data?.character_book?.entries) ? data.character_book.entries : [];
  if (entries.length) {
    out.push(`## 卡组世界书全文（${entries.length} 条）`, '');
    entries.forEach((e, i) => {
      const keys = (Array.isArray(e?.keys) ? e.keys : []).map((k) => String(k ?? '').trim()).filter(Boolean);
      const flags = [
        keys.length ? `keys: ${keys.join('、')}` : '（无 keys）',
        e?.constant === true ? 'constant' : '',
        e?.enabled === false ? '原卡已禁用' : '',
        Number.isFinite(Number(e?.insertion_order)) ? `order: ${Number(e.insertion_order)}` : '',
      ].filter(Boolean).join(' | ');
      out.push(`### ${fix(String(e?.name ?? e?.comment ?? '').trim() || `条目 ${i + 1}`)}`, '', `<!-- ${flags} -->`, '', fix(String(e?.content ?? '').trim()), '');
    });
  }

  const text = out.join('\n').replace(/\n{4,}/g, '\n\n\n').trim() + '\n';
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, maxChars)}\n\n…（本文档超长已截断）\n`, truncated: true };
}

/** 开场指令里最多引用多少字的卡组开场白（它只是给 DM 定的场景与文风锚点）。 */
export const OPENING_GREETING_CHARS = 4000;

/**
 * 卡组开场白的**引导文件**（写到工作区 `rp-cards/<slug>.opening.md`）。
 *
 * 为什么要有它：开场白动辄几千字，卡的备用开场白还可能有好几条 ——
 * 全塞进「开局」指令里既贵又会撞上字数上限（一截断，模型就会接着残句往下写）。
 * 所以**不截断**，把它们完整写进工作区的文件，让 DM 需要时自己 `read`：
 * 这样「正文的体量」与「这一轮进上下文的体量」就解耦了（与世界书同一个道理）。
 */
export function cardToOpeningFile(decoded, { greetings, chosenIndex = 0, userLabel, charLabel } = {}) {
  const data = decoded?.data ?? {};
  const char = String(charLabel ?? '').trim() || String(data?.name ?? '').trim() || '本卡组';
  const fix = (t) => localizeAttributes(resolvePlaceholders(t, { userLabel, charLabel: char }).text).text;
  const list = Array.isArray(greetings) ? greetings : [];
  const out = [
    `# 《${fix(char)}》卡组开场白（共 ${list.length} 条，未截断）`,
    '',
    '> 由 dsh-rp-tools 从 PNG 角色卡导出。**这里没有任何截断**，需要多少读多少。',
    `> 卡里的 user / char 占位符已展开为「${String(userLabel ?? '').trim() || DEFAULT_USER_LABEL}」/「${char}」。`,
    '> 用法建议：读第 1 条（或标着「默认」的那条）当开场画面与文风锚点，',
    '> **不要照抄、不要复述**；也可以用别的条目换一个开局。',
    '',
  ];
  list.forEach((g, i) => {
    const meta = [i === chosenIndex ? '默认' : '', g.source === 'first_mes' ? 'first_mes' : `备用开场白 #${g.altIndex + 1}`]
      .filter(Boolean).join(' · ');
    out.push(`## 开场白 ${i + 1}${meta ? `（${meta}）` : ''}`, '', fix(String(g.text ?? '').trim()), '');
  });
  if (!list.length) out.push('（这张卡没有可用的开场白。）', '');
  return { text: out.join('\n').replace(/\n{4,}/g, '\n\n\n').trim() + '\n', count: list.length };
}


/**
 * 导入之后替玩家发的那条「开始游戏」指令。
 *
 * 为什么必须显式写「不要再问世界从哪来」：dm 预设的 persona 里，开局第一件事是
 * **问玩家世界从哪来**（原著 / 自带文件 / 原创）。导入卡组的场景下这个问题已经被
 * 回答过了，不问这句的话 DM 会先反问你一遍，导入的设定白导。
 *
 * ⚠️ 引用开场白时**绝不截断在正文中间、更不许往正文里插「（已截断）」这类注释**：
 * 模型会把它当成叙事的一部分照念（用户实测：DM 的第一句回复里原样出现了那行字）。
 * 所以这里用完整开场白（上限 OPENING_GREETING_CHARS，够了就整段给），
 * 超长才在**句末**干净地截断，且「这是节选」这类说明只放在引用**之外**的指令行里。
 */
export function buildOpeningPrompt(imported, { worldFile, cardFile, imageRel, greeting, greetingFile, greetingCount = 0, macros } = {}) {
  const name = String(imported?.character?.name ?? '').trim() || '本卡组';
  // greeting 可由调用方传**未截断**的原文（导入时角色字段里那份是给提示词用的短版）
  const raw = String(greeting ?? imported?.character?.first_mes ?? '').trim();
  const stats = imported?.stats ?? {};
  // 短开场白直接引用（省掉一次工具往返）；长了就只给路径，让 DM 自己读 —— 不截断
  const inline = raw.length <= OPENING_GREETING_CHARS;
  const cut = inline ? raw : '';
  const lines = [
    `【开局】已导入卡组《${name}》，世界设定与角色卡都已就位 —— **不要再问世界从哪来，直接开团**。`,
    '',
    `- 世界书：${worldFile || 'rp-worldbook.md'}（本次导入 ${stats.kept ?? 0} 条，合并后按关键词触发；被预算挡下的条目在下面这个全文文件里）`,
    `- 卡组全文：${cardFile || '（未写出）'}${imageRel ? `（卡面图 ${imageRel}）` : ''}`,
    greetingFile
      ? `- 卡组开场白：${greetingFile}${greetingCount > 1 ? `（共 ${greetingCount} 条可选，第 1 条是默认）` : ''}`
      : '',
    `- 本会话的宏：${Object.entries(macros ?? {}).filter(([, v]) => String(v ?? '').trim())
      .map(([k, v]) => `{{${k}}} = ${String(v).slice(0, 40)}`).join('、') || '（无）'}`,
    '  （世界书 / 设定里写的 `{{宏名}}` 会由系统自动替换成上面的值；玩家改名字或设定时以这里为准，不要自己编。）',
    `- 角色卡《${name}》已载入（详细卡片会在提到该角色时展开）`,
    '',
    '请按这个顺序开场：',
    '1. 先用 2-4 段描写开场画面（延续卡组的文风与描写密度）；',
    '2. 交代玩家角色此刻的位置、处境、以及眼前最要紧的事；',
    '3. 给 2-3 个可以立刻行动的选项（用带 action 的按钮卡片），然后停下等玩家回应。',
  ].filter((l) => l !== '');
  if (cut) {
    lines.push(
      '',
      // 说明放在引用**之前**，且明说引用之外才是指令 —— 模型会把引用整体当素材，不会去续写它
      '下面是卡组自带的开场白，**只作场景与文风参考：不要照抄、不要在你的回复里复述它、也不要接着它往下写**。',
      '',
      cut,
    );
  } else if (raw && greetingFile) {
    lines.push(
      '',
      `卡组自带的开场白比较长（${raw.length} 字），完整放在 ${greetingFile} 里 —— `
      + '**开场前先 read 这个文件**，取它的场景与文风，但不要照抄、不要复述、也不要接着它往下写。',
    );
  }
  return lines.join('\n');
}

