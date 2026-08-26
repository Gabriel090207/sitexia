from dataclasses import dataclass
from typing import Any, Annotated

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from firebase_admin import auth


bearer_scheme = HTTPBearer(auto_error=False)


@dataclass(frozen=True)
class AuthenticatedUser:
    uid: str
    claims: dict[str, Any]


def get_current_user(
    credentials: Annotated[
        HTTPAuthorizationCredentials | None,
        Depends(bearer_scheme),
    ],
) -> AuthenticatedUser:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Credencial de autenticação inválida.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    try:
        claims = auth.verify_id_token(credentials.credentials)
    except (auth.InvalidIdTokenError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Credencial de autenticação inválida.",
            headers={"WWW-Authenticate": "Bearer"},
        ) from None

    uid = claims.get("uid") or claims.get("sub")

    if not isinstance(uid, str) or not uid:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Credencial de autenticação inválida.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    return AuthenticatedUser(
        uid=uid,
        claims=claims,
    )
