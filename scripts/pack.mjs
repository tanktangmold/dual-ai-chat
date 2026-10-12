/**
 * 打包给别人用：npm run pack → dist/dual-ai-chat-v<版本>.zip（GitHub Release 的附件也用它）
 *
 * 只打包白名单里的程序文件。你的对话、附件、报告（data/）、下载的运行环境（runtime/）、测试、git 都不会进去。
 * 自己写 zip（不依赖第三方）：文件名设 UTF-8 标记，中文文件名在 Windows 资源管理器 / 7-Zip 里都不乱码。
 */
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { deflateRawSync, crc32 } from 'node:zlib';
import { join, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOP = 'dual-ai-chat';

/** 打包白名单：目录会递归。 */
export const INCLUDE = Object.freeze([
  'server.mjs', 'package.json', 'LICENSE', 'README.md', 'README.zh-CN.md', 'README.ja.md',
  'INSTALL.txt', 'INSTALL.zh-CN.txt', 'INSTALL.ja.txt', 'install.bat', 'start.vbs',
  'src', 'public', 'docs', 'scripts/install.ps1', 'scripts/extract_text.py'
]);
const SKIP = /(^|[\\/])(\.DS_Store|Thumbs\.db|desktop\.ini)$|\.tmp$/i;

function walk(path) {
  const st = statSync(path);
  if (st.isFile()) return SKIP.test(path) ? [] : [path];
  return readdirSync(path).flatMap((name) => walk(join(path, name)));
}

export function collectFiles(root = ROOT) {
  return INCLUDE.flatMap((entry) => walk(join(root, entry)))
    .map((abs) => ({ abs, name: `${TOP}/${relative(root, abs).split(sep).join('/')}` }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function dosTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/** entries: [{ name, data: Buffer, mtime: Date }] → zip Buffer */
export function buildZip(entries) {
  const UTF8 = 0x0800;
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, mtime = new Date() } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const crc = crc32(data);
    const { time, day } = dosTime(mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8, 6);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

function main() {
  const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const files = collectFiles();
  const zip = buildZip(files.map((f) => ({ name: f.name, data: readFileSync(f.abs), mtime: statSync(f.abs).mtime })));
  const outDir = join(ROOT, 'dist');
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `dual-ai-chat-v${version}.zip`);
  writeFileSync(out, zip);
  console.log(`已打包 ${files.length} 个文件 → ${out}（${(zip.length / 1024).toFixed(0)} KB）`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
