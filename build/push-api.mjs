// 走 GitHub REST API 推提交：本机连不上 github.com:443，但 api.github.com 通。
// 等价于 git push：blob → tree → commit → ref，外加空仓库时先建初始分支。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const GH = 'C:\\Users\\summer\\AppData\\Local\\dsh-tools\\gh\\bin\\gh.exe';
const OWNER = 'summersummer-liu';
const REPO = 'dsh-folder-janitor';
const ROOT = 'D:\\deepseek-harness\\default-workspace\\reading-tidy';
const MESSAGE = [
  '文件夹整理实录：38.63 GB / 53,481 个文件的断舍离',
  '',
  '- docs/: 9 页竖版图文（PDF + PNG），可直接发小红书',
  '- plugin/: dsh-folder-janitor v0.1.0 源码快照（体检/清单/执行/撤销四个工具）',
  '- record/: 整理前后数据、时间线、数字汇总',
  '- review/: 独立审核记录',
  '- xhs/: 文案方案',
  '',
  '6 条计划、7 次成功移动、0 文件丢失；唯一失手的改名用两步绕行完成。',
].join('\n');

const token = execFileSync(GH, ['auth', 'token'], { encoding: 'utf8' }).trim();
const tracked = execFileSync('git', ['-c', 'core.quotepath=false', '-C', ROOT, 'ls-files'], {
  encoding: 'utf8',
})
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean);

const present = [];
for (const rel of tracked) {
  try {
    await fs.access(path.join(ROOT, rel));
    present.push(rel);
  } catch {
    /* 已被删掉，跳过 */
  }
}
console.log(`git 跟踪 ${tracked.length} 个文件，磁盘上还在 ${present.length} 个`);

async function api(method, endpoint, body) {
  const res = await fetch(`https://api.github.com${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'dsh-folder-janitor-push',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${endpoint} -> ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

// 空仓库不能让 Git Data API 建 blob（409），先提交 README 把 main 建出来
let baseCommit = null;
try {
  const ref = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/main`);
  baseCommit = ref.object?.sha ?? null;
  console.log('已有 main：', String(baseCommit).slice(0, 8));
} catch {
  const readme = await fs.readFile(path.join(ROOT, 'README.md'));
  const created = await api('PUT', `/repos/${OWNER}/${REPO}/contents/README.md`, {
    message: 'init: README',
    content: readme.toString('base64'),
    branch: 'main',
  });
  baseCommit = created.commit.sha;
  console.log('空仓库，已建初始提交：', baseCommit.slice(0, 8));
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

console.log('上传 blob…');
const shas = await mapLimit(present, 6, async (rel) => {
  const bytes = await fs.readFile(path.join(ROOT, rel));
  const { sha } = await api('POST', `/repos/${OWNER}/${REPO}/git/blobs`, {
    content: bytes.toString('base64'),
    encoding: 'base64',
  });
  process.stdout.write('.');
  return { path: rel.split(path.sep).join('/'), sha };
});
console.log('');

const tree = await api('POST', `/repos/${OWNER}/${REPO}/git/trees`, {
  tree: shas.map((s) => ({ path: s.path, mode: '100644', type: 'blob', sha: s.sha })),
});
console.log('tree', tree.sha.slice(0, 8));

const commit = await api('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
  message: MESSAGE,
  tree: tree.sha,
  parents: baseCommit ? [baseCommit] : [],
});
console.log('commit', commit.sha.slice(0, 8));

await api('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/main`, {
  sha: commit.sha,
  force: true,
});
console.log(`完成：https://github.com/${OWNER}/${REPO}`);
