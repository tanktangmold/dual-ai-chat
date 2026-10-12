// 附件：拖拽 / 粘贴截图 / 点 📎 选文件 → 上传 → 输入框上方显示小卡片，发送时带上附件 ID。
import { esc, t, formatSize, fileIcon, uploadUrl } from './ui.js';

export const MAX_FILES = 8;
export const MAX_MB = 25;
export const ACCEPT = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.heif', '.pdf', '.docx', '.xlsx', '.xlsm', '.pptx',
  '.txt', '.md', '.csv', '.tsv', '.json', '.jsonl', '.xml', '.html', '.htm', '.yaml', '.yml', '.log', '.ini', '.toml',
  '.js', '.mjs', '.ts', '.tsx', '.jsx', '.vue', '.py', '.java', '.c', '.h', '.cpp', '.cs', '.go', '.rs', '.php', '.rb',
  '.sh', '.ps1', '.bat', '.sql', '.css', '.scss', '.kt', '.swift', '.srt', '.vtt'
].join(',');

const kindOf = (name, type) => {
  if (/^image\//.test(type) || /\.(png|jpe?g|gif|webp|heic|heif)$/i.test(name)) return 'image';
  if (/\.pdf$/i.test(name)) return 'pdf';
  if (/\.(docx|xlsx|xlsm|pptx)$/i.test(name)) return 'office';
  return 'text';
};

const pad = (n) => String(n).padStart(2, '0');
function screenshotName(type) {
  const d = new Date();
  const ext = type === 'image/jpeg' ? 'jpg' : (type.split('/')[1] || 'png');
  return `${t('attach.screenshot')}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${ext}`;
}

const canvasToBlob = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));

/** 大图在浏览器里先缩到最长边 2400px（截图保持 PNG 清晰；仍超 3.5MB 再转 JPEG），省模型的读图时间。 */
export async function shrinkImage(file, { maxSide = 2400, maxBytes = 3.5 * 1024 * 1024 } = {}) {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return file;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= maxBytes) {
    bitmap.close?.();
    return file;
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  let blob = await canvasToBlob(canvas, file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.9);
  if (blob && blob.size > maxBytes) blob = await canvasToBlob(canvas, 'image/jpeg', 0.88);
  if (!blob || blob.size >= file.size) return file;
  const name = blob.type === 'image/jpeg' ? file.name.replace(/\.(png|webp)$/i, '.jpg') : file.name;
  return new File([blob], name, { type: blob.type });
}

/**
 * @param listEl 卡片容器
 * @param upload async (file) => meta
 * @param onChange () => void   列表或状态变化时回调（用来刷新发送按钮）
 * @param toast (msg, isError) => void
 */
export function createAttachmentTray({ listEl, upload, onChange, toast }) {
  let items = [];
  let seq = 0;

  const setItems = (next) => {
    items = next;
    render();
    onChange?.();
  };
  const patch = (key, fields) => setItems(items.map((it) => (it.key === key ? { ...it, ...fields } : it)));

  function chip(it) {
    const thumb = it.preview ? `<img src="${esc(it.preview)}" alt="">` : `<span class="att-icon">${fileIcon(it.kind, it.name)}</span>`;
    const sub = it.status === 'uploading'
      ? `<span class="spin small"></span>${esc(t('attach.uploading'))}`
      : it.status === 'error'
        ? esc(t('attach.failed', { error: it.error }))
        : esc([formatSize(it.size), it.meta?.convertedFrom ? t('attach.converted') : '', it.meta?.textChars ? t('attach.textChars', { n: it.meta.textChars }) : '', it.meta?.pages ? t('attach.pages', { n: it.meta.pages }) : ''].filter(Boolean).join(' · '));
    return `<div class="att-chip ${it.status}" data-key="${it.key}" title="${esc(it.name)}">
      <span class="att-thumb">${thumb}</span>
      <span class="att-info"><span class="att-name">${esc(it.name)}</span><span class="att-sub">${sub}</span></span>
      <button type="button" class="att-x" data-remove="${it.key}" aria-label="${esc(t('attach.remove'))}" title="${esc(t('attach.remove'))}">✕</button>
    </div>`;
  }

  function render() {
    listEl.hidden = items.length === 0;
    listEl.innerHTML = items.map(chip).join('');
  }

  async function addOne(raw) {
    const named = raw.name && raw.name !== 'image.png' ? raw : new File([raw], screenshotName(raw.type || 'image/png'), { type: raw.type || 'image/png' });
    if (named.size > MAX_MB * 1024 * 1024) {
      toast(t('attach.tooBig', { name: named.name, mb: MAX_MB }), true);
      return;
    }
    const kind = kindOf(named.name, named.type);
    const key = `a${(seq += 1)}`;
    // 浏览器显示不了 HEIC：先不预览，等服务端转成 JPG 后用那张
    const previewable = /^image\/(png|jpeg|gif|webp)$/.test(named.type) || /\.(png|jpe?g|gif|webp)$/i.test(named.name);
    const preview = kind === 'image' && previewable ? URL.createObjectURL(named) : '';
    setItems([...items, { key, name: named.name, size: named.size, kind, status: 'uploading', preview, meta: null, error: '' }]);
    try {
      const file = kind === 'image' ? await shrinkImage(named) : named;
      const meta = await upload(file);
      if (!items.some((it) => it.key === key)) return; // 上传途中被移除了
      const current = items.find((it) => it.key === key);
      patch(key, { status: 'done', meta, size: meta.size, preview: current?.preview || (meta.kind === 'image' ? uploadUrl(meta) : '') });
    } catch (err) {
      if (items.some((it) => it.key === key)) patch(key, { status: 'error', error: err.message });
    }
  }

  listEl.addEventListener('click', (e) => {
    const key = e.target.closest('[data-remove]')?.dataset.remove;
    if (!key) return;
    const gone = items.find((it) => it.key === key);
    if (gone?.preview?.startsWith('blob:')) URL.revokeObjectURL(gone.preview);
    setItems(items.filter((it) => it.key !== key));
  });

  return {
    add(fileList) {
      const files = [...(fileList ?? [])];
      const room = MAX_FILES - items.length;
      if (files.length > room) toast(t('attach.max', { n: MAX_FILES }), true);
      files.slice(0, Math.max(0, room)).forEach(addOne);
    },
    ids: () => items.filter((it) => it.status === 'done').map((it) => it.meta.id),
    busy: () => items.some((it) => it.status === 'uploading'),
    count: () => items.length,
    clear() {
      items.forEach((it) => it.preview?.startsWith('blob:') && URL.revokeObjectURL(it.preview));
      setItems([]);
    },
    rerender: render
  };
}

/** 整个窗口接受拖入文件；任何地方 Ctrl+V 截图/文件都加为附件（纯文字粘贴不受影响）。 */
export function bindDropAndPaste({ overlay, onFiles }) {
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  const hide = () => {
    depth = 0;
    overlay.hidden = true;
  };

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth += 1;
    overlay.hidden = false;
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth -= 1;
    if (depth <= 0) hide();
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    hide();
    if (e.dataTransfer.files?.length) onFiles(e.dataTransfer.files);
  });
  document.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (!files.length) return;
    // 从 Word / Excel 复制文字时剪贴板里还会附带一张渲染图：有文字就让文字正常贴进去
    const text = e.clipboardData.getData('text/plain');
    if (text.trim() && files.every((f) => f.type.startsWith('image/'))) return;
    e.preventDefault();
    onFiles(files);
  });
}
