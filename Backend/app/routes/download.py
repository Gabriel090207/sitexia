from urllib.parse import unquote, urlparse

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from app.services.firebase import bucket, db


router = APIRouter(
    prefix="/download",
    tags=["download"],
)


@router.get("/{user_id}/{item_id}")
def download_library_item(
    user_id: str,
    item_id: str,
):

    item_ref = (
        db
        .collection("users")
        .document(user_id)
        .collection("swaps")
        .document(item_id)
    )

    item_snapshot = item_ref.get()

    if not item_snapshot.exists:
        raise HTTPException(
            status_code=404,
            detail="Arquivo não encontrado.",
        )

    item = item_snapshot.to_dict()

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

        file_url = item.get("imageUrl")

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

    parsed_url = urlparse(file_url)

    file_path = unquote(
        parsed_url.path.split("/o/", 1)[-1]
    )

    blob = bucket.blob(file_path)

    if not blob.exists():

        raise HTTPException(
            status_code=404,
            detail="Arquivo não encontrado no Storage.",
        )

    file_bytes = blob.download_as_bytes()

    created_at = item.get("createdAt")

    if created_at:

        date_string = created_at.strftime(
            "%Y%m%d-%H%M%S"
        )

    else:

        date_string = item_id[:8]

    filename = (
        f"{base_name}-{date_string}{extension}"
    )

    return Response(
        content=file_bytes,
        media_type=media_type,
        headers={
            "Content-Disposition":
                f'attachment; filename="{filename}"'
        },
    )