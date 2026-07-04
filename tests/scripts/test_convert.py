import io
import shutil
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import Mock, patch

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import convert
from generate_structure import Chapter, generate_book_structure
from mineru_client import extract_zip_contents
from fix_heading_levels import TocEntry, fix_heading_levels


def _zip_with_markdown(markdown: str) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("auto.md", markdown)
    return buf.getvalue()


class ConvertDispatchResolutionTest(unittest.TestCase):
    def test_detect_new_pdfs_is_case_insensitive(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            input_dir = Path(tmp_dir)
            lower = input_dir / "lower.pdf"
            upper = input_dir / "upper.PDF"
            lower.write_bytes(b"%PDF-1.4\n")
            upper.write_bytes(b"%PDF-1.4\n")
            (input_dir / "notes.txt").write_text("ignore", encoding="utf-8")

            self.assertEqual(convert.detect_new_pdfs(input_dir), [lower, upper])

    def test_resolve_prefers_input_root(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            input_dir = Path(tmp_dir) / "input"
            input_dir.mkdir(parents=True, exist_ok=True)

            (input_dir / "book.pdf").write_bytes(b"%PDF-1.4\n")

            resolved = convert._resolve_input_pdf(input_dir, "book.pdf")
            self.assertEqual(resolved, input_dir / "book.pdf")

    def test_resolve_missing_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            input_dir = Path(tmp_dir) / "input"
            input_dir.mkdir(parents=True, exist_ok=True)

            with self.assertRaises(FileNotFoundError):
                convert._resolve_input_pdf(input_dir, "missing.pdf")

    def test_resolve_rejects_path_traversal_like_input(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            input_dir = Path(tmp_dir) / "input"
            input_dir.mkdir(parents=True, exist_ok=True)
            (input_dir / "book.pdf").write_bytes(b"%PDF-1.4\n")

            resolved = convert._resolve_input_pdf(input_dir, "../book.pdf")
            self.assertEqual(resolved, input_dir / "book.pdf")


class ContentIdGenerationTest(unittest.TestCase):
    def test_generate_book_id_preserves_unicode_letters(self) -> None:
        item_id = convert.generate_book_id(Path("测试 文档.pdf"))
        self.assertEqual(item_id, "测试-文档")

    def test_generate_book_id_falls_back_when_slug_is_empty(self) -> None:
        item_id = convert.generate_book_id(Path("!!!.pdf"))
        self.assertTrue(item_id.startswith("item-"))
        self.assertGreater(len(item_id), 5)


class PdfBookmarkChapterSplitTest(unittest.TestCase):
    def test_bookmark_split_prefers_chapter_entries_under_parts(self) -> None:
        markdown = """# 译者序

front matter

# 第一部分 基础知识

## 第2章 线程安全性

### 2.1 什么是线程安全性

body 2

## 第3章 对象的共享

### 3.1 可见性

body 3
"""
        toc = [
            TocEntry(level=1, title="译者序"),
            TocEntry(level=1, title="第一部分 基础知识"),
            TocEntry(level=2, title="第2章 线程安全性"),
            TocEntry(level=3, title="2.1 什么是线程安全性"),
            TocEntry(level=2, title="第3章 对象的共享"),
            TocEntry(level=3, title="3.1 可见性"),
        ]

        chapters = convert._split_chapters(markdown, toc)

        self.assertEqual([chapter.title for chapter in chapters], [
            "译者序",
            "第2章 线程安全性",
            "第3章 对象的共享",
        ])
        self.assertIn("# 第2章 线程安全性", chapters[1].content)
        self.assertIn("## 2.1 什么是线程安全性", chapters[1].content)
        self.assertNotIn("第一部分", [chapter.title for chapter in chapters])

    def test_bookmark_split_falls_back_to_h1_without_matches(self) -> None:
        markdown = "# Intro\n\nbody\n\n# Next\n\nmore"
        toc = [TocEntry(level=1, title="Completely Different")]

        chapters = convert._split_chapters(markdown, toc)

        self.assertEqual([chapter.title for chapter in chapters], ["Intro", "Next"])

    def test_heading_fix_merges_adjacent_headings_for_bookmark_match(self) -> None:
        markdown = "# 译者序\n\nbody\n\n# 第1章\n\n# 简介\n\n# 1.1 并发简史"
        toc = [
            TocEntry(level=1, title="译者序"),
            TocEntry(level=1, title="第1章 简介"),
            TocEntry(level=2, title="1.1 并发简史"),
        ]

        fixed = fix_heading_levels(markdown, toc)
        chapters = convert._split_chapters(fixed, toc)

        self.assertIn("# 第1章 简介", fixed)
        self.assertNotIn("**第1章**", fixed)
        self.assertEqual([chapter.title for chapter in chapters], [
            "译者序",
            "第1章 简介",
        ])

    def test_generate_book_structure_removes_stale_chapter_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            output_dir = Path(tmp_dir)
            stale_dir = output_dir / "book" / "chapters"
            stale_dir.mkdir(parents=True)
            (stale_dir / "99-stale.md").write_text("# Stale\n", encoding="utf-8")

            generate_book_structure(
                "book",
                "Book",
                [Chapter(title="Fresh", slug="01-fresh", content="# Fresh\n")],
                output_dir,
            )

            self.assertFalse((stale_dir / "99-stale.md").exists())
            self.assertTrue((stale_dir / "01-fresh.md").exists())


class PdfChunkingTest(unittest.TestCase):
    def test_split_pdf_uses_mineru_page_limit_by_default(self) -> None:
        if convert.fitz is None:
            self.skipTest("PyMuPDF is not installed")

        with tempfile.TemporaryDirectory() as tmp_dir:
            pdf_path = Path(tmp_dir) / "large.pdf"
            doc = convert.fitz.open()
            for _ in range(201):
                doc.new_page()
            doc.save(str(pdf_path))
            doc.close()

            chunk_paths = convert.split_pdf(pdf_path)
            tmp_chunks_dir = chunk_paths[0].parent
            try:
                self.assertEqual(len(chunk_paths), 2)
                with convert.fitz.open(chunk_paths[0]) as first:
                    self.assertEqual(len(first), convert.MAX_PAGES_PER_CHUNK)
                with convert.fitz.open(chunk_paths[1]) as second:
                    self.assertEqual(len(second), 1)
            finally:
                shutil.rmtree(tmp_chunks_dir, ignore_errors=True)

    def test_convert_single_pdf_splits_anything_over_mineru_page_limit(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            pdf_path = root / "input.pdf"
            pdf_path.write_bytes(b"%PDF-1.4\n")

            with (
                patch.object(convert, "_pdf_md5", return_value="md5"),
                patch.object(convert, "_read_cache", return_value=None),
                patch.object(convert, "get_page_count", return_value=201),
                patch.object(convert, "MineruClient", return_value=Mock()),
                patch.object(
                    convert,
                    "_convert_large_pdf",
                    return_value=(b"zip", "# Markdown", {}),
                ) as large_pdf_mock,
                patch.object(convert, "extract_toc", return_value=[]),
                patch.object(convert, "_write_cache"),
                patch.object(convert, "localize_images", side_effect=lambda markdown, *_: markdown),
                patch.object(convert, "split_by_headings", return_value=[]),
                patch.object(convert, "generate_book_structure"),
                patch.object(convert, "_write_book_metadata"),
                patch.object(convert, "_remove_failure"),
            ):
                convert.convert_single_pdf(pdf_path, root / "books")

            large_pdf_mock.assert_called_once()
            self.assertEqual(large_pdf_mock.call_args.args[2], 201)
            self.assertEqual(large_pdf_mock.call_args.args[3], "md5")
            self.assertFalse(pdf_path.exists())

    def test_cleanup_pdf_chunks_ignores_unexpected_directories(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            safe_dir = Path(tmp_dir) / "not-a-chunk-dir"
            safe_dir.mkdir()
            chunk_path = safe_dir / "chunk.pdf"
            chunk_path.write_bytes(b"%PDF-1.4\n")

            convert._cleanup_pdf_chunks([chunk_path])

            self.assertTrue(chunk_path.exists())

    def test_chunk_cache_round_trips_zip_content(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            cachedir = Path(tmp_dir) / "chunks"
            zip_data = _zip_with_markdown("# Cached")

            with patch.object(convert, "CHUNK_CACHE_DIR", cachedir):
                convert._write_chunk_cache("parent-md5", 2, zip_data)
                cached = convert._read_chunk_cache("parent-md5", 2)

            self.assertIsNotNone(cached)
            self.assertEqual(cached[0], zip_data)
            self.assertEqual(cached[1], "# Cached")
            self.assertEqual(cached[2], {})
            self.assertTrue(
                (cachedir / f"parent-md5_p{convert.MAX_PAGES_PER_CHUNK}_chunk_002.zip").exists()
            )

    def test_extract_zip_contents_concatenates_multiple_markdown_files(self) -> None:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("chunk_001/full.md", "# Second")
            zf.writestr("chunk_000/full.md", "# First")

        markdown, _images = extract_zip_contents(buf.getvalue())

        self.assertEqual(markdown, "# First\n\n# Second")

    def test_convert_large_pdf_reuses_cached_chunks_across_retries(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            chunk_1 = root / "chunk-1.pdf"
            chunk_2 = root / "chunk-2.pdf"
            chunk_1.write_bytes(b"%PDF-1.4\n")
            chunk_2.write_bytes(b"%PDF-1.4\n")

            cached_zip = _zip_with_markdown("# Cached chunk")
            fresh_zip = _zip_with_markdown("# Fresh chunk")
            client = Mock()
            client.convert_pdf.return_value = (fresh_zip, "# Fresh chunk", {"images/fresh.png": b"fresh"})

            with (
                patch.object(convert, "_read_chunk_cache", side_effect=[
                    (cached_zip, "# Cached chunk", {"images/cached.png": b"cached"}),
                    None,
                ]) as read_cache_mock,
                patch.object(convert, "_write_chunk_cache") as write_cache_mock,
                patch.object(convert, "split_pdf", return_value=[chunk_1, chunk_2]),
                patch.object(convert, "_cleanup_pdf_chunks"),
            ):
                zip_data, markdown, images = convert._convert_large_pdf(
                    client,
                    root / "book.pdf",
                    400,
                    "parent-md5",
                )

            self.assertEqual(read_cache_mock.call_count, 2)
            client.convert_pdf.assert_called_once_with(chunk_2)
            write_cache_mock.assert_called_once_with("parent-md5", 1, fresh_zip)
            self.assertEqual(markdown, "# Cached chunk\n\n# Fresh chunk")
            self.assertEqual(images["images/cached.png"], b"cached")
            self.assertEqual(images["images/fresh.png"], b"fresh")
            with zipfile.ZipFile(io.BytesIO(zip_data)) as zf:
                self.assertEqual(len([n for n in zf.namelist() if n.endswith(".md")]), 2)


class FailureTrackingTest(unittest.TestCase):
    def test_write_failures_creates_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            docs_dir = Path(tmp_dir)
            pdf_path = Path("input/bad.pdf")
            convert._write_failures([(pdf_path, ValueError("API error"))], docs_dir)

            data = __import__("json").loads((docs_dir / "failures.json").read_text())
            self.assertEqual(len(data["failures"]), 1)
            self.assertEqual(data["failures"][0]["filename"], "bad.pdf")
            self.assertEqual(data["failures"][0]["error"], "API error")
            self.assertIn("failed_at", data["failures"][0])
            self.assertIn("book_id", data["failures"][0])

    def test_write_failures_deduplicates_by_filename(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            docs_dir = Path(tmp_dir)
            pdf_path = Path("input/bad.pdf")
            convert._write_failures([(pdf_path, ValueError("first error"))], docs_dir)
            convert._write_failures([(pdf_path, ValueError("second error"))], docs_dir)

            data = __import__("json").loads((docs_dir / "failures.json").read_text())
            self.assertEqual(len(data["failures"]), 1)
            self.assertEqual(data["failures"][0]["error"], "second error")

    def test_remove_failure(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            docs_dir = Path(tmp_dir)
            convert._write_failures([
                (Path("input/a.pdf"), ValueError("err a")),
                (Path("input/b.pdf"), ValueError("err b")),
            ], docs_dir)

            convert._remove_failure("a.pdf", docs_dir)

            data = __import__("json").loads((docs_dir / "failures.json").read_text())
            self.assertEqual(len(data["failures"]), 1)
            self.assertEqual(data["failures"][0]["filename"], "b.pdf")

    def test_remove_failure_noop_when_missing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            docs_dir = Path(tmp_dir)
            # No failures.json exists — should not raise
            convert._remove_failure("nonexistent.pdf", docs_dir)

    def test_read_failures_returns_empty_on_missing_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            result = convert._read_failures(Path(tmp_dir))
            self.assertEqual(result, [])


class ChapterImagePathRewriteTest(unittest.TestCase):
    def test_rewrites_extracted_image_paths_for_chapters(self) -> None:
        markdown = "![Figure](images/diagram.png)\n\n![](./images/chart.jpg)"

        rewritten = convert._rewrite_chapter_image_paths(markdown, "my-book")

        self.assertIn("![Figure](../images/diagram.png)", rewritten)
        self.assertIn("![](../images/chart.jpg)", rewritten)

    def test_rewrites_book_scoped_image_paths_for_repo_readability(self) -> None:
        markdown = "![Figure](books/my-book/images/diagram.png)"

        rewritten = convert._rewrite_chapter_image_paths(markdown, "my-book")

        self.assertEqual(rewritten, "![Figure](../images/diagram.png)")

    def test_keeps_remote_and_data_images_unchanged(self) -> None:
        markdown = (
            "![Remote](https://example.com/diagram.png)\n"
            "<img src=\"data:image/png;base64,abc\" alt=\"inline\">"
        )

        rewritten = convert._rewrite_chapter_image_paths(markdown, "my-book")

        self.assertIn("![Remote](https://example.com/diagram.png)", rewritten)
        self.assertIn('<img src="data:image/png;base64,abc" alt="inline">', rewritten)


if __name__ == "__main__":
    unittest.main()
