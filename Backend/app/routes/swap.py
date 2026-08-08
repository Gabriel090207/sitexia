from fastapi import APIRouter
from fastapi import Body

from pydantic import BaseModel

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


class CreateMaterialRequest(BaseModel):
    image_url: str


class ResolveTaskRequest(BaseModel):
    task_id: str


@router.post("/material")
async def create_swap_material(
    request: CreateMaterialRequest
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

    return await get_task(task_id)


@router.post("/result")
async def get_swap_result(
    request: ResolveTaskRequest
):

    return await resolve_task(
        request.task_id
    )