"""Pure pricing for trusted DeepSwap material responses; no I/O or billing.

Callers must obtain metadata from the provider and verify material ownership.
Results use int/float, as accepted by generation_credits (not Decimal).
"""
from collections.abc import Mapping
import math
from typing import Any


class InvalidFaceSwapMetadata(ValueError):
    """Provider metadata cannot safely determine a Xia credit price."""


def _duration(value: Any) -> int | float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise InvalidFaceSwapMetadata("Duração do material inválida.")
    if isinstance(value, float) and not math.isfinite(value):
        raise InvalidFaceSwapMetadata("Duração do material inválida.")
    return value


def calculate_face_swap_price(material: Mapping[str, Any]) -> int | float:
    """IMAGE costs 0.1; VIDEO costs ceil(seconds / 15), at least one.

    IMAGE may omit duration or report zero; a positive video duration on an
    image is inconsistent. GIF has no supported provider classification here.
    """
    if not isinstance(material, Mapping):
        raise InvalidFaceSwapMetadata("Metadados do material inválidos.")
    material_type = material.get("materialType")
    if material_type == "IMAGE":
        duration = material.get("duration")
        if duration is not None and _duration(duration) != 0:
            raise InvalidFaceSwapMetadata("Duração incompatível com material de imagem.")
        # Same float literal as existing Xia pricing; no monetary arithmetic.
        return 0.1
    if material_type == "VIDEO":
        duration = _duration(material.get("duration"))
        if duration <= 0:
            raise InvalidFaceSwapMetadata("Duração do vídeo deve ser positiva.")
        # Integer ratio avoids rounding a tiny positive duration to zero or a
        # value just above a 15-second boundary down to the preceding tier.
        numerator, denominator = (
            duration.as_integer_ratio() if isinstance(duration, float)
            else (duration, 1)
        )
        divisor = 15 * denominator
        return max(1, (numerator + divisor - 1) // divisor)
    raise InvalidFaceSwapMetadata("Tipo de material não suportado para cálculo.")
