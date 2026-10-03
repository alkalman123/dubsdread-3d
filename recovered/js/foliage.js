/* Procedural geometry: trees, grass, and the course furniture. */
(function (root) {
  'use strict';

  const { clamp, lerp, rng } = root.MM;

  /* ------------------------------------------------------------ primitives */

  function sphere(segU, segV, out, cb) {
    const v0 = out.pos.length / 3;
    for (let j = 0; j <= segV; j++) {
      const v = j / segV, phi = v * Math.PI;
      const sp = Math.sin(phi), cp = Math.cos(phi);
      for (let i = 0; i <= segU; i++) {
        const u = i / segU, th = u * Math.PI * 2;
        let x = sp * Math.cos(th), y = cp, z = sp * Math.sin(th);
        const p = cb ? cb(x, y, z, u, v) : [x, y, z];
        out.pos.push(p[0], p[1], p[2]);
        const l = Math.hypot(x, y, z) || 1;
        out.nrm.push(x / l, y / l, z / l);
      }
    }
    for (let j = 0; j < segV; j++) {
      for (let i = 0; i < segU; i++) {
        const a = v0 + j * (segU + 1) + i, b = a + 1;
        const c = a + segU + 1, d = c + 1;
        out.idx.push(a, c, b, b, c, d);
      }
    }
  }

  function tube(seg, rings, out, radiusAt, offsetAt) {
    const v0 = out.pos.length / 3;
    for (let j = 0; j <= rings; j++) {
      const t = j / rings;
      const r = radiusAt(t);
      const o = offsetAt ? offsetAt(t) : [0, t, 0];
      for (let i = 0; i <= seg; i++) {
        const a = i / seg * Math.PI * 2;
        const cx = Math.cos(a), cz = Math.sin(a);
        out.pos.push(o[0] + cx * r, o[1], o[2] + cz * r);
        out.nrm.push(cx, 0.16, cz);
      }
    }
    for (let j = 0; j < rings; j++) {
      for (let i = 0; i < seg; i++) {
        const a = v0 + j * (seg + 1) + i, b = a + 1;
        const c = a + seg + 1, d = c + 1;
        out.idx.push(a, c, b, b, c, d);
      }
    }
  }

  function cone(seg, out, r, h, y0) {
    const v0 = out.pos.length / 3;
    out.pos.push(0, y0 + h, 0); out.nrm.push(0, 1, 0);
    for (let i = 0; i <= seg; i++) {
      const a = i / seg * Math.PI * 2;
      out.pos.push(Math.cos(a) * r, y0, Math.sin(a) * r);
      out.nrm.push(Math.cos(a) * 0.8, 0.4, Math.sin(a) * 0.8);
    }
    for (let i = 0; i < seg; i++) out.idx.push(v0, v0 + 1 + i, v0 + 2 + i);
  }

  /* ---------------------------------------------------------------- trees */

  const ARCHETYPES = [
    { name: 'oak',    blobs: 6, spread: 0.62, crown: 0.55, trunkR: 0.055, lift: 0.42, tall: 1.00 },
    { name: 'elm',    blobs: 5, spread: 0.44, crown: 0.70, trunkR: 0.042, lift: 0.50, tall: 1.22 },
    { name: 'maple',  blobs: 7, spread: 0.70, crown: 0.48, trunkR: 0.062, lift: 0.36, tall: 0.90 },
    { name: 'spruce', blobs: 0, spread: 0.34, crown: 0.90, trunkR: 0.048, lift: 0.10, tall: 1.15 }
  ];

  /** One unit tree, ~1.0 tall; instances scale it. Returns {mesh, radius}. */
  function buildTreeMesh(gl, arch, seed) {
    const R = rng(seed);
    const out = { pos: [], nrm: [], idx: [] };
    const A = ARCHETYPES[arch];

    // trunk
    const trunkTop = A.lift + 0.10;
    tube(7, 5, out, t => A.trunkR * (1.0 - t * 0.55) * (1 + (1 - t) * (1 - t) * 0.9),
      t => [Math.sin(t * 1.7 + seed) * 0.02 * t, t * trunkTop, Math.cos(t * 1.3 + seed) * 0.02 * t]);
    const trunkVerts = out.pos.length / 3;

    // a couple of limbs
    if (A.blobs > 0) {
      for (let b = 0; b < 3; b++) {
        const ang = R() * Math.PI * 2;
        const len = 0.20 + R() * 0.16;
        const y = trunkTop - 0.06;
        tube(5, 3, out, t => 0.024 * (1 - t * 0.7),
          t => [Math.cos(ang) * len * t, y + t * 0.26, Math.sin(ang) * len * t]);
      }
    }
    const nTrunk = out.pos.length / 3;

    // canopy
    if (A.blobs === 0) {
      // conifer: stacked cones
      const layers = 6;
      for (let i = 0; i < layers; i++) {
        const t = i / (layers - 1);
        const y = A.lift + t * (1 - A.lift) * 0.96;
        const r = A.spread * (1 - t) * 1.05 + 0.06;
        cone(9, out, r, 0.30 * (1 - t * 0.5), y);
      }
    } else {
      for (let b = 0; b < A.blobs; b++) {
        const t = b / A.blobs;
        const ang = R() * Math.PI * 2;
        const rad = A.spread * (0.20 + R() * 0.72) * (1 - t * 0.25);
        const cx = Math.cos(ang) * rad * 0.72;
        const cz = Math.sin(ang) * rad * 0.72;
        const cy = A.lift + A.crown * (0.30 + R() * 0.72);
        const rr = A.spread * (0.40 + R() * 0.42);
        const sx = rr * (0.95 + R() * 0.55);
        const sy = rr * (0.52 + R() * 0.30);
        const sz = rr * (0.95 + R() * 0.55);
        const tw = 0.55 + R() * 0.9;
        sphere(8, 5, out, (x, y, z) => {
          // squash + shear each blob into a lobe rather than a ball
          const k = 1.0 - 0.28 * y;
          return [cx + x * sx * k + y * 0.12 * tw,
                  cy + y * sy - (x * x + z * z) * 0.10 * rr,
                  cz + z * sz * k + y * 0.10 * tw];
        });
      }
    }

    const nAll = out.pos.length / 3;
    const data = new Float32Array(nAll * 2);
    for (let i = 0; i < nAll; i++) data[i * 2] = i < nTrunk ? 0 : 1;

    let radius = 0, top = 0;
    for (let i = 0; i < nAll; i++) {
      radius = Math.max(radius, Math.hypot(out.pos[i * 3], out.pos[i * 3 + 2]));
      top = Math.max(top, out.pos[i * 3 + 1]);
    }

    const mesh = new root.GLX.Mesh(gl);
    mesh.attr(0, new Float32Array(out.pos), 3);
    mesh.attr(1, new Float32Array(out.nrm), 3);
    mesh.attr(2, data, 2);
    mesh.index(new Uint32Array(out.idx));
    return { mesh, radius, top, tris: out.idx.length / 3 };
  }

  /**
   * Scatter trees over the property.  Trees go where play does not: outside the
   * mown corridor, off the paths and water, denser inside mapped woodland.
   */
  function scatterTrees(field, course, opts) {
    const o = opts || {};
    const R = rng(o.seed || 4271);
    const spacing = o.spacing || 11.0;
    const half = field.size / 2 - spacing;
    const cx = field.cx, cz = field.cz;
    const out = [];

    const nCells = Math.floor((half * 2) / spacing);
    for (let j = 0; j < nCells; j++) {
      for (let i = 0; i < nCells; i++) {
        const x = cx - half + (i + 0.15 + R() * 0.7) * spacing;
        const z = cz - half + (j + 0.15 + R() * 0.7) * spacing;
        if (!field.contains(x, z, 4)) continue;

        const dCo = field.sample(field.sdfCo, x, z);     // + outside mown corridor
        const dWa = field.sample(field.sdfWa, x, z);
        const dPa = field.sample(field.sdfPa, x, z);
        const dSa = field.sample(field.sdfSa, x, z);
        const wood = field.sample2(field.covWood, x, z) / 255;
        const bld = field.sample2(field.covBld, x, z) / 255;

        if (dWa < 6 || dPa < 4.5 || dSa < 5 || bld > 0.25) continue;

        // probability: right at the corridor edge trees are sparse specimens,
        // deeper out it becomes solid woodland
        let p = 0;
        if (dCo > 3) p = clamp((dCo - 3) / 20, 0, 1) * 0.92;
        p = Math.max(p, wood * 0.92 * (dCo > 2 ? 1 : 0));
        if (dCo > 46) p = Math.max(p, 0.90);
        if (p <= 0.02 || R() > p) continue;

        const y = field.height(x, z);
        const rr = R();
        const arch = rr < 0.40 ? 0 : rr < 0.68 ? 1 : rr < 0.92 ? 2 : 3;
        const scale = (arch === 3 ? 13.5 : 16) * (0.58 + R() * 0.82);
        out.push({
          x, y: y - 0.35, z,
          scale,
          rotY: R() * Math.PI * 2,
          hue: R(),
          phase: R() * 100,
          hScale: 0.82 + R() * 0.5,
          arch
        });
      }
    }
    return out;
  }

  /**
   * Split a scatter into per-archetype instance buffers plus far impostors.
   * Proximity is measured to the hole's centreline, not to a single point, so a
   * 600-yard par 5 gets full-detail trees down its whole length.
   */
  function packTrees(gl, trees, spine, nearRadius, farRadius) {
    const near = [[], [], [], []];
    const far = [];
    const distToSpine = (x, z) => {
      let best = Infinity;
      for (let i = 1; i < spine.length; i++) {
        const ax = spine[i - 1][0], az = spine[i - 1][1];
        const bx = spine[i][0], bz = spine[i][1];
        const dx = bx - ax, dz = bz - az;
        const l2 = dx * dx + dz * dz;
        const t = l2 > 0 ? clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1) : 0;
        const px = x - (ax + dx * t), pz = z - (az + dz * t);
        const d = px * px + pz * pz;
        if (d < best) best = d;
      }
      return Math.sqrt(best);
    };
    for (const t of trees) {
      const d = distToSpine(t.x, t.z);
      if (d < nearRadius) near[t.arch].push(t);
      else if (d < farRadius) far.push(t);
    }
    const mk = list => {
      const a = new Float32Array(list.length * 4);
      const b = new Float32Array(list.length * 4);
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        a[i * 4] = t.x; a[i * 4 + 1] = t.y; a[i * 4 + 2] = t.z; a[i * 4 + 3] = t.scale;
        b[i * 4] = t.rotY; b[i * 4 + 1] = t.hue; b[i * 4 + 2] = t.phase; b[i * 4 + 3] = t.hScale;
      }
      return { a, b, n: list.length };
    };
    const farPack = (() => {
      const a = new Float32Array(far.length * 4);
      const b = new Float32Array(far.length * 4);
      for (let i = 0; i < far.length; i++) {
        const t = far[i];
        const r = t.scale * 0.52;
        a[i * 4] = t.x; a[i * 4 + 1] = t.y + t.scale * t.hScale * 0.60;
        a[i * 4 + 2] = t.z; a[i * 4 + 3] = r;
        b[i * 4] = t.rotY; b[i * 4 + 1] = t.hue; b[i * 4 + 2] = t.phase; b[i * 4 + 3] = t.hScale * 1.02;
      }
      return { a, b, n: far.length };
    })();
    return { near: near.map(mk), far: farPack };
  }

  /* ---------------------------------------------------------------- grass */

  function bladeMesh(gl) {
    const pos = [], t = [], idx = [];
    const SEG = 4;
    let base = 0;
    for (let s = 0; s <= SEG; s++) {
      const f = s / SEG;
      const w = 0.019 * (1 - f * 0.88);
      pos.push(-w, f, 0, w, f, 0);
      t.push(f, f);
    }
    for (let s = 0; s < SEG; s++) {
      const a = s * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, c, b, b, c, d);
    }
    const mesh = new root.GLX.Mesh(gl);
    mesh.attr(0, new Float32Array(pos), 3);
    mesh.attr(1, new Float32Array(t), 1);
    mesh.index(new Uint16Array(idx));
    return mesh;
  }

  /** Blades within ~34 m of the camera focus, on mown or native turf. */
  function scatterGrass(field, fx, fz, radius, count, seed) {
    const R = rng(seed || 777);
    const a = new Float32Array(count * 4);
    const b = new Float32Array(count * 4);
    let m = 0;
    for (let i = 0; i < count * 3 && m < count; i++) {
      const ang = R() * Math.PI * 2;
      const rr = Math.sqrt(R()) * radius;
      const x = fx + Math.cos(ang) * rr;
      const z = fz + Math.sin(ang) * rr;
      if (!field.contains(x, z, 2)) continue;
      const dSa = field.sample(field.sdfSa, x, z);
      const dWa = field.sample(field.sdfWa, x, z);
      const dPa = field.sample(field.sdfPa, x, z);
      if (dSa < 0.4 || dWa < 0.4 || dPa < 0.4) continue;
      const dGr = field.sample(field.sdfGr, x, z);
      const dFw = field.sample(field.sdfFw, x, z);
      const dTe = field.sample(field.sdfTe, x, z);
      const dCo = field.sample(field.sdfCo, x, z);
      // Mown surfaces are handled entirely by the turf shader. Blades only go
      // in the native areas outside the mown corridor, where the grass really
      // is long enough to break the silhouette — anywhere else they read as a
      // carpet ring following the camera around.
      if (dGr < 2.0 || dFw < 0.5 || dTe < 0.5 || dCo < 1.5) continue;
      const fade = clamp((dCo - 1.5) / 6, 0, 1);
      if (R() > 0.25 + fade * 0.75) continue;
      const h = (0.26 + R() * 0.34) * (0.45 + 0.55 * fade);
      const y = field.height(x, z);
      a[m * 4] = x; a[m * 4 + 1] = y; a[m * 4 + 2] = z; a[m * 4 + 3] = h * (0.75 + R() * 0.6);
      b[m * 4] = R() * Math.PI * 2;
      b[m * 4 + 1] = (R() - 0.5) * 0.55 * h;
      b[m * 4 + 2] = (R() - 0.5) * 0.55 * h;
      b[m * 4 + 3] = R();
      m++;
    }
    return { a: a.subarray(0, m * 4), b: b.subarray(0, m * 4), n: m };
  }

  /* ---------------------------------------------------------------- props */

  function propBuilder() {
    return {
      pos: [], nrm: [], col: [], wav: [], idx: [],
      _push(p, n, c, w) {
        this.pos.push(p[0], p[1], p[2]);
        this.nrm.push(n[0], n[1], n[2]);
        this.col.push(c[0], c[1], c[2]);
        this.wav.push(w || 0);
      },
      cylinder(x, y, z, r0, r1, h, c, seg) {
        seg = seg || 10;
        const v0 = this.pos.length / 3;
        for (let j = 0; j <= 1; j++) {
          const r = j ? r1 : r0;
          for (let i = 0; i <= seg; i++) {
            const a = i / seg * Math.PI * 2;
            const cx = Math.cos(a), cz = Math.sin(a);
            this._push([x + cx * r, y + j * h, z + cz * r], [cx, 0.1, cz], c, 0);
          }
        }
        for (let i = 0; i < seg; i++) {
          const a = v0 + i, b = a + 1, cc = a + seg + 1, d = cc + 1;
          this.idx.push(a, cc, b, b, cc, d);
        }
        // cap
        const capC = this.pos.length / 3;
        this._push([x, y + h, z], [0, 1, 0], c, 0);
        for (let i = 0; i <= seg; i++) {
          const a = i / seg * Math.PI * 2;
          this._push([x + Math.cos(a) * r1, y + h, z + Math.sin(a) * r1], [0, 1, 0], c, 0);
        }
        for (let i = 0; i < seg; i++) this.idx.push(capC, capC + 1 + i, capC + 2 + i);
      },
      ball(x, y, z, r, c, segU, segV) {
        segU = segU || 14; segV = segV || 9;
        const v0 = this.pos.length / 3;
        for (let j = 0; j <= segV; j++) {
          const phi = j / segV * Math.PI;
          for (let i = 0; i <= segU; i++) {
            const th = i / segU * Math.PI * 2;
            const nx = Math.sin(phi) * Math.cos(th), ny = Math.cos(phi), nz = Math.sin(phi) * Math.sin(th);
            this._push([x + nx * r, y + ny * r, z + nz * r], [nx, ny, nz], c, 0);
          }
        }
        for (let j = 0; j < segV; j++) {
          for (let i = 0; i < segU; i++) {
            const a = v0 + j * (segU + 1) + i, b = a + 1, cc = a + segU + 1, d = cc + 1;
            this.idx.push(a, cc, b, b, cc, d);
          }
        }
      },
      box(x, y, z, sx, sy, sz, c) {
        const v0 = this.pos.length / 3;
        const F = [
          [[0, 0, 1], [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]],
          [[0, 0, -1], [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]]],
          [[1, 0, 0], [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]]],
          [[-1, 0, 0], [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]]],
          [[0, 1, 0], [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]]],
          [[0, -1, 0], [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]]]
        ];
        let k = v0;
        for (const [n, quad] of F) {
          for (const p of quad) this._push([x + p[0] * sx, y + p[1] * sy, z + p[2] * sz], n, c, 0);
          this.idx.push(k, k + 1, k + 2, k, k + 2, k + 3);
          k += 4;
        }
      },
      /** Flag cloth: a strip that ripples in the shader. */
      flag(x, y, z, dirX, dirZ, w, h, c) {
        const NX = 8, NY = 4;
        const v0 = this.pos.length / 3;
        for (let j = 0; j <= NY; j++) {
          for (let i = 0; i <= NX; i++) {
            const u = i / NX, v = j / NY;
            this._push([x + dirX * u * w, y + (v - 0.5) * h, z + dirZ * u * w],
                       [-dirZ, 0.12, dirX], c, u * u);
          }
        }
        for (let j = 0; j < NY; j++) {
          for (let i = 0; i < NX; i++) {
            const a = v0 + j * (NX + 1) + i, b = a + 1, cc = a + NX + 1, d = cc + 1;
            this.idx.push(a, cc, b, b, cc, d);
          }
        }
      },
      extrude(ring, y0, h, c) {
        const v0 = this.pos.length / 3;
        const m = ring.length;
        for (let i = 0; i < m; i++) {
          const a = ring[i], b = ring[(i + 1) % m];
          const dx = b[0] - a[0], dz = b[1] - a[1];
          const l = Math.hypot(dx, dz) || 1;
          const n = [dz / l, 0, -dx / l];
          const k = this.pos.length / 3;
          this._push([a[0], y0, a[1]], n, c, 0);
          this._push([b[0], y0, b[1]], n, c, 0);
          this._push([b[0], y0 + h, b[1]], n, c, 0);
          this._push([a[0], y0 + h, a[1]], n, c, 0);
          this.idx.push(k, k + 1, k + 2, k, k + 2, k + 3);
        }
        // flat roof via fan from centroid (footprints are near-convex enough)
        let sx = 0, sz = 0;
        for (const p of ring) { sx += p[0]; sz += p[1]; }
        sx /= m; sz /= m;
        const rc = this.pos.length / 3;
        const rcol = [c[0] * 0.72, c[1] * 0.72, c[2] * 0.70];
        this._push([sx, y0 + h, sz], [0, 1, 0], rcol, 0);
        for (let i = 0; i < m; i++) this._push([ring[i][0], y0 + h, ring[i][1]], [0, 1, 0], rcol, 0);
        for (let i = 0; i < m; i++) this.idx.push(rc, rc + 1 + i, rc + 1 + ((i + 1) % m));
      },
      build(gl) {
        const mesh = new root.GLX.Mesh(gl);
        mesh.attr(0, new Float32Array(this.pos), 3);
        mesh.attr(1, new Float32Array(this.nrm), 3);
        mesh.attr(2, new Float32Array(this.col), 3);
        mesh.attr(3, new Float32Array(this.wav), 1);
        mesh.index(new Uint32Array(this.idx));
        return mesh;
      }
    };
  }

  root.Foliage = {
    buildTreeMesh, scatterTrees, packTrees,
    bladeMesh, scatterGrass, propBuilder, ARCHETYPES
  };
})(window);
