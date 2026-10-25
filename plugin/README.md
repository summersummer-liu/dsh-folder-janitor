# dsh-folder-janitor（文件夹管家）

整理混乱文件夹的 DSH 插件。把「收拾文件夹」拆成四步，每步都能停下来看：

```
folder_inventory  只读体检    →  看看里面到底有什么
folder_plan       只读计划    →  算出一份能看的移动清单
folder_apply      执行        →  按清单搬，边搬边记账
folder_undo       撤销        →  账本倒着走，回到原样
```

## 装到你自己电脑上

前提：你装了 DSH（DeepSeek Harness），版本 `>= 0.2.1-rc.2`。这不是独立软件，脱离 DSH 跑不起来。

**方式一：用发布包**

1. 下载 `dist/dsh-folder-janitor-0.2.0.zip`，解压到任意目录，比如 `D:\tools\dsh-folder-janitor`。
2. 在 DSH 里让我把这几个工具装进去，一句话就够：

   ```
   把这个目录装成插件：D:\tools\dsh-folder-janitor
   ```

   我背后执行的是 `plugin_manager install_bundle`，指向你解压出来的那个目录。
3. 如果装完工具没出现，把插件行 `include:dsh-folder-janitor` 关掉再打开，模块会重新加载。

**方式二：直接指目录**

克隆仓库，把 `plugin/` 那个目录当成本地插件包装进去，效果一样。

**验证装好了**：随便找个不重要的文件夹，说「先看看 `D:\某个文件夹` 里都有什么」。能返回一份体检报告，就是通了。

**卸载**：在设置 → 插件里关掉这一行，或者让我执行 `plugin_manager remove_bundle`。代码还在原地，随时能再装。

**换系统注意**：我只在 Windows 上实测过。macOS 和 Linux 的行为不一样（大小写敏感、权限模型不同），装上应该能跑，但撤销和改名这些边界分支没有验证过。

这四步不是流程洁癖。这套顺序是从真实事故里长出来的：以前直接一把梭 `mv`，半小时后想不起某个文件原来在哪；`README.md` 被顺手扫进 `documents/`，工作区约定就断了。所以现在把「读盘、算计划、动文件、记账」拆开，apply 之前必须有一份给用户看的清单。

## 从实际收拾里固化下来的规则

这些规则不是拍的，每一条都对应这个工作区里踩过的坑。

1. **先读盘，再动手。** 82 个散落文件的根目录，凭感觉分类必错。`folder_inventory` 先给出类型分布、重复组、草稿清单，再谈方案。
2. **只整理根目录散落文件，不碰已有项目文件夹。** `depth` 默认 1。`blender-tower/`、`rhino-work/` 这些是整理好的成果，进去翻等于破坏成果。需要递归时显式给 `depth=2` 或 `-1`。
3. **结构文件永远不动。** `README.md`、`AGENTS.md`、`WORKFLOW.md`、`LICENSE`、`package.json` 和所有 `.` 开头的隐藏文件，任何策略都绕开。挪走它们等于撕掉目录的说明书。
4. **草稿不删，进回收站。** `_build_dbg.js`、`~$draft.docx`、`.bak`、带「副本」的名字、0 字节文件，统一进 `_trash/<日期>/`，保留原来的相对路径，随时能捞回来。
5. **重名不覆盖。** 目标已存在就自动改名 `name (2).ext`；同内容的多余拷贝进 `_duplicates/<日期>/`。
6. **移动后回盘核对。** `rename` 返回成功不代表文件真在。apply 结束会逐个 stat 落点，`读回核对 21/21` 才是证据。
7. **每一次执行都可撤销。** 日志写在 `<root>/.folder-janitor/journals/`，撤销严格倒着走，只回滚还完好的文件（大小没变、原位置没被占），只删本次自己建的空目录。

## 算法：by-project 认名词，不认动词

`by-project` 从文件名里抠词聚类。词表改过两轮，因为第一版在真实根目录跑出了一堆 `build/`、`make/`、`check/`、`verify/` 目录 —— 那些是「脚本在干什么」的动词，不是「属于哪个项目」的名字。现在的规则：

- 动词（build/make/check/verify/extract/rasterize/…）和格式词（pdf/png/json/…）一律当噪声。
- 中文按汉字段切分，`2026年诺贝尔经济学奖学习手册` 会切成 `诺贝尔经济学奖学习手册`，跟 `_预览.pdf` 归到一组。
- 一个词至少在 2 个文件里出现才算候选；覆盖超过 60% 文件的词太泛，淘汰。
- 每个文件挂到它命中的最稀有那个词上；平手时偏向不含数字的词（`sphere` 胜过 `r600mm`）。
- 抠不出共同词的文件**留在原地**，报告里算「跳过」。宁可漏，不硬编。

## 策略

| strategy | 落到哪 | 什么时候用 |
|---|---|---|
| `by-type` | `documents/ images/ scripts/ data/ archives/ media/ fonts/ models/ misc/` | 默认。散落文件多、项目边界不清 |
| `by-date` | `2026-10/`、`2026-09/` | 按时间找东西（照片、下载、归档） |
| `by-project` | 项目名目录 | 文件名自带人名/作品名/项目代号 |
| `archive-old` | `archive/YYYY-MM/` | 只把 `older_than_days`（默认 180）之前的挪走 |
| `dedupe` | `_duplicates/<日期>/` | 只处理内容完全相同的文件，其余不动 |

横切开关：`junk`（默认开，`dedupe` 策略默认关）、`dedupe`（默认关）、`keep`、`ignore`、`quarantine_dir`、`duplicate_dir`。

## 用法

```
folder_inventory(root="D:\\path", depth=1)
folder_plan(root="D:\\path", strategy="by-type", depth=1)
folder_apply(plan="plan-20261025-100211-b046", root="D:\\path")          # 先 dry_run=true
folder_undo(target="journal-20261025-100223-d1de", root="D:\\path")
```

`folder_apply` 只认显式给的计划 id 或计划文件路径，没有「自动挑最新计划」这种省事但危险的默认值。`folder_undo` 的 target 可以是日志 id、日志路径，或计划 id（回滚该计划最近一次执行）。

## 目录约定

```
<root>/.folder-janitor/
  plans/plan-<时间戳>-<随机>.json      计划（每 40 份自动清最老的）
  journals/journal-<时间戳>-<随机>.json 执行日志（撤销就靠它）
<root>/_trash/<YYYY-MM-DD>/…          草稿与临时文件，保留原相对路径
<root>/_duplicates/<YYYY-MM-DD>/…     内容重复的多余拷贝
```

`.folder-janitor` 跟着被整理的文件夹走，换盘、拷走都还能撤销。

## 安全边界

- 所有路径 `path.resolve` 后必须仍在 root 内，越界直接失败（apply 和 undo 两边都查）。
- 只处理普通文件；符号链接、目录一律跳过并报告。
- **撤销要过三道检查**：目录身份（`.folder-janitor/id` 随机串，目录改名不影响，但同名新目录冒名会被识别）、目标仍是普通文件、内容没被动过（大小 + mtime，≤16MB 的文件再加 sha256）。任何一道不过就 refuse 并说明原因，宁可留着不还原。
- **执行前抢锁**：`.folder-janitor/lock` 用 `wx` 原子创建；同一目录不会有两个整理任务同时动文件。上次崩溃残留的锁要人工删。
- 状态目录创建失败（被同名文件占位、没权限）→ 动手前就拒绝执行，绝不出现「文件搬完了但没有账本」。
- 默认忽略 `node_modules`、`.git`、`__pycache__`、`dist`、`build`、`.venv` 等 30 多个依赖/缓存目录。想整理这类目录，把 root 直接指向它。
- `dry_run=true` 全程零写入（连目录都不建）。
- 文件被占用 / 没权限 / 目标 `(2)..(999)` 全被占 → 该条记 `failed` 并继续，不中断整批，日志照写。

## 已知限制

- `by-project` 只在文件名层聚类，不看内容，也不做中文分词：`斯卡帕_平面图.pdf` 和 `卡洛·斯卡帕学习手册.pdf` 的重叠词「斯卡帕」被后者整词吞掉，会分不到一组。文件名起得随便的目录，它宁愿不分组。
- 同一个原名被多次 apply 撞名后，只能撤销最近一次；更早的文件会以 `x (2).pdf` 留在目标目录里（不丢，但撤不干净）。
- 忽略目录表是固定的，还不能按次覆盖（`ignore` 只能加，不能减）。
- 跨盘移动走「复制 + 删源」，大文件会慢；同盘是原子 rename。
- Windows/macOS 大小写不敏感：同一目录里 `Photo.PNG` 与 `photo.png` 只能存在一个，第二个会被改名成 `photo (2).png`；撤销时如果原位置被「只差大小写」的同名文件占住，会明确报出来而不是悄悄跳过。
- 移动 20 万个文件的目录没试过，`MAX_FILES` 卡在 20000，超了会报告截断。

## 测试

```
node test/run.mjs          # 29 项主链路：不丢文件、不越界、不覆盖、dry-run 零写入、幂等、撤销逐字节还原
node test/edge.mjs         # 23 项抗打击：极端文件名、13 层嵌套同名、同尺寸改写后撤销、伪造越界日志、
                           #            目录身份不符、目标变目录、撞名耗尽、状态目录被占、并发执行、撤销预演零写入
node test/adversarial.mjs  # 140 项独立对抗（另一个 agent 写的）：撞名矩阵、计划过期、depth 语义、by-project 质量、
                           #            读句柄占用、junction、盘符根、异常名字。它自己造树在 test/.adv/
```

`test/edge.mjs` 里每个用例都对应一个真实出现过的 bug，不是装饰。三个套件全绿才算改完：`29 + 23 + 140`。

## 安装与更新

```
plugin_manager install_bundle target="<这个目录的绝对路径>"
```

插件是从工作区目录链接进 profile 的，所以**不要** import `@deepseek-ai/dsh-tools` 这类只在 dsh 安装目录里的包 —— 从工作区真实路径解析不到，整行会激活失败。工具定义是普通对象，`index.js` 里自己把参数简写转成 JSON Schema，插件零依赖。

改完代码要重新加载：`set_plugin` 把 `include:dsh-folder-janitor` 关掉再打开，模块会重新 import。改配置文件不需要重启 dsh。

## 这个工作区的实测记录（2026-10-25）

根目录 82 个散落文件 / 88.5 MB：

- 体检：脚本 39、文档 28、数据 9、图片 3、模型 3；8 个下划线草稿。
- `by-type` 计划：80 个待移动（`scripts` 38、`documents` 24、`_trash` 8、`data` 7、`models` 2、`images` 1），`AGENTS.md` / `WORKFLOW.md` 被识别为结构文件跳过。
- `by-project` 计划：36 个进 12 个项目组（`figs` 5、`formula` 5、`lab` 4、`sketchup` 4、`article` 3、`edge` 3、`sphere` 2、`style` 2、`斯卡帕学习手册` 2、`萨克雷社区中心` 2、`诺贝尔经济学奖学习手册` 2、`重返提帕萨` 2），46 个抠不出项目词、留在原地。

结论：这个根目录的散落文件是各任务的**遗留脚本**，不是一个项目 —— `by-type` 比 `by-project` 更接近「找得到」。
