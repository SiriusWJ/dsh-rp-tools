# 交接文档（HANDOFF）—— 在新会话里继续开发

> 目标读者：**没有任何上文的新会话**。读完这一份即可继续改这个插件。
> 快照：2026-09-12 · v1.4.0 · commit 见 `git log`

---

## 0. 一句话现状

插件**已可用且已实测**：10 个 `rp_*` 工具、10 种风格、会话级战役配置、世界书、状态追踪、
角色卡 8 字段、设置页与右侧栏 DM 面板，以及**PNG 故事书（角色卡）导入**——
在工作区那一行点「📖 导入 PNG 故事书」→ 选卡 → 自动切 dm 预设 + 写世界书 + 开场。

**架构已收敛为「一切都在 dm 预设作用域」**：host 组合里**不注册任何模型工具**，
全部 10 个工具（含 `rp_random`）与两条提示词注入通道都由 dm 预设的 `rp-bridge.mjs`
在 agent 作用域注册 —— 非 dm 会话既看不到工具，上下文里也不会出现跑团内容。

冒烟测试 **262 条断言全绿**（`tools/smoke-dm.mjs` 194 + `tools/smoke-card.mjs` 64 +
`tools/smoke-client.mjs` 4 项 + `tools/verify-roundtrip.mjs` 4 条）。
**待界面确认**：右栏 RP 面板与故事书导入面板的实际渲染（见 §5.1 / §5.2）。

---

## 1. 关键路径

| 用途 | 路径 |
|---|---|
| 源码（权威） | `D:\Code\dsh\rp-tools-plugin` |
| GitHub | `https://github.com/SiriusWJ/dsh-rp-tools`（public，分支 `main`，topics 含 `dsh-plugin`） |
| 安装位置（profile） | `~/.dsh/profiles/web/node_modules/dsh-rp-tools`（`file:` 依赖 = **安装期拷贝，不会自动跟随源码**） |
| 数据目录 | `~/.dsh/data/dsh-rp-tools/`（`styles.json` / `sessions/<id>.json` / `dm-sessions.json` / `_agent-probe.json` / `_standing-probe.json`） |
| 世界书（**按会话隔离**） | `<会话工作区>/rp-sessions/<会话 id>/rp-worldbook.md` —— 工作区取自 `session.header.cwd`（如 `D:\Story`）。老版本在工作区根目录，首次读取时会**一次性迁移**一份过来（旧文件保留） |
| PNG 卡库（导入源） | `D:\Story\sillytavernassets`（3269 张，`cards/<分类>/*.png`）—— 设置页「卡库目录」可改，存 `styles.json` 的 `cards.root` |
| 导入产物（按会话） | `<会话工作区>/rp-sessions/<会话 id>/cards/<slug>.{md,json,png}`（卡全文 / 规范化结果 / 卡面） |
| 卡库目录 | `cards.root`（设置页）；**留空 = 会话工作区下的 `rp-cards/`**。不再有任何固定路径兜底，也不再有私有索引 |
| dm 预设 | `~/.dsh/.agent-presets/dm/agent.cordis.yml`、`~/.dsh/.agent-presets/dm/rp-bridge.mjs`（仓库内有副本 `preset/rp-bridge.mjs`） |
| ComfyUI | Comfy Desktop **0.35.0** · `http://127.0.0.1:8188` · RTX 5080 16GB |
| 模型 | `E:\AI\Models\models\{diffusion_models,text_encoders,vae,loras}`（`Documents\ComfyUI\models` 是指向它的 junction） |
| 重启器 | 计划任务 `dsh-rp-restart` → `D:\Code\dsh\comfyui-workflows\rp-restart.cmd`（延迟 75 秒后 POST dsh-restart-btn 的重启接口） |

---

## 2. 当前功能（10 个工具，**全部只在 dm 预设作用域**）

| 工具 | 作用 |
|---|---|
| `rp_random` | 骰子 / 区间 / 加权抽取 / 布尔；`seed` 可复现 |
| `rp_styles` | 列出风格（触发词 / CFG / 步数 / 尺寸预设） |
| `rp_illustrate` | 按风格出一张图（`prompt`* `style?` `seed?` `aspect?` `width?` `height?`） |
| `rp_character` | 角色卡增删查 + 立绘（8 个字段，含 `first_mes` / `mes_example` 两个**样本字段**） |
| `rp_state` | 状态追踪：场景 / 时间 / 地点 / 在场 / 线索 + 队伍（状态·持有·伤病·目标）+ 自由旗标 |
| `rp_lore` | 世界书：`list` 目录 / `find` 按条取 / `template` 生成模板（在会话工作区） |
| `rp_session` | 本会话配置：世界 / 前缀 / 会话默认风格 / 风格备注 / 战役名 |
| `rp_scenes` | 按 `scenes[].panels[]` 逐格批量出图 |
| `rp_config` | **全局**配置：负面词 / 全局默认风格 / ComfyUI 地址 / 单风格字段 |
| `rp_table` | 随机表（表名 + 骰式 + 条目）定义与掷表 |

⚠️ **全部 10 个都在 dm 预设作用域**（连 `rp_random` 也是）—— 由 `rp-bridge.mjs` 调
`registerRpTools(ctx)` 注册。**host 组合里一个模型工具都不注册。**
早先 `rp_random` 是全局的，为此 dm 预设的白名单还得放行它；现在白名单只剩 3 项
（`render_ui` / `validate_dsh_ui` / `web_search`）。

**界面**：设置页「RP工具」（全局配置 + 风格库卡片 + 工具列表：只列名字与一句话说明）；DM 会话头部**右上角**「🎲 RP」按钮 → 把 RP 面板作为**右侧栏页签**打开（世界 / 角色卡 / 随机表 / 本会话生图配置），右栏自带收起与浮动。**工作区那一行**（`conversation.input.dock`，id `rp-card-import`，order 15）还有「📖 导入 PNG 故事书」入口 —— 见 §3 ⑩。

**风格库可增删**（设置页）：
- 卡片里每条风格的 **LoRA 用下拉选取**（清单来自 ComfyUI `/object_info/LoraLoaderModelOnly`，经 `/rp-tools/loras` 代理；非 krea2 的 LoRA 会标注出来）。
- 「＋ 新增风格」填 key / 显示名 / LoRA / 触发词 → 点「加入风格库」→ 再点「保存」才落盘。
- 自定义风格可「删除」；**内置 10 种不给删**（客户端不给按钮，`applyStyleOps()` 里也独立挡了一层）。
- ⚠️ 提交顺序很关键：`/rp-tools/config` 里 **`applyStyleOps()` 必须跑在字段补丁之前**，
  否则新增的风格还不存在，`if (!st) continue` 会把它的全部字段静默丢掉（踩过）。
  同理，add/duplicate 失败的 key 会进 `failedKeys`，调用方据此**跳过该 key 的补丁** ——
  不然补丁会盖到同名旧条目上，把已有风格悄悄改掉。

---

## 3. 架构要点（改代码前必读）

**① 宿主半侧拆成两个入口**（`lib/index.js`）：

| 入口 | 作用域 | 做什么 |
|---|---|---|
| `apply(ctx)` | 全局（host 组合） | **不注册任何模型工具**。只注册 12 条 HTTP 路由（设置页 / 客户端 / 媒体代理）+ 监听 `session/created`（fork 继承配置、记录工作区）。 |
| `registerRpTools(ctx)` | agent（由 dm 预设的 `rp-bridge.mjs` 调用） | 注册**全部 10 个** `rp_*` 工具（每个的 `execute` 包一层 `markDmSession` 保底登记）+ 挂两条提示词注入通道。 |

各自的依赖声明：

```js
// lib/index.js
export const inject = [];                     // 全局：连 tools 都不需要（路由走 ctx.inject(['webServer'])）
// preset/rp-bridge.mjs
export const inject = ['tools', 'systemPrompt'];
```

**为什么注入必须放在 agent 作用域**（这是踩过的架构错误，别改回去）：
`system-prompt/assemble` 是**按作用域过滤**的事件（契约原文：*scoped listeners receive only
that scope's assemblies*），所以在 agent 作用域注册时，回调**只会收到本会话的装配** ——
「只在 DM 会话生效」与「会话隔离」都由 Cordis 免费保证。

早先版本把它注册在全局 `apply()` 里，还为此写了一套「猜当前会话」的启发式
（记 `session/created`、按会话文件修改时间挑、可手动指定优先）。两个错：
① 全局注册让**每个会话**都带上跑团世界观；
② 猜会话**猜错时会把别的战役设定注进来**（实测：把 9 角色无世界的会话当成目标，而不是 861 字世界的那个）。
现在这些代码**全部删除**，会话 id 直接取作用域自带的 `ctx.agent.id`。
回归测试：`tools/smoke-dm.mjs` 里「全局不注册任何模型工具」+「注入只由 agent 作用域注册」。

**② 生图链路**：`buildWorkflow(style, {...})` 生成 API 工作流 → `POST {baseUrl}/prompt` → 轮询 `/history/{id}` → 图片经**插件自己的同源代理** `/rp-tools/media` 返回（URL 形如 `http://127.0.0.1:3080/rp-tools/media?file=…`，前端据此渲染成聊天卡片）。**不依赖 dsh-comfyui**。

**③ 会话 id 归一化**（关键，刚修）：工具侧 `exec.agent.id` 形如 `session-<uuid>`，而会话目录 / 客户端 `useSessions().current` 是裸 `<uuid>`。`normalizeSessionId()` 统一剥掉 `session-` 前缀，`loadSession` 兼容旧文件名，`isDmSession()` 两种写法都能命中。

**④ 客户端三处贡献**（`client/client.js`）：
- `settings.section` id `rp-tools` → 设置页卡片；
- `conversation.session.header.utilities` id `rp-tools` → 会话头部**右上角**的「🎲 RP」入口（只在 DM 会话渲染，非 DM 返回 `null`）；
- `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title` key `dsh-rp-tools` → **RP 面板本体，作为右侧栏页签**。

  **面板为什么在右栏而不是浮层**：早期版本用 `shell.overlay` 自己画浮层（ComfyUI 面板也是这个做法），
  既丑又不能收缩。现在改为注册成右栏的一种页签，**收起 / 浮动 / 关闭 / 拖拽全由 DSH 右栏负责**，插件不再自己管定位。
  接线三件套（缺一不可）：

  ```js
  // ① 类型的静态面（kind 是 openTab 的入参；id 是 body/title 两个座位的 key）
  ctx.inject(['sidebarRightTabs', 'sidebarRight'], (injected) => {
    injected.sidebarRightTabs.register({ id: 'dsh-rp-tools', kind: 'dsh-rp-tools',
      title: () => '🎲 RP', guide: [{ order: 30, title: () => '🎲 RP 跑团面板' }] });
    // ② 页签里的面板主体
    injected.slots.inject('sidebar.right.pane.tab', () => injected.slots.register(
      { name: 'sidebar.right.pane.tab', key: 'dsh-rp-tools' }, (props) => h(RpSidebarTabBody, props)));
    // ③ 右栏条上的小标题
    injected.slots.inject('sidebar.right.pane.tab.title', () => injected.slots.register(
      { name: 'sidebar.right.pane.tab.title', key: 'dsh-rp-tools' }, () => h(RpTabTitle)));
  });
  ```
  打开动作：`ctx.sidebarRight.openTab('dsh-rp-tools')` —— **它会顺带展开右栏**（官方原话：
  「`openResource` 与 `openTab` 是导航控制器，进入这一列的每一条路都是对它们之一的调用」），
  不需要自己再调 `layout.openRightbar()`。
  ⚠️ 导航必须用**注入了 `sidebarRight` 的那个 ctx**（延迟注入回调的参数），不能用 `apply(ctx)` 的根 ctx，
  否则 `ctx.sidebarRight` 是 undefined。

  判定 DM 会话的顺序（**改这里之前先读完**）：
  1. **权威**：`props.useSessions((s) => s.byId[sessionId]?.projectionValues?.agentPreset) === 'dm'`
     → 是 DM，直接渲染，并（每个会话一次）POST `/rp-tools/dm-mark` 把判定落到宿主。
  2. **回退**：预设还没投影出来（旧会话 / 刚切过去）→ 查 `/rp-tools/session?sessionId=` 的 `isDm`。
  3. 两个都说不清 → `return null` / 提示「不是 DM 会话」。

  会话 id 取法：`[props.useSessions(s => s.current), props.sessionId, props.session?.id]` 里第一个**非空字符串**。
  ⚠️ 别写成 `String(fromHook || props.sessionId || '')`：钩子初值是 `undefined`、切换期可能是**空串**，
  空串会把后面的兜底全短路掉 → `isDm` 永远 false → **入口静默不出现**（这正是最难查的那类 bug）。
  槽位契约实测（`cordis_inspect_query` Slots）确认 `standardProps` 同时含 `useSessions` 与 `sessionId`；
  `useSessions` 的 store 是 `@deepseek-ai/dsh-api-session-controller` 的 `list`，`current` 存**裸 id 字符串**。
  （为什么不用 `conversation.view` 页签：它**无法按会话条件注册**，一注册就所有会话都出现。）

**⑤ 全局 vs 会话**：全局 = 风格库 / ComfyUI 地址 / 负面词 / 全局默认风格（`styles.json`）；会话 = 世界 / 角色卡 / 随机表 / 前缀 / 会话默认风格 / 风格备注 / 战役名（`sessions/<id>.json`）。

**⑥ fork 分叉要继承会话配置**（`copyRpSessionFromParent()` + `session/created` 监听）。
RP 配置按会话 id 存，而 fork 出来的是**新 id** —— 不处理的话用户分叉后世界/角色卡/随机表全「消失」。
谱系信息 DSH 自己给，全在 `session.header` 上：
- `parentSession` = fork 来源会话 id；
- `isSeeded` = 该日志含 fork 继承的事件前缀（**resume 是 false**，所以重启恢复不会被误判成 fork）；
- `agentPreset` = 会话用的预设（判定 DM 用得上）。
判定条件：`header.parentSession && header.isSeeded`。复制是**快照**语义（父子之后各改各的）；
子会话已经自己写过配置就不覆盖。注意这是宿主半侧改动，**要重启才生效**。

**⑦ 两条提示词注入通道**（`installStandingPrompt()`，**只在 dm 作用域注册**）：

| 通道 | 段名 | order | 放什么 |
|---|---|---|---|
| system 段 | `rp:standing` | 210 | 战役名 / 世界设定 / **角色索引**（逐字节稳定） |
| runtime context | `rp:turn` | 20 | 当前状态 + 世界书命中 + **在场角色的详细卡**（每轮不同） |

- **order 210 是刻意的**：工具说明占 100–199，稳定骨架放其后，即使骨架抖动，稳定的工具前缀仍能命中前缀缓存。
- **未配置时写固定短文案，而不是把段删掉** —— 避免段布局抖动打穿缓存。
- 内容必须**逐字节稳定**：不掺时间戳/随机数/轮次号。常驻内容放 standing、每轮变化的放 context。
- **角色卡分两层注入**：standing 只放「名字 + 一句简介 + 是否常驻展开」的**索引**
  （`renderCharacterIndex`，字节数不随角色数增长）；详细卡片进 turn 通道，且**只在角色出场的那几轮**
  （`charactersToExpand`：名字出现在最近对话里，或被标了 `always`）。
- **宏表（按会话隔离）**：会话配置里的 `macros: { user: '阿岚', place: '广寒宫' }`。
  - 值在**第一次导入时由界面问用户**（默认取全局「玩家称呼」，可改，也能加自定义宏）；
    预览接口 `GET /rp-tools/card` 会返回卡里扫到的宏名（`discoverMacros`＋`collectCardText`）供预填；
  - RP 面板有「宏 / 变量」卡片，任何时候都能改；`rp_session(action:"set", macro_name, macro_value)` 让 DM 也能设；
  - 注入时由 **`systemPrompt.variable(name, provider)`** 在 agent 作用域逐名注册（`macroVars`/`macroRegistrars`/`macroValueCache`），
    所以世界设定 / 世界书条目里写的 `{{x}}` 会**跟着面板改的值变**（不是把值烤进文件）；
  - 未注册的宏由 `neutralizeMustache(text, known)` 换成全角 —— 宿主对未知变量是**严格**的（直接抛错）；
  - **自动宏**（`time` / `date` / `datetime` / `weekday` / `isotime` / `localtime` / `timezone`）：永远注册、值在装配时现算，
    导入界面把它们列出来并标「自动」（不用填）；用户也可以填个固定值把它**钉死**（例如游戏内时间「子时三刻」）。
    注意：写进 standing 段的自动宏每轮都变，会打穿前缀缓存 —— 放进世界书条目（走 turn 通道）没这个问题。
  - `{{char}}` 仍是**导入时展开成卡名**：一场戏可能多角色，全局变量表达不了它。
  - ⚠️ 注册必须发生在**该会话的 agent 作用域**；路由（全局作用域）改完宏表要通过 `refreshSessionMacros` 回调进去，
    否则要么污染别的会话，要么下一轮装配因未知变量抛错。
- **身份宏 `{{user}}`**：是宏表里的一个普通键，默认值取全局「玩家称呼」；
  （DSH 原生的插值机制，语义上等价于酒馆那边的「身份宏」），所以用户在**世界书条目 / 世界设定里手写**的
  `{{user}}`（哪怕是我们导入之后才写的）也会被正确替换成玩家称呼（设置页「玩家称呼」可改）。
  `neutralizeMustache()` 因此要**放行注册过的变量、只中和没注册的宏** —— 宿主对未知变量是**严格**的（直接抛错）。
  `{{char}}` **没有**全局注册：一场戏可能有多个角色，全局变量表达不了它；导入时按卡名展开仍走 `resolvePlaceholders`。
- **其余 `{{…}}` 必须中和**（`neutralizeMustache()`）：宿主会对 section 做变量插值，
  未注册的写法会被当未定义变量**抛错**。

**⑧ 状态追踪**（`rp_state` + `applyStateUpdates` / `renderState`）：
解决的不是「记不住上一幕」（那在上下文里），而是**只有叙述文本承载的「变化」会在上下文压缩后消失**
—— 伤势、东西在谁手里、关系转变、伏笔。
- 字段：`scene/time/location/present/clues` + `party[]`（character/status/inventory/conditions/goal）+ 自由 `flags`。
- **空串即清除**（先删后设），不留幽灵键 —— 伤势好了、东西用掉了能真的清掉。
- 注入在 turn 通道**最前**（最权威）；`FLAGS_MAX_SHOWN` / `FLAG_VALUE_CHARS` 是成本护栏。
- 更新靠**模型主动调工具**，不解析叙事正文（解析自由文本很脆）。
- `renderState` 会在状态多轮未更新时附一句提醒（防静默漂移）；测试断言渲染结果**绝不含 `undefined`**
  （曾经因 `clues` 漏配显示名而输出 `undefined：…`）。

**⑨ 世界书**（`parseLoreMarkdown` / `activateLore` / `renderLore`）：
条目存**会话工作区根目录的 `rp-worldbook.md`**（路径来自 `session.header.cwd`）。
用户能用任何编辑器改，DM 也能用 read/write 维护，还能用 `rp_lore(action:"template")` 一键生成模板。

解析规则：**`##` 开新条目**（单个 `#` 是文档标题，不参与解析）；`<!-- keys: … | constant | order: N | prob: N -->`；
不写 keys 就用标题当触发词。

激活语义（刻意比参考实现简单）：常驻无视关键词；其余**子串匹配**（中文场景不做整词匹配）；
`prob < 100` 用**确定性掷点**（种子 = `会话:轮次:条目名`，用 `session.seq` 当轮次），
**复用 rp_random 的同一套 PRNG**（`hashSeed` + `mulberry32`），所以可精确回放；
预算按「常驻优先 → order 降序」取，**被裁的进 `dropped` 并列标题**（不静默丢弃）。

刻意**不做**：inclusion group 随机竞争、sticky/cooldown/delay 定时器、多来源分层 ——
都是参考实现花大代价的部分，与「轻量」定位不符。

**面板里各字段由谁编辑**（改界面时注意）：
- 面板直接给了输入框的：世界设定、角色卡、随机表、**生图配置卡片里的「会话默认风格」**。
- **只由 DM 用 `rp_session` 工具维护、面板不放输入框的**：提示词前缀 / 风格备注 / 战役名。
  面板保存时把这些字段**原样回写**（`save()` 里送的是 `draft.campaign` / `draft.styleNotes`），
  所以精简界面**不会**清掉 DM 已经设好的值 —— 别为了「干净」改成发送空串。
- **负面词只属于全局**（设置页「RP工具」），会话面板里不该出现它的说明或入口。
  面板的「生图配置」卡片只留「会话默认风格」。

**⑩ PNG 故事书（角色卡）导入**（`lib/card-png.js` + `lib/card-import.js` + 4 条路由 + 客户端一个槽位）

调研数字（`docs/PNG-CARD-DECODE.md`，3269 张实测）决定了全部设计：
`first_mes` **100% 是广告**（必须换成 `alternate_greetings`）、**40% 的卡正文只在 `character_book` 里**
（导入主战场是世界书而不是字段）、**32% 的条目没有 keys**（不补 `constant` 就是死条目）、
单卡最大 167 万字（必须限量，其余写文件让 DM 按需 `read`）。解码细节（`tEXt`/`iTXt`/`zTXt`、`ccv3` 优先、
截断容错）见 `lib/card-png.js`，映射规则见 `lib/card-import.js` 顶部注释。

数据流（**解析全在宿主**，浏览器只拿摘要）：

```
客户端(conversation.input.dock)          宿主(lib/index.js)
  打开面板 ──GET /rp-tools/cards──────────▶ 列卡库（服务端过滤 + 分页，索引 482KB 不落地）
  选一张   ──GET /rp-tools/card?path=─────▶ 解码 PNG → 摘要 + 预览（不落盘）
  点导入   ──POST remote.agentPresets.select(sessionId,'dm')──▶ 切预设（空白会话才允许）
           ──POST /rp-tools/card-import───▶ ① 世界书**追加合并**进 <工作区>/rp-worldbook.md
                                            ② 卡全文写 rp-sessions/<会话 id>/cards/<slug>.md（超预算条目的去处）
                                            ③ 规范化结果写 rp-sessions/<会话 id>/cards/<slug>.json
                                            ④ 卡面复制成 rp-sessions/<会话 id>/cards/<slug>.png
                                            ⑤ 角色卡合并/世界覆盖/立绘登记进会话配置
           ◀─{lore, files, opening, stats}─┘
  开始游戏：inputActions.setDraft(opening) → submit()
```

几条**必须保留**的设计约束：

- **路径安全是硬边界**：`safeCardPath()` 用 `resolve()` + 前缀比对把路径锁在卡库根内，且只认 `.png`。
  这条路由会把磁盘内容交给浏览器，不校验等于开了个任意文件读取。逃逸/绝对路径/非 png/不存在 → 400，
  回归测试 4 条（`/rp-tools/card` 与 `/rp-tools/card-image` 各两条）。
- **世界书只追加、不重写**：`mergeWorldBook()` 按标题去重后把新条目**原文贴到文件末尾**。
  刻意不走「解析 → 重新渲染」——那会把用户手写的注释与格式全部抹掉。导入是外来动作，不该动用户那部分。
- **卡库只由 `cards.root` / 会话工作区决定**（私有索引那条路已按用户要求整条删除；`lib/card-index.js` 也不再需要）：用 **动态 `import()` + try** 拿（静态 import 一旦文件不存在，
  整个插件加载失败）；且**只在卡库根 == 内置默认根**时用它 —— 索引里的相对路径是相对默认根生成的，
  换了根目录还用它就会列出一堆不存在的路径（踩过一次）。没有索引就退回 `scanCardDir()` 扫目录。
- **预设切换用官方接口**：`ctx.get('remote').agentPresets.select(sessionId, 'dm')`（hero 上的预设
  chip 用的是同一个）。宿主对**已开局**的会话会拒绝（`agent-preset/locked`），所以那时先
  `ctx.get('uiWorkspace').startSession()` 新建空白会话再继续。切不动时**不静默**：把原因显示出来，导入照做。
- **开场指令显式拦住 persona 的开场提问**：dm 预设的 persona 第一条就是「开局先问玩家世界从哪来」，
  所以 `buildOpeningPrompt()` 里必须写「**不要再问世界从哪来**」，否则 DM 会先反问一句，导入的设定白导。
- **待办导入放模块级**（`pendingImport`，不是组件 state）：新建会话会让**会话作用域的槽位子树重新挂载**，
  组件 state 被重置，任务就永远等不到接手的那次渲染。
- **提交开场那一句**：`inputActions.setDraft(text)` → 等 `useInput(s=>s.draft)` 与目标一致 → `submit()`；
  另有 1200ms 兜底直接提交（免得卡在等同步）。
- `slug` **只去掉 `.png`**，保留 `.card` 标记：卡库里 `X.card.png` 与 `X.png` 可以并存，
  去掉就撞成同一个 slug，导入第二张会覆盖第一张的全文与卡面。
- 卡面同时进会话配置 `session.portraits[角色名] = { card: <卡库相对路径>, file: <工作区相对路径> }`：
  `card` 给界面拼 `/rp-tools/card-image` 的 URL（只服务卡库内的文件），`file` 是工作区自带的那份。
  面板的立绘区因此变成「生成的立绘优先，导入的卡面垫在后面」。

**真卡库探针**（不是单测，是手动诊断）：`node tools/probe-cardlib.mjs [每类抽样数]` ——
拿本机 3269 张真卡跑列表 / 搜索 / 抽样解析 / 真导入，用来抓合成 PNG 测不到的脾气
（实测：160/160 解析成功、中位 1ms；642 条目的卡导入 25 条、全文 40 万字截断；三张卡合并出 124KB 世界书）。

---

## 4. 开发流程（照抄即可）

```powershell
# 1) 改源码：D:\Code\dsh\rp-tools-plugin\{lib/index.js, client/client.js}

# 2) 语法检查
node --check lib/index.js ; node --check client/client.js

# 3) 同步到 profile（file: 依赖是拷贝，必须手动同步！）
$dst = "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-rp-tools"
Copy-Item lib/index.js       "$dst\lib\index.js"       -Force
Copy-Item lib/card-png.js    "$dst\lib\card-png.js"    -Force   # 故事书导入（PNG 解码）
Copy-Item lib/card-import.js "$dst\lib\card-import.js" -Force   # 故事书导入（卡 → 会话配置）
Copy-Item client/client.js   "$dst\client\client.js"   -Force
# ⚠️ 改了 agent 作用域那半边（如 rp-bridge.mjs）还要同步到预设目录：
Copy-Item preset/rp-bridge.mjs "$env:USERPROFILE\.dsh\.agent-presets\dm\rp-bridge.mjs" -Force

# 4) 重启 dsh web（75 秒后自动重启，避免打断当前回合）
schtasks /Run /TN dsh-rp-restart

# 5) 冒烟测试（宿主逻辑不必等重启就能验）
node tools/smoke-dm.mjs        # 194 条断言：作用域隔离、工具/路由注册、dm 判定、世界书、状态、风格库、LoRA、卡库导入
node tools/smoke-card.mjs      # 64 条：合成 PNG 解码（三种文本块 / ccv3 优先 / 截断容错）+ 广告过滤 + 世界书限量 + 开场指令
node tools/smoke-client.mjs    # 客户端：样式在 apply 时就注入（防 FOUC 回归）、槽位注册（含 id/order）、bundle 工厂可跑
#    ★ 数据隔离：smoke-dm.mjs 把 DSH_HOME 指向临时目录，跑完就删 —— 绝不碰真实 ~/.dsh/data。
#      （早期版本直接写真实数据目录，测试记录混进真实会话登记表，清理时极易误删
#        真实会话 —— 已经被这个坑咬过一次，别再改回去。）
#    依赖从 profile 解析（同 rp-bridge.mjs 的 createRequire 办法），所以要在仓库根跑。
#    ★ 断言要覆盖「真的能跑」，不只是「定义正确」：曾经删掉全局 tools 数组后漏改
#      /rp-tools/tools 里的引用，路由直接 400，而当时 140 条断言全绿 ——
#      因为它们只测工具定义与纯函数，从没真的打过路由。现在有 7 条「路由体检」。
#    ★ 故事书导入另有两层：① 闭环断言（导入的世界书真的按触发词进 buildTurnContext，
#      进常驻段的是世界设定、角色进索引）；② 真卡库探针（下面这条，手动跑）。
node tools/probe-cardlib.mjs 12   # 真卡库：列表/搜索/抽样解析/真导入（只读 + 写临时目录）

# 6) 往返一致性（要在 profile 的 node_modules 目录里跑：那里才解析得到 @deepseek-ai/dsh-tools）
Copy-Item tools/verify-roundtrip.mjs "$dst\_roundtrip.mjs" -Force
cd $dst ; node _roundtrip.mjs "D:\Code\dsh\rp-tools-plugin\lib\card-import.js"
Remove-Item "$dst\_roundtrip.mjs"
```

**验证改动是否真的生效**（别只信「我重启了」）：比对监听进程的 PID 与启动时间。
已经踩过两次——一次重启发生在我同步代码**之前**，一次重启命令**根本没执行**，
两次都表现为「改了代码但行为没变」，白查一轮。

```powershell
Get-NetTCPConnection -LocalPort 3080 -State Listen |
  ForEach-Object { Get-Process -Id $_.OwningProcess } | Select-Object Id, StartTime
```

**发布**：`git add -A && git commit -m "..." && git push`（仓库已配好 origin；GitHub 账号 SiriusWJ，token 含 `repo`+`workflow`）。
**npm 不发布**（用户明确要求）。

---

## 5. 未解决 / 待验证（按优先级）

1. **右栏面板的界面确认**（入口按钮已实测出现）：
   - 验证：**刷新页面** → 打开 DM 会话 → 右上角应出现「🎲 RP」→ 点它 → 右栏应展开并显示 RP 面板 →
     右栏的收起 / 浮动按钮应正常作用。
   - 客户端 bundle 是**页面加载时**读取的，所以改完 `client/client.js` 只需刷新页面，**不必重启宿主**；
     只有改了 `lib/index.js` / `rp-bridge.mjs`（宿主半侧与作用域半侧）才需要重启。
   - 若入口出现但点了没反应：打开控制台看有没有 `[rp-tools] 打开 RP 右栏页签失败` 或
     `注册右栏页签类型失败` —— 前者说明没有挂载的右栏座位（右栏被折叠到不渲染），后者说明
     `sidebarRightTabs.register` 抛错（id/kind 撞车）。也可以直接看右栏条的「+」菜单里有没有
     「🎲 RP 跑团面板」这一项（注册 `guide` 之后会出现）。
2. **故事书导入面板的界面确认**（宿主 4 条路由已用 HTTP 实测：
   `/rp-tools/cards` 返回 3269 张、`/rp-tools/card` 解析成功、两条逃逸请求都是 400）：
   - 验证：**刷新页面** → 新建会话（Hero 上应出现「📖 导入 PNG 故事书」）→ 点开应列出卡库分类与卡片 →
     选一张应出预览（世界书条数 / 开场白来源 / 世界与性格摘要）→ 点「导入并开始」应：
     ① 会话预设变成 `dm`（右上角预设标签）；② 输入框被自动填上开场指令并发出；③ 工作区出现
     `rp-sessions/<会话 id>/` 下的世界书与 `cards/`；④ RP 面板的角色卡下面出现卡面立绘。
   - 已知**未在浏览器里跑过**的部分：`remote.agentPresets.select()` 与 `uiWorkspace.startSession()`
     都只能在页面里验证（宿主侧没有等价入口）。若切预设失败，面板会**显示原因**而不是静默 —— 先看那行字。
3. **`rp_scenes` 未用真实 `scenes_*.json` 实跑过**（逻辑同 `rp_illustrate`；样例文件在 `~/.dsh/.../userdata/workflows/manga_pipeline/scenes_*.json`）。
4. **角色一致性只做了第一版**：目前是「角色名→外观锚点」+ **每角色固定 seed**（`characterSeed()`，
   多角色同框时不固定）。要真正锁五官需接参考图 —— 本机已确认有
   `qwen_image_2512_fp8_e4m3fn` + Qwen VL 编码器 + `Qwen-Image-Edit-2509-Lightning-4steps` LoRA
   + **`ReferenceLatent` 节点**（**没有** `IPAdapterModelLoader`，别走 IPAdapter 那条路）。
   代价：要新增第二个工作流模板（现在 krea2-only）+ 首次加载 ~20GB 模型。
5. **LoRA 强度未暴露**：模板已支持 `st.loraStrength`，设置页/工具未开放。
6. 大尺寸（1664×928 等）未压测；媒体代理会把整图读进内存（仅适合图片）。
7. 面板「掷表」走独立路由 `/rp-tools/roll`，与 `rp_table` 工具共享 `parseDice`/`rollDice`。
8. **预设 id 目前硬编码为 `dm`**：若把预设目录改名，判定会失效（客户端、`markDmSession`、
   导入的 `select()` 都写死 `'dm'`）。要支持改名就把预设 id 提成一个常量或配置项。
9. **导入的叙事设定只做了「卡 → 世界书」这一层**：卡里的 `personality` 目前整段塞进角色卡的
   `personality` 字段（`appearance` / `speech` / `behavior` / `relations` 留空，等 DM 提炼）。
   下一步可让 DM 首轮把它拆成 8 个字段（`rp_character` 已经支持），但别让插件去猜。
10. **并行会话冲突**（真的发生过）：另一个 agent 会话曾同时改这个仓库，撞在 `lib/index.js`、
    `tools/smoke-dm.mjs`、`docs/REFERENCE-COMPARISON.md` 上，还留下过 `lib/card-index.js`
    （482KB 私人卡库索引 —— 已加进 `.gitignore`，因为 `package.json` 的 `files` 含 `lib/`，
    不加会被提交并随 npm 包发布）。**同时开两个会话改这个仓库前，先约定分工。**
11. **ST 式「正则表」：明确不做**（用户 2026-09-12 决定，别再自作主张加）。理由与现状：
    - 两个参考仓库里 **`{{user}}` 不是正则，是「宏」**：dsh-liketavern 有独立的宏展开器
      （`lib/core/macros.d.ts`，支持清单明确），dsh-roleplay 的 `rp-macro` 更保守（只有 `{{char}}`/`{{user}}`）。
      正则表是**另一件事**：作用域（用户输入 / AI 输出 / 发送给模型）＋ 时机（组装前 / 发送前 / 渲染前）＋
      find/replace ＋ 深度 ＋ 来源（用户 / 角色卡 / 预设 `extensions.regex_scripts`）。
    - 代价：liketavern 的 AGENTS.md 明确要求**第三方正则不许在宿主主线程跑**（必须进 QuickJS 隔离 worker，防 ReDoS）；
      要作用到「AI 输出」还得在 DSH 里挂 `conversation.chat.node`。与「轻量跑团工具」的定位不符。
    - 我们现在走的是 DSH 原生路线：`{{user}}` 注册成**宿主变量**（`systemPrompt.variable`），
      导入时再按卡名展开 `{{char}}` 等（`resolvePlaceholders`），其余未注册的宏中和成全角。
      需要「清标签 / 统一标点」时，用 dm 预设的 persona 指令或直接改世界书条目即可。

---

## 6. 踩过的坑（别再踩）

| 现象 | 根因 / 解法 |
|---|---|
| 客户端卡片/按钮完全不渲染 | bundle 的 `factory` **必须自己声明** `var module = { exports: {} }`（官方 bundle 同样），否则 `module.exports.*` 赋给了错误对象 |
| 按钮「静默不出现」且无报错 | 用 `String(fromHook \|\| props.sessionId \|\| '')` 取会话 id 时，钩子的**空串**会把后面兜底短路 → 查询落到未知 id → `isDm:false`。空串要当「真值缺失」跳过：`[a, b, c].find(v => typeof v === 'string' && v !== '')` |
| 同源路由测试里 POST 被 403 | `sameOrigin()` 比对 `new URL(origin).host === request.headers.host`——**假请求必须同时给 `origin` 和 `host` 两个头**（浏览器会强制覆盖 Host，所以真实 CSRF 场景里两者必然不一致） |
| 面板又丑又不能收缩 | 别用 `shell.overlay` 自己画浮层（ComfyUI 面板就是这么做的，属于反面教材）。要「右侧常驻 + 可收起」就注册 `sidebar.right.pane.tab`，外壳交给 DSH |
| 下拉框白底看不清 | 原生 `<select>` 的**弹出列表由浏览器绘制**，不继承我们的半透明背景 → 必须显式给 `option` 上色。用主题 token（`--dsw-alias-bg-layer-2` / `--dsw-alias-label-primary`），别写死深色，否则浅色主题下又不一致。别用 `color-scheme: dark` 图省事，那会写死外观 |
| 插件按钮跟旁边「不搭」 | 头部右上角那排是宿主的设计系统组件（参考 `dsh-client-ui-open-in-app` 的 split 按钮）：**28px 高 / 14px 圆角 / 0.5px 边框 `--dsw-alias-border-l4` / 透明底 / 11px 字 / hover 用 `--dsw-alias-interactive-bg-hover`**。裸 `<button>` 继承的是全局灰底方角样式，一眼就看得出是外来的。用这些 token 抄规格即可（都在 `dsh-web-frontend` 的 CSS 里有定义） |
| 共享 class 互相污染 | 给头部按钮写的 `.rpt-hbtn` 挂在浮层根元素 `.rpt` 上，结果把浮层的 `font-size: 13px` 带进了按钮。**独立根元素要用独立的无前缀 class**（现在是 `.rph-btn`） |
| 「第一次启动样式不对，后面就好了」 | **FOUC**：`injectStyles()` 只在设置页 / 会话面板的 `useEffect` 里调用，而头部按钮属于第三个组件、从不调用它 → 首屏按钮先以裸 `<button>` 外观出现，等某个组件挂载后才恢复。**样式必须在 `apply()` 里就注入**（已这么做），别依赖「某个组件挂载时顺手注入」。回归测试：`node tools/smoke-client.mjs`（做过变异验证：撤掉这行它会红） |
| 「试出」点了像没反应 | 预览卡片原本渲染在面板**顶部**，而「试出」按钮在卡片组**底部** —— 出图后不主动滚动，用户看着画面纹丝不动，会以为图没出。**现在每个「出图」入口都把结果渲染在自己旁边**：角色卡「立绘」→ 挂在该角色下方；「生图配置」的「试出一张」→ 卡片内按钮下方；设置页「试出」→「全局生图配置」卡片内。`useScrollToPreview()` 只作兜底滚动；等待期按钮显示「出图中…」（本机一张 ~18s）。以后再加出图入口，**让图出现在按钮附近**，不要又放到别处 |
| 立绘串到别人身上 | 立绘存在 `portraits[角色名]`，**不能按数组下标存** —— 删掉中间一个角色后下标整体前移，图就会挂到隔壁角色。角色改名等于换了 key（旧图留在内存里，重新出图即可） |
| 预览标题显示成「预览：（18.1s）」 | `/rp-tools/preview` 返回的是 `styleKey` / **`styleLabel`**，**没有 `style` 字段**。客户端早期读 `res.style` → undefined。按接口实际字段名读 |
| `ctx.sidebarRight` 是 undefined | 新服务要在**延迟注入回调的 ctx** 上取（`ctx.inject(['sidebarRightTabs'], (injected) => injected.sidebarRight.openTab(...))`），根 ctx 上没有 |
| 假 request 让 `readJsonBody` 报 400 | 它用 `for await (const chunk of request)` → 请求体必须是真正的 `Readable` 流（`Readable.from([Buffer...])`），手搓的 `on('data')` 对象不行 |
| 冒烟测试第二次跑就假失败 | 测试写的是**真实数据目录**：上一轮登记进 `dm-sessions.json` 的记录会让「未登记」用例返回 true。修法不是换随机 id，而是把 `DSH_HOME` 指向临时目录（现在这么做了） |
| 测试断言假失败 / 假通过 | 假 ctx 的 async handler **必须 `await`**：`await route.handler(req, res)`。漏掉 await 时断言读到的是**上一次调用残留的同一个响应对象**（于是「登记」断言假通过、「isDm」断言假失败），而 handler 其实稍后才跑完 —— 症状极具误导性。诊断诀窍：给「调用前 / 调用后」各打一条日志，看 handler 的日志落在哪两条之间 |
| 清理数据目录误删真实会话 | 别按「文件名不像我造的」就删。测试 id 必须先与 `~/.dsh/sessions/` 下的真实会话核对过才动手（作者已因此误删过一个真实会话的 RP 配置） |
| 改了源码但行为没变 | `file:` 依赖是**安装期拷贝**，必须手动同步到 `node_modules`；且宿主代码**只在重启时装载**，客户端 bundle **只在页面加载时读取**（所以改客户端只需刷新页面）。**判断是否真的重启过：比对监听进程的 PID / StartTime** —— 已踩两次（一次重启发生在同步代码之前，一次重启命令没执行），两次都表现为「改了代码但没生效」 |
| 全局注册 = 所有会话都带上跑团内容 | 提示词注入与 RP 工具**必须在 agent 作用域**（由 dm 预设的 `rp-bridge` 调用），不能放全局 `apply()`。`system-prompt/assemble` 是按作用域过滤的事件，在 agent 作用域注册就**只收到本会话的装配** —— 「只在 DM 生效」与「会话隔离」由 Cordis 免费保证。曾用「全局注册 + 猜当前会话」去模拟它，结果两个都错（每个会话都有跑团世界观；猜错会话还把别的战役设定注进来） |
| 删了全局数组，某条路由静默 400 | 删掉全局 `tools` 数组后，`/rp-tools/tools` 里的 `[...tools, ...rpTools]` 抛 ReferenceError。**handler 是同步的，异常被 webServer 转成 400**，前端只看到「读取失败」。当时 140 条断言全绿 —— 因为**没有一条真的打过路由**。现在有 6 条「路由体检」断言每条 GET 返回 2xx |
| 注入文本里出现 `undefined：…` | 加了状态字段 `clues` 却忘了在 `STATE_LABELS` 里配显示名。修法有两层：① 补标签；② **让渲染缺标签时回退到字段名**（`stateLabel()`），同类疏漏最多显示成 `clues：…`。回归测试：把全部字段填满渲染一遍，断言**绝不含 `undefined`** |
| `__debug` 放文件顶部 → 模块直接加载失败 | 它引用了下面定义的 `const`，命中**暂时性死区**（`Cannot access 'X' before initialization`）。放在文件**末尾**并注明原因 |
| 大段编辑把相邻代码吃掉 | 用 `edit` 替换大段时，`old_string` 若不精确会**连带删掉紧邻的函数注释头、`return` 或闭括号**（本轮踩了 3 次：`world:` 那行被替换而非追加、`buildTurnContext` 的 return 被删、`characterInPrompt` 的注释头被吃）。改完**立刻 `node --check`**，别攒着 |
| 测试退出时报 `UV_HANDLE_CLOSING` | Windows 上同步 `process.exit()` 会在 libuv 句柄收尾途中断言失败 —— 那是**收尾时序**问题、不是测试失败。改成 `process.exitCode = ...` 让事件循环自然收尾 |
| `comfyui_run` 的 `inputs` 覆盖报错 | 那是 dsh-comfyui 的坑（对象被冻结）；本插件不用它——出图直接 `POST /prompt`，参数自己注入 |
| 面板/工具传参"静默失效" | 早期版本把风格存成 dsh-comfyui 工作流时，参数清单没保存 → 覆盖值被忽略。现在参数由插件自己注入工作流，不存在该问题 |
| PowerShell 里 `@(a + $b * 360, c + $d * 170)` 报 `Object[] 不包含 op_Multiply` | 逗号优先级坑，**每个表达式加括号** |
| `schtasks` 的 `/TR` 超 261 字符 | 把命令写进 `.cmd`，`/TR` 指向该 cmd |
| 从 pwsh 里 `Stop-Process` 匹配到自己 | 过滤 `CommandLine` 时别让当前命令自身的文本命中模式（用拼接绕过） |
| 负面词"不起作用" | Krea-2 Turbo 默认 CFG=1，负向被 `(1-cfg)=0` 消掉；把该风格 `cfg` 调到 1.5~2.5 才生效 |
| 两个会话的世界书混到一起 | 世界书原先放在**工作区根目录**的 p-worldbook.md，而工作区是**按目录共享**的 —— 同工作区的两个会话读到同一个文件，A 导入的卡组条目就出现在 B 的上下文里。现在世界书按会话隔离：<工作区>/rp-sessions/<会话 id>/rp-worldbook.md；老文件首次读取时一次性迁移一份（旧文件保留不删），之后各会话互不影响。回归测试：smoke-dm.mjs 的「隔离：」系列（两个会话同一个工作区，条目、注入、常驻段路径三处都要互不可见） |
| 装了插件后**同工作区**会话互相串设定 | 见上一条。凡是「按会话」承诺的东西，路径里就必须有会话 id —— 别放在工作区根这种共享位置上 |
| 换了卡库目录却列出 3269 张老卡 | 私有索引 `card-index.js` 里的相对路径是**相对内置默认根**生成的，换根之后完全不适用。只在 `resolve(root) === resolve(CARD_DEFAULT_ROOT)` 时才用索引，否则扫目录（踩过一次：测试用临时卡库，却列出真卡库的卡） |
| 删掉 `lib/card-index.js` 后插件整个加载失败 | 那是**可选私有文件**（gitignore），不能静态 `import`（静态 import 失败连累整个模块）。用动态 `import()` + try 包住，没有就退回扫目录 |
| 卡库路由变成任意文件读取 | 卡库路径来自浏览器，`resolve()` 之后必须**前缀比对**卡库根 + 只认 `.png`（`safeCardPath`）。逃逸、绝对路径、非 png、不存在 → 全部 400。这条路由会把文件内容交给浏览器，校验不是可选项 |
| 导入把用户手写的世界书清空了 | 导入**只追加**同标题去重后的新条目（`mergeWorldBook`），绝不做「解析 → 重新渲染」——那会抹掉用户的注释与格式 |
| `X.card.png` 与 `X.png` 互相覆盖 | slug 只去掉 `.png`，保留 `.card` 标记（否则两张卡撞成同一个文件名，第二张覆盖第一张的全文与卡面） |
| 待办导入「等不到新会话」 | 新建会话会让**会话作用域的槽位子树重新挂载**，组件 state 被重置 → 任务丢失。待办放**模块级变量**，state 只负责触发重渲染 |
| 开场指令发出去了但 DM 先反问一句 | dm 预设的 persona 第一条就是「开局先问玩家世界从哪来」。`buildOpeningPrompt()` 必须显式写「不要再问世界从哪来，直接开团」 |
| 会话已开局时切预设静默失败 | 宿主对已开局的会话返回 `agent-preset/locked`（`turnBoundary.lastTurn > 0`）。判定 `blank` 后再切；不 blank 就先 `uiWorkspace.startSession()` 新建会话，并把失败原因**显示出来**而不是吞掉 |
| 用 `Start-Sleep` + 查进程验证重启 | 长 sleep 的工具调用被中断后结论不可知。**只信 PID/StartTime 的实际读数**：先记 `PID + StartTime`，重启后再读一次比对（PID 变了且 StartTime 晚于同步时间才算真重启） |
| 卡预览报 `读不到文件：ENOENT … stat '<AppData>\同人\X.png'` | 两层叠加：① 客户端 `API.card` 曾写成 `card: (path) => …`，把调用点传的 workspace **悄悄吞掉**，请求里只剩 `?path=`；② 宿主对「会话工作区」的记忆**只在进程内存**（`session/created` 时填），重启后恢复的会话查不到，而请求里也没有 sessionId 可查。于是根目录落空 → `resolve('')` = **进程工作目录**（DSH 从 `AppData\Local\DeepSeekHarness` 启动）→ 拼出一条谁都不认识的路径。修法：客户端所有读盘卡路由都带 `sessionId`（有 cwd 再带 `workspace`）；宿主 `resolveWorkspaceDir` 改**四级链**（内存 → `ctx.get('sessions').get(id).header.cwd` 现查 → 会话配置里落盘的 cwd → 请求参数），并且**没给 sessionId 的匿名请求不进 `default` 桶**（否则第一个匿名请求会把工作区种给它，后续全串）。教训：**凡是「宿主一定知道」的假设都要写下位兜底**，`resolve('')` 永远不等于「当前工作区」 |
| 测试跑在旧副本上 → 假失败 | `tools/smoke-*.mjs` 从 **profile** 的 `node_modules/dsh-rp-tools` 解析被测模块，改完 `lib/` 必须先同步再跑；没同步时看到的是上一版的行为（本轮先跑了一次，报「提示没指向工作区」，其实代码已对）。 |
| 用 PowerShell `.Replace` 改含反引号的 JS | 模板字符串里的反引号会被 PowerShell 当转义符，吃掉引号后直接语法报错（本轮踩了两次，一次把 `tools/smoke-dm.mjs` 弄坏到必须 `git checkout` 恢复）。**改代码只用 `edit` 工具**，PowerShell 只用来跑命令和查文件。 |
| 切走 agent 预设再切回 dm，导入入口永久消失 | 入口可见性原先只看**客户端投影**（`byId[id].projectionValues.agentPreset` + 摘要里的 `blank`）。切预设会让会话作用域重新挂载、投影基线重放，而 `ProjectionValueStore.seed()` 对「基线里没有的键」是**删除**语义 —— `agentPreset` 于是读成空串，判定「不是 DM」，入口再也不出现（刷新页面才回来）。修法：加宿主路由 `/rp-tools/gate`（宿主手里是活着的会话对象 + 自己的投影状态，回答「现在是不是 dm」「有没有真的开局」），客户端把投影只当**快速路径**；宿主答复**带 key 缓存**，key（会话+blank+预设）一变旧答复立刻作废。**教训：别把「界面缓存里的投影值」当成会话事实** —— 凡是决定「要不要显示某个功能」的判断，都要有一条问宿主的权威路径 |
| 摘要没到就当成「已开局」 | 同一条可见性逻辑里写过 `blank === true` 才算新会话，摘要缺席时读成 `false` → 重挂载后入口闪一下就没。**缺省要落在「功能可见」那一侧**，再让权威路径纠正；落在「功能消失」那侧用户根本找不回来，多显示一次则没有损失 |
| 尺寸改了但出图没变 | 图像尺寸现在是**全局**的（`config.imageSizes`，设置页「图像」那三行），解析顺序 `resolveImageSizes()` = **全局优先 → 风格自己的 `sizes` → 兜底**。风格里的旧尺寸只在「全局缺该用途」时才生效 —— 这是刻意的：若风格优先，用户在设置页改了全局会完全没反应。要单风格特例就直接写 `styles.json`。将来加第 4 档用途要同时改三处：`IMAGE_SIZE_SLOTS`、`DEFAULT_IMAGE_SIZES`、设置页的 `sizeRow(...)` |
| 「重启了还是没按钮」 | 单点判据时，任一侧给出错误值入口就消失。**判据要往「显示」方向合并**：dm 用 `storeDm \|\| gateDm`，开局用 `storeStarted && gateStarted`（只有两侧都说已开局才收起）。更要紧的是补一条**结构性保底通道**：RP 面板里的「PNG 故事书导入 → 展开卡库」，与 chip 共用面板主体但不判定预设/开局 —— 会话开局后 chip 必然消失，而「再导一张卡」恰恰是开工之后的需求。教训：凡是「只在某状态下出现」的入口，都要有一个**不依赖那个状态**的备用入口。面板顶部还留了一行**入口判据诊断**（界面侧 vs 宿主侧），排查先看它 |
| 「值都对，按钮就是不回来」 | 定位这类问题要**先分三问**（这次靠用户的三句话一次锁定）：① 刷新页面能回来吗？（能 ⇒ 数据源没错，是「没重新判断」）② 切换真的生效了吗？（RP 面板能打开 ⇒ 生效）③ 按钮原本出现在什么状态？（新对话首屏 ⇒ 它属于首屏的预设选择）。结论：**客户端那份 `projectionValues.agentPreset` 在切走之后可能不再更新**（官方 chip 显示正确，是因为它自己持有 staged 值，不是投影更新了），组件入参一个不变 → 不重渲染 → 判定永远停在旧值。正确触发源是宿主广播的 **`agent-preset/selected`**（在 `dsh-api-remotes` 的转发白名单里，客户端 `ctx.remote.$on(...)` 收得到；`dsh-client-ui-skill` / `ui-commands` 都这么用）。教训：**别把「某个 store 值会变」当成前提**，凡是要跟随别的 UI 变化的东西，就订阅那个变化的广播 |
| React 的 hook 不能写在早退之后 | `RpCardImport` 里 `useRef`/`useState`/`useLayoutEffect` 原本写在两个 `return null` **之后** —— 等于按条件调用 hook。真实 React 下状态可能错位，测试桩（槽位按序号存）里直接表现为「面板打不开」。**所有 hook 提到早退之前**，早退只决定「渲染什么」。顺带修了测试桩：钩子槽位原先**跨组件共用一个数组**，我加两个 hook 之后 dock 组件的 `open` 就读到了 RP 面板的 `lib`，报了一个完全不相关的假失败 —— 现在 `rt.cellStore` 按组件类型隔离，重挂载用 `resetHooks()` |
| 卡面缩略图为什么自己写解码 | DSH 没有可复用的服务端缩放（客户端的缩略图能力在浏览器里，宿主侧没有），而卡 PNG 单张可能几 MB。`lib/png-thumb.js` 只实现「8bit 非隔行 + 已知通道数」这一条最常走的路，其余全部返回 `null` 让路由**回退原图** —— 生产里绝不能出现「缩出一张坏图」。改它的时候务必跑 `smoke-card` 的那组**像素级**断言（纯色/左右分界/取平均/灰度），只断言「体积变小」会漏掉「整张压成空白色块」 |
| 主题 token 用错 → 按钮变白底白字 | DSH 的 `--dsw-alias-brand-primary` **不是品牌蓝**，是**高对比前景色**：浅色主题 = 近黑 `#0f1115`，深色主题 = 近白 `#f9fafb`。主按钮要按宿主自己的配法来：底色 `--dsw-alias-button-primary-fill`、文字 `--dsw-alias-label-primary-foreground`、hover `--dsw-alias-button-primary-hover`；**永远不要**自己配 `color:#fff`。要蓝色就用 `--dsw-alias-button-info-fill`。改完一定在**深色 + 浅色两种主题**下看一眼（这次只在深色下就翻车了）。token 全表在 `dsh-client-ui-theme/lib/client.js` 的 `design_platform_css_default` 里，可以直接 grep 值 |
| 界面是新的、宿主却是旧的 | `dsh-client-modules` 会**监视插件 bundle 文件**：改 `client.js` 后刷新页面就能生效（不必重启）。而宿主 `lib/` 只有重启才加载 —— 两者不同步就会出现「新界面 + 旧数据」的诡异组合（实测：设置页有三大类，但 `/rp-tools/state` 里没有 `imageSizes`，尺寸行显示 0）。**排查手法：先看监听进程的 StartTime 是否晚于 profile 里 `lib/index.js` 的 mtime**；判断界面新旧则看有没有刚加的那条文案/class。**结论：客户端要按「旧宿主」防御**（缺字段给默认值、并把自己解析出的值保存回去自愈） |
| 客户端改了但页面没变 | `dsh-client-modules` 在**宿主启动时**就把各插件的 bundle 字节读进内存（`responses` 表），并按内容哈希定 rev —— 所以**改客户端也要重启宿主**，只刷新页面拿不到新字节（HMR 只有在跑 `pnpm run dev:web` 时才生效）。判断有没有生效：比对 profile 里 `client/client.js` 的 mtime 与宿主进程的 StartTime |

---

## 7. 环境侧的既有资产（可复用）

- **模型**：`krea2_turbo_fp8_scaled`（12.2GB）、`qwen3vl_4b_fp8_scaled`（4.9GB）、`qwen_image_vae`、9 个 `krea2_*` 风格 LoRA（各 ~448MB）、`z_image_turbo_bf16`、`qwen_image_2512_fp8_e4m3fn` 等。
- **官方模板**（可参考构图/参数）：`~/.dsh/.../site-packages/comfyui_workflow_templates_json/templates/image_krea2_turbo_t2i.json`、`image_z_image_int8.json`。
- **可复用脚本**：`D:\Code\dsh\comfyui-workflows\` 下有 `fetch-models.ps1`（HF 断点续传）、`api-to-ui.ps1`（API→UI 图格式转换）、`run-comfy.ps1`（直连 ComfyUI 跑工作流）。
- **dsh-comfyui 插件**（仍在用，与本插件解耦）：其工作流库现有 3 个文生图工作流 + 1 个「跑团-暗黑水墨」（旧版遗留，可删）。

---

## 8. 下一步建议

1. 刷新页面确认两处界面：① 头部「🎲 RP」→ 右栏面板；② 工作区那一行「📖 导入 PNG 故事书」→
   走一遍「选卡 → 导入并开始」，确认预设真的切成 dm、开场指令真的发出、工作区真的落了文件。
   正常的话把 `docs/STATUS.md` 的对应条目标为已解决。
2. 让 DM 首轮把导入的 `personality` 拆成 `appearance` / `speech` / `behavior` / `relations`
   （`rp_character` 已支持；别在插件里猜）。
3. `rp_scenes` 用真实场景文件实跑一次。
4. 接 Qwen-Image-Edit 做角色一致性（卡面已经在工作区里了，可以直接当参考图）。
5. 暴露 LoRA 强度；给 `rp_table` 加「掷出结果 → 顺手出图」。
6. 满 1 天后可向 `awesome-dsh-plugin` 提收录（用户自己维护该列表）。
