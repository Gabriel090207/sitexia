import os

from dotenv import load_dotenv
import mercadopago

load_dotenv()

mp_sdk = mercadopago.SDK(
    os.getenv("MERCADO_PAGO_ACCESS_TOKEN")
)

subscription_sdk = mp_sdk
