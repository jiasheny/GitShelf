import os
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import fitz

REPO_ROOT = Path(__file__).resolve().parents[2]
import sys

sys.path.insert(0, str(REPO_ROOT / "scripts"))

import process


class ChunkedPdfUploadTest(unittest.TestCase):
    def _write_pdf(self, path: Path, labels: list[str]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        document = fitz.open()
        try:
            for label in labels:
                page = document.new_page()
                page.insert_text((72, 72), label)
            document.save(path)
        finally:
            document.close()

    def test_assembles_parts_in_order_and_cleans_staging_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            input_dir = root / "input"
            upload_dir = root / "uploads" / "upload123"
            input_dir.mkdir()
            self._write_pdf(upload_dir / "part-00001.pdf", ["one", "two"])
            self._write_pdf(upload_dir / "part-00002.pdf", ["three"])
            manifest = input_dir / "upload123.parts.json"
            manifest.write_text(json.dumps({
                "version": 1,
                "filename": "complete.pdf",
                "page_count": 3,
                "parts": [
                    "uploads/upload123/part-00001.pdf",
                    "uploads/upload123/part-00002.pdf",
                ],
            }), encoding="utf-8")

            assembled = process.assemble_chunked_uploads(input_dir)

            output = input_dir / "complete.pdf"
            upload = assembled[manifest.name]
            self.assertEqual(upload.pdf_path, output)
            with fitz.open(output) as document:
                self.assertEqual(document.page_count, 3)
            self.assertTrue(manifest.exists())
            self.assertTrue(upload_dir.exists())

            upload.finalize()

            self.assertFalse(manifest.exists())
            self.assertFalse(upload_dir.exists())

    def test_rejects_parts_outside_uploads_directory(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            input_dir = root / "input"
            input_dir.mkdir()
            outside = root / "outside.pdf"
            self._write_pdf(outside, ["nope"])
            manifest = input_dir / "unsafe.parts.json"
            manifest.write_text(json.dumps({
                "version": 1,
                "filename": "complete.pdf",
                "parts": ["outside.pdf"],
            }), encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "outside uploads"):
                process.assemble_chunked_uploads(input_dir)

            self.assertTrue(manifest.exists())
            self.assertTrue(outside.exists())

    def test_reassembles_raw_binary_parts_exactly(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            input_dir = root / "input"
            upload_dir = root / "uploads" / "raw123"
            input_dir.mkdir()
            original = root / "original.pdf"
            self._write_pdf(original, ["one", "two", "three"])
            original_bytes = original.read_bytes()
            midpoint = len(original_bytes) // 2
            upload_dir.mkdir(parents=True)
            (upload_dir / "part-00001.part").write_bytes(original_bytes[:midpoint])
            (upload_dir / "part-00002.part").write_bytes(original_bytes[midpoint:])
            manifest = input_dir / "raw123.parts.json"
            manifest.write_text(json.dumps({
                "version": 1,
                "assembly": "bytes",
                "filename": "restored.pdf",
                "file_size": len(original_bytes),
                "parts": [
                    "uploads/raw123/part-00001.part",
                    "uploads/raw123/part-00002.part",
                ],
            }), encoding="utf-8")

            upload = process.assemble_chunked_uploads(input_dir)[manifest.name]

            self.assertEqual(upload.pdf_path.read_bytes(), original_bytes)
            with fitz.open(upload.pdf_path) as document:
                self.assertEqual(document.page_count, 3)

    def test_targeted_manifest_ignores_unrelated_broken_upload(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            input_dir = root / "input"
            upload_dir = root / "uploads" / "valid"
            input_dir.mkdir()
            original = root / "original.pdf"
            self._write_pdf(original, ["valid"])
            payload = original.read_bytes()
            upload_dir.mkdir(parents=True)
            (upload_dir / "part-00001.part").write_bytes(payload)

            broken = input_dir / "broken.parts.json"
            broken.write_text("{not-json", encoding="utf-8")
            valid = input_dir / "valid.parts.json"
            valid.write_text(json.dumps({
                "version": 1,
                "assembly": "bytes",
                "filename": "valid.pdf",
                "file_size": len(payload),
                "parts": ["uploads/valid/part-00001.part"],
            }), encoding="utf-8")

            assembled = process.assemble_chunked_uploads(
                input_dir,
                manifest_names={valid.name},
            )

            self.assertEqual(list(assembled), [valid.name])
            self.assertTrue((input_dir / "valid.pdf").exists())
            self.assertTrue(broken.exists())


class EpubProcessingTest(unittest.TestCase):
    def test_process_epub_converts_to_pdf_and_reuses_pdf_pipeline(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            books_dir = root / "docs" / "books"
            books_dir.mkdir(parents=True, exist_ok=True)

            epub_path = root / "input" / "sample.epub"
            epub_path.parent.mkdir(parents=True, exist_ok=True)
            epub_path.write_bytes(b"epub-bytes")

            converted_pdfs: list[Path] = []

            def fake_convert_epub_to_pdf(source: Path, dest: Path) -> None:
                self.assertEqual(source, epub_path)
                dest.write_bytes(b"%PDF-1.4\n")
                converted_pdfs.append(dest)

            with patch.object(process, "_convert_epub_to_pdf", side_effect=fake_convert_epub_to_pdf) as convert_mock:
                with patch.object(process, "convert_single_pdf") as convert_pdf_mock:
                    process.process_epub(epub_path, books_dir)

            self.assertFalse(epub_path.exists())
            convert_mock.assert_called_once()
            convert_pdf_mock.assert_called_once()

            args, kwargs = convert_pdf_mock.call_args
            self.assertEqual(args[1], books_dir)
            self.assertEqual(kwargs["source_name"], "sample.epub")
            self.assertEqual(args[0].suffix, ".pdf")
            self.assertEqual(args[0].name, "sample.pdf")
            self.assertGreater(len(converted_pdfs), 0)

    def test_background_queue_skips_known_failures_and_processes_new_items(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            input_dir = root / "input"
            output_dir = root / "docs"
            input_dir.mkdir()
            output_dir.mkdir()
            failed_path = input_dir / "failed.md"
            fresh_path = input_dir / "fresh.md"
            failed_path.write_text("# Failed\n", encoding="utf-8")
            fresh_path.write_text("# Fresh\n", encoding="utf-8")
            (output_dir / process.FAILURES_FILENAME).write_text(json.dumps({
                "failures": [{"filename": failed_path.name, "error": "previous failure"}],
            }), encoding="utf-8")

            argv = sys.argv[:]
            try:
                sys.argv = [
                    "process.py",
                    "--input-dir",
                    str(input_dir),
                    "--output-dir",
                    str(output_dir),
                ]
                with patch.dict(os.environ, {"INPUT_FILENAME": ""}, clear=False):
                    process.main()
            finally:
                sys.argv = argv

            self.assertTrue(failed_path.exists())
            self.assertFalse(fresh_path.exists())
            self.assertTrue((output_dir / "articles" / "fresh" / "content.md").exists())

    def test_main_reconverts_missing_epub_via_pdf_cache(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            input_dir = root / "input"
            output_dir = root / "docs"
            books_dir = output_dir / "books"
            books_dir.mkdir(parents=True, exist_ok=True)

            env = os.environ.copy()
            env["INPUT_FILENAME"] = "cached.epub"

            with patch.dict(os.environ, env, clear=True):
                with patch.object(process, "reconvert_from_cache") as reconvert_mock:
                    with patch.object(process, "build_manifest") as build_manifest_mock:
                        argv = sys.argv[:]
                        try:
                            sys.argv = [
                                "process.py",
                                "--input-dir",
                                str(input_dir),
                                "--output-dir",
                                str(output_dir),
                            ]
                            process.main()
                        finally:
                            sys.argv = argv

            reconvert_mock.assert_called_once_with("cached.epub", books_dir)
            build_manifest_mock.assert_called_once()


class DocxDetectionTest(unittest.TestCase):
    def test_detect_new_docx_is_case_insensitive(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            input_dir = Path(tmp_dir)
            lower = input_dir / "one.docx"
            upper = input_dir / "two.DOCX"
            lower.write_bytes(b"one")
            upper.write_bytes(b"two")
            (input_dir / "ignore.doc").write_bytes(b"old word")

            self.assertEqual(process.detect_new_docx(input_dir), [lower, upper])


if __name__ == "__main__":
    unittest.main()
