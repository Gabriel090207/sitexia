from fastapi import APIRouter
from pydantic import BaseModel
from app.config.mp import subscription_sdk

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


@router.get("/ping")
def ping():

    return {
        "success": True,
        "message": "Subscription API online."
    }


@router.post("/create-subscription")
def create_subscription(
    data: SubscriptionPayment
):

    try:

        subscription_data = {

            "reason":
                "Assinatura Xia",

            "payer_email":
                data.email,

            "card_token_id":
                data.token,

            "back_url":
                "http://localhost:5173",

            "auto_recurring": {

                "frequency": 1,

                "frequency_type":
                    "months",

                "transaction_amount":
                    float(data.amount),

                "currency_id":
                    "BRL"
            },

            "status":
                "authorized"
        }

        response = subscription_sdk.preapproval().create(
            subscription_data
        )

        return response

    except Exception as e:

        return {

            "success": False,

            "error": str(e)
        }