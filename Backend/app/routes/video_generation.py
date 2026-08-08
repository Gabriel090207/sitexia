from fastapi import APIRouter

from pydantic import BaseModel

from app.services.deepswap import (
    create_image_to_video_task,
    create_text_to_video_task,
    create_video_extend_task,
    create_reference_to_video_task,
    get_video_task,
)

router = APIRouter(
    prefix="/video-generation",
    tags=["Video Generation"],
)

class ImageToVideoRequest(BaseModel):
    image_url: str
    prompt: str

class VideoExtendRequest(BaseModel):
    source_task_id: str
    prompt: str

class ReferenceToVideoRequest(BaseModel):
    reference_url: str
    prompt: str

class TextToVideoRequest(BaseModel):
    prompt: str
    reference_image_url: str

@router.post("/image-to-video")
async def create_image_to_video(
    request: ImageToVideoRequest
):

    return await create_image_to_video_task(
        request.image_url,
        request.prompt
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

    return await create_video_extend_task(
        request.source_task_id,
        request.prompt
    )


@router.post("/reference-to-video")
async def create_reference_to_video(
    request: ReferenceToVideoRequest
):

    return await create_reference_to_video_task(
        request.reference_url,
        request.prompt
    )


@router.post("/text-to-video")
async def create_text_to_video(
    request: TextToVideoRequest
):

    return await create_text_to_video_task(
        request.prompt,
        request.reference_image_url
    )