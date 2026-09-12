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
 * ③ **32% 的世界书条目没有 keys**。运行时会把条目标题当默认触发 key；导入器必须保留
 *    原卡的 `constant` 语义，不能把所有无 keys 条目擅自升级成每轮常驻。
 *
 * ④ 单卡最大 167 万字 → 必须限量（`LORE_IMPORT_MAX_ENTRIES` / `LORE_IMPORT_MAX_CHARS`），
 *    其余写进工作区文件让 DM 按需 `read`，而不是全塞进世界书。
 */

/** 导入广告的指纹。 */
const AD_MARKERS = ['deepseektavern.com', 'Deepseek Tavern', '酒馆专属'];

/**
 * 「广告 / 授权 / 社群」类噪音的判定，**只用在卡片的元信息字段**（`creator_notes` 那种）。
 *
 * 为什么需要：真卡的 `creator_notes` 基本是同一套模板 —— 分享群号、Discord 邀请、
 * 「请勿倒卖、侵删」、CC BY-SA 授权链接。它们进【世界设定】以后就是每轮注入的纯噪音
 * （用户截图里的「本角色卡分享于破限组交流群：704819371…」）。
 *
 * 边界刻意收窄：**只作用于元信息字段**，不碰 `description` / 世界书正文 ——
 * 那些是真正的设定，宁可留着也不误删（§9：不替用户猜）。
 */
const PROMO_PATTERNS = [
  // 社群 / 引流
  /交流群|讨论群|QQ\s*群|qq\s*群|加群|群号|discord|telegram|t\.me\/|patreon|afdian|爱发电|赞助|打赏|三连|关注我|订阅|频道/i,
  // 转卖 / 侵权声明
  /请勿倒卖|禁止倒卖|严禁倒卖|倒卖|盗卖|侵删|如有侵权|请勿转载|转载请注明|转载/,
  // 授权 / 版权
  /creativecommons|creative\s*commons|CC[-\s]?BY|许可证|版权|版权所有|授权/i,
  // 联系方式 / 出处
  /分享于|分享自|联系方式|加微信|微信[:：]|QQ[:：]?\s*\d/i,
];

/**
 * 去掉元信息里的广告/授权/社群行。
 *
 * 逐行判定而不是整段丢弃：一条 `creator_notes` 里常常「一半是卡片玩法说明、一半是广告」，
 * 整段扔会把有用的说明一起扔掉（真卡实测就是这样）。
 *
 * @returns {{ text: string, dropped: number, chars: number }}
 */
export function stripPromo(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const kept = [];
  let dropped = 0;
  for (const line of lines) {
    const s = line.trim();
    if (s && PROMO_PATTERNS.some((re) => re.test(s))) { dropped += 1; continue; }
    kept.push(line);
  }
  const out = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text: out, dropped, chars: out.length };
}


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
 * 世界书条目的正文是不是**空壳**（没有内容，只有 markdown 脚手架或占位词）。
 *
 * 为什么需要：真卡里不少条目的正文就是「1. / markdown」这种模板残留
 * （用户实测在面板里看到「足 / 14 字」这种条目）。它们既占每轮注入的预算，
 * 又会让模型以为「这里有条规则」。
 *
 * 判法（**刻意保守**，只丢「压根没内容」的）：
 * 1. 去掉 markdown 脚手架、纯符号、纯数字、以及英文占位词（markdown/content/todo…）；
 * 2. 如果**剩下的整个串**只是占位词（内容/正文/空/略/无…）也一并去掉；
 * 3. 剩下不足 2 个字符 → 空壳。
 *
 * 为什么不直接「见到『无』就减字」：中文里「无」是常用字，
 * 「无言」「无法回头」会被误判 —— 实测第一版就把 `正文 A` 判成了空壳（测试抓出来的）。
 * 所以中文占位词只在**整串就是它**的时候才算。
 */
export function isJunkLoreBody(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) return true;
  const stripped = raw
    .replace(/```[a-z]*/gi, ' ')                  // 代码围栏
    .replace(/[#*\-—>`|~[\](){}（）【】]/g, ' ')     // 脚手架
    .replace(/\b(markdown|md|text|content|todo|tbd|placeholder|none|null|n\/a)\b/gi, ' ')
    .replace(/[\s\d.,，。:：;；、!！?？"'“”‘’_=+*/\\@$%^&<>]/g, '')
    .replace(/^(内容|正文|占位|待填|待定|待补|暂无|没有|同上|见上|空|略|无)+$/, '');
  return stripped.length < 2;
}

/** 世界书条目的**类别**：面板上给个小标签，一眼知道这条是设定还是状态/历史。 */
export function loreKindOf({ title = '', body = '' } = {}) {
  const head = `${title} ${String(body).slice(0, 60)}`;
  if (/历史|事件|经过|纪要|前情|回顾|日志|时间线/.test(head)) return '历史';
  if (/当前|状态|进度|好感|关系|物品|背包|持有|线索|目标|任务/.test(head)) return '状态';
  if (/规则|玩法|要求|禁止|限制|必须|输出|格式|界面|指令/.test(head)) return '规则';
  return '设定';
}

/**
 * 世界书条目的标题 —— 卡里没给名字时**不要只叫「条目 N」**。
 *
 * 用户实测的面板：二十条里十七条叫「条目 4」「条目 5」…根本认不出哪条是干什么的。
 * 这些条目的正文/触发词里其实是有信息的（真卡：`--战斗、--b` 配「D4=1-4. Roll to determine
 * damage」），所以按下面的顺序退而求其次，**第一顺位永远是卡自己给的名字**：
 *
 * 1. `name` / `comment`；
 * 2. 正文里第一个 markdown 标题（跳过代码围栏内的 —— 那里是卡画的面板，不是标题）；
 * 3. 触发词（去掉 `--` 前缀）：`--战斗` → 「战斗」；三个以上触发词时标成「营地 等 8 项」；
 * 4. 正文里第一个像标题的短行；
 * 5. 全都拿不到才退回「条目 N」。
 *
 * 刻意**不改变触发行为**：`keys` 已经在 meta 里显式写死，标题只影响显示与人工阅读。
 */
export function loreTitleOf(entry, index = 0) {
  const named = String(entry?.name ?? entry?.comment ?? '').trim();
  if (named) return named.slice(0, 80);
  const body = String(entry?.content ?? '').trim();
  const lines = body.split(/\r?\n/);
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (heading && heading[1].trim().length >= 2) return heading[1].trim().slice(0, 60);
  }
  const keys = (Array.isArray(entry?.keys) ? entry.keys : [])
    .map((k) => String(k ?? '').replace(/^[\s\-–—_*]+/, '').replace(/[\s\-–—_*]+$/, '').trim())
    .filter(Boolean);
  // 只取**第一个**触发词当名字：面板那一列本来就写着完整的 `keys: --详细地图、--dmap`，
  // 标题里再挂一句「等 2 项」纯属重复；而「详细地图」四个字一眼就知道这条干什么。
  if (keys.length) return keys[0].slice(0, 60);
  // 没有触发词可用 → 落到「正文首行」那条规则（**不能在这里直接返回「条目 N」**）
  const first = lines.map((l) => l.trim()).find((l) => l && !/^<[^>]{1,24}>$/.test(l) && !/^```/.test(l));
  if (first && first.length <= 40 && !/^\d+[.、)]?$/.test(first)) {
    return first.replace(/^[\s\-–—*#>]+/, '').slice(0, 60);
  }
  return `条目 ${index + 1}`;
}

/** 标题去重：世界书**按标题合并/触发**，重名条目会被 mergeWorldBook 当成重复而丢掉。 */
export function uniqueTitle(title, used) {
  const base = String(title ?? '').trim() || '条目';
  const n = (used.get(base) ?? 0) + 1;
  used.set(base, n);
  return n === 1 ? base : `${base}（${n}）`;
}

/**
 * 把世界书条目转成 `rp-worldbook.md` 的 markdown。
 *
 * 转换规则（对应调研 §4.2）：
 * - 有 keys → 写进 `keys:`；
 * - 无 keys → 保持无 keys，由运行时用标题作为默认触发 key；
 * - 仅原卡明确 `constant: true` 时加 `constant`；
 * - `insertion_order` → `order:`；
 * - `enabled: false` → 跳过（不导成生效条目）；
 * - 正文是空壳（`isJunkLoreBody`）→ 跳过；
 * - 排序：显式 constant 优先 → 正文长度降序，取前 N 条、总字数不超上限。
 *
 * @returns {{ markdown: string, kept: number, skipped: number, dropped: Array, totalChars: number, enabledOff: number, emptySkipped: number }}
 */
export function worldBookMarkdown(entries, { maxEntries = LORE_IMPORT_MAX_ENTRIES, maxChars = LORE_IMPORT_MAX_CHARS } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const enabledOff = list.filter((e) => e && e.enabled === false).length;
  // 空壳条目直接不要（用户要求：「需要智能过滤世界书，无内容的不要」）
  const emptySkipped = list.filter((e) => e && e.enabled !== false && isJunkLoreBody(e.content)).length;
  const usable = list.filter((e) => {
    const body = String(e?.content ?? '').trim();
    return e && e.enabled !== false && body && !isJunkLoreBody(body);
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

  // 标题：卡里没给名字的条目**不能只叫「条目 4」** —— 面板上二十条「条目 N」等于没名字，
  // 运行时也是靠标题/触发词认条目的。退而求其次也要能认出「这条是干什么的」：
  // 正文里的第一个 markdown 标题 → 触发词（`--战斗` → 战斗）→ 首个像标题的正文行。
  const usedTitles = new Map();
  const blocks = kept.map((e, index) => {
    const rawKeys = (Array.isArray(e.keys) ? e.keys : []).map((k) => String(k ?? '').trim()).filter(Boolean);
    const flags = [];
    if (rawKeys.length) flags.push(`keys: ${rawKeys.join('、')}`);
    // 无 keys 时保持原样：运行时解析器会用标题作为默认触发 key。
    if (e.constant === true) flags.push('constant');
    if (Number.isFinite(Number(e.insertion_order))) flags.push(`order: ${Number(e.insertion_order)}`);
    // **来源标记**：这条是导入来的，不是玩家手写的。
    // 注入侧的 planLoreInjection() 据此不让外部世界书因 `constant` 自动获得 system 权限
    // （见 index.js：标记为 card 的常驻条目降级到 runtime，按触发词命中）。
    flags.push('source: card');
    const title = uniqueTitle(loreTitleOf(e, index), usedTitles);
    const meta = `<!-- ${flags.join(' | ')} -->\n`;
    return `## ${title}\n${meta}${String(e.content ?? '').trim()}`;
  });

  const header = [
    '# 从角色卡导入的世界书',
    '',
    '<!-- 由 dsh-rp-tools 从 PNG 角色卡导入。可以直接编辑：## 开一个新条目，',
    '     条目正文前写一行注释指定触发方式 —— keys: 触发词1、触发词2 | constant | order: N | prob: N。',
    '     无 keys 时运行时会用条目标题触发；原卡明确 constant 的条目会保留 constant 标记，',
    '     但导入来的条目按需注入（不进系统提示），手写条目在预算内才常驻。 -->',
    '',
  ].join('\n');

  return {
    markdown: blocks.length ? `${header}${blocks.join('\n\n')}\n` : '',
    kept: kept.length,
    skipped: dropped.length,
    dropped,
    totalChars: total,
    enabledOff,
    emptySkipped,       // 正文是空壳（只有 markdown 脚手架/占位词）而没导进来的条数
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
 * 早先不管哪种都把 `name` 建一条角色，于是「下班，然后成为魔法少女」这种书名
 * 直接进了面板的角色列表。
 *
 * 判定标准（2026-09-12 收紧过一次）：
 * **只认 description / personality**，也就是「角色描述 / 性格」这两项真正属于角色卡的字段。
 * 一开始还把 `first_mes`（开场白）和 `mes_example`（对白范例）算进来 —— 结果**拦不住**
 * 真事故里的那张卡：它 description/personality 都是 0，只有 206 字的 first_mes（故事开场白）
 * 和 22 条世界书，照样被建成了一个空壳角色。故事书同样有开场白与对白，这两项不是角色专属。
 *
 * `scenario`（情境）与 `creator_notes`（作者注）同样**不算** —— 故事书也有。
 */
export function hasCharacterFields(data) {
  const has = (v) => String(v ?? '').trim().length > 0;
  return has(data?.description) || has(data?.personality);
}

/** 正则里的字面量转义（卡名会进正则）。 */
function escapeRe(text) {
  return String(text ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 收集 DM（旁白 / 主持人）规则的识别信号。
 *
 * 卡可以同时含 DM 规则、世界书和真正的主角设定，因此这里返回诊断数据而不是只做
 * 「DM 或角色」的互斥二分。`isDmCardData()` 仍保留布尔接口，供旧调用方兼容使用。
 * `system_prompt` / `post_history_instructions` 也是 DM 规则的常见主来源，不能漏扫。
 */
export function detectDmCardData(data) {
  const name = String(data?.name ?? '').trim();
  const fields = [
    ['system_prompt', data?.system_prompt],
    ['post_history_instructions', data?.post_history_instructions],
    ['description', data?.description],
    ['personality', data?.personality],
    ['behavior', data?.behavior],
    ['speech', data?.speech],
    ['scenario', data?.scenario],
    ['first_mes', data?.first_mes],
    ['mes_example', data?.mes_example],
    ['creator_notes', data?.creator_notes],
    ['relations', data?.relations],
  ].map(([field, value]) => [field, String(value ?? '').trim()]).filter(([, value]) => value);
  const text = fields.map(([, value]) => value).join('\n');
  if (!text) return { isDm: false, strongSignals: [], weakSignals: [], sourceFields: [], sources: [] };

  const strongSignals = [];
  const weakSignals = [];
  const directMaster = /(你|模型|助手|AI|\{\{\s*char\s*\}\}).{0,12}(是|作为|担任|扮演).{0,12}(DM|GM|主持人|游戏主持|地下城主)|you\s+(?:are|act as|serve as|will be)\s+(?:an?\s+|the\s+)?(?:DM|GM|game\s*master|dungeon\s*master)\b|(Dungeon|Game)\s*Master/i.test(text);
  const directNarrator = /(你|模型|助手|AI|\{\{\s*char\s*\}\}).{0,12}(是|作为|担任).{0,12}(故事讲述者|讲述者|叙述者|叙事者|旁白)|you\s+(?:are|act as|serve as|will be)\s+(?:an?\s+|the\s+)?(?:narrator|storyteller)\b/i.test(text);
  const playAllRoles = /(?:扮演|饰演|演绎|控制|代入|负责(?:扮演|描写)?).{0,40}(?:所有|全部|其余|其他).{0,12}(?:NPC|角色|人物)|(?:play(?:ing)?|portray(?:ing)?|roleplay(?:ing)?|control(?:ling)?).{0,30}(?:all|every|other).{0,12}(?:NPCs?|characters?|roles?)/i.test(text);
  const excludesUser = /(?:除(?:了)?|不包括).{0,16}(?:\{\{\s*(?:user|player|persona)\s*\}\}|玩家|用户).{0,8}(?:之外|以外)?|(?:\{\{\s*(?:user|player|persona)\s*\}\}|玩家|用户).{0,8}(?:除外|例外)|except\s+(?:the\s+)?(?:user|player)/i.test(text);
  if (directMaster) strongSignals.push('direct-dm-identity');
  if (directNarrator) strongSignals.push('direct-narrator-identity');
  if (playAllRoles) strongSignals.push(excludesUser ? 'play-all-except-user' : 'play-all-roles');

  const roleSignal = /(\bDM\b|\bGM\b|主持人|游戏主持|地下城主|旁白|故事讲述者|讲述者|叙述者|叙事者|\bnarrator\b|\bstoryteller\b|语言模型|\bAI\b.{0,6}(语气|助手|assistant))/i.test(text);
  const nameWill = name !== '' && new RegExp(`\\b${escapeRe(name)}\\s+will\\b`, 'i').test(text);
  const gmTalk = /((引导|带领|带你|让你|给你|告诉).{0,20}(冒险|游戏|世界|故事|选择|背景))|choose a genre|create a world|tell me your character|what kind of (story|world)/i.test(text);
  if (roleSignal) weakSignals.push('dm-role-language');
  if (nameWill) weakSignals.push('card-name-will');
  if (gmTalk) weakSignals.push('gm-addresses-player');

  const hint = /(\bDM\b|\bGM\b|主持人|游戏主持|地下城主|旁白|故事讲述者|讲述者|叙述者|叙事者|\bnarrator\b|\bstoryteller\b|扮演|饰演|演绎|playing|portray|roleplay|引导|带领|create a world|game\s*master|dungeon\s*master)/i;
  const sources = fields
    .filter(([, value]) => hint.test(value))
    .map(([field, value]) => ({ field, excerpt: value.slice(0, 240) }));
  return {
    isDm: strongSignals.length > 0 || weakSignals.length >= 2,
    strongSignals,
    weakSignals,
    sourceFields: sources.map((source) => source.field),
    sources,
  };
}

/** 兼容旧调用方的 DM 卡布尔判定。 */
export function isDmCardData(data) {
  return detectDmCardData(data).isDm;
}

/**
 * DM 卡 → 本会话的 **DM 设定**（`session.dm.prompt`）。
 *
 * 与 `cardToCharacter` 的区别：这里不是在描述「一个人」，而是在收拢「这个 DM 怎么带团」——
 * 所以按 定位 / 语气 / 准则 / 开场白 / 范例 组织，直接读给模型当自己的行为准则。
 * `opts.fix` 与 `cardToCharacter` 同源（展开 `{{user}}`、中文化属性标签）。
 */
export function dmCardToPrompt(data, { fix } = {}) {
  const apply = typeof fix === 'function' ? fix : (t) => String(t ?? '');
  const firstNonBlank = (...values) => values.find((value) => String(value ?? '').trim()) ?? '';
  const cut = (v, max) => clamp(apply(String(v ?? '').trim()), max);
  const rows = [
    ['系统规则', cut(data?.system_prompt, 8000)],
    ['历史后规则', cut(data?.post_history_instructions, 6000)],
    ['角色定位', cut(firstNonBlank(data?.description, data?.personality), 4000)],
    ['语气与叙述', cut(data?.speech, 4000)],
    ['行为准则', cut(firstNonBlank(data?.behavior, data?.personality), 6000)],
    ['开场白（第一次开场时用，之后不要再念）', cut(data?.first_mes, 4000)],
    ['对白与判例范例', cut(data?.mes_example, 6000)],
    ['世界观立场', cut(data?.relations, 2000)],
  ].filter(([, body]) => body);
  if (!rows.length) return '';
  return `导入自卡组《${apply(String(data?.name ?? '').trim() || '未命名')}》的 DM 设定：\n\n`
    + rows.map(([title, body]) => `## ${title}\n${body}`).join('\n\n');
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

  // 卡可以同时有 DM 规则、主角、世界书、状态和开场白，不能再用「DM 或角色」互斥二分。
  // 但 description/personality 自己若已被识别为 DM 规则，就不能把卡名再建成一个假人物。
  // 相反，DM 规则只在 system_prompt 等字段、description/personality 确实描述人物时，两种标签可并存。
  const dmDetection = detectDmCardData(data);
  const characterFieldDmDetection = detectDmCardData({
    name: data?.name,
    description: data?.description,
    personality: data?.personality,
  });
  const hasDmRules = dmDetection.isDm;
  const hasCharacterDescription = hasCharacterFields(data);
  const hasPrimaryCharacter = hasCharacterDescription && !characterFieldDmDetection.isDm;
  const isDmCard = hasDmRules;
  const isCharacterCard = hasPrimaryCharacter;
  const dmPrompt = hasDmRules ? dmCardToPrompt(data, { fix }) : '';
  const character = cardToCharacter(data, { userLabel, charLabel: char, fix });
  const cardLabel = String(data?.name ?? '').trim() || character.name;
  const entries = Array.isArray(data?.character_book?.entries) ? data.character_book.entries : [];
  const greetings = listGreetings(data);
  const usableEntries = entries.filter((entry) => entry && entry.enabled !== false && !isJunkLoreBody(entry.content));
  const hasLore = usableEntries.length > 0;
  const hasRuntimeState = usableEntries.some((entry) => loreKindOf({
    title: String(entry?.name ?? entry?.comment ?? ''),
    body: String(entry?.content ?? ''),
  }) === '状态');
  const hasOpenings = greetings.items.length > 0;
  const wb = worldBookMarkdown(entries, { maxEntries, maxChars });
  const worldBook = fix(wb.markdown);

  // 作者注是**元信息**（且大概率混着广告）：先去掉广告/授权/社群行，剩下的才有资格进【世界设定】。
  // 整段都是广告时干脆不注入（全文仍在 cards/<slug>.md 里，不会被销毁）。
  const notesRaw = String(data?.creator_notes ?? '').trim();
  const notes = notesRaw ? stripPromo(notesRaw) : { text: '', dropped: 0, chars: 0 };

  const world = [
    String(data?.name ?? '').trim()
      ? `${hasDmRules && hasPrimaryCharacter ? '【DM/角色组合卡】' : hasDmRules ? '【DM 卡】' : hasPrimaryCharacter ? '【角色卡】' : '【故事书】'}${data.name}`
      : '',
    String(data?.scenario ?? '').trim() ? `【情境】\n${String(data.scenario).trim()}` : '',
    notes.text ? `【作者注】\n${notes.text}` : '',
  ].filter(Boolean).join('\n\n');

  const adDropped = isAdText(data?.first_mes) ? 1 : 0;
  const summary = [
    hasDmRules && hasPrimaryCharacter
      ? `组合卡：${cardLabel} —— 同时包含 **DM 设定** 与角色《${character.name}》`
      : hasDmRules
        ? `DM（旁白）/场景卡：${cardLabel} —— 已写进本会话的 **DM 设定**，没有把卡名建成角色`
        : hasPrimaryCharacter ? `角色卡：${character.name}` : `故事书：${cardLabel}（卡里没有角色描述/性格，不建角色卡）`,
    `规范：${decoded?.kind ?? '?'}（${decoded?.chunk ?? '?'} 块）`,
    `开场白来源：${character._greetingSource === 'alternate_greetings'
      ? `备用开场白第 1 条（共 ${character._greetingAlternatives} 条可选）`
      : character._greetingSource === 'first_mes' ? 'first_mes（未检出广告）' : '无'}`,
    adDropped ? '已丢弃被广告污染的 first_mes' : '',
    `世界书：保留 ${wb.kept} 条 / 跳过 ${wb.skipped} 条 / 其中 ${wb.enabledOff} 条原卡已禁用`
      + (wb.emptySkipped ? ` / 丢掉 ${wb.emptySkipped} 条空条目（正文只有模板残留）` : ''),
    `世界书正文：${wb.totalChars} 字`,
    `情境：${world ? `${world.length} 字` : '无'}`,
    notes.dropped
      ? `作者注里去掉 ${notes.dropped} 行广告/授权/社群信息${notes.text ? '' : '（整段都是，已不注入；全文见卡文件）'}`
      : '',    describePlaceholders(ph.counts),
    attrs.count ? `已把 ${attrs.count} 行属性标签中文化（name→名称、gender: Female→性别：女 …）` : '',
  ].filter(Boolean);

  return {
    character,
    // 兼容字段：调用方据此决定要不要把卡名写进人物表。DM 规则只出现在 system_prompt
    // 等字段时，它可以与 isDmCard 同时为 true；description/personality 本身是主持规则时则为 false。
    isCharacterCard,
    // 兼容字段：调用方把 `dmPrompt` 写进会话配置的 `dm.prompt`。
    isDmCard,
    // 多标签识别结果（P1 typed import plan 的兼容前置形态）。
    hasDmRules,
    hasPrimaryCharacter,
    hasLore,
    hasRuntimeState,
    hasOpenings,
    recognition: {
      hasDmRules,
      hasPrimaryCharacter,
      hasLore,
      hasRuntimeState,
      hasOpenings,
      characterFieldsAreDmRules: hasCharacterDescription && characterFieldDmDetection.isDm,
      dm: dmDetection,
    },
    dmPrompt,
    // 全量开场白供 writeImportFiles/cardToOpeningFile 落盘；greeting 保留为默认选中项兼容旧调用方。
    greetings: greetings.items,
    greeting: fix(greetings.picked?.text ?? ''),
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

/** 旧调用方可能仍会导入这个常量；开局提示现在不再内联开场白。 */
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
 * 开局**引导文件**（`cards/<slug>.launch.md`）—— 计划 §4。
 *
 * 为什么要有它（而不是把这些内容塞进首条消息）：首条消息要**短**（验收要求 <500 字），
 * 但「从哪开始、有哪些文件、已经写进了什么、还有什么要人确认」这些信息又必须让 DM 拿到。
 * 折中办法就是：消息只给一个路径，细节全在文件里 —— 同一套思路已经用在
 * 卡全文 / 开场白 / 世界书上（体量在文件里，上下文里只留指针）。
 *
 * 内容刻意只做**汇总与指针**，不复述正文：复述一遍等于把这些字又过一遍上下文。
 */
export function cardToLaunchFile(decoded, {
  greetings, chosenIndex = 0, files = {}, built, warnings = [], userLabel, charLabel,
} = {}) {
  const data = decoded?.data ?? {};
  const char = String(charLabel ?? '').trim() || String(data?.name ?? '').trim() || '本卡组';
  const fix = (t) => localizeAttributes(resolvePlaceholders(t, { userLabel, charLabel: char }).text).text;
  const list = Array.isArray(greetings) ? greetings : [];
  const at = Math.max(0, Math.min(Math.max(0, list.length - 1), Number(chosenIndex) || 0));
  const picked = list[at] ?? null;
  const rec = built?.recognition ?? {};
  const name = String(data?.name ?? '').trim() || char;

  const label = (source, altIndex) => (source === 'first_mes'
    ? 'first_mes（未检出广告）'
    : `备用开场白 #${Number(altIndex) + 1}`);

  const lines = [
    `# 《${name}》开局引导`,
    '',
    '> 由 dsh-rp-tools 在导入时生成。**这是开局要读的第一份文件**，',
    '> 读完按「选定开场」开始剧情即可 —— 不需要把内容复述给玩家。',
    '',
    '## 选定开场（按这条开始，不要照抄原文）',
    '',
  ];
  if (picked) {
    lines.push(`来源：${label(picked.source, picked.altIndex)}（本卡共 ${list.length} 条可选）`, '', fix(String(picked.text ?? '').trim()), '');
  } else {
    lines.push(`来源：无（本卡共 ${list.length} 条可选）`, '', '（这张卡没有可用的开场白 —— 按世界书与本会话设定自行开一个场。）', '');
  }

  lines.push('## 落盘文件（需要细节时按需 read，不要整篇搬进对话）', '');
  if (files.opening) lines.push(`- 全部开场白（未截断，共 ${list.length} 条）：${files.opening}`);
  if (files.markdown) lines.push(`- 卡全文（世界书只导入了预算内的条目，这里是全文）：${files.markdown}`);
  if (files.world) lines.push(`- 本会话世界书（可直接编辑）：${files.world}`);
  if (files.image) lines.push(`- 卡面（已登记为本会话封面）：${files.image}`);
  lines.push('');

  lines.push('## 已经写进本会话的内容', '');
  if (built?.dmPrompt) lines.push(`- DM 设定：${String(built.dmPrompt).length} 字（本会话的 DM 行为准则，见系统提示的【本会话设定】）`);
  if (rec.hasPrimaryCharacter && built?.character?.name) lines.push(`- 人物卡：${built.character.name}`);
  else lines.push('- 人物卡：这张卡没有角色字段（或这是 DM 卡）→ **没有建人物**，需要时用 rp_character 建');
  if (built?.world) lines.push(`- 世界设定：${String(built.world).length} 字`);
  const kb = built?.stats ?? {};
  if (kb.kept !== undefined) {
    lines.push(`- 世界书：写入 ${kb.kept} 条（原卡 ${decoded?.data?.character_book?.entries?.length ?? 0} 条）`
      + `；导入来的条目**按触发词注入**，不占系统提示`);
  }
  lines.push('');

  const notes = [
    ...(Array.isArray(warnings) ? warnings : []),
  ];
  if (kb.skipped) notes.push(`有 ${kb.skipped} 条世界书超出导入预算，只在卡全文里（按标题去读）`);
  if (kb.emptySkipped) notes.push(`有 ${kb.emptySkipped} 条世界书正文是空壳，没有导入`);
  if (rec.hasRuntimeState) notes.push('世界书里有「状态/历史」类条目（会过期）—— 需要时把它们挪进 rp_state，别让它长期常驻');
  lines.push('## 需要人工确认（只是提示，不阻塞开局）', '');
  lines.push(...(notes.length ? notes.map((n) => `- ${n}`) : ['- 无']));
  lines.push('');

  // 初始要做的事**全在这里**（用户拍板）：DM 读这份文件就拿到全部开局任务，
  // 面板上不再需要「属性中文化」「重命名无名条目」这类按钮 —— 它们只能做规则能判的那几件，
  // 剩下的（哪条该合并、哪条该改成状态）本来就得 DM 看着办，分成两处反而让人以为没做。
  lines.push('## 现在做什么（按顺序做，做完给玩家一行摘要再开始剧情）', '');
  lines.push('- 按上面「选定开场」开始剧情；**不要复述本文件**，也不要念开场白原文。');
  lines.push('- **不要再问玩家「世界从哪来」**：设定已经写进本会话（见系统提示与本会话世界书）。');
  lines.push('- 先看一眼世界书有哪些条目（`rp_lore(action:"list")`），再按下面对照收拾。');
  lines.push('');
  lines.push(...buildTidyPrompt({
    worldFile: files.world,
    character: built?.character?.name ?? '',
    when: 'launch',
  }).split('\n'));
  return { text: lines.join('\n').replace(/\n{4,}/g, '\n\n\n').trim() + '\n', count: list.length, pickedIndex: at };
}


/**
 * 「开局收尾」的指令正文 —— **导入之后要做的那几件事**，一处措辞两处用：
 *
 * - `when: 'launch'`：写进 `cards/<slug>.launch.md`（计划 §4「初始要做的事都放在初始引导文件里」）。
 *   DM 读那份文件时就拿到了全部初始任务，**不需要面板上再加「属性中文化」「重命名无名条目」
 *   这类按钮** —— 按钮只能做规则能判的那几件事，剩下的（哪条该合并、哪条该改成状态）
 *   本来就得 DM 看着办，分成两处反而让人以为没做。
 * - `when: 'now'`：面板「整理设定」按钮，已开局的会话想再收一次时用。
 * - `when: 'opening'`：兼容旧调用（随开局消息一起发，现在默认不发）。
 */
export function buildTidyPrompt({ worldFile, character = '', loreTitles = [], when = 'opening' } = {}) {
  const who = String(character ?? '').trim();
  const listed = (Array.isArray(loreTitles) ? loreTitles : []).filter(Boolean);
  const head = when === 'launch'
    ? '【开局收尾】导入是按规则解码的，卡里那些「面板模板 / 当前进度 / 物品清单」不一定都该留在世界书里。'
      + '**开始剧情之前**把下面四件收干净（不用问玩家、不用等确认），做完给一行摘要再开场。'
    : when === 'opening'
      ? '【设定整备】开场画面之后**同一轮里**把导入的设定收干净 —— 不要问玩家、也不要停下来等确认，做完给一行摘要就继续。'
      : '【设定整备】现在做一次设定整理：**只做这一件事**，做完回一行摘要，然后停下等玩家。';
  return [
    head,
    '',
    '① 角色卡字段归位（用 `rp_character`）',
    `- ${who ? `《${who}》` : '导入的角色'}现在把一大段描述整坨塞在「性格」里：把外貌搬进 appearance、说话方式搬进 speech、习惯动作搬进 behavior、人物关系搬进 relations、开场白搬进 first_mes、对白范例搬进 mes_example，性格字段只留性格。`,
    '- **只搬家、不缩写、不自己编**：原文里的信息逐字保留。',
    '- **会变的东西不要留在人物卡上**：技能 / 能力 / 当前装备 / 道具 / 金钱 / HP 这类，开局时用 `rp_state`',
    '  写成初始值 —— `party` 行里的 `abilities`（技能能力）、`inventory`（持有装备）、`status`（当前状态），',
    '  数值放 `flags`（如 `桐人_HP: "1744/2500"`）；之后随剧情更新那一行。人物卡只留不会变的底色。',
    '',
    `② 世界书过滤（文件：${worldFile || '本会话的 rp-worldbook.md'}，直接编辑它；改完就是最终版）`,
    '- 只留「世界是什么样」：世界观、势力、地点、规则/禁忌、关键人物、传闻。',
    '- **删掉、或改成按触发词触发**：当前进度 / 前情提要 / 历史纪要 / 物品清单 / 好感度现状 —— 它们是**某一刻的状态**，写进世界书就会过期，还会一直占每轮上下文。这类信息交给 `rp_state`（场景/时间/地点/在场/线索 + 队伍）跟踪。',
    '- 删掉没有正文的空壳条目（正文只剩 `1.`、空的 markdown 代码块、或「待填」这类占位词）。',
    '- 每条补 1-3 个**玩家真的会说出口**的触发词（地名、人名、势力名），别用你自己的分类名。',
    '- `constant`（每轮都注入）只留给真正的核心设定，控制在 1-3 条。',
    '- **玩家手写的条目与注释不要动**：拿不准是不是导入来的，就跳过。',
    '',
    '③ 标题与文字按**当前对话的语言**收拾（一次就够）',
    '- 属性标签用中文（或本次对话用的语言）：`name:` → `名称：`、`gender: Female` → `性别：女`、`relationship:` → `人物关系：`。',
    '  整本一起改用 `rp_lore(action:"localize")`；只有一两条就直接 `edit`。',
    '- **条目标题要一眼看出是什么**：`条目 4`「条目 5」这种编号一律改成按内容/触发词起的实义名 ——',
    '  `--战斗、--b` 的条目就叫「战斗」、`--配方、--recipe` 的叫「配方」。整本一起改用 `rp_lore(action:"rename_unnamed")`。',
    '- 作者留下的原语言正文**不必逐句翻译**（那是有信息量的原文），但你自己新写的条目一律用中文。',
    '',
    '④ 收尾',
    '- 用**一行**说明改了哪几条、删了哪几条，然后继续剧情（不要再展开解释、也不要重复开场画面）。',
    listed.length
      ? `- 当前世界书里的条目（供你对照，不必逐条念）：${listed.slice(0, 30).join('、')}${listed.length > 30 ? ` 等 ${listed.length} 条` : ''}`
      : '',
  ].filter((l) => l !== '').join('\n');
}

/**
 * 导入之后替玩家发的短「开始游戏」指令。
 *
 * 开场白、世界书和卡全文都已落盘；这里仅给一个启动文件指针，避免把几千字开场白再次
 * 塞进消息，也不再默认串联全量“设定整备”。默认指向 `cards/<slug>.launch.md`
 * （见 `cardToLaunchFile`），拿不到它时才退回 `.opening.md` / 卡全文 / 世界书。
 * `tidy: true` 只保留给显式手动调用。
 */
export function buildOpeningPrompt(imported, { launchFile, greetingFile, cardFile, worldFile, tidy = false } = {}) {
  const pointer = [launchFile, greetingFile, cardFile, worldFile]
    .map((value) => String(value ?? '').trim())
    .find(Boolean) || 'rp-worldbook.md';
  const lines = [
    `【开局】请读取 ${pointer}，按其中「选定开场」开始；不要复述文件内容。`,
  ];
  if (tidy) {
    const name = String(imported?.character?.name ?? '').trim() || '本卡组';
    lines.push('', buildTidyPrompt({ worldFile, character: name }));
  }
  return lines.join('\n');
}

