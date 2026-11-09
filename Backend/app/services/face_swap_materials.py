"""Backend-owned associations; clients must not be allowed to write this collection."""
import logging

from fastapi import HTTPException
from google.api_core.exceptions import AlreadyExists
from google.cloud import firestore

from app.services.firebase import db

logger = logging.getLogger(__name__)
COLLECTION = "face_swap_materials"


def normalize_material_id(value) -> str:
    # Provider IDs are decimal integers. Never round through float/JavaScript number.
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise ValueError("Invalid material ID")
    value = str(value)
    if not value or not value.isascii() or not value.isdecimal():
        raise ValueError("Invalid material ID")
    value = value.lstrip("0")
    if not value or len(value) > 1500:
        raise ValueError("Invalid material ID")
    return value


def register_material_owner(material_id: str, uid: str) -> None:
    try:
        # Atomic create: never replace an existing association, including on retry.
        db.collection(COLLECTION).document(material_id).create({
            "uid": uid,
            "materialId": material_id,
            "createdAt": firestore.SERVER_TIMESTAMP,
        })
    except AlreadyExists:
        raise HTTPException(409, "Não foi possível registrar o material.") from None
    except Exception as error:
        logger.warning("Material ownership write failed: errorType=%s", type(error).__name__)
        raise HTTPException(503, "Não foi possível registrar o material.") from None


def require_material_owner(material_id: str, uid: str) -> None:
    try:
        snapshot = db.collection(COLLECTION).document(material_id).get()
        data = snapshot.to_dict() if snapshot.exists else None
    except Exception as error:
        logger.warning("Material ownership read failed: errorType=%s", type(error).__name__)
        raise HTTPException(503, "Não foi possível consultar o material.") from None
    if not isinstance(data, dict) or data.get("uid") != uid or data.get("materialId") != material_id:
        raise HTTPException(404, "Material não encontrado.")
