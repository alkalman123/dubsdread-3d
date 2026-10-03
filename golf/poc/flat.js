/* Dubsdread without a GPU.
 *
 * Some browsers will not hand over a WebGL 2 context — hardware acceleration
 * switched off, a blocklisted driver, a machine with no GPU worth the name — and
 * no amount of asking politely changes that. But almost none of this project is
 * actually a renderer. The course geometry, the height field, the signed
 * distance fields that decide what surface the ball is sitting on, the ball
 * flight, the tree collisions, the stimpmeter putting, the caddie and the
 * dispersion patterns are all plain JavaScript that never touches the GPU.
 *
 * So this is the same round of golf drawn on a 2D canvas: a top-down view of the
 * hole rastered straight out of the same field the 3D build reads, with the same
 * Play and ShotPoc modules driving it, unmodified. It is not a downgrade of the
 * renderer — there is no renderer. It is the game, playable, on a machine that
 * cannot run the renderer.
 *
 * Load order matters: this file defines the App the play module expects, so it
 * must come before poc/play.js. Boot waits for DOMContentLoaded, by which time
 * play.js has defined Play.
 */
(function (root) {
  'use strict';

  const { clamp, lerp } = root.MM;
  const $ = id => document.getElementById(id);
  const M2Y = 1.09361;
  const esc = t => String(t).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  /* ==================================================================== App
   *
   * Everything poc/play.js reaches for, and nothing else. The camera, scar and
   * tracer calls are kept as no-ops rather than stripped out of play.js: the
   * play module stays byte-for-byte the same in both builds, which is the only
   * way the two stay in step.
   */
  const App = {
    hole: 1,
    teeSet: 0,
    quality: 'fast',
    profile: 'tour',
    loading: false,
    camMode: 'play',
    wind: { speed: 0, dir: 200 },
    shot: null,
    shotAnim: 0,
    ballPos: null,
    aim: 0,
    aimPoint: null,
    ballTeed: false,

    buildWorld() {
      const C = this.course = root.COURSE;
      let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
      for (const h of C.holes) for (const p of h.spine) {
        minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
        minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]);
      }
      this.courseCenter = [(minX + maxX) / 2, (minZ + maxZ) / 2];
      const span = Math.max(maxX - minX, maxZ - minZ);
      this.worldSize = span + 900;
      this.worldField = new root.Field(C, this.courseCenter[0], this.courseCenter[1],
        this.worldSize, 768);
      // the tree line is a collider set here, not something to draw
      this.trees = root.Foliage.scatterTrees(this.worldField, C, { spacing: 12.0, seed: 8123 });
    },

    /** The CPU half of js/app.js's loadHole: the field, and nothing else. */
    loadHole(n) {
      const C = this.course;
      this.hole = clamp(n, 1, 18);
      const H = this.holeData = C.holes[this.hole - 1];
      const sp = H.spine;
      const mid = sp[Math.floor(sp.length / 2)];
      const tee = sp[0], grn = H.green.c;
      const cx = (tee[0] + grn[0] + mid[0] * 2) / 4;
      const cz = (tee[1] + grn[1] + mid[1] * 2) / 4;
      const len = Math.hypot(grn[0] - tee[0], grn[1] - tee[1]);
      const fieldSize = clamp(len * 1.9 + 240, 620, 880);
      this.focus = [cx, cz];
      if (this.field) this.field.dispose();
      this.field = new root.Field(C, cx, cz, fieldSize, 832);
      this.clearShot();
    },

    teePos() {
      const H = this.holeData;
      const t = H.tees[clamp(this.teeSet, 0, H.tees.length - 1)] || { x: H.spine[0][0], z: H.spine[0][1] };
      return [t.x, this.field.height(t.x, t.z) + 0.06, t.z];
    },

    pinPos() {
      const g = this.holeData.green.c;
      return [g[0], this.field.height(g[0], g[1]), g[1]];
    },

    heightAt(x, z) {
      return this.field.contains(x, z, 1) ? this.field.height(x, z) : this.worldField.height(x, z);
    },

    defaultAim() {
      const H = this.holeData;
      const t = this.teePos();
      const g = H.green.c;
      const sp = H.spine;
      const target = H.par >= 4 && H.yards > 300
        ? sp[Math.min(sp.length - 1, Math.round(sp.length * 0.55))]
        : [g[0], g[1]];
      return Math.atan2(target[1] - t[2], target[0] - t[0]);
    },

    windVec() {
      const a = this.wind.dir * Math.PI / 180;
      return [Math.cos(a) * this.wind.speed, Math.sin(a) * this.wind.speed];
    },

    clearShot() {
      this.shot = null;
      this.shotAnim = 0;
      this.tracerPts = null;
      this.ballPos = this.holeData ? this.teePos() : null;
      this.aimPoint = null;
    },

    /* The 3D build turns the flight into a ribbon mesh; here the points are the
       drawing, so keep them and let the canvas stroke them. */
    buildTracer(res) {
      const pts = (res.path || []).concat(res.roll || []);
      this.tracerPts = pts.length >= 2 ? pts : null;
    },

    /** Walk the ball along the flight in real time, the way the 3D build does. */
    advanceShot(dt) {
      if (!this.shot || this.shotAnim >= 1) return;
      const hang = Math.max(0.4, (this.shot.stats && this.shot.stats.hangTime) || 1.2);
      this.shotAnim = Math.min(1, this.shotAnim + dt / (hang * 0.8 + 0.9));
      const pts = this.tracerPts;
      if (!pts) { this.ballPos = this.shot.finalPoint; return; }
      const f = this.shotAnim * (pts.length - 1);
      const i = clamp(Math.floor(f), 0, pts.length - 1);
      const j = clamp(i + 1, 0, pts.length - 1);
      const t = f - i;
      this.ballPos = [lerp(pts[i][0], pts[j][0], t),
                      lerp(pts[i][1], pts[j][1], t),
                      lerp(pts[i][2], pts[j][2], t)];
    },

    /* Nothing to move, nothing to scar, no blades to re-scatter. */
    setCamera() {},
    updateCamera() {},
    clearScars() {},
    addScar() {},
    updateGrass() {}
  };

  root.App = App;

  /* ================================================================== paint */

  const SURF = {
    fairway: [104, 156, 78], green: [130, 190, 92], fringe: [112, 168, 82],
    tee: [104, 156, 78], rough: [66, 104, 56], native: [140, 132, 78],
    sand: [216, 199, 156], path: [148, 146, 140], water: [64, 122, 154]
  };

  const Flat = {
    zones: true,
    scale: 1,
    view: '3d',        // '3d' = software perspective, 'map' = top-down

    /* ------------------------------------------------------------ view
     * The hole plays up the screen. Every world point goes through the same
     * rotate-and-scale, and the raster inverts it, so there is one definition
     * of where things are rather than two that can drift apart.
     */
    fitView() {
      const H = App.holeData;
      const t = App.teePos(), p = App.pinPos();
      const ang = Math.atan2(p[2] - t[2], p[0] - t[0]);
      // rotate so tee->pin runs from the bottom of the frame to the top
      this.rot = -ang - Math.PI / 2;
      this.cs = Math.cos(this.rot); this.sn = Math.sin(this.rot);
      this.cx = (t[0] + p[0]) / 2; this.cz = (t[2] + p[2]) / 2;

      // everything that has to be on screen: the corridor, both ends, the green
      let mx = 0, mz = 0;
      const consider = (x, z) => {
        const d = this.rotate(x, z);
        mx = Math.max(mx, Math.abs(d[0])); mz = Math.max(mz, Math.abs(d[1]));
      };
      for (const s of H.spine) consider(s[0], s[1]);
      consider(t[0], t[2]); consider(p[0], p[2]);
      const gr = (H.green.r || 18) + 12;
      consider(H.green.c[0] + gr, H.green.c[1]); consider(H.green.c[0] - gr, H.green.c[1]);
      consider(H.green.c[0], H.green.c[1] + gr); consider(H.green.c[0], H.green.c[1] - gr);

      const c = this.cv;
      const pad = 26;
      this.scale = Math.min((c.width / 2 - pad) / Math.max(mx + 22, 1),
                            (c.height / 2 - pad) / Math.max(mz + 22, 1));
    },

    rotate(x, z) {
      const dx = x - this.cx, dz = z - this.cz;
      return [dx * this.cs - dz * this.sn, dx * this.sn + dz * this.cs];
    },

    toScreen(x, z) {
      const r = this.rotate(x, z);
      return [this.cv.width / 2 + r[0] * this.scale, this.cv.height / 2 + r[1] * this.scale];
    },

    toWorld(sx, sy) {
      const rx = (sx - this.cv.width / 2) / this.scale;
      const ry = (sy - this.cv.height / 2) / this.scale;
      // inverse rotation
      return [this.cx + rx * this.cs + ry * this.sn, this.cz - rx * this.sn + ry * this.cs];
    },

    /**
     * Raster the hole once, then blit it every frame.
     *
     * Colour comes from the same surfaceAt() the physics asks when it wants to
     * know what the ball is sitting in, so what you see and what you get are the
     * same query. The shading is a hillshade off the height field — without it a
     * top-down view of a golf course is a flat green blob and every slope that
     * matters to a putt is invisible.
     */
    rasterHole() {
      const c = this.cv, F = App.field;
      const W = Math.max(2, Math.round(c.width / 2)), Hh = Math.max(2, Math.round(c.height / 2));
      const off = document.createElement('canvas');
      off.width = W; off.height = Hh;
      const g = off.getContext('2d');
      const img = g.createImageData(W, Hh);
      const d = img.data;
      const sxk = c.width / W, syk = c.height / Hh;
      // sun from the upper left, the convention every relief map uses
      const lx = -0.55, lz = -0.55, ly = 0.63;
      for (let y = 0; y < Hh; y++) {
        for (let x = 0; x < W; x++) {
          const w = this.toWorld(x * sxk, y * syk);
          const k = (y * W + x) * 4;
          if (!F.contains(w[0], w[1], 1)) {
            d[k] = 24; d[k + 1] = 30; d[k + 2] = 26; d[k + 3] = 255;
            continue;
          }
          const col = SURF[F.surfaceAt(w[0], w[1])] || SURF.rough;
          const e = 1.6;
          const h0 = F.height(w[0], w[1]);
          const hx = F.height(w[0] + e, w[1]) - h0;
          const hz = F.height(w[0], w[1] + e) - h0;
          // normal of the slope, lit by a fixed low sun
          let nx = -hx / e, nz = -hz / e;
          const inv = 1 / Math.sqrt(nx * nx + nz * nz + 1);
          const sh = clamp((nx * lx + nz * lz + ly) * inv * 1.55, 0.42, 1.5);
          d[k] = clamp(col[0] * sh, 0, 255);
          d[k + 1] = clamp(col[1] * sh, 0, 255);
          d[k + 2] = clamp(col[2] * sh, 0, 255);
          d[k + 3] = 255;
        }
      }
      g.putImageData(img, 0, 0);
      this.base = off;
    },

    /* ------------------------------------------------------------- frame */
    draw() {
      if (this.view === '3d' && root.Soft3D) {
        root.Soft3D.zones = this.zones;
        root.Soft3D.draw(App, root.Play);
        if (root.Soft3D.mode !== this._flyWas) {
          this._flyWas = root.Soft3D.mode;
          this.syncHud();
        }
        return;
      }
      const c = this.cv, g = this.ctx;
      g.clearRect(0, 0, c.width, c.height);
      if (this.base) {
        g.imageSmoothingEnabled = true;
        g.drawImage(this.base, 0, 0, c.width, c.height);
      }
      const P = root.Play;
      const ball = App.ballPos || App.teePos();
      const pin = App.pinPos();

      if (this.zones && P.state.phase === 'idle' && !P.isPutting()) this.drawZones(g);
      this.drawAim(g, ball);
      if (App.tracerPts && App.shotAnim > 0) this.drawTracer(g);

      // pin
      const ps = this.toScreen(pin[0], pin[2]);
      g.strokeStyle = '#f2f2ee'; g.lineWidth = 1.6;
      g.beginPath(); g.moveTo(ps[0], ps[1]); g.lineTo(ps[0], ps[1] - 15); g.stroke();
      g.fillStyle = '#d8443a';
      g.beginPath(); g.moveTo(ps[0], ps[1] - 15); g.lineTo(ps[0] + 10, ps[1] - 11.5);
      g.lineTo(ps[0], ps[1] - 8); g.closePath(); g.fill();
      g.fillStyle = 'rgba(0,0,0,.45)';
      g.beginPath(); g.arc(ps[0], ps[1], 2.6, 0, 7); g.fill();

      // ball, with a shadow under it when it is in the air
      const bs = this.toScreen(ball[0], ball[2]);
      const air = Math.max(0, ball[1] - App.heightAt(ball[0], ball[2]));
      if (air > 0.5) {
        const gs = this.toScreen(ball[0], ball[2]);
        g.fillStyle = 'rgba(0,0,0,' + (0.30 * clamp(1 - air / 40, 0.1, 1)).toFixed(3) + ')';
        g.beginPath(); g.arc(gs[0], gs[1], 3 + air * 0.09, 0, 7); g.fill();
      }
      const lift = clamp(air * 0.30, 0, 26);
      g.fillStyle = '#fff';
      g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineWidth = 1;
      g.beginPath(); g.arc(bs[0], bs[1] - lift, air > 0.5 ? 4 : 3.4, 0, 7); g.fill(); g.stroke();
    },

    drawAim(g, ball) {
      const P = root.Play;
      if (P.state.phase === 'flying') return;
      const a = P.aim;
      const reach = P.isPutting() ? Math.max(2, P.read().distM) : P.aimDistance();
      const tx = ball[0] + Math.cos(a) * reach, tz = ball[2] + Math.sin(a) * reach;
      const b = this.toScreen(ball[0], ball[2]), t = this.toScreen(tx, tz);
      g.save();
      g.setLineDash([6, 5]);
      g.strokeStyle = 'rgba(240,226,180,.75)'; g.lineWidth = 1.4;
      g.beginPath(); g.moveTo(b[0], b[1]); g.lineTo(t[0], t[1]); g.stroke();
      g.restore();
      g.fillStyle = 'rgba(240,226,180,.9)';
      g.beginPath(); g.arc(t[0], t[1], 3, 0, 7); g.fill();
    },

    /* Where each standard of player would actually finish, from the same Monte
       Carlo the 3D build draws on the hole map. */
    drawZones(g) {
      const pats = root.Play.allPatterns(60);
      if (!pats) return;
      const cols = { tour: '#e0a83c', low: '#7fc7e8', mid: '#8fd07a', senior: '#d08fc0' };
      for (const p of pats) {
        g.fillStyle = cols[p.profile] || '#888';
        g.globalAlpha = 0.34;
        for (const s of p.shots) {
          const q = this.toScreen(s.x, s.z);
          g.fillRect(q[0] - 1.2, q[1] - 1.2, 2.4, 2.4);
        }
        g.globalAlpha = 1;
      }
    },

    drawTracer(g) {
      const pts = App.tracerPts;
      const upto = clamp(Math.floor(App.shotAnim * (pts.length - 1)), 1, pts.length - 1);
      g.strokeStyle = 'rgba(255,236,190,.85)'; g.lineWidth = 1.6;
      g.beginPath();
      for (let i = 0; i <= upto; i++) {
        const s = this.toScreen(pts[i][0], pts[i][2]);
        const air = Math.max(0, pts[i][1] - App.heightAt(pts[i][0], pts[i][2]));
        const y = s[1] - clamp(air * 0.30, 0, 26);
        if (i === 0) g.moveTo(s[0], y); else g.lineTo(s[0], y);
      }
      g.stroke();
    },

    /* ================================================================= HUD */

    /* =================================================================== HUD
     *
     * Three layers, not one column of identical boxes: the course, a status
     * rail across the top, and the controls along the bottom where the hands
     * are. Everything the player acts on is in the action bar; everything they
     * only read is in the rail or the side panels.
     */

    onPlayChanged() { this.syncHud(); },
    onCameraChanged() {},

    /* ------------------------------------------------------------- clubs */
    buildClubs() {
      const wrap = $('clubs');
      wrap.innerHTML = '';
      for (const c of root.Shot.CLUBS) {
        const b = document.createElement('button');
        b.className = 'club';
        b.dataset.club = c.id;
        b.innerHTML = esc(c.name) + '<span class="yd"></span>';
        b.onclick = () => {
          root.Play.club = c.id;
          root.Play.clearPatterns();
          this.syncHud();
        };
        wrap.appendChild(b);
      }
    },

    syncClubs() {
      const P = root.Play;
      document.querySelectorAll('#clubs .club').forEach(b => {
        const on = b.dataset.club === P.club;
        b.classList.toggle('on', on);
        if (on) b.scrollIntoView({ block: 'nearest', inline: 'center' });
      });
    },

    /* --------------------------------------------------------------- rail */
    syncHud() {
      const P = root.Play, H = App.holeData, s = P.state;

      $('hNum').textContent = App.hole;
      $('hPar').textContent = 'par ' + H.par;
      $('hYds').textContent = H.yards;
      $('hLie').textContent = s.holed ? 'holed' : P.lie();
      $('lieChip').textContent = s.holed ? 'holed out' : P.lie();
      $('hStroke').textContent = s.holed ? s.stroke : (s.stroke + 1);
      $('hTot').textContent = P.totalLabel();

      const pinYd = P.toPin() * M2Y;
      $('hPin').textContent = s.holed ? '—' :
        (pinYd < 30 ? (pinYd * 3).toFixed(0) + ' ft' : Math.round(pinYd) + ' yd');

      /* The caddie's recommendation, and how hard to hit it. The percentage is
         the whole point: a swing you can aim beats a swing you guess at. */
      this.target = null;
      if (s.holed) {
        $('cadClub').textContent = 'In the hole';
        $('cadPct').textContent = '';
        $('cadDist').textContent = s.stroke + ' strokes';
        $('cadNote').textContent = '';
      } else if (P.isPutting()) {
        const rd = P.read();
        this.target = clamp(rd.power || 0.5, 0.12, 1.12);
        $('cadClub').textContent = 'Putter';
        $('cadPct').textContent = Math.round(this.target * 100) + '%';
        $('cadDist').textContent = (rd.distM * 3.28084).toFixed(1) + ' ft of roll';
        $('cadNote').textContent = rd.breakText || 'plays straight';
      } else {
        const cad = P.caddie();
        this.target = clamp(cad.power, 0.12, 1.12);
        $('cadClub').textContent = cad.rec.name;
        $('cadPct').textContent = Math.round(this.target * 100) + '%';
        $('cadDist').textContent = Math.round(cad.pinYd) + ' yds · plays ' +
          Math.round(cad.playsLikeYd);
        $('cadNote').textContent = cad.windText || 'calm';
      }

      /* Shot list. Two lines per shot: what was hit, and what happened. */
      const rows = s.shots.map(sh =>
        '<div class="r"><span class="n">' + sh.no + '</span>' +
        '<span class="c">' + esc(sh.club) + '</span>' +
        '<span class="y num">' + Math.round(sh.distYd) + ' yd</span>' +
        (sh.surface || sh.note
          ? '<span class="s">' + esc([sh.surface, sh.note].filter(Boolean).join(' · ')) + '</span>'
          : '') + '</div>').join('');
      $('shots').innerHTML = rows || '<div class="empty">No shots yet</div>';

      const ph = s.phase;
      const sw = $('swing');
      sw.textContent = s.holed ? 'Next tee' :
        ph === 'idle' ? (P.isPutting() ? 'Putt' : 'Swing') :
        ph === 'power' ? 'Set power' : ph === 'strike' ? 'Set the face' : 'In the air';
      sw.classList.toggle('wait', ph === 'flying');
      $('meterHint').style.display = ph === 'idle' || ph === 'flying' ? 'flex' : 'none';
      $('meterHint').textContent = ph === 'flying' ? 'Ball in the air'
        : this.target ? 'Stop the needle at the marker — ' +
                        Math.round(this.target * 100) + '%'
                      : 'Space to swing';

      $('fly').textContent = (root.Soft3D && root.Soft3D.mode === 'fly') ? 'Stop' : 'Flyover';
      $('fly').classList.toggle('on', !!(root.Soft3D && root.Soft3D.mode === 'fly'));
      $('viewBtn').textContent = this.view === '3d' ? 'Map' : 'Down the line';
      $('zoneBtn').classList.toggle('on', this.zones);
      this.syncClubs();
      this.drawMini();
    },

    /** Names for the bag, without asking play.js for something it does not have. */
    clubName(id) {
      const c = root.Shot.CLUBS.find(x => x.id === id);
      return c ? c.name : id;
    },

    stepClub(d) {
      const P = root.Play, list = root.Shot.CLUBS;
      const i = list.findIndex(c => c.id === P.club);
      P.club = list[clamp((i < 0 ? 0 : i) + d, 0, list.length - 1)].id;
      P.clearPatterns();
    },

    /* --------------------------------------------------------------- toast */
    toast(main, sub) {
      const el = $('toast');
      el.innerHTML = '<b>' + esc(main) + '</b>' +
        (sub ? '<span class="sub">' + esc(sub) + '</span>' : '');
      el.classList.add('on');
      clearTimeout(this._toastT);
      this._toastT = setTimeout(() => el.classList.remove('on'), 2600);
    },

    /* ------------------------------------------------------------- minimap
     * The top-down raster the map view already builds, at panel size, with the
     * ball and pin on it. Having the whole hole visible while playing down the
     * line is the difference between aiming and hoping.
     */
    drawMini() {
      const c = $('miniC');
      if (!c || !c.clientWidth) return;
      const w = c.clientWidth, h = c.clientHeight;
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; this._mini = null; }
      const g = c.getContext('2d');

      if (!this._mini || this._miniHole !== App.hole) {
        const save = { cv: this.cv, base: this.base };
        this.cv = c;
        this.fitView();
        this.rasterHole();
        this._mini = this.base;
        this._miniView = { cx: this.cx, cz: this.cz, cs: this.cs, sn: this.sn, scale: this.scale };
        this._miniHole = App.hole;
        this.cv = save.cv;
        this.base = save.base;
        // the main view's own mapping has to be restored after borrowing it
        this.fitView();
      }

      g.clearRect(0, 0, w, h);
      g.drawImage(this._mini, 0, 0, w, h);

      const V = this._miniView;
      const to = (x, z) => {
        const dx = x - V.cx, dz = z - V.cz;
        return [w / 2 + (dx * V.cs - dz * V.sn) * V.scale,
                h / 2 + (dx * V.sn + dz * V.cs) * V.scale];
      };
      const pin = App.pinPos(), ball = App.ballPos || App.teePos();
      const p = to(pin[0], pin[2]), b = to(ball[0], ball[2]);

      g.strokeStyle = 'rgba(255,255,255,.5)';
      g.setLineDash([4, 4]);
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(b[0], b[1]); g.lineTo(p[0], p[1]); g.stroke();
      g.setLineDash([]);

      g.fillStyle = '#d8443a';
      g.beginPath(); g.arc(p[0], p[1], 3.4, 0, 6.2832); g.fill();
      g.fillStyle = '#fff';
      g.strokeStyle = 'rgba(0,0,0,.6)';
      g.beginPath(); g.arc(b[0], b[1], 3.4, 0, 6.2832); g.fill(); g.stroke();
    },

    /* ----------------------------------------------------------- scorecard */
    showCard(on) {
      const m = $('cardModal');
      if (!on) { m.classList.remove('on'); return; }
      const P = root.Play, T = P.roundTotals();
      const cls = (sc, par) => sc == null ? '' :
        sc - par <= -2 ? 'eag' : sc - par === -1 ? 'bir' :
        sc - par === 1 ? 'bog' : sc - par >= 2 ? 'dbl' : '';
      const nine = (from, to) => {
        let hdr = '', par = '', sc = '';
        for (let i = from; i < to; i++) {
          const H = App.course.holes[i];
          const card = P.round && P.round.card[i];
          hdr += '<th>' + (i + 1) + '</th>';
          par += '<td>' + H.par + '</td>';
          sc += '<td class="' + cls(card && card.score, H.par) + '">' +
                (card ? card.score : '·') + '</td>';
        }
        return { hdr, par, sc };
      };
      const out = nine(0, 9), inn = nine(9, 18);
      $('cardTable').innerHTML =
        '<table><tr><th class="h">Hole</th>' + out.hdr + '<th>Out</th>' + inn.hdr +
        '<th>In</th><th>Tot</th></tr>' +
        '<tr><td class="h">Par</td>' + out.par + '<td>' + T.outP + '</td>' + inn.par +
        '<td>' + T.inP + '</td><td>' + T.par + '</td></tr>' +
        '<tr class="tot"><td class="h">Score</td>' + out.sc + '<td>' + (T.outG || '·') +
        '</td>' + inn.sc + '<td>' + (T.inG || '·') + '</td><td>' + (T.gross || '·') +
        '</td></tr></table>';
      m.classList.add('on');
    },

    /* ================================================================= boot */

    /**
     * Go back to the WebGL build if this machine can run it.
     *
     * A URL is sticky: once somebody has been sent here, or bookmarked it, this
     * is where they land every time — including on a machine that was capable
     * all along. Check, and hand them back. ?stay=1 keeps them here.
     */
    bounceIf3D() {
      const p = new URLSearchParams(location.search);
      if (p.get('stay') === '1' || p.get('from') === 'nogl') return false;
      let ok = false;
      try {
        const c = document.createElement('canvas');
        const g = c.getContext('webgl2');
        ok = !!g;
        if (g) { const l = g.getExtension('WEBGL_lose_context'); if (l) l.loseContext(); }
      } catch (e) { ok = false; }
      if (!ok) return false;
      p.delete('stay');
      const q = p.toString();
      location.replace('index.html' + (q ? '?' + q : ''));
      return true;
    },

    async boot() {
      // No bounce to the WebGL build: this is the home page now, and the WebGL
      // build lives at webgl.html for anyone who wants it.
      const msg = $('loadMsg');
      const bar = $('lBar').firstElementChild;
      let done = 0;
      const step = async (label, fn) => {
        msg.textContent = label + '…';
        bar.style.width = Math.round((done++ / 2) * 100) + '%';
        await new Promise(r => setTimeout(r, 12));
        return fn();
      };
      try {
        await step('Reading the property', () => App.buildWorld());
        await step('Shaping the 1st', () => App.loadHole(1));
        bar.style.width = '100%';
        msg.textContent = 'Ready';
      } catch (e) {
        msg.textContent = 'Could not start: ' + ((e && e.message) || e);
        return;
      }

      if (new URLSearchParams(location.search).get('from') === 'nogl') {
        const w = $('lWhy');
        if (w) w.style.display = 'block';
      }

      this.cv = $('map');
      this.ctx = this.cv.getContext('2d');
      if (root.Soft3D) root.Soft3D.attach(this.cv);
      root.UI = this;                       // Play notifies through UI
      this.resize();
      root.Play.init();
      this.newHoleView();
      this.bind();
      const H = App.holeData;
      this.toast('Hole 1 · par ' + H.par, H.yards + ' yards');
      setTimeout(() => $('load').classList.add('done'), 260);
      this.loop();
      root.__ready = true;
      root.__flat = this;
    },

    /**
     * Walk to the next tee. The engine load is synchronous here, so the veil is
     * only there to cover the frame where the camera has jumped but the labels
     * have not caught up.
     */
    async goHole(n) {
      n = clamp(n, 1, 18);
      if (n === App.hole || App.loading) return;
      App.loading = true;
      $('loadMsg').textContent = 'Walking to the ' + this.ord(n);
      $('load').classList.remove('done');
      await new Promise(r => setTimeout(r, 40));
      App.loadHole(n);
      App.loading = false;
      root.Play.newHole(n);
      this._mini = null;
      this.newHoleView();
      $('load').classList.add('done');
      const H = App.holeData;
      this.toast('Hole ' + n + ' · par ' + H.par, H.yards + ' yards');
    },

    ord(n) {
      const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
      return n + (s[(v - 20) % 10] || s[v] || s[0]);
    },

    /* ---------------------------------------------------------- the meter */
    drawMeter() {
      const c = $('meterC');
      if (!c.clientWidth) return;
      if (c.width !== c.clientWidth || c.height !== c.clientHeight) {
        c.width = c.clientWidth; c.height = c.clientHeight;
      }
      const g = c.getContext('2d');
      const P = root.Play, m = P.meter, ph = P.state.phase;
      const W = c.width, H = c.height;
      g.clearRect(0, 0, W, H);

      // the zone the caddie is asking for, always visible
      if (this.target) {
        const tx = W * (this.target / 1.12);
        const band = Math.max(6, W * 0.022);
        g.fillStyle = 'rgba(224,185,63,.20)';
        g.fillRect(tx - band, 0, band * 2, H);
        g.fillStyle = 'rgba(255,255,255,.85)';
        g.fillRect(tx - 1, 0, 2, H);
      }
      // the overswing zone, so 100% is a visible line rather than a feeling
      g.fillStyle = 'rgba(226,104,92,.18)';
      g.fillRect(W * (1 / 1.12), 0, W * (0.12 / 1.12), H);

      if (ph === 'power') {
        const w = W * clamp(m.t / 1.12, 0, 1);
        const grd = g.createLinearGradient(0, 0, W, 0);
        grd.addColorStop(0, '#6fae52');
        grd.addColorStop(0.72, '#e0b93f');
        grd.addColorStop(1, '#e2685c');
        g.fillStyle = grd;
        g.fillRect(0, 0, w, H);
        g.fillStyle = 'rgba(255,255,255,.9)';
        g.fillRect(w - 1.5, 0, 3, H);
      } else if (ph === 'strike') {
        const mid = W / 2;
        g.fillStyle = 'rgba(255,255,255,.10)';
        g.fillRect(mid - W * 0.04, 0, W * 0.08, H);
        g.fillStyle = 'rgba(255,255,255,.35)';
        g.fillRect(mid - 0.5, 0, 1, H);
        const x = mid + m.t * mid;
        g.fillStyle = Math.abs(m.t) < 0.08 ? '#7fc46a' : '#e0b93f';
        g.fillRect(x - 2, 0, 4, H);
      }
    },

    resize() {
      const c = this.cv;
      /* The backing store is deliberately smaller than the box it is stretched
         over. See Soft3D.SCALES: pixels are what the software renderer pays
         for, and the upscale smooths the quad edges for free. */
      const rs = (root.Soft3D && root.Soft3D.renderScale) || 1;
      const w = Math.max(320, Math.round(c.clientWidth * rs));
      const h = Math.max(240, Math.round(c.clientHeight * rs));
      if (c.width === w && c.height === h) return false;
      c.width = w; c.height = h;
      return true;
    },

    newHoleView() {
      this.fitView();
      // the top-down raster costs a second on a slow machine and is only worth
      // paying for when that is the view being looked at
      if (this.view === 'map') this.rasterHole(); else this.base = null;
      this.syncHud();
    },

    setView(v) {
      if (this.view === v) return;
      this.view = v;
      document.querySelectorAll('[data-view]').forEach(b =>
        b.classList.toggle('on', b.dataset.view === v));
      if (v === 'map' && !this.base) this.rasterHole();
      this.syncHud();
    },

    async goHole(n) {
      n = clamp(n, 1, 18);
      if (n === App.hole || App.loading) return;
      App.loading = true;
      $('loadMsg').textContent = 'Walking to the ' + n + ((n % 10 === 1 && n !== 11) ? 'st' : (n % 10 === 2 && n !== 12) ? 'nd' : (n % 10 === 3 && n !== 13) ? 'rd' : 'th');
      $('load').classList.remove('done');
      await new Promise(r => setTimeout(r, 30));
      App.loadHole(n);
      App.loading = false;
      root.Play.newHole(n);
      this.newHoleView();
      $('load').classList.add('done');
    },

    bind() {
      const P = root.Play;

      $('swing').onclick = () => {
        if (P.state.holed) { this.walkOn(true); return; }
        P.tap();
      };
      $('restart').onclick = () => { P.restartHole(); this.syncHud(); };
      $('cardBtn').onclick = () => this.showCard(true);
      $('cardClose').onclick = () => this.showCard(false);
      $('viewBtn').onclick = () => this.setView(this.view === '3d' ? 'map' : '3d');
      $('zoneBtn').onclick = () => { this.zones = !this.zones; this.syncHud(); };
      $('fly').onclick = () => {
        const S = root.Soft3D;
        if (!S) return;
        if (S.mode === 'fly') S.stopFly();
        else { this.setView('3d'); S.startFly(); }
        this.syncHud();
      };
      $('mini').onclick = () => this.setView(this.view === '3d' ? 'map' : '3d');
      this.buildClubs();

      /* Click to aim, in either view. In the map it is a straight inverse of
         the projection; down the line it is a ray walked out until it meets the
         ground, which is what Soft3D.pick does. */
      this.cv.onclick = e => {
        if (P.state.phase !== 'idle' || P.state.holed) return;
        const r = this.cv.getBoundingClientRect();
        const b = App.ballPos || App.teePos();
        const w = this.view === 'map'
          ? this.toWorld(e.clientX - r.left, e.clientY - r.top)
          : (root.Soft3D ? root.Soft3D.pick(App, P, e.clientX - r.left, e.clientY - r.top) : null);
        if (!w) return;
        P.aim = Math.atan2(w[1] - b[2], w[0] - b[0]);
        App.aim = P.aim;
        P.clearPatterns();
        this.syncHud();
      };

      addEventListener('keydown', e => {
        const modal = $('cardModal').classList.contains('on');
        if (modal && e.key === 'Escape') { this.showCard(false); return; }
        const k = e.key.toLowerCase();
        if (k === ' ' || e.code === 'Space') {
          e.preventDefault();
          if (P.state.holed) this.walkOn(true); else P.tap();
          return;
        }
        if (k === 'a') { P.aim -= 0.012; App.aim = P.aim; P.clearPatterns(); }
        else if (k === 'd') { P.aim += 0.012; App.aim = P.aim; P.clearPatterns(); }
        else if (k === '[') this.stepClub(-1);
        else if (k === ']') this.stepClub(1);
        else if (k === 'n') { this.goHole(App.hole + 1); return; }
        else if (k === 'p') { this.goHole(App.hole - 1); return; }
        else if (k === 'r') P.restartHole();
        else if (k === 'z') { $('zoneBtn').click(); return; }
        else if (k === 'v') { $('viewBtn').click(); return; }
        else if (k === 'f') { $('fly').click(); return; }
        else if (k === 's') { this.showCard(!modal); return; }
        else return;
        this.syncHud();
      });

      addEventListener('resize', () => {
        if (this.resize()) { this.base = null; this._mini = null; this.newHoleView(); }
      });
    },

    /** Walk to the next tee: on a timer after holing out, or by hand. */
    walkOn(now) {
      const P = root.Play;
      if (this._walking && !now) return;
      clearTimeout(this._walkT);
      this._walking = false;
      const next = P.nextHoleNumber ? P.nextHoleNumber() : null;
      if (next) this.goHole(next);
      else { this.toast('Round complete', P.totalLabel()); this.showCard(true); }
    },

    loop() {
      let last = performance.now();
      const tick = () => {
        const now = performance.now();
        const dt = Math.min((now - last) / 1000, 0.05);
        last = now;
        const P = root.Play;
        const S = root.Soft3D;
        if (S && S.wantScale && S.wantScale !== S.renderScale) {
          S.renderScale = S.wantScale;
          S.wantScale = null;
          if (this.resize()) { this.base = null; if (this.view === 'map') this.rasterHole(); }
        }
        try {
          P.tick(dt);
          App.advanceShot(dt);
          // the flight is over: hand the result to the scorer, once
          if (P.pending && App.shot && App.shotAnim >= 1) {
            P.settle();
            this.syncHud();
            const last = P.state.shots[P.state.shots.length - 1];
            if (P.state.holed) {
              const n = P.state.stroke, par = App.holeData.par;
              const names = { '-3': 'Albatross', '-2': 'Eagle', '-1': 'Birdie',
                              '0': 'Par', '1': 'Bogey', '2': 'Double bogey' };
              this.toast(n === 1 ? 'Hole in one' :
                         (names[String(n - par)] || (n - par) + ' over'),
                         'Holed in ' + n + ' · walking to the next tee');
              /* Give the moment a couple of seconds, then move on. Having to
                 notice you have finished and press a button is the least
                 interesting thing a round of golf can ask. */
              if (!this._walking) {
                this._walking = true;
                this._walkT = setTimeout(() => this.walkOn(true), 2100);
              }
            } else if (last) {
              this.toast(last.club + ' · ' + Math.round(last.distYd) + ' yards',
                         [last.surface, last.note].filter(Boolean).join(' · '));
            }
          }
          this.drawMeter();
          this.draw();
        } catch (e) {
          if (!this._warned) { this._warned = true; console.error(e); }
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
  };

  root.Flat = Flat;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => Flat.boot());
  } else {
    Flat.boot();
  }
})(window);
