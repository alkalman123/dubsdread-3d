/* ---------------------------------------------------------------------------
 * BRANDING — the only file you edit to re-skin this preview for another course.
 *
 * Everything below is safe to change without touching the renderer. Pair it with
 * a course-data.js generated for that club (see tools/README.md) and the same
 * engine ships as their product.
 * ------------------------------------------------------------------------- */
window.BRANDING = {

  /* --- identity ---------------------------------------------------------- */
  club:      'Cog Hill Golf & Country Club',
  course:    'Dubsdread',
  courseSub: 'Course No. 4',
  location:  'Lemont, Illinois',

  /** 2–3 letters for the crest, or '' to hide it. */
  crest: 'CH',

  /** Shown in the browser tab and when the link is shared. */
  title: 'Dubsdread · Cog Hill No. 4 — Interactive Course Preview',

  /* --- colour ------------------------------------------------------------ */
  /** Accent used for the crest, hole numbers, active states and the tracer. */
  accent: '#c9a227',
  /** Panel tint. Keep it dark — the UI sits over a bright 3D scene. */
  panel: 'rgba(14,18,17,.80)',

  /* --- call to action ---------------------------------------------------- */
  /** Leave url empty to hide the button entirely. */
  cta: {
    label: 'Book a tee time',
    url: ''
  },

  /* --- footer ------------------------------------------------------------ */
  /**
   * Attribution. The OpenStreetMap credit is required by the ODbL licence when
   * the model is derived from OSM data — leave it in unless the course geometry
   * has been replaced with the club's own as-built survey.
   */
  credit:
    'Routing, greens, bunkers &amp; hazards derived from OpenStreetMap (ODbL). ' +
    'Terrain from USGS 3DEP 10&nbsp;m elevation. ' +
    'A visual preview — not a survey document. ' +
    // Drop this last sentence once a club has actually licensed the preview;
    // until then a publicly shared link should not imply they commissioned it.
    'An independent demonstration, not affiliated with or endorsed by the club.',

  /* --- defaults ---------------------------------------------------------- */
  /** Where a visitor lands. Any of these can be overridden by the URL. */
  defaults: {
    hole: 1,
    camera: 'tee',        // tee | approach | green | flyover | aerial | free
    tee: 0,               // index into the hole's tee list, 0 = back tee
    lighting: 'midday',   // morning | midday | afternoon | golden | overcast
    quality: 'auto'       // high | fast | auto
  },

  /**
   * Kiosk mode: cycle every hole on the flyover camera, hands-free. Good for a
   * clubhouse screen or a trade stand. Also reachable with ?tour=1.
   */
  kiosk: {
    enabled: false,
    secondsPerHole: 26
  }
};
