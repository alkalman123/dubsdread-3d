# garmin-backend

A standalone Python service that maintains a *live* Garmin Connect data
feed for a mobile app, built around `python-garminconnect` (the same
library your local `garmin-ai` pipeline already uses successfully). It
mediates all Garmin access itself: the mobile app / Alpine Log frontend
never talks to Garmin directly, it only talks to this backend's own small
JSON API.

## Why a Python backend, and why not log in from the server directly

Garmin's SSO login (`sso.garmin.com`) sits behind Cloudflare bot
protection that blocks requests from datacenter/cloud IPs -- which is
exactly what broke the earlier attempt to log in live from Render using
the Node `garmin-connect` package. This service works around that with a
one-time-login / long-lived-refresh split:

1. You run `cli_login.py` **once, from your own PC** (a residential IP,
   which Cloudflare lets through) to do the actual interactive SSO login
   (including MFA if enabled).
2. That produces an OAuth token pair (`di_token` / `di_refresh_token`).
   `python-garminconnect`'s own `Garmin.login()` proactively refreshes
   `di_token` using `di_refresh_token` whenever it's expiring -- a plain
   token-refresh call, not a new SSO login -- and only falls back to
   hitting the Cloudflare-protected SSO endpoint if the refresh token
   itself is dead. So once tokens exist, the *server* (Render, in a
   datacenter, behind whatever IP) can keep syncing indefinitely without
   ever needing to pass Cloudflare itself.
3. If Garmin does eventually invalidate the refresh token (revoked
   session, password change, long inactivity), this service can't recover
   on its own -- it has no path back through Cloudflare. `GET /api/status`
   will report `needs_relogin: true`, and you re-run `cli_login.py` from
   home to get back on the air.

## The six things that lose you data if you don't handle them

These are implemented in `app/garmin_client.py`, `app/merge.py`, and
`app/sync.py` -- code comments there point back to this list:

1. **Wrap every endpoint call.** Garmin's backend is flaky per-service,
   not all-or-nothing; one dead endpoint (say, HRV) shouldn't blank out
   the rest of a day's sync. `garmin_client.safe()` catches and logs.
2. **Merge field-by-field, never overwrite wholesale.** A day pulled
   before the watch fully synced can be missing fields a later pull for
   the same day fills in; a naive overwrite would erase them if the
   *later* pull happened to fail on some other field. `merge.py` only
   replaces a stored field when the new value is non-empty.
3. **Always re-pull a rolling overlap window.** Every scheduled sync
   re-fetches the last `OVERLAP_DAYS` (default 3) days, not just "today",
   because sleep and other wellness metrics often finalize on Garmin's
   side hours after the calendar day ends.
4. **Pace long backfills.** `backfill()` sleeps `BACKFILL_PACE_SECONDS`
   (default 0.5s) between days to avoid rate-limiting on a big historical
   pull.
5. **Sleep crosses midnight.** `get_sleep_data(date)` isn't reliably
   anchored to "the night that ended on the morning of `date`". We query
   both `date` and `date + 1` and use a 6-hour-shift heuristic
   (`merge.pick_sleep_for_day`) to decide which payload is actually last
   night's sleep for the dashboard day in question.
6. **Never blend HRV measurement methods.** Garmin has two incompatible
   HRV data shapes (an overnight summary baseline vs. continuous 5-minute
   readings) depending on device/firmware. `merge.tag_hrv_reading` keeps
   them in separate tagged series; nothing here averages across methods.

## Setup

```bash
cd garmin-backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # then edit BACKEND_API_TOKEN at minimum
```

### 1. One-time interactive login (from your own PC, not from Render)

```bash
python cli_login.py
```

Enter your Garmin email/password, and an MFA code if prompted. On success
this writes tokens to `.data/garmin_tokens/` (or wherever
`GARMIN_TOKENSTORE_PATH` points) and prints the token data as one JSON
string.

**Copy that printed JSON string into the `GARMIN_TOKENSTORE_JSON`
environment variable when you deploy.** Render's free tier wipes local
disk on every redeploy, so the token *file* alone won't survive that --
this env var is the backup the service reads from at boot if the file is
missing (see `app/garmin_client.py::_restore_tokenstore_from_env`).

### 2. Run locally

```bash
uvicorn app.main:app --reload --port 8000
```

On boot it runs an initial sync attempt, then schedules a recurring one
every `SYNC_INTERVAL_MINUTES` (default 30).

### 3. Deploy to Render

- New Web Service, root directory `garmin-backend`.
- Build command: `pip install -r requirements.txt`
- Start command: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
- Environment variables: `BACKEND_API_TOKEN`, `GARMIN_TOKENSTORE_JSON`
  (from step 1), and optionally `SYNC_INTERVAL_MINUTES` /
  `BACKFILL_DAYS`.
- Because the free tier's disk is ephemeral, `DATABASE_PATH` (SQLite)
  resets on redeploy too -- the next sync just rebuilds recent history
  from Garmin, or run `POST /api/sync/trigger?full_backfill=true` once
  after a redeploy to repopulate deep history.

## API

All endpoints except `/api/status` require `Authorization: Bearer
<BACKEND_API_TOKEN>`.

- `GET /api/status` -- `{connected, needs_relogin, last_error,
  last_sync_at, last_backfill_at, sync_interval_minutes}`. Poll this from
  the mobile app and show a "reconnect Garmin" prompt when
  `needs_relogin` is true -- that's the one failure mode this service
  can't self-heal (see "why a Python backend" above).
- `GET /api/wellness?start=YYYY-MM-DD&end=YYYY-MM-DD` -- daily sleep, HRV
  (method-tagged), resting HR, body battery, stress, steps, training
  readiness. Defaults to the last 30 days.
- `GET /api/activities?limit=50&offset=0` -- recent activities, newest
  first.
- `POST /api/sync/trigger?full_backfill=false` -- force a sync outside the
  schedule; pass `full_backfill=true` for a deep historical pull
  (`BACKFILL_DAYS` back), paced per gotcha #4 above.

## Files

```
garmin-backend/
  requirements.txt
  .env.example
  cli_login.py        one-time interactive Garmin login (run locally)
  app/
    config.py          env-driven settings
    garmin_client.py   safe() wrapper, connect/reconnect, endpoint fetching
    merge.py           field-by-field merge, HRV tagging, sleep bucketing
    db.py              SQLite persistence
    sync.py            overlap-window sync + paced backfill
    auth.py            bearer-token auth for this backend's own API
    main.py            FastAPI app, scheduler, endpoints
```
