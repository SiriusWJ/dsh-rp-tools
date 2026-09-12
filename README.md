# dsh-rp-tools

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）用的 **跑团 / DM 工具插件**：
**中立随机裁决**（`rp_random`）+ **本地 ComfyUI 配图**（场景、NPC 立绘、道具线索、氛围图）+
**按会话隔离的战役配置**（世界设定 / 角色卡 / 随机表 / 风格偏好）+ **世界书与状态追踪** +
**PNG 故事书（SillyTavern 角色卡）导入** —— 选一张卡就能开团。

面向通用 DM 活动：任何模组、任何战役都能用；配图完全走本机 ComfyUI，不依赖任何云端服务。

> 设计取向：**只依赖 ComfyUI 本身**（直连 `POST /prompt` + 轮询 `/history`），
> 不使用 dsh-comfyui 插件的工作流库，因此两者可以各自独立使用。

---

## 特性

| | |
|---|---|
| 🎲 **中立随机** | `rp_random`：骰子表达式（`2d6+3` / `d20` / `3d8+1d4-2`）、区间、加权抽取、布尔翻转；`seed` 可复现，`count` 可批量 |
| 🖼 **本地生图** | `rp_illustrate`：直连本机 ComfyUI，Krea-2 Turbo（8 步 / CFG 1）+ Qwen3-VL 文本编码；1024² 约 13–18 秒，1344×768 约 25 秒 |
| 🎨 **10 种风格** | `manga`（黑白漫画，默认，无 LoRA）+ 9 个官方 Krea-2 风格 LoRA（水墨 / 点绘 / 蜡笔 / 抽象 / 雨窗 / 复古动画 / 水彩 / 运动模糊 / 塔罗）；每个风格 = 一套生图工作流，含触发词 / CFG / 步数 / 尺寸预设 |
| 🧑 **角色卡** | `rp_character`：登记「名字 + 外观」，之后**任何画面描述里提到该名字就自动补外观** —— 保持角色长相一致的主要手段，并可直接出立绘 |
| 📖 **PNG 故事书导入** | 工作区那一行的「📖 导入 PNG 故事书」：从本地卡库（SillyTavern PNG 角色卡）选一张 → **世界书**追加进本会话自己的 `rp-sessions/<会话 id>/rp-worldbook.md`、卡全文与卡面落进 `rp-sessions/<会话 id>/cards/`、角色卡/世界写进会话配置、**自动切 `dm` 预设并把开场指令发给 DM**。实测 3269 张卡库：解析 160/160 成功（中位 1 ms） |
| 📚 **世界书** | 会话工作区的 `rp-worldbook.md`：`##` 分条，`keys` / `constant` / `order` / `prob` 标记；**只有命中的条目进上下文**（每轮预算 12 条 / 6000 字），被裁的列标题供按需补读 |
| 📌 **状态追踪** | `rp_state`：场景 / 时间 / 地点 / 在场 / 线索 + 队伍（状态·持有·伤病·目标）+ 自由旗标；空串即清除；注入在每轮上下文最前 |
| 🌍 **会话隔离** | 世界设定 / 角色卡 / 随机表 / 提示词前缀 / 会话默认风格**按会话独立**，互不干扰；真正全局的只有风格库、ComfyUI 地址、全局负面词、全局默认风格、卡库目录 |
| 🎬 **整幕批量** | `rp_scenes`：吃 `scenes[].panels[]` 结构（含每格 positive/seed/宽高），一次出一整幕，单格失败不中断 |
| 🎲 **随机表** | `rp_table`：遭遇表 / 掉落表 / 情绪表…… 定义（表名 + 骰式 + 条目）、掷表、`count`/`seed`；面板上也能掷 |
| 🖥 **三处界面** | 设置页「RP工具」（全局配置 + 风格库 + 工具清单）；DM 会话头部的「🎲 RP」按钮（右侧栏面板：世界 / 角色卡 / 随机表 / 本会话生图配置）；工作区那一行的「📖 导入 PNG 故事书」 |
| 🔒 **只进 DM 会话** | RP 工具**只在 `dm` 预设作用域注册**，其它预设的会话既看不到工具、也没有任何 RP 界面（故事书导入入口只在**空白会话**或 DM 会话出现 —— 否则没法从零开团） |

---

## 安装

```bash
# 从 GitHub 装
dsh plugin --profile web add github:SiriusWJ/dsh-rp-tools
```

开发期用本地目录（本仓库即源码）：

```jsonc
// profiles/<profile>/package.json
"dependencies": { "dsh-rp-tools": "file:D:/Code/dsh/rp-tools-plugin" }
```

安装/改动后**必须重启 `dsh web`**（宿主代码与客户端 bundle 都只在启动时装载）。

### 前提：本机 ComfyUI（Comfy Desktop 亦可）

模型放在 ComfyUI 的模型目录（`models/`）：

```
models/diffusion_models/krea2_turbo_fp8_scaled.safetensors     ← 生图主模型（12.2GB）
models/text_encoders/qwen3vl_4b_fp8_scaled.safetensors         ← 文本编码（4.9GB）
models/vae/qwen_image_vae.safetensors                          ← VAE（0.24GB）
models/loras/krea2_*.safetensors                               ← 9 个风格 LoRA（各约 448MB，可选）
```

来源：<https://huggingface.co/Comfy-Org/Krea-2>（国内可用 <https://hf-mirror.com/Comfy-Org/Krea-2>）。
没有 LoRA 也能跑：`manga` 风格不使用 LoRA。ComfyUI 地址默认 `http://127.0.0.1:8188`，可在设置页改。

---

## 工具

10 个工具，全部以 `rp_` 开头，**全部只在 `dm` 预设作用域注册**。设置页「RP工具 → 工具列表」会实时展示同款清单（含每个参数的说明）。

| 工具 | 作用 | 主要参数 |
|---|---|---|
| `rp_random` | 中立随机裁决（骰子 / 区间 / 抽取 / 布尔） | `kind?` `dice?` `choices?` `weights?` `min?` `max?` `count?` `seed?` |
| `rp_styles` | 列出风格（触发词 / CFG / 步数 / 尺寸预设） | — |
| `rp_illustrate` | 按风格生成一张图 | `prompt`* `style?` `seed?` `aspect?` `width?` `height?` |
| `rp_character` | 角色卡增删查 + 出立绘 | `action`* `name?` `appearance?` `portrait?` `style?` |
| `rp_state` | 状态追踪（场景 / 时间 / 地点 / 在场 / 线索 + 队伍 + 旗标） | `action`* `field?` `value?` `party?` `flags?` |
| `rp_lore` | 世界书按条读取 / 生成模板 | `action`* `query?` `limit?` |
| `rp_session` | 本会话设置（世界 / 前缀 / 会话默认风格 / 风格备注 / 战役名） | `action`* `world?` `prompt_prefix?` `default_style?` `style_notes?` `campaign_name?` |
| `rp_scenes` | 按场景文件逐格批量出图 | `scenesFile`* `sceneId?` `style?` `limit?` |
| `rp_config` | **全局**配置（负面词 / 全局默认风格 / ComfyUI 地址 / 单个风格的触发词·步数·CFG） | `action`* `negative?` `default_style?` `base_url?` `style_key?` `trigger?` `steps?` `cfg?` |
| `rp_table` | 随机表定义与掷表 | `action`* `name?` `dice?` `entries?` `count?` `seed?` |

\* ＝ 必填。

---

## PNG 故事书导入

界面入口在**工作区那一行**（输入框上方，只在空白会话或 DM 会话出现）。点开 → 在本地卡库里搜卡 →
预览（世界书条数 / 开场白来源 / 世界与性格摘要）→ 「导入并开始」。

导入做的事：

1. 卡里的 `character_book` → **追加合并**进会话工作区的 `rp-worldbook.md`
   （按标题去重，**绝不覆盖你自己写的条目**；无 `keys` 的条目**不补 constant** —— 运行时用标题当触发词，
   而导入来的条目一律标 `source: card`，**不占系统提示**，命中了才进上下文）；
   条目名优先用卡给的，卡没给名字时依次用**正文里的第一个标题 → 触发词 → 正文首行**
   （所以不会出现「条目 4」「条目 5」这种认不出是什么的名字）；
2. 卡全文 → `<工作区>/rp-sessions/<会话 id>/cards/<slug>.md`（世界书有 60 条 / 6 万字预算，超出的设定在这里按需 `read`）；
3. 卡面 → `<工作区>/rp-sessions/<会话 id>/cards/<slug>.png`，登记成会话封面（**不是**某个角色的立绘）；
4. 角色卡 / 世界设定 / 战役名 → 会话配置（`creator_notes` 里的广告、社群号、CC 协议**逐行剔掉**，
   只有真正的说明才进【世界设定】；整段都是广告就不注入，全文仍留在卡文件里）；
5. 开场引导文件 → `<工作区>/rp-sessions/<会话 id>/cards/<slug>.launch.md`
   （选定开场 + 文件清单 + 已写入什么 + 待人工确认），并切成 `dm` 预设、只把**这个路径**发给 DM
   （首条消息约 60 字，绝不内联开场白）。

> **导入之后要收尾的事全在 `launch.md` 里**（DM 读那份文件就有全部开局任务）：角色字段归位、
> 世界书过滤（状态/历史类改成触发式、删空壳、补触发词、`constant` 只留 1–3 条）、
> 以及**按当前语言收拾标题与属性**（`name:` → `名称：`、`gender: Female` → `性别：女`；
> `条目 4` → 「战斗」这类实义名）。整本一起收拾用 `rp_lore(action:"localize")` /
> `rp_lore(action:"rename_unnamed")`，一次调用做完。
> 所以面板上**没有**「属性中文化」「重命名条目」这类按钮 —— 同一件事两个入口会让人以为没做。

### 注入分层（省 token 的关键）

| 通道 | 放什么 |
|---|---|
| **system standing**（每轮都在、字节稳定） | 通用 DM 规则、`session.dm.prompt`、战役名、世界设定、**紧凑人物索引**、路径指针、生图策略、**手写且在预算内的常驻世界书** |
| **runtime context**（每轮重新装配） | 当前状态、在场人物的详细卡、命中触发词的世界书条目、**导入来的条目**（含原卡标了 `constant` 的） |
| **文件（按需 read）** | 卡全文、全部备用开场白、被预算挡下的条目、导入映射 |

两条硬规则：**导入来的世界书正文不因 `constant` 自动进系统提示**（它按触发词走 runtime）；
**system standing 里的常驻世界书有 6000 字预算**，超出的降级为「按需」，而不是截断成残句。
同一个人物若既在世界书里、又作为人物卡在本轮展开，装配时会**跳过世界书那份**（诊断里记为
`character-duplicate`），避免同一批正文注入两遍。

卡库位置在**设置页 → RP工具 → 卡库目录**（默认是会话工作区下的 `rp-cards`）。
目录结构是 `cards/<分类>/*.png`；没有私有索引文件时退回按文件名扫目录，功能一样可用。

### 出图：默认尺寸与立绘复用

出图默认尺寸（设置页「图像」可改）：场景 **768×432**、立绘 **512×768**、道具 **512×512**。
出图时间基本正比于像素，而聊天里也渲染不到 1024 宽，所以 1.12.8 起调小了（单张大约 8~14 秒）；
老配置里**没动过**的那一档会跟着换成新值，**自己改过的保持原样**。

**立绘复用**：常驻段的【本会话设定】里有一行「已有可用图」—— 角色已有的生成立绘、
以及**导入卡的卡面**（对角色卡来说那张 PNG 就是它的立绘）都在那里。DM 第一次出场时直接展示它，
不必再花十几秒重出一张；确实没有图时才调 `rp_illustrate`。

需要一次出多张时，DM 会在**同一步**里并发发出多个 `rp_illustrate`（插件已把这两个工具声明为
并发安全，宿主才会真的并行调度）。ComfyUI 是单卡队列，**GPU 总时长不变** —— 省掉的是每张图
之间那几轮模型往返（长局里一步就是几万 input token）。

> ⚠️ 实测结论（3269 张卡，见 `docs/PNG-CARD-DECODE.md`）：**`first_mes` 100% 被广告污染**
> （`deepseektavern.com`），所以导入一律改用 `alternate_greetings` 的第一条；
> 40% 的卡正文只在 `character_book` 里，所以导入的主战场是**世界书**而不是角色字段。

---

## 数据与配置

```
~/.dsh/data/dsh-rp-tools/
├── styles.json                 全局：风格库 + 全局负面词 + ComfyUI 地址 + 全局默认风格 + 卡库目录
├── sessions/<sessionId>.json   会话级：世界设定 / 角色卡 / 随机表 / 前缀 / 会话默认风格 / 状态 / 立绘登记
├── dm-sessions.json            DM 会话登记表（界面据此决定是否显示 RP 入口）
└── _agent-probe.json           诊断用：agent/created 事件里可读到的字段快照

<会话工作区>/
├── rp-worldbook.md             世界书（可手写；导入的故事书条目也追加在这里）
└── rp-sessions/<会话 id>/cards/<slug>.{md,json,png}   导入产物：卡全文 / 规范化结果 / 卡面
```

`styles.json` 关键字段：

```jsonc
{
  "comfyui": { "baseUrl": "http://127.0.0.1:8188", "dshOrigin": "http://127.0.0.1:3080" },
  "defaultStyle": "manga",
  "negative": "low quality, worst quality, blurry, ... , lowres",   // 全局负面词（预置一套）
  "styles": {
    "manga": { "label": "黑白漫画", "workflow": "krea2", "lora": null, "cfg": 1, "steps": 8,
               "trigger": "black and white manga panel, screentone shading, crisp ink lineart, ...",
               "sizes": { "scene": [1344,768], "portrait": [768,1024], "item": [1024,1024] } }
  }
}
```

> ⚠️ **负面词与 CFG**：Krea-2 Turbo 建议 CFG=1，**此时负向条件在数学上不参与计算**（官方模板也如此）。
> 想让全局负面词真正生效，把对应风格的 `cfg` 调到 `1.5~2.5`（过高会让 turbo 模型过曝/崩坏）。

---

## DM 预设接线（关键，否则工具不出现）

RP 工具**只在 `dm` 预设作用域注册**。需要在预设目录做两件事：

**1. 放行工具**（`~/.dsh/.agent-presets/dm/agent.cordis.yml`）—— 该预设默认 deny 掉所有全局工具，只保留白名单：

```yaml
- id: dm-filter
  name: ./session-filter.mjs
  config:
    keepGlobalTools:
      - render_ui
      - validate_dsh_ui
      - web_search
```

> 全部 `rp_*` 工具现在都在本预设作用域注册（由 `rp-bridge.mjs` 调用 `registerRpTools`），
> 所以白名单里**不再需要放行任何 `rp_*`** —— 它只用于保留少数几个全局工具。

**2. 挂桥接插件**（把 RP 工具注册进本会话 + 登记 DM 会话）：

```yaml
- id: rp-bridge
  name: ./rp-bridge.mjs
```

`rp-bridge.mjs` 的副本见本仓库 [`preset/rp-bridge.mjs`](preset/rp-bridge.mjs)。

---

## 架构

```
dsh-rp-tools/
├── lib/index.js        宿主半侧（ESM）
│   ├── apply(ctx)              全局：**不注册任何模型工具**，只挂 HTTP 路由 + 监听 session/created（fork 继承、记录工作区）
│   ├── registerRpTools(ctx)    dm 作用域（由 rp-bridge 调用）：全部 10 个 rp_ 工具 + 两条提示词注入通道
│   ├── 生图链路                 组装 API 工作流 → ComfyUI POST /prompt → 轮询 /history → 同源媒体 URL
│   └── 配置层                  styles.json（全局） / sessions/<id>.json（会话）
├── lib/card-png.js     PNG 角色卡解码（tEXt / iTXt / zTXt，ccv3 优先，截断容错）
├── lib/card-import.js  卡 → 会话配置的映射（丢广告开场白、无 keys 条目补 constant、限量 + 全文导出）
├── client/client.js    客户端半侧（plain JS + React.createElement，无构建）
│   ├── settings.section「RP工具」                全局配置 + 风格库 + 卡库目录 + 工具清单
│   ├── conversation.session.header.utilities    仅 DM 会话渲染的「🎲 RP」按钮（打开右侧栏面板）
│   └── conversation.input.dock「📖 导入 PNG 故事书」  空白会话 / DM 会话里的故事书导入入口
├── preset/rp-bridge.mjs    dm 预设作用域桥接插件（副本，供安装参考）
├── cordis.patch.yml        bundle 补丁层
└── docs/                   交接文档（HANDOFF）/ 状态（STATUS）/ 卡格式实测（PNG-CARD-DECODE）
```

**HTTP 路由**（POST 全部同源保护，`Origin` 必须等于 `Host`）：

| 路由 | 方法 | 用途 |
|---|---|---|
| `/rp-tools/state` | GET | 全局配置 + 风格摘要（同时学习浏览器 origin，用于拼媒体 URL） |
| `/rp-tools/config` | POST | 写全局配置（含 `negative` / `baseUrl` / `cards.root` / 风格字段与增删） |
| `/rp-tools/reset` | POST | 恢复默认全局配置 |
| `/rp-tools/check` | GET | ComfyUI 连通性（版本 / GPU / 显存） |
| `/rp-tools/inject` | GET | 注入自检：某个会话**会**被注入什么（只读，不参与运行） |
| `/rp-tools/loras` | GET | 本地 LoRA 清单（读 ComfyUI `/object_info`） |
| `/rp-tools/session` | GET/POST | 读写某个会话的 RP 配置（角色卡 / 世界 / 随机表 / 状态 / 立绘） |
| `/rp-tools/dm-mark` | POST | 登记某会话为 DM 会话 |
| `/rp-tools/tools` | GET | 工具清单 + 参数说明（设置页用） |
| `/rp-tools/roll` | POST | 掷随机表（面板用） |
| `/rp-tools/media` | GET | **同源媒体代理**：把 ComfyUI `/view` 转成同源，图片才能在聊天里渲染 |
| `/rp-tools/preview` | POST | 试出一张（设置页 / 面板用，可带 sessionId） |
| `/rp-tools/cards` | GET | 列卡库（服务端搜索 / 分类 / 分页） |
| `/rp-tools/card` | GET | 解析单张卡 → 摘要与预览（不落盘） |
| `/rp-tools/card-import` | POST | 导入到某个会话（写世界书 / 卡全文 / 卡面 + 更新会话配置，返回开场指令） |
| `/rp-tools/card-image` | GET | 卡面图（只服务卡库内的 `.png`） |

> ⚠️ `/rp-tools/card*` 三条会把磁盘内容交给浏览器，路径一律经 `safeCardPath()`（`resolve` 后前缀比对卡库根 + 只认 `.png`）；
> 逃逸 / 绝对路径 / 非 png 全部 400。

---

## 开发

> **所有改动都在这个 git 仓库里做**（`D:\Code\dsh\rp-tools-plugin`，它本身就是
> `github.com/SiriusWJ/dsh-rp-tools` 的克隆）。**不要改 profile 里那份安装副本**
> （`~/.dsh/profiles/web/node_modules/dsh-rp-tools`）—— 它是重装时会被覆盖的产物，
> 改了既不进版本库，下次安装就没了。

```bash
node --check lib/index.js && node --check client/client.js      # 语法检查
```

这个插件在 profile 里是**从 GitHub 装的**（`"dsh-rp-tools": "github:SiriusWJ/dsh-rp-tools"`），
所以「本地源码 → GitHub → profile」是一条链，**本地不再是权威副本**：

```powershell
# 1) 改完 → 提交并推送（profile 装的就是 push 上去的那个 commit）
git -C D:\Code\dsh\rp-tools-plugin add -A
git -C D:\Code\dsh\rp-tools-plugin commit -m "feat(x): …"
git -C D:\Code\dsh\rp-tools-plugin push origin main

# 2) 重装，让 profile 跟上新 commit（不重装的话它还停在旧 commit）
dsh plugin --profile web add github:SiriusWJ/dsh-rp-tools

# 3) 改的是 dm 预设那一半，还要同步**活动预设目录**（它不属于这个包，只能手动拷）
Copy-Item preset\agent.cordis.yml     "$env:USERPROFILE\.dsh\.agent-presets\dm\agent.cordis.yml" -Force
Copy-Item preset\session-filter-v2.mjs "$env:USERPROFILE\.dsh\.agent-presets\dm\session-filter-v2.mjs" -Force
Copy-Item preset\rp-bridge.mjs         "$env:USERPROFILE\.dsh\.agent-presets\dm\rp-bridge.mjs" -Force
```

重启 `dsh web` 后生效（`lib/` 与 `preset/` 在启动时装载；`client/` 只需刷新页面）。

> 只改了文档（`docs/`、`README.md`）时第 2 步可以跳过 —— 安装副本里的文档不参与运行。

> 想跳过「push + 重装」这两步（改成改完即生效）：把依赖换成
> `dsh plugin --profile web add link:D:/Code/dsh/rp-tools-plugin`。
> 代价是 profile 直接读源码目录，与「商店里声明的是 GitHub」不一致 —— 二选一。
>
> ⚠️ 本机到 `codeload.github.com`（GitHub 打包下载域名）吞吐只有 ~25KB/s，且 Node 的 fetch
> 比系统下载慢十倍量级 —— **仓库 tarball 必须保持小**（这也是 `temp_output/` 被移出仓库的原因：
> 四张试出图占了 4.3MB，会让 `github:` 安装卡满超时）。

测试：

```bash
node tools/smoke-dm.mjs        # 宿主：作用域隔离 / 路由 / 世界书 / 状态 / 风格库 / 卡库导入
node tools/smoke-card.mjs      # PNG 卡解码 + 映射 + 开场指令 / 引导文件（合成 PNG 字节）
node tools/smoke-client.mjs    # 客户端 bundle：样式注入时机 / 槽位注册 / 面板渲染
node tools/verify-roundtrip.mjs <card-import.js>   # 导入↔解析往返（需 profile 里那份）
node tools/probe-cardlib.mjs   # 真卡库探针（只读 + 临时目录，手动跑）
```

当前开发状态、验证记录、已知问题与路线图见 **[docs/STATUS.md](docs/STATUS.md)**，
给新会话的交接文档见 **[docs/HANDOFF.md](docs/HANDOFF.md)**。

## License

MIT
