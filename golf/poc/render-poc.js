/* Renderer overlay for the hole-1 proof of concept.
 *
 * Deliberately written as an overlay on js/app.js rather than a fork of it: it
 * replaces buildPrograms, resize, sunDir, applyEnv, updateGrass and render, and
 * leaves the scene assembly, cameras, field and terrain code exactly as they
 * are. That keeps the diff honest — everything here is a rendering change, and
 * the shipping preview is untouched.
 *
 * Frame:
 *      SSAO          off last frame's depth, half res, two-tap blur
 *      shadow        two cascades, unchanged
 *      main           sky, terrain, water, trees, props, grass, tracer  -> HDR
 *      circle of confusion + separable gather                           -> half res
 *      bright + blur                                                    -> bloom
 *      radial gather toward the sun, sky-gated                          -> shafts
 *      composite      white balance, AgX, FXAA, vignette, grain
 */
(function (root) {
  'use strict';

  const App = root.App;
  const { M4, clamp, lerp, rng } = root.MM;
  const SkyModel = root.SkyModel;

  /* Course origin, straight out of the generated data: the real latitude and
     longitude the geometry was projected from. */
  const ORIGIN = root.COURSE && root.COURSE.origin
    ? { lat: root.COURSE.origin.lat0, lon: root.COURSE.origin.lon0 }
    : { lat: 41.68159, lon: -87.95004 };

  /* ------------------------------------------------------------- settings */

  App.poc = {
    /* clock */
    date: '2025-06-21',
    minutes: 17 * 60 + 30,       // local wall-clock minutes
    tzOffset: -5,                // CDT
    turbidity: 2.4,
    cloudCover: 0.36,
    cloudAlt: 1500,
    cloudShadow: 0.82,
    season: 0.10,

    /* features */
    ao: true,
    aoRadius: 0.85,
    aoStrength: 1.0,
    dof: true,
    shafts: true,
    contact: true,     // the dark patch under the ball; see drawBall
    agx: true,
    grain: 0.008,
    grassDensity: 1.0,
    /* Skip the whole optimistic buffer chain and use the plainest path that any
       WebGL2 device can render. ?safe=1 turns it on. */
    safeMode: false,

    /* camera */
    focal: 50,                   // mm
    fStop: 5.6,
    focusAuto: true,
    focusDist: 40,

    /* grade */
    saturation: 1.02,
    punch: 1.02,
    whiteBalance: 0.62
  };

  /* ------------------------------------------------------------- tiers
   *
   * The renderer was written for a machine that can afford it, and the two
   * settings it shipped with — "high" and "fast" — differ by about a third.
   * That is not a range. On an integrated GPU a frame can take long enough
   * that Windows decides the driver has stopped responding and resets it,
   * which is why a heavy frame does not show up as a slow one: it shows up as
   * a picture that freezes, or a canvas that goes black while the HUD carries
   * on. Both are the device being taken away, not the code failing.
   *
   * So the tiers go down far enough to matter. "low" is a tenth of the pixel
   * work of "high" and half the geometry; "min" draws the course and nothing
   * else. Something in here runs on anything that can hold a context.
   */
  App.TIERS = {
    high: { res: 1.00, dpr: 1.5, sm: 2048, cascades: 2, hdr: true,
            ao: true,  dof: true,  shafts: true,  bloom: true,
            grassR: 22, grassN: 46000, leaves: 1.00, dimples: true },
    fast: { res: 1.00, dpr: 1.0, sm: 2048, cascades: 2, hdr: true,
            ao: true,  dof: false, shafts: true,  bloom: true,
            grassR: 15, grassN: 15000, leaves: 0.55, dimples: false },
    /* Phones. A phone GPU is quick at plain shading and slow at fill and
       bandwidth, and its screen is three device pixels to the CSS pixel. So
       full resolution at a capped 1.5x (sharp enough on a retina screen, under
       a quarter of the native fill), real shadows from one small cascade, HDR
       and bloom kept because they are most of what makes the light look like
       daylight, and the screen-space passes — occlusion, depth of field,
       shafts — left off, since each one is another full-screen read. */
    mobile: { res: 1.00, dpr: 1.5, sm: 1024, cascades: 1, hdr: true,
            ao: false, dof: false, shafts: false, bloom: true,
            grassR: 9,  grassN: 5000,  leaves: 0.36, dimples: false },
    low:  { res: 0.80, dpr: 1.0, sm: 1024, cascades: 1, hdr: false,
            ao: false, dof: false, shafts: false, bloom: true,
            grassR: 9,  grassN: 4200,  leaves: 0.30, dimples: false },
    min:  { res: 0.65, dpr: 1.0, sm: 0,    cascades: 0, hdr: false,
            ao: false, dof: false, shafts: false, bloom: false,
            grassR: 0,  grassN: 0,     leaves: 0.18, dimples: false }
  };

  App.TIER_ORDER = ['high', 'fast', 'mobile', 'low', 'min'];

  App.tier = function () {
    return this.TIERS[this.quality] || this.TIERS.fast;
  };

  /** Move down one tier and rebuild. Returns false when already at the bottom. */
  App.stepDownTier = function (why) {
    const i = this.TIER_ORDER.indexOf(this.quality);
    if (i < 0 || i >= this.TIER_ORDER.length - 1) return false;
    this.quality = this.TIER_ORDER[i + 1];
    const T = this.tier();
    this.poc.ao = T.ao; this.poc.dof = T.dof; this.poc.shafts = T.shafts;
    // the shadow maps are sized by tier, so they have to go back too
    if (this.sm) {
      if (this.sm[0]) this.sm[0].dispose();
      if (this.sm[1] && this.sm[1] !== this.sm[0]) this.sm[1].dispose();
      this.sm = null;
    }
    if (this.rt) { this.rt.dispose(); this.rt = null; }
    this.resize();
    this.grassAt = null;
    if (this.updateGrass) this.updateGrass(true);
    console.warn('[dubsdread] dropped to ' + this.quality + ' quality: ' + why);
    if (root.UI && root.UI.tierChanged) root.UI.tierChanged(this.quality, why);
    return true;
  };

  /* ---------------------------------------------------------- lighting state */

  /** Local wall-clock -> UTC Date, using the POC's fixed offset. */
  function localDate(dateStr, minutes, tzOffset) {
    const p = String(dateStr).split('-');
    const y = +p[0] || 2025, mo = (+p[1] || 6) - 1, d = +p[2] || 21;
    const h = Math.floor(minutes / 60), mi = Math.round(minutes % 60);
    return new Date(Date.UTC(y, mo, d, h - tzOffset, mi));
  }

  App.refreshSky = function () {
    const P = this.poc;
    this.sky = SkyModel.lighting({
      date: localDate(P.date, P.minutes, P.tzOffset),
      lat: ORIGIN.lat, lon: ORIGIN.lon,
      turbidity: P.turbidity,
      cloudCover: P.cloudCover,
      whiteBalance: P.whiteBalance
    });
    // dew burns off within an hour or so of the sun getting up
    this.sky.dew = clamp(1 - (this.sky.solar.elevation - 1) / 13, 0, 1) * 0.85;
    return this.sky;
  };

  App.sunDir = function () {
    if (!this.sky) this.refreshSky();
    return this.sky.sunDir;
  };

  /** Sunrise / sunset in local minutes, for the clock UI. */
  App.dayBounds = function () {
    const P = this.poc;
    const find = (from, to, step) => {
      let prev = null;
      for (let m = from; step > 0 ? m <= to : m >= to; m += step) {
        const s = SkyModel.solarPosition(localDate(P.date, m, P.tzOffset), ORIGIN.lat, ORIGIN.lon);
        if (prev !== null && (prev < 0) !== (s.elevation < 0)) return m;
        prev = s.elevation;
      }
      return null;
    };
    return { rise: find(180, 780, 2) || 330, set: find(1260, 780, -2) || 1230 };
  };

  /* ------------------------------------------------------------- programs */

  const origBuildPrograms = App.buildPrograms;

  App.buildPrograms = function () {
    origBuildPrograms.call(this);
    const gl = this.gl, S = root.SHP, P = root.GLX.Program;
    this.pg = {
      sky: new P(gl, S.skyVert, S.skyFrag, 'sky'),
      terrain: new P(gl, S.terrainVert, S.terrainFrag, 'terrain'),
      tree: new P(gl, S.treeVert, S.treeFrag, 'tree'),
      impostor: new P(gl, S.impostorVert, S.impostorFrag, 'impostor'),
      water: new P(gl, S.waterVert, S.waterFrag, 'water'),
      prop: new P(gl, S.propVert, S.propFrag, 'prop'),
      /* ball and blob are added below, not here: a program that will not
         compile throws, and these two are the newest and least essential
         things in the frame. Taking the whole renderer down over the ball's
         dimples — on a driver whose compiler is stricter than any I can test
         against — is not a trade worth making. */
      grass: new P(gl, S.grassVert, S.grassFrag, 'grass'),
      shadow: new P(gl, S.shadowVert, S.shadowFrag, 'shadow'),
      shadowTree: new P(gl, S.leafDepthVert, S.leafDepthFrag, 'shadowLeaf'),
      tracer: new P(gl, S.tracerVert, S.tracerFrag, 'tracer'),
      ssao: new P(gl, S.fsqVert, S.ssaoFrag, 'ssao'),
      ssaoBlur: new P(gl, S.fsqVert, S.ssaoBlurFrag, 'ssaoBlur'),
      coc: new P(gl, S.fsqVert, S.cocFrag, 'coc'),
      dof: new P(gl, S.fsqVert, S.dofFrag, 'dof'),
      bright: new P(gl, S.fsqVert, S.brightFrag, 'bright'),
      blur: new P(gl, S.fsqVert, S.blurFrag, 'blur'),
      godray: new P(gl, S.fsqVert, S.godrayFrag, 'godray'),
      composite: new P(gl, S.fsqVert, S.compositeFrag, 'composite')
    };
    /* Optional programs. If one of them will not build on this driver, say so
       and carry on without it — the ball falls back to the shader every other
       prop uses, and the contact shadow is simply not drawn. */
    for (const [key, vert, frag] of [['ball', S.ballVert, S.ballFrag],
                                     ['blob', S.blobVert, S.blobFrag]]) {
      try {
        this.pg[key] = new P(gl, vert, frag, key);
      } catch (e) {
        this.pg[key] = null;
        console.warn('[dubsdread] optional program "' + key + '" did not build: ' +
                     ((e && e.message) || e));
        (this.shaderNotes = this.shaderNotes || []).push(key);
      }
    }

    this.mPrevInvVP = M4.create();
    this.frameNo = 0;
    this.refreshSky();
    this.buildScarTexture();
    this.leafTex = root.FoliagePoc.leafAtlas(gl, 9001);
  };

  /* ------------------------------------------------------- render targets
   *
   * Every buffer in this pipeline is created optimistically — half-float colour
   * for the HDR pass, a depth *texture* so occlusion, depth of field and the
   * shaft gather can read it. Neither is guaranteed. RGBA16F is only
   * colour-renderable when EXT_color_buffer_float is present, and it is missing
   * on plenty of otherwise capable machines.
   *
   * js/gl.js checks completeness and console.warn()s, then carries on. The
   * result is the worst possible failure: the main pass renders nowhere, the
   * composite samples an incomplete texture, and the canvas comes out **white**
   * while every bit of JavaScript keeps running — the HUD updates, the ball
   * flies, the card fills in, and the 3D is a blank sheet with no error anywhere
   * the player can see.
   *
   * So: try, verify, and degrade. A clipped-highlight render is worth having;
   * a white screen is not.
   */

  /** Create a render target only if it actually comes out complete. */
  App.tryRT = function (w, h, opts) {
    const gl = this.gl;
    let r;
    try { r = new root.GLX.RenderTarget(gl, w, h, opts); }
    catch (e) { return null; }
    gl.bindFramebuffer(gl.FRAMEBUFFER, r.fbo);
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (st === gl.FRAMEBUFFER_COMPLETE) return r;
    r.dispose();
    return null;
  };

  App.resize = function () {
    const gl = this.gl;
    const T = this.tier();
    const dpr = Math.min(window.devicePixelRatio || 1, T.dpr) * T.res;
    // Never ask for a buffer bigger than the driver will give: on a wide display
    // at a high pixel ratio the request can exceed the limit, every attachment
    // fails, and the result is another blank canvas.
    const maxT = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;
    const maxR = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) || maxT;
    const cap = Math.min(maxT, maxR);
    const w = clamp(Math.round(this.canvas.clientWidth * dpr), 2, cap);
    const h = clamp(Math.round(this.canvas.clientHeight * dpr), 2, cap);
    if (this.canvas.width === w && this.canvas.height === h && this.rt) return;
    this.canvas.width = w; this.canvas.height = h;

    // Null-safe: after a fallback some of these legitimately do not exist, and
    // disposing a missing one would throw on every subsequent resize.
    for (const k of ['rt', 'bloomA', 'bloomB', 'aoA', 'aoB', 'dofA', 'dofB', 'shaftA']) {
      if (this[k]) { this[k].dispose(); this[k] = null; }
    }
    /* --- main target, degrading until something is complete ----------- */
    const safe = this.poc.safeMode;
    const wants = safe || !T.hdr
      ? [{ float: false, depthTexture: true, why: null },
         { float: false, depth: true, why: null }]
      : [{ float: true,  depthTexture: true, why: null },
         { float: false, depthTexture: true, why: 'no float render targets — bright highlights will clip' },
         { float: true,  depth: true,        why: 'no depth textures — occlusion, depth of field and sun shafts are off' },
         { float: false, depth: true,        why: 'minimal render path — post-processing is off' }];

    this.gpu = { notes: [], hdr: true, depthTex: true };
    this.rt = null;
    for (const wnt of wants) {
      this.rt = this.tryRT(w, h, wnt);
      if (this.rt) {
        this.gpu.hdr = !!wnt.float;
        this.gpu.depthTex = !!wnt.depthTexture;
        if (wnt.why) this.gpu.notes.push(wnt.why);
        break;
      }
    }
    if (!this.rt) {
      // Nothing at all worked. Say so rather than presenting a blank canvas.
      this.gpu.failed = true;
      this.gpu.notes.push('this GPU could not provide any usable render target');
      if (root.UI && root.UI.gpuWarning) root.UI.gpuWarning(this.gpu);
      return;
    }
    // features that cannot run without a readable depth buffer
    if (!this.gpu.depthTex) {
      this.poc.ao = false; this.poc.dof = false; this.poc.shafts = false;
    }
    const F = this.gpu.hdr;

    const hw = Math.max(2, w >> 1), hh = Math.max(2, h >> 1);
    this.aoA = this.tryRT(hw, hh, { depth: false });
    this.aoB = this.tryRT(hw, hh, { depth: false });
    this.dofA = this.tryRT(hw, hh, { float: F, depth: false }) || this.tryRT(hw, hh, { depth: false });
    this.dofB = this.tryRT(hw, hh, { float: F, depth: false }) || this.tryRT(hw, hh, { depth: false });

    const bw = Math.max(2, w >> 2), bh = Math.max(2, h >> 2);
    this.bloomA = this.tryRT(bw, bh, { float: F, depth: false }) || this.tryRT(bw, bh, { depth: false });
    this.bloomB = this.tryRT(bw, bh, { float: F, depth: false }) || this.tryRT(bw, bh, { depth: false });
    this.shaftA = this.tryRT(bw, bh, { float: F, depth: false }) || this.tryRT(bw, bh, { depth: false });

    if (!this.aoA || !this.aoB) { this.poc.ao = false; }
    if (!this.dofA || !this.dofB) { this.poc.dof = false; }
    if (!this.bloomA || !this.bloomB) {
      this.gpu.notes.push('no bloom buffer — glare is off');
      this.bloomA = this.bloomB = null;
    }
    if (!this.shaftA) this.poc.shafts = false;

    if (!this.sm && T.sm > 0) {
      const S = T.sm;
      const a = this.tryRT(S, S, { color: false, depthTexture: true });
      /* One cascade is a real saving: it halves the shadow pass, which redraws
         every tree and every triangle of ground. The far slot points at the
         same map, and buildShadowMatrices gives both slots the same matrix, so
         the shader samples it correctly without knowing anything changed. */
      const b = T.cascades > 1 ? this.tryRT(S, S, { color: false, depthTexture: true }) : a;
      if (a && b) { this.sm = [a, b]; this.smSize = S; }
      else {
        if (a) a.dispose();
        if (b && b !== a) b.dispose();
        this.sm = null;
        this.gpu.notes.push('no shadow maps on this GPU');
      }
    }

    if (this.gpu.notes.length) {
      console.warn('[dubsdread] render fallbacks: ' + this.gpu.notes.join('; '));
      if (root.UI && root.UI.gpuWarning) root.UI.gpuWarning(this.gpu);
    }
  };

  /**
   * Last resort: rebuild every target on the plainest path the engine has.
   * Called when the frame guard finds that what reached the screen was empty,
   * whatever the reason — an incomplete attachment the driver reported as
   * complete, a post-processing pass the GPU quietly refuses, a shader that
   * links but writes nothing. Returns false if there is nothing left to give
   * up, so the caller knows to stop and say so instead.
   */
  App.downgrade = function (why) {
    if (this.poc.safeMode || !this.gl || this.gl.isContextLost()) return false;
    this.poc.safeMode = true;
    this.poc.ao = false;
    this.poc.dof = false;
    this.poc.shafts = false;
    // resize() bails out early when the size already matches and a target
    // exists, so drop the main target to force the rebuild through.
    if (this.rt) { this.rt.dispose(); this.rt = null; }
    this.resize();
    this.gpu = this.gpu || { notes: [] };
    this.gpu.failed = true;
    this.gpu.notes.push(why);
    if (root.UI && root.UI.gpuWarning) root.UI.gpuWarning(this.gpu);
    console.warn('[dubsdread] ' + why);
    return true;
  };

  /* ------------------------------------------------------------- uniforms */

  App.applyEnv = function (pg) {
    const K = this.sky || this.refreshSky();
    const P = this.poc;
    const s = K.sunDir;
    const t = SkyModel.tauVert(P.turbidity);

    pg.v3('uSunDir', s[0], s[1], s[2]);
    pg.v3('uSunColor', K.sunColor[0], K.sunColor[1], K.sunColor[2]);
    pg.v3('uTauR', t.r[0], t.r[1], t.r[2]);
    pg.f('uTauM', t.m);
    pg.f('uSkyGain', SkyModel.GAIN);
    pg.f('uTwilight', clamp(-s[1] / 0.16, 0, 1) * 0.030);
    pg.v3('uGroundTint', K.groundTint[0], K.groundTint[1], K.groundTint[2]);
    pg.f('uExposure', K.exposure);
    pg.f('uExposureT', K.exposure);
    pg.v3('uCamPos', this.camPos[0], this.camPos[1], this.camPos[2]);

    pg.f('uCloudCover', P.cloudCover);
    pg.f('uCloudAlt', P.cloudAlt);
    pg.f('uCloudScale', 1 / 1900);
    pg.f('uCloudShadow', P.cloudShadow);
    const cd = this.cloudDrift();
    pg.v2('uCloudDrift', cd[0], cd[1]);
    /* The deck is a light source in its own right: whatever it intercepts comes
       back down as a broad grey-white glow, and that is what fills a cloud
       shadow. Scaled by cover and by how high the sun is, since a low sun lights
       the underside of the cloud far less. */
    const cf = P.cloudCover * (0.30 + 0.55 * clamp(s[1], 0, 1)) * P.cloudShadow;
    const cl = (K.sunColor[0] + K.sunColor[1] + K.sunColor[2]) / 3;
    pg.v3('uCloudFill',
      (K.sunColor[0] * 0.45 + cl * 0.55) * cf,
      (K.sunColor[1] * 0.45 + cl * 0.55) * cf,
      (K.sunColor[2] * 0.45 + cl * 0.60) * cf);

    pg.f('uFogDensity', K.fogDensity);
    // haze scale height ~130 m: hazy along the ground, clear from a drone
    pg.f('uFogHeight', 0.0075);
    pg.f('uDew', K.dew || 0);
    pg.f('uSeason', P.season);

    pg.f('uTime', this.time);
    pg.f('uTimeT', this.time);
    pg.f('uTimeG', this.time);
    pg.f('uTimeP', this.time);
    const wv = this.windUnit();
    pg.v2('uWindDir', wv[0], wv[1]);
    pg.f('uWind', 0.22 + this.wind.speed * 0.055);
    pg.f('uWindP', this.wind.speed * 0.06);
    pg.f('uGrassFade', this.grassRadius || 20);

    pg.f('uAOEnabled', P.ao && this.frameNo > 0 ? 1 : 0);
    if (P.ao && this.aoB) {
      pg.tex('uAOTex', this.aoB.color);
      // gl_FragCoord is in full-resolution pixels; the AO buffer is sampled with
      // normalised coordinates, so this is the canvas size, not the AO texel
      pg.v2('uAOTexel', 1 / this.canvas.width, 1 / this.canvas.height);
    }
  };

  App.windUnit = function () {
    const a = this.wind.dir * Math.PI / 180;
    return [Math.cos(a), Math.sin(a)];
  };

  /** Cloud field offset. The deck moves with the wind aloft, faster than the
   *  surface wind, and never quite stops. */
  App.cloudDrift = function () {
    const u = this.windUnit();
    const spd = 3.0 + this.wind.speed * 2.4;
    const k = 1 / 1900;
    return [-u[0] * spd * this.time * k, -u[1] * spd * this.time * k];
  };

  /* ------------------------------------------------------------ scar layer
   * A paint layer over the detail field that the game writes divots and pitch
   * marks into. Cheap: one 512x512 canvas re-uploaded only when something is
   * added, sampled by the terrain shader in the same world rect as the field.
   */

  App.buildScarTexture = function () {
    const gl = this.gl;
    const c = document.createElement('canvas');
    c.width = c.height = 512;
    const g = c.getContext('2d', { willReadFrequently: false });
    g.fillStyle = '#000';
    g.fillRect(0, 0, 512, 512);
    this.scarCanvas = c;
    this.scarCtx = g;
    this.scarTex = gl.createTexture();
    this.scarMarks = [];
    this.scarDirty = true;
    gl.bindTexture(gl.TEXTURE_2D, this.scarTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  };

  App.clearScars = function () {
    if (!this.scarCtx) return;
    this.scarMarks = [];
    this.scarCtx.fillStyle = '#000';
    this.scarCtx.fillRect(0, 0, 512, 512);
    this.scarDirty = true;
  };

  /**
   * @param kind 'divot' (turf taken) | 'pitch' (ball mark) | 'wear'
   * @param dir  direction of travel, for the shape of a divot
   */
  App.addScar = function (x, z, kind, radius, dir) {
    if (!this.scarCtx || !this.field) return;
    const F = this.field;
    const s = 512 / F.size;
    const px = (x - F.x0) * s, py = (z - F.z0) * s;
    if (px < -20 || py < -20 || px > 532 || py > 532) return;
    const g = this.scarCtx;
    const r = Math.max(radius * s, 1.2);
    g.save();
    g.translate(px, py);
    if (dir) g.rotate(Math.atan2(dir[1], dir[0]));
    if (kind === 'divot') {
      // a divot is a long scrape, deepest at the front where the club entered
      const grd = g.createLinearGradient(-r * 1.6, 0, r * 1.6, 0);
      grd.addColorStop(0, 'rgba(255,0,0,0.15)');
      grd.addColorStop(0.45, 'rgba(235,0,0,0.95)');
      grd.addColorStop(1, 'rgba(120,0,0,0.35)');
      g.fillStyle = grd;
      g.beginPath();
      g.ellipse(0, 0, r * 1.7, r * 0.72, 0, 0, 7);
      g.fill();
    } else if (kind === 'pitch') {
      const grd = g.createRadialGradient(0, 0, 0, 0, 0, r);
      grd.addColorStop(0, 'rgba(0,220,0,0.85)');
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd;
      g.beginPath(); g.arc(0, 0, r, 0, 7); g.fill();
    } else {
      const grd = g.createRadialGradient(0, 0, 0, 0, 0, r);
      grd.addColorStop(0, 'rgba(0,0,190,0.55)');
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd;
      g.beginPath(); g.arc(0, 0, r, 0, 7); g.fill();
    }
    g.restore();
    this.scarMarks.push({ x, z, kind });
    this.scarDirty = true;
  };

  App.uploadScars = function () {
    if (!this.scarDirty) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.scarTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, this.scarCanvas);
    this.scarDirty = false;
  };

  /* --------------------------------------------------------------- grass
   * The original put blades only in the native areas outside the mown corridor,
   * on the argument that mown turf is the shader's job. From a tee box that
   * leaves the whole foreground as a flat green wash — the one part of the frame
   * the eye is closest to and judges hardest. This scatters short blades over
   * mown surfaces too, at a length that matches the cut.
   */

  function scatterGrassPoc(field, fx, fz, radius, count, seed, pin) {
    const R = rng(seed || 777);
    const a = new Float32Array(count * 4);
    const b = new Float32Array(count * 4);
    let m = 0;
    for (let i = 0; i < count * 4 && m < count; i++) {
      const ang = R() * Math.PI * 2;
      // bias toward the camera: density falls off as 1/r so the near ground,
      // where blades actually resolve, gets most of the budget
      const rr = Math.pow(R(), 0.72) * radius;
      const x = fx + Math.cos(ang) * rr;
      const z = fz + Math.sin(ang) * rr;
      if (!field.contains(x, z, 2)) continue;
      // nothing grows out of the cup, or leans over its edge
      if (pin && Math.hypot(x - pin[0], z - pin[2]) < 0.09) continue;
      const dSa = field.sample(field.sdfSa, x, z);
      const dWa = field.sample(field.sdfWa, x, z);
      const dPa = field.sample(field.sdfPa, x, z);
      if (dSa < 0.3 || dWa < 0.4 || dPa < 0.35) continue;

      const dGr = field.sample(field.sdfGr, x, z);
      const dFw = field.sample(field.sdfFw, x, z);
      const dTe = field.sample(field.sdfTe, x, z);
      const dCo = field.sample(field.sdfCo, x, z);

      // Height of cut, in metres. These are the real numbers: greens run about
      // 3 mm, fairways 12, first cut 20, rough 60-75, native fescue knee high.
      let hoc, prob, hue;
      // a green is cut too short for a blade to stand up and be seen; drawn
      // blades there read as specks of dirt on the putting surface
      if (dGr < 0.2) continue;
      else if (dGr < 1.2) { hoc = 0.016; prob = 0.40; hue = 0.22; }
      else if (dFw < 0 || dTe < 0) { hoc = 0.026; prob = 0.42; hue = 0.28; }
      else if (dFw < 2.5) { hoc = 0.042; prob = 0.55; hue = 0.34; }
      else if (dCo < 0) { hoc = 0.085; prob = 0.85; hue = 0.45; }
      else {
        const fade = clamp((dCo - 1.5) / 6, 0, 1);
        hoc = (0.26 + R() * 0.34) * (0.45 + 0.55 * fade);
        prob = 0.25 + fade * 0.75;
        hue = 0.6 + R() * 0.4;
      }
      // Blades on a mown surface only earn their cost within a few metres.
      const d2 = Math.hypot(x - fx, z - fz);
      if (hoc < 0.10 && d2 > radius * 0.42) continue;
      if (R() > prob) continue;

      const y = field.height(x, z);
      const h = hoc * (0.7 + R() * 0.7);
      a[m * 4] = x; a[m * 4 + 1] = y; a[m * 4 + 2] = z; a[m * 4 + 3] = h;
      b[m * 4] = R() * Math.PI * 2;
      b[m * 4 + 1] = (R() - 0.5) * 0.55 * h;
      b[m * 4 + 2] = (R() - 0.5) * 0.55 * h;
      b[m * 4 + 3] = clamp(hue + (R() - 0.5) * 0.18, 0, 1);
      m++;
    }
    return { a: a.subarray(0, m * 4), b: b.subarray(0, m * 4), n: m };
  }

  App.updateGrass = function (force) {
    // Blades are the single most expensive thing in the frame: hundreds of
    // thousands of alpha-blended instances, each one sampling the shadow map.
    // The bottom tier does without them entirely.
    if (!this.showGrass || this.tier().grassR <= 0) {
      if (this.grass) this.grass.n = 0;
      if (this.bladeMesh) this.bladeMesh.instances = 0;
      return;
    }
    const c = this.camPos || [this.focus[0], 0, this.focus[1]];
    const radius = this.tier().grassR;
    this.grassRadius = radius;
    if (!force && this.grassAt &&
        Math.hypot(c[0] - this.grassAt[0], c[2] - this.grassAt[1]) < 3.5) return;
    const fx = c[0], fz = c[2];
    if (!this.field.contains(fx, fz, 20)) { if (this.grass) this.grass.n = 0; return; }
    const budget = Math.round(this.tier().grassN * this.poc.grassDensity);
    const pack = scatterGrassPoc(this.field, fx, fz, radius, budget, 4242, this.pin);
    this.grassAt = [fx, fz];
    const gl = this.gl;
    if (!this.grassA) { this.grassA = gl.createBuffer(); this.grassB = gl.createBuffer(); }
    this.bladeMesh.instances = pack.n;
    gl.bindVertexArray(this.bladeMesh.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.grassA);
    gl.bufferData(gl.ARRAY_BUFFER, pack.a, gl.DYNAMIC_DRAW);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(3); gl.vertexAttribDivisor(3, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.grassB);
    gl.bufferData(gl.ARRAY_BUFFER, pack.b, gl.DYNAMIC_DRAW);
    gl.vertexAttribPointer(4, 4, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(4); gl.vertexAttribDivisor(4, 1);
    gl.bindVertexArray(null);
    this.grass = pack;
  };

  /* ------------------------------------------------------------- shadows
   *
   * The original centres each cascade at `lerp(camPos, camLook, 0.55)`. For a
   * camera looking down the hole that target is 250 m away, so cascade 0 —
   * which is only 115 m across — ends up centred 140 m ahead and the ground
   * within about twenty metres of the camera falls outside the map entirely.
   * `pcf` returns 1.0 for anything off the edge, so the whole foreground is
   * unconditionally lit: no tree shadows anywhere near the player, which is
   * exactly where they would sell the scene.
   *
   * Centring on the camera and pushing forward by a fraction of the cascade's
   * own span instead keeps the near field inside the map and still spends most
   * of the resolution ahead of the viewer, where they are looking.
   */

  App.buildShadowMatrices = function () {
    const s = this.sunDir();
    const one = this.tier().cascades < 2;
    // with a single map, cover the near field well and let the split sit past
    // anything the shader will ask about, so cascade 1 is never selected
    const spans = one
      ? [Math.max(150, this.spineLength() * 0.30), Math.max(150, this.spineLength() * 0.30)]
      : [Math.max(105, this.spineLength() * 0.20), Math.max(520, this.spineLength() * 1.15)];
    this.cascadeSplit = one ? 1e9 : spans[0] * 0.86;

    let fx = this.camLook[0] - this.camPos[0];
    let fz = this.camLook[2] - this.camPos[2];
    const fl = Math.hypot(fx, fz) || 1;
    fx /= fl; fz /= fl;

    for (let c = 0; c < 2; c++) {
      const span = spans[c];
      // far enough forward to spend the map on what is in front, near enough
      // that the ground at the player's feet is still covered
      const ahead = Math.min(span * 0.55, fl * 0.75);
      const cx = this.camPos[0] + fx * ahead;
      const cz = this.camPos[2] + fz * ahead;
      const cy = this.heightAt(cx, cz);

      // snap the centre to whole texels or the shadow edges crawl as the camera
      // moves, which reads as shimmering along every shadow boundary
      const texel = (span * 2) / this.smSize;
      const sx = Math.round(cx / texel) * texel;
      const sz = Math.round(cz / texel) * texel;

      const dist = span * 2.2 + 300;
      const eye = [sx + s[0] * dist, cy + s[1] * dist, sz + s[2] * dist];
      const view = M4.lookAt(M4.create(), eye, [sx, cy, sz], [0, 1, 0]);
      const proj = M4.ortho(M4.create(), -span, span, -span, span, 1, dist * 2 + span * 2);
      M4.mul(this.mShadow[c], proj, view);
    }
  };

  App.renderShadowPass = function () {
    if (!this.sm) return;
    const gl = this.gl;
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1.6, 3.5);
    const nC = this.sm[1] === this.sm[0] ? 1 : 2;
    for (let c = 0; c < nC; c++) {
      this.sm[c].bind();
      gl.clear(gl.DEPTH_BUFFER_BIT);
      const p = this.pg.shadow.use();
      p.m4('uViewProj', this.mShadow[c]).m4('uModel', this.identity);
      this.detailMesh.draw();
      if (c === 1 || nC === 1) this.worldMesh.draw();
      if (this.buildingsMesh) this.buildingsMesh.draw();
      if (this.holePropsMesh) this.holePropsMesh.draw();
      // the ball casts a shadow too, which is most of what sells it as sitting
      // on the ground rather than hovering over it
      if (this.ballPos && c === 0) {
        const m = M4.identity(M4.create());
        m[12] = this.ballPos[0]; m[13] = this.ballPos[1] + 0.0213; m[14] = this.ballPos[2];
        p.m4('uModel', m);
        this.ballMesh.draw();
        p.m4('uModel', this.identity);
      }

      const pt = this.pg.shadowTree.use();
      pt.m4('uViewProj', this.mShadow[c]);
      pt.f('uAlphaCut', 0.42).tex('uLeaf', this.leafTex);
      for (let i = 0; i < 4; i++) {
        const m = this.treeMeshes[i].mesh;
        if (m.instances) m.draw();
      }
    }
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  };

  /* Shadow uniforms, guarded. js/app.js reaches straight into this.sm[0].depth,
     which throws if the shadow maps could not be created — and a throw inside
     render() leaves a frozen frame rather than a degraded one. */
  const origApplyShadowUniforms = App.applyShadowUniforms;
  App.applyShadowUniforms = function (pg) {
    if (!this.sm) return pg;
    return origApplyShadowUniforms.call(this, pg);
  };

  /* A lost context is not an error the player can be left to guess at either. */
  App.watchContext = function () {
    const c = this.canvas;
    c.addEventListener('webglcontextlost', e => {
      e.preventDefault();
      this.ready = false;

      /* A lost context on a machine that was drawing fine a second ago is the
         driver having been reset, and a driver is reset because a frame took
         too long. Telling the player to reload just runs the same frame again
         and loses it again. Come back one tier lower instead — the reload is
         the only way back, because everything on the GPU went with it. */
      let next = null;
      try {
        const i = this.TIER_ORDER.indexOf(this.quality);
        if (i >= 0 && i < this.TIER_ORDER.length - 1) next = this.TIER_ORDER[i + 1];
        const tried = sessionStorage.getItem('dd_lost') || '';
        if (next && tried.indexOf(next) < 0) {
          sessionStorage.setItem('dd_lost', tried + ',' + next);
          const u = new URL(location.href);
          u.searchParams.set('q', next);
          location.replace(u.toString());
          return;
        }
      } catch (err) { /* no storage: fall through to the message */ }

      if (root.UI && root.UI.gpuWarning) {
        root.UI.gpuWarning({
          notes: ['the graphics driver was reset and the 3D context was lost'],
          lost: true, failed: true, flat: true
        });
      }
    });
  };

  /* ------------------------------------------------------------- SSAO pass */

  App.renderAO = function () {
    if (!this.poc.ao || this.frameNo < 1) return;
    if (!this.aoA || !this.aoB || !this.rt || !this.rt.depth) return;
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);

    this.aoA.bind();
    {
      const p = this.pg.ssao.use();
      p.tex('uDepth', this.rt.depth);
      p.m4('uInvViewProj', this.mPrevInvVP);
      p.m4('uViewProj', this.mPrevVP);
      p.v3('uCamPosA', this.prevCam[0], this.prevCam[1], this.prevCam[2]);
      p.v2('uDepthTexel', 1 / this.rt.w, 1 / this.rt.h);
      p.f('uRadius', this.poc.aoRadius);
      p.f('uStrength', this.poc.aoStrength);
      p.f('uFrame', this.frameNo % 64);
      this.fsq.draw();
    }
    this.aoB.bind();
    {
      const p = this.pg.ssaoBlur.use();
      p.tex('uTex', this.aoA.color).tex('uDepth', this.rt.depth);
      p.v2('uDir', 1 / this.aoA.w, 0);
      this.fsq.draw();
    }
    this.aoA.bind();
    {
      const p = this.pg.ssaoBlur.use();
      p.tex('uTex', this.aoB.color).tex('uDepth', this.rt.depth);
      p.v2('uDir', 0, 1 / this.aoA.h);
      this.fsq.draw();
    }
    // leave the finished term in aoB, which is what the forward shaders read
    const t = this.aoA; this.aoA = this.aoB; this.aoB = t;
    gl.enable(gl.DEPTH_TEST);
  };

  /* -------------------------------------------------------------- focus */

  /** What the lens is focused on: the ball in play, or the middle distance. */
  App.focusDistance = function () {
    const P = this.poc;
    if (!P.focusAuto) return P.focusDist;
    let target = null;
    if (this.shot && this.shotAnim < 1 && this.ballPos) target = this.ballPos;
    else if (this.ballPos) target = this.ballPos;
    else target = this.pinPos();
    const d = Math.hypot(target[0] - this.camPos[0], target[1] - this.camPos[1],
                         target[2] - this.camPos[2]);
    // ease it so a cut or a bouncing ball does not snap the focus
    this._focus = this._focus === undefined ? d : lerp(this._focus, d, 0.12);
    return clamp(this._focus, 0.5, 4000);
  };

  /**
   * Vertical field of view, in radians, for this screen shape.
   *
   * Every camera mode frames its shot as a vertical angle, which is right on a
   * landscape screen and wrong on a phone held upright: 46 degrees of height on
   * a screen half as wide as it is tall is about 22 degrees across — a long
   * lens, with the fairway cropped to a slot. Below a reference aspect the
   * width is held instead, so the hole still fits across the screen.
   */
  App.effectiveFov = function (fovDeg, aspect) {
    const v = fovDeg * Math.PI / 180;
    const REF = 0.85;
    if (!(aspect > 0) || aspect >= REF) return v;
    return 2 * Math.atan(Math.tan(v * 0.5) * REF / aspect);
  };

  /* -------------------------------------------------------------- render */

  App.render = function (dt) {
    if (!this.ready) return;
    const gl = this.gl;
    const P = this.poc;
    this.time += dt;
    this.resize();
    if (!this.rt) return;                  // no usable target; UI has been told
    this.updateCamera(dt);
    this.updateGrass(false);
    this.uploadScars();

    const aspect = this.canvas.width / this.canvas.height;
    /* Field of view and focal length are the same control, as they are on a
     * camera: a 24 mm sensor height and the vertical FOV determine each other.
     * By default the lens follows whatever the camera mode framed; pick a lens
     * explicitly and the framing follows instead. Either way the depth of field
     * is computed from a real focal length, so f/2.8 on a long lens throws the
     * background out the way it should and f/2.8 on a wide one barely does. */
    if (P.lens) {
      this.fovTarget = 2 * Math.atan(24 / (2 * P.lens)) * 180 / Math.PI;
      P.focal = P.lens;
    } else {
      P.focal = 24 / (2 * Math.tan((this.fov || 45) * Math.PI / 360));
    }
    const vfov = this.effectiveFov(this.fov || 45, aspect);
    M4.perspective(this.mProj, vfov, aspect, 0.22, 7000);
    M4.lookAt(this.mView, this.camPos, this.camLook, [0, 1, 0]);
    M4.mul(this.mVP, this.mProj, this.mView);
    M4.invert(this.mInvVP, this.mVP);

    /* --- ambient occlusion, off the previous frame ---------------------- */
    this.renderAO();

    /* --- shadows -------------------------------------------------------- */
    this.buildShadowMatrices();
    this.renderShadowPass();

    /* --- main ----------------------------------------------------------- */
    this.rt.bind();
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.disable(gl.BLEND);

    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    {
      const p = this.pg.sky.use();
      this.applyEnv(p);
      p.m4('uInvViewProj', this.mInvVP);
      this.fsq.draw();
    }
    gl.depthMask(true);
    gl.enable(gl.CULL_FACE);

    {
      const mow = this.mowDir();
      const draw = (field, mesh, detail) => {
        const p = this.pg.terrain.use();
        this.applyEnv(p);
        this.applyShadowUniforms(p);
        p.m4('uViewProj', this.mVP);
        p.v2('uMowDir', mow[0], mow[1]);
        const r = this.fieldRect(field);
        p.v4('uFieldRect', r[0], r[1], r[2], r[3]);
        p.f('uDetail', detail);
        const pin = this.pin || this.pinPos();
        p.v4('uCup', pin[0], pin[1], pin[2], detail > 0.5 ? this.CUP_R : 0);
        p.tex('uFieldA', field.texA).tex('uFieldB', field.texB);
        if (detail > 0.5 && this.scarTex) {
          p.tex('uScar', this.scarTex);
          p.v4('uScarRect', this.field.x0, this.field.z0, this.field.size, 1 / this.field.size);
          p.f('uScarOn', 1);
        } else {
          p.f('uScarOn', 0);
        }
        mesh.draw();
      };
      draw(this.worldField, this.worldMesh, 0);
      draw(this.field, this.detailMesh, 1);
    }

    if (this.waterMesh) {
      const p = this.pg.water.use();
      this.applyEnv(p);
      this.applyShadowUniforms(p);
      p.m4('uViewProj', this.mVP);
      const r = this.fieldRect(this.worldField);
      p.v4('uFieldRect', r[0], r[1], r[2], r[3]);
      p.tex('uFieldA', this.worldField.texA);
      gl.disable(gl.CULL_FACE);
      this.waterMesh.draw();
      gl.enable(gl.CULL_FACE);
    }

    {
      gl.disable(gl.CULL_FACE);
      const p = this.pg.tree.use();
      this.applyEnv(p);
      this.applyShadowUniforms(p);
      p.m4('uViewProj', this.mVP);
      p.f('uAlphaCut', 0.42).tex('uLeaf', this.leafTex);
      for (let i = 0; i < 4; i++) {
        const m = this.treeMeshes[i].mesh;
        if (m.instances) m.draw();
      }
      const q = this.pg.impostor.use();
      this.applyEnv(q);
      q.m4('uViewProj', this.mVP);
      q.tex('uLeaf', this.leafTex);
      q.v3('uCamPosB', this.camPos[0], this.camPos[1], this.camPos[2]);
      if (this.impostorMesh.instances) this.impostorMesh.draw();
      gl.enable(gl.CULL_FACE);
    }

    {
      const p = this.pg.prop.use();
      this.applyEnv(p);
      this.applyShadowUniforms(p);
      p.m4('uViewProj', this.mVP).m4('uModel', this.identity);
      p.f('uEmissive', 0).f('uRough', 0.75);
      gl.disable(gl.CULL_FACE);
      if (this.holePropsMesh) this.holePropsMesh.draw();
      gl.enable(gl.CULL_FACE);
      if (this.buildingsMesh) { p.f('uRough', 0.9); this.buildingsMesh.draw(); }
    }

    if (this.ballPos) this.drawBall();

    if (this.grass && this.grass.n) {
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      const p = this.pg.grass.use();
      this.applyEnv(p);
      this.applyShadowUniforms(p);
      p.m4('uViewProj', this.mVP);
      this.bladeMesh.draw();
      gl.disable(gl.BLEND);
      gl.enable(gl.CULL_FACE);
    }

    // a putt is followed by eye; a tracer ribbon on the green is a white sheet
    if (this.tracerMesh && this.shotAnim > 0 && this.showTracer !== false &&
        !(this.shot && this.shot.putt)) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.depthMask(false);
      gl.disable(gl.CULL_FACE);
      const p = this.pg.tracer.use();
      p.m4('uViewProj', this.mVP);
      p.v3('uCamPosT', this.camPos[0], this.camPos[1], this.camPos[2]);
      const tc = this.tracerColor || [1.0, 0.93, 0.72];
      p.v3('uColor', tc[0], tc[1], tc[2]);
      p.f('uWidth', 0.30).f('uProgress', clamp(this.shotAnim, 0, 1))
       .f('uExposureT', this.sky.exposure);
      this.tracerMesh.draw();
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.enable(gl.CULL_FACE);
    }

    /* --- post ----------------------------------------------------------- */
    const K = this.sky;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);

    let dofTex = null;
    if (P.dof && P.fStop < 22 && this.dofA && this.dofB && this.rt.depth) {
      const focus = this.focusDistance();
      this.dofA.bind();
      {
        const p = this.pg.coc.use();
        p.tex('uTex', this.rt.color).tex('uDepth', this.rt.depth);
        p.m4('uInvViewProj', this.mInvVP);
        p.v3('uCamPosD', this.camPos[0], this.camPos[1], this.camPos[2]);
        p.f('uFocus', focus).f('uFocal', P.focal).f('uAperture', P.fStop)
         .f('uMaxCoC', 14).f('uViewH', this.canvas.height);
        this.fsq.draw();
      }
      this.dofB.bind();
      {
        const p = this.pg.dof.use();
        p.tex('uTex', this.dofA.color);
        p.v2('uDir', 14 / this.dofA.w, 0).f('uMaxCoC', 14);
        this.fsq.draw();
      }
      this.dofA.bind();
      {
        const p = this.pg.dof.use();
        p.tex('uTex', this.dofB.color);
        p.v2('uDir', 0, 14 / this.dofA.h).f('uMaxCoC', 14);
        this.fsq.draw();
      }
      dofTex = this.dofA.color;
    }

    if (this.bloomA) {
      this.bloomA.bind();
      const p = this.pg.bright.use();
      p.tex('uTex', this.rt.color).f('uThreshold', 1.0);
      this.fsq.draw();
    }

    // shafts before the bloom blur, so they gather from crisp highlights
    let shaftAmt = 0;
    if (P.shafts && this.shaftA && this.bloomA) {
      const s = K.sunDir;
      const far = [this.camPos[0] + s[0] * 6000, this.camPos[1] + s[1] * 6000, this.camPos[2] + s[2] * 6000];
      const v = new Float32Array(3);
      M4.xformPoint(v, this.mVP, far);
      const fwd = [this.camLook[0] - this.camPos[0], this.camLook[1] - this.camPos[1],
                   this.camLook[2] - this.camPos[2]];
      const fl = Math.hypot(fwd[0], fwd[1], fwd[2]) || 1;
      const facing = (fwd[0] * s[0] + fwd[1] * s[1] + fwd[2] * s[2]) / fl;
      if (facing > 0.02 && s[1] > -0.02) {
        this.shaftA.bind();
        const p = this.pg.godray.use();
        p.tex('uTex', this.bloomA.color).tex('uDepth', this.rt.depth);
        p.v2('uSunUv', v[0] * 0.5 + 0.5, v[1] * 0.5 + 0.5);
        p.f('uDecay', 0.94).f('uDensity', 0.55);
        this.fsq.draw();
        // strongest with a low sun in frame, gone when it is overhead or behind
        shaftAmt = clamp(facing * 1.4, 0, 1) * clamp(1 - Math.max(s[1], 0) / 0.55, 0, 1) * 0.85;
      }
    }

    if (this.bloomA && this.bloomB) {
      this.bloomB.bind();
      { const p = this.pg.blur.use(); p.tex('uTex', this.bloomA.color).v2('uDir', 1 / this.bloomA.w, 0); this.fsq.draw(); }
      this.bloomA.bind();
      { const p = this.pg.blur.use(); p.tex('uTex', this.bloomB.color).v2('uDir', 0, 1 / this.bloomA.h); this.fsq.draw(); }
      this.bloomB.bind();
      { const p = this.pg.blur.use(); p.tex('uTex', this.bloomA.color).v2('uDir', 2.2 / this.bloomA.w, 0); this.fsq.draw(); }
      this.bloomA.bind();
      { const p = this.pg.blur.use(); p.tex('uTex', this.bloomB.color).v2('uDir', 0, 2.2 / this.bloomA.h); this.fsq.draw(); }
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    {
      const p = this.pg.composite.use();
      // Every sampler must be bound to something complete, even when the pass
      // that would have filled it never ran — an unbound sampler is exactly the
      // undefined read this whole fallback exists to avoid.
      const bloomTex = this.bloomA ? this.bloomA.color : this.rt.color;
      p.tex('uTex', this.rt.color).tex('uBloom', bloomTex);
      p.tex('uShafts', shaftAmt > 0 && this.shaftA ? this.shaftA.color : bloomTex);
      p.tex('uDof', dofTex || this.rt.color);
      p.f('uDofAmt', dofTex ? 1 : 0);
      p.v2('uTexel', 1 / this.canvas.width, 1 / this.canvas.height);
      p.f('uBloomAmt', this.bloomA ? K.bloom : 0).f('uShaftAmt', shaftAmt)
       .f('uVignette', 0.24).f('uSaturation', P.saturation).f('uPunch', P.punch)
       .f('uAgx', P.agx ? 1 : 0).f('uGrain', P.grain).f('uFrameC', this.frameNo % 512);
      p.v3('uWhiteBalance', K.whiteBalance[0], K.whiteBalance[1], K.whiteBalance[2]);
      this.fsq.draw();
    }
    gl.enable(gl.DEPTH_TEST);

    /* remember this frame for next frame's occlusion */
    if (!this.mPrevVP) this.mPrevVP = M4.create();
    M4.copy(this.mPrevInvVP, this.mInvVP);
    M4.copy(this.mPrevVP, this.mVP);
    this.prevCam = this.camPos.slice();
    this.frameNo++;
  };

  /**
   * The ball, and the dark patch underneath it.
   *
   * Order matters: the patch is multiplied onto the turf that is already there,
   * so it has to be drawn after the ground and before the ball. It is also the
   * only shadow the ball gets — at 2048 texels across a hundred-metre cascade a
   * 43 mm sphere never lands on a shadow-map texel — and without it the ball
   * hovers, whether it is sitting in the fairway or forty metres up.
   */
  App.drawBall = function () {
    const gl = this.gl;
    const b = this.ballPos;

    if (!this.blobMesh) {
      const SEG = 28;
      const v = [0, 0];
      for (let i = 0; i <= SEG; i++) {
        const a = i / SEG * Math.PI * 2;
        v.push(Math.cos(a), Math.sin(a));
      }
      const m = new root.GLX.Mesh(gl);
      m.attr(0, new Float32Array(v), 2);
      m.count = v.length / 2;
      m.mode = gl.TRIANGLE_FAN;
      this.blobMesh = m;
    }

    /* --- contact shadow ------------------------------------------------ */
    const inHole = root.Play && root.Play.state && root.Play.state.holed;
    const F = this.poc.contact && !inHole ? this.field : null;
    if (F) {
      const gy = F.height(b[0], b[2]);
      const air = Math.max(0, b[1] - gy);
      // A shadow spreads and washes out with the height of what casts it. Past
      // about twenty metres there is nothing left worth drawing.
      const t = clamp(air / 18, 0, 1);
      const dark = (1 - t) * 0.60 * clamp(this.sky.sunDir[1] * 5.0, 0.15, 1.0);
      if (dark > 0.01 && this.pg.blob) {
        const p = this.pg.blob.use();
        p.m4('uViewProj', this.mVP);
        p.v3('uBlobPos', b[0], gy + 0.003, b[2]);
        // At rest the patch is barely wider than the ball — a contact shadow is
        // tight, and anything larger stops reading as contact and starts
        // reading as a mark on the grass.
        p.f('uBlobR', 0.030 + air * 0.050);
        p.f('uBlobDark', dark).f('uBlobSoft', t * 0.85);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.DST_COLOR, gl.ZERO);   // multiply
        gl.depthMask(false);
        gl.disable(gl.CULL_FACE);
        gl.enable(gl.POLYGON_OFFSET_FILL);
        gl.polygonOffset(-1.2, -2.0);
        this.blobMesh.draw();
        gl.polygonOffset(1.6, 3.5);
        gl.disable(gl.POLYGON_OFFSET_FILL);
        gl.enable(gl.CULL_FACE);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
      }
    }

    /* --- the peg --------------------------------------------------------
       teePos() lifts the ball 60 mm, which is a tee whether or not anything is
       drawn there. Nothing was, so on every tee shot the ball hung in the air
       above its own shadow. */
    if (this.ballTeed && this.field) {
      if (!this.teeMesh) {
        const TB = root.Foliage.propBuilder();
        // narrow at the point, flaring into the cup the ball sits in
        TB.cylinder(0, 0, 0, 0.0020, 0.0042, 0.060, [0.94, 0.91, 0.87], 8);
        TB.cylinder(0, 0.060, 0, 0.0060, 0.0110, 0.009, [0.94, 0.91, 0.87], 10);
        this.teeMesh = TB.build(gl);
      }
      const gy = this.field.height(b[0], b[2]);
      const tm = M4.identity(M4.create());
      tm[12] = b[0]; tm[13] = gy - 0.008; tm[14] = b[2];
      const pp = this.pg.prop.use();
      this.applyEnv(pp);
      this.applyShadowUniforms(pp);
      pp.m4('uViewProj', this.mVP).m4('uModel', tm);
      pp.f('uEmissive', 0).f('uRough', 0.55);
      this.teeMesh.draw();
    }

    /* --- the ball itself ----------------------------------------------- */
    const m = M4.identity(M4.create());
    // A ball at rest sits down into the turf rather than balancing on top of
    // it; three millimetres is the difference between resting and hovering.
    const fld = this.field;
    const bed = fld && b[1] - fld.height(b[0], b[2]) < 0.01 ? 0.0032 : 0;
    /* On a phone held upright a real-size ball three or four metres away is
       a few pixels — present, but easy to lose. Draw it half as big again
       there; the physics, the cup and everything else stay real size. */
    const c = this.canvas;
    const bs = c && c.clientHeight > c.clientWidth * 1.2 ? 1.5 : 1.0;
    m[0] = m[5] = m[10] = bs;
    m[12] = b[0]; m[13] = b[1] + 0.0213 * bs - bed; m[14] = b[2];
    /* In the hole. The roll ends two centimetres down, at the rim; from there
       the ball drops to the floor of the cup, quickly, the way it does. */
    const pin = this.pin;
    const holed = root.Play && root.Play.state && root.Play.state.holed;
    if (pin && (holed || (Math.hypot(b[0] - pin[0], b[2] - pin[2]) < this.CUP_R &&
                          b[1] < pin[1] - 0.005))) {
      // the roll is captured anywhere within 75 mm of the centre; once it is
      // in, it is in the cup, against the stick
      const t = this._dropT = Math.min(1, (this._dropT || 0) + 0.12);
      const off = Math.max(0, this.CUP_R - 0.0225 * bs);
      const ax = b[0] - pin[0], az = b[2] - pin[2], al = Math.hypot(ax, az) || 1;
      m[12] = pin[0] + ax / al * off; m[14] = pin[2] + az / al * off;
      m[13] = lerp(pin[1] - 0.005 + 0.0213 * bs, pin[1] - this.CUP_DEPTH + 0.0213 * bs, t * t);
    } else {
      this._dropT = 0;
    }
    if (this.pg.ball) {
      const p = this.pg.ball.use();
      this.applyEnv(p);
      this.applyShadowUniforms(p);
      p.m4('uViewProj', this.mVP).m4('uModel', m);
      p.f('uDimples', this.tier().dimples ? 3.5 : 0.0);
      p.v3('uBallTint', 0.97, 0.97, 0.94);
      this.ballMesh.draw();
    } else {
      // no dimples, but a ball on the ground beats no ball at all
      const p = this.pg.prop.use();
      this.applyEnv(p);
      this.applyShadowUniforms(p);
      p.m4('uViewProj', this.mVP).m4('uModel', m);
      p.f('uEmissive', 0).f('uRough', 0.22);
      this.ballMesh.draw();
      p.m4('uModel', this.identity);
    }
  };

  /* Shot tracer colour follows the club, the way a broadcast tracer does. */
  App.tracerColor = [1.0, 0.93, 0.72];

  /* Canopies are leaf cards rather than sphere clusters — see foliage-poc.js. */
  const origBuildTrees = App.buildTrees;
  App.buildTrees = function () {
    origBuildTrees.call(this);
    const gl = this.gl;
    for (const t of this.treeMeshes) t.mesh.dispose();
    // Canopy density follows the quality tier. Leaf cards are cheap in triangles
    // and expensive in alpha-tested fill, which is exactly what an integrated or
    // mobile GPU is short of.
    const dens = this.tier().leaves;
    this.treeMeshes = [0, 1, 2, 3].map(i =>
      root.FoliagePoc.buildLeafTree(gl, i, 1000 + i * 137, dens));
  };

  /* ------------------------------------------------------- hole transition
   *
   * The original two-phase rebuild has a data race. js/app.js hands the *live*
   * Field in as the recycle target:
   *
   *     const recycle = this.field && this.field.res === 832 ? this.field : {};
   *     if (this.field) this.field.dispose();
   *     this.field = new root.Field(..., { recycle: recycle });
   *
   * Field.build() writes the new hole's signed distances straight into those
   * arrays, so for the frames between the two phases `this.field` is being
   * progressively overwritten with the next hole's data while the renderer and
   * the ball physics are still reading it — and `holeData` has already been
   * swapped, while `detailMesh` still holds the previous hole's geometry. The
   * result is a frame or two of the old ground under the new hole's pin, with
   * the surface classification changing underfoot.
   *
   * This double-buffers instead: build into a retired Field that nothing is
   * reading, then swap every piece of hole state in a single tick. The memory
   * saving the recycling was there for is kept, because the two buffers
   * alternate.
   */

  App.holeFieldSpec = function (n) {
    const H = this.course.holes[clamp(n, 1, 18) - 1];
    const sp = H.spine;
    const mid = sp[Math.floor(sp.length / 2)];
    const tee = sp[0], grn = H.green.c;
    const len = Math.hypot(grn[0] - tee[0], grn[1] - tee[1]);
    return {
      H: H,
      cx: (tee[0] + grn[0] + mid[0] * 2) / 4,
      cz: (tee[1] + grn[1] + mid[1] * 2) / 4,
      // identical to the formula in loadHole, so the field the meshes are built
      // against is the field that was prepared
      size: clamp(len * 1.9 + 240, 620, 880)
    };
  };

  const origLoadHole = App.loadHole;

  App.loadHoleAsync = async function (n, initial, onStep) {
    if (this.loading) return;
    // A background tab never gets requestAnimationFrame, so race it against a
    // timer — otherwise loading a hole in a background tab hangs forever.
    const frame = () => new Promise(resolve => {
      let done = false;
      const fire = () => { if (!done) { done = true; resolve(); } };
      requestAnimationFrame(() => setTimeout(fire, 0));
      setTimeout(fire, 60);
    });

    this.loading = true;
    n = clamp(n, 1, 18);
    try {
      if (onStep) onStep('Shaping the ground');
      await frame();

      const spec = this.holeFieldSpec(n);
      // Build into the retired buffer. Nothing reads it, so it is safe to
      // scribble the next hole's distance fields all over it.
      const next = new root.Field(this.course, spec.cx, spec.cz, spec.size, 832,
        { recycle: this.fieldRetired || {} });

      if (onStep) onStep('Building the corridor');
      await frame();

      /* --- one tick: everything changes together ----------------------- */
      const old = this.field;
      this.field = next;
      if (old) { old.dispose(); this.fieldRetired = old; }
      // scars are painted in the old field's coordinate rect, so keeping them
      // would smear the last hole's divots across this one
      this.clearScars();
      this._focus = undefined;
      origLoadHole.call(this, n, initial, 'rest');
    } finally {
      this.loading = false;
    }
    if (onStep) onStep(null);
  };

  /* ---------------------------------------------------------- furniture
   * The pin and the tee markers are the two props the hero shots put closest to
   * the camera, and both were spheres. A tee marker is a low disc or a wedge of
   * painted timber sitting on the ground, and a flagstick tapers.
   */

  /* Cup dimensions, in metres: the rules say 108 mm across, and a liner
     sits about an inch below the surface and runs four inches down. */
  App.CUP_R = 0.054;
  App.CUP_DEPTH = 0.102;

  /** An open-topped cup: walls facing inward, and a floor. */
  App.buildCup = function (B, pin) {
    const R = this.CUP_R, D = this.CUP_DEPTH, SEG = 20;
    const F = this.field;
    const soil = [0.15, 0.105, 0.07], liner = [0.80, 0.80, 0.77], floor = [0.05, 0.045, 0.04];
    // the wall in two bands: soil at the top, the liner below it
    const bands = [[0, 0.026, soil], [0.026, D, liner]];
    for (const [d0, d1, col] of bands) {
      const v0 = B.pos.length / 3;
      for (let j = 0; j <= 1; j++) {
        for (let i = 0; i <= SEG; i++) {
          const a = i / SEG * Math.PI * 2;
          const cx = Math.cos(a), cz = Math.sin(a);
          const x = pin[0] + cx * R, z = pin[2] + cz * R;
          // the top edge follows the green, so no sliver of wall shows above it
          const top = F ? F.height(x, z) : pin[1];
          const y = j === 0 ? (d0 === 0 ? top + 0.002 : pin[1] - d0) : pin[1] - d1;
          B._push([x, y, z], [-cx, 0.15, -cz], col, 0);
        }
      }
      for (let i = 0; i < SEG; i++) {
        const a = v0 + i, b = a + 1, c = a + SEG + 1, d = c + 1;
        B.idx.push(a, b, c, b, d, c);
      }
    }
    const c0 = B.pos.length / 3;
    B._push([pin[0], pin[1] - D, pin[2]], [0, 1, 0], floor, 0);
    for (let i = 0; i <= SEG; i++) {
      const a = i / SEG * Math.PI * 2;
      B._push([pin[0] + Math.cos(a) * R, pin[1] - D, pin[2] + Math.sin(a) * R], [0, 1, 0], floor, 0);
    }
    for (let i = 0; i < SEG; i++) B.idx.push(c0, c0 + 2 + i, c0 + 1 + i);
  };

  App.buildHoleProps = function () {
    const gl = this.gl;
    const H = this.holeData;
    const F = this.field;
    const B = root.Foliage.propBuilder();
    const R = rng(3000 + this.hole);
    const Y2M = 0.9144;

    const pin = this.pinPos();
    this.pin = pin;
    /* The hole. It used to be two capped cylinders sitting on the green, so
       what you saw was a grey disc where the hole should be. Now the terrain
       shader cuts the green open over CUP_R (see uCup) and this is what is
       underneath: an inch of soil, the white plastic liner, and a dark bottom
       — open at the top. */
    this.buildCup(B, pin);
    // tapered fibreglass stick standing in the bottom of the cup, black ferrule
    const D = this.CUP_DEPTH;
    B.cylinder(pin[0], pin[1] - D, pin[2], 0.011, 0.008, 2.28 + D, [0.94, 0.94, 0.91], 7);
    B.cylinder(pin[0], pin[1] - D + 0.005, pin[2], 0.017, 0.017, 0.07, [0.08, 0.08, 0.08], 7);
    // A flag you can actually pick out from 200 yards. Slightly oversized against
    // the real 45 cm, because at that range it is a couple of pixels and it is
    // the thing the whole shot is aimed at.
    const fdx = Math.cos(R() * 0.4 + 0.6), fdz = Math.sin(R() * 0.4 + 0.6);
    B.flag(pin[0] + 0.02, pin[1] + 1.90, pin[2], fdx, fdz, 0.70, 0.46, [0.90, 0.11, 0.11]);

    const TEE_COLORS = [
      [0.05, 0.05, 0.06], [0.60, 0.10, 0.10], [0.11, 0.24, 0.56],
      [0.88, 0.88, 0.85], [0.84, 0.68, 0.14], [0.74, 0.20, 0.34]
    ];
    H.tees.forEach((t, i) => {
      const a = this.aimAtTee(t);
      const nx = -Math.sin(a), nz = Math.cos(a);
      const col = TEE_COLORS[i % TEE_COLORS.length];
      for (const s of [-1, 1]) {
        const x = t.x + nx * s * 2.4, z = t.z + nz * s * 2.4;
        const y = F.height(x, z);
        // a marker disc: 14 cm across, 6 cm tall, slightly domed
        B.cylinder(x, y - 0.005, z, 0.072, 0.062, 0.055, col, 12);
        B.cylinder(x, y + 0.050, z, 0.062, 0.030, 0.022, col, 12);
      }
    });

    for (const ring of H.bunkers) {
      if (R() > 0.55) continue;
      let sx = 0, sz = 0;
      for (const p of ring) { sx += p[0]; sz += p[1]; }
      sx /= ring.length; sz /= ring.length;
      const ang = R() * Math.PI * 2;
      const px = sx + Math.cos(ang) * 4.5, pz = sz + Math.sin(ang) * 4.5;
      if (!F.contains(px, pz, 5)) continue;
      const y = F.height(px, pz);
      B.cylinder(px, y, pz, 0.016, 0.016, 1.55, [0.30, 0.22, 0.13], 6);
      B.box(px, y + 0.04, pz, 0.28, 0.025, 0.045, [0.18, 0.18, 0.20]);
    }

    const teeP = this.teePos();
    for (const yd of [150, 200, 250]) {
      const p = this.pointAlongSpine(H.green.c, yd * Y2M);
      if (!p || !F.contains(p[0], p[1], 12)) continue;
      if (Math.hypot(p[0] - teeP[0], p[1] - teeP[2]) < 60) continue;
      const off = this.spineNormalAt(p);
      const px = p[0] + off[0] * 26, pz = p[1] + off[1] * 26;
      if (!F.contains(px, pz, 6)) continue;
      const y = F.height(px, pz);
      const col = yd === 150 ? [0.88, 0.86, 0.82] : yd === 200 ? [0.24, 0.38, 0.72] : [0.80, 0.66, 0.16];
      B.cylinder(px, y, pz, 0.028, 0.024, 1.05, col, 7);
      B.ball(px, y + 1.08, pz, 0.048, col, 8, 6);
    }

    if (this.holePropsMesh) this.holePropsMesh.dispose();
    this.holePropsMesh = B.build(gl);

    if (!this.ballMesh) {
      const BB = root.Foliage.propBuilder();
      BB.ball(0, 0, 0, 0.0213, [0.97, 0.97, 0.95], 32, 20);
      this.ballMesh = BB.build(gl);
    }
  };
})(window);
