// Thin wrapper around the `garmin-connect` npm package.
//
// Adds: on-disk session persistence (Garmin throttles/locks accounts that
// log in too often, so we reuse the OAuth tokens across restarts), a few
// "mountain athlete" wellness endpoints the library doesn't expose helpers
// for (body battery, HRV status, training readiness, training status,
// per-activity detail streams and typed splits), and light retry-once
// logic on 401s (token expired -> re-login).

const fs = require('fs');
const path = require('path');
const { GarminConnect } = require('garmin-connect');

const TOKEN_DIR = path.join(__dirname, '.data');
const TOKEN_FILE = path.join(TOKEN_DIR, 'tokens.json');

function ensureDataDir() {
  if (!fs.existsSync(TOKEN_DIR)) fs.mkdirSync(TOKEN_DIR, { recursive: true });
}

function toDateString(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.toISOString().slice(0, 10);
}

class GarminClient {
  constructor() {
    this.gc = new GarminConnect({ username: '', password: '' });
    this.authenticated = false;
    this.lastError = null;
  }

  // GC_API base ("https://connectapi.garmin.com"), read off the internal
  // UrlClass instance so we don't have to hardcode the domain twice.
  get apiBase() {
    return this.gc.url.GC_API;
  }

  hasSavedSession() {
    return fs.existsSync(TOKEN_FILE);
  }

  async restoreSession() {
    if (!this.hasSavedSession()) return false;
    try {
      const raw = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      this.gc.loadToken(raw.oauth1, raw.oauth2);
      // Confirm the token still works.
      await this.gc.getUserProfile();
      this.authenticated = true;
      return true;
    } catch (err) {
      this.authenticated = false;
      return false;
    }
  }

  async login(username, password) {
    ensureDataDir();
    await this.gc.login(username, password);
    const tokens = this.gc.exportToken();
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens), { mode: 0o600 });
    this.authenticated = true;
    return true;
  }

  logout() {
    this.authenticated = false;
    if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
  }

  async ensureAuth() {
    if (this.authenticated) return true;
    return this.restoreSession();
  }

  async withRetry(fn) {
    try {
      return await fn();
    } catch (err) {
      const status = err && (err.status || (err.response && err.response.status));
      if (status === 401 && process.env.GARMIN_USERNAME && process.env.GARMIN_PASSWORD) {
        await this.login(process.env.GARMIN_USERNAME, process.env.GARMIN_PASSWORD);
        return fn();
      }
      throw err;
    }
  }

  // ---- Activities -------------------------------------------------------

  async getActivities(limit = 40, start = 0) {
    return this.withRetry(() => this.gc.getActivities(start, limit));
  }

  async getActivityDetail(activityId) {
    return this.withRetry(async () => {
      const [summary, details, splits, typedSplits] = await Promise.all([
        this.gc.getActivity({ activityId }),
        this.gc
          .get(`${this.apiBase}/activity-service/activity/${activityId}/details`, {
            params: { maxChartSize: 2000, maxPolylineSize: 4000 },
          })
          .catch(() => null),
        this.gc
          .get(`${this.apiBase}/activity-service/activity/${activityId}/splits`)
          .catch(() => null),
        this.gc
          .get(`${this.apiBase}/activity-service/activity/${activityId}/typedsplits`)
          .catch(() => null),
      ]);
      return { summary, details, splits, typedSplits };
    });
  }

  // ---- Wellness / recovery -----------------------------------------------

  async getDailyWellness(date = new Date()) {
    const ds = toDateString(date);
    return this.withRetry(async () => {
      const [steps, sleep, heartRate, bodyBattery, hrv, trainingReadiness, trainingStatus, stress] =
        await Promise.all([
          this.gc.getSteps(date).catch(() => null),
          this.gc.getSleepData(date).catch(() => null),
          this.gc.getHeartRate(date).catch(() => null),
          this.gc
            .get(`${this.apiBase}/wellness-service/wellness/bodyBattery/reports/daily`, {
              params: { startDate: ds, endDate: ds },
            })
            .catch(() => null),
          this.gc.get(`${this.apiBase}/hrv-service/hrv/${ds}`).catch(() => null),
          this.gc
            .get(`${this.apiBase}/metrics-service/metrics/trainingreadiness/${ds}`)
            .catch(() => null),
          this.gc
            .get(`${this.apiBase}/metrics-service/metrics/trainingstatus/aggregated/${ds}`)
            .catch(() => null),
          this.gc.get(`${this.apiBase}/wellness-service/wellness/dailyStress/${ds}`).catch(() => null),
        ]);
      return { date: ds, steps, sleep, heartRate, bodyBattery, hrv, trainingReadiness, trainingStatus, stress };
    });
  }
}

module.exports = { GarminClient, toDateString };
