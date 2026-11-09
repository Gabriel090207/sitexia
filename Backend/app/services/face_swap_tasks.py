"""Server-only task ownership; no financial operations."""
import logging

from fastapi import HTTPException
from google.api_core.exceptions import AlreadyExists
from google.cloud import firestore

from app.services.firebase import db
from app.services.face_swap_materials import normalize_material_id as normalize_swap_id

logger = logging.getLogger(__name__)
COLLECTION = "face_swap_tasks"


def task_owner_record(task_id: str, uid: str, material_id: str, source_face_id: str) -> dict:
    """Shared schema for legacy creation and transactional financial linking."""
    return {
        "taskId": task_id, "uid": uid, "materialId": material_id,
        "sourceFaceId": source_face_id, "createdAt": firestore.SERVER_TIMESTAMP,
    }


def register_task_owner(task_id: str, uid: str, material_id: str, source_face_id: str) -> None:
    try:
        db.collection(COLLECTION).document(task_id).create(
            task_owner_record(task_id, uid, material_id, source_face_id)
        )
    except AlreadyExists:
        raise HTTPException(409, "Não foi possível registrar a tarefa.") from None
    except Exception as error:
        logger.warning("Task ownership write failed: errorType=%s", type(error).__name__)
        raise HTTPException(503, "Não foi possível registrar a tarefa.") from None


def require_task_owner(task_id: str, uid: str) -> None:
    try:
        snapshot = db.collection(COLLECTION).document(task_id).get()
        data = snapshot.to_dict() if snapshot.exists else None
    except Exception as error:
        logger.warning("Task ownership read failed: errorType=%s", type(error).__name__)
        raise HTTPException(503, "Não foi possível consultar a tarefa.") from None
    if not isinstance(data, dict) or data.get("uid") != uid or data.get("taskId") != task_id:
        raise HTTPException(404, "Tarefa não encontrada.")
