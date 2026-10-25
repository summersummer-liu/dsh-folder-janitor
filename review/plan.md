# D:\阅读学习 整理前基线 + manual 策略审核提纲

审核员（reviewer）第一段产出。所有数字都是我自己在盘上跑出来的，不引用 Lead 的说法。
快照时间：2026-10-25 10:30:18（Asia/Shanghai），此时 `.folder-janitor` 还不存在，目录是干净的原始状态。

## 1. 基线数字

命令：

```powershell
node reading-tidy\review\tools\baseline.mjs 'D:\阅读学习' 'reading-tidy\review\baseline.json'
# 独立复核（PowerShell 自己走一遍递归）
Get-ChildItem -LiteralPath 'D:\阅读学习' -Recurse -Force -File | Measure-Object Length -Sum
```

两条路径结果一致，说明我的 walker 没有漏项：

| 项 | 值 |
|---|---|
| 顶层条目 | **19**（任务书写 20，对不上） |
| 文件数 | **53,481**（任务书写「约 5.6 万」，差约 2,500） |
| 目录数 | 22,786 |
| 总字节 | **41,478,292,322** = 38.63 GiB |
| root 内 junction / 符号链接 | **0**（walker 逐条 lstat，遇到链接不跟进） |
| `.pdftmp` | **503 文件 / 75,402,057 字节** |
| `._*`（AppleDouble） | **257 文件 / 1,052,672 字节** |
| `.DS_Store` | 13 文件 / 114,740 字节 |
| 0 字节文件 | 12,703（莫兰蒂作品 12,652、.pdftmp 49、attachment_… 2） |
| `plugins` | 38 文件 / 69,089 字节 / 18 目录 |

顶层 19 项按体积降序（树内文件数与字节，含子目录）：

```
阅读                603 文件   24,198,298,277 B
莫兰蒂作品        49,301 文件    5,579,698,338 B
投标                 89 文件    2,953,323,141 B
G构造               250 文件    2,294,521,325 B
积累与学习           19 文件    2,066,853,154 B
建筑构件特辑detail     7 文件    1,960,929,684 B
《WKW》.pdf          1 文件      456,561,735 B
南京生活手册        289 文件      430,326,214 B
concept_arts         21 文件      410,900,968 B
原画集.zip            1 文件      394,570,645 B
26-1015…作品集      940 文件      279,707,066 B
attachment_17434050909562708  296 文件  135,339,728 B
博物馆建筑学习网页   549 文件      110,021,642 B
.pdftmp             503 文件       75,402,057 B
学校建筑学习网页     291 文件       63,735,851 B
作品集网页          229 文件       58,041,127 B
中体量建筑_副本      48 文件        9,375,024 B
_covers               6 文件          617,257 B
plugins              38 文件           69,089 B
```

完整逐文件清单（路径 + 大小 + mtime）在 `baseline.json` 的 `entries` 里，第三段用它判断有没有文件凭空消失。

## 2. 搬前哈希（为第三段「内容守恒」冻结）

```powershell
node reading-tidy\review\tools\hash-targets.mjs 'D:\阅读学习' 'reading-tidy\review\baseline-hashes.json'
```

800 个文件 / 927,656,198 字节，SHA-256 全量，0 错误：
`《WKW》.pdf`、`原画集.zip`、`.pdftmp` 里全部 503 个文件、全部 257 个 `._*`、`plugins` 里全部 38 个文件。
搬完之后任何一个字节变了，这里能直接指出来。

## 3. plugins 是活的

```
C:\Users\summer\.dsh\profiles\desktop\node_modules\dsh-humanizer
    → junction → D:\阅读学习\plugins\dsh-humanizer   (Get-Item .Target)
    → package.json 可读，name=dsh-humanizer, version=0.1.0
D:\阅读学习\plugins\dsh-humanizer  是真目录，不是二级链接
    fsutil reparsepoint query → Error 4390: not a reparse point
```

结论：**整条链只有一层 junction**。真正怕的是有人搬 `plugins` 或 `plugins\dsh-humanizer`——junction 的目标是写死路径，目录一改名就悬空，插件从 profile 里消失。实测见 review.md 的 T17。

## 4. manual 策略的 5 个高危点（读源码得出，逐条给了判据）

读的是这一版（SHA-256 前 16 位）：`index.js` 704CBE9A1208D3DA / `lib/apply.js` FAA0251A3E4802F7 / `lib/plan.js` F4FDEBFE53A3C22C。

**① 目录条目和文件条目走的是两套守卫，最容易漏**
`buildManualPlan` 会产出 `kind:'dir'`、`size:null` 的条目。`applyPlan` 里 `wantsDir` 把 size/mtime 检查整段跳过，journal 里目录的 `size/mtimeMs/hash` 全是 `null`，于是 undo 对目录**没有任何内容护栏**——只看「目标位置还是个目录」。判据：目录里改一个文件再 undo，会不会被拦。预期拦不住，重点不是能不能回滚，而是别在文档里承诺「改过的会被拦住」。

**② `insideRoot()` 是纯字符串比较，链接能把它绕过去**
`path.relative()` 只在字面上判断，不管中间某一段是不是 junction。`from` 或 `to` 的**父路径**穿过 junction 时，文件会真的进出 root。判据：`to:"jout/f.txt"`（jout 指向 root 外）会不会被拒；`from:"jin/victim.txt"`（root 外文件）会不会被搬走。这条对现在的 D:\阅读学习 是空风险（root 内链接 0 个），但插件要发出去。

**③ `plugins` 不在 PROTECTED_DIRS**
`plan.js` 的保护名单是 `.git/.folder-janitor/node_modules/__pycache__/.venv/venv`，按 basename 比。`plugins` 这个 basename 很常见，但在本机它是被测插件自己的家。判据：`{from:"plugins", to:"_trash/.../plugins"}` 是否会被接受。

**④ 目标已存在的拒绝只在计划阶段有效**
`buildManualPlan` 用 `pathExists(destAbs)` 挡撞名；但计划生成到 apply 之间目标才出现时，走的是 `applyPlan` 的碰撞分支：目录直接 failed（对），文件会 `pickFreeName` 加 `(2)` 照样搬。契约说 manual 不加 (2)。判据：计划后造一个同名文件，看落点是不是 `later (2).txt`。

**⑤ 跨盘 / 目录套目录 / 同名文件**
- 跨盘：`moveEntry` 只在 EXDEV 时对**文件**退化成 copy+utimes+unlink；目录抛 `EXDEV_DIR`。要确认目录失败后源完好、没有半截副本。
- 目录套目录：`{from:"d1", to:"d2"}` 和 `{from:"d1/f.txt", to:"d2/f.txt"}` 同批。计划期两边目标都不存在，都会通过；apply 按 `from` 字典序执行。要确认不会把文件搬丢。
- 同名：大小写不同（`ABC.TXT` vs `abc.txt`）在 Windows 上算撞名，`pathExists` 会拦住——确认一下，别让大小写改写悄悄发生。

Test outline 落在 `tools/manual-matrix.mjs`（16+1 例）。第二段结果见 `review.md`，第三段对账见同文件后半部分。
