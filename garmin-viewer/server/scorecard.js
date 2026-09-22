// A transparent, 4-component readiness scorecard and verdict line — ported
// from (and adapted from) the mountaineering-focused version of this
// methodology: same idea (average of capped-at-100 components, penalized
// when load is spiking), retuned for a Chicago athlete whose three sports
// are biking, running, and gym climbing rather than alpine mountaineering,
// so "vertical ascent" (meaningless on flat lakefront terrain) is replaced
// with session consistency.

function clamp01to100(v) {
  return Math.max(0, Math.min(100, v));
}
function mean(xs) {
  const v = xs.filter((x) => x !== null && x !== undefined && !Number.isNaN(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

const TARGETS = {
  aerobicHoursPerWeek: 4, // biking + running combined
  climbHoursPerWeek: 3,
  sessionsPerWeek: 4,
};

function computeScorecard(activities, wellnessDays, acwrRatio, windowDays = 90) {
  const cutoff = Date.now() - windowDays * 86400000;
  const inWindow = activities.filter((a) => new Date(a.startTime).getTime() >= cutoff);
  const weeks = Math.max(1, windowDays / 7);

  const hoursOf = (disciplines) =>
    inWindow.filter((a) => disciplines.includes(a.discipline)).reduce((s, a) => s + a.durationMin / 60, 0);

  const aerobicHrs = hoursOf(['biking', 'running']);
  const climbHrs = hoursOf(['climbing']);
  const sessions = inWindow.length;

  const wellnessInWindow = wellnessDays.filter((d) => new Date(d.date).getTime() >= cutoff);
  const sleepAvg = mean(wellnessInWindow.map((d) => d.sleepHours)) || 0;

  const comp = [
    {
      k: 'Aerobic base',
      v: clamp01to100(((aerobicHrs / weeks) / TARGETS.aerobicHoursPerWeek) * 100),
      color: '#4a90c2',
      detail: `${(aerobicHrs / weeks).toFixed(1)} h/wk biking + running (target ${TARGETS.aerobicHoursPerWeek})`,
    },
    {
      k: 'Climbing volume',
      v: clamp01to100(((climbHrs / weeks) / TARGETS.climbHoursPerWeek) * 100),
      color: '#e8622c',
      detail: `${(climbHrs / weeks).toFixed(1)} h/wk climbing (target ${TARGETS.climbHoursPerWeek})`,
    },
    {
      k: 'Consistency',
      v: clamp01to100(((sessions / weeks) / TARGETS.sessionsPerWeek) * 100),
      color: '#c9a86a',
      detail: `${(sessions / weeks).toFixed(1)} sessions/wk, all disciplines (target ${TARGETS.sessionsPerWeek})`,
    },
    {
      k: 'Recovery',
      v: clamp01to100((sleepAvg / 8) * 100),
      color: '#5b8c5a',
      detail: `${sleepAvg.toFixed(1)} h average sleep (target 8)`,
    },
  ];

  let score = mean(comp.map((c) => c.v)) || 0;
  // A load spike is a readiness problem regardless of volume.
  if (acwrRatio != null && acwrRatio >= 1.5) score *= 0.85;

  return { score: Math.round(score), comp, weeks: Number(weeks.toFixed(1)), windowDays };
}

// The verdict must never congratulate you while a component is failing: it
// names the weakest link and surfaces active warnings rather than
// averaging them out of sight. A high score means training VOLUME is
// balanced, which is not the same thing as being recovered.
function computeVerdict(scorecard, insights) {
  const s = scorecard.score;
  const weak = [...scorecard.comp].sort((a, b) => a.v - b.v)[0];
  const warns = (insights || []).filter((i) => i.severity === 'warn');

  let text;
  if (s >= 75) text = 'Training volume is where it needs to be.';
  else if (s >= 55) text = 'Building, with a gap to close.';
  else if (s >= 35) text = 'Early in the block.';
  else text = 'Off-season or recovering.';
  if (warns.length && s >= 75) text = 'Volume is there, but recovery is not keeping up.';

  let sub = `Limiting factor: <b>${weak.k.toLowerCase()}</b> at ${Math.round(weak.v)}/100 — ${weak.detail}.`;
  if (warns.length) {
    sub +=
      ` <b>${warns.length} active warning${warns.length > 1 ? 's' : ''}:</b> ` +
      warns.map((w) => w.title.toLowerCase()).join('; ') +
      '.';
  }
  return { text, sub };
}

module.exports = { computeScorecard, computeVerdict, TARGETS };
