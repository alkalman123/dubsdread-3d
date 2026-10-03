/* Ball flight, strike quality and putting for the POC.
 *
 * js/shot.js already integrates drag and Magnus properly and bounces off the
 * surface it lands on. What it does not have is any notion of a *golfer*: every
 * shot is a tour-average launch monitor number, the lie the ball is sitting in
 * has no effect on the strike, the tree line the whole hole is framed by is not
 * solid, and once the ball is on the green there is nothing left to do.
 *
 * This adds the parts that make it a game rather than a visualiser:
 *
 *   lies      what you can actually do with the ball from where it finished
 *   strike    contact quality driving smash, spin, launch and start direction
 *   trees     canopy and trunk collision, so the corridor matters
 *   wind      a boundary-layer profile, so a high shot is a different shot
 *   air       density from temperature and elevation
 *   putting   stimpmeter roll on the real green surface, with cup capture
 */
(function (root) {
  'use strict';

  const { clamp, lerp, rng } = root.MM;
  const Shot = root.Shot;

  const MASS = 0.04593, RADIUS = 0.02134;
  const AREA = Math.PI * RADIUS * RADIUS;
  const G = 9.80665;
  const M2Y = 1.09361, Y2M = 0.9144, MPH = 2.23694;
  const COURSE_ALT = 180;                 // metres, Lemont

  /* Loft-ish ordering, used to decide how much a bad lie hurts a given club:
     a 5 iron out of thick rough is a much worse idea than a sand wedge. */
  const CLUB_LOFT = {
    D: 10.5, '3w': 15, '5w': 18, '3i': 21, '4i': 24, '5i': 27, '6i': 30,
    '7i': 34, '8i': 38, '9i': 42, PW: 46, GW: 50, SW: 55, LW: 60
  };

  /**
   * What each lie does to the strike.
   *
   *  speed   ball-speed multiplier for a clean strike from this lie
   *  spin    backspin multiplier (grass between face and ball kills spin)
   *  launch  degrees added to launch angle
   *  disp    multiplier on start-direction scatter
   *  flyer   chance the ball comes out hot with no spin
   *  loftDep how much the penalty is reduced by using a lofted club
   *  playable false when the ball has to be dropped
   */
  const LIES = {
    tee:     { speed: 1.00, spin: 1.00, launch: 0.0, disp: 1.00, flyer: 0.00, loftDep: 0.0, name: 'Tee', note: 'Teed up' },
    fairway: { speed: 0.995, spin: 1.00, launch: 0.0, disp: 1.05, flyer: 0.02, loftDep: 0.0, name: 'Fairway', note: 'Clean lie' },
    fringe:  { speed: 0.97, spin: 0.90, launch: 0.6, disp: 1.15, flyer: 0.05, loftDep: 0.1, name: 'Fringe', note: 'Sitting down slightly' },
    green:   { speed: 1.00, spin: 1.00, launch: 0.0, disp: 1.00, flyer: 0.00, loftDep: 0.0, name: 'Green', note: 'Putting surface' },
    rough:   { speed: 0.86, spin: 0.58, launch: 2.2, disp: 1.9, flyer: 0.30, loftDep: 0.55, name: 'Rough', note: 'Grass will grab the hosel' },
    native:  { speed: 0.64, spin: 0.42, launch: 4.5, disp: 3.0, flyer: 0.12, loftDep: 0.75, name: 'Native area', note: 'Wedge it out' },
    sand:    { speed: 0.58, spin: 1.30, launch: 8.0, disp: 2.4, flyer: 0.00, loftDep: 0.70, name: 'Bunker', note: 'Splash it' },
    path:    { speed: 0.96, spin: 0.72, launch: 0.0, disp: 1.6, flyer: 0.08, loftDep: 0.0, name: 'Cart path', note: 'No divot — pick it clean' },
    water:   { speed: 0.00, spin: 0.00, launch: 0.0, disp: 1.0, flyer: 0.00, loftDep: 0.0, name: 'Water', note: 'Penalty drop', playable: false }
  };

  /**
   * Dispersion, in degrees of start direction, that the player cannot control.
   *
   * Calibrated against published shot-pattern data rather than picked by feel:
   * offline standard deviation runs about 5-6% of carry for a tour player and
   * 9-11% for a mid handicap, which is roughly 3 to 6 degrees once curvature is
   * added on top. The values here were a third of that, which made every
   * skill level's landing zone about ten yards wide — narrow enough that the
   * whole question of whether you can hold a fairway disappeared.
   */
  const SKILL = {
    tour:   { disp: 1.90, strike: 0.96, puttErr: 0.010, name: 'Tour Professional' },
    low:    { disp: 2.90, strike: 0.90, puttErr: 0.020, name: 'Low Handicap' },
    mid:    { disp: 4.10, strike: 0.80, puttErr: 0.035, name: 'Mid Handicap' },
    senior: { disp: 4.80, strike: 0.76, puttErr: 0.045, name: 'Senior / Ladies' }
  };

  /** Air density from temperature and the course's elevation. */
  function airDensity(tempC) {
    const T = (tempC === undefined ? 22 : tempC) + 273.15;
    const p = 101325 * Math.pow(1 - 2.25577e-5 * COURSE_ALT, 5.25588);
    return p / (287.058 * T);
  }

  /**
   * Wind at height h.
   *
   * The number on the HUD is the wind at 10 m, which is where it is measured.
   * A power-law boundary-layer profile means a wedge held up into a breeze is
   * hurt far more than a punch shot under it, which is the single most useful
   * thing wind does to golf strategy.
   */
  function windAt(h, base, gust) {
    const f = Math.pow(Math.max(h, 0.6) / 10, 0.16) * gust;
    return [base[0] * f, base[1] * f];
  }

  /* ------------------------------------------------------------- colliders
   * A uniform grid over the trees near the hole. Built once per hole; the flight
   * integrator only ever tests the cell the ball is in.
   */

  function buildTreeColliders(trees, spine, maxDist) {
    const CELL = 24;
    const cells = new Map();
    const A = root.Foliage.ARCHETYPES;

    // Reject the great majority of the property's trees on a bounding box first.
    // The exact test is O(spine length) per tree, and with ~15k trees against a
    // 200-point centreline that is three million segment projections for every
    // hole change — enough to be felt as a stutter.
    let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
    for (const p of spine) {
      if (p[0] < bx0) bx0 = p[0];
      if (p[0] > bx1) bx1 = p[0];
      if (p[1] < bz0) bz0 = p[1];
      if (p[1] > bz1) bz1 = p[1];
    }
    bx0 -= maxDist; bx1 += maxDist; bz0 -= maxDist; bz1 += maxDist;

    const near = (x, z) => {
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
    let n = 0;
    for (const t of trees) {
      if (t.x < bx0 || t.x > bx1 || t.z < bz0 || t.z > bz1) continue;
      if (near(t.x, t.z) > maxDist) continue;
      const a = A[t.arch];
      const sy = t.scale * t.hScale;
      const c = {
        x: t.x, z: t.z, base: t.y,
        // canopy as an ellipsoid, which is what the blob cluster amounts to
        cy: t.y + 0.62 * sy,
        ry: 0.40 * sy,
        rxz: a.spread * 1.02 * t.scale,
        trunkR: Math.max(a.trunkR * 2.4 * t.scale, 0.10),
        trunkTop: t.y + (a.lift + 0.06) * sy,
        top: t.y + sy
      };
      const key = ((c.x / CELL) | 0) + ',' + ((c.z / CELL) | 0);
      let list = cells.get(key);
      if (!list) cells.set(key, list = []);
      list.push(c);
      n++;
    }
    return {
      cells, cell: CELL, count: n,
      at(x, z) {
        const out = [];
        const i = (x / CELL) | 0, j = (z / CELL) | 0;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const l = cells.get((i + di) + ',' + (j + dj));
            if (l) for (const c of l) out.push(c);
          }
        }
        return out;
      }
    };
  }

  /**
   * Does the segment from p0 to p1 hit a tree?
   * Returns null, or { kind, point, normal }.
   */
  function treeHit(colliders, p0, p1) {
    if (!colliders) return null;
    const list = colliders.at(p1[0], p1[2]);
    for (const c of list) {
      if (p1[1] > c.top + 0.4 || p1[1] < c.base - 0.5) continue;
      const dx = p1[0] - c.x, dz = p1[2] - c.z;
      const rr = Math.hypot(dx, dz);
      if (rr > c.rxz + 0.3) continue;

      // trunk first: a small, solid, near-vertical cylinder
      if (p1[1] < c.trunkTop && rr < c.trunkR) {
        const l = rr || 1e-4;
        return { kind: 'trunk', point: [p1[0], p1[1], p1[2]], normal: [dx / l, 0, dz / l] };
      }
      // canopy: ellipsoid test
      const ny = (p1[1] - c.cy) / c.ry;
      const nx = dx / c.rxz, nz = dz / c.rxz;
      if (nx * nx + ny * ny + nz * nz < 1.0) {
        const l = Math.hypot(nx, ny, nz) || 1e-4;
        return { kind: 'canopy', point: [p1[0], p1[1], p1[2]],
                 normal: [nx / l, ny / l, nz / l] };
      }
    }
    return null;
  }

  /* ------------------------------------------------------------- full shot */

  /**
   * @param o.origin/aim/club/profile/field   as js/shot.js
   * @param o.lie          surface key the ball is sitting on
   * @param o.power        0.2..1.1 swing effort
   * @param o.strike       0..1 contact quality (1 = flush)
   * @param o.faceErr      -1..1 open/closed at impact -> start line + curve
   * @param o.shape        -1 draw .. +1 fade, intended
   * @param o.wind         [vx, vz] at 10 m
   * @param o.gust         multiplier for this particular shot
   * @param o.tempC        air temperature
   * @param o.colliders    tree colliders, or null to fly through them
   * @param o.pin          [x,y,z] for flagstick collision
   * @param o.seed         makes the whole shot reproducible
   * @param o.deterministic drop every random term: the expected shot, not a
   *        sample of it. What the caddie and the club-selection search must use
   *        — a fixed seed is NOT the same thing, because a fixed seed makes a
   *        one-in-three event happen every single time.
   */
  function simulate(o) {
    const club = Shot.clubBy(o.club);
    const prof = Shot.PROFILES.find(p => p.id === o.profile) || Shot.PROFILES[0];
    const skill = SKILL[o.profile] || SKILL.tour;
    const field = o.field;
    const lie = LIES[o.lie] || LIES.fairway;
    const R = rng((o.seed === undefined ? 1 : o.seed) | 0);
    const det = !!o.deterministic;

    const power = clamp(o.power === undefined ? 1 : o.power, 0.2, 1.12);
    const strike = clamp(o.strike === undefined ? 1 : o.strike, 0, 1);
    const faceErr = clamp(o.faceErr || 0, -1, 1);
    const shape = clamp(o.shape || 0, -1, 1);

    /* --- how the lie and the strike change the launch ------------------- */
    const loft = CLUB_LOFT[club.id] || 30;
    // a lofted club escapes a bad lie better: it gets under the ball
    const relief = lie.loftDep * clamp((loft - 12) / 46, 0, 1);
    const lieSpeed = lie.speed + (1 - lie.speed) * relief;
    const lieSpin = lie.spin + (1 - lie.spin) * relief * 0.6;

    /* Flyer: grass slides between the face and the ball, spin collapses and the
     * shot comes out hot. The classic reason a good player fears light rough.
     *
     * Loft-dependent in both frequency and severity. A flyer is a lofted-club
     * phenomenon — it needs a face that was going to impart a lot of spin for
     * losing that spin to matter. Applied flat, a 5 iron out of the rough loses
     * so much spin that it stops generating lift, knuckles, and runs out to
     * roughly twice the distance the shot was planned for, which is not a flyer,
     * it is a bug that looks like one. */
    const loftF = clamp((loft - 20) / 34, 0, 1);       // 0 long iron .. 1 wedge
    const flyer = !det && R() < (lie.flyer || 0) * (1 - relief * 0.5) * (0.30 + 0.70 * loftF);

    // Contact quality. A mishit loses ball speed, and off-centre contact both
    // starts the ball offline and puts curve on it (gear effect).
    const q = strike;
    const smash = 0.865 + 0.135 * q + (flyer ? 0.035 : 0);
    const fat = q < 0.62 && !det && R() < 0.5;
    const thin = q < 0.62 && !fat;

    let speed = club.speed * prof.speed * power * lieSpeed * smash;
    let launchDeg = club.launch + lie.launch + (fat ? 1.8 : thin ? -3.2 : 0)
                  + (flyer ? -1.2 * loftF : 0);
    let spinRpm = club.spin * prof.spin * lieSpin
                * (thin ? 1.22 : fat ? 0.72 : 1.0)
                * (flyer ? (0.82 - 0.34 * loftF) : 1.0)
                * (power > 1.0 ? 1.06 : 1.0);

    /* --- start direction ------------------------------------------------ */
    // Gaussian-ish from two uniforms, so the tails are not square
    const gauss = () => (det ? 0 : (R() + R() + R() - 1.5) / 0.866);
    const uncontrolled = gauss() * skill.disp * lie.disp * (0.7 + 0.3 * (1 - q));
    const fromFace = faceErr * 3.4;            // degrees of push/pull
    const startDeg = uncontrolled + fromFace + (o.pushDeg || 0);

    // Curvature: intended shape plus gear effect from the face error. A pushed
    // shot with an open face keeps going right.
    const curve = shape + faceErr * 0.55 + gauss() * 0.10 * lie.disp;

    const aim = o.aim + startDeg * Math.PI / 180;
    const fwd = [Math.cos(aim), 0, Math.sin(aim)];
    const side = [-Math.sin(aim), 0, Math.cos(aim)];

    const launch = launchDeg * Math.PI / 180;
    const dirX = fwd[0] * Math.cos(launch), dirZ = fwd[2] * Math.cos(launch);
    const dirY = Math.sin(launch);
    const dl = Math.hypot(dirX, dirY, dirZ) || 1;

    const v = [dirX / dl * speed, dirY / dl * speed, dirZ / dl * speed];
    const p = [o.origin[0], o.origin[1] + 0.02, o.origin[2]];

    const tilt = -clamp(curve, -1.6, 1.6) * 0.26;
    const axis = [side[0] * Math.cos(tilt), Math.sin(tilt), side[2] * Math.cos(tilt)];
    const al = Math.hypot(axis[0], axis[1], axis[2]) || 1;
    axis[0] /= al; axis[1] /= al; axis[2] /= al;

    let omega = spinRpm * (2 * Math.PI / 60);
    const RHO = airDensity(o.tempC);
    const wind = o.wind || [0, 0];
    const gust = o.gust === undefined ? 1 : o.gust;

    const dt = 1 / 600;
    const path = [[p[0], p[1], p[2]]];
    let t = 0, apex = p[1], hitTree = null, hitPin = false;
    const ground = x => field.height(x[0], x[2]);
    const prev = [p[0], p[1], p[2]];

    while (t < 16) {
      const w = windAt(p[1] - o.origin[1] + 1.0, wind, gust);
      const rvx = v[0] - w[0], rvy = v[1], rvz = v[2] - w[1];
      const rv = Math.hypot(rvx, rvy, rvz) || 1e-6;

      const S = clamp(omega * RADIUS / rv, 0, 0.6);
      const Cl = Math.min(0.60 * Math.pow(S, 0.52), 0.34);
      const Cd = 0.198 + 0.30 * S;

      const qA = 0.5 * RHO * AREA;
      const fd = -qA * Cd * rv / MASS;
      const lx = axis[1] * rvz - axis[2] * rvy;
      const ly = axis[2] * rvx - axis[0] * rvz;
      const lz = axis[0] * rvy - axis[1] * rvx;
      const ll = Math.hypot(lx, ly, lz) || 1e-6;
      const fl = qA * Cl * rv * rv / MASS;

      v[0] += (fd * rvx + fl * lx / ll) * dt;
      v[1] += (fd * rvy + fl * ly / ll - G) * dt;
      v[2] += (fd * rvz + fl * lz / ll) * dt;

      prev[0] = p[0]; prev[1] = p[1]; prev[2] = p[2];
      p[0] += v[0] * dt; p[1] += v[1] * dt; p[2] += v[2] * dt;
      omega *= Math.exp(-0.055 * dt);
      t += dt;
      if (p[1] > apex) apex = p[1];

      /* --- the tree line is solid -------------------------------------- */
      if (o.colliders && !hitTree) {
        const h = treeHit(o.colliders, prev, p);
        if (h) {
          hitTree = h.kind;
          path.push([p[0], p[1], p[2]]);
          const sp = Math.hypot(v[0], v[1], v[2]);
          if (h.kind === 'trunk') {
            // a trunk strike is a rebound, and it goes almost anywhere
            const n = h.normal;
            const vn = v[0] * n[0] + v[2] * n[2];
            v[0] = (v[0] - 2 * vn * n[0]) * 0.34;
            v[2] = (v[2] - 2 * vn * n[2]) * 0.34;
            v[1] = Math.abs(v[1]) * 0.20 + sp * 0.05;
            v[0] += (R() - 0.5) * sp * 0.18;
            v[2] += (R() - 0.5) * sp * 0.18;
          } else {
            // branches and leaves: most of the speed goes, and it drops
            const k = 0.16 + R() * 0.16;
            v[0] *= k; v[2] *= k;
            v[1] = Math.min(v[1], 0) * 0.3 - 1.2;
            v[0] += (R() - 0.5) * sp * 0.06;
            v[2] += (R() - 0.5) * sp * 0.06;
          }
          omega *= 0.25;
        }
      }

      /* --- the flagstick is solid too ---------------------------------- */
      if (o.pin && !hitPin && p[1] < o.pin[1] + 2.3 && p[1] > o.pin[1]) {
        const dpx = p[0] - o.pin[0], dpz = p[2] - o.pin[2];
        if (dpx * dpx + dpz * dpz < 0.0022) {           // ~47 mm
          hitPin = true;
          path.push([p[0], p[1], p[2]]);
          v[0] *= -0.22; v[2] *= -0.22; v[1] = -1.0;
          omega *= 0.2;
        }
      }

      const g = ground(p);
      if (p[1] <= g) { p[1] = g; path.push([p[0], p[1], p[2]]); break; }
      if (path.length < 4000 && (path.length < 2 || (t * 600) % 3 < 1)) {
        path.push([p[0], p[1], p[2]]);
      }
    }

    const carry = Math.hypot(p[0] - o.origin[0], p[2] - o.origin[2]);
    const landSpeed = Math.hypot(v[0], v[1], v[2]);
    const descent = Math.atan2(-v[1], Math.hypot(v[0], v[2])) * 180 / Math.PI;
    const landPoint = [p[0], p[1], p[2]];
    const landSurface = field.surfaceAt(p[0], p[2]);

    /* --- bounce and roll: unchanged model, re-integrated here ---------- */
    const roll = [[p[0], p[1], p[2]]];
    const rp = [p[0], p[1], p[2]];
    const rv2 = [v[0], v[2]];
    let vy = v[1], bounces = 0;
    let surface = landSurface;
    let wet = surface === 'water';

    if (!wet) {
      const rdt = 1 / 240;
      let rt = 0;
      while (bounces < 8 && rt < 12) {
        const S = Shot.SURFACE[surface] || Shot.SURFACE.rough;
        const vn = Math.max(-vy, 0);
        let vt = Math.hypot(rv2[0], rv2[1]);
        if (vn < 0.8) break;
        const spinCheck = clamp(omega / 620, 0, 1.4) * S.grab;
        const e = S.e * (1 - clamp(spinCheck, 0, 1) * 0.35);
        const mu = S.mu * (1 + spinCheck * 0.75);
        const dvt = Math.min(vt, mu * (1 + e) * vn);
        if (vt > 1e-4) { const k = (vt - dvt) / vt; rv2[0] *= k; rv2[1] *= k; }
        vy = vn * e;
        omega *= 0.45;
        bounces++;
        if (vy < 0.6) break;
        let hop = 0;
        while (hop < 4) {
          vy -= G * rdt;
          rp[0] += rv2[0] * rdt; rp[2] += rv2[1] * rdt; rp[1] += vy * rdt;
          rt += rdt; hop += rdt;
          const g = field.height(rp[0], rp[2]);
          if (rp[1] <= g && vy < 0) { rp[1] = g; break; }
          roll.push([rp[0], rp[1], rp[2]]);
        }
        surface = field.surfaceAt(rp[0], rp[2]);
        if (surface === 'water') { wet = true; break; }
        roll.push([rp[0], rp[1], rp[2]]);
      }
      if (!wet) {
        let speed2 = Math.hypot(rv2[0], rv2[1]);
        let guard = 0;
        while (guard++ < 6000) {
          surface = field.surfaceAt(rp[0], rp[2]);
          if (surface === 'water') { wet = true; break; }
          const S = Shot.SURFACE[surface] || Shot.SURFACE.rough;
          const n = field.normal(rp[0], rp[2]);
          const gx = -n[0] * G, gz = -n[2] * G;
          const slope = Math.hypot(gx, gz);
          const fr = S.roll * G;
          if (speed2 > 1e-3) {
            const ux = rv2[0] / speed2, uz = rv2[1] / speed2;
            rv2[0] += (gx - ux * fr) * rdt;
            rv2[1] += (gz - uz * fr) * rdt;
          } else if (slope > fr) {
            rv2[0] += gx * rdt; rv2[1] += gz * rdt;
          } else break;
          speed2 = Math.hypot(rv2[0], rv2[1]);
          rp[0] += rv2[0] * rdt; rp[2] += rv2[1] * rdt;
          rp[1] = field.height(rp[0], rp[2]);
          if (guard % 4 === 0) roll.push([rp[0], rp[1], rp[2]]);
          if (speed2 < 0.12 && slope <= fr) break;
        }
      }
    }
    roll.push([rp[0], rp[1], rp[2]]);

    const finalSurface = wet ? 'water' : field.surfaceAt(rp[0], rp[2]);
    const total = Math.hypot(rp[0] - o.origin[0], rp[2] - o.origin[2]);
    // signed offline distance from the intended line
    const ax = Math.cos(o.aim), az = Math.sin(o.aim);
    const rx = rp[0] - o.origin[0], rz = rp[2] - o.origin[2];
    const offline = (-az * rx + ax * rz);

    return {
      path, roll, landPoint, finalPoint: [rp[0], rp[1], rp[2]],
      landSurface, finalSurface,
      hitTree, hitPin, flyer, fat, thin,
      stats: {
        ballSpeed: speed * MPH,
        launchAngle: launchDeg,
        spin: Math.round(spinRpm),
        carryYd: carry * M2Y,
        totalYd: total * M2Y,
        apexM: apex - o.origin[1],
        apexYd: (apex - o.origin[1]) * M2Y,
        hangTime: t,
        descentAngle: descent,
        landSpeed: landSpeed * MPH,
        rollYd: (total - carry) * M2Y,
        club: club.name,
        clubId: club.id,
        offlineYd: offline * M2Y,
        startDeg: startDeg,
        strike: q,
        smash: smash
      }
    };
  }

  /* --------------------------------------------------------------- putting
   * Stimpmeter physics. The USGA device releases a ball at 1.83 m/s; the green
   * speed in feet is how far it then rolls on the level. That fixes the rolling
   * deceleration exactly, which is why a green speed is a physical measurement
   * and not a feel setting.
   *
   * Gravity along the surface gets the 5/7 factor for a sphere rolling without
   * slipping — the rest of the energy goes into rotation.
   */

  function puttDecel(stimp) {
    const d = stimp * 0.3048;
    return (1.83 * 1.83) / (2 * d);
  }

  /**
   * @param o.origin [x,y,z]  @param o.aim radians  @param o.speed m/s
   * @param o.field           @param o.pin [x,y,z]  @param o.stimp feet
   */
  function putt(o) {
    const field = o.field;
    const stimp = o.stimp || 11;
    const pin = o.pin;
    const dt = 1 / 240;
    const p = [o.origin[0], field.height(o.origin[0], o.origin[2]), o.origin[2]];
    const v = [Math.cos(o.aim) * o.speed, Math.sin(o.aim) * o.speed];
    const path = [[p[0], p[1], p[2]]];

    let holed = false, lipOut = false, t = 0;
    let maxBreak = 0;
    const startAim = o.aim;

    let guard = 0;
    while (guard++ < 8000) {
      const surf = field.surfaceAt(p[0], p[2]);
      // off the surface the ball is running through grass, not rolling on it
      const mul = surf === 'green' ? 1 : surf === 'fringe' ? 2.4
                : surf === 'fairway' || surf === 'tee' ? 3.4 : 9.0;
      const a = puttDecel(stimp) * mul;

      const n = field.normal(p[0], p[2]);
      const gx = -n[0] * G * (5 / 7), gz = -n[2] * G * (5 / 7);

      const sp = Math.hypot(v[0], v[1]);
      if (sp > 1e-4) {
        v[0] += (gx - v[0] / sp * a) * dt;
        v[1] += (gz - v[1] / sp * a) * dt;
      } else {
        const slope = Math.hypot(gx, gz);
        if (slope <= a) break;
        v[0] += gx * dt; v[1] += gz * dt;
      }

      p[0] += v[0] * dt; p[2] += v[1] * dt;
      p[1] = field.height(p[0], p[2]);
      t += dt;

      /* --- the cup ----------------------------------------------------- */
      if (pin) {
        const d = Math.hypot(p[0] - pin[0], p[2] - pin[2]);
        if (d < 0.075) {
          const speed = Math.hypot(v[0], v[1]);
          // A ball travelling faster than roughly 1.6 m/s across the hole can
          // run right over it; between that and a dead weight it lips out.
          const offset = d / 0.054;
          const capture = 1.62 * (1 - offset * 0.42);
          if (speed < capture) {
            holed = true;
            path.push([pin[0], p[1] - 0.02, pin[2]]);
            break;
          } else if (speed < capture * 1.45) {
            lipOut = true;
            // thrown out tangentially, having lost most of its speed
            const tx = -(p[2] - pin[2]) / (d || 1e-4), tz = (p[0] - pin[0]) / (d || 1e-4);
            const s2 = speed * 0.42;
            v[0] = tx * s2; v[1] = tz * s2;
          }
        }
      }

      const along = (p[0] - o.origin[0]) * Math.cos(startAim) + (p[2] - o.origin[2]) * Math.sin(startAim);
      const across = -(p[0] - o.origin[0]) * Math.sin(startAim) + (p[2] - o.origin[2]) * Math.cos(startAim);
      if (Math.abs(across) > Math.abs(maxBreak)) maxBreak = across;

      if (guard % 3 === 0) path.push([p[0], p[1], p[2]]);
      const sp2 = Math.hypot(v[0], v[1]);
      const slope2 = Math.hypot(gx, gz);
      if (sp2 < 0.035 && slope2 <= puttDecel(stimp) * mul) break;
      if (t > 22) break;
    }
    path.push([p[0], p[1], p[2]]);

    const dist = Math.hypot(p[0] - o.origin[0], p[2] - o.origin[2]);
    return {
      path, holed, lipOut,
      finalPoint: [p[0], p[1], p[2]],
      finalSurface: field.surfaceAt(p[0], p[2]),
      distM: dist,
      breakM: maxBreak,
      hangTime: t,
      toPin: pin ? Math.hypot(p[0] - pin[0], p[2] - pin[2]) : 0
    };
  }

  /**
   * Speed needed to finish `dist` metres away on level ground, plus whatever
   * the slope along the way does to it. Solved by bisection on the real roll,
   * so it accounts for the actual contour rather than a flat approximation.
   */
  function puttSpeedFor(o, targetDist) {
    let lo = 0.3, hi = 9.0, best = 1.5;
    for (let i = 0; i < 9; i++) {
      const mid = (lo + hi) / 2;
      const r = putt(Object.assign({}, o, { speed: mid, pin: null }));
      if (r.distM < targetDist) lo = mid; else hi = mid;
      best = mid;
    }
    return best;
  }

  /**
   * Read of the putt: the aim offset, in degrees, that holes it.
   * Used both by the caddie overlay and by the auto-putt.
   */
  function readPutt(o) {
    const pin = o.pin;
    const straight = Math.atan2(pin[2] - o.origin[2], pin[0] - o.origin[0]);
    const dist = Math.hypot(pin[0] - o.origin[0], pin[2] - o.origin[2]);
    // aim for about 0.4 m past the hole, the standard "die it in" pace
    let bestAim = straight, bestSpeed = 1.5, bestMiss = 1e9;
    for (let pass = 0; pass < 2; pass++) {
      const span = pass === 0 ? 0.16 : 0.03;
      const steps = pass === 0 ? 9 : 7;
      const centre = bestAim;
      for (let i = 0; i < steps; i++) {
        const aim = centre + (i / (steps - 1) - 0.5) * 2 * span;
        const speed = puttSpeedFor({ origin: o.origin, aim, field: o.field, stimp: o.stimp },
                                   dist + 0.45);
        const r = putt({ origin: o.origin, aim, speed, field: o.field, stimp: o.stimp, pin });
        const miss = r.holed ? -1 : r.toPin;
        if (miss < bestMiss) { bestMiss = miss; bestAim = aim; bestSpeed = speed; }
      }
    }
    let d = (bestAim - straight) * 180 / Math.PI;
    return { aim: bestAim, speed: bestSpeed, offsetDeg: d, holes: bestMiss < 0, straight, dist };
  }

  root.ShotPoc = {
    simulate, putt, puttSpeedFor, readPutt, puttDecel,
    buildTreeColliders, treeHit, airDensity, windAt,
    LIES, SKILL, CLUB_LOFT
  };
})(window);
