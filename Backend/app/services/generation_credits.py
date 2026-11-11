"""Reservas transacionais. Uso exclusivo por código confiável do backend.

operation_id deve ser estável nos retries da mesma solicitação. A confirmação
externa de sucesso/falha cabe ao chamador; este módulo não consulta provedores.
"""

import hashlib
import json
import math
from copy import deepcopy

from firebase_admin import firestore
from app.services.firestore_transactions import isolated_transactional
from google.cloud.firestore_v1.base_query import FieldFilter

from app.services.firebase import db


GENERATIONS_COLLECTION = "generations"


class ReservationConflict(ValueError):
    """An operation key already identifies a different intent."""


class InsufficientCredits(ValueError):
    """Available credits cannot cover the reservation."""


def get_generation_by_task_for_user(task_id: str, user_id: str) -> dict | None:
    """None indica ausência de vínculo; vínculo de outro usuário é rejeitado."""
    _identifier(task_id)
    _identifier(user_id)
    matches = list(
        db.collection(GENERATIONS_COLLECTION)
        .where(filter=FieldFilter("taskId", "==", task_id)).limit(2).stream()
    )
    if not matches:
        return None
    if len(matches) != 1:
        raise ValueError("Geração não encontrada.")
    generation = matches[0].to_dict()
    if generation.get("userId") != user_id:
        raise ValueError("Geração não encontrada.")
    return {"generationId": matches[0].id, "type": generation.get("type")}


def _identifier(value: str) -> str:
    if not isinstance(value, str) or not value.strip() or "/" in value:
        raise ValueError("Identificador inválido.")
    return value


def _amount(value) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("Valor de créditos inválido.")
    amount = float(value)
    if not math.isfinite(amount) or amount < 0:
        raise ValueError("Valor de créditos inválido.")
    return amount


def _subtract(balance: float, cost: float) -> float:
    result = balance - cost
    # Compensa apenas resíduos de precisão binária, sem mudar a unidade monetária.
    if result < 0:
        if math.isclose(balance, cost, rel_tol=0, abs_tol=1e-12):
            return 0.0
        raise ValueError("Saldo de créditos inconsistente.")
    return result


def _generation(transaction, generation_id):
    ref = db.collection(GENERATIONS_COLLECTION).document(_identifier(generation_id))
    snapshot = ref.get(transaction=transaction)
    if not snapshot.exists:
        raise ValueError("Geração não encontrada.")
    return ref, snapshot.to_dict()


@isolated_transactional
def _reserve(transaction, generation_id, user_id, cost, generation_type, mode, reservation_intent=None):
    generation_ref = db.collection(GENERATIONS_COLLECTION).document(generation_id)
    user_ref = db.collection("users").document(user_id)
    generation_snapshot = generation_ref.get(transaction=transaction)
    user_snapshot = user_ref.get(transaction=transaction)
    if not user_snapshot.exists:
        raise ValueError("Usuário não encontrado.")
    if generation_snapshot.exists:
        existing = generation_snapshot.to_dict()
        expected = {"userId": user_id, "cost": cost, "type": generation_type, "mode": mode}
        if reservation_intent is not None:
            expected["reservationIntent"] = reservation_intent
        if any(existing.get(key) != value for key, value in expected.items()):
            raise ReservationConflict("A operação já existe com dados diferentes.")
        # Operações terminadas também nunca são reservadas novamente.
        return existing

    user = user_snapshot.to_dict()
    credits = _amount(user.get("credits", 0))
    reserved = _amount(user.get("reservedCredits", 0))
    if credits - reserved < cost:
        raise InsufficientCredits("Créditos insuficientes.")
    generation = {
        "generationId": generation_id,
        "userId": user_id,
        "cost": cost,
        "type": generation_type,
        "mode": mode,
        "taskId": None,
        "status": "CREATED",
        "creditStatus": "reserved",
        "createdAt": firestore.SERVER_TIMESTAMP,
        "updatedAt": firestore.SERVER_TIMESTAMP,
    }
    if reservation_intent is not None:
        generation["reservationIntent"] = reservation_intent
    transaction.create(generation_ref, generation)
    transaction.update(user_ref, {"reservedCredits": reserved + cost})
    return generation


def reserve_generation_credits(
    user_id: str,
    operation_id: str,
    cost: float,
    generation_type: str,
    mode: str | None = None,
    *,
    reservation_intent: dict | None = None,
) -> dict:
    _identifier(user_id)
    if not isinstance(operation_id, str) or not operation_id.strip():
        raise ValueError("Identificador da operação inválido.")
    _identifier(generation_type)
    if mode is not None:
        _identifier(mode)
    cost = _amount(cost)
    if cost <= 0:
        raise ValueError("Custo de geração inválido.")
    generation_id = hashlib.sha256(
        json.dumps([user_id, operation_id], ensure_ascii=False).encode("utf-8")
    ).hexdigest()
    if reservation_intent is None:
        # Preserve the existing callers and their document shape.
        return _reserve(db.transaction(), generation_id, user_id, cost, generation_type, mode)
    if not isinstance(reservation_intent, dict):
        raise ValueError("Intenção da reserva inválida.")
    return _reserve(
        db.transaction(), generation_id, user_id, cost, generation_type, mode,
        deepcopy(reservation_intent),
    )


@isolated_transactional
def _attach(transaction, generation_id, task_id):
    ref, generation = _generation(transaction, generation_id)
    existing_task = generation.get("taskId")
    if existing_task == task_id:
        return generation
    if existing_task is not None:
        raise ValueError("A geração já possui outra tarefa vinculada.")
    if generation.get("creditStatus") != "reserved":
        raise ValueError("A reserva da geração já foi finalizada.")
    updates = {"taskId": task_id, "status": "PROCESSING", "updatedAt": firestore.SERVER_TIMESTAMP}
    transaction.update(ref, updates)
    return {**generation, **updates}


def attach_generation_task(generation_id: str, task_id: str) -> dict:
    return _attach(db.transaction(), generation_id, _identifier(task_id))


def finalize_generation_in_transaction(transaction, generation_id, charge):
    """Internal server primitive; caller owns the transaction and evidence checks."""
    ref, generation = _generation(transaction, generation_id)
    credit_status = generation.get("creditStatus")
    if credit_status in ("charged", "released"):
        return generation
    if credit_status != "reserved":
        raise ValueError("Estado de reserva inválido.")
    cost = _amount(generation["cost"])
    if cost <= 0:
        raise ValueError("Custo de geração inválido.")
    user_ref = db.collection("users").document(_identifier(generation["userId"]))
    snapshot = user_ref.get(transaction=transaction)
    if not snapshot.exists:
        raise ValueError("Usuário não encontrado.")
    user = snapshot.to_dict()
    reserved = _amount(user.get("reservedCredits", 0))
    user_updates = {"reservedCredits": _subtract(reserved, cost)}
    if charge:
        user_updates["credits"] = _subtract(_amount(user.get("credits", 0)), cost)
    updates = {
        "creditStatus": "charged" if charge else "released",
        "status": "SUCCEEDED" if charge else "FAILED",
        "updatedAt": firestore.SERVER_TIMESTAMP,
    }
    transaction.update(user_ref, user_updates)
    transaction.update(ref, updates)
    return {**generation, **updates}


@isolated_transactional
def _finalize(transaction, generation_id, charge):
    return finalize_generation_in_transaction(transaction, generation_id, charge)


def charge_reserved_generation(generation_id: str) -> dict:
    """Chamar somente após confirmar sucesso no backend; nunca a partir de alegação do cliente."""
    return _finalize(db.transaction(), generation_id, True)


def release_reserved_generation(generation_id: str) -> dict:
    """Libera uma reserva após falha confirmada; não reembolsa gerações cobradas."""
    return _finalize(db.transaction(), generation_id, False)
