from fastapi import APIRouter, HTTPException

from pydantic import BaseModel

from app.services.firebase import (
    db,
    deduct_credits,
)

from app.services.deepswap import (
    create_text_to_image_task,
    get_task,
)


router = APIRouter(
    prefix="/image-generation",
    tags=["Image Generation"],
)


# ===========================
# IMAGE CONFIG
# ===========================

STYLE_CONFIG = {

    "realistic": {
        "model": "neoreal-girl2.0",
        "size": "768:1152",
    },

    "anime": {
        "model": "anime-girl1.0",
        "size": "512:768",
    },

}


ALLOWED_QUANTITIES = {
    1,
    4,
    9,
}


COST_PER_IMAGE = 0.2


# ===========================
# REQUEST
# ===========================

class TextToImageRequest(BaseModel):
    prompt: str
    style: str
    quantity: int
    user_id: str


# ===========================
# COST
# ===========================

def calculate_image_generation_cost(
    quantity: int
) -> float:

    if quantity not in ALLOWED_QUANTITIES:

        raise HTTPException(
            status_code=400,
            detail="Quantidade de imagens inválida."
        )

    return quantity * COST_PER_IMAGE


# ===========================
# CHARGE CREDITS
# ===========================

def charge_image_generation_credits(
    user_id: str,
    quantity: int
) -> float:

    cost = calculate_image_generation_cost(
        quantity
    )

    user_ref = (
        db.collection("users")
        .document(user_id)
    )

    transaction = db.transaction()

    try:

        remaining_credits = deduct_credits(
            transaction,
            user_ref,
            cost
        )

    except ValueError as error:

        message = str(error)

        if message == "Usuário não encontrado.":

            raise HTTPException(
                status_code=404,
                detail=message
            )

        if message == "Créditos insuficientes.":

            raise HTTPException(
                status_code=402,
                detail=message
            )

        raise HTTPException(
            status_code=400,
            detail=message
        )

    print(
        f"Image Generation | "
        f"Usuário: {user_id} | "
        f"Quantidade: {quantity} | "
        f"Custo: {cost} | "
        f"Saldo restante: {remaining_credits}"
    )

    return remaining_credits


# ===========================
# CREATE IMAGE
# ===========================

@router.post("/text-to-image")
async def create_text_to_image(
    request: TextToImageRequest
):

    prompt = request.prompt.strip()

    if not prompt:

        raise HTTPException(
            status_code=400,
            detail="Prompt obrigatório."
        )


    # -----------------------
    # STYLE / MODEL / SIZE
    # -----------------------

    style_config = STYLE_CONFIG.get(
        request.style
    )

    if not style_config:

        raise HTTPException(
            status_code=400,
            detail="Estilo de imagem inválido."
        )

    model = style_config["model"]
    size = style_config["size"]


    # -----------------------
    # QUANTITY
    # -----------------------

    if request.quantity not in ALLOWED_QUANTITIES:

        raise HTTPException(
            status_code=400,
            detail="Quantidade de imagens inválida."
        )


    # -----------------------
    # CHARGE
    # -----------------------

    charge_image_generation_credits(
        request.user_id,
        request.quantity
    )


    # -----------------------
    # CREATE DEEPSWAP TASK
    # -----------------------

    return await create_text_to_image_task(
        prompt,
        model,
        size,
        request.quantity
    )


# ===========================
# GET TASK
# ===========================

@router.get("/task/{task_id}")
async def get_image_generation_task(
    task_id: str
):

    return await get_task(
        task_id
    )