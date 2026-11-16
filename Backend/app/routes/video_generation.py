import asyncio
import json
import logging
from typing import Annotated
from uuid import uuid4

import httpx
from google.api_core.exceptions import Aborted, DeadlineExceeded, ServiceUnavailable

from fastapi import APIRouter, Depends, HTTPException
from starlette.concurrency import run_in_threadpool

from pydantic import BaseModel, ConfigDict, Field, field_validator

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
            try:
                release_reserved_generation(generation_id)
            except Exception:
                if mode != "video-extend":
                    raise
                logger.warning("Extensão rejeitada category=release_unconfirmed http_status=%s", error.response.status_code)
                raise HTTPException(503, "O provedor rejeitou a extensão, mas não foi possível confirmar a liberação da reserva. Não repita a operação automaticamente.") from None
            if mode == "video-extend":
                logger.warning("Extensão rejeitada category=provider_rejection http_status=%s", error.response.status_code)
                raise HTTPException(502, "O provedor não aceitou a solicitação de extensão de vídeo.") from None
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
    prompt: str = Field(max_length=1500)
    duration: int = Field(strict=True)

    @field_validator("source_task_id")
    @classmethod
    def valid_source_task_id(cls, value: str) -> str:
        if not value or any(char not in "0123456789" for char in value):
            raise ValueError("Identificador da tarefa inválido.")
        canonical = value.lstrip("0")
        if not canonical or len(canonical) > 19 or (len(canonical) == 19 and canonical > "9223372036854775807"):
            raise ValueError("Identificador da tarefa fora do intervalo int64 positivo.")
        return canonical

    @field_validator("duration")
    @classmethod
    def valid_duration(cls, value: int) -> int:
        if value not in (5, 10, 15):
            raise ValueError("Duração inválida.")
        return value


class ReferenceToVideoRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reference_url: str
    prompt: str = Field(max_length=1500)
    duration: int


class TextToVideoRequest(BaseModel):
    """Text-only T2V: legacy reference_image_url is explicitly rejected (422)."""
    model_config = ConfigDict(extra="forbid")

    prompt: str = Field(max_length=1500)
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

    if not isinstance(task, dict):
        raise HTTPException(502, "Resposta inválida da geração de vídeo.")
    if "taskId" in task:
        returned_id = task["taskId"]
        if (isinstance(returned_id, bool) or not isinstance(returned_id, (str, int))
                or str(returned_id) != task_id):
            raise HTTPException(502, "Identidade da tarefa de vídeo incompatível.")
    status = task.get("taskStatus")
    if not isinstance(status, str) or status not in {"SUCCEEDED", "FAILED", "PENDING", "RUNNING", "UNKNOWN"}:
        raise HTTPException(502, "Estado da tarefa de vídeo inválido.")

    try:
        if status == "SUCCEEDED":
            charge_reserved_generation(generation["generationId"])
        elif status == "FAILED":
            release_reserved_generation(generation["generationId"])
        elif status not in ("PENDING", "RUNNING"):
            logger.warning("Consulta de vídeo category=unknown_status")
    except Exception:
        logger.warning("Consulta de vídeo category=financial_finalization_unconfirmed")
        raise HTTPException(503, {
            "code": "financial_finalization_unconfirmed",
            "taskStatus": status,
            "message": "Não foi possível confirmar a finalização financeira da geração de vídeo. Não inicie outra geração para substituir esta tentativa.",
        }) from None

    # Provider diagnostics are not a public response contract. Only expose the
    # status and media fields used by the UI, never raw error bodies or metadata.
    result = {"taskStatus": status}
    if "taskId" in task:
        result["taskId"] = task["taskId"]
    if status == "SUCCEEDED":
        for field in ("videoUrl", "coverUrl"):
            if isinstance(task.get(field), str):
                result[field] = task[field]
    elif status == "FAILED":
        result["errorMsg"] = "A geração do vídeo falhou."
    return result


@router.post("/extend")
async def extend_video(
    request: VideoExtendRequest,
    current_user: Annotated[
        AuthenticatedUser,
        Depends(get_current_user),
    ],
):

    authorize_video_task(request.source_task_id, current_user.uid)

    try:
        return await create_reserved_video(
            current_user.uid,
            "video-extend",
            request.duration,
            create_video_extend_task,
            request.source_task_id,
            request.prompt,
            request.duration
        )
    except HTTPException:
        raise
    except (httpx.HTTPError, json.JSONDecodeError):
        logger.warning("Extensão não confirmada category=provider_unconfirmed")
        raise HTTPException(502, "Não foi possível confirmar a extensão de vídeo. A reserva pode continuar ativa. Não inicie outra extensão para substituir esta tentativa.") from None
    except Exception:
        logger.warning("Extensão não confirmada category=operation_unconfirmed")
        raise HTTPException(503, "Não foi possível confirmar a operação de extensão. A tarefa ou reserva pode existir. Não inicie outra extensão para substituir esta tentativa.") from None


@router.post("/reference-to-video")
async def create_reference_to_video(
    request: ReferenceToVideoRequest,
    current_user: Annotated[
        AuthenticatedUser,
        Depends(get_current_user),
    ],
):

    # Keep the authenticated route explicit for old clients; historical task
    # queries/finalizers remain available through the shared task endpoint.
    raise HTTPException(410, "Referência para Vídeo está indisponível para novas gerações.")


@router.post("/text-to-video")
async def create_text_to_video(
    request: TextToVideoRequest,
    current_user: Annotated[
        AuthenticatedUser,
        Depends(get_current_user),
    ],
):

    return await create_private_reference_video(
        current_user.uid,
        "text-to-video",
        request.duration,
        create_text_to_video_task,
        request.prompt,
        request.duration
    )
