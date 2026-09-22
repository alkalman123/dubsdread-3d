# Alpine Log — a bike/run/climb training viewer

A phone-friendly (installable PWA) training dashboard built around how a
Chicago athlete who bikes, runs, and climbs actually thinks about
training — not Garmin's generic activity split, and not a mountain-athlete
framing that doesn't fit a flat city with an indoor gym for climbing.

It pulls from two places, either or both:

- **Your own Garmin Connect account** (live sync — see below).
- **An imported health-data export** — a `data.json` or self-contained
  `Health-Dashboard.html` from an external multi-year, multi-source pipeline
  (Apple Health + Garmin + a smart scale, say). See **Importing your own
  data** below. This is what makes the "same data, more detail" experience
  possible: years of history, body composition, and pre-written insights
  that a fresh Garmin Connect API connection alone can't give you.

On top of whichever data you feed it, it adds:

- **Discipline view**, weighted toward Climbing, Biking, and Running (with
  Strength, Hiking, Walking, and anything else your history contains still
  tracked and shown, just not central to the daily recommendation).
- **A daily workout recommendation** for climbing (gym-focused: bouldering,
  ARC training, projecting, hangboard), biking (Lakefront Trail / indoor
  trainer), and running (Lakefront Path intervals/tempo) — based on an
  acute:chronic training-load ratio (like TrainingPeaks/Strava) plus a
  recovery score from sleep, Body Battery, HRV, and resting heart rate.
- **A training scorecard and verdict** — four transparent components
  (aerobic base, climbing volume, consistency, recovery) averaged into one
  number, plus a plain-language verdict that names whichever component is
  weakest rather than letting a high average hide a real problem.
- **Body composition** (Body tab) — segmental lean mass, composition bands,
  weight trend — when your import or Garmin data includes it.
- **Morning and evening briefings** — a short readiness summary and plan
  when you open the app in the morning, a wrap-up in the evening.
- **Manually-logged activities** (Activities → "+ Log") for sessions your
  watch missed, so the planner isn't limited to what got auto-synced.

It ships with a full **demo mode** (45 days of synthetic sample data,
including a demo body-composition scan) so you can explore everything
before connecting a real account or importing anything. Demo mode always
shows the synthetic data, even after you've imported your own — Auto and
Live are what use your real data.

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

## Deploying to Render (so it's on your phone as a real installed app)

This repo includes a `render.yaml` Blueprint at the repo root, so deploy is:

1. Push this repo to GitHub (already done if you're reading this from the repo).
2. On [render.com](https://render.com), sign up/log in (GitHub login is easiest).
3. **New +** → **Blueprint** → pick this repo → Render reads `render.yaml`
   and proposes one service, `alpine-log-garmin-viewer`, rooted at `garmin-viewer/`.
4. Click **Apply**. It'll deploy on the **free** plan by default.
5. In the new service's **Environment** tab, optionally set `GARMIN_USERNAME`
   / `GARMIN_PASSWORD` to your real Garmin Connect login — the app logs in
   automatically on every boot when these are set. Leave them unset to run
   in demo mode.
6. Once deployed, Render gives you a URL like
   `https://alpine-log-garmin-viewer.onrender.com` — open it on your phone
   and **Add to Home Screen**.

**Free plan tradeoffs:** the service spins down after 15 minutes idle, so
opening the app after a gap takes ~30-50s to wake up, and its disk resets on
each restart — which is why setting `GARMIN_USERNAME`/`GARMIN_PASSWORD` as
environment variables (rather than only logging in through the in-app form)
matters here: the app re-logs-in automatically every time it wakes up,
instead of you having to. If the wake-up delay bothers you, switch the
service's plan to **Starter** ($7/mo) in the Render dashboard — same
deploy, just always-on.

### Importing your own data

If you have (or build) a pipeline that exports a `window.__HEALTH_DATA__`
JSON blob — daily wellness rows (`days[]`) and workouts (`workouts[]`), plus
optionally `body` (composition) and `insights` (pre-written text) — you can
feed it straight in: **Settings → Import health data → choose file**. It
accepts either the raw `data.json` or a full self-contained HTML page with
that blob embedded in a `<script>` tag (i.e. you can literally upload the
dashboard file your pipeline generates).

Once imported, that dataset becomes your activity/wellness history up
through its own last recorded day; a live Garmin connection (or demo data,
if you're in Auto/Live with no Garmin connected) only fills in what's
happened *since* that day. Re-importing an updated export — after your
pipeline's next daily sync, say — is how the covered history grows over
time. Nothing about this import is automatic or scheduled: this app doesn't
reach out to wherever that pipeline runs, so re-importing is a manual step.

The expected shape per day/workout (all fields optional except `d`):

```
days[]:     { d, steps, rhr, hrv, sleep, sleepScore, bbHigh, bbLow, stress, ready }
workouts[]: { d, t (activity type key), start, min, km, kcal, hr, maxHr, up (elevation gain m), name }
body:       { source, date, segmental: {...}, composition: {...}, weight_lbs, history: [...] }
insights:   [{ severity: warn|good|info, title, body, metric }]
```

Unrecognized/extra fields are ignored, so this works fine with a partial
export too — missing fields just show as `–` rather than a guess.

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

- **Today** — insight cards (from your import, or generated from recent
  wellness if you don't have one), a morning briefing (before 3pm) or
  evening wrap-up (after), today's key wellness numbers, today's recommended
  workout, and your most recent activity.
- **Activities** — every activity, filterable by discipline, plus **+ Log**
  to manually add a session. Tap one for a route map (when GPS data exists),
  elevation/HR charts, and discipline-specific stats.
- **Trends** — your training scorecard (four components + verdict), the
  acute:chronic training-load ratio, volume by discipline, a daily
  training-load chart, and recovery trends (Body Battery, resting HR).
- **Body** — segmental lean mass, composition bands (body fat, lean mass,
  visceral fat, water, BMR, metabolic age), and a body-fat trend, when your
  import or Garmin data includes body composition. Empty until you import
  data with a `body` section (or in demo mode).
- **Plan** — today's recommendation in full, your readiness breakdown, and
  an illustrative 7-day look-ahead that re-rotates each time you open it
  based on your current recovery and which disciplines you haven't done
  in a while. It's a guide, not a fixed program.

## How the workout recommendation works

No black-box ML — the logic is in `server/trainingLoad.js` and is meant to
be readable:

1. **Training load** per activity = time in estimated heart-rate intensity,
   plus a small vertical-gain term (mostly a no-op on flat Chicago
   rides/runs and indoor climbing, but harmless if you ever log something
   with real elevation).
2. **ACWR** (acute:chronic workload ratio) = your last 7 days' average daily
   load ÷ your last 28 days' average daily load. Above ~1.5 is flagged
   high-risk; below ~0.8, undertrained.
3. **Readiness** (0-100) uses Garmin's own device-computed Training
   Readiness score when your data has one (imported or live), else compares
   today's sleep score, Body Battery, resting HR, and HRV status against
   *your own* trailing 2-week baseline rather than a fixed threshold.
4. Combine both, then pick whichever of **climbing / biking / running /
   strength** you haven't done in the longest time, and hand back one of the
   hand-written workout templates in `TEMPLATES` for that discipline at that
   intensity (recovery / moderate / hard).

The **training scorecard** (`server/scorecard.js`) is a separate, simpler
transparency tool: four components (aerobic base, climbing volume,
consistency, recovery), each capped at 100 and averaged, with an ACWR
penalty if load is spiking. The **verdict** text always names the weakest
component rather than letting a high average hide a real gap.

Tune `TEMPLATES`/`DISCIPLINE_PRIORITY` in `trainingLoad.js`, the weekly
targets in `scorecard.js`, or the discipline list in `classify.js` directly
— it's all plain, commented-enough JS.

## Architecture

```
server/
  garminClient.js     Garmin Connect login/session + raw wellness endpoints
  healthImport.js     parses/stores an imported data.json or dashboard HTML
  importAdapter.js    maps imported days[]/workouts[] to this app's shapes
  manualActivities.js manually-logged activities ("+ Log" in Activities)
  demoData.js         synthetic 45-day sample dataset + demo body scan
  classify.js         activity type -> discipline, aggregation
  normalize.js        defensive parsing of Garmin's undocumented payloads
  trainingLoad.js     training load, ACWR, readiness, workout recommendation
  scorecard.js        4-component training score + verdict text
  insightsFallback.js generates insight cards when there's no import
  briefing.js         morning/evening briefing text (template + optional Claude)
  dataCache.js        TTL cache with stale-on-error fallback (protects your
                      Garmin account from being hammered)
  routes.js           the whole REST API
  index.js            Express app + startup + cron
public/
  index.html, css/, js/    the PWA frontend (vanilla JS, no build step)
  vendor/                  Leaflet + Chart.js, vendored (not CDN) so the
                            app works offline and behind restrictive networks
  manifest.webmanifest, service-worker.js, icons/   installable PWA bits
```

No build step, no framework, no bundler — same philosophy as the course
preview app this folder sits next to.
