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

    /**
     * 拼查询串：丢掉空值。
     *
     * ⚠️ 这里踩过一次：`API.card` 原先写成 `card: (path) => ...`，把调用点传进来的
     * 工作区**悄悄吞掉了** —— 请求里既没有 sessionId 也没有 workspace，宿主无从判断
     * 「哪个会话的卡库」，于是根目录落空、退化成 `resolve('')` = 进程 cwd 的 ENOENT。
     * 所有会读盘的卡路由都必须带上 `sessionId`（有 cwd 再带上 workspace 兜底）。
     */
    const qs = (params) => {
      const sp = new URLSearchParams();
      for (const [k, v] of Object.entries(params ?? {})) {
        if (v === undefined || v === null || v === '') continue;
        sp.set(k, String(v));
      }
      return sp.toString();
    };

    /**
     * 生成图的媒体 URL（同源相对路径即可，img/link 会按页面 origin 解析）。
     *
     * 为什么存三要素而不是 URL：`/rp-tools/media` 是 ComfyUI `/view` 的代理，
     * 只要 (file, subfolder, type) 还在就永远能取回同一张图 —— 而 URL 里带的 origin
     * 换个访问方式（局域网 IP / 改端口）就失效，所以会话配置里只记三要素。
     */
    const mediaUrlOf = (ref) => (ref && ref.file
      ? `/rp-tools/media?${qs({ file: ref.file, subfolder: ref.subfolder, type: ref.type })}`
      : '');

    /**
     * 会话配置里的 portraits → 面板用的立绘表（生成立绘优先，其次外部导入的，卡面另存）。
     * `sid` 用来拼导入立绘的地址（那条路由要 sessionId 才知道去哪个会话目录取文件）。
     */
    const portraitsFromSession = (raw, sid = '') => {
      const out = {};
      for (const [name, entry] of Object.entries(raw ?? {})) {
        const ref = entry?.generated;
        if (ref && ref.file) {
          out[name] = {
            url: mediaUrlOf(ref),
            style: String(entry?.style ?? ''),
            elapsedMs: Number(entry?.elapsedMs) || 0,
            persisted: true,
          };
          continue;
        }
        // 用户外部导入的立绘：文件在会话目录里，走 /rp-tools/portrait-image。
        // `v` 用导入时间：同名重导时文件名不变，浏览器会命中缓存，带上才能换图即换。
        if (entry?.imported?.file) {
          out[name] = {
            url: `/rp-tools/portrait-image?${qs({ sessionId: sid, name, v: String(entry.imported.at ?? '') })}`,
            style: '导入',
            elapsedMs: 0,
            persisted: true,
          };
        }
      }
      return out;
    };

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
      cards: (params) => jget(`/rp-tools/cards?${qs(params)}`),
      card: (path, params) => jget(`/rp-tools/card?${qs({ path, ...(params ?? {}) })}`),
      cardImport: (body) => jpost('/rp-tools/card-import', body),
      // 立绘：把生成结果的 (file, subfolder, type) 记进会话配置，下次打开面板还在
      portraitSave: (body) => jpost('/rp-tools/portrait', body),
      // 外部立绘：用户在编辑器里选一张本地图，转成 data URL 传给宿主落盘（宿主只收 png/jpeg/webp）
      portraitUpload: (body) => jpost('/rp-tools/portrait-upload', body),
      // 资源库：列出（可按分类/角色/标签/关键词过滤）/ 改标签 / 删除 / 提取成某角色的立绘
      assets: (params) => jget(`/rp-tools/assets?${qs(params)}`),
      assetSave: (body) => jpost('/rp-tools/assets', body),
      // 通用导入：kind=portrait 且带 name 时同步登记成那个角色的立绘
      assetUpload: (body) => jpost('/rp-tools/asset-upload', body),
      // 会话包：导出是**下载**（走 <a download>，不用 fetch，也不经过 JSON），快照与导入是 POST
      snapshots: (params) => jget(`/rp-tools/snapshots?${qs(params)}`),
      snapshot: (body) => jpost('/rp-tools/snapshot', body),
      importBundle: (body) => jpost('/rp-tools/import', body),
      // 会话闸门：宿主回答「现在是不是 dm」「有没有真的开局」。
      // 为什么不能只信客户端投影：切预设会重建投影基线、把基线里没有的键**清掉**，
      // 于是 `projectionValues.agentPreset` 变空 → 判定「不是 DM」→ 入口永久消失。
      gate: (sessionId) => jget(`/rp-tools/gate?${qs({ sessionId })}`),
      lore: (sessionId) => jget(`/rp-tools/lore?sessionId=${encodeURIComponent(sessionId)}`),
      loreEntry: (sessionId, title) => jget(`/rp-tools/lore?sessionId=${encodeURIComponent(sessionId)}&title=${encodeURIComponent(title)}`),
      loreSave: (body) => jpost('/rp-tools/lore', body),
      // 设定整备指令正文（宿主给措辞，界面只负责填进输入框）
      tidy: (body) => jpost('/rp-tools/tidy', body),
    };

    /** 宏名规则：与宿主变量名一致（[a-z][a-z0-9_]*）。 */
    const MACRO_RE = /^[a-z][a-z0-9_]{0,31}$/;

    /**
     * 卡面图 URL。卡库默认在**会话工作区**下的 rp-cards/，所以要把 sessionId + cwd 一起带上，
     * 宿主才能把相对路径解析到同一个根（只给 sessionId 也行：宿主会自己查会话的工作区）。
     */
    const cardImageUrl = (rel, workspace, sessionId, extra) => `/rp-tools/card-image?${qs({ path: rel, workspace, sessionId, ...(extra ?? {}) })}`;

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
/* ── 设置页控件统一规格 ────────────────────────────────────────────────
   跟随宿主的语义 token（与官方设置页同一套：输入框 bg-layer-1 + border-l4 + 10px 圆角，
   聚焦用 brand-primary 细环）。以前用的是 currentColor 半透明描边，聚焦时浏览器会给
   一圈又粗又亮的默认 outline —— 用户说的「选中效果不好看」就是它。 */
.rpt input[type=text], .rpt input[type=number], .rpt input[type=search], .rpt textarea, .rpt select {
  width: 100%; box-sizing: border-box; padding: 6px 9px; border-radius: 8px; font: inherit; font-size: 13px;
  border: .5px solid var(--dsw-alias-border-l4, color-mix(in oklab, currentColor 20%, transparent));
  background: var(--dsw-alias-bg-layer-1, color-mix(in oklab, currentColor 4%, transparent));
  color: var(--dsw-alias-label-primary, inherit);
}
.rpt input::placeholder, .rpt textarea::placeholder { color: var(--dsw-alias-label-dimmed, color-mix(in oklab, currentColor 45%, transparent)); }
.rpt input:focus, .rpt textarea:focus, .rpt select:focus {
  outline: 2px solid var(--dsw-alias-brand-primary, #4D6BFE); outline-offset: -1px;
  border-color: transparent;
}
/* 原生下拉的弹出列表由浏览器绘制，不继承我们的半透明背景 —— 不显式给色就会是
   白底 + 浅色文字 → 看不清。用 DSH 主题 token（浅色主题下这两个值本身就是浅色）。 */
.rpt select option, .rpt select optgroup {
  background-color: var(--dsw-alias-bg-layer-2, #26272b);
  color: var(--dsw-alias-label-primary, #e8e8ea);
}
.rpt select option:checked { background-color: var(--dsw-alias-bg-overlay, #303136); }
.rpt textarea { min-height: 62px; resize: vertical; }
/* label.filebtn 是「导入图片」那个包裹隐藏 input 的 label：外观要跟旁边的小按钮一模一样 */
.rpt button, .rpt label.filebtn {
  padding: 5px 11px; border-radius: 8px; cursor: pointer; font: inherit; font-size: 12.5px;
  white-space: nowrap; color: var(--dsw-alias-label-primary, inherit);
  border: .5px solid var(--dsw-alias-border-l4, color-mix(in oklab, currentColor 22%, transparent));
  background: transparent;
}
.rpt button:hover:not(:disabled), .rpt label.filebtn:hover { background: var(--dsw-alias-interactive-bg-hover, color-mix(in oklab, currentColor 12%, transparent)); }
.rpt button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4D6BFE); outline-offset: -1px; }
.rpt button:disabled { opacity: .45; cursor: default; }
/* 主按钮 = 宿主的「高对比」按钮：底色 button-primary-fill，文字 label-primary-foreground。
   ⚠️ 这里踩过一次：--dsw-alias-brand-primary 并不是「蓝色品牌色」，它是**高对比前景色** ——
   深色主题下是近白（#f9fafb），配上写死的 color:#fff 就成了白底白字，保存按钮直接看不见。
   浅色主题下它是近黑。所以文字必须跟着 label-primary-foreground 走。 */
.rpt button.primary {
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #4D6BFE));
  color: var(--dsw-alias-label-primary-foreground, #fff);
  border-color: transparent; font-weight: 500;
}
.rpt button.primary:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary, #4D6BFE));
}
.rpt button.tiny, .rpt label.filebtn { padding: 2px 8px; font-size: 12px; }
/* 行尾的删除按钮：小圆点式幽灵按钮，别用带边框的小方块（截图里那个 × 就是它） */
.rpt button.iconbtn {
  width: 22px; height: 22px; padding: 0; border-radius: 6px; border-color: transparent;
  display: inline-flex; align-items: center; justify-content: center; line-height: 1;
  color: var(--dsw-alias-label-tertiary, color-mix(in oklab, currentColor 55%, transparent));
}
.rpt button.iconbtn:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger, color-mix(in oklab, #ef4444 18%, transparent));
  color: var(--dsw-alias-state-error-primary, #ef4444);
}
/* 「＋ 添加」类按钮：整条虚线，和上面的行拉开距离（原来贴着最后一行，看着像被挤住） */
.rpt button.addbtn {
  margin-top: 6px; width: 100%; border-style: dashed; color: var(--dsw-alias-label-secondary, inherit);
  font-size: 12px; padding: 5px 8px;
}
.rpt .card { border: .5px solid var(--dsw-alias-border-l4, color-mix(in oklab, currentColor 13%, transparent));
  border-radius: 12px; padding: 14px; display: flex; flex-direction: column; gap: 10px;
  background: var(--dsw-alias-bg-layer-1, transparent); }
.rpt .badge { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; }
.rpt .badge.ok { background: color-mix(in oklab, #22c55e 24%, transparent); }
.rpt .badge.warn { background: color-mix(in oklab, #f59e0b 26%, transparent); }
/* 世界书条目类别标签：设定/规则 是正常内容，状态/历史 更像运行期快照（着色提醒） */
.rpt .badge.kind { background: color-mix(in oklab, currentColor 12%, transparent); opacity: .9; font-weight: 400; }
.rpt .badge.kind-状态, .rpt .badge.kind-历史 { background: color-mix(in oklab, #38bdf8 24%, transparent); }
.rpt .loreempty { padding: 6px 0; }
.rpt .loreempty .loretitle { text-decoration: line-through; opacity: .6; }
.rpt .msg { padding: 6px 9px; border-radius: 6px; background: color-mix(in oklab, currentColor 8%, transparent); }
.rpt img.pv { max-width: 100%; border-radius: 8px; }
.rpt .stylecard { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 8px; align-items: start;
  border: 1px solid color-mix(in oklab, currentColor 11%, transparent); border-radius: 8px; padding: 10px; }
/* ── 设置页三大类（设定 / 图像 / 工具）────────────────────────────────────
   小节标题带一条细分隔线，比一堆卡片堆叠好扫；提示文字一律 dim + 12px，别抢正文。 */
.rpt .rpsec { gap: 14px; }
.rpt .sechead { align-items: baseline; gap: 10px; padding-bottom: 8px;
  border-bottom: .5px solid var(--dsw-alias-border-l2, color-mix(in oklab, currentColor 10%, transparent)); }
.rpt .sechead h4 { margin: 0; font-size: 14.5px; font-weight: 600; letter-spacing: -.01em; }
.rpt .rpsec .dim { font-size: 12px; line-height: 1.6; }
.rpt .kv { grid-template-columns: 92px minmax(0, 1fr); gap: 10px 12px; }
/* 默认宏列表：名字 + 值 + 行尾删除按钮；名称列定宽，几行之间对齐 */
.rpt .rpsec .macroblk { width: 100%; }
.rpt .rpsec .macrorow { grid-template-columns: 118px minmax(0, 1fr) 22px; gap: 8px; }
.rpt .rpsec .macrorow input[type=text] { height: 30px; padding: 0 8px; font-size: 12.5px; }
/* 风格库：一行一个风格，用 flex-wrap 保证窄面板下自动换行而不是挤压输入框 */
.rpt .stylegrid { display: flex; flex-direction: column; gap: 6px; }
.rpt .stylerow { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center;
  border: .5px solid var(--dsw-alias-border-l2, color-mix(in oklab, currentColor 10%, transparent));
  border-radius: 10px; padding: 7px 10px; transition: background .14s ease; }
.rpt .stylerow:hover { background: var(--dsw-alias-interactive-bg-hover, color-mix(in oklab, currentColor 6%, transparent)); }
.rpt .stylerow .styname { display: flex; flex-direction: column; min-width: 120px; font-size: 13px; font-weight: 600; }
.rpt .stylerow .styname .mono { font-size: 10.5px; font-weight: 400; }
.rpt .stylerow .styfield { display: flex; gap: 5px; align-items: center; font-size: 11.5px;
  color: var(--dsw-alias-label-secondary, inherit); }
.rpt .stylerow .styfield input[type=number] { width: 58px; height: 28px; padding: 0 6px; font-size: 12px; }
.rpt .stylerow .stylora select { max-width: 190px; height: 30px; padding: 0 8px; font-size: 12px; }
.rpt .stylerow .stytrigger { flex: 1 1 150px; min-width: 120px; height: 30px; font-size: 12px; }
.rpt .stylerow .styact { gap: 4px; }
/* 图像尺寸：三行「用途 宽 × 高 px」，数字框定宽，行与行对齐 */
.rpt .szblock { display: flex; flex-direction: column; gap: 6px; }
.rpt .szrow { display: flex; gap: 6px; align-items: center; }
.rpt .szrow .szlabel { flex: 0 0 42px; font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); }
.rpt .szrow input[type=number] { width: 80px; height: 28px; padding: 0 8px; }
.rpt .szrow .szx, .rpt .szrow .szu { flex: 0 0 auto; opacity: .55; font-size: 11.5px; }
.rpt .toollist { max-height: 260px; overflow: auto; display: flex; flex-direction: column; gap: 2px; }
.rpt .nums { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.rpt .nums label { display: flex; gap: 5px; align-items: center; font-size: 12px; opacity: .85; }
.rpt .nums input[type=number] { width: 64px; }
.rpt .param { display: grid; grid-template-columns: 168px 74px minmax(0,1fr); gap: 8px; font-size: 12px; padding: 1px 0; }
.rpt .param .t { opacity: .6; }
.rpt .req { color: #ef4444; }
.rpt .tool { padding: 9px 0; border-top: 1px solid color-mix(in oklab, currentColor 9%, transparent); }
.rpt .tool:first-child { border-top: none; }
.rpt .scroll { max-height: 320px; overflow: auto; }
/* 世界书与角色卡的默认态都是单行摘要；完整字段统一放到 body portal 大编辑器。 */
.rpt .lorelist { max-height: min(62vh, 640px); overflow: auto; }
.rpt .loreitem { padding: 6px 0; border-top: 1px solid color-mix(in oklab, currentColor 9%, transparent); }
.rpt .loreitem:first-child { border-top: none; }
.rpt .loreline { display: grid; grid-template-columns: minmax(110px, 1.2fr) minmax(90px, .8fr) auto auto auto; gap: 7px; align-items: center; }
.rpt .loretitle, .rpt .charsum-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rpt .loresummary, .rpt .charsum-brief { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rpt .loreconst { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.rpt .lorelegacy { display: flex; flex-direction: column; gap: 6px; padding: 8px; border-radius: 8px;
  background: color-mix(in oklab, #f59e0b 14%, transparent); }
.rpt .loreform, .rpt .chareditform, .rpt .dmeditform { display: flex; flex-direction: column; gap: 7px; }
.rpt .loreform label, .rpt .chareditform label, .rpt .dmeditform label { font-size: 12px; opacity: .78; }
.rpt .loreform textarea.lorebody { min-height: 430px; resize: vertical; font-size: 12.5px; line-height: 1.6; }
.rpt .dmeditform textarea { min-height: 380px; resize: vertical; font-size: 12.5px; line-height: 1.6; }
.rpt .chareditform textarea { resize: vertical; font-size: 12.5px; line-height: 1.6; }
.rpt .charlist { display: flex; flex-direction: column; }
/* 角色行（用户重新设计）：**一行 = 小头像 + 名称 + 简介 + 标记 + 操作**。
   早先是「有图就两列、图 150×200」，那一行会被撑成三倍高（截图里的「桐人」就是），
   而且带了「大图 / 收起」两个按钮 —— 「收起」会把立绘从会话配置里删掉，点完反而看不到了。
   现在头像固定 36px、列表里不提供删除立绘（挪到编辑浮窗里，那里摆着大图、删之前看得见）。 */
.rpt .charbox { display: flex; gap: 9px; align-items: center; padding: 7px 0;
  border-top: 1px solid color-mix(in oklab, currentColor 9%, transparent); }
.rpt .charbox:first-child { border-top: none; }
.rpt .charavatar { flex: none; width: 36px; height: 36px; border-radius: 9px; overflow: hidden;
  display: flex; align-items: center; justify-content: center;
  background: color-mix(in oklab, currentColor 8%, transparent);
  border: .5px solid var(--dsw-alias-border-l2, color-mix(in oklab, currentColor 12%, transparent)); }
.rpt .charbox[data-hasface='true'] .charavatar { border-color: color-mix(in oklab, currentColor 24%, transparent); }
.rpt .charavatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
.rpt .charavatar .charavatar-ph { font-size: 15px; opacity: .5; line-height: 1; }
.rpt .charbody { flex: 1 1 auto; min-width: 0; }
.rpt .charline { display: grid; grid-template-columns: minmax(88px, .72fr) minmax(120px, 1.35fr) auto auto; gap: 7px; align-items: center; }
.rpt .charstatus { display: inline-flex; gap: 4px; align-items: center; white-space: nowrap; }
.rpt .chargrid { display: grid; grid-template-columns: 92px minmax(0,1fr); gap: 8px 10px; align-items: start; }
.rpt .chargrid .dim { padding-top: 5px; }
.rpt .chargrid textarea { min-height: 72px; }
.rpt .partylines { display: flex; gap: 8px; flex-wrap: wrap; align-items: baseline; padding: 3px 0; font-size: 12px; }
/* 大编辑器：立绘在**左列**、尽量铺满那一列；表单在右列。
   用户实测反馈「立绘要大，最好利用完左侧空间」—— 之前左列封顶 300px、图 280×400，
   下面空着大半列。现在左列按比例给到 46%，图同时受 max-width 与 max-height 约束
   （两个都卡才能既不撑破又不变形：宽高都 auto，只被上限裁）。 */
.rpt .chareditform { display: grid; grid-template-columns: minmax(280px, 46%) minmax(0, 1fr); gap: 18px; align-items: start; }
.rpt .chareditform .facepreview { position: sticky; top: 0; display: flex; flex-direction: column; gap: 8px; }
.rpt .chareditform .facepreview img { display: block; width: auto; height: auto; max-width: 100%;
  max-height: calc(88vh - 250px); margin: 0 auto; border-radius: 12px;
  border: .5px solid var(--dsw-alias-border-l2, color-mix(in oklab, currentColor 12%, transparent)); }
.rpt .chareditform .facepreview .facecap { font-size: 12px; line-height: 1.55; }
.rpt .chareditform .facepreview .facerow { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: center; }
/* 「导入图片」是个 label 包着隐藏 input：样式按按钮来，别让原生 file 控件露出来 */
.rpt .chareditform .facepreview .filebtn { display: inline-flex; align-items: center; cursor: pointer; }
.rpt .chareditform .facepreview .filebtn.disabled { opacity: .45; cursor: default; }
.rpt .chareditform .facepreview .filebtn input[type=file] { position: absolute; width: 1px; height: 1px;
  opacity: 0; pointer-events: none; }
.rpt .chareditform .charfields { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 8px 10px; align-items: start; }
.rpt .chareditform .charfields > label { padding-top: 6px; }
/* ── 资源库：筛选条 + 图墙 ─────────────────────────────────────────────────
   图墙用 auto-fill 的最小宽度而不是固定列数 —— 面板宽度会随侧栏变化，固定列数在窄面板下会挤压。
   缩略图统一走服务端降采样（previewUrl），**不能原图直出**：一张几百 KB × 上百张会拖死面板。 */
.rpt .assetbar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.rpt .assetbar .assetq { flex: 1 1 120px; min-width: 100px; height: 28px; font-size: 12px; }
.rpt .assetbar .assetkindsel { height: 28px; font-size: 12px; }
.rpt .assetbar button.on {
  background: var(--dsw-alias-brand-primary, #4D6BFE);
  color: var(--dsw-alias-label-primary-foreground, #fff); border-color: transparent;
}
.rpt .assetgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 8px; }
.rpt .assettile {
  padding: 0; border-radius: 10px; overflow: hidden; background: transparent; cursor: pointer;
  display: flex; flex-direction: column; gap: 0; border: .5px solid var(--dsw-alias-border-l2, color-mix(in oklab, currentColor 14%, transparent));
}
.rpt .assettile img { display: block; width: 100%; height: 96px; object-fit: cover; }
.rpt .assettile-label {
  font-size: 11px; line-height: 1.4; padding: 3px 5px; text-align: left;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%;
}
/* 资源详情：左大图 + 右信息（窄屏落成单列） */
.rpt .assetview { display: grid; grid-template-columns: minmax(240px, 1fr) minmax(240px, 1fr); gap: 16px; align-items: start; }
.rpt .assetview .assetpic img {
  display: block; width: auto; height: auto; max-width: 100%; max-height: calc(80vh - 200px);
  margin: 0 auto; border-radius: 12px;
  border: .5px solid var(--dsw-alias-border-l2, color-mix(in oklab, currentColor 12%, transparent));
}
.rpt .assetview .assetmeta { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
.rpt .assetview .assetmeta label { font-size: 12px; opacity: .78; }
.rpt .assetview .assetmeta input[type=text] { width: 100%; }
.rpt .assetview .assetprompt { font-size: 12px; line-height: 1.5; opacity: .62; word-break: break-word; }
@media (max-width: 720px) { .rpt .assetview { grid-template-columns: minmax(0, 1fr); } }
/* 备份：一行按钮 + 恢复点清单。清单要能滚（快照多了不该把面板撑长） */
.rpt .backupbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.rpt .snaplist { display: flex; flex-direction: column; gap: 4px; max-height: min(30vh, 220px); overflow: auto; }
.rpt .snaprow {
  display: flex; gap: 8px; align-items: baseline; font-size: 12px;
  padding: 2px 0; border-top: .5px solid var(--dsw-alias-border-l2, color-mix(in oklab, currentColor 8%, transparent));
}
.rpt .snaprow .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
@media (max-width: 860px) {
  .rpt .chareditform { grid-template-columns: minmax(0, 1fr); }
  .rpt .chareditform .facepreview { position: static; }
  .rpt .chareditform .facepreview img { max-height: 60vh; }
  .rpt .chareditform .charfields { grid-template-columns: minmax(0, 1fr); }
  .rpt .chareditform .charfields > label { padding-top: 0; }
}
.rpt .sessionimages { gap: 8px; }
.rpt .sessionimages .imagecontrols { display: flex; gap: 8px 12px; align-items: center; flex-wrap: wrap; }
.rpt .sessionimages label { display: inline-flex; gap: 5px; align-items: center; white-space: nowrap; }
.rpt .sessionimages select { width: auto; min-width: 150px; max-width: 260px; }
.rpt .portraitsummary { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rpt .dmsummary { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 8px; align-items: center; }
.rpt .dupwarn { color: var(--dsw-alias-state-warning-primary, #f59e0b); }
/* 共享编辑浮窗在 .rpt 树之外，因此遮罩自身用独立类，内容根仍带 .rpt 以复用控件样式。 */
.rpt-modal-layer { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center;
  padding: 18px; box-sizing: border-box; background: rgba(0,0,0,.58); }
.rpt-modal-layer .rpt-modal { width: min(1100px, 85vw); height: min(860px, 85vh); max-width: calc(100vw - 36px);
  max-height: calc(100vh - 36px); display: flex; flex-direction: column; overflow: hidden; border-radius: 14px;
  background: var(--dsw-alias-bg-layer-1, #1b1c1f); color: var(--dsw-alias-label-primary, inherit);
  border: .5px solid var(--dsw-alias-border-l4, color-mix(in oklab, currentColor 20%, transparent));
  box-shadow: 0 24px 80px rgba(0,0,0,.55); }
.rpt-modal-layer .rpt-modal-head, .rpt-modal-layer .rpt-modal-foot { flex: none; display: flex; align-items: center; gap: 8px; padding: 12px 16px;
  background: var(--dsw-alias-bg-layer-1, #1b1c1f); }
.rpt-modal-layer .rpt-modal-head { border-bottom: .5px solid var(--dsw-alias-border-l2, color-mix(in oklab, currentColor 12%, transparent)); }
.rpt-modal-layer .rpt-modal-foot { border-top: .5px solid var(--dsw-alias-border-l2, color-mix(in oklab, currentColor 12%, transparent)); }
.rpt-modal-layer .rpt-modal-body { flex: 1 1 auto; overflow: auto; padding: 16px; }
@media (max-width: 760px) {
  .rpt .loreline, .rpt .charline { grid-template-columns: minmax(90px, 1fr) minmax(90px, 1.2fr) auto; }
  .rpt .loreline .rowactions, .rpt .charline .rowactions { grid-column: 1 / -1; justify-self: end; }
  .rpt-modal-layer { padding: 8px; }
  .rpt-modal-layer .rpt-modal { width: calc(100vw - 16px); height: calc(100vh - 16px); max-width: none; max-height: none; }
}
/* 世界设定 + 卡封面：有封面就两列（封面在左 116×150、设定在右）
   右侧输入框**拉伸到与封面同高**（用户要求：「世界那个介绍文本框拉大，对齐图片」）：
   grid 用 stretch，列内 textarea flex:1，封面列多高它就多高。 */
.rpt .worldwrap { display: grid; grid-template-columns: 116px minmax(0, 1fr); gap: 12px; align-items: stretch; }
.rpt .worldcol { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.rpt .worldcol textarea { flex: 1 1 auto; min-height: 150px; }
.rpt textarea.worldtext { min-height: 150px; line-height: 1.6; }
/* DM 设定：规则文本可以很长（导入 DM 卡会填进来），给足高度；生图开关一行排开 */
.rpt textarea.dmtext { min-height: 130px; line-height: 1.6; }
.rpt .dmimgs { gap: 14px; align-items: center; margin-top: 6px; }
.rpt .dmimgs label { display: inline-flex; align-items: center; gap: 5px; }
.rpt .cover { display: flex; flex-direction: column; gap: 4px; font-size: 11px; }
.rpt .cover img { width: 116px; height: 150px; object-fit: cover; border-radius: 8px;
  border: .5px solid var(--dsw-alias-border-l2, color-mix(in oklab, currentColor 12%, transparent)); }
.rpt .cover .row { gap: 8px; align-items: center; }
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
/* 导入面板两列：**左列表与右侧预览同高**（用户反馈「左侧列表长一点」—— 原来封顶 300px，
   5 张卡时只有一百多像素，旁边预览却有七百多，右边一大片空、左边挤成一条）。 */
.rpc .split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.05fr); gap: 12px; align-items: stretch; }
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
/* 卡列表：撑满左列（与右侧预览等高），至少 320px、最高 ~78vh —— 卡片多时在列表内滚动 */
.rpc .list { height: 100%; min-height: 320px; max-height: min(78vh, 820px); overflow: auto;
  border: 1px solid color-mix(in oklab, currentColor 11%, transparent); border-radius: 8px; }
.rpc .item { display: flex; flex-direction: column; gap: 2px; padding: 7px 9px; cursor: pointer;
  border-top: 1px solid color-mix(in oklab, currentColor 8%, transparent); }
.rpc .item:first-child { border-top: none; }
.rpc .item:hover { background: color-mix(in oklab, currentColor 7%, transparent); }
.rpc .item[data-sel='true'] { background: color-mix(in oklab, #4D6BFE 20%, transparent); }
.rpc .item .nm { font-size: 12.5px; }
.rpc .item .mt { font-size: 11px; opacity: .6; }
.rpc .prev { display: flex; flex-direction: column; gap: 8px; }
/* 卡面：选中卡片后显示的那张大图。列表里**不**出缩略图（几十张几 MB 的卡同时拉会拖死），
   只有选中这一张才请求，而且走宿主服务端降采样（thumb=1&width=420）。 */
.rpc .face { max-width: 100%; max-height: 260px; width: auto; align-self: flex-start;
  border-radius: 10px; border: .5px solid var(--dsw-alias-border-l2, color-mix(in oklab, currentColor 12%, transparent)); }
.rpc .greet { display: flex; flex-direction: column; gap: 4px; }
.rpc .macroblk { display: flex; flex-direction: column; gap: 6px; padding: 8px; border-radius: 8px;
  background: color-mix(in oklab, currentColor 5%, transparent); }
/* 宏行：名称列**固定宽度**（等宽字体 + 定宽，名字长短不一时输入框也齐），
   值列吃掉剩余宽度，最后一列固定给「自动 / 预设」标记 —— 对齐靠这三列，不靠手写空格 */
.rpc .macrorows { display: flex; flex-direction: column; gap: 4px; max-height: min(38vh, 320px); overflow: auto; }
.rpc .macrorow, .rpt .macrorow { display: grid; grid-template-columns: 108px minmax(0, 1fr) 44px; gap: 8px; align-items: center; }
.rpc .macrorow .mono, .rpt .macrorow .mono { opacity: .8; }
.rpc .macrorow .mname { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rpc .macrorow .mtag { justify-self: end; font-size: 10.5px; }
.rpc .macrorow input[type='text'] { height: 30px; padding: 0 8px; font-size: 12.5px; }
.rpc .macrorow[data-auto='true'] input[type='text'] { opacity: .75; }
.rpc .macroblk .row.mk { font-size: 12px; font-weight: 600; }
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

    /** 把宿主可选的重复-key诊断压成一行；字段缺失时安静返回空串。 */
    function diagnosticText(value) {
      if (!value) return '';
      if (typeof value === 'string' || typeof value === 'number') return String(value);
      if (Array.isArray(value)) return value.map((item) => {
        if (typeof item === 'string' || typeof item === 'number') return String(item);
        if (!item || typeof item !== 'object') return '';
        return String(item.key ?? item.name ?? item.title ?? item.message ?? '');
      }).filter(Boolean).join('、');
      if (typeof value === 'object') return Object.entries(value).map(([key, item]) => {
        const detail = diagnosticText(item);
        return detail ? `${key}: ${detail}` : key;
      }).join('；');
      return '';
    }

    function namedDiagnostic(source, name) {
      if (!source) return '';
      if (Array.isArray(source)) {
        const matched = source.filter((item) => !item || typeof item !== 'object'
          || [item.name, item.title, item.character].some((v) => String(v ?? '') === String(name ?? '')));
        return diagnosticText(matched);
      }
      if (typeof source === 'object' && name && Object.prototype.hasOwnProperty.call(source, name)) {
        return diagnosticText(source[name]);
      }
      return diagnosticText(source);
    }

    /**
     * 角色、世界书、DM 共用的一只大编辑器。浏览器里始终 portal 到 document.body；
     * 极简宿主拿不到 react-dom/body 时才退回原位。关闭/Escape 都走同一个未保存确认。
     */
    function SharedPortalModal({ title, dirty, onClose, footer, children }) {
      const closeRef = React.useRef(onClose);
      closeRef.current = onClose;
      const openerRef = React.useRef(null);
      React.useEffect(() => {
        openerRef.current = typeof document !== 'undefined' ? document.activeElement : null;
        const onKeyDown = (event) => {
          if (event?.key === 'Escape') closeRef.current?.();
        };
        if (typeof document?.addEventListener === 'function') document.addEventListener('keydown', onKeyDown);
        return () => {
          if (typeof document?.removeEventListener === 'function') document.removeEventListener('keydown', onKeyDown);
          try { openerRef.current?.focus?.(); } catch { /* 焦点恢复失败不影响关闭 */ }
        };
      }, []);
      const content = h('div', {
        className: 'rpt rpt-modal-layer', role: 'presentation',
        onMouseDown: (event) => { if (event.target === event.currentTarget) closeRef.current?.(); },
      }, h('section', { className: 'rpt-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, [
        h('div', { key: 'head', className: 'rpt-modal-head' }, [
          h('h3', { key: 'title' }, title),
          dirty ? h('span', { key: 'dirty', className: 'badge warn' }, '未应用') : null,
          h('span', { key: 'sep', className: 'sep' }),
          h('button', { key: 'close', className: 'tiny', onClick: () => closeRef.current?.(), title: '关闭（Esc）' }, '关闭'),
        ]),
        h('div', { key: 'body', className: 'rpt-modal-body' }, children),
        h('div', { key: 'foot', className: 'rpt-modal-foot' }, footer),
      ]));
      return ReactDOM?.createPortal && typeof document !== 'undefined' && document.body
        ? ReactDOM.createPortal(content, document.body)
        : content;
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
      // 宿主给的自动宏名单（设置页要把「哪些宏不用填」提示出来）
      const [autoMacros, setAutoMacros] = React.useState([]);
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
          // 自动宏名单由宿主给（`{{time}}` 那一族 + 年月日时分秒分量）：界面只负责提示，不自己抄一份
          setAutoMacros(Array.isArray(data.autoMacros) ? data.autoMacros : []);
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

      // 三档图像尺寸的内置默认值：宿主还没重启 / 配置里缺这一项时也**不显示 0**。
      // 与宿主 `DEFAULT_IMAGE_SIZES` 保持一致（1.12.8 起调小：出图时间基本正比于像素，
      // 聊天里用不到 1024 宽）。
      const IMAGE_SIZE_DEFAULTS = { scene: [768, 432], portrait: [512, 768], item: [512, 512] };
      /**
       * 解析出当前的三个尺寸（缺就用内置默认值）。
       *
       * 界面显示与保存都走它：宿主还是旧版（config 里没有 `imageSizes`）时，用户看到的是
       * 默认值而不是 0，保存时也把默认值**一起交回去** —— 旧宿主不会自己补，交回去就自愈了。
       */
      function resolvedImageSizes() {
        const out = {};
        for (const [slot, fallback] of Object.entries(IMAGE_SIZE_DEFAULTS)) {
          const raw = draft?.imageSizes?.[slot];
          const ok = Array.isArray(raw) && Number(raw[0]) >= 256 && Number(raw[1]) >= 256;
          out[slot] = ok ? [Number(raw[0]), Number(raw[1])] : fallback;
        }
        return out;
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
            // 默认宏列表整份提交（键值对）；userLabel 由宿主从 macros.user 同步，不再单独发
            cards: { root: draft.cards?.root ?? '', macros: draft.cards?.macros ?? {} },
            // 全局图像尺寸（场景/立绘/道具）：用**解析后**的值，缺配置时把默认值交回去自愈
            imageSizes: resolvedImageSizes(),
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

      // ── 风格库：**紧凑一行**（名称 + 参数），名称与 key 不可编辑 ──────────────
      // 用户明确要求：去掉「新增风格」、名称不可改、只显示名称与后面的参数。
      // 要加风格就直接改 styles.json（设置页顶部有「打开配置文件」）。
      const styleRows = state.styles.map((s) => {
        const d = draft.styles[s.key] ?? {};
        return h('div', { key: s.key, className: 'stylerow' }, [
          h('div', { key: 'n', className: 'styname' }, [
            h('span', { key: 'l' }, d.label ?? s.key),
            h('span', { key: 'k', className: 'mono dim' }, s.key),
            s.builtin ? null : h('span', { key: 'c', className: 'badge warn' }, '自定义'),
          ]),
          h('label', { key: 'c', className: 'styfield' }, 'CFG', h('input', {
            type: 'number', step: '0.1', min: '1', value: d.cfg ?? 1,
            onChange: (e) => patchStyle(s.key, 'cfg', Number(e.target.value)),
          })),
          h('label', { key: 's', className: 'styfield' }, '步数', h('input', {
            type: 'number', min: '1', value: d.steps ?? 8,
            onChange: (e) => patchStyle(s.key, 'steps', Number(e.target.value)),
          })),
          h('span', { key: 'lr', className: 'stylora' }, loraSelect(d.lora ?? '', (v) => patchStyle(s.key, 'lora', v), `lora-${s.key}`)),
          h('input', {
            key: 't', type: 'text', className: 'stytrigger', value: d.trigger ?? '',
            placeholder: '触发词（写在提示词最前，可留空）',
            onChange: (e) => patchStyle(s.key, 'trigger', e.target.value),
          }),
          h('div', { key: 'act', className: 'row styact' }, [
            h('button', { key: 'p', className: 'tiny', disabled: Boolean(busy), onClick: () => runPreview(s.key) },
              busy === `preview:${s.key}` ? '…' : '试出'),
            s.builtin ? null : h('button', {
              key: 'd', className: 'tiny', disabled: Boolean(busy), onClick: () => removeStyle(s.key),
            }, '删除'),
          ]),
        ]);
      });

      /** 三个大类小节：标题 + 一句说明 + 内容。 */
      const section = (title, hint, children, key) => h('div', { key: `sec-${key}`, className: 'card rpsec' }, [
        h('div', { key: 'h', className: 'row sechead' }, [
          h('h4', { key: 't' }, title),
          hint ? h('span', { key: 'd', className: 'dim' }, hint) : null,
        ]),
        ...children,
      ]);
      const sizeRow = (slot, label) => {
        // 显示用**解析后**的值：宿主旧版 / 配置缺项时显示内置默认值，绝不显示 0
        const pair = resolvedImageSizes()[slot];
        const setSlot = (idx, value) => {
          const n = Number(value);
          const next = [pair[0], pair[1]];
          next[idx] = Number.isFinite(n) ? Math.round(n) : pair[idx];
          setDraft({ ...draft, imageSizes: { ...(draft.imageSizes ?? {}), [slot]: next } });
        };
        return h('div', { key: `sz-${slot}`, className: 'szrow' }, [
          h('span', { key: 'l', className: 'szlabel' }, label),
          h('input', { key: 'w', type: 'number', min: '256', step: '16', value: pair[0], onChange: (e) => setSlot(0, e.target.value) }),
          h('span', { key: 'x', className: 'dim szx' }, '×'),
          h('input', { key: 'h', type: 'number', min: '256', step: '16', value: pair[1], onChange: (e) => setSlot(1, e.target.value) }),
          h('span', { key: 'u', className: 'dim szu' }, 'px'),
        ]);
      };

      return h('div', { className: 'rpt' }, [
        h('div', { key: 'head', className: 'row' }, [
          h('h3', { key: 't' }, 'RP工具'),
          h('span', { key: 'sep', className: 'sep' }),
          h('button', { key: 'chk', onClick: check, disabled: Boolean(busy) }, busy === 'check' ? '检查中…' : '检查连接'),
          h('button', { key: 'reload', onClick: reload, disabled: Boolean(busy) }, '刷新'),
          h('button', { key: 'save', className: 'primary', onClick: save, disabled: Boolean(busy) }, busy === 'save' ? '保存中…' : '保存'),
          h('button', { key: 'reset', onClick: reset, disabled: Boolean(busy) }, '恢复默认'),
        ]),
        msg ? h('div', { key: 'msg', className: 'msg' }, msg.text) : null,

        // ══ 设定 ══ 文字与卡库类：卡往哪找、宏的默认值 ────────────────────────
        section('设定', '文字与卡库', [
          h('div', { key: 'kv', className: 'kv' }, [
            h('span', { key: 'k1' }, '卡库目录'),
            h('input', {
              key: 'k2', type: 'text', value: draft.cards?.root ?? '',
              placeholder: '留空 = 会话工作区下的 rp-cards',
              onChange: (e) => setDraft({ ...draft, cards: { ...(draft.cards ?? {}), root: e.target.value } }),
            }),
          ]),
          h('div', { key: 'mk', className: 'kv' }, [
            h('span', { key: 'u1' }, '默认宏列表'),
            h('div', { key: 'u2', className: 'macroblk' }, [
              // 键值对编辑器：**名字可以改**（这里只是预设默认值，还不知道会用哪张卡，
              // 所以不存在「改了匹配不上」的问题）；导入/面板里那些名字来自卡里的占位符，
              // 那边不能改名 —— 两处的规则刻意不同。
              ...Object.entries(draft.cards?.macros ?? {}).map(([name, value], i) => h('div', { key: `m${i}`, className: 'row macrorow' }, [
                h('input', {
                  key: 'n', type: 'text', value: name, className: 'mono',
                  'data-name': name,                      // 原值：改名时用它把老键删掉
                  onChange: (e) => {
                    const next = e.target.value.trim().toLowerCase();
                    // 清空 / 非法字符时保留原名，否则这一行会在输入过程中反复消失
                    if (!MACRO_RE.test(next)) return;
                    const macros = { ...(draft.cards?.macros ?? {}) };
                    if (next !== name && macros[next] !== undefined) {
                      setMsg({ kind: 'err', text: `已经有 {{${next}}} 了 —— 名字没改` });
                      return;   // 撞名不覆盖（静默丢一条默认值比撞名麻烦得多）
                    }
                    delete macros[name];
                    macros[next] = value;
                    setDraft({ ...draft, cards: { ...(draft.cards ?? {}), macros } });
                    if (msg?.kind === 'err') setMsg(null);
                  },
                }),
                h('input', {
                  key: 'v', type: 'text', value,
                  placeholder: name === 'user' ? '玩家' : '默认值',
                  onChange: (e) => setDraft({
                    ...draft,
                    cards: { ...(draft.cards ?? {}), macros: { ...(draft.cards?.macros ?? {}), [name]: e.target.value } },
                  }),
                }),
                h('button', {
                  key: 'd', className: 'iconbtn', title: '删掉这条默认宏',
                  onClick: () => {
                    const macros = { ...(draft.cards?.macros ?? {}) };
                    delete macros[name];
                    setDraft({ ...draft, cards: { ...(draft.cards ?? {}), macros } });
                  },
                }, '×'),
              ])),
              h('button', {
                key: 'add', className: 'addbtn',
                onClick: () => {
                  // 新行的名字给一个「不撞车」的占位，用户直接改
                  const macros = { ...(draft.cards?.macros ?? {}) };
                  let n = 1;
                  while (macros[`macro${n}`] !== undefined) n += 1;
                  macros[`macro${n}`] = '';
                  setDraft({ ...draft, cards: { ...(draft.cards ?? {}), macros } });
                },
              }, '＋ 添加默认宏'),
            ]),
          ]),
          h('div', { key: 'hint', className: 'dim' },
            Object.keys(draft.cards?.macros ?? {}).length === 0
              ? '还没有默认宏：点「＋ 添加默认宏」，名字填 user、值填玩家。'
              : '导入卡时，卡里写的 {{宏}} 用这里的默认值预填（会话里填过的以会话为准）。'
                + `例：user → ${draft.cards?.macros?.user || '玩家'}。`),
          h('div', { key: 'auto', className: 'dim' },
            `自动宏（不用填，装配时现算）：${(autoMacros ?? []).map((n) => `{{${n}}}`).join(' ')}`),
        ], 'config'),

        // ══ 图像 ══ 出图相关的全部设置：地址、风格、负面词、尺寸 ───────────────
        section('图像', '本地 ComfyUI 生图', [
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
            }, Object.keys(draft.styles).map((k) => h('option', { key: k, value: k }, draft.styles[k].label ?? k))),
            h('span', { key: 'n1' }, '全局负面词'),
            h('textarea', {
              key: 'n2', rows: 2, value: draft.negative ?? '', placeholder: '反瑕疵词（已预置一套）',
              onChange: (e) => setDraft({ ...draft, negative: e.target.value }),
            }),
            h('span', { key: 'z1' }, '图像尺寸'),
            h('div', { key: 'z2', className: 'szblock' }, [
              sizeRow('scene', '场景'),
              sizeRow('portrait', '立绘'),
              sizeRow('item', '道具'),
            ]),
          ]),
          h('div', { key: 'note', className: 'dim' },
            '尺寸对所有用途生效（场景/立绘/道具各一档）；krea2 风格 CFG=1 时负面词不参与计算。'),

          h('div', { key: 'styles', className: 'row sechead' }, [
            h('h4', { key: 't' }, `风格库（${state.styles.length}）`),
            h('span', { key: 'd', className: 'dim' }, '名称与 key 固定；CFG / 步数 / LoRA / 触发词可改。要加风格改 styles.json'),
          ]),
          loraErr ? h('div', { key: 'le', className: 'dim' }, `LoRA 清单读取失败（${loraErr}）—— 确认 ComfyUI 已启动`) : null,
          h('div', { key: 'list', className: 'stylegrid' }, styleRows),

          preview ? h('div', { key: 'prev', className: 'card', ref: previewRef }, [
            h('div', { key: 'l', className: 'row' }, [
              h('span', { key: 't', className: 'dim' }, `预览：${preview.key}（${(preview.elapsedMs / 1000).toFixed(1)}s）`),
              h('span', { key: 'sep', className: 'sep' }),
              preview.url ? h('a', { key: 'o', className: 'dim', href: preview.url, target: '_blank', rel: 'noreferrer' }, '大图') : null,
            ]),
            preview.url ? h('img', { key: 'i', className: 'pv', src: preview.url, alt: preview.key }) : null,
          ]) : null,
        ], 'image'),

        // ══ 工具 ══ 诊断与工具清单 ───────────────────────────────────────────
        section('工具', `rp_* 只在 DM 预设的会话里注册（当前 ${tools.length} 个）`, [
          h('div', { key: 'd', className: 'dim' }, '这些是 DM 能调用的工具；其它预设的会话不加载。'),
          h('div', { key: 'list', className: 'toollist scroll' }, tools.map((tool) => h('div', { key: tool.name, className: 'tool' }, [
            h('span', { key: 'a', className: 'mono' }, tool.name),
            h('span', { key: 'b', className: 'dim' }, `  ${String(tool.description ?? '').split('\n')[0]}`),
          ]))),
          h('div', { key: 'file', className: 'dim mono' }, `配置文件：${state.file}`),
        ], 'tools'),
      ]);
    }

    // ── 会话 RP 面板：两种外壳共用同一份内容 ────────────────────────────────
    //   variant='float'（默认）：点头部按钮弹出的浮层，自带关闭按钮
    //   variant='embed'        ：挂在右侧栏页签里，由右栏自己管关闭/收起
    function RpSessionOverlay({ sessionId, onClose, variant, ...props }) {
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
      /** 正在共享大浮窗里编辑的世界书条目。 */
      const [loreEdit, setLoreEdit] = React.useState(null);
      const [loreEditDirty, setLoreEditDirty] = React.useState(false);
      /** 角色与 DM 也复用同一只 portal 编辑器；列表里只留单行摘要。 */
      const [charEdit, setCharEdit] = React.useState(null);
      const [dmEdit, setDmEdit] = React.useState(null);
      // 资源库：列表（含每个分类的条数）、当前筛选、详情浮窗里那条
      const [assets, setAssets] = React.useState(null);
      const [assetKind, setAssetKind] = React.useState('');
      const [assetQuery, setAssetQuery] = React.useState('');
      const [assetEdit, setAssetEdit] = React.useState(null);
      const [assetImportKind, setAssetImportKind] = React.useState('scene');
      // 会话包：快照列表（面板显示「有几个恢复点」）+ 待恢复的快照
      const [snaps, setSnaps] = React.useState(null);
      // 详情浮窗里的可编辑副本（**打开时**从那条资源铺一次，不在打字过程中被外部刷新冲掉）
      const [assetMetaDraft, setAssetMetaDraft] = React.useState({ label: '', tags: '' });
      const [assetPortraitTarget, setAssetPortraitTarget] = React.useState('');
      const assetEditId = assetEdit?.id ?? '';
      React.useEffect(() => {
        if (!assetEdit) return;
        setAssetMetaDraft({ label: String(assetEdit.label ?? ''), tags: (assetEdit.tags ?? []).join(',') });
        setAssetPortraitTarget('');
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [assetEditId]);
      const [loreQuery, setLoreQuery] = React.useState('');
      /** 是否把「空条目」（正文只有模板残留，永不注入）也列出来 —— 默认藏起来 */
      const [showEmptyLore, setShowEmptyLore] = React.useState(false);
      // 宿主对「这个会话是不是 dm / 有没有开局」的答复：面板里显示一行诊断，
      // 也是导入入口的第二条判据（见 dock 里的说明）。
      const [gate, setGate] = React.useState(null);
      const [tableDraft, setTableDraft] = React.useState({ name: '', dice: '', entries: '' });
      // 全局玩家称呼（面板里 {{user}} 留空的说明要用）
      const [globalUserLabel, setGlobalUserLabel] = React.useState('');
      // 每个角色自己的立绘：{ [角色名]: { url, style, elapsedMs } }
      const [portraits, setPortraits] = React.useState({});
      /** 当前草稿的镜像（软刷新要拿它和宿主那份比，判断用户有没有动过表单）。 */
      const draftRef = React.useRef(null);
      /** 上次从宿主载入的草稿序列化 —— 与 draftRef 相同即「用户没改过」。 */
      const hostDraftRef = React.useRef('');
      /**
       * 用户有没有**没保存的改动**。
       * 软刷新（DM 那一轮结束）靠它决定要不要覆盖表单：动过就绝不动，免得冲掉人家正在写的东西。
       */
      const dirtyRef = React.useRef(false);
      draftRef.current = draft;
      const previewRef = React.useRef(null);
      useScrollToPreview(preview, previewRef);

      React.useEffect(() => { injectStyles(); void reload(); }, [sessionId]);

      // ── DM 用工具改完设定 → 面板自己刷新（用户报：「dm 填完后需要我手动刷新」）──────
      // 触发源用宿主官方的那份状态：`useSessions` 里的 `running`（`api-session/status` 广播）
      // 与 `updatedAt`（`api-session/activity` → 玩家发了消息）。DM 那一轮结束（running 由
      // true 落回 false）时**软刷新**一次：只覆盖用户没动过的字段，绝不冲掉正在编辑的内容。
      const running = typeof props?.useSessions === 'function'
        ? props.useSessions((s) => (sessionId ? s?.byId?.[sessionId]?.running : undefined))
        : undefined;
      const updatedAt = typeof props?.useSessions === 'function'
        ? props.useSessions((s) => (sessionId ? s?.byId?.[sessionId]?.updatedAt : undefined))
        : undefined;
      const prevRunning = React.useRef(running);
      const prevUpdatedAt = React.useRef(updatedAt);
      /** 上一次处理过的「运行状态 + 活动时间」签名 —— 同一签名不重复刷新（避免自激循环）。 */
      const lastWatchSig = React.useRef('');
      React.useEffect(() => {
        const sig = `${String(running)}|${String(updatedAt)}`;
        if (lastWatchSig.current === sig) return undefined;
        const prev = lastWatchSig.current;
        lastWatchSig.current = sig;
        const wasRunning = prevRunning.current;
        prevRunning.current = running;
        prevUpdatedAt.current = updatedAt;
        if (prev === '') { void softReload(); return undefined; }               // 首次拿到值
        if (wasRunning === true && running === false) { void softReload(); return undefined; }   // 那一轮结束
        if (updatedAt !== undefined) void softReload();                         // 玩家发了新消息
        return undefined;
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [running, updatedAt]);

      /**
       * 软刷新：把宿主那侧的改动（DM 用 rp_character / rp_state / rp_lore 写的、或别人发的消息）
       * 拉进界面，但**用户正在编辑的表单不动**。
       *
       * 判据：草稿与「上次从宿主载入的那份」逐字节一致（= 用户没动过）→ 整份覆盖；
       * 否则只更新只读部分（世界书列表 / 立绘 / 宿主原文），并提示一句「DM 刚改过」。
       */
      async function softReload() {
        try {
          const data = await API.session(sessionId);
          if (!data?.ok) return;
          setState(data);
          setPortraits(portraitsFromSession(data.session?.portraits, sessionId));
          const hostDraft = JSON.parse(JSON.stringify(data.session));
          // 用户**没动过任何字段**（dirtyRef）→ 整份铺上宿主的新版本；
          // 动过就不覆盖表单，只更新只读部分（世界书列表 / 立绘 / 宿主原文）。
          if (!dirtyRef.current) {
            setDraft(hostDraft);
            hostDraftRef.current = JSON.stringify(hostDraft);
            setMsg({ kind: 'ok', text: 'DM 刚改过本会话的设定，已自动刷新。' });
          }
          try {
            const l = await API.lore(sessionId);
            setLore(l?.ok ? l : { exists: false, total: 0, entries: [], error: l?.error });
          } catch { /* 世界书读不到就先不动 */ }
        } catch { /* 软刷新失败不打扰用户 */ }
      }

      // 界面侧的判据（与 dock 里的快速路径同源）：只用来和宿主答复对照着显示。
      // 必须用**原始值**选择器，否则每次 store 变更都产生新引用 → 无限重渲染。
      const clientPreset = typeof props?.useSessions === 'function'
        ? props.useSessions((s) => {
          const v = sessionId ? s?.byId?.[sessionId]?.projectionValues?.agentPreset : undefined;
          return typeof v === 'string' ? v : '';
        })
        : '';
      const clientBlank = typeof props?.useSessions === 'function'
        ? props.useSessions((s) => (sessionId ? s?.byId?.[sessionId]?.blank : undefined))
        : undefined;

      async function reload() {
        setBusy('load');
        try {
          const [data, global] = await Promise.all([API.session(sessionId), API.state()]);
          if (!data?.ok) throw new Error(data?.error ?? '读取失败');
          setState(data);
          setStyles(global);
          setGlobalUserLabel(String(global?.config?.cards?.userLabel ?? ''));
          const fresh = JSON.parse(JSON.stringify(data.session));
          setDraft(fresh);
          hostDraftRef.current = JSON.stringify(fresh);
          dirtyRef.current = false;                  // 重新载入 = 回到宿主的版本，没有未保存改动
          // 立绘：会话配置里记着的生成图要**装回面板状态** —— 原先它只活在组件 state 里，
          // 关面板/刷新就没了（用户报的「下次打开就消失」）。
          setPortraits(portraitsFromSession(data.session?.portraits, sessionId));
          setMsg(null);
          // 诊断：把「界面看到的预设」和「宿主说的预设/是否开局」都记下来。
          // 导入入口的可见性一度只依赖客户端投影，而它会被切预设清空 —— 这一行是为了
          // 下次再出「入口不见了」时能一眼看出是哪一侧的值不对，而不是靠猜。
          try { setGate(await API.gate(sessionId)); } catch { setGate(null); }
          // 世界书条目单独取（放在工作区的文件里，不在会话配置里）
          try {
            const l = await API.lore(sessionId);
            setLore(l?.ok ? l : { exists: false, total: 0, entries: [], error: l?.error });
          } catch { setLore({ exists: false, total: 0, entries: [] }); }
          void refreshAssets();
          void refreshSnapshots();
        } catch (error) {
          setMsg({ kind: 'err', text: String(error?.message ?? error) });
        } finally { setBusy(''); }
      }

      /**
       * 拉资源库。**失败不打断面板其它部分**：图墙拉不到只是看不到图，不该让整个世界书都报错。
       * 每次都用宿主给的 `kinds` 渲染筛选条（不在界面里再抄一份分类映射）。
       */
      async function refreshAssets(kind = assetKind, q = assetQuery) {
        try {
          const res = await API.assets({
            sessionId,
            kind: kind || undefined,
            q: String(q ?? '').trim() || undefined,
            limit: 200,
          });
          if (res?.ok) setAssets(res);
        } catch { /* 图墙拉不到就保持原样 */ }
      }

      /** 改完资源（导入/删除/改标签）后重新拉一次 —— 索引是由宿主维护的，界面不自己算。 */
      async function mutateAsset(body) {
        const res = await API.assetSave({ sessionId, ...body });
        if (!res?.ok) throw new Error(res?.error ?? '操作失败');
        await refreshAssets();
        return res;
      }

      /**
       * 拉快照列表。和资源库一样**失败不打断面板**。
       * 导出不是 fetch：走下面那个 `<a download>`，由浏览器直接存盘（省一次 base64 往返）。
       */
      async function refreshSnapshots() {
        try {
          const res = await API.snapshots({ sessionId });
          if (res?.ok) setSnaps(res);
        } catch { /* 备份信息拉不到不影响面板其它部分 */ }
      }

      /** 打一个快照（宿主侧会顺手修剪到最近 N 个）。 */
      async function takeSnapshotNow() {
        setBusy('snapshot');
        try {
          const res = await API.snapshot({ sessionId });
          if (!res?.ok) throw new Error(res?.error ?? '快照失败');
          setSnaps({ ok: true, keep: res.keep, total: (res.items ?? []).length, items: res.items ?? [] });
          setMsg({
            kind: res.failed?.length ? 'warn' : 'ok',
            text: `已拍快照 ${res.name}（${Math.round(Number(res.bytes ?? 0) / 1024)}KB，含 ${res.files} 个文件）`
              + (res.failed?.length ? `；但有 ${res.failed.length} 个旧快照删不掉，请手动清理` : ''),
          });
        } catch (error) {
          setMsg({ kind: 'err', text: String(error?.message ?? error) });
        } finally { setBusy(''); }
      }

      /**
       * 从选中的文件导入会话包。
       *
       * **默认不覆盖**：宿主在目标会话已有内容且没收到 overwrite 时回 409，这里弹一句确认，
       * 用户点了「覆盖」才带 overwrite 再来一次（宿主会在覆盖前自动拍一个快照兜底）。
       */
      async function importBundleFromFile(file, { overwrite = false } = {}) {
        setBusy('import');
        try {
          const dataUrl = await readAsDataUrl(file);
          const payload = { sessionId, dataUrl, overwrite };
          let res = await API.importBundle(payload);
          // 宿主回 409 + needsOverwrite（`jpost` 只回 JSON，不看状态码，所以认这个标志位）
          if (res?.needsOverwrite === true) {
            const yes = window.confirm('目标会话已有内容。导入会**覆盖**它（宿主会先自动拍一个快照兜底）。继续吗？');
            if (!yes) { setMsg({ kind: 'warn', text: '已取消导入（没有改动任何东西）' }); return; }
            res = await API.importBundle({ ...payload, overwrite: true });
          }
          if (!res?.ok) throw new Error(res?.error ?? '导入失败');
          await reload();                       // 配置与世界书都换了，整份重新载入
          await refreshSnapshots();
          setMsg({
            kind: 'ok',
            text: `已导入会话包（来自 ${String(res.from ?? '').slice(0, 8) || '未知会话'}，还原 ${res.files} 个文件`
              + `${res.snapshot ? `，覆盖前的快照：${res.snapshot}` : ''}）`,
          });
        } catch (error) {
          setMsg({ kind: 'err', text: String(error?.message ?? error) });
        } finally { setBusy(''); }
      }

      function patch(p) { dirtyRef.current = true; setDraft((d) => (d ? { ...d, ...p } : d)); }

      /** 改 DM 设定（会话隔离的那几个字段：prompt + images）。 */
      function patchDm(p) {
        dirtyRef.current = true;
        setDraft((d) => (d ? { ...d, dm: { ...(d.dm ?? {}), ...p, migrated: [] } } : d));
      }
      // 状态：只提交改动过的字段（空串即清除），与宿主 applyStateUpdates 的语义一致
      function patchState(field, value) {
        dirtyRef.current = true;
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
            dm: draft.dm ?? {},
          });
          if (!res?.ok) throw new Error(res?.error ?? '保存失败');
          setState((s) => ({ ...s, session: res.session }));
          const savedDraft = JSON.parse(JSON.stringify(res.session));
          setDraft(savedDraft);
          hostDraftRef.current = JSON.stringify(savedDraft);
          dirtyRef.current = false;
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

      /**
       * 「整理设定」：拿宿主的指令正文填进输入框，由用户确认后发送。
       *
       * 为什么不让界面自己拼这段话：措辞只有一处（`lib/card-import.js` 的 `buildTidyPrompt`），
       * 而且它要带上本会话的世界书路径与条目列表 —— 这些只有宿主知道。
       * 也**不自动发送**：这是一条长指令，先进输入框让用户能改。
       */
      async function sendTidy() {
        setBusy('tidy');
        try {
          const res = await API.tidy({ sessionId });
          const text = String(res?.text ?? '');
          if (!res?.ok || !text) throw new Error(res?.error ?? '宿主没有返回指令正文');
          const actions = props?.inputActions;
          if (!actions || typeof actions.setDraft !== 'function') {
            setMsg({ kind: 'err', text: '拿不到输入框，没法把指令填进去。可以直接对 DM 说：「按世界书条目做一次设定整理」。' });
            return;
          }
          actions.setDraft(text);
          setMsg({ kind: 'ok', text: '已把「整理设定」指令填进输入框 —— 看一眼没问题就发送。' });
        } catch (error) {
          setMsg({ kind: 'err', text: String(error?.message ?? error) });
        } finally { setBusy(''); }
      }

      /** 搜索过滤（标题 / 触发词 / 正文预览都搜，与 liketavern 的搜索框一致）。
       *  **空条目默认不显示**（用户要求：「需要智能过滤世界书，无内容的不要」）：
       *  它们不会进上下文，但也没从文件里删掉 —— 想看/想删就点那一行提示展开。 */
      function visibleLoreEntries() {
        const all = lore?.entries ?? [];
        const base = showEmptyLore ? all : all.filter((e) => !e.empty);
        const q = loreQuery.trim().toLowerCase();
        if (!q) return base;
        return base.filter((e) => [e.title, ...(e.keys ?? []), e.preview]
          .some((v) => String(v ?? '').toLowerCase().includes(q)));
      }

      function confirmEditorClose(dirty, close) {
        if (dirty && !window.confirm('有尚未应用的修改，确定关闭编辑器吗？')) return;
        close();
      }

      function patchLoreEdit(p) {
        setLoreEditDirty(true);
        setLoreEdit((d) => (d ? { ...d, ...p } : d));
      }

      function beginDmEdit() {
        setDmEdit({
          prompt: String(draft.dm?.prompt ?? ''),
          source: String(draft.dm?.source ?? draft.dm?.promptSource ?? draft.dm?.origin ?? ''),
          dirty: false,
        });
      }

      function patchDmEdit(prompt) {
        // 同上：浮窗里改 DM 正文也要算「动过字段」，否则软刷新会把它冲掉
        dirtyRef.current = true;
        setDmEdit((d) => (d ? { ...d, prompt, dirty: true } : d));
      }

      function applyDmEdit() {
        if (!dmEdit) return;
        patchDm({ prompt: dmEdit.prompt });
        setDmEdit(null);
        setMsg({ kind: 'ok', text: 'DM 设定已应用到会话草稿；点面板顶部「保存」后持久化。' });
      }

      function beginCharacter(character, index, isNew) {
        const name = String(character?.name ?? '');
        const list = Array.isArray(draft.characterIndex) ? draft.characterIndex : [];
        const idx = list.find((entry) => String(entry?.name ?? '') === name) ?? { name, brief: '', always: false };
        setCharEdit({
          index,
          isNew: isNew === true,
          originalName: name,
          character: JSON.parse(JSON.stringify(character ?? { name: '', appearance: '' })),
          indexEntry: { ...idx },
          dirty: false,
        });
      }

      function patchCharacterEdit(field, value) {
        // 大浮窗里的编辑也算「用户动过字段」：不置 dirtyRef 的话，宿主广播的那次软刷新
        // 会把整份 draft 铺回宿主版本，用户刚改的字还没点「应用」就没了（冒烟测试抓到过）。
        dirtyRef.current = true;
        setCharEdit((edit) => (edit ? { ...edit, dirty: true, character: { ...edit.character, [field]: value } } : edit));
      }

      function patchCharacterIndex(field, value) {
        dirtyRef.current = true;
        setCharEdit((edit) => (edit ? { ...edit, dirty: true, indexEntry: { ...edit.indexEntry, [field]: value } } : edit));
      }

      function applyCharacterEdit() {
        if (!charEdit) return;
        const character = { ...charEdit.character };
        const name = String(character.name ?? '').trim();
        const nextCharacters = charEdit.isNew
          ? [...(draft.characters ?? []), character]
          : (draft.characters ?? []).map((item, index) => (index === charEdit.index ? character : item));
        const previous = Array.isArray(draft.characterIndex) ? draft.characterIndex : [];
        const remaining = previous.filter((entry) => {
          const entryName = String(entry?.name ?? '');
          return entryName !== String(charEdit.originalName ?? '') && entryName !== name;
        });
        const indexEntry = { ...charEdit.indexEntry, name };
        patch({ characters: nextCharacters, characterIndex: name ? [...remaining, indexEntry] : remaining });
        setCharEdit(null);
        setMsg({ kind: 'ok', text: `角色「${name || '未命名'}」已应用到会话草稿；点面板顶部「保存」后持久化。` });
      }

      /**
       * 打开某一条的详情/编辑器。列表里只有 160 字预览，所以正文要**单独取一次**
       * （整本世界书可能几十万字，不能指望列表响应背着它）。
       * `entry` 传 null 就是「新建」。
       */
      async function beginLore(entry) {
        if (!entry) {
          setLoreEdit({ title: '', keysText: '', constant: false, order: 0, probability: 100, body: '', isNew: true });
          setLoreEditDirty(false);
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
            nameConflict: e.nameConflict ?? entry.nameConflict,
          });
          setLoreEditDirty(false);
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
          setLoreEditDirty(false);
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

      // 注：曾经有两个按钮「属性中文化」「重命名无名条目」。按用户拍板，**初始要做的事全部
      // 放进 `cards/<slug>.launch.md`**，由 DM 在开局时自己收拾（它能一次调用
      // `rp_lore(action:"localize")` / `rp_lore(action:"rename_unnamed")` 做完），
      // 面板上不再重复这一层按钮 —— 规则能判的那几件之外的事本来也得 DM 看着办。

      async function deleteLoreEntry(title) {
        if (!window.confirm(`删除世界书条目「${title}」？（只删这一条，文件里其它内容不动）`)) return;
        setBusy('lore-del');
        try {
          const res = await API.loreSave({ sessionId, action: 'delete', title });
          if (!res?.ok) throw new Error(res?.error ?? '删除失败');
          applyLoreResponse(res);
          setLoreEditDirty(false);
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
          // 「条目名与人物卡重名」的诊断（key 重复不做诊断：用户拍板，那只是噪音）
          characterOverlap: res.characterOverlap ?? res.diagnostics?.characterOverlap,
          empty: res.empty,
          emptyChars: res.emptyChars,
          constantChars: res.constantChars,
          kinds: res.kinds,
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
            // **立绘要纵向**（用户要求）：不传的话宿主按场景档出，出来是横向的 ——
            // 那样在角色卡编辑器左列只占半截，头像也扁。
            sizeKey: 'portrait',
          });
          if (!res?.ok) throw new Error(res?.error ?? '出图失败');
          const label = res.styleLabel || res.styleKey || '';
          const ref = res.files?.[0];
          // 先本地显示（同源的相对 URL 与宿主给的绝对 URL 等价），再**记进会话配置**：
          // 下次打开面板 / 刷新页面时用同一张三要素拼回来（见 portraitsFromSession）。
          setPortraits((p) => ({
            ...p,
            [name]: { url: ref ? mediaUrlOf(ref) : res.media?.[0], style: label, elapsedMs: res.elapsedMs },
          }));
          let saved = false;
          if (ref) {
            try {
              const put = await API.portraitSave({
                sessionId, name, action: 'save',
                file: ref.file, subfolder: ref.subfolder, type: ref.type,
                style: label, elapsedMs: res.elapsedMs,
              });
              saved = put?.ok === true;
              if (saved) {
                // 会话配置也同步一份，免得下次「保存」把刚写的立绘覆盖掉（保存是整份覆盖）
                setDraft((d) => (d ? {
                  ...d,
                  portraits: { ...(d.portraits ?? {}), [name]: (put.portraits ?? {})[name] ?? d.portraits?.[name] },
                } : d));
              }
            } catch { /* 存不下不影响这次显示 */ }
          }
          setMsg({
            kind: saved ? 'ok' : 'warn',
            text: `「${name}」立绘完成（${label}，${(res.elapsedMs / 1000).toFixed(1)}s）—— 已作为这个角色的头像显示`
              + (saved ? '，并记进本会话' : '，但**没能记进会话**（下次打开会消失）'),
          });
        } catch (error) {
          setMsg({ kind: 'err', text: String(error?.message ?? error) });
        } finally { setBusy(''); }
      }

      /** 同时清掉界面和会话配置里的立绘记录。 */
      function clearPortrait(name) {
        const key = String(name ?? '').trim();
        if (!key) return;
        setPortraits((current) => { const next = { ...current }; delete next[key]; return next; });
        API.portraitSave({ sessionId, name: key, action: 'clear' })
          .then((res) => {
            if (!res?.ok) return;
            setDraft((current) => (current ? { ...current, portraits: res.portraits ?? {} } : current));
          })
          .catch(() => { /* 清不掉只会导致下次仍显示，不打断编辑 */ });
      }

      /** 文件 → data URL。宿主收不了本地路径，只能这样把图带过去。 */
      function readAsDataUrl(file) {
        return new Promise((resolvePromise, rejectPromise) => {
          const reader = new FileReader();
          reader.onload = () => resolvePromise(String(reader.result ?? ''));
          reader.onerror = () => rejectPromise(new Error('读不出这个文件'));
          reader.readAsDataURL(file);
        });
      }

      /**
       * 外部立绘：用户自己选的图交给宿主落盘（宿主只认 png/jpeg/webp，上限 8MB）。
       * 用户要求「也支持用户用外部导入立绘」—— 生图不满意时不必反复抽卡，直接用现成的图。
       * 走通用导入（kind=portrait + name）：既登记成这个角色的立绘，也进资源库。
       */
      async function importPortrait(character, file) {
        const name = String(character?.name ?? '').trim();
        if (!name) { setMsg({ kind: 'err', text: '先给角色起个名字，立绘要按名字存档' }); return; }
        if (!file) return;
        setBusy(`portrait:${name}`);
        try {
          const dataUrl = await readAsDataUrl(file);
          const res = await API.assetUpload({ sessionId, kind: 'portrait', name, dataUrl });
          if (!res?.ok) throw new Error(res?.error ?? '导入失败');
          const url = String(res.url ?? '');
          setPortraits((p) => ({ ...p, [name]: { url, style: '导入' } }));
          setDraft((d) => (d ? { ...d, portraits: res.portraits ?? d.portraits } : d));
          await refreshAssets();
          setMsg({ kind: 'ok', text: `已把这张图记成「${name}」的立绘（${Math.round(Number(res.bytes ?? 0) / 1024)}KB），也进了资源库` });
        } catch (error) {
          setMsg({ kind: 'err', text: String(error?.message ?? error) });
        } finally { setBusy(''); }
      }

      /** 通用导入：给资源库加一张外部图（角色 / 场景 / 道具）。 */
      async function importAsset(kind, file) {
        if (!file) return;
        setBusy(`asset-import:${kind}`);
        try {
          const dataUrl = await readAsDataUrl(file);
          const res = await API.assetUpload({
            sessionId, kind, dataUrl,
            label: String(file.name ?? '').replace(/\.[^.]+$/, '').slice(0, 60),
          });
          if (!res?.ok) throw new Error(res?.error ?? '导入失败');
          await refreshAssets();
          setMsg({ kind: 'ok', text: `已导入到资源库（${kind === 'portrait' ? '角色' : kind === 'item' ? '道具' : kind === 'other' ? '其他' : '场景'}，${Math.round(Number(res.bytes ?? 0) / 1024)}KB）` });
        } catch (error) {
          setMsg({ kind: 'err', text: String(error?.message ?? error) });
        } finally { setBusy(''); }
      }

      /** 把一张资源提成某个角色的立绘（不复制文件，只改引用）。 */
      async function useAssetAsPortrait(asset, name) {
        const who = String(name ?? '').trim();
        if (!who) { setMsg({ kind: 'err', text: '先选一个角色' }); return; }
        setBusy(`asset-portrait:${asset?.id ?? ''}`);
        try {
          const res = await mutateAsset({ action: 'useAsPortrait', id: asset.id, name: who });
          const url = String(asset.url ?? '');
          setPortraits((p) => ({ ...p, [who]: { url, style: '资源库' } }));
          setDraft((d) => (d ? { ...d, portraits: res.portraits ?? d.portraits } : d));
          setMsg({ kind: 'ok', text: `已把这张图设为「${who}」的立绘` });
        } catch (error) {
          setMsg({ kind: 'err', text: String(error?.message ?? error) });
        } finally { setBusy(''); }
      }

      /** 资源详情里改 label / tags。 */
      async function saveAssetMeta(asset, label, tags) {
        setBusy(`asset-save:${asset?.id ?? ''}`);
        try {
          await mutateAsset({ action: 'update', id: asset.id, label, tags });
          setAssetEdit((cur) => (cur && cur.id === asset.id ? { ...cur, label, tags: String(tags).split(/[,，、;；\s]+/).filter(Boolean) } : cur));
          setMsg({ kind: 'ok', text: '已更新这张图的名称与标签' });
        } catch (error) {
          setMsg({ kind: 'err', text: String(error?.message ?? error) });
        } finally { setBusy(''); }
      }

      /** 删一张资源（宿主会把文件也删掉，并清掉指向它的立绘引用）。 */
      async function deleteAsset(asset) {
        setBusy(`asset-del:${asset?.id ?? ''}`);
        try {
          const res = await mutateAsset({ action: 'delete', id: asset.id });
          if (res.droppedPortraits?.length) {
            setPortraits((p) => {
              const next = { ...p };
              for (const n of res.droppedPortraits) delete next[n];
              return next;
            });
          }
          setAssetEdit(null);
          setMsg({
            kind: 'ok',
            text: `已删除这张图${res.droppedPortraits?.length ? `（同时解除了 ${res.droppedPortraits.join('、')} 的立绘）` : ''}`,
          });
        } catch (error) {
          setMsg({ kind: 'err', text: String(error?.message ?? error) });
        } finally { setBusy(''); }
      }

      /**
       * 「显示到对话」：把这张图拼成一段 `dsh-ui` 围栏填进输入框，由用户确认后发送。
       * 和「整理设定」同一个路子 —— **不自动发送**（用户可能还想加一句话）。
       */
      function showAssetInChat(asset) {
        const actions = props?.inputActions;
        if (!actions || typeof actions.setDraft !== 'function') {
          setMsg({ kind: 'err', text: '拿不到输入框。可以直接把这张图的地址发给 DM。' });
          return;
        }
        const fence = '```dsh-ui\n'
          + `${JSON.stringify({ items: [{ type: 'image', src: asset.url, alt: asset.label || '资源图' }] })}\n`
          + '```';
        actions.setDraft(fence);
        setMsg({ kind: 'ok', text: '已把这张图填进输入框 —— 看一眼没问题就发送。' });
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
      const portraitNames = Object.keys(portraits).filter((name) => portraits[name]?.url);
      const imageEnabled = draft.dm?.images?.enabled !== false;
      const dmPrompt = String(draft.dm?.prompt ?? '');
      const dmSource = String(draft.dm?.source ?? draft.dm?.promptSource ?? draft.dm?.origin ?? '会话配置');
      const characterDiagnostics = draft.duplicateCharacterKeys ?? draft.diagnostics?.duplicateCharacterKeys;
      // 只诊断一种：**世界书条目名 == 人物卡名**（键一律不管 —— 用户口径）。
      const loreDiagnostics = lore?.characterOverlap ?? lore?.diagnostics?.characterOverlap;
      // 编辑器里的同名提示：条目级说明由宿主计算，这里只负责显示
      const nameConflictWarn = diagnosticText(loreEdit?.nameConflict);
      // 大浮窗里的立绘：**当前名字优先**，取不到再退回原名 —— 改名后重新生成，
      // 新图立刻显示；还没重生成时也还能看到旧名的旧图（不至于突然空掉）。
      const charEditName = charEdit ? String(charEdit.character?.name ?? '').trim() : '';
      const charEditOriginal = charEdit ? String(charEdit.originalName ?? '').trim() : '';
      const charEditFaceKey = charEditName || charEditOriginal;
      const charEditPortrait = charEdit
        ? (portraits[charEditName] || portraits[charEditOriginal] || null)
        : null;
      const charEditPortraitUrl = String(charEditPortrait?.url ?? '');
      const charEditPortraitStyle = String(charEditPortrait?.style ?? '');

      return h('div', { className: embed ? 'rpt embed' : 'rpt ovl' }, [
        h('div', { key: 'head', className: 'ovlhead' }, [
          h('h3', { key: 't' }, 'RP'),
          state.isDm ? h('span', { key: 'b', className: 'badge ok' }, 'DM 会话') : h('span', { key: 'b', className: 'badge warn' }, '非 DM'),
          h('span', { key: 'sep', className: 'sep' }),
          h('button', { key: 'r', onClick: reload, disabled: Boolean(busy) }, '刷新'),
          h('button', { key: 'sv', className: 'primary', onClick: save, disabled: Boolean(busy) }, busy === 'save' ? '保存中…' : '保存'),
          embed ? null : h('button', { key: 'x', onClick: onClose }, '关闭'),
        ]),
        // 固定在 RP 标题下第一块：会话生图所有控制集中于此，面板底部不再重复。
        h('div', { key: 'session-images', className: 'card sessionimages' }, [
          h('div', { key: 'h', className: 'row' }, [
            h('h4', { key: 't' }, '本会话生图'),
            h('span', { key: 'sep', className: 'sep' }),
            h('span', { key: 'portraits', className: 'dim portraitsummary', title: portraitNames.join('、') },
              portraitNames.length ? `已有立绘 ${portraitNames.length}：${portraitNames.join('、')}` : '暂无已生成立绘'),
          ]),
          h('div', { key: 'controls', className: 'imagecontrols' }, [
            h('label', { key: 'en', className: 'dim' }, [
              h('input', {
                key: 'i', type: 'checkbox', checked: imageEnabled,
                onChange: (event) => patchDm({ images: { ...(draft.dm?.images ?? {}), enabled: event.target.checked } }),
              }),
              '自动配图',
            ]),
            h('label', { key: 'fa', className: 'dim' }, [
              h('input', {
                key: 'i', type: 'checkbox', disabled: !imageEnabled,
                checked: draft.dm?.images?.firstAppearance !== false,
                onChange: (event) => patchDm({ images: { ...(draft.dm?.images ?? {}), firstAppearance: event.target.checked } }),
              }),
              '首次出场',
            ]),
            h('label', { key: 'ks', className: 'dim' }, [
              h('input', {
                key: 'i', type: 'checkbox', disabled: !imageEnabled,
                checked: draft.dm?.images?.keyScenes !== false,
                onChange: (event) => patchDm({ images: { ...(draft.dm?.images ?? {}), keyScenes: event.target.checked } }),
              }),
              '重要场景',
            ]),
            h('label', { key: 'style', className: 'dim' }, [
              '默认风格',
              h('select', {
                key: 's', value: draft.defaultStyle ?? '',
                onChange: (event) => patch({ defaultStyle: event.target.value }),
              }, [
                h('option', { key: '', value: '' }, `跟随全局：${styles?.config?.defaultStyle ?? '?'}`),
                ...Object.keys(styles?.config?.styles ?? {}).map((key) => h('option', { key, value: key }, `${styles.config.styles[key].label} (${key})`)),
              ]),
            ]),
            h('button', {
              key: 'preview', className: 'tiny', disabled: Boolean(busy),
              onClick: () => runPreview(draft.defaultStyle || undefined, '一位旅人站在岔路口，远处有灯火'),
            }, busy === 'preview' ? '出图中…' : '试出 / 预览'),
            h('span', { key: 'advanced', className: 'dim', title: '提示词前缀、风格备注与战役名由 DM 的 rp_session 工具维护' }, '高级配置由 DM 工具维护'),
          ]),
          preview ? h('div', { key: 'prev', className: 'imagepreview', ref: previewRef }, [
            h('div', { key: 'l', className: 'row' }, [
              h('span', { key: 't', className: 'dim' }, `预览：${preview.style ?? ''}（${(preview.elapsedMs / 1000).toFixed(1)}s）`),
              h('span', { key: 'sep', className: 'sep' }),
              preview.url ? h('a', { key: 'o', className: 'dim', href: preview.url, target: '_blank', rel: 'noreferrer' }, '新标签打开大图') : null,
            ]),
            preview.url ? h('img', { key: 'i', className: 'pv', src: preview.url, alt: 'preview' }) : null,
          ]) : null,
        ]),
        msg ? h('div', { key: 'msg', className: 'msg' }, msg.text) : null,
        // 诊断行：导入入口的可见性历史上就看这两侧的值，出问题时一眼能看出是哪边不对
        h('div', { key: 'diag', className: 'dim' }, `入口判据 — 界面：预设「${clientPreset || '空'}」/${clientBlank === false ? '已开局' : clientBlank === true ? '未开局' : '未知'}；宿主：预设「${gate?.preset || '未知'}」/${gate ? (gate.started ? '已开局' : '未开局') : '未答'}`),

        // ── DM 设定（默认只占一行；长文本在共享 portal 编辑器里改）──────────────
        h('div', { key: 'dm', className: 'card dmcard' }, [
          h('div', { key: 'summary', className: 'dmsummary' }, [
            h('h4', { key: 't' }, 'DM 设定'),
            h('span', { key: 's', className: 'dim' },
              `${dmPrompt.trim() ? '已配置' : '未配置'} · ${dmPrompt.length} 字 · 来源：${dmSource}`),
            h('button', { key: 'edit', className: 'tiny', onClick: beginDmEdit }, '编辑'),
          ]),
          (draft.dm?.migrated ?? []).length
            ? h('div', { key: 'mig', className: 'dim dupwarn' },
              `⚠ 已把 ${(draft.dm.migrated ?? []).join('、')} 从角色卡挪到这里 —— 确认后在编辑器应用，再点顶部「保存」。`)
            : null,
        ]),

        // 世界设定 + **卡封面**：导入卡的 PNG 就摆在这里（用户要求：
        // 「PNG 移到世界设定旁边，作为封面」）。封面是**卡的书封**，不是任何角色的立绘。
        (() => {
          const coverRel = draft.cover?.card;
          const coverUrl = typeof coverRel === 'string' && coverRel
            // 封面也只是看一眼，走服务端降采样（卡 PNG 可能几 MB）
            ? cardImageUrl(coverRel, state?.cwd ?? '', sessionId, { thumb: '1', width: '240' })
            : '';
          const body = [
            h('textarea', {
              key: 'w', className: 'worldtext', value: draft.world ?? '', placeholder: '世界观、时代、地点、基调……',
              onChange: (e) => patch({ world: e.target.value }),
            }),
            h('div', { key: 'd', className: 'dim' }, `本会话配置文件（DM 也能用 read/write 直接改）：${state.file ?? ''}`),
          ];
          return h('div', {
            key: 'world', className: 'card', 'data-cover': coverUrl ? 'true' : 'false',
          }, [
            h('h4', { key: 't' }, '世界设定'),
            coverUrl
              ? h('div', { key: 'wrap', className: 'worldwrap' }, [
                h('div', { key: 'cover', className: 'cover' }, [
                  h('img', { key: 'i', src: coverUrl, alt: '卡封面', loading: 'lazy' }),
                  h('div', { key: 'l', className: 'dim' }, String(draft.cover?.name ?? '').slice(0, 24) || '卡封面'),
                  h('div', { key: 'a', className: 'row' }, [
                    h('a', { key: 'o', className: 'dim', href: coverUrl, target: '_blank', rel: 'noreferrer' }, '大图'),
                  ]),
                ]),
                h('div', { key: 'col', className: 'worldcol' }, body),
              ])
              : body,
          ]);
        })(),

        // ── 宏（按会话隔离）：`{{user}}` 与自定义 `{{x}}` 的值 ──────────────────
        // 值存在会话配置里，宿主会用同名**变量**在注入时插值 —— 所以改完保存，
        // 世界设定 / 世界书条目里写的 `{{x}}` 立刻跟着变（不是把值烤进文件）。
        h('div', { key: 'macros', className: 'card' }, [
          h('div', { key: 'h', className: 'row' }, [
            h('h4', { key: 't' }, `宏 / 变量（${Object.keys(draft.macros ?? {}).length}）`),
            h('span', { key: 'sep', className: 'sep' }),
            h('span', { key: 'd', className: 'dim' }, `按会话隔离；{{user}} 留空 = 全局「${globalUserLabel || '玩家'}」`),
          ]),
          // 只改值：**名字来自卡里的占位符**（或设置页的默认宏列表），在这里改名就对不上卡了。
          // 想加宏/改名字去设置页的「默认宏列表」（那边的名字可改）。
          ...Object.entries(draft.macros ?? {}).map(([name, value], i) => h('div', { key: `m${i}`, className: 'row macrorow' }, [
            h('span', { key: 'n', className: 'mono mname', title: `文本里的 {{${name}}} 会换成这里填的值` }, `{{${name}}}`),
            h('input', {
              key: 'v', type: 'text', value,
              placeholder: name === 'user' ? '玩家' : '默认值',
              onChange: (e) => patch({ macros: { ...(draft.macros ?? {}), [name]: e.target.value } }),
            }),
          ])),
          h('div', { key: 'note', className: 'dim' },
            '在世界设定 / 世界书条目里写 {{名字}}，注入时会被替换成这里的值。要新增或改宏名，去设置页「默认宏列表」。'),
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
            h('button', { key: 'r', className: 'tiny', onClick: () => void loadLore(), disabled: busy === 'lore' },
              busy === 'lore' ? '读取中…' : '刷新'),
            // 让 DM 把设定收一次尾（导入是规则解码，「当前进度/前情提要/物品清单」那类会过期的
            // 条目得由它看着删或改成触发式）。指令正文由宿主给（措辞只有一处），这里只负责发出去。
            h('button', {
              key: 'tidy', className: 'tiny', disabled: Boolean(busy),
              title: '把一条「整理设定」的指令发给 DM：角色卡字段归位、世界书删掉会过期的条目、补触发词。指令会填进输入框，你可以改完再发',
              onClick: () => void sendTidy(),
            }, busy === 'tidy' ? '准备中…' : '整理设定'),
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
          // 常驻条目是**每轮都注入**的（而且直接写进系统提示的常驻段，不进每轮快照），
          // 所以这里把体积直接算出来（只报条数回答不了「这本世界书到底占了多少上下文」）。
          // 数字来自宿主 loreOverview，口径与注入时的成本一致。
          lore && lore.exists && lore.constant
            ? h('div', { key: 'cost', className: 'dim' },
              `每轮都会注入：常驻 ${lore.constant} 条 ≈ ${lore.constantChars ?? 0} 字/轮（写进系统提示的常驻段）`
              + (lore.kinds ? `（设定 ${lore.kinds['设定'] ?? 0}｜规则 ${lore.kinds['规则'] ?? 0}｜状态 ${lore.kinds['状态'] ?? 0}｜历史 ${lore.kinds['历史'] ?? 0}）` : ''))
            : null,
          // 导入来的常驻与超预算的常驻**不进系统提示**：它们按触发词进 runtime（命中才注入）。
          // 必须说清楚「它们没丢」，否则用户会以为导入的设定不见了。
          lore && lore.exists && (lore.demoted ?? []).length
            ? h('div', { key: 'demoted', className: 'dim' },
              `另有 ${lore.demoted.length} 条标了 constant 的条目**按需注入**（不占系统提示，命中触发词才进）`
              + `${lore.importedEntries ? `：其中 ${lore.importedEntries} 条来自导入的卡` : ''}`
              + `—— 需要时用 rp_lore 按标题读`)
            : null,
          // 空条目：不注入上下文，但还在文件里 —— 默认藏起来，给一行提示 + 展开开关
          lore && lore.exists && lore.empty
            ? h('div', { key: 'empty', className: 'row loreempty dim' }, [
              h('span', { key: 't' },
                `已隐藏 ${lore.empty} 条空条目（正文只有 markdown 残留，${lore.emptyChars ?? 0} 字，不会被注入）`),
              h('span', { key: 's', className: 'sep' }),
              h('button', {
                key: 'b', className: 'tiny', onClick: () => setShowEmptyLore((v) => !v),
              }, showEmptyLore ? '收起' : '显示 / 清理'),
            ])
            : null,
          // 搜索：条目一多就得能筛（标题 / 触发词 / 正文预览）
          lore && lore.exists && (lore.entries ?? []).length > 6
            ? h('input', {
              key: 'q', type: 'search', value: loreQuery, placeholder: '搜索条目名、触发词或正文…',
              onChange: (e) => setLoreQuery(e.target.value),
            })
            : null,
          // 只提示「条目名 == 人物卡名」这一种：key 重复无所谓、也不显示（用户拍板）。
          diagnosticText(loreDiagnostics)
            ? h('div', { key: 'dupes', className: 'msg dupwarn' },
              `⚠ 与人物卡重名的条目：${diagnosticText(loreDiagnostics)}—— 这几条的正文已由人物卡承载，世界书不会再重复注入`)
            : null,
          lore && lore.exists
            ? h('div', { key: 'list', className: 'scroll lorelist' }, visibleLoreEntries().map((entry, index) => {
              const conflict = diagnosticText(entry.nameConflict)
                || namedDiagnostic(loreDiagnostics, entry.title);
              const keys = Array.isArray(entry.keys) ? entry.keys : [];
              return h('div', {
                key: `e${index}`, className: 'loreitem', 'data-empty': entry.empty ? 'true' : 'false',
              }, h('div', { className: 'loreline' }, [
                h('span', { key: 't', className: 'loretitle', title: entry.title }, entry.title),
                h('span', { key: 'meta', className: 'dim loresummary', title: keys.join('、') },
                  `${entry.kind || '设定'} · ${entry.constant ? 'constant' : (keys.length ? `keys ${keys.join('、')}` : '无 keys')} · order ${entry.order ?? 0}`),
                h('span', { key: 'status', className: 'row charstatus' }, [
                  entry.empty ? h('span', { key: 'empty', className: 'badge warn' }, '空') : null,
                  // 来源：导入来的条目按触发词走 runtime，不因原卡的 constant 占系统提示
                  entry.source === 'card'
                    ? h('span', { key: 'src', className: 'badge', title: '从 PNG 卡导入的条目：按触发词注入，不写进系统提示' }, '导入') : null,
                  entry.constant && (entry.kind === '历史' || entry.kind === '状态')
                    ? h('span', { key: 'stale', className: 'badge warn', title: '状态/历史常驻会持续注入过期内容' }, '常驻存疑') : null,
                  !entry.constant && !keys.length
                    ? h('span', { key: 'never', className: 'badge warn', title: '既没有 keys 也不是 constant，不会被注入' }, '永不触发') : null,
                  conflict ? h('span', { key: 'dup', className: 'badge warn', title: conflict }, '与人物同名') : null,
                  h('span', { key: 'chars', className: 'dim' }, `${entry.chars} 字`),
                ]),
                h('label', { key: 'constant', className: 'dim loreconst', title: '常驻：每轮都注入' }, [
                  h('input', {
                    key: 'c', type: 'checkbox', checked: entry.constant === true, disabled: Boolean(busy),
                    onChange: (event) => void toggleLoreConstant(entry, event.target.checked),
                  }),
                  '常驻',
                ]),
                h('span', { key: 'actions', className: 'row rowactions' }, [
                  h('button', { key: 'edit', className: 'tiny', disabled: Boolean(busy), onClick: () => void beginLore(entry) }, '编辑'),
                  h('button', { key: 'delete', className: 'iconbtn', disabled: Boolean(busy), title: `删除 ${entry.title}`, onClick: () => void deleteLoreEntry(entry.title) }, '×'),
                ]),
              ]));
            }))
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
            // 角色索引：常驻的紧凑名单（brief / always）。缺条目时按名字现建一条。
            const idx = Array.isArray(draft.characterIndex) ? draft.characterIndex : [];
            const idxEntry = idx.find((e) => String(e?.name ?? '') === String(c.name ?? '')) ?? null;
            // 进阶字段（设定层）：列表里不展开，只报「填了几项」——完整字段在大浮窗里改
            const filled = ['personality', 'speech', 'behavior', 'first_mes', 'mes_example', 'relations']
              .filter((f) => String(c[f] ?? '').trim());
            // 立绘：**只有生成出来的**才挂在角色行上（当小头像用）。
            // 卡面不是角色的立绘 —— 它现在是「世界设定」旁边那张封面。
            //
            // 版面（用户重新设计的要求）：**一行 = 小头像 + 名称 + 简介 + 标记 + 操作**。
            // 早先「有图就两列、图在左 150×200」会把那一行撑成三倍高（截图里「桐人」就是），
            // 而且旁边的「大图 / 收起」里的「收起」其实会**把立绘从会话配置里删掉** ——
            // 点完就真的看不到了。现在：头像固定 36px、不提供「收起」，
            // 删立绘挪到编辑浮窗里（那里本来就摆着大图，删之前看得见）。
            const shownUrl = portrait?.url || '';
            const faceLabel = shownUrl
              ? `立绘${portrait?.style ? ` · ${portrait.style}` : ''}`
              : '';
            const face = h('div', {
              key: 'face', className: 'charavatar', title: faceLabel || '还没有立绘（点「立绘」生成）',
            }, shownUrl
              ? h('img', { key: 'i', src: shownUrl, alt: `${pkey} 立绘`, loading: 'lazy' })
              : h('span', { key: 'ph', className: 'charavatar-ph' }, (pkey || '?').slice(0, 1)));
            return h('div', { key: `c${i}`, className: 'charbox', 'data-hasface': shownUrl ? 'true' : 'false' }, [
              face,
              h('div', { key: 'body', className: 'charbody' }, [
                // 默认**只占一行**（§6）：头像 / 名称 / 索引简介 / 标记 / 编辑 / 立绘 / 删除。
                // 完整 8 字段搬进共享大浮窗 —— 5 个角色就把面板撑满的版面问题就是这么来的。
                h('div', { key: 'line', className: 'charline' }, [
                  h('span', { key: 'n', className: 'charsum-name', title: pkey || '（未命名）' },
                    pkey || '（未命名）'),
                  h('span', { key: 'b', className: 'dim charsum-brief', title: idxEntry?.brief || String(c.appearance ?? '') },
                    idxEntry?.brief || String(c.appearance ?? '') || '（无简介）'),
                  h('span', { key: 'tags', className: 'row charstatus' }, [
                    filled.length
                      ? h('span', { key: 'f', className: 'badge', title: `已填：${filled.join('、')}` }, `${filled.length}/6 已填`)
                      : h('span', { key: 'f', className: 'badge warn', title: '只有名字，扮演会不稳' }, '空壳'),
                    idxEntry?.always === true
                      ? h('span', { key: 'a', className: 'badge', title: '完整设定每轮都注入（主角用）' }, '常驻展开') : null,
                  ]),
                  h('span', { key: 'actions', className: 'row rowactions' }, [
                    h('button', {
                      key: 'edit', className: 'tiny', disabled: Boolean(busy),
                      onClick: () => beginCharacter(c, i, false),
                    }, '编辑'),
                    h('button', {
                      key: 'p', className: 'tiny',
                      // 出图期间禁用：避免同时再发一张（每次 ~18 秒，且都排同一个 ComfyUI 队列）
                      disabled: Boolean(busy),
                      onClick: () => runPortrait(c),
                    }, busy === `portrait:${pkey}` ? '出图中…' : '立绘'),
                    h('button', {
                      key: 'd', className: 'iconbtn', title: `删除 ${pkey || '这个角色'}`,
                      onClick: () => {
                        // 删角色时顺手清掉它的立绘（否则会话配置里会留一条孤儿记录）
                        if (pkey) clearPortrait(pkey);
                        patch({ characters: chars.filter((_, j) => j !== i) });
                      },
                    }, '×'),
                  ]),
                ]),
              ]),
            ]);
          }),
          // 角色**不再从这里手加**（用户要求：只通过 DM 添加）—— 面板手加出来的空壳角色
          // 既没有设定也没立绘，还要 DM 再补一遍；统一让 DM 用 rp_character 建，
          // 导入卡时也会自动写入。这里只留一行说明。
          h('div', { key: 'addhint', className: 'dim' },
            '角色由 DM 用 `rp_character` 添加/修改（导入角色卡时自动写入）；这里只能编辑、配立绘或删除。'),        ]),

        // 资源库：本会话出过/导入的图都在这儿。**没有图时整张卡片不渲染**（空图墙只是噪音）。
        // 分类由宿主给（`assets.kinds`），界面不自己维护一份映射。
        (assets && assets.total > 0) || assetQuery || assetKind
          ? h('div', { key: 'assets', className: 'card' }, [
            h('div', { key: 'h', className: 'row' }, [
              h('h4', { key: 't' }, `资源库（${Object.values(assets?.counts ?? {}).reduce((a, b) => a + Number(b || 0), 0)}）`),
              h('span', { key: 'd', className: 'dim' }, 'DM 出过的图与导入的图；DM 也能用 rp_assets 查到同一批'),
            ]),
            h('div', { key: 'bar', className: 'assetbar' }, [
              // 「全部」报的是**库里的总数**（各类之和），不是本次筛选命中的条数 ——
              // 否则点了「场景」之后「全部」会跟着变成 1，看着像图丢了一样。
              h('button', {
                key: 'all', className: assetKind === '' ? 'tiny on' : 'tiny',
                onClick: () => { setAssetKind(''); void refreshAssets('', assetQuery); },
              }, `全部 ${Object.values(assets?.counts ?? {}).reduce((a, b) => a + Number(b || 0), 0)}`),
              ...((assets?.kinds ?? []).filter((k) => k.count > 0).map((k) => h('button', {
                key: k.key, className: assetKind === k.key ? 'tiny on' : 'tiny',
                onClick: () => { setAssetKind(k.key); void refreshAssets(k.key, assetQuery); },
              }, `${k.label} ${k.count}`))),
              h('input', {
                key: 'q', type: 'search', className: 'assetq', value: assetQuery,
                placeholder: '搜名字 / 标签 / 角色',
                onChange: (e) => {
                  const v = e.target.value;
                  setAssetQuery(v);
                  void refreshAssets(assetKind, v);
                },
              }),
              // 导入外部图：分类用下面那个 select 选（默认场景）
              h('select', {
                key: 'ik', className: 'assetkindsel', value: assetImportKind,
                onChange: (e) => setAssetImportKind(e.target.value),
              }, [
                h('option', { key: 's', value: 'scene' }, '场景'),
                h('option', { key: 'p', value: 'portrait' }, '角色'),
                h('option', { key: 'i', value: 'item' }, '道具'),
                h('option', { key: 'o', value: 'other' }, '其他'),
              ]),
              h('label', {
                key: 'up', className: `tiny filebtn${busy ? ' disabled' : ''}`,
                title: '选一张本地图片（png / jpeg / webp，≤8MB）存进资源库',
              }, [
                busy === `asset-import:${assetImportKind}` ? '导入中…' : '导入图片',
                h('input', {
                  key: 'f', type: 'file', accept: 'image/png,image/jpeg,image/webp',
                  disabled: Boolean(busy),
                  onChange: (e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file) void importAsset(assetImportKind, file);
                  },
                }),
              ]),
            ]),
            (assets?.assets ?? []).length
              ? h('div', { key: 'grid', className: 'assetgrid' }, (assets?.assets ?? []).map((a) => h('button', {
                key: a.id, className: 'assettile', title: `${a.label || a.id}（${a.width}×${a.height}）`,
                onClick: () => setAssetEdit(a),
              }, [
                h('img', { key: 'i', src: a.previewUrl || a.url, alt: a.label || a.id, loading: 'lazy' }),
                a.label ? h('span', { key: 'l', className: 'assettile-label' }, a.label) : null,
              ])))
              : null,
            (assets?.assets ?? []).length ? null : h('div', { key: 'none', className: 'dim' }, '没有符合条件的图。'),
          ]) : null,

        // 备份：会话配置在全局数据目录、世界书与图在**工作区** —— 两处分离，手工备份必漏。
        // 这里把整个会话打成一个 zip（下载或快照），以及从文件还原。
        h('div', { key: 'backup', className: 'card' }, [
          h('div', { key: 'h', className: 'row' }, [
            h('h4', { key: 't' }, '备份 / 会话包'),
            h('span', { key: 'd', className: 'dim' },
              '一个文件带走整个会话：配置 + 世界书 + 资源库图 + 导入卡产物'),
          ]),
          h('div', { key: 'bar', className: 'backupbar' }, [
            // 下载走 <a download>：浏览器自己存盘，不经过 fetch、也不用 base64 绕一圈
            h('a', {
              key: 'dl', className: 'tiny', download: '',
              href: `/rp-tools/export?${qs({ sessionId })}`,
              title: '把本会话打成一个 zip 下载下来（含世界书与资源库里的图）',
            }, busy ? '导出' : '导出会话包'),
            h('button', {
              key: 'snap', className: 'tiny', disabled: Boolean(busy),
              title: `在会话目录里留一个恢复点（只保留最近 ${snaps?.keep ?? 5} 个）`,
              onClick: () => void takeSnapshotNow(),
            }, busy === 'snapshot' ? '快照中…' : '拍快照'),
            h('label', {
              key: 'imp', className: `tiny filebtn${busy ? ' disabled' : ''}`,
              title: '从一个会话包 zip 还原（默认不覆盖：目标有内容时会先问一句，并自动留一个恢复点）',
            }, [
              busy === 'import' ? '导入中…' : '从文件导入',
              h('input', {
                key: 'f', type: 'file', accept: 'application/zip,application/x-zip-compressed,.zip',
                disabled: Boolean(busy),
                onChange: (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void importBundleFromFile(file);
                },
              }),
            ]),
          ]),
          (snaps?.items ?? []).length
            ? h('div', { key: 'list', className: 'snaplist' }, [
              h('div', { key: 'l', className: 'dim' },
                `恢复点 ${snaps.items.length}/${snaps.keep ?? 5}（最新的在前；导入覆盖前会自动拍一个）`),
              ...snaps.items.map((s) => h('div', { key: s.name, className: 'snaprow' }, [
                h('span', { key: 'n', className: 'mono' }, String(s.name).replace(/^snapshot-|\.zip$/g, '')),
                h('span', { key: 'b', className: 'dim' }, `${Math.round(Number(s.bytes ?? 0) / 1024)}KB`),
              ])),
            ])
            : h('div', { key: 'none', className: 'dim' }, '还没有恢复点 —— 长团建议开局后拍一个。'),
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
          // 队伍成员：状态 / 能力技能 / 持有装备 / 伤病 / 目标，一行一个人。
          // 「能力」与「持有」都是**动态值**（学到新的、换装备、用掉道具就变），
          // 所以它们在这里而不在人物卡上。
          h('div', { key: 'party' }, [
            h('div', { key: 'l', className: 'dim' }, `队伍状态（${(st.party ?? []).length} 人）—— 由 DM 用 rp_state 维护，这里可以直接改`),
            ...(st.party ?? []).map((row, i) => h('div', { key: `p${i}`, className: 'partylines' }, [
              h('span', { key: 'n' }, row.character || '（未具名）'),
              h('span', { key: 's', className: 'dim' }, row.status ? `状态：${row.status}` : ''),
              row.abilities ? h('span', { key: 'ab', className: 'dim' }, `能力：${row.abilities}`) : null,
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

        // 「生图配置（本会话）」这块**已经合并到面板最上面的「本会话生图」**：
        // 默认风格、试出/预览、自动配图开关都在那里。这里不再重复一份 ——
        // 两份同一个 draft 字段时，用户在下面改了、上面那份看起来没动，很容易以为没生效。
        h('div', { key: 'style-note', className: 'dim' },
          `提示词前缀 / 风格备注 / 战役名由 DM 用 rp_session 工具维护${draft.campaign?.name ? `（当前战役：${draft.campaign.name}）` : ''}`),

        // ── 共享大浮窗（§6）：世界书 / 角色卡 / DM 设定三处编辑都走它 ──────────
        // 列表里只留单行摘要，完整字段、正文与立绘都在这里改；portal 到 document.body，
        // 所以右侧栏再窄也不会把表单挤变形。
        dmEdit ? h(SharedPortalModal, {
          key: 'dm-edit',
          title: 'DM 设定',
          dirty: dmEdit.dirty === true,
          onClose: () => confirmEditorClose(dmEdit.dirty === true, () => setDmEdit(null)),
          footer: [
            h('span', { key: 'h', className: 'dim' }, `改完点「应用」，再点面板顶部「保存」落盘　·　${dmEdit.prompt.length} 字`),
            h('span', { key: 's', className: 'sep' }),
            h('button', { key: 'ok', className: 'primary', onClick: applyDmEdit }, '应用'),
            h('button', { key: 'x', className: 'tiny', onClick: () => confirmEditorClose(dmEdit.dirty === true, () => setDmEdit(null)) }, '关闭'),
          ],
        }, [
          h('div', { key: 'f', className: 'dmeditform' }, [
            h('label', { key: 'l' }, 'DM 自己的规则（写进系统提示的【本会话设定】，每轮都在）'),
            h('div', { key: 'd', className: 'dim' },
              '这里放的是「这个 DM 怎么带团」：扮演哪些角色、叙述人称、裁决风格、禁忌。不是某个角色的设定 —— 角色请放人物卡。'),
            h('textarea', {
              key: 't', className: 'dmtext', value: dmEdit.prompt,
              placeholder: '例如：扮演除玩家以外的所有角色；第二人称叙述；不替玩家做决定；判定用 rp_random…',
              onChange: (e) => patchDmEdit(e.target.value),
            }),
          ]),
        ]) : null,

        loreEdit ? h(SharedPortalModal, {
          key: 'lore-edit',
          title: loreEdit.isNew ? '新建世界书条目' : `编辑条目：${loreEdit.title}`,
          dirty: loreEditDirty,
          onClose: () => confirmEditorClose(loreEditDirty, () => { setLoreEdit(null); setLoreEditDirty(false); }),
          footer: [
            h('span', { key: 'h', className: 'dim' }, `正文 ${String(loreEdit.body ?? '').length} 字　·　保存后写入本会话世界书`),
            h('span', { key: 's', className: 'sep' }),
            loreEdit.isNew ? null : h('button', {
              key: 'del', className: 'tiny', disabled: Boolean(busy),
              onClick: () => {
                if (!window.confirm(`删除条目「${loreEdit.title}」？`)) return;
                setLoreEdit(null);
                void deleteLoreEntry(loreEdit.title);
              },
            }, '删除条目'),
            h('button', {
              key: 'ok', className: 'primary lore-save', disabled: Boolean(busy),
              onClick: () => void saveLoreEdit(),
            }, busy === 'lore-save' ? '保存中…' : '保存'),
            h('button', {
              key: 'x', className: 'tiny',
              onClick: () => confirmEditorClose(loreEditDirty, () => { setLoreEdit(null); setLoreEditDirty(false); }),
            }, '关闭'),
          ],
        }, [
          h('div', { key: 'f', className: 'loreform' }, [
            nameConflictWarn
              ? h('div', { key: 'dup', className: 'msg dupwarn' }, `⚠ ${nameConflictWarn}`)
              : null,
            h('label', { key: 't1' }, '标题（也是默认触发词）'),
            h('input', {
              key: 't2', type: 'text', value: loreEdit.title, placeholder: '如：广寒宫 / 当前进度',
              onChange: (e) => patchLoreEdit({ title: e.target.value }),
            }),
            h('label', { key: 'k1' }, '触发词（逗号分隔）—— 留空就用标题当触发词'),
            h('input', {
              key: 'k2', type: 'text', value: loreEdit.keysText, placeholder: '广寒宫, 祝婉宁',
              onChange: (e) => patchLoreEdit({ keysText: e.target.value }),
            }),
            h('div', { key: 'k3', className: 'row' }, [
              h('label', { key: 'c1', className: 'dim' }, [
                h('input', {
                  key: 'c2', type: 'checkbox', checked: loreEdit.constant === true,
                  onChange: (e) => patchLoreEdit({ constant: e.target.checked }),
                }),
                '常驻（不看触发词）',
              ]),
              h('label', { key: 'o1', className: 'dim' }, [
                'order ',
                h('input', {
                  key: 'o2', type: 'number', value: String(loreEdit.order ?? 0), style: { width: '72px' },
                  onChange: (e) => patchLoreEdit({ order: e.target.value }),
                }),
              ]),
              h('label', { key: 'p1', className: 'dim' }, [
                '触发概率 ',
                h('input', {
                  key: 'p2', type: 'number', min: '0', max: '100', value: String(loreEdit.probability ?? 100), style: { width: '72px' },
                  onChange: (e) => patchLoreEdit({ probability: e.target.value }),
                }),
              ]),
            ]),
            h('label', { key: 'b1' }, '正文'),
            h('textarea', {
              key: 'b2', className: 'lorebody', value: loreEdit.body ?? '',
              placeholder: '这条被触发时注入的内容。状态/历史类信息建议改用 rp_state，别写成常驻。',
              onChange: (e) => patchLoreEdit({ body: e.target.value }),
            }),
          ]),
        ]) : null,

        // 资源详情：大图 + 改名/标签 + 三个动作（显示到对话 / 设成某角色的立绘 / 删除）。
        // **不自动保存改名** —— 和图鉴那两处一样要点「保存」，避免打字打到一半就被写盘。
        assetEdit ? h(SharedPortalModal, {
          key: 'asset-view',
          title: assetEdit.label || `资源 ${assetEdit.id}`,
          onClose: () => setAssetEdit(null),
          footer: [
            h('span', { key: 'h', className: 'dim' }, '删除会连磁盘上的图一起删掉（不可撤销）'),
            h('span', { key: 's', className: 'sep' }),
            h('button', { key: 'x', className: 'tiny', onClick: () => setAssetEdit(null) }, '关闭'),
          ],
        }, [
          h('div', { key: 'f', className: 'assetview' }, [
            h('div', { key: 'pic', className: 'assetpic' }, [
              h('img', { key: 'i', src: assetEdit.url, alt: assetEdit.label || '资源图' }),
            ]),
            h('div', { key: 'meta', className: 'assetmeta' }, [
              h('div', { key: 'k', className: 'row' }, [
                h('span', { key: 'b', className: 'badge' },
                  (assets?.kinds ?? []).find((k) => k.key === assetEdit.kind)?.label ?? assetEdit.kind),
                assetEdit.width && assetEdit.height
                  ? h('span', { key: 'wh', className: 'dim' }, `${assetEdit.width}×${assetEdit.height}`) : null,
                h('span', { key: 'by', className: 'dim' }, `${Math.round(Number(assetEdit.bytes ?? 0) / 1024)}KB · ${assetEdit.source === 'imported' ? '导入' : '生成'}`),
                assetEdit.group ? h('span', { key: 'g', className: 'dim', title: '同一幕的多格' }, `组 ${assetEdit.group}`) : null,
              ]),
              h('label', { key: 'l1' }, '名称'),
              h('input', {
                key: 'l2', type: 'text', value: assetMetaDraft.label, placeholder: '给这张图起个好找的名字',
                onChange: (e) => setAssetMetaDraft({ ...assetMetaDraft, label: e.target.value }),
              }),
              h('label', { key: 't1' }, '标签'),
              h('input', {
                key: 't2', type: 'text', value: assetMetaDraft.tags, placeholder: '逗号分隔，如「客栈,雨夜,室内」',
                onChange: (e) => setAssetMetaDraft({ ...assetMetaDraft, tags: e.target.value }),
              }),
              h('button', {
                key: 'sv', className: 'tiny primary', disabled: Boolean(busy),
                onClick: () => void saveAssetMeta(assetEdit, assetMetaDraft.label, assetMetaDraft.tags),
              }, busy === `asset-save:${assetEdit.id}` ? '保存中…' : '保存名称与标签'),
              h('div', { key: 'hr1', className: 'sep' }),
              assetEdit.characters?.length
                ? h('div', { key: 'cs', className: 'dim' }, `画面里的角色：${assetEdit.characters.join('、')}`) : null,
              assetEdit.prompt ? h('div', { key: 'pr', className: 'dim assetprompt' }, `提示词：${assetEdit.prompt}`) : null,
              h('button', {
                key: 'show', className: 'tiny', disabled: Boolean(busy),
                title: '把这张图拼成一段 dsh-ui 围栏填进输入框（由你确认后发送）',
                onClick: () => showAssetInChat(assetEdit),
              }, '显示到对话'),
              h('div', { key: 'pr1', className: 'row' }, [
                h('select', {
                  key: 'sel', value: assetPortraitTarget,
                  onChange: (e) => setAssetPortraitTarget(e.target.value),
                }, [
                  h('option', { key: '', value: '' }, '设为某角色的立绘…'),
                  ...chars.map((c) => {
                    const n = String(c?.name ?? '').trim();
                    return n ? h('option', { key: n, value: n }, n) : null;
                  }),
                ]),
                h('button', {
                  key: 'go', className: 'tiny', disabled: Boolean(busy) || !assetPortraitTarget,
                  onClick: () => void useAssetAsPortrait(assetEdit, assetPortraitTarget),
                }, busy === `asset-portrait:${assetEdit.id}` ? '设置中…' : '设为立绘'),
              ]),
              h('div', { key: 'hr2', className: 'sep' }),
              h('button', {
                key: 'del', className: 'tiny', disabled: Boolean(busy),
                title: '删掉这张图（连磁盘文件一起）。如果它正被当成某个角色的立绘，那条引用也会解除。',
                onClick: () => { if (window.confirm(`删掉「${assetEdit.label || assetEdit.id}」？磁盘上的图也会删掉。`)) void deleteAsset(assetEdit); },
              }, busy === `asset-del:${assetEdit.id}` ? '删除中…' : '删除这张图'),
            ]),
          ]),
        ]) : null,

        charEdit ? h(SharedPortalModal, {
          key: 'char-edit',
          title: charEdit.isNew ? '新建角色' : `编辑角色：${charEdit.originalName || charEdit.character?.name || '（未命名）'}`,
          dirty: charEdit.dirty === true,
          onClose: () => confirmEditorClose(charEdit.dirty === true, () => setCharEdit(null)),
          footer: [
            h('span', { key: 'h', className: 'dim' }, '改完点「应用」，再点面板顶部「保存」落盘'),
            h('span', { key: 's', className: 'sep' }),
            h('button', { key: 'ok', className: 'primary', onClick: applyCharacterEdit }, '应用'),
            h('button', { key: 'x', className: 'tiny', onClick: () => confirmEditorClose(charEdit.dirty === true, () => setCharEdit(null)) }, '关闭'),
          ],
        }, [
          h('div', { key: 'f', className: 'chareditform' }, [
            // 左列：立绘（纵向、尽量占满这一列的宽/高；窄屏落到上方）。
            // 按钮集中在这里：生成立绘是**纵向**的（宿主 sizeKey=portrait），所以图比场景图高，
            // 这一列才填得满。「看大图」已去掉（用户要求）—— 图在这里就是最大的那个尺寸。
            h('div', { key: 'face', className: 'facepreview' }, [
              charEditPortraitUrl
                ? h('img', { key: 'i', src: charEditPortraitUrl, alt: '立绘' })
                : h('div', { key: 'none', className: 'dim faceempty' },
                  '还没有立绘 —— 点下面的「生成立绘」，或直接导入一张现成的图'),
              h('div', { key: 'c', className: 'dim facecap' }, charEditPortraitUrl
                ? `「${charEditFaceKey || '（未命名）'}」的立绘${charEditPortraitStyle ? `（${charEditPortraitStyle}）` : ''}。重新生成会覆盖这张；不想抽卡就直接导入一张图。`
                : '立绘按角色名保存；改名后旧立绘不会自动跟过来，重新生成一次即可。'),
              h('div', { key: 'a', className: 'row facerow' }, [
                h('button', {
                  key: 'g', className: 'tiny', disabled: Boolean(busy) || !charEditName,
                  title: charEditPortraitUrl
                    ? '按这个角色的名字与外貌重新出一张纵向立绘（会覆盖现在这张）'
                    : '按这个角色的名字与外貌出一张纵向立绘',
                  onClick: () => void runPortrait(charEdit.character),
                }, busy === `portrait:${charEditFaceKey}` ? '出图中…' : (charEditPortraitUrl ? '重新生成' : '生成立绘')),
                // 外部导入（用户要求）：对生成结果不满意时不必反复抽卡，直接用现成的图。
                // 走隐藏的 file input + data URL：浏览器不能把本地路径交给宿主。
                h('label', {
                  key: 'u', className: `tiny filebtn${busy ? ' disabled' : ''}`,
                  title: '选一张本地图片（png / jpeg / webp，≤8MB）作为这个角色的立绘',
                }, [
                  '导入图片',
                  h('input', {
                    key: 'f', type: 'file', accept: 'image/png,image/jpeg,image/webp',
                    disabled: Boolean(busy) || !charEditName,
                    onChange: (e) => {
                      const file = e.target.files?.[0];
                      // 清 value：连着选同一个文件也要能再触发一次 onChange
                      e.target.value = '';
                      if (file) void importPortrait(charEdit.character, file);
                    },
                  }),
                ]),
              ]),
            ]),
            // 右列：字段（label + 控件两列对齐）
            h('div', { key: 'fields', className: 'charfields' }, [
              h('label', { key: 'n1' }, '名称'),
              h('input', {
                key: 'n2', type: 'text', value: charEdit.character?.name ?? '', placeholder: '角色名',
                onChange: (e) => patchCharacterEdit('name', e.target.value),
              }),
              h('label', { key: 'a1' }, '外貌（生图时自动补进提示词）'),
              h('textarea', {
                key: 'a2', value: charEdit.character?.appearance ?? '', placeholder: '可观察的外形特征：发色、服饰、体态、标志物',
                onChange: (e) => patchCharacterEdit('appearance', e.target.value),
              }),
              h('label', { key: 'p1' }, '性格'),
              h('textarea', {
                key: 'p2', value: charEdit.character?.personality ?? '', placeholder: '表层 → 深层 → 矛盾点，以及对待玩家的基本态度',
                onChange: (e) => patchCharacterEdit('personality', e.target.value),
              }),
              h('label', { key: 's1' }, '说话方式'),
              h('textarea', {
                key: 's2', value: charEdit.character?.speech ?? '', placeholder: '可观察的量化特征，如「句子短、爱用反问、管玩家叫小子」',
                onChange: (e) => patchCharacterEdit('speech', e.target.value),
              }),
              h('label', { key: 'b1' }, '行为习惯'),
              h('textarea', {
                key: 'b2', value: charEdit.character?.behavior ?? '', placeholder: '紧张时做什么、面对威胁的第一反应……',
                onChange: (e) => patchCharacterEdit('behavior', e.target.value),
              }),
              h('label', { key: 'r1' }, '人物关系'),
              h('textarea', {
                key: 'r2', value: charEdit.character?.relations ?? '', placeholder: '与其他角色的关系，如「祁俊的师父，亦师亦母」',
                onChange: (e) => patchCharacterEdit('relations', e.target.value),
              }),
              h('label', { key: 'f1' }, '开场白 / 文风范本'),
              h('textarea', {
                key: 'f2', value: charEdit.character?.first_mes ?? '', placeholder: '该角色初次登场的原文 —— 最有效的文风锚点（注入时取前 300 字）',
                onChange: (e) => patchCharacterEdit('first_mes', e.target.value),
              }),
              h('label', { key: 'm1' }, '对话范例'),
              h('textarea', {
                key: 'm2', value: charEdit.character?.mes_example ?? '', placeholder: '2~4 轮，格式「角色名：台词」',
                onChange: (e) => patchCharacterEdit('mes_example', e.target.value),
              }),
              h('label', { key: 'i1' }, '索引简介'),
              h('input', {
                key: 'i2', type: 'text', value: charEdit.indexEntry?.brief ?? '',
                placeholder: '常驻显示的一句话（默认取外观首句）',
                onChange: (e) => patchCharacterIndex('brief', e.target.value),
              }),
              h('label', { key: 'w1' }, '常驻展开'),
              h('label', { key: 'w2', className: 'dim charalways' }, [
                h('input', {
                  key: 'w3', type: 'checkbox', checked: charEdit.indexEntry?.always === true,
                  onChange: (e) => patchCharacterIndex('always', e.target.checked),
                }),
                '完整设定每轮都注入（主角用；不勾则只在它出场的那几轮）',
              ]),
            ]),
          ]),
        ]) : null,
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
      return h(RpSessionOverlay, {
        sessionId, variant: 'embed',
        // 把槽位这几件「会话相关」的道具透传下去：面板里的诊断行要读界面侧的预设/开局状态，
        // 拿来和宿主答复对照（导入入口的可见性历史上就栽在这两个值不一致上）。
        useSessions: props?.useSessions, useInput: props?.useInput, inputActions: props?.inputActions,
      });
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
      /**
       * 「RP 面板」这个右栏页签类型**只在 DM 会话存在**。
       *
       * 非 DM 时把它撤掉，否则右栏展开的引导页会在每个会话都列着「🎲 RP 跑团面板」
       * ——引导页列的是所有已注册类型，而类型注册是应用级的（不按会话）。
       * 由这个组件驱动是有意的：它是本会话「是不是 DM」的唯一判定点（闸门 + 预设订阅
       * 都在 useDmSession 里），而且它本身就是 RP 面板唯一的入口 —— 它没挂载时，
       * 面板本来也打不开。
       */
      React.useEffect(() => (isDm ? acquireRpSidebarTab() : undefined), [isDm]);
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
     * 预设切换的订阅者（每实例一个）：宿主广播 `agent-preset/selected` 时全部叫醒。
     *
     * 这是「新对话切预设 → 按钮状态要重新判断」的唯一可靠触发源：客户端那份投影
     * 在被切走之后**可能不再更新**（官方 chip 自己持有 staged 值所以看起来是对的），
     * 组件入参一个都不变 → 不重渲染 → 按钮再也回不来，只有刷新页面才行。
     */
    const presetChangeListeners = new Map();

    /** 宿主的闸门答复缓存：键里带 presetRev，所以切预设后旧答复自动作废（见 notifyPresetChange）。 */
    const gateCache = new Map();

    /** 宿主切了预设：丢掉所有闸门答复，再叫醒订阅者（订阅者自己重算并重渲染）。 */
    function notifyPresetChange() {
      gateCache.clear();
      for (const listener of [...presetChangeListeners.values()]) {
        try { listener(); } catch { /* 单个订阅者出错不影响其它 */ }
      }
    }

    /** 闸门缓存的键：会话 + 已知的投影值（这些值一变就重新问一次宿主）。 */
    const gateKeyOf = (sessionId, blank, preset) => `${sessionId}|${blank === false ? 'started' : blank === true ? 'blank' : 'unknown'}|${preset}`;

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
      // 两种挂法共用同一套逻辑与界面：
      //   dock  —— 工作区那一行的 chip（只在未开局的 DM 新会话上出现，见下面的可见性判定）
      //   embed —— 挂在 RP 面板里（会话进行中也能导入）。**这是入口的保底通道**：
      //            chip 的可见性依赖投影/宿主两侧的判定，历史上两度因为那两侧不一致而消失，
      //            面板里的这条只要你在 DM 会话里就一定能打开（头部 🎲 RP 入口是另一条独立判定）。
      const embedMode = props?.variant === 'embed';
      // 异步回调里要拿到最新 props（React 的闭包会留住旧值）
      const propsRef = React.useRef(props);
      propsRef.current = props;
      // 卡库默认 <工作区>/rp-cards，所以请求卡库/卡面时要带上会话的 cwd（见 live.current.cwd）

      // 一律选**原始值**（对象选择器会在每次 store 变更时产生新引用 → 无限重渲染）
      const currentId = typeof props?.useSessions === 'function' ? props.useSessions((s) => s?.current) : undefined;
      const sessionId = [props?.sessionId, currentId, props?.session?.id].find((v) => typeof v === 'string' && v !== '') || '';
      // 摘要里的 blank：**只把明确的 false 当「已开局」**。之前写成 `=== true`，
      // 于是摘要还没到（重挂载后那一瞬）就被当成「不是新会话」→ 入口闪一下就没。
      const blankRaw = typeof props?.useSessions === 'function'
        ? props.useSessions((s) => (sessionId ? s?.byId?.[sessionId]?.blank : undefined))
        : undefined;
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
      // 客户端的判据只当**快速路径**：投影可能被重建清空（见下面 gate 的注释）。
      const storeDm = agentPreset === 'dm';
      const storeStarted = blankRaw === false;
      // ★ 预设切换的重新判断：宿主每次切预设都会 append `agent-preset/selected` 并广播同名事件，
      //   客户端用 `ctx.remote.$on('agent-preset/selected')` 收得到（见 apply 里的订阅）。
      //   这个计数进 key：事件一来 key 就变，闸门答复作废并**重新问一次宿主**。
      //   为什么必须这样：首屏选 dm → 切走 → 切回 dm，客户端那份投影**可能根本没更新**
      //   （官方那枚 chip 显示正确是因为它自己持有 staged 值），于是组件的入参一个都没变、
      //   也不会重渲染 —— 只有刷新页面才会重读。用户报的「切回 dm 按钮不见了，刷新才回来」
      //   就是这条：**值是对的，判断没有重跑**。
      const [presetRev, setPresetRev] = React.useState(0);
      const gateKey = `${gateKeyOf(sessionId, blankRaw, agentPreset)}|${presetRev}`;
      // 订阅「预设变了」：清掉闸门缓存（notifyPresetChange 里做）并重算一次
      React.useEffect(() => {
        const key = Symbol('rp-preset');
        const listener = () => { setPresetRev((n) => n + 1); };
        presetChangeListeners.set(key, listener);
        return () => { presetChangeListeners.delete(key); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      // 闸门答复**带键存**：键一变（切预设 / 摘要刷新）旧答复立刻作废，
      // 直到新答复回来为止都用投影快速路径 —— 否则会拿着上个会话状态的答案做决定。
      const [gateState, setGateState] = React.useState(() => {
        const cached = gateCache.get(gateKey);
        return cached ? { key: gateKey, value: cached } : null;
      });
      const gateKeyRef = React.useRef('');
      React.useEffect(() => {
        if (!sessionId) return undefined;
        gateKeyRef.current = gateKey;
        const cached = gateCache.get(gateKey);
        if (cached) { setGateState({ key: gateKey, value: cached }); return undefined; }
        let alive = true;
        API.gate(sessionId)
          .then((res) => {
            if (!res?.ok) return;
            const value = { dm: res.dm === true, started: res.started === true };
            gateCache.set(gateKey, value);
            if (alive && gateKeyRef.current === gateKey) setGateState({ key: gateKey, value });
          })
          .catch(() => { /* 拿不到就继续用投影快速路径 */ });
        return () => { alive = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [sessionId, blankRaw, agentPreset]);
      const gate = gateState && gateState.key === gateKey ? gateState.value : null;
      // 两个来源各说一半时**都往「显示」那边靠**：
      //  · dm  ：任一来源说是 dm 就算 dm（客户端投影会被切预设清空，宿主投影也可能落后）
      //  · 开局：只有两个来源**都**说已开局才收起入口
      // 方向是刻意的 —— 入口少显示一次，用户就再也找不回来（这正是他报的 bug）；
      // 多显示一次最坏是点进去发现要新建会话，导入流程自己会处理那条路。
      const dmNow = gate ? (gate.dm || storeDm) : storeDm;
      const startedNow = gate ? (gate.started && storeStarted) : storeStarted;
      const unstarted = !startedNow;
      const draftText = typeof props?.useInput === 'function' ? props.useInput((s) => s?.draft ?? '') : '';
      // 最新值放一份在 ref 里：startSession 之后的那次导入要用**新会话**的 cwd
      const live = React.useRef({});
      live.current = { sessionId, blank: unstarted, cwd, agentPreset, dm: dmNow };
      // 卡库/卡面请求要用同一个 cwd（propsRef 在异步回调里是唯一能取到最新值的地方）
      propsRef.current = { ...props, _cwd: cwd };

      const [open, setOpen] = React.useState(embedMode);   // embed 模式常开（面板里已经由外层收起/展开）
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
      // 宏行（导入表单用）：只列**卡里真出现**的宏名 + user，值用设置页「默认宏列表」预填。
      // 名字不可改、也不提供增删 —— 它来自卡里的占位符，多一行少一行都会和卡对不上；
      // 想预设更多默认值就去设置页的「默认宏列表」加（那边的名字可以改）。
      const [macroRows, setMacroRows] = React.useState([{ name: 'user', value: '' }]);
      // 设置页那份默认宏列表（`config.cards.macros`）：只当**预填值**用；会话里填过的以会话为准
      const [globalMacros, setGlobalMacros] = React.useState({});
      const globalMacrosRef = React.useRef({});
      globalMacrosRef.current = globalMacros;
      const setMacroRow = (i, value) => setMacroRows((rows) => rows.map((r, j) => (j === i ? { ...r, value } : r)));
      /** 卡预览回来后，用「卡里扫到的宏名」重建行（已经填过的值保留）。 */
      function applyDiscoveredMacros(found, macrosOverride) {
        const defaults = macrosOverride ?? globalMacrosRef.current ?? {};
        setMacroRows((rows) => {
          const byName = new Map(rows.map((r) => [r.name, r.value]));
          const names = ['user', ...(found ?? []).map((m) => m.name).filter((n) => n !== 'user')];
          const autoSet = new Set((found ?? []).filter((m) => m.auto).map((m) => m.name));
          return names.map((name) => ({
            name,
            auto: autoSet.has(name),
            // 默认值来自设置页的「默认宏列表」（user 也在里面）；用户填过的保留。
            // ⚠️ 空串要当「还没填」——初始那行 `{name:'user', value:''}` 否则会把默认值顶掉。
            value: String(byName.get(name) ?? '').trim() || String(defaults[name] ?? ''),
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

      /** 拉一次设置页的默认宏列表（导入表单的预填值来源；拿不到就只填空）。 */
      async function loadGlobalMacros() {
        try {
          const st = await API.state();
          const raw = st?.config?.cards?.macros;
          const macs = raw && typeof raw === 'object' ? { ...raw } : {};
          // 老配置只有 userLabel：把它当 user 的默认值（宿主侧也会这么迁）
          const label = String(st?.config?.cards?.userLabel ?? '').trim();
          const merged = label && !macs.user ? { ...macs, user: label } : macs;
          setGlobalMacros(merged);
          return merged;
        } catch { return globalMacrosRef.current ?? {}; }
      }

      React.useEffect(() => {
        if (open && Object.keys(globalMacros).length === 0) void loadGlobalMacros();
        if (open && lib === null) void load('');
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [open]);

      // 新建会话后接手导入：等它成为当前会话、且还没开局
      React.useEffect(() => {
        const job = pendingImport;
        if (!job) return;
        if (!sessionId || !unstarted) return;
        pendingImport = null;
        void runImport(sessionId, job);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [pendingTick, sessionId, unstarted]);

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
          // 卡库默认在会话工作区下的 rp-cards/ → sessionId（优先）+ cwd 一起报上去
          const res = await API.cards({ q: query, category: cat, limit: 60, workspace: await ensureCwd(), sessionId: live.current.sessionId });
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
          const res = await API.card(cardPath, { workspace: await ensureCwd(), sessionId: live.current.sessionId });
          if (!res?.ok) throw new Error(res?.error ?? '解析失败');
          setPreview(res);
          // 先取回默认宏列表再建行：否则预填用的是上一次的旧值（刚在设置页改过就白改）
          const defaults = await loadGlobalMacros();
          applyDiscoveredMacros(res.macros, defaults);
        } catch (error) {
          setMsg({ kind: 'err', text: String(error?.message ?? error) });
        } finally { setBusy(''); }
      }

      /** 把当前会话的预设切成 dm。切不动时返回说明而不是抛错 —— 导入本身仍然该继续。 */
      async function selectDmPreset(targetId) {
        // 已经是 dm 就别再切：切换会重新组装一遍 agent 作用域并追加一条事件，没必要。
        // 判据用闸门解析过的 `dm`，不用 store 里的 `agentPreset` —— 后者会被切预设清空
        // （那正是「切走再切回 dm 入口消失」的同一条根因），清空后会误判成「需要切一次」。
        if (live.current.dm) return { ok: true, preset: 'dm', note: '本来就在 dm 预设' };
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
            // DM（旁白）卡：内容进了本会话的「DM 设定」，不建角色 —— 说清楚免得去角色卡里找
            res.isDmCard === true ? '这是一张 DM（旁白）卡 → 已写进本会话「DM 设定」，没建角色卡'
              // 故事书（卡里没有角色字段）不建人物，说清楚免得用户去面板里找不到
              : res.isCharacterCard === false ? '卡里没有角色描述/性格 → 没建角色卡（封面已放到世界设定旁）' : '',
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

      // 入口要待在「工作区 / DM 主持人」那一行上，而不是自己占一行。
      // 那一行的两个座位（`conversation.hero.workspace` / `conversation.hero.agentPreset`）
      // 都是 **single 且已被官方插件占满**，没有第三个槽位可注册 ——
      // 所以只能在 DOM 上想办法：**优先**用 portal 把 chip 送进那一行（它是 flex 行，
      // 送进去就是正经的第三个 chip）；拿不到 react-dom（或找不到那一行）时退回
      // 「量出那一行的位置、把 chip 固定在它右边」，最差也只是自己占一行，不会消失。
      //
      // ⚠️ 这两个 hook 必须在**早退之前**声明：早退（下面那两个 return null）会让后面的
      // hook 不再执行，等于「按条件调用 hook」—— 真实 React 下状态会错位（测试桩尤其会）。
      const rootRef = React.useRef(null);
      const [slot, setSlot] = React.useState(undefined);   // undefined=还没量 / null=找不到 / {kind,row|rect}
      React.useLayoutEffect(() => {
        if (embedMode || slot !== undefined) return;       // embed 模式不进 DOM 找那一行
        setSlot(findHeroRowSlot(rootRef.current));
      }, [slot, sessionId]);

      // 入口只在「还没开局的 DM 新会话」上出现 —— 那正是要选卡开团的时刻。
      // 导入进行中/刚导完时例外：开场指令一发出去会话就不再是空白，
      // 这时把面板藏掉会让用户看不到结果（`keep` 一直维持到用户自己收起）。
      const keepOpen = open && (busy === 'import' || result !== null);
      if (!sessionId) return null;
      // embed 模式不受「未开局的 DM 新会话」这条限制：它就在 RP 面板里，用户是主动打开的
      if (!embedMode && !(unstarted && dmNow) && !keepOpen) return null;

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
          + `${preview.stats?.emptySkipped ? `（已丢掉 ${preview.stats.emptySkipped} 条空条目：正文只有模板残留）` : ''}`
          + `｜开场白来源：${preview.character?.greetingSource === 'alternate_greetings'
            ? `备用开场白（共 ${preview.character?.greetingAlternatives} 条）`
            : preview.character?.greetingSource === 'first_mes' ? 'first_mes' : '无'}`),
        // 卡面：**只在选中这张时才加载**（列表里一张图都不请求，避免几十张几 MB 的卡同时拉）。
        // 走宿主 `thumb=1&width=420` 的服务端降采样 —— 卡 PNG 正文可能有上百万字，
        // 原图动辄几 MB，预览只需要看一眼封面。解码失败时宿主会回退原图。
        preview.path
          ? h('img', {
            key: 'face', className: 'face',
            src: cardImageUrl(preview.path, cwd, sessionId, { thumb: '1', width: '420' }),
            alt: `${preview.name} 卡面`,
            loading: 'lazy', decoding: 'async',
          })
          : null,
        // 卡里常见的占位符：这里摊开给用户看，并解释每一类**怎么被处理**（免得
        // 「我卡里的 {{user}} 怎么没了」「{{char}} 是什么」这类疑问）
        preview.placeholders?.total
          ? h('div', { key: 'ph', className: 'dim' }, [
            h('div', { key: 'c' }, `占位符：${Object.entries(preview.placeholders.counts ?? {}).map(([k, n]) => `${k}×${n}`).join('、')}`),
            h('div', { key: 'l', className: 'phlegend' },
              '{{char}} / <CHAR> 已展开成卡名；<USER> 已展开成玩家称呼；'
              + '{{user}} 与其它合法宏就是下面那些表单行（值可改）；时间/日期类每轮自动；'
              + '{{random:…}} / {{roll:…}} 导入时抽一次；名字不合法的占位符已删除。'),
          ])
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
        // ── 宏（第一次导入时让用户填）──────────────────────────────────────
        // 名字是**卡里扫到的**占位符，不可改也不可删（改了就对不上卡里的 `{{x}}`）；
        // 值从设置页「默认宏列表」预填，留空则用默认值 / 自动宏每轮现算。
        // 这些值**按会话保存**，世界书/设定里写的 `{{x}}` 由宿主变量在注入时替换，
        // 所以以后在 RP 面板里改值，已导入的文本会跟着变。
        h('div', { key: 'macros', className: 'macroblk' }, [
          h('div', { key: 'h', className: 'row' }, [
            h('span', { key: 't', className: 'mk' }, `宏（${macroRows.length}）`),
            h('span', { key: 'd', className: 'dim' },
              `值已按设置页「默认宏列表」预填（共 ${Object.keys(globalMacros).length} 条）；留空 = 用它自己那份或自动`),
          ]),
          h('div', { key: 'rows', className: 'macrorows' }, macroRows.map((row, i) => h('div', {
            key: `m${i}`, className: 'row macrorow', 'data-auto': row.auto ? 'true' : 'false',
          }, [
            h('span', { key: 'n', className: 'mono mname', title: row.auto ? '自动宏：每轮由系统按当前时间/日期填写' : `文本里的 {{${row.name}}} 会换成这里填的值` }, `{{${row.name}}}`),
            h('input', {
              key: 'v', type: 'text', value: row.value,
              placeholder: row.auto ? '留空 = 自动' : (row.name === 'user' ? '玩家' : '默认值'),
              onChange: (e) => setMacroRow(i, e.target.value),
            }),
            row.auto
              ? h('span', { key: 'a', className: 'badge ok mtag', title: '自动：装配时按当前时间/日期填写，留空即可' }, '自动')
              : (String(row.value).trim() && String(globalMacros[row.name] ?? '') === row.value
                ? h('span', { key: 'p', className: 'badge mtag', title: '这个值来自设置页的「默认宏列表」；改了就只影响本会话' }, '预设')
                : h('span', { key: 'p2', className: 'mtag' })),
          ]))),
        ]),
        h('label', { key: 'auto', className: 'cb' }, [
          h('input', { key: 'c', type: 'checkbox', checked: autoStart, onChange: (e) => setAutoStart(e.target.checked) }),
          '导入后自动开场（把开场指令发给 DM）',
        ]),
        h('div', { key: 'act', className: 'row' }, [
          h('button', { key: 'go', className: 'primary', disabled: Boolean(busy) || Boolean(pendingImport), onClick: startImport },
            busy === 'import' ? '导入中…' : (pendingImport ? '等待新会话…' : (unstarted ? '导入并开始' : '新建会话并导入'))),
          !unstarted && !dmNow
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

      // 面板主体：dock 与 embed 两种挂法共用（曾经的 chip 判定出过两次事故，
      // 所以这条通道必须在两个入口都能用）。
      const panelBody = h('div', { key: 'panel', className: 'panel' }, [
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
        ]);

      // embed：只出面板块（外面的 RP 面板负责收起/展开，也不再判定预设/开局）
      if (embedMode) return h('div', { className: 'rpc embed' }, [panelBody]);
      return h('div', { className: 'rpc', ref: rootRef }, [holder, entry, panelBody]);
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

    /**
     * 把「RP 面板」注册成右栏的一种**页签类型**（外加两个座位），返回撤销这一切的函数。
     *
     * ⚠️ 为什么必须能撤下来：右栏展开时的引导页列的是**所有已注册类型**的条目，而类型
     * 注册是**应用级**的（`tabs.register` 不按会话）—— 注册一次不撤，非 DM 会话展开右栏
     * 也会看到「🎲 RP 跑团面板」。用户报的就是这个（右侧栏 3 个选项里那个多出来的）。
     *
     * 运行中注册/撤销是宿主契约允许的：`tabs.register` 与两个 `slots.inject` 都返回
     * disposer，dsh-context 用它自己的 placement 开关做的正是同一件事。
     */
    function mountRpSidebarTab() {
      const ctx = ctxRef.current;
      if (!ctx || typeof ctx.inject !== 'function') return null;
      let disposeInject = null;
      try {
        disposeInject = ctx.inject(['sidebarRightTabs', 'sidebarRight'], (injected) => {
          const disposers = [];
          const own = (result) => { if (typeof result === 'function') disposers.push(result); };
          const release = () => {
            openRpTab = null;
            for (const dispose of disposers) { try { dispose(); } catch { /* 单个失败不影响其余 */ } }
          };
          const tabs = injected.sidebarRightTabs;
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
          if (!tabs || typeof tabs.register !== 'function') return release;
          try {
            own(tabs.register({
              id: RP_TAB_ID,
              kind: RP_TAB_KIND,
              title: () => '🎲 RP',
              guide: [{
                order: 30,
                title: () => '🎲 RP 跑团面板',
                description: () => '世界设定 / 角色卡 / 随机表 / 本会话生图配置',
              }],
            }));
          } catch (error) {
            console.warn('[rp-tools] 注册右栏页签类型失败:', error?.message ?? error);
            release();
            return undefined;
          }
          own(injected.slots.inject('sidebar.right.pane.tab', () => injected.slots.register({
            name: 'sidebar.right.pane.tab',
            key: RP_TAB_ID,
          }, (props) => h(RpSidebarTabBody, props))));
          own(injected.slots.inject('sidebar.right.pane.tab.title', () => injected.slots.register({
            name: 'sidebar.right.pane.tab.title',
            key: RP_TAB_ID,
          }, () => h(RpTabTitle))));
          return release;
        });
      } catch (error) {
        console.warn('[rp-tools] 注入右栏服务失败:', error?.message ?? error);
        return null;
      }
      return () => { try { if (typeof disposeInject === 'function') disposeInject(); } catch { /* 忽略 */ } };
    }

    /**
     * 右栏页签的全局挂载点（**引用计数**）。
     *
     * 由「当前显示的会话是不是 DM」驱动：DM 会话的头部按钮挂载时 acquire、卸载（或不再是
     * DM）时 release。引用计数是必需的 —— 万一同时挂着多个会话头部，重复注册同一个
     * `id` 会被页签注册表判为接线错误直接抛错。
     */
    let rpTabMount = null;   // { dispose, refs }
    function acquireRpSidebarTab() {
      if (!rpTabMount) {
        const dispose = mountRpSidebarTab();
        rpTabMount = { dispose: typeof dispose === 'function' ? dispose : () => {}, refs: 0 };
      }
      rpTabMount.refs += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (!rpTabMount) return;
        rpTabMount.refs -= 1;
        if (rpTabMount.refs > 0) return;
        const { dispose } = rpTabMount;
        rpTabMount = null;
        try { dispose(); } catch (error) { console.warn('[rp-tools] 撤销右栏页签失败:', error?.message ?? error); }
      };
    }

    function apply(ctx) {
      ctxRef.current = ctx;
      // 样式必须在**第一个组件渲染之前**就挂上。
      // 之前只在设置页 / 会话面板的 effect 里调用，于是首次加载时头部那个「🎲 RP」
      // 按钮先以裸 <button> 的默认外观出现（灰底方角），等某个组件挂载后才变正常 ——
      // 就是「第一次启动样式不对、后面正常」的典型 FOUC。
      injectStyles();

      // ── 订阅「预设被切换」─────────────────────────────────────────────
      // 宿主每次切预设都会 broadcast `agent-preset/selected`（在 API 的转发白名单里，
      // 客户端用 `remote.$on` 就能收到）。导入入口的可见性必须跟着它重新判断：
      // 首屏选 dm → 切走 → 切回 dm 时，客户端那份投影可能一个字节都没变，
      // 组件不重渲染，按钮就再也回不来（只有刷新页面才恢复）—— 这正是用户报的现象。
      try {
        const remote = ctx.get ? ctx.get('remote') : undefined;
        if (remote && typeof remote.$on === 'function') {
          const off = remote.$on('agent-preset/selected', notifyPresetChange);
          ctx.effect(() => () => { try { off?.(); } catch { /* 忽略 */ } }, 'rp-tools: preset listener');
        }
      } catch { /* 拿不到 remote（旧宿主）就只靠投影，功能不因此中断 */ }
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

      // 右栏页签（RP 面板本体）**不在这里注册**：它是应用级的类型注册，注册一次就会让
      // 每个会话的右栏引导页都列着「🎲 RP 跑团面板」。改由会话头部按钮按「本会话是不是 DM」
      // 挂载/撤销 —— 见 acquireRpSidebarTab 与 RpHeaderButton 里的 effect。
    }

    module.exports.name = name;
    module.exports.inject = inject;
    module.exports.apply = apply;
    return module.exports;
  },
});
