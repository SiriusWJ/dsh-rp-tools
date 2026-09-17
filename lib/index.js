/**
 * dsh-rp-tools — 本地 RP 工具固定插件（宿主组合层常驻）。
 *
 * 注册模型工具 rp_random：可配置的随机值生成器（整数/浮点区间、
 * 加权抽取、骰子表达式、布尔翻转，支持 seed 复现）。
 *
 * 扩展方式：向下方 `tools` 数组追加新的工具定义即可（name /
 * description / parameters / output / execute），apply 会统一注册，
 * 插件停止时统一注销。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'dsh-rp-tools';
// 全局半侧不注册任何模型工具、也不碰 systemPrompt —— 它只需要 webServer 注册路由
// （installRoutes 里用 ctx.inject(['webServer']) 延迟注入，所以这里连 webServer 都不用硬声明）。
// 全部 rp_* 工具与提示词注入都在 dm 预设作用域，由 rp-bridge 自己声明 tools / systemPrompt。
export const inject = [];


import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync, renameSync, rmSync, unlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, isAbsolute, resolve, sep } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { buildBundle, parseBundle, restoreBundleEntries } from './session-bundle.js';
import { mapContextForDir, mapFilePaths } from './rp-map.js';
import { decodeCardPng, readPngTextChunks } from './card-png.js';
import { buildImport, cardToMarkdown, cardToOpeningFile, cardToLaunchFile, buildOpeningPrompt, buildTidyPrompt, isDmCardData, dmCardToPrompt, DEFAULT_USER_LABEL, localizeAttributes, listGreetings, discoverMacros, collectCardText, MACRO_NAME_RE, AUTO_MACROS, autoMacroValue, isJunkLoreBody, loreKindOf, loreTitleOf, uniqueTitle } from './card-import.js';
// 卡面缩略图：纯 node:zlib 实现（无第三方依赖），不支持解码就回退原图
import { makeThumbnail } from './png-thumb.js';
// 全局工具放行名单的默认值与归一化：**与 dm 预设过滤器共用同一份**（各自硬编码会走散 —— 
// 默认名单少一项就是「DM 悄悄少一个能力且不报错」）。改名单只改那个文件。
import { GLOBAL_TOOLS_DEFAULT, GLOBAL_TOOLS_ALLOW_MAX, TOOL_NAME_RE, normalizeGlobalToolsAllow } from './global-tools-defaults.js';

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const RP_DATA_DIR = join(DSH_HOME, 'data', 'dsh-rp-tools');
/** 全局配置文件（卡库根目录 + 默认宏列表 + DM 会话放行的全局工具）。文件名沿用 `styles.json` 以免动老用户的盘。 */
const RP_CONFIG_FILE = join(RP_DATA_DIR, 'styles.json');

/** 出厂配置：卡库那点东西 + DM 会话放行的全局工具。 */
function defaultConfig() {
  return {
    // PNG 故事书导入的卡库根目录（空串 = 会话工作区下的 rp-cards/）
    // + **默认宏列表** `{ 宏名: 默认值 }`：会话里没填的键用它（`{{user}}` 那套规则推广到所有键）。
    // 出厂就放一条 `user -> 玩家`：这是每张卡都会用到的那个宏，摆在那里界面才自解释
    // （空列表看不出该怎么填）。`userLabel` 是 1.8.7 之前的老字段，保留并由迁移保持同步。
    cards: { root: '', userLabel: DEFAULT_USER_LABEL, macros: { user: DEFAULT_USER_LABEL }, macrosSeeded: true },
    // DM 会话要放行的**全局**工具（走设置页「第三方工具管理」那张表）。
    // 全部可勾选、默认全勾 —— 没有「固定放行」这一层（见共享模块的注释）。
    globalToolsAllow: [...GLOBAL_TOOLS_DEFAULT],
  };
}

/**
 * 设置页/路由共用：报告当前的放行名单 + 出厂默认。
 *
 * 曾经这里还返回 `base`（用户不可取消的底线三项），现在没有了 —— 底线改成「默认勾选」，
 * 于是「哪些固定、哪些可选」这个区分不存在了，界面也只剩一张统一的表。
 */
function globalToolsAllowView(cfg) {
  return {
    allow: normalizeGlobalToolsAllow(cfg?.globalToolsAllow),
    defaults: [...GLOBAL_TOOLS_DEFAULT],
    max: GLOBAL_TOOLS_ALLOW_MAX,
  };
}

/** 读配置；不存在则写一份默认值。老 `styles.json` 里的生图字段一并保留在盘上，只是不再读。 */
function loadStyles() {
  if (!existsSync(RP_CONFIG_FILE)) {
    mkdirSync(dirname(RP_CONFIG_FILE), { recursive: true });
    writeFileSync(RP_CONFIG_FILE, JSON.stringify(defaultConfig(), null, 2) + '\n', 'utf8');
  }
  const cfg = JSON.parse(readFileSync(RP_CONFIG_FILE, 'utf8'));
  // 老配置迁移：DM 放行的全局工具名单。这里有一次**语义变更**，必须迁移而不是照读：
  //   1.15.0 那份是「**额外**放行」（在预设底线 render_ui/validate_dsh_ui/web_search 之上追加），
  //   1.15.1 起改成「**完整**名单」（没有底线的概念了）。
  // 所以把旧值原样当完整名单读，会**静默丢掉**卡片渲染、围栏自检、联网考据 ——
  // 用户看到的会是「DM 突然不发卡片了」，而且不知道是自己那次升级造成的。
  // 迁移规则：**只加不减** —— 拿出厂默认与旧值取并集。用户额外勾过的插件工具得以保留，
  // 原先靠底线隐含拥有的能力也得以保留。用 `globalToolsAllowMerged` 做个一次性标记：
  //   · 老磁盘（没这个键）→ 并集一次，之后用户说什么就是什么（能取消、能全不勾）
  //   · 新磁盘（有这个键）→ 完全按用户当前勾选，不再动
  //   · 完全没有 globalToolsAllow 键（1.15.0 之前的更老配置）→ 出厂默认全勾
  if (!Object.prototype.hasOwnProperty.call(cfg, 'globalToolsAllow')) {
    cfg.globalToolsAllow = [...GLOBAL_TOOLS_DEFAULT];
    cfg.globalToolsAllowMerged = true;
    saveStyles(cfg);
  } else if (cfg.globalToolsAllowMerged !== true) {
    const saved = normalizeGlobalToolsAllow(cfg.globalToolsAllow);
    cfg.globalToolsAllow = normalizeGlobalToolsAllow([...GLOBAL_TOOLS_DEFAULT, ...saved]);
    cfg.globalToolsAllowMerged = true;
    saveStyles(cfg);
  } else {
    cfg.globalToolsAllow = normalizeGlobalToolsAllow(cfg.globalToolsAllow);
  }
  // 老配置迁移：卡库目录 + 默认宏列表（PNG 故事书导入用）
  if (!cfg.cards || typeof cfg.cards !== 'object') {
    cfg.cards = defaultConfig().cards;
  } else {
    if (typeof cfg.cards.userLabel !== 'string') cfg.cards = { ...cfg.cards, userLabel: '' };
    // 1.8.7：单一「玩家称呼」升级成**默认宏列表**。老配置里只有 user 一个默认值，
    // 迁移成 `{ user: 玩家称呼 }`；两边保持同步，免得外部/老代码读到空值。
    const hadMacros = Boolean(cfg.cards.macros) && typeof cfg.cards.macros === 'object';
    if (!hadMacros) {
      const legacy = String(cfg.cards.userLabel ?? '').trim();
      cfg.cards = { ...cfg.cards, macros: legacy ? { user: legacy } : {} };
    }
    // 1.8.8：出厂/老配置都补一条 `user -> 玩家`，让界面一眼看懂该怎么填。
    // 用 `macrosSeeded` 做成**一次性**迁移：用户删掉这条之后不会又被塞回来
    // （保存时也会把它置为 true —— 你动过这个列表，就按你的来）。
    if (!cfg.cards.macrosSeeded) {
      const macros = { ...(cfg.cards.macros ?? {}) };
      if (!String(macros.user ?? '').trim()) macros.user = DEFAULT_USER_LABEL;
      cfg.cards = { ...cfg.cards, macros, macrosSeeded: true };
    }
    const synced = String(globalMacros(cfg).user ?? '');
    if (String(cfg.cards.userLabel ?? '') !== synced) cfg.cards = { ...cfg.cards, userLabel: synced };
  }
  return cfg;
}

/** 会话闸门（界面据此决定「导入入口要不要出现」）的判定见 sessionGate。 */
/**
 * 卡面缩略图缓存：`绝对路径|mtime|目标宽` → 缩略图 Buffer。
 *
 * 为什么要缓存：解码+降采样一次要几十到几百毫秒（大卡尤其慢），而同一张卡会被
 * 反复请求（切回卡片、刷新页面）。上限几百条足够 —— 缩略图本身只有几 KB。
 */
const thumbCache = new Map();
const THUMB_CACHE_MAX = 300;

/** 取（或生成）某个尺寸的缩略图；不支持 / 出错都返回 null，调用方回退原图。 */
function thumbFor(abs, buffer, maxWidth) {
  let key = '';
  try {
    const st = statSync(abs);
    key = `${abs}|${st.mtimeMs}|${st.size}|${maxWidth}`;
    const hit = thumbCache.get(key);
    if (hit) return hit;
  } catch { /* stat 失败就每次现算 */ }
  let thumb = null;
  try { thumb = makeThumbnail(buffer, maxWidth); } catch { thumb = null; }
  if (!thumb) return null;
  if (key) {
    if (thumbCache.size >= THUMB_CACHE_MAX) thumbCache.clear();   // 简单粗暴：满了整体丢弃
    thumbCache.set(key, thumb);
  }
  return thumb;
}

function saveStyles(cfg) {
  try { writeFileSync(RP_CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8'); } catch { /* 只读时忽略 */ }
}

// ===================================================================
// 会话级配置（按 session 隔离）
// -------------------------------------------------------------------
// 全局：卡库根目录 + 默认宏列表（styles.json）。图片生成已不在本插件里（1.15.0 移除）。
// 会话级：角色卡 / 世界设定 / 提示词前缀 / 战役名 / DM 设定 / 宏表 / 随机表 / 立绘位 / 资源库。
// 会话 id 取自工具执行上下文 exec.agent.id；dm 预设的会话另由预设插件登记。
// ===================================================================

const SESSIONS_DIR = join(RP_DATA_DIR, 'sessions');
const DM_INDEX_FILE = join(RP_DATA_DIR, 'dm-sessions.json');

/**
 * 本插件注入系统提示词的段名。
 * order 210 是刻意的：工具说明占 100–199，稳定骨架放其后，即使骨架有微小抖动，
 * 稳定的工具前缀仍能命中 DeepSeek 的前缀缓存（dsh-liketavern 用同一个位置）。
 */
const STANDING_SECTION = 'rp:standing';

/**
 * 每轮才变的内容（世界书命中 / 状态）的注入段名，走 runtime context。
 * order 20 与 dsh-liketavern 的 turn 层一致：放在 runtime context 组的前部。
 */
const TURN_CONTEXT = 'rp:turn';

// 会话 id 不在这里解析 —— 注入由 dm 预设的 rp-bridge 在 **agent 作用域** 注册，
// 那里的 `ctx.agent.id` 就是本会话，作用域过滤天然保证「只在 DM 会话、且互不串台」。
// （曾经在这里写过一套「猜当前会话」的启发式：全局注册 + 按 session/created 或文件时间挑会话。
//   两个错：① 全局注册让每个会话都带上跑团世界观；② 猜会话会把别的战役设定注进来。
//   正确做法是让作用域回答问题 —— 架构上本来就该这样。）


/**
 * 每个会话的工作区根目录（来自 `session.header.cwd`）。
 * 世界书就放在这个目录下的 `rp-worldbook.md`：用户能用任何编辑器改，DM 也能用 read/write 直接维护。
 */
const sessionCwd = new Map();

/**
 * 宿主上下文（含 `ctx.get('sessions')` 会话注册表），`installRoutes` 注入 webServer 时记下。
 *
 * 存在的理由：`sessionCwd` 是**进程内存**，只有 `session/created`（创建或**恢复**）时才会被写，
 * 而这个进程没加载过的会话（重启后没打开的那些）它一无所知 —— 用户就是这么炸的：
 * 卡库路径依赖「会话的工作区」，而那份记忆不存在 → 根目录为空 → `resolve('')` 拿到进程 cwd。
 * 注册表能让路由按 id 现查活着的会话（`session.header.cwd`），补上这个空档。
 */
let hostSessionLookup = null;

/**
 * 全局工具注册表（`tools` 服务），`installRoutes` 注入时记下。
 *
 * 用途只有一个：设置页要能列出**本机真实存在的全局工具**，让人勾选「哪些放行给 DM 会话」。
 * 为什么不能写死名单：生图插件因机器而异（`dsh-image-gen` 只是其中一种），工具名自然也不同。
 */
let hostToolsLookup = null;

/**
 * 列出本机全部全局工具名（`schemas()` 省略 scope = 全局视图，不套作用域限制）。
 * 拿不到注册表时返回 null（**不是空数组**）—— 界面要能区分「一个工具都没有」与「查不到」。
 */
function listGlobalToolNames() {
  try {
    const schemas = hostToolsLookup?.tools?.schemas?.();
    if (!Array.isArray(schemas)) return null;
    return schemas.map((t) => String(t?.name ?? '')).filter(Boolean).sort();
  } catch { return null; }
}

/**
 * 粗判「这个工具像是图片/生图相关的」——只用来在设置页给它打个「图」标，不参与任何强制逻辑。
 *
 * 刻意**不**包含 `vision` / `caption` 这类词：它们在别的插件里未必指图片
 * （`caption` 可能是字幕、`vision` 可能是别的语义），打错标比不打更误导。
 */
function looksLikeImageTool(name) {
  return /(^|_)(image|img|photo|picture|draw|paint|illustrat)/i.test(String(name ?? ''));
}

/**
 * 设置页给个别工具的一句提醒（**不是锁定** —— 现在没有固定放行，用户想关就能关）。
 * 只写「关掉它会失去什么」，因为这几项关掉以后的现象（DM 不出卡片、不自检围栏）不容易联想到原因。
 */
const TOOL_HINTS = {
  render_ui: 'DM 的卡片全靠它渲染；关掉就只能发纯文字',
  validate_dsh_ui: '围栏自检；关掉后写坏的卡片不会在发送前被拦下',
  web_search: '开局考据（不熟悉的作品先查再写）；不需要联网可以关',
  generate_image: '宿主的生图；关掉后 DM 不能配图',
  edit_image: '宿主的改图；关掉后 DM 不能基于已有图改',
};

/**
 * 会话对象引用：装配时要 `deriveMessages()` 取最近消息做世界书关键词匹配。
 * 会话销毁时清理，避免长期持有一堆已经结束的会话。
 */
const sessionRefs = new Map();

/** 世界书文件缓存：mtime + 解析结果。避免每轮装配都读盘解析（装配是热路径）。 */
const loreCache = new Map();

/**
 * 世界书文件的位置：**按会话隔离**，放在工作区里的 `rp-sessions/<会话 id>/rp-worldbook.md`。
 *
 * ⚠️ 这里踩过一个真事故：世界书原先直接放在**工作区根目录**的 `rp-worldbook.md`，
 * 而工作区是按目录共享的 —— 同一个工作区开两个会话，它们读到的是**同一个文件**，
 * 于是 A 会话导入的卡组条目出现在了 B 会话的上下文里（用户报的「两个会话的世界书混到一起」）。
 * 「世界书属于会话」是本插件的核心承诺（会话隔离），所以它必须跟着会话 id 走。
 *
 * 放在工作区内（而不是插件数据目录）是为了让 DM 能用 `read`/`write` 直接维护它，
 * 也让用户能在资源管理器里直接打开。
 */
const LORE_SESSION_DIR = 'rp-sessions';
function sessionLorePath(sessionId, hint) {
  const id = normalizeSessionId(sessionId);
  // 工作区优先取宿主记录的（session/created 里的 header.cwd）；本进程没记过就问会话引用，
  // 再没有才用调用方给的绝对路径。
  // 装配热路径只走**内存**这两级（不做磁盘 IO）：世界书文件本身还要按这个目录去读。
  let cwd = sessionCwd.get(id) || liveSessionCwd(id);
  if (!cwd) {
    const raw = String(hint ?? '').trim();
    if (raw && isAbsolute(raw) && existsSync(raw)) {
      cwd = resolve(raw);
      rememberSessionCwd(id, cwd);      // 顺手补登记，让装配热路径也找得到同一个文件
    }
  }
  if (!cwd) return null;
  return { id, cwd, dir: join(cwd, LORE_SESSION_DIR, id), file: join(cwd, LORE_SESSION_DIR, id, LORE_FILE_NAME), legacy: join(cwd, LORE_FILE_NAME) };
}

/**
 * 本会话的世界书路径（**不做任何复制**）。
 *
 * ⚠️ 这里曾经是「旧文件存在就自动复制一份给本会话」—— 那等于**每个新会话都继承那份被污染的文件**
 * （工作区根目录的 `rp-worldbook.md` 是历史遗留的共享文件，混着所有会话的条目），
 * 于是「新会话也带着别的会话的词条」再次发生。教训：**自动迁移绝不能进新会话**。
 * 现在旧文件完全不参与读取，只在面板里提示它存在；要不要并进来由用户显式点一下
 * （`POST /rp-tools/lore { action: 'importLegacy' }`）。
 */
function ensureSessionLore(sessionId, hint) {
  const p = sessionLorePath(sessionId, hint);
  if (!p) return null;
  const hasOwn = existsSync(p.file);
  return {
    ...p,
    migrated: false,
    legacyExists: !hasOwn && existsSync(p.legacy),
  };
}
/** 读并解析某个会话的世界书文件（没有文件返回空数组；mtime 未变则用缓存）。 */
function loadLoreEntries(sessionId) {
  const id = normalizeSessionId(sessionId);
  const p = ensureSessionLore(id);
  if (!p) return [];
  const file = p.file;
  try {
    if (!existsSync(file)) { loreCache.delete(id); return []; }
    const mtime = statSync(file).mtimeMs;
    const cached = loreCache.get(id);
    if (cached && cached.mtime === mtime && cached.file === file) return cached.entries;
    const entries = parseLoreMarkdown(readFileSync(file, 'utf8'));
    loreCache.set(id, { mtime, file, entries });
    return entries;
  } catch { return []; }
}

/** 宏表归一化：名字必须合法（宿主变量名规则），值转字符串；非法项直接丢掉。 */
function normalizeMacros(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw)) {
    const name = String(k ?? '').trim().toLowerCase();
    if (!MACRO_NAME_RE.test(name)) continue;
    out[name] = String(v ?? '').slice(0, 2000);
  }
  return out;
}

/**
 * 会话 id 归一化。
 * 两侧形式不同：工具侧 `exec.agent.id` 形如 `session-<uuid>`，
 * 而会话目录 / 客户端的 `useSessions().current` 可能是裸 `<uuid>`。
 * 统一剥掉 `session-` 前缀，避免「工具登记了、界面查不到」。
 */
function normalizeSessionId(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return 'default';
  return raw.replace(/^session-/, '') || 'default';
}

/** 会话 id → 安全文件名。 */
function sessionFile(sessionId) {
  return join(SESSIONS_DIR, `${normalizeSessionId(sessionId).replace(/[^\w.-]/g, '_')}.json`);
}

/** 读会话配置（不存在则返回空配置，不落盘）。 */
function loadSession(sessionId) {
  const id = normalizeSessionId(sessionId);
  let data = {};
  const candidates = [sessionFile(id), join(SESSIONS_DIR, `session-${id}.json`)];   // 兼容旧的前缀文件名
  for (const file of candidates) {
    try {
      if (existsSync(file)) { data = JSON.parse(readFileSync(file, 'utf8')); break; }
    } catch { data = {}; }
  }
  /**
   * 迁移：老数据可能把 **DM（旁白）卡**当成角色存下来了（用户实测那条 `lust Adventure`：
   * 性格/行为里全是「它会怎么叙述」，根本不是一个角色）。
   * 判出来就搬到 `dm.prompt` 并从角色表里拿掉 —— **只在内存里做**，
   * 等下一次保存（面板保存 / 工具写入）才落盘，不在这里偷偷改用户的文件。
   */
  const rawChars = Array.isArray(data.characters) ? data.characters : [];
  const dmCardChars = rawChars.filter((c) => c && isDmCardData(c));
  return {
    sessionId: id,
    preset: typeof data.preset === 'string' ? data.preset : '',
    campaign: {
      name: '',
      prompt_prefix: '',
      ...(data.campaign && typeof data.campaign === 'object' ? data.campaign : {}),
    },
    characters: rawChars
      .filter((c) => c && !isDmCardData(c))                               // DM 卡不当角色（见上）
      .filter((c) => CHARACTER_FIELDS.some((f) => String(c[f] ?? '').trim()))
      .map(normalizeCharacter),
    // 角色索引：常驻注入的紧凑名单（brief / always）。缺省时由角色表现推，所以老数据无需迁移。
    characterIndex: Array.isArray(data.characterIndex)
      ? data.characterIndex.map((e) => normalizeIndexEntry(e)).filter((e) => e.name)
      : [],
    tables: Array.isArray(data.tables)
      ? data.tables.filter((t) => t && t.name && Array.isArray(t.entries)).map((t) => ({
        name: String(t.name),
        dice: String(t.dice ?? `1d${t.entries.length || 1}`),
        entries: t.entries.map((e) => String(e)),
      }))
      : [],
    world: typeof data.world === 'string' ? data.world : '',
    // 立绘：生成出来的那一份存在会话配置里（`{ 角色名: { generated: {...} } }`）；
    // 界面在「没生成过立绘」时不再拿卡面顶替 —— 卡面现在是**封面**（见下）。
    portraits: data.portraits && typeof data.portraits === 'object' ? data.portraits : {},
    // **封面**：导入的那张卡的文件名（面板摆在「世界设定」旁边）。
    // 迁移：1.10.2 之前卡面是登记在 `portraits[卡名].card` 上的（而那个「卡名」往往
    // 根本不是角色）。这里把「键不在角色表里」的那条认成封面，用户不必重导。
    cover: (() => {
      if (data.cover && typeof data.cover === 'object' && data.cover.card) {
        return { card: String(data.cover.card), file: String(data.cover.file ?? ''), name: String(data.cover.name ?? '') };
      }
      const names = new Set((Array.isArray(data.characters) ? data.characters : []).map((c) => String(c?.name ?? '')));
      for (const [key, entry] of Object.entries(data.portraits ?? {})) {
        if (names.has(key)) continue;                       // 是某个角色的卡面 → 不算封面
        if (entry && typeof entry === 'object' && entry.card) {
          return { card: String(entry.card), file: String(entry.file ?? ''), name: key };
        }
      }
      return null;
    })(),
    // 状态追踪：只有叙述文本承载的变化（伤势/物品/关系/伏笔）会在上下文压缩后消失，这里兜住。
    state: normalizeState(data.state),
    // ── DM 设定（本会话的 DM 自己的规则）─────────────────────
    // 为什么要它：DM（旁白）卡不是角色卡 —— 它的内容是「这个 DM 怎么带团」，
    // 早先会被导成一条名叫 DM 的角色（用户实测：第一条角色卡里全是 DM 预设）。
    // 这里既收卡导入的正文，也收用户手写的（会话隔离）。
    dm: (() => {
      const raw = data.dm && typeof data.dm === 'object' ? data.dm : {};
      // 面板里那份是权威；它空着时用**从老数据的角色表里迁移出来的 DM 卡正文**兜底
      const prompt = typeof raw.prompt === 'string' && raw.prompt.trim()
        ? raw.prompt
        : (dmCardChars.length ? dmCardToPrompt(dmCardChars[0]) : '');
      return {
        prompt,
        // 迁移痕迹：界面据此提示「这条其实是 DM 卡，已从角色表挪到这里」
        migrated: prompt !== '' && !(typeof raw.prompt === 'string' && raw.prompt.trim())
          ? dmCardChars.map((c) => String(c?.name ?? '')).filter(Boolean)
          : [],
      };
    })(),
    // 宏表（**按会话隔离**）：`{ user: '阿岚', place: '广寒宫' }`。
    // 名字必须是宿主变量允许的 `[a-z][a-z0-9_]*`；值就是 `{{名字}}` 插值出来的文本。
    macros: normalizeMacros(data.macros),
    // 会话工作区：插件在**第一次知道**它的地方落盘（见 rememberSessionCwd），
    // 这样重启后仍然能定位世界书与卡库 —— 不用等宿主再发一次 session/created。
    cwd: typeof data.cwd === 'string' && isAbsolute(data.cwd) ? data.cwd : null,
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : null,
  };
}

function saveSession(session) {
  try {
    mkdirSync(SESSIONS_DIR, { recursive: true });
    const id = normalizeSessionId(session.sessionId);
    writeFileSync(sessionFile(id), JSON.stringify({ ...session, sessionId: id, updatedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8');
    return true;
  } catch { return false; }
}

/** 从工具执行上下文取会话 id（归一化后）。 */
function sessionIdOf(exec) {
  return normalizeSessionId(exec?.agent?.id);
}

/**
 * 角色卡的字段集。
 *
 * 设计取向来自 hermes-roleplay-engine：**给样本 > 给形容词**。
 * 它把 `first_mes`（开场白原文）标为最重要的字段 —— 「决定文风、描写密度、叙事节奏」，
 * 并强调「用『给样本』代替『给形容词』」。所以这里既有描述性字段，也有两个样本字段。
 *
 * 刻意不做的事：
 * - 不兼容 SillyTavern / CCv1-v3 规范，也不做 PNG 导入 —— 本插件的定位是轻量跑团工具，
 *   自建一份够用的字段即可（导入整套生态是另一个量级的产品）。
 * - 不做数值化的关系/好感度：容易变成「模型自己报数」的假追踪。
 *   将来做状态追踪时再统一设计；现在 `relations` 只是文字描述。
 */
const CHARACTER_FIELDS = ['name', 'appearance', 'personality', 'speech', 'behavior', 'first_mes', 'mes_example', 'relations'];

/** `first_mes` 注入上限：当文风样本够用即可，不必整段塞进系统提示词。 */
const FIRST_MES_BUDGET = 300;

/**
 * 「角色索引」：常驻注入的紧凑名单。
 *
 * 为什么要有它：角色卡的详细字段是给模型的**样本**，但人一多，全部常驻会把系统提示词撑爆
 * （常驻段膨胀还会拖累前缀缓存）。所以常驻的只放「谁在场」这一层，详细卡片按轮注入 ——
 * 与 liketavern 的 standing / turn 分层同一个道理。
 *
 * - `brief` 缺省时回退到 `appearance` 的首句（老数据不用改也能用，不需要迁移）；
 * - `always` 表示该角色的完整卡片每轮都注入（主角这种要一直"在场"的）。
 */
const INDEX_BRIEF_CHARS = 40;

/** 规范化一个角色索引条目。`fallbackAppearance` 供老数据兜底。 */
function normalizeIndexEntry(entry, fallbackAppearance) {
  const name = String(entry?.name ?? '').trim();
  const brief = String(entry?.brief ?? '').trim()
    || String(fallbackAppearance ?? '').split(/[。；;\n]/)[0].slice(0, INDEX_BRIEF_CHARS);
  return { name, brief, always: entry?.always === true };
}

/** 渲染常驻的角色索引（只名字 + 一句简介）。老数据没有 index 时用角色表现推，无需迁移。 */
function renderCharacterIndex(session) {
  const chars = Array.isArray(session?.characters) ? session.characters.filter((c) => c?.name) : [];
  const idx = Array.isArray(session?.characterIndex) ? session.characterIndex : [];
  const byName = new Map();
  for (const e of idx) {
    const n = normalizeIndexEntry(e);
    if (n.name) byName.set(n.name, n);
  }
  const rows = chars.map((c) => byName.get(String(c.name)) ?? normalizeIndexEntry({ name: c.name }, c.appearance));
  if (!rows.length) return '';
  return '【角色索引】' + rows
    .map((r) => `${r.name}${r.brief ? `（${r.brief}）` : ''}${r.always ? '[常驻展开]' : ''}`)
    .join('、');
}

/** 哪些角色的详细卡片要在**本轮**展开：名字出现在最近对话里，或被标了 always。 */
function charactersToExpand(session, corpus) {
  const chars = Array.isArray(session?.characters) ? session.characters.filter((c) => c?.name) : [];
  const idx = Array.isArray(session?.characterIndex) ? session.characterIndex : [];
  const alwaysByName = new Map(idx.map((e) => [String(e?.name ?? '').trim(), e?.always === true]));
  const text = String(corpus ?? '');
  return chars.filter((c) => {
    const name = String(c.name);
    return alwaysByName.get(name) === true || text.includes(name);
  });
}

/** 把任意来源的角色对象归一化成规范结构（缺的字段一律空串，界面与注入都不用再判 undefined）。 */
function normalizeCharacter(c) {
  const out = {};
  for (const f of CHARACTER_FIELDS) out[f] = String(c?.[f] ?? '').trim();
  return out;
}

/**
 * 把一个角色渲染成给模型看的一段。
 * 只输出**有内容**的字段，避免一堆「（未填）」污染提示词。
 */
function renderCharacter(c) {
  const ch = normalizeCharacter(c);
  const lines = [`### ${ch.name || '（未具名角色）'}`];
  if (ch.appearance) lines.push(`- 外貌：${ch.appearance}`);
  if (ch.personality) lines.push(`- 性格：${ch.personality}`);
  if (ch.speech) lines.push(`- 说话方式：${ch.speech}`);
  if (ch.behavior) lines.push(`- 行为习惯：${ch.behavior}`);
  if (ch.relations) lines.push(`- 人物关系：${ch.relations}`);
  // 样本字段单独标注用途 —— 不说明的话模型会把它当普通设定读过去
  if (ch.first_mes) {
    const sample = ch.first_mes.length > FIRST_MES_BUDGET ? `${ch.first_mes.slice(0, FIRST_MES_BUDGET)}…` : ch.first_mes;
    lines.push(`- 文风范本（初次登场时的写法，后续对白与描写请延续这个语感，不要照抄内容）：\n  ${sample}`);
  }
  if (ch.mes_example) lines.push(`- 对话范例：\n  ${ch.mes_example}`);
  return lines.join('\n');
}

// ===================================================================
// 世界书（lorebook）
// -------------------------------------------------------------------
// 两台参考实现都证明：把「设定的体量」与「每轮实际注入量」解耦，是长会话唯一可扩展的读法。
// 我们的做法比它们简单：条目存在**工作区的 markdown 文件**里（用户能用任何编辑器改，
// DM 也能用 read/write 直接维护），只有命中的条目才进上下文。
//
// 刻意不做的（都是它们花了大代价、而我们不需要的）：
// - 不做 inclusion group / groupWeight 随机竞争；
// - 不做 sticky / cooldown / delay 定时器（要跨轮存状态，与轻量定位不符）；
// - 不做多来源分层（chat/persona/character/global）—— 我们只有「会话」一层。
// ===================================================================

/** 默认的世界书文件名（放在会话工作区根目录）。 */
const LORE_FILE_NAME = 'rp-worldbook.md';

/** 每轮最多注入多少条触发条目（常驻条目不计入）。 */
const LORE_MAX_ENTRIES = 12;

/**
 * 触发条目每轮的字符预算。
 * 参照 dsh-liketavern 的结论：runtime context 每轮都是**未缓存前缀**，搭上去的内容每轮全价重付。
 * 超预算的条目按「常驻优先 → order 降序 → 先命中优先」取，被丢掉的在快照尾部列出标题供按需补读。
 */
const LORE_BUDGET_CHARS = 6000;

/** 扫描多少条最近消息（含 user 与 assistant）。 */
const LORE_SCAN_DEPTH = 2;

/**
 * 确定性掷点：用「会话 id + 轮次 + 条目名」做种子。
 *
 * 为什么不用 rp_random：注入发生在 `system-prompt:assemble` 这个热路径里，不便调用另一个工具的
 * execute。但它**复用 rp_random 同一套 PRNG**（`hashSeed` + `mulberry32`，见文件后部），
 * 所以「同样的输入 → 同样的结果」这条性质与骰子工具完全一致，可精确回放。
 * 这也正是两个参考项目做不到的：它们的触发要么固定、要么用不可复现的随机。
 */
/** 用「会话:轮次:条目」算一个 [0,1) 的确定性值。 */
function seededRoll(sessionId, turn, key) {
  return mulberry32(hashSeed(`${sessionId}:${turn}:${key}`))();
}

/**
 * 解析世界书 markdown。
 *
 * 格式（尽力而为，不报错 —— 世界书是用户手写的，宽容比严格重要）：
 *
 *   ## 条目名
 *   <!-- keys: 广寒宫, 祝婉宁 | constant | order: 80 -->
 *   条目正文……
 *
 * - **恰好 `##` 开一个新条目**（`###` 及更深的是**条目正文里的子标题**，不是新条目；
 *   单个 `#` 是文档标题，不参与解析）—— 这条规则必须与 `splitLoreFile()` / `renderLoreEntryBlock()`
 *   用的 `^##\s` 完全一致，否则「面板显示 N 条、运行时解析出 M 条」；
 * - `<!-- keys: ... -->` 可指定触发词（逗号、顿号或竖线分隔）、`constant`（常驻）、
 *   `order: N`（越大越优先）、`prob: 0-100`（触发概率）、`source: card`（来源是导入的卡）；
 * - **没写 keys 时用标题当触发词**：按常见分隔符切开、去掉括号注释，最省事；
 * - 标题下的正文就是条目内容；只有标题没有正文的**不算条目**。
 */
function parseLoreMarkdown(text) {
  const entries = [];
  let cur = null;
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine;
    // 只认**恰好两个 `#` + 空白**：`###` 属于上一条的正文（历史 bug：`#{2,6}` 让子标题变成条目，
    // 26 个顶级条目被解析成 35 个，世界书体积与面板条数一起虚高）。
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      if (cur) entries.push(cur);
      const title = heading[1].trim();
      cur = {
        title,
        keys: [],
        constant: false,
        order: 0,
        body: [],
        // 没写 keys 就用标题兜底
        autoKeys: true,
      };
      continue;
    }
    if (!cur) continue; // 第一个 `##` 之前的内容忽略（可当文件说明/注释区）
    // `##` 之前可能还有更高级别的标题（如 `# 目录`），它们属于文档结构而非条目内容
    if (/^#\s+/.test(line)) continue;
    const meta = /^\s*<!--\s*(.+?)\s*-->\s*$/.exec(line);
    if (meta) {
      const spec = meta[1];
      const keysPart = /keys?\s*[:：]\s*([^|]+)/i.exec(spec);
      if (keysPart) {
        cur.keys = keysPart[1].split(/[,，、|]/).map((s) => s.trim()).filter(Boolean);
        cur.autoKeys = false;
      }
      if (/\bconstant\b/i.test(spec)) cur.constant = true;
      const orderPart = /order\s*[:：]\s*(-?\d+)/i.exec(spec);
      if (orderPart) cur.order = Number(orderPart[1]);
      const probPart = /prob(?:ability)?\s*[:：]\s*(\d+)/i.exec(spec);
      if (probPart) cur.probability = Math.max(0, Math.min(100, Number(probPart[1])));
      // 来源标记：`source: card` = 这条是从 PNG 卡导入的（不是玩家手写的）。
      // 用途见 planLoreInjection()：外部导入的世界书不因 `constant` 自动获得 system 权限。
      const sourcePart = /source\s*[:：]\s*([a-z]+)/i.exec(spec);
      if (sourcePart) cur.source = sourcePart[1].toLowerCase();
      continue;
    }
    cur.body.push(line);
  }
  if (cur) entries.push(cur);

  return entries
    .map((e) => {
      const body = e.body.join('\n').trim();
      let keys;
      if (e.autoKeys) {
        const cleaned = e.title.replace(/[（(].*?[）)]/g, '').trim();
        // 中文标题里没有空格，按空白切没意义；英文/混排才按空白拆。
        // 判据：拆出来的每一段都得够长，否则保留整个标题（避免 "Yuhu Shan Zhuang" 碎成 3 个词）。
        const bySpace = cleaned.split(/\s+/).filter(Boolean);
        keys = (bySpace.length > 1 && bySpace.every((w) => w.length >= 4))
          ? bySpace
          : cleaned.split(/[,，、·]+/).map((s) => s.trim()).filter(Boolean);
      } else {
        keys = e.keys;
      }
      return {
        title: e.title,
        keys: keys.filter(Boolean),
        constant: e.constant,
        order: e.order,
        probability: typeof e.probability === 'number' ? e.probability : 100,
        // 来源（'card' = 从 PNG 卡导入；缺席 = 玩家手写/未知）。**只记录，不改写语义。**
        source: e.source ?? '',
        body,
        // 空壳（正文只有 markdown 脚手架/占位词）：**不注入上下文**，但仍在文件里，
        // 面板会单独列出来让用户自己删（用户要求：「无内容的不要」）
        empty: isJunkLoreBody(body),
        // 类别标签：面板上显示 设定/规则/状态/历史，让人一眼看出「这条是不是历史快照」
        kind: loreKindOf({ title: e.title, body }),
      };
    })
    .filter((e) => e.body); // 只有标题没有内容的不算条目
}

/** 从最近消息拼出用于关键词匹配的语料。 */
function buildLoreCorpus(messages, depth = LORE_SCAN_DEPTH) {
  const list = Array.isArray(messages) ? messages : [];
  return list
    .slice(-Math.max(1, depth))
    .map((m) => {
      if (typeof m === 'string') return m;
      // deriveMessages() 的形状：{ role, content: ContentBlock[] }
      const blocks = Array.isArray(m?.content) ? m.content : [];
      return blocks.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n');
    })
    .join('\n');
}

/**
 * 激活世界书条目。
 *
 * 语义（刻意比参考实现简单，只保留真正有用的部分）：
 * - `constant` 条目无视关键词常驻；
 * - 其余条目：任一触发词出现在语料里即命中（**子串匹配**，中文场景下不做整词匹配）；
 * - `probability < 100` 的条目用确定性掷点决定是否注入；
 * - **正文是空壳的条目一律不注入**（老导入留下的「1. / markdown」这类模板残留），
 *   但仍留在文件里，面板单独列出来让用户删；
 * - `skipTitles` 里的**条目名**（= 本轮要展开的人物名）**跳过**：该人物的正文已经由角色卡展开，
 *   世界书里那份是同一批内容（§3.3 的装配层去重）。**只看条目名**，不看触发词
 *   （用户口径：键不用管）。跳过原因回给调用方做诊断；
 * - 预算按「常驻优先 → order 降序 → 先命中优先」取，超出部分记入 dropped 供模型按需补读。
 *
 * @returns {{ active: object[], dropped: object[], skipped: object[], matchedByScan: number, emptySkipped: number }}
 */
function activateLore(entries, corpus, { sessionId, turn, maxEntries = LORE_MAX_ENTRIES, budgetChars = LORE_BUDGET_CHARS, skipTitles } = {}) {
  const text = String(corpus ?? '');
  const skip = skipTitles instanceof Set ? skipTitles : new Set();
  const constants = [];
  const matched = [];
  const skipped = [];
  let emptySkipped = 0;

  for (const e of Array.isArray(entries) ? entries : []) {
    if (e.empty === true) { emptySkipped++; continue; }
    // 与「本轮已展开的人物」重名 → 跳过重复正文，原因记进诊断（§3.3）
    // **只比条目名**（用户口径：键不用管）—— 触发词里出现人物名不算重名。
    const title = String(e.title ?? '').trim();
    if (title && skip.has(title)) {
      skipped.push({ title: e.title, reason: 'character-duplicate', character: title });
      continue;
    }
    if (e.constant) { constants.push(e); continue; }
    const hit = (e.keys ?? []).some((k) => k && text.includes(k));
    if (!hit) continue;
    // 概率：确定性掷点，可精确回放
    if (typeof e.probability === 'number' && e.probability < 100) {
      if (seededRoll(sessionId ?? '', turn ?? 0, e.title) * 100 >= e.probability) continue;
    }
    matched.push(e);
  }

  // 常驻优先、再按 order 降序（order 大的更"重要"）、最后保持命中顺序
  const ordered = [
    ...constants,
    ...matched.sort((a, b) => (b.order ?? 0) - (a.order ?? 0)),
  ];

  const active = [];
  const dropped = [];
  let used = 0;
  for (const e of ordered) {
    const cost = e.title.length + e.body.length + 8;
    const isConstant = Boolean(e.constant);
    // 常驻条目不受条目数限制；预算对两者都生效
    if (!isConstant && active.length >= maxEntries) { dropped.push(e); continue; }
    if (used + cost > budgetChars && active.length > 0) { dropped.push(e); continue; }
    active.push(e);
    used += cost;
  }
  return { active, dropped, skipped, matchedByScan: matched.length, emptySkipped };
}

/**
 * 每轮注入的内容（runtime context 通道）：世界书命中 + 需要展开的角色卡。
 *
 * 与 standing 分开的理由见 TURN_CONTEXT 的说明 —— 常驻段的字节必须逐字节稳定，
 * 这里的内容每轮都会变，混进去会打穿 DeepSeek 的前缀缓存。
 */
function buildTurnContext(session, corpus, { sessionId, turn, diagnostics, loreFile } = {}) {
  const parts = [];

  // ① 当前状态放最前：它是最权威、最该被优先遵守的（模型对靠前的内容更稳）
  const state = renderState(session?.state, turn);
  if (state) parts.push(state);

  // ①b 地图摘要：紧跟状态 —— 它**就是状态**（队伍在哪、能去哪），不是设定。
  //     放这里而不是 standing，是因为它随移动/揭示变化；放进系统提示会让整段前缀每次失效。
  if (loreFile) {
    const mapText = mapContextForDir(dirname(String(loreFile)));
    if (mapText) parts.push(mapText);
  }

  // 谁要展开（下一步世界书的去重要用到，所以先算）
  const expand = charactersToExpand(session, corpus);

  // ② 世界书：被本轮对话触发的条目
  //    - 真正常驻（手写、且在预算内）的**不在这里** —— 它们整段进 standing（见 renderConstantLore）；
  //    - 导入来的常驻与超预算的常驻被 planLoreInjection **降级**到这里，按触发词命中；
  //    - 若某条目命中的正是**本轮要展开的人物**，则跳过它的正文（§3.3 去重）——
  //      否则同一个人在 standing/快照里出现两份（实测 15 个人物叠加 5.2 万字）。
  const entries = sessionId ? loadLoreEntries(sessionId) : [];
  const plan = planLoreInjection(entries);
  if (plan.runtime.length) {
    const { active, dropped, skipped } = activateLore(plan.runtime, corpus, {
      sessionId,
      turn,
      skipTitles: new Set(expand.map((c) => String(c.name))),
    });
    if (diagnostics && typeof diagnostics === 'object') {
      diagnostics.demoted = plan.demoted;
      diagnostics.skipped = skipped;
      diagnostics.standingChars = plan.standingChars;
    }
    const lore = renderLore(active, dropped);
    if (lore) parts.push(lore);
  }

  // ③ 角色卡：名字出现在最近对话里（或被标了 always）的，展开详细卡片
  if (expand.length) {
    parts.push('## 本轮在场角色（详细设定）\n' + expand.map(renderCharacter).join('\n\n'));
  }

  return parts.join('\n\n');
}

/** 把激活结果渲染成注入文本（带来源标签 —— 裸文本拼接会让模型把设定当普通叙述滑过）。 */
function renderLore(active, dropped) {
  if (!active.length && !dropped.length) return '';
  const parts = ['## 世界书（据本轮对话自动调取）'];
  for (const e of active) {
    const tag = e.constant ? '常驻' : '本轮命中';
    parts.push(`【世界书·${tag}】${e.title}\n${e.body}`);
  }
  if (dropped.length) {
    // 被预算裁掉的**不静默丢弃**：列出标题，模型可主动问或由 DM 补读
    parts.push(`（以下条目本轮因预算未展开，需要时请让 DM 调 rp_lore 读取：${dropped.map((e) => e.title).join('、')}）`);
  }
  return parts.join('\n\n');
}

/**
 * 把一个条目渲染回 markdown 块。
 *
 * 必须与 `parseLoreMarkdown` 严格互逆：`keys:` 要写在第一个 `|` 之前（解析器的
 * `[^|]+` 只吃到竖线为止），`constant` 用单词判定，`order`/`prob` 是 `order: N` 形式。
 */
function renderLoreEntryBlock(entry) {
  // keys 允许传数组或字符串（面板里是一个「逗号分隔」的输入框，接口也接受手写调用）
  const rawKeys = Array.isArray(entry?.keys) ? entry.keys : String(entry?.keys ?? '').split(/[,，、|]/);
  const keys = rawKeys.map((k) => String(k ?? '').trim()).filter(Boolean);
  const flags = [];
  if (keys.length) flags.push(`keys: ${keys.join('、')}`);
  if (entry?.constant === true) flags.push('constant');
  const order = Number(entry?.order);
  if (Number.isFinite(order) && order !== 0) flags.push(`order: ${Math.trunc(order)}`);
  const prob = Number(entry?.probability);
  if (Number.isFinite(prob) && prob < 100) flags.push(`prob: ${Math.max(0, Math.min(100, Math.trunc(prob)))}`);
  // 来源标记必须原样保留：编辑一条导入来的条目时若把它丢掉，这条就「变回手写」，
  // 下一轮就会绕过 system 权限的门槛被塞回常驻段（planLoreInjection 的依据就是它）。
  if (String(entry?.source ?? '').toLowerCase() === 'card') flags.push('source: card');
  const body = String(entry?.body ?? '').trim();
  return `## ${String(entry?.title ?? '').trim()}\n${flags.length ? `<!-- ${flags.join(' | ')} -->\n` : ''}${body}\n`;
}

/**
 * 把世界书文件切成「文件头 + 每个条目一块原始文本」。
 * 保留原始块的意义：编辑某一条时**只重写那一条**，其它条目（以及用户手写的注释、
 * 空行、奇怪的写法）原样不动 —— 与导入时的 mergeWorldBook 同一个原则。
 */
function splitLoreFile(text) {
  const parts = String(text ?? '').split(/^(?=##\s)/m);
  const header = /^##\s/.test(parts[0] ?? '') ? '' : (parts.shift() ?? '');
  return { header, blocks: parts.filter((b) => b.trim()) };
}

/** 从原始块里取标题（与 parser 同一条规则）。 */
function blockTitle(block) {
  return /^##\s+(.+?)\s*$/m.exec(String(block ?? ''))?.[1]?.trim() ?? '';
}

/**
 * 这是不是**占位标题**（老导入器给没名字的条目编的「条目 4」「条目 7（2）」）。
 *
 * 只有这类标题才允许被「重命名无名条目」改掉 —— 用户自己起的名字（哪怕就叫「条目 」开头
 * 但是手打的）一律不动。
 */
function isPlaceholderLoreTitle(title) {
  return /^条目\s*\d+(（\d+）)?$/.test(String(title ?? '').trim());
}

/** 原子写文件：先写临时文件再 rename，避免写一半把世界书弄坏。 */
function writeFileAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
}

/**
 * 在内存里执行一次世界书编辑，返回新的文件全文。
 *
 * @returns {{ ok: boolean, error?: string, text?: string, action: string, title?: string }}
 */
function applyLoreEdit(current, action, payload) {
  const { header, blocks } = splitLoreFile(current);
  const wantTitle = String(payload?.title ?? '').trim();
  const entry = payload?.entry ?? {};
  const newTitle = String(entry.title ?? '').trim();

  if (action === 'add') {
    if (!newTitle) return { ok: false, error: '条目要有标题', action };
    if (blocks.some((b) => blockTitle(b) === newTitle)) return { ok: false, error: `已有同名条目：${newTitle}`, action };
    const text = `${[header, ...blocks].join('').replace(/\s*$/, '')}\n\n${renderLoreEntryBlock({ ...entry, title: newTitle })}`;
    return { ok: true, text, action, title: newTitle };
  }

  // 「并入旧版共享世界书」：老版本的世界书在工作区根目录，按工作区共享（谁都能往里写）。
  // 它属于哪个会话已经无法判断，所以**不自动迁移**，只允许用户显式把它并到当前会话里来。
  // 与 localize 同理：没有目标标题，必须放在按标题查找之前。
  if (action === 'importLegacy') {
    const legacyFile = String(payload?.legacyFile ?? '').trim();
    if (!legacyFile || !existsSync(legacyFile)) return { ok: false, error: '找不到旧版共享世界书', action };
    const incoming = parseLoreMarkdown(readFileSync(legacyFile, 'utf8'));
    const existingTitles = new Set(blocks.map(blockTitle).filter(Boolean));
    const fresh = incoming.filter((e) => e.title && !existingTitles.has(e.title));
    if (!fresh.length) {
      return { ok: true, text: current, action, title: '', changed: 0, lines: 0, imported: 0 };
    }
    const text = `${current.replace(/\s*$/, '')}\n\n${fresh.map((e) => renderLoreEntryBlock(e)).join('\n')}`;
    return { ok: true, text, action, title: '', changed: fresh.length, lines: 0, imported: fresh.length };
  }

  // 「属性中文化」：把整本书里 YAML 风格的英文属性键换成中文。
  // ⚠️ 必须放在**按标题查找之前** —— 它没有目标标题，先查标题会直接被 `at < 0` 挡掉
  // （测试就是这么抓出来的：action 返回 undefined、文件一字未改）。
  if (action === 'localize') {
    let changed = 0;
    let lines = 0;
    const next = blocks.map((block) => {
      const parsed = parseLoreMarkdown(block)[0];
      if (!parsed) return block;
      const fixed = localizeAttributes(parsed.body);
      if (!fixed.count) return block;
      changed++;
      lines += fixed.count;
      return renderLoreEntryBlock({ ...parsed, body: fixed.text });
    });
    if (!changed) return { ok: true, text: current, action, title: '', changed: 0, lines: 0 };
    return { ok: true, text: `${header}${next.join('')}`, action, title: '', changed, lines };
  }

  // 「给无名条目起个有意义的名字」：老导入器把卡里没有 name 的条目一律写成「条目 4」「条目 5」，
  // 面板上十几行等于没名字。这里**只动**这类占位标题，按触发词/正文标题/首行重新命名；
  // 名字仍拿不出来的（正文也没有可用信息）保持原样 —— §9：不替用户猜。
  // ⚠️ 与 localize 同理：它没有目标标题，**必须放在按标题查找之前**（否则被 `at < 0` 挡掉）。
  if (action === 'renameUnnamed') {
    const used = new Map();
    for (const block of blocks) {
      const t = blockTitle(block);
      if (t && !isPlaceholderLoreTitle(t)) used.set(t, 1);
    }
    const renamed = [];
    let changed = 0;
    const out = blocks.map((block, i) => {
      const parsed = parseLoreMarkdown(block)[0];
      const title = blockTitle(block);
      if (!parsed || !isPlaceholderLoreTitle(title)) return block;
      const derived = loreTitleOf({ keys: parsed.keys, content: parsed.body }, i);
      if (!derived || isPlaceholderLoreTitle(derived)) return block;   // 没信息可依 → 不动
      // 撞名：加（2）这种后缀，否则世界书按标题合并会把其中一条吃掉
      const finalTitle = used.has(derived) ? uniqueTitle(derived, used) : derived;
      if (!used.has(derived)) used.set(derived, 1);
      renamed.push({ from: title, to: finalTitle });
      changed += 1;
      return renderLoreEntryBlock({ ...parsed, title: finalTitle });
    });
    if (!changed) return { ok: true, text: current, action, title: '', changed: 0, lines: 0, renamed: [] };
    return { ok: true, text: `${header}${out.join('')}`, action, title: '', changed, lines: 0, renamed };
  }

  const at = blocks.findIndex((b) => blockTitle(b) === wantTitle);
  if (at < 0) return { ok: false, error: `找不到条目：${wantTitle || '（空标题）'}`, action };

  if (action === 'delete') {
    const rest = blocks.filter((_, i) => i !== at);
    const text = `${header}${rest.join('')}`.replace(/\n{3,}$/, '\n');
    return { ok: true, text, action, title: wantTitle };
  }

  if (action === 'update') {
    if (!newTitle) return { ok: false, error: '条目要有标题', action };
    // 改名撞车要挡住（否则两条同名，以后按标题编辑会永远打到第一条）
    if (newTitle !== wantTitle && blocks.some((b, i) => i !== at && blockTitle(b) === newTitle)) {
      return { ok: false, error: `已有同名条目：${newTitle}`, action };
    }
    const next = blocks.slice();
    next[at] = renderLoreEntryBlock({ ...entry, title: newTitle });
    const text = `${header}${next.join('')}`;
    return { ok: true, text, action, title: newTitle };
  }

  return { ok: false, error: `未知操作：${action}`, action };
}

/** 列表里每条正文最多带多少字（整本世界书另有总预算，见 LOL 视图预算）。 */
const LORE_VIEW_BODY_CHARS = 20000;
/** 列表响应里正文的总预算：超了就只给预览，避免一次响应几 MB。 */
const LORE_VIEW_TOTAL_CHARS = 600000;
/** 单条详情（编辑器用）的正文上限；超过则标记 truncated，界面据此禁用保存。 */
const LORE_DETAIL_BODY_CHARS = 500000;

/**
 * 世界书条目的界面表示。
 *
 * **带全文**（不再是 160 字预览）：用户要能在面板里直接把条目读完，
 * 而不是每条都点进编辑器。整本世界书一般几十 KB，一次给完完全没问题；
 * 极端大书由 `budget` 兜底 —— 超预算的条目退回预览并标 `bodyTruncated`。
 *
 * `empty` / `kind` 一定算出来（老文件里的条目可能是更早的解析结果，没带这两个字段）：
 * 前者让面板把空壳条目单独折叠，后者给出 设定/规则/状态/历史 标签。
 */
function loreEntryView(e, budget) {
  const full = e.body;
  const room = budget === undefined ? full.length : Math.max(0, Math.min(full.length, budget.left, LORE_VIEW_BODY_CHARS));
  const body = full.slice(0, room);
  if (budget !== undefined) budget.left -= body.length;
  return {
    title: e.title,
    keys: e.keys,
    constant: e.constant,
    order: e.order,
    probability: e.probability,
    // 来源：'card' = 从 PNG 卡导入的（面板据此标「导入」，并说明它按触发词走 runtime）
    source: String(e.source ?? ''),
    chars: full.length,
    body,
    bodyTruncated: body.length < full.length,
    preview: full.slice(0, 160),
    empty: e.empty === true || isJunkLoreBody(full),
    kind: e.kind ?? loreKindOf({ title: e.title, body: full }),
  };
}

/**
 * 世界书的总览数字（面板顶部那行提示用）。
 *
 * `constantChars` 是**每轮真的会注入**的字数 —— 用户问过「常驻条目到底占了多少上下文」，
 * 只报条数没法回答，所以这里把字也算出来。
 *
 * ⚠️ 它不等于「原卡里标了 constant 的条数」：导入来的常驻与超预算的常驻都**降级**到 runtime
 * （见 planLoreInjection），所以这里用注入规划的结果算，否则面板会把「按需」的条目
 * 报成「每轮都在」，用户看到 4.2 万字/轮会被吓到（而且那是错的）。
 */
function loreOverview(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const plan = planLoreInjection(list);
  const kinds = { 设定: 0, 规则: 0, 状态: 0, 历史: 0 };
  for (const e of list) {
    const k = e.kind ?? loreKindOf({ title: e.title, body: e.body });
    kinds[k] = (kinds[k] ?? 0) + 1;
  }
  return {
    total: list.length,
    constant: plan.standing.length,
    keyed: list.filter((e) => Array.isArray(e.keys) && e.keys.length).length,
    empty: list.filter((e) => e.empty === true || isJunkLoreBody(e.body)).length,
    emptyChars: list.filter((e) => e.empty === true || isJunkLoreBody(e.body)).reduce((n, e) => n + e.body.length, 0),
    constantChars: plan.standingChars,
    // 因来源/预算而降级的常驻条目：面板要说清楚它们**在哪**（按触发词进 runtime，不是丢了）
    demoted: plan.demoted,
    // ⚠️ 名字不能叫 `imported`：`applyLoreEdit` 的返回值里 `imported` 是「这次并入了几条」，
    //    两者在路由响应里会撞键，后展开的那个会把前一个覆盖掉（冒烟测试抓到过）。
    importedEntries: list.filter((e) => String(e.source ?? '').toLowerCase() === 'card').length,
    kinds,
  };
}

/**
 * 规范化世界书的 key（§3.3）：去首尾空白、全角→半角、去掉常见标点与空白、统一小写。
 *
 * 为什么不能在原文上直接比：卡里的触发词写法五花八门 ——
 * 「诸葛大力」「 诸葛大力 」「诸葛大力：」是全角/半角与标点的差别，
 * 用原文比会把同一批人算成不同条目，重复检测直接失灵。
 * **原文不丢**（展示仍用原样），这里只用于比较。
 */
function normalizeLoreKey(text) {
  return String(text ?? '')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .replace(/[\s_\-·・:：;；,，、.。/\\|()（）[\]【】"'“”‘’!！?？*#]+/g, '')
    .toLowerCase();
}

/**
 * 面板用的**条目名 ↔ 人物名**诊断 —— 只看**条目名称**是否与某张人物卡重名。
 *
 * 用户拍板（两次更正后的最终口径）：
 * - **key 一律不管**：两条条目共用一个触发词无所谓、不用显示；触发词里出现人物名也不算；
 * - 唯一要看的是**条目名称**和**角色名**重不重复 —— 实测《爱情公寓》15 个条目就叫
 *   15 个人物的名字，那才是同一批正文进两次上下文的来源（装配层也按这一条跳过）。
 *
 * 比较时用 `normalizeLoreKey()` 归一（全半角/标点/大小写），否则「 长安城：」与「长安城」
 * 会被当成两个不同的东西。
 *
 * **不删任何东西**：诊断只是提示，删改由用户/DM 决定（§9 数据安全原则）。
 */
function loreNameConflicts(entries, { characterNames = [] } = {}) {
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && e.empty !== true);
  const byTitle = {};
  const names = new Map();
  for (const n of Array.isArray(characterNames) ? characterNames : []) {
    const k = normalizeLoreKey(n);
    if (k && !names.has(k)) names.set(k, String(n));
  }
  const characterOverlap = [];
  for (const e of list) {
    const key = normalizeLoreKey(e.title);
    if (!key || !names.has(key)) continue;
    characterOverlap.push({ title: e.title, character: names.get(key) });
    byTitle[e.title] = `条目名与人物卡「${names.get(key)}」重名，正文已由人物卡承载（不会再从世界书重复注入）`;
  }
  return { characterOverlap, byTitle };
}

/** 某个会话里的人物名（诊断用）。读不到就返回空数组，绝不因为诊断把路由打挂。 */
function sessionCharacterNames(sessionId) {
  try {
    return (loadSession(sessionId).characters ?? []).map((c) => String(c?.name ?? '').trim()).filter(Boolean);
  } catch { return []; }
}

/** 世界书模板：让 DM 一键生成正确格式，用户不用记语法。 */
function loreTemplateText() {
  return `# ${LORE_FILE_NAME} — 本会话世界书

<!--
这一行及下面的说明不会进入模型上下文（只有 ## 条目会被解析）。

用法：每个 ## 是一个条目。对话里出现该条目的触发词时，它的正文会被自动注入上下文。
触发词用 HTML 注释写；不写就用标题当触发词。

可选标记（写在同一条注释里，用 | 分隔）：
  constant  常驻：不看触发词，每轮都注入（用于最核心的几条设定，别滥用）
  order: N  越大越优先；预算不足时先保它
  prob: N   触发概率 0-100（默认 100）
            概率用确定性掷点（种子 = 会话+轮次+条目名），同一轮的结果可精确复现

维护方式：用编辑器直接改这个文件，或让 DM 用 write/edit 工具改。
条目读不全时，DM 可以用 rp_lore 按关键词把某条取出来。
-->

## 世界总纲
<!-- constant -->
这里写一两句最核心的世界观（时代、地域、基调）。标了 constant 所以每轮都会进上下文，请控制长度。

## 主要势力
<!-- keys: 势力名1, 势力名2 | order: 80 -->
描述这个势力：立场、掌权者、与玩家的关系。对话里提到"势力名1"时这段就会被注入。

## 关键人物
<!-- keys: 人物名 | order: 60 -->
人物的背景、动机、把柄、对玩家的态度。

## 地点
<!-- keys: 地点名 -->
这个地点的样子、里面有什么、危险在哪。

## 传闻（每次出现概率不同）
<!-- keys: 传闻, 谣言 | prob: 40 -->
这条只有 40% 概率被注入 —— 适合那种"偶尔才会被提起"的线索。
`;
}

/**
 * fork 一个新会话时，把父会话的 RP 配置（世界 / 角色卡 / 随机表 / 前缀 / 战役名 / 宏表 /
 * DM 设定）复制过去。
 *
 * 为什么需要：RP 配置按会话 id 存在 `sessions/<id>.json`，而 fork 出来的子会话是**新 id**，
 * 于是分叉后 DM 攒下的世界观、角色卡、随机表全都「消失」—— 用户看到的就是「新建分支后配置没了」。
 * 谱系信息由 DSH 自己给：`session.header.parentSession` 是 fork 来源，
 * `isSeeded` 表示该日志含 fork 继承的前缀（**resume 不会置 true**，所以不会把恢复误判成 fork）。
 *
 * 复制是「快照」语义：之后父子各改各的，互不牵连。
 * @returns 复制成功返回子会话 id，否则 undefined。
 */
function copyRpSessionFromParent(childId, parentId) {
  const child = normalizeSessionId(childId);
  const parent = normalizeSessionId(parentId);
  if (!child || !parent || child === 'default' || parent === 'default' || child === parent) return undefined;
  try {
    // 子会话已有自己的配置文件 → 不覆盖（可能先调过工具，或是人工放的）
    if (existsSync(sessionFile(child))) return undefined;
    const parentFile = [sessionFile(parent), join(SESSIONS_DIR, `session-${parent}.json`)].find((f) => existsSync(f));
    if (!parentFile) return undefined;                    // 父会话没有 RP 配置，没什么可继承
    const data = JSON.parse(readFileSync(parentFile, 'utf8'));
    const preset = typeof data.preset === 'string' ? data.preset : '';
    saveSession({ ...data, sessionId: child });
    // 世界书现在按会话隔离，**fork 必须把父会话的世界书也带过来** ——
    // 否则分叉出来的会话有父会话的「世界设定」却没有世界书条目（看起来像丢了一半设定）。
    try {
      const pLore = sessionLorePath(parent);
      const cLore = sessionLorePath(child);
      if (pLore && cLore && existsSync(pLore.file) && !existsSync(cLore.file)) {
        mkdirSync(cLore.dir, { recursive: true });
        writeFileSync(cLore.file, readFileSync(pLore.file, 'utf8'), 'utf8');
      }
    } catch { /* 世界书复制失败不该影响会话创建 */ }
    // 父会话是 DM，分叉当然还是 DM —— 记上，界面与会话侧判定立刻一致
    if (preset === 'dm') markDmSession(child, 'dm');
    return child;
  } catch { return undefined; }   // 继承失败不该影响会话创建
}

/** dm 预设登记的会话清单（供页签只对 dm 会话显示）。 */
function loadDmIndex() {
  try {
    if (!existsSync(DM_INDEX_FILE)) return {};
    const data = JSON.parse(readFileSync(DM_INDEX_FILE, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch { return {}; }
}

/** 登记一个 dm 会话（dm 预设的桥接插件 / 客户端预设判定调用）。 */
function markDmSession(sessionId, presetName) {
  try {
    const id = normalizeSessionId(sessionId);
    const preset = String(presetName ?? 'dm');
    const index = loadDmIndex();
    // 幂等：工具每次调用都会走保底登记，内容没变就别反复写盘。
    if (index[id]?.preset === preset) return true;
    mkdirSync(RP_DATA_DIR, { recursive: true });
    index[id] = { preset, at: new Date().toISOString() };
    writeFileSync(DM_INDEX_FILE, JSON.stringify(index, null, 2) + '\n', 'utf8');
    return true;
  } catch { return false; }
}

/**
 * 这个会话是不是 DM 会话。三种来源，任一命中即可：
 *   ① 登记表（桥接 / 客户端预设判定写入）；
 *   ② 会话文件里的 preset（同 ①，随会话走，换机器也认）；
 *   ③ 调用方已经读到的会话对象（避免重复读盘）。
 * 兼容带/不带 `session-` 前缀两种写法。
 */
function isDmSession(sessionId, preloaded) {
  const id = normalizeSessionId(sessionId);
  const index = loadDmIndex();
  if (index[id] || index[`session-${id}`]) return true;
  try {
    const session = preloaded ?? loadSession(id);
    return session?.preset === 'dm';
  } catch { return false; }
}


/**
 * 状态追踪的字段集。
 *
 * 为什么需要它（**不是**「记不住上一幕」—— 上一幕在上下文里，模型看得到）：
 * 只有叙述文本承载的状态（伤势、东西在谁手里、关系变化、伏笔）会在**上下文被压缩后消失**。
 * 世界书兜住的是「设定」，这里兜住的是「变化」。
 *
 * 设计取向（对照 dsh-roleplay 的 event-sourced 投影，我们取轻量版）：
 * - **结构化字段 + 自由 flags**：常用维度固定下来（模型好填、我们好渲染），
 *   战役特有的东西（伏笔、声望、时限）丢进 flags，不用改代码；
 * - **不用数值好感度**：谁改、何时改说不清，容易变成模型自己报数；关系用文字；
 * - **靠模型主动更新**（工具动作），不解析叙事正文 —— 解析自由文本很脆，
 *   而 roleplay 的实现也明确是「模型主动调工具」而非抽取正文。
 */
const STATE_FIELDS = ['scene', 'time', 'location', 'present', 'clues'];
/**
 * 队伍成员（= 场上人物）的**动态**字段。
 *
 * `abilities` 是后加的：技能 / 能力 / 专长和装备一样**会变**（学会新的、被封印、临时增益、
 * 换一把武器、把东西用掉）—— 用户一句「技能/能力/装备 等也可能是动态数据」点破了
 * 「技能放人物卡当静态设定」的错处。所以：**当前值一律放这里**（每轮注入、DM 随时改、
 * 过期的自然被覆盖）；人物卡只写不会变的底色（流派、战斗风格、性格），两者不重复。
 */
const PARTY_FIELDS = ['character', 'status', 'abilities', 'inventory', 'conditions', 'goal'];

/** 状态字段在注入文本里的显示名。改了 STATE_FIELDS 记得同步这里（有测试兜底）。 */
const STATE_LABELS = {
  scene: '场景', time: '时间', location: '地点', present: '在场', clues: '线索',
  character: '角色', status: '状态', abilities: '能力/技能', inventory: '持有/装备',
  conditions: '伤病/影响', goal: '目标',
};

/** 取显示名：缺标签时回退到字段名本身 —— 绝不让 `undefined` 出现在注入文本里（踩过一次）。 */
function stateLabel(field) {
  return STATE_LABELS[field] ?? field;
}

/** flags 里最多注入几条、键名多长（防止它变成第二个无界上下文）。 */
const FLAGS_MAX_SHOWN = 16;
const FLAG_KEY_CHARS = 40;
const FLAG_VALUE_CHARS = 120;

/** 状态多久没更新就在注入里提醒一次（单位：会话事件数，粗略对应轮次）。 */
const STATE_STALE_AFTER = 12;

function clampText(value, max) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * 把一次提交里的 `party` 数组规范化成 `{ character, present }`。
 *
 * **为什么不能直接丢空值**：`present` 要区分「传了空串」和「压根没传」——
 * 前者是「这个字段清掉」（伤势好了），后者是「别动它」。规范化时把两者都记下来，
 * 具体怎么落地交给调用处（merge 还是 replace）。空串在这里记成 `null` 占位。
 */
function normalizePartyPatch(rows) {
  return (Array.isArray(rows) ? rows : []).map((raw) => {
    const present = {};
    for (const f of PARTY_FIELDS) {
      if (!raw || !(f in raw)) continue;
      const v = String(raw[f] ?? '').trim();
      present[f] = v ? v : null;
    }
    return { character: String(raw?.character ?? '').trim(), present };
  });
}

/** `{character, present}` → 落盘用的行（空值字段与空行都丢掉，与旧行为一致）。 */
function partyRowFromPatch(entry) {
  const out = {};
  if (entry.character) out.character = entry.character;
  for (const [f, v] of Object.entries(entry.present)) if (v !== null) out[f] = v;
  return out;
}

/** `partyRemove` 接受数组或「逗号/顿号/空格分隔的名字串」。 */
function parsePartyRemove(raw) {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[,，、;；\s]+/);
  return list.map((s) => String(s ?? '').trim()).filter(Boolean);
}

/**
 * 规范化状态提交。
 * **不在设定时留幽灵键**：`updates` 里出现的键先移除再重建，
 * 传空串就等于删除 —— 这样「伤势好了」「东西用掉了」能把旧值清掉，而不是留个空壳。
 *
 * ## 队伍（`party`）的三种写法
 *
 * 这里曾经是**整组替换**，而工具说明写的是「只列你要更新的人」—— 两边不一致，
 * 照文档用就会把队友和装备一起删掉（真机复测时实测：提交 `[{character:'祁俊', conditions:''}]`
 * 之后，祝婉宁整行消失、祁俊自己的 status 与 inventory 也没了）。现在文档就是实现：
 *
 * - **默认 merge**：按 `character` 找到已有那一行，**只改你传的字段**（传空串＝清掉该字段），
 *   没传的字段原样保留；找不到就在末尾追加。所以「伤势好了」只传 `conditions:''` 就够了。
 * - `partyMode: 'replace'`：整组替换 —— 要删人、要重排顺序时用它。
 * - `party: []`：两种模式下都**清空**（一个明确的空数组没有别的解释）。
 * - `partyRemove`：按名字删人，与上面的模式叠加，也可以单独用。
 */
function applyStateUpdates(state, updates, { seq = 0, now = new Date().toISOString() } = {}) {
  const next = normalizeState(state);
  const patch = updates && typeof updates === 'object' ? updates : {};

  for (const f of STATE_FIELDS) {
    if (!(f in patch)) continue;
    const v = String(patch[f] ?? '').trim();
    if (v) next[f] = v; else delete next[f];
  }

  // ① 先按名字删人（与模式无关，可以单独使用）
  const removes = parsePartyRemove(patch.partyRemove);
  if (removes.length) {
    const gone = new Set(removes);
    next.party = (Array.isArray(next.party) ? next.party : []).filter((r) => !gone.has(String(r?.character ?? '').trim()));
  }

  // ② 再处理 party 本身
  if ('party' in patch && Array.isArray(patch.party)) {
    const mode = String(patch.partyMode ?? 'merge').trim() || 'merge';
    if (mode !== 'merge' && mode !== 'replace') {
      throw new Error(`rp_state: partyMode 只能是 "merge"（局部更新）或 "replace"（整组替换），收到 "${mode}"`);
    }
    const incoming = normalizePartyPatch(patch.party);
    if (incoming.length === 0) {
      next.party = [];                                   // 空数组 = 清空
    } else if (mode === 'replace') {
      next.party = incoming.map(partyRowFromPatch).filter((row) => Object.keys(row).length > 0);
    } else {
      const rows = (Array.isArray(next.party) ? next.party : []).map((r) => ({ ...r }));
      const at = new Map(rows.map((r, i) => [String(r.character ?? '').trim(), i]));
      for (const entry of incoming) {
        if (!entry.character) {
          // merge 靠名字定位，没有名字就没法「只改它」—— 与其猜一个、或者塞进一行永远删不掉的
          // 匿名记录，不如当场说清楚（模型看得到错误，一次重试就能改对）。
          throw new Error('rp_state: party 每项都要有 character（merge 靠它定位到人）；'
            + '若确实要整组替换，传 partyMode:"replace"');
        }
        const found = at.get(entry.character);
        if (found === undefined) {
          rows.push(partyRowFromPatch(entry));
          at.set(entry.character, rows.length - 1);
          continue;
        }
        const merged = { ...rows[found] };
        for (const [f, v] of Object.entries(entry.present)) {
          if (v === null) delete merged[f]; else merged[f] = v;
        }
        rows[found] = merged;
      }
      next.party = rows.filter((row) => Object.keys(row).length > 0);
    }
  }

  if ('flags' in patch && patch.flags && typeof patch.flags === 'object') {
    const flags = { ...(next.flags ?? {}) };
    for (const [rawKey, rawVal] of Object.entries(patch.flags)) {
      const key = clampText(rawKey, FLAG_KEY_CHARS);
      if (!key) continue;
      const val = String(rawVal ?? '').trim();
      if (val) flags[key] = clampText(val, FLAG_VALUE_CHARS); else delete flags[key];
    }
    if (Object.keys(flags).length) next.flags = flags; else delete next.flags;
  }

  next.updatedAt = now;
  next.updatedSeq = seq;
  return next;
}

/** 规范化（读取时用）：丢掉空值与未知键，保证渲染端不用判 undefined。 */
function normalizeState(state) {
  const out = {};
  for (const f of STATE_FIELDS) {
    const v = String(state?.[f] ?? '').trim();
    if (v) out[f] = v;
  }
  if (Array.isArray(state?.party)) {
    const party = state.party
      .map((row) => {
        const r = {};
        for (const f of PARTY_FIELDS) {
          const v = String(row?.[f] ?? '').trim();
          if (v) r[f] = v;
        }
        return r;
      })
      .filter((r) => Object.keys(r).length > 0);
    if (party.length) out.party = party;
  }
  if (state?.flags && typeof state.flags === 'object') {
    const flags = {};
    for (const [k, v] of Object.entries(state.flags)) {
      const key = clampText(k, FLAG_KEY_CHARS);
      const val = clampText(v, FLAG_VALUE_CHARS);
      if (key && val) flags[key] = val;
    }
    if (Object.keys(flags).length) out.flags = flags;
  }
  if (typeof state?.updatedAt === 'string' && state.updatedAt) out.updatedAt = state.updatedAt;
  if (Number.isFinite(Number(state?.updatedSeq))) out.updatedSeq = Number(state.updatedSeq);
  return out;
}

/**
 * 渲染注入用的状态文本。
 * @param seq - 当前会话事件数，用来判断状态是不是太久没更新了
 */
function renderState(state, seq = 0) {
  const st = normalizeState(state);
  const lines = [];
  for (const f of STATE_FIELDS) {
    if (st[f]) lines.push(`${stateLabel(f)}：${st[f]}`);
  }
  for (const row of st.party ?? []) {
    const bits = PARTY_FIELDS.filter((f) => f !== 'character' && row[f]).map((f) => `${stateLabel(f)}=${row[f]}`);
    if (row.character || bits.length) lines.push(`- ${row.character || '（未具名）'}${bits.length ? `：${bits.join('；')}` : ''}`);
  }
  const flagKeys = Object.keys(st.flags ?? {});
  if (flagKeys.length) {
    const shown = flagKeys.slice(0, FLAGS_MAX_SHOWN);
    const more = flagKeys.length - shown.length;
    lines.push('旗标：' + shown.map((k) => `${k}=${st.flags[k]}`).join('；') + (more > 0 ? `；…另有 ${more} 项` : ''));
  }
  if (!lines.length) return '';
  const stale = st.updatedSeq !== undefined && seq - st.updatedSeq >= STATE_STALE_AFTER;
  return '## 本场当前状态（唯一权威，最新）\n'
    + lines.join('\n')
    + (stale ? '\n（注：以上状态已多轮未更新。若本轮有变化——受伤、得失物品、关系转变、地点移动——请用 rp_state 更新。）' : '');
}

// ---- 可复现随机数工具（纯标准 JS）----

/** 把任意字符串哈希成 uint32 种子。 */
function hashSeed(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

/** mulberry32 PRNG：给定种子返回 [0,1) 的确定性随机函数。 */
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 构造随机源：有 seed 用确定性 PRNG，否则用 Math.random。 */
function makeRng(seed) {
  if (seed === undefined || seed === null || seed === '') return Math.random;
  return mulberry32(hashSeed(String(seed)));
}

/** 数值/标量统一转字符串（浮点保留 4 位小数）。 */
function fmt(v) {
  if (typeof v === 'number') {
    return Number.isInteger(v) ? String(v) : String(Math.round(v * 10000) / 10000);
  }
  return String(v);
}

/** 单次掷骰的骰子颗数上限（`100d6` 已经够离谱了）。 */
const DICE_MAX_COUNT = 100;
/** 骰面数上限。`1d1000000000` 语法上合法，但掷出来是十位数，对叙事没有意义 —— 直接拒。 */
const DICE_MAX_SIDES = 100000;
/** 一次生成多少个结果。**契约值**，由 `resolveRollCount` 强制（不再静默截断）。 */
const ROLL_COUNT_MAX = 20;

/**
 * `count` 的取值检查：**越界抛错，不静默截断**。
 *
 * 工具契约写着「1..20」和「参数非法会抛出明确错误」，而旧实现是
 * `Math.min(Math.max(trunc(c), 1), 20)` —— `count:21` 悄悄只给 20 个结果，
 * `count:0` / 负数悄悄变成 1。模型据此以为「我掷了 21 次」，实际不是；
 * 这种偏差在跑团里就是**结果与叙述对不上**。要么按契约拒绝，要么改契约 —— 这里选拒绝。
 */
function resolveRollCount(raw) {
  if (raw === undefined || raw === null) return 1;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`rp_random: count must be an integer between 1 and ${ROLL_COUNT_MAX} (got ${JSON.stringify(raw)})`);
  }
  if (n < 1 || n > ROLL_COUNT_MAX) {
    throw new Error(`rp_random: count must be between 1 and ${ROLL_COUNT_MAX} (got ${n})`);
  }
  return n;
}

/**
 * 解析骰子表达式，如 "2d6+3"、"d20"、"3d8+1d4-2"。
 *
 * **必须一口气吃完整串**（真机测试报告里的 BUG-03）：旧实现用 `String.match(/…/g)` 做**扫描**，
 * 匹配不上的位置会被静默跳过 —— 于是
 *   `2dd6`   → 被吃成「常数 2」+「d6」，即 2 + 1d6（还照原样回显 `2dd6`，明细却是 1d6，自相矛盾）
 *   `2d6++3` → `++` 里那一个 `+` 被跳过，表达式照样成立，`+3` 照算
 * 这类输入**合法与非法之间没有可见差别**，跑团里等于悄悄改了玩家的骰子。
 * 现在改用**粘性（sticky）逐段匹配**：每一步都必须匹配上，且必须刚好停在字符串末尾 ——
 * 剩下一个字符没吃下去就抛错。`d` 缺骰面数、多余的运算符、夹杂字母，全都会被挡下。
 */
function parseDice(expr) {
  const text = String(expr ?? '').replace(/\s+/g, '');
  const bad = () => new Error(`rp_random: dice expression "${expr}" is invalid — expected something like "2d6+3" or "d20"`);
  if (!text) throw bad();
  // 一组骰子（可选符号 + 可选颗数 + d + 面数）或一个常数（可选符号 + 数字）
  const re = /([+-]?)(\d*)d(\d+)|([+-]?)(\d+)/y;
  let totalConst = 0;
  const dice = [];
  let at = 0;
  while (at < text.length) {
    re.lastIndex = at;
    const m = re.exec(text);
    if (!m) throw bad();
    if (m[3] !== undefined) {
      const count = m[2] === '' ? 1 : Number.parseInt(m[2], 10);
      const sides = Number.parseInt(m[3], 10);
      if (!Number.isFinite(count) || count < 1 || count > DICE_MAX_COUNT) {
        throw new Error(`rp_random: dice "${m[0]}" has invalid number of dice (must be 1..${DICE_MAX_COUNT})`);
      }
      // 面数上界：`1d1000000000` 语法上「合法」，但掷出来是个十位数 —— 对叙事毫无意义。
      // 与其让它悄悄产出垃圾，不如当场说清面数超了。
      if (!Number.isFinite(sides) || sides < 2 || sides > DICE_MAX_SIDES) {
        throw new Error(`rp_random: dice "${m[0]}" has invalid sides (must be 2..${DICE_MAX_SIDES})`);
      }
      dice.push({ count, sides, sign: m[1] === '-' ? -1 : 1 });
    } else {
      const n = Number.parseInt(m[5], 10);
      totalConst += m[4] === '-' ? -n : n;
    }
    at = re.lastIndex;
  }
  if (dice.length === 0) {
    throw new Error(`rp_random: dice expression "${expr}" contains no dice`);
  }
  return { dice, totalConst };
}

/**
 * 掷一组骰子，返回总和与**可核对的**逐颗明细。
 *
 * 明细里必须带符号与常数修正：`2d6+3` 掷出 [6,2] 时明细是 `2d6[6,2] + 3`。
 * 旧实现只拼骰子组、把常数丢了（负骰组也不带负号），于是 `2d6+3 → 11 (2d6[6,2])` ——
 * 玩家一加是 8，看到 11 会以为骰子坏了。明细存在的意义就是能对上账。
 */
function rollDice(parsed, rnd) {
  let sum = parsed.totalConst;
  const parts = [];
  for (const d of parsed.dice) {
    let s = 0;
    const rolls = [];
    for (let i = 0; i < d.count; i++) {
      const r = Math.floor(rnd() * d.sides) + 1;
      rolls.push(r);
      s += r;
    }
    sum += d.sign * s;
    const body = `${d.count}d${d.sides}[${rolls.join(',')}]`;
    // 正数第二组起要补 `+`，否则 `3d8[5,5,5] 1d4[3] - 2` 读起来像是两组粘在一起
    parts.push(d.sign < 0 ? `- ${body}` : (parts.length ? `+ ${body}` : body));
  }
  if (parsed.totalConst !== 0) {
    parts.push(`${parsed.totalConst > 0 ? '+' : '-'} ${Math.abs(parsed.totalConst)}`);
  }
  return { sum, detail: parts.join(' ') };
}

/** 从列表抽取一项；提供 weights 时按权重抽取。 */
function pickWeighted(choices, weights, rnd) {
  if (weights !== undefined) {
    if (!Array.isArray(weights) || weights.length !== choices.length) {
      throw new Error('rp_random: weights must have the same length as choices');
    }
    let total = 0;
    for (const w of weights) {
      if (typeof w !== 'number' || !Number.isFinite(w) || w < 0) {
        throw new Error('rp_random: weights must be non-negative numbers');
      }
      total += w;
    }
    if (total <= 0) throw new Error('rp_random: weights must sum to more than zero');
    let r = rnd() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r <= 0) return choices[i];
    }
    return choices[choices.length - 1];
  }
  return choices[Math.floor(rnd() * choices.length)];
}

// ---- 工具清单 ----
//
// 全部 rp_* 工具都在 `rpTools` 里，由 dm 预设的 rp-bridge 调用 `registerRpTools(ctx)` 在
// **agent 作用域**注册 —— 所以其它预设的会话既看不到也调不到（连 rp_random 也是）。
// 宿主组合（全局 apply）**不注册任何模型工具**，只负责 HTTP 路由与会话级维护。

// ── 资源库的常量 ────────────────────────────────────────────────────────────
// ⚠️ 必须放在 `rpTools` **之前**：`rp_assets` 的参数说明里用了 ASSET_LIST_DEFAULT_LIMIT，
// 而数组字面量在模块加载时就会求值 —— 放到后面会直接 TDZ 抛错（`const` 没有提升）。
// 存放形状（kind 同时也是目录名）：
//   <工作区>/rp-sessions/<会话 id>/assets.json
//   <工作区>/rp-sessions/<会话 id>/assets/portraits|scenes|items|other/<id>.png
const ASSET_DIR = 'assets';
const ASSET_INDEX_FILE = 'assets.json';
/** 资源分类。**顺序即界面顺序**（角色/场景/道具/其他）。 */
const ASSET_KINDS = ['portrait', 'scene', 'item', 'other'];
/** 分类 → 子目录名。和 kind 一一对应，索引里存的 `kind` 决定文件去哪。 */
const ASSET_KIND_DIR = { portrait: 'portraits', scene: 'scenes', item: 'items', other: 'other' };
/** 分类 → 中文显示名（面板与工具返回都用它，模型不必知道英文 key）。 */
const ASSET_KIND_LABEL = { portrait: '角色', scene: '场景', item: '道具', other: '其他' };
const ASSET_MAX_BYTES = 8 * 1024 * 1024;
/** 只承认这三种（浏览器 img 都认）：其余一律回 400，不猜扩展名。 */
const ASSET_MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
/** 单张资源的 `label` / 每个 tag 的长度上限（索引是给人读的，不是原样存提示词）。 */
const ASSET_LABEL_MAX = 60;
const ASSET_TAGS_MAX = 12;
/** 索引里保存的 prompt 原文上限：留着是为了事后能补救标签，不是让人读整段。 */
const ASSET_PROMPT_MAX = 400;
/** `rp_assets` 一次最多返回多少条 / 面板一次最多拉多少条。 */
const ASSET_LIST_DEFAULT_LIMIT = 20;
const ASSET_LIST_MAX_LIMIT = 200;
/** 分类是否合法（非法一律归 `other`，不猜）。 */
const assetKindOf = (kind) => (ASSET_KINDS.includes(String(kind)) ? String(kind) : 'other');

const rpTools = [
  // ---- 通用随机裁决（原先是全局工具，现收进 dm 作用域）----
  {
    name: 'rp_random',
    description: '为角色扮演与叙事生成可配置的随机值：骰子、数值区间、加权抽取、布尔翻转。凡场景需要中立随机结果时使用（战斗检定、掉落、遭遇表、惊喜、情绪、天气、命运裁决）。seed 可复现，count 可批量。\n\n模式（kind 缺省时按传入参数自动推断）：\n- dice：骰子表达式，如 「2d6+3」「d20」「3d8+1d4-2」，支持多组骰子与加减修正；**每一掷都返回总和与逐颗明细**（含常数修正，能自己核对：`2d6+3 → 11（2d6[6,2] + 3）`）；\n- choices：从列表抽取，可选 weights 制造不均等概率（如稀有度掉落、NPC 反应）；\n- integer / float：min..max 闭区间随机数，缺省 1..100（整数）或 0..1（浮点）；\n- bool：50/50 真假翻转。\n\n参数说明：count 一次生成多个值（1..20，choices 为放回抽取）；seed 相同则结果必定相同（确定性 PRNG），不传则真随机。\n\n参数非法一律**抛出明确错误**（骰式写错、权重数量与 choices 不一致、区间倒置、count 超出 1..20）—— 不会「猜你的意思」也不会静默少给几个结果，修正参数重试即可。骰式必须整串合法：`2dd6`、`2d6++3` 这类会被拒绝，而不是被拆成一半照跑。',
    parameters: {
      kind: {
        type: 'string',
        enum: ['integer', 'float', 'choice', 'dice', 'bool'],
        description: '生成类型：integer（整数）/ float（浮点）/ choice（抽取）/ dice（骰子）/ bool（布尔）。缺省时按参数自动推断：传了 dice 用骰子；传了 choices 用加权抽取；传了 min/max 用数值区间；否则默认整数 1..100。',
      },
      min: { type: 'number', description: '数值区间（含）下界，integer/float 模式使用。' },
      max: { type: 'number', description: '数值区间（含）上界，integer/float 模式使用。只给 max 时区间为 1..max；两者都不给时整数 1..100、浮点 0..1。' },
      choices: { type: 'array', items: { type: 'string' }, description: '候选列表，从中抽取一个（或 count 个）。元素按字符串处理；结合 weights 可实现不均等概率（如「成功 5 份、失败 1 份」）。' },
      weights: { type: 'array', items: { type: 'number' }, description: '可选权重数组：长度必须与 choices 一致，元素为非负数值，权重越大被抽中概率越高。' },
      dice: { type: 'string', description: '骰子表达式，如 「2d6+3」「d20」「3d8+1d4-2」：NdM 表示掷 N 颗 M 面骰（N 缺省为 1），支持多组骰子与 ± 常数，所有骰子与修正求和为最终结果。' },
      count: { type: 'number', description: `一次生成的结果数量（1..${ROLL_COUNT_MAX}，默认 1）；choices 模式为放回抽取（同一项可重复出现）。**越界会报错**，不会被悄悄截断。` },
      seed: { type: 'string', description: '可选种子字符串：相同 seed + 相同参数必定产出相同结果（确定性 PRNG），便于复现关键剧情掷点或调试；不传则使用真随机。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true },
          values: { type: 'array', required: true, items: { type: 'string' } },
          note: { type: 'string', required: true },
          seed: { type: 'string' },
        },
      },
      render: (args, value) => [{ type: 'text', text: `🎲 ${value.note}` }],
    },
    execute: async (args) => {
      const count = resolveRollCount(args.count);
      const rnd = makeRng(args.seed);
      const out = {
        kind: 'integer',
        values: [],
        note: '',
        ...(args.seed !== undefined ? { seed: String(args.seed) } : {}),
      };
      if (args.dice !== undefined) {
        out.kind = 'dice';
        const parsed = parseDice(args.dice);
        // **每一掷都带明细**：以前 `count > 1` 时这里被一句 `out.note = …` 覆盖掉，
        // 于是「3d8+1d4-2 × 2 → 6, 12」这种结果**没有任何可核对的过程**（报告 BUG-05）。
        // 注意那不是「复杂骰式」特有 —— 简单的 `2d6+3 count:3` 一样丢明细。
        const entries = [];
        for (let i = 0; i < count; i++) {
          const { sum, detail } = rollDice(parsed, rnd);
          out.values.push(fmt(sum));
          entries.push(`${fmt(sum)}（${detail}）`);
        }
        out.note = count === 1
          ? `${args.dice} → ${entries[0]}`
          : `${args.dice} × ${count} → ${entries.join('；')}`;
        return out;
      }
      if (args.choices !== undefined) {
        if (!Array.isArray(args.choices) || args.choices.length === 0) {
          throw new Error('rp_random: choices must be a non-empty array');
        }
        out.kind = 'choice';
        const src = args.choices.map(String);
        for (let i = 0; i < count; i++) out.values.push(pickWeighted(src, args.weights, rnd));
        out.note = count === 1
          ? `choice from [${src.join(', ')}] → ${out.values[0]}`
          : `choice from [${src.join(', ')}] × ${count} → ${out.values.join(', ')}`;
        return out;
      }
      if (args.kind === 'dice') throw new Error('rp_random: kind "dice" requires the dice argument, e.g. dice: "2d6+3"');
      if (args.kind === 'choice') throw new Error('rp_random: kind "choice" requires the choices argument');
      if (args.kind === 'bool') {
        out.kind = 'bool';
        for (let i = 0; i < count; i++) out.values.push(rnd() < 0.5 ? 'true' : 'false');
        out.note = `bool flip × ${count} → ${out.values.join(', ')}`;
        return out;
      }
      const isFloat = args.kind === 'float';
      const lo = args.min !== undefined ? args.min : (args.max !== undefined ? 1 : (isFloat ? 0 : 1));
      const hi = args.max !== undefined ? args.max : (isFloat ? 1 : 100);
      if (typeof lo !== 'number' || typeof hi !== 'number' || !Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) {
        throw new Error('rp_random: invalid range — min and max must be finite numbers with max >= min');
      }
      out.kind = isFloat ? 'float' : 'integer';
      for (let i = 0; i < count; i++) {
        const v = isFloat ? lo + rnd() * (hi - lo) : Math.floor(rnd() * (hi - lo + 1)) + lo;
        out.values.push(fmt(v));
      }
      out.note = `${isFloat ? 'float' : 'integer'} [${lo}, ${hi}] × ${count} → ${out.values.join(', ')}`;
      return out;
    },
  },
  // ---- 角色设定表 ----
  {
    name: 'rp_character',
    description: [
      '管理战役的角色设定表。',
      'appearance 是保持角色长相一致的主要手段：配图时把它放进画面描述里。',
      '（本插件不出图 —— 要插图用宿主的 `generate_image`；图的入库与复用见 `rp_assets`。）',
      '角色设定会随世界设定一起注入模型上下文，所以填得越具体，扮演越稳。',
      '字段填法建议（重要）：',
      '- appearance 按「发型颜色 → 眼睛 → 肤色体型 → 身高 → 日常穿着 → 标志性配饰」的顺序写，具体到能画出来；',
      '- speech 请写**可观察的量化特征**（如「句子短、爱用反问、管玩家叫小子」），不要写「说话很有个性」这种空话；',
      '- first_mes 填一段该角色初次登场时的**开场白原文**，它是最有效的文风锚点（只取前 300 字注入）；',
      '- mes_example 填 2~4 轮带对白的示例，用「角色名：台词」的格式。',
    ].join('\n'),
    parameters: {
      action: { type: 'string', required: true, description: '"list" 列出全部；"set" 新增或更新一个角色（需 name）；"remove" 删除一个（需 name）；"clear" 清空' },
      name: { type: 'string', description: '角色名（set/remove 用）。名字同时是角色卡的唯一标识与注入时的检索键。' },
      appearance: { type: 'string', description: '外貌描述。按「发型颜色→眼睛→肤色体型→身高→日常穿着→标志性配饰」顺序写，配图时作为画面描述的一部分' },
      personality: { type: 'string', description: '性格：表层 → 深层 → 矛盾点，以及对待玩家的基本态度' },
      speech: { type: 'string', description: '说话方式：口癖、常用称呼、句子长短等可观察的量化特征' },
      behavior: { type: 'string', description: '可观察的行为习惯（紧张时做什么、面对威胁时的第一反应等）' },
      first_mes: { type: 'string', description: '初次登场的开场白原文，作为文风范本（注入时只取前 300 字）' },
      mes_example: { type: 'string', description: '对话范例，2~4 轮，格式「角色名：台词」' },
      relations: { type: 'string', description: '与其他角色的关系（文字描述，如「祁俊的师父，亦师亦母」）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          characters: { type: 'array', required: true, items: { type: 'string' } },
          note: { type: 'string', required: true },
        },
      },
      render: (args, value) => {
        const lines = [`🧑‍🎤 ${value.note}`];
        for (const c of value.characters) lines.push(`  ${c}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    execute: async (args, exec) => {
      const cfg = loadStyles();
      const session = loadSession(sessionIdOf(exec));
      const action = String(args.action ?? 'list');
      const sheet = session.characters;

      if (action === 'set') {
        const name = String(args.name ?? '').trim();
        if (!name) throw new Error('rp_character: action "set" 需要 name');
        const idx = sheet.findIndex((c) => String(c.name) === name);
        const existing = idx >= 0 ? sheet[idx] : null;
        // 只覆盖**传进来的**字段：没传的保持原值（否则改一个字段会把别的字段清掉）
        const next = normalizeCharacter(existing ?? { name });
        next.name = name;
        for (const f of CHARACTER_FIELDS) {
          if (f === 'name') continue;
          if (args[f] === undefined) continue;
          next[f] = String(args[f]).trim();
        }
        if (idx >= 0) sheet[idx] = next; else sheet.push(next);
        saveSession(session);
      } else if (action === 'remove') {
        const name = String(args.name ?? '').trim();
        session.characters = sheet.filter((c) => String(c.name) !== name);
        saveSession(session);
      } else if (action === 'clear') {
        session.characters = [];
        saveSession(session);
      } else if (action !== 'list') {
        throw new Error(`rp_character: 未知 action "${action}"（可用 list / set / remove / clear）`);
      }

      const current = session.characters.map((c) => {
        const filled = CHARACTER_FIELDS.filter((f) => f !== 'name' && String(c[f] ?? '').trim());
        return `${c.name}：${c.appearance || '（无外观描述）'}${filled.length ? `　[已填：${filled.join('/')}]` : ''}`;
      });

      return {
        ok: true, action, characters: current,
        note: `${action} 完成，本会话当前 ${current.length} 个角色（会话 ${session.sessionId}）`,
      };
    },
  },

  // ---- 生成工具：状态追踪（伤势 / 物品 / 关系 / 伏笔）----
  {
    name: 'rp_state',
    description: [
      '查看或更新「本场当前状态」—— 场景、时间、地点、在场者、队伍成员的状态/持有/伤病/目标，以及自由旗标。',
      '为什么需要它：对话历史会被上下文压缩。**只有叙述文本承载的变化会在压缩后消失** ——',
      '谁受了什么伤、钥匙现在在谁手里、关系变了、埋下的伏笔。这些必须落到结构化状态里，否则几轮后就没人记得。',
      '用法：',
      '- 每次剧情推进后，**只提交发生变化的部分**（局部更新，没传的字段保持原值）；',
      '- 把某个字段设为**空串即为清除**（伤势好了、东西用掉了、人离场了）；',
      '- 战役特有的东西（伏笔、声望、倒计时、承诺）丢进 flags 自由键值，想加就加，不需要改插件；',
      '- 状态每轮都会自动注入你的上下文，**不必反复 get**；只在不确定当前值时用 action:"get"。',
      '注意：status 会覆盖角色的整体状态描述，inventory 会覆盖持有物列表 —— 它们是「当前值」而不是增量，',
      '所以更新前请先看注入的状态里现值是什么，把该保留的写进去。',
    ].join('\n'),
    parameters: {
      action: { type: 'string', description: '"set"（默认）提交变化；"get" 读取当前状态（含完整 flags）' },
      scene: { type: 'string', description: '当前场景的一句话概括' },
      time: { type: 'string', description: '游戏内时间，如「当夜三更」「次日清晨」' },
      location: { type: 'string', description: '当前地点' },
      present: { type: 'string', description: '在场者（除队伍成员外），如「祝婉宁、两名麒麟卫」' },
      clues: { type: 'string', description: '已知线索 / 待办' },
      party: {
        type: 'array',
        description: '队伍成员状态，每项 {character, status, abilities, inventory, conditions, goal}。'
          + '**默认是局部更新**：按 `character` 找到那一行，只改你传的字段 —— 没传的字段原样保留，'
          + '传空串则清掉该字段。所以「祁俊伤好了」只要 `[{character:"祁俊", conditions:""}]`，'
          + '**不要**为了改一个字段把整行重发一遍（更不要把队友漏掉）。'
          + '`character` 必填。要删人/重排顺序用 `party_mode:"replace"` 传完整数组，或直接用 `party_remove`。'
          + '传空数组 `[]` 即清空全部。',
      },
      party_mode: { type: 'string', description: '"merge"（默认，局部更新，按 character 合并）或 "replace"（整组替换）。只有要删人、要重排顺序时才用 replace' },
      party_remove: { type: 'string', description: '按名字把人从队伍里移除，逗号分隔（如「祝婉宁,两名麒麟卫」）；与 party/party_mode 可同时使用，也可单独用' },
      flags: {
        type: 'object',
        additionalProperties: true,
        description: '自由键值（伏笔、声望、倒计时…）。传空串即删除该键。例：{"伏笔_黑猫":"已埋","义王_好感":"警惕"}',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          lines: { type: 'array', required: true, items: { type: 'string' } },
          note: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{ type: 'text', text: [value.note, ...value.lines].join('\n') }],
    },
    execute: async (args, exec) => {
      const sid = sessionIdOf(exec);
      const session = loadSession(sid);
      // 记下「当时的会话事件数」作为基准，注入时据此提醒状态是否太久没更新（见 renderState）
      const seq = loreTurnOf(sessionRefs.get(sid));
      const action = String(args.action ?? 'set');
      if (action === 'get') {
        const text = renderState(session.state, 0) || '（当前没有任何状态记录）';
        return { ok: true, action: 'get', lines: text.split('\n'), note: `状态读取（会话 ${session.sessionId}）` };
      }
      if (action !== 'set') throw new Error(`rp_state: 未知 action "${action}"（可用 set / get）`);

      const before = normalizeState(session.state);
      const patch = {};
      for (const f of STATE_FIELDS) if (args[f] !== undefined) patch[f] = args[f];
      if (args.party !== undefined) patch.party = args.party;
      if (args.party_mode !== undefined) patch.partyMode = args.party_mode;
      if (args.party_remove !== undefined) patch.partyRemove = args.party_remove;
      if (args.flags !== undefined) patch.flags = args.flags;
      if (!Object.keys(patch).length) {
        return { ok: true, action: 'set', lines: [], note: '没有传入任何字段，状态未改动' };
      }
      session.state = applyStateUpdates(before, patch, { seq });
      if (!saveSession(session)) throw new Error('rp_state: 写入会话配置失败');
      const text = renderState(session.state, 0);
      return {
        ok: true, action: 'set',
        lines: text ? text.split('\n').slice(1) : [],
        note: '状态已更新（每轮会自动注入你的上下文）',
      };
    },
  },

  // ---- 生成工具：世界书按需补读 ----
  {
    name: 'rp_lore',
    description: [
      '读取本会话世界书（`rp-sessions/<会话 id>/` 下的 `' + LORE_FILE_NAME + '`，按会话隔离）里的条目。',
      '世界书里**只有被本轮对话触发的条目**会自动进入你的上下文；这里用来：',
      '(1) 查看世界书有哪些条目（不传 query）；(2) 按关键词或标题取某条的完整内容。',
      '行为约束：**先看目录再按条取，不要整本倾倒** —— 世界书可能有几十条，全读会挤占上下文。',
      '当上下文里出现「以下条目本轮因预算未展开」时，用这里按标题把它们取出来即可。',
    ].join('\n'),
    parameters: {
      action: { type: 'string', description: '"find"（默认）按关键词/标题取条目；"list" 只列目录；"template" 在工作区生成一份带示例的世界书模板文件（已存在则不动）；"localize" 把整本的英文属性键换成中文（name→名称、gender: Female→性别：女）；"rename_unnamed" 把「条目 4」这类编号标题按触发词改成实义名' },
      query: { type: 'string', description: '关键词或标题片段；不传则列出全部条目的标题与触发词（目录）' },
      limit: { type: 'number', description: '最多返回几条第全文（默认 3，上限 10）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          file: { type: 'string', required: true },
          total: { type: 'number', required: true },
          lines: { type: 'array', required: true, items: { type: 'string' } },
          note: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{ type: 'text', text: [value.note, ...value.lines].join('\n') }],
    },
    execute: async (args, exec) => {
      const sessionId = sessionIdOf(exec);
      // 世界书按会话隔离（见 sessionLorePath 的注释：放在工作区根目录会让同工作区的会话互相串）
      const p = ensureSessionLore(sessionId);
      const dir = p?.dir ?? '';
      const file = p?.file ?? '';
      const action = String(args.action ?? 'find');

      // 生成模板：让 DM 一键拿到正确格式，不用用户手记
      if (action === 'template') {
        if (!p) return { ok: false, file, total: 0, lines: [], note: `读不到本会话工作区目录，无法写入 ${LORE_FILE_NAME}` };
        if (existsSync(file)) {
          return { ok: true, file, total: loadLoreEntries(sessionId).length, lines: [], note: `${LORE_FILE_NAME} 已存在，未改动（路径：${file}）` };
        }
        try {
          mkdirSync(dir, { recursive: true });
          writeFileSync(file, loreTemplateText(), 'utf8');
          loreCache.delete(sessionId);
          return { ok: true, file, total: 0, lines: [], note: `已生成世界书模板：${file}（把示例条目改成你的设定即可；只有被对话触发的条目才会进上下文）` };
        } catch (error) {
          return { ok: false, file, total: 0, lines: [], note: `写入模板失败：${error?.message ?? error}` };
        }
      }

      const entries = loadLoreEntries(sessionId);

      // 「属性中文化」/「重命名无名条目」：开局收尾要做的事（见 launch 文件），
      // 给 DM 一个**一次调用**做完的路子 —— 手改十几条标题既慢又容易漏。
      // 两者都复用 applyLoreEdit，与 HTTP 路由同一份实现。
      if (action === 'localize' || action === 'rename_unnamed') {
        if (!p || !existsSync(file)) {
          return { ok: true, file, total: entries.length, lines: [], note: `本会话还没有 ${LORE_FILE_NAME}，没什么可收拾的。` };
        }
        try {
          const editAction = action === 'localize' ? 'localize' : 'renameUnnamed';
          const r = applyLoreEdit(readFileSync(file, 'utf8'), editAction, {});
          if (!r.ok) return { ok: false, file, total: entries.length, lines: [], note: `处理失败：${r.error}` };
          writeFileAtomic(file, r.text);
          loreCache.delete(normalizeSessionId(sessionId));
          const after = parseLoreMarkdown(r.text);
          const lines = action === 'localize'
            ? (r.changed ? [`- 改了 ${r.changed} 条、共 ${r.lines} 行属性标签`] : [])
            : (r.renamed ?? []).map((row) => `- 「${row.from}」→「${row.to}」`);
          return {
            ok: true, file, total: after.length, lines,
            note: action === 'localize'
              ? (r.changed ? `已把 ${r.changed} 条、共 ${r.lines} 行英文属性键换成中文。` : '没有需要中文化的属性行。')
              : (lines.length ? `已重命名 ${lines.length} 条编号条目（按触发词起的名字）。` : '没有编号标题需要改。'),
          };
        } catch (error) {
          return { ok: false, file, total: entries.length, lines: [], note: `处理失败：${error?.message ?? error}` };
        }
      }

      if (!entries.length) {
        return {
          ok: true, file, total: 0, lines: [],
          note: p
            ? `世界书为空：本会话还没有 ${LORE_FILE_NAME}（路径 ${file}）。可以让 DM 调 rp_lore(action:"template") 生成一份模板。`
            : `读不到本会话工作区目录，无法定位 ${LORE_FILE_NAME}`,
        };
      }
      const query = String(args.query ?? '').trim();
      if (!query || action === 'list') {
        // 目录：标题 + 触发词 + 常驻标记，不含正文
        return {
          ok: true, file, total: entries.length,
          lines: entries.map((e) => `- ${e.title}${e.constant ? '（常驻）' : ''}${e.probability < 100 ? `（${e.probability}% 概率）` : ''}　触发词：${e.keys.join('、') || '（无）'}`),
          note: `世界书共 ${entries.length} 条（传 query 取某条的完整内容）：`,
        };
      }
      const limit = Math.max(1, Math.min(10, Math.trunc(Number(args.limit ?? 3)) || 3));
      const hit = entries.filter((e) => e.title.includes(query) || (e.keys ?? []).some((k) => k.includes(query) || query.includes(k)));
      const picked = hit.slice(0, limit);
      if (!picked.length) {
        return { ok: true, file, total: entries.length, lines: [], note: `没有匹配「${query}」的条目（共 ${entries.length} 条）` };
      }
      return {
        ok: true, file, total: entries.length,
        lines: picked.map((e) => `【${e.title}】\n${e.body}`),
        note: `匹配「${query}」：${hit.length} 条，返回前 ${picked.length} 条`,
      };
    },
  },

  // ---- 会话级设置（世界 / 宏表 / 前缀 / 战役名 / DM 设定）----
  {
    name: 'rp_session',
    description: [
      '查看或修改「当前会话」的 RP 设置（按会话隔离，互不影响）：世界设定、宏表、提示词前缀、战役名、DM 设定。',
      'DM 用它在开局录入世界观与基调；这些设置只作用于本会话（全局卡库配置用 rp_config）。',
      '',
      '注意：世界设定（world）是**常驻**注入的短总纲。设定一多就该改用**世界书**——',
      `世界书是本会话自己的 \`${LORE_FILE_NAME}\`（**按会话隔离**，精确路径见系统提示里的【世界书】一行），只有被对话触发的条目才进上下文（省大量 token）。`,
      '世界书格式（Markdown，每个 `##` 一个条目）：',
      '```',
      '# 我的跑团世界书（这一行是文件标题，不参与解析）',
      '',
      '## 条目名',
      '<!-- keys: 触发词1, 触发词2 | constant | order: 80 | prob: 100 -->',
      '条目正文。命中触发词时这段文字会被注入上下文。',
      '```',
      '- `keys` 不写就用标题当触发词；`constant` 表示常驻（不看关键词）；',
      '- `order` 越大越优先（预算不足时先保它）；`prob` 是触发概率（默认 100）；',
      '- 概率用确定性掷点（种子 = 会话+轮次+条目名），所以**同一轮的结果可精确复现**；',
      `- 用 read/write 工具直接维护这个文件即可；读条目用 rp_lore。`,
    ].join('\n'),
    parameters: {
      action: { type: 'string', required: true, description: '"get" 查看当前会话设置；"set" 修改（只改传入的字段）；"clear" 清空会话设置' },
      world: { type: 'string', description: '世界/战役设定文本（给 DM 当背景设定；更长的设定放世界书）' },
      macro_name: { type: 'string', description: '配合 macro_value：要设哪个宏（如 user / place）。名字须为小写字母开头的 [a-z0-9_]' },
      macro_value: { type: 'string', description: '配合 macro_name：该宏的值（世界设定/世界书里写 {{macro_name}} 会替换成它）' },
      prompt_prefix: { type: 'string', description: '本会话的全局提示词前缀（配图时作为画面描述的固定前缀，供 DM 参考）' },
      campaign_name: { type: 'string', description: '战役名（纯记录，方便识别）' },
      dm_prompt: { type: 'string', description: 'DM 自己的行为准则/主持规则（本会话；面板「DM 设定」里可见可改）。导入 DM 卡时会自动写入' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          sessionId: { type: 'string', required: true },
          lines: { type: 'array', required: true, items: { type: 'string' } },
          note: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{ type: 'text', text: [value.note, ...value.lines].join('\n') }],
    },
    execute: async (args, exec) => {
      const session = loadSession(sessionIdOf(exec));
      const sessionId = session.sessionId;
      const action = String(args.action ?? 'get');

      if (action === 'set') {
        if (args.world !== undefined) session.world = String(args.world);
        // 宏表：DM 问清玩家名字 / 地名之后可以自己设（值按会话保存，注入时由宿主变量替换）
        if (args.macro_name !== undefined) {
          const name = String(args.macro_name).trim().toLowerCase();
          if (!MACRO_NAME_RE.test(name)) {
            throw new Error(`rp_session: 宏名 "${args.macro_name}" 不合法（只允许小写字母开头 + 小写字母/数字/下划线）`);
          }
          session.macros = { ...(session.macros ?? {}), [name]: String(args.macro_value ?? '') };
          macroValueCache.set(sessionId, mergedMacros(loadStyles(), session.macros));
          refreshSessionMacros(sessionId, session.macros);
        }
        if (args.campaign_name !== undefined) session.campaign.name = String(args.campaign_name);
        if (args.prompt_prefix !== undefined) session.campaign.prompt_prefix = String(args.prompt_prefix);
        // DM 设定：与面板共用同一份会话配置（面板软刷新就能看到 Agent 改了什么）。
        // 只改传进来的那一个键，没传的保持原值 —— 否则 DM 改一次规则会把别的键清空。
        if (args.dm_prompt !== undefined) {
          session.dm = { ...(session.dm ?? {}), prompt: String(args.dm_prompt), migrated: [] };
        }
        saveSession(session);
      } else if (action === 'clear') {
        saveSession({
          sessionId: session.sessionId,
          preset: session.preset,
          campaign: { name: '', prompt_prefix: '' },
          characters: session.characters,
          world: '',
        });
        session.world = '';
        session.campaign = { name: '', prompt_prefix: '' };
      } else if (action !== 'get') {
        throw new Error(`rp_session: 未知 action "${action}"（可用 get / set / clear）`);
      }

      const lines = [
        `会话 ${session.sessionId}${session.preset ? `（预设 ${session.preset}）` : ''}`,
        `战役名：${session.campaign.name || '（未设）'}`,
        `提示词前缀：${session.campaign.prompt_prefix || '（未设）'}`,
        `DM 设定：${String(session.dm?.prompt ?? '').trim() ? `${String(session.dm.prompt).length} 字` : '（未设）'}`,
        `角色卡：${session.characters.length} 个${session.characters.length ? ` — ${session.characters.map((c) => c.name).join('、')}` : ''}`,
        `世界设定：${session.world ? `${session.world.slice(0, 120)}${session.world.length > 120 ? '…' : ''}` : '（未设）'}`,
        `本会话配置文件（可用 read/write 工具直接读写）：${sessionFile(session.sessionId)}`,
        `全局卡库配置：${RP_CONFIG_FILE}`,
        '配图请用宿主的 `generate_image`；出图后用 `rp_assets(action:"import", path:…)` 收进资源库。',
      ];
      return {
        ok: true,
        action,
        sessionId: session.sessionId,
        lines,
        note: action === 'set' ? '✅ 已更新本会话设置' : (action === 'clear' ? '🧹 已清空本会话设置（角色卡保留）' : '📋 当前会话设置'),
      };
    },
  },

  // ---- 资源库：浏览本会话已有的图，找到就复用，别重出 ----
  {
    name: 'rp_assets',
    description: [
      '浏览本会话的**图片资源库**：系统生图工具出的图、玩家导入的图都在里面，按分类分文件夹存着。',
      '为什么用它：**剧情回到同一个地方、同一个人再出场时，先把库里那张找出来重放** ——',
      '同一张图永远长得一样，也不必再花一次生图额度去重新生成。',
      '用法：',
      '- `action:"list"`（默认）按条件查：`kind` 选分类、`characters` 指定角色、`tags` 指定标签、`q` 关键词；',
      '- 返回的每一行都带 `id` 和**可直接放进 `dsh-ui` image 组件的地址**，选中哪张就把那个地址原样用上；',
      '- **`action:"import"`：把一张已经存在的图收进库里**（新图入馆的唯一途径）。',
      '  刚用宿主的 `generate_image` 出的图就传 `path`，值用该工具返回的 `savedTo`',
      '  （也可以只写工作区相对路径 `dsh-image-gen/image-01234567.png`，甚至只写文件名）；',
      '  只拿到 `Attachment ID` 就传 `attachment_id`。**导入时一定填 `label` 和 `tags`**，',
      '  否则以后搜不到；顺便用 `kind` / `characters` 分好类。',
      '- 事后发现某张图不好找，用 `action:"tag"` 补 label/tags；',
      '- 这个工具**不能删图**（删除是玩家在面板里做的事）。',
    ].join('\n'),
    parameters: {
      action: { type: 'string', description: '"list"（默认）查询；"get" 看单张详情（需 id）；"tag" 补 label/tags（需 id）；"import" 把一张已有的图收进库（需 path 或 attachment_id）' },
      kind: { type: 'string', description: 'list 用：分类过滤 —— portrait（角色）/ scene（场景）/ item（道具）/ other；import 用：这张图归哪一类（不传归 other）' },
      characters: { type: 'string', description: 'list 用：只看画面里有这些角色的图，逗号分隔（如「祁俊,祝婉宁」）；import 用：这张图里有谁（逗号分隔）' },
      tags: { type: 'string', description: 'list 用：按标签过滤，逗号分隔（要全部命中）；import 用：给新图打的检索标签' },
      q: { type: 'string', description: 'list 用：关键词，在名字/标签/提示词原文/角色名里做子串匹配' },
      limit: { type: 'number', description: `list 用：最多返回几条（默认 ${ASSET_LIST_DEFAULT_LIMIT}，上限 ${ASSET_LIST_MAX_LIMIT}）` },
      id: { type: 'string', description: 'get / tag 用：资源 id（list 返回里带）' },
      label: { type: 'string', description: 'tag / import 用：一个以后好找的短名字（如「雨夜客栈大堂」）' },
      path: { type: 'string', description: 'import 用：要收录的图片 —— 宿主生图工具返回的 `savedTo`，或工作区相对路径（如 dsh-image-gen/image-01234567.png）' },
      attachment_id: { type: 'string', description: 'import 用：宿主附件 id（形如 sha256:xxxx，生图工具返回里带）。只在没有 path（图没落盘）时用' },
      prompt: { type: 'string', description: 'import 用：这张图的画面描述原文（留着便于以后按内容模糊搜）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          total: { type: 'number', required: true },
          lines: { type: 'array', required: true, items: { type: 'string' } },
          note: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{ type: 'text', text: [value.note, ...value.lines].join('\n') }],
    },
    execute: async (args, exec) => {
      const sid = sessionIdOf(exec);
      const action = String(args.action ?? 'list');
      if (action === 'import') {
        // 系统生图工具（generate_image / edit_image）出的图不会自己进库 —— 这是它入馆的唯一入口。
        // 两条来源：`path`（工具返回的 savedTo，最直接）或 `attachment_id`（图没落盘时的兜底）。
        const rawPath = String(args.path ?? '').trim();
        const rawAttachment = String(args.attachment_id ?? '').trim();
        const workspace = resolveWorkspaceDir(sid);
        if (!rawPath && !rawAttachment) {
          // **别只说「需要 path」**：把最近生成的那几张列出来，带上可复制的相对路径，
          // 一次调用就能改对（「参数不合法只回一句『需要 id』」正是真机复测投诉过的那种错）。
          const recent = recentWorkspaceImages(workspace);
          throw new Error('rp_assets: action:"import" 需要 path 或 attachment_id。'
            + (recent.length
              ? `工作区 ${WORKSPACE_IMAGE_FOLDER}/ 里最近几张：${recent.join('、')} —— 把其中一个填进 path 即可。`
              : `工作区 ${WORKSPACE_IMAGE_FOLDER}/ 里暂时没有图（也接受绝对路径或文件名）。`
                + '宿主生图工具会返回 `savedTo`，把它填进 path；只拿到 Attachment ID 就填 attachment_id。'));
        }
        const read = await readImageForImport(sid, workspace, exec, { path: rawPath, attachmentId: rawAttachment });
        if (!read.ok) throw new Error(`rp_assets: 导入失败 —— ${read.error}`);
        const session = loadSession(sid);
        const label = String(args.label ?? '').trim()
          || String(args.prompt ?? '').trim().slice(0, ASSET_LABEL_MAX)
          || read.from;
        const entry = await archiveAsset(sid, {
          bytes: read.bytes,
          kind: args.kind ?? 'other',
          ext: read.ext,
          label,
          tags: args.tags,
          characters: args.characters !== undefined
            ? parseAssetTags(args.characters)
            : charactersInPrompt(session, args.prompt),
          source: 'imported',
          prompt: args.prompt,
        });
        if (!entry) throw new Error('rp_assets: 导入失败 —— 图片没能写进资源库（检查会话工作区是否可写）');
        return {
          ok: true, action, total: 1, lines: [assetLine(sid, entry)],
          note: `${entry.deduped ? '这张图库里已经有了（字节完全相同），已补上标签' : '已收进资源库'}`
            + `：来源 ${read.from}｜id=${entry.id}（${ASSET_KIND_LABEL[assetKindOf(entry.kind)]}）`
            + '｜以后用 `action:"list"` 按 label/tags 就能找回来。',
        };
      }
      if (action === 'tag') {
        const id = String(args.id ?? '').trim();
        if (!id) throw new Error('rp_assets: action:"tag" 需要 id（先 list 拿到）');
        const found = await withAssetLock(sid, () => {
          const index = loadAssets(sid);
          const asset = index.assets.find((a) => a.id === id);
          if (!asset) return null;
          if (args.label !== undefined) asset.label = String(args.label).trim().slice(0, ASSET_LABEL_MAX);
          if (args.tags !== undefined) asset.tags = parseAssetTags(args.tags);
          return saveAssets(sid, index) ? asset : null;
        });
        if (!found) throw new Error(`rp_assets: 没有 id=${id} 这条资源 —— 先 action:"list" 看现有的 id`);
        return {
          ok: true, action, total: 1, lines: [assetLine(sid, found)],
          note: `已更新：「${found.label || found.id}」标签 ${(found.tags ?? []).length} 个`,
        };
      }
      const { total, counts, assets } = queryAssets(sid, args);
      const lines = assets.map((a) => assetLine(sid, a));
      const head = `资源库共 ${total} 张（角色 ${counts.portrait}、场景 ${counts.scene}、道具 ${counts.item}、其他 ${counts.other}）`;
      if (action === 'get') {
        // **两种失败要分清**（真机复测 RETEST-03）：传了个不存在的 id，却回「需要 id」——
        // 调用方明明传了，只能怀疑是自己没传对，实际是 id 不存在。
        // 查也直接查**全量索引**：以前先在这页（默认只取 20 条）里找、再回退全量，纯属绕路。
        const want = String(args.id ?? '').trim();
        if (!want) throw new Error('rp_assets: action:"get" 需要 id —— 先 action:"list" 看现有的 id');
        const one = loadAssets(sid).assets.find((a) => a.id === want);
        if (!one) {
          const all = loadAssets(sid).assets;
          throw new Error(`rp_assets: 没有 id=${want} 这条资源（本会话共 ${all.length} 张：`
            + `${all.slice(0, 8).map((a) => `${a.id}=${a.label || a.kind}`).join('、') || '（空）'}${all.length > 8 ? '…' : ''}）`);
        }
        return {
          ok: true, action, total: 1,
          lines: [assetLine(sid, one), one.prompt ? `提示词原文：${one.prompt}` : '', `存入时间：${one.at}`].filter(Boolean),
          note: head,
        };
      }
      return {
        ok: true, action: 'list', total, lines,
        note: lines.length
          ? `${head}；下面 ${lines.length} 条，**选中哪张就把它的地址原样放进 \`dsh-ui\` 的 image 组件**（已展示过的图不必重出）`
          : `${head}；没有符合条件的图。要新图就用 \`generate_image\` 生，然后 action:"import" 收进来，`
            + '**记得填 label 与 tags** 方便以后找回来（也可以让玩家从面板直接导入）。',
      };
    },
  },

  // ---- 全局配置（卡库根目录 / 默认宏列表）----
  {
    name: 'rp_config',
    description: [
      '查看或修改「全局」卡库配置（所有会话共用）：PNG 故事书卡库的根目录、以及导入卡时预填的默认宏列表。',
      '会话级内容（角色卡 / 世界设定 / 提示词前缀 / DM 设定）用 rp_session。',
      '',
      '**本插件不做配图** —— 需要插图时请直接用宿主自带的 `generate_image`（改图用 `edit_image`），',
      '生成的图会作为附件显示在对话里。想把那张图收进本会话的资源库以便复用，',
      '用 `rp_assets(action:"import", path:"<generate_image 返回的 savedTo>", label:"…", tags:"…")`。',
    ].join('\n'),
    parameters: {
      action: { type: 'string', required: true, description: '"get" 查看；"set" 修改（只改传入字段）；"set_global_tools" 单独设「放行给 DM 会话的全局工具」' },
      cards_root: { type: 'string', description: '卡库根目录（PNG 故事书 / 角色卡从哪扫）。空串 = 用会话工作区下的 rp-cards/；相对路径按会话工作区解析' },
      macro_name: { type: 'string', description: '配合 macro_value：要设哪条默认宏（如 user / place）。名字须为小写字母开头的 [a-z0-9_]' },
      macro_value: { type: 'string', description: '配合 macro_name：该宏的默认值（导入的卡里写 {{macro_name}} 时用它预填；空串 = 删掉这条）' },
      global_tools: {
        type: 'string',
        description: '配合 action:"set_global_tools"：DM 会话要放行哪些**第三方/宿主全局工具**，逗号分隔。'
          + '**这是一份完整名单**（不是增量）：没列进来的全局工具 DM 都看不见。'
          + '出厂默认全勾 `render_ui,validate_dsh_ui,web_search,generate_image,edit_image`'
          + '（GenUI 卡片渲染 / 围栏自检 / 联网考据 / 宿主的生图改图）。'
          + '传空串 = 一个都不放行（DM 连卡片都渲染不了，慎用）。'
          + '**改完要新开或重进 DM 会话才生效**（过滤在挂载时读）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          lines: { type: 'array', required: true, items: { type: 'string' } },
          note: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{ type: 'text', text: [value.note, ...value.lines].join('\n') }],
    },
    execute: async (args) => {
      let cfg = loadStyles();
      const action = String(args.action ?? 'get');
      if (action === 'set') {
        const patch = {};
        if (args.cards_root !== undefined) patch.root = String(args.cards_root);
        if (args.macro_name !== undefined) {
          const name = String(args.macro_name).trim().toLowerCase();
          if (!MACRO_NAME_RE.test(name)) {
            throw new Error(`rp_config: 宏名 "${args.macro_name}" 不合法（只允许小写字母开头 + 小写字母/数字/下划线）`);
          }
          // 与设置页同一套规则：只收合法名字 + 非空值，空值等于删掉这条
          patch.macros = { ...globalMacros(cfg) };
          const value = String(args.macro_value ?? '').trim();
          if (value) patch.macros[name] = value; else delete patch.macros[name];
        }
        if (Object.keys(patch).length) {
          // ⚠️ `applyCardConfigPatch` 返回的是 **cards 那一层**，必须包回 `cards` 键下 ——
          // 写成 `cfg = applyCardConfigPatch(cfg, patch)` 会把 `cards` 这层壳整个丢掉，
          // 盘上变成 `{root,userLabel,macros,macrosSeeded}`，`loadStyles()` 下次认不出来
          // 就退回出厂默认（用户的默认宏列表/卡库目录**静默丢失**），而工具还回「✅ 已更新」。
          cfg = { ...cfg, cards: applyCardConfigPatch(cfg, patch) };
          saveStyles(cfg);
        }
      } else if (action === 'set_global_tools') {
        // 单独一个 action（而不是塞进 set）：它改的是**预设过滤器**要读的那份配置，
        // 语义与「卡库配置」不同，混在一起容易误改。
        cfg.globalToolsAllow = normalizeGlobalToolsAllow(String(args.global_tools ?? '').split(/[,，、;；\s]+/));
        saveStyles(cfg);
      } else if (action !== 'get') {
        throw new Error(`rp_config: 未知 action "${action}"（可用 get / set / set_global_tools）`);
      }
      const macros = globalMacros(cfg);
      const toolView = globalToolsAllowView(cfg);
      const available = listGlobalToolNames();
      return {
        ok: true,
        action,
        note: action === 'set' ? '✅ 已更新全局卡库配置'
          : (action === 'set_global_tools' ? '✅ 已更新「放行给 DM 会话的全局工具」（**新开/重进 DM 会话才生效**）' : '⚙️ 当前全局卡库配置'),
        lines: [
          `卡库根目录：${cfg.cards?.root || '（未设）—— 用会话工作区下的 rp-cards/'}`,
          `默认宏（${Object.keys(macros).length} 条）：${Object.entries(macros).map(([k, v]) => `${k} → ${v}`).join('、') || '（无）'}`,
          `放行给 DM 会话的全局工具（${toolView.allow.length} 个）：${toolView.allow.join(' / ') || '（一个都没有 —— DM 看不见任何全局工具，包括 GenUI 卡片渲染）'}`,
          available === null
            ? '（本机全局工具清单：读不到注册表，无法核对名字是否正确）'
            : `本机实际存在的全局工具：${available.join('、')}`,
          `出厂默认（设置页「恢复默认」用的就是它）：${toolView.defaults.join(' / ')}`,
          `配置文件（可用 read/write 工具直接改）：${RP_CONFIG_FILE}`,
          '配图请用宿主的 `generate_image`；出图后用 `rp_assets(action:"import", path:…)` 收进资源库。',
        ],
      };
    },
  },

  // ---- RP 表格工具：随机表（遭遇/掉落/情绪/天气…）----
  {
    name: 'rp_table',
    description: 'RP 随机表工具（按会话保存）：定义表格（表名 + 骰式 + 条目），需要时掷表。经典跑团用法：遭遇表 d20、掉落表 2d6、情绪表 1d8。不写骰式时默认 1dN（N=条目数）。',
    parameters: {
      action: { type: 'string', required: true, description: '"list" 列出本会话所有表；"set" 新建或覆盖一个表（需 name 与 entries）；"remove" 删除一个表（需 name）；"roll" 掷表（需 name，或 table 别名）' },
      name: { type: 'string', description: '表名，如「地下城遭遇表」' },
      dice: { type: 'string', description: '骰式，如 "1d20"、"2d6+1"；不写则默认 1dN（N=条目数）' },
      entries: { type: 'array', items: { type: 'string' }, description: '条目列表（按顺序对应点数；点数超出条目数时取模）' },
      count: { type: 'number', description: `roll 时掷几次（1..${ROLL_COUNT_MAX}，默认 1）；越界会**报错**而不是悄悄少掷几次` },
      seed: { type: 'string', description: 'roll 的随机种子（给定则结果可复现）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          lines: { type: 'array', required: true, items: { type: 'string' } },
          note: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{ type: 'text', text: [value.note, ...value.lines].join('\n') }],
    },
    execute: async (args, exec) => {
      const session = loadSession(sessionIdOf(exec));
      // ⚠️ 必须是 `let`：`remove` 分支会换成 filter 出来的**新数组**。写成 `const` 时，
      // 下面的回显仍然读旧数组 —— 真机复测抓到过：响应说「已删除表格」，紧接着又列出刚删掉的那张
      // （RETEST-01）。删除逻辑一直是对的，错的是回显。
      let tables = Array.isArray(session.tables) ? session.tables : [];
      const action = String(args.action ?? 'list');
      const find = (n) => tables.find((t) => String(t.name) === String(n ?? ''));

      if (action === 'set') {
        const name = String(args.name ?? '').trim();
        if (!name) throw new Error('rp_table: action "set" 需要 name');
        const entries = Array.isArray(args.entries) ? args.entries.map((e) => String(e)).filter((e) => e.trim()) : [];
        if (entries.length === 0) throw new Error('rp_table: action "set" 需要非空 entries');
        const dice = String(args.dice ?? `1d${entries.length}`);
        const idx = tables.findIndex((t) => String(t.name) === name);
        const table = { name, dice, entries };
        if (idx >= 0) tables[idx] = table; else tables.push(table);
        session.tables = tables;
        saveSession(session);
      } else if (action === 'remove') {
        const name = String(args.name ?? '').trim();
        const table = find(name);
        // 删一张不存在的表**不能报「已删除」** —— 那和 DELETE 一个不存在的 key 还回 204 一样，
        // 模型会以为删掉了。与 `roll` 保持一致：报错并列出实际有哪些。
        if (!table) {
          throw new Error(`rp_table: 没有名为 "${name}" 的表 —— 本会话现有：${tables.map((t) => t.name).join('、') || '（无）'}`);
        }
        tables = tables.filter((t) => String(t.name) !== name);
        session.tables = tables;
        saveSession(session);
      } else if (action === 'roll') {
        const table = find(args.name);
        if (!table) {
          throw new Error(`rp_table: 没有名为 "${args.name ?? ''}" 的表 —— 本会话现有：${tables.map((t) => t.name).join('、') || '（无）'}`);
        }
        const parsed = parseDice(table.dice);
        const rnd = makeRng(args.seed);
        const times = resolveRollCount(args.count);
        const out = [];
        for (let i = 0; i < times; i++) {
          const { sum, detail } = rollDice(parsed, rnd);
          const entry = table.entries[(sum - 1) % table.entries.length] ?? table.entries[0];
          out.push(`${table.dice} → ${sum}（${detail}）→ ${entry}`);
        }
        return {
          ok: true,
          action,
          note: `🎲 ${table.name}（${table.dice}，${table.entries.length} 条）`,
          lines: out,
        };
      } else if (action !== 'list') {
        throw new Error(`rp_table: 未知 action "${action}"（可用 list / set / remove / roll）`);
      }

      return {
        ok: true,
        action,
        // 删掉的表名写进 note：以前只写「已删除表格」，而 lines 又是旧列表，两处叠起来看不出删了哪张
        note: action === 'set' ? '✅ 已保存表格'
          : (action === 'remove' ? `🗑 已删除表格：${String(args.name ?? '').trim()}`
            : `📋 本会话随机表（${tables.length}）`),
        lines: tables.length
          ? tables.map((t) => `${t.name}｜${t.dice}｜${t.entries.length} 条：${t.entries.slice(0, 6).join(' / ')}${t.entries.length > 6 ? ' …' : ''}`)
          : ['（尚无表格。用 rp_table action=set 建一个，例如：name「地下城遭遇表」entries [「狗头人巡逻队」「陷阱」…]）'],
      };
    },
  },
];

/**
 * 场景对象 / 分镜对象的 id，按**约定字段优先 + 常见别名兜底**取。
 *
 * 为什么兜底：`scene_id` 是 `scenes_*.json` 的约定字段，但模型手写场景文件时常写成 `id` / `sceneId`。
 * 以前只认 `scene_id`，于是 a) 按 `sceneId` 筛选会静默返回 0/0（RETEST-02），
 * b) 归档进资源库的标签退化成 `… · ?`（索引里的问号永远留着，以后认不出是哪一幕）。
 * 筛选仍以**主字段**为准（否则「`id` 撞车」会变得不可预测），这里只负责生成标签与报错信息。
 */
function sceneIdOf(scene) {
  if (!scene || typeof scene !== 'object') return '?';
  for (const k of ['scene_id', 'sceneId', 'id', 'title']) {
    const v = String(scene[k] ?? '').trim();
    if (v) return v;
  }
  return '?';
}

/** 分镜 id 的同一套兜底（`panel_id` 是约定字段）。 */
function panelIdOf(panel) {
  if (!panel || typeof panel !== 'object') return '';
  for (const k of ['panel_id', 'panelId', 'id']) {
    const v = String(panel[k] ?? '').trim();
    if (v) return v;
  }
  return '';
}

// ===================================================================
// PNG 故事书（角色卡）导入
// -------------------------------------------------------------------
// 本地卡库是 3269 张 SillyTavern PNG 卡（实测见 docs/PNG-CARD-DECODE.md）。
// 这里做三件事，全部由浏览器半侧的同源路由驱动：
//   ① 列卡库（服务端过滤/分页，避免把 480KB 索引整个丢给浏览器）；
//   ② 解析单张卡（读 PNG 文本块 → 卡 JSON → 映射成本插件的会话配置）；
//   ③ 落到会话：世界书写进工作区 `rp-worldbook.md`（**追加合并，不覆盖**），
//      卡全文写 `rp-cards/<slug>.md`，卡面复制一份当立绘，角色/世界写进会话配置。
//
// 为什么解析在宿主而不是浏览器：卡 JSON 动辄几十万字，且要写工作区文件；
// 浏览器只需要拿到摘要与预览字符串。
// ===================================================================

/** 卡库默认放在会话工作区下的这个子目录（cards.root 留空时用它）。 */
const CARD_LIBRARY_DIR = 'rp-cards';

/** 导入到工作区的子目录名。 */
const CARD_IMPORT_DIR = 'cards';
// 注：1.13.0 起「导入外部图」统一走资源库（`assets/<分类>/<id>.<ext>`，见下面的 ASSET_* 常量）。
// 早期那两个只服务立绘的常量（`PORTRAIT_DIR` 目录名、`portraitFileSlug` 角色名→文件名）连同
// 逻辑一起删掉了 —— 留着会让人误以为路径里还会出现用户给的名字，而实际上**路径里永远只有
// 宿主生成的 id**，那是这里唯一的安全边界。

// ── 资源库：本会话产生/导入的图都留档，DM 可以按条件找回来复用 ─────────────
// 为什么要有它：以前**只有立绘**会留档，场景图/群像图/道具图/整幕多格出完就只在当轮消息里，
// 下一轮宿主侧没有索引 —— 想让「雨夜客栈」再出现一次只能重新抽卡。
//
// 存放形状（用户要求「按场景、角色、道具等分内部文件夹」——kind 同时也是目录名）：
//   <工作区>/rp-sessions/<会话 id>/assets.json          索引（一张图一条）
//   <工作区>/rp-sessions/<会话 id>/assets/portraits/<id>.png
//   <工作区>/rp-sessions/<会话 id>/assets/scenes/<id>.png
//   <工作区>/rp-sessions/<会话 id>/assets/items/<id>.png
//   <工作区>/rp-sessions/<会话 id>/assets/other/<id>.png
//
// 为什么**真存一份**而不是只记 ComfyUI 的三要素引用：ComfyUI 的 output/ 会被清理，
// 引用式过一阵子就是一堆死链（一张都打不开，但索引里还在）。代价是每张 300~600KB。
// （常量与 `assetKindOf` 在 `rpTools` 之前声明 —— 见那里的说明。）

/**
 * 解析标签：接受数组或「逗号/顿号/空格分隔的字符串」。
 *
 * 为什么参数不直接用数组：模型给标签时更常写成 `"客栈, 雨夜, 室内"` 这种字符串，
 * 强行要数组会频繁触发参数校验失败（整次调用白费）。
 */
function parseAssetTags(raw) {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[,，、;；\s]+/);
  const out = [];
  for (const item of list) {
    const tag = String(item ?? '').trim().slice(0, 24);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= ASSET_TAGS_MAX) break;
  }
  return out;
}

/** 资源 id：既是索引主键也是文件名（路径里永不出现用户/模型给的字符串）。 */
function newAssetId() {
  return randomBytes(5).toString('hex');
}

/** 资源在会话目录里的相对路径：`assets/<分类目录>/<id>.<ext>`。 */
function assetRelPath(kind, id, ext) {
  return `${ASSET_DIR}/${ASSET_KIND_DIR[assetKindOf(kind)]}/${id}.${ext}`;
}

/** 资源发给浏览器的同源地址。按 `id` 取 —— 「重导同名」不会再撞缓存，不需要 `v=` 补丁。 */
function assetUrl(sessionId, id) {
  return `/rp-tools/asset-image?sessionId=${encodeURIComponent(String(sessionId ?? ''))}&id=${encodeURIComponent(String(id ?? ''))}`;
}

/** 演示/展示用地址（DM 把它放进 `dsh-ui` 的 image 组件）。 */
function assetPreviewUrl(sessionId, id, width = 640) {
  return `${assetUrl(sessionId, id)}&thumb=1&width=${Math.max(48, Math.min(1024, Math.trunc(width) || 640))}`;
}

/** 资源索引路径（和世界书同目录：`rp-sessions/<id>/`）。 */
function assetIndexPath(sessionId, hint) {
  const p = sessionLorePath(sessionId, hint);
  if (!p) return null;
  return { id: p.id, dir: p.dir, file: join(p.dir, ASSET_INDEX_FILE), root: join(p.dir, ASSET_DIR) };
}

/** 读索引。坏文件一律当空库（不抛）—— 索引丢了不该让出图/面板整个失败。 */
function loadAssets(sessionId, hint) {
  const p = assetIndexPath(sessionId, hint);
  if (!p) return { version: 1, assets: [] };
  try {
    const raw = JSON.parse(readFileSync(p.file, 'utf8'));
    const assets = (Array.isArray(raw?.assets) ? raw.assets : [])
      .filter((a) => a && typeof a === 'object' && a.id && a.file);
    return { version: 1, assets };
  } catch { return { version: 1, assets: [] }; }
}

function saveAssets(sessionId, index, hint) {
  const p = assetIndexPath(sessionId, hint);
  if (!p) return false;
  try {
    mkdirSync(p.dir, { recursive: true });
    writeFileAtomic(p.file, `${JSON.stringify({ version: 1, assets: index.assets }, null, 1)}\n`);
    return true;
  } catch { return false; }
}

/**
 * 每个会话一把**写队列**。
 *
 * 为什么必须有：资源库的写入口可能并发（面板导入、模型用 `rp_assets(action:"import")` 收图），
 * 而索引是 read-modify-write —— 几个调用同时「读索引 → 加一条 → 写回」会互相覆盖，丢记录，
 * 而且丢了不报错（表现是「导了 5 张图，库里只有 2 张」）。所有写索引的路径都必须过这里。
 *
 * JS 单线程，所以 Map 本身没有竞态；要串的只是「读—改—写」这三步之间被 await 打断。
 */
const assetWriteChains = new Map();
function withAssetLock(sessionId, fn) {
  const id = normalizeSessionId(sessionId);
  const prev = assetWriteChains.get(id) ?? Promise.resolve();
  // 前一个失败也要继续（不能因为一次写盘失败把后面所有出图都卡死）
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  assetWriteChains.set(id, tail);
  tail.then(() => { if (assetWriteChains.get(id) === tail) assetWriteChains.delete(id); });
  return run;
}

/**
 * 找出库里**字节完全相同**的同分类资源（内容去重的核心判断）。
 *
 * 为什么需要去重：本地出图是「同 seed + 同提示词 → 同一张图」，DM 重新出一张一模一样的、
 * 或者复测里把同一格生成两次，库里就会出现两条 md5 相同、只有 id 和标签不同的记录 ——
 * 图墙里看着是两张，实际占两份磁盘，而且人分不出区别（真机复测里那两张场景图就是这样）。
 *
 * 只在**字节数相同**的候选上算哈希：老条目没记 `sha256`（1.13.0/1.13.1 写下的），
 * 但对它们也只在这一小撮候选上补算一次，不会把整个库读一遍。
 */
/**
 * 按**内容**在索引里找同一张图（跨分类）。老条目没有 `sha256`，就按字节数先筛、再实读文件核对。
 *
 * 为什么要跨分类查：同一张图可能被先当 `scene` 收一次、再被 `rp_assets(action:"import", kind:"item")`
 * 收一次 —— 按 kind 查重会存成两份重复文件。字节相同就是同一张图，与调用方这次填的 kind 无关。
 *
 * @returns 命中的索引条目（并顺手补上它缺的 `sha256`），没有则 null
 */
function findAssetByBytes(sessionId, index, sha256, bytes) {
  const p = assetIndexPath(sessionId);
  if (!p) return null;
  // 从新到旧找：最近导的那张最可能是重复项
  const candidates = index.assets.slice().reverse();
  for (const candidate of candidates) {
    if (candidate.sha256) {
      if (candidate.sha256 === sha256) return candidate;
      continue;
    }
    if (Number(candidate.bytes) !== bytes.length) continue;
    try {
      const abs = join(p.dir, String(candidate.file));
      if (!abs.startsWith(p.dir + sep) || !existsSync(abs)) continue;
      const oldHash = createHash('sha256').update(readFileSync(abs)).digest('hex');
      if (oldHash === sha256) { candidate.sha256 = oldHash; return candidate; }
    } catch { /* 读不到就当不是同一张 */ }
  }
  return null;
}

function findDuplicateAsset(sessionId, index, kind, bytes, sha256) {
  const same = index.assets.filter((a) => assetKindOf(a.kind) === kind && Number(a.bytes) === bytes.length);
  if (!same.length) return null;
  const p = assetIndexPath(sessionId);
  if (!p) return null;
  for (const candidate of same) {
    if (candidate.sha256) {
      if (candidate.sha256 === sha256) return candidate;
      continue;
    }
    try {
      const abs = join(p.dir, String(candidate.file));
      if (!abs.startsWith(p.dir + sep) || !existsSync(abs)) continue;
      const oldHash = createHash('sha256').update(readFileSync(abs)).digest('hex');
      if (oldHash === sha256) { candidate.sha256 = oldHash; return candidate; }
    } catch { /* 读不到就当不是同一张 */ }
  }
  return null;
}

/**
 * `dsh-image-gen` 把生成的图落在**会话工作区**下的这个目录里（该插件的 `workspaceFolder` 出厂值）。
 * 只用于「找不到就给个提示」这条路径 —— 导入本身不依赖它（路径由调用方给）。
 */
const WORKSPACE_IMAGE_FOLDER = 'dsh-image-gen';

/**
 * 「最近生成的那几张」候选：**工作区相对路径**，按 mtime 倒序。
 *
 * 只在 `action:"import"` 没给 path / attachment_id 时用来报错，让调用方一眼看到该怎么传、
 * 直接把其中一个路径复制进来。任何一步失败都当「没有候选」（这只是提示，不该让导入本身失败）。
 */
function recentWorkspaceImages(workspace, limit = 6) {
  const root = String(workspace ?? '').trim();
  if (!root) return [];
  try {
    const dir = join(root, WORKSPACE_IMAGE_FOLDER);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((n) => /\.(png|jpe?g|webp)$/i.test(n))
      .map((n) => {
        let at = 0;
        try { at = statSync(join(dir, n)).mtimeMs; } catch { /* 拿不到时间就排最后 */ }
        return { rel: `${WORKSPACE_IMAGE_FOLDER}/${n}`, at };
      })
      .sort((a, b) => b.at - a.at)
      .slice(0, Math.max(1, limit))
      .map((c) => c.rel);
  } catch { return []; }
}

/**
 * `realpathSync` 的「失败就给 null」版本。
 *
 * 用来做**顺着符号链接的越界判定**（见 `readImageForImport`）：Windows 上工作区常是 junction，
 * 而宿主给的 `savedTo` 是 realpath 之后的结果；只比字符串会把合法路径判成越界。
 * 路径不存在 / 无权限时返回 null，调用方退回字符串比对（宁可放行也不误杀合法导入）。
 */
function realpathOrNull(p) {
  try { return realpathSync(String(p)); } catch { return null; }
}

/**
 * 把外部文件（工作区里的）或宿主附件读成字节，供 `rp_assets action:"import"` 归档。
 *
 * 两条来源，优先工作区路径 —— 宿主生图工具会把图写到工作区，返回里的 `savedTo` 就是它：
 *   ① `path`：绝对路径，或工作区相对路径（如 `dsh-image-gen/image-01234567.png`），
 *      或干脆只给文件名（会再在 `dsh-image-gen/` 下找一次）；
 *   ② `attachment_id`：宿主附件 id（`sha256:<hex>`），生图工具返回里带 ——
 *      适合「图没落盘（saveToWorkspace 关了）但还挂在对话里」的情况。
 *
 * 安全边界与面板导入一致：**只读**、只认会话工作区内的 png/jpeg/webp、上限 `ASSET_MAX_BYTES`。
 * 不写源文件、不删源文件；归档出来的是资源库自己的一份副本（这也是它比引用路径可靠的地方）。
 *
 * @returns {{ok: true, bytes: Buffer, ext: string, from: string}|{ok: false, error: string}}
 */
async function readImageForImport(sessionId, workspace, exec, { path: rawPath, attachmentId: rawAttachmentId } = {}) {
  const wantPath = String(rawPath ?? '').trim();
  const wantAttachment = String(rawAttachmentId ?? '').trim();

  if (wantPath) {
    if (!workspace) return { ok: false, error: '拿不到本会话的工作区目录（先在宿主里打开这个会话，或改用 attachment_id）' };
    // 越界校验对**解析后的绝对路径**做（不是对入参字符串）—— 两处候选都在同一个工作区内，安全性不变。
    const candidates = [resolve(workspace, wantPath)];
    const inImageFolder = resolve(join(workspace, WORKSPACE_IMAGE_FOLDER), wantPath);
    if (inImageFolder !== candidates[0]) candidates.push(inImageFolder);
    const abs = candidates.find((p) => existsSync(p));
    if (!abs) {
      const tried = candidates.map((p) => p.slice(workspace.length + 1).split(sep).join('/')).join(' 与 ');
      return { ok: false, error: `工作区里没有这个文件：${wantPath}（找过 ${tried}）` };
    }
    // ⚠️ 越界判定要**顺着符号链接看真实路径**，不能只比字符串：
    // 宿主那边（`dsh-image-gen` 的 `saveImageToWorkspace`）是先 `realpath(workspaceRoot)` 再判包含关系的，
    // 所以它给的 `savedTo` 是**真实路径**。如果 workspace 本身是个 junction / symlink（Windows 上很常见，
    // 把工作区挂到别的盘），字符串比对会把一份**完全合法**的图判成越界，用户只会看到「导入失败」。
    // 两边都 realpath 之后前缀比对才有意义；realpath 失败（路径已被删）就退回字符串比对。
    const realWorkspace = realpathOrNull(workspace);
    const realAbs = realpathOrNull(abs);
    const inside = realWorkspace && realAbs
      ? (realAbs === realWorkspace || realAbs.startsWith(realWorkspace + sep))
      : (abs === workspace || abs.startsWith(workspace + sep));
    if (!inside) return { ok: false, error: `path 越出了本会话工作区：${wantPath}` };
    if (!/\.(png|jpe?g|webp)$/i.test(abs)) return { ok: false, error: `只认 png / jpeg / webp：${wantPath}` };
    let size = 0;
    try { size = statSync(abs).size; } catch { /* 下面读失败会报 */ }
    if (size > ASSET_MAX_BYTES) return { ok: false, error: `图太大（${Math.round(size / 1048576)}MB，上限 ${Math.round(ASSET_MAX_BYTES / 1048576)}MB）` };
    try {
      const bytes = readFileSync(abs);
      if (!bytes.length) return { ok: false, error: `文件是空的：${wantPath}` };
      const ext = (/\.png$/i.test(abs) ? 'png' : (/\.webp$/i.test(abs) ? 'webp' : 'jpg'));
      return { ok: true, bytes, ext, from: `工作区 ${abs.slice(workspace.length + 1).split(sep).join('/')}` };
    } catch (error) {
      return { ok: false, error: `读文件失败：${String(error?.message ?? error)}` };
    }
  }

  if (!wantAttachment) return { ok: false, error: '需要 path 或 attachment_id' };

  // 附件：走宿主附件服务（工具执行上下文里有 agent.ctx）。拿不到服务就如实说清楚，别猜。
  const store = exec?.agent?.ctx?.get?.('attachments');
  if (!store || typeof store.readImage !== 'function') {
    return { ok: false, error: '本会话取不到宿主的附件服务（attachments）—— 请改用 path 指向工作区里的文件' };
  }
  // 媒体类型要**声明对**才读得出来（`readImage` 按它校验字节），而附件 id 里没有格式信息，
  // 所以三种都试一遍；全失败时如实报错，不会静默拿错字节。
  const errors = [];
  for (const mediaType of ['image/png', 'image/jpeg', 'image/webp']) {
    try {
      const stored = await store.readImage({ attachmentId: wantAttachment, mediaType });
      const bytes = Buffer.from(stored?.data ?? []);
      if (!bytes.length) { errors.push(`${mediaType}: 空`); continue; }
      if (bytes.length > ASSET_MAX_BYTES) {
        return { ok: false, error: `图太大（${Math.round(bytes.length / 1048576)}MB，上限 ${Math.round(ASSET_MAX_BYTES / 1048576)}MB）` };
      }
      const ref = String(stored?.ref?.mediaType ?? mediaType);
      const ext = ref === 'image/jpeg' ? 'jpg' : (ref === 'image/webp' ? 'webp' : 'png');
      return { ok: true, bytes, ext, from: `附件 ${wantAttachment}` };
    } catch (error) {
      errors.push(`${mediaType}: ${String(error?.message ?? error)}`);
    }
  }
  return { ok: false, error: `读附件失败 —— ${errors.join('；')}` };
}

/**
 * 把一张图的字节收进资源库（写盘 + 追加索引）。
 *
 * @param bytes {Buffer}
 * @param ext   文件扩展名（`png` / `jpg` / `webp`）
 * @returns 索引里那条记录；写不进去返回 null（**不影响这次出图本身**）
 */
async function archiveAsset(sessionId, meta) {
  const bytes = meta?.bytes;
  if (!Buffer.isBuffer(bytes) || !bytes.length) return null;
  const id = String(meta.id ?? '').trim() || newAssetId();
  const kind = assetKindOf(meta.kind);
  const ext = String(meta.ext ?? 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return withAssetLock(sessionId, () => {
    const p = assetIndexPath(sessionId);
    if (!p) return null;
    const index = loadAssets(sessionId);
    // **去重必须在锁里做**：并发归档同一张图时，两个调用都在锁外查重就会双双通过、各写一份。
    // 先按**内容**查（同一份字节就是同一张图，与调用方这次报的 kind 无关 —— 否则同一张图
    // 先当 scene 收一次、再当 other 收一次会存成两份）；内容没命中再退回「同 kind 同长度」的老查法。
    const dup = findAssetByBytes(sessionId, index, sha256, bytes)
      ?? findDuplicateAsset(sessionId, index, kind, bytes, sha256);
    if (dup) {
      // 复用已有那条：补上它缺的标签 / 名字 / hash / 分类，不写新文件
      let changed = false;
      for (const tag of parseAssetTags(meta.tags)) {
        if (!(dup.tags ?? []).includes(tag)) { dup.tags = [...(dup.tags ?? []), tag]; changed = true; }
      }
      if (!dup.label && meta.label) { dup.label = String(meta.label).trim().slice(0, ASSET_LABEL_MAX); changed = true; }
      if (!dup.sha256) { dup.sha256 = sha256; changed = true; }
      // 调用方这次明确报了分类（且原来只是兜底的 `other`）→ 顺手纠正，别让图一直待在「其他」里
      if (meta.kind !== undefined && assetKindOf(dup.kind) === 'other' && kind !== 'other') {
        dup.kind = kind; changed = true;
      }
      if (changed) saveAssets(sessionId, index);
      return { ...dup, deduped: true };
    }
    const rel = assetRelPath(kind, id, ext);
    const abs = join(p.dir, rel);
    try {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, bytes);
    } catch { return null; }
    const entry = {
      id,
      kind,
      file: rel,
      bytes: bytes.length,
      sha256,
      width: Number(meta.width) || 0,
      height: Number(meta.height) || 0,
      label: String(meta.label ?? '').trim().slice(0, ASSET_LABEL_MAX),
      tags: parseAssetTags(meta.tags),
      characters: Array.isArray(meta.characters) ? meta.characters.map((c) => String(c).trim()).filter(Boolean) : [],
      style: String(meta.style ?? ''),
      styleLabel: String(meta.styleLabel ?? ''),
      source: String(meta.source ?? 'generated'),
      group: String(meta.group ?? ''),
      prompt: String(meta.prompt ?? '').slice(0, ASSET_PROMPT_MAX),
      at: new Date().toISOString(),
    };
    index.assets.push(entry);
    return saveAssets(sessionId, index) ? entry : null;
  });
}


/** 画面里出现的**全部**已登记角色（群像图要把他们都记进索引，便于按角色检索）。 */
function charactersInPrompt(session, prompt) {
  const text = String(prompt ?? '');
  return (Array.isArray(session?.characters) ? session.characters : [])
    .map((c) => String(c?.name ?? '').trim())
    .filter((n) => n && text.includes(n));
}

/** 各分类的条数（常驻段摘要与面板筛选都用它）。 */
function assetCounts(index) {
  const counts = { portrait: 0, scene: 0, item: 0, other: 0 };
  for (const a of index?.assets ?? []) counts[assetKindOf(a.kind)] += 1;
  return counts;
}

/**
 * 按条件筛资源。**工具与 HTTP 路由共用这一份**（两处各写一遍的话，早晚会慢慢走散）。
 *
 * 语义：kind / characters / tags 是**硬过滤**（都要满足），`q` 再在 label+tags+prompt+角色名
 * 上做一次子串匹配。返回按时间**倒序** —— 最近出的那张更可能正是想复用的那张。
 */
function queryAssets(sessionId, opts = {}) {
  const index = loadAssets(sessionId);
  const kind = String(opts.kind ?? '').trim();
  const wantChars = Array.isArray(opts.characters) ? opts.characters.map((s) => String(s).trim()).filter(Boolean) : [];
  const wantTags = parseAssetTags(opts.tags);
  const q = String(opts.q ?? '').trim().toLowerCase();
  let list = index.assets.slice();
  if (ASSET_KINDS.includes(kind)) list = list.filter((a) => assetKindOf(a.kind) === kind);
  if (wantChars.length) list = list.filter((a) => wantChars.every((c) => (a.characters ?? []).includes(c)));
  if (wantTags.length) list = list.filter((a) => wantTags.every((t) => (a.tags ?? []).includes(t)));
  if (q) {
    list = list.filter((a) => [a.label, (a.tags ?? []).join(' '), (a.characters ?? []).join(' '), a.prompt, a.group]
      .filter(Boolean).join(' ').toLowerCase().includes(q));
  }
  list.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
  const want = Number(opts.limit);
  const limit = Math.min(ASSET_LIST_MAX_LIMIT,
    Math.max(1, Number.isFinite(want) && want > 0 ? Math.trunc(want) : ASSET_LIST_DEFAULT_LIMIT));
  return { total: list.length, counts: assetCounts(index), assets: list.slice(0, limit), limit };
}

/** 一条资源 → 给模型看的一行（含 id 与可直接放进 `dsh-ui` 的地址）。 */
function assetLine(sessionId, a) {
  const bits = [
    `[${ASSET_KIND_LABEL[assetKindOf(a.kind)]}] ${a.label || '（未命名）'}`,
    (a.tags ?? []).length ? `#${(a.tags ?? []).join(' #')}` : '',
    (a.characters ?? []).length ? `角色：${(a.characters ?? []).join('、')}` : '',
    a.width && a.height ? `${a.width}×${a.height}` : '',
    `id=${a.id}`,
    assetPreviewUrl(sessionId, a.id, 640),
  ].filter(Boolean);
  return bits.join(' · ');
}

/** 导入会话包的上限（base64 之前）。几个 MB 的包很常见，留足余量但挡住「有人塞了个超大文件」。 */
const BUNDLE_UPLOAD_MAX_BYTES = 64 * 1024 * 1024;

/** 单张卡 PNG 的读取上限（实测最大 1.67MB 文本，整文件最大约 8MB）。 */
const CARD_PNG_MAX_BYTES = 32 * 1024 * 1024;

/** 卡片全文 markdown 的字数上限（超出截断，仅影响按需 read 的全文）。 */
const CARD_MD_MAX_CHARS = 400000;

/** 列表默认/最大返回条数。 */
const CARD_LIST_LIMIT = 60;
const CARD_LIST_MAX = 200;

/**
 * 卡库根目录的解析顺序：
 * 1. 设置页显式填的 `cards.root`（相对路径按会话工作区解析）；
 * 2. **默认 = 会话工作区下的 `rp-cards/`** —— 卡跟着战役走，一个工作区一套卡；
 * 3. 拿不到工作区就返回空串（调用方回一句「拿不到工作区」），**不再回落到任何固定路径**。
 */
function cardLibraryRoot(cfg, workspaceHint) {
  const fromCfg = String(cfg?.cards?.root ?? '').trim();
  const ws = String(workspaceHint ?? '').trim();
  const wsAbs = ws && isAbsolute(ws) && existsSync(ws) ? resolve(ws) : '';
  if (fromCfg) {
    if (isAbsolute(fromCfg)) return fromCfg;
    return wsAbs ? resolve(wsAbs, fromCfg) : fromCfg;
  }
  if (wsAbs) return join(wsAbs, CARD_LIBRARY_DIR);
  return '';
}

/**
 * 导入时把卡里的 `{{user}}` 换成什么（默认「玩家」）。
 * 卡里的世界观/开场白大量使用 `{{user}}` 指代玩家角色，直接留着会被注入端的
 * `neutralizeMustache()` 变成全角括号（DM 看到 `｛｛user｝｝`），所以在导入时就展开。
 */
/**
 * 全局**默认宏列表**（设置页里那份预设，存在 `config.cards.macros`）。
 *
 * 语义：**只提供默认值**。会话宏表里有同名键就用会话的（`{{user}}` 一直是这个规矩，
 * 现在推广到所有名字）。键必须是宿主变量名（`[a-z][a-z0-9_]*`），值为空串的条目直接忽略
 * —— 一个空默认值没有任何意义，留着只会让界面出现空行。
 */
function globalMacros(cfg) {
  const raw = cfg?.cards?.macros;
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw)) {
    const name = String(key ?? '').trim().toLowerCase();
    if (!MACRO_NAME_RE.test(name)) continue;
    const text = String(value ?? '');
    if (!text.trim()) continue;
    out[name] = text;
  }
  return out;
}

/** 全局默认 + 会话宏表（会话优先）—— provider 与变量注册都用这一份，避免两处规则不一致。 */
function mergedMacros(cfg, sessionMacros) {
  return { ...globalMacros(cfg), ...(sessionMacros ?? {}) };
}

/**
 * 打一个**卡库配置**补丁：`{ root?, macros? }` → 归一化后的新 `cfg.cards`。
 *
 * 工具（`rp_config`）与设置页（`POST /rp-tools/config`）共用这一份，规则只有一处：
 * 宏名必须是宿主变量名（`MACRO_NAME_RE`），**值为空串的条目直接丢掉**（空默认值没意义，
 * 留着只会让界面出现空行）；`userLabel` 继续跟着 `user` 走 —— 它只是 1.8.7 之前的老字段，
 * 别让它和宏列表说两套话。`macrosSeeded` 置 true：用户动过这个列表，之后不再自动补 `user → 玩家`。
 */
function applyCardConfigPatch(cfg, { root, macros } = {}) {
  const next = {};
  if (macros && typeof macros === 'object') {
    for (const [key, value] of Object.entries(macros)) {
      const name = String(key ?? '').trim().toLowerCase();
      if (!MACRO_NAME_RE.test(name)) continue;
      const text = String(value ?? '');
      if (!text.trim()) continue;
      next[name] = text;
    }
  }
  return {
    ...(cfg?.cards ?? {}),
    root: root !== undefined ? String(root).trim() : String(cfg?.cards?.root ?? '').trim(),
    userLabel: String(next.user ?? ''),
    macros: next,
    macrosSeeded: true,
  };
}

function cardUserLabel(cfg) {
  // 默认宏列表里的 user 优先；老字段 userLabel 继续认（迁移期的兼容）
  const label = String(globalMacros(cfg).user ?? cfg?.cards?.userLabel ?? '').trim();
  return label || DEFAULT_USER_LABEL;
}

/**
 * 列卡库：**直接扫目录**（只认 PNG 文件名当卡名）。
 *
 * 早先还有一条「本机私有索引」的路（`lib/card-index.js`，从某个固定的 SillyTavern 素材大目录
 * 生成），但它与那个固定路径强绑定 —— 用户明确说「不需要判断那个目录」，
 * 于是整条索引路径都删掉了：卡库现在只由 `cards.root`（默认会话工作区下的 rp-cards）决定。
 */
// 目录扫描结果会被搜索框连续复用；但缓存不能永久活着。卡库文件被重命名/移动/删除时，
// 永久缓存会继续把旧路径发给界面，点卡后就得到 ENOENT（「刷新」按钮也曾因此完全无效）。
// 每次复用前只核对**扫描过的目录**的 mtime/ctime：通常只有几十个 stat，比重扫几千张 PNG 轻；
// 任一目录发生增删/重命名就重扫。显式刷新与「旧路径已不存在」还会直接清缓存兜底。
let cardScanCache = new Map();  // root → { entries, directories: [{ path, stamp }] }

function cardDirectoryStamp(dir) {
  try {
    const st = statSync(dir);
    return `${st.mtimeMs}:${st.ctimeMs}`;
  } catch { return ''; }
}

function cardScanCacheFresh(cached) {
  if (!cached || !Array.isArray(cached.entries) || !Array.isArray(cached.directories) || !cached.directories.length) return false;
  return cached.directories.every((entry) => cardDirectoryStamp(entry.path) === entry.stamp);
}

function invalidateCardIndex(root) {
  const raw = String(root ?? '').trim();
  if (!raw || !isAbsolute(raw)) return;
  cardScanCache.delete(resolve(raw));
}

async function ensureCardIndex(root, { refresh = false } = {}) {
  const rootAbs = resolve(root);
  const cached = cardScanCache.get(rootAbs);
  if (!refresh && cardScanCacheFresh(cached)) return { entries: cached.entries, source: 'scan' };
  const directories = [];
  const entries = scanCardDir(rootAbs, { directories });
  cardScanCache.set(rootAbs, { entries, directories });
  return { entries, source: 'scan' };
}

/** 扫目录：最多 3 层，跳过「解压密码」这类目录，只取文件名当卡名。 */
function scanCardDir(root, { depth = 3, limit = 8000, directories = [] } = {}) {
  const out = [];
  const rootAbs = resolve(root);
  const walk = (dir, level) => {
    if (level > depth || out.length >= limit) return;
    let names = [];
    try { names = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const dirent of names) {
      if (out.length >= limit) break;
      const full = join(dir, dirent.name);
      if (dirent.isDirectory()) {
        // 加密/解压密码之类的目录整片跳过（实测这类目录里全是坏卡）
        if (/解压密码|密码|password/i.test(dirent.name)) continue;
        walk(full, level + 1);
      } else if (/\.png$/i.test(dirent.name)) {
        let size = 0;
        try { size = statSync(full).size; } catch { /* 忽略 */ }
        const rel = full.slice(rootAbs.length + 1).split(sep).join('/');
        out.push({ f: rel, k: '', n: dirent.name.replace(/\.png$/i, ''), c: '', t: [], b: 0, s: size });
      }
    }
    const stamp = cardDirectoryStamp(dir);
    if (stamp) directories.push({ path: dir, stamp });
  };
  walk(rootAbs, 1);
  return out;
}

async function listCardsFor(root, opts) {
  const { entries, source } = await ensureCardIndex(root);
  return { ...listCards(entries, opts), indexSource: source };
}

/**
 * 把卡库内的相对路径解析成绝对路径。
 *
 * 路径安全：卡库路径来自浏览器请求，必须**落在根目录之内**（`resolve` 后前缀比对，
 * 挡住 `..\..` 与绝对路径逃逸），并且只认 `.png` —— 这条路由会读盘并把文件内容
 * 交给浏览器，不做校验就等于开了个任意文件读取。
 */
function safeCardPath(root, rel) {
  const raw = String(rel ?? '').trim();
  const rootRaw = String(root ?? '').trim();
  if (!raw || raw.includes('\0')) return null;
  // ⚠️ root 必须是**非空绝对路径**：`resolve('')` 会返回**进程工作目录**
  // （DSH 从 AppData\Local\DeepSeekHarness 启动时就是那儿），于是「拿不到工作区」
  // 会退化成 `stat '<cwd>\同人\某卡.png'` 的 ENOENT —— 用户看到的就是这种莫名错误。
  if (!rootRaw || !isAbsolute(rootRaw)) return null;
  const rootAbs = resolve(rootRaw);
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(rootAbs, raw);
  const withSep = rootAbs.endsWith(sep) ? rootAbs : `${rootAbs}${sep}`;
  if (abs !== rootAbs && !abs.toLowerCase().startsWith(withSep.toLowerCase())) return null;
  if (!/\.png$/i.test(abs)) return null;
  return abs;
}

/** 卡在库里的分类（路径第二段；`cards/<分类>/<文件>`）。 */
function cardCategory(rel) {
  const parts = String(rel ?? '').split(/[\\/]/).filter(Boolean);
  return parts.length >= 3 && parts[0] === 'cards' ? parts[1] : (parts[0] ?? '');
}

/** 给一张卡打分：名称命中 > 作者 > 标签 > 路径，供搜索排序。 */
function cardScore(entry, needle) {
  if (!needle) return 1;
  const q = needle.toLowerCase();
  const name = String(entry.n ?? '').toLowerCase();
  if (name === q) return 100;
  if (name.startsWith(q)) return 80;
  if (name.includes(q)) return 60;
  if (String(entry.c ?? '').toLowerCase().includes(q)) return 40;
  if ((entry.t ?? []).some((t) => String(t).toLowerCase().includes(q))) return 30;
  return String(entry.f ?? '').toLowerCase().includes(q) ? 10 : 0;
}

/** 过滤 + 分页列出卡库。返回给浏览器的字段都是短名展开后的。 */
function listCards(index, { q, category, limit, offset } = {}) {
  const needle = String(q ?? '').trim();
  const wantCat = String(category ?? '').trim();
  const scored = [];
  for (const e of index) {
    if (wantCat && cardCategory(e.f) !== wantCat) continue;
    const score = cardScore(e, needle);
    if (!score) continue;
    scored.push({ e, score });
  }
  // 有搜索词时按相关度，其次卡名；无搜索词时按分类内原有顺序（索引本身就是按目录排的）
  if (needle) scored.sort((a, b) => (b.score - a.score) || String(a.e.n).localeCompare(String(b.e.n), 'zh'));
  const start = Math.max(0, Math.trunc(Number(offset ?? 0)) || 0);
  const take = Math.min(Math.max(Math.trunc(Number(limit ?? CARD_LIST_LIMIT)) || CARD_LIST_LIMIT, 1), CARD_LIST_MAX);
  return {
    total: scored.length,
    items: scored.slice(start, start + take).map(({ e }) => ({
      path: e.f,
      name: e.n || String(e.f).split('/').pop(),
      kind: e.k ?? '',
      creator: e.c ?? '',
      tags: Array.isArray(e.t) ? e.t : [],
      bookEntries: Number(e.b ?? 0),
      bytes: Number(e.s ?? 0),
      category: cardCategory(e.f),
    })),
  };
}

/** 分类清单（名称 + 数量），顺序按卡数降序。 */
function cardCategories(index) {
  const counts = new Map();
  for (const e of index) {
    const cat = cardCategory(e.f);
    if (!cat) continue;
    counts.set(cat, (counts.get(cat) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));
}

/** 读卡库里的 PNG 并解码成卡 JSON（不落盘）。`ph` 里带玩家称呼（展开 `{{user}}` 用）。 */
function readCard(root, rel, { userLabel } = {}) {
  const abs = safeCardPath(root, rel);
  if (!abs) {
    return {
      ok: false,
      error: root ? '路径不合法（必须在卡库目录内的 .png）'
        : '拿不到会话工作区，无法定位卡库（默认是 <工作区>/rp-cards）。请在设置页填一个卡库目录，或让会话带上工作区。',
    };
  }
  let size = 0;
  try {
    size = statSync(abs).size;
    if (size > CARD_PNG_MAX_BYTES) return { ok: false, error: `卡文件过大（${(size / 1048576).toFixed(1)}MB）` };
  } catch (error) {
    // 列表里的路径可能在用户整理卡库后失效（重命名 / 移动 / 删除）。立即作废扫描缓存，
    // 让客户端自动重拉时拿到新目录，而不是继续显示同一批死路径。
    if (error?.code === 'ENOENT') {
      invalidateCardIndex(root);
      return {
        ok: false,
        code: 'CARD_LIBRARY_CHANGED',
        error: '卡库内容已变更：原文件已被移动、重命名或删除。列表已刷新，请重新选择。',
      };
    }
    return { ok: false, error: `读不到文件：${error?.message ?? error}` };
  }
  let decoded;
  try {
    decoded = decodeCardPng(readFileSync(abs));
  } catch (error) {
    return { ok: false, error: `PNG 解析失败：${error?.message ?? error}` };
  }
  if (!decoded.ok) return { ok: false, error: decoded.error ?? '卡数据解析失败', warnings: decoded.warnings };
  // seed 用卡库相对路径：`{{random:a,b}}` / `{{roll:1d6}}` 的展开是**确定性**的 ——
  // 同一张卡每次导入结果一致（换了卡才会不同），否则重导一次世界就换了。
  const built = buildImport(decoded, { userLabel, seed: rel });
  return { ok: true, abs, size, decoded, built };
}

/**
 * 把卡库相对路径变成一个安全的文件名（只去掉 `.png`，保留 `.card` 标记）。
 *
 * 刻意**不**去掉 `.card`：卡库里 `X.card.png` 与 `X.png` 可以同时存在，
 * 去掉后就撞成同一个 slug，导入第二个会把第一个的全文/卡面覆盖掉。
 */
function cardSlug(rel, fallbackName) {
  const base = String(rel ?? '').split(/[\\/]/).pop() ?? '';
  const raw = base.replace(/\.png$/i, '').trim() || String(fallbackName ?? '').trim() || 'card';
  return raw.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 120) || 'card';
}

/**
 * 世界书合并：**只追加新标题的条目**，绝不重写已有内容。
 *
 * 为什么不用「解析 → 重新渲染」：解析会把用户的注释、缩进、非标准写法全部抹掉。
 * 导入是外来动作，不该动用户自己写的那部分 —— 只把新条目的原始块贴到文件末尾。
 */
function mergeWorldBook(file, importedMarkdown) {
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const blocks = [];
  let header = '';
  for (const chunk of String(importedMarkdown ?? '').split(/^(?=##\s)/m)) {
    if (!chunk.trim()) continue;
    if (/^##\s/m.test(chunk) || chunk.trimStart().startsWith('## ')) blocks.push(chunk.trim());
    else header = chunk.trim();
  }
  if (!existing.trim()) {
    return { text: String(importedMarkdown ?? ''), added: blocks.length, skipped: 0, fresh: true };
  }
  const existingTitles = new Set(parseLoreMarkdown(existing).map((e) => e.title));
  const fresh = [];
  let skipped = 0;
  for (const block of blocks) {
    const title = /^##\s+(.+?)\s*$/m.exec(block)?.[1]?.trim();
    if (!title) continue;
    if (existingTitles.has(title)) { skipped++; continue; }
    existingTitles.add(title);
    fresh.push(block);
  }
  if (!fresh.length) return { text: existing, added: 0, skipped, fresh: false };
  const tail = existing.endsWith('\n') ? existing : `${existing}\n`;
  return { text: `${tail}\n${fresh.join('\n\n')}\n`, added: fresh.length, skipped, fresh: false, header };
}

/**
 * 按 id 取**活着的**会话对象：插件自己的引用 → 宿主会话注册表。
 *
 * 宿主注册表是权威的（`ctx.get('sessions').get(id)`）：它按 id 直接给会话对象，
 * 而 `sessionRefs` 只在 `session/created` 时填 —— 本进程没加载过的那些只有注册表知道。
 * 两侧 id 形式不同（注册表键是 `session-<uuid>`，插件内部用裸 uuid），所以两种都试。
 */
function liveSession(sessionId) {
  const id = normalizeSessionId(sessionId);
  const fromRef = sessionRefs.get(id);
  if (fromRef) return fromRef;
  try {
    const sessions = hostSessionLookup?.get ? hostSessionLookup.get('sessions') : undefined;
    if (!sessions || typeof sessions.get !== 'function') return undefined;
    for (const key of [id, `session-${id}`]) {
      const found = sessions.get(key);
      if (found) return found;
    }
  } catch { /* 没有该服务或版本不同就跳过 */ }
  return undefined;
}

/** 按 id 找**活着的**会话的 cwd：内存引用 → 宿主会话注册表。找不到返回 ''。 */
function liveSessionCwd(sessionId) {
  const cwd = liveSession(sessionId)?.header?.cwd;
  return typeof cwd === 'string' ? cwd : '';
}

/**
 * 记住会话工作区：写内存 + **落盘到会话配置**。
 *
 * 落盘是关键：只在内存里记，重启后这份知识就没了，而重启是常事（插件更新、崩溃恢复）。
 * 用「读原始 JSON → 只改 cwd → 写回」的方式，避免把用户手改过、本插件不认识的其他字段冲掉。
 */
function rememberSessionCwd(sessionId, cwd) {
  const id = normalizeSessionId(sessionId);
  const abs = String(cwd ?? '').trim();
  if (!id || !abs || !isAbsolute(abs)) return false;
  sessionCwd.set(id, abs);
  try {
    const file = sessionFile(id);
    let data = {};
    if (existsSync(file)) {
      try { data = JSON.parse(readFileSync(file, 'utf8')) ?? {}; } catch { data = {}; }
    }
    if (data.cwd === abs) return true;                    // 没变化就不写盘
    data.cwd = abs;
    if (!data.sessionId) data.sessionId = id;
    mkdirSync(SESSIONS_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
    return true;
  } catch { return false; }
}

/**
 * 解析「这个会话的工作区」。四级兜底，前三级都不需要调用方知道路径：
 * ① 本进程记过的（内存 Map）；② 交给宿主会话注册表现查（恢复进来的会话）；
 * ③ 会话配置里落过盘的（跨重启）；④ 调用方给的绝对路径（浏览器那边的 cwd）。
 *
 * 注意 ④ 排最后：浏览器的 cwd 可能过期（会话换过工作区），能自己查就别信请求参数。
 */
function resolveWorkspaceDir(sessionId, hint) {
  const rawId = String(sessionId ?? '').trim();
  const id = normalizeSessionId(rawId);
  // 没给 sessionId 的请求（部分路由允许）**不进 'default' 这个桶**：
  // 否则第一个带 workspace 的匿名请求就会被记下来，之后所有匿名请求都拿到那个目录 ——
  // 这是跨会话串台的一种形式，和世界书串档同一类错误。
  const keyed = Boolean(rawId);

  if (keyed) {
    const known = sessionCwd.get(id);
    if (known && existsSync(known)) return known;

    const live = liveSessionCwd(id);
    if (live && existsSync(live)) { rememberSessionCwd(id, resolve(live)); return resolve(live); }

    const stored = loadSession(id).cwd;
    if (stored && isAbsolute(stored) && existsSync(stored)) {
      sessionCwd.set(id, resolve(stored));
      return resolve(stored);
    }
  }

  const raw = String(hint ?? '').trim();
  if (raw && isAbsolute(raw) && existsSync(raw)) {
    if (keyed) rememberSessionCwd(id, resolve(raw));
    return resolve(raw);
  }
  return null;
}

/** 这个会话是否真的开过局：日志里出现过 `turn/start`，或已经有过用户消息。 */
function sessionHasTurn(session) {
  try {
    const log = session?.log;
    if (Array.isArray(log)) {
      for (const event of log) {
        if (event?.type === 'turn/start') return true;
        // 用户消息也算（有些会话的日志窗口里 turn/start 已被裁掉）
        if (event?.type === 'user/message' && event?.data?.source?.kind === 'user') return true;
      }
    }
  } catch { /* 忽略 */ }
  try {
    const messages = typeof session?.deriveMessages === 'function' ? session.deriveMessages() : [];
    if (Array.isArray(messages) && messages.some((m) => m?.role === 'user')) return true;
  } catch { /* 忽略 */ }
  return false;
}

/**
 * 会话闸门：「这个会话现在是不是 dm 预设」「有没有真的开局」。
 *
 * 为什么必须由宿主回答：界面的判据全部来自**客户端那份投影缓存**
 * （`byId[id].projectionValues.agentPreset` 与摘要里的 `blank`），而那份缓存会被重建 ——
 * 切预设会让会话作用域重新挂载、投影基线重放，基线里没有的键会被**清掉**。
 * 清掉之后 `agentPreset` 读成空串，界面就判定「不是 DM」，导入入口**永久消失**（刷新页面才好）——
 * 这正是用户报的「切走预设再切回 dm，导入按钮不见了」。
 * 宿主手里是活着的会话对象 + 自己的投影状态，问一次就能给出确定答案。
 */
function sessionGate(sessionId) {
  const id = normalizeSessionId(sessionId);
  const live = liveSession(id);
  let preset = '';
  let blank = null;
  try {
    const projections = hostSessionLookup?.get ? hostSessionLookup.get('sessionProjections') : undefined;
    if (projections && live && typeof projections.stateOf === 'function') {
      const p = projections.stateOf(live, 'agentPreset');
      if (typeof p === 'string' && p) preset = p;
      const meta = projections.stateOf(live, 'sessionListMetadata');
      if (meta && typeof meta.blank === 'boolean') blank = meta.blank;
    }
  } catch { /* 没有该服务就退回下面几种来源 */ }
  if (!preset) preset = String(live?.header?.agentPreset ?? '');
  const started = blank === null ? sessionHasTurn(live) : !blank;
  // 会话不在本进程里、又没有任何预设信息时，退回到「插件自己记的 dm 登记表」
  const dm = preset ? preset === 'dm' : isDmSession(id);
  return { ok: true, sessionId: id, dm, started, preset: preset || '', blank: !started, live: Boolean(live) };
}

/**
 * 把一次导入的结果落盘：世界书 + 卡全文/卡 JSON/卡面**都写进本会话自己的目录**
 * （`<工作区>/rp-sessions/<会话 id>/`）。
 *
 * 世界书与导入产物同处一个会话目录，是为了让「按会话隔离」这条承诺在**文件层面**也成立：
 * 放在工作区根目录的 `rp-cards/` 是同工作区共享的，A 会话导入的卡面会出现在 B 会话的目录列表里
 * （内容虽然一样，但边界含糊 —— 与刚修的世界书串档是同一类问题）。
 */
function writeImportFiles(workspace, { root, rel, built, decoded, name, userLabel, chosenGreeting, sessionId }) {
  // 世界书按会话隔离（见 sessionLorePath）；导入产物放进同一个会话目录下的 cards/
  const lorePath = ensureSessionLore(sessionId, workspace);
  const sessionDir = lorePath?.dir ?? join(workspace, LORE_SESSION_DIR, normalizeSessionId(sessionId));
  const dir = join(sessionDir, CARD_IMPORT_DIR);
  mkdirSync(dir, { recursive: true });
  const slug = cardSlug(rel, name);
  const relDir = `${LORE_SESSION_DIR}/${normalizeSessionId(sessionId)}/${CARD_IMPORT_DIR}`;

  const worldFile = lorePath?.file ?? join(workspace, LORE_FILE_NAME);
  mkdirSync(dirname(worldFile), { recursive: true });
  const merged = mergeWorldBook(worldFile, built.worldBookMarkdown);
  if (built.worldBookMarkdown) writeFileSync(worldFile, merged.text, 'utf8');

  // 卡全文：给 DM 按需 read（世界书有 60 条/6 万字预算，超出部分只在这里）
  const mdFile = join(dir, `${slug}.md`);
  const md = cardToMarkdown(decoded, { maxChars: CARD_MD_MAX_CHARS, userLabel, seed: rel });
  writeFileSync(mdFile, md.text, 'utf8');

  // 卡组开场白引导文件：**不截断**，全部开场白都在这里，DM 开场前 read 它
  const openFile = join(dir, `${slug}.opening.md`);
  const openMd = cardToOpeningFile(decoded, {
    greetings: built.greetings,
    chosenIndex: Number(chosenGreeting) || 0,
    userLabel,
  });
  writeFileSync(openFile, openMd.text, 'utf8');

  // 开局引导文件（§4）：首条消息只发它的路径；「从哪开始 / 有哪些文件 / 写进了什么 /
  // 还要人确认什么」全在里面 —— 消息保持 <500 字，细节不丢。
  const relDirForLaunch = relDir;
  const launchFile = join(dir, `${slug}.launch.md`);
  const launch = cardToLaunchFile(decoded, {
    greetings: built.greetings,
    chosenIndex: Number(chosenGreeting) || 0,
    files: {
      world: `${LORE_SESSION_DIR}/${normalizeSessionId(sessionId)}/${LORE_FILE_NAME}`,
      markdown: `${relDirForLaunch}/${slug}.md`,
      opening: `${relDirForLaunch}/${slug}.opening.md`,
      image: `${relDirForLaunch}/${slug}.png`,
    },
    built,
    warnings: Array.isArray(decoded?.warnings) ? decoded.warnings : [],
    userLabel,
  });
  writeFileSync(launchFile, launch.text, 'utf8');

  // 规范化后的导入结果（不含原文），供以后重放/排查
  const jsonFile = join(dir, `${slug}.json`);
  const { character } = built;
  const clean = {};
  for (const f of CHARACTER_FIELDS) clean[f] = character[f] ?? '';
  writeFileSync(jsonFile, JSON.stringify({
    source: rel,
    importedAt: new Date().toISOString(),
    kind: decoded.kind,
    chunk: decoded.chunk,
    character: clean,
    world: built.world,
    stats: {
      kept: built.stats.kept,
      skipped: built.stats.skipped,
      enabledOff: built.stats.enabledOff,
      totalChars: built.stats.totalChars,
      markdownChars: built.worldBookMarkdown.length,
    },
    // 卡里展开掉的占位符（{{user}} / {{char}} 等），便于事后核对「这句话原本是谁说的」
    placeholders: built.placeholders,
    summary: built.summary,
  }, null, 2) + '\n', 'utf8');

  // 卡面：复制一份到工作区，既能当立绘，也让工作区自带这套卡
  let imageFile = null;
  let imageRel = null;
  try {
    imageFile = join(dir, `${slug}.png`);
    writeFileSync(imageFile, readFileSync(safeCardPath(root, rel)));
    imageRel = `${relDir}/${slug}.png`;
  } catch { imageFile = null; imageRel = null; }

  return {
    slug,
    dir,
    worldFile,
    loreAdded: merged.added,
    loreSkipped: merged.skipped,
    loreFresh: merged.fresh,
    mdFile,
    mdChars: md.text.length,
    mdTruncated: md.truncated,
    openFile,
    openingChars: openMd.text.length,
    greetingCount: openMd.count,
    launchFile,
    launchChars: launch.text.length,
    jsonFile,
    imageFile,
    imageRel,
    relative: {
      // 相对工作区的路径（界面/提示词里显示的都要能对上）：全部在**本会话目录**下
      world: `${LORE_SESSION_DIR}/${normalizeSessionId(sessionId)}/${LORE_FILE_NAME}`,
      // 开局消息指向它（§4）
      launch: `${relDir}/${slug}.launch.md`,
      markdown: `${relDir}/${slug}.md`,
      opening: `${relDir}/${slug}.opening.md`,
      json: `${relDir}/${slug}.json`,
      image: imageRel,
    },
  };
}

// ===================================================================
// 设置页（管理 / 查看界面）的宿主路由
// -------------------------------------------------------------------
// 浏览器半侧 client/client.js 通过这几条同源路由读写 styles.json，
// 并可以「初始化工作流」「试出一张」。Origin 必须等于 Host。
// ===================================================================

function sameOrigin(request) {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (origin === undefined || host === undefined) return false;
  try { return new URL(origin).host === host; } catch { return false; }
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request, limit = 262144) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}


/**
 * 宏表「谁注册了哪些宿主变量」。
 *
 * - `macroVars`：sessionId → 该会话作用域里**已注册变量**的表（作用域自己的 Map，这里只是别名）；
 *   作用域销毁时别名会被清掉（见 installStandingPrompt 里的 effect）。
 * - `macroRegistrars`：sessionId → 一个函数，用来在**该会话的 agent 作用域**里注册新变量。
 *   路由（全局作用域）改完宏表后要立刻生效，就得靠它回调进 agent 作用域 ——
 *   变量是作用域隔离的，全局注册会污染所有会话。
 *
 * ⚠️ 这两个表的键都要靠 `installStandingPrompt` **从装配上下文里学到**才会出现
 * （插件 ctx 上没有 agent，见那里的注释）：在某个会话第一次装配之前，
 * 路由侧的 refreshSessionMacros 只会返回 pending，这是预期行为。
 */
const macroVars = new Map();
const macroRegistrars = new Map();
/** sessionId → 当前宏表的值（provider 每轮装配会被调用 N 次，不能每次都读盘）。 */
const macroValueCache = new Map();

/** 让某个会话的 agent 作用域把宏表里的名字都注册上（幂等；没有挂载就记下来等挂载时补）。 */
function refreshSessionMacros(sessionId, macros) {
  const id = normalizeSessionId(sessionId);
  const register = macroRegistrars.get(id);
  if (!register) return { registered: [], pending: Object.keys(macros ?? {}) };
  const registered = [];
  const pending = [];
  for (const name of Object.keys(macros ?? {})) {
    if (macroVars.get(id)?.has(name)) continue;
    const ok = register(name);
    if (ok) registered.push(name); else pending.push(name);
  }
  return { registered, pending };
}

/**
 * 中和 ST / 宿主风格的 `{{…}}` 双花括号 —— **放行本会话已注册的宿主变量**。
 *
 * 为什么必须做：宿主渲染时**严格插值** `{{变量}}`，未注册的名字直接抛错。
 * 注册过的（`user` + 本会话宏表）要原样留着交给宿主插值；其余换成全角，避免整轮装配失败。
 * `known` 为空时退化成「全部中和」（测试与旧调用点仍然可用）。
 */
function neutralizeMustache(text, known) {
  // 不传 known 时默认放行 user（历史行为）；显式传空数组/空 Set 则一律中和
  const keepSet = known instanceof Set ? known : new Set(known ?? ['user', ...AUTO_MACROS]);
  const keep = [];
  let out = String(text ?? '').replace(/\{\{\s*([^{}]{0,80}?)\s*\}\}/g, (m, name) => {
    const clean = String(name).trim().toLowerCase();
    if (keepSet.has(clean)) {
      keep.push(`{{${clean}}}`);
      return `\u0000${keep.length - 1}\u0000`;
    }
    return `｛｛${name}｝｝`;
  });
  // 落单的半角花括号（没有配对的）也换成全角，免得宿主当成畸形引用
  out = out.replace(/\{\{/g, '｛｛').replace(/\}\}/g, '｝｝');
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i) => keep[Number(i)] ?? '');
}

/**
 * system standing 里「常驻世界书」的**总字符预算**。
 *
 * 为什么必须有：`constant` 条目的正文以前是无上限地整体进系统提示 —— 一张卡原卡里
 * 32 条全 `constant`，导入后光这一段就有 4.2 万字，比整个跑团 standing 的验收基线还大，
 * 而且每轮都在（用户实测：导入一张卡后 system 提示反而更长）。
 *
 * 超预算的**不截断**（截成残句会让模型接着残句往下写），而是**降级**：
 * 退出 system standing，改为按触发词进 runtime —— 命中了才注入，没命中就用 `rp_lore` 补读。
 */
const STANDING_LORE_BUDGET_CHARS = 6000;

/**
 * 把世界书条目分成「进 system standing 的常驻」与「只能走 runtime 的条目」。
 *
 * 两条规则（对应计划 §3.1 的约束）：
 * ① **外部导入的条目不得因 `constant` 自动获得 system 权限**：`source: card` 的条目一律降级到
 *    runtime（它仍有标题/keys 触发，只是不再是「已经确立的事实」）。判据取自导入器写下的
 *    来源标记，**不靠猜**；老文件没有标记 → 维持原行为；
 * ② **standing 有总字符预算**：手写常驻按 order 降序取，超预算的同样降级到 runtime。
 *
 * 降级条目返回时 `constant` 一律置 false —— 这样 `activateLore()` 会按 keys 处理它们，
 * 而不会当成「无视关键词常驻」。
 *
 * @returns {{ standing: object[], runtime: object[], demoted: Array<{title: string, reason: string}>, standingChars: number }}
 */
function planLoreInjection(entries, { budgetChars = STANDING_LORE_BUDGET_CHARS } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const standing = [];
  const runtime = [];
  const demoted = [];
  let used = 0;
  const constants = list
    .filter((e) => e && e.constant === true)
    .sort((a, b) => (b.order ?? 0) - (a.order ?? 0));

  for (const e of constants) {
    if (e.empty === true) { runtime.push({ ...e, constant: false }); continue; }
    if (String(e.source ?? '').toLowerCase() === 'card') {
      demoted.push({ title: e.title, reason: 'imported' });
      runtime.push({ ...e, constant: false });
      continue;
    }
    const cost = e.title.length + e.body.length + 8;
    if (used + cost > budgetChars) {
      demoted.push({ title: e.title, reason: 'budget' });
      runtime.push({ ...e, constant: false });
      continue;
    }
    standing.push(e);
    used += cost;
  }
  // 非常驻条目本来就只走 runtime
  for (const e of list) if (e && e.constant !== true) runtime.push(e);
  return { standing, runtime, demoted, standingChars: used };
}

/**
 * 常驻世界书条目 → 写进 **standing 段（系统提示词）**。
 *
 * 为什么常驻条目不放每轮快照：它们的内容是稳定的（除非用户/DM 改世界书），
 * 放进字节稳定的常驻段既能被前缀缓存复用，又不会每轮往会话历史里追加一份全文
 * （10 条常驻 ≈ 4.5 千字，30 轮就是十几万字）。用户也正是期望
 * 「常驻条目就该在系统提示里」（他问过「我在系统提示词里没看到常驻世界书条目」）。
 *
 * 命中的（非常驻）条目仍然走每轮快照 —— 它们本来就每轮不同。
 * 被预算/来源降级的常驻条目**列标题**告知模型「有这些，需要时按需取」，不静默丢弃。
 */
function renderConstantLore(entries, demoted = []) {
  const list = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && e.constant === true && e.empty !== true && String(e.body ?? '').trim());
  const notes = (Array.isArray(demoted) ? demoted : []).filter((d) => d?.title);
  if (!list.length && !notes.length) return '';
  const parts = [];
  if (list.length) {
    parts.push(`【世界书·常驻】以下条目每轮都在，视为已确立的事实：\n${list.map((e) => `### ${e.title}\n${e.body}`).join('\n\n')}`);
  }
  if (notes.length) {
    parts.push(`【世界书·按需】以下条目因超出常驻预算或来自导入的卡而没有整段常驻，`
      + `需要时用 rp_lore 按标题补读：${notes.map((d) => d.title).join('、')}`);
  }
  return parts.join('\n\n');
}

/**
 * 「本会话设定」块：DM 自己的规则 + **配图指路** + **已有可用图的地址**。
 *
 * 为什么要放进常驻段：
 * - DM 设定（多半来自 DM 卡的导入）就是**这个 DM 的行为准则**，属于指令，必须在系统提示里；
 * - **本插件不做配图**：要新图得用宿主自带的 `generate_image` —— 常驻段里只留**一行指路**，
 *   不抄宿主的工具说明（每轮都发的字节，抄一遍既费 token 又会形成两套口径）；
 * - 「谁已经有图」这件事由宿主算最准 —— DM 拿到现成地址就能**直接展示**，不必重新生成
 *   （用户要求：「如果角色卡本身有立绘，可以直接使用立绘」）。
 * 这些都是**字节稳定**的（只有用户保存 / 导入时才变），所以放常驻段不会每轮重发。
 */
function renderDmSetup(session, { loreFile } = {}) {
  const dm = session?.dm ?? {};
  const lines = [];
  // 配图指路：一句话说清「谁出图、出完怎么用、想复用怎么入库」。
  lines.push('- 配图：**本插件不出图** —— 需要插图时用宿主的 `generate_image`（改图用 `edit_image`），'
    + '画面描述里带上人物卡 `appearance` 的外观描述；拿到附件后用 `dsh-ui` 的 image 组件显示。'
    + '想把新图收进资源库复用，用 `rp_assets(action:"import", path:"<generate_image 返回的 savedTo>", label:"…", tags:"…")`。');
  // 已有立绘：直接给可用的相对地址（界面与聊天都用同一个同源路由）
  const portraits = session?.portraits && typeof session.portraits === 'object' ? session.portraits : {};
  const arts = [];
  const charNames = (Array.isArray(session?.characters) ? session.characters : [])
    .map((c) => String(c?.name ?? '').trim()).filter(Boolean);
  for (const [name, entry] of Object.entries(portraits)) {
    if (!entry || typeof entry !== 'object') continue;
    // ⚠️ 只认 `imported` 与 `card`：`generated` 是老版本存的 ComfyUI 三要素，媒体代理已经删掉，
    // 那些路径现在是死引用（见 docs/REMOVE-IMAGE-GEN.md §5.2）。
    if (entry.imported?.file) {
      // 用户导入的立绘（存在会话目录里，走 /rp-tools/portrait-image）。
      // `v` = 导入时间：同名重导时文件名不变，带上它才能绕过浏览器缓存。
      arts.push(`  · ${name}（导入的立绘）：/rp-tools/portrait-image?sessionId=${encodeURIComponent(String(session?.sessionId ?? ''))}&name=${encodeURIComponent(name)}&v=${encodeURIComponent(String(entry.imported.at ?? ''))}`);
    } else if (entry.card) {
      arts.push(`  · ${name}（卡面）：/rp-tools/card-image?path=${encodeURIComponent(String(entry.card))}&sessionId=${encodeURIComponent(String(session?.sessionId ?? ''))}&thumb=1&width=640`);
    }
  }
  // **导入卡的那张 PNG 就是它的立绘**（用户要求「立绘复用」）：卡面已经落在会话目录里、
  // 面板也摆在【世界设定】旁边，第一次出场时**直接展示它**，不必再让模型重新生成。
  // 归属判断：卡名与某个角色同名 → 就是它的；只有一个角色 → 也认给它（一对一的角色卡最常见）。
  const coverCard = session?.cover?.card;
  if (coverCard) {
    const coverName = String(session?.cover?.name ?? '').trim();
    const owner = coverName && charNames.includes(coverName) ? coverName
      : (charNames.length === 1 ? charNames[0] : '');
    const ownerArt = owner && portraits[owner] && typeof portraits[owner] === 'object' ? portraits[owner] : null;
    // 已经有可用图（导入的立绘）或已登记过卡面 → 不重复列，免得 DM 以为有两张图
    const ownerHasArt = Boolean(ownerArt && (ownerArt.card || ownerArt.imported?.file));
    const anyCard = Object.values(portraits).some((e) => e && e.card);
    if (!ownerHasArt && !anyCard) {
      const label = owner ? `${owner}（卡面＝立绘）` : (coverName ? `卡面《${coverName}》` : '卡面');
      arts.push(`  · ${label}：/rp-tools/card-image?path=${encodeURIComponent(String(coverCard))}&sessionId=${encodeURIComponent(String(session?.sessionId ?? ''))}&thumb=1&width=640`);
    }
  }
  if (arts.length) {
    lines.push('- **已有可用图：先在下面找，有就直接展示，不要重新生成**（玩家导入的立绘 / 导入卡的卡面都在这里；展示时把地址原样放进 `dsh-ui` 的 image 组件）：');
    lines.push(...arts);
  }
  // 资源库摘要：**只报条数，不列清单**。这是故意的 —— 常驻段是每轮都发的，而资源库只增不减，
  // 把上百条图列进来会把每轮上下文吃掉几千字。查什么由 DM 当场用 `rp_assets` 决定。
  const assetCountsAll = assetCounts(loadAssets(session?.sessionId));
  const assetTotal = ASSET_KINDS.reduce((sum, k) => sum + assetCountsAll[k], 0);
  if (assetTotal > 0) {
    const parts = ASSET_KINDS.filter((k) => assetCountsAll[k] > 0)
      .map((k) => `${ASSET_KIND_LABEL[k]} ${assetCountsAll[k]}`);
    lines.push(`- 资源库：本会话已有 ${assetTotal} 张图（${parts.join('、')}）—— 剧情回到同一地点/同一人物时，`
      + '**先用 `rp_assets` 按标签或角色查一遍，找到就重放那张**（同一张图永远长得一样，也不必再让模型生成一次）；确实没有才生新的，'
      + '生完用 `rp_assets(action:"import", …)` 收进来');
  } else {
    // 同上：空的时候明说，别让「这一行没出现」被读成「已经有了」
    lines.push('- 资源库：本会话**还没有任何图**（一张都没有。生新图后用 `rp_assets(action:"import", …)` 收进来，'
      + '**记得填 `label` 与 `tags`**，否则以后搜不到；玩家也会从面板直接导入自己的图）');
  }
  const prompt = String(dm.prompt ?? '').trim();
  if (prompt) lines.push('', '### DM 自己的设定（按它带团）', prompt);
  if (!lines.length) return '';
  return `【本会话设定】\n${lines.join('\n')}`;
}

/**
 * 列出本会话的 launch 文件（`<会话目录>/cards/*.launch.md`），按名字排序。
 *
 * 只读**本会话自己的** cards 目录 —— 这也是把「找 launch 文件」这件事从 DM 手里收回来的关键：
 * 宿主知道该去哪找，DM 不需要（也不该）在工作区根上 glob。找不到就返回空数组。
 */
function listLaunchFiles(loreFile) {
  try {
    const dir = join(dirname(String(loreFile)), CARD_IMPORT_DIR);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((n) => n.toLowerCase().endsWith('.launch.md'))
      .sort()
      .map((n) => join(dir, n));
  } catch { return []; }
}

/**
 * 删一个文件，**并确认它真的没了**（返回是否已消失）。
 *
 * 为什么要确认：本机（Windows + Node 24）实测 `rmSync(path, { force: true })` 对**中文文件名**
 * 会**静默地什么都不做** —— 不抛错、文件仍在；同一个路径换 `unlinkSync` 就删掉了，ASCII 名也没问题：
 *
 *   a.zip → 删掉   旧的.zip → 还在   b.zip → 删掉   中文.txt → 还在   c.zip → 删掉
 *
 * 这个插件里**中文文件名是常态**（卡面文件名来自卡名、用户导入的图也常是中文名），所以绝不能
 * 「rmSync 没抛错就当删掉了」—— 那正是这个仓库反复吃亏的「报告与事实不符」。
 * 先 rmSync，还在就用 unlinkSync 兜底，**最终以磁盘状态为准**。
 */
function removeFileVerified(abs) {
  try { rmSync(abs, { force: true }); } catch { /* 下面统一看磁盘 */ }
  if (!existsSync(abs)) return true;
  try { unlinkSync(abs); } catch { /* 再失败就如实返回 false */ }
  return !existsSync(abs);
}

/**
 * 从会话配置拼出「世界观速览」——注入 system 段的常驻内容。
 * 刻意做成**纯函数**（吃会话对象，不自己读盘）：既好测，也不依赖模块加载时定下的数据目录。
 * 兼容两种入参：`loadSession()` 的解析结果，或 `sessions/<id>.json` 的原始内容（字段同名）。
 */
function buildStandingText(session, extra = {}) {
  if (!session) return '';
  const parts = [];
  // 「有没有世界观类内容」决定用哪个标题：只有 DM 设定时不该声称「设定都已确立」
  let hasWorldParts = false;
  const campaignName = session.campaign?.name;
  if (campaignName) { parts.push(`战役：${campaignName}`); hasWorldParts = true; }
  const dmSetup = renderDmSetup(session, { loreFile: extra.loreFile });
  if (dmSetup) parts.push(dmSetup);
  if (session.world) { parts.push(`【世界设定】\n${session.world}`); hasWorldParts = true; }
  const chars = Array.isArray(session.characters) ? session.characters.filter((c) => c?.name) : [];
  if (chars.length) {
    // 常驻的**只有索引**（谁在场），详细卡片按轮注入 —— 见 charactersToExpand / buildTurnContext。
    // 这样 standing 的字节数不随角色数增长，也不会每轮变化。
    const index = renderCharacterIndex(session);
    if (index) { parts.push(index); hasWorldParts = true; }
  } else {
    // **空的时候要明说**（真机测试报告 BUG-01 的种子）：以前「没有角色」的表现是**这一节不出现**，
    // 而 persona 里又写着「已有可用图」「常驻条目」这些规矩，模型回头读自己的 system prompt 时
    // 很容易把**没出现**当成**已经有了**。一行字很便宜，误判很贵。
    parts.push('【人物】本会话还没有登记任何角色（用 `rp_character` 建；别以为已经有了）');
  }
  const tables = Array.isArray(session.tables) ? session.tables.filter((t) => t?.name) : [];
  if (tables.length) {
    // 只列名字：掷表交给 rp_table 工具，这里给个目录就够，避免常驻内容膨胀
    parts.push(`【可用随机表】${tables.map((t) => `${t.name}(${t.dice})`).join('、')}`);
    hasWorldParts = true;
  }
  // 世界书路径：给 DM 一个**确定**的指针（按会话隔离，路径随会话变化，别让它去猜/复用别的会话的）
  if (extra.loreFile) {
    // 文件还不存在时必须**说出来**（真机测试报告 BUG-02 的种子）：只给一行路径，
    // 模型很容易读成「世界书已经有了」—— 然后去 read 一个不存在的文件、或者干脆不问玩家要世界。
    const loreExists = existsSync(extra.loreFile);
    parts.push(`【世界书】${extra.loreFile}`
      + (loreExists
        ? '\n（本会话专属；用 read 读、用 write/edit 增改。只有被对话触发的条目才进上下文。）'
        : '\n（**这份文件还不存在** —— 本会话目前没有任何世界书条目。要建就调 `rp_lore(action:"template")` 生成模板，'
          + '或直接 write 这个路径。别把它当成「已经有设定」。）'));
    hasWorldParts = true;
    // 开局引导文件也**印出来**（有就给路径，没有就说没有）。
    //
    // 为什么这条能顺手消掉一个真风险：persona 让 DM「找 `cards/*.launch.md`，有就先读它」，
    // 而 launch 路径只在导入那一刻的返回与开场白里出现过，既不在会话配置里、也不在常驻段里 ——
    // DM 到了后续轮次只能靠 glob 去猜。真机日志里它在工作区根 glob 一次捞到了**4 个别的会话的**
    // launch 文件，读了就是拿别人的世界观开团（而且不报错）。把路径直接给它，DM 就**不必去找**，
    // 比在 persona 里警告它「别找错地方」有效得多。
    const launchFiles = listLaunchFiles(extra.loreFile);
    parts.push(launchFiles.length
      ? `【开局文件】${launchFiles[0]}`
        + `\n（本会话导入卡时生成的开局引导；开局先读它，按其中的「选定开场」开始。`
        + `${launchFiles.length > 1 ? `另有 ${launchFiles.length - 1} 份同目录下的 .launch.md。` : ''}`
        + '**不要再 glob 找它**。）'
      : '【开局文件】本会话没有 `cards/*.launch.md`（没导入过卡，或导入时没生成）——'
        + '**不要在别处找别人的 launch 文件**，世界从哪来按 persona 的规则处理。');
    // 地图（可选功能）：有就给两个文件的绝对路径 —— DM 要改结构/状态时直接读写，
    // 不必 glob 去找；而「队伍在哪、能去哪」的每轮摘要由宿主注入（见 buildTurnContext），
    // 更不必为了看一眼位置去读整个文件。
    const mapPaths = mapFilePaths(extra.loreFile);
    if (mapPaths.exists) {
      parts.push(`【地图】${mapPaths.mapFile}`
        + `\n（静态图在上面这个文件；队伍位置等运行时变化放 ${mapPaths.stateFile}，**不要写回静态图**。`
        + '当前位置与可走方向宿主**每轮自动注入**，不用读文件也能知道；要改变时先 read 再 write/edit。）');
      hasWorldParts = true;
    }
  }
  // 常驻条目全文（稳定内容 → 常驻段；非常驻的命中条目走每轮快照）
  // 这里先做一次**注入规划**：导入来的常驻与超预算的常驻都降级到 runtime（见 planLoreInjection）
  const plan = planLoreInjection(extra.constants);
  const constants = renderConstantLore(plan.standing, plan.demoted);
  if (constants) { parts.push(constants); hasWorldParts = true; }
  if (!parts.length) return '';
  const body = hasWorldParts
    ? '## 本场跑团的世界观（由 RP 工具注入，视为已确立的事实）\n'
      + '以下设定已经确定，直接据此叙述，不要再说「我需要先了解设定」：\n\n'
      + parts.join('\n\n')
    : `## 本会话设定（由 RP 工具注入）\n\n${parts.join('\n\n')}`;
  return neutralizeMustache(body, extra.macros);
}

/**
 * 注册提示词常驻段（standing）并每轮填充。
 *
 * 为什么需要：本插件原先 8 个工具**全是模型主动调用型**，没有任何主动注入通道 ——
 * 世界设定/角色卡在模型侧是「冷数据」，模型得先花一步调 rp_session 才知道世界观，而且每轮都可能忘。
 * 参照 dsh-liketavern 的做法补上这条通道。
 *
 * 几个刻意的选择（都有踩坑依据）：
 * - 段序取 210：工具说明占 100–199，稳定骨架放其后，即使骨架抖动，稳定的工具前缀仍能命中前缀缓存。
 * - 内容为空时注入一段**固定短文案**而不是清空段：避免段布局抖动打穿缓存，同时避免插件没配会话时乱讲设定。
 * - 只放**逐字节稳定**的内容（不掺时间戳/随机数/轮次号）。
 * - 任何异常都吞掉：绝不能因为插件出问题而让用户发不出消息。
 */
function installStandingPrompt(ctx, opts = {}) {
  try {
    const sys = ctx.get ? ctx.get('systemPrompt') : undefined;
    if (!sys || typeof sys.section !== 'function' || typeof sys.context !== 'function') return false;
    /**
     * 本会话 id —— **只从装配上下文取，不看 `ctx.agent`**。
     *
     * 为什么这是唯一正确来源：`assemble()` 传进来的 `AssembleContext` 由
     * `assembleContextFor(agent, signal)` 构造（见 dsh-agent），形如 `{ agent, scope: agent }`，
     * 而 agent 作用域上下文（插件拿到的 `ctx`）上**根本没有 `agent` 属性**。
     *
     * 踩过的坑：早先写成 `ctx.agent.id`，`normalizeSessionId(undefined)` 得到 `'default'`，
     * 于是每一次真实装配都去读 `default` 这个空会话 —— 世界设定/角色卡/世界书**从来没注入过**
     * （会话日志里只有那句占位「本会话尚未设置跑团世界设定」，`_standing-probe.json` 里
     * `sessionId: "default"`、`loreEntries: 0`）。反复看代码没看出来，是**查日志**查出来的。
     */
    const sessionIdOfAssemble = (context) => {
      try {
        const agent = context?.agent ?? context?.scope;
        const raw = agent?.session?.id ?? agent?.id ?? '';
        // 工具侧是 `session-<uuid>`，会话目录是裸 `<uuid>`，统一成一个
        return String(raw).replace(/^session-/, '').trim();
      } catch { return ''; }
    };
    /**
     * 本作用域已注册的宿主变量：name → disposer。
     *
     * 粒度是**作用域**而不是会话 id —— 一个 agent 作用域就是一份注册表，
     * 按会话 id 记账会在「挂载时还不知道 id」的那一段里重复注册（宿主会直接抛重复错误）。
     */
    const owned = new Map();
    /** 挂载时能拿到的 id（rp-bridge 不传，所以通常为空）。 */
    let learnedSessionId = (() => {
      const id = normalizeSessionId(opts.sessionId ?? '');
      return id === 'default' ? '' : id;
    })();

    // ── 身份宏 / 宏表：把 `{{user}}`、`{{x}}` 注册成**宿主变量**（DSH 原生做法，等价于酒馆那边的身份宏）──
    // 宿主渲染时**严格插值** `{{变量}}`，未注册的名字直接抛错，所以：
    //   ① `user` 永远注册（值 = 会话宏表里的 user，缺省落到全局「玩家称呼」）；
    //   ② 会话宏表里其它名字在挂载时注册一遍，之后由路由/装配再补注册（宿主不允许重复注册）。
    // 变量是**作用域隔离**的：这些注册发生在 agent 作用域，所以只作用于本会话，不会污染别的会话。
    //
    // ⚠️ provider 每轮装配都会被调用，**每次调用都会收到该轮的 AssembleContext** ——
    //    会话 id 就从这里取（`ctx.agent` 是没有的，见上）。
    /**
     * 宏表取值。缓存在 `macroValueCache` 里（provider 一轮会被调 N 次，不能每次都读盘）；
     * 进程里**第一次**碰到某个会话时补读一次盘 —— 否则「刚重启、会话宏表还没被任何路由写过」
     * 的那一轮会拿到空表，`{{user}}` 之类会退回全局默认值（面板里明明填过会话值）。
     */
    const macroValueFor = (id) => {
      let table = macroValueCache.get(id);
      if (table === undefined && id && id !== 'default') {
        try { table = mergedMacros(loadStyles(), loadSession(id).macros); } catch { table = {}; }
        macroValueCache.set(id, table);
      }
      return table ?? {};
    };
    const providerFor = (name) => (context) => {
      const id = sessionIdOfAssemble(context) || learnedSessionId;
      const table = macroValueFor(id);
      if (name === 'user') {
        const v = String(table.user ?? '').trim();
        return v || cardUserLabel(loadStyles());
      }
      // 自动宏（time/date/…）：宏表里给过固定值就用它，否则当场算
      if (AUTO_MACROS.includes(name)) return autoMacroValue(name, table);
      return String(table[name] ?? '');
    };
    /** 在本作用域注册一个变量（幂等）。返回是否成功。 */
    const registerVar = (name) => {
      if (!MACRO_NAME_RE.test(name)) return false;
      if (owned.has(name)) return true;
      if (typeof sys.variable !== 'function') return false;
      try {
        const off2 = sys.variable(name, providerFor(name));
        ctx.effect(() => off2, `rp-tools: prompt variable ${name}`);
        owned.set(name, off2);
        return true;
      } catch (error) {
        console.warn(`[rp-tools] 注册 {{${name}}} 变量失败:`, error?.message ?? error);
        return false;
      }
    };
    /**
     * 记住「本作用域对应哪个会话」。装配上下文一给出来就学，
     * 之后路由侧（全局作用域）改完宏表也能回调进来补注册。
     */
    const bindSession = (id) => {
      const clean = normalizeSessionId(id);
      if (!clean || clean === 'default') return '';
      learnedSessionId = clean;
      macroVars.set(clean, owned);              // 别名：作用域里的注册结果
      macroRegistrars.set(clean, registerVar);  // 路由 → 本作用域补注册
      return clean;
    };

    sys.section({
      name: STANDING_SECTION,
      order: 210,
      text: '（本会话尚未设置跑团世界设定；若玩家问及世界观，请先用 rp_session 读取或录入。）',
    });
    // 每轮才变的内容（状态 / 世界书命中 / 在场角色）走 runtime context —— 与 standing 分开，
    // 这样常驻段的字节保持稳定，不会因为每轮命中不同而打穿前缀缓存。
    //
    // ⚠️ 注册文本给**空串**：宿主 `renderContextSections` 会把空文本丢掉，
    // 于是「这一轮没什么可注入」就**不会**产生快照消息。给固定短文案的话，
    // 每轮都会在「真实内容」和「占位文案」之间来回翻，等于每轮都提交一条快照。
    sys.context({ name: TURN_CONTEXT, order: 20, text: '' });

    // 作用域销毁时把别名一起清掉（否则会话 id 会一直指向一个已经 dispose 的 Map）
    ctx.effect(() => () => {
      for (const [k, v] of [...macroVars]) if (v === owned) macroVars.delete(k);
      for (const [k, v] of [...macroRegistrars]) if (v === registerVar) macroRegistrars.delete(k);
    }, 'rp-tools: macro bookkeeping');

    const cfgAtMount = loadStyles();
    if (learnedSessionId) {
      bindSession(learnedSessionId);
      const initial = loadSession(learnedSessionId).macros ?? {};
      macroValueCache.set(learnedSessionId, mergedMacros(cfgAtMount, initial));
      for (const name of Object.keys(initial)) registerVar(name);
    }
    registerVar('user');
    for (const name of AUTO_MACROS) registerVar(name);      // time/date… 自动宏：值当场算，用户不用填
    // 全局默认列表里的名字也要注册：世界书/角色卡里写了 `{{place}}` 而会话没填过它时，
    // 靠的就是这条兜底（不注册的话宿主严格插值会直接抛错）。
    for (const name of Object.keys(globalMacros(cfgAtMount))) registerVar(name);

    const off = ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      const result = await next();
      const before = Array.isArray(result?.sections)
        ? result.sections.filter((s) => s?.name === STANDING_SECTION)
        : [];
      try {
        // ⚠️ 会话 id 只能从这里取：`context` 是宿主为本轮装配构造的 AssembleContext，
        //    `context.agent`（= `context.scope`）就是本会话的 Agent。插件 ctx 上没有 agent 属性。
        const sessionId = bindSession(sessionIdOfAssemble(context));
        if (!sessionId) return result;
        const session = loadSession(sessionId);
        // 值缓存先刷新（provider 读它），再把**新出现**的名字补注册（全局默认 + 会话宏表）——
        // 用户刚在面板里加一个 `{{place}}`、或在设置页加一条默认值，下一轮装配就能用上。
        const cfgNow = loadStyles();
        macroValueCache.set(sessionId, mergedMacros(cfgNow, session.macros));
        for (const name of Object.keys(macroValueCache.get(sessionId) ?? {})) registerVar(name);
        refreshSessionMacros(sessionId, session.macros ?? {});
        /**
         * 哪些 `{{名字}}` 能留在文本里 —— **以本次装配的 variables 快照为准**，不是以我们的
         * 记账为准。宿主 `interpolate` 对未注册名和 `undefined` 值都是**直接抛错**，
         * 而 variables 是在 waterfall **之前**收集的：这一轮刚补注册的名字并不在快照里，
         * 若按记账放行就会把整轮装配打挂。留不住的名字由 neutralizeMustache 中和掉（下一轮就好了）。
         */
        const vars = result?.variables && typeof result.variables === 'object' ? result.variables : {};
        const known = new Set(Object.keys(vars).filter((k) => typeof vars[k] === 'string'));
        const sections = Array.isArray(result?.sections) ? result.sections.slice() : [];

        const constantEntries = loadLoreEntries(sessionId);
        const text = buildStandingText(session, {
          loreFile: sessionLorePath(sessionId)?.file,
          constants: constantEntries,
          macros: known,
        });
        if (text) {
          const at = sections.findIndex((s) => s?.name === STANDING_SECTION);
          const entry = { name: STANDING_SECTION, text };
          if (at >= 0) sections[at] = entry; else sections.push(entry);
        }

        // ── 每轮才变的内容：状态 + 世界书命中 + 在场角色的详细卡 ────────────
        const live = sessionRefs.get(sessionId);
        const messages = typeof live?.deriveMessages === 'function' ? live.deriveMessages() : [];
        const turnText = buildTurnContext(session, buildLoreCorpus(messages), {
          sessionId,
          turn: loreTurnOf(live),
          loreFile: sessionLorePath(sessionId)?.file,
        });
        if (turnText) {
          const contexts = Array.isArray(result?.contexts) ? result.contexts.slice() : [];
          const at = contexts.findIndex((c) => c?.name === TURN_CONTEXT);
          // runtime context 同样会被宿主严格插值 → 未注册的宏要在这里中和（世界书是用户手写的，什么都可能有）
          const entry = { name: TURN_CONTEXT, text: neutralizeMustache(turnText, known) };
          if (at >= 0) contexts[at] = entry; else contexts.push(entry);
          result.contexts = contexts;
        }
        result.sections = sections;
        writeStandingProbe(before, result, sessionId);
      } catch { /* 装配失败就用原样，不影响这一轮 */ }
      return result;
    });
    ctx.effect(() => off, 'rp-tools: standing prompt');
    return true;
  } catch { return false; }
}

/**
 * 本轮用哪个数字做确定性掷点的种子。
 *
 * `session.seq` 是「这个会话已经追加了多少事件」，随对话单调增长 ——
 * 拿它当轮次既稳定（同一轮内多次装配得到同一个值）又每轮变化，
 * 而且**重启/回放后依然是同一个值**，满足可复现要求。
 */
function loreTurnOf(session) {
  try {
    const seq = session?.seq;
    if (typeof seq === 'number') return seq;
    if (typeof seq?.valueOf === 'function') { const v = Number(seq); if (Number.isFinite(v)) return v; }
  } catch { /* 忽略 */ }
  return 0;
}

/**
 * 注入诊断：把「我们写入的 standing 段」和「宿主实际装配出的段清单」写一份探针文件。
 *
 * 为什么需要：宿主契约里有一句警告 ——
 * 「A registered complete section is restored after this waterfall, so listeners cannot add to
 *  or replace that scope's system prompt.」而 dm 预设的 persona 恰好注册了一个 complete 段。
 * 如果真的会被还原，我们的注入就是**静默失效**（不报错、只是没进上下文）。
 * 这个探针让我们能直接读文件确认，而不是靠猜。
 * 只在段名/文本变化时写盘，避免每轮都写。
 */
/**
 * 注入诊断：把「我们写入的 standing 段」与「宿主实际装配出的段清单」写一份探针文件。
 *
 * 为什么保留它：宿主契约里有一条「registered complete section is restored after this waterfall」的警告，
 * 而它是否适用于我们**只能实测**（实测结论：不适用，我们的段能留在返回的 assembly 里）。
 * 现在注入只发生在 dm 作用域，所以探针里的 `sessionId` 就是那个 DM 会话 —— 天然就是我们要查的对象。
 */
let standingProbeSig = '';
function writeStandingProbe(before, after, sessionId = '') {
  try {
    const entries = (arr) => (Array.isArray(arr) ? arr : []).map((s) => ({
      name: s?.name,
      chars: typeof s?.text === 'string' ? s.text.length : -1,
    }));
    // 判断我们的注入是否留在了返回给调用方的 assembly 里，以及其中是否含目标会话的世界设定
    const mine = (Array.isArray(after?.sections) ? after.sections : []).find((s) => s?.name === STANDING_SECTION);
    const turnCtx = (Array.isArray(after?.contexts) ? after.contexts : []).find((c) => c?.name === TURN_CONTEXT);
    const sid = normalizeSessionId(sessionId);
    const info = {
      at: new Date().toISOString(),
      sessionId: sid || null,
      // 会话与工作区：用来确认世界书文件到底有没有被找到
      sessionCwd: sessionCwd.get(sid) ?? null,
      loreFile: sessionLorePath(sid)?.file ?? null,
      loreEntries: loadLoreEntries(sid).length,
      // 每轮快照的字数（0 = 这一轮既没有状态也没有命中条目；常驻条目不在这个通道里）
      loreInjectedChars: typeof turnCtx?.text === 'string' ? turnCtx.text.length : 0,
      standingSectionExists: Boolean(mine),
      standingChars: typeof mine?.text === 'string' ? mine.text.length : 0,
      // 关键判据：注入内容里应当出现「本场跑团的世界观」这句我们自己写的话
      injectedContentPresent: typeof mine?.text === 'string' ? mine.text.includes('本场跑团的世界观') : false,
      sectionsBeforeWeWrote: entries(before),
      sectionsInReturnedAssembly: entries(after?.sections),
      sectionCount: Array.isArray(after?.sections) ? after.sections.length : -1,
    };
    const sig = JSON.stringify([info.standingChars, info.injectedContentPresent, info.sectionCount, info.loreEntries, info.loreInjectedChars, info.sectionsInReturnedAssembly.map((s) => s.name)]);
    if (sig === standingProbeSig) return;
    standingProbeSig = sig;
    mkdirSync(RP_DATA_DIR, { recursive: true });
    writeFileSync(join(RP_DATA_DIR, '_standing-probe.json'), JSON.stringify(info, null, 2) + '\n', 'utf8');
  } catch { /* 诊断失败不影响装配 */ }
}

function installRoutes(ctx) {
  ctx.inject(['webServer'], (hostCtx) => {
    // 记下宿主上下文：路由需要现查「这个会话的工作区」（ctx.get('sessions').get(id).header.cwd），
    // 见 liveSessionCwd —— 光靠 session/created 事件记的内存 Map 会漏掉没被本进程加载过的会话。
    hostSessionLookup = hostCtx;
    // 再取一次全局工具注册表：设置页要列出「**本机真实存在**的全局工具」供勾选放行
    // （换生图插件时工具名不一样，写死名单必然过时）。
    // ⚠️ `schemas()` 省略 scope = **全局视图**（`view(undefined)` 不套任何作用域限制），
    // 所以这里拿到的是全部全局工具，而不是「本作用域可见」的那一份。
    try {
      ctx.inject(['tools'], (toolCtx) => { hostToolsLookup = toolCtx; });
    } catch { /* 拿不到就不提供发现能力，设置页退化成手填 */ }
    hostCtx.effect(() => hostCtx.webServer.register({
      kind: 'exact',
      path: '/rp-tools/global-tools',
      handler: async (request, response) => {
        // GET  ：列出「本机全部全局工具」+ 当前的放行名单（设置页那张表据此渲染）
        // POST ：写入放行名单（持久化到 styles.json，dm-filter 会读它）
        if (request.method === 'GET') {
          try {
            const cfg = loadStyles();
            const all = listGlobalToolNames();
            const view = globalToolsAllowView(cfg);
            const allowSet = new Set(view.allow);
            sendJson(response, 200, {
              ok: true,
              ...view,
              // `available: null` = 查不到注册表（与「一个工具都没有」不是一回事，界面要分开说）
              available: all === null ? null : all.map((name) => ({
                name,
                checked: allowSet.has(name),
                imageLike: looksLikeImageTool(name),
                // 界面上给「关掉它会砸掉什么」留一句话的位置（不是锁定，只是提示）
                hint: TOOL_HINTS[name] ?? '',
              })),
              // 配置里有、但本机注册表里暂时没有的名字（插件没装 / 改名了）——也要显示出来，
              // 否则用户看不到自己配了什么，只能猜「为什么没生效」。
              missing: view.allow.filter((n) => all !== null && !all.includes(n)),
            });
          } catch (error) {
            sendJson(response, 500, { ok: false, error: String(error?.message ?? error) });
          }
          return;
        }
        if (request.method !== 'POST') { sendJson(response, 405, { ok: false, error: 'method not allowed' }); return; }
        if (!sameOrigin(request)) { sendJson(response, 403, { ok: false, error: 'cross-origin request rejected' }); return; }
        try {
          const body = await readJsonBody(request);
          const raw = body.allow ?? body.globalToolsAllow;
          if (!Array.isArray(raw)) { sendJson(response, 400, { ok: false, error: 'allow 必须是字符串数组（要放行的全局工具名）' }); return; }
          const cfg = loadStyles();
          cfg.globalToolsAllow = normalizeGlobalToolsAllow(raw);
          // 这是一次**用户显式选择**：打上一次性迁移标记，免得下次读盘又把出厂默认并回来
          // （否则「取消勾选 render_ui」会关不掉 —— 看着关成功、下一轮又回来）。
          cfg.globalToolsAllowMerged = true;
          saveStyles(cfg);
          sendJson(response, 200, {
            ok: true,
            ...globalToolsAllowView(cfg),
            note: '已保存 —— 下次打开 DM 会话生效（改的是预设过滤器读的那份配置）',
          });
        } catch (error) {
          sendJson(response, 400, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }), 'rp-tools: global-tools');

    hostCtx.effect(() => hostCtx.webServer.register({
      kind: 'exact',
      path: '/rp-tools/state',
      handler: (request, response) => {
        if (request.method !== 'GET') { sendJson(response, 405, { ok: false, error: 'method not allowed' }); return; }
        try {
          const cfg = loadStyles();
          sendJson(response, 200, {
            ok: true,
            file: RP_CONFIG_FILE,
            config: cfg,
            // 自动宏名单（时间/日期及其分量）：设置页要把「哪些宏不用填」提示出来，
            // 这件事只有宿主知道（`AUTO_MACROS`），别让界面再手抄一份。
            autoMacros: AUTO_MACROS,
          });
        } catch (error) {
          sendJson(response, 500, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }), 'rp-tools: state');

    hostCtx.effect(() => hostCtx.webServer.register({
      kind: 'exact',
      path: '/rp-tools/config',
      handler: async (request, response) => {
        if (request.method !== 'POST') { sendJson(response, 405, { ok: false, error: 'method not allowed' }); return; }
        if (!sameOrigin(request)) { sendJson(response, 403, { ok: false, error: 'cross-origin request rejected' }); return; }
        try {
          const body = await readJsonBody(request);
          let cfg = loadStyles();
          // 卡库目录 + 默认宏列表：与 `rp_config` 工具共用同一套归一化规则
          if (body.cards && typeof body.cards === 'object') {
            cfg = { ...cfg, cards: applyCardConfigPatch(cfg, { root: body.cards.root, macros: body.cards.macros }) };
          }
          if (body.campaign && typeof body.campaign === 'object') {
            // 全局 campaign 只有角色卡表（这是历史字段；会话级内容在 rp_session）
            cfg.campaign = {
              name: String(body.campaign.name ?? ''),
              prompt_prefix: String(body.campaign.prompt_prefix ?? ''),
              character_sheet: Array.isArray(body.campaign.character_sheet)
                ? body.campaign.character_sheet
                  .map(normalizeCharacter)
                  .filter((c) => CHARACTER_FIELDS.some((f) => c[f]))
                : [],
            };
          }
          saveStyles(cfg);
          sendJson(response, 200, { ok: true, config: cfg });
        } catch (error) {
          sendJson(response, 400, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }), 'rp-tools: config');

    // 注入自检（只读）：`GET /rp-tools/inject?sessionId=<会话 id>` 看某个会话**会**被注入什么。
    // 注入本身只发生在 dm 预设作用域（由 rp-bridge 调用 installStandingPrompt），
    // 这里只是把同一份拼装逻辑单独跑一遍给人看 —— 不参与运行，不需要猜任何东西。
    // 不传 sessionId 时列出所有有内容的会话，方便你挑一个来查。
    hostCtx.effect(() => hostCtx.webServer.register({
      kind: 'exact',
      path: '/rp-tools/inject',
      handler: (request, response) => {
        if (request.method !== 'GET') { sendJson(response, 405, { ok: false, error: 'method not allowed' }); return; }
        try {
          const url = new URL(request.url ?? '/', 'http://localhost');
          const wanted = normalizeSessionId(url.searchParams.get('sessionId') ?? '');
          if (wanted && wanted !== 'default') {
            const session = loadSession(wanted);
            const live = sessionRefs.get(wanted);
            const messages = typeof live?.deriveMessages === 'function' ? live.deriveMessages() : [];
            const standing = buildStandingText(session, { loreFile: sessionLorePath(wanted)?.file });
            const turn = buildTurnContext(session, buildLoreCorpus(messages), {
              sessionId: wanted, turn: loreTurnOf(live),
              loreFile: sessionLorePath(wanted)?.file,
            });
            sendJson(response, 200, {
              ok: true,
              sessionId: wanted,
              // 注意：只在会话属于 dm 预设时，这份内容才会真正进模型上下文
              isDm: isDmSession(wanted, session),
              sessionCwd: sessionCwd.get(wanted) ?? null,
              loreFile: sessionLorePath(wanted)?.file ?? null,
              standingChars: standing.length,
              turnChars: turn.length,
              standingPreview: standing.slice(0, 800),
              turnPreview: turn.slice(0, 800),
            });
            return;
          }
          const candidates = [];
          try {
            for (const f of readdirSync(SESSIONS_DIR)) {
              if (!f.endsWith('.json')) continue;
              try {
                const data = JSON.parse(readFileSync(join(SESSIONS_DIR, f), 'utf8'));
                const chars = Array.isArray(data?.characters) ? data.characters.length : 0;
                const worldLen = String(data?.world ?? '').length;
                if (chars || worldLen || (data?.state && Object.keys(data.state).length)) {
                  candidates.push({
                    sessionId: f.replace(/\.json$/, ''),
                    campaign: data?.campaign?.name ?? '',
                    worldChars: worldLen,
                    characters: chars,
                    isDm: isDmSession(f.replace(/\.json$/, ''), loadSession(f.replace(/\.json$/, ''))),
                  });
                }
              } catch { /* 跳过坏文件 */ }
            }
          } catch { /* 忽略 */ }
          sendJson(response, 200, {
            ok: true,
            note: '传 ?sessionId=<会话 id> 查看该会话会被注入什么。只有 dm 预设的会话才会真正注入。',
            candidates,
          });
        } catch (error) {
          sendJson(response, 500, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }), 'rp-tools: inject');


    hostCtx.effect(() => hostCtx.webServer.register({
      kind: 'exact',
      path: '/rp-tools/reset',
      handler: async (request, response) => {
        if (request.method !== 'POST') { sendJson(response, 405, { ok: false, error: 'method not allowed' }); return; }
        if (!sameOrigin(request)) { sendJson(response, 403, { ok: false, error: 'cross-origin request rejected' }); return; }
        try {
          const fresh = defaultConfig();
          saveStyles(fresh);
          sendJson(response, 200, { ok: true, config: fresh });
        } catch (error) {
          sendJson(response, 500, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }), 'rp-tools: reset');


    // 会话级配置：读/写某个会话的 RP 设置（角色卡 / 世界 / 前缀 / 战役名 / 宏表 / 随机表 / DM 设定）
    hostCtx.effect(() => hostCtx.webServer.register({
      kind: 'exact',
      path: '/rp-tools/session',
      handler: async (request, response) => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        const sessionId = url.searchParams.get('sessionId') ?? '';

        if (request.method === 'GET') {
          if (!sessionId) { sendJson(response, 400, { ok: false, error: 'sessionId is required' }); return; }
          try {
            const session = loadSession(sessionId);
            const dmIndex = loadDmIndex();
            const id = normalizeSessionId(sessionId);
            sendJson(response, 200, {
              ok: true,
              isDm: isDmSession(id, session),
              preset: dmIndex[id]?.preset ?? dmIndex[`session-${id}`]?.preset ?? session.preset ?? '',
              // 会话工作区：界面拼卡库 / 卡面 URL 时要带回去（卡库默认 = <工作区>/rp-cards）
              // 走完整解析链（内存 → 宿主注册表现查 → 落盘的），不能只看内存 Map：
              // 重启后恢复的会话不在 Map 里，界面就会拿到 null，卡库路径随之落空。
              cwd: resolveWorkspaceDir(id, url.searchParams.get('workspace')),
              session,
            });
          } catch (error) {
            sendJson(response, 500, { ok: false, error: String(error?.message ?? error) });
          }
          return;
        }

        if (request.method === 'POST') {
          if (!sameOrigin(request)) { sendJson(response, 403, { ok: false, error: 'cross-origin request rejected' }); return; }
          try {
            const body = await readJsonBody(request);
            const id = String(body.sessionId ?? '');
            if (!id) { sendJson(response, 400, { ok: false, error: 'sessionId is required' }); return; }
            const session = loadSession(id);
            if (body.world !== undefined) session.world = String(body.world);
            // 宏表（**按会话隔离**）：整体替换（面板提交的就是完整表）。存完立刻把新名字注册到
            // **本会话的 agent 作用域**，这样下一轮装配里的 `{{新名字}}` 就能被宿主正确插值。
            if (body.macros && typeof body.macros === 'object') {
              session.macros = normalizeMacros(body.macros);
              macroValueCache.set(normalizeSessionId(id), mergedMacros(loadStyles(), session.macros));
              refreshSessionMacros(id, session.macros);
            }
            if (body.campaign && typeof body.campaign === 'object') {
              // 会话 campaign 只有战役名 + 提示词前缀
              session.campaign = {
                name: String(body.campaign.name ?? ''),
                prompt_prefix: String(body.campaign.prompt_prefix ?? ''),
              };
            }
            if (Array.isArray(body.characters)) {
              session.characters = body.characters
                .map(normalizeCharacter)
                .filter((c) => CHARACTER_FIELDS.some((f) => c[f]));
            }
            if (Array.isArray(body.characterIndex)) {
              session.characterIndex = body.characterIndex
                .map((e) => normalizeIndexEntry(e))
                .filter((e) => e.name);
            }
            // DM 设定（本会话）：DM 自己的规则文本，会话隔离。
            // 面板提交的是完整对象；只收认识的键，非法值不动旧值。
            if (body.dm && typeof body.dm === 'object') {
              session.dm = {
                prompt: typeof body.dm.prompt === 'string' ? body.dm.prompt : session.dm?.prompt ?? '',
                migrated: [],                                  // 用户保存过就清掉「迁移提示」
              };
            }
            // 状态：走 applyStateUpdates 而不是整体替换 —— 面板只提交改动的字段，
            // 空串即清除，与 rp_state 工具同一套语义。
            if (body.state && typeof body.state === 'object') {
              session.state = applyStateUpdates(session.state, body.state, { seq: 0 });
            }
            if (Array.isArray(body.tables)) {
              session.tables = body.tables
                .filter((t) => t && t.name)
                .map((t) => ({
                  name: String(t.name),
                  dice: String(t.dice ?? `1d${Array.isArray(t.entries) && t.entries.length ? t.entries.length : 1}`),
                  entries: Array.isArray(t.entries) ? t.entries.map((e) => String(e)) : [],
                }));
            }
            if (!saveSession(session)) throw new Error(`无法写入 ${sessionFile(id)}`);
            sendJson(response, 200, { ok: true, session });
          } catch (error) {
            sendJson(response, 400, { ok: false, error: String(error?.message ?? error) });
          }
          return;
        }
        sendJson(response, 405, { ok: false, error: 'method not allowed' });
      },
    }), 'rp-tools: session');

    // dm 会话登记：桥接插件与客户端（读到 agentPreset==='dm' 时）都会调它。
    // 写两处：登记表（供快速查表）+ 会话文件（跟着会话走，界面/工具两侧都能读到）。
    hostCtx.effect(() => hostCtx.webServer.register({
      kind: 'exact',
      path: '/rp-tools/dm-mark',
      handler: async (request, response) => {
        if (request.method !== 'POST') { sendJson(response, 405, { ok: false, error: 'method not allowed' }); return; }
        if (!sameOrigin(request)) { sendJson(response, 403, { ok: false, error: 'cross-origin request rejected' }); return; }
        try {
          const body = await readJsonBody(request);
          const id = String(body.sessionId ?? '');
          if (!id) { sendJson(response, 400, { ok: false, error: 'sessionId is required' }); return; }
          const preset = String(body.preset ?? 'dm');
          // 先读文件再登记：读失败不该被登记「掩盖」过去。
          const session = loadSession(id);
          markDmSession(id, preset);
          if (session.preset !== preset) { session.preset = preset; saveSession(session); }
          sendJson(response, 200, { ok: true, sessionId: id, preset });
        } catch (error) {
          sendJson(response, 400, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }), 'rp-tools: dm-mark');

    // 工具清单 + 参数说明（设置页展示用，直接读插件自己注册的工具定义）
    hostCtx.effect(() => hostCtx.webServer.register({
      kind: 'exact',
      path: '/rp-tools/tools',
      handler: (request, response) => {
        if (request.method !== 'GET') { sendJson(response, 405, { ok: false, error: 'method not allowed' }); return; }
        // 全部 rp_* 工具都在 rpTools 里（全局不再注册任何工具，所以没有第二个数组）
        const list = rpTools.map((tool) => ({
          name: tool.name,
          description: tool.description ?? '',
          parameters: Object.entries(tool.parameters ?? {}).map(([pname, spec]) => ({
            name: pname,
            type: Array.isArray(spec?.type) ? 'enum' : String(spec?.type ?? 'any'),
            required: spec?.required === true,
            description: spec?.description ?? '',
          })),
        }));
        sendJson(response, 200, { ok: true, tools: list });
      },
    }), 'rp-tools: tools');

    // 掷表（面板上的「掷」按钮用；与 rp_table 工具同一套逻辑）
    hostCtx.effect(() => hostCtx.webServer.register({
      kind: 'exact',
      path: '/rp-tools/roll',
      handler: async (request, response) => {
        if (request.method !== 'POST') { sendJson(response, 405, { ok: false, error: 'method not allowed' }); return; }
        if (!sameOrigin(request)) { sendJson(response, 403, { ok: false, error: 'cross-origin request rejected' }); return; }
        try {
          const body = await readJsonBody(request);
          const session = loadSession(String(body.sessionId ?? 'default'));
          const table = (session.tables ?? []).find((t) => String(t.name) === String(body.name ?? ''));
          if (!table) {
            sendJson(response, 404, { ok: false, error: `没有名为 "${body.name ?? ''}" 的表` });
            return;
          }
          const parsed = parseDice(table.dice);
          const rnd = makeRng(body.seed);
          const times = resolveRollCount(body.count);
          const lines = [];
          for (let i = 0; i < times; i++) {
            const { sum, detail } = rollDice(parsed, rnd);
            const entry = table.entries[(sum - 1) % table.entries.length] ?? table.entries[0];
            lines.push(`${table.dice} → ${sum}（${detail}）→ ${entry}`);
          }
          sendJson(response, 200, {
            ok: true,
            note: `🎲 ${table.name}（${table.dice}，${table.entries.length} 条）`,
            lines,
          });
        } catch (error) {
          sendJson(response, 400, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }), 'rp-tools: roll');


    // ── 立绘：清理老版本留下的「生成的立绘」死引用 ────────────────────────
    // 1.15.0 起本插件不再出图，这条路由只保留 `action:"clear"`：把 `portraits[name].generated`
    // 抹掉（那是 1.14.x 存的 ComfyUI (file, subfolder, type)，媒体代理 `/rp-tools/media` 已删，
    // 留着就是死链）。**卡面（`card`）与玩家导入的立绘（`imported`）都不动**。
    // 导入立绘走 `/rp-tools/asset-upload`（kind=portrait + name）。
    hostCtx.effect(() => hostCtx.webServer.register({
      kind: 'exact',
      path: '/rp-tools/portrait',
      handler: async (request, response) => {
        if (request.method !== 'POST') { sendJson(response, 405, { ok: false, error: 'method not allowed' }); return; }
        if (!sameOrigin(request)) { sendJson(response, 403, { ok: false, error: 'cross-origin request rejected' }); return; }
        try {
          const body = await readJsonBody(request, 65536);
          // 注意用**原始** id 判空：normalizeSessionId('') 会返回 'default'，
          // 拿归一化后的值判空等于把匿名请求记到 default 这个桶里（串台的老毛病）
          const rawId = String(body.sessionId ?? '').trim();
          if (!rawId) { sendJson(response, 400, { ok: false, error: 'sessionId is required' }); return; }
          const id = normalizeSessionId(rawId);
          const name = String(body.name ?? '').trim();
          if (!name) { sendJson(response, 400, { ok: false, error: 'name is required' }); return; }
          const session = loadSession(id);
          const portraits = { ...(session.portraits ?? {}) };
          // 生成本身已移出本插件（配图走宿主的 `generate_image`），这条路由现在只做清理：
          // 清掉老版本留下的 `generated`（那是指向 ComfyUI output 的死引用）。
          // **卡面（`card`）与用户导入的立绘（`imported`）都不动** —— 它们是另外两份东西；
          // 导入立绘走 `/rp-tools/asset-upload`（kind=portrait）。
          //
          // ⚠️ 默认值是 `save`（不是 `clear`）：老版本这条路由 `action` 缺省时语义就是「保存生成结果」，
          // 把缺省当 `clear` 会让**老调用静默变成删除**。所以只认显式的 `clear`，别的（含缺省）
          // 一律 400 并说清该走哪条路。
          if (String(body.action ?? 'save') !== 'clear') {
            sendJson(response, 400, { ok: false, error: '本插件不再生成图片；这条路由只支持 action:"clear"（导入立绘用 /rp-tools/asset-upload）' });
            return;
          }
          // 连生成产物的字段一起挡住：带着 file/subfolder/type 来「clear」多半是没改完的老调用，
          // 报错比静默清掉更好查。
          const strayKeys = ['file', 'subfolder', 'type', 'style', 'elapsedMs'].filter((k) => body[k] !== undefined);
          if (strayKeys.length) {
            sendJson(response, 400, { ok: false, error: `action:"clear" 不接受生成产物的字段（${strayKeys.join(' / ')}）—— 导入立绘用 /rp-tools/asset-upload` });
            return;
          }
          const cur = { ...(portraits[name] ?? {}) };
          delete cur.generated;
          delete cur.style;
          delete cur.elapsedMs;
          delete cur.at;
          if (Object.keys(cur).length) portraits[name] = cur;
          else delete portraits[name];
          session.portraits = portraits;
          const saved = saveSession(session);
          sendJson(response, saved ? 200 : 500, { ok: saved, sessionId: id, portraits, error: saved ? undefined : '会话配置写入失败' });
        } catch (error) {
          sendJson(response, 500, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }), 'rp-tools: portrait');

    // ── 资源库：导入外部图片 ────────────────────────────────────────────────
    // 前端把用户选的图读成 data URL 传上来（浏览器不能把本地路径交给服务端）。落进
    // `assets/<分类>/<id>.<ext>` 并登记进索引；`kind=portrait` 且给了角色名时，**顺带**
    // 把它登记成该角色的立绘（复用 `portraits[name].imported`，指向同一个文件，不复制）。
    //
    // 只承认 png/jpeg/webp、上限 8MB：这是用户自己的图，不是不可信输入，但仍要挡住路径穿越
    // 与超大 body。**文件名由宿主生成**（`newAssetId`）—— 用户/模型给的字符串永不进路径。
    const handleAssetUpload = async (request, response) => {
      if (request.method !== 'POST') { sendJson(response, 405, { ok: false, error: 'method not allowed' }); return; }
      if (!sameOrigin(request)) { sendJson(response, 403, { ok: false, error: 'cross-origin request rejected' }); return; }
      try {
        const body = await readJsonBody(request, ASSET_MAX_BYTES * 2);
        const rawId = String(body.sessionId ?? '').trim();
        if (!rawId) { sendJson(response, 400, { ok: false, error: 'sessionId is required' }); return; }
        const id = normalizeSessionId(rawId);
        const kind = assetKindOf(body.kind ?? 'portrait');
        const name = String(body.name ?? '').trim();
        if (kind === 'portrait' && !name) {
          sendJson(response, 400, { ok: false, error: '导入角色立绘要带 name（角色名），否则不知道该挂给谁' });
          return;
        }
        const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(body.dataUrl ?? ''));
        if (!m) { sendJson(response, 400, { ok: false, error: '只支持 png / jpeg / webp 的图片（data URL 形式）' }); return; }
        const ext = ASSET_MIME_EXT[m[1]];
        const buffer = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
        if (!buffer.length) { sendJson(response, 400, { ok: false, error: '图片内容为空' }); return; }
        if (buffer.length > ASSET_MAX_BYTES) {
          sendJson(response, 413, { ok: false, error: `图片太大（${Math.round(buffer.length / 1024 / 1024)}MB，上限 8MB）` });
          return;
        }
        if (!assetIndexPath(id, body.workspace)) { sendJson(response, 400, { ok: false, error: '拿不到本会话的工作区目录' }); return; }
        const entry = await archiveAsset(id, {
          bytes: buffer, kind, ext,
          label: String(body.label ?? '').trim() || name || `导入的${ASSET_KIND_LABEL[kind]}`,
          tags: body.tags,
          characters: kind === 'portrait' && name ? [name] : [],
          source: 'imported',
          prompt: String(body.note ?? ''),
        });
        if (!entry) { sendJson(response, 500, { ok: false, error: '写不进资源库（检查会话工作区是否可写）' }); return; }
        if (kind === 'portrait' && name) {
          const session = loadSession(id);
          session.portraits = {
            ...(session.portraits ?? {}),
            [name]: {
              ...(session.portraits?.[name] ?? {}),
              imported: { file: entry.file, bytes: entry.bytes, at: entry.at },
            },
          };
          saveSession(session);
        }
        sendJson(response, 200, {
          ok: true, sessionId: id, kind, name, bytes: entry.bytes,
          asset: entry, file: entry.file,
          url: assetUrl(id, entry.id),
          portraits: loadSession(id).portraits,
        });
      } catch (error) {
        sendJson(response, 500, { ok: false, error: String(error?.message ?? error) });
      }
    };
    hostCtx.effect(() => hostCtx.webServer.register({
      kind: 'exact',
      path: '/rp-tools/asset-upload',
      handler: handleAssetUpload,
    }), 'rp-tools: asset-upload');
    // 兼容 1.12.10 的名字（那时只有立绘能导入）；行为完全一样，只是默认 kind=portrait。
    hostCtx.effect(() => hostCtx.webServer.register({
      kind: 'exact',
      path: '/rp-tools/portrait-upload',
      handler: handleAssetUpload,
    }), 'rp-tools: portrait-upload');

    // ── 资源库：面板读写索引 ────────────────────────────────────────────────
    // GET ：列出（可按分类/角色/标签/关键词过滤），带上每个分类的条数 —— 面板的筛选条用它。
    // POST：action = update（改 label/tags）/ delete（连文件一起删）/ useAsPortrait（提成某角色的立绘）。
    // 所有写索引的路径都过 `withAssetLock`：出图是并发的，read-modify-write 会丢记录。
    hostCtx.effect(() => hostCtx.webServer.register({
      kind: 'exact',
      path: '/rp-tools/assets',
      handler: async (request, response) => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        if (request.method === 'GET') {
          try {
            const rawId = String(url.searchParams.get('sessionId') ?? '').trim();
            if (!rawId) { sendJson(response, 400, { ok: false, error: 'sessionId is required' }); return; }
            const id = normalizeSessionId(rawId);
            const found = queryAssets(id, {
              kind: url.searchParams.get('kind') ?? '',
              q: url.searchParams.get('q') ?? '',
              characters: parseAssetTags(url.searchParams.get('characters') ?? ''),
              tags: url.searchParams.get('tags') ?? '',
              limit: url.searchParams.get('limit') ?? '',
            });
            sendJson(response, 200, {
              ok: true, sessionId: id, total: found.total, counts: found.counts,
              // 分类清单（key + 中文名 + 条数）：面板直接渲染筛选条，不必自己维护一份映射
              kinds: ASSET_KINDS.map((k) => ({ key: k, label: ASSET_KIND_LABEL[k], count: found.counts[k] })),
              assets: found.assets.map((a) => ({
                ...a,
                url: assetUrl(id, a.id),
                previewUrl: assetPreviewUrl(id, a.id, 480),
              })),
            });
          } catch (error) {
            sendJson(response, 500, { ok: false, error: String(error?.message ?? error) });
          }
          return;
        }
        if (request.method !== 'POST') { sendJson(response, 405, { ok: false, error: 'method not allowed' }); return; }
        if (!sameOrigin(request)) { sendJson(response, 403, { ok: false, error: 'cross-origin request rejected' }); return; }
        try {
          const body = await readJsonBody(request, 1048576);
          const rawId = String(body.sessionId ?? '').trim();
          if (!rawId) { sendJson(response, 400, { ok: false, error: 'sessionId is required' }); return; }
          const id = normalizeSessionId(rawId);
          const action = String(body.action ?? 'update');
          const assetId = String(body.id ?? '').trim();
          if (!assetId) { sendJson(response, 400, { ok: false, error: 'id is required' }); return; }

          if (action === 'useAsPortrait') {
            // 提成某角色的立绘：只改**引用**（不复制文件）。
            // 必须**清掉 generated** —— 读取端 `portraitsFromSession` 优先用 generated，
            // 留着它的话用户点了「设为立绘」却看不到任何变化（静默失效，很难查）。
            const name = String(body.name ?? '').trim();
            if (!name) { sendJson(response, 400, { ok: false, error: 'name is required（要给哪个角色）' }); return; }
            const entry = loadAssets(id).assets.find((a) => a.id === assetId);
            if (!entry) { sendJson(response, 404, { ok: false, error: '没有这条资源' }); return; }
            const session = loadSession(id);
            const cur = { ...(session.portraits?.[name] ?? {}) };
            delete cur.generated;
            session.portraits = {
              ...(session.portraits ?? {}),
              [name]: { ...cur, imported: { file: entry.file, bytes: entry.bytes, at: new Date().toISOString() } },
            };
            const saved = saveSession(session);
            sendJson(response, saved ? 200 : 500, {
              ok: saved, sessionId: id, name, assetId,
              portraits: session.portraits,
              error: saved ? undefined : '会话配置写入失败',
            });
            return;
          }

          const result = await withAssetLock(id, () => {
            const index = loadAssets(id);
            const at = index.assets.findIndex((a) => a.id === assetId);
            if (at < 0) return { missing: true };
            const entry = index.assets[at];
            if (action === 'delete') {
              index.assets.splice(at, 1);
              const p = assetIndexPath(id);
              let fileGone = false;
              try {
                const abs = join(p.dir, entry.file);
                if (abs.startsWith(p.dir + sep) && existsSync(abs)) {
                  // **以磁盘状态为准**，不是「rmSync 没抛错就算删了」（见 removeFileVerified 的注释）
                  fileGone = removeFileVerified(abs);
                } else {
                  fileGone = !existsSync(abs);              // 本来就不在，也算「没有残留文件」
                }
              } catch { /* 文件删不掉也要把索引清了，否则会一直显示一张打不开的图 */ }
              return { deleted: true, entry, fileGone, saved: saveAssets(id, index) };
            }
            // update：只改 label / tags（别的字段由归档流程维护，界面不碰）
            if (body.label !== undefined) entry.label = String(body.label).trim().slice(0, ASSET_LABEL_MAX);
            if (body.tags !== undefined) entry.tags = parseAssetTags(body.tags);
            return { entry, saved: saveAssets(id, index) };
          });
          if (result.missing) { sendJson(response, 404, { ok: false, error: '没有这条资源' }); return; }

          if (result.deleted) {
            // 删掉的图如果正被当成某个角色的立绘，那条引用会变成死链 —— 顺手清掉并告诉界面。
            const session = loadSession(id);
            const dropped = [];
            for (const [name, entry] of Object.entries(session.portraits ?? {})) {
              if (entry?.imported?.file === result.entry.file) {
                const cur = { ...entry };
                delete cur.imported;
                if (Object.keys(cur).length) session.portraits[name] = cur; else delete session.portraits[name];
                dropped.push(name);
              }
            }
            if (dropped.length) saveSession(session);
            sendJson(response, 200, {
              ok: true, sessionId: id, action, id: assetId,
              fileGone: result.fileGone === true, droppedPortraits: dropped,
            });
            return;
          }
          sendJson(response, 200, { ok: result.saved === true, sessionId: id, action, asset: result.entry });
        } catch (error) {
          sendJson(response, 500, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }), 'rp-tools: assets');

    // 发资源图。**只认索引里登记过的那条**（不接任意路径），再解析到会话目录内校验前缀 ——
    // 两条一起挡住路径穿越。`thumb=1&width=N` 走服务端降采样（图墙不能原图直出）。
    hostCtx.effect(() => hostCtx.webServer.register({
      kind: 'exact',
      path: '/rp-tools/asset-image',
      handler: (request, response) => {
        if (request.method !== 'GET') { response.writeHead(405, { allow: 'GET' }); response.end(); return; }
        try {
          const url = new URL(request.url ?? '/', 'http://localhost');
          const rawId = String(url.searchParams.get('sessionId') ?? '').trim();
          const assetId = String(url.searchParams.get('id') ?? '').trim();
          if (!rawId || !assetId) { sendJson(response, 400, { ok: false, error: 'sessionId / id is required' }); return; }
          const id = normalizeSessionId(rawId);
          const entry = loadAssets(id).assets.find((a) => a.id === assetId);
          if (!entry) { sendJson(response, 404, { ok: false, error: '没有这条资源' }); return; }
          const p = assetIndexPath(id);
          if (!p) { sendJson(response, 404, { ok: false, error: '拿不到本会话的工作区目录' }); return; }
          const abs = resolve(p.dir, String(entry.file));
          if (!abs.startsWith(p.dir + sep)) { sendJson(response, 400, { ok: false, error: '路径越界' }); return; }
          if (!/\.(png|jpe?g|webp)$/i.test(abs) || !existsSync(abs)) { sendJson(response, 404, { ok: false, error: '资源文件不存在' }); return; }
          let buffer = readFileSync(abs);
          const isPng = /\.png$/i.test(abs);
          const type = isPng ? 'image/png' : (/\.webp$/i.test(abs) ? 'image/webp' : 'image/jpeg');
          if (url.searchParams.get('thumb') === '1') {
            const want = Number(url.searchParams.get('width'));
            const maxW = Math.min(1024, Math.max(48, Number.isFinite(want) && want > 0 ? want : 480));
            // 缩略图只对 PNG 有效（png-thumb 是纯 zlib 的 PNG 解码器）；jpeg/webp 原样发。
            buffer = (isPng ? thumbFor(abs, buffer, maxW) : null) ?? buffer;
          }
          response.writeHead(200, {
            'content-type': type,
            'content-length': String(buffer.length),
            // 按 id 取，内容永不变 → 可以长缓存（换图必然换 id）
            'cache-control': 'private, max-age=86400',
          });
          response.end(buffer);
        } catch (error) {
          sendJson(response, 404, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }), 'rp-tools: asset-image');

    // 把导入的立绘发给浏览器。**只认会话配置里记下的那张**（不接任意路径），
    // 再把它解析到本会话目录内并校验前缀 —— 两条一起挡住路径穿越。
    hostCtx.effect(() => hostCtx.webServer.register({
      kind: 'exact',
      path: '/rp-tools/portrait-image',
      handler: (request, response) => {
        if (request.method !== 'GET') { response.writeHead(405, { allow: 'GET' }); response.end(); return; }
        try {
          const url = new URL(request.url ?? '/', 'http://localhost');
          const rawId = String(url.searchParams.get('sessionId') ?? '').trim();
          const name = String(url.searchParams.get('name') ?? '').trim();
          if (!rawId || !name) { sendJson(response, 400, { ok: false, error: 'sessionId / name is required' }); return; }
          const id = normalizeSessionId(rawId);
          const relFile = loadSession(id).portraits?.[name]?.imported?.file;
          if (!relFile) { sendJson(response, 404, { ok: false, error: '这个角色没有导入的立绘' }); return; }
          const sessionDir = ensureSessionLore(id)?.dir;
          if (!sessionDir) { sendJson(response, 404, { ok: false, error: '拿不到本会话的工作区目录' }); return; }
          const abs = resolve(sessionDir, String(relFile));
          if (!abs.startsWith(sessionDir + sep)) { sendJson(response, 400, { ok: false, error: '路径越界' }); return; }
          if (!/\.(png|jpe?g|webp)$/i.test(abs) || !existsSync(abs)) { sendJson(response, 404, { ok: false, error: '立绘图不存在' }); return; }
          const buffer = readFileSync(abs);
          const type = /\.png$/i.test(abs) ? 'image/png' : (/\.webp$/i.test(abs) ? 'image/webp' : 'image/jpeg');
          response.writeHead(200, {
            'content-type': type,
            'content-length': String(buffer.length),
            'cache-control': 'private, max-age=3600',
          });
          response.end(buffer);
        } catch (error) {
          sendJson(response, 404, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }), 'rp-tools: portrait-image');


    // ── 世界书：读条目 / 改条目（RP 面板「世界书」卡片用）────────────────
    // 世界书文件在会话工作区里（`rp-worldbook.md`），DM / 用户都能直接改。
    // GET  ：列出全部条目（只有 160 字预览）；`?title=` 取某一条的完整正文（编辑器用）。
    // POST ：add / update / delete —— **只重写被改的那一条**，其它块（含用户手写的注释）原样保留。
    hostCtx.effect(() => hostCtx.webServer.register({
      kind: 'exact',
      path: '/rp-tools/lore',
      handler: async (request, response) => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        const id = normalizeSessionId(url.searchParams.get('sessionId') ?? '');
        const workspace = resolveWorkspaceDir(id, url.searchParams.get('workspace'));

        if (request.method === 'POST') {
          if (!sameOrigin(request)) { sendJson(response, 403, { ok: false, error: 'cross-origin request rejected' }); return; }
          try {
            const body = await readJsonBody(request, 1048576);
            const sid = normalizeSessionId(body.sessionId);
            const wsDir = resolveWorkspaceDir(sid, body.workspace);
            if (!wsDir) { sendJson(response, 400, { ok: false, error: '拿不到这个会话的工作区目录' }); return; }
            // 世界书按会话隔离（老版本在工作区根目录，这里会自动迁移一份过来）
            const lorePath = ensureSessionLore(sid, wsDir);
            const file = lorePath?.file ?? join(wsDir, LORE_FILE_NAME);
            mkdirSync(dirname(file), { recursive: true });
            const current = existsSync(file) ? readFileSync(file, 'utf8') : `${loreTemplateText().split('\n\n## ')[0]}\n`;
            const result = applyLoreEdit(current, String(body.action ?? ''), {
              title: body.title, entry: body.entry,
              // 只有 importLegacy 用得上：旧版共享世界书的绝对路径（由 GET 返回给界面）
              legacyFile: body.legacyFile || lorePath?.legacy,
            });
            if (!result.ok) { sendJson(response, 400, { ok: false, error: result.error, action: result.action }); return; }
            writeFileAtomic(file, result.text);
            loreCache.delete(sid);                     // 缓存按 mtime 失效，这里再主动清一次更稳
            const entries = parseLoreMarkdown(result.text);
            const diag = loreNameConflicts(entries, { characterNames: sessionCharacterNames(sid) });
            sendJson(response, 200, {
              ok: true,
              action: result.action,
              title: result.title,
              changed: result.changed,
              lines: result.lines,
              imported: result.imported,
              renamed: result.renamed,
              file,
              relative: `${LORE_SESSION_DIR}/${sid}/${LORE_FILE_NAME}`,
              chars: result.text.length,
              ...loreOverview(entries),
              // 只把「与人物卡重名」这一种诊断给出去（byTitle 是内部查表，不进接口）
              characterOverlap: diag.characterOverlap,
              entries: (() => {
                const budget = { left: LORE_VIEW_TOTAL_CHARS };
                return entries.slice(0, 400).map((e) => ({
                  ...loreEntryView(e, budget),
                  nameConflict: diag.byTitle[e.title] ?? '',
                }));
              })(),
              truncated: entries.length > 400,
              note: '只有命中的条目才进每轮上下文；导入的常驻条目按触发词走 runtime（不占系统提示）；空壳条目（正文只有模板残留）一律不注入。文件可直接编辑，DM 也能用 read/write 维护。',
            });
          } catch (error) {
            sendJson(response, 400, { ok: false, error: String(error?.message ?? error) });
          }
          return;
        }

        if (request.method !== 'GET') { sendJson(response, 405, { ok: false, error: 'method not allowed' }); return; }
        try {
          if (!workspace) {
            sendJson(response, 200, { ok: true, exists: false, file: null, entries: [], ...loreOverview([]), hint: '拿不到这个会话的工作区目录' });
            return;
          }
          const lorePath = ensureSessionLore(id, workspace);
          const file = lorePath?.file ?? join(workspace, LORE_FILE_NAME);
          const exists = existsSync(file);
          const text = exists ? readFileSync(file, 'utf8') : '';
          const entries = exists ? parseLoreMarkdown(text) : [];
          const diag = loreNameConflicts(entries, { characterNames: sessionCharacterNames(id) });
          const budget = { left: LORE_VIEW_TOTAL_CHARS };

          // ?title= ：取单条的完整正文（编辑器展开时才要，列表不必背着几十万字）
          const wantTitle = url.searchParams.get('title');
          if (wantTitle !== null) {
            const found = entries.find((e) => e.title === wantTitle);
            if (!found) { sendJson(response, 404, { ok: false, error: `找不到条目：${wantTitle}` }); return; }
            const cut = found.body.slice(0, LORE_DETAIL_BODY_CHARS);
            sendJson(response, 200, {
              ok: true,
              entry: {
                ...loreEntryView(found),
                body: cut,
                chars: found.body.length,
                truncated: cut.length < found.body.length,
              },
            });
            return;
          }

          sendJson(response, 200, {
            ok: true,
            exists,
            file,
            relative: `${LORE_SESSION_DIR}/${id}/${LORE_FILE_NAME}`,
            // 旧版共享世界书（工作区根目录）是否存在：存在就提示用户「要不要并进来」，但不自动迁
            legacyExists: lorePath?.legacyExists === true,
            legacy: lorePath?.legacy,
            chars: text.length,
            ...loreOverview(entries),
            // 只把「与人物卡重名」这一种诊断给出去（byTitle 是内部查表，不进接口）
              characterOverlap: diag.characterOverlap,
            // 正文一起给（面板要能直接读完）；预算见 LORE_VIEW_TOTAL_CHARS
            entries: entries.slice(0, 400).map((e) => ({
              ...loreEntryView(e, budget),
              nameConflict: diag.byTitle[e.title] ?? '',
            })),
            truncated: entries.length > 400,
            note: '只有命中的条目才进每轮上下文；导入的常驻条目按触发词走 runtime（不占系统提示）；空壳条目（正文只有模板残留）一律不注入。文件可直接编辑，DM 也能用 read/write 维护。',
          });
        } catch (error) {
          sendJson(response, 400, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }), 'rp-tools: lore');

    // ── 设定整备指令：让 DM 把导入的设定收一次尾（面板上的「整理设定」按钮用）──
    // 已开局的会话发不了开场指令，但同样需要这一步：导入是规则解码，
    // 「当前进度 / 前情提要 / 物品清单」这类会过期的条目得由 DM 看着删或改成触发式。
    hostCtx.effect(() => hostCtx.webServer.register({
      kind: 'exact',
      path: '/rp-tools/tidy',
      handler: async (request, response) => {
        if (request.method !== 'POST') { sendJson(response, 405, { ok: false, error: 'method not allowed' }); return; }
        if (!sameOrigin(request)) { sendJson(response, 403, { ok: false, error: 'cross-origin request rejected' }); return; }
        try {
          const body = await readJsonBody(request);
          const id = normalizeSessionId(body.sessionId ?? '');
          const session = loadSession(id);
          const entries = loadLoreEntries(id);
          const text = buildTidyPrompt({
            worldFile: sessionLorePath(id)?.file,
            character: session.characters?.[0]?.name ?? '',
            loreTitles: entries.map((e) => e.title),
            when: 'now',
          });
          sendJson(response, 200, { ok: true, text, entries: entries.length });
        } catch (error) {
          sendJson(response, 400, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }), 'rp-tools: tidy');

    // ── PNG 故事书：列卡库 ────────────────────────────────────────────
    // 只读；服务端过滤 + 分页（本机索引 480KB，整个丢给浏览器不划算）。
    hostCtx.effect(() => hostCtx.webServer.register({
      kind: 'exact',
      path: '/rp-tools/cards',
      handler: async (request, response) => {
        if (request.method !== 'GET') { sendJson(response, 405, { ok: false, error: 'method not allowed' }); return; }
        try {
          const url = new URL(request.url ?? '/', 'http://localhost');
          const cfg = loadStyles();
          // 卡库默认跟着**会话工作区**走（<工作区>/rp-cards）；客户端把 cwd 传上来
          const wsHint = resolveWorkspaceDir(url.searchParams.get('sessionId') ?? '', url.searchParams.get('workspace'));
          const root = cardLibraryRoot(cfg, wsHint);
          if (!root) {
            sendJson(response, 200, {
              ok: true, root: '', rootSource: 'none', exists: false, indexSource: 'scan',
              librarySize: 0, total: 0, items: [], categories: [],
              hint: '拿不到会话工作区，无法定位卡库（默认是 <工作区>/rp-cards）。请在设置页填一个卡库目录，或让会话带上工作区。',
            });
            return;
          }
          const refresh = /^(?:1|true)$/i.test(url.searchParams.get('refresh') ?? '');
          const { entries, source } = await ensureCardIndex(root, { refresh });
          const listed = listCards(entries, {
            q: url.searchParams.get('q') ?? '',
            category: url.searchParams.get('category') ?? '',
            limit: url.searchParams.get('limit') ?? undefined,
            offset: url.searchParams.get('offset') ?? undefined,
          });
          sendJson(response, 200, {
            ok: true,
            root,
            exists: existsSync(root),
            indexSource: source,             // index = 本机索引；scan = 目录扫描兜底
            // 让界面能说清「这个目录是怎么定下来的」：设置页显式指定 / 工作区默认 / 内置兜底
            rootSource: String(cfg?.cards?.root ?? '').trim() ? 'config' : (wsHint ? 'workspace' : 'fallback'),
            librarySize: entries.length,
            categories: cardCategories(entries),
            ...listed,
          });
        } catch (error) {
          sendJson(response, 500, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }), 'rp-tools: cards');

    // ── 会话闸门：界面据此决定「导入入口要不要出现」────────────────────
    // 界面自己的投影缓存会被切预设清掉（见 sessionGate 注释），所以这条必须问宿主。
    hostCtx.effect(() => hostCtx.webServer.register({
      kind: 'exact',
      path: '/rp-tools/gate',
      handler: (request, response) => {
        if (request.method !== 'GET') { sendJson(response, 405, { ok: false, error: 'method not allowed' }); return; }
        try {
          const url = new URL(request.url ?? '/', 'http://localhost');
          const id = url.searchParams.get('sessionId') ?? '';
          if (!id) { sendJson(response, 400, { ok: false, error: 'sessionId is required' }); return; }
          sendJson(response, 200, sessionGate(id));
        } catch (error) {
          sendJson(response, 500, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }), 'rp-tools: gate');

    // ── PNG 故事书：解析单张卡（预览，不落盘）────────────────────────
    hostCtx.effect(() => hostCtx.webServer.register({
      kind: 'exact',
      path: '/rp-tools/card',
      handler: (request, response) => {
        if (request.method !== 'GET') { sendJson(response, 405, { ok: false, error: 'method not allowed' }); return; }
        try {
          const url = new URL(request.url ?? '/', 'http://localhost');
          const cfg = loadStyles();
          const root = cardLibraryRoot(cfg, resolveWorkspaceDir(url.searchParams.get('sessionId') ?? '', url.searchParams.get('workspace')));
          const rel = url.searchParams.get('path') ?? '';
          const got = readCard(root, rel, { userLabel: cardUserLabel(cfg) });
          if (!got.ok) { sendJson(response, 400, { ok: false, code: got.code, error: got.error, warnings: got.warnings ?? [] }); return; }
          const { character, world, stats, summary, placeholders, attributes } = got.built;
          const allGreetings = listGreetings(got.decoded.data).items;
          sendJson(response, 200, {
            ok: true,
            path: rel,
            name: character.name,
            kind: got.decoded.kind,
            chunk: got.decoded.chunk,
            bytes: got.size,
            tags: Array.isArray(got.decoded.data?.tags) ? got.decoded.data.tags.slice(0, 12) : [],
            creator: String(got.decoded.data?.creator ?? ''),
            stats: {
              entries: stats.kept,
              skipped: stats.skipped,
              enabledOff: stats.enabledOff,
              totalChars: stats.totalChars,
              emptySkipped: stats.emptySkipped ?? 0,   // 正文只有模板残留、被丢掉的条数
            },
            // 预览只给摘要与截断文本：整份世界书几十万字，交给「导入」那一步写盘
            world,
            placeholders,                     // 卡里 {{user}}/{{char}} 等占位符的展开统计
            // 卡里用到的宏名（界面据此让用户填值；char 系列不算，导入时直接展开成卡名）
            macros: discoverMacros(collectCardText(got.decoded)),
            // 全部开场白（只给摘要：正文可能几千字，选完再在导入时落盘）
            greetings: allGreetings.map((g, i) => ({
              index: i, source: g.source, chars: g.chars,
              preview: g.text.slice(0, 120).replace(/\s+/g, ' '),
            })),
            attributes,                       // 英文属性行中文化的行数
            character: {
              name: character.name,
              personality: character.personality,
              first_mes: character.first_mes,
              mes_example: character.mes_example,
              greetingSource: character._greetingSource,
              greetingAlternatives: character._greetingAlternatives,
            },
            summary,
            warnings: got.decoded.warnings ?? [],
          });
        } catch (error) {
          sendJson(response, 400, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }), 'rp-tools: card');

    // ── PNG 故事书：导入到某个会话 ───────────────────────────────────
    // 写盘三件套（世界书追加合并 / 卡全文 / 卡面）+ 会话配置（角色卡、世界、立绘）。
    hostCtx.effect(() => hostCtx.webServer.register({
      kind: 'exact',
      path: '/rp-tools/card-import',
      handler: async (request, response) => {
        if (request.method !== 'POST') { sendJson(response, 405, { ok: false, error: 'method not allowed' }); return; }
        if (!sameOrigin(request)) { sendJson(response, 403, { ok: false, error: 'cross-origin request rejected' }); return; }
        try {
          const body = await readJsonBody(request, 1048576);
          const cfg = loadStyles();
          const rel = String(body.path ?? '');
          const id = normalizeSessionId(body.sessionId);
          const workspace = resolveWorkspaceDir(id, body.workspace);
          // 卡库根：跟着本会话的工作区（<工作区>/rp-cards），除非设置页显式指定了目录
          const root = cardLibraryRoot(cfg, workspace);
          if (!root) {
            sendJson(response, 400, {
              ok: false,
              error: '拿不到会话工作区，无法定位卡库（默认是 <工作区>/rp-cards）。请在设置页填一个卡库目录，或让会话带上工作区。',
            });
            return;
          }
          if (!workspace) {
            sendJson(response, 400, {
              ok: false,
              error: '拿不到这个会话的工作区目录（导入要往工作区写世界书）。用 ?sessionId=<id> 并把 workspace 传成绝对路径再试。',
            });
            return;
          }
          const got = readCard(root, rel, { userLabel: cardUserLabel(cfg) });
          if (!got.ok) { sendJson(response, 400, { ok: false, code: got.code, error: got.error, warnings: got.warnings ?? [] }); return; }

          // 用哪条开场白：界面可以选（卡常带好几条备用开场白），默认第一条
          const greetings = listGreetings(got.decoded.data).items;
          const chosen = Math.max(0, Math.min(greetings.length - 1, Math.trunc(Number(body.greetingIndex ?? 0)) || 0));
          const chosenGreeting = greetings[chosen]?.text ?? '';

          // 宏表：导入界面里让用户填的（默认值来自全局「玩家称呼」），**按会话保存**。
          // 存下来之后 `{{user}}` / `{{x}}` 由宿主变量在注入时插值 —— 所以以后在面板里改值，
          // 已经导入的文本会跟着变（不再把值烤进文件）。
          const macrosIn = normalizeMacros(body.macros ?? {});

          const files = writeImportFiles(workspace, {
            root, rel, built: got.built, decoded: got.decoded, name: got.built.character.name,
            userLabel: cardUserLabel(cfg), chosenGreeting: chosen, sessionId: id,
          });

          // ── 会话配置：角色卡按名字合并（同名替换，不重复添加）、世界覆盖、立绘登记 ──
          const session = loadSession(id);
          const previousWorldChars = String(session.world ?? '').length;
          const incoming = {};
          for (const f of CHARACTER_FIELDS) incoming[f] = got.built.character[f] ?? '';
          // **故事书不建人物**：卡里没有角色字段（描述/性格/对白范例/开场白）时 `name` 是书名，
          // 把它塞进人物表会出现「下班，然后成为魔法少女」这种条目（用户报的「标题不是角色卡」）。
          // 这种情况只导世界书 + 情境，人物留给 DM 用 rp_character 建。
          const isCharacter = got.built.isCharacterCard !== false;
          session.world = got.built.world;
          // 宏表合并（界面填的覆盖已有项；没填的键保持原值）
          if (Object.keys(macrosIn).length) session.macros = { ...(session.macros ?? {}), ...macrosIn };
          // **DM（旁白）卡**：它的内容不是「一个人」，而是「这个 DM 怎么带团」。
          // 早先按角色卡导，于是模型把自己的规则变成了一条名叫 DM 的角色（用户实测到过）。
          // 现在写进 `session.dm.prompt`（面板「DM 设定」里可见可改），角色表一个都不动。
          if (got.built.isDmCard === true && got.built.dmPrompt) {
            session.dm = {
              ...(session.dm ?? {}),
              prompt: String(got.built.dmPrompt),
              migrated: [],
            };
          }
          if (isCharacter) {
            const characters = session.characters.filter((c) => String(c?.name) !== incoming.name);
            characters.push(incoming);
            session.characters = characters;
          }
          // 战役名：角色卡用角色名；DM 卡/故事书用卡名（那才是这个剧本的名字）
          if (!session.campaign?.name) {
            const label = got.built.isDmCard === true
              ? String(got.decoded?.data?.name ?? '').trim()
              : isCharacter ? incoming.name : '';
            if (label) session.campaign = { ...(session.campaign ?? {}), name: label };
          }
          // **封面**：导入卡的 PNG 记在这里，面板把它摆在「世界设定」旁边。
          // 不再挂到某个角色名下 —— 那张图是**卡的书封**，不是某个角色的立绘
          // （用户要求：「PNG 移到世界设定旁边，作为封面」）。
          session.cover = rel
            ? { card: rel, file: files.relative.image, name: String(got.decoded?.data?.name ?? incoming.name ?? '').trim() }
            : null;
          if (!saveSession(session)) throw new Error(`无法写入会话配置 ${sessionFile(id)}`);
          // 存完立刻把宏注册到本会话的 agent 作用域（下一轮装配生效）
          macroValueCache.set(normalizeSessionId(id), mergedMacros(cfg, session.macros));
          refreshSessionMacros(id, session.macros ?? {});

          const opening = buildOpeningPrompt(got.built, {
            worldFile: files.relative.world,
            cardFile: files.relative.markdown,
            imageRel: files.relative.image,
            greeting: chosenGreeting,                  // 选中的那条原文（未截断）
            greetingFile: files.relative.opening,      // 全场开场白的引导文件（不截断）
            launchFile: files.relative.launch,         // 开局引导文件（§4，优先指向它）
            greetingCount: greetings.length,
            macros: session.macros,                    // 告诉 DM 本会话的宏值（它读世界书时会看到 {{user}}）
          });
          sendJson(response, 200, {
            ok: true,
            sessionId: id,
            workspace,
            path: rel,
            name: incoming.name,
            files: { ...files.relative, abs: { world: files.worldFile, markdown: files.mdFile, launch: files.launchFile, json: files.jsonFile, image: files.imageFile } },
            lore: { added: files.loreAdded, skipped: files.loreSkipped, fresh: files.loreFresh, budgetSkipped: got.built.stats.skipped },
            markdown: { chars: files.mdChars, truncated: files.mdTruncated },
            previousWorldChars,
            character: incoming,
            // false = 卡里没有角色描述/性格（或这是一张 DM 卡）：没建角色卡（封面照常放到世界设定旁）
            isCharacterCard: isCharacter,
            // true = DM（旁白）卡：正文写进了 session.dm.prompt，界面要提示「没建角色，进了 DM 设定」
            isDmCard: got.built.isDmCard === true,
            cover: session.cover,
            world: got.built.world,
            stats: got.built.stats,
            placeholders: got.built.placeholders,   // 卡里 {{user}}/{{char}} 等占位符的展开统计
            attributes: got.built.attributes,       // 英文属性行中文化的行数
            summary: got.built.summary,
            opening,
            warnings: got.decoded.warnings ?? [],
          });
        } catch (error) {
          sendJson(response, 400, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }), 'rp-tools: card-import');

    // ── PNG 故事书：卡面图（导入后当立绘用）──────────────────────────
    // 只允许卡库内的 .png；卡库路径安全由 safeCardPath 兜住。
    hostCtx.effect(() => hostCtx.webServer.register({
      kind: 'exact',
      path: '/rp-tools/card-image',
      handler: (request, response) => {
        if (request.method !== 'GET') { response.writeHead(405, { allow: 'GET' }); response.end(); return; }
        try {
          const url = new URL(request.url ?? '/', 'http://localhost');
          const imgRoot = cardLibraryRoot(loadStyles(), resolveWorkspaceDir(url.searchParams.get('sessionId') ?? '', url.searchParams.get('workspace')));
          const abs = safeCardPath(imgRoot, url.searchParams.get('path') ?? '');
          if (!abs) { sendJson(response, 400, { ok: false, error: '路径不合法' }); return; }
          let buffer = readFileSync(abs);
          // `thumb=1&width=N`：**服务端降采样**后再发。卡 PNG 单张可能几百 KB～数 MB
          // （正文动辄上百万字），而预览区只是看一眼封面 —— 缩到几百像素足够快。
          // 解码不支持（无像素数据 / 16bit / 隔行扫描）就回退原图，绝不发坏图。
          if (url.searchParams.get('thumb') === '1') {
            const want = Number(url.searchParams.get('width'));
            const maxW = Math.min(1024, Math.max(48, Number.isFinite(want) && want > 0 ? want : 420));
            buffer = thumbFor(abs, buffer, maxW) ?? buffer;
          }
          response.writeHead(200, {
            'content-type': 'image/png',
            'content-length': String(buffer.length),
            'cache-control': 'private, max-age=3600',
          });
          response.end(buffer);
        } catch (error) {
          sendJson(response, 404, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }), 'rp-tools: card-image');

    // ── 会话包：导出 / 快照 / 列表 / 导入 ────────────────────────────────────
    // 为什么需要：会话配置在全局数据目录、世界书与资源图在**工作区**，两处分离 —— 用户手工备份
    // 必然漏一半。这里把「这个会话能带走的一切」打成一个 zip（见 lib/session-bundle.js）。
    //
    // 四个口子：
    //   GET  /rp-tools/export?sessionId=        下载当前会话包（浏览器直接存盘）
    //   GET  /rp-tools/snapshots?sessionId=     列出快照（面板显示「有几个恢复点」）
    //   POST /rp-tools/snapshot                 打一个快照落到 rp-sessions/<id>/snapshots/，只留最近 N 个
    //   POST /rp-tools/import                   从工作区路径或 data URL 还原；**默认不覆盖**，
    //                                           要覆盖必须先显式 overwrite:true，且会自动先拍快照
    const SNAPSHOT_DIR = 'snapshots';
    const SNAPSHOT_KEEP = 5;

    /** 会话目录（`rp-sessions/<id>/`），顺带确保父目录存在。 */
    const sessionDirOf = (id, hint) => ensureSessionLore(id, hint)?.dir ?? '';

    /**
     * 列出**本插件自己的**快照，新的在前。
     *
     * 只认 `snapshot-*.zip`：用户往这个目录里放自己的包时，不该被插件当成「我的快照」列出来，
     * 更不该在修剪时被删掉（目录是我们的，但不代表里面每个文件都是我们的）。
     */
    const listSnapshots = (dir) => {
      const snapDir = join(dir, SNAPSHOT_DIR);
      if (!existsSync(snapDir)) return [];
      try {
        return readdirSync(snapDir)
          .filter((n) => n.startsWith('snapshot-') && n.endsWith('.zip'))
          .map((n) => {
            const st = statSync(join(snapDir, n));
            return { name: n, bytes: st.size, at: st.mtime.toISOString() };
          })
          .sort((a, b) => (a.name < b.name ? 1 : -1));       // 纯字典序：名字是定宽 ISO 时间戳，即时间倒序
      } catch { return []; }
    };

    /** 拍一个快照并**只留最近 N 个**（只删自己的快照；删不掉的如实报出来，不谎报成功）。 */
    const takeSnapshot = (id, hint) => {
      const dir = sessionDirOf(id, hint);
      if (!dir) throw new Error('拿不到本会话的工作区目录');
      const now = new Date();
      const stamp = now.toISOString().replace(/[:.]/g, '-');
      const { buffer, manifest } = buildBundle({ sessionId: id, sessionDir: dir, sessionConfig: loadSession(id), now });
      const snapDir = join(dir, SNAPSHOT_DIR);
      mkdirSync(snapDir, { recursive: true });
      const file = join(snapDir, `snapshot-${stamp}.zip`);
      writeFileSync(file, buffer);
      // 修剪：按名字倒序（= 时间倒序）保留前 N 个
      const all = listSnapshots(dir);
      const dropped = [];
      const failed = [];
      for (const old of all.slice(SNAPSHOT_KEEP)) {
        const abs = join(snapDir, old.name);
        if (!abs.startsWith(snapDir + sep)) continue;       // 双保险：只删自己目录里的
        if (removeFileVerified(abs)) dropped.push(old.name); else failed.push(old.name);
      }
      return {
        file, name: `snapshot-${stamp}.zip`, bytes: buffer.length,
        kept: Math.min(all.length, SNAPSHOT_KEEP), dropped, failed,
        files: manifest.files.length,
      };
    };

    // 导出下载：直接回二进制，浏览器按 content-disposition 存盘。
    hostCtx.effect(() => hostCtx.webServer.register({
      kind: 'exact',
      path: '/rp-tools/export',
      handler: (request, response) => {
        if (request.method !== 'GET') { sendJson(response, 405, { ok: false, error: 'method not allowed' }); return; }
        try {
          const url = new URL(request.url ?? '/', 'http://localhost');
          const rawId = String(url.searchParams.get('sessionId') ?? '').trim();
          if (!rawId) { sendJson(response, 400, { ok: false, error: 'sessionId is required' }); return; }
          const id = normalizeSessionId(rawId);
          const dir = sessionDirOf(id, url.searchParams.get('workspace'));
          if (!dir) { sendJson(response, 400, { ok: false, error: '拿不到本会话的工作区目录' }); return; }
          const now = new Date();
          const { buffer, manifest } = buildBundle({ sessionId: id, sessionDir: dir, sessionConfig: loadSession(id), now });
          const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '');
          const filename = `rp-${id.slice(0, 8)}-${stamp}.zip`;
          response.writeHead(200, {
            'content-type': 'application/zip',
            'content-length': String(buffer.length),
            // 只给 ASCII 回退名；真正的文件名交给前端 `<a download>`（中文名在头里要 RFC 5987 编码，容易出错）
            'content-disposition': `attachment; filename="${filename}"`,
            'cache-control': 'no-store',
            'x-rp-files': String(manifest.files.length),
          });
          response.end(buffer);
        } catch (error) {
          sendJson(response, 500, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }), 'rp-tools: export');

    hostCtx.effect(() => hostCtx.webServer.register({
      kind: 'exact',
      path: '/rp-tools/snapshots',
      handler: (request, response) => {
        if (request.method !== 'GET') { sendJson(response, 405, { ok: false, error: 'method not allowed' }); return; }
        const url = new URL(request.url ?? '/', 'http://localhost');
        const rawId = String(url.searchParams.get('sessionId') ?? '').trim();
        if (!rawId) { sendJson(response, 400, { ok: false, error: 'sessionId is required' }); return; }
        const id = normalizeSessionId(rawId);
        const dir = sessionDirOf(id, url.searchParams.get('workspace'));
        if (!dir) { sendJson(response, 400, { ok: false, error: '拿不到本会话的工作区目录' }); return; }
        const items = listSnapshots(dir);
        sendJson(response, 200, { ok: true, keep: SNAPSHOT_KEEP, total: items.length, items });
      },
    }), 'rp-tools: snapshots');

    hostCtx.effect(() => hostCtx.webServer.register({
      kind: 'exact',
      path: '/rp-tools/snapshot',
      handler: async (request, response) => {
        if (request.method !== 'POST') { sendJson(response, 405, { ok: false, error: 'method not allowed' }); return; }
        if (!sameOrigin(request)) { sendJson(response, 403, { ok: false, error: 'cross-origin request rejected' }); return; }
        try {
          const body = await readJsonBody(request, 65536);
          const rawId = String(body.sessionId ?? '').trim();
          if (!rawId) { sendJson(response, 400, { ok: false, error: 'sessionId is required' }); return; }
          const id = normalizeSessionId(rawId);
          const made = takeSnapshot(id, body.workspace);
          sendJson(response, 200, {
            ok: true, sessionId: id, ...made,
            items: listSnapshots(sessionDirOf(id, body.workspace)),
          });
        } catch (error) {
          sendJson(response, 500, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }), 'rp-tools: snapshot');

    hostCtx.effect(() => hostCtx.webServer.register({
      kind: 'exact',
      path: '/rp-tools/import',
      handler: async (request, response) => {
        if (request.method !== 'POST') { sendJson(response, 405, { ok: false, error: 'method not allowed' }); return; }
        if (!sameOrigin(request)) { sendJson(response, 403, { ok: false, error: 'cross-origin request rejected' }); return; }
        try {
          const body = await readJsonBody(request, Math.ceil(BUNDLE_UPLOAD_MAX_BYTES * 1.4));
          const rawTarget = String(body.sessionId ?? '').trim();
          if (!rawTarget) { sendJson(response, 400, { ok: false, error: 'sessionId is required（导入到哪个会话）' }); return; }
          const target = normalizeSessionId(rawTarget);
          const dir = sessionDirOf(target, body.workspace);
          if (!dir) { sendJson(response, 400, { ok: false, error: '拿不到目标会话的工作区目录' }); return; }

          // 两种来源：工作区里的相对路径（大包走这条，不经 base64），或 data URL（面板选文件）
          let buffer = null;
          let source = '';
          if (body.path) {
            const rel = String(body.path).trim();
            const abs = isAbsolute(rel) ? resolve(rel) : resolve(dir, rel);
            // 只允许读**会话目录内**的包：这个接口是给面板用的，不该变成「读任意文件路径」的口子
            if (!abs.startsWith(dir + sep)) { sendJson(response, 400, { ok: false, error: '只能导入会话目录内的包（把 zip 放进会话目录再用相对路径）' }); return; }
            if (!existsSync(abs)) { sendJson(response, 404, { ok: false, error: `找不到：${rel}` }); return; }
            buffer = readFileSync(abs);
            source = rel;
          } else if (body.dataUrl) {
            const m = /^data:(application\/(?:zip|x-zip-compressed)|application\/octet-stream);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(body.dataUrl));
            if (!m) { sendJson(response, 400, { ok: false, error: '只接受 zip 的 data URL' }); return; }
            buffer = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
            source = 'dataUrl';
          } else {
            sendJson(response, 400, { ok: false, error: '要么给 path（会话目录内的包），要么给 dataUrl' });
            return;
          }
          if (buffer.length > BUNDLE_UPLOAD_MAX_BYTES) {
            sendJson(response, 413, { ok: false, error: `包太大（${Math.round(buffer.length / 1048576)}MB，上限 ${Math.round(BUNDLE_UPLOAD_MAX_BYTES / 1048576)}MB）` });
            return;
          }

          const parsed = parseBundle(buffer);
          const current = loadSession(target);
          const hasData = Boolean(
            (Array.isArray(current.characters) && current.characters.length)
            || (Array.isArray(current.tables) && current.tables.length)
            || Object.keys(current.portraits ?? {}).length
            || String(current.world ?? '').trim()
            || (Array.isArray(current.state?.party) && current.state.party.length),
          );
          // **默认不覆盖**：导入是破坏性的，必须先明确说要覆盖；覆盖前**自动拍一个快照**兜底。
          if (hasData && body.overwrite !== true) {
            sendJson(response, 409, {
              ok: false,
              error: '目标会话已有内容。要覆盖请传 overwrite:true（覆盖前会自动拍一个快照）',
              needsOverwrite: true,
              incoming: { sessionId: parsed.sessionId, files: parsed.entries.length, exportedAt: parsed.manifest?.exportedAt ?? '' },
            });
            return;
          }
          let snapshot = null;
          if (hasData) {
            try { snapshot = takeSnapshot(target, body.workspace); } catch { /* 拍不上也要能导入，但要在返回里说 */ }
          }

          const restored = restoreBundleEntries(parsed.entries, dir);
          // 会话配置写到**全局数据目录**，并且把 sessionId 改成目标 id
          // （包里的相对路径天然可搬，只有配置里的这个字段是「自我指涉」的）
          const session = { ...(parsed.sessionConfig ?? current), sessionId: target };
          const saved = saveSession(session);
          sendJson(response, saved ? 200 : 500, {
            ok: saved, sessionId: target, source,
            from: parsed.sessionId, exportedAt: parsed.manifest?.exportedAt ?? '',
            files: restored.written, bytes: restored.bytes,
            snapshot: snapshot ? snapshot.name : null,
            error: saved ? undefined : '会话配置写入失败（文件已还原）',
          });
        } catch (error) {
          sendJson(response, 400, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }), 'rp-tools: import');
  });
}

/**
 * 供测试使用的内部工具（生产不调用）。
 *
 * 为什么放在文件**末尾**：它引用了下面定义的常量与函数，
 * 而 `const` 有暂时性死区 —— 放在声明之前会在模块加载时直接抛错（踩过一次）。
 */
export const __debug = {
  buildStandingText,
  neutralizeMustache,
  discoverMacros,
  autoMacroValue,
  renderCharacter,
  normalizeCharacter,
  parseLoreMarkdown,
  loreEntryView,
  loreOverview,
  renderConstantLore,
  planLoreInjection,
  normalizeLoreKey,
  loreNameConflicts,
  // 资源库（测试要能直接验归档/索引/并发写；导入路径不必真跑生图）
  // + 外部图片导入（系统生图结果 / 玩家自己给的图怎么变成库里的一条）
  readImageForImport,
  recentWorkspaceImages,
  applyCardConfigPatch,
  loadAssets,
  saveAssets,
  archiveAsset,
  findDuplicateAsset,
  listLaunchFiles,
  removeFileVerified,
  // 地图（P1 收尾：一行摘要 + 格式诊断；静态图与状态都是 DM 自己读写的文件）
  mapContextForDir,
  mapFilePaths,
  sceneIdOf,
  panelIdOf,
  queryAssets,
  assetCounts,
  assetLine,
  assetIndexPath,
  assetRelPath,
  assetUrl,
  assetPreviewUrl,
  assetKindOf,
  parseAssetTags,
  charactersInPrompt,
  withAssetLock,
  ASSET_KINDS,
  ASSET_KIND_DIR,
  ASSET_KIND_LABEL,
  applyLoreEdit,
  splitLoreFile,
  renderLoreEntryBlock,
  renderDmSetup,
  buildStandingText,
  loadSession,
  /** 测试用：直接改写某个会话的落盘配置（测「配置被改成越界路径」这类防御）。 */
  saveSession,
  isDmCardData,
  dmCardToPrompt,
  buildLoreCorpus,
  activateLore,
  renderLore,
  seededRoll,
  // 随机核心（真机报告 BUG-03/04/05 之后补的直接测试口：这一块以前零覆盖）
  parseDice,
  rollDice,
  resolveRollCount,
  DICE_MAX_COUNT,
  DICE_MAX_SIDES,
  ROLL_COUNT_MAX,
  renderCharacterIndex,
  charactersToExpand,
  buildTurnContext,
  normalizeState,
  applyStateUpdates,
  renderState,
  STATE_FIELDS,
  PARTY_FIELDS,
  STATE_LABELS,
  loreTemplateText,
  AUTO_MACROS,
  autoMacroValue,
  /** 测试用：给某个会话登记工作区目录（生产由 session/created / 路由解析填充）。 */
  setSessionCwd: (id, cwd) => { sessionCwd.set(normalizeSessionId(id), cwd); },
  /** 测试用：抹掉内存里的登记，模拟「重启后这份记忆没了」（落盘的那份仍在）。 */
  forgetSessionCwd: (id) => { sessionCwd.delete(normalizeSessionId(id)); },
  /** 测试用：直接调一次工作区解析链（内存 → 宿主注册表 → 落盘 → 请求参数）。 */
  resolveWorkspaceDir: (id, hint) => resolveWorkspaceDir(id, hint),
  /** 测试用：直接问一次会话闸门（是不是 dm / 有没有开局）。 */
  sessionGate: (id) => sessionGate(id),
  /** 默认宏列表的纯函数（设置页那套）：过滤规则、合并规则、玩家称呼解析。 */
  globalMacros: (cfg) => globalMacros(cfg),
  mergedMacros: (cfg, sessionMacros) => mergedMacros(cfg, sessionMacros),
  cardUserLabel: (cfg) => cardUserLabel(cfg),
  /** 测试用：让插件以为宿主会话注册表可用（生产由 installRoutes 注入 webServer 时捕获）。 */
  setSessionLookup: (ctxLike) => { hostSessionLookup = ctxLike; },
  /** 直接跑一次装配用的注入逻辑，返回写进段里的文本（供测试断言，不碰宿主）。 */
  injectFor: (session) => {
    const text = buildStandingText(session);
    if (!text) return '';
    const sections = [{ name: STANDING_SECTION, text: 'placeholder' }];
    const at = sections.findIndex((s) => s?.name === STANDING_SECTION);
    const entry = { name: STANDING_SECTION, text };
    if (at >= 0) sections[at] = entry; else sections.push(entry);
    return sections.find((s) => s.name === STANDING_SECTION).text;
  },
};

export function apply(ctx) {
  // 全局半侧：**不注册任何模型工具**，只做两件事：
  //   ① 注册 HTTP 路由（设置页 / 客户端 / 卡库与资源库取图用）；
  //   ② 监听 session/created 做会话级维护（fork 继承配置、记录工作区）。
  //
  // 全部 rp_* 工具**与提示词注入**都只在 dm 预设作用域出现
  // （工具见 registerRpTools，注入见 installStandingPrompt，两者都由 rp-bridge 调用），
  // 所以非 dm 会话既看不到工具，上下文里也不会出现跑团内容。
  installRoutes(ctx);

  // fork 会话时继承 RP 配置：子会话是新 id，不复制的话分叉后世界/角色卡/随机表全没了。
  // 判定依据全部来自 DSH 自己给的会话头：parentSession（fork 来源）+ isSeeded（含继承前缀）。
  // isSeeded 对 resume 是 false，所以「重启恢复会话」不会被误当成 fork 而触发复制。
  try {
    ctx.on('session/created', (session) => {
      try {
        const header = session?.header;
        if (!header) return;
        const child = session?.id ?? header.id;
        const parent = header.parentSession;
        if (!parent || !header.isSeeded) return;   // 不是 fork，跳过
        copyRpSessionFromParent(child, parent);
      } catch { /* 继承失败不该影响会话创建 */ }
    });
  } catch { /* 没有该事件就跳过 */ }

  // 记录最近活动的会话 + 它的工作区根目录，供 standing / 世界书注入使用。
  try {
    ctx.on('session/created', (session) => {
      try {
        const id = normalizeSessionId(session?.id ?? session?.header?.id);
        if (!id || id === 'default') return;
        // 世界书文件就放在会话的工作区根目录下：用户能用编辑器改，DM 也能用 read/write 维护
        const cwd = session?.header?.cwd;
        if (typeof cwd === 'string' && cwd) rememberSessionCwd(id, cwd);
        // 保留会话对象引用：装配时要 deriveMessages() 取最近消息做关键词匹配
        sessionRefs.set(id, session);
      } catch { /* 忽略 */ }
    });
  } catch { /* 没有该事件就跳过 */ }

  // 会话结束时清理引用与缓存，避免长期持有已结束的会话对象
  try {
    ctx.on('session/disposed', (session) => {
      try {
        const id = normalizeSessionId(session?.id ?? session?.header?.id);
        sessionRefs.delete(id);
        sessionCwd.delete(id);
        loreCache.delete(id);
        macroVars.delete(id);
        macroRegistrars.delete(id);
        macroValueCache.delete(id);
      } catch { /* 忽略 */ }
    });
  } catch { /* 没有该事件就跳过 */ }

  // 诊断用：把 agent/created 的可用字段写一份探针文件，
  // 用来判断宿主侧能否直接识别「这个会话是不是 dm 预设」。
  try {
    ctx.on('agent/created', (payload) => {
      try {
        const agent = payload?.agent ?? payload?.ctx?.agent ?? payload;
        const str = {};
        if (agent && typeof agent === 'object') {
          for (const [k, v] of Object.entries(agent)) {
            if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') str[k] = v;
          }
        }
        // 只读叶子字段，绝不整体序列化活对象（options / session 里可能有 ctx、inbox 等自引用结构）。
        const shallow = (obj) => {
          const out = { keys: [], scalars: {} };
          if (!obj || typeof obj !== 'object') return out;
          try {
            const keys = Object.keys(obj);
            out.keys = keys.slice(0, 60);
            for (const k of out.keys) {
              let v;
              try { v = obj[k]; } catch { continue; }
              if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
                out.scalars[k] = typeof v === 'string' && v.length > 200 ? `${v.slice(0, 200)}…` : v;
              } else if (v && typeof v === 'object') {
                try { out.scalars[k] = `[${Array.isArray(v) ? 'array' : 'object'}:${Object.keys(v).slice(0, 12).join(',')}]`; } catch { /* 跳过 */ }
              }
            }
          } catch { /* 诊断失败不影响运行 */ }
          return out;
        };
        const sessionShallow = shallow(agent?.session);
        const foundPreset = findPresetId(agent, str, sessionShallow);
        const info = {
          at: new Date().toISOString(),
          payloadKeys: payload && typeof payload === 'object' ? Object.keys(payload) : [],
          agentKeys: agent && typeof agent === 'object' ? Object.keys(agent) : [],
          scalars: str,
          // 判定「能否在宿主侧直接识别 dm 预设」的关键：预设名多半挂在 options / session 上。
          options: shallow(agent?.options),
          session: sessionShallow,
          // 若宿主侧能直接读到预设，就不必依赖桥接登记（这才是 HANDOFF 里想找的那条路）。
          foundPreset: foundPreset ?? null,
        };
        // 宿主侧直接识别成功 → 立刻登记，界面无需等一次工具调用。
        if (foundPreset === 'dm' && typeof agent?.id === 'string') {
          markDmSession(agent.id, 'dm');
          info.autoMarked = normalizeSessionId(agent.id);
        }
        mkdirSync(RP_DATA_DIR, { recursive: true });
        writeFileSync(join(RP_DATA_DIR, '_agent-probe.json'), JSON.stringify(info, null, 2) + '\n', 'utf8');
      } catch { /* 诊断失败不影响运行 */ }
    });
  } catch { /* 没有该事件就跳过 */ }
}

/** 从已知标量（str）与 options/session 浅层摘要里找预设 id。找不到返回 undefined。 */
function findPresetId(agent, scalars, sessionShallow) {
  const KEYS = ['agentPreset', 'preset', 'presetId', 'presetName', 'presetKey'];
  for (const key of KEYS) {
    const v = scalars?.[key];
    if (typeof v === 'string' && v) return v;
  }
  for (const src of [agent?.options, agent?.session, agent?.runtimeContext]) {
    if (!src || typeof src !== 'object') continue;
    for (const key of KEYS) {
      try {
        const v = src[key];
        if (typeof v === 'string' && v) return v;
      } catch { /* 忽略 */ }
    }
  }
  // options.preset 可能是对象（{id,name}），摘要里会是 "[object:id,name]" —— 只在能取到真值时用。
  try {
    const p = agent?.options?.preset;
    if (p && typeof p === 'object' && typeof p.id === 'string') return p.id;
  } catch { /* 忽略 */ }
  void sessionShallow;
  return undefined;
}

/**
 * 注册 RP 会话 / 角色 / 状态 / 世界书 / 资源库 / 随机表工具。
 * 由 dm 预设的 `./rp-bridge.mjs` 在 agent 作用域调用，于是这些工具只存在于 DM 会话。
 * 保底：每次调用都把该会话登记为 DM 会话 —— 即使预设桥接拿不到会话 id，
 * 只要 DM 用过一次工具，界面上的「🎲 RP」按钮就会出现。
 */
export function registerRpTools(ctx) {
  for (const tool of rpTools) {
    const wrapped = {
      ...tool,
      execute: async (args, exec) => {
        try { markDmSession(sessionIdOf(exec), 'dm'); } catch { /* 尽力而为 */ }
        return tool.execute(args, exec);
      },
    };
    ctx.tools.register(defineTool(wrapped));
  }

  // 提示词注入也挂在本作用域：`system-prompt/assemble` 按作用域过滤，
  // 所以这里的回调**只会收到本会话的装配** —— 天然「只在 DM 会话生效」且互不串台。
  // 会话 id 取 `ctx.agent.id`，不猜。
  try {
    const ok = installStandingPrompt(ctx);
    if (!ok) console.warn('[rp-tools] 提示词注入未注册：本作用域拿不到 systemPrompt 服务');
  } catch (error) {
    console.warn('[rp-tools] 注册提示词注入失败:', error?.message ?? error);
  }
}