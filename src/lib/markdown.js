import markdownit from 'markdown-it';
import texmath from 'markdown-it-texmath';
import katex from 'katex';
import DOMPurify from 'dompurify';

function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const md = markdownit({ html: true, linkify: true, typographer: true });

function resolveImageSrc(src, assetBase) {
  const value = String(src || '').trim();
  if (!value || !assetBase) return value;

  if (
    value.startsWith('/') ||
    value.startsWith('#') ||
    value.startsWith('books/') ||
    value.startsWith('./books/') ||
    value.startsWith('../books/') ||
    value.startsWith('//') ||
    /^[a-z][a-z0-9+.-]*:/i.test(value)
  ) {
    return value;
  }

  const match = value.match(/^(?:\.\.\/|\.\/)*images\/(.+)$/);
  if (!match) return value;

  return `${assetBase.replace(/\/+$/, '')}/images/${match[1]}`;
}

md.use(texmath, { engine: katex, delimiters: 'dollars' });

const originalHeadingOpen =
  md.renderer.rules.heading_open ||
  function (tokens, idx, options, _env, self) {
    return self.renderToken(tokens, idx, options);
  };

md.renderer.rules.heading_open = function (tokens, idx, options, env, self) {
  const token = tokens[idx];
  const contentToken = tokens[idx + 1];
  if (contentToken && contentToken.children) {
    const text = contentToken.children
      .filter((child) => child.type === 'text' || child.type === 'code_inline')
      .map((child) => child.content)
      .join('');
    const id = slugify(text);
    token.attrSet('id', id);
    // Store slug for heading_close to generate anchor link
    env._headingSlug = id;
  }
  return originalHeadingOpen(tokens, idx, options, env, self);
};

// Inject anchor link at the end of heading content
const originalHeadingClose =
  md.renderer.rules.heading_close ||
  function (tokens, idx, options, _env, self) {
    return self.renderToken(tokens, idx, options);
  };

md.renderer.rules.heading_close = function (tokens, idx, options, env, self) {
  let anchorHtml = '';
  if (env._headingSlug) {
    const slug = md.utils.escapeHtml(env._headingSlug);
    anchorHtml = ` <a class="heading-anchor" data-anchor="${slug}" href="#${slug}" aria-label="Link to this section">#</a>`;
    env._headingSlug = null;
  }
  return anchorHtml + originalHeadingClose(tokens, idx, options, env, self);
};

// Wrap images in <figure> with <figcaption> from alt text
md.renderer.rules.image = function (tokens, idx, _options, env) {
  const token = tokens[idx];
  const src = resolveImageSrc(token.attrGet('src') || '', env?.assetBase);
  const alt = token.children
    ? token.children.map((c) => c.content).join('')
    : (token.content || '');
  const title = token.attrGet('title') || '';
  const titleAttr = title ? ` title="${md.utils.escapeHtml(title)}"` : '';
  const imgHtml = `<img src="${md.utils.escapeHtml(src)}" alt="${md.utils.escapeHtml(alt)}"${titleAttr} loading="lazy">`;
  if (alt) {
    return `<figure>${imgHtml}<figcaption>${md.utils.escapeHtml(alt)}</figcaption></figure>`;
  }
  return `<figure>${imgHtml}</figure>`;
};

/** Normalize Unicode bullet chars (•, ◦, ▪, ▸, ‣) into markdown list syntax.
 *  Skips fenced code blocks and math blocks to avoid false positives. */
function normalizeBullets(text) {
  const bulletRe = /^([ \t]*)[•◦▪▸‣]\s*/gm;
  const fenceRe = /^([ \t]*)(```|~~~|\$\$)/gm;
  // Find all fenced regions (code blocks, math blocks)
  const protected_ = [];
  let match;
  let openIdx = -1;
  let openFence = '';
  const lines = text.split('\n');
  let pos = 0;
  for (const line of lines) {
    const lineStart = pos;
    const lineEnd = pos + line.length;
    const trimmed = line.trimStart();
    if (openIdx === -1) {
      if (trimmed.startsWith('```') || trimmed.startsWith('~~~') || trimmed.startsWith('$$')) {
        openIdx = lineStart;
        openFence = trimmed.slice(0, trimmed.startsWith('$$') ? 2 : 3);
      }
    } else if (trimmed === openFence || (openFence === '```' && trimmed.startsWith('```')) || (openFence === '~~~' && trimmed.startsWith('~~~'))) {
      protected_.push([openIdx, lineEnd]);
      openIdx = -1;
    }
    pos = lineEnd + 1; // +1 for the \n
  }
  if (openIdx !== -1) protected_.push([openIdx, text.length]);

  return text.replace(bulletRe, (full, indent, offset) => {
    for (const [start, end] of protected_) {
      if (offset >= start && offset < end) return full;
    }
    return indent + '- ';
  });
}

export { normalizeBullets as _normalizeBullets };

/** Strip markdown syntax to plain text for full-text search */
export function stripMarkdown(text) {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]+`/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*{1,3}|_{1,3})(.*?)\1/g, '$2')
    .replace(/^[-*_]{3,}\s*$/gm, '')
    .replace(/^>\s*/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function renderMarkdown(text, options = {}) {
  const normalized = normalizeBullets(text);
  const html = DOMPurify.sanitize(md.render(normalized, { assetBase: options.assetBase || '' }), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'textarea', 'select', 'option', 'button'],
    FORBID_ATTR: ['style', 'srcdoc', 'target'],
  });
  return html.replace(/<table[\s>]/g, '<div class="table-scroll">$&').replace(/<\/table>/g, '</table></div>');
}

function createCopyIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const rect = document.createElementNS(ns, 'rect');
  rect.setAttribute('x', '5.5');
  rect.setAttribute('y', '5.5');
  rect.setAttribute('width', '8');
  rect.setAttribute('height', '8');
  rect.setAttribute('rx', '1.5');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M3 10.5H2.5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1V3');
  svg.appendChild(rect);
  svg.appendChild(path);
  return svg;
}

function createCheckIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M3 8.5l3 3 7-7');
  svg.appendChild(path);
  return svg;
}

export function addCopyButtons(container) {
  const pres = container.querySelectorAll('pre');
  for (const pre of pres) {
    if (pre.querySelector('.copy-btn')) continue;
    const wrapper = document.createElement('div');
    wrapper.className = 'code-block-wrapper';
    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(pre);

    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Copy code');
    btn.appendChild(createCopyIcon());
    btn.addEventListener('click', () => {
      const code = pre.querySelector('code');
      const text = code ? code.textContent : pre.textContent;
      navigator.clipboard.writeText(text).then(() => {
        btn.replaceChildren(createCheckIcon());
        btn.classList.add('copied');
        setTimeout(() => {
          btn.replaceChildren(createCopyIcon());
          btn.classList.remove('copied');
        }, 2000);
      });
    });
    wrapper.appendChild(btn);
  }
}

let highlighterPromise = null;
const MAX_HIGHLIGHT_LENGTH = 100_000;

const languageAliases = {
  js: 'javascript',
  jsx: 'javascript',
  ps1: 'powershell',
  py: 'python',
  shell: 'bash',
  sh: 'bash',
  yml: 'yaml',
};

function loadHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = import('./highlighter.js')
      .then((module) => module.default)
      .catch((error) => {
        highlighterPromise = null;
        throw error;
      });
  }
  return highlighterPromise;
}

export async function highlightCodeBlocks(container) {
  const codeBlocks = container.querySelectorAll('pre code');
  if (codeBlocks.length === 0) return;

  try {
    const highlighter = await loadHighlighter();

    for (const block of codeBlocks) {
      if (block.classList.contains('hljs')) continue;
      const languageClass = Array.from(block.classList).find((c) => c.startsWith('language-'));
      const requestedLanguage = languageClass ? languageClass.replace('language-', '').toLowerCase() : '';
      const language = languageAliases[requestedLanguage] || requestedLanguage;
      const code = block.textContent;

      try {
        if (!language || code.length > MAX_HIGHLIGHT_LENGTH || !highlighter.getLanguage(language)) continue;
        block.innerHTML = highlighter.highlight(code, {
          language,
          ignoreIllegals: true,
        }).value;
        block.classList.add('hljs');
      } catch (_) {
        // Unsupported languages remain readable without highlighting
      }
    }
  } catch (_) {
    // Syntax highlighting is best-effort
  }
}
