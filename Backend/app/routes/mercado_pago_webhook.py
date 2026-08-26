from decimal import Decimal, InvalidOperation
import hashlib
import hmac
import os
from typing import Any

from fastapi import APIRouter, HTTPException, Request, status
from firebase_admin import firestore
from google.cloud.firestore_v1.base_query import FieldFilter

from app.services.firebase import db
from app.services.mercado_pago_orders import (
    MercadoPagoOrderNotFoundError,
    MercadoPagoOrdersAPIError,
    MercadoPagoOrdersConfigurationError,
    MercadoPagoOrdersNetworkError,
    get_order,
)


router = APIRouter(
    prefix="/webhooks/mercado-pago",
    tags=["Mercado Pago Webhooks"],
)


ORDER_STATUS_MAP = {
    ("action_required", "waiting_transfer"): "pending",
    ("processing", "in_process"): "processing",
    ("processed", "accredited"): "approved",
    ("failed", "failed"): "failed",
    ("canceled", "canceled"): "cancelled",
    ("expired", "expired"): "expired",
    ("refunded", "refunded"): "refunded",
}

TERMINAL_STATUSES = {"approved", "failed", "cancelled", "expired", "refunded"}
STATUS_RANK = {
    "pending": 1,
    "processing": 2,
    "failed": 3,
    "cancelled": 3,
    "expired": 3,
    "approved": 4,
    "refunded": 5,
}


def _invalid_signature() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Assinatura de webhook inválida.",
    )


def _parse_signature(x_signature: str) -> tuple[str, str]:
    parts = {}
    for part in x_signature.split(","):
        key, separator, value = part.strip().partition("=")
        if separator and key and value:
            parts[key] = value

    timestamp = parts.get("ts")
    signature = parts.get("v1")
    if not timestamp or not signature:
        raise _invalid_signature()
    return timestamp, signature


def validate_webhook_signature(
    data_id: str,
    x_request_id: str | None,
    x_signature: str | None,
) -> None:
    secret = os.getenv("MERCADO_PAGO_WEBHOOK_SECRET")
    if not secret:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Webhook temporariamente indisponível.",
        )
    if not x_request_id or not x_signature:
        raise _invalid_signature()

    timestamp, received_signature = _parse_signature(x_signature)
    signature_data_id = data_id.lower() if data_id.isalnum() else data_id
    manifest = (
        f"id:{signature_data_id};request-id:{x_request_id};ts:{timestamp};"
    )
    expected_signature = hmac.new(
        secret.encode(),
        manifest.encode(),
        hashlib.sha256,
    ).hexdigest()

    if not hmac.compare_digest(expected_signature, received_signature):
        raise _invalid_signature()


def _first_payment(order: dict[str, Any]) -> dict[str, Any]:
    transactions = order.get("transactions")
    if not isinstance(transactions, dict):
        return {}
    payments = transactions.get("payments")
    if not isinstance(payments, list) or not payments:
        return {}
    return payments[0] if isinstance(payments[0], dict) else {}


def _decimal_amount(value: Any) -> Decimal | None:
    try:
        amount = Decimal(str(value)).quantize(Decimal("0.01"))
    except (InvalidOperation, TypeError, ValueError):
        return None
    return amount if amount.is_finite() else None


def _credit_amount(value: Any) -> int:
    if isinstance(value, bool):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Quantidade de créditos da recarga inválida.",
        )
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        amount = Decimal("NaN")
    if not amount.is_finite() or amount <= 0 or amount != amount.to_integral():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Quantidade de créditos da recarga inválida.",
        )
    return int(amount)


def _credit_balance(value: Any) -> int | float:
    if value is None:
        return 0
    if isinstance(value, bool):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Saldo de créditos do usuário inválido.",
        )
    try:
        balance = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        balance = Decimal("NaN")
    if not balance.is_finite() or balance < 0:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Saldo de créditos do usuário inválido.",
        )
    return int(balance) if balance == balance.to_integral() else float(balance)


def _normalized_status(order: dict[str, Any]) -> str | None:
    return ORDER_STATUS_MAP.get(
        (order.get("status"), order.get("status_detail"))
    )


def _current_internal_status(data: dict[str, Any]) -> str | None:
    current = data.get("status")
    if current in STATUS_RANK:
        return current
    return ORDER_STATUS_MAP.get(
        (data.get("status"), data.get("status_detail"))
    )


def _can_apply_status(current: str | None, new: str) -> bool:
    if current is None or current == new:
        return True
    if current == "approved" and new == "refunded":
        return True
    if current in TERMINAL_STATUSES:
        return False
    return STATUS_RANK[new] >= STATUS_RANK.get(current, 0)


def _validate_order_relationship(
    order: dict[str, Any],
    order_id: str,
    topup_id: str,
    topup: dict[str, Any],
    attempt: dict[str, Any],
) -> None:
    if str(order.get("id")) != order_id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Order incompatível com a notificação.",
        )

    external_reference = order.get("external_reference")
    if (
        not isinstance(external_reference, str)
        or external_reference.strip() != topup_id
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Order incompatível com a recarga.",
        )

    order_amount = _decimal_amount(order.get("total_amount"))
    topup_amount = _decimal_amount(topup.get("amount"))
    if order_amount is None or topup_amount is None or order_amount != topup_amount:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Valor da Order incompatível com a recarga.",
        )

    if topup.get("currency") != "BRL":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Moeda da recarga incompatível.",
        )

    payment = _first_payment(order)
    order_currency = order.get("currency") or payment.get("currency_id")
    if order_currency is not None and order_currency != "BRL":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Moeda da Order incompatível com a recarga.",
        )

    payment_id = payment.get("id")
    attempt_payment_id = attempt.get("mercado_pago_payment_id")
    if (
        attempt_payment_id is not None
        and (
            payment_id is None
            or str(payment_id) != str(attempt_payment_id)
        )
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Pagamento incompatível com a tentativa.",
        )

    attempt_method = attempt.get("payment_method")
    payment_method = payment.get("payment_method")
    method_id = (
        payment_method.get("id")
        if isinstance(payment_method, dict)
        else None
    )
    method_type = (
        payment_method.get("type")
        if isinstance(payment_method, dict)
        else None
    )

    valid_method = False
    if attempt_method == "pix":
        valid_method = method_id == "pix" and method_type == "bank_transfer"
    elif attempt_method == "card":
        valid_method = (
            isinstance(method_id, str)
            and bool(method_id.strip())
            and method_type == "credit_card"
        )

    if not valid_method:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Método de pagamento incompatível com a tentativa.",
        )


@firestore.transactional
def reconcile_order_transaction(
    transaction,
    topup_ref,
    attempt_ref,
    order: dict[str, Any],
    order_id: str,
    internal_status: str,
):
    topup_snapshot = next(transaction.get(topup_ref))
    attempt_snapshot = next(transaction.get(attempt_ref))
    if not topup_snapshot.exists or not attempt_snapshot.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Recarga ou tentativa não encontrada.",
        )

    topup = topup_snapshot.to_dict()
    attempt = attempt_snapshot.to_dict()
    if (
        attempt.get("topup_id") != topup_ref.id
        or attempt.get("uid") != topup.get("uid")
        or str(attempt.get("mercado_pago_order_id")) != order_id
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Order incompatível com a tentativa.",
        )

    _validate_order_relationship(
        order,
        order_id,
        topup_ref.id,
        topup,
        attempt,
    )
    attempt_status = _current_internal_status(attempt)
    topup_status = _current_internal_status(topup)
    current_status = max(
        (value for value in (attempt_status, topup_status) if value),
        key=lambda value: STATUS_RANK.get(value, 0),
        default=None,
    )
    if not _can_apply_status(attempt_status, internal_status) or not (
        _can_apply_status(topup_status, internal_status)
    ):
        return current_status

    raw_status = order.get("status")
    raw_status_detail = order.get("status_detail")
    if (
        attempt_status == internal_status
        and topup_status == internal_status
        and attempt.get("mercado_pago_status") == raw_status
        and attempt.get("mercado_pago_status_detail") == raw_status_detail
        and topup.get("mercado_pago_status") == raw_status
        and topup.get("mercado_pago_status_detail") == raw_status_detail
    ):
        return internal_status

    payment = _first_payment(order)
    attempt_update = {
        "status": internal_status,
        "status_detail": raw_status_detail,
        "mercado_pago_status": raw_status,
        "mercado_pago_status_detail": raw_status_detail,
        "updated_at": firestore.SERVER_TIMESTAMP,
    }
    if payment.get("id") is not None:
        attempt_update["mercado_pago_payment_id"] = payment["id"]

    transaction.update(attempt_ref, attempt_update)
    transaction.update(
        topup_ref,
        {
            "status": internal_status,
            "status_detail": raw_status_detail,
            "mercado_pago_status": raw_status,
            "mercado_pago_status_detail": raw_status_detail,
            "updated_at": firestore.SERVER_TIMESTAMP,
        },
    )
    return internal_status


@firestore.transactional
def grant_topup_credits_once(
    transaction,
    topup_ref,
    user_ref,
    credit_transaction_ref,
    expected_uid: str,
    order_id: str,
    payment_attempt_id: str,
):
    topup_snapshot = next(transaction.get(topup_ref))
    user_snapshot = next(transaction.get(user_ref))
    credit_transaction_snapshot = next(
        transaction.get(credit_transaction_ref)
    )

    if not topup_snapshot.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Recarga não encontrada.",
        )
    topup = topup_snapshot.to_dict()
    if topup.get("uid") != expected_uid:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Usuário da recarga incompatível.",
        )

    if (
        topup.get("credits_granted") is True
        or credit_transaction_snapshot.exists
    ):
        return False

    if not user_snapshot.exists:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Usuário da recarga não encontrado.",
        )

    if (
        topup.get("status") != "approved"
        or topup.get("status_detail") != "accredited"
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A recarga não está aprovada para concessão de créditos.",
        )

    credits = _credit_amount(topup.get("credits"))
    user = user_snapshot.to_dict()
    balance_before = _credit_balance(user.get("credits"))
    balance_after = balance_before + credits

    transaction.update(user_ref, {"credits": balance_after})
    transaction.create(
        credit_transaction_ref,
        {
            "uid": expected_uid,
            "type": "topup",
            "amount": credits,
            "topup_id": topup_ref.id,
            "mercado_pago_order_id": order_id,
            "payment_attempt_id": payment_attempt_id,
            "package_id": topup.get("package_id"),
            "balance_before": balance_before,
            "balance_after": balance_after,
            "created_at": firestore.SERVER_TIMESTAMP,
        },
    )
    transaction.update(
        topup_ref,
        {
            "credits_granted": True,
            "credits_granted_at": firestore.SERVER_TIMESTAMP,
            "updated_at": firestore.SERVER_TIMESTAMP,
        },
    )
    return True


@router.post("/orders")
async def mercado_pago_orders_webhook(request: Request):
    try:
        body = await request.json()
    except ValueError:
        body = {}
    if not isinstance(body, dict):
        body = {}

    body_data = body.get("data")
    body_data_id = body_data.get("id") if isinstance(body_data, dict) else None
    data_id = request.query_params.get("data.id") or body_data_id
    if data_id is None or not str(data_id).strip():
        raise _invalid_signature()
    order_id = str(data_id).strip()

    validate_webhook_signature(
        order_id,
        request.headers.get("x-request-id"),
        request.headers.get("x-signature"),
    )

    event_type = request.query_params.get("type") or body.get("type")
    if event_type != "order":
        return {"received": True, "ignored": True}

    try:
        order = get_order(order_id)
    except MercadoPagoOrderNotFoundError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Order não encontrada.",
        ) from None
    except MercadoPagoOrdersConfigurationError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Webhook temporariamente indisponível.",
        ) from None
    except (MercadoPagoOrdersNetworkError, MercadoPagoOrdersAPIError):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Não foi possível consultar a Order.",
        ) from None

    if str(order.get("id")) != order_id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Order incompatível com a notificação.",
        )

    external_reference = order.get("external_reference")
    if not isinstance(external_reference, str) or not external_reference.strip():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Order sem referência de recarga.",
        )
    topup_id = external_reference.strip()
    topup_ref = db.collection("topups").document(topup_id)
    topup_snapshot = topup_ref.get()
    if not topup_snapshot.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Recarga não encontrada.",
        )

    attempt_query = (
        topup_ref.collection("payment_attempts")
        .where(
            filter=FieldFilter("mercado_pago_order_id", "==", order_id)
        )
        .limit(2)
    )
    attempts = list(attempt_query.stream())
    if len(attempts) != 1:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Tentativa de pagamento não encontrada.",
        )

    internal_status = _normalized_status(order)
    if internal_status is None:
        return {"received": True, "ignored": True}

    applied_status = reconcile_order_transaction(
        db.transaction(),
        topup_ref,
        attempts[0].reference,
        order,
        order_id,
        internal_status,
    )
    if applied_status == "approved":
        topup = topup_snapshot.to_dict()
        uid = topup.get("uid")
        if not isinstance(uid, str) or not uid:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Usuário da recarga inválido.",
            )
        grant_topup_credits_once(
            db.transaction(),
            topup_ref,
            db.collection("users").document(uid),
            db.collection("credit_transactions").document(topup_id),
            uid,
            order_id,
            attempts[0].reference.id,
        )
    return {
        "received": True,
        "status": applied_status,
    }
