import { describe, it, expect, vi, beforeEach } from 'vitest';
import { uploadContent } from '../../src/lib/github-api';

class FakeXMLHttpRequest {
  static latest;

  constructor() {
    FakeXMLHttpRequest.latest = this;
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
    this.upload.onprogress({ lengthComputable: true, loaded: 50, total: 100 });
    this.onload();
  }
}

beforeEach(() => {
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
});
