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
    tee: [122, 168, 92], rough: [74, 114, 58], native: [156, 146, 92],
    cut: [100, 146, 76],
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

  /**
   * Fill one triangle into a 32-bit pixel buffer, interpolating the colour
   * across it. Colours are packed 0xBBGGRR; alpha is set opaque. Pixels are
   * sampled at their centres, and anything thinner than a pixel is splatted
   * as its average colour instead, so the rows near the horizon — dozens of
   * them inside a few pixels — do not drop out and leave holes.
   */
  function tri(buf, W, H, ax, ay, ac, bx, by, bc, cx, cy, cc) {
    let x0 = Math.floor(Math.min(ax, bx, cx)), x1 = Math.ceil(Math.max(ax, bx, cx));
    let y0 = Math.floor(Math.min(ay, by, cy)), y1 = Math.ceil(Math.max(ay, by, cy));
    if (x1 < 0 || y1 < 0 || x0 >= W || y0 >= H) return;
    const ar = ac & 255, ag = (ac >> 8) & 255, ab = (ac >> 16) & 255;
    const br = bc & 255, bg = (bc >> 8) & 255, bb = (bc >> 16) & 255;
    const cr = cc & 255, cg = (cc >> 8) & 255, cb = (cc >> 16) & 255;
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (y1 - y0 <= 1 || x1 - x0 <= 1 || Math.abs(area) < 0.5) {
      const r = (ar + br + cr) / 3 | 0, g = (ag + bg + cg) / 3 | 0, b = (ab + bb + cb) / 3 | 0;
      const v = 0xff000000 | (b << 16) | (g << 8) | r;
      const yy = Math.max(0, Math.min(H - 1, Math.round((ay + by + cy) / 3 - 0.5)));
      for (let x = Math.max(0, x0); x <= Math.min(W - 1, x1 - 1); x++) buf[yy * W + x] = v;
      if (x1 - x0 < 1) {
        const xx = Math.max(0, Math.min(W - 1, Math.round((ax + bx + cx) / 3 - 0.5)));
        buf[yy * W + xx] = v;
      }
      return;
    }
    if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0;
    if (x1 > W) x1 = W; if (y1 > H) y1 = H;
    const inv = 1 / area, e = -0.02;
    for (let y = y0; y < y1; y++) {
      const py = y + 0.5;
      let o = y * W + x0;
      for (let x = x0; x < x1; x++, o++) {
        const px = x + 0.5;
        const wa = ((bx - px) * (cy - py) - (by - py) * (cx - px)) * inv;
        if (wa < e) continue;
        const wb = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) * inv;
        if (wb < e) continue;
        const wc = 1 - wa - wb;
        if (wc < e) continue;
        const r = ar * wa + br * wb + cr * wc;
        const g = ag * wa + bg * wb + cg * wc;
        const b = ab * wa + bb * wb + cb * wc;
        buf[o] = 0xff000000 | ((b < 0 ? 0 : b > 255 ? 255 : b) << 16) |
                 ((g < 0 ? 0 : g > 255 ? 255 : g) << 8) | (r < 0 ? 0 : r > 255 ? 255 : r);
      }
    }
  }

  /* Canopy tints per archetype, roughly the leaf colours the 3D build uses. */
  const TREE = [[74, 104, 52], [92, 124, 62], [108, 140, 70], [58, 92, 62]];

  const Soft3D = {
    /* Rows: how far the ground is drawn and at what spacing. NEAR is the first
       row's distance, FAR the last, and the ratio between consecutive rows is
       constant, which is what keeps screen-space density even. */
    ROWS: 64,
    COLS: 88,
    NEAR: 1.5,
    FAR: 340,
    fov: 52 * Math.PI / 180,

    /* Grid sizes to fall back and forth between. Every machine this runs on is
       one that could not give us a GPU, so "fast enough" is not a safe
       assumption to make once and forget. */
    STEPS: [[44, 60], [54, 74], [64, 88], [74, 104]],
    stepIx: 2,

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
    scaleIx: 3,
    renderScale: 1.0,

    /* The band of the canvas that is not under the HUD, in backing pixels.
       Set by the page on resize. The ball is placed inside this band rather
       than at a fixed fraction of the canvas, because on a phone the action bar
       covers the bottom quarter of the screen — exactly where a camera behind
       the ball puts the ball. */
    viewTop: 0,
    viewBottom: 0,

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
      this.dist = null;
      this.buildRows(this._near);
    },

    buildRows(near) {
      near = near || this.NEAR;
      if (this.dist && this._near === near && this.dist.length === this.ROWS) return;
      this._near = near;
      const k = Math.pow(this.FAR / near, 1 / (this.ROWS - 1));
      this.dist = [];
      for (let i = 0, d = near; i < this.ROWS; i++, d *= k) this.dist.push(d);
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
      /* On the green, stand closer and lower: a putt is read from a few feet
         behind the ball, and from 5 m back a 2 m putt is a smudge. */
      const putting = Play && Play.isPutting && Play.state.active &&
                      (Play.isPutting() || (Play.pending && Play.pending.kind === 'putt'));
      const back = putting ? 3.0 : 6.0, height = putting ? 1.25 : 2.3;
      const ex = b[0] - Math.cos(aim) * back;
      const ez = b[2] - Math.sin(aim) * back;
      const ey = Math.max(App.heightAt(ex, ez) + height, b[1] + (putting ? 0.8 : 1.0));
      return { x: ex, y: ey, z: ez, yaw: aim, pitch: 0.050, ball: b };
    },

    /**
     * Focal length in backing pixels.
     *
     * The field of view is vertical, which is fine on a landscape screen and
     * wrong on a phone held upright: 52 degrees of height on a narrow screen
     * is about 25 degrees of width, a telephoto lens. Hold a minimum width
     * instead, so the fairway still fits across the screen.
     */
    focalFor(W, H) {
      const f = (H * 0.5) / Math.tan(this.fov * 0.5);
      return Math.min(f, (W * 0.5) / Math.tan(this.hfovMin * 0.5));
    },
    hfovMin: 46 * Math.PI / 180,

    /**
     * Where the horizon goes this frame.
     *
     * For the play camera this is solved backwards from the ball: pick the
     * screen row the ball should sit on — most of the way down the band the
     * HUD leaves clear — and put the horizon wherever that requires. A fixed
     * pitch put the ball under the action bar on a phone, and on a sloping
     * green it wandered off the screen entirely. Eased, so a shot taking off
     * does not snap the view.
     */
    horizonFor(cam, focal, W, H) {
      if (!cam.ball) {
        this._hz = null; this.settling = false;
        return H * 0.5 - focal * Math.tan(cam.pitch || 0);
      }
      const top = this.viewTop || 0;
      const bot = this.viewBottom || H;
      const want = top + (bot - top) * 0.80;
      const b = cam.ball;
      const dx = b[0] - cam.x, dz = b[2] - cam.z;
      const f = Math.max(0.5, dx * Math.cos(cam.yaw) + dz * Math.sin(cam.yaw));
      let hz = want + focal * ((b[1] - cam.y) / f);
      // never let the sky take more than about half the clear band
      hz = clamp(hz, top + (bot - top) * 0.12, top + (bot - top) * 0.55);
      if (this._hz == null || Math.abs(this._hz - hz) > H) this._hz = hz;
      else this._hz += (hz - this._hz) * 0.3;
      this.settling = Math.abs(this._hz - hz) > 0.5;
      return this._hz;
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
      const cam = this._cam || this.camera(App, Play);
      const focal = this._focal || this.focalFor(W, H);
      const horizon = this._horizon != null ? this._horizon : H * 0.5;
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

    /**
     * The ground is painted into a smaller canvas and stretched over the
     * frame.
     *
     * Every quad of ground is one flat colour, and at full resolution the
     * steps between neighbouring quads show as a grid of blocks — worst on the
     * grass right in front of the ball, which is where you look. Painted at a
     * fraction of the size, each quad is two or three pixels, and the bilinear
     * stretch turns the steps into gradients: the colour of the turf is the
     * same, the blocks are gone. It is also less than a fifth of the pixels to
     * fill, which on a phone is most of the frame time.
     *
     * Trees, the flag, the ball and everything drawn over the course stay at
     * full resolution, on top.
     */
    GROUND_SCALE: 0.5,

    groundCtx(W, H) {
      const k = this.GROUND_SCALE;
      const w = Math.max(2, Math.round(W * k)), h = Math.max(2, Math.round(H * k));
      if (!this._gcv) {
        this._gcv = document.createElement('canvas');
        this._gctx = this._gcv.getContext('2d');
      }
      if (this._gcv.width !== w || this._gcv.height !== h) {
        this._gcv.width = w; this._gcv.height = h;
      }
      // draw in full-frame coordinates; the transform does the shrinking
      this._gctx.setTransform(w / W, 0, 0, h / H, 0, 0);
      return this._gctx;
    },

    draw(App, Play) {
      const t0 = performance.now();
      const cv = this.cv, gm = this.ctx;
      const W = cv.width, H = cv.height;
      const g = this.groundCtx(W, H);
      const cam = this.camera(App, Play);
      const F = App.field;
      if (!F) return;

      const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
      const focal = this.focalFor(W, H);
      const horizon = this.horizonFor(cam, focal, W, H);
      this._cam = cam; this._horizon = horizon;
      // one column of margin past the edge, so the outermost quad is complete
      this.fan(Math.atan((W * 0.5) / focal) * 1.06);
      /* Start the rows at the bottom edge of the frame, not at a fixed metre and
         a half. Rows are spaced geometrically, so every row spent on ground
         behind the bottom of the screen is a row taken from the ground that is
         on it — from the camera behind the ball that was a fifth of them. */
      if (cam.ball) {
        const drop = cam.y - App.heightAt(cam.x, cam.z);
        const below = H - horizon;
        const dBottom = below > 4 ? focal * drop / below : this.NEAR;
        this.buildRows(clamp(Math.round(dBottom * 0.85 * 4) / 4, 0.8, 80));
      } else {
        this.buildRows(this.NEAR);
      }

      /* Sun: the same direction the WebGL build computes, so the shading of a
         slope agrees between the two views. */
      const sun = App.sunDir ? App.sunDir() : [0.4, 0.7, 0.3];
      this.shadowMap(App, sun);

      // the direction the mower ran, i.e. the line of the hole
      const tee = App.teePos(), pin0 = App.pinPos();
      const al = Math.hypot(pin0[0] - tee[0], pin0[2] - tee[2]) || 1;
      this._ax = (pin0[0] - tee[0]) / al;
      this._az = (pin0[2] - tee[2]) / al;
      this._yaw = cam.yaw; this._focal = focal;

      this.sky(gm, W, H, horizon, sun);

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

      /* The cup goes in the same depth order as everything else, so a rise in
         the green between the ball and the hole hides it, as it would. */
      const to = (wx, wy, wz) => {
        const dx = wx - cam.x, dz = wz - cam.z;
        const f = dx * cy + dz * sy;
        if (f < 0.25) return null;
        const r = -dx * sy + dz * cy;
        return { x: W * 0.5 + focal * (r / f), y: horizon - focal * ((wy - cam.y) / f), d: f };
      };
      const pin = App.pinPos();
      const pf = (pin[0] - cam.x) * cy + (pin[2] - cam.z) * sy;
      let pinRow = -2;
      if (pf > 0.25 && pf < this.FAR) {
        pinRow = -1;
        for (let i = 0; i < this.ROWS; i++) if (this.dist[i] < pf) pinRow = i;
      }

      /* ------------------------------------------------- ground, far to near
       *
       * Shaded at the vertices and filled by hand, not by the canvas.
       *
       * Filling quads through the canvas API paints each one a single flat
       * colour, which shows as a grid of blocks however fine the grid, and the
       * path calls cost more than the shading did. So each grid point gets its
       * colour, and the triangles between them are rasterised straight into a
       * pixel buffer with the colour interpolated across them — Gouraud
       * shading, the way every 3D card did it in 1998. The grass is a gradient
       * between samples instead of a step at each one, and the whole ground is
       * one putImageData.
       */
      const gw = this._gcv.width, gh = this._gcv.height;
      const kx = gw / W, ky = gh / H;
      if (!this._img || this._img.width !== gw || this._img.height !== gh) {
        this._img = g.createImageData(gw, gh);
        this._buf = new Uint32Array(this._img.data.buffer);
      }
      const buf = this._buf;
      buf.fill(0);
      const C = this.COLS;
      if (!this._rowA || this._rowA.n !== C) {
        const mk = () => ({ n: C, x: new Float32Array(C), y: new Float32Array(C),
                            c: new Int32Array(C), ok: new Uint8Array(C) });
        this._rowA = mk(); this._rowB = mk();
      }
      let row = this._rowA, prev = this._rowB, have = false;
      for (let i = this.ROWS - 1; i >= 0; i--) {
        const d = this.dist[i];
        const cheap = d >= 40;
        for (let j = 0; j < C; j++) {
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
          if (ff < 0.35) { row.ok[j] = 0; continue; }
          row.ok[j] = 1;
          row.x[j] = (W * 0.5 + focal * (rr / ff)) * kx;
          row.y[j] = (horizon - focal * ((wy - cam.y) / ff)) * ky;
          /* Far away, shade every other point and average the ones between:
             neighbouring samples there are a fraction of a pixel apart. */
          if (cheap && (j & 1) && j < C - 1) { row.c[j] = -1; continue; }
          this.shade(F, App, wx, wz, wy, sun, ff);
          row.c[j] = (this._oB << 16) | (this._oG << 8) | this._oR;
        }
        if (cheap) {
          for (let j = 1; j < C - 1; j += 2) {
            if (row.c[j] !== -1) continue;
            const p = row.c[j - 1], q = row.c[j + 1];
            row.c[j] = ((((p >> 16) & 255) + ((q >> 16) & 255)) >> 1) << 16 |
                       ((((p >> 8) & 255) + ((q >> 8) & 255)) >> 1) << 8 |
                       (((p & 255) + (q & 255)) >> 1);
          }
        }

        if (have) {
          for (let j = 0; j < C - 1; j++) {
            if (!row.ok[j] || !row.ok[j + 1] || !prev.ok[j] || !prev.ok[j + 1]) continue;
            tri(buf, gw, gh,
                row.x[j], row.y[j], row.c[j],
                row.x[j + 1], row.y[j + 1], row.c[j + 1],
                prev.x[j + 1], prev.y[j + 1], prev.c[j + 1]);
            tri(buf, gw, gh,
                row.x[j], row.y[j], row.c[j],
                prev.x[j + 1], prev.y[j + 1], prev.c[j + 1],
                prev.x[j], prev.y[j], prev.c[j]);
          }
        }
        const t = prev; prev = row; row = t; have = true;
      }
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.putImageData(this._img, 0, 0);

      gm.imageSmoothingEnabled = true;
      gm.imageSmoothingQuality = 'high';
      gm.drawImage(this._gcv, 0, 0, W, H);

      // trees and the cup, far to near, sharp
      for (let i = this.ROWS - 1; i >= -1; i--) {
        const bucket = buckets[i];
        if (bucket) for (const t of bucket) this.tree(gm, t, cam, cy, sy, focal, W, horizon, sun);
        if (i === pinRow) this.cup(gm, App, Play, to, focal);
      }

      this.overlay(gm, App, Play, cam, cy, sy, focal, W, H, horizon);
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
     * Tree shadows, baked once per hole into a one-metre grid.
     *
     * A shadow is the cheapest realism there is — a tree that does not darken
     * the grass under it looks pasted on — but working out which trees shade a
     * patch of ground, per patch, per frame, is not cheap. The sun does not
     * move during a hole, so stamp each crown's shadow into a grid once and
     * have the shading read it back with a bilinear lookup.
     */
    shadowMap(App, sun) {
      const F = App.field;
      const key = App.hole + ':' + F.x0 + ':' + sun.map(v => v.toFixed(2)).join(',');
      if (this._shKey === key) return;
      this._shKey = key;
      const N = Math.ceil(F.size), x0 = F.x0, z0 = F.z0;
      const m = new Uint8Array(N * N);
      const sy = Math.max(0.3, sun[1]);
      const ox = -sun[0] / sy, oz = -sun[2] / sy;
      for (const t of App.trees || []) {
        const h = t.scale * (t.hScale || 1);
        const hc = h * 0.62;
        const cx = t.x + ox * hc - x0, cz = t.z + oz * hc - z0;
        const r = h * 0.36;
        if (cx < -r || cz < -r || cx > N + r || cz > N + r) continue;
        const i0 = Math.max(0, Math.floor(cx - r)), i1 = Math.min(N - 1, Math.ceil(cx + r));
        const j0 = Math.max(0, Math.floor(cz - r)), j1 = Math.min(N - 1, Math.ceil(cz + r));
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            const d = Math.hypot(i - cx, j - cz) / r;
            if (d >= 1) continue;
            // dense in the middle, soft at the edge, dappled by a hash
            const v = Math.min(1, (1 - d) * 2.2) * (0.78 + hash2(i, j) * 0.22) * 255;
            const k = j * N + i;
            if (v > m[k]) m[k] = v;
          }
        }
      }
      this._sh = m; this._shN = N; this._shX = x0; this._shZ = z0;
    },

    shadowAt(x, z) {
      const m = this._sh;
      if (!m) return 0;
      const N = this._shN;
      const fx = x - this._shX - 0.5, fz = z - this._shZ - 0.5;
      const i = Math.floor(fx), j = Math.floor(fz);
      if (i < 0 || j < 0 || i >= N - 1 || j >= N - 1) return 0;
      const u = fx - i, v = fz - j, k = j * N + i;
      const a = m[k] + (m[k + 1] - m[k]) * u;
      const b = m[k + N] + (m[k + N + 1] - m[k + N]) * u;
      return (a + (b - a) * v) / 255;
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
        const l1 = l0 * (1 - this.shadowAt(x, z) * 0.36);
        this._oR = Math.min(255, (b0[0] * l1 * (1 - f0) + 196 * f0) | 0);
        this._oG = Math.min(255, (b0[1] * l1 * (1 - f0) + 206 * f0) | 0);
        this._oB = Math.min(255, (b0[2] * l1 * (1 - f0) + 198 * f0) | 0);
        return;
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
        /* Rough is not one colour. Long grass lies over in clumps that catch
           the light differently, so give it a slow, low-contrast mottle — big
           enough to read as clumps, far too big to read as grain. */
        const wR = 1 - wN;
        if (wR > 0.02 && dist < 140) {
          const cl = (vnoise(x * 0.42, z * 0.42) - 0.5) * 0.16 * wR;
          r *= 1 + cl; g *= 1 + cl * 0.8; b *= 1 + cl;
        }
        const dFw = S(F.sdfFw, x, z);
        const wF = w(dFw), wT = w(S(F.sdfTe, x, z));
        const dGr = S(F.sdfGr, x, z);
        const wG = w(dGr);
        // the first cut: a mower's width of intermediate grass around the fairway
        lay(SURF.cut, w(dFw - 2.6));
        lay(SURF.fairway, Math.max(wF, wT));
        lay(SURF.fringe, w(dGr - 1.1));
        lay(SURF.green, wG);
        lay(SURF.path, w(S(F.sdfPa, x, z)));
        const dSa = S(F.sdfSa, x, z);
        const wS = w(dSa);
        lay(SURF.sand, wS);
        const wW = w(S(F.sdfWa, x, z));
        lay(SURF.water, wW);
        mown = Math.max(wF, wT, wG) * (1 - Math.max(wS, wW));
        this._wet = wW;
        this._green = wG;
        /* A bunker is a hole with a lip, not sand paint: darken its edge, most
           on the face turned away from the sun, so it reads as sunk. */
        this._lip = wS > 0.05 ? clamp(1 + dSa / 1.6, 0, 1) * wS : 0;
      } else {
        const n = SURF.native;
        r = n[0]; g = n[1]; b = n[2];
        this._wet = 0; this._green = 0; this._lip = 0;
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
      if (mown > 0.02 && this._ax !== undefined && dist < 200) {
        /* Mowing stripes, the way a course is actually cut: passes running up
           and down the hole, each laying the grass the opposite way, so they
           alternate light and dark across it. A softened square wave rather
           than a sine — a real stripe has an edge. Greens are cut narrower. */
        const across = -x * this._az + z * this._ax;
        const along = x * this._ax + z * this._az;
        const gr = this._green;
        const width = 6.5 * (1 - gr) + 1.6 * gr;
        let sq = clamp(Math.sin(across * Math.PI / width) * 4, -1, 1);
        // greens are double-cut, so they show a faint checkerboard
        if (gr > 0.3) sq = (sq + clamp(Math.sin(along * Math.PI / width) * 4, -1, 1) * 0.5) / 1.5;
        const fade = 1 - clamp((dist - 90) / 110, 0, 1);
        lit *= 1 + sq * (0.075 - gr * 0.03) * mown * fade;
      }
      if (this._lip > 0) {
        const away = clamp(1 - (nx * sun[0] + nz * sun[2]) * 3, 0.6, 1.4);
        lit *= 1 - this._lip * 0.20 * away;
      }
      lit *= 1 - this.shadowAt(x, z) * 0.36;

      /* Turf grain: one fine octave only, and faded out with distance so it
         reads as texture close up and never as blotches further out. The last
         attempt at this used a six-metre octave and gave the fairway a case of
         camouflage. */
      const near = 1 - clamp((dist - 6) / 40, 0, 1);
      if (near > 0.01 && wet < 0.5) {
        lit *= 1 + (vnoise(x * 1.15, z * 1.15) - 0.5) * 0.030 * near * (1 - wet);
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
      this._oR = clamp(R | 0, 0, 255);
      this._oG = clamp(G | 0, 0, 255);
      this._oB = clamp(B | 0, 0, 255);
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

    /* Cup and ball radii, in metres. The real ones are 0.054 and 0.021; both
       are drawn at about two and a half times life size, and in proportion,
       so the ball still fits in the hole. At the real size a cup ten metres
       away is three pixels and a putt dropping is not something you can see. */
    CUP_R: 0.135,
    BALL_R: 0.052,

    inCup(App, b) {
      const pin = App.pinPos();
      // holed counts wherever the roll stopped: capture is anywhere within
      // 75 mm of the centre, and the ball is in the cup after that
      if (root.Play && root.Play.state && root.Play.state.holed) return true;
      return Math.hypot(b[0] - pin[0], b[2] - pin[2]) < this.CUP_R &&
             b[1] < App.heightAt(b[0], b[2]) - 0.004;
    },

    /**
     * The hole: a real opening in the green, drawn in perspective.
     *
     * The rim is the cup's circle projected onto the ground, so it foreshortens
     * like the green around it. Inside, the far wall is what you see from
     * above — the white liner at the top, soil below it, and the dark bottom —
     * done by clipping to the rim and stacking the same circle projected at
     * increasing depth, each one lower on the screen than the last. Then the
     * flagstick, standing in the middle of it.
     */
    cup(g, App, Play, to, focal) {
      const pin = App.pinPos();
      const R = this.CUP_R, N = 22;
      const ring = depth => {
        const out = [];
        for (let k = 0; k < N; k++) {
          const a = k / N * 6.2832;
          const x = pin[0] + Math.cos(a) * R, z = pin[2] + Math.sin(a) * R;
          const q = to(x, (depth ? pin[1] : App.heightAt(x, z)) - depth + 0.002, z);
          if (!q) return null;
          out.push(q);
        }
        return out;
      };
      const path = pts => {
        g.beginPath();
        g.moveTo(pts[0].x, pts[0].y);
        for (let k = 1; k < pts.length; k++) g.lineTo(pts[k].x, pts[k].y);
        g.closePath();
      };
      const rim = ring(0);
      const c0 = to(pin[0], pin[1], pin[2]);
      if (!rim || !c0) return;
      const pxR = R * focal / c0.d;

      if (pxR > 0.9) {
        g.save();
        // a ring of worn, slightly darker turf where the cup was cut in
        path(rim);
        g.strokeStyle = 'rgba(40,60,30,.45)';
        g.lineWidth = Math.max(1, pxR * 0.22);
        g.stroke();
        g.clip();
        /* An inch of soil at the top, then the white liner, then the dark
           bottom. From a few metres away only the soil shows, which is why a
           hole looks dark from where you putt; stand over it and the liner
           appears. */
        g.fillStyle = '#2e2216';
        g.fill();
        const liner = ring(R * 0.38), floor = ring(R * 1.7);
        if (liner) { path(liner); g.fillStyle = '#cfd1c8'; g.fill(); }
        if (floor) { path(floor); g.fillStyle = '#120d08'; g.fill(); }
        // the flagstick, where it goes down into the cup
        const s0 = to(pin[0], pin[1] - R * 2.2, pin[2]);
        if (s0) {
          g.strokeStyle = '#d9d9d2';
          g.lineWidth = Math.max(1, 0.028 * focal / c0.d);
          g.beginPath(); g.moveTo(s0.x, s0.y); g.lineTo(c0.x, c0.y); g.stroke();
        }
        // a holed ball, down in the hole and lit only from above
        const b = App.ballPos;
        if (b && this.inCup(App, b)) {
          /* The roll ends two centimetres down, which at the drawn ball size
             would leave it sitting on the rim. Sink it by how far down it has
             got, so it drops from level with the green to below the lip. */
          const holed = root.Play && root.Play.state && root.Play.state.holed;
          const gy = App.heightAt(b[0], b[2]);
          const sink = holed ? 1 : clamp((gy - b[1]) / 0.02, 0, 1);
          const bx = holed ? pin[0] : b[0], bz = holed ? pin[2] : b[2];
          const bq = to(bx, gy + this.BALL_R - sink * this.BALL_R * 1.7, bz);
          if (bq) {
            const rad = Math.max(1.4, this.BALL_R * focal / bq.d);
            g.fillStyle = '#d6d6cf';
            g.beginPath(); g.arc(bq.x, bq.y, rad, 0, 6.2832); g.fill();
          }
        }
        g.restore();
      } else {
        g.fillStyle = '#15100a';
        g.fillRect(c0.x - 1, c0.y - 0.5, 2, 1);
      }

      // the flagstick and flag, standing in the cup
      const p1 = to(pin[0], pin[1] + 2.3, pin[2]);
      if (!p1) return;
      g.strokeStyle = '#f4f4ee';
      g.lineWidth = Math.max(1, 0.028 * focal / c0.d);
      g.beginPath(); g.moveTo(c0.x, c0.y); g.lineTo(p1.x, p1.y); g.stroke();
      const fw = Math.max(4, 0.52 * focal / c0.d), fh = Math.max(3, 0.36 * focal / c0.d);
      g.fillStyle = '#d8443a';
      g.beginPath();
      g.moveTo(p1.x, p1.y);
      g.quadraticCurveTo(p1.x + fw * 0.5, p1.y - fh * 0.12, p1.x + fw, p1.y + fh * 0.08);
      g.lineTo(p1.x + fw, p1.y + fh * 1.04);
      g.quadraticCurveTo(p1.x + fw * 0.5, p1.y + fh * 0.84, p1.x, p1.y + fh);
      g.closePath(); g.fill();
    },

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

      // the aim line, while the ball is at rest
      const ball = App.ballPos || App.teePos();
      if (Play && Play.state.phase !== 'flying') {
        const aim = Play.aim;
        const reach = Play.isPutting ? (Play.isPutting() ? Math.max(1.2, Play.toPin()) : Play.aimDistance()) : 150;
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

      // the ball, with the patch of shadow under it — unless it is in the cup,
      // in which case the cup has already drawn it
      const bq = this.inCup(App, ball) ? null : to(ball[0], ball[1] + this.BALL_R, ball[2]);
      if (bq) {
        const gy = App.heightAt(ball[0], ball[2]);
        const gq = to(ball[0], gy, ball[2]);
        const rad = Math.max(1.6, this.BALL_R * this._focal / bq.d);
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

    }
  };

  root.Soft3D = Soft3D;
})(window);
