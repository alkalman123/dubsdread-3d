/* DOM wiring, hole map, labels, camera input. */
(function (root) {
  'use strict';

  const { clamp, lerp, M4 } = root.MM;
  const App = root.App;
  const $ = id => document.getElementById(id);
  const M2Y = 1.09361;
  const Y2M = 0.9144;

  const TEE_COLOR = ['#141414', '#b02525', '#2a5bbf', '#e8e8e4', '#d8b12c', '#c2497a'];

  const esc = s => String(s).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /** Lighten (t>0) or darken (t<0) a #rrggbb colour. */
  function shade(hex, t) {
    const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || '');
    if (!m) return hex;
    const ch = i => {
      const v = parseInt(m[i], 16);
      const n = Math.round(t < 0 ? v * (1 + t) : v + (255 - v) * t);
      return Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
    };
    return '#' + ch(1) + ch(2) + ch(3);
  }

  const UI = {
    labels: [],

    /* ------------------------------------------------------------ boot */
    async boot() {
      const canvas = $('gl');
      const bar = $('bar').firstElementChild;
      const msg = $('loadMsg');
      const steps = 6;
      let done = 0;

      this.brand = this.applyBranding();
      this.params = new URLSearchParams(location.search);

      // Fail loudly and usefully rather than showing a black screen.
      const fail = (title, detail) => {
        $('err').style.display = 'block';
        $('err').innerHTML = detail;
        msg.textContent = title;
      };

      if (typeof window.COURSE === 'undefined') {
        fail('Course data did not load.',
          'course-data.js was not read.\n\n' +
          'If you opened this page from a cloud-synced or read-only location, copy the whole ' +
          'folder somewhere local and try again. You can also run <b>serve.cmd</b> in this ' +
          'folder and open http://localhost:8099.');
        return;
      }
      if (!document.createElement('canvas').getContext('webgl2')) {
        fail('This browser cannot run the preview.',
          'WebGL 2 is required. Chrome, Edge, Firefox and Safari 15+ all support it — ' +
          'if you are on one of those, hardware acceleration may be switched off in the ' +
          'browser settings.');
        return;
      }

      // If startup stalls, say so. A frozen splash screen is indistinguishable
      // from a screenshot, and the user has no way to tell which they are seeing.
      const watchdog = setTimeout(() => {
        if (App.ready) return;
        $('err').style.display = 'block';
        $('err').innerHTML =
          'Still working. Building the terrain takes a few seconds the first time, ' +
          'but if this message stays put, the page is probably running somewhere ' +
          'that throttles background rendering — try opening it in its own tab.';
      }, 25000);

      try {
        await App.init(canvas, label => {
          if (label) {
            msg.textContent = label + '…';
            bar.style.width = Math.round((done++ / steps) * 100) + '%';
          } else {
            bar.style.width = '100%';
            msg.textContent = 'Ready';
          }
        });
      } catch (e) {
        console.error(e);
        $('err').style.display = 'block';
        $('err').textContent = (e && e.message) || String(e);
        msg.textContent = 'Could not start the 3D preview.';
        return;
      }

      clearTimeout(watchdog);
      $('err').style.display = 'none';

      this.buildStrip();
      this.buildLightSeg();
      this.buildCamBar();
      this.buildSelects();
      this.bindControls();
      this.bindCanvas(canvas);
      this.bindShare();
      this.onHoleChanged();

      $('credit').innerHTML = this.brand.credit;

      try {
        await this.applyDeepLink();
      } catch (e) {
        // a malformed link must never stop the preview from starting
        console.warn('deep link ignored:', e);
      }

      setTimeout(() => $('load').classList.add('done'), 400);
      this.loop();
      setTimeout(() => this.assertControlsClickable(), 1200);
    },

    /**
     * Verify the primary controls are actually hit-testable.
     *
     * Synthetic clicks (element.click(), dispatchEvent) bypass hit-testing, so a
     * transparent overlay sitting on top of the UI will pass every scripted test
     * and still leave the page completely dead for a real user. This checks what
     * the browser would actually deliver a click to.
     */
    assertControlsClickable() {
      const blocked = [];
      const check = (label, el) => {
        if (!el) return;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return;
        const x = Math.round(r.left + r.width / 2);
        const y = Math.round(r.top + r.height / 2);
        if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return;
        const top = document.elementFromPoint(x, y);
        if (!top || !(top === el || el.contains(top))) {
          blocked.push(label + ' <- ' + (top ? top.tagName.toLowerCase() +
            (top.id ? '#' + top.id : '') : 'nothing'));
        }
      };
      check('hole button', document.querySelector('.hbtn'));
      check('camera button', document.querySelector('#camBar button'));
      check('canvas', $('gl'));
      const hit = $('hit');
      if (hit && getComputedStyle(hit.closest('#tools') || hit).display !== 'none') check('hit button', hit);

      if (blocked.length) {
        console.error('[preview] controls are not clickable — something is covering them:\n  ' +
          blocked.join('\n  '));
      }
      return blocked;
    },

    /* --------------------------------------------------------- branding */
    /**
     * Everything club-specific comes from branding.js so the same engine can be
     * re-skinned for another course without touching the renderer.
     */
    applyBranding() {
      const d = {
        club: 'Golf Club', course: 'Course', courseSub: '', location: '',
        crest: '', title: document.title, accent: '#c9a227',
        panel: 'rgba(14,18,17,.80)', cta: { label: '', url: '' }, credit: '',
        defaults: { hole: 1, camera: 'tee', tee: 0, lighting: 'midday', quality: 'auto' },
        kiosk: { enabled: false, secondsPerHole: 26 }
      };
      const b = Object.assign({}, d, window.BRANDING || {});
      b.cta = Object.assign({}, d.cta, b.cta);
      b.defaults = Object.assign({}, d.defaults, b.defaults);
      b.kiosk = Object.assign({}, d.kiosk, b.kiosk);

      document.title = b.title;
      const root = document.documentElement;
      root.style.setProperty('--gold', b.accent);
      root.style.setProperty('--gold-dim', shade(b.accent, -0.28));
      root.style.setProperty('--panel', b.panel);

      for (const id of ['bCrest', 'lCrest']) {
        const c = $(id);
        if (!c) continue;
        if (b.crest) c.textContent = b.crest; else c.style.display = 'none';
      }
      // "Cog Hill Golf & Country Club" -> "Cog Hill"; the header has no room for
      // the legal name and nobody says it out loud anyway
      const short = b.club.replace(/\s+(Golf|Country)\b.*$/i, '').trim() || b.club;

      const lt = $('lTitle');
      if (lt) {
        lt.innerHTML = esc([short, b.courseSub].filter(Boolean).join(' ')) +
          ' · <em>' + esc(b.course) + '</em>';
      }
      $('bTitle').innerHTML = esc(short) + ' · <em>' + esc(b.course) + '</em>';
      // the town is the first thing to go when the header gets tight
      $('bSub').innerHTML = esc(b.courseSub) +
        (b.location ? '<span class="bLoc"> &nbsp;·&nbsp; ' + esc(b.location) + '</span>' : '');

      if (b.cta.url) {
        const cta = $('cta');
        cta.textContent = b.cta.label || 'Book a tee time';
        cta.href = b.cta.url;
        cta.hidden = false;
      }

      // favicon without an external file: an inline SVG in the accent colour
      const ico = document.createElement('link');
      ico.rel = 'icon';
      ico.href = 'data:image/svg+xml,' + encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
        `<rect width="32" height="32" rx="7" fill="#0e1211"/>` +
        `<circle cx="16" cy="16" r="9.5" fill="none" stroke="${b.accent}" stroke-width="2"/>` +
        `<circle cx="16" cy="16" r="3" fill="${b.accent}"/></svg>`);
      document.head.appendChild(ico);

      return b;
    },

    /* -------------------------------------------------------- deep links */
    /**
     * ?hole=7&cam=flyover&tee=2&light=golden&embed=1&tour=1
     * Lets a club link straight to a hole, drop the preview into a page as an
     * iframe, or run it hands-free on a clubhouse screen.
     */
    async applyDeepLink() {
      const p = this.params;
      const b = this.brand;
      const num = (k, dflt) => {
        const v = parseInt(p.get(k), 10);
        return isNaN(v) ? dflt : v;
      };

      if (p.get('embed') === '1') document.body.classList.add('embed');

      const light = p.get('light') || b.defaults.lighting;
      if (App.LIGHTING[light]) {
        App.lighting = light;
        document.querySelectorAll('#lightSeg button').forEach((el, i) => {
          el.classList.toggle('on', ['morning', 'midday', 'afternoon', 'golden', 'overcast'][i] === light);
        });
      }

      const q = p.get('quality') || b.defaults.quality;
      if (q === 'fast' || (q === 'auto' && this.looksLowPowered())) {
        const btn = document.querySelector('#qualSeg button[data-q="fast"]');
        if (btn) btn.click();
      }

      const tee = num('tee', b.defaults.tee);
      const hole = clamp(num('hole', b.defaults.hole), 1, 18);
      App.teeSet = Math.max(0, tee);

      if (hole !== App.hole) {
        await App.loadHoleAsync(hole, false, null);
      } else {
        App.teeSet = clamp(App.teeSet, 0, App.holeData.tees.length - 1);
        App.aim = App.defaultAim();
      }
      this.onHoleChanged();

      const cam = p.get('cam') || b.defaults.camera;
      if (App.CAMERAS.indexOf(cam) >= 0) App.setCamera(cam, true);

      if (p.get('tour') === '1' || b.kiosk.enabled) this.startTour();
    },

    looksLowPowered() {
      const mem = navigator.deviceMemory || 8;
      const cores = navigator.hardwareConcurrency || 8;
      const coarse = matchMedia('(pointer: coarse)').matches;
      return mem <= 4 || cores <= 4 || coarse || window.innerWidth < 700;
    },

    /** Keep the address bar in step so "copy link" always means something. */
    syncUrl() {
      if (!App.ready) return;
      const u = new URL(location.href);
      u.searchParams.set('hole', App.hole);
      u.searchParams.set('cam', App.camMode);
      u.searchParams.set('tee', App.teeSet);
      u.searchParams.set('light', App.lighting);
      try {
        history.replaceState(null, '', u);
      } catch (e) {
        /* some hosts disallow rewriting the address; the app is unaffected */
      }

      const full = $('openFull');
      if (full) {
        const f = new URL(u.toString());
        f.searchParams.delete('embed');
        full.href = f.toString();
      }
    },

    bindShare() {
      const btn = $('shareBtn');
      if (btn) btn.onclick = () => {
        this.syncUrl();
        const url = location.href;
        const done = () => this.flash('Link to this view copied');
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).then(done, () => this.flash(url));
          } else {
            this.flash(url);
          }
        } catch (e) {
          this.flash(url);
        }
      };
      const tour = $('tourBtn');
      if (tour) tour.onclick = () => this.tourTimer ? this.stopTour() : this.startTour();
    },

    /* ------------------------------------------------------- kiosk tour */
    startTour() {
      this.stopTour();
      document.body.classList.add('kiosk');
      App.setCamera('flyover', true);
      const secs = (this.brand.kiosk && this.brand.kiosk.secondsPerHole) || 26;
      const step = () => {
        if (App.loading) return;
        this.goHole(App.hole % 18 + 1);
        App.setCamera('flyover', true);
      };
      this.tourTimer = setInterval(step, secs * 1000);
      const stop = () => this.stopTour();
      this._tourStop = stop;
      window.addEventListener('keydown', stop, { once: true });
      $('gl').addEventListener('pointerdown', stop, { once: true });
      this.flash('Auto tour — press any key to stop');
    },

    stopTour() {
      if (this.tourTimer) clearInterval(this.tourTimer);
      this.tourTimer = null;
      document.body.classList.remove('kiosk');
    },

    /* ------------------------------------------------------ hole strip */
    buildStrip() {
      const s = $('strip');
      s.innerHTML = '';
      const mk = (h) => {
        const b = document.createElement('button');
        b.className = 'hbtn' + (h.num === App.hole ? ' on' : '');
        b.dataset.hole = h.num;
        b.innerHTML = `<b>${h.num}</b><span>Par ${h.par}</span>`;
        b.title = `Hole ${h.num} · Par ${h.par} · ${h.yards} yards · Stroke index ${h.hcp}`;
        b.onclick = () => this.goHole(h.num);
        return b;
      };
      const C = App.course;
      for (let i = 0; i < 9; i++) s.appendChild(mk(C.holes[i]));
      const t1 = document.createElement('div');
      t1.className = 'strip-tot';
      t1.innerHTML = `<b>${C.meta.outYards}</b><span>Out ${C.meta.outPar}</span>`;
      s.appendChild(t1);
      const sep = document.createElement('div'); sep.className = 'strip-sep'; s.appendChild(sep);
      for (let i = 9; i < 18; i++) s.appendChild(mk(C.holes[i]));
      const t2 = document.createElement('div');
      t2.className = 'strip-tot';
      t2.innerHTML = `<b>${C.meta.inYards}</b><span>In ${C.meta.inPar}</span>`;
      s.appendChild(t2);
      const sep2 = document.createElement('div'); sep2.className = 'strip-sep'; s.appendChild(sep2);
      const t3 = document.createElement('div');
      t3.className = 'strip-tot';
      t3.innerHTML = `<b>${C.meta.yards.toLocaleString()}</b><span>Par ${C.meta.par}</span>`;
      s.appendChild(t3);
    },

    buildLightSeg() {
      const seg = $('lightSeg');
      seg.innerHTML = '';
      for (const k of ['morning', 'midday', 'afternoon', 'golden', 'overcast']) {
        const b = document.createElement('button');
        b.textContent = App.LIGHTING[k].name;
        b.className = k === App.lighting ? 'on' : '';
        b.onclick = () => {
          App.lighting = k;
          [...seg.children].forEach(c => c.classList.remove('on'));
          b.classList.add('on');
        };
        seg.appendChild(b);
      }
    },

    buildCamBar() {
      const bar = $('camBar');
      bar.innerHTML = '';
      const names = { tee: 'Tee', approach: 'Approach', green: 'Green', flyover: 'Flyover', aerial: 'Aerial', free: 'Free' };
      for (const m of App.CAMERAS) {
        const b = document.createElement('button');
        b.textContent = names[m];
        b.dataset.cam = m;
        b.className = m === App.camMode ? 'on' : '';
        b.onclick = () => App.setCamera(m, false);
        bar.appendChild(b);
      }
    },

    buildSelects() {
      const cs = $('club');
      cs.innerHTML = '';
      for (const c of root.Shot.CLUBS) {
        const o = document.createElement('option');
        o.value = c.id; o.textContent = c.name;
        cs.appendChild(o);
      }
      cs.value = 'D';
      App.club = 'D';

      const ms = $('mClub');
      if (ms) {
        ms.innerHTML = cs.innerHTML;
        ms.value = 'D';
        ms.onchange = e => { cs.value = e.target.value; cs.onchange(e); };
      }

      const ps = $('profile');
      ps.innerHTML = '';
      for (const p of root.Shot.PROFILES) {
        const o = document.createElement('option');
        o.value = p.id; o.textContent = p.name + ' — ' + p.label;
        ps.appendChild(o);
      }
      ps.value = 'tour';
      App.profile = 'tour';
    },

    /* -------------------------------------------------------- controls */
    bindControls() {
      $('club').onchange = e => {
        App.club = e.target.value;
        $('clubName').textContent = root.Shot.clubBy(App.club).name;
        const ms = $('mClub');
        if (ms && ms.value !== App.club) ms.value = App.club;
      };
      $('mHit').onclick = () => this.hit();
      $('mReset').onclick = () => {
        App.clearShot();
        $('readout').classList.remove('on');
        this.refreshLie();
      };
      $('profile').onchange = e => {
        App.profile = e.target.value;
        const p = root.Shot.PROFILES.find(x => x.id === App.profile);
        $('profName').textContent = p.name;
      };
      $('shape').oninput = e => {
        App.shape = e.target.value / 100;
        const v = App.shape;
        $('shapeVal').textContent =
          v < -0.55 ? 'Big draw' : v < -0.15 ? 'Draw' :
          v > 0.55 ? 'Big fade' : v > 0.15 ? 'Fade' : 'Straight';
      };
      $('power').oninput = e => {
        App.power = e.target.value / 100;
        $('powerVal').textContent = e.target.value + '%';
      };
      $('wind').oninput = e => {
        App.wind.speed = +e.target.value;
        $('windVal').textContent = App.wind.speed === 0 ? 'Calm'
          : Math.round(App.wind.speed * 2.237) + ' mph';
        this.updateWindDir();
      };
      $('wdir').oninput = e => {
        App.wind.dir = +e.target.value;
        this.updateWindDir();
      };
      $('grassBtn').onclick = () => {
        App.showGrass = !App.showGrass;
        $('grassVal').textContent = App.showGrass ? 'On' : 'Off';
        App.updateGrass(true);
      };
      $('hit').onclick = () => this.hit();
      $('reset').onclick = () => { App.clearShot(); $('readout').classList.remove('on'); this.refreshLie(); };

      $('qualSeg').querySelectorAll('button').forEach(b => {
        b.onclick = () => {
          App.quality = b.dataset.q;
          $('qualSeg').querySelectorAll('button').forEach(x => x.classList.remove('on'));
          b.classList.add('on');
          App.rt = null;
          App.resize();
          this.busy('Rebuilding');
          App.loadHoleAsync(App.hole, false, s => this.busy(s ? 'Rebuilding · ' + s : null));
        };
      });

      window.addEventListener('keydown', e => {
        if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
        if (e.key === 'ArrowRight' || e.key === ']') this.goHole(App.hole + 1);
        else if (e.key === 'ArrowLeft' || e.key === '[') this.goHole(App.hole - 1);
        else if (e.key === ' ') { e.preventDefault(); this.hit(); }
        else if (e.key >= '1' && e.key <= '9' && !e.shiftKey) this.goHole(+e.key);
        else {
          const i = App.CAMERAS.indexOf(App.camMode);
          if (e.key === 'c') App.setCamera(App.CAMERAS[(i + 1) % App.CAMERAS.length], false);
        }
      });
      window.addEventListener('resize', () => App.resize());
    },

    updateWindDir() {
      const d = App.wind.dir;
      const names = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];
      // world +X is east, +Z is south
      const idx = Math.round(d / 45) % 8;
      $('windDir').textContent = App.wind.speed === 0 ? '—' : ('From the ' + names[(idx + 4) % 8]);
    },

    /* ---------------------------------------------------- canvas input */
    bindCanvas(canvas) {
      let dragging = false, lx = 0, ly = 0, button = 0, moved = 0;

      const toOrbit = () => {
        if (App.camMode !== 'free') {
          // capture the current view as the free-orbit starting point
          const eye = App.camPos, look = App.camLook;
          const dx = look[0] - eye[0], dy = look[1] - eye[1], dz = look[2] - eye[2];
          const dist = Math.max(Math.hypot(dx, dy, dz), 6);
          App.orbit = {
            target: [eye[0] + dx, eye[1] + dy, eye[2] + dz],
            dist,
            yaw: Math.atan2(dz, dx),
            pitch: Math.asin(clamp(dy / dist, -1, 1))
          };
          App.setCamera('free', false);
        }
      };

      // two-finger pinch maps to orbit distance
      const touches = new Map();
      let pinchStart = 0, pinchDist0 = 0;
      const pinchSpan = () => {
        const p = [...touches.values()];
        return p.length < 2 ? 0 : Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      };

      canvas.addEventListener('pointerdown', e => {
        if (e.pointerType === 'touch') {
          touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (touches.size === 2) {
            toOrbit();
            pinchDist0 = pinchSpan();
            pinchStart = App.orbit.dist;
            dragging = false;
            return;
          }
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
            if (span > 8) {
              App.orbit.dist = clamp(pinchStart * (pinchDist0 / span), 3, 2200);
            }
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
        const o = App.orbit;
        o.dist = clamp(o.dist * Math.exp(e.deltaY * 0.0012), 3, 2200);
      }, { passive: false });
    },

    clickAim(e) {
      const r = $('gl').getBoundingClientRect();
      const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
      const ny = 1 - ((e.clientY - r.top) / r.height) * 2;
      const hit = App.pick(nx, ny);
      if (!hit) return;
      const o = App.ballPos || App.teePos();
      App.aim = Math.atan2(hit[2] - o[2], hit[0] - o[0]);
      App.aimPoint = hit;
      const d = Math.hypot(hit[0] - o[0], hit[2] - o[2]) * M2Y;
      const surf = App.field.surfaceAt(hit[0], hit[2]);
      const S = root.Shot.SURFACE[surf];
      this.flash(`Aiming ${Math.round(d)} yds · ${S ? S.name : surf}`);
      // auto-select a club that carries there
      const best = root.Shot.clubForDistance(d, App.profile, App.field, o, App.aim, App.windVec());
      if (best) {
        App.club = best.club.id;
        $('club').value = best.club.id;
        const ms = $('mClub');
        if (ms) ms.value = best.club.id;
        $('clubName').textContent = best.club.name;
      }
    },

    flash(text) {
      let el = $('flash');
      if (!el) {
        el = document.createElement('div');
        el.id = 'flash';
        el.style.cssText = 'position:absolute;left:50%;top:22px;transform:translateX(-50%);' +
          'background:rgba(8,12,10,.78);border:1px solid rgba(201,162,39,.45);color:#f0e2b4;' +
          'padding:6px 14px;border-radius:20px;font-size:11.5px;letter-spacing:.06em;' +
          'backdrop-filter:blur(8px);transition:opacity .35s;pointer-events:none;z-index:9';
        $('labels').appendChild(el);
      }
      el.textContent = text;
      el.style.opacity = '1';
      clearTimeout(this._flashT);
      this._flashT = setTimeout(() => { el.style.opacity = '0'; }, 2200);
    },

    /* ------------------------------------------------------------ hole */
    goHole(n) {
      if (n < 1) n = 18;
      if (n > 18) n = 1;
      if (n === App.hole || App.loading) return;
      App.clearShot();
      $('readout').classList.remove('on');
      // paint the selection immediately so the click feels instant
      document.querySelectorAll('.hbtn').forEach(b => b.classList.toggle('on', +b.dataset.hole === n));
      this.busy('Hole ' + n);
      App.loadHoleAsync(n, false, step => {
        if (step) this.busy('Hole ' + n + ' · ' + step);
        else this.busy(null);
      });
    },

    /** Small non-blocking badge while a hole rebuilds. */
    busy(text) {
      let el = $('busy');
      if (!el) {
        el = document.createElement('div');
        el.id = 'busy';
        el.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);' +
          'background:rgba(8,12,10,.86);border:1px solid rgba(201,162,39,.42);color:#f0e2b4;' +
          'padding:12px 22px;border-radius:12px;font-size:12.5px;letter-spacing:.10em;' +
          'backdrop-filter:blur(10px);pointer-events:none;z-index:12;text-transform:uppercase;' +
          'box-shadow:0 12px 40px rgba(0,0,0,.5);transition:opacity .2s';
        $('labels').appendChild(el);
      }
      if (text === null) { el.style.opacity = '0'; return; }
      el.textContent = text + ' …';
      el.style.opacity = '1';
    },

    onHoleChanged() {
      const H = App.holeData;
      const C = App.course;
      $('hNum').textContent = H.num;
      $('hPar').textContent = `Par ${H.par} · Stroke ${H.hcp}`;
      $('hNum').title = `Hole ${H.num} of 18`;
      const tee = H.tees[App.teeSet] || H.tees[0];
      $('hYds').textContent = tee ? tee.yards : H.yards;
      $('hDesc').textContent = this.describe(H, tee ? tee.yards : H.yards);
      $('sBunk').textContent = H.bunkers.length;
      $('sGreen').textContent = Math.round(this.greenArea(H) * 10.7639).toLocaleString();
      $('sElev').textContent = this.elevDelta(H);

      document.querySelectorAll('.hbtn').forEach(b => {
        b.classList.toggle('on', +b.dataset.hole === H.num);
      });

      const tl = $('teeList');
      tl.innerHTML = '';
      H.tees.forEach((t, i) => {
        const b = document.createElement('div');
        b.className = 'tee' + (i === App.teeSet ? ' on' : '');
        b.innerHTML = `<i class="dot" style="background:${TEE_COLOR[i % TEE_COLOR.length]}"></i>` +
                      `<span>${t.name}</span><b>${t.yards}</b>`;
        b.onclick = () => {
          App.teeSet = i;
          App.aim = App.defaultAim();
          App.clearShot();
          $('readout').classList.remove('on');
          if (App.camMode === 'tee') App.setCamera('tee', false);
          this.onHoleChanged();
        };
        tl.appendChild(b);
      });

      this.drawMap();
      this.refreshLie();
      this.syncUrl();
    },

    onCameraChanged() {
      document.querySelectorAll('#camBar button').forEach(b => {
        b.classList.toggle('on', b.dataset.cam === App.camMode);
      });
      this.syncUrl();
    },

    onShotProgress(p) {
      // the ball only reaches its resting place when the flight finishes, so the
      // lie readout has to wait for that rather than update on impact
      if (p >= 1 && !this._lieSettled) {
        this._lieSettled = true;
        this.refreshLie();
        this.drawMap();
      }
      if (p < 1) this._lieSettled = false;
    },

    greenArea(H) {
      let a = 0;
      for (const r of H.green.rings) {
        let s = 0;
        for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
          s += r[j][0] * r[i][1] - r[i][0] * r[j][1];
        }
        a += Math.abs(s) / 2;
      }
      return a;
    },

    elevDelta(H) {
      const F = App.field;
      const t = App.teePos();
      const g = App.pinPos();
      const d = (g[1] - t[1]) * 3.28084;
      const s = d >= 0 ? '+' : '−';
      return s + Math.abs(Math.round(d)) + ' ft';
    },

    /** Description generated from the geometry, so it always matches the model. */
    describe(H, yards) {
      yards = yards || H.yards;
      const sp = H.spine;
      const a = sp[0], m = sp[Math.floor(sp.length * 0.5)], b = sp[sp.length - 1];
      const ang = (p, q, r) => {
        const v1 = Math.atan2(q[1] - p[1], q[0] - p[0]);
        const v2 = Math.atan2(r[1] - q[1], r[0] - q[0]);
        let d = (v2 - v1) * 180 / Math.PI;
        while (d > 180) d -= 360;
        while (d < -180) d += 360;
        return d;
      };
      const bend = ang(a, m, b);
      // world Z is south, so a positive turn in XZ is a turn to the right of play
      let shape;
      if (Math.abs(bend) < 6) shape = 'plays dead straight';
      else if (Math.abs(bend) < 15) shape = 'bends gently ' + (bend > 0 ? 'left' : 'right');
      else if (Math.abs(bend) < 28) shape = 'doglegs ' + (bend > 0 ? 'left' : 'right');
      else shape = 'turns hard ' + (bend > 0 ? 'left' : 'right');

      const F = App.field;
      const t = App.teePos(), g = App.pinPos();
      const rise = (g[1] - t[1]) * 3.28084;
      const grade = Math.abs(rise) < 6 ? 'to a green at roughly tee level'
        : rise > 0 ? `to a green sitting ${Math.round(rise)} ft above the tee`
                   : `to a green ${Math.round(-rise)} ft below the tee`;

      const nb = H.bunkers.length;
      const water = H.waters.length > 0;
      const kind = H.par === 3 ? 'one-shotter' : H.par === 5 ? 'three-shotter' : 'two-shotter';

      let s = `A ${yards}-yard ${kind} that ${shape} ${grade}. `;
      s += nb === 0 ? 'No sand guards this one — the defence is length and the tree line. '
        : `${nb} bunker${nb > 1 ? 's' : ''} frame the corridor and the putting surface. `;
      if (water) s += 'Water is in play. ';
      if (H.hcp <= 4) s += 'One of the hardest holes on the card.';
      else if (H.hcp >= 15) s += 'The card says it is a breather; the green says otherwise.';
      return s;
    },

    /* ----------------------------------------------------------- map */
    drawMap() {
      const cv = $('map');
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const W = cv.clientWidth || 286, Hh = 172;
      cv.width = W * dpr; cv.height = Hh * dpr;
      const g = cv.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, Hh);

      const H = App.holeData;
      // bounds over everything belonging to this hole
      let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9;
      const eat = r => { for (const p of r) {
        minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]);
        minz = Math.min(minz, p[1]); maxz = Math.max(maxz, p[1]);
      } };
      eat(H.spine);
      H.fairways.forEach(eat); H.green.rings.forEach(eat);
      H.bunkers.forEach(eat); H.waters.forEach(eat); H.teeBoxes.forEach(eat);

      const pad = 22;
      const sw = maxx - minx, sh = maxz - minz;
      // rotate so the hole always plays bottom-to-top
      const t = H.spine[0], gr = H.green.c;
      const ang = Math.atan2(gr[1] - t[1], gr[0] - t[0]) + Math.PI / 2;
      const ca = Math.cos(-ang), sa = Math.sin(-ang);
      const cx = (minx + maxx) / 2, cz = (minz + maxz) / 2;
      const rot = p => {
        const x = p[0] - cx, z = p[1] - cz;
        return [x * ca - z * sa, x * sa + z * ca];
      };
      let rminx = 1e9, rmaxx = -1e9, rminz = 1e9, rmaxz = -1e9;
      const all = [H.spine, ...H.fairways, ...H.green.rings, ...H.bunkers, ...H.waters, ...H.teeBoxes];
      for (const r of all) for (const p of r) {
        const q = rot(p);
        rminx = Math.min(rminx, q[0]); rmaxx = Math.max(rmaxx, q[0]);
        rminz = Math.min(rminz, q[1]); rmaxz = Math.max(rmaxz, q[1]);
      }
      const sc = Math.min((W - pad * 2) / (rmaxx - rminx), (Hh - pad * 2) / (rmaxz - rminz));
      const ox = W / 2 - ((rminx + rmaxx) / 2) * sc;
      const oy = Hh / 2 - ((rminz + rmaxz) / 2) * sc;
      const P = p => { const q = rot(p); return [q[0] * sc + ox, q[1] * sc + oy]; };

      const poly = (r, fill, stroke, lw) => {
        if (r.length < 2) return;
        g.beginPath();
        const s = P(r[0]); g.moveTo(s[0], s[1]);
        for (let i = 1; i < r.length; i++) { const q = P(r[i]); g.lineTo(q[0], q[1]); }
        g.closePath();
        if (fill) { g.fillStyle = fill; g.fill(); }
        if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw || 1; g.stroke(); }
      };

      g.fillStyle = '#141a15';
      g.fillRect(0, 0, W, Hh);
      // mown corridor
      g.strokeStyle = 'rgba(58,84,48,.85)';
      g.lineWidth = 46 * sc; g.lineJoin = 'round'; g.lineCap = 'round';
      g.beginPath();
      const s0 = P(H.spine[0]); g.moveTo(s0[0], s0[1]);
      for (let i = 1; i < H.spine.length; i++) { const q = P(H.spine[i]); g.lineTo(q[0], q[1]); }
      g.stroke();

      H.fairways.forEach(r => poly(r, '#4a7038'));
      H.waters.forEach(r => poly(r, '#2b5566'));
      H.bunkers.forEach(r => poly(r, '#cdbe98'));
      H.green.rings.forEach(r => poly(r, '#6fa04a', 'rgba(255,255,255,.22)', 1));
      H.teeBoxes.forEach(r => poly(r, '#3f6b34'));

      // centreline
      g.strokeStyle = 'rgba(255,255,255,.30)';
      g.setLineDash([4, 5]); g.lineWidth = 1.1;
      g.beginPath();
      const c0 = P(H.spine[0]); g.moveTo(c0[0], c0[1]);
      for (let i = 1; i < H.spine.length; i++) { const q = P(H.spine[i]); g.lineTo(q[0], q[1]); }
      g.stroke(); g.setLineDash([]);

      // markers
      const pin = P(H.green.c);
      g.fillStyle = '#e8c447';
      g.beginPath(); g.arc(pin[0], pin[1], 3.4, 0, 7); g.fill();
      g.strokeStyle = '#e8c447'; g.lineWidth = 1.2;
      g.beginPath(); g.moveTo(pin[0], pin[1]); g.lineTo(pin[0], pin[1] - 9); g.stroke();
      g.fillRect(pin[0], pin[1] - 9, 6, 4);

      H.tees.forEach((t2, i) => {
        const q = P([t2.x, t2.z]);
        g.fillStyle = TEE_COLOR[i % TEE_COLOR.length];
        g.strokeStyle = 'rgba(255,255,255,.5)'; g.lineWidth = i === App.teeSet ? 1.4 : 0.7;
        g.beginPath(); g.arc(q[0], q[1], i === App.teeSet ? 4 : 2.6, 0, 7); g.fill(); g.stroke();
      });

      // aim / shot overlay
      if (App.shot) {
        const pts = App.shot.path;
        g.strokeStyle = 'rgba(255,235,170,.95)'; g.lineWidth = 1.6;
        g.beginPath();
        const a0 = P([pts[0][0], pts[0][2]]); g.moveTo(a0[0], a0[1]);
        for (const p of pts) { const q = P([p[0], p[2]]); g.lineTo(q[0], q[1]); }
        g.stroke();
        g.strokeStyle = 'rgba(255,255,255,.55)'; g.setLineDash([2, 3]);
        g.beginPath();
        const r0 = P([App.shot.roll[0][0], App.shot.roll[0][2]]);
        g.moveTo(r0[0], r0[1]);
        for (const p of App.shot.roll) { const q = P([p[0], p[2]]); g.lineTo(q[0], q[1]); }
        g.stroke(); g.setLineDash([]);
        const f = P([App.shot.finalPoint[0], App.shot.finalPoint[2]]);
        g.fillStyle = '#fff';
        g.beginPath(); g.arc(f[0], f[1], 3, 0, 7); g.fill();
      }

      // scale bar
      const barYd = 100;
      const px = barYd * Y2M * sc;
      g.strokeStyle = 'rgba(255,255,255,.45)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(10, Hh - 12); g.lineTo(10 + px, Hh - 12); g.stroke();
      g.beginPath(); g.moveTo(10, Hh - 15); g.lineTo(10, Hh - 9);
      g.moveTo(10 + px, Hh - 15); g.lineTo(10 + px, Hh - 9); g.stroke();
      g.fillStyle = 'rgba(255,255,255,.55)'; g.font = '9px ui-sans-serif, sans-serif';
      g.fillText('100 yds', 12, Hh - 17);
      g.fillText('N', W - 16, 16);
      // north arrow (rotated)
      g.save();
      g.translate(W - 13, 26); g.rotate(-ang);
      g.strokeStyle = 'rgba(255,255,255,.5)';
      g.beginPath(); g.moveTo(0, 6); g.lineTo(0, -6); g.moveTo(-3, -3); g.lineTo(0, -6); g.lineTo(3, -3);
      g.stroke(); g.restore();
    },

    /* ----------------------------------------------------------- shot */
    refreshLie() {
      const o = App.ballPos || App.teePos();
      const s = App.field.surfaceAt(o[0], o[2]);
      const S = root.Shot.SURFACE[s];
      const pin = App.pinPos();
      const d = Math.round(Math.hypot(pin[0] - o[0], pin[2] - o[2]) * M2Y);
      const txt = `${d} yds · ${S ? S.name : s}`;
      $('lieTag').textContent = txt;
      const m = $('mLie');
      if (m) m.textContent = txt;
    },

    hit() {
      if (!App.ready) return;
      const res = App.playShot();
      const st = res.stats;
      const f = (v, u) => Math.round(v) + (u || '');
      $('rCarry').textContent = f(st.carryYd, ' yd');
      $('rTotal').textContent = f(st.totalYd, ' yd');
      $('rApex').textContent = f(st.apexYd * 3 / M2Y / 3 * M2Y, '') + ' ft';
      $('rApex').textContent = Math.round(st.apexM * 3.28084) + ' ft';
      $('rDesc').textContent = f(st.descentAngle, '°');
      $('rBall').textContent = f(st.ballSpeed, ' mph');
      $('rSpin').textContent = st.spin.toLocaleString() + ' rpm';
      $('rHang').textContent = st.hangTime.toFixed(1) + ' s';
      $('rRoll').textContent = f(st.rollYd, ' yd');
      $('readout').classList.add('on');

      const pin = App.pinPos();
      const fp = res.finalPoint;
      const toPin = Math.hypot(pin[0] - fp[0], pin[2] - fp[2]) * M2Y;
      const S = root.Shot.SURFACE[res.finalSurface];
      const el = $('rResult');
      el.className = 'result';
      let txt;
      if (res.finalSurface === 'water') { txt = 'In the water — penalty stroke.'; el.className = 'result bad'; }
      else if (res.finalSurface === 'sand') { txt = `Bunkered, ${Math.round(toPin)} yds from the pin.`; el.className = 'result warn'; }
      else if (res.finalSurface === 'native') { txt = `Native area, ${Math.round(toPin)} yds out.`; el.className = 'result warn'; }
      else if (res.finalSurface === 'green') {
        const ft = toPin * 3;
        txt = ft < 12 ? `On the green — ${Math.round(ft)} ft for the putt. Tap in range.`
                      : `On the green, ${Math.round(ft)} ft from the hole.`;
      } else if (res.finalSurface === 'fringe') txt = `Just off the surface, ${Math.round(toPin * 3)} ft to the flag.`;
      else if (res.finalSurface === 'rough') { txt = `In the rough, ${Math.round(toPin)} yds remaining.`; el.className = 'result warn'; }
      else txt = `${S ? S.name : res.finalSurface} — ${Math.round(toPin)} yds remaining.`;
      el.textContent = txt;

      this._lieSettled = false;
      this.drawMap();
      if (App.camMode === 'tee' || App.camMode === 'approach') {
        // stay put; the tracer does the work
      }
      setTimeout(() => this.refreshLie(), 100);
    },

    /* --------------------------------------------------------- labels */
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

      // While the ball is in the air the pin distance is measured from where the
      // shot started, not from the ball — a number counting down mid-flight just
      // reads as a glitch.
      const from = flying ? App.shot.path[0] : (App.ballPos || App.teePos());
      const d = Math.hypot(pin[0] - from[0], pin[2] - from[2]) * M2Y;
      items.push({ p: [pin[0], pin[1] + 3.4, pin[2]], t: `PIN · ${Math.round(d)} yds`, cls: 'lbl pin' });

      if (App.shot && !flying) {
        const s = App.shot;
        const f = s.finalPoint;
        const toPin = Math.hypot(pin[0] - f[0], pin[2] - f[2]) * M2Y;
        items.push({ p: [f[0], f[1] + 1.6, f[2]],
                     t: `${Math.round(s.stats.totalYd)} yds · ${Math.round(toPin)} to pin`,
                     cls: 'lbl dist' });
        // only worth showing the carry mark when it is clearly short of the finish
        const rollYd = s.stats.totalYd - s.stats.carryYd;
        if (rollYd > 12) {
          const l = s.landPoint;
          items.push({ p: [l[0], l[1] + 1.0, l[2]], t: `carry ${Math.round(s.stats.carryYd)}`, cls: 'lbl' });
        }
      } else if (App.aimPoint && !App.shot) {
        const a = App.aimPoint;
        const da = Math.hypot(a[0] - from[0], a[2] - from[2]) * M2Y;
        items.push({ p: [a[0], a[1] + 1.2, a[2]], t: `aim ${Math.round(da)} yds`, cls: 'lbl dist' });
      }

      const els = this.ensureLabels(items.length);
      const placed = [];
      const out = [0, 0];
      for (let i = 0; i < els.length; i++) {
        if (i >= items.length) { els[i].style.display = 'none'; continue; }
        const it = items[i];
        const r = this.project(it.p, out);
        if (!r || r[0] < -80 || r[0] > window.innerWidth + 80 ||
                 r[1] < -40 || r[1] > window.innerHeight + 40) {
          els[i].style.display = 'none';
          continue;
        }
        let x = r[0], y = r[1];
        // nudge apart anything that would otherwise sit on top of a label
        for (const q of placed) {
          if (Math.abs(x - q[0]) < 150 && Math.abs(y - q[1]) < 24) y = q[1] + 26;
        }
        placed.push([x, y]);
        els[i].style.display = 'block';
        els[i].className = it.cls;
        els[i].textContent = it.t;
        els[i].style.left = x + 'px';
        els[i].style.top = y + 'px';
      }
    },

    /* ----------------------------------------------------------- loop */
    /**
     * Render loop driven by requestAnimationFrame *or* a timer, whichever fires
     * first. Some embedding contexts — a frame that is not being composited, a
     * host that renders the page off-screen — never deliver rAF at all, and a
     * loop that trusts it alone shows exactly one frame and then looks like a
     * screenshot with dead controls. The timer keeps it alive at a lower rate.
     */
    loop() {
      let last = performance.now();
      let acc = 0, frames = 0, pending = false;

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
        try {
          App.render(dt);
          App.advanceShot(dt);
          this.updateLabels();
        } catch (e) {
          // one bad frame must not kill the loop and freeze the page
          if (!this._loopWarned) { this._loopWarned = true; console.error(e); }
        }
        acc += dt; frames++;
        if (acc > 0.6) {
          $('fps').textContent = Math.round(frames / acc) + ' fps';
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
