import { describe, it, expect } from 'vitest';
import { _normalizeBullets as normalizeBullets, renderMarkdown } from '../../src/lib/markdown';

describe('normalizeBullets', () => {
  it('converts • to list syntax', () => {
    expect(normalizeBullets('• item one\n• item two')).toBe('- item one\n- item two');
  });

  it('converts other bullet characters (◦ ▪ ▸ ‣)', () => {
    expect(normalizeBullets('◦ sub\n▪ sub\n▸ sub\n‣ sub')).toBe('- sub\n- sub\n- sub\n- sub');
  });

  it('preserves indentation', () => {
    expect(normalizeBullets('  • nested\n    • deeper')).toBe('  - nested\n    - deeper');
  });

  it('leaves normal text untouched', () => {
    const text = 'No bullets here.\nJust regular text.';
    expect(normalizeBullets(text)).toBe(text);
  });

  it('does not convert bullets inside fenced code blocks', () => {
    const text = '• outside\n```\n• inside code\n```\n• outside again';
    expect(normalizeBullets(text)).toBe('- outside\n```\n• inside code\n```\n- outside again');
  });

  it('does not convert bullets inside ~~~ code blocks', () => {
    const text = '~~~\n• inside\n~~~';
    expect(normalizeBullets(text)).toBe('~~~\n• inside\n~~~');
  });

  it('does not convert bullets inside $$ math blocks', () => {
    const text = '• before\n$$\n• in math\n$$\n• after';
    expect(normalizeBullets(text)).toBe('- before\n$$\n• in math\n$$\n- after');
  });

  it('handles unclosed code block (protects to end of text)', () => {
    const text = '• before\n```\n• inside unclosed';
    expect(normalizeBullets(text)).toBe('- before\n```\n• inside unclosed');
  });

  it('handles bullet mid-line (no conversion)', () => {
    const text = 'This has a • bullet in the middle';
    expect(normalizeBullets(text)).toBe(text);
  });
});

describe('renderMarkdown security', () => {
  it('removes scripts, event handlers, and unquoted javascript URLs', () => {
    const html = renderMarkdown('<script>alert(1)</script><img src=x onerror=alert(2)><a href=javascript:alert(3)>bad</a>');
    const container = document.createElement('div');
    container.innerHTML = html;

    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).not.toHaveAttribute('onerror');
    expect(container.querySelector('a')).not.toHaveAttribute('href');
    expect(html.toLowerCase()).not.toContain('javascript:');
  });

  it('blocks dangerous SVG and inline styling while preserving tables', () => {
    const html = renderMarkdown('<svg><a href="javascript:alert(1)">x</a></svg><p style="background:url(javascript:alert(2))">text</p>\n\n| A | B |\n| - | - |\n| 1 | 2 |');
    const container = document.createElement('div');
    container.innerHTML = html;

    expect(html.toLowerCase()).not.toContain('javascript:');
    expect(container.querySelector('p')).not.toHaveAttribute('style');
    expect(container.querySelector('table')).not.toBeNull();
  });
});
