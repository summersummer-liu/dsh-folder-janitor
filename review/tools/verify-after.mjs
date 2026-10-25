// 第三段总对账：搬前基线 vs 搬后真实盘。只读 D:\阅读学习。
// 用法: node verify-after.mjs
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REVIEW = path.resolve(HERE, '..');
const ROOT = 'D:\\阅读学习';
const PLUGIN = path.resolve(REVIEW, '../../folder-janitor');

const { undoJournal } = await import('file:///' + path.join(PLUGIN, 'lib/apply.js').replace(/\\/g, '/'));
const { loadJournalByPath } = await import('file:///' + path.join(PLUGIN, 'lib/store.js').replace(/\\/g, '/'));

const baseline = JSON.parse(fs.readFileSync(path.join(REVIEW, 'baseline.json'), 'utf8'));
const beforeHashes = JSON.parse(fs.readFileSync(path.join(REVIEW, 'baseline-hashes.json'), 'utf8'));
const report = { generatedAt: new Date().toISOString(), checks: [], evidence: {} };

function add(name, verdict, detail) {
  report.checks.push({ name, verdict, detail });
  console.log(`${verdict.padEnd(5)} ${name} :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
}

function sha256(abs) {
  return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

function walk(abs, rel = '') {
  const out = [];
  for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
    const r = rel ? rel + '/' + d.name : d.name;
    const a = path.join(abs, d.name);
    const st = fs.lstatSync(a);
    if (st.isSymbolicLink()) { out.push({ rel: r, t: 'link', target: fs.readlinkSync(a), mtimeMs: st.mtimeMs }); continue; }
    if (st.isDirectory()) { out.push({ rel: r, t: 'd', mtimeMs: st.mtimeMs }); out.push(...walk(a, r)); }
    else out.push({ rel: r, t: 'f', size: st.size, mtimeMs: st.mtimeMs });
  }
  return out;
}

const now = walk(ROOT);
const nowFiles = new Map(now.filter((e) => e.t === 'f').map((e) => [e.rel, e]));
const nowDirs = new Map(now.filter((e) => e.t === 'd').map((e) => [e.rel, e]));
const nowLinks = now.filter((e) => e.t === 'link');

// ---------------------------------------------------------------- 1. 路径映射
const MAP = [
  { from: '.pdftmp', to: '_trash/2026-10-25/.pdftmp' },
  { from: '《WKW》.pdf', to: '_待归类/《WKW》.pdf' },
  { from: '原画集.zip', to: '_待归类/原画集.zip' },
  { from: 'attachment_17434050909562708', to: '知末_施工图与案例素材' },
  { from: '中体量建筑_副本', to: '中体量建筑' },
  { from: '26-1015【建筑设计事务所】MASS设计集团 MASS Design Group作品集', to: 'MASS设计集团_作品集' },
];
function mapRel(rel) {
  for (const m of MAP) {
    if (rel === m.from) return m.to;
    if (rel.startsWith(m.from + '/')) return m.to + rel.slice(m.from.length);
  }
  return rel;
}

const blFiles = baseline.entries.filter((e) => e.t === 'f');
const blDirs = baseline.entries.filter((e) => e.t === 'd');
const missing = [];
const sizeMismatch = [];
let movedCount = 0;
for (const e of blFiles) {
  const want = mapRel(e.p);
  const hit = nowFiles.get(want);
  if (!hit) { missing.push({ from: e.p, want, reason: '搬后位置找不到' }); continue; }
  if (hit.size !== e.s) { sizeMismatch.push({ from: e.p, want, before: e.s, after: hit.size }); continue; }
  if (want !== e.p) movedCount += 1;
}
const missingDirs = [];
for (const e of blDirs) {
  const want = mapRel(e.p);
  if (!nowDirs.has(want)) missingDirs.push({ from: e.p, want });
}
add('全部搬前文件在映射后位置可按大小对上', missing.length === 0 && sizeMismatch.length === 0 ? 'PASS' : 'FAIL', {
  baselineFiles: blFiles.length, movedFiles: movedCount, missingCount: missing.length, sizeMismatchCount: sizeMismatch.length,
  missing: missing.slice(0, 10), sizeMismatch: sizeMismatch.slice(0, 10),
});
add('全部搬前目录在映射后位置还在', missingDirs.length === 0 ? 'PASS' : 'FAIL', { baselineDirs: blDirs.length, missingDirs: missingDirs.slice(0, 10) });

// 旧位置必须已经不在
const staleOld = [];
for (const m of MAP) {
  const abs = path.join(ROOT, m.from);
  if (fs.existsSync(abs)) staleOld.push(m.from);
}
add('旧位置已清空（不留副本）', staleOld.length === 0 ? 'PASS' : 'FAIL', { stale: staleOld });

// 反向：盘上多出来的文件只允许是 README + .folder-janitor
const expectedNew = new Set(['README.md']);
for (const e of nowFiles.keys()) {
  if (e.startsWith('.folder-janitor/')) expectedNew.add(e);
}
const blSet = new Set(blFiles.map((e) => mapRel(e.p)));
const unexpected = [...nowFiles.keys()].filter((r) => !blSet.has(r) && !expectedNew.has(r));
add('没有计划外的新文件', unexpected.length === 0 ? 'PASS' : 'FAIL', { unexpected: unexpected.slice(0, 20) });

// 现盘总数增减必须被 README + 状态文件解释掉
const stateFiles = [...nowFiles.keys()].filter((r) => r.startsWith('.folder-janitor/'));
const addBytes = (expectedNew.size > 0 ? (nowFiles.get('README.md')?.size ?? 0) : 0) + stateFiles.reduce((s, r) => s + nowFiles.get(r).size, 0);
const expectFiles = blFiles.length + expectedNew.size;
const expectBytes = blFiles.reduce((s, e) => s + e.s, 0) + addBytes;
const nowBytes = [...nowFiles.values()].reduce((s, e) => s + e.size, 0);
add('文件数/总体积与「基线 + README + 状态文件」一致', nowFiles.size === expectFiles && nowBytes === expectBytes ? 'PASS' : 'FAIL', {
  baselineFiles: blFiles.length, nowFiles: nowFiles.size, expected: expectFiles,
  baselineBytes: blFiles.reduce((s, e) => s + e.s, 0), nowBytes, expectedBytes: expectBytes,
  deltaFiles: nowFiles.size - expectFiles, deltaBytes: nowBytes - expectBytes,
});
add('root 内 junction/符号链接数量', nowLinks.length === 0 ? 'PASS' : 'INFO', { count: nowLinks.length, links: nowLinks.map((l) => l.rel) });

// ---------------------------------------------------------------- 2. 哈希
const hashBad = [];
const mtimeBad = [];
for (const [rel, rec] of Object.entries(beforeHashes.files)) {
  const want = mapRel(rel);
  const abs = path.join(ROOT, want);
  if (!fs.existsSync(abs)) { hashBad.push({ rel, want, why: '不存在' }); continue; }
  const st = fs.statSync(abs);
  if (st.size !== rec.size) { hashBad.push({ rel, want, why: '大小变了', before: rec.size, after: st.size }); continue; }
  const h = sha256(abs);
  if (h !== rec.sha256) hashBad.push({ rel, want, why: '哈希变了', before: rec.sha256.slice(0, 16), after: h.slice(0, 16) });
  // rename 应保留 mtime；搬后文件 mtime 与搬前一致
  if (Math.abs(st.mtimeMs - rec.mtimeMs) > 2) mtimeBad.push({ rel, want, before: rec.mtimeMs, after: st.mtimeMs });
}
add('800 个冻结文件搬后 SHA-256 全部一致', hashBad.length === 0 ? 'PASS' : 'FAIL', {
  hashed: Object.keys(beforeHashes.files).length, bytes: beforeHashes.totalBytes, bad: hashBad.slice(0, 10), badCount: hashBad.length,
});
add('搬后 mtime 未变（rename 语义）', mtimeBad.length === 0 ? 'PASS' : 'FAIL', { badCount: mtimeBad.length, bad: mtimeBad.slice(0, 5) });

// 全树 mtime 复核：53,481 个文件一个都没被动过的直接证据（内容改动必然改 mtime）
const mtimeAllBad = [];
for (const e of blFiles) {
  const hit = nowFiles.get(mapRel(e.p));
  if (hit && Math.abs(hit.mtimeMs - e.m) > 2) mtimeAllBad.push({ from: e.p, want: mapRel(e.p), before: e.m, after: hit.mtimeMs });
}
add('全部 53,481 个文件 mtime 与搬前快照一致', mtimeAllBad.length === 0 ? 'PASS' : 'FAIL', { badCount: mtimeAllBad.length, bad: mtimeAllBad.slice(0, 5) });

// ---------------------------------------------------------------- 3. 分块点名
const pdftmpHashes = Object.keys(beforeHashes.files).filter((r) => r.startsWith('.pdftmp/'));
const pdftmpNow = nowFiles.get('_trash/2026-10-25/.pdftmp');
add('.pdftmp 503 个文件全在 _trash/2026-10-25/.pdftmp',
  fs.existsSync('D:\\阅读学习\\_trash\\2026-10-25\\.pdftmp') && pdftmpHashes.length === 503 &&
  pdftmpHashes.every((r) => nowFiles.has('_trash/2026-10-25/.pdftmp/' + r.slice('.pdftmp/'.length))) ? 'PASS' : 'FAIL',
  { beforeCount: pdftmpHashes.length, destExists: fs.existsSync('D:\\阅读学习\\_trash\\2026-10-25\\.pdftmp') });

const bigTwo = ['《WKW》.pdf', '原画集.zip'].map((rel) => {
  const rec = beforeHashes.files[rel];
  const want = '_待归类/' + rel;
  const abs = path.join(ROOT, want);
  return { rel, want, exists: fs.existsSync(abs), sizeBefore: rec.size, sizeAfter: fs.existsSync(abs) ? fs.statSync(abs).size : null, hashMatch: fs.existsSync(abs) && sha256(abs) === rec.sha256 };
});
add('两个 800MB 级散件在 _待归类 且哈希不变', bigTwo.every((x) => x.exists && x.hashMatch) ? 'PASS' : 'FAIL', bigTwo);

// plugins 一字未动
const pluginRecs = Object.entries(beforeHashes.files).filter(([r]) => r.startsWith('plugins/'));
const pluginBad = pluginRecs.filter(([rel, rec]) => {
  const abs = path.join(ROOT, rel);
  return !fs.existsSync(abs) || fs.statSync(abs).size !== rec.size || sha256(abs) !== rec.sha256;
});
const pluginsTree = now.filter((e) => e.rel === 'plugins' || e.rel.startsWith('plugins/'));
const pluginFiles = pluginsTree.filter((e) => e.t === 'f');
const profileLink = 'C:\\Users\\summer\\.dsh\\profiles\\desktop\\node_modules\\dsh-humanizer';
const profilePkg = path.join(profileLink, 'package.json');
let junction = { exists: false };
try {
  const st = fs.lstatSync(profileLink);
  junction = { exists: true, isLink: st.isSymbolicLink(), target: fs.readlinkSync(profileLink), pkgReadable: fs.existsSync(profilePkg) };
  if (junction.pkgReadable) junction.pkgSha = sha256(profilePkg).slice(0, 16);
} catch (e) { junction = { exists: false, error: e.code }; }
add('plugins/ 文件哈希全部不变', pluginBad.length === 0 ? 'PASS' : 'FAIL', { hashedBefore: pluginRecs.length, filesNow: pluginFiles.length, bytesNow: pluginFiles.reduce((s, e) => s + e.size, 0), bad: pluginBad.map(([r]) => r) });
add('profile junction 仍指向 plugins/dsh-humanizer 且 package.json 可读', junction.isLink && junction.pkgReadable && junction.target === 'D:\\阅读学习\\plugins\\dsh-humanizer' ? 'PASS' : 'FAIL', junction);

// ---------------------------------------------------------------- 4. 日志
const jdir = path.join(ROOT, '.folder-janitor', 'journals');
const jnames = fs.readdirSync(jdir).filter((n) => n.endsWith('.json')).sort();
const stateId = fs.readFileSync(path.join(ROOT, '.folder-janitor', 'id'), 'utf8').trim();
const jlist = jnames.map((n) => JSON.parse(fs.readFileSync(path.join(jdir, n), 'utf8')));
const journals = [];
const journalIssues = [];
const chains = [];

/** 这条路径后来是否又被某份日志搬过；一路跟到落点确实存在为止。 */
function resolvesAt(jIndex, absPath, depth = 0) {
  if (fs.existsSync(path.join(ROOT, absPath))) return { ok: true, chain: [] };
  for (let k = jIndex + 1; k < jlist.length; k += 1) {
    const e = jlist[k].entries.find((x) => x.from === absPath);
    if (!e) continue;
    // 这次没搬成（如 EPERM）不算被接手，继续找后面的日志
    if (e.status !== 'ok') continue;
    const next = resolvesAt(k, e.to, depth + 1);
    return { ok: next.ok, chain: [{ journal: jlist[k].journalId, from: e.from, to: e.to }, ...next.chain] };
  }
  return { ok: false, chain: [] };
}

for (let i = 0; i < jlist.length; i += 1) {
  const j = jlist[i];
  const detail = { id: j.journalId, planId: j.planId, moved: j.moved, failed: j.failed, verified: j.verified, stateIdOk: j.stateId === stateId, entries: [] };
  for (const e of j.entries.filter((x) => x.status === 'ok')) {
    const toAbs = path.join(ROOT, e.to);
    const fromAbs = path.join(ROOT, e.from);
    const toOk = fs.existsSync(toAbs);
    const chained = toOk ? { ok: true, chain: [] } : resolvesAt(i, e.to);
    if (chained.chain.length > 0) chains.push({ journal: j.journalId, from: e.from, to: e.to, chain: chained.chain });
    const fromGone = !fs.existsSync(fromAbs);
    const sizeOk = toOk ? (e.kind === 'dir' ? fs.statSync(toAbs).isDirectory() : fs.statSync(toAbs).size === e.size) : null;
    detail.entries.push({ from: e.from, to: e.to, kind: e.kind, toOk, chainedToOk: chained.ok, fromGone, sizeOk });
    if (!chained.ok || !fromGone || (sizeOk === false)) journalIssues.push({ journal: j.journalId, from: e.from, to: e.to, toOk, chainedToOk: chained.ok, fromGone, sizeOk });
  }
  // failed 条目：源要么还在，要么被后续日志接手搬走了
  for (const e of j.entries.filter((x) => x.status === 'failed')) {
    const srcThere = fs.existsSync(path.join(ROOT, e.from));
    const chained = srcThere ? { ok: true, chain: [] } : resolvesAt(i, e.from);
    if (chained.chain.length > 0) chains.push({ journal: j.journalId, failedFrom: e.from, chain: chained.chain });
    detail.entries.push({ from: e.from, to: e.to, status: 'failed', error: e.error, srcStillThere: srcThere, pickedUpLater: chained.ok, chain: chained.chain });
    if (!srcThere && !chained.ok) journalIssues.push({ journal: j.journalId, from: e.from, status: 'failed 且源没了、后续日志也没接手' });
  }
  journals.push(detail);
}
add('4 份日志中所有 ok/failed 条目按「原位置→落点」链条对得上', journalIssues.length === 0 && journals.length === 4 ? 'PASS' : 'FAIL', {
  journals: journals.length, issues: journalIssues, indexQuote: 'journal-20261025-103235/103305 的 MASS 改名 failed EPERM，由 103500→103503 两步接手完成',
});
add('日志 stateId 与 .folder-janitor/id 一致', journals.every((j) => j.stateIdOk) ? 'PASS' : 'FAIL', { stateId, perJournal: journals.map((j) => j.stateIdOk) });

// ---------------------------------------------------------------- 5. undo 预演（只读，不写盘）
const dryRun = [];
const stateSnap = () => {
  const dir = path.join(ROOT, '.folder-janitor');
  const out = {};
  const walkState = (abs, rel) => {
    for (const n of fs.readdirSync(abs).sort()) {
      const a = path.join(abs, n);
      const st = fs.statSync(a);
      out[rel ? rel + '/' + n : n] = st.isDirectory() ? 'dir' : `${st.size}:${st.mtimeMs}`;
      if (st.isDirectory()) walkState(a, rel ? rel + '/' + n : n);
    }
  };
  walkState(dir, '');
  return out;
};
const beforeState = stateSnap();
for (const n of jnames) {
  const j = await loadJournalByPath(path.join(jdir, n));
  const r = await undoJournal(j, { dryRun: true });
  dryRun.push({ journal: j.journalId, restored: r.restored, skipped: r.skipped, failed: r.failed, warnings: r.warnings, skippedDetail: r.entries.filter((e) => e.status === 'skipped').map((e) => e.error) });
}
const afterState = stateSnap();
const dryOk = dryRun.every((d) => d.failed === 0 && d.warnings.length === 0);
// J3（中间那步）的目标已被 J4 搬回根目录，前向 dry_run 看不到它；这属于链条效应，不是丢文件
const dryExplained = dryRun.every((d) => d.skipped === 0 || d.skippedDetail.every((x) => /整理后的文件已经不在了/.test(x)));
add('undo dry_run：每条都能对上（含链条解释），且 .folder-janitor 零写入', dryOk && dryExplained && JSON.stringify(beforeState) === JSON.stringify(afterState) ? 'PASS' : 'FAIL', {
  dryRun, stateUntouched: JSON.stringify(beforeState) === JSON.stringify(afterState),
  dryTotals: dryRun.reduce((s, d) => ({ restored: s.restored + d.restored, skipped: s.skipped + d.skipped, failed: s.failed + d.failed }), { restored: 0, skipped: 0, failed: 0 }),
  note: 'J3 的目标在 J4 执行后已经不在；要真正回滚必须按 J4→J3→J2→J1 倒序，单独 dry_run 一份 J3 会看到 1 条 skipped',
});

report.evidence = { totals: { files: nowFiles.size, dirs: nowDirs.size, bytes: nowBytes, topLevel: fs.readdirSync(ROOT, { withFileTypes: true }).length }, journals, chains, dryRun, junction, bigTwo };

// ---------------------------------------------------------------- 6. 临时副本里做一次真撤销
const SCRATCH = path.join(REVIEW, '.scratch', 'undo-copy');
fs.rmSync(SCRATCH, { recursive: true, force: true });
const copyRoot = path.join(SCRATCH, 'root');
fs.mkdirSync(copyRoot, { recursive: true });
const srcPdftmp = path.join(ROOT, '_trash', '2026-10-25', '.pdftmp');
const dstPdftmp = path.join(copyRoot, '_trash', '2026-10-25', '.pdftmp');
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const d of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, d.name);
    const b = path.join(to, d.name);
    if (d.isDirectory()) copyTree(a, b);
    else { fs.copyFileSync(a, b); const st = fs.statSync(a); fs.utimesSync(b, st.atime, st.mtime); }
  }
}
copyTree(srcPdftmp, dstPdftmp);
fs.mkdirSync(path.join(copyRoot, '.folder-janitor', 'journals'), { recursive: true });
fs.writeFileSync(path.join(copyRoot, '.folder-janitor', 'id'), stateId);
const j1 = JSON.parse(fs.readFileSync(path.join(jdir, 'journal-20261025-103235-2ba4.json'), 'utf8'));
const pdftmpEntry = j1.entries.find((e) => e.from === '.pdftmp');
const testJournal = {
  ...j1,
  root: copyRoot,
  entries: [pdftmpEntry],
  moved: 1, failed: 0, verified: 1, bytes: 0,
  createdDirs: ['_trash', path.join('_trash', '2026-10-25')],
};
const testJournalPath = path.join(copyRoot, '.folder-janitor', 'journals', 'journal-test.json');
fs.writeFileSync(testJournalPath, JSON.stringify(testJournal, null, 2));
const realUndo = await undoJournal(await loadJournalByPath(testJournalPath), { dryRun: false });
const restoredOk = pdftmpHashes.filter((r) => {
  const abs = path.join(copyRoot, r); // 回到 .pdftmp/...
  return fs.existsSync(abs) && sha256(abs) === beforeHashes.files[r].sha256;
}).length;
const pruned = !fs.existsSync(path.join(copyRoot, '_trash'));
add('临时副本里真撤销：503 个文件回到原路径且哈希一致、自建目录清空',
  realUndo.restored === 1 && restoredOk === 503 && pruned ? 'PASS' : 'FAIL',
  { restored: realUndo.restored, skipped: realUndo.skipped, prunedDirs: realUndo.prunedDirs, restoredHashOk: restoredOk, trashPruned: pruned });

// 7. MASS 两步改名的真撤销（先撤 J4 再撤 J3，这是唯一正确的倒序）
const MASS_ORIG = '26-1015【建筑设计事务所】MASS设计集团 MASS Design Group作品集';
const MASS_NEW = 'MASS设计集团_作品集';
const massCopyRoot = path.join(SCRATCH, 'mass-root');
fs.mkdirSync(path.join(massCopyRoot, '.folder-janitor', 'journals'), { recursive: true });
fs.writeFileSync(path.join(massCopyRoot, '.folder-janitor', 'id'), stateId);
copyTree(path.join(ROOT, MASS_NEW), path.join(massCopyRoot, MASS_NEW));
const j3raw = jlist.find((j) => j.journalId === 'journal-20261025-103500-5c86');
const j4raw = jlist.find((j) => j.journalId === 'journal-20261025-103503-af4d');
for (const [name, j] of [['j4.json', j4raw], ['j3.json', j3raw]]) {
  fs.writeFileSync(path.join(massCopyRoot, '.folder-janitor', 'journals', name), JSON.stringify({ ...j, root: massCopyRoot, createdDirs: [] }, null, 2));
}
const u4 = await undoJournal(await loadJournalByPath(path.join(massCopyRoot, '.folder-janitor', 'journals', 'j4.json')));
const u3 = await undoJournal(await loadJournalByPath(path.join(massCopyRoot, '.folder-janitor', 'journals', 'j3.json')));
const blMass = blFiles.filter((e) => e.p.startsWith(MASS_ORIG + '/'));
const massBack = blMass.filter((e) => {
  const abs = path.join(massCopyRoot, e.p);
  return fs.existsSync(abs) && fs.statSync(abs).size === e.s;
});
const massTotal = blMass.reduce((s, e) => s + e.s, 0);
add('临时副本里两步改名真撤销：J4→J3 后回到 45 字原名、940 个文件大小逐个对上',
  u4.restored === 1 && u3.restored === 1 && massBack.length === blMass.length ? 'PASS' : 'FAIL',
  { undoJ4: { restored: u4.restored, skipped: u4.skipped }, undoJ3: { restored: u3.restored, skipped: u3.skipped }, expectedFiles: blMass.length, matchedFiles: massBack.length, expectedBytes: massTotal, restoredPath: MASS_ORIG });
fs.rmSync(SCRATCH, { recursive: true, force: true });

fs.writeFileSync(path.join(REVIEW, 'verify-after.json'), JSON.stringify(report, null, 2));
const pass = report.checks.filter((c) => c.verdict === 'PASS').length;
console.log(`\nPASS=${pass} FAIL=${report.checks.filter((c) => c.verdict === 'FAIL').length} INFO=${report.checks.filter((c) => c.verdict === 'INFO').length}`);
