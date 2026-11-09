"""Trusted-backend-only reservations. Not connected to routes or provider calls.

Authorization of material/face belongs to the caller. target_identity must be
a stable backend-verified identity (e.g. storage object path + immutable version),
not a client declaration or a signed download URL. Only its SHA-256 is stored.
The generations collection must disallow direct client writes.
"""
import hashlib
import json
import math
import re
from collections.abc import Mapping
from uuid import uuid4

from firebase_admin import firestore

from app.services.firebase import db

from app.services.face_swap_materials import normalize_material_id
from app.services.face_swap_pricing import calculate_face_swap_price
from app.services.face_swap_tasks import COLLECTION as TASKS_COLLECTION, task_owner_record
from app.services.generation_credits import (
    InsufficientCredits,
    ReservationConflict,
    reserve_generation_credits,
    finalize_generation_in_transaction,
)

MODEL = "shapetransformer3.1-fs"
PRICE_VERSION = "xia-face-swap-v1"


class InvalidFaceSwapEvidence(ValueError):
    """Incomplete or incompatible provider evidence; never implies failure."""


def _validate_finalization(operation, uid, generation_id):
    if not isinstance(operation, dict) or operation.get("userId") != uid:
        raise FaceSwapOperationNotFound("Operação não encontrada.")
    if (operation.get("generationId") != generation_id or operation.get("type") != "face-swap"
            or operation.get("mode") != "face-swap"):
        raise InvalidFaceSwapEvidence("Operação financeira incompatível.")
    try:
        task_id = normalize_material_id(operation.get("taskId"))
        cost = operation.get("cost")
        if (task_id != operation.get("taskId") or isinstance(cost, bool)
                or not isinstance(cost, (int, float)) or not math.isfinite(cost) or cost <= 0):
            raise ValueError()
    except (ValueError, OverflowError):
        raise InvalidFaceSwapEvidence("Vínculo ou valor financeiro inválido.") from None
    expected_states = {"reserved": "PROCESSING", "charged": "SUCCEEDED", "released": "FAILED"}
    if (operation.get("creditStatus") not in expected_states
            or operation.get("status") != expected_states[operation["creditStatus"]]):
        raise InvalidFaceSwapEvidence("Estado financeiro inválido.")
    intent = operation.get("reservationIntent")
    if (not isinstance(intent, dict) or not operation.get("submissionAttemptId")
            or operation.get("taskLinkedAt") is None):
        raise InvalidFaceSwapEvidence("Operação sem vínculo financeiro válido.")
    return task_id


@firestore.transactional
def _finalize_confirmed_task(transaction, uid, generation_id, observed_task_id, provider_status):
    reference = db.collection("generations").document(generation_id)
    snapshot = reference.get(transaction=transaction)
    if not snapshot.exists:
        raise FaceSwapOperationNotFound("Operação não encontrada.")
    operation = snapshot.to_dict()
    task_id = _validate_finalization(operation, uid, generation_id)
    if task_id != observed_task_id:
        raise InvalidFaceSwapEvidence("Tarefa incompatível com a confirmação.")
    task_snapshot = db.collection(TASKS_COLLECTION).document(task_id).get(transaction=transaction)
    owner = task_snapshot.to_dict() if task_snapshot.exists else None
    intent = operation["reservationIntent"]
    expected = {
        "uid": uid, "taskId": task_id, "generationId": generation_id,
        "materialId": intent.get("materialId"), "sourceFaceId": intent.get("sourceFaceId"),
        "submissionAttemptId": operation["submissionAttemptId"],
    }
    if (not isinstance(owner, dict) or any(owner.get(k) != v for k, v in expected.items())
            or not expected["materialId"] or not expected["sourceFaceId"]):
        raise InvalidFaceSwapEvidence("Propriedade da tarefa incompatível.")
    if provider_status not in {"SUCCEEDED", "FAILED", "PENDING", "RUNNING", "UNKNOWN"}:
        raise InvalidFaceSwapEvidence("Confirmação do provedor inválida.")
    financial = operation["creditStatus"]
    if financial in {"charged", "released"}:
        if provider_status in {"SUCCEEDED", "FAILED"} and provider_status != operation["status"]:
            # Sanitized durable evidence; no provider bodies, URLs or personal data.
            transaction.update(reference, {
                "lastConflictingStatus": provider_status,
                "lastConflictAt": firestore.SERVER_TIMESTAMP,
            })
        return operation
    if provider_status in {"PENDING", "RUNNING", "UNKNOWN"}:
        return operation
    # All ownership/evidence reads precede the shared primitive's financial writes.
    # Use the frozen cost. Do not recalculate current prices or metadata.
    return finalize_generation_in_transaction(transaction, generation_id, provider_status == "SUCCEEDED")


async def _fetch_face_swap_task(task_id):
    from app.services.deepswap import get
    return await get(f"/openapi/v1/tasks/{task_id}", log_response=False)


async def finalize_face_swap_operation(uid: str, generation_id: str) -> dict:
    """Fetch server-side evidence, then finalize atomically; never trust client status.

    Transport, parsing and storage failures propagate without release. No provider
    call is inside a transaction. Legacy tasks without financial links are denied.
    """
    if not isinstance(uid, str) or not uid.strip() or "/" in uid:
        raise FaceSwapOperationNotFound("Operação não encontrada.")
    if not isinstance(generation_id, str) or not re.fullmatch(r"[0-9a-f]{64}", generation_id):
        raise FaceSwapOperationNotFound("Operação não encontrada.")
    snapshot = db.collection("generations").document(generation_id).get()
    if not snapshot.exists:
        raise FaceSwapOperationNotFound("Operação não encontrada.")
    task_id = _validate_finalization(snapshot.to_dict(), uid, generation_id)
    task = await _fetch_face_swap_task(task_id)
    if not isinstance(task, dict):
        raise InvalidFaceSwapEvidence("Resposta do provedor inválida.")
    if "taskId" in task:
        try:
            returned_id = normalize_material_id(task["taskId"])
        except ValueError:
            raise InvalidFaceSwapEvidence("Identificador retornado inválido.") from None
        if returned_id != task_id:
            raise InvalidFaceSwapEvidence("Tarefa retornada incompatível.")
    status = task.get("taskStatus")
    if not isinstance(status, str) or status not in {"SUCCEEDED", "FAILED", "PENDING", "RUNNING", "UNKNOWN"}:
        raise InvalidFaceSwapEvidence("Estado retornado inválido.")
    return _finalize_confirmed_task(db.transaction(), uid, generation_id, task_id, status)


class FaceSwapOperationNotFound(ValueError):
    """Missing operation or different owner; deliberately indistinguishable."""


class FaceSwapSubmissionUnavailable(ValueError):
    """Operation is invalid, already attempted or no longer reserved."""


def _valid_operation_intent(operation, uid, generation_id):
    if not isinstance(operation, dict) or operation.get("userId") != uid:
        raise FaceSwapOperationNotFound("Operação não encontrada.")
    if (
        operation.get("generationId") != generation_id
        or operation.get("type") != "face-swap"
        or operation.get("mode") != "face-swap"
        or operation.get("creditStatus") != "reserved"
    ):
        raise FaceSwapSubmissionUnavailable("Operação indisponível para envio.")
    intent = operation.get("reservationIntent")
    try:
        if not isinstance(intent, dict):
            raise ValueError()
        key = intent.get("operationId")
        if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", key):
            raise ValueError()
        expected_id = hashlib.sha256(
            json.dumps([uid, "face-swap:" + key], ensure_ascii=False).encode("utf-8")
        ).hexdigest()
        if expected_id != generation_id or intent.get("model") != MODEL or intent.get("priceVersion") != PRICE_VERSION:
            raise ValueError()
        for field in ("materialId", "sourceFaceId"):
            if normalize_material_id(intent.get(field)) != intent.get(field):
                raise ValueError()
        identity = intent.get("targetIdentityHash")
        if not isinstance(identity, str) or not re.fullmatch(r"[0-9a-f]{64}", identity):
            raise ValueError()
        expected_cost = calculate_face_swap_price(intent)
    except (ValueError, TypeError):
        raise FaceSwapSubmissionUnavailable("Intenção financeira inválida.") from None
    cost = operation.get("cost")
    if isinstance(cost, bool) or not isinstance(cost, (int, float)) or cost != expected_cost:
        raise FaceSwapSubmissionUnavailable("Reserva financeira inválida.")
    return cost


def _valid_reserved_operation(operation, uid, generation_id):
    cost = _valid_operation_intent(operation, uid, generation_id)
    if (operation.get("status") != "CREATED" or operation.get("taskId") is not None
            or "submissionAttemptId" in operation or "submissionAcquiredAt" in operation):
        raise FaceSwapSubmissionUnavailable("Operação indisponível para envio.")
    return cost


def _validate_user_reserve(user, cost):
    if not isinstance(user, dict):
        raise FaceSwapSubmissionUnavailable("Reserva financeira inválida.")
    balance, reserved = user.get("credits"), user.get("reservedCredits")
    try:
        if any(isinstance(value, bool) or not isinstance(value, (int, float))
               or not math.isfinite(value) or value < 0 for value in (balance, reserved)):
            raise ValueError()
        if reserved < cost or balance < reserved:
            raise ValueError()
    except (ValueError, OverflowError):
        raise FaceSwapSubmissionUnavailable("Reserva financeira inválida.") from None


@firestore.transactional
def _acquire_submission(transaction, uid, generation_id, attempt_id):
    reference = db.collection("generations").document(generation_id)
    snapshot = reference.get(transaction=transaction)
    if not snapshot.exists:
        raise FaceSwapOperationNotFound("Operação não encontrada.")
    operation = snapshot.to_dict()
    cost = _valid_reserved_operation(operation, uid, generation_id)
    user_snapshot = db.collection("users").document(uid).get(transaction=transaction)
    user = user_snapshot.to_dict() if user_snapshot.exists else None
    _validate_user_reserve(user, cost)
    update = {
        "status": "SUBMITTING",
        "submissionAttemptId": attempt_id,
        "submissionAcquiredAt": firestore.SERVER_TIMESTAMP,
        "updatedAt": firestore.SERVER_TIMESTAMP,
    }
    transaction.update(reference, update)
    return {**operation, **update}


def acquire_face_swap_submission(uid: str, generation_id: str) -> dict:
    """Return a single durable send grant, only after a successful transaction.

    No lease expiration or automatic takeover. A crash/lost commit response
    leaves SUBMITTING pending for investigation; retries cannot grant again.
    Storage errors propagate, never authorizing a send. Callers must not treat
    a persisted attempt ID or an existing reservation as a new send grant.
    """
    if not isinstance(uid, str) or not uid.strip() or "/" in uid:
        raise FaceSwapOperationNotFound("Operação não encontrada.")
    if not isinstance(generation_id, str) or not re.fullmatch(r"[0-9a-f]{64}", generation_id):
        raise FaceSwapOperationNotFound("Operação não encontrada.")
    # Generate once, outside the retryable transaction; no external side effects.
    return _acquire_submission(db.transaction(), uid, generation_id, uuid4().hex)


@firestore.transactional
def _link_task(transaction, uid, generation_id, attempt_id, task_id):
    reference = db.collection("generations").document(generation_id)
    snapshot = reference.get(transaction=transaction)
    if not snapshot.exists:
        raise FaceSwapOperationNotFound("Operação não encontrada.")
    operation = snapshot.to_dict()
    cost = _valid_operation_intent(operation, uid, generation_id)
    if (operation.get("submissionAttemptId") != attempt_id
            or operation.get("submissionAcquiredAt") is None):
        raise FaceSwapSubmissionUnavailable("Tentativa não autorizada.")
    intent = operation["reservationIntent"]
    expected = {
        "taskId": task_id, "uid": uid, "materialId": intent["materialId"],
        "sourceFaceId": intent["sourceFaceId"], "generationId": generation_id,
        "submissionAttemptId": attempt_id,
    }
    task_ref = db.collection(TASKS_COLLECTION).document(task_id)
    task_snapshot = task_ref.get(transaction=transaction)
    user_snapshot = db.collection("users").document(uid).get(transaction=transaction)
    _validate_user_reserve(user_snapshot.to_dict() if user_snapshot.exists else None, cost)
    if operation.get("taskId") is not None:
        # Retry only if BOTH committed records agree. Never repair by claiming
        # an existing task, including legacy records owned by the same user.
        task = task_snapshot.to_dict() if task_snapshot.exists else None
        if (operation.get("taskId") == task_id and operation.get("status") == "PROCESSING"
                and isinstance(task, dict) and all(task.get(k) == v for k, v in expected.items())
                and operation.get("taskLinkedAt") is not None and task.get("createdAt") is not None):
            return operation
        raise ReservationConflict("Vínculo de tarefa conflitante.")
    if operation.get("status") != "SUBMITTING":
        raise FaceSwapSubmissionUnavailable("Operação indisponível para vinculação.")
    if task_snapshot.exists:
        raise ReservationConflict("Vínculo de tarefa conflitante.")
    update = {
        "taskId": task_id, "status": "PROCESSING",
        "taskLinkedAt": firestore.SERVER_TIMESTAMP, "updatedAt": firestore.SERVER_TIMESTAMP,
    }
    owner = task_owner_record(task_id, uid, intent["materialId"], intent["sourceFaceId"])
    owner.update(generationId=generation_id, submissionAttemptId=attempt_id)
    transaction.create(task_ref, owner)
    transaction.update(reference, update)
    return {**operation, **update}


def link_face_swap_task(uid: str, generation_id: str, attempt_id: str, task_id: str) -> dict:
    """Atomically bind a provider task to its authorized attempt and owner.

    Only call with a task ID obtained from the provider, never a client claim.
    Storage failure leaves SUBMITTING/reserved (or an already committed link);
    retry THIS binding, never acquire/send a new external attempt.
    """
    if not isinstance(uid, str) or not uid.strip() or "/" in uid:
        raise FaceSwapOperationNotFound("Operação não encontrada.")
    if not isinstance(generation_id, str) or not re.fullmatch(r"[0-9a-f]{64}", generation_id):
        raise FaceSwapOperationNotFound("Operação não encontrada.")
    if not isinstance(attempt_id, str) or not re.fullmatch(r"[0-9a-f]{32}", attempt_id):
        raise FaceSwapSubmissionUnavailable("Tentativa não autorizada.")
    try:
        task_id = normalize_material_id(task_id)
    except ValueError:
        raise FaceSwapSubmissionUnavailable("Identificador de tarefa inválido.") from None
    return _link_task(db.transaction(), uid, generation_id, attempt_id, task_id)


def reserve_face_swap_operation(
    uid: str,
    operation_id: str,
    material_id: str,
    source_face_id: str,
    target_identity: str,
    material: Mapping,
    *,
    model: str = MODEL,
) -> dict:
    """Reserve once per (uid, operation_id); mismatched intent raises conflict.

    Returns the existing record even if already terminal, without another hold.
    Does not grant permission to submit an external task on repeated calls.
    InsufficientCredits/ReservationConflict are controlled ValueError subclasses;
    transaction/storage errors propagate so callers cannot treat them as success.
    """
    if not isinstance(operation_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", operation_id):
        raise ValueError("Identificador da operação inválido.")
    if not isinstance(target_identity, str) or not target_identity.strip() or len(target_identity) > 4096:
        raise ValueError("Identidade da imagem de destino inválida.")
    if any(marker in target_identity for marker in ("://", "?", "#")):
        raise ValueError("Use uma identidade estável, não uma URL de acesso.")
    if model != MODEL:
        raise ValueError("Modelo de Face Swap inválido.")
    material_id = normalize_material_id(material_id)
    source_face_id = normalize_material_id(source_face_id)
    if not isinstance(material, Mapping) or normalize_material_id(material.get("materialId")) != material_id:
        raise ValueError("Metadados incompatíveis com o material.")
    cost = calculate_face_swap_price(material)
    # Shared finance stores floats; reject values that would lose an integer tier.
    try:
        numeric_cost = float(cost)
    except OverflowError:
        raise ValueError("Preço não representável.") from None
    if not math.isfinite(numeric_cost) or numeric_cost != cost:
        raise ValueError("Preço não representável.")
    intent = {
        "operationId": operation_id,
        "materialId": material_id,
        "sourceFaceId": source_face_id,
        "targetIdentityHash": hashlib.sha256(target_identity.encode("utf-8")).hexdigest(),
        "model": model,
        "priceVersion": PRICE_VERSION,
        "materialType": material["materialType"],
        "duration": material.get("duration") if material["materialType"] == "VIDEO" else None,
    }
    # Namespace prevents collision with a key used by another generator.
    return reserve_generation_credits(
        uid, "face-swap:" + operation_id, cost, "face-swap", "face-swap",
        reservation_intent=intent,
    )
