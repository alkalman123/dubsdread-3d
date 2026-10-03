/* A 3D view of the hole with no GPU involved at all.
 *
 * Some browsers will not hand over a WebGL 2 context, and there is no arguing
 * with that — the renderer needs one and cannot be talked into working without.
 * But "3D" is a picture, not an API. Everything needed to draw one is already
 * here in plain JavaScript: the height field, the surface classification, the
 * tree positions, the sun direction. What was missing was somewhere to put the
 * triangles, and a 2D canvas is somewhere.
 *
 * So this projects and shades the course by hand, from the ball, down the line
 * of play. It is not the WebGL renderer at lower quality — there are no
 * shadows, no atmosphere integral, no grass. It is a different renderer that
 * happens to draw the same course, and it runs anywhere a canvas does.
 *
 * The one idea worth knowing: the ground is built in camera space rather than
 * world space. Rows march away from the viewer at geometrically increasing
 * spacing, so every row costs about the same number of screen pixels — near
 * ground gets detail, far ground does not waste any — and because the rows are
 * generated in depth order, drawing them far to near is a painter's algorithm
 * for free. No sorting, no depth buffer, no z-fighting.
 */
(function (root) {
  'use strict';

  const { clamp } = root.MM;

  /* Surface colours, matched to the WebGL build's palette so the two look like
     the same golf course. */
  const SURF = {
    fairway: [122, 168, 92], green: [140, 196, 104], fringe: [128, 178, 96],
    tee: [122, 168, 92], rough: [82, 122, 66], native: [156, 146, 92],
    sand: [222, 206, 166], path: [156, 154, 148], water: [70, 128, 158]
  };

  /* Smooth value noise: a hash at the cell corners, cubically interpolated
     between them. Sampled at a floor() instead, a hash is constant across its
     whole cell, which is just a second layer of blocks over the ones it was
     meant to hide. */
  function hash2(a, b) {
    const v = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
    return v - Math.floor(v);
  }

  function vnoise(x, z) {
    const xi = Math.floor(x), zi = Math.floor(z);
    const fx = x - xi, fz = z - zi;
    const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
    const a = hash2(xi, zi), b = hash2(xi + 1, zi);
    const c = hash2(xi, zi + 1), d = hash2(xi + 1, zi + 1);
    const top = a + (b - a) * sx;
    return top + ((c + (d - c) * sx) - top) * sz;
  }

  /* Canopy tints per archetype, roughly the leaf colours the 3D build uses. */
  const TREE = [[74, 104, 52], [92, 124, 62], [108, 140, 70], [58, 92, 62]];

  const Soft3D = {
    /* Rows: how far the ground is drawn and at what spacing. NEAR is the first
       row's distance, FAR the last, and the ratio between consecutive rows is
       constant, which is what keeps screen-space density even. */
    ROWS: 54,
    COLS: 74,
    NEAR: 1.5,
    FAR: 340,
    fov: 52 * Math.PI / 180,

    /* Grid sizes to fall back and forth between. Every machine this runs on is
       one that could not give us a GPU, so "fast enough" is not a safe
       assumption to make once and forget. */
    STEPS: [[44, 60], [54, 74], [64, 88], [74, 104]],
    stepIx: 1,

    /* Resolution steps for the backing store.
     *
     * Reducing the grid barely moved the frame time, which was the clue: the
     * cost is fill rate, not quad count. Every quad in a row is a slice of the
     * same screen, so a coarser grid paints the same pixels in fewer, larger
     * pieces. What costs less is painting fewer pixels. The canvas is stretched
     * over its box by CSS, so shrinking the backing store and letting the
     * browser scale it up is a straight multiplier on the whole frame — and the
     * bilinear upscale softens the quad edges on the way, which is the
     * blockiness we were fighting anyway.
     */
    SCALES: [0.50, 0.62, 0.78, 1.0],
    scaleIx: 2,
    renderScale: 0.78,

    attach(canvas) {
      this.cv = canvas;
      this.ctx = canvas.getContext('2d');
      this.buildRows();
      return this;
    },

    /**
     * Keep the frame inside a budget by changing how much ground is in it.
     *
     * Held over eight frames so a single slow one — a hole loading, the tab
     * coming back — does not move it, and with a gap between the two
     * thresholds so it cannot sit on the boundary flipping back and forth.
     */
    pace(ms) {
      this._t = this._t || [];
      this._t.push(ms);
      if (this._t.length < 8) return;
      const med = this._t.slice().sort((a, b) => a - b)[4];
      this._t.length = 0;
      /* Resolution first, grid second. Pixels are the expensive axis, and a
         softer upscale costs less to look at than a coarser grid does. */
      /* Degrade only, never climb back.
       *
       * A two-way pacer oscillated: a step down makes the frame cheap enough to
       * qualify for a step up, which makes it expensive enough to qualify for a
       * step down, and the picture pumps between two settings forever. Worse, a
       * measurement taken across a resize describes neither setting. Starting
       * conservative and only ever giving ground is deterministic — it settles
       * once, on whatever this machine can hold, and stays there. */
      if (med > 30) {
        if (this.stepIx > 0) this.setGrid(this.stepIx - 1);
        else if (this.scaleIx > 0) {
          this.scaleIx--;
          this.wantScale = this.SCALES[this.scaleIx];
        }
      }
    },

    setGrid(ix) {
      this.stepIx = ix;
      this.ROWS = this.STEPS[ix][0];
      this.COLS = this.STEPS[ix][1];
      this._half = null;
      this.buildRows();
    },

    buildRows() {
      const k = Math.pow(this.FAR / this.NEAR, 1 / (this.ROWS - 1));
      this.dist = [];
      for (let i = 0, d = this.NEAR; i < this.ROWS; i++, d *= k) this.dist.push(d);
      // lateral fan, in radians off the view axis: half the field of view plus
      // a margin so the edges of the screen are covered when the camera rolls
      this.fan(this.fov * 0.92);
    },

    /**
     * Lay the columns across exactly the angle the screen covers.
     *
     * The horizontal field of view is not the vertical one — it follows the
     * aspect ratio — and fanning wider than the frustum spends columns on
     * ground nobody can see while thinning out the ground they can. Measured
     * per frame, because the window can be any shape.
     */
    fan(half) {
      if (Math.abs(half - this._half) < 0.01) return;
      this._half = half;
      this.ang = [];
      for (let j = 0; j < this.COLS; j++) {
        this.ang.push(-half + (2 * half) * (j / (this.COLS - 1)));
      }
    },

    /* ------------------------------------------------------------ camera */

    /** Behind the ball, down the line, the way the 3D build's play camera sits. */
    /* Flyover: tee to green along the hole's own spine, rising to an apex in
       the middle and settling behind the green, looking a little ahead of
       itself so the corridor opens up rather than sliding past. */
    mode: 'play',
    flyT: 0,

    startFly() { this.mode = 'fly'; this.flyT = 0; },
    stopFly() { this.mode = 'play'; },

    flyCamera(App) {
      const H = App.holeData, sp = H.spine;
      const u = clamp(this.flyT, 0, 1);
      const at = t => {
        const f = clamp(t, 0, 1) * (sp.length - 1);
        const i = Math.min(sp.length - 1, Math.floor(f)), j = Math.min(sp.length - 1, i + 1);
        const k = f - i;
        return [sp[i][0] + (sp[j][0] - sp[i][0]) * k, sp[i][1] + (sp[j][1] - sp[i][1]) * k];
      };
      const p = at(u), look = at(u + 0.14);
      const alt = 9 + Math.sin(u * Math.PI) * 26;
      return {
        x: p[0], y: App.heightAt(p[0], p[1]) + alt, z: p[1],
        yaw: Math.atan2(look[1] - p[1], look[0] - p[0]),
        pitch: 0.16 + Math.sin(u * Math.PI) * 0.18
      };
    },

    camera(App, Play) {
      if (this.mode === 'fly') return this.flyCamera(App);
      const b = App.ballPos || App.teePos();
      const aim = Play && Play.state.active ? Play.aim : App.aim;
      const back = 5.4, height = 1.72;
      const ex = b[0] - Math.cos(aim) * back;
      const ez = b[2] - Math.sin(aim) * back;
      const ey = Math.max(App.heightAt(ex, ez) + height, b[1] + 1.0);
      return { x: ex, y: ey, z: ez, yaw: aim, pitch: 0.050 };
    },

    /**
     * Which point of ground a screen position is over.
     *
     * Clicking to aim only means something if the click can be turned back into
     * a place on the course. Inverting the projection needs the height at the
     * answer, which is what is being solved for, so walk out along the ray and
     * stop where it crosses the ground — the same march the flight uses to find
     * where a shot lands.
     */
    pick(App, Play, sx, sy) {
      const cv = this.cv;
      if (!cv) return null;
      const W = cv.width, H = cv.height;
      const cam = this.camera(App, Play);
      const focal = (H * 0.5) / Math.tan(this.fov * 0.5);
      const horizon = H * 0.5 - focal * Math.tan(cam.pitch);
      // canvas is CSS-scaled, so put the click into buffer pixels first
      const bx = sx * (W / cv.clientWidth), by = sy * (H / cv.clientHeight);
      const dyOverF = (horizon - by) / focal;          // rise per unit forward
      if (dyOverF >= -0.002) return null;              // at or above the horizon
      const rOverF = (bx - W * 0.5) / focal;
      const cy = Math.cos(cam.yaw), sn = Math.sin(cam.yaw);
      let lo = 0.5, hi = 600;
      for (let i = 0; i < 26; i++) {
        const f = (lo + hi) * 0.5;
        const x = cam.x + cy * f - sn * (rOverF * f);
        const z = cam.z + sn * f + cy * (rOverF * f);
        const rayY = cam.y + dyOverF * f;
        if (rayY > App.heightAt(x, z)) lo = f; else hi = f;
      }
      const f = (lo + hi) * 0.5;
      return [cam.x + cy * f - sn * (rOverF * f), cam.z + sn * f + cy * (rOverF * f)];
    },

    /* ------------------------------------------------------------- paint */

    draw(App, Play) {
      const t0 = performance.now();
      const cv = this.cv, g = this.ctx;
      const W = cv.width, H = cv.height;
      const cam = this.camera(App, Play);
      const F = App.field;
      if (!F) return;

      const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
      const focal = (H * 0.5) / Math.tan(this.fov * 0.5);
      const horizon = H * 0.5 - focal * Math.tan(cam.pitch);
      // one column of margin past the edge, so the outermost quad is complete
      this.fan(Math.atan((W * 0.5) / focal) * 1.06);

      /* Sun: the same direction the WebGL build computes, so the shading of a
         slope agrees between the two views. */
      const sun = App.sunDir ? App.sunDir() : [0.4, 0.7, 0.3];

      // the direction the mower ran, i.e. the line of the hole
      const tee = App.teePos(), pin0 = App.pinPos();
      const al = Math.hypot(pin0[0] - tee[0], pin0[2] - tee[2]) || 1;
      this._ax = (pin0[0] - tee[0]) / al;
      this._az = (pin0[2] - tee[2]) / al;
      this._yaw = cam.yaw; this._focal = focal;

      this.sky(g, W, H, horizon, sun);

      /* Project one ground sample. Returns null behind the camera. */
      const px = [], py = [], pv = [];
      const project = (wx, wy, wz) => {
        const dx = wx - cam.x, dz = wz - cam.z;
        // into camera space: forward is +f, right is +r
        const f = dx * cy + dz * sy;
        const r = -dx * sy + dz * cy;
        if (f < 0.35) return false;
        const dy = wy - cam.y;
        const sx = W * 0.5 + focal * (r / f);
        const sv = horizon - focal * (dy / f) - focal * cam.pitch * 0;
        px.push(sx); py.push(sv); pv.push(f);
        return true;
      };

      /* Trees, bucketed by distance so they interleave with the ground rows
         rather than all being drawn on top of it. */
      const buckets = this.treeBuckets(App, cam, cy, sy);

      /* ------------------------------------------------- ground, far to near */
      let prev = null;
      for (let i = this.ROWS - 1; i >= 0; i--) {
        const d = this.dist[i];
        const row = new Array(this.COLS);
        for (let j = 0; j < this.COLS; j++) {
          const a = this.ang[j];
          // a fan in camera space: forward d, lateral d*tan(a)
          const lf = d, lr = d * Math.tan(a);
          const wx = cam.x + cy * lf - sy * lr;
          const wz = cam.z + sy * lf + cy * lr;
          const inside = F.contains(wx, wz, 1);
          const wy = inside ? F.height(wx, wz) : App.worldField.height(wx, wz);
          const dx = wx - cam.x, dz = wz - cam.z;
          const ff = dx * cy + dz * sy;
          const rr = -dx * sy + dz * cy;
          row[j] = ff < 0.35 ? null : {
            x: W * 0.5 + focal * (rr / ff),
            y: horizon - focal * ((wy - cam.y) / ff),
            wx: wx, wz: wz, wy: wy, d: ff
          };
        }

        if (prev) {
          let lastCol = null;
          for (let j = 0; j < this.COLS - 1; j++) {
            const a = row[j], b = row[j + 1], c = prev[j + 1], e = prev[j];
            if (!a || !b || !c || !e) continue;
            // skip anything that has collapsed to nothing on screen
            if (Math.abs(b.x - a.x) < 0.35 && Math.abs(e.y - a.y) < 0.35) continue;
            /* Shade every other column and reuse it for its neighbour. Two
               adjacent quads in the same row differ by a fraction of a degree
               of view angle; the colour difference is below what the eye picks
               out of a gradient, and the saving is half the shading in the
               frame. */
            let col;
            if ((j & 1) === 0 || !lastCol) {
              const mx = (a.wx + b.wx) * 0.5, mz = (a.wz + b.wz) * 0.5;
              col = lastCol = this.shade(F, App, mx, mz, a.wy, sun, a.d);
            } else {
              col = lastCol;
            }
            g.fillStyle = col;
            g.beginPath();
            g.moveTo(a.x, a.y); g.lineTo(b.x, b.y);
            g.lineTo(c.x, c.y); g.lineTo(e.x, e.y);
            g.closePath();
            g.fill();
            /* Canvas antialiases the edge of every fill, so two quads sharing an
               edge leave a hairline of whatever was underneath between them — a
               grid of pale seams across the whole ground. Stroking each quad in
               its own colour covers its half of that seam. */
            g.strokeStyle = col;
            g.lineWidth = 1;
            g.stroke();
          }
        }
        prev = row;

        // trees that live between this row and the next one in
        const bucket = buckets[i];
        if (bucket) for (const t of bucket) this.tree(g, t, cam, cy, sy, focal, W, horizon, sun);
      }

      this.overlay(g, App, Play, cam, cy, sy, focal, W, H, horizon);
      if (this.mode === 'fly') {
        this.flyT += 0.0042;
        if (this.flyT >= 1) { this.flyT = 1; this.stopFly(); }
      }
      this.pace(performance.now() - t0);
    },

    /** Sky: a plain vertical ramp, warmed toward the sun. */
    sky(g, W, H, horizon, sun) {
      const top = Math.max(0, Math.min(H, horizon));
      const grad = g.createLinearGradient(0, 0, 0, Math.max(2, top));
      const warm = clamp(sun[1], 0, 1);
      grad.addColorStop(0, 'rgb(' + Math.round(96 + warm * 20) + ',' +
                              Math.round(140 + warm * 20) + ',' +
                              Math.round(196 + warm * 14) + ')');
      grad.addColorStop(1, 'rgb(' + Math.round(186 + warm * 24) + ',' +
                              Math.round(206 + warm * 18) + ',' +
                              Math.round(222 + warm * 10) + ')');
      g.fillStyle = grad;
      g.fillRect(0, 0, W, Math.max(0, top));

      /* The sun, where the solar position puts it. A sky with a light in it
         reads as outdoors; a gradient reads as a backdrop. */
      if (sun[1] > -0.05 && this._focal) {
        let d = Math.atan2(sun[2], sun[0]) - this._yaw;
        while (d > Math.PI) d -= 6.2832;
        while (d < -Math.PI) d += 6.2832;
        if (Math.abs(d) < 1.1) {
          const sx = W * 0.5 + Math.tan(d) * this._focal;
          const sy2 = top - this._focal * (sun[1] / Math.max(0.25, Math.hypot(sun[0], sun[2])));
          const rr = Math.max(34, W * 0.10);
          const gl = g.createRadialGradient(sx, sy2, 0, sx, sy2, rr);
          gl.addColorStop(0, 'rgba(255,251,228,0.9)');
          gl.addColorStop(0.22, 'rgba(255,247,212,0.32)');
          gl.addColorStop(1, 'rgba(255,245,206,0)');
          g.fillStyle = gl;
          g.fillRect(sx - rr, sy2 - rr, rr * 2, rr * 2);
        }
      }
      /* A few soft clouds. Placed by world azimuth so they stay put relative to
         the course when the camera turns, rather than sliding with it. */
      if (this._focal) {
        for (let i = 0; i < 7; i++) {
          const az = i * 0.897 + 0.4;
          let d = az - this._yaw;
          while (d > Math.PI) d -= 6.2832;
          while (d < -Math.PI) d += 6.2832;
          if (Math.abs(d) > 1.0) continue;
          const cx = W * 0.5 + Math.tan(d) * this._focal;
          const cyy = top * (0.14 + hash2(i, 3) * 0.42);
          const cw = W * (0.10 + hash2(i, 7) * 0.13);
          const ch = cw * 0.20;
          g.fillStyle = 'rgba(255,255,255,' + (0.30 + hash2(i, 11) * 0.26).toFixed(2) + ')';
          g.beginPath();
          g.ellipse(cx, cyy, cw, ch, 0, 0, 6.2832);
          g.ellipse(cx + cw * 0.5, cyy + ch * 0.35, cw * 0.6, ch * 0.75, 0, 0, 6.2832);
          g.ellipse(cx - cw * 0.55, cyy + ch * 0.30, cw * 0.5, ch * 0.7, 0, 0, 6.2832);
          g.fill();
        }
      }

      // haze band so the ground does not meet the sky on a hard line
      g.fillStyle = 'rgba(196,206,198,0.55)';
      g.fillRect(0, Math.max(0, top - 6), W, 12);
      g.fillStyle = '#8fa08a';
      g.fillRect(0, Math.max(0, top), W, H - Math.max(0, top));
    },

    /**
     * Colour one patch of ground: its surface, lit by the sun off the local
     * slope, then faded into the haze with distance. The slope comes from the
     * same height field the ball rolls on, so a hill that breaks a putt is a
     * hill you can see.
     */
    shade(F, App, x, z, y, sun, dist) {
      const inside = F.contains(x, z, 3);
      let r, g, b, mown = 0;

      /* Far ground gets the cheap answer. The blend below is seven distance-field
         lookups and a noise octave; spending that on a quad three pixels tall is
         most of a frame for none of the picture. */
      if (inside && dist > 60) {
        const b0 = SURF[F.surfaceAt(x, z)] || SURF.rough;
        const e0 = 3.0;
        const h0 = F.height(x + e0, z) - y, h1 = F.height(x, z + e0) - y;
        const nx0 = -h0 / e0, nz0 = -h1 / e0;
        const iv = 1 / Math.sqrt(nx0 * nx0 + nz0 * nz0 + 1);
        const l0 = clamp(0.55 + (nx0 * sun[0] + nz0 * sun[2] + sun[1]) * iv * 0.62, 0.42, 1.28);
        const f0 = clamp((dist - 60) / 320, 0, 0.72);
        return 'rgb(' + ((b0[0] * l0 * (1 - f0) + 196 * f0) | 0) + ',' +
                        ((b0[1] * l0 * (1 - f0) + 206 * f0) | 0) + ',' +
                        ((b0[2] * l0 * (1 - f0) + 198 * f0) | 0) + ')';
      }

      if (inside) {
        /* Blend the surfaces instead of picking one.
         *
         * surfaceAt() answers a yes/no question, and one answer per quad turns
         * every boundary on the course into a staircase — which is most of what
         * looked wrong about the grass. The distance fields it is built from are
         * continuous, so read those directly and cross-fade over about a metre
         * and a half: wider than a quad, so the transition is a gradient spread
         * across several of them rather than a hard step inside one.
         */
        const S = (arr, ax, az) => F.sample(arr, ax, az);
        const w = d => clamp(0.5 - d / 3.0, 0, 1);      // 1 inside, 0 well outside
        r = SURF.rough[0]; g = SURF.rough[1]; b = SURF.rough[2];
        const lay = (c, k) => {
          if (k <= 0.001) return;
          r += (c[0] - r) * k; g += (c[1] - g) * k; b += (c[2] - b) * k;
        };
        const wN = w(-S(F.sdfCo, x, z));                // outside the corridor
        lay(SURF.native, wN);
        const wF = w(S(F.sdfFw, x, z)), wT = w(S(F.sdfTe, x, z));
        const wG = w(S(F.sdfGr, x, z));
        lay(SURF.fairway, Math.max(wF, wT));
        lay(SURF.fringe, w(S(F.sdfGr, x, z) - 1.1));
        lay(SURF.green, wG);
        lay(SURF.path, w(S(F.sdfPa, x, z)));
        const wS = w(S(F.sdfSa, x, z));
        lay(SURF.sand, wS);
        const wW = w(S(F.sdfWa, x, z));
        lay(SURF.water, wW);
        mown = Math.max(wF, wT, wG) * (1 - Math.max(wS, wW));
        this._wet = wW;
      } else {
        const n = SURF.native;
        r = n[0]; g = n[1]; b = n[2];
        this._wet = 0;
      }
      const wet = this._wet;

      const e = 2.2;
      const src = inside ? F : App.worldField;
      const hx = src.height(x + e, z) - y;
      const hz = src.height(x, z + e) - y;
      // unnormalised normal is enough for a lambert term at this fidelity
      const nx = -hx / e, nz = -hz / e;
      const inv = 1 / Math.sqrt(nx * nx + nz * nz + 1);
      let lit = (nx * sun[0] + nz * sun[2] + sun[1]) * inv;
      lit = clamp(0.55 + lit * 0.62, 0.42, 1.28);

      /* Mowing stripes, along the line the hole is played. Real turf on a
         mown surface is striped, and it is the cue that reads as "cut". */
      if (mown > 0.02 && this._ax !== undefined) {
        lit *= 1 + Math.sin((x * this._ax + z * this._az) / 5.2) * 0.055 * mown;
      }

      /* Turf grain: one fine octave only, and faded out with distance so it
         reads as texture close up and never as blotches further out. The last
         attempt at this used a six-metre octave and gave the fairway a case of
         camouflage. */
      const near = 1 - clamp((dist - 8) / 55, 0, 1);
      if (near > 0.01 && wet < 0.5) {
        lit *= 1 + (vnoise(x * 1.9, z * 1.9) - 0.5) * 0.085 * near * (1 - wet);
      }

      if (wet > 0.05) {
        // water is a mirror, not a slope: flatten its lighting and add sky
        lit = lit * (1 - wet) + wet;
        const sk = 150 + 55 * (0.5 + 0.5 * Math.sin(x * 0.9 + z * 1.3));
        r += (sk * 0.62 - r) * wet * 0.45;
        g += (sk * 0.86 - g) * wet * 0.45;
        b += (sk * 1.10 - b) * wet * 0.45;
      }

      const fog = clamp((dist - 60) / 320, 0, 0.72);
      const R = r * lit * (1 - fog) + 196 * fog;
      const G = g * lit * (1 - fog) + 206 * fog;
      const B = b * lit * (1 - fog) + 198 * fog;
      return 'rgb(' + (R | 0) + ',' + (G | 0) + ',' + (B | 0) + ')';
    },

    /* --------------------------------------------------------------- trees */

    /** Sort the visible trees into the ground row they stand in. */
    treeBuckets(App, cam, cy, sy) {
      const out = [];
      const trees = App.trees;
      if (!trees) return out;
      const maxD = this.FAR;
      for (let i = 0; i < trees.length; i++) {
        const t = trees[i];
        const dx = t.x - cam.x, dz = t.z - cam.z;
        if (dx * dx + dz * dz > maxD * maxD) continue;
        const f = dx * cy + dz * sy;
        if (f < 2) continue;
        const r = -dx * sy + dz * cy;
        if (Math.abs(r) > f * 1.5 + 30) continue;     // outside the fan
        // which row does it belong to
        let lo = 0, hi = this.dist.length - 1, row = 0;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (this.dist[mid] < f) { row = mid; lo = mid + 1; } else hi = mid - 1;
        }
        (out[row] || (out[row] = [])).push(t);
      }
      // within a row, far ones first
      for (const b of out) {
        if (b) b.sort((a, c) => {
          const fa = (a.x - cam.x) * cy + (a.z - cam.z) * sy;
          const fc = (c.x - cam.x) * cy + (c.z - cam.z) * sy;
          return fc - fa;
        });
      }
      return out;
    },

    /** One tree: a trunk and two overlapping canopy blobs. Cheap, and at this
        scale a crown is a silhouette rather than a collection of leaves. */
    tree(g, t, cam, cy, sy, focal, W, horizon, sun) {
      const dx = t.x - cam.x, dz = t.z - cam.z;
      const f = dx * cy + dz * sy;
      if (f < 2) return;
      const r = -dx * sy + dz * cy;
      const sx = W * 0.5 + focal * (r / f);
      const baseY = horizon - focal * ((t.y - cam.y) / f);
      const h = t.scale * (t.hScale || 1);
      const topY = horizon - focal * ((t.y + h - cam.y) / f);
      const ph = baseY - topY;
      if (ph < 1.5) return;
      const crownW = ph * 0.52;
      const fog = clamp((f - 60) / 320, 0, 0.72);
      const col = TREE[t.arch % 4];
      const lit = 0.86 + clamp(sun[1], 0, 1) * 0.3;
      const mix = (c, i) => Math.round(c * lit * (1 - fog) + [196, 206, 198][i] * fog);

      g.fillStyle = 'rgb(' + Math.round(62 * (1 - fog) + 196 * fog) + ',' +
                             Math.round(52 * (1 - fog) + 206 * fog) + ',' +
                             Math.round(44 * (1 - fog) + 198 * fog) + ')';
      const tw = Math.max(1, ph * 0.055);
      g.fillRect(sx - tw * 0.5, baseY - ph * 0.42, tw, ph * 0.42);

      const side = Math.sign(sun[0] * cy + sun[2] * sy || 1);
      const blob = (up, off, w, hh, k) => {
        g.fillStyle = 'rgb(' + mix(col[0] * k, 0) + ',' + mix(col[1] * k, 1) +
                      ',' + mix(col[2] * k, 2) + ')';
        g.beginPath();
        g.ellipse(sx + crownW * off, baseY - ph * up, crownW * w, ph * hh, 0, 0, 6.2832);
        g.fill();
      };

      if (t.arch === 3) {
        /* Spruce: stacked skirts. One archetype that is not a ball is what
           stops a tree line reading as a row of lollipops. */
        for (let k = 0; k < 4; k++) {
          const f0 = 0.30 + k * 0.185;
          const wk = crownW * (1.12 - k * 0.21);
          g.fillStyle = 'rgb(' + mix(col[0] * (0.84 + k * 0.10), 0) + ',' +
                                 mix(col[1] * (0.84 + k * 0.10), 1) + ',' +
                                 mix(col[2] * (0.84 + k * 0.10), 2) + ')';
          g.beginPath();
          g.moveTo(sx - wk, baseY - ph * f0);
          g.lineTo(sx + wk, baseY - ph * f0);
          g.lineTo(sx, baseY - ph * (f0 + 0.30));
          g.closePath();
          g.fill();
        }
      } else {
        blob(0.56, -side * 0.12, 0.94, 0.30, 0.78);   // shaded underside
        blob(0.66, 0, 1.0, 0.34, 1.0);
        blob(0.74, side * 0.24, 0.74, 0.29, 1.14);
        if (ph > 14) blob(0.84, -side * 0.26, 0.56, 0.24, 0.9);
        if (ph > 26) {
          blob(0.68, side * 0.54, 0.30, 0.15, 1.2);
          blob(0.78, -side * 0.56, 0.26, 0.13, 0.86);
        }
      }
    },

    /* -------------------------------------------------- ball, flag, tracer */

    /* Exaggeration for the cup, in metres. The real thing is 0.108. */
    CUP_R: 0.42,

    overlay(g, App, Play, cam, cy, sy, focal, W, H, horizon) {
      const to = (wx, wy, wz) => {
        const dx = wx - cam.x, dz = wz - cam.z;
        const f = dx * cy + dz * sy;
        if (f < 0.4) return null;
        const r = -dx * sy + dz * cy;
        return { x: W * 0.5 + focal * (r / f), y: horizon - focal * ((wy - cam.y) / f), d: f };
      };

      /* Yardage arcs. Every golf broadcast and every course guide draws these
         because distance down an open fairway is impossible to judge by eye —
         and in a rendered view there is not even a bag or a caddie to judge it
         against. Drawn on the ground, so they sit in the perspective. */
      if (Play && Play.state.phase !== 'flying' && !Play.isPutting()) {
        const b0 = App.ballPos || App.teePos();
        const aim0 = Play.aim;
        const toPin = Play.toPin ? Play.toPin() : 999;
        g.font = '600 11px ui-sans-serif, system-ui, sans-serif';
        g.textAlign = 'center';
        let lastLabelY = 1e9;
        for (const yd of [100, 150, 200, 250, 300]) {
          const m = yd * 0.9144;
          if (m > toPin + 30) continue;
          g.strokeStyle = 'rgba(255,255,255,.24)';
          g.lineWidth = 1.2;
          g.beginPath();
          let on = false, mid = null;
          for (let k = -7; k <= 7; k++) {
            const a = aim0 + k * 0.055;
            const wx = b0[0] + Math.cos(a) * m, wz = b0[2] + Math.sin(a) * m;
            const q = to(wx, App.heightAt(wx, wz) + 0.06, wz);
            if (!q) { on = false; continue; }
            if (!on) { g.moveTo(q.x, q.y); on = true; } else g.lineTo(q.x, q.y);
            if (k === 0) mid = q;
          }
          g.stroke();
          /* Label it only if it is far enough down the screen from the last
             one. Near the horizon every remaining arc lands within a few
             pixels of the others and the numbers print on top of each other. */
          if (mid && mid.d > 12 && mid.y < H - 26 && lastLabelY - mid.y > 16) {
            lastLabelY = mid.y;
            g.fillStyle = 'rgba(0,0,0,.45)';
            g.fillText(yd, mid.x + 1, mid.y - 5);
            g.fillStyle = 'rgba(255,255,255,.72)';
            g.fillText(yd, mid.x, mid.y - 6);
          }
        }
        g.textAlign = 'left';
      }

      /* Landing zones, projected onto the ground. The same Monte Carlo the hole
         map draws, put where the shots would actually finish, so the spread is
         something you look down the fairway at rather than something you have to
         switch views to read. */
      if (Play && Play.state.phase === 'idle' && this.zones !== false &&
          Play.allPatterns && !Play.isPutting()) {
        const cols = { tour: '#e0a83c', low: '#7fc7e8', mid: '#8fd07a', senior: '#d08fc0' };
        const pats = Play.allPatterns(34);
        g.globalAlpha = 0.5;
        for (const pat of pats) {
          g.fillStyle = cols[pat.profile] || '#999';
          for (const sh of pat.shots) {
            const q = to(sh.x, App.heightAt(sh.x, sh.z) + 0.05, sh.z);
            if (!q) continue;
            const rr = clamp(150 / q.d, 1.2, 7);
            g.beginPath(); g.ellipse(q.x, q.y, rr, rr * 0.45, 0, 0, 6.2832); g.fill();
          }
        }
        g.globalAlpha = 1;
      }

      /* The cup, drawn several times its real size.
         A hole is 108 mm across: at any distance you would actually putt from
         it is a pixel, and a ball vanishing into a pixel does not read as holing
         out. Exaggerating it is the difference between seeing the putt drop and
         being told about it afterwards. */
      const pin = App.pinPos();
      const cq = to(pin[0], pin[1] + 0.01, pin[2]);
      if (cq) {
        const cr = Math.max(2.5, (this.CUP_R * this._focal) / cq.d);
        g.fillStyle = 'rgba(236,238,230,.85)';
        g.beginPath(); g.ellipse(cq.x, cq.y, cr * 1.22, cr * 0.52, 0, 0, 6.2832); g.fill();
        g.fillStyle = '#15100a';
        g.beginPath(); g.ellipse(cq.x, cq.y, cr, cr * 0.42, 0, 0, 6.2832); g.fill();
      }
      const p0 = to(pin[0], pin[1], pin[2]);
      const p1 = to(pin[0], pin[1] + 2.4, pin[2]);
      if (p0 && p1) {
        g.strokeStyle = '#f4f4ee';
        g.lineWidth = Math.max(1, 90 / p0.d);
        g.beginPath(); g.moveTo(p0.x, p0.y); g.lineTo(p1.x, p1.y); g.stroke();
        const fw = Math.max(3, 150 / p0.d);
        g.fillStyle = '#d8443a';
        g.beginPath();
        g.moveTo(p1.x, p1.y); g.lineTo(p1.x + fw, p1.y + fw * 0.42);
        g.lineTo(p1.x, p1.y + fw * 0.84); g.closePath(); g.fill();
      }

      // the aim line, while the ball is at rest
      const ball = App.ballPos || App.teePos();
      if (Play && Play.state.phase !== 'flying') {
        const aim = Play.aim;
        const reach = Play.isPutting ? (Play.isPutting() ? 6 : Play.aimDistance()) : 150;
        const t1 = to(ball[0] + Math.cos(aim) * reach, ball[1], ball[2] + Math.sin(aim) * reach);
        const t0 = to(ball[0], ball[1] + 0.02, ball[2]);
        if (t0 && t1) {
          g.save();
          g.setLineDash([7, 6]);
          g.strokeStyle = 'rgba(245,232,190,.8)';
          g.lineWidth = 1.6;
          g.beginPath(); g.moveTo(t0.x, t0.y); g.lineTo(t1.x, t1.y); g.stroke();
          g.restore();
        }
      }

      // the shot, as far as it has flown
      const pts = App.tracerPts;
      if (pts && App.shotAnim > 0) {
        const upto = clamp(Math.floor(App.shotAnim * (pts.length - 1)), 1, pts.length - 1);
        g.strokeStyle = 'rgba(255,240,200,.9)';
        g.lineWidth = 2;
        g.beginPath();
        let started = false;
        for (let i = 0; i <= upto; i++) {
          const q = to(pts[i][0], pts[i][1], pts[i][2]);
          if (!q) { started = false; continue; }
          if (!started) { g.moveTo(q.x, q.y); started = true; } else g.lineTo(q.x, q.y);
        }
        g.stroke();
      }

      // the ball, with the patch of shadow under it
      const bq = to(ball[0], ball[1] + 0.021, ball[2]);
      if (bq) {
        const gy = App.heightAt(ball[0], ball[2]);
        const gq = to(ball[0], gy, ball[2]);
        const rad = Math.max(1.4, 90 / bq.d);
        if (gq) {
          g.fillStyle = 'rgba(0,0,0,.30)';
          g.beginPath();
          g.ellipse(gq.x, gq.y, rad * 1.5, rad * 0.6, 0, 0, 6.2832);
          g.fill();
        }
        g.fillStyle = '#fff';
        g.strokeStyle = 'rgba(0,0,0,.5)';
        g.lineWidth = 1;
        g.beginPath(); g.arc(bq.x, bq.y, rad, 0, 6.2832); g.fill(); g.stroke();
      }

      /* A vignette. Nothing physical about it, but every camera has one and its
         absence is part of why a flat-shaded frame reads as a diagram. */
      if (!this._vig || this._vigW !== W || this._vigH !== H) {
        this._vigW = W; this._vigH = H;
        const off = document.createElement('canvas');
        off.width = W; off.height = H;
        const og = off.getContext('2d');
        const vg = og.createRadialGradient(W * 0.5, H * 0.52, Math.min(W, H) * 0.44,
                                           W * 0.5, H * 0.52, Math.max(W, H) * 0.80);
        vg.addColorStop(0, 'rgba(0,0,0,0)');
        vg.addColorStop(0.7, 'rgba(0,0,0,0.03)');
        vg.addColorStop(1, 'rgba(0,0,0,0.14)');
        og.fillStyle = vg;
        og.fillRect(0, 0, W, H);
        this._vig = off;
      }
      g.drawImage(this._vig, 0, 0);

      if (Play && Play.state.holed) {
        const n = Play.state.stroke;
        const par = App.holeData.par;
        const names = { '-3': 'Albatross', '-2': 'Eagle', '-1': 'Birdie',
                        '0': 'Par', '1': 'Bogey', '2': 'Double bogey' };
        const label = n === 1 ? 'Hole in one!' : (names[String(n - par)] || (n - par) + ' over');
        g.textAlign = 'center';
        g.font = '600 30px ui-sans-serif, system-ui, sans-serif';
        g.fillStyle = 'rgba(0,0,0,.45)';
        g.fillText(label, W * 0.5 + 2, H * 0.30 + 2);
        g.fillStyle = '#f0d878';
        g.fillText(label, W * 0.5, H * 0.30);
        g.font = '400 15px ui-sans-serif, system-ui, sans-serif';
        g.fillStyle = 'rgba(255,255,255,.85)';
        g.fillText('in ' + n + ' — walking to the next tee', W * 0.5, H * 0.30 + 26);
        g.textAlign = 'left';
      }
    }
  };

  root.Soft3D = Soft3D;
})(window);
