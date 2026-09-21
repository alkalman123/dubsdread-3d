import { api } from './api.js';
import { lineChart, barChart, gaugeArc } from './charts.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  tab: 'today',
  mode: 'demo',
  activityFilter: 'all',
  activities: null,
};

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
  else if (tab === 'plan') renderPlan();
}

// -------------------------------------------------------------- status ----

async function refreshStatus() {
  try {
    const s = await api.status();
    state.mode = s.mode;
    const pill = $('#modePill');
    pill.textContent = s.mode;
    pill.className = `mode-pill ${s.mode}`;
    return s;
  } catch {
    return { mode: 'demo', authenticated: false };
  }
}

// --------------------------------------------------------------- Today ----

async function renderToday() {
  const view = $('#view-today');
  view.innerHTML = `<h2 class="section-title">Briefing</h2>${skeletonCards(1)}<h2 class="section-title">Today</h2>${skeletonCards(1)}`;
  try {
    const hour = new Date().getHours();
    const isMorning = hour < 15;
    const [briefing, wellnessRes, actsRes] = await Promise.all([
      isMorning ? api.briefingMorning() : api.briefingEvening(),
      api.wellness(2),
      api.activities(5),
    ]);
    const today = wellnessRes.wellness[wellnessRes.wellness.length - 1] || {};
    const plan = briefing.plan || (await api.planToday()).plan;
    const acts = actsRes.activities;

    view.innerHTML = `
      <h2 class="section-title">${isMorning ? 'Morning Briefing' : 'Evening Wrap-up'}</h2>
      <div class="card briefing-card">
        <div class="kicker">${isMorning ? '☀️ Good morning' : '🌙 Day complete'}</div>
        <p>${briefing.text}</p>
      </div>

      <h2 class="section-title">Today's Numbers</h2>
      <div class="stat-row">
        <div class="stat-tile"><div class="val">${today.bodyBatteryHigh ?? '–'}</div><div class="lbl">Body Battery</div></div>
        <div class="stat-tile"><div class="val">${today.sleepHours ?? '–'}h</div><div class="lbl">Sleep</div></div>
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
    `;
    $('#planPreviewCard').addEventListener('click', () => switchTab('plan'));
    renderActivityListInto($('#recentList'), acts, { compact: true });
  } catch (err) {
    view.innerHTML = `<h2 class="section-title">Briefing</h2>${errorCard(err)}`;
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
    if (!state.activities) {
      const res = await api.activities(60);
      state.activities = res.activities;
    }
    const disciplines = Array.from(new Map(state.activities.map((a) => [a.discipline, a])).values());
    const chips = ['all', ...disciplines.map((d) => d.discipline)];
    const labelFor = (d) => (d === 'all' ? 'All' : disciplines.find((x) => x.discipline === d)?.disciplineLabel || d);

    view.innerHTML = `
      <h2 class="section-title">Activities</h2>
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
    const filtered = state.activityFilter === 'all' ? state.activities : state.activities.filter((a) => a.discipline === state.activityFilter);
    renderActivityListInto($('#activityList'), filtered);
  } catch (err) {
    view.innerHTML = `<h2 class="section-title">Activities</h2>${errorCard(err)}`;
  }
}

let map;
async function openActivitySheet(id) {
  const sheet = $('#activitySheet');
  const backdrop = $('#backdrop');
  sheet.innerHTML = `<div class="sheet-handle"></div>${skeletonCards(2)}`;
  openSheet(sheet, backdrop);
  try {
    const { activity: a, track, streams, splits } = await api.activity(id);
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
        ['climbing', 'mountaineering', 'ski', 'hiking'].includes(a.discipline)
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
      lineChart($('#hrChart'), { labels, series: [{ label: 'HR', data: streams.hr, color: '#ef5b6b' }] });
    }
    if (streams.elevation && streams.elevation.length) {
      const labels = (streams.timeSec || []).map((s) => `${Math.round(s / 60)}m`);
      lineChart($('#eleChart'), { labels, series: [{ label: 'Elevation', data: streams.elevation, color: '#c9a3ff' }], fill: true });
    }
  } catch (err) {
    sheet.innerHTML = `<div class="sheet-handle"></div>${errorCard(err)}`;
  }
}

// --------------------------------------------------------------- Trends ----

async function renderTrends() {
  const view = $('#view-trends');
  view.innerHTML = `<h2 class="section-title">Training Load</h2>${skeletonCards(3)}`;
  try {
    const [summary, wellnessRes] = await Promise.all([api.summary(), api.wellness(30)]);
    const acwr = summary.acwr;
    const acwrColor = { 'high-risk': '#ef5b6b', monitor: '#e8d24a', 'sweet-spot': '#7ee88a', undertrained: '#4ab0e8' }[acwr.status] || '#7ee88a';

    view.innerHTML = `
      <h2 class="section-title">Training Load</h2>
      <div class="card" style="text-align:center;">
        <div class="chart-wrap" style="height:130px"><canvas id="acwrGauge"></canvas></div>
        <div style="margin-top:-46px;font-size:26px;font-weight:700;">${acwr.ratio}</div>
        <div class="readiness-badge" style="margin-top:8px"><span class="dot" style="background:${acwrColor}"></span>${acwr.status.replace('-', ' ')}</div>
        <div class="hint">Acute (7d avg) ${acwr.acute7d ? Math.round(acwr.acute7d / 7) : 0} vs chronic (28d avg) ${acwr.chronic28dAvgDaily} training load per day.</div>
      </div>

      <h2 class="section-title">Last 28 Days by Discipline</h2>
      <div class="card"><div class="chart-wrap tall"><canvas id="disciplineChart"></canvas></div></div>

      <h2 class="section-title">Daily Training Load (30d)</h2>
      <div class="card"><div class="chart-wrap"><canvas id="loadChart"></canvas></div></div>

      <h2 class="section-title">Recovery Trend</h2>
      <div class="card"><div class="chart-wrap"><canvas id="bbChart"></canvas></div></div>
      <div class="card"><div class="chart-wrap"><canvas id="rhrChart"></canvas></div></div>
    `;

    gaugeArc($('#acwrGauge'), Math.min(acwr.ratio, 2), 2, acwrColor);

    const byD = summary.byDiscipline28;
    barChart($('#disciplineChart'), {
      labels: byD.map((d) => `${d.icon} ${d.label}`),
      data: byD.map((d) => Math.round(d.durationMin / 60)),
      colors: byD.map((d) => d.color),
      horizontal: true,
    });

    const byDay = {};
    for (const r of summary.recentLoad) {
      const day = r.date.slice(0, 10);
      byDay[day] = (byDay[day] || 0) + r.load;
    }
    const dayKeys = Object.keys(byDay).sort();
    lineChart($('#loadChart'), {
      labels: dayKeys.map((d) => d.slice(5)),
      series: [{ label: 'Load', data: dayKeys.map((d) => byDay[d]), color: '#e8734a' }],
      fill: true,
    });

    const w = wellnessRes.wellness;
    lineChart($('#bbChart'), {
      labels: w.map((d) => d.date.slice(5)),
      series: [
        { label: 'Body Battery High', data: w.map((d) => d.bodyBatteryHigh), color: '#7ee88a' },
        { label: 'Body Battery Low', data: w.map((d) => d.bodyBatteryLow), color: '#4ab0e8' },
      ],
    });
    lineChart($('#rhrChart'), {
      labels: w.map((d) => d.date.slice(5)),
      series: [{ label: 'Resting HR', data: w.map((d) => d.restingHR), color: '#ef5b6b' }],
    });
  } catch (err) {
    view.innerHTML = `<h2 class="section-title">Training Load</h2>${errorCard(err)}`;
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
    const discipline = intensity === 'recovery' ? 'hiking' : disciplines[i % disciplines.length];
    days.push({ label: i === 0 ? 'Today' : d.toLocaleDateString(undefined, { weekday: 'short' }), intensity, discipline });
  }
  return days;
}

const INTENSITY_COLOR = { recovery: '#4ab0e8', moderate: '#e8d24a', hard: '#e8734a' };

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

      <h2 class="section-title">Readiness — ${r.score}/100</h2>
      <div class="card">
        <div class="stat-row">
          <div class="stat-tile"><div class="val">${r.factors.sleepScore ?? '–'}</div><div class="lbl">Sleep score</div></div>
          <div class="stat-tile"><div class="val">${r.factors.bodyBatteryHigh ?? '–'}</div><div class="lbl">Body battery</div></div>
          <div class="stat-tile"><div class="val">${r.factors.restingHR ?? '–'}</div><div class="lbl">Resting HR</div></div>
          <div class="stat-tile" style="font-size:11px;display:flex;align-items:center;justify-content:center">${(r.factors.hrvStatus || '–').toLowerCase()}</div>
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

async function openSettings() {
  const sheet = $('#settingsSheet');
  const status = await refreshStatus();
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
    <div class="hint">Auto uses your Garmin account once connected below, and falls back to demo data otherwise.</div>

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
      state.activities = null;
      await refreshStatus();
      render(state.tab);
      toast(`Mode set to ${r.value}`);
    })
  );

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
        state.activities = null;
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
      state.activities = null;
      toast('Disconnected');
      await refreshStatus();
      openSettings();
      render(state.tab);
    });
  }

  openSheet(sheet, $('#backdrop'));
}
$('#settingsBtn').addEventListener('click', openSettings);

// ------------------------------------------------------------------ init ----

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/service-worker.js').catch(() => {}));
}

(async function init() {
  await refreshStatus();
  render(state.tab);
})();
