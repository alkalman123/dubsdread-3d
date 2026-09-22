// Talks to the standalone garmin-backend/ Python service instead of doing a
// live Garmin login from this Node process. That's the whole reason that
// service exists: Garmin's SSO login is Cloudflare-blocked from Render's
// datacenter IPs, but the Python backend gets around it via a one-time
// interactive login done from a residential IP (see garmin-backend/README.md)
// plus the underlying library's own proactive token refresh, so it can run
// server-side indefinitely without re-hitting that blocked endpoint.
//
// This class implements the same public interface GarminClient does
// (authenticated/hasSavedSession/ensureAuth/getActivities/getDailyWellness/
// getActivityDetail/login/logout/restoreSession) so index.js and routes.js
// don't need to know which one is actually backing the app -- it just
// reshapes the Python backend's raw Garmin JSON into the exact shapes
// normalize.js and classify.js already expect from the npm garmin-connect
// library, since both ultimately proxy the same underlying Garmin REST API.

function toDateString(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.toISOString().slice(0, 10);
}

class PythonBackendClient {
  constructor({ baseUrl, apiToken }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiToken = apiToken;
    this.authenticated = false;
    this.lastError = null;
  }

  async _get(path) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: this.apiToken ? { Authorization: `Bearer ${this.apiToken}` } : {},
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`garmin-backend ${path} -> HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json();
  }

  async _post(path) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.apiToken ? { Authorization: `Bearer ${this.apiToken}` } : {},
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`garmin-backend ${path} -> HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json();
  }

  hasSavedSession() {
    // The Python backend owns its own tokenstore entirely server-side; from
    // this app's point of view "has a saved session" and "is currently
    // authenticated" are the same question, so just answer with whatever
    // the last status check found.
    return this.authenticated;
  }

  async restoreSession() {
    return this.ensureAuth();
  }

  async ensureAuth() {
    try {
      const status = await this._get('/api/status');
      this.authenticated = Boolean(status.connected) && !status.needs_relogin;
      this.lastError = status.last_error || null;
      if (status.needs_relogin) {
        console.warn(
          '[garmin-backend] needs re-login -- run `python cli_login.py` from a residential IP and update GARMIN_TOKENSTORE_JSON on the backend service. Last error:',
          status.last_error
        );
      }
    } catch (err) {
      this.authenticated = false;
      this.lastError = err.message;
      console.error('[garmin-backend] status check failed:', err.message);
    }
    return this.authenticated;
  }

  async login() {
    // Live login for this architecture happens once, out-of-band, from a
    // residential IP via `python cli_login.py` in garmin-backend/ -- see
    // that project's README. This app's own login form can't complete it
    // (the whole point of the split is that Render's IP can't reach past
    // Garmin's Cloudflare-protected SSO endpoint), so surface that clearly
    // instead of pretending to try.
    throw new Error(
      'Live Garmin login now happens once, out-of-band, via the garmin-backend service\'s `cli_login.py` (run from your own PC, not from here) -- see garmin-backend/README.md. This form no longer performs a login itself.'
    );
  }

  logout() {
    // Nothing for this Node process to tear down -- the Garmin session
    // lives entirely in the Python backend's own tokenstore. This only
    // exists so routes.js's existing /auth/logout handler has something
    // to call; it does not disconnect the backend.
    console.warn('[garmin-backend] logout() called, but the Garmin session is owned by the backend service and was not changed.');
  }

  async getActivities(limit = 80) {
    const { activities } = await this._get(`/api/activities?limit=${limit}`);
    return activities;
  }

  async getActivityDetail(activityId) {
    // The Python backend doesn't yet expose per-activity detail streams
    // (splits/GPS track/HR-over-time) -- only the list/summary endpoint.
    // Find the matching summary from a wider activity pull and degrade
    // gracefully (empty track/streams) rather than failing the whole
    // activity page, matching how imported-history detail views already
    // behave in routes.js.
    const activities = await this.getActivities(200);
    const summary = activities.find((a) => String(a.activityId) === String(activityId));
    if (!summary) throw new Error(`Activity ${activityId} not found in the last 200 synced activities`);
    return { summary, details: null, splits: null, typedSplits: null };
  }

  async getDailyWellness(date) {
    const ds = toDateString(date);
    const { days } = await this._get(`/api/wellness?start=${ds}&end=${ds}`);
    const day = days && days[0];
    if (!day) {
      return {
        date: ds,
        steps: null,
        sleep: null,
        heartRate: null,
        bodyBattery: null,
        hrv: null,
        trainingReadiness: null,
        trainingStatus: null,
        stress: null,
      };
    }

    const restingHR =
      day.rhr?.allMetrics?.metricsMap?.WELLNESS_RESTING_HEART_RATE?.[0]?.value ??
      day.sleep?.restingHeartRate ??
      null;

    // Gotcha #6 from the backend (see garmin-backend/app/merge.py): HRV is
    // stored tagged by measurement method so the two shapes are never
    // blended. The overnight-summary method carries the same
    // status/lastNightAvg fields the UI has always read, so surface that
    // one here -- the continuous-reading series (day.hrv.reading_method)
    // isn't consumed by this app yet.
    const hrvSummary = day.hrv?.summary_method;

    return {
      date: ds,
      steps: day.summary?.totalSteps ?? day.stats?.totalSteps ?? null,
      sleep: day.sleep,
      heartRate: restingHR != null ? { restingHeartRate: restingHR } : null,
      bodyBattery: day.body_battery,
      hrv: hrvSummary ? { status: hrvSummary.status, lastNightAvg: hrvSummary.last_night_avg } : null,
      trainingReadiness: day.training_readiness,
      trainingStatus: null,
      stress: day.stress,
    };
  }
}

module.exports = { PythonBackendClient, toDateString };
