from decimal import Decimal, InvalidOperation
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, status
from firebase_admin import firestore
from pydantic import BaseModel, ConfigDict

from app.config.packages import PACKAGES
from app.dependencies.auth import AuthenticatedUser, get_current_user
from app.services.firebase import db
from app.services.mercado_pago_orders import (
    MercadoPagoOrdersAPIError,
    MercadoPagoOrdersConfigurationError,
    MercadoPagoOrdersNetworkError,
    create_order,
)


router = APIRouter(
    prefix="/topups",
    tags=["Topups"],
)


class CreateTopupRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    package_id: str


class CreatePaymentAttemptRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    payment_method: Literal["pix", "card"]


def _not_found() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail="Recarga ou tentativa de pagamento não encontrada.",
    )


def _pix_response(
    topup_id: str,
    payment_attempt_id: str,
    attempt: dict[str, Any],
) -> dict[str, Any]:
    return {
        "topup_id": topup_id,
        "payment_attempt_id": payment_attempt_id,
        "order_id": attempt.get("mercado_pago_order_id"),
        "status": attempt.get("status"),
        "status_detail": attempt.get("status_detail"),
        "qr_code": attempt.get("qr_code"),
        "qr_code_base64": attempt.get("qr_code_base64"),
        "ticket_url": attempt.get("ticket_url"),
        "expires_at": attempt.get("expires_at"),
    }


def _money_amount(value: Any) -> str:
    try:
        amount = Decimal(str(value)).quantize(Decimal("0.01"))
    except (InvalidOperation, TypeError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A recarga possui um valor inválido.",
        ) from None

    if not amount.is_finite() or amount <= 0:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A recarga possui um valor inválido.",
        )

    return format(amount, ".2f")


def _pix_order_payload(
    topup_id: str,
    amount: str,
    payer_email: str,
) -> dict[str, Any]:
    return {
        "type": "online",
        "processing_mode": "automatic",
        "external_reference": topup_id,
        "total_amount": amount,
        "payer": {"email": payer_email},
        "transactions": {
            "payments": [
                {
                    "amount": amount,
                    "payment_method": {
                        "id": "pix",
                        "type": "bank_transfer",
                    },
                    "expiration_time": "PT24H",
                }
            ]
        },
    }


def _order_fields(order: dict[str, Any]) -> dict[str, Any]:
    transactions = order.get("transactions")
    if not isinstance(transactions, dict):
        transactions = {}
    payments = transactions.get("payments", [])
    if not isinstance(payments, list):
        payments = []
    payment = payments[0] if payments and isinstance(payments[0], dict) else {}
    payment_method = payment.get("payment_method", {})
    if not isinstance(payment_method, dict):
        payment_method = {}

    order_id = order.get("id")
    if order_id is None or str(order_id).strip() == "":
        raise MercadoPagoOrdersAPIError(
            "Mercado Pago returned an Order without an ID."
        )

    return {
        "mercado_pago_order_id": str(order_id),
        "mercado_pago_payment_id": payment.get("id"),
        "status": order.get("status") or "payment_pending",
        "status_detail": (
            order.get("status_detail") or "order_created"
        ),
        "ticket_url": (
            payment.get("ticket_url") or payment_method.get("ticket_url")
        ),
        "qr_code": (
            payment.get("qr_code") or payment_method.get("qr_code")
        ),
        "qr_code_base64": (
            payment.get("qr_code_base64")
            or payment_method.get("qr_code_base64")
        ),
        "expires_at": (
            payment.get("expiration_time")
            or payment.get("expiration_date")
            or payment.get("date_of_expiration")
            or payment_method.get("expiration_time")
            or payment_method.get("expiration_date")
            or order.get("expiration_time")
            or order.get("expiration_date")
            or order.get("date_of_expiration")
        ),
    }


@firestore.transactional
def claim_pix_order_creation(
    transaction,
    topup_ref,
    payment_attempt_ref,
    uid: str,
):
    topup_snapshot = transaction.get(topup_ref)
    attempt_snapshot = transaction.get(payment_attempt_ref)

    if not topup_snapshot.exists or not attempt_snapshot.exists:
        raise _not_found()

    topup = topup_snapshot.to_dict()
    attempt = attempt_snapshot.to_dict()

    if (
        topup.get("uid") != uid
        or attempt.get("uid") != uid
        or attempt.get("topup_id") != topup_ref.id
    ):
        raise _not_found()

    if attempt.get("payment_method") != "pix":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Esta tentativa não é compatível com pagamento Pix.",
        )

    if attempt.get("mercado_pago_order_id"):
        return {"existing_attempt": attempt}

    if (
        attempt.get("status") != "created"
        or attempt.get("status_detail") != "awaiting_order_creation"
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A tentativa não está disponível para criar uma Order.",
        )

    amount = _money_amount(topup.get("amount"))
    transaction.update(
        payment_attempt_ref,
        {
            "status": "processing",
            "status_detail": "creating_order",
            "updated_at": firestore.SERVER_TIMESTAMP,
        },
    )
    transaction.update(
        topup_ref,
        {
            "status": "payment_pending",
            "status_detail": "order_creation_in_progress",
            "updated_at": firestore.SERVER_TIMESTAMP,
        },
    )
    return {"amount": amount}


@firestore.transactional
def persist_pix_order(
    transaction,
    topup_ref,
    payment_attempt_ref,
    order_fields: dict[str, Any],
):
    attempt_snapshot = transaction.get(payment_attempt_ref)
    if not attempt_snapshot.exists:
        raise _not_found()

    attempt = attempt_snapshot.to_dict()
    if attempt.get("mercado_pago_order_id"):
        return attempt

    persisted_attempt = {
        **order_fields,
        "updated_at": firestore.SERVER_TIMESTAMP,
    }
    transaction.update(payment_attempt_ref, persisted_attempt)
    transaction.update(
        topup_ref,
        {
            "status": "payment_pending",
            "status_detail": "mercado_pago_order_created",
            "updated_at": firestore.SERVER_TIMESTAMP,
        },
    )
    return {**attempt, **order_fields}


@firestore.transactional
def release_pix_order_creation(
    transaction,
    topup_ref,
    payment_attempt_ref,
    failure_type: str,
):
    attempt_snapshot = transaction.get(payment_attempt_ref)
    if not attempt_snapshot.exists:
        return

    attempt = attempt_snapshot.to_dict()
    if attempt.get("mercado_pago_order_id"):
        return

    if (
        attempt.get("status") == "processing"
        and attempt.get("status_detail") == "creating_order"
    ):
        transaction.update(
            payment_attempt_ref,
            {
                "status": "created",
                "status_detail": "awaiting_order_creation",
                "last_order_error": failure_type,
                "updated_at": firestore.SERVER_TIMESTAMP,
            },
        )
        transaction.update(
            topup_ref,
            {
                "status": "payment_pending",
                "status_detail": "payment_attempt_created",
                "updated_at": firestore.SERVER_TIMESTAMP,
            },
        )


@firestore.transactional
def create_payment_attempt_transaction(
    transaction,
    topup_ref,
    payment_attempt_ref,
    uid: str,
    payment_method: str,
):
    topup_snapshot = transaction.get(topup_ref)

    if not topup_snapshot.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Recarga não encontrada.",
        )

    topup = topup_snapshot.to_dict()

    if topup.get("uid") != uid:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Recarga não encontrada.",
        )

    if topup.get("credits_granted") is True or topup.get("status") in {
        "approved",
        "completed",
    }:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A recarga já foi concluída.",
        )

    transaction.set(
        payment_attempt_ref,
        {
            "uid": uid,
            "topup_id": topup_ref.id,
            "payment_method": payment_method,
            "status": "created",
            "status_detail": "awaiting_order_creation",
            "mercado_pago_order_id": None,
            "mercado_pago_payment_id": None,
            "created_at": firestore.SERVER_TIMESTAMP,
            "updated_at": firestore.SERVER_TIMESTAMP,
        },
    )

    transaction.update(
        topup_ref,
        {
            "status": "payment_pending",
            "status_detail": "payment_attempt_created",
            "updated_at": firestore.SERVER_TIMESTAMP,
        },
    )


@router.post("", status_code=status.HTTP_201_CREATED)
def create_topup(
    data: CreateTopupRequest,
    current_user: Annotated[
        AuthenticatedUser,
        Depends(get_current_user),
    ],
):
    package = PACKAGES.get(data.package_id)

    if package is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Pacote inválido.",
        )

    topup_ref = db.collection("topups").document()

    topup_data = {
        "uid": current_user.uid,
        "package_id": data.package_id,
        "package_name": package["name"],
        "amount": package["price"],
        "currency": "BRL",
        "credits": package["credits"],
        "status": "created",
        "status_detail": "awaiting_payment_attempt",
        "credits_granted": False,
        "credits_granted_at": None,
        "created_at": firestore.SERVER_TIMESTAMP,
        "updated_at": firestore.SERVER_TIMESTAMP,
    }

    topup_ref.set(topup_data)

    return {
        "topup_id": topup_ref.id,
        "package": {
            "id": data.package_id,
            "name": package["name"],
        },
        "amount": package["price"],
        "currency": "BRL",
        "credits": package["credits"],
        "status": "created",
    }


@router.post(
    "/{topup_id}/payment-attempts",
    status_code=status.HTTP_201_CREATED,
)
def create_payment_attempt(
    topup_id: str,
    data: CreatePaymentAttemptRequest,
    current_user: Annotated[
        AuthenticatedUser,
        Depends(get_current_user),
    ],
):
    topup_ref = db.collection("topups").document(topup_id)
    payment_attempt_ref = (
        topup_ref.collection("payment_attempts").document()
    )
    transaction = db.transaction()

    create_payment_attempt_transaction(
        transaction,
        topup_ref,
        payment_attempt_ref,
        current_user.uid,
        data.payment_method,
    )

    return {
        "topup_id": topup_id,
        "payment_attempt_id": payment_attempt_ref.id,
        "payment_method": data.payment_method,
        "status": "created",
    }


@router.post(
    "/{topup_id}/payment-attempts/{payment_attempt_id}/order",
)
def create_pix_order(
    topup_id: str,
    payment_attempt_id: str,
    current_user: Annotated[
        AuthenticatedUser,
        Depends(get_current_user),
    ],
):
    payer_email = current_user.claims.get("email")
    if not isinstance(payer_email, str) or not payer_email.strip():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="O usuário autenticado não possui e-mail disponível.",
        )

    topup_ref = db.collection("topups").document(topup_id)
    payment_attempt_ref = topup_ref.collection(
        "payment_attempts"
    ).document(payment_attempt_id)

    claim = claim_pix_order_creation(
        db.transaction(),
        topup_ref,
        payment_attempt_ref,
        current_user.uid,
    )
    existing_attempt = claim.get("existing_attempt")
    if existing_attempt is not None:
        return _pix_response(
            topup_id,
            payment_attempt_id,
            existing_attempt,
        )

    payload = _pix_order_payload(
        topup_id,
        claim["amount"],
        payer_email.strip(),
    )

    try:
        order = create_order(payload, payment_attempt_id)
        order_fields = _order_fields(order)
    except MercadoPagoOrdersConfigurationError:
        release_pix_order_creation(
            db.transaction(),
            topup_ref,
            payment_attempt_ref,
            "configuration_error",
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="O serviço de pagamento está temporariamente indisponível.",
        ) from None
    except MercadoPagoOrdersNetworkError:
        release_pix_order_creation(
            db.transaction(),
            topup_ref,
            payment_attempt_ref,
            "network_error",
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Não foi possível confirmar a criação do pagamento.",
        ) from None
    except MercadoPagoOrdersAPIError:
        release_pix_order_creation(
            db.transaction(),
            topup_ref,
            payment_attempt_ref,
            "api_error",
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="O provedor de pagamento rejeitou a criação do Pix.",
        ) from None

    persisted_attempt = persist_pix_order(
        db.transaction(),
        topup_ref,
        payment_attempt_ref,
        order_fields,
    )
    return _pix_response(
        topup_id,
        payment_attempt_id,
        persisted_attempt,
    )
