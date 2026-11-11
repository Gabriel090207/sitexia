"""Short-lived owner-authorized video playback, independent of generation/credits."""
from datetime import datetime, timedelta, timezone
import logging
import re

from fastapi import HTTPException
from google.api_core.exceptions import NotFound

from app.services.firebase import bucket, db
from app.services.storage_results import authorize_result_path

logger = logging.getLogger(__name__)
ACCESS_SECONDS = 30 * 60
VIDEO_EXTENSIONS = {
    "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "video/ogg": "ogv",
    "video/x-m4v": "m4v", "video/x-matroska": "mkv", "video/x-msvideo": "avi",
    "video/avi": "avi", "video/mpeg": "mpg", "video/x-ms-wmv": "wmv",
}
VIDEO_TYPES = set(VIDEO_EXTENSIONS)


def create_video_access(uid: str, item_id: str, *, download: bool = False) -> dict:
    # Never take ownership from a request parameter or a client-written record.
    if any(not value or value in {".", ".."} or any(c in value for c in "/\\%")
           or any(ord(c) < 32 or ord(c) == 127 for c in value) for value in (uid, item_id)):
        raise HTTPException(400, "Identificador inválido.")
    try:
        snapshot = db.collection("users").document(uid).collection("swaps").document(item_id).get()
    except Exception:
        raise HTTPException(503, "Não foi possível consultar o resultado.") from None
    if not snapshot.exists:
        raise HTTPException(404, "Resultado não encontrado.")
    item = snapshot.to_dict()
    if not isinstance(item, dict):
        raise HTTPException(409, "Referência do resultado inconsistente.")
    # Face Swap uses imageUrl even for video. Type is origin, not media evidence.
    values = [item[field] for field in ("imageUrl", "videoUrl") if item.get(field)]
    if not values:
        raise HTTPException(404, "Referência do resultado não encontrada.")
    paths = {authorize_result_path(value, uid, bucket.name) for value in values}
    if len(paths) != 1:
        raise HTTPException(409, "Referência do resultado ambígua.")
    path = paths.pop()
    folder = path.split("/")[2]
    if folder not in {"swaps", "videos"}:
        raise HTTPException(415, "O resultado não pertence a um diretório de vídeos suportado.")
    try:
        blob = bucket.blob(path)
        blob.reload()
    except NotFound:
        raise HTTPException(404, "Arquivo não encontrado.") from None
    except Exception:
        raise HTTPException(503, "Não foi possível validar o vídeo.") from None
    generation = str(blob.generation)
    if (not re.fullmatch(r"[1-9][0-9]*", generation) or isinstance(blob.size, bool)
            or not isinstance(blob.size, int) or blob.size <= 0):
        raise HTTPException(409, "Metadados do resultado inconsistentes.")
    raw_type = blob.content_type
    content_type = raw_type.split(";", 1)[0].strip().lower() if isinstance(raw_type, str) else ""
    if content_type not in VIDEO_TYPES:
        raise HTTPException(415, "O arquivo não possui um tipo de vídeo suportado.")
    issued_at = datetime.now(timezone.utc).replace(microsecond=0)
    expires_at = issued_at + timedelta(seconds=ACCESS_SECONDS)
    filename = f"xia-{'face-swap' if folder == 'swaps' else 'video-generation'}-{issued_at.strftime('%Y%m%d-%H%M%S')}.{VIDEO_EXTENSIONS[content_type]}"
    disposition = f'attachment; filename="{filename}"' if download else "inline"
    try:
        # Do not sign a fixed Range header: the player must request arbitrary bytes.
        url = blob.generate_signed_url(version="v4", expiration=expires_at, method="GET",
                                       generation=generation, response_type=content_type,
                                       response_disposition=disposition, scheme="https")
    except Exception as error:
        logger.warning("Video access signing failed errorType=%s", type(error).__name__)
        raise HTTPException(503, "Não foi possível preparar o acesso temporário ao vídeo.") from None
    return {"url": url, "expiresAt": expires_at, "expiresInSeconds": ACCESS_SECONDS,
            "mediaType": "video", "contentType": content_type,
            "origin": "face-swap" if folder == "swaps" else "video-generation",
            **({"filename": filename} if download else {})}
