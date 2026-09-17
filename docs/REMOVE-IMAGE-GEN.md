# 完全移除本地生图功能（ComfyUI）——实施方案与实施记录

> 目标仓库：`SiriusWJ/dsh-rp-tools`，基线 commit `cccfb75`（tag `v1.14.3`）。
> **本文件前半是当初的方案，后半（§10 起）是实施记录**：实际改了什么、与方案的偏差、
> 以及实施中**真跑出来的三个缺陷**。方案的「建议/可选项」若已落地，会在原处标注 **已实施**。
> 行号除特别说明外**以基线 commit 为准**（改完之后行号必然漂，故正文尽量用函数名/工具名指代）。

## 0.0 实施状态（结论先行）

| 项 | 状态 |
| --- | --- |
| 生成链路 | 已全部移除（3 个工具 / 4 条路由 / 全部 ComfyUI 与风格库代码） |
| 消费链路 | 全部保留（资源库、立绘位、玩家导入、卡面、常驻段「已有可用图」） |
| 新能力 | `rp_assets(action:"import")` 已实装（工作区路径 / 裸文件名 / 宿主附件 id 三条来源） |
| 工具面 | 11 → **8** 个；路由 29 → **25** 条（生图路由残留 0） |
| 代码量 | `lib/index.js` 6676 → 5651 行；`client/client.js` 3634 → 3202 行 |
| 测试 | smoke-dm **1004** / smoke-client **427** / smoke-card **256** / verify-roundtrip **10**，全 0 失败 |
| 实施中新发现的缺陷 | **3 个**（`keepGlobalTools` 白名单漏项、`rp_config` 写坏配置形状、portrait 路由缺省语义反转）——见 §10 |

## 0. 已确认的决策（来自本轮对话）

| 决策 | 选择 |
| --- | --- |
| 移除范围 | **只移除「生成」链路**（ComfyUI / 风格库 / LoRA / 出图工具）；**保留「消费」链路**（资源库 `rp_assets`、立绘位、用户导入图片、常驻段「已有可用图」） |
| 出图改由谁做 | **宿主系统自带的生图工具**（`generate_image` / `edit_image`，由 `dsh-image-gen` 插件提供，已在本机 profile 启用 0.6.8）。DM 需要插图时直接调它，插件不再自己出图 |
| `rp_config` | **保留**，删掉生图字段，并在工具说明里明确提示 DM 「配图请用系统生图工具」 |
| 预设措辞 | **不复述已删工具的名字**（`rp_illustrate` / `rp_styles` / `rp_scenes`）—— 模型看不到这些工具，点名只会把注意力引到不存在的工具上；改为正面说明「本插件不提供出图能力 + 要图就用 `generate_image`」 |
| 本地产物落盘位置（迁移参考） | `generate_image` 会把图写到 `<会话工作区>/dsh-image-gen/image-<8位hex>.png`（内容寻址、幂等重写），由 `dsh-image-gen` 的 `workspaceFolder` 配置决定目录名 |

---

## 1. 移除后插件是什么

**删掉的东西**（一条链路，全部围绕「插件自己调 ComfyUI 出图」）：

- ComfyUI HTTP 客户端：`/prompt` 提交、`/history` 轮询、`/view` 取字节、`/system_stats` 自检、LoRA 目录列举
- 三套内置工作流模板（krea2 / NetaYumev35 / FLUX.1-Dev）与提示词拼装
- 风格库（styles.json 的 `styles` / `defaultStyle` / `negative` / `comfyui`）、全局与风格级图像尺寸
- 角色固定种子、单人自动选纵向立绘档
- 出图即登记立绘、出图即入资源库
- 4 个工具入口：`rp_styles`、`rp_illustrate`、`rp_scenes`、`rp_config` 的生图字段
- 3 个 HTTP 路由：`/rp-tools/media`（ComfyUI 代理）、`/rp-tools/preview`（试出）、`/rp-tools/loras`、`/rp-tools/check`（连通自检）
- 设置页「图像」整节、面板「本会话生图」整卡、角色卡「立绘」按钮（生成立绘的那个）

**留下的东西**（DM 仍是完整的跑团插件）：

- 骰子/随机 `rp_random`、随机表 `rp_table`、状态追踪 `rp_state`
- 世界书 `rp_lore` + 会话配置 `rp_session`（世界/宏表/前缀/战役名/DM 设定）
- 角色设定表 `rp_character`（只去掉「顺带出立绘」）
- 资源库 `rp_assets`（**现在是玩家导入图与系统生图结果的复用入口**）
- 卡库导入（PNG 故事书 / 角色卡 / DM 卡）、会话包导出导入、快照、地图
- 立绘位（`portraits`）：`imported`（用户上传）、`card`（卡面）两条来源照旧可用
- 提示词常驻段与 persona（去掉「调 `rp_illustrate`」的说法，改成「调系统生图工具」）

---

## 2. `lib/index.js` 逐条改动清单

### 2.1 删除：模块级生图常量与工作流（行 19–257）

| 行 | 内容 | 处理 |
| --- | --- | --- |
| 44–45 | `COMFY_ORIGIN` / `COMFY_BASE_URL` | 删 |
| 50 | `learnedOrigin`（只为拼同源媒体代理 URL） | 删 |
| 51–52 | `POLL_INTERVAL_MS` / `DEFAULT_TIMEOUT_MS` | 删 |
| 54–148 | `WORKFLOW_TEMPLATES`（krea2 / uncensored_anime / uncensored_real） | 删 |
| 150–183 | `buildWorkflow()` | 删 |
| 185–199 | `IMAGE_SIZE_SLOTS` / `DEFAULT_IMAGE_SIZES` / `LEGACY_DEFAULT_IMAGE_SIZES` / `FALLBACK_IMAGE_SIZES` | 删 |
| 200–243 | `defaultStyles()` → 缩成 `defaultConfig()`，只留 `cards`（卡库根目录 + 默认宏列表 + `userLabel`/`macrosSeeded`） | 改 |
| 245–257 | `LEGACY_STYLE_SIZES` / `REMOVED_BUILTIN_STYLES` | 删 |

### 2.2 改写：`loadStyles()`（行 259–340）

保留的迁移逻辑**只有卡片库那一块**（行 273–295：`cards.root` / `cards.macros` / `userLabel` 同步 / 一次性 `macrosSeeded`）。删除：

- 行 266–268 `comfyui.dshOrigin` 补齐
- 行 269–272 全局 `negative` 迁移
- 行 296–320 风格库清理、`defaultStyle` 兜底、风格尺寸降级迁移
- 行 321–338 全局 `imageSizes` 迁移

保留理由：`loadStyles()` 仍被 `globalMacros()` / `cardUserLabel()` / `cardLibraryRoot()` / `rp_config` / `/rp-tools/config` 使用，函数名不必改（改名会牵动 20+ 处调用点，收益为零）。**读盘容错要保留**：老 `styles.json` 里的 `styles`/`negative`/`comfyui`/`imageSizes` 键不再被读，但**不主动删除磁盘上的老键**（见 §6）。

### 2.3 删除：出图管线（行 1436–1625、1866–1941）

| 函数 | 位置 | 备注 |
| --- | --- | --- |
| `sleep` | 1436 | 只被 `waitForImages` 用 → 删 |
| `comfyApi` / `submitWorkflow` / `waitForImages` | 1442–1512 | 删 |
| `recordGeneratedPortrait` | 1527–1546 | 删（出图即登记立绘） |
| `illustrateSizeKey` | 1558–1566 | 删 |
| `mediaUrl` | 1569–1577 | 删（`/rp-tools/media` 一起删） |
| `comfyStatus` | 1580–1591 | 删 |
| `buildPrompt` | 1600–1614 | 删（只服务出图） |
| `aspectToSize` | 1617–1625 | 删（只服务出图尺寸） |
| `generateOne` | 1891–1941 | 删（出图中枢） |
| `hashSeed` / `mulberry32` / `makeRng` | 1957–1983 | **保留** —— `seededRoll`（世界书概率、骰点）在用 |
| `characterInPrompt` | 1866–1884 | **保留**（`__debug` 有测试口），但删掉 `characterSeed` |
| `characterSeed` | 1885–1889 | 删（只服务固定种子出图）；同时从 `__debug` 导出里删（6482 行） |
| `readScenes` / `sceneIdOf` / `panelIdOf` | 1944–1957、3235–3249 | **保留**（地图/场景摘要仍在用 `sceneIdOf`、`panelIdOf`；`readScenes` 若无其它调用点则一并删，实施时以 grep 结果为准） |

### 2.4 删除：资源库的「从 ComfyUI 取字节 + 出图归档」两个函数

- `fetchComfyImageBytes`（3470–3484）：删
- `archiveGeneratedImages`（3486–3512）：删（唯一调用方是三个出图工具）

**保留** `archiveAsset`（3417–3468）—— 它是「把字节存进资源库」的中立入口，玩家导入路径（`handleAssetUpload`）与新的「导入系统生图结果」都用它。注意 `archiveAsset` 的 `meta.source` 默认值是 `'generated'`，出图链路没了以后，新增调用点应显式传 `source: 'imported'`（或把默认值改成 `'imported'`，见 §5.3）。

### 2.5 删除：工具（`rpTools`，行 2155 起）

| 工具 | 行 | 处理 |
| --- | --- | --- |
| `rp_random` | 2157–2247 | 不动 |
| `rp_styles` | 2249–2277 | **整块删** |
| `rp_illustrate` | 2280–2385 | **整块删** |
| `rp_character` | 2388–2498 | **保留，做减法**：删 `portrait`/`style` 两个参数（2410–2411）、删执行体的出图分支（2469–2494）、`media` 输出字段保留但恒为空数组（或一并从 schema 删除，实施时二选一，注意 `output.schema` 是 required 校验） |
| `rp_state` | 2501–2585 | 不动 |
| `rp_lore` | 2587–2700 | 不动 |
| `rp_session` | 2701–2834 | **保留，做减法**，见下 |
| `rp_scenes` | 2837–2978 | **整块删** |
| `rp_assets` | 2981–3068 | **保留**，新增 `import` action（见 §5.3） |
| `rp_config` | 3070–3130 | **保留，做减法**，见下 |
| `rp_table` | 3133+ | 不动 |

#### `rp_session` 的减法（2701–2834）

- 删参数：`default_style`（2727）、`style_notes`（2728）、`images_enabled`（2731）、`images_first_appearance`（2732）、`images_key_scenes`（2733）
- 删执行体：`imageFlags` 那段（2774–2783）、`default_style` 校验写入（2784–2790）
- `style_notes` 参数删掉后，会话里的 `styleNotes` 字段不再写入；`r-world` 等无关逻辑不动
- `action:"clear"`（2792–2805）里删 `defaultStyle` / `styleNotes` 两项
- 回显 `lines`（2810–2825）删四行：默认风格、负面词、风格备注、本会话生图
- `world` 参数描述里的「给 DM 与配图当背景，不直接塞进生图提示词」（2723）→ 改成「给 DM 当背景设定」

#### `rp_config` 的减法 + 新增提示（3070–3130）

- 删参数：`negative`、`default_style`、`base_url`、`style_key`、`trigger`、`steps`、`cfg`（3074–3080）
- 改 `description`：从「查看或修改全局生图配置」改成「查看或修改全局卡库配置（卡库目录、默认宏列表）」，并**明确写一句**：
  > 本插件不做配图。需要插图时请直接用系统自带的 `generate_image` / `edit_image`（宿主工具），生成的图会作为附件显示在对话里。
- 删执行体的 `set` 分支（3099–3113），改为只处理卡片库字段（与 `/rp-tools/config` 里 `body.cards` 那段同一套校验：宏名走 `MACRO_NAME_RE`、空值丢弃、`macrosSeeded: true`）
- 回显 `lines`（3121–3127）删四行：ComfyUI 地址、默认风格、负面词、风格数；保留配置文件路径

> 注：设置页的「卡库目录 / 默认宏」目前走 `POST /rp-tools/config`（行 4960–4983）。`rp_config` 的 `set` 要与它行为一致，最好抽一个 `applyCardConfigPatch(cfg, body)` 共用（`rp_config` 的宏用 `{user: '玩家'}` 这种单键写法，接口形状可自定，但校验规则必须同源）。

### 2.6 删除：HTTP 路由

| 路由 | 行 | 处理 |
| --- | --- | --- |
| `/rp-tools/media` | 5352–5379 | **删**（ComfyUI `/view` 代理） |
| `/rp-tools/preview` | 5720–5743 | **删**（试出/立绘预览） |
| `/rp-tools/loras` | 5115–5130 | **删**（读 ComfyUI LoRA 目录） |
| `/rp-tools/check` | 5148–5160 | **删**（ComfyUI 连通自检） |
| `/rp-tools/state` | 4916–4940 | **改**：删 `comfyOrigin`、`comfyBaseUrl`、`styles`、`defaults`；保留 `file`、`config`、`autoMacros`。`learnedOrigin` 一并删（行 4919–4921） |
| `/rp-tools/config` | 4942–5047 | **改**：删 `defaultStyle`（4951–4953）、`baseUrl`（4954–4956）、`negative`（4957–4959）、`imageSizes`（4984–4992）、整个风格补丁块与 `applyStyleOps` 调用（5005–5034）；响应的 `styles`/`removedStyles`/`styleErrors` 删掉。保留 `body.cards` 与 `body.campaign` |
| `/rp-tools/reset` | 5132–5146 | **改**：`defaultStyles()` → `defaultConfig()`；响应删 `styles` |
| `/rp-tools/session` | 5163+ | **改**：GET 不动（`session` 对象里多几个死字段无妨）；POST 删 `defaultStyle`（5201–5204）、`styleNotes`（5206）、`body.dm.images` 校验（5234–5242 → 只留 `prompt`/`migrated`） |
| `/rp-tools/portrait` | 5386–5445 | **改**：删「面板出图后归档」那段（5431–5439）；`action: 'clear'` 语义收窄（见 §5.2） |
| `/rp-tools/asset-upload` | 5509–5518 | 不动 |
| `/rp-tools/portrait-upload` | 5513–5518 | 不动（兼容别名） |
| `/rp-tools/assets` | 5524+ | 不动（`useAsPortrait` / `delete` / `update` 都还是有效操作）；注释里「出图是并发的」改成「导入是并发的」 |
| `/rp-tools/asset-image` | 5648–5684 | 不动 |
| `/rp-tools/portrait-image` | 5688–5718 | 不动 |
| 其余（lore/cards/card/card-import/card-image/export/snapshots/snapshot/import/tidy/gate/roll/inject/dm-mark/tools） | — | 不动 |

### 2.7 删除：风格库辅助函数

| 函数 | 行 | 处理 |
| --- | --- | --- |
| `listLoras` | 4238–4249 | 删 |
| `applyStyleOps` | 4250–4307 | 删 |
| `newStyleTemplate` | 4221–4237 | 删 |
| `styleSummary` | 4201–4220 | 删 |
| `normalizeSizePair` | 3631–3644 | 删（只服务 imageSizes / 风格 sizes） |
| `resolveImageSizes` | 3645–3653 | 删（含 `__debug` 里的测试口 6497） |
| `charactersInPrompt` | 3514–3521 | **保留**（`rp_assets`/`rp_assets import` 打标签用） |

`defaultStyles()` 被引用处需一并改为 `defaultConfig()`：行 263、271、308、4202、4222、4256、4930、5139。

### 2.8 改写：`renderDmSetup()`（行 4440–4511）—— 这是「提示 DM 用系统生图工具」的落点

删：

- 生图开关那一行（4444–4454，`- 生图：**关**/开（…）· 出图用 rp_illustrate…`）
- `session.dm.images` 的读取（4442）

改：「已有可用图」这一行（4490–4493）与资源库摘要（4494–4506）**保留**，但措辞去掉「不要再生成」「省 15~25 秒」这类本地出图语汇，改成：

```
- **已有可用图：先在下面找，有就直接展示**（玩家导入的立绘 / 导入卡的卡面 / 资源库里收着的图都在这里；
  展示时把地址原样放进 `dsh-ui` 的 image 组件）：
  · 祁俊（导入的立绘）：/rp-tools/portrait-image?...
  · 卡面《…》：/rp-tools/card-image?...
- 资源库：本会话已有 N 张图（角色 a、场景 b）—— 剧情回到同一地点/同一人物时，先用 `rp_assets` 查一遍，
  找到就重放那张（同一张图永远长得一样，也不必再花一次生图额度）
```

新增一行（就是用户要的「提示 DM 用系统生图工具」）：

```
- 需要新图时用宿主的 `generate_image`（改图用 `edit_image`）—— **本插件不出图**，不要再找 rp_illustrate/rp_styles。
  画面描述里带上人物卡 `appearance` 里的外观描述以保持角色一致；拿到附件后用 `dsh-ui` 的 image 组件显示。
  想把新图收进资源库复用，用 `rp_assets(action:"import", path:"dsh-image-gen/image-xxxxxxxx.png")`（工作区相对路径）。
```

`buildStandingText`（4554+）里对这部分的拼装逻辑（标题选择、DM 正文）保持；注意 4557 附近「有没有世界观类内容决定用哪个标题」的判断原本会考虑「只有 DM 设定（生图开关等）」—— 生图开关没了以后，只剩 DM 正文，判断条件要跟着调（变成「只有 DM 正文时」）。

### 2.9 删除：`__debug` 里的出图测试口（6406–6510）

删：`recordGeneratedPortrait`、`illustrateSizeKey`、`archiveGeneratedImages`、`fetchComfyImageBytes`、`resolveImageSizes`、`characterSeed`。
保留：`loadAssets` / `saveAssets` / `archiveAsset` / `findDuplicateAsset` / `queryAssets` / `assetLine` / `asset*` 常量 / `characterInPrompt` / `charactersInPrompt`。

### 2.10 其它

- 文件头注释（1–27）：「本地生图桥接（走 dsh-comfyui 的工作流库 + 媒体代理）」整段删；模块描述里的生图措辞改掉
- `registerRpTools` 的注释（6649–6654）：「注册 RP 生图 / 会话 / 角色…」→「注册 RP 会话 / 角色 / 状态 / 资源 / 表格工具」
- 行 20 的注释、行 3514 附近的注释、`assetWriteChains` 注释（3362）里举的 `rp_illustrate` 并发例子要换掉（现在并发的写入口是面板导入 + 资源库导入）
- `installRoutes` 顶部若有「媒体代理」说明也一并清

---

## 3. `client/client.js` 逐条改动清单

### 3.1 删除：设置页（`RpSettings`，行 630–1018）

| 行 | 内容 | 处理 |
| --- | --- | --- |
| 4 | 文件头注释（设置页含 ComfyUI 地址/风格库） | 改 |
| 96–98 | `API.check` / `API.preview` | 删 |
| 103 | `API.loras` | 删 |
| 140 未用、`stylesInjected` | 无关，不动 | — |
| 232–263 | `.stylecard/.stylegrid/.stylerow/...` CSS | 删 |
| 411 | 「生图开关一行排开」注释 | 改/删 |
| 550–563 | `useScrollToPreview` | 删（唯一用处在设置页预览与面板预览，两处都删） |
| 636–639 | `preview` / `loras` / `loraErr` state | 删 |
| 644–646 | `previewRef` / `useScrollToPreview` | 删 |
| 650–671 | `reload()` 里的 `API.loras()`（656、664–665） | 删 |
| 673–695 | `patchStyle` / `removeStyle` | **删**（「新增风格」早已移除，风格不再可编辑） |
| 697 | `IMAGE_SIZE_DEFAULTS` | 删 |
| 703–750 | `save()` 里的 styles/comfyui/imageSizes/negative/defaultStyle/styleOps 提交（719–741）、`styleErrors` 处理（744–745） | 删，只留 `cards` 区块 |
| 757–766 | `reset()` 的 confirm 文案（「风格库 / 负面词 / 默认风格」）→「默认宏列表与卡库设置」 | 改 |
| 772–780 | `check()` | 删 |
| 783–800 | `runPreview()`（设置页那个） | 删 |
| 803–812 | `loraOptions` | 删 |
| 814–846 | `styleRows` | 删 |
| 960–1016 | `section('图像', '本地 ComfyUI 生图', [...])` **整节删**（含 ComfyUI 地址、全局默认风格、全局负面词、图像尺寸三行、风格库列表、预览卡） | 删 |
| 978–983 | `sizeRow()`（只在这里用） | 删 |

保留：卡库目录、默认宏列表、自动宏提示、工具清单（`/rp-tools/tools`）、`/rp-tools/inject` 诊断入口（若有）。

### 3.2 改写：面板（`RpSessionOverlay`，行 1020–2650）

| 行 | 内容 | 处理 |
| --- | --- | --- |
| 54–61 | `mediaUrlOf`（拼 `/rp-tools/media`） | 删 |
| 63–91 | `portraitsFromSession` | **改**：删掉 `generated` 分支（64–79 里对 `entry.generated` 的读取），只留 `imported`（→ `/rp-tools/portrait-image`）与 `card`（→ `/rp-tools/card-image`） |
| 98 | `API.preview` | 删 |
| 103 | `API.loras` | 删 |
| 107–108 | `API.portraitSave` | **保留**（`action:'clear'` 仍用于「删掉立绘」），但去掉「把生成结果的 (file,subfolder,type) 记进会话配置」的注释 |
| 1024–1027 | `styles` / `preview` state | 删 |
| 1076–1077 | `previewRef` / `useScrollToPreview` | 删 |
| 1233、1286、1446 | 表单提交里的 `defaultStyle` / `styleNotes`（若有） | 删 |
| 1286 附近 | `dm: { prompt, images: {...} }` 提交体 | 改成只提交 `prompt` |
| 1591–1604 | `runPreview()` | 删 |
| 1607–1658 | `regeneratePortrait()`（调 `API.preview` 出立绘再 `portraitSave`） | **删**（生成立绘入口） |
| 1660–1671 | `clearPortrait()` | **保留**，但 `action:'clear'` 的语义收窄见 §5.2；确认删角色时仍会连带清理 |
| 1684–1705 | `importPortraitFile()`（走 `assetUpload`） | **保留**（用户导入图片的能力） |
| 1806–1807 | `portraitNames` / `imageEnabled` | `portraitNames` 保留（用于「已有立绘」摘要），`imageEnabled` 删 |
| 1835–1891 | **「本会话生图」整卡**（`session-images`） | **整卡删**：自动配图三开关、默认风格下拉、「试出 / 预览」按钮、预览图块、`imagecontrols` CSS（379） |
| 2355–2359 | 「生图配置已合并到顶部」的说明块 + `style-note` | 改：保留一句「提示词前缀 / 战役名由 DM 用 `rp_session` 维护」，去掉生图相关半句 |
| 2593 | 角色卡里 `外貌（生图时自动补进提示词）` | 改成「外貌（DM 配图时会作为画面描述的一部分）」，字段本身**保留** |
| 2793、3527 | 面板标题/描述里的「生图配置」 | 改 |
| 294、313–327、382 | 立绘相关 CSS 与注释 | 保留（立绘位还在），只调注释（「删掉立绘」→「移除立绘」） |

角色卡编辑浮窗（1806–1830 附近）：**删掉「重新生成」按钮**（原 `regeneratePortrait`），**保留「导入图片」**（`label.filebtn` + `input[type=file]`）与「移除立绘」。

### 3.3 删除：API 面（行 94–138）

```
- state.preview      (98)
- state.check        (97)   ← 若设置页不再有「检查连接」
- state.loras        (103)
- mediaUrlOf         (54–61)
```

`state.state()` / `state.save()` / `state.reset()` / `state.tools()` / `state.session()` / `state.saveSession()` / `roll` / `cards` / `card` / `cardImport` / `portraitSave` / `portraitUpload` / `assets` / `assetSave` / `assetUpload` / `snapshots` / `snapshot` / `importBundle` / `gate` / `lore` / `loreEntry` / `loreSave` / `tidy` 全部保留。

---

## 4. 预设与文档

### 4.1 `preset/agent.cordis.yml`

- **删整节**「## 插画（本地生图可用时）」（行 124–156）
- **加一节**「## 配图（用宿主的生图工具，不要自己出图）」，内容要点（写给人看，精简到 20 行内）：
  1. 需要插图时调 `generate_image`（改图 `edit_image`）——**本插件没有出图工具，不要找 `rp_illustrate`/`rp_styles`/`rp_scenes`**
  2. 画面描述带上人物卡 `appearance` 的外观描述（顺序：发型色 → 眼睛 → 肤色体型 → 身高 → 穿着 → 配饰），这是角色一致性的主要手段
  3. 生成的图是**附件**：拿到后用 `dsh-ui` 的 `image` 组件显示，多张图放同一个围栏
  4. 先查【本会话设定】里的「已有可用图」与资源库（`rp_assets`），能复用就别重生
  5. 一次要几张就一次发几个 `generate_image` 调用（并行，不要串行等）
  6. 插件内置的三套风格提示词模板（原 `uncensored_anime` / `uncensored_real` / `manga` 的 trigger + `notes`，见 `defaultStyles()` 228–241）**搬到这里当可选风格词**：二次元（NetaYume 系）、写实（FLUX 系）、黑白漫画（screentone/ink lineart）。没有 LoRA 了，靠提示词
- 行 37 那句「系统提示里那些『常驻条目』『已有可用图』是**规则说明**」—— 保留（`已有可用图` 仍在常驻段里）
- 行 51–52 提到 `rp_character` 填 appearance —— 保留

### 4.2 脚本注释与文档

- `preset/rp-bridge.mjs` 行 4：「RP 生图 / 会话 / 角色…」→「RP 会话 / 角色 / 状态 / 资源 / 表格工具」
- 建议新增 `preset/style-prompts.md`（或直接写在 persona 里）放那三套风格词的完整版，供人以后调
- `package.json`：
  - `description` 重写：去掉「本地 ComfyUI 配图（rp_illustrate / rp_styles …）」「只依赖本机 ComfyUI」，改成「本地图片资源库（玩家导入 / 系统生图结果归档）+ 会话级战役配置 + 世界书/状态追踪 + PNG 故事书导入」
  - `keywords`：删 `comfyui`、`image-generation`；`dependencies` 无变化（本来就没有第三方依赖）
  - `version`：按仓库习惯升 minor（`1.15.0`）——这是**破坏性 API 变更**
- `docs/STATUS.md` / `docs/HANDOFF.md` / `docs/DEVELOPMENT-PLAN.md` / `docs/REFERENCE-COMPARISON.md`：追加一条「1.15.0：移除本地生图链路」的条目即可，**历史条目不要改写**（这个仓库的 STATUS 是变更日志，改写历史会毁掉可追溯性）；`REFERENCE-COMPARISON.md` 里「直连 ComfyUI 出图是独有的护城河」（行 133、257、270）这类战略结论需要加一句「1.15.0 起改由宿主生图工具承担，插件侧护城河转为会话隔离 + 资源归档 + 世界书/状态」
- `README.md`（28KB）：改动点集中在
  - 第 19 行表格「生图模型（Krea-2 / NetaYumev35 / FLUX.1-Dev）」整行删
  - 第 50 行「🖼 **本地生图** `rp_illustrate` / `rp_scenes`」→ 改成「🖼 **图片资源库** `rp_assets`（导入 + 复用；新图用系统 `generate_image`）」
  - 第 55 行会话隔离列表里删「会话默认风格」「生图开关」
  - 第 77 行工具表删 `rp_styles` / `rp_illustrate` / `rp_scenes` 三行，`rp_config` 说明重写
  - 第 94 行面板卡片清单删「本会话生图」「资源库（没有图时整张卡片不渲染）」保留资源库
  - 第 128 行上下文分层表删「生图策略」一项
  - 第 316 行架构图里「生图链路」那一行删
  - 「模型前提」相关小节（ComfyUI 安装、模型文件、LoRA）整节删

---

## 5. 三个需要拿主意的细节（本方案已给建议）

### 5.1 常驻段要不要真的「提示 DM 用系统生图工具」

**建议：要，且只写一行**。理由：你明确要求。但**不要**把宿主工具描述抄进常驻段（每轮都发的字节，抄一遍既费 token 又会被宿主的工具描述覆盖出两套口径）。写成「需要新图时用 `generate_image`（改图 `edit_image`）；先查『已有可用图』与 `rp_assets`，能复用就别重生」即可。
副作用：常驻段字节会变 → 首轮前缀缓存失效一次，之后稳定。

### 5.2 `portraits[name].generated` 这个字段怎么办

老会话的 `sessions/<id>.json` 里存着 `generated: {file,subfolder,type}`，指向 ComfyUI 的 `output/` 目录。`/rp-tools/media` 删掉后这些路径**全部失效**（死链）。

三个选项：

| 选项 | 做法 | 评价 |
| --- | --- | --- |
| A（**建议**） | 读盘时**忽略** `generated`，不做任何磁盘改写；面板自然变成「这个角色没有立绘，可以导入一张」；`portrait` 路由的 `clear` 保留（能清掉死记录） | 零风险、可回滚。缺点：老配置里留着死字段 |
| B | 加一次性迁移：删掉所有 `generated` 键并落盘 | 干净，但**不可逆**，且用户还没决定要不要保留那些 ComfyUI 里的老图 |
| C | 什么都不做，保留 `mediaUrlOf` 与 `/rp-tools/media` | 与「完全移除」矛盾，否决 |

配套：`GET /rp-tools/portrait-image` 已经只认 `imported` 那一份（5699），不受影响。

**实施时踩到并修掉的坑**：`POST /rp-tools/portrait` 收窄时，`action` 的**缺省值不能写成 `'clear'`** ——
老版本这条路由的语义是「缺省 = 保存生成结果」，把缺省当 `clear` 会让**老调用静默变成删除**
（请求里带着 `file` 却没有 `action`，就被当成「清掉这个角色的立绘」）。现在只认**显式的** `clear`，
缺省与其它值一律 400 并说清该走 `/rp-tools/asset-upload`；连 `file`/`subfolder`/`type`/`style`/`elapsedMs`
这些生成产物字段也一起挡住（带着它们来「clear」多半是没改完的调用，报错比静默清掉好查）。
`clear` 本身**只删 `generated`**，`imported`（用户导入的）与 `card`（卡面）都不动 —— 已有断言覆盖。

### 5.3 少了出图，资源库只剩「导入」——建议给 `rp_assets` 加一个 `import`

现在资源库的喂入口有两个：`rp_illustrate`/`rp_scenes` 的自动归档（要删）和面板导入（保留）。删掉前者后，**系统生图的结果进不了资源库**，「找到就重放、不必再生成」这条复用能力就废了一半。 

**建议**：给 `rp_assets` 加 `action:"import"`（或复用 `tag` 的写法新增一个 action），参数 `path`（**会话工作区相对路径**，如 `dsh-image-gen/image-01234567.png`），执行体约 40 行：

1. `resolveWorkspaceDir(sessionIdOf(exec))` 拿会话工作区（注意：拿不到就报错，不猜 cwd）
2. `resolve(workspace, path)` 后校验 `startsWith(workspace + sep)`（与 `asset-image` 同一套越界防护）
3. 后缀白名单 `png|jpe?g|webp`，`statSync` 存在性 + `ASSET_MAX_BYTES` 上限
4. `readFileSync` → `archiveAsset(sessionId, { bytes, kind, ext, label, tags, characters, source: 'imported', prompt })`
5. 返回条目 id + `assetPreviewUrl`，note 里说明「已在资源库（用 `rp_assets` 可再查回）」

安全边界与 `portrait-upload` 保持一致（只读会话工作区内的图片文件，不写、不删源文件）。

**已实施**（见 `lib/index.js` 的 `readImageForImport` / `recentWorkspaceImages` 与 `rp_assets` 的 `import` 分支），
实施时比上面这版方案又多做/校准了四处：

1. **`path` 比方案更宽容**：除绝对路径与工作区相对路径，还接受**只给文件名**（会再在 `dsh-image-gen/` 下找一次）——
   模型经常只抄到文件名，为这个多来回一轮不值。越界判定仍然只对**解析后的绝对路径**做。
2. **`attachment_id` 走宿主附件服务**：`exec.agent.ctx.get('attachments').readImage(...)`。附件 id 里没有格式信息，
   所以 png / jpeg / webp **三种媒体类型都试一遍**（声明错就读不出字节），全失败才如实报错 —— 不静默拿错字节。
3. **去重从「同 kind 同长度」改成优先按内容**（新增 `findAssetByBytes`）：否则同一张图先当 `scene` 收一次、
   再当 `other` 收一次会**存成两份重复文件**（实施时真跑出来了）。命中已有条目时顺手补 label/tags/sha256，
   并在「调用方这次明确报了分类、而库里那条只是兜底的 `other`」时纠正分类。
4. **没给参数时的报错要能指路**：列出 `dsh-image-gen/` 里最近几张的**可直接复制的相对路径**，
   一次调用就能改对（这正是真机复测里被投诉过的那类「参数不合法只回一句『需要 id』」）。

---

## 6. 数据与向后兼容

| 数据 | 处理 |
| --- | --- |
| `~/.dsh/data/dsh-rp-tools/styles.json` | **不动磁盘文件**。`loadStyles()` 不再读 `styles`/`negative`/`comfyui`/`imageSizes`；`saveStyles()` 只在写卡片库时整份重写 —— ⚠️ 注意 `saveStyles` 是**整份覆盖**，老键会在第一次保存后消失。如果希望保留用户的老风格配置作备份，建议实施时把文件改名成 `styles.json.bak-1.14.3` 再让插件写新的（或干脆把文件重命名为 `config.json`，一次性区分新旧格式） |
| `sessions/<id>.json` 的 `dm.images` | 读盘时忽略（`loadSession` 行 596–617 里删掉 `images` 组装）。**不删磁盘字段**，`/rp-tools/session` POST 也不再收它 |
| `sessions/<id>.json` 的 `portraits[name].generated` | 见 §5.2 选项 A：忽略、不改写 |
| `sessions/<id>.json` 的 `defaultStyle` / `styleNotes` | 忽略（`loadSession` 行 547、591 删掉这两行解析） |
| 会话包（export/import） | `session-bundle.js` 里的字段清单若含 `dm.images` 无需改；导出会带上死字段，无害 |
| 已生成的图片文件 | ComfyUI 的 `output/` 与 `<工作区>/rp-sessions/<id>/assets/` 不动。资源库里已有的**生成图条目**照旧可查、可看（走 `/rp-tools/asset-image`，不依赖 ComfyUI）——**这是「保留消费链路」的最大好处**：老图墙不废 |
| `~/.dsh/data/dsh-rp-tools/dm-sessions.json` | 不动 |

**回滚**：本方案不改任何数据文件（除非采纳 §6 的 `styles.json` 改名，那也只是换个文件名）。用 git 回到 `v1.14.3` 并重装即可完整恢复；唯一需要人工处理的是「ComfyUI 地址/风格」等配置项在新的 `styles.json` 里不再出现。

---

## 7. 测试改动（`tools/smoke-dm.mjs` 230KB、`smoke-client.mjs` 135KB）

`smoke-card.mjs` / `verify-*.mjs` / `png-fixture.mjs` / `probe-cardlib.mjs` 基本不受影响（各 0–1 处命中）。

### 7.1 `tools/smoke-dm.mjs`：删掉/改写这些块

| 行 | 块 | 处理 |
| --- | --- | --- |
| 227–243 | 并发：`rp_illustrate` / `rp_scenes` 的 `isConcurrencySafe` 断言 | **删**（工具没了） |
| 245–285 | 出图即登记成立绘（`recordGeneratedPortrait` 全组） | **删** |
| 286–322 | 尺寸档：单人角色 → 纵向立绘（`illustrateSizeKey`） | **删** |
| 323–415 | 外部导入立绘 | **保留**（`assetUpload` 能力还在） |
| 416–677 | 资源库（1.13.0） | **改**：`archiveGeneratedImages` / `fetchComfyImageBytes` 相关用例改走 `archiveAsset` 或新的 `import` action；其余（索引/去重/并发写/`useAsPortrait`/删除联动）保留 |
| 2005–2046 | `rp_session` 的 DM 设定与**生图策略** | **改**：删 `images_*` 参数与「常驻段反映生图开关」断言；保留「改一个键不把 DM 正文清空」 |
| 2047–2071 | 角色固定种子（`characterSeed`） | **删** |
| 2166–2192 | 路由体检（每条 GET 都要能应答） | **改**：去掉 `/rp-tools/media`、`/rp-tools/check`、`/rp-tools/loras` |
| 2193–2283 | 风格库增删 + LoRA 清单 | **删** |
| 2663–2730 | DM 设定（会话隔离）：生图开关 + 正文注入 | **改**：删生图开关部分，保留 DM 正文注入 |
| 3014–3057 | 老配置迁移 / 降尺寸迁移 | **删**（迁移逻辑没了；保留卡片库宏那部分迁移用例，若有） |
| 3083–3113 | 全局图像尺寸 | **删** |
| 3143+ | dm 预设「渲染方案与过滤开关」 | **改**：删「插画节」的断言，加「配图节指向 generate_image、且不再出现 rp_illustrate/rp_styles」 |

`__debug` 导出被删的函数所对应的 `D.xxx` 调用要一并清掉，避免测试脚本因 `undefined is not a function` 崩在启动阶段。
**建议做法**：先 `grep -n "rp_illustrate\|rp_styles\|rp_scenes\|generateOne\|illustrateSizeKey\|characterSeed\|recordGeneratedPortrait\|archiveGeneratedImages\|fetchComfyImageBytes\|imageSizes\|defaultStyle\|negative\|comfy"` 出全部命中行，再逐块删；不要凭记忆删。

### 7.2 `tools/smoke-client.mjs`：115 处命中

集中在：设置页「图像」节、面板「本会话生图」卡（1105、1483、1518–1535）、立绘预览（1603）。处理同 §3：删断言、保留导入立绘与资源库断言。行 1519–1522 那组「『本会话生图』应是第一块 / 底部重复块应已删除」**整组删**。

### 7.3 验收命令

```powershell
cd D:\code\dsh\dsh-rp-tools
node --check lib/index.js
node --check client/client.js
node --check preset/rp-bridge.mjs
node tools/smoke-dm.mjs
node tools/smoke-client.mjs
node tools/smoke-card.mjs
```

---

## 8. 实施顺序（每步都能单独跑通）

1. **删工具**：`rp_styles` / `rp_illustrate` / `rp_scenes` 整块；`rp_character` 去立绘分支；`rp_session` / `rp_config` 做减法。跑 `node --check`。
2. **删管线**：§2.1–2.4、2.7 的函数级删除（此时会出现一批「未使用的函数」，用 `grep` 确认后逐个删）。跑 `node --check`。
3. **删路由**：§2.6（`media` / `preview` / `loras` / `check` 整条删；`state` / `config` / `reset` / `session` / `portrait` 改）。跑 `node --check`。
4. **改注入文案**：§2.8 `renderDmSetup` + §4.1 persona。跑 `smoke-dm.mjs`（此时测试还是红的，看失败点是否符合预期）。
5. **改面板与设置页**：§3。跑 `node --check client/client.js`。⚠️ `client.js` 是**打包产物**吗？—— 本仓库 `client/client.js` 是手写源码（224KB，含 `h()` 调用），没有 src/ 目录，直接改即可；若 `pnpm run dev:web` 之类的构建参与，需按仓库说明重建。
6. **清测试**：§7，跑到全绿。
7. **改文档与包元数据**：§4.2、§6。
8. **手动验收**（关键路径，必须真机过一遍）：
   - DM 会话正常开场（世界书注入、骰子、状态、角色卡）
   - 角色卡「导入图片」→ 立绘出现在角色行与编辑浮窗
   - 资源库导入一张图 → 图墙显示、改标签、设为某角色立绘、删除后立绘引用被清
   - 让 DM 出一张图 → 它调 `generate_image`（**不是** `rp_illustrate`），图在对话里以附件显示
   - 设置页只剩卡库目录 + 默认宏，保存后 `styles.json` 内容符合预期
   - 确认 `rp_styles`/`rp_illustrate`/`rp_scenes` 三个工具在 DM 会话里**不可见**（`/rp-tools/tools` 清单里没有）

---

## 9. 不做什么（避免过度工程）

- 不引入第三方依赖（本插件至今零运行时依赖，保持）
- 不保留任何「降级开关」或 `if (removedImageGen)` 之类的兼容分支 —— 要么有要么没有
- 不迁移/不删除用户已有的图片文件（ComfyUI output 与 `assets/` 都留着）
- 不重命名 `loadStyles` / `styles.json` / `rp_config`（除非采纳 §6 的备份改名）；改名会牵动 20+ 调用点与设置页，收益为零
- 不把宿主的生图工具描述抄进常驻段（只留一句指路）

---

## 10. 实施记录：方案之外真跑出来的三个缺陷

这三个都不是「照方案写就能避开」的 —— 它们分别藏在**权限白名单**、**函数返回值语义**、
**缺省参数语义**里，而且**症状都是「看起来成功了」**。记在这里，因为它们正是这类改造最容易漏的地方。

### 10.1 🔴 `keepGlobalTools` 漏项：删了出图能力，却没接上新管道

**症状**：preset 的配图小节、常驻段、`rp_config` 说明、README 全都在让 DM 调 `generate_image`，
但 DM **看不到这个工具** —— 说了等于没说。

**根因**：`preset/agent.cordis.yml` 的 `dm-filter`（`preset/session-filter-v2.mjs`）会把**所有全局工具**
deny 掉，只留 `keepGlobalTools` 白名单。而 `generate_image` / `edit_image` 是 `dsh-image-gen`
**全局注册**的（`cordis.patch.yml` 里 `insert` 到根组合），不在白名单里 → 被 deny。

**修法（第一版）**：把 `generate_image` / `edit_image` 加进白名单（README 的样例同步改，两处必须一致）。

**修法（第二版 —— 用户指出「每个 DSH 装的生图插件都可能不同」后重构）**：写死在预设里只是把坑挪了个位置 ——
换个生图插件（或它改了工具名）用户就得手改 `agent.cordis.yml`，而预设目录在**重装插件时会被覆盖**。
所以把「额外放行哪些全局工具」改成**用户可勾选的设置**：

| 层 | 内容 | 可否改 |
| --- | --- | --- |
| 预设底线 `GLOBAL_TOOLS_BASE` | `render_ui` / `validate_dsh_ui` / `web_search` | **不可** —— 去掉任何一个都会当场砸掉卡片渲染 / 围栏自检 / 开局考据 |
| 出厂额外放行 `GLOBAL_TOOLS_ALLOW_DEFAULT` | `generate_image` / `edit_image` | 可改，默认勾选 |
| 本机其他全局工具 | 设置页列出**本机真实存在**的全局工具供勾选 | 可改 |

落地要点：

- **发现**：`GET /rp-tools/global-tools` 用 `ctx.tools.schemas()` —— **省略 scope = 全局视图**
  （`view(undefined)` 不套任何作用域限制），所以列得出全部全局工具，而不只是「本作用域可见」的那份。
  设置页据此渲染勾选框，生图类自动打标、未注册的名字标「未注册」并支持手填。
- **持久化**：`POST /rp-tools/global-tools` → `styles.json` 的 `globalToolsAllow`。
- **消费**：`preset/session-filter-v2.mjs` 挂载时读那份配置并合并进 keep 名单；**读不到 / 读坏退回出厂默认**
  （底线永不受影响）；**显式空数组**才是「只留底线」。
- **同源**：默认值与归一化（合法名 / 去重 / 剔底线名 / 上限 32）抽到共享模块
  `lib/global-tools-defaults.js`，插件与过滤器**同一份**（各自硬编码必然走散：底线少一项就是静默坏掉）。
- **工具侧等价入口**：`rp_config(action:"set_global_tools", global_tools:"a,b")`，且 `get` 会报出放行名单
  与**本机实际存在的全局工具**，让模型能自己核对名字。

**为什么容易漏**：删自己的工具是「减」，改白名单是「加」，两者在代码上离得很远；
而**没有任何现成断言**会发现「persona 让调、但工具不可见」这种不一致 —— 它是**跨文件的契约**。
本仓库正好有一节「工具面」测试（断言哪 8 个 rp_* 在注册表里），但那只覆盖**本插件**的工具。
现在补上了：smoke-dm 断言「YAML 只留底线 + 默认值在共享模块里且正确 + 过滤器确实去读那份配置」，
以及新路由的发现 / 勾选 / 非法值剔除 / 未注册项可见 / 工具侧等价入口共约 30 条。

### 10.2 🔴 `rp_config` 把配置写坏形状，用户设置静默丢失

**症状**：`rp_config(action:"set", macro_name:"x", macro_value:"v")` 回「✅ 已更新」，
但紧接着 `get` 读不到 x；盘上 `styles.json` 变成 `{root,userLabel,macros,macrosSeeded}`
（**少了 `cards` 这层壳**）→ 下次 `loadStyles()` 认不出来，直接退回出厂默认，
用户的默认宏列表 / 卡库目录**无声消失**。

**根因**：`applyCardConfigPatch(cfg, patch)` 返回的是 **`cards` 那一层**，而工具那条路写成
`cfg = applyCardConfigPatch(cfg, patch)`（把返回值当成了整个 cfg）；HTTP 路由那条路是对的
（`cfg = { ...cfg, cards: applyCardConfigPatch(...) }`）。**同一个函数、两条调用路径、一种写法错**——
典型的「抽了公共函数但没统一包装」。

**修法**：包回 `{ ...cfg, cards: ... }`，并把三条都钉进测试（读得回来 / 盘上有 `cards` / 顶层没被摊平）。

**教训**：`applyXxxPatch(cfg, …)` 这类**返回片段而不是整体**的函数，命名就该点明返回的是哪一层。
本仓库的 `applyCardConfigPatch` 现在有注释专门写这件事。

### 10.3 🟠 portrait 路由缺省语义反转：老调用会静默变成「删除」

**症状**：把 `POST /rp-tools/portrait` 收窄成「只支持 `action:"clear"`」时，
若按直觉写 `String(body.action ?? 'clear')`，那么**老调用**（带 `file` 但不带 `action`，
本意是「保存生成结果」）会被**当成 clear 静默删掉该角色现有立绘**。

**根因**：这条路由老版本的缺省语义是 **save**，不是 clear。收窄时把缺省值改成 clear，
等于给一条「写入」接口赋予了「删除」的默认行为。

**修法**：缺省值取**老语义**（`?? 'save'`）→ 只认**显式**的 `clear`，其余（含缺省）一律 400 并说清该走哪条路；
顺带把 `file`/`subfolder`/`type`/`style`/`elapsedMs` 这些生成产物字段也一起挡住
（带着它们来「clear」多半是没改完的老调用，报错比静默清掉好查）。测试断言 `clear` **只**删 `generated`，
`imported` 与 `card` 都不动。

**教训**：**收窄一个写接口时，缺省值必须沿用老语义**，让老调用**响亮地失败**，而不是安静地做别的事。

## 11. 实施记录：与方案的其它偏差

| 方案原文 | 实际做法 | 为什么 |
| --- | --- | --- |
| `generate_image` 出的图「拿到后用 `dsh-ui` 的 image 组件显示」 | 改成「**刚生成的图会自动作为附件挂在对话里**，不用模型操心；**只有从资源库重放的图**才用 image 组件」 | 坏指导：工具结果的 render 自带 image 内容块（`render: () => [{type:'text'…},{type:'image',attachment}]`），图已经显示了；而 GenUI 的 `image` **只认 `src` 字符串、不认附件 id**（`safeMediaSrc(v.src)`），模型手上根本没有可用的 src。旧写法会诱导模型编一个假 URL |
| §5.3 `import` 的 path 只接受「绝对路径 / 工作区相对路径」 | 再接受**裸文件名**（回退到 `dsh-image-gen/` 下找一次） | 模型经常只抄到文件名，为这个多一轮不值；越界判定仍只对**解析后的绝对路径**做 |
| §5.3 说 `import` 是「可选」 | 已实施 | 不做的话资源库只剩玩家手动导入，DM 无法把宿主的生图结果收进来，复用能力废掉一半 |
| §5.2 选项 A「读盘时忽略 `generated`」 | 采纳；额外让 `portraitsFromSession` 与常驻段都**只认 `imported` 与 `card`** | 见 10.1/§5.2 |
| —（方案没想到） | 去重从「同 kind 同长度」改成**优先按内容**（新增 `findAssetByBytes`） | 实施时真跑出来：同一张图先当 `scene` 收、再当 `other` 收会**存成两份重复文件**。字节相同就是同一张图，与调用方这次填的 kind 无关 |
| —（方案没想到） | 删掉 `characterInPrompt`（旧固定种子的唯一调用方）与 `inflateSync` 等死代码 | 功能删干净后它们没有调用点了 |

## 12. 验证方式（可复现）

```powershell
cd <repo>
$env:DSH_RP_PROFILE_PACKAGE="<profile>/package.json"   # 见 README 测试一节的前置条件
node tools/smoke-dm.mjs          # 1004 通过 / 0 失败
node tools/smoke-client.mjs      # 427 通过 / 0 失败
node tools/smoke-card.mjs        # 256 通过 / 0 失败
node tools/verify-roundtrip.mjs lib/card-import.js   # 10 通过 / 0 失败
```

> ⚠️ 跑测试的前提是**插件能被 ESM 解析到 `@deepseek-ai/dsh-tools`**：测试脚本用
> `createRequire(profile/package.json).resolve('dsh-rp-tools')` 找模块，但模块**自己**的
> `import '@deepseek-ai/dsh-tools'` 是 ESM 解析，只认模块所在目录往上找 `node_modules`，
> **不看 `DSH_RP_PROFILE_PACKAGE`**。所以要么真装进 profile，要么用 link/junction 把仓库挂进
> profile 的 `node_modules`，否则会看到 `ERR_MODULE_NOT_FOUND`。
