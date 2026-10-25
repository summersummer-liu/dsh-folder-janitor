# 审核报告：manual 策略 + D:\阅读学习 整理后对账

审核员（reviewer）。所有结论都来自我自己在盘上跑的命令，不采信 Lead 的说法。
本文件分两段：第二段是插件 `manual` 策略的对抗测试，第三段是真数据的对账。每条都给 PASS/FAIL 和复现命令。

被测代码指纹（矩阵最后重跑时，2026-10-25 10:43）：

| 文件 | SHA-256 前 16 位 | 最后修改 |
|---|---|---|
| `index.js` | `704CBE9A1208D3DA` | 10:31:03 |
| `lib/apply.js` | `12A3B96C4374843F` | 10:34:32 |
| `lib/plan.js` | `09E82FE53FEACCFA` | 10:34:24 |
| `lib/scan.js` | `908938AAFC64AC9E` | 10:34:44 |

中途我按过 10:30 那一版（`FAA0251A…`/`F4FDEBFE…`），那时 `plugins` 没进保护名单、`insideRoot` 还是纯字符串判断。下面 FAIL/PASS 的行是按上表这版。**没改过 `lib/`，也没动 `D:\阅读学习` 一个字节。**

---

## 一、manual 策略矩阵：18 例，PASS 13 / FAIL 1 / INFO 4

```powershell
node reading-tidy\review\tools\manual-matrix.mjs --keep
```

每条用例在 `reading-tidy/review/.scratch/case-*/root` 里造独立数据，跑完删掉。证据在 `scratch-results.json`。

| 用例 | 结论 | 关键证据 |
|---|---|---|
| T1 目录移动+目录改名+文件移动同一计划 → undo | PASS | 3 条全 ok、verified 3；undo restored 3、prunedDirs 2；撤销后全树（含子目录文件 SHA-256、目录集合）与 apply 前逐字节相同 |
| T2 越界 6 种（`../`、绝对路径、盘符根、内嵌 `..`、源越界、搬 root 自己） | PASS | entries 0，6 条全进 skipped；root 外零落点 |
| T3 目标父目录不存在 | PASS | 自建 `deep/a/b`，createdDirs 记 3 个；undo 全清空，`deep` 不残留 |
| T4 目录内含 junction，整体搬 | PASS | 搬后 junction 仍可用、target 未变；undo 后树一致。rename 不动 junction 目标，这条安全 |
| T5 `from` 本身是 junction | PASS | 拒绝："符号链接/目录联接不搬" |
| T6 目标父路径是 junction（指向 root 外） | PASS | 10:34 那版之前是 **FAIL**；现在 realpath 校验拒绝，root 外无落点 |
| T7 `from` 穿过 junction（拿 root 外文件） | PASS | 同上，已拒；外部文件仍在原位 |
| T8 文件被进程持有句柄时移动 | PASS | `fs.open` 持着句柄时 rename 成功、undo 干净。Windows 下 Node 的共享模式含 DELETE，这条不必特殊处理 |
| T9 目标同名已存在（文件/目录各一）+ 计划后目标才出现的竞态 | PASS | 计划期两条都拒；竞态下文件条目 `failed "目标已存在（manual 不自动改名）"`、源仍在；目录条目 failed。不再出现 `(2)` |
| T10 dry_run 零写入 | PASS | 树（路径+大小+mtime+哈希）与 `.folder-janitor` 状态逐项相同，无 lock，状态全是 `would-move` |
| T11 受保护目录名 + 搬进自己 | PASS | node_modules/.git/plugins 三条全拒，`self→self/inner/self` 拒 |
| T12 大小写同名 / 尾点 | INFO | `keep.txt→ABC.TXT` 被"目标已存在"拒（Windows 大小写不敏感）；`trail.txt.` 能建、日志与盘上名字一致 |
| T13 跨盘（junction 指向 C: 临时目录） | PASS | 现在被 realpath 拦下，没有文件写到 C:。**代价：`moveEntry` 的 EXDEV/EXDEV_DIR 分支在 manual 路径上不可达了**（要跨卷就得过 junction，而 junction 被拦）——那段代码等于没有集成测试 |
| T14 目录内容被改后 undo | INFO | 目录条目 journal 的 size/mtime/hash 全是 `null`，改过的目录照样被 rename 回去（contentAfterUndo=TAMPERED）。契约没承诺拦，但文档里不能写"改过的会被拦住" |
| T15 目录套目录（d1→d2 且 d1/f.txt→d2/f.txt） | INFO | 两个条目都进了计划；apply 时第二条 skipped「源文件已不存在」，无丢失；undo 后回到 d1/f.txt |
| T16 同批 from 重复 / to 撞车 | INFO | `a.txt` 出现两次都进计划，第二条 apply 时 skipped；最终盘上 a→x.txt、b.txt 还在。**计划层不查重复 from**，建议补 |
| T17 profile junction 指向 `plugins/dsh-humanizer` | **FAIL** | 见下 |
| T18 计划后把父目录换成 junction（apply 端复查） | PASS | apply 报 `真实路径越出根目录` failed，源完好，无泄漏。说明 plan→apply 之间的 TOCTOU 也堵住了 |

### 唯一的 FAIL：T17，还能改 `plugins` 的子目录名

复刻：`root/plugins/dsh-humanizer/package.json`，外部一条 junction 指向它（和 `C:\Users\summer\.dsh\profiles\desktop\node_modules\dsh-humanizer` 同构）。

- `{from:"plugins", to:"_trash/2026-10-25/plugins"}` → **拒绝**（`PROTECTED_DIRS` 生效）
- `{from:"plugins/dsh-humanizer", to:"plugins/dsh-humanizer-v2"}` → **接受（FAIL）**，apply 之后 `profile\...\dsh-humanizer\package.json` 立刻读不到，junction 悬空

原因：保护判断用 `path.basename(srcAbs)`，`plugins` 只有作为最后一段才命中。真实数据这次没踩到（`plugins` 一个字节没动，我验过），但插件要发出去，别人目录树里 protected 目录的子目录一样能改名。建议：`from` 的**任一路径段**命中 `PROTECTED_DIRS` 就拒绝，而不是只比 basename。

### 顺手说三件

- Lead 报的回归我独立跑了：`run.mjs` 29/29、`edge.mjs` 23/23、`manual.mjs` 15/15，都过。`adversarial.mjs` 我没跑——它会往 `folder-janitor/test/.adv` 写盘，超出我的写盘范围。
- 中途我抓到过一版真回归：`realInsideRoot` 早一版把「最近存在的祖先是 root 本身」判成越界，导致**顶层改名全部被拒**（`attachment_123 → 知末_素材` 报"真实路径越出 root"）。10:34:44 那版修了（`if (rel === '') return true`），我复核过。这条只是记录：如果那个修法再动，先跑 T1 和 T3。
- `realInsideRoot(root, root)` 现在返回 true。调用点都有 `insideRoot` 先挡着，所以「搬 root 自己」仍然被拒；但这个函数自己不再拒绝 root，别单独用它当边界判断。

---

## 二、真数据对账：18 项全 PASS

```powershell
node reading-tidy\review\tools\verify-after.mjs
```

基线是我在 Lead 动手前 10:30:18 抓的（`baseline.json`，53,481 文件 + 800 个文件的 SHA-256 在 `baseline-hashes.json`）。核心结论：**一个文件没丢，一个字节没变，plugins 没动。**

| 检查 | 结论 | 数字 |
|---|---|---|
| 搬前 53,481 个文件在映射后位置按大小对上 | PASS | missing 0 / sizeMismatch 0；1789 个文件发生前缀位移 |
| 搬前 22,786 个目录都在 | PASS | missingDirs 0 |
| 旧位置已清空、不留副本 | PASS | 6 个旧路径全部不存在 |
| 没有计划外的新文件 | PASS | 多出来的只有 README.md + `.folder-janitor/` 10 个文件 |
| 文件总数/总字节 = 基线 + 新产物 | PASS | 53,481→53,492（+11）、41,478,292,322→41,478,308,175（+15,853），delta 0 |
| 800 个冻结文件 SHA-256 | PASS | 927,656,198 B 逐字节一致，含 `.pdftmp` 503、`._*` 257、plugins 38、两个大件 |
| **全部 53,481 个文件 mtime 与搬前一致** | PASS | 0 个不一致。同卷 rename 的直接证据，比抽样哈希更硬 |
| `.pdftmp` 503 个文件在 `_trash/2026-10-25/.pdftmp` | PASS | 503/503，命名 + 哈希都对 |
| `《WKW》.pdf`、`原画集.zip` 在 `_待归类` | PASS | 456,561,735 / 394,570,645，哈希一致 |
| `plugins/` 38 个文件 | PASS | 69,089 B，哈希全同 |
| profile junction | PASS | 仍指向 `D:\阅读学习\plugins\dsh-humanizer`，package.json 可读（sha 前 16 位 `0cde69a949578816`） |
| 4 份日志按「原位置→落点」链条对上 | PASS | 见下：两次 EPERM 失败由后两份日志接手 |
| 日志 stateId 与 `.folder-janitor/id` | PASS | `f5867319f7eed390`，4/4 |
| undo dry_run 预演 | PASS | restored 6 / skipped 1 / failed 0；`.folder-janitor` 目录树（名+大小+mtime）零变化 |
| 临时副本真撤销：`.pdftmp` | PASS | 503 个文件回到 `.pdftmp/…`，哈希逐一致；自建 `_trash/2026-10-25`、`_trash` 清空 |
| 临时副本真撤销：MASS 两步改名（J4→J3） | PASS | 回到 45 字原名，940 个文件大小逐个对上（279,707,066 B） |

日志链条要说清楚：`journal-…-2ba4`（主批次 5 ok + MASS failed EPERM）→ `-c681`（MASS 重试仍 EPERM）→ `-5c86`（挪进 `_待归类` ok）→ `-af4d`（挪回根目录 ok）。所以**前向干跑时 `-5c86` 会看到 1 条 skipped（"整理后的文件已经不在了"）**——因为它的目标已经被 `-af4d` 搬回根目录了。这不是丢文件：全链回滚必须按 `-af4d → -5c86 → -2ba4` 倒序，我在副本里照这个顺序跑通过。

---

## 三、record 与页面上的数字

### record/ 本身：复现通过

`node reading-tidy\review\tools\number-audit.mjs`

- `record/before.json` 和我的独立基线**逐文件一致**：53,481 / 41,478,292,322 B / 22,786 目录 / 19 顶层项 / 0 链接。两套 walker 互相校验，没有分歧。
- `before.md` 19 行表格逐行复算：文件数 + GiB 全对（22.54 / 5.20 / 2.75 …）。
- `summary.json` 的每个字段复现：trash 503/75,402,057、moved 2/851,132,380、renamed 3（940+296+48=1284 文件 / 424,421,818 B）、appledouble 257/1,052,672/4096、biggest_folder 603/24,198,298,277、matched 1,789/1,350,956,255、_check 各条。
- `before-after.md` 的变化量对：+11 文件 / +15,853 B / +6 目录 / 19→20 顶层，新增产物 11 个逐项列全。

两个口径要标注，不是错：

1. `undo_entries: 6` 是「当前干跑能回滚的条数」（主批次 5 + MASS 第二步 1）。全链实际是 7 条动作——`-5c86` 那条要等 `-af4d` 撤完才可撤。我的独立干跑也是 6，数字对，但别理解成"这次整理一共 6 条记录"。
2. after 快照是 10:36:17 的。之后 `README.md` 又被改过（3,727→3,740 B，10:41:59），所以 `total_bytes_after: 41478308175` 现在盘上是 **41,478,308,188**，差 13 B。快照有时点，不是错；但如果 PDF 写"现在盘上 41,478,308,175 B"，就不准了。

### 盘上的 README.md：GB 列公式是错的（FAIL）

```powershell
node reading-tidy\review\tools\number-audit.mjs
```

6 行的 GB 值系统性偏大约 2.4%，用 `bytes / 1024^2 / 1000` 算的（把 1000 MiB 当 1 GB），不是 GiB：

| 行 | README 写 | 盘上实际 |
|---|--:|--:|
| 阅读 | 23.08 GB | **22.54 GiB** |
| 莫兰蒂作品 | 5.32 GB | **5.20 GiB** |
| 投标 | 2.82 GB | **2.75 GiB** |
| G构造 | 2.19 GB | **2.14 GiB** |
| 积累与学习 | 1.97 GB | **1.92 GiB** |
| 建筑构件特辑detail | 1.87 GB | **1.83 GiB** |

6/6 行都符合同一个错误公式，文件数列全对。同一份 README 顶上的「38.63 GB」又是对的 GiB（41,478,292,322/1024³）——同一份文档里两套口径。`before.md` 和 `before-after.md` 的 GiB 是对的，只有 README 错。**如果小红书 PDF 里放 README 截图，文案的 22.54 会和截图的 23.08 打架。**

### PDF 页面：数字基本对，四处文字要改

PDF 文件在我检查时不在盘上（Lead 正在重建，`build/png/*.png` 10:42 刚渲完），所以我核的是 `build/pages/p01–p09.html` + 读了 P1、P6 的渲染图（数字与 HTML 一致，`09 / 09`，9 页）。

对得上的：`53,481`、`49,301`（92%）、`38 GB`、`22,786`、`6.8 s`（before.md 记录的抓取耗时）、`503`、`71.9 MB`、`435 MB`/`376 MB`、`812 MB`、`1.26 GB`、`1789`、`13`、`7/7 读回核对`、`0 文件丢失`、`257`、`1 MB`、`22.54G`。P7 关于 EPERM 的写法是对的：ACE 确实存在（`icacls` 可以复现那条 `Everyone:(I)(CI)(DENY)(DC)`），但页面明说"做了受控试验、deny 不是原因"——这比硬凑因果诚实。顺带核实：现在 `icacls` 列出的全是 `(I)` 继承项，没有临时授的显式 FullControl，"权限回到原样"这句站得住。

要改的四处：

1. **P3「类型分布（图片 71%、文档 24%）」——盘上没有依据（FAIL）。** 我按 53,481 个文件复算：`other` 86.2%、image 7.0%、data 3.6%、document 2.1%、model3d 0.5%、script 0.5%。用插件自己的 `buildInventory(depth=-1, hashes=false)` 跑真盘是 image 10.0% / document 0.9%，而且 **truncated=true（只扫到 20,218 个文件就被 20,000 文件上限截断）**。我还试了工作区根、`阅读`、`投标` 三个根，没有一个是 71/24。真实情况反而更有意思：86.2% 的文件被归到 `other`，其中 **72.1%（38,578 个）根本没有扩展名**——莫兰蒂作品一个文件夹里就有 38,383 个无扩展名文件、2,681 个 `.old`、2,341 个 `.log`。这句要么删，要么换成"86% 的文件没有扩展名"。
2. **P1「53,481 个文件 · 19 个文件夹」**：19 是顶层**项**数，其中 2 个是散文件（`《WKW》.pdf`、`原画集.zip`），目录只有 17 个。改成「19 个顶层项」或「17 个文件夹 + 2 个散件」。
3. **P5「6 条计划，7 条成功移动」**：7 > 6，读起来像笔误。实情是 5 份计划文件、首份计划 6 条（5 成 1 败）、后来又补了两次单条计划，最终 7 条 ok。建议写「9 条计划，7 条成功」或「6 条计划里 5 条一次成」。
4. **P9「目录名越长越容易触发 ACL 问题」**：这句把 P7 特意否掉的因果又写回来了，而且盘上没有任何依据支持"名字长度"和 ACL 有关。建议改成「这个 ACL 问题只绕过、没根治」。
5. 次一级：`before-after.md` 说"14 个 `pip-*` / `edgeprofile` 临时目录"，实际 `.pdftmp` 顶层 14 个目录里只有 11 个是 `pip-*`/`edgeprofile`（10 + 1），另外 3 个是 `imgs/`、`imgs_probe/`、`pub/`——按体积算那 3 个才是大头（26.3 + 21.0 + 13.1 MB，而 edgeprofile 只有 4.8 MB，10 个 pip 目录全是 0 字节）。所以「71.9 MB 全是 pip 缓存 + Edge 临时 profile」这个说法在 journal 的 reason 里是错的（PDF P2 补了"外加一套拆书渲染"，好一些）。`.pdftmp` 主要在干一件事：拆书渲染（`build_book.py` 33,387 B、`render_book.py` 42,617 B、`huivang_*` 三份 37 万字节的 txt、8 张 `qa_*.png` 共 5.0 MB、23 个 py 脚本）。

---

## 四、FAIL 清单（就这四条）

1. **T17**：`manual` 允许改名受保护目录的子目录（`plugins/dsh-humanizer`）。本次真数据没受影响，插件对外发布前要修。
2. **README.md 的 GB 列**：6 行数错，公式是 `bytes/1024²/1000`。PDF 若截图会自相矛盾。
3. **PDF P3 的类型分布**：71%/24% 无法在盘上复现。
4. **P1 / P5 / P9 三处口径**：见上。

## 五、做不了 / 没做的

- `adversarial.mjs` 没跑：它会写 `folder-janitor/test/.adv`，超出我「只写 reading-tidy/review」的范围。
- EXDEV 跨盘分支在 manual 路径上已不可达（T13），这段代码现在没有集成测试覆盖。要测只能直接调 `moveEntry`（未导出）。
- PDF 文件最终版没解析：检查时 `build/阅读学习整理_2026-10-25.pdf` 不在盘上（重建中）。页面源（HTML/PNG）核过了。
- Windows 保留名（`CON`、`AUX`）没测：造出来可能删不掉，不值得在真机上冒这个险。
- 目录属主/ACL 的 EPERM 因果我没独立复现，只核实了 ACE 存在 + 事后没有残留显式授权。PDF 的写法（"没查清原因"）与我的证据不冲突。

## 附：证据文件

| 文件 | 内容 |
|---|---|
| `baseline.json` | 搬前逐文件清单（53,481 条路径+大小+mtime） |
| `baseline-hashes.json` | 搬前 800 个文件的 SHA-256（927,656,198 B） |
| `scratch-results.json` | manual 18 例逐条证据 + 被测代码指纹 |
| `verify-after.json` | 搬后 18 项对账明细（含日志链条、干跑、副本撤销） |
| `number-audit.json` | record/README 数字复算明细 |
| `tools/*.mjs` | 全部可重跑：`baseline` / `hash-targets` / `manual-matrix` / `verify-after` / `number-audit` |
