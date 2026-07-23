import { describe, expect, it } from 'vitest';
import {
  bookImageUrl,
  createTextOnlyMarkdown,
  mergeChapterMarkdown,
  prepareMarkdownForObsidian,
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

  it('prepares Markdown and HTML image references for the Obsidian attachment folder', () => {
    const markdown = [
      '![封面](../images/cover.png)',
      '![图表](books/my-book/images/charts/figure.jpg "说明")',
      '<img class="wide" src="./images/inline.webp" alt="插图">',
    ].join('\n');
    const result = prepareMarkdownForObsidian(markdown, 'my-book');

    expect(result.markdown).toContain(
      '![封面](<../../99 附件/默认附件/my-book--cover.png>)',
    );
    expect(result.markdown).toContain(
      '![图表](<../../99 附件/默认附件/my-book--charts--figure.jpg> "说明")',
    );
    expect(result.markdown).toContain(
      '<img class="wide" src="../../99 附件/默认附件/my-book--inline.webp" alt="插图">',
    );
    expect(result.imagePaths).toEqual([
      'cover.png',
      'charts/figure.jpg',
      'inline.webp',
    ]);
    expect(result.imageFilenames).toEqual([
      'my-book--cover.png',
      'my-book--charts--figure.jpg',
      'my-book--inline.webp',
    ]);
    expect(result.attachments).toEqual([
      { sourcePath: 'cover.png', filename: 'my-book--cover.png' },
      { sourcePath: 'charts/figure.jpg', filename: 'my-book--charts--figure.jpg' },
      { sourcePath: 'inline.webp', filename: 'my-book--inline.webp' },
    ]);
  });

  it('keeps remote images unchanged when preparing Markdown for Obsidian', () => {
    const markdown = [
      '![Remote](https://example.com/image.png)',
      '<img src="//cdn.example.com/image.jpg" alt="Remote">',
    ].join('\n');
    const result = prepareMarkdownForObsidian(markdown, 'my-book');

    expect(result.markdown).toBe(markdown);
    expect(result.attachments).toEqual([]);
  });

  it('handles angle-bracket paths with parentheses and URL-encoded spaces', () => {
    const markdown = [
      '![Plan](<../images/floor plan (1).png>)',
      '![Chart](../images/chart%202.png)',
    ].join('\n');
    const result = prepareMarkdownForObsidian(markdown, 'design-book');

    expect(result.imagePaths).toEqual(['floor plan (1).png', 'chart 2.png']);
    expect(result.markdown).toContain(
      '![Plan](<../../99 附件/默认附件/design-book--floor plan (1).png>)',
    );
    expect(result.markdown).toContain(
      '![Chart](<../../99 附件/默认附件/design-book--chart 2.png>)',
    );
    expect(bookImageUrl('design-book', result.imagePaths[1]))
      .toBe('./books/design-book/images/chart%202.png');
    expect(prepareMarkdownWithImages(markdown, 'design-book').markdown).toContain(
      '![Plan](<images/floor plan (1).png>)',
    );
  });

  it('keeps content-hash filenames flat and applies final filename overrides', () => {
    const hashName = `${'a'.repeat(64)}.png`;
    const markdown = [
      `![Hash](../images/${hashName})`,
      '![Nested](<../images/chapter one/figure.png>)',
      '<img src="images/chart.png" alt="Chart">',
    ].join('\n');
    const result = prepareMarkdownForObsidian(
      markdown,
      '中文 书籍',
      new Map([
        ['chapter one/figure.png', 'figure--uploaded (2).png'],
      ]),
    );

    expect(result.imageFilenames).toEqual([
      hashName,
      'figure--uploaded (2).png',
      '中文 书籍--chart.png',
    ]);
    expect(result.markdown).toContain(
      `![Hash](<../../99 附件/默认附件/${hashName}>)`,
    );
    expect(result.markdown).toContain(
      '![Nested](<../../99 附件/默认附件/figure--uploaded (2).png>)',
    );
    expect(result.markdown).toContain(
      '<img src="../../99 附件/默认附件/中文 书籍--chart.png" alt="Chart">',
    );
  });
});
