import { api } from './api.js';
import { lineChart, barChart, gaugeArc, stackedBarChart, sleepConsistencyChart } from './charts.js';
import { importStore } from './importStore.js';
import { contextStore } from './contextStore.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  tab: 'today',
  mode: 'demo',
  activityFilter: 'all',
  activities: null,
  trendsRange: '90',
  chatMessages: [],
  contextNotes: [],
};

// Range chips on Trends map to a day count sent to the wellness API.
// "all" asks for a decade, which the server caps to whatever's actually
// on record — it's just a "give me everything you've got" signal.
const TRENDS_RANGES = { '30': 30, '90': 90, '365': 365, all: 3650 };

// ------------------------------------------------- daily micro-programs ----
// Progressive home hangboard (finger strength) and Gibbon-board slackline
// routines, meant for the short sessions you can fit between meetings on
// WFH days / every day respectively. Each is a fixed week-by-week plan
// (so it genuinely builds on the previous week instead of repeating the
// same tip forever) selected purely by calendar week since PROGRAM_START —
// no server state to lose on a redeploy, everyone always sees the same
// phase on the same week.
//
// Hangboard weeks 1-4 follow the "Abrahangs" protocol (Emil Abrahamsson /
// popularized by Lattice Training & thehangboard.com): short, frequent,
// sub-maximal hangs with feet on the ground, done 2x/day 6+ hours apart --
// deliberately the low-fatigue, high-frequency style suited to sneaking in
// between calls, not a single hard session. After week 4 it holds at a
// maintenance version of that same protocol rather than progressing into
// heavier max-hang work, which belongs in an actual gym session (see the
// climbing entries in trainingLoad.js's TEMPLATES) — not something to do
// solo at a desk.
const PROGRAM_START = new Date('2026-09-22T00:00:00');

function programWeekIndex(maxIndex) {
  const weeks = Math.floor((Date.now() - PROGRAM_START.getTime()) / (7 * 86400000));
  return Math.max(0, Math.min(maxIndex, weeks));
}

const HANGBOARD_WEEKS = [
  {
    title: 'Week 1: Open-hand Abrahangs',
    detail:
      '2x/day, 6+ hours apart: 10 sets of 10s hangs on a jug or large edge (20mm+), open-hand grip only, ~50s rest between sets. Feet stay on the ground the whole time — this should feel like 40% effort, never close to failure. ~2min of hang time per session.',
  },
  {
    title: 'Week 2: Add half-crimp',
    detail:
      '2x/day, 6+ hours apart: 10 sets of 10s hangs, alternating open-hand and half-crimp each set, same edge as week 1. Still feet-on-ground, still sub-maximal — the goal is frequency and tendon adaptation, not fatigue.',
  },
  {
    title: 'Week 3: Smaller edge',
    detail:
      '2x/day, 6+ hours apart: 10 sets of 10s hangs on a smaller edge (~14-18mm), half of the sets open-hand and half half-crimp. If your gear only has one small edge, that\'s fine — consistency matters more than variety here.',
  },
  {
    title: 'Week 4: Full protocol',
    detail:
      '2x/day, 6+ hours apart: 10 sets of 10s hangs on your week-3 edge, split evenly between open-hand and half-crimp, ~50s rest between sets. This is the complete Abrahangs session — Emil Abrahamsson\'s original numbers (roughly 1-2 minutes of total hang time per session, every day) are what drove his real strength gains.',
  },
  {
    title: 'Maintenance: keep the habit',
    detail:
      '2x/day on WFH days, 6+ hours apart: 10 sets of 10s hangs (open-hand + half-crimp) on whatever edge still feels like ~40% effort. If it starts feeling easy, drop to a smaller edge — but this stays a low-fatigue habit, not a max-effort session. Save real max-hang work for gym days (see your climbing plan).',
  },
];

const SLACKLINE_WEEKS = [
  {
    title: 'Week 1: Mount & stillness',
    detail:
      '5min: practice stepping onto the line and finding a stable, still stance — both feet, soft knees, gaze fixed on something ahead (not your feet). Count your longest still hold each attempt and try to beat it.',
  },
  {
    title: 'Week 2: Single-leg balance + first steps',
    detail:
      "5min: hold single-leg balance on each side (aim for 10-20s per side), then try 2-3 steps forward before stepping off. It's normal to fall a lot here — that's how balance calibrates.",
  },
  {
    title: 'Week 3: Full-length walk + turnaround',
    detail:
      '5min: walk the full length of the line, and practice turning around at the far end without stepping off (pivot on the balls of both feet, low and slow).',
  },
  {
    title: 'Week 4: Walk backward + bounce control',
    detail:
      '5min: add walking backward the full length, then practice small controlled bounces in place without losing your line. Bounce control is the base for surfing and jump tricks later.',
  },
  {
    title: 'Week 5: First sit',
    detail:
      "5min: from standing, practice dropping to a seated \"Buddha sit\" on the line and standing back up — this is the standard entry into every seated/lying trick. Expect a lot of falls; that's normal at this stage.",
  },
  {
    title: 'Week 6+: Pick one trick, rotate weekly',
    detail:
      'You have the fundamentals (mount, walk both directions, turn around, bounce, sit). Spend 5min/day on ONE intermediate trick this week — surfing (forward or sideways rocking), cross-legged knee drop, or jumping turns — then swap to a different one next week.',
  },
];

function dailyMicroPrograms() {
  return {
    hangboard: HANGBOARD_WEEKS[programWeekIndex(HANGBOARD_WEEKS.length - 1)],
    slackline: SLACKLINE_WEEKS[programWeekIndex(SLACKLINE_WEEKS.length - 1)],
  };
}

function microHabitsCardHtml() {
  const { hangboard, slackline } = dailyMicroPrograms();
  return `
      <h2 class="section-title">Today's Micro-Habits</h2>
      <div class="card" style="padding:4px 12px">
        <div class="activity-item">
          <div class="glyph" style="background:#c25b9e22;color:#c25b9e">🤸</div>
          <div>
            <div class="name">${slackline.title}</div>
            <div class="meta">${slackline.detail}</div>
          </div>
        </div>
        <div class="activity-item">
          <div class="glyph" style="background:#f0793d22;color:#f0793d">🖐️</div>
          <div>
            <div class="name">${hangboard.title}</div>
            <div class="meta">${hangboard.detail}</div>
          </div>
        </div>
      </div>`;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.remove('show'), 2600);
}

function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function fmtDuration(min) {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}
function skeletonCards(n = 2) {
  return Array.from({ length: n }, () => '<div class="card"><div class="skeleton" style="height:70px"></div></div>').join('');
}
function errorCard(err) {
  return `<div class="card"><b style="color:var(--red)">Couldn't load this.</b><div class="hint">${err.message || err}</div></div>`;
}

// ---------------------------------------------------------------- tabs ----

function switchTab(tab) {
  state.tab = tab;
  $$('nav.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${tab}`));
  render(tab);
}
$$('nav.tabbar button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

function render(tab) {
  if (tab === 'today') renderToday();
  else if (tab === 'activities') renderActivities();
  else if (tab === 'trends') renderTrends();
  else if (tab === 'sleep') renderSleep();
  else if (tab === 'body') renderBody();
  else if (tab === 'plan') renderPlan();
}

// -------------------------------------------------------------- status ----

async function refreshStatus() {
  try {
    const s = await api.status();
    state.mode = s.mode;
    const pill = $('#modePill');
    // "demo" only means synthetic data — once a real import exists, the
    // athlete is looking at their own history even without a live Garmin
    // connection, so labeling it "demo" would be actively misleading.
    const label = s.mode === 'demo' && s.import ? 'imported' : s.mode;
    pill.textContent = label;
    pill.className = `mode-pill ${label === 'imported' ? 'live' : s.mode}`;
    return s;
  } catch {
    return { mode: 'demo', authenticated: false };
  }
}

function insightCardsHtml(insights) {
  if (!insights || !insights.length) return '';
  return `<div class="icards">${insights
    .slice(0, 4)
    .map(
      (i) => `
    <div class="ic ${i.severity}">
      <div class="t">${i.title}</div>
      ${i.metric ? `<div class="m num">${i.metric}</div>` : ''}
      <div class="b">${i.body}</div>
    </div>`
    )
    .join('')}</div>`;
}

function scorePanelHtml(sc) {
  return `
    <div class="score-panel">
      <div class="lbl">Training Score</div>
      <div class="bigscore"><span class="v num">${sc.score}</span><span class="o">/ 100</span></div>
      <div class="desc">A transparent average of four components, each capped at 100. Measures <b>training balance, not health</b> — read it alongside the insights above.</div>
      ${sc.comp
        .map(
          (c) => `
        <div class="comp-row">
          <div class="cr-lbl"><span>${c.k}</span><span>${Math.round(c.v)}</span></div>
          <div class="comp-track"><div class="comp-fill" style="width:${c.v}%;background:${c.color}"></div></div>
          <div class="cr-detail">${c.detail}</div>
        </div>`
        )
        .join('')}
    </div>`;
}

// --------------------------------------------------------------- Today ----

async function renderToday() {
  const view = $('#view-today');
  view.innerHTML = skeletonCards(1) + skeletonCards(2);
  try {
    const hour = new Date().getHours();
    const isMorning = hour < 15;
    const [briefing, wellnessRes, actsRes, insightsRes] = await Promise.all([
      isMorning ? api.briefingMorning() : api.briefingEvening(),
      api.wellness(2),
      api.activities(5),
      api.insights(),
    ]);
    const today = wellnessRes.wellness[wellnessRes.wellness.length - 1] || {};
    const plan = briefing.plan || (await api.planToday()).plan;
    const acts = actsRes.activities;

    view.innerHTML = `
      ${insightCardsHtml(insightsRes.insights)}

      <h2 class="section-title">${isMorning ? 'Morning Briefing' : 'Evening Wrap-up'}</h2>
      <div class="card briefing-card">
        <div class="kicker">${isMorning ? '☀️ Good morning' : '🌙 Day complete'}</div>
        <p>${briefing.text}</p>
      </div>

      <h2 class="section-title">Today's Numbers</h2>
      <div class="ring-row">
        <div class="ring-tile">
          <div class="ring-canvas-wrap"><canvas id="bbRing"></canvas><div class="ring-center"><div class="rv">${today.bodyBatteryHigh ?? '–'}</div></div></div>
          <div class="ring-lbl">Body Battery</div>
        </div>
        <div class="ring-tile">
          <div class="ring-canvas-wrap"><canvas id="sleepRing"></canvas><div class="ring-center"><div class="rv">${today.sleepHours ?? '–'}<span class="ru">h</span></div></div></div>
          <div class="ring-lbl">Sleep</div>
        </div>
      </div>
      <div class="stat-row two">
        <div class="stat-tile"><div class="val">${today.restingHR ?? '–'}</div><div class="lbl">Resting HR</div></div>
        <div class="stat-tile"><div class="val">${today.steps != null ? (today.steps / 1000).toFixed(1) + 'k' : '–'}</div><div class="lbl">Steps</div></div>
      </div>

      <h2 class="section-title">Today's Plan</h2>
      <div class="card tappable plan-preview" id="planPreviewCard">
        <div class="glyph">${plan?.icon || '🎯'}</div>
        <div>
          <div class="title">${plan?.title || 'Loading...'}</div>
          <div class="sub">${plan?.disciplineLabel || ''} · ${plan?.intensity || ''}</div>
        </div>
        <div class="chev">›</div>
      </div>

      <h2 class="section-title">Recent Activity</h2>
      <div class="card" id="recentList" style="padding:4px 12px;"></div>

      ${microHabitsCardHtml()}

      ${coachSectionHtml()}
    `;
    $('#planPreviewCard').addEventListener('click', () => switchTab('plan'));
    renderActivityListInto($('#recentList'), acts, { compact: true });
    // Canvas fillStyle can't resolve CSS custom properties, so these mirror
    // --teal/--blue from style.css as literal values rather than var(...).
    gaugeArc($('#bbRing'), today.bodyBatteryHigh ?? 0, 100, '#2ec4cb');
    gaugeArc($('#sleepRing'), Math.min(((today.sleepHours ?? 0) / 9) * 100, 100), 100, '#4fa3e0');
    await initCoachUI();
  } catch (err) {
    view.innerHTML = errorCard(err);
  }
}

// ----------------------------------------------------------- Activities ----

function renderActivityListInto(container, activities, { compact = false } = {}) {
  if (!activities.length) {
    container.innerHTML = '<div class="empty">No activities in this view yet.</div>';
    return;
  }
  container.innerHTML = activities
    .map(
      (a) => `
    <div class="activity-item tappable" data-id="${a.id}">
      <div class="glyph" style="background:${a.color}22;color:${a.color}">${a.icon}</div>
      <div>
        <div class="name">${a.name}</div>
        <div class="meta">${a.distanceKm ? a.distanceKm + ' km · ' : ''}${fmtDuration(a.durationMin)}${a.elevationGainM ? ' · ↑' + a.elevationGainM + 'm' : ''}</div>
      </div>
      <div class="date">${fmtDate(a.startTime)}</div>
    </div>`
    )
    .join('');
  $$('.activity-item', container).forEach((node) =>
    node.addEventListener('click', () => openActivitySheet(Number(node.dataset.id)))
  );
}

async function renderActivities() {
  const view = $('#view-activities');
  view.innerHTML = `<h2 class="section-title">Activities</h2>${skeletonCards(3)}`;
  try {
    const allActivities = await ensureActivitiesLoaded();
    const disciplines = Array.from(new Map(allActivities.map((a) => [a.discipline, a])).values());
    const chips = ['all', ...disciplines.map((d) => d.discipline)];
    const labelFor = (d) => (d === 'all' ? 'All' : disciplines.find((x) => x.discipline === d)?.disciplineLabel || d);

    view.innerHTML = `
      <div style="display:flex;align-items:baseline;justify-content:space-between">
        <h2 class="section-title" style="margin-bottom:10px">Activities</h2>
        <button class="btn secondary" id="logActivityBtn" style="padding:6px 12px;font-size:12.5px;margin-bottom:10px">+ Log</button>
      </div>
      <div class="chip-row" id="filterChips">
        ${chips.map((d) => `<div class="chip ${d === state.activityFilter ? 'active' : ''}" data-d="${d}">${labelFor(d)}</div>`).join('')}
      </div>
      <div class="card" id="activityList" style="padding:4px 12px;"></div>
    `;
    $$('#filterChips .chip').forEach((chip) =>
      chip.addEventListener('click', () => {
        state.activityFilter = chip.dataset.d;
        renderActivities();
      })
    );
    $('#logActivityBtn').addEventListener('click', openLogActivitySheet);
    const filtered = state.activityFilter === 'all' ? state.activities : state.activities.filter((a) => a.discipline === state.activityFilter);
    renderActivityListInto($('#activityList'), filtered);
  } catch (err) {
    view.innerHTML = `<h2 class="section-title">Activities</h2>${errorCard(err)}`;
  }
}

const LOGGABLE_TYPES = [
  { typeKey: 'climbing', label: 'Climbing (gym)' },
  { typeKey: 'cycling', label: 'Biking' },
  { typeKey: 'running', label: 'Running' },
  { typeKey: 'strength_training', label: 'Strength' },
  { typeKey: 'hiking', label: 'Hiking' },
  { typeKey: 'walking', label: 'Walking' },
  { typeKey: 'slacklining', label: 'Slacklining' },
];

function openLogActivitySheet() {
  const sheet = $('#activitySheet');
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <h3>Log an activity</h3>
    <div class="hint" style="margin-top:2px">For sessions your watch missed, or history from before you had one — this feeds the training-load and plan engine too.</div>
    <form class="stack-form" id="logForm">
      <select name="typeKey" required>
        ${LOGGABLE_TYPES.map((t) => `<option value="${t.typeKey}">${t.label}</option>`).join('')}
      </select>
      <input type="text" name="name" placeholder="Name (optional)" />
      <div class="field-row">
        <input type="date" name="date" value="${new Date().toISOString().slice(0, 10)}" required />
        <input type="number" name="durationMin" placeholder="Duration (min)" min="1" required />
      </div>
      <div class="field-row">
        <input type="number" name="distanceKm" placeholder="Distance (km)" step="0.1" min="0" />
        <input type="number" name="elevationGainM" placeholder="Elevation gain (m)" min="0" />
      </div>
      <div class="field-row">
        <input type="number" name="avgHR" placeholder="Avg HR (optional)" min="0" />
        <input type="number" name="calories" placeholder="Calories (optional)" min="0" />
      </div>
      <button class="btn" type="submit">Save activity</button>
    </form>
  `;
  openSheet(sheet, $('#backdrop'));
  $('#logForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const entry = Object.fromEntries(fd.entries());
    try {
      await api.addManualActivity(entry);
      toast('Activity logged');
      state.activities = null;
      closeSheets();
      render(state.tab);
    } catch (err) {
      toast(err.message || 'Could not save activity');
    }
  });
}

let map;
async function openActivitySheet(id) {
  const sheet = $('#activitySheet');
  const backdrop = $('#backdrop');
  sheet.innerHTML = `<div class="sheet-handle"></div>${skeletonCards(2)}`;
  openSheet(sheet, backdrop);
  try {
    const { activity: a, track, streams } = await api.activity(id);
    const hasTrack = track && track.length > 1;
    sheet.innerHTML = `
      <div class="sheet-handle"></div>
      <h3>${a.icon} ${a.name}</h3>
      <div class="hint">${new Date(a.startTime).toLocaleString()}</div>
      ${hasTrack ? '<div class="detail-map" id="detailMap"></div>' : ''}
      <div class="detail-grid">
        <div class="stat-tile"><div class="val">${a.distanceKm}</div><div class="lbl">km</div></div>
        <div class="stat-tile"><div class="val">${fmtDuration(a.durationMin)}</div><div class="lbl">time</div></div>
        <div class="stat-tile"><div class="val">${a.elevationGainM}m</div><div class="lbl">gain</div></div>
        <div class="stat-tile"><div class="val">${a.avgHR ?? '–'}</div><div class="lbl">avg hr</div></div>
        <div class="stat-tile"><div class="val">${a.maxHR ?? '–'}</div><div class="lbl">max hr</div></div>
        <div class="stat-tile"><div class="val">${a.calories ?? '–'}</div><div class="lbl">kcal</div></div>
      </div>
      ${
        ['climbing', 'mountaineering', 'ski', 'hiking'].includes(a.discipline) && a.vam
          ? `<div class="hint">Vertical ascent rate: ~${a.vam} m/h</div>`
          : ''
      }
      ${streams.hr && streams.hr.length ? '<h2 class="section-title">Heart Rate</h2><div class="chart-wrap"><canvas id="hrChart"></canvas></div>' : ''}
      ${streams.elevation && streams.elevation.length ? '<h2 class="section-title">Elevation</h2><div class="chart-wrap"><canvas id="eleChart"></canvas></div>' : ''}
    `;

    if (hasTrack) {
      requestAnimationFrame(() => {
        if (map) { map.remove(); map = null; }
        map = L.map('detailMap', { zoomControl: false, attributionControl: false });
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 17 }).addTo(map);
        const latlngs = track.map((p) => [p.lat, p.lon]);
        const poly = L.polyline(latlngs, { color: a.color, weight: 4 }).addTo(map);
        map.fitBounds(poly.getBounds(), { padding: [16, 16] });
      });
    }

    if (streams.hr && streams.hr.length) {
      const labels = (streams.timeSec || []).map((s) => `${Math.round(s / 60)}m`);
      lineChart($('#hrChart'), { labels, series: [{ label: 'HR', data: streams.hr, color: '#e35a48' }] });
    }
    if (streams.elevation && streams.elevation.length) {
      const labels = (streams.timeSec || []).map((s) => `${Math.round(s / 60)}m`);
      lineChart($('#eleChart'), { labels, series: [{ label: 'Elevation', data: streams.elevation, color: '#ac82a5' }], fill: true });
    }
  } catch (err) {
    sheet.innerHTML = `<div class="sheet-handle"></div>${errorCard(err)}`;
  }
}

// --------------------------------------------------------------- Trends ----

async function ensureActivitiesLoaded() {
  if (!state.activities) {
    const res = await api.activities(5000);
    state.activities = res.activities;
  }
  return state.activities;
}

function mean(xs) {
  const v = xs.filter((x) => x != null && !Number.isNaN(x));
  return v.length ? Number((v.reduce((a, b) => a + b, 0) / v.length).toFixed(1)) : null;
}

// A year+ of daily points crushes into an unreadable smear on a phone-width
// line chart, so once a range gets long, average into weekly buckets
// instead of plotting every single day.
function bucketWeekly(wellness) {
  const buckets = new Map();
  for (const d of wellness) {
    const date = new Date(d.date);
    const weekStart = new Date(date);
    weekStart.setDate(date.getDate() - date.getDay());
    const key = weekStart.toISOString().slice(0, 10);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(d);
  }
  return Array.from(buckets.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([week, days]) => ({
      date: week,
      bodyBatteryHigh: mean(days.map((d) => d.bodyBatteryHigh)),
      bodyBatteryLow: mean(days.map((d) => d.bodyBatteryLow)),
      restingHR: mean(days.map((d) => d.restingHR)),
      sleepHours: mean(days.map((d) => d.sleepHours)),
    }));
}

function computeRecords(activities) {
  if (!activities || !activities.length) return null;
  const totalHours = activities.reduce((s, a) => s + a.durationMin, 0) / 60;
  const totalElevation = activities.reduce((s, a) => s + (a.elevationGainM || 0), 0);
  const byDiscipline = {};
  for (const a of activities) {
    byDiscipline[a.discipline] = byDiscipline[a.discipline] || { hours: 0, km: 0, meta: a };
    byDiscipline[a.discipline].hours += a.durationMin / 60;
    byDiscipline[a.discipline].km += a.distanceKm || 0;
  }
  const longest = [...activities].sort((a, b) => b.durationMin - a.durationMin)[0];
  const mostElevation = [...activities].sort((a, b) => (b.elevationGainM || 0) - (a.elevationGainM || 0))[0];
  const topDiscipline = Object.entries(byDiscipline).sort((a, b) => b[1].hours - a[1].hours)[0];
  return { totalActivities: activities.length, totalHours, totalElevation, longest, mostElevation, topDiscipline };
}

function recordsCardHtml(activities) {
  const r = computeRecords(activities);
  if (!r) return '';
  return `
    <h2 class="section-title">All-Time Records</h2>
    <div class="card">
      <div class="stat-row three">
        <div class="stat-tile"><div class="val">${r.totalActivities}</div><div class="lbl">Activities logged</div></div>
        <div class="stat-tile"><div class="val">${Math.round(r.totalHours)}h</div><div class="lbl">Total training time</div></div>
        <div class="stat-tile"><div class="val">${Math.round(r.totalElevation).toLocaleString()}m</div><div class="lbl">Total elevation</div></div>
        <div class="stat-tile"><div class="val small">${fmtDuration(r.longest.durationMin)}</div><div class="lbl">Longest session</div></div>
        <div class="stat-tile"><div class="val small">${Math.round(r.mostElevation.elevationGainM || 0)}m</div><div class="lbl">Biggest climb day</div></div>
        <div class="stat-tile"><div class="val small">${r.topDiscipline[1].meta.disciplineLabel}</div><div class="lbl">Most-trained sport</div></div>
      </div>
    </div>
  `;
}

async function renderTrends() {
  const view = $('#view-trends');
  view.innerHTML = `<h2 class="section-title">Training Load</h2>${skeletonCards(3)}`;
  try {
    const rangeDays = TRENDS_RANGES[state.trendsRange] ?? 90;
    const [summary, wellnessRes, scorecardRes, activities] = await Promise.all([
      api.summary(),
      api.wellness(rangeDays),
      api.scorecard(),
      ensureActivitiesLoaded(),
    ]);
    const acwr = summary.acwr;
    const acwrColor = { 'high-risk': '#e35a48', monitor: '#d6bb85', 'sweet-spot': '#6fae70', undertrained: '#6fb6e0' }[acwr.status] || '#6fae70';

    view.innerHTML = `
      <h2 class="section-title">Training Score</h2>
      ${scorePanelHtml(scorecardRes.scorecard)}

      <h2 class="section-title">Training Load</h2>
      <div class="card" style="text-align:center;">
        <div class="chart-title" style="text-align:left">Acute:Chronic Workload Ratio (ACWR)</div>
        <div class="chart-wrap" style="height:130px;margin-top:4px"><canvas id="acwrGauge"></canvas></div>
        <div class="gauge-scale"><span>0</span><span>2.0×</span></div>
        <div style="margin-top:-38px;font-size:26px;font-weight:800;">${acwr.ratio}×</div>
        <div class="readiness-badge" style="margin-top:8px"><span class="dot" style="background:${acwrColor}"></span>${acwr.status.replace('-', ' ')}</div>
        <div class="hint">Ratio of your acute (7-day avg) to chronic (28-day avg) training load — ${acwr.acute7d ? Math.round(acwr.acute7d / 7) : 0} vs ${acwr.chronic28dAvgDaily} load-points/day. Under 0.8 = undertrained, 0.8-1.3 = sweet spot, over 1.5 = injury-risk territory.</div>
      </div>

      <h2 class="section-title">Last 28 Days by Discipline</h2>
      <div class="card">
        <div class="chart-title">Hours trained, by sport</div>
        <div class="chart-wrap tall"><canvas id="disciplineChart"></canvas></div>
      </div>

      <h2 class="section-title">Daily Training Load</h2>
      <div class="card">
        <div class="chart-title">Session load score (duration × intensity)</div>
        <div class="chart-subtitle">Higher = harder/longer session. Not a real-world unit — only meaningful relative to your own other days.</div>
        <div class="chart-wrap"><canvas id="loadChart"></canvas></div>
      </div>

      <div style="display:flex;align-items:baseline;justify-content:space-between">
        <h2 class="section-title" style="margin-bottom:10px">Long-Term Trends</h2>
      </div>
      <div class="chip-row" id="rangeChips">
        ${Object.keys(TRENDS_RANGES)
          .map(
            (k) =>
              `<div class="chip ${k === state.trendsRange ? 'active' : ''}" data-r="${k}">${{ '30': '30D', '90': '90D', '365': '1Y', all: 'All Time' }[k]}</div>`
          )
          .join('')}
      </div>
      <div class="card">
        <div class="chart-title">Body Battery — daily high &amp; low</div>
        <div class="chart-subtitle">Garmin's 0-100 energy-reserve estimate. High = your peak for the day (usually on waking); Low = your lowest point.</div>
        <div class="chart-wrap"><canvas id="bbChart"></canvas></div>
      </div>
      <div class="card">
        <div class="chart-title">Resting Heart Rate</div>
        <div class="chart-subtitle">Beats per minute, lowest overnight reading. A rising trend can be an early sign of fatigue or illness.</div>
        <div class="chart-wrap"><canvas id="rhrChart"></canvas></div>
      </div>
      <div class="card">
        <div class="chart-title">Sleep Duration</div>
        <div class="chart-subtitle">Hours per night.</div>
        <div class="chart-wrap"><canvas id="sleepTrendChart"></canvas></div>
      </div>

      ${recordsCardHtml(activities)}
    `;

    $$('#rangeChips .chip').forEach((chip) =>
      chip.addEventListener('click', () => {
        state.trendsRange = chip.dataset.r;
        renderTrends();
      })
    );

    gaugeArc($('#acwrGauge'), Math.min(acwr.ratio, 2), 2, acwrColor);

    const byD = summary.byDiscipline28;
    barChart($('#disciplineChart'), {
      labels: byD.map((d) => `${d.icon} ${d.label}`),
      data: byD.map((d) => Math.round(d.durationMin / 60)),
      colors: byD.map((d) => d.color),
      horizontal: true,
      valueLabel: 'Hours',
    });

    const byDay = {};
    for (const r of summary.recentLoad) {
      const day = r.date.slice(0, 10);
      byDay[day] = (byDay[day] || 0) + r.load;
    }
    const dayKeys = Object.keys(byDay).sort();
    lineChart($('#loadChart'), {
      labels: dayKeys.map((d) => d.slice(5)),
      series: [{ label: 'Load', data: dayKeys.map((d) => byDay[d]), color: '#f0793d' }],
      fill: true,
      yLabel: 'Load score',
    });

    const rawW = wellnessRes.wellness;
    const w = rawW.length > 120 ? bucketWeekly(rawW) : rawW;
    const dateLabel = (d) => (rawW.length > 120 ? new Date(d).toLocaleDateString(undefined, { month: 'short', year: '2-digit' }) : d.slice(5));
    lineChart($('#bbChart'), {
      labels: w.map((d) => dateLabel(d.date)),
      series: [
        { label: 'High', data: w.map((d) => d.bodyBatteryHigh), color: '#2ec4cb' },
        { label: 'Low', data: w.map((d) => d.bodyBatteryLow), color: '#4fa3e0' },
      ],
      yLabel: '0-100',
    });
    lineChart($('#rhrChart'), {
      labels: w.map((d) => dateLabel(d.date)),
      series: [{ label: 'Resting HR', data: w.map((d) => d.restingHR), color: '#e35a48' }],
      yLabel: 'bpm',
    });
    lineChart($('#sleepTrendChart'), {
      labels: w.map((d) => dateLabel(d.date)),
      series: [{ label: 'Sleep', data: w.map((d) => d.sleepHours), color: '#ac82a5' }],
      fill: true,
      yLabel: 'Hours',
    });
  } catch (err) {
    view.innerHTML = `<h2 class="section-title">Training Load</h2>${errorCard(err)}`;
  }
}

// ---------------------------------------------------------------- Sleep ----

// A "clock" offset anchored at 6pm, so a bedtime/waketime pair spanning
// midnight is one contiguous [start,end] range instead of wrapping around a
// 0-24 axis -- matches sleepConsistencyChart's expected input in charts.js.
function hoursSince6pm(ms) {
  if (ms == null) return null;
  const d = new Date(ms);
  const h = d.getHours() + d.getMinutes() / 60;
  const offset = h - 18;
  return offset < 0 ? offset + 24 : offset;
}

function fmtMin(min) {
  if (min == null) return '–';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

async function renderSleep() {
  const view = $('#view-sleep');
  view.innerHTML = `<h2 class="section-title">Sleep</h2>${skeletonCards(3)}`;
  try {
    const wellnessRes = await api.wellness(30);
    const nights = wellnessRes.wellness;
    const last = [...nights].reverse().find((d) => d.sleepHours != null) || {};
    const stages = last.sleepStages || {};
    const hasStages = stages.deepMin != null || stages.lightMin != null || stages.remMin != null;
    const recent = nights.slice(-14);

    view.innerHTML = `
      <h2 class="section-title">Last Night</h2>
      <div class="card">
        <div class="stat-row">
          <div class="stat-tile"><div class="val">${last.sleepHours ?? '–'}<span class="ru">h</span></div><div class="lbl">Total sleep</div></div>
          <div class="stat-tile"><div class="val">${last.sleepScore ?? '–'}</div><div class="lbl">Sleep score</div></div>
          <div class="stat-tile"><div class="val">${last.avgRespiration ?? '–'}</div><div class="lbl">Avg. breaths/min</div></div>
          <div class="stat-tile"><div class="val">${last.restlessCount ?? '–'}</div><div class="lbl">Restless moments</div></div>
        </div>
      </div>

      ${
        hasStages
          ? `
      <h2 class="section-title">Sleep Stages</h2>
      <div class="card">
        <div class="chart-subtitle">Most recent night with stage-level detail.</div>
        <div class="chart-wrap" style="height:56px;margin-top:14px"><canvas id="stagesChart"></canvas></div>
        <div class="stage-legend-detail">
          <div><i style="background:#4a3aa7"></i>Deep — ${fmtMin(stages.deepMin)}</div>
          <div><i style="background:#2a78d6"></i>Light — ${fmtMin(stages.lightMin)}</div>
          <div><i style="background:#1baf7a"></i>REM — ${fmtMin(stages.remMin)}</div>
          <div><i style="background:#a8b2ba"></i>Awake — ${fmtMin(stages.awakeMin)}</div>
        </div>
      </div>`
          : `
      <h2 class="section-title">Sleep Stages</h2>
      <div class="card"><div class="empty">Stage-level detail isn't available for last night (older imported data only tracks total hours).</div></div>`
      }

      <h2 class="section-title">Bedtime &amp; Wake Consistency</h2>
      <div class="card">
        <div class="chart-subtitle">Last 14 nights. A tighter, more consistent band here is one of the best levers you have for recovery.</div>
        <div class="chart-wrap"><canvas id="consistencyChart"></canvas></div>
      </div>

      <h2 class="section-title">Sleep Duration Trend</h2>
      <div class="card">
        <div class="chart-subtitle">Last 30 nights.</div>
        <div class="chart-wrap"><canvas id="sleepDurationChart"></canvas></div>
      </div>
    `;

    if (hasStages) {
      stackedBarChart($('#stagesChart'), {
        horizontal: true,
        showLegend: false,
        labels: [''],
        series: [
          { label: 'Deep', data: [stages.deepMin ?? 0], color: '#4a3aa7' },
          { label: 'Light', data: [stages.lightMin ?? 0], color: '#2a78d6' },
          { label: 'REM', data: [stages.remMin ?? 0], color: '#1baf7a' },
          { label: 'Awake', data: [stages.awakeMin ?? 0], color: '#a8b2ba' },
        ],
      });
    }

    sleepConsistencyChart($('#consistencyChart'), {
      labels: recent.map((d) => d.date.slice(5)),
      ranges: recent.map((d) => {
        const start = hoursSince6pm(d.sleepStartMs);
        const end = hoursSince6pm(d.sleepEndMs);
        return start != null && end != null ? [start, end] : null;
      }),
      color: '#ac82a5',
    });

    lineChart($('#sleepDurationChart'), {
      labels: nights.map((d) => d.date.slice(5)),
      series: [{ label: 'Sleep', data: nights.map((d) => d.sleepHours), color: '#ac82a5' }],
      fill: true,
      yLabel: 'Hours',
    });
  } catch (err) {
    view.innerHTML = `<h2 class="section-title">Sleep</h2>${errorCard(err)}`;
  }
}

// ----------------------------------------------------------------- Body ----

function bandClass(band) {
  return String(band || '').toLowerCase().replace(/\s+/g, '-');
}

// Teal -> amber -> orange (all three already used elsewhere in the app's
// validated discipline palette), scaled across a typical athletic-to-average
// body-fat% range. Piecewise through amber rather than a direct teal->orange
// lerp, which crosses a muddy gray-brown band right around the midpoint.
function fatColorRgb(pct) {
  if (pct == null) return [58, 91, 100];
  const t = Math.max(0, Math.min(1, (pct - 6) / (28 - 6)));
  const stops = [
    [0, 176, 185], // teal (lean)
    [237, 161, 0], // amber (mid)
    [235, 104, 52], // orange (higher fat%)
  ];
  const i = t < 0.5 ? 0 : 1;
  const localT = t < 0.5 ? t / 0.5 : (t - 0.5) / 0.5;
  return stops[i].map((c, k) => Math.round(c + (stops[i + 1][k] - c) * localT));
}
function shadeRgb([r, g, b], amt) {
  const mix = (c, target) => Math.round(c + (target - c) * Math.abs(amt));
  return amt >= 0 ? `rgb(${mix(r, 255)},${mix(g, 255)},${mix(b, 255)})` : `rgb(${mix(r, 0)},${mix(g, 0)},${mix(b, 0)})`;
}
const rgbStr = ([r, g, b]) => `rgb(${r},${g},${b})`;

// A stylized front-view figure with real limb tapering (not rectangles),
// per-segment radial gradients (light source upper-left) for a volumetric,
// almost-figurine look, plus a specular highlight ellipse and cast shadow
// on each region, an ellipse ground shadow, and a slight CSS 3D tilt on the
// wrapper (see .figureWrap) — not a true 3D model, but reads as dimensional
// rather than flat. Hover/long-press each region for exact numbers.
function bodyFigureSvg(seg) {
  const region = (key) => seg[key] || {};
  const label = (key, name) => {
    const s = region(key);
    return `${name}: ${s.lean_lbs ?? '–'} lbs lean, ${s.fat_pct ?? '–'}% fat`;
  };
  // Anatomical right/left as if the figure is facing you (its right arm
  // renders on your left), matching how body-scan UIs usually present this.
  const rgb = {
    trunk: fatColorRgb(region('trunk').fat_pct),
    rArm: fatColorRgb(region('right_arm').fat_pct),
    lArm: fatColorRgb(region('left_arm').fat_pct),
    rLeg: fatColorRgb(region('right_leg').fat_pct),
    lLeg: fatColorRgb(region('left_leg').fat_pct),
  };
  const grad = (key, c) => `
        <radialGradient id="bf-${key}" cx="28%" cy="16%" r="95%">
          <stop offset="0%" stop-color="${shadeRgb(c, 0.55)}"/>
          <stop offset="40%" stop-color="${rgbStr(c)}"/>
          <stop offset="100%" stop-color="${shadeRgb(c, -0.42)}"/>
        </radialGradient>`;
  return `
    <svg class="bodyFigure" viewBox="0 0 220 400" role="img" aria-label="Body composition by segment">
      <defs>
        <radialGradient id="bfHead" cx="30%" cy="20%" r="85%">
          <stop offset="0%" stop-color="#5d7c88"/>
          <stop offset="55%" stop-color="#33505a"/>
          <stop offset="100%" stop-color="#182931"/>
        </radialGradient>
        ${Object.entries(rgb).map(([key, c]) => grad(key, c)).join('')}
        <radialGradient id="bfShadow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="rgba(0,0,0,0.35)"/>
          <stop offset="100%" stop-color="rgba(0,0,0,0)"/>
        </radialGradient>
        <radialGradient id="bfShine" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="rgba(255,255,255,0.6)"/>
          <stop offset="60%" stop-color="rgba(255,255,255,0.15)"/>
          <stop offset="100%" stop-color="rgba(255,255,255,0)"/>
        </radialGradient>
      </defs>

      <ellipse cx="110" cy="390" rx="54" ry="8" fill="url(#bfShadow)"/>

      <!-- legs (drawn first so the trunk's hip overlaps their tops) -->
      <path d="M78,182 C70,214 65,246 63,278 C61,304 61,328 64,352 C65,360 76,363 84,359 C85,334 86,306 88,278 C90,248 92,216 96,186 Z"
        fill="url(#bf-rLeg)"><title>${label('right_leg', 'Right leg')}</title></path>
      <ellipse cx="76" cy="230" rx="8" ry="30" fill="url(#bfShine)" opacity="0.45"/>

      <path d="M124,186 C128,216 130,248 132,278 C134,306 135,334 136,359 C144,363 155,360 156,352 C159,328 159,304 157,278 C155,246 150,214 142,182 Z"
        fill="url(#bf-lLeg)"><title>${label('left_leg', 'Left leg')}</title></path>
      <ellipse cx="145" cy="230" rx="8" ry="30" fill="url(#bfShine)" opacity="0.28"/>

      <!-- arms (drawn before trunk + shoulder caps so the seam tucks under) -->
      <path d="M100,80 C78,90 58,106 47,130 C39,150 34,171 32,192 C31,204 31,214 33,224 C39,229 49,228 54,221 C54,204 56,186 60,168 C65,146 75,122 106,96 Z"
        fill="url(#bf-rArm)"><title>${label('right_arm', 'Right arm')}</title></path>
      <ellipse cx="48" cy="150" rx="7.5" ry="30" fill="url(#bfShine)" opacity="0.5"/>

      <path d="M120,80 C142,90 162,106 173,130 C181,150 186,171 188,192 C189,204 189,214 187,224 C181,229 171,228 166,221 C166,204 164,186 160,168 C155,146 145,122 114,96 Z"
        fill="url(#bf-lArm)"><title>${label('left_arm', 'Left arm')}</title></path>
      <ellipse cx="172" cy="150" rx="7.5" ry="30" fill="url(#bfShine)" opacity="0.3"/>

      <!-- shoulder caps: round off the arm/trunk seam without a visible notch -->
      <circle cx="80" cy="90" r="17" fill="url(#bf-trunk)"/>
      <circle cx="140" cy="90" r="17" fill="url(#bf-trunk)"/>

      <!-- trunk -->
      <path d="M64,88 C62,76 82,70 110,70 C138,70 158,76 156,88 C162,106 160,128 152,146 C158,164 156,180 148,192 L72,192 C64,180 62,164 68,146 C60,128 58,106 64,88 Z"
        fill="url(#bf-trunk)"><title>${label('trunk', 'Trunk')}</title></path>
      <ellipse cx="88" cy="100" rx="18" ry="28" fill="url(#bfShine)" opacity="0.4"/>

      <!-- neck -->
      <path d="M96,58 L124,58 L131,82 L89,82 Z" fill="#233942"/>
      <path d="M96,58 L124,58 L127,68 L93,68 Z" fill="#3a5560"/>

      <!-- head -->
      <circle cx="110" cy="38" r="25" fill="url(#bfHead)"><title>Head</title></circle>
      <ellipse cx="100" cy="29" rx="9.5" ry="12.5" fill="url(#bfShine)" opacity="0.5"/>
    </svg>
    <div class="figureLegend">
      <span><i style="background:${rgbStr(fatColorRgb(6))}"></i>Leaner</span>
      <span><i style="background:${rgbStr(fatColorRgb(28))}"></i>Higher fat%</span>
    </div>
  `;
}

async function renderBody() {
  const view = $('#view-body');
  view.innerHTML = `<h2 class="section-title">Body Composition</h2>${skeletonCards(1)}`;
  try {
    const { body } = await api.body();
    if (!body) {
      view.innerHTML = `
        <h2 class="section-title">Body Composition</h2>
        <div class="card empty">No body composition data yet. Import your health data (Settings → Import) to see it here.</div>
      `;
      return;
    }

    const seg = body.segmental || {};
    const segLabels = { right_arm: 'Right arm', left_arm: 'Left arm', trunk: 'Trunk', right_leg: 'Right leg', left_leg: 'Left leg' };
    const maxLean = Math.max(1, ...Object.values(seg).map((s) => s.lean_lbs || 0));

    const comp = body.composition || {};
    const compOrder = ['body_fat_pct', 'lean_mass_lbs', 'skeletal_muscle_mass_lbs', 'visceral_fat_index', 'body_water_pct', 'bmr_cal', 'metabolic_age_yrs'];
    const compLabels = {
      body_fat_pct: 'Body fat',
      lean_mass_lbs: 'Lean mass',
      skeletal_muscle_mass_lbs: 'Skeletal muscle',
      visceral_fat_index: 'Visceral fat',
      body_water_pct: 'Body water',
      bmr_cal: 'BMR',
      metabolic_age_yrs: 'Metabolic age',
    };

    view.innerHTML = `
      <h2 class="section-title">Body Composition</h2>
      <div class="scanner">
        <div class="scanTitle">BODY SCAN <span>· ${body.source || 'scale'}</span></div>
        <div class="scanSub">${body.date ? new Date(body.date).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }) : ''}</div>

        <div class="weightRow"><span class="wv num">${body.weight_lbs ?? '–'}</span><span class="wu">lbs</span></div>

        <div class="figureWrap">${bodyFigureSvg(seg)}</div>

        <div class="segGrid" style="margin-top:14px">
          ${Object.entries(seg)
            .map(
              ([k, v]) => `
            <div class="segCard">
              <div class="sk">${segLabels[k] || k}</div>
              <div class="sv num">${v.lean_lbs ?? '–'}<span class="su"> lbs lean</span></div>
              <div class="su">${v.fat_pct ?? '–'}% fat</div>
              <div class="sbar"><i style="width:${((v.lean_lbs || 0) / maxLean) * 100}%"></i></div>
            </div>`
            )
            .join('')}
        </div>

        <div class="compGrid" style="margin-top:14px">
          ${compOrder
            .filter((k) => comp[k])
            .map(
              (k) => `
            <div class="compCell">
              <div class="ck">${compLabels[k]}</div>
              <div class="cv num">${comp[k].value}<span class="cu"> ${comp[k].unit || ''}</span></div>
              ${comp[k].band ? `<div class="band ${bandClass(comp[k].band)}">${comp[k].band}</div>` : ''}
            </div>`
            )
            .join('')}
        </div>
      </div>

      ${
        body.history && body.history.length > 1
          ? `<h2 class="section-title">Trend</h2><div class="card"><div class="chart-wrap" id="bodyTrendWrap"><canvas id="bodyTrendChart"></canvas></div></div>`
          : ''
      }
    `;

    if (body.history && body.history.length > 1) {
      lineChart($('#bodyTrendChart'), {
        labels: body.history.map((h) => h.date.slice(5)),
        series: [
          { label: 'Body fat %', data: body.history.map((h) => h.body_fat_pct), color: '#f0793d' },
        ],
      });
    }
  } catch (err) {
    view.innerHTML = `<h2 class="section-title">Body Composition</h2>${errorCard(err)}`;
  }
}

// ----------------------------------------------------------------- Plan ----

function previewWeek(plan) {
  const patterns = {
    hard: ['hard', 'moderate', 'recovery', 'moderate', 'hard', 'moderate', 'recovery'],
    recovery: ['recovery', 'moderate', 'moderate', 'hard', 'moderate', 'recovery', 'moderate'],
    moderate: ['moderate', 'hard', 'moderate', 'recovery', 'moderate', 'hard', 'recovery'],
  };
  const seq = patterns[plan.intensity] || patterns.moderate;
  const pool = Object.entries(plan.daysSinceLast)
    .filter(([, days]) => days < 45)
    .sort((a, b) => b[1] - a[1])
    .map(([d]) => d);
  const disciplines = pool.length >= 2 ? pool : Object.keys(plan.daysSinceLast);

  const days = [];
  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    const intensity = i === 0 ? plan.intensity : seq[i];
    const discipline = intensity === 'recovery' ? 'strength' : disciplines[i % disciplines.length];
    days.push({ label: i === 0 ? 'Today' : d.toLocaleDateString(undefined, { weekday: 'short' }), intensity, discipline });
  }
  return days;
}

const INTENSITY_COLOR = { recovery: '#6fb6e0', moderate: '#d6bb85', hard: '#f0793d' };

async function renderPlan() {
  const view = $('#view-plan');
  view.innerHTML = `<h2 class="section-title">Today's Plan</h2>${skeletonCards(2)}`;
  try {
    const { plan } = await api.planToday();
    const r = plan.readiness;
    const week = previewWeek(plan);

    view.innerHTML = `
      <h2 class="section-title">Today's Plan</h2>
      <div class="card">
        <div class="plan-preview" style="margin-bottom:10px">
          <div class="glyph">${plan.icon}</div>
          <div>
            <div class="title">${plan.title}</div>
            <div class="sub">${plan.disciplineLabel} · <span style="color:${INTENSITY_COLOR[plan.intensity]}">${plan.intensity}</span></div>
          </div>
        </div>
        <p style="margin:0 0 8px;font-size:14px;line-height:1.5">${plan.detail}</p>
        <div class="hint">${plan.reason}</div>
      </div>

      ${microHabitsCardHtml()}

      <h2 class="section-title">Readiness — ${r.score}/100</h2>
      <div class="card">
        <div class="stat-row">
          <div class="stat-tile"><div class="val">${r.factors.sleepScore ?? '–'}</div><div class="lbl">Sleep score</div></div>
          <div class="stat-tile"><div class="val">${r.factors.bodyBatteryHigh ?? '–'}</div><div class="lbl">Body battery</div></div>
          <div class="stat-tile"><div class="val">${r.factors.restingHR ?? '–'}</div><div class="lbl">Resting HR</div></div>
          <div class="stat-tile" style="font-size:11px;display:flex;align-items:center;justify-content:center">${r.factors.source === 'device' ? 'device score' : (r.factors.hrvStatus || '–').toLowerCase()}</div>
        </div>
      </div>

      <h2 class="section-title">Next 7 Days (auto-adjusts daily)</h2>
      <div class="card" style="padding:4px 12px">
        ${week
          .map(
            (d) => `
          <div class="activity-item">
            <div class="glyph" style="background:${INTENSITY_COLOR[d.intensity]}22;color:${INTENSITY_COLOR[d.intensity]}">${d.intensity === 'recovery' ? '💤' : d.intensity === 'hard' ? '🔥' : '🟡'}</div>
            <div>
              <div class="name">${d.label}</div>
              <div class="meta">${d.intensity} · ${d.discipline}</div>
            </div>
          </div>`
          )
          .join('')}
      </div>
      <div class="hint" style="margin:0 2px 12px">This preview re-rotates each time you open Plan, based on today's actual readiness — it's a guide, not a fixed schedule.</div>
    `;
  } catch (err) {
    view.innerHTML = `<h2 class="section-title">Today's Plan</h2>${errorCard(err)}`;
  }
}

// ----------------------------------------------------------------- Coach ----

// textContent, never innerHTML, for chat bubbles — this is the one place in
// the app that renders arbitrary free-text (the athlete's own questions),
// so there's no escaping-html-by-hand XSS surface to get wrong.
function appendChatBubble(role, text, container = $('#chatMessages')) {
  const div = document.createElement('div');
  div.className = `chat-bubble ${role}`;
  div.textContent = text;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return div;
}

async function handleChatSubmit(e) {
  e.preventDefault();
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  input.focus();
  state.chatMessages.push({ role: 'user', content: text });
  appendChatBubble('user', text);
  const typing = appendChatBubble('assistant typing', 'Thinking…');
  try {
    const { reply, notes } = await api.chat(state.chatMessages);
    typing.remove();
    state.chatMessages.push({ role: 'assistant', content: reply });
    appendChatBubble('assistant', reply);
    if (Array.isArray(notes)) {
      state.contextNotes = notes;
      contextStore.save(notes);
      renderRememberedNotes();
    }
  } catch (err) {
    typing.remove();
    appendChatBubble('assistant error', err.message || 'Something went wrong reaching the coach.');
  }
}

const NOTE_CATEGORY_ICON = { objective: '🎯', equipment: '🏠', schedule: '📅', other: '💡' };

function renderRememberedNotes() {
  const box = $('#rememberedNotes');
  if (!box) return;
  if (!state.contextNotes.length) {
    box.innerHTML = '';
    box.style.display = 'none';
    return;
  }
  box.style.display = '';
  box.innerHTML = `
    <div class="chart-subtitle" style="margin:0 2px 6px">What the coach remembers about you:</div>
    <div class="chip-row" style="margin-bottom:8px">
      ${state.contextNotes
        .map(
          (n) => `
        <div class="chip note-chip" data-id="${n.id}" title="${n.note.replace(/"/g, '&quot;')}">
          ${NOTE_CATEGORY_ICON[n.category] || '💡'} ${n.note.length > 40 ? n.note.slice(0, 40) + '…' : n.note}
          <span class="note-remove" data-id="${n.id}">×</span>
        </div>`
        )
        .join('')}
    </div>
  `;
  $$('.note-remove', box).forEach((btn) =>
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const { notes } = await api.deleteContextNote(id);
      state.contextNotes = notes;
      contextStore.save(notes);
      renderRememberedNotes();
    })
  );
}

function coachSectionHtml() {
  return `
    <h2 class="section-title">Coach</h2>
    <div id="rememberedNotes"></div>
    <div class="chat-card embedded">
      <div class="chat-messages" id="chatMessages"></div>
      <form class="chat-input-row" id="chatForm">
        <input type="text" id="chatInput" placeholder="Ask about your training, sleep, recovery…" autocomplete="off" />
        <button class="btn chat-send" type="submit" aria-label="Send">➤</button>
      </form>
    </div>
    <div class="hint">Grounded in your real recent training and health data — not generic advice. Not a substitute for a doctor. Tell it about upcoming trips, objectives, or equipment (e.g. "I have a hangboard at home") and it'll remember for next time.</div>
  `;
}

async function initCoachUI() {
  try {
    const { notes } = await api.context();
    state.contextNotes = notes;
    contextStore.save(notes);
  } catch {
    // Non-fatal — chat still works without the remembered-notes list loaded.
  }
  renderRememberedNotes();

  const container = $('#chatMessages');
  if (!state.chatMessages.length) {
    appendChatBubble(
      'assistant',
      "Ask me anything about your training, sleep, recovery, or what to focus on next — I can see your real recent data.",
      container
    );
  } else {
    state.chatMessages.forEach((m) => appendChatBubble(m.role, m.content, container));
  }
  $('#chatForm').addEventListener('submit', handleChatSubmit);
}

// ------------------------------------------------------------- Settings ----

function openSheet(sheet, backdrop) {
  backdrop.classList.add('open');
  requestAnimationFrame(() => sheet.classList.add('open'));
}
function closeSheets() {
  $$('.sheet').forEach((s) => s.classList.remove('open'));
  $('#backdrop').classList.remove('open');
}
$('#backdrop').addEventListener('click', closeSheets);

function invalidateAllCaches() {
  state.activities = null;
}

// Cache the server's CURRENT (merged) import, not the raw file that was
// just uploaded — the server may have carried forward fields the upload
// itself didn't include (e.g. a body-comp snapshot from an older export
// when re-importing a newer one that lacks it, see healthImport.js). This
// is what a redeploy restores from, so it needs to reflect the merged
// truth or a later restore would silently undo the merge.
async function cacheServerImport() {
  try {
    const raw = await api.importHealthRaw();
    await importStore.save(JSON.stringify(raw));
  } catch (err) {
    console.warn('Failed to cache import for redeploy-resilience:', err);
  }
}

async function openSettings() {
  const sheet = $('#settingsSheet');
  const status = await refreshStatus();
  const imp = status.import;
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <h3>Settings</h3>
    <div class="status-line">Garmin session: <b>${status.authenticated ? 'connected' : 'not connected'}</b></div>

    <h2 class="section-title">Data source</h2>
    <div class="radio-row" id="modeRadios">
      ${['auto', 'live', 'demo']
        .map(
          (m) => `<label><input type="radio" name="mode" value="${m}" ${status.modePreference === m ? 'checked' : ''}/><span>${m}</span></label>`
        )
        .join('')}
    </div>
    <div class="hint">Auto uses your Garmin account (or imported history) once available, falling back to demo data otherwise. Live requires a Garmin connection below. Demo always shows the synthetic sample data, even if you've imported your own.</div>

    <h2 class="section-title">Import health data</h2>
    ${
      imp
        ? `<div class="status-line">Imported: <b>${imp.first} → ${imp.last}</b> (${imp.totalDays} days, ${imp.totalWorkouts} workouts)</div>
           <div class="btn-row">
             <button class="btn secondary" id="reimportBtn">Re-import</button>
             <button class="btn danger" id="clearImportBtn">Clear</button>
           </div>`
        : `<input type="file" id="importFile" accept=".json,.html,application/json,text/html" style="display:block;margin-top:6px;font-size:13px" />
           <div class="hint">Upload your data.json or Health-Dashboard.html export. This becomes your activity/wellness history here — live Garmin sync only fills in what's happened since the export's last day. Nothing is sent anywhere but this server.</div>`
    }

    <h2 class="section-title">${status.authenticated ? 'Garmin account' : 'Connect Garmin'}</h2>
    ${
      status.authenticated
        ? `<button class="btn danger" id="logoutBtn" style="width:100%">Disconnect Garmin account</button>`
        : `
      <form class="login-form" id="loginForm">
        <input type="text" name="username" placeholder="Garmin Connect email" autocomplete="username" required />
        <input type="password" name="password" placeholder="Password" autocomplete="current-password" required />
        <button class="btn" type="submit">Connect</button>
      </form>
      <div class="hint">Your credentials are sent only to this server, which uses them once to sign in to connect.garmin.com on your behalf. Only the resulting session token is stored (in <code>server/.data/</code>) — never your password. Accounts with MFA/2FA enabled aren't supported by this form yet (Garmin's login flow will reject it) — see the README for a workaround.</div>
    `
    }

    <h2 class="section-title">Install on your phone</h2>
    <div class="hint">
      <b>iPhone:</b> open this page in Safari → Share → "Add to Home Screen".<br/>
      <b>Android:</b> open in Chrome → menu (⋮) → "Add to Home screen" / "Install app".
    </div>
  `;

  $$('#modeRadios input').forEach((r) =>
    r.addEventListener('change', async () => {
      await api.setMode(r.value);
      invalidateAllCaches();
      await refreshStatus();
      render(state.tab);
      toast(`Mode set to ${r.value}`);
    })
  );

  const importFile = $('#importFile', sheet);
  if (importFile) {
    importFile.addEventListener('change', async () => {
      const file = importFile.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const res = await api.importHealth(text);
        // Also keep a copy of the server's merged result in this browser's
        // own storage — Render's free tier wipes the server's disk on
        // every deploy, so without this a code push would silently erase
        // the import until it's noticed and re-uploaded by hand. See
        // public/js/importStore.js and cacheServerImport() above.
        await cacheServerImport();
        toast(`Imported ${res.import.totalWorkouts} workouts`);
        invalidateAllCaches();
        await refreshStatus();
        openSettings();
        render(state.tab);
      } catch (err) {
        toast(err.message || 'Import failed');
      }
    });
  }
  const reimportBtn = $('#reimportBtn', sheet);
  if (reimportBtn) reimportBtn.addEventListener('click', openSettingsWithImportForm);
  const clearImportBtn = $('#clearImportBtn', sheet);
  if (clearImportBtn) {
    clearImportBtn.addEventListener('click', async () => {
      await api.clearImport();
      await importStore.clear();
      toast('Import cleared');
      invalidateAllCaches();
      await refreshStatus();
      openSettings();
      render(state.tab);
    });
  }

  const loginForm = $('#loginForm', sheet);
  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(loginForm);
      const btn = loginForm.querySelector('button');
      btn.disabled = true;
      btn.textContent = 'Connecting…';
      try {
        await api.login(fd.get('username'), fd.get('password'));
        toast('Connected to Garmin');
        invalidateAllCaches();
        closeSheets();
        await refreshStatus();
        render(state.tab);
      } catch (err) {
        toast(err.message || 'Login failed');
        btn.disabled = false;
        btn.textContent = 'Connect';
      }
    });
  }
  const logoutBtn = $('#logoutBtn', sheet);
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      await api.logout();
      invalidateAllCaches();
      toast('Disconnected');
      await refreshStatus();
      openSettings();
      render(state.tab);
    });
  }

  openSheet(sheet, $('#backdrop'));
}

// A forced re-import: show the file input even though an import already
// exists, so a fresh export can replace it in one step.
function openSettingsWithImportForm() {
  const sheet = $('#settingsSheet');
  const importSection = $$('h2.section-title', sheet).find((h) => h.textContent === 'Import health data');
  if (!importSection) return;
  let el = importSection.nextElementSibling;
  while (el && el.tagName !== 'H2') {
    const next = el.nextElementSibling;
    el.remove();
    el = next;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.id = 'importFile';
  input.accept = '.json,.html,application/json,text/html';
  input.style.cssText = 'display:block;margin-top:6px;font-size:13px';
  importSection.after(input);
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const res = await api.importHealth(text);
      await cacheServerImport();
      toast(`Imported ${res.import.totalWorkouts} workouts`);
      invalidateAllCaches();
      await refreshStatus();
      openSettings();
      render(state.tab);
    } catch (err) {
      toast(err.message || 'Import failed');
    }
  });
}

$('#settingsBtn').addEventListener('click', openSettings);

// ------------------------------------------------------------------ init ----

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/service-worker.js').catch(() => {}));
}

// If the server has no import on file but this browser has a cached copy
// (see public/js/importStore.js), silently re-upload it. This is what
// makes an import survive a Render redeploy without you having to notice
// it's gone and re-upload by hand every time.
async function restoreImportIfNeeded(status) {
  if (status.import) return status;
  const cached = await importStore.get();
  if (!cached) return status;
  try {
    await api.importHealth(cached);
    await cacheServerImport();
    toast('Restored your imported history on this device');
    return refreshStatus();
  } catch (err) {
    console.warn('Failed to restore cached import:', err);
    return status;
  }
}

// Same redeploy-survival pattern as restoreImportIfNeeded, for the Coach's
// remembered notes (see public/js/contextStore.js). This one doesn't need
// a status flag from the server to know whether to run — it just checks
// directly whether the server has anything on record.
async function restoreContextIfNeeded() {
  try {
    const { notes: serverNotes } = await api.context();
    if (serverNotes && serverNotes.length) {
      state.contextNotes = serverNotes;
      return;
    }
    const cached = await contextStore.get();
    if (!cached || !cached.length) return;
    const { notes } = await api.restoreContext(cached);
    state.contextNotes = notes;
  } catch (err) {
    console.warn('Failed to restore cached context notes:', err);
  }
}

(async function init() {
  const status = await refreshStatus();
  await restoreImportIfNeeded(status);
  await restoreContextIfNeeded();
  render(state.tab);
})();
