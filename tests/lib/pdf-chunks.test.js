import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { splitPdfIntoChunks } from '../../src/lib/pdf-chunks';

describe('splitPdfIntoChunks', () => {
  it('creates valid page-preserving PDF parts', async () => {
    const source = await PDFDocument.create();
    for (let page = 0; page < 4; page += 1) {
      source.addPage([300, 400]).drawText(`Page ${page + 1}`);
    }
    const bytes = await source.save();
    const file = new File([bytes], 'large.pdf', { type: 'application/pdf' });
    const progress = [];

    const result = await splitPdfIntoChunks(file, {
      maxChunkBytes: 1,
      onProgress: (completed, total) => progress.push([completed, total]),
    });

    expect(result.pageCount).toBe(4);
    expect(result.chunks).toHaveLength(4);
    let restoredPages = 0;
    for (const chunk of result.chunks) {
      const parsed = await PDFDocument.load(chunk.bytes);
      restoredPages += parsed.getPageCount();
    }
    expect(restoredPages).toBe(4);
    expect(progress.at(-1)).toEqual([4, 4]);
  });
});
