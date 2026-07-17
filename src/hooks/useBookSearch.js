import { useState, useRef, useCallback, useEffect } from 'preact/hooks';
import { fetchText, flattenChapters } from '../lib/api';
import { stripMarkdown } from '../lib/markdown';

const DEBOUNCE_MS = 200;
const MAX_RESULTS = 50;
const SNIPPET_RADIUS = 80;
const MIN_QUERY_LENGTH = 2;
const MAX_CONCURRENT_CHAPTER_LOADS = 6;
const MAX_CACHED_BOOKS = 3;

// Module-level cache: bookId → Map<slug, { title, plainText }>
const cache = new Map();

function cacheBook(bookId, chapters) {
  cache.delete(bookId);
  cache.set(bookId, chapters);
  while (cache.size > MAX_CACHED_BOOKS) {
    cache.delete(cache.keys().next().value);
  }
}

function extractSnippet(text, matchIndex, queryLength) {
  let start = matchIndex - SNIPPET_RADIUS;
  let end = matchIndex + queryLength + SNIPPET_RADIUS;

  // Clamp
  if (start < 0) start = 0;
  if (end > text.length) end = text.length;

  // Extend to word boundaries
  if (start > 0) {
    const spaceIdx = text.indexOf(' ', start);
    if (spaceIdx !== -1 && spaceIdx < matchIndex) start = spaceIdx + 1;
  }
  if (end < text.length) {
    const spaceIdx = text.lastIndexOf(' ', end);
    if (spaceIdx > matchIndex + queryLength) end = spaceIdx;
  }

  const snippet = text.slice(start, end);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < text.length ? '...' : '';

  return {
    text: prefix + snippet + suffix,
    matchStart: prefix.length + (matchIndex - start),
    matchLength: queryLength,
  };
}

function searchChapters(chaptersMap, query) {
  const lower = query.toLowerCase();
  const results = [];

  for (const [slug, { title, plainText }] of chaptersMap) {
    const lowerText = plainText.toLowerCase();
    let idx = 0;
    while (results.length < MAX_RESULTS) {
      const found = lowerText.indexOf(lower, idx);
      if (found === -1) break;
      results.push({
        slug,
        chapterTitle: title,
        ...extractSnippet(plainText, found, query.length),
      });
      idx = found + query.length;
    }
    if (results.length >= MAX_RESULTS) break;
  }

  return results;
}

function countAllMatches(chaptersMap, query) {
  const lower = query.toLowerCase();
  let count = 0;
  for (const [, { plainText }] of chaptersMap) {
    const lowerText = plainText.toLowerCase();
    let idx = 0;
    while (true) {
      const found = lowerText.indexOf(lower, idx);
      if (found === -1) break;
      count++;
      idx = found + query.length;
    }
  }
  return count;
}

export function useBookSearch(bookId, tocData) {
  const [loading, setLoading] = useState(false);
  const [loadProgress, setLoadProgress] = useState({ loaded: 0, total: 0 });
  const [query, setQueryRaw] = useState('');
  const [results, setResults] = useState([]);
  const [totalMatches, setTotalMatches] = useState(0);
  const debounceRef = useRef(null);
  const queryRef = useRef('');

  const chaptersMap = bookId ? cache.get(bookId) : null;

  const loadChapters = useCallback(async () => {
    if (!bookId || !tocData?.children) return;
    if (cache.has(bookId)) return;

    const chapters = flattenChapters(tocData.children);
    if (chapters.length === 0) return;

    setLoading(true);
    setLoadProgress({ loaded: 0, total: chapters.length });

    const map = new Map();
    let loaded = 0;
    let nextIndex = 0;

    const loadWorker = async () => {
      while (nextIndex < chapters.length) {
        const ch = chapters[nextIndex];
        nextIndex += 1;
        try {
          const raw = await fetchText(`books/${bookId}/chapters/${ch.slug}.md`);
          map.set(ch.slug, { title: ch.title, plainText: stripMarkdown(raw) });
        } catch (_) {
          // Skip chapters that fail to load
        }
        loaded++;
        setLoadProgress({ loaded, total: chapters.length });
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(MAX_CONCURRENT_CHAPTER_LOADS, chapters.length) },
        () => loadWorker(),
      ),
    );

    cacheBook(bookId, map);
    setLoading(false);
    const pendingQuery = queryRef.current;
    if (pendingQuery.length >= MIN_QUERY_LENGTH) {
      const found = searchChapters(map, pendingQuery);
      setResults(found);
      setTotalMatches(countAllMatches(map, pendingQuery));
    }
  }, [bookId, tocData]);

  const setQuery = useCallback(
    (value) => {
      setQueryRaw(value);
      queryRef.current = value;
      if (debounceRef.current) clearTimeout(debounceRef.current);

      if (value.length < MIN_QUERY_LENGTH) {
        setResults([]);
        setTotalMatches(0);
        return;
      }

      debounceRef.current = setTimeout(() => {
        const map = cache.get(bookId);
        if (!map) return;
        const found = searchChapters(map, value);
        setResults(found);
        setTotalMatches(
          countAllMatches(map, value),
        );
      }, DEBOUNCE_MS);
    },
    [bookId],
  );

  // Clear debounce on unmount
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  // Reset query when book changes
  useEffect(() => {
    setQueryRaw('');
    queryRef.current = '';
    setResults([]);
    setTotalMatches(0);
  }, [bookId]);

  return {
    loading,
    loadProgress,
    query,
    setQuery,
    results,
    totalMatches,
    loadChapters,
  };
}
