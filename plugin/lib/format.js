// 呈现层：把 JSON 结果压成人能读的几行。信息密度优先，不写客套话。

import {
  CATEGORY_LABELS,
  humanBytes,
} from './classify.js';

const MAX_LINES = 14;

function clip(text, max = 64) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function listSamples(rows, render, limit = MAX_LINES) {
  const lines = rows.slice(0, limit).map(render);
  if (rows.length > limit) lines.push(`… 还有 ${rows.length - limit} 条`);
  return lines;
}

export function renderInventory(inv) {
  const lines = [];
  lines.push(`目录 ${inv.root}`);
  lines.push(
    `文件 ${inv.files} 个 / ${humanBytes(inv.totalBytes)} · 目录 ${inv.dirs} 个 · 忽略 ${inv.ignoredDirs} 个依赖/缓存目录`,
  );

  if (inv.files === 0) {
    lines.push('这里没有可整理的文件（只有子目录，或者全在忽略名单里）。');
    return [{ type: 'text', text: lines.join('\n') }];
  }

  lines.push('');
  lines.push('类型分布：');
  lines.push(
    inv.categories
      .slice(0, 6)
      .map((c) => `${CATEGORY_LABELS[c.category] ?? c.category} ${c.files} 个 (${humanBytes(c.bytes)})`)
      .join(' · '),
  );
  lines.push(`主要扩展名：${inv.topExtensions.map((e) => `${e.ext} ${e.files}`).join(' · ')}`);

  if (inv.junk.count > 0) {
    lines.push('');
    lines.push(`草稿/临时 ${inv.junk.count} 个（${humanBytes(inv.junk.bytes)}）：`);
    lines.push(
      '  ' +
        inv.junk.samples
          .slice(0, 5)
          .map((j) => `${clip(j.rel, 40)}（${j.reason}）`)
          .join('、'),
    );
  }

  if (inv.duplicates.groups > 0) {
    lines.push('');
    lines.push(
      `重复内容 ${inv.duplicates.groups} 组，多余 ${inv.duplicates.redundantFiles} 个，可回收 ${humanBytes(inv.duplicates.reclaimableBytes)}：`,
    );
    lines.push(...listSamples(inv.duplicates.samples, (g) => `  ${clip(g.keep, 40)} ≡ ${clip(g.extras[0], 40)}（${humanBytes(g.size)}）`, 3));
  }

  if (inv.truncated) lines.push('注意：文件数达到上限，统计不完整。');
  if (inv.errors.length > 0) lines.push(`有 ${inv.errors.length} 个路径读不了（权限/占用）。`);

  lines.push('');
  lines.push('建议：');
  for (const suggestion of inv.suggestions) lines.push(`  · ${suggestion}`);
  lines.push('');
  lines.push(`下一步：folder_plan(root="${inv.root}", strategy="by-type") 先出计划，别直接动手。`);
  return [{ type: 'text', text: lines.join('\n') }];
}

function groupByTop(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const parts = String(entry.to).split(/[\\/]/);
    const top = parts.length > 1 ? parts[0] : `根目录`;
    const bucket = groups.get(top) ?? { name: top, count: 0, bytes: 0 };
    bucket.count += 1;
    bucket.bytes += entry.size ?? 0;
    groups.set(top, bucket);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));
}

export function renderPlan(plan) {
  const lines = [];
  const optionBits = [`depth=${plan.options.depth < 0 ? '∞' : plan.options.depth}`, `junk=${plan.options.junk ? '开' : '关'}`];
  if (plan.options.dedupe) optionBits.push('dedupe=开');
  if (plan.strategy === 'archive-old') optionBits.push(`older_than=${plan.options.olderDays}天`);

  lines.push(`计划 ${plan.planId} · ${plan.strategyLabel} · ${optionBits.join(' · ')}`);
  lines.push(
    `检查 ${plan.checked} 个文件，待移动 ${plan.entries.length} 个（${humanBytes(plan.entries.reduce((s, e) => s + (e.size ?? 0), 0))}），跳过 ${plan.skippedTotal} 个`,
  );

  if (plan.entries.length === 0) {
    lines.push('没有要移动的文件。');
  } else {
    const groups = groupByTop(plan.entries);
    lines.push('去向：');
    lines.push('  ' + groups.map((g) => `${g.name} ${g.count} 个`).join(' · '));

    if (plan.strategy === 'by-project' && plan.projectNotes?.folders?.length) {
      lines.push('项目组：');
      lines.push('  ' + plan.projectNotes.folders.slice(0, 8).map((f) => `${f.folder} (${f.files})`).join(' · '));
    }

    lines.push('');
    lines.push('示例：');
    lines.push(...listSamples(plan.entries, (e) => `  ${clip(e.from, 46)} → ${clip(e.to, 46)}`, 10));
  }

  if (plan.warnings.length > 0) {
    lines.push('');
    for (const warning of plan.warnings) lines.push(`注意：${warning}`);
  }

  if (plan.skipped.length > 0) {
    lines.push('');
    lines.push(`跳过 ${plan.skippedTotal} 个，前几条原因：`);
    lines.push(...listSamples(plan.skipped, (s) => `  ${clip(s.from, 40)} —— ${s.reason}`, 4));
  }

  lines.push('');
  lines.push(`计划文件：${plan.planPath}`);
  lines.push(`下一步：folder_apply(plan="${plan.planId}", root="${plan.root}") —— 想先演练就加 dry_run=true。`);
  return [{ type: 'text', text: lines.join('\n') }];
}

export function renderApply(journal) {
  const lines = [];
  const head = journal.dryRun ? '演练（没有动任何文件）' : '执行完成';
  lines.push(`${head} · 计划 ${journal.planId} · 日志 ${journal.journalId}`);
  lines.push(
    `${journal.dryRun ? '将移动' : '已移动'} ${journal.moved} 个（${humanBytes(journal.bytes)}）· 跳过 ${journal.skipped} · 失败 ${journal.failed}` +
      (journal.dryRun ? '' : ` · 读回核对 ${journal.verified}/${journal.moved}`),
  );

  const ok = journal.entries.filter((e) => e.status === 'ok' || e.status === 'would-move');
  if (ok.length > 0) {
    const groups = groupByTop(ok);
    lines.push(`去向：${groups.map((g) => `${g.name} ${g.count}`).join(' · ')}`);
    lines.push('');
    lines.push('前几条：');
    lines.push(...listSamples(ok, (e) => `  ${clip(e.from, 44)} → ${clip(e.to, 44)}${e.note ? `（${e.note}）` : ''}`, 8));
  }

  const bad = journal.entries.filter((e) => e.status === 'failed' || e.status === 'skipped');
  if (bad.length > 0) {
    lines.push('');
    lines.push('没动的：');
    lines.push(...listSamples(bad, (e) => `  ${clip(e.from, 40)} —— ${e.error}`, 5));
  }

  if (journal.createdDirs?.length) {
    lines.push('');
    lines.push(`新建目录：${journal.createdDirs.slice(0, 8).join('、')}${journal.createdDirs.length > 8 ? ' …' : ''}`);
  }
  if (journal.warnings?.length) {
    for (const warning of journal.warnings) lines.push(`注意：${warning}`);
  }

  lines.push('');
  if (journal.dryRun) {
    lines.push(`确认无误后去掉 dry_run 再执行一次。`);
  } else if (journal.moved > 0) {
    lines.push(`后悔药：folder_undo(target="${journal.journalId}", root="${journal.root}")`);
  } else {
    lines.push('这一轮没有移动任何文件，盘上没有变化。');
  }
  return [{ type: 'text', text: lines.join('\n') }];
}

export function renderUndo(result) {
  const lines = [];
  const head = result.dryRun ? '撤销演练' : '撤销完成';
  lines.push(`${head} · 日志 ${result.journalId}${result.planId ? ` · 计划 ${result.planId}` : ''}`);
  lines.push(
    `${result.dryRun ? '将恢复' : '已恢复'} ${result.restored} 个 · 跳过 ${result.skipped} · 失败 ${result.failed} · 清掉 ${result.prunedDirs} 个空目录`,
  );

  const restored = result.entries.filter((e) => e.status === 'restored' || e.status === 'would-restore');
  if (restored.length > 0) {
    lines.push('');
    lines.push('恢复：');
    lines.push(...listSamples(restored, (e) => `  ${clip(e.to, 44)} → ${clip(e.from, 44)}`, 8));
  }

  const bad = result.entries.filter((e) => e.status !== 'restored' && e.status !== 'would-restore');
  if (bad.length > 0) {
    lines.push('');
    lines.push('没恢复的：');
    lines.push(...listSamples(bad, (e) => `  ${clip(e.to, 40)} —— ${e.error}`, 5));
  }
  if (result.warnings?.length) {
    lines.push('');
    for (const warning of result.warnings) lines.push(`注意：${warning}`);
  }
  return [{ type: 'text', text: lines.join('\n') }];
}
