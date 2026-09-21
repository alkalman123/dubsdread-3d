// Synthetic "mountain athlete" dataset so the app is fully explorable
// before you ever connect a real Garmin account. Deterministic (seeded
// PRNG) so it looks the same on every server restart.

function mulberry32(seed) {
  let a = seed;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20240921);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const between = (lo, hi) => lo + rand() * (hi - lo);

// Home base: a Front Range mountain town. Every route wanders out from here.
const BASE = { lat: 40.0176, lon: -105.2797 };

const TEMPLATES = [
  {
    typeKey: 'rock_climbing', label: 'Rock Climbing', discipline: 'climbing',
    durationMin: [90, 240], distanceKm: [0.2, 1.5], gainM: [40, 260],
    hr: [95, 150], titles: ['The Fang', 'Eldorado Canyon', 'North Table Mesa', 'Boulder Canyon Trad Day'],
  },
  {
    typeKey: 'bouldering', label: 'Bouldering', discipline: 'climbing',
    durationMin: [60, 150], distanceKm: [0, 0.3], gainM: [0, 20],
    hr: [90, 140], titles: ['Gym Session — Power Endurance', 'Flagstaff Boulders', 'Gym 4x4 Pyramid'],
  },
  {
    typeKey: 'mountain_biking', label: 'Mountain Biking', discipline: 'biking',
    durationMin: [70, 210], distanceKm: [15, 45], gainM: [250, 1100],
    hr: [120, 168], titles: ['Betasso Loop', 'Heil Ranch Singletrack', 'Walker Ranch Loop', 'Hall Ranch'],
  },
  {
    typeKey: 'gravel_cycling', label: 'Gravel Ride', discipline: 'biking',
    durationMin: [90, 240], distanceKm: [40, 95], gainM: [300, 1200],
    hr: [115, 160], titles: ['Peak to Peak Gravel', 'Lefthand Canyon Loop', 'Jamestown Out-and-Back'],
  },
  {
    typeKey: 'road_biking', label: 'Road Ride', discipline: 'biking',
    durationMin: [60, 180], distanceKm: [25, 90], gainM: [150, 900],
    hr: [125, 165], titles: ['Sunday Long Ride', 'Flagstaff Repeats', 'Boulder Creek Path Spin'],
  },
  {
    typeKey: 'trail_running', label: 'Trail Run', discipline: 'running',
    durationMin: [35, 130], distanceKm: [6, 24], gainM: [150, 900],
    hr: [130, 175], titles: ['Bear Peak Loop', 'Sanitas Repeats', 'Green Mountain Trail Run', 'NCAR Loop'],
  },
  {
    typeKey: 'mountaineering', label: 'Mountaineering', discipline: 'mountaineering',
    durationMin: [240, 540], distanceKm: [10, 22], gainM: [900, 1700],
    hr: [110, 155], titles: ['Longs Peak — Keyhole', 'Mt. Evans East Ridge', 'Torreys via Kelso Ridge'],
  },
  {
    typeKey: 'hiking', label: 'Hike', discipline: 'hiking',
    durationMin: [60, 240], distanceKm: [6, 18], gainM: [200, 800],
    hr: [95, 135], titles: ['Chautauqua to Bear Peak', 'Royal Arch', 'Mesa Trail'],
  },
  {
    typeKey: 'backcountry_skiing_ws', label: 'Backcountry Ski Tour', discipline: 'ski',
    durationMin: [150, 330], distanceKm: [8, 16], gainM: [600, 1300],
    hr: [110, 150], titles: ['Berthoud Pass Tour', 'James Peak Skin', 'Butler Gulch'],
  },
];

const REST_BIAS = 0.32; // ~2-3 rest days/week

function genLatLonTrack(distanceKm, gainM, points = 40) {
  const track = [];
  let lat = BASE.lat + between(-0.05, 0.05);
  let lon = BASE.lon + between(-0.05, 0.05);
  let ele = 1600 + between(-100, 200);
  const dLat = between(-1, 1) * 0.0009 * (distanceKm / points) * 10;
  const dLon = between(-1, 1) * 0.0009 * (distanceKm / points) * 10;
  for (let i = 0; i < points; i++) {
    const t = i / (points - 1);
    const wobble = Math.sin(t * Math.PI * between(1.5, 3)) * 0.0025;
    lat += dLat / points + wobble * 0.02 * rand();
    lon += dLon / points + wobble * 0.02 * rand();
    const climbShape = Math.sin(t * Math.PI); // up then down
    ele = 1600 + climbShape * gainM * between(0.9, 1.1) + between(-15, 15);
    track.push({ lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)), ele: Math.round(ele) });
  }
  return track;
}

function genStream(durationMin, hrRange, points = 60) {
  const hr = [];
  const pace = [];
  const elevation = [];
  let base = hrRange[0];
  for (let i = 0; i < points; i++) {
    const t = i / (points - 1);
    const ramp = Math.min(1, t * 6); // warm-up ramp
    const wobble = Math.sin(t * Math.PI * between(3, 6)) * 6;
    base = hrRange[0] + ramp * (hrRange[1] - hrRange[0]) * between(0.55, 1) + wobble;
    hr.push(Math.round(Math.max(hrRange[0] - 10, Math.min(hrRange[1] + 8, base))));
    pace.push(Number((between(3.5, 9)).toFixed(2))); // min/km, rough
    elevation.push(Math.round(1600 + Math.sin(t * Math.PI) * between(100, 400)));
  }
  return { timeMin: Array.from({ length: points }, (_, i) => Number(((i / (points - 1)) * durationMin).toFixed(1))), hr, pace, elevation };
}

function buildActivities(days = 42) {
  const activities = [];
  let id = 900000;
  const now = new Date();
  for (let d = days; d >= 0; d--) {
    if (rand() < REST_BIAS) continue;
    const t = pick(TEMPLATES);
    const date = new Date(now);
    date.setDate(date.getDate() - d);
    date.setHours(Math.round(between(6, 18)), Math.round(between(0, 59)), 0, 0);

    const durationMin = between(t.durationMin[0], t.durationMin[1]);
    const distanceKm = between(t.distanceKm[0], t.distanceKm[1]);
    const gainM = between(t.gainM[0], t.gainM[1]);
    const avgHR = Math.round(between(t.hr[0], t.hr[1]));
    const maxHR = Math.round(Math.min(195, avgHR + between(10, 28)));
    const track = genLatLonTrack(distanceKm, gainM);
    const streams = genStream(durationMin, t.hr);

    id += 1;
    activities.push({
      activityId: id,
      activityName: `${pick(t.titles)}`,
      activityType: { typeKey: t.typeKey },
      startTimeLocal: date.toISOString(),
      distance: Math.round(distanceKm * 1000),
      duration: Math.round(durationMin * 60),
      elapsedDuration: Math.round(durationMin * 60 * between(1, 1.15)),
      elevationGain: Math.round(gainM),
      elevationLoss: Math.round(gainM * between(0.85, 1)),
      averageHR: avgHR,
      maxHR,
      calories: Math.round(durationMin * between(6, 12)),
      averageSpeed: distanceKm > 0 ? (distanceKm * 1000) / (durationMin * 60) : 0,
      startLatitude: track[0].lat,
      startLongitude: track[0].lon,
      endLatitude: track[track.length - 1].lat,
      endLongitude: track[track.length - 1].lon,
      minElevation: Math.min(...track.map((p) => p.ele)),
      maxElevation: Math.max(...track.map((p) => p.ele)),
      _demo: { track, streams },
    });
  }
  return activities.sort((a, b) => new Date(b.startTimeLocal) - new Date(a.startTimeLocal));
}

const ACTIVITIES = buildActivities(45);

function buildWellness(days = 45) {
  const out = [];
  const now = new Date();
  let load = 40;
  for (let d = days; d >= 0; d--) {
    const date = new Date(now);
    date.setDate(date.getDate() - d);
    const ds = date.toISOString().slice(0, 10);
    const hadHardDay = rand() < 0.3;
    load = Math.max(15, Math.min(95, load + (hadHardDay ? between(10, 25) : -between(5, 15))));
    const sleepHours = between(5.5, 8.7);
    const sleepScore = Math.round(Math.max(35, Math.min(97, sleepHours * 11 + between(-8, 8))));
    const bodyBatteryHigh = Math.round(Math.max(55, Math.min(100, 100 - (100 - load) * 0.2 + between(-5, 5))));
    const bodyBatteryLow = Math.round(Math.max(5, bodyBatteryHigh - between(35, 70)));
    const restingHR = Math.round(46 + (100 - sleepScore) * 0.08 + between(-2, 2));
    const hrvStatus = sleepScore > 70 && load < 70 ? 'BALANCED' : sleepScore < 50 || load > 80 ? 'UNBALANCED' : 'LOW';
    out.push({
      date: ds,
      steps: Math.round(between(2500, 15000)),
      sleepHours: Number(sleepHours.toFixed(1)),
      sleepScore,
      bodyBatteryHigh,
      bodyBatteryLow,
      restingHR,
      hrvStatus,
      hrvMs: Math.round(between(28, 78)),
      stressAvg: Math.round(Math.max(10, Math.min(70, 100 - bodyBatteryHigh + between(-10, 10)))),
      trainingLoad: Math.round(load),
    });
  }
  return out;
}

const WELLNESS = buildWellness(45);

module.exports = { ACTIVITIES, WELLNESS };
