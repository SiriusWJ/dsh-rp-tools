# 参考项目对比备忘（dsh-rp-tools）

> 目的：为「把 dsh-rp-tools 做成好用的 RP 工具」提供依据。
> 三个参考项目已拉到 `D:\Code\dsh\refs\`（只读参考，不属于本仓库）。
> 本文件是**分析备忘**，不是路线图 —— 取舍结论见文末。

---

## 0. 一句话结论

三个参考项目在**角色扮演的内容层**（设定如何进入模型、记忆如何维持、角色如何不自相矛盾）上比我们成熟得多；
我们在**工程层**（按会话隔离、宿主集成、生图链路、fork 继承）上并不落后，甚至在「直连 ComfyUI 出图」这一点上是独有的。

我们的定位应该是：**轻量跑团配图 + 裁决工具**（DM 的辅助轮），
而不是「叙事引擎」。这决定了该抄什么、不该抄什么。

---

## 1. 三个参考项目画像

| 项目 | 性质 | 体量 | 核心价值 |
|---|---|---|---|
| **hermes-roleplay-engine** | Python + Hermes Agent 的**内容层设计稿**，不是 DSH 插件 | 11 个文件（2 个 py 引擎 + 蒸馏器 + PNG 解析） | 角色卡字段设计、World Book、情感/心理描写规范、防抢话 |
| **dsh-roleplay** | DSH 插件**套件**，monorepo | 23 个插件（`rp-lore-book` / `rp-character-card` / `rp-conversation-summary` / `rp-preset` / `rp-macro` / `rp-persona` / `rp-state` …） | 完整角色扮演套件：资料管理 + 故事生成 + 对话增强；架构规范极严（见其 AGENTS.md） |
| **dsh-liketavern** | DSH 插件，**SillyTavern 兼容引擎** | 733 个文件，v0.2.2 | 世界书（递归激活/WI）、ST 角色卡与预设导入、EJS 模板、长期记忆、分支、正则、MVU |

### 1.1 hermes 的要点（内容层）

- **角色卡字段设计**（YAML/JSON），并明确给出**字段优先级**：
  1. `first_mes` — **决定文风、描写密度、叙事节奏（标注为最重要）**
  2. `personality` — 行为逻辑
  3. `scenario` — 互动起点与关系张力
  4. `system_prompt` — 心理建模规则
  5. `description` — 外貌参考
  其余：`behavior`（可观察的行为习惯）、`speech`（量化口癖）、`likes` / `dislikes` / `backstory` / `mes_example`
- **World Book 关键词触发式注入**（按关键词命中才注入对应描写规范）—— 省 token 的关键手段
- **PNG 角色卡导入**（Chub / JanitorAI 生态：角色卡藏在 PNG 的 tEXt 块里）
- **角色蒸馏器**：输入角色名 → 三路并行调研（基础档案 / 台词行为 / 社区解读）→ 生成角色卡
- 防抢话四重约束、身体一致性锁定、5 维心理建模（依恋/防御/核心图式/需求层级/道德推理）

### 1.2 dsh-liketavern 的要点（工程+内容，SillyTavern 兼容）

- 三面结构：host（`src/index.ts`）/ agent（`src/agent.ts`）/ client（`src/client/`，5 个 slot）/ core（纯函数）/ state / node
- **7 个模型工具**：`tavern_memory_search` / `memory_write` / `memory_update` / `lore_read` / `worldstate_update` / `asset_list` / `asset_read`
  —— 并强调「默认直接扮演，只有缺设定、遗忘或已确定事实需要落盘时才调用」「禁止整本倾倒」
- **提示词边界**：standing 是工具说明后的 `tavern:standing`（order 210）；turn 是 runtime context `tavern:turn`；
  「绝不使用 complete 段盖掉工具前缀」—— 即**不改写宿主工具前缀**，只在自己的层里加内容
- **每轮冻结完整提示词计划**：首次组装成功后缓存快照，后续步骤重放同一份；资产编辑下一轮生效
- **第三方代码隔离**：世界书/组装/渲染在 `isolated()` 里跑；EJS 只在 worker 内的 QuickJS/WASM 执行，
  不暴露 Node/DOM/网络；交互卡 iframe 用 `sandbox="allow-scripts"` 且**不加** `allow-same-origin`
- 资产共享 / 剧情状态隔离：`workspace(cardId)` vs `storyWorkspace(cardId, storyId)`；记忆/变化层/笔记/聊天世界书都属**剧情**
- **分支先准备后发布**：锁住来源剧情做快照 → 草稿内回滚 → 原子发布 → 再建宿主子会话；不回滚原会话
- **每次楼层写入先 WAL 后正文**；损坏日志整批拒绝，不做「跳过坏行标成功」

### 1.3 dsh-roleplay 的要点（工程规范，来自其 AGENTS.md）

架构原则（值得逐条对照我们自己的实现）：

- **Session-centric、event-sourced、live-source-referenced**：Harness Session 是聚合根，
  不得在别处建立与 Session 并列的会话事实源
- 可复用资产（角色卡/世界书/人设/预设/文风）是**独立可变事实源**，Session 只存 `id` 引用；
  事实源更新后所有引用它的 Session 下一轮就读到新内容（不把 Session 钉在历史版本）
- 上层投影（`rp/session`、`rp/state`）必须**可从日志完整重建**，不是第二份事实源
- **安全**：外部角色卡里的 `system_prompt` / `post_history_instructions` 等可执行提示内容
  **不得未经用户选择直接进入模型上下文**；导入图片必须剥离原始元数据（含角色卡数据）
- UI 文案规范：所有可见文案都要单独设计；不得把 Session/fork/entity/projection/snapshot/CAS/RPC 等
  实现术语暴露给用户；错误文案不得直接展示错误码或异常文本

---

## 2. 我们的现状（dsh-rp-tools v1.1.2）

**已具备**：
- 8 个工具：`rp_random`（骰子/区间/加权/布尔，seed 可复现）、`rp_styles`、`rp_illustrate`、
  `rp_character`、`rp_session`、`rp_scenes`、`rp_config`、`rp_table`
- **直连 ComfyUI** 的 API 工作流（krea2 turbo + 风格 LoRA）+ 自建同源媒体代理
- 10 种内置风格 + 自定义风格增删 + **本地 LoRA 下拉选取**
- 按会话隔离：世界设定 / 角色卡 / 随机表 / 提示词前缀 / 风格备注 / 战役名 / 会话默认风格
- fork 时按 `header.parentSession + isSeeded` 继承会话配置
- 界面：设置页（全局配置 + 风格库 + 工具列表）、会话头部右上角入口、**右侧栏页签面板**（世界/角色卡/随机表/生图配置，每个角色带立绘位）
- 两个冒烟测试（宿主 40 条断言 + 客户端 FOUC 回归）

**明显缺失（按参考项目对照）**：

| 缺口 | 参考项目怎么做 | 我们的现状 |
|---|---|---|
| **世界书 / 关键词触发注入** | hermes 有 World Book；liketavern 有完整 WI（递归激活、扫描深度、常驻条目、token 预算） | 完全没有。世界观只是一整块文本塞进会话配置 |
| **角色卡字段深度** | ST V2/V3 规范（`first_mes`/`mes_example`/`system_prompt`…）；hermes 标明 `first_mes` 最重要 | 只有 `name` + `appearance`（且只服务于生图） |
| **我的人设（persona）** | 两者都有 | 没有 |
| **提示词分层与注入位置** | liketavern 明确 standing/turn 两层 + `order` + 用 runtime context；dsh-roleplay 有 prompt manager | 只有一条 `prompt_prefix` 字符串前缀 |
| **长期记忆 / 摘要** | dsh-roleplay 的 `rp-conversation-summary`；liketavern 的 memory_search/write/update + 归档摘要 | 没有。剧情长了全靠宿主自己的上下文管理 |
| **状态追踪（关系/物品/任务）** | dsh-roleplay 的 `rp-state` + `rp-state-display` | 没有（随机表勉强算一种结构化数据） |
| **角色卡导入生态** | PNG 角色卡（Chub/JanitorAI）、ST JSON | 只能手填 |
| **输出格式/防抢话约束** | hermes 四重约束；liketavern 的 output/render 规则 | 没有 |
| **安全边界** | 两者都强调：卡内可执行提示不得直接进上下文、导入图片剥离元数据 | 暂无导入功能，尚不涉及 |

---

## 3. 取舍：该抄什么、不该抄什么

### 3.1 明确不该抄（会失控）

- **不做 event-sourced 架构**：那是给「Session 日志即唯一事实源 + 可回放 + 可重建投影」的严肃引擎准备的。
  我们按会话存 JSON 足够；贸然上 WAL/投影只会让小插件背上巨大的复杂度。
- **不做第三方代码沙箱**：QuickJS/EJS/iframe 沙箱是为了跑**社区角色卡的脚本**。我们若不支持第三方卡，就不需要。
- **不做分支快照回滚**：liketavern 的「先准备后发布 + 原子发布」是为「多楼层回滚不污染原会话」。
  我们只继承一次配置，用不上。
- **不追 ST 全量兼容**：那是 liketavern 的产品定位。我们兼容一半反而会制造期望落差。

### 3.2 值得抄（按性价比排序，已细化见 §7）

> 下面几条的结论已由三份代码级报告核实，细化后的清单见 §7。

1. **世界书 / 关键词触发注入**（价值最高）
   理由：解决「设定太长塞不进上下文」「模型忘记细节」这两个最痛的点；
   而且我们已经有会话级世界设定，只是「整块塞」——升级成按关键词命中注入，收益立竿见影。
2. **角色卡字段加深 + `first_mes` / `mes_example`**
   理由：`first_mes` 被明确标为决定文风；这是**零工程成本、纯提示词质量**的提升。
   注意：我们的角色卡现在只服务生图，要扩成「既服务生图、也服务叙事」。
3. **我的人设（persona）**
   理由：DM 需要知道「玩家是谁」；实现成本低（就是一份会话级文本）。
4. **提示词分层**：把现在的一条 `prefix` 拆成「常驻层 / 触发层 / 深度注入」
   理由：liketavern 的 standing/turn 分层说明「放哪里」和「放什么」同样重要。
5. **长期记忆：轻量摘要**
   理由：长战役的必需项；但要注意别做成 liketavern 那样重（它带归档、检索、去重、回滚）。
   轻量版：每 N 轮让 DM 主动写一条「前情提要」，存会话文件，按需注入。
6. **安全边界（现在就立规矩）**
   理由：一旦做角色卡导入，卡内 `system_prompt` 就直接进上下文了。
   参考两者的做法：导入时隔离可执行提示、剥离图片元数据、让用户显式选择。

### 3.3 我们的独有优势（别丢掉）

- **直连 ComfyUI 的生图链路**：两个参考项目都不做本地出图（liketavern 有消息图片渲染，但不是生成）
- **立绘/场景图与角色卡绑定**：角色卡 → 外观锚点 → 立绘，这条线是我们的差异化
- **轻**：8 个工具、按会话 JSON、无沙箱无 WAL。装上一个下午就能用起来是优点，不是缺点

---

## 4. 实现级避坑要点（来自 dsh-liketavern 的 CHANGELOG / 架构文档）

> 这些是**别人已经用版本迭代换来**的经验，抄要点比抄代码便宜得多。

### 4.1 提示词注入通道（我们要新增的核心能力）

- **段序**：standing 放 `order 210`。理由：工具说明占 100–199，稳定骨架放其后，**即使骨架有残余抖动，稳定的工具前缀仍能命中 DeepSeek 前缀缓存**。
- **未绑定/无配置时写固定短文案，而不是把段删掉** —— 避免段布局抖动打穿缓存。
- **必须中和 `{{…}}`**：宿主会对 system section 做插值，残留的 `{{宏}}` 会被当变量处理而抛错。
  liketavern 的做法是把残留花括号换成全角（`neutralizeDshMustache`）。我们的风格触发词/世界设定里出现 `{{ }}` 完全可能。
- **standing 必须逐字节稳定**：不要放时间戳、随机数、step 号。
- **standing 指纹只纳入真正决定 standing 字节的设置键**：liketavern 曾把 tokenBudget/scanDepth 也算进去，
  结果用户改个无关设置就打穿整段缓存。现在收窄到 3 个键。
- **概率/定时不要放 standing**：liketavern 让「standing-safe 常驻条目不掷概率」——因为钉死机制会把掷骰冻结成
  「每会话一次」，而 fork/重新生成出的子会话换种子重掷会与父会话字节漂移，打穿整段 system 前缀缓存。
  概率、sticky/cooldown、递归门槛一律走 turn 层。

### 4.2 turn 层预算（会直接反映在 token 账单上）

- runtime context 每轮被追加成**新的 user 快照**，对每个新请求都是**未缓存前缀** —— 搭上去的内容每轮全价重付。
  liketavern 实测单轮快照可达 ~37k 字符，为此专门写了独立预算文件。
- **百分比预算的折算基数要 clamp 到 128K**：否则 1M 窗口模型下「25%」= 25 万 token，形同虚设。
- **固定预算优先于百分比**。
- **被裁条目不要静默丢弃**：在快照尾部附 uid 清单（封顶 8 条），让模型可以按条补读。

### 4.3 世界书（轻量版也要遵守）

- **中文场景下 `matchWholeWords` 要默认 false**：ST 出厂默认整词匹配，对中文很不友好。
- 超长键（>500 字符）与灾难性回溯正则：**一律判为「永不命中」，不抛错、不冻结主循环**。
- 正则键编译要注意 `g`/`y` 标志的 `lastIndex` 残留 —— 会导致奇偶次调用交替漏匹配（ST 自己也踩过）。
- 递归时落选条目的正文**不要喂给后续递归轮次**，否则会出现「自己不会被注入的条目决定别人是否被激活」。
- 落选条目的**定时状态必须清掉**，否则 sticky 条目下一轮免概率回归、独占 inclusion group、饿死同组兄弟。

### 4.4 认证 / 会话判定的静默失败（我们踩过同类坑）

- liketavern 有一次宿主升级把 `SessionSummary.agentPreset` 挪进了 `projectionValues.agentPreset`，
  它没跟上 → **恒判为非 Tavern 模式 → 选卡区/会话芯片/楼层操作条全部不显示，且无任何报错**。
  这正是我们这次踩的「按钮静默不出现」同一类问题（见 §我们的坑）。
- 教训：**判定类逻辑要有可观测出口**（我们已有 `/rp-tools/session?sessionId=` 这类查询接口，保持它）。

### 4.5 客户端插件写法

- 服务由 apply 内部安装时，**不要在 `inject` 里声明它**，否则加载器会在 apply 前等一个不存在的服务而死锁；
  安装后只用 `ctx.get('x')` 读，**不要写 `ctx.remote.x`**（追踪代理会按点路径查 inject）。
- **slot 声明可能尚未就位**（插件加载顺序）：优先 `ctx.slots.inject(name, () => register(...))`，
  回退 `ctx.effect(() => register(...))`。（我们已用前者。）

### 4.6 一条元建议

liketavern 的 `AGENTS.md`「必须保持的边界」9 条 + `docs/HOST_COMPATIBILITY.md`，
本质是**一份 dsh 插件开发的踩坑清单 / 宿主升级核对清单**。升级 dsh 时按它逐项核对，
能省掉它 CHANGELOG 0.1.5 那种「整版都在修破坏性变更」的代价。

---

## 5. dsh-roleplay 的关键设计（23 插件套件，约 19 万行）

它和 liketavern 是**同一个平台上的两种走法**，值得对照看：

| | dsh-roleplay | dsh-liketavern |
|---|---|---|
| 前后端通道 | 类型化 RPC（`TypertRemoteService`），**无自建 HTTP 路由** | 同样无 HTTP 路由，走 typert remote |
| 挂载 | 全局 host 行（`rp-feature-manager` 作唯一入口）+ 动态生成受管 preset | host 全局 + `presets/tavern` preset |
| 提示词 | `system-prompt/assemble` + **10 种可注册的 context source** | `systemPrompt.section/context` 两通道 |
| 世界/状态 | **event-sourced 投影**（`ctx.sessionProjections.register`），可从日志重建 | 文件 + 楼层 WAL |
| 长期记忆 | 直接**重写 `ctx.compaction` 引擎**，压缩结果落成原生 `compaction/summary` 事件 | 自建 BM25 记忆 + 归档 |
| 资产与状态隔离 | 资产共享（Session 只存 live `id`）+ 会话投影 | 角色资产共享 + `storyId` 剧情隔离 |

### 5.1 值得我们抄的三处

1. **上下文渲染带来源标签**（`<section name="角色卡信息"><item name="角色卡">…`）：
   整段提示词是自解释的结构化文本，模型能分清「哪段是什么」。我们注入 world 时只用了纯文本标题，
   可以升级成同样的结构化外壳。它还会把正文里**伪造的同名标签转义掉**，防止角色卡内容冒充上下文结构。
2. **`filterUnavailableToolPromptSections`**：把「工具说明段」与**当前真正可见的工具**对齐 ——
   工具不可用时，对应的说明段也一并从 assembly 里滤掉。我们给 dm 预设过滤了工具，
   但**提示词里仍可能残留「你有 rp_illustrate」这类指导**，同类问题。
3. **资产识别用会话投影，而不是猜**：它踩过和我们一样的坑 ——
   客户端靠 `projectionValues.agentPreset === 'roleplay'` 判定会话类型，
   升级后识别方式变了 → **会话工具/头像/高亮全部静默隐藏**。（和我们的按钮静默不出现同源。）

### 5.2 它「文档承诺但代码没做」的地方（重要：别照抄文档）

- `budgetPriority` / `promptCategory` 的**裁剪算法根本不存在**（字段只被写入、从未读取）；
  测试里甚至有一条反向断言「大 factual source 不受本地容量限制」。
  唯一真实的预算是世界书内部的 `maxTokens=4096 / maxEntries=128`。
- 角色卡的 `system_prompt` / `post_history_instructions` 会被**递归删除并存进 quarantine**，
  而解封通道 `trustPromptPaths()` 是**死代码**（无 UI、无端点、无工具、无测试）——
  即当前发行版里这两类提示词**永远进不了上下文**。
- `withLibraryMutation()` 是每插件模块私有 Map，**不跨 Cordis 实例**，与它文档要求的
  「同目录 mutation 必须串行化」不符（跨实例只靠 rename 原子性兜着）。

**方法论收获**：三个参考项目**每一个**都有 README/文档与实现不符的地方
（hermes 的「年龄检查」、roleplay 的预算裁剪与 quarantine 解封、liketavern 相对最诚实并主动标注边界）。
→ 结论：**读代码，别读 README**；评估任何设计时都要落到实现。

### 5.3 一条 Cordis 平台的坑（它踩过，我们若走 Remote 会同样踩）

通过浏览器 Remote 调用 Host 服务时，**Cordis 的可追踪代理会把 `this.ctx` 重绑定到调用方**，
于是「功能开关不可写」。它的修法是保存 provider 侧的 ctx，不依赖 `this.ctx`。
我们现在用自建 HTTP 路由（`webServer.register`）绕过了这个问题，但要记住**别在服务方法里依赖 `this.ctx`**。

---

## 6. 落地记录（按轮次累积）

- **✅ 提示词注入通道（standing）**：注册 `rp:standing` 段（order 210），每轮按当前会话把
  战役名 / 世界设定 / 角色卡 / 随机表目录注入 system 段。
  这是「世界设定从没进过模型」这个 bug 的正解 —— 见 `docs/PROMPT-CONTENT.md` 与本文 4.1 的避坑要点。
  实测：注入内容确实出现在装配结果里；`{{}}` 被中和；无配置会话回落固定短文案、不泄露上一会话内容。
- **诊断探针** `_standing-probe.json`：记录我们写入的段与宿主返回的段清单，
  用于验证契约里那条「complete 段会被还原、监听者无法改写该作用域系统提示词」的限制是否真的生效。

---

## 7. 落地清单（三份报告合成的结论）

### 7.1 战略定位（先说清楚，否则会做错取舍）

我们的差异化是**结构性的**，两个 DSH 参考套件都**完全没有**：直连 ComfyUI 的生图链路 + 风格 LoRA + 同源媒体代理 + 骰子/随机表。
反过来，它们有而我们**完全没有**的是：世界观检索、状态追踪、角色卡生态兼容。

所以定位是：**给「轻量跑团配图 + 裁决」补上「记忆与设定」**，而不是变成第三个叙事引擎。
判断标准：一件事如果只服务于「长篇叙事的文学质量」，可以不做；如果服务于「DM 少花力气、图跟得上剧情」，优先做。

### 7.2 P0（立刻做）

| # | 做什么 | 为什么 | 难度 | 状态 |
|---|---|---|---|---|
| 1 | **提示词注入通道（standing）** | 「世界设定从没进过模型」——一切的前提 | 小 | ✅ 已完成 |
| 2 | **角色卡字段加深（学 hermes，不导入 ST 格式）** | 现在只有 `name`+`appearance`，且只为生图服务 | 小 | ✅ 已完成 |
| 3 | **世界书：关键词触发检索** | 把「设定体量」与「每轮注入量」解耦；长会话里固定注入必然吃光上下文 | 中 | ✅ 已完成 |
| 4 | **结构化 `appearance` → 生图一致 prompt** | 我们唯一的护城河就是生图，而角色一致性是它最大的痛点 | 中 | 待做 |

**#2 已完成的字段集**（`CHARACTER_FIELDS`，故意**不做** ST/CCv 兼容与 PNG 导入 —— 定位是轻量工具）：

| 字段 | 取向 |
|---|---|
| `name` | 唯一标识 + 注入检索键 + 生图锚点 |
| `appearance` | 生图提示词 + 注入。填写**顺序建议**写进工具描述（发型色→眼睛→肤色体型→身高→穿着→配饰） |
| `personality` | 表层 → 深层 → 矛盾点 |
| `speech` | **可观察的量化特征**（「句子短、爱用反问、管玩家叫小子」），不要「很有个性」这种空话 |
| `behavior` | 可观察的行为习惯 |
| `relations` | 文字描述（**不做数值好感度** —— 谁改、何时改说不清，会变成模型自己报数的假追踪） |
| `first_mes` | **文风锚点**，hermes 标为最重要的字段。注入时截断到 300 字 |
| `mes_example` | 对话范例 2~4 轮 |

设计取向来自 hermes：**给样本 > 给形容词**。所以 `first_mes` / `mes_example` 是**样本字段**，
渲染时会明确标注用途（「延续这个语感，不要照抄内容」）—— 不标注的话模型会当普通设定读过去。

其他实现细节：
- `renderCharacter()` **只输出填过的字段**，不产生「（未填）」噪音。
- `rp_character set` **只覆盖传入的字段**：不传的保持原值（否则改一个字段会把别的字段清掉）。
- 数据结构天然适配将来的世界书：角色名就是稳定的检索键与触发词。

**#2 的两个实现参考**（两份报告分别给了，互不冲突）：

- 起步用 liketavern 的最小闭环：`compileKey` + `matchCompiled` + `textsAtDepth`（**别一上来做递归/定时/group**）。
- 要做扎实就用 roleplay 的 `activation.js` —— 纯函数、零 DSH 依赖、~480 行，报告称「全仓性价比最高的一个文件」。

**#2 我们独有的优势：用 `rp_random` 做可复现触发。**
两个参考项目都只能靠 `sha256(runId:bookId:entryId)` 之类的伪随机来保证可回放；
而我们本来就有 `rp_random`（`seed` 可复现的骰子）。所以可以做成：

> 世界书条目带 `probability`，掷点走 `rp_random(seed = <会话id>:<轮次>:<条目id>)`。
> 这样**触发既随机又可精确回放** —— 玩家质疑「这条设定怎么突然出现了」时能复现。
> 这是两个参考项目都做不到的（它们没有骰子工具）。

**#2 必须遵守的细节**（来自两份报告的踩坑）：
- **中文场景 `matchWholeWords` 默认 false**（ST 出厂默认整词匹配，对中文很不友好）。
- token 预算**按 first-fit / 超限跳过该条**，不是「丢最低优先级」也不是「停止扫描」。
- 超长键 / 灾难性回溯正则 → **判为永不命中，不抛错**。
- 正则键注意 `g`/`y` 标志的 `lastIndex` 残留（会导致奇偶次漏匹配）。
- **常驻条目不要参与随机**：钉死机制会把掷骰冻结成「每会话一次」，而 fork 出的子会话换种子重掷会与父会话字节漂移、打穿前缀缓存。

### 7.3 P1（显著提升）

| # | 做什么 | 为什么 | 难度 |
|---|---|---|---|
| 5 | **Writer / Commit 分离** | 结构上杜绝「正文与副作用混杂」。**我们的生图工具最受益**：现在生图和剧情挤在同一条消息里，很容易图文不一致 | 中 |
| 6 | **状态追踪（关系/物品/任务）** | 双面契约很值得学：同一份数据给模型看可读 JSON、给提交路径看紧凑契约，**不靠 prompt 写规矩** | 大 |
| 7 | **`{{char}}` / `{{user}}` 宏展开** | 角色卡与风格文本里必然出现；不展开就是硬伤。可逆做法：未绑定则原样保留 | 小 |
| 8 | **工具说明段与实际可见工具对齐** | 我们给 dm 预设过滤了工具，但提示词里可能残留「你有 rp_illustrate」这类指导 | 小 |
| 9 | **缓存字节稳定性守卫测试** | 前缀缓存只认追加点之前的字节，任何抖动整段打穿，而退化是**静默的** | 小 |

### 7.4 明确不做（会失控）

- **event-sourced + 投影 + WAL 楼层事务**：那是给「日志即唯一事实源、可回放可重建」的严肃引擎准备的。我们按会话存 JSON 就够。
- **QuickJS/EJS 沙箱**：为跑社区角色卡的第三方脚本而建。不做第三方卡就不需要。
- **消息操作全套**（编辑/删除/重生成/分支）：roleplay 花了约 13K 行，是最深的护城河，重做性价比极低。
- **MVU 兼容**：为迁就某个社区变量扩展写 866 行测试，除非有明确用户需求。
- **`budgetPriority` / `promptCategory` 那套预算裁剪**：**roleplay 自己都没实现** —— 报告做了独立交叉验证：
  全仓只有 5 处注册写入 + 2 处 metadata + 1 处 catalog，**零个消费点**；测试里甚至有反向断言
  「大 factual source 不受本地容量限制」。所以 `docs/rp-architecture.md:82` 的预算是纯文档承诺。
  要做就做我们自己的明确预算，别照抄语义悬空的字段。
- **ST 全量兼容**：那是 liketavern 的产品定位。我们兼容一半反而制造期望落差。

### 7.5 一条被纠偏的认知（记下来，免得误导后续判断）

我先前把 roleplay 的长期记忆描述为「接管 `ctx.compaction` 服务」，**不准确**。精确说法是：
它**继承 `BasicCompactionEngine` 成为该 preset realm 内的 `compaction` 服务**（只重写 4 个方法），
preset 用 `isolate: { compaction: true }` 装它并**故意不装 `compaction-basic`**。
触发不靠自己注册，而是继承来的上游 `agent/pre-step` handler。→ 难度判断（大）不变，
但实现路径是「**继承覆盖**」而不是「另起一套」。

同理还有一处：**`rp-state-display` 只是只读卡片，不是可编辑的状态面板**（Host 半边是空 `apply(){}`）。
所以「用户可编辑的世界状态面板」在参考项目里**没有现成实现可抄** —— 那反而是我们可以做得更好的地方
（我们已经有右侧栏面板 + 会话配置的读写通道）。

### 7.6 值得抄的两个一致性习惯（来自 roleplay 的 state 实现）

1. **投影自校验**：要求「按 mutations+entities 重放的结果 === 缓存值」，否则整体判坏。
   这让「投影可丢弃、可从日志重建」不只是口号。
2. **revision 在执行时与重放时各校验一次**，且一次提交内每个 namespace 至多一个 effect（重复即报错）。
   另外它**不静默降级**：旧版本数据直接抛错并给明确迁移路径。
3. 诊断只为「能改变模型行为」的项保留，滤掉 `info` 级噪音 —— 避免把噪音喂给模型。

### 7.7 两个平台级的坑（他们的代码已经踩过，我们照抄结论即可）

1. **浏览器 Remote 调用会重绑定 `this.ctx`**（Cordis 4.0.2）：provider 里要存 `this.selfCtx = ctx`，别依赖 `this.ctx`。
   我们现在用自建 HTTP 路由绕过了，但**别在服务方法里依赖 `this.ctx`**。
2. **「先用后禁用」竞态**：新插件行在 settings 就绪前就装载 → 卡片显示关闭但功能已生效。
   修法是新 host 行先 `disabled: true` 停驻，设置对账后再 `entry.update({ disabled })` 启停。
   （我们的设置页如果要开关功能，照这套做。）

---

## 8. 差距复审（当前状态）

> 复核时间：世界书 + 角色卡 + 注入通道落地之后。已逐项对照代码，**不重复列出已完成的项**。

### 8.1 已经补上的（对照三个参考项目的共性缺口）

| 能力 | 状态 | 实现位置 |
|---|---|---|
| 提示词主动注入（两条通道） | ✅ | `installStandingPrompt()`：`rp:standing`(order 210) + `rp:turn`(order 20) |
| 世界书 / 关键词触发检索 | ✅ | `parseLoreMarkdown` / `activateLore` / `renderLore`，文件在会话工作区 |
| 确定性概率触发 | ✅ | `seededRoll()`，复用 rp_random 的同一套 PRNG（可精确回放） |
| 角色卡字段（给样本 > 给形容词） | ✅ | `CHARACTER_FIELDS` 8 字段，含 `first_mes` / `mes_example` |
| 角色卡按需注入 | ✅ | `renderCharacterIndex`（常驻只放索引）+ `charactersToExpand`（出场才展开详情） |
| 角色生图一致性（第一版） | ✅ | `characterSeed()`：同角色固定 seed；多角色同框时不固定 |
| **状态追踪** | ✅ | `rp_state` + `applyStateUpdates` / `renderState`，注入在 turn 通道最前 |
| 按条补读、禁止整本倾倒 | ✅ | `rp_lore` 的 `list` / `find` / `template` 三个动作 |
| 本地 LoRA 选取 | ✅ | `/rp-tools/loras` + 设置页下拉 |
| fork 继承会话配置 | ✅ | `copyRpSessionFromParent()` + `session/created` |

### 8.2 仍缺（按「与本插件定位的契合度 × 收益」排序）

| # | 缺口 | 参考实现怎么做 | 我们为什么缺 | 难度 |
|---|---|---|---|---|
| A | **角色一致性（同一角色跨场景长得一样）** | 三家都没有真做（hermes 只给了外观字段顺序纪律） | 我们唯一的护城河就是生图，而这是它最大的痛点 | 小（固定种子）／大（参考图） |
| B | **角色卡按需注入** | 关键词激活 | 现在全量注入，人一多就膨胀；数据已就绪 | 小 |
| C | **状态追踪（关系/物品/地点/伤势）** | roleplay 的 `rp-state`：event-sourced 投影 + 双面契约 | 完全没有；长战役里模型会忘掉上一幕的状态 | 中大 |
| D | **输出的机读状态块 + 正则收口** | hermes 状态栏 + liketavern `output/render` 正则 | 完全没有；且这是 A/B 的天然触发器（场景变了就出图） | 中 |
| E | **Writer/Commit 分离** | roleplay 把叙事与副作用提交分开 | 生图和剧情挤在同一条消息里，容易图文不一致 | 中 |
| F | **`{{char}}` / `{{user}}` 宏展开** | roleplay 的可逆宏 | 角色卡与风格文本里必然出现，不展开是硬伤 | 小 |
| G | **采样参数（temperature / stop）** | `agent/request` 瀑布 | 没有；stop 串对防抢话有用 | 小 |
| H | **设置页的编辑草稿持久化** | liketavern 专门做了 | 表单字段多，误刷新丢配置 | 中 |

### 8.3 明确不做（复核后仍然成立）

- event-sourced + WAL 楼层事务、QuickJS/EJS 沙箱、消息操作全套（约 13K 行）、MVU 兼容、
  `budgetPriority` 那套预算裁剪（**roleplay 自己都没实现**）。
- **不做 ST 角色卡导入**（用户已确认）—— 只学字段设计，不接生态格式。

### 8.4 A 的可行性已实测

本机 ComfyUI 环境（用 `/object_info` 查的实况，不是猜的）：

| 需要的东西 | 状态 |
|---|---|
| `qwen_image_2512_fp8_e4m3fn.safetensors` | ✅ 在 |
| Qwen 文本编码器（`qwen3vl_4b_fp8_scaled` 等 3 个） | ✅ 在 |
| `Qwen-Image-Edit-2509-Lightning-4steps-*.safetensors` LoRA | ✅ 在 |
| `ReferenceLatent` 节点 | ✅ 有 |
| `ControlNetLoader` / `CLIPVisionLoader` / `ImageStitch` | ✅ 有 |
| `IPAdapterModelLoader` | ❌ 无（所以别走 IPAdapter 那条路） |

所以「角色参考图」的正路是 **Qwen-Image-Edit 路线**：先用 krea2 出一张立绘当基准 → 之后要出该角色的图时，
走一条新的 Qwen 工作流模板，把基准图作为 `ReferenceLatent` 注入。

**代价**：要新增第二个工作流模板（现在是 krea2-only）+ 首次加载 ~20GB 模型。
**先做小版本**：每角色固定 seed（几行代码、零成本、零风险），能显著提升观感一致性，
参考图作为第二步。

---

## 9. 待验证

- [ ] **注入是否被 `complete` 段还原**：契约里警告「registered complete section is restored after this waterfall」，
      而 dm 预设的 persona 正是 complete 段。重启宿主后读 `~/.dsh/data/dsh-rp-tools/_standing-probe.json`：
      `injectedContentPresent: true` 说明注入生效；`false` 则是被还原了，需要改用别的方式（比如 preset 内注入）。
      同一份探针还会给出 `loreEntries` / `loreInjectedChars`，用来确认世界书文件有没有被找到、有没有命中。
- [ ] **改预设要新建会话才生效** —— 组合在会话开始时读取，已在跑的 DM 会话仍用旧 persona。
- [ ] `dsh-roleplay` 报告里「`conversation.chat.node` 12 个 key」等 UI 细节未逐行核对（不影响结论）。
- [ ] 三份报告的代码位置都来自实际读取，但**均未运行**参考项目的测试/构建。
