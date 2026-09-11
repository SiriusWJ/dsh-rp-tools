# 交接文档（HANDOFF）—— 在新会话里继续开发

> 目标读者：**没有任何上文的新会话**。读完这一份即可继续改这个插件。
> 快照：2026-09-12 · v1.1.0 · commit 见 `git log`

---

## 0. 一句话现状

插件**已可用**：8 个 `rp_*` 工具、10 种风格、会话级战役配置、设置页与 DM 会话面板都已实现并大部分实测通过；
**唯一待界面确认**的是 DM 会话头部那个「🎲 RP」按钮——根因（会话 id 前后缀不一致）**已修复并做了数据迁移**，重启后应出现。

---

## 1. 关键路径

| 用途 | 路径 |
|---|---|
| 源码（权威） | `D:\Code\dsh\rp-tools-plugin` |
| GitHub | `https://github.com/SiriusWJ/dsh-rp-tools`（public，分支 `main`，topics 含 `dsh-plugin`） |
| 安装位置（profile） | `~/.dsh/profiles/web/node_modules/dsh-rp-tools`（`file:` 依赖 = **安装期拷贝，不会自动跟随源码**） |
| 数据目录 | `~/.dsh/data/dsh-rp-tools/`（`styles.json` / `sessions/<id>.json` / `dm-sessions.json` / `_agent-probe.json`） |
| dm 预设 | `~/.dsh/.agent-presets/dm/agent.cordis.yml`、`~/.dsh/.agent-presets/dm/rp-bridge.mjs`（仓库内有副本 `preset/rp-bridge.mjs`） |
| ComfyUI | Comfy Desktop **0.35.0** · `http://127.0.0.1:8188` · RTX 5080 16GB |
| 模型 | `E:\AI\Models\models\{diffusion_models,text_encoders,vae,loras}`（`Documents\ComfyUI\models` 是指向它的 junction） |
| 重启器 | 计划任务 `dsh-rp-restart` → `D:\Code\dsh\comfyui-workflows\rp-restart.cmd`（延迟 75 秒后 POST dsh-restart-btn 的重启接口） |

---

## 2. 当前功能（8 个工具）

| 工具 | 注册范围 | 作用 |
|---|---|---|
| `rp_random` | **全局** | 骰子 / 区间 / 加权抽取 / 布尔；`seed` 可复现 |
| `rp_styles` | dm 作用域 | 列出风格（触发词 / CFG / 步数 / 尺寸预设） |
| `rp_illustrate` | dm 作用域 | 按风格出一张图（`prompt`* `style?` `seed?` `aspect?` `width?` `height?`） |
| `rp_character` | dm 作用域 | 角色卡增删查 + 立绘（角色名出现在画面描述里会自动补外观） |
| `rp_session` | dm 作用域 | 本会话配置：世界 / 前缀 / 会话默认风格 / 风格备注 / 战役名 |
| `rp_scenes` | dm 作用域 | 按 `scenes[].panels[]` 逐格批量出图 |
| `rp_config` | dm 作用域 | **全局**配置：负面词 / 全局默认风格 / ComfyUI 地址 / 单风格字段 |
| `rp_table` | dm 作用域 | 随机表（表名 + 骰式 + 条目）定义与掷表 |

**界面**：设置页「RP工具」（全局配置 + 风格库卡片 + 工具清单与参数说明）；DM 会话头部「🎲 RP」按钮 → 浮层面板（世界 / 角色卡 / 随机表 / 本会话生图配置）。

---

## 3. 架构要点（改代码前必读）

**① 宿主半侧拆成两个入口**（`lib/index.js`）：
- `apply(ctx)`：全局——只注册 `rp_random` + 全部 HTTP 路由 + 监听 `agent/created` 写诊断快照。**不注册任何 RP 生图工具**。
- `registerRpTools(ctx)`：由 dm 预设的 `rp-bridge.mjs` 在 **agent 作用域**调用，注册另外 7 个工具；
  每个工具的 `execute` 被包了一层——**调用即 `markDmSession(sessionIdOf(exec))`**（保底登记）。

**② 生图链路**：`buildWorkflow(style, {...})` 生成 API 工作流 → `POST {baseUrl}/prompt` → 轮询 `/history/{id}` → 图片经**插件自己的同源代理** `/rp-tools/media` 返回（URL 形如 `http://127.0.0.1:3080/rp-tools/media?file=…`，前端据此渲染成聊天卡片）。**不依赖 dsh-comfyui**。

**③ 会话 id 归一化**（关键，刚修）：工具侧 `exec.agent.id` 形如 `session-<uuid>`，而会话目录 / 客户端 `useSessions().current` 是裸 `<uuid>`。`normalizeSessionId()` 统一剥掉 `session-` 前缀，`loadSession` 兼容旧文件名，`isDmSession()` 两种写法都能命中。

**④ 客户端两处贡献**（`client/client.js`）：
- `settings.section` id `rp-tools` → 设置页卡片；
- `conversation.session.header.actions` id `rp-tools` → DM 会话才渲染的按钮（组件先查 `/rp-tools/session?sessionId=` 的 `isDm`，**非 DM 直接 `return null`**）。
  该槽位**不传 `props.sessionId`**，但会注入 **`useSessions` 钩子**（用法见 dsh-pocket）→ 用它取当前会话 id。
  （为什么不用 `conversation.view` 页签：它**无法按会话条件注册**，一注册就所有会话都出现。）

**⑤ 全局 vs 会话**：全局 = 风格库 / ComfyUI 地址 / 负面词 / 全局默认风格（`styles.json`）；会话 = 世界 / 角色卡 / 随机表 / 前缀 / 会话默认风格 / 风格备注 / 战役名（`sessions/<id>.json`）。

---

## 4. 开发流程（照抄即可）

```powershell
# 1) 改源码：D:\Code\dsh\rp-tools-plugin\{lib/index.js, client/client.js}

# 2) 语法检查
node --check lib/index.js ; node --check client/client.js

# 3) 同步到 profile（file: 依赖是拷贝，必须手动同步！）
$dst = "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-rp-tools"
Copy-Item lib/index.js     "$dst\lib\index.js"      -Force
Copy-Item client/client.js "$dst\client\client.js"  -Force

# 4) 重启 dsh web（75 秒后自动重启，避免打断当前回合）
schtasks /Run /TN dsh-rp-restart

# 5) 冒烟测试（宿主逻辑可在 profile 上下文直接跑，不必等重启）
#    在 C:\Users\75373\.dsh\profiles\web\node_modules 下写 _x.mjs：
#    import * as mod from './dsh-rp-tools/lib/index.js'
#    伪造 ctx（tools.register / inject→webServer.register / effect）后 mod.apply 与 mod.registerRpTools
#    node _x.mjs
```

**发布**：`git add -A && git commit -m "..." && git push`（仓库已配好 origin；GitHub 账号 SiriusWJ，token 含 `repo`+`workflow`）。
**npm 不发布**（用户明确要求）。

---

## 5. 未解决 / 待验证（按优先级）

1. **DM 按钮是否出现**（本轮已修 id 归一化 + 迁移数据）：
   - 验证：刷新页面 → 打开 DM 会话 → 说一句让 agent 调一次 `rp_*` 工具 → 看会话头部是否出现「🎲 RP」。
   - 若仍不出现，下一步：
     a. 读 `~/.dsh/data/dsh-rp-tools/_agent-probe.json`（已在监听 `agent/created`，payload 只有一个键 `agent`；agent 的键有 `options` / `session` / `scope` / `ctx` / `systemPrompt` 等），**把探针扩展成 dump `agent.options` 与 `agent.session` 的键**，判断能否在宿主侧直接识别 dm 预设（那样就不必依赖登记）；
     b. 检查客户端是否真的拿到了 `useSessions`（在 `RpHeaderButton` 里临时把取到的 `sessionId` 打到 `console.log`）；
     c. 确认 `dm/rp-bridge.mjs` 的 `createRequire` 路径（默认 `C:/Users/75373/.dsh/profiles/web/package.json`，可用环境变量 `DSH_RP_PACKAGE`/`DSH_RP_PROFILE_PACKAGE` 覆盖）与 `ctx.agent` 是否取到 id。
2. **`rp_scenes` 未用真实 `scenes_*.json` 实跑过**（逻辑同 `rp_illustrate`；样例文件在 `~/.dsh/.../userdata/workflows/manga_pipeline/scenes_*.json`）。
3. **角色一致性**未做：目前只有「角色名→外观」锚点 + 固定 seed。可行方案：本机已有 `qwen_image_2512_fp8_e4m3fn` + `Qwen-Image-Edit-2509-Lightning-4steps` LoRA，接成 `rp_illustrate` 的参考图参数。
4. **LoRA 强度未暴露**：模板已支持 `st.loraStrength`，设置页/工具未开放。
5. 大尺寸（1664×928 等）未压测；媒体代理会把整图读进内存（仅适合图片）。
6. 面板「掷表」走独立路由 `/rp-tools/roll`，与 `rp_table` 工具共享 `parseDice`/`rollDice`。

---

## 6. 踩过的坑（别再踩）

| 现象 | 根因 / 解法 |
|---|---|
| 客户端卡片/按钮完全不渲染 | bundle 的 `factory` **必须自己声明** `var module = { exports: {} }`（官方 bundle 同样），否则 `module.exports.*` 赋给了错误对象 |
| 改了源码但行为没变 | `file:` 依赖是**安装期拷贝**，必须手动同步到 `node_modules`；且宿主代码/客户端 bundle **只在重启时装载** |
| `comfyui_run` 的 `inputs` 覆盖报错 | 那是 dsh-comfyui 的坑（对象被冻结）；本插件不用它——出图直接 `POST /prompt`，参数自己注入 |
| 面板/工具传参"静默失效" | 早期版本把风格存成 dsh-comfyui 工作流时，参数清单没保存 → 覆盖值被忽略。现在参数由插件自己注入工作流，不存在该问题 |
| PowerShell 里 `@(a + $b * 360, c + $d * 170)` 报 `Object[] 不包含 op_Multiply` | 逗号优先级坑，**每个表达式加括号** |
| `schtasks` 的 `/TR` 超 261 字符 | 把命令写进 `.cmd`，`/TR` 指向该 cmd |
| 从 pwsh 里 `Stop-Process` 匹配到自己 | 过滤 `CommandLine` 时别让当前命令自身的文本命中模式（用拼接绕过） |
| 负面词"不起作用" | Krea-2 Turbo 默认 CFG=1，负向被 `(1-cfg)=0` 消掉；把该风格 `cfg` 调到 1.5~2.5 才生效 |

---

## 7. 环境侧的既有资产（可复用）

- **模型**：`krea2_turbo_fp8_scaled`（12.2GB）、`qwen3vl_4b_fp8_scaled`（4.9GB）、`qwen_image_vae`、9 个 `krea2_*` 风格 LoRA（各 ~448MB）、`z_image_turbo_bf16`、`qwen_image_2512_fp8_e4m3fn` 等。
- **官方模板**（可参考构图/参数）：`~/.dsh/.../site-packages/comfyui_workflow_templates_json/templates/image_krea2_turbo_t2i.json`、`image_z_image_int8.json`。
- **可复用脚本**：`D:\Code\dsh\comfyui-workflows\` 下有 `fetch-models.ps1`（HF 断点续传）、`api-to-ui.ps1`（API→UI 图格式转换）、`run-comfy.ps1`（直连 ComfyUI 跑工作流）。
- **dsh-comfyui 插件**（仍在用，与本插件解耦）：其工作流库现有 3 个文生图工作流 + 1 个「跑团-暗黑水墨」（旧版遗留，可删）。

---

## 8. 下一步建议

1. 确认 DM 按钮 → 若正常，把 `docs/STATUS.md` 的「已知问题 #1」标为已解决。
2. `rp_scenes` 用真实场景文件实跑一次。
3. 接 Qwen-Image-Edit 做角色一致性。
4. 暴露 LoRA 强度；给 `rp_table` 加「掷出结果 → 顺手出图」。
5. 满 1 天后可向 `awesome-dsh-plugin` 提收录（用户自己维护该列表）。
