// render_before.mjs — before.json -> before.md (human-readable, <= ~10 lines of prose + one table)
import fs from 'node:fs/promises';
import path from 'node:path';

const DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const before = JSON.parse(await fs.readFile(path.join(DIR, 'before.json'), 'utf8'));

const B = 1;
const KB = 1024, MB = KB * 1024, GB = MB * 1024;
function human(n) {
  if (n == null) return 'null';
  if (n >= GB) return (n / GB).toFixed(2) + ' GB';
  if (n >= MB) return (n / MB).toFixed(1) + ' MB';
  if (n >= KB) return (n / KB).toFixed(1) + ' KB';
  return n + ' B';
}
const nf = new Intl.NumberFormat('en-US');
const rows = [...before.top_level].sort((a, b) => b.bytes - a.bytes);
const typeZh = { dir: '目录', file: '文件', link: '连接点', other: '其他' };

const lines = [];
lines.push('# D:\\阅读学习 整理前快照');
lines.push('');
lines.push(`抓取 ${before.captured_at} · 耗时 ${(before.duration_ms / 1000).toFixed(1)} s · 只读元数据（readdir+lstat，不哈希），未跟随 junction`);
lines.push('');
lines.push(`## 顶层 ${before.totals.top_level_items} 项（按体积降序）`);
lines.push('');
lines.push('| # | 类型 | 名称 | 文件数 | 体积 |');
lines.push('|--:|---|---|--:|--:|');
rows.forEach((r, i) => {
  const name = r.name.replace(/\|/g, '\\|');
  lines.push(`| ${i + 1} | ${typeZh[r.type] || r.type} | ${name} | ${nf.format(r.files)} | ${human(r.bytes)} |`);
});
lines.push('');
lines.push('## 合计');
lines.push('');
const t = before.totals;
lines.push(`- 总文件 **${nf.format(t.files)}** · 总体积 **${human(t.bytes)}**（${nf.format(t.bytes)} B）· 目录 ${nf.format(t.dirs)} 个 · 顶层 ${t.top_level_items} 项（17 目录 + 2 散件；任务书写的是 20 项，实测 19 项）· junction/符号链接 ${t.links} 个`);
// `._*` 按顶层目录分布
const adByTop = new Map();
let adTotal = 0;
for (const [rel, size] of before.entries) {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  if (!base.startsWith('._')) continue;
  const top = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : '(根目录)';
  const cur = adByTop.get(top) || { files: 0, bytes: 0 };
  cur.files++; cur.bytes += size ?? 0; adTotal++;
  adByTop.set(top, cur);
}
const adBreakdown = [...adByTop.entries()].sort((a, b) => b[1].files - a[1].files)
  .map(([k, v]) => `\`${k}\` ${v.files} 个/${human(v.bytes)}`).join(' · ');
lines.push(`- \`._*\` AppleDouble 垃圾：**${nf.format(before.buckets.appledouble.files)}** 个 / **${human(before.buckets.appledouble.bytes)}**；分布：${adBreakdown || '无'}`);
lines.push(`- \`.pdftmp\`：**${nf.format(before.buckets.dot_pdftmp.files)}** 个 / **${human(before.buckets.dot_pdftmp.bytes)}**`);
lines.push('- `.pdftmp` 不全是缓存：14 个 `pip-*` / `edgeprofile` 临时目录之外，还有一套拆书渲染的工作目录——`build_book.py` 33,387 B、`render_book.py` 42,617 B、`huivang_raw.txt` 379,422 B / `huivang_full.txt` 375,086 B / `huivang_clean.txt` 376,712 B、`qa_00.png` 2,420,154 B 起共 8 张、`t1.pdf` / `t2.pdf`、20 来个 py 脚本');
lines.push(`- 隐藏文件（含上面两类）：${nf.format(before.buckets.hidden.files)} 个 / ${human(before.buckets.hidden.bytes)}`);
lines.push('');
lines.push('## 命名问题（顶层）');
lines.push('');
if (!before.naming_issues.length) lines.push('- 无');
for (const n of before.naming_issues) lines.push(`- \`${n.name}\` — ${n.flags.join('、')}`);
if (before.links.length) lines.push(`- junction：${before.links.map(l => '`' + l + '`').join('、')}`);
if (before.errors.length) lines.push(`- 读取失败 ${before.errors.length} 条（见 before.json.errors）`);

await fs.writeFile(path.join(DIR, 'before.md'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
