// Rule-based training-load and recovery engine. No external ML/AI here —
// just the same acute:chronic workload ratio (ACWR) and readiness
// heuristics that training-load tools like TrainingPeaks/Strava use,
// tuned for a Chicago athlete whose three sports are biking, running, and
// gym climbing (the vertical-gain term below matters far less here than it
// would for a mountain athlete, but is harmless — it's simply ~0 on flat
// lakefront rides/runs and indoor climbing).

const MAX_HR_ESTIMATE = 187;

function activityLoad(activity) {
  const hrIntensity = activity.avgHR
    ? clamp((activity.avgHR - 95) / (MAX_HR_ESTIMATE - 95), 0.15, 1.35)
    : 0.55;
  const durationLoad = activity.durationMin * hrIntensity;
  const verticalLoad = (activity.elevationGainM || 0) / 30;
  return Math.round(durationLoad + verticalLoad * 0.6);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function sumLoad(activities, sinceDaysAgo) {
  const cutoff = Date.now() - sinceDaysAgo * 86400000;
  return activities
    .filter((a) => new Date(a.startTime).getTime() >= cutoff)
    .reduce((sum, a) => sum + activityLoad(a), 0);
}

function computeACWR(activities) {
  const acute = sumLoad(activities, 7) / 7;
  const chronic = sumLoad(activities, 28) / 28;
  const ratio = chronic > 0 ? acute / chronic : acute > 0 ? 1.6 : 1;
  let status = 'sweet-spot';
  if (ratio > 1.5) status = 'high-risk';
  else if (ratio > 1.3) status = 'monitor';
  else if (ratio < 0.8) status = 'undertrained';
  return {
    acute7d: Math.round(acute * 7),
    chronic28dAvgDaily: Math.round(chronic),
    ratio: Number(ratio.toFixed(2)),
    status,
  };
}

function mean(xs) {
  const v = xs.filter((x) => x !== null && x !== undefined && !Number.isNaN(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

// 0-100 readiness score from the most recent wellness day, relative to the
// trailing baseline (so "low sleep for you" matters more than an absolute
// threshold that ignores your normal sleep needs). When the source already
// carries a device-computed readiness score (Garmin's own Training
// Readiness, passed through on imported/live wellness days), that's used
// directly rather than re-deriving a weaker estimate from its inputs.
function computeReadiness(wellnessDays) {
  if (!wellnessDays.length) return { score: 60, factors: {} };
  const today = wellnessDays[wellnessDays.length - 1];
  const baseline = wellnessDays.slice(-15, -1);
  const avg = (key) => (baseline.length ? mean(baseline.map((d) => d[key])) : today[key]) ?? 0;

  if (today.readinessScore != null) {
    return {
      score: Math.round(clamp(today.readinessScore, 5, 100)),
      factors: {
        sleepScore: today.sleepScore,
        bodyBatteryHigh: today.bodyBatteryHigh,
        restingHR: today.restingHR,
        hrvStatus: today.hrvStatus,
        source: 'device',
      },
    };
  }

  const sleepDelta = (today.sleepScore ?? avg('sleepScore')) - avg('sleepScore');
  const batteryDelta = (today.bodyBatteryHigh ?? avg('bodyBatteryHigh')) - avg('bodyBatteryHigh');
  const rhrDelta = avg('restingHR') - (today.restingHR ?? avg('restingHR')); // lower RHR than usual = good
  const hrvBonus =
    today.hrvStatus === 'BALANCED' ? 8 : today.hrvStatus === 'UNBALANCED' ? -12 : today.hrvStatus === 'LOW' ? -3 : 0;

  let score = 60 + sleepDelta * 0.6 + batteryDelta * 0.5 + rhrDelta * 1.5 + hrvBonus;
  score = Math.round(clamp(score, 5, 100));
  return {
    score,
    factors: {
      sleepScore: today.sleepScore,
      bodyBatteryHigh: today.bodyBatteryHigh,
      restingHR: today.restingHR,
      hrvStatus: today.hrvStatus,
      sleepDelta: Math.round(sleepDelta),
      batteryDelta: Math.round(batteryDelta),
      rhrDelta: Math.round(rhrDelta),
    },
  };
}

function daysSinceLastByDiscipline(activities, disciplines) {
  const now = Date.now();
  const out = {};
  for (const d of disciplines) {
    const last = activities.find((a) => a.discipline === d);
    out[d] = last ? Math.floor((now - new Date(last.startTime).getTime()) / 86400000) : 99;
  }
  return out;
}

const TEMPLATES = {
  climbing: {
    recovery: { title: 'Easy movement day', detail: 'Top-rope or auto-belay well below your limit, 40-50min at the gym. Footwork drills, no redpoint burns.' },
    moderate: { title: 'Volume / ARC training', detail: '4x4 boulder pyramid or ARC (aerobic capacity) laps at the gym, 60-90min at moderate intensity, full rest between hard sets.' },
    hard: { title: 'Projecting session', detail: '4-6 focused burns on your project boulder or route with full rest (3-5min) between attempts, then hangboard repeaters if fresh.' },
  },
  biking: {
    recovery: { title: 'Recovery spin', detail: 'Zone 1, 30-45min. Easy out-and-back on the 606 right from your door, or trainer, conversational pace.' },
    moderate: { title: 'Zone 2 endurance ride', detail: '60-100min steady aerobic pace — the 606 out to the Lakefront Trail and back is an easy way to string together distance (or Zwift/trainer when it’s not rideable outside).' },
    hard: { title: 'Threshold intervals', detail: '4-6x8min at threshold on the trainer (structured Zwift workout), or hard sustained efforts on the Lakefront Trail’s open stretches once you’ve connected over from the 606.' },
  },
  running: {
    recovery: { title: 'Easy shakeout', detail: 'Flat, easy jog, 25-40min, Zone 1-2 right out your door on the 606.' },
    moderate: { title: 'Zone 2 run', detail: '45-75min steady aerobic pace on the 606 (it’s flat and car-free end to end), practice fueling for longer efforts.' },
    hard: { title: 'Interval session', detail: '6-8x3min at hard effort using the 606’s mile markers, full recovery jog between reps, or one tempo-paced longer run out toward the Lakefront Trail.' },
  },
  mountaineering: {
    recovery: { title: 'Rest or valley walk', detail: 'Full rest, or a flat, easy walk. Legs need to absorb the last big day.' },
    moderate: { title: 'Load-carry hike', detail: 'Pack with 20-30% bodyweight, moderate vert (400-700m gain), steady pace.' },
    hard: { title: 'Big vertical day', detail: 'Target 1000m+ gain, pack on, pacing that simulates a summit push — this is the session that builds the engine.' },
  },
  hiking: {
    recovery: { title: 'Short flat walk', detail: '20-40min, flat trail, easy pace.' },
    moderate: { title: 'Moderate vert hike', detail: '5-8mi with 300-600m gain at a steady, sustainable pace.' },
    hard: { title: 'Big vert hike', detail: 'Longer objective with 800m+ gain, ideally with a loaded pack to build mountaineering-specific strength.' },
  },
  ski: {
    recovery: { title: 'Rest day', detail: 'Full rest — ski touring legs need it after a big vert day.' },
    moderate: { title: 'Moderate skin tour', detail: '600-900m of skinning at a conversational pace, groomed or mellow skin track.' },
    hard: { title: 'Big vert tour', detail: 'Multiple laps or a long single tour targeting 1200m+ of gain.' },
  },
  strength: {
    recovery: { title: 'Mobility / easy core', detail: '20-30min mobility and light core work, nothing loaded.' },
    moderate: { title: 'Strength maintenance', detail: 'Full-body session: squat/deadlift pattern, pull-ups, core, 45-60min moderate load.' },
    hard: { title: 'Heavy strength session', detail: 'Lower-rep, higher-load lifting session focused on legs and pulling strength for climbing/mountaineering.' },
  },
};

// The daily recommendation rotates only through the sports this athlete
// actually trains for; other disciplines (hiking, mountaineering, ski —
// still classified and shown in Activities/Trends if they ever show up in
// imported history) are excluded from the "what's next" pool.
const DISCIPLINE_PRIORITY = ['climbing', 'biking', 'running', 'strength'];

function recommendWorkout(activities, wellnessDays) {
  const acwr = computeACWR(activities);
  const readiness = computeReadiness(wellnessDays);
  const sinceLast = daysSinceLastByDiscipline(activities, DISCIPLINE_PRIORITY);

  let intensity = 'moderate';
  let reason;
  if (readiness.score < 40 || acwr.status === 'high-risk') {
    intensity = 'recovery';
    reason =
      acwr.status === 'high-risk'
        ? `Your training load ratio is ${acwr.ratio} (7-day load well above your 28-day norm) — time to absorb that work, not add to it.`
        : `Readiness is ${readiness.score}/100 today (sleep/body battery/HRV below your recent norm). Push a hard day to tomorrow.`;
  } else if (readiness.score >= 70 && acwr.status !== 'monitor') {
    intensity = 'hard';
    reason = `Readiness is strong (${readiness.score}/100) and training load is in a healthy range (ACWR ${acwr.ratio}) — good day for the hardest session of your week.`;
  } else {
    reason = `Readiness (${readiness.score}/100) and load (ACWR ${acwr.ratio}) are both mid-range — a solid maintenance session keeps building fitness without digging a hole.`;
  }

  // Pick whichever priority discipline has gone longest without a session,
  // biased toward disciplines you actually do (seen in the last 45 days).
  const active = DISCIPLINE_PRIORITY.filter((d) => sinceLast[d] < 45);
  const pool = active.length ? active : DISCIPLINE_PRIORITY.slice(0, 3);
  const discipline = pool.sort((a, b) => sinceLast[b] - sinceLast[a])[0];

  const template = (TEMPLATES[discipline] || TEMPLATES.hiking)[intensity];

  return {
    discipline,
    intensity,
    title: template.title,
    detail: template.detail,
    reason,
    readiness,
    acwr,
    daysSinceLast: sinceLast,
  };
}

module.exports = { activityLoad, computeACWR, computeReadiness, recommendWorkout, DISCIPLINE_PRIORITY };
