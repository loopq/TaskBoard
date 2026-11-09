import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { api, fileUrl } from './api';

marked.use({ gfm: true, breaks: true });

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
  if (node.tagName === 'IMG') {
    node.setAttribute('src', fileUrl(node.getAttribute('src') ?? ''));
    node.setAttribute('loading', 'lazy');
  }
});

/** Markdown → 安全 HTML。DOMPurify 是 XSS 防线（<script>、onerror= 等全部剥掉），不可省 */
export const renderMd = (md: string) => DOMPurify.sanitize(marked.parse(md, { async: false }));

const LONG_EDGE = 1920;
const toBlob = (c: HTMLCanvasElement, type: string) => new Promise<Blob | null>((r) => c.toBlob(r, type, 0.85));

/**
 * 压缩：长边 ≤ 1920，优先 webp。iOS Safari 的 canvas 不支持编码 webp（会悄悄返回 png），
 * 这时退回 jpeg。先铺白底，透明 png 转 jpeg 不会变黑。
 * 已知天花板：经过 canvas 后 GIF 动图只保留第一帧。
 */
async function compress(file: Blob): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, LONG_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const webp = await toBlob(canvas, 'image/webp');
    if (webp?.type === 'image/webp') return webp;
    const jpeg = await toBlob(canvas, 'image/jpeg');
    if (!jpeg) throw new Error('图片压缩失败');
    return jpeg;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 返回可直接写进 Markdown 的地址（/files/...） */
export async function uploadImage(file: Blob) {
  const { url } = await api<{ url: string }>('POST', '/upload', await compress(file));
  return url;
}
