from fastapi import APIRouter
from fastapi import Body

from app.services.deepswap import (
    create_text_to_video_task,
    create_image_to_video_task,
    get_video_task
)

router = APIRouter(
    prefix="/video",
    tags=["Video"]
)


@router.post("/generate")
async def generate_video(

    prompt: str = Body(embed=True),

    reference_image_url: str | None = Body(
        default=None,
        embed=True
    )

):

    return await create_text_to_video_task(
        prompt,
        reference_image_url
    )

@router.get("/{task_id}")
async def get_video(
    task_id: str
):

    return await get_video_task(
        task_id
    )


@router.post("/generate-image")
async def generate_image_video(

    image_url: str = Body(embed=True),

    prompt: str = Body(embed=True)

):

    return await create_image_to_video_task(
        image_url,
        prompt
    )