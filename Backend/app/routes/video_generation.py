import asyncio
import json
import logging
from typing import Annotated
from uuid import uuid4

import httpx
from google.api_core.exceptions import Aborted, DeadlineExceeded, ServiceUnavailable

from fastapi import APIRouter, Depends, HTTPException
from starlette.concurrency import run_in_threadpool

from pydantic import BaseModel, ConfigDict, Field

from app.dependencies.auth import AuthenticatedUser, get_current_user

from app.services.video_reference import prepare_video_reference
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
            if mode == "image-to-video":
                logger.warning(
                    "Image to Video rejeitado: status=%s generationId=%s",
                    error.response.status_code, generation_id,
                )
                raise HTTPException(
                    status_code=502,
                    detail="O provedor não aceitou a solicitação de geração de vídeo.",
                ) from None
        else:
            logger.warning("Criação ambígua; reserva mantida: generationId=%s", generation_id)
        raise
    except (httpx.RequestError, json.JSONDecodeError, asyncio.CancelledError):
        logger.warning("Criação ambígua; reserva mantida: generationId=%s", generation_id)
        raise
    except (ValueError, HTTPException):
        # Validações locais dos helpers (por exemplo, conversão de sourceTaskId).
        release_reserved_generation(generation_id)
        raise
    except Exception:
        # Não há evidência suficiente para liberar em falhas inesperadas.
        logger.warning("Criação não confirmada; reserva mantida: generationId=%s", generation_id)
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
        logger.warning(
            "Falha ao vincular task; reserva mantida: generationId=%s taskId=%s",
            generation_id, task_id,
        )
        raise
    return task

async def create_private_reference_video(*args):
    """Keep provider exception text (which may contain URLs) out of server logs."""
    try:
        return await create_reserved_video(*args)
    except HTTPException:
        raise
    except Exception as error:
        logger.warning("Falha na geração de vídeo: errorType=%s", type(error).__name__)
        raise HTTPException(502, "Não foi possível confirmar a geração de vídeo.") from None


router = APIRouter(
    prefix="/video-generation",
    tags=["Video Generation"],
)


class ImageToVideoRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    image_url: str
    prompt: str = Field(max_length=1500)
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
    reference_image_url: str = ""
    duration: int



@router.post("/image-to-video")
async def create_image_to_video(
    request: ImageToVideoRequest,
    current_user: Annotated[
        AuthenticatedUser,
        Depends(get_current_user),
    ],
):

    reference = await run_in_threadpool(prepare_video_reference, current_user.uid, request.image_url, bounded_dimensions=True)

    return await create_private_reference_video(
        current_user.uid,
        "image-to-video",
        request.duration,
        create_image_to_video_task,
        reference,
        request.prompt,
        request.duration
    )


def authorize_video_task(task_id: str, uid: str) -> dict:
    """Only backend-written generation bindings prove task ownership.

    A saved owned object proves access to that copy, not to a provider task ID
    written in the library. Legacy tasks without this binding stay denied.
    """
    try:
        generation = get_generation_by_task_for_user(task_id, uid)
    except ValueError:
        raise HTTPException(404, "Geração não encontrada.") from None
    except Exception:
        raise HTTPException(503, "Não foi possível validar a geração.") from None
    if generation is None or generation.get("type") != "video-generation":
        raise HTTPException(404, "Geração não encontrada.")
    return generation


@router.get("/task/{task_id}")
async def get_video_generation_task(
    task_id: str,
    current_user: Annotated[AuthenticatedUser, Depends(get_current_user)],
):
    generation = authorize_video_task(task_id, current_user.uid)

    try:
        task = await get_video_task(task_id)
    except (httpx.HTTPError, json.JSONDecodeError):
        raise HTTPException(502, "Não foi possível consultar a geração de vídeo.") from None
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

    authorize_video_task(request.source_task_id, current_user.uid)

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

    reference = await run_in_threadpool(prepare_video_reference, current_user.uid, request.reference_url, bounded_dimensions=True)

    return await create_private_reference_video(
        current_user.uid,
        "reference-to-video",
        request.duration,
        create_reference_to_video_task,
        reference,
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

    reference = await run_in_threadpool(prepare_video_reference, current_user.uid, request.reference_image_url, bounded_dimensions=False) if request.reference_image_url else ""

    return await create_private_reference_video(
        current_user.uid,
        "text-to-video",
        request.duration,
        create_text_to_video_task,
        request.prompt,
        reference,
        request.duration
    )
