// 自测：造一个真实的乱文件夹，跑完整链路（体检 → 计划 → 执行 → 撤销 → 再计划）。
// 断言只盯四件事：不丢文件、不越界、不覆盖、能回到原样。
//
// 用法：node test/run.mjs

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildInventory } from '../lib/scan.js';
import { buildPlan } from '../lib/plan.js';
import { applyPlan, undoJournal } from '../lib/apply.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(HERE, '.tmp');
const FIXTURE = path.join(TMP, 'messy');

const results = [];
async function check(label, fn) {
  try {
    await fn();
    results.push({ label, ok: true });
    console.log(`  ok   ${label}`);
  } catch (err) {
    results.push({ label, ok: false, err });
    console.log(`  FAIL ${label}\n       ${err.message}`);
  }
}

async function sha(abs) {
  return createHash('sha256').update(await fs.readFile(abs)).digest('hex').slice(0, 16);
}

async function snapshot(root, { skip = ['.folder-janitor'] } = {}) {
  const out = new Map();
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs);
      if (skip.some((s) => rel === s || rel.startsWith(`${s}${path.sep}`))) continue;
      if (entry.isDirectory()) await walk(abs);
      else if (entry.isFile()) out.set(rel, await sha(abs));
    }
  }
  await walk(root);
  return out;
}

function diffMaps(before, after) {
  const missing = [...before.keys()].filter((k) => !after.has(k));
  const added = [...after.keys()].filter((k) => !before.has(k));
  const changed = [...before.keys()].filter((k) => after.has(k) && after.get(k) !== before.get(k));
  return { missing, added, changed };
}

/** 路径会变、内容不该变：比「内容的多重集合」才是不丢文件的证据。 */
function histogram(map) {
  const counts = new Map();
  for (const value of map.values()) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

async function put(rel, content) {
  const abs = path.join(FIXTURE, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  return abs;
}

async function makeFixture() {
  await fs.rm(TMP, { recursive: true, force: true });
  await fs.mkdir(FIXTURE, { recursive: true });

  // 一个真实的项目现场：同一项目的文件共用项目词，另有一堆散落的单件和草稿
  await put('nobel-2026-brief.md', 'brief');
  await put('nobel-2026-hall-woodford.md', 'hall');
  await put('nobel-2026-figures.json', '{"fig":1}');
  await put('卡洛·斯卡帕学习手册.md', 'scarpa');
  await put('斯卡帕学习手册_封面.png', 'png-scarpa');
  await put('重返提帕萨_图文导读.html', '<html>tipasa</html>');
  await put('重返提帕萨_图文导读.pdf', 'pdf-tipasa');
  await put('photo.png', 'png-1');
  await put('script.py', 'print(1)');
  await put('data.csv', 'a,b\n1,2\n');
  await put('archive.zip', 'zip-bytes');
  await put('report.pdf', 'pdf-report');
  await put('report copy.pdf', 'pdf-report-copy');
  await put('_build_dbg.js', 'dbg');
  await put('_nettest.js', 'net');
  await put('~$draft.docx', 'lock');
  await put('empty.txt', '');
  await put('a.pdf', 'identical-content');
  await put('a2.pdf', 'identical-content');
  await put('裁剪 副本.png', 'cjk-copy');
  // 结构文件：任何策略都不许动
  await put('README.md', '# readme');
  await put('AGENTS.md', '# agents');
  await put('.gitignore', 'node_modules/');
  // 子目录：by-type depth=1 不许碰
  await put(path.join('sub', 'nested.pdf'), 'nested');
  await put(path.join('sub', 'nested.txt'), 'nested-txt');
  // 必须被忽略
  await put(path.join('node_modules', 'pkg', 'index.js'), 'module');
  await put(path.join('.git', 'config'), 'gitconfig');
  // 一个 40 天前的旧文件，给 archive-old 用
  const old = await put('old-notes.md', 'old');
  const past = new Date(Date.now() - 40 * 86400000);
  await fs.utimes(old, past, past);
}

async function main() {
  console.log(`dsh-folder-janitor 自测 · ${new Date().toISOString()}`);
  await makeFixture();
  const before = await snapshot(FIXTURE);
  console.log(`\nfixture: ${before.size} 个文件在 ${FIXTURE}\n`);

  console.log('[1] 体检');
  const inv = await buildInventory(FIXTURE, { maxDepth: 1, hashes: true });
  await check('根目录文件数 = 24（不含子目录与忽略目录）', () => assert.equal(inv.files, 24));
  await check('识别出 1 组重复内容（a.pdf ≡ a2.pdf）', () => assert.equal(inv.duplicates.groups, 1));
  await check('重复组保留最新的一份、多余 1 个', () => {
    assert.equal(inv.duplicates.redundantFiles, 1);
    const group = inv.duplicates.samples[0];
    assert.equal(group.extras.length, 1);
  });
  await check('草稿/临时文件被点名（_ 开头、~$、副本、空文件、report copy）', () => {
    const names = inv.junk.samples.map((j) => path.basename(j.rel));
    assert.ok(names.includes('_build_dbg.js'));
    assert.ok(names.includes('~$draft.docx'));
    assert.ok(names.includes('empty.txt'));
    assert.ok(inv.junk.count >= 5);
  });
  await check('node_modules/.git 不进入统计', () => {
    assert.ok(!inv.topExtensions.some((e) => e.ext === 'gitconfig'));
    assert.ok(inv.ignoredDirs >= 2);
  });
  await check('给了建议', () => assert.ok(inv.suggestions.length > 0));

  console.log('\n[2] by-type 计划（不动盘）');
  const { plan: typePlan, file: typePlanFile } = await buildPlan({
    root: FIXTURE,
    strategy: 'by-type',
    options: { depth: 1, junk: true },
  });
  await check('计划已落盘', async () => assert.ok((await fs.stat(typePlanFile)).isFile()));
  await check('子目录 sub/ 的文件没有被列入（depth=1）', () => {
    assert.ok(!typePlan.entries.some((e) => e.from.startsWith('sub')));
  });
  await check('空文件与 ~$ 锁文件进 _trash', () => {
    const trash = typePlan.entries.filter((e) => e.kind === 'junk').map((e) => path.basename(e.from));
    assert.ok(trash.includes('empty.txt'));
    assert.ok(trash.includes('~$draft.docx'));
  });
  await check('草稿进 _trash 且按日期分桶', () => {
    const junk = typePlan.entries.filter((e) => e.kind === 'junk');
    assert.ok(junk.length >= 5);
    assert.ok(junk.every((e) => e.to.startsWith(`_trash${path.sep}`)));
  });
  await check('report.pdf 去 documents，photo.png 去 images，script.py 去 scripts', () => {
    const to = new Map(typePlan.entries.map((e) => [e.from, e.to]));
    assert.equal(to.get('report.pdf'), path.join('documents', 'report.pdf'));
    assert.equal(to.get('photo.png'), path.join('images', 'photo.png'));
    assert.equal(to.get('script.py'), path.join('scripts', 'script.py'));
    assert.equal(to.get('data.csv'), path.join('data', 'data.csv'));
    assert.equal(to.get('archive.zip'), path.join('archives', 'archive.zip'));
  });
  await check('README / AGENTS / .gitignore 一个都不动', () => {
    const moved = typePlan.entries.map((e) => e.from);
    for (const name of ['README.md', 'AGENTS.md', '.gitignore']) {
      assert.ok(!moved.includes(name), `${name} 不该被移动`);
    }
    const skippedNames = typePlan.skipped.map((s) => s.from);
    assert.ok(skippedNames.includes('README.md'));
    assert.ok(skippedNames.includes('.gitignore'));
  });

  console.log('\n[3] 执行');
  const dry = await applyPlan(typePlan, { dryRun: true });
  await check('dry_run 报告了移动数', () => assert.equal(dry.moved, typePlan.entries.length));
  const afterDry = await snapshot(FIXTURE);
  await check('dry_run 之后盘上没有任何变化', () => {
    const diff = diffMaps(before, afterDry);
    assert.deepEqual(diff, { missing: [], added: [], changed: [] });
  });

  const journal = await applyPlan(typePlan, {});
  await check('执行后 moved = 计划条目数', () => assert.equal(journal.moved, typePlan.entries.length));
  await check('读回核对全部通过', () => assert.equal(journal.verified, journal.moved));
  const afterApply = await snapshot(FIXTURE);
  await check('没有丢文件：内容哈希的多重集合不变', () => {
    assert.deepEqual(histogram(afterApply), histogram(before));
  });
  await check('落点真实存在', async () => {
    assert.ok((await fs.stat(path.join(FIXTURE, 'documents', 'report.pdf'))).isFile());
    assert.ok((await fs.stat(path.join(FIXTURE, 'images', 'photo.png'))).isFile());
  });

  console.log('\n[4] 幂等');
  const { plan: again } = await buildPlan({ root: FIXTURE, strategy: 'by-type', options: { depth: 1, junk: true } });
  await check('再跑一次 by-type 没有新移动', () => assert.equal(again.entries.length, 0));

  console.log('\n[5] 撤销');
  const undo = await undoJournal(journal, {});
  await check('撤销恢复数 = 之前移动数', () => assert.equal(undo.restored, journal.moved));
  await check('撤销后清掉了本次新建的空目录', () => assert.ok(undo.prunedDirs >= 3));
  const afterUndo = await snapshot(FIXTURE, { skip: ['.folder-janitor'] });
  await check('撤销后跟原始快照逐字节一致', () => {
    const diff = diffMaps(before, afterUndo);
    assert.deepEqual(diff, { missing: [], added: [], changed: [] });
  });

  console.log('\n[6] 撞名不覆盖');
  await put(path.join('documents', 'a.pdf'), 'DIFFERENT-CONTENT');
  const { plan: collide } = await buildPlan({ root: FIXTURE, strategy: 'by-type', options: { depth: 1, junk: true } });
  const colJournal = await applyPlan(collide, {});
  await check('目标已存在同名文件时不覆盖，改名避让', async () => {
    const kept = await fs.readFile(path.join(FIXTURE, 'documents', 'a.pdf'), 'utf8');
    assert.equal(kept, 'DIFFERENT-CONTENT');
    const names = await fs.readdir(path.join(FIXTURE, 'documents'));
    assert.ok(names.some((n) => /^a \(\d\)\.pdf$/.test(n)));
  });
  await undoJournal(colJournal, {});
  await fs.rm(path.join(FIXTURE, 'documents'), { recursive: true, force: true });

  console.log('\n[7] by-project');
  const { plan: projectPlan } = await buildPlan({ root: FIXTURE, strategy: 'by-project', options: { depth: 1, junk: true } });
  await check('nobel 三个文件归到一个项目目录', () => {
    const nobel = projectPlan.entries.filter((e) => e.to.includes(path.sep) && e.to.split(path.sep)[0] === 'nobel');
    assert.ok(nobel.length >= 3, `实际 ${nobel.length}`);
  });
  await check('提帕萨的两个文件归到一个项目目录', () => {
    const tipasa = projectPlan.entries.filter((e) => e.from.startsWith('重返提帕萨'));
    assert.equal(tipasa.length, 2);
    assert.ok(tipasa.every((e) => e.to.startsWith('重返提帕萨' + path.sep)));
  });
  await check('孤立文件不强行编组', () => assert.ok(projectPlan.skippedTotal > 0));

  console.log('\n[8] archive-old');
  const { plan: archivePlan } = await buildPlan({
    root: FIXTURE,
    strategy: 'archive-old',
    options: { depth: 1, junk: false, olderDays: 30 },
  });
  await check('只归档 40 天前的 old-notes.md', () => {
    assert.deepEqual(archivePlan.entries.map((e) => e.from), ['old-notes.md']);
    assert.ok(archivePlan.entries[0].to.startsWith(`archive${path.sep}`));
  });

  console.log('\n[9] dedupe');
  const { plan: dedupePlan } = await buildPlan({ root: FIXTURE, strategy: 'dedupe', options: { depth: 1 } });
  await check('dedupe 只处理重复文件，其余不动', () => {
    assert.equal(dedupePlan.entries.length, 1);
    assert.ok(dedupePlan.entries[0].to.startsWith(`_duplicates${path.sep}`));
  });
  await check('dedupe 策略默认不清草稿', () => assert.equal(dedupePlan.options.junk, false));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) {
    console.log('失败项：');
    for (const item of failed) console.log(`  - ${item.label}: ${item.err.message}`);
    process.exitCode = 1;
  }
}

await main();
