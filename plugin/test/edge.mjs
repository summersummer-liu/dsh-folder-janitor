// 抗打击测试：每条都对应一个真实踩过的坑，尤其是「撤销看起来成功、其实回滚错了」。
// 断言四条硬承诺：不丢、不覆盖、不越界、能还原 —— 以及还原失败时必须说清楚为什么。

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildInventory, insideRoot } from '../lib/scan.js';
import { buildPlan } from '../lib/plan.js';
import { applyPlan, undoJournal } from '../lib/apply.js';
import { ensureStateId } from '../lib/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(HERE, '.edge');

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

async function snapshot(root, skip = ['.folder-janitor']) {
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

function histogram(map) {
  const counts = new Map();
  for (const value of map.values()) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

async function fresh(name) {
  const root = path.join(TMP, name);
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  return root;
}

async function put(root, rel, content = 'x') {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  return abs;
}

async function main() {
  await fs.rm(TMP, { recursive: true, force: true });

  // ---------------------------------------------------------------- A. 极端名字
  {
    const root = await fresh('names');
    await put(root, 'CON.txt', 'reserved');
    await put(root, 'emoji-🎉.png', 'emoji');
    await put(root, "quote's and %20.pdf", 'quote');
    await put(root, 'a'.repeat(200) + '.txt', 'long');
    await put(root, 'dots..name.md', 'dots');

    const { plan } = await buildPlan({ root, strategy: 'by-type', options: { depth: 1, junk: false } });
    const journal = await applyPlan(plan, {});
    const after = await snapshot(root);
    console.log(`\n[A] 极端文件名：${journal.moved} 移动 / ${journal.failed} 失败`);
    await check('保留名/emoji/超长名都能移动且不丢', () => {
      assert.equal(journal.failed, 0);
      assert.equal(after.size, 5);
    });
    const undo = await undoJournal(journal, {});
    await check('全部还原', async () => {
      assert.equal(undo.restored, journal.moved);
      assert.ok(!(await fs.readdir(root)).includes('documents'));
    });
  }

  // ---------------------------------------------------------------- B. 深层同名
  {
    const root = await fresh('deep');
    for (let i = 0; i < 12; i += 1) {
      await put(root, path.join(...Array.from({ length: i + 1 }, (_, k) => `d${k}`), 'same.pdf'), `depth-${i}`);
    }
    await put(root, path.join('documents', 'keep-me.txt'), 'user-owned');

    const before = await snapshot(root);
    const { plan } = await buildPlan({ root, strategy: 'by-type', options: { depth: -1, junk: false } });
    const targets = plan.entries.map((e) => e.to);
    await check('深层同名文件的目标路径互不相同', () => assert.equal(new Set(targets).size, targets.length));

    const journal = await applyPlan(plan, {});
    const after = await snapshot(root);
    console.log(`\n[B] 13 层嵌套：${journal.moved} 移动 / ${journal.failed} 失败`);
    await check('内容多重集合不变（一个没丢）', () => assert.deepEqual(histogram(after), histogram(before)));
    await check('用户自己的 documents/keep-me.txt 没被吞', () =>
      assert.ok([...after.keys()].some((k) => k.endsWith('keep-me.txt'))));

    const undo = await undoJournal(journal, {});
    const restored = await snapshot(root);
    await check('撤销后与原始快照一致', () => assert.deepEqual(histogram(restored), histogram(before)));
    await check('用户原有文件仍在原位', () => assert.ok(restored.has(path.join('documents', 'keep-me.txt'))));
    await check('没有删掉用户原有的 documents/ 目录', async () => {
      const stat = await fs.stat(path.join(root, 'documents'));
      assert.ok(stat.isDirectory());
    });
  }

  // ---------------------------------------------------------------- C. 重复执行
  {
    const root = await fresh('twice');
    for (const name of ['a.pdf', 'b.pdf', 'c.png']) await put(root, name, name);
    const { plan } = await buildPlan({ root, strategy: 'by-type', options: { depth: 1, junk: false } });
    const first = await applyPlan(plan, {});
    const second = await applyPlan(plan, {});
    console.log(`\n[C] 同一计划跑两次：第一次 ${first.moved}，第二次 ${second.moved}`);
    await check('第二次全部跳过，不报错不乱搬', () => {
      assert.equal(second.moved, 0);
      assert.equal(second.failed, 0);
      assert.equal(second.skipped + second.failed, plan.entries.length);
    });
  }

  // ---------------------------------------------------------------- D. 同尺寸改写后撤销
  {
    const root = await fresh('same-size');
    await put(root, 'note.txt', 'abc');
    const { plan } = await buildPlan({ root, strategy: 'by-type', options: { depth: 1, junk: false } });
    const journal = await applyPlan(plan, {});
    const target = path.join(root, journal.entries[0].to);
    await fs.writeFile(target, 'xyz'); // 同样 3 字节，内容变了
    const undo = await undoJournal(journal, {});
    console.log('\n[D] 移动后同尺寸改写再撤销');
    await check('拒绝回滚（不再只看大小）', () => {
      assert.equal(undo.restored, 0);
      assert.equal(undo.skipped, 1);
      assert.match(undo.entries[0].error, /mtime|内容/);
    });
  }

  // ---------------------------------------------------------------- E. 日志越界
  {
    const root = await fresh('escape');
    await put(root, 'inside.txt', 'inside');
    const outside = path.join(TMP, 'outside.txt');
    await fs.writeFile(outside, 'outside');
    const stateId = await ensureStateId(root);
    const fake = {
      kind: 'folder-janitor/journal',
      journalId: 'journal-forged',
      planId: 'plan-forged',
      root,
      stateId,
      entries: [{ from: path.join('..', 'outside.txt'), to: 'inside.txt', status: 'ok', size: 7 }],
      createdDirs: [],
    };
    const undo = await undoJournal(fake, {});
    console.log('\n[E] 伪造越界日志');
    await check('拒绝把文件搬出根目录', async () => {
      assert.equal(undo.restored, 0);
      assert.equal(undo.skipped, 1);
      assert.ok((await fs.stat(outside)).isFile(), 'outside.txt 应该还在原地');
    });
  }

  // ---------------------------------------------------------------- F. 目录身份不符
  {
    const root = await fresh('identity');
    await put(root, 'x.txt', 'x');
    const { plan } = await buildPlan({ root, strategy: 'by-type', options: { depth: 1, junk: false } });
    const journal = await applyPlan(plan, {});
    await fs.writeFile(path.join(root, '.folder-janitor', 'id'), 'deadbeefdeadbeef', 'utf8');
    const undo = await undoJournal(journal, {});
    console.log('\n[F] 目录身份被换掉后撤销');
    await check('拒绝回滚，并说明目录已不是当初那个', () => {
      assert.equal(undo.restored, 0);
      assert.ok(undo.warnings.some((w) => w.includes('拒绝回滚')));
    });
  }

  // ---------------------------------------------------------------- G. 目标变成目录
  {
    const root = await fresh('dir-target');
    await put(root, 'file.txt', 'content');
    const { plan } = await buildPlan({ root, strategy: 'by-type', options: { depth: 1, junk: false } });
    const journal = await applyPlan(plan, {});
    const target = path.join(root, journal.entries[0].to);
    await fs.rm(target);
    await fs.mkdir(target);
    const undo = await undoJournal(journal, {});
    console.log('\n[G] 目标被换成同名空目录');
    await check('不把目录 rename 成文件', () => {
      assert.equal(undo.restored, 0);
      assert.equal(undo.skipped, 1);
      assert.match(undo.entries[0].error, /不是普通文件/);
    });
  }

  // ---------------------------------------------------------------- H. 撞名耗尽
  {
    const root = await fresh('exhausted');
    await put(root, 'a.pdf', 'original');
    await fs.mkdir(path.join(root, 'documents'), { recursive: true });
    await put(root, path.join('documents', 'a.pdf'), 'squatter-primary');
    for (let n = 2; n <= 999; n += 1) {
      await put(root, path.join('documents', `a (${n}).pdf`), `squatter-${n}`);
    }
    await put(root, 'b.pdf', 'second');
    const { plan } = await buildPlan({ root, strategy: 'by-type', options: { depth: 1, junk: false } });
    const journal = await applyPlan(plan, {});
    console.log(`\n[H] 撞名占满 (2)..(999)：${journal.moved} 移动 / ${journal.failed} 失败`);
    await check('占用耗尽只让那一条失败，不影响其它条目', () => {
      assert.equal(journal.failed, 1);
      assert.ok(journal.moved >= 1, `moved=${journal.moved}`);
    });
    await check('失败条目写进日志，仍可撤销', async () => {
      const journalFile = path.join(root, '.folder-janitor', 'journals', `${journal.journalId}.json`);
      assert.ok((await fs.stat(journalFile)).isFile());
    });
  }

  // ---------------------------------------------------------------- I. 状态目录被占
  {
    const root = await fresh('state-occupied');
    await put(root, 'a.pdf', 'a');
    const { plan } = await buildPlan({ root, strategy: 'by-type', options: { depth: 1, junk: false } });
    await fs.rm(path.join(root, '.folder-janitor'), { recursive: true, force: true });
    await fs.writeFile(path.join(root, '.folder-janitor'), 'not a directory');
    let error = null;
    try {
      await applyPlan(plan, {});
    } catch (err) {
      error = err;
    }
    console.log('\n[I] .folder-janitor 被普通文件占位');
    await check('动手前就拒绝执行（否则没有账本）', async () => {
      assert.ok(error, '应该抛错');
      assert.ok((await fs.stat(path.join(root, 'a.pdf'))).isFile(), '文件必须原地不动');
    });
  }

  // ---------------------------------------------------------------- J. 并发
  {
    const root = await fresh('concurrent');
    for (const name of ['f1.txt', 'f2.txt', 'f3.txt']) await put(root, name, name);
    const { plan } = await buildPlan({ root, strategy: 'by-type', options: { depth: 1, junk: false } });
    const settled = await Promise.allSettled([applyPlan(plan, {}), applyPlan(plan, {})]);
    const fulfilled = settled.filter((s) => s.status === 'fulfilled');
    const rejected = settled.filter((s) => s.status === 'rejected');
    console.log(`\n[J] 同一计划并发执行：${fulfilled.length} 成功 / ${rejected.length} 被锁拒绝`);
    await check('只允许一个任务真正动手', () => {
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      assert.match(String(rejected[0].reason?.message), /正在执行/);
    });
    await check('失败的那个没有写假账本', async () => {
      const journals = await fs.readdir(path.join(root, '.folder-janitor', 'journals'));
      assert.equal(journals.length, 1);
    });
  }

  // ---------------------------------------------------------------- K. 只读体检
  {
    const root = await fresh('inventory');
    await put(root, 'one.md', 'a');
    const inv = await buildInventory(root, { maxDepth: 1, hashes: false });
    console.log('\n[K] 只读体检');
    await check('体检正常返回', () => assert.equal(inv.files, 1));
  }

  // ---------------------------------------------------------------- L. 撤销预演不写盘
  {
    const root = await fresh('undo-dry');
    await put(root, 'x.txt', 'x');
    const fake = {
      kind: 'folder-janitor/journal',
      journalId: 'journal-dry',
      planId: 'plan-dry',
      root,
      stateId: 'deadbeefdeadbeef',
      entries: [{ from: 'x.txt', to: 'documents/x.txt', status: 'ok', size: 1, mtimeMs: 1 }],
      createdDirs: [],
    };
    const undo = await undoJournal(fake, { dryRun: true });
    console.log('\n[L] 撤销预演 + 目录身份不符');
    await check('身份校验只读，预演不创建状态目录', async () => {
      assert.equal(undo.restored, 0);
      let exists = true;
      try {
        await fs.stat(path.join(root, '.folder-janitor'));
      } catch {
        exists = false;
      }
      assert.equal(exists, false, '.folder-janitor 不该被这次预演创建出来');
    });
  }

  // ---------------------------------------------------------------- M. 以 .. 开头的合法名字
  {
    const root = await fresh('dotdot');
    await put(root, '..probe.txt', 'probe');
    await check('..probe.txt 属于 root 内部', () =>
      assert.equal(insideRoot(root, path.join(root, '..probe.txt')), true));
    const plan = {
      planId: 'plan-manual',
      root,
      strategy: 'by-type',
      entries: [{ from: '..probe.txt', to: path.join('documents', '..probe.txt'), kind: 'content', size: 5 }],
    };
    const journal = await applyPlan(plan, {});
    console.log('\n[M] 以 .. 开头的合法文件名');
    await check('能正常移动，而不是被当成越界', () => assert.equal(journal.moved, 1));
    await check('越界判定没被放宽：../secret.txt 仍然拒绝', () =>
      assert.equal(insideRoot(root, path.join(root, '..', 'secret.txt')), false));
  }

  await fs.rm(TMP, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) {
    for (const item of failed) console.log(`  - ${item.label}: ${item.err.message}`);
    process.exitCode = 1;
  }
}

await main();
