"""Gotcha #2: merge field-by-field, never overwrite wholesale.

A fresh pull for a day that's already partially stored (because, say, the
watch hadn't synced sleep yet when we first pulled that day) must not blow
away fields the new pull came back with as None/empty. The rule is simple
and applied recursively: a new value replaces an old one only if the new
value is not None/empty; otherwise the old value survives.
"""

from __future__ import annotations

from typing import Any


def _is_empty(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, (list, dict, str)) and len(value) == 0:
        return True
    return False


def merge_field(old: Any, new: Any) -> Any:
    if _is_empty(new):
        return old
    if isinstance(old, dict) and isinstance(new, dict):
        return merge_dicts(old, new)
    return new


def merge_dicts(old: dict[str, Any], new: dict[str, Any]) -> dict[str, Any]:
    merged = dict(old)
    for key, new_value in new.items():
        merged[key] = merge_field(old.get(key), new_value)
    return merged


def merge_wellness_day(stored: dict[str, Any] | None, fresh: dict[str, Any]) -> dict[str, Any]:
    """Merge one day's freshly-fetched wellness payload into whatever is
    already stored for that date, field by field."""
    if stored is None:
        return fresh
    return merge_dicts(stored, fresh)


# ---- gotcha #6: HRV method tagging -----------------------------------------

# Garmin's two HRV data shapes in the wild:
#  - "summary" method: `hrvSummary` block with a single overnight baseline
#    (weeklyAvg, lastNightAvg, status) -- older firmware / most watches.
#  - "reading" method: `hrvReadings` list of discrete 5-min measurements
#    through the night -- newer firmware.
# They are not the same measurement and Garmin's own `status` field is
# computed against whichever method produced it, so blending series from
# both methods into one history corrupts the trend line. We store them
# as separate tagged series and let the API/consumer pick one, never
# average across both.


def tag_hrv_reading(hrv_payload: dict[str, Any] | None) -> dict[str, Any] | None:
    if not hrv_payload:
        return None

    summary = hrv_payload.get("hrvSummary")
    readings = hrv_payload.get("hrvReadings")

    tagged: dict[str, Any] = {}
    if summary:
        tagged["summary_method"] = {
            "method": "overnight_summary",
            "weekly_avg": summary.get("weeklyAvg"),
            "last_night_avg": summary.get("lastNightAvg"),
            "last_night_5min_high": summary.get("lastNight5MinHigh"),
            "status": summary.get("status"),
            "baseline": summary.get("baseline"),
        }
    if readings:
        tagged["reading_method"] = {
            "method": "continuous_5min_readings",
            "readings": [
                {"timestamp": r.get("readingTimeGMT") or r.get("readingTimeLocal"), "hrv_value": r.get("hrvValue")}
                for r in readings
            ],
        }
    return tagged or None


# ---- gotcha #5: sleep spanning midnight -------------------------------------

SLEEP_MIDNIGHT_SHIFT_HOURS = 6


def pick_sleep_for_day(queried_day: dict[str, Any] | None, queried_next_day: dict[str, Any] | None) -> dict[str, Any] | None:
    """Given get_sleep_data(day) and get_sleep_data(day+1), decide which
    payload actually represents "the night that ended on the morning of
    day+1" -- i.e. the sleep a person would expect to see on day+1's
    dashboard. We compare each candidate's sleep-start timestamp shifted
    back by SLEEP_MIDNIGHT_SHIFT_HOURS against the calendar dates involved,
    and prefer whichever candidate's (shifted) start falls on `day` --
    that's the session that began the evening of `day` and is being
    reported for the following morning.

    This is a heuristic, not a guarantee -- Garmin doesn't give us an
    authoritative "which dashboard day does this belong to" field, so we
    match the shift the working local pipeline already uses.
    """

    def start_epoch_seconds(payload: dict[str, Any] | None) -> int | None:
        if not payload:
            return None
        dto = payload.get("dailySleepDTO") or {}
        ms = dto.get("sleepStartTimestampGMT") or dto.get("sleepStartTimestampLocal")
        return ms // 1000 if ms else None

    import datetime as _dt

    next_day_start = start_epoch_seconds(queried_next_day)
    if next_day_start is not None:
        shifted = _dt.datetime.utcfromtimestamp(next_day_start) - _dt.timedelta(hours=SLEEP_MIDNIGHT_SHIFT_HOURS)
        day_start = start_epoch_seconds(queried_day)
        day_shifted = (
            _dt.datetime.utcfromtimestamp(day_start) - _dt.timedelta(hours=SLEEP_MIDNIGHT_SHIFT_HOURS)
            if day_start
            else None
        )
        # Prefer next_day's payload if its shifted start is a *later*
        # calendar day than queried_day's shifted start -- meaning it's a
        # distinct, more-recently-started sleep session, i.e. the one
        # that belongs on this dashboard day.
        if day_shifted is None or shifted.date() > day_shifted.date():
            return queried_next_day

    return queried_day or queried_next_day
