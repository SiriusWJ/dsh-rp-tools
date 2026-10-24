# market/index.json — dsh 0.2.1+ 插件市场索引

这是 `dsh-rp-tools` 的 format 1 市场索引；把 `index.json` 放到任意 https 静态地址，就能被 dsh 的插件市场识别。

- **dsh 内置「发现」**：插件 → 实验性插件旁的「更多」→ 打开「自定义插件市场」→ 发现 → 添加索引源 → 粘贴索引 URL。
- **jsDelivr（推荐，国内可直连）**：`https://cdn.jsdelivr.net/gh/SiriusWJ/dsh-rp-tools@main/market/index.json`
- **GitHub raw**：`https://raw.githubusercontent.com/SiriusWJ/dsh-rp-tools/main/market/index.json`
  （部分网络（含本机）访问 raw 域名会超时，这时用上面的 jsDelivr 链接）
- **GitHub Pages**（若仓库开启 Pages）：`https://siriuswj.github.io/dsh-rp-tools/market/index.json`
- 索引 URL 必须是 `http:`/`https:`，不能带用户名、密码或 `#` 片段；建议用 https，并确认该 URL 直接返回 2xx、不重定向（jsDelivr 实测 200）。
- 版本条目固定到 commit SHA；发新版本后要同步 `versions[]`（`version` / `publishTimestamp` / `commit`），否则市场装到的还是旧提交。
- `engines.dsh` 与包自身一致（`^0.2.1-rc.2`）；改包里的 engines 时记得同步这里。
- 校验：`node market/validate.mjs --self-test`（零依赖；含与 git 仓库 / package.json 的交叉检查）。
