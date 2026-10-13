export const SCREENSHOT_LIMITS = { count: 3, bytes: 512 * 1024 } as const;
export interface Screenshot { mime: string; data: Uint8Array<ArrayBuffer> }

/** 只接受栅格图片，核对实际文件签名而不是信任扩展名或上传 MIME。 */
export function imageMime(data: Uint8Array): string | null {
  const starts = (...bytes: number[]) => bytes.every((b, i) => data[i] === b);
  if (data.length >= 33 && starts(137, 80, 78, 71, 13, 10, 26, 10) &&
      String.fromCharCode(...data.slice(12, 16)) === 'IHDR') return 'image/png';
  if (data.length >= 4 && starts(255, 216, 255) && data.at(-2) === 255 && data.at(-1) === 217) return 'image/jpeg';
  if (data.length >= 30 && String.fromCharCode(...data.slice(0, 4)) === 'RIFF' &&
      String.fromCharCode(...data.slice(8, 12)) === 'WEBP' &&
      ['VP8 ', 'VP8L', 'VP8X'].includes(String.fromCharCode(...data.slice(12, 16)))) return 'image/webp';
  return null;
}

export async function readScreenshots(entries: (File | string)[]): Promise<Screenshot[] | null> {
  if (entries.length > SCREENSHOT_LIMITS.count) return null;
  const screenshots: Screenshot[] = [];
  for (const entry of entries) {
    if (typeof entry === 'string' || !entry.size || entry.size > SCREENSHOT_LIMITS.bytes) return null;
    const data = new Uint8Array(await entry.arrayBuffer());
    const mime = imageMime(data);
    if (!mime || mime !== entry.type) return null;
    screenshots.push({ mime, data });
  }
  return screenshots;
}

/** 在读取流时限制大小，不依赖可缺失或伪造的 Content-Length。 */
export async function boundedBody(request: Request, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (Number(request.headers.get('Content-Length')) > max) return null;
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  return body;
}
