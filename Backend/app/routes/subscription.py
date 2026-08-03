from fastapi import APIRouter
from pydantic import BaseModel
from firebase_admin import auth

from app.config.mp import subscription_sdk

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

    amount: float

    card_holder: str

    plan_id: str

    plan_name: str

    credits: int

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

    user_ref.set({

        "plan":
            subscription.get("plan_name"),

        "credits":
            subscription.get("credits"),

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


def get_subscription(subscription_id: str):

    response = subscription_sdk.preapproval().get(
        subscription_id
    )

    return response["response"]

@router.get("/ping")
def ping():

    return {
        "success": True,
        "message": "Subscription API online."
    }


@router.post("/create-subscription")
def create_subscription(data: SubscriptionPayment):

    try:

        subscription_data = {

            "reason": "Assinatura Xia",

            "payer_email": data.email,

            "card_token_id": data.token,

            "back_url": "https://xiaswap.netlify.app",

            "auto_recurring": {

                "frequency": 1,
                "frequency_type": "months",
                "transaction_amount": float(data.amount),
                "currency_id": "BRL"

            },

            "status": "authorized"

        }

        mp_response = subscription_sdk.preapproval().create(
            subscription_data
        )

        subscription = mp_response["response"]

        subscription_id = subscription["id"]

        db.collection("subscriptions").document(
            subscription_id
        ).set({

            "mercado_pago_id": subscription_id,

            "email": data.email,

            "plan_id": data.plan_id,

            "plan_name": data.plan_name,

            "credits": data.credits,

            "amount": data.amount,

            "status": subscription.get("status"),

            "payer_id": subscription.get("payer_id"),

            "payment_method_id": subscription.get("payment_method_id"),

            "date_created": subscription.get("date_created"),

            "last_modified": subscription.get("last_modified"),

            "next_payment_date": subscription.get("next_payment_date"),

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


            user_ref.update({

                "plan": data.plan_name,

                "credits": data.credits,

                "subscription_status":
                    subscription.get("status"),

                "active_subscription":
                    subscription_id,

                "subscription_plan_id":
                    data.plan_id,

                "subscription_amount":
                    data.amount,

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
            ).document(subscription_id).set({

                "mercado_pago_id":
                    subscription_id,

                "plan_id":
                    data.plan_id,

                "plan_name":
                    data.plan_name,

                "credits":
                    data.credits,

                "amount":
                    data.amount,

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

    except Exception as e:

        return {

            "success": False,

            "error": str(e)

        }




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

            return {

                "success": False,

                "error": "Assinatura não encontrada."

            }


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

        print("========== WEBHOOK RECEBIDO ==========")
        print(payload)
        print("======================================")

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

    except Exception as e:

        print(e)

        return {
            "success": False,
            "error": str(e)
        }


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

                    "credits": 0,

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

    except Exception as e:

        return {

            "success": False,

            "error": str(e)

        }