const GITHUB_API_BASE = 'https://api.github.com';
const PAT_STORAGE_KEY = 'github_pat';
const REPO_OWNER_KEY = 'admin_repo_owner';
const REPO_NAME_KEY = 'admin_repo_name';
const REPO_WRITE_BRANCH = 'main';

const FAILURES_PATH = 'docs/failures.json';
const MANIFEST_PATH = 'docs/manifest.json';
const CATALOG_DEFAULT_PATH = 'docs/catalog.json';
const CATALOG_METADATA_PATH = 'docs/catalog-metadata.json';
const VISIBILITY_VALUES = ['published', 'hidden', 'archived'];
const MAX_FILE_SIZE = 100 * 1024 * 1024;
const MAX_LARGE_PDF_SIZE = 500 * 1024 * 1024;
const LARGE_PDF_CHUNK_SIZE = 15 * 1024 * 1024;
const ACCEPTED_EXTENSIONS = ['pdf', 'epub', 'md', 'zip'];

const CONTENT_TYPE_DIRS = {
  book: 'docs/books',
  doc: 'docs/articles',
  site: 'docs/sites',
};

// --- PAT ---
export function getPat() { return localStorage.getItem(PAT_STORAGE_KEY); }
export function setPat(pat) { localStorage.setItem(PAT_STORAGE_KEY, pat); }
export function clearPat() { localStorage.removeItem(PAT_STORAGE_KEY); }

// --- Repo ---
export function detectRepo() {
  const savedOwner = localStorage.getItem(REPO_OWNER_KEY);
  const savedName = localStorage.getItem(REPO_NAME_KEY);
  if (savedOwner && savedName) return { owner: savedOwner, name: savedName };
  const m = window.location.hostname.match(/^([^.]+)\.github\.io$/);
  if (m) {
    const segments = window.location.pathname.split('/').filter(Boolean);
    return { owner: m[1], name: segments[0] || `${m[1]}.github.io` };
  }
  return { owner: '', name: '' };
}
export function saveRepo(owner, name) {
  localStorage.setItem(REPO_OWNER_KEY, owner);
  localStorage.setItem(REPO_NAME_KEY, name);
}

// --- API ---
export async function githubApi(path, options = {}) {
  const pat = getPat();
  if (!pat) throw new Error('No GitHub PAT configured');
  const url = path.startsWith('http') ? path : `${GITHUB_API_BASE}${path}`;
  const parsed = new URL(url);
  if (parsed.hostname !== 'api.github.com') throw new Error('PAT must only be sent to api.github.com');
  const res = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json', ...options.headers },
  });
  if (res.status === 204) return null;
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 401) throw new Error('Authentication failed. Please check your PAT.');
    throw new Error(`GitHub API error ${res.status} on ${path}: ${body}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function githubUpload(path, body, onUploadProgress, method = 'PUT') {
  const pat = getPat();
  if (!pat) return Promise.reject(new Error('No GitHub PAT configured'));

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, `${GITHUB_API_BASE}${path}`);
    xhr.setRequestHeader('Authorization', `Bearer ${pat}`);
    xhr.setRequestHeader('Accept', 'application/vnd.github.v3+json');
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && typeof onUploadProgress === 'function') {
        onUploadProgress(event.loaded, event.total);
      }
    };
    xhr.onerror = () => reject(new Error('Network error while uploading to GitHub.'));
    xhr.onabort = () => reject(new Error('Upload cancelled.'));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.responseText ? JSON.parse(xhr.responseText) : null);
      } else if (xhr.status === 401) {
        reject(new Error('Authentication failed. Please check your PAT.'));
      } else {
        reject(new Error(`GitHub API error ${xhr.status} on ${path}: ${xhr.responseText}`));
      }
    };
    xhr.send(JSON.stringify(body));
  });
}

export async function verifyPat() {
  return githubApi('/user');
}

// --- Encoding ---
function encodeBase64Utf8(text) { return btoa(unescape(encodeURIComponent(text))); }
function decodeBase64Utf8(text) { return decodeURIComponent(escape(atob(text))); }
function isNotFoundError(err) { return String(err && err.message).includes('404'); }

// --- Normalize ---
function normalizeNullableNumber(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}
export function normalizeVisibility(v) {
  const c = String(v || '').trim().toLowerCase();
  return VISIBILITY_VALUES.includes(c) ? c : 'published';
}
export function normalizeTags(value) {
  if (Array.isArray(value)) return value.map((t) => String(t || '').trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((t) => t.trim()).filter(Boolean);
  return [];
}
export function parseTagsInput(raw) {
  const seen = new Set(); const tags = [];
  for (const tag of normalizeTags(raw)) { const k = tag.toLowerCase(); if (!seen.has(k)) { seen.add(k); tags.push(tag); } }
  return tags;
}
export function getDisplayTitle(item) {
  const v = String(item.display_title || '').trim();
  return v || item.title || item.id;
}

function normalizeItemRecord(raw) {
  const m = raw && typeof raw === 'object' ? raw : {};
  const id = String(m.id || '').trim();
  if (!id) return null;
  return {
    id,
    type: String(m.type || 'book').trim(),
    title: String(m.title || id).trim(),
    display_title: String(m.display_title || '').trim(),
    author: String(m.author || '').trim(),
    summary: String(m.summary || '').trim(),
    tags: normalizeTags(m.tags),
    featured: Boolean(m.featured),
    manual_order: normalizeNullableNumber(m.manual_order),
    visibility: normalizeVisibility(m.visibility),
    chapters_count: normalizeNullableNumber(m.chapters_count),
    word_count: normalizeNullableNumber(m.word_count),
    source_format: String(m.source_format || '').trim() || null,
    created_at: String(m.created_at || '').trim() || null,
    updated_at: String(m.updated_at || m.created_at || '').trim() || null,
    source: String(m.source || '').trim() || null,
    entry: String(m.entry || '').trim() || null,
  };
}

function normalizeCatalogPayload(payload) {
  const records = Array.isArray(payload?.items) ? payload.items : [];
  return records.map(normalizeItemRecord).filter(Boolean);
}

function compareString(a, b) {
  return String(a || '').localeCompare(String(b || ''), undefined, { sensitivity: 'base', numeric: true });
}

function sortItemsForPublic(items) {
  return items.slice().sort((a, b) => {
    if (Boolean(a.featured) !== Boolean(b.featured)) return a.featured ? -1 : 1;
    const mo = (a.manual_order ?? Infinity) - (b.manual_order ?? Infinity);
    if (mo !== 0) return mo;
    return compareString(getDisplayTitle(a), getDisplayTitle(b));
  });
}

function toIsoNow() { return new Date().toISOString(); }

function buildPublicManifest(items) {
  return { items: sortItemsForPublic(items.filter(b => normalizeVisibility(b.visibility) === 'published')).map(b => {
    const result = {
      id: b.id, type: b.type || 'book', title: getDisplayTitle(b),
      author: b.author || undefined, summary: b.summary || undefined,
      tags: (b.tags || []).slice(), featured: Boolean(b.featured),
      source: b.source || undefined,
      created_at: b.created_at, updated_at: b.updated_at,
    };
    if (b.type === 'book' || !b.type) {
      result.chapters_count = b.chapters_count;
      result.word_count = b.word_count;
      result.source_format = b.source_format || undefined;
    } else if (b.type === 'doc') {
      result.word_count = b.word_count;
    } else if (b.type === 'site') {
      result.entry = b.entry;
    }
    return result;
  })};
}

function serializeCatalog(items) {
  return { version: 1, updated_at: toIsoNow(), items: items.slice().sort((a, b) => compareString(a.id, b.id)).map(b => ({
    id: b.id, type: b.type || 'book', title: b.title, display_title: b.display_title || '',
    author: b.author || '', summary: b.summary || '',
    tags: (b.tags || []).slice(), featured: Boolean(b.featured),
    manual_order: b.manual_order, visibility: normalizeVisibility(b.visibility),
    source: b.source || '', entry: b.entry || undefined,
    source_format: b.source_format || undefined,
    chapters_count: b.chapters_count, word_count: b.word_count,
    created_at: b.created_at, updated_at: b.updated_at,
  }))};
}

function serializeCatalogMetadata(items) {
  return { version: 1, updated_at: toIsoNow(), items: items.slice().sort((a, b) => compareString(a.id, b.id)).map(b => ({
    id: b.id, type: b.type || 'book', display_title: b.display_title || '',
    author: b.author || '', summary: b.summary || '',
    tags: (b.tags || []).slice(), featured: Boolean(b.featured),
    manual_order: b.manual_order, visibility: normalizeVisibility(b.visibility),
    metadata_updated_at: b.updated_at || null, source: b.source || '',
  }))};
}

// --- Repo read/write ---
async function readRepositoryJson(repo, path) {
  const data = await githubApi(`/repos/${repo.owner}/${repo.name}/contents/${path}`);
  if (!data || typeof data.content !== 'string') throw new Error(`Unexpected file payload for ${path}`);
  const decoded = decodeBase64Utf8(data.content.replace(/\n/g, ''));
  return { path, sha: data.sha || null, data: JSON.parse(decoded) };
}

async function commitRepositoryOperations(repo, message, operations) {
  const ops = [...new Map((operations || []).filter(o => o?.path).map(o => [o.path, o])).values()].sort((a, b) => compareString(a.path, b.path));
  if (ops.length === 0) return;
  const ref = await githubApi(`/repos/${repo.owner}/${repo.name}/git/ref/heads/${REPO_WRITE_BRANCH}`);
  const parentSha = ref?.object?.sha;
  if (!parentSha) throw new Error(`Could not resolve branch head for ${REPO_WRITE_BRANCH}.`);
  const parentCommit = await githubApi(`/repos/${repo.owner}/${repo.name}/git/commits/${parentSha}`);
  const baseTree = parentCommit?.tree?.sha;
  if (!baseTree) throw new Error(`Could not resolve base tree for ${REPO_WRITE_BRANCH}.`);
  const tree = ops.map(o => o.delete ? { path: o.path, mode: '100644', type: 'blob', sha: null } : { path: o.path, mode: '100644', type: 'blob', content: o.content });
  const newTree = await githubApi(`/repos/${repo.owner}/${repo.name}/git/trees`, { method: 'POST', body: JSON.stringify({ base_tree: baseTree, tree }) });
  if (!newTree?.sha) throw new Error('Failed to create repository tree.');
  const newCommit = await githubApi(`/repos/${repo.owner}/${repo.name}/git/commits`, { method: 'POST', body: JSON.stringify({ message, tree: newTree.sha, parents: [parentSha] }) });
  if (!newCommit?.sha) throw new Error('Failed to create repository commit.');
  await githubApi(`/repos/${repo.owner}/${repo.name}/git/refs/heads/${REPO_WRITE_BRANCH}`, { method: 'PATCH', body: JSON.stringify({ sha: newCommit.sha, force: false }) });
}

function notifyCatalogUpdated() { window.dispatchEvent(new CustomEvent('gitshelf:catalog-updated')); }

// --- Catalog ---
let catalogSourcePath = CATALOG_DEFAULT_PATH;

export async function fetchCatalog(repo) {
  try { await readRepositoryJson(repo, CATALOG_METADATA_PATH); } catch (e) { if (!isNotFoundError(e)) throw e; }
  try {
    const f = await readRepositoryJson(repo, CATALOG_DEFAULT_PATH);
    catalogSourcePath = f.path;
    return { items: normalizeCatalogPayload(f.data), sourcePath: f.path, notice: '' };
  } catch (e) {
    if (!isNotFoundError(e)) throw e;
  }
  try { const f = await readRepositoryJson(repo, MANIFEST_PATH); return { items: normalizeCatalogPayload(f.data).map(b => ({ ...b, visibility: 'published' })), sourcePath: CATALOG_DEFAULT_PATH, notice: 'Full catalog not found. Loaded manifest as fallback.' }; }
  catch (e) { if (!isNotFoundError(e)) throw e; return { items: [], sourcePath: CATALOG_DEFAULT_PATH, notice: 'Catalog files not found. First metadata save will create them.' }; }
}

export async function persistCatalog(repo, nextItems, message, extraOps) {
  const catPath = catalogSourcePath || CATALOG_DEFAULT_PATH;
  const ops = [
    { path: CATALOG_METADATA_PATH, content: JSON.stringify(serializeCatalogMetadata(nextItems), null, 2) + '\n' },
    { path: catPath, content: JSON.stringify(serializeCatalog(nextItems), null, 2) + '\n' },
    { path: MANIFEST_PATH, content: JSON.stringify(buildPublicManifest(nextItems), null, 2) + '\n' },
    ...(extraOps || []),
  ];
  await commitRepositoryOperations(repo, message, ops);
  catalogSourcePath = catPath;
  notifyCatalogUpdated();
}

export function deepCloneItems(items) { return items.map(b => ({ ...b, tags: (b.tags || []).slice() })); }

function readAsBase64(value, onReadProgress) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result.split(',')[1] : '');
    reader.onerror = () => reject(new Error('Failed to read file.'));
    reader.onprogress = (event) => {
      if (event.lengthComputable && typeof onReadProgress === 'function') {
        onReadProgress(event.loaded, event.total);
      }
    };
    reader.readAsDataURL(value);
  });
}

function createUploadId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().replaceAll('-', '');
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

async function commitLargePdfUpload(repo, file, uploadId, parts) {
  const manifestPath = `input/${uploadId}.parts.json`;
  const manifest = {
    version: 1,
    assembly: 'bytes',
    filename: file.name,
    file_size: file.size,
    parts: parts.map((part) => part.path),
  };
  const manifestBlob = await githubApi(`/repos/${repo.owner}/${repo.name}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify({
      content: encodeBase64Utf8(`${JSON.stringify(manifest, null, 2)}\n`),
      encoding: 'base64',
    }),
  });
  if (!manifestBlob?.sha) throw new Error('GitHub did not confirm the upload manifest.');

  const ref = await githubApi(`/repos/${repo.owner}/${repo.name}/git/ref/heads/${REPO_WRITE_BRANCH}`);
  const parentSha = ref?.object?.sha;
  if (!parentSha) throw new Error(`Could not resolve branch head for ${REPO_WRITE_BRANCH}.`);
  const parentCommit = await githubApi(`/repos/${repo.owner}/${repo.name}/git/commits/${parentSha}`);
  const baseTree = parentCommit?.tree?.sha;
  if (!baseTree) throw new Error(`Could not resolve base tree for ${REPO_WRITE_BRANCH}.`);

  const treeEntries = [
    ...parts.map((part) => ({
      path: part.path,
      mode: '100644',
      type: 'blob',
      sha: part.sha,
    })),
    {
      path: manifestPath,
      mode: '100644',
      type: 'blob',
      sha: manifestBlob.sha,
    },
  ];
  const tree = await githubApi(`/repos/${repo.owner}/${repo.name}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ base_tree: baseTree, tree: treeEntries }),
  });
  if (!tree?.sha) throw new Error('Failed to create the large PDF upload tree.');
  const commit = await githubApi(`/repos/${repo.owner}/${repo.name}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({
      message: `feat(pipeline): assemble ${file.name}`,
      tree: tree.sha,
      parents: [parentSha],
    }),
  });
  if (!commit?.sha) throw new Error('Failed to create the large PDF upload commit.');
  await githubApi(`/repos/${repo.owner}/${repo.name}/git/refs/heads/${REPO_WRITE_BRANCH}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });
}

async function uploadLargePdf(file, repo, onProgress) {
  const uploadId = createUploadId();
  const uploaded = [];
  const chunkCount = Math.ceil(file.size / LARGE_PDF_CHUNK_SIZE);
  onProgress('splitting', `Preparing ${chunkCount} safe upload parts...`, { percent: 2 });

  for (let index = 0; index < chunkCount; index += 1) {
    const partNumber = String(index + 1).padStart(5, '0');
    const partPath = `uploads/${uploadId}/part-${partNumber}.part`;
    const start = index * LARGE_PDF_CHUNK_SIZE;
    const chunk = file.slice(start, Math.min(file.size, start + LARGE_PDF_CHUNK_SIZE));
    const base64 = await readAsBase64(chunk);
    const partStart = 3 + (index / chunkCount) * 91;
    const partShare = 91 / chunkCount;
    onProgress(
      'uploading',
      `Uploading PDF part ${index + 1} of ${chunkCount}... 0%`,
      { percent: Math.round(partStart), uploadPercent: 0 },
    );
    const response = await githubUpload(
      `/repos/${repo.owner}/${repo.name}/git/blobs`,
      {
        content: base64,
        encoding: 'base64',
      },
      (loaded, total) => {
        const uploadPercent = Math.round((loaded / total) * 100);
        onProgress(
          'uploading',
          `Uploading PDF part ${index + 1} of ${chunkCount}... ${uploadPercent}%`,
          {
            percent: Math.round(partStart + (uploadPercent / 100) * partShare),
            uploadPercent,
          },
        );
      },
      'POST',
    );
    const sha = response?.sha;
    if (!sha) throw new Error(`GitHub did not confirm PDF part ${index + 1}.`);
    uploaded.push({ path: partPath, sha });
  }

  onProgress('preparing', 'Starting automatic conversion...', { percent: 96 });
  await commitLargePdfUpload(repo, file, uploadId, uploaded);
}

export async function uploadContent(file, repo, onProgress) {
  if (!repo.owner || !repo.name) throw new Error('Repository not configured.');
  const ext = file.name.split('.').pop().toLowerCase();
  if (!ACCEPTED_EXTENSIONS.includes(ext)) throw new Error(`Unsupported file type. Accepted: ${ACCEPTED_EXTENSIONS.join(', ')}`);
  if (ext === 'pdf' && file.size > MAX_FILE_SIZE) {
    if (file.size > MAX_LARGE_PDF_SIZE) throw new Error('PDF too large (max 500 MB).');
    await uploadLargePdf(file, repo, onProgress);
    onProgress('done', 'Upload complete.', { percent: 100 });
    return;
  }
  if (file.size > MAX_FILE_SIZE) throw new Error(`File too large (max 100 MB).`);
  onProgress('reading', `Reading ${file.name}...`, { percent: 0 });
  const base64 = await readAsBase64(file, (loaded, total) => {
        onProgress('reading', `Reading ${file.name}...`, {
      percent: Math.round((loaded / total) * 20),
        });
  });
  onProgress('preparing', 'Preparing GitHub upload...', { percent: 20 });
  const filePath = `input/${encodeURIComponent(file.name)}`;
  let sha;
  try {
    const existing = await githubApi(`/repos/${repo.owner}/${repo.name}/contents/${filePath}`);
    sha = existing.sha;
  } catch { /* file doesn't exist yet */ }
  const body = { message: `feat(pipeline): upload ${file.name}`, content: base64 };
  if (sha) body.sha = sha;
  onProgress('uploading', 'Uploading to GitHub... 0%', { percent: 25, uploadPercent: 0 });
  await githubUpload(`/repos/${repo.owner}/${repo.name}/contents/${filePath}`, body, (loaded, total) => {
    const uploadPercent = Math.round((loaded / total) * 100);
    onProgress('uploading', `Uploading to GitHub... ${uploadPercent}%`, {
      percent: 25 + Math.round(uploadPercent * 0.7),
      uploadPercent,
    });
  });
  onProgress('done', 'Upload complete.', { percent: 100 });
}

export async function triggerReconvert(item, repo, { clearCache = false } = {}) {
  if (!repo.owner || !repo.name) throw new Error('Repository not configured.');
  const filename = String(item.source || '').trim();
  if (!filename) throw new Error('Missing source file metadata.');
  if (clearCache) {
    const cacheOps = await getCacheDeleteOps(repo, item.id);
    if (cacheOps.length) {
      await commitRepositoryOperations(repo, `chore(admin): clear cache for ${item.id}`, cacheOps);
    }
  }
  await githubApi(`/repos/${repo.owner}/${repo.name}/actions/workflows/convert.yml/dispatches`, {
    method: 'POST', body: JSON.stringify({ ref: 'main', inputs: { filename } }),
  });
}

async function listRepoTree(repo, path) {
  try {
    const data = await githubApi(`/repos/${repo.owner}/${repo.name}/contents/${path}`);
    if (!Array.isArray(data)) return data?.type === 'file' ? [data] : [];

    const nested = await Promise.all(data.map(async (entry) => {
      if (entry.type === 'dir') return listRepoTree(repo, entry.path);
      return entry.type === 'file' ? [entry] : [];
    }));
    return nested.flat();
  } catch {
    return [];
  }
}

async function getCacheDeleteOps(repo, itemId) {
  let pdfMd5;
  try {
    const f = await readRepositoryJson(repo, `docs/books/${itemId}/meta.json`);
    pdfMd5 = f.data?.pdf_md5;
  } catch { /* not found */ }
  const ops = [];

  if (pdfMd5) {
    const cacheFiles = await listRepoTree(repo, 'cache/markdown');
    ops.push(...cacheFiles
      .filter(f => f.name.startsWith(pdfMd5))
      .map(f => ({ path: f.path, delete: true })));
  }

  return ops;
}

export async function deleteItemPermanently(item, repo, catalog) {
  const type = item.type || 'book';
  const dirBase = CONTENT_TYPE_DIRS[type] || 'docs/books';
  const files = await listRepoTree(repo, `${dirBase}/${item.id}`);
  const cacheOps = type === 'book' ? await getCacheDeleteOps(repo, item.id) : [];
  const next = deepCloneItems(catalog).filter(b => b.id !== item.id);
  const deleteOps = [...files.map(f => ({ path: f.path, delete: true })), ...cacheOps];
  await persistCatalog(repo, next, `chore(admin): permanently delete ${type} ${item.id}`, deleteOps);
  return next;
}


export async function loadHistory(repo) {
  try {
    const data = await githubApi(`/repos/${repo.owner}/${repo.name}/contents/input/archived`);
    if (!Array.isArray(data)) return [];
    return data.filter(f => f.name !== '.gitkeep').map(f => ({ name: f.name, size: f.size }));
  } catch { return []; }
}

// --- Failures ---
export async function fetchFailures(repo) {
  try {
    const f = await readRepositoryJson(repo, FAILURES_PATH);
    const records = f.data?.failures;
    return Array.isArray(records) ? records : [];
  } catch (e) {
    if (isNotFoundError(e)) return [];
    throw e;
  }
}

export async function dismissFailure(repo, filename, retryFilename = filename) {
  const all = await fetchFailures(repo);
  const filtered = all.filter(f => f.filename !== filename);
  const ops = [{ path: FAILURES_PATH, content: JSON.stringify({ failures: filtered }, null, 2) + '\n' }];
  const filePath = `input/${retryFilename}`;
  try {
    const source = await readRepositoryJson(repo, filePath);
    ops.push({ path: filePath, delete: true });
    if (retryFilename.endsWith('.parts.json')) {
      for (const partPath of source.data?.parts || []) {
        if (typeof partPath === 'string' && partPath.startsWith('uploads/')) {
          ops.push({ path: partPath, delete: true });
        }
      }
    }
  } catch { /* file may not exist */ }
  await commitRepositoryOperations(repo, `chore(admin): dismiss failure for ${filename}`, ops);
}

export async function retryFailure(repo, filename, retryFilename = filename) {
  await githubApi(`/repos/${repo.owner}/${repo.name}/actions/workflows/convert.yml/dispatches`, {
    method: 'POST', body: JSON.stringify({ ref: 'main', inputs: { filename: retryFilename } }),
  });
}

// --- Formatting ---
export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`;
}

export const dateFormatter = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
export const dateTimeFormatter = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
export const numberFormatter = new Intl.NumberFormat(undefined);

export { ACCEPTED_EXTENSIONS, MAX_FILE_SIZE, MAX_LARGE_PDF_SIZE, VISIBILITY_VALUES, toIsoNow };
