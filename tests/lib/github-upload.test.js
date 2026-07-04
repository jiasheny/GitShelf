import { describe, it, expect, vi, beforeEach } from 'vitest';
import { uploadContent } from '../../src/lib/github-api';

class FakeXMLHttpRequest {
  static latest;
  static instances = [];

  constructor() {
    FakeXMLHttpRequest.latest = this;
    FakeXMLHttpRequest.instances.push(this);
    this.upload = {};
    this.status = 201;
    this.responseText = JSON.stringify({ content: { path: 'input/book.pdf' } });
  }

  open(method, url) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader() {}

  send(body) {
    this.body = JSON.parse(body);
    if (this.method === 'POST' && this.url.endsWith('/git/blobs')) {
      this.responseText = JSON.stringify({ sha: 'uploaded-blob-sha' });
    }
    this.upload.onprogress({ lengthComputable: true, loaded: 50, total: 100 });
    this.onload();
  }
}

beforeEach(() => {
  FakeXMLHttpRequest.instances = [];
  localStorage.setItem('github_pat', 'token');
  global.XMLHttpRequest = FakeXMLHttpRequest;
  global.fetch = vi.fn(async () => ({
    ok: false,
    status: 404,
    text: async () => '{}',
  }));
});

describe('uploadContent progress', () => {
  it('reports upload progress and commits through the GitHub contents API', async () => {
    const updates = [];
    const file = new File(['hello'], 'book.pdf', { type: 'application/pdf' });

    await uploadContent(file, { owner: 'owner', name: 'repo' }, (stage, msg, details) => {
      updates.push({ stage, msg, ...details });
    });

    expect(FakeXMLHttpRequest.latest.method).toBe('PUT');
    expect(FakeXMLHttpRequest.latest.url).toContain('/repos/owner/repo/contents/input/book.pdf');
    expect(FakeXMLHttpRequest.latest.body.message).toBe('feat(pipeline): upload book.pdf');
    expect(updates).toContainEqual(expect.objectContaining({
      stage: 'uploading',
      uploadPercent: 50,
      percent: 60,
    }));
    expect(updates.at(-1)).toEqual(expect.objectContaining({ stage: 'done', percent: 100 }));
  });

  it('uses Git blobs and one atomic commit for PDFs over 100 MB', async () => {
    const file = new File(['small test payload'], 'large.pdf', { type: 'application/pdf' });
    Object.defineProperty(file, 'size', { value: 101 * 1024 * 1024 });

    global.fetch = vi.fn(async (url, options = {}) => {
      let payload = {};
      if (url.includes('/git/ref/heads/main')) payload = { object: { sha: 'parent-sha' } };
      else if (url.includes('/git/commits/parent-sha')) payload = { tree: { sha: 'base-tree-sha' } };
      else if (url.endsWith('/git/blobs')) payload = { sha: 'manifest-blob-sha' };
      else if (url.endsWith('/git/trees')) payload = { sha: 'new-tree-sha' };
      else if (url.endsWith('/git/commits')) payload = { sha: 'new-commit-sha' };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(payload),
      };
    });

    await uploadContent(file, { owner: 'owner', name: 'repo' }, () => {});

    const blobRequest = FakeXMLHttpRequest.instances.find((request) => (
      request.method === 'POST' && request.url.endsWith('/git/blobs')
    ));
    expect(blobRequest).toBeTruthy();
    expect(FakeXMLHttpRequest.instances.some((request) => request.url.includes('/contents/uploads/'))).toBe(false);

    const treeCall = global.fetch.mock.calls.find(([url]) => url.endsWith('/git/trees'));
    const treeBody = JSON.parse(treeCall[1].body);
    expect(treeBody.tree).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: expect.stringMatching(/^uploads\/.+\/part-00001\.part$/), sha: 'uploaded-blob-sha' }),
      expect.objectContaining({ path: expect.stringMatching(/^input\/.+\.parts\.json$/), sha: 'manifest-blob-sha' }),
    ]));
  });
});
