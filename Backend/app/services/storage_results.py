"""Validate owner-scoped result addresses independently of client library data."""
from urllib.parse import unquote, urlsplit

from fastapi import HTTPException


def authorize_result_path(file_url: str, uid: str, bucket_name: str) -> str:
    """Library URLs are client-written; enforce bucket and owner independently."""
    try:
        if not isinstance(file_url, str) or any(ord(c) < 32 for c in file_url):
            raise ValueError
        parsed = urlsplit(file_url)
        prefix = f"/v0/b/{bucket_name}/o/"
        if (parsed.scheme != "https" or parsed.netloc != "firebasestorage.googleapis.com"
                or not parsed.path.startswith(prefix) or parsed.fragment):
            raise ValueError
        path = unquote(parsed.path[len(prefix):], errors="strict")
        parts = path.split("/")
        if (len(parts) < 4 or parts[:2] != ["users", uid]
                or parts[2] not in {"swaps", "images", "videos"}
                or any(part in {"", ".", ".."} for part in parts)
                or any(c in path for c in ("\\", "%"))
                or any(ord(c) < 32 for c in path)):
            raise ValueError
        return path
    except (ValueError, UnicodeError):
        raise HTTPException(status_code=403, detail="Referência de arquivo não autorizada.") from None
