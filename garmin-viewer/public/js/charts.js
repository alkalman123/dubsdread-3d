/* global Chart */

const GRID = 'rgba(255,255,255,0.06)';
const TICK = '#6b7482';

Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
Chart.defaults.font.size = 11;
Chart.defaults.color = TICK;

const registry = new Map();

function makeChart(canvas, config) {
  const key = canvas.id;
  if (registry.has(key)) registry.get(key).destroy();
  const chart = new Chart(canvas, config);
  registry.set(key, chart);
  return chart;
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
        backgroundColor: fill ? s.color + '22' : 'transparent',
        pointRadius: 0,
        borderWidth: 2,
        tension: 0.35,
        fill,
        spanGaps: true,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: series.length > 1, labels: { boxWidth: 10, padding: 10 } } },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 6 } },
        y: { grid: { color: GRID }, title: yLabel ? { display: true, text: yLabel, color: TICK } : undefined },
      },
    },
  });
}

export function barChart(canvas, { labels, data, colors, horizontal = false }) {
  return makeChart(canvas, {
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderRadius: 6, maxBarThickness: 28 }] },
    options: {
      indexAxis: horizontal ? 'y' : 'x',
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: !horizontal, color: GRID } },
        y: { grid: { display: horizontal, color: GRID } },
      },
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
          backgroundColor: [color, 'rgba(255,255,255,0.08)'],
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
