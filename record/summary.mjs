// summary.mjs — diff.json + undo_check.json -> summary.json
// 只留能给文案直接引用的数字；其余核对项塞进 _check，不往正文堆。
import fs from 'node:fs/promises';
import path from 'node:path';

const DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const rd = async (f, fb = null) => { try { return JSON.parse(await fs.readFile(path.join(DIR, f), 'utf8')); } catch { return fb; } };

const diff = await rd('diff.json');
const before = await rd('before.json');
const after = await rd('after.json');
const undo = await rd('undo_check.json', null);
if (!diff || !before || !after) { console.error('need diff.json + before.json + after.json'); process.exit(2); }

const biggest = [...before.top_level].sort((a, b) => b.bytes - a.bytes)[0];
const g = diff.groups ?? [];
const trashG = g.find(x => x.toTop === '_trash' || x.toTop.startsWith('_trash'));
const moveG = g.filter(x => x.action === '根目录散件归位').reduce((a, x) => ({ files: a.files + x.files, bytes: a.bytes + x.bytes }), { files: 0, bytes: 0 });
const renames = g.filter(x => x.action === '改名/整体移动').sort((a, b) => b.bytes - a.bytes)
  .map(x => ({ from: x.fromTop, to: x.toTop, files: x.files, bytes: x.bytes }));

const bNames = new Set(before.top_level.map(t => t.name));
const aNames = new Set(after.top_level.map(t => t.name));
const groupTos = new Set(g.map(x => x.toTop));
const groupFroms = new Set(g.map(x => x.fromTop));

const summary = {
  generated_at: new Date().toISOString(),

  // 体量：整理前后原有内容零丢失
  total_files_before: before.totals.files,
  total_bytes_before: before.totals.bytes,
  total_bytes_after: after.totals.bytes,
  // 41,478,308,175 − 41,478,292,322 = 15,853 B = README.md 3,727 + .folder-janitor 12,126

  trash_files: trashG?.files ?? null,
  trash_bytes: trashG?.bytes ?? null,
  moved_files: moveG.files,
  moved_bytes: moveG.bytes,

  renamed_dirs: renames.length,
  renamed_dirs_detail: renames,

  // macOS 元数据壳，这次没清（Lead 已写进 README「还没处理」）
  appledouble_files: before.buckets.appledouble.files,
  appledouble_bytes: before.buckets.appledouble.bytes,
  appledouble_bytes_per_file: before.buckets.appledouble.files
    ? before.buckets.appledouble.bytes / before.buckets.appledouble.files : null,

  undo_available: undo ? undo.undo_available : null,
  biggest_folder: { name: biggest.name, bytes: biggest.bytes, files: biggest.files },

  _check: {
    captured_before: before.captured_at,
    captured_after: after.captured_at,
    files_delta: after.totals.files - before.totals.files,
    bytes_delta: after.totals.bytes - before.totals.bytes,
    new_artifacts: diff.unmatched_after.map(x => `${x.path} (${x.size} B)`),
    matched_pairs: diff.matched_count,
    matched_bytes: diff.matched_bytes,
    matched_mtime_identical: diff.matched_mtime_identical,
    unmatched_before: diff.unmatched_before.length,
    appledouble_outside_trash_after: diff.after?.outside_trash?.appledouble_files ?? null,
    renamed_files_total: renames.reduce((s, r) => s + r.files, 0),
    renamed_bytes_total: renames.reduce((s, r) => s + r.bytes, 0),
    top_level_added: after.top_level.filter(t => !bNames.has(t.name) && !groupTos.has(t.name)).map(t => t.name),
    top_level_removed: before.top_level.filter(t => !aNames.has(t.name) && !groupFroms.has(t.name)).map(t => t.name),
    top_level_before: before.totals.top_level_items,
    top_level_after: after.totals.top_level_items,
    pdftmp_files_before: before.buckets.dot_pdftmp.files,
    pdftmp_bytes_before: before.buckets.dot_pdftmp.bytes,
    journal_bytes_sum: 851132380,
    journal_bytes_note: 'folder-janitor 对 kind=dir 的条目记 size=null，日志 bytes 只累计普通文件；71.9 MB 的 .pdftmp 和三个改名目录不在日志 bytes 里',
    undo_entries: undo?.full_restore_entries ?? null,
    undo_order: undo?.full_restore_order ?? null,
  },
};
await fs.writeFile(path.join(DIR, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
