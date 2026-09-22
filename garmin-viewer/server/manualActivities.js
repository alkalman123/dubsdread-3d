// Manually-logged activities: a way to widen what the training-load and
// workout-planner engines see beyond whatever's synced from Garmin or a
// data-pipeline import — e.g. a gym climbing session your watch didn't
// record, or a ride from before you had a Garmin at all.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '.data');
const FILE = path.join(DATA_DIR, 'manualActivities.json');
const ID_BASE = 800000000;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeAll(list) {
  ensureDir();
  fs.writeFileSync(FILE, JSON.stringify(list));
}

// entry: { typeKey, name, date (YYYY-MM-DD or ISO), durationMin, distanceKm,
//          elevationGainM, avgHR, calories }
function addManualActivity(entry) {
  if (!entry.typeKey) throw new Error('typeKey is required');
  if (!entry.date) throw new Error('date is required');
  const durationMin = Number(entry.durationMin) || 0;
  if (durationMin <= 0) throw new Error('durationMin must be a positive number');

  const list = readAll();
  const id = ID_BASE + list.length;
  const startTimeLocal = /T/.test(entry.date) ? entry.date : `${entry.date}T12:00:00`;
  const distanceKm = Number(entry.distanceKm) || 0;
  const raw = {
    activityId: id,
    activityName: entry.name || null,
    activityType: { typeKey: entry.typeKey },
    startTimeLocal,
    distance: distanceKm * 1000,
    duration: durationMin * 60,
    elevationGain: Number(entry.elevationGainM) || 0,
    elevationLoss: 0,
    averageHR: entry.avgHR ? Number(entry.avgHR) : null,
    maxHR: null,
    calories: entry.calories ? Number(entry.calories) : null,
    averageSpeed: distanceKm ? (distanceKm * 1000) / (durationMin * 60) : 0,
    startLatitude: null,
    startLongitude: null,
    minElevation: null,
    maxElevation: null,
    _manual: true,
  };
  list.push(raw);
  writeAll(list);
  return raw;
}

function listManualActivities() {
  return readAll();
}

function removeManualActivity(id) {
  const list = readAll().filter((a) => a.activityId !== Number(id));
  writeAll(list);
}

module.exports = { addManualActivity, listManualActivities, removeManualActivity };
