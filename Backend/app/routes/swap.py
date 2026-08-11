from fastapi import APIRouter
from fastapi import Body, HTTPException

from pydantic import BaseModel

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

    target_face_url: str = Body(),

    user_id: str = Body(),

    generation_cost: float = Body()

):

    user_ref = (
        db.collection("users")
        .document(user_id)
    )

    user_snapshot = user_ref.get()

    if not user_snapshot.exists:
        raise HTTPException(
            status_code=404,
            detail="Usuário não encontrado."
        )

    user_data = user_snapshot.to_dict()

    current_credits = user_data.get("credits", 0)

    print(
        f"Custo recebido para geração: {generation_cost} crédito(s)."
    )

    print(
        f"Usuário {user_id} possui {current_credits} créditos."
    )

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