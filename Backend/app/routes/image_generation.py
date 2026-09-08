import asyncio
import json
import logging
from typing import Annotated
from uuid import uuid4

import httpx
from google.api_core.exceptions import Aborted, DeadlineExceeded, ServiceUnavailable

from fastapi import APIRouter, Depends, HTTPException

from pydantic import BaseModel, ConfigDict

from app.dependencies.auth import AuthenticatedUser, get_current_user

from app.services.generation_credits import (
    reserve_generation_credits,
    attach_generation_task,
    charge_reserved_generation,
    release_reserved_generation,
    get_generation_by_task_for_user,
)

from app.services.deepswap import (
    create_text_to_image_task,
    get_task,
)


logger = logging.getLogger(__name__)

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
    model_config = ConfigDict(extra="forbid")

    prompt: str
    style: str
    quantity: int


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
# RESERVE CREDITS
# ===========================

async def create_reserved_image(user_id, quantity, prompt, model, size):
    cost = calculate_image_generation_cost(quantity)
    # Sem chave do cliente: um retry HTTP completo é uma nova operação.
    try:
        generation = reserve_generation_credits(
            user_id, str(uuid4()), cost, "image-generation", "text-to-image"
        )
    except ValueError as error:
        message = str(error)
        status = 404 if message == "Usuário não encontrado." else (
            402 if message == "Créditos insuficientes." else 400
        )
        raise HTTPException(status_code=status, detail=message) from error

    generation_id = generation["generationId"]
    try:
        task = await create_text_to_image_task(prompt, model, size, quantity)
    except httpx.HTTPStatusError as error:
        # 408 e 5xx não comprovam que o provedor deixou de criar a tarefa.
        if 400 <= error.response.status_code < 500 and error.response.status_code != 408:
            release_reserved_generation(generation_id)
        else:
            logger.exception("Criação ambígua; reserva mantida: generationId=%s", generation_id)
        raise
    except (httpx.RequestError, json.JSONDecodeError, asyncio.CancelledError):
        logger.exception("Criação ambígua; reserva mantida: generationId=%s", generation_id)
        raise
    except (ValueError, HTTPException):
        # Validações locais definitivas dos helpers.
        release_reserved_generation(generation_id)
        raise
    except Exception:
        # Não há evidência suficiente para liberar em falhas inesperadas.
        logger.exception("Criação não confirmada; reserva mantida: generationId=%s", generation_id)
        raise

    task_id = task.get("taskId") if isinstance(task, dict) else None
    if (
        isinstance(task_id, bool)
        or not isinstance(task_id, (str, int))
        or not str(task_id).strip()
        or "/" in str(task_id)
    ):
        release_reserved_generation(generation_id)
        raise HTTPException(status_code=502, detail="A API não retornou uma tarefa de geração válida.")

    try:
        try:
            attach_generation_task(generation_id, str(task_id))
        except (Aborted, DeadlineExceeded, ServiceUnavailable):
            logger.warning(
                "Repetindo vínculo após falha transitória: generationId=%s taskId=%s",
                generation_id, task_id,
            )
            attach_generation_task(generation_id, str(task_id))
    except Exception:
        # A task já existe: falhar ao persistir o vínculo não autoriza liberação.
        logger.exception(
            "Falha ao vincular task; reserva mantida: generationId=%s taskId=%s",
            generation_id, task_id,
        )
        raise
    return task


# ===========================
# CREATE IMAGE
# ===========================

@router.post("/text-to-image")
async def create_text_to_image(
    request: TextToImageRequest,
    current_user: Annotated[
        AuthenticatedUser,
        Depends(get_current_user),
    ],
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


    return await create_reserved_image(
        current_user.uid,
        request.quantity,
        prompt,
        model,
        size,
    )


# ===========================
# GET TASK
# ===========================

@router.get("/task/{task_id}")
async def get_image_generation_task(
    task_id: str,
    current_user: Annotated[AuthenticatedUser, Depends(get_current_user)],
):
    try:
        generation = get_generation_by_task_for_user(task_id, current_user.uid)
    except ValueError as error:
        raise HTTPException(status_code=404, detail="Geração não encontrada.") from error

    # A biblioteca antiga de imagens não persiste taskId: não há prova de dono.
    # Nunca criar reserva retroativa nem consultar tasks sem vínculo seguro.
    if generation is None or generation.get("type") != "image-generation":
        raise HTTPException(status_code=404, detail="Geração não encontrada.")

    task = await get_task(task_id)
    status = task.get("taskStatus") if isinstance(task, dict) else None
    if status == "SUCCEEDED":
        charge_reserved_generation(generation["generationId"])
    elif status == "FAILED":
        release_reserved_generation(generation["generationId"])
    elif status not in ("PENDING", "RUNNING"):
        logger.warning(
            "Estado de task desconhecido; reserva mantida: generationId=%s",
            generation["generationId"],
        )
    return task
