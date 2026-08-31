import math
from typing import Annotated, Literal

from fastapi import APIRouter
from fastapi import Depends, HTTPException

from pydantic import BaseModel, ConfigDict

from app.dependencies.auth import AuthenticatedUser, get_current_user
from app.services.firebase import db

from app.services.deepswap import (
    create_material,
    get_material,
    create_task,
    get_task,
)

from app.services.browser_worker import (
    resolve_task,
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

    return await create_material(
        request.image_url
    )


@router.get("/material/{material_id}")
async def get_swap_material(
    material_id: str
):

    return await get_material(
        material_id
    )


@router.post("/task")
async def create_swap_task(
    request: CreateSwapTaskRequest,
    current_user: Annotated[
        AuthenticatedUser,
        Depends(get_current_user),
    ],
):

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

    return await create_task(
        request.material_id,
        request.source_face_id,
        request.target_face_url
    )

@router.get("/task/{task_id}")
async def get_swap_task(
    task_id: str
):

    return await get_task(task_id)


@router.post("/result")
async def get_swap_result(
    request: ResolveTaskRequest
):

    return await resolve_task(
        request.task_id
    )
