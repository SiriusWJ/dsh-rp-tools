# dsh-rp-tools

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）用的 **跑团 / DM 工具插件**：
中立随机裁决（`rp_random`）+ 本地 ComfyUI 配图（场景、NPC 立绘、道具线索、氛围图）+
按会话隔离的战役配置（世界设定 / 角色卡 / 随机表 / 风格偏好）+ 世界书与状态追踪 +
PNG 故事书（SillyTavern 角色卡）导入 —— 选一张卡就能开团。

配图直连本机 ComfyUI（`POST /prompt` + 轮询 `/history`），不使用 dsh-comfyui 的工作流库，两者可各自独立使用。

---

## 特性

| | |
|---|---|
| 🎲 **中立随机** | `rp_random`：骰子表达式（`2d6+3` / `d20` / `3d8+1d4-2`）、区间、加权抽取、布尔翻转；`seed` 可复现，`count` 可批量，每掷给可核对的逐颗明细，骰式必须整串合法 |
| 🖼 **本地生图** | `rp_illustrate` 直连本机 ComfyUI：Krea-2 Turbo（8 步 / CFG 1）+ Qwen3-VL 文本编码 |
| 🎨 **10 种风格** | `manga`（黑白漫画，默认，无 LoRA）+ 9 个官方 Krea-2 风格 LoRA；每个风格 = 一套生图工作流，含触发词 / CFG / 步数 / 尺寸预设 |
| 🧑 **角色卡** | `rp_character`：登记「名字 + 外观」，之后任何画面描述里提到该名字就自动补外观，并可直接出立绘 |
| 📖 **PNG 故事书导入** | 工作区那一行的「📖 导入 PNG 故事书」：从本地卡库选一张 SillyTavern PNG 角色卡 → 世界书 / 卡全文 / 卡面落进会话工作区、角色与世界观写进会话配置、自动切 `dm` 预设并把开场指令发给 DM |
| 📚 **世界书** | 会话工作区的 `rp-worldbook.md`：`##` 分条，支持 `keys` / `constant` / `order` / `prob`；命中的条目才进上下文 |
| 📌 **状态追踪** | `rp_state`：场景 / 时间 / 地点 / 在场 / 线索 + 队伍（状态·持有·伤病·目标）+ 自由旗标；空串即清除 |
| 🌍 **会话隔离** | 世界设定 / 角色卡 / 随机表 / 提示词前缀 / 会话默认风格按会话独立；真正全局的只有风格库、ComfyUI 地址、全局负面词、全局默认风格、卡库目录 |
| 🎬 **整幕批量** | `rp_scenes`：吃 `scenes[].panels[]` 结构（含每格 positive/seed/宽高），一次出一整幕，单格失败不中断 |
| 🎲 **随机表** | `rp_table`：遭遇表 / 掉落表 / 情绪表…… 定义（表名 + 骰式 + 条目）、掷表、`count` / `seed`；面板上也能掷 |
| 🖥 **三处界面** | 设置页「RP工具」（全局配置 + 风格库 + 工具清单）；DM 会话头部的「🎲 RP」按钮（右侧栏面板：世界 / 角色卡 / 随机表 / 本会话生图配置）；工作区那一行的「📖 导入 PNG 故事书」 |
| 🔒 **只进 DM 会话** | RP 工具只在 `dm` 预设作用域注册，其它预设的会话既看不到工具、也没有任何 RP 界面 |

---

## 安装

```bash
dsh plugin --profile web add github:SiriusWJ/dsh-rp-tools
```

安装或改动后**必须重启 `dsh web`**（宿主代码与客户端 bundle 都只在启动时装载）。

### 前提：本机 ComfyUI（Comfy Desktop 亦可）

模型放在 ComfyUI 的模型目录（`models/`）：

```
models/diffusion_models/krea2_turbo_fp8_scaled.safetensors     ← 生图主模型（12.2GB）
models/text_encoders/qwen3vl_4b_fp8_scaled.safetensors         ← 文本编码（4.9GB）
models/vae/qwen_image_vae.safetensors                          ← VAE（0.24GB）
models/loras/krea2_*.safetensors                               ← 9 个风格 LoRA（各约 448MB，可选）
```

来源：<https://huggingface.co/Comfy-Org/Krea-2>（国内可用 <https://hf-mirror.com/Comfy-Org/Krea-2>）。
`manga` 风格不使用 LoRA。ComfyUI 地址默认 `http://127.0.0.1:8188`，可在设置页改。

---

## 工具

11 个工具，全部以 `rp_` 开头，全部只在 `dm` 预设作用域注册；设置页「RP工具 → 工具列表」展示同款清单。

| 工具 | 作用 | 主要参数 |
|---|---|---|
| `rp_random` | 中立随机裁决（骰子 / 区间 / 抽取 / 布尔） | `kind?` `dice?` `choices?` `weights?` `min?` `max?` `count?` `seed?` |
| `rp_styles` | 列出风格（触发词 / CFG / 步数 / 尺寸预设） | — |
| `rp_illustrate` | 按风格生成一张图（并自动存进资源库） | `prompt`* `style?` `seed?` `aspect?` `width?` `height?` `label?` `tags?` `kind?` |
| `rp_assets` | 浏览资源库（找回来复用，不必重出） | `action?` `kind?` `characters?` `tags?` `q?` `limit?` `id?` `label?` |
| `rp_character` | 角色卡增删查 + 出立绘 | `action`* `name?` `appearance?` `portrait?` `style?` |
| `rp_state` | 状态追踪（场景 / 时间 / 地点 / 在场 / 线索 + 队伍 + 旗标） | `action`* `field?` `value?` `party?` `party_mode?` `party_remove?` `flags?` |
| `rp_lore` | 世界书按条读取 / 生成模板 | `action`* `query?` `limit?` |
| `rp_session` | 本会话设置（世界 / 前缀 / 会话默认风格 / 风格备注 / 战役名） | `action`* `world?` `prompt_prefix?` `default_style?` `style_notes?` `campaign_name?` |
| `rp_scenes` | 按场景文件逐格批量出图（整幕共享一个组存进资源库） | `scenesFile`* `sceneId?` `style?` `limit?` `label?` `tags?` |
| `rp_config` | **全局**配置（负面词 / 全局默认风格 / ComfyUI 地址 / 单个风格的触发词·步数·CFG） | `action`* `negative?` `default_style?` `base_url?` `style_key?` `trigger?` `steps?` `cfg?` |
| `rp_table` | 随机表定义与掷表 | `action`* `name?` `dice?` `entries?` `count?` `seed?` |

\* ＝ 必填。

---

## PNG 故事书导入

界面入口在**工作区那一行**（输入框上方，只在空白会话或 DM 会话出现）。点开 → 在本地卡库里搜卡 →
预览（世界书条数 / 开场白来源 / 世界与性格摘要）→「导入并开始」。

导入做的事：

1. 卡里的 `character_book` → **追加合并**进会话工作区的 `rp-worldbook.md`（按标题去重，不覆盖手写条目；
   条目名优先用卡给的，卡没给名字时依次用正文第一个标题 → 触发词 → 正文首行）；
2. 卡全文 → `<工作区>/rp-sessions/<会话 id>/cards/<slug>.md`；
3. 卡面 → `<工作区>/rp-sessions/<会话 id>/cards/<slug>.png`，登记成会话封面；
4. 角色卡 / 世界设定 / 战役名 → 会话配置（`creator_notes` 里的广告、社群号、CC 协议逐行剔掉）；
5. 开局引导 → `<工作区>/rp-sessions/<会话 id>/cards/<slug>.launch.md`（选定开场 + 文件清单 +
   已写入什么 + 待人工确认），并切成 `dm` 预设、只把这个路径发给 DM。

> 导入之后要收尾的事全在 `launch.md` 里：角色字段归位、世界书过滤（状态/历史类改成触发式、
> 删空壳、补触发词、`constant` 只留 1–3 条）、按当前语言收拾标题与属性。整本一起收拾用
> `rp_lore(action:"localize")` / `rp_lore(action:"rename_unnamed")`，一次调用做完。

卡库位置在**设置页 → RP工具 → 卡库目录**（默认是会话工作区下的 `rp-cards`）。
目录结构是 `cards/<分类>/*.png`；没有私有索引文件时退回按文件名扫目录，功能一样可用。

### 注入分层

| 通道 | 放什么 |
|---|---|
| **system standing**（每轮都在、字节稳定） | 通用 DM 规则、`session.dm.prompt`、战役名、世界设定、紧凑人物索引、路径指针、生图策略、预算内的常驻世界书 |
| **runtime context**（每轮重新装配） | 当前状态、在场人物的详细卡、命中触发词的世界书条目、导入来的条目（含原卡标了 `constant` 的） |
| **文件（按需 read）** | 卡全文、全部备用开场白、被预算挡下的条目、导入映射 |

导入来的条目按触发词走 runtime，不因 `constant` 自动进系统提示；system standing 里的常驻世界书有
6000 字预算，超出的**降级为按需**而不是截断。同一人物若既在世界书里、又作为人物卡在本轮展开，
装配时会跳过世界书那份。

### 出图：默认尺寸与立绘复用

出图默认尺寸（设置页「图像」可改）：场景 **768×432**、立绘 **512×768**、道具 **512×512**。
老配置里没动过的那一档会跟着换成新值，自己改过的保持原样。

`rp_illustrate` 不传 `width`/`height`/`aspect` 时，画面里只提到一个已登记角色就按纵向立绘出，
否则按场景横幅。DM 出的第一张单人图会**自动记成该角色的立绘**（已有立绘时不覆盖）。

常驻段的【本会话设定】里有一行「已有可用图」（生成立绘、玩家导入的图、导入卡的卡面），
DM 直接展示即可，不必重出。角色卡编辑器里可以：**生成立绘 / 重新生成**、**导入图片**
（png / jpeg / webp，≤8MB，存进 `<工作区>/rp-sessions/<会话 id>/portraits/`）、删除角色。

### 资源库

出图后插件会把图**真存一份**进会话目录，并按分类分文件夹：

```
<工作区>/rp-sessions/<会话 id>/
├── assets.json                    索引：一张图一条（id / 分类 / 标签 / 角色 / 尺寸 / 风格 / 提示词 / 时间）
└── assets/
    ├── portraits/<id>.png         角色
    ├── scenes/<id>.png            场景
    ├── items/<id>.png             道具
    └── other/<id>.png             其他
```

入库的四个入口：`rp_illustrate` 出图、`rp_scenes` 每格（整幕共享一个 `group`）、
`rp_character(portrait:true)`、面板「导入图片」；导入卡的卡面不入库。入库前按 `sha256` 去重，
同分类同字节复用已有那条（合并标签，不写第二份文件），查重放在写锁内。
`rp_illustrate` 与 `rp_scenes` 声明为并发安全，需要多张时 DM 会在同一步里并发发出多个调用。

`rp_scenes` 的场景文件**字段名固定**：幕的 id 是 `scene_id`、分镜是 `panel_id`
（`sceneId` 参数筛的就是它，也兼容 `id`/`title`）；筛不到会直接报错并列出文件里实际有哪些 id。

**DM 侧**用 `rp_assets` 按 `kind` / `characters` / `tags` / `q` 查，每行都带能直接放进 `dsh-ui`
image 组件的地址；常驻段里只报条数。**DM 不能删图**，删除是玩家在面板里做的事。
**玩家侧**「资源」卡片：分类筛选 + 搜索 + 图墙（服务端降采样缩略图）+ 点开看原图，
可改名称/标签、显示到对话、设为某角色的立绘、删除（连磁盘文件一起删并解除引用）。
资源库索引是 read-modify-write，所有写索引的路径都过一把按会话串行的写队列。

---

## 备份 / 会话包

会话配置在全局数据目录、世界书与资源图在工作区，手工备份必漏一半，所以插件把它们打成一个 zip：

```
MANIFEST.json          格式与版本 / 导出时间 / 原会话 id / 每个文件的 sha256
session.json           会话配置
rp-worldbook.md        世界书（可能没有）
assets.json            资源库索引
assets/<分类>/<id>.<ext>   出过的图与导入的图
cards/<slug>.{md,json,launch.md,png}   导入卡产物（含卡面与开局引导）
rp-map.json / rp-map-state.json        地图（可选）
```

- **导出**：面板「备份 / 会话包 → 导出会话包」是一个 `<a download>`，浏览器自己存盘。
- **快照**：同一个卡片里的「拍快照」把包写进 `<工作区>/rp-sessions/<id>/snapshots/`，只保留最近 5 个
  （只管自己写的 `snapshot-*.zip`，你放进该目录的别的包不会被当成快照、也不会被删）。
- **导入**：选一个 zip。**默认不覆盖** —— 目标会话已有内容时宿主回 409，界面问一句，确认后才带
  `overwrite:true` 重来，且覆盖前会自动拍一个快照兜底。
- 包是 **STORE（不压缩）** 的 zip；用别的工具重新打包会默认压缩 → 导入会明确报「只支持 STORE 包」。

解包是外部输入：条目名逐段判定 `..`／绝对路径／盘符，落盘时再做一次目标路径前缀校验，
清单里的 sha256 也逐个核对。

---

## 轻量地图（可选）

只在模组本身有地点结构时才用（地牢、宅邸、城镇）；没有地图就正常叙事，不给每个场景造图。

```
<工作区>/rp-sessions/<会话 id>/
├── rp-map.json         静态结构：nodes（id/label/public）+ edges（id/a/b/label/state）
└── rp-map-state.json   运行时：node 当前节点 / revealed 已揭示 / edges 变化的边 / tokens 标记位置
```

不加 `rp_map` 工具，两个文件都由 DM 用通用的 read/write 读写。插件只做两件事：

1. **每轮注入一行摘要**（跟在「本场当前状态」之后）：
   `【地图】旧钟旅店·大堂｜已揭示 4/5｜可走：厨房（木门）、二楼客房（楼梯）｜队伍@大堂、老板@大堂`
2. **结构出问题时把话说明白**（而不是静默或渲染垃圾）：
   `【地图】⚠ node="nope" 不是 rp-map.json 里的节点`。文件坏了不当成「还没建」，坏数据不渲染摘要。

两个地图文件都计入会话包（导出/快照会带上）。DM 侧的约定（何时建图、怎么画、按钮只从当前节点的
邻接边生成、action 命名 `<地图id>:move:<节点id>`）写在 dm 预设的「## 地图」小节里。

---

## 数据与配置

```
~/.dsh/data/dsh-rp-tools/
├── styles.json                 全局：风格库 + 全局负面词 + ComfyUI 地址 + 全局默认风格 + 卡库目录
├── sessions/<sessionId>.json   会话级：世界设定 / 角色卡 / 随机表 / 前缀 / 会话默认风格 / 状态 / 立绘登记
└── dm-sessions.json            DM 会话登记表（界面据此决定是否显示 RP 入口）

<会话工作区>/
├── rp-worldbook.md             世界书（可手写；导入的故事书条目也追加在这里）
└── rp-sessions/<会话 id>/
    ├── cards/<slug>.{md,json,png,launch.md}   导入产物：卡全文 / 规范化结果 / 卡面 / 开局引导
    ├── assets.json + assets/<分类>/<id>.<ext> 资源库
    ├── rp-map.json + rp-map-state.json        地图（可选）
    └── snapshots/snapshot-<时间>.zip          恢复点（只保留最近 5 个）
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

> Krea-2 Turbo 建议 CFG=1，此时负向条件在数学上不参与计算。想让全局负面词生效，
> 把对应风格的 `cfg` 调到 `1.5~2.5`（过高会让 turbo 模型过曝/崩坏）。

---

## DM 预设接线（关键，否则工具不出现）

RP 工具**只在 `dm` 预设作用域注册**，需要在预设目录做两件事：

**1. 放行工具**（`~/.dsh/.agent-presets/dm/agent.cordis.yml`）—— 该预设默认 deny 掉所有全局工具：

```yaml
- id: dm-filter
  name: ./session-filter.mjs
  config:
    keepGlobalTools:
      - render_ui
      - validate_dsh_ui
      - web_search
```

全部 `rp_*` 工具都在本预设作用域注册（由 `rp-bridge.mjs` 调用 `registerRpTools`），
所以白名单只用于保留少数几个全局工具，不需要放行任何 `rp_*`。

**2. 挂桥接插件**（把 RP 工具注册进本会话 + 登记 DM 会话）：

```yaml
- id: rp-bridge
  name: ./rp-bridge.mjs
```

副本见本仓库 [`preset/rp-bridge.mjs`](preset/rp-bridge.mjs)。

---

## 架构

```
dsh-rp-tools/
├── lib/index.js        宿主半侧（ESM）
│   ├── apply(ctx)              全局：不注册任何模型工具，只挂 HTTP 路由 + 监听 session/created
│   ├── registerRpTools(ctx)    dm 作用域（由 rp-bridge 调用）：全部 rp_ 工具 + 两条提示词注入通道
│   ├── 生图链路                 组装 API 工作流 → ComfyUI POST /prompt → 轮询 /history → 同源媒体 URL
│   └── 配置层                  styles.json（全局） / sessions/<id>.json（会话）
├── lib/card-png.js     PNG 角色卡解码（tEXt / iTXt / zTXt，ccv3 优先）
├── lib/card-import.js  卡 → 会话配置的映射
├── lib/rp-map.js       地图结构校验与摘要渲染
├── lib/zip.js          会话包（STORE zip + crc32 + sha256）
├── client/client.js    客户端半侧（plain JS + React.createElement，无构建）
├── preset/             dm 预设桥接与过滤插件（副本，供安装参考）
├── cordis.patch.yml    bundle 补丁层
└── docs/               交接文档（HANDOFF）/ 状态（STATUS）/ 卡格式实测（PNG-CARD-DECODE）
```

界面挂载三处：`settings.section`「RP工具」；`conversation.session.header.utilities` —— 仅 DM 会话渲染的
「🎲 RP」按钮，右侧栏标签类型随它挂载/注销（引用计数）；`conversation.input.dock` —— 空白会话 /
DM 会话里的「📖 导入 PNG 故事书」。

**HTTP 路由**（POST 全部同源保护，`Origin` 必须等于 `Host`）：

| 路由 | 方法 | 用途 |
|---|---|---|
| `/rp-tools/state` | GET | 全局配置 + 风格摘要（同时学习浏览器 origin） |
| `/rp-tools/config` | POST | 写全局配置 |
| `/rp-tools/reset` | POST | 恢复默认全局配置 |
| `/rp-tools/check` | GET | ComfyUI 连通性（版本 / GPU / 显存） |
| `/rp-tools/inject` | GET | 注入自检：某个会话会被注入什么（只读） |
| `/rp-tools/loras` | GET | 本地 LoRA 清单（读 ComfyUI `/object_info`） |
| `/rp-tools/session` | GET/POST | 读写某个会话的 RP 配置 |
| `/rp-tools/dm-mark` | POST | 登记某会话为 DM 会话 |
| `/rp-tools/tools` | GET | 工具清单 + 参数说明 |
| `/rp-tools/roll` | POST | 掷随机表（面板用） |
| `/rp-tools/media` | GET | 同源媒体代理：把 ComfyUI `/view` 转成同源 |
| `/rp-tools/portrait` | POST | 登记/清除某个角色的立绘 |
| `/rp-tools/portrait-upload` | POST | 导入外部立绘 |
| `/rp-tools/portrait-image` | GET | 把登记过的导入立绘发回浏览器 |
| `/rp-tools/assets` | GET/POST | 资源库：列出 / 改名称与标签 / 删除 / 设为立绘 |
| `/rp-tools/asset-upload` | POST | 导入外部图进资源库（png/jpeg/webp，≤8MB） |
| `/rp-tools/asset-image` | GET | 发资源图（`thumb=1&width=N` 走服务端降采样） |
| `/rp-tools/export` | GET | 下载会话包（STORE-only zip） |
| `/rp-tools/snapshots` | GET | 列恢复点 |
| `/rp-tools/snapshot` | POST | 拍一个恢复点并修剪到最近 5 个 |
| `/rp-tools/import` | POST | 导入会话包，默认不覆盖 |
| `/rp-tools/preview` | POST | 试出一张 |
| `/rp-tools/cards` | GET | 列卡库（服务端搜索 / 分类 / 分页） |
| `/rp-tools/card` | GET | 解析单张卡 → 摘要与预览（不落盘） |
| `/rp-tools/card-import` | POST | 导入到某个会话（返回开场指令） |
| `/rp-tools/card-image` | GET | 卡面图（只服务卡库内的 `.png`） |

`/rp-tools/card*` 与 `/rp-tools/portrait-image` 的路径都经 `safeCardPath()` 前缀校验，
逃逸 / 绝对路径 / 非 png 一律 400。

---

## 开发

所有改动都在这个 git 仓库里做（它本身就是 `github.com/SiriusWJ/dsh-rp-tools` 的克隆）。
**不要改 profile 里那份安装副本**（`~/.dsh/profiles/web/node_modules/dsh-rp-tools`）—— 它是重装时会被
覆盖的产物，改了既不进版本库，下次安装就没了。

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

# 3) 改的是 dm 预设那一半，还要同步活动预设目录（它不属于这个包，只能手动拷）
Copy-Item preset\agent.cordis.yml      "$env:USERPROFILE\.dsh\.agent-presets\dm\agent.cordis.yml" -Force
Copy-Item preset\session-filter-v2.mjs "$env:USERPROFILE\.dsh\.agent-presets\dm\session-filter-v2.mjs" -Force
Copy-Item preset\rp-bridge.mjs         "$env:USERPROFILE\.dsh\.agent-presets\dm\rp-bridge.mjs" -Force
```

重启 `dsh web` 后生效（`lib/` 与 `preset/` 启动时装载；`client/` 只需刷新页面）。
只改了文档时第 2 步可以跳过。仓库 tarball 必须保持小（`github:` 安装会整包下载）。

测试：

```bash
node tools/smoke-dm.mjs        # 宿主：作用域隔离 / 路由 / 世界书 / 状态 / 风格库 / 卡库导入
node tools/smoke-card.mjs      # PNG 卡解码 + 映射 + 开场指令 / 引导文件
node tools/smoke-client.mjs    # 客户端 bundle：样式注入 / 槽位注册 / 面板渲染
node tools/verify-roundtrip.mjs <card-import.js>   # 导入↔解析往返（需 profile 里那份）
node tools/probe-cardlib.mjs   # 真卡库探针（只读 + 临时目录，手动跑）
```

当前开发状态、验证记录与路线图见 **[docs/STATUS.md](docs/STATUS.md)**，
给新会话的交接文档见 **[docs/HANDOFF.md](docs/HANDOFF.md)**。

## License

MIT
