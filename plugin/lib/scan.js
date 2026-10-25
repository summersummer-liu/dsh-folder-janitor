// 读盘层：遍历目录、做体检报告、算内容哈希。
// 一条原则：只读，绝不在这里改文件。所有落盘动作集中在 apply.js。

import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  CATEGORY_FOLDERS,
  CATEGORY_LABELS,
  IGNORED_DIRS,
  IGNORED_FILES,
  categoryOf,
  extOf,
  humanBytes,
  junkOf,
} from './classify.js';

const MAX_FILES = 20000;
const HASH_CONCURRENCY = 8;

export function toRel(root, abs) {
  const rel = path.relative(root, abs);
  return rel === '' ? '.' : rel;
}

export function insideRoot(root, abs) {
  const rel = path.relative(root, abs);
  if (!rel) return false; // 就是 root 自己，不算「里面」
  if (path.isAbsolute(rel)) return false;
  // 只看首段是不是 ..：root 里合法的 ..probe.txt 不能被当成越界
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

/**
 * 真实路径校验：字符串判断挡不住 junction/符号链接。
 * 取目标或其最近存在祖先的 realpath，再跟 root 的 realpath 比 ——
 * 这样 `to: "某联接/文件"` 不会被放进 root 外面的目录。
 */
export async function realInsideRoot(root, abs) {
  let rootReal;
  try {
    rootReal = await fs.realpath(root);
  } catch {
    return false;
  }
  let cursor = abs;
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const real = await fs.realpath(cursor);
      const rel = path.relative(rootReal, real);
      // 最近的已存在祖先就是 root 本身：剩下还没创建的那几段由我们创建，允许
      if (rel === '') return true;
      return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) return false;
      cursor = parent;
    }
  }
  return false;
}

/**
 * 遍历一棵目录树。depth 语义：直接放在 root 里的文件 depth=1。
 * maxDepth=1 只看根目录，2 含一层子目录，-1 表示不限。
 */
export async function scanTree(root, { maxDepth = 1, ignore = [], skipDirs = new Set() } = {}) {
  const items = [];
  const ignoredDirs = [];
  const symlinks = [];
  const errors = [];
  let dirCount = 0;
  let truncated = false;

  const ignoreSet = new Set(ignore.map((s) => String(s).toLowerCase()));

  async function walk(dirAbs, level) {
    let entries;
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true });
    } catch (err) {
      errors.push({ path: toRel(root, dirAbs), error: err.code || err.message });
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      const abs = path.join(dirAbs, entry.name);
      const rel = toRel(root, abs);

      if (entry.isSymbolicLink()) {
        symlinks.push(rel);
        continue;
      }

      if (entry.isDirectory()) {
        const lower = entry.name.toLowerCase();
        if (IGNORED_DIRS.has(entry.name) || ignoreSet.has(lower) || skipDirs.has(entry.name)) {
          ignoredDirs.push(rel);
          continue;
        }
        if (entry.name.startsWith('.')) {
          ignoredDirs.push(rel);
          continue;
        }
        dirCount += 1;
        const mayDescend = level + 1 < maxDepth || maxDepth < 0;
        if (mayDescend) await walk(abs, level + 1);
        continue;
      }

      if (!entry.isFile()) continue;
      if (IGNORED_FILES.has(entry.name)) continue;
      if (ignoreSet.has(entry.name.toLowerCase())) continue;
      if (ignoreSet.has(rel.toLowerCase())) continue;

      let stat;
      try {
        stat = await fs.stat(abs);
      } catch (err) {
        errors.push({ path: rel, error: err.code || err.message });
        continue;
      }

      items.push({
        rel,
        name: entry.name,
        ext: extOf(entry.name),
        category: categoryOf(entry.name),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        depth: level + 1,
      });

      if (items.length >= MAX_FILES) {
        truncated = true;
        return;
      }
    }
  }

  await walk(root, 0);
  return { items, dirCount, ignoredDirs, symlinks, errors, truncated };
}

export async function hashFile(abs) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(abs)) hash.update(chunk);
  return hash.digest('hex').slice(0, 32);
}

async function mapLimit(list, limit, fn) {
  const results = new Array(list.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (next < list.length) {
      const index = next;
      next += 1;
      results[index] = await fn(list[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * 找内容完全重复的文件：先按大小分桶，只有同大小的才真的去哈希，
 * 几百个 0 字节空文件不会拖慢速度。
 * keep = 修改时间最新的那一份（「留最新」是这个工作区一贯的做法）。
 */
export async function findDuplicates(root, items) {
  const bySize = new Map();
  for (const item of items) {
    if (item.size === 0) continue;
    const bucket = bySize.get(item.size);
    if (bucket) bucket.push(item);
    else bySize.set(item.size, [item]);
  }

  const candidates = [...bySize.values()].filter((group) => group.length > 1);
  if (candidates.length === 0) return { groups: [], hashedFiles: 0, errors: [] };

  const flat = candidates.flat();
  const errors = [];
  const hashes = await mapLimit(flat, HASH_CONCURRENCY, async (item) => {
    try {
      return await hashFile(path.join(root, item.rel));
    } catch (err) {
      errors.push({ path: item.rel, error: err.code || err.message });
      return null;
    }
  });
  flat.forEach((item, index) => {
    item.hash = hashes[index];
  });

  const byHash = new Map();
  for (const item of flat) {
    if (!item.hash) continue;
    const key = `${item.size}:${item.hash}`;
    const bucket = byHash.get(key);
    if (bucket) bucket.push(item);
    else byHash.set(key, [item]);
  }

  const groups = [];
  for (const members of byHash.values()) {
    if (members.length < 2) continue;
    members.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.rel < b.rel ? -1 : 1));
    groups.push({
      key: `${members[0].size}:${members[0].hash}`,
      size: members[0].size,
      hash: members[0].hash,
      keep: members[0].rel,
      extras: members.slice(1).map((m) => m.rel),
      reclaimableBytes: members[0].size * (members.length - 1),
    });
  }
  groups.sort((a, b) => b.reclaimableBytes - a.reclaimableBytes);

  return { groups, hashedFiles: flat.length, errors };
}

export async function pathExists(abs) {
  try {
    await fs.lstat(abs);
    return true;
  } catch {
    return false;
  }
}

const TRASH_DIR_CANDIDATES = ['_trash', '_duplicates'];

/** 一次只读体检：用户说「这文件夹太乱了」时先给他看这个。 */
export async function buildInventory(root, { maxDepth = 1, ignore = [], hashes = true } = {}) {
  const scan = await scanTree(root, {
    maxDepth,
    ignore,
    skipDirs: new Set(TRASH_DIR_CANDIDATES),
  });

  const { items } = scan;
  const totalBytes = items.reduce((sum, item) => sum + item.size, 0);

  const byCategory = new Map();
  for (const item of items) {
    const entry = byCategory.get(item.category) ?? { category: item.category, files: 0, bytes: 0 };
    entry.files += 1;
    entry.bytes += item.size;
    byCategory.set(item.category, entry);
  }
  const categories = [...byCategory.values()].sort((a, b) => b.files - a.files || b.bytes - a.bytes);

  const byExt = new Map();
  for (const item of items) {
    const key = item.ext || '(无扩展名)';
    const entry = byExt.get(key) ?? { ext: key, files: 0, bytes: 0 };
    entry.files += 1;
    entry.bytes += item.size;
    byExt.set(key, entry);
  }
  const topExtensions = [...byExt.values()].sort((a, b) => b.files - a.files || b.bytes - a.bytes).slice(0, 8);

  const junk = [];
  for (const item of items) {
    const verdict = junkOf(item.name, item.size);
    if (verdict) junk.push({ rel: item.rel, size: item.size, rule: verdict.id, reason: verdict.reason });
  }
  junk.sort((a, b) => b.size - a.size || (a.rel < b.rel ? -1 : 1));

  let duplicates = { groups: [], hashedFiles: 0, errors: [] };
  if (hashes) duplicates = await findDuplicates(root, items);

  const dupFiles = duplicates.groups.reduce((sum, group) => sum + group.extras.length, 0);
  const reclaimable = duplicates.groups.reduce((sum, group) => sum + group.reclaimableBytes, 0);

  const inventory = {
    root,
    files: items.length,
    dirs: scan.dirCount,
    totalBytes,
    truncated: scan.truncated,
    categories,
    topExtensions,
    junk: { count: junk.length, bytes: junk.reduce((s, j) => s + j.size, 0), samples: junk.slice(0, 8) },
    duplicates: {
      groups: duplicates.groups.length,
      redundantFiles: dupFiles,
      reclaimableBytes: reclaimable,
      samples: duplicates.groups.slice(0, 5),
      errors: duplicates.errors.length,
    },
    ignoredDirs: scan.ignoredDirs.length,
    ignoredSamples: scan.ignoredDirs.slice(0, 6),
    symlinks: scan.symlinks.length,
    errors: scan.errors,
  };
  inventory.suggestions = suggestionsFor(inventory);
  return inventory;
}

const STRATEGY_HINT = {
  'by-type': '按文件类型分到 documents/images/scripts/data…',
  'by-date': '按修改月份分到 2026-10 这样的目录',
  'by-project': '按文件名里的项目共词聚类',
  'archive-old': '老文件归档到 archive/YYYY-MM/',
  dedupe: '只处理内容重复的文件',
};

/** 体检报告末尾的「下一步做什么」，规则是死的，但比让人自己猜强。 */
export function suggestionsFor(inv) {
  const out = [];
  const loose = inv.files;
  const junkRatio = inv.files > 0 ? inv.junk.count / inv.files : 0;
  const topCategoryRatio = inv.files > 0 && inv.categories[0] ? inv.categories[0].files / inv.files : 0;

  if (loose === 0) {
    out.push('这个目录没有可整理的文件（只有子目录或已被忽略）。');
    return out;
  }
  if (junkRatio >= 0.12) {
    out.push(
      `约 ${inv.junk.count} 个临时/草稿文件（${Math.round(junkRatio * 100)}%），先 by-type + junk=true 把它们收进 _trash，再谈分类。`,
    );
  }
  if (inv.duplicates.redundantFiles > 0) {
    out.push(
      `${inv.duplicates.groups} 组内容完全重复，可回收 ${humanBytes(inv.duplicates.reclaimableBytes)}；按文件名分不开的话用 strategy=dedupe。`,
    );
  }
  if (topCategoryRatio >= 0.6 && inv.files >= 20) {
    out.push(
      `已经有 ${Math.round(topCategoryRatio * 100)}% 是${CATEGORY_LABELS[inv.categories[0].category] ?? inv.categories[0].category}，${STRATEGY_HINT['by-type']}收益不大，试试 by-project。`,
    );
  } else if (loose >= 40) {
    out.push(`散落文件 ${loose} 个，先用 ${STRATEGY_HINT['by-type']}（depth=1，不动已有项目文件夹）。`);
  }
  if (inv.categories.length >= 4 && topCategoryRatio < 0.5) {
    out.push('类型很分散，by-project 或 by-date 通常比 by-type 更接近「找得到」的目标。');
  }
  if (out.length === 0) out.push('结构已经比较整齐，可以先 by-type 做一次微调，或直接用 inventory 的结果收工。');
  return out;
}

export const CATEGORY_FOLDER = CATEGORY_FOLDERS;
