"""Manual/admin reconciliation; no scheduler or routes.

Call reconcile_face_swap_reservations() without a cursor for the first page.
Pass each returned next_cursor as after_id for the NEXT PAGE of the same scan,
until next_cursor is None. Only a NEW full scan starts without a cursor.
A full last page may require one extra empty page to discover the end.
Records inserted before an already passed cursor are visited on the next scan;
the multi-page scan is not a database-wide snapshot. Each page reads at most limit
reserved face-swap operations, including unlinked records for separate review.
Index, if requested by Firestore, on generations:
(type ASC, creditStatus ASC, __name__ ASC). No index is created by this module.

No TTL, resubmission, legacy debit migration or automatic release on errors.
"""
import logging
import re

from google.cloud.firestore_v1.base_query import FieldFilter

from app.services.firebase import db
from app.services.generation_credits import GENERATIONS_COLLECTION
from app.services.face_swap_tasks import COLLECTION as TASKS_COLLECTION
from app.services.face_swap_operations import (
    InvalidFaceSwapEvidence,
    _validate_finalization,
    finalize_face_swap_operation,
)

logger = logging.getLogger(__name__)


def list_reserved_face_swap_operations(limit: int = 100, after_id: str | None = None) -> list:
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 1000:
        raise ValueError("Limite inválido.")
    collection = db.collection(GENERATIONS_COLLECTION)
    query = (
        collection.where(filter=FieldFilter("type", "==", "face-swap"))
        .where(filter=FieldFilter("creditStatus", "==", "reserved"))
        .order_by("__name__")
    )
    if after_id is not None:
        if not isinstance(after_id, str) or not after_id or "/" in after_id:
            raise ValueError("Cursor inválido.")
        query = query.start_after({"__name__": collection.document(after_id)})
    return list(query.limit(limit).stream())


def _require_financial_link(operation, generation_id):
    """Preflight only; existing finalization rechecks links inside its transaction."""
    uid = operation.get("userId")
    if not isinstance(uid, str) or not uid.strip() or "/" in uid:
        raise InvalidFaceSwapEvidence("Proprietário financeiro inválido.")
    task_id = _validate_finalization(operation, uid, generation_id)
    snapshot = db.collection(TASKS_COLLECTION).document(task_id).get()
    owner = snapshot.to_dict() if snapshot.exists else None
    intent = operation["reservationIntent"]
    expected = {
        "uid": uid, "taskId": task_id, "generationId": generation_id,
        "materialId": intent.get("materialId"), "sourceFaceId": intent.get("sourceFaceId"),
        "submissionAttemptId": operation["submissionAttemptId"],
    }
    if (not isinstance(owner, dict) or any(owner.get(k) != v for k, v in expected.items())
            or not expected["materialId"] or not expected["sourceFaceId"]):
        raise InvalidFaceSwapEvidence("Vínculo financeiro inválido.")
    return uid


async def reconcile_face_swap_reservations(limit: int = 100, after_id: str | None = None) -> dict:
    """Process one bounded page; per-operation failures preserve funds and continue.

    kept_processing_or_unknown means finalization confirmed a nonterminal state;
    it deliberately does not infer a provider failure from elapsed time.
    Page/query failures propagate so a runner can retry without losing its cursor.
    """
    snapshots = list_reserved_face_swap_operations(limit, after_id)
    results = []
    for snapshot in snapshots:
        generation_id = snapshot.id
        safe_id = generation_id if re.fullmatch(r"[0-9a-f]{64}", generation_id) else "invalid"
        outcome = "kept_error"
        try:
            current = snapshot.reference.get()
            operation = current.to_dict() if current.exists else None
            if (not isinstance(operation, dict) or operation.get("type") != "face-swap"
                    or operation.get("creditStatus") != "reserved"):
                outcome = "skipped"
            elif operation.get("taskId") is None:
                outcome = ("review_submitting_without_task" if operation.get("status") == "SUBMITTING"
                           else "review_without_task")
            else:
                if safe_id == "invalid":
                    raise InvalidFaceSwapEvidence("Identificador financeiro inválido.")
                uid = _require_financial_link(operation, generation_id)
                finalized = await finalize_face_swap_operation(uid, generation_id)
                outcome = (finalized["creditStatus"] if finalized["creditStatus"] in ("charged", "released")
                           else "kept_processing_or_unknown")
        except InvalidFaceSwapEvidence:
            outcome = "review_invalid_link_or_evidence"
            logger.warning("Face Swap reconciliation generationId=%s outcome=%s", safe_id, outcome)
        except Exception as error:
            # Never log exception messages, provider bodies, URLs, user IDs or traces.
            logger.warning("Face Swap reconciliation generationId=%s outcome=%s errorType=%s",
                           safe_id, outcome, type(error).__name__)
        else:
            logger.info("Face Swap reconciliation generationId=%s outcome=%s", safe_id, outcome)
        results.append({"generationId": generation_id, "outcome": outcome})
    return {
        "results": results,
        "next_cursor": snapshots[-1].id if len(snapshots) == limit else None,
    }
