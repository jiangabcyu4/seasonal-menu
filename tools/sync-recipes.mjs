#!/usr/bin/env node
/**
 * sync-recipes.mjs — 把网页里「我的菜谱」导出的 JSON 合并进 data/recipes.js，并可选推送到 GitHub + Gitee
 *
 * 用法：
 *   node tools/sync-recipes.mjs recipes-custom-2026-11-25.json
 *   node tools/sync-recipes.mjs recipes-custom-2026-11-25.json --push
 *
 * 工作方式：
 *   1. 读取网页导出的 JSON（{ schema, version, recipes: [...] }）
 *   2. 与 data/recipes.js 里已有的 RECIPES_EXTRA 按 id 去重合并
 *   3. 重写 data/recipes.js（保持可被 <script> 直接加载的格式）
 *   4. --push 时：git add/commit，并推送到 origin(GitHub) 与 gitee
 *
 * 网页下次打开会自动加载 data/recipes.js，新增的菜就进了菜谱库和配餐池。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA_FILE = path.join(ROOT, 'data', 'recipes.js');

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m'
};
const log = {
  ok: (t) => console.log(`  ${c.green}✓${c.reset} ${t}`),
  info: (t) => console.log(`  ${c.dim}·${c.reset} ${t}`),
  warn: (t) => console.log(`  ${c.yellow}!${c.reset} ${t}`),
  err: (t) => console.log(`  ${c.red}✗${c.reset} ${t}`),
  step: (t) => console.log(`\n${c.cyan}[${t}]${c.reset}`)
};

/* ---------------- 读取现有扩充包 ---------------- */
function readExtra() {
  if (!fs.existsSync(DATA_FILE)) return [];
  const src = fs.readFileSync(DATA_FILE, 'utf8');
  const m = src.match(/window\.RECIPES_EXTRA\s*=\s*(\[[\s\S]*?\])\s*;?\s*$/);
  if (!m) return [];
  try {
    return JSON.parse(m[1]);
  } catch (e) {
    console.error(`解析 ${DATA_FILE} 失败: ${e.message}`);
    console.error('提示：这个文件应由本脚本生成，手改时请保持纯 JSON 数组格式。');
    process.exit(1);
  }
}

/* ---------------- 校验单条菜谱 ---------------- */
const REQUIRED = ['id', 'name', 'kind', 'ing', 'steps'];
const VALID_KIND = ['meat', 'half', 'veg', 'soup', 'bf', 'staple', 'med', 'des'];

function validate(r, i) {
  const errs = [];
  for (const k of REQUIRED) if (!r[k]) errs.push(`缺字段 ${k}`);
  if (r.kind && !VALID_KIND.includes(r.kind)) errs.push(`kind 非法: ${r.kind}`);
  if (r.ing && (!Array.isArray(r.ing) || r.ing.some(x => !Array.isArray(x) || x.length < 2))) {
    errs.push('ing 格式应为 [[名称,数量,单位,生活单位], ...]');
  }
  if (r.steps && (!Array.isArray(r.steps) || !r.steps.length)) errs.push('steps 应为非空数组');
  return errs.length ? `第 ${i + 1} 条（${r.name || '无名称'}）：${errs.join('；')}` : null;
}

/* ---------------- 主流程 ---------------- */
const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith('--'));
const shouldPush = args.includes('--push');

if (!input) {
  console.log(`
${c.bold}sync-recipes${c.reset} — 把网页导出的自定义菜谱合并进 data/recipes.js

${c.bold}用法${c.reset}
  node tools/sync-recipes.mjs <导出的json> [--push]

${c.bold}说明${c.reset}
  在网页「06 我的菜谱」里点「导出 JSON」，把文件路径传进来。
  加 --push 会同时 commit 并推送到 GitHub 与 Gitee。
`);
  process.exit(0);
}

const inPath = path.resolve(input);
if (!fs.existsSync(inPath)) {
  console.error(`文件不存在: ${inPath}`);
  process.exit(1);
}

log.step('1/4 读取输入');
const payload = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const incoming = Array.isArray(payload) ? payload : (payload.recipes || []);
if (!incoming.length) {
  console.error('文件里没有菜谱（应为 { recipes: [...] } 或数组）');
  process.exit(1);
}
log.ok(`读入 ${incoming.length} 条`);

log.step('2/4 校验');
const problems = incoming.map(validate).filter(Boolean);
if (problems.length) {
  problems.forEach((p) => log.err(p));
  console.error(`\n有 ${problems.length} 条不合格，已中止（不会写入任何文件）`);
  process.exit(1);
}
log.ok('全部合格');

log.step('3/4 合并');
const existing = readExtra();
const byId = new Map(existing.map((r) => [r.id, r]));
const byName = new Set(existing.map((r) => r.name));
let added = 0, updated = 0, skipped = 0;

for (const r of incoming) {
  if (byId.has(r.id)) {
    byId.set(r.id, r); updated++;
  } else if (byName.has(r.name)) {
    skipped++; // 同名不同 id，跳过避免重复菜
  } else {
    byId.set(r.id, r); byName.add(r.name); added++;
  }
}
const merged = [...byId.values()];
log.ok(`新增 ${added} · 更新 ${updated} · 跳过同名 ${skipped} · 合并后共 ${merged.length} 条`);

const out = `/**
 * 菜谱扩充包（云端同步点）
 *
 * 这个文件由 tools/sync-recipes.mjs 自动生成/更新。
 * 网页加载时会把它合并进内置菜谱库，所以在这里加的菜不需要改 index.html。
 *
 * 最后同步：${new Date().toISOString()}
 * 条目数：${merged.length}
 *
 * 手动编辑请保持 window.RECIPES_EXTRA 为纯 JSON 数组，否则脚本和网页都会读不出。
 */
window.RECIPES_EXTRA = ${JSON.stringify(merged, null, 2)};
`;
fs.writeFileSync(DATA_FILE, out, 'utf8');
log.ok(`已写入 ${path.relative(ROOT, DATA_FILE)}（${(out.length / 1024).toFixed(1)} KB）`);

log.step('4/4 提交与推送');
if (!shouldPush) {
  log.info('未指定 --push，只更新了本地文件');
  log.info('确认无误后可手动 push，或重跑并加 --push');
  console.log('');
  process.exit(0);
}

function git(argsArr, opts = {}) {
  try {
    return execFileSync('git', argsArr, {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, ...opts
    });
  } catch (e) {
    return { error: [e.stderr, e.stdout, e.message].filter(Boolean).join('\n') };
  }
}

git(['add', 'data/recipes.js']);
const staged = git(['diff', '--cached', '--name-only']);
if (typeof staged === 'string' && !staged.trim()) {
  log.info('没有变化，跳过提交');
  console.log('');
  process.exit(0);
}
const committed = git(['commit', '-m', `feat(recipes): 同步 ${added} 道自定义菜谱`]);
if (committed.error) {
  log.err('提交失败：' + committed.error.split('\n')[0]);
  process.exit(1);
}
log.ok('已提交');

/* 推送：remote URL 里不带凭证，凭证由 git 凭据管理器或 publish-kit 负责 */
const remotes = (git(['remote']) || '').toString().trim().split('\n').filter(Boolean);
if (!remotes.length) {
  log.warn('没有配置 remote，跳过推送');
  log.info('可用 publish-kit：pk deploy . --name seasonal-menu --only github,gitee');
  process.exit(0);
}

for (const remote of remotes) {
  const branch = (git(['rev-parse', '--abbrev-ref', 'HEAD']) || 'main').toString().trim();
  const r = git(['push', remote, branch]);
  if (r.error) log.warn(`${remote} 推送失败：${r.error.split('\n')[0]}`);
  else log.ok(`${remote} 推送成功`);
}

console.log(`\n${c.green}完成${c.reset} 重新打开网页即可看到新增菜谱。\n`);
