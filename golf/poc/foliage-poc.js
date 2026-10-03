/* Leaf-card foliage.
 *
 * The canopy in js/foliage.js is a cluster of squashed spheres, and that is the
 * single thing holding the render back once the lighting is right. Noise-eroding
 * the silhouette (see shaders-poc.js) hides it at distance, but the giveaway
 * survives at any range you actually play from: a sphere shades as a sphere, so
 * the crown reads as one smooth mass with a bright top and a dark bottom rather
 * than as thousands of individual leaves catching the light at their own angles.
 *
 * This replaces the blobs with the standard solution — cards. Each canopy is a
 * few dozen quads laid over the same lobe structure the blobs described, tangent
 * to the lobe surface, each carrying a cluster of leaves in an alpha texture. The
 * texture is drawn procedurally into a canvas at startup, so nothing is
 * downloaded and the page still runs off the filesystem.
 *
 * Two details do most of the work:
 *
 *   - Cards are lit by the *lobe's* outward normal, not the quad's. A card lit by
 *     its own flat normal looks like what it is, a flat sheet; lit by the volume
 *     it sits on, a hundred of them integrate into something that reads as a
 *     crown. This is the whole trick behind card foliage.
 *   - The alpha cutoff loosens with distance. Alpha-tested foliage sparkles when
 *     a leaf is smaller than a pixel, so far canopies are allowed to close up
 *     into a solid mass instead of dissolving into noise.
 */
(function (root) {
  'use strict';

  const { clamp, lerp, rng } = root.MM;
  const ARCH = root.Foliage.ARCHETYPES;

  /* ------------------------------------------------------------- atlas */

  /**
   * Four leaf-cluster variants in a 2x2 atlas.
   *   R  per-leaf brightness (0.5 is neutral)
   *   G  yellowing, for the leaves that have turned
   *   B  a crude thickness cue, brighter where leaves overlap
   *   A  coverage
   * The species colour comes from the instance, so this carries only the
   * variation *within* a cluster.
   */
  function leafAtlas(gl, seed) {
    const S = 1024, CELL = S / 2;
    const cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const g = cv.getContext('2d');
    g.clearRect(0, 0, S, S);
    const R = rng(seed || 9001);

    for (let cell = 0; cell < 4; cell++) {
      const ox = (cell % 2) * CELL, oy = ((cell / 2) | 0) * CELL;
      const cx = ox + CELL / 2, cy = oy + CELL / 2;
      // a spread of sizes: the big leaves set the silhouette, the small ones
      // fill the interior so it does not read as a handful of blades
      const passes = [
        { n: 90, lo: 0.115, hi: 0.185, spread: 0.44, dark: 0.55 },
        { n: 130, lo: 0.075, hi: 0.130, spread: 0.40, dark: 0.78 },
        { n: 150, lo: 0.045, hi: 0.085, spread: 0.34, dark: 1.00 }
      ];
      for (const p of passes) {
        for (let i = 0; i < p.n; i++) {
          const a = R() * Math.PI * 2;
          // pow < 1 pushes samples outward, so the cluster has a ragged rim
          // rather than a dense core with a bald edge
          const rr = Math.pow(R(), 0.62) * (CELL * p.spread);
          const x = cx + Math.cos(a) * rr;
          const y = cy + Math.sin(a) * rr * 0.92;

          const len = CELL * (p.lo + R() * (p.hi - p.lo));
          const wid = len * (0.38 + R() * 0.30);
          const rot = R() * Math.PI * 2;

          // leaves deeper in the cluster sit in its own shade
          const depth = clamp(1 - rr / (CELL * p.spread), 0, 1);
          const bright = clamp((0.42 + 0.52 * (1 - depth * 0.8)) * p.dark
                               + (R() - 0.5) * 0.30, 0.05, 1);
          const yellow = R() < 0.12 ? 0.35 + R() * 0.5 : R() * 0.14;
          const thick = clamp(0.35 + depth * 0.5 + (R() - 0.5) * 0.2, 0, 1);

          g.save();
          g.translate(x, y);
          g.rotate(rot);
          g.fillStyle = 'rgba(' + Math.round(bright * 255) + ',' +
                                  Math.round(yellow * 255) + ',' +
                                  Math.round(thick * 255) + ',1)';
          // a leaf: an ellipse drawn to a point at the tip
          g.beginPath();
          g.moveTo(-len * 0.5, 0);
          g.quadraticCurveTo(0, -wid * 0.5, len * 0.5, 0);
          g.quadraticCurveTo(0, wid * 0.5, -len * 0.5, 0);
          g.closePath();
          g.fill();
          g.restore();
        }
      }
    }

    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, cv);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    const ext = gl.getExtension('EXT_texture_filter_anisotropic');
    if (ext) {
      gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT,
        Math.min(8, gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
    }
    return t;
  }

  /* -------------------------------------------------------------- trunk */

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
        out.uv.push(0, 0, 0, 0);
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

  /* --------------------------------------------------------------- tree */

  /**
   * One unit tree, ~1.0 tall. Instances scale it.
   *
   * The lobes are the same ones the blob canopy described — that shape is right,
   * it is only the surface that was wrong — but each is now covered in cards
   * laid tangent to it, plus a few inside for depth when you look into the crown.
   */
  function buildLeafTree(gl, arch, seed, density) {
    const R = rng(seed);
    const A = ARCH[arch];
    const dens = density === undefined ? 1 : density;
    const out = { pos: [], nrm: [], uv: [], idx: [] };

    /* --- trunk and limbs -------------------------------------------- */
    const trunkTop = A.lift + 0.10;
    tube(7, 5, out, t => A.trunkR * (1.0 - t * 0.55) * (1 + (1 - t) * (1 - t) * 0.9),
      t => [Math.sin(t * 1.7 + seed) * 0.02 * t, t * trunkTop, Math.cos(t * 1.3 + seed) * 0.02 * t]);
    if (A.blobs > 0) {
      for (let b = 0; b < 4; b++) {
        const ang = R() * Math.PI * 2;
        const len = 0.20 + R() * 0.18;
        const y = trunkTop - 0.06;
        tube(5, 3, out, t => 0.026 * (1 - t * 0.72),
          t => [Math.cos(ang) * len * t, y + t * 0.28, Math.sin(ang) * len * t]);
      }
    }
    const nTrunk = out.pos.length / 3;

    /* --- canopy ------------------------------------------------------ */
    const card = (px, py, pz, nx, ny, nz, size, roll, variant, bow) => {
      // an orthonormal frame with the lobe's outward normal as the card's normal
      let ax = 0, ay = 1, az = 0;
      if (Math.abs(ny) > 0.92) { ax = 1; ay = 0; az = 0; }
      let tx = ay * nz - az * ny, ty = az * nx - ax * nz, tz = ax * ny - ay * nx;
      let tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl; ty /= tl; tz /= tl;
      let bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;

      const c = Math.cos(roll), s = Math.sin(roll);
      const ux = tx * c + bx * s, uy = ty * c + by * s, uz = tz * c + bz * s;
      const vx = -tx * s + bx * c, vy = -ty * s + by * c, vz = -tz * s + bz * c;

      const cu = (variant % 2) * 0.5, cv = ((variant / 2) | 0) * 0.5;
      const v0 = out.pos.length / 3;
      // bow the card outward slightly so a cluster is not perfectly planar
      const corners = [[-1, -1, 0], [1, -1, 1], [1, 1, 2], [-1, 1, 3]];
      for (const [sx, sy, k] of corners) {
        const ox = px + (ux * sx + vx * sy) * size + nx * bow;
        const oy = py + (uy * sx + vy * sy) * size + ny * bow;
        const oz = pz + (uz * sx + vz * sy) * size + nz * bow;
        out.pos.push(ox, oy, oz);
        out.nrm.push(nx, ny, nz);
        out.uv.push(cu + (k === 1 || k === 2 ? 0.5 : 0),
                    cv + (k >= 2 ? 0.5 : 0), 1, 0);
      }
      out.idx.push(v0, v0 + 1, v0 + 2, v0, v0 + 2, v0 + 3);
    };

    if (A.blobs === 0) {
      /* conifer: cards in downward-sloping tiers, small and dense */
      const layers = 9;
      for (let i = 0; i < layers; i++) {
        const t = i / (layers - 1);
        const y = A.lift + t * (1 - A.lift) * 0.98;
        const rad = A.spread * (1 - t) * 1.02 + 0.05;
        const count = Math.max(3, Math.round((16 * (1 - t) + 4) * dens));
        for (let k = 0; k < count; k++) {
          const a = (k / count) * Math.PI * 2 + R() * 0.5;
          const rr = rad * (0.55 + R() * 0.5);
          const px = Math.cos(a) * rr, pz = Math.sin(a) * rr;
          const py = y + (R() - 0.5) * 0.04;
          // needles hang: tilt the normal down and out
          let nx = Math.cos(a) * 0.85, ny = -0.42, nz = Math.sin(a) * 0.85;
          const nl = Math.hypot(nx, ny, nz);
          nx /= nl; ny /= nl; nz /= nl;
          card(px, py, pz, nx, ny, nz, rad * 0.42 + 0.045,
               R() * Math.PI, (R() * 4) | 0, 0.01);
        }
      }
    } else {
      /* broadleaf: the blob lobes, resurfaced with cards */
      const lobes = [];
      for (let b = 0; b < A.blobs; b++) {
        const t = b / A.blobs;
        const ang = R() * Math.PI * 2;
        const rad = A.spread * (0.20 + R() * 0.72) * (1 - t * 0.25);
        lobes.push({
          cx: Math.cos(ang) * rad * 0.72,
          cy: A.lift + A.crown * (0.30 + R() * 0.72),
          cz: Math.sin(ang) * rad * 0.72,
          rx: A.spread * (0.40 + R() * 0.42) * (0.95 + R() * 0.5),
          ry: A.spread * (0.40 + R() * 0.42) * (0.55 + R() * 0.32),
          rz: A.spread * (0.40 + R() * 0.42) * (0.95 + R() * 0.5)
        });
      }
      for (const L of lobes) {
        const surf = L.rx * L.ry + L.ry * L.rz + L.rz * L.rx;
        // Card count is the canopy's whole cost, and it is alpha-tested overdraw
        // rather than triangles — the thing a phone actually minds. Fewer, larger
        // cards hold the silhouette at a fraction of the fill.
        const count = clamp(Math.round(surf * 118 * dens), 7, 36);
        for (let i = 0; i < count; i++) {
          // Fibonacci sphere, jittered: even coverage without clumping at a pole
          const u = (i + 0.5) / count;
          const phi = Math.acos(1 - 2 * u);
          const theta = Math.PI * (1 + Math.sqrt(5)) * i + R() * 0.7;
          let nx = Math.sin(phi) * Math.cos(theta);
          let ny = Math.cos(phi);
          let nz = Math.sin(phi) * Math.sin(theta);
          // bias the crown: fewer cards underneath, where a tree is thin
          if (ny < -0.35 && R() < 0.55) continue;
          const jit = 0.86 + R() * 0.28;
          const px = L.cx + nx * L.rx * jit;
          const py = L.cy + ny * L.ry * jit;
          const pz = L.cz + nz * L.rz * jit;
          const size = A.spread * (0.31 + R() * 0.17) / Math.sqrt(Math.max(dens, 0.35));
          card(px, py, pz, nx, ny, nz, size, R() * Math.PI * 2, (R() * 4) | 0,
               -size * 0.12);
        }
        // a few interior cards so looking into the crown is not hollow
        for (let i = 0; i < Math.round(6 * dens); i++) {
          const a = R() * Math.PI * 2, b2 = (R() - 0.5) * 1.4;
          const nx = Math.cos(a), ny = b2, nz = Math.sin(a);
          const nl = Math.hypot(nx, ny, nz) || 1;
          card(L.cx + nx * L.rx * 0.35, L.cy + ny * L.ry * 0.35, L.cz + nz * L.rz * 0.35,
               nx / nl, ny / nl, nz / nl, A.spread * 0.30,
               R() * Math.PI * 2, (R() * 4) | 0, 0);
        }
      }
    }

    const nAll = out.pos.length / 3;
    const data = new Float32Array(nAll * 4);
    for (let i = 0; i < nAll; i++) {
      data[i * 4] = i < nTrunk ? 0 : 1;          // canopy flag
      data[i * 4 + 1] = out.uv[i * 4];           // u
      data[i * 4 + 2] = out.uv[i * 4 + 1];       // v
      data[i * 4 + 3] = 0;
    }

    let radius = 0, top = 0;
    for (let i = 0; i < nAll; i++) {
      radius = Math.max(radius, Math.hypot(out.pos[i * 3], out.pos[i * 3 + 2]));
      top = Math.max(top, out.pos[i * 3 + 1]);
    }

    const mesh = new root.GLX.Mesh(gl);
    mesh.attr(0, new Float32Array(out.pos), 3);
    mesh.attr(1, new Float32Array(out.nrm), 3);
    mesh.attr(2, data, 4);
    mesh.index(new Uint32Array(out.idx));
    return { mesh, radius, top, tris: out.idx.length / 3, cards: (nAll - nTrunk) / 4 };
  }

  root.FoliagePoc = { leafAtlas, buildLeafTree };
})(window);
