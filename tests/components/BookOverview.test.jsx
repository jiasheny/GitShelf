import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { strFromU8, unzipSync } from 'fflate';
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
    if (value.includes('/images/diagram.png')) {
      return Promise.resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(Uint8Array.from([1, 2, 3]).buffer),
      });
    }
    const content = value.includes('one.md')
      ? '# One\n\n![Diagram](../images/diagram.png)'
      : '# Two';
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

describe('BookOverview Markdown downloads', () => {
  it('downloads all chapters as one text-only Markdown file', async () => {
    render(<BookOverview bookId="my-book" onTocLoaded={() => {}} />);

    const button = await screen.findByRole('button', { name: 'Download text-only MD' });
    fireEvent.click(button);

    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledOnce());
    const blob = URL.createObjectURL.mock.calls[0][0];
    expect(await blob.text()).toBe('# One\n\nDiagram\n\n---\n\n# Two\n');
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:markdown');
  });

  it('downloads Markdown and referenced images in a ZIP', async () => {
    render(<BookOverview bookId="my-book" onTocLoaded={() => {}} />);

    const button = await screen.findByRole('button', { name: 'Download MD + Images (ZIP)' });
    fireEvent.click(button);

    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledOnce());
    const blob = URL.createObjectURL.mock.calls[0][0];
    const archive = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    expect(Object.keys(archive).sort()).toEqual(['My Book.md', 'images/diagram.png']);
    expect(strFromU8(archive['My Book.md'])).toContain('![Diagram](images/diagram.png)');
    expect([...archive['images/diagram.png']]).toEqual([1, 2, 3]);
    expect(global.fetch).toHaveBeenCalledWith('./books/my-book/images/diagram.png');
  });
});
