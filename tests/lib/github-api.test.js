import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPat,
  fetchConversionStatus,
  getPat,
  githubApi,
  setPat,
} from '../../src/lib/github-api';

function response(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (data == null ? '' : JSON.stringify(data)),
  };
}

describe('GitHub credential handling', () => {
  beforeEach(() => {
    clearPat();
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('keeps new tokens in memory only', () => {
    setPat('secret-token');

    expect(getPat()).toBe('secret-token');
    expect(localStorage.getItem('github_pat')).toBeNull();
    expect(sessionStorage.getItem('github_pat')).toBeNull();
  });

  it('removes rather than reusing a token persisted by an older release', () => {
    localStorage.setItem('github_pat', 'legacy-token');

    expect(getPat()).toBe('');
    expect(localStorage.getItem('github_pat')).toBeNull();
    expect(sessionStorage.getItem('github_pat')).toBeNull();
  });

  it('never sends a token outside the exact GitHub API origin', async () => {
    setPat('secret-token');
    global.fetch = vi.fn();

    await expect(githubApi('https://api.github.com.evil.example/user')).rejects.toThrow(
      'https://api.github.com',
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('conversion tracking', () => {
  const repo = { owner: 'owner', name: 'repo' };
  const job = {
    commitSha: 'upload-sha',
    filename: 'book.pdf',
    queuedAt: new Date().toISOString(),
  };

  beforeEach(() => {
    clearPat();
    setPat('secret-token');
    vi.restoreAllMocks();
  });

  it('reports queued while GitHub is creating the workflow run', async () => {
    global.fetch = vi.fn(async () => response({ workflow_runs: [] }));

    await expect(fetchConversionStatus(repo, job)).resolves.toMatchObject({
      stage: 'queued',
      percent: 8,
    });
  });

  it('maps the active Process content step to a user-facing status', async () => {
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('/runs?')) {
        return response({ workflow_runs: [{
          id: 42,
          head_sha: 'upload-sha',
          status: 'in_progress',
          html_url: 'https://github.example/run/42',
        }] });
      }
      if (String(url).includes('/runs/42/jobs')) {
        return response({ jobs: [{ steps: [{ name: 'Process content', status: 'in_progress' }] }] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    await expect(fetchConversionStatus(repo, job)).resolves.toMatchObject({
      stage: 'processing',
      percent: 58,
      runUrl: 'https://github.example/run/42',
    });
  });

  it('reports complete only after the Pages deployment succeeds', async () => {
    global.fetch = vi.fn(async (url) => {
      const target = String(url);
      if (target.includes('/convert.yml/runs?')) {
        return response({ workflow_runs: [{
          id: 42,
          head_sha: 'upload-sha',
          status: 'completed',
          conclusion: 'success',
          created_at: '2026-07-17T10:00:02Z',
          updated_at: '2026-07-17T10:10:00Z',
          html_url: 'https://github.example/run/42',
        }] });
      }
      if (target.includes('/contents/docs/failures.json')) return response({ message: 'Not Found' }, 404);
      if (target.includes('/commits?')) {
        return response([{
          sha: 'result-sha',
          commit: {
            message: 'feat(pipeline): process books\n\nGitShelf-Source: upload-sha',
            committer: { date: '2026-07-17T10:10:01Z' },
          },
        }]);
      }
      if (target.includes('/deploy-pages.yml/runs?')) {
        return response({ workflow_runs: [{
          head_sha: 'result-sha',
          status: 'completed',
          conclusion: 'success',
          created_at: '2026-07-17T10:10:01Z',
          html_url: 'https://github.example/deploy/1',
        }] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    await expect(fetchConversionStatus(repo, job)).resolves.toMatchObject({
      stage: 'complete',
      percent: 100,
      deployUrl: 'https://github.example/deploy/1',
    });
  });

  it('does not accept a successful deployment for an unrelated commit', async () => {
    const now = new Date().toISOString();
    global.fetch = vi.fn(async (url) => {
      const target = String(url);
      if (target.includes('/convert.yml/runs?')) {
        return response({ workflow_runs: [{
          id: 42,
          head_sha: 'upload-sha',
          status: 'completed',
          conclusion: 'success',
          html_url: 'https://github.example/run/42',
        }] });
      }
      if (target.includes('/contents/docs/failures.json')) return response({ message: 'Not Found' }, 404);
      if (target.includes('/commits?')) {
        return response([{
          sha: 'result-sha',
          commit: {
            message: 'GitShelf-Source: upload-sha',
            committer: { date: now },
          },
        }]);
      }
      if (target.includes('/deploy-pages.yml/runs?')) {
        return response({ workflow_runs: [{
          head_sha: 'unrelated-sha',
          status: 'completed',
          conclusion: 'success',
        }] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    await expect(fetchConversionStatus(repo, job)).resolves.toMatchObject({
      stage: 'deploying',
    });
  });

  it('does not attribute an unrelated failure record to the current upload', async () => {
    global.fetch = vi.fn(async (url) => {
      const target = String(url);
      if (target.includes('/convert.yml/runs?')) {
        return response({ workflow_runs: [{
          id: 42,
          head_sha: 'upload-sha',
          status: 'completed',
          conclusion: 'failure',
          html_url: 'https://github.example/run/42',
        }] });
      }
      if (target.includes('/contents/docs/failures.json')) {
        return response({
          sha: 'failure-sha',
          content: btoa(JSON.stringify({ failures: [{ filename: 'another.pdf', error: 'Other error' }] })),
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    await expect(fetchConversionStatus(repo, job)).resolves.toMatchObject({
      stage: 'failed',
      message: 'Conversion failure. Open the log for details.',
    });
  });
});
