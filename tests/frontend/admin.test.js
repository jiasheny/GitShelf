import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdminPanel from '../../src/components/AdminView';
import { clearPat, setPat } from '../../src/lib/github-api';

function createGithubResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(data),
    json: async () => data,
  };
}

function encodeRepositoryJson(value) {
  return {
    sha: 'sha-current',
    content: btoa(unescape(encodeURIComponent(JSON.stringify(value, null, 2) + '\n'))),
  };
}

function createAdminFetch(options = {}) {
  const config = options;

  return vi.fn(async (url, requestOptions = {}) => {
    const target = String(url);
    const method = requestOptions.method || 'GET';

    if (target === 'https://api.github.com/user') {
      return createGithubResponse({ login: 'owner' });
    }

    if (target === 'https://api.github.com/repos/owner/repo') {
      return createGithubResponse({ full_name: 'owner/repo' });
    }

    if (target.startsWith('https://api.github.com/repos/owner/repo/actions/workflows/convert.yml/runs?')) {
      return createGithubResponse({ workflow_runs: [] });
    }

    if (target === 'https://api.github.com/repos/owner/repo/contents/docs/catalog-metadata.json') {
      return createGithubResponse(encodeRepositoryJson(config.metadataPayload || { version: 1, items: [] }));
    }

    if (target === 'https://api.github.com/repos/owner/repo/contents/docs/catalog.json') {
      return createGithubResponse(encodeRepositoryJson(config.catalogPayload || { version: 1, items: [] }));
    }

    if (target === 'https://api.github.com/repos/owner/repo/contents/docs/failures.json') {
      return createGithubResponse({}, 404);
    }

    if (target === 'https://api.github.com/repos/owner/repo/contents/input/archived') {
      return createGithubResponse([]);
    }

    if (target === 'https://api.github.com/repos/owner/repo/git/ref/heads/main') {
      return createGithubResponse({ object: { sha: 'commit-base' } });
    }

    if (target === 'https://api.github.com/repos/owner/repo/git/commits/commit-base') {
      return createGithubResponse({ sha: 'commit-base', tree: { sha: 'tree-base' } });
    }

    if (target === 'https://api.github.com/repos/owner/repo/git/trees' && method === 'POST') {
      return createGithubResponse({ sha: 'tree-next' });
    }

    if (target === 'https://api.github.com/repos/owner/repo/git/commits' && method === 'POST') {
      return createGithubResponse({ sha: 'commit-next' });
    }

    if (target === 'https://api.github.com/repos/owner/repo/git/refs/heads/main' && method === 'PATCH') {
      return createGithubResponse({ ref: 'refs/heads/main', object: { sha: 'commit-next' } });
    }

    throw new Error(`Unexpected fetch request: ${method} ${target}`);
  });
}

describe('frontend admin flows', () => {
  beforeEach(() => {
    cleanup();
    clearPat();
    localStorage.clear();
    sessionStorage.clear();
    document.documentElement.setAttribute('data-theme', 'light');
    window.location.hash = '#/admin';
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('authenticates without tripping hook-order errors and then loads the content catalog', async () => {
    localStorage.setItem('admin_repo_owner', 'owner');
    localStorage.setItem('admin_repo_name', 'repo');
    global.fetch = createAdminFetch({
      catalogPayload: {
        version: 1,
        items: [
          { id: 'book-1', type: 'book', title: 'Generated One', visibility: 'published', source: 'book-1.pdf' },
        ],
      },
    });

    render(<AdminPanel />);

    fireEvent.input(screen.getByLabelText('GitHub Personal Access Token'), {
      target: { value: 'token' },
    });
    fireEvent.submit(screen.getByRole('button', { name: 'Save Token' }).closest('form'));

    expect(await screen.findByText('Content Catalog')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Content' })).toHaveAttribute('aria-selected', 'true');
  });

  it('renders type-aware links from catalog items and only exposes re-process for books', async () => {
    setPat('token');
    localStorage.setItem('admin_repo_owner', 'owner');
    localStorage.setItem('admin_repo_name', 'repo');
    global.fetch = createAdminFetch({
      catalogPayload: {
        version: 1,
        items: [
          { id: 'book-1', type: 'book', title: 'Book One', visibility: 'published', source: 'book-1.pdf', updated_at: '2026-03-29T00:00:00Z' },
          { id: 'doc-1', type: 'doc', title: 'Doc One', visibility: 'hidden', source: 'doc-1.md', updated_at: '2026-03-29T00:00:00Z' },
          { id: 'site-1', type: 'site', title: 'Site One', visibility: 'published', source: 'site-1.zip', entry: 'sites/site-1/index.html', updated_at: '2026-03-29T00:00:00Z' },
        ],
      },
    });

    render(<AdminPanel />);

    expect((await screen.findAllByText('Book One')).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: 'Book One' })[0]).toHaveAttribute('href', '#/books/book-1');
    expect(screen.getAllByRole('link', { name: 'Doc One' })[0]).toHaveAttribute('href', '#/articles/doc-1');
    expect(screen.getAllByRole('link', { name: 'Site One' })[0]).toHaveAttribute('href', '#/sites/site-1');

    fireEvent.click(screen.getAllByLabelText('More actions')[0]);
    expect(await screen.findByText('Re-process')).toBeInTheDocument();

    fireEvent.click(screen.getAllByLabelText('More actions')[1]);
    await waitFor(() => expect(screen.getAllByText('Force Delete').length).toBeGreaterThan(0));
    expect(screen.getAllByText('Re-process').length).toBe(1);
  });
});
