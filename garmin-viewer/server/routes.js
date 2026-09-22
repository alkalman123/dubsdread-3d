const express = require('express');
const demoData = require('./demoData');
const cache = require('./dataCache');
const { toDateString } = require('./garminClient');
const { normalizeActivity, summarizeByDiscipline, disciplineMeta } = require('./classify');
const { normalizeWellnessDay, extractStreams, extractTrack } = require('./normalize');
const { computeACWR, computeReadiness, recommendWorkout, activityLoad } = require('./trainingLoad');
const { buildMorningBriefing, buildEveningBriefing } = require('./briefing');
const healthImport = require('./healthImport');
const { importedActivities, importedWellnessDays } = require('./importAdapter');
const manualActivities = require('./manualActivities');
const { computeScorecard, computeVerdict } = require('./scorecard');
const { generateInsights } = require('./insightsFallback');

const MANUAL_ID_MIN = 800000000;
const IMPORT_ID_MIN = 900000000;

function emptyStreams() {
  return { timeSec: [], hr: [], elevation: [], speedKmh: [], distanceKm: [] };
}

// The garmin-connect library's own errors are the only diagnostic signal
// we get back — it has no typed exceptions, just Error messages baked into
// its login-flow HTML scraping. Its "MFA" handling is a literal no-op
// (see node_modules/garmin-connect/dist/common/HttpClient.js), so an
// MFA-enabled account produces a message that reads exactly like a wrong
// password even though the credentials are fine — worth calling out
// explicitly rather than telling someone with correct credentials to
// re-check them.
function classifyGarminLoginError(err) {
  const msg = String(err && err.message || err || '');
  if (/AccountLocked/i.test(msg)) {
    return "Garmin says this account is locked. Open connect.garmin.com in a normal browser, log in there to unlock it, then try again here.";
  }
  if (/Ticket not found or MFA/i.test(msg)) {
    return "Garmin rejected this login. The underlying library can't tell apart two different causes here, so it's one of: (1) MFA/2FA is enabled on this account — this app's login form can't complete a second-factor challenge, or (2) the password itself was rejected (a recent reset, or hidden whitespace from copy-pasting can cause this even when it looks right). Try typing the password manually instead of pasting it; if it still fails, MFA is the likely cause — temporarily disable it on your Garmin account to connect here, or use the health-data import feature instead.";
  }
  if (/Update Phone number/i.test(msg)) {
    return "Garmin is asking this account to confirm a phone number before allowing login. Do that at connect.garmin.com, then try again here.";
  }
  if (/csrf not found/i.test(msg)) {
    return "Garmin's login page didn't return what this app expected — Garmin likely changed something on their end. Try again in a few minutes.";
  }
  return `Garmin login failed: ${msg || 'unknown error'}. Double-check the email/password, and see the server logs for the raw error if this persists.`;
}

function createRouter(garminClient) {
  const router = express.Router();
  let modePreference = 'auto'; // 'auto' | 'demo' | 'live'

  function effectiveMode() {
    if (modePreference === 'demo') return 'demo';
    if (modePreference === 'live') return garminClient.authenticated ? 'live' : 'demo';
    return garminClient.authenticated ? 'live' : 'demo';
  }

  // An explicit "demo" choice means "show me the synthetic showcase data",
  // full stop — a real import shouldn't leak through just because it
  // happens to be cached. Import data only feeds Auto/Live (including
  // Auto's fallback-to-demo when there's no live Garmin session).
  function currentImportData() {
    return modePreference === 'demo' ? null : healthImport.loadImport();
  }

  // Imported history supplies everything up through its own last day;
  // live/demo sync only fills the gap since then, so re-importing an
  // updated export is how the dataset's coverage grows over time.
  async function loadActivities() {
    const mode = effectiveMode();
    const importData = currentImportData();
    const importCutoff = importData?.meta?.last ? new Date(`${importData.meta.last}T23:59:59`).getTime() : null;

    let raw;
    if (mode === 'demo') {
      // Fictional demo activities have nothing to do with a real import —
      // never let them pose as "what's happened since the last import".
      raw = importData ? [] : demoData.ACTIVITIES;
    } else {
      await garminClient.ensureAuth();
      raw = await cache.remember('activities:live', 15 * 60 * 1000, () => garminClient.getActivities(80));
    }
    const freshRaw = importCutoff ? raw.filter((a) => new Date(a.startTimeLocal).getTime() > importCutoff) : raw;

    const combined = [...manualActivities.listManualActivities(), ...freshRaw, ...importedActivities(importData)];
    const activities = combined
      .map(normalizeActivity)
      .sort((a, b) => new Date(b.startTime) - new Date(a.startTime));

    return { mode, activities, hasImport: Boolean(importData) };
  }

  async function loadWellness(days) {
    const mode = effectiveMode();
    const importData = currentImportData();
    const importCutoff = importData?.meta?.last || null;

    let liveOrDemo;
    if (mode === 'demo') {
      liveOrDemo = importData ? [] : demoData.WELLNESS.slice(-days);
    } else {
      await garminClient.ensureAuth();
      const capped = Math.min(days, 30);
      const dates = Array.from({ length: capped }, (_, i) => new Date(Date.now() - (capped - 1 - i) * 86400000));
      const today = toDateString(new Date());
      const results = await Promise.all(
        dates.map((d) => {
          const ds = toDateString(d);
          const ttl = ds === today ? 15 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
          return cache.remember(`wellness:${ds}`, ttl, () => garminClient.getDailyWellness(d));
        })
      );
      liveOrDemo = results.map((r, i) => normalizeWellnessDay(toDateString(dates[i]), r));
    }

    let wellness;
    if (importData) {
      const importedDays = importedWellnessDays(importData).filter((d) => !importCutoff || d.date <= importCutoff);
      const freshLiveOrDemo = liveOrDemo.filter((d) => !importCutoff || d.date > importCutoff);
      wellness = [...importedDays, ...freshLiveOrDemo].slice(-days);
    } else {
      wellness = liveOrDemo;
    }
    return { mode, wellness, hasImport: Boolean(importData) };
  }

  function loadBody(mode, importData) {
    if (importData?.body) return importData.body;
    if (mode === 'demo') return demoData.BODY;
    return null;
  }

  function loadInsights(importData, wellness) {
    if (importData?.insights?.length) return importData.insights;
    return generateInsights(wellness);
  }

  // Shared context for every "how am I doing" screen: activities, a wide
  // wellness window, the plan, the scorecard/verdict, and insights — built
  // once per request so they're all consistent with each other.
  async function loadDashboardContext() {
    const { mode, activities } = await loadActivities();
    const { wellness } = await loadWellness(90);
    const importData = currentImportData();
    const plan = recommendWorkout(activities, wellness);
    const meta = disciplineMeta(plan.discipline);
    const insights = loadInsights(importData, wellness);
    const scorecard = computeScorecard(activities, wellness, plan.acwr.ratio, 90);
    const verdict = computeVerdict(scorecard, insights);
    return {
      mode,
      activities,
      wellness,
      importData,
      insights,
      scorecard,
      verdict,
      plan: { ...plan, disciplineLabel: meta.label, icon: meta.icon, color: meta.color },
    };
  }

  router.get('/status', async (req, res) => {
    await garminClient.ensureAuth().catch(() => {});
    const importData = healthImport.loadImport();
    res.json({
      mode: effectiveMode(),
      modePreference,
      authenticated: garminClient.authenticated,
      hasSavedSession: garminClient.hasSavedSession(),
      import: healthImport.importSummary(importData),
    });
  });

  router.post('/mode', (req, res) => {
    const { mode } = req.body || {};
    if (!['auto', 'demo', 'live'].includes(mode)) return res.status(400).json({ error: 'mode must be auto|demo|live' });
    modePreference = mode;
    res.json({ ok: true, mode: effectiveMode(), modePreference });
  });

  router.post('/auth/login', async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ ok: false, error: 'username and password required' });
    try {
      await garminClient.login(username, password);
      modePreference = 'auto';
      res.json({ ok: true, mode: effectiveMode() });
    } catch (err) {
      res.status(401).json({ ok: false, error: classifyGarminLoginError(err) });
    }
  });

  router.post('/auth/logout', (req, res) => {
    garminClient.logout();
    cache.invalidate('activities');
    cache.invalidate('wellness');
    res.json({ ok: true, mode: effectiveMode() });
  });

  // ---- health data import --------------------------------------------

  router.get('/import/health', (req, res) => {
    res.json({ import: healthImport.importSummary(healthImport.loadImport()) });
  });

  router.post('/import/health', (req, res) => {
    const raw = typeof req.body === 'string' ? req.body : req.body?.raw;
    if (!raw) return res.status(400).json({ ok: false, error: 'No file content received' });
    try {
      const data = healthImport.parseImportPayload(raw);
      healthImport.saveImport(data);
      cache.invalidate('activities');
      cache.invalidate('wellness');
      res.json({ ok: true, import: healthImport.importSummary(data) });
    } catch (err) {
      res.status(400).json({ ok: false, error: String(err.message || err) });
    }
  });

  router.delete('/import/health', (req, res) => {
    healthImport.clearImport();
    cache.invalidate('activities');
    cache.invalidate('wellness');
    res.json({ ok: true });
  });

  // ---- manually-logged activities --------------------------------------

  router.get('/activities/manual', (req, res) => {
    res.json({ activities: manualActivities.listManualActivities().map(normalizeActivity) });
  });

  router.post('/activities/manual', (req, res) => {
    try {
      const raw = manualActivities.addManualActivity(req.body || {});
      res.json({ ok: true, activity: normalizeActivity(raw) });
    } catch (err) {
      res.status(400).json({ ok: false, error: String(err.message || err) });
    }
  });

  router.delete('/activities/manual/:id', (req, res) => {
    manualActivities.removeManualActivity(req.params.id);
    res.json({ ok: true });
  });

  // ---- activities -------------------------------------------------------

  router.get('/activities', async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 40, 500);
      const { mode, activities } = await loadActivities();
      const list = activities.slice(0, limit).map(({ _demo, ...rest }) => rest);
      res.json({ mode, activities: list });
    } catch (err) {
      res.status(502).json({ error: 'Could not load activities', detail: String(err.message || err) });
    }
  });

  router.get('/activities/:id', async (req, res) => {
    const id = Number(req.params.id);
    const mode = effectiveMode();
    try {
      if (id >= MANUAL_ID_MIN && id < IMPORT_ID_MIN) {
        const raw = manualActivities.listManualActivities().find((a) => a.activityId === id);
        if (!raw) return res.status(404).json({ error: 'not found' });
        return res.json({ mode, activity: normalizeActivity(raw), track: [], streams: emptyStreams(), splits: null });
      }
      if (id >= IMPORT_ID_MIN) {
        const raw = importedActivities(currentImportData()).find((a) => a.activityId === id);
        if (!raw) return res.status(404).json({ error: 'not found' });
        return res.json({ mode, activity: normalizeActivity(raw), track: [], streams: emptyStreams(), splits: null });
      }
      if (mode === 'demo') {
        const raw = demoData.ACTIVITIES.find((a) => a.activityId === id);
        if (!raw) return res.status(404).json({ error: 'not found' });
        const activity = normalizeActivity(raw);
        const s = raw._demo.streams;
        const streams = {
          timeSec: s.timeMin.map((m) => Math.round(m * 60)),
          hr: s.hr,
          elevation: s.elevation,
          speedKmh: s.pace.map((p) => Number((60 / p).toFixed(1))),
          distanceKm: null,
        };
        return res.json({ mode, activity: { ...activity, _demo: undefined }, track: raw._demo.track, streams, splits: null });
      }
      await garminClient.ensureAuth();
      const detail = await cache.remember(`activity:${id}`, 60 * 60 * 1000, () => garminClient.getActivityDetail(id));
      const activity = normalizeActivity(detail.summary);
      const track = extractTrack(detail.details, activity);
      const streams = extractStreams(detail.details);
      res.json({ mode, activity, track, streams, splits: detail.splits, typedSplits: detail.typedSplits });
    } catch (err) {
      res.status(502).json({ error: 'Could not load activity', detail: String(err.message || err) });
    }
  });

  router.get('/wellness', async (req, res) => {
    try {
      const days = Math.min(Number(req.query.days) || 30, 3650);
      const { mode, wellness } = await loadWellness(days);
      res.json({ mode, wellness });
    } catch (err) {
      res.status(502).json({ error: 'Could not load wellness data', detail: String(err.message || err) });
    }
  });

  router.get('/body', async (req, res) => {
    try {
      const mode = effectiveMode();
      const importData = currentImportData();
      res.json({ mode, body: loadBody(mode, importData) });
    } catch (err) {
      res.status(502).json({ error: 'Could not load body composition', detail: String(err.message || err) });
    }
  });

  router.get('/insights', async (req, res) => {
    try {
      const { mode, wellness } = await loadWellness(30);
      const importData = currentImportData();
      res.json({ mode, insights: loadInsights(importData, wellness) });
    } catch (err) {
      res.status(502).json({ error: 'Could not build insights', detail: String(err.message || err) });
    }
  });

  router.get('/scorecard', async (req, res) => {
    try {
      const { mode, scorecard, verdict } = await loadDashboardContext();
      res.json({ mode, scorecard, verdict });
    } catch (err) {
      res.status(502).json({ error: 'Could not build scorecard', detail: String(err.message || err) });
    }
  });

  router.get('/summary', async (req, res) => {
    try {
      const { mode, activities } = await loadActivities();
      res.json({
        mode,
        byDiscipline7: summarizeByDiscipline(activities, 7),
        byDiscipline28: summarizeByDiscipline(activities, 28),
        acwr: computeACWR(activities),
        recentLoad: activities.slice(0, 60).map((a) => ({
          date: a.startTime,
          discipline: a.discipline,
          load: activityLoad(a),
        })),
      });
    } catch (err) {
      res.status(502).json({ error: 'Could not build summary', detail: String(err.message || err) });
    }
  });

  router.get('/plan/today', async (req, res) => {
    try {
      const { mode, plan } = await loadDashboardContext();
      res.json({ mode, plan });
    } catch (err) {
      res.status(502).json({ error: 'Could not build a plan', detail: String(err.message || err) });
    }
  });

  router.get('/briefing/morning', async (req, res) => {
    try {
      const { mode, activities, wellness, plan } = await loadDashboardContext();
      const readiness = computeReadiness(wellness);
      const yesterdayCutoff = Date.now() - 36 * 3600 * 1000;
      const yesterday = activities.find((a) => new Date(a.startTime).getTime() >= yesterdayCutoff);
      const text = await buildMorningBriefing({ readiness, acwr: plan.acwr, plan, yesterday });
      res.json({ mode, text, readiness, plan });
    } catch (err) {
      res.status(502).json({ error: 'Could not build morning briefing', detail: String(err.message || err) });
    }
  });

  router.get('/briefing/evening', async (req, res) => {
    try {
      const { mode, activities, wellness } = await loadDashboardContext();
      const today = toDateString(new Date());
      const todayActivities = activities.filter((a) => toDateString(new Date(a.startTime)) === today);
      const totalLoad = todayActivities.reduce((s, a) => s + activityLoad(a), 0);
      const readiness = computeReadiness(wellness);
      const text = await buildEveningBriefing({ todayActivities, totalLoad, readiness });
      res.json({ mode, text, todayActivities, totalLoad });
    } catch (err) {
      res.status(502).json({ error: 'Could not build evening briefing', detail: String(err.message || err) });
    }
  });

  return router;
}

module.exports = { createRouter };
