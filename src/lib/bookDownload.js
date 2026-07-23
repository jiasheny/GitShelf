const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(\s*(<[^>\n]*>|(?:\\.|[^()\s\n]|\([^()\n]*\))+)([^)\n]*)\)/g;
const HTML_IMAGE_RE = /<img\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1[^>]*>/gi;
const HASHED_IMAGE_FILENAME_RE = /^[a-f0-9]{64}(?:\.[^./\\]+)?$/i;
const OBSIDIAN_ATTACHMENT_PATH = '../../99 附件/默认附件';

function splitDestination(sourceToken, suffix = '') {
  const token = String(sourceToken || '').trim();
  return {
    source: token.startsWith('<') && token.endsWith('>') ? token.slice(1, -1) : token,
    suffix: String(suffix || ''),
  };
}

function normalizeImagePath(source, bookId) {
  let value = String(source || '').trim().replace(/\\/g, '/');
  if (!value || value.startsWith('/') || value.startsWith('#') || value.startsWith('//')) {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;

  value = value.split(/[?#]/, 1)[0];
  try {
    value = decodeURIComponent(value);
  } catch {
    return null;
  }
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

function flatFilename(value, fallback, pathSeparator = '-') {
  const filename = String(value || '')
    .normalize('NFC')
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .join(pathSeparator)
    .replace(/[<>:"|?*\u0000-\u001f]/g, '-')
    .replace(/^[.\s-]+|[.\s-]+$/g, '');
  if (!filename) return fallback;
  const encoder = new TextEncoder();
  if (encoder.encode(filename).byteLength <= 220) return filename;
  const dot = filename.lastIndexOf('.');
  const extension = dot > 0 && filename.length - dot <= 16 ? filename.slice(dot) : '';
  const stem = extension ? filename.slice(0, dot) : filename;
  const maxStemBytes = 220 - encoder.encode(extension).byteLength;
  let truncated = '';
  for (const character of stem) {
    if (encoder.encode(truncated + character).byteLength > maxStemBytes) break;
    truncated += character;
  }
  truncated = truncated.replace(/[.\s-]+$/g, '');
  return truncated ? `${truncated}${extension}` : fallback;
}

function preferredObsidianFilename(imagePath, bookId) {
  const basename = imagePath.split('/').at(-1);
  if (HASHED_IMAGE_FILENAME_RE.test(basename)) return basename;

  const namespace = flatFilename(bookId, 'book');
  const sourceName = flatFilename(imagePath, 'image', '--');
  return `${namespace}--${sourceName}`;
}

function filenameOverride(filenameOverrides, imagePath) {
  if (filenameOverrides instanceof Map) {
    return filenameOverrides.get(imagePath);
  }
  if (
    filenameOverrides
    && Object.prototype.hasOwnProperty.call(filenameOverrides, imagePath)
  ) {
    return filenameOverrides[imagePath];
  }
  return undefined;
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
    (full, alt, sourceToken, suffix) => {
      const { source } = splitDestination(sourceToken);
      const path = normalizeImagePath(source, bookId);
      if (!path) return full;
      imagePaths.add(path);
      const destination = `images/${path}`;
      const safeDestination = /[\s()]/.test(destination) ? `<${destination}>` : destination;
      return `![${alt}](${safeDestination}${suffix})`;
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

export function prepareMarkdownForObsidian(markdown, bookId, filenameOverrides = {}) {
  const attachmentByPath = new Map();

  const attachmentFilename = (imagePath) => {
    if (attachmentByPath.has(imagePath)) return attachmentByPath.get(imagePath);

    const preferred = preferredObsidianFilename(imagePath, bookId);
    const override = filenameOverride(filenameOverrides, imagePath);
    const filename = override == null || String(override).trim() === ''
      ? preferred
      : flatFilename(override, preferred);
    attachmentByPath.set(imagePath, filename);
    return filename;
  };

  let rewritten = String(markdown || '').replace(
    MARKDOWN_IMAGE_RE,
    (full, alt, sourceToken, suffix) => {
      const { source } = splitDestination(sourceToken);
      const imagePath = normalizeImagePath(source, bookId);
      if (!imagePath) return full;

      const filename = attachmentFilename(imagePath);
      return `![${alt}](<${OBSIDIAN_ATTACHMENT_PATH}/${filename}>${suffix})`;
    },
  );

  rewritten = rewritten.replace(HTML_IMAGE_RE, (full, quote, source) => {
    const imagePath = normalizeImagePath(source, bookId);
    if (!imagePath) return full;

    const filename = attachmentFilename(imagePath);
    return full.replace(
      `${quote}${source}${quote}`,
      `${quote}${OBSIDIAN_ATTACHMENT_PATH}/${filename}${quote}`,
    );
  });

  const attachments = [...attachmentByPath].map(([sourcePath, filename]) => ({
    sourcePath,
    filename,
  }));
  return {
    markdown: rewritten,
    imagePaths: attachments.map(({ sourcePath }) => sourcePath),
    imageFilenames: attachments.map(({ filename }) => filename),
    attachments,
  };
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
