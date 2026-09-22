require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path = require('path');
const express = require('express');
const cron = require('node-cron');

const { GarminClient } = require('./garminClient');
const { PythonBackendClient } = require('./pythonBackendClient');
const { createRouter } = require('./routes');

const app = express();
const PORT = process.env.PORT || 8123;

// Health-data imports can be tens of MB (years of daily records plus a
// full dashboard HTML export) — well past express.json()'s 100kb default.
// The import upload itself is sent as raw text (see public/js/api.js), so
// express.text() is what actually needs the generous limit; express.json()
// stays smaller since every other route's payloads are small.
app.use(express.json({ limit: '2mb' }));
// Import uploads are always sent as text/plain regardless of whether the
// underlying content is JSON or HTML (server/healthImport.js sniffs the
// actual content, not the header) — that keeps this middleware from ever
// competing with express.json() over an application/json content-type.
app.use(express.text({ limit: '150mb', type: ['text/plain', 'text/html'] }));

// Render (and most PaaS hosts) poll this to know the service is alive.
app.get('/healthz', (req, res) => res.status(200).send('ok'));

// When PYTHON_BACKEND_URL is set, live data comes from the standalone
// garmin-backend/ Python service (see its README) instead of a live Garmin
// login done directly from this process -- that login is Cloudflare-blocked
// from Render's datacenter IPs, which is the whole reason that service
// exists. Leaving it unset keeps the old direct-login path working exactly
// as before for anyone not using the new backend.
const usingPythonBackend = Boolean(process.env.PYTHON_BACKEND_URL);
const garminClient = usingPythonBackend
  ? new PythonBackendClient({ baseUrl: process.env.PYTHON_BACKEND_URL, apiToken: process.env.PYTHON_BACKEND_TOKEN })
  : new GarminClient();

app.use('/api', createRouter(garminClient));
app.use(express.static(path.join(__dirname, '..', 'public')));

async function bootstrap() {
  if (usingPythonBackend) {
    const connected = await garminClient.restoreSession();
    console.log(connected ? '[garmin-backend] connected' : '[garmin-backend] not connected yet — starting in demo mode');
  } else {
    const restored = await garminClient.restoreSession();
    if (!restored && process.env.GARMIN_USERNAME && process.env.GARMIN_PASSWORD) {
      try {
        await garminClient.login(process.env.GARMIN_USERNAME, process.env.GARMIN_PASSWORD);
        console.log('[garmin] logged in with GARMIN_USERNAME from .env');
      } catch (err) {
        console.warn('[garmin] auto-login failed, starting in demo mode:', err.message);
      }
    } else if (restored) {
      console.log('[garmin] restored saved session');
    } else {
      console.log('[garmin] no saved session and no credentials in .env — starting in demo mode');
    }
  }

  const schedule = process.env.SYNC_CRON || '0 */2 * * *';
  if (garminClient.authenticated && cron.validate(schedule)) {
    cron.schedule(schedule, async () => {
      try {
        await garminClient.getActivities(80);
        console.log('[garmin] background sync ok');
      } catch (err) {
        console.warn('[garmin] background sync failed:', err.message);
      }
    });
  }

  app.listen(PORT, () => {
    console.log(`Garmin mountain viewer running at http://localhost:${PORT}`);
  });
}

bootstrap();
