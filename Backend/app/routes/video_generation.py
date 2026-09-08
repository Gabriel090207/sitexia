import asyncio
import json
import logging
from typing import Annotated
from uuid import uuid4

import httpx

from fastapi import APIRouter, Depends, HTTPException

from pydantic import BaseModel, ConfigDict

from google.cloud.firestore_v1.base_query import FieldFilter

from app.dependencies.auth import AuthenticatedUser, get_current_user

from app.services.firebase import db
from app.services.generation_credits import (
    reserve_generation_credits,
    attach_generation_task,
    charge_reserved_generation,
    release_reserved_generation,
    get_generation_by_task_for_user,
)

from app.services.deepswap import (
    create_image_to_video_task,
    create_text_to_video_task,
    create_video_extend_task,
    create_reference_to_video_task,
    get_video_task,
)

logger = logging.getLogger(__name__)


def calculate_generation_cost(
    mode: str,
    duration: int
) -> float:

    if duration not in (5, 10, 15):
        raise HTTPException(
            status_code=400,
            detail="Duração inválida."
        )

    if mode == "reference-to-video":
        cost_per_5_seconds = 2.0
    else:
        cost_per_5_seconds = 1.2

    return (duration / 5) * cost_per_5_seconds


async def create_reserved_video(user_id, mode, duration, create_task, *task_args):
    cost = calculate_generation_cost(mode, duration)
    # Sem chave do cliente: um retry HTTP completo é uma nova operação.
    try:
        generation = reserve_generation_credits(
            user_id, str(uuid4()), cost, "video-generation", mode
        )
    except ValueError as error:
        message = str(error)
        status = 404 if message == "Usuário não encontrado." else (
            402 if message == "Créditos insuficientes." else 400
        )
        raise HTTPException(status_code=status, detail=message) from error

    generation_id = generation["generationId"]
    try:
        task = await create_task(*task_args)
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
        # Validações locais dos helpers (por exemplo, conversão de sourceTaskId).
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
        attach_generation_task(generation_id, str(task_id))
    except Exception:
        # A task já existe: falhar ao persistir o vínculo não autoriza liberação.
        logger.exception(
            "Falha ao vincular task; reserva mantida: generationId=%s taskId=%s",
            generation_id, task_id,
        )
        raise
    return task

router = APIRouter(
    prefix="/video-generation",
    tags=["Video Generation"],
)


class ImageToVideoRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    image_url: str
    prompt: str
    duration: int


class VideoExtendRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_task_id: str
    prompt: str
    duration: int


class ReferenceToVideoRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reference_url: str
    prompt: str
    duration: int


class TextToVideoRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    prompt: str
    reference_image_url: str
    duration: int



@router.post("/image-to-video")
async def create_image_to_video(
    request: ImageToVideoRequest,
    current_user: Annotated[
        AuthenticatedUser,
        Depends(get_current_user),
    ],
):

    return await create_reserved_video(
        current_user.uid,
        "image-to-video",
        request.duration,
        create_image_to_video_task,
        request.image_url,
        request.prompt,
        request.duration
    )


@router.get("/task/{task_id}")
async def get_video_generation_task(
    task_id: str,
    current_user: Annotated[AuthenticatedUser, Depends(get_current_user)],
):
    try:
        generation = get_generation_by_task_for_user(task_id, current_user.uid)
    except ValueError as error:
        raise HTTPException(status_code=404, detail="Geração não encontrada.") from error

    if generation is None:
        # Legadas já cobradas: apenas consulta, e somente com prova de propriedade.
        legacy = list(
            db.collection("users").document(current_user.uid).collection("swaps")
            .where(filter=FieldFilter("taskId", "==", task_id)).limit(1).stream()
        )
        if not legacy:
            raise HTTPException(status_code=404, detail="Geração não encontrada.")
    elif generation.get("type") != "video-generation":
        raise HTTPException(status_code=404, detail="Geração não encontrada.")

    task = await get_video_task(task_id)
    if generation is not None:
        status = task.get("taskStatus") if isinstance(task, dict) else None
        if status == "SUCCEEDED":
            charge_reserved_generation(generation["generationId"])
        elif status == "FAILED":
            release_reserved_generation(generation["generationId"])
        elif status not in ("PENDING", "RUNNING"):
            logger.warning("Estado de task desconhecido; reserva mantida: generationId=%s", generation["generationId"])
    return task


@router.post("/extend")
async def extend_video(
    request: VideoExtendRequest,
    current_user: Annotated[
        AuthenticatedUser,
        Depends(get_current_user),
    ],
):

    return await create_reserved_video(
        current_user.uid,
        "video-extend",
        request.duration,
        create_video_extend_task,
        request.source_task_id,
        request.prompt,
        request.duration
    )


@router.post("/reference-to-video")
async def create_reference_to_video(
    request: ReferenceToVideoRequest,
    current_user: Annotated[
        AuthenticatedUser,
        Depends(get_current_user),
    ],
):

    return await create_reserved_video(
        current_user.uid,
        "reference-to-video",
        request.duration,
        create_reference_to_video_task,
        request.reference_url,
        request.prompt,
        request.duration
    )


@router.post("/text-to-video")
async def create_text_to_video(
    request: TextToVideoRequest,
    current_user: Annotated[
        AuthenticatedUser,
        Depends(get_current_user),
    ],
):

    return await create_reserved_video(
        current_user.uid,
        "text-to-video",
        request.duration,
        create_text_to_video_task,
        request.prompt,
        request.reference_image_url,
        request.duration
    )
