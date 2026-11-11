"""Authenticated short-lived access to saved result media; no proxy or tasks."""
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel

from app.dependencies.auth import AuthenticatedUser, get_current_user
from app.services.video_access import create_video_access

router = APIRouter(prefix="/media", tags=["media"])


class VideoAccessResponse(BaseModel):
    url: str
    expiresAt: datetime
    expiresInSeconds: int
    mediaType: Literal["video"]
    contentType: str
    origin: Literal["face-swap", "video-generation"]


@router.post("/{item_id}/video-access", response_model=VideoAccessResponse)
def request_video_access(item_id: str, response: Response,
                         current_user: Annotated[AuthenticatedUser, Depends(get_current_user)]):
    result = create_video_access(current_user.uid, item_id)
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["Pragma"] = "no-cache"
    return result
