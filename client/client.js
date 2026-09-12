/**
 * dsh-rp-tools client half。
 *
 *  1. settings.section「RP工具」：全局配置（ComfyUI 地址、全局负面词、全局默认风格、风格库）
 *     + 工具列表与参数说明（实时读宿主 /rp-tools/tools）。
 *  2. conversation.session.header.utilities：会话头部**右上角**的「🎲 RP」入口，只在 DM 会话渲染。
 *  3. sidebar.right.pane.tab：RP 面板本体，作为**右侧栏的一种页签**打开。
 *     点入口 → `ctx.sidebarRight.openTab('dsh-rp-tools')` → 右栏展开并显示面板；
 *     收起 / 浮动 / 关闭都由 DSH 右栏自己管，插件不再自己画浮层。
 *
 * 纯 JS + React.createElement，无构建步骤。
 */
window.__ModuleLoader__.load({
  id: 'dsh-rp-tools',
  factory: (require) => {
    // 加载器协议要求 factory 自己持有 CommonJS 的 module 对象。
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const React = require('react');
    // react-dom 只为 createPortal：那一行没有对外槽位，只能把 chip 送进它的 DOM。
    // 万一取不到（更精简的宿主）就退回「自己占一行」，功能不受影响。
    let ReactDOM = null;
    try { ReactDOM = require('react-dom'); } catch { ReactDOM = null; }
    const h = React.createElement;

    const jget = (path) => fetch(path).then((r) => r.json());
    const jpost = (path, body) => fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    }).then((r) => r.json());

    const API = {
      state: () => jget('/rp-tools/state'),
      save: (body) => jpost('/rp-tools/config', body),
      reset: () => jpost('/rp-tools/reset'),
      check: () => jget('/rp-tools/check'),
      preview: (body) => jpost('/rp-tools/preview', body),
      tools: () => jget('/rp-tools/tools'),
      session: (id) => jget(`/rp-tools/session?sessionId=${encodeURIComponent(id)}`),
      saveSession: (body) => jpost('/rp-tools/session', body),
      roll: (body) => jpost('/rp-tools/roll', body),
      loras: () => jget('/rp-tools/loras'),
      cards: (params) => jget(`/rp-tools/cards?${new URLSearchParams(params ?? {}).toString()}`),
      card: (path) => jget(`/rp-tools/card?path=${encodeURIComponent(path)}`),
      cardImport: (body) => jpost('/rp-tools/card-import', body),
      lore: (sessionId) => jget(`/rp-tools/lore?sessionId=${encodeURIComponent(sessionId)}`),
      loreEntry: (sessionId, title) => jget(`/rp-tools/lore?sessionId=${encodeURIComponent(sessionId)}&title=${encodeURIComponent(title)}`),
      loreSave: (body) => jpost('/rp-tools/lore', body),
    };

    /** 宏名规则：与宿主变量名一致（[a-z][a-z0-9_]*）。 */
    const MACRO_RE = /^[a-z][a-z0-9_]{0,31}$/;

    /**
     * 卡面图 URL。卡库默认在**会话工作区**下的 rp-cards/，所以要把 cwd 一起带上，
     * 宿主才能把相对路径解析到同一个根（不然会按内置卡库去查、404）。
     */
    const cardImageUrl = (rel, workspace) => `/rp-tools/card-image?path=${encodeURIComponent(rel)}`
      + (workspace ? `&workspace=${encodeURIComponent(workspace)}` : '');

    let stylesInjected = false;
    function injectStyles() {
      if (stylesInjected) return;
      stylesInjected = true;
      const el = document.createElement('style');
      // 带上标识属性，与宿主自带的客户端插件同一惯例，便于在 devtools 里认出这层样式
      el.dataset.plugin = 'dsh-rp-tools';
      el.dataset.pluginCss = 'dsh-rp-tools/inline';
      el.textContent = `
.rpt { display: flex; flex-direction: column; gap: 12px; font-size: 13px; line-height: 1.55; }
.rpt * { min-width: 0; }
.rpt h3 { margin: 0; font-size: 14px; font-weight: 600; }
.rpt h4 { margin: 0; font-size: 13px; font-weight: 600; }
.rpt .dim { opacity: .62; font-size: 12px; }
.rpt .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
.rpt .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.rpt .sep { flex: 1; }
.rpt .kv { display: grid; grid-template-columns: 96px 1fr; gap: 8px 10px; align-items: center; }
.rpt input[type=text], .rpt input[type=number], .rpt textarea, .rpt select {
  width: 100%; box-sizing: border-box; padding: 5px 8px; border-radius: 6px;
  border: 1px solid color-mix(in oklab, currentColor 20%, transparent);
  background: color-mix(in oklab, currentColor 4%, transparent); color: inherit; font: inherit;
}
/* 原生下拉的弹出列表由浏览器绘制，不继承我们的半透明背景 —— 不显式给色就会是
   白底 + 浅色文字 → 看不清。用 DSH 主题 token（浅色主题下这两个值本身就是浅色）。 */
.rpt select option, .rpt select optgroup {
  background-color: var(--dsw-alias-bg-layer-2, #26272b);
  color: var(--dsw-alias-label-primary, #e8e8ea);
}
.rpt select option:checked { background-color: var(--dsw-alias-bg-overlay, #303136); }
.rpt textarea { min-height: 68px; resize: vertical; }
.rpt button {
  padding: 4px 10px; border-radius: 6px; cursor: pointer; font: inherit; white-space: nowrap;
  border: 1px solid color-mix(in oklab, currentColor 22%, transparent);
  background: color-mix(in oklab, currentColor 6%, transparent); color: inherit;
}
.rpt button:hover:not(:disabled) { background: color-mix(in oklab, currentColor 12%, transparent); }
.rpt button:disabled { opacity: .5; cursor: default; }
.rpt button.primary { background: #4D6BFE; border-color: #4D6BFE; color: #fff; }
.rpt button.tiny { padding: 2px 8px; font-size: 12px; }
.rpt .card { border: 1px solid color-mix(in oklab, currentColor 13%, transparent); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.rpt .badge { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; }
.rpt .badge.ok { background: color-mix(in oklab, #22c55e 24%, transparent); }
.rpt .badge.warn { background: color-mix(in oklab, #f59e0b 26%, transparent); }
.rpt .msg { padding: 6px 9px; border-radius: 6px; background: color-mix(in oklab, currentColor 8%, transparent); }
.rpt img.pv { max-width: 100%; border-radius: 8px; }
.rpt .stylecard { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 8px; align-items: start;
  border: 1px solid color-mix(in oklab, currentColor 11%, transparent); border-radius: 8px; padding: 10px; }
.rpt .nums { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.rpt .nums label { display: flex; gap: 5px; align-items: center; font-size: 12px; opacity: .85; }
.rpt .nums input[type=number] { width: 64px; }
.rpt .param { display: grid; grid-template-columns: 168px 74px minmax(0,1fr); gap: 8px; font-size: 12px; padding: 1px 0; }
.rpt .param .t { opacity: .6; }
.rpt .req { color: #ef4444; }
.rpt .tool { padding: 9px 0; border-top: 1px solid color-mix(in oklab, currentColor 9%, transparent); }
.rpt .tool:first-child { border-top: none; }
.rpt .scroll { max-height: 320px; overflow: auto; }
/* 世界书条目列表：每条一行标题 + 触发词 + 正文预览。
   列表要**高**（右侧栏本来就窄，再压到 260px 就真看不全了），预览给 6 行。 */
.rpt .lorelist { max-height: min(62vh, 640px); overflow: auto; }
.rpt .loreitem { padding: 6px 0; border-top: 1px solid color-mix(in oklab, currentColor 9%, transparent); }
.rpt .loreitem:first-child { border-top: none; }
.rpt .loreitem .loretitle { font-weight: 600; }
.rpt .loreitem .loreprev { font-size: 12px; opacity: .78; white-space: pre-wrap; word-break: break-word; }
/* 只有宿主那边截断的超大条目才收成 6 行（正常条目整条读完） */
.rpt .loreitem .loreprev.clamp { display: -webkit-box; -webkit-line-clamp: 6; -webkit-box-orient: vertical; overflow: hidden; }
/* 条目详情 / 编辑表单：**标签在上、控件在下**（右侧栏窄，两列网格会把正文框挤成一条） */
.rpt .loreconst { display: inline-flex; align-items: center; gap: 4px; }
.rpt .lorelegacy { display: flex; flex-direction: column; gap: 6px; padding: 8px; border-radius: 8px;
  background: color-mix(in oklab, #f59e0b 14%, transparent); }
.rpt .loreform { display: flex; flex-direction: column; gap: 4px; margin: 8px 0 4px; padding: 10px;
  border-radius: 8px; background: color-mix(in oklab, currentColor 6%, transparent); }
.rpt .loreform label { font-size: 12px; opacity: .75; margin-top: 4px; }
.rpt .loreform .row { flex-wrap: wrap; }
.rpt .loreform textarea.lorebody { min-height: 220px; resize: vertical; font-size: 12.5px; line-height: 1.55; }
.rpt .charline { display: grid; grid-template-columns: 118px minmax(0,1fr) auto auto; gap: 6px; align-items: center; }
/* 一个角色的整块（一行输入 + 可选立绘）：立绘落在这块里面，紧挨该角色 */
.rpt .charbox { padding: 8px 0; border-top: 1px solid color-mix(in oklab, currentColor 9%, transparent); }
.rpt .charbox:first-child { border-top: none; }
/* 角色设定细节：折叠区 + 两列（标签 / 输入）网格 */
.rpt .chargrow { margin-top: 6px; }
.rpt .chargrow summary { cursor: pointer; font-size: 12px; padding: 2px 0; }
.rpt .chargrid { display: grid; grid-template-columns: 68px minmax(0,1fr); gap: 6px 8px; align-items: start; margin-top: 6px; }
.rpt .chargrid .dim { padding-top: 5px; }
.rpt .partylines { display: flex; gap: 8px; flex-wrap: wrap; align-items: baseline; padding: 3px 0; font-size: 12px; }
.rpt .chargrid textarea { min-height: 44px; }
.rpt .portrait { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; align-items: flex-start; }
.rpt .portrait img { max-width: 200px; border-radius: 8px; }
.rpt .tbl { display: grid; grid-template-columns: minmax(0,1fr) auto auto; gap: 6px; align-items: center; }
.rpt .ovl { position: fixed; top: 56px; right: 16px; bottom: 16px; width: 440px; max-width: calc(100vw - 32px);
  z-index: 60; overflow: auto; padding: 14px; border-radius: 12px;
  background: var(--dsh-surface, #1b1c1f); color: inherit;
  border: 1px solid color-mix(in oklab, currentColor 18%, transparent);
  box-shadow: 0 12px 40px rgba(0,0,0,.45); }
.rpt .ovlhead { display: flex; align-items: center; gap: 8px; }
/* 右侧栏页签里的面板：占满页签，自己做滚动，不再需要浮层的定位与阴影 */
.rpt.embed { position: static; width: auto; max-width: none; height: 100%; box-sizing: border-box;
  border: none; border-radius: 0; box-shadow: none; background: transparent; padding: 10px 12px; }
.rpt.embed .ovlhead { position: sticky; top: 0; z-index: 2; padding-bottom: 8px;
  background: inherit; backdrop-filter: blur(6px); }

/* ── 会话头部右上角的入口按钮 ──────────────────────────────────────────────
   注意：这层是**独立根元素**（不在 .rpt 里面），不能写成 .rpt-hbtn ——
   否则它会吃到 .rpt 的 13px 字号并往下传给整块面板。
   规格对齐 DSH 官方头部按钮（open-in-app 的 split 按钮）：28px 高 / 14px 圆角 /
   0.5px 细边框 / 透明底 / 11px 字。自己写裸 <button> 而不套这层，
   就会是一块灰色实底方角小牌子，跟旁边那排图标按钮明显不搭。 */
.rph-btn {
  box-sizing: border-box; height: 28px; border-radius: 14px;
  border: .5px solid var(--dsw-alias-border-l4, color-mix(in oklab, currentColor 22%, transparent));
  background: transparent; color: var(--dsw-alias-label-primary, inherit);
  font-family: var(--dsw-font-family, inherit); font-size: 11px; font-weight: 400; line-height: 16px;
  display: inline-flex; align-items: center; gap: 5px; padding: 5px 10px 5px 8px;
  cursor: pointer; white-space: nowrap;
}
.rph-btn:hover, .rph-btn:focus-visible {
  background: var(--dsw-alias-interactive-bg-hover, color-mix(in oklab, currentColor 10%, transparent));
}
/* 面板已经打开时给个明确的按下态 */
.rph-btn[data-open='true'] {
  border-color: var(--dsw-alias-label-secondary, currentColor);
  background: var(--dsw-alias-interactive-bg-hover, color-mix(in oklab, currentColor 10%, transparent));
}
.rph-btn .glyph { flex: none; font-size: 13px; line-height: 1; }

/* ── PNG 故事书导入（会话输入框上方的那一行）─────────────────────────────
   这一层同样是**独立根元素**，不继承 .rpt 的字号（用 .rpc 自己的 13px）。
   折叠时只有一枚小 chip，展开才铺开列表与预览 —— 别让它平时占着输入框的地盘。 */
.rpc { font-size: 13px; line-height: 1.5; display: flex; flex-direction: column; gap: 8px; }
.rpc * { min-width: 0; }
.rpc .dim { opacity: .62; font-size: 12px; }
.rpc .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
.rpc .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
/* ⚠️ 这枚 chip 会被 portal 送进「工作区 / DM 主持人」那一行 —— 那时它**不在 .rpc 里面**，
   所以样式**不能用带 .rpc 前缀的后代选择器**（第一版就是这么写的：portal 之后一条规则都不命中，
   于是浏览器给出 <button> 的默认灰底方角，用户一眼就看出「风格不对」）。
   chip 的规格**照抄宿主那一行里的官方 chip**（DM 预设座位 / 工作区 chip）：
   无边框、透明底、16px 圆角、min-height 28px、13px/500 字、hover 与展开态都用 interactive-bg-hover。 */
.rpc-chip {
  box-sizing: border-box; display: inline-flex; align-items: center; gap: 4px; align-self: flex-start;
  min-width: 0; max-width: min(100%, 240px); min-height: 28px; padding: 0 8px;
  border: none; border-radius: 16px; background: 0 0;
  color: var(--dsw-alias-label-primary, inherit);
  font-family: inherit; font-size: 13px; font-weight: 500; line-height: 20px;
  cursor: pointer; white-space: nowrap;
}
.rpc-chip:hover:not(:disabled), .rpc-chip[aria-expanded='true'] {
  background: var(--dsw-alias-interactive-bg-hover, color-mix(in oklab, currentColor 10%, transparent));
}
/* 与旁边两枚 chip 一样的小箭头（颜色用 caption 级，与官方 chevron 对齐） */
.rpc-chip .chev { flex: none; color: var(--dsw-alias-label-caption, currentColor); font-size: 9px; line-height: 1; }
.rpc-chip .t { overflow: hidden; text-overflow: ellipsis; }
/* 定位用的空占位（chip 被 portal 送进那一行时，这里不能占空间） */
.rpc .rpc-holder { display: none; }
.rpc .panel {
  display: flex; flex-direction: column; gap: 10px; padding: 12px; border-radius: 12px;
  border: 1px solid color-mix(in oklab, currentColor 14%, transparent);
  background: var(--dsw-alias-bg-layer-2, color-mix(in oklab, currentColor 4%, transparent));
}
.rpc .split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.05fr); gap: 12px; align-items: start; }
@media (max-width: 720px) { .rpc .split { grid-template-columns: minmax(0, 1fr); } }
.rpc input[type=text], .rpc input[type=search], .rpc select, .rpc textarea {
  box-sizing: border-box; width: 100%; padding: 5px 8px; border-radius: 6px; font: inherit;
  border: 1px solid color-mix(in oklab, currentColor 20%, transparent);
  background: color-mix(in oklab, currentColor 4%, transparent); color: inherit;
}
.rpc select option { background-color: var(--dsw-alias-bg-layer-2, #26272b); color: var(--dsw-alias-label-primary, #e8e8ea); }
.rpc button { padding: 4px 10px; border-radius: 6px; cursor: pointer; font: inherit; white-space: nowrap;
  border: 1px solid color-mix(in oklab, currentColor 22%, transparent);
  background: color-mix(in oklab, currentColor 6%, transparent); color: inherit; }
.rpc button:hover:not(:disabled) { background: color-mix(in oklab, currentColor 12%, transparent); }
.rpc button:disabled { opacity: .5; cursor: default; }
.rpc button.primary { background: #4D6BFE; border-color: #4D6BFE; color: #fff; }
.rpc .list { max-height: 300px; overflow: auto; border: 1px solid color-mix(in oklab, currentColor 11%, transparent); border-radius: 8px; }
.rpc .item { display: flex; flex-direction: column; gap: 2px; padding: 7px 9px; cursor: pointer;
  border-top: 1px solid color-mix(in oklab, currentColor 8%, transparent); }
.rpc .item:first-child { border-top: none; }
.rpc .item:hover { background: color-mix(in oklab, currentColor 7%, transparent); }
.rpc .item[data-sel='true'] { background: color-mix(in oklab, #4D6BFE 20%, transparent); }
.rpc .item .nm { font-size: 12.5px; }
.rpc .item .mt { font-size: 11px; opacity: .6; }
.rpc .prev { display: flex; flex-direction: column; gap: 8px; }
.rpc .greet { display: flex; flex-direction: column; gap: 4px; }
.rpc .macroblk { display: flex; flex-direction: column; gap: 6px; padding: 8px; border-radius: 8px;
  background: color-mix(in oklab, currentColor 5%, transparent); }
.rpc .macrorow, .rpt .macrorow { display: grid; grid-template-columns: minmax(0, auto) minmax(0, 1fr) auto; gap: 6px; align-items: center; }
.rpc .macrorow .mono, .rpt .macrorow .mono { opacity: .8; }
.rpc .greet select { font-size: 12px; }
.rpc .prevbox { max-height: 190px; overflow: auto; white-space: pre-wrap; word-break: break-word;
  font-size: 12px; padding: 8px; border-radius: 8px; background: color-mix(in oklab, currentColor 6%, transparent); }
.rpc .msg { padding: 6px 9px; border-radius: 6px; font-size: 12px; background: color-mix(in oklab, currentColor 8%, transparent); }
.rpc .msg.ok { background: color-mix(in oklab, #22c55e 20%, transparent); }
.rpc .msg.err { background: color-mix(in oklab, #ef4444 20%, transparent); }
.rpc .badge { display: inline-block; padding: 0 6px; border-radius: 999px; font-size: 10.5px;
  background: color-mix(in oklab, currentColor 12%, transparent); }
.rpc label.cb { display: flex; gap: 6px; align-items: center; font-size: 12px; opacity: .85; }
`;
      document.head.appendChild(el);
    }

    // ── 设置页：RP工具（全局） ────────────────────────────────────────────
    /**
     * 出图后把预览卡片滚进视野。
     * 「试出」按钮在卡片组里，预览卡片紧挨着它渲染 —— 卡片组很长时（风格库在下面）
     * 仍可能落在视野外，所以出图后主动滚一下，避免用户以为「点了没反应」。
     * @param preview - 预览状态；变化即触发滚动
     * @param ref - 预览卡片的 ref（由调用方创建，便于同一组件里挂多个预览）
     */
    function useScrollToPreview(preview, ref) {
      React.useEffect(() => {
        if (!preview) return;
        const el = ref.current;
        if (!el) return;
        try { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch { /* 旧浏览器忽略 */ }
      }, [preview]);
    }

    function RpSettings() {
      const [state, setState] = React.useState(null);
      const [draft, setDraft] = React.useState(null);
      const [tools, setTools] = React.useState([]);
      const [busy, setBusy] = React.useState('');
      const [msg, setMsg] = React.useState(null);
      const [preview, setPreview] = React.useState(null);
      // 本地 LoRA 清单（读 ComfyUI）+ 新增风格表单
      const [loras, setLoras] = React.useState(null);
      const [loraErr, setLoraErr] = React.useState('');
      const [showNew, setShowNew] = React.useState(false);
      const [newStyle, setNewStyle] = React.useState({ key: '', label: '', lora: '', trigger: '', notes: '' });
      // 界面里做过但还没提交的增删操作（保存时一次性交给宿主）
      const pendingOps = React.useRef([]);
      // 预览卡片紧贴「试出」按钮渲染；出图后滚过去
      const previewRef = React.useRef(null);
      useScrollToPreview(preview, previewRef);

      React.useEffect(() => { injectStyles(); void reload(); }, []);

      async function reload() {
        setBusy('load');
        try {
          const [data, toolData, loraData] = await Promise.all([
            API.state(),
            API.tools().catch(() => ({ tools: [] })),
            API.loras().catch((e) => ({ ok: false, loras: [], error: String(e?.message ?? e) })),
          ]);
          if (!data?.ok) throw new Error(data?.error ?? '读取失败');
          setState(data);
          setDraft(JSON.parse(JSON.stringify(data.config)));
          setTools(toolData?.tools ?? []);
          setLoras(Array.isArray(loraData?.loras) ? loraData.loras : []);
          setLoraErr(loraData?.ok === false ? String(loraData.error ?? '读不到 LoRA 清单') : '');
          pendingOps.current = [];
          setMsg(null);
        } catch (error) {
          setMsg({ kind: 'err', text: String(error?.message ?? error) });
        } finally { setBusy(''); }
      }

      function patchStyle(key, field, value) {
        setDraft((d) => (d ? { ...d, styles: { ...d.styles, [key]: { ...d.styles[key], [field]: value } } } : d));
      }

      /** 新增一个风格：先在草稿里建出来（保存时才真正落盘到 styles.json）。 */
      function addStyle() {
        const key = newStyle.key.trim();
        const label = newStyle.label.trim() || key;
        if (!key) { setMsg({ kind: 'err', text: '请填风格 key（英文标识，如 inkwash）' }); return; }
        if (!/^[\w.-]+$/.test(key)) { setMsg({ kind: 'err', text: 'key 只能用字母/数字/下划线/点/横线' }); return; }
        if (draft?.styles?.[key]) { setMsg({ kind: 'err', text: `风格已存在：${key}` }); return; }
        // 若之前删过同名 key，先把那条 remove 撤掉，避免同一个 key 上出现两个操作
        pendingOps.current = pendingOps.current.filter((o) => !(o.action === 'remove' && o.key === key));
        pendingOps.current.push({ action: 'add', key });
        const tpl = draft.styles[draft.defaultStyle] ?? Object.values(draft.styles)[0] ?? {};
        setDraft((d) => ({
          ...d,
          styles: {
            ...d.styles,
            [key]: {
              label,
              workflow: tpl.workflow ?? 'krea2',
              lora: newStyle.lora,
              trigger: newStyle.trigger,
              notes: newStyle.notes,
              cfg: tpl.cfg ?? 1,
              steps: tpl.steps ?? 8,
              sizes: JSON.parse(JSON.stringify(tpl.sizes ?? { scene: [1344, 768], portrait: [768, 1024], item: [1024, 1024] })),
            },
          },
        }));
        setNewStyle({ key: '', label: '', lora: '', trigger: '', notes: '' });
        setShowNew(false);
        setMsg({ kind: 'ok', text: `已加入风格 ${label}（${key}）——记得点「保存」落盘` });
      }

      /** 从草稿里去掉一个风格；内置风格只警告不删。 */
      function removeStyle(key) {
        const summary = state.styles.find((s) => s.key === key);
        if (summary?.builtin) { setMsg({ kind: 'err', text: `「${summary.label}」是内置风格，不能删；改 label / 触发词即可` }); return; }
        if (!window.confirm(`删除风格「${summary?.label ?? key}」？（保存后生效）`)) return;
        // 同一个 key 上只留一条操作
        pendingOps.current = pendingOps.current.filter((o) => o.key !== key);
        pendingOps.current.push({ action: 'remove', key });
        setDraft((d) => {
          const styles = { ...d.styles };
          delete styles[key];
          const rest = Object.keys(styles);
          return { ...d, styles, defaultStyle: d.defaultStyle === key ? (rest[0] ?? '') : d.defaultStyle };
        });
        setMsg({ kind: 'ok', text: `已移除风格 ${key} —— 记得点「保存」落盘` });
      }

      async function save() {
        if (!draft) return;
        setBusy('save');
        try {
          const justAdded = new Set(pendingOps.current.filter((o) => o.action === 'add' || o.action === 'duplicate').map((o) => o.key));
          const styles = {};
          for (const [key, st] of Object.entries(draft.styles ?? {})) {
            const orig = state.config.styles?.[key];
            // 本次新加的风格：整份提交，否则模板 defaultValue（workflow / cfg / steps / sizes）会丢
            if (justAdded.has(key) || !orig) { styles[key] = st; continue; }
            const changed = {};
            for (const field of ['label', 'trigger', 'lora', 'cfg', 'steps']) {
              if (JSON.stringify(st[field]) !== JSON.stringify(orig[field])) changed[field] = st[field];
            }
            if (JSON.stringify(st.sizes) !== JSON.stringify(orig.sizes)) changed.sizes = st.sizes;
            if (Object.keys(changed).length) styles[key] = changed;
          }
          const styleOps = pendingOps.current.slice();
          const res = await API.save({
            defaultStyle: draft.defaultStyle,
            baseUrl: draft.comfyui?.baseUrl,
            negative: draft.negative,
            cards: { root: draft.cards?.root ?? '', userLabel: draft.cards?.userLabel ?? '' },
            styles,
            styleOps,
          });
          if (!res?.ok) throw new Error(res?.error ?? '保存失败');
          const styleErrors = res.styleErrors ?? [];
          if (styleErrors.length) throw new Error(`部分风格操作失败：${styleErrors.join('；')}`);
          pendingOps.current = [];
          setState((s) => ({ ...s, config: res.config, styles: res.styles }));
          setDraft(JSON.parse(JSON.stringify(res.config)));
          const n = styleOps.length;
          setMsg({ kind: 'ok', text: n ? `已保存到 styles.json（含 ${n} 项风格增删）` : '已保存到 styles.json' });
        } catch (error) {
          setMsg({ kind: 'err', text: String(error?.message ?? error) });
        } finally { setBusy(''); }
      }

      async function reset() {
        if (!window.confirm('恢复默认全局配置（风格库 / 负面词 / 默认风格）？各会话的角色卡、世界、随机表不受影响。')) return;
        setBusy('reset');
        try {
          const res = await API.reset();
          if (!res?.ok) throw new Error(res?.error ?? '恢复失败');
          setState((s) => ({ ...s, config: res.config, styles: res.styles }));
          setDraft(JSON.parse(JSON.stringify(res.config)));
          setMsg({ kind: 'ok', text: '已恢复默认' });
        } catch (error) {
          setMsg({ kind: 'err', text: String(error?.message ?? error) });
        } finally { setBusy(''); }
      }

      async function check() {
        setBusy('check');
        setMsg({ kind: 'ok', text: '正在检查 ComfyUI 连接…' });
        try {
          const res = await API.check();
          setMsg(res?.ok
            ? { kind: 'ok', text: `ComfyUI 在线：${res.version}｜${res.device ?? '?'}｜显存空闲 ${res.vramFreeGb ?? '?'}GB` }
            : { kind: 'err', text: res?.error ?? '连接失败' });
        } catch (error) {
          setMsg({ kind: 'err', text: String(error?.message ?? error) });
        } finally { setBusy(''); }
      }

      async function runPreview(key) {
        setBusy(`preview:${key}`);
        setPreview(null);
        setMsg({ kind: 'ok', text: '出图中…（本机约 15～20 秒，出完自动滚到上方预览卡片）' });
        try {
          const res = await API.preview({ style: key, prompt: '一位旅人站在岔路口，远处有灯火' });
          if (!res?.ok) throw new Error(res?.error ?? '预览失败');
          const label = res.styleLabel || key;
          setPreview({ key: label, url: res.media?.[0], elapsedMs: res.elapsedMs });
          setMsg({ kind: 'ok', text: `预览完成：${label}（${(res.elapsedMs / 1000).toFixed(1)}s）—— 图在上方预览卡片里` });
        } catch (error) {
          setMsg({ kind: 'err', text: String(error?.message ?? error) });
        } finally { setBusy(''); }
      }

      if (!state || !draft) {
        return h('div', { className: 'rpt' }, h('h3', null, 'RP工具'),
          h('div', { className: 'dim' }, busy === 'load' ? '读取中…' : (msg?.text ?? '未加载')));
      }

      /** 本地 LoRA 下拉：选中当前值；若清单里没有它（被删了 / ComfyUI 没开）也保留为一项，免得静默改值。 */
      function loraSelect(value, onChange, keyPrefix) {
        const names = (loras ?? []).map((l) => l.name);
        const has = value && names.includes(value);
        return h('select', { key: keyPrefix, value: value ?? '', onChange: (e) => onChange(e.target.value) }, [
          h('option', { key: '__none', value: '' }, '（不使用 LoRA）'),
          ...(value && !has ? [h('option', { key: '__cur', value }, `${value}（当前值，清单里没有）`)] : []),
          ...(loras ?? []).map((l) => h('option', { key: l.name, value: l.name }, l.krea2 ? l.name : `${l.name}（非 krea2）`)),
        ]);
      }

      const styleCards = state.styles.map((s) => {
        const d = draft.styles[s.key] ?? {};
        return h('div', { key: s.key, className: 'stylecard' }, [
          h('div', { key: 'l', style: { display: 'flex', flexDirection: 'column', gap: 6 } }, [
            h('div', { key: 'r1', className: 'row' }, [
              h('input', {
                key: 'n', type: 'text', value: d.label ?? '', style: { width: 148 },
                onChange: (e) => patchStyle(s.key, 'label', e.target.value),
              }),
              h('span', { key: 'k', className: 'mono dim' }, s.key),
              s.builtin ? null : h('span', { key: 'c', className: 'badge warn' }, '自定义'),
            ]),
            // 本地 LoRA 选取：清单来自 ComfyUI 的模型目录
            h('div', { key: 'lr', className: 'row' }, [
              h('span', { key: 't', className: 'dim mono', style: { flex: '0 0 34px' } }, 'LoRA'),
              h('span', { key: 's', style: { flex: '1 1 220px' } }, loraSelect(d.lora ?? '', (v) => patchStyle(s.key, 'lora', v), `lora-${s.key}`)),
            ]),
            h('input', {
              key: 't', type: 'text', value: d.trigger ?? '', placeholder: '触发词（写在提示词最前）',
              onChange: (e) => patchStyle(s.key, 'trigger', e.target.value),
            }),
          ]),
          h('div', { key: 'c', style: { display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' } }, [
            h('div', { key: 'nums', className: 'nums' }, [
              h('label', { key: 'c' }, 'CFG', h('input', {
                type: 'number', step: '0.1', min: '1', value: d.cfg ?? 1,
                onChange: (e) => patchStyle(s.key, 'cfg', Number(e.target.value)),
              })),
              h('label', { key: 's' }, '步数', h('input', {
                type: 'number', min: '1', value: d.steps ?? 8,
                onChange: (e) => patchStyle(s.key, 'steps', Number(e.target.value)),
              })),
              h('button', { key: 'p', className: 'tiny', disabled: Boolean(busy), onClick: () => runPreview(s.key) },
                busy === `preview:${s.key}` ? '…' : '试出'),
              s.builtin ? null : h('button', {
                key: 'd', className: 'tiny', disabled: Boolean(busy),
                onClick: () => removeStyle(s.key),
              }, '删除'),
            ]),
            h('div', { key: 'z', className: 'dim mono' },
              ['scene', 'portrait', 'item'].map((k) => (Array.isArray(d.sizes?.[k]) ? `${k} ${d.sizes[k][0]}×${d.sizes[k][1]}` : null)).filter(Boolean).join('  ·  ')),
          ]),
        ]);
      });

      return h('div', { className: 'rpt' }, [
        h('div', { key: 'head', className: 'row' }, [
          h('h3', { key: 't' }, 'RP工具'),
          h('span', { key: 'd', className: 'dim' }, '本地 ComfyUI 生图 · 角色卡/世界/随机表按会话隔离'),
          h('span', { key: 'sep', className: 'sep' }),
          h('button', { key: 'chk', onClick: check, disabled: Boolean(busy) }, busy === 'check' ? '检查中…' : '检查连接'),
          h('button', { key: 'reload', onClick: reload, disabled: Boolean(busy) }, '刷新'),
        ]),
        h('div', { key: 'file', className: 'dim mono' }, `配置文件：${state.file}`),
        msg ? h('div', { key: 'msg', className: 'msg' }, msg.text) : null,

        h('div', { key: 'global', className: 'card' }, [
          h('h4', { key: 't' }, '全局生图配置'),
          h('div', { key: 'kv', className: 'kv' }, [
            h('span', { key: 'c1' }, 'ComfyUI 地址'),
            h('input', {
              key: 'c2', type: 'text', value: draft.comfyui?.baseUrl ?? '',
              onChange: (e) => setDraft({ ...draft, comfyui: { ...(draft.comfyui ?? {}), baseUrl: e.target.value } }),
            }),
            h('span', { key: 'g1' }, '全局默认风格'),
            h('select', {
              key: 'g2', value: draft.defaultStyle,
              onChange: (e) => setDraft({ ...draft, defaultStyle: e.target.value }),
            }, Object.keys(draft.styles).map((k) => h('option', { key: k, value: k }, `${draft.styles[k].label} (${k})`))),
            h('span', { key: 'n1' }, '全局负面词'),
            h('textarea', {
              key: 'n2', value: draft.negative ?? '', placeholder: '反瑕疵词列表（已预置一套）',
              onChange: (e) => setDraft({ ...draft, negative: e.target.value }),
            }),
            h('span', { key: 'k1' }, '卡库目录'),
            h('input', {
              key: 'k2', type: 'text', value: draft.cards?.root ?? '',
              placeholder: '留空 = 会话工作区下的 rp-cards（相对路径按工作区解析）',
              onChange: (e) => setDraft({ ...draft, cards: { ...(draft.cards ?? {}), root: e.target.value } }),
            }),
            h('span', { key: 'u1' }, '玩家称呼'),
            h('input', {
              key: 'u2', type: 'text', value: draft.cards?.userLabel ?? '',
              placeholder: '导入卡组时把 {{user}} 换成它（默认「玩家」）',
              onChange: (e) => setDraft({ ...draft, cards: { ...(draft.cards ?? {}), userLabel: e.target.value } }),
            }),
          ]),
          h('div', { key: 'note', className: 'dim' },
            '负面词对所有会话与风格生效；krea2 turbo 默认 CFG=1 时负向不参与计算 —— 想让负面真正起作用，把对应风格的 CFG 调到 1.5~2.5。'),
          h('div', { key: 'note2', className: 'dim' },
            '卡库目录是「导入 PNG 故事书」扫描角色卡的地方。留空 = 会话工作区下的 rp-cards（卡跟着战役走）；'
            + '填绝对路径可指向共享卡库，填相对路径则按工作区解析。改完记得保存。'),
          h('div', { key: 'note3', className: 'dim' },
            '卡里用到的 {{宏}} 会在导入时列出来让你填（{{time}} / {{date}} 等自动宏由系统每轮现算，不用填）；'
            + '值按会话保存，RP 面板里随时能改。'),
          // 预览结果就放在这条配置里（卡片的「试出」按钮在风格库那边，滚过来即可见）
          preview ? h('div', { key: 'prev', className: 'card', ref: previewRef }, [
            h('div', { key: 'l', className: 'row' }, [
              h('span', { key: 't', className: 'dim' }, `预览：${preview.key}（${(preview.elapsedMs / 1000).toFixed(1)}s）`),
              h('span', { key: 'sep', className: 'sep' }),
              preview.url ? h('a', { key: 'o', className: 'dim', href: preview.url, target: '_blank', rel: 'noreferrer' }, '新标签打开大图') : null,
            ]),
            preview.url ? h('img', { key: 'i', className: 'pv', src: preview.url, alt: preview.key }) : null,
          ]) : null,
          h('div', { key: 'act', className: 'row' }, [
            h('button', { key: 'save', className: 'primary', onClick: save, disabled: Boolean(busy) }, busy === 'save' ? '保存中…' : '保存'),
            h('button', { key: 'reset', onClick: reset, disabled: Boolean(busy) }, '恢复默认'),
          ]),
        ]),

        h('div', { key: 'styles', className: 'card' }, [
          h('div', { key: 'h', className: 'row' }, [
            h('h4', { key: 't' }, `风格库（${state.styles.length}）`),
            h('span', { key: 'sep', className: 'sep' }),
            h('button', { key: 'add', disabled: Boolean(busy), onClick: () => setShowNew((v) => !v) },
              showNew ? '取消' : '＋ 新增风格'),
          ]),
          loraErr ? h('div', { key: 'le', className: 'dim' }, `LoRA 清单读取失败（${loraErr}）—— 请确认 ComfyUI 已启动；当前只能沿用已有 LoRA 名。`) : null,
          // 新增风格表单：key + 名称 + 本地 LoRA 选取 + 触发词
          showNew ? h('div', { key: 'new', className: 'card', style: { gap: 8 } }, [
            h('div', { key: 'r1', className: 'row' }, [
              h('input', {
                key: 'k', type: 'text', value: newStyle.key, placeholder: 'key（英文，如 inkwash）', style: { flex: '1 1 140px' },
                onChange: (e) => setNewStyle({ ...newStyle, key: e.target.value }),
              }),
              h('input', {
                key: 'l', type: 'text', value: newStyle.label, placeholder: '显示名，如 水墨', style: { flex: '1 1 140px' },
                onChange: (e) => setNewStyle({ ...newStyle, label: e.target.value }),
              }),
            ]),
            h('div', { key: 'r2', className: 'row' }, [
              h('span', { key: 't', className: 'dim mono', style: { flex: '0 0 34px' } }, 'LoRA'),
              h('span', { key: 's', style: { flex: '1 1 220px' } },
                loraSelect(newStyle.lora, (v) => setNewStyle({ ...newStyle, lora: v }), 'lora-new')),
            ]),
            h('input', {
              key: 't', type: 'text', value: newStyle.trigger, placeholder: '触发词（可留空，之后再填）',
              onChange: (e) => setNewStyle({ ...newStyle, trigger: e.target.value }),
            }),
            h('input', {
              key: 'n', type: 'text', value: newStyle.notes, placeholder: '备注（给自己看的用途说明）',
              onChange: (e) => setNewStyle({ ...newStyle, notes: e.target.value }),
            }),
            h('div', { key: 'r3', className: 'row' }, [
              h('button', { key: 'ok', className: 'primary', onClick: addStyle }, '加入风格库'),
              h('span', { key: 'd', className: 'dim' }, '加入后还要点「保存」才写入 styles.json；新风格的尺寸/CFG 沿用当前默认风格。'),
            ]),
          ]) : null,
          ...styleCards,
        ]),

        h('div', { key: 'tools', className: 'card scroll' }, [
          h('h4', { key: 't' }, `工具列表（${tools.length}）`),
          h('div', { key: 'd', className: 'dim' }, 'rp_* 生图 / 会话 / 角色 / 场景 / 表格工具只在 DM 预设的会话里注册，其它会话不加载。'),
          // 只列名字与一句话说明；参数清单太长，交给模型自己看工具 schema。
          ...tools.map((tool) => h('div', { key: tool.name, className: 'tool' }, [
            h('span', { key: 'a', className: 'mono' }, tool.name),
            h('span', { key: 'b', className: 'dim' }, `  ${String(tool.description ?? '').split('\n')[0]}`),
          ])),
        ]),
      ]);
    }

    // ── 会话 RP 面板：两种外壳共用同一份内容 ────────────────────────────────
    //   variant='float'（默认）：点头部按钮弹出的浮层，自带关闭按钮
    //   variant='embed'        ：挂在右侧栏页签里，由右栏自己管关闭/收起
    function RpSessionOverlay({ sessionId, onClose, variant }) {
      const embed = variant === 'embed';
      const [state, setState] = React.useState(null);
      const [draft, setDraft] = React.useState(null);
      const [styles, setStyles] = React.useState(null);
      const [busy, setBusy] = React.useState('');
      const [msg, setMsg] = React.useState(null);
      const [preview, setPreview] = React.useState(null);
      const [rolls, setRolls] = React.useState([]);
      // 世界书条目（面板上要能看见导入进来的条目）
      const [lore, setLore] = React.useState(null);
      /** 正在编辑的世界书条目草稿：{ title(原值), keysText, constant, order, probability, body, isNew } */
      const [loreEdit, setLoreEdit] = React.useState(null);
      const [loreQuery, setLoreQuery] = React.useState('');
      const [tableDraft, setTableDraft] = React.useState({ name: '', dice: '', entries: '' });
      // 新增宏的临时输入 + 全局玩家称呼（面板里 {{user}} 留空的说明要用）
      const [newMacroName, setNewMacroName] = React.useState('');
      const [globalUserLabel, setGlobalUserLabel] = React.useState('');
      // 每个角色自己的立绘：{ [角色名]: { url, style, elapsedMs } }
      const [portraits, setPortraits] = React.useState({});
      const previewRef = React.useRef(null);
      useScrollToPreview(preview, previewRef);

      React.useEffect(() => { injectStyles(); void reload(); }, [sessionId]);

      async function reload() {
        setBusy('load');
        try {
          const [data, global] = await Promise.all([API.session(sessionId), API.state()]);
          if (!data?.ok) throw new Error(data?.error ?? '读取失败');
          setState(data);
          setStyles(global);
          setGlobalUserLabel(String(global?.config?.cards?.userLabel ?? ''));
          setDraft(JSON.parse(JSON.stringify(data.session)));
          setMsg(null);
          // 世界书条目单独取（放在工作区的文件里，不在会话配置里）
          try {
            const l = await API.lore(sessionId);
            setLore(l?.ok ? l : { exists: false, total: 0, entries: [], error: l?.error });
          } catch { setLore({ exists: false, total: 0, entries: [] }); }
        } catch (error) {
          setMsg({ kind: 'err', text: String(error?.message ?? error) });
        } finally { setBusy(''); }
      }

      function patch(p) { setDraft((d) => (d ? { ...d, ...p } : d)); }
      // 状态：只提交改动过的字段（空串即清除），与宿主 applyStateUpdates 的语义一致
      function patchState(field, value) {
        setDraft((d) => (d ? { ...d, state: { ...(d.state ?? {}), [field]: value } } : d));
      }

      async function save() {
        if (!draft) return;
        setBusy('save');
        try {
          const res = await API.saveSession({
            sessionId,
            defaultStyle: draft.defaultStyle || '',
            world: draft.world ?? '',
            styleNotes: draft.styleNotes ?? '',
            campaign: draft.campaign,
            characters: draft.characters,
            characterIndex: draft.characterIndex ?? [],
            state: draft.state ?? {},
            tables: draft.tables,
            macros: draft.macros ?? {},
          });
          if (!res?.ok) throw new Error(res?.error ?? '保存失败');
          setState((s) => ({ ...s, session: res.session }));
          setDraft(JSON.parse(JSON.stringify(res.session)));
          setMsg({ kind: 'ok', text: '已保存（仅本会话）' });
        } catch (error) {
          setMsg({ kind: 'err', text: String(error?.message ?? error) });
        } finally { setBusy(''); }
      }

      /** 读世界书条目（面板「世界书」卡片用；只读，文件本身由用户/DM 维护）。 */
      async function loadLore() {
        setBusy('lore');
        try {
          const res = await API.lore(sessionId);
          setLore(res?.ok ? res : { exists: false, total: 0, entries: [], error: res?.error });
        } catch (error) {
          setLore({ exists: false, total: 0, entries: [], error: String(error?.message ?? error) });
        } finally { setBusy(''); }
      }

      /** 搜索过滤（标题 / 触发词 / 正文预览都搜，与 liketavern 的搜索框一致）。 */
      function visibleLoreEntries() {
        const all = lore?.entries ?? [];
        const q = loreQuery.trim().toLowerCase();
        if (!q) return all;
        return all.filter((e) => [e.title, ...(e.keys ?? []), e.preview]
          .some((v) => String(v ?? '').toLowerCase().includes(q)));
      }

      function patchLoreEdit(p) { setLoreEdit((d) => (d ? { ...d, ...p } : d)); }

      /**
       * 打开某一条的详情/编辑器。列表里只有 160 字预览，所以正文要**单独取一次**
       * （整本世界书可能几十万字，不能指望列表响应背着它）。
       * `entry` 传 null 就是「新建」。
       */
      async function beginLore(entry) {
        if (!entry) {
          setLoreEdit({ title: '', keysText: '', constant: false, order: 0, probability: 100, body: '', isNew: true });
          setMsg({ kind: 'ok', text: '新建条目：填好标题与正文后点「保存」写入世界书。' });
          return;
        }
        setBusy('lore-det');
        try {
          const res = await API.loreEntry(sessionId, entry.title);
          // 老宿主不认识 ?title=，会把**整个列表**回给我们（没有 entry 字段）。
          // 这时绝不能拿列表里的 160 字预览去当正文编辑 —— 一保存就把正文截没了。
          if (!res?.ok) throw new Error(res?.error ?? '读取条目失败');
          if (!res.entry || typeof res.entry.body !== 'string') {
            throw new Error('宿主没有返回条目正文 —— 多半是 DSH 还在跑旧代码，重启后再试（列表能看到、编辑要新路由）');
          }
          const e = res.entry;
          setLoreEdit({
            title: e.title,
            keysText: (e.keys ?? []).join('、'),
            constant: e.constant === true,
            order: e.order ?? 0,
            probability: e.probability ?? 100,
            body: e.body ?? '',
            isNew: false,
          });
          setMsg({ kind: 'ok', text: `正在编辑「${e.title}」（${String(e.body ?? '').length} 字）` });
        } catch (error) {
          setMsg({ kind: 'err', text: String(error?.message ?? error) });
        } finally { setBusy(''); }
      }

      /** 保存编辑器内容（新建走 add，其余走 update）。 */
      async function saveLoreEdit() {
        if (!loreEdit) return;
        setBusy('lore-save');
        try {
          const res = await API.loreSave({
            sessionId,
            action: loreEdit.isNew ? 'add' : 'update',
            title: loreEdit.title,                     // add 时无意义；update 时是**原名**
            entry: {
              title: loreEdit.title,
              keys: loreEdit.keysText,
              constant: loreEdit.constant,
              order: Number(loreEdit.order) || 0,
              probability: Number(loreEdit.probability),
              body: loreEdit.body,
            },
          });
          if (!res?.ok) throw new Error(res?.error ?? '保存失败');
          applyLoreResponse(res);
          setLoreEdit(null);
          setMsg({ kind: 'ok', text: `已写入世界书：${res.title}（下一轮装配即生效）` });
        } catch (error) {
          setMsg({ kind: 'err', text: String(error?.message ?? error) });
        } finally { setBusy(''); }
      }

      /** 就地切换「常驻」（列表里的复选框，最常用的那一个开关）。 */
      async function toggleLoreConstant(entry, constant) {
        setBusy(`lore-c:${entry.title}`);
        try {
          const full = await API.loreEntry(sessionId, entry.title);
          if (!full?.ok) throw new Error(full?.error ?? '读取条目失败');
          const res = await API.loreSave({
            sessionId,
            action: 'update',
            title: entry.title,
            entry: { ...full.entry, constant },
          });
          if (!res?.ok) throw new Error(res?.error ?? '保存失败');
          applyLoreResponse(res);
          setMsg({ kind: 'ok', text: `「${entry.title}」${constant ? '改为常驻' : '取消常驻'}` });
        } catch (error) {
          setMsg({ kind: 'err', text: String(error?.message ?? error) });
        } finally { setBusy(''); }
      }

      /** 把旧版共享世界书**显式**并入本会话（不自动继承，见 ensureSessionLore 的注释）。 */
      async function importLegacyLore() {
        if (!window.confirm('把工作区根目录那份旧共享世界书里的条目并入本会话？\n只影响本会话；同名条目会跳过。')) return;
        setBusy('lore-legacy');
        try {
          const res = await API.loreSave({ sessionId, action: 'importLegacy', legacyFile: lore?.legacy });
          if (!res?.ok) throw new Error(res?.error ?? '并入失败');
          applyLoreResponse(res);
          setLoreEdit(null);
          setMsg({
            kind: 'ok',
            text: res.imported
              ? `已并入 ${res.imported} 条旧世界书条目（同名跳过）`
              : '没有可并入的条目（旧文件为空，或同名条目都在了）',
          });
        } catch (error) {
          setMsg({ kind: 'err', text: String(error?.message ?? error) });
        } finally { setBusy(''); }
      }

      /** 整本书「属性中文化」（老世界书里的 name:/gender: 之类一键换成中文）。 */
      async function localizeLoreAll() {
        if (!window.confirm('把整本世界书里 YAML 风格的英文属性键换成中文？（name→名称、gender: Female→性别：女 …）\n只会改这类属性行，正文与触发词不动。')) return;
        setBusy('lore-lz');
        try {
          const res = await API.loreSave({ sessionId, action: 'localize' });
          if (!res?.ok) throw new Error(res?.error ?? '处理失败');
          applyLoreResponse(res);
          setLoreEdit(null);
          setMsg({
            kind: 'ok',
            text: res.changed
              ? `已把 ${res.changed} 条、共 ${res.lines} 行属性标签中文化`
              : '没有需要中文化的属性行（这本世界书里没有 name:/gender: 这种英文键）',
          });
        } catch (error) {
          setMsg({ kind: 'err', text: String(error?.message ?? error) });
        } finally { setBusy(''); }
      }

      async function deleteLoreEntry(title) {
        if (!window.confirm(`删除世界书条目「${title}」？（只删这一条，文件里其它内容不动）`)) return;
        setBusy('lore-del');
        try {
          const res = await API.loreSave({ sessionId, action: 'delete', title });
          if (!res?.ok) throw new Error(res?.error ?? '删除失败');
          applyLoreResponse(res);
          setLoreEdit(null);
          setMsg({ kind: 'ok', text: `已删除条目「${title}」` });
        } catch (error) {
          setMsg({ kind: 'err', text: String(error?.message ?? error) });
        } finally { setBusy(''); }
      }

      /** 写操作返回的就是最新条目清单，直接拿来更新界面（省掉一次刷新往返）。 */
      function applyLoreResponse(res) {
        setLore({
          ok: true,
          exists: true,
          file: res.file,
          relative: res.relative,
          chars: res.chars,
          total: res.total,
          constant: res.constant,
          keyed: res.keyed,
          entries: res.entries ?? [],
          truncated: res.truncated,
          note: res.note,
        });
      }

      async function roll(table) {
        setBusy(`roll:${table.name}`);
        try {
          const res = await API.roll({ sessionId, name: table.name, count: 1 });
          if (!res?.ok) throw new Error(res?.error ?? '掷表失败');
          setRolls((prev) => [`${res.note} ${res.lines.join('；')}`, ...prev].slice(0, 6));
        } catch (error) {
          setMsg({ kind: 'err', text: String(error?.message ?? error) });
        } finally { setBusy(''); }
      }

      async function runPreview(styleKey, prompt) {
        setBusy('preview');
        setPreview(null);
        setMsg({ kind: 'ok', text: '出图中…（本机约 15～20 秒；出完自动滚到「生图配置」卡片里的预览图）' });
        try {
          const res = await API.preview({ sessionId, style: styleKey, prompt });
          if (!res?.ok) throw new Error(res?.error ?? '预览失败');
          // 宿主返回的是 styleKey / styleLabel，没有 `style` 字段（读错会显示成空）
          const label = res.styleLabel || res.styleKey || styleKey || '默认风格';
          setPreview({ url: res.media?.[0], elapsedMs: res.elapsedMs, style: label });
          setMsg({ kind: 'ok', text: `预览完成：${label}（${(res.elapsedMs / 1000).toFixed(1)}s）—— 图在下方「生图配置」卡片里` });
        } catch (error) {
          setMsg({ kind: 'err', text: String(error?.message ?? error) });
        } finally { setBusy(''); }
      }

      /** 某个角色的立绘：出图后挂在**这个角色自己**的卡片下面（按角色名存取）。 */
      async function runPortrait(character) {
        const name = String(character?.name ?? '').trim();
        if (!name) { setMsg({ kind: 'err', text: '先给角色起个名字，立绘要用它做画面描述（也用它记住这张图属于谁）' }); return; }
        setBusy(`portrait:${name}`);
        setPortraits((p) => { const n = { ...p }; delete n[name]; return n; });
        setMsg({ kind: 'ok', text: `「${name}」立绘出图中…（本机约 15～20 秒）` });
        try {
          const res = await API.preview({
            sessionId,
            style: draft?.defaultStyle || undefined,
            prompt: `${name} 的半身立绘，正面，中性背景`,
          });
          if (!res?.ok) throw new Error(res?.error ?? '出图失败');
          const label = res.styleLabel || res.styleKey || '';
          setPortraits((p) => ({ ...p, [name]: { url: res.media?.[0], style: label, elapsedMs: res.elapsedMs } }));
          setMsg({ kind: 'ok', text: `「${name}」立绘完成（${label}，${(res.elapsedMs / 1000).toFixed(1)}s）—— 图在该角色的卡片下方` });
        } catch (error) {
          setMsg({ kind: 'err', text: String(error?.message ?? error) });
        } finally { setBusy(''); }
      }

      if (!draft || !state) {
        return h('div', { className: embed ? 'rpt embed' : 'rpt ovl' }, [
          h('div', { key: 'hd', className: 'ovlhead' }, [
            h('h3', { key: 't' }, 'RP'), h('span', { key: 's', className: 'sep' }),
            embed ? null : h('button', { key: 'x', onClick: onClose }, '关闭'),
          ]),
          h('div', { key: 'm', className: 'dim' }, busy === 'load' ? '读取中…' : (msg?.text ?? '未加载')),
        ]);
      }

      const chars = draft.characters ?? [];
      const tables = draft.tables ?? [];
      // 当前状态（场景/时间/地点/在场/线索 + 队伍 + 旗标）。老会话可能没有，给空对象兜底。
      const st = draft.state ?? {};

      return h('div', { className: embed ? 'rpt embed' : 'rpt ovl' }, [
        h('div', { key: 'head', className: 'ovlhead' }, [
          h('h3', { key: 't' }, 'RP'),
          state.isDm ? h('span', { key: 'b', className: 'badge ok' }, 'DM 会话') : h('span', { key: 'b', className: 'badge warn' }, '非 DM'),
          h('span', { key: 'sep', className: 'sep' }),
          h('button', { key: 'r', onClick: reload, disabled: Boolean(busy) }, '刷新'),
          h('button', { key: 'sv', className: 'primary', onClick: save, disabled: Boolean(busy) }, busy === 'save' ? '保存中…' : '保存'),
          embed ? null : h('button', { key: 'x', onClick: onClose }, '关闭'),
        ]),
        msg ? h('div', { key: 'msg', className: 'msg' }, msg.text) : null,

        h('div', { key: 'world', className: 'card' }, [
          h('h4', { key: 't' }, '世界设定'),
          h('textarea', {
            key: 'w', value: draft.world ?? '', placeholder: '世界观、时代、地点、基调……',
            onChange: (e) => patch({ world: e.target.value }),
          }),
          h('div', { key: 'd', className: 'dim' }, `本会话配置文件（DM 也能用 read/write 直接改）：${state.file ?? ''}`),
        ]),

        // ── 宏（按会话隔离）：`{{user}}` 与自定义 `{{x}}` 的值 ──────────────────
        // 值存在会话配置里，宿主会用同名**变量**在注入时插值 —— 所以改完保存，
        // 世界设定 / 世界书条目里写的 `{{x}}` 立刻跟着变（不是把值烤进文件）。
        h('div', { key: 'macros', className: 'card' }, [
          h('div', { key: 'h', className: 'row' }, [
            h('h4', { key: 't' }, `宏 / 变量（${Object.keys(draft.macros ?? {}).length}）`),
            h('span', { key: 'sep', className: 'sep' }),
            h('span', { key: 'd', className: 'dim' }, `按会话隔离；{{user}} 留空 = 全局「${globalUserLabel || '玩家'}」`),
          ]),
          ...Object.entries(draft.macros ?? {}).map(([name, value], i) => h('div', { key: `m${i}`, className: 'row macrorow' }, [
            h('span', { key: 'n', className: 'mono' }, `{{${name}}}`),
            h('input', {
              key: 'v', type: 'text', value,
              onChange: (e) => patch({ macros: { ...(draft.macros ?? {}), [name]: e.target.value } }),
            }),
            h('button', {
              key: 'd', className: 'tiny',
              onClick: () => { const next = { ...(draft.macros ?? {}) }; delete next[name]; patch({ macros: next }); },
            }, '×'),
          ])),
          h('div', { key: 'add', className: 'row' }, [
            h('input', {
              key: 'nn', type: 'text', value: newMacroName, placeholder: '宏名（小写字母/数字/下划线）',
              onChange: (e) => setNewMacroName(e.target.value),
            }),
            h('button', {
              key: 'ab', className: 'tiny',
              onClick: () => {
                const name = newMacroName.trim().toLowerCase();
                if (!MACRO_RE.test(name)) { setMsg({ kind: 'err', text: '宏名只能用 小写字母开头 + 小写字母/数字/下划线' }); return; }
                if ((draft.macros ?? {})[name] !== undefined) { setMsg({ kind: 'err', text: `已经有 {{${name}}} 了` }); return; }
                patch({ macros: { ...(draft.macros ?? {}), [name]: '' } });
                setNewMacroName('');
              },
            }, '＋ 添加宏'),
          ]),
          h('div', { key: 'note', className: 'dim' },
            '在世界设定 / 世界书条目里写 `{{名字}}`，注入时会被替换成这里的值（宿主原生插值，不用重启）。'),
        ]),

        // 世界书：条目都在工作区的 rp-worldbook.md 里，只有命中的才进每轮上下文。
        // 面板里可以直接**查看详情 / 编辑 / 新建 / 删除**，并就地切换「常驻」
        // （参考 dsh-liketavern 的 lorebookEditor：列表 + 详情表单 + 常驻开关 + 概率/顺序）。
        h('div', { key: 'lore', className: 'card' }, [
          h('div', { key: 'h', className: 'row' }, [
            h('h4', { key: 't' }, `世界书（${lore?.total ?? '…'} 条）`),
            h('span', { key: 'sep', className: 'sep' }),
            h('button', {
              key: 'n', className: 'tiny', disabled: Boolean(busy),
              onClick: () => beginLore(null),
            }, '＋ 新建条目'),
            // 老世界书（导入功能之前写的）里可能全是 name:/gender: Female 这种英文键，一键中文化
            h('button', {
              key: 'lz', className: 'tiny', disabled: Boolean(busy),
              title: '把整本书里 YAML 风格的英文属性键换成中文（name→名称、gender: Female→性别：女 …）',
              onClick: () => void localizeLoreAll(),
            }, busy === 'lore-lz' ? '处理中…' : '属性中文化'),
            h('button', { key: 'r', className: 'tiny', onClick: () => void loadLore(), disabled: busy === 'lore' },
              busy === 'lore' ? '读取中…' : '刷新'),
          ]),
          lore && lore.exists === false
            ? h('div', { key: 'none', className: 'dim' }, '本会话还没有自己的世界书。用「📖 导入故事书」导入一张卡，或让 DM 用 rp_lore 生成模板。')
            : null,
          // 旧版的世界书在**工作区根目录**、按工作区共享（谁都能写，混着好几个会话的条目）。
          // 归属无法判断，所以**绝不自动继承** —— 只提示存在，并进来与否由用户点。
          lore && lore.legacyExists
            ? h('div', { key: 'mig', className: 'lorelegacy' }, [
              h('div', { key: 't', className: 'dim' },
                '⚠ 发现旧版本的共享世界书（工作区根目录的 rp-worldbook.md）：历史上多个会话共用过它，归属已无法判断，'
                + '所以本会话**没有**继承它。要并进本会话就点右边按钮（只影响本会话）。'),
              h('div', { key: 'a', className: 'row' }, [
                h('button', {
                  key: 'b', className: 'tiny', disabled: Boolean(busy),
                  onClick: () => void importLegacyLore(),
                }, busy === 'lore-legacy' ? '并入中…' : '把旧世界书并入本会话'),
                h('span', { key: 'p', className: 'mono dim' }, lore.legacy ?? ''),
              ]),
            ])
            : null,
          lore && lore.exists
            ? h('div', { key: 'stat', className: 'dim' },
              `${lore.total} 条（常驻 ${lore.constant}｜带触发词 ${lore.keyed}）· ${lore.chars} 字 · ${lore.relative ?? 'rp-worldbook.md'}`
              + `${lore.truncated ? '（条目过多，只列出前 400 条）' : ''}`)
            : null,
          // 搜索：条目一多就得能筛（标题 / 触发词 / 正文预览）
          lore && lore.exists && (lore.entries ?? []).length > 6
            ? h('input', {
              key: 'q', type: 'search', value: loreQuery, placeholder: '搜索条目名、触发词或正文…',
              onChange: (e) => setLoreQuery(e.target.value),
            })
            : null,
          lore && lore.exists
            ? h('div', { key: 'list', className: 'scroll lorelist' }, visibleLoreEntries().map((e, i) => h('div', { key: `e${i}`, className: 'loreitem' }, [
              h('div', { key: 'h', className: 'row' }, [
                h('span', { key: 't', className: 'loretitle' }, e.title),
                e.constant ? h('span', { key: 'c', className: 'badge ok' }, '常驻') : null,
                e.order ? h('span', { key: 'o', className: 'badge' }, `order ${e.order}`) : null,
                e.probability !== undefined && e.probability < 100 ? h('span', { key: 'p', className: 'badge warn' }, `${e.probability}%`) : null,
                h('span', { key: 'n', className: 'dim' }, `${e.chars} 字`),
              // 折叠态**只有这一行**：名称 / 常驻 / order / 字数 + 右侧的常驻开关与「详情 / 编辑」。
              // 触发词与正文都收进详情里 —— 一屏能扫完十几条，比每条摊开几千字有用得多。
              (Array.isArray(e.keys) && e.keys.length) || e.constant
                ? null
                : h('span', {
                  key: 'warn', className: 'badge warn',
                  title: '既没有触发词也不是常驻 → 这条永远不会被注入，建议补触发词或勾上「常驻」',
                }, '⚠ 永不触发'),
              h('span', { key: 's', className: 'sep' }),
              // 常驻开关**就地可改**（用户明确要的），改完立刻写回文件
              h('label', { key: 'cc', className: 'dim loreconst', title: '常驻：不看触发词，每轮都注入' }, [
                h('input', {
                  key: 'c', type: 'checkbox', checked: e.constant === true, disabled: Boolean(busy),
                  onChange: (ev) => void toggleLoreConstant(e, ev.target.checked),
                }),
                '常驻',
              ]),
              h('button', {
                key: 'ed', className: 'tiny', disabled: Boolean(busy),
                // 已经展开的那条再点一次就是**收起**（第一版这里永远调 beginLore，于是只能展开、收不起来）
                onClick: () => {
                  if (loreEdit && loreEdit.title === e.title) setLoreEdit(null);
                  else void beginLore(e);
                },
              }, loreEdit && loreEdit.title === e.title ? '收起' : '详情 / 编辑'),
            ]),
            // 详情 / 编辑：就地展开在这一条下面（正文全文都在表单里，可读也可改）
            loreEdit && loreEdit.title === e.title
              ? h('div', { key: 'form', className: 'loreform' }, [
                h('div', { key: 'meta', className: 'dim' },
                  `触发词：${(Array.isArray(e.keys) && e.keys.length) ? e.keys.join('、') : '（无）'}`),
                h('label', { key: 'l1', className: 'dim' }, '标题'),
                h('input', { key: 'f1', type: 'text', value: loreEdit.title, onChange: (ev) => patchLoreEdit({ title: ev.target.value }) }),
                h('label', { key: 'l2', className: 'dim' }, '触发词（逗号分隔）'),
                h('input', {
                  key: 'f2', type: 'text', value: loreEdit.keysText, placeholder: '命中这些词时注入；留空则必须勾「常驻」',
                    onChange: (ev) => patchLoreEdit({ keysText: ev.target.value }),
                  }),
                  h('div', { key: 'f5', className: 'row' }, [
                    h('label', { key: 'c1', className: 'dim' }, [
                      h('input', { key: 'c2', type: 'checkbox', checked: loreEdit.constant, onChange: (ev) => patchLoreEdit({ constant: ev.target.checked }) }),
                      ' 常驻（不看触发词）',
                    ]),
                    h('label', { key: 'o1', className: 'dim' }, [
                      'order ',
                      h('input', {
                        key: 'o2', type: 'number', value: loreEdit.order, style: { width: 64 },
                        onChange: (ev) => patchLoreEdit({ order: ev.target.value }),
                      }),
                    ]),
                    h('label', { key: 'p1', className: 'dim' }, [
                      '概率 ',
                      h('input', {
                        key: 'p2', type: 'number', min: 0, max: 100, value: loreEdit.probability, style: { width: 64 },
                        onChange: (ev) => patchLoreEdit({ probability: ev.target.value }),
                      }),
                    ]),
                  ]),
                  h('label', { key: 'l3', className: 'dim' }, `正文（${String(loreEdit.body ?? '').length} 字）`),
                  h('textarea', {
                    key: 'f3', className: 'lorebody', value: loreEdit.body,
                    placeholder: '写进提示词的正文', onChange: (ev) => patchLoreEdit({ body: ev.target.value }),
                  }),
                  h('div', { key: 'f4', className: 'row' }, [
                    h('button', { key: 'sv', className: 'primary tiny', disabled: Boolean(busy), onClick: () => void saveLoreEdit() },
                      busy === 'lore-save' ? '保存中…' : '保存'),
                    h('button', { key: 'ca', className: 'tiny', onClick: () => setLoreEdit(null) }, '取消'),
                    h('span', { key: 'sep', className: 'sep' }),
                    h('button', { key: 'rm', className: 'tiny', disabled: Boolean(busy), onClick: () => void deleteLoreEntry(loreEdit.title) }, '删除条目'),
                  ]),
                  h('div', { key: 'w', className: 'dim' },
                    '改动只重写这一条；文件里其它条目与你手写的注释都不会被动。保存后下一轮装配即生效。'),
                ])
                : null,
            ])))
            : null,
          lore && lore.exists
            ? h('div', { key: 'note', className: 'dim' },
              `只有命中的条目才进每轮上下文。文件：${lore.file ?? ''} —— 可以直接编辑，DM 也能用 read/write 维护。`)
            : null,
        ]),

        h('div', { key: 'chars', className: 'card' }, [
          h('h4', { key: 't' }, `角色卡（${chars.length}）`),
          ...chars.map((c, i) => {
            // 立绘按**角色名**存取，而不是按数组下标 —— 删掉中间一个角色时下标会整体前移，
            // 那样立绘就会串到别的角色身上。
            const pkey = String(c.name ?? '').trim();
            const portrait = pkey ? portraits[pkey] : undefined;
            // 导入 PNG 卡时登记的卡面（会话配置里的 portraits）：没生成过立绘时直接当立绘用，
            // 生成过就排在生成图下面 —— 卡面是「原图」，不覆盖用户的出图结果。
            const cardRel = pkey ? draft?.portraits?.[pkey]?.card : undefined;
            // 卡库默认在会话工作区下 → 拼卡面 URL 也要带上 cwd（state.cwd 来自 /rp-tools/session）
            const cardUrl = typeof cardRel === 'string' && cardRel ? cardImageUrl(cardRel, state?.cwd ?? '') : '';
            const setField = (field, value) => {
              const n = [...chars];
              n[i] = { ...n[i], [field]: value };
              patch({ characters: n });
            };
            // 角色索引：常驻的紧凑名单（brief / always）。缺条目时按名字现建一条。
            const idx = Array.isArray(draft.characterIndex) ? draft.characterIndex : [];
            const idxEntry = idx.find((e) => String(e?.name ?? '') === String(c.name ?? '')) ?? null;
            const patchIndex = (field, value) => {
              const name = String(c.name ?? '').trim();
              if (!name) { setMsg({ kind: 'err', text: '先给角色起个名字，才能设置它的索引' }); return; }
              const rest = idx.filter((e) => String(e?.name ?? '') !== name);
              patch({ characterIndex: [...rest, { ...(idxEntry ?? { name, brief: '', always: false }), name, [field]: value }] });
            };
            // 进阶字段（设定层）：平时折叠，避免 5 个角色就把面板撑得很长
            const filled = ['personality', 'speech', 'behavior', 'first_mes', 'mes_example', 'relations']
              .filter((f) => String(c[f] ?? '').trim());
            return h('div', { key: `c${i}`, className: 'charbox' }, [
              h('div', { key: 'line', className: 'charline' }, [
                h('input', {
                  key: 'n', type: 'text', value: c.name ?? '', placeholder: '角色名',
                  onChange: (e) => setField('name', e.target.value),
                }),
                h('input', {
                  key: 'a', type: 'text', value: c.appearance ?? '', placeholder: '外观描述（生图时自动补进提示词）',
                  onChange: (e) => setField('appearance', e.target.value),
                }),
                h('button', {
                  key: 'p', className: 'tiny',
                  // 出图期间禁用：避免同时再发一张（每次 ~18 秒，且都排同一个 ComfyUI 队列）
                  disabled: Boolean(busy),
                  onClick: () => runPortrait(c),
                }, busy === `portrait:${pkey}` ? '出图中…' : '立绘'),
                h('button', {
                  key: 'd', className: 'tiny',
                  onClick: () => {
                    if (pkey) setPortraits((p) => { const n = { ...p }; delete n[pkey]; return n; });
                    patch({ characters: chars.filter((_, j) => j !== i) });
                  },
                }, '删'),
              ]),
              // 常驻展开：勾上则这个角色的完整卡片每轮都注入（主角用），否则只在出场时展开
              h('label', { key: 'always', className: 'dim', style: { display: 'flex', gap: 6, alignItems: 'center', marginTop: 4, fontSize: 12 } }, [
                h('input', {
                  key: 'cb', type: 'checkbox', checked: idxEntry?.always === true,
                  onChange: (e) => patchIndex('always', e.target.checked),
                }),
                '常驻展开完整设定（主角用；不勾则只在它出场的那几轮注入，省 token）',
              ]),
              // 设定层字段：折叠起来，填过的会在标题里列出来
              h('details', { key: 'adv', className: 'chargrow' }, [
                h('summary', { key: 's', className: 'dim' },
                  `设定细节${filled.length ? `（已填 ${filled.length} 项：${filled.join('、')}）` : '（性格 / 口癖 / 开场白… 填了扮演更稳）'}`),
                h('div', { key: 'b', className: 'chargrid' }, [
                  h('span', { key: 'i1', className: 'dim' }, '索引简介'),
                  h('input', {
                    key: 'i2', type: 'text',
                    value: idxEntry?.brief ?? '',
                    placeholder: '常驻显示的一句话（默认取外观首句）——详细卡片在角色出场时才注入',
                    onChange: (e) => patchIndex('brief', e.target.value),
                  }),
                  h('span', { key: 'p1', className: 'dim' }, '性格'),
                  h('textarea', {
                    key: 'p2', value: c.personality ?? '', placeholder: '表层 → 深层 → 矛盾点，以及对待玩家的基本态度',
                    onChange: (e) => setField('personality', e.target.value),
                  }),
                  h('span', { key: 's1', className: 'dim' }, '口癖/语气'),
                  h('textarea', {
                    key: 's2', value: c.speech ?? '', placeholder: '可观察的量化特征，如「句子短、爱用反问、管玩家叫小子」',
                    onChange: (e) => setField('speech', e.target.value),
                  }),
                  h('span', { key: 'b1', className: 'dim' }, '行为习惯'),
                  h('textarea', {
                    key: 'b2', value: c.behavior ?? '', placeholder: '紧张时做什么、面对威胁的第一反应……',
                    onChange: (e) => setField('behavior', e.target.value),
                  }),
                  h('span', { key: 'r1', className: 'dim' }, '人物关系'),
                  h('textarea', {
                    key: 'r2', value: c.relations ?? '', placeholder: '与其他角色的关系，如「祁俊的师父，亦师亦母」',
                    onChange: (e) => setField('relations', e.target.value),
                  }),
                  h('span', { key: 'f1', className: 'dim' }, '开场白'),
                  h('textarea', {
                    key: 'f2', value: c.first_mes ?? '', placeholder: '该角色初次登场的原文 —— 最有效的文风锚点（注入时取前 300 字）',
                    onChange: (e) => setField('first_mes', e.target.value),
                  }),
                  h('span', { key: 'm1', className: 'dim' }, '对话范例'),
                  h('textarea', {
                    key: 'm2', value: c.mes_example ?? '', placeholder: '2~4 轮，格式「角色名：台词」',
                    onChange: (e) => setField('mes_example', e.target.value),
                  }),
                ]),
              ]),
              // 立绘就挂在这个角色下面：生成的立绘优先，导入的卡面垫在后面
              (portrait || cardUrl) ? h('div', { key: 'pt', className: 'portrait' }, [
                cardUrl ? h('img', { key: 'ci', src: cardUrl, alt: `${pkey} 卡面`, title: '导入的卡面' }) : null,
                portrait
                  ? (portrait.url
                    ? h('img', { key: 'i', src: portrait.url, alt: `${pkey} 立绘` })
                    : h('div', { key: 'i', className: 'dim' }, '（无图）'))
                  : null,
                h('div', { key: 'l', className: 'row' }, [
                  h('span', { key: 's', className: 'dim' },
                    portrait
                      ? `立绘：${pkey}${portrait.style ? ` · ${portrait.style}` : ''}（${(portrait.elapsedMs / 1000).toFixed(1)}s）`
                      : `卡面：${pkey}（导入 PNG 卡时带进来的）`),
                  portrait?.url ? h('a', { key: 'o', className: 'dim', href: portrait.url, target: '_blank', rel: 'noreferrer' }, '大图') : null,
                  portrait
                    ? h('button', { key: 'x', className: 'tiny', onClick: () => setPortraits((p) => { const n = { ...p }; delete n[pkey]; return n; }) }, '收起')
                    : (cardUrl ? h('a', { key: 'co', className: 'dim', href: cardUrl, target: '_blank', rel: 'noreferrer' }, '原图') : null),
                ]),
              ]) : null,
            ]);
          }),
          h('button', { key: 'add', className: 'tiny', onClick: () => patch({ characters: [...chars, { name: '', appearance: '' }] }) }, '+ 添加角色'),
        ]),

        // 随机表：**没有表时整张卡片不渲染**（一张「RP 表格 / 随机表（0）」摆在面板里
        // 只是噪音）；真建了表才出现，掷表入口也随之回来。
        tables.length ? h('div', { key: 'tables', className: 'card' }, [
          h('h4', { key: 't' }, `RP 表格 / 随机表（${tables.length}）`),
          h('div', { key: 'd', className: 'dim' }, '遭遇表 / 掉落表 / 情绪表…… 也可以让 DM 掷：「掷<表名>」（走 rp_table 工具）。'),
          ...tables.map((t, i) => h('div', { key: `t${i}`, className: 'tbl' }, [
            h('span', { key: 'n' }, `${t.name}  `, h('span', { className: 'mono dim' }, `${t.dice} / ${t.entries.length} 条`)),
            h('button', { key: 'r', className: 'tiny', disabled: Boolean(busy), onClick: () => roll(t) }, busy === `roll:${t.name}` ? '…' : '掷'),
            h('button', { key: 'd', className: 'tiny', onClick: () => patch({ tables: tables.filter((_, j) => j !== i) }) }, '删'),
          ])),
          rolls.length ? h('div', { key: 'res', className: 'msg' }, rolls.map((r, i) => h('div', { key: i }, r))) : null,
          h('div', { key: 'new', style: { display: 'flex', flexDirection: 'column', gap: 6 } }, [
            h('div', { key: 'r1', className: 'row' }, [
              h('input', { key: 'n', type: 'text', placeholder: '表名，如 地下城遭遇表', value: tableDraft.name, style: { flex: '1 1 140px' }, onChange: (e) => setTableDraft({ ...tableDraft, name: e.target.value }) }),
              h('input', { key: 'dc', type: 'text', placeholder: '骰式（空=1dN）', value: tableDraft.dice, style: { flex: '1 1 100px' }, onChange: (e) => setTableDraft({ ...tableDraft, dice: e.target.value }) }),
            ]),
            h('textarea', {
              key: 'e', placeholder: '条目，一行一条（按顺序对应点数）', value: tableDraft.entries,
              onChange: (e) => setTableDraft({ ...tableDraft, entries: e.target.value }),
            }),
            h('button', {
              key: 'add', className: 'tiny',
              onClick: () => {
                const entries = tableDraft.entries.split('\n').map((s) => s.trim()).filter(Boolean);
                if (!tableDraft.name.trim() || entries.length === 0) { setMsg({ kind: 'err', text: '表名与至少一条条目必填' }); return; }
                patch({ tables: [...tables, { name: tableDraft.name.trim(), dice: tableDraft.dice.trim() || `1d${entries.length}`, entries }] });
                setTableDraft({ name: '', dice: '', entries: '' });
              },
            }, '+ 添加表'),
          ]),
        ]) : null,

        h('div', { key: 'state', className: 'card' }, [
          h('div', { key: 'h', className: 'row' }, [
            h('h4', { key: 't' }, '当前状态'),
            h('span', { key: 'd', className: 'dim' }, '每轮自动注入 DM 的上下文；对话历史被压缩后靠它兜住'),
          ]),
          h('div', { key: 'kv', className: 'kv' }, [
            h('span', { key: 's1' }, '场景'),
            h('input', { key: 's2', type: 'text', value: st.scene ?? '', onChange: (e) => patchState('scene', e.target.value) }),
            h('span', { key: 't1' }, '时间'),
            h('input', { key: 't2', type: 'text', value: st.time ?? '', onChange: (e) => patchState('time', e.target.value) }),
            h('span', { key: 'l1' }, '地点'),
            h('input', { key: 'l2', type: 'text', value: st.location ?? '', onChange: (e) => patchState('location', e.target.value) }),
            h('span', { key: 'p1' }, '在场'),
            h('input', { key: 'p2', type: 'text', value: st.present ?? '', placeholder: '除队伍成员外的在场者', onChange: (e) => patchState('present', e.target.value) }),
            h('span', { key: 'c1' }, '线索'),
            h('input', { key: 'c2', type: 'text', value: st.clues ?? '', onChange: (e) => patchState('clues', e.target.value) }),
          ]),
          // 队伍成员：状态 / 持有 / 伤病 / 目标，一行一个人
          h('div', { key: 'party' }, [
            h('div', { key: 'l', className: 'dim' }, `队伍状态（${(st.party ?? []).length} 人）—— 由 DM 用 rp_state 维护，这里可以直接改`),
            ...(st.party ?? []).map((row, i) => h('div', { key: `p${i}`, className: 'partylines' }, [
              h('span', { key: 'n' }, row.character || '（未具名）'),
              h('span', { key: 's', className: 'dim' }, row.status ? `状态：${row.status}` : ''),
              row.conditions ? h('span', { key: 'c', className: 'badge warn' }, row.conditions) : null,
              row.inventory ? h('span', { key: 'i', className: 'dim mono' }, `持有：${row.inventory}`) : null,
              row.goal ? h('span', { key: 'g', className: 'dim' }, `目标：${row.goal}`) : null,
            ])),
          ]),
          // 旗标：伏笔 / 声望 / 倒计时等自由键值
          Object.keys(st.flags ?? {}).length ? h('div', { key: 'flags', className: 'row', style: { flexWrap: 'wrap', gap: 6 } }, [
            h('span', { key: 'l', className: 'dim' }, '旗标：'),
            ...Object.entries(st.flags).map(([k, v]) => h('span', { key: k, className: 'mono dim' }, `${k}=${v}`)),
          ]) : null,
        ]),

        h('div', { key: 'style', className: 'card' }, [
          h('h4', { key: 't' }, '生图配置（本会话）'),
          h('div', { key: 'kv', className: 'kv' }, [
            h('span', { key: 's1' }, '会话默认风格'),
            h('select', {
              key: 's2', value: draft.defaultStyle ?? '',
              onChange: (e) => patch({ defaultStyle: e.target.value }),
            }, [
              h('option', { key: '', value: '' }, `（跟随全局：${styles?.config?.defaultStyle ?? '?'}）`),
              ...Object.keys(styles?.config?.styles ?? {}).map((k) => h('option', { key: k, value: k }, `${styles.config.styles[k].label} (${k})`)),
            ]),
          ]),
          h('div', { key: 'act', className: 'row' }, [
            h('button', { key: 't', disabled: Boolean(busy), onClick: () => runPreview(draft.defaultStyle || undefined, '一位旅人站在岔路口，远处有灯火') },
              busy === 'preview' ? '出图中…' : '用本会话配置试出一张'),
          ]),
          // 预览结果就在按钮下方（点完图就在眼前，不用去别处找）
          preview ? h('div', { key: 'prev', className: 'card', ref: previewRef }, [
            h('div', { key: 'l', className: 'row' }, [
              h('span', { key: 't', className: 'dim' }, `预览：${preview.style ?? ''}（${(preview.elapsedMs / 1000).toFixed(1)}s）`),
              h('span', { key: 'sep', className: 'sep' }),
              preview.url ? h('a', { key: 'o', className: 'dim', href: preview.url, target: '_blank', rel: 'noreferrer' }, '新标签打开大图') : null,
            ]),
            preview.url ? h('img', { key: 'i', className: 'pv', src: preview.url, alt: 'preview' }) : null,
          ]) : null,
          // 提示词前缀 / 风格备注 / 战役名仍在会话数据里（DM 用 rp_session 工具设置），
          // 这里不再放输入框：保存时原样回写，不会因为界面精简而被清掉。
          h('div', { key: 'more', className: 'dim' },
            `提示词前缀 / 风格备注 / 战役名由 DM 用 rp_session 工具维护${draft.campaign?.name ? `（当前战役：${draft.campaign.name}）` : ''}`),
        ]),
      ]);
    }

    /**
     * 取当前会话 id：钩子优先，其次槽位的 sessionId / session.id。
     * 空串要当「真值缺失」跳过 —— 否则会把后面的兜底全部短路（按钮静默不出现）。
     */
    function pickSessionId(props) {
      const fromHook = typeof props?.useSessions === 'function'
        ? props.useSessions((s) => s?.current)
        : undefined;
      return [fromHook, props?.sessionId, props?.session?.id]
        .find((v) => typeof v === 'string' && v !== '') || '';
    }

    /**
     * 本会话是不是 DM 会话：
     *   ① 权威：会话自己的预设 id（官方 agent-preset 标签读的同一字段），等于 dm 就是；
     *   ② 回退：预设投影还没就绪（旧会话 / 刚切过去）时问宿主登记表。
     * 判定为 dm 时顺手（每个会话一次）POST 登记，让宿主其它入口也认得。
     */
    function useDmSession(props) {
      const sessionId = pickSessionId(props);
      const agentPreset = typeof props?.useSessions === 'function'
        ? props.useSessions((s) => {
          const v = s?.byId?.[sessionId]?.projectionValues?.agentPreset;
          return typeof v === 'string' ? v : undefined;
        })
        : undefined;
      const presetSaysDm = agentPreset === 'dm';

      const [isDm, setIsDm] = React.useState(false);
      const registered = React.useRef(false);

      React.useEffect(() => {
        let alive = true;
        if (presetSaysDm) {
          setIsDm(true);
          if (sessionId && !registered.current) {
            registered.current = true;
            jpost('/rp-tools/dm-mark', { sessionId, preset: 'dm' }).catch(() => {});
          }
          return () => { alive = false; };
        }
        if (!sessionId) { setIsDm(false); return () => { alive = false; }; }
        API.session(sessionId)
          .then((r) => { if (alive) setIsDm(Boolean(r?.isDm)); })
          .catch(() => { if (alive) setIsDm(false); });
        return () => { alive = false; };
      }, [sessionId, presetSaysDm]);

      return { sessionId, isDm, known: presetSaysDm || Boolean(sessionId) };
    }

    /** 右侧栏页签里挂的面板：会话 id 由槽位 props 解析后传给面板本体。 */
    function RpSidebarTabBody(props) {
      const { sessionId, isDm, known } = useDmSession(props);
      if (!isDm) {
        return h('div', { className: 'rpt embed' }, [
          h('div', { key: 'm', className: 'dim' }, known ? '当前会话不是 DM 会话，RP 面板不可用。' : '正在识别会话…'),
        ]);
      }
      return h(RpSessionOverlay, { sessionId, variant: 'embed' });
    }

    /** 面板页签在右栏条上的小标题。 */
    function RpTabTitle() {
      return h('span', null, '🎲 RP');
    }

    /**
     * RP 面板此刻是不是正开着（右栏展开 **且** 活动页签是本插件的）。
     * 用 `ctx.inject` 拿服务：插件只硬注入 slots，右栏服务是延迟注入的。
     * 没装右栏时恒为 false，按钮就不显示按下态 —— 不会因此崩。
     */
    function useRpPanelOpen() {
      const [open, setOpen] = React.useState(false);
      React.useEffect(() => {
        let alive = true;
        let dispose = null;
        if (!ctxRef.current) return () => { alive = false; };
        try {
          dispose = ctxRef.current.inject(['sidebarRight'], (injected) => {
            const service = injected.sidebarRight;
            if (!service) return;
            const sync = () => {
              if (!alive) return;
              let next = false;
              try {
                next = service.isExpanded() === true && service.active()?.kind === RP_TAB_KIND;
              } catch { next = false; }
              setOpen(next);
            };
            sync();
            // 服务本身是命令式的，没暴露订阅 —— 用一个轻量轮询跟上它的状态变化。
            const timer = setInterval(sync, 400);
            return () => clearInterval(timer);
          });
        } catch { /* 没有右栏服务：保持未打开 */ }
        return () => {
          alive = false;
          if (typeof dispose === 'function') { try { dispose(); } catch { /* 忽略 */ } }
        };
      }, []);
      return open;
    }

    /** 会话头部右上角入口：点了把 RP 面板作为右侧栏页签打开。 */
    function RpHeaderButton(props) {
      const { isDm } = useDmSession(props);
      const isOpen = useRpPanelOpen();
      if (!isDm) return null;   // 非 DM 会话：一个像素都不渲染
      return h('button', {
        key: 'btn',
        type: 'button',
        className: 'rph-btn',
        'data-open': isOpen ? 'true' : 'false',
        'aria-pressed': isOpen,
        onClick: () => { if (openRpTab) openRpTab(); },
        title: 'RP 面板（世界 / 角色卡 / 随机表 / 生图配置）',
      }, [
        h('span', { key: 'g', className: 'glyph' }, '🎲'),
        h('span', { key: 't' }, 'RP'),
      ]);
    }

    // ── PNG 故事书导入（工作区那一行的入口）─────────────────────────────
    /**
     * 已经点过「导入」、正在等一个新的空白会话就位的任务。
     *
     * 为什么放在模块级而不是组件 state：新建会话会让**会话作用域的槽位子树重新挂载**，
     * 组件 state 被重置 → 任务永远等不到接手的那次渲染（这条踩过一次）。
     * 模块级变量跨重挂载存活，state 只用来触发一次重渲染。
     */
    let pendingImport = null;

    /**
     * 找到「工作区 / DM 主持人」那一行，并决定入口怎么贴上去。
     *
     * 为什么要在 DOM 上找：那一行的两个座位都是 single 且被官方插件占满，没有第三个槽位。
     * 为什么不只看「上一兄弟」：dock 的条目外面常有一层包装（每个 cell 一个容器），
     * 所以真正的那一行可能在**祖先的**上一兄弟上 —— 逐层往上找，找到就停。
     *
     * 三种结果：
     * - `{kind:'portal', row}`：那把 chip 用 portal 送进这一行（最好，正经的第三个 chip）；
     * - `{kind:'fixed', style}`：拿到行但没法 portal（没有 react-dom）→ 量出位置把 chip 贴上去；
     * - `null`：找不到 → 退回自己占一行（宁可难看也别消失）。
     */
    function findHeroRowSlot(root) {
      if (!root || typeof root !== 'object') return null;
      let node = root;
      let row = null;
      for (let up = 0; up < 4 && node && !row; up++) {
        let prev = node.previousElementSibling;
        while (prev && !row) {
          // 校验：里面已经有 chip（button），而且是个矮行（那一行只有 chip，没有大块内容）
          try {
            const hasButton = typeof prev.querySelector === 'function' && prev.querySelector('button');
            const rect = typeof prev.getBoundingClientRect === 'function' ? prev.getBoundingClientRect() : null;
            const short = !rect || !rect.height || rect.height <= 64;
            if (hasButton && short) row = prev;
          } catch { /* 这个候选不可用，继续往左找 */ }
          prev = prev.previousElementSibling;
        }
        node = node.parentElement;
      }
      if (!row) return null;
      if (ReactDOM && typeof ReactDOM.createPortal === 'function') return { kind: 'portal', row };
      try {
        const rect = typeof row.getBoundingClientRect === 'function' ? row.getBoundingClientRect() : null;
        if (!rect || !rect.width) return null;
        // 贴在那一行的最右端：纵向与行对齐，横向接在最后一个 chip 后面
        const kids = row.children ? Array.from(row.children) : [];
        const last = kids.length ? kids[kids.length - 1] : row;
        const lastRect = typeof last?.getBoundingClientRect === 'function' ? last.getBoundingClientRect() : rect;
        return {
          kind: 'fixed',
          style: {
            position: 'fixed',
            left: `${Math.round((lastRect.right || rect.right || rect.left) + 6)}px`,
            top: `${Math.round(rect.top + Math.max(0, (rect.height - 24) / 2))}px`,
            zIndex: 5,
          },
        };
      } catch { return null; }
    }

    /**
     * 在「工作区/输入框上方」那一行放一个折叠入口：点开 → 列卡库 → 选卡 → 导入并开始。
     *
     * 完整流程（每一步都有它必须存在的理由）：
     *   ① 目标会话：**当前会话**。若它已经开过局（非空白），宿主会拒绝改预设
     *      （`agent-preset/locked`），所以那时先 `uiWorkspace.startSession()` 新建一个，
     *      等它成为当前会话再继续 —— 这就是下面 pending 那段状态机。
     *   ② 预设：`remote.agentPresets.select(sessionId,'dm')`（官方 hero chip 用的是同一个
     *      接口，空白会话才能切）。切不动时**不静默**：把原因显示出来，导入照做。
     *   ③ 导入：POST /rp-tools/card-import —— 世界书追加写进工作区、卡全文与卡面落盘、
     *      角色卡与世界写进会话配置。解析全在宿主做（卡数据动辄几十万字）。
     *   ④ 开始游戏：把宿主备好的开场指令塞进输入框并提交。这条指令显式说了
     *      「不要再问世界从哪来」，否则 dm 预设的 persona 会先反问玩家一遍。
     */
    function RpCardImport(props) {
      // 异步回调里要拿到最新 props（React 的闭包会留住旧值）
      const propsRef = React.useRef(props);
      propsRef.current = props;
      // 卡库默认 <工作区>/rp-cards，所以请求卡库/卡面时要带上会话的 cwd（见 live.current.cwd）

      // 一律选**原始值**（对象选择器会在每次 store 变更时产生新引用 → 无限重渲染）
      const currentId = typeof props?.useSessions === 'function' ? props.useSessions((s) => s?.current) : undefined;
      const sessionId = [props?.sessionId, currentId].find((v) => typeof v === 'string' && v !== '') || '';
      const blank = typeof props?.useSessions === 'function'
        ? props.useSessions((s) => (sessionId ? s?.byId?.[sessionId]?.blank === true : false))
        : false;
      const cwd = typeof props?.useSessions === 'function'
        ? props.useSessions((s) => {
          const v = sessionId ? s?.byId?.[sessionId]?.cwd : undefined;
          return typeof v === 'string' ? v : '';
        })
        : '';
      const agentPreset = typeof props?.useSessions === 'function'
        ? props.useSessions((s) => {
          const v = sessionId ? s?.byId?.[sessionId]?.projectionValues?.agentPreset : undefined;
          return typeof v === 'string' ? v : '';
        })
        : '';
      const draftText = typeof props?.useInput === 'function' ? props.useInput((s) => s?.draft ?? '') : '';
      // 最新值放一份在 ref 里：startSession 之后的那次导入要用**新会话**的 cwd
      const live = React.useRef({});
      live.current = { sessionId, blank, cwd, agentPreset };
      // 卡库/卡面请求要用同一个 cwd（propsRef 在异步回调里是唯一能取到最新值的地方）
      propsRef.current = { ...props, _cwd: cwd };

      const [open, setOpen] = React.useState(false);
      const [q, setQ] = React.useState('');
      const [category, setCategory] = React.useState('');
      const [lib, setLib] = React.useState(null);
      const [items, setItems] = React.useState([]);
      const [total, setTotal] = React.useState(0);
      const [loading, setLoading] = React.useState(false);
      const [sel, setSel] = React.useState('');
      const [preview, setPreview] = React.useState(null);
      const [busy, setBusy] = React.useState('');
      const [msg, setMsg] = React.useState(null);
      const [result, setResult] = React.useState(null);
      const [autoStart, setAutoStart] = React.useState(true);
      // 用第几条开场白（导入时随请求发给宿主）
      const [greetingIndex, setGreetingIndex] = React.useState(0);
      // 宏行（导入表单用）：`user` 默认取全局玩家称呼，其余来自卡里扫到的宏名
      const [macroRows, setMacroRows] = React.useState([{ name: 'user', value: '' }]);
      const [newMacroName, setNewMacroName] = React.useState('');
      const [globalUserLabel, setGlobalUserLabel] = React.useState('');
      const globalUserLabelRef = React.useRef('');
      globalUserLabelRef.current = globalUserLabel;
      const setMacroRow = (i, value) => setMacroRows((rows) => rows.map((r, j) => (j === i ? { ...r, value } : r)));
      const removeMacroRow = (i) => setMacroRows((rows) => rows.filter((_, j) => j !== i));
      /** 导入表单里加一行自定义宏（名字按宿主变量规则校验）。 */
      function addMacroRow() {
        const name = newMacroName.trim().toLowerCase();
        if (!MACRO_RE.test(name)) { setMsg({ kind: 'err', text: '宏名只能用 小写字母开头 + 小写字母/数字/下划线' }); return; }
        if (macroRows.some((r) => r.name === name)) { setMsg({ kind: 'err', text: `已经有 {{${name}}} 了` }); return; }
        setMacroRows((rows) => [...rows, { name, value: '' }]);
        setNewMacroName('');
      }
      /** 卡预览回来后，用「卡里扫到的宏名」重建行（已经填过的值保留）。 */
      function applyDiscoveredMacros(found) {
        setMacroRows((rows) => {
          const byName = new Map(rows.map((r) => [r.name, r.value]));
          const names = ['user', ...(found ?? []).map((m) => m.name).filter((n) => n !== 'user')];
          const autoSet = new Set((found ?? []).filter((m) => m.auto).map((m) => m.name));
          return names.map((name) => ({
            name,
            auto: autoSet.has(name),
            // user 的默认值来自全局「玩家称呼」（设置页）；用户随手改掉也只影响本会话
            value: byName.get(name) ?? (name === 'user' ? globalUserLabelRef.current : ''),
          }));
        });
      }
      // 待办导入**放在模块级**：新建会话会让会话作用域的槽位子树重新挂载，
      // 那时组件 state 会被重置，任务就永远等不到接手的那次渲染（这条踩过一次）。
      const [pendingTick, setPendingTick] = React.useState(0);
      const pendingSend = React.useRef(null);
      const searchTimer = React.useRef(null);
      // 每张卡给一个稳定的 key（路径里可能有重名文件）
      const itemKey = (it, i) => `${i}:${it.path}`;

      React.useEffect(() => {
        if (open && globalUserLabel === '') {
          API.state().then((st) => setGlobalUserLabel(String(st?.config?.cards?.userLabel ?? ''))).catch(() => {});
        }
        if (open && lib === null) void load('');
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [open]);

      // 新建会话后接手导入：等它成为当前会话、且是空白会话
      React.useEffect(() => {
        const job = pendingImport;
        if (!job) return;
        if (!sessionId || !blank) return;
        pendingImport = null;
        void runImport(sessionId, job);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [pendingTick, sessionId, blank]);

      // 开场指令：等编辑器真的同步了草稿再提交（setDraft 是离散更新，通常当帧就到位）
      React.useEffect(() => {
        const want = pendingSend.current;
        if (!want || draftText !== want) return undefined;
        pendingSend.current = null;
        const timer = setTimeout(() => {
          try { propsRef.current?.inputActions?.submit?.(); } catch { /* 忽略 */ }
        }, 80);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [draftText]);

      /** 卡库根默认跟着会话工作区 —— 拿不到 cwd 时回宿主问一次（宿主的 sessionCwd 一定有）。 */
      async function ensureCwd() {
        const local = live.current.cwd || propsRef.current?._cwd || '';
        if (local) return local;
        try {
          const res = await API.session(live.current.sessionId);
          const cwd = typeof res?.cwd === 'string' ? res.cwd : '';
          if (cwd) live.current = { ...live.current, cwd };
          return cwd;
        } catch { return ''; }
      }

      async function load(query, cat = category) {
        setLoading(true);
        try {
          // 卡库默认在会话工作区下的 rp-cards/ → 把 cwd 一起报上去
      const res = await API.cards({ q: query, category: cat, limit: 60, workspace: await ensureCwd() });
          if (!res?.ok) throw new Error(res?.error ?? '读取卡库失败');
          setLib({ root: res.root, exists: res.exists, indexSource: res.indexSource, librarySize: res.librarySize, categories: res.categories ?? [] });
          setItems(res.items ?? []);
          setTotal(res.total ?? 0);
        } catch (error) {
          setMsg({ kind: 'err', text: String(error?.message ?? error) });
        } finally { setLoading(false); }
      }

      function onSearch(value) {
        setQ(value);
        if (searchTimer.current) clearTimeout(searchTimer.current);
        searchTimer.current = setTimeout(() => { void load(value); }, 260);
      }

      function pickCategory(value) {
        setCategory(value);
        void load(q, value);
      }

      async function pick(cardPath) {
        setSel(cardPath);
        setPreview(null);
        setResult(null);
        setBusy('preview');
        try {
          const res = await API.card(cardPath, await ensureCwd());
          if (!res?.ok) throw new Error(res?.error ?? '解析失败');
          setPreview(res);
          applyDiscoveredMacros(res.macros);
          try { const st = await API.state(); setGlobalUserLabel(String(st?.config?.cards?.userLabel ?? '')); } catch { /* 拿不到就用默认 */ }
        } catch (error) {
          setMsg({ kind: 'err', text: String(error?.message ?? error) });
        } finally { setBusy(''); }
      }

      /** 把当前会话的预设切成 dm。切不动时返回说明而不是抛错 —— 导入本身仍然该继续。 */
      async function selectDmPreset(targetId) {
        // 已经是 dm 就别再切：切换会重新组装一遍 agent 作用域并追加一条事件，没必要
        if (live.current.agentPreset === 'dm') return { ok: true, preset: 'dm', note: '本来就在 dm 预设' };
        let remote;
        try { remote = ctxRef.current?.get?.('remote'); } catch { remote = undefined; }
        const api = remote?.agentPresets;
        if (!api || typeof api.select !== 'function') {
          return { ok: false, note: '这一版 DSH 没暴露 remote.agentPresets，预设需要你手动确认（右侧「Agent 预设」页签）' };
        }
        try {
          const res = await api.select(targetId, 'dm');
          if (res?.ok) return { ok: true, preset: res.value };
          const reason = res?.error?.details?.reason ?? res?.error?.message ?? '未知原因';
          return { ok: false, note: `预设未切成 dm：${reason}` };
        } catch (error) {
          return { ok: false, note: `预设未切成 dm：${error?.message ?? error}` };
        }
      }

      function sendOpening(text) {
        const actions = propsRef.current?.inputActions;
        if (!actions || typeof actions.setDraft !== 'function') {
          setMsg({ kind: 'ok', text: '导入完成。开场指令没地方放（拿不到输入框），直接对 DM 说一句「开始吧」即可。' });
          return;
        }
        pendingSend.current = text;
        try { actions.setDraft(text); } catch { /* 忽略 */ }
        // 兜底：草稿同步事件没等到就自己提交，免得用户对着填好的输入框发呆
        setTimeout(() => {
          if (!pendingSend.current) return;
          pendingSend.current = null;
          try { actions.submit?.(); } catch { /* 忽略 */ }
        }, 1200);
      }

      async function runImport(targetId, opts) {
        setBusy('import');
        try {
          const preset = await selectDmPreset(targetId);
          const res = await API.cardImport({
            sessionId: targetId,
            workspace: (await ensureCwd()) || undefined,
            path: opts.path,
            greetingIndex: opts.greetingIndex ?? greetingIndex,
            // 宏表：导入表单里填的值，按会话保存（默认值已在界面里预填全局玩家称呼）
            macros: Object.fromEntries(macroRows.filter((r) => r.name && String(r.value).trim()).map((r) => [r.name, r.value])),
          });
          if (!res?.ok) throw new Error(res?.error ?? '导入失败');
          setResult({ ...res, preset });
          const bits = [
            `已导入《${res.name}》`,
            `世界书 +${res.lore.added} 条${res.lore.skipped ? `（跳过重名 ${res.lore.skipped} 条）` : ''}`,
            `全文 ${res.files.markdown}`,
            res.files.opening ? `开场白引导 ${res.files.opening}` : '',
            preset.ok ? '预设已切到 dm' : (preset.note ?? '预设未切换'),
          ].filter(Boolean);
          setMsg({ kind: preset.ok ? 'ok' : 'warn', text: bits.join(' · ') });
          if (opts.autoStart && res.opening) sendOpening(res.opening);
          // 导入成功就把面板收起来：这一刻开团已经开始（开场指令发出去了），
          // 面板继续占着屏幕中间只会挡着正文 —— 入口本身也会随会话「不再是新会话」而消失。
          setOpen(false);
        } catch (error) {
          setMsg({ kind: 'err', text: String(error?.message ?? error) });
        } finally { setBusy(''); }
      }

      async function startImport() {
        if (!sel) return;
        setMsg(null);
        setResult(null);
        const target = live.current.sessionId;
        if (target && live.current.blank) { await runImport(target, { path: sel, autoStart, greetingIndex }); return; }
        // 已经开过局的会话改不了预设（宿主 agent-preset/locked）→ 新建一个空白会话再来
        let ws;
        try { ws = ctxRef.current?.get?.('uiWorkspace'); } catch { ws = undefined; }
        if (!ws || typeof ws.startSession !== 'function') {
          setMsg({ kind: 'err', text: '当前会话已经开始（预设已固定），且拿不到「新建会话」接口 —— 请手动新建一个会话再导入。' });
          return;
        }
        pendingImport = { path: sel, autoStart, greetingIndex };
        setPendingTick((t) => t + 1);
        setMsg({ kind: 'ok', text: '当前会话已经开始（预设固定），正在新建一个会话用于开团…' });
        try { ws.startSession(); } catch (error) {
          pendingImport = null;
          setPendingTick((t) => t + 1);
          setMsg({ kind: 'err', text: String(error?.message ?? error) });
        }
      }

      // 入口只在「还没开局的 DM 新会话」上出现 —— 那正是要选卡开团的时刻。
      // 导入进行中/刚导完时例外：开场指令一发出去会话就不再是空白，
      // 这时把面板藏掉会让用户看不到结果（`keep` 一直维持到用户自己收起）。
      const isDmNow = agentPreset === 'dm';
      const keepOpen = open && (busy === 'import' || result !== null);
      if (!sessionId) return null;
      if (!(blank && isDmNow) && !keepOpen) return null;

      // 入口要待在「工作区 / DM 主持人」那一行上，而不是自己占一行。
      // 那一行的两个座位（`conversation.hero.workspace` / `conversation.hero.agentPreset`）
      // 都是 **single 且已被官方插件占满**，没有第三个槽位可注册 ——
      // 所以只能在 DOM 上想办法：**优先**用 portal 把 chip 送进那一行（它是 flex 行，
      // 送进去就是正经的第三个 chip）；拿不到 react-dom（或找不到那一行）时退回
      // 「量出那一行的位置、把 chip 固定在它右边」，最差也只是自己占一行，不会消失。
      const rootRef = React.useRef(null);
      const [slot, setSlot] = React.useState(undefined);   // undefined=还没量 / null=找不到 / {kind,row|rect}
      React.useLayoutEffect(() => {
        if (slot !== undefined) return;
        setSlot(findHeroRowSlot(rootRef.current));
      }, [slot, sessionId]);

      const isRow = slot?.kind === 'portal';
      const chip = h('button', {
        key: 'chip', type: 'button',
        // 样式类不带 .rpc 前缀：这枚 chip 会被 portal 到那一行里，那时它不在 .rpc 内部
        className: 'rpc-chip',
        'data-open': open ? 'true' : 'false',
        'data-row': slot ? 'true' : 'false',
        'aria-expanded': open,
        style: slot?.kind === 'fixed' ? slot.style : undefined,
        onClick: () => setOpen((v) => !v),
        title: '从本地 PNG 角色卡库导入一本故事书：世界书写进工作区，自动开场（只在未开局的 DM 新会话上出现）',
      }, [
        h('span', { key: 'g' }, '📖'),
        h('span', { key: 't' }, open ? '收起' : '导入故事书'),
        h('span', { key: 'c', className: 'chev' }, open ? '▴' : '▾'),
      ]);

      // 定位用的空节点：chip 被送走之后，根元素里还得留个锚
      const holder = h('span', { key: 'holder', className: 'rpc-holder', 'aria-hidden': 'true' });
      const entry = slot === undefined
        ? null                                     // 首帧先不画，等 useLayoutEffect 量完（它在绘制前跑，不会闪）
        : (slot?.kind === 'portal' ? ReactDOM.createPortal(chip, slot.row) : chip);

      if (!open) {
        return h('div', { className: 'rpc', ref: rootRef }, [holder, entry]);
      }

      const previewCard = preview ? h('div', { key: 'prev', className: 'prev' }, [
        h('div', { key: 'h', className: 'row' }, [
          h('strong', { key: 'n' }, preview.name),
          h('span', { key: 'k', className: 'badge' }, preview.kind),
          preview.creator ? h('span', { key: 'c', className: 'dim' }, `by ${preview.creator}`) : null,
        ]),
        h('div', { key: 's', className: 'dim' },
          `世界书 ${preview.stats?.entries ?? 0} 条 / ${preview.stats?.totalChars ?? 0} 字`
          + `${preview.stats?.skipped ? `（另有 ${preview.stats.skipped} 条超预算，只写进全文文件）` : ''}`
          + `｜开场白来源：${preview.character?.greetingSource === 'alternate_greetings'
            ? `备用开场白（共 ${preview.character?.greetingAlternatives} 条）`
            : preview.character?.greetingSource === 'first_mes' ? 'first_mes' : '无'}`),
        // 卡里常见的 {{user}} / {{char}} / <USER>：导入时就会展开成玩家称呼与卡名，
        // 这里先摊给用户看（免得「导入后我卡里的 {{user}} 怎么没了」）
        preview.placeholders?.total
          ? h('div', { key: 'ph', className: 'dim' },
            `占位符：${Object.entries(preview.placeholders.counts ?? {}).map(([k, n]) => `${k}×${n}`).join('、')} → 导入时展开为玩家称呼与卡名`)
          : null,
        // 英文属性键（name:/gender: Female）会在导入时中文化
        preview.attributes?.count
          ? h('div', { key: 'attr', className: 'dim' },
            `属性标签：${preview.attributes.count} 行将中文化（name→名称、gender: Female→性别：女 …）`)
          : null,
        // 开场白可以挑（卡常带好几条），选中的那条会内联进「开局」指令、
        // 全部开场白另存一份引导文件，DM 长开白时自己去 read（不截断）
        (preview.greetings ?? []).length
          ? h('div', { key: 'greet', className: 'greet' }, [
            h('div', { key: 'l', className: 'dim' }, `开场白（${preview.greetings.length} 条可选，会写进 rp-cards/*.opening.md 引导文件）`),
            h('select', {
              key: 's', value: String(greetingIndex),
              onChange: (e) => setGreetingIndex(Number(e.target.value)),
            }, preview.greetings.map((g) => h('option', { key: g.index, value: String(g.index) },
              `#${g.index + 1}${g.source === 'first_mes' ? '（first_mes）' : ''} · ${g.chars} 字 · ${String(g.preview ?? '').slice(0, 40)}…`))),
          ])
          : null,
        preview.world ? h('div', { key: 'w', className: 'prevbox' }, preview.world) : null,
        preview.character?.personality ? h('div', { key: 'p', className: 'prevbox' }, preview.character.personality) : null,
        // ── 宏（第一次导入时让用户填；默认取全局玩家称呼，可改，也可加自定义 {{x}}）──
        // 这些值**按会话保存**，世界书/设定里写的 `{{x}}` 由宿主变量在注入时替换，
        // 所以以后在 RP 面板里改值，已导入的文本会跟着变。
        h('div', { key: 'macros', className: 'macroblk' }, [
          h('div', { key: 't', className: 'dim' },
            '宏（按会话保存）：卡里用到的 {{…}} 留在这里填，也可以自己加一行。'
            + `默认 {{user}} = ${globalUserLabel || '玩家'}（设置页的「玩家称呼」）。`),
          ...macroRows.map((row, i) => h('div', { key: `m${i}`, className: 'row macrorow' }, [
            h('span', { key: 'n', className: 'mono' }, `{{${row.name}}}`),
            // 自动宏（time/date/…）：后台每轮自己算，用户不用填；留空即可，想钉死游戏内时间也可以填
            row.auto ? h('span', { key: 'a', className: 'badge ok', title: '自动：装配时按当前时间/日期填写，留空即可' }, '自动') : null,
            h('input', {
              key: 'v', type: 'text', value: row.value,
              placeholder: row.auto ? '留空 = 自动（当前时间/日期）' : (row.name === 'user' ? '玩家称呼' : '这一项的值'),
              onChange: (e) => setMacroRow(i, e.target.value),
            }),
            h('button', { key: 'd', className: 'tiny', onClick: () => removeMacroRow(i) }, '×'),
          ])),
          h('div', { key: 'add', className: 'row' }, [
            h('input', {
              key: 'nn', type: 'text', value: newMacroName, placeholder: '自定义宏名（小写字母/数字/下划线）',
              onChange: (e) => setNewMacroName(e.target.value),
            }),
            h('button', { key: 'ab', className: 'tiny', onClick: addMacroRow }, '＋ 添加宏'),
          ]),
        ]),
        h('label', { key: 'auto', className: 'cb' }, [
          h('input', { key: 'c', type: 'checkbox', checked: autoStart, onChange: (e) => setAutoStart(e.target.checked) }),
          '导入后自动开场（把开场指令发给 DM）',
        ]),
        h('div', { key: 'act', className: 'row' }, [
          h('button', { key: 'go', className: 'primary', disabled: Boolean(busy) || Boolean(pendingImport), onClick: startImport },
            busy === 'import' ? '导入中…' : (pendingImport ? '等待新会话…' : (blank ? '导入并开始' : '新建会话并导入'))),
          !blank && agentPreset !== 'dm'
            ? h('span', { key: 'w', className: 'dim' }, `当前会话预设是 ${agentPreset || '未知'}，导入会新建一个会话`)
            : null,
        ]),
        (preview.warnings ?? []).length
          ? h('div', { key: 'warn', className: 'dim' }, `解析告警：${preview.warnings.join('；')}`)
          : null,
      ]) : h('div', { key: 'noprev', className: 'dim' }, busy === 'preview' ? '解析中…' : '← 先选一张卡');

      const resultCard = result ? h('div', { key: 'res', className: 'prev' }, [
        h('div', { key: 'h', className: 'row' }, [h('strong', { key: 't' }, '导入完成'), h('span', { key: 'b', className: 'badge' }, result.name)]),
        h('div', { key: 'f', className: 'mono dim' },
          `世界书 ${result.files?.world}（+${result.lore?.added ?? 0} 条）｜全文 ${result.files?.markdown}`
          + (result.files?.opening ? `｜开场白引导 ${result.files.opening}` : '')
          + `｜卡面 ${result.files?.image ?? '—'}`),
        result.placeholders?.total
          ? h('div', { key: 'ph', className: 'dim' },
            `已展开占位符 ${result.placeholders.total} 处：${Object.entries(result.placeholders.counts ?? {}).map(([k, n]) => `${k}×${n}`).join('、')}`)
          : null,
        result.attributes?.count
          ? h('div', { key: 'at', className: 'dim' }, `已把 ${result.attributes.count} 行属性标签中文化（名称 / 性别 / 年龄 …）`)
          : null,
        result.previousWorldChars
          ? h('div', { key: 'w', className: 'dim' }, `注意：本会话原有的世界设定（${result.previousWorldChars} 字）已被这次的卡组设定覆盖；世界书文件是追加合并的，没动你手写的条目。`)
          : null,
      ]) : null;

      return h('div', { className: 'rpc', ref: rootRef }, [
        holder,
        entry,
        h('div', { key: 'panel', className: 'panel' }, [
          h('div', { key: 'bar', className: 'row' }, [
            h('input', {
              key: 'q', type: 'search', value: q, placeholder: '搜卡名 / 作者 / 标签（回车或停顿即搜）',
              style: { flex: '1 1 200px' },
              onChange: (e) => onSearch(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') { if (searchTimer.current) clearTimeout(searchTimer.current); void load(q); } },
            }),
            h('select', {
              key: 'cat', value: category, style: { flex: '0 1 150px' }, onChange: (e) => pickCategory(e.target.value),
            }, [
              h('option', { key: '', value: '' }, `全部分类（${lib?.librarySize ?? '…'}）`),
              ...(lib?.categories ?? []).map((c) => h('option', { key: c.name, value: c.name }, `${c.name}（${c.count}）`)),
            ]),
            h('button', { key: 'r', onClick: () => void load(q) }, loading ? '…' : '刷新'),
          ]),
          h('div', { key: 'meta', className: 'dim' },
            lib && lib.exists === false
              ? `卡库目录不存在：${lib.root} —— 到「设置 → RP工具 → 卡库目录」改成正确路径`
              : `卡库 ${lib?.root ?? ''}`
                + (lib?.rootSource === 'workspace' ? '（默认：会话工作区下的 rp-cards）' : '')
                + (lib?.rootSource === 'none' ? '（拿不到会话工作区 —— 去设置页填一个卡库目录）' : '')
                + (lib?.indexSource === 'scan' ? '（目录扫描：卡名取文件名）' : '')
                + `｜命中 ${total} 张`),
          h('div', { key: 'split', className: 'split' }, [
            h('div', { key: 'list', className: 'list' }, items.length
              ? items.map((it, i) => h('div', {
                key: itemKey(it, i), className: 'item', 'data-sel': it.path === sel ? 'true' : 'false',
                onClick: () => void pick(it.path),
              }, [
                h('div', { key: 'n', className: 'nm' }, `${it.name}${it.kind ? ` · ${it.kind}` : ''}`),
                h('div', { key: 'm', className: 'mt' },
                  [it.category, it.creator, it.bookEntries ? `世界书 ${it.bookEntries} 条` : '', ...(it.tags ?? []).slice(0, 4)]
                    .filter(Boolean).join(' · ')),
              ]))
              : h('div', { key: 'empty', className: 'dim', style: { padding: '10px' } }, loading ? '读取中…' : '没有匹配的卡')),
            h('div', { key: 'right', style: { display: 'flex', flexDirection: 'column', gap: 8 } }, [previewCard, resultCard]),
          ]),
          msg ? h('div', { key: 'msg', className: `msg ${msg.kind === 'err' ? 'err' : msg.kind === 'warn' ? '' : 'ok'}` }, msg.text) : null,
        ]),
      ]);
    }

    const name = 'dsh-rp-tools';
    // inject 只放硬依赖：slots 是唯一的。右栏那两个服务走延迟注入（见 apply），
    // 这样即便本机 DSH 没提供右栏，插件也不会卡在等待里 —— 只是少一个面板入口。
    const inject = ['slots'];

    /** 右栏页签类型的 id 与 kind（两者都用插件名，避免与别的插件撞车）。 */
    const RP_TAB_ID = 'dsh-rp-tools';
    const RP_TAB_KIND = 'dsh-rp-tools';

    /**
     * 打开 RP 右栏页签。导航只能在**注入了 sidebarRight 的那个 ctx** 上做，
     * 所以由 apply 在延迟注入回调里把这个函数挂到共享命名空间上。
     */
    let openRpTab = null;
    /**
     * 客户端根 ctx 的引用。给需要延迟注入的组件用（React 的 useEffect 是异步跑的，
     * 不能靠给 thenable 赋值的土办法拿 ctx）。只在 apply 里赋值一次。
     */
    const ctxRef = { current: null };

    function registerSidebarTab(injected) {
      const tabs = injected.sidebarRightTabs;
      if (!tabs || typeof tabs.register !== 'function') return;
      const service = injected.sidebarRight;
      if (service && typeof service.openTab === 'function') {
        openRpTab = () => {
          try {
            service.openTab(RP_TAB_KIND);
          } catch (error) {
            // 没有挂载的右栏座位（极窄视口等）→ 至少试着把右栏打开
            console.warn('[rp-tools] 打开 RP 右栏页签失败，退回直接展开右栏:', error?.message ?? error);
            try { service.toggleExpanded(); } catch { /* 放弃 */ }
          }
        };
      }
      try {
        tabs.register({
          id: RP_TAB_ID,
          kind: RP_TAB_KIND,
          title: () => '🎲 RP',
          guide: [{
            order: 30,
            title: () => '🎲 RP 跑团面板',
            description: () => '世界设定 / 角色卡 / 随机表 / 本会话生图配置',
          }],
        });
      } catch (error) {
        console.warn('[rp-tools] 注册右栏页签类型失败:', error?.message ?? error);
        return;
      }
      injected.slots.inject('sidebar.right.pane.tab', () => injected.slots.register({
        name: 'sidebar.right.pane.tab',
        key: RP_TAB_ID,
      }, (props) => h(RpSidebarTabBody, props)));
      injected.slots.inject('sidebar.right.pane.tab.title', () => injected.slots.register({
        name: 'sidebar.right.pane.tab.title',
        key: RP_TAB_ID,
      }, () => h(RpTabTitle)));
    }

    function apply(ctx) {
      ctxRef.current = ctx;
      // 样式必须在**第一个组件渲染之前**就挂上。
      // 之前只在设置页 / 会话面板的 effect 里调用，于是首次加载时头部那个「🎲 RP」
      // 按钮先以裸 <button> 的默认外观出现（灰底方角），等某个组件挂载后才变正常 ——
      // 就是「第一次启动样式不对、后面正常」的典型 FOUC。
      injectStyles();
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'rp-tools',
        order: 31,
        label: () => 'RP工具',
      }, (props) => h(RpSettings, props)));

      // 会话头部右上角入口（utilities = 右对齐，与 ComfyUI 面板等入口并排）。
      // 组件自身在非 DM 会话返回 null → 其它会话不出现任何 RP 界面。
      ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: 'rp-tools',
        order: 40,
        label: () => 'RP',
      }, (props) => h(RpHeaderButton, props)));

      // 工作区/输入框上方那一行的「📖 导入 PNG 故事书」入口。
      // 用 input.dock（整宽条目）而不是输入框工具行：导入面板要放列表 + 预览，两列需要横向空间。
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'rp-card-import',
        order: 15,
        label: () => 'PNG 故事书',
      }, (props) => h(RpCardImport, props)));

      // 把 RP 面板注册成右侧栏的一种页签：入口按钮调 openTab 打开它，
      // 右栏自带的收起 / 浮动 / 关闭都由 DSH 负责，插件不再自己画浮层。
      ctx.inject(['sidebarRightTabs', 'sidebarRight'], registerSidebarTab);
    }

    module.exports.name = name;
    module.exports.inject = inject;
    module.exports.apply = apply;
    return module.exports;
  },
});
