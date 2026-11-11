"""Validate private video input images before any credit reservation or send."""
from datetime import timedelta
from io import BytesIO
import warnings

from fastapi import HTTPException
from google.api_core.exceptions import NotFound, PreconditionFailed
from PIL import Image, UnidentifiedImageError

from app.services.storage_inputs import authorize_storage_input

MAX_IMAGE_BYTES = 20_000_000
# Bound decompression work independently of model-specific dimension rules.
MAX_CONTENT_PIXELS = 64_000_000
MIME_FORMATS = {"image/jpeg": "JPEG", "image/png": "PNG", "image/webp": "WEBP"}


def prepare_video_reference(uid: str, url: str, *, bounded_dimensions: bool) -> str:
    _, blob, generation = authorize_storage_input(
        uid, url, "video-generation", "de referência",
        {mime: MAX_IMAGE_BYTES for mime in MIME_FORMATS},
    )
    expected_size, expected_format = blob.size, MIME_FORMATS[blob.content_type]
    try:
        # Bounded read and precondition: never validate a replacement version.
        content = blob.download_as_bytes(start=0, end=MAX_IMAGE_BYTES,
                                         if_generation_match=int(generation), raw_download=True)
    except (NotFound, PreconditionFailed):
        raise HTTPException(409, "A referência foi alterada ou removida. Envie o arquivo novamente.") from None
    except Exception:
        raise HTTPException(503, "Não foi possível verificar a imagem de referência.") from None
    if not content or len(content) > MAX_IMAGE_BYTES or len(content) != expected_size:
        raise HTTPException(400, "Tamanho da imagem de referência inválido.")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(content), formats=list(MIME_FORMATS.values())) as image:
                width, height = image.size
                if image.format != expected_format or width * height > MAX_CONTENT_PIXELS:
                    raise ValueError()
                if bounded_dimensions and not (240 <= width <= 8000 and 240 <= height <= 8000):
                    raise ValueError()
                if image.format == "PNG" and ("A" in image.getbands() or "transparency" in image.info):
                    raise ValueError()
                image.verify()
            # Decode as well: header/MIME alone cannot validate image content.
            with Image.open(BytesIO(content), formats=list(MIME_FORMATS.values())) as image:
                image.load()
    except (ValueError, OSError, SyntaxError, UnidentifiedImageError,
            Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise HTTPException(400, "Conteúdo, dimensões ou transparência da referência incompatíveis.") from None
    try:
        return blob.generate_signed_url(version="v4", expiration=timedelta(hours=1),
                                        method="GET", generation=generation)
    except Exception:
        raise HTTPException(503, "Não foi possível preparar a imagem de referência.") from None
