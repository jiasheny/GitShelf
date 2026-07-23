import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  githubApi: vi.fn(),
  fetchBookImages: vi.fn(),
}));

vi.mock('../../src/lib/github-api', () => ({
  githubApi: mocks.githubApi,
}));

vi.mock('../../src/lib/bookDownload', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchBookImages: mocks.fetchBookImages,
  };
});

import {
  OBSIDIAN_ATTACHMENTS_DIR,
  OBSIDIAN_BOOKS_DIR,
  syncBookToObsidian,
} from '../../src/lib/obsidianSync';

function apiError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function installGithubApi({
  attachmentEntries = [],
  noteEntries = [],
  noteBlobContents = {},
  patchFailures = 0,
  patchError = null,
} = {}) {
  let refReads = 0;
  let blobNumber = 0;
  let treeNumber = 0;
  let commitNumber = 0;
  let patchCalls = 0;

  mocks.githubApi.mockImplementation(async (path, options = {}) => {
    const method = options.method || 'GET';
    if (path === '/repos/jiasheny/obsidian-vault') return { permissions: { push: true } };
    if (path.endsWith('/git/ref/heads/main') && method === 'GET') {
      refReads += 1;
      return { object: { sha: `head-${refReads}` } };
    }
    if (path.includes('/git/commits/head-') && method === 'GET') {
      return { tree: { sha: `root-${refReads}` } };
    }
    if (path.includes('/git/trees/root-') && method === 'GET') {
      return {
        tree: [
          { path: '20 学习', type: 'tree', sha: 'tree-learning' },
          { path: '99 附件', type: 'tree', sha: 'tree-attachments' },
        ],
      };
    }
    if (path.endsWith('/git/trees/tree-learning') && method === 'GET') {
      return { tree: [{ path: '34 书籍', type: 'tree', sha: 'tree-books' }] };
    }
    if (path.endsWith('/git/trees/tree-attachments') && method === 'GET') {
      return { tree: [{ path: '默认附件', type: 'tree', sha: 'tree-default-attachments' }] };
    }
    if (path.endsWith('/git/trees/tree-books') && method === 'GET') {
      return { tree: noteEntries };
    }
    if (path.endsWith('/git/trees/tree-default-attachments') && method === 'GET') {
      return { tree: attachmentEntries };
    }
    if (path.includes('/git/blobs/') && method === 'GET') {
      const sha = path.split('/').at(-1);
      return {
        encoding: 'base64',
        content: btoa(noteBlobContents[sha] || ''),
      };
    }
    if (path.endsWith('/git/blobs') && method === 'POST') {
      blobNumber += 1;
      return { sha: `uploaded-blob-${blobNumber}` };
    }
    if (path.endsWith('/git/trees') && method === 'POST') {
      treeNumber += 1;
      return { sha: `new-tree-${treeNumber}` };
    }
    if (path.endsWith('/git/commits') && method === 'POST') {
      commitNumber += 1;
      return { sha: `new-commit-${commitNumber}` };
    }
    if (path.endsWith('/git/refs/heads/main') && method === 'PATCH') {
      patchCalls += 1;
      if (patchError && patchCalls === 1) throw patchError;
      if (patchCalls <= patchFailures) throw apiError('Reference changed', 422);
      return { object: { sha: `new-commit-${commitNumber}` } };
    }
    throw new Error(`Unexpected GitHub API call: ${method} ${path}`);
  });
}

function decodeBlobRequest(call) {
  const payload = JSON.parse(call[1].body);
  const binary = atob(payload.content);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchBookImages.mockImplementation(async (_bookId, paths, onProgress) => {
    const images = new Map();
    paths.forEach((path, index) => {
      images.set(path, Uint8Array.from([index + 1, 2, 3]));
      onProgress(index + 1, paths.length);
    });
    return images;
  });
});

describe('Obsidian repository sync', () => {
  it('writes the merged note and images to the exact vault folders in one commit', async () => {
    installGithubApi();

    const result = await syncBookToObsidian({
      bookId: 'my-book',
      title: '我的书',
      markdown: '# Title\n\n![图](../images/charts/figure.png)\n',
    });

    const treeCall = mocks.githubApi.mock.calls.find(([path, options]) => (
      path.endsWith('/git/trees') && options.method === 'POST'
    ));
    const treeBody = JSON.parse(treeCall[1].body);
    expect(treeBody.tree).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: `${OBSIDIAN_ATTACHMENTS_DIR}/my-book--charts--figure.png`,
      }),
      expect.objectContaining({
        path: `${OBSIDIAN_BOOKS_DIR}/我的书.md`,
      }),
    ]));

    const blobCalls = mocks.githubApi.mock.calls.filter(([path, options]) => (
      path.endsWith('/git/blobs') && options.method === 'POST'
    ));
    expect(decodeBlobRequest(blobCalls.at(-1))).toContain(
      '![图](<../../99 附件/默认附件/my-book--charts--figure.png>)',
    );
    expect(decodeBlobRequest(blobCalls.at(-1))).toContain(
      '<!-- gitshelf-book-id:my-book -->',
    );
    expect(result).toMatchObject({
      changed: true,
      notePath: `${OBSIDIAN_BOOKS_DIR}/我的书.md`,
      attachmentCount: 1,
    });
  });

  it('does not overwrite a different attachment that already uses a hash filename', async () => {
    const hashName = `${'a'.repeat(64)}.jpg`;
    installGithubApi({
      attachmentEntries: [
        { path: hashName, type: 'blob', sha: 'different-content' },
        { path: `fire-book--${hashName}`, type: 'blob', sha: 'another-different-file' },
      ],
    });

    await syncBookToObsidian({
      bookId: 'fire-book',
      title: 'Fire Book',
      markdown: `![Figure](../images/${hashName})`,
    });

    const treeCall = mocks.githubApi.mock.calls.find(([path, options]) => (
      path.endsWith('/git/trees') && options.method === 'POST'
    ));
    const treeBody = JSON.parse(treeCall[1].body);
    const attachmentPath = treeBody.tree
      .map((entry) => entry.path)
      .find((path) => path.startsWith(`${OBSIDIAN_ATTACHMENTS_DIR}/`));
    expect(attachmentPath).toMatch(
      new RegExp(`^${OBSIDIAN_ATTACHMENTS_DIR}/fire-book--[0-9a-f]{12}--${hashName}$`),
    );
  });

  it('does not overwrite a same-title note unless it was created by this book sync', async () => {
    installGithubApi({
      noteEntries: [{ path: '我的书.md', type: 'blob', sha: 'personal-note' }],
      noteBlobContents: { 'personal-note': '# My handwritten notes' },
    });

    const result = await syncBookToObsidian({
      bookId: 'my-book',
      title: '我的书',
      markdown: '# Imported book',
    });

    const treeCall = mocks.githubApi.mock.calls.find(([path, options]) => (
      path.endsWith('/git/trees') && options.method === 'POST'
    ));
    const treeBody = JSON.parse(treeCall[1].body);
    expect(treeBody.tree).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: `${OBSIDIAN_BOOKS_DIR}/我的书--GitShelf.md` }),
    ]));
    expect(treeBody.tree).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: `${OBSIDIAN_BOOKS_DIR}/我的书.md` }),
    ]));
    expect(result.notePath).toBe(`${OBSIDIAN_BOOKS_DIR}/我的书--GitShelf.md`);
  });

  it('retries from the latest main branch when Obsidian Git updates concurrently', async () => {
    installGithubApi({ patchFailures: 1 });

    await syncBookToObsidian({
      bookId: 'plain-book',
      title: 'Plain Book',
      markdown: '# No images',
    });

    const patchCalls = mocks.githubApi.mock.calls.filter(([path, options]) => (
      path.endsWith('/git/refs/heads/main') && options.method === 'PATCH'
    ));
    const commitCalls = mocks.githubApi.mock.calls.filter(([path, options]) => (
      path.endsWith('/git/commits') && options.method === 'POST'
    ));
    expect(patchCalls).toHaveLength(2);
    expect(JSON.parse(commitCalls[0][1].body).parents).toEqual(['head-1']);
    expect(JSON.parse(commitCalls[1][1].body).parents).toEqual(['head-2']);
    expect(patchCalls.every(([, options]) => JSON.parse(options.body).force === false)).toBe(true);
  });

  it('explains how to grant access before downloading any book images', async () => {
    mocks.githubApi.mockRejectedValueOnce(apiError('Not Found', 404));

    await expect(syncBookToObsidian({
      bookId: 'private-book',
      title: 'Private Book',
      markdown: '![A](../images/a.png)',
    })).rejects.toThrow('Grant that repository Contents read/write access');
    expect(mocks.fetchBookImages).not.toHaveBeenCalled();
  });

  it('does not treat every validation error as a concurrent vault update', async () => {
    installGithubApi({
      patchError: apiError('Protected branch update failed', 422),
    });

    await expect(syncBookToObsidian({
      bookId: 'protected-book',
      title: 'Protected Book',
      markdown: '# Protected',
    })).rejects.toThrow('Check the vault branch rules');
    const patchCalls = mocks.githubApi.mock.calls.filter(([path, options]) => (
      path.endsWith('/git/refs/heads/main') && options.method === 'PATCH'
    ));
    expect(patchCalls).toHaveLength(1);
  });
});
