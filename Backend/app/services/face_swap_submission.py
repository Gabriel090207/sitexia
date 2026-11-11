"""Backend-only orchestration of the existing Face Swap finance primitives."""
import hashlib
import json
import logging
from datetime import timedelta

import httpx
from fastapi import HTTPException

from app.services.firebase import db
from app.services.storage_inputs import authorize_storage_input as _authorize_input
from app.services import face_swap_operations as operations
from app.services.face_swap_materials import normalize_material_id
from app.services.face_swap_pricing import InvalidFaceSwapMetadata
from app.services.generation_credits import InsufficientCredits, ReservationConflict

logger = logging.getLogger(__name__)


def finance_call(function, *args, **kwargs):
    """Never retry external sends after storage/transaction failures."""
    try:
        return function(*args, **kwargs)
    except InsufficientCredits:
        raise HTTPException(402, "Créditos insuficientes.") from None
    except ReservationConflict:
        raise HTTPException(409, "A chave de idempotência já foi usada com outra intenção.") from None
    except operations.FaceSwapOperationNotFound:
        raise HTTPException(404, "Operação não encontrada.") from None
    except operations.FaceSwapSubmissionUnavailable:
        raise HTTPException(409, "A operação não está disponível para um novo envio.") from None
    except InvalidFaceSwapMetadata:
        raise HTTPException(400, "Metadados do material não permitem calcular o preço com segurança.") from None
    except Exception:
        raise HTTPException(503, "Não foi possível confirmar a operação financeira. Preserve a chave de idempotência.") from None


def operation_id(uid, key):
    return hashlib.sha256(json.dumps([uid, "face-swap:" + key], ensure_ascii=False).encode("utf-8")).hexdigest()


def read_operation(uid, key):
    identifier = operation_id(uid, key)
    snapshot = db.collection("generations").document(identifier).get()
    if not snapshot.exists:
        return None
    data = snapshot.to_dict()
    if (not isinstance(data, dict) or data.get("userId") != uid
            or data.get("generationId") != identifier or data.get("type") != "face-swap"
            or data.get("mode") != "face-swap"):
        raise operations.FaceSwapOperationNotFound()
    return data



def authorize_target(uid, target_url):
    return _authorize_input(uid, target_url, "face-swap-faces", "de rosto",
                            {mime: 10 * 1024 * 1024 for mime in ("image/jpeg", "image/png", "image/webp")})


# Official Face Swap material limits: 10 MB images, 1.5 GB videos.
_ORIGINAL_LIMITS = {mime: 10_000_000 for mime in ("image/jpeg", "image/png", "image/webp")}
_ORIGINAL_LIMITS.update({mime: 1_500_000_000 for mime in (
    "video/mp4", "video/quicktime", "video/webm", "video/x-msvideo", "video/avi",
    "video/x-ms-wmv", "video/mpeg", "video/x-m4v", "video/ogg", "video/x-matroska",
)})


def prepare_original_url(uid, original_url):
    """Authorize original by owner namespace, never by its download token."""
    _, blob, generation = _authorize_input(uid, original_url, "face-swap", "original", _ORIGINAL_LIMITS)
    try:
        return blob.generate_signed_url(version="v4", expiration=timedelta(hours=1),
                                        method="GET", generation=generation)
    except Exception:
        raise HTTPException(503, "Não foi possível preparar o arquivo original. Nenhum material foi enviado.") from None


def existing_response(operation):
    identifier = operation["generationId"]
    if operation.get("taskId"):
        try:
            task_id = normalize_material_id(operation["taskId"])
        except ValueError:
            raise HTTPException(503, "Vínculo financeiro inválido; nenhum novo envio foi autorizado.") from None
        status = {"PROCESSING": "PENDING", "SUCCEEDED": "SUCCEEDED", "FAILED": "FAILED"}.get(operation.get("status"))
        if status is None:
            raise HTTPException(409, {"code": "operation_pending", "generationId": identifier})
        return {"taskId": task_id, "taskStatus": status, "generationId": identifier}
    raise HTTPException(409, {"code": "operation_pending_or_cancelled", "generationId": identifier,
                              "message": "Nenhum novo envio foi autorizado. Preserve a chave de idempotência."})


async def submit_face_swap(uid, key, material_id, source_face_id, target_url, load_material, create_task):
    identity, blob, generation = authorize_target(uid, target_url)
    existing = finance_call(read_operation, uid, key)
    if existing is not None:
        intent = existing.get("reservationIntent")
        if (not isinstance(intent, dict) or intent.get("operationId") != key
                or intent.get("materialId") != material_id or intent.get("sourceFaceId") != source_face_id
                or intent.get("targetIdentityHash") != hashlib.sha256(identity.encode("utf-8")).hexdigest()
                or intent.get("model") != operations.MODEL):
            raise HTTPException(409, "A chave de idempotência já foi usada com outra intenção.")
        if existing.get("status") != "CREATED" or existing.get("creditStatus") != "reserved":
            return existing_response(existing)
        operation = existing
    else:
        material = await load_material(material_id)
        if not isinstance(material, dict) or material.get("status") != "SUCCEEDED":
            raise HTTPException(409, "O material não está pronto para Face Swap.")
        faces = material.get("faces")
        if not isinstance(faces, list):
            raise HTTPException(502, "A Deep retornou dados de rostos inválidos.")
        try:
            ids = {normalize_material_id(face.get("id")) for face in faces if isinstance(face, dict)}
        except ValueError:
            raise HTTPException(502, "A Deep retornou dados de rostos inválidos.") from None
        if source_face_id not in ids:
            raise HTTPException(400, "O rosto não pertence ao material informado.")
        operation = finance_call(operations.reserve_face_swap_operation, uid, key, material_id,
                                 source_face_id, identity, material)
        if operation.get("status") != "CREATED" or operation.get("creditStatus") != "reserved":
            return existing_response(operation)
    # Prepare URL before acquisition. A local signing failure cannot create a task.
    try:
        signed_url = blob.generate_signed_url(version="v4", expiration=timedelta(hours=1),
                                              method="GET", generation=generation)
    except Exception:
        finance_call(operations.cancel_face_swap_operation, uid, operation["generationId"])
        raise HTTPException(503, "Não foi possível preparar o arquivo de rosto. Nenhuma tarefa foi enviada.") from None
    try:
        grant = finance_call(operations.acquire_face_swap_submission, uid, operation["generationId"])
    except HTTPException as error:
        if error.status_code == 409:
            latest = finance_call(read_operation, uid, key)
            if latest is not None:
                return existing_response(latest)
        raise
    try:
        task = await create_task(material_id, source_face_id, signed_url)
        task_id = normalize_material_id(task.get("taskId") if isinstance(task, dict) else None)
    except Exception:
        # SUBMITTING cannot be cancelled by the current verified-evidence contract.
        raise HTTPException(502, {"code": "submission_unconfirmed", "generationId": operation["generationId"],
                                  "message": "Criação não confirmada; reserva mantida. Não crie outra operação."}) from None
    try:
        linked = finance_call(operations.link_face_swap_task, uid, operation["generationId"],
                              grant["submissionAttemptId"], task_id)
    except HTTPException:
        # Trusted provider ID for administrative binding recovery, never a resend.
        logger.warning("Face Swap binding pending generationId=%s taskId=%s",
                       operation["generationId"], task_id)
        raise
    return {"taskId": task_id, "taskStatus": "PENDING", "generationId": linked["generationId"]}


async def finalize_linked_task(uid, task_id):
    """Legacy ownership documents have no generationId: never charge them again."""
    try:
        owner = db.collection("face_swap_tasks").document(task_id).get().to_dict()
        if not isinstance(owner, dict) or owner.get("uid") != uid or owner.get("taskId") != task_id:
            raise HTTPException(404, "Tarefa não encontrada.")
        if "generationId" not in owner:
            if "submissionAttemptId" in owner:
                raise HTTPException(503, "Vínculo financeiro incompleto.")
            return None
        reference = db.collection("generations").document(owner["generationId"])
        operation = reference.get().to_dict()
        if operations._validate_finalization(operation, uid, owner["generationId"]) != task_id:
            raise HTTPException(503, "Vínculo financeiro incompatível com a tarefa consultada.")
        return await operations.finalize_face_swap_operation(uid, owner["generationId"])
    except HTTPException:
        raise
    except (httpx.HTTPError, json.JSONDecodeError):
        raise HTTPException(502, "Não foi possível confirmar o estado financeiro na Deep.") from None
    except Exception:
        raise HTTPException(503, "Não foi possível confirmar a operação financeira. Consulte novamente a mesma tarefa.") from None
