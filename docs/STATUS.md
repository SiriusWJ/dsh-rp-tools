# 开发状态（STATUS）

> 快照时间：2026-09-12 · 版本 1.5.0 · 状态：**可用；架构已收敛为「一切都在 dm 预设作用域」，262 条断言全绿（含会话隔离回归）**
> 这份文档记录「现在做到哪了、什么验证过、什么没验证、坑在哪」——给未来的自己和协作者看。

---

## 1. 完成度总览

| 模块 | 状态 | 说明 |
|---|---|---|
| `rp_random` | ✅ 已上线（**dm 作用域**） | 骰子 / 区间 / 加权抽取 / 布尔，`seed` 可复现。曾经是全局工具，现与其余工具一起收进 dm |
| 生图链路（直连 ComfyUI） | ✅ 已验证 | 组装 API 工作流 → `POST /prompt` → 轮询 `/history` → 同源媒体代理；实测 1024² 13–18s、1344×768 25s |
| 风格库（10 种内置 + 可自定义） | ✅ 已验证 | `manga`（无 LoRA，默认）+ 9 个官方 Krea-2 LoRA；触发词 / CFG / 步数 / 尺寸预设。设置页可**新增/删除自定义风格**，每条风格的 **LoRA 从本地清单下拉选取**（ComfyUI `/object_info/LoraLoaderModelOnly` → `/rp-tools/loras`）；内置风格不可删 |
| `rp_illustrate` / `rp_styles` | ✅ 已验证 | 出图、风格列举、aspect→尺寸换算 |
| **PNG 故事书导入** | ✅ 宿主已验证（界面待确认） | 工作区那一行的「📖 导入 PNG 故事书」：列卡库（3269 张，服务端过滤/分页）→ 预览 → 导入。世界书**追加合并**进 `<工作区>/rp-worldbook.md`、卡全文 `rp-sessions/<会话 id>/cards/<slug>.md`（超预算条目的去处）、卡面复制当立绘；角色/世界/战役名写进会话配置；自动切 `dm` 预设 + 发开场指令。真卡库实测：160/160 解析成功（中位 1ms）、642 条目的卡导入 25 条 |
| `rp_character`（8 字段） | ✅ 已验证 | 增删查 + 立绘；字段含 `first_mes` / `mes_example` 两个**样本字段**（给样本 > 给形容词）。导入的卡面会作为默认立绘显示在角色卡下面 |
| **提示词注入（两条通道）** | ✅ **已实测生效** | `rp:standing`(order 210) 放战役名/世界设定/**角色索引**；`rp:turn`(order 20) 放**当前状态 + 世界书命中 + 在场角色详细卡**。实测：Cordis 会话为空、dm 会话三条通道齐全 |
| **世界书** | ✅ 已实现（未实跑） | 会话工作区的 `rp-worldbook.md`；`##` 分条、`keys/constant/order/prob` 标记；触发式注入 + 预算 + 被裁列出标题；`rp_lore` 按条补读 |
| **状态追踪（`rp_state`）** | ✅ 已实现（未长跑验证） | 场景/时间/地点/在场/线索 + 队伍（状态·持有·伤病·目标）+ 自由旗标；空串即清除；注入在 turn 通道最前；多轮未更新会提醒 |
| `rp_session`（会话隔离） | ✅ 已验证 | A/B 两会话实测互不干扰 |
| `rp_scenes`（整幕批量） | ⚠️ 已实现，未实跑 | 逻辑与 `rp_illustrate` 同源，未用真实 `scenes_*.json` 跑过整幕 |
| `rp_config`（全局配置） | ✅ 已实现 | 负面词 / 全局默认风格 / ComfyUI 地址 / 单风格字段 |
| `rp_table`（随机表） | ✅ 已验证 | 定义 + 掷表（`1d6 → 4 → 幽灵` 实测） |
| 设置页「RP工具」 | ✅ 已上线 | 全局配置 + 风格库卡片（可增删 / LoRA 下拉）+ 工具列表（只列名字与一句话说明）；下拉框用主题 token 上色，浅深色主题都清晰 |
| DM 会话「🎲 RP」入口 | ✅ **已界面确认** | 判定用 `useSessions().byId[id].projectionValues.agentPreset === 'dm'`（与官方 agent-preset 标签同源）；入口在头部**右上角**（`conversation.session.header.utilities`），外观对齐宿主设计系统（28px 高 / 14px 圆角 / 细边框 / 11px 字，面板打开时有按下态） |
| RP 面板（右侧栏页签） | ⚠️ **待界面确认** | 注册 `sidebar.right.pane.tab`（key `dsh-rp-tools`）：点入口 → `ctx.sidebarRight.openTab()` → 右栏展开；收起/浮动/关闭由 DSH 右栏负责 |
| **作用域隔离（全在 dm）** | ✅ **已实测** | host 组合**不注册任何模型工具**；全部 10 个工具与两条注入通道都由 `rp-bridge.mjs` 在 agent 作用域注册。实测：Cordis 会话的工具列表里无 rp、上下文里无跑团内容；dm 会话三条通道齐全 |
| dm 预设接线 | ✅ 已配置 | `keepGlobalTools` 只剩 3 项（`render_ui` / `validate_dsh_ui` / `web_search`）—— 全部 rp_* 现在都在本作用域注册，不需要放行；`rp-bridge.mjs` 已放入预设目录 |
| 宿主侧单元测试 | ✅ 已建立 | `tools/smoke-dm.mjs` **194 条** + `tools/smoke-card.mjs` **64 条** + `tools/smoke-client.mjs` + `tools/verify-roundtrip.mjs` 4 条。覆盖作用域隔离、路由体检（7 条）、世界书、状态、风格库增删、LoRA 清单、cross-origin 拒绝、fork 继承、PNG 解码（三种文本块 / `ccv3` 优先 / 截断容错）、卡库路径逃逸、导入闭环（世界书真的按触发词进注入） |
| 真卡库探针 | ✅ 已建立 | `tools/probe-cardlib.mjs`：拿本机 3269 张真卡跑列表/搜索/抽样解析/真导入（只读 + 临时目录） |

---

## 2. 关键设计决策（附理由）

**① 不依赖 dsh-comfyui 插件。**
最初版本把风格存成 dsh-comfyui 工作流库里的工作流、走它的 `/comfyui/workflows/run`。实测后改为**直连 ComfyUI**（`POST /prompt` + `/history`）：
- 用户本机是 Comfy Desktop，插件不该强迫他再启用另一个插件；
- 媒体用**插件自己的同源代理** `/rp-tools/media` 转发 ComfyUI 的 `/view`，跨端口问题消失；
- 代价：不再出现在 dsh-comfyui 面板的队列/资产里（可接受，两者可各自独立使用）。

**② 风格 = 内置工作流模板，而不是外部工作流。**
`WORKFLOW_TEMPLATES.krea2` 在代码里生成 API 工作流，按风格注入 `lora_name` / 触发词 / CFG / 步数。好处：零外部依赖、可版本化；将来要接别的模型只需加一个模板函数。

**③ "只在 DM 会话出现"的实现（最终形态：一切都在 dm 作用域）。**
- **工具层**：host 组合**不注册任何模型工具**；全部 10 个 `rp_*`（含 `rp_random`）都由
  `registerRpTools(ctx)` 在 **agent 作用域**注册（由 dm 预设的 `rp-bridge.mjs` 调用）
  → 非 dm 会话**看不到也用不到**。
- **提示词注入**：同样只在 agent 作用域注册（`installStandingPrompt`）。`system-prompt/assemble`
  是**按作用域过滤**的事件，所以回调只收到本会话的装配 —— 「只在 DM 生效」与「会话隔离」
  由 Cordis 免费保证，**不需要猜会话 id**。
  ⚠️ 早先版本把它放在全局 `apply()` 里并写了一套「猜当前会话」的启发式，两个错都犯过：
  全局注册让每个会话都带上跑团世界观；猜会话会**把别的战役设定注进来**。相关代码已全部删除。
- **界面层**：`conversation.view`（页签）**无法按会话条件注册**（全局注册即全局出现），因此用
  `conversation.session.header.utilities`（会话头部右上角按钮）。
- **判定来源**：客户端从 `useSessions` 读 `byId[sessionId].projectionValues.agentPreset`——
  官方 `agent-preset` 标签组件渲染「本会话跑的预设」所用的同一字段。等于 `dm` 就是 DM 会话。
  回退路径：查 `/rp-tools/session` 的 `isDm`（预设投影未就绪时用）。

**④ 会话级 vs 全局的划分。**
- 全局（`styles.json`）：风格库、ComfyUI 地址、**负面词**、全局默认风格。
- 会话（`sessions/<id>.json`）：世界设定、角色卡、随机表、提示词前缀、会话默认风格、风格备注、战役名。
- 会话 id 来源：工具侧取 `exec.agent.id`；界面侧取 `useSessions((s) => s.current)`。
- **负面词只属于全局**：会话配置里没有它（旧版本曾在 `campaign.negative` 留过字段，
  写了但从没人读，1.1.2 已彻底清掉；面板里也不再出现任何负面词的说明）。

**⑤ 负面词为什么"可能不生效"。**
Krea-2 Turbo 官方推荐 CFG=1，而 CFG=1 时 KSampler 的负向条件被乘以 `(1-cfg)=0` —— 数学上不参与计算。插件把负面词写进负向文本编码节点，并在 UI/工具输出中**明确提示**：要让负面真正生效需把该风格 CFG 调到 1.5~2.5。这是模型特性，不是 bug。

---

## 3. 验证记录（实测）

**生图端到端**（`rp_illustrate`，默认 `manga` 风格）：

```
风格 黑白漫画（manga）· 1368×768 · 16.6s
提示词 = 触发词 + 用户描述 + 命中角色的外观
media: /rp-tools/media?file=rp_00002_.png&subfolder=&type=output
媒体代理：HTTP 200 · image/png · 1.6MB
```

**会话隔离**（`rp_session` / `rp_character`）：

```
[A 会话] 战役名：灰烬纪元 | 前缀：cinematic lighting | 角色：凯尔
[B 会话] 战役名：（未设） | 前缀：（未设）        | 角色：0 个   ← 完全隔离
```

**作用域隔离（实测）**：

```
全局注册的工具: （零个）
dm 作用域注册的工具: rp_random, rp_styles, rp_illustrate, rp_character, rp_state,
                     rp_lore, rp_session, rp_scenes, rp_config, rp_table
/rp-tools/tools → 10 个工具（插件自己的清单，与作用域无关）

Cordis 会话（非 dm）：工具列表里无 rp_*，运行时上下文里无跑团内容
dm 会话            ：三条通道齐全 —— 世界观(standing) / 当前状态 + 世界书命中 + 在场角色(turn)
```

**随机表**：

```
🎲 地下城遭遇表（1d6，6 条）
  1d6 → 4 → 幽灵    1d6 → 4 → 幽灵    1d6 → 2 → 陷阱
```

**ComfyUI 连通性**（`/rp-tools/check`）：`0.35.0 | cuda:0 NVIDIA GeForce RTX 5080 | vram_free ≈ 2.9GB`

**宿主侧单元测试**（`tools/smoke-dm.mjs`，伪造 ctx + Readable 请求体，12/12 通过；`DSH_HOME` 指向临时目录，不碰真实数据）：

```
被测模块: C:\Users\75373\.dsh\profiles\web\node_modules\dsh-rp-tools\lib\index.js
注册的工具: rp_random, rp_styles, rp_illustrate, rp_character, rp_session, rp_scenes, rp_config, rp_table
注册的路由: check, config, dm-mark, media, preview, reset, roll, session, state, tools
PASS  POST dm-mark 同源登记 / GET session(已登记 dm).isDm=true / (session- 前缀)=true
PASS  GET session(未登记).isDm=false          ← 入口不会污染其它会话
PASS  POST dm-mark 跨域被拒 got=403
PASS  登记后 isDm=true / 重复登记幂等 / 回读 preset="dm"
PASS  工具调用保底登记 =true
PASS  agent/created 自动识别 dm 预设 =true    ← 宿主侧可直接识别
PASS  agent/created 不误登记非 dm =false
结果: 12 通过 / 0 失败
```

**槽位契约核对**（`cordis_inspect_query` → client `Slots.listSubTree`）：
`conversation.session.header.actions` 的 `standardProps` **同时包含 `useSessions` 与 `sessionId`**，
本插件 cell（id `rp-tools`，order 40）在客户端 `active: true`；
`useSessions` 的 `list` store（`@deepseek-ai/dsh-api-session-controller`）里 `current` 存的是**裸 id 字符串**。

---

## 4. 已知问题与限制

| # | 问题 | 影响 | 现状 / 计划 |
|---|---|---|---|
| 1 | **DM 会话判定** | 曾导致「🎲 RP」按钮不出现 | **已修（待界面肉眼确认）**：根因有两层——① 会话 id 前后缀不一致（工具侧 `session-<uuid>` vs 界面侧裸 `<uuid>`），已由 `normalizeSessionId()` 统一；② **更隐蔽的一层**：客户端写 `String(fromHook \|\| props.sessionId \|\| '')`，而钩子初值是 `undefined`、切换期可能是**空串**，空串会把兜底短路 → 永久 `isDm:false` 且无任何报错。现改为「第一个非空字符串」取 id，并改用 `projectionValues.agentPreset === 'dm'` 作为权威判定（官方标签组件同源字段）。宿主侧 11/11 断言通过；只剩刷新页面确认 |
| 2 | 负面词在 CFG=1 下无效 | 全局负面词形同虚设 | 已文档化；提高该风格 CFG 即可生效（turbo 模型不建议 >2.5） |
| 3 | 面板上的「掷」走独立路由 | 与工具逻辑重复 | 已抽成同源实现（路由与工具共用 `parseDice`/`rollDice`）；如需完全统一可让路由调用工具内部函数 |
| 4 | 角色一致性 | 同一角色换姿势/场景会漂 | 目前靠 `character_sheet` 外观锚点 + 固定 seed；**未接** Qwen-Image-Edit 参考图方案（本机已有模型） |
| 5 | LoRA 强度未暴露 | 只能 1.0 | `WORKFLOW_TEMPLATES.krea2` 支持 `st.loraStrength`；设置页现在能**选 LoRA** 了，但强度仍是固定 1.0 —— 加一个数字输入即可（本机 LoRA 多为风格 LoRA，1.0 通常合适，所以不急） |
| 6 | 大尺寸未压测 | >1.5MP 的画质/耗时未知 | 已知 1344×768 稳定；`scenes` 里的 1664×928 未实测 |
| 7 | 媒体代理把整图读进内存 | 大图/视频会吃内存 | 当前仅图片；若接视频需改流式转发 |
| 8 | 客户端 bundle 需手动同步 | 改了不生效 | `file:` 依赖是安装期拷贝；已在 README「开发」写明同步命令。注意加载时机不同：**客户端 bundle 只在页面加载时读取（改完刷新页面即可）**，宿主 `lib/` 只在重启时装载 |
| 9 | 预设 id 硬编码为 `dm` | 预设目录改名则判定失效 | 客户端、`markDmSession`、导入时的 `agentPresets.select()` 都写死 `'dm'`；要支持改名就提成常量/配置项 |
| 11 | 故事书导入的**界面**未肉眼确认 | 点「导入并开始」后是否真的切预设 + 发开场 | 宿主 4 条路由已 HTTP 实测（列表 3269 张、解析成功、逃逸 400）；`remote.agentPresets.select()` 与 `uiWorkspace.startSession()` 只在页面里能验。**失败时面板会显示原因**，不会静默 |
| 10 | ~~fork 分叉后会话配置丢失~~ | ~~新建分支后世界 / 角色卡 / 随机表全没了~~ | **已修（待重启确认）**：`session/created` 时按 `header.parentSession` + `header.isSeeded` 判定「这是一次 fork」，把父会话的 RP 配置复制给子会话（快照语义，父子之后各改各的）；子会话已有配置则不覆盖；`isSeeded` 对 resume 为 false，所以重启恢复不会被误判。**宿主半侧改动，需重启生效** |

---

## 5. 路线图（按优先级）

1. **肉眼确认两处界面**：① 头部「🎲 RP」→ 右栏 RP 面板；② 工作区那一行的「📖 导入 PNG 故事书」→
   完整走一遍「选卡 → 导入并开始」，确认预设真切成 `dm`、开场指令真发出、工作区真落了文件。
   之后读 `_agent-probe.json`：若 `options.scalars.preset === 'dm'`，说明宿主侧 `agent/created`
   也能直接识别，可删掉 `rp-bridge.mjs` 里的登记段，把三条路径收敛成一条。
2. **让 DM 首轮把导入的设定拆成 8 个字段**（`personality` 目前整段塞进去，`appearance`/`speech`/
   `behavior`/`relations` 留空等 DM 提炼；`rp_character` 已支持）。
3. **角色一致性**：基于 Qwen-Image-Edit（本机 `qwen_image_2512_fp8_e4m3fn` + `Qwen-Image-Edit-2509-Lightning-4steps` LoRA）做「参考图 → 同角色新姿势」，作为 `rp_illustrate` 的可选 `reference` 参数。导入的卡面已经在工作区里，可直接当参考图。
4. **LoRA 强度**：风格条目加 `loraStrength`，设置页给滑块/输入框。
5. **整幕流水线**：用真实 `scenes_*.json` 跑通 `rp_scenes`，并把「幕 → 多格 → 拼页」流程写进文档。
6. **随机表联动**：`rp_table` 掷出的结果可以一键转为配图提示词（"掷到幽灵 → 顺手出一张幽灵立绘"）。
7. **导出**：把整个会话的 RP 配置（角色卡/世界/随机表/出图历史）导出成一份复盘文档。
8. **预设 id 参数化**：把硬编码的 `'dm'` 提成常量/配置，支持预设目录改名。
9. **ST 式正则表：不做**（2026-09-12 决定）。`{{user}}` 这类是**宏**（已用宿主变量 `systemPrompt.variable` 实现），
   正则表是另一件事，且要求把用户正则放进隔离执行器（参考实现如此），与轻量定位不符。详见 HANDOFF §5.11。
10. **卡库可搜索化增强**：现在按卡名/作者/标签搜；可以再加「按世界书条目数 / 分类多选 / 只看 v3 卡」。`/rp-tools/cards` 的参数已经留好了扩展位。

---

## 6. 环境与文件地图

```
源码        D:\Code\dsh\rp-tools-plugin
安装位置    ~/.dsh/profiles/web/node_modules/dsh-rp-tools        （file: 依赖，安装期拷贝）
预设接线    ~/.dsh/.agent-presets/dm/agent.cordis.yml            （白名单 + rp-bridge 条目）
            ~/.dsh/.agent-presets/dm/rp-bridge.mjs               （仓库内有副本 preset/rp-bridge.mjs）
数据        ~/.dsh/data/dsh-rp-tools/{styles.json, sessions/*.json, dm-sessions.json, _agent-probe.json}
私有卡索引  lib/card-index.js                                    （gitignore；缺失时自动扫目录兜底）
卡库        D:\Story\sillytavernassets\cards\<分类>\*.png        （3269 张，设置页「卡库目录」可改）
导入产物    <会话工作区>\rp-sessions\<会话 id>\{rp-worldbook.md, cards\<slug>.{md,json,png}}
ComfyUI     Comfy Desktop 0.35.0 · http://127.0.0.1:8188 · RTX 5080 16GB
模型        E:\AI\Models\models\{diffusion_models,text_encoders,vae,loras}
```

---

## 7. 变更历史

| 版本 | 主要变化 |
|---|---|
| 1.0.0 | 只有 `rp_random`（骰子/区间/抽取/布尔） |
| 1.1.0 | 新增 7 个 RP 工具；生图从「依赖 dsh-comfyui 工作流库」改为**直连 ComfyUI + 自建同源媒体代理**；风格库内置 10 种（含默认 `manga`）；**会话级隔离**（世界/角色卡/随机表/前缀/风格）；设置页「RP工具」（含工具清单与参数说明）；DM 会话头部「🎲 RP」浮层面板；负面词改全局并预置一套；RP 工具**只在 dm 预设作用域注册**；dm 预设白名单与桥接插件 |
| 1.1.1 | DM 判定收敛为**权威方案**（客户端读 `projectionValues.agentPreset`，宿主 `agent/created` 直接读 `agent.options.preset` 自动登记）；修掉「空串短路兜底」导致的入口静默不出现；删掉 `rp-bridge.mjs` 里靠猜测取会话 id 的登记逻辑；**RP 面板从自绘浮层改为右侧栏页签**（`sidebar.right.pane.tab`），入口移到头部右上角；新增 `tools/smoke-dm.mjs` |
| 1.1.2 | 设置页三处改进：**下拉框终于能看清**（原生 option 不继承背景，改用主题 token 上色）；工具列表**只留名字与一句话说明**（参数清单删掉）；**风格库可增删** + 每条风格的 **LoRA 从本地清单下拉选取**（新增 `/rp-tools/loras`，读 ComfyUI `/object_info`）；内置风格不可删；冒烟测试扩到 29 条断言（含风格增删与 LoRA 清单），并把 `DSH_HOME` 指向临时目录做到**零污染** |
| 1.2.0 | **提示词注入**：`rp:standing`(210) + `rp:turn`(20) 两条通道 —— 世界设定/角色卡终于真的进了模型上下文（此前 `world` 只是存在会话文件里，**从没进过上下文**） |
| 1.2.1 | **角色卡 8 字段**（学 hermes：给样本 > 给形容词，含 `first_mes`/`mes_example`）；**角色卡按需注入**（常驻只放索引，详细卡出场才展开）；**角色一致性第一版**（每角色固定 seed，多角色同框时不固定）；fork 继承会话配置 |
| 1.2.2 | **世界书**（会话工作区的 `rp-worldbook.md`，关键词触发 + 常驻 + 概率 + order + 预算，`rp_lore` 按条补读）；**状态追踪**（`rp_state`：场景/时间/地点/在场/线索 + 队伍 + 自由旗标，空串即清除） |
| **1.3.0** | **架构收敛：一切都在 dm 作用域。** host 组合不再注册任何模型工具（`rp_random` 也从全局收进 dm，全局 `inject` 改为 `[]`）；**提示词注入从全局 `apply()` 移到 agent 作用域** —— 此前它让每个会话都带上跑团世界观，还得靠「猜当前会话」的启发式（会把别的战役设定注进来），两者都已删除；dm 预设 `keepGlobalTools` 从 11 项缩到 3 项；修复 `/rp-tools/tools` 因删除全局数组而静默 400；测试补「路由体检」与「作用域隔离」断言，共 **146 条** |
| **1.5.0** | **世界书改为按会话隔离**（<工作区>/rp-sessions/<会话 id>/rp-worldbook.md）—— 修掉「同工作区两个会话的世界书混到一起」的事故：原先它放在工作区根目录，而工作区是按目录共享的；老文件首次读取时一次性迁移一份（保留原文件）。另：开场白改用**引导文件**（p-cards/*.opening.md，不截断，全部开场白都在里面）+ 面板可选第几条；截断不再往正文里插「（已截断…）」；世界书条目可查看详情/编辑/新建/删除 + 常驻就地开关；属性标签中文化（name:→名称、gender: Female→性别：女） |
| **1.4.0** | **PNG 故事书（角色卡）导入**：工作区那一行的「📖 导入 PNG 故事书」→ 列卡库（本地 3269 张，服务端过滤/分页）→ 预览 → **导入并开始**：世界书**追加合并**进工作区 `rp-worldbook.md`、卡全文写 `rp-sessions/<会话 id>/cards/<slug>.md`、卡面复制成 `rp-sessions/<会话 id>/cards/<slug>.png` 并当默认立绘、角色卡/世界/战役名写进会话配置、**自动切 `dm` 预设并发出开场指令**。四件套依据实测（`first_mes` 100% 广告 → 换 `alternate_greetings`；32% 条目无 keys → 补 `constant`；单卡最大 167 万字 → 限量 + 全文落文件）。新增 `lib/card-png.js`、`lib/card-import.js`、4 条路由（含路径逃逸防护）、私有卡索引缺失时的目录扫描兜底；测试补 `smoke-card.mjs`（64 条）与真卡库探针 `probe-cardlib.mjs`，共 **262 条断言** |
