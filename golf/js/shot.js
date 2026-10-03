/* Golf ball flight and roll.
 *
 * Rigid-body integration with drag and Magnus lift using the usual spin-ratio
 * fits, then a bounce-and-roll model whose restitution and friction come from
 * the surface the ball actually lands on.
 */
(function (root) {
  'use strict';

  const { clamp, lerp } = root.MM;

  const MASS = 0.04593;              // kg
  const RADIUS = 0.02134;            // m
  const AREA = Math.PI * RADIUS * RADIUS;
  const RHO = 1.225;                 // kg/m^3
  const G = 9.80665;
  const M2Y = 1.09361;
  const MPH = 2.23694;

  /* Club specs at a tour-average swing: ball speed (m/s), launch (deg), backspin (rpm). */
  const CLUBS = [
    { id: 'D',   name: 'Driver',      speed: 74.66, launch: 10.9, spin: 2686 },
    { id: '3w',  name: '3 Wood',      speed: 70.63, launch: 9.2,  spin: 3655 },
    { id: '5w',  name: '5 Wood',      speed: 67.95, launch: 9.4,  spin: 4350 },
    { id: '3i',  name: '3 Iron',      speed: 63.48, launch: 10.4, spin: 4630 },
    { id: '4i',  name: '4 Iron',      speed: 61.24, launch: 11.0, spin: 4836 },
    { id: '5i',  name: '5 Iron',      speed: 59.01, launch: 12.1, spin: 5361 },
    { id: '6i',  name: '6 Iron',      speed: 56.77, launch: 14.1, spin: 6231 },
    { id: '7i',  name: '7 Iron',      speed: 53.64, launch: 16.3, spin: 7097 },
    { id: '8i',  name: '8 Iron',      speed: 51.41, launch: 18.1, spin: 7998 },
    { id: '9i',  name: '9 Iron',      speed: 48.73, launch: 20.4, spin: 8647 },
    { id: 'PW',  name: 'Pitching W',  speed: 45.60, launch: 24.2, spin: 9304 },
    { id: 'GW',  name: 'Gap Wedge',   speed: 41.60, launch: 26.5, spin: 9600 },
    { id: 'SW',  name: 'Sand Wedge',  speed: 37.20, launch: 30.0, spin: 9900 },
    { id: 'LW',  name: 'Lob Wedge',   speed: 31.50, launch: 35.0, spin: 10200 }
  ];

  /* Player profiles scale clubhead speed and add spin the slower you swing. */
  const PROFILES = [
    { id: 'tour',   name: 'Tour Professional', speed: 1.00, spin: 1.00, label: '113 mph driver' },
    { id: 'low',    name: 'Low Handicap',      speed: 0.925, spin: 1.08, label: '104 mph driver' },
    { id: 'mid',    name: 'Mid Handicap',      speed: 0.845, spin: 1.18, label: '95 mph driver' },
    { id: 'senior', name: 'Senior / Ladies',   speed: 0.760, spin: 1.30, label: '85 mph driver' }
  ];

  /**
   * Impact and roll properties per surface.
   *   e    normal restitution
   *   mu   tangential friction during the bounce impulse
   *   roll rolling-resistance coefficient once the ball is on the deck
   *   grab how much backspin is converted into check on landing
   */
  const SURFACE = {
    green:   { e: 0.30, mu: 0.42, roll: 0.055, grab: 0.85, name: 'Green' },
    fringe:  { e: 0.28, mu: 0.50, roll: 0.090, grab: 0.70, name: 'Fringe' },
    fairway: { e: 0.34, mu: 0.52, roll: 0.115, grab: 0.45, name: 'Fairway' },
    tee:     { e: 0.34, mu: 0.52, roll: 0.115, grab: 0.45, name: 'Tee' },
    rough:   { e: 0.16, mu: 0.85, roll: 0.450, grab: 0.30, name: 'Rough' },
    native:  { e: 0.11, mu: 0.95, roll: 0.700, grab: 0.20, name: 'Native area' },
    sand:    { e: 0.07, mu: 1.10, roll: 0.950, grab: 0.15, name: 'Bunker' },
    path:    { e: 0.62, mu: 0.12, roll: 0.020, grab: 0.05, name: 'Cart path' },
    water:   { e: 0.00, mu: 1.20, roll: 1.400, grab: 0.00, name: 'Water' }
  };

  function clubBy(id) { return CLUBS.find(c => c.id === id) || CLUBS[0]; }

  /**
   * @param opts.origin   [x,y,z]
   * @param opts.aim      azimuth radians (world, 0 = +X)
   * @param opts.club     club id
   * @param opts.profile  profile id
   * @param opts.shape    -1 draw .. +1 fade
   * @param opts.power    0..1.2 multiplier
   * @param opts.wind     [vx, vz] m/s
   * @param opts.field    Field for height / surface lookups
   */
  function simulate(opts) {
    const club = clubBy(opts.club);
    const prof = PROFILES.find(p => p.id === opts.profile) || PROFILES[0];
    const field = opts.field;
    const power = clamp(opts.power === undefined ? 1 : opts.power, 0.2, 1.25);

    const speed = club.speed * prof.speed * power;
    const launch = club.launch * Math.PI / 180;
    let spin = club.spin * prof.spin * (2 * Math.PI / 60);       // rad/s
    const shape = clamp(opts.shape || 0, -1, 1);

    const aim = opts.aim;
    const fwd = [Math.cos(aim), 0, Math.sin(aim)];
    const side = [-Math.sin(aim), 0, Math.cos(aim)];

    // launch direction, tilted slightly by the intended shot shape
    const startBias = -shape * 0.020;
    const dirX = fwd[0] * Math.cos(launch) + side[0] * Math.sin(startBias);
    const dirZ = fwd[2] * Math.cos(launch) + side[2] * Math.sin(startBias);
    const dirY = Math.sin(launch);
    const dl = Math.hypot(dirX, dirY, dirZ);

    const v = [dirX / dl * speed, dirY / dl * speed, dirZ / dl * speed];
    const p = [opts.origin[0], opts.origin[1] + 0.02, opts.origin[2]];

    // Spin axis: pure backspin points along `side` (the right-hand rule vector
    // for a ball whose top is rolling backwards), so Magnus (axis x v) lifts.
    // Tilting it toward +Y bends the flight toward the fade side.
    const tilt = -shape * 0.24;
    const axis = [
      side[0] * Math.cos(tilt),
      Math.sin(tilt),
      side[2] * Math.cos(tilt)
    ];
    const al = Math.hypot(axis[0], axis[1], axis[2]) || 1;
    axis[0] /= al; axis[1] /= al; axis[2] /= al;

    const wind = opts.wind || [0, 0];
    const dt = 1 / 600;
    const path = [[p[0], p[1], p[2]]];
    let t = 0, apex = p[1], apexAt = 0;
    let omega = spin;

    const ground = x => field.height(x[0], x[2]);

    while (t < 16) {
      // relative air velocity
      const rvx = v[0] - wind[0], rvy = v[1], rvz = v[2] - wind[1];
      const rv = Math.hypot(rvx, rvy, rvz) || 1e-6;

      // spin ratio drives both coefficients (Bearman & Harvey style fits)
      const S = clamp(omega * RADIUS / rv, 0, 0.6);
      const Cl = Math.min(0.60 * Math.pow(S, 0.52), 0.34);
      const Cd = 0.198 + 0.30 * S;

      const qA = 0.5 * RHO * AREA;
      const fd = -qA * Cd * rv / MASS;                 // per unit velocity
      const ax0 = fd * rvx, ay0 = fd * rvy, az0 = fd * rvz;

      // Magnus: axis x velocity
      const lx = axis[1] * rvz - axis[2] * rvy;
      const ly = axis[2] * rvx - axis[0] * rvz;
      const lz = axis[0] * rvy - axis[1] * rvx;
      const ll = Math.hypot(lx, ly, lz) || 1e-6;
      const fl = qA * Cl * rv * rv / MASS;
      const ax1 = fl * lx / ll, ay1 = fl * ly / ll, az1 = fl * lz / ll;

      v[0] += (ax0 + ax1) * dt;
      v[1] += (ay0 + ay1 - G) * dt;
      v[2] += (az0 + az1) * dt;

      p[0] += v[0] * dt; p[1] += v[1] * dt; p[2] += v[2] * dt;
      omega *= Math.exp(-0.055 * dt);          // ~5.5 %/s spin decay
      t += dt;

      if (p[1] > apex) { apex = p[1]; apexAt = t; }

      const g = ground(p);
      if (p[1] <= g) {
        // back up to the exact crossing
        const prev = path[path.length - 1];
        p[1] = g;
        path.push([p[0], p[1], p[2]]);
        break;
      }
      if (path.length < 4000 && (path.length < 2 || t * 600 % 3 < 1)) {
        path.push([p[0], p[1], p[2]]);
      }
      if (t > 15.9) break;
    }

    const carryVec = [p[0] - opts.origin[0], p[2] - opts.origin[2]];
    const carry = Math.hypot(carryVec[0], carryVec[1]);
    const landSpeed = Math.hypot(v[0], v[1], v[2]);
    const descent = Math.atan2(-v[1], Math.hypot(v[0], v[2])) * 180 / Math.PI;
    const landPoint = [p[0], p[1], p[2]];
    const landSurface = field.surfaceAt(p[0], p[2]);

    /* ------------------------------------------------------------- roll */
    const roll = [[p[0], p[1], p[2]]];
    let rp = [p[0], p[1], p[2]];
    let rv2 = [v[0], v[2]];
    let vy = v[1];
    let bounces = 0;
    let surface = landSurface;
    let wet = surface === 'water';

    if (!wet) {
      const rdt = 1 / 240;
      let rt = 0;

      /* --- bounce phase ---------------------------------------------------
       * Each impact is an impulse: the normal component is scaled by the
       * restitution, and friction removes tangential speed up to mu*(1+e)*|vn|.
       * Backspin adds extra check on receptive turf. This is what stops a
       * wedge dead and lets a driver run out.
       */
      while (bounces < 8 && rt < 12) {
        const S = SURFACE[surface] || SURFACE.rough;
        const vn = Math.max(-vy, 0);                       // closing speed
        let vt = Math.hypot(rv2[0], rv2[1]);
        if (vn < 0.8) break;

        const spinCheck = clamp(omega / 620, 0, 1.4) * S.grab;
        const e = S.e * (1 - clamp(spinCheck, 0, 1) * 0.35);
        const mu = S.mu * (1 + spinCheck * 0.75);

        const dvt = Math.min(vt, mu * (1 + e) * vn);
        if (vt > 1e-4) {
          const k = (vt - dvt) / vt;
          rv2[0] *= k; rv2[1] *= k;
        }
        vy = vn * e;
        omega *= 0.45;
        bounces++;
        vt = Math.hypot(rv2[0], rv2[1]);
        if (vy < 0.6) break;

        // ballistic hop
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

      /* --- rolling phase --------------------------------------------------- */
      if (!wet) {
        let speed2 = Math.hypot(rv2[0], rv2[1]);
        let guard = 0;
        while (guard++ < 6000) {
          surface = field.surfaceAt(rp[0], rp[2]);
          if (surface === 'water') { wet = true; break; }
          const S = SURFACE[surface] || SURFACE.rough;
          const n = field.normal(rp[0], rp[2]);
          // gravity resolved onto the ground plane
          const gx = -n[0] * G, gz = -n[2] * G;
          const slope = Math.hypot(gx, gz);
          const fr = S.roll * G;
          if (speed2 > 1e-3) {
            const ux = rv2[0] / speed2, uz = rv2[1] / speed2;
            rv2[0] += (gx - ux * fr) * rdt;
            rv2[1] += (gz - uz * fr) * rdt;
          } else if (slope > fr) {
            rv2[0] += gx * rdt; rv2[1] += gz * rdt;
          } else {
            break;                                   // at rest and holding
          }
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
    const total = Math.hypot(rp[0] - opts.origin[0], rp[2] - opts.origin[2]);

    return {
      path, roll,
      landPoint, finalPoint: [rp[0], rp[1], rp[2]],
      landSurface, finalSurface,
      stats: {
        ballSpeed: speed * MPH,
        launchAngle: club.launch,
        spin: Math.round(club.spin * prof.spin),
        carryYd: carry * M2Y,
        totalYd: total * M2Y,
        apexM: apex - opts.origin[1],
        apexYd: (apex - opts.origin[1]) * M2Y,
        hangTime: t,
        descentAngle: descent,
        landSpeed: landSpeed * MPH,
        rollYd: (total - carry) * M2Y,
        club: club.name,
        offline: 0
      }
    };
  }

  /** Pick the club whose carry best matches a target distance in yards. */
  function clubForDistance(yards, profileId, field, origin, aim, wind) {
    let best = null;
    for (const c of CLUBS) {
      const r = simulate({ origin, aim, club: c.id, profile: profileId, field, wind, power: 1 });
      const d = Math.abs(r.stats.carryYd - yards);
      if (!best || d < best.d) best = { d, club: c, result: r };
    }
    return best;
  }

  root.Shot = { simulate, CLUBS, PROFILES, SURFACE, clubBy, clubForDistance };
})(window);
