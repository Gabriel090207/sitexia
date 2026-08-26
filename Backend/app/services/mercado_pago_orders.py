from typing import Any

import requests
from mercadopago.config import RequestOptions

from app.config.mp import mp_sdk


class MercadoPagoOrdersError(Exception):
    """Base error for failures while communicating with Orders API."""


class MercadoPagoOrdersConfigurationError(MercadoPagoOrdersError):
    """The Mercado Pago credentials or integration are not authorized."""


class MercadoPagoOrdersAPIError(MercadoPagoOrdersError):
    """Mercado Pago rejected the request or returned an invalid response."""

    def __init__(self, message: str, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code


class MercadoPagoOrderNotFoundError(MercadoPagoOrdersAPIError):
    """The requested Order does not exist or is not accessible."""


class MercadoPagoOrdersNetworkError(MercadoPagoOrdersError):
    """The outcome is unknown because communication with Mercado Pago failed."""


def _response_body(
    result: dict[str, Any],
    expected_statuses: set[int],
) -> dict[str, Any]:
    if not isinstance(result, dict):
        raise MercadoPagoOrdersAPIError(
            "Mercado Pago returned an invalid response."
        )

    status_code = result.get("status")
    response = result.get("response")

    if status_code in expected_statuses and isinstance(response, dict):
        return response

    if status_code in {401, 403}:
        raise MercadoPagoOrdersConfigurationError(
            "Mercado Pago authentication failed."
        )

    if status_code == 404:
        raise MercadoPagoOrderNotFoundError(
            "Mercado Pago Order was not found.",
            status_code=status_code,
        )

    if isinstance(status_code, int) and (
        status_code == 429 or status_code >= 500
    ):
        raise MercadoPagoOrdersNetworkError(
            "Mercado Pago request could not be completed."
        )

    raise MercadoPagoOrdersAPIError(
        "Mercado Pago rejected the Order request.",
        status_code=(
            status_code if isinstance(status_code, int) else None
        ),
    )


def create_order(
    payload: dict[str, Any],
    idempotency_key: str,
) -> dict[str, Any]:
    if not isinstance(payload, dict) or not payload:
        raise MercadoPagoOrdersAPIError(
            "Order payload must be a non-empty dictionary."
        )

    if not isinstance(idempotency_key, str) or not idempotency_key:
        raise MercadoPagoOrdersAPIError(
            "Order idempotency key must be a non-empty string."
        )

    request_options = RequestOptions()
    request_options.custom_headers = {
        "X-Idempotency-Key": idempotency_key,
    }

    try:
        result = mp_sdk.order().create(
            payload,
            request_options,
        )
    except requests.RequestException:
        raise MercadoPagoOrdersNetworkError(
            "Mercado Pago request could not be completed."
        ) from None
    except MercadoPagoOrdersError:
        raise
    except Exception:
        raise MercadoPagoOrdersNetworkError(
            "Mercado Pago request could not be completed."
        ) from None

    return _response_body(result, expected_statuses={200, 201})


def get_order(order_id: str) -> dict[str, Any]:
    if not isinstance(order_id, str) or not order_id:
        raise MercadoPagoOrdersAPIError(
            "Order ID must be a non-empty string."
        )

    try:
        result = mp_sdk.order().get(order_id)
    except requests.RequestException:
        raise MercadoPagoOrdersNetworkError(
            "Mercado Pago request could not be completed."
        ) from None
    except MercadoPagoOrdersError:
        raise
    except Exception:
        raise MercadoPagoOrdersNetworkError(
            "Mercado Pago request could not be completed."
        ) from None

    return _response_body(result, expected_statuses={200})
