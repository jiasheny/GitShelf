import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { strFromU8, unzipSync } from 'fflate';
import { BookOverview } from '../../src/components/BookOverview';

const syncBookToObsidianMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/lib/obsidianSync', () => ({
  syncBookToObsidian: syncBookToObsidianMock,
}));

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
  syncBookToObsidianMock.mockReset();
  syncBookToObsidianMock.mockResolvedValue({
    changed: true,
    noteUrl: 'https://github.example/obsidian/note',
  });
  URL.createObjectURL = vi.fn(() => 'blob:markdown');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BookOverview Markdown downloads', () => {
  it('finds the first readable chapter inside nested TOC groups', async () => {
    global.fetch = vi.fn((url) => {
      if (String(url).includes('toc.json')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            title: 'Nested Book',
            children: [{ title: 'Part One', children: [{ title: 'Chapter One', slug: 'chapter-one' }] }],
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ items: [{ id: 'my-book', title: 'Nested Book' }] }),
      });
    });

    render(<BookOverview bookId="my-book" onTocLoaded={() => {}} />);

    expect(await screen.findByRole('link', { name: 'Start Reading' })).toHaveAttribute(
      'href',
      '#/books/my-book/chapter-one',
    );
    expect(screen.getByText('Part One').closest('a')).toBeNull();
    expect(screen.getByRole('link', { name: /Chapter One/ })).toHaveAttribute(
      'href',
      '#/books/my-book/chapter-one',
    );
  });

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

  it('syncs merged Markdown to Obsidian and links to the resulting note', async () => {
    syncBookToObsidianMock.mockImplementation(async (book, onProgress) => {
      onProgress({ stage: 'uploading', message: 'Uploading attachments 1/1...', percent: 70 });
      return {
        changed: true,
        noteUrl: 'https://github.example/obsidian/note',
      };
    });
    render(<BookOverview bookId="my-book" onTocLoaded={() => {}} />);

    const button = await screen.findByRole('button', { name: 'Sync to Obsidian' });
    fireEvent.click(button);

    await waitFor(() => expect(syncBookToObsidianMock).toHaveBeenCalledOnce());
    expect(syncBookToObsidianMock.mock.calls[0][0]).toMatchObject({
      bookId: 'my-book',
      title: 'My Book',
      markdown: '# One\n\n![Diagram](../images/diagram.png)\n\n---\n\n# Two\n',
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Synced to Obsidian.');
    expect(screen.getByRole('link', { name: 'Open note' })).toHaveAttribute(
      'href',
      'https://github.example/obsidian/note',
    );
  });
});
