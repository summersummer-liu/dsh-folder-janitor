// manual 策略验收矩阵。只在 reading-tidy/review/.scratch/ 里造数据。
// 用法: node manual-matrix.mjs [--keep]
// 输出: ../scratch-results.json + 终端表格
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REVIEW = path.resolve(HERE, '..');
const SCRATCH = path.join(REVIEW, '.scratch');
const PLUGIN = path.resolve(REVIEW, '../../folder-janitor');
const { buildPlan } = await import('file:///' + path.join(PLUGIN, 'lib/plan.js').replace(/\\/g, '/'));
const { applyPlan, undoJournal } = await import('file:///' + path.join(PLUGIN, 'lib/apply.js').replace(/\\/g, '/'));
const { statePaths, loadJournalByPath } = await import('file:///' + path.join(PLUGIN, 'lib/store.js').replace(/\\/g, '/'));

const KEEP = process.argv.includes('--keep');
const results = [];
const log = (...a) => console.log(...a);

// ---------------------------------------------------------------- 工具
function sha256(abs) {
  return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

function snapshot(root, { includeState = false } = {}) {
  const files = {};
  const dirs = [];
  const state = [];
  function walk(abs, rel) {
    for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? rel + '/' + d.name : d.name;
      const a = path.join(abs, d.name);
      if (!includeState && (r === '.folder-janitor' || r.startsWith('.folder-janitor/'))) continue;
      const st = fs.lstatSync(a);
      if (st.isSymbolicLink()) { files[r] = { type: 'link', target: fs.readlinkSync(a), mtimeMs: st.mtimeMs }; continue; }
      if (st.isDirectory()) {
        dirs.push(r);
        if (includeState && (r === '.folder-janitor' || r.startsWith('.folder-janitor/'))) {
          state.push('D ' + r);
        }
        walk(a, r);
      } else {
        files[r] = { type: 'file', size: st.size, mtimeMs: st.mtimeMs, sha256: sha256(a) };
      }
    }
  }
  walk(root, '');
  return { files, dirs: dirs.sort() };
}

function stateSnapshot(root) {
  const out = { exists: fs.existsSync(path.join(root, '.folder-janitor')), lock: false, id: null, plans: [], journals: [] };
  const p = statePaths(root);
  if (out.exists) {
    out.lock = fs.existsSync(path.join(p.dir, 'lock'));
    try { out.id = fs.readFileSync(path.join(p.dir, 'id'), 'utf8').trim(); } catch {}
    for (const k of ['plans', 'journals']) {
      try {
        out[k] = fs.readdirSync(p[k]).sort().map((n) => n + ':' + fs.statSync(path.join(p[k], n)).size + ':' + fs.statSync(path.join(p[k], n)).mtimeMs);
      } catch {}
    }
  }
  return out;
}

function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

const tmpTargets = [];
function newRoot(name) {
  const root = path.join(SCRATCH, 'case-' + name, 'root');
  fs.rmSync(path.join(SCRATCH, 'case-' + name), { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function mk(root, rel, content = 'x') {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

async function plan(root, items) {
  const { plan: p, file } = await buildPlan({ root, strategy: 'manual', options: { items } });
  return { plan: p, file };
}

async function apply(planObj, { dryRun = false } = {}) {
  return applyPlan(planObj, { dryRun });
}

async function undo(root, journal) {
  // 走真实路径：从盘上把日志读回来再撤销
  const file = statePaths(root).journalFile(journal.journalId);
  const loaded = await loadJournalByPath(file);
  return undoJournal(loaded);
}

function caseResult(name, verdict, evidence, extra = {}) {
  results.push({ case: name, verdict, evidence, ...extra });
  log(`${verdict.padEnd(4)} ${name} :: ${evidence}`);
}

// ---------------------------------------------------------------- 用例
async function c1() {
  // 正常混合：目录移动 + 目录改名 + 文件移动，同一计划；apply 后 undo 逐字节还原
  const root = newRoot('mixed');
  mk(root, '素材/大图/a.jpg', 'AAAA');
  mk(root, '素材/大图/b.jpg', 'BBBB');
  mk(root, '旧名/inner.txt', 'OLD');
  mk(root, '散件.pdf', 'PDF');
  const before = snapshot(root);

  const { plan: p } = await plan(root, [
    { from: '素材', to: '归档/素材', reason: '目录移动' },
    { from: '旧名', to: '新名', reason: '目录改名' },
    { from: '散件.pdf', to: '_待归类/散件.pdf', reason: '散件归位' },
  ]);
  const refusals = p.skipped.map((s) => s.reason);
  const kinds = p.entries.map((e) => `${e.from}->${e.to}:${e.kind}`);

  const journal = await apply(p);
  const afterApply = snapshot(root);
  const okAll = journal.entries.every((e) => e.status === 'ok');
  const stateAfterApply = stateSnapshot(root);

  const u = await undo(root, journal);
  const afterUndo = snapshot(root);

  const byteEqual = eq(before.files, afterUndo.files) && eq(before.dirs, afterUndo.dirs);
  const dirtClean = !fs.existsSync(path.join(root, '_待归类')) && !fs.existsSync(path.join(root, '归档'));

  caseResult('T1 混合计划 apply→undo 逐字节还原', (okAll && u.restored === 3 && byteEqual && dirtClean) ? 'PASS' : 'FAIL', JSON.stringify({
    entries: kinds, skipped: refusals, moved: journal.moved, verified: journal.verified,
    undo: { restored: u.restored, skipped: u.skipped, failed: u.failed, prunedDirs: u.prunedDirs },
    createdDirs: journal.createdDirs, byteEqual, dirtClean,
    afterApplyPaths: Object.keys(afterApply.files), journalLock: stateAfterApply.lock,
  }));
}

async function c2() {
  // 越界：../、绝对路径、盘符根、内嵌 ..
  const root = newRoot('escape');
  mk(root, 'a.txt', 'A');
  const items = [
    { from: 'a.txt', to: '../outside.txt', reason: '父目录逃逸' },
    { from: 'a.txt', to: 'D:\\escape-abs.txt', reason: '绝对路径' },
    { from: 'a.txt', to: '\\escape-root.txt', reason: '盘符根相对' },
    { from: 'a.txt', to: 'sub/../../escape2.txt', reason: '内嵌 ..' },
    { from: '../etc/passwd', to: 'x.txt', reason: '源越界' },
    { from: '.', to: 'everything', reason: '搬 root 自己' },
  ];
  const { plan: p } = await plan(root, items);
  const reasons = p.skipped.map((s) => s.reason);
  const outside = fs.existsSync('D:\\escape-abs.txt') || fs.existsSync(path.resolve(root, '..', '..', 'outside.txt'));
  const pass = p.entries.length === 0 && p.skipped.length === items.length && !outside;
  caseResult('T2 越界全部拒绝', pass ? 'PASS' : 'FAIL', JSON.stringify({ entries: p.entries.length, skipped: reasons, outsideLeak: outside, planFileExists: !!p }));
}

async function c3() {
  // 目标父目录不存在：应自建，undo 应删掉自建目录
  const root = newRoot('missing-parent');
  mk(root, 'f.txt', 'F');
  const { plan: p } = await plan(root, [{ from: 'f.txt', to: 'deep/a/b/f.txt', reason: '多级目标' }]);
  const journal = await apply(p);
  const landed = fs.existsSync(path.join(root, 'deep/a/b/f.txt'));
  const u = await undo(root, journal);
  const created = journal.createdDirs.slice().sort();
  const pruned = created.every((d) => !fs.existsSync(path.join(root, d)));
  const back = fs.existsSync(path.join(root, 'f.txt'));
  const pass = landed && journal.moved === 1 && u.restored === 1 && pruned && back && !fs.existsSync(path.join(root, 'deep'));
  caseResult('T3 目标父目录缺失 → 自建 → undo 清空目录', pass ? 'PASS' : 'FAIL', JSON.stringify({
    landed, createdDirs: created, prunedDirs: u.prunedDirs, restored: u.restored, backHome: back,
    deepLeft: fs.existsSync(path.join(root, 'deep')),
  }));
}

async function c4() {
  // 目录里含 junction：搬目录本身（rename）应保留 junction，指向不变
  const root = newRoot('junction-inside');
  const outside = path.join(SCRATCH, 'case-junction-inside', 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'target.txt'), 'TARGET');
  mk(root, 'withlink/a.txt', 'A');
  fs.symlinkSync(outside, path.join(root, 'withlink', 'jl'), 'junction');

  const before = snapshot(root);
  const { plan: p } = await plan(root, [{ from: 'withlink', to: 'moved/withlink', reason: '含 junction 的目录' }]);
  // 计划层是否把「目录里有 junction」视为可搬
  const accepted = p.entries.length === 1;
  const journal = await apply(p);
  const linkStillWorks = fs.existsSync(path.join(root, 'moved/withlink/jl/target.txt'));
  const linkTarget = fs.readlinkSync(path.join(root, 'moved/withlink/jl'));
  const u = await undo(root, journal);
  const after = snapshot(root);
  const same = eq(before.files, after.files);
  caseResult('T4 目录内含 junction：搬目录', (accepted && linkStillWorks && journal.moved === 1 && u.restored === 1 && same) ? 'PASS' : 'FAIL', JSON.stringify({
    planAccepted: accepted, linkStillWorks, linkTarget, targetUnchanged: linkTarget === outside, moved: journal.moved, undoRestored: u.restored, treeEqual: same,
  }));
}

async function c5() {
  // from 本身是 junction → 应拒绝
  const root = newRoot('junction-src');
  const outside = path.join(SCRATCH, 'case-junction-src', 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'x.txt'), 'X');
  fs.symlinkSync(outside, path.join(root, 'link-to-outside'), 'junction');
  const { plan: p } = await plan(root, [{ from: 'link-to-outside', to: 'stolen', reason: '搬链接' }]);
  const refused = p.entries.length === 0 && p.skipped.some((s) => /链接|联接/.test(s.reason));
  caseResult('T5 from 是 junction → 拒绝', refused ? 'PASS' : 'FAIL', JSON.stringify({ entries: p.entries.length, skipped: p.skipped }));
}

async function c6() {
  // 目标父路径穿过 junction 指向 root 外 → 期望拒绝（检查是否逃逸）
  const root = newRoot('junction-dest');
  const outside = path.join(SCRATCH, 'case-junction-dest', 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, path.join(root, 'jout'), 'junction');
  mk(root, 'f.txt', 'PAYLOAD');
  const { plan: p } = await plan(root, [{ from: 'f.txt', to: 'jout/f.txt', reason: '目标穿过 junction' }]);
  const accepted = p.entries.length === 1;
  let landedOutside = false, journalTo = null;
  if (accepted) {
    const journal = await apply(p);
    landedOutside = fs.existsSync(path.join(outside, 'f.txt'));
    journalTo = journal.entries[0]?.to;
  }
  caseResult('T6 目标父路径是 junction（逃逸 root）', !accepted && !landedOutside ? 'PASS' : 'FAIL', JSON.stringify({
    planAccepted: accepted, landedOutside, journalTo,
    note: accepted ? '文件被搬到 root 之外的真实路径，日志里只记 jout/f.txt' : '',
  }));
}

async function c7() {
  // from 穿过 junction 从 root 外搬进来
  const root = newRoot('junction-from');
  const outside = path.join(SCRATCH, 'case-junction-from', 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'victim.txt'), 'VICTIM');
  fs.symlinkSync(outside, path.join(root, 'jin'), 'junction');
  const { plan: p } = await plan(root, [{ from: 'jin/victim.txt', to: 'stolen.txt', reason: '穿过 junction 取文件' }]);
  const accepted = p.entries.length === 1;
  let stolen = false;
  if (accepted) { await apply(p); stolen = fs.existsSync(path.join(root, 'stolen.txt')); }
  caseResult('T7 from 穿过 junction（把 root 外文件搬进来）', !accepted && !stolen ? 'PASS' : 'FAIL', JSON.stringify({
    planAccepted: accepted, stolen, outsideStillThere: fs.existsSync(path.join(outside, 'victim.txt')),
  }));
}

async function c8() {
  // 文件被另一个进程持有句柄时移动
  const root = newRoot('open-handle');
  const abs = mk(root, 'busy.bin', 'BUSY-CONTENT');
  const before = snapshot(root);
  const fh = await fsp.open(abs, 'r');
  let moved = false, error = null, journal = null;
  try {
    const { plan: p } = await plan(root, [{ from: 'busy.bin', to: 'busy2.bin', reason: '重命名被占用文件' }]);
    journal = await apply(p);
    moved = fs.existsSync(path.join(root, 'busy2.bin'));
  } catch (e) { error = e.message; }
  await fh.close();
  let undoOk = null;
  if (journal && moved) { const u = await undo(root, journal); undoOk = u.restored === 1 && fs.existsSync(abs); }
  caseResult('T8 文件被进程持有句柄时移动', (moved && undoOk) ? 'PASS' : 'FAIL', JSON.stringify({
    movedWhileOpen: moved, error, status: journal?.entries?.[0]?.status, undoOk,
    note: moved ? 'Windows 上 Node 的 rename 对已打开文件成功（共享模式含 DELETE）' : '',
  }));
}

async function c9() {
  // 目标同名已存在：文件 / 目录各一
  const root = newRoot('collision');
  mk(root, 'src.txt', 'SRC');
  mk(root, 'exists.txt', 'OTHER');
  mk(root, 'dirsrc/inner.txt', 'INNER');
  fs.mkdirSync(path.join(root, 'existsdir'), { recursive: true });
  const { plan: p } = await plan(root, [
    { from: 'src.txt', to: 'exists.txt', reason: '文件撞名' },
    { from: 'dirsrc', to: 'existsdir', reason: '目录撞名' },
  ]);
  // 反向：计划后目标才出现（apply 时竞态）
  const root2 = newRoot('collision-race');
  mk(root2, 'src.txt', 'SRC');
  const plan2 = await plan(root2, [{ from: 'src.txt', to: 'later.txt', reason: '文件竞态' }]);
  mk(root2, 'later.txt', 'APPEARED');
  const j2 = await apply(plan2.plan);
  const fileBecame = Object.keys(snapshot(root2).files).filter((f) => f.startsWith('later'));

  const root3 = newRoot('collision-race-dir');
  mk(root3, 'd/inner.txt', 'INNER');
  const plan3 = await plan(root3, [{ from: 'd', to: 'laterdir', reason: '目录竞态' }]);
  mk(root3, 'laterdir/x.txt', 'X');
  const j3 = await apply(plan3.plan);

  const planRefused = p.entries.length === 0 && p.skipped.length === 2;
  caseResult('T9 目标同名已存在（文件/目录）', planRefused ? 'PASS' : 'FAIL', JSON.stringify({
    planEntries: p.entries.length, planSkipped: p.skipped.map((s) => s.reason),
    raceFile: { status: j2.entries[0]?.status, error: j2.entries[0]?.error, note: j2.entries[0]?.note, landings: fileBecame, journalTo: j2.entries[0]?.to },
    raceDir: { status: j3.entries[0]?.status, error: j3.entries[0]?.error },
    srcStillThere: fs.existsSync(path.join(root2, 'src.txt')),
  }));
}

async function c10() {
  // dry_run 必须零写入
  const root = newRoot('dryrun');
  mk(root, 'a.txt', 'A');
  mk(root, 'dir/inner.txt', 'I');
  const { plan: p } = await plan(root, [
    { from: 'a.txt', to: 'sub/a.txt', reason: '文件' },
    { from: 'dir', to: 'dir2', reason: '目录改名' },
  ]);
  const beforeTree = snapshot(root);
  const beforeState = stateSnapshot(root);
  const journal = await apply(p, { dryRun: true });
  const afterTree = snapshot(root);
  const afterState = stateSnapshot(root);
  const treeSame = eq(beforeTree, afterTree);
  const stateSame = eq(beforeState, afterState);
  const noLock = !afterState.lock;
  const worldMoves = journal.entries.every((e) => e.status === 'would-move');
  caseResult('T10 dry_run 零写入（含 .folder-janitor 状态）', (treeSame && stateSame && noLock && worldMoves) ? 'PASS' : 'FAIL', JSON.stringify({
    treeSame, stateSame, noLock, statuses: journal.entries.map((e) => e.status), wouldMove: journal.moved,
    diffTree: treeSame ? null : { before: Object.keys(beforeTree.files), after: Object.keys(afterTree.files) },
  }));
}

async function c11() {
  // 受保护目录名 & 目录搬进自己
  const root = newRoot('protect');
  mk(root, 'node_modules/pkg/a.js', 'A');
  mk(root, '.git/HEAD', 'ref');
  mk(root, 'self/inner.txt', 'I');
  mk(root, 'plugins/dsh-humanizer/package.json', '{}');
  const { plan: p } = await plan(root, [
    { from: 'node_modules', to: 'x/node_modules', reason: '受保护' },
    { from: '.git', to: 'x/git', reason: '受保护' },
    { from: 'self', to: 'self/inner/self', reason: '搬进自己' },
    { from: 'plugins', to: '_trash/plugins', reason: '插件目录（真实数据里有 junction 指向它）' },
  ]);
  const refused = p.skipped.map((s) => s.from + ':' + s.reason);
  const pluginsAccepted = p.entries.some((e) => e.from === 'plugins');
  // node_modules / .git / plugins / 搬进自己 → 4 条都该拒
  const pass = refused.length === 4 && !pluginsAccepted;
  caseResult('T11 受保护目录名 + 搬进自己', pass ? 'PASS' : 'FAIL', JSON.stringify({
    refused, pluginsAccepted,
  }));
}

async function c12() {
  // 大小写同名 / 尾点（Windows 会静默改写目标名）
  const root = newRoot('names');
  mk(root, 'abc.txt', 'ABC');
  mk(root, 'keep.txt', 'K');
  const { plan: p1 } = await plan(root, [{ from: 'keep.txt', to: 'ABC.TXT', reason: '大小写同名' }]);
  const { plan: p3 } = await plan(root, [{ from: 'keep.txt', to: 'trail.txt.', reason: '尾点' }]);
  let trailResult = null;
  if (p3.entries.length) {
    const j = await apply(p3);
    const listed = fs.readdirSync(root);
    trailResult = { status: j.entries[0]?.status, journalTo: j.entries[0]?.to, onDisk: listed.filter((n) => n.startsWith('trail')) };
  }
  caseResult('T12 大小写同名 / 尾点', 'INFO', JSON.stringify({
    caseTwin: { entries: p1.entries.length, skipped: p1.skipped.map((s) => s.reason) },
    trailingDot: { entries: p3.entries.length, skipped: p3.skipped.map((s) => s.reason), trailResult },
    note: 'Windows 保留名（CON 等）没测：造出来可能删不掉',
  }));
}

async function c13() {
  // 跨盘（EXDEV）：junction 指向 C: 临时目录
  const root = newRoot('xdev');
  const ctmp = path.join(os.tmpdir(), 'fj-xdev-' + process.pid);
  fs.rmSync(ctmp, { recursive: true, force: true });
  fs.mkdirSync(ctmp, { recursive: true });
  tmpTargets.push(ctmp);
  fs.symlinkSync(ctmp, path.join(root, 'jcross'), 'junction');
  mk(root, 'bigdir/a.bin', crypto.randomBytes(256 * 1024));
  mk(root, 'file.bin', crypto.randomBytes(512 * 1024));

  const { plan: p, file } = await plan(root, [
    { from: 'bigdir', to: 'jcross/bigdir', reason: '目录跨盘' },
    { from: 'file.bin', to: 'jcross/file.bin', reason: '文件跨盘' },
  ]);
  const refused = p.skipped.map((s) => s.reason);
  const leaked = fs.existsSync(path.join(ctmp, 'file.bin')) || fs.existsSync(path.join(ctmp, 'bigdir'));
  const dirStillHome = fs.existsSync(path.join(root, 'bigdir/a.bin'));
  // 守卫拦下之后，EXDEV 分支在 manual 路径上已经不可达；这里只记录「拦截生效」
  const pass = p.entries.length === 0 && !leaked && dirStillHome;
  caseResult('T13 跨盘：junction 目标被 realpath 守卫拦下', pass ? 'PASS' : 'FAIL', JSON.stringify({
    planEntries: p.entries.length, refused, leaked, dirStillHome,
    note: 'moveEntry 的 EXDEV / EXDEV_DIR 分支现在在 manual 路径上不可达：要触发跨卷就得经过 junction，而 junction 已被拦。这段代码等于没有集成测试覆盖。',
  }));
}

async function c18() {
  // 计划生成后把父目录换成 junction（TOCTOU）：apply 端必须也拦
  const root = newRoot('toctou');
  const outside = path.join(SCRATCH, 'case-toctou', 'outside');
  fs.mkdirSync(outside, { recursive: true });
  mk(root, 'a.txt', 'PAYLOAD');
  fs.mkdirSync(path.join(root, 'sub'));
  const { plan: p } = await plan(root, [{ from: 'a.txt', to: 'sub/a.txt', reason: '先进计划' }]);
  const plannedOk = p.entries.length === 1;
  // 计划后：把空目录 sub 换成指向 root 外的 junction
  fs.rmdirSync(path.join(root, 'sub'));
  fs.symlinkSync(outside, path.join(root, 'sub'), 'junction');
  const journal = await apply(p);
  const leaked = fs.existsSync(path.join(outside, 'a.txt'));
  const pass = plannedOk && !leaked && journal.entries[0]?.status === 'failed';
  caseResult('T18 计划后父目录被换成 junction（apply 端复查）', pass ? 'PASS' : 'FAIL', JSON.stringify({
    plannedOk, applyStatus: journal.entries[0]?.status, applyError: journal.entries[0]?.error, leaked,
    srcStillThere: fs.existsSync(path.join(root, 'a.txt')),
  }));
}

async function c14() {
  // 目录里有 junction 且 undo 前内容被动过：目录条目没有大小/哈希护栏
  const root = newRoot('dir-tamper');
  mk(root, 'work/a.txt', 'V1');
  const { plan: p } = await plan(root, [{ from: 'work', to: 'work2', reason: '改名' }]);
  const journal = await apply(p);
  fs.writeFileSync(path.join(root, 'work2/a.txt'), 'TAMPERED');
  const u = await undo(root, journal);
  const backHome = path.join(root, 'work/a.txt');
  const content = fs.existsSync(backHome) ? fs.readFileSync(backHome, 'utf8') : '(没回到原位置)';
  caseResult('T14 目录内容被改后 undo', 'INFO', JSON.stringify({
    undoRestored: u.restored, undoSkipped: u.skipped, contentAfterUndo: content, stayedAtNewPath: fs.existsSync(path.join(root, 'work2')),
    note: '目录条目 journal.size/mtime/hash 全为 null，undo 无内容护栏；改过的目录照样被 rename 回去',
  }));
}

async function c15() {
  // 同批里一条的 from 落在另一条的 to 下面（目录套目录）
  const root = newRoot('nesting');
  mk(root, 'd1/f.txt', 'F');
  mk(root, 'other.txt', 'O');
  const { plan: p } = await plan(root, [
    { from: 'd1', to: 'd2', reason: '目录改名' },
    { from: 'd1/f.txt', to: 'd2/f.txt', reason: '子文件同批移动' },
  ]);
  const journal = await apply(p);
  const statuses = journal.entries.map((e) => `${e.from}:${e.status}${e.error ? '/' + e.error : ''}`);
  const finalTree = Object.keys(snapshot(root).files).sort();
  const u = await undo(root, journal);
  const afterUndo = Object.keys(snapshot(root).files).sort();
  caseResult('T15 目录套目录：d1→d2 且 d1/f.txt→d2/f.txt', 'INFO', JSON.stringify({
    planEntries: p.entries.length, statuses, finalTree, undo: { restored: u.restored, skipped: u.skipped }, afterUndo,
  }));
}

async function c16() {
  // 同一批里 from 重复 / to 互为 from
  const root = newRoot('dups');
  mk(root, 'a.txt', 'A');
  mk(root, 'b.txt', 'B');
  const { plan: p } = await plan(root, [
    { from: 'a.txt', to: 'x.txt', reason: '第一次' },
    { from: 'a.txt', to: 'y.txt', reason: '同一 from 两次' },
    { from: 'b.txt', to: 'x.txt', reason: '同一 to 两次' },
    { from: 'b.txt', to: 'a.txt', reason: 'to 是别人的 from' },
  ]);
  const journal = await apply(p);
  caseResult('T16 同批 from 重复 / to 撞车', 'INFO', JSON.stringify({
    planEntries: p.entries.map((e) => `${e.from}->${e.to}`),
    planSkipped: p.skipped.map((s) => s.from + ':' + s.reason),
    statuses: journal.entries.map((e) => `${e.from}->${e.to}:${e.status}`),
    finalTree: Object.keys(snapshot(root).files).sort(),
  }));
}

async function c17() {
  // 真实场景复刻：profile 里有一条 junction 指向 root/plugins/dsh-humanizer
  const root = newRoot('plugin-link');
  mk(root, 'plugins/dsh-humanizer/package.json', '{"name":"dsh-humanizer"}');
  const plc = path.join(SCRATCH, 'case-plugin-link', 'profile', 'node_modules', 'dsh-humanizer');
  fs.mkdirSync(path.dirname(plc), { recursive: true });
  fs.symlinkSync(path.join(root, 'plugins/dsh-humanizer'), plc, 'junction');
  const liveBefore = fs.existsSync(path.join(plc, 'package.json'));

  const { plan: p1 } = await plan(root, [{ from: 'plugins', to: '_trash/2026-10-25/plugins', reason: '把插件目录当缓存扔进 _trash' }]);
  const acceptedAsTrash = p1.entries.length === 1;
  const j1 = await apply(p1);
  const liveAfterMove = fs.existsSync(path.join(plc, 'package.json'));
  const u1 = await undo(root, j1);
  const liveAfterUndo = fs.existsSync(path.join(plc, 'package.json'));

  const { plan: p2 } = await plan(root, [{ from: 'plugins/dsh-humanizer', to: 'plugins/dsh-humanizer-v2', reason: '改名插件目录' }]);
  const acceptedAsRename = p2.entries.length === 1;
  const j2 = await apply(p2);
  const liveAfterRename = fs.existsSync(path.join(plc, 'package.json'));

  caseResult('T17 profile junction 指向 plugins/dsh-humanizer', (!acceptedAsTrash && !acceptedAsRename) ? 'PASS' : 'FAIL', JSON.stringify({
    liveBefore, acceptedAsTrash, liveAfterMove, undoRestored: u1.restored, liveAfterUndo,
    acceptedAsRename, liveAfterRename,
    note: '两条都被接受：搬走或改名后 profile\\.dsh\\...\dsh-humanizer 变成悬空 junction，插件消失',
  }));
}

// ---------------------------------------------------------------- 主流程
fs.mkdirSync(SCRATCH, { recursive: true });
const cases = [c1, c2, c3, c4, c5, c6, c7, c8, c9, c10, c11, c12, c13, c14, c15, c16, c17, c18];
for (const c of cases) {
  try { await c(); } catch (e) { caseResult(c.name, 'ERROR', String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)); }
}
for (const t of tmpTargets) fs.rmSync(t, { recursive: true, force: true });

const summary = {
  generatedAt: new Date().toISOString(),
  plugin: PLUGIN,
  pluginFingerprint: {
    'index.js': sha256(path.join(PLUGIN, 'index.js')).slice(0, 16),
    'lib/apply.js': sha256(path.join(PLUGIN, 'lib/apply.js')).slice(0, 16),
    'lib/plan.js': sha256(path.join(PLUGIN, 'lib/plan.js')).slice(0, 16),
  },
  pass: results.filter((r) => r.verdict === 'PASS').length,
  fail: results.filter((r) => r.verdict === 'FAIL').length,
  info: results.filter((r) => r.verdict === 'INFO').length,
  error: results.filter((r) => r.verdict === 'ERROR').length,
  results,
};
fs.writeFileSync(path.join(REVIEW, 'scratch-results.json'), JSON.stringify(summary, null, 2));
log(`\nPASS=${summary.pass} FAIL=${summary.fail} INFO=${summary.info} ERROR=${summary.error}`);
if (!KEEP) {
  // 保留 case 目录里的小文件无意义，清掉；C: 临时目录已清
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  log('scratch cleaned');
} else {
  log('scratch kept at ' + SCRATCH);
}
