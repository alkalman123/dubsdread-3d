const express = require('express');
const demoData = require('./demoData');
const cache = require('./dataCache');
const { toDateString } = require('./garminClient');
const { normalizeActivity, summarizeByDiscipline, disciplineMeta } = require('./classify');
const { normalizeWellnessDay, extractStreams, extractTrack } = require('./normalize');
const { computeACWR, computeReadiness, recommendWorkout, activityLoad } = require('./trainingLoad');
const { buildMorningBriefing, buildEveningBriefing } = require('./briefing');

function createRouter(garminClient) {
  const router = express.Router();
  let modePreference = 'auto'; // 'auto' | 'demo' | 'live'

  function effectiveMode() {
    if (modePreference === 'demo') return 'demo';
    if (modePreference === 'live') return garminClient.authenticated ? 'live' : 'demo';
    return garminClient.authenticated ? 'live' : 'demo';
  }

  async function loadActivities() {
    const mode = effectiveMode();
    let raw;
    if (mode === 'demo') {
      raw = demoData.ACTIVITIES;
    } else {
      await garminClient.ensureAuth();
      raw = await cache.remember('activities:live', 15 * 60 * 1000, () => garminClient.getActivities(80));
    }
    return { mode, activities: raw.map(normalizeActivity) };
  }

  async function loadWellness(days) {
    const mode = effectiveMode();
    if (mode === 'demo') {
      return { mode, wellness: demoData.WELLNESS.slice(-days) };
    }
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
    return { mode, wellness: results.map((r, i) => normalizeWellnessDay(toDateString(dates[i]), r)) };
  }

  async function buildPlanContext() {
    const { mode, activities } = await loadActivities();
    const { wellness } = await loadWellness(30);
    const plan = recommendWorkout(activities, wellness);
    const meta = disciplineMeta(plan.discipline);
    return { mode, activities, wellness, plan: { ...plan, disciplineLabel: meta.label, icon: meta.icon, color: meta.color } };
  }

  router.get('/status', async (req, res) => {
    await garminClient.ensureAuth().catch(() => {});
    res.json({
      mode: effectiveMode(),
      modePreference,
      authenticated: garminClient.authenticated,
      hasSavedSession: garminClient.hasSavedSession(),
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
      res.status(401).json({ ok: false, error: 'Garmin login failed. Check your credentials (and check for an MFA prompt in Garmin Connect).' });
    }
  });

  router.post('/auth/logout', (req, res) => {
    garminClient.logout();
    cache.invalidate('activities');
    cache.invalidate('wellness');
    res.json({ ok: true, mode: effectiveMode() });
  });

  router.get('/activities', async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 40, 200);
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
      const days = Math.min(Number(req.query.days) || 30, 45);
      const { mode, wellness } = await loadWellness(days);
      res.json({ mode, wellness });
    } catch (err) {
      res.status(502).json({ error: 'Could not load wellness data', detail: String(err.message || err) });
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
        recentLoad: activities.slice(0, 30).map((a) => ({
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
      const { mode, plan } = await buildPlanContext();
      res.json({ mode, plan });
    } catch (err) {
      res.status(502).json({ error: 'Could not build a plan', detail: String(err.message || err) });
    }
  });

  router.get('/briefing/morning', async (req, res) => {
    try {
      const { mode, activities, wellness, plan } = await buildPlanContext();
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
      const { mode, activities, wellness } = await buildPlanContext();
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
