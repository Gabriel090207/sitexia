from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from firebase_admin import auth

from datetime import datetime
from decimal import Decimal
from dateutil.relativedelta import relativedelta

from app.config.mp import subscription_sdk
from app.config.plans import PLANS

from firebase_admin import firestore

from app.services.firebase import db

router = APIRouter(
    prefix="/subscription",
    tags=["Subscription"]
)

class SubscriptionPayment(BaseModel):

    user_id: str

    token: str

    email: str

    cpf: str

    card_holder: str

    plan_id: str

class LinkSubscriptionRequest(BaseModel):

    firebase_uid: str

    email: str

    subscription_id: str


class CancelSubscriptionRequest(BaseModel):

    subscription_id: str


def sync_subscription_data(
    subscription_id: str,
    subscription: dict,
    extra_data: dict | None = None
):

    data = {

        "mercado_pago_id": subscription_id,

        "status": subscription.get("status"),

        "payer_id": subscription.get("payer_id"),

        "payment_method_id":
            subscription.get("payment_method_id"),

        "date_created":
            subscription.get("date_created"),

        "last_modified":
            subscription.get("last_modified"),

        "next_payment_date":
            subscription.get("next_payment_date"),

    }

    if extra_data:

        data.update(extra_data)

    db.collection("subscriptions").document(
        subscription_id
    ).set(
        data,
        merge=True
    )


def sync_user_subscription(
    firebase_uid: str,
    subscription_id: str,
    subscription: dict
):

    user_ref = (
        db.collection("users")
        .document(firebase_uid)
    )

    if subscription.get("status") == "cancelled":

        user_ref.update({
            "plan": "free",
            "subscription_status": "cancelled",
            "active_subscription": None,
            "subscription_plan_id": None,
            "subscription_amount": None,
            "subscription_next_payment": None,
            "subscription_payment_method": None,
            "subscription_created_at": None,
            "subscription_last_modified": None,
            "subscription_payer_id": None
        })

        return

    user_ref.set({

        "plan":
            subscription.get("plan_name"),

        "subscription_status":
            subscription.get("status"),

        "active_subscription":
            subscription_id,

        "subscription_plan_id":
            subscription.get("plan_id"),

        "subscription_amount":
            subscription.get("amount"),

        "subscription_next_payment":
            subscription.get("next_payment_date"),

        "subscription_payment_method":
            subscription.get("payment_method_id"),

        "subscription_created_at":
            subscription.get("date_created"),

        "subscription_last_modified":
            subscription.get("last_modified"),

        "subscription_payer_id":
            subscription.get("payer_id"),

    }, merge=True)

def calculate_next_payment_date():

    now = datetime.now()

    next_payment = now + relativedelta(months=1)

    return next_payment.isoformat()


def get_subscription(subscription_id: str):

    response = subscription_sdk.preapproval().get(
        subscription_id
    )

    return response["response"]


def get_payment(payment_id: str):

    response = subscription_sdk.payment().get(
        payment_id
    )

    return response["response"]

def search_subscriptions_by_payer(
    payer_id: str
):

    response = (
        subscription_sdk
        .preapproval()
        .search({
            "payer_id": payer_id
        })
    )

    return (
        response
        .get("response", {})
        .get("results", [])
    )
    
@router.get("/ping")
def ping():

    return {
        "success": True,
        "message": "Subscription API online."
    }


@router.post("/create-subscription")
def create_subscription(data: SubscriptionPayment):

    try:

        plan = PLANS.get(data.plan_id)

        if not plan:
            raise HTTPException(
                status_code=400,
                detail="Plano inválido."
            )

        plan_name = plan["name"]
        plan_price = plan["price"]
        plan_credits = plan["credits"]

        user_ref = (
            db.collection("users")
            .document(data.user_id)
        )

        user_snapshot = user_ref.get()

        if not user_snapshot.exists:
            raise HTTPException(
                status_code=404,
                detail="Usuário não encontrado."
            )

        user_data = user_snapshot.to_dict()

        current_subscription_id = (
            user_data.get("active_subscription")
        )

        current_credits = int(
            user_data.get("credits") or 0
        )

        if current_subscription_id:
            current_subscription_ref = (
                db.collection("subscriptions")
                .document(current_subscription_id)
            )

            current_subscription_snapshot = (
                current_subscription_ref.get()
            )

            if current_subscription_snapshot.exists:

                current_subscription = (
                    current_subscription_snapshot.to_dict()
                )

            else:
                current_subscription = None

        else:
            current_subscription = None

        if current_subscription:

            current_status = (
                current_subscription.get("status")
            )

            if current_status not in [
                "authorized",
                "pending"
            ]:

                current_subscription = None

        previous_subscription_id = None

        if current_subscription:
            previous_subscription_id = (
                current_subscription_id
            )

        subscription_data = {

            "reason": "Assinatura Xia",

            "payer_email": data.email,

            "card_token_id": data.token,

            "external_reference": data.user_id,

            "back_url": "https://xiaswap.netlify.app",

            "auto_recurring": {

                "frequency": 1,
                "frequency_type": "months",
                "transaction_amount": float(plan_price),
                "currency_id": "BRL"

            },

            "status": "authorized"

        }

        mp_response = subscription_sdk.preapproval().create(
            subscription_data
        )

        subscription = mp_response.get("response")

        if not subscription or not subscription.get("id"):

            raise HTTPException(
                status_code=502,
                detail="Mercado Pago não retornou uma nova assinatura válida."
            )

        subscription_id = subscription["id"]

        if previous_subscription_id == subscription_id:

            raise HTTPException(
                status_code=409,
                detail="A nova assinatura não pode ser igual à assinatura anterior."
            )

        next_payment_date = (
            subscription.get("next_payment_date")
            or calculate_next_payment_date()
        )

        if previous_subscription_id:

            previous_response = (
                subscription_sdk.preapproval().update(
                    previous_subscription_id,
                    {
                        "status": "cancelled"
                    }
                )
            )

            if not previous_response.get("response"):

                raise HTTPException(
                    status_code=502,
                    detail="Mercado Pago não confirmou o cancelamento da assinatura anterior."
                )

            previous_subscription = (
                previous_response["response"]
            )

            sync_subscription_data(
                previous_subscription_id,
                previous_subscription
            )

        db.collection("subscriptions").document(
            subscription_id
        ).set({

            "mercado_pago_id": subscription_id,

            "email": data.email,

            "plan_id": data.plan_id,

            "plan_name": plan_name,

            "credits": plan_credits,

            "amount": plan_price,

            "status": subscription.get("status"),

            "payer_id": subscription.get("payer_id"),

            "payment_method_id": subscription.get("payment_method_id"),

            "date_created": subscription.get("date_created"),

            "last_modified": subscription.get("last_modified"),

            "next_payment_date": next_payment_date,

            "last_credit_date": None,

            "last_charged_quantity": 0,

            "created_at": firestore.SERVER_TIMESTAMP

        })

        custom_token = None

        try:

            firebase_user = auth.get_user_by_email(data.email)

            user_exists = True

            firebase_uid = firebase_user.uid

            custom_token = auth.create_custom_token(
                firebase_uid
            ).decode()


        except auth.UserNotFoundError:

            user_exists = False

            firebase_uid = None


        if user_exists:

            user_ref = db.collection(
                "users"
            ).document(firebase_uid)


            db.collection("subscriptions").document(
                subscription_id
            ).update({

                "firebase_uid": firebase_uid,

                "linked": True

            })


            user_ref.update({

                "plan": plan_name,

                "credits": current_credits + plan_credits,

                "subscription_status":
                    subscription.get("status"),

                "active_subscription":
                    subscription_id,

                "subscription_plan_id":
                    data.plan_id,

                "subscription_amount": plan_price,

                "subscription_next_payment":
                    next_payment_date,

                "subscription_payment_method":
                    subscription.get("payment_method_id"),

                "subscription_created_at":
                    subscription.get("date_created"),

                "subscription_last_modified":
                    subscription.get("last_modified"),

                "subscription_payer_id":
                    subscription.get("payer_id")

            })


            user_ref.collection(
                "subscriptions"
            ).document(subscription_id).set({

                "mercado_pago_id":
                    subscription_id,

                "plan_id":
                    data.plan_id,

                "plan_name": plan_name,
                "credits": plan_credits,
                "amount": plan_price,

                "status":
                    subscription.get("status"),

                "email":
                    data.email,

                "created_at":
                    firestore.SERVER_TIMESTAMP

            })

        return {

            "success": True,

            "subscription": mp_response,

            "subscription_id": subscription_id,

            "user_exists": user_exists,

            "firebase_uid": firebase_uid,

            "custom_token": custom_token,

            "email": data.email

        }

    except HTTPException:
        raise

    except Exception as e:

        raise HTTPException(
            status_code=500,
            detail="Não foi possível vincular a assinatura."
        )


@router.post("/link-user")
def link_user_subscription(
    data: LinkSubscriptionRequest
):

    try:

        subscription_ref = (
            db.collection("subscriptions")
            .document(data.subscription_id)
        )

        subscription_snapshot = subscription_ref.get()


        if not subscription_snapshot.exists:

            if not subscription_snapshot.exists:

                raise HTTPException(
                    status_code=404,
                    detail="Assinatura não encontrada."
                )


        subscription = subscription_snapshot.to_dict()


        user_ref = (
            db.collection("users")
            .document(data.firebase_uid)
        )


        user_ref.update({

            "plan":
                subscription["plan_name"],

            "credits":
                subscription["credits"],

            "active_subscription":
                data.subscription_id,

            "subscription_status":
                subscription["status"],

            "subscription_plan_id":
                subscription["plan_id"],

            "subscription_amount":
                subscription["amount"],

            "subscription_next_payment":
                subscription.get("next_payment_date"),

            "subscription_payment_method":
                subscription.get("payment_method_id"),

            "subscription_created_at":
                subscription.get("date_created"),

            "subscription_last_modified":
                subscription.get("last_modified"),

            "subscription_payer_id":
                subscription.get("payer_id")

        })


        user_ref.collection(
            "subscriptions"
        ).document(
            data.subscription_id
        ).set(subscription)


        subscription_ref.update({

            "firebase_uid":
                data.firebase_uid,

            "linked":
                True

        })


        return {

            "success": True

        }


    except Exception as e:

        return {

            "success": False,

            "error": str(e)

        }

@router.post("/webhook")
async def mercado_pago_webhook(payload: dict):

    try:

        event_type = payload.get("type")

        if event_type == "payment":

            payment_id = (
                payload.get("data", {})
                .get("id")
            )

            if not payment_id:

                return {
                    "success": True,
                    "ignored": True
                }

            payment = get_payment(
                str(payment_id)
            )

            if payment.get("status") != "approved":

                return {
                    "success": True,
                    "ignored": True
                }

            if payment.get("operation_type") != "recurring_payment":

                return {
                    "success": True,
                    "ignored": True
                }

            payer = payment.get("payer") or {}

            payer_id = payer.get("id")

            if not payer_id:

                return {
                    "success": True,
                    "ignored": True
                }

            payer_subscriptions = (
                search_subscriptions_by_payer(
                    str(payer_id)
                )
            )

            if not payer_subscriptions:

                return {
                    "success": True,
                    "ignored": True
                }

            xia_subscriptions = []

            for payer_subscription in payer_subscriptions:

                subscription_id = payer_subscription.get("id")

                if not subscription_id:
                    continue

                subscription_doc = (
                    db.collection("subscriptions")
                    .document(subscription_id)
                    .get()
                )

                if not subscription_doc.exists:
                    continue

                xia_subscriptions.append({
                    "id": subscription_id,
                    "mercado_pago": payer_subscription,
                    "firestore": subscription_doc.to_dict()
                })

            if not xia_subscriptions:

                return {
                    "success": True,
                    "ignored": True
                }

            renewed_subscriptions = []

            for item in xia_subscriptions:

                mercado_pago_subscription = (
                    item["mercado_pago"]
                )

                firestore_subscription = (
                    item["firestore"]
                )

                summarized = (
                    mercado_pago_subscription.get("summarized")
                    or {}
                )

                charged_quantity = (
                    summarized.get("charged_quantity")
                    or 0
                )

                last_charged_quantity = (
                    firestore_subscription.get(
                        "last_charged_quantity"
                    )
                    or 0
                )

                if charged_quantity <= last_charged_quantity:
                    continue

                renewed_subscriptions.append({
                    **item,
                    "charged_quantity": charged_quantity
                })

            if not renewed_subscriptions:

                return {
                    "success": True,
                    "ignored": True
                } 

            if len(renewed_subscriptions) != 1:

                raise HTTPException(
                    status_code=409,
                    detail="Não foi possível identificar uma única assinatura renovada."
                )  

            renewed_subscription = renewed_subscriptions[0]

            subscription_id = renewed_subscription["id"]

            subscription_data = renewed_subscription["firestore"]

            last_payment_id = subscription_data.get(
                "last_payment_id"
            )

            if last_payment_id == str(payment_id):

                return {
                    "success": True,
                    "ignored": True
                }

            mercado_pago_subscription = (
                renewed_subscription["mercado_pago"]
            )

            charged_quantity = (
                renewed_subscription["charged_quantity"]
            )

            subscription_status = (
                mercado_pago_subscription.get("status")
            )

            if subscription_status != "authorized":

                return {
                    "success": True,
                    "ignored": True
                }

            mercado_pago_amount = (
                mercado_pago_subscription
                .get("auto_recurring", {})
                .get("transaction_amount")
            )

            xia_amount = subscription_data.get("amount")

            if mercado_pago_amount is None or xia_amount is None:

                raise HTTPException(
                    status_code=409,
                    detail="Valor da assinatura não identificado."
                )

            if (
                Decimal(str(mercado_pago_amount))
                != Decimal(str(xia_amount))
            ):

                raise HTTPException(
                    status_code=409,
                    detail="Valor da cobrança não corresponde à assinatura."
                )

            firebase_uid = subscription_data.get(
                "firebase_uid"
            )

            if not firebase_uid:

                raise HTTPException(
                    status_code=409,
                    detail="Usuário da assinatura não identificado."
                )

            user_ref = (
                db.collection("users")
                .document(firebase_uid)
            )

            user_snapshot = user_ref.get()

            if not user_snapshot.exists:

                raise HTTPException(
                    status_code=404,
                    detail="Usuário da assinatura não encontrado."
                )

            user_data = user_snapshot.to_dict()

            credits_to_add = int(
                subscription_data.get("credits") or 0
            )

            if credits_to_add <= 0:

                raise HTTPException(
                    status_code=409,
                    detail="Quantidade de créditos da assinatura inválida."
                )

            transaction = db.transaction()

            transaction_user_snapshot = (
                transaction.get(user_ref)
            )

            if not transaction_user_snapshot.exists:

                raise HTTPException(
                    status_code=404,
                    detail="Usuário da assinatura não encontrado."
                )

            transaction_user_data = (
                transaction_user_snapshot.to_dict()
            )

            transaction_current_credits = int(
                transaction_user_data.get("credits") or 0
            )

            transaction_new_credits = (
                transaction_current_credits
                + credits_to_add
            )

            transaction.update(
                user_ref,
                {
                    "credits": transaction_new_credits,
                    "subscription_status": "authorized",
                    "active_subscription": subscription_id,
                    "subscription_next_payment":
                        mercado_pago_subscription.get(
                            "next_payment_date"
                        ),
                    "subscription_last_modified":
                        mercado_pago_subscription.get(
                            "last_modified"
                        )
                }
            )

            subscription_ref = (
                db.collection("subscriptions")
                .document(subscription_id)
            )

            transaction.update(
                subscription_ref,
                {
                    "last_credit_date":
                        datetime.now().isoformat(),

                    "last_charged_quantity":
                        charged_quantity,

                    "last_payment_id":
                        str(payment_id),

                    "next_payment_date":
                        mercado_pago_subscription.get(
                            "next_payment_date"
                        ),

                    "last_modified":
                        mercado_pago_subscription.get(
                            "last_modified"
                        )
                }
            )

            transaction.commit()

            return {
                "success": True,
                "payment_received": True,
                "credits_added": credits_to_add,
                "subscription_id": subscription_id
            }


        if event_type != "subscription_preapproval":

            return {
                "success": True,
                "ignored": True,
                "event_type": event_type
            }

        subscription_id = (
            payload.get("data", {})
            .get("id")
        )

        if not subscription_id:

            return {
                "success": True
            }

        subscription = get_subscription(
            subscription_id
        )

        sync_subscription_data(
            subscription_id,
            subscription
        )

        subscription_doc = (
            db.collection("subscriptions")
            .document(subscription_id)
            .get()
        )

        if subscription_doc.exists:

            subscription_data = subscription_doc.to_dict()

            firebase_uid = subscription_data.get(
                "firebase_uid"
            )

            if firebase_uid:

                sync_user_subscription(
                    firebase_uid,
                    subscription_id,
                    subscription_data
                )

        return {
            "success": True
        }

    except Exception:

        raise HTTPException(
            status_code=500,
            detail="Não foi possível processar o webhook."
        )


@router.post("/cancel")
def cancel_subscription(
    data: CancelSubscriptionRequest
):

    try:

        response = subscription_sdk.preapproval().update(

            data.subscription_id,

            {
                "status": "cancelled"
            }

        )

        subscription = response["response"]

        sync_subscription_data(

            data.subscription_id,

            subscription

        )


        subscription_doc = (

            db.collection("subscriptions")

            .document(data.subscription_id)

            .get()

        )

        if subscription_doc.exists:

            subscription_data = subscription_doc.to_dict()

            firebase_uid = subscription_data.get(
                "firebase_uid"
            )


            if firebase_uid:

                db.collection("users").document(
                    firebase_uid
                ).update({

                    "plan": "free",

                    "subscription_status": "cancelled",

                    "active_subscription": None,

                    "subscription_plan_id": None,

                    "subscription_amount": None,

                    "subscription_next_payment": None,

                    "subscription_payment_method": None,

                    "subscription_created_at": None,

                    "subscription_last_modified": None,

                    "subscription_payer_id": None

                })

        return {

            "success": True,

            "mercado_pago": response

        }

    except Exception:

        raise HTTPException(
            status_code=500,
            detail="Não foi possível cancelar a assinatura."
        )