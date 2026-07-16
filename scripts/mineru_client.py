"""MinerU API client for converting documents to Markdown.

Handles the full lifecycle: upload a document via pre-signed URL, poll for
extraction completion, download and extract the resulting Markdown.
"""

from __future__ import annotations

import io
import os
import time
import zipfile
from pathlib import Path

import requests

BASE_URL = "https://mineru.net/api/v4"
MODEL_VERSION = "vlm"
SUPPORTED_MODEL_VERSIONS = {"pipeline", "vlm"}


class MineruError(Exception):
    """Raised when a MinerU API call fails."""


class MineruTimeoutError(MineruError):
    """Raised when polling for task completion exceeds the timeout."""


class MineruClient:
    """Client for the MinerU document extraction API."""

    def __init__(self, token: str | None = None) -> None:
        """Initialize with an API token.

        Falls back to the MINERU_TOKEN environment variable if no token
        is provided. Raises MineruError if neither is set.
        """
        self.token = token or os.environ.get("MINERU_TOKEN")
        if not self.token:
            raise MineruError(
                "No API token provided. Pass token= or set MINERU_TOKEN."
            )

    def convert_document(
        self,
        document_path: Path,
        poll_interval: int = 10,
        timeout: int = 600,
        model_version: str = MODEL_VERSION,
    ) -> tuple[bytes, str, dict[str, bytes]]:
        """Upload a document and return raw ZIP plus extracted Markdown and images.

        Args:
            document_path: Path to the PDF or DOCX file to convert.
            poll_interval: Seconds between status checks.
            timeout: Maximum seconds to wait for completion.
            model_version: MinerU model to use (``pipeline`` or ``vlm``).

        Returns:
            A tuple of (zip_bytes, markdown_text, images_dict).

        Raises:
            MineruError: On API errors or extraction failure.
            MineruTimeoutError: If extraction does not finish in time.
            FileNotFoundError: If document_path does not exist.
        """
        document_path = Path(document_path)
        if not document_path.is_file():
            raise FileNotFoundError(f"Document not found: {document_path}")
        if model_version not in SUPPORTED_MODEL_VERSIONS:
            raise ValueError(f"Unsupported MinerU model version: {model_version}")

        batch_id, upload_url = self._request_upload_url(
            document_path.name,
            model_version=model_version,
        )
        self._upload_file(upload_url, document_path)
        zip_url = self._poll_until_done(batch_id, poll_interval, timeout)
        zip_data = _download_zip(zip_url)
        markdown, images = extract_zip_contents(zip_data)
        return zip_data, markdown, images

    def convert_pdf(
        self,
        pdf_path: Path,
        poll_interval: int = 10,
        timeout: int = 600,
        model_version: str = MODEL_VERSION,
    ) -> tuple[bytes, str, dict[str, bytes]]:
        """Backward-compatible PDF wrapper around :meth:`convert_document`."""
        return self.convert_document(
            pdf_path,
            poll_interval=poll_interval,
            timeout=timeout,
            model_version=model_version,
        )

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
        }

    def _request_upload_url(
        self,
        filename: str,
        *,
        model_version: str = MODEL_VERSION,
    ) -> tuple[str, str]:
        """Request a pre-signed upload URL from the MinerU API.

        Returns (batch_id, upload_url).
        """
        url = f"{BASE_URL}/file-urls/batch"
        payload = {
            "files": [{"name": filename, "data_id": filename[:128]}],
            "model_version": model_version,
            "enable_formula": True,
            "enable_table": True,
        }
        resp = requests.post(url, headers=self._headers(), json=payload, timeout=30)
        body = _parse_response(resp, "request upload URL")
        data = body["data"]
        batch_id: str = data["batch_id"]
        file_urls: list[str] = data["file_urls"]
        if not file_urls:
            raise MineruError("API returned no upload URLs")
        return batch_id, file_urls[0]

    def _upload_file(self, upload_url: str, document_path: Path) -> None:
        """PUT the document binary to the pre-signed upload URL."""
        with document_path.open("rb") as f:
            resp = requests.put(upload_url, data=f, timeout=300)
        if resp.status_code != 200:
            raise MineruError(
                f"File upload failed: status={resp.status_code} "
                f"url={upload_url} body={resp.text[:500]}"
            )

    def _poll_until_done(
        self,
        batch_id: str,
        poll_interval: int,
        timeout: int,
    ) -> str:
        """Poll the batch results endpoint until the file is done.

        Returns the full_zip_url for the completed extraction.
        """
        url = f"{BASE_URL}/extract-results/batch/{batch_id}"
        deadline = time.monotonic() + timeout

        while True:
            if time.monotonic() > deadline:
                raise MineruTimeoutError(
                    f"Extraction not finished after {timeout}s "
                    f"(batch_id={batch_id})"
                )

            resp = requests.get(
                url,
                headers=self._headers(),
                timeout=30,
            )
            body = _parse_response(resp, "poll extraction status")
            results = body["data"]["extract_result"]

            if not results:
                time.sleep(poll_interval)
                continue

            result = results[0]
            state = result["state"]

            match state:
                case "done":
                    zip_url = result.get("full_zip_url")
                    if not zip_url:
                        raise MineruError(
                            f"Extraction done but no full_zip_url: "
                            f"batch_id={batch_id}"
                        )
                    return zip_url
                case "failed":
                    raise MineruError(
                        f"Extraction failed: batch_id={batch_id} "
                        f"err_msg={result.get('err_msg', '(none)')}"
                    )
                case _:
                    time.sleep(poll_interval)


# ------------------------------------------------------------------
# Module-level helpers
# ------------------------------------------------------------------


def _parse_response(resp: requests.Response, context: str) -> dict:
    """Validate an API response and return the parsed JSON body.

    Raises MineruError with full context on any failure.
    """
    if resp.status_code != 200:
        raise MineruError(
            f"MinerU API error during {context}: "
            f"status={resp.status_code} url={resp.url} body={resp.text[:500]}"
        )

    try:
        body = resp.json()
    except ValueError as exc:
        raise MineruError(
            f"Non-JSON response during {context}: "
            f"url={resp.url} body={resp.text[:500]}"
        ) from exc

    if body.get("code") != 0:
        raise MineruError(
            f"MinerU API returned error during {context}: "
            f"code={body.get('code')} msg={body.get('msg')} url={resp.url}"
        )

    return body


def _download_zip(zip_url: str) -> bytes:
    """Download a result ZIP and return the raw bytes."""
    resp = requests.get(zip_url, timeout=120)
    if resp.status_code != 200:
        raise MineruError(
            f"Failed to download result ZIP: status={resp.status_code} "
            f"url={zip_url}"
        )
    return resp.content


def extract_zip_contents(zip_data: bytes) -> tuple[str, dict[str, bytes]]:
    """Extract markdown and images from a MinerU result ZIP.

    Returns:
        A tuple of (markdown_text, images_dict) where images_dict maps
        relative paths (e.g. "images/abc.jpg") to their binary content.
    """
    with zipfile.ZipFile(io.BytesIO(zip_data)) as zf:
        md_files = [n for n in zf.namelist() if n.endswith(".md")]
        if not md_files:
            raise MineruError(
                f"No .md file found in result ZIP. "
                f"Contents: {zf.namelist()}"
            )
        markdown = "\n\n".join(
            zf.read(name).decode("utf-8") for name in sorted(md_files)
        )

        images: dict[str, bytes] = {}
        for name in zf.namelist():
            parts = name.replace("\\", "/").split("/")
            try:
                idx = parts.index("images")
            except ValueError:
                continue
            if name.endswith("/"):
                continue
            rel_path = "/".join(parts[idx:])
            images[rel_path] = zf.read(name)

        return markdown, images
