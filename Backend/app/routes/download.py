from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response, RedirectResponse, JSONResponse
from fastapi.encoders import jsonable_encoder
from google.api_core.exceptions import NotFound

from app.services.firebase import bucket, db
from app.services.storage_results import authorize_result_path
from app.services.video_access import create_video_access, VIDEO_TYPES
from app.dependencies.auth import AuthenticatedUser, get_current_user


router = APIRouter(
    prefix="/download",
    tags=["download"],
)


def authorized_object_path(file_url: str, uid: str) -> str:
    return authorize_result_path(file_url, uid, bucket.name)


@router.get("/{user_id}/{item_id}")
def download_library_item(
    user_id: str,
    item_id: str,
    current_user: Annotated[AuthenticatedUser, Depends(get_current_user)],
    delivery: Literal["redirect", "direct"] = "redirect",
):
    """Images retain binary delivery. Videos use a signed attachment URL:
    delivery=direct returns its descriptor; the default redirects native clients.
    """
    if user_id != current_user.uid:
        raise HTTPException(status_code=403, detail="Acesso não autorizado.")
    if any(part in {"", ".", ".."} or "/" in part or "\\" in part
           for part in (user_id, item_id)):
        raise HTTPException(status_code=400, detail="Identificador inválido.")


    item_ref = (
        db
        .collection("users")
        .document(user_id)
        .collection("swaps")
        .document(item_id)
    )

    try:
        item_snapshot = item_ref.get()
    except Exception:
        raise HTTPException(503, "Não foi possível consultar o resultado.") from None

    if not item_snapshot.exists:
        raise HTTPException(
            status_code=404,
            detail="Arquivo não encontrado.",
        )

    item = item_snapshot.to_dict()
    if not isinstance(item, dict):
        raise HTTPException(409, "Referência do resultado inconsistente.")

    item_type = item.get("type") or "face-swap"

    if item_type == "video-generation":

        file_url = item.get("videoUrl")

        base_name = "xia-video-generation"

        extension = ".mp4"

        media_type = "video/mp4"

    elif item_type == "image-generation":

        file_url = item.get("imageUrl")

        base_name = "xia-image-generation"

        extension = ".png"

        media_type = "image/png"

    elif item_type == "face-swap":

        file_url = item.get("videoUrl") or item.get("imageUrl")

        base_name = "xia-face-swap"

        extension = ".png"

        media_type = "image/png"

    else:

        raise HTTPException(
            status_code=400,
            detail="Tipo de arquivo inválido.",
        )

    if not file_url:

        raise HTTPException(
            status_code=404,
            detail="URL do arquivo não encontrada.",
        )

    file_path = authorized_object_path(file_url, current_user.uid)

    blob = bucket.blob(file_path)

    try:
        blob.reload()
    except NotFound:
        raise HTTPException(404, "Arquivo não encontrado no Storage.") from None
    except Exception:
        raise HTTPException(503, "Não foi possível verificar o arquivo.") from None
    raw_type = blob.content_type
    content_type = raw_type.split(";", 1)[0].strip().lower() if isinstance(raw_type, str) else ""
    if content_type in VIDEO_TYPES:
        # Compatibility for authenticated GET clients, without buffering video.
        access = create_video_access(current_user.uid, item_id, download=True)
        if delivery == "direct":
            return JSONResponse(jsonable_encoder(access), headers={"Cache-Control": "private, no-store"})
        return RedirectResponse(access["url"], status_code=303, headers={"Cache-Control": "private, no-store"})
    if item.get("mediaType") == "video" or item_type == "video-generation" or item.get("videoUrl"):
        raise HTTPException(415, "O arquivo não possui um tipo de vídeo compatível.")
    if content_type not in {"image/jpeg", "image/png", "image/webp", "image/gif", "image/avif", "image/bmp"}:
        raise HTTPException(415, "O tipo do arquivo não é compatível com download.")
    try:
        file_bytes = blob.download_as_bytes()
    except NotFound:
        raise HTTPException(404, "Arquivo não encontrado no Storage.") from None
    except Exception:
        raise HTTPException(503, "Não foi possível baixar o arquivo.") from None

    created_at = item.get("createdAt")

    if hasattr(created_at, "strftime"):

        date_string = created_at.strftime(
            "%Y%m%d-%H%M%S"
        )

    else:

        date_string = "".join(c for c in item_id[:8] if c.isascii() and c.isalnum()) or "arquivo"

    filename = (
        f"{base_name}-{date_string}{extension}"
    )

    return Response(
        content=file_bytes,
        media_type=media_type,
        headers={
            "Content-Disposition":
                f'attachment; filename="{filename}"',
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff"
        },
    )
