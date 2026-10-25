// 第二/三段要用的「搬前哈希」：只哈希点名的目标，不扫全盘。
// 用法: node hash-targets.mjs <root> <out.json>
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(process.argv[2]);
const out = path.resolve(process.argv[3]);
const CONC = 6;

async function sha256(abs) {
  const h = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const s = fs.createReadStream(abs);
    s.on('data', (c) => h.update(c));
    s.on('error', reject);
    s.on('end', resolve);
  });
  return h.digest('hex');
}

function walk(rel, acc) {
  const abs = path.join(root, rel);
  for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
    const r = rel ? rel + '/' + d.name : d.name;
    if (d.isSymbolicLink()) { acc.links.push(r); continue; }
    if (d.isDirectory()) walk(r, acc);
    else if (d.isFile()) acc.files.push(r);
  }
  return acc;
}

const targets = new Set();
function add(rel) { targets.add(rel); }

// 1) 两个大件
add('《WKW》.pdf');
add('原画集.zip');
// 2) .pdftmp 全量
for (const f of walk('.pdftmp', { files: [], links: [] }).files) add(f);
// 3) ._* 垃圾全量（按 basename 前缀）
for (const f of walk('', { files: [], links: [] }).files) {
  if (path.basename(f).startsWith('._')) add(f);
}
// 4) plugins 全量
const pluginLinks = [];
for (const f of walk('plugins', { files: [], links: [] }).files) add(f);
for (const l of walk('plugins', { files: [], links: [] }).links) pluginLinks.push(l);

const list = [...targets].sort();
const result = { root, generatedAt: new Date().toISOString(), count: list.length, files: {}, links: pluginLinks, errors: [] };

let i = 0;
async function worker() {
  while (i < list.length) {
    const rel = list[i++];
    const abs = path.join(root, rel);
    try {
      const st = await fsp.lstat(abs);
      const hash = await sha256(abs);
      result.files[rel] = { size: st.size, mtimeMs: st.mtimeMs, sha256: hash };
    } catch (e) {
      result.errors.push({ rel, code: e.code, msg: e.message });
    }
  }
}
const t0 = Date.now();
await Promise.all(Array.from({ length: CONC }, worker));
result.elapsedMs = Date.now() - t0;
const bytes = Object.values(result.files).reduce((s, f) => s + f.size, 0);
result.totalBytes = bytes;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(result));
console.log(JSON.stringify({
  count: list.length,
  hashed: Object.keys(result.files).length,
  totalBytes: bytes,
  elapsedMs: result.elapsedMs,
  errors: result.errors.length,
  pluginLinks: result.links,
}));
