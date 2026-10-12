/**
 * 附件：保存到 data/workspace/uploads/<id>/（就在两个 CLI 的工作目录里，模型可以按相对路径读到），
 * 上传时就把文字提取好（文本直接解码，PDF/Office 交给 scripts/extract_text.py），提问时直接用。
 *
 * 每个上传目录：<原名清洗后>、meta.json、extracted.txt（有文字时）、page-N.png（扫描版 PDF）。
 */
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { localStamp } from './dates.mjs';
import { i18nError } from './i18n.mjs';
import { heicToJpeg, isHeic } from './media.mjs';

const HELPER = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'extract_text.py');

export const UPLOAD_LIMITS = Object.freeze({ fileMB: 25, perTurn: 8, textChars: 200_000, extractMs: 90_000 });
export const UPLOAD_ID_RE = /^u_\d{8}-\d{6}_[0-9a-f]{6}$/;

const EXT = Object.freeze({
  image: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.heif'],
  pdf: ['.pdf'],
  office: ['.docx', '.xlsx', '.xlsm', '.pptx'],
  text: [
    '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.xml', '.html', '.htm', '.yaml', '.yml', '.log', '.ini',
    '.toml', '.env', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.py', '.java', '.c', '.h', '.cpp', '.cs', '.go',
    '.rs', '.php', '.rb', '.sh', '.ps1', '.bat', '.sql', '.css', '.scss', '.kt', '.swift', '.srt', '.vtt'
  ]
});

const MIME = Object.freeze({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.pdf': 'application/pdf'
});

export function classify(name) {
  const ext = extname(String(name ?? '')).toLowerCase();
  return Object.keys(EXT).find((kind) => EXT[kind].includes(ext)) ?? null;
}

export const mimeOf = (name) => MIME[extname(String(name ?? '')).toLowerCase()] ?? 'application/octet-stream';

/** 去掉路径分隔符、Windows 保留字符和 cmd.exe 元字符；保留中日文；限长 80。 */
export function safeFileName(name) {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .replace(/[\u0000-\u001f<>:"|?*%^&!]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim();
  const ext = extname(cleaned).slice(0, 10);
  const stem = cleaned.slice(0, cleaned.length - ext.length).slice(0, 70) || 'file';
  return `${stem}${ext}`;
}

/** 文本解码：BOM → UTF-8 → Shift_JIS（楽天 CSV）→ GB18030 → latin1。 */
export function decodeText(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  for (const encoding of ['utf-8', 'shift_jis', 'gb18030']) {
    try {
      return new TextDecoder(encoding, { fatal: true, ignoreBOM: false }).decode(bytes);
    } catch {
      // 换下一种编码
    }
  }
  return new TextDecoder('latin1').decode(bytes);
}

function runHelper({ python, file, outDir, timeoutMs }) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(python, [HELPER, file, outDir], {
        windowsHide: true,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
      });
    } catch (err) {
      resolve({ error: err.message });
      return;
    }
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.resume();
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ error: err.code === 'ENOENT' ? 'python-missing' : err.message });
    });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(out.trim().split('\n').pop() || '{}'));
      } catch {
        resolve({ error: 'bad-output' });
      }
    });
  });
}

/** 对外暴露的元数据（不含服务器路径）。 */
export const publicMeta = (m) => ({
  id: m.id, name: m.name, file: m.file, kind: m.kind, mime: m.mime, size: m.size,
  textChars: m.textChars, pages: m.pages, scanPages: m.scanPages.length, convertedFrom: m.convertedFrom ?? ''
});

/**
 * @param getFfmpeg () => ffmpeg 路径或 null —— 每次上传时取，设置里改了路径立即生效
 * @param convertHeic / extract 可注入，方便测试
 */
export function createUploads({
  root,
  log = console,
  python = process.env.DUAL_CHAT_PYTHON || 'python',
  extract = runHelper,
  getFfmpeg = () => null,
  convertHeic = heicToJpeg
}) {
  const base = join(root, 'uploads');
  let cache = new Map();

  const dirOf = (id) => join(base, id);

  async function extractText(kind, file, dir, buffer) {
    if (kind === 'text') return { text: decodeText(buffer), pages: 0, images: [] };
    if (kind === 'image') return { text: '', pages: 0, images: [] };
    const res = await extract({ python, file, outDir: dir, timeoutMs: UPLOAD_LIMITS.extractMs });
    if (res.error) {
      log.warn?.(`[uploads] 提取文字失败 ${file}：${res.error}`);
      return { text: '', pages: 0, images: [], error: res.error };
    }
    return { text: String(res.text ?? ''), pages: Number(res.pages) || 0, images: Array.isArray(res.images) ? res.images.map(safeFileName) : [] };
  }

  return {
    dir: base,

    async save({ name, buffer }) {
      const kind = classify(name);
      if (!kind) throw i18nError(415, 'err.fileType', { name: String(name).slice(0, 60) });
      if (!buffer?.length) throw i18nError(400, 'err.fileEmpty');
      if (buffer.length > UPLOAD_LIMITS.fileMB * 1024 * 1024) throw i18nError(413, 'err.fileSize', { name, mb: UPLOAD_LIMITS.fileMB });

      const heic = isHeic(name);
      const ffmpeg = heic ? getFfmpeg() : null;
      if (heic && !ffmpeg) throw i18nError(422, 'err.heicNoFfmpeg', { name });

      const id = `u_${localStamp()}_${randomBytes(3).toString('hex')}`;
      const original = safeFileName(name);
      const dir = dirOf(id);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, original), buffer);

      // iPhone 照片：转成 JPG，之后预览、Claude 的 Read、Codex 的 --image 都用这张
      let file = original;
      let size = buffer.length;
      if (heic) {
        file = `${original.slice(0, original.length - extname(original).length)}.jpg`;
        const res = await convertHeic({ ffmpeg, input: join(dir, original), output: join(dir, file) });
        if (!res.ok) {
          log.warn?.(`[uploads] HEIC 转换失败 ${name}：${res.error}`);
          throw i18nError(422, 'err.heicFailed', { name, error: res.error });
        }
        size = (await stat(join(dir, file))).size;
      }

      const extracted = await extractText(kind, join(dir, file), dir, buffer);
      const text = extracted.text.slice(0, UPLOAD_LIMITS.textChars);
      if (text.trim()) await writeFile(join(dir, 'extracted.txt'), text, 'utf8');

      const meta = Object.freeze({
        id,
        name: String(name).slice(0, 200),
        file,
        kind,
        mime: kind === 'image' || kind === 'pdf' ? mimeOf(file) : 'application/octet-stream',
        size,
        convertedFrom: heic ? 'HEIC' : '',
        createdAt: new Date().toISOString(),
        textChars: text.trim() ? text.length : 0,
        pages: extracted.pages,
        scanPages: Object.freeze(extracted.images),
        extractError: extracted.error ?? ''
      });
      await writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
      cache = new Map(cache).set(id, meta);
      return meta;
    },

    async get(id) {
      if (!UPLOAD_ID_RE.test(String(id ?? ''))) return null;
      if (cache.has(id)) return cache.get(id);
      try {
        const meta = Object.freeze(JSON.parse(await readFile(join(dirOf(id), 'meta.json'), 'utf8')));
        cache = new Map(cache).set(id, meta);
        return meta;
      } catch {
        return null;
      }
    },

    async textOf(meta) {
      if (!meta?.textChars) return '';
      try {
        return await readFile(join(dirOf(meta.id), 'extracted.txt'), 'utf8');
      } catch {
        return '';
      }
    },

    /** 模型工作目录里的相对路径（正斜杠，Claude 的 Read 权限规则按它匹配）。 */
    relPath: (meta, file = meta.file) => `uploads/${meta.id}/${file}`,
    absPath: (meta, file = meta.file) => join(dirOf(meta.id), file)
  };
}
