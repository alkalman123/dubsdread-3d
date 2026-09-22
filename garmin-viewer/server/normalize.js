// Defensive parsing of Garmin Connect's undocumented wellness/detail
// payloads. Field names below match the shapes documented by the
// long-running python-garminconnect community project, but Garmin changes
// these without notice — every access is optional-chained with a sane
// fallback so a shape change degrades a chart instead of crashing a route.

function get(obj, pathArr, fallback = null) {
  let cur = obj;
  for (const k of pathArr) {
    if (cur == null) return fallback;
    cur = cur[k];
  }
  return cur == null ? fallback : cur;
}

function normalizeWellnessDay(date, raw) {
  const sleepDto = get(raw, ['sleep', 'dailySleepDTO']);
  const stagesSum =
    get(sleepDto, ['deepSleepSeconds'], 0) +
    get(sleepDto, ['lightSleepSeconds'], 0) +
    get(sleepDto, ['remSleepSeconds'], 0);
  const sleepSeconds = get(sleepDto, ['sleepTimeSeconds']) ?? (stagesSum || null);
  const sleepScore =
    get(sleepDto, ['sleepScores', 'overall', 'value']) ?? get(raw, ['sleep', 'overallSleepScore']) ?? null;

  const bbDay = Array.isArray(raw.bodyBattery) ? raw.bodyBattery[0] : null;
  const bbValues = get(bbDay, ['bodyBatteryValuesArray'], []) || [];
  const bbLevels = bbValues.map((v) => (Array.isArray(v) ? v[1] : v && v.level)).filter((v) => typeof v === 'number');
  const bodyBatteryHigh = bbLevels.length ? Math.max(...bbLevels) : get(bbDay, ['charged']);
  const bodyBatteryLow = bbLevels.length ? Math.min(...bbLevels) : get(bbDay, ['drained']);

  const hrvStatus = get(raw, ['hrv', 'hrvSummary', 'status']) || get(raw, ['hrv', 'status']) || null;
  const hrvMs = get(raw, ['hrv', 'hrvSummary', 'lastNightAvg']) ?? get(raw, ['hrv', 'lastNightAvg']) ?? null;

  const restingHR = get(raw, ['heartRate', 'restingHeartRate']) ?? null;
  const stressAvg = get(raw, ['stress', 'avgStressLevel']) ?? get(raw, ['stress', 'overallStressLevel']) ?? null;
  const steps = typeof raw.steps === 'number' ? raw.steps : null;

  // Sleep detail for the Sleep tab. Only live/imported-from-Garmin days
  // carry stage/timing detail (the older flat health-import format only
  // ever had total hours) -- these all come back null for those days,
  // which the Sleep tab treats as "not available" rather than zero.
  const toMin = (sec) => (sec != null ? Math.round(sec / 60) : null);
  const sleepStages = {
    deepMin: toMin(get(sleepDto, ['deepSleepSeconds'])),
    lightMin: toMin(get(sleepDto, ['lightSleepSeconds'])),
    remMin: toMin(get(sleepDto, ['remSleepSeconds'])),
    awakeMin: toMin(get(sleepDto, ['awakeSleepSeconds'])),
  };
  const sleepStartMs = get(sleepDto, ['sleepStartTimestampLocal']) ?? get(sleepDto, ['sleepStartTimestampGMT']);
  const sleepEndMs = get(sleepDto, ['sleepEndTimestampLocal']) ?? get(sleepDto, ['sleepEndTimestampGMT']);
  const avgRespiration = get(sleepDto, ['averageRespirationValue']);
  const restlessCount = get(raw, ['sleep', 'restlessMomentsCount']);

  return {
    date,
    steps,
    sleepHours: sleepSeconds ? Number((sleepSeconds / 3600).toFixed(1)) : null,
    sleepScore,
    bodyBatteryHigh,
    bodyBatteryLow,
    restingHR,
    hrvStatus,
    hrvMs,
    stressAvg,
    sleepStages,
    sleepStartMs,
    sleepEndMs,
    avgRespiration,
    restlessCount,
  };
}

// Garmin's activity "details" endpoint returns a columnar structure:
// metricDescriptors describe each column (by `key`), activityDetailMetrics
// holds one row (`metrics` array) per sample, aligned by column index.
function extractStreams(details) {
  const descriptors = get(details, ['metricDescriptors'], []) || [];
  const rows = get(details, ['activityDetailMetrics'], []) || [];
  if (!descriptors.length || !rows.length) return { timeSec: [], hr: [], elevation: [], speedKmh: [], distanceKm: [] };

  const idx = {};
  for (const d of descriptors) idx[d.key] = d.metricsIndex ?? d.index;

  const col = (key) => (idx[key] != null ? rows.map((r) => r.metrics[idx[key]]) : null);
  const timestamps = col('directTimestamp') || col('sumElapsedDuration') || rows.map((_, i) => i);
  const t0 = timestamps[0] || 0;

  return {
    timeSec: timestamps.map((t) => Math.round(((t - t0) / (t0 > 1e10 ? 1000 : 1)) || 0)),
    hr: col('directHeartRate') || [],
    elevation: (col('directElevation') || []).map((v) => (v != null ? Math.round(v) : null)),
    speedKmh: (col('directSpeed') || []).map((v) => (v != null ? Number((v * 3.6).toFixed(1)) : null)),
    distanceKm: (col('sumDistance') || []).map((v) => (v != null ? Number((v / 1000).toFixed(2)) : null)),
  };
}

function extractTrack(details, summary) {
  const polyline = get(details, ['geoPolylineDTO', 'polyline'], []) || [];
  if (polyline.length) {
    return polyline
      .filter((p) => p.lat != null && p.lon != null)
      .map((p) => ({ lat: p.lat, lon: p.lon, ele: p.altitude != null ? Math.round(p.altitude) : null }));
  }
  const descriptors = get(details, ['metricDescriptors'], []) || [];
  const rows = get(details, ['activityDetailMetrics'], []) || [];
  const idx = {};
  for (const d of descriptors) idx[d.key] = d.metricsIndex ?? d.index;
  if (idx.directLatitude != null && idx.directLongitude != null && rows.length) {
    return rows
      .map((r) => ({
        lat: r.metrics[idx.directLatitude],
        lon: r.metrics[idx.directLongitude],
        ele: idx.directElevation != null ? Math.round(r.metrics[idx.directElevation] || 0) : null,
      }))
      .filter((p) => p.lat && p.lon);
  }
  // Last resort: a straight line between start and end so the map isn't empty.
  if (summary && summary.startLat && summary.startLon) {
    const end = summary.endLat && summary.endLon ? { lat: summary.endLat, lon: summary.endLon } : { lat: summary.startLat, lon: summary.startLon };
    return [{ lat: summary.startLat, lon: summary.startLon, ele: null }, end];
  }
  return [];
}

module.exports = { normalizeWellnessDay, extractStreams, extractTrack };
