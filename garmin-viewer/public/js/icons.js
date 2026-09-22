// A small, self-contained icon system: SF-Symbols-style monochrome stroke
// icons (2px stroke, round caps/joins, currentColor) so they tint correctly
// wherever they're dropped -- a discipline chip, a severity badge, a plan
// intensity glyph. Path data below is vendored from lucide-static (ISC
// license, see public/vendor/icons/LICENSE.txt) and baked in directly
// rather than fetched per-icon at runtime: ~40 icons is a few KB total,
// well worth avoiding 40 extra network round-trips on a phone that might
// be opening this as a cold-started, possibly-offline installed PWA.
//
// The server (server/classify.js) still sends an emoji per discipline/
// intensity for backwards compatibility with anything reading the raw API
// directly -- the client just doesn't render it anymore. ICON_FOR_* below
// maps the same semantic keys the server already uses onto icon names.

const PATHS = {
  'activity': `<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />`,
  'award': `<path d="m15.477 12.89 1.515 8.526a.5.5 0 0 1-.81.47l-3.58-2.687a1 1 0 0 0-1.197 0l-3.586 2.686a.5.5 0 0 1-.81-.469l1.514-8.526" /><circle cx="12" cy="8" r="6" />`,
  'bed': `<path d="M2 4v16" /><path d="M2 8h18a2 2 0 0 1 2 2v10" /><path d="M2 17h20" /><path d="M6 8v9" />`,
  'bike': `<circle cx="18.5" cy="17.5" r="3.5" /><circle cx="5.5" cy="17.5" r="3.5" /><circle cx="15" cy="5" r="1" /><path d="M12 17.5V14l-3-3 4-3 2 3h2" />`,
  'calendar': `<path d="M8 2v3" /><path d="M16 2v3" /><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18" />`,
  'check': `<path d="M20 6 9 17l-5-5" />`,
  'chevron-right': `<path d="m9 18 6-6-6-6" />`,
  'circle-dot': `<circle cx="12" cy="12" r="1" /><circle cx="12" cy="12" r="10" />`,
  'clock': `<circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" />`,
  'dna': `<path d="m10 16 1.5 1.5" /><path d="m14 8-1.5-1.5" /><path d="M15 2c-1.798 1.998-2.518 3.995-2.807 5.993" /><path d="m16.5 10.5 1 1" /><path d="m17 6-2.891-2.891" /><path d="M2 15c6.667-6 13.333 0 20-6" /><path d="m20 9 .891.891" /><path d="M3.109 14.109 4 15" /><path d="m6.5 12.5 1 1" /><path d="m7 18 2.891 2.891" /><path d="M9 22c1.798-1.998 2.518-3.995 2.807-5.993" />`,
  'download': `<path d="M12 15V3" /><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" />`,
  'dumbbell': `<path d="M17.596 12.768a2 2 0 1 0 2.829-2.829l-1.768-1.767a2 2 0 0 0 2.828-2.829l-2.828-2.828a2 2 0 0 0-2.829 2.828l-1.767-1.768a2 2 0 1 0-2.829 2.829z" /><path d="m2.5 21.5 1.4-1.4" /><path d="m20.1 3.9 1.4-1.4" /><path d="M5.343 21.485a2 2 0 1 0 2.829-2.828l1.767 1.768a2 2 0 1 0 2.829-2.829l-6.364-6.364a2 2 0 1 0-2.829 2.829l1.768 1.767a2 2 0 0 0-2.828 2.829z" /><path d="m9.6 14.4 4.8-4.8" />`,
  'flame': `<path d="M12 3q1 4 4 6.5t3 5.5a1 1 0 0 1-14 0 5 5 0 0 1 1-3 1 1 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4" />`,
  'footprints': `<path d="M4 16v-2.38C4 11.5 2.97 10.5 3 8c.03-2.72 1.49-6 4.5-6C9.37 2 10 3.8 10 5.5c0 3.11-2 5.66-2 8.68V16a2 2 0 1 1-4 0Z" /><path d="M20 20v-2.38c0-2.12 1.03-3.12 1-5.62-.03-2.72-1.49-6-4.5-6C14.63 6 14 7.8 14 9.5c0 3.11 2 5.66 2 8.68V20a2 2 0 1 0 4 0Z" /><path d="M16 17h4" /><path d="M4 13h4" />`,
  'gauge': `<path d="m12 14 4-4" /><path d="M3.34 19a10 10 0 1 1 17.32 0" />`,
  'hand': `<path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2" /><path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2" /><path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8" /><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />`,
  'heart-pulse': `<path d="M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5" /><path d="M3.22 13H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27" />`,
  'home': `<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" /><path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />`,
  'list': `<path d="M3 5h.01" /><path d="M3 12h.01" /><path d="M3 19h.01" /><path d="M8 5h13" /><path d="M8 12h13" /><path d="M8 19h13" />`,
  'log-in': `<path d="m10 17 5-5-5-5" /><path d="M15 12H3" /><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />`,
  'log-out': `<path d="m16 17 5-5-5-5" /><path d="M21 12H9" /><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />`,
  'map-pin': `<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0" /><circle cx="12" cy="10" r="3" />`,
  'moon': `<path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401" />`,
  'mountain-snow': `<path d="m8 3 4 8 5-5 5 15H2L8 3z" /><path d="M4.14 15.08c2.62-1.57 5.24-1.43 7.86.42 2.74 1.94 5.49 2 8.23.19" />`,
  'mountain': `<path d="m8 3 4 8 5-5 5 15H2L8 3z" />`,
  'person-standing': `<circle cx="12" cy="5" r="1" /><path d="m9 20 3-6 3 6" /><path d="m6 8 6 2 6-2" /><path d="M12 10v4" />`,
  'plus': `<path d="M5 12h14" /><path d="M12 5v14" />`,
  'refresh-cw': `<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" />`,
  'route': `<circle cx="6" cy="19" r="3" /><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15" /><circle cx="18" cy="5" r="3" />`,
  'settings': `<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" /><circle cx="12" cy="12" r="3" />`,
  'share': `<path d="M12 2v13" /><path d="m16 6-4-4-4 4" /><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />`,
  'smartphone': `<rect width="14" height="20" x="5" y="2" rx="2" ry="2" /><path d="M12 18h.01" />`,
  'snowflake': `<path d="m10 20-1.25-2.5L6 18" /><path d="M10 4 8.75 6.5 6 6" /><path d="m14 20 1.25-2.5L18 18" /><path d="m14 4 1.25 2.5L18 6" /><path d="m17 21-3-6h-4" /><path d="m17 3-3 6 1.5 3" /><path d="M2 12h6.5L10 9" /><path d="m20 10-1.5 2 1.5 2" /><path d="M22 12h-6.5L14 15" /><path d="m4 10 1.5 2L4 14" /><path d="m7 21 3-6-1.5-3" /><path d="m7 3 3 6h4" />`,
  'sport-shoe': `<path d="m15 10.42 4.8-5.07" /><path d="M19 18h3" /><path d="M9.5 22 21.414 9.415A2 2 0 0 0 21.2 6.4l-5.61-4.208A1 1 0 0 0 14 3v2a2 2 0 0 1-1.394 1.906L8.677 8.053A1 1 0 0 0 8 9c-.155 6.393-2.082 9-4 9a2 2 0 0 0 0 4h14" />`,
  'sun': `<circle cx="12" cy="12" r="4" /><path d="M12 2v2" /><path d="M12 20v2" /><path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" /><path d="M2 12h2" /><path d="M20 12h2" /><path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" />`,
  'target': `<circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" />`,
  'trash': `<path d="M10 11v6" /><path d="M14 11v6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />`,
  'trending-up': `<path d="M16 7h6v6" /><path d="m22 7-8.5 8.5-5-5L2 17" />`,
  'upload': `<path d="M12 3v12" /><path d="m17 8-5-5-5 5" /><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />`,
  'waves': `<path d="M2 12q2.5 2 5 0t5 0 5 0 5 0" /><path d="M2 19q2.5 2 5 0t5 0 5 0 5 0" /><path d="M2 5q2.5 2 5 0t5 0 5 0 5 0" />`,
  'x': `<path d="M18 6 6 18" /><path d="m6 6 12 12" />`,
};

// Renders one icon as an inline <svg> markup string. `size` is CSS px on
// both axes; stroke-width stays fixed at Lucide's authored 2 (matching the
// "SF-Symbols-like ~1.5-2px stroke" spec) regardless of size, since scaling
// it down at small sizes reads as thin/weak rather than crisp.
export function icon(name, { size = 20, className = '', strokeWidth = 2, label } = {}) {
  const d = PATHS[name];
  if (!d) return '';
  const cls = className ? ` class="${className}"` : '';
  const a11y = label ? ` role="img" aria-label="${label}"` : ' aria-hidden="true"';
  return `<svg${cls} width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"${a11y}>${d}</svg>`;
}

// Semantic lookup tables, keyed by the same strings the server already
// uses (discipline id, plan intensity, tab name) -- app.js swaps an emoji
// interpolation for icon(ICON_FOR_DISCIPLINE[a.discipline]) etc. rather
// than each call site hardcoding an icon name.
export const ICON_FOR_DISCIPLINE = {
  biking: 'bike',
  climbing: 'hand',
  cardio: 'heart-pulse',
  strength: 'dumbbell',
  slacklining: 'route',
  hiking: 'footprints',
  mountaineering: 'mountain-snow',
  running: 'sport-shoe',
  ski: 'snowflake',
  water: 'waves',
  walking: 'person-standing',
  other: 'circle-dot',
};

export const ICON_FOR_INTENSITY = {
  recovery: 'moon',
  moderate: 'activity',
  hard: 'flame',
};

export const ICON_FOR_TAB = {
  today: 'home',
  activities: 'list',
  trends: 'trending-up',
  sleep: 'moon',
  body: 'dna',
  plan: 'target',
};
