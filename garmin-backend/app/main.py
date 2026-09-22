from __future__ import annotations

import logging
import threading
from contextlib import asynccontextmanager
from datetime import date, timedelta

from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import Depends, FastAPI, HTTPException, Query
from starlette.requests import Request
from starlette.responses import Response

from . import config, db, sync
from .auth import require_bearer_token

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("garmin_backend.main")

scheduler = BackgroundScheduler()
_backfill_lock = threading.Lock()


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
        backfill_status = db.get_state(conn, "backfill_status")
        backfill_progress = db.get_state(conn, "backfill_progress")
    finally:
        conn.close()

    return {
        "connected": sync.client._client is not None and not sync.client.needs_relogin,
        "needs_relogin": sync.client.needs_relogin,
        "last_error": sync.client.last_error,
        "last_sync_at": last_sync_at,
        "last_backfill_at": last_backfill_at,
        "sync_interval_minutes": config.SYNC_INTERVAL_MINUTES,
        # A full backfill takes minutes (deliberately paced, see sync.py),
        # so it always runs in the background -- poll these two fields
        # instead of waiting on POST /api/sync/trigger's response.
        "backfill_status": backfill_status,  # "running" | "done" | "error" | None
        "backfill_progress": backfill_progress,  # "N/total" days synced so far
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


def _run_backfill_in_background() -> None:
    try:
        result = sync.backfill()
        if not result.get("ok"):
            logger.warning("background backfill did not complete cleanly: %s", result)
    finally:
        _backfill_lock.release()


@app.post("/api/sync/trigger", dependencies=[Depends(require_bearer_token)])
def trigger_sync(full_backfill: bool = Query(default=False)):
    if not full_backfill:
        # Small (few-day) window -- fast enough to run in-request.
        return sync.sync_recent_days()

    # A full backfill takes minutes (paced deliberately, see sync.py), far
    # longer than Render's (or any) HTTP proxy will hold a request open.
    # Kick it off in a background thread and return immediately; the
    # caller polls GET /api/status for backfill_status / backfill_progress.
    if not _backfill_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="a backfill is already running -- check /api/status")

    thread = threading.Thread(target=_run_backfill_in_background, daemon=True)
    thread.start()
    return {"ok": True, "started": True, "message": "backfill running in background -- poll GET /api/status"}
