// iPhone HEIC 照片 → JPG。
// fixtures/grid-2x2-rot90.heic：和 iPhone 一样的结构（4 个隐藏的 hvc1 小块 + grid 主图 + irot 旋转 90°），
// 原图 1440×1000，转正后应是 1000×1440。由 fixtures/make-heic-grid.mjs 生成（再加 irot）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { heicToJpeg, isHeic, locateFfmpeg, ffmpegCandidates } from '../src/media.mjs';
import { createUploads, classify } from '../src/uploads.mjs';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'grid-2x2-rot90.heic');
const quiet = { warn() {} };

/** 读 JPEG 的 SOF 段拿宽高。 */
function jpegSize(buf) {
  let p = 2;
  while (p < buf.length) {
    const marker = buf[p + 1];
    const len = buf.readUInt16BE(p + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return { h: buf.readUInt16BE(p + 5), w: buf.readUInt16BE(p + 7) };
    p += 2 + len;
  }
  return null;
}

test('HEIC 识别', () => {
  assert.ok(isHeic('IMG_1234.HEIC'));
  assert.ok(isHeic('a.heif'));
  assert.ok(!isHeic('a.jpg'));
  assert.equal(classify('IMG_1234.HEIC'), 'image');
});

test('ffmpeg 查找：手填路径优先；自动查找包含 PATH 和常见位置', () => {
  assert.equal(locateFfmpeg({ override: 'Z:\\no\\ffmpeg.exe', exists: () => false }), null);
  assert.equal(locateFfmpeg({ override: 'C:\\x\\ffmpeg.exe', exists: () => true }), 'C:\\x\\ffmpeg.exe');
  const list = ffmpegCandidates({ PATH: 'P', DUAL_CHAT_FFMPEG: 'E:\\ff.exe' });
  assert.equal(list[0], 'E:\\ff.exe');
  assert.ok(list.some((f) => /runtime[\\/]ffmpeg/.test(f)), '一键安装放的 runtime/ffmpeg 也在候选里');
});

test('转换分两步：先完整转出，再缩小；缩小失败退回完整图', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dual-heic-'));
  const calls = [];
  const fakeRun = async (_ff, args) => {
    calls.push(args);
    const out = args.at(-1);
    if (args.includes('-vf')) return { code: 1, stderr: 'scale failed' };
    await writeFile(out, 'JPEGDATA');
    return { code: 0, stderr: '' };
  };
  const res = await heicToJpeg({ ffmpeg: 'ffmpeg', input: 'in.heic', output: join(dir, 'out.jpg'), run: fakeRun });
  assert.equal(res.ok, true);
  assert.equal(calls.length, 2);
  assert.ok(!calls[0].includes('-vf'), '第一步不能带 -vf（网格图内部已用复杂滤镜）');
  assert.equal(await readFile(join(dir, 'out.jpg'), 'utf8'), 'JPEGDATA');

  const fail = await heicToJpeg({ ffmpeg: 'ffmpeg', input: 'x', output: join(dir, 'bad.jpg'), run: async () => ({ code: 1, stderr: 'line1\nInvalid data found' }) });
  assert.equal(fail.ok, false);
  assert.match(fail.error, /Invalid data/);
});

test('上传 HEIC：没有 ffmpeg 时给出明确提示', async () => {
  const up = createUploads({ root: await mkdtemp(join(tmpdir(), 'dual-heic-up-')), log: quiet, getFfmpeg: () => null });
  await assert.rejects(up.save({ name: 'IMG_1.HEIC', buffer: Buffer.from('x') }), (e) => e.status === 422 && /ffmpeg/.test(e.message));
});

test('上传 HEIC：转成 JPG 存储，保留原名，标记来源', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dual-heic-up2-'));
  const convertHeic = async ({ output }) => {
    await writeFile(output, Buffer.alloc(1234));
    return { ok: true };
  };
  const up = createUploads({ root, log: quiet, getFfmpeg: () => 'ffmpeg.exe', convertHeic });
  const meta = await up.save({ name: 'IMG_0420.HEIC', buffer: Buffer.from('heic') });
  assert.equal(meta.name, 'IMG_0420.HEIC');
  assert.equal(meta.file, 'IMG_0420.jpg');
  assert.equal(meta.kind, 'image');
  assert.equal(meta.mime, 'image/jpeg');
  assert.equal(meta.size, 1234);
  assert.equal(meta.convertedFrom, 'HEIC');
  assert.ok(up.absPath(meta).endsWith('IMG_0420.jpg'), 'Codex 的 --image 和 Claude 的 Read 都用 JPG');
});

const ffmpeg = locateFfmpeg();
test('真实 ffmpeg：iPhone 式网格 HEIC 拼接 + 旋转转正 + 缩小', { skip: !ffmpeg && '本机没有 ffmpeg' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dual-heic-real-'));
  const big = join(dir, 'big.jpg');
  assert.equal((await heicToJpeg({ ffmpeg, input: FIXTURE, output: big })).ok, true);
  assert.deepEqual(jpegSize(await readFile(big)), { w: 1000, h: 1440 }, '4 块拼成完整图，并按旋转标记转成竖图');

  const small = join(dir, 'small.jpg');
  assert.equal((await heicToJpeg({ ffmpeg, input: FIXTURE, output: small, maxSide: 720 })).ok, true);
  assert.deepEqual(jpegSize(await readFile(small)), { w: 500, h: 720 }, '最长边缩到上限，比例不变');
});
