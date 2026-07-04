const DEFAULT_CHUNK_SIZE = 70 * 1024 * 1024;
const MAX_GITHUB_BLOB_SIZE = 95 * 1024 * 1024;

async function createPdfChunk(source, startPage, endPage) {
  const { PDFDocument } = await import('pdf-lib');
  const chunk = await PDFDocument.create();
  const pageIndexes = Array.from(
    { length: endPage - startPage },
    (_, index) => startPage + index,
  );
  const pages = await chunk.copyPages(source, pageIndexes);
  pages.forEach((page) => chunk.addPage(page));
  return chunk.save({ useObjectStreams: true });
}

async function splitRange(source, startPage, endPage, maxChunkBytes) {
  const bytes = await createPdfChunk(source, startPage, endPage);
  if (bytes.length <= maxChunkBytes) {
    return [{ bytes, startPage, endPage }];
  }
  if (endPage - startPage === 1) {
    if (bytes.length > MAX_GITHUB_BLOB_SIZE) {
      throw new Error(`Page ${startPage + 1} is too large to upload to GitHub by itself.`);
    }
    return [{ bytes, startPage, endPage }];
  }
  const midpoint = startPage + Math.floor((endPage - startPage) / 2);
  const left = await splitRange(source, startPage, midpoint, maxChunkBytes);
  const right = await splitRange(source, midpoint, endPage, maxChunkBytes);
  return [...left, ...right];
}

export async function splitPdfIntoChunks(
  file,
  { maxChunkBytes = DEFAULT_CHUNK_SIZE, onProgress = () => {} } = {},
) {
  const { PDFDocument } = await import('pdf-lib');
  const sourceBytes = await file.arrayBuffer();
  const source = await PDFDocument.load(sourceBytes);
  const pageCount = source.getPageCount();
  if (!pageCount) throw new Error('The PDF does not contain any pages.');

  const estimatedChunks = Math.max(2, Math.ceil(file.size / maxChunkBytes));
  const pagesPerRange = Math.max(1, Math.ceil(pageCount / estimatedChunks));
  const chunks = [];

  for (let startPage = 0; startPage < pageCount; startPage += pagesPerRange) {
    const endPage = Math.min(pageCount, startPage + pagesPerRange);
    chunks.push(...await splitRange(source, startPage, endPage, maxChunkBytes));
    onProgress(endPage, pageCount);
  }

  return { chunks, pageCount };
}

export { DEFAULT_CHUNK_SIZE };
