from fastapi import APIRouter
from fastapi import File
from fastapi import UploadFile

from app.services.storage import upload_image

router = APIRouter(
    prefix="/upload",
    tags=["Upload"]
)


@router.post("")
async def upload(
    file: UploadFile = File(...)
):
    image_url = await upload_image(file)

    return {
        "url": image_url
    }