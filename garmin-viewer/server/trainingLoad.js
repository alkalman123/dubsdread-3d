// Rule-based training-load and recovery engine. No external ML/AI here —
// just the same acute:chronic workload ratio (ACWR) and readiness
// heuristics that training-load tools like TrainingPeaks/Strava use,
// adapted so vertical gain counts for as much as heart rate (a common gap
// for climbers/mountaineers, whose hardest days are often low-HR).

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

// 0-100 readiness score from the most recent wellness day, relative to the
// trailing baseline (so "low sleep for you" matters more than an absolute
// threshold that ignores your normal sleep needs).
function computeReadiness(wellnessDays) {
  if (!wellnessDays.length) return { score: 60, factors: {} };
  const today = wellnessDays[wellnessDays.length - 1];
  const baseline = wellnessDays.slice(-15, -1);
  const avg = (key) =>
    baseline.length ? baseline.reduce((s, d) => s + (d[key] || 0), 0) / baseline.length : today[key] || 0;

  const sleepDelta = today.sleepScore - avg('sleepScore');
  const batteryDelta = today.bodyBatteryHigh - avg('bodyBatteryHigh');
  const rhrDelta = avg('restingHR') - today.restingHR; // lower RHR than usual = good
  const hrvBonus = today.hrvStatus === 'BALANCED' ? 8 : today.hrvStatus === 'UNBALANCED' ? -12 : -3;

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
    recovery: { title: 'Easy movement day', detail: 'Top-rope or gym volume well below your limit, 40-50min. Footwork drills, no redpoint burns.' },
    moderate: { title: 'Volume / ARC training', detail: '4x4 pyramid or ARC (aerobic capacity) circuits, 60-90min at moderate intensity, full rest between hard sets.' },
    hard: { title: 'Projecting session', detail: '4-6 focused attempts on your project grade with full rest (3-5min) between burns, then fingerboard repeaters if fresh.' },
  },
  biking: {
    recovery: { title: 'Recovery spin', detail: 'Zone 1, flat, 30-45min. Conversational pace, no climbs.' },
    moderate: { title: 'Zone 2 endurance ride', detail: '60-100min rolling terrain, steady aerobic pace, stay out of the red.' },
    hard: { title: 'Threshold / vert intervals', detail: '4-6x8min at threshold, or repeat your local climb 3-4x at a hard, sustainable pace.' },
  },
  running: {
    recovery: { title: 'Easy shakeout', detail: 'Flat, easy jog or brisk hike, 25-40min, Zone 1-2.' },
    moderate: { title: 'Zone 2 trail run', detail: '45-75min rolling singletrack, steady effort, practice fueling for longer days.' },
    hard: { title: 'Hill repeats', detail: '6-10x uphill efforts (2-4min each) at hard effort, easy jog/walk down, or one long vert-heavy run.' },
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

const DISCIPLINE_PRIORITY = ['climbing', 'biking', 'mountaineering', 'running', 'ski', 'hiking', 'strength'];

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
