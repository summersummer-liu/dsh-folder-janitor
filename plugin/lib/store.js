// 计划与日志的落盘。放在被整理目录里的 .folder-janitor/ 下：
// 这样「撤销」跟着文件夹走，换台机器、挪个盘都还能回滚。

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { idStamp } from './classify.js';

const KEEP = 40; // 每种最多留 40 份，久了自动清掉最老的

export const STATE_DIR = '.folder-janitor';

/** 只读目录身份：没写过就返回 null，绝不创建（预演/撤销校验都不能改盘）。 */
export async function readStateId(root) {
  try {
    const text = (await fs.readFile(path.join(root, STATE_DIR, 'id'), 'utf8')).trim();
    return text || null;
  } catch {
    return null;
  }
}

/**
 * 目录身份：一个随机 id 存在 .folder-janitor/id 里，跟着目录走。
 * 目录改名没关系（id 跟着搬），但「同名的新目录占用了旧路径」能被识别出来 ——
 * 撤销靠它避免把别人的文件搬走。
 */
export async function ensureStateId(root) {
  const existing = await readStateId(root);
  if (existing) return existing;
  const dir = path.join(root, STATE_DIR);
  const id = crypto.randomBytes(8).toString('hex');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'id'), id, 'utf8');
  return id;
}

export function statePaths(root) {
  const dir = path.join(root, STATE_DIR);
  return {
    dir,
    plans: path.join(dir, 'plans'),
    journals: path.join(dir, 'journals'),
    planFile: (id) => path.join(dir, 'plans', `${id}.json`),
    journalFile: (id) => path.join(dir, 'journals', `${id}.json`),
  };
}

export function newId(prefix) {
  const rand = crypto.randomBytes(2).toString('hex');
  return `${prefix}-${idStamp()}-${rand}`;
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tmp, file); // 原子替换：写到一半断电不会留下半截 JSON
}

export async function readJson(file) {
  const text = await fs.readFile(file, 'utf8');
  return JSON.parse(text);
}

async function prune(dir) {
  let names = [];
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith('.json'));
  } catch {
    return 0;
  }
  if (names.length <= KEEP) return 0;
  names.sort(); // id 前缀带时间戳，字典序即时间序
  const drop = names.slice(0, names.length - KEEP);
  let removed = 0;
  for (const name of drop) {
    try {
      await fs.unlink(path.join(dir, name));
      removed += 1;
    } catch {
      /* 被占用就留着，不影响本次任务 */
    }
  }
  return removed;
}

export async function savePlan(root, plan) {
  const paths = statePaths(root);
  await writeJson(paths.planFile(plan.planId), plan);
  await prune(paths.plans);
  return paths.planFile(plan.planId);
}

export async function loadPlanByPath(file) {
  const plan = await readJson(file);
  if (!plan || plan.kind !== 'folder-janitor/plan') {
    throw new Error(`不是 folder-janitor 计划文件: ${file}`);
  }
  return plan;
}

export async function loadPlanById(root, id) {
  return loadPlanByPath(statePaths(root).planFile(id));
}

export async function saveJournal(root, journal) {
  const paths = statePaths(root);
  await writeJson(paths.journalFile(journal.journalId), journal);
  await prune(paths.journals);
  return paths.journalFile(journal.journalId);
}

export async function loadJournalByPath(file) {
  const journal = await readJson(file);
  if (!journal || journal.kind !== 'folder-janitor/journal') {
    throw new Error(`不是 folder-janitor 日志文件: ${file}`);
  }
  return journal;
}

export async function loadJournalById(root, id) {
  return loadJournalByPath(statePaths(root).journalFile(id));
}

export async function listPlans(root) {
  const dir = statePaths(root).plans;
  try {
    const names = (await fs.readdir(dir)).filter((n) => n.endsWith('.json'));
    names.sort();
    return names.map((n) => n.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

export async function listJournals(root) {
  const dir = statePaths(root).journals;
  try {
    const names = (await fs.readdir(dir)).filter((n) => n.endsWith('.json'));
    names.sort();
    return names.map((n) => n.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

/** target 既可能是 id，也可能是绝对路径。 */
export function looksLikePath(value) {
  return /[\\/]/.test(value) || value.endsWith('.json');
}
