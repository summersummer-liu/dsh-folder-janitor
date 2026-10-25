// 只读基线快照：不跟随 junction/符号链接，逐条 lstat。
// 用法: node baseline.mjs <root> <out.json>
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2]);
const out = path.resolve(process.argv[3]);

const entries = [];      // {p: 相对路径, t: 'f'|'d'|'l', s: size, m: mtimeMs}
const links = [];        // 重解析点 {p, target}
const errors = [];
let totalBytes = 0, fileCount = 0, dirCount = 0, linkCount = 0;

const t0 = Date.now();

function walk(abs, rel) {
  let dirents;
  try {
    dirents = fs.readdirSync(abs, { withFileTypes: true });
  } catch (e) {
    errors.push({ p: rel || '.', code: e.code, msg: e.message });
    return;
  }
  for (const d of dirents) {
    const childAbs = path.join(abs, d.name);
    const childRel = rel ? rel + '/' + d.name : d.name;
    let st;
    try {
      st = fs.lstatSync(childAbs);
    } catch (e) {
      errors.push({ p: childRel, code: e.code, msg: e.message });
      continue;
    }
    // Node 在 Windows 上把 junction 和 symlink 都报成 symlink
    if (st.isSymbolicLink()) {
      let target = null;
      try { target = fs.readlinkSync(childAbs); } catch {}
      links.push({ p: childRel, target, mtimeMs: st.mtimeMs });
      linkCount++;
      continue; // 绝不跟随，避免走出 root 或重复计数
    }
    if (st.isDirectory()) {
      dirCount++;
      entries.push({ p: childRel, t: 'd', m: st.mtimeMs });
      walk(childAbs, childRel);
    } else if (st.isFile()) {
      fileCount++;
      totalBytes += st.size;
      entries.push({ p: childRel, t: 'f', s: st.size, m: st.mtimeMs });
    } else {
      entries.push({ p: childRel, t: 'other', m: st.mtimeMs });
    }
  }
}

walk(root, '');

// —— 关键切片 ——
const fileEntries = entries.filter(e => e.t === 'f');
const sum = a => a.reduce((x, e) => x + e.s, 0);
const matchRel = re => fileEntries.filter(e => re.test(e.p));

function slice(label, re) {
  const hit = matchRel(re);
  return { label, files: hit.length, bytes: sum(hit), samples: hit.slice(0, 3).map(h => h.p) };
}

const slices = {
  pdftmp: slice('.pdftmp', /(^|\/)\.pdftmp\//),
  appleDouble: slice('._*', /(^|\/)\._[^/]*$/),
  dsStore: slice('.DS_Store', /(^|\/)\.DS_Store$/),
  zeroByte: { label: 'zero-byte', files: fileEntries.filter(e => e.s === 0).length },
};

const top = fs.readdirSync(root, { withFileTypes: true }).map(d => {
  const p = path.join(root, d.name);
  let st; try { st = fs.lstatSync(p); } catch { st = null; }
  const rel = d.name;
  const own = fileEntries.filter(e => e.p === rel);
  const under = fileEntries.filter(e => e.p.startsWith(rel + '/'));
  return {
    name: rel,
    kind: st ? (st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'file') : '?',
    ownBytes: own.length ? own[0].s : 0,
    treeFiles: under.length + own.length,
    treeBytes: sum(under) + (own.length ? own[0].s : 0),
    treeDirs: entries.filter(e => e.t === 'd' && e.p.startsWith(rel + '/')).length,
  };
});

const result = {
  generatedAt: new Date().toISOString(),
  root,
  elapsedMs: Date.now() - t0,
  summary: {
    topLevelItems: top.length,
    files: fileCount,
    dirs: dirCount,
    links: linkCount,
    bytes: totalBytes,
    GiB: +(totalBytes / 1024 ** 3).toFixed(3),
  },
  slices,
  links,
  topLevel: top.sort((a, b) => b.treeBytes - a.treeBytes),
  errors,
  entries, // 完整清单，第三段用来对账
};

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(result));
console.log(JSON.stringify({
  elapsedMs: result.elapsedMs,
  summary: result.summary,
  slices,
  links,
  topLevel: result.topLevel,
  errorCount: errors.length,
  errors: errors.slice(0, 20),
}, null, 2));
