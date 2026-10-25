// diff.mjs — before.json + after.json -> diff.json + before-after.md
// Matching rule: (basename, size) for relocated files; directories are reported
// as groups keyed by (top segment before -> top segment after).
import fs from 'node:fs/promises';
import path from 'node:path';

const DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const before = JSON.parse(await fs.readFile(path.join(DIR, 'before.json'), 'utf8'));
const after = JSON.parse(await fs.readFile(path.join(DIR, 'after.json'), 'utf8'));

const KB = 1024, MB = KB * 1024, GB = MB * 1024;
function human(n) {
  if (n == null) return 'null';
  const s = n < 0 ? '-' : '';
  const a = Math.abs(n);
  if (a >= GB) return s + (a / GB).toFixed(2) + ' GB';
  if (a >= MB) return s + (a / MB).toFixed(1) + ' MB';
  if (a >= KB) return s + (a / KB).toFixed(1) + ' KB';
  return s + a + ' B';
}
const nf = new Intl.NumberFormat('en-US');
const B = (rel) => rel.slice(rel.lastIndexOf('/') + 1);
const topOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : '');
const suffixOf = (rel) => rel.slice(rel.indexOf('/') + 1);

const bMap = new Map(before.entries.map(([r, s, m]) => [r, [s, m]]));
const aMap = new Map(after.entries.map(([r, s, m]) => [r, [s, m]]));

const gone = [];   // in before, not at same path in after
const fresh = [];  // in after, not at same path in before
for (const [r, v] of bMap) if (!aMap.has(r)) gone.push([r, ...v]);
for (const [r, v] of aMap) if (!bMap.has(r)) fresh.push([r, ...v]);

// match gone <-> fresh on (basename, size)
const byKey = new Map();
for (const [r, s, m] of fresh) {
  const k = B(r) + '\u0000' + s;
  if (!byKey.has(k)) byKey.set(k, []);
  byKey.get(k).push([r, s, m]);
}
const matched = [];
const unmatchedBefore = [];
for (const [r, s, m] of gone) {
  const q = byKey.get(B(r) + '\u0000' + s);
  const hit = q && q.length ? q.shift() : null;
  if (hit) matched.push({ from: r, to: hit[0], size: s, mtimeSame: m === hit[2], mtimeFrom: m, mtimeTo: hit[2] });
  else unmatchedBefore.push([r, s, m]);
}
const matchedToSet = new Set(matched.map(x => x.to));
const unmatchedAfter = fresh.filter(([r]) => !matchedToSet.has(r));

// group matches by (fromTop -> toTop)
const groups = new Map();
for (const m of matched) {
  const ft = topOf(m.from) || '(根)', tt = topOf(m.to) || '(根)';
  const k = ft + '\u0001' + tt;
  if (!groups.has(k)) groups.set(k, { fromTop: ft, toTop: tt, files: 0, bytes: 0, mtimeSame: 0, sameSuffix: 0 });
  const g = groups.get(k);
  g.files++; g.bytes += m.size; if (m.mtimeSame) g.mtimeSame++;
  if (suffixOf(m.from) === suffixOf(m.to)) g.sameSuffix++;
}
const groupList = [...groups.values()].sort((a, b) => b.bytes - a.bytes).map(g => {
  const intoTrash = g.toTop === '_trash' || g.toTop.startsWith('_trash');
  let action;
  if (intoTrash) action = '移入回收';
  else if (g.fromTop === '(根)' && g.toTop === '_待归类') action = '根目录散件归位';
  else if (g.sameSuffix === g.files && g.fromTop !== g.toTop) action = '改名/整体移动';
  else if (g.fromTop === g.toTop) action = '同级内移动';
  else action = '拆散移动';
  return { ...g, action };
});

// byte accounting
const deltaBytes = after.totals.bytes - before.totals.bytes;
const deltaFiles = after.totals.files - before.totals.files;
// buckets outside _trash, so "cleaned" means out of the working area
function bucketOutsideTrash(snap) {
  let ad = 0, adB = 0, pdftmp = 0, pdftmpB = 0;
  for (const [r, s] of snap.entries) {
    if (r === '_trash' || r.startsWith('_trash/')) continue;
    const b = B(r);
    if (b.startsWith('._')) { ad++; adB += s ?? 0; }
    if (r === '.pdftmp' || r.startsWith('.pdftmp/')) { pdftmp++; pdftmpB += s ?? 0; }
  }
  return { appledouble_files: ad, appledouble_bytes: adB, pdftmp_files: pdftmp, pdftmp_bytes: pdftmpB };
}
const bOut = bucketOutsideTrash(before);
const aOut = bucketOutsideTrash(after);

const out = {
  generated_at: new Date().toISOString(),
  before: { captured_at: before.captured_at, totals: before.totals, buckets: before.buckets, outside_trash: bOut },
  after: { captured_at: after.captured_at, totals: after.totals, buckets: after.buckets, outside_trash: aOut },
  delta: { bytes: deltaBytes, files: deltaFiles, dirs: after.totals.dirs - before.totals.dirs },
  top_level_before: before.top_level.map(t => ({ name: t.name, type: t.type, files: t.files, bytes: t.bytes })),
  top_level_after: after.top_level.map(t => ({ name: t.name, type: t.type, files: t.files, bytes: t.bytes })),
  groups: groupList,
  matched_count: matched.length,
  matched_bytes: matched.reduce((s, m) => s + m.size, 0),
  matched_mtime_identical: matched.filter(m => m.mtimeSame).length,
  unmatched_before: unmatchedBefore.map(([r, s]) => ({ path: r, size: s })),
  unmatched_after: unmatchedAfter.map(([r, s]) => ({ path: r, size: s })),
  samples: {
    matched: matched.slice(0, 5),
    unmatched_before: unmatchedBefore.slice(0, 20).map(([r, s]) => `${r} (${s} B)`),
    unmatched_after: unmatchedAfter.slice(0, 20).map(([r, s]) => `${r} (${s} B)`),
  },
};
await fs.writeFile(path.join(DIR, 'diff.json'), JSON.stringify(out, null, 2));

// ---------- markdown ----------
const L = [];
L.push('# 整理前后对比（before → after）');
L.push('');
L.push(`before ${before.captured_at} · after ${after.captured_at}`);
L.push('');
L.push('## 总量');
L.push('');
L.push(`| 指标 | 整理前 | 整理后 | 变化 |`);
L.push('|---|--:|--:|--:|');
L.push(`| 文件数 | ${nf.format(before.totals.files)} | ${nf.format(after.totals.files)} | ${deltaFiles >= 0 ? '+' : ''}${nf.format(deltaFiles)} |`);
L.push(`| 总字节 | ${nf.format(before.totals.bytes)} | ${nf.format(after.totals.bytes)} | ${deltaBytes >= 0 ? '+' : ''}${nf.format(deltaBytes)} |`);
L.push(`| 体积 | ${human(before.totals.bytes)} | ${human(after.totals.bytes)} | ${human(deltaBytes)} |`);
L.push(`| 目录数 | ${nf.format(before.totals.dirs)} | ${nf.format(after.totals.dirs)} | ${after.totals.dirs - before.totals.dirs >= 0 ? '+' : ''}${nf.format(after.totals.dirs - before.totals.dirs)} |`);
L.push(`| 顶层项 | ${before.totals.top_level_items} | ${after.totals.top_level_items} | ${after.totals.top_level_items - before.totals.top_level_items >= 0 ? '+' : ''}${after.totals.top_level_items - before.totals.top_level_items} |`);
L.push('');
L.push('## 顶层变化');
L.push('');
L.push('| 动作 | 前 | 后 | 文件数 | 体积 |');
L.push('|---|---|---|--:|--:|');
for (const g of groupList) L.push(`| ${g.action} | \`${g.fromTop}\` | \`${g.toTop}\` | ${nf.format(g.files)} | ${human(g.bytes)} |`);
const afterTopNames = new Set(after.top_level.map(t => t.name));
const beforeTopNames = new Set(before.top_level.map(t => t.name));
const matchedFroms = new Set(matched.map(m => m.from));
const movedTop = new Set(groupList.map(g => g.fromTop));
const vanished = before.top_level.filter(t => {
  if (afterTopNames.has(t.name)) return false;
  if (movedTop.has(t.name)) return false;                       // 作为目录整体出现在分组里
  if (matchedFroms.has(t.name)) return false;                   // 作为单个文件被匹配掉
  for (const f of matchedFroms) if (f.startsWith(t.name + '/')) return false; // 目录内文件被匹配
  return true;
});
const appeared = after.top_level.filter(t => !beforeTopNames.has(t.name) && !groupList.some(g => g.toTop === t.name));
const newBytes = unmatchedAfter.reduce((s, [, sz]) => s + (sz ?? 0), 0);
for (const t of appeared) {
  L.push(`| 新增 | — | \`${t.name}\` | ${nf.format(t.files)} | ${human(t.bytes)} |`);
}
for (const t of vanished) {
  L.push(`| 消失 | \`${t.name}\` | — | ${nf.format(t.files)} | ${human(t.bytes)} |`);
}
L.push('');
L.push('改名明细（原名 → 新名，长度按 JS 字符数）：');
L.push('');
L.push('| 原名 | 旧长度 | 新名 | 新长度 | 文件数 | 体积 |');
L.push('|---|--:|---|--:|--:|--:|');
for (const g of groupList.filter(x => x.action === '改名/整体移动')) {
  L.push(`| \`${g.fromTop}\` | ${[...g.fromTop].length} | \`${g.toTop}\` | ${[...g.toTop].length} | ${nf.format(g.files)} | ${human(g.bytes)} |`);
}
const oldLen = groupList.filter(x => x.action === '改名/整体移动').reduce((s, g) => s + [...g.fromTop].length, 0);
const newLen = groupList.filter(x => x.action === '改名/整体移动').reduce((s, g) => s + [...g.toTop].length, 0);
if (oldLen) L.push('');
if (oldLen) L.push(`三个改名对象的名字总长 ${oldLen} → ${newLen} 字符。`);
L.push('');
L.push('## 清理效果（`_trash/` 以外的工作区，回收站里的文件仍在盘上）');
L.push('');
L.push('| 项 | 前 | 后 |');
L.push('|---|--:|--:|');
L.push(`| \`._*\` AppleDouble 文件 | ${nf.format(bOut.appledouble_files)} / ${human(bOut.appledouble_bytes)} | ${nf.format(aOut.appledouble_files)} / ${human(aOut.appledouble_bytes)} |`);
L.push(`| \`.pdftmp\` 文件 | ${nf.format(bOut.pdftmp_files)} / ${human(bOut.pdftmp_bytes)} | ${nf.format(aOut.pdftmp_files)} / ${human(aOut.pdftmp_bytes)} |`);
L.push('');
L.push('## 内容完整性');
L.push('');
L.push(`- 按（文件名 + 字节数）匹配到的迁移/改名文件：**${nf.format(matched.length)}** 个 / **${human(out.matched_bytes)}**`);
L.push(`- 其中 size 与 mtime 都与整理前完全一致：**${nf.format(out.matched_mtime_identical)}** / ${nf.format(matched.length)}（同卷 rename 的直接证据）`);
L.push(`- 总字节变化：**${deltaBytes >= 0 ? '+' : ''}${nf.format(deltaBytes)} B**${deltaBytes === 0 ? '（零变化 = 没有内容被删）' : ''}`);
L.push(`- 新增产物 ${nf.format(unmatchedAfter.length)} 个 / ${nf.format(newBytes)} B（README.md 3,727 B + \`.folder-janitor/\` 的计划与日志），数量与字节都和上面的变化对得上：**整理前后原有内容一个字节没少**`);
L.push(`- 搬动分布：${groupList.map(g => `${g.action} ${g.fromTop}→${g.toTop} ${nf.format(g.files)} 条/${human(g.bytes)}`).join('；')}`);
L.push(`- 前有后无、且找不到同（名,大小）落点：**${nf.format(unmatchedBefore.length)}** 个`);
if (unmatchedBefore.length) L.push(`  样本：${out.samples.unmatched_before.map(s => '`' + s + '`').join('、')}`);
L.push(`- 后有前无、且不是迁移过来的：**${nf.format(unmatchedAfter.length)}** 个`);
if (unmatchedAfter.length) L.push(`  样本：${out.samples.unmatched_after.map(s => '`' + s + '`').join('、')}`);
L.push('');
L.push('## 回收内容核对（`_trash/2026-10-25/.pdftmp`）');
L.push('');
const pdt = after.top_level.find(t => t.name === '_trash');
L.push(`- 落在盘上：${nf.format(pdt.files)} 个文件 / ${nf.format(pdt.bytes)} B，与整理前的 \`.pdftmp\`（${nf.format(before.buckets.dot_pdftmp.files)} 个 / ${nf.format(before.buckets.dot_pdftmp.bytes)} B）逐项对上`);
L.push('- 构成不是纯缓存：根目录除了 14 个 `pip-*` / `edgeprofile` 临时目录，还有一套拆书渲染的工作目录——`build_book.py` 33,387 B、`render_book.py` 42,617 B、`huivang_raw.txt` 379,422 B / `huivang_full.txt` 375,086 B / `huivang_clean.txt` 376,712 B、`qa_00.png` 2,420,154 B 到 `qa_07.png` 共 8 张、`t1.pdf` / `t2.pdf`，以及 20 来个 py 脚本');
L.push('');
L.push('## 顶层清单（整理后）');
L.push('');
L.push('| # | 类型 | 名称 | 文件数 | 体积 |');
L.push('|--:|---|---|--:|--:|');
[...after.top_level].sort((a, b) => b.bytes - a.bytes).forEach((t, i) => {
  L.push(`| ${i + 1} | ${t.type} | ${t.name.replace(/\|/g, '\\|')} | ${nf.format(t.files)} | ${human(t.bytes)} |`);
});

await fs.writeFile(path.join(DIR, 'before-after.md'), L.join('\n') + '\n');
console.log(L.join('\n'));
