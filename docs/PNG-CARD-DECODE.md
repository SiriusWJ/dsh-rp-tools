# PNG 角色卡解码调研（实测数据）

> 调研对象：本地卡库 `D:\Story\sillytavernassets`（来源仓库 `leigegehaha/sillytavernassets`）
> 样本：**3269 张可解析卡全量扫描** + 6 张分类抽查
> 工具：`D:\Story\_import\audit_cards.py`、`D:\Code\dsh\.tmp-cardprobe\{decode-test,inspect-v3,library-stats}.mjs`
> 结论一句话：**解码不是问题，数据形状是问题** —— 这张卡库的正文 40% 活在 `character_book` 里，而 `first_mes` 100% 是广告。

---

## 1. 文件格式（结论：只用 `node:zlib` 即可，无第三方依赖）

卡片数据藏在 PNG 的**标准文本块**里，不是加密，是三层公开约定：

| 层 | 内容 |
|---|---|
| PNG `tEXt` / `iTXt` / `zTXt` | 键名 `chara`（CCv2）或 `ccv3`（CCv3），值是纯文本块 |
| 值 | `base64(UTF-8 JSON)` |
| JSON | `{ spec: "chara_card_v2"/"chara_card_v3", data: {...} }`；v1 没有 `spec`，字段直接铺在顶层 |

解析要点（逐条都踩过）：

1. **`ccv3` 必须优先**：本地 1954 张（59.8%）是 v3，只读 `chara` 会漏掉一大半。部分卡两个块都有，取 `ccv3`。
2. **`iTXt` 要处理压缩标志**：结构是 `keyword\0 flag(0/1) method(0) lang\0 translated\0 text`，`flag=1` 时 `text` 是 zlib 压缩的。本地这批恰好全是未压缩的 `tEXt`，但真实世界存在压缩块。
3. **`zTXt` 同样存在**：`keyword\0 method(0) zlib(text)`。
4. **字段摊平**：v1 的字段在顶层，v2/v3 在 `data` 下；统一按 `const d = raw.data ?? raw` 处理，世界书统一读 `d.character_book`。
5. 遍历 chunk 时在 `IEND` 停止；长度越界要容错（别让一张坏图崩掉整个工具）。

**实测覆盖率**：

| 分类 | 数量 | 说明 |
|---|---|---|
| v3（`ccv3`） | 1954 | spec=`chara_card_v3`, spec_version=`3.0` |
| v2（`chara`） | 1286 | spec=`chara_card_v2` |
| v1（`chara`，无 spec） | 29 | 字段在顶层 |
| 无卡数据的 PNG | 4 | 纯插图，返回「无卡数据」而不是报错 |
| **疑似加密/解不开** | **0** | 本卡库内无加密卡；解码失败路径仍应保留（返回 `encrypted` 而不是抛错） |

抽查明细（`decode-test.mjs`）：

| 卡 | kind | 关键字 | chunk | description | first_mes | 备用开场白 | 世界书 |
|---|---|---|---|---|---|---|---|
| 黑天鹅（米哈游） | v3 | ccv3 | tEXt | 2142 | 206（广告） | 1 | 1516 条 |
| 天堂岛计划 | v3 | ccv3 | tEXt | 1379 | 206（广告） | 1 | 16 条 |
| 汴京残梦录 | v3 | ccv3 | tEXt | **0** | 206（广告） | 33 | 32 条 |
| Civ Simulator | v2 | chara | tEXt | 1509 | 206（广告） | 1 | 无 |
| Ennoia（英文卡） | v1 | chara | tEXt | 4020 | 206（广告） | 4 | 无 |

---

## 2. 三个会改变设计的实测数字

### ① `first_mes` 被广告污染 100%

- 3269 / 3269 张卡的 `first_mes` 含 `deepseektavern.com`；
- 3233 张（**98.9%**）的 `first_mes` 长度恰好 **206 字**，是同一段「酒馆专属大模型 Deepseek Tavern Pro」广告模板。

> ⚠️ 现插件 `rp_character` 把 `first_mes` 标为「最重要的文风锚点」（hermes 取向）。**直接映射 = 100% 导入广告文本。**

### ② 真正可用的开场白在 `alternate_greetings`

抽 3 张卡共 38 条备用开场白：**含广告 0 条**，中位长度 1126~2310 字，内容质量正常（例：汴京残梦录第一条 2310 字，是正经的靖康二年开场）。

### ③ 40% 的卡，正文根本不在 `description` 里

- 931 张（28.5%）`description` **完全为空**；
- 1291 张（**39.5%**）满足「`character_book` 正文 > 4000 字 且 `description` < 800 字」——正文全在世界书条目里。

典型：

| 卡 | description | 世界书 |
|---|---|---|
| 汴京残梦录 | 0 字 | 93,088 字 / 32 条 |
| 黑天鹅 | 2142 字 | 1,677,664 字 / 1516 条 |
| 宝可梦RPG—战斗面板 | 742 字 | 16,166 字 / 6 条 |
| 【角色生成器】看世界书《How to use》 | 233 字 | 14,535 字 / 28 条 |

---

## 3. 全库统计（3269 张）

| 维度 | 实测 | 对导入的含义 |
|---|---|---|
| `first_mes` = 206 字广告模板 | 3233（98.9%） | 必须过滤，否则导入的「文风锚点」全是广告 |
| `first_mes` 含 deepseektavern.com | 3269（100%） | 用 `includes()` 判断即可 |
| `description` 为空 | 931（28.5%） | 不能当主要来源 |
| 正文活在 `character_book` | 1291（39.5%） | 导入对象是**世界书**，不是字段 |
| v3 卡 | 1954（59.8%） | `ccv3` 必读 |
| `group_only_greetings` 非空 | 0 | 可忽略 |
| `extensions.depth_prompt.prompt` 非空 | 132（4.0%） | 注入深度信息，插件格式无处安放 |
| 世界书条目总数 | 57,388（均 17.6 / 卡） | 远超 `LORE_MAX_ENTRIES=12` |
| 其中**有 keys** | 38,939（67.9%） | 32% 无触发词 |
| 其中**常驻（constant）** | 23,037（40.1%） | 无 keys 的条目应按 constant 处理 |
| 世界书正文合计 | **8548.6 万字** | 单卡最大 167 万字 |

---

## 4. 建议的映射规则（供实现者取舍）

### 4.1 字段 → 本插件 `CHARACTER_FIELDS`

| 卡字段 | 建议去向 | 说明 |
|---|---|---|
| `name` | `name` | 直接映射 |
| `description` | `personality`（前半） | 若为空则跳过 |
| `personality` | `personality`（追加） | 与 description 拼接，标注来源 |
| `scenario` | `world`（会话世界设定的补充） | 通常短（60~100 字） |
| `first_mes` | **丢弃并过滤** | 含 `deepseektavern.com` → 不用 |
| `alternate_greetings[0..n]` | `first_mes`（取第一条非广告的） | **真正的文风锚点**；其余可存文件备查 |
| `mes_example` | `mes_example` | 直接映射（广告污染较少） |
| `system_prompt` / `post_history_instructions` | 不映射，或转成世界书的 constant 条目 | 会覆盖用户全局提示词，慎用 |
| `character_book.entries[]` | **世界书条目**（主战场） | 见 4.2 |
| `extensions.depth_prompt` | 暂丢弃 + 注明 | 需要插件格式支持 depth 才能保真 |
| `speech` / `behavior` / `relations` | **卡里没有** | 必须由 agent 读正文后自行提炼，别假装映射成功 |

### 4.2 `character_book.entries[]` → `rp-worldbook.md`

目标格式（`parseLoreMarkdown` 已支持）：

```markdown
## 条目名
<!-- keys: 触发词1、触发词2 | constant | order: 100 -->
条目正文……
```

转换规则：

1. **有 `keys`** → 写进 `keys:`（用 `、` 分隔）。
2. **无 `keys`** → ⚠️ 关键坑：`parseLoreMarkdown` 里「无 keys 且无 constant」的条目**永远不触发**。这类条目（本库 32%）必须补 `constant`，否则等于导入了一堆死条目。
3. **`constant: true`** → 加 `constant` 标记。
4. **`order`** → 有 `insertion_order` 时写入 `order:`（降序优先）。
5. **`enabled: false`** → 建议跳过或写成注释，别导成生效条目。
6. **`position: before_char/after_char` + `extensions.depth`** → 当前插件格式无对应字段。两个选择：
   - 丢弃并在文档里注明（最简单）；
   - 在 `<!-- -->` 里加 `depth: N` / `position: xxx`，**同时改 `parseLoreMarkdown`** 才能生效。
7. **体量控制**：按「constant 优先 → 内容长度降序」取前 N 条（N 可配，建议 20~50），其余写独立文件让 agent 按需 `read`。单卡 167 万字不可能全量入世界书。

### 4.3 建议的返回策略（上下文友好）

- 工具默认返回**截断摘要**（头尾保留 + 标注省略字数），并给出**绝对路径**；
- 要全文就让 agent 用自带 `read` 工具读 `export` 出来的文件 —— 而不是把 167 万字塞进工具输出；
- `export` 产出：`<卡名>.json`（ST 兼容结构，agent 可直接 read）+ `<卡名>.worldbook.md`（格式同 4.2）。

---

## 5. 已知坑清单

1. **只读 `chara`** → 漏 60% 的 v3 卡。
2. **`iTXt` 忽略压缩标志** → 压缩块解出乱码。
3. **直接映射 `first_mes`** → 导入广告。
4. **无 keys 的条目不补 constant** → 导入死条目。
5. **全量导世界书** → `rp-worldbook.md` 几百万字，每轮扫描失控。
6. **路径安全**：卡名/分类名含中文、`！`、空格、`【】`；必须 `resolve` 后校验仍在卡库根目录内（防 `../`）。本地库还有 `（解压密码Wait）` 之类目录，其中是压缩包，应跳过。
7. **体量控制**：卡库 2.97GB / 3463 文件；单张卡最大 8.2MB（黑天鹅），解析后 JSON 可达数十 MB —— 解析结果要缓存（按 mtime），别每次调用重解。
8. **本卡库 100% 是第三方搬运**，成人向分类占多数，授权不明 —— 工具面向本地只读使用，不要做二次分发功能。

---

## 6. 现有资产

| 路径 | 内容 |
|---|---|
| `D:\Story\sillytavernassets\cards\<32 分类>\` | 3463 个文件（3273 PNG / 129 JSON / 57 TXT） |
| `D:\Story\_import\_index.json` | 3269 条完整索引（含字段字数、世界书条目数、标签、创作者） |
| `D:\Story\_import\_cards-index.json` | 744KB 精简索引（插件侧用） |
| `D:\Code\dsh\rp-tools-plugin\lib\card-index.js` | 344KB，随插件分发的索引（`CARD_INDEX` / `CARD_CATEGORIES`） |
| `D:\Story\_import\audit_cards.py` | 扫描 PNG → 生成上面两个索引（可重跑） |
| `D:\Story\_import\gen_card_index.mjs` | 精简索引 → `lib/card-index.js` |
| `D:\Story\_import\download_cards.py` | 断点续传下载器（8 线程 raw.githubusercontent） |
| `D:\Code\dsh\.tmp-cardprobe\decode-test.mjs` | 分类抽查 |
| `D:\Code\dsh\.tmp-cardprobe\inspect-v3.mjs` | 单卡结构透视 |
| `D:\Code\dsh\.tmp-cardprobe\library-stats.mjs` | 全库统计（本文档第 3 节的数据源） |

> `decode-test.mjs` 里「插图卡」那条用例的断言写错了（抽到的那张实际带 v3 卡数据），不是解码失败。
