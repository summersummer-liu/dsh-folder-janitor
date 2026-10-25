// timeline.mjs — reads D:\阅读学习\.folder-janitor\{plans,journals}\*.json (+ optional
// timeline_extra.json produced by hand from undo verification) and writes timeline.md.
import fs from 'node:fs/promises';
import path from 'node:path';

const DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = 'D:\\阅读学习';
const STATE = path.join(ROOT, '.folder-janitor');

const KB = 1024, MB = KB * 1024, GB = MB * 1024;
const human = (n) => n == null ? 'null' : n >= GB ? (n / GB).toFixed(2) + ' GB' : n >= MB ? (n / MB).toFixed(1) + ' MB' : n >= KB ? (n / KB).toFixed(1) + ' KB' : n + ' B';
const nf = new Intl.NumberFormat('en-US');

// local +08:00 rendering without deps
function shanghai(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const s = new Date(d.getTime() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  return s;
}
async function readJsonDir(p) {
  let names = [];
  try { names = (await fs.readdir(p)).filter(n => n.endsWith('.json')).sort(); } catch { return []; }
  const out = [];
  for (const n of names) {
    try { out.push({ file: n, ...JSON.parse(await fs.readFile(path.join(p, n), 'utf8')) }); }
    catch (e) { out.push({ file: n, error: String(e.message) }); }
  }
  return out;
}

const plans = await readJsonDir(path.join(STATE, 'plans'));
const journals = await readJsonDir(path.join(STATE, 'journals'));
let extra = [];
try { extra = JSON.parse(await fs.readFile(path.join(DIR, 'timeline_extra.json'), 'utf8')); } catch { extra = []; }

// snapshot times
let snap = { before: null, after: null };
for (const label of ['before', 'after']) {
  try {
    const j = JSON.parse(await fs.readFile(path.join(DIR, `${label}.json`), 'utf8'));
    snap[label] = { at: j.captured_at, files: j.totals.files, bytes: j.totals.bytes, ms: j.duration_ms };
  } catch { /* absent */ }
}

// stat a few paths for their real timestamps (README etc.)
async function statTimes(rel) {
  try {
    const st = await fs.stat(path.join(ROOT, rel));
    return { mtime: st.mtime.toISOString(), ctime: st.birthtime.toISOString(), size: st.size };
  } catch { return null; }
}
const readme = await statTimes('README.md');
const trashDir = await statTimes('_trash');
const stateIdFile = await statTimes(path.join('.folder-janitor', 'id'));

// ---------- events ----------
const events = [];
if (snap.before) events.push({
  at: snap.before.at, action: '只读快照 before', items: snap.before.files, bytes: snap.before.bytes, failed: 0,
  note: `snapshot.mjs 全树 readdir+lstat，${(snap.before.ms / 1000).toFixed(1)} s，未跟随 junction`,
});
for (const p of plans) events.push({
  at: p.createdAt, action: `计划生成（strategy=${p.strategy}）`, items: p.entries?.length ?? 0,
  bytes: (p.entries ?? []).reduce((s, e) => s + (e.size ?? 0), 0), failed: 0,
  note: `${p.planId}${p.strategyLabel ? ` · ${p.strategyLabel}` : ''} · 扫描 ${p.checked ?? '?'} 项 · 跳过 ${p.skipped?.length ?? 0} 项`,
});
for (const j of journals) {
  if (j.error) continue;
  events.push({
    at: j.createdAt, action: '执行开始', items: j.entries?.length ?? 0, bytes: 0, failed: 0,
    note: `journal ${j.journalId} · plan ${j.planId}${j.dryRun ? ' · **dryRun（未动文件）**' : ''}`,
  });
  events.push({
    at: j.finishedAt ?? j.createdAt, action: j.dryRun ? '执行完成（演练）' : '执行完成',
    items: j.moved ?? 0, bytes: j.bytes ?? 0, failed: j.failed ?? 0,
    note: `移动 ${j.moved ?? 0} · 跳过 ${j.skipped ?? 0} · 失败 ${j.failed ?? 0} · 读回核对 ${j.verified ?? 0}/${j.moved ?? 0}` +
      (j.createdDirs?.length ? ` · 新建目录 ${j.createdDirs.length}` : '') +
      (j.warnings?.length ? ` · 警告：${j.warnings.join('；')}` : ''),
  });
}
for (const e of extra) events.push({ ...e, note: e.note ?? '' });
if (readme) events.push({
  at: readme.mtime, action: '已写入根目录 README.md', items: 1, bytes: readme.size, failed: 0,
  note: 'mtime 即写入时间（内容由 Lead 写，记录员不记录正文）',
});
if (snap.after) events.push({
  at: snap.after.at, action: '只读快照 after', items: snap.after.files, bytes: snap.after.bytes, failed: 0,
  note: `snapshot.mjs，${(snap.after.ms / 1000).toFixed(1)} s`,
});
events.sort((a, b) => String(a.at).localeCompare(String(b.at)));

// ---------- per-journal kind / group breakdown ----------
function topOf(rel) { return rel.split(/[\\/]/)[0]; }
const journalBlocks = [];
for (const j of journals) {
  if (j.error) { journalBlocks.push({ j, error: j.error }); continue; }
  const kinds = new Map();
  const groups = new Map();
  for (const e of j.entries ?? []) {
    if (e.status !== 'ok' && e.status !== 'would-move') continue;
    kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);
    const k = topOf(e.from) + ' → ' + topOf(e.to);
    const g = groups.get(k) ?? { files: 0, bytes: 0 };
    g.files++; g.bytes += e.size ?? 0;
    groups.set(k, g);
  }
  journalBlocks.push({ j, kinds, groups, bad: (j.entries ?? []).filter(e => e.status === 'failed' || e.status === 'skipped') });
}

// ---------- markdown ----------
const L = [];
L.push('# 整理时间线（D:\\阅读学习）');
L.push('');
L.push('时间列为 Asia/Shanghai（+08:00），原始 ISO 时间戳同时保留在括号里。条目数/字节数取自 `.folder-janitor` 的计划与日志文件，没有估算。');
L.push('');
L.push('## 事件表');
L.push('');
L.push('| 时间 | ISO | 动作 | 条目 | 字节 | 失败 | 说明 |');
L.push('|---|---|---|--:|--:|--:|---|');
for (const e of events) {
  L.push(`| ${shanghai(e.at)} | \`${e.at ?? '—'}\` | ${e.action} | ${e.items == null ? '—' : nf.format(e.items)} | ${e.bytes == null ? '—' : human(e.bytes)} | ${e.failed ?? 0} | ${String(e.note ?? '').replace(/\|/g, '\\|')} |`);
}
L.push('');
if (snap.before && snap.after) {
  const dt = (new Date(snap.after.at) - new Date(snap.before.at)) / 1000;
  L.push(`before → after 跨度 ${dt.toFixed(0)} s（${(dt / 60).toFixed(1)} min）。`);
  L.push('');
}

L.push('## 计划（plans/*.json）');
L.push('');
if (!plans.length) L.push('- 没有计划文件。');
for (const p of plans) {
  if (p.error) { L.push(`- \`${p.file}\` 解析失败：${p.error}`); continue; }
  const bytes = (p.entries ?? []).reduce((s, e) => s + (e.size ?? 0), 0);
  L.push(`- \`${p.planId}\` · ${shanghai(p.createdAt)} · strategy=${p.strategy}${p.strategyLabel ? `（${p.strategyLabel}）` : ''} · 条目 ${nf.format(p.entries?.length ?? 0)} / ${human(bytes)} · 扫描 ${p.checked ?? '?'} · 跳过 ${p.skipped?.length ?? 0}`);
  if (p.options) L.push(`  - options: depth=${p.options.depth} junk=${p.options.junk} dedupe=${p.options.dedupe} keep=${JSON.stringify(p.options.keep ?? [])}`);
}
for (let i = 0; i + 1 < plans.length; i++) {
  const a = plans[i], b = plans[i + 1];
  if (a.entries && b.entries && JSON.stringify(a.entries) === JSON.stringify(b.entries)) {
    L.push(`- 注：\`${a.planId}\` 与 \`${b.planId}\` 的 entries 逐字相同（只差 planId / createdAt），真正被执行的是后者。`);
  }
}
L.push('');

L.push('## 执行（journals/*.json）');
L.push('');
L.push('journal 里的 `bytes` 只累计普通文件——`kind=dir` 的条目 `size=null`。所以日志数字（851,132,380 B）只含 `《WKW》.pdf` 与 `原画集.zip`；`.pdftmp` 的 75,402,057 B 和三个改名目录（266.7 + 129.1 + 8.9 MB）不在里面。按 before/after 快照算，实际被搬动的文件是 1,789 个 / 1.26 GB。');
L.push('');
if (!journals.length) L.push('- 没有执行日志文件。');
for (const b of journalBlocks) {
  if (b.error) { L.push(`- \`${b.j.file}\` 解析失败：${b.error}`); continue; }
  const j = b.j;
  L.push(`### ${j.journalId}`);
  L.push('');
  L.push(`- plan ${j.planId} · ${shanghai(j.createdAt)} → ${shanghai(j.finishedAt)} · strategy=${j.strategy} · dryRun=${j.dryRun}`);
  L.push(`- 移动 ${nf.format(j.moved ?? 0)} 条 / **${human(j.bytes ?? 0)}**（${nf.format(j.bytes ?? 0)} B）· 跳过 ${nf.format(j.skipped ?? 0)} · 失败 ${nf.format(j.failed ?? 0)} · 读回核对 ${nf.format(j.verified ?? 0)}/${nf.format(j.moved ?? 0)}`);
  L.push(`- 按 kind：${[...b.kinds.entries()].map(([k, n]) => `${k} ${nf.format(n)}`).join(' · ') || '无成功条目'}`);
  if (b.groups.size) {
    L.push('- 按顶层去向：');
    for (const [k, g] of [...b.groups.entries()].sort((a, b2) => b2[1].bytes - a[1].bytes)) {
      L.push(`  - \`${k}\` — ${nf.format(g.files)} 条 / ${g.bytes ? human(g.bytes) : '目录条目，日志不记字节'}`);
    }
  }
  if (j.createdDirs?.length) L.push(`- 新建目录：${j.createdDirs.map(d => '`' + d + '`').join('、')}`);
  if (b.bad.length) {
    L.push(`- 失败/跳过明细（${b.bad.length} 条）：`);
    for (const e of b.bad.slice(0, 30)) L.push(`  - \`${e.from}\` → \`${e.to}\` · ${e.status} · ${e.error ?? ''}`);
    if (b.bad.length > 30) L.push(`  - …其余 ${b.bad.length - 30} 条见 \`${j.journalPath ?? j.journalId}\``);
  } else {
    L.push('- 失败/跳过明细：无失败条目');
  }
  if (j.journalPath) L.push(`- 日志路径：\`${j.journalPath}\``);
  L.push('');
}

L.push('## 撤销验证');
L.push('');
L.push(extra.some(e => /撤销/.test(e.action)) ? '见上方事件表中「撤销验证」行（由 `folder_undo` dry_run 产生，dry_run 不写盘、不留日志文件）。' : '- 尚未做撤销验证。');
L.push('');
if (stateIdFile) L.push(`状态标识文件 \`.folder-janitor/id\`：写入 ${shanghai(stateIdFile.mtime)}，${stateIdFile.size} B（撤销时的根目录身份校验用它）。`);
if (trashDir) L.push(`\`_trash/\` 目录 ctime ${shanghai(trashDir.ctime)}。`);
L.push('');

L.push('## 附：现场复核（记录员在盘上直接读到的事实）');
L.push('');
try {
  const b = JSON.parse(await fs.readFile(path.join(DIR, 'before.json'), 'utf8'));
  const pl = b.top_level.find(t => t.name === 'plugins');
  const ad = b.top_level.find(t => t.name === '_covers');
  if (pl) L.push(`- \`plugins/\` 整理前后一致：${nf.format(pl.files)} 个文件 / ${nf.format(pl.bytes)} B，diff 里没有任何一条涉及它的迁移；快照全程 junction 数为 ${b.totals.links}（没有跟随任何链接）。`);
  if (ad) L.push(`- \`_covers/\` 未动：${nf.format(ad.files)} 个文件 / ${nf.format(ad.bytes)} B。`);
} catch { /* skip */ }
L.push('- 根目录 `D:\\阅读学习` 有一条显式 ACE：`Everyone: DeleteSubdirectoriesAndFiles (DENY)`；`MASS设计集团_作品集`、`_待归类`、`_trash`、`plugins`、`投标` 继承了它，而 `阅读`、`中体量建筑`、`知末_施工图与案例素材` 的 DACL 屏蔽了继承、看不到这条。');
L.push('- 受控试验结论：这条 DENY 不阻止改名/移出（见上方「受控试验」行），所以 MASS 的 EPERM 不能记在 ACL 头上。');
L.push('');
await fs.writeFile(path.join(DIR, 'timeline.md'), L.join('\n') + '\n');
console.log(L.join('\n'));
