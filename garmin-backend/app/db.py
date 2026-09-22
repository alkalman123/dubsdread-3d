from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS wellness_days (
    date TEXT PRIMARY KEY,
    data_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activities (
    activity_id TEXT PRIMARY KEY,
    start_date TEXT NOT NULL,
    data_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activities_start_date ON activities(start_date);

CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    value TEXT
);
"""


def get_connection() -> sqlite3.Connection:
    p = Path(config.DATABASE_PATH)
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(p))
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    conn = get_connection()
    try:
        conn.executescript(SCHEMA)
        conn.commit()
    finally:
        conn.close()


# ---- wellness_days ----------------------------------------------------------

def get_wellness_day(conn: sqlite3.Connection, date_str: str) -> dict[str, Any] | None:
    row = conn.execute("SELECT data_json FROM wellness_days WHERE date = ?", (date_str,)).fetchone()
    if row is None:
        return None
    return json.loads(row["data_json"])


def upsert_wellness_day(conn: sqlite3.Connection, date_str: str, data: dict[str, Any]) -> None:
    conn.execute(
        """
        INSERT INTO wellness_days (date, data_json, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(date) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at
        """,
        (date_str, json.dumps(data)),
    )
    conn.commit()


def list_wellness_days(conn: sqlite3.Connection, start_date: str, end_date: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT data_json FROM wellness_days WHERE date >= ? AND date <= ? ORDER BY date ASC",
        (start_date, end_date),
    ).fetchall()
    return [json.loads(r["data_json"]) for r in rows]


# ---- activities ---------------------------------------------------------------

def upsert_activity(conn: sqlite3.Connection, activity_id: str, start_date: str, data: dict[str, Any]) -> None:
    conn.execute(
        """
        INSERT INTO activities (activity_id, start_date, data_json, updated_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(activity_id) DO UPDATE SET
            start_date = excluded.start_date,
            data_json = excluded.data_json,
            updated_at = excluded.updated_at
        """,
        (activity_id, start_date, json.dumps(data)),
    )
    conn.commit()


def list_activities(conn: sqlite3.Connection, limit: int = 50, offset: int = 0) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT data_json FROM activities ORDER BY start_date DESC LIMIT ? OFFSET ?",
        (limit, offset),
    ).fetchall()
    return [json.loads(r["data_json"]) for r in rows]


# ---- sync_state ------------------------------------------------------------

def get_state(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM sync_state WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def set_state(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        """
        INSERT INTO sync_state (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        """,
        (key, value),
    )
    conn.commit()
