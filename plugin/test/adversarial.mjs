// test/adversarial.mjs — folder-janitor 对抗性测试
//
// 用法（在 folder-janitor/ 下）：node test/adversarial.mjs
//
// 只写 test/.adv/，不改 lib/、index.js、test/run.mjs。
// 每个场景自带临时树，互不依赖；失败的断言就是被证伪的承诺。
// 除了 pass/fail，还会打印 BUG（真问题）和 NOTE（难用/质量/环境限制）。

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  categoryOf,
  dayStamp,
  extOf,
  humanBytes,
  junkOf,
  safeSegment,
  siblingName,
  tokensOf,
  yearMonth,
} from '../lib/classify.js';
import { buildInventory, insideRoot, scanTree } from '../lib/scan.js';
import { buildPlan, groupByProject } from '../lib/plan.js';
import { applyPlan, undoJournal } from '../lib/apply.js';
import { listJournals, loadJournalByPath, loadPlanByPath } from '../lib/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '.adv');
const NOW = new Date(2026, 0, 15, 12, 0, 0).getTime(); // 本地 2026-01-15，junk 日期桶可预测
const DAY = 86400000;
const LONG_ASCII = 'L'.repeat(205) + '.txt';
const LONG_CJK = '长'.repeat(120) + '.md';
const LONG_PROJECT_CJK = '这是一个长度超过二十四个汉字的项目名称我们来做整理'; // 25 个汉字

// ---------------------------------------------------------------- 结果记录

const results = [];
const bugs = [];
const notes = [];
let section = '(未开始)';
let planSeq = 0;

function heading(title) {
  section = title;
  console.log(`\n=== ${title} ===`);
}

function bug(title, expected, actual, where) {
  bugs.push({ title, expected, actual, where });
  console.log(`  BUG  ${title}\n       期望: ${expected}\n       实际: ${actual}\n       定位: ${where}`);
}

function note(title, detail) {
  notes.push({ title, detail });
  console.log(`  NOTE ${title}\n       ${detail}`);
}

async function check(label, fn) {
  try {
    const value = fn();
    if (value && typeof value.then === 'function') await value;
    results.push({ section, label, ok: true });
    console.log(`  ok   ${label}`);
  } catch (err) {
    const msg = String(err?.message ?? err).split('\n').slice(0, 8).join('\n       ');
    results.push({ section, label, ok: false, msg });
    console.log(`  FAIL ${label}\n       ${msg}`);
  }
}

/** lib/ 指纹：测试期间如果有人在改引擎，这轮结果就不能当成定版结论。 */
async function libFingerprint() {
  const base = path.join(HERE, '..');
  const targets = (await fs.readdir(path.join(base, 'lib')))
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => path.join(base, 'lib', name));
  targets.push(path.join(base, 'index.js'));
  const out = {};
  for (const abs of targets) out[path.basename(abs)] = sha(await fs.readFile(abs)).slice(0, 16);
  return out;
}

async function runSection(title, fn) {
  heading(title);
  try {
    await fn();
  } catch (err) {
    await check(`[${title}] 未预期异常`, () => {
      throw err;
    });
  }
}

// ---------------------------------------------------------------- 基础工具

function sha(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function rmrf(abs) {
  await fs.rm(abs, { recursive: true, force: true, maxRetries: 3 });
}

async function freshDir(name) {
  const abs = path.join(ROOT, name);
  await rmrf(abs);
  await fs.mkdir(abs, { recursive: true });
  return abs;
}

async function put(root, rel, content = 'x') {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  return abs;
}

async function mkdirp(root, rel) {
  const abs = path.join(root, rel);
  await fs.mkdir(abs, { recursive: true });
  return abs;
}

async function readText(abs) {
  return fs.readFile(abs, 'utf8');
}

async function exists(abs) {
  try {
    await fs.lstat(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * 目录快照。默认不含 .folder-janitor（计划/日志是正常写入，不算承诺范围）。
 * withMtime=true 时文件记录 大小|mtime|hash、目录记录 mtime，用于证明 dryRun 零写入。
 */
async function snap(root, { includeState = false, withMtime = false, withDirs = true } = {}) {
  const out = new Map();
  async function walk(dirAbs, rel) {
    let entries = [];
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      const abs = path.join(dirAbs, entry.name);
      if (!includeState && (childRel === '.folder-janitor' || childRel.startsWith('.folder-janitor' + path.sep))) continue;
      if (entry.isDirectory()) {
        const stat = withMtime ? await fs.stat(abs) : null;
        if (withDirs) out.set(`d:${childRel}`, withMtime ? String(stat.mtimeMs) : 'dir');
        await walk(abs, childRel);
      } else if (entry.isFile()) {
        const stat = await fs.stat(abs);
        const hash = sha(await fs.readFile(abs));
        out.set(`f:${childRel}`, withMtime ? `${stat.size}|${stat.mtimeMs}|${hash}` : `${stat.size}|${hash}`);
      } else if (entry.isSymbolicLink()) {
        out.set(`l:${childRel}`, 'link');
      }
    }
  }
  await walk(root, '');
  return out;
}

function diffSnapshot(before, after) {
  return {
    missing: [...before.keys()].filter((k) => !after.has(k)).sort(),
    added: [...after.keys()].filter((k) => !before.has(k)).sort(),
    changed: [...before.keys()].filter((k) => after.has(k) && after.get(k) !== before.get(k)).sort(),
  };
}

function shortDiff(diff) {
  const text = JSON.stringify(diff);
  return text.length > 500 ? text.slice(0, 500) + '…' : text;
}

function assertSnapshotEqual(before, after, hint = '') {
  const diff = diffSnapshot(before, after);
  assert.deepEqual(diff, { missing: [], added: [], changed: [] }, `${hint}${hint ? ' ' : ''}${shortDiff(diff)}`);
}

async function snapHashes(root, options = {}) {
  const snapshot = await snap(root, { withDirs: false, ...options });
  const map = new Map();
  for (const [key, value] of snapshot) {
    if (!key.startsWith('f:')) continue;
    map.set(key.slice(2), value.split('|').pop());
  }
  return map;
}

function histogram(map) {
  const counts = new Map();
  for (const hash of map.values()) counts.set(hash, (counts.get(hash) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function assertContentConserved(before, after, hint = '') {
  assert.deepEqual(histogram(after), histogram(before), `${hint} 内容多重集变化（可能丢文件/覆盖）`);
}

function byFrom(journal) {
  return new Map(journal.entries.map((entry) => [entry.from, entry]));
}

function journalCount(root) {
  return listJournals(root).then((ids) => ids.length);
}

function craftedPlan(root, entries, strategy = 'by-type') {
  planSeq += 1;
  return {
    kind: 'folder-janitor/plan',
    planId: `plan-crafted-${planSeq}`,
    createdAt: new Date(NOW).toISOString(),
    root,
    strategy,
    strategyLabel: strategy,
    options: { depth: 1, junk: false },
    entries: entries.map((entry) => ({ kind: 'content', reason: 'crafted', ...entry })),
    skipped: [],
    skippedTotal: 0,
  };
}

// ---------------------------------------------------------------- 0. 纯函数

async function pureFns() {
  await check("extOf('.gitignore') 为空、归 other（纯扩展名不当扩展名）", () => {
    assert.equal(extOf('.gitignore'), '');
    assert.equal(categoryOf('.gitignore'), 'other');
  });

  await check('扩展名大小写归一、多点取最后一段', () => {
    assert.equal(extOf('REPORT.PDF'), 'pdf');
    assert.equal(categoryOf('PHOTO.PNG'), 'image');
    assert.equal(extOf('a.tar.gz'), 'gz');
    assert.equal(categoryOf('a.tar.gz'), 'archive');
  });

  await check('尾点/无扩展名不崩', () => {
    assert.equal(extOf('a.'), '');
    assert.equal(categoryOf('a.'), 'other');
    assert.equal(extOf('noext'), '');
    assert.equal(categoryOf(''), 'other');
  });

  await check('junkOf 各规则正面命中', () => {
    assert.equal(junkOf('~$draft.docx', 10)?.id, 'office-lock');
    assert.equal(junkOf('_build.js', 10)?.id, 'scratch-prefix');
    assert.equal(junkOf('x.tmp', 10)?.id, 'temp-ext');
    assert.equal(junkOf('x.LOG', 10)?.id, 'temp-ext');
    assert.equal(junkOf('report copy.pdf', 10)?.id, 'copy-suffix');
    assert.equal(junkOf('裁剪 副本.png', 10)?.id, 'copy-suffix');
    assert.equal(junkOf('a (2).pdf', 10)?.id, 'copy-suffix');
    assert.equal(junkOf('empty.txt', 0)?.id, 'empty');
  });

  await check('junkOf 不误伤普通文件名', () => {
    assert.equal(junkOf('empty.txt', 10), null);
    assert.equal(junkOf('final.pdf', 10), null);
    assert.equal(junkOf('untitled.txt', 10), null);
    assert.equal(junkOf('.gitignore', 12), null);
    assert.equal(junkOf('照片副本 2.png', 10), null); // 没有分隔符的 副本 不算
  });

  await check('humanBytes 常规值', () => {
    assert.equal(humanBytes(0), '0 B');
    assert.equal(humanBytes(1023), '1023 B');
    assert.equal(humanBytes(1024), '1.0 KB');
    assert.equal(humanBytes(1536), '1.5 KB');
    assert.equal(humanBytes(1048576), '1.0 MB');
  });

  await check('日期格式化稳定', () => {
    assert.equal(yearMonth(NOW), '2026-01');
    assert.equal(dayStamp(NOW), '2026-01-15');
  });

  await check('safeSegment 处理保留名/非法字符/首尾点/超长', () => {
    assert.equal(safeSegment('CON'), 'group'); // 默认 fallback
    assert.equal(safeSegment('CON', 'project'), 'project');
    assert.equal(safeSegment('nul', '_duplicates'), '_duplicates');
    assert.equal(safeSegment('a/b:c'), 'a-b-c');
    assert.equal(safeSegment('.hidden'), 'hidden');
    assert.equal(safeSegment('x'.repeat(80)).length, 60);
    assert.equal(safeSegment('   '), 'group');
    assert.equal(safeSegment(''), 'group');
    assert.equal(safeSegment('a\u0001b'), 'ab');
    assert.equal(safeSegment(' ..x.. '), '..x'); // 注意：仍以 .. 开头，后面会看到后果
  });

  await check('siblingName 对纯扩展名/多扩展名/无扩展名', () => {
    assert.equal(siblingName('.gitignore', 2), '.gitignore (2)');
    assert.equal(siblingName('a.tar.gz', 2), 'a.tar (2).gz');
    assert.equal(siblingName('noext', 2), 'noext (2)');
  });

  await check('insideRoot 对 root 内以 .. 开头的文件路径判定正确', () => {
    const probeRoot = path.join(ROOT, 'inside-root-probe');
    assert.equal(insideRoot(probeRoot, path.join(probeRoot, '..x.txt')), true);
    assert.equal(insideRoot(probeRoot, path.join(probeRoot, 'normal.txt')), true);
    assert.equal(insideRoot(probeRoot, path.join(probeRoot, '..', 'evil.txt')), false);
    assert.equal(insideRoot(probeRoot, probeRoot), false);
  });

  await check('tokensOf 确定性输出（含 2 字母词/哈希/混排/CJK 长度上限/新增停用词）', () => {
    assert.deepEqual(tokensOf('nobel-2026-brief'), ['nobel', 'brief']);
    assert.deepEqual(tokensOf('卡洛·斯卡帕学习手册'), ['卡洛', '斯卡帕学习手册']);
    assert.deepEqual(tokensOf('.gitignore'), ['gitignore']);
    assert.deepEqual(tokensOf('ai-notes'), []); // notes 已是停用词
    assert.deepEqual(tokensOf('3d-scene'), ['scene']);
    assert.deepEqual(tokensOf('deadbeef1234'), []);
    assert.deepEqual(tokensOf('HTTPServer'), ['http', 'server']);
    assert.deepEqual(tokensOf('final-draft'), []);
    assert.deepEqual(tokensOf(LONG_PROJECT_CJK), []);
    assert.deepEqual(tokensOf('a_b'), []);
    assert.deepEqual(tokensOf('2026年诺贝尔经济学奖学习手册'), ['诺贝尔经济学奖学习手册']);
    assert.deepEqual(tokensOf('Sphere_R600mm'), ['sphere', 'r600mm']);
  });

  await check('groupByProject：恰好 60% 覆盖的泛词会通过“太泛”筛子', () => {
    const items = [];
    for (let i = 1; i <= 6; i += 1) items.push({ rel: `shared-batch-${i}.md`, name: `shared-batch-${i}.md` });
    for (let i = 1; i <= 4; i += 1) items.push({ rel: `other-${i}.pdf`, name: `other-${i}.pdf` });
    const grouping = groupByProject(items);
    const shared = grouping.groups.find((group) => group.folder === 'shared');
    assert.ok(shared, `实际分组: ${JSON.stringify(grouping.groups.map((g) => [g.folder, g.files.length]))}`);
    assert.equal(shared.files.length, 6);
  });
}

// ---------------------------------------------------------------- 1. 极端文件名

async function extremeNames() {
  const root = await freshDir('s1-names');
  const attempts = [
    ['中文 空格 🚀 标题.md', 'c1'],
    [' leading-space.txt', 'c2'],
    ['.gitignore', 'node_modules\n'],
    ['.eslintrc.json', '{"root":true}'],
    ['noext', 'c3'],
    ['100% done.txt', 'c4'],
    ['%TEMP% 变量.txt', 'c5'],
    ["it's a quote.txt", 'c6'],
    ['a..b.txt', 'c7'],
    ['emoji🖼️middle.png', 'c8'],
    ['..double.dot.pdf', 'c9'],
    ['trailingdot.', 'c10'],
    ['CON.txt', 'c11'],
    ['NUL', 'c12'],
    ['quote"double.txt', 'c13'],
    ['new\nline.txt', 'c14'],
    ['tab\tname.txt', 'c15'],
    [LONG_ASCII, 'c16'],
    [LONG_CJK, 'c17'],
    ['bad|pipe.txt', 'c18'],
  ];

  const contentByName = new Map();
  const envNotes = [];
  for (const [name, content] of attempts) {
    const before = new Set(await fs.readdir(root));
    try {
      await fs.writeFile(path.join(root, name), content, { flag: 'wx' });
    } catch (err) {
      envNotes.push(`${JSON.stringify(name)} 无法在本机创建: ${err.code}`);
      continue;
    }
    const after = await fs.readdir(root);
    const created = after.find((entry) => !before.has(entry));
    const actual = created ?? name;
    if (actual !== name) envNotes.push(`${JSON.stringify(name)} 被文件系统规范化成 ${JSON.stringify(actual)}`);
    contentByName.set(actual, content);
  }
  console.log(`  本机实际创建成功的极端名: ${JSON.stringify([...contentByName.keys()])}`);
  for (const line of envNotes) console.log(`  ENV  ${line}`);

  const names = [...contentByName.keys()];
  const baseHashes = await snapHashes(root);

  let plan;
  let planFile;
  let buildCrash = null;
  try {
    ({ plan, file: planFile } = await buildPlan({ root, strategy: 'by-type', options: { depth: 1, junk: false }, now: NOW }));
  } catch (err) {
    buildCrash = err;
  }

  await check('极端文件名：buildPlan 不抛异常并落盘计划（隐藏/结构文件被排除）', async () => {
    assert.equal(buildCrash, null, String(buildCrash));
    assert.ok(await exists(planFile));
    assert.equal(plan.checked, names.length);
    const structural = names.filter((name) => name.startsWith('.'));
    assert.ok(structural.length >= 3, JSON.stringify(structural));
    assert.equal(plan.entries.length, names.length - structural.length, `entries=${plan.entries.length} names=${names.length} structural=${structural}`);
    for (const name of structural) {
      assert.ok(plan.skipped.some((entry) => entry.from === name && entry.reason.includes('结构文件')), `${name} 没有被标为结构文件`);
    }
  });
  if (buildCrash) return;

  await check('计划 JSON 读写往返后条目一致（长名/CJK/emoji/%/引号）', async () => {
    const loaded = await loadPlanByPath(planFile);
    assert.deepEqual(loaded.entries.map((entry) => entry.from), plan.entries.map((entry) => entry.from));
  });

  const loadedPlan = await loadPlanByPath(planFile);
  const beforeApply = await snap(root);
  let journal = null;
  try {
    journal = await applyPlan(loadedPlan);
  } catch (err) {
    note('极端名 apply 崩溃', String(err));
  }

  await check('apply 不因极端文件名崩溃', () => assert.ok(journal, 'apply 抛错'));
  if (!journal) return;

  await check('每个计划条目都有明确终态（ok/failed/skipped）', () => {
    assert.equal(journal.entries.length, plan.entries.length);
    for (const entry of journal.entries) assert.ok(['ok', 'failed', 'skipped'].includes(entry.status), JSON.stringify(entry));
  });

  const status = byFrom(journal);

  await check('成功移动的文件内容逐字节一致', async () => {
    for (const entry of journal.entries) {
      if (entry.status !== 'ok') continue;
      assert.equal(await readText(path.join(root, entry.to)), contentByName.get(entry.from), `${entry.from} -> ${entry.to}`);
    }
  });

  await check('failed 条目源文件仍在原位（不丢）', async () => {
    for (const entry of journal.entries) {
      if (entry.status !== 'failed') continue;
      assert.ok(await exists(path.join(root, entry.from)), `${entry.from} 丢失`);
    }
  });

  await check('移动前后内容多重集一致（不丢不覆盖）', async () => {
    assertContentConserved(baseHashes, await snapHashes(root));
  });

  await check('分类落点正确：无扩展名→misc、CON/NUL 也不特殊处理', () => {
    assert.equal(status.get('noext')?.to, path.join('misc', 'noext'));
    assert.equal(status.get('CON.txt')?.to, path.join('documents', 'CON.txt'));
    assert.equal(status.get('NUL')?.to, path.join('misc', 'NUL'));
  });

  await check('中文/emoji/空格/单引号/% 名称保持原样落位', () => {
    assert.equal(status.get('中文 空格 🚀 标题.md')?.to, path.join('documents', '中文 空格 🚀 标题.md'));
    assert.equal(status.get("it's a quote.txt")?.to, path.join('documents', "it's a quote.txt"));
    assert.equal(status.get('100% done.txt')?.to, path.join('documents', '100% done.txt'));
    assert.equal(status.get('%TEMP% 变量.txt')?.to, path.join('documents', '%TEMP% 变量.txt'));
  });

  await check('隐藏/结构文件（.gitignore/.eslintrc.json/..double.dot.pdf）原样留在 root', async () => {
    for (const name of ['.gitignore', '.eslintrc.json', '..double.dot.pdf']) {
      assert.equal(await readText(path.join(root, name)), contentByName.get(name));
    }
  });

  const longEntry = status.get(LONG_ASCII);
  await check('>200 字符文件名：ok 则内容完整，failed 则源文件仍在（不丢）', async () => {
    if (!longEntry) {
      return; // 本机文件系统拒绝创建该文件，已在 ENV 里记录
    }
    if (longEntry.status === 'ok') assert.equal(await readText(path.join(root, longEntry.to)), 'c16');
    else assert.ok(await exists(path.join(root, LONG_ASCII)));
  });
  note('>200 字符文件名 apply 实际结果', longEntry ? `${longEntry.status} ${longEntry.error ?? ''}` : '本机无法创建，未覆盖');

  const cjkLongEntry = status.get(LONG_CJK);
  note('120 个汉字文件名 apply 实际结果', `${cjkLongEntry?.status} ${cjkLongEntry?.error ?? ''}`);

  const undo = await undoJournal(journal);
  await check('撤销后文件/目录结构回到整理前（除未移动的 failed 项）', async () => {
    assertSnapshotEqual(beforeApply, await snap(root), '');
  });
  await check('撤销恢复数 = ok 条目数', () => {
    assert.equal(undo.restored, journal.entries.filter((entry) => entry.status === 'ok').length);
  });
}

// ---------------------------------------------------------------- 2. 深层嵌套与 depth

async function deepNesting() {
  const root = await freshDir('s2-deep');
  await put(root, 'same.pdf', 'root-content');
  let chain = '';
  for (let i = 1; i <= 12; i += 1) {
    chain = path.join(chain, `d${i}`);
    await put(root, path.join(chain, 'same.pdf'), `level-${i}`);
  }
  await put(root, path.join('branchA', 'same.pdf'), 'branch-a');
  await put(root, path.join('branchB', 'same.pdf'), 'branch-b');
  await put(root, path.join(chain, 'leaf.md'), 'leaf-content');
  const before = await snap(root);

  const depth2 = await buildPlan({ root, strategy: 'by-type', options: { depth: 2, junk: false }, now: NOW });
  await check('depth=2 覆盖根和所有一层子目录（不只 d1）', () => {
    assert.deepEqual(
      depth2.plan.entries.map((entry) => entry.from).sort(),
      ['same.pdf', path.join('d1', 'same.pdf'), path.join('branchA', 'same.pdf'), path.join('branchB', 'same.pdf')].sort(),
    );
  });
  await check('depth=2 保留相对子路径，不会把子目录文件搬平', () => {
    const to = new Map(depth2.plan.entries.map((entry) => [entry.from, entry.to]));
    assert.equal(to.get('same.pdf'), path.join('documents', 'same.pdf'));
    assert.equal(to.get(path.join('d1', 'same.pdf')), path.join('documents', 'd1', 'same.pdf'));
    assert.equal(to.get(path.join('branchA', 'same.pdf')), path.join('documents', 'branchA', 'same.pdf'));
  });

  const beforeHashes = await snapHashes(root);
  const all = await buildPlan({ root, strategy: 'by-type', options: { depth: -1, junk: false }, now: NOW });
  await check('depth=-1 覆盖 13 层嵌套里的全部 16 个文件', () => {
    assert.equal(all.plan.entries.length, 16);
  });
  await check('depth=-1 计划内目标路径（大小写无关）互不重复', () => {
    const dests = all.plan.entries.map((entry) => entry.to.toLowerCase());
    assert.equal(new Set(dests).size, dests.length);
  });
  await check('depth=-1 保留完整相对路径（13 层同名文件各回各家）', () => {
    const to = new Map(all.plan.entries.map((entry) => [entry.from, entry.to]));
    assert.equal(to.get(path.join(chain, 'same.pdf')), path.join('documents', chain, 'same.pdf'));
    assert.equal(to.get(path.join('branchA', 'same.pdf')), path.join('documents', 'branchA', 'same.pdf'));
    assert.equal(to.get(path.join('branchB', 'same.pdf')), path.join('documents', 'branchB', 'same.pdf'));
  });

  const journal = await applyPlan(all.plan);
  await check('深层执行后内容多重集不变（同名不同内容不互相覆盖）', async () => {
    assertContentConserved(beforeHashes, await snapHashes(root));
  });
  await check('13 层落点内容正确', async () => {
    assert.equal(await readText(path.join(root, 'documents', chain, 'same.pdf')), 'level-12');
    assert.equal(await readText(path.join(root, 'documents', 'branchA', 'same.pdf')), 'branch-a');
    assert.equal(await readText(path.join(root, 'documents', 'branchB', 'same.pdf')), 'branch-b');
    assert.equal(await readText(path.join(root, 'documents', chain, 'leaf.md')), 'leaf-content');
  });
  note(
    'depth=-1 的 by-type 会把子目录里的项目文件搬出项目目录',
    '例如 branchA/same.pdf → documents/branchA/same.pdf；子目录结构被镜像保留，但文件已不在 branchA 下，原项目目录被掏空（空目录保留）。',
  );

  const undo = await undoJournal(journal);
  await check('深层整理后撤销，文件与目录结构回到整理前', async () => {
    assertSnapshotEqual(before, await snap(root), '');
  });
  await check('深层撤销全部成功', () => assert.equal(undo.restored, 16));

  const zero = await buildPlan({ root, strategy: 'by-type', options: { depth: 0, junk: false }, now: NOW });
  await check('depth=0 被归一成 1（只根目录）', () => {
    assert.equal(zero.plan.options.depth, 1);
    assert.deepEqual(zero.plan.entries.map((entry) => entry.from), ['same.pdf']);
  });

  const doubleNegative = await buildPlan({ root, strategy: 'by-type', options: { depth: '-2', junk: false }, now: NOW });
  await check('depth 传字符串 "-2" 被当成不限深度', () => {
    assert.equal(doubleNegative.plan.entries.length, 16);
  });
}

// ---------------------------------------------------------------- 3. 撞名矩阵

async function collisions() {
  const root = await freshDir('s3-matrix');
  await put(root, 'x.pdf', 'ROOT-X1');
  await put(root, 'y.pdf', 'SAME-Y');
  await put(root, 'z.pdf', 'ROOT-Z');
  await put(root, 's.pdf', 'AAAA');
  await put(root, 'same-size.pdf', '1111');
  await put(root, 'ro.pdf', 'RO-ROOT');
  await put(root, 'rosrc.pdf', 'RO-SOURCE');
  await put(root, 'free.pdf', 'FREE');
  await put(root, path.join('documents', 'x.pdf'), 'PRE-X');
  await put(root, path.join('documents', 'y.pdf'), 'SAME-Y');
  await put(root, path.join('documents', 's.pdf'), 'BBBB');
  await put(root, path.join('documents', 'same-size.pdf'), '2222');
  await put(root, path.join('documents', 'ro.pdf'), 'RO-TARGET');
  await put(root, path.join('documents', 'z.pdf', 'inside.txt'), 'USER-DIR-CONTENT');
  await fs.chmod(path.join(root, 'documents', 'ro.pdf'), 0o444);
  await fs.chmod(path.join(root, 'rosrc.pdf'), 0o444);

  const before = await snap(root);
  const beforeHashes = await snapHashes(root);
  const { plan } = await buildPlan({ root, strategy: 'by-type', options: { depth: 1, junk: false }, now: NOW });
  const journal = await applyPlan(plan);
  const status = byFrom(journal);

  await check('目标已存在不同内容 → 改名 (2)，不覆盖', () => {
    assert.equal(status.get('x.pdf')?.to, path.join('documents', 'x (2).pdf'));
    assert.equal(status.get('x.pdf')?.note?.includes('重名'), true);
  });
  await check('目标已存在同内容 → 仍然改名并存，并标注“同内容”', () => {
    assert.equal(status.get('y.pdf')?.to, path.join('documents', 'y (2).pdf'));
    assert.equal(status.get('y.pdf')?.note?.includes('同内容'), true);
  });
  await check('目标同名的是目录 → 改名 (2)，不动目录', async () => {
    assert.equal(status.get('z.pdf')?.to, path.join('documents', 'z (2).pdf'));
    assert.equal(await readText(path.join(root, 'documents', 'z.pdf', 'inside.txt')), 'USER-DIR-CONTENT');
  });
  await check('目标同大小但内容不同 → 仍然改名，不覆盖', () => {
    assert.equal(status.get('s.pdf')?.to, path.join('documents', 's (2).pdf'));
    assert.equal(status.get('same-size.pdf')?.to, path.join('documents', 'same-size (2).pdf'));
  });
  await check('目标只读文件 → 改名避让，只读目标内容不变', async () => {
    assert.equal(status.get('ro.pdf')?.to, path.join('documents', 'ro (2).pdf'));
    assert.equal(await readText(path.join(root, 'documents', 'ro.pdf')), 'RO-TARGET');
  });
  await check('只读源文件：failed 则源文件离开原处，ok 则内容完整（不丢）', async () => {
    const entry = status.get('rosrc.pdf');
    if (entry.status === 'failed') {
      assert.equal(await readText(path.join(root, 'rosrc.pdf')), 'RO-SOURCE');
    } else {
      assert.equal(entry.status, 'ok');
      assert.equal(await readText(path.join(root, entry.to)), 'RO-SOURCE');
    }
  });
  note('只读源文件的 apply 实际结果', `${status.get('rosrc.pdf')?.status} ${status.get('rosrc.pdf')?.error ?? ''}`);

  await check('预置目标文件内容全部原样', async () => {
    assert.equal(await readText(path.join(root, 'documents', 'x.pdf')), 'PRE-X');
    assert.equal(await readText(path.join(root, 'documents', 'y.pdf')), 'SAME-Y');
    assert.equal(await readText(path.join(root, 'documents', 's.pdf')), 'BBBB');
    assert.equal(await readText(path.join(root, 'documents', 'same-size.pdf')), '2222');
  });
  await check('撞名矩阵执行后内容多重集不变', async () => {
    assertContentConserved(beforeHashes, await snapHashes(root));
  });

  const undo = await undoJournal(journal);
  await check('撞名矩阵撤销后回到整理前（含预置目录/只读目标）', async () => {
    assertSnapshotEqual(before, await snap(root), '');
  });
  await check('撤销只删本次新建目录：预置 documents/ 不能删', async () => {
    assert.equal(undo.prunedDirs, 0);
    assert.ok(await exists(path.join(root, 'documents')));
  });
  await fs.chmod(path.join(root, 'rosrc.pdf'), 0o666).catch(() => {});
  await fs.chmod(path.join(root, 'documents', 'ro.pdf'), 0o666).catch(() => {});

  // ---- 连续 apply 的 (2)(3)(4) 递进
  const seqRoot = await freshDir('s3-seq');
  const contents = ['one', 'two', 'three', 'four'];
  const expectedNames = ['x.pdf', 'x (2).pdf', 'x (3).pdf', 'x (4).pdf'];
  const journals = [];
  for (let i = 0; i < contents.length; i += 1) {
    await put(seqRoot, 'x.pdf', contents[i]);
    const { plan: seqPlan } = await buildPlan({ root: seqRoot, strategy: 'by-type', options: { depth: 1, junk: false }, now: NOW });
    journals.push(await applyPlan(seqPlan));
    const namesAfter = (await fs.readdir(path.join(seqRoot, 'documents'))).sort();
    await check(`第 ${i + 1} 次 apply 撞名得到 ${expectedNames[i]}`, () => {
      assert.deepEqual(namesAfter, expectedNames.slice(0, i + 1).sort());
    });
  }
  await check('四次 apply 后四份内容都完好，没有互相覆盖', async () => {
    for (let i = 0; i < contents.length; i += 1) {
      assert.equal(await readText(path.join(seqRoot, 'documents', expectedNames[i])), contents[i]);
    }
  });
  const undoLast = await undoJournal(journals[3]);
  await check('先撤销最近一次：x.pdf 回到 root（内容 four）', async () => {
    assert.equal(undoLast.restored, 1);
    assert.equal(await readText(path.join(seqRoot, 'x.pdf')), 'four');
  });
  const undoThird = await undoJournal(journals[2]);
  await check('更早的计划因原位被占而拒绝回滚（安全但不完整）', () => {
    assert.equal(undoThird.restored, 0);
    assert.equal(undoThird.skipped, 1);
  });
  note(
    '顺序多次撞名后的撤销是“部分回滚”',
    '同一原名被多次 apply 后，只有最后一次能回原位；更早几次的日志因原位置被占全部 skipped，文件仍以 x (2)/x (3).pdf 留在 documents/，不会丢但撤不干净。',
  );

  // ---- 构造计划：两个不同源文件指向同一目标
  const dupRoot = await freshDir('s3-dupdest');
  await put(dupRoot, 'a.txt', 'AAA');
  await put(dupRoot, 'b.txt', 'BBB');
  const dupPlan = craftedPlan(dupRoot, [
    { from: 'a.txt', to: path.join('documents', 'same.txt'), size: 3 },
    { from: 'b.txt', to: path.join('documents', 'same.txt'), size: 3 },
  ]);
  let dupJournal = null;
  let dupCrash = null;
  try {
    dupJournal = await applyPlan(dupPlan);
  } catch (err) {
    dupCrash = err;
  }
  await check('构造的同目标计划：第二件改名 (2)，两件内容都在', async () => {
    assert.equal(dupCrash, null, String(dupCrash));
    assert.equal(await readText(path.join(dupRoot, 'documents', 'same.txt')), 'AAA');
    assert.equal(await readText(path.join(dupRoot, 'documents', 'same (2).txt')), 'BBB');
  });
  note('构造同名目标 Apply 结果', JSON.stringify(dupJournal?.entries?.map((entry) => ({ from: entry.from, to: entry.to, status: entry.status }))));

  // ---- 构造计划：a→b, b→a（交换）
  const swapRoot = await freshDir('s3-swap');
  await put(swapRoot, 'a.txt', 'AAA');
  await put(swapRoot, 'b.txt', 'BBB');
  const swapPlan = craftedPlan(swapRoot, [
    { from: 'a.txt', to: 'b.txt', size: 3 },
    { from: 'b.txt', to: 'a.txt', size: 3 },
  ]);
  const swapJournal = await applyPlan(swapPlan);
  await check('交换式计划不覆盖、不丢内容（结果可能不是用户预期的交换）', async () => {
    const names = (await fs.readdir(swapRoot)).filter((name) => name.endsWith('.txt')).sort();
    const values = [];
    for (const name of names) values.push(await readText(path.join(swapRoot, name)));
    assert.deepEqual(values.sort(), ['AAA', 'BBB']);
    assert.equal(names.includes('b (2).txt'), true);
    assert.equal(await readText(path.join(swapRoot, 'a.txt')), 'BBB');
  });
  note('交换式计划实际落点', JSON.stringify(swapJournal.entries.map((entry) => ({ from: entry.from, to: entry.to, status: entry.status }))));

  // ---- 重名耗尽 (2)..(999)
  const exhaustRoot = await freshDir('s3-exhaust');
  await put(exhaustRoot, 'ok.txt', 'OK');
  await put(exhaustRoot, 'x.pdf', 'X');
  await mkdirp(exhaustRoot, 'documents');
  await put(exhaustRoot, path.join('documents', 'x.pdf'), 'BASE');
  for (let n = 2; n <= 999; n += 1) await put(exhaustRoot, path.join('documents', `x (${n}).pdf`), `P${n}`);
  const { plan: exhaustPlan } = await buildPlan({ root: exhaustRoot, strategy: 'by-type', options: { depth: 1, junk: false }, now: NOW });
  let exhaustCrash = null;
  let exhaustJournal = null;
  try {
    exhaustJournal = await applyPlan(exhaustPlan);
  } catch (err) {
    exhaustCrash = err;
  }
  await check('重名耗尽（(2)..(999) 全占）：应记为 failed，而不是整次 apply 抛错中断', () => {
    assert.equal(exhaustCrash, null, `实际抛出: ${exhaustCrash?.message}`);
    const entry = exhaustJournal?.entries.find((item) => item.from === 'x.pdf');
    assert.equal(entry?.status, 'failed');
    assert.match(String(entry?.error), /占用|重名/);
    assert.equal(exhaustJournal?.moved, 1);
    assert.equal(exhaustJournal?.failed, 1);
  });
  await check('重名耗尽：其余条目继续执行，已移动文件有落盘日志', async () => {
    assert.equal(await readText(path.join(exhaustRoot, 'documents', 'ok.txt')), 'OK');
    const journals = await listJournals(exhaustRoot);
    assert.equal(journals.length, 1, `journals=${JSON.stringify(journals)}`);
  });
  await check('重名耗尽：不丢文件、不覆盖已有文件', async () => {
    assert.equal(await readText(path.join(exhaustRoot, 'documents', 'x.pdf')), 'BASE');
    assert.equal(await readText(path.join(exhaustRoot, 'x.pdf')), 'X');
  });

  // ---- 日志写入失败（.folder-janitor 被同名文件占住）
  const njRoot = await freshDir('s3-nojournal');
  await put(njRoot, 'a.txt', 'A');
  await fs.writeFile(path.join(njRoot, '.folder-janitor'), 'blocked');
  const njPlan = craftedPlan(njRoot, [{ from: 'a.txt', to: path.join('documents', 'a.txt'), size: 1 }]);
  let njCrash = null;
  try {
    await applyPlan(njPlan);
  } catch (err) {
    njCrash = err;
  }
  await check('状态目录不可创建时，apply 在动手前就拒绝（不移动任何文件）', async () => {
    assert.ok(njCrash, '期望抛错拒绝执行');
    assert.match(String(njCrash.message), /状态目录|拒绝/);
    assert.equal(await exists(path.join(njRoot, 'documents', 'a.txt')), false);
    assert.equal(await readText(path.join(njRoot, 'a.txt')), 'A');
    assert.equal(await readText(path.join(njRoot, '.folder-janitor')), 'blocked');
  });

  // ---- 大小写只差一个字母的撞名（平台限制 + 缓解逻辑）
  {
    const caseRoot = await freshDir('s3-case');
    await put(caseRoot, 'Photo.PNG', 'UPPER-CONTENT');
    await put(caseRoot, 'photo.png', 'lower-content');
    const caseNames = await fs.readdir(caseRoot);
    await check('Windows 同目录放不下两个仅大小写不同的文件（平台限制，记录）', async () => {
      assert.equal(caseNames.length, 1, JSON.stringify(caseNames));
      assert.equal(await readText(path.join(caseRoot, caseNames[0])), 'lower-content'); // 第二次写穿到同一文件
    });
    note('大小写同目录限制', `本机只能存在 ${JSON.stringify(caseNames[0])} 一个文件；第二件写入直接落到同一文件，所以无法用真实文件复现「两个仅大小写不同的源名」，下两条改为构造计划/日志验证缓解逻辑。`);
  }

  // 构造计划：两个条目的目标只差大小写
  {
    const root = await freshDir('s3-case-dest');
    await put(root, 'a.txt', 'AAA');
    await put(root, 'b.txt', 'BBB');
    const plan = craftedPlan(root, [
      { from: 'a.txt', to: path.join('documents', 'Photo.PNG'), size: 3 },
      { from: 'b.txt', to: path.join('documents', 'photo.png'), size: 3 },
    ]);
    const journal = await applyPlan(plan);
    await check('仅目标大小写不同的两个条目：第二件改名 (2)，不覆盖、不丢内容', async () => {
      const names = (await fs.readdir(path.join(root, 'documents'))).sort();
      assert.equal(names.length, 2, JSON.stringify(names));
      const values = [];
      for (const name of names) values.push(await readText(path.join(root, 'documents', name)));
      assert.deepEqual(values.sort(), ['AAA', 'BBB']);
      assert.equal(journal.entries[1].status, 'ok');
      assert.match(journal.entries[1].to, /\(2\)/);
    });
    const undo = await undoJournal(journal);
    await check('该计划撤销：两件都按原名回到 root', async () => {
      assert.equal(undo.restored, 2);
      assert.equal(await readText(path.join(root, 'a.txt')), 'AAA');
      assert.equal(await readText(path.join(root, 'b.txt')), 'BBB');
    });
  }

  // 构造日志：原位置被仅差大小写的同名文件占住
  {
    const root = await freshDir('s3-case-undo');
    await mkdirp(root, 'documents');
    await put(root, path.join('documents', 'Photo.PNG'), 'UP');
    await put(root, 'photo.png', 'LOW');
    const journal = {
      kind: 'folder-janitor/journal',
      journalId: 'journal-crafted-case',
      planId: 'p',
      root,
      entries: [{ from: 'Photo.PNG', to: path.join('documents', 'Photo.PNG'), status: 'ok', size: 2 }],
      createdDirs: [],
    };
    const undo = await undoJournal(journal);
    await check('撤销时原位置被仅差大小写的同名文件占住：skip 并给出专门原因', async () => {
      assert.equal(undo.restored, 0);
      assert.equal(undo.skipped, 1);
      assert.match(String(undo.entries[0]?.error), /大小写/);
      assert.equal(await readText(path.join(root, 'photo.png')), 'LOW');
      assert.equal(await readText(path.join(root, 'documents', 'Photo.PNG')), 'UP');
    });
  }
}

// ---------------------------------------------------------------- 4. 撤销的对抗场景

async function undoAdversarial() {
  // a) 目标内容被改成同样大小
  {
    const root = await freshDir('s4-samesize');
    await put(root, 'note.txt', 'AAAA');
    const { plan } = await buildPlan({ root, strategy: 'by-type', options: { depth: 1, junk: false }, now: NOW });
    const journal = await applyPlan(plan);
    await fs.writeFile(path.join(root, journal.entries[0].to), 'BBBB');
    const undo = await undoJournal(journal);
    await check('目标内容被改成同样大小后，撤销应拒绝回滚（改过的要跳过）', () => {
      assert.equal(undo.skipped, 1, `实际 restored=${undo.restored} skipped=${undo.skipped}`);
      assert.match(String(undo.entries[0]?.error), /mtime|内容被改过/);
    });
    await check('apply 的 journal 记录了 size + mtimeMs + hash，撤销才有依据比内容', () => {
      const entry = journal.entries[0];
      assert.equal(entry.status, 'ok');
      assert.equal(typeof entry.size, 'number');
      assert.equal(typeof entry.mtimeMs, 'number');
      assert.equal(typeof entry.hash, 'string');
      assert.equal(entry.hash.length, 32);
    });
    if (undo.restored === 1) {
      bug(
        '撤销只比文件大小，不比内容：同样大小的改动被当成“完好”静默回滚',
        '移动后内容被改过（即使大小不变）应 skip 并提示“内容变了”',
        `documents/note.txt 被改成 BBBB（4 字节）后 undo：restored=1，文件被移回 root/note.txt，内容是 BBBB，不是原始的 AAAA`,
        'lib/apply.js:199-202（只比较 stat.size）、lib/apply.js:168-169 的注释承诺“已经被用户改过…一律跳过”',
      );
    }
  }

  // b) 目标内容变长
  {
    const root = await freshDir('s4-diffsize');
    await put(root, 'note.txt', 'AAAA');
    const { plan } = await buildPlan({ root, strategy: 'by-type', options: { depth: 1, junk: false }, now: NOW });
    const journal = await applyPlan(plan);
    await fs.writeFile(path.join(root, journal.entries[0].to), 'AAAA-plus');
    const undo = await undoJournal(journal);
    await check('目标内容变长后撤销被拒绝，文件原地保留', async () => {
      assert.equal(undo.restored, 0);
      assert.equal(undo.skipped, 1);
      assert.equal(await readText(path.join(root, 'documents', 'note.txt')), 'AAAA-plus');
      assert.equal(await exists(path.join(root, 'note.txt')), false);
    });
  }

  // c) 目标被删
  {
    const root = await freshDir('s4-deleted');
    await put(root, 'note.txt', 'AAAA');
    const { plan } = await buildPlan({ root, strategy: 'by-type', options: { depth: 1, junk: false }, now: NOW });
    const journal = await applyPlan(plan);
    await fs.unlink(path.join(root, journal.entries[0].to));
    const undo = await undoJournal(journal);
    await check('目标被删后撤销：跳过、不崩、不凭空造文件', async () => {
      assert.equal(undo.restored, 0);
      assert.equal(undo.skipped, 1);
      assert.equal(await exists(path.join(root, 'note.txt')), false);
    });
  }

  // d) 原位置被新文件占住
  {
    const root = await freshDir('s4-occupied');
    await put(root, 'note.txt', 'AAAA');
    const { plan } = await buildPlan({ root, strategy: 'by-type', options: { depth: 1, junk: false }, now: NOW });
    const journal = await applyPlan(plan);
    await put(root, 'note.txt', 'NEW');
    const undo = await undoJournal(journal);
    await check('原位置被新文件占住：拒绝回滚，两份文件都保留', async () => {
      assert.equal(undo.restored, 0);
      assert.equal(undo.skipped, 1);
      assert.equal(await readText(path.join(root, 'note.txt')), 'NEW');
      assert.equal(await readText(path.join(root, 'documents', 'note.txt')), 'AAAA');
    });
  }

  // e) 撤销两次
  {
    const root = await freshDir('s4-twice');
    await put(root, 'note.txt', 'AAAA');
    const { plan } = await buildPlan({ root, strategy: 'by-type', options: { depth: 1, junk: false }, now: NOW });
    const journal = await applyPlan(plan);
    const first = await undoJournal(journal);
    const afterFirst = await snap(root);
    const second = await undoJournal(journal);
    await check('撤销两次：第二次全部 skipped，不重复搬动', async () => {
      assert.equal(first.restored, 1);
      assert.equal(second.restored, 0);
      assert.equal(second.skipped, 1);
      assertSnapshotEqual(afterFirst, await snap(root), '');
    });
  }

  // f1) 用户原有空目录不能被当成“本次新建”
  {
    const root = await freshDir('s4-userdir');
    await mkdirp(root, 'documents');
    await put(root, 'a.txt', 'AAA');
    const before = await snap(root);
    const { plan } = await buildPlan({ root, strategy: 'by-type', options: { depth: 1, junk: false }, now: NOW });
    const journal = await applyPlan(plan);
    const undo = await undoJournal(journal);
    await check('用户原有空目录 documents/ 在撤销后仍然存在', async () => {
      assert.equal(undo.prunedDirs, 0);
      assert.ok(await exists(path.join(root, 'documents')));
      assertSnapshotEqual(before, await snap(root), '');
    });
  }

  // f2) 用户往“本次新建”的目录里放了文件：目录不能被删
  {
    const root = await freshDir('s4-usercontent');
    await put(root, 'a.txt', 'AAA');
    const { plan } = await buildPlan({ root, strategy: 'by-type', options: { depth: 1, junk: false }, now: NOW });
    const journal = await applyPlan(plan);
    await put(root, path.join('documents', 'user-note.txt'), 'USER');
    const undo = await undoJournal(journal);
    await check('撤销只删自己建的空目录：目录里有用户文件时保留整个目录', async () => {
      assert.equal(undo.restored, 1);
      assert.equal(undo.prunedDirs, 0);
      assert.equal(await readText(path.join(root, 'documents', 'user-note.txt')), 'USER');
      assert.equal(await readText(path.join(root, 'a.txt')), 'AAA');
    });
  }

  // f3) 深层新建目录里被用户塞了文件
  {
    const root = await freshDir('s4-usernested');
    await put(root, path.join('sub', 'c.txt'), 'CCC');
    const { plan } = await buildPlan({ root, strategy: 'by-type', options: { depth: 2, junk: false }, now: NOW });
    const journal = await applyPlan(plan);
    await put(root, path.join('documents', 'sub', 'user.txt'), 'USER2');
    const undo = await undoJournal(journal);
    await check('嵌套新建目录被用户占用时，撤销不删目录且文件各回原位', async () => {
      assert.equal(undo.restored, 1);
      assert.equal(undo.prunedDirs, 0);
      assert.equal(await readText(path.join(root, 'sub', 'c.txt')), 'CCC');
      assert.equal(await readText(path.join(root, 'documents', 'sub', 'user.txt')), 'USER2');
    });
  }

  // g) 构造 journal 把文件还原到 root 之外
  {
    const base = await freshDir('s4-escape');
    const root = path.join(base, 'root');
    const outside = path.join(base, 'outside');
    await fs.mkdir(root);
    await fs.mkdir(outside);
    await put(root, 'inside.txt', 'SECRET');
    const crafted = {
      kind: 'folder-janitor/journal',
      journalId: 'journal-crafted-escape',
      planId: 'plan-crafted-escape',
      root,
      entries: [{ from: path.join('..', 'outside', 'restored.txt'), to: 'inside.txt', status: 'ok', size: 6 }],
      createdDirs: [],
    };
    const dry = await undoJournal(crafted, { dryRun: true });
    await check('撤销不得把文件还原到 root 之外（构造日志）', () => {
      assert.equal(dry.restored, 0, `dryRun 也认为可以还原到 ${path.join(outside, 'restored.txt')}`);
    });
    const real = await undoJournal(crafted);
    const escaped = await exists(path.join(outside, 'restored.txt'));
    if (escaped) {
      bug(
        'undoJournal 没有 insideRoot 守卫：日志里的 from 可解析到 root 之外并真的搬文件',
        '撤销只允许在 journal.root 内部移动；越界条目应 failed/skipped',
        `构造 from="../outside/restored.txt" 的日志后，undo 把 root/inside.txt 搬到了 ${path.join(outside, 'restored.txt')}（restored=${real.restored}）`,
        'lib/apply.js:185-218（未调用 insideRoot，对照 apply.js:87）',
      );
    }
  }

  // h) 整理根目录被改名后，同名新目录被旧日志改动
  {
    const base = await freshDir('s4-stale');
    const orig = path.join(base, 'root');
    const renamed = path.join(base, 'renamed');
    await fs.mkdir(orig);
    await put(orig, 'a.pdf', 'OLD');
    const { plan } = await buildPlan({ root: orig, strategy: 'by-type', options: { depth: 1, junk: false }, now: NOW });
    await applyPlan(plan);
    const journalIds = await listJournals(orig);
    const journal = await loadJournalByPath(path.join(orig, '.folder-janitor', 'journals', `${journalIds[0]}.json`));
    await fs.rename(orig, renamed);
    const reused = path.join(base, 'root');
    await fs.mkdir(reused);
    await put(reused, path.join('documents', 'a.pdf'), 'NEW'); // 同名、同大小
    const undo = await undoJournal(journal);
    const reusedFile = await exists(path.join(reused, 'a.pdf'));
    await check('整理根目录改名、旧路径被新目录复用时，旧日志不得改动新目录', () => {
      assert.equal(undo.restored, 0, `实际 restored=${undo.restored}；新目录的 documents/a.pdf 被搬到了 root/a.pdf`);
      assert.ok(
        undo.warnings.some((warning) => /拒绝回滚|状态标识|不是当初整理的那个/.test(warning)),
        `缺 warning: ${JSON.stringify(undo.warnings)}`,
      );
    });
    if (reusedFile) {
      bug(
        'journal.root 是绝对路径：目录改名后 old path 被复用，撤销会改动一个完全无关的新目录',
        '撤销前应确认 journal.root 与当前目录一致；或至少校验文件内容哈希，发现不是自己移的文件就拒绝',
        `root/ 已改名为 renamed/；新建同名 root/ 后 undo：新目录的 documents/a.pdf 被移动到 root/a.pdf（内容 NEW，文件数被改动），真正的旧文件还在 renamed/documents/a.pdf`,
        'lib/apply.js:172（root 取 journal.root）、lib/index.js:225-231（按路径加载日志时不覆盖 root）',
      );
    }
  }

  // i) 目标被换成同名目录
  {
    const root = await freshDir('s4-dirtarget');
    await put(root, '_empty.txt', '');
    const { plan } = await buildPlan({ root, strategy: 'by-type', options: { depth: 1, junk: true }, now: NOW });
    const journal = await applyPlan(plan);
    const targetRel = journal.entries[0].to;
    await fs.unlink(path.join(root, targetRel));
    await fs.mkdir(path.join(root, targetRel));
    const undo = await undoJournal(journal);
    const movedAsDir = await fs.lstat(path.join(root, '_empty.txt')).then((stat) => stat.isDirectory()).catch(() => false);
    await check('目标被换成同名目录后，撤销不得把目录当文件搬回', () => {
      assert.equal(undo.restored, 0, `实际 restored=${undo.restored}；root/_empty.txt 现在是目录`);
    });
    if (movedAsDir) {
      bug(
        '撤销缺类型检查：0 字节文件的目标位置被换成空目录后，undo 把整个目录 rename 回成文件路径',
        '撤销应确认 to 仍是普通文件（isFile），类型不符则 skip',
        `原 0 字节 junk 文件移到 ${targetRel} 后，该路径被替换成空目录；undo restored=${undo.restored}，root/_empty.txt 现在是一个目录`,
        'lib/apply.js:191-198（只用 fs.stat 比较 size，未检查 stat.isFile；Windows 目录 size=0 恰好等于 entry.size=0）',
      );
    }
  }

  // j) undo dryRun 零写入
  {
    const root = await freshDir('s4-undodry');
    await put(root, 'note.txt', 'AAAA');
    const { plan } = await buildPlan({ root, strategy: 'by-type', options: { depth: 1, junk: false }, now: NOW });
    const journal = await applyPlan(plan);
    const before = await snap(root, { includeState: true, withMtime: true });
    const dry = await undoJournal(journal, { dryRun: true });
    const after = await snap(root, { includeState: true, withMtime: true });
    await check('undo dryRun 报告 would-restore 且磁盘逐项不变（含 mtime 与状态目录）', () => {
      assert.equal(dry.restored, 1);
      assertSnapshotEqual(before, after, '');
    });
  }

  // j2) 根目录身份缺失时 undo dryRun 是否仍然零写入
  {
    const root = await freshDir('s4-undodry-id');
    await mkdirp(root, 'documents');
    await put(root, path.join('documents', 'x.txt'), 'X');
    const crafted = {
      kind: 'folder-janitor/journal',
      journalId: 'journal-crafted-dryid',
      planId: 'p',
      root,
      stateId: 'deadbeefdeadbeef',
      entries: [{ from: 'x.txt', to: path.join('documents', 'x.txt'), status: 'ok', size: 1 }],
      createdDirs: [],
    };
    const before = await snap(root, { includeState: true, withMtime: true });
    const dry = await undoJournal(crafted, { dryRun: true });
    const after = await snap(root, { includeState: true, withMtime: true });
    await check('undo dryRun 在根目录身份缺失/不符时也必须零写入', () => {
      assert.equal(dry.restored, 0);
      assertSnapshotEqual(before, after, '');
    });
    const diff = diffSnapshot(before, after);
    if (diff.added.length > 0 || diff.changed.length > 0) {
      bug(
        'undoJournal 的 dryRun 会写盘：校验根目录身份时调用 ensureStateId，等于给目录凭空建 .folder-janitor/id',
        '撤销预演（dryRun）不得创建/修改任何文件，包括状态目录',
        `构造 stateId 不匹配的日志后 undo({dryRun:true})：新增 ${JSON.stringify(diff)}`,
        'lib/apply.js:276-289（身份校验前置于 dryRun 分支）；lib/store.js:19-32（ensureStateId 会 mkdir + 写 id）',
      );
    }
  }
}

// ---------------------------------------------------------------- 5. dryRun 零写入

async function dryRun() {
  const root = await freshDir('s5-dry');
  await put(root, 'x.pdf', 'DRY-X');
  await put(root, 'photo.png', 'DRY-P');
  await put(root, '_draft.js', 'DRY-JUNK');
  await put(root, 'empty.txt', '');
  await put(root, path.join('documents', 'x.pdf'), 'PRE-EXISTING');
  await put(root, path.join('sub', 'nested.md'), 'NESTED');
  const { plan } = await buildPlan({ root, strategy: 'by-type', options: { depth: 1, junk: true }, now: NOW });

  const before = await snap(root, { includeState: true, withMtime: true });
  const journalsBefore = await journalCount(root);
  const dry = await applyPlan(plan, { dryRun: true });
  const after = await snap(root, { includeState: true, withMtime: true });

  await check('dryRun 不改变磁盘任何一个字节/mtime（含 .folder-janitor 状态）', () => {
    assertSnapshotEqual(before, after, '');
  });
  await check('dryRun 不新增 journal 文件', async () => {
    assert.equal(await journalCount(root), journalsBefore);
  });
  await check('dryRun 报告 would-move，且没有 ok/failed 状态', () => {
    assert.equal(dry.moved, plan.entries.length);
    assert.equal(dry.failed, 0);
    for (const entry of dry.entries) assert.equal(entry.status, 'would-move');
  });
  await check('dryRun 预测了撞名改名（x.pdf → documents/x (2).pdf）', () => {
    const x = dry.entries.find((entry) => entry.from === 'x.pdf');
    assert.equal(x.to, path.join('documents', 'x (2).pdf'));
    assert.equal(x.collision, true);
  });
  await check('dryRun 不创建 _trash / images 等目标目录', async () => {
    assert.equal(await exists(path.join(root, '_trash')), false);
    assert.equal(await exists(path.join(root, 'images')), false);
  });
  await check('dryRun 之后真实 apply 与预测一致', async () => {
    const journal = await applyPlan(plan, {});
    for (const predicted of dry.entries) {
      const actual = journal.entries.find((entry) => entry.from === predicted.from);
      assert.equal(actual.to, predicted.to, `预测 ${predicted.from}→${predicted.to}，实际 ${actual.to}`);
    }
    assert.equal(journal.verified, journal.moved);
  });
}

// ---------------------------------------------------------------- 6. 幂等 / 重复执行 / 并发

async function idempotency() {
  // a) 同一计划连跑两次
  {
    const root = await freshDir('s6-idem');
    await put(root, 'photo.png', 'P');
    await put(root, 'a.pdf', 'A');
    await put(root, 'b.txt', 'B');
    await put(root, '_draft.js', 'JUNK');
    await put(root, 'empty.txt', '');
    await put(root, path.join('documents', 'keep.pdf'), 'KEEP');
    await put(root, path.join('sub', 'nested.pdf'), 'NESTED');
    const beforeHashes = await snapHashes(root);
    const { plan } = await buildPlan({ root, strategy: 'by-type', options: { depth: 1, junk: true }, now: NOW });
    const journal = await applyPlan(plan);
    const afterFirst = await snap(root, { withMtime: true });
    const journalsAfterFirst = await journalCount(root);
    let crash = null;
    let second = null;
    try {
      second = await applyPlan(plan);
    } catch (err) {
      crash = err;
    }
    const afterSecond = await snap(root, { withMtime: true });
    await check('同一计划连续 apply 两次：第二次全部 skipped、moved=0、不抛错', () => {
      assert.equal(crash, null, String(crash));
      assert.equal(second.moved, 0);
      assert.equal(second.failed, 0);
      assert.equal(second.skipped, plan.entries.length);
    });
    await check('第二次 apply 只多一份零移动日志，业务文件逐项不变', () => {
      assertSnapshotEqual(afterFirst, afterSecond, '');
    });
    await check('第二次 apply 会写一份零移动 journal（当前设计如此）', async () => {
      assert.equal(await journalCount(root), journalsAfterFirst + 1);
    });
    await check('执行后重新出 by-type 计划为空（幂等）', async () => {
      const { plan: again } = await buildPlan({ root, strategy: 'by-type', options: { depth: 1, junk: true }, now: NOW });
      assert.equal(again.entries.length, 0);
    });
    await check('第一次执行内容守恒', async () => {
      const hashesNow = await snapHashes(root);
      assertContentConserved(beforeHashes, hashesNow);
      assert.equal(hashesNow.size, 7);
    });
    await undoJournal(journal);
  }

  // b) by-date / dedupe / archive-old 再跑一次
  {
    const root = await freshDir('s6-idem-date');
    await put(root, 'a.pdf', 'A');
    await put(root, 'b.md', 'B');
    const { plan } = await buildPlan({ root, strategy: 'by-date', options: { depth: 1, junk: false }, now: NOW });
    await applyPlan(plan);
    await check('by-date 执行后重新出计划为空', async () => {
      const { plan: again } = await buildPlan({ root, strategy: 'by-date', options: { depth: 1, junk: false }, now: NOW });
      assert.equal(again.entries.length, 0);
    });
  }
  {
    const root = await freshDir('s6-idem-dedupe');
    await put(root, 'dup1.txt', 'SAME');
    await put(root, 'dup2.txt', 'SAME');
    const { plan } = await buildPlan({ root, strategy: 'dedupe', options: { depth: 1 }, now: NOW });
    await applyPlan(plan);
    await check('dedupe 执行后重新出计划为空', async () => {
      const { plan: again } = await buildPlan({ root, strategy: 'dedupe', options: { depth: 1 }, now: NOW });
      assert.equal(again.entries.length, 0);
    });
  }
  {
    const root = await freshDir('s6-idem-archive');
    const old = await put(root, 'old.pdf', 'OLD');
    const past = new Date(NOW - 400 * DAY);
    await fs.utimes(old, past, past);
    const { plan } = await buildPlan({ root, strategy: 'archive-old', options: { depth: 1, junk: false }, now: NOW });
    await applyPlan(plan);
    await check('archive-old 执行后重新出计划为空', async () => {
      const { plan: again } = await buildPlan({ root, strategy: 'archive-old', options: { depth: 1, junk: false }, now: NOW });
      assert.equal(again.entries.length, 0);
    });
  }

  // c) 同一计划并发 apply
  {
    const root = await freshDir('s6-race');
    const names = [];
    for (let i = 1; i <= 30; i += 1) {
      const name = `f${String(i).padStart(2, '0')}.txt`;
      names.push(name);
      await put(root, name, `content-${i}`);
    }
    const beforeHashes = await snapHashes(root);
    const { plan } = await buildPlan({ root, strategy: 'by-type', options: { depth: 1, junk: false }, now: NOW });
    const settled = await Promise.allSettled([applyPlan(plan), applyPlan(plan)]);
    const outcomes = settled.filter((result) => result.status === 'fulfilled').map((result) => result.value);
    const rejections = settled.filter((result) => result.status === 'rejected').map((result) => result.reason);
    await check('同一计划并发 apply：锁生效，恰好一个执行、另一个被拒绝', () => {
      assert.equal(outcomes.length, 1, `成功 ${outcomes.length} 个；拒绝: ${rejections.map(String).join(' | ')}`);
      assert.equal(rejections.length, 1);
      assert.match(String(rejections[0]?.message), /正在执行|另一个整理任务|lock/);
    });
    await check('并发被拒的那次不写 journal：只有一份落盘日志', async () => {
      assert.equal(await journalCount(root), 1);
    });
    await check('并发结束后锁文件已释放（下一轮不会被挡）', async () => {
      assert.equal(await exists(path.join(root, '.folder-janitor', 'lock')), false);
    });
    await check('并发 apply 后内容多重集不变（不丢不覆盖）', async () => {
      assertContentConserved(beforeHashes, await snapHashes(root));
    });
    await check('并发 apply 后 documents/ 里正好 30 个文件，日志声称的落点都真实存在', async () => {
      const namesInDir = await fs.readdir(path.join(root, 'documents'));
      assert.equal(namesInDir.length, 30);
      for (const journal of outcomes) {
        for (const entry of journal.entries) {
          if (entry.status !== 'ok') continue;
          assert.equal(await exists(path.join(root, entry.to)), true, `journal 声称 ok 但落点不存在: ${entry.to}`);
        }
      }
    });
    note(
      '并发 apply 的实际账本（锁已修复重复记账）',
      JSON.stringify(outcomes.map((journal) => ({ moved: journal.moved, skipped: journal.skipped, failed: journal.failed }))) +
        `；被拒: ${rejections.map((err) => err?.message).join(' | ')}`,
    );
    for (const journal of outcomes) await undoJournal(journal);
    await check('并发执行后撤销，文件内容仍守恒', async () => {
      assertContentConserved(beforeHashes, await snapHashes(root));
    });
  }

  // d) 两份不同计划并发 apply
  {
    const root = await freshDir('s6-two-plans');
    for (let i = 1; i <= 10; i += 1) {
      await put(root, `doc${i}.pdf`, `D${i}`);
      await put(root, `img${i}.png`, `I${i}`);
    }
    const before = await snapHashes(root);
    const { plan: typePlan } = await buildPlan({ root, strategy: 'by-type', options: { depth: 1, junk: false }, now: NOW });
    const { plan: datePlan } = await buildPlan({ root, strategy: 'by-date', options: { depth: 1, junk: false }, now: NOW });
    const settled = await Promise.allSettled([applyPlan(typePlan), applyPlan(datePlan)]);
    const outcomes = settled.filter((result) => result.status === 'fulfilled').map((result) => result.value);
    const rejections = settled.filter((result) => result.status === 'rejected').map((result) => result.reason);
    await check('两份不同计划并发 apply：锁让第二份被拒，只有一份执行', () => {
      assert.equal(outcomes.length, 1, `成功 ${outcomes.length} 个；拒绝: ${rejections.map(String).join(' | ')}`);
      assert.equal(rejections.length, 1);
      assert.match(String(rejections[0]?.message), /正在执行|另一个整理任务|lock/);
    });
    await check('两份不同计划并发 apply 后内容不丢', async () => {
      assertContentConserved(before, await snapHashes(root));
    });
    note(
      '两份不同计划并发 apply 的账本',
      JSON.stringify(outcomes.map((journal) => ({ moved: journal.moved, skipped: journal.skipped, failed: journal.failed }))) +
        `；被拒: ${rejections.map((err) => err?.message).join(' | ')}`,
    );
  }

  // e) 撤销后可以重新 apply
  {
    const root = await freshDir('s6-cycle');
    await put(root, 'a.pdf', 'A');
    const { plan } = await buildPlan({ root, strategy: 'by-type', options: { depth: 1, junk: false }, now: NOW });
    const journal = await applyPlan(plan);
    await undoJournal(journal);
    const again = await applyPlan(plan);
    await check('撤销后重新 apply 同一计划仍可执行', async () => {
      assert.equal(again.moved, 1);
      assert.equal(await readText(path.join(root, 'documents', 'a.pdf')), 'A');
    });
  }
}

// ---------------------------------------------------------------- 7. by-project 聚类质量

async function byProject() {
  // 纯函数：恰好 60% 边界已在 0 节测过。这里测真实计划。
  const root = await freshDir('s7-project');
  const files = [
    'payroll-march.xlsx',
    'march-trip.jpg',
    '卡洛·斯卡帕学习手册.md',
    '斯卡帕学习手册_封面.png',
    '斯卡帕_平面图.pdf',
    'Nobel-Brief.md',
    'nobel-figures.md',
    'ai-model.md',
    'ai-notes.md',
    'deadbeef-report.md',
    'deadbeef-notes.md',
    `${LONG_PROJECT_CJK}-笔记.md`,
    `${LONG_PROJECT_CJK}-封面.png`,
    '2026-10-budget.xlsx',
    '2026-10-plan.md',
    '重返提帕萨_图文导读.html',
    '重返提帕萨_图文导读.pdf',
    'quasar-notes.md',
    'final-report.md',
    'final-notes.md',
  ];
  for (const name of files) await put(root, name, `content of ${name}`);
  // 预置一个已有的项目目录 + 同名目标，验证不覆盖
  await put(root, path.join('nobel', 'Nobel-Brief.md'), 'OLD-PRE');
  await put(root, path.join('nobel', 'extra.md'), 'NESTED');

  const { plan } = await buildPlan({ root, strategy: 'by-project', options: { depth: 1, junk: false }, now: NOW });
  const groups = new Map();
  for (const entry of plan.entries) {
    const folder = entry.to.split(path.sep)[0];
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(entry.from);
  }
  const groupSummary = Object.fromEntries([...groups.entries()].map(([folder, list]) => [folder, list.sort()]));
  console.log(`  by-project 实际分组: ${JSON.stringify(groupSummary)}`);
  console.log(`  by-project 未归类: ${JSON.stringify(plan.skipped.map((entry) => entry.from))}`);

  await check('nobel（大小写不同）聚成一组', () => {
    assert.ok(groups.has('nobel'));
    assert.deepEqual(groups.get('nobel').sort(), ['Nobel-Brief.md', 'nobel-figures.md']);
  });
  await check('CJK 项目“斯卡帕学习手册”两件聚成一组', () => {
    const group = [...groups.entries()].find(([folder]) => folder === '斯卡帕学习手册');
    assert.ok(group, `实际分组 ${JSON.stringify(groupSummary)}`);
    assert.deepEqual(group[1].sort(), ['卡洛·斯卡帕学习手册.md', '斯卡帕学习手册_封面.png']);
  });
  await check('重返提帕萨 两件聚成一组', () => {
    assert.ok(groups.has('重返提帕萨'));
    assert.deepEqual(groups.get('重返提帕萨').sort(), ['重返提帕萨_图文导读.html', '重返提帕萨_图文导读.pdf']);
  });
  await check('by-project 只整理根目录散落文件，嵌套文件 skip', async () => {
    const nested = await buildPlan({ root, strategy: 'by-project', options: { depth: 2, junk: false }, now: NOW });
    assert.ok(!nested.plan.entries.some((entry) => entry.from.startsWith('nobel' + path.sep)));
    assert.ok(nested.plan.skipped.some((entry) => entry.from.startsWith('nobel' + path.sep)));
  });

  await check('调整后的停用词把 notes/plan 挡在项目名之外（不再跨项目误合并）', () => {
    assert.equal(groups.has('notes'), false);
    assert.equal(groups.has('plan'), false);
  });
  await check('月份词与 report 停用后，march/report 误聚类消失', () => {
    assert.equal(groups.has('march'), false, JSON.stringify(groupSummary));
    assert.equal(groups.has('report'), false, JSON.stringify(groupSummary));
  });

  // 聚类质量问题（记录，不当成安全承诺）
  const misGrouped = [];
  if (misGrouped.length > 0) note('by-project 错误归组', misGrouped.join('；'));

  const ungrouped = plan.skipped.map((entry) => entry.from);
  const expectedMisses = [];
  if (ungrouped.includes('斯卡帕_平面图.pdf')) expectedMisses.push('斯卡帕_平面图.pdf 与同项目两件分不到一组（CJK 无分词，唯一重叠词是“斯卡帕”，另一个文件里的“斯卡帕”嵌在“卡洛·斯卡帕学习手册”整词中）');
  if (ungrouped.includes('斯卡帕学习手册_封面.png')) expectedMisses.push('斯卡帕学习手册_封面.png 与 长CJK-封面.png 共享“封面”却都没归组：前者被更长的“斯卡帕学习手册”占走，后者只剩单文件组被丢弃（最稀有词策略会把两条文件的小组拆散）');
  if (ungrouped.includes('ai-model.md')) expectedMisses.push('ai-model.md 与 ai-notes.md 都不聚类（2 字母词 ai 被丢弃；notes 已被停用）');
  if (ungrouped.includes('deadbeef-report.md')) expectedMisses.push('deadbeef-report/notes 的公共词 deadbeef 因像哈希被丢弃，两个文件被拆开');
  if (ungrouped.some((name) => name.startsWith(LONG_PROJECT_CJK))) expectedMisses.push('超过 24 个汉字的项目词被整个丢弃，同项目的两个文件都没归类');
  if (ungrouped.includes('2026-10-budget.xlsx')) expectedMisses.push('2026-10-* 的同日期前缀不参与聚类（数字被丢）');
  if (expectedMisses.length > 0) note('by-project 漏聚类', expectedMisses.join('；'));

  await check('by-project 执行：项目目录下的内容全部守恒', async () => {
    const beforeHashes = await snapHashes(root);
    const journal = await applyPlan(plan);
    assert.equal(journal.failed, 0, JSON.stringify(journal.entries.filter((entry) => entry.status !== 'ok')));
    assertContentConserved(beforeHashes, await snapHashes(root));
    assert.equal(await readText(path.join(root, 'nobel', 'Nobel-Brief.md')), 'OLD-PRE');
    const nobelNames = await fs.readdir(path.join(root, 'nobel'));
    assert.ok(nobelNames.includes('Nobel-Brief (2).md'), `实际 nobel 目录: ${nobelNames}`);
    assert.equal(await readText(path.join(root, 'nobel', 'Nobel-Brief (2).md')), 'content of Nobel-Brief.md');
    const undo = await undoJournal(journal);
    assert.ok(undo.restored === journal.entries.length, `restored=${undo.restored} entries=${journal.entries.length}`);
    assert.equal(await readText(path.join(root, 'Nobel-Brief.md')), 'content of Nobel-Brief.md');
    assert.equal(await readText(path.join(root, 'nobel', 'Nobel-Brief.md')), 'OLD-PRE');
  });
}

// ---------------------------------------------------------------- 8. 边界（空目录/文件作 root/盘符/怪路径/旁路）

async function boundaries() {
  // 空目录 / 只有子目录
  {
    const root = await freshDir('s8-empty');
    const inventory = await buildInventory(root, { maxDepth: -1, hashes: true });
    await check('空目录：inventory 0 文件、给“没有可整理”建议', () => {
      assert.equal(inventory.files, 0);
      assert.ok(inventory.suggestions[0]?.includes('没有可整理'));
    });
    const { plan } = await buildPlan({ root, strategy: 'by-type', options: { depth: -1, junk: true }, now: NOW });
    await check('空目录：计划 0 条目且有 warning', () => {
      assert.equal(plan.entries.length, 0);
      assert.ok(plan.warnings.some((warning) => warning.includes('没有需要移动')));
    });
    const journal = await applyPlan(plan);
    await check('空目录：apply moved=0，写一份零移动 journal（当前设计）', async () => {
      assert.equal(journal.moved, 0);
      assert.equal(await journalCount(root), 1);
    });
  }
  {
    const root = await freshDir('s8-onlydirs');
    await mkdirp(root, path.join('a', 'b', 'c'));
    const inventory = await buildInventory(root, { maxDepth: -1, hashes: false });
    await check('只有子目录没有文件：files=0、dirs=3、计划为空', async () => {
      assert.equal(inventory.files, 0);
      assert.equal(inventory.dirs, 3);
      const { plan } = await buildPlan({ root, strategy: 'by-type', options: { depth: -1 }, now: NOW });
      assert.equal(plan.entries.length, 0);
    });
  }

  // root 是文件 / 不存在 / 状态目录被占用
  {
    const root = await freshDir('s8-badroot');
    const file = await put(root, 'iamfile.txt', 'F');
    let err = null;
    try {
      await buildPlan({ root: file, strategy: 'by-type' });
    } catch (error) {
      err = error;
    }
    await check('root 是文件：明确报“不是目录”，不写盘', () => {
      assert.match(String(err?.message), /不是目录/);
    });
    const missing = path.join(ROOT, 's8-does-not-exist');
    let missingErr = null;
    try {
      await buildPlan({ root: missing, strategy: 'by-type' });
    } catch (error) {
      missingErr = error;
    }
    await check('root 不存在：明确报“目录不存在”', () => {
      assert.match(String(missingErr?.message), /目录不存在/);
    });
    await check('root 不存在时没有在旁边创建状态目录', async () => {
      assert.equal(await exists(path.join(ROOT, '.folder-janitor')), false);
    });
  }
  {
    const root = await freshDir('s8-stateblocked');
    await put(root, 'a.txt', 'A');
    await fs.writeFile(path.join(root, '.folder-janitor'), 'block');
    let err = null;
    try {
      await buildPlan({ root, strategy: 'by-type', options: { depth: 1 } });
    } catch (error) {
      err = error;
    }
    await check('状态目录位置被同名文件占用：buildPlan 失败但不碰用户文件', async () => {
      assert.ok(err, '期望抛错');
      assert.equal(await readText(path.join(root, 'a.txt')), 'A');
      assert.equal(await readText(path.join(root, '.folder-janitor')), 'block');
    });
    note('状态目录被文件占用的报错', String(err?.message));
  }

  // root 路径含空格/CJK/emoji/百分号/单引号 + 相对路径 + 尾随 ..
  {
    const weird = await freshDir("s8 root 空格 🚀 100% 'quote'");
    await put(weird, '报告 2026.pdf', 'REPORT');
    await put(weird, 'photo 🖼️.png', 'PHOTO');
    const before = await snap(weird);
    const absolutePlan = await buildPlan({ root: weird, strategy: 'by-type', options: { depth: 1, junk: false }, now: NOW });
    await check('怪路径（空格 emoji % 单引号）：计划落盘与执行成功', async () => {
      assert.equal(absolutePlan.plan.root, path.resolve(weird));
      assert.ok(await exists(absolutePlan.file));
      const journal = await applyPlan(absolutePlan.plan);
      assert.equal(journal.failed, 0);
      assert.equal(await readText(path.join(weird, 'documents', '报告 2026.pdf')), 'REPORT');
      const undo = await undoJournal(journal);
      assert.equal(undo.restored, 2);
      assertSnapshotEqual(before, await snap(weird), '');
    });

    const relRoot = path.relative(process.cwd(), weird);
    const relativePlan = await buildPlan({ root: relRoot, strategy: 'by-type', options: { depth: 1, junk: false }, now: NOW });
    await check('相对 root（含怪字符）解析成绝对路径', () => {
      assert.equal(relativePlan.plan.root, path.resolve(weird));
    });

    const dotted = await buildPlan({ root: path.join(weird, '.', 'sub', '..'), strategy: 'by-type', options: { depth: 1, junk: false }, now: NOW });
    await check('root 里的 . / sub/.. 被规范化', () => {
      assert.equal(dotted.plan.root, path.resolve(weird));
    });
  }

  // 结构文件保护（新行为）+ keep 自定义模式
  {
    const root = await freshDir('s8-structural');
    await put(root, 'README.md', 'README');
    await put(root, 'package.json', '{}');
    await put(root, '.gitignore', 'node_modules');
    await put(root, 'AGENTS.md', 'AGENT');
    await put(root, 'notes.md', 'NOTE');
    await put(root, 'trace.log', 'LOG');
    const { plan } = await buildPlan({ root, strategy: 'by-type', options: { depth: 1, junk: true }, now: NOW });
    await check('结构文件（README/package.json/AGENTS/.gitignore）不进计划、不被 junk 收走', () => {
      assert.deepEqual(plan.entries.map((entry) => entry.from).sort(), ['notes.md', 'trace.log']);
      for (const name of ['README.md', 'package.json', '.gitignore', 'AGENTS.md']) {
        assert.ok(plan.skipped.some((entry) => entry.from === name), `${name} 没被结构文件规则挡下`);
      }
    });
    const { plan: keepPlan } = await buildPlan({
      root,
      strategy: 'by-type',
      options: { depth: 1, junk: false, keep: ['*.log'] },
      now: NOW,
    });
    await check('keep 自定义模式（*.log）生效', () => {
      assert.ok(!keepPlan.entries.some((entry) => entry.from === 'trace.log'));
      assert.ok(keepPlan.skipped.some((entry) => entry.from === 'trace.log'));
    });
    const journal = await applyPlan(plan);
    await check('结构文件在 apply 后原地未动，其它文件正常移动', async () => {
      assert.equal(journal.moved, 2);
      assert.equal(await readText(path.join(root, 'README.md')), 'README');
      assert.equal(await readText(path.join(root, 'package.json')), '{}');
      assert.equal(await readText(path.join(root, '.gitignore')), 'node_modules');
      assert.equal(await readText(path.join(root, 'AGENTS.md')), 'AGENT');
      assert.equal(await readText(path.join(root, 'documents', 'notes.md')), 'NOTE');
    });
  }

  // 合法的 in-root 名字以 .. 开头时，apply 的守卫会不会误伤
  {
    const root = await freshDir('s8-inside-root');
    await put(root, '..probe.txt', 'PROBE');
    const plan = craftedPlan(root, [{ from: '..probe.txt', to: path.join('documents', '..probe.txt'), size: 5 }]);
    const journal = await applyPlan(plan);
    await check('合法 in-root 名称 "..probe.txt" 不应被 apply 判为越界', async () => {
      assert.equal(journal.entries[0].status, 'ok', JSON.stringify(journal.entries[0]));
      assert.equal(await readText(path.join(root, 'documents', '..probe.txt')), 'PROBE');
    });
    if (journal.entries[0].status !== 'ok') {
      bug(
        'apply 的 insideRoot 用 rel.startsWith("..") 判断，root 内以 .. 开头的合法名字被误判越界',
        'root 内的 ..probe.txt 应能移动到 documents/..probe.txt',
        `实际: ${journal.entries[0].status} ${journal.entries[0].error}；plan 层目前把所有 . 开头的文件当结构文件跳过，所以正常计划不会暴露，但这是 apply 层的潜在拒付`,
        'lib/scan.js:28-31（!rel.startsWith(\'..\')）、lib/apply.js:143（apply 入口守卫）',
      );
    }
  }

  // 盘符根：不跑 buildPlan（会往盘符根写 .folder-janitor），只构造 plan 测 apply 的守卫
  {
    const driveRoot = path.parse(HERE).root;
    const probe = craftedPlan(driveRoot, [
      { from: 'no-such-file-for-janitor-test.txt', to: 'folder-janitor-probe/no-such.txt', size: 1 },
      { from: 'C:\\Windows\\notepad.exe', to: 'folder-janitor-probe/notepad.exe', size: 1 },
      { from: '', to: 'folder-janitor-probe/root.txt', size: 1 },
    ]);
    const journal = await applyPlan(probe, { dryRun: true });
    await check('盘符根：跨盘绝对路径 / root 自身一律 failed，绝不尝试搬系统文件', () => {
      const statuses = journal.entries.map((entry) => entry.status);
      assert.deepEqual(statuses, ['skipped', 'failed', 'failed']);
      assert.ok(journal.entries.slice(1).every((entry) => entry.error.includes('越出')));
    });
    await check('盘符根 dryRun 没有创建任何探测目录', async () => {
      assert.equal(await exists(path.join(driveRoot, 'folder-janitor-probe')), false);
    });
    note('盘符根处理', '未调用 buildPlan（按设计会往盘符根写 .folder-janitor 状态目录），只验证了 apply 的越界守卫。');
  }

  // 构造 plan 的路径穿越
  {
    const base = await freshDir('s8-traversal');
    const root = path.join(base, 'root');
    await fs.mkdir(root);
    await put(root, 'inside.txt', 'INSIDE');
    await put(base, path.join('outside-secret.txt'), 'OUTSIDE');
    const outsideRel = path.join('..', 'outside-secret.txt');
    const plan = craftedPlan(root, [
      { from: outsideRel, to: path.join('documents', 'stolen.txt'), size: 7 },
      { from: 'inside.txt', to: path.join('..', 'escaped-out.txt'), size: 6 },
      { from: 'inside.txt', to: path.join('..', '..', 'escaped-out2.txt'), size: 6 },
    ]);
    const journal = await applyPlan(plan);
    await check('构造计划越界（from/to 到 root 外）全部 failed，文件不动', async () => {
      assert.deepEqual(journal.entries.map((entry) => entry.status), ['failed', 'failed', 'failed']);
      assert.ok(journal.entries.every((entry) => entry.error.includes('越出')));
      assert.equal(await readText(path.join(root, 'inside.txt')), 'INSIDE');
      assert.equal(await readText(path.join(base, 'outside-secret.txt')), 'OUTSIDE');
      assert.equal(await exists(path.join(base, 'escaped-out.txt')), false);
      assert.equal(await exists(path.join(ROOT, 'escaped-out2.txt')), false);
    });
  }

  // 目录 junction：会不会把 root 外的文件卷进整理范围
  {
    const base = await freshDir('s8-junction');
    const root = path.join(base, 'root');
    const outside = path.join(base, 'outside');
    await fs.mkdir(root);
    await fs.mkdir(outside);
    await put(outside, 'secret.txt', 'OUTSIDE-SECRET');
    let linked = false;
    try {
      await fs.symlink(outside, path.join(root, 'link'), 'junction');
      linked = true;
    } catch (err) {
      note('junction 创建失败，跳过本项', String(err.code));
    }
    if (linked) {
      const scan = await scanTree(root, { maxDepth: -1 });
      const followed = scan.items.filter((item) => item.rel.startsWith('link' + path.sep));
      if (followed.length > 0) {
        bug(
          '扫描穿过目录 junction，把 root 之外的文件算进整理范围',
          'junction/symlink 应整体跳过（或仅记录），不得把 root 外文件列入计划',
          `scanTree 返回 ${JSON.stringify(followed.map((item) => item.rel))}`,
          'lib/scan.js:61-80（只处理 Dirent.isSymbolicLink，junction 的判定依赖平台）',
        );
        const { plan } = await buildPlan({ root, strategy: 'by-type', options: { depth: -1, junk: false }, now: NOW });
        const escaped = plan.entries.filter((entry) => entry.from.startsWith('link' + path.sep));
        await check('目录 junction 不应把 root 外文件拉进移动计划', () => {
          assert.equal(escaped.length, 0, `计划包含 ${JSON.stringify(escaped.map((entry) => entry.from))}`);
        });
      } else {
        await check('目录 junction 被整体跳过（不会越界）', () => {
          assert.ok(scan.symlinks.includes('link') || followed.length === 0);
        });
        const { plan } = await buildPlan({ root, strategy: 'by-type', options: { depth: -1, junk: false }, now: NOW });
        await check('junction 不在计划里，计划也不警告它被忽略（记录体验问题）', () => {
          assert.equal(plan.entries.some((entry) => entry.from.startsWith('link' + path.sep)), false);
        });
        note('junction 处理', 'scan 将目录 junction 放入 symlinks 并跳过；但 plan/warnings 不提示“有 1 个链接被忽略”，用户看不出漏整理了它。');
      }
    }
  }

  // skipped 列表截断（500）
  {
    const root = await freshDir('s8-skipcap');
    for (let i = 1; i <= 505; i += 1) await put(root, `filler-${String(i).padStart(4, '0')}.md`, `c${i}`);
    const { plan } = await buildPlan({ root, strategy: 'by-project', options: { depth: 1, junk: false }, now: NOW });
    await check('skipped 明细截断到 500，但 skippedTotal 保留真实数量', () => {
      assert.equal(plan.entries.length, 0);
      assert.equal(plan.skipped.length, 500);
      assert.equal(plan.skippedTotal, 505);
    });
  }
}

// ---------------------------------------------------------------- 9. 并发/占用（Windows 句柄）

async function handles() {
  const content = 'L'.repeat(5000);
  let root = await freshDir('s9-lock-apply');
  await put(root, 'locked.pdf', content);
  const abs = path.join(root, 'locked.pdf');
  const handle = await fs.open(abs, 'r');
  let journal = null;
  let crash = null;
  try {
    const { plan } = await buildPlan({ root, strategy: 'by-type', options: { depth: 1, junk: false }, now: NOW });
    journal = await applyPlan(plan);
  } catch (err) {
    crash = err;
  }
  await check('文件被同进程持有读句柄：apply 不抛异常', () => assert.equal(crash, null, String(crash)));
  await check('文件被占用时：ok 则内容完整，failed/skipped 则源文件仍在（不丢）', async () => {
    const entry = journal.entries[0];
    if (entry.status === 'ok') {
      assert.equal(await readText(path.join(root, entry.to)), content);
    } else {
      assert.ok(['failed', 'skipped'].includes(entry.status), JSON.stringify(entry));
      assert.equal(await readText(abs), content);
    }
  });
  note('读句柄占用时 apply 状态', JSON.stringify(journal.entries.map((entry) => ({ status: entry.status, error: entry.error }))));
  await handle.close();

  // 撤销时目标仍被句柄占用
  root = await freshDir('s9-lock-undo');
  await put(root, 'locked.pdf', content);
  const { plan } = await buildPlan({ root, strategy: 'by-type', options: { depth: 1, junk: false }, now: NOW });
  const applied = await applyPlan(plan);
  const targetAbs = path.join(root, applied.entries[0].to);
  const targetHandle = await fs.open(targetAbs, 'r+');
  const beforeUndoHashes = await snapHashes(root);
  let undo = null;
  let undoCrash = null;
  try {
    undo = await undoJournal(applied);
  } catch (err) {
    undoCrash = err;
  }
  await targetHandle.close();
  await check('撤销时目标被占用：不崩、不丢内容', async () => {
    assert.equal(undoCrash, null, String(undoCrash));
    assertContentConserved(beforeUndoHashes, await snapHashes(root));
    const entry = undo.entries[0];
    assert.ok(['restored', 'failed', 'skipped'].includes(entry.status), JSON.stringify(entry));
  });
  note('目标被占用时 undo 状态', JSON.stringify(undo.entries.map((entry) => ({ status: entry.status, error: entry.error }))));
}

// ---------------------------------------------------------------- 10. 计划过期 / 其它策略 / 选项

async function misc() {
  // a) 计划生成后源文件被改（同样大小）
  {
    const root = await freshDir('s10-stale-same-size');
    await put(root, 'edit.txt', 'AAAA');
    const { plan } = await buildPlan({ root, strategy: 'by-type', options: { depth: 1, junk: false }, now: NOW });
    await fs.writeFile(path.join(root, 'edit.txt'), 'BBBB');
    const journal = await applyPlan(plan);
    await check('apply 对“计划后内容被改”的检测（记录实际行为）', () => {
      assert.ok(['ok', 'skipped'].includes(journal.entries[0].status));
    });
    note(
      '计划过期检测只比大小',
      `计划后把 edit.txt 内容从 AAAA 改成 BBBB（同大小），apply 状态=${journal.entries[0].status}（${journal.entries[0].error ?? '无错误'}）。代码中的“计划生成后文件被改动过”实际只覆盖大小变化。`,
    );
  }

  // b) 源文件被删 / 被目录顶替
  {
    const root = await freshDir('s10-stale-deleted');
    await put(root, 'gone.txt', 'G');
    await put(root, 'swap.txt', 'S');
    const { plan } = await buildPlan({ root, strategy: 'by-type', options: { depth: 1, junk: false }, now: NOW });
    await fs.unlink(path.join(root, 'gone.txt'));
    await fs.unlink(path.join(root, 'swap.txt'));
    await put(root, path.join('swap.txt', 'inside.txt'), 'DIR');
    const journal = await applyPlan(plan);
    const status = byFrom(journal);
    await check('计划后源文件被删/被目录顶替：skipped，不崩不丢', async () => {
      assert.equal(status.get('gone.txt')?.status, 'skipped');
      assert.equal(status.get('swap.txt')?.status, 'skipped');
      assert.equal(status.get('swap.txt')?.error, '不是普通文件（可能是链接或目录）');
      assert.equal(await readText(path.join(root, 'swap.txt', 'inside.txt')), 'DIR');
    });
  }

  // c) 分类语义：by-date / archive-old / dedupe / ignore
  {
    const root = await freshDir('s10-date');
    const june = await put(root, 'june.pdf', 'JUNE');
    const jan = await put(root, 'january.md', 'JAN');
    const juneDate = new Date(2025, 5, 1, 12);
    const janDate = new Date(2026, 0, 10, 12);
    await fs.utimes(june, juneDate, juneDate);
    await fs.utimes(jan, janDate, janDate);
    const { plan } = await buildPlan({ root, strategy: 'by-date', options: { depth: 1, junk: false }, now: NOW });
    await check('by-date 按修改月份落桶（2025-06 / 2026-01）', () => {
      const to = new Map(plan.entries.map((entry) => [entry.from, entry.to]));
      assert.equal(to.get('june.pdf'), path.join('2025-06', 'june.pdf'));
      assert.equal(to.get('january.md'), path.join('2026-01', 'january.md'));
    });
  }
  {
    const root = await freshDir('s10-archive');
    const old = await put(root, 'old.pdf', 'OLD');
    const fresh = await put(root, 'fresh.pdf', 'FRESH');
    const oldDate = new Date(NOW - 400 * DAY);
    await fs.utimes(old, oldDate, oldDate);
    await fs.utimes(fresh, new Date(NOW), new Date(NOW));
    const { plan } = await buildPlan({ root, strategy: 'archive-old', options: { depth: 1, junk: false, olderDays: 180 }, now: NOW });
    await check('archive-old 只归档过期文件，且带 YYYY-MM 桶', () => {
      assert.deepEqual(plan.entries.map((entry) => entry.from), ['old.pdf']);
      assert.equal(plan.entries[0].to, path.join('archive', yearMonth(oldDate.getTime()), 'old.pdf'));
    });
  }
  {
    const root = await freshDir('s10-dedupe');
    const older = await put(root, 'dup-old.txt', 'SAME-CONTENT');
    const newer = await put(root, 'dup-new.txt', 'SAME-CONTENT');
    await fs.utimes(older, new Date(NOW - 10 * DAY), new Date(NOW - 10 * DAY));
    await fs.utimes(newer, new Date(NOW - 1 * DAY), new Date(NOW - 1 * DAY));
    const { plan } = await buildPlan({ root, strategy: 'dedupe', options: { depth: 1 }, now: NOW });
    await check('dedupe 保留最新一份，把老副本移进 _duplicates/<今天>/', () => {
      assert.equal(plan.entries.length, 1);
      assert.equal(plan.entries[0].from, 'dup-old.txt');
      assert.equal(plan.entries[0].to, path.join('_duplicates', dayStamp(NOW), 'dup-old.txt'));
      assert.ok(plan.entries[0].reason.includes('dup-new.txt'));
      assert.equal(plan.options.junk, false);
    });
  }
  {
    const root = await freshDir('s10-ignore');
    await put(root, 'keep-me.pdf', 'K');
    await put(root, 'secret.pdf', 'S');
    await put(root, path.join('skipdir', 'x.pdf'), 'X');
    const { plan } = await buildPlan({
      root,
      strategy: 'by-type',
      options: { depth: 1, junk: false, ignore: ['secret.pdf', 'skipdir'] },
      now: NOW,
    });
    await check('ignore 选项同时排除文件名和目录名', () => {
      assert.deepEqual(plan.entries.map((entry) => entry.from), ['keep-me.pdf']);
    });
  }

  // d) 选项消毒：quarantineDir 带路径/保留名
  {
    const root = await freshDir('s10-opts');
    await put(root, '_junk.js', 'J');
    const { plan } = await buildPlan({
      root,
      strategy: 'by-type',
      options: { depth: 1, junk: true, quarantineDir: 'a/b', duplicateDir: 'CON' },
      now: NOW,
    });
    await check('quarantineDir 路径分隔符被消毒、duplicateDir 保留名回退', () => {
      assert.equal(plan.options.quarantineDir, 'a-b');
      assert.equal(plan.options.duplicateDir, '_duplicates');
      assert.ok(plan.entries[0].to.startsWith('a-b' + path.sep));
    });
  }

  // e) 空计划 / root 不存在时 apply 的容错
  {
    const root = await freshDir('s10-emptyplan');
    const plan = craftedPlan(root, []);
    const journal = await applyPlan(plan);
    await check('空计划 apply 返回 moved=0，并写零移动 journal', async () => {
      assert.equal(journal.moved, 0);
      assert.equal(await journalCount(root), 1);
    });
    const ghostRoot = path.join(ROOT, 's10-ghost-root');
    const ghostPlan = craftedPlan(ghostRoot, [{ from: 'a.txt', to: path.join('documents', 'a.txt'), size: 1 }]);
    let ghostCrash = null;
    let ghostJournal = null;
    try {
      ghostJournal = await applyPlan(ghostPlan);
    } catch (err) {
      ghostCrash = err;
    }
    // 行为变更（2026-10-25，修 ghost-root 副作用）：原来的实现会为写零移动日志而把
    // root 建出来，等于"整理"了一个不存在的目录。现在改成动手前先确认 root 存在，
    // 不存在就明确抛错。为此把断言从"全部 skipped 不崩"改成"报错且不留目录"。
    await check('root 不存在时明确报错，且不创建幽灵目录', async () => {
      assert.ok(ghostCrash, '应该抛错');
      assert.match(String(ghostCrash.message), /目录不存在|不是目录/);
      assert.equal(await exists(ghostRoot), false, '不该把 ghost root 建出来');
    });
  }
}

// ---------------------------------------------------------------- 入口

async function main() {
  console.log(`folder-janitor 对抗性测试 · ${new Date().toISOString()}`);
  console.log(`临时目录: ${ROOT}`);
  const fingerprintBefore = await libFingerprint();
  console.log(`引擎指纹(前): ${JSON.stringify(fingerprintBefore)}`);
  await rmrf(ROOT);
  await fs.mkdir(ROOT, { recursive: true });

  const sections = [
    ['0 纯函数基线', pureFns],
    ['1 极端文件名', extremeNames],
    ['2 深层嵌套 / depth 语义', deepNesting],
    ['3 撞名矩阵 / 改名递进 / 日志落盘失败', collisions],
    ['4 撤销对抗', undoAdversarial],
    ['5 dryRun 零写入', dryRun],
    ['6 幂等 / 重复执行 / 并发', idempotency],
    ['7 by-project 聚类质量', byProject],
    ['8 边界（空目录 / 坏 root / 怪路径 / 穿越 / junction / 截断）', boundaries],
    ['9 文件占用（Windows 句柄）', handles],
    ['10 计划过期 / 其它策略与选项', misc],
  ];
  for (const [title, fn] of sections) await runSection(title, fn);

  const fingerprintAfter = await libFingerprint();
  const engineChanged = JSON.stringify(fingerprintBefore) !== JSON.stringify(fingerprintAfter);
  if (engineChanged) {
    console.log(`\n!! 引擎在测试期间被修改，本轮结果不能作为定版结论`);
    console.log(`   测试前: ${JSON.stringify(fingerprintBefore)}`);
    console.log(`   测试后: ${JSON.stringify(fingerprintAfter)}`);
  } else {
    console.log(`\n引擎指纹(后，未变): ${JSON.stringify(fingerprintAfter)}`);
  }

  const passed = results.filter((result) => result.ok).length;
  const failed = results.filter((result) => !result.ok);
  console.log('\n================ 汇总 ================');
  console.log(`通过 ${passed}/${results.length}，失败 ${failed.length}`);
  if (failed.length > 0) {
    console.log('\n失败项：');
    for (const result of failed) console.log(`  - [${result.section}] ${result.label}\n    ${result.msg}`);
  }
  console.log(`\nBUG ${bugs.length} 条（真问题）：`);
  for (const item of bugs) {
    console.log(`  * ${item.title}`);
    console.log(`    期望: ${item.expected}`);
    console.log(`    实际: ${item.actual}`);
    console.log(`    定位: ${item.where}`);
  }
  console.log(`\nNOTE ${notes.length} 条（难用 / 质量 / 环境）：`);
  for (const item of notes) console.log(`  - ${item.title}: ${item.detail}`);
  console.log(`\n临时树保留在 ${ROOT}`);

  if (failed.length > 0) process.exitCode = 1;
}

await main();
