# dsh-rp-tools

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）用的 **跑团 / DM 工具插件**：
中立随机裁决（`rp_random`）+ 按会话隔离的图片资源库（场景 / NPC 立绘 / 道具线索 / 氛围图的**入库与复用**，
角色立绘槽位可以直接导入玩家自备的图）+ 按会话隔离的战役配置（世界设定 / 角色卡 / 随机表 / 宏表 / 提示词前缀）+
世界书与状态追踪 + PNG 故事书（SillyTavern 角色卡）导入 —— 选一张卡就能开团。

**出图由宿主的生图工具负责**（`generate_image` / `edit_image`，来自宿主自带的 `dsh-image-gen` 插件）。
本插件不做配图，只做**图片的入库与复用**：把已经存在的图（宿主刚出的图、玩家自备的图）用
`rp_assets(action:"import", path:"<generate_image 返回的 savedTo>", label:"…", tags:"…")` 收进本会话资源库，
之后按 label / tags 找回来重放，同一张图永远长得一样。

---

## 依赖

| 依赖 | 必需性 | 说明 |
|---|---|---|
| **`@changfenhuang/dsh-genui`**（GenUI） | **必需** | 提供 `render_ui` / `validate_dsh_ui` 两个全局工具、`genui:fence` 提示词章节，以及浏览器端的 `dsh-ui` 围栏渲染器。dm 预设的过滤器**专门保留**这两个工具与这个章节，persona 也要求 DM「一律用 GenUI 组件画卡片」，面板的「显示到对话」同样只是往输入框填一段 `dsh-ui` 围栏。**没装它：`rp_*` 工具仍能调用，但 DM 画不出任何卡片/地图/状态面板，「显示到对话」也只能得到一段渲染不了的围栏。** |
| 生图（`generate_image` / `edit_image`） | **不需要**（宿主自带） | 来自宿主的 `dsh-image-gen` 插件；本插件不做配图，只负责把出好的图收进资源库 |

安装（两个都要装；装完**必须重启 `dsh web`**，宿主代码与客户端 bundle 只在启动时装载）：

```bash
dsh plugin --profile web add @changfenhuang/dsh-genui
dsh plugin --profile web add github:SiriusWJ/dsh-rp-tools
```

### 出图前提：无需准备

出图由宿主自带的 `generate_image` / `edit_image` 负责，模型与工作流都是宿主的配置。
**本插件不依赖 ComfyUI，也没有任何模型文件要求**，插件侧零运行时依赖。

---

## 特性

| | |
|---|---|
| 🎲 **中立随机** | `rp_random`：骰子表达式（`2d6+3` / `d20` / `3d8+1d4-2`）、区间、加权抽取、布尔翻转；`seed` 可复现，`count` 可批量（1..20），每掷给可核对的逐颗明细，骰式必须整串合法（`2dd6`、`2d6++3` 一律拒绝） |
| 🖼 **图片资源库** | `rp_assets`：列出（按分类 / 角色 / 标签 / 关键词）/ 看单张 / 补标签 / **`import` 把已经存在的图收进库**（宿主 `generate_image` 出的图、玩家自备的图）；角色立绘槽位可导入玩家给的图片，按 `sha256` 去重、跨回合复用 |
| 🧑 **角色卡** | `rp_character`：`name` / `appearance` / `personality` / `speech` / `behavior` / `first_mes` / `mes_example` / `relations`；**不再出立绘**，`appearance` 留着给 DM 写画面描述（出图时带上它长相才一致） |
| 📖 **PNG 故事书导入** | 从本地卡库选一张 SillyTavern PNG 角色卡 → 世界书 / 卡全文 / 全部开场白 / 卡面落进会话工作区，角色与世界观写进会话配置，自动切 `dm` 预设并把开场指令发给 DM |
| 📚 **世界书** | 会话工作区的 `rp-worldbook.md`：`##` 分条，支持 `keys` / `constant` / `order` / `prob`；命中的条目才进上下文 |
| 📌 **状态追踪** | `rp_state`：场景 / 时间 / 地点 / 在场 / 线索 + 队伍（状态·能力·持有·伤病·目标）+ 自由旗标；队伍默认**局部更新**，空串即清除 |
| 🌍 **会话隔离** | 世界设定 / 角色卡 / 随机表 / 宏表 / 提示词前缀按会话独立；全局的只有卡库目录、默认宏列表 |
| 🎲 **随机表** | `rp_table`：定义（表名 + 骰式 + 条目）、掷表、`count` / `seed`；面板上也能掷 |
| 🔒 **只进 DM 会话** | 全局半侧**不注册任何模型工具**，`rp_*` 全部由 dm 预设的桥接插件在本作用域注册；其它预设的会话既看不到工具，也没有任何 RP 界面 |

---

## 工具

8 个工具，全部以 `rp_` 开头，**只在 `dm` 预设作用域注册**。设置页「RP工具 → 工具」会实时展示同一份清单。

| 工具 | 作用 | 参数 |
|---|---|---|
| `rp_random` | 中立随机裁决 | `kind?`（integer/float/choice/dice/bool）`dice?` `choices?` `weights?` `min?` `max?` `count?`（1..20）`seed?` |
| `rp_character` | 角色卡增删改查（**不出立绘**；`appearance` 保留下来，供 DM 写进画面描述） | `action`*（list/set/remove/clear）`name?` `appearance?` `personality?` `speech?` `behavior?` `first_mes?` `mes_example?` `relations?` |
| `rp_state` | 状态追踪 | `action?`（set/get）`scene?` `time?` `location?` `present?` `clues?` `party?` `party_mode?`（merge/replace）`party_remove?` `flags?` |
| `rp_lore` | 世界书取条目 / 生成模板 / 整本收拾 | `action?`（find/list/template/localize/rename_unnamed）`query?` `limit?`（默认 3，上限 10） |
| `rp_session` | 本会话设置 | `action`*（get/set/clear）`world?` `prompt_prefix?` `campaign_name?` `macro_name?`+`macro_value?` `dm_prompt?` |
| `rp_assets` | 本会话图片资源库：查 / 标注 / **导入** | `action?`（list/get/tag/**import**）`kind?` `characters?` `tags?` `q?` `limit?`（默认 20，上限 200）`id?` `label?` `path?` `attachment_id?` `prompt?` |
| `rp_config` | **全局**卡库配置（卡库目录 + 默认宏列表）+ DM 放行的第三方工具名单 | `action`*（`get`/`set`/`set_global_tools`）`cards_root?` `macro_name?` `macro_value?` `global_tools?` |
| `rp_table` | 随机表定义与掷表 | `action`*（list/set/remove/roll）`name?` `dice?` `entries?` `count?` `seed?` |

\* ＝ 必填。`rp_assets(action:"import")` 就是**新图入馆的唯一入口**：`path` 填宿主 `generate_image` 返回的
`savedTo`（也接受工作区相对路径或裸文件名），只拿到附件 id 时改用 `attachment_id`；`label` / `tags` 一定要填，
否则以后搜不到。这个工具**不能删图**，删除是玩家在面板里做的事。

---

## 界面

**设置页「RP工具」**，三部分：

- **设定**（文字与卡库）：卡库目录（留空 = 会话工作区下的 `rp-cards`）、默认宏列表（键值对，名字可改），
  外加「哪些宏是自动的」提示（时间 / 日期及其分量）
- **第三方工具管理**：DM 能看见哪些**非本插件**的全局工具（一行一个插件、全部可勾选、
  按工具出厂默认勾选、已勾选的排前面、生图插件带 🖼 标识）—— 详见下文「第三方工具管理」
- **诊断**：配置文件路径 + 本插件注册了多少个 `rp_*` 工具
  （原来这里列 8 个 `rp_*` 与参数说明的清单面板已按要求隐藏）

原来的「图像」那一整节（生图地址 / 风格 / 尺寸 / 预览）已随本地生图功能一起移除。

**RP 面板**：DM 会话头部右上角的「🎲 RP」按钮 → 右侧栏页签（非 DM 会话这个按钮与页签类型都不注册）。
面板卡片：DM 设定、世界设定（含封面）、宏 / 变量、世界书、角色卡、**资源库**（没有图时整张卡片不渲染）、
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
| **system standing**（每轮都在、字节稳定） | 通用 DM 规则、`session.dm.prompt`、战役名、世界设定、紧凑人物索引、路径指针、配图指路（要新图用宿主的 `generate_image`）、已有可用图（玩家导入的立绘 / 卡面）、库内张数摘要、预算内的常驻世界书 |
| **runtime context**（每轮重新装配） | 当前状态、地图摘要、在场人物的详细卡、命中触发词的世界书条目、导入来的条目 |
| **文件（按需 read）** | 卡全文、全部开场白、被预算挡下的条目 |

导入来的条目按触发词走 runtime，不因 `constant` 自动进系统提示；system standing 里的常驻世界书有
**6000 字预算**，超出的降级为按需而不是截断。同一人物既在世界书里、又作为人物卡在本轮展开时，
装配会跳过世界书那份。

---

## 配图与资源库

**插件不出图**：需要新图时用宿主的 `generate_image`（改图用 `edit_image`）。画面描述里带上角色卡的
`appearance`，同一个角色跨场景的长相才稳。想让这张图以后还能原样复用，就用
`rp_assets(action:"import", path:"<savedTo>", label:"…", tags:"…")` 收进资源库。

**显示方式有一处关键区别**（照着做错会让玩家看不到图）：

| 图的来源 | 怎么让玩家看到 |
| --- | --- |
| **刚 `generate_image` 出来的图** | **什么都不用做** —— 工具结果自带 image 内容块，图会**自动作为附件挂在对话里**。不要在正文里贴 URL，也别自己拼图片地址（模型拿不到可用的 `src`） |
| **从资源库重放的图**（`rp_assets` 查出来的） | 用 `dsh-ui` 的 `image` 组件，`src` **原样粘** `rp_assets` 返回的那行地址（同源相对路径，浏览器直接能取） |

GenUI 的 `image` 只认 `src` 字符串、不认附件 id，所以「重放」那条路必须走资源库地址 —— 这也是
「先查库里有没有，有就重放」除了省钱之外的第二层意义。

常驻段的【本会话设定】里有一行「配图指路」，紧跟一行「已有可用图」（玩家导入的立绘、导入卡的卡面）——
DM 直接把地址放进 `dsh-ui` 的 image 组件重放即可，不必重出。角色卡编辑器里可以**导入图片**
（png / jpeg / webp，≤8MB，落进 `<工作区>/rp-sessions/<会话 id>/assets/portraits/`）/ 移除立绘 / 删除角色。

### 第三方工具管理（DM 能看见哪些非本插件的工具）

dm 预设里的 `dm-filter`（`preset/session-filter-v2.mjs`）会把**所有全局工具** deny 掉，
只放行名单里的。生图、GenUI 卡片、联网搜索这些都是**全局**工具 ——
**不在名单里 = DM 根本看不到它**，persona 里「用 `generate_image` 配图」就成了一句空话。

**名单在哪配：插件设置页「第三方工具管理」**（不用改预设文件）。**一行一个插件**
（按来源插件聚合，见下），一个勾选框管该插件的全部工具：全部可勾选、**出厂默认按工具勾选**
（默认那 5 个工具所属的插件就是勾上的）、已勾选的排在最前面；行下方用一行小字列出
它带的工具名，图片/生图插件带 🖼 标识。

| 出厂默认勾选 | 关掉的后果 |
| --- | --- |
| `render_ui` / `validate_dsh_ui` | DM 出的卡片不再渲染 / 围栏不再自检（界面会就此提醒） |
| `web_search` | 开局不能联网考据（不需要联网可以关） |
| `generate_image` / `edit_image` | DM 不能配图 / 不能改图 |

**行是按插件聚合的**：用户装的是插件，不是散装工具名 —— 一个勾选框 = 该插件全部工具一起
放行/取消（勾上 `dsh-image-gen` 就等于放行它的 `generate_image` / `edit_image` /
`canvas_state` / `view_canvas`）。宿主**不提供**「这个工具是哪个插件注册的」
（`tools.register` 只把定义进当前层，层标签是 `tools.register()`），所以插件归属靠一份
映射表（`lib/global-tools-defaults.js` 的 `GLOBAL_TOOL_SOURCES`）；映射表里没有的工具
落进「其它」组，**不按名字前缀乱猜** —— 猜错会让用户以为自己看的是某个插件。
想加一个插件就加一条（正则 + 显示名），界面不需要改。

**没有「固定放行」这一层**：连 `render_ui` 都能取消（那是你自己的机器）。设置页只对
「关掉会失去什么」给一句提示，不锁死。

为什么做成设置而不是写死在预设里：**每个 DSH 装的插件可能不一样**（生图插件尤其，
`dsh-image-gen` 只是其中一种），工具名自然不同；而预设目录在重装插件时会被覆盖 ——
让你为换个插件去手改那份 YAML 是不合理的。

落地链路：

```
设置页勾选 ──POST /rp-tools/global-tools──▶ styles.json 的 globalToolsAllow
                                                     │
                          session-filter-v2.mjs 挂载时读它（读不到/读坏 → 退回出厂默认）
                                                     │
                                          算出要 deny 的全局工具
```

要点与边界：

- **换一个生图插件**：它的工具会落在「其它」组里（或你给它加一条映射），勾上即可；
  列表里没有的工具名也能手填，会标「未注册」，装上对应插件即生效。
- **改完要新开 / 重进 DM 会话才生效** —— 过滤在会话挂载时施加。
- 配置**读不到或读坏**时退回出厂默认（默认那 5 项），免得 DM 因为一份坏配置什么工具都看不见；
  **显式全不勾**才是「一个都不放行」。
- 名字合法性（`[a-z][a-z0-9_]*`）、去重、上限 32 条，都在共享模块
  `lib/global-tools-defaults.js` 里 —— 插件与过滤器**同源**，不会两边走散。
- 这个失败是**静默**的，所以 `preset/rp-bridge.mjs` 还会在挂载时用 `ctx.tools.schemas()` 自查一次
  （读的是**应用了作用域过滤之后**的可见工具集，「读不到 = 真被 deny 了」），缺了就打印一条明确的警告。

> 若本机压根没装生图插件，把那条警告当噪音忽略即可 —— 代价只是 DM 不能配图。

### 资源库

入库时插件会把图**真存一份**进会话目录（不是只记引用），并按分类分文件夹：

```
<工作区>/rp-sessions/<会话 id>/
├── assets.json                    索引：一张图一条（id / 分类 / 标签 / 角色 / 尺寸 / 提示词 / sha256 / 时间）
└── assets/{portraits,scenes,items,other}/<id>.<ext>
```

入库入口只有两条：工具侧 `rp_assets(action:"import", path:…)`（`path` = 宿主生图工具返回的 `savedTo` /
工作区相对路径 / 裸文件名；图没落盘时改用 `attachment_id`），界面侧面板「导入图片」（png / jpeg / webp，≤8MB）。
导入卡的卡面不入库（它作为「已有可用图」直接引用）。**按内容去重**：入库前比对 `sha256`，
同一份字节复用已有那条并补上缺的标签。所有写索引的路径都过一把按会话串行的写队列（并发导入时
read-modify-write 会丢记录）。

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
├── styles.json                 全局：卡库目录 + 默认宏列表（老的风格 / 负面词字段不再读取）
├── sessions/<sessionId>.json   会话级：世界 / 角色卡 / 随机表 / 宏表 / 前缀 / 状态 / 立绘登记 / DM 设定
├── dm-sessions.json            DM 会话登记表（界面据此判断是否显示 RP 入口）
└── _agent-probe.json / _standing-probe.json   诊断快照（注入自检用）

<会话工作区>/
├── rp-worldbook.md             世界书（可手写；导入的故事书条目也追加在这里）
└── rp-sessions/<会话 id>/
    ├── cards/<slug>.{md,opening.md,json,png,launch.md}  导入产物
    ├── assets.json + assets/<分类>/<id>.<ext>           资源库（导入的立绘也在 assets/portraits/ 下）
    ├── rp-map.json + rp-map-state.json                  地图（可选）
    └── snapshots/snapshot-<时间>.zip                    恢复点（最近 5 个）
```

环境变量：`DSH_HOME`（数据目录根）、`DSH_RP_PROFILE_PACKAGE`（dm 预设的桥接用，见下方「DM 预设接线」）。
插件侧只读 `DSH_HOME` 这一个（本地生图相关的 `DSH_RP_COMFY_*` 都没有了）。

`styles.json` 关键字段（现在只剩这两组，其余字段都是老版本遗留、不再读取）：

```jsonc
{
  "cards": {
    "root": "",
    "userLabel": "玩家",
    "macros": { "user": "玩家" },
    "macrosSeeded": true
  },
  // DM 会话放行的**全局**工具（设置页「第三方工具管理」那张表写的就是它）。
  // 这是一份**完整名单**：没列进来的全局工具 DM 都看不见。
  // 缺这个键 = 用出厂默认全勾；显式空数组 = 一个都不放行。
  "globalToolsAllow": ["render_ui", "validate_dsh_ui", "web_search", "generate_image", "edit_image"]
}
```

> 文件里还可能留着老版本的 `styles` / `negative` / `comfyui` / `imageSizes` / `defaultStyle` ——
> 插件已经不读它们，留着不影响运行，也可以直接删掉。

---

## DM 预设接线

`rp_*` 工具与两条提示词注入通道都由 dm 预设的桥接插件注册。预设目录（本机为
`~/.dsh/.agent-presets/dm/`）需要下面四份文件，仓库里都有副本：

| 文件 | 作用 |
|---|---|
| [`preset/agent.cordis.yml`](preset/agent.cordis.yml) | 预设本体：persona、文档工具（`dsh-tool-fs` / `dsh-tool-fs-search` / `dsh-tool-ask-user`）、会话过滤、桥接 |
| [`preset/session-filter-v2.mjs`](preset/session-filter-v2.mjs) | 工具与提示词章节过滤器（名单在挂载时对着**实时**全局注册表算，宿主增删插件都不用同步） |
| [`preset/rp-bridge.mjs`](preset/rp-bridge.mjs) | 桥接插件：调 `registerRpTools(ctx)` 把 8 个工具 + 注入挂到本会话 |
| [`preset/preset.yml`](preset/preset.yml) | 预设的名字与描述（预设选择器里显示的那两行） |

过滤器配置（`agent.cordis.yml` 里 `dm-filter` 那一段的核心字段）：

```yaml
- id: dm-filter
  name: ./session-filter-v2.mjs
  config:
    # ⚠️ **故意没有 keepGlobalTools**：放行哪些全局工具完全由插件设置页的「第三方工具管理」
    # 那张表决定（存在 styles.json 的 globalToolsAllow），session-filter-v2.mjs 挂载时读它。
    # 理由：本机装了哪些插件人人不同（生图插件尤其），写死在预设里用户就得改这份 YAML，
    # 而预设目录在重装插件时会被覆盖；也**没有「固定放行」**——全部工具都可勾选、默认勾选。
    # 手写在这里的名字仍会被并进名单（兼容手改过的人），正常使用不必碰。
    blankPromptSections:        # 遮蔽的全局提示词章节（节选；保留 genui:fence，DM 靠它知道卡片怎么写）
      - ['harness:identity', -100]
      - ['app:web-surface', -98]
      - ['godot-bridge:config-guidance', 150]
      - ['ui:deliverable-file-references', 190]
    suppressRuntimeContext: false   # ⚠️ 不能开 true，开了每轮注入（状态/命中条目/在场角色）会被静默丢光
```

`rp_*` 工具都在本作用域注册，**不需要**在放行名单里放任何 `rp_*`（列表里也不会出现它们）。

> ⚠️ `rp-bridge.mjs` 用 `createRequire()` 从 **profile 的 package.json** 解析已安装的 `dsh-rp-tools`，
> 默认路径写死为 `C:/Users/75373/.dsh/profiles/web/package.json`。换了用户名 / 机器 / profile 目录时
> 必须设 `DSH_RP_PROFILE_PACKAGE=<profile>/package.json`，否则桥接会打印
> 「注册 RP 工具失败」而工具与注入一个都不生效。

---

## 架构

```
dsh-rp-tools/
├── lib/index.js        宿主半侧（ESM, 5.7k 行）
│   ├── 全局 apply(ctx)         不注册任何模型工具：HTTP 路由 + session/created 监听
│   ├── registerRpTools(ctx)    dm 作用域：8 个 rp_ 工具 + system standing / runtime context 两条注入通道
│   ├── 图片入库                 rp_assets import：工作区路径 / 宿主附件 → 校验越界 → 归档 + 索引去重
│   └── 配置层                  styles.json（全局）/ sessions/<id>.json（会话）
├── lib/card-png.js       PNG 角色卡解码（tEXt / iTXt / zTXt，ccv3 优先）
├── lib/card-import.js    卡 → 会话配置 / 世界书条目 / 开场文件 / launch 文件的映射
├── lib/png-thumb.js      纯 node:zlib 的 PNG 降采样（卡面与资源缩略图，零第三方依赖）
├── lib/rp-map.js         地图结构校验 + 每轮摘要渲染
├── lib/session-bundle.js 会话包编目（含 sha256 清单）
├── lib/zip.js / crc32.js STORE-only zip 读写与校验
├── client/client.js      客户端半侧（plain JS + React.createElement，无构建，3.2k 行）
├── preset/               dm 预设的四份文件（副本，供安装参考）
├── cordis.patch.yml      bundle 补丁层
└── docs/                 交接文档（HANDOFF）/ 状态（STATUS）/ 卡格式实测（PNG-CARD-DECODE）/
                          开发计划（DEVELOPMENT-PLAN）/ 参考对照（REFERENCE-COMPARISON）/ 提示词（PROMPT-CONTENT）
```

客户端挂载四类槽位：

| 槽位 | 内容 |
|---|---|
| `settings.section` | 设置页「RP工具」（两部分） |
| `conversation.session.header.utilities` | 「🎲 RP」按钮，**非 DM 会话返回 null** |
| `sidebar.right.pane.tab` | RP 面板本体（标签**类型**是应用级的，因此由上面那个按钮按引用计数注册/注销） |
| `conversation.input.dock` | 工作区那一行的「📖 导入故事书」 |

**HTTP 路由**（25 条；所有 POST 都做同源校验，`Origin` 必须等于 `Host`）：

| 路由 | 方法 | 用途 |
|---|---|---|
| `/rp-tools/state` | GET | 全局配置（`{ ok, file, config, autoMacros }`）+ 自动宏名单（同时学习浏览器 origin） |
| `/rp-tools/config` | POST | 写全局配置（只认 `{ cards, campaign }`：卡库目录 / 默认宏列表） |
| `/rp-tools/global-tools` | GET/POST | 第三方工具管理：GET 列本机全部全局工具 + 当前勾选；POST 写勾选（持久化到 `styles.json`，过滤器读它） |
| `/rp-tools/reset` | POST | 恢复默认全局配置 |
| `/rp-tools/inject` | GET | 注入自检：某个会话会被注入什么（只读） |
| `/rp-tools/session` | GET/POST | 读写某个会话的 RP 配置 |
| `/rp-tools/dm-mark` | POST | 登记某会话为 DM 会话 |
| `/rp-tools/tools` | GET | 工具清单 + 参数说明（设置页用） |
| `/rp-tools/roll` | POST | 掷随机表（面板用） |
| `/rp-tools/portrait` | POST | **只支持 `action:"clear"`**：清掉老版本留下的生图引用（`portraits[name].generated`）；导入立绘走 `asset-upload` |
| `/rp-tools/asset-upload` | POST | 导入外部图进资源库（png / jpeg / webp，≤8MB）；`kind=portrait` + `name` 时顺带登记成该角色的立绘 |
| `/rp-tools/portrait-upload` | POST | 上面的别名（`kind` 默认 `portrait`，需角色名） |
| `/rp-tools/portrait-image` | GET | 把**登记过**的导入立绘发回浏览器 |
| `/rp-tools/assets` | GET/POST | 资源库：列出 / 改名称与标签 / 删除 / 设为某角色立绘 |
| `/rp-tools/asset-image` | GET | 发资源图（`thumb=1&width=N` 走服务端降采样） |
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

> `node --check` 只查语法、不需要依赖；但 **`node -e "import('./lib/index.js')"` 之类的真加载**要先让
> `@deepseek-ai/dsh-tools` 能被解析到（ESM 只认模块所在目录往上找 `node_modules`）。没装进 profile 时
> 会报 `ERR_MODULE_NOT_FOUND` —— 详见下面测试一节的前提说明。

profile 里是从 GitHub 装的，所以「本地源码 → GitHub → profile」是一条链：

```powershell
# 1) 提交并推送（profile 装的就是 push 上去的那个 commit）
git add -A
git commit -m "feat(x): …"
git push origin main

# 2) 重装，让 profile 跟上新 commit
dsh plugin --profile web add github:SiriusWJ/dsh-rp-tools

# 3) 改了 dm 预设那一半，还要同步活动预设目录（它不属于这个包）
#    这一步有脚本，别手抄（幂等：重跑就是覆盖成当前版本，覆盖前自动备份）
node tools\install-preset.mjs
```

重启 `dsh web` 后生效（`lib/` 与 `preset/` 启动时装载；`client/` 只需刷新页面）。
只改了文档时第 2 步可以跳过。仓库 tarball 必须保持小（`github:` 安装会整包下载）。

> **为什么插件装完还要单独装预设**：DSH 的 agent 预设**只能是文件系统目录**
> （`~/.dsh/.agent-presets/<id>/`，由 `@deepseek-ai/dsh-agent-presets` 发现），
> 插件的 bundle manifest **声明不了预设**；而本插件的 8 个 `rp_*` 工具与两条注入通道
> **故意**只在 dm 预设作用域注册（作用域隔离 = 只有 DM 会话看得到、会话之间不串台）。
> 所以预设目录必须存在，否则工具一个都不生效 —— 这一步是架构约束，不是仪式。
> `install-preset.mjs` 装完还会自检「插件是否装进 profile」「预设是否引用了桥接与过滤器」，
> 让「装了但工具不出现」当场暴露。

> **profile 路径不写死**：桥接与 `verify-roundtrip` 都走 `preset/rp-bridge.mjs` 的
> `resolveProfilePackage()` —— `DSH_RP_PROFILE_PACKAGE` → `<DSH_HOME>/profiles/web` → 唯一 profile。
> 仓库曾有硬编码机台路径的坑（换机器上工具全不生效），所以加了
> `node tools/check-no-machine-paths.mjs` 扫这类字面量，改代码后建议顺手跑一下。

测试（每个套件都是自带桩的独立脚本，全程不联网、不碰 ComfyUI —— 插件已经不和它通信了；除探针外都不碰真实数据）：

```bash
node tools/smoke-dm.mjs        # 宿主：作用域隔离 / 路由 / 世界书 / 状态 / 资源库（含配图入库）/ 卡库导入 / 地图 / 会话包
node tools/smoke-card.mjs      # PNG 卡解码 + 映射 + 开场指令 / 引导文件
node tools/smoke-client.mjs    # 客户端 bundle：样式注入 / 槽位注册 / 面板渲染
node tools/verify-roundtrip.mjs lib/card-import.js   # 导入↔解析往返（要传 card-import.js 路径）
node tools/verify-injection.mjs                      # 读会话日志统计每轮注入（只读）
node tools/probe-cardlib.mjs   # 真卡库探针（只读 + 临时目录，手动跑）
node tools/check-no-machine-paths.mjs   # 体检：代码里不该有机台固定路径（见上文）
```

> ⚠️ **跑测试前先把插件装进某个 profile**（或让仓库能解析到 `@deepseek-ai/dsh-tools`）。
> 这些脚本用 `createRequire(profile/package.json).resolve('dsh-rp-tools')` 找到被测模块
> （profile 位置自动解析：`DSH_RP_PROFILE_PACKAGE` → `~/.dsh/profiles/web` → 唯一 profile），
> 而被测的 `lib/index.js` 自己 `import '@deepseek-ai/dsh-tools'` —— 这条是 **ESM 解析**，
> 只认模块所在目录往上找 `node_modules`，**不看 `DSH_RP_PROFILE_PACKAGE`**。
> 所以「装进 profile」（`dsh plugin add`，或用 `link:`/junction 把仓库挂进 profile 的 `node_modules`）是前提；
> 否则会看到 `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools'`。

当前开发状态、验证记录与路线图见 **[docs/STATUS.md](docs/STATUS.md)**，
给新会话的交接文档见 **[docs/HANDOFF.md](docs/HANDOFF.md)**。

## License

MIT
