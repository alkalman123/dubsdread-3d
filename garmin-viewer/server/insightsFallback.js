// Lightweight insight generation for when there's no imported dataset (that
// already carries its own pre-computed `insights[]`) — demo mode and
// fresh live-Garmin-only setups still get something in the insight cards.

function mean(xs) {
  const v = xs.filter((x) => x !== null && x !== undefined && !Number.isNaN(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function generateInsights(wellnessDays) {
  const out = [];
  const recent = wellnessDays.slice(-14);
  if (!recent.length) return out;

  const sleepAvg = mean(recent.map((d) => d.sleepHours));
  if (sleepAvg != null) {
    if (sleepAvg < 7) {
      out.push({
        severity: 'warn',
        title: 'Sleep is running short',
        body: `Averaging ${sleepAvg.toFixed(1)} h over the last 14 nights — below an 8 h target. Sleep is the single biggest lever on HRV and resting heart rate.`,
        metric: `${sleepAvg.toFixed(1)} h`,
      });
    } else {
      out.push({
        severity: 'good',
        title: 'Sleep on target',
        body: `Averaging ${sleepAvg.toFixed(1)} h over the last 14 nights.`,
        metric: `${sleepAvg.toFixed(1)} h`,
      });
    }
  }

  const hrvVals = recent.map((d) => d.hrvMs).filter((v) => v != null);
  if (hrvVals.length) {
    const avg = mean(hrvVals);
    out.push({
      severity: 'info',
      title: 'HRV',
      body: `Averaging ${Math.round(avg)} ms over the last ${hrvVals.length} measured days.`,
      metric: `${Math.round(avg)} ms`,
    });
  }

  const readyVals = recent.map((d) => d.readinessScore).filter((v) => v != null);
  if (readyVals.length) {
    const avg = mean(readyVals);
    out.push({
      severity: avg >= 60 ? 'good' : avg >= 40 ? 'info' : 'warn',
      title: 'Training readiness',
      body: `Averaging ${Math.round(avg)} over the last ${readyVals.length} scored days.`,
      metric: `${Math.round(avg)}`,
    });
  }

  const rhrVals = recent.map((d) => d.restingHR).filter((v) => v != null);
  const baseline = wellnessDays.slice(-30, -14).map((d) => d.restingHR).filter((v) => v != null);
  if (rhrVals.length && baseline.length) {
    const avg = mean(rhrVals);
    const base = mean(baseline);
    const delta = avg - base;
    if (delta >= 3) {
      out.push({
        severity: 'warn',
        title: 'Resting heart rate is elevated',
        body: `Averaging ${avg.toFixed(0)} bpm over the last 14 days vs ${base.toFixed(0)} bpm before that — often shows up before you feel run down.`,
        metric: `+${delta.toFixed(0)} bpm`,
      });
    }
  }

  return out;
}

module.exports = { generateInsights };
