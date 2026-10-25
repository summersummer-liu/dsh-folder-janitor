// 计划层：把「怎么整理」算成一份可复核的移动清单，然后写盘。
// 这里一个文件都不动 —— 动文件是 apply.js 的事，用户看过的计划才配执行。

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  CATEGORY_FOLDERS,
  categoryOf,
  dayStamp,
  humanBytes,
  isStructuralFile,
  junkOf,
  safeSegment,
  tokensOf,
  yearMonth,
} from './classify.js';
import { findDuplicates, insideRoot, pathExists, realInsideRoot, scanTree } from './scan.js';
import { newId, ensureStateId, savePlan } from './store.js';

export const STRATEGIES = ['by-type', 'by-date', 'by-project', 'archive-old', 'dedupe', 'manual'];

export const STRATEGY_LABELS = {
  'by-type': '按类型',
  'by-date': '按月份',
  'by-project': '按项目',
  'archive-old': '归档老文件',
  dedupe: '只去重',
  manual: '手动清单',
};

// manual 模式下不许整目录搬走的：搬了会弄坏别人的环境或工具链。
// plugins 是特意加进来的：这个目录经常是被别的工具/插件管理器指向的目标，
// 搬走会让指向它的 junction 变成悬空（reviewer 复现过）。
const PROTECTED_DIRS = new Set([
  '.git', '.folder-janitor', 'node_modules', '__pycache__', '.venv', 'venv', 'plugins',
]);

const ARCHIVE_DIR = 'archive';
const MAX_ENTRIES = 5000;

export const DEFAULT_OPTIONS = {
  depth: 1,
  junk: true,
  dedupe: false,
  olderDays: 180,
  quarantineDir: '_trash',
  duplicateDir: '_duplicates',
  ignore: [],
  keep: [],
};

function normalizeOptions(strategy, raw = {}) {
  const options = { ...DEFAULT_OPTIONS };
  if (Number.isFinite(Number(raw.depth))) options.depth = Math.trunc(Number(raw.depth));
  if (options.depth === 0) options.depth = 1;
  if (typeof raw.junk === 'boolean') options.junk = raw.junk;
  else if (strategy === 'dedupe') options.junk = false; // 只去重就只去重，别顺手清草稿
  // strategy=dedupe 本身就是「去掉重复」，不能因为它不是 content 策略就不做去重
  if (strategy === 'dedupe') options.dedupe = true;
  else if (typeof raw.dedupe === 'boolean') options.dedupe = raw.dedupe;
  if (Number.isFinite(Number(raw.olderDays)) && Number(raw.olderDays) > 0) {
    options.olderDays = Math.trunc(Number(raw.olderDays));
  }
  if (raw.quarantineDir) options.quarantineDir = safeSegment(raw.quarantineDir, '_trash');
  if (raw.duplicateDir) options.duplicateDir = safeSegment(raw.duplicateDir, '_duplicates');
  if (Array.isArray(raw.ignore)) options.ignore = raw.ignore.map(String).filter(Boolean);
  if (Array.isArray(raw.keep)) options.keep = raw.keep.map(String).filter(Boolean);
  return options;
}

function currentDirOf(rel) {
  const dir = path.dirname(rel);
  return dir === '.' ? '' : dir;
}

/**
 * 按文件名共词聚类。规则写死成三条，好解释也好预测：
 * 1. 一个词至少在 2 个文件里出现才算候选项目名；
 * 2. 覆盖超过 60% 文件的词太泛（比如所有文件都叫 xxx_final），直接淘汰；
 * 3. 每个文件挂到它命中的最稀有那个词上，平手取更长的词，再平手按字母序。
 */
export function groupByProject(items) {
  const perFile = new Map();
  const coverage = new Map();

  for (const item of items) {
    const stem = item.name.replace(/\.[^.]+$/, '');
    const tokens = tokensOf(stem);
    perFile.set(item.rel, tokens);
    for (const token of tokens) {
      const bucket = coverage.get(token) ?? new Set();
      bucket.add(item.rel);
      coverage.set(token, bucket);
    }
  }

  const genericLimit = Math.max(2, Math.floor(items.length * 0.6));
  const candidates = new Map();
  for (const [token, files] of coverage) {
    if (files.size < 2) continue;
    if (files.size > genericLimit) continue;
    candidates.set(token, files);
  }

  const assigned = new Map(); // token -> [item]
  const ungrouped = [];
  const ordered = [...items].sort((a, b) => (a.rel < b.rel ? -1 : 1));

  for (const item of ordered) {
    const tokens = (perFile.get(item.rel) ?? []).filter((token) => candidates.has(token));
    if (tokens.length === 0) {
      ungrouped.push(item);
      continue;
    }
    tokens.sort((a, b) => {
      // 先偏向不含数字的词：sphere 比 r600mm 更像项目名
      const byDigit = (/\d/.test(a) ? 1 : 0) - (/\d/.test(b) ? 1 : 0);
      if (byDigit !== 0) return byDigit;
      const bySize = candidates.get(a).size - candidates.get(b).size;
      if (bySize !== 0) return bySize;
      if (a.length !== b.length) return b.length - a.length;
      return a < b ? -1 : 1;
    });
    const chosen = tokens[0];
    const bucket = assigned.get(chosen) ?? [];
    bucket.push(item);
    assigned.set(chosen, bucket);
  }

  const groups = [...assigned.entries()]
    .filter(([, files]) => files.length >= 2)
    .map(([token, files]) => ({
      token,
      folder: safeSegment(token, 'project'),
      files: files.map((f) => f.rel).sort(),
    }));

  // 同一个词净化后可能撞名（比如 a/b 和 a:b），合并成一个组
  const merged = new Map();
  for (const group of groups) {
    const existing = merged.get(group.folder);
    if (existing) {
      existing.files = [...new Set([...existing.files, ...group.files])].sort();
    } else {
      merged.set(group.folder, { folder: group.folder, token: group.token, files: [...group.files] });
    }
  }

  const kept = new Set([...merged.values()].flatMap((group) => group.files));
  for (const item of ordered) {
    if (!kept.has(item.rel) && !ungrouped.some((u) => u.rel === item.rel)) ungrouped.push(item);
  }

  return {
    groups: [...merged.values()].sort((a, b) => b.files.length - a.files.length || (a.folder < b.folder ? -1 : 1)),
    ungrouped: ungrouped.map((item) => item.rel).sort(),
  };
}

/**
 * 生成计划。返回的计划对象同时已写入 <root>/.folder-janitor/plans/<id>.json。
 */
export async function buildPlan({ root, strategy = 'by-type', options: rawOptions = {}, now = Date.now() } = {}) {
  if (!STRATEGIES.includes(strategy)) {
    throw new Error(`未知策略 ${strategy}，可用：${STRATEGIES.join(' / ')}`);
  }

  const rootAbs = path.resolve(root);
  let stat;
  try {
    stat = await fs.stat(rootAbs);
  } catch {
    throw new Error(`目录不存在: ${rootAbs}`);
  }
  if (!stat.isDirectory()) throw new Error(`不是目录: ${rootAbs}`);

  const options = normalizeOptions(strategy, rawOptions);

  // 手动清单：不扫全树、不套策略，只逐条校验 agent 给出的 from → to
  if (strategy === 'manual') {
    return buildManualPlan({ rootAbs, options, rawItems: rawOptions.items, now });
  }

  const reserved = new Set([
    options.quarantineDir,
    options.duplicateDir,
    ARCHIVE_DIR,
    ...Object.values(CATEGORY_FOLDERS),
  ]);

  const scan = await scanTree(rootAbs, {
    maxDepth: options.depth,
    ignore: options.ignore,
    skipDirs: reserved,
  });

  const entries = [];
  const skipped = [];
  const skip = (item, reason) => skipped.push({ from: item.rel, reason });

  const pending = [...scan.items].sort((a, b) => (a.rel < b.rel ? -1 : 1));

  // 0) 结构文件先摘出来：README/AGENTS/WORKFLOW/隐藏文件，任何策略都不动它们
  const candidates = [];
  for (const item of pending) {
    if (isStructuralFile(item.name, options.keep)) {
      skip(item, '结构文件（README/AGENTS/隐藏文件等）保持原位');
      continue;
    }
    candidates.push(item);
  }

  // 1) 垃圾/草稿 -> _trash/<今天>/
  const afterJunk = [];
  if (options.junk) {
    const bucket = dayStamp(now);
    for (const item of candidates) {
      const verdict = junkOf(item.name, item.size);
      if (verdict) {
        entries.push({
          from: item.rel,
          to: path.join(options.quarantineDir, bucket, item.rel),
          kind: 'junk',
          reason: verdict.reason,
          size: item.size,
          mtimeMs: item.mtimeMs,
        });
      } else {
        afterJunk.push(item);
      }
    }
  } else {
    afterJunk.push(...candidates);
  }

  // 2) 重复内容 -> _duplicates/<今天>/
  const afterDedupe = [];
  let duplicateReport = { groups: 0, redundantFiles: 0, reclaimableBytes: 0 };
  if (options.dedupe) {
    const dup = await findDuplicates(rootAbs, afterJunk);
    const extras = new Map(); // rel -> 组信息
    for (const group of dup.groups) {
      for (const rel of group.extras) extras.set(rel, group);
    }
    const bucket = dayStamp(now);
    for (const item of afterJunk) {
      const group = extras.get(item.rel);
      if (!group) {
        afterDedupe.push(item);
        continue;
      }
      entries.push({
        from: item.rel,
        to: path.join(options.duplicateDir, bucket, item.rel),
        kind: 'dupe',
        reason: `与 ${group.keep} 内容相同（${humanBytes(group.size)}）`,
        size: item.size,
      });
      duplicateReport.redundantFiles += 1;
      duplicateReport.reclaimableBytes += group.size;
    }
    duplicateReport.groups = dup.groups.length;
  } else {
    afterDedupe.push(...afterJunk);
  }

  // 3) 正文：按策略分类
  const projectNotes = { groups: 0, ungrouped: 0, folders: [] };
  if (strategy !== 'dedupe') {
    if (strategy === 'by-project') {
      const loose = afterDedupe.filter((item) => item.depth === 1);
      for (const item of afterDedupe) {
        if (item.depth !== 1) skip(item, '在子目录里，by-project 只整理根目录散落文件');
      }
      const grouping = groupByProject(loose);
      const target = new Map();
      for (const group of grouping.groups) {
        for (const rel of group.files) target.set(rel, group.folder);
      }
      projectNotes.groups = grouping.groups.length;
      projectNotes.ungrouped = grouping.ungrouped.length;
      projectNotes.folders = grouping.groups.map((group) => ({ folder: group.folder, files: group.files.length }));

      for (const item of loose) {
        const folder = target.get(item.rel);
        if (!folder) {
          skip(item, '文件名里没有能跟别人共用的项目词');
          continue;
        }
        const destDir = folder;
        if (currentDirOf(item.rel) === destDir) {
          skip(item, '已经在这个项目目录里');
          continue;
        }
        entries.push({
          from: item.rel,
          to: path.join(destDir, path.basename(item.rel)),
          kind: 'content',
          reason: `项目「${folder}」`,
          size: item.size,
          mtimeMs: item.mtimeMs,
        });
      }
    } else {
      const cutoff = now - options.olderDays * 86400000;
      for (const item of afterDedupe) {
        let destDir;
        let reason;
        if (strategy === 'by-type') {
          const category = categoryOf(item.name);
          destDir = CATEGORY_FOLDERS[category] ?? CATEGORY_FOLDERS.other;
          reason = `${categoryOf(item.name)} 类型`;
        } else if (strategy === 'by-date') {
          destDir = yearMonth(item.mtimeMs);
          reason = `修改于 ${yearMonth(item.mtimeMs)}`;
        } else if (strategy === 'archive-old') {
          if (item.mtimeMs > cutoff) {
            skip(item, `未超过 ${options.olderDays} 天，保持原样`);
            continue;
          }
          destDir = path.join(ARCHIVE_DIR, yearMonth(item.mtimeMs));
          reason = `${options.olderDays} 天前的旧文件`;
        }
        if (!destDir) continue;
        if (currentDirOf(item.rel) === destDir) {
          skip(item, '已经分好类，无需移动');
          continue;
        }
        entries.push({
          from: item.rel,
          // 保留原有相对子路径：depth>1 时不同子目录下的同名文件不会互相覆盖
          to: path.join(destDir, item.rel),
          kind: 'content',
          reason,
          size: item.size,
          mtimeMs: item.mtimeMs,
        });
      }
    }
  }

  entries.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));

  const warnings = [];
  if (scan.truncated) warnings.push(`文件数超过上限（${scan.items.length}），只处理了前 ${scan.items.length} 个`);
  if (scan.errors.length > 0) warnings.push(`${scan.errors.length} 个路径读不了（权限/占用），已跳过`);
  if (scan.symlinks.length > 0) {
    warnings.push(`跳过了 ${scan.symlinks.length} 个符号链接/目录联接（不跟进链接，避免搬走外面的东西）`);
  }
  if (entries.length === 0) warnings.push('没有需要移动的文件：要么已经整齐，要么全都命中了跳过条件');
  if (entries.length > MAX_ENTRIES) {
    entries.length = MAX_ENTRIES;
    warnings.push(`移动条目超过 ${MAX_ENTRIES} 条，只保留前 ${MAX_ENTRIES} 条`);
  }
  if (strategy === 'by-project' && projectNotes.groups === 0) {
    warnings.push('没找到共享项目词，by-project 无从下手；换 by-type 或人工给规则');
  }

  const plan = {
    kind: 'folder-janitor/plan',
    planId: newId('plan'),
    createdAt: new Date(now).toISOString(),
    root: rootAbs,
    stateId: await ensureStateId(rootAbs),
    strategy,
    strategyLabel: STRATEGY_LABELS[strategy],
    options,
    checked: scan.items.length,
    dirs: scan.dirCount,
    ignoredDirs: scan.ignoredDirs.length,
    entries,
    skipped: skipped.slice(0, 500),
    skippedTotal: skipped.length,
    projectNotes,
    duplicateReport,
    warnings,
  };

  const file = await savePlan(rootAbs, plan);
  return { plan, file };
}

// ---------------------------------------------------------------- manual：人工清单
//
// 有些整理需求根本猜不出来：把 `attachment_17434050909562708` 改成
// `知末_施工图与案例素材`，或者把 `.pdftmp` 整个扔进回收站。
// 这些是「agent 想清楚 → 列成清单 → 人看过 → 再执行」，不需要策略，只需要校验：
// 不越界、不碰联接、不覆盖、不搬进自己肚子里。

function normalizeRel(value) {
  const raw = String(value ?? '').replace(/[\\/]+/g, path.sep).trim();
  return raw.startsWith(`.${path.sep}`) ? raw.slice(2) : raw;
}

async function buildManualPlan({ rootAbs, options, rawItems, now }) {
  const items = Array.isArray(rawItems) ? rawItems : [];
  if (items.length === 0) {
    throw new Error('manual 策略需要 items：形如 [{ "from": "旧名字", "to": "新名字" }]');
  }

  const entries = [];
  const skipped = [];
  const warnings = [];
  const seenTargets = new Set();

  for (const item of items) {
    const from = normalizeRel(item?.from);
    const to = normalizeRel(item?.to);
    const label = from || String(item?.from ?? '');
    const refuse = (reason) => skipped.push({ from: label, reason });

    if (!from || !to) {
      refuse('from / to 都要给');
      continue;
    }
    if (path.isAbsolute(from) || path.isAbsolute(to)) {
      refuse('不接受绝对路径，请写相对于 root 的路径');
      continue;
    }

    const srcAbs = path.resolve(rootAbs, from);
    const destAbs = path.resolve(rootAbs, to);
    if (!insideRoot(rootAbs, srcAbs) || !insideRoot(rootAbs, destAbs)) {
      refuse('路径越出 root');
      continue;
    }

    let stat;
    try {
      stat = await fs.lstat(srcAbs);
    } catch {
      refuse('源不存在');
      continue;
    }
    if (stat.isSymbolicLink()) {
      refuse('符号链接/目录联接不搬（会弄坏指向它的东西）');
      continue;
    }
    if (!(await realInsideRoot(rootAbs, srcAbs)) || !(await realInsideRoot(rootAbs, destAbs))) {
      refuse('真实路径越出 root（路径里经过 junction 或符号链接）');
      continue;
    }
    const isDir = stat.isDirectory();
    if (!isDir && !stat.isFile()) {
      refuse('不是普通文件或目录');
      continue;
    }
    if (isDir && PROTECTED_DIRS.has(path.basename(srcAbs).toLowerCase())) {
      refuse('受保护目录名，拒绝整体搬走');
      continue;
    }
    if (isDir && (destAbs === srcAbs || destAbs.startsWith(srcAbs + path.sep))) {
      refuse('不能把目录搬到它自己里面');
      continue;
    }
    if (await pathExists(destAbs)) {
      refuse('目标已存在（manual 不做合并，要合并请拆成单条文件移动）');
      continue;
    }
    const targetKey = destAbs.toLowerCase();
    if (seenTargets.has(targetKey)) {
      refuse('同一批清单里目标重复');
      continue;
    }
    seenTargets.add(targetKey);

    const sameParent = path.dirname(from) === path.dirname(to);
    const entry = {
      from,
      to,
      kind: isDir ? 'dir' : 'file',
      reason: String(item?.reason ?? '') || (sameParent ? '重命名' : '移动'),
      size: isDir ? null : stat.size,
      mtimeMs: stat.mtimeMs,
    };
    // 值为 undefined 的键会让工具输出的 lossless-JSON 校验失败，所以按需才加
    if (sameParent) entry.note = 'rename';
    entries.push(entry);
  }

  entries.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  if (entries.length === 0) warnings.push('清单里没有可执行的条目');
  if (skipped.length > 0) warnings.push(`${skipped.length} 条被拒绝，原因见跳过清单`);

  const plan = {
    kind: 'folder-janitor/plan',
    planId: newId('plan'),
    createdAt: new Date(now).toISOString(),
    root: rootAbs,
    stateId: await ensureStateId(rootAbs),
    strategy: 'manual',
    strategyLabel: STRATEGY_LABELS.manual,
    options,
    checked: items.length,
    dirs: entries.filter((entry) => entry.kind === 'dir').length,
    ignoredDirs: 0,
    entries,
    skipped: skipped.slice(0, 500),
    skippedTotal: skipped.length,
    projectNotes: { groups: 0, ungrouped: 0, folders: [] },
    duplicateReport: { groups: 0, redundantFiles: 0, reclaimableBytes: 0 },
    warnings,
  };

  const file = await savePlan(rootAbs, plan);
  return { plan, file };
}
