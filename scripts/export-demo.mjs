/**
 * 把一个演示用数据目录（真实提问录下来的对话）导出到 demo/，给 GitHub Pages 在线体验版回放。
 *   node scripts/export-demo.mjs <数据目录>
 *
 * - 只导出 conversations/ 里的对话（不含 trash），去掉 CLI 会话 ID。
 * - 对比报告复制到 demo/reports/，附件原件复制到 demo/uploads/<id>/file.<扩展名>（静态托管用 ASCII 文件名）。
 * - 千万别拿日常使用的 data/ 来导出：那里是你的真实对话。
 */
import { readFileSync, readdirSync, mkdirSync, writeFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'demo');

export function cleanConversation(conv, renameFile) {
  const { sessions, ...rest } = conv;
  return {
    ...rest,
    turns: conv.turns.map((turn) => ({
      ...turn,
      attachments: (turn.attachments ?? []).map((a) => ({ ...a, file: renameFile(a) }))
    }))
  };
}

function main() {
  const dataDir = process.argv[2] && resolve(process.argv[2]);
  if (!dataDir || !existsSync(join(dataDir, 'conversations'))) {
    console.error('用法：node scripts/export-demo.mjs <演示数据目录>（里面要有 conversations/）');
    process.exit(1);
  }
  if (resolve(dataDir) === resolve(ROOT, 'data')) {
    console.error('拒绝导出 data/：那是日常使用的真实对话。请用单独的演示实例录制。');
    process.exit(1);
  }

  for (const sub of ['reports', 'uploads']) rmSync(join(OUT, sub), { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const files = readdirSync(join(dataDir, 'conversations')).filter((f) => f.endsWith('.json'));
  const conversations = [];
  for (const name of files) {
    const conv = JSON.parse(readFileSync(join(dataDir, 'conversations', name), 'utf8'));
    const renameFile = (a) => {
      const target = `file${extname(a.file || a.name).toLowerCase()}`;
      const src = join(dataDir, 'workspace', 'uploads', a.id, a.file);
      if (existsSync(src)) {
        mkdirSync(join(OUT, 'uploads', a.id), { recursive: true });
        copyFileSync(src, join(OUT, 'uploads', a.id, target));
      }
      return target;
    };
    const clean = cleanConversation(conv, renameFile);
    for (const turn of clean.turns) {
      const report = turn.comparison?.report;
      if (!report) continue;
      const src = join(dataDir, 'reports', report);
      if (!existsSync(src)) throw new Error(`报告不存在：${src}`);
      mkdirSync(dirname(join(OUT, 'reports', report)), { recursive: true });
      copyFileSync(src, join(OUT, 'reports', report));
    }
    conversations.push(clean);
  }
  conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  writeFileSync(join(OUT, 'data.json'), JSON.stringify({ exportedAt: new Date().toISOString(), conversations }, null, 2));
  console.log(`已导出 ${conversations.length} 段对话 → ${OUT}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
