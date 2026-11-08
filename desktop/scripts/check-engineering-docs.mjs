import {readFileSync, readdirSync, statSync, existsSync} from 'node:fs';
import {resolve, dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

/**
 * 文档机械检查：相对链接与锚点、过期术语、目录计数、缺陷 ID 唯一性、
 * 以及 docs/README.md 是否覆盖全部文档。
 * 只检查可机械验证的部分；事实正确性仍需对照源码与运行证据。
 */
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const docsRoot = join(repo, 'docs');
const failures = [];
const fail = (message) => failures.push(message);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.md')) out.push(full);
  }
  return out;
}

const docs = walk(docsRoot);
const rel = (file) => relative(repo, file).replaceAll('\\', '/');
const slug = (text) => text.trim().toLowerCase()
  .replace(/[`*_]/g, '')
  .replace(/[^\p{L}\p{N}\s-]/gu, '')
  .replace(/\s+/g, '-');

const anchorCache = new Map();
function anchorsOf(file) {
  if (!anchorCache.has(file)) {
    const set = new Set();
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const heading = /^#{1,6}\s+(.*)$/.exec(line);
      if (heading) set.add(slug(heading[1]));
    }
    anchorCache.set(file, set);
  }
  return anchorCache.get(file);
}

// 1. 相对链接与锚点
for (const file of docs) {
  const text = readFileSync(file, 'utf8');
  const link = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match;
  while ((match = link.exec(text))) {
    const raw = match[1];
    if (/^(https?:|mailto:)/.test(raw)) continue;
    if (raw.startsWith('#')) {
      if (!anchorsOf(file).has(slug(decodeURIComponent(raw.slice(1))))) fail(`${rel(file)}: 锚点不存在 ${raw}`);
      continue;
    }
    const [pathPart, anchor] = raw.split('#');
    const target = resolve(dirname(file), decodeURIComponent(pathPart));
    if (!existsSync(target)) {
      fail(`${rel(file)}: 链接目标不存在 ${raw}`);
      continue;
    }
    if (anchor && target.endsWith('.md') && !anchorsOf(target).has(slug(decodeURIComponent(anchor)))) {
      fail(`${rel(file)}: 锚点不存在 ${raw}`);
    }
  }
}

// 2. 过期术语与旧文件名
const stale = /两视图|材料\s*7\s*大类|25\s*子类|engineering-wholes-[1-7](?!\d)|meassurement\.md/;
for (const file of docs) {
  if (stale.test(readFileSync(file, 'utf8'))) fail(`${rel(file)}: 含过期术语或旧文件名`);
}

// 3. 目录计数与生成表
const catalog = JSON.parse(readFileSync(join(repo, 'desktop/src/engineering/catalog.json'), 'utf8'));
const catalogText = readFileSync(join(docsRoot, 'engineering/catalogs/README.md'), 'utf8');
const materials = catalog.categories.filter((row) => /^M\d+$/.test(row.code)).length;
const components = catalog.categories.filter((row) => /^C-/.test(row.code)).length;
if (!catalogText.includes(`材料 ${materials} 大类`) || !catalogText.includes(`${components} 子类`)) {
  fail('docs/engineering/catalogs/README.md: 目录计数与 catalog.json 不一致');
}

// 4. 缺陷/限制 ID 唯一
const issueText = readFileSync(join(docsRoot, 'open-issues.md'), 'utf8');
const ids = [...issueText.matchAll(/^\|\s*((?:O|L|M)-\d+)\s*\|/gm)].map((match) => match[1]);
const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
if (duplicateIds.length) fail(`docs/open-issues.md: 重复 ID ${[...new Set(duplicateIds)].join(', ')}`);

// 5. 文档首页覆盖全部文档
const hub = readFileSync(join(docsRoot, 'README.md'), 'utf8');
const hubTargets = new Set([...hub.matchAll(/\]\(([^)\s#]+)/g)]
  .map((match) => resolve(docsRoot, decodeURIComponent(match[1])))
  .filter((target) => target.endsWith('.md')));
for (const file of docs) {
  if (file === join(docsRoot, 'README.md')) continue;
  if (!hubTargets.has(file)) fail(`docs/README.md: 未收录 ${rel(file)}`);
}

// 6. 标题锚点唯一、表格列数一致、目录覆盖全部内容二级标题
const cellCount = (line) => {
  let count = 1;
  let escaped = false;
  for (const char of line.replace(/^\||\|$/g, '')) {
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (char === '|') count++;
  }
  return count;
};
for (const file of docs) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const seen = new Map();
  for (const line of lines) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (!heading) continue;
    const key = slug(heading[1]);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const [key, count] of seen) if (count > 1) fail(`${rel(file)}: 重复标题锚点 ${key}`);

  for (let index = 0; index < lines.length - 1; index++) {
    if (!/^\|/.test(lines[index]) || !/^\|[\s:|-]+\|$/.test(lines[index + 1])) continue;
    const expected = cellCount(lines[index]);
    for (let row = index + 1; row < lines.length && /^\|/.test(lines[row]); row++) {
      if (cellCount(lines[row]) !== expected) {
        fail(`${rel(file)}:${row + 1}: 表格列数与表头不一致（${cellCount(lines[row])} ≠ ${expected}）`);
      }
    }
    index += 1;
  }

  const tocIndex = lines.findIndex((line) => /^##\s+目录\s*$/.test(line));
  if (tocIndex < 0) continue;
  const toc = [];
  let end = tocIndex + 1;
  for (; end < lines.length; end++) {
    const entry = /^\s*-\s+\[[^\]]*\]\(#([^)]+)\)/.exec(lines[end]);
    if (entry) { toc.push(decodeURIComponent(entry[1])); continue; }
    if (/^##\s+/.test(lines[end])) break;
  }
  const sections = lines.slice(end)
    .map((line) => /^##\s+(.*)$/.exec(line))
    .filter(Boolean)
    .map((match) => slug(match[1]))
    .filter((key) => key !== '目录' && key !== '相关文档');
  for (const key of sections) if (!toc.includes(key)) fail(`${rel(file)}: 目录缺少 ${key}`);
  for (const key of toc) if (!sections.includes(key) && key !== '相关文档') fail(`${rel(file)}: 目录含多余条目 ${key}`);
}

if (failures.length) {
  console.error(`Documentation check failed (${failures.length}):`);
  for (const message of failures) console.error(`- ${message}`);
  process.exit(1);
}
console.log(`Documentation check passed: ${docs.length} files, links/anchors, stale terms, catalog counts, issue IDs, hub coverage, headings/tables/TOC.`);
