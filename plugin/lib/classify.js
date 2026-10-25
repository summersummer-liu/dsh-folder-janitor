// 纯函数层：类型归类、垃圾判定、项目词提取、显示格式化。
// 刻意不碰 I/O，这样可以直接 `node --test` 跑，不用起 harness。

// ---------------------------------------------------------------- 类型 -> 文件夹

const EXT_CATEGORY = new Map();

function add(category, exts) {
  for (const ext of exts) EXT_CATEGORY.set(ext, category);
}

add('document', [
  'pdf', 'doc', 'docx', 'rtf', 'odt', 'pages', 'tex', 'epub', 'mobi', 'azw3',
  'md', 'txt', 'html', 'htm', 'ppt', 'pptx', 'key', 'odp', 'xps', 'djvu',
]);
add('image', [
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tif', 'tiff', 'heic',
  'avif', 'ico', 'psd', 'ai', 'eps', 'raw', 'cr2', 'nef',
]);
add('script', [
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'ps1', 'sh', 'bash',
  'bat', 'cmd', 'lua', 'pl', 'php', 'r', 'java', 'c', 'h', 'cpp', 'hpp', 'cs',
  'go', 'rs', 'swift', 'kt', 'dart', 'scss', 'css', 'less', 'vue', 'svelte',
]);
add('data', [
  'json', 'jsonl', 'ndjson', 'csv', 'tsv', 'xls', 'xlsx', 'ods', 'numbers',
  'parquet', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'xml', 'sql', 'db',
  'sqlite', 'sqlite3', 'sav', 'npy', 'npz', 'pkl', 'pickle', 'h5', 'dat',
]);
add('archive', ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'iso', 'dmg']);
add('media', ['mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'flv', 'm4v', 'mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg']);
add('font', ['ttf', 'otf', 'woff', 'woff2', 'eot']);
add('model3d', [
  'blend', 'skp', 'skb', '3dm', '3ds', 'obj', 'fbx', 'stl', 'glb', 'gltf',
  'usd', 'usda', 'usdc', 'usdz', 'ply', 'step', 'stp', 'iges', 'igs',
  'dwg', 'dxf', 'ifc', 'rvt', 'gh',
]);

/** 分类默认落点文件夹。用英文小写，跟这个工作区已有的 figs/notes/source 风格一致。 */
export const CATEGORY_FOLDERS = {
  document: 'documents',
  image: 'images',
  script: 'scripts',
  data: 'data',
  archive: 'archives',
  media: 'media',
  font: 'fonts',
  model3d: 'models',
  other: 'misc',
};

export const CATEGORY_LABELS = {
  document: '文档',
  image: '图片',
  script: '脚本',
  data: '数据',
  archive: '压缩包',
  media: '影音',
  font: '字体',
  model3d: '模型',
  other: '其他',
};

export function extOf(name) {
  const base = name.toLowerCase();
  const i = base.lastIndexOf('.');
  // 没有点，或点在最前面（.gitignore 这类），都算没有扩展名
  if (i <= 0 || i === base.length - 1) return '';
  return base.slice(i + 1);
}

export function categoryOf(name) {
  return EXT_CATEGORY.get(extOf(name)) ?? 'other';
}

// ---------------------------------------------------------------- 垃圾判定
//
// 只判「可以安全进回收站（_trash）」的东西，判据来自真实收拾过的现场：
// 下划线开头的中间脚本、Office 锁文件、.bak/.tmp、带 copy/副本 的名字、0 字节。
// 任何规则命中都只进 _trash，不删除，用户随时能捞回来。

const JUNK_RULES = [
  { id: 'office-lock', reason: 'Office 临时锁文件', test: (n) => n.startsWith('~$') },
  { id: 'scratch-prefix', reason: '下划线开头的草稿或中间产物', test: (n) => n.startsWith('_') },
  {
    id: 'temp-ext',
    reason: '.tmp / .bak / .log 之类的临时备份',
    test: (n) => /\.(tmp|temp|bak|old|orig|log|crdownload|part|download)$/i.test(n),
  },
  {
    id: 'copy-suffix',
    reason: '文件名带 copy / 副本 / (2) 的重复拷贝',
    test: (n) =>
      /(^|[\s._-])(copy|副本)([\s._-]*\d*)?(\.[^.]+)?$/i.test(n) || /\s\(\d+\)(\.[^.]+)?$/.test(n),
  },
  { id: 'empty', reason: '0 字节空文件', test: () => true, sizeIsZero: true },
];

/** @returns {{id: string, reason: string} | null} */
export function junkOf(name, size) {
  for (const rule of JUNK_RULES) {
    if (rule.sizeIsZero) {
      if (size === 0) return { id: rule.id, reason: rule.reason };
      continue;
    }
    if (rule.test(name, size)) return { id: rule.id, reason: rule.reason };
  }
  return null;
}

// 这些目录不进去：进了一个是收拾不完，另一个是进去就等于破坏别人装好的环境。
export const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'venv', 'env',
  '.cache', '.next', '.nuxt', '.turbo', '.parcel-cache', 'dist', 'build', 'out',
  'target', '.idea', '.vscode', '.gradle', '.terraform', '.pnpm-store',
  'site-packages', '.pytest_cache', '.mypy_cache', '.ruff_cache', 'coverage',
  '$RECYCLE.BIN', 'System Volume Information', '.folder-janitor',
]);

export const IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

// 结构文件：挪走它们等于把目录的说明书撕了。
// AGENTS.md / WORKFLOW.md 是这个工作区每次开工都要读的约定文件，
// README/LICENSE/.gitignore 是任何目录的固定零件。隐藏文件同理，一律不动。
const STRUCTURE_FILES = new Set([
  'readme.md', 'readme', 'readme.txt', 'readme.rst',
  'agents.md', 'claude.md', 'workflow.md', 'contributing.md',
  'changelog.md', 'license', 'license.md', 'license.txt',
  'makefile', 'dockerfile', 'package.json', 'pnpm-workspace.yaml',
  'tsconfig.json', 'cordis.yml', 'cordis.patch.yml', '.env', '.env.example',
]);

export function isStructuralFile(name, extraKeep = []) {
  const low = String(name).toLowerCase();
  if (low.startsWith('.')) return true;
  if (STRUCTURE_FILES.has(low)) return true;
  return extraKeep.some((pattern) => {
    const p = String(pattern).toLowerCase();
    if (p.startsWith('*.')) return low.endsWith(p.slice(1));
    if (p.endsWith('*')) return low.startsWith(p.slice(0, -1));
    return low === p;
  });
}

// ---------------------------------------------------------------- 项目词
//
// by-project 的核心：从文件名里抠出「看起来是项目名」的词，靠共词把文件聚类。
// 收拾这个工作区时反复出现的情况：nobel-2026-*.md、斯卡帕_*.pdf、重返提帕萨_*.html
// 这种同一项目的文件共用一个人名/作品名。
//
// 词表是踩坑踩出来的：最早只停用 copy/final/page，结果在工作区根目录跑出
// build/ make/ check/ verify/ rasterize/ 一堆目录 —— 那些是「脚本在干什么」的动词，
// 不是「属于哪个项目」的名字。动词和格式词一律当噪声，只信名词。

const STOPWORDS = new Set([
  // 通用占位词
  'copy', 'final', 'new', 'old', 'test', 'tests', 'tmp', 'temp', 'draft',
  'backup', 'index', 'main', 'app', 'page', 'pages', 'img', 'image', 'images',
  'file', 'files', 'untitled', 'readme', 'output', 'result', 'results', 'data',
  'document', 'preview', 'version', 'update', 'sample', 'demo', 'x', 'src',
  // 只说明「动作」的动词：它们出现在的文件分属不同项目
  'build', 'make', 'check', 'checks', 'verify', 'analysis', 'analyze', 'analyse',
  'extract', 'rasterize', 'diff', 'clean', 'parse', 'fetch', 'download', 'render',
  'crop', 'inspect', 'export', 'convert', 'generate', 'run', 'setup', 'install',
  'diag', 'print', 'draw', 'save', 'load', 'merge', 'split', 'join',
  'script', 'scripts', 'tool', 'tools', 'util', 'utils', 'helper', 'copy2',
  'fixed', 'log', 'logs', 'text', 'plan', 'notes', 'screenshot',
  'report', 'reports', 'summary', 'list', 'item', 'items', 'misc', 'other',
  // 月份：2026-March-report 里的 march 不是项目名
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  // 格式词：文件名里到处都是，跟项目无关
  'pdf', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'docx', 'doc', 'xlsx', 'xls',
  'pptx', 'html', 'htm', 'json', 'csv', 'txt', 'md', 'zip', 'mp4', 'py', 'js',
  // 中文占位
  '新建', '副本', '未命名', '文档', '文件', '图片', '预览', '输出', '结果', '表格',
]);

const HAN = /\p{Script=Han}/u;
const HAN_RUN = /\p{Script=Han}+/gu;
const LATIN_RUN = /[A-Za-z][A-Za-z0-9]*/g;

/** 把一个文件名词干拆成候选项目词。保持确定性：同样的名字永远给同样的输出。 */
export function tokensOf(stem) {
  const spaced = stem
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  const parts = spaced.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const out = [];

  for (const part of parts) {
    // 中文和拉丁混排的段（2026年诺贝尔经济学奖学习手册、Sphere_R600mm）要拆开看，
    // 否则一整段既不是纯中文也不是纯英文，两边都会被丢掉。
    const chunks = [];
    if (HAN.test(part) && !/^\p{Script=Han}+$/u.test(part)) {
      chunks.push(...(part.match(HAN_RUN) ?? []));
      chunks.push(...(part.match(LATIN_RUN) ?? []));
    } else {
      chunks.push(part);
    }

    for (const chunk of chunks) {
      if (HAN.test(chunk)) {
        // 去掉开头的日期标记：2026年诺贝尔经济学奖… 里抠出来的段会带一个「年」
        const trimmed = chunk.replace(/^[年月日号]+/, '');
        if (trimmed.length >= 2 && trimmed.length <= 24 && !STOPWORDS.has(trimmed)) out.push(trimmed);
        continue;
      }
      const low = chunk.toLowerCase();
      if (STOPWORDS.has(low)) continue;
      if (/^\d+$/.test(low)) continue;
      if (/^[0-9a-f]{6,}$/.test(low)) continue; // 长得像哈希/时间戳
      if (/^[a-z][a-z0-9]*$/.test(low) && low.length >= 3) out.push(low);
    }
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------- 格式化

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function humanBytes(bytes) {
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(value)} B`;
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${UNITS[unit]}`;
}

export function pad2(value) {
  return String(value).padStart(2, '0');
}

/** 本地时区的 YYYY-MM，按修改时间分桶时用。 */
export function yearMonth(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

export function dayStamp(ms = Date.now()) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function idStamp(ms = Date.now()) {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/** 把任意字符串变成 Windows/macOS/Linux 都能用的单段目录名。 */
export function safeSegment(raw, fallback = 'group') {
  let name = String(raw ?? '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .trim();
  if (name.length > 60) name = name.slice(0, 60).trim();
  if (!name || RESERVED.has(name.toLowerCase())) name = fallback;
  return name;
}

/** 目标已存在时的备选名：name (2).ext / name (3).ext … */
export function siblingName(name, n) {
  const i = name.lastIndexOf('.');
  if (i <= 0) return `${name} (${n})`;
  return `${name.slice(0, i)} (${n})${name.slice(i)}`;
}
