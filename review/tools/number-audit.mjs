// 数字对账：record/ 与 README.md 里每个数字回盘上复算。只读。
// 用法: node number-audit.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REVIEW = path.resolve(HERE, '..');
const WS = path.resolve(REVIEW, '../..');
const ROOT = 'D:\\阅读学习';
const out = { generatedAt: new Date().toISOString(), checks: [] };
const add = (name, verdict, detail) => {
  out.checks.push({ name, verdict, detail });
  console.log(`${verdict.padEnd(5)} ${name} :: ${JSON.stringify(detail)}`);
};

const baseline = JSON.parse(fs.readFileSync(path.join(REVIEW, 'baseline.json'), 'utf8'));
const lead = JSON.parse(fs.readFileSync(path.join(WS, 'reading-tidy/record/before.json'), 'utf8'));

// ---------- 0. 两套 walker 互校（Lead 的 before.json vs 我的 baseline.json）
const mine = new Map(baseline.entries.filter((e) => e.t === 'f').map((e) => [e.p, e.s]));
const theirs = new Map(lead.entries.map(([p, s]) => [p, s]));
const onlyMine = [...mine.keys()].filter((p) => !theirs.has(p));
const onlyTheirs = [...theirs.keys()].filter((p) => !mine.has(p));
const sizeDiff = [...mine.entries()].filter(([p, s]) => theirs.has(p) && theirs.get(p) !== s);
add('record/before.json 与我的独立基线逐文件一致', onlyMine.length === 0 && onlyTheirs.length === 0 && sizeDiff.length === 0 && lead.totals.files === baseline.summary.files && lead.totals.bytes === baseline.summary.bytes ? 'PASS' : 'FAIL', {
  leadTotals: lead.totals, mineTotals: baseline.summary, onlyMine: onlyMine.slice(0, 5), onlyTheirs: onlyTheirs.slice(0, 5), sizeDiff: sizeDiff.slice(0, 5),
});

// ---------- 1. 搬后每棵树的实际数字
function tree(abs) {
  let files = 0, bytes = 0;
  (function walk(a) {
    for (const d of fs.readdirSync(a, { withFileTypes: true })) {
      const p = path.join(a, d.name);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(p);
      else { files += 1; bytes += st.size; }
    }
  })(abs);
  return { files, bytes };
}
const topNow = {};
for (const d of fs.readdirSync(ROOT, { withFileTypes: true })) {
  const p = path.join(ROOT, d.name);
  if (d.isDirectory()) topNow[d.name] = tree(p);
  else topNow[d.name] = { files: 1, bytes: fs.lstatSync(p).size };
}
const beforeTop = Object.fromEntries(baseline.topLevel.map((t) => [t.name, { files: t.treeFiles, bytes: t.treeBytes }]));

// ---------- 2. before.md 的表
const beforeMd = fs.readFileSync(path.join(WS, 'reading-tidy/record/before.md'), 'utf8');
const bRows = [...beforeMd.matchAll(/^\|\s*\d+\s*\|\s*(目录|文件)\s*\|\s*(.+?)\s*\|\s*([\d,]+)\s*\|\s*([\d.]+)\s*(KB|MB|GB)\s*\|$/gm)]
  .map((m) => ({ name: m[2] === '《WKW》.pdf' || m[2] === '原画集.zip' ? m[2] : m[2], files: Number(m[3].replace(/,/g, '')), size: Number(m[4]), unit: m[5] }));
const bBad = [];
for (const r of bRows) {
  const b = beforeTop[r.name];
  if (!b) { bBad.push({ name: r.name, why: '基线里没这棵树' }); continue; }
  const gib = b.bytes / 1024 ** 3;
  const mib = b.bytes / 1024 ** 2;
  const want = r.unit === 'GB' ? { v: gib, tol: 0.006 } : r.unit === 'MB' ? { v: mib, tol: 0.06 } : { v: b.bytes / 1024, tol: 0.06 };
  const ok = r.files === b.files && Math.abs(want.v - r.size) <= want.tol;
  if (!ok) bBad.push({ name: r.name, statedFiles: r.files, actualFiles: b.files, stated: `${r.size} ${r.unit}`, actualGiB: +gib.toFixed(2) });
}
add('record/before.md 的 19 行逐行复算（文件数 + GiB）', bRows.length === 19 && bBad.length === 0 ? 'PASS' : 'FAIL', { rows: bRows.length, bad: bBad });

// ---------- 3. README.md 的表：两种 GB 公式都算一遍
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const rRows = [...readme.matchAll(/^\|\s*`([^`]+)`\s*\|\s*([\d,]+)\s*文件\s*\/\s*([\d.]+)\s*(KB|MB|GB)\s*\|/gm)]
  .map((m) => ({ name: m[1], files: Number(m[2].replace(/,/g, '')), size: Number(m[3]), unit: m[4] }));
const rows = [];
for (const r of rRows) {
  const b = topNow[r.name];
  if (!b) { rows.push({ name: r.name, why: '盘上没有这棵树' }); continue; }
  const gib = b.bytes / 1024 ** 3;
  const mib = b.bytes / 1024 ** 2;
  // 公式 A：正确的 GiB / MiB。公式 B：bytes / (1024^2 * 1000)（把 1000 MB 当 1 GB）
  const formulaB = b.bytes / (1024 ** 2 * 1000);
  rows.push({
    name: r.name, statedFiles: r.files, actualFiles: b.files,
    stated: `${r.size} ${r.unit}`, actualGiB: +gib.toFixed(2), actualMiB: +mib.toFixed(1),
    matchA: r.unit === 'GB' ? Math.abs(gib - r.size) <= 0.02 : r.unit === 'MB' ? Math.abs(mib - r.size) <= 0.2 : Math.abs(b.bytes / 1024 - r.size) <= 0.2,
    matchB: r.unit === 'GB' ? Math.abs(formulaB - r.size) <= 0.02 : null,
    fileCountOk: r.files === b.files,
  });
}
const gbRows = rows.filter((r) => r.stated && r.stated.endsWith('GB'));
const wrongA = gbRows.filter((r) => !r.matchA);
const fitB = gbRows.filter((r) => r.matchB);
add('README.md 的 GB 列复算', wrongA.length === 0 ? 'PASS' : 'FAIL', {
  gbRows: gbRows.length, wrongAgainstGiB: wrongA.map((r) => `${r.name}: 写 ${r.stated} / 实际 ${r.actualGiB} GiB`),
  explainsByFormulaB: `${fitB.length}/${gbRows.length} 行符合 bytes/1024^2/1000（1000 MiB 当 1 GB）`,
  allRows: rows,
});
add('README.md 的文件数列复算', rows.every((r) => r.fileCountOk) ? 'PASS' : 'FAIL', { bad: rows.filter((r) => !r.fileCountOk) });

// ---------- 4. README 的正文断言
const nowTop = fs.readdirSync(ROOT, { withFileTypes: true });
const nowFiles = (function count() { let n = 0; (function w(a) { for (const d of fs.readdirSync(a, { withFileTypes: true })) { const p = path.join(a, d.name); const st = fs.lstatSync(p); if (st.isSymbolicLink()) continue; if (st.isDirectory()) w(p); else n += 1; } })(ROOT); return n; })();
const claims = {
  '19 个顶层项（README 正文）': { stated: 19, actual: nowTop.length, note: '现在含 README.md 与 .folder-janitor；排除 .folder-janitor 是 19，排除 README 与 .folder-janitor 是 18' },
  '53,481 个文件（README 正文）': { stated: 53481, actual: nowFiles, note: '这是搬前数字；盘上现在多了 README + 10 个状态文件' },
  '只动 6 处 / 其余 13 个不动': { stated: 6, actual: 6, note: '基线里 1789 个文件发生前缀位移，恰好落在这 6 个顶层项里' },
  '_待归类 2 个文件': { stated: 2, actual: topNow['_待归类']?.files, note: '' },
  '_trash 503 个文件': { stated: 503, actual: topNow['_trash']?.files, note: '' },
};
add('README 正文的关键断言复算', claims['_待归类 2 个文件'].actual === 2 && claims['_trash 503 个文件'].actual === 503 ? 'PASS' : 'FAIL', claims);

// ---------- 5. 数字口径：GiB 还是 GB
add('「38.63 GB」的口径', Math.abs(41478292322 / 1024 ** 3 - 38.63) < 0.01 ? 'PASS' : 'FAIL', {
  bytes: 41478292322, GiB: +(41478292322 / 1024 ** 3).toFixed(3), GB_decimal: +(41478292322 / 1e9).toFixed(2),
  verdict: '38.63 是 GiB（41.48 GB 十进制），README 里同时出现 GB 字样与 GiB 数值',
});

// ---------- 6. .pdftmp 的真实成分（README 说是 pip 缓存 + Edge 临时 profile）
const pd = path.join(ROOT, '_trash', '2026-10-25', '.pdftmp');
const pdTop = fs.readdirSync(pd, { withFileTypes: true }).map((d) => (d.isDirectory() ? d.name + '/' : d.name)).sort();
const ext = {};
let zero = 0;
(function w(a) { for (const d of fs.readdirSync(a, { withFileTypes: true })) { const p = path.join(a, d.name); const st = fs.lstatSync(p); if (st.isDirectory()) w(p); else { const e = path.extname(d.name).toLowerCase() || '(none)'; ext[e] = (ext[e] ?? 0) + 1; if (st.size === 0) zero += 1; } } })(pd);
add('.pdftmp 成分（README 称 pip 缓存 + Edge 临时 profile）', 'INFO', {
  topEntries: pdTop.slice(0, 25), topEntryCount: pdTop.length, zeroByte: zero,
  topExt: Object.entries(ext).sort((a, b) => b[1] - a[1]).slice(0, 10),
});

fs.writeFileSync(path.join(REVIEW, 'number-audit.json'), JSON.stringify(out, null, 2));
console.log(`\nPASS=${out.checks.filter((c) => c.verdict === 'PASS').length} FAIL=${out.checks.filter((c) => c.verdict === 'FAIL').length} INFO=${out.checks.filter((c) => c.verdict === 'INFO').length}`);
