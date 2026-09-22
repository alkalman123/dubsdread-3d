async function req(path, opts) {
  const res = await fetch(`/api${path}`, {
    headers: { 'content-type': 'application/json' },
    ...opts,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || body.detail || `Request failed: ${path}`);
  return body;
}

export const api = {
  status: () => req('/status'),
  setMode: (mode) => req('/mode', { method: 'POST', body: JSON.stringify({ mode }) }),
  login: (username, password) => req('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => req('/auth/logout', { method: 'POST' }),
  activities: (limit = 40) => req(`/activities?limit=${limit}`),
  activity: (id) => req(`/activities/${id}`),
  wellness: (days = 30) => req(`/wellness?days=${days}`),
  summary: () => req('/summary'),
  planToday: () => req('/plan/today'),
  briefingMorning: () => req('/briefing/morning'),
  briefingEvening: () => req('/briefing/evening'),
  body: () => req('/body'),
  insights: () => req('/insights'),
  scorecard: () => req('/scorecard'),
  importStatus: () => req('/import/health'),
  // Sent as raw text/plain, not JSON-wrapped — imports can be tens of MB
  // (years of daily records), and JSON-escaping a blob that size just to
  // unwrap it server-side would waste memory and bandwidth for nothing.
  importHealth: (raw) => req('/import/health', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: raw }),
  importHealthRaw: () => req('/import/health/raw'),
  clearImport: () => req('/import/health', { method: 'DELETE' }),
  addManualActivity: (entry) => req('/activities/manual', { method: 'POST', body: JSON.stringify(entry) }),
  chat: (messages) => req('/chat', { method: 'POST', body: JSON.stringify({ messages }) }),
  context: () => req('/context'),
  restoreContext: (notes) => req('/context', { method: 'POST', body: JSON.stringify({ notes }) }),
  deleteContextNote: (id) => req(`/context/${id}`, { method: 'DELETE' }),
};
