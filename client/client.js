/**
 * dsh-rp-tools client half。
 *
 *  1. settings.section「RP工具」：全局配置（ComfyUI 地址、全局负面词、全局默认风格、风格库）
 *     + 工具列表与参数说明（实时读宿主 /rp-tools/tools）。
 *  2. conversation.session.header.actions：会话头部按钮 —— **只在 DM 会话渲染**
 *     （先查 /rp-tools/session?sessionId= 的 isDm），点开是浮层面板：
 *     世界设定 / 角色卡 / 随机表 / 本会话生图配置。非 DM 会话什么都不渲染。
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
    };

    let stylesInjected = false;
    function injectStyles() {
      if (stylesInjected) return;
      stylesInjected = true;
      const el = document.createElement('style');
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
.rpt .charline { display: grid; grid-template-columns: 118px minmax(0,1fr) auto auto; gap: 6px; align-items: center; }
.rpt .tbl { display: grid; grid-template-columns: minmax(0,1fr) auto auto; gap: 6px; align-items: center; }
.rpt .ovl { position: fixed; top: 56px; right: 16px; bottom: 16px; width: 440px; max-width: calc(100vw - 32px);
  z-index: 60; overflow: auto; padding: 14px; border-radius: 12px;
  background: var(--dsh-surface, #1b1c1f); color: inherit;
  border: 1px solid color-mix(in oklab, currentColor 18%, transparent);
  box-shadow: 0 12px 40px rgba(0,0,0,.45); }
.rpt .ovlhead { display: flex; align-items: center; gap: 8px; }
`;
      document.head.appendChild(el);
    }

    // ── 设置页：RP工具（全局） ────────────────────────────────────────────
    function RpSettings() {
      const [state, setState] = React.useState(null);
      const [draft, setDraft] = React.useState(null);
      const [tools, setTools] = React.useState([]);
      const [busy, setBusy] = React.useState('');
      const [msg, setMsg] = React.useState(null);
      const [preview, setPreview] = React.useState(null);

      React.useEffect(() => { injectStyles(); void reload(); }, []);

      async function reload() {
        setBusy('load');
        try {
          const [data, toolData] = await Promise.all([API.state(), API.tools().catch(() => ({ tools: [] }))]);
          if (!data?.ok) throw new Error(data?.error ?? '读取失败');
          setState(data);
          setDraft(JSON.parse(JSON.stringify(data.config)));
          setTools(toolData?.tools ?? []);
          setMsg(null);
        } catch (error) {
          setMsg({ kind: 'err', text: String(error?.message ?? error) });
        } finally { setBusy(''); }
      }

      function patchStyle(key, field, value) {
        setDraft((d) => (d ? { ...d, styles: { ...d.styles, [key]: { ...d.styles[key], [field]: value } } } : d));
      }

      async function save() {
        if (!draft) return;
        setBusy('save');
        try {
          const styles = {};
          for (const [key, st] of Object.entries(draft.styles ?? {})) {
            const orig = state.config.styles?.[key] ?? {};
            const changed = {};
            for (const field of ['label', 'trigger', 'cfg', 'steps']) {
              if (JSON.stringify(st[field]) !== JSON.stringify(orig[field])) changed[field] = st[field];
            }
            if (JSON.stringify(st.sizes) !== JSON.stringify(orig.sizes)) changed.sizes = st.sizes;
            if (Object.keys(changed).length) styles[key] = changed;
          }
          const res = await API.save({
            defaultStyle: draft.defaultStyle,
            baseUrl: draft.comfyui?.baseUrl,
            negative: draft.negative,
            styles,
          });
          if (!res?.ok) throw new Error(res?.error ?? '保存失败');
          setState((s) => ({ ...s, config: res.config, styles: res.styles }));
          setDraft(JSON.parse(JSON.stringify(res.config)));
          setMsg({ kind: 'ok', text: '已保存到 styles.json' });
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
        try {
          const res = await API.preview({ style: key, prompt: '一位旅人站在岔路口，远处有灯火' });
          if (!res?.ok) throw new Error(res?.error ?? '预览失败');
          setPreview({ key, url: res.media?.[0], elapsedMs: res.elapsedMs });
          setMsg({ kind: 'ok', text: `预览完成：${key}（${(res.elapsedMs / 1000).toFixed(1)}s）` });
        } catch (error) {
          setMsg({ kind: 'err', text: String(error?.message ?? error) });
        } finally { setBusy(''); }
      }

      if (!state || !draft) {
        return h('div', { className: 'rpt' }, h('h3', null, 'RP工具'),
          h('div', { className: 'dim' }, busy === 'load' ? '读取中…' : (msg?.text ?? '未加载')));
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
              h('span', { key: 'o', className: 'mono dim' }, s.lora ? `· ${s.lora}` : '· 无 LoRA'),
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
        preview ? h('div', { key: 'prev', className: 'card' }, [
          h('div', { key: 'l', className: 'dim' }, `预览：${preview.key}（${(preview.elapsedMs / 1000).toFixed(1)}s）`),
          preview.url ? h('img', { key: 'i', className: 'pv', src: preview.url, alt: preview.key }) : null,
        ]) : null,

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
              key: 'n2', value: draft.negative ?? '', placeholder: '反瑕疵词表（已预置一套）',
              onChange: (e) => setDraft({ ...draft, negative: e.target.value }),
            }),
          ]),
          h('div', { key: 'note', className: 'dim' },
            '负面词对所有会话与风格生效；krea2 turbo 默认 CFG=1 时负向不参与计算 —— 想让负面真正起作用，把对应风格的 CFG 调到 1.5~2.5。'),
          h('div', { key: 'act', className: 'row' }, [
            h('button', { key: 'save', className: 'primary', onClick: save, disabled: Boolean(busy) }, busy === 'save' ? '保存中…' : '保存'),
            h('button', { key: 'reset', onClick: reset, disabled: Boolean(busy) }, '恢复默认'),
          ]),
        ]),

        h('div', { key: 'styles', className: 'card' }, [
          h('h4', { key: 't' }, `风格库（${state.styles.length}）`),
          ...styleCards,
        ]),

        h('div', { key: 'tools', className: 'card scroll' }, [
          h('h4', { key: 't' }, `工具列表（${tools.length}）`),
          h('div', { key: 'd', className: 'dim' }, 'rp_* 生图 / 会话 / 角色 / 场景 / 表格工具只在 DM 预设的会话里注册，其它会话不加载。'),
          ...tools.map((tool) => h('div', { key: tool.name, className: 'tool' }, [
            h('div', { key: 'n' }, [
              h('span', { key: 'a', className: 'mono' }, tool.name),
              h('span', { key: 'b', className: 'dim' }, `  ${tool.description}`),
            ]),
            ...(tool.parameters ?? []).map((p) => h('div', { key: p.name, className: 'param' }, [
              h('span', { key: 'n', className: 'mono' }, p.name, p.required ? h('span', { className: 'req' }, ' *') : null),
              h('span', { key: 't', className: 'mono t' }, p.type),
              h('span', { key: 'd', className: 'dim' }, p.description),
            ])),
          ])),
        ]),
      ]);
    }

    // ── 会话浮层：RP 面板（只在 DM 会话出现） ──────────────────────────────
    function RpSessionOverlay({ sessionId, onClose }) {
      const [state, setState] = React.useState(null);
      const [draft, setDraft] = React.useState(null);
      const [styles, setStyles] = React.useState(null);
      const [busy, setBusy] = React.useState('');
      const [msg, setMsg] = React.useState(null);
      const [preview, setPreview] = React.useState(null);
      const [rolls, setRolls] = React.useState([]);
      const [tableDraft, setTableDraft] = React.useState({ name: '', dice: '', entries: '' });

      React.useEffect(() => { void reload(); }, [sessionId]);

      async function reload() {
        setBusy('load');
        try {
          const [data, global] = await Promise.all([API.session(sessionId), API.state()]);
          if (!data?.ok) throw new Error(data?.error ?? '读取失败');
          setState(data);
          setStyles(global);
          setDraft(JSON.parse(JSON.stringify(data.session)));
          setMsg(null);
        } catch (error) {
          setMsg({ kind: 'err', text: String(error?.message ?? error) });
        } finally { setBusy(''); }
      }

      function patch(p) { setDraft((d) => (d ? { ...d, ...p } : d)); }
      function patchCampaign(p) { setDraft((d) => (d ? { ...d, campaign: { ...d.campaign, ...p } } : d)); }

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
            tables: draft.tables,
          });
          if (!res?.ok) throw new Error(res?.error ?? '保存失败');
          setState((s) => ({ ...s, session: res.session }));
          setDraft(JSON.parse(JSON.stringify(res.session)));
          setMsg({ kind: 'ok', text: '已保存（仅本会话）' });
        } catch (error) {
          setMsg({ kind: 'err', text: String(error?.message ?? error) });
        } finally { setBusy(''); }
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
        try {
          const res = await API.preview({ sessionId, style: styleKey, prompt });
          if (!res?.ok) throw new Error(res?.error ?? '预览失败');
          setPreview({ url: res.media?.[0], elapsedMs: res.elapsedMs, style: res.style });
          setMsg({ kind: 'ok', text: `预览完成：${res.style}（${(res.elapsedMs / 1000).toFixed(1)}s）` });
        } catch (error) {
          setMsg({ kind: 'err', text: String(error?.message ?? error) });
        } finally { setBusy(''); }
      }

      if (!draft || !state) {
        return h('div', { className: 'rpt ovl' }, [
          h('div', { key: 'hd', className: 'ovlhead' }, [
            h('h3', { key: 't' }, 'RP'), h('span', { key: 's', className: 'sep' }),
            h('button', { key: 'x', onClick: onClose }, '关闭'),
          ]),
          h('div', { key: 'm', className: 'dim' }, busy === 'load' ? '读取中…' : (msg?.text ?? '未加载')),
        ]);
      }

      const chars = draft.characters ?? [];
      const tables = draft.tables ?? [];

      return h('div', { className: 'rpt ovl' }, [
        h('div', { key: 'head', className: 'ovlhead' }, [
          h('h3', { key: 't' }, 'RP'),
          state.isDm ? h('span', { key: 'b', className: 'badge ok' }, 'DM 会话') : h('span', { key: 'b', className: 'badge warn' }, '非 DM'),
          h('span', { key: 'sep', className: 'sep' }),
          h('button', { key: 'r', onClick: reload, disabled: Boolean(busy) }, '刷新'),
          h('button', { key: 'sv', className: 'primary', onClick: save, disabled: Boolean(busy) }, busy === 'save' ? '保存中…' : '保存'),
          h('button', { key: 'x', onClick: onClose }, '关闭'),
        ]),
        msg ? h('div', { key: 'msg', className: 'msg' }, msg.text) : null,
        preview ? h('div', { key: 'prev', className: 'card' }, [
          h('div', { key: 'l', className: 'dim' }, `预览：${preview.style ?? ''}（${(preview.elapsedMs / 1000).toFixed(1)}s）`),
          preview.url ? h('img', { key: 'i', className: 'pv', src: preview.url, alt: 'preview' }) : null,
        ]) : null,

        h('div', { key: 'world', className: 'card' }, [
          h('h4', { key: 't' }, '世界 / 战役设定'),
          h('textarea', {
            key: 'w', value: draft.world ?? '', placeholder: '世界观、时代、地点、基调……',
            onChange: (e) => patch({ world: e.target.value }),
          }),
          h('div', { key: 'd', className: 'dim' }, `本会话配置文件（DM 也能用 read/write 直接改）：${state.file ?? ''}`),
        ]),

        h('div', { key: 'chars', className: 'card' }, [
          h('h4', { key: 't' }, `角色卡（${chars.length}）`),
          ...chars.map((c, i) => h('div', { key: `c${i}`, className: 'charline' }, [
            h('input', {
              key: 'n', type: 'text', value: c.name ?? '', placeholder: '角色名',
              onChange: (e) => { const n = [...chars]; n[i] = { ...n[i], name: e.target.value }; patch({ characters: n }); },
            }),
            h('input', {
              key: 'a', type: 'text', value: c.appearance ?? '', placeholder: '外观描述（生图时自动补进提示词）',
              onChange: (e) => { const n = [...chars]; n[i] = { ...n[i], appearance: e.target.value }; patch({ characters: n }); },
            }),
            h('button', { key: 'p', className: 'tiny', disabled: Boolean(busy), onClick: () => runPreview(draft.defaultStyle || undefined, `${c.name} 的半身立绘，正面，中性背景`) }, '立绘'),
            h('button', { key: 'd', className: 'tiny', onClick: () => patch({ characters: chars.filter((_, j) => j !== i) }) }, '删'),
          ])),
          h('button', { key: 'add', className: 'tiny', onClick: () => patch({ characters: [...chars, { name: '', appearance: '' }] }) }, '+ 添加角色'),
        ]),

        h('div', { key: 'tables', className: 'card' }, [
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
            h('span', { key: 'p1' }, '提示词前缀'),
            h('input', { key: 'p2', type: 'text', value: draft.campaign?.prompt_prefix ?? '', onChange: (e) => patchCampaign({ prompt_prefix: e.target.value }) }),
            h('span', { key: 'y1' }, '风格备注'),
            h('input', { key: 'y2', type: 'text', value: draft.styleNotes ?? '', placeholder: '每次生图附在提示词后', onChange: (e) => patch({ styleNotes: e.target.value }) }),
            h('span', { key: 'c1' }, '战役名'),
            h('input', { key: 'c2', type: 'text', value: draft.campaign?.name ?? '', onChange: (e) => patchCampaign({ name: e.target.value }) }),
          ]),
          h('div', { key: 'act', className: 'row' }, [
            h('button', { key: 't', disabled: Boolean(busy), onClick: () => runPreview(draft.defaultStyle || undefined, '一位旅人站在岔路口，远处有灯火') }, '用本会话配置试出一张'),
            h('span', { key: 'n', className: 'dim' }, '负面词走全局（设置页 RP工具）'),
          ]),
        ]),
      ]);
    }

    /** 会话头部按钮：只在 DM 会话渲染；点开浮层。 */
    function RpHeaderButton(props) {
      // 该槽位会给组件注入 useSessions 钩子（dsh-pocket 同样用它取当前会话）
      const fromHook = typeof props?.useSessions === 'function'
        ? props.useSessions((s) => s?.current)
        : undefined;
      const sessionId = String(fromHook || props?.sessionId || props?.session?.id || '');
      const [isDm, setIsDm] = React.useState(false);
      const [open, setOpen] = React.useState(false);

      React.useEffect(() => {
        let alive = true;
        if (!sessionId) { setIsDm(false); return () => { alive = false; }; }
        API.session(sessionId)
          .then((r) => { if (alive) setIsDm(Boolean(r?.isDm)); })
          .catch(() => { if (alive) setIsDm(false); });
        return () => { alive = false; };
      }, [sessionId]);

      if (!isDm) return null;   // 非 DM 会话：什么都不渲染
      return h(React.Fragment, null,
        h('button', { key: 'btn', onClick: () => setOpen((v) => !v), title: 'RP 面板（角色卡 / 世界 / 随机表）' }, '🎲 RP'),
        open ? h(RpSessionOverlay, { key: 'ovl', sessionId, onClose: () => setOpen(false) }) : null,
      );
    }

    const name = 'dsh-rp-tools';
    const inject = ['slots'];

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'rp-tools',
        order: 31,
        label: () => 'RP工具',
      }, (props) => h(RpSettings, props)));

      // 会话头部按钮：组件自身在非 DM 会话返回 null → 其它会话不出现任何 RP 界面
      ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: 'rp-tools',
        order: 40,
      }, (props) => h(RpHeaderButton, props)));
    }

    module.exports.name = name;
    module.exports.inject = inject;
    module.exports.apply = apply;
    return module.exports;
  },
});
