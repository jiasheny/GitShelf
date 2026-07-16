import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import sys

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import mineru_client


class MineruDocumentClientTest(unittest.TestCase):
    def test_upload_payload_uses_requested_model(self) -> None:
        response = Mock(status_code=200)
        response.json.return_value = {
            "code": 0,
            "data": {"batch_id": "batch", "file_urls": ["https://upload.example"]},
        }
        with patch.object(mineru_client.requests, "post", return_value=response) as post_mock:
            client = mineru_client.MineruClient(token="token")
            client._request_upload_url("manual.docx", model_version="pipeline")

        payload = post_mock.call_args.kwargs["json"]
        self.assertEqual(payload["files"][0]["name"], "manual.docx")
        self.assertEqual(payload["model_version"], "pipeline")

    def test_convert_document_supports_docx(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            document_path = Path(tmp_dir) / "manual.docx"
            document_path.write_bytes(b"docx")
            client = mineru_client.MineruClient(token="token")

            with (
                patch.object(client, "_request_upload_url", return_value=("batch", "upload")) as request_mock,
                patch.object(client, "_upload_file") as upload_mock,
                patch.object(client, "_poll_until_done", return_value="zip-url"),
                patch.object(mineru_client, "_download_zip", return_value=b"zip"),
                patch.object(mineru_client, "extract_zip_contents", return_value=("# Word", {})),
            ):
                result = client.convert_document(document_path, model_version="pipeline")

            request_mock.assert_called_once_with("manual.docx", model_version="pipeline")
            upload_mock.assert_called_once_with("upload", document_path)
            self.assertEqual(result, (b"zip", "# Word", {}))

    def test_rejects_unknown_model(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            document_path = Path(tmp_dir) / "book.pdf"
            document_path.write_bytes(b"pdf")
            client = mineru_client.MineruClient(token="token")

            with self.assertRaisesRegex(ValueError, "Unsupported MinerU model"):
                client.convert_document(document_path, model_version="unknown")


if __name__ == "__main__":
    unittest.main()
