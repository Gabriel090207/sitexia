"""Reconciliação manual/admin de reservas de imagem, sem agendador.

Execute reconcile_image_reservations() e passe next_cursor na próxima chamada
até retornar None. Em uma nova rodada, comece sem cursor. O cursor evita que
reservas sem taskId impeçam o processamento das páginas seguintes.

Query: type == image-generation, creditStatus == reserved, ordenada por ID.
Se o Firestore solicitar índice composto, criar em generations:
(type ASC, creditStatus ASC, __name__ ASC). Nenhum índice é criado aqui.

Não há TTL: timeout HTTP e polling de 3s não são limites de processamento
do provedor. Sem taskId, é necessária reconsulta por
identificador do provedor ou intervenção administrativa após confirmação.
"""

import logging

from google.cloud.firestore_v1.base_query import FieldFilter

from app.services.firebase import db
from app.services.deepswap import get
from app.services.generation_credits import (
    GENERATIONS_COLLECTION,
    charge_reserved_generation,
    release_reserved_generation,
)

logger = logging.getLogger(__name__)


def list_reserved_image_generations(limit: int = 100, after_id: str | None = None) -> list:
    """Lista limitada por cursor; não lê a coleção inteira."""
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 1000:
        raise ValueError("Limite inválido.")
    collection = db.collection(GENERATIONS_COLLECTION)
    query = (
        collection.where(filter=FieldFilter("type", "==", "image-generation"))
        .where(filter=FieldFilter("creditStatus", "==", "reserved"))
        .order_by("__name__")
    )
    if after_id is not None:
        if not isinstance(after_id, str) or not after_id or "/" in after_id:
            raise ValueError("Cursor inválido.")
        query = query.start_after({"__name__": collection.document(after_id)})
    return list(query.limit(limit).stream())


async def reconcile_image_reservations(limit: int = 100, after_id: str | None = None) -> dict:
    """Processa uma página. Não confiar em estados de sucesso enviados por clientes."""
    snapshots = list_reserved_image_generations(limit, after_id)
    results = []
    for snapshot in snapshots:
        generation_id = snapshot.id
        task_id = None
        outcome = "kept_error"
        try:
            # Evita consultas desnecessárias se o polling já finalizou a reserva.
            current = snapshot.reference.get()
            generation = current.to_dict() if current.exists else {}
            if generation.get("type") != "image-generation" or generation.get("creditStatus") != "reserved":
                outcome = "skipped"
            else:
                task_id = generation.get("taskId")
                if task_id is None:
                    outcome = "kept_without_task"
                elif not isinstance(task_id, str) or not task_id.strip():
                    outcome = "kept_invalid_task"
                else:
                    task = await get(f"/openapi/v1/tasks/{task_id}", log_response=False)
                    status = task.get("taskStatus") if isinstance(task, dict) else None
                    returned_id = task.get("taskId") if isinstance(task, dict) else None
                    if returned_id is not None and str(returned_id) != task_id:
                        outcome = "kept_mismatched_task"
                    elif status == "SUCCEEDED":
                        finalized = charge_reserved_generation(generation_id)
                        outcome = finalized["creditStatus"]
                    elif status == "FAILED":
                        finalized = release_reserved_generation(generation_id)
                        outcome = finalized["creditStatus"]
                    elif status in ("PENDING", "RUNNING"):
                        outcome = "kept_processing"
                    else:
                        outcome = "kept_unknown_status"
        except Exception as error:
            # Exceção de transporte/HTTP/parsing não é falha terminal da geração.
            # Não incluir a mensagem da exceção: pode conter URL/resposta sensível.
            logger.warning(
                "Reconciliação generationId=%s taskId=%s outcome=%s errorType=%s",
                generation_id, task_id, outcome, type(error).__name__,
            )
        else:
            logger.info(
                "Reconciliação generationId=%s taskId=%s outcome=%s",
                generation_id, task_id, outcome,
            )
        results.append({"generationId": generation_id, "taskId": task_id, "outcome": outcome})
    return {
        "results": results,
        "next_cursor": snapshots[-1].id if len(snapshots) == limit else None,
    }
