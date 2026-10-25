// 执行层：唯一会真正移动文件的地方。每一步都记账，账本能倒着走。
//
// 这里的安全约束是拿真 bug 换来的，改之前先看清楚：
// - 撤销必须验「内容没被动过」，只比大小会让同尺寸改写的文件被静默回滚；
// - 撤销必须比「根目录身份」，否则目录改名后 old path 被新目录复用，会把别人的文件搬走；
// - 目标可能是目录、可能是只读、可能被占满 (2)..(999)，任何一种都不能让整批中断；
// - 并发跑同一计划会让两个日志都对同一文件记 ok，所以执行前要抢锁。

import fs from 'node:fs/promises';
import path from 'node:path';

import { siblingName } from './classify.js';
import { hashFile, insideRoot, pathExists, realInsideRoot, toRel } from './scan.js';
import { ensureStateId, newId, readStateId, saveJournal, statePaths } from './store.js';

const HASH_LIMIT = 16 * 1024 * 1024; // 超过 16MB 不哈希，靠大小 + mtime 比对
const MAX_SUFFIX = 999;

async function fingerprint(abs, size) {
  if (size > HASH_LIMIT) return null;
  try {
    return await hashFile(abs);
  } catch {
    return null;
  }
}

/** 目标被占了就换名字；换不出来返回 null，由调用方记 failed，绝不覆盖。 */
async function pickFreeName(baseAbs, claimed) {
  for (let n = 2; n <= MAX_SUFFIX; n += 1) {
    const candidate = path.join(path.dirname(baseAbs), siblingName(path.basename(baseAbs), n));
    if (claimed?.has(candidate.toLowerCase())) continue;
    if (!(await pathExists(candidate))) return candidate;
  }
  return null;
}

async function ensureDirs(dirAbs, root, created) {
  if (await pathExists(dirAbs)) return;
  const missing = [];
  let cursor = dirAbs;
  while (cursor !== root && insideRoot(root, cursor)) {
    if (await pathExists(cursor)) break;
    missing.push(cursor);
    cursor = path.dirname(cursor);
  }
  await fs.mkdir(dirAbs, { recursive: true });
  for (const abs of missing) created.add(toRel(root, abs));
}

async function moveEntry(srcAbs, destAbs, isDir = false) {
  try {
    await fs.rename(srcAbs, destAbs);
    return;
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    if (isDir) throw new Error('EXDEV_DIR'); // 目录不能「复制+删源」糊过去
  }
  const stat = await fs.stat(srcAbs);
  await fs.copyFile(srcAbs, destAbs);
  await fs.utimes(destAbs, stat.atime, stat.mtime);
  await fs.unlink(srcAbs);
}

/** 抢一把锁：.folder-janitor/lock 用 wx 原子创建。崩溃残留的锁要人工删。 */
async function acquireLock(root) {
  const dir = statePaths(root).dir;
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err) {
    throw new Error(`无法创建状态目录 ${dir}（${err.code}）；拒绝在没有撤销账本的情况下移动文件`);
  }
  const file = path.join(dir, 'lock');
  try {
    const handle = await fs.open(file, 'wx');
    await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    await handle.close();
    return file;
  } catch (err) {
    if (err.code === 'EEXIST') {
      throw new Error(`另一个整理任务正在执行（${file} 存在）。确认没有任务在跑后删掉这个文件再重试`);
    }
    throw err;
  }
}

async function releaseLock(file) {
  if (!file) return;
  await fs.unlink(file).catch(() => {});
}

/**
 * 执行计划。dryRun 只算不落盘。
 * 无论中途发生什么，只要动过盘就写日志 —— 没有账本的整理等于赌博。
 */
export async function applyPlan(plan, { dryRun = false, now = Date.now() } = {}) {
  const root = plan.root;
  try {
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error(`目录不存在或不是目录: ${root}（拒绝执行，否则连日志写哪都不知道）`);
  }
  const journal = {
    kind: 'folder-janitor/journal',
    journalId: newId('journal'),
    planId: plan.planId,
    root,
    stateId: null,
    createdAt: new Date(now).toISOString(),
    strategy: plan.strategy,
    dryRun,
    entries: [],
    createdDirs: [],
    moved: 0,
    skipped: 0,
    failed: 0,
    verified: 0,
    bytes: 0,
    warnings: [],
  };
  const created = new Set();
  const claimed = new Set(); // 本轮已占用的目标（小写），防 Windows 大小写撞车
  let lockFile = null;

  if (!dryRun) {
    lockFile = await acquireLock(root);
    try {
      journal.stateId = await ensureStateId(root);
    } catch (err) {
      await releaseLock(lockFile);
      throw new Error(`状态目录不可写（${err.code ?? err.message}）；拒绝执行`);
    }
  }

  try {
    for (const item of plan.entries) {
      const record = {
        from: item.from,
        to: item.to,
        kind: item.kind ?? 'content',
        reason: item.reason ?? '',
        size: item.size ?? null,
      };

      try {
        const srcAbs = path.resolve(root, item.from);
        const goalAbs = path.resolve(root, item.to);

        if (!insideRoot(root, srcAbs) || !insideRoot(root, goalAbs)) {
          journal.entries.push({ ...record, status: 'failed', error: '路径越出整理根目录' });
          journal.failed += 1;
          continue;
        }
        // 字符串判断挡不住 junction：真实路径也必须落在 root 里
        if (!(await realInsideRoot(root, srcAbs)) || !(await realInsideRoot(root, goalAbs))) {
          journal.entries.push({ ...record, status: 'failed', error: '真实路径越出根目录（路径里经过 junction 或符号链接）' });
          journal.failed += 1;
          continue;
        }

        let stat;
        try {
          stat = await fs.lstat(srcAbs);
        } catch {
          journal.entries.push({ ...record, status: 'skipped', error: '源文件已不存在' });
          journal.skipped += 1;
          continue;
        }
        if (stat.isSymbolicLink()) {
          journal.entries.push({ ...record, status: 'skipped', error: '符号链接/目录联接不搬' });
          journal.skipped += 1;
          continue;
        }
        const wantsDir = record.kind === 'dir';
        if (wantsDir ? !stat.isDirectory() : !stat.isFile()) {
          journal.entries.push({ ...record, status: 'skipped', error: wantsDir ? '源已经不是目录' : '不是普通文件（可能是链接或目录）' });
          journal.skipped += 1;
          continue;
        }
        // 目录只看「计划里记的类型还对不对」，不比对 size/mtime —— 里面的文件变动与目录本身无关
        if (!wantsDir && item.size != null && stat.size !== item.size) {
          journal.entries.push({ ...record, status: 'skipped', error: '计划生成后文件被改动过' });
          journal.skipped += 1;
          continue;
        }
        if (!wantsDir && item.mtimeMs != null && Math.abs(stat.mtimeMs - item.mtimeMs) > 2) {
          journal.entries.push({ ...record, status: 'skipped', error: '计划生成后文件被改动过（mtime 变了）' });
          journal.skipped += 1;
          continue;
        }

        let destAbs = goalAbs;
        let collision = false;
        if (claimed.has(destAbs.toLowerCase()) || (await pathExists(destAbs))) {
          // manual 是「我说搬去哪就搬去哪」，目标冒出来就失败，不偷偷改成 (2)；
          // 目录更不行：两个目录合并要人决定。
          if (wantsDir || plan.strategy === 'manual') {
            journal.entries.push({
              ...record,
              status: 'failed',
              error: wantsDir ? '目标目录已存在（不自动合并）' : '目标已存在（manual 不自动改名）',
            });
            journal.failed += 1;
            continue;
          }
          collision = true;
          const free = await pickFreeName(goalAbs, claimed);
          if (!free) {
            journal.entries.push({ ...record, status: 'failed', error: '目标重名，且 (2)..(999) 都被占用' });
            journal.failed += 1;
            continue;
          }
          const identical =
            stat.size === (await fs.stat(destAbs).catch(() => ({ size: -1 }))).size &&
            (await fingerprint(srcAbs, stat.size)) === (await fingerprint(destAbs, stat.size));
          destAbs = free;
          record.note = identical ? '目标已有同内容文件，改名并存' : '目标重名，改名避让';
        }

        record.to = toRel(root, destAbs);
        claimed.add(destAbs.toLowerCase());

        if (dryRun) {
          journal.entries.push({ ...record, status: 'would-move', collision });
          journal.moved += 1;
          journal.bytes += wantsDir ? 0 : stat.size;
          continue;
        }

        await ensureDirs(path.dirname(destAbs), root, created);
        await moveEntry(srcAbs, destAbs, wantsDir);
        journal.entries.push({
          ...record,
          status: 'ok',
          size: wantsDir ? null : stat.size,
          mtimeMs: wantsDir ? null : stat.mtimeMs,
          hash: wantsDir ? null : await fingerprint(destAbs, stat.size),
        });
        journal.moved += 1;
        journal.bytes += wantsDir ? 0 : stat.size;
      } catch (err) {
        journal.entries.push({ ...record, status: 'failed', error: err?.code ?? err?.message ?? 'ERROR' });
        journal.failed += 1;
      }
    }

    if (!dryRun) {
      // 读回校验：不信 rename 成功，回盘上确认每一个落点
      for (const entry of journal.entries) {
        if (entry.status !== 'ok') continue;
        try {
          const stat = await fs.stat(path.resolve(root, entry.to));
          const typeOk = entry.kind === 'dir' ? stat.isDirectory() : stat.isFile();
          const sizeOk = entry.size == null || stat.size === entry.size;
          if (typeOk && sizeOk) journal.verified += 1;
        } catch {
          /* 落点不见了，verified 计数自然少一个 */
        }
      }
      if (journal.verified < journal.moved) {
        journal.warnings.push(`有 ${journal.moved - journal.verified} 个文件落点核对不上，建议立刻 undo 检查`);
      }
    }
  } finally {
    journal.createdDirs = [...created].sort();
    if (!dryRun) {
      journal.finishedAt = new Date().toISOString();
      try {
        await saveJournal(root, journal);
      } catch (err) {
        journal.warnings.push(`撤销日志写入失败（${err.code ?? err.message}）：这次移动没有账本，请人工核对`);
        journal.journalPath = null;
      }
    }
    await releaseLock(lockFile);
  }

  return journal;
}

/** 目标位置是否是「同名的另一个文件」（Windows/macOS 大小写不敏感时的典型冲突）。 */
async function occupiedByCaseTwin(fromAbs) {
  try {
    const dir = path.dirname(fromAbs);
    const base = path.basename(fromAbs).toLowerCase();
    const names = await fs.readdir(dir);
    return names.find((name) => name.toLowerCase() === base) ?? null;
  } catch {
    return null;
  }
}

/**
 * 撤销一次执行：严格倒着走，只回滚还完好的文件。
 * 三道硬检查：根目录身份、目标仍是普通文件、内容（大小 + mtime [+哈希]）没被动过。
 */
export async function undoJournal(journal, { dryRun = false } = {}) {
  const root = journal.root;
  const result = {
    journalId: journal.journalId,
    planId: journal.planId,
    root,
    dryRun,
    restored: 0,
    skipped: 0,
    failed: 0,
    prunedDirs: 0,
    entries: [],
    warnings: [],
  };

  // 1) 根目录身份：同一路径可能已经被另一个目录占用，那时一份都不能回滚。
  //    这里必须只读 —— 撤销预演（dryRun）一个字节都不许写。
  if (journal.stateId) {
    const current = await readStateId(root);
    if (current !== journal.stateId) {
      result.warnings.push(
        `这个目录已经不是当初整理的那个（状态标识 ${String(current).slice(0, 8)} ≠ ${String(journal.stateId).slice(0, 8)}），拒绝回滚`,
      );
      return result;
    }
  }

  for (const entry of [...journal.entries].reverse()) {
    if (entry.status !== 'ok') continue;
    const fromAbs = path.resolve(root, entry.from);
    const toAbs = path.resolve(root, entry.to);
    const record = { from: entry.from, to: entry.to };

    if (!insideRoot(root, fromAbs) || !insideRoot(root, toAbs)) {
      result.entries.push({ ...record, status: 'skipped', error: '日志里的路径越出根目录，不执行' });
      result.skipped += 1;
      continue;
    }

    let stat;
    try {
      stat = await fs.lstat(toAbs);
    } catch {
      result.entries.push({ ...record, status: 'skipped', error: '整理后的文件已经不在了' });
      result.skipped += 1;
      continue;
    }
    if (stat.isSymbolicLink()) {
      result.entries.push({ ...record, status: 'skipped', error: '目标位置变成了链接，不碰' });
      result.skipped += 1;
      continue;
    }
    const wantsDir = entry.kind === 'dir';
    if (wantsDir ? !stat.isDirectory() : !stat.isFile()) {
      result.entries.push({
        ...record,
        status: 'skipped',
        error: wantsDir ? '目标位置已经不是目录' : '目标位置已经不是普通文件',
      });
      result.skipped += 1;
      continue;
    }
    if (!wantsDir && entry.size != null && stat.size !== entry.size) {
      result.entries.push({ ...record, status: 'skipped', error: '移动之后内容大小变了，不敢回滚' });
      result.skipped += 1;
      continue;
    }
    if (!wantsDir && entry.mtimeMs != null && Math.abs(stat.mtimeMs - entry.mtimeMs) > 2) {
      result.entries.push({ ...record, status: 'skipped', error: '移动之后文件被改过（mtime 变了），不敢回滚' });
      result.skipped += 1;
      continue;
    }
    if (!wantsDir && entry.hash) {
      const current = await fingerprint(toAbs, stat.size);
      if (current && current !== entry.hash) {
        result.entries.push({ ...record, status: 'skipped', error: '移动之后文件内容被改过，不敢回滚' });
        result.skipped += 1;
        continue;
      }
    }
    if (await pathExists(fromAbs)) {
      const twin = await occupiedByCaseTwin(fromAbs);
      result.entries.push({
        ...record,
        status: 'skipped',
        error: twin
          ? `原位置被同名文件「${twin}」占住（只差大小写），这个平台放不下两个`
          : '原位置又被占用',
      });
      result.skipped += 1;
      continue;
    }

    if (dryRun) {
      result.entries.push({ ...record, status: 'would-restore' });
      result.restored += 1;
      continue;
    }

    try {
      await fs.mkdir(path.dirname(fromAbs), { recursive: true });
      await moveEntry(toAbs, fromAbs, wantsDir);
      result.entries.push({ ...record, status: 'restored' });
      result.restored += 1;
    } catch (err) {
      result.entries.push({ ...record, status: 'failed', error: err?.code ?? err?.message ?? 'ERROR' });
      result.failed += 1;
    }
  }

  if (!dryRun) {
    // 只删本次整理自己建的空目录，深的先删
    const dirs = [...(journal.createdDirs ?? [])].sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
    for (const rel of dirs) {
      try {
        await fs.rmdir(path.join(root, rel));
        result.prunedDirs += 1;
      } catch {
        /* ENOTEMPTY / ENOENT：说明目录里还有东西，留着 */
      }
    }
  }

  result.entries.reverse();
  return result;
}
