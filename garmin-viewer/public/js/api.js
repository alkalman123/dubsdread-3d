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
};
