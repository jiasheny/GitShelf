import { useState, useEffect } from 'preact/hooks';
import { fetchToc, fetchManifest, fetchText, flattenChapters, formatWordCount } from '../lib/api';
import {
  createBookZip,
  createTextOnlyMarkdown,
  fetchBookImages,
  mergeChapterMarkdown,
  prepareMarkdownWithImages,
} from '../lib/bookDownload';
import { showToast } from '../lib/toast';

function safeFilename(value) {
  return String(value || 'book')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim() || 'book';
}

function OverviewToc({ items, encodedBookId, nested = false }) {
  return (
    <ol class={`book-overview-toc${nested ? ' book-overview-toc--nested' : ''}`}>
      {items.map((item, index) => {
        const key = item.slug || item.anchor || `${item.title}-${index}`;
        const content = (
          <>
            <span class="book-overview-toc-title">{item.title}</span>
            {item.children?.length > 0 && (
              <span class="book-overview-toc-count">{item.children.length} sections</span>
            )}
          </>
        );
        return (
          <li key={key} class="book-overview-toc-item">
            {item.slug ? (
              <a class="book-overview-toc-link" href={`#/books/${encodedBookId}/${encodeURIComponent(item.slug)}${item.anchor ? `#${encodeURIComponent(item.anchor)}` : ''}`}>
                {content}
              </a>
            ) : (
              <div class="book-overview-toc-link book-overview-toc-group">{content}</div>
            )}
            {item.children?.length > 0 && (
              <OverviewToc items={item.children} encodedBookId={encodedBookId} nested />
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function BookOverview({ bookId, onTocLoaded }) {
  const [tocData, setTocData] = useState(null);
  const [bookMeta, setBookMeta] = useState(null);
  const [error, setError] = useState(null);
  const [downloadProgress, setDownloadProgress] = useState(null);
  const [downloadError, setDownloadError] = useState('');
  const [syncResult, setSyncResult] = useState(null);

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
  const firstChapter = flattenChapters(items)[0] || null;
  const encodedBookId = encodeURIComponent(bookId);

  const downloading = Boolean(downloadProgress);

  async function loadMergedMarkdown() {
    const chapters = flattenChapters(items);
    if (chapters.length === 0) throw new Error('No chapters available.');
    const parts = await Promise.all(chapters.map((chapter) => (
      fetchText(`books/${bookId}/chapters/${chapter.slug}.md`)
    )));
    return mergeChapterMarkdown(parts);
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function handleTextDownload() {
    setDownloadProgress({ type: 'text', message: 'Preparing text-only Markdown...', percent: 20 });
    setDownloadError('');
    setSyncResult(null);
    try {
      const markdown = createTextOnlyMarkdown(await loadMergedMarkdown());
      const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
      saveBlob(blob, `${safeFilename(tocData.title || bookId)}.md`);
    } catch (err) {
      setDownloadError(err.message || 'Download failed.');
    } finally {
      setDownloadProgress(null);
    }
  }

  async function handleFullDownload() {
    setDownloadProgress({ type: 'full', message: 'Preparing chapters...', percent: 5 });
    setDownloadError('');
    setSyncResult(null);
    try {
      const merged = await loadMergedMarkdown();
      const { markdown, imagePaths } = prepareMarkdownWithImages(merged, bookId);
      setDownloadProgress({
        type: 'full',
        message: imagePaths.length ? `Downloading images 0/${imagePaths.length}...` : 'Creating ZIP...',
        percent: imagePaths.length ? 10 : 90,
      });
      const images = await fetchBookImages(bookId, imagePaths, (completed, total) => {
        setDownloadProgress({
          type: 'full',
          message: `Downloading images ${completed}/${total}...`,
          percent: 10 + Math.round((completed / total) * 80),
        });
      });
      setDownloadProgress({ type: 'full', message: 'Creating ZIP...', percent: 95 });
      const filename = safeFilename(tocData.title || bookId);
      saveBlob(await createBookZip(markdown, filename, images), `${filename}.zip`);
    } catch (err) {
      setDownloadError(err.message || 'Download failed.');
    } finally {
      setDownloadProgress(null);
    }
  }

  async function handleObsidianSync() {
    setDownloadProgress({ type: 'obsidian', message: 'Preparing book for Obsidian...', percent: 5 });
    setDownloadError('');
    setSyncResult(null);
    try {
      const markdown = await loadMergedMarkdown();
      const { syncBookToObsidian } = await import('../lib/obsidianSync');
      const result = await syncBookToObsidian({
        bookId,
        title: tocData.title || bookId,
        markdown,
      }, (progress) => {
        setDownloadProgress({
          type: 'obsidian',
          message: progress.message || 'Syncing to Obsidian...',
          percent: progress.percent ?? 10,
        });
      });
      setSyncResult(result);
      showToast(
        result.changed === false ? 'This book is already up to date in Obsidian.' : 'Book synced to Obsidian.',
        'success',
      );
    } catch (err) {
      const message = err.message || 'Obsidian sync failed.';
      setDownloadError(message);
      showToast(message, 'error');
    } finally {
      setDownloadProgress(null);
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
          <button class="book-overview-cta btn btn-secondary" type="button" onClick={handleTextDownload} disabled={downloading}>
            Download text-only MD
          </button>
          <button class="book-overview-cta btn btn-secondary" type="button" onClick={handleFullDownload} disabled={downloading}>
            Download MD + Images (ZIP)
          </button>
          <button class="book-overview-cta btn btn-secondary" type="button" onClick={handleObsidianSync} disabled={downloading}>
            Sync to Obsidian
          </button>
        </div>
        {downloadProgress && (
          <div class="download-progress" aria-live="polite">
            <div class="progress-bar" role="progressbar" aria-label="Book action progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow={downloadProgress.percent}>
              <div class="progress-bar-fill" style={{ width: `${downloadProgress.percent}%` }} />
            </div>
            <p class="progress-text">{downloadProgress.message}</p>
          </div>
        )}
        {syncResult && (
          <p class="status-success" role="status">
            {syncResult.changed === false ? 'Already up to date in Obsidian.' : 'Synced to Obsidian.'}
            {' '}
            {syncResult.noteUrl && (
              <a class="admin-text-link" href={syncResult.noteUrl} target="_blank" rel="noopener noreferrer">
                Open note
              </a>
            )}
          </p>
        )}
        {downloadError && <p class="admin-error" role="alert">{downloadError}</p>}
      </div>

      <OverviewToc items={items} encodedBookId={encodedBookId} />
    </div>
  );
}
