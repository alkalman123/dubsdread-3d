/* Playing the hole.
 *
 * The shipping preview has a shot visualiser: pick a club, click a target, watch
 * a tour-average shot fly. It is a good demonstration of the ball-flight model
 * and it is not a game — there is no skill input, the lie the ball finished in
 * does not affect the next strike, the tree line is not solid, and there is no
 * way to finish the hole because there is no putting.
 *
 * This turns it into one hole of stroke play:
 *
 *   - a two-stage swing that the player has to time, driving power and contact
 *   - lies that change what the club can do, with flyers out of light rough
 *   - trees and the flagstick as solid objects
 *   - putting on the real green contour, with a caddie's read
 *   - penalties, a stroke count and a scorecard
 *   - a caddie panel: club recommendation, carry numbers to clear the sand,
 *     what the wind and the elevation are worth
 *
 * Camera work is part of the game: the view follows the ball, then settles
 * behind wherever it finished, and drops to eye level on the green.
 */
(function (root) {
  'use strict';

  const App = root.App;
  const { clamp, lerp, M4, rng } = root.MM;
  const SP = root.ShotPoc;
  const M2Y = 1.09361, Y2M = 0.9144;

  /* ------------------------------------------------------- camera additions */

  const origSetCamera = App.setCamera;
  App.setCamera = function (mode, snap) {
    if (mode === 'play' || mode === 'follow' || mode === 'putt') {
      this.camMode = mode;
      this.camFixed = null;
      this.fovTarget = mode === 'putt' ? 34 : mode === 'follow' ? 44 : 46;
      if (snap) { this.fov = this.fovTarget; this.camPos = null; }
      if (root.UI && root.UI.onCameraChanged) root.UI.onCameraChanged();
      return;
    }
    origSetCamera.call(this, mode, snap);
  };

  /**
   * Tilt `look` down, if it has to be, until the ball sits above the controls.
   *
   * The play and putt cameras aim at where the shot is going, which puts the
   * ball near the bottom of the frame — and on a phone the bottom of the frame
   * is under the swing button. UI reports how much of the screen its controls
   * cover (App.viewInset, in CSS pixels); the ball is kept a little above that.
   * Only ever tilts down, so on a big screen with nothing in the way the
   * framing is exactly what it was.
   */
  App.keepInFrame = function (eye, look, ball) {
    const c = this.canvas;
    if (!c || !c.clientHeight) return;
    const H = c.clientHeight, aspect = c.clientWidth / H;
    const inset = this.viewInset || { top: 0, bottom: 0 };
    const band = Math.max(40, H - inset.top - inset.bottom);
    // lowest the ball may sit, as a fraction of the screen from the top
    const yMax = (inset.top + band * 0.80) / H;
    const ndc = 1 - 2 * yMax;                         // negative: below centre
    const half = this.effectiveFov(this.fovTarget || this.fov || 45, aspect) * 0.5;
    const dx = look[0] - eye[0], dy = look[1] - eye[1], dz = look[2] - eye[2];
    const hd = Math.hypot(dx, dz);
    if (hd < 1e-3) return;
    const pitch = Math.atan2(dy, hd);
    const bh = Math.hypot(ball[0] - eye[0], ball[2] - eye[2]);
    const beta = Math.atan2(ball[1] + 0.02 - eye[1], Math.max(bh, 0.05));
    const maxPitch = beta - Math.atan(ndc * Math.tan(half));
    if (pitch <= maxPitch) return;
    const L = Math.hypot(hd, dy);
    look[0] = eye[0] + dx / hd * Math.cos(maxPitch) * L;
    look[2] = eye[2] + dz / hd * Math.cos(maxPitch) * L;
    look[1] = eye[1] + Math.sin(maxPitch) * L;
  };

  const origUpdateCamera = App.updateCamera;
  App.updateCamera = function (dt) {
    const P = root.Play;
    const g = (x, z) => this.heightAt(x, z);
    let eye = null, look = null, snapK = null;

    if (this.camMode === 'play') {
      // Down the line from behind the ball, the way a player sees the shot.
      const b = this.ballPos || this.teePos();
      const a = P && P.state.active ? P.aim : this.aim;
      // a little closer on a phone held upright, where the ball is otherwise a
      // few pixels across
      const c = this.canvas, tall = c && c.clientHeight > c.clientWidth;
      const back = tall ? 3.9 : 5.2, height = tall ? 1.52 : 1.68;
      const ex = b[0] - Math.cos(a) * back, ez = b[2] - Math.sin(a) * back;
      const ey = Math.max(g(ex, ez) + height, b[1] + 0.9);
      // look at where the shot is meant to finish, not at the ball
      const reach = P ? Math.min(P.aimDistance(), 260) : 200;
      const tx = b[0] + Math.cos(a) * reach, tz = b[2] + Math.sin(a) * reach;
      eye = [ex, ey, ez];
      look = [tx, g(tx, tz) + 2.0, tz];
      this.keepInFrame(eye, look, b);
    } else if (this.camMode === 'putt') {
      /* Behind the ball on the line of the putt, looking at the hole — and,
         while the putt is rolling, staying behind the ball rather than behind
         where it started, so it cannot run out of the bottom of the frame. */
      const b = this.ballPos || (P && P.state.ballAt) || this.teePos();
      const pin = this.pinPos();
      const a = P && P.state.active ? P.aim : Math.atan2(pin[2] - b[2], pin[0] - b[0]);
      const d = Math.hypot(pin[0] - b[0], pin[2] - b[2]);
      const back = clamp(1.6 + d * 0.10, 1.8, 4.2);
      const ex = b[0] - Math.cos(a) * back, ez = b[2] - Math.sin(a) * back;
      const ey = g(ex, ez) + clamp(0.95 + d * 0.05, 1.0, 2.2);
      eye = [ex, ey, ez];
      look = [pin[0], pin[1] + 0.15, pin[2]];
      if (d < 0.3) look = [b[0] + Math.cos(a) * 3, b[1], b[2] + Math.sin(a) * 3];
      this.keepInFrame(eye, look, b);
    } else if (this.camMode === 'follow') {
      // Chase camera: behind and above the ball, along the direction it is
      // actually travelling, pulling back as it speeds up.
      const b = this.ballPos || this.teePos();
      const pts = this.tracerPoints;
      let dir = [Math.cos(this.aim), 0, Math.sin(this.aim)];
      if (pts && pts.length > 3) {
        const i = clamp(Math.floor(this.shotAnim * (pts.length - 1)), 1, pts.length - 1);
        const a = pts[Math.max(0, i - 3)], c = pts[i];
        const dx = c[0] - a[0], dz = c[2] - a[2];
        if (Math.hypot(dx, dz) > 0.05) dir = [dx, 0, dz];
      }
      const dl = Math.hypot(dir[0], dir[2]) || 1;
      dir = [dir[0] / dl, 0, dir[2] / dl];
      const apex = this.shot ? this.shot.stats.apexM : 20;
      const back = clamp(9 + apex * 0.30, 9, 26);
      const up = clamp(3.2 + apex * 0.16, 3.2, 12);
      const ex = b[0] - dir[0] * back, ez = b[2] - dir[2] * back;
      const ey = Math.max(g(ex, ez) + up, b[1] + up * 0.45);
      eye = [ex, ey, ez];
      look = [b[0] + dir[0] * 14, b[1] + 1.0, b[2] + dir[2] * 14];
      snapK = 0.00035;                       // tighter tracking than the default
    }

    if (!eye) { origUpdateCamera.call(this, dt); return; }

    if (!this.camPos) { this.camPos = eye.slice(); this.camLook = look.slice(); }
    const k = 1 - Math.pow(snapK === null ? 0.0016 : snapK, dt);
    for (let i = 0; i < 3; i++) {
      this.camPos[i] = lerp(this.camPos[i], eye[i], k);
      this.camLook[i] = lerp(this.camLook[i], look[i], k);
    }
    this.fov = lerp(this.fov || this.fovTarget, this.fovTarget, 1 - Math.pow(0.02, dt));
  };

  /* ------------------------------------------------------------ shot driver */

  App.playShotPoc = function (opts) {
    if (this.loading) return null;
    const res = SP.simulate(opts);
    this.shot = res;
    this.buildTracer(res);
    this.shotAnim = 0;
    this.ballPos = null;
    return res;
  };

  App.playPutt = function (opts) {
    if (this.loading) return null;
    const res = SP.putt(opts);
    // reuse the tracer ribbon for the roll, so the line the ball took is visible
    this.shot = {
      path: res.path, roll: [res.finalPoint],
      landPoint: res.finalPoint, finalPoint: res.finalPoint,
      landSurface: res.finalSurface, finalSurface: res.finalSurface,
      putt: res,
      stats: { hangTime: res.hangTime, totalYd: res.distM * M2Y, carryYd: 0,
               apexM: 0, club: 'Putter', clubId: 'P' }
    };
    this.buildTracer(this.shot);
    this.shotAnim = 0;
    this.ballPos = null;
    return this.shot;
  };

  /* ==================================================================== Play */

  const Play = {
    state: {
      active: false,
      phase: 'idle',            // idle | power | strike | flying | holed
      stroke: 0,
      penalties: 0,
      shots: [],
      holed: false,
      lie: 'tee',
      ballAt: null
    },

    /* swing meter */
    meter: { phase: null, t: 0, power: 0, strike: 0, dir: 1 },

    aim: 0,
    club: 'D',
    shape: 0,
    assist: true,               // show the read on the green
    autoSwing: false,
    stimp: 11.0,
    tempC: 22,
    seed: 1,

    /* --------------------------------------------------------------- round
     * A round is eighteen holes of the same per-hole state, plus a card. Nothing
     * in the hole logic is hole-specific — it all reads App.holeData — so the
     * round is mostly bookkeeping and a clean handover between holes.
     */
    round: null,

    init() {
      this.newRound();
      return this;
    },

    /** Start eighteen fresh holes from the current tee set. */
    newRound() {
      this.round = {
        card: new Array(18).fill(null),     // per hole: { score, penalties, shots }
        started: Date.now(),
        complete: false
      };
      this.newHole(App.hole || 1, true);
    },

    /**
     * Reset for one hole. Assumes the engine has already loaded it — the field,
     * meshes and props all have to be the new hole's before the colliders and
     * the tee position mean anything.
     */
    newHole(n, quiet) {
      const H = App.holeData;
      App.clearShot();
      if (App.clearScars) App.clearScars();
      // rebuilt per hole: the corridor the ball can hit is this hole's tree line
      this.colliders = SP.buildTreeColliders(App.trees, H.spine, 95);
      this.state = {
        active: true, phase: 'idle', stroke: 0, penalties: 0,
        shots: [], holed: false, lie: 'tee', ballAt: App.teePos()
      };
      this.tracks = [];
      /* Any shot still in the air belongs to the hole we are leaving. Without
       * this, resetting mid-flight leaves a resolved shot queued: UI.onShotProgress
       * has already scheduled settle(), that timer fires a moment later, and it
       * pushes the old shot onto the fresh scorecard and drops the ball where the
       * previous one finished. */
      this.pending = null;
      this._read = null;
      this._readAt = null;
      this._powerKey = null;
      this._recKey = null;
      this._patKey = null;
      this.aimPoint = null;
      App.aimPoint = null;
      App.ballPos = App.teePos();
      App.ballTeed = true;              // teePos() sits the ball on a peg
      this.seed = (Math.random() * 1e9) | 0;
      this.aim = App.defaultAim();
      App.aim = this.aim;
      this.club = this.recommendClub().id;
      this.gust = 1;
      App.setCamera('play', true);
      if (!quiet) this.notify();
    },

    /**
     * Start this hole again from the tee.
     *
     * Separate from newHole because it also releases the card: if the hole had
     * been holed out, its score has already been written, and replaying it
     * without clearing that entry would leave the old number on the card and
     * count the hole twice in the running total.
     */
    restartHole() {
      if (App.loading) return;
      if (this.round) this.round.card[App.hole - 1] = null;
      this.newHole(App.hole);
    },

    /** Hole number to play next, or null when the card is full. */
    nextHoleNumber() {
      if (!this.round) return null;
      return App.hole < 18 ? App.hole + 1 : null;
    },

    /**
     * Advance to the next hole. The engine load is asynchronous, so the caller
     * owns the transition (and the veil that hides it) — see UI.goHole.
     */
    holesPlayed() {
      return this.round ? this.round.card.filter(Boolean).length : 0;
    },

    roundTotals() {
      const C = App.course;
      let gross = 0, par = 0, thru = 0;
      let outG = 0, outP = 0, inG = 0, inP = 0;
      for (let i = 0; i < 18; i++) {
        const e = this.round && this.round.card[i];
        if (!e) continue;
        const p = C.holes[i].par;
        gross += e.score; par += p; thru++;
        if (i < 9) { outG += e.score; outP += p; } else { inG += e.score; inP += p; }
      }
      return { gross, par, thru, toPar: gross - par, outG, outP, inG, inP,
               complete: thru === 18 };
    },

    /** "+3 thru 7", the way a leaderboard says it. */
    totalLabel() {
      const t = this.roundTotals();
      if (!t.thru) return 'Not started';
      const p = t.toPar === 0 ? 'E' : (t.toPar > 0 ? '+' : '\u2212') + Math.abs(t.toPar);
      return p + (t.complete ? ' \u00b7 final' : ' thru ' + t.thru);
    },

    /* ---------------------------------------------------------- geometry */
    ball() { return App.ballPos || this.state.ballAt || App.teePos(); },

    lie() {
      const b = this.ball();
      return App.field.surfaceAt(b[0], b[2]);
    },

    lieInfo() { return SP.LIES[this.lie()] || SP.LIES.fairway; },

    /**
     * Is this a putt?
     *
     * The green, or the fringe from close enough that a player would putt rather
     * than chip. Six metres is about the limit — any further off the surface and
     * the shot is a wedge, and a putter swung twenty yards was the giveaway that
     * this threshold was too generous.
     */
    onGreen() {
      const l = this.lie();
      return l === 'green' || (l === 'fringe' && this.toPin() < 6);
    },

    isPutting() { return this.onGreen(); },

    toPin() {
      const b = this.ball(), p = App.pinPos();
      return Math.hypot(p[0] - b[0], p[2] - b[2]);
    },

    aimDistance() {
      if (this.aimPoint) {
        const b = this.ball();
        return Math.hypot(this.aimPoint[0] - b[0], this.aimPoint[2] - b[2]);
      }
      return this.toPin();
    },

    setAim(worldPt) {
      const b = this.ball();
      this.aim = Math.atan2(worldPt[2] - b[2], worldPt[0] - b[0]);
      this.aimPoint = worldPt;
      App.aim = this.aim;
      App.aimPoint = worldPt;
      if (!this.isPutting()) this.club = this.recommendClub(Math.hypot(
        worldPt[0] - b[0], worldPt[2] - b[2]) * M2Y).id;
      this.notify();
    },

    nudgeAim(deg) {
      this.aim += deg * Math.PI / 180;
      const b = this.ball();
      const d = this.isPutting() ? this.toPin() : this.aimDistance();
      this.aimPoint = [b[0] + Math.cos(this.aim) * d, 0, b[2] + Math.sin(this.aim) * d];
      this.aimPoint[1] = App.heightAt(this.aimPoint[0], this.aimPoint[2]);
      App.aim = this.aim;
      App.aimPoint = this.aimPoint;
      this.notify();
    },

    /* ------------------------------------------------------------- caddie */

    windVec() { return App.windVec(); },

    /** A representative shot with a given club from where the ball is. */
    trial(clubId, over) {
      return SP.simulate(Object.assign({
        origin: this.ball(), aim: this.aim, club: clubId,
        profile: App.profile || 'tour', lie: this.lie(),
        power: 1, strike: 1, faceErr: 0, shape: 0,
        wind: this.windVec(), gust: 1, tempC: this.tempC,
        field: App.field, colliders: null, pin: null, seed: 7,
        deterministic: true
      }, over || {}));
    },

    /**
     * Club selection, the way a golfer does it.
     *
     * Not "whose full swing lands nearest" — that picks a lob wedge for a 30
     * yard pitch and then hits it 75, which is the difference between a launch
     * monitor and a player. Score each club on how close the shot would be to a
     * comfortable stock swing (about 92% of full), and refuse clubs that cannot
     * reach at all.
     */
    recommendClub(targetYd) {
      const target = targetYd === undefined ? this.toPin() * M2Y : targetYd;
      const b = this.ball();
      const key = Math.round(target) + '|' + this.lie() + '|' +
                  Math.round(b[0]) + ',' + Math.round(b[2]) + '|' +
                  Math.round(App.wind.speed * 4) + ',' + Math.round(App.wind.dir) + '|' +
                  (App.profile || 'tour') + '|' + Math.round(this.tempC);
      if (this._recKey === key) return this._rec;
      let best = null;
      for (const c of root.Shot.CLUBS) {
        const full = this.trial(c.id).stats.totalYd;
        const frac = full > 1 ? target / full : 99;
        const score = frac <= 1.02 ? Math.abs(frac - 0.92) : 10 + (frac - 1);
        if (!best || score < best.score) {
          best = { score, id: c.id, name: c.name, fullYd: full, frac };
        }
      }
      this._recKey = key;
      this._rec = best || { id: 'D', name: 'Driver', fullYd: 280, frac: 1 };
      return this._rec;
    },

    /**
     * Swing effort that carries a given club a given distance.
     * Bisected on the real flight, so wind, lie and elevation are all in it.
     *
     * Solved on carry, not on total. Total distance includes the roll-out, and
     * roll on sloping ground is not monotonic in swing power — land a wedge on
     * an upslope and it can come back toward you, so a bisection on total will
     * happily converge on a spurious crossing and hand back half the effort the
     * shot needs. Carry rises with power, always. It is also how a golfer thinks
     * about a wedge: pick a number to land it on.
     */
    powerFor(clubId, targetYd) {
      const b = this.ball();
      const key = clubId + '|' + Math.round(targetYd) + '|' + this.lie() +
                  '|' + Math.round(b[0]) + ',' + Math.round(b[2]) +
                  '|' + Math.round(App.wind.speed * 4) + '|' + Math.round(App.wind.dir);
      if (this._powerKey === key) return this._power;
      const solve = want => {
        let lo = 0.2, hi = 1.06;
        for (let i = 0; i < 7; i++) {
          const mid = (lo + hi) / 2;
          if (this.trial(clubId, { power: mid }).stats.carryYd < want) lo = mid;
          else hi = mid;
        }
        return clamp((lo + hi) / 2, 0.2, 1.06);
      };

      /* Bisect on carry, correct on finish.
       *
       * What matters is where the ball stops, but total distance is not monotonic
       * in swing power once roll on a slope is in it, so it cannot be bisected
       * directly. Instead solve the monotonic quantity and then walk the carry
       * target by however far the resulting shot over- or under-ran. Two
       * corrections is plenty, and it is much better than deducting a fixed
       * fraction of the roll: a shot landing on a green checks up, the same shot
       * three yards further on lands on the downslope behind it and releases
       * thirty. Guessing that split is what made every par 3 fly the green. */
      let want = targetYd;
      let p = solve(want);
      for (let i = 0; i < 2; i++) {
        const err = this.trial(clubId, { power: p }).stats.totalYd - targetYd;
        if (Math.abs(err) < 2.5) break;
        want = clamp(want - err * 0.9, targetYd * 0.30, targetYd * 1.15);
        p = solve(want);
      }

      this._powerKey = key;
      this._power = p;
      return p;
    },

    /** Club and effort the caddie is suggesting for the shot in front of you. */
    plan() {
      const target = this.aimDistance() * M2Y;
      const rec = { id: this.club, name: root.Shot.clubBy(this.club).name };
      return { club: rec.id, name: rec.name, power: this.powerFor(rec.id, target), targetYd: target };
    },

    /**
     * Everything a caddie would say before the shot.
     *
     * The wind and elevation numbers are measured by running the ball-flight
     * model twice rather than applied as a rule of thumb, so they respond to
     * the actual trajectory: a wedge into a breeze loses far more than a
     * driver does, and that falls out of the physics instead of a fudge.
     */
    caddie() {
      const b = this.ball();
      const pin = App.pinPos();
      const pinYd = this.toPin() * M2Y;
      const rec = this.recommendClub();
      // measure the wind and elevation effect on the shot actually being played,
      // at the effort it needs, rather than on a full swing with a random club
      const power = this.powerFor(rec.id, pinYd);
      const withWind = this.trial(rec.id, { power });
      const still = this.trial(rec.id, { power, wind: [0, 0] });
      const windYd = still.stats.carryYd - withWind.stats.carryYd;
      const elevFt = (pin[1] - b[1]) * 3.28084;

      // green depth along the line of play
      const ax = Math.cos(this.aim), az = Math.sin(this.aim);
      let front = Infinity, back = -Infinity;
      for (const ring of App.holeData.green.rings) {
        for (const p of ring) {
          const along = (p[0] - b[0]) * ax + (p[1] - b[2]) * az;
          front = Math.min(front, along); back = Math.max(back, along);
        }
      }

      const w = this.windVec();
      const wSpeed = Math.hypot(w[0], w[1]);
      let windText = 'Calm';
      if (wSpeed > 0.3) {
        const along = (w[0] * ax + w[1] * az) / wSpeed;
        const across = (-w[0] * az + w[1] * ax) / wSpeed;
        const mph = Math.round(wSpeed * 2.23694);
        const dir = along > 0.6 ? 'downwind' : along < -0.6 ? 'into the wind'
          : across > 0 ? 'left to right' : 'right to left';
        windText = mph + ' mph ' + dir;
      }

      return {
        pinYd, rec, power, windYd, elevFt, windText,
        frontYd: front * M2Y, backYd: back * M2Y,
        playsLikeYd: pinYd + windYd - elevFt * 0.28,
        lie: this.lieInfo(),
        carries: this.bunkerCarries(),
        expected: withWind
      };
    },

    /**
     * Carry needed to clear, or to stay short of, each bunker on the line.
     * This is the number a course guide exists to give you.
     */
    bunkerCarries() {
      const b = this.ball();
      const ax = Math.cos(this.aim), az = Math.sin(this.aim);
      const out = [];
      const rings = App.holeData.bunkers;
      for (let i = 0; i < rings.length; i++) {
        let near = Infinity, far = -Infinity, minAcross = Infinity, side = 0;
        for (const p of rings[i]) {
          const along = (p[0] - b[0]) * ax + (p[1] - b[2]) * az;
          const across = -(p[0] - b[0]) * az + (p[1] - b[2]) * ax;
          near = Math.min(near, along); far = Math.max(far, along);
          if (Math.abs(across) < Math.abs(minAcross)) { minAcross = across; }
          side += across;
        }
        if (far < 12) continue;                       // behind or beside us
        if (Math.abs(minAcross) > 26) continue;       // not on this line
        out.push({
          i, carryYd: far * M2Y, shortYd: near * M2Y,
          side: side > 0 ? 'left' : 'right',
          onLine: Math.abs(minAcross) < 11
        });
      }
      out.sort((a, b2) => a.carryYd - b2.carryYd);
      return out.slice(0, 3);
    },

    /* ------------------------------------------------------- shot patterns
     * What actually happens if you hit this shot, given who you are.
     *
     * The caddie's numbers describe one perfect strike. A golfer is a
     * distribution, and the interesting question before a tee shot is not "how
     * far does a driver go" but "how much of that dispersion cone is still
     * fairway". Sampling the same flight model the shot itself will use answers
     * that directly: the trees, the wind profile, the lie and the roll-out are
     * all already in it, so the pattern is the hole's own answer rather than an
     * ellipse drawn on top of it.
     */

    /** One profile's spread of outcomes for the shot in front of you. */
    shotPattern(profileId, n) {
      const skill = SP.SKILL[profileId] || SP.SKILL.tour;
      const b = this.ball();
      const lie = this.lie();
      const plan = this.powerFor(this.club, this.aimDistance() * M2Y);
      const R = rng(0x9e37 ^ (profileId.charCodeAt(0) * 7919));
      const g = () => (R() + R() + R() - 1.5) / 0.866;

      const shots = [];
      for (let i = 0; i < n; i++) {
        // A player misses in three ways at once: contact, effort and face angle.
        // Sampling only the start direction gives a pencil-thin pattern that is
        // long in every sample, which is not what a scorecard looks like.
        const strike = clamp(skill.strike + g() * 0.085, 0.25, 1);
        const power = clamp(plan * (1 + g() * 0.038), 0.2, 1.10);
        const faceErr = clamp(g() * 0.16 * (1.4 - skill.strike), -1, 1);
        const res = SP.simulate({
          origin: b, aim: this.aim, club: this.club, profile: profileId, lie: lie,
          power: power, strike: strike, faceErr: faceErr, shape: this.shape,
          wind: this.windVec(), gust: 0.85 + R() * 0.4, tempC: this.tempC,
          field: App.field, colliders: this.colliders, pin: null,
          seed: (R() * 2147483647) | 0
        });
        const f = res.finalPoint;
        const ax = Math.cos(this.aim), az = Math.sin(this.aim);
        shots.push({
          x: f[0], z: f[2],
          along: ((f[0] - b[0]) * ax + (f[2] - b[2]) * az) * M2Y,
          across: (-(f[0] - b[0]) * az + (f[2] - b[2]) * ax) * M2Y,
          surface: res.finalSurface,
          tree: !!res.hitTree,
          totalYd: res.stats.totalYd
        });
      }
      return this.summarise(profileId, skill, shots);
    },

    /** Percentiles rather than a mean and a sigma: outcomes here are not normal
     *  — a tree or a bunker truncates one tail and nothing truncates the other. */
    summarise(profileId, skill, shots) {
      const pct = (arr, q) => {
        const a = arr.slice().sort((x, y) => x - y);
        return a[clamp(Math.round((a.length - 1) * q), 0, a.length - 1)];
      };
      const along = shots.map(s => s.along);
      const across = shots.map(s => s.across);
      const counts = {};
      let trees = 0;
      for (const s of shots) {
        const k = s.surface;
        counts[k] = (counts[k] || 0) + 1;
        if (s.tree) trees++;
      }
      const n = shots.length;
      const share = {};
      for (const k in counts) share[k] = counts[k] / n;
      return {
        profile: profileId, name: skill.name, shots, n,
        alongMid: pct(along, 0.5),
        alongLo: pct(along, 0.1), alongHi: pct(along, 0.9),
        acrossLo: pct(across, 0.1), acrossHi: pct(across, 0.9),
        acrossMid: pct(across, 0.5),
        share, trees: trees / n,
        good: (share.fairway || 0) + (share.green || 0) + (share.fringe || 0) + (share.tee || 0),
        bad: (share.water || 0) + (share.native || 0) + (share.sand || 0)
      };
    },

    /**
     * The same shot for every skill level, so a player can see what the hole
     * asks of them rather than what it asks of a tour professional.
     */
    allPatterns(n) {
      const b = this.ball();
      const key = [Math.round(b[0]), Math.round(b[2]), this.club,
                   Math.round(this.aim * 200), Math.round(App.wind.speed * 4),
                   Math.round(App.wind.dir), this.lie(), Math.round(this.shape * 20),
                   n || 22].join('|');
      if (this._patKey === key) return this._pat;
      const out = ['tour', 'low', 'mid', 'senior'].map(p => this.shotPattern(p, n || 22));
      this._patKey = key;
      this._pat = out;
      return out;
    },

    clearPatterns() { this._patKey = null; this._pat = null; },

    /* --------------------------------------------------------- swing meter */

    beginSwing() {
      if (this.state.phase !== 'idle' || !this.state.active) return;
      if (this.autoSwing) {
        // a flush strike, but at the effort the shot actually needs
        this.strike({ power: this.plan().power, strike: 1, faceErr: 0 });
        return;
      }
      this.meter = { phase: 'power', t: 0, power: 0, strike: 0, dir: 1 };
      this.state.phase = 'power';
      this.notify();
    },

    /** Called by the render loop; drives the meter needles. */
    tick(dt) {
      const m = this.meter;
      if (this.state.phase === 'power') {
        // up to 110% in a second, then back down: overswing is available but it
        // costs contact, which is the trade every golfer actually makes
        m.t += dt * m.dir * 1.10;
        if (m.t >= 1.12) { m.t = 1.12; m.dir = -1; }
        if (m.t <= 0 && m.dir < 0) { m.t = 0; m.dir = 1; }
      } else if (this.state.phase === 'strike') {
        m.t += dt * 2.35 * m.dir;
        if (m.t >= 1) { m.t = 1; m.dir = -1; }
        if (m.t <= -1) { m.t = -1; m.dir = 1; }
      }
    },

    /** Space / click: locks whichever needle is running. */
    tap() {
      if (this.state.phase === 'idle') { this.beginSwing(); return; }
      if (this.state.phase === 'power') {
        this.meter.power = clamp(this.meter.t, 0.15, 1.12);
        this.meter.t = 0; this.meter.dir = 1;
        this.state.phase = 'strike';
        this.notify();
        return;
      }
      if (this.state.phase === 'strike') {
        const face = this.meter.t;
        this.meter.strike = face;
        // an 8% dead band counts as flush: there has to be a reward for timing
        const err = Math.abs(face) < 0.08 ? 0 : face - Math.sign(face) * 0.08;
        const overswing = clamp(this.meter.power - 1.0, 0, 0.12) / 0.12;
        this.strike({
          power: this.meter.power,
          strike: clamp(1 - Math.abs(err) * 1.15 - overswing * 0.22, 0, 1),
          faceErr: err
        });
      }
    },

    /* -------------------------------------------------------------- strike */

    strike(sw) {
      if (!this.state.active || this.state.holed) return;
      const lie = this.lie();
      if (this.isPutting()) { this.putt(sw); return; }

      const b = this.ball();
      this.state.ballAt = b.slice();
      this.state.stroke++;
      this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;

      // a gust for this shot only, so the same swing twice is not the same shot
      const gr = rng(this.seed ^ 0x5bf03635);
      this.gust = 0.82 + gr() * 0.42;

      App.ballTeed = false;             // struck; the peg is behind it now
      const res = App.playShotPoc({
        origin: b, aim: this.aim, club: this.club,
        profile: App.profile || 'tour', lie: lie,
        power: sw.power, strike: sw.strike, faceErr: sw.faceErr, shape: this.shape,
        wind: this.windVec(), gust: this.gust, tempC: this.tempC,
        field: App.field, colliders: this.colliders, pin: App.pinPos(),
        seed: this.seed
      });

      // the club takes a divot where it entered, unless there was nothing to take
      if (lie !== 'sand' && lie !== 'path' && lie !== 'tee' && this.club !== 'D') {
        App.addScar(b[0] + Math.cos(this.aim) * 0.20, b[2] + Math.sin(this.aim) * 0.20,
                    'divot', 0.22 + sw.power * 0.10,
                    [Math.cos(this.aim), Math.sin(this.aim)]);
      }
      if (lie === 'sand') App.addScar(b[0], b[2], 'wear', 0.9);

      this.pending = { kind: 'shot', res, from: b.slice(), lie };
      this.state.phase = 'flying';
      App.setCamera('follow', false);
      this.notify();
      return res;
    },

    /* --------------------------------------------------------------- putt */

    /** The read: where to aim and how hard, from the real contour. */
    read() {
      if (this._read && this._readAt &&
          Math.hypot(this._readAt[0] - this.ball()[0], this._readAt[1] - this.ball()[2]) < 0.05) {
        return this._read;
      }
      const r = SP.readPutt({
        origin: this.ball(), pin: App.pinPos(), field: App.field, stimp: this.stimp
      });
      this._read = r;
      this._readAt = [this.ball()[0], this.ball()[2]];
      return r;
    },

    putt(sw) {
      const b = this.ball();
      this.state.ballAt = b.slice();
      this.state.stroke++;
      this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
      const R = rng(this.seed);
      const skill = SP.SKILL[App.profile || 'tour'] || SP.SKILL.tour;

      const read = this.read();
      const dist = this.toPin();
      // power 1.0 means "the read pace"; the meter scales it
      const base = SP.puttSpeedFor({ origin: b, aim: this.aim, field: App.field, stimp: this.stimp },
                                   dist + 0.45);
      const err = ((R() + R() - 1) * skill.puttErr);
      const speed = clamp(base * (sw.power === undefined ? 1 : sw.power) * (1 + err * 3), 0.25, 9);
      const aim = this.aim + (sw.faceErr || 0) * 0.035 + err * 0.6;

      const res = App.playPutt({
        origin: b, aim, speed, field: App.field, pin: App.pinPos(), stimp: this.stimp
      });
      // a ball landing on the green from the air leaves a mark; a putt leaves none
      this.pending = { kind: 'putt', res, from: b.slice(), lie: this.lie() };
      this.state.phase = 'flying';
      App.setCamera('putt', false);
      this.notify();
      return res;
    },

    /** Aim straight at the hole and use the read's own pace. */
    autoPutt() {
      const r = this.read();
      this.aim = r.aim;
      App.aim = this.aim;
      this.putt({ power: 1, faceErr: 0 });
    },

    tapIn() {
      if (this.toPin() > 0.75 || this.state.holed) return;
      this.state.stroke++;
      this.state.shots.push({
        no: this.state.stroke, club: 'Putter', lie: 'green',
        distYd: this.toPin() * M2Y, result: 'Holed', surface: 'holed', note: 'tap in'
      });
      this.finish();
    },

    /* ---------------------------------------------------- shot resolution */

    /** Called once the flight animation has finished. */
    settle() {
      const p = this.pending;
      if (!p) return;
      this.pending = null;
      this._read = null;
      const st = this.state;
      const res = p.res;

      if (p.kind === 'putt') {
        const r = res.putt;
        st.shots.push({
          no: st.stroke, club: 'Putter', lie: p.lie,
          distYd: r.distM * M2Y,
          result: r.holed ? 'Holed' : (r.toPin * 3.28084).toFixed(1) + ' ft short/past',
          surface: r.holed ? 'holed' : r.finalSurface,
          note: r.lipOut ? 'lipped out' : (r.holed ? '' : this.puttNote(r))
        });
        if (r.holed) { this.finish(); return; }
        st.phase = 'idle';
        App.ballPos = r.finalPoint;
        App.setCamera('putt', false);
        this.afterSettle();
        return;
      }

      /* --- full shot -------------------------------------------------- */
      let surface = res.finalSurface;
      let note = [];
      if (res.hitTree) note.push(res.hitTree === 'trunk' ? 'hit a trunk' : 'came down through the branches');
      if (res.hitPin) note.push('rattled the flagstick');
      if (res.flyer) note.push('flyer out of the grass');
      else if (res.thin) note.push('thinned it');
      else if (res.fat) note.push('heavy');

      if (surface === 'water') {
        st.penalties++;
        const drop = this.dropPoint(res);
        App.ballPos = drop;
        st.shots.push({
          no: st.stroke, club: res.stats.club, lie: p.lie,
          distYd: res.stats.totalYd, result: 'Water — penalty', surface: 'water',
          note: note.join(', '), penalty: 1
        });
        st.phase = 'idle';
        App.setCamera('play', false);
        this.afterSettle();
        return;
      }

      // a shot landing on the green leaves a pitch mark
      if (res.landSurface === 'green' && res.stats.descentAngle > 30) {
        App.addScar(res.landPoint[0], res.landPoint[2], 'pitch', 0.16);
      }

      st.shots.push({
        no: st.stroke, club: res.stats.club, lie: p.lie,
        distYd: res.stats.totalYd, carryYd: res.stats.carryYd,
        offlineYd: res.stats.offlineYd,
        result: this.describeResult(res), surface,
        note: note.join(', ')
      });
      App.ballPos = res.finalPoint;
      st.phase = 'idle';
      App.setCamera(this.isPutting() ? 'putt' : 'play', false);
      this.afterSettle();
    },

    afterSettle() {
      this.state.ballAt = App.ballPos.slice();
      const pin = App.pinPos();
      const b = App.ballPos;
      this.aim = Math.atan2(pin[2] - b[2], pin[0] - b[0]);
      App.aim = this.aim;
      this.aimPoint = null;
      App.aimPoint = null;
      if (!this.isPutting()) this.club = this.recommendClub().id;
      this.clearPatterns();
      App.updateGrass(true);
      this.notify();
    },

    puttNote(r) {
      const past = r.distM > this.distAtStroke;
      return Math.abs(r.breakM) > 0.25 ? 'broke ' + (r.breakM > 0 ? 'right' : 'left') : '';
    },

    describeResult(res) {
      const pin = App.pinPos();
      const f = res.finalPoint;
      const toPin = Math.hypot(pin[0] - f[0], pin[2] - f[2]) * M2Y;
      const S = SP.LIES[res.finalSurface];
      if (res.finalSurface === 'green') {
        const ft = toPin * 3;
        return ft < 3 ? 'Gimme range' : Math.round(ft) + ' ft from the hole';
      }
      if (res.finalSurface === 'fringe') return 'Fringe, ' + Math.round(toPin * 3) + ' ft out';
      return (S ? S.name : res.finalSurface) + ', ' + Math.round(toPin) + ' yds left';
    },

    /**
     * Where the ball is played from after a water penalty: back along the flight
     * line to the last dry point, which is close enough to a proper drop.
     */
    dropPoint(res) {
      const pts = res.path.concat(res.roll);
      let last = null;
      for (const q of pts) {
        if (App.field.surfaceAt(q[0], q[2]) === 'water') break;
        last = q;
      }
      if (!last) last = this.state.ballAt;
      // two metres back toward the tee, out of the hazard
      const from = this.state.ballAt;
      const dx = from[0] - last[0], dz = from[2] - last[2];
      const l = Math.hypot(dx, dz) || 1;
      let x = last[0] + dx / l * 2.5, z = last[2] + dz / l * 2.5;
      for (let i = 0; i < 20 && App.field.surfaceAt(x, z) === 'water'; i++) {
        x += dx / l * 2; z += dz / l * 2;
      }
      return [x, App.field.height(x, z), z];
    },

    finish() {
      this.state.holed = true;
      this.state.phase = 'holed';
      const total = this.state.stroke + this.state.penalties;
      this.state.score = total;
      this.state.toPar = total - App.holeData.par;
      if (this.round) {
        this.round.card[App.hole - 1] = {
          score: total, penalties: this.state.penalties,
          shots: this.state.shots.slice(), par: App.holeData.par
        };
        this.round.complete = this.roundTotals().complete;
      }
      App.setCamera('green', false);
      this.notify();
    },

    scoreName() {
      const p = this.state.toPar;
      if (p === undefined) return '';
      if (this.state.score === 1) return 'Hole in one';
      return p <= -3 ? 'Albatross' : p === -2 ? 'Eagle' : p === -1 ? 'Birdie'
        : p === 0 ? 'Par' : p === 1 ? 'Bogey' : p === 2 ? 'Double bogey'
        : p === 3 ? 'Triple bogey' : (p + ' over');
    },

    notify() {
      if (root.UI && root.UI.onPlayChanged) root.UI.onPlayChanged();
    }
  };

  root.Play = Play;
})(window);
