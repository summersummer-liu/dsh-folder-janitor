// dsh-folder-janitor —— 把「我平时怎么收拾文件夹」固化成四个工具：
// 先体检（只读），再出计划（只读），执行要显式点名计划，最后每一步都能倒着撤销。
//
// 这套顺序不是装饰：收拾这个工作区时反复踩同一个坑 —— 直接 mv 一把梭，
// 半小时后想不起某个文件原来在哪。所以这里把「读盘、算计划、动文件、记账」
// 拆成四个不可跳步的动作，并且 apply 之前必须有一份用户可以看的清单。

import path from 'node:path';
import fs from 'node:fs/promises';

import { buildInventory } from './lib/scan.js';
import { buildPlan, STRATEGIES, STRATEGY_LABELS } from './lib/plan.js';
import { applyPlan, undoJournal } from './lib/apply.js';
import { renderApply, renderInventory, renderPlan, renderUndo } from './lib/format.js';
import {
  listJournals,
  loadJournalById,
  loadJournalByPath,
  loadPlanById,
  loadPlanByPath,
  looksLikePath,
} from './lib/store.js';

export const name = 'dsh-folder-janitor';
export const inject = ['tools'];

const TEXT_OUTPUT = { schema: { type: 'object', additionalProperties: true } };

// 刻意不 import `@deepseek-ai/dsh-tools`：这个插件是从工作区目录链接进 profile 的，
// 从那里的真实路径解析不到 dsh 安装目录里的包，一 import 整行就激活失败。
// ToolDefinition 本身就是普通对象，参数简写转成 JSON Schema 只要这几行。
function toJsonSchema(parameters = {}) {
  const properties = {};
  const required = [];
  for (const [key, spec] of Object.entries(parameters)) {
    const { required: isRequired, ...rest } = spec;
    properties[key] = rest;
    if (isRequired) required.push(key);
  }
  const schema = { type: 'object', properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

function tool({ name, description, parameters, output, execute, timeoutMs }) {
  return {
    name,
    description,
    parameters: toJsonSchema(parameters),
    output: { schema: output.schema, render: output.render },
    execute,
    ...(timeoutMs ? { timeoutMs } : {}),
  };
}

function resolveRoot(base, raw) {
  const value = String(raw ?? '').trim();
  if (!value) throw new Error('缺少 root：要整理的目录（可以用绝对路径，或相对于当前工作目录）');
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(base, value);
}

async function assertDirectory(root) {
  let stat;
  try {
    stat = await fs.stat(root);
  } catch {
    throw new Error(`目录不存在: ${root}`);
  }
  if (!stat.isDirectory()) throw new Error(`不是目录: ${root}`);
}

/** 计划 id 和日志 id 长得像，先按前缀分派，再回退成路径。 */
async function loadJournalAny(root, target) {
  const value = String(target ?? '').trim();
  if (!value) throw new Error('缺少 target：日志 id、日志路径或计划 id');
  if (looksLikePath(value)) return loadJournalByPath(path.isAbsolute(value) ? value : path.resolve(root, value));
  if (value.startsWith('journal-')) return loadJournalById(root, value);
  if (value.startsWith('plan-')) {
    const ids = await listJournals(root);
    for (const id of ids.slice().reverse()) {
      const journal = await loadJournalById(root, id);
      if (journal.planId === value) return journal;
    }
    throw new Error(`计划 ${value} 还没有执行记录，没有可撤销的东西`);
  }
  // 只给了半截 id：当作日志 id 的前缀去匹配最近一条
  const ids = await listJournals(root);
  const hit = ids.slice().reverse().find((id) => id.includes(value));
  if (hit) return loadJournalById(root, hit);
  throw new Error(`找不到目标 ${value}：既不是日志 id，也不是计划 id`);
}

export function apply(ctx) {
  const workingDirectory = ctx.get('workingDirectory');
  const baseDir = () => workingDirectory?.defaultDirectory ?? process.cwd();

  ctx.tools.register(
    tool({
      name: 'folder_inventory',
      description:
        '只读体检一个目录：文件数与体积、类型分布、主要扩展名、临时草稿和空文件、内容完全重复的组（含可回收空间）、被忽略的依赖目录，最后给出推荐的整理策略。不改动任何文件。' +
        '用户说「这文件夹太乱了」「先看看里面有什么」「帮我整理一下」时，第一步永远跑它：拿到报告和建议，再决定用哪种策略。' +
        'depth 语义：1=只看根目录散落文件（默认），2=含一层子目录，-1=全部递归。',
      parameters: {
        root: { type: 'string', required: true, description: '要体检的目录；绝对路径，或相对当前工作目录。' },
        depth: { type: 'number', description: '遍历深度，1=只根目录（默认）、2=含一层子目录、-1=不限。' },
        hashes: { type: 'boolean', description: '是否算内容哈希找重复文件，默认 true。目录很大时设 false 更快。' },
      },
      output: { ...TEXT_OUTPUT, render: (_args, value) => renderInventory(value) },
      timeoutMs: 180000,
      execute: async (args) => {
        const root = resolveRoot(baseDir(), args.root);
        await assertDirectory(root);
        const depth = Number.isFinite(Number(args.depth)) ? Math.trunc(Number(args.depth)) : 1;
        return buildInventory(root, {
          maxDepth: depth === 0 ? 1 : depth,
          hashes: args.hashes !== false,
        });
      },
    }),
  );

  ctx.tools.register(
    tool({
      name: 'folder_plan',
      description:
        '把整理方案算成一份可复核的移动清单，但不移动任何文件；清单写入 <root>/.folder-janitor/plans/。' +
        '策略：by-type 按类型分到 documents/images/scripts/data/archives/media/fonts/models/misc；by-date 按修改月份分到 2026-10 这样的目录；' +
        'by-project 从文件名提取共享词（人名/作品名/项目代号）把同一项目的文件归到一个子目录，提不出共同词的文件保持不动；archive-old 只把超过 older_than_days 的旧文件挪进 archive/YYYY-MM/；dedupe 只处理内容重复的文件，其余不动；' +
        'manual 不套任何策略，只执行 items 里逐条列出的 from → to（可移动/重命名文件和目录，目录整体搬，逐条校验不越界、不碰联接、目标存在就拒绝、不自动合并）。' +
        '默认只整理根目录散落文件（depth=1），不碰已有项目文件夹；junk=true 把下划线草稿、.bak/.tmp、0 字节文件收进 _trash/<日期>/；dedupe=true 顺带把重复文件收进 _duplicates/。' +
        'README、AGENTS.md、WORKFLOW.md、LICENSE、package.json 和所有隐藏文件默认保持原位（挪走它们等于撕掉目录的说明书）。' +
        '出计划后必须先把示例和跳过原因给用户看，得到同意才 apply。',
      parameters: {
        root: { type: 'string', required: true, description: '要整理的目录；绝对路径，或相对当前工作目录。' },
        strategy: {
          type: 'string',
          enum: STRATEGIES,
          required: true,
          description: `整理策略：${STRATEGIES.map((s) => `${s}（${STRATEGY_LABELS[s]}）`).join('、')}。`,
        },
        depth: { type: 'number', description: '遍历深度，1=只根目录（默认）、2=含一层子目录、-1=不限。' },
        older_than_days: { type: 'number', description: 'archive-old 用的天数门槛，默认 180。' },
        junk: { type: 'boolean', description: '是否把草稿/临时/空文件收进回收目录，默认 true（dedupe 策略默认 false）。' },
        dedupe: { type: 'boolean', description: '是否顺带把内容重复的文件收进重复目录，默认 false。' },
        quarantine_dir: { type: 'string', description: '回收目录名，默认 _trash。' },
        duplicate_dir: { type: 'string', description: '重复文件目录名，默认 _duplicates。' },
        ignore: { type: 'array', items: { type: 'string' }, description: '额外忽略的文件名/目录名（追加在默认忽略名单后面）。' },
        keep: {
          type: 'array',
          items: { type: 'string' },
          description:
            '额外保护的文件名（精确名，或 *.md 这样的后缀通配）。README/AGENTS/WORKFLOW/LICENSE/package.json 与所有隐藏文件默认已保护，不会被移动。',
        },
        items: {
          type: 'array',
          description:
            'manual 策略专用：逐条列出要执行的动作，如 [{"from":"attachment_123","to":"知末_素材","reason":"改名"}]。路径写相对于 root 的相对路径。',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              from: { type: 'string', description: '现有文件/目录的相对路径' },
              to: { type: 'string', description: '目标相对路径（同目录改名也写完整路径）' },
              reason: { type: 'string', description: '这条为什么动，会写进计划里给人看' },
            },
          },
        },
      },
      output: { ...TEXT_OUTPUT, render: (_args, value) => renderPlan(value) },
      timeoutMs: 180000,
      execute: async (args) => {
        const root = resolveRoot(baseDir(), args.root);
        const strategy = String(args.strategy ?? 'by-type');
        if (!STRATEGIES.includes(strategy)) {
          throw new Error(`未知策略 ${strategy}，可用：${STRATEGIES.join(' / ')}`);
        }
        const { plan, file } = await buildPlan({
          root,
          strategy,
          options: {
            depth: args.depth,
            junk: args.junk,
            dedupe: args.dedupe,
            olderDays: args.older_than_days,
            quarantineDir: args.quarantine_dir,
            duplicateDir: args.duplicate_dir,
            ignore: args.ignore,
            keep: args.keep,
            items: args.items,
          },
        });
        return { ...plan, planPath: file };
      },
    }),
  );

  ctx.tools.register(
    tool({
      name: 'folder_apply',
      description:
        '执行一份已经生成并核对过的计划：按清单真正移动文件，写撤销日志到 <root>/.folder-janitor/journals/，移动后重新读盘核对每个落点。' +
        '必须显式给出 plan（计划 id，或计划文件的绝对路径），不会自动挑「最新计划」；dry_run=true 只演练、不改磁盘。' +
        '重名不覆盖：内容相同的改名并存，内容不同的自动加 (2)。执行完把 moved/skipped/failed、失败原因和撤销命令一起交代给用户。',
      parameters: {
        plan: { type: 'string', required: true, description: '计划 id（plan-…）或计划文件绝对路径。' },
        root: { type: 'string', description: 'plan 只给 id 时用来定位 <root>/.folder-janitor；给绝对路径时可省略。' },
        dry_run: { type: 'boolean', description: 'true=只报告将要发生的移动，不动磁盘；默认 false。' },
      },
      output: { ...TEXT_OUTPUT, render: (_args, value) => renderApply(value) },
      timeoutMs: 180000,
      execute: async (args) => {
        const planArg = String(args.plan ?? '').trim();
        if (!planArg) throw new Error('缺少 plan：给计划 id 或计划文件路径');
        let plan;
        if (looksLikePath(planArg)) {
          plan = await loadPlanByPath(path.isAbsolute(planArg) ? planArg : path.resolve(baseDir(), planArg));
        } else {
          if (!args.root) throw new Error('plan 只给了 id，还需要 root 才能找到 plans 目录');
          const root = resolveRoot(baseDir(), args.root);
          await assertDirectory(root);
          plan = await loadPlanById(root, planArg);
        }
        if (plan.entries.length > 0) await assertDirectory(plan.root);
        return applyPlan(plan, { dryRun: args.dry_run === true });
      },
    }),
  );

  ctx.tools.register(
    tool({
      name: 'folder_undo',
      description:
        '按撤销日志严格倒着回滚一次整理：只恢复仍然完好（大小没变、原位置没被占）的文件，改过的跳过并说明；只删本次整理自己新建且已空的目录。' +
        'target 可以是日志 id（journal-…）、日志文件路径，或计划 id（回滚该计划最近一次执行）。不确定撤哪次时，先看 folder_apply 输出里的「后悔药」那行。',
      parameters: {
        target: { type: 'string', required: true, description: '日志 id、日志路径，或计划 id。' },
        root: { type: 'string', description: 'target 只给 id 时用来定位 <root>/.folder-janitor。' },
        dry_run: { type: 'boolean', description: 'true=只报告会恢复哪些，不动磁盘。' },
      },
      output: { ...TEXT_OUTPUT, render: (_args, value) => renderUndo(value) },
      timeoutMs: 180000,
      execute: async (args) => {
        const target = String(args.target ?? '').trim();
        const byPath = looksLikePath(target);
        let root;
        if (args.root) {
          root = resolveRoot(baseDir(), args.root);
        } else if (byPath) {
          root = null; // 日志里自带 root
        } else {
          throw new Error('target 只给了 id，还需要 root 才能找到 journals 目录');
        }
        const journal = await loadJournalAny(root ?? baseDir(), target);
        return undoJournal(journal, { dryRun: args.dry_run === true });
      },
    }),
  );
}
