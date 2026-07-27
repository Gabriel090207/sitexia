from fastapi import APIRouter
from fastapi import File
from fastapi import UploadFile
from fastapi import Body

from app.services.storage import upload_image

from app.services.deepswap import (
    create_material,
    get_material,
    create_task,
    get_task
)

router = APIRouter(
    prefix="/swap",
    tags=["Face Swap"]
)


@router.post("/material")
async def create_swap_material(
    file: UploadFile = File(...)
):

    image_url = await upload_image(file)

    return await create_material(
        image_url
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

    material_id: str = Body(),

    source_face_id: str = Body(),

    target_face_url: str = Body()

):

    return await create_task(
        material_id,
        source_face_id,
        target_face_url
    )


@router.get("/task/{task_id}")
async def get_swap_task(
    task_id: str
):

    return await get_task(
        task_id
    )