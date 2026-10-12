import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { collectFiles, buildZip, INCLUDE } from '../scripts/pack.mjs';
import { candidatesFor, npmRoots, APP_ROOT } from '../src/cli/locate.mjs';
import { ffmpegCandidates, pythonCandidates } from '../src/media.mjs';
import { join } from 'node:path';

/** 读回 zip 的中央目录：[{ name, flags, method, data }] */
function readZip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const dataStart = local + 30 + buf.readUInt16LE(local + 26);
    const raw = buf.subarray(dataStart, dataStart + csize);
    out.push({ name, flags, method, data: method === 8 ? inflateRawSync(raw) : raw });
    p += 46 + nameLen;
  }
  return out;
}

test('打包白名单：不含对话数据、运行环境、测试和 git', () => {
  const names = collectFiles().map((f) => f.name);
  assert.ok(names.includes('dual-ai-chat/server.mjs'));
  for (const f of ['install.bat', 'start.vbs', 'INSTALL.txt', 'INSTALL.zh-CN.txt', 'INSTALL.ja.txt', 'LICENSE', 'README.md', 'README.zh-CN.md', 'README.ja.md']) {
    assert.ok(names.includes(`dual-ai-chat/${f}`), `缺少 ${f}`);
  }
  assert.ok(names.includes('dual-ai-chat/public/app.ico'));
  assert.ok(names.includes('dual-ai-chat/scripts/install.ps1'));
  for (const bad of ['/data/', '/runtime/', '/tests/', '/.git/', '/dist/', 'live-check', 'settings.json']) {
    assert.ok(!names.some((n) => n.includes(bad)), `不该打包：${bad}`);
  }
  assert.ok(!INCLUDE.includes('data'));
});

test('zip 读写一致，中文文件名带 UTF-8 标记', () => {
  const entries = [
    { name: 'dual-ai-chat/一键安装.bat', data: Buffer.from('@echo off\r\n') },
    { name: 'dual-ai-chat/src/a.mjs', data: Buffer.from('x'.repeat(5000)) }
  ];
  const back = readZip(buildZip(entries));
  assert.deepEqual(back.map((e) => e.name), entries.map((e) => e.name));
  assert.ok(back.every((e) => e.flags & 0x0800));
  assert.equal(back[1].method, 8, '可压缩的文件用 deflate');
  assert.equal(back[1].data.toString(), 'x'.repeat(5000));
  assert.equal(back[0].data.toString(), '@echo off\r\n');
});

test('安装器和启动器的编码：ps1 带 BOM（PowerShell 5.1 才能读对中文），bat 纯 ASCII', async () => {
  const { readFile } = await import('node:fs/promises');
  const ps1 = await readFile(join(APP_ROOT, 'scripts', 'install.ps1'));
  assert.deepEqual([...ps1.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const bat = await readFile(join(APP_ROOT, 'install.bat'));
  assert.ok([...bat].every((b) => b < 0x80), 'bat 里不能有非 ASCII（日文/中文系统的代码页不同）');
  assert.match(bat.toString(), /scripts\\install\.ps1/);
  const vbs = await readFile(join(APP_ROOT, 'start.vbs'));
  assert.ok([...vbs].every((b) => b < 0x80), 'vbs 里不能有非 ASCII');
});

test('一键安装放在 runtime 里的 CLI / ffmpeg / Python 都能被找到', () => {
  const env = { APPDATA: 'C:\\Users\\x\\AppData\\Roaming', PATH: '' };
  assert.ok(npmRoots(env).includes(join(APP_ROOT, 'runtime', 'npm')));
  assert.ok(candidatesFor('claude', { env, fsApi: { readdirSync: () => [] } }).includes(join(APP_ROOT, 'runtime', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')));
  const fakeFs = { readdirSync: (dir) => (dir.endsWith('@openai') ? ['codex', 'codex-win32-x64'] : dir.endsWith('vendor') ? ['x86_64-pc-windows-msvc'] : []) };
  const codex = candidatesFor('codex', { env, fsApi: fakeFs });
  assert.ok(codex.some((f) => f.startsWith(join(APP_ROOT, 'runtime', 'npm')) && f.endsWith(join('bin', 'codex.exe'))));
  assert.ok(ffmpegCandidates({ PATH: '' }).includes(join(APP_ROOT, 'runtime', 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')));
  const py = pythonCandidates({ PATH: ['C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps', 'C:\\Py'].join(process.platform === 'win32' ? ';' : ':') });
  assert.ok(py.includes(join(APP_ROOT, 'runtime', 'python', process.platform === 'win32' ? 'python.exe' : 'python3')));
  assert.ok(!py.some((f) => /WindowsApps/.test(f)), '应用商店那个假 python 不算');
});
