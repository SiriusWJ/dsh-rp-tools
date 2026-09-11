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

function clamp(text, max) {
  const s = String(text ?? '').trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}\n…（已截断，全文见导出的 JSON）` : s;
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

/** 挑一条可用的开场白：优先备用开场白里第一条非广告的，最后才退回 first_mes（且要非广告）。 */
export function pickGreeting(data) {
  const alts = (Array.isArray(data?.alternate_greetings) ? data.alternate_greetings : [])
    .map((g) => String(g ?? '').trim())
    .filter((g) => g && !isAdText(g));
  if (alts.length) return { text: alts[0], source: 'alternate_greetings', alternatives: alts.length };
  const first = String(data?.first_mes ?? '').trim();
  if (first && !isAdText(first)) return { text: first, source: 'first_mes', alternatives: 0 };
  return { text: '', source: 'none', alternatives: alts.length };
}

/**
 * 角色卡 → 本插件的角色字段（`CHARACTER_FIELDS`）。
 *
 * 诚实说明：`speech` / `behavior` / `relations` **卡里没有** ——
 * 别假装映射成功，留空让 DM 读正文后自己提炼（工具描述里已经教它怎么填）。
 */
export function cardToCharacter(data) {
  const greeting = pickGreeting(data);
  const desc = String(data?.description ?? '').trim();
  const personality = String(data?.personality ?? '').trim();
  // description 与 personality 拼接，各自标注来源，方便用户知道哪段来自哪里
  const parts = [];
  if (desc) parts.push(`【设定】\n${desc}`);
  if (personality) parts.push(`【性格】\n${personality}`);
  return {
    name: String(data?.name ?? '').trim() || '（未命名角色）',
    appearance: '',                       // 卡里的 description 常混外貌与设定，交给 DM 提炼后再填
    personality: clamp(parts.join('\n\n'), FIELD_CHARS.personality),
    speech: '',
    behavior: '',
    relations: '',
    first_mes: clamp(greeting.text, FIELD_CHARS.first_mes),
    mes_example: clamp(String(data?.mes_example ?? '').trim(), FIELD_CHARS.mes_example),
    _greetingSource: greeting.source,
    _greetingAlternatives: greeting.alternatives,
  };
}

/**
 * 汇总一次导入：会话配置片段 + 世界书 markdown + 给用户看的摘要。
 * @returns 纯数据（不落盘），由调用方决定写到哪。
 */
export function buildImport(decoded, { maxEntries, maxChars } = {}) {
  const data = decoded?.data ?? {};
  const character = cardToCharacter(data);
  const entries = Array.isArray(data?.character_book?.entries) ? data.character_book.entries : [];
  const wb = worldBookMarkdown(entries, { maxEntries, maxChars });

  const world = [
    String(data?.name ?? '').trim() ? `【角色卡】${data.name}` : '',
    String(data?.scenario ?? '').trim() ? `【情境】\n${String(data.scenario).trim()}` : '',
    String(data?.creator_notes ?? '').trim() ? `【作者注】\n${String(data.creator_notes).trim()}` : '',
  ].filter(Boolean).join('\n\n');

  const adDropped = isAdText(data?.first_mes) ? 1 : 0;
  const summary = [
    `角色卡：${character.name}`,
    `规范：${decoded?.kind ?? '?'}（${decoded?.chunk ?? '?'} 块）`,
    `开场白来源：${character._greetingSource === 'alternate_greetings'
      ? `备用开场白第 1 条（共 ${character._greetingAlternatives} 条可选）`
      : character._greetingSource === 'first_mes' ? 'first_mes（未检出广告）' : '无'}`,
    adDropped ? '已丢弃被广告污染的 first_mes' : '',
    `世界书：保留 ${wb.kept} 条 / 跳过 ${wb.skipped} 条 / 其中 ${wb.enabledOff} 条原卡已禁用`,
    `世界书正文：${wb.totalChars} 字`,
    `情境：${world ? `${world.length} 字` : '无'}`,
  ].filter(Boolean);

  return { character, world, worldBookMarkdown: wb.markdown, summary, stats: wb, decodedKind: decoded?.kind };
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
export function cardToMarkdown(decoded, { maxChars = 400000 } = {}) {
  const data = decoded?.data ?? {};
  const out = [
    `# ${String(data?.name ?? '').trim() || '（未命名卡）'}`,
    '',
    `> 由 dsh-rp-tools 从 PNG 角色卡导入（规范 ${decoded?.kind ?? '?'}，来源块 ${decoded?.chunk ?? '?'}）。`,
    '> 世界书只导入了预算内的条目，**这里是全文**；需要细节时按标题查这一段。',
    '',
  ];
  const section = (title, body) => {
    const text = String(body ?? '').trim();
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
      out.push(`### ${String(e?.name ?? e?.comment ?? '').trim() || `条目 ${i + 1}`}`, '', `<!-- ${flags} -->`, '', String(e?.content ?? '').trim(), '');
    });
  }

  const text = out.join('\n').replace(/\n{4,}/g, '\n\n\n').trim() + '\n';
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, maxChars)}\n\n…（本文档超长已截断）\n`, truncated: true };
}

/**
 * 导入之后替玩家发的那条「开始游戏」指令。
 *
 * 为什么必须显式写「不要再问世界从哪来」：dm 预设的 persona 里，开局第一件事是
 * **问玩家世界从哪来**（原著 / 自带文件 / 原创）。导入卡组的场景下这个问题已经被
 * 回答过了，不问这句的话 DM 会先反问你一遍，导入的设定白导。
 */
export function buildOpeningPrompt(imported, { worldFile, cardFile, imageRel } = {}) {
  const name = String(imported?.character?.name ?? '').trim() || '本卡组';
  const greeting = String(imported?.character?.first_mes ?? '').trim();
  const stats = imported?.stats ?? {};
  const lines = [
    `【开局】已导入卡组《${name}》，世界设定与角色卡都已就位 —— **不要再问世界从哪来，直接开团**。`,
    '',
    `- 世界书：${worldFile || 'rp-worldbook.md'}（本次导入 ${stats.kept ?? 0} 条，合并后按关键词触发；被预算挡下的条目在下面这个全文文件里）`,
    `- 卡组全文：${cardFile || '（未写出）'}${imageRel ? `（卡面图 ${imageRel}）` : ''}`,
    `- 角色卡《${name}》已载入（详细卡片会在提到该角色时展开）`,
    '',
    '请按这个顺序开场：',
    '1. 先用 2-4 段描写开场画面（延续卡组的文风与描写密度）；',
    '2. 交代玩家角色此刻的位置、处境、以及眼前最要紧的事；',
    '3. 给 2-3 个可以立刻行动的选项（用带 action 的按钮卡片），然后停下等玩家回应。',
  ];
  if (greeting) {
    lines.push('', '卡组自带的开场白如下，**只作场景与文风参考，不要照抄、不要在正文里复述**：', '', greeting);
  }
  return lines.join('\n');
}

