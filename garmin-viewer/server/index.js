require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path = require('path');
const express = require('express');
const cron = require('node-cron');

const { GarminClient } = require('./garminClient');
const { createRouter } = require('./routes');

const app = express();
const PORT = process.env.PORT || 8123;

app.use(express.json());

const garminClient = new GarminClient();

app.use('/api', createRouter(garminClient));
app.use(express.static(path.join(__dirname, '..', 'public')));

async function bootstrap() {
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
