/* Atmosphere and sun position.
 *
 * The shipping preview lights the course from five hand-tuned presets: an
 * azimuth, an elevation and three colours picked by eye. They look pleasant but
 * they are not physical — two of them put the sun in the northern sky, which
 * cannot happen at 41 degrees north — and because the sun colour, the sky
 * gradient and the exposure are all independent numbers, any change to one of
 * them has to be re-balanced against the other two by hand.
 *
 * This replaces the presets with one atmosphere. The sun's position comes from
 * the NOAA solar-position algorithm evaluated at the course's real latitude and
 * longitude, and every lighting quantity — direct sun colour, sky radiance in
 * any direction, ambient fill, exposure, white balance — falls out of a single
 * single-scattering model of the air above the property. Turn the clock and
 * everything moves together, because they are all reading the same air.
 *
 * The same functions are transcribed into GLSL in shaders-poc.js, so what the
 * sky is drawn with and what the turf is lit by cannot drift apart. This file is
 * the reference implementation: it runs in plain JS, which is what lets it drive
 * exposure, the HUD readout and the ball-flight air density on the CPU side.
 */
(function (root) {
  'use strict';

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const RAD = Math.PI / 180, DEG = 180 / Math.PI;

  /* ------------------------------------------------------------------ optics
   * Vertical (zenith) optical depth of the whole atmosphere, per RGB channel.
   * Rayleigh from the standard 1/lambda^4 fit at 600/550/450 nm; Mie from an
   * Angstrom turbidity term; ozone from the Chappuis band, which is what makes
   * a clear zenith read slightly violet rather than pure cyan.
   */
  const TAU_R = [0.0464, 0.1085, 0.2646];
  const TAU_M1 = 0.0100;                     // Mie at turbidity 1
  const TAU_O = [0.0031, 0.0019, 0.0002];    // ozone
  /**
   * Henyey-Greenstein asymmetry for the haze. 0.50 is deliberately broader than
   * the 0.75-0.80 usually quoted for aerosol: a single HG lobe that tight puts
   * far too much spectrally flat light within 20 degrees of the sun, which is
   * where most of a golf scene's sky actually sits.
   */
  const MIE_G = 0.50;
  /**
   * Aerosol single-scattering albedo. Haze absorbs as well as scatters, so it
   * belongs in the extinction at full strength but only reflects ~0.85 of what
   * it takes out. Leaving this at 1.0 is the classic mistake that turns a clear
   * midday zenith grey: the flat Mie term then out-scatters Rayleigh's blue.
   */
  const MIE_SSA = 0.86;

  /** Extraterrestrial beam, in the same arbitrary units the renderer works in. */
  const E0 = [1.86, 1.83, 1.79];

  /**
   * Relative air mass (Kasten & Young 1989). Valid to the horizon, where a
   * naive 1/sin would blow up.
   */
  function airMass(cosZ) {
    const el = Math.asin(clamp(cosZ, -1, 1)) * DEG;
    return 1 / (Math.max(cosZ, 0) + 0.50572 * Math.pow(Math.max(el, -5) + 6.07995, -1.6364));
  }

  const phaseR = mu => 3 / (16 * Math.PI) * (1 + mu * mu);
  function phaseM(mu, g) {
    const gg = g * g;
    return 3 / (8 * Math.PI) * ((1 - gg) * (1 + mu * mu)) /
           ((2 + gg) * Math.pow(Math.max(1 + gg - 2 * g * mu, 1e-4), 1.5));
  }

  function tauVert(turbidity) {
    const m = TAU_M1 * turbidity;
    return {
      r: [TAU_R[0] + TAU_O[0], TAU_R[1] + TAU_O[1], TAU_R[2] + TAU_O[2]],
      m: m,
      total: [TAU_R[0] + TAU_O[0] + m, TAU_R[1] + TAU_O[1] + m, TAU_R[2] + TAU_O[2] + m]
    };
  }

  /** Beam transmittance from space down to the ground for a sun at cosZ. */
  function transmittance(cosZ, turbidity) {
    const t = tauVert(turbidity), am = airMass(cosZ);
    return [Math.exp(-t.total[0] * am), Math.exp(-t.total[1] * am), Math.exp(-t.total[2] * am)];
  }

  /**
   * Sky radiance looking along `dir`, single scattering only.
   *
   * Everything the eye reads as "what time is it" lives in this one expression:
   * the length of the view ray sets how much air is scattering toward you, the
   * length of the sun's ray sets what colour is left to scatter, and the two
   * phase functions decide how much of it comes from the sun's direction. At a
   * high sun the short solar path keeps the beam white and Rayleigh's blue
   * dominates; at a low sun the beam has lost its blue before it ever reaches
   * the air you are looking at, so the same equation reddens on its own.
   */
  function skyRadiance(dir, sun, turbidity, gain) {
    const t = tauVert(turbidity);
    const up = dir[1];
    let am = airMass(Math.max(up, 0));
    if (up < 0) am = am + (airMass(0) * 1.4 - am) * clamp(-up / 0.12, 0, 1);

    const mu = clamp(dir[0] * sun[0] + dir[1] * sun[1] + dir[2] * sun[2], -1, 1);
    const pr = phaseR(mu), pm = phaseM(mu, MIE_G);
    const sunT = transmittance(sun[1], turbidity);

    // Second-order scattering. Applied as a gain on the single-scattering result
    // rather than as its own flat term, so it brightens the sky without washing
    // the hue out — light that has bounced twice is, if anything, bluer.
    const msc = 1 + 0.34 * (1 - Math.exp(-am * 0.45));

    // Twilight. Once the beam is below the horizon single scattering has nothing
    // left to work with and the sky goes abruptly black, which is wrong: the lit
    // air above the terminator keeps the ground blue for a good half hour.
    const tw = clamp(-sun[1] / 0.16, 0, 1) * 0.030;

    const out = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      const den = t.r[i] + t.m;                       // extinction, both species
      const ext = Math.exp(-den * am);
      const num = t.r[i] * pr + t.m * MIE_SSA * pm;   // scattering only
      // (beta*P / beta_ext) * (1 - exp(-beta_ext * s)): the thin-limit product
      // beta*P*s for the channels that barely scatter, saturating for the ones
      // that do. This single expression is what makes blue saturate first.
      out[i] = E0[i] * sunT[i] * (num / den) * (1 - ext) * gain * msc;
      out[i] += E0[i] * tw * (t.r[i] / den) * (1 - ext) * gain;
    }
    return out;
  }

  /* --------------------------------------------------------- solar position
   * NOAA / Meeus. Accurate to well under a minute of arc over the years anyone
   * will type into the clock, which is far better than the geometry it lights.
   */
  function solarPosition(dateUTC, latDeg, lonDeg) {
    const jd = dateUTC.getTime() / 86400000 + 2440587.5;
    const T = (jd - 2451545) / 36525;

    const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
    const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
    const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
    const Mr = M * RAD;
    const C = Math.sin(Mr) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
              Math.sin(2 * Mr) * (0.019993 - 0.000101 * T) +
              Math.sin(3 * Mr) * 0.000289;
    const trueLong = L0 + C;
    const omega = 125.04 - 1934.136 * T;
    const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD);

    const seconds = 21.448 - T * (46.815 + T * (0.00059 - T * 0.001813));
    const e0 = 23 + (26 + seconds / 60) / 60;
    const eps = e0 + 0.00256 * Math.cos(omega * RAD);

    const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(appLong * RAD)) * DEG;

    const y = Math.pow(Math.tan(eps * RAD / 2), 2);
    const eqTime = 4 * DEG * (y * Math.sin(2 * L0 * RAD)
      - 2 * e * Math.sin(Mr)
      + 4 * e * y * Math.sin(Mr) * Math.cos(2 * L0 * RAD)
      - 0.5 * y * y * Math.sin(4 * L0 * RAD)
      - 1.25 * e * e * Math.sin(2 * Mr));

    const minutesUTC = dateUTC.getUTCHours() * 60 + dateUTC.getUTCMinutes() +
                       dateUTC.getUTCSeconds() / 60;
    const trueSolarTime = (minutesUTC + eqTime + 4 * lonDeg + 1440) % 1440;
    let ha = trueSolarTime / 4 - 180;
    if (ha < -180) ha += 360;

    const latR = latDeg * RAD, declR = decl * RAD, haR = ha * RAD;
    let cosZen = Math.sin(latR) * Math.sin(declR) +
                 Math.cos(latR) * Math.cos(declR) * Math.cos(haR);
    cosZen = clamp(cosZen, -1, 1);
    const zen = Math.acos(cosZen);

    // atmospheric refraction lifts a low sun visibly — about half a degree on
    // the horizon, which is the whole difference between "set" and "not set"
    const elGeom = 90 - zen * DEG;
    let refr = 0;
    if (elGeom <= 85) {
      const te = Math.tan(elGeom * RAD);
      if (elGeom > 5) refr = 58.1 / te - 0.07 / Math.pow(te, 3) + 0.000086 / Math.pow(te, 5);
      else if (elGeom > -0.575) refr = 1735 + elGeom * (-518.2 + elGeom * (103.4 + elGeom * (-12.79 + elGeom * 0.711)));
      else refr = -20.774 / te;
      refr /= 3600;
    }
    const el = elGeom + refr;

    let az;
    const denom = Math.cos(latR) * Math.sin(zen);
    if (Math.abs(denom) > 1e-6) {
      let c = (Math.sin(latR) * Math.cos(zen) - Math.sin(declR)) / denom;
      az = Math.acos(clamp(c, -1, 1)) * DEG;
      az = ha > 0 ? (az + 180) % 360 : (540 - az) % 360;
    } else {
      az = latDeg > 0 ? 180 : 0;
    }
    return { elevation: el, azimuth: az, declination: decl, eqTime: eqTime, hourAngle: ha };
  }

  /**
   * World-space unit vector toward the sun.
   *
   * The model's axes are metres east (+X) and metres south (+Z) from the course
   * origin, so north is -Z. Compass azimuth is measured clockwise from north.
   */
  function sunVector(elevation, azimuth) {
    const el = elevation * RAD, az = azimuth * RAD;
    const ce = Math.cos(el);
    return [ce * Math.sin(az), Math.sin(el), -ce * Math.cos(az)];
  }

  /* -------------------------------------------------------------- lighting */

  /**
   * Everything the renderer needs for one instant in time.
   *
   * `gain` is the one free constant in the whole model: it converts the
   * atmosphere's arbitrary radiance units into the scale the existing turf and
   * foliage shaders were authored against, so this drops in without every
   * albedo needing to be re-tuned.
   */
  const GAIN = 14.2;

  function lighting(opts) {
    const o = opts || {};
    const lat = o.lat === undefined ? 41.68159 : o.lat;
    const lon = o.lon === undefined ? -87.95004 : o.lon;
    const turb = o.turbidity === undefined ? 2.2 : o.turbidity;
    const cover = o.cloudCover === undefined ? 0.34 : o.cloudCover;

    const sp = solarPosition(o.date || new Date(), lat, lon);
    const sun = sunVector(sp.elevation, sp.azimuth);

    // Direct beam. Below the horizon there is no beam at all; the last couple of
    // degrees are faded rather than cut so sunset is not a switch.
    const T = transmittance(Math.max(sun[1], 0.0), turb);
    const below = clamp((sp.elevation + 0.8) / 2.2, 0, 1);
    const beamAtten = below * below;
    const sunColor = [
      E0[0] * T[0] * beamAtten,
      E0[1] * T[1] * beamAtten,
      E0[2] * T[2] * beamAtten
    ];

    // Overcast trades the beam for a brighter, flatter dome.
    const overcast = clamp((cover - 0.55) / 0.45, 0, 1);
    for (let i = 0; i < 3; i++) {
      sunColor[i] *= 1 - overcast * 0.82;
      // a thick deck also greys what is left of the beam
      sunColor[i] = sunColor[i] * (1 - overcast * 0.5) +
        (sunColor[0] + sunColor[1] + sunColor[2]) / 3 * overcast * 0.5;
    }

    const zenith = skyRadiance([0, 1, 0], sun, turb, GAIN);
    const horizonSun = skyRadiance([sun[0], 0.06, sun[2]], sun, turb, GAIN);

    /**
     * Hemispheric ambient: the cosine-weighted integral of sky radiance over the
     * upper hemisphere, which is what a patch of level turf actually receives.
     *
     * Worth doing properly rather than averaging a couple of probes. At sunrise
     * the sky is enormously brighter toward the sun than away from it, but that
     * bright part covers very little solid angle — weighting a horizon probe at
     * a flat 30% overstates dawn ambient by a factor of three and the exposure
     * meter then stops the whole scene down into mud.
     */
    const ambient = [0, 0, 0];
    let wsum = 0;
    const RINGS = 6, SPOKES = 12;
    for (let r = 0; r < RINGS; r++) {
      // equal-solid-angle rings, sampled at the ring centre
      const sinT2 = (r + 0.5) / RINGS;             // sin^2(theta) from zenith
      const st = Math.sqrt(sinT2), ct = Math.sqrt(1 - sinT2);
      for (let s = 0; s < SPOKES; s++) {
        const a = (s + 0.5) / SPOKES * Math.PI * 2;
        const d = [st * Math.cos(a), ct, st * Math.sin(a)];
        const L = skyRadiance(d, sun, turb, GAIN);
        const w = ct;                              // Lambert cosine
        ambient[0] += L[0] * w; ambient[1] += L[1] * w; ambient[2] += L[2] * w;
        wsum += w;
      }
    }
    for (let i = 0; i < 3; i++) ambient[i] = ambient[i] / wsum * (1 + overcast * 0.85);

    // Exposure: meter the scene the way a camera would, off a mid-grey card lit
    // by both the beam and the sky, so no time of day needs a hand-set number.
    const lum = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    const key = lum(sunColor) * Math.max(sun[1], 0) * 0.62 + lum(ambient) * 0.95;
    const exposure = clamp(0.56 / Math.max(key, 0.02), 0.14, 2.6);

    // White balance. A camera pulls a warm scene part of the way back toward
    // neutral but never all the way, which is exactly why golden hour still
    // looks golden in a photograph.
    const illum = [
      sunColor[0] * Math.max(sun[1], 0.02) + ambient[0],
      sunColor[1] * Math.max(sun[1], 0.02) + ambient[1],
      sunColor[2] * Math.max(sun[1], 0.02) + ambient[2]
    ];
    const g = illum[1] || 1;
    // A low sun is deliberately under-corrected: a camera left on daylight
    // balance is exactly why a photograph of golden hour still looks golden.
    const strength = (o.whiteBalance === undefined ? 0.62 : o.whiteBalance) *
                     clamp((sp.elevation - 1) / 12, 0.18, 1);
    const wb = [
      clamp(1 + (g / Math.max(illum[0], 1e-4) - 1) * strength, 0.55, 1.75),
      1,
      clamp(1 + (g / Math.max(illum[2], 1e-4) - 1) * strength, 0.55, 1.75)
    ];

    // Ground bounce tint: turf reflecting back up into everything above it.
    const groundTint = [
      0.135 * (sunColor[0] * 0.5 + ambient[0]),
      0.230 * (sunColor[1] * 0.5 + ambient[1]),
      0.105 * (sunColor[2] * 0.5 + ambient[2])
    ];

    return {
      solar: sp,
      sunDir: sun,
      sunColor: sunColor,
      turbidity: turb,
      cloudCover: cover,
      overcast: overcast,
      skyZenith: zenith,
      skyHorizon: horizonSun,
      ambient: ambient,
      groundTint: groundTint,
      exposure: exposure,
      whiteBalance: wb,
      gain: GAIN,
      // haze grows through the day as the boundary layer heats up, and a low sun
      // has to shine through the length of it
      fogDensity: 0.00016 + turb * 0.00010 + overcast * 0.00028 +
                  0.00055 * clamp(1 - sp.elevation / 22, 0, 1),
      bloom: 0.14 + 0.34 * clamp(1 - sp.elevation / 30, 0, 1) + overcast * -0.04,
      night: clamp(1 - (sp.elevation + 6) / 10, 0, 1)
    };
  }

  root.SkyModel = {
    solarPosition, sunVector, lighting, skyRadiance, transmittance,
    airMass, phaseR, phaseM, tauVert, GAIN, E0, TAU_R, TAU_M1, TAU_O, MIE_G
  };
})(typeof window === 'undefined' ? globalThis : window);
