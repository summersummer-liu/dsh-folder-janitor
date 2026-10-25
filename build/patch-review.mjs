import fs from 'node:fs/promises';

// 1) 插件：任一路径段命中保护名单就拒绝（reviewer 的 T17）
const plan = 'D:\\deepseek-harness\\default-workspace\\folder-janitor\\lib\\plan.js';
let p = await fs.readFile(plan, 'utf8');
const pBefore = p;
p = p.replace(
  `    if (isDir && PROTECTED_DIRS.has(path.basename(srcAbs).toLowerCase())) {`,
  `    // 任一路径段命中保护名单都拒：只挡 basename 时 plugins/dsh-humanizer 还能被单独搬走，
    // 而 profile 的 junction 正指着它
    const hitProtected = from
      .split(/[\\\\/]+/)
      .some((seg) => PROTECTED_DIRS.has(seg.toLowerCase()));
    if (hitProtected) {`,
);
if (p === pBefore) console.log('plan.js NO CHANGE');
else {
  await fs.writeFile(plan, p, 'utf8');
  console.log('plan.js patched');
}

// 2) PDF 文案：四处硬伤
const gen = 'D:\\deepseek-harness\\default-workspace\\reading-tidy\\build\\gen.mjs';
let s = await fs.readFile(gen, 'utf8');
const before = s;

// P1：19 是顶层项，其中 17 个目录
s = s.replace(
  '<div class="kicker">${F.totalFiles.toLocaleString(\'en-US\')} 个文件 · ${F.topItems} 个文件夹</div>',
  '<div class="kicker">${F.totalFiles.toLocaleString(\'en-US\')} 个文件 · ${F.topItems} 个顶层项</div>',
);

// P3：类型占比没有依据，换成复算出来的真实分布
s = s.replace(
  '<div class="body" style="max-width:880px">扫描只读元数据，一个字节都不写。出来的是：类型分布（图片 71%、文档 24%）、最大的目录、内容完全重复的组、临时与草稿文件清单。</div>',
  '<div class="body" style="max-width:880px">扫描只读元数据，一个字节都不写。出来的是：类型分布、最大的目录、重复内容、垃圾清单。</div>\n    <div class="body" style="max-width:880px">最意外的一条：<span class="accent">86% 的文件归不进任何类型</span>，其中 38,578 个根本没有扩展名 —— 莫兰蒂那一个文件夹里就有 38,383 个无后缀文件、2,681 个 .old、2,341 个 .log。</div>',
);

// P5：9 条执行条目，7 条成功
s = s.replace(
  "top('结果 · 具体动作', '6 条计划，7 条成功移动')",
  "top('结果 · 具体动作', '9 条执行条目，7 条成功')",
);

// P9：不要把这页特意否掉的因果又写回来
s = s.replace(
  '<div class="small">目录名越长越容易触发 ACL 问题，这条只绕过、没根治。</div>',
  '<div class="small">EPERM 的原因没查清，只绕过、没根治。</div>',
);

if (s === before) console.log('gen.mjs NO CHANGE');
else {
  await fs.writeFile(gen, s, 'utf8');
  console.log('gen.mjs patched');
}

// 3) 用户目录 README：MB 列是 MiB，改成 GiB 并对齐
const readme = 'D:\\阅读学习\\README.md';
let r = await fs.readFile(readme, 'utf8');
const rBefore = r;
const gib = {
  '603 文件 / 23.08 GB': '603 文件 / 22.54 GiB',
  '49,301 文件 / 5.32 GB': '49,301 文件 / 5.20 GiB',
  '89 文件 / 2.82 GB': '89 文件 / 2.75 GiB',
  '250 文件 / 2.19 GB': '250 文件 / 2.14 GiB',
  '19 文件 / 1.97 GB': '19 文件 / 1.92 GiB',
  '7 文件 / 1.87 GB': '7 文件 / 1.83 GiB',
  '2 文件 / 811.7 MB': '2 文件 / 811.7 MiB',
  '289 文件 / 410 MB': '289 文件 / 410 MiB',
  '21 文件 / 392 MB': '21 文件 / 392 MiB',
  '940 文件 / 267 MB': '940 文件 / 267 MiB',
  '296 文件 / 129 MB': '296 文件 / 129 MiB',
  '549 文件 / 105 MB': '549 文件 / 105 MiB',
  '503 文件 / 71.9 MB': '503 文件 / 71.9 MiB',
  '291 文件 / 60.8 MB': '291 文件 / 60.8 MiB',
  '229 文件 / 55.4 MB': '229 文件 / 55.4 MiB',
  '48 文件 / 8.9 MB': '48 文件 / 8.9 MiB',
  '6 文件 / 0.6 MB': '6 文件 / 0.6 MiB',
  '38 文件 / 69 KB': '38 文件 / 69 KiB',
};
for (const [from, to] of Object.entries(gib)) r = r.split(from).join(to);
r = r.replace('53,481 个文件、38.63 GB', '53,481 个文件、38.63 GiB');
if (r === rBefore) console.log('user README NO CHANGE');
else {
  await fs.writeFile(readme, r, 'utf8');
  console.log('user README patched');
}
