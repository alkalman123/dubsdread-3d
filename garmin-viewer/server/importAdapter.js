// Converts the imported health-data shape into the internal shapes the rest
// of the app already understands (the same "raw activity" and "wellness
// day" shapes used for live Garmin Connect / demo data), so downstream code
// (classify, trainingLoad, routes) doesn't need to know where data came from.

const { IGNORED_TYPE_KEYS } = require('./classify');

// Large, fixed offset so imported activity ids never collide with demo ids
// (900000-900999) or real Garmin activity ids.
const ID_BASE = 900000000;

function importedActivities(importData) {
  if (!importData || !Array.isArray(importData.workouts)) return [];
  return importData.workouts
    .filter((w) => w.t && !IGNORED_TYPE_KEYS.test(w.t))
    .map((w, i) => ({
      activityId: ID_BASE + i,
      activityName: w.name || null,
      activityType: { typeKey: w.t },
      startTimeLocal: w.start ? w.start.replace(' ', 'T') : `${w.d}T12:00:00`,
      distance: (w.km || 0) * 1000,
      duration: (w.min || 0) * 60,
      elevationGain: w.up || 0,
      elevationLoss: 0,
      averageHR: w.hr || null,
      maxHR: w.maxHr || null,
      calories: w.kcal || null,
      averageSpeed: w.km && w.min ? (w.km * 1000) / (w.min * 60) : 0,
      startLatitude: null,
      startLongitude: null,
      minElevation: null,
      maxElevation: null,
      _importSource: w.src || null,
      _importLoad: w.load ?? null,
    }));
}

// Imported days[] are already flat (unlike Garmin's nested wellness
// payloads), and carry a couple of fields live sync doesn't have:
// `readinessScore` (Garmin's own 0-100 training readiness, when known) and
// `precomputedLoad`/`precomputedAcwr` from the source pipeline's own
// training-load model — used for historical trend charts so they match
// what the athlete already sees elsewhere, without pretending our own
// day-by-day ACWR recompute is more authoritative than data Garmin itself
// already scored.
function importedWellnessDays(importData) {
  if (!importData || !Array.isArray(importData.days)) return [];
  return importData.days.map((d) => ({
    date: d.d,
    steps: d.steps ?? null,
    sleepHours: d.sleep ?? null,
    sleepScore: d.sleepScore ?? null,
    bodyBatteryHigh: d.bbHigh ?? null,
    bodyBatteryLow: d.bbLow ?? null,
    restingHR: d.rhr ?? null,
    hrvStatus: null,
    hrvMs: d.hrv ?? null,
    stressAvg: d.stress ?? null,
    readinessScore: d.ready ?? null,
    precomputedLoad: d.load ?? null,
    precomputedAcwr: d.acwr ?? null,
  }));
}

module.exports = { importedActivities, importedWellnessDays, ID_BASE };
