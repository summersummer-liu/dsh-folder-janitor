// manual 策略自测：目录移动、目录重命名、拒绝规则、撤销还原。
// 不碰任何真实数据，全在这个临时目录里造。

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPlan } from '../lib/plan.js';
import { applyPlan, undoJournal } from '../lib/apply.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(HERE, '.manual');
const ROOT = path.join(TMP, 'root');

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

async function put(rel, content = 'x') {
  const abs = path.join(ROOT, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  return abs;
}

async function main() {
  await fs.rm(TMP, { recursive: true, force: true });
  await fs.mkdir(ROOT, { recursive: true });

  // 场景：一个要改名的目录、一个要整体搬走的目录、一个要挪动的文件、一个受保护的目录名
  await put(path.join('projects', 'a.txt'), 'inner-a');
  await put(path.join('projects', 'deep', 'b.txt'), 'inner-b');
  await put(path.join('attachment_1234567890', 'note.txt'), 'attachment');
  await put(path.join('junk_cache', 'pip', 'leftover.bin'), 'cache');
  await put('《WKW》.pdf', 'bigpdf');
  await put(path.join('node_modules', 'lib', 'index.js'), 'module');
  const innerHash = await sha(path.join(ROOT, 'projects', 'deep', 'b.txt'));

  console.log('[1] 计划：只收显式清单');
  const { plan } = await buildPlan({
    root: ROOT,
    strategy: 'manual',
    options: {
      items: [
        { from: 'attachment_1234567890', to: '知末_素材', reason: '乱码名字改成能读的' },
        { from: 'junk_cache', to: path.join('_trash', '2026-10-25', 'junk_cache'), reason: '缓存整体回收' },
        { from: '《WKW》.pdf', to: path.join('_待归类', '《WKW》.pdf'), reason: '根目录散件归位' },
        { from: 'projects', to: 'projects', reason: '原地不动，应该被拒绝' },
        { from: 'node_modules', to: 'node_modules_old', reason: '受保护目录，应该被拒绝' },
        { from: '不存在的东西', to: 'x', reason: '源不存在，应该被拒绝' },
        { from: '../逃逸.txt', to: 'x', reason: '越界，应该被拒绝' },
        { from: 'node_modules/lib/index.js', to: 'x/index.js', reason: '路径段命中保护名单，应该被拒绝' },
      ],
    },
  });

  await check('3 条合法动作进入计划', () => assert.equal(plan.entries.length, 3));
  await check('5 条非法动作被拒绝且写了原因', () => assert.equal(plan.skippedTotal, 5));
  await check('目录被标记为 dir，文件被标记为 file', () => {
    const kinds = plan.entries.map((e) => `${e.from}:${e.kind}`).sort();
    assert.deepEqual(kinds, ['attachment_1234567890:dir', 'junk_cache:dir', '《WKW》.pdf:file'].sort());
  });
  await check('改名条目带 rename 备注', () => {
    const renamed = plan.entries.find((e) => e.from === 'attachment_1234567890');
    assert.equal(renamed.note, 'rename');
  });

  console.log('\n[2] 执行');
  const dry = await applyPlan(plan, { dryRun: true });
  await check('dryRun 报告 3 条、零写入', async () => {
    assert.equal(dry.moved, 3);
    assert.ok((await fs.stat(path.join(ROOT, 'attachment_1234567890'))).isDirectory());
  });
  const journal = await applyPlan(plan, {});
  await check('执行后 3 条成功、读回核对通过', () => {
    assert.equal(journal.moved, 3);
    assert.equal(journal.failed, 0);
    assert.equal(journal.verified, 3);
  });
  await check('目录改名生效，里面的文件还在', async () => {
    assert.ok((await fs.stat(path.join(ROOT, '知末_素材', 'note.txt'))).isFile());
  });
  await check('目录整体搬走，子目录结构完整', async () => {
    assert.ok((await fs.stat(path.join(ROOT, '_trash', '2026-10-25', 'junk_cache', 'pip', 'leftover.bin'))).isFile());
  });
  await check('文件搬走', async () => {
    assert.ok((await fs.stat(path.join(ROOT, '_待归类', '《WKW》.pdf'))).isFile());
  });
  await check('目录内容哈希不变', async () => {
    assert.equal(await sha(path.join(ROOT, 'projects', 'deep', 'b.txt')), innerHash);
  });

  console.log('\n[3] 撤销');
  const undo = await undoJournal(journal, {});
  await check('3 条全部还原', () => assert.equal(undo.restored, 3));
  await check('改名目录回到原名', async () => {
    assert.ok((await fs.stat(path.join(ROOT, 'attachment_1234567890', 'note.txt'))).isFile());
  });
  await check('搬走的目录回到原处', async () => {
    assert.ok((await fs.stat(path.join(ROOT, 'junk_cache', 'pip', 'leftover.bin'))).isFile());
  });
  await check('撤销后清掉本次建的空目录', () => assert.ok(undo.prunedDirs >= 2));

  console.log('\n[4] 目标已存在');
  await put('a.txt', 'A');
  await put('b.txt', 'B');
  await put(path.join('b.txt'), 'B');
  const { plan: plan2 } = await buildPlan({
    root: ROOT,
    strategy: 'manual',
    options: { items: [{ from: 'a.txt', to: 'b.txt', reason: '目标已存在' }] },
  });
  await check('目标已存在直接拒绝，不覆盖', () => {
    assert.equal(plan2.entries.length, 0);
    assert.equal(plan2.skippedTotal, 1);
    assert.match(plan2.skipped[0].reason, /目标已存在/);
  });

  await fs.rm(TMP, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) process.exitCode = 1;
}

await main();
