# dsh-rp-tools

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）用的 **跑团 / DM 工具插件**：
**中立随机裁决**（`rp_random`）+ **本地 ComfyUI 配图**（场景、NPC 立绘、道具线索、氛围图）+ **按会话隔离的战役配置**（世界设定 / 角色卡 / 随机表 / 风格偏好）。

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
| 🌍 **会话隔离** | 世界设定 / 角色卡 / 随机表 / 提示词前缀 / 会话默认风格**按会话独立**，互不干扰；真正全局的只有风格库、ComfyUI 地址、全局负面词、全局默认风格 |
| 🎬 **整幕批量** | `rp_scenes`：吃 `scenes[].panels[]` 结构（含每格 positive/seed/宽高），一次出一整幕，单格失败不中断 |
| 🎲 **随机表** | `rp_table`：遭遇表 / 掉落表 / 情绪表…… 定义（表名 + 骰式 + 条目）、掷表、`count`/`seed`；面板上也能掷 |
| 🖥 **两处界面** | 设置页「RP工具」（全局配置 + 风格库 + 工具清单与参数说明）；DM 会话头部的「🎲 RP」按钮（浮层面板：世界 / 角色卡 / 随机表 / 本会话生图配置） |
| 🔒 **只进 DM 会话** | RP 工具**只在 `dm` 预设作用域注册**，其它预设的会话既看不到工具、也没有任何 RP 界面 |

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

8 个工具，全部以 `rp_` 开头。设置页「RP工具 → 工具列表」会实时展示同款清单（含每个参数的说明）。

| 工具 | 作用 | 主要参数 |
|---|---|---|
| `rp_random` | 中立随机裁决（**全局注册**，任何会话可用） | `kind?` `dice?` `choices?` `weights?` `min?` `max?` `count?` `seed?` |
| `rp_styles` | 列出风格（触发词 / CFG / 步数 / 尺寸预设） | — |
| `rp_illustrate` | 按风格生成一张图 | `prompt`* `style?` `seed?` `aspect?` `width?` `height?` |
| `rp_character` | 角色卡增删查 + 出立绘 | `action`* `name?` `appearance?` `portrait?` `style?` |
| `rp_session` | 本会话设置（世界 / 前缀 / 会话默认风格 / 风格备注 / 战役名） | `action`* `world?` `prompt_prefix?` `default_style?` `style_notes?` `campaign_name?` |
| `rp_scenes` | 按场景文件逐格批量出图 | `scenesFile`* `sceneId?` `style?` `limit?` |
| `rp_config` | **全局**配置（负面词 / 全局默认风格 / ComfyUI 地址 / 单个风格的触发词·步数·CFG） | `action`* `negative?` `default_style?` `base_url?` `style_key?` `trigger?` `steps?` `cfg?` |
| `rp_table` | 随机表定义与掷表 | `action`* `name?` `dice?` `entries?` `count?` `seed?` |

\* ＝ 必填。

---

## 数据与配置

```
~/.dsh/data/dsh-rp-tools/
├── styles.json                 全局：风格库 + 全局负面词 + ComfyUI 地址 + 全局默认风格
├── sessions/<sessionId>.json   会话级：世界设定 / 角色卡 / 随机表 / 前缀 / 会话默认风格
├── dm-sessions.json            DM 会话登记表（界面据此决定是否显示 RP 入口）
└── _agent-probe.json           诊断用：agent/created 事件里可读到的字段快照
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
      - rp_random
      - rp_styles
      - rp_illustrate
      - rp_character
      - rp_scenes
      - rp_session
      - rp_config
      - rp_table
      - render_ui
      - validate_dsh_ui
```

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
│   ├── apply(ctx)              全局：注册 rp_random + 全部 HTTP 路由；监听 agent/created 写诊断快照
│   ├── registerRpTools(ctx)    DM 作用域：注册另外 7 个 rp_ 工具（execute 包一层：调用即登记该会话为 DM）
│   ├── 生图链路                 组装 API 工作流 → ComfyUI POST /prompt → 轮询 /history → 同源媒体 URL
│   └── 配置层                  styles.json（全局） / sessions/<id>.json（会话）
├── client/client.js    客户端半侧（plain JS + React.createElement，无构建）
│   ├── settings.section「RP工具」            全局配置 + 风格库 + 工具清单
│   └── conversation.session.header.actions  仅 DM 会话渲染的「🎲 RP」按钮 + 浮层面板
├── preset/rp-bridge.mjs    dm 预设作用域桥接插件（副本，供安装参考）
├── cordis.patch.yml        bundle 补丁层
└── docs/STATUS.md          开发状态、验证记录、已知问题、路线图
```

**HTTP 路由**（全部同源保护，`Origin` 必须等于 `Host`）：

| 路由 | 方法 | 用途 |
|---|---|---|
| `/rp-tools/state` | GET | 全局配置 + 风格摘要（同时学习浏览器 origin，用于拼媒体 URL） |
| `/rp-tools/config` | POST | 写全局配置（含 `negative` / `baseUrl` / 风格字段） |
| `/rp-tools/reset` | POST | 恢复默认全局配置 |
| `/rp-tools/check` | GET | ComfyUI 连通性（版本 / GPU / 显存） |
| `/rp-tools/session` | GET/POST | 读写某个会话的 RP 配置（角色卡 / 世界 / 随机表） |
| `/rp-tools/dm-mark` | POST | 登记某会话为 DM 会话 |
| `/rp-tools/tools` | GET | 工具清单 + 参数说明（设置页用） |
| `/rp-tools/roll` | POST | 掷随机表（面板用） |
| `/rp-tools/media` | GET | **同源媒体代理**：把 ComfyUI `/view` 转成同源，图片才能在聊天里渲染 |
| `/rp-tools/preview` | POST | 试出一张（设置页 / 面板用，可带 sessionId） |

---

## 开发

```bash
node --check lib/index.js && node --check client/client.js      # 语法检查
```

改完源码要**同步到 profile**（`file:` 依赖是安装期拷贝，不会自动跟随），然后重启 `dsh web`：

```powershell
$dst = "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-rp-tools"
Copy-Item lib/index.js    "$dst\lib\index.js"    -Force
Copy-Item client/client.js "$dst\client\client.js" -Force
```

当前开发状态、验证记录、已知问题与路线图见 **[docs/STATUS.md](docs/STATUS.md)**。

## License

MIT
