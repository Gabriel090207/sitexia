"""Owner-scoped immutable Storage references; no financial dependencies."""
import re
from urllib.parse import unquote, urlsplit

from fastapi import HTTPException
from google.api_core.exceptions import NotFound


def authorize_storage_input(uid, target_url, folder, label, limits):
    """Resolve a client URL to an owned, immutable Storage object, never fetch it.

    Only the current UUID-scoped Firebase upload layout is accepted. Download
    tokens/query parameters from the client are ignored. Signing failure is closed.
    """
    from app.services.firebase import bucket
    try:
        if not isinstance(target_url, str) or any(ord(c) < 32 for c in target_url):
            raise ValueError()
        url = urlsplit(target_url)
        if (url.scheme != "https" or url.netloc != "firebasestorage.googleapis.com"
                or url.username or url.password or url.fragment):
            raise ValueError()
        prefix = f"/v0/b/{bucket.name}/o/"
        if not url.path.startswith(prefix):
            raise ValueError()
        path = unquote(url.path[len(prefix):], errors="strict")
        expected = rf"{re.escape(folder)}/{re.escape(uid)}/[0-9a-f]{{8}}-[0-9a-f]{{4}}-4[0-9a-f]{{3}}-[89ab][0-9a-f]{{3}}-[0-9a-f]{{12}}(?:[.][a-zA-Z0-9]{{1,10}})?"
        if not re.fullmatch(expected, path):
            raise ValueError()
    except (ValueError, TypeError):
        raise HTTPException(403, f"Arquivo {label} não autorizado.") from None
    try:
        blob = bucket.blob(path)
        blob.reload()
        generation = str(blob.generation)
        if (not generation.isdecimal() or blob.content_type not in limits
                or not isinstance(blob.size, int) or not 0 < blob.size <= limits.get(blob.content_type, 0)):
            raise HTTPException(400, f"Arquivo {label} inválido.")
        identity = f"{bucket.name}/{path}@{generation}"
        # Signing is deferred until a new operation actually needs a send.
        return identity, blob, generation
    except NotFound:
        raise HTTPException(404, f"Arquivo {label} não encontrado.") from None
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(503, f"Não foi possível validar o arquivo {label}.") from None
