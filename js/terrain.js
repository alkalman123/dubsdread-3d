/* Terrain meshes.
 *
 * Two shells share one height function: a fine grid over the hole in play and a
 * coarse grid over the rest of the property.  The coarse grid skips any cell the
 * fine grid already covers, so there is no overlap and nothing to z-fight.
 */
(function (root) {
  'use strict';

  const { clamp, smoothstep } = root.MM;

  function buildGrid(gl, field, opts) {
    const { x0, z0, size, res } = opts;
    const skip = opts.skip || null;      // {x0,z0,x1,z1} region to punch out
    const step = size / res;
    const n = res + 1;

    const pos = new Float32Array(n * n * 3);
    const nrm = new Float32Array(n * n * 3);
    const ao = new Float32Array(n * n);

    for (let j = 0; j < n; j++) {
      const z = z0 + j * step;
      for (let i = 0; i < n; i++) {
        const x = x0 + i * step;
        const k = j * n + i;
        pos[k * 3] = x;
        pos[k * 3 + 1] = field.height(x, z);
        pos[k * 3 + 2] = z;
      }
    }

    // normals from the height grid (central differences, correct across seams
    // because we resample the field rather than the local array at the border)
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const x = pos[k * 3], z = pos[k * 3 + 2];
        const hL = i > 0 ? pos[(k - 1) * 3 + 1] : field.height(x - step, z);
        const hR = i < n - 1 ? pos[(k + 1) * 3 + 1] : field.height(x + step, z);
        const hD = j > 0 ? pos[(k - n) * 3 + 1] : field.height(x, z - step);
        const hU = j < n - 1 ? pos[(k + n) * 3 + 1] : field.height(x, z + step);
        let nx = hL - hR, ny = 2 * step, nz = hD - hU;
        const l = Math.hypot(nx, ny, nz) || 1;
        nrm[k * 3] = nx / l; nrm[k * 3 + 1] = ny / l; nrm[k * 3 + 2] = nz / l;

        // cheap curvature AO: concave ground collects shadow
        const h = pos[k * 3 + 1];
        const curv = (hL + hR + hD + hU) * 0.25 - h;
        ao[k] = clamp(1.0 - Math.max(curv, 0) * 0.42, 0.35, 1.0);
      }
    }

    // wide-radius AO from the height field: valleys and bunker floors darken
    const R = Math.max(1, Math.round(6 / step));
    const ao2 = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const h = pos[k * 3 + 1];
        let occ = 0, cnt = 0;
        for (let d = 0; d < 8; d++) {
          const a = d / 8 * Math.PI * 2;
          const di = Math.round(Math.cos(a) * R), dj = Math.round(Math.sin(a) * R);
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
          const hh = pos[(jj * n + ii) * 3 + 1];
          occ += clamp((hh - h) / (R * step) * 1.6, 0, 1);
          cnt++;
        }
        ao2[k] = ao[k] * clamp(1 - (cnt ? occ / cnt : 0) * 0.75, 0.28, 1.0);
      }
    }

    const idx = [];
    for (let j = 0; j < res; j++) {
      const z = z0 + (j + 0.5) * step;
      for (let i = 0; i < res; i++) {
        const x = x0 + (i + 0.5) * step;
        if (skip && x > skip.x0 && x < skip.x1 && z > skip.z0 && z < skip.z1) continue;
        const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
        // split along the shorter diagonal to avoid ridging on saddles
        const ha = pos[a * 3 + 1], hb = pos[b * 3 + 1], hc = pos[c * 3 + 1], hd = pos[d * 3 + 1];
        if (Math.abs(ha - hd) < Math.abs(hb - hc)) {
          idx.push(a, c, d, a, d, b);
        } else {
          idx.push(a, c, b, b, c, d);
        }
      }
    }

    const mesh = new root.GLX.Mesh(gl);
    mesh.attr(0, pos, 3).attr(1, nrm, 3).attr(2, ao2, 1);
    mesh.index(new Uint32Array(idx));
    mesh.tris = idx.length / 3;
    return mesh;
  }

  /** Flat quads at each pond level, clipped in the shader by the water SDF. */
  function buildWater(gl, field) {
    const pos = [];
    const idx = [];
    let base = 0;
    for (const p of field.pools.list) {
      const pad = 6;
      const x0 = p.minx - pad, x1 = p.maxx + pad;
      const z0 = p.minz - pad, z1 = p.maxz + pad;
      const y = p.level;
      pos.push(x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1);
      idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
      base += 4;
    }
    if (!pos.length) return null;
    const mesh = new root.GLX.Mesh(gl);
    mesh.attr(0, new Float32Array(pos), 3);
    mesh.index(new Uint32Array(idx));
    return mesh;
  }

  root.Terrain = { buildGrid, buildWater };
})(window);
