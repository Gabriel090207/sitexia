from fastapi import APIRouter

from pydantic import BaseModel

from app.services.deepswap import (
    create_text_to_image_task,
    get_task,
)


router = APIRouter(
    prefix="/image-generation",
    tags=["Image Generation"],
)


class TextToImageRequest(BaseModel):
    prompt: str


@router.post("/text-to-image")
async def create_text_to_image(
    request: TextToImageRequest
):

    return await create_text_to_image_task(
        request.prompt
    )


@router.get("/task/{task_id}")
async def get_image_generation_task(
    task_id: str
):

    return await get_task(
        task_id
    )