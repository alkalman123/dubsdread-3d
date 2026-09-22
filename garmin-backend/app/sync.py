from __future__ import annotations

import logging
import time
from datetime import date, timedelta

from . import config, db
from .garmin_client import GarminClient, NeedsReloginError
from .merge import merge_wellness_day, pick_sleep_for_day, tag_hrv_reading

logger = logging.getLogger("garmin_backend.sync")

client = GarminClient()


def _build_wellness_record(raw: dict) -> dict:
    """Shape one day's raw multi-endpoint pull into the stored record shape,
    applying the HRV tagging gotcha. Sleep's midnight-crossing gotcha is
    applied separately in sync_recent_days/backfill, since it needs the
    *next* day's sleep pull too."""
    record = dict(raw)
    record["hrv"] = tag_hrv_reading(raw.get("hrv"))
    return record


def sync_one_day(conn, day: date) -> None:
    raw = client.fetch_wellness_day(day)

    # Gotcha #5: resolve sleep separately using both today's and tomorrow's
    # queries so a session spanning midnight lands on the right dashboard day.
    sleep_pair = client.fetch_sleep_shifted(day)
    resolved_sleep = pick_sleep_for_day(sleep_pair.get("queried_day"), sleep_pair.get("queried_next_day"))
    raw["sleep"] = resolved_sleep

    fresh = _build_wellness_record(raw)
    date_str = day.isoformat()
    stored = db.get_wellness_day(conn, date_str)
    merged = merge_wellness_day(stored, fresh)
    db.upsert_wellness_day(conn, date_str, merged)


def sync_activities(conn, start_date: date, end_date: date) -> int:
    activities = client.fetch_activities_by_date(start_date, end_date)
    count = 0
    for activity in activities:
        activity_id = str(activity.get("activityId"))
        if not activity_id or activity_id == "None":
            continue
        start = (activity.get("startTimeLocal") or activity.get("startTimeGMT") or "")[:10]
        db.upsert_activity(conn, activity_id, start or start_date.isoformat(), activity)
        count += 1
    return count


def sync_recent_days() -> dict:
    """Gotcha #3: always re-pull an overlap window of recent days, not just
    "today" -- Garmin devices sync late and some wellness fields (sleep
    especially) finalize hours after the fact. Runs on every scheduled tick."""
    if not client.ensure_connected():
        return {"ok": False, "needs_relogin": client.needs_relogin, "error": client.last_error}

    conn = db.get_connection()
    try:
        today = date.today()
        start = today - timedelta(days=config.OVERLAP_DAYS)
        days_synced = 0
        try:
            for offset in range((today - start).days + 1):
                sync_one_day(conn, start + timedelta(days=offset))
                days_synced += 1
            activities_synced = sync_activities(conn, start, today)
        except NeedsReloginError as err:
            return {"ok": False, "needs_relogin": True, "error": str(err)}

        db.set_state(conn, "last_sync_at", today.isoformat())
        return {"ok": True, "days_synced": days_synced, "activities_synced": activities_synced}
    finally:
        conn.close()


def backfill(days: int | None = None) -> dict:
    """One-off deep pull for history that predates the normal overlap
    window -- used the first time this backend runs against an account, or
    on request. Paced per gotcha #4 so we don't get rate-limited.

    A full year of history at this pace takes minutes, not seconds, which
    is longer than Render's (or any) HTTP proxy will hold a request open.
    Callers that trigger this over the API run it in a background thread
    (see main.py) and poll `progress` in sync_state / GET /api/status
    instead of waiting on the response."""
    if not client.ensure_connected():
        return {"ok": False, "needs_relogin": client.needs_relogin, "error": client.last_error}

    days = days or config.BACKFILL_DAYS
    conn = db.get_connection()
    try:
        today = date.today()
        start = today - timedelta(days=days)
        total_days = (today - start).days + 1
        days_synced = 0
        db.set_state(conn, "backfill_status", "running")
        db.set_state(conn, "backfill_progress", f"0/{total_days}")
        try:
            for offset in range(total_days):
                sync_one_day(conn, start + timedelta(days=offset))
                days_synced += 1
                db.set_state(conn, "backfill_progress", f"{days_synced}/{total_days}")
                time.sleep(config.BACKFILL_PACE_SECONDS)

            # Activities in bounded chunks -- Garmin's activity-by-date
            # endpoint is generally fine over long ranges, but keep it
            # paced the same way for consistency and safety.
            activities_synced = sync_activities(conn, start, today)
        except NeedsReloginError as err:
            db.set_state(conn, "backfill_status", "error")
            return {"ok": False, "needs_relogin": True, "error": str(err)}

        db.set_state(conn, "last_backfill_at", today.isoformat())
        db.set_state(conn, "last_sync_at", today.isoformat())
        db.set_state(conn, "backfill_status", "done")
        return {"ok": True, "days_synced": days_synced, "activities_synced": activities_synced}
    finally:
        conn.close()
