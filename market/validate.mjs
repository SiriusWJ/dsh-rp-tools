#!/usr/bin/env node
// dsh 插件市场索引（format 1）校验脚本 —— 零依赖。
//
// 用法：
//   node market/validate.mjs             # 校验 market/index.json
//   node market/validate.mjs 路径.json    # 校验指定文件
//   node market/validate.mjs --self-test  # 额外跑一组「坏样本」自测，证明校验会拒收
//
// 规则来源：dsh 自带的 @deepseek-ai/dsh-plugin-market-index（0.2.1-rc.2）的
// parseMarketIndex()；本脚本逐条镜像它的校验规则（含精确 SemVer、40 位小写 hex
// commit、Unix 秒 publishTimestamp、LocalizedText 必须含 en 等），因此不依赖 npm 包。
// 另外做仓库一致性交叉检查：commit 是否存在、该 commit 的 package.json version 是否
// 等于条目 version、committer 时间是否等于 publishTimestamp、tag 是否指向该 commit。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_INDEX_URL = 'https://cdn.jsdelivr.net/gh/SiriusWJ/dsh-rp-tools@main/market/index.json';

// ---------- 与 dsh-plugin-market-index 完全一致的常量 ----------
const LANGUAGE_ID = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/u;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;
const PACKAGE_NAME_MAX_LENGTH = 214;
const NUMERIC = '(?:0|[1-9]\\d*)';
const PRERELEASE_PART = `(?:${NUMERIC}|\\d*[a-zA-Z-][0-9a-zA-Z-]*)`;
const SEMVER = new RegExp(
  `^${NUMERIC}\\.${NUMERIC}\\.${NUMERIC}(?:-${PRERELEASE_PART}(?:\\.${PRERELEASE_PART})*)?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$`,
  'u',
);
const COMMIT = /^[0-9a-f]{40}$/u;
const PATH_SEGMENT = /^[A-Za-z0-9._@+-]+$/u;
const DATA_ICON = /^data:(?:image\/svg\+xml|image\/png|image\/jpeg|image\/webp);base64,([A-Za-z0-9+/]*={0,2})$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const MAX_INLINE_ICON_BYTES = 32 * 1024;
const MAX_PUBLISH_TIMESTAMP = 1e11;

class MarketIndexError extends Error {
  constructor(jsonPath, reason) {
    super(`${jsonPath} ${reason}`);
    this.path = jsonPath;
    this.reason = reason;
    this.name = 'MarketIndexError';
  }
}

function fail(jsonPath, reason) {
  throw new MarketIndexError(jsonPath, reason);
}

function objectAt(value, jsonPath) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(jsonPath, '必须是对象');
  return value;
}

function stringAt(value, jsonPath) {
  if (typeof value !== 'string' || value.trim() === '') fail(jsonPath, '必须是非空字符串');
  return value;
}

function optional(object, key, jsonPath, read) {
  return Object.hasOwn(object, key) ? read(object[key], `${jsonPath}.${key}`) : undefined;
}

function own(record, key, value) {
  Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true });
}

// ---------- LocalizedText：字符串，或 { en: ... } 对象（必须含 en） ----------
function localizedText(value, jsonPath) {
  if (typeof value === 'string') return stringAt(value, jsonPath);
  const object = objectAt(value, jsonPath);
  const text = {};
  for (const [language, member] of Object.entries(object)) {
    if (!LANGUAGE_ID.test(language)) fail(`${jsonPath}.${language}`, '必须以小写语言 id 为键');
    own(text, language, stringAt(member, `${jsonPath}.${language}`));
  }
  if (!Object.hasOwn(text, 'en')) fail(jsonPath, '必须包含 en');
  return text;
}

// ---------- metadata（分类 / 标签 / 排序键） ----------
function declarations(value, jsonPath, read) {
  const result = {};
  for (const [id, member] of Object.entries(objectAt(value, jsonPath))) {
    if (id === '') fail(jsonPath, '不能声明空 id');
    own(result, id, read(objectAt(member, `${jsonPath}.${id}`), `${jsonPath}.${id}`));
  }
  return result;
}

function declaration(object, jsonPath) {
  return { title: localizedText(object.title, `${jsonPath}.title`) };
}

function sortKeyDeclaration(object, jsonPath) {
  if (object.order !== 'asc' && object.order !== 'desc') fail(`${jsonPath}.order`, '必须是 "asc" 或 "desc"');
  return { title: localizedText(object.title, `${jsonPath}.title`), order: object.order };
}

function indexMetadata(value, jsonPath) {
  const object = value === undefined ? {} : objectAt(value, jsonPath);
  return {
    categories: optional(object, 'categories', jsonPath, (m, at) => declarations(m, at, declaration)) ?? {},
    labels: optional(object, 'labels', jsonPath, (m, at) => declarations(m, at, declaration)) ?? {},
    sortKeys: optional(object, 'sortKeys', jsonPath, (m, at) => declarations(m, at, sortKeyDeclaration)) ?? {},
  };
}

function declaredId(value, jsonPath, declared) {
  const id = stringAt(value, jsonPath);
  if (!Object.hasOwn(declared, id)) fail(jsonPath, `引用了未声明的 id ${JSON.stringify(id)}`);
  return id;
}

function pluginMetadata(value, jsonPath, index) {
  const object = value === undefined ? {} : objectAt(value, jsonPath);
  const category = optional(object, 'category', jsonPath, (m, at) => declaredId(m, at, index.categories));
  const keywords = optional(object, 'keywords', jsonPath, (m, at) => {
    if (!Array.isArray(m)) fail(at, '必须是数组');
    return m.map((keyword, position) => {
      if (typeof keyword !== 'string') fail(`${at}[${position}]`, '必须是字符串');
      return keyword;
    });
  }) ?? [];
  const labels = optional(object, 'labels', jsonPath, (m, at) => {
    if (!Array.isArray(m)) fail(at, '必须是数组');
    const ids = m.map((label, position) => declaredId(label, `${at}[${position}]`, index.labels));
    if (new Set(ids).size !== ids.length) fail(at, '不能重复声明标签');
    return ids;
  }) ?? [];
  const sortKeys = optional(object, 'sortKeys', jsonPath, (m, at) => {
    const values = {};
    for (const [id, sortValue] of Object.entries(objectAt(m, at))) {
      declaredId(id, `${at}.${id}`, index.sortKeys);
      if (typeof sortValue !== 'number' || !Number.isFinite(sortValue)) fail(`${at}.${id}`, '必须是有限数字');
      own(values, id, sortValue);
    }
    return values;
  }) ?? {};
  return { ...(category === undefined ? {} : { category }), keywords, labels, sortKeys };
}

// ---------- URL 规则 ----------
function httpUrl(value, jsonPath, protocols) {
  const text = stringAt(value, jsonPath);
  let url;
  try {
    url = new URL(text);
  } catch {
    fail(jsonPath, '必须是绝对 URL');
  }
  if (!protocols.includes(url.protocol)) fail(jsonPath, `必须使用 ${protocols.join(' 或 ')}`);
  if (url.username !== '' || url.password !== '') fail(jsonPath, '不能包含凭据');
  if (url.href.includes('?') || url.href.includes('#')) fail(jsonPath, '不能包含查询串或片段');
  return url;
}

function homepageUrl(value, jsonPath) {
  const text = stringAt(value, jsonPath);
  if (!URL.canParse(text)) fail(jsonPath, '必须是绝对 URL');
  const url = new URL(text);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') fail(jsonPath, '必须使用 https: 或 http:');
  return url.href;
}

function gitUrl(value, jsonPath) {
  const url = httpUrl(value, jsonPath, ['https:']);
  if (url.href !== value) fail(jsonPath, '必须是规范化 URL');
  if (!/^(?:\/[^/]+){2,}$/u.test(url.pathname)) fail(jsonPath, '必须指向至少两段路径的仓库');
  if (/\.(?:tgz|tar\.gz)$/iu.test(url.pathname)) fail(jsonPath, '必须指向仓库，不能是 tarball');
  return url.href;
}

function packagePath(value, jsonPath) {
  const text = stringAt(value, jsonPath);
  if (text.split('/').some((segment) => segment === '.' || segment === '..' || !PATH_SEGMENT.test(segment))) {
    fail(jsonPath, '必须是只含字母、数字与 ._@+- 段的相对目录，且不能有 . 或 ..');
  }
  return text;
}

function repository(value, jsonPath) {
  const object = objectAt(value, jsonPath);
  const url = httpUrl(object.url, `${jsonPath}.url`, ['https:', 'http:']).href;
  const directory = optional(object, 'directory', jsonPath, packagePath);
  return { url, ...(directory === undefined ? {} : { directory }) };
}

function source(value, jsonPath) {
  const object = objectAt(value, jsonPath);
  switch (object.type) {
    case 'npm': {
      const registry = optional(object, 'registry', jsonPath, (m, at) => httpUrl(m, at, ['https:', 'http:']).href);
      return { type: 'npm', ...(registry === undefined ? {} : { registry }) };
    }
    case 'git': {
      const commit = stringAt(object.commit, `${jsonPath}.commit`);
      if (!COMMIT.test(commit)) fail(`${jsonPath}.commit`, '必须是小写 40 位十六进制 commit SHA');
      const dir = optional(object, 'path', jsonPath, packagePath);
      return { type: 'git', url: gitUrl(object.url, `${jsonPath}.url`), commit, ...(dir === undefined ? {} : { path: dir }) };
    }
    default:
      return fail(`${jsonPath}.type`, '必须是 "npm" 或 "git"');
  }
}

// 官方用 semver.validRange 严格校验；这里零依赖只做形状校验，避免明显垃圾串。
const RANGE_TOKEN = /^(?:[\^~<>=]*)?(?:[*xX]|\d+)(?:\.(?:[*xX]|\d+)){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
function engines(value, jsonPath) {
  const dsh = optional(objectAt(value, jsonPath), 'dsh', jsonPath, (member, at) => {
    const range = stringAt(member, at);
    if (range.startsWith('workspace:')) fail(at, '不能是 workspace: 范围');
    for (const token of range.trim().split(/\s+/u)) {
      if (token !== '||' && token !== '-' && !RANGE_TOKEN.test(token)) fail(at, '必须是 SemVer 范围（形状近似校验）');
    }
    return range;
  });
  return dsh === undefined ? {} : { dsh };
}

function icon(value, jsonPath, indexUrl) {
  const text = stringAt(value, jsonPath);
  if (text.startsWith('data:')) {
    const payload = DATA_ICON.exec(text)?.[1];
    if (payload === undefined || payload === '' || !BASE64.test(payload)) {
      fail(jsonPath, '必须是 base64 的 SVG / PNG / JPEG / WebP data URL');
    }
    const decoded = (payload.length / 4) * 3 - (payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0);
    if (decoded > 32768) fail(jsonPath, `解码后不能超过 ${MAX_INLINE_ICON_BYTES / 1024} KiB`);
    return text;
  }
  let resolved;
  try {
    resolved = new URL(text, indexUrl);
  } catch {
    fail(jsonPath, '必须是 URL 引用');
  }
  if (resolved.protocol !== 'https:' && (resolved.origin === 'null' || resolved.origin !== new URL(indexUrl).origin)) {
    fail(jsonPath, '必须解析到 https 或索引所在源');
  }
  return resolved.href;
}

// ---------- 版本 / 插件 / 索引 ----------
function marketVersion(value, jsonPath) {
  const object = objectAt(value, jsonPath);
  const version = stringAt(object.version, `${jsonPath}.version`);
  if (!SEMVER.test(version)) fail(`${jsonPath}.version`, '必须是精确 SemVer 版本');
  const publishTimestamp = object.publishTimestamp;
  if (typeof publishTimestamp !== 'number' || !Number.isInteger(publishTimestamp) || publishTimestamp < 0 || publishTimestamp >= MAX_PUBLISH_TIMESTAMP) {
    fail(`${jsonPath}.publishTimestamp`, '必须是 [0, 10^11) 内的整数 Unix 秒');
  }
  return {
    version,
    publishTimestamp,
    source: source(object.source, `${jsonPath}.source`),
    engines: optional(object, 'engines', jsonPath, engines) ?? {},
  };
}

function compareSemverDesc(left, right) {
  const parse = (text) => {
    const [main, rest] = text.split('+')[0].split('-');
    const core = main.split('.').map(Number);
    return { core, pre: rest === undefined ? [] : rest.split('.') };
  };
  const a = parse(left);
  const b = parse(right);
  for (let i = 0; i < 3; i += 1) {
    if (a.core[i] !== b.core[i]) return b.core[i] - a.core[i];
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return -1;
  if (b.pre.length === 0) return 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i += 1) {
    if (a.pre[i] === undefined) return 1;
    if (b.pre[i] === undefined) return -1;
    const an = /^\d+$/u.test(a.pre[i]) ? Number(a.pre[i]) : null;
    const bn = /^\d+$/u.test(b.pre[i]) ? Number(b.pre[i]) : null;
    if (an !== null && bn !== null && an !== bn) return bn - an;
    if (an === null && bn !== null) return 1;
    if (an !== null && bn === null) return -1;
    if (a.pre[i] !== b.pre[i]) return a.pre[i] < b.pre[i] ? 1 : -1;
  }
  return 0;
}

function versions(value, jsonPath) {
  if (!Array.isArray(value) || value.length === 0) fail(jsonPath, '必须是非空数组');
  const seen = new Set();
  return value
    .map((member, position) => {
      const at = `${jsonPath}[${position}]`;
      const entry = marketVersion(member, at);
      if (seen.has(entry.version)) fail(`${at}.version`, `与 ${entry.version} 重复`);
      seen.add(entry.version);
      return entry;
    })
    .sort((left, right) => compareSemverDesc(left.version, right.version));
}

function plugin(value, jsonPath, index, indexUrl) {
  const object = objectAt(value, jsonPath);
  const name = stringAt(object.name, `${jsonPath}.name`);
  if (name.length > PACKAGE_NAME_MAX_LENGTH || !PACKAGE_NAME.test(name)) fail(`${jsonPath}.name`, '必须是合法 npm 包名');
  const title = optional(object, 'title', jsonPath, localizedText);
  const description = optional(object, 'description', jsonPath, localizedText);
  const iconUrl = optional(object, 'icon', jsonPath, (m, at) => icon(m, at, indexUrl));
  const author = optional(object, 'author', jsonPath, stringAt);
  const homepage = optional(object, 'homepage', jsonPath, homepageUrl);
  const repo = optional(object, 'repository', jsonPath, repository);
  return {
    name,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(iconUrl === undefined ? {} : { icon: iconUrl }),
    ...(author === undefined ? {} : { author }),
    ...(homepage === undefined ? {} : { homepage }),
    ...(repo === undefined ? {} : { repository: repo }),
    metadata: pluginMetadata(object.metadata, `${jsonPath}.metadata`, index),
    versions: versions(object.versions, `${jsonPath}.versions`),
  };
}

/** 镜像 @deepseek-ai/dsh-plugin-market-index 的 parseMarketIndex()：第一条违规即抛出。 */
function parseMarketIndex(value, indexUrl) {
  if (!URL.canParse(indexUrl)) fail('$', `索引 URL ${JSON.stringify(indexUrl)} 必须是绝对 URL`);
  const base = new URL(indexUrl);
  const object = objectAt(value, '$');
  if (object.format !== 1) fail('$.format', '必须是 1');
  const metadata = indexMetadata(object.metadata, '$.metadata');
  if (!Array.isArray(object.plugins)) fail('$.plugins', '必须是数组');
  const names = new Set();
  const plugins = object.plugins.map((entry, position) => {
    const parsed = plugin(entry, `$.plugins[${position}]`, metadata, base);
    if (names.has(parsed.name)) fail(`$.plugins[${position}].name`, `与 ${parsed.name} 重复`);
    names.add(parsed.name);
    return parsed;
  });
  const title = localizedText(object.title, '$.title');
  const description = optional(object, 'description', '$', localizedText);
  return {
    format: 1,
    title,
    ...(description === undefined ? {} : { description }),
    metadata,
    plugins,
  };
}

// ---------- 与 dsh 一致：git 版本的安装 spec ----------
function marketInstallTarget(name, version) {
  const from = version.source;
  if (from.type === 'npm') return { spec: `${name}@${version.version}`, ...(from.registry === undefined ? {} : { registry: from.registry }) };
  return {
    spec: `git+${from.url.endsWith('.git') ? from.url : `${from.url}.git`}#${from.commit}${from.path === undefined ? '' : `&path:/${from.path}`}`,
  };
}

// ---------- 输出辅助 ----------
let passed = 0;
let failed = 0;
function ok(label, detail = '') {
  passed += 1;
  console.log(`  [PASS] ${label}${detail ? `  ${detail}` : ''}`);
}
function bad(label, detail = '') {
  failed += 1;
  console.log(`  [FAIL] ${label}${detail ? `  ${detail}` : ''}`);
}
function warn(label, detail = '') {
  console.log(`  [WARN] ${label}${detail ? `  ${detail}` : ''}`);
}

function printIndexSummary(index) {
  const title = typeof index.title === 'string' ? index.title : index.title.en;
  console.log(`  市场标题：${title}${index.description ? `（${typeof index.description === 'string' ? index.description : index.description.en}）` : ''}`);
  for (const plugin of index.plugins) {
    console.log(`  插件：${plugin.name}（${plugin.versions.length} 个版本）`);
    for (const version of plugin.versions) {
      const { spec } = marketInstallTarget(plugin.name, version);
      console.log(`    - ${version.version}  publishTimestamp=${version.publishTimestamp}`);
      console.log(`      source=${JSON.stringify(version.source)}`);
      console.log(`      install=${spec}`);
      if (version.engines.dsh) console.log(`      engines.dsh=${version.engines.dsh}`);
    }
  }
}

// ---------- 仓库一致性交叉检查 ----------
function git(repoRoot, args) {
  return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function normalizeRepoUrl(url) {
  let text = String(url).trim();
  text = text.replace(/^git\+/u, '');
  text = text.replace(/\.git$/u, '');
  text = text.replace(/\/+$/u, '');
  return text;
}

function checkAgainstRepo(index, repoRoot) {
  let gitAvailable = true;
  try {
    git(repoRoot, ['rev-parse', '--git-dir']);
  } catch {
    gitAvailable = false;
  }
  if (!gitAvailable) {
    warn('跨仓库一致性检查', '跳过（当前目录不是 git 仓库或找不到 git）');
    return;
  }

  let remoteUrl = null;
  try {
    remoteUrl = normalizeRepoUrl(git(repoRoot, ['remote', 'get-url', 'origin']));
  } catch {
    warn('git remote origin', '未配置，跳过 URL 对比');
  }

  // 工作区 package.json（仅告警：可能正在被 Lead 改动）
  let worktreeManifest = null;
  try {
    worktreeManifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  } catch {
    warn('读取工作区 package.json', '跳过');
  }

  for (const plugin of index.plugins) {
    for (const version of plugin.versions) {
      const label = `${plugin.name}@${version.version}`;
      if (version.source.type === 'npm') {
        ok(`${label} source=npm`, `install=${plugin.name}@${version.version}`);
        continue;
      }
      const { url, commit } = version.source;

      // 1) commit 存在且是提交
      let resolved = null;
      try {
        resolved = git(repoRoot, ['rev-parse', '--verify', `${commit}^{commit}`]);
        if (resolved === commit) ok(`${label} commit`, `${commit.slice(0, 12)}… 存在`);
        else bad(`${label} commit`, `解析为 ${resolved}，与索引不一致`);
      } catch {
        bad(`${label} commit`, `${commit} 在本地仓库不存在`);
        continue;
      }

      // 2) 该 commit 的 package.json（name / version）
      let manifest = null;
      try {
        manifest = JSON.parse(git(repoRoot, ['show', `${commit}:package.json`]));
        if (manifest.name === plugin.name) ok(`${label} 包名`, `commit 内 package.json name=${manifest.name}`);
        else bad(`${label} 包名`, `commit 内 name=${manifest.name}，索引为 ${plugin.name}`);
        if (manifest.version === version.version) ok(`${label} 版本`, `commit 内 package.json version=${manifest.version}`);
        else bad(`${label} 版本`, `commit 内 version=${manifest.version}，索引为 ${version.version}`);
      } catch (error) {
        bad(`${label} package.json`, `无法读取该 commit 的 package.json：${error.message.split('\n')[0]}`);
      }

      // 3) publishTimestamp == 该 commit 的 committer 时间
      try {
        const ct = Number(git(repoRoot, ['log', '-1', '--format=%ct', commit]));
        const cIso = git(repoRoot, ['log', '-1', '--format=%cI', commit]);
        if (ct === version.publishTimestamp) ok(`${label} publishTimestamp`, `${ct}（${cIso}）`);
        else bad(`${label} publishTimestamp`, `commit 时间 ${ct}，索引为 ${version.publishTimestamp}`);
      } catch (error) {
        bad(`${label} publishTimestamp`, `读取提交时间失败：${error.message.split('\n')[0]}`);
      }

      // 4) tag v<version> 若存在必须指向该 commit（tag 可选）
      try {
        const tagSha = git(repoRoot, ['rev-parse', '--verify', `refs/tags/v${version.version}^{commit}`]);
        if (tagSha === commit) ok(`${label} tag`, `v${version.version} → ${commit.slice(0, 12)}…`);
        else bad(`${label} tag`, `v${version.version} 指向 ${tagSha}，与索引 commit 不一致`);
      } catch {
        warn(`${label} tag`, `v${version.version} 不存在（tag 可选）`);
      }

      // 5) source URL 与仓库来源一致（package.json repository / git remote）
      const sourceUrl = normalizeRepoUrl(url);
      if (manifest?.repository?.url) {
        const manifestUrl = normalizeRepoUrl(manifest.repository.url);
        if (manifestUrl === sourceUrl) ok(`${label} source.url`, `与 package.json repository 一致`);
        else bad(`${label} source.url`, `package.json repository 为 ${manifestUrl}，索引为 ${sourceUrl}`);
      }
      if (remoteUrl) {
        if (remoteUrl === sourceUrl) ok(`${label} source.url`, `与 git remote origin 一致`);
        else warn(`${label} source.url`, `git remote origin 为 ${remoteUrl}，索引为 ${sourceUrl}`);
      }

      // 6) git url 至少两段路径 + 安装 spec
      const { spec } = marketInstallTarget(plugin.name, version);
      ok(`${label} 安装 spec`, spec);
    }

    if (worktreeManifest && worktreeManifest.name === plugin.name) {
      if (plugin.versions.some((v) => v.version === worktreeManifest.version)) {
        ok('工作区版本已收录', `package.json version=${worktreeManifest.version}`);
      } else {
        warn('工作区版本未收录', `package.json version=${worktreeManifest.version} 不在 versions[]（版本升级后需同步索引）`);
      }
    }
  }
}

// ---------- 自测：坏样本必须被拒收 ----------
function selfTest(doc, indexUrl) {
  console.log('\n自测：坏样本必须被拒收（镜像 dsh 官方规则）');
  const clone = () => structuredClone(doc);
  const cases = [
    ['format 不是 1', (d) => { d.format = 2; }, '$.format'],
    ['缺少 title', (d) => { delete d.title; }, '$.title'],
    ['title 对象缺 en', (d) => { d.title = { zh: '只有中文' }; }, '$.title'],
    ['缺少 plugins', (d) => { delete d.plugins; }, '$.plugins'],
    ['plugins 不是数组', (d) => { d.plugins = {}; }, '$.plugins'],
    ['插件名非法', (d) => { d.plugins[0].name = 'Bad Name'; }, '$.plugins[0].name'],
    ['versions 为空', (d) => { d.plugins[0].versions = []; }, '$.plugins[0].versions'],
    ['版本不是精确 SemVer', (d) => { d.plugins[0].versions[0].version = '1.15'; }, '$.plugins[0].versions[0].version'],
    ['publishTimestamp 是小数', (d) => { d.plugins[0].versions[0].publishTimestamp = 1.5; }, '$.plugins[0].versions[0].publishTimestamp'],
    ['publishTimestamp 是字符串', (d) => { d.plugins[0].versions[0].publishTimestamp = '1789646128'; }, '$.plugins[0].versions[0].publishTimestamp'],
    ['source.type 非法', (d) => { d.plugins[0].versions[0].source = { type: 'http', url: 'https://example.com/a/b' }; }, '$.plugins[0].versions[0].source.type'],
    ['git url 不是 https', (d) => { d.plugins[0].versions[0].source.url = 'http://github.com/SiriusWJ/dsh-rp-tools'; }, '$.plugins[0].versions[0].source.url'],
    ['commit 不是 40 位小写 hex', (d) => { d.plugins[0].versions[0].source.commit = '8628CEB'; }, '$.plugins[0].versions[0].source.commit'],
    ['重复版本', (d) => { d.plugins[0].versions.push(structuredClone(d.plugins[0].versions[0])); }, '$.plugins[0].versions[1].version'],
    ['homepage 不是 http(s)', (d) => { d.plugins[0].homepage = 'ftp://example.com/a'; }, '$.plugins[0].homepage'],
  ];
  let selfFailed = 0;
  for (const [label, mutate, expectedPath] of cases) {
    const candidate = clone();
    mutate(candidate);
    try {
      parseMarketIndex(candidate, indexUrl);
      console.log(`  [FAIL] ${label}：未被拒收`);
      selfFailed += 1;
    } catch (error) {
      if (error instanceof MarketIndexError && error.path === expectedPath) {
        console.log(`  [PASS] ${label} → 拒收于 ${error.path}：${error.reason}`);
      } else {
        console.log(`  [FAIL] ${label}：拒收路径/类型不符（${error.path ?? error.message}）`);
        selfFailed += 1;
      }
    }
  }
  if (selfFailed > 0) {
    failed += selfFailed;
    bad('自测', `${selfFailed}/${cases.length} 个坏样本未按预期拒收`);
  } else {
    ok('自测', `${cases.length}/${cases.length} 个坏样本全部按预期拒收`);
  }
}

// ---------- 主流程 ----------
function main() {
  const args = process.argv.slice(2);
  const wantSelfTest = args.includes('--self-test');
  const fileArg = args.find((argument) => !argument.startsWith('--'));
  const indexPath = path.resolve(fileArg ?? path.join(SCRIPT_DIR, 'index.json'));
  const indexUrl = DEFAULT_INDEX_URL;

  console.log('dsh 插件市场索引校验（format 1，规则镜像 @deepseek-ai/dsh-plugin-market-index）');
  console.log(`node ${process.version}`);
  console.log(`索引文件：${indexPath}`);
  if (!fs.existsSync(indexPath)) {
    bad('索引文件存在', `${indexPath} 不存在`);
    process.exitCode = 1;
    return;
  }
  const raw = fs.readFileSync(indexPath, 'utf8');
  console.log(`文件大小：${Buffer.byteLength(raw, 'utf8')} 字节\n`);
  console.log('[1] JSON 可解析');
  let doc;
  try {
    doc = JSON.parse(raw);
    ok('JSON 可解析');
  } catch (error) {
    bad('JSON 可解析', error.message);
    process.exitCode = 1;
    return;
  }

  console.log('\n[2] 结构校验（与 dsh 内置 parseMarketIndex 规则一致）');
  let index;
  try {
    index = parseMarketIndex(doc, indexUrl);
    ok('结构校验通过', 'format / title / plugins / versions / source 全部符合 format 1');
  } catch (error) {
    if (error instanceof MarketIndexError) bad('结构校验失败', `${error.path} ${error.reason}`);
    else bad('结构校验失败', error.stack ?? error.message);
    process.exitCode = 1;
    return;
  }
  console.log('\n[3] 解析后摘要');
  printIndexSummary(index);

  console.log('\n[4] 跨仓库一致性（commit / 版本 / 时间戳 / tag / source URL）');
  checkAgainstRepo(index, REPO_ROOT);

  if (wantSelfTest) selfTest(doc, indexUrl);

  console.log(`\n结果：${failed === 0 ? 'PASS' : 'FAIL'}（通过 ${passed} 项，失败 ${failed} 项）`);
  if (failed === 0) console.log(`索引 URL 形态：${indexUrl}`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main();
