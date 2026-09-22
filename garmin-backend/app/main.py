from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from datetime import date, timedelta

from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import Depends, FastAPI, Query
from starlette.requests import Request
from starlette.responses import Response

from . import config, db, sync
from .auth import require_bearer_token

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("garmin_backend.main")

scheduler = BackgroundScheduler()


def _scheduled_sync() -> None:
    result = sync.sync_recent_days()
    if not result.get("ok"):
        logger.warning("scheduled sync did not complete cleanly: %s", result)


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()

    # Try an initial connect + sync at boot so /api/status is accurate
    # immediately rather than waiting for the first scheduled tick. This is
    # best-effort: a failure here just means needs_relogin gets reported
    # honestly, it doesn't stop the server from starting.
    try:
        sync.sync_recent_days()
    except Exception:  # noqa: BLE001
        logger.exception("initial sync at boot failed")

    scheduler.add_job(
        _scheduled_sync,
        "interval",
        minutes=config.SYNC_INTERVAL_MINUTES,
        id="recent_sync",
        replace_existing=True,
    )
    scheduler.start()
    logger.info("scheduler started, syncing every %s minutes", config.SYNC_INTERVAL_MINUTES)

    yield

    scheduler.shutdown(wait=False)


app = FastAPI(title="Garmin Backend", lifespan=lifespan)


@app.middleware("http")
async def no_store_cache_headers(request: Request, call_next):
    """This serves personal health data -- make sure nothing in front of it
    (browser, mobile app webview, a CDN if one's ever added) caches a
    response meant for one authenticated caller."""
    response: Response = await call_next(request)
    response.headers["Cache-Control"] = "private, no-store"
    return response


# ---- deliverable #3: failure-visibility for "needs re-login" ---------------


@app.get("/api/status")
def get_status():
    """The mobile app / Alpine Log frontend should poll this and surface a
    clear "reconnect Garmin" prompt when needs_relogin is true, rather than
    silently going stale. This is the honest signal the Node/Cloudflare
    attempt never had -- a distinct state from "transient error, will retry
    on the next scheduled sync"."""
    conn = db.get_connection()
    try:
        last_sync_at = db.get_state(conn, "last_sync_at")
        last_backfill_at = db.get_state(conn, "last_backfill_at")
    finally:
        conn.close()

    return {
        "connected": sync.client._client is not None and not sync.client.needs_relogin,
        "needs_relogin": sync.client.needs_relogin,
        "last_error": sync.client.last_error,
        "last_sync_at": last_sync_at,
        "last_backfill_at": last_backfill_at,
        "sync_interval_minutes": config.SYNC_INTERVAL_MINUTES,
    }


# ---- deliverable #4: endpoints the mobile app needs -------------------------


@app.get("/api/wellness", dependencies=[Depends(require_bearer_token)])
def get_wellness(
    start: str = Query(default=None, description="YYYY-MM-DD, defaults to 30 days ago"),
    end: str = Query(default=None, description="YYYY-MM-DD, defaults to today"),
):
    end_date = date.fromisoformat(end) if end else date.today()
    start_date = date.fromisoformat(start) if start else end_date - timedelta(days=30)

    conn = db.get_connection()
    try:
        days = db.list_wellness_days(conn, start_date.isoformat(), end_date.isoformat())
    finally:
        conn.close()

    return {"start": start_date.isoformat(), "end": end_date.isoformat(), "days": days}


@app.get("/api/activities", dependencies=[Depends(require_bearer_token)])
def get_activities(limit: int = Query(default=50, ge=1, le=200), offset: int = Query(default=0, ge=0)):
    conn = db.get_connection()
    try:
        activities = db.list_activities(conn, limit=limit, offset=offset)
    finally:
        conn.close()

    return {"limit": limit, "offset": offset, "activities": activities}


@app.post("/api/sync/trigger", dependencies=[Depends(require_bearer_token)])
def trigger_sync(full_backfill: bool = Query(default=False)):
    result = sync.backfill() if full_backfill else sync.sync_recent_days()
    return result
