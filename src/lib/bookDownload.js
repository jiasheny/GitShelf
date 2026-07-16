const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(([^)\n]+)\)/g;
const HTML_IMAGE_RE = /<img\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1[^>]*>/gi;

function splitDestination(value) {
  const trimmed = String(value || '').trim();
  if (trimmed.startsWith('<')) {
    const closing = trimmed.indexOf('>');
    if (closing > 0) {
      return {
        source: trimmed.slice(1, closing),
        suffix: trimmed.slice(closing + 1),
      };
    }
  }

  const match = trimmed.match(/^(\S+)([\s\S]*)$/);
  return {
    source: match?.[1] || '',
    suffix: match?.[2] || '',
  };
}

function normalizeImagePath(source, bookId) {
  let value = String(source || '').trim().replace(/\\/g, '/');
  if (!value || value.startsWith('/') || value.startsWith('#') || value.startsWith('//')) {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;

  value = value.split(/[?#]/, 1)[0];
  const escapedBookId = String(bookId || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    /^(?:\.\.\/|\.\/)*images\/(.+)$/i,
    new RegExp(`^(?:\\.\\.\\/|\\.\\/)*books/${escapedBookId}/images/(.+)$`, 'i'),
  ];
  const match = patterns.map((pattern) => value.match(pattern)).find(Boolean);
  if (!match) return null;

  const relative = match[1].replace(/^\/+/, '');
  const segments = relative.split('/');
  if (!relative || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    return null;
  }
  return relative;
}

function htmlAltText(tag) {
  const match = tag.match(/\balt\s*=\s*(["'])(.*?)\1/i);
  return match?.[2]?.trim() || '';
}

export function mergeChapterMarkdown(chapterTexts) {
  const parts = chapterTexts.map((text) => String(text || '').trim()).filter(Boolean);
  return `${parts.join('\n\n---\n\n')}\n`;
}

export function createTextOnlyMarkdown(markdown) {
  return String(markdown || '')
    .replace(MARKDOWN_IMAGE_RE, (_full, alt) => String(alt || '').trim())
    .replace(HTML_IMAGE_RE, (full) => htmlAltText(full))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd() + '\n';
}

export function prepareMarkdownWithImages(markdown, bookId) {
  const imagePaths = new Set();
  let rewritten = String(markdown || '').replace(
    MARKDOWN_IMAGE_RE,
    (full, alt, destination) => {
      const { source, suffix } = splitDestination(destination);
      const path = normalizeImagePath(source, bookId);
      if (!path) return full;
      imagePaths.add(path);
      return `![${alt}](images/${path}${suffix})`;
    },
  );

  rewritten = rewritten.replace(HTML_IMAGE_RE, (full, quote, source) => {
    const path = normalizeImagePath(source, bookId);
    if (!path) return full;
    imagePaths.add(path);
    return full.replace(`${quote}${source}${quote}`, `${quote}images/${path}${quote}`);
  });

  return { markdown: rewritten, imagePaths: [...imagePaths] };
}

export function bookImageUrl(bookId, imagePath) {
  const encodedBookId = encodeURIComponent(bookId);
  const encodedPath = imagePath.split('/').map(encodeURIComponent).join('/');
  return `./books/${encodedBookId}/images/${encodedPath}`;
}

export async function fetchBookImages(bookId, imagePaths, onProgress = () => {}) {
  const images = new Map();
  let nextIndex = 0;
  let completed = 0;
  const workerCount = Math.min(6, imagePaths.length);

  async function worker() {
    while (nextIndex < imagePaths.length) {
      const path = imagePaths[nextIndex];
      nextIndex += 1;
      const response = await fetch(bookImageUrl(bookId, path));
      if (!response.ok) throw new Error(`Failed to download image: ${path} (${response.status})`);
      images.set(path, new Uint8Array(await response.arrayBuffer()));
      completed += 1;
      onProgress(completed, imagePaths.length);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return images;
}

export async function createBookZip(markdown, filename, images) {
  const { strToU8, zipSync } = await import('fflate');
  const files = {
    [`${filename}.md`]: new Uint8Array(strToU8(markdown)),
  };
  for (const [path, bytes] of images) {
    files[`images/${path}`] = bytes;
  }
  return new Blob([zipSync(files, { level: 0 })], { type: 'application/zip' });
}
