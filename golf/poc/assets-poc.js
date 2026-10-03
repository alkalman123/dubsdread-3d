/* Photographed materials and sky.
 *
 * Until now every surface in the round was made up in the shader out of noise:
 * convincing at a distance, and recognisably synthetic close up, because real
 * turf, sand and bark have structure that noise does not. These are photo
 * scans (CC0, from Poly Haven and ambientCG — see assets/CREDITS.txt), loaded
 * after the course is already on screen and blended in as they arrive.
 *
 * The photos supply *detail*, not colour. Each layer is divided by its own
 * average, so the shaders keep the palette that was tuned against the sky
 * model and the mowing stripes, and take the grain, the clumping and the
 * relief from the photograph. That is also why nothing looks wrong for the
 * second or two before the images land: the frame was complete without them.
 *
 *   ground-color.jpg   six 1024px layers stacked vertically, one texture array:
 *                      fairway, green, rough, bunker sand, woodland floor, path
 *   ground-normal.jpg  the matching surface relief, 512px
 *   bark.jpg           oak-type bark for the trunks
 *   leaves.png         real leaves cut out of their scans: oak, elm, maple
 *   sky-*.jpg          the sky dome from an HDR photograph, relative to its
 *                      own zenith brightness (see sky.js notes in render-poc)
 */
(function (root) {
  'use strict';

  const App = root.App;
  const { clamp, rng } = root.MM;
  const BASE = 'assets/';

  const A = {
    meta: null,
    img: {},
    ready: false,

    load() {
      fetch(BASE + 'assets.json').then(r => r.json()).then(meta => {
        this.meta = meta;
        const want = { ground: 'ground-color.jpg', groundN: 'ground-normal.jpg',
                       bark: 'bark.jpg', leaves: 'leaves.png' };
        for (const k of Object.keys(meta.skies)) want['sky_' + k] = meta.skies[k].file.replace(BASE, '');
        for (const [k, f] of Object.entries(want)) {
          const im = new Image();
          im.decoding = 'async';
          im.onload = () => { this.img[k] = im; this.pending = true; };
          im.onerror = () => console.warn('[dubsdread] could not load ' + f);
          im.src = BASE + f;
        }
      }).catch(e => console.warn('[dubsdread] no photo assets: ' + e));
    },

    /** Called every frame from the renderer; uploads whatever has arrived. */
    upload(gl) {
      if (!this.pending || !gl) return;
      this.pending = false;
      const T = App.tex = App.tex || {};
      const I = this.img;
      const n = this.meta.layers.length;
      try {
        if (I.ground && !T.ground) T.ground = this.array(gl, I.ground, n, true);
        if (I.groundN && !T.groundN) T.groundN = this.array(gl, I.groundN, n, false);
        if (I.bark && !T.bark) T.bark = this.tex2d(gl, I.bark, true, true);
        for (const k of Object.keys(this.meta.skies)) {
          if (I['sky_' + k] && !(T.sky && T.sky[k])) {
            T.sky = T.sky || {};
            T.sky[k] = this.tex2d(gl, I['sky_' + k], true, false);
          }
        }
        if (I.leaves && !this.leavesDone && App.leafTex) {
          this.leavesDone = true;
          root.FoliagePoc.leafAtlasFromPhotos(gl, App.leafTex, I.leaves, this.meta.leaves);
        }
      } catch (e) {
        console.warn('[dubsdread] photo texture upload failed: ' + ((e && e.message) || e));
      }
      App.photo = !!(T.ground && T.groundN);
      // the sky the player is looking at, once its photo is here
      if (App.poc.realSky && T.sky && T.sky[App.poc.realSky] && !this.skyApplied) {
        this.skyApplied = true;
        App.setRealSky(App.poc.realSky);
      }
    },

    array(gl, img, layers, srgb) {
      const w = img.naturalWidth, h = img.naturalHeight / layers;
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8, w, h, layers, 0,
                    gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
      this.aniso(gl, gl.TEXTURE_2D_ARRAY);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
      return t;
    },

    tex2d(gl, img, srgb, mips) {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      // the sky wraps around in azimuth but must not bleed zenith into horizon
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, mips ? gl.REPEAT : gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      if (mips) {
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        this.aniso(gl, gl.TEXTURE_2D);
      } else {
        // no mips on the sky: the azimuth seam would pick the smallest one
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      }
      gl.bindTexture(gl.TEXTURE_2D, null);
      return t;
    },

    aniso(gl, target) {
      const ext = gl.getExtension('EXT_texture_filter_anisotropic');
      if (ext) gl.texParameterf(target, ext.TEXTURE_MAX_ANISOTROPY_EXT,
        Math.min(8, gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
    }
  };

  /* ------------------------------------------------------------ the sky */

  /**
   * Light the course to match a photographed sky.
   *
   * The photo has a sun in it, at a height and a bearing. The sky model can
   * put the real sun anywhere by the clock, so find the time on this date when
   * the sun stands that high over Cog Hill, light the scene for that time —
   * sun colour, exposure, haze, shadows all follow — and then turn the photo
   * so its sun sits exactly where the light comes from. The clouds you see and
   * the shadows on the fairway then agree.
   */
  App.setRealSky = function (key) {
    const P = this.poc;
    const meta = A.meta && A.meta.skies[key];
    P.realSky = key || null;
    if (!meta) { this.refreshSky(); return; }
    const want = meta.sunEl;
    const SM = root.SkyModel;
    // afternoon: search from midday to sunset for the first time the sun
    // drops to the photo's elevation
    let best = P.minutes, bestErr = 1e9;
    for (let m = 760; m <= 1290; m += 2) {
      const d = this.localDateFor ? this.localDateFor(m) : null;
      const s = d ? SM.solarPosition(d, this.originLat, this.originLon) : null;
      if (!s) break;
      const err = Math.abs(s.elevation - want);
      if (err < bestErr) { bestErr = err; best = m; }
    }
    P.minutes = best;
    P.cloudCover = meta.cover;
    this.refreshSky();
    if (root.UI && root.UI.syncConditions) root.UI.syncConditions();
  };

  /** Rotation that puts the photo's sun on the scene's sun. */
  App.skyRotation = function () {
    const meta = A.meta && A.meta.skies[this.poc.realSky];
    if (!meta) return 0;
    const s = this.sky.sunDir;
    const phi = Math.atan2(s[2], s[0]) / (Math.PI * 2);
    return meta.sunU - phi;
  };

  App.assets = A;
  A.load();
})(window);
