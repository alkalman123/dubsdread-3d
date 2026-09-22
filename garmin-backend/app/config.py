import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent

TOKENSTORE_PATH = os.getenv("GARMIN_TOKENSTORE_PATH", str(BASE_DIR / ".data" / "garmin_tokens"))
TOKENSTORE_JSON = os.getenv("GARMIN_TOKENSTORE_JSON", "").strip()

DATABASE_PATH = os.getenv("DATABASE_PATH", str(BASE_DIR / ".data" / "garmin.db"))

BACKEND_API_TOKEN = os.getenv("BACKEND_API_TOKEN", "").strip()

SYNC_INTERVAL_MINUTES = int(os.getenv("SYNC_INTERVAL_MINUTES", "30"))
BACKFILL_DAYS = int(os.getenv("BACKFILL_DAYS", "365"))

# Gotcha #3: always re-pull a rolling window of recent days on every sync,
# not just "today", because Garmin devices sync late and backfill their own
# wellness metrics (sleep in particular often finalizes hours after the
# night ends), so "yesterday" can still be incomplete on the first pass.
OVERLAP_DAYS = 3

# Gotcha #4: pace long historical backfills so we don't get rate-limited.
BACKFILL_PACE_SECONDS = 0.5
