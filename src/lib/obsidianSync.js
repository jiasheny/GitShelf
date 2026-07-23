import { fetchBookImages, prepareMarkdownForObsidian } from './bookDownload';
import { githubApi } from './github-api';

export const OBSIDIAN_REPOSITORY = Object.freeze({
  owner: 'jiasheny',
  name: 'obsidian-vault',
  branch: 'main',
});
export const OBSIDIAN_BOOKS_DIR = '20 学习/34 书籍';
export const OBSIDIAN_ATTACHMENTS_DIR = '99 附件/默认附件';

const MAX_SYNC_ATTEMPTS = 3;
const BLOB_UPLOAD_CONCURRENCY = 4;

function truncateUtf8(value, maxBytes) {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  let truncated = '';
  for (const character of value) {
    if (encoder.encode(truncated + character).byteLength > maxBytes) break;
    truncated += character;
  }
  return truncated;
}

function reportProgress(onProgress, stage, message, percent, details = {}) {
  onProgress({ stage, message, percent, ...details });
}

function safeVaultFilename(value, fallback = 'book') {
  let filename = String(value || '')
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s-]+|[.\s-]+$/g, '');
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename)) {
    filename = `_${filename}`;
  }
  filename = truncateUtf8(filename, 180).replace(/[.\s-]+$/g, '');
  return filename || fallback;
}

function safeAttachmentFilename(value) {
  let filename = String(value || '')
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/^[.\s-]+|[.\s-]+$/g, '');
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename)) {
    filename = `_${filename}`;
  }
  const encoder = new TextEncoder();
  if (encoder.encode(filename).byteLength <= 220) return filename || 'image';
  const dot = filename.lastIndexOf('.');
  const extension = dot > 0 && filename.length - dot <= 16 ? filename.slice(dot) : '';
  const stem = extension ? filename.slice(0, dot) : filename;
  const maxStemBytes = 220 - encoder.encode(extension).byteLength;
  const truncated = truncateUtf8(stem, maxStemBytes).replace(/[.\s-]+$/g, '');
  return truncated ? `${truncated}${extension}` : 'image';
}

function noteUrl(path) {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${OBSIDIAN_REPOSITORY.owner}/${OBSIDIAN_REPOSITORY.name}/blob/${OBSIDIAN_REPOSITORY.branch}/${encodedPath}`;
}

function bytesToBase64(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  const chunks = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return btoa(chunks.join(''));
}

function base64ToText(value) {
  const binary = atob(String(value || '').replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

async function gitBlobSha(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const payload = new Uint8Array(header.byteLength + bytes.byteLength);
  payload.set(header);
  payload.set(bytes, header.byteLength);
  const digest = await globalThis.crypto.subtle.digest('SHA-1', payload);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function repositoryPath(path) {
  return `/repos/${OBSIDIAN_REPOSITORY.owner}/${OBSIDIAN_REPOSITORY.name}${path}`;
}

async function createBlob(bytes) {
  const blob = await githubApi(repositoryPath('/git/blobs'), {
    method: 'POST',
    body: JSON.stringify({
      content: bytesToBase64(bytes),
      encoding: 'base64',
    }),
  });
  if (!blob?.sha) throw new Error('GitHub did not confirm an uploaded Obsidian file.');
  return blob.sha;
}

async function mapWithConcurrency(items, limit, worker) {
  let nextIndex = 0;
  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index], index);
    }
  }
  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => run()));
}

async function readTargetState() {
  const ref = await githubApi(repositoryPath(`/git/ref/heads/${OBSIDIAN_REPOSITORY.branch}`));
  const headSha = ref?.object?.sha;
  if (!headSha) throw new Error('Could not resolve the Obsidian vault main branch.');

  const commit = await githubApi(repositoryPath(`/git/commits/${headSha}`));
  const rootTreeSha = commit?.tree?.sha;
  if (!rootTreeSha) throw new Error('Could not resolve the Obsidian vault file tree.');

  const treeCache = new Map();
  async function treeEntries(treeSha) {
    if (!treeCache.has(treeSha)) {
      treeCache.set(treeSha, githubApi(repositoryPath(`/git/trees/${treeSha}`)));
    }
    const tree = await treeCache.get(treeSha);
    if (!Array.isArray(tree?.tree)) throw new Error('GitHub returned an invalid Obsidian folder listing.');
    return tree.tree;
  }

  async function folderEntries(path) {
    let treeSha = rootTreeSha;
    for (const segment of path.split('/')) {
      const entries = await treeEntries(treeSha);
      const folder = entries.find((entry) => entry.type === 'tree' && entry.path === segment);
      if (!folder?.sha) {
        throw new Error(`The Obsidian folder "${path}" was not found. Check the vault structure.`);
      }
      treeSha = folder.sha;
    }
    return treeEntries(treeSha);
  }

  const [attachmentEntries, noteEntries] = await Promise.all([
    folderEntries(OBSIDIAN_ATTACHMENTS_DIR),
    folderEntries(OBSIDIAN_BOOKS_DIR),
  ]);

  return {
    headSha,
    rootTreeSha,
    attachments: new Map(
      attachmentEntries.filter((entry) => entry.type === 'blob').map((entry) => [entry.path, entry.sha]),
    ),
    notes: new Map(
      noteEntries.filter((entry) => entry.type === 'blob').map((entry) => [entry.path, entry.sha]),
    ),
  };
}

function collisionFilename(bookId, preferred) {
  const namespace = safeVaultFilename(bookId);
  return preferred.startsWith(`${namespace}--`) ? preferred : `${namespace}--${preferred}`;
}

function attachmentFilename(record, existingAttachments, assignedFilenames, bookId) {
  const namespace = safeVaultFilename(bookId);
  const candidates = [
    record.filename,
    collisionFilename(bookId, record.filename),
    `${namespace}--${record.gitSha.slice(0, 12)}--${record.filename}`,
    `${namespace}--${record.gitSha}--${record.filename}`,
  ];
  for (const candidate of new Set(candidates.map(safeAttachmentFilename))) {
    const existingSha = existingAttachments.get(candidate);
    const assignedSha = assignedFilenames.get(candidate);
    if (
      (!existingSha || existingSha === record.gitSha)
      && (!assignedSha || assignedSha === record.gitSha)
    ) {
      return candidate;
    }
  }
  throw new Error(`Could not choose a safe Obsidian attachment name for ${record.sourcePath}.`);
}

function noteMarker(bookId) {
  return `<!-- gitshelf-book-id:${encodeURIComponent(bookId)} -->`;
}

async function noteBelongsToBook(blobSha, marker) {
  const blob = await githubApi(repositoryPath(`/git/blobs/${blobSha}`));
  return blob?.encoding === 'base64' && base64ToText(blob.content).includes(marker);
}

async function resolveNoteName(state, title, bookId, noteGitSha, marker) {
  const titleStem = safeVaultFilename(title || bookId);
  const bookStem = truncateUtf8(safeVaultFilename(bookId), 60).replace(/[.\s-]+$/g, '') || 'book';
  const withSuffix = (suffix = '') => {
    const suffixBytes = new TextEncoder().encode(suffix).byteLength;
    const stem = truncateUtf8(titleStem, Math.max(24, 180 - suffixBytes))
      .replace(/[.\s-]+$/g, '') || 'book';
    return `${stem}${suffix}.md`;
  };
  const candidates = [
    withSuffix(),
    withSuffix('--GitShelf'),
    withSuffix(`--GitShelf--${bookStem}`),
    withSuffix(`--GitShelf--${bookStem}--${noteGitSha.slice(0, 12)}`),
  ];
  for (const candidate of candidates) {
    const existingSha = state.notes.get(candidate);
    if (!existingSha || existingSha === noteGitSha) return candidate;
    if (await noteBelongsToBook(existingSha, marker)) return candidate;
  }
  throw new Error(`Could not choose a safe Obsidian note name for "${titleStem}".`);
}

function isRetryableRefError(error) {
  if (error?.status === 409) return true;
  return error?.status === 422 && /not a fast.?forward|reference changed/i.test(String(error?.message || ''));
}

function friendlySyncError(error) {
  const message = String(error?.message || error);
  if (message.includes('No GitHub PAT configured')) {
    return new Error('Open Admin and connect a GitHub token before syncing to Obsidian.');
  }
  if (error?.status === 401) {
    return new Error('GitHub authentication failed. Reconnect your token in Admin.');
  }
  if (error?.status === 403 || error?.status === 404) {
    return new Error(
      'The GitHub token cannot write jiasheny/obsidian-vault. Grant that repository Contents read/write access, then reconnect it in Admin.',
    );
  }
  if (error?.status === 422) {
    return new Error(
      'GitHub rejected the Obsidian update. Check the vault branch rules and token Contents permission, then try again.',
    );
  }
  return error instanceof Error ? error : new Error(message);
}

/**
 * Copy one converted GitShelf book into the private Obsidian vault.
 * Images and the merged Markdown note become visible in one fast-forward commit.
 */
export async function syncBookToObsidian({ bookId, title, markdown }, onProgress = () => {}) {
  try {
    if (!bookId) throw new Error('Missing GitShelf book ID.');
    const marker = noteMarker(bookId);

    reportProgress(onProgress, 'checking', 'Checking Obsidian vault access...', 3);
    await githubApi(repositoryPath(''));
    reportProgress(onProgress, 'preparing', 'Preparing Markdown and image references...', 5);
    const initial = prepareMarkdownForObsidian(markdown, bookId);
    reportProgress(
      onProgress,
      'downloading',
      initial.imagePaths.length
        ? `Downloading book images 0/${initial.imagePaths.length}...`
        : 'No local images to copy. Checking the vault...',
      initial.imagePaths.length ? 10 : 40,
      { completed: 0, total: initial.imagePaths.length },
    );
    const images = await fetchBookImages(bookId, initial.imagePaths, (completed, total) => {
      reportProgress(
        onProgress,
        'downloading',
        `Downloading book images ${completed}/${total}...`,
        10 + Math.round((completed / total) * 30),
        { completed, total },
      );
    });

    const imageRecords = await Promise.all(initial.attachments.map(async (attachment) => {
      const bytes = images.get(attachment.sourcePath);
      if (!(bytes instanceof Uint8Array)) {
        throw new Error(`Downloaded image is missing: ${attachment.sourcePath}`);
      }
      return {
        ...attachment,
        bytes,
        gitSha: await gitBlobSha(bytes),
      };
    }));

    reportProgress(onProgress, 'checking', 'Checking the latest Obsidian backup...', 42);
    const blobUploads = new Map();
    const ensureBlob = async (record) => {
      if (!blobUploads.has(record.gitSha)) {
        blobUploads.set(record.gitSha, createBlob(record.bytes));
      }
      return blobUploads.get(record.gitSha);
    };

    for (let attempt = 1; attempt <= MAX_SYNC_ATTEMPTS; attempt += 1) {
      const state = await readTargetState();
      const filenameOverrides = new Map();
      const assignedFilenames = new Map();
      for (const record of imageRecords) {
        const filename = attachmentFilename(
          record,
          state.attachments,
          assignedFilenames,
          bookId,
        );
        assignedFilenames.set(filename, record.gitSha);
        filenameOverrides.set(record.sourcePath, filename);
      }

      const prepared = prepareMarkdownForObsidian(markdown, bookId, filenameOverrides);
      const finalFilenameBySource = new Map(
        prepared.attachments.map((attachment) => [attachment.sourcePath, attachment.filename]),
      );
      const noteBytes = new TextEncoder().encode(`${marker}\n\n${prepared.markdown}`);
      const noteGitSha = await gitBlobSha(noteBytes);
      const noteName = await resolveNoteName(state, title, bookId, noteGitSha, marker);
      const targetNotePath = `${OBSIDIAN_BOOKS_DIR}/${noteName}`;
      const imagesCurrent = imageRecords.every((record) => (
        state.attachments.get(finalFilenameBySource.get(record.sourcePath)) === record.gitSha
      ));
      if (imagesCurrent && state.notes.get(noteName) === noteGitSha) {
        reportProgress(onProgress, 'complete', 'This book is already up to date in Obsidian.', 100);
        return {
          changed: false,
          commitSha: state.headSha,
          notePath: targetNotePath,
          noteUrl: noteUrl(targetNotePath),
          attachmentCount: imageRecords.length,
        };
      }

      const entries = [];
      const uploadsNeeded = imageRecords.filter((record) => (
        state.attachments.get(finalFilenameBySource.get(record.sourcePath)) !== record.gitSha
      ));
      let uploaded = 0;
      await mapWithConcurrency(uploadsNeeded, BLOB_UPLOAD_CONCURRENCY, async (record) => {
        const sha = await ensureBlob(record);
        const filename = finalFilenameBySource.get(record.sourcePath);
        entries.push({
          path: `${OBSIDIAN_ATTACHMENTS_DIR}/${filename}`,
          mode: '100644',
          type: 'blob',
          sha,
        });
        uploaded += 1;
        reportProgress(
          onProgress,
          'uploading',
          `Uploading attachments ${uploaded}/${uploadsNeeded.length}...`,
          48 + Math.round((uploaded / Math.max(1, uploadsNeeded.length)) * 37),
          { completed: uploaded, total: uploadsNeeded.length },
        );
      });

      for (const record of imageRecords) {
        const filename = finalFilenameBySource.get(record.sourcePath);
        if (state.attachments.get(filename) === record.gitSha) {
          entries.push({
            path: `${OBSIDIAN_ATTACHMENTS_DIR}/${filename}`,
            mode: '100644',
            type: 'blob',
            sha: record.gitSha,
          });
        }
      }

      reportProgress(onProgress, 'committing', 'Saving the Markdown note and attachments...', 88);
      const noteBlobSha = await createBlob(noteBytes);
      entries.push({
        path: targetNotePath,
        mode: '100644',
        type: 'blob',
        sha: noteBlobSha,
      });
      const uniqueEntries = [...new Map(entries.map((entry) => [entry.path, entry])).values()]
        .sort((a, b) => a.path.localeCompare(b.path));

      const tree = await githubApi(repositoryPath('/git/trees'), {
        method: 'POST',
        body: JSON.stringify({ base_tree: state.rootTreeSha, tree: uniqueEntries }),
      });
      if (!tree?.sha) throw new Error('Failed to create the Obsidian vault update.');

      const commit = await githubApi(repositoryPath('/git/commits'), {
        method: 'POST',
        body: JSON.stringify({
          message: `sync(gitshelf): ${title || bookId}`,
          tree: tree.sha,
          parents: [state.headSha],
        }),
      });
      if (!commit?.sha) throw new Error('Failed to create the Obsidian vault commit.');

      try {
        await githubApi(repositoryPath(`/git/refs/heads/${OBSIDIAN_REPOSITORY.branch}`), {
          method: 'PATCH',
          body: JSON.stringify({ sha: commit.sha, force: false }),
        });
        reportProgress(onProgress, 'complete', 'Book synced to Obsidian.', 100);
        return {
          changed: true,
          commitSha: commit.sha,
          notePath: targetNotePath,
          noteUrl: noteUrl(targetNotePath),
          attachmentCount: imageRecords.length,
        };
      } catch (error) {
        if (!isRetryableRefError(error)) throw error;
        if (attempt === MAX_SYNC_ATTEMPTS) {
          throw new Error('The Obsidian vault kept changing. Wait for its backup to finish and try again.');
        }
        reportProgress(
          onProgress,
          'retrying',
          `The vault changed during sync. Retrying safely (${attempt + 1}/${MAX_SYNC_ATTEMPTS})...`,
          45,
        );
      }
    }

    throw new Error('The Obsidian vault kept changing. Wait for its backup to finish and try again.');
  } catch (error) {
    throw friendlySyncError(error);
  }
}
