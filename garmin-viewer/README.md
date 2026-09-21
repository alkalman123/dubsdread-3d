# Alpine Log — a mountain-athlete Garmin viewer

A phone-friendly (installable PWA) dashboard for your Garmin Connect data,
built around how climbers, mountain bikers, trail runners, mountaineers,
and ski tourers actually think about training — not Garmin's generic
running/cycling split.

It connects to **your own Garmin Connect account** (live sync, not a file
upload), and adds three things Garmin Connect doesn't have:

- **Discipline view.** Every activity is classified into Climbing, Biking,
  Trail Running, Mountaineering, Hiking, or Ski Touring, with vertical gain,
  vertical ascent rate, and time-in-discipline tracked separately.
- **A daily workout recommendation**, based on an acute:chronic training-load
  ratio (like TrainingPeaks/Strava, but weighting vertical gain as heavily as
  heart rate — important for climbers/mountaineers, whose hardest days are
  often low-HR) plus a recovery score from sleep, Body Battery, HRV, and
  resting heart rate.
- **Morning and evening briefings** — a short readiness summary and plan when
  you open the app in the morning, and a wrap-up summary in the evening.

It ships with a full **demo mode** (30-45 days of synthetic mountain-athlete
data) so you can explore everything before connecting a real account.

## Running it

```bash
cd garmin-viewer
npm install
npm start
```

Open `http://localhost:8123` — on your phone, open that same address (your
computer's LAN IP instead of `localhost`) in Safari or Chrome, then use
**Settings → Install on your phone** to add it to your home screen as an app.

By default it starts in **demo mode** — no account needed.

### Connecting your real Garmin account

Open the app → the gear icon → **Connect Garmin**, and enter your Garmin
Connect email/password. Or put them in `garmin-viewer/.env` (copy
`.env.example`) so the server logs in automatically on startup:

```
GARMIN_USERNAME=you@example.com
GARMIN_PASSWORD=yourpassword
```

**Important limitations, honestly stated:**

- Garmin Connect has no public personal-use API. This app uses the
  well-known [`garmin-connect`](https://www.npmjs.com/package/garmin-connect)
  library, which logs in the same way the Garmin Connect *website* does.
  That's how most personal Garmin dashboards/exporters work, but it's
  unofficial — Garmin could change their login flow or rate-limit an
  account that logs in too often. This app caches aggressively and reuses
  your session token (stored in `server/.data/tokens.json`, not your
  password) specifically to avoid that.
- **Accounts with MFA/2FA enabled aren't supported** by the login form —
  Garmin's login flow will reject a plain password. Either temporarily
  disable MFA on your Garmin account to connect, or ask around for a
  current token-import method for the `garmin-connect` library.
- Body Battery, HRV, and training-readiness parsing goes through Garmin's
  undocumented wellness endpoints. Field names are based on the long-running
  community reverse-engineering of these APIs and are believed current, but
  Garmin can and does change them without notice — if a metric shows `–`,
  that's the honest "couldn't parse it" state, not a made-up zero.
- Your credentials are only ever sent to this server (which you're running),
  which uses them once to sign in to `connect.garmin.com`. Nothing is sent
  anywhere else.

### Optional: nicer briefing text

Set `ANTHROPIC_API_KEY` in `.env` and the morning/evening briefings are
phrased by Claude instead of the built-in template. Everything works
without it — the template is deterministic and free.

### Background sync

If you're running with saved credentials, `SYNC_CRON` (default: every 2
hours) pre-warms the activity cache in the background so the dashboard
opens instantly. Change it in `.env` (standard cron syntax, UTC).

## What's in each screen

- **Today** — a morning briefing (before 3pm) or evening wrap-up (after),
  today's key wellness numbers, today's recommended workout, and your most
  recent activity.
- **Activities** — every activity, filterable by discipline. Tap one for a
  route map, elevation/HR charts, and discipline-specific stats (vertical
  ascent rate for climbing/mountaineering/hiking/ski).
- **Trends** — your acute:chronic training-load ratio, volume by discipline
  over the last 28 days, a daily training-load chart, and 30-day recovery
  trends (Body Battery, resting HR).
- **Plan** — today's recommendation in full, your readiness breakdown, and
  an illustrative 7-day look-ahead that re-rotates each time you open it
  based on your current recovery and which disciplines you haven't done
  in a while. It's a guide, not a fixed program.

## How the workout recommendation works

No black-box ML — the logic is in `server/trainingLoad.js` and is meant to
be readable:

1. **Training load** per activity = time in estimated heart-rate intensity,
   plus a vertical-gain term (so a 1200m mountaineering day counts as hard
   even if your HR stayed low).
2. **ACWR** (acute:chronic workload ratio) = your last 7 days' average daily
   load ÷ your last 28 days' average daily load. Above ~1.5 is flagged
   high-risk; below ~0.8, undertrained.
3. **Readiness** (0-100) compares today's sleep score, Body Battery, resting
   HR, and HRV status against *your own* trailing 2-week baseline, not a
   fixed threshold.
4. Combine both, then pick whichever discipline you haven't done in the
   longest time, and hand back one of the hand-written workout templates in
   `TEMPLATES` for that discipline at that intensity (recovery / moderate /
   hard).

Tune `TEMPLATES`, the discipline list in `server/classify.js`, or the
ACWR thresholds directly — it's all plain, commented-enough JS.

## Architecture

```
server/
  garminClient.js   Garmin Connect login/session + raw wellness endpoints
  demoData.js       synthetic 45-day mountain-athlete dataset
  classify.js       activity type -> discipline, aggregation
  normalize.js      defensive parsing of Garmin's undocumented payloads
  trainingLoad.js   training load, ACWR, readiness, workout recommendation
  briefing.js       morning/evening briefing text (template + optional Claude)
  dataCache.js      TTL cache with stale-on-error fallback (protects your
                    Garmin account from being hammered)
  routes.js         the whole REST API
  index.js          Express app + startup + cron
public/
  index.html, css/, js/    the PWA frontend (vanilla JS, no build step)
  vendor/                  Leaflet + Chart.js, vendored (not CDN) so the
                            app works offline and behind restrictive networks
  manifest.webmanifest, service-worker.js, icons/   installable PWA bits
```

No build step, no framework, no bundler — same philosophy as the course
preview app this folder sits next to.
