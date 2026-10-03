/* HUD for the hole-1 proof of concept.
 *
 * Replaces js/ui.js entirely rather than extending it, because the thing being
 * driven is different: the original is a chooser (pick a hole, pick a camera,
 * watch a shot), this is a round of golf on one hole with a caddie and a
 * scorecard. The green book is the piece worth looking at — it reads the actual
 * height field the ball rolls on, so the contours it draws and the break the
 * putt takes are the same data.
 */
(function (root) {
  'use strict';

  const App = root.App;
  const Play = root.Play;
  const SP = root.ShotPoc;
  const { clamp, lerp, M4 } = root.MM;
  const $ = id => document.getElementById(id);
  const M2Y = 1.09361, Y2M = 0.9144;
  const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  /* Plain-English names for the frame stages, for when one of them fails. */
  const STAGE = {
    physics: 'the ball physics', meter: 'the swing meter', render: 'the 3D view',
    check: 'the display check', shot: 'the shot animation', labels: 'the on-screen labels'
  };

  /* One palette for the whole outcome story, so a colour on the breakdown bar is
     the same colour as the dots it describes on the map. */
  const SURF = {
    fairway: { c: '#5f9c3f', n: 'Fairway' },
    green:   { c: '#7ec24f', n: 'Green' },
    fringe:  { c: '#6ba844', n: 'Fringe' },
    tee:     { c: '#5f9c3f', n: 'Tee' },
    rough:   { c: '#38602c', n: 'Rough' },
    native:  { c: '#8a7c3c', n: 'Native' },
    sand:    { c: '#d8c795', n: 'Bunker' },
    path:    { c: '#8b8b86', n: 'Path' },
    water:   { c: '#3a7fa8', n: 'Water' }
  };

  const CAMS = [
    ['play', 'Play'], ['follow', 'Follow'], ['putt', 'Putt'],
    ['green', 'Green'], ['flyover', 'Flyover'], ['aerial', 'Aerial'], ['free', 'Free']
  ];

  const UI = {
    labels: [],
    tab: 'map',

    /* ------------------------------------------------------------- boot */
    async boot() {
      const canvas = $('gl');
      const bar = $('bar').firstElementChild;
      const msg = $('loadMsg');
      let done = 0;
      const steps = 6;

      if (typeof root.COURSE === 'undefined') return this.fail('Course data did not load.');
      /* The check that shipped, restored. Creating the context here myself and
         handing it to js/app.js was meant to help browsers that refuse the
         first set of attributes; it also inserted a new way to fail into the
         one path that was already working, on machines I cannot test. Ask the
         plain question, and if the answer is no, say so and offer the build
         that does not need one. */
      if (!document.createElement('canvas').getContext('webgl2')) {
        /* Somebody who opened the link wants to play, not to read about
           graphics settings. Send them to the build that needs no GPU, with
           the hole they asked for; ?stay=1 keeps the explanation instead. */
        const q = new URLSearchParams(location.search);
        if (q.get('stay') !== '1') {
          q.set('from', 'nogl');
          location.replace('flat.html?' + q.toString());
          return;
        }
        this.explainNoWebGL2();
        return;
      }

      root.UI = this;

      /* Deep links, the same idea as the original preview's: the URL carries the
         state so "look at the 1st at golden hour" is a link.
         ?t=1190&cover=45&wind=6&q=fast&cam=play&f=2.8 */
      const p = new URLSearchParams(location.search);
      const num = (k, dflt) => { const v = parseFloat(p.get(k)); return isNaN(v) ? dflt : v; };
      const P = App.poc;
      P.minutes = clamp(num('t', P.minutes), 240, 1320);
      if (p.get('t') !== null) P.realSky = null;
      if (p.get('sky') !== null) P.realSky = p.get('sky') || null;
      P.cloudCover = clamp(num('cover', P.cloudCover * 100) / 100, 0, 1);
      P.turbidity = clamp(num('haze', P.turbidity * 10) / 10, 1, 7);
      P.fStop = clamp(num('f', P.fStop), 1.8, 32);
      if (p.get('date')) P.date = p.get('date');
      if (p.get('safe') === '1') { P.safeMode = true; P.ao = false; P.dof = false; P.shafts = false; }
      /* Start light and let the player turn it up. Sniffing the GPU meant
         creating a throwaway context on every boot to read a string browsers
         increasingly refuse to give — cost and risk for a guess. The tier
         buttons are right there, and the watchdog comes down further on its
         own if even this is too much. */
      /* A phone gets the tier built for it; anything else starts at "fast",
         which is the full look less depth of field. The frame-rate watch in
         the loop steps down on its own if this machine cannot hold it, so a
         weak laptop ends up where "low" used to put everybody — and everybody
         else gets shadows, occlusion and HDR light. */
      const phone = matchMedia('(pointer: coarse)').matches &&
                    Math.min(screen.width, screen.height) < 820;
      App.quality = App.TIERS && App.TIERS[p.get('q')] ? p.get('q')
                  : phone ? 'mobile' : 'fast';
      this.qPinned = !!(App.TIERS && App.TIERS[p.get('q')]);
      /* The tier owns which passes run. Applying it here rather than only when
         the tier changes is what makes the choice mean anything on the first
         frame — which is the frame that decides whether the driver survives. */
      if (App.tier) {
        const T = App.tier();
        P.ao = T.ao; P.dof = T.dof; P.shafts = T.shafts;
      }
      App.wind.speed = clamp(num('wind', 0), 0, 16);
      App.wind.dir = num('wdir', 200);
      this.deepCam = p.get('cam');
      this.deepHole = clamp(Math.round(num('hole', 1)), 1, 18);
      this.deepTee = Math.max(0, Math.round(num('tee', 0)));

      /* A loading screen that sits there is indistinguishable from one that has
         hung, and startup on a slow machine is genuinely tens of seconds — the
         field, the tree line and a dozen shader programs all get built before
         the first frame. Show the clock, and after half a minute say what to do
         about it rather than leaving the player to guess. */
      let stage = 'starting';
      const t0 = Date.now();
      const ticker = setInterval(() => {
        const secs = Math.round((Date.now() - t0) / 1000);
        msg.textContent = stage + '… ' + secs + 's';
        if (secs === 30) {
          const el = $('lStuck');
          if (el) el.style.display = 'block';
        }
      }, 1000);

      try {
        await App.init(canvas, label => {
          if (label) { stage = label; msg.textContent = label + '…'; bar.style.width = Math.round((done++ / steps) * 100) + '%'; }
          else { bar.style.width = '100%'; msg.textContent = 'Ready'; }
        });
        clearInterval(ticker);
      } catch (e) {
        clearInterval(ticker);
        console.error(e);
        // A renderer that will not start is still no reason to be unable to play
        return this.fail(null,
          '<div style="text-align:left;max-width:620px;margin:0 auto;line-height:1.65">' +
          '<a href="flat.html" style="display:block;text-align:center;margin:0 0 14px;' +
          'background:linear-gradient(#d8b23a,#b4901e);color:#1a1508;text-decoration:none;' +
          'font-weight:700;font-size:13px;padding:11px 14px;border-radius:9px">' +
          'Play the no-GPU version →</a>' +
          '<div style="color:#e07a5f;margin-bottom:6px">The 3D renderer could not start ' +
          'on this machine.</div><div style="opacity:.85">' + esc((e && e.message) || String(e)) +
          '</div></div>');
      }

      App.profile = 'tour';
      App.teeSet = this.deepTee;
      if (this.deepHole !== App.hole) {
        // the engine booted on hole 1; walk to the requested one before the
        // round starts so the card is not opened on the wrong hole
        await App.loadHoleAsync(this.deepHole, false, null);
      }
      Play.init();

      this.buildCamBar();
      this.buildStrip();
      this.buildClubs();
      this.buildTees();
      this.bindControls();
      this.bindCanvas(canvas);
      this.syncConditions();
      this.onPlayChanged();
      if (this.deepCam && CAMS.some(c => c[0] === this.deepCam)) App.setCamera(this.deepCam, true);

      if (App.shaderNotes && App.shaderNotes.length) {
        this.gpuWarning({
          notes: ['this driver would not build: ' + App.shaderNotes.join(', ') +
                  ' — those details are off, the rest is unaffected'],
          failed: false
        });
      }

      setTimeout(() => $('load').classList.add('done'), 350);
      this.loop();

      /* Test hooks. A render loop never lets the page go quiet, so an automated
         screenshot has to be able to stop it and take the pixels itself. */
      App.watchContext && App.watchContext();
      root.__ready = true;
      root.__pause = () => { this.paused = true; };
      root.__resume = () => { this.paused = false; };
      root.__grab = () => { App.render(1 / 60); return $('gl').toDataURL('image/png'); };
    },

    /* ---------------------------------------------------- hole transition
     * The rebuild is a few hundred milliseconds during which the frame is
     * frozen. Cutting to black over it reads as walking to the next tee; not
     * covering it reads as a hang. The veil also hides the one frame where the
     * camera has snapped to a new tee but the labels have not caught up.
     */
    async goHole(n, opts) {
      const o = opts || {};
      if (App.loading || this.walking) return;
      n = clamp(n, 1, 18);
      if (n === App.hole && !o.force) return;
      // never leave a hole mid-flight: the ball is still resolving
      if (Play.state.phase === 'flying') { this.flash('Wait for the ball to finish'); return; }

      this.walking = true;
      $('done').classList.remove('on');
      $('cardModal').style.display = 'none';
      $('veilTxt').textContent = o.label ||
        (n === App.hole ? 'Re-teeing' : 'Walking to the ' + this.ordinal(n));
      $('veil').classList.add('on');
      $('veilTxt').classList.add('on');
      // let the fade actually paint before the main thread is taken for the build
      await new Promise(r => setTimeout(r, 240));

      try {
        await App.loadHoleAsync(n, false, null);
        Play.newHole(n);
      } catch (e) {
        console.error(e);
        this.flash('Could not load that hole');
      }

      this.buildTees();
      this.onPlayChanged();
      this.refreshStrip();
      this.syncUrl();
      // one frame on the new hole before lifting the veil, so it fades up onto
      // the finished scene rather than onto the last frame of the old one
      await new Promise(r => requestAnimationFrame(() => setTimeout(r, 60)));
      $('veil').classList.remove('on');
      $('veilTxt').classList.remove('on');
      this.walking = false;
    },

    /** Keep the address bar on the current hole so a reload stays put. */
    syncUrl() {
      try {
        const u = new URL(location.href);
        u.searchParams.set('hole', App.hole);
        u.searchParams.set('tee', App.teeSet);
        history.replaceState(null, '', u);
      } catch (e) { /* some hosts disallow rewriting the address */ }
    },

    ordinal(n) {
      const s = ['th', 'st', 'nd', 'rd'];
      const v = n % 100;
      return n + (s[(v - 20) % 10] || s[v] || s[0]);
    },

    /** Phones and low-core machines get the cheaper build automatically. */
    looksLowPowered() {
      const cores = navigator.hardwareConcurrency || 8;
      return cores <= 4 || matchMedia('(pointer: coarse)').matches || window.innerWidth < 900;
    },

    /**
     * Tell the player when the renderer had to fall back.
     *
     * A silent degrade is how a blank canvas happens: the JavaScript keeps
     * running, the HUD keeps updating, and nothing anywhere says the 3D is not
     * being drawn. If a buffer could not be made, say so on screen and offer the
     * one link that is most likely to work.
     */
    gpuWarning(gpu) {
      /* Accumulate. The render-target fallback and the frame guard can both
         have something to say, and the second one must not erase the first. */
      this.notes = this.notes || [];
      for (const n of (gpu.notes || [])) if (this.notes.indexOf(n) < 0) this.notes.push(n);
      this.notesBad = this.notesBad || !!(gpu.failed || gpu.lost);
      this.notesFlat = this.notesFlat || !!gpu.flat;

      let el = $('gpuWarn');
      if (!el) {
        el = document.createElement('div');
        el.id = 'gpuWarn';
        el.style.cssText = 'position:fixed;left:50%;top:14px;transform:translateX(-50%);' +
          'z-index:12;max-width:min(620px,92vw);background:rgba(20,12,8,.94);' +
          'border:1px solid rgba(224,168,60,.55);color:#f0e2b4;padding:10px 14px;' +
          'border-radius:10px;font-size:12px;line-height:1.5;backdrop-filter:blur(8px);' +
          'box-shadow:0 12px 40px rgba(0,0,0,.5)';
        document.body.appendChild(el);
      }
      const safeUrl = (() => {
        try { const u = new URL(location.href); u.searchParams.set('safe', '1'); return u.toString(); }
        catch (e) { return '?safe=1'; }
      })();
      el.innerHTML =
        '<b style="color:var(--gold)">Graphics fallback</b><br>' +
        this.notes.map(n => '· ' + esc(n)).join('<br>') +
        (this.notesBad
          ? '<br><a href="' + safeUrl + '" style="color:#9fd">Try safe mode</a>'
          : '') +
        (this.notesFlat
          ? ' &nbsp;·&nbsp; <a href="flat.html" style="color:var(--gold);font-weight:700">' +
            'Play the no-GPU version →</a>'
          : '') +
        '<span style="float:right;cursor:pointer;opacity:.6" onclick="this.parentNode.remove()">✕</span>';
    },

    /* --------------------------------------------------------- frame guard
     * One subsystem throwing must not take the rest of the frame with it, and
     * it must never fail silently: a swallowed exception in the draw call is
     * exactly how a blank canvas with a live, correct HUD happens. Each stage
     * runs on its own, reports the first failure on screen, and switches
     * itself off if it keeps failing rather than throwing sixty times a
     * second forever.
     */
    fc: 0,

    step(stage, fn) {
      if (this.dead && this.dead[stage]) return;
      try {
        fn();
        if (this.fails) this.fails[stage] = 0;
      } catch (e) {
        this.fails = this.fails || {};
        this.dead = this.dead || {};
        const n = (this.fails[stage] = (this.fails[stage] || 0) + 1);
        if (n === 1) {
          console.error('[dubsdread] ' + stage + ' failed', e);
          this.gpuWarning({
            notes: [STAGE[stage] + ' hit an error: ' + ((e && e.message) || String(e))],
            failed: true
          });
        } else if (n === 90) {
          this.dead[stage] = true;
          this.gpuWarning({ notes: [STAGE[stage] + ' has been switched off after repeated errors'], failed: true });
        }
      }
    },

    /**
     * Step down before the driver gives up.
     *
     * Windows resets a GPU that has not answered for about two seconds, and
     * Chrome then either loses the context — a black canvas under a working
     * HUD — or stalls hard enough that the picture simply stops. Neither
     * presents as "slow", so waiting for the player to notice and turn
     * something down does not happen. Measure the work instead and get out of
     * the way while there is still time: a run of frames past 120 ms is
     * nowhere near the reset threshold yet, and is already unplayable.
     */
    watchFrameTime(ms) {
      if (App.loading || !App.stepDownTier) return;
      this.slow = (ms > 120) ? (this.slow || 0) + 1 : 0;
      if (this.slow < 12) return;
      this.slow = 0;
      App.stepDownTier('frames were taking ' + Math.round(ms) + ' ms');
    },

    /**
     * Step down when the frame rate will not hold, before the player has to
     * go looking for a quality setting. The 120 ms guard above is for frames
     * slow enough to upset the driver; this is for frames that are merely too
     * slow to play — under about 24 a second for a few seconds running. Not
     * while a hole is loading, not in the first seconds while shaders warm up,
     * and never below "low" on its own: past there the picture costs more than
     * it saves.
     */
    watchFps(fps) {
      if (this.qPinned || App.loading || this.walking || document.hidden) return;
      const now = performance.now();
      this._fpsT0 = this._fpsT0 || now;
      if (now - this._fpsT0 < 6000) return;
      this._fpsLog = (this._fpsLog || []).concat(fps).slice(-6);
      if (this._fpsLog.length < 6) return;
      const avg = this._fpsLog.reduce((a, b) => a + b, 0) / this._fpsLog.length;
      if (avg >= 24) return;
      const i = App.TIER_ORDER.indexOf(App.quality);
      if (i < 0 || App.TIER_ORDER[i + 1] === 'min') return;
      this._fpsLog = [];
      this._fpsT0 = now;
      App.stepDownTier('about ' + Math.round(avg) + ' frames a second');
    },

    syncQualityButtons() {
      document.querySelectorAll('[data-q]').forEach(x =>
        x.classList.toggle('on', x.dataset.q === App.quality));
      ['swAO', 'swDof', 'swShaft'].forEach((id, i) => {
        const el = $(id);
        if (el) el.classList.toggle('on', [App.poc.ao, App.poc.dof, App.poc.shafts][i]);
      });
    },

    /** Say so, once, without stealing focus from the round. */
    tierChanged(q, why) {
      const names = { high: 'High', fast: 'Fast', low: 'Low', min: 'Minimum' };
      this.flash('Graphics turned down to ' + (names[q] || q));
      this.syncQualityButtons && this.syncQualityButtons();
      console.warn('[dubsdread] ' + why);
    },

    fail(text, html) {
      const err = $('err');
      err.style.display = 'block';
      if (html) {
        // the loading card is sized for a progress bar, not for instructions
        const lw = $('lw');
        if (lw) { lw.style.width = 'min(720px,92vw)'; lw.style.textAlign = 'left'; }
        err.style.whiteSpace = 'normal';
        err.style.color = '#cfd3cc';
        err.innerHTML = html;
      } else {
        err.textContent = text;
      }
      $('loadMsg').textContent = 'Could not start.';
    },

    /**
     * Say which of the two failures this is, because the fixes are different.
     * A browser that gives WebGL 1 but not 2 is old, or running on a driver the
     * vendor has blocklisted. A browser that gives neither has it switched off
     * somewhere — nearly always hardware acceleration, occasionally a privacy
     * setting that blocks the canvas outright.
     */
    explainNoWebGL2() {
      let one = false, renderer = '';
      try {
        const probe = document.createElement('canvas');
        const g1 = probe.getContext('webgl') || probe.getContext('experimental-webgl');
        if (g1) {
          one = true;
          const dbg = g1.getExtension('WEBGL_debug_renderer_info');
          if (dbg) renderer = String(g1.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '');
          const lose = g1.getExtension('WEBGL_lose_context');
          if (lose) lose.loseContext();          // hand the slot straight back
        }
      } catch (e) { /* the probe failing is itself the answer */ }

      const s = 'style="color:#cfd3cc;font-weight:600"';
      const head = one
        ? 'This browser has WebGL 1 but not WebGL 2.'
        : 'This browser is not providing WebGL at all.';
      const why = one
        ? 'That combination almost always means the graphics driver is on the ' +
          'browser\'s blocklist, or the browser predates WebGL 2 ' +
          '(Chrome 56, Edge 79, Firefox 51, Safari 15).'
        : 'WebGL is switched off rather than missing — most often because ' +
          'hardware acceleration is disabled, sometimes because a privacy or ' +
          'anti-fingerprinting setting blocks the canvas.';

      const steps = [
        '<b ' + s + '>Chrome / Edge</b> — open <code>chrome://settings/system</code> ' +
        '(<code>edge://settings/system</code>), turn on “Use graphics acceleration ' +
        'when available”, and restart the browser.',
        '<b ' + s + '>Chrome / Edge, if that is already on</b> — open ' +
        '<code>chrome://flags/#ignore-gpu-blocklist</code>, set it to Enabled, and restart. ' +
        'That is the switch for a blocklisted driver.',
        '<b ' + s + '>Firefox</b> — open <code>about:config</code>, set ' +
        '<code>webgl.force-enabled</code> to true, and restart.',
        '<b ' + s + '>Brave / hardened browsers</b> — set Shields → Fingerprinting ' +
        'to Standard for this site, or turn Shields off for it.',
        '<b ' + s + '>Still nothing</b> — open the page in a different browser. ' +
        'It runs in current Chrome, Edge, Firefox and Safari 15 or newer.'
      ];

      const state = '<code>chrome://gpu</code> lists what your browser thinks it can do — ' +
        'the “WebGL2” row there says hardware, software, or disabled.';

      /* The way out. Everything except the renderer is plain JavaScript, so
         there is a whole build that does not need a GPU — offer that first and
         put the settings advice underneath it. Somebody who wants to play now
         should not have to restart their browser to do it. */
      const play =
        '<a href="flat.html" style="display:block;text-align:center;margin:0 0 16px;' +
        'background:linear-gradient(#d8b23a,#b4901e);color:#1a1508;text-decoration:none;' +
        'font-weight:700;font-size:13px;padding:11px 14px;border-radius:9px">' +
        'Play the no-GPU version →</a>' +
        '<div style="margin-bottom:14px;opacity:.85">Same course, same ball flight, ' +
        'caddie and putting — drawn top-down on a plain 2D canvas. Nothing to install ' +
        'or switch on.</div>';

      this.fail(null,
        '<div style="text-align:left;max-width:680px;margin:0 auto;line-height:1.65">' +
        play +
        '<div style="color:#e07a5f;font-weight:600;margin-bottom:8px">' + head + '</div>' +
        '<div style="margin-bottom:12px">' + why +
        (renderer ? ' Your browser reports its renderer as <code>' + esc(renderer) + '</code>.' : '') +
        '</div>' +
        '<div style="margin-bottom:6px">Things that fix it, most likely first:</div>' +
        '<ul style="margin:0 0 12px 18px;padding:0">' +
        steps.map(t => '<li style="margin-bottom:7px">' + t + '</li>').join('') +
        '</ul><div style="opacity:.8">' + state + '</div></div>');
    },

    /* ------------------------------------------------------------ chrome */
    buildCamBar() {
      const bar = $('camBar');
      bar.innerHTML = '';
      for (const [m, label] of CAMS) {
        const b = document.createElement('button');
        b.textContent = label;
        b.dataset.cam = m;
        if (m === App.camMode) b.className = 'on';
        b.onclick = () => App.setCamera(m, false);
        bar.appendChild(b);
      }
    },

    /**
     * The eighteen-hole strip. Doubles as the card at a glance: once a hole is
     * played its cell shows the score coloured against par, so you can see the
     * shape of the round without opening anything.
     */
    buildStrip() {
      const strip = $('strip');
      strip.innerHTML = '';
      const C = App.course;
      const mk = i => {
        const h = C.holes[i];
        const b = document.createElement('button');
        b.dataset.hole = h.num;
        b.innerHTML = '<b>' + h.num + '</b><i>' + h.par + '</i>';
        b.title = 'Hole ' + h.num + ' \u00b7 par ' + h.par + ' \u00b7 ' + h.yards + ' yds';
        b.onclick = () => this.goHole(h.num);
        return b;
      };
      for (let i = 0; i < 9; i++) strip.appendChild(mk(i));
      const sep = document.createElement('div'); sep.className = 'sep';
      strip.appendChild(sep);
      for (let i = 9; i < 18; i++) strip.appendChild(mk(i));
      this.refreshStrip();
    },

    refreshStrip() {
      const C = App.course;
      document.querySelectorAll('#strip button').forEach(b => {
        const n = +b.dataset.hole;
        const e = Play.round && Play.round.card[n - 1];
        b.classList.toggle('on', n === App.hole);
        b.classList.toggle('done', !!e);
        b.classList.remove('under', 'over');
        const i = b.querySelector('i');
        if (e) {
          i.textContent = e.score;
          const d = e.score - C.holes[n - 1].par;
          if (d < 0) b.classList.add('under');
          else if (d > 0) b.classList.add('over');
        } else {
          i.textContent = C.holes[n - 1].par;
        }
      });
      const played = Play.holesPlayed();
      $('bThru').textContent = played ? Play.totalLabel() : '18 holes';
      $('hTot').textContent = played ? Play.totalLabel() : 'Scorecard';
    },

    /** Tee sets apply to the whole round, so this is picked once. */
    buildTees() {
      const sel = $('teeSel');
      sel.innerHTML = '';
      App.holeData.tees.forEach((t, i) => {
        const o = document.createElement('option');
        o.value = i;
        o.textContent = t.name;
        sel.appendChild(o);
      });
      sel.value = String(clamp(App.teeSet, 0, App.holeData.tees.length - 1));
      $('teeName').textContent = (App.holeData.tees[App.teeSet] || {}).name || '—';
      sel.onchange = e => {
        App.teeSet = +e.target.value;
        $('teeName').textContent = (App.holeData.tees[App.teeSet] || {}).name || '—';
        // a different tee is a different hole, so the ball goes back
        Play.newHole(App.hole);
        this.flash('Playing the ' + $('teeName').textContent + ' tees');
      };
    },

    buildClubs() {
      const cs = $('club');
      cs.innerHTML = '';
      for (const c of root.Shot.CLUBS) {
        const o = document.createElement('option');
        o.value = c.id;
        o.textContent = c.name;
        cs.appendChild(o);
      }
      cs.value = Play.club;
    },

    bindControls() {
      const P = App.poc;

      $('club').onchange = e => { Play.club = e.target.value; Play.notify(); };
      $('shape').oninput = e => {
        Play.shape = e.target.value / 100;
        const v = Play.shape;
        $('shapeVal').textContent = v < -0.55 ? 'Big draw' : v < -0.15 ? 'Draw'
          : v > 0.55 ? 'Big fade' : v > 0.15 ? 'Fade' : 'Straight';
      };
      $('aimL').onclick = () => Play.nudgeAim(-1.2);
      $('aimR').onclick = () => Play.nudgeAim(1.2);
      $('paimL').onclick = () => Play.nudgeAim(-0.35);
      $('paimR').onclick = () => Play.nudgeAim(0.35);
      $('pPace').oninput = e => {
        this.puttPace = e.target.value / 100;
        $('pPaceVal').textContent = this.puttPace === 1 ? 'Read pace'
          : Math.round((this.puttPace - 1) * 100) + '% ' + (this.puttPace > 1 ? 'firm' : 'soft');
      };
      const ps = $('profileSel');
      ps.innerHTML = '';
      for (const p2 of root.Shot.PROFILES) {
        const o = document.createElement('option');
        o.value = p2.id;
        o.textContent = p2.name + ' — ' + p2.label;
        ps.appendChild(o);
      }
      ps.value = App.profile;
      $('skillName').textContent = (SP.SKILL[App.profile] || {}).name || '';
      ps.onchange = e => {
        App.profile = e.target.value;
        $('skillName').textContent = (SP.SKILL[App.profile] || {}).name || '';
        // every distance on screen belongs to a player, so they all change
        Play._powerKey = null; Play._recKey = null;
        Play.clearPatterns();
        if (!Play.isPutting()) Play.club = Play.recommendClub().id;
        this.flash('Playing as ' + $('skillName').textContent);
        Play.notify();
      };

      $('zoneBtn').onclick = () => {
        this.zones = !this.zones;
        $('zoneBtn').classList.toggle('on', this.zones);
        $('zoneBtn').textContent = this.zones ? 'Hide landing zones' : 'Show landing zones';
        $('zoneTag').textContent = this.zones ? 'on' : 'off';
        this.onPlayChanged();
      };

      $('swing').onclick = () => this.act();
      $('autoBtn').onclick = () => {
        Play.autoSwing = !Play.autoSwing;
        $('autoBtn').classList.toggle('on', Play.autoSwing);
        this.flash(Play.autoSwing ? 'Auto swing: a flush strike every time'
                                  : 'Manual swing: time the power, then the face');
      };
      /* Back to the tee on this hole. The rest of the card is untouched — only
         this hole's entry is released, so it can be scored again. */
      const restart = () => {
        this._settled = false;          // drop any settle the loop had queued
        Play.restartHole();
        $('done').classList.remove('on');
        $('cardModal').style.display = 'none';
        this.refreshStrip();
        this.flash('Back to the tee — hole ' + App.hole + ' restarted');
      };
      $('restart').onclick = restart;
      $('againBtn').onclick = restart;
      $('nextBtn').onclick = () => {
        const n = Play.nextHoleNumber();
        if (n) this.goHole(n);
        else this.showScorecard();
      };
      $('cardBtn').onclick = () => this.showScorecard();
      $('cardBtn2').onclick = () => this.showScorecard();
      $('hTot').onclick = () => this.showScorecard();
      $('scClose').onclick = () => { $('cardModal').style.display = 'none'; };
      $('scNew').onclick = () => {
        $('cardModal').style.display = 'none';
        Play.newRound();
        this.goHole(1, { force: true, label: 'Back to the 1st' });
      };

      /* --- conditions --- */
      const clockLbl = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' +
                            String(Math.round(m % 60)).padStart(2, '0');
      $('skySel').onchange = e => {
        const v = e.target.value || null;
        if (v) App.setRealSky(v);
        else { P.realSky = null; App.refreshSky(); }
        this.updateSunTag();
        this.flash(v ? 'Real sky' : 'Simulated sky — set the time');
      };
      $('clock').oninput = e => {
        // moving the clock means the simulated sky, which follows it
        if (P.realSky) { P.realSky = null; $('skySel').value = ''; }
        P.minutes = +e.target.value;
        $('tVal').textContent = clockLbl(P.minutes);
        App.refreshSky();
        this.updateSunTag();
      };
      $('cover').oninput = e => {
        P.cloudCover = e.target.value / 100;
        $('cvVal').textContent = e.target.value + '%';
        App.refreshSky();
      };
      $('turb').oninput = e => {
        P.turbidity = e.target.value / 10;
        $('tbVal').textContent = P.turbidity.toFixed(1);
        App.refreshSky();
      };
      $('wind').oninput = e => { App.wind.speed = +e.target.value; this.windLabel(); Play.notify(); };
      $('wdir').oninput = e => { App.wind.dir = +e.target.value; this.windLabel(); Play.notify(); };
      $('temp').oninput = e => {
        Play.tempC = +e.target.value;
        $('tmpVal').textContent = Play.tempC + ' °C';
        Play.notify();
      };
      $('stimp').oninput = e => {
        Play.stimp = e.target.value / 10;
        $('stVal').textContent = Play.stimp.toFixed(1) + ' ft';
        Play._read = null;
        Play.notify();
      };

      /* --- rendering --- */
      const sw = (id, get, set) => {
        const el = $(id);
        el.onclick = () => { set(!get()); el.classList.toggle('on', get()); };
      };
      sw('swCloud', () => P.cloudShadow > 0.01, v => { P.cloudShadow = v ? 0.82 : 0; });
      sw('swAO', () => P.ao, v => { P.ao = v; });
      sw('swDof', () => P.dof, v => { P.dof = v; });
      sw('swShaft', () => P.shafts, v => { P.shafts = v; });
      sw('swAgx', () => P.agx, v => { P.agx = v; });
      sw('swGrass', () => App.showGrass, v => { App.showGrass = v; App.updateGrass(true); });

      const STOPS = [1.8, 2.8, 4, 5.6, 8, 11, 16, 22, 32];
      $('ap').oninput = e => {
        P.fStop = STOPS[+e.target.value];
        $('apVal').textContent = P.fStop >= 22 ? 'off (f/22+)' : 'f/' + P.fStop;
      };
      const STOPI = STOPS.indexOf(P.fStop);
      $('ap').value = STOPI >= 0 ? STOPI : 3;
      $('apVal').textContent = P.fStop >= 22 ? 'off (f/22+)' : 'f/' + P.fStop;
      this.syncQualityButtons();

      document.querySelectorAll('[data-q]').forEach(b => {
        b.onclick = () => {
          App.quality = b.dataset.q;
          const T = App.tier();
          P.ao = T.ao; P.dof = T.dof; P.shafts = T.shafts;
          this.syncQualityButtons();
          // the shadow maps are sized by tier, so they are rebuilt with the rest
          if (App.sm) {
            if (App.sm[0]) App.sm[0].dispose();
            if (App.sm[1] && App.sm[1] !== App.sm[0]) App.sm[1].dispose();
            App.sm = null;
          }
          if (App.rt) { App.rt.dispose(); }
          App.rt = null;
          App.resize();
          App.grassAt = null;
          this.flash('Rebuilding at ' + b.dataset.q + ' quality');
          // reuse the hole transition so the rebuild is covered and the round's
          // card survives it
          this.goHole(App.hole, { force: true, label: 'Rebuilding' });
        };
      });

      /* Hold to compare: every POC rendering feature off, and the original
         tonemap back, so the difference is one button rather than an argument. */
      const ab = $('abBtn');
      const saved = {};
      const abOn = () => {
        Object.assign(saved, { ao: P.ao, dof: P.dof, shafts: P.shafts, agx: P.agx,
                               cloudShadow: P.cloudShadow, grass: App.showGrass,
                               sat: P.saturation, punch: P.punch, wb: P.whiteBalance });
        P.ao = false; P.dof = false; P.shafts = false; P.agx = false;
        P.cloudShadow = 0; P.saturation = 1.09; P.punch = 1.06;
        P.whiteBalance = 0; App.refreshSky();
        ab.classList.add('on'); ab.textContent = 'Baseline shading';
      };
      const abOff = () => {
        P.ao = saved.ao; P.dof = saved.dof; P.shafts = saved.shafts; P.agx = saved.agx;
        P.cloudShadow = saved.cloudShadow; P.saturation = saved.sat; P.punch = saved.punch;
        P.whiteBalance = saved.wb; App.refreshSky();
        ab.classList.remove('on'); ab.textContent = 'Hold to compare';
      };
      ab.addEventListener('pointerdown', abOn);
      ab.addEventListener('pointerup', abOff);
      ab.addEventListener('pointerleave', () => { if (ab.classList.contains('on')) abOff(); });

      $('photoBtn').onclick = () => {
        document.body.classList.toggle('photo');
        const on = document.body.classList.contains('photo');
        document.querySelector('.hud').style.opacity = on ? '0' : '1';
        $('labels').style.opacity = on ? '0' : '1';
        if (on) this.flash('Photo mode — click anywhere to bring the HUD back');
      };

      /* --- map tabs --- */
      document.querySelectorAll('#mapTabs button').forEach(b => {
        b.onclick = () => {
          this.tab = b.dataset.tab;
          document.querySelectorAll('#mapTabs button').forEach(x => x.classList.toggle('on', x === b));
          $('map').style.display = this.tab === 'map' ? 'block' : 'none';
          $('book').style.display = this.tab === 'book' ? 'block' : 'none';
          this.draw();
        };
      });

      /* --- keys --- */
      window.addEventListener('keydown', e => {
        if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
        if (document.body.classList.contains('photo') && e.key) {
          $('photoBtn').click();
          return;
        }
        if (e.key === ' ') { e.preventDefault(); if (!e.repeat) this.act(); }
        else if (e.key === 'a' || e.key === 'ArrowLeft') Play.nudgeAim(Play.isPutting() ? -0.35 : -1.2);
        else if (e.key === 'd' || e.key === 'ArrowRight') Play.nudgeAim(Play.isPutting() ? 0.35 : 1.2);
        else if (e.key === 'c') {
          const i = CAMS.findIndex(c => c[0] === App.camMode);
          App.setCamera(CAMS[(i + 1) % CAMS.length][0], false);
        }
        else if (e.key === '[') this.cycleClub(-1);
        else if (e.key === ']') this.cycleClub(1);
        else if (e.key === 'p' && Play.isPutting()) Play.autoPutt();
        else if (e.key === 'r') restart();
        else if (e.key === 'n' || e.key === 'ArrowDown') {
          const n = Play.nextHoleNumber();
          if (n) this.goHole(n); else this.showScorecard();
        }
        else if (e.key === 'ArrowUp') this.goHole(App.hole - 1);
        else if (e.key === 's') this.showScorecard();
      });
      window.addEventListener('resize', () => { App.resize(); this.draw(); });
    },

    /**
     * The one action. Off the green it is the two-stage swing play.js already
     * has. On the green a putt needs only pace — the line is the aim — so it is
     * one tap to start the needle and a second to stop it, and the white mark
     * is the caddie's pace (the pace slider moves the mark).
     */
    act() {
      const st = Play.state;
      if (st.holed) { $('nextBtn').click(); return; }
      if (!Play.isPutting() || st.phase === 'flying') { Play.tap(); return; }
      if (Play.autoSwing && st.phase === 'idle') {
        Play.putt({ power: this.puttPace || 1, faceErr: 0 });
        return;
      }
      if (st.phase === 'idle') {
        Play.meter = { phase: 'power', t: 0, power: 0, strike: 0, dir: 1 };
        st.phase = 'power';
        Play.notify();
      } else if (st.phase === 'power') {
        Play.putt({ power: clamp(Play.meter.t, 0.08, 1.12), faceErr: 0 });
      }
    },

    /** How much of the screen the controls cover, for the camera framing. */
    measureInsets() {
      const H = innerHeight;
      const bot = $('bottom');
      let b = 0;
      if (bot) {
        const r = bot.getBoundingClientRect();
        b = r.height > 0 ? H - r.top : 0;
        // the meter only appears mid-swing; leave room for it all the time so
        // the view does not jump when it does
        if (!$('meter').classList.contains('on')) b += 78;
      }
      App.viewInset = { top: 0, bottom: clamp(b, 0, H * 0.5) };
    },

    cycleClub(d) {
      const list = root.Shot.CLUBS;
      let i = list.findIndex(c => c.id === Play.club);
      i = clamp(i + d, 0, list.length - 1);
      Play.club = list[i].id;
      $('club').value = Play.club;
      Play.notify();
    },

    windLabel() {
      const s = App.wind.speed;
      $('wVal').textContent = s === 0 ? 'Calm' : Math.round(s * 2.23694) + ' mph';
      this.updateSunTag();
    },

    syncConditions() {
      const P = App.poc;
      $('clock').value = P.minutes;
      if ($('skySel')) $('skySel').value = P.realSky || '';
      $('tVal').textContent = String(Math.floor(P.minutes / 60)).padStart(2, '0') + ':' +
                              String(P.minutes % 60).padStart(2, '0');
      $('cover').value = Math.round(P.cloudCover * 100);
      $('cvVal').textContent = Math.round(P.cloudCover * 100) + '%';
      $('turb').value = Math.round(P.turbidity * 10);
      $('tbVal').textContent = P.turbidity.toFixed(1);
      $('temp').value = Play.tempC;
      $('tmpVal').textContent = Play.tempC + ' °C';
      $('stimp').value = Math.round(Play.stimp * 10);
      $('stVal').textContent = Play.stimp.toFixed(1) + ' ft';
      $('wind').value = App.wind.speed;
      $('wdir').value = App.wind.dir;
      this.windLabel();
      this.updateSunTag();
    },

    updateSunTag() {
      const K = App.sky;
      const b = App.dayBounds();
      const hhmm = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(Math.round(m % 60)).padStart(2, '0');
      $('sunTag').textContent = K.solar.elevation.toFixed(1) + '° · ' +
        Math.round(K.solar.azimuth) + '° · rise ' + hhmm(b.rise) + ' set ' + hhmm(b.set);
    },

    /* -------------------------------------------------------- game readout */

    onPlayChanged() {
      const st = Play.state;
      const H = App.holeData;

      $('hNum').textContent = H.num;
      $('hMeta').textContent = 'Par ' + H.par + ' · Stroke ' + H.hcp;
      $('hYds').innerHTML = (H.tees[App.teeSet] || H.tees[0]).yards + ' <span>yards</span>';
      $('hScore').textContent = st.holed ? st.score : (st.stroke + st.penalties) || '—';
      $('strokeTag').textContent = st.holed ? 'Holed out'
        : 'Stroke ' + (st.stroke + st.penalties + 1);
      $('hDesc').textContent = this.describe(H);

      const putting = Play.isPutting() && !st.holed;
      $('fullControls').style.display = putting ? 'none' : 'block';
      $('puttControls').style.display = putting ? 'block' : 'none';
      $('swing').textContent = st.holed ? 'Holed out'
        : Play.autoSwing ? (putting ? 'Putt' : 'Swing') + ' (auto)'
        : (putting ? 'Putt' : 'Swing');
      $('swing').disabled = st.holed;

      const lie = Play.lieInfo();
      const chip = $('lieChip');
      chip.textContent = lie.name;
      chip.className = 'chip ' + (lie.name === 'Fairway' || lie.name === 'Green' || lie.name === 'Tee' ? 'g'
        : lie.name === 'Water' ? 'b' : 'w');

      if (putting) this.showPuttRead(); else this.showCaddie();
      $('zoneBtn').disabled = putting || st.holed;
      this.drawZones();
      this.drawShots();
      this.draw();
      this.refreshStrip();

      if (st.holed) this.showCard();
    },

    showCaddie() {
      let c;
      try { c = Play.caddie(); } catch (e) { return; }
      $('cPin').innerHTML = Math.round(c.pinYd) + '<small> yds to pin</small>';
      const plays = Math.round(c.playsLikeYd);
      $('cPlays').textContent = Math.abs(plays - Math.round(c.pinYd)) < 2
        ? 'Plays its number' : 'Plays like ' + plays + ' yds';
      // the club, and how hard to hit it: a stock 7 iron and a three-quarter
      // 7 iron are different shots, and the player needs to be told which
      const pct = Math.round(c.power * 100);
      $('cRec').innerHTML = c.rec.name +
        (pct < 92 ? ' <small style="color:var(--dim)">' + pct + '%</small>' : '');
      $('club').value = Play.club;
      $('cWind').textContent = c.windText +
        (Math.abs(c.windYd) > 1.5 ? '  (' + (c.windYd > 0 ? '+' : '−') + Math.abs(Math.round(c.windYd)) + ' yd)' : '');
      $('cElev').textContent = (c.elevFt >= 0 ? '+' : '−') + Math.abs(Math.round(c.elevFt)) + ' ft';
      $('cGreen').textContent = Math.round(c.frontYd) + '–' + Math.round(c.backYd) + ' yds deep';

      const cs = c.carries.map(b =>
        (b.onLine ? 'Carry ' : 'Sand ') + Math.round(b.carryYd) + ' to clear the ' + b.side + ' bunker');
      $('cCarries').innerHTML = cs.join('<br>');
      $('cLieNote').textContent = Play.lie() === 'fairway' || Play.lie() === 'tee' ? '' : c.lie.note;
    },

    showPuttRead() {
      const r = Play.read();
      const dist = Play.toPin();
      $('cPin').innerHTML = (dist * 3.28084).toFixed(1) + '<small> ft to the hole</small>';
      $('cPlays').textContent = 'Green running ' + Play.stimp.toFixed(1) + ' ft';
      $('cRec').textContent = 'Putter';
      const off = r.offsetDeg;
      const cups = Math.abs(off) * Math.PI / 180 * dist / 0.108;
      $('pRead').textContent = Math.abs(cups) < 0.4 ? 'Straight'
        : cups.toFixed(1) + ' cups ' + (off > 0 ? 'right' : 'left');
      $('cWind').textContent = Play.assist ? 'Read shown on the green book' : 'Read it yourself';
      const b = Play.ball(), pin = App.pinPos();
      $('cElev').textContent = ((pin[1] - b[1]) * 39.37).toFixed(1) + ' in';
      $('cGreen').textContent = r.holes ? 'This line holes it' : 'Best line misses';
      $('cCarries').innerHTML = '';
      $('cLieNote').textContent = '';
    },

    /**
     * The outcome breakdown. Four skill levels, the same shot, so the question
     * "can I actually hold this fairway" gets a number instead of a vibe.
     */
    drawZones() {
      const box = $('zoneOut');
      if (!this.zones || Play.isPutting() || Play.state.holed || Play.state.phase !== 'idle') {
        box.innerHTML = '';
        this.patterns = null;
        return;
      }
      let pats;
      try { pats = Play.allPatterns(22); }
      catch (e) { box.innerHTML = '<div class="zsub">Could not sample this shot.</div>'; return; }
      this.patterns = pats;

      let html = '';
      for (const p of pats) {
        const me = p.profile === App.profile;
        const keys = Object.keys(p.share).sort((a, b) => p.share[b] - p.share[a]);
        let bar = '';
        for (const k of keys) {
          const s = SURF[k] || { c: '#666' };
          bar += '<i style="width:' + (p.share[k] * 100).toFixed(1) + '%;background:' + s.c + '"></i>';
        }
        const spread = Math.round(p.acrossHi - p.acrossLo);
        html += '<div class="zrow">' +
          '<div class="zhead"><b style="color:' + (me ? 'var(--gold)' : 'var(--ink)') + '">' +
          p.name.replace(' Professional', '').replace(' Handicap', '') +
          (me ? ' · you' : '') + '</b>' +
          '<span style="color:var(--dim)">' + Math.round(p.good * 100) + '% in play</span></div>' +
          '<div class="zbar">' + bar + '</div>' +
          '<div class="zsub">' + Math.round(p.alongLo) + '–' + Math.round(p.alongHi) +
          ' yds · ' + spread + ' yds wide' +
          (p.trees > 0.02 ? ' · ' + Math.round(p.trees * 100) + '% catch a tree' : '') +
          '</div></div>';
      }
      const shown = {};
      for (const p of pats) for (const k in p.share) shown[k] = 1;
      let key = '<div class="zkey">';
      for (const k in shown) {
        const s = SURF[k] || { c: '#666', n: k };
        key += '<span><i style="background:' + s.c + '"></i>' + s.n + '</span>';
      }
      box.innerHTML = html + key + '</div>';
    },

    drawShots() {
      const body = $('shotBody');
      body.innerHTML = '';
      for (const s of Play.state.shots) {
        const tr = document.createElement('tr');
        const note = s.note ? '<div class="note">' + s.note + '</div>' : '';
        // a putt measured in yards rounds to nothing; putts are a feet unit
        const dist = s.club === 'Putter'
          ? Math.round(s.distYd * 3) + ' ft'
          : (s.distYd >= 1 ? Math.round(s.distYd) + ' yd' : '');
        tr.innerHTML = '<td class="n">' + s.no + '</td>' +
          '<td>' + s.club + '<div class="note">' + s.result + '</div>' + note + '</td>' +
          '<td class="d">' + dist +
          (s.penalty ? '<div class="note">+1</div>' : '') + '</td>';
        body.appendChild(tr);
      }
      const st = Play.state;
      $('shotSum').textContent = st.shots.length
        ? (st.stroke + st.penalties) + ' played' : 'on the tee';
      const box = $('shots');
      box.scrollTop = box.scrollHeight;
    },

    showCard() {
      const st = Play.state;
      $('doneScore').textContent = st.score;
      $('doneName').textContent = Play.scoreName();
      const t = Play.roundTotals();
      $('doneTot').textContent = 'Hole ' + App.hole + ' \u00b7 round ' + Play.totalLabel();
      const list = $('doneList');
      list.innerHTML = '';
      for (const s of st.shots) {
        const d = document.createElement('div');
        const dist = s.club === 'Putter' ? Math.round(s.distYd * 3) + ' ft · '
          : (s.distYd >= 1 ? Math.round(s.distYd) + ' yd · ' : '');
        d.innerHTML = '<span>' + s.no + '. ' + s.club + '</span><span>' + dist + s.result + '</span>';
        list.appendChild(d);
      }
      const n = Play.nextHoleNumber();
      $('nextBtn').textContent = n ? 'Next hole \u2014 the ' + this.ordinal(n)
                                   : 'See the card';
      $('done').classList.add('on');
      if (t.complete) setTimeout(() => this.showScorecard(), 900);
    },

    /**
     * The card, laid out the way a real one is: nine out, nine in, totals.
     */
    showScorecard() {
      const C = App.course;
      const card = Play.round ? Play.round.card : new Array(18).fill(null);
      const t = Play.roundTotals();
      const nine = (from, to) => {
        let cells = '';
        for (let i = from; i < to; i++) cells += '<th>' + (i + 1) + '</th>';
        return cells;
      };
      const row = (label, get, cls) => {
        let h = '<td class="lbl">' + label + '</td>';
        let out = 0, inn = 0;
        for (let i = 0; i < 9; i++) h += get(i);
        h += '<td class="tot">' + (label === 'Hole' ? 'OUT' : this.nineTotal(card, C, 0, 9, label)) + '</td>';
        for (let i = 9; i < 18; i++) h += get(i);
        h += '<td class="tot">' + (label === 'Hole' ? 'IN' : this.nineTotal(card, C, 9, 18, label)) + '</td>';
        h += '<td class="tot">' + (label === 'Hole' ? 'TOT' : this.nineTotal(card, C, 0, 18, label)) + '</td>';
        return '<tr>' + h + '</tr>';
      };

      let html = '<tr><th class="lbl" style="text-align:left">Hole</th>' + nine(0, 9) +
        '<th>OUT</th>' + nine(9, 18) + '<th>IN</th><th>TOT</th></tr>';
      html += row('Par', i => '<td>' + C.holes[i].par + '</td>');
      html += row('Yards', i => '<td>' + ((C.holes[i].tees[App.teeSet] || C.holes[i].tees[0] ||
        { yards: C.holes[i].yards }).yards) + '</td>');
      html += row('Score', i => {
        const e = card[i];
        if (!e) return '<td style="color:var(--faint)">·</td>';
        const d = e.score - C.holes[i].par;
        const cls = d <= -2 ? 'eagle' : d < 0 ? 'under' : d > 0 ? 'over' : '';
        return '<td class="' + cls + '">' + e.score + '</td>';
      });
      $('sc').innerHTML = html;
      $('scTot').textContent = t.thru
        ? t.gross + ' gross \u00b7 ' + Play.totalLabel() : 'no holes played yet';
      $('cardModal').style.display = 'grid';
    },

    /** Column total for one of the card's rows, blank where nothing is played. */
    nineTotal(card, C, from, to, label) {
      let n = 0, any = false;
      for (let i = from; i < to; i++) {
        if (label === 'Par') { n += C.holes[i].par; any = true; }
        else if (label === 'Yards') {
          n += (C.holes[i].tees[App.teeSet] || C.holes[i].tees[0] ||
                { yards: C.holes[i].yards }).yards;
          any = true;
        } else if (card[i]) { n += card[i].score; any = true; }
      }
      return any ? n : '·';
    },

    /**
     * Hole description generated from the geometry, so it is right for all
     * eighteen rather than written out for one.
     */
    describe(H) {
      const st = Play.state;
      if (st.holed) return 'Holed out in ' + st.score + ' — ' + Play.scoreName().toLowerCase() + '.';
      if (st.stroke > 0) {
        return Play.lieInfo().note + '. ' + Math.round(Play.toPin() * M2Y) + ' yards to the flag.';
      }

      const sp = H.spine;
      const a = sp[0], m = sp[Math.floor(sp.length * 0.5)], b = sp[sp.length - 1];
      let bend = (Math.atan2(b[1] - m[1], b[0] - m[0]) -
                  Math.atan2(m[1] - a[1], m[0] - a[0])) * 180 / Math.PI;
      while (bend > 180) bend -= 360;
      while (bend < -180) bend += 360;
      const side = bend > 0 ? 'left' : 'right';
      const shape = Math.abs(bend) < 6 ? 'plays dead straight'
        : Math.abs(bend) < 15 ? 'bends gently ' + side
        : Math.abs(bend) < 28 ? 'doglegs ' + side : 'turns hard ' + side;

      const rise = (App.pinPos()[1] - App.teePos()[1]) * 3.28084;
      const grade = Math.abs(rise) < 6 ? 'to a green at roughly tee level'
        : rise > 0 ? 'to a green sitting ' + Math.round(rise) + ' ft above the tee'
                   : 'to a green ' + Math.round(-rise) + ' ft below the tee';

      const tee = H.tees[App.teeSet] || H.tees[0];
      const kind = H.par === 3 ? 'one-shotter' : H.par === 5 ? 'three-shotter' : 'two-shotter';
      let s = 'A ' + (tee ? tee.yards : H.yards) + '-yard ' + kind + ' that ' + shape + ' ' + grade + '. ';
      s += H.bunkers.length === 0
        ? 'No sand here — the defence is length and the tree line. '
        : H.bunkers.length + ' bunker' + (H.bunkers.length > 1 ? 's' : '') +
          ' frame the corridor and the putting surface. ';
      if (H.waters.length) s += 'Water is in play. ';
      if (H.hcp <= 4) s += 'One of the hardest holes on the card.';
      else if (H.hcp >= 15) s += 'The card says it is a breather.';
      return s;
    },

    /* ---------------------------------------------------------- hole map */
    draw() {
      if (this.tab === 'book' && Play.isPutting()) this.drawGreenBook();
      else if (this.tab === 'book') this.drawGreenBook();
      else this.drawMap();
    },

    _ctx(id, h) {
      const cv = $(id);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const W = cv.clientWidth || 286;
      cv.width = W * dpr; cv.height = h * dpr;
      const g = cv.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, h);
      return { g, W, H: h };
    },

    drawMap() {
      const { g, W, H: Hh } = this._ctx('map', 186);
      const H = App.holeData;

      let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9;
      const eat = r => { for (const p of r) {
        minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]);
        minz = Math.min(minz, p[1]); maxz = Math.max(maxz, p[1]);
      } };
      eat(H.spine); H.fairways.forEach(eat); H.green.rings.forEach(eat);
      H.bunkers.forEach(eat); H.waters.forEach(eat); H.teeBoxes.forEach(eat);

      const t = H.spine[0], gr = H.green.c;
      const ang = Math.atan2(gr[1] - t[1], gr[0] - t[0]) + Math.PI / 2;
      const ca = Math.cos(-ang), sa = Math.sin(-ang);
      const cx = (minx + maxx) / 2, cz = (minz + maxz) / 2;
      const rot = p => { const x = p[0] - cx, z = p[1] - cz; return [x * ca - z * sa, x * sa + z * ca]; };
      let rminx = 1e9, rmaxx = -1e9, rminz = 1e9, rmaxz = -1e9;
      const all = [H.spine, ...H.fairways, ...H.green.rings, ...H.bunkers, ...H.waters, ...H.teeBoxes];
      for (const r of all) for (const p of r) {
        const q = rot(p);
        rminx = Math.min(rminx, q[0]); rmaxx = Math.max(rmaxx, q[0]);
        rminz = Math.min(rminz, q[1]); rmaxz = Math.max(rmaxz, q[1]);
      }
      const pad = 20;
      const sc = Math.min((W - pad * 2) / (rmaxx - rminx), (Hh - pad * 2) / (rmaxz - rminz));
      const ox = W / 2 - ((rminx + rmaxx) / 2) * sc;
      const oy = Hh / 2 - ((rminz + rmaxz) / 2) * sc;
      const Pp = p => { const q = rot(p); return [q[0] * sc + ox, q[1] * sc + oy]; };

      const poly = (r, fill, stroke, lw) => {
        if (r.length < 2) return;
        g.beginPath();
        const s = Pp(r[0]); g.moveTo(s[0], s[1]);
        for (let i = 1; i < r.length; i++) { const q = Pp(r[i]); g.lineTo(q[0], q[1]); }
        g.closePath();
        if (fill) { g.fillStyle = fill; g.fill(); }
        if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw || 1; g.stroke(); }
      };

      g.fillStyle = '#121712'; g.fillRect(0, 0, W, Hh);
      g.strokeStyle = 'rgba(52,76,44,.85)';
      g.lineWidth = 46 * sc; g.lineJoin = 'round'; g.lineCap = 'round';
      g.beginPath();
      const s0 = Pp(H.spine[0]); g.moveTo(s0[0], s0[1]);
      for (let i = 1; i < H.spine.length; i++) { const q = Pp(H.spine[i]); g.lineTo(q[0], q[1]); }
      g.stroke();

      H.fairways.forEach(r => poly(r, '#456b34'));
      H.waters.forEach(r => poly(r, '#2b5566'));
      H.bunkers.forEach(r => poly(r, '#c9ba95'));
      H.green.rings.forEach(r => poly(r, '#6c9d47', 'rgba(255,255,255,.22)', 1));
      H.teeBoxes.forEach(r => poly(r, '#3b6631'));

      const b = Play.ball();
      const bp = Pp([b[0], b[2]]);

      /* --- landing zones -------------------------------------------------
       * The sampled outcomes, drawn where they actually finished. Each skill
       * level gets its 80% box along and across the line of play, and the
       * selected player also gets the individual finishes coloured by what they
       * found — which is the point: a cone drawn from an angle tells you
       * nothing about whether the miss is rough or water.
       */
      if (this.zones && this.patterns && !Play.state.holed) {
        const ax = Math.cos(Play.aim), az = Math.sin(Play.aim);
        const world = (along, across) => {
          const A = along * Y2M, C = across * Y2M;
          return [b[0] + ax * A - az * C, b[2] + az * A + ax * C];
        };
        const tint = ['rgba(255,255,255,.30)', 'rgba(160,210,255,.30)',
                      'rgba(255,205,120,.32)', 'rgba(255,150,150,.32)'];
        this.patterns.forEach((p, i) => {
          const me = p.profile === App.profile;
          const corners = [
            world(p.alongLo, p.acrossLo), world(p.alongHi, p.acrossLo),
            world(p.alongHi, p.acrossHi), world(p.alongLo, p.acrossHi)
          ].map(Pp);
          g.beginPath();
          g.moveTo(corners[0][0], corners[0][1]);
          for (let k = 1; k < 4; k++) g.lineTo(corners[k][0], corners[k][1]);
          g.closePath();
          g.strokeStyle = tint[i % 4];
          g.lineWidth = me ? 1.8 : 0.9;
          if (!me) g.setLineDash([3, 3]);
          g.stroke();
          g.setLineDash([]);
          if (me) { g.fillStyle = 'rgba(255,255,255,.07)'; g.fill(); }
        });
        // individual finishes for the player you are
        const mine = this.patterns.find(p => p.profile === App.profile);
        if (mine) {
          for (const sh of mine.shots) {
            const q = Pp([sh.x, sh.z]);
            const c = SURF[sh.surface] || { c: '#999' };
            g.fillStyle = c.c;
            g.globalAlpha = 0.85;
            g.beginPath(); g.arc(q[0], q[1], 1.7, 0, 7); g.fill();
            g.globalAlpha = 1;
          }
        }
      }

      // the line of play as aimed
      if (!Play.state.holed) {
        const reach = Play.isPutting() ? Play.toPin() : Play.aimDistance();
        const tip = [b[0] + Math.cos(Play.aim) * reach, b[2] + Math.sin(Play.aim) * reach];
        const tp = Pp(tip);
        g.strokeStyle = 'rgba(255,235,170,.75)'; g.lineWidth = 1;
        g.setLineDash([3, 3]);
        g.beginPath(); g.moveTo(bp[0], bp[1]); g.lineTo(tp[0], tp[1]); g.stroke();
        g.setLineDash([]);
      }

      // shots played
      for (const s of Play.state.shots) {
        if (!s.path) continue;
      }
      if (Play.tracks) {
        g.lineWidth = 1.5;
        for (const tr of Play.tracks) {
          g.strokeStyle = 'rgba(255,235,170,.9)';
          g.beginPath();
          const a0 = Pp([tr[0][0], tr[0][2]]); g.moveTo(a0[0], a0[1]);
          for (const p of tr) { const q = Pp([p[0], p[2]]); g.lineTo(q[0], q[1]); }
          g.stroke();
        }
      }

      const pin = Pp(H.green.c);
      g.fillStyle = '#e8c447';
      g.beginPath(); g.arc(pin[0], pin[1], 3.2, 0, 7); g.fill();
      g.strokeStyle = '#e8c447'; g.lineWidth = 1.1;
      g.beginPath(); g.moveTo(pin[0], pin[1]); g.lineTo(pin[0], pin[1] - 9); g.stroke();
      g.fillRect(pin[0], pin[1] - 9, 5.5, 3.6);

      g.fillStyle = '#fff';
      g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineWidth = 1;
      g.beginPath(); g.arc(bp[0], bp[1], 3.2, 0, 7); g.fill(); g.stroke();

      const px = 100 * Y2M * sc;
      g.strokeStyle = 'rgba(255,255,255,.4)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(10, Hh - 11); g.lineTo(10 + px, Hh - 11);
      g.moveTo(10, Hh - 14); g.lineTo(10, Hh - 8);
      g.moveTo(10 + px, Hh - 14); g.lineTo(10 + px, Hh - 8); g.stroke();
      g.fillStyle = 'rgba(255,255,255,.5)'; g.font = '9px ui-sans-serif,sans-serif';
      g.fillText('100 yds', 12, Hh - 16);
    },

    /**
     * The green book.
     *
     * Contours and slope arrows read straight off App.field's height grid — the
     * same surface the putt physics rolls the ball down — so this is a
     * measurement of the model, not an illustration of it. Contour interval is
     * three inches, which is what a real yardage book uses.
     */
    drawGreenBook() {
      const { g, W, H: Hh } = this._ctx('book', 186);
      const F = App.field;
      const H = App.holeData;
      const b = Play.ball();
      const pin = App.pinPos();

      let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9;
      const eat = (x, z) => {
        minx = Math.min(minx, x); maxx = Math.max(maxx, x);
        minz = Math.min(minz, z); maxz = Math.max(maxz, z);
      };
      for (const r of H.green.rings) for (const p of r) eat(p[0], p[1]);
      eat(b[0], b[2]); eat(pin[0], pin[2]);
      const m = 4;
      minx -= m; maxx += m; minz -= m; maxz += m;

      // rotate so the putt plays bottom-to-top
      const ang = Math.atan2(pin[2] - b[2], pin[0] - b[0]) + Math.PI / 2;
      const ca = Math.cos(-ang), sa = Math.sin(-ang);
      const cx = (minx + maxx) / 2, cz = (minz + maxz) / 2;
      const rot = (x, z) => { const dx = x - cx, dz = z - cz; return [dx * ca - dz * sa, dx * sa + dz * ca]; };
      let rx0 = 1e9, rx1 = -1e9, rz0 = 1e9, rz1 = -1e9;
      for (const [x, z] of [[minx, minz], [maxx, minz], [minx, maxz], [maxx, maxz]]) {
        const q = rot(x, z);
        rx0 = Math.min(rx0, q[0]); rx1 = Math.max(rx1, q[0]);
        rz0 = Math.min(rz0, q[1]); rz1 = Math.max(rz1, q[1]);
      }
      const pad = 12;
      const sc = Math.min((W - pad * 2) / (rx1 - rx0), (Hh - pad * 2) / (rz1 - rz0));
      const ox = W / 2 - (rx0 + rx1) / 2 * sc, oy = Hh / 2 - (rz0 + rz1) / 2 * sc;
      const Pp = (x, z) => { const q = rot(x, z); return [q[0] * sc + ox, q[1] * sc + oy]; };

      g.fillStyle = '#101510'; g.fillRect(0, 0, W, Hh);

      /* --- sample the real surface ------------------------------------- */
      const N = 44;
      const hs = new Float32Array(N * N);
      const onGreen = new Uint8Array(N * N);
      const gx = [], gz = [];
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          // sample in rotated space so the grid lines up with the drawing
          const u = rx0 + (i / (N - 1)) * (rx1 - rx0);
          const v = rz0 + (j / (N - 1)) * (rz1 - rz0);
          const x = cx + u * ca + v * sa;
          const z = cz - u * sa + v * ca;
          const k = j * N + i;
          hs[k] = F.height(x, z);
          onGreen[k] = F.sample(F.sdfGr, x, z) < 0.6 ? 1 : 0;
          if (j === 0) gx[i] = i / (N - 1) * (rx1 - rx0) * sc + (rx0 * sc + ox);
          if (i === 0) gz[j] = j / (N - 1) * (rz1 - rz0) * sc + (rz0 * sc + oy);
        }
      }

      // green outline as a clip
      g.save();
      g.beginPath();
      for (const r of H.green.rings) {
        const s = Pp(r[0][0], r[0][1]); g.moveTo(s[0], s[1]);
        for (let i = 1; i < r.length; i++) { const q = Pp(r[i][0], r[i][1]); g.lineTo(q[0], q[1]); }
        g.closePath();
      }
      g.fillStyle = '#3f6a33'; g.fill();
      g.clip();

      /* --- hypsometric tint, relative to the hole ---------------------- */
      const hPin = F.height(pin[0], pin[2]);
      const cw = (gx[1] - gx[0]) + 0.7, chh = (gz[1] - gz[0]) + 0.7;
      for (let j = 0; j < N - 1; j++) {
        for (let i = 0; i < N - 1; i++) {
          const d = hs[j * N + i] - hPin;
          const t = clamp(d / 0.55, -1, 1);
          const r = t > 0 ? 210 : 90, gg = t > 0 ? 150 : 150, bb = t > 0 ? 90 : 200;
          g.fillStyle = 'rgba(' + r + ',' + gg + ',' + bb + ',' + (Math.abs(t) * 0.30).toFixed(3) + ')';
          g.fillRect(gx[i], gz[j], cw, chh);
        }
      }

      /* --- contours, three inches apart ------------------------------- */
      const STEP = 0.0762;
      let lo = Infinity, hi = -Infinity;
      for (let k = 0; k < N * N; k++) { if (hs[k] < lo) lo = hs[k]; if (hs[k] > hi) hi = hs[k]; }
      g.lineWidth = 0.8;
      for (let lv = Math.ceil(lo / STEP) * STEP; lv <= hi; lv += STEP) {
        const major = Math.abs(Math.round(lv / (STEP * 4)) * STEP * 4 - lv) < 1e-6;
        g.strokeStyle = major ? 'rgba(255,255,255,.34)' : 'rgba(255,255,255,.15)';
        g.beginPath();
        for (let j = 0; j < N - 1; j++) {
          for (let i = 0; i < N - 1; i++) {
            const a = hs[j * N + i], b2 = hs[j * N + i + 1];
            const c = hs[(j + 1) * N + i + 1], d = hs[(j + 1) * N + i];
            const x0 = gx[i], x1 = gx[i + 1], y0 = gz[j], y1 = gz[j + 1];
            const pts = [];
            const edge = (va, vb, xa, ya, xb, yb) => {
              if ((va < lv) === (vb < lv)) return;
              const t = (lv - va) / (vb - va);
              pts.push([xa + (xb - xa) * t, ya + (yb - ya) * t]);
            };
            edge(a, b2, x0, y0, x1, y0);
            edge(b2, c, x1, y0, x1, y1);
            edge(c, d, x1, y1, x0, y1);
            edge(d, a, x0, y1, x0, y0);
            for (let q = 0; q + 1 < pts.length; q += 2) {
              g.moveTo(pts[q][0], pts[q][1]);
              g.lineTo(pts[q + 1][0], pts[q + 1][1]);
            }
          }
        }
        g.stroke();
      }

      /* --- fall lines -------------------------------------------------- */
      const S = 6;
      for (let j = 1; j < N - 1; j += S) {
        for (let i = 1; i < N - 1; i += S) {
          if (!onGreen[j * N + i]) continue;
          const dhx = hs[j * N + i + 1] - hs[j * N + i - 1];
          const dhz = hs[(j + 1) * N + i] - hs[(j - 1) * N + i];
          const mag = Math.hypot(dhx, dhz);
          if (mag < 0.004) continue;
          const ux = -dhx / mag, uz = -dhz / mag;      // downhill
          const len = clamp(mag * 160, 3, 11);
          const x = gx[i], y = gz[j];
          g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 1;
          g.beginPath();
          g.moveTo(x - ux * len * 0.5, y - uz * len * 0.5);
          g.lineTo(x + ux * len * 0.5, y + uz * len * 0.5);
          g.stroke();
          g.beginPath();
          g.moveTo(x + ux * len * 0.5, y + uz * len * 0.5);
          g.lineTo(x + ux * len * 0.5 - ux * 3 + uz * 2, y + uz * len * 0.5 - uz * 3 - ux * 2);
          g.moveTo(x + ux * len * 0.5, y + uz * len * 0.5);
          g.lineTo(x + ux * len * 0.5 - ux * 3 - uz * 2, y + uz * len * 0.5 - uz * 3 + ux * 2);
          g.stroke();
        }
      }
      g.restore();

      // green edge on top of the clip
      g.strokeStyle = 'rgba(255,255,255,.30)'; g.lineWidth = 1.2;
      for (const r of H.green.rings) {
        g.beginPath();
        const s = Pp(r[0][0], r[0][1]); g.moveTo(s[0], s[1]);
        for (let i = 1; i < r.length; i++) { const q = Pp(r[i][0], r[i][1]); g.lineTo(q[0], q[1]); }
        g.closePath(); g.stroke();
      }

      /* --- ball, hole, and the read ----------------------------------- */
      const bp = Pp(b[0], b[2]), hp = Pp(pin[0], pin[2]);
      if (Play.isPutting() && Play.assist && !Play.state.holed) {
        const r = Play.read();
        const sim = SP.putt({ origin: b, aim: r.aim, speed: r.speed, field: F,
                              pin: pin, stimp: Play.stimp });
        g.strokeStyle = 'rgba(255,235,170,.9)'; g.lineWidth = 1.6;
        g.beginPath();
        const q0 = Pp(sim.path[0][0], sim.path[0][2]); g.moveTo(q0[0], q0[1]);
        for (const p of sim.path) { const q = Pp(p[0], p[2]); g.lineTo(q[0], q[1]); }
        g.stroke();
      }
      // the line the player is actually aiming
      if (!Play.state.holed) {
        const d = Play.toPin() * 1.12;
        const t2 = Pp(b[0] + Math.cos(Play.aim) * d, b[2] + Math.sin(Play.aim) * d);
        g.strokeStyle = 'rgba(140,200,255,.75)'; g.lineWidth = 1; g.setLineDash([3, 3]);
        g.beginPath(); g.moveTo(bp[0], bp[1]); g.lineTo(t2[0], t2[1]); g.stroke();
        g.setLineDash([]);
      }

      g.fillStyle = '#0c0f0c';
      g.beginPath(); g.arc(hp[0], hp[1], 3.4, 0, 7); g.fill();
      g.strokeStyle = '#e8c447'; g.lineWidth = 1.2; g.stroke();
      g.fillStyle = '#fff';
      g.strokeStyle = 'rgba(0,0,0,.6)'; g.lineWidth = 1;
      g.beginPath(); g.arc(bp[0], bp[1], 3, 0, 7); g.fill(); g.stroke();

      g.fillStyle = 'rgba(255,255,255,.45)'; g.font = '9px ui-sans-serif,sans-serif';
      g.fillText('contours 3 in · arrows point downhill', 8, Hh - 7);
    },

    /* ------------------------------------------------------- canvas input */
    bindCanvas(canvas) {
      let dragging = false, lx = 0, ly = 0, button = 0, moved = 0;
      const touches = new Map();
      let pinchDist0 = 0, pinchStart = 0;

      const toOrbit = () => {
        if (App.camMode !== 'free') {
          const eye = App.camPos, look = App.camLook;
          const dx = look[0] - eye[0], dy = look[1] - eye[1], dz = look[2] - eye[2];
          const dist = Math.max(Math.hypot(dx, dy, dz), 6);
          App.orbit = {
            target: [eye[0] + dx, eye[1] + dy, eye[2] + dz], dist,
            yaw: Math.atan2(dz, dx), pitch: Math.asin(clamp(dy / dist, -1, 1))
          };
          App.setCamera('free', false);
        }
      };
      const pinchSpan = () => {
        const p = [...touches.values()];
        return p.length < 2 ? 0 : Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      };

      canvas.addEventListener('pointerdown', e => {
        if (document.body.classList.contains('photo')) { $('photoBtn').click(); return; }
        if (e.pointerType === 'touch') {
          touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (touches.size === 2) { toOrbit(); pinchDist0 = pinchSpan(); pinchStart = App.orbit.dist; dragging = false; return; }
        }
        canvas.setPointerCapture(e.pointerId);
        dragging = true; lx = e.clientX; ly = e.clientY; button = e.button; moved = 0;
        canvas.classList.add('dragging');
      });
      canvas.addEventListener('pointerup', e => {
        if (touches.has(e.pointerId)) {
          touches.delete(e.pointerId);
          if (touches.size < 2) pinchDist0 = 0;
          if (touches.size >= 1) { dragging = false; return; }
        }
        dragging = false;
        canvas.classList.remove('dragging');
        if (moved < 5 && button === 0) this.clickAim(e);
      });
      canvas.addEventListener('pointercancel', () => { dragging = false; canvas.classList.remove('dragging'); });
      canvas.addEventListener('pointermove', e => {
        if (touches.has(e.pointerId)) {
          touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (touches.size === 2 && pinchDist0 > 8) {
            const span = pinchSpan();
            if (span > 8) App.orbit.dist = clamp(pinchStart * (pinchDist0 / span), 3, 2200);
            return;
          }
        }
        if (!dragging) return;
        const dx = e.clientX - lx, dy = e.clientY - ly;
        lx = e.clientX; ly = e.clientY;
        moved += Math.abs(dx) + Math.abs(dy);
        if (moved < 4) return;
        toOrbit();
        const o = App.orbit;
        if (button === 2 || e.shiftKey) {
          const s = o.dist * 0.0016;
          const cy = Math.cos(o.yaw), sy = Math.sin(o.yaw);
          o.target[0] += (sy * dx - cy * dy * 0.6) * s;
          o.target[2] += (-cy * dx - sy * dy * 0.6) * s;
        } else {
          o.yaw += dx * 0.0055;
          o.pitch = clamp(o.pitch - dy * 0.0045, -1.42, 0.32);
        }
      });
      canvas.addEventListener('contextmenu', e => e.preventDefault());
      canvas.addEventListener('wheel', e => {
        e.preventDefault();
        toOrbit();
        App.orbit.dist = clamp(App.orbit.dist * Math.exp(e.deltaY * 0.0012), 3, 2200);
      }, { passive: false });
    },

    clickAim(e) {
      if (Play.state.phase !== 'idle' || Play.state.holed) return;
      const r = $('gl').getBoundingClientRect();
      const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
      const ny = 1 - ((e.clientY - r.top) / r.height) * 2;
      const hit = App.pick(nx, ny);
      if (!hit) return;
      Play.setAim(hit);
      const b = Play.ball();
      const d = Math.hypot(hit[0] - b[0], hit[2] - b[2]) * M2Y;
      const surf = App.field.surfaceAt(hit[0], hit[2]);
      const S = SP.LIES[surf];
      this.flash('Aiming ' + Math.round(d) + ' yds · ' + (S ? S.name : surf));
    },

    flash(text) {
      const el = $('flash');
      el.textContent = text;
      el.style.opacity = '1';
      clearTimeout(this._flashT);
      this._flashT = setTimeout(() => { el.style.opacity = '0'; }, 2100);
    },

    /* ------------------------------------------------------------ meter */
    drawMeter() {
      const ph = Play.state.phase;
      const on = ph === 'power' || ph === 'strike';
      $('meter').classList.toggle('on', on);
      if (!on) return;
      const m = Play.meter;
      if (ph === 'power') {
        const putt = Play.isPutting();
        $('barPower').style.display = 'block';
        $('barStrike').style.display = 'none';
        this.markTarget();
        const pct = clamp(m.t / 1.12, 0, 1) * 100;
        $('barPower').querySelector('.fill').style.width = pct + '%';
        $('barPower').querySelector('.needle').style.left = pct + '%';
        $('mL').textContent = putt ? 'Pace' : 'Power';
        $('mR').textContent = Math.round(m.t * 100) + '%';
        $('mHint').textContent = putt
          ? (this.touch ? 'Tap Putt' : 'Space') + ' on the green mark for the caddie\'s pace'
          : (this.touch ? 'Tap again' : 'Space') + ' to set the power — past the line is an overswing';
      } else {
        $('barPower').style.display = 'block';
        $('barStrike').style.display = 'block';
        const pw = clamp(m.power / 1.12, 0, 1) * 100;
        $('barPower').querySelector('.fill').style.width = pw + '%';
        $('barPower').querySelector('.needle').style.left = pw + '%';
        const pct = (m.t * 0.5 + 0.5) * 100;
        $('barStrike').querySelector('.needle').style.left = pct + '%';
        $('mL').textContent = 'Face at impact';
        $('mR').textContent = m.t < -0.08 ? 'closed' : m.t > 0.08 ? 'open' : 'square';
        $('mHint').textContent = (this.touch ? 'Tap' : 'Space') + ' again in the green band for a flush strike';
      }
    },

    /** Where on the power bar the caddie wants the needle stopped. */
    markTarget() {
      let el = this._tgt;
      if (!el) {
        el = this._tgt = document.createElement('div');
        el.className = 'mark';
        el.style.background = 'rgba(127,196,106,.95)';
        el.style.width = '2px';
        $('barPower').appendChild(el);
      }
      if (Play.isPutting()) {
        el.style.display = 'block';
        el.style.left = (clamp((this.puttPace || 1) / 1.12, 0, 1) * 100) + '%';
        return;
      }
      try {
        el.style.display = 'block';
        el.style.left = (clamp(Play.plan().power / 1.12, 0, 1) * 100) + '%';
      } catch (e) { el.style.display = 'none'; }
    },

    /* ----------------------------------------------------------- labels */
    ensureLabels(n) {
      const host = $('labels');
      while (this.labels.length < n) {
        const d = document.createElement('div');
        d.className = 'lbl';
        host.appendChild(d);
        this.labels.push(d);
      }
      return this.labels;
    },

    project(p, out) {
      const v = new Float32Array(3);
      M4.xformPoint(v, App.mVP, p);
      if (v[2] > 1 || v[2] < -1) return null;
      out[0] = (v[0] * 0.5 + 0.5) * window.innerWidth;
      out[1] = (1 - (v[1] * 0.5 + 0.5)) * window.innerHeight;
      return out;
    },

    updateLabels() {
      const items = [];
      const pin = App.pinPos();
      const flying = App.shot && App.shotAnim < 0.995;
      const from = flying ? App.shot.path[0] : Play.ball();
      const d = Math.hypot(pin[0] - from[0], pin[2] - from[2]) * M2Y;
      const putting = Play.isPutting();
      items.push({
        p: [pin[0], pin[1] + 3.2, pin[2]],
        t: putting ? Math.round(d * 3.28084) + ' ft' : 'PIN · ' + Math.round(d) + ' yds',
        cls: 'lbl pin'
      });

      if (App.shot && !flying && !Play.state.holed) {
        const f = App.shot.finalPoint;
        const toPin = Math.hypot(pin[0] - f[0], pin[2] - f[2]) * M2Y;
        if (!App.shot.putt) {
          items.push({ p: [f[0], f[1] + 1.5, f[2]],
                       t: Math.round(App.shot.stats.totalYd) + ' yds · ' + Math.round(toPin) + ' to pin',
                       cls: 'lbl dist' });
          const rollYd = App.shot.stats.totalYd - App.shot.stats.carryYd;
          if (rollYd > 12) {
            const l = App.shot.landPoint;
            items.push({ p: [l[0], l[1] + 0.9, l[2]], t: 'carry ' + Math.round(App.shot.stats.carryYd), cls: 'lbl' });
          }
        }
      } else if (App.aimPoint && !flying) {
        const a = App.aimPoint;
        const da = Math.hypot(a[0] - from[0], a[2] - from[2]) * M2Y;
        items.push({ p: [a[0], a[1] + 1.1, a[2]], t: 'aim ' + Math.round(da) + ' yds', cls: 'lbl dist' });
      }

      const els = this.ensureLabels(items.length);
      const placed = [];
      const out = [0, 0];
      for (let i = 0; i < els.length; i++) {
        if (i >= items.length) { els[i].style.display = 'none'; continue; }
        const it = items[i];
        const r = this.project(it.p, out);
        if (!r || r[0] < -80 || r[0] > innerWidth + 80 || r[1] < -40 || r[1] > innerHeight + 40) {
          els[i].style.display = 'none';
          continue;
        }
        let x = r[0], y = r[1];
        for (const q of placed) if (Math.abs(x - q[0]) < 150 && Math.abs(y - q[1]) < 24) y = q[1] + 26;
        placed.push([x, y]);
        els[i].style.display = 'block';
        els[i].className = it.cls;
        els[i].textContent = it.t;
        els[i].style.left = x + 'px';
        els[i].style.top = y + 'px';
      }
    },

    onHoleChanged() { /* single hole; the card is rebuilt by onPlayChanged */ },

    onCameraChanged() {
      document.querySelectorAll('#camBar button').forEach(b => {
        b.classList.toggle('on', b.dataset.cam === App.camMode);
      });
    },

    onShotProgress(p) {
      if (p >= 1 && !this._settled) {
        this._settled = true;
        // let the ball sit for a beat before the camera and the HUD move on
        setTimeout(() => {
          if (!Play.tracks) Play.tracks = [];
          if (App.tracerPoints && !App.shot.putt) Play.tracks.push(App.tracerPoints.slice());
          Play.settle();
        }, 420);
      }
      if (p < 1) this._settled = false;
    },

    /* ------------------------------------------------------------- loop */
    loop() {
      let last = performance.now(), acc = 0, frames = 0, pending = false;
      const schedule = () => {
        if (pending) return;
        pending = true;
        let fired = false;
        const fire = () => { if (!fired) { fired = true; pending = false; tick(); } };
        requestAnimationFrame(fire);
        setTimeout(fire, 100);
      };
      const tick = () => {
        const now = performance.now();
        const dt = Math.min((now - last) / 1000, 0.05);
        last = now;
        if (this.paused) { setTimeout(() => { pending = false; schedule(); }, 200); return; }
        this.step('physics', () => Play.tick(dt));
        this.step('meter', () => this.drawMeter());
        this.step('render', () => App.render(dt));
        this.fc++;
        this.step('shot', () => App.advanceShot(dt));
        this.step('labels', () => this.updateLabels());
        this.watchFrameTime(performance.now() - now);
        acc += dt; frames++;
        if (now - (this._insT || 0) > 400) { this._insT = now; this.measureInsets(); }
        if (acc > 0.6) {
          this.watchFps(frames / acc);
          const K = App.sky;
          if (K) {
            $('fps').textContent = Math.round(frames / acc) + ' fps · ' +
              K.solar.elevation.toFixed(0) + '° sun · EV ' + Math.log2(1 / K.exposure).toFixed(1);
          }
          acc = 0; frames = 0;
        }
        schedule();
      };
      schedule();
    }
  };

  root.UI = UI;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => UI.boot());
  } else {
    UI.boot();
  }
})(window);
