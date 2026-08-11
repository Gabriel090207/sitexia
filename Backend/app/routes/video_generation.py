from fastapi import APIRouter, HTTPException

from pydantic import BaseModel

from firebase_admin import firestore

from app.services.firebase import (
    db,
    deduct_credits,
)

from app.services.deepswap import (
    create_image_to_video_task,
    create_text_to_video_task,
    create_video_extend_task,
    create_reference_to_video_task,
    get_video_task,
)


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


def charge_generation_credits(
    user_id: str,
    mode: str,
    duration: int
) -> float:

    cost = calculate_generation_cost(
        mode,
        duration
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
        f"Usuário {user_id}: "
        f"custo {cost} crédito(s), "
        f"saldo restante {remaining_credits}."
    )

    return remaining_credits

router = APIRouter(
    prefix="/video-generation",
    tags=["Video Generation"],
)


class ImageToVideoRequest(BaseModel):
    image_url: str
    prompt: str
    duration: int
    user_id: str


class VideoExtendRequest(BaseModel):
    source_task_id: str
    prompt: str
    duration: int
    user_id: str


class ReferenceToVideoRequest(BaseModel):
    reference_url: str
    prompt: str
    duration: int
    user_id: str


class TextToVideoRequest(BaseModel):
    prompt: str
    reference_image_url: str
    duration: int
    user_id: str



@router.post("/image-to-video")
async def create_image_to_video(
    request: ImageToVideoRequest
):

    charge_generation_credits(
        request.user_id,
        "image-to-video",
        request.duration
    )

    return await create_image_to_video_task(
        request.image_url,
        request.prompt,
        request.duration
    )


@router.get("/task/{task_id}")
async def get_video_generation_task(
    task_id: str
):

    return await get_video_task(
        task_id
    )


@router.post("/extend")
async def extend_video(
    request: VideoExtendRequest
):

    charge_generation_credits(
        request.user_id,
        "video-extend",
        request.duration
    )

    return await create_video_extend_task(
        request.source_task_id,
        request.prompt,
        request.duration
    )


@router.post("/reference-to-video")
async def create_reference_to_video(
    request: ReferenceToVideoRequest
):

    charge_generation_credits(
        request.user_id,
        "reference-to-video",
        request.duration
    )

    return await create_reference_to_video_task(
        request.reference_url,
        request.prompt,
        request.duration
    )


@router.post("/text-to-video")
async def create_text_to_video(
    request: TextToVideoRequest
):

    charge_generation_credits(
        request.user_id,
        "text-to-video",
        request.duration
    )

    return await create_text_to_video_task(
        request.prompt,
        request.reference_image_url,
        request.duration
    )