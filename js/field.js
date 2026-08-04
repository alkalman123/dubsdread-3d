/* Surface classification + heightfield.
 *
 * Everything the renderer knows about the ground comes from here.  We rasterise
 * the OSM polygons with Canvas2D (free anti-aliasing, and canvas-sourced pixels
 * stay origin-clean so the page works straight off the filesystem), turn each
 * class into a signed distance field, then sculpt a heightfield out of the real
 * USGS elevation grid plus the shaping every golf hole actually has: built green
 * pads, dug bunkers with flashed lips, level tees and pond basins.
 */
(function (root) {
  'use strict';

  const { clamp, smoothstep, lerp, rng } = root.MM;

  /* ---------------------------------------------------------------- noise */
  const P = new Uint8Array(512);
  (function () {
    const r = rng(20240719);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = (r() * (i + 1)) | 0;
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    for (let i = 0; i < 512; i++) P[i] = p[i & 255];
  })();

  const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
  function grad2(h, x, y) {
    switch (h & 7) {
      case 0: return x + y; case 1: return -x + y; case 2: return x - y; case 3: return -x - y;
      case 4: return x; case 5: return -x; case 6: return y; default: return -y;
    }
  }
  function perlin2(x, y) {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
    x -= Math.floor(x); y -= Math.floor(y);
    const u = fade(x), v = fade(y);
    const A = P[X] + Y, B = P[X + 1] + Y;
    return lerp(
      lerp(grad2(P[A], x, y), grad2(P[B], x - 1, y), u),
      lerp(grad2(P[A + 1], x, y - 1), grad2(P[B + 1], x - 1, y - 1), u), v);
  }
  function fbm(x, y, oct, lac, gain) {
    let a = 1, f = 1, s = 0, n = 0;
    for (let i = 0; i < oct; i++) {
      s += a * perlin2(x * f, y * f);
      n += a; a *= gain; f *= lac;
    }
    return s / n;
  }

  /* ---------------------------------------------------------------- EDT
   * 8SSEDT (Danielsson): two sweeps propagating the offset to the nearest
   * boundary pixel. Not quite exact at large radii, but the error is a fraction
   * of a pixel and it runs several times faster than an exact transform — which
   * matters because a hole rebuild does fourteen of these.
   */
  const EDT = { w: 0, h: 0, gx: null, gy: null, sq: null };

  function edtAlloc(w, h) {
    if (EDT.w !== w || EDT.h !== h) {
      EDT.w = w; EDT.h = h;
      EDT.gx = new Int16Array(w * h);
      EDT.gy = new Int16Array(w * h);
      EDT.sq = new Int32Array(w * h);
    }
  }

  /** distance in pixels from every cell to the nearest cell where mask is "on" */
  function edt2d(mask, w, h, invert, out) {
    edtAlloc(w, h);
    const gx = EDT.gx, gy = EDT.gy, sq = EDT.sq;
    const N = w * h;
    const FAR = 9999;
    const FARSQ = FAR * FAR;

    for (let i = 0; i < N; i++) {
      const on = invert ? mask[i] === 0 : mask[i] !== 0;
      if (on) { gx[i] = 0; gy[i] = 0; sq[i] = 0; }
      else { gx[i] = FAR; gy[i] = FAR; sq[i] = FARSQ; }
    }

    // The comparison is written out by hand rather than via a helper: this runs
    // roughly 8N times per transform and a closure call here costs more than
    // everything else in the hole rebuild put together.
    let x, y, d, o, i, r;
    for (y = 0; y < h; y++) {
      r = y * w;
      for (x = 0; x < w; x++) {
        i = r + x;
        if (y > 0) {
          o = i - w;
          if (sq[o] < FARSQ) {
            const ax = gx[o], ay = gy[o] + 1;
            d = ax * ax + ay * ay;
            if (d < sq[i]) { gx[i] = ax; gy[i] = ay; sq[i] = d; }
          }
          if (x > 0) {
            o = i - w - 1;
            if (sq[o] < FARSQ) {
              const ax = gx[o] + 1, ay = gy[o] + 1;
              d = ax * ax + ay * ay;
              if (d < sq[i]) { gx[i] = ax; gy[i] = ay; sq[i] = d; }
            }
          }
          if (x < w - 1) {
            o = i - w + 1;
            if (sq[o] < FARSQ) {
              const ax = gx[o] - 1, ay = gy[o] + 1;
              d = ax * ax + ay * ay;
              if (d < sq[i]) { gx[i] = ax; gy[i] = ay; sq[i] = d; }
            }
          }
        }
        if (x > 0) {
          o = i - 1;
          if (sq[o] < FARSQ) {
            const ax = gx[o] + 1, ay = gy[o];
            d = ax * ax + ay * ay;
            if (d < sq[i]) { gx[i] = ax; gy[i] = ay; sq[i] = d; }
          }
        }
      }
      for (x = w - 2; x >= 0; x--) {
        i = r + x; o = i + 1;
        if (sq[o] < FARSQ) {
          const ax = gx[o] - 1, ay = gy[o];
          d = ax * ax + ay * ay;
          if (d < sq[i]) { gx[i] = ax; gy[i] = ay; sq[i] = d; }
        }
      }
    }
    for (y = h - 1; y >= 0; y--) {
      r = y * w;
      for (x = w - 1; x >= 0; x--) {
        i = r + x;
        if (y < h - 1) {
          o = i + w;
          if (sq[o] < FARSQ) {
            const ax = gx[o], ay = gy[o] - 1;
            d = ax * ax + ay * ay;
            if (d < sq[i]) { gx[i] = ax; gy[i] = ay; sq[i] = d; }
          }
          if (x < w - 1) {
            o = i + w + 1;
            if (sq[o] < FARSQ) {
              const ax = gx[o] - 1, ay = gy[o] - 1;
              d = ax * ax + ay * ay;
              if (d < sq[i]) { gx[i] = ax; gy[i] = ay; sq[i] = d; }
            }
          }
          if (x > 0) {
            o = i + w - 1;
            if (sq[o] < FARSQ) {
              const ax = gx[o] + 1, ay = gy[o] - 1;
              d = ax * ax + ay * ay;
              if (d < sq[i]) { gx[i] = ax; gy[i] = ay; sq[i] = d; }
            }
          }
        }
        if (x < w - 1) {
          o = i + 1;
          if (sq[o] < FARSQ) {
            const ax = gx[o] - 1, ay = gy[o];
            d = ax * ax + ay * ay;
            if (d < sq[i]) { gx[i] = ax; gy[i] = ay; sq[i] = d; }
          }
        }
      }
      for (x = 1; x < w; x++) {
        i = r + x; o = i - 1;
        if (sq[o] < FARSQ) {
          const ax = gx[o] + 1, ay = gy[o];
          d = ax * ax + ay * ay;
          if (d < sq[i]) { gx[i] = ax; gy[i] = ay; sq[i] = d; }
        }
      }
    }

    out = out || new Float32Array(N);
    for (i = 0; i < N; i++) out[i] = Math.sqrt(sq[i]);
    return out;
  }

  let _dIn = null, _dOut = null, _bin = null;

  /**
   * Signed distance in metres: negative inside the shape, positive outside.
   * `into` lets the caller recycle a buffer, which matters a lot — a hole
   * rebuild produces seven of these and each one is several megabytes.
   */
  function signedDistance(cov, w, h, mpp, into) {
    const N = w * h;
    if (!_dIn || _dIn.length !== N) {
      _dIn = new Float32Array(N); _dOut = new Float32Array(N); _bin = new Uint8Array(N);
    }
    for (let i = 0; i < N; i++) _bin[i] = cov[i] >= 128 ? 1 : 0;
    edt2d(_bin, w, h, false, _dOut);
    edt2d(_bin, w, h, true, _dIn);
    const sdf = (into && into.length === N) ? into : new Float32Array(N);
    for (let i = 0; i < N; i++) sdf[i] = (_bin[i] ? -_dIn[i] : _dOut[i]) * mpp;
    return sdf;
  }

  /* ---------------------------------------------------------------- Field */
  class Field {
    /**
     * @param course parsed COURSE data
     * @param cx,cz  centre in world metres
     * @param size   side length in metres
     * @param res    grid resolution (res x res)
     */
    constructor(course, cx, cz, size, res, opts) {
      this.course = course;
      this.cx = cx; this.cz = cz; this.size = size; this.res = res;
      this.mpp = size / res;
      this.x0 = cx - size / 2; this.z0 = cz - size / 2;
      this.opts = opts || {};
      this.build();
    }

    /* world <-> grid */
    gx(x) { return (x - this.x0) / this.mpp - 0.5; }
    gz(z) { return (z - this.z0) / this.mpp - 0.5; }

    /** Bilinear sample of a Float32Array laid out row-major (row = +Z). */
    sample(arr, x, z) {
      const n = this.res;
      let u = this.gx(x), v = this.gz(z);
      u = clamp(u, 0, n - 1.001); v = clamp(v, 0, n - 1.001);
      const i0 = u | 0, j0 = v | 0;
      const fu = u - i0, fv = v - j0;
      const a = arr[j0 * n + i0], b = arr[j0 * n + i0 + 1];
      const c = arr[(j0 + 1) * n + i0], d = arr[(j0 + 1) * n + i0 + 1];
      return lerp(lerp(a, b, fu), lerp(c, d, fu), fv);
    }

    /** Bilinear sample of a Uint8Array coverage mask. */
    sample2(arr, x, z) {
      const n = this.res;
      let u = clamp(this.gx(x), 0, n - 1.001), v = clamp(this.gz(z), 0, n - 1.001);
      const i0 = u | 0, j0 = v | 0, fu = u - i0, fv = v - j0;
      const a = arr[j0 * n + i0], b = arr[j0 * n + i0 + 1];
      const c = arr[(j0 + 1) * n + i0], d = arr[(j0 + 1) * n + i0 + 1];
      return lerp(lerp(a, b, fu), lerp(c, d, fu), fv);
    }

    contains(x, z, m) {
      m = m || 0;
      return x > this.x0 + m && x < this.x0 + this.size - m &&
             z > this.z0 + m && z < this.z0 + this.size - m;
    }

    /* ------------------------------------------------------------ raster */
    _canvas() {
      let c = Field._scratch;
      if (!c || c.width !== this.res) {
        c = Field._scratch = document.createElement('canvas');
        c.width = c.height = this.res;
        Field._scratchCtx = c.getContext('2d', { willReadFrequently: true });
      }
      const g = Field._scratchCtx;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, this.res, this.res);
      g.fillStyle = '#fff'; g.strokeStyle = '#fff';
      g.lineJoin = 'round'; g.lineCap = 'round';
      // world -> pixel
      const s = this.res / this.size;
      g.setTransform(s, 0, 0, s, -this.x0 * s, -this.z0 * s);
      return { c, g };
    }

    _coverage(g, slot) {
      const n = this.res, N = n * n;
      if (!Field._cov) Field._cov = {};
      let out = Field._cov[slot];
      if (!out || out.length !== N) out = Field._cov[slot] = new Uint8Array(N);
      const d = g.getImageData(0, 0, n, n).data;
      for (let i = 0, j = 3; i < N; i++, j += 4) out[i] = d[j];
      return out;
    }

    _fillPolys(g, polys) {
      for (const poly of polys) {
        if (!poly || poly.length < 3) continue;
        g.beginPath();
        g.moveTo(poly[0][0], poly[0][1]);
        for (let i = 1; i < poly.length; i++) g.lineTo(poly[i][0], poly[i][1]);
        g.closePath();
        g.fill();
      }
    }

    _strokePolys(g, lines, width) {
      g.lineWidth = width;
      for (const ln of lines) {
        if (!ln || ln.length < 2) continue;
        g.beginPath();
        g.moveTo(ln[0][0], ln[0][1]);
        for (let i = 1; i < ln.length; i++) g.lineTo(ln[i][0], ln[i][1]);
        g.stroke();
      }
    }

    /* ------------------------------------------------------------- build */
    build() {
      const C = this.course, n = this.res;
      const holes = C.holes;

      const gather = key => {
        const out = [];
        for (const h of holes) for (const r of h[key]) out.push(r);
        return out;
      };

      const fairwayPolys = gather('fairways').concat(C.ctx.fairway);
      const greenPolys = [];
      for (const h of holes) for (const r of h.green.rings) greenPolys.push(r);
      const greenPolysAll = greenPolys.concat(C.ctx.green);
      const bunkerPolys = gather('bunkers').concat(C.ctx.bunker);
      const waterPolys = gather('waters').concat(C.ponds);
      const teePolys = gather('teeBoxes');
      const spines = holes.map(h => h.spine);

      // --- class coverage masks
      let r = this._canvas();
      this._fillPolys(r.g, fairwayPolys);
      const covFw = this._coverage(r.g, 'fw');

      r = this._canvas();
      this._fillPolys(r.g, greenPolysAll);
      const covGr = this._coverage(r.g, 'gr');

      r = this._canvas();
      this._fillPolys(r.g, bunkerPolys);
      const covSa = this._coverage(r.g, 'sa');

      r = this._canvas();
      this._fillPolys(r.g, waterPolys);
      const covWa = this._coverage(r.g, 'wa');

      r = this._canvas();
      this._fillPolys(r.g, teePolys);
      const covTe = this._coverage(r.g, 'te');

      r = this._canvas();
      this._strokePolys(r.g, C.paths.concat(C.roads), 3.0);
      const covPa = this._coverage(r.g, 'pa');

      // mown corridor: fairway + greens + tees, generously dilated, plus a
      // stroke down each hole spine so the mown envelope is continuous
      r = this._canvas();
      this._strokePolys(r.g, spines, 62);
      this._fillPolys(r.g, fairwayPolys);
      this._fillPolys(r.g, greenPolysAll);
      this._fillPolys(r.g, teePolys);
      this._fillPolys(r.g, bunkerPolys);
      const covCorr = this._coverage(r.g, 'corr');

      r = this._canvas();
      this._fillPolys(r.g, C.woods);
      const covWood = this._coverage(r.g, 'wood');

      r = this._canvas();
      this._fillPolys(r.g, C.buildings);
      const covBld = this._coverage(r.g, 'bld');

      const mpp = this.mpp;
      const R = this.opts.recycle || {};
      this.sdfFw = signedDistance(covFw, n, n, mpp, R.sdfFw);
      this.sdfGr = signedDistance(covGr, n, n, mpp, R.sdfGr);
      this.sdfSa = signedDistance(covSa, n, n, mpp, R.sdfSa);
      this.sdfWa = signedDistance(covWa, n, n, mpp, R.sdfWa);
      this.sdfTe = signedDistance(covTe, n, n, mpp, R.sdfTe);
      this.sdfPa = signedDistance(covPa, n, n, mpp, R.sdfPa);
      this.sdfCo = signedDistance(covCorr, n, n, mpp, R.sdfCo);
      this.covWood = covWood;
      this.covBld = covBld;

      this.buildHeight();
      this.buildTextures();
    }

    /* --------------------------------------------------------- elevation */
    demSample(x, z) {
      const d = this.course.dem;
      if (!d) return 0;
      const n = d.n;
      // dem rows run north->south in world Z because Z = -north
      let u = (x - d.x0) / (d.x1 - d.x0) * (n - 1);
      let v = (z - d.z0) / (d.z1 - d.z0) * (n - 1);
      u = clamp(u, 0, n - 1.001); v = clamp(v, 0, n - 1.001);
      const i0 = u | 0, j0 = v | 0, fu = u - i0, fv = v - j0;
      const h = d.h;
      const a = h[j0 * n + i0], b = h[j0 * n + i0 + 1];
      const c = h[(j0 + 1) * n + i0], e = h[(j0 + 1) * n + i0 + 1];
      return lerp(lerp(a, b, fu), lerp(c, e, fu), fv) - d.base;
    }

    buildHeight() {
      const n = this.res, mpp = this.mpp;
      const H = new Float32Array(n * n);
      const base = new Float32Array(n * n);

      // 1. Real terrain plus natural micro-relief. The DEM is 10 m data and the
      //    noise runs at 30 m+ wavelengths, so evaluate on a coarse grid and
      //    bilinearly upsample — same result, a fraction of the work.
      const CS = 8;                       // coarse cells per fine cell
      const cn = Math.ceil(n / CS) + 1;
      const cBase = new Float32Array(cn * cn);
      const cRoll = new Float32Array(cn * cn);
      for (let j = 0; j < cn; j++) {
        const z = this.z0 + j * CS * mpp;
        for (let i = 0; i < cn; i++) {
          const x = this.x0 + i * CS * mpp;
          const k = j * cn + i;
          cBase[k] = this.demSample(x, z);
          cRoll[k] = fbm(x * 0.0075, z * 0.0075, 4, 2.1, 0.5) * 1.35
                   + fbm(x * 0.031, z * 0.031, 3, 2.3, 0.5) * 0.42;
        }
      }
      const bil = (arr, u, v) => {
        const i0 = u | 0, j0 = v | 0, fu = u - i0, fv = v - j0;
        const a = arr[j0 * cn + i0], b = arr[j0 * cn + i0 + 1];
        const c = arr[(j0 + 1) * cn + i0], d = arr[(j0 + 1) * cn + i0 + 1];
        return lerp(lerp(a, b, fu), lerp(c, d, fu), fv);
      };
      for (let j = 0; j < n; j++) {
        const v = clamp((j + 0.5) / CS, 0, cn - 1.001);
        for (let i = 0; i < n; i++) {
          const u = clamp((i + 0.5) / CS, 0, cn - 1.001);
          const k = j * n + i;
          const h = bil(cBase, u, v);
          base[k] = h;
          H[k] = h + bil(cRoll, u, v);
        }
      }

      // 2. pads: greens and tees are constructed, near-level platforms
      const pads = [];
      for (const h of this.course.holes) {
        for (const ring of h.green.rings) {
          pads.push({ ring, kind: 'green', fall: 16, hole: h.num });
        }
        for (const ring of h.teeBoxes) pads.push({ ring, kind: 'tee', fall: 7 });
      }

      const padH = new Float32Array(n * n);
      const padW = new Float32Array(n * n);
      const R = rng(99001);

      for (const pad of pads) {
        const ring = pad.ring;
        let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9, sx = 0, sz = 0;
        for (const p of ring) {
          minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]);
          minz = Math.min(minz, p[1]); maxz = Math.max(maxz, p[1]);
          sx += p[0]; sz += p[1];
        }
        const cxp = sx / ring.length, czp = sz / ring.length;
        const fall = pad.fall;
        if (maxx < this.x0 - fall || minx > this.x0 + this.size + fall) continue;
        if (maxz < this.z0 - fall || minz > this.z0 + this.size + fall) continue;

        // reference height: average of the real terrain under the pad
        let acc = 0, cnt = 0;
        for (let t = 0; t < 24; t++) {
          const a = t / 24 * Math.PI * 2;
          acc += this.demSample(cxp + Math.cos(a) * 4, czp + Math.sin(a) * 4); cnt++;
        }
        let h0 = acc / cnt;
        // greens sit slightly proud of grade; tees are level cut pads
        const tilt = pad.kind === 'green' ? 0.018 + R() * 0.016 : 0.006;
        const tiltDir = R() * Math.PI * 2;
        const tdx = Math.cos(tiltDir) * tilt, tdz = Math.sin(tiltDir) * tilt;
        const crown = pad.kind === 'green' ? 0.55 + R() * 0.5 : 0.0;
        h0 += pad.kind === 'green' ? 0.45 + R() * 0.5 : 0.12;
        const wob = R() * 1000;

        const i0 = clamp(Math.floor(this.gx(minx - fall)), 0, n - 1);
        const i1 = clamp(Math.ceil(this.gx(maxx + fall)), 0, n - 1);
        const j0 = clamp(Math.floor(this.gz(minz - fall)), 0, n - 1);
        const j1 = clamp(Math.ceil(this.gz(maxz + fall)), 0, n - 1);
        let rmax = 1;
        for (const p of ring) rmax = Math.max(rmax, Math.hypot(p[0] - cxp, p[1] - czp));

        for (let j = j0; j <= j1; j++) {
          const z = this.z0 + (j + 0.5) * mpp;
          for (let i = i0; i <= i1; i++) {
            const x = this.x0 + (i + 0.5) * mpp;
            const d = distToPoly(x, z, ring);   // negative inside
            if (d > fall) continue;
            const w = 1 - smoothstep(0, fall, Math.max(d, 0));
            if (w <= 0.001) continue;
            const k = j * n + i;
            const rr = Math.hypot(x - cxp, z - czp) / rmax;
            let hh = h0 + (x - cxp) * tdx + (z - czp) * tdz;
            if (pad.kind === 'green') {
              // gentle crown falling away to the edges + subtle internal contour
              hh += crown * (1 - clamp(rr, 0, 1) * clamp(rr, 0, 1));
              hh += fbm((x + wob) * 0.055, (z + wob) * 0.055, 3, 2.2, 0.5) * 0.34;
            }
            if (w > padW[k]) { padW[k] = w; padH[k] = hh; }
            else if (padW[k] > 0) { padH[k] = lerp(padH[k], hh, 0.5 * w); }
          }
        }
      }

      for (let k = 0; k < n * n; k++) {
        if (padW[k] > 0) H[k] = lerp(H[k], padH[k], padW[k]);
      }

      // 3. fairways are mown and rolled: damp the micro-relief there
      for (let k = 0; k < n * n; k++) {
        const inFw = 1 - smoothstep(-4, 4, this.sdfFw[k]);
        if (inFw > 0) H[k] = lerp(H[k], lerp(H[k], base[k] + 0.15, 0.55), inFw);
      }

      // 4. bunkers: dished floor with a flashed lip on the high side
      for (let k = 0; k < n * n; k++) {
        const s = this.sdfSa[k];
        if (s < 6) {
          const i = k % n, j = (k / n) | 0;
          const x = this.x0 + (i + 0.5) * mpp, z = this.z0 + (j + 0.5) * mpp;
          const jit = fbm(x * 0.09, z * 0.09, 2, 2.0, 0.5);
          if (s < 0) {
            const depth = (1.05 + jit * 0.28) * smoothstep(0, 3.2, -s);
            H[k] -= depth;
          } else {
            H[k] += (0.42 + jit * 0.16) * (1 - smoothstep(0, 5.0, s)) * smoothstep(0, 1.1, s);
          }
        }
      }

      // 5. water: flat pool with a dug basin and a soft bank
      const pools = this.poolLevels(H);
      for (let k = 0; k < n * n; k++) {
        const s = this.sdfWa[k];
        if (s < 9) {
          const i = k % n, j = (k / n) | 0;
          const lvl = pools.sample(this.x0 + (i + 0.5) * mpp, this.z0 + (j + 0.5) * mpp);
          if (lvl === null) continue;
          if (s < 0) {
            H[k] = lvl - 0.6 - 2.0 * smoothstep(0, 9, -s);
          } else {
            const w = 1 - smoothstep(0, 9, s);
            H[k] = lerp(H[k], lvl + 0.5, w * 0.85);
          }
        }
      }

      // 6. cart paths sit just below grade
      for (let k = 0; k < n * n; k++) {
        const s = this.sdfPa[k];
        if (s < 1.6) H[k] -= 0.09 * (1 - smoothstep(0, 1.6, Math.max(s, 0)));
      }

      // 7. one smoothing pass to kill raster stair-stepping
      const S = new Float32Array(H);
      for (let j = 1; j < n - 1; j++) {
        for (let i = 1; i < n - 1; i++) {
          const k = j * n + i;
          S[k] = (H[k] * 4 + H[k - 1] + H[k + 1] + H[k - n] + H[k + n]) / 8;
        }
      }
      this.H = S;
      this.pools = pools;
    }

    /** Group water polygons into pools and give each a single flat level. */
    poolLevels(H) {
      const list = [];
      const polys = [];
      for (const h of this.course.holes) for (const r of h.waters) polys.push(r);
      for (const r of this.course.ponds) polys.push(r);
      for (const ring of polys) {
        let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9;
        for (const p of ring) {
          minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]);
          minz = Math.min(minz, p[1]); maxz = Math.max(maxz, p[1]);
        }
        let lo = 1e9;
        for (const p of ring) lo = Math.min(lo, this.demSample(p[0], p[1]));
        list.push({ minx, maxx, minz, maxz, level: lo - 0.35,
                    cx: (minx + maxx) / 2, cz: (minz + maxz) / 2,
                    r: Math.hypot(maxx - minx, maxz - minz) * 0.5 + 24 });
      }
      return {
        list,
        sample(x, z) {
          let best = null, bd = 1e9;
          for (const p of list) {
            const d = Math.hypot(x - p.cx, z - p.cz);
            if (d < p.r && d < bd) { bd = d; best = p; }
          }
          return best ? best.level : null;
        }
      };
    }

    height(x, z) { return this.sample(this.H, x, z); }

    normal(x, z, out) {
      const e = Math.max(this.mpp, 0.8);
      const hL = this.height(x - e, z), hR = this.height(x + e, z);
      const hD = this.height(x, z - e), hU = this.height(x, z + e);
      const nx = hL - hR, ny = 2 * e, nz = hD - hU;
      const l = Math.hypot(nx, ny, nz) || 1;
      out = out || new Float32Array(3);
      out[0] = nx / l; out[1] = ny / l; out[2] = nz / l;
      return out;
    }

    /** Surface class at a world point — drives ball behaviour and the UI readout. */
    surfaceAt(x, z) {
      if (this.sample(this.sdfWa, x, z) < 0) return 'water';
      if (this.sample(this.sdfSa, x, z) < 0) return 'sand';
      const g = this.sample(this.sdfGr, x, z);
      if (g < 0) return 'green';
      if (g < 0.9) return 'fringe';
      if (this.sample(this.sdfTe, x, z) < 0) return 'tee';
      if (this.sample(this.sdfPa, x, z) < 0) return 'path';
      if (this.sample(this.sdfFw, x, z) < 0) return 'fairway';
      if (this.sample(this.sdfCo, x, z) < 0) return 'rough';
      return 'native';
    }

    /* ---------------------------------------------------------- textures */
    buildTextures() {
      const gl = root.__gl;
      if (!gl) return;
      const n = this.res, N = n * n;
      const a = new Float32Array(N * 4);
      const b = new Float32Array(N * 4);
      for (let k = 0; k < N; k++) {
        a[k * 4] = this.sdfFw[k];
        a[k * 4 + 1] = this.sdfGr[k];
        a[k * 4 + 2] = this.sdfSa[k];
        a[k * 4 + 3] = this.sdfWa[k];
        b[k * 4] = this.sdfTe[k];
        b[k * 4 + 1] = this.sdfPa[k];
        b[k * 4 + 2] = this.sdfCo[k];
        b[k * 4 + 3] = this.covWood[k] / 255;
      }
      if (this.texA) gl.deleteTexture(this.texA);
      if (this.texB) gl.deleteTexture(this.texB);
      this.texA = root.GLX.texFloat(gl, n, n, a, 4);
      this.texB = root.GLX.texFloat(gl, n, n, b, 4);
    }

    dispose() {
      const gl = root.__gl;
      if (gl) {
        if (this.texA) gl.deleteTexture(this.texA);
        if (this.texB) gl.deleteTexture(this.texB);
      }
    }
  }

  /** Signed distance from a point to a polygon (negative inside). */
  function distToPoly(px, pz, ring) {
    let d = Infinity, inside = false;
    const m = ring.length;
    for (let i = 0, j = m - 1; i < m; j = i++) {
      const ax = ring[j][0], az = ring[j][1];
      const bx = ring[i][0], bz = ring[i][1];
      const ex = bx - ax, ez = bz - az;
      const wx = px - ax, wz = pz - az;
      const l2 = ex * ex + ez * ez;
      const t = l2 > 0 ? clamp((wx * ex + wz * ez) / l2, 0, 1) : 0;
      const dx = wx - ex * t, dz = wz - ez * t;
      d = Math.min(d, dx * dx + dz * dz);
      if ((az > pz) !== (bz > pz) && px < ax + (pz - az) / (bz - az) * (bx - ax)) inside = !inside;
    }
    return (inside ? -1 : 1) * Math.sqrt(d);
  }

  root.Field = Field;
  root.FieldUtil = { fbm, perlin2, distToPoly, signedDistance };
})(window);
