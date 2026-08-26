from typing import Annotated

from fastapi import APIRouter, Depends

from app.dependencies.auth import AuthenticatedUser, get_current_user


router = APIRouter(
    prefix="/auth",
    tags=["Authentication"],
)


@router.get("/me")
def get_authenticated_user(
    current_user: Annotated[
        AuthenticatedUser,
        Depends(get_current_user),
    ],
):
    return {
        "authenticated": True,
        "uid": current_user.uid,
    }
