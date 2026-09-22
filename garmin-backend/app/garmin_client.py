"""Thin wrapper around python-garminconnect (cyberjunky), built to survive
the six ways this API bites you in practice. See README.md for the full
writeup; the short version, gotcha by gotcha:

  1. Any single endpoint can 500, time out, or come back empty on a given
     day even when the rest are fine (Garmin's backend is flaky per-service,
     not all-or-nothing). Every call goes through `safe()` so one dead
     endpoint doesn't take down the whole day's sync.
  2. Never assume a fresh pull replaces a stored day wholesale -- some
     endpoints backfill fields Garmin computes late (see #3). merge.py does
     the field-by-field reconciliation; this module only fetches and
     shapes, it doesn't decide what to keep.
  3. (handled in sync.py) always re-pull a multi-day overlap window.
  4. (handled in sync.py) pace backfills.
  5. Sleep spans midnight. Garmin timestamps sleep events in UTC epoch ms
     with no inherent "which calendar day does this belong to" answer, and
     `get_sleep_data(date)` sometimes returns the *previous* night's sleep
     depending on when the watch synced. We shift by 6 hours before
     bucketing so a sleep that runs e.g. 11pm-7am lands on the day the
     person woke up, matching how a human reads "last night's sleep on
     today's dashboard."
  6. HRV status/values come from two different measurement methods
     depending on device generation and firmware (`hrvSummary` "5-min"
     baseline captures vs. the newer continuous overnight readings). We
     tag every HRV reading with its method and never average or blend
     across methods into one series -- doing so silently corrupts the
     baseline Garmin uses for its own status field.
"""

from __future__ import annotations

import logging
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Callable, TypeVar

from garminconnect import (
    Garmin,
    GarminConnectAuthenticationError,
    GarminConnectConnectionError,
    GarminConnectTooManyRequestsError,
)

from . import config

logger = logging.getLogger("garmin_backend.client")

T = TypeVar("T")


class NeedsReloginError(Exception):
    """Raised when Garmin has rejected our stored tokens outright and only
    a fresh interactive `cli_login.py` run (from a residential IP, past
    Cloudflare) can recover -- as opposed to a transient error, which
    callers should just retry on the next scheduled sync."""


def safe(label: str, fn: Callable[[], T]) -> T | None:
    """Gotcha #1: wrap every endpoint call. Never let one dead endpoint take
    down a whole sync pass; log and move on with None instead."""
    try:
        return fn()
    except (GarminConnectConnectionError, GarminConnectTooManyRequestsError) as err:
        logger.warning("garmin endpoint %s failed (transient): %s", label, err)
        return None
    except GarminConnectAuthenticationError:
        # Let this one propagate -- it means our tokens are actually dead,
        # not that this one endpoint hiccuped, and the caller needs to know.
        raise
    except Exception as err:  # noqa: BLE001 -- deliberately broad, see docstring
        logger.warning("garmin endpoint %s failed (unexpected): %s", label, err)
        return None


class GarminClient:
    def __init__(self) -> None:
        self._client: Garmin | None = None
        self.needs_relogin = False
        self.last_error: str | None = None
        self.last_sync_at: datetime | None = None

    # ---- session lifecycle -------------------------------------------------

    def _tokenstore_ready(self) -> bool:
        p = Path(config.TOKENSTORE_PATH)
        return (p / "garmin_tokens.json").exists() if p.is_dir() or not p.name.endswith(".json") else p.exists()

    def _restore_tokenstore_from_env(self) -> None:
        """Render's free-tier disk is ephemeral. If the on-disk tokenstore is
        gone but we have a backup copy in GARMIN_TOKENSTORE_JSON, write it
        back out before trying to load it, so a redeploy doesn't force a
        fresh interactive login."""
        if self._tokenstore_ready() or not config.TOKENSTORE_JSON:
            return
        p = Path(config.TOKENSTORE_PATH)
        if p.is_dir() or not p.name.endswith(".json"):
            p = p / "garmin_tokens.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(config.TOKENSTORE_JSON)
        logger.info("restored garmin tokenstore from GARMIN_TOKENSTORE_JSON env var")

    def connect(self) -> bool:
        """Load stored tokens and confirm they still work. This is the path
        every server boot and every scheduled sync takes -- it should never
        need the password, and per the library's own source it proactively
        refreshes the DI token instead of re-hitting Garmin's Cloudflare-
        protected SSO login endpoint when the token is merely expiring, not
        dead. Only a genuinely revoked/invalid token forces that SSO hit,
        which is why the one-time interactive login (cli_login.py) has to
        happen from a residential IP once, up front."""
        self._restore_tokenstore_from_env()
        if not self._tokenstore_ready():
            self.needs_relogin = True
            self.last_error = "no tokenstore on disk -- run cli_login.py once from a residential IP"
            return False

        client = Garmin()
        try:
            client.login(config.TOKENSTORE_PATH)
        except GarminConnectAuthenticationError as err:
            self.needs_relogin = True
            self.last_error = f"stored tokens rejected: {err}"
            logger.error("garmin reconnect failed, needs re-login: %s", err)
            return False
        except (GarminConnectConnectionError, GarminConnectTooManyRequestsError) as err:
            # Transient -- don't burn the "needs re-login" flag over a
            # network blip or rate limit, just fail this attempt.
            self.last_error = f"transient connect failure: {err}"
            logger.warning("garmin reconnect transient failure: %s", err)
            return False

        self._client = client
        self.needs_relogin = False
        self.last_error = None
        return True

    def ensure_connected(self) -> bool:
        if self._client is not None and not self.needs_relogin:
            return True
        return self.connect()

    # ---- fetch helpers ------------------------------------------------------

    def _require_client(self) -> Garmin:
        if self._client is None:
            raise NeedsReloginError(self.last_error or "not connected")
        return self._client

    def fetch_activities(self, start: int = 0, limit: int = 50) -> list[dict[str, Any]]:
        client = self._require_client()
        result = safe("get_activities_by_date", lambda: client.get_activities(start, limit))
        return result or []

    def fetch_activities_by_date(self, start_date: date, end_date: date) -> list[dict[str, Any]]:
        client = self._require_client()
        result = safe(
            "get_activities_by_date",
            lambda: client.get_activities_by_date(start_date.isoformat(), end_date.isoformat()),
        )
        return result or []

    def fetch_wellness_day(self, day: date) -> dict[str, Any]:
        """Pull every wellness endpoint for one calendar day. Each field is
        independently None-able (gotcha #1) -- merge.py decides what to do
        with the gaps against whatever is already stored for this day."""
        client = self._require_client()
        ds = day.isoformat()

        stats = safe("get_stats", lambda: client.get_stats(ds))
        summary = safe("get_user_summary", lambda: client.get_user_summary(ds))
        body_battery = safe("get_body_battery", lambda: client.get_body_battery(ds, ds))
        body_battery_events = safe("get_body_battery_events", lambda: client.get_body_battery_events(ds))
        sleep = safe("get_sleep_data", lambda: client.get_sleep_data(ds))
        rhr = safe("get_rhr_day", lambda: client.get_rhr_day(ds))
        hrv = safe("get_hrv_data", lambda: client.get_hrv_data(ds))
        training_readiness = safe("get_training_readiness", lambda: client.get_training_readiness(ds))

        return {
            "date": ds,
            "stats": stats,
            "summary": summary,
            "body_battery": body_battery,
            "body_battery_events": body_battery_events,
            "sleep": sleep,
            "rhr": rhr,
            "hrv": hrv,
            "training_readiness": training_readiness,
        }

    def fetch_sleep_shifted(self, day: date) -> dict[str, Any] | None:
        """Gotcha #5: `get_sleep_data(day)` is unreliable about which
        calendar day a spans-midnight sleep session belongs to. Query both
        `day` and `day + 1`, then let sync.py's bucketing logic (the +6h
        shift heuristic) decide which one is actually "last night" for the
        given day."""
        client = self._require_client()
        today = safe("get_sleep_data", lambda: client.get_sleep_data(day.isoformat()))
        tomorrow = safe("get_sleep_data", lambda: client.get_sleep_data((day + timedelta(days=1)).isoformat()))
        return {"queried_day": today, "queried_next_day": tomorrow}
