import { describe, expect, it } from 'vitest';
import {
  bookImageUrl,
  createTextOnlyMarkdown,
  mergeChapterMarkdown,
  prepareMarkdownWithImages,
} from '../../src/lib/bookDownload';

describe('book download helpers', () => {
  it('merges chapters with a visible separator', () => {
    expect(mergeChapterMarkdown(['# One\n', '', '# Two'])).toBe('# One\n\n---\n\n# Two\n');
  });

  it('removes Markdown and HTML images from the text-only version', () => {
    const markdown = '# Title\n\n![Figure 1](../images/a.png)\n\n<img src="images/b.jpg" alt="Figure 2">';
    expect(createTextOnlyMarkdown(markdown)).toBe('# Title\n\nFigure 1\n\nFigure 2\n');
  });

  it('rewrites local image references and keeps remote images unchanged', () => {
    const markdown = [
      '![A](../images/a.png)',
      '![B](books/my-book/images/nested/b.jpg "title")',
      '![Remote](https://example.com/c.png)',
      '<img src="./images/d.webp" alt="D">',
    ].join('\n');
    const result = prepareMarkdownWithImages(markdown, 'my-book');

    expect(result.markdown).toContain('![A](images/a.png)');
    expect(result.markdown).toContain('![B](images/nested/b.jpg "title")');
    expect(result.markdown).toContain('![Remote](https://example.com/c.png)');
    expect(result.markdown).toContain('<img src="images/d.webp" alt="D">');
    expect(result.imagePaths).toEqual(['a.png', 'nested/b.jpg', 'd.webp']);
  });

  it('encodes book and nested image paths for download', () => {
    expect(bookImageUrl('中文书', 'charts/图 1.png'))
      .toBe('./books/%E4%B8%AD%E6%96%87%E4%B9%A6/images/charts/%E5%9B%BE%201.png');
  });
});
