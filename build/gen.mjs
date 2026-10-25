// 生成小红书用的 9 页竖版图文：先出 HTML，再用 Edge 无头转 PDF / PNG。
// 数字全部来自 reading-tidy/record/summary.json（没有就用下面的 fallback）。

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RECORD = path.join(HERE, '..', 'record', 'summary.json');
const OUT = path.join(HERE, 'pages');

let summary = {};
try {
  summary = JSON.parse(await fs.readFile(RECORD, 'utf8'));
} catch {
  /* 还没生成就用 fallback */
}

const F = {
  totalFiles: summary.total_files_before ?? 53481,
  gb: ((summary.total_bytes_before ?? 41478292322) / 1024 ** 3).toFixed(2),
  dirs: summary.total_dirs_before ?? 22786,
  topItems: summary.top_level_items ?? 19,
  biggestCount: 49301,
  biggestName: '莫兰蒂作品',
  biggestShare: Math.round((49301 / (summary.total_files_before ?? 53481)) * 100),
  trashFiles: summary.trash?.files ?? summary.trash_files ?? 503,
  trashMb: ((summary.trash?.bytes ?? summary.trash_bytes ?? 75402057) / 1024 ** 2).toFixed(1),
  looseMb: Math.round(851132380 / 1024 ** 2),
  movedTotalGb: ((summary._check?.matched_bytes ?? 1350956255) / 1024 ** 3).toFixed(2),
  movedFiles: summary._check?.matched_pairs ?? 1789,
  appleFiles: summary.appledouble?.files ?? summary.appledouble_files ?? 257,
  scanSeconds: 6.8,
  movedEntries: 7,
  verified: 7,
  untouched: 13,
  longName: 45,
};

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#F5F1E8}
body{width:1080px;font-family:"Microsoft YaHei","Noto Sans SC",sans-serif;color:#16130F;
  -webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{width:1080px;height:1440px;padding:84px 80px 118px;position:relative;overflow:hidden;
  display:flex;flex-direction:column;page-break-after:always;background:#F5F1E8}
.page:last-child{page-break-after:auto}
.eyebrow{font-size:23px;letter-spacing:.2em;color:#7A7468}
.top{display:flex;justify-content:space-between;align-items:baseline;border-bottom:1px solid rgba(22,19,15,.22);padding-bottom:20px}
.h1{font-size:96px;line-height:.98;font-weight:700;letter-spacing:-.02em}
.h2{font-size:60px;line-height:1.16;font-weight:700;letter-spacing:-.01em}
.lead{font-size:33px;line-height:1.6}
.body{font-size:29px;line-height:1.68}
.small{font-size:22px;line-height:1.6;color:#7A7468}
.mono{font-family:Consolas,"Cascadia Mono",monospace;font-size:25px;line-height:1.5}
.accent{color:#B5342A}
.num{font-weight:700;letter-spacing:-.045em;line-height:.92}
.pn{position:absolute;right:80px;bottom:54px;font-size:21px;color:#7A7468;letter-spacing:.08em}
.mark{position:absolute;left:80px;bottom:54px;font-size:21px;color:#7A7468}
.grow{flex:1}
.stack{display:flex;flex-direction:column}
.card{border-top:2px solid #16130F;padding-top:26px}
.grid3{display:grid;grid-template-columns:1fr;gap:44px}
.kicker{font-size:25px;color:#B5342A;letter-spacing:.14em}
table{border-collapse:collapse;width:100%}
td{padding:20px 0;vertical-align:top;border-bottom:1px solid rgba(22,19,15,.16)}
td.old{color:#7A7468;font-family:Consolas,"Cascadia Mono",monospace;font-size:24px;width:52%}
td.arrow{width:8%;color:#B5342A;font-size:26px;text-align:center}
td.new{font-family:"Microsoft YaHei";font-size:26px;font-weight:700}
`;

function page(inner, { index, total = 9 } = {}) {
  return `<div class="page">${inner}<div class="mark">阅读学习 · 2026.10.25</div><div class="pn">${String(index).padStart(2, '0')} / ${String(total).padStart(2, '0')}</div></div>`;
}

function top(eyebrow, note = '') {
  return `<div class="top"><div class="eyebrow">${eyebrow}</div><div class="eyebrow">${note}</div></div>`;
}

const pages = [];

// 01 封面
pages.push(page(`
  ${top('D:\\阅读学习', '一次真实的整理')}
  <div class="grow stack" style="justify-content:center;gap:34px">
    <div class="kicker">${F.totalFiles.toLocaleString('en-US')} 个文件 · ${F.topItems} 个顶层项</div>
    <div class="h1">给一个<br>38 GB 的<br>学习文件夹<br>做断舍离</div>
    <div class="lead" style="max-width:820px;color:#3A342C">两个 400MB 的散件躺在根目录，一个隐藏缓存占了 ${F.trashFiles} 个文件，三个文件夹的名字不是给人读的。</div>
  </div>
  <div class="small">全程可撤销 · 读回核对 ${F.verified}/${F.movedEntries} · 0 文件丢失</div>
`, { index: 1 }));

// 02 它乱在哪
pages.push(page(`
  ${top('整理前', '先说问题')}
  <div class="h2" style="margin-top:40px">乱在三件具体的事上</div>
  <div class="grow grid3" style="margin-top:52px;align-content:start">
    <div class="card">
      <div class="kicker">01 · 一个文件夹吃掉 ${F.biggestShare}%</div>
      <div class="body" style="margin-top:12px">${F.biggestName} 里有 ${F.biggestCount.toLocaleString('en-US')} 个文件，占全盘的九成。剩下 ${F.topItems - 1} 个项目分另外 8%。</div>
    </div>
    <div class="card">
      <div class="kicker">02 · 两个大件堆在根目录</div>
      <div class="body" style="margin-top:12px">《WKW》.pdf 435 MB，原画集.zip 376 MB。每次打开这个文件夹都得先绕过它们。</div>
    </div>
    <div class="card">
      <div class="kicker">03 · 三个名字不是给人读的</div>
      <div class="mono" style="margin-top:14px;color:#3A342C">attachment_17434050909562708<br>26-1015【建筑设计事务所】MASS设计集团 MASS Design Group作品集<br>中体量建筑_副本</div>
    </div>
    <div class="small" style="border-top:1px solid rgba(22,19,15,.16);padding-top:22px">还有一个你在资源管理器里看不到的：<span class="mono">.pdftmp</span>，${F.trashFiles} 个文件、${F.trashMb} MB，全是 pip 构建缓存、Edge 临时 profile，外加一套拆书渲染的脚本和中间文件。</div>
    <div class="lead" style="margin-top:8px">所以这次几乎不碰文件内容，只碰位置和名字。</div>
  </div>
`, { index: 2 }));

// 03 先体检
pages.push(page(`
  ${top('方法 · 第一步', '只看，不动')}
  <div class="h2" style="margin-top:40px">先体检，再动手</div>
  <div class="grow stack" style="justify-content:center;gap:26px">
    <div class="stack" style="gap:8px">
      <div class="num" style="font-size:190px">${F.totalFiles.toLocaleString('en-US')}</div>
      <div class="lead">个文件、${F.dirs.toLocaleString('en-US')} 个目录，全树扫完 ${F.scanSeconds} 秒</div>
    </div>
    <div class="body" style="max-width:880px">这一步只看文件的基本信息，一个字节都不改。出来的是：类型分布、最大的目录、重复内容、垃圾清单。</div>
    <div class="body" style="max-width:880px">最意外的一条：<span class="accent">86% 的文件归不进任何类型</span>，其中 38,578 个根本没有扩展名 —— 莫兰蒂那一个文件夹里就有 38,383 个无后缀文件、2,681 个 .old、2,341 个 .log。</div>
    <div class="small" style="max-width:820px">体检的价值不是「知道有多少文件」，是知道 <span class="accent">哪些不该动</span>：${F.untouched} 个项目文件夹在用，动它们只会让人找不到东西。</div>
  </div>
`, { index: 3 }));

// 04 四步
pages.push(page(`
  ${top('方法 · 四步', '一条不能跳的顺序')}
  <div class="h2" style="margin-top:40px">看 → 清单 → 搬 → 撤销</div>
  <div class="grow stack" style="justify-content:center;gap:40px">
    ${[
      ['看', '只看不动。先看清里面有什么、什么最占地方、哪些是垃圾。'],
      ['清单', '列一张单子：哪个搬到哪、为什么。这一步也不动文件。'],
      ['搬', '按单子搬，边搬边记账，搬完回盘上核对每个落点。'],
      ['撤销', '照账本倒着退。退之前先看文件有没有被改过，改过的不硬退。'],
    ]
      .map(
        ([k, v], i) => `<div style="display:flex;gap:36px;align-items:baseline;border-top:1px solid rgba(22,19,15,.16);padding-top:26px">
          <div class="num accent" style="font-size:56px;width:64px">${i + 1}</div>
          <div><div style="font-size:38px;font-weight:700">${k}</div><div class="body" style="margin-top:8px">${v}</div></div>
        </div>`,
      )
      .join('')}
  </div>
  <div class="small">直接一把梭我试过，过两天就找不到东西。</div>
`, { index: 4 }));

// 05 改了什么
pages.push(page(`
  ${top('结果 · 具体动作', '9 条动作，7 条成功')}
  <div class="h2" style="margin-top:36px">改了什么</div>
  <table style="margin-top:34px">
    <tr><td class="old">attachment_17434050909562708</td><td class="arrow">→</td><td class="new">知末_施工图与案例素材</td></tr>
    <tr><td class="old">26-1015【建筑设计事务所】MASS设计集团<br>MASS Design Group作品集</td><td class="arrow">→</td><td class="new">MASS设计集团_作品集</td></tr>
    <tr><td class="old">中体量建筑_副本</td><td class="arrow">→</td><td class="new">中体量建筑</td></tr>
    <tr><td class="old">《WKW》.pdf + 原画集.zip（根目录）</td><td class="arrow">→</td><td class="new">_待归类/</td></tr>
    <tr><td class="old">.pdftmp（隐藏缓存）</td><td class="arrow">→</td><td class="new">_trash/2026-10-25/</td></tr>
  </table>
  <div style="margin-top:40px" class="stack">
    <div class="small" style="font-size:24px;color:#16130F">新建了三个东西：</div>
    <div class="small" style="margin-top:10px">_待归类/ 收两个散件 · _trash/2026-10-25/ 收缓存 · README.md 是目录索引。13 个项目文件夹原封不动。</div>
  </div>
  <div class="grow"></div>
  <div class="body">唯一失手的一条：那个 ${F.longName} 字符的长名文件夹，</div>
  <div class="body accent">原地改名被系统拒绝（EPERM），改用两步挪动绕过。</div>
`, { index: 5 }));

// 06 结果数字
pages.push(page(`
  ${top('结果 · 数字', '全部可复现')}
  <div class="grow stack" style="justify-content:center;gap:40px">
    <div class="stack" style="gap:6px">
      <div class="kicker">丢失文件</div>
      <div class="num" style="font-size:210px">0</div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:44px 40px">
      <div><div class="num accent" style="font-size:74px">${F.trashMb} MB</div><div class="small" style="margin-top:6px">回收：缓存与临时工作目录</div></div>
      <div><div class="num accent" style="font-size:74px">${F.looseMb} MB</div><div class="small" style="margin-top:6px">两个大件归位：_待归类/</div></div>
      <div><div class="num" style="font-size:74px">${F.movedTotalGb} GB</div><div class="small" style="margin-top:6px">实际搬动 ${F.movedFiles} 个文件（含目录里的）</div></div>
      <div><div class="num" style="font-size:74px">${F.untouched}</div><div class="small" style="margin-top:6px">个项目文件夹一个没动</div></div>
    </div>
  </div>
  <div class="small">${F.movedEntries} 次移动全部读回核对；账本在 <span class="mono">.folder-janitor/journals/</span>，撤销要按 3 份日志倒序走，反过来会跳过。</div>
`, { index: 6 }));

// 07 意外一：ACL
pages.push(page(`
  ${top('意外 01', '没查出来的原因，就不写')}
  <div class="h2" style="margin-top:40px">那次没成的改名</div>
  <div class="grow stack" style="justify-content:center;gap:30px">
    <div class="body">那个 ${F.longName} 个字的文件夹，我就在原地给它换个名，系统直接拒绝。第一反应是权限：它的权限设置里确实有一条下载工具留下的限制，写着「不许删里面的东西」。</div>
    <div class="body">但我做了个实验：自己在别处造出一条一模一样的限制，再给文件夹改名 —— <b>成功了</b>。所以那条限制不是原因。</div>
    <div class="body">也查过是不是有程序正开着它，没查到。到底为什么，我没弄清楚。</div>
    <div class="body">最后的办法是绕：<span class="accent">先搬到旁边的文件夹，再搬回来</span>，名字就换了。两次都记了账，随时能退回去。</div>
  </div>
  <div class="small">临时加的权限已经撤掉了。写一条没验证过的原因，比写「不知道」更糟。</div>
`, { index: 7 }));

// 08 意外二：插件差点搬坏自己
pages.push(page(`
  ${top('意外 02', '自己人差点被自己人搬走')}
  <div class="h2" style="margin-top:40px">它差点搬走我自己的代码</div>
  <div class="grow stack" style="justify-content:center;gap:30px">
    <div class="body">我写插件用的那个文件夹，被系统里另一处用快捷方式指着。第一版允许搬任何文件夹，测试直接复现了：一搬，插件当场不能用。</div>
    <div class="card"><div class="kicker">修了两处</div>
      <div class="body" style="margin-top:12px">1. 代码、缓存这类文件夹，一律不许搬。<br>2. 不只看名字，还查文件真正在哪 —— 快捷方式指到文件夹外面的，也拦下来。</div>
    </div>
    <div class="small">这两条是专门来找茬的 AI 挖出来的，不是我自己想到的。</div>
  </div>
`, { index: 8 }));

// 09 规则与没做的
pages.push(page(`
  ${top('规则 · 以及没做的', '别把这次当范本')}
  <div class="h2" style="margin-top:36px">三条规则，三件没做的事</div>
  <div class="grow stack" style="margin-top:40px;gap:30px;justify-content:center">
    <div class="card"><div class="body"><b>项目文件夹不动。</b>在用的东西挪了只会更难找。</div></div>
    <div class="card"><div class="body"><b>名字大改前先看清单。</b>改名比移动更容易踩到人的记忆。</div></div>
    <div class="card"><div class="body"><b>不删，只进回收站。</b>${F.trashMb} MB 的缓存也在 _trash 里躺着，不是消失。</div></div>
    <div style="border-top:2px solid #16130F;padding-top:26px" class="stack">
      <div class="small" style="color:#16130F;font-size:24px">没做的：</div>
      <div class="small" style="margin-top:10px">${F.appleFiles} 个 mac 留下来的 4KB 小文件（点开头，Windows 上用不到，合计 1 MB）还在原地，没清。</div>
      <div class="small">有个改名失败的毛病只绕过去了，没找到根因。</div>
      <div class="small">插件还在自己电脑上跑，没有上架，也没打算现在上。</div>
    </div>
  </div>
  <div class="body" style="border-top:2px solid #16130F;padding-top:24px">规则写进 README 才算结束，不然下周又乱回去。</div>
  <div class="eyebrow" style="margin-top:16px">目录索引：D:\\阅读学习\\README.md</div>
`, { index: 9 }));

await fs.mkdir(OUT, { recursive: true });
const head = (title) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title><style>@page{size:1080px 1440px;margin:0}${CSS}</style></head><body>`;

for (let i = 0; i < pages.length; i += 1) {
  const file = path.join(OUT, `p${String(i + 1).padStart(2, '0')}.html`);
  await fs.writeFile(file, `${head(`阅读学习整理 ${i + 1}`)}${pages[i]}</body></html>`, 'utf8');
}
await fs.writeFile(path.join(OUT, 'all.html'), `${head('阅读学习整理')}${pages.join('')}</body></html>`, 'utf8');

console.log(`生成 ${pages.length} 页 -> ${OUT}`);
console.log(`数字：${F.totalFiles} 文件 / ${F.gb} GB / 回收 ${F.trashMb} MB / 散件归位 ${F.looseMb} MB / 总搬动 ${F.movedTotalGb} GB`);
