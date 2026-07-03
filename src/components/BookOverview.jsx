import { useState, useEffect } from 'preact/hooks';
import { fetchToc, fetchManifest, fetchText, flattenChapters, formatWordCount } from '../lib/api';

function safeFilename(value) {
  return String(value || 'book')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim() || 'book';
}

export function BookOverview({ bookId, onTocLoaded }) {
  const [tocData, setTocData] = useState(null);
  const [bookMeta, setBookMeta] = useState(null);
  const [error, setError] = useState(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [toc, manifest] = await Promise.all([
          fetchToc(bookId),
          fetchManifest(),
        ]);
        if (cancelled) return;

        setTocData(toc);
        const meta = manifest.items?.find((b) => b.id === bookId) || null;
        setBookMeta(meta);
        onTocLoaded(toc);

        document.title = `${toc.title || bookId} \u00b7 GitShelf`;
      } catch (err) {
        if (!cancelled) {
          setError(err.message);
          document.title = `${bookId} \u00b7 GitShelf`;
        }
      }
    }

    load();
    return () => { cancelled = true; };
  }, [bookId, onTocLoaded]);

  if (error) {
    return <div class="content-error view-enter">Failed to load: {error}</div>;
  }

  if (!tocData || !tocData.children) {
    return <div class="reader-content view-enter" style={{ opacity: 0.5 }}>Loading...</div>;
  }

  const items = tocData.children;
  const totalChapters = bookMeta?.chapters_count || items.length;
  const wordCount = bookMeta?.word_count || 0;
  const firstChapter = items.find((item) => item.slug) || null;
  const encodedBookId = encodeURIComponent(bookId);

  async function handleDownload() {
    setDownloading(true);
    setDownloadError('');
    try {
      const chapters = flattenChapters(items);
      if (chapters.length === 0) throw new Error('No chapters available.');
      const parts = await Promise.all(chapters.map(async (chapter) => {
        const text = await fetchText(`books/${bookId}/chapters/${chapter.slug}.md`);
        return text.trim();
      }));
      const markdown = `${parts.filter(Boolean).join('\n\n---\n\n')}\n`;
      const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${safeFilename(tocData.title || bookId)}.md`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setDownloadError(err.message || 'Download failed.');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div class="book-overview view-enter">
      <div class="book-overview-header">
        <h1 class="book-overview-title">{tocData.title}</h1>
        <div class="book-overview-meta">
          <span>{totalChapters} chapters</span>
          {wordCount > 0 && <span>{formatWordCount(wordCount)} words</span>}
          {wordCount > 0 && <span>~{Math.ceil(wordCount / 250)} min read</span>}
        </div>
        <div class="book-overview-actions" style={{ display: 'flex', justifyContent: 'center', flexWrap: 'wrap', gap: '12px' }}>
          {firstChapter && (
            <a class="book-overview-cta" href={`#/books/${encodedBookId}/${encodeURIComponent(firstChapter.slug)}`}>
              Start Reading
            </a>
          )}
          <button class="book-overview-cta btn btn-secondary" type="button" onClick={handleDownload} disabled={downloading}>
            {downloading ? 'Preparing Markdown…' : 'Download Markdown'}
          </button>
        </div>
        {downloadError && <p class="admin-error" role="alert">{downloadError}</p>}
      </div>

      <ol class="book-overview-toc">
        {items.map((item) => (
          <li key={item.slug} class="book-overview-toc-item">
            <a class="book-overview-toc-link" href={`#/books/${encodedBookId}/${encodeURIComponent(item.slug)}`}>
              <span class="book-overview-toc-title">{item.title}</span>
              {item.children && item.children.length > 0 && (
                <span class="book-overview-toc-count">{item.children.length} sections</span>
              )}
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}
