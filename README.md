# dsh-rp-tools

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）用的 **跑团 / DM 工具插件**：
中立随机裁决（`rp_random`）+ 本地 ComfyUI 配图（场景、NPC 立绘、道具线索、氛围图）+
按会话隔离的战役配置（世界设定 / 角色卡 / 随机表 / 风格偏好）+ 世界书与状态追踪 +
PNG 故事书（SillyTavern 角色卡）导入 —— 选一张卡就能开团。

配图直连本机 ComfyUI（`POST /prompt` → 轮询 `/history/<promptId>` → `/view` 取图并存档），
不使用 dsh-comfyui 的工作流库，两者可各自独立使用。

---

## 依赖

| 依赖 | 必需性 | 说明 |
|---|---|---|
| **`@changfenhuang/dsh-genui`**（GenUI） | **必需** | 提供 `render_ui` / `validate_dsh_ui` 两个全局工具、`genui:fence` 提示词章节，以及浏览器端的 `dsh-ui` 围栏渲染器。dm 预设的过滤器**专门保留**这两个工具与这个章节，persona 也要求 DM「一律用 GenUI 组件画卡片」，面板的「显示到对话」同样只是往输入框填一段 `dsh-ui` 围栏。**没装它：`rp_*` 工具仍能调用，但 DM 画不出任何卡片/地图/状态面板，「显示到对话」也只能得到一段渲染不了的围栏。** |
| 本地 **ComfyUI**（Desktop 版亦可） | 出图必需 | 默认 `http://127.0.0.1:8188`，可在设置页改 |
| 生图模型（Krea-2 / NetaYumev35 / FLUX.1-Dev） | 按风格 | 见下方「模型前提」 |
| dsh-comfyui 插件 | 不需要 | 工作流模板内置在本插件里 |

安装（两个都要装；装完**必须重启 `dsh web`**，宿主代码与客户端 bundle 只在启动时装载）：

```bash
dsh plugin --profile web add @changfenhuang/dsh-genui
dsh plugin --profile web add github:SiriusWJ/dsh-rp-tools
```

### 模型前提：按风格准备

三个内置风格各对应一套内置工作流，需要的模型不同（都放在 ComfyUI 的 `models/` 下）：

| 风格 key | 标签 | 工作流 / 模型 |
|---|---|---|
| `uncensored_anime` | 二次元（**默认**） | `checkpoints/NetaYumev35_pretrained_all_in_one.safetensors` + `loras/tone001_manga.safetensors`（20 步 / CFG 5.5 / euler_ancestral） |
| `uncensored_real` | 写实 | `diffusion_models/flux1-krea-dev_fp8_scaled.safetensors` + `text_encoders/clip_l.safetensors` + `text_encoders/t5xxl_fp16.safetensors` + `vae/ae.safetensors`（20 步 / CFG 1） |
| `manga` | 黑白漫画 | `diffusion_models/krea2_turbo_fp8_scaled.safetensors` + `text_encoders/qwen3vl_4b_fp8_scaled.safetensors` + `vae/qwen_image_vae.safetensors`（8 步 / CFG 1，无 LoRA） |

Krea-2 来源：<https://huggingface.co/Comfy-Org/Krea-2>（国内镜像 <https://hf-mirror.com/Comfy-Org/Krea-2>）。
只装其中一个风格所需的模型也能用，把全局默认风格改成那一个即可。
早期内置的 9 个 krea2 风格（darkbrush / dotmatrix / retroanime…）已从风格库移除，老配置里会自动清掉。

---

## 特性

| | |
|---|---|
| 🎲 **中立随机** | `rp_random`：骰子表达式（`2d6+3` / `d20` / `3d8+1d4-2`）、区间、加权抽取、布尔翻转；`seed` 可复现，`count` 可批量（1..20），每掷给可核对的逐颗明细，骰式必须整串合法（`2dd6`、`2d6++3` 一律拒绝） |
| 🖼 **本地生图** | `rp_illustrate` / `rp_scenes`：三个内置风格（见上），单张约 8~25 秒（取决于风格与尺寸） |
| 🧑 **角色卡** | `rp_character`：`name` / `appearance` / `personality` / `speech` / `behavior` / `first_mes` / `mes_example` / `relations`；登记过外观的角色，在任何画面描述里被提到就自动补外观 |
| 📖 **PNG 故事书导入** | 从本地卡库选一张 SillyTavern PNG 角色卡 → 世界书 / 卡全文 / 全部开场白 / 卡面落进会话工作区，角色与世界观写进会话配置，自动切 `dm` 预设并把开场指令发给 DM |
| 📚 **世界书** | 会话工作区的 `rp-worldbook.md`：`##` 分条，支持 `keys` / `constant` / `order` / `prob`；命中的条目才进上下文 |
| 📌 **状态追踪** | `rp_state`：场景 / 时间 / 地点 / 在场 / 线索 + 队伍（状态·能力·持有·伤病·目标）+ 自由旗标；队伍默认**局部更新**，空串即清除 |
| 🌍 **会话隔离** | 世界设定 / 角色卡 / 随机表 / 宏表 / 提示词前缀 / 会话默认风格 / 生图开关按会话独立；全局的只有风格库、ComfyUI 地址、负面词、全局默认风格、图像尺寸、卡库目录、默认宏表 |
| 🎬 **整幕批量** | `rp_scenes`：吃 `scenes[].panels[]`（每格 positive/negative/seed/width/height），一次出一整幕，单格失败不中断 |
| 🎲 **随机表** | `rp_table`：定义（表名 + 骰式 + 条目）、掷表、`count` / `seed`；面板上也能掷 |
| 🔒 **只进 DM 会话** | 全局半侧**不注册任何模型工具**，`rp_*` 全部由 dm 预设的桥接插件在本作用域注册；其它预设的会话既看不到工具，也没有任何 RP 界面 |

---

## 工具

11 个工具，全部以 `rp_` 开头，**只在 `dm` 预设作用域注册**。设置页「RP工具 → 工具」会实时展示同一份清单。

| 工具 | 作用 | 参数 |
|---|---|---|
| `rp_random` | 中立随机裁决 | `kind?`（integer/float/choice/dice/bool）`dice?` `choices?` `weights?` `min?` `max?` `count?`（1..20）`seed?` |
| `rp_styles` | 列出风格（触发词 / 工作流 / CFG / 步数 / 尺寸 / 配置路径） | — |
| `rp_illustrate` | 出一张图，并自动存进资源库 | `prompt`* `style?` `seed?` `aspect?` `width?` `height?` `label?` `tags?` `kind?` |
| `rp_character` | 角色卡增删改查（+ 可选出立绘） | `action`*（list/set/remove/clear）`name?` `appearance?` `personality?` `speech?` `behavior?` `first_mes?` `mes_example?` `relations?` `portrait?` `style?` |
| `rp_state` | 状态追踪 | `action?`（set/get）`scene?` `time?` `location?` `present?` `clues?` `party?` `party_mode?`（merge/replace）`party_remove?` `flags?` |
| `rp_lore` | 世界书取条目 / 生成模板 / 整本收拾 | `action?`（find/list/template/localize/rename_unnamed）`query?` `limit?`（默认 3，上限 10） |
| `rp_session` | 本会话设置 | `action`*（get/set/clear）`world?` `prompt_prefix?` `default_style?` `style_notes?` `campaign_name?` `macro_name?`+`macro_value?` `dm_prompt?` `images_enabled?` `images_first_appearance?` `images_key_scenes?` |
| `rp_scenes` | 按场景文件逐格批量出图 | `scenesFile`* `sceneId?` `style?` `limit?` `label?` `tags?` |
| `rp_assets` | 浏览 / 标注资源库 | `action?`（list/get/tag）`kind?` `characters?` `tags?` `q?` `limit?`（默认 20，上限 200）`id?` `label?` |
| `rp_config` | **全局**生图配置 | `action`*（get/set）`negative?` `default_style?` `base_url?` `style_key?` + `trigger?` / `steps?` / `cfg?` |
| `rp_table` | 随机表定义与掷表 | `action`*（list/set/remove/roll）`name?` `dice?` `entries?` `count?` `seed?` |

\* ＝ 必填。`rp_illustrate` 与 `rp_scenes` 声明了 `isConcurrencySafe`，同一轮里发多个调用会被宿主并行调度（ComfyUI 侧仍排队）。

---

## 界面

**设置页「RP工具」**，三大类：

- **设定**（文字与卡库）：卡库目录（留空 = 会话工作区下的 `rp-cards`）、默认宏列表（键值对，名字可改）
- **图像**：ComfyUI 地址、全局默认风格、全局负面词、图像尺寸（场景 / 立绘 / 道具各一对宽高）、
  风格库（名称与 key 固定，CFG / 步数 / LoRA / 触发词可改）、试出预览、检查连接
- **工具**：`rp_*` 清单与参数说明 + 配置文件路径

**RP 面板**：DM 会话头部右上角的「🎲 RP」按钮 → 右侧栏页签（非 DM 会话这个按钮与页签类型都不注册）。
面板卡片：本会话生图、DM 设定、世界书、角色卡、**资源库**（没有图时整张卡片不渲染）、
**RP 表格 / 随机表**（没有表时不渲染）、当前状态、备份 / 会话包。

**工作区那一行的「📖 导入故事书」**：只在**未开局的 DM 会话**出现（导入进行中 / 刚导完会保持打开，方便看结果）。
RP 面板里另有一个常驻的导入入口（`embed` 模式），不受这条限制 —— 已经开局的团想再导一张卡走那里。

---

## PNG 故事书导入

从本地卡库搜卡 → 预览（分类 / 作者 / 世界书条数 / 开场白来源 / 世界与性格摘要）→「导入并开始」。

导入做的事：

1. 卡里的 `character_book` **追加合并**进会话工作区的 `rp-worldbook.md`（按标题去重，不覆盖手写条目；
   条目名优先用卡给的，卡没给名字时依次用正文第一个标题 → 触发词 → 正文首行）；
2. 卡全文 → `rp-sessions/<会话 id>/cards/<slug>.md`；
3. **全部开场白** → 同目录 `<slug>.opening.md`（不截断，可选第几条）；
4. 规范化结果 → `<slug>.json`；卡面 → `<slug>.png`（登记为会话封面，不当角色立绘）；
5. 开局引导 → `<slug>.launch.md`（选定开场 + 文件清单 + 已写入什么 + 待人工确认），
   并切成 `dm` 预设、只把这个路径发给 DM；角色卡 / 世界设定 / 战役名写进会话配置
   （`creator_notes` 里的广告、社群号、CC 协议逐行剔掉）。

> 导入之后要收尾的事全在 `launch.md` 里：角色字段归位、世界书过滤（状态/历史类改成触发式、
> 删空壳、补触发词、`constant` 只留 1–3 条）、按当前语言收拾标题与属性。整本一起收拾用
> `rp_lore(action:"localize")` / `rp_lore(action:"rename_unnamed")`，一次调用做完。

卡库位置在**设置页 → RP工具 → 卡库目录**（默认 `<会话工作区>/rp-cards`），目录结构 `cards/<分类>/*.png`。
没有私有索引文件时退回按文件名扫目录，目录内容变了会自动重扫（「刷新」可强制绕过缓存）。

### 注入分层

| 通道 | 放什么 |
|---|---|
| **system standing**（每轮都在、字节稳定） | 通用 DM 规则、`session.dm.prompt`、战役名、世界设定、紧凑人物索引、路径指针、生图策略、预算内的常驻世界书 |
| **runtime context**（每轮重新装配） | 当前状态、地图摘要、在场人物的详细卡、命中触发词的世界书条目、导入来的条目 |
| **文件（按需 read）** | 卡全文、全部开场白、被预算挡下的条目 |

导入来的条目按触发词走 runtime，不因 `constant` 自动进系统提示；system standing 里的常驻世界书有
**6000 字预算**，超出的降级为按需而不是截断。同一人物既在世界书里、又作为人物卡在本轮展开时，
装配会跳过世界书那份。

---

## 出图

默认尺寸（设置页「图像」可改）：场景 **768×432**、立绘 **512×768**、道具 **512×512**。
老配置里没动过的那一档会跟着换成新值，自己改过的保持原样。

`rp_illustrate` 不传 `width`/`height`/`aspect` 时：画面里只提到一个已登记角色 → 出**纵向立绘**，
否则出场景横幅。DM 给某角色出的第一张单人图会**自动记成该角色的立绘**（已有立绘时不覆盖）。

常驻段的【本会话设定】里有一行「已有可用图」（生成立绘、玩家导入的图、导入卡的卡面），
DM 直接展示即可，不必重出。角色卡编辑器里可以**生成立绘 / 重新生成 / 导入图片**
（png / jpeg / webp，≤8MB，存进 `<工作区>/rp-sessions/<会话 id>/portraits/`）/ 删除角色。

### 资源库

出图后插件会把图**真存一份**进会话目录（不是只记引用），并按分类分文件夹：

```
<工作区>/rp-sessions/<会话 id>/
├── assets.json                    索引：一张图一条（id / 分类 / 标签 / 角色 / 尺寸 / 风格 / 提示词 / sha256 / 时间）
└── assets/{portraits,scenes,items,other}/<id>.<ext>
```

入库入口：`rp_illustrate` 出图、`rp_scenes` 每格（整幕共享一个 `group`）、`rp_character(portrait:true)`、
面板「导入图片」；导入卡的卡面不入库。**按内容去重**：入库前比对 `sha256`，同分类同字节复用已有那条。
所有写索引的路径都过一把按会话串行的写队列（出图是并发的，read-modify-write 会丢记录）。

`rp_scenes` 的场景文件**字段名固定**：幕的 id 是 `scene_id`、分镜是 `panel_id`
（`sceneId` 参数筛的就是它，也兼容 `id`/`title`）；筛不到会直接报错并列出文件里实际有哪些 id。

**DM 侧**用 `rp_assets` 按 `kind` / `characters` / `tags` / `q` 查，每行都带能直接放进 `dsh-ui`
image 组件的地址；常驻段里只报条数。**DM 不能删图**，删除是玩家在面板里做的事。
**玩家侧**「资源库」卡片：分类筛选 + 搜索 + 图墙（服务端降采样缩略图）+ 点开看原图，
可改名称/标签、显示到对话、设为某角色的立绘、删除（连磁盘文件一起删并解除引用）。

---

## 备份 / 会话包

会话配置在全局数据目录、世界书与资源图在工作区，手工备份必漏一半，所以插件把它们打成一个 zip：

```
MANIFEST.json          格式与版本 / 导出时间 / 原会话 id / 每个文件的 sha256
session.json           会话配置
rp-worldbook.md        世界书（可能没有）
assets.json            资源库索引
assets/<分类>/<id>.<ext>
cards/<slug>.{md,opening.md,json,launch.md,png}
rp-map.json / rp-map-state.json      地图（可能没有）
```

- **导出**：面板「备份 / 会话包 → 导出会话包」是一个 `<a download>`，浏览器自己存盘。
- **快照**：「拍快照」写进 `<工作区>/rp-sessions/<id>/snapshots/`，**只保留最近 5 个**；只认自己写的
  `snapshot-*.zip`，用户放进该目录的别的包不会被当成快照、也不会被删。`snapshots/` 本身不进包。
- **导入**：**默认不覆盖** —— 目标会话已有内容时宿主回 409，界面问一句，确认后才带 `overwrite:true`
  重来，且覆盖前会自动拍一个快照兜底。
- 包是 **STORE（不压缩）** 的 zip；用别的工具重新打包会默认压缩 → 导入会明确报「只支持 STORE 包」。

解包是外部输入：条目名逐段判定 `..`／绝对路径／盘符，落盘时再做一次目标路径前缀校验，
清单里的 sha256 也逐个核对。

---

## 轻量地图（可选）

只在模组本身有地点结构时才用（地牢、宅邸、城镇）；没有地图就正常叙事。

```
<工作区>/rp-sessions/<会话 id>/
├── rp-map.json         静态结构：nodes（id/label/public）+ edges（id/a/b/label/state）
└── rp-map-state.json   运行时：node 当前节点 / revealed 已揭示 / edges 变化的边 / tokens 标记位置
```

**不加 `rp_map` 工具**，两个文件由 DM 用通用的 read/write 读写（节点 id 只允许 ASCII）。插件做两件事：

1. **每轮注入一行摘要**（跟在「本场当前状态」之后，实测约 64 字/轮）：
   `【地图】旧钟旅店·大堂｜已揭示 4/5｜可走：厨房（木门）、二楼客房（楼梯）｜队伍@大堂、老板@大堂`
2. **结构出问题时把话说明白**（而不是静默或渲染垃圾）：
   `【地图】⚠ node="nope" 不是 rp-map.json 里的节点`。状态文件存在但 JSON 坏了不会当成「还没建」，
   坏数据也不渲染摘要。

两个地图文件都计入会话包。DM 侧的约定（何时建图、画图用 `mermaid` 的 `flowchart LR`、
节点 ID 必须 ASCII、按钮只从当前节点的邻接边生成）写在 dm 预设的「## 地图」小节里，
action 命名三种：`map:<地图id>:move:<节点id>` / `map:<地图id>:unlock:<连接id>` / `map:<地图id>:search:<节点id>`。

---

## 数据与配置

```
$DSH_HOME/data/dsh-rp-tools/                     # DSH_HOME 默认 ~/.dsh
├── styles.json                 全局：风格库 + 负面词 + ComfyUI 地址 + 默认风格 + 图像尺寸 + 卡库目录 + 默认宏表
├── sessions/<sessionId>.json   会话级：世界 / 角色卡 / 随机表 / 宏表 / 前缀 / 默认风格 / 状态 / 立绘登记 / DM 设定
├── dm-sessions.json            DM 会话登记表（界面据此判断是否显示 RP 入口）
└── _agent-probe.json / _standing-probe.json   诊断快照（注入自检用）

<会话工作区>/
├── rp-worldbook.md             世界书（可手写；导入的故事书条目也追加在这里）
└── rp-sessions/<会话 id>/
    ├── cards/<slug>.{md,opening.md,json,png,launch.md}  导入产物
    ├── assets.json + assets/<分类>/<id>.<ext>           资源库
    ├── portraits/<文件>                                 玩家导入的立绘
    ├── rp-map.json + rp-map-state.json                  地图（可选）
    └── snapshots/snapshot-<时间>.zip                    恢复点（最近 5 个）
```

环境变量：`DSH_HOME`（数据目录根）、`DSH_RP_COMFY_URL`（覆盖默认 ComfyUI 地址）、
`DSH_RP_COMFY_ORIGIN`（覆盖默认 DSH 源）、`DSH_RP_PROFILE_PACKAGE`（见下方「DM 预设接线」）。

`styles.json` 关键字段：

```jsonc
{
  "comfyui": { "baseUrl": "http://127.0.0.1:8188", "dshOrigin": "http://127.0.0.1:3080" },
  "defaultStyle": "uncensored_anime",
  "negative": "low quality, worst quality, blurry, ... , lowres",   // 全局负面词（预置一套）
  "imageSizes": { "scene": [768, 432], "portrait": [512, 768], "item": [512, 512] },
  "cards": { "root": "", "macros": { "user": "玩家" } },            // root 空 = <工作区>/rp-cards
  "campaign": { "name": "", "prompt_prefix": "", "character_sheet": [] },
  "styles": {
    "manga": { "label": "黑白漫画", "workflow": "krea2", "lora": null, "cfg": 1, "steps": 8,
               "trigger": "black and white manga panel, screentone shading, ...",
               "sizes": { "scene": [768, 432], "portrait": [512, 768], "item": [512, 512] } }
  }
}
```

> `workflow` 可选 `krea2` / `uncensored_anime` / `uncensored_real`；风格里的 `sizes` 是单风格特例，
> 平时生效的是全局 `imageSizes`。Krea-2 建议 CFG=1，此时负向条件不参与计算 ——
> 想让全局负面词生效，把对应风格的 `cfg` 调到 `1.5~2.5`。

---

## DM 预设接线

`rp_*` 工具与两条提示词注入通道都由 dm 预设的桥接插件注册。预设目录（本机为
`~/.dsh/.agent-presets/dm/`）需要下面四份文件，仓库里都有副本：

| 文件 | 作用 |
|---|---|
| [`preset/agent.cordis.yml`](preset/agent.cordis.yml) | 预设本体：persona、文档工具（`dsh-tool-fs` / `dsh-tool-fs-search` / `dsh-tool-ask-user`）、会话过滤、桥接 |
| [`preset/session-filter-v2.mjs`](preset/session-filter-v2.mjs) | 工具与提示词章节过滤器（名单在挂载时对着**实时**全局注册表算，宿主增删插件都不用同步） |
| [`preset/rp-bridge.mjs`](preset/rp-bridge.mjs) | 桥接插件：调 `registerRpTools(ctx)` 把 11 个工具 + 注入挂到本会话 |
| [`preset/preset.yml`](preset/preset.yml) | 预设的名字与描述（预设选择器里显示的那两行） |

过滤器配置（`agent.cordis.yml` 里 `dm-filter` 那一段的核心字段）：

```yaml
- id: dm-filter
  name: ./session-filter-v2.mjs
  config:
    keepGlobalTools:            # 只保留这三个全局工具，其余全部 deny
      - render_ui               # ← 来自 dsh-genui
      - validate_dsh_ui         # ← 来自 dsh-genui
      - web_search
    blankPromptSections:        # 遮蔽的全局提示词章节（节选；保留 genui:fence，DM 靠它知道卡片怎么写）
      - ['harness:identity', -100]
      - ['app:web-surface', -98]
      - ['godot-bridge:config-guidance', 150]
      - ['ui:deliverable-file-references', 190]
    suppressRuntimeContext: false   # ⚠️ 不能开 true，开了每轮注入（状态/命中条目/在场角色）会被静默丢光
```

`rp_*` 工具都在本作用域注册，**不需要**在 `keepGlobalTools` 里放行任何 `rp_*`。

> ⚠️ `rp-bridge.mjs` 用 `createRequire()` 从 **profile 的 package.json** 解析已安装的 `dsh-rp-tools`，
> 默认路径写死为 `C:/Users/75373/.dsh/profiles/web/package.json`。换了用户名 / 机器 / profile 目录时
> 必须设 `DSH_RP_PROFILE_PACKAGE=<profile>/package.json`，否则桥接会打印
> 「注册 RP 工具失败」而工具与注入一个都不生效。

---

## 架构

```
dsh-rp-tools/
├── lib/index.js        宿主半侧（ESM, 6.7k 行）
│   ├── 全局 apply(ctx)         不注册任何模型工具：HTTP 路由 + session/created 监听
│   ├── registerRpTools(ctx)    dm 作用域：11 个 rp_ 工具 + system standing / runtime context 两条注入通道
│   ├── 生图链路                 组装 API 工作流 → POST /prompt → 轮询 /history → /view 取字节并归档
│   └── 配置层                  styles.json（全局）/ sessions/<id>.json（会话）
├── lib/card-png.js       PNG 角色卡解码（tEXt / iTXt / zTXt，ccv3 优先）
├── lib/card-import.js    卡 → 会话配置 / 世界书条目 / 开场文件 / launch 文件的映射
├── lib/png-thumb.js      纯 node:zlib 的 PNG 降采样（卡面与资源缩略图，零第三方依赖）
├── lib/rp-map.js         地图结构校验 + 每轮摘要渲染
├── lib/session-bundle.js 会话包编目（含 sha256 清单）
├── lib/zip.js / crc32.js STORE-only zip 读写与校验
├── client/client.js      客户端半侧（plain JS + React.createElement，无构建，3.6k 行）
├── preset/               dm 预设的四份文件（副本，供安装参考）
├── cordis.patch.yml      bundle 补丁层
└── docs/                 交接文档（HANDOFF）/ 状态（STATUS）/ 卡格式实测（PNG-CARD-DECODE）/
                          开发计划（DEVELOPMENT-PLAN）/ 参考对照（REFERENCE-COMPARISON）/ 提示词（PROMPT-CONTENT）
```

客户端挂载四类槽位：

| 槽位 | 内容 |
|---|---|
| `settings.section` | 设置页「RP工具」（三大类） |
| `conversation.session.header.utilities` | 「🎲 RP」按钮，**非 DM 会话返回 null** |
| `sidebar.right.pane.tab` | RP 面板本体（标签**类型**是应用级的，因此由上面那个按钮按引用计数注册/注销） |
| `conversation.input.dock` | 工作区那一行的「📖 导入故事书」 |

**HTTP 路由**（29 条；所有 POST 都做同源校验，`Origin` 必须等于 `Host`）：

| 路由 | 方法 | 用途 |
|---|---|---|
| `/rp-tools/state` | GET | 全局配置 + 风格摘要 + 自动宏名单（同时学习浏览器 origin） |
| `/rp-tools/config` | POST | 写全局配置（风格库 / 负面词 / 地址 / 卡库目录 / 默认宏表） |
| `/rp-tools/reset` | POST | 恢复默认全局配置 |
| `/rp-tools/check` | GET | ComfyUI 连通性（版本 / GPU / 显存） |
| `/rp-tools/inject` | GET | 注入自检：某个会话会被注入什么（只读） |
| `/rp-tools/loras` | GET | 本地 LoRA 清单（读 ComfyUI `/object_info`） |
| `/rp-tools/session` | GET/POST | 读写某个会话的 RP 配置 |
| `/rp-tools/dm-mark` | POST | 登记某会话为 DM 会话 |
| `/rp-tools/tools` | GET | 工具清单 + 参数说明（设置页用） |
| `/rp-tools/roll` | POST | 掷随机表（面板用） |
| `/rp-tools/media` | GET | 同源媒体代理：把 ComfyUI `/view` 转成同源 |
| `/rp-tools/portrait` | POST | 登记 / 清除某个角色的立绘 |
| `/rp-tools/asset-upload` | POST | 导入外部图进资源库（png / jpeg / webp，≤8MB） |
| `/rp-tools/portrait-upload` | POST | 上面的别名（默认 `kind=portrait`，需角色名） |
| `/rp-tools/portrait-image` | GET | 把**登记过**的导入立绘发回浏览器 |
| `/rp-tools/assets` | GET/POST | 资源库：列出 / 改名称与标签 / 删除 / 设为某角色立绘 |
| `/rp-tools/asset-image` | GET | 发资源图（`thumb=1&width=N` 走服务端降采样） |
| `/rp-tools/preview` | POST | 试出一张（设置页 / 面板用） |
| `/rp-tools/lore` | GET/POST | 读世界书条目（GET）/ 条目 `add`·`update`·`delete`、`localize`、`renameUnnamed`、`importLegacy`（POST） |
| `/rp-tools/tidy` | POST | 生成「整理设定」指令文本（界面填进输入框，不自动发送） |
| `/rp-tools/gate` | GET | 入口判据：这个会话是不是 DM、有没有真的开局 |
| `/rp-tools/cards` | GET | 列卡库（服务端搜索 / 分类 / 分页） |
| `/rp-tools/card` | GET | 解析单张卡 → 摘要与预览（不落盘） |
| `/rp-tools/card-import` | POST | 导入到某个会话（写世界书 / 卡产物 / 会话配置，返回开场指令） |
| `/rp-tools/card-image` | GET | 卡面图（只服务卡库内的 `.png`，支持缩略图） |
| `/rp-tools/export` | GET | 下载会话包（STORE-only zip） |
| `/rp-tools/snapshots` | GET | 列恢复点 |
| `/rp-tools/snapshot` | POST | 拍一个恢复点并修剪到最近 5 个 |
| `/rp-tools/import` | POST | 导入会话包（默认不覆盖，覆盖前自动拍快照） |

`/rp-tools/card*` 与 `/rp-tools/portrait-image` 的路径都经前缀校验（`resolve` 后比对根目录 +
只认登记过的相对路径 / `.png`），逃逸、绝对路径、非 png 一律 400/403。

---

## 开发

所有改动都在这个 git 仓库里做（它本身就是 `github.com/SiriusWJ/dsh-rp-tools` 的克隆）。
**不要改 profile 里那份安装副本**（`~/.dsh/profiles/web/node_modules/dsh-rp-tools`）—— 它是重装时
会被覆盖的产物，改了既不进版本库，下次安装就没了。

```bash
node --check lib/index.js && node --check client/client.js      # 语法检查
```

profile 里是从 GitHub 装的，所以「本地源码 → GitHub → profile」是一条链：

```powershell
# 1) 提交并推送（profile 装的就是 push 上去的那个 commit）
git add -A
git commit -m "feat(x): …"
git push origin main

# 2) 重装，让 profile 跟上新 commit
dsh plugin --profile web add github:SiriusWJ/dsh-rp-tools

# 3) 改了 dm 预设那一半，还要同步活动预设目录（它不属于这个包，只能手动拷）
$dm = "$env:USERPROFILE\.dsh\.agent-presets\dm"
Copy-Item preset\agent.cordis.yml      "$dm\agent.cordis.yml" -Force
Copy-Item preset\session-filter-v2.mjs "$dm\session-filter-v2.mjs" -Force
Copy-Item preset\rp-bridge.mjs         "$dm\rp-bridge.mjs" -Force
Copy-Item preset\preset.yml            "$dm\preset.yml" -Force
```

重启 `dsh web` 后生效（`lib/` 与 `preset/` 启动时装载；`client/` 只需刷新页面）。
只改了文档时第 2 步可以跳过。仓库 tarball 必须保持小（`github:` 安装会整包下载）。

测试（每个套件都是自带桩的独立脚本，不需要真 ComfyUI，除探针外都不碰真实数据）：

```bash
node tools/smoke-dm.mjs        # 宿主：作用域隔离 / 路由 / 世界书 / 状态 / 风格库 / 卡库导入 / 地图 / 会话包
node tools/smoke-card.mjs      # PNG 卡解码 + 映射 + 开场指令 / 引导文件
node tools/smoke-client.mjs    # 客户端 bundle：样式注入 / 槽位注册 / 面板渲染
node tools/verify-roundtrip.mjs <card-import.js>   # 导入↔解析往返（需 profile 里那份）
node tools/verify-injection.mjs                    # 读会话日志统计每轮注入（只读）
node tools/probe-cardlib.mjs   # 真卡库探针（只读 + 临时目录，手动跑）
```

当前开发状态、验证记录与路线图见 **[docs/STATUS.md](docs/STATUS.md)**，
给新会话的交接文档见 **[docs/HANDOFF.md](docs/HANDOFF.md)**。

## License

MIT
