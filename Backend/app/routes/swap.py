import math
import json
import logging
from typing import Annotated, Literal
from urllib.parse import urlsplit

import httpx

from fastapi import APIRouter
from fastapi import Depends, HTTPException

from pydantic import BaseModel, ConfigDict

from app.dependencies.auth import AuthenticatedUser, get_current_user
from app.services.firebase import db
from app.services.face_swap_tasks import normalize_swap_id, register_task_owner, require_task_owner
from app.services.face_swap_materials import (
    normalize_material_id,
    register_material_owner,
    require_material_owner,
)

from app.services.deepswap import (
    create_material,
    get_material,
    create_task,
    get_task,
    get as get_deep_response,
)


router = APIRouter(
    prefix="/swap",
    tags=["Face Swap"],
)


from google.cloud import firestore


@firestore.transactional
def deduct_credits(
    transaction,
    user_ref,
    cost: float
):

    snapshot = user_ref.get(
        transaction=transaction
    )

    if not snapshot.exists:
        raise HTTPException(
            status_code=404,
            detail="Usuário não encontrado."
        )

    user_data = snapshot.to_dict()

    current_credits = float(
        user_data.get("credits") or 0
    )

    if current_credits < cost:
        raise HTTPException(
            status_code=402,
            detail="Créditos insuficientes."
        )

    new_credits = current_credits - cost

    transaction.update(
        user_ref,
        {
            "credits": new_credits
        }
    )

    return new_credits


class CreateMaterialRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    image_url: str


class CreateSwapTaskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    material_id: str
    source_face_id: str
    target_face_url: str
    media_type: Literal["image", "gif", "video"]
    video_duration: float | None = None


class ResolveTaskRequest(BaseModel):
    task_id: str


def calculate_swap_cost(
    media_type: str,
    video_duration: float | None = None,
) -> float:

    if media_type == "image":
        return 0.1

    if media_type == "gif":
        return 1.0

    if media_type == "video":
        if (
            video_duration is None
            or not math.isfinite(video_duration)
            or video_duration <= 0
        ):
            raise HTTPException(
                status_code=400,
                detail="Duração do vídeo inválida."
            )

        return float(max(1, math.ceil(video_duration / 15)))

    raise HTTPException(
        status_code=400,
        detail="Tipo de mídia inválido."
    )


@router.post("/material")
async def create_swap_material(
    request: CreateMaterialRequest,
    current_user: Annotated[
        AuthenticatedUser,
        Depends(get_current_user),
    ],
):

    try:
        material = await create_material(request.image_url)
    except (httpx.HTTPError, json.JSONDecodeError):
        raise HTTPException(502, "Não foi possível criar o material na Deep.") from None
    try:
        material_id = normalize_material_id(
            material.get("materialId") if isinstance(material, dict) else None
        )
    except ValueError:
        logging.getLogger(__name__).warning("Deep returned material without valid ID: uid=%s", current_user.uid)
        raise HTTPException(502, "A Deep retornou um material inválido.") from None
    try:
        register_material_owner(material_id, current_user.uid)
    except HTTPException:
        logging.getLogger(__name__).warning(
            "Material ownership not saved; investigate orphan: materialId=%s uid=%s",
            material_id, current_user.uid,
        )
        raise
    return material


@router.get("/material/{material_id}")
async def get_swap_material(
    material_id: str,
    current_user: Annotated[AuthenticatedUser, Depends(get_current_user)],
):
    try:
        material_id = normalize_material_id(material_id)
    except ValueError:
        raise HTTPException(404, "Material não encontrado.") from None
    require_material_owner(material_id, current_user.uid)
    try:
        material = await get_material(material_id)
        returned_id = normalize_material_id(
            material.get("materialId") if isinstance(material, dict) else None
        )
    except (httpx.HTTPError, json.JSONDecodeError, ValueError):
        raise HTTPException(502, "Não foi possível consultar o material na Deep.") from None
    if returned_id != material_id:
        raise HTTPException(502, "A Deep retornou um material inválido.")
    return material


@router.post("/task")
async def create_swap_task(
    request: CreateSwapTaskRequest,
    current_user: Annotated[
        AuthenticatedUser,
        Depends(get_current_user),
    ],
):
    try:
        material_id = normalize_material_id(request.material_id)
        source_face_id = normalize_swap_id(request.source_face_id)
    except ValueError:
        raise HTTPException(400, "Identificador de material ou rosto inválido.") from None
    # Authenticate ownership and provider data before the existing debit.
    material = await get_swap_material(material_id, current_user)
    if material.get("status") != "SUCCEEDED":
        raise HTTPException(409, "O material não está pronto para Face Swap.")
    faces = material.get("faces")
    if not isinstance(faces, list):
        raise HTTPException(502, "A Deep retornou dados de rostos inválidos.")
    try:
        face_ids = {
            normalize_swap_id(face.get("id"))
            for face in faces if isinstance(face, dict)
        }
    except ValueError:
        raise HTTPException(502, "A Deep retornou dados de rostos inválidos.") from None
    if source_face_id not in face_ids:
        raise HTTPException(400, "O rosto não pertence ao material informado.")
    cost = calculate_swap_cost(
        request.media_type,
        request.video_duration,
    )

    user_ref = (
        db.collection("users")
        .document(current_user.uid)
    )

    transaction = db.transaction()

    remaining_credits = deduct_credits(
        transaction,
        user_ref,
        cost,
    )

    try:
        task = await create_task(material_id, source_face_id, request.target_face_url)
    except (httpx.HTTPError, json.JSONDecodeError):
        raise HTTPException(502, "Não foi possível criar a tarefa na Deep.") from None
    try:
        task_id = normalize_swap_id(task.get("taskId") if isinstance(task, dict) else None)
    except ValueError:
        logging.getLogger(__name__).warning(
            "Deep returned task without valid ID: uid=%s materialId=%s", current_user.uid, material_id,
        )
        raise HTTPException(502, "A Deep retornou uma tarefa inválida.") from None
    try:
        register_task_owner(task_id, current_user.uid, material_id, source_face_id)
    except HTTPException:
        logging.getLogger(__name__).warning(
            "Task ownership not saved; investigate orphan: taskId=%s uid=%s materialId=%s",
            task_id, current_user.uid, material_id,
        )
        raise
    return task

@router.get("/task/{task_id}")
async def get_swap_task(
    task_id: str,
    current_user: Annotated[AuthenticatedUser, Depends(get_current_user)],
):
    try:
        task_id = normalize_swap_id(task_id)
    except ValueError:
        raise HTTPException(404, "Tarefa não encontrada.") from None
    require_task_owner(task_id, current_user.uid)
    try:
        task = await get_deep_response(f"/openapi/v1/tasks/{task_id}", log_response=False)
        returned_id = normalize_swap_id(task.get("taskId") if isinstance(task, dict) else None)
    except (httpx.HTTPError, json.JSONDecodeError, ValueError):
        raise HTTPException(502, "Não foi possível consultar a tarefa na Deep.") from None
    if returned_id != task_id:
        raise HTTPException(502, "A Deep retornou uma tarefa inválida.")
    return task


@router.post("/result")
async def get_swap_result(
    request: ResolveTaskRequest,
    current_user: Annotated[AuthenticatedUser, Depends(get_current_user)],
):

    try:
        task_id = normalize_swap_id(request.task_id)
    except ValueError:
        raise HTTPException(404, "Tarefa não encontrada.") from None
    require_task_owner(task_id, current_user.uid)

    try:
        task = await get_deep_response(
            f"/openapi/v1/tasks/{task_id}",
            log_response=False,
        )
    except (httpx.HTTPError, json.JSONDecodeError):
        # Não repassar respostas/URLs do provedor em erros ou logs.
        raise HTTPException(
            status_code=502,
            detail="Não foi possível consultar o resultado na Deep.",
        ) from None

    if not isinstance(task, dict):
        raise HTTPException(status_code=502, detail="Resposta inválida da Deep.")

    status = task.get("taskStatus")
    if status in ("PENDING", "RUNNING"):
        raise HTTPException(status_code=409, detail="O Face Swap ainda está em processamento.")
    if status == "FAILED":
        raise HTTPException(status_code=422, detail="O processamento do Face Swap falhou.")
    if status != "SUCCEEDED":
        raise HTTPException(status_code=502, detail="Estado de tarefa inválido retornado pela Deep.")

    candidates = [task.get("videoUrl")]
    image_urls = task.get("imageUrls")
    if isinstance(image_urls, list):
        candidates.extend(image_urls)

    file_url = None
    for candidate in candidates:
        if not isinstance(candidate, str) or not candidate or any(char.isspace() for char in candidate):
            continue
        try:
            url = urlsplit(candidate)
            host = url.hostname
            url.port  # Rejeitar portas malformadas.
        except ValueError:
            continue
        if url.scheme in ("http", "https") and host:
            file_url = candidate
            break

    if file_url is None:
        raise HTTPException(status_code=502, detail="A Deep concluiu a tarefa sem retornar a URL do resultado.")

    result = {
        "success": True,
        "status": status,
        "file_url": file_url,
    }
    # Manter os campos auxiliares somente quando fornecidos pela OpenAPI.
    for source, target in (
        ("taskId", "task_id"),
        ("coverUrl", "cover_url"),
        ("materialId", "material_id"),
    ):
        if task.get(source) is not None:
            result[target] = task[source]
    return result
