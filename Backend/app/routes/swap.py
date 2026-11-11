import json
import logging
from typing import Annotated, Literal
from urllib.parse import urlsplit

import httpx

from fastapi import APIRouter
from fastapi import Depends, HTTPException, Header

from pydantic import BaseModel, ConfigDict

from app.dependencies.auth import AuthenticatedUser, get_current_user
from app.services.face_swap_submission import submit_face_swap, finalize_linked_task, prepare_original_url
from app.services.face_swap_tasks import normalize_swap_id, require_task_owner
from app.services.face_swap_materials import (
    normalize_material_id,
    register_material_owner,
    require_material_owner,
)

from app.services.deepswap import (
    create_material,
    get_material,
    create_task,
    get as get_deep_response,
)


router = APIRouter(
    prefix="/swap",
    tags=["Face Swap"],
)


class CreateMaterialRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    image_url: str


class CreateSwapTaskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    material_id: str
    source_face_id: str
    target_face_url: str
    media_type: Literal["image", "gif", "video"] | None = None
    video_duration: float | None = None


class ResolveTaskRequest(BaseModel):
    task_id: str


@router.post("/material")
async def create_swap_material(
    request: CreateMaterialRequest,
    current_user: Annotated[
        AuthenticatedUser,
        Depends(get_current_user),
    ],
):

    signed_url = prepare_original_url(current_user.uid, request.image_url)
    try:
        material = await create_material(signed_url)
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
    current_user: Annotated[AuthenticatedUser, Depends(get_current_user)],
    idempotency_key: Annotated[str, Header(alias="Idempotency-Key", min_length=1,
                                         max_length=128, pattern=r"^[A-Za-z0-9_-]+$")],
):
    try:
        material_id = normalize_material_id(request.material_id)
        source_face_id = normalize_swap_id(request.source_face_id)
    except ValueError:
        raise HTTPException(400, "Identificador de material ou rosto inválido.") from None
    # Ownership is checked on replays too; provider metadata is only fetched for
    # a new intent. Client media_type/video_duration never determine the price.
    require_material_owner(material_id, current_user.uid)
    return await submit_face_swap(
        current_user.uid, idempotency_key, material_id, source_face_id,
        request.target_face_url,
        lambda identifier: get_swap_material(identifier, current_user), create_task,
    )

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
    financial = await finalize_linked_task(current_user.uid, task_id)
    try:
        task = await get_deep_response(f"/openapi/v1/tasks/{task_id}", log_response=False)
        returned_id = normalize_swap_id(task.get("taskId") if isinstance(task, dict) else None)
    except (httpx.HTTPError, json.JSONDecodeError, ValueError):
        raise HTTPException(502, "Não foi possível consultar a tarefa na Deep.") from None
    if returned_id != task_id:
        raise HTTPException(502, "A Deep retornou uma tarefa inválida.")
    if financial is not None and financial.get("creditStatus") in ("charged", "released"):
        task["taskStatus"] = financial["status"]
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
    financial = await finalize_linked_task(current_user.uid, task_id)

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

    status = (financial["status"] if financial is not None and financial.get("creditStatus") in ("charged", "released")
              else task.get("taskStatus"))
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
