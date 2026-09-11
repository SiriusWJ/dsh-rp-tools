# 开发状态（STATUS）

> 快照时间：2026-09-12 · 版本 1.1.0 · 状态：**可用，DM 会话接入待确认**
> 这份文档记录「现在做到哪了、什么验证过、什么没验证、坑在哪」——给未来的自己和协作者看。

---

## 1. 完成度总览

| 模块 | 状态 | 说明 |
|---|---|---|
| `rp_random` | ✅ 已上线（全局） | 骰子 / 区间 / 加权抽取 / 布尔，`seed` 可复现；沿用原有实现 |
| 生图链路（直连 ComfyUI） | ✅ 已验证 | 组装 API 工作流 → `POST /prompt` → 轮询 `/history` → 同源媒体代理；实测 1024² 13–18s、1344×768 25s |
| 风格库（10 种） | ✅ 已验证 | `manga`（无 LoRA，默认）+ 9 个官方 Krea-2 LoRA；触发词 / CFG / 步数 / 尺寸预设 |
| `rp_illustrate` / `rp_styles` | ✅ 已验证 | 出图、风格列举、aspect→尺寸换算 |
| `rp_character` | ✅ 已验证 | 角色卡增删查 + 立绘；名字命中即自动补外观 |
| `rp_session`（会话隔离） | ✅ 已验证 | A/B 两会话实测互不干扰 |
| `rp_scenes`（整幕批量） | ⚠️ 已实现，未实跑 | 逻辑与 `rp_illustrate` 同源，未用真实 `scenes_*.json` 跑过整幕 |
| `rp_config`（全局配置） | ✅ 已实现 | 负面词 / 全局默认风格 / ComfyUI 地址 / 单风格字段 |
| `rp_table`（随机表） | ✅ 已验证 | 定义 + 掷表（`1d6 → 4 → 幽灵` 实测） |
| 设置页「RP工具」 | ✅ 已上线 | 全局配置 + 风格库卡片 + 工具清单与参数说明（实时读 `/rp-tools/tools`） |
| DM 会话「🎲 RP」浮层面板 | ⚠️ **未在界面确认** | 代码已就位；取决于能否正确判定「本会话是 DM 会话」 |
| 工具只在 DM 会话注册 | ✅ 已实现 | 全局只注册 `rp_random`；其余 7 个由 dm 预设的 `rp-bridge.mjs` 在 agent 作用域注册 |
| dm 预设接线（白名单 + 桥接） | ✅ 已配置 | `keepGlobalTools` 已加 8 项；`rp-bridge.mjs` 已放入预设目录 |

---

## 2. 关键设计决策（附理由）

**① 不依赖 dsh-comfyui 插件。**
最初版本把风格存成 dsh-comfyui 工作流库里的工作流、走它的 `/comfyui/workflows/run`。实测后改为**直连 ComfyUI**（`POST /prompt` + `/history`）：
- 用户本机是 Comfy Desktop，插件不该强迫他再启用另一个插件；
- 媒体用**插件自己的同源代理** `/rp-tools/media` 转发 ComfyUI 的 `/view`，跨端口问题消失；
- 代价：不再出现在 dsh-comfyui 面板的队列/资产里（可接受，两者可各自独立使用）。

**② 风格 = 内置工作流模板，而不是外部工作流。**
`WORKFLOW_TEMPLATES.krea2` 在代码里生成 API 工作流，按风格注入 `lora_name` / 触发词 / CFG / 步数。好处：零外部依赖、可版本化；将来要接别的模型只需加一个模板函数。

**③ "只在 DM 会话出现"的实现。**
- **工具层**：全局 `apply()` 只注册 `rp_random`；其余 7 个由 `registerRpTools(ctx)` 在 **agent 作用域**注册（由 dm 预设的 `rp-bridge.mjs` 调用）→ 非 dm 会话**看不到也用不到**。
- **界面层**：`conversation.view`（页签）**无法按会话条件注册**（全局注册即全局出现），因此改用 `conversation.session.header.actions`（会话头部按钮）——组件先问宿主 `isDm`，**不是 DM 就 `return null`**，一点痕迹都不留。
- 头部槽位**不传 `props.sessionId`**，但会注入 `useSessions` 钩子（dsh-pocket 同款用法）→ 用它取当前会话 id。

**④ 会话级 vs 全局的划分。**
- 全局（`styles.json`）：风格库、ComfyUI 地址、**负面词**、全局默认风格。
- 会话（`sessions/<id>.json`）：世界设定、角色卡、随机表、提示词前缀、会话默认风格、风格备注、战役名。
- 会话 id 来源：工具侧取 `exec.agent.id`；界面侧取 `useSessions((s) => s.current)`。

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

**工具注册拆分**：

```
全局注册的工具: rp_random
dm 作用域注册的工具: rp_styles, rp_illustrate, rp_character, rp_session, rp_scenes, rp_config, rp_table
/rp-tools/tools → 8 个工具（含参数说明）
```

**随机表**：

```
🎲 地下城遭遇表（1d6，6 条）
  1d6 → 4 → 幽灵    1d6 → 4 → 幽灵    1d6 → 2 → 陷阱
```

**ComfyUI 连通性**（`/rp-tools/check`）：`0.35.0 | cuda:0 NVIDIA GeForce RTX 5080 | vram_free ≈ 2.9GB`

---

## 4. 已知问题与限制

| # | 问题 | 影响 | 现状 / 计划 |
|---|---|---|---|
| 1 | **DM 会话判定** | 曾导致「🎲 RP」按钮不出现 | **已修（待界面确认）**：根因是会话 id 前后缀不一致——工具侧 `exec.agent.id` 为 `session-<uuid>`，会话目录/客户端 `useSessions().current` 为裸 `<uuid>`。已加 `normalizeSessionId()` 统一剥前缀、`isDmSession()` 兼容两种写法、`loadSession` 兼容旧文件名，并迁移了 `dm-sessions.json` 与 `sessions/*.json`（实测 `_agent-probe.json` 证实 agent.id 带前缀、登记表已写入 2 条）。下一步若仍有问题：扩展 `_agent-probe.json` 去 dump `agent.options` / `agent.session` 的键，判断能否在宿主侧直接识别 dm 预设 |
| 2 | 负面词在 CFG=1 下无效 | 全局负面词形同虚设 | 已文档化；提高该风格 CFG 即可生效（turbo 模型不建议 >2.5） |
| 3 | 面板上的「掷」走独立路由 | 与工具逻辑重复 | 已抽成同源实现（路由与工具共用 `parseDice`/`rollDice`）；如需完全统一可让路由调用工具内部函数 |
| 4 | 角色一致性 | 同一角色换姿势/场景会漂 | 目前靠 `character_sheet` 外观锚点 + 固定 seed；**未接** Qwen-Image-Edit 参考图方案（本机已有模型） |
| 5 | LoRA 强度未暴露 | 只能 1.0 | `WORKFLOW_TEMPLATES.krea2` 支持 `st.loraStrength`，但设置页/工具未开放；加一个字段即可 |
| 6 | 大尺寸未压测 | >1.5MP 的画质/耗时未知 | 已知 1344×768 稳定；`scenes` 里的 1664×928 未实测 |
| 7 | 媒体代理把整图读进内存 | 大图/视频会吃内存 | 当前仅图片；若接视频需改流式转发 |
| 8 | 客户端 bundle 需手动同步 | 改了不生效 | `file:` 依赖是安装期拷贝；已在 README「开发」写明同步命令 |

---

## 5. 路线图（按优先级）

1. **确认 DM 判定**：读 `_agent-probe.json` → 若宿主能识别 dm 预设，则去掉桥接的猜测逻辑，改为 `agent/created` 时直接登记；否则保留「工具调用保底」。
2. **角色一致性**：基于 Qwen-Image-Edit（本机 `qwen_image_2512_fp8_e4m3fn` + `Qwen-Image-Edit-2509-Lightning-4steps` LoRA）做「参考图 → 同角色新姿势」，作为 `rp_illustrate` 的可选 `reference` 参数。
3. **LoRA 强度**：风格条目加 `loraStrength`，设置页给滑块/输入框。
4. **整幕流水线**：用真实 `scenes_*.json` 跑通 `rp_scenes`，并把「幕 → 多格 → 拼页」流程写进文档。
5. **随机表联动**：`rp_table` 掷出的结果可以一键转为配图提示词（"掷到幽灵 → 顺手出一张幽灵立绘"）。
6. **导出**：把整个会话的 RP 配置（角色卡/世界/随机表/出图历史）导出成一份复盘文档。

---

## 6. 环境与文件地图

```
源码        D:\Code\dsh\rp-tools-plugin
安装位置    ~/.dsh/profiles/web/node_modules/dsh-rp-tools        （file: 依赖，安装期拷贝）
预设接线    ~/.dsh/.agent-presets/dm/agent.cordis.yml            （白名单 + rp-bridge 条目）
            ~/.dsh/.agent-presets/dm/rp-bridge.mjs               （仓库内有副本 preset/rp-bridge.mjs）
数据        ~/.dsh/data/dsh-rp-tools/{styles.json, sessions/*.json, dm-sessions.json, _agent-probe.json}
ComfyUI     Comfy Desktop 0.35.0 · http://127.0.0.1:8188 · RTX 5080 16GB
模型        E:\AI\Models\models\{diffusion_models,text_encoders,vae,loras}
```

---

## 7. 变更历史

| 版本 | 主要变化 |
|---|---|
| 1.0.0 | 只有 `rp_random`（骰子/区间/抽取/布尔） |
| 1.1.0 | 新增 7 个 RP 工具；生图从「依赖 dsh-comfyui 工作流库」改为**直连 ComfyUI + 自建同源媒体代理**；风格库内置 10 种（含默认 `manga`）；**会话级隔离**（世界/角色卡/随机表/前缀/风格）；设置页「RP工具」（含工具清单与参数说明）；DM 会话头部「🎲 RP」浮层面板；负面词改全局并预置一套；RP 工具**只在 dm 预设作用域注册**；dm 预设白名单与桥接插件 |
