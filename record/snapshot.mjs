// snapshot.mjs — read-only metadata snapshot of a directory tree.
// Zero deps, Node 24 ESM.
// Usage: node snapshot.mjs --root "D:\阅读学习" --label before --out before.json
// Never writes inside --root. Never follows junctions/symlinks (Windows reparse points).

import fs from 'node:fs/promises';
import path from 'node:path';

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, '');
    a[k] = argv[i + 1];
  }
  return a;
}

const args = parseArgs(process.argv);
if (!args.root || !args.label || !args.out) {
  console.error('usage: node snapshot.mjs --root <dir> --label <before|after> --out <file.json>');
  process.exit(2);
}

const ROOT = path.resolve(args.root);
const OUT = path.resolve(args.out);
const t0 = Date.now();

// ---------- walk ----------
const errors = [];          // [relPath, code]
const links = [];           // rel paths of junctions/symlinks, not descended into
const dirs = [''];          // relative dir paths, '' = root
const fileRels = [];        // relative file paths, collected for the stats pass
const depthCap = 40;

async function walk(absDir, relDir, depth) {
  let ents;
  try {
    ents = await fs.readdir(absDir, { withFileTypes: true });
  } catch (e) {
    errors.push([relDir || '.', e.code || String(e.message)]);
    return;
  }
  for (const d of ents) {
    const rel = relDir ? relDir + '/' + d.name : d.name;
    const abs = path.join(absDir, d.name);
    if (d.isFile()) {
      fileRels.push(rel);
    } else if (d.isDirectory()) {
      // Windows junctions are reparse points; lstat them so we never descend into a loop.
      let st = null;
      try { st = await fs.lstat(abs); } catch (e) { errors.push([rel, e.code || String(e.message)]); continue; }
      if (st.isSymbolicLink()) { links.push(rel); continue; }
      if (depth >= depthCap) { errors.push([rel, 'DEPTH_CAP']); continue; }
      dirs.push(rel);
      await walk(abs, rel, depth + 1);
    } else if (d.isSymbolicLink()) {
      links.push(rel);
    } else {
      links.push(rel); // socket/fifo/etc — record, do not descend
    }
  }
}

// ---------- stats pass with bounded concurrency ----------
async function statAll(rels, concurrency = 64) {
  const out = new Array(rels.length);
  let i = 0;
  async function worker() {
    while (i < rels.length) {
      const idx = i++;
      const rel = rels[idx];
      try {
        const st = await fs.stat(path.join(ROOT, rel));
        out[idx] = [rel, st.size, Math.round(st.mtimeMs)];
      } catch (e) {
        out[idx] = [rel, null, null];
        errors.push([rel, e.code || String(e.message)]);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, rels.length) }, worker));
  return out;
}

await walk(ROOT, '', 0);
const files = await statAll(fileRels);

// ---------- aggregate ----------
const topRaw = await fs.readdir(ROOT, { withFileTypes: true }).catch(() => []);
const top = [];
for (const d of topRaw) {
  let st = null;
  try { st = await fs.lstat(path.join(ROOT, d.name)); } catch { /* ignore */ }
  const type = st?.isSymbolicLink() ? 'link' : d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other';
  top.push({
    name: d.name,
    type,
    files: 0,
    bytes: 0,
    dirs: 0,
    mtime: st ? new Date(st.mtimeMs).toISOString() : null,
    mtime_ms: st ? Math.round(st.mtimeMs) : null,
  });
}
const topByName = new Map(top.map(t => [t.name, t]));

const agg = {
  bytes: 0, files: 0,
  dot_pdftmp: { files: 0, bytes: 0 },
  appledouble: { files: 0, bytes: 0 },
  hidden: { files: 0, bytes: 0 },
  other: { files: 0, bytes: 0 },       // not matched by the buckets above
};
const ext = new Map();

for (const [rel, size, mtime] of files) {
  const name = rel.slice(rel.lastIndexOf('/') + 1);
  const topName = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : rel;
  const t = topByName.get(topName);
  if (t) { t.files++; t.bytes += size ?? 0; }

  agg.files++;
  agg.bytes += size ?? 0;

  const isAppleDouble = name.startsWith('._');
  const isHidden = name.startsWith('.');
  const inPdftmp = rel === '.pdftmp' || rel.startsWith('.pdftmp/');

  let matched = false;
  if (inPdftmp) { agg.dot_pdftmp.files++; agg.dot_pdftmp.bytes += size ?? 0; matched = true; }
  if (isAppleDouble) { agg.appledouble.files++; agg.appledouble.bytes += size ?? 0; matched = true; }
  if (isHidden) { agg.hidden.files++; agg.hidden.bytes += size ?? 0; matched = true; }
  if (!matched) { agg.other.files++; agg.other.bytes += size ?? 0; }

  const e = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '(none)';
  ext.set(e, (ext.get(e) || 0) + 1);
}

for (const rel of dirs) {
  if (!rel) continue;
  const topName = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : rel;
  const t = topByName.get(topName);
  if (t) t.dirs++;
}

// naming problems — computed, not guessed
const nameIssues = [];
const allNames = [...top.map(t => t.name), ...dirs.filter(Boolean).map(d => d.slice(d.lastIndexOf('/') + 1))];
const seen = new Map();
for (const n of allNames) seen.set(n, (seen.get(n) || 0) + 1);
for (const t of top) {
  const n = t.name;
  const flags = [];
  if (/副本/.test(n)) flags.push('副本后缀');
  if (/^\d+-\d{4}/.test(n)) flags.push('日期前缀');
  if (/attachment_\d+/.test(n)) flags.push('attachment_数字');
  if (/^(\.|_)/.test(n)) flags.push(/^\./.test(n) ? '点号隐藏' : '下划线前缀');
  if (/[【】]/.test(n)) flags.push('全角括号');
  if (n.length > 40) flags.push(`名长${n.length}`);
  if (/[ ]/.test(n)) flags.push('含空格');
  if (flags.length) nameIssues.push({ name: n, flags });
}

// ---------- report ----------
const report = {
  schema: {
    entries: '[relative_path, size_bytes|never null on success, mtime_epoch_ms]',
    note: 'read-only metadata snapshot; junctions/symlinks recorded but not descended; no hashing',
  },
  label: args.label,
  root: ROOT,
  captured_at: new Date().toISOString(),
  captured_at_epoch_ms: t0,
  duration_ms: Date.now() - t0,
  totals: { files: agg.files, bytes: agg.bytes, dirs: dirs.length - 1, top_level_items: top.length, links: links.length },
  buckets: {
    dot_pdftmp: agg.dot_pdftmp,
    appledouble: agg.appledouble,
    hidden: agg.hidden,
    other: agg.other,
  },
  top_level: top,
  extensions: [...ext.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([e, n]) => ({ ext: e, files: n })),
  naming_issues: nameIssues,
  links,
  errors,
  entries: files,
};

await fs.writeFile(OUT, JSON.stringify(report));
console.log(JSON.stringify({
  label: args.label,
  out: OUT,
  duration_ms: report.duration_ms,
  totals: report.totals,
  buckets: report.buckets,
  top_level: top.map(t => `${t.type}\t${t.name}\t${t.files}\t${t.bytes}`),
  links,
  error_count: errors.length,
}, null, 2));
