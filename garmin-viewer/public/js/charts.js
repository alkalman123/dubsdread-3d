/* global Chart */
// Chart mark specs follow the dataviz skill: 2px round-cap/join lines, an
// end-anchored >=8px marker with a surface-color ring (so it stays legible
// crossing the line), ~10% opacity area washes, <=24px capped/rounded bars,
// hairline recessive gridlines, and a styled dark tooltip that carries the
// series swatch (never color-only identity).

// Colors read live from the CSS custom properties (see :root/[data-theme]
// in style.css) rather than hardcoded per-theme literals -- Chart.js can't
// resolve var(--x) itself, so this is the theme-follows-the-page bridge.
// Called fresh inside each chart-builder function below (never cached at
// module load), so switching theme and re-rendering the current tab is
// enough to repaint every chart in the new palette.
function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
function gridColor() { return cssVar('--rule', 'rgba(128,128,128,0.1)'); }
function tickColor() { return cssVar('--muted', '#8590a0'); }
function surfaceColor() { return cssVar('--card', '#171c23'); }
function tooltipStyle() {
  return {
    backgroundColor: cssVar('--card2', 'rgba(29,35,44,0.97)'),
    titleColor: cssVar('--ink', '#eef2f5'),
    bodyColor: cssVar('--ink', '#eef2f5'),
    borderColor: cssVar('--rule', 'rgba(255,255,255,0.12)'),
    borderWidth: 1,
    padding: 10,
    cornerRadius: 8,
    displayColors: true,
    boxWidth: 8,
    boxHeight: 8,
    boxPadding: 4,
    usePointStyle: true,
  };
}

Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
Chart.defaults.font.size = 11;

const registry = new Map();

function makeChart(canvas, config) {
  const key = canvas.id;
  if (registry.has(key)) registry.get(key).destroy();
  Chart.defaults.color = tickColor();
  const chart = new Chart(canvas, config);
  registry.set(key, chart);
  return chart;
}

// End-anchored marker: the line itself stays clean (no per-point clutter),
// but the last real value gets a >=8px dot with a surface ring so each
// series has one legible "landing point" per the mark spec, and hover
// shows the same treatment at whichever point is nearest the cursor.
function endMarkerRadii(dataArr) {
  const lastIdx = [...dataArr].reverse().findIndex((v) => v != null);
  const lastRealIndex = lastIdx === -1 ? -1 : dataArr.length - 1 - lastIdx;
  return (ctx) => (ctx.dataIndex === lastRealIndex ? 4 : 0);
}

export function lineChart(canvas, { labels, series, yLabel, fill = false }) {
  return makeChart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: series.map((s) => ({
        label: s.label,
        data: s.data,
        borderColor: s.color,
        backgroundColor: fill ? `${s.color}1a` : 'transparent',
        pointRadius: endMarkerRadii(s.data),
        pointHoverRadius: 5,
        pointBackgroundColor: s.color,
        pointBorderColor: surfaceColor(),
        pointBorderWidth: 2,
        pointHoverBorderWidth: 2,
        borderWidth: 2,
        borderCapStyle: 'round',
        borderJoinStyle: 'round',
        tension: 0.35,
        fill,
        spanGaps: true,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: series.length > 1, labels: { boxWidth: 8, boxHeight: 8, padding: 12, usePointStyle: true } },
        tooltip: tooltipStyle(),
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 6 } },
        y: { grid: { color: gridColor() }, border: { display: false }, title: yLabel ? { display: true, text: yLabel, color: tickColor() } : undefined },
      },
    },
  });
}

export function barChart(canvas, { labels, data, colors, horizontal = false, valueLabel }) {
  const valueAxis = { grid: { color: gridColor() }, border: { display: false }, title: valueLabel ? { display: true, text: valueLabel, color: tickColor() } : undefined };
  const categoryAxis = { grid: { display: false }, border: { display: false } };
  // "4px rounded data-end, square at the baseline" -- for a horizontal bar
  // growing rightward from the y-axis, the data-end is the right edge; for
  // a vertical bar growing up from the x-axis, it's the top edge.
  const radius = horizontal
    ? { topLeft: 0, bottomLeft: 0, topRight: 4, bottomRight: 4 }
    : { topLeft: 4, topRight: 4, bottomLeft: 0, bottomRight: 0 };
  return makeChart(canvas, {
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderRadius: radius, borderSkipped: false, maxBarThickness: 24 }] },
    options: {
      indexAxis: horizontal ? 'y' : 'x',
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: tooltipStyle() },
      scales: horizontal ? { x: valueAxis, y: categoryAxis } : { x: categoryAxis, y: valueAxis },
    },
  });
}

export function gaugeArc(canvas, value, max, color) {
  return makeChart(canvas, {
    type: 'doughnut',
    data: {
      datasets: [
        {
          data: [value, Math.max(0, max - value)],
          backgroundColor: [color, gridColor()],
          borderWidth: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      circumference: 240,
      rotation: -120,
      cutout: '75%',
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
    },
  });
}

// A minimal inline trend line for a stat tile: no axes, no gridlines, no
// tooltip chrome -- just the shape of the last N days, end-anchored like
// the full-size lineChart, so a glance tells you "trending up/down" without
// competing with the big number it sits under.
export function sparkline(canvas, data, color) {
  return makeChart(canvas, {
    type: 'line',
    data: {
      labels: data.map((_, i) => i),
      datasets: [
        {
          data,
          borderColor: color,
          backgroundColor: `${color}22`,
          borderWidth: 1.5,
          pointRadius: endMarkerRadii(data),
          pointBackgroundColor: color,
          pointBorderWidth: 0,
          tension: 0.35,
          fill: true,
          spanGaps: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 500 },
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        x: { display: false },
        y: { display: false },
      },
      elements: { point: { radius: 0 } },
    },
  });
}

// Bedtime/wake consistency: one floating bar per night spanning bedtime to
// wake time, on a "clock" axis anchored at 6pm (so a night crossing
// midnight is just one contiguous bar instead of wrapping). ranges are
// [startOffsetHours, endOffsetHours] pairs already computed by the caller
// (see app.js's hoursSince6pm), or null for a night with no sleep data.
const CLOCK_TICKS = { 0: '6pm', 3: '9pm', 6: '12am', 9: '3am', 12: '6am', 15: '9am', 18: '12pm' };

export function sleepConsistencyChart(canvas, { labels, ranges, color }) {
  return makeChart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{ data: ranges, backgroundColor: `${color}cc`, borderRadius: 4, borderSkipped: false, maxBarThickness: 20 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          ...tooltipStyle(),
          callbacks: {
            label(ctx) {
              const [start, end] = ctx.raw || [];
              if (start == null) return 'No data';
              const fmt = (h) => {
                const clockH = (18 + h) % 24;
                const hour12 = clockH % 12 === 0 ? 12 : Math.round(clockH % 12);
                const min = Math.round((clockH % 1) * 60);
                return `${hour12}:${String(min).padStart(2, '0')}${clockH < 12 ? 'am' : 'pm'}`;
              };
              return `${fmt(start)} → ${fmt(end)}`;
            },
          },
        },
      },
      scales: {
        x: { grid: { display: false }, border: { display: false } },
        y: {
          reverse: false,
          min: 0,
          max: 18,
          grid: { color: gridColor() },
          border: { display: false },
          ticks: { stepSize: 3, callback: (v) => CLOCK_TICKS[v] ?? '' },
        },
      },
    },
  });
}

// A compact stacked horizontal bar (sleep-stage breakdown, etc.) — segments
// share a 2px surface gap instead of a border, per the spacer rule.
export function stackedBarChart(canvas, { labels, series, horizontal = true, showLegend = true }) {
  return makeChart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: series.map((s) => ({
        label: s.label,
        data: s.data,
        backgroundColor: s.color,
        borderColor: surfaceColor(),
        borderWidth: horizontal ? { top: 0, bottom: 0, left: 2, right: 2 } : { top: 2, bottom: 2, left: 0, right: 0 },
        maxBarThickness: 28,
      })),
    },
    options: {
      indexAxis: horizontal ? 'y' : 'x',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: showLegend, position: 'bottom', labels: { boxWidth: 8, boxHeight: 8, padding: 12, usePointStyle: true } },
        tooltip: tooltipStyle(),
      },
      scales: {
        x: { stacked: true, grid: { display: !horizontal, color: gridColor() }, border: { display: false } },
        y: { stacked: true, grid: { display: horizontal, color: gridColor() }, border: { display: false } },
      },
    },
  });
}
