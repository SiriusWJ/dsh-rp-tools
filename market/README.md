# market/index.json — dsh 0.2.1+ 插件市场索引

这是 `dsh-rp-tools` 的 format 1 市场索引；把 `index.json` 放到任意 https 静态地址，就能被 dsh 的插件市场识别。

- **dsh 内置「发现」**：插件 → 实验性插件旁的「更多」→ 打开「自定义插件市场」→ 发现 → 添加索引源 → 粘贴索引 URL。
- **GitHub raw（本仓库 main 分支，提交并推送后可用）**：`https://raw.githubusercontent.com/SiriusWJ/dsh-rp-tools/main/market/index.json`
- **GitHub Pages**（若仓库开启 Pages）：`https://siriuswj.github.io/dsh-rp-tools/market/index.json`
- 索引 URL 必须是 `http:`/`https:`，不能带用户名、密码或 `#` 片段；建议用 https，并确认该 URL 直接返回 2xx、不重定向。
- 版本条目固定到 commit SHA；发新版本后要同步 `versions[]`（`version` / `publishTimestamp` / `commit`），否则市场装到的还是旧提交。
- `engines.dsh` 暂未写入：待 dsh 0.2.1 兼容性审计确认后由 Lead 决定是否补上（索引里的值应与包自身 `engines.dsh` 一致）。
- 校验：`node market/validate.mjs --self-test`（零依赖；含与 git 仓库 / package.json 的交叉检查）。
