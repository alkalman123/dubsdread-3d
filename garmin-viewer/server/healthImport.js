// Ingests an export from an external health-data pipeline (the
// `window.__HEALTH_DATA__` blob baked into a Health-Dashboard.html build, or
// a bare data.json with the same shape) so this app can work from the same
// multi-year, multi-source dataset instead of only what Garmin Connect's
// API returns.
//
// This is intentionally a manual import, not a live integration: the
// pipeline that produces this data runs on the user's own machine and isn't
// reachable from wherever this app is hosted. Re-importing an updated
// export is how the dataset grows over time.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '.data');
const IMPORT_FILE = path.join(DATA_DIR, 'healthImport.json');

const BLOB_RE = /window\.__HEALTH_DATA__\s*=\s*(\{[\s\S]*?\});/;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Accepts either the raw JSON text of data.json, or a full HTML page with
// window.__HEALTH_DATA__ = {...}; embedded in a <script> tag.
function parseImportPayload(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('Empty import payload');

  let jsonText = text;
  if (text.startsWith('<') || BLOB_RE.test(text)) {
    const match = text.match(BLOB_RE);
    if (!match) throw new Error('Could not find window.__HEALTH_DATA__ in the uploaded file');
    jsonText = match[1];
  }

  let data;
  try {
    data = JSON.parse(jsonText);
  } catch (err) {
    throw new Error('Uploaded file is not valid JSON: ' + err.message);
  }

  if (!Array.isArray(data.days) || !Array.isArray(data.workouts)) {
    throw new Error('This does not look like a health-data export (missing days[]/workouts[])');
  }
  return data;
}

// Body composition (from a smart scale like a Hume Pod) and free-text
// insights don't come from every export -- notably the large converted
// Apple Health dump doesn't carry them at all, only the original
// Health-Dashboard.html export did. Body comp changes slowly enough that a
// stale snapshot is still worth having, so a re-import that's missing
// these fields keeps whatever was already on record rather than silently
// dropping it. A re-import that DOES carry a new value still overwrites,
// same as always -- this only fills gaps, never blocks a real update.
function mergeForward(newData, existingData) {
  if (!existingData) return newData;
  const merged = { ...newData };
  if (!merged.body && existingData.body) merged.body = existingData.body;
  if ((!Array.isArray(merged.insights) || !merged.insights.length) && Array.isArray(existingData.insights) && existingData.insights.length) {
    merged.insights = existingData.insights;
  }
  return merged;
}

function saveImport(data) {
  ensureDir();
  const merged = mergeForward(data, loadImport());
  fs.writeFileSync(IMPORT_FILE, JSON.stringify(merged));
  return merged;
}

function loadImport() {
  try {
    return JSON.parse(fs.readFileSync(IMPORT_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function clearImport() {
  if (fs.existsSync(IMPORT_FILE)) fs.unlinkSync(IMPORT_FILE);
}

function importSummary(data) {
  if (!data) return null;
  return {
    generated: data.generated || null,
    first: data.meta?.first || null,
    last: data.meta?.last || null,
    totalDays: data.meta?.totalDays ?? data.days.length,
    totalWorkouts: data.meta?.totalWorkouts ?? data.workouts.length,
    hasBody: Boolean(data.body),
    hasInsights: Array.isArray(data.insights) && data.insights.length > 0,
  };
}

module.exports = { parseImportPayload, saveImport, loadImport, clearImport, importSummary };
