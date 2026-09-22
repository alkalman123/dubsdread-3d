from __future__ import annotations

import hmac

from fastapi import Header, HTTPException, status

from . import config


def require_bearer_token(authorization: str = Header(default="")) -> None:
    """Every route the mobile app calls depends on this. Distinct from
    Garmin auth entirely -- this just gates access to *this backend's* API
    with a secret the deployer makes up (BACKEND_API_TOKEN), so the sync
    service isn't an open proxy to someone's Garmin data."""
    if not config.BACKEND_API_TOKEN:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="BACKEND_API_TOKEN is not configured on the server",
        )

    prefix = "Bearer "
    if not authorization.startswith(prefix):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="missing bearer token")

    token = authorization[len(prefix):]
    if not hmac.compare_digest(token, config.BACKEND_API_TOKEN):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid bearer token")
