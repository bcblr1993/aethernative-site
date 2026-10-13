import type { ui } from './i18n';

type Copy = (typeof ui)['zh' | 'en']['feedback']['screenshots'];
export interface ScreenshotLink { id: string; url: string }
const MAX_COUNT = 3;
const MAX_SOURCE = 10 * 1024 * 1024;
const MAX_STORED = 512 * 1024;

/** 解码再绘制，去除原始元数据；限制长边，优先保留截图文字的清晰度。 */
async function compress(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 80_000_000) throw new Error('image');
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas');
    const encode = (quality: number) => new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('encode')), 'image/webp', quality);
    });
    for (let attempt = 0; attempt < 5; attempt++) {
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await encode(attempt === 0 ? 0.92 : 0.8);
      if (blob.size <= MAX_STORED) return blob;
      canvas.width = Math.max(1, Math.round(canvas.width * 0.8));
      canvas.height = Math.max(1, Math.round(canvas.height * 0.8));
    }
    throw new Error('size');
  } finally { bitmap.close(); }
}

export function setupScreenshots(root: HTMLElement, copy: Copy) {
  const input = root.querySelector<HTMLInputElement>('[data-screenshot-input]')!;
  const add = root.querySelector<HTMLButtonElement>('[data-screenshot-add]')!;
  const previews = root.querySelector<HTMLElement>('[data-screenshot-previews]')!;
  const count = root.querySelector<HTMLElement>('[data-screenshot-count]')!;
  const message = root.querySelector<HTMLElement>('[data-screenshot-message]')!;
  let images: { blob: Blob; url: string }[] = [];
  let processing = false;
  let locked = false;
  let generation = 0;

  const render = () => {
    previews.replaceChildren();
    count.textContent = `${images.length} / ${MAX_COUNT}`;
    input.disabled = add.disabled = processing || locked || images.length === MAX_COUNT;
    root.setAttribute('aria-busy', String(processing));
    images.forEach((image, index) => {
      const tile = document.createElement('div');
      tile.className = 'screenshot-tile';
      const link = document.createElement('a');
      link.href = image.url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.title = copy.view(index + 1);
      const img = document.createElement('img');
      img.src = image.url;
      img.alt = copy.view(index + 1);
      link.append(img);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'screenshot-remove';
      remove.textContent = '×';
      remove.setAttribute('aria-label', copy.remove(index + 1));
      remove.disabled = processing || locked;
      remove.addEventListener('click', () => {
        URL.revokeObjectURL(image.url);
        images.splice(index, 1);
        message.textContent = '';
        render();
        add.focus();
      });
      tile.append(link, remove);
      previews.append(tile);
    });
  };

  async function select(files: File[]) {
    if (!files.length || processing || locked) return;
    if (images.length + files.length > MAX_COUNT) { message.textContent = copy.tooMany; return; }
    if (files.some((f) => !['image/png', 'image/jpeg', 'image/webp'].includes(f.type))) {
      message.textContent = copy.typeError; return;
    }
    if (files.some((f) => !f.size || f.size > MAX_SOURCE)) { message.textContent = copy.sizeError; return; }
    const current = generation;
    processing = true;
    message.textContent = copy.processing;
    render();
    try {
      // 顺序压缩，避免同时解码多张大图的内存峰值；这一批全部成功再加入。
      const blobs: Blob[] = [];
      for (const file of files) blobs.push(await compress(file));
      if (current !== generation) return;
      images.push(...blobs.map((blob) => ({ blob, url: URL.createObjectURL(blob) })));
      message.textContent = '';
    } catch {
      if (current === generation) message.textContent = copy.failed;
    } finally {
      if (current === generation) { processing = false; render(); }
    }
  }

  add.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { void select([...input.files ?? []]); input.value = ''; });
  root.addEventListener('dragover', (event) => { event.preventDefault(); if (!locked) root.classList.add('is-dragging'); });
  root.addEventListener('dragleave', (event) => {
    if (!root.contains(event.relatedTarget as Node | null)) root.classList.remove('is-dragging');
  });
  root.addEventListener('drop', (event) => {
    event.preventDefault();
    root.classList.remove('is-dragging');
    void select([...event.dataTransfer?.files ?? []]);
  });
  const clear = () => {
    generation++;
    images.forEach((image) => URL.revokeObjectURL(image.url));
    images = [];
    processing = false;
    input.value = '';
    message.textContent = '';
    render();
  };
  window.addEventListener('pagehide', clear);
  render();
  return {
    clear,
    get busy() { return processing || locked; },
    lock(value: boolean) { locked = value; render(); },
    error() { message.textContent = copy.failed; add.focus(); },
    append(data: FormData) {
      images.forEach(({ blob }, index) => data.append('screenshots', blob, `screenshot-${index + 1}.${blob.type === 'image/webp' ? 'webp' : 'png'}`));
    },
  };
}

export function screenshotGallery(images: ScreenshotLink[] | undefined, label: (n: number) => string) {
  const gallery = document.createElement('div');
  gallery.className = 'screenshot-gallery';
  for (const [index, image] of (images ?? []).entries()) {
    const link = document.createElement('a');
    // 只从服务端 ID 生成同源路径，避免 API 内容引入任意 URL。
    link.href = `/api/feedback/screenshots/${encodeURIComponent(image.id)}`;
    link.target = '_blank';
    link.rel = 'noopener';
    link.title = label(index + 1);
    const img = document.createElement('img');
    img.src = link.href;
    img.alt = label(index + 1);
    img.loading = 'lazy';
    link.append(img);
    gallery.append(link);
  }
  return gallery;
}
