import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { BookOverview } from '../../src/components/BookOverview';

function mockFetch() {
  return vi.fn((url) => {
    const value = String(url);
    if (value.includes('toc.json')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          title: 'My Book',
          children: [
            { title: 'One', slug: 'one' },
            { title: 'Two', slug: 'two' },
          ],
        }),
      });
    }
    if (value.includes('manifest.json')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          items: [{ id: 'my-book', title: 'My Book', chapters_count: 2 }],
        }),
      });
    }
    const content = value.includes('one.md') ? '# One' : '# Two';
    return Promise.resolve({
      ok: true,
      text: () => Promise.resolve(content),
    });
  });
}

beforeEach(() => {
  global.fetch = mockFetch();
  URL.createObjectURL = vi.fn(() => 'blob:markdown');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BookOverview Markdown download', () => {
  it('downloads all chapters as one Markdown file', async () => {
    render(<BookOverview bookId="my-book" onTocLoaded={() => {}} />);

    const button = await screen.findByRole('button', { name: 'Download Markdown' });
    fireEvent.click(button);

    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledOnce());
    const blob = URL.createObjectURL.mock.calls[0][0];
    expect(await blob.text()).toBe('# One\n\n---\n\n# Two\n');
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:markdown');
  });
});
