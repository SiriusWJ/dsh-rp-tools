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
export const inject = ['tools'];

// ===================================================================
// 本地生图桥接（走 dsh-comfyui 的工作流库 + 媒体代理）
// -------------------------------------------------------------------
// 设计：每个「风格」= dsh-comfyui 库里的一个工作流（krea2 turbo + 一条风格 LoRA）。
// styles.json 里存风格 -> 触发词 / LoRA / 尺寸预设 / 工作流 id；
// 工作流 id 缺失时自动创建（并回存 id），所以删了库里的工作流也能自愈。
// 调用链：POST /comfyui/workflows/run -> promptId -> 轮询 /comfyui/jobs/media -> 媒体 URL。
// 返回文本里的 "image: <url>" 与 comfyui_run 同格式，前端会渲染成媒体卡片。
// ===================================================================

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, isAbsolute, resolve } from 'node:path';

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const RP_DATA_DIR = join(DSH_HOME, 'data', 'dsh-rp-tools');
const RP_STYLES_FILE = join(RP_DATA_DIR, 'styles.json');
const COMFY_ORIGIN = process.env.DSH_RP_COMFY_ORIGIN || 'http://127.0.0.1:3080';
const COMFY_BASE_URL = process.env.DSH_RP_COMFY_URL || 'http://127.0.0.1:8188';
/**
 * 浏览器实际访问 DSH 用的源，由设置页请求带上的 Origin 头学习而来，
 * 用于拼「插件自己的媒体代理」URL（同源，避免 CORS/端口不一致）。
 */
let learnedOrigin = '';
const POLL_INTERVAL_MS = 1500;
const DEFAULT_TIMEOUT_MS = 300000;

/**
 * 内置工作流模板：直接提交给 ComfyUI 的 API 格式 prompt。
 * 只依赖 ComfyUI 本身（comfyui.baseUrl），不依赖 dsh-comfyui 插件。
 */
const WORKFLOW_TEMPLATES = {
  /** krea2 turbo（8 步 / CFG 可调）+ 可选风格 LoRA。 */
  krea2: (st) => {
    const lora = st.lora ? String(st.lora) : '';
    const nodes = {
      '1': { class_type: 'UNETLoader', inputs: { unet_name: 'krea2_turbo_fp8_scaled.safetensors', weight_dtype: 'default' } },
      '2': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen3vl_4b_fp8_scaled.safetensors', type: 'krea2', device: 'default' } },
      '3': { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_vae.safetensors' } },
      '4': { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: '' } },
      '5': { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: '' } },
      '6': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['5', 0] } },
      '7': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
      '9': {
        class_type: 'KSampler',
        inputs: {
          model: [lora ? '8' : '1', 0], seed: 0, steps: 8, cfg: 1,
          sampler_name: 'euler', scheduler: 'simple',
          positive: ['4', 0], negative: ['6', 0], latent_image: ['7', 0], denoise: 1,
        },
      },
      '10': { class_type: 'VAEDecode', inputs: { samples: ['9', 0], vae: ['3', 0] } },
      '11': { class_type: 'SaveImage', inputs: { images: ['10', 0], filename_prefix: 'rp' } },
    };
    if (lora) {
      nodes['8'] = {
        class_type: 'LoraLoaderModelOnly',
        inputs: { model: ['1', 0], lora_name: lora, strength_model: Number(st.loraStrength ?? 1) },
      };
    }
    return nodes;
  },
};

/** 按风格定义组装本次运行的 API 工作流，注入提示词/负向/尺寸/种子/步数/CFG。 */
function buildWorkflow(st, { prompt, negative, width, height, seed }) {
  const tplName = st.workflow || 'krea2';
  const tpl = WORKFLOW_TEMPLATES[tplName];
  if (!tpl) {
    throw new Error(`rp: 未知工作流模板 "${tplName}"（可选：${Object.keys(WORKFLOW_TEMPLATES).join(', ')}）`);
  }
  const wf = tpl(st);
  const samplerId = Object.keys(wf).find((k) => wf[k].class_type === 'KSampler');
  if (!samplerId) throw new Error(`rp: 工作流模板 "${tplName}" 缺少 KSampler`);
  const inputs = wf[samplerId].inputs;
  const posId = inputs.positive?.[0];
  const negId = inputs.negative?.[0];
  const latentId = inputs.latent_image?.[0];
  if (!posId || !latentId) throw new Error(`rp: 工作流模板 "${tplName}" 结构不符合预期（缺正向或 latent）`);

  wf[posId].inputs.text = prompt;
  // 负向可能挂在 ConditioningZeroOut 上，写它的上游文本编码节点
  const negTextId = negId && wf[negId]?.class_type === 'ConditioningZeroOut'
    ? wf[negId].inputs.conditioning?.[0]
    : negId;
  if (negTextId && wf[negTextId]?.class_type === 'CLIPTextEncode') {
    wf[negTextId].inputs.text = negative ?? '';
  }

  wf[latentId].inputs.width = Math.round(width);
  wf[latentId].inputs.height = Math.round(height);
  inputs.steps = Number(st.steps ?? inputs.steps ?? 8);
  inputs.cfg = Number(st.cfg ?? inputs.cfg ?? 1);
  if (seed !== undefined && seed !== null && Number.isFinite(Number(seed))) {
    inputs.seed = Math.trunc(Number(seed));
  }
  return wf;
}

/** 默认风格表：manga（黑白漫画，无 LoRA，默认）+ 9 种风格 LoRA。 */
function defaultStyles() {
  const mk = (label, lora, trigger, notes, extra = {}) => ({
    label,
    workflow: 'krea2',
    lora,
    trigger,
    notes,
    cfg: 1,
    steps: 8,
    sizes: { scene: [1344, 768], portrait: [768, 1024], item: [1024, 1024] },
    ...extra,
  });
  return {
    comfyui: { baseUrl: COMFY_BASE_URL, dshOrigin: COMFY_ORIGIN },
    defaultStyle: 'manga',
    // 全局生图配置：负面提示词（预先给一套通用反瑕疵词）。注意 krea2 turbo 默认 CFG=1，
    // 此时负向不参与计算；想让负面生效，把风格 CFG 调到 1.5~2.5。
    negative: 'low quality, worst quality, blurry, jpeg artifacts, watermark, signature, text, deformed, bad anatomy, bad hands, extra fingers, missing fingers, extra limbs, missing limbs, disfigured, poorly drawn, lowres',
    campaign: { name: '', prompt_prefix: '', character_sheet: [] },
    styles: {
      manga: mk('黑白漫画', null, 'black and white manga panel, screentone shading, crisp ink lineart, high contrast, comic composition', '通用黑白漫画风（无 LoRA，靠提示词；对标 manga pipeline 的分镜配方）'),
      darkbrush: mk('暗黑水墨', 'krea2_darkbrush.safetensors', 'monochrome ink wash style', '单色水墨，克苏鲁/黑暗奇幻'),
      dotmatrix: mk('单色点绘', 'krea2_dotmatrix.safetensors', 'monochrome stippling style', '点阵素描，档案/调查感'),
      kidsdrawing: mk('儿童蜡笔', 'krea2_kidsdrawing.safetensors', 'naive expressive sketch style', '稚拙手绘，回忆/童年场景'),
      neondrip: mk('抽象肌理', 'krea2_neondrip.safetensors', 'textured abstract style', '抽象质感，梦魇/异界'),
      rainywindow: mk('雨窗', 'krea2_rainywindow.safetensors', 'rainy window style', '隔窗观景，忧郁/悬疑'),
      retroanime: mk('紫色复古动画', 'krea2_retroanime.safetensors', 'purple retro anime style', '赛璐璐动画，都市/校园'),
      softwatercolor: mk('装饰水彩', 'krea2_softwatercolor.safetensors', 'art deco watercolor style', '淡彩插画，童话/治愈'),
      sunsetblur: mk('运动模糊', 'krea2_sunsetblur.safetensors', 'ethereal motion blur style', '空灵拖影，梦境/闪回'),
      vintagetarot: mk('复古塔罗', 'krea2_vintagetarot.safetensors', 'vintage tarot style', '版画塔罗，占卜/神话'),
    },
  };
}

/** 读配置；不存在则写一份默认值。 */
function loadStyles() {
  if (!existsSync(RP_STYLES_FILE)) {
    mkdirSync(dirname(RP_STYLES_FILE), { recursive: true });
    writeFileSync(RP_STYLES_FILE, JSON.stringify(defaultStyles(), null, 2) + '\n', 'utf8');
  }
  const cfg = JSON.parse(readFileSync(RP_STYLES_FILE, 'utf8'));
  if (cfg?.comfyui?.dshOrigin === undefined) {
    cfg.comfyui = { ...(cfg.comfyui ?? {}), dshOrigin: COMFY_ORIGIN };
  }
  // 老配置迁移：补上全局负面词（预先给一套反瑕疵词）
  if (typeof cfg.negative !== 'string') {
    cfg.negative = defaultStyles().negative;
  }
  return cfg;
}

function saveStyles(cfg) {
  try { writeFileSync(RP_STYLES_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8'); } catch { /* 只读时忽略 */ }
}

// ===================================================================
// 会话级配置（按 session 隔离）
// -------------------------------------------------------------------
// 全局：风格库、ComfyUI 地址、全局默认风格（styles.json）。
// 会话级：角色卡 / 世界设定 / 提示词前缀 / 负面 / 会话默认风格。
// 会话 id 取自工具执行上下文 exec.agent.id；dm 预设的会话另由预设插件登记。
// ===================================================================

const SESSIONS_DIR = join(RP_DATA_DIR, 'sessions');
const DM_INDEX_FILE = join(RP_DATA_DIR, 'dm-sessions.json');

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
  return {
    sessionId: id,
    preset: typeof data.preset === 'string' ? data.preset : '',
    defaultStyle: typeof data.defaultStyle === 'string' && data.defaultStyle ? data.defaultStyle : null,
    campaign: {
      name: '',
      prompt_prefix: '',
      negative: '',
      ...(data.campaign && typeof data.campaign === 'object' ? data.campaign : {}),
    },
    characters: Array.isArray(data.characters) ? data.characters.filter((c) => c && (c.name || c.appearance)) : [],
    tables: Array.isArray(data.tables)
      ? data.tables.filter((t) => t && t.name && Array.isArray(t.entries)).map((t) => ({
        name: String(t.name),
        dice: String(t.dice ?? `1d${t.entries.length || 1}`),
        entries: t.entries.map((e) => String(e)),
      }))
      : [],
    world: typeof data.world === 'string' ? data.world : '',
    styleNotes: typeof data.styleNotes === 'string' ? data.styleNotes : '',
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

/** dm 预设登记的会话清单（供页签只对 dm 会话显示）。 */
function loadDmIndex() {
  try {
    if (!existsSync(DM_INDEX_FILE)) return {};
    const data = JSON.parse(readFileSync(DM_INDEX_FILE, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch { return {}; }
}

/** 登记一个 dm 会话（dm 预设的桥接插件挂载时调用）。 */
function markDmSession(sessionId, presetName) {
  try {
    mkdirSync(RP_DATA_DIR, { recursive: true });
    const id = normalizeSessionId(sessionId);
    const index = loadDmIndex();
    index[id] = { preset: String(presetName ?? 'dm'), at: new Date().toISOString() };
    writeFileSync(DM_INDEX_FILE, JSON.stringify(index, null, 2) + '\n', 'utf8');
    return true;
  } catch { return false; }
}

/** 这个会话是不是 DM 会话（兼容带/不带 session- 前缀两种写法）。 */
function isDmSession(sessionId) {
  const id = normalizeSessionId(sessionId);
  const index = loadDmIndex();
  return Boolean(index[id] || index[`session-${id}`]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 调 ComfyUI 自己的 HTTP API —— 这是本插件唯一的生图依赖。
 * 任何本地/远程 ComfyUI 都行，只要 baseUrl 通。
 */
async function comfyApi(cfg, path, { method = 'GET', body, timeoutMs = 60000 } = {}) {
  const base = String(cfg?.comfyui?.baseUrl || COMFY_BASE_URL).replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(base + path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
    return { status: res.status, json };
  } catch (error) {
    throw new Error(`rp: 连不上 ComfyUI ${base}（${error?.message ?? error}）—— 确认 Comfy Desktop / ComfyUI 已启动，或改 comfyui.baseUrl`);
  } finally {
    clearTimeout(timer);
  }
}

/** 提交 API 工作流，返回 prompt_id。 */
async function submitWorkflow(cfg, workflow) {
  const res = await comfyApi(cfg, '/prompt', {
    method: 'POST',
    body: { prompt: workflow, client_id: 'dsh-rp-tools' },
  });
  const promptId = res.json?.prompt_id;
  if (!promptId) {
    const nodeErrors = res.json?.node_errors ? ` 节点错误：${JSON.stringify(res.json.node_errors).slice(0, 300)}` : '';
    const err = res.json?.error ? ` ${JSON.stringify(res.json.error).slice(0, 300)}` : '';
    throw new Error(`rp: 提交失败（HTTP ${res.status}）${err}${nodeErrors}`);
  }
  return promptId;
}

/** 轮询 /history 直到该 prompt 出图（或失败/超时），返回图片条目数组。 */
async function waitForImages(cfg, promptId, timeoutMs) {
  const started = Date.now();
  const limit = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  for (;;) {
    await sleep(POLL_INTERVAL_MS);
    const res = await comfyApi(cfg, `/history/${encodeURIComponent(promptId)}`, { timeoutMs: 30000 });
    const entry = res.json?.[promptId];
    if (entry) {
      const status = entry.status?.status_str;
      if (status === 'error') {
        const messages = Array.isArray(entry.status?.messages) ? entry.status.messages : [];
        const detail = messages
          .filter((m) => Array.isArray(m) && m[0] === 'execution_error')
          .map((m) => m[1]?.exception_message ?? m[1]?.node_type ?? 'error')
          .join('；');
        throw new Error(`rp: ComfyUI 执行失败 —— ${detail || '见 ComfyUI 控制台'}`);
      }
      const done = status === 'success' || entry.status?.completed === true;
      if (done) {
        const images = [];
        for (const nodeId of Object.keys(entry.outputs ?? {})) {
          for (const img of entry.outputs[nodeId]?.images ?? []) {
            if (img?.filename) images.push(img);
          }
        }
        return images;
      }
    }
    if (Date.now() - started > limit) {
      throw new Error(`rp: 等待超时（${Math.round(limit / 1000)}s），promptId=${promptId}（ComfyUI 里可能仍在跑）`);
    }
  }
}

/** 组本插件媒体代理的 URL（同源）。 */
function mediaUrl(cfg, img) {
  const origin = learnedOrigin || cfg?.comfyui?.dshOrigin || COMFY_ORIGIN;
  const qs = new URLSearchParams({
    file: String(img.filename),
    subfolder: String(img.subfolder ?? ''),
    type: String(img.type ?? 'output'),
  });
  return `${origin.replace(/\/+$/, '')}/rp-tools/media?${qs.toString()}`;
}

/** 连通性自检（设置页「检查连接」与工具都可用）。 */
async function comfyStatus(cfg) {
  const stats = await comfyApi(cfg, '/system_stats', { timeoutMs: 15000 });
  const devices = Array.isArray(stats.json?.devices) ? stats.json.devices : [];
  const gpu = devices[0];
  return {
    ok: stats.status === 200,
    baseUrl: cfg?.comfyui?.baseUrl || COMFY_BASE_URL,
    version: stats.json?.system?.comfyui_version ?? 'unknown',
    device: gpu?.name ?? null,
    vramFreeGb: gpu?.vram_free ? Math.round((gpu.vram_free / 1024 ** 3) * 10) / 10 : null,
  };
}

/** 按风格把用户提示词补全：会话前缀 + 触发词 + 提示词 + 风格备注 + 命中的角色外观。 */
function buildPrompt(cfg, st, prompt, session) {
  const parts = [];
  const prefix = session?.campaign?.prompt_prefix || cfg?.campaign?.prompt_prefix || '';
  if (prefix) parts.push(String(prefix));
  if (st.trigger) parts.push(st.trigger);
  if (prompt) parts.push(String(prompt));
  if (session?.styleNotes) parts.push(String(session.styleNotes));
  const sheet = (Array.isArray(session?.characters) && session.characters.length
    ? session.characters
    : (Array.isArray(cfg?.campaign?.character_sheet) ? cfg.campaign.character_sheet : []));
  for (const ch of sheet) {
    if (ch?.name && ch?.appearance && String(prompt ?? '').includes(String(ch.name))) {
      parts.push(`${ch.name}: ${ch.appearance}`);
    }
  }
  return parts.filter(Boolean).join(', ');
}

/** 解析 "16:9" 这类比例到约 1MP 的像素尺寸。 */
function aspectToSize(aspect, megapixels = 1) {
  const m = /^(\d+)\s*[:x]\s*(\d+)$/.exec(String(aspect ?? '').trim());
  if (!m) return null;
  const w = Number(m[1]); const h = Number(m[2]);
  if (!w || !h) return null;
  const total = megapixels * 1024 * 1024;
  const scale = Math.sqrt(total / (w * h));
  const round8 = (v) => Math.max(256, Math.round((v * scale) / 8) * 8);
  return [round8(w), round8(h)];
}

/** 生成一张图：组装工作流 → 直连 ComfyUI 提交 → 轮询 → 返回媒体 URL。 */
async function generateOne(cfg, { prompt, style, seed, width, height, timeoutMs, sizeKey = 'scene', session }) {
  const styleKey = style || session?.defaultStyle || cfg.defaultStyle;
  const st = cfg.styles?.[styleKey];
  if (!st) {
    throw new Error(`rp: 未知风格 "${styleKey}" —— 可选：${Object.keys(cfg.styles ?? {}).join(', ')}`);
  }
  const fullPrompt = buildPrompt(cfg, st, prompt, session);

  let w = width; let h = height;
  if (!w || !h) {
    const preset = st.sizes?.[sizeKey] ?? st.sizes?.scene ?? [1344, 768];
    w = w ?? preset[0];
    h = h ?? preset[1];
  }

  const negative = cfg?.negative ?? '';
  const workflow = buildWorkflow(st, { prompt: fullPrompt, negative, width: w, height: h, seed });

  const started = Date.now();
  const promptId = await submitWorkflow(cfg, workflow);
  const images = await waitForImages(cfg, promptId, timeoutMs);
  if (images.length === 0) throw new Error(`rp: 执行完成但没有图片输出（promptId=${promptId}）`);

  return {
    styleKey,
    styleLabel: st.label,
    promptId,
    fullPrompt,
    width: Math.round(w),
    height: Math.round(h),
    cfg: Number(st.cfg ?? 1),
    elapsedMs: Date.now() - started,
    media: images.map((img) => mediaUrl(cfg, img)),
  };
}

/** 读场景文件（支持绝对路径与工作目录相对路径）。 */
function readScenes(file) {
  const path = isAbsolute(file) ? file : resolve(process.cwd(), file);
  if (!existsSync(path)) throw new Error(`rp: 找不到场景文件 ${path}`);
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const scenes = Array.isArray(data) ? data : (Array.isArray(data?.scenes) ? data.scenes : null);
  if (!scenes) throw new Error('rp: 场景文件应为数组，或含 scenes 数组（照 scenes_manga.json 的结构）');
  return { path, meta: data?.meta ?? {}, scenes };
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

/** 解析骰子表达式，如 "2d6+3"、"d20"、"3d8+1d4-2"。 */
function parseDice(expr) {
  const tokens = String(expr).replace(/\s+/g, '').match(/[+-]?\d*d\d+|[+-]?\d+/g);
  if (!tokens || tokens.length === 0) {
    throw new Error(`rp_random: dice expression "${expr}" is invalid — expected something like "2d6+3" or "d20"`);
  }
  let totalConst = 0;
  const dice = [];
  for (const t of tokens) {
    if (t.includes('d')) {
      const parts = t.split('d');
      const count = parts[0] === '' || parts[0] === '+' ? 1 : Math.abs(parseInt(parts[0], 10));
      const sides = parseInt(parts[1], 10);
      if (!Number.isFinite(count) || count < 1 || count > 100) {
        throw new Error(`rp_random: dice "${t}" has invalid number of dice (must be 1..100)`);
      }
      if (!Number.isFinite(sides) || sides < 2) {
        throw new Error(`rp_random: dice "${t}" has invalid sides (must be >= 2)`);
      }
      dice.push({ count, sides, sign: t.startsWith('-') ? -1 : 1 });
    } else {
      totalConst += parseInt(t, 10);
    }
  }
  if (dice.length === 0) {
    throw new Error(`rp_random: dice expression "${expr}" contains no dice`);
  }
  return { dice, totalConst };
}

/** 掷一组骰子，返回总和与逐颗明细。 */
function rollDice(parsed, rnd) {
  let sum = parsed.totalConst;
  const detail = [];
  for (const d of parsed.dice) {
    let s = 0;
    const rolls = [];
    for (let i = 0; i < d.count; i++) {
      const r = Math.floor(rnd() * d.sides) + 1;
      rolls.push(r);
      s += r;
    }
    sum += d.sign * s;
    detail.push(`${d.count}d${d.sides}[${rolls.join(',')}]`);
  }
  return { sum, detail: detail.join(' + ') };
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

// ---- 工具清单：以后扩展 RP 工具时，只需向此数组追加定义 ----

const tools = [
  {
    name: 'rp_random',
    description: '为角色扮演与叙事生成可配置的随机值：骰子、数值区间、加权抽取、布尔翻转。凡场景需要中立随机结果时使用（战斗检定、掉落、遭遇表、惊喜、情绪、天气、命运裁决）。seed 可复现，count 可批量。\n\n模式（kind 缺省时按传入参数自动推断）：\n- dice：骰子表达式，如 「2d6+3」「d20」「3d8+1d4-2」，支持多组骰子与加减修正，返回总和并附逐颗明细；\n- choices：从列表抽取，可选 weights 制造不均等概率（如稀有度掉落、NPC 反应）；\n- integer / float：min..max 闭区间随机数，缺省 1..100（整数）或 0..1（浮点）；\n- bool：50/50 真假翻转。\n\n参数说明：count 一次生成多个值（1..20，choices 为放回抽取）；seed 相同则结果必定相同（确定性 PRNG），不传则真随机。\n\n参数非法（骰子表达式错误、权重数量与 choices 不一致、区间倒置）会抛出明确错误，修正参数重试即可。',
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
      count: { type: 'number', description: '一次生成的结果数量（1..20，默认 1）；choices 模式为放回抽取（同一项可重复出现）。' },
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
      const count = Math.min(Math.max(Math.trunc(args.count ?? 1), 1), 20);
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
        for (let i = 0; i < count; i++) {
          const { sum, detail } = rollDice(parsed, rnd);
          out.values.push(fmt(sum));
          if (i === 0) out.note = `${args.dice} → ${fmt(sum)} (${detail})`;
        }
        if (count > 1) out.note = `${args.dice} × ${count} → ${out.values.join(', ')}`;
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
];

// ═══════════════════════════════════════════════════════════════════
// dm 作用域工具：只在 DM 会话里注册（由 dm 预设调用 registerRpTools）。
// 非 dm 会话不会看到它们，也调用不到。
// ═══════════════════════════════════════════════════════════════════
const rpTools = [
  // ---- 生成工具：风格列表 ----
  {
    name: 'rp_styles',
    description: '列出本地生图（ComfyUI）的可选风格：每个风格对应一套生图工作流（krea2 turbo，部分带风格 LoRA），含触发词、CFG/步数与尺寸预设。任何需要「按某种画风出图」的场合都先调它拿风格 key。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          defaultStyle: { type: 'string', required: true },
          count: { type: 'number', required: true },
          lines: { type: 'array', required: true, items: { type: 'string' } },
          configFile: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{ type: 'text', text: value.lines.join('\n') }],
    },
    execute: async () => {
      const cfg = loadStyles();
      const styles = styleSummary(cfg);
      const lines = styles.map((s) => {
        const mark = s.key === cfg.defaultStyle ? '★' : '·';
        const wf = `工作流 ${s.workflow}${s.lora ? ' + LoRA' : '（无 LoRA）'}｜cfg ${s.cfg}／${s.steps} 步`;
        return `${mark} ${s.key} — ${s.label}｜触发词「${s.trigger}」｜${wf}${s.notes ? `｜${s.notes}` : ''}`;
      });
      lines.unshift(`共 ${styles.length} 种风格，默认 ${cfg.defaultStyle}；配置：${RP_STYLES_FILE}`);
      return { defaultStyle: cfg.defaultStyle, count: styles.length, lines, configFile: RP_STYLES_FILE };
    },
  },

  // ---- 本地生图：单张 ----
  {
    name: 'rp_illustrate',
    description: '用本地 ComfyUI 生成一张图，风格可选（不传用默认风格）。通用出图工具：跑团/DM 配图、场景、NPC 立绘、道具线索、氛围图都走它。返回的图片链接会渲染成聊天里的卡片。',
    parameters: {
      prompt: { type: 'string', required: true, description: '画面描述（中英文都可）。若描述里出现角色设定表中的角色名，会自动补上其外观描述。' },
      style: { type: 'string', description: '风格 key（先用 rp_styles 查看）；不传用默认风格' },
      seed: { type: 'number', description: '随机种子，固定则同一张可复现；不传用工作流默认值' },
      aspect: { type: 'string', description: '宽高比，如 "16:9" / "3:4" / "1:1"；不传用风格默认尺寸' },
      width: { type: 'number', description: '显式宽度（覆盖 aspect 与风格默认）' },
      height: { type: 'number', description: '显式高度' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          style: { type: 'string', required: true },
          styleLabel: { type: 'string', required: true },
          prompt: { type: 'string', required: true },
          promptId: { type: 'string', required: true },
          elapsedMs: { type: 'number', required: true },
          media: { type: 'array', required: true, items: { type: 'string' } },
          note: { type: 'string', required: true },
        },
      },
      render: (args, value) => {
        const lines = [`🎨 ${value.styleLabel}（${value.style}）用时 ${(value.elapsedMs / 1000).toFixed(1)}s`];
        for (const url of value.media) lines.push(`  image: ${url}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    execute: async (args, exec) => {
      const cfg = loadStyles();
      const session = loadSession(sessionIdOf(exec));
      let w = args.width; let h = args.height;
      if ((!w || !h) && args.aspect) {
        const size = aspectToSize(args.aspect, 1);
        if (size) { w = w ?? size[0]; h = h ?? size[1]; }
      }
      const result = await generateOne(cfg, {
        prompt: args.prompt,
        style: args.style,
        seed: args.seed,
        width: w,
        height: h,
        session,
      });
      return {
        ok: true,
        style: result.styleKey,
        styleLabel: result.styleLabel,
        prompt: result.fullPrompt,
        promptId: result.promptId,
        elapsedMs: result.elapsedMs,
        media: result.media,
        note: `${result.styleLabel} · ${result.width}×${result.height} · cfg ${result.cfg} · promptId=${result.promptId}`,
      };
    },
  },

  // ---- 生成工具：角色设定表管理（+ 可选出立绘）----
  {
    name: 'rp_character',
    description: '管理战役的角色设定表（character_sheet：名字 + 外观描述），并按需用默认风格出一张角色立绘。角色名一旦登记，任何 rp_illustrate 的画面描述里提到它就会自动补上外观——这是保持角色长相一致的主要手段。',
    parameters: {
      action: { type: 'string', required: true, description: '"list" 列出全部；"set" 新增或更新一个角色（需 name）；"remove" 删除一个（需 name）；"clear" 清空' },
      name: { type: 'string', description: '角色名（set/remove 用）' },
      appearance: { type: 'string', description: '外观描述（set 用），如「17岁少年，凌乱短发，黑色斗篷，腰间挂着蓝水晶」' },
      portrait: { type: 'boolean', description: 'set/list 时是否顺带出一张立绘（用默认风格的 portrait 尺寸）' },
      style: { type: 'string', description: '出立绘时指定风格；不传用默认风格' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          characters: { type: 'array', required: true, items: { type: 'string' } },
          media: { type: 'array', required: true, items: { type: 'string' } },
          note: { type: 'string', required: true },
        },
      },
      render: (args, value) => {
        const lines = [`🧑‍🎤 ${value.note}`];
        for (const c of value.characters) lines.push(`  ${c}`);
        for (const url of value.media) lines.push(`  image: ${url}`);
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
        const appearance = String(args.appearance ?? '').trim();
        const idx = sheet.findIndex((c) => String(c.name) === name);
        if (idx >= 0) sheet[idx] = { ...sheet[idx], appearance: appearance || sheet[idx].appearance };
        else sheet.push({ name, appearance });
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

      const current = session.characters.map((c) => `${c.name}：${c.appearance || '（无外观描述）'}`);

      // 可选：立即出一张立绘（会话级配置：风格/前缀/角色卡）
      const media = [];
      let note = `${action} 完成，本会话当前 ${current.length} 个角色（会话 ${session.sessionId}）`;
      if (args.portrait) {
        const want = String(args.name ?? '').trim();
        const target = session.characters.find((c) => String(c.name) === want) ?? session.characters[0];
        if (!target) throw new Error('rp_character: 没有角色可出立绘（先 set 一个）');
        const result = await generateOne(cfg, {
          prompt: `${target.name} 的半身立绘，正面，中性背景`,
          style: args.style,
          sizeKey: 'portrait',
          session,
        });
        media.push(...result.media);
        note = `${note}；已出「${target.name}」立绘（${result.styleLabel}，${result.width}×${result.height}，${(result.elapsedMs / 1000).toFixed(1)}s）`;
      }

      return { ok: true, action, characters: current, media, note };
    },
  },

  // ---- 生成工具：会话级设置（世界 / 前缀 / 负面 / 会话默认风格）----
  {
    name: 'rp_session',
    description: '查看或修改「当前会话」的 RP 设置（按会话隔离，互不影响）：世界设定、提示词前缀、会话默认风格、风格备注、战役名。DM 用它在开局录入世界观与基调；这些设置只作用于本会话（全局负面词与风格库用 rp_config）。',
    parameters: {
      action: { type: 'string', required: true, description: '"get" 查看当前会话设置；"set" 修改（只改传入的字段）；"clear" 清空会话设置' },
      world: { type: 'string', description: '世界/战役设定文本（给 DM 与配图当背景，不直接塞进生图提示词）' },
      prompt_prefix: { type: 'string', description: '本会话的全局提示词前缀（拼在每条生图提示词最前）' },
      default_style: { type: 'string', description: '本会话默认风格 key（不传则用全局默认；先用 rp_styles 查看）' },
      style_notes: { type: 'string', description: '本会话的风格补充说明（每次生图会附在提示词后）' },
      campaign_name: { type: 'string', description: '战役名（纯记录，方便识别）' },
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
      const cfg = loadStyles();
      const session = loadSession(sessionIdOf(exec));
      const action = String(args.action ?? 'get');

      if (action === 'set') {
        if (args.world !== undefined) session.world = String(args.world);
        if (args.style_notes !== undefined) session.styleNotes = String(args.style_notes);
        if (args.campaign_name !== undefined) session.campaign.name = String(args.campaign_name);
        if (args.prompt_prefix !== undefined) session.campaign.prompt_prefix = String(args.prompt_prefix);
        if (args.default_style !== undefined) {
          const key = String(args.default_style).trim();
          if (key && !cfg.styles?.[key]) {
            throw new Error(`rp_session: 未知风格 "${key}" —— 可选：${Object.keys(cfg.styles ?? {}).join(', ')}`);
          }
          session.defaultStyle = key || null;
        }
        saveSession(session);
      } else if (action === 'clear') {
        saveSession({
          sessionId: session.sessionId,
          preset: session.preset,
          defaultStyle: null,
          campaign: { name: '', prompt_prefix: '' },
          characters: session.characters,
          world: '',
          styleNotes: '',
        });
        session.world = '';
        session.styleNotes = '';
        session.defaultStyle = null;
        session.campaign = { name: '', prompt_prefix: '' };
      } else if (action !== 'get') {
        throw new Error(`rp_session: 未知 action "${action}"（可用 get / set / clear）`);
      }

      const effectiveStyle = session.defaultStyle || cfg.defaultStyle;
      const lines = [
        `会话 ${session.sessionId}${session.preset ? `（预设 ${session.preset}）` : ''}`,
        `战役名：${session.campaign.name || '（未设）'}`,
        `默认风格：${effectiveStyle} — ${cfg.styles?.[effectiveStyle]?.label ?? '?'}${session.defaultStyle ? '（会话级）' : '（全局默认）'}`,
        `提示词前缀：${session.campaign.prompt_prefix || '（未设）'}`,
        `负面词（全局，改它用 rp_config 或设置页 RP工具）：${cfg.negative ? `${cfg.negative.slice(0, 56)}${cfg.negative.length > 56 ? '…' : ''}` : '（未设）'}`,
        `风格备注：${session.styleNotes || '（未设）'}`,
        `角色卡：${session.characters.length} 个${session.characters.length ? ` — ${session.characters.map((c) => c.name).join('、')}` : ''}`,
        `世界设定：${session.world ? `${session.world.slice(0, 120)}${session.world.length > 120 ? '…' : ''}` : '（未设）'}`,
        `本会话配置文件（可用 read/write 工具直接读写）：${sessionFile(session.sessionId)}`,
        `全局配置（风格库/负面词）：${RP_STYLES_FILE}`,
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

  // ---- 生成工具：按场景文件批量 ----
  {
    name: 'rp_scenes',
    description: '按场景文件（scenes_*.json 结构：scenes[].panels[]，每格有 positive/negative/seed/width/height）逐格批量生图。适合一次性出一整幕。单格失败会跳过并记录，不中断整批。',
    parameters: {
      scenesFile: { type: 'string', required: true, description: '场景 JSON 路径（绝对路径，或相对当前工作目录）' },
      sceneId: { type: 'string', description: '只处理某一幕，如 "S01"；不传则全部' },
      style: { type: 'string', description: '风格 key；不传用默认风格' },
      limit: { type: 'number', description: '最多生成几张（调试用）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          style: { type: 'string', required: true },
          styleLabel: { type: 'string', required: true },
          total: { type: 'number', required: true },
          done: { type: 'number', required: true },
          failed: { type: 'number', required: true },
          media: { type: 'array', required: true, items: { type: 'string' } },
          errors: { type: 'array', required: true, items: { type: 'string' } },
          note: { type: 'string', required: true },
        },
      },
      render: (args, value) => {
        const lines = [`🎬 ${value.styleLabel}：${value.done}/${value.total} 张完成${value.failed ? `，${value.failed} 张失败` : ''}`];
        for (const url of value.media) lines.push(`  image: ${url}`);
        for (const err of value.errors) lines.push(`  ! ${err}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    execute: async (args, exec) => {
      const cfg = loadStyles();
      const session = loadSession(sessionIdOf(exec));
      const styleKey = args.style || session.defaultStyle || cfg.defaultStyle;
      const st = cfg.styles?.[styleKey];
      if (!st) throw new Error(`rp_scenes: 未知风格 "${styleKey}" —— 可选：${Object.keys(cfg.styles ?? {}).join(', ')}`);
      const { scenes, meta } = readScenes(args.scenesFile);
      const wanted = scenes.filter((s) => !args.sceneId || String(s?.scene_id) === String(args.sceneId));
      const panels = [];
      for (const scene of wanted) {
        for (const panel of (Array.isArray(scene?.panels) ? scene.panels : [])) panels.push({ scene, panel });
      }
      const limit = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? Math.trunc(Number(args.limit)) : panels.length;
      const targets = panels.slice(0, limit);

      const media = [];
      const errors = [];
      let done = 0;
      for (const { scene, panel } of targets) {
        const label = `${scene?.scene_id ?? '?'}${panel?.panel_id ? `/${panel.panel_id}` : ''}`;
        try {
          const promptText = [panel?.positive, panel?.narration].filter(Boolean).join(', ') || 'scene illustration';
          let w = Number(panel?.width) || undefined;
          let h = Number(panel?.height) || undefined;
          if (!w || !h) {
            const aspect = meta?.aspect?.[panel?.panel_type];
            const size = aspectToSize(aspect, 1);
            if (size) { w = size[0]; h = size[1]; }
          }
          const result = await generateOne(cfg, {
            prompt: promptText,
            style: styleKey,
            seed: panel?.seed,
            width: w,
            height: h,
            session,
          });
          media.push(...result.media);
          done += 1;
        } catch (error) {
          errors.push(`${label}: ${String(error?.message ?? error)}`);
        }
      }

      return {
        ok: errors.length === 0,
        style: styleKey,
        styleLabel: st.label,
        total: targets.length,
        done,
        failed: errors.length,
        media,
        errors,
        note: `${st.label}｜${done}/${targets.length} 张｜来源 ${args.scenesFile}`,
      };
    },
  },

  // ---- 生成工具：全局配置（负面词 / 全局默认风格 / ComfyUI 地址）----
  {
    name: 'rp_config',
    description: '查看或修改「全局」生图配置（所有会话共用）：负面提示词、全局默认风格、ComfyUI 地址、以及配置文件路径。会话级内容（角色卡/世界/前缀）用 rp_session。',
    parameters: {
      action: { type: 'string', required: true, description: '"get" 查看；"set" 修改（只改传入字段）' },
      negative: { type: 'string', description: '全局负面提示词（反瑕疵词表）；注意 krea2 turbo 默认 CFG=1 时负向不参与计算，需把风格 CFG 调到 1.5~2.5 才生效' },
      default_style: { type: 'string', description: '全局默认风格 key（会话未指定时用它）' },
      base_url: { type: 'string', description: 'ComfyUI 地址，如 http://127.0.0.1:8188' },
      style_key: { type: 'string', description: '配合 trigger/steps/cfg 使用：要修改哪个风格' },
      trigger: { type: 'string', description: '改写某风格的触发词（需同时传 style_key）' },
      steps: { type: 'number', description: '改写某风格的采样步数（需 style_key）' },
      cfg: { type: 'number', description: '改写某风格的 CFG（需 style_key）' },
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
      const cfg = loadStyles();
      const action = String(args.action ?? 'get');
      if (action === 'set') {
        if (args.negative !== undefined) cfg.negative = String(args.negative);
        if (args.base_url !== undefined) cfg.comfyui = { ...(cfg.comfyui ?? {}), baseUrl: String(args.base_url) };
        if (args.default_style !== undefined) {
          const key = String(args.default_style).trim();
          if (!cfg.styles?.[key]) throw new Error(`rp_config: 未知风格 "${key}" —— 可选：${Object.keys(cfg.styles ?? {}).join(', ')}`);
          cfg.defaultStyle = key;
        }
        if (args.style_key !== undefined) {
          const st = cfg.styles?.[String(args.style_key)];
          if (!st) throw new Error(`rp_config: 未知风格 "${args.style_key}"`);
          if (args.trigger !== undefined) st.trigger = String(args.trigger);
          if (args.steps !== undefined && Number.isFinite(Number(args.steps))) st.steps = Math.max(1, Math.trunc(Number(args.steps)));
          if (args.cfg !== undefined && Number.isFinite(Number(args.cfg))) st.cfg = Number(args.cfg);
        }
        saveStyles(cfg);
      } else if (action !== 'get') {
        throw new Error(`rp_config: 未知 action "${action}"（可用 get / set）`);
      }
      return {
        ok: true,
        action,
        note: action === 'set' ? '✅ 已更新全局生图配置' : '⚙️ 当前全局生图配置',
        lines: [
          `ComfyUI 地址：${cfg.comfyui?.baseUrl ?? COMFY_BASE_URL}`,
          `全局默认风格：${cfg.defaultStyle} — ${cfg.styles?.[cfg.defaultStyle]?.label ?? '?'}`,
          `全局负面词：${cfg.negative || '（未设）'}`,
          `风格数：${Object.keys(cfg.styles ?? {}).length}（${Object.keys(cfg.styles ?? {}).join('、')}）`,
          `配置文件（可用 read/write 工具直接改）：${RP_STYLES_FILE}`,
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
      count: { type: 'number', description: 'roll 时掷几次（默认 1）' },
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
      const tables = Array.isArray(session.tables) ? session.tables : [];
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
        session.tables = tables.filter((t) => String(t.name) !== String(args.name ?? ''));
        saveSession(session);
      } else if (action === 'roll') {
        const table = find(args.name);
        if (!table) {
          throw new Error(`rp_table: 没有名为 "${args.name ?? ''}" 的表 —— 本会话现有：${tables.map((t) => t.name).join('、') || '（无）'}`);
        }
        const parsed = parseDice(table.dice);
        const rnd = makeRng(args.seed);
        const times = Math.min(Math.max(Math.trunc(Number(args.count ?? 1)) || 1, 1), 20);
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
        note: action === 'set' ? '✅ 已保存表格' : (action === 'remove' ? '🗑 已删除表格' : `📋 本会话随机表（${tables.length}）`),
        lines: tables.length
          ? tables.map((t) => `${t.name}｜${t.dice}｜${t.entries.length} 条：${t.entries.slice(0, 6).join(' / ')}${t.entries.length > 6 ? ' …' : ''}`)
          : ['（尚无表格。用 rp_table action=set 建一个，例如：name「地下城遭遇表」entries [「狗头人巡逻队」「陷阱」…]）'],
      };
    },
  },
];

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

/** 给设置页/工具用的风格摘要。 */
function styleSummary(cfg) {
  return Object.entries(cfg.styles ?? {}).map(([key, st]) => ({
    key,
    label: st.label ?? key,
    trigger: st.trigger ?? '',
    lora: st.lora ?? '',
    notes: st.notes ?? '',
    workflow: st.workflow ?? 'krea2',
    cfg: Number(st.cfg ?? 1),
    steps: Number(st.steps ?? 8),
    sizes: st.sizes ?? {},
  }));
}

function installRoutes(ctx) {
  ctx.inject(['webServer'], (hostCtx) => {
    hostCtx.effect(() => hostCtx.webServer.register({
      kind: 'exact',
      path: '/rp-tools/state',
      handler: (request, response) => {
        if (request.method !== 'GET') { sendJson(response, 405, { ok: false, error: 'method not allowed' }); return; }
        // 顺手学习浏览器实际访问 DSH 的源，用于拼同源媒体 URL
        const origin = request.headers.origin;
        if (origin) { try { learnedOrigin = new URL(origin).origin; } catch { /* 忽略非法 Origin */ } }
        try {
          const cfg = loadStyles();
          sendJson(response, 200, {
            ok: true,
            file: RP_STYLES_FILE,
            comfyOrigin: learnedOrigin || cfg?.comfyui?.dshOrigin || COMFY_ORIGIN,
            comfyBaseUrl: cfg?.comfyui?.baseUrl ?? COMFY_BASE_URL,
            config: cfg,
            defaults: defaultStyles(),
            styles: styleSummary(cfg),
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
          const cfg = loadStyles();
          if (typeof body.defaultStyle === 'string' && cfg.styles?.[body.defaultStyle]) {
            cfg.defaultStyle = body.defaultStyle;
          }
          if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) {
            cfg.comfyui = { ...(cfg.comfyui ?? {}), baseUrl: body.baseUrl.trim() };
          }
          if (typeof body.negative === 'string') {
            cfg.negative = body.negative;
          }
          if (body.campaign && typeof body.campaign === 'object') {
            cfg.campaign = {
              name: String(body.campaign.name ?? ''),
              prompt_prefix: String(body.campaign.prompt_prefix ?? ''),
              negative: String(body.campaign.negative ?? ''),
              character_sheet: Array.isArray(body.campaign.character_sheet)
                ? body.campaign.character_sheet
                  .filter((c) => c && (c.name || c.appearance))
                  .map((c) => ({ name: String(c.name ?? ''), appearance: String(c.appearance ?? '') }))
                : [],
            };
          }
          if (body.styles && typeof body.styles === 'object') {
            for (const [key, patch] of Object.entries(body.styles)) {
              const st = cfg.styles?.[key];
              if (!st || !patch || typeof patch !== 'object') continue;
              if (typeof patch.label === 'string') st.label = patch.label;
              if (typeof patch.trigger === 'string') st.trigger = patch.trigger;
              if (typeof patch.notes === 'string') st.notes = patch.notes;
              if (patch.cfg !== undefined && Number.isFinite(Number(patch.cfg))) st.cfg = Number(patch.cfg);
              if (patch.steps !== undefined && Number.isFinite(Number(patch.steps))) st.steps = Math.max(1, Math.trunc(Number(patch.steps)));
              if (patch.sizes && typeof patch.sizes === 'object') {
                const sizes = {};
                for (const [slot, pair] of Object.entries(patch.sizes)) {
                  if (Array.isArray(pair) && pair.length === 2) {
                    const w = Math.trunc(Number(pair[0]));
                    const h = Math.trunc(Number(pair[1]));
                    if (Number.isFinite(w) && Number.isFinite(h) && w >= 256 && h >= 256) sizes[slot] = [w, h];
                  }
                }
                st.sizes = { ...(st.sizes ?? {}), ...sizes };
              }
            }
          }
          saveStyles(cfg);
          sendJson(response, 200, { ok: true, config: cfg, styles: styleSummary(cfg) });
        } catch (error) {
          sendJson(response, 400, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }), 'rp-tools: config');

    hostCtx.effect(() => hostCtx.webServer.register({
      kind: 'exact',
      path: '/rp-tools/reset',
      handler: async (request, response) => {
        if (request.method !== 'POST') { sendJson(response, 405, { ok: false, error: 'method not allowed' }); return; }
        if (!sameOrigin(request)) { sendJson(response, 403, { ok: false, error: 'cross-origin request rejected' }); return; }
        try {
          const fresh = defaultStyles();
          saveStyles(fresh);
          sendJson(response, 200, { ok: true, config: fresh, styles: styleSummary(fresh) });
        } catch (error) {
          sendJson(response, 500, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }), 'rp-tools: reset');

    hostCtx.effect(() => hostCtx.webServer.register({
      kind: 'exact',
      path: '/rp-tools/check',
      handler: async (request, response) => {
        if (request.method !== 'GET') { sendJson(response, 405, { ok: false, error: 'method not allowed' }); return; }
        try {
          const cfg = loadStyles();
          sendJson(response, 200, { ok: true, ...(await comfyStatus(cfg)) });
        } catch (error) {
          sendJson(response, 200, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }), 'rp-tools: check');

    // 会话级配置：读/写某个会话的 RP 设置（角色卡 / 世界 / 前缀 / 负面 / 会话默认风格）
    hostCtx.effect(() => hostCtx.webServer.register({
      kind: 'exact',
      path: '/rp-tools/session',
      handler: async (request, response) => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        const sessionId = url.searchParams.get('sessionId') ?? '';
        const origin = request.headers.origin;
        if (origin) { try { learnedOrigin = new URL(origin).origin; } catch { /* 忽略 */ } }

        if (request.method === 'GET') {
          if (!sessionId) { sendJson(response, 400, { ok: false, error: 'sessionId is required' }); return; }
          try {
            const session = loadSession(sessionId);
            const dmIndex = loadDmIndex();
            const id = normalizeSessionId(sessionId);
            sendJson(response, 200, {
              ok: true,
              isDm: isDmSession(id) || session.preset === 'dm',
              preset: dmIndex[id]?.preset ?? dmIndex[`session-${id}`]?.preset ?? session.preset ?? '',
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
            if (body.defaultStyle !== undefined) {
              const key = String(body.defaultStyle ?? '');
              session.defaultStyle = key ? key : null;
            }
            if (body.world !== undefined) session.world = String(body.world);
            if (body.styleNotes !== undefined) session.styleNotes = String(body.styleNotes);
            if (body.campaign && typeof body.campaign === 'object') {
              session.campaign = {
                name: String(body.campaign.name ?? ''),
                prompt_prefix: String(body.campaign.prompt_prefix ?? ''),
                negative: String(body.campaign.negative ?? ''),
              };
            }
            if (Array.isArray(body.characters)) {
              session.characters = body.characters
                .filter((c) => c && (c.name || c.appearance))
                .map((c) => ({ name: String(c.name ?? ''), appearance: String(c.appearance ?? '') }));
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

    // dm 预设的桥接插件调用它登记会话（页签据此只对 dm 会话展开）
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
          markDmSession(id, body.preset ?? 'dm');
          const session = loadSession(id);
          if (session.preset !== 'dm') { session.preset = 'dm'; saveSession(session); }
          sendJson(response, 200, { ok: true, sessionId: id });
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
        const list = [...tools, ...rpTools].map((tool) => ({
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
          const times = Math.min(Math.max(Math.trunc(Number(body.count ?? 1)) || 1, 1), 20);
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

    // 媒体代理：把 ComfyUI 的 /view 转成同源（浏览器渲染卡片用）
    hostCtx.effect(() => hostCtx.webServer.register({
      kind: 'exact',
      path: '/rp-tools/media',
      handler: async (request, response) => {
        if (request.method !== 'GET') { response.writeHead(405, { allow: 'GET' }); response.end(); return; }
        try {
          const cfg = loadStyles();
          const base = String(cfg?.comfyui?.baseUrl || COMFY_BASE_URL).replace(/\/+$/, '');
          const url = new URL(request.url ?? '/', 'http://localhost');
          const qs = new URLSearchParams({
            filename: url.searchParams.get('file') ?? '',
            subfolder: url.searchParams.get('subfolder') ?? '',
            type: url.searchParams.get('type') ?? 'output',
          });
          if (!qs.get('filename')) { sendJson(response, 400, { ok: false, error: 'file is required' }); return; }
          const upstream = await fetch(`${base}/view?${qs.toString()}`, { signal: AbortSignal.timeout(60000) });
          if (!upstream.ok) { sendJson(response, 502, { ok: false, error: `ComfyUI /view HTTP ${upstream.status}` }); return; }
          const buffer = Buffer.from(await upstream.arrayBuffer());
          response.writeHead(200, {
            'content-type': upstream.headers.get('content-type') ?? 'image/png',
            'content-length': String(buffer.length),
            'cache-control': 'no-store',
          });
          response.end(buffer);
        } catch (error) {
          sendJson(response, 502, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }), 'rp-tools: media');

    hostCtx.effect(() => hostCtx.webServer.register({
      kind: 'exact',
      path: '/rp-tools/preview',
      handler: async (request, response) => {
        if (request.method !== 'POST') { sendJson(response, 405, { ok: false, error: 'method not allowed' }); return; }
        if (!sameOrigin(request)) { sendJson(response, 403, { ok: false, error: 'cross-origin request rejected' }); return; }
        try {
          const body = await readJsonBody(request);
          const cfg = loadStyles();
          const session = body.sessionId ? loadSession(String(body.sessionId)) : undefined;
          const result = await generateOne(cfg, {
            prompt: typeof body.prompt === 'string' && body.prompt ? body.prompt : '一位旅人站在岔路口，远处有灯火',
            style: typeof body.style === 'string' && body.style ? body.style : undefined,
            timeoutMs: 240000,
            session,
          });
          sendJson(response, 200, { ok: true, ...result });
        } catch (error) {
          sendJson(response, 502, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }), 'rp-tools: preview');
  });
}

export function apply(ctx) {
  // 全局半侧：只注册 rp_random + 设置页路由。
  // RP 生图工具不在这里注册 —— 它们只在 dm 预设作用域出现（见 registerRpTools），
  // 因此非 dm 会话的工具列表里根本不会出现 rp_styles / rp_illustrate 等。
  for (const tool of tools) {
    ctx.tools.register(defineTool(tool));
  }
  installRoutes(ctx);

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
        const info = {
          at: new Date().toISOString(),
          payloadKeys: payload && typeof payload === 'object' ? Object.keys(payload) : [],
          agentKeys: agent && typeof agent === 'object' ? Object.keys(agent) : [],
          scalars: str,
        };
        mkdirSync(RP_DATA_DIR, { recursive: true });
        writeFileSync(join(RP_DATA_DIR, '_agent-probe.json'), JSON.stringify(info, null, 2) + '\n', 'utf8');
      } catch { /* 诊断失败不影响运行 */ }
    });
  } catch { /* 没有该事件就跳过 */ }
}

/**
 * 注册 RP 生图 / 会话 / 角色 / 场景 / 表格工具。
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
}
