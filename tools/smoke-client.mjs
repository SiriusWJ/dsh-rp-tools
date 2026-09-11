/**
 * dsh-rp-tools 客户端半侧冒烟测试（无头）。
 *
 * 目前只验证一件曾经真的坏过的事：**样式表必须在第一个组件渲染之前注入**。
 * 历史 bug：injectStyles() 只在设置页 / 会话面板的 useEffect 里调用，于是首次加载时
 * 头部那个「🎲 RP」按钮先以裸 <button> 的默认外观出现（灰底方角），
 * 等某个组件挂载后才恢复 —— 用户看到的就是「第一次启动样式不对，后面正常」。
 *
 * 做法：搭一个最小 DOM 桩 + 模块加载器桩，跑一遍 bundle 的 factory 拿到插件导出，
 * 调 apply()（此时一个组件都还没渲染），断言 <style> 已经进了 head。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const here = fileURLToPath(new URL('.', import.meta.url));
const bundlePath = join(here, '..', 'client', 'client.js');

// ── 最小 DOM 桩 ────────────────────────────────────────────────────────────
const head = [];
globalThis.document = {
  createElement(tag) {
    const el = { tagName: String(tag).toUpperCase(), dataset: {}, textContent: '', isConnected: false };
    el.setAttribute = (k, v) => { el[k] = v; };
    return el;
  },
  head: { appendChild: (el) => { el.isConnected = true; head.push(el); } },
  querySelector: () => null,
};

// ── 模块加载器桩：捕获 factory，喂给它 require ──────────────────────────────
let captured = null;
globalThis.window = {
  __ModuleLoader__: {
    load(spec) { captured = spec; },
  },
};

// React 只用到 createElement / useState / useEffect / useRef —— 本测试不渲染组件，
// 给一组不会崩的最小实现即可。
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol('Fragment'),
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
};

// bundle 是给浏览器写的普通脚本：在 ESM 里读出来用 indirect eval 执行，拿到全局桩上的效果。
const source = readFileSync(bundlePath, 'utf8');
(0, eval)(source);
assert.ok(captured !== null, 'bundle 应通过 window.__ModuleLoader__.load() 注册自己');
assert.equal(captured.id, 'dsh-rp-tools', 'bundle 注册的 id 应为 dsh-rp-tools');

const plugin = captured.factory((name) => {
  if (name === 'react') return React;
  throw new Error(`未预期的 require: ${name}`);
});
assert.equal(plugin.name, 'dsh-rp-tools');
assert.deepEqual(plugin.inject, ['slots']);

// ── 关键断言：apply 一跑，样式就该在 head 里 ────────────────────────────────
const registered = [];
const slotRegs = [];
const slotsStub = {
  inject: (key, cb) => { registered.push(key); cb(); return () => {}; },
  register: (spec) => { slotRegs.push(spec); return () => {}; },
};
const ctx = {
  slots: slotsStub,
  inject: () => () => {},
  effect: () => () => {},
};

assert.equal(head.length, 0, 'apply 之前不应有样式（否则这个测试就没意义了）');
plugin.apply(ctx);
assert.equal(head.length, 1, 'apply 之后必须恰好注入一份样式表');

const style = head[0];
assert.equal(style.tagName, 'STYLE');
assert.equal(style.dataset.plugin, 'dsh-rp-tools', '样式表应带 plugin 标识，便于 devtools 辨认');
assert.ok(style.textContent.includes('.rph-btn'), '样式表里应含头部按钮的 .rph-btn 规则');
assert.ok(style.textContent.includes('.rpc'), '样式表里应含故事书导入的 .rpc 规则');
// 导入面板的两列布局必须随窄视口塌成一列，否则小窗口里列表会被压没
assert.ok(style.textContent.includes('.rpc .split'), '样式表里应含导入面板的 .split 两列布局');
assert.ok(/@media[^{]*\{\s*\.rpc \.split/.test(style.textContent), '.split 应有窄视口的单列降级');

// 再调一次不能又插一份（幂等）
plugin.apply(ctx);
assert.equal(head.length, 1, '重复 apply 不应重复注入样式');

// 槽位注册：设置页 + 头部入口 + 输入框上方入口（三个都必须注册上）
assert.ok(registered.includes('settings.section'), '应注册设置页');
assert.ok(registered.includes('conversation.session.header.utilities'), '应注册头部右上角入口');
assert.ok(registered.includes('conversation.input.dock'), '应注册输入框上方的故事书导入入口');

// 注册描述要能被 DSH 的槽位系统认出来（id 唯一、order 是数字）
const dockReg = slotRegs.find((r) => r.name === 'conversation.input.dock');
assert.ok(dockReg, 'conversation.input.dock 应有注册项');
assert.equal(dockReg.id, 'rp-card-import', '导入入口的槽位 id 应稳定（界面/测试都按它找）');
assert.equal(typeof dockReg.order, 'number', 'order 必须是数字，否则排序会退化');

console.log('客户端冒烟测试通过：');
console.log(`  · bundle id = ${captured.id}`);
console.log(`  · apply 后样式表已注入（${style.textContent.length} 字符，含 .rph-btn / .rpc）`);
console.log(`  · 重复 apply 幂等`);
console.log(`  · 已注册槽位：${registered.join(', ')}`);
console.log(`  · 故事书导入槽位：id=${dockReg.id} order=${dockReg.order}`);
