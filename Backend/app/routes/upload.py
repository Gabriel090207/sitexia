import logging

from fastapi import APIRouter, HTTPException


logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/upload",
    tags=["Upload"],
)


@router.post("", deprecated=True)
async def upload():
    # Do not bind or read the request body, or import the legacy Storage service.
    logger.warning("legacy_upload_endpoint_access method=POST status=410")
    raise HTTPException(status_code=410, detail="Este endpoint foi descontinuado.")
