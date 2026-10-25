# dsh-rp-tools

给 [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/)（dsh）用的**跑团 / DM 工具插件**：中立随机裁决、世界书、状态追踪、按会话隔离的战役配置，以及 PNG 故事书（SillyTavern 角色卡）导入 —— 选一张卡就能开团。

当前版本 **1.27.0** · MIT · 仓库 <https://github.com/SiriusWJ/dsh-rp-tools>

---

## 它是什么

模型负责叙事，插件负责它记不住的那三样：**规则、设定、状态**。

- **删除消息**：助手消息操作行里的 🗑 删除这条回复（保留提问）；每条**用户消息**旁的 🗑 删除整轮（提问 + 回复）。走官方 surface replace（参考 dsh-wm-toolkit），删掉的内容会从**模型上下文**移除；界面行当场收起，刷新页面会恢复显示（当前官方能力下的已知取舍）。
- **8 个 `rp_*` 工具**：随机裁决、会话配置、角色卡、全局配置、随机表、世界书、状态、图片资源库。全部只在 `dm` 预设的会话里注册，其它会话看不到工具，也没有任何 RP 界面。
- **按会话隔离**：世界设定、角色卡、随机表、宏表、状态、世界书每会话一份，互不串台；全局的只有卡库目录与默认宏列表。
- **两条提示词注入通道**：稳定的世界观走 system 常驻段，每轮变化的状态 / 命中条目 / 在场角色走 runtime context。
- **PNG 故事书导入**：从本地卡库选一张 SillyTavern PNG 卡，世界书、卡全文、全部开场白、卡面落进会话工作区，角色与世界观写进会话配置，自动切 `dm` 预设并发出开场指令。
- **图片资源库（`rp_assets`）**：收录已有图片（玩家自备的、导入卡的卡面等），按分类 / 角色 / 标签 / 关键词找回来复用 —— 同一张图永远长得一样。
- **设置页 + 右栏面板**：「插件 → RP工具」页签管卡库与默认宏；DM 会话头部「🎲 RP」打开右侧栏面板。
- **上下文压缩（DM 会话可用）**：dm 预设自带标准预设同款的压缩组 —— 自动压缩、`/compact` 手动压一次、工具结果超预算先裁剪；装了 billion-context / dsh-context 这类压缩插件也不冲突（它们的补丁只认标准预设行，自定义预设用宿主自带压缩兜底）。

**它不做什么**

- **不进入非 dm 会话**：工具与注入都在 `dm` 预设的 agent 作用域注册，换一个预设就完全看不到本插件。
- **不做 ST 式正则表**：`{{user}}` 这类按 dsh 原生「宿主变量」实现，不执行用户正则。

**环境**：dsh 0.2.1-rc.2 及以上（0.2.x 系列；包内 `engines.dsh` 为 `^0.2.1-rc.2`），桌面版的 profile 名是 `desktop`。插件本身零运行时依赖。

**0.2.x 适配**：DM 预设随插件包声明（`cordis.patch.yml` 里的 `preset-dm` 行），**装插件即装预设**，不再需要 `~/.dsh/.agent-presets/` 目录。

## 安装

### 1. 安装插件

桌面版界面：「插件」页 →「添加插件」→ 输入 `github:SiriusWJ/dsh-rp-tools` → 安装。

或用桌面版自带的 `dsh` CLI（单独用 npm 装的 dsh CLI 不允许管理 `desktop` profile）：

```bash
dsh plugin --profile desktop add github:SiriusWJ/dsh-rp-tools
```

本地开发可以用 `link:` 指向自己的 checkout（把路径换成仓库所在目录），改源码后只需重启：

```bash
dsh plugin --profile desktop add link:<checkout 的绝对路径>
```

> 也可以作为插件市场索引源安装：仓库带 [market/index.json](market/index.json)（format 1 索引）。在「插件 → 发现 → 添加索引源」里填能访问到该 JSON 的 https URL（需先启用实验性的「自定义插件市场」）；索引源地址、发版同步与校验方式见 [market/README.md](market/README.md)。

### 2. dm 预设随插件包自带

dsh 0.2.x 起，agent 预设不再是文件系统目录，而是 bundle patch 里的一条 `@deepseek-ai/dsh-agent-preset` 行。DM 预设已经声明在本包的 `cordis.patch.yml`（`preset-dm`，id 为 `dm`，含 persona、文档与提问工具、`dm-filter`、`rp-bridge` 等子插件行），随插件一起加载。

所以**装好插件 = 装好了预设**：重启宿主后新建会话，预设列表里会直接出现「DM 角色扮演主持人」。

- 不再需要往 `~/.dsh/.agent-presets/dm/` 拷文件 —— 那是 0.1.x 的做法，0.2.x 已失效；
- 不再需要跑任何安装脚本；
- 8 个 `rp_*` 工具与两条注入仍只在这个预设的 agent 作用域注册，选别的预设看不到。

### 3. 重启

宿主代码与 bundle patch 只在启动时应用：**重启桌面版**。只改了客户端 `client/` 时刷新页面即可。

### 4. 确认装好

- 「插件」页里能看到「RP工具」页签（与 已安装 / 插件市场 / 发现 并排）；
- 新建会话时能选到「DM 角色扮演主持人」预设；
- 会话头部右上角出现「🎲 RP」。

预设没出现时：先确认装的是 1.16.0+（只有 0.2.x 版才带预设声明），再重装 / 重启；在仓库 clone 里可以跑 `node tools/check-preset.mjs` 逐项诊断（插件、profile 的 bundle 列表、`preset-dm` 行、子插件文件）。工具没出现时看宿主日志：桥接会打印「注册 RP 工具失败」，并列出它到哪个 profile 找插件。桥接会自己挑**装了本插件的 profile**（多个都装时优先 `desktop`）；找不到或想手动指定时用环境变量：

```bash
DSH_RP_PROFILE_PACKAGE=<profile>/package.json
```

## 快速开始：开一局

1. 装好插件并重启（dm 预设随插件自带，见上）。
2. 「插件 → RP工具 → 设定」里填**卡库目录**（PNG 卡库所在目录；留空 = 会话工作区下的 `rp-cards/`）。
3. 新建会话，预设选「DM 角色扮演主持人」。
4. 新会话行（工作区 / 预设选择器那一行）右侧点「📖 导入故事书」→ 选卡 →「导入并开始」：自动切 dm、写世界书、把开场指令发给 DM。
5. 之后用头部「🎲 RP」打开右栏面板维护世界书 / 角色卡 / 资源库 / 会话包。没有卡也能开团：直接聊，让 DM 用 `rp_session` / `rp_character` 现场搭世界。

## 8 个工具

全部只在 `dm` 预设的会话作用域注册。带 `*` 的参数为必填。

| 工具 | 用途 | 主要参数 |
| --- | --- | --- |
| `rp_random` | 中立随机裁决：骰子、区间、加权抽取、布尔 | `kind` `dice` `choices` `weights` `min` `max` `count`（1..20）`seed` |
| `rp_session` | 本会话设置：世界设定、提示词前缀、战役名、DM 设定、宏 | `action`*（get/set/clear）`world` `prompt_prefix` `campaign_name` `dm_prompt` `macro_name`+`macro_value` |
| `rp_character` | 角色卡增删改查（8 个字段） | `action`*（list/set/remove/clear）`name` `appearance` `personality` `speech` `behavior` `first_mes` `mes_example` `relations` |
| `rp_config` | **全局**配置：卡库目录、默认宏列表 | `action`*（get/set）`cards_root` `macro_name`/`macro_value` |
| `rp_table` | 随机表定义与掷表 | `action`*（list/set/remove/roll）`name` `dice` `entries` `count` `seed` |
| `rp_lore` | 世界书：列目录 / 按条取 / 生成模板 / 批量中文化与重命名 | `action`（find/list/template/localize/rename_unnamed）`query` `limit` |
| `rp_state` | 状态追踪：场景 / 时间 / 地点 / 在场 / 线索 + 队伍 + 旗标 | `action`（set/get）`scene` `time` `location` `present` `clues` `party` `party_mode` `party_remove` `flags` |
| `rp_assets` | 本会话图片资源库：查 / 标注 / **导入** | `action`（list/get/tag/import）`kind` `characters` `tags` `q` `limit` `id` `label` `path` `attachment_id` `prompt` |

`rp_random` 的每一掷都带可核对的逐颗明细；`seed` 相同结果必定相同。`rp_state` 的 `party` 默认**局部合并**（按 `character` 找到那一行，只改你传的字段；传空串等于清掉该字段），整组替换要显式 `party_mode:"replace"`。`rp_assets` 不能删图（删除是玩家在面板里做的事）。

## 提示词注入：两条通道

| 通道 | 时机 | 放什么 |
| --- | --- | --- |
| **system 常驻段** | 每轮都在，要求逐字节稳定 | 战役名、DM 设定、世界设定、角色索引、路径指针（世界书 / 开局文件 / 地图）、常驻世界书条目（6000 字预算） |
| **runtime context** | 每轮重新装配 | 当前状态、地图摘要、在场角色的详细卡、命中触发词的世界书条目 |
| 文件（DM 按需 `read`） | 用到时 | 卡全文、全部开场白、被预算挡下的世界书条目 |

常驻段里只放稳定内容，避免每轮打穿前缀缓存；导入来的世界书条目按触发词走 runtime，不会因为卡里标了 `constant` 就自动进系统提示。常驻世界书超出 6000 字预算时**降级为按需**而不是截断；runtime 里因预算没展开的条目会列出标题，DM 可以用 `rp_lore` 补读。

## 界面

### 「插件 → RP工具」页签

- **设定**：卡库目录 + 默认宏列表（导入卡时预填的键值对，如 `user` → 玩家称呼）。
- **诊断**：配置文件路径与工具数量。
- 整页只有最上面一颗「保存」与一颗「恢复默认」。

### 右栏 RP 面板

DM 会话头部右上角「🎲 RP」→ 右侧栏页签（非 DM 会话这个按钮与页签都不注册）。面板卡片：DM 设定、世界设定（含导入卡的封面）、宏 / 变量、世界书、角色卡、资源库（没有图时整张卡片不渲染）、RP 表格 / 随机表（没有表时不渲染）、当前状态、备份 / 会话包。收起 / 浮动 / 关闭由 dsh 右栏负责。

面板可直接编辑世界设定、DM 设定、宏、角色卡、资源库、随机表、当前状态；**提示词前缀 / 战役名只由 DM 用 `rp_session` 维护**，面板保存时会原样回写，不会把它们清空。

## 图片资源库：收录与复用

图片资源库收录并复用会话里已有的图片（玩家自备的、导入卡的卡面等）：真存一份进会话目录（不是只记引用），按分类分文件夹、按内容 `sha256` 去重；只收 png / jpeg / webp，单张 ≤8MB。按分类 / 角色 / 标签 / 关键词查回来复用 —— 同一张图永远长得一样。

入库有两条路：

- **面板导入**：右栏 RP 面板的「资源库」里选本地图片；
- **工具导入**：把工作区里已有的图片文件收进来：

```text
rp_assets(action:"import", path:"<工作区内的图片文件>", label:"雨夜客栈大堂", tags:"客栈,雨夜", kind:"scene")
```

`path` 接受工作区相对路径、绝对路径或裸文件名；只拿到附件 id 时用 `attachment_id`。**一定要填 `label` 和 `tags`**，否则以后搜不到。

DM 不能删图；玩家可以改名称与标签、设为某角色立绘、删除（连磁盘文件一起删）。角色卡编辑器里也可以给角色导入立绘（同样进资源库）。

## PNG 故事书导入

从本地卡库搜卡 → 预览（分类 / 作者 / 世界书条数 / 开场白来源 / 世界与性格摘要）→「导入并开始」。导入做的事：

1. 卡里的 `character_book` **追加合并**进本会话的 `rp-worldbook.md`（按标题去重，不覆盖手写条目）；
2. 卡全文 → `rp-sessions/<会话 id>/cards/<slug>.md`（超预算条目的去处）；
3. **全部开场白** → 同目录 `<slug>.opening.md`（不截断，可选第几条）；
4. 规范化结果 / 卡面 → `<slug>.json` / `<slug>.png`（卡面登记为会话封面，不占角色立绘位）；
5. 开局引导 → `<slug>.launch.md`，角色卡 / 世界设定 / 战役名写进会话配置，切成 `dm` 预设并把开场指令发给 DM。

导入后要收尾的事都列在 `launch.md` 里：角色字段归位、世界书过滤（状态 / 历史类改成触发式、删空壳、补触发词）、按当前语言收拾属性。整本一次收拾用 `rp_lore(action:"localize")` / `rp_lore(action:"rename_unnamed")`。

新会话行右侧的「📖 导入故事书」**只在未开局的 DM 新会话出现**（与工作区 / 预设下拉同一行）；已经开局的团想再导一张卡，走 RP 面板里常驻的导入入口。DM / 旁白卡也认：没有角色字段的卡只导世界书和封面，DM 卡正文写进「DM 设定」。

卡库：「插件 → RP工具 → 设定 → 卡库目录」，默认 `<会话工作区>/rp-cards`。目录里的 `.png` 递归扫描（最多 3 层），约定结构 `cards/<分类>/*.png`；目录内容变化会自动重扫。卡里的 `first_mes` 在实测卡库中基本全是广告，导入时会丢弃，改用 `alternate_greetings` 当开场白。PNG 卡的数据在标准文本块 `tEXt` / `iTXt` / `zTXt` 里（`ccv3` 优先），解码只用 `node:zlib`，无额外依赖。

> 参考实测记录（作者本机，见 [docs/STATUS.md](docs/STATUS.md)）：卡库 3269 张，抽样 160/160 解析成功、中位 1ms；642 条目的卡导入 25 条。

## 世界书与状态

**世界书**是本会话专属的 `<会话工作区>/rp-sessions/<会话 id>/rp-worldbook.md`，用任何编辑器或 DM 的 `read` / `write` 维护：

```markdown
## 条目名
<!-- keys: 触发词1, 触发词2 | constant | order: 80 | prob: 100 -->
命中触发词时注入的正文。
```

`##` 开新条目；不写 `keys` 就用标题当触发词；`constant` 表示每轮常驻（不进触发匹配）；`order` 越大预算不足时越先保；`prob` 是触发概率（种子 = 会话 + 轮次 + 条目名，可精确复现）。世界设定 / 世界书里写的 `{{user}}`、`{{宏名}}` 由 dsh 宿主变量在注入时替换，面板里改宏值立刻生效。

**状态追踪**存对话历史压缩后会丢的东西：`scene` / `time` / `location` / `present` / `clues`，队伍每人 `status` / `abilities` / `inventory` / `conditions` / `goal`，外加自由 `flags`（HP、声望、倒计时、伏笔）。空串即清除；状态注入在每轮 runtime context 最前；多轮未更新时会给 DM 一句提醒。它靠 DM 主动调 `rp_state`，不解析叙事正文。

## 随机表、地图、会话包

- **随机表**：`rp_table` 定义「表名 + 骰式 + 条目」（不写骰式默认 `1dN`），面板上也能掷；`count` / `seed` 可批量与复现。
- **地图（可选）**：只有模组本身有地点结构时才用。两个文件都由 DM 用通用 `read` / `write` 维护 —— `rp-map.json`（静态结构：节点 / 连接）和 `rp-map-state.json`（当前节点 / 已揭示 / 锁着的边 / 标记位置）。没有 `rp_map` 工具；插件每轮在状态后注入一行摘要（约 64 字），结构坏了会明说而不是渲染垃圾。
- **会话包**：把会话配置、世界书、资源库图、导入卡产物、地图打成一个 zip 导出；「拍快照」在会话目录留恢复点（**只保留最近 5 个**）。导入**默认不覆盖**（目标有内容时先问一句，确认后覆盖前自动拍快照）。包是 **STORE（不压缩）** 的 zip，用别的工具重新压缩过会被拒绝。

## 数据与文件位置

```text
~/.dsh/data/dsh-rp-tools/                    # DSH_HOME 默认 ~/.dsh
├── styles.json                              # 全局：卡库目录、默认宏列表
├── sessions/<会话 id>.json                  # 会话：世界 / 角色卡 / 随机表 / 宏 / 前缀 / 状态 / 立绘引用 / DM 设定
├── dm-sessions.json                         # DM 会话登记（界面据此显示 RP 入口）
└── _agent-probe.json / _standing-probe.json # 诊断快照

<会话工作区>/
├── rp-cards/                                # 卡库默认位置（设置页里留空时）
└── rp-sessions/<会话 id>/
    ├── rp-worldbook.md                      # 世界书（本会话专属）
    ├── cards/<slug>.{md,opening.md,json,png,launch.md}   # 导入产物
    ├── assets.json + assets/{portraits,scenes,items,other}/<id>.<ext>
    ├── rp-map.json + rp-map-state.json      # 地图（可选）
    └── snapshots/snapshot-<时间>.zip        # 恢复点（最近 5 个）
```

环境变量：`DSH_HOME`（数据目录根，默认 `~/.dsh`）、`DSH_RP_PROFILE_PACKAGE`（dm 预设桥接用；不设时自动找装了本插件的 profile，多 profile / 自定义位置时可手动指向该 profile 的 `package.json`）。

## 开发与测试

所有改动都在本 git 仓库里做。从 git 装进 profile 的是**安装期副本**，改完要重新安装 + 重启；开发时推荐 `link:` 安装，改源码后重启即可。dm 预设与两个子插件声明在仓库根 `cordis.patch.yml`（`preset-dm` 行），改完同样要重新装插件 / 重启宿主才生效。

```bash
node --check lib/index.js && node --check client/client.js
```

测试脚本会优先测 profile 里装的那份，没装时退回仓库源码：

```bash
node tools/smoke-dm.mjs        # 宿主：作用域隔离 / 路由 / 世界书 / 状态 / 资源库 / 卡库导入 / 地图 / 会话包
node tools/smoke-client.mjs    # 客户端 bundle：样式注入 / 槽位注册 / 设置页与面板渲染
node tools/smoke-card.mjs      # PNG 卡解码 + 映射 + 开场指令 / 引导文件
node tools/verify-roundtrip.mjs lib/card-import.js   # 导入 ↔ 解析往返
node tools/check-no-machine-paths.mjs                # 体检：代码里不该有机台固定路径
node tools/check-preset.mjs                          # 诊断：插件 / bundle 列表 / preset-dm / 子插件文件是否装对（只读）
node tools/verify-injection.mjs                      # 可选：读会话日志核对注入（只读）
node tools/probe-cardlib.mjs                         # 可选：真卡库探针（只读 + 临时目录）
```

前提：模块要能解析到宿主的 `@deepseek-ai/dsh-tools` —— 先把插件装进 profile（`DSH_RP_PROFILE_PACKAGE` 可指定用哪个 profile，但它只解决「profile 选哪份」，救不了 ESM 解析），或让仓库自己就能解析到宿主依赖；解析不到会报 `ERR_MODULE_NOT_FOUND`。最近一次记录：smoke-dm **1083 通过 / 0 失败**；其余套件（smoke-client / smoke-card / verify-roundtrip）的计数见 [docs/STATUS.md](docs/STATUS.md)。

发布流程：`git commit` → `git push` → 重新 `dsh plugin --profile desktop add github:SiriusWJ/dsh-rp-tools` → 重启桌面版。只改文档时可跳过重装；发新版本时还要同步 `market/index.json` 的版本条目（见 [market/README.md](market/README.md)）。

## 已知限制

- **只在 dm 预设生效**，且预设 id 固定为 `dm`：在 `cordis.patch.yml` 的 `preset-dm` 行里改成别的 id 后，客户端与导入流程仍按 `dm` 判定，需要同步改代码；0.1.x 的 `~/.dsh/.agent-presets/<id>/` 目录形态在 0.2.x 已失效。
- 图片：DM 不能删图；只收 png / jpeg / webp 且 ≤8MB；资源库按内容去重。
- 会话包只认 STORE（不压缩）zip；快照最多留 5 个；导入默认不覆盖，需要确认。
- 世界书导入是**追加合并**（按标题去重），不会重写你手写的部分；「状态 / 历史」类条目若设成常驻会持续占上下文，面板只提示、不自动改语义。
- 卡导入只做到「卡 → 世界书 + 基础字段」：`personality` 常整段导入，字段细分要靠 DM 按 `launch.md` 的待办整理。
- 故事书导入的浏览器侧闭环（切预设 + 自动发开场）请以真实界面为准；失败时面板会显示原因，不会静默。
- 地图是可选功能，没有专用工具，两个 JSON 由 DM 读写；玩家改结构时要先读后写。

## 相关文档

- [docs/STATUS.md](docs/STATUS.md)：开发状态、验证记录、路线图
- [docs/HANDOFF.md](docs/HANDOFF.md)：交接文档（改代码前先读）
- [docs/PNG-CARD-DECODE.md](docs/PNG-CARD-DECODE.md)：PNG 角色卡格式实测

## License

MIT
