// Small in-memory + on-disk cache. Garmin Connect's undocumented API will
// throttle or lock an account that gets hammered, so every live fetch goes
// through here: results are reused for `ttlMs`, and the last good result
// for a key is kept on disk so a transient Garmin failure still lets the
// dashboard render something instead of an error screen.

const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '.data', 'cache');
const mem = new Map();

function ensureDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function fileFor(key) {
  return path.join(CACHE_DIR, `${key.replace(/[^a-z0-9_-]/gi, '_')}.json`);
}

function readDisk(key) {
  try {
    return JSON.parse(fs.readFileSync(fileFor(key), 'utf8'));
  } catch {
    return null;
  }
}

function writeDisk(key, value) {
  try {
    ensureDir();
    fs.writeFileSync(fileFor(key), JSON.stringify({ savedAt: Date.now(), value }));
  } catch {
    // Non-fatal: worst case we just don't have a stale fallback.
  }
}

async function remember(key, ttlMs, fn) {
  const hit = mem.get(key);
  if (hit && Date.now() - hit.savedAt < ttlMs) return hit.value;

  try {
    const value = await fn();
    mem.set(key, { savedAt: Date.now(), value });
    writeDisk(key, value);
    return value;
  } catch (err) {
    if (hit) return hit.value; // stale-in-memory beats an error
    const disk = readDisk(key);
    if (disk) return disk.value; // stale-on-disk beats an error
    throw err;
  }
}

function invalidate(prefix) {
  for (const key of mem.keys()) {
    if (key.startsWith(prefix)) mem.delete(key);
  }
}

module.exports = { remember, invalidate };
