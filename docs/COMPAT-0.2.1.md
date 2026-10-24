# dsh-rp-tools × DSH 0.2.1-rc.2 兼容性审计

- 审计对象：`D:\Code\dsh-rp-tools`（git HEAD `8628ceb` + 审计期间工作区未提交改动）
- 目标运行时：DSH 桌面版 **0.2.1-rc.2**（app.asar 内置；实际 profile：`C:\Users\75373\.dsh\profiles\desktop`；GUI `http://127.0.0.1:60841`）
- 0.2.1 解包源码根（下称 `D021`）：`C:\Users\75373\AppData\Local\Temp\dsh021`（304 个 `@deepseek-ai/*` 包；`@deepseek-ai/cordis` 4.0.5）
- 审计时间：2026-10-25 02:0x（工作区正被 Lead 连续修改，本文以该时刻文件为准，并标出已修/未修状态）

> 说明：审计期间 Lead 已把 0.1.5 时代的「预设目录」形态迁移为 0.2.1 的「bundle patch 里插 `@deepseek-ai/dsh-agent-preset` 行」形态（`cordis.patch.yml`、`package.json`、`rp-bridge.mjs`、`engines.dsh`），并删除了 `preset/agent.cordis.yml`、`preset/preset.yml`、`tools/install-preset.mjs`。本文对这些项只记录结论与依据，**剩余风险**放在 P0/P1。

---

## 0. 结论摘要（先结论后依据）

**总体结论**：插件用到的核心扩展点在 0.2.1 全部仍然存在且签名兼容——`webServer.register({kind,path,handler})`、`tools.register(defineTool(...))`、`tools.schemas/restrict`、`systemPrompt.section/context/variable` 与 `system-prompt/assemble` waterfall、`agent/created` / `session/created` / `session/disposed` 事件、客户端 5 个槽位与 `sidebarRight(Tabs)` 服务、`dsh.bundle.patch` / `dsh.client` 清单。**没有**发现「0.2.1 删了某个扩展点导致插件整体无法加载」的硬伤。

真正剩下的风险只有三类：

1. **安装形态**（`link:`/本地目录安装）下主模块的裸导入解析会失败（P0-1，未修）。
2. **预设内容与 0.2.1 的工具归属变化脱节**：`web_search` 在 0.2.1 属于 preset 作用域工具，DM 预设没挂 → DM 会话拿不到（P0-2，未修）；GenUI / 生图工具在 0.2.1 默认环境不存在或名字不同（P0-3）。
3. **0.1.5 语义残留**：`blankPromptSections` 只遮蔽 section、遮不住 0.2.1 新加的 runtime context（P1-1）；全局工具默认名单/来源映射仍是 0.1.5 生态（P1-2）；客户端 `remote` 未声明依赖（P1-3）。

**最严重的 3 项**

| 级别 | 编号 | 问题 | 状态 |
|---|---|---|---|
| P0 | P0-1 | `link:`/本地目录安装时 `lib/index.js` 的 `import '@deepseek-ai/dsh-tools'` 无法解析（插件主模块与客户端 bundle 双双失效，只有一行日志） | 未修；待实测 |
| P0 | P0-2 | DM 预设未挂 `@deepseek-ai/dsh-tool-web`，`web_search`/`web_fetch` 在 0.2.1 的 DM 会话里不存在，而 persona 明确让 DM 用 `web_search` | 未修 |
| P1 | P1-1 | `blankPromptSections` 遮不住 `harness:source` / `app:web-surface` 的 **runtime context**：DM 会话每轮仍收到本机 DSH checkout 路径与 GUI URL | 未修 |

**逐项状态总览**

| # | 审计点 | 0.2.1 结论 | 剩余动作 |
|---|---|---|---|
| 1 | `lib/index.js` 插件形态（`inject/apply/ctx.inject(['webServer'])/webServer.register/ctx.on/tools.register`） | 兼容 | P0-1（解析） |
| 2 | `preset/rp-bridge.mjs`（agent 作用域、`ctx.tools.schemas()`、`systemPrompt.variable`、`system-prompt/assemble`） | 兼容 | 建议 P1-6 简化解析 |
| 3 | `client/client.js`（5 个槽位、`sidebarRightTabs/sidebarRight`、`useSessions`） | 兼容 | P1-3/P1-5/P2-1 |
| 4 | `package.json` 清单 / `cordis.patch.yml` / 预设 YAML | 已按 0.2.1 迁移（旧目录形态在 0.2.1 已废除） | P0-2、P1-1 |
| 5 | 模块解析（桌面 profile 只有 3 个 `@deepseek-ai` 包时如何解析 `@deepseek-ai/*`） | 安装包/registry 安装走 0.2.1 runtime resolution，兼容；`link:` 安装缺 peer 依赖会失败 | P0-1 |
| 6 | `tools.defineTool` / schema DSL / `webServer.register` 选项 | 兼容（8 个 rp_* 工具用 0.2.1 真实 `defineTool` 全部通过） | 无 |
| 7 | 客户端 bundle 注入与 `dsh.client.inject` | 协议兼容；`inject` 合法；`immediately` 可选；id 必须=包名 | P2-2（补 inject 列表） |

---

## 1. 审计方法与证据来源

1. `D021` 下逐包读 README.zh.md + `lib/*.js`（`dsh-app-boot` / `dsh-host-webserver` / `dsh-tools` / `dsh-system-prompt` / `dsh-agent` / `dsh-session` / `dsh-agent-preset(-registry)` / `dsh-client-modules` / `dsh-client-ui-sidebar-right` / `dsh-cordis-client-runner` / `dsh-harness-dev-context` / `dsh-web-app` / `dsh-base` / `cordis-plugin-loader` / `@deepseek-ai/cordis`）。
2. **live 契约**（`cordis_inspect_query`，跑在真实 0.2.1 上）：
   - host `Event.listEvents({"event":"system-prompt/assemble"})` → `(assembly, context, next)`，`AssembleContext = { scope?: ScopeKey; signal?: AbortSignal }`；
   - host `Service.listService({"service":"tools"})` → `register/restrict/get/schemas` 签名与 `ToolDefinition`（`output:{schema,render,presentationMeta?}`）逐字段一致；
   - host `Tool.listTools` / `Config.listConfigs` → 本机真实工具与宿主行状态（用于 P0-3/P1-2）。
   - client `Slots.listSubTree` / `Builtin.listBuiltins` 在本次审计时**超时**（页面未连上 inspect），客户端槽位契约改用 `D021` 里的槽位目录（`dsh-cordis-client-runner/lib/client.js` 的 `Slots` 目录，见 §5.3）。
3. **动态验证**：把 `lib/` 拷进临时目录，用 `D021` 里真实的 `dsh-tools/lib/types/schema.js`（含 `defineTool`）与最小 stub（`dsh-llm` 的 `HarnessError`、`dsh-util-values`）跑 `registerRpTools(fakeCtx)`：
   ```
   registered tools: 8
   - rp_random | params keys: 8 | output required: ["kind","values","note"] | render: function
   - rp_character / rp_state / rp_lore / rp_session / rp_assets / rp_config / rp_table 同样通过
   definitions missing execute/render: []
   ```
   → 工具定义、参数 DSL（`required:true`、`enum`、`array.items`、`object.additionalProperties`）、输出 schema、`render` 全部被 0.2.1 接受。
4. 桌面 profile **只读检查**：`profiles/desktop/package.json`（23 个 bundle）、`profiles/desktop/node_modules/@deepseek-ai/` 只有 `cosmokit / dsh-home-paths / schemastery` 3 个包。
5. 官方文档（0.2.1 自带技能，权威）：`D021/dsh-agent-preset/skills/editing-cordis-compositions/SKILL.md`、`.../cordis-plugin-development/{SKILL.md,references/host-plugin.md,references/ui-plugin.md}`、`D021/dsh-agent-preset-registry/README.zh.md`。

---

## 2. P0：会导致功能失败/整体失效

### P0-1 `link:`/本地目录安装时，插件主模块的 `import '@deepseek-ai/dsh-tools'` 解析失败（未修；待实测）

**现象**

用 `dsh plugin --profile <p> add link:<repo>`（或 `plugin_manager install_bundle` 指向本地目录）把插件装进 0.2.1 profile 后：

- Loader 的宿主行 `dsh-rp-tools` 导入失败（`ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools'`），该行没有 fiber；
- 因为行未激活，`dsh-client-modules` 不会把它算进客户端 bundle（见证据 4），设置页/RP 面板/🎲 RP 入口一并消失；
- dm 预设的 `rp-bridge` 行本身能加载（它只导入 node 内置模块），但 `apply()` 里 `await import(插件入口)` 同样失败 → 只打印一行 `[rp-bridge] 注册 RP 工具失败…`，**8 个工具与两条注入通道全丢**，表面看像插件坏了。

**证据（0.2.1 源码）**

1. 本地目录安装记录为 `link:`：`D021/dsh-plugin-manager/lib/index.js:933`（`spec: \`link:${directory}\``）。
2. profile 里指向树外的符号链接会被识别为「linked root」：`D021/dsh-app-boot/lib/index.js:664-692`（`linkedProfileRoots`，realpath 在 `profiles/` 与当前 profile 之外即收录）。
3. 解析拦截对「linked」导入方有额外条件：`D021/dsh-app-boot/lib/index.js:1676-1730`（`routeLinked`）。
   只有某个祖先目录的 `package.json` 的 **`peerDependencies`** 里出现该包名时，才走 `installation` 拦截（1684-1701）；否则逐个查物理 `node_modules`，都没有就返回 `{ route: { kind: "native" } }`（1726-1729）→ 原生解析失败。
   （对照组：非 link 安装的插件 realpath 在 profile 内，走 `routeScoped`，`D021/.../index.js:1664-1674` 直接用 installation 条目，**不需要** peer 声明。）
4. 客户端 bundle 只登记「有 fiber 的 Loader 行」：`D021/dsh-client-modules/lib/index.js:851-876`（`processOne` 跳过 `entry.fiber === undefined`）和 `890-911`（`reconcilePackage`）。
5. 桌面 profile 里 `@deepseek-ai/dsh-tools` 不在 profile 的 `node_modules`（只有 3 个包），它来自安装目录的 runtime resolution（`dsh-base` 依赖闭包：`D021/dsh-base/package.json` dependencies 含 `@deepseek-ai/dsh-tools`；`D021/dsh/package.json` dependencies 含 `@deepseek-ai/dsh-base`）。
6. **为什么 Lead 的 `rptest` 实测能过**：当时排查发现 repo 根有 `node_modules -> /tmp/dsh021root/node_modules` 的符号链接（dev 用，`.gitignore:1` 忽略）。这条链接让 `routeLinked` 的物理候选分支（1726 附近之前的 `localPackageCandidate`）直接命中；**新 clone / 发布包没有它**，所以这个成功不能代表 `link:` 安装的真实用户路径。

**插件侧位置**

- `lib/index.js:11` `import { defineTool } from '@deepseek-ai/dsh-tools';`
- `package.json:46-59` 只有 `dsh`/`engines`，**没有 `peerDependencies`/`dependencies`**。
- `preset/rp-bridge.mjs:103-125` 的动态导入（失败面被 try/catch 吃掉，只剩日志）。

**建议修法（0.2.1 正确写法）**

在 `package.json` 顶部加（`peerDependenciesMeta.optional` 防止 pnpm/宿主自动安装；`readPeerNames` 只读 key，不看 meta）：

```json
"peerDependencies": {
  "@deepseek-ai/dsh-tools": ">=0.1.7-rc.2"
},
"peerDependenciesMeta": {
  "@deepseek-ai/dsh-tools": { "optional": true }
}
```

- 版本要求不会引入兼容性门禁：`package.json` 已有 `engines.dsh`，0.2.1 的兼容性检查在存在 `engines.dsh` 时**只看它、忽略 peerDependencies**（`D021/dsh-app-boot/lib/index.js:281-298`）。
- 若不想动 peer：备选是把 README 的开发安装方式改成 `dsh plugin add file:<tarball>` 或 registry/git 安装（这两种 realpath 在 profile 内，天然不需要 peer），并删掉「link: 安装」建议。

**待实测（必做）**

1. 新 clone 到临时目录（确认无 `node_modules`）：`git clone https://github.com/SiriusWJ/dsh-rp-tools.git C:\tmp\rptools-clean`；
2. 建临时 profile 并 `dsh plugin --profile rptest2 add link:C:\tmp\rptools-clean`；
3. `dsh --profile rptest2 --no-open --port 0`（Windows 用桌面版自带 node），看 boot 日志是否出现 `Cannot find package '@deepseek-ai/dsh-tools'` / `dsh-rp-tools` 行 failed；
4. 加回 `peerDependencies` 后重复，期望行激活、`GET /rp-tools/tools` 返回 8 个工具。
（本地快速复现：把 repo 根 `node_modules` 临时改名后重启现有 `rptest` profile。）

---

### P0-2 DM 预设未挂 `@deepseek-ai/dsh-tool-web`，`web_search`/`web_fetch` 在 DM 会话里不存在（未修）

**现象**

0.2.1 起，第一方模型工具（`tool-fs`、`tool-fs-search`、`tool-web`、`tool-subagent` …）**不再是 host 全局工具**，而是 host 行被禁用、由各 preset 的 `config.plugins` 挂载。DM 预设只挂了 `tool-fs` / `tool-fs-search` / `tool-ask-user`，所以：

- DM 会话**没有 `web_search` / `web_fetch` 工具**；
- 而 `cordis.patch.yml` 里 DM 的 persona 仍在教它「查资料用 `web_search`」；
- dm-filter 的「全局工具放行名单」对此无能为力——它只能 deny/keep **全局层**工具，不能把一个不存在的 preset 工具「放进来」。

**证据（0.2.1 源码/配置）**

1. `D021/dsh-base/cordis.patch.yml:292-301` 插入 host 层 `tool-fs`/`tool-fs-search` 行；但 web 场景把它们禁用，交给 preset：`D021/dsh-web-app/cordis.patch.yml:560-576`（`- id: tool-subagent / disabled: true` 等同段）与 `D021/dsh-web-app/presets/standard.patch.yml:27-30,116-117`（standard 预设显式挂 `tool-fs`/`tool-fs-search`/`tool-web`）。
2. 0.2.1 工具归属随 preset 作用域：`ctx.tools.register` 注册在「当前 agent 作用域」，`restrict` 只作用于 **inherited（全局+祖先）层**，scope 自己的注册不受影响——`D021/dsh-tools/lib/index.js:3033-3081`（`view()` 把 `own` 排除在 `restrictableNames` 外）。
3. `web_search`/`web_fetch` 由 `@deepseek-ai/dsh-tool-web` 提供：`D021/dsh-tool-web/lib/index.js:257-262,732-737`；README.zh.md「它把 `web_search` 与 `web_fetch` 加入模型的工具集」。
4. host 的 web 服务与后端仍在本机（`dsh-web` / `dsh-web-search-deepseek` / `dsh-web-fetch-http` 行 active，见 `Config.listConfigs`），所以**只差一行 preset 插件行**，不需要再加后端。
5. dm-filter 的 keep 语义见 `preset/session-filter-v2.mjs:94-121`（deny 由 `ctx.tools.schemas()` 的全局视图推导）。

**插件侧位置**

- `cordis.patch.yml:164-171`（preset `plugins` 里的 3 个第一方工具行；缺 `tool-web`）
- `cordis.patch.yml:39-43`（persona 文档工具段：`用 web_search 查资料…`）
- `preset/session-filter-v2.mjs:94-100`（`deniedGlobalTools` 只能看全局视图）

**建议修法（0.2.1 正确写法）**

在 `cordis.patch.yml` 的 `preset-dm.config.plugins` 里、`tool-ask-user` 之后加一行（`dsh-tool-web` 的两个工具默认都注册；也可 `config: { fetch: false }` 只留搜索）：

```yaml
          - id: tool-web
            name: "@deepseek-ai/dsh-tool-web"
```

不想给 DM 联网能力的话，反向修：删掉 persona 里 `web_search` 的两处说明（`cordis.patch.yml:39-43`、`102-104` 的「地图/世界书」段没有引用无需动），并把 README「第三方工具管理」里 `web_search` 默认放行改成说明「0.2.1 里 web_search 属预设工具，不在全局名单内」。

**待实测**：新建 DM 会话后，让模型做一次需要联网的检索，或在会话日志的 tools 声明里确认 `web_search`/`web_fetch` 出现（0.2.1 的工具 schema 是组装结果，日志中 `tool/call` 或 `request/header` 可见）。

---

### P0-3 GenUI / 生图工具在 0.2.1 默认环境不存在或改名，persona 与默认放行名单会和现实脱节（需产品决策；部分未修）

**现象**

- 0.2.1 官方包里**没有** `render_ui` / `validate_dsh_ui` / `dsh-ui` 围栏：在 `D021` 全量 `*.js` 里 grep 这三个 token **0 命中**；它们来自第三方 GenUI 插件（README 已注明可选 `@changfenhuang/dsh-genui`），而当前 desktop profile **没有装**。
- 生图同理：当前 desktop profile 没装 `dsh-image-gen`，已装的生图能力是 **`codex_image_generate`**（`dsh-codex-subscription`，来自 `Tool.listTools` 实测）。
- 但：
  - DM persona/常驻说明仍写「用 `generate_image` / `edit_image` 配图」「用 `render_ui` / `validate_dsh_ui` / `dsh-ui` 围栏」；
  - `lib/global-tools-defaults.js:33-42` 默认放行名单仍是 `render_ui/validate_dsh_ui/web_search/generate_image/edit_image`；
  - `preset/rp-bridge.mjs:89-101` 的 `warnIfNoImageTools` 只认 `generate_image`/`edit_image`，所以**每个 DM 会话都会打印一条生图警告**，即使本机有 `codex_image_generate`；
  - dm-filter 默认 deny 一切不在名单里的全局工具 → DM 会话连 `codex_image_generate` 也看不见；`rp_assets` 的「收录宿主生图结果」链路（`path: generate_image 返回的 savedTo`）也就无从发生。

**证据**

1. 工具名/归属：`cordis_inspect_query` host `Tool.listTools`（本机实际工具：`codex_image_generate`、`ops_bash`、`markitdown`、`team_task_*` 等；无 `render_ui`/`generate_image`）。
2. 默认名单：`lib/global-tools-defaults.js:33-42`、来源映射 `:65-108`（`dsh-image-gen`/`dsh-genui`/`web_*` 等 0.1.5 生态名字）。
3. 插件侧提示词：`cordis.patch.yml:39-43`（web_search）、`:100-139`（GenUI 卡片/围栏/`render_ui`）、`:141-163`（`generate_image`/`edit_image`）。
4. 0.2.1 的全局工具放行过滤仍按「deny 全局层」工作（P0-2 证据 2），因此名单里没有的全局工具 DM 一定看不到。

**建议修法（三选一或组合，推荐 A+B 一起）**

A. **默认名单改为动态**：首装时 `yield 当前全部全局工具`（`ctx.tools.schemas()` 的全局视图），设置页再从「全放行」往回收。0.2.1 写法：

```js
// session-filter-v2.mjs：没有可读配置时，退回“放行本机全部全局工具”，而不是写死 5 个名字
function readAllowList() {
  try { /* …读 styles.json.globalToolsAllow… */ } catch { /* fall through */ }
  try { return ctxTools.schemas().map((t) => t.name).filter((n) => n !== 'run_code'); } catch { return []; }
}
```

（注意：`restrict({deny})` 的 deny 必须 ⊆ 当前全局注册表，动态读取天然满足；写死名单里已不存在的名字只影响 keep、不触发 `restrict` 的 unknown 校验，但会让设置页出现无意义的「未注册」项。）

B. **rp-bridge 探测本机可用生图工具，注入到常驻段**，persona 里改为「**用本机实际提供的生图工具（名字见系统提示【生图工具】一行）**」：

```js
const names = new Set((ctx.tools.schemas() ?? []).map((t) => t?.name).filter(Boolean));
const imageTools = [...names].filter((n) => /(image|canvas|draw|picture)/i.test(n));
// 放进 buildStandingText 的输出（rp-bridge 安装的 standing section 或 dm-filter 的 blank 区域之外）
```

C. 如果确实要保留 GenUI/生图硬依赖：在 README/安装说明中把两个可选插件列为 DM 配图/卡片的**前置条件**，并在 preset 里保留 fallback 文案（模型看不到对应工具时只叙事、不调工具）。

**待实测**：装 `@changfenhuang/dsh-genui` 与一个生图插件后，确认工具名是否恰为 `render_ui/validate_dsh_ui/generate_image/edit_image`；在设置页勾选后 DM 会话 `Tool.listTools` 是否出现；`codex_image_generate` 勾选后 `rp_assets import` 是否能收图。

---

## 3. P1：会静默降级或出现新旧语义差

### P1-1 `blankPromptSections` 遮不住 runtime context：DM 会话仍会收到 checkout 路径与 GUI URL（未修）

**现象**：dm-filter 用「同名空 section」遮蔽 host 注入的全局提示词章节。0.2.1 中 `harness:source` 与 `app:web-surface` **同时注册了 section 和 runtime context**；空 section 只能遮 section，两条 context（`Current DeepSeek Harness implementation checkout: "…"`、`Current DeepSeek Harness Web GUI URL: "…"`）仍然每轮进入 DM 上下文。

**证据**

1. `D021/dsh-harness-dev-context/lib/index.js:102-122`：同一组名字既 `ctx.systemPrompt.section(...)`（104-108、113-117）又 `ctx.systemPrompt.context(...)`（109-112、118-121）。
2. 空 section 会被 `renderPrompt` 丢弃 → 遮蔽生效：`D021/dsh-system-prompt/lib/index.js:117-118`。
3. **空 context 也会被丢弃**，所以「同名空 context」同样是合法遮蔽手段：`D021/dsh-system-prompt/lib/index.js:151-155`（`renderContextSections(...).filter(section => section.text.length > 0)`）。
4. host 的 `harness-dev-context` 行在 0.2.1 是 active（`D021/dsh-web-app/cordis.patch.yml:211-212`），并非可选。
5. 0.2.1 第一方 context 清单（供决策）：`D021/dsh-system-prompt/lib/index.js:44-52`（`working_directory` 100，`required`；`sandbox_policy` 110；`approval_policy` 115；`subagent_delegation` 120；`team_identity` 125；`harness:source` 200；`app:web-surface` 210）。

**插件侧位置**

- `preset/session-filter-v2.mjs:124-131`（`blankSections` 只调 `section`）
- `cordis.patch.yml:175-190`（预设里只配了 `blankPromptSections`，`suppressRuntimeContext: false` 在 190 行——它是给 rp-tools 自己的 `rp:turn` 通道留的，不能全局关）

**建议修法**

在 `session-filter-v2.mjs` 增加 `blankContexts`（配置里与 `blankPromptSections` 同级），**不要**用 `suppressRuntimeContext()` 全局关（会连带丢掉 rp-tools 的每轮注入）：

```js
function blankContexts(ctx, contexts) {
  for (const entry of contexts ?? []) {
    const name = Array.isArray(entry) ? entry[0] : entry?.name;
    const order = Array.isArray(entry) ? entry[1] : entry?.order;
    if (typeof name !== 'string' || !Number.isFinite(order)) continue;
    // 同名空 context 会遮蔽全局项，空文本在渲染时被丢弃
    ctx.systemPrompt.context({ name, order, text: '' });
  }
}
// apply 里：
blankContexts(ctx, settings.blankContexts);
```

`cordis.patch.yml` 的 dm-filter config 增加：

```yaml
              blankContexts:
                - ["harness:source", 200]
                - ["app:web-surface", 210]
```

（其余 context 是否遮蔽属于产品决策：`working_directory` 是 `required`，遮挡会被注册表按必需项恢复，不要配；`sandbox_policy`/`approval_policy` 对 DM 是安全相关，建议保留。）

**待实测**：DM 会话跑 1 轮后读 `%USERPROFILE%\.dsh\data\dsh-rp-tools\_standing-probe.json` 与 session log 的 `request/context`，确认 `Current DeepSeek Harness implementation checkout` 不出现；`_standing-probe.json` 同时还能看到 `rp:standing` 段（现成的诊断探针，插件 `lib/index.js:4219-4252`）。

---

### P1-2 全局工具默认名单/来源映射仍是 0.1.5 生态（未修，与 P0-3 同源）

**现象**：`GLOBAL_TOOLS_DEFAULT` 的 5 个名字在 0.2.1 桌面版**一个都不存在于全局注册表**（`render_ui/validate_dsh_ui/generate_image/edit_image` 来自可选插件；`web_search` 在 0.2.1 是 preset 工具，见 P0-2）。后果：

- 「设置 → RP工具 → 第三方工具管理」出厂即显示一批「未注册」条目；
- DM 默认放行名单空转，用户以为「DM 能配图」，实际一张都出不了（P0-3）；
- `GLOBAL_TOOL_SOURCES` 的归组规则对本机真实工具（`ops_*`、`team_task_*`、`session_*`、`codex_*`、`markitdown`…）全部落到 `__unmapped__`「宿主内置 · 其它」——这正是该文件注释里说「正常应该是空的」的那一组。

**证据**：`lib/global-tools-defaults.js:33-42`、`:65-108`；`cordis_inspect_query` host `Tool.listTools` 的实际工具名；`preset/session-filter-v2.mjs:62`（`ALLOW_DEFAULT = [...DEFAULTS.GLOBAL_TOOLS_DEFAULT]`）。

**建议**：见 P0-3 修法 A；来源映射表改成「按工具名前缀/正则给出各插件组」并允许未知组标注来源插件（0.2.1 `Tool.listTools` 仍不提供归属，`tools.register` 没有来源字段——这点 0.1.5/0.2.1 一样，映射表仍是唯一手段）。

---

### P1-3 客户端 `ctx.get('remote')` 未声明依赖，预设切换订阅可能静默不生效（未修）

**现象**：🎲 RP 入口在「切走预设再切回 dm」后依赖 `agent-preset/selected` 广播恢复；插件在 `apply` 里用 `ctx.get('remote')` 取服务，但客户端插件只声明了 `inject = ['slots']`。0.2.1 的 `remote` 服务由其他客户端插件提供，插件 fiber 激活时它可能还没就绪 → `ctx.get` 返回 undefined → 订阅被静默跳过（代码里有 try/catch），回到 0.1.5 修过的「按钮再也不回来」现象。

**证据**

1. 0.2.1 客户端 `remote.$on` 存在，且 `agent-preset/selected` 在广播白名单：`D021/dsh-api-remotes/lib/types/remote-events.js:17`；同款用法见 `D021/dsh-client-ui-skill/lib/client.js:482`、`D021/dsh-client-ui-commands/lib/client.js:1438`。
2. Cordis 的 `ctx.get(name)` 不走依赖等待：`D021/cordis/lib/index.js:763-772`（`get()` 直接读 impl，`strict` 只要求提供方 fiber active）；依赖等待只在 `inject`（`:1600-1606`）。

**插件侧位置**：`client/client.js:3202`（`inject = ['slots']`）、`3323-3334`（`ctx.get('remote')` + try/catch）。

**建议修法**：把 `remote` 声明为硬依赖（最简单），或延迟注入：

```js
// 方案一：硬依赖（remote 服务不存在时插件会等待，不会跳过）
const inject = ['slots', 'remote'];
// 方案二：延迟注入（与现 rightbar 写法一致）
ctx.inject(['remote'], (scope) => {
  const off = scope.remote.$on('agent-preset/selected', notifyPresetChange);
  scope.effect(() => () => off(), 'rp-tools: preset listener');
});
```

**待实测**：DM 会话里切到别的预设再切回，不刷新页面，🎲 RP 按钮是否重新出现；DevTools 里确认插件 apply 时 `ctx.get('remote')` 非 undefined。

---

### P1-4 `findPresetId` 在 0.2.1 不再能识别预设（宿主侧自动登记失效，低影响）

**现象**：`lib/index.js:5913-5935` 在 `agent.options`/`agent.session` 上找 `agentPreset/preset/...` 标量。0.2.1 的 `Agent` 接口只有 `readonly id: SessionId`（live `Service.listService({service:'tools'})` 的 referencedTypes），预设的真正来源是 **`session.header.agentPreset`**（`D021/dsh-session/lib/index.js:1818-1829`）或 `agentPreset` 投影（`D021/dsh-agent-preset-registry/lib/types/session.js:15-31`）。结果：`_agent-probe.json` 的 `foundPreset` 恒为 null，`markDmSession` 的宿主侧自动登记不触发（但客户端 POST `/rp-tools/dm-mark` 与「DM 用过一次工具」的保底登记仍会生效，所以功能不丢，只是诊断信息误导）。

**建议修法**：`findPresetId` 增加一个来源：

```js
const header = agent?.session?.header ?? {};
for (const key of ['agentPreset']) {
  const v = header[key];
  if (typeof v === 'string' && v) return v;
}
```

**待实测**：DM 会话创建后看 `_agent-probe.json` 的 `foundPreset` 是否为 `"dm"`、`autoMarked` 是否出现。

---

### P1-5 右栏分栏类型的 guide 条目缺 `id`（不报错，但违反 0.2.1 约定）

**现象**：`client/client.js:3256-3265` 注册的 guide 条目只有 `{order,title,description}`。0.2.1 的 `sidebarRightTabs.register` 只在**同一个 definition 内 id 重复**时抛错（`D021/dsh-client-ui-sidebar-right/lib/client.js:4465-4468`）；单条缺 id 会静默通过，但：

- guide 渲染的 React key 变成 `["dsh-rp-tools", undefined]`（`.../index.js:535`）；
- guide 条目槽位拿到 `entryId: undefined`（`.../index.js:518-522`），将来想替换/定位这条 guide 条目时无 id 可用。

**证据**：`D021/dsh-client-ui-sidebar-right/lib/client.js:4465-4472`（id/kind 校验）、`4617-4623`（refresh 展开 guide）、`455-538`（GuideBody 渲染与 key）。

**建议修法**：

```js
guide: [{
  id: 'rp-panel',              // 0.2.1：provider 内唯一 id
  order: 30,
  title: () => '🎲 RP 跑团面板',
  description: () => '世界设定 / 角色卡 / 世界书 / 随机表 / 会话配置',
}],
```

---

### P1-6 `rp-bridge.mjs` 的 profile 解析已修，但整体可再简化（建议，非故障）

**现状**：`preset/rp-bridge.mjs:42-72` 已把 `profiles/web` 默认改为「装插件的 profile → desktop → 唯一 profile」；`:103-125` 仍用 `createRequire(PROFILE_PACKAGE).resolve('dsh-rp-tools')` + `import(pathToFileURL(...))`。0.2.1 下这套能用（CJS resolve 会跟随 profile/node_modules 符号链接到 realpath，ESM 缓存 URL 与宿主行一致），但依赖 profile 的物理布局；0.2.1 的推荐写法是**直接按包名导入自己**：

```js
// preset/rp-bridge.mjs
export async function apply(ctx) {
  const mod = await import('dsh-rp-tools');   // package exports "." → ./lib/index.js；自引用可用
  mod.registerRpTools(ctx);
}
```

配合 `package.json:24-33` 已有的 `"."` 导出即可；不再需要 `PROFILE_PACKAGE`/`createRequire`/`DSH_RP_PROFILE_PACKAGE`（`tools/verify-roundtrip.mjs` 等测试可改为 `createRequire(import.meta.url)` 或直接 import）。注意：这样改后 `tools/smoke-dm.mjs` 等仍可保留环境变量路径用于「加载安装副本」，但不再是运行必需。

---

## 4. P2：低危、清理项、待实测清单

### P2-1 客户端 `useSessions((s) => s?.current)` 在 0.2.1 恒为 undefined

0.2.1 的 session-list 快照结构是 `{ byId, projectionsBySession, ... }`（`D021/dsh-api-session-controller/lib/client.js:4150-4220` 的 summary 字段：`sessionId/running/blank/updatedAt/parentSessionId/origin/cwd/...`），没有 `current` 字段。插件多处 `s?.current`（`client/client.js:2389-2394,2647` 等）取到 undefined，但都有 `props.sessionId` 兜底（槽位 standardProps 有 `sessionId`，见 §5.3），所以当前不坏事；建议把这些 fallback 换成 `props.sessionId` 优先，避免将来误用。

### P2-2 客户端清单收尾建议（非阻塞）

- `package.json:50-55` 的 `dsh.client.inject` 只列了 `@deepseek-ai/dsh-client-ui-settings`。0.2.1 里 `inject` 是**浏览器 bundle 预加载顺序**（客户端半侧 `D021/dsh-client-modules/lib/client.js:776-794`：只对已存在的图行生效，未知名字静默跳过），不是硬依赖；插件实际依赖 `slots`（dsh-client-ui-renderer 提供）、`sidebarRight(Tabs)`（dsh-client-ui-sidebar-right）、`remote`（dsh-api-remotes）。建议补全：
  ```json
  "inject": [
    "@deepseek-ai/dsh-client-ui-renderer",
    "@deepseek-ai/dsh-client-ui-conversation",
    "@deepseek-ai/dsh-client-ui-sidebar-right",
    "@deepseek-ai/dsh-api-remotes"
  ]
  ```
- `immediately`：0.2.1 解析并校验为可选布尔（`D021/dsh-client-modules/lib/index.js:62-76`），**不是必填**；已交付的 feature 型客户端插件（`dsh-client-ui-goal/skill/schedule/...` 的 `dsh.client`）都不设它，只有装饰类模板设 `true`。当前不设没问题；若希望「首屏就有 🎲 RP」，可以设 `"immediately": true`（低风险）。
- 手写 bundle 的注册协议兼容：`window.__ModuleLoader__.load({ id, factory })` 与 0.2.1 一致，**id 必须等于包名**（客户端把包名作为浏览器模块 id：`D021/dsh-client-modules/lib/index.js:890-911`、boot graph 行 `graphRow(packageName,...)`；官方模板 `templates/decoration/client.js:1-5`），插件 `client/client.js:13-14` 的 `id: 'dsh-rp-tools'` 正确。
- `require('react')`/`require('react-dom')`：平台种子表提供（官方模板与所有内置 bundle 都这样 require），插件用 try/catch 包 `react-dom` 也安全。

### P2-3 `agent/created` 里同步写诊断文件会拖慢建会话

`lib/index.js:5859-5909` 在 `agent/created` 监听里同步 `writeFileSync` 写 `_agent-probe.json`。0.2.1 的 `agent/created` 是 **serial** 事件且监听器失败会回滚创建（`D021/dsh-agent/lib/index.js:574-590`；文档：`D021/dsh-agent/lib/index.js:474`），同步 IO 会增加新会话创建延迟。建议保留但不写盘（或改成 `process.env.DSH_RP_DEBUG` 时才写）。

### P2-4 文档残留（0.1.5 路径）

`docs/HANDOFF.md:37`、`docs/STATUS.md:191` 仍写 `~/.dsh/profiles/web/node_modules/...`；`docs/` 在发布 `files` 里（`package.json:38`）。与新 README（`README.md:28,56,226` 已写明 0.2.x 预设随包、`.agent-presets` 失效）不一致，建议同步或归档旧文档。

### P2-5 `engines.dsh` 取值说明

`package.json:57-59` 现为 `"^0.2.1-rc.2"`：0.2.1-rc.2 / 0.2.1 / 0.2.2 都满足，0.3.x 拒绝（0.2.1 用 `semver.satisfies(..., {includePrerelease:true})`，`D021/dsh-app-boot/lib/index.js:276-278`）。如果希望兼容 `0.2.0-rc.2` 需放宽为 `">=0.2.0-rc.2"`；建议至少保持 `^0.2.1-rc.2`，因为本审计只对 0.2.1 负责。

### P2-6 `tools/smoke-*.mjs` 的宿主依赖解析（dev 用）

`README.md:219` 已说明：仓库直接跑 smoke 需要能解析到 `@deepseek-ai/dsh-tools`。0.2.1 下这是真话：ESM 不走 `NODE_PATH`，仓库没有 `node_modules` 时 `node tools/smoke-dm.mjs` 会 `ERR_MODULE_NOT_FOUND`。当前仓库根有指向 `/tmp/dsh021root/node_modules` 的符号链接（dev），发布包/新 clone 没有。若想彻底摆脱，可把 smoke 改成从 profile 的安装副本运行（README 已给方式），不阻塞发布。

### P2-7 其余「已确认无影响」的 0.1.5→0.2.1 差异（记录备查）

- `session/created`/`session/disposed` 参数仍是 Session 对象；根上下文（无 scope 标记）的监听器能收到 scope 派发事件（`D021/dsh-scope/lib/index.js:316-338`：`if (tag === undefined) return true`），**不需要** `{global:true}`。
- `session.header` 字段齐全：`id/createdAt/cwd/parentSession/isSeeded/origin/agentPreset`（`D021/dsh-session/lib/index.js:1818-1829`），插件 fork 继承（`header.parentSession + header.isSeeded`）与工作区推导（`header.cwd`，0.2.1 校验绝对路径）都成立。
- 会话 id 形态：GUI/API 新建 = **`session-<uuid>`**（`D021/dsh-api-session-controller/lib/index.js:509`）；store 自动分配 = `session-<n>`（`D021/dsh-session/lib/index.js:1801-1804`）；ACP 新建 = 裸 uuid（`D021/dsh-acp/lib/index.js:1213`）、子代理 = 裸 uuid（`D021/dsh-subagent/lib/index.js:1397`）。插件 `normalizeSessionId`（`lib/index.js:382-390`）剥 `session-` 前缀，两种形态都能归一，且同一进程内所有入口（工具 `exec.agent.id`、路由参数、事件）都会做同样归一 → 自洽。
- `ctx.sessions` 服务名/`get(id)` 仍存在（`D021/dsh-session/lib/index.js:1739,1980-1981`）；`sessionProjections.stateOf(session,key)` 仍存在（`D021/dsh-session-projection/lib/index.js:126`），`agentPreset`、`sessionListMetadata` 投影都在（`D021/dsh-agent-preset-registry/lib/types/session.js:15-31`；`D021/dsh-api-session-controller/lib/index.js:1908`）→ `/rp-tools/gate` 的判定链成立。
- `ctx.tools.restrict({deny})` 成功条件：只 deny **全局层/祖先层** 的名字，且名字必须当前可见（否则抛 `unknown global tool`）。dm-filter 的 deny 由 `ctx.tools.schemas()`（全局视图）推导，天然满足；`tools/change` 事件在 0.2.1 仍会发出（`D021/dsh-tools/lib/index.js:2784, `dsh-agent-preset-registry` 安装/卸载 preset 时也会 emit），所以「装插件后重算 deny」链路保留（`preset/session-filter-v2.mjs:103-121`）。
- `systemPrompt.suppressRuntimeContext()` 仍存在且是**按 scope** 的（`D021/dsh-system-prompt/lib/index.js:289-291`），`settings.suppressRuntimeContext: true` 的语义不变（但见 P1-1：不要用它代替 blank contexts）。

---

## 5. 七个审计点逐条结论

### 5.1 `lib/index.js` 的插件形态

**结论：兼容。** 唯一问题是 P0-1 的模块解析。

| 扩展点 | 0.2.1 证据 | 结论 |
|---|---|---|
| `export const inject = []` + `export function apply(ctx)` | Loader 归一化 ESM 命名导出（`D021/cordis-plugin-loader/lib/index.js:666-671`：`exports.default ?? exports`，命名导出对象含 `apply` 即合法插件） | 兼容 |
| `ctx.inject(['webServer'], cb)` | Cordis 4.0.5 `ctx.inject` = `registry.inject`（`D021/cordis/lib/index.js:743-753,1600-1606`），返回可 await 的 fiber，`cb` 收到注入后的 ctx | 兼容 |
| `hostCtx.effect(() => hostCtx.webServer.register({...}))` | `ctx.effect(callback)` 支持返回 disposer 的函数（`D021/cordis/lib/index.js:1169`）；`WebServer.register(route)` 返回移除函数（`D021/dsh-host-webserver/lib/index.js:326-333`） | 兼容 |
| `webServer.register({kind:'exact', path, handler})` ×25 | 0.2.1 路由对象只有 `{kind:'exact'|'prefix', path, handler}`，**没有 method/auth 选项**，handler 自己写响应（`D021/dsh-host-webserver/lib/index.js:326-333,378-405`；README.zh.md:61） | 兼容（路由自己判 method/同源，插件已这么做） |
| `ctx.on('agent/created')` | payload `{ agent, source, signal }`（`D021/dsh-agent/lib/index.js:574-590`） | 兼容（插件读 `payload.agent`） |
| `ctx.on('session/created'|'session/disposed')` | 参数是 Session（`D021/dsh-session/lib/index.js:1894-1935`；`Session` 有 `id/header/seq/deriveMessages/log`：`:1344-1347,1415,1477,1672`） | 兼容 |
| `ctx.tools.register(defineTool(wrapped))` | 签名一致（`D021/dsh-tools/lib/index.js:2974-2983`；inspect live 契约 `register(definition: ToolDefinition): () => void`） | 兼容（8 个工具实跑通过） |
| `exec.agent.id` 取会话 id | `ToolExecutionInput.agent?: Agent`、`Agent.readonly id: SessionId`（live inspect `Service.listService({service:'tools'})` referencedTypes） | 兼容 |
| `context.agent ?? context.scope`（装配回调） | `AssembleContext = {scope?, signal?}`，无 `agent`；`scope` 就是 agent（`D021/dsh-agent/lib/index.js:291-297` 构造 `{agent, scope: agent}`，但类型上 `scope` 是 `ScopeKey`） | 兼容：插件 fallback 到 `scope`；`agent.session?.id` 在运行对象上存在（`D021/dsh-agent/lib/index.js:514` 直接读 `agent.session.id`），`agent.id` 兜底也对 |
| 会话 id 前缀 | 见 §4 P2-7 | 兼容 |

**建议动作**：P0-1（peer 依赖），其余无需改。

### 5.2 `preset/rp-bridge.mjs`

**结论：兼容（迁移后形态正确）。**

- 预设声明：0.2.1 的 preset = bundle patch 里 `@deepseek-ai/dsh-agent-preset` 一行，`config = { id, plugins, name?, description?, order? }`（`D021/dsh-agent-preset/lib/index.js:7-27`；官方技能 `D021/dsh-agent-preset/skills/editing-cordis-compositions/SKILL.md:14`）。当前 `cordis.patch.yml:13-23` 的 `preset-dm` 行合法；child 行用包内子路径 `dsh-rp-tools/preset/*.mjs`（`cordis.patch.yml:172-192`）配合 `package.json:30` 的 `"./preset/*.mjs"` 导出可解析。
- **旧目录形态已废除**：`$DSH_HOME/.agent-presets/<id>/`「Nothing reads that directory any more」（`SKILL.md:68` 起的 Migrate a legacy preset 段）；注册表 README 也说「注册表不扫描目录，也不接受 preset 路径」（`D021/dsh-agent-preset-registry/README.zh.md:46`）。工作区已删 `preset/agent.cordis.yml`、`preset/preset.yml`、`tools/install-preset.mjs`，正确。
- 子插件作用域：preset 插件树以 `ctx.baseUrl`（profile 目录）解析子行（`D021/dsh-agent-preset-registry/lib/index.js:219-237,226`），mount 需要 scope（同文件 220）；rp-bridge 用 `ctx.tools.register` / `ctx.systemPrompt` 做 **preset 作用域注册**，对绑定到该 preset 的 agent 生效——与 0.2.1 的 scope 模型一致（`scopeTarget` 祖先链准入：`D021/dsh-scope/lib/index.js:316-338`；preset scope 是 agent scope 的父：`dsh-agent-preset-registry/lib/index.js:655-670`）。
- `ctx.tools.schemas()` 语义：无参=全局视图（`D021/dsh-tools/lib/index.js:3119-3121`），rp-bridge 的 `warnIfNoImageTools`（`preset/rp-bridge.mjs:89-101`）用它做「本机有没有生图工具」的判断在 0.2.1 会漏掉 preset 作用域工具——对「宿主生图」而言应该看全局，问题在名字（P0-3）而非 API。
- `systemPrompt.variable(name, provider)`：签名/作用域一致（`D021/dsh-system-prompt/lib/index.js:310-313`；provider 收到 `AssembleContext`）；`section({name,order,text})`（:253-256）、`context(...)`（:279-282）、`suppressRuntimeContext()`（:289-291）一致。
- `system-prompt/assemble` waterfall：签名 `(assembly, context, next)`（live inspect；`D021/dsh-system-prompt/lib/index.js:398`），插件 `await next()` 后改 `sections/contexts`（`lib/index.js:4112-4179`）合法；`PromptAssembly = {sections,contexts,tools,variables}`（inspect referencedTypes）。
- **注意**：装配 waterfall 里**不能**替换 `complete` 段（`dsh-persona` 的 `complete: true`）；DM 预设没开 `complete`（`cordis.patch.yml:24-27` 只给 `prefix`），所以 rp-tools 的 standing 段能生效。
- `preset/rp-bridge.mjs:42-72` 的 profile 解析已按 0.2.x 修（P1-6 只是建议简化）。

**建议动作**：P0-2（补 `tool-web` 行）、P1-1（blank contexts）、P1-6（可选简化）。

### 5.3 `client/client.js`

**结论：兼容。** 槽位名、注册选项、props 与服务都对得上；剩余是 P1-3/P1-5/P2-1/P2-2。

| 用法 | 0.2.1 契约（`D021/dsh-cordis-client-runner/lib/client.js` 槽位目录） | 结论 |
|---|---|---|
| `settings.section` | list 槽；registerOptions `id`(required)/`order`/`label`；ownerProps `{close}`；standardProps 含 `useSessions` | 兼容（`client/client.js:3335-3340`） |
| `conversation.session.header.utilities` | list 槽；`id` required；standardProps 含 `sessionId/useSessions/useInput/inputActions/useChat/...` | 兼容（`:3344-3349`） |
| `conversation.input.dock` | list 槽；standardProps 同上（含 `sessionId/useInput/inputActions`） | 兼容（`:3353-3358`） |
| `sidebar.right.pane.tab` | keyed 槽：`key` required，owner 用「在 force 的类型的 `id`」派发（`dsh-client-ui-sidebar-right/lib/client.js:1284-1288`）；standardProps 含 `sessionId/useSessions/useInput/inputActions/useSession/useProjection...` | 兼容（`:3271-3274`，key=`RP_TAB_ID`=definition.id ✓） |
| `sidebar.right.pane.tab.title` | keyed 槽，dispatch 同上 | 兼容（`:3275-3278`） |
| `ctx.sidebarRightTabs.register({id,kind,title,guide})` | `register(definition)`：`id` 全局唯一、`kind` 按 band 共存、`title(address)` 函数、`guide[]` 条目（`dsh-client-ui-sidebar-right/lib/client.js:4465-4496`） | 兼容；**guide 条目建议补 `id`**（P1-5） |
| `ctx.sidebarRight.openTab(kind)` | 存在；要求当前屏上有 session（`require()`），否则抛（`:2111-2131,2479`）；插件有 `toggleExpanded()` 兜底（`:2236-2255`） | 兼容（`:3239-3252`） |
| `service.isExpanded()` / `service.active()?.kind` | 都存在（`:2236-2255`） | 兼容（`:2475-2504`） |
| `ctx.inject(['sidebarRightTabs','sidebarRight'], cb)` / `disposeInjectHandle` | Cordis `ctx.inject` 返回 fiber，fiber 有 `.dispose`（`D021/cordis/lib/index.js:1020-1091`） | 兼容（`:3234-3286,2463-2468`） |
| `useSessions` 投影字段 | `byId[id] = {sessionId,running,blank,updatedAt,cwd,projectionValues,...}`；`projectionValues.agentPreset` 由 `dsh-client-ui-agent-preset` 同款读取（`D021/dsh-client-ui-agent-preset/lib/client.js:1001-1003`） | 兼容（`client/client.js:2402-2433`）；`s.current` 不存在见 P2-1 |
| `ctx.get('remote').$on('agent-preset/selected')` | 存在且白名单内（P1-3 证据） | 建议声明依赖（P1-3） |

**关于「正文要 `useTabInfo()` 取 panel/tab」**：0.2.1 的 pane.tab 槽确实通过 `hookContext: TabHookContext` 提供 `useTabInfo`（`dsh-client-ui-sidebar-right/lib/client.js:1253-1288`；槽位目录 `hookContext: "TabHookContext"`），但那是**取 tab/panel/sidebar 导航信息**用的；`sessionId/useSessions/useInput/inputActions` 仍在 **standardProps** 里平铺传入（槽位目录 `standardProps` 列表，第 5770-5779 行）。插件只用这四个标准 props、不读 panel/tab，所以**不需要** `useTabInfo`，现有写法正确。

**客户端模块加载协议**：`window.__ModuleLoader__.load({id, factory})` 是 0.2.1 唯一入口（`dsh-client-modules/README.zh.md:38`；官方模板 `templates/decoration/client.js`）；`dsh.client.platform='web'` 在桌面版同样生效（桌面 profile 里 `dsh-context`/`dsh-ops`/`dsh-mcp-studio` 等已安装第三方插件都用 `platform:'web'`）；`inject` 非法值只会在 scan 时 loudly fail，插件当前值是合法字符串数组。

### 5.4 `package.json` 清单 / `cordis.patch.yml` / 预设 YAML

**结论：已按 0.2.1 迁移，格式正确；内容问题见 P0-2/P1-1。**

- `dsh.bundle.patch` 仍是字符串或数组（`D021/dsh-app-boot/lib/index.js:513-525`；`dsh-web-app/package.json` 用数组），当前 `package.json:47-49` 单文件合法。
- `dsh.client` 声明合法（`parseDshClient`：`D021/dsh-client-modules/lib/index.js:62-76`）；`platform` 必填字符串，`inject` 字符串数组可选。
- 元数据：0.2.1 插件页读 `dsh.client` 包的 `exports["./locale/*.json"]`/`exports["./icon"]` 与 `meta.title/meta.description`（`D021/dsh-app-boot/lib/index.js:2199-2247` 的 `readPluginMeta`），工作区已加 `locale/en.json`、`locale/zh.json`、`icon.svg` 并写入 `exports/files`——正确。
- 预设 YAML 的 `!!js` 用法：不必；`config.plugins` 里允许 `!!js`（Loader 在子插件激活时求值，官方技能 `SKILL.md:59` 一带）。当前无表达式，安全。
- 旧 `preset/preset.yml`（name/description/order）字段已一一映射到 `preset-dm` 的 `config.name/description/order`（`cordis.patch.yml:19-22`），无遗漏。
- `agent.cordis.yml:189-200` 里的旧「`tool-fs-search` 必须显式给 `sampleOverCapGlobResults`」在 0.2.1 仍是硬要求（`D021/dsh-tool-fs-search/README.zh.md` 配置表：该键必填无默认），当前 `cordis.patch.yml:166-169` 已带 `sampleOverCapGlobResults: false` ✓。

### 5.5 模块解析（桌面 profile 只有 3 个 `@deepseek-ai` 包）

**结论：普通安装 OK；`link:` 安装有坑（P0-1）。**

0.2.1 不再用 `NODE_PATH`/fallback 链接，而是在挂载 profile 前把一份 **runtime resolution** 装进 Node 的 ESM/CJS 解析器（`D021/dsh-app-boot/README.zh.md` 的「Profile」段；实现 `D021/dsh-app-boot/lib/index.js:766-799,1846-1870`）。解析表 = 安装依赖闭包（installation scope，`@deepseek-ai/dsh-tools` 经 `dsh → dsh-base → dsh-tools` 进入）+ profile bundle 依赖闭包（profile scope）+ linked roots。

- 普通 registry/git/tarball 安装：插件 realpath 在 profile 内 → `routeScoped` 直接命中 installation 条目 → `import '@deepseek-ai/dsh-tools'` 解析到安装目录的 0.2.1 副本，**不需要**插件声明依赖（官方文档也明说「bundle 对随 dsh 交付的包不需要声明依赖」：`D021/dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md`）。
- `link:`/本地目录安装：realpath 在 profile 外 → tracked 为 linked root（`linkedProfileRoots`），走 `routeLinked`，**必须**由某个祖先 `package.json` 的 `peerDependencies` 点名才拦截（P0-1 证据 3）。
- `rp-bridge.mjs` 的 `createRequire(<profile>/package.json).resolve('dsh-rp-tools')`：0.2.1 仍可行（CJS resolve 从 profile 出发，跟随符号链接到 realpath），且与宿主行共享模块实例（同 realpath → 同 URL → 同 ESM 缓存）；但见 P1-6，建议改成按包名导入。

### 5.6 `tools.defineTool` / schema DSL / `webServer.register` 选项

**结论：兼容（已动态验证）。**

- `defineTool(options)` 在 0.2.1 要求 `name/description/parameters/output:{schema,render,...}/execute`（`D021/dsh-tools/lib/index.js:838-887`；`D021/dsh-tools/lib/types/schema.js`）。插件的 8 个工具用 0.2.1 真实实现跑通（见 §1）；`required` 只允许在「属性」层出现、`object` 必须显式 `additionalProperties`、`array.items` 不带 `required`、`enum` 只允许标量——插件的写法全部满足。
- `webServer.register` 选项不变（只有 `kind/path/handler`，没有 `method/auth`，`registerUpgrade`/`registerFallback` 另有）；插件 25 条路由 `kind:'exact'` 写法正确；handler 内自己判 method 与同源（0.2.1 README 明说「不提供服务器级认证或来源策略——route owner 自己实施」：`D021/dsh-host-webserver/README.zh.md:130`），插件已有 `sameOrigin()`。
- 路由异常处理：0.2.1 对 handler 抛错返回 400/warn（`D021/dsh-host-webserver/lib/index.js:395-405`），不退出进程；插件自身 `try/catch` + 405/403/500 的语义一致。

### 5.7 客户端 bundle 注入与 `dsh.client.inject`

**结论：兼容。** 见 §5.3 与 P2-2：

- 手写 bundle + `window.__ModuleLoader__.load` 合法；factory 的 `require` 由平台种子表解析（`react`/`react-dom` 可用）。
- `id` 必须=包名（`dsh-rp-tools` ✓）。
- `dsh.client.inject` 合法；0.2.1 无需声明 `@deepseek-ai/dsh-client-*` 依赖（种子表 + 图行解析）；建议补全实际依赖用于预加载顺序。
- `immediately` 可选，不设也可（已交付 feature 插件均不设）。

---

## 6. 待实测清单（按优先级）

| # | 目的 | 方法 | 期望 |
|---|---|---|---|
| 1（P0-1） | 验证 `link:` + 无 repo node_modules 时主模块导入 | 新 clone 到临时目录（无 node_modules）→ `dsh plugin --profile rptest2 add link:<clone>` → 启动 `dsh --profile rptest2 --no-open --port 0` 观察 stderr | 修复前应见 `Cannot find package '@deepseek-ai/dsh-tools'`；加 peer 后行激活、`GET /rp-tools/tools` 返回 8 工具 |
| 2（P0-2） | DM 会话有没有 `web_search` | 新建 DM 会话，检查该会话 agent 的可见工具（会话日志 tools 声明，或从 DM 会话内发起一次检索） | 加 `tool-web` 行后出现 `web_search`/`web_fetch` |
| 3（P0-3） | 生图/GenUI 工具名与放行链路 | 装可选 GenUI/生图插件 → 设置页勾选 → DM 会话 `rp_assets import` 收一张图 | 工具可见；`codex_image_generate` 等非标准名被默认名单识别或可由用户勾选 |
| 4（P1-1） | context 泄漏是否仍在 | DM 会话跑 1 轮 → 读 `~/.dsh/data/dsh-rp-tools/_standing-probe.json` 与 session log 的 `request/context` | 修后不应出现 `Current DeepSeek Harness implementation checkout` / `Web GUI URL` |
| 5（P1-3） | 预设切换广播订阅 | DM 会话切走再切回，不刷新页面 | 🎲 RP 按钮恢复；DevTools 确认 `remote` 非 undefined |
| 6（P1-4） | 宿主自动登记 | 新建 DM 会话后读 `_agent-probe.json` | `foundPreset: "dm"`、`autoMarked` 存在 |
| 7（P1-5） | guide 条目 | 打开右栏引导页 | 出现「🎲 RP 跑团面板」；无 console 报错；加 `id` 后仍正常 |
| 8（§5.1） | 25 条 `/rp-tools/*` 路由在桌面 GUI 可达 | 页面内 DevTools fetch `/rp-tools/state`（同源） | 200 JSON；不是 404/403（若桌面版对 GUI 有全局 token 鉴权，需要实测是否覆盖插件路由） |
| 9（§5.3） | 客户端 bundle 在桌面加载 | 页面 DevTools 看 `window.__DSH_BOOT__` 含 `dsh-rp-tools` 行、RP 设置页出现 | 正常注册与渲染 |
| 10（§5.1） | 根监听取 scoped 事件 | DM 会话 fork 一次（生成子会话）看子会话是否继承 RP 配置 | fork 继承生效（`session/created` 根监听可收 scope 派发） |
| 11（§5.4 / 预设激活审计） | 整棵 preset 子树是否 all-or-nothing 通过 | 装插件后：`cordis_inspect_query` host `Config.listConfigs({"name":"@deepseek-ai/dsh-agent-preset"})` 看 `preset-dm` 行 activation 状态；再新建 DM 会话触发 `mountPreset` | 无 failed 行、无 leaked service；`persona/tool-fs/tool-fs-search/tool-ask-user/dm-filter/rp-bridge` 全部 active（mount 失败会让该 preset 不可用：`D021/dsh-agent-preset-registry/lib/index.js:206-237`） |

---

## 7. 附：关键证据路径索引

**0.2.1（`D021`）**

- `dsh-app-boot/lib/index.js:276-298`（prerelease 语义 + engines/peers 兼容门禁）、`664-692`（linked roots）、`1613-1730`（ESM 路由：routeScoped/routeLinked）、`1846-1870`（解析拦截安装）、`2305-2310`（preset 子行 preflight/baseUrl）、`4525`（Loader baseUrl=profile 目录）、`766-799`（runtime resolution 表）
- `dsh-host-webserver/lib/index.js:326-333,378-405`；`README.zh.md:61,130`
- `dsh-tools/lib/index.js:838-887,2974-2983,2991-3006,3119-3121`；`lib/types/schema.js`（DSL 编译）
- `dsh-system-prompt/lib/index.js:10-52,117-118,151-155,253-291,310-313,356-406`
- `dsh-scope/lib/index.js:316-338`
- `dsh-agent/lib/index.js:291-297,474,512-516,549-590`
- `dsh-session/lib/index.js:1344-1347,1415,1477,1672,1739,1801-1829,1894-1935,1980-1981`
- `dsh-agent-preset/lib/index.js:7-27`；`dsh-agent-preset-registry/lib/index.js:219-237,655-670`、`README.zh.md:46`；`dsh-agent-preset/skills/editing-cordis-compositions/SKILL.md:14,68`
- `dsh-harness-dev-context/lib/index.js:26-27,102-122`
- `dsh-client-modules/lib/index.js:62-76,851-911`；`lib/client.js:776-794`；`README.zh.md:34,38`
- `dsh-client-ui-sidebar-right/lib/client.js:455-538,1253-1288,2111-2131,2236-2255,4465-4496,4617-4623`
- `dsh-cordis-client-runner/lib/client.js:3339-3398（input.dock）,3999-4057（header.utilities）,5292-5343（settings.section）,5748-5798（pane.tab）`
- `dsh-api-remotes/lib/types/remote-events.js:17`；`dsh-api-session-controller/lib/index.js:509,1908`
- `dsh-web-app/cordis.patch.yml`（host 行禁用 + preset 注册表）、`presets/standard.patch.yml:27-30,116-117`、`dsh-base/cordis.patch.yml:292-301`
- `dsh-persona/README.zh.md:40-49`（prefix 必填、suffix 空串遮蔽、模板严格插值）
- `dsh-plugin-manager/lib/index.js:933`（本地目录 = link:）
- `cordis/lib/index.js:258-264,743-753,1020-1091,1169,1600-1606`；`cordis-plugin-loader/lib/index.js:666-671`
- `dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md`（bundle 清单/导出形态/不需声明随 dsh 交付包的依赖）、`references/ui-plugin.md`（客户端 bundle 协议）

**插件（工作区，2026-10-25 02:0x）**

- `lib/index.js:11,17,4255,4266-5579,3983-4183,4219-4252,5778-5910,5913-5935,5943-5963`
- `preset/rp-bridge.mjs:42-72,74,89-101,103-125`
- `preset/session-filter-v2.mjs:46-52,62,94-100,103-121,124-131,133-142`
- `client/client.js:13-25,2388-2433,2436-2448,2463-2504,3202,3234-3286,3296-3313,3323-3358`
- `cordis.patch.yml:13-23,24-27,39-43,100-139,141-163,164-171,172-192`
- `package.json:24-33,34-45,46-59`
- `lib/global-tools-defaults.js:33-42,65-108`

**已删除的旧形态（HEAD 可查，供对照）**

- `preset/agent.cordis.yml`（HEAD:1-206，目录形态的 preset 条目列表）
- `preset/preset.yml`（HEAD:1-3，name/description/order → 已映射到 `preset-dm` 行）
- `tools/install-preset.mjs`（HEAD:6-7,42-46,141-156：向 `$DSH_HOME/.agent-presets/<id>/` 拷贝、按旧 profile 自检）
