// Maps Garmin's activityType.typeKey onto the disciplines a mountain
// athlete actually thinks in, since Garmin's own grouping (running /
// cycling / fitness equipment / ...) buries climbing and mountaineering
// under generic buckets.

// Colors match the palette of the source health-data pipeline (paper/ink/
// orange editorial system) so imported history reads consistently with
// wherever else this athlete looks at the same data.
const DISCIPLINES = {
  climbing: { label: 'Climbing', icon: '🧗', color: '#e8622c' },
  biking: { label: 'Biking', icon: '🚴', color: '#4a90c2' },
  running: { label: 'Running', icon: '🏃', color: '#d4614f' },
  mountaineering: { label: 'Mountaineering', icon: '⛰️', color: '#8b5e83' },
  hiking: { label: 'Hiking', icon: '🥾', color: '#5b8c5a' },
  ski: { label: 'Ski Touring', icon: '⛷️', color: '#9adfff' },
  slacklining: { label: 'Slacklining', icon: '🤸', color: '#c25b9e' },
  water: { label: 'Water', icon: '🏊', color: '#5aa9d6' },
  strength: { label: 'Strength', icon: '🏋️', color: '#c9a86a' },
  walking: { label: 'Walking', icon: '🚶', color: '#a8b2ba' },
  cardio: { label: 'Cardio', icon: '❤️', color: '#6aa89b' },
  other: { label: 'Other', icon: '📍', color: '#a0a6b0' },
};

// Activity types that aren't real training sessions and should never reach
// the app (Apple Watch fall/crash "workouts" from incident detection, etc.).
const IGNORED_TYPE_KEYS = /^incident_detected$/;

const RULES = [
  [/boulder|rock_climbing|via_ferrata|indoor_climbing|climbing/, 'climbing'],
  [/mountaineering|ice_climbing|alpine/, 'mountaineering'],
  [/mountain_biking|enduro_mtb|downhill|e_bike_mountain/, 'biking'],
  [/gravel|cyclocross|road_biking|cycl|biking|virtual_ride|track_cycling/, 'biking'],
  [/trail_run|ultra_run/, 'running'],
  [/run/, 'running'],
  [/backcountry_ski|ski_touring|skate_ski|cross_country_ski|resort_skiing|snowboard/, 'ski'],
  [/slacklin|highlin|tricklin/, 'slacklining'],
  [/hik/, 'hiking'],
  [/^walk/, 'walking'],
  [/kayak|canoe|row|paddle|swim|surf/, 'water'],
  [/^cardio$/, 'cardio'],
  [/strength|fitness_equipment|indoor_cardio|yoga|pilates|hangboard/, 'strength'],
];

function classify(typeKey = '') {
  const key = String(typeKey).toLowerCase();
  for (const [re, discipline] of RULES) {
    if (re.test(key)) return discipline;
  }
  return 'other';
}

function disciplineMeta(discipline) {
  return DISCIPLINES[discipline] || DISCIPLINES.other;
}

// Normalizes an IActivity (live or demo shape) into the fields the rest of
// the app needs, tagging it with a discipline.
function normalizeActivity(raw) {
  const typeKey = raw.activityType && raw.activityType.typeKey;
  const discipline = classify(typeKey);
  const meta = disciplineMeta(discipline);
  const distanceKm = (raw.distance || 0) / 1000;
  const durationMin = (raw.duration || 0) / 60;
  return {
    id: raw.activityId,
    name: raw.activityName || meta.label,
    typeKey,
    discipline,
    disciplineLabel: meta.label,
    icon: meta.icon,
    color: meta.color,
    startTime: raw.startTimeLocal,
    distanceKm: Number(distanceKm.toFixed(2)),
    durationMin: Number(durationMin.toFixed(1)),
    elevationGainM: Math.round(raw.elevationGain || 0),
    elevationLossM: Math.round(raw.elevationLoss || 0),
    avgHR: raw.averageHR || null,
    maxHR: raw.maxHR || null,
    calories: raw.calories || null,
    avgSpeedKmh: raw.averageSpeed ? Number((raw.averageSpeed * 3.6).toFixed(2)) : null,
    startLat: raw.startLatitude || null,
    startLon: raw.startLongitude || null,
    minElevationM: raw.minElevation != null ? Math.round(raw.minElevation) : null,
    maxElevationM: raw.maxElevation != null ? Math.round(raw.maxElevation) : null,
    vam: durationMin > 0 ? Math.round(((raw.elevationGain || 0) / (durationMin / 60)) || 0) : 0,
    _demo: raw._demo || null,
  };
}

function summarizeByDiscipline(activities, windowDays) {
  const cutoff = windowDays ? Date.now() - windowDays * 86400000 : 0;
  const groups = {};
  for (const a of activities) {
    if (windowDays && new Date(a.startTime).getTime() < cutoff) continue;
    if (!groups[a.discipline]) {
      groups[a.discipline] = {
        discipline: a.discipline,
        label: a.disciplineLabel,
        icon: a.icon,
        color: a.color,
        count: 0,
        distanceKm: 0,
        durationMin: 0,
        elevationGainM: 0,
      };
    }
    const g = groups[a.discipline];
    g.count += 1;
    g.distanceKm += a.distanceKm;
    g.durationMin += a.durationMin;
    g.elevationGainM += a.elevationGainM;
  }
  return Object.values(groups)
    .map((g) => ({
      ...g,
      distanceKm: Number(g.distanceKm.toFixed(1)),
      durationMin: Math.round(g.durationMin),
      elevationGainM: Math.round(g.elevationGainM),
    }))
    .sort((a, b) => b.durationMin - a.durationMin);
}

module.exports = { classify, disciplineMeta, normalizeActivity, summarizeByDiscipline, DISCIPLINES, IGNORED_TYPE_KEYS };
