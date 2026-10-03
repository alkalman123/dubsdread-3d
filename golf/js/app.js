/* Renderer, scene assembly and camera. */
(function (root) {
  'use strict';

  const { V3, M4, clamp, lerp, smoothstep, rng, frustumFromVP } = root.MM;
  const M2Y = 1.09361;
  const Y2M = 0.9144;

  /* ------------------------------------------------------------ presets */

  const LIGHTING = {
    morning: {
      name: 'Morning', az: 96, el: 28,
      sun: [1.72, 1.44, 1.10], zenith: [0.118, 0.246, 0.540], horizon: [0.700, 0.716, 0.720],
      ground: [0.25, 0.25, 0.21], turb: 1.4, haze: 0.58, cloud: 0.36,
      exposure: 0.415, fog: 0.00030, bloom: 0.24
    },
    midday: {
      name: 'Midday', az: 168, el: 63,
      sun: [1.66, 1.60, 1.44], zenith: [0.075, 0.196, 0.560], horizon: [0.615, 0.720, 0.855],
      ground: [0.25, 0.27, 0.22], turb: 1.0, haze: 0.42, cloud: 0.30,
      exposure: 0.385, fog: 0.00020, bloom: 0.18
    },
    afternoon: {
      name: 'Afternoon', az: 232, el: 40,
      sun: [1.80, 1.54, 1.18], zenith: [0.100, 0.226, 0.545], horizon: [0.700, 0.745, 0.800],
      ground: [0.27, 0.26, 0.21], turb: 1.3, haze: 0.52, cloud: 0.34,
      exposure: 0.405, fog: 0.00026, bloom: 0.22
    },
    golden: {
      name: 'Golden Hour', az: 262, el: 13,
      sun: [1.98, 1.44, 0.98], zenith: [0.128, 0.200, 0.412], horizon: [0.760, 0.606, 0.452],
      ground: [0.24, 0.20, 0.15], turb: 1.9, haze: 0.72, cloud: 0.40,
      exposure: 0.455, fog: 0.00042, bloom: 0.38
    },
    overcast: {
      name: 'Overcast', az: 180, el: 52,
      sun: [0.92, 0.94, 0.97], zenith: [0.330, 0.372, 0.430], horizon: [0.610, 0.640, 0.672],
      ground: [0.26, 0.27, 0.26], turb: 0.5, haze: 1.00, cloud: 0.88,
      exposure: 0.50, fog: 0.00058, bloom: 0.12
    }
  };

  const CAMERAS = ['tee', 'approach', 'green', 'flyover', 'aerial', 'free'];

  /* ============================================================== App */

  const App = {
    hole: 1,
    lighting: 'midday',
    camMode: 'tee',
    teeSet: 0,
    wind: { speed: 0, dir: 0 },
    quality: 'high',
    showGrass: true,
    time: 0,
    shot: null,
    shotAnim: 0,
    ready: false,

    /* -------------------------------------------------------- bootstrap */
    async init(canvas, onProgress) {
      this.canvas = canvas;
      const gl = canvas.getContext('webgl2', {
        antialias: false, alpha: false, depth: true,
        powerPreference: 'high-performance', preserveDrawingBuffer: false
      });
      if (!gl) throw new Error('WebGL 2 is required.');
      root.__gl = this.gl = gl;
      gl.getExtension('EXT_color_buffer_float');
      gl.getExtension('OES_texture_float_linear');
      this.aniso = gl.getExtension('EXT_texture_filter_anisotropic');

      this.course = root.COURSE;
      const step = async (label, fn) => {
        if (onProgress) onProgress(label);
        await new Promise(r => setTimeout(r, 4));
        return fn();
      };

      await step('Compiling shaders', () => this.buildPrograms());
      await step('Reading the property', () => this.buildWorldField());
      await step('Growing the tree line', () => this.buildTrees());
      await step('Building course furniture', () => this.buildStaticProps());
      await step('Shaping hole 1', () => this.loadHole(1, true));
      await step('Preparing render targets', () => this.resize());

      this.ready = true;
      if (onProgress) onProgress(null);
    },

    buildPrograms() {
      const gl = this.gl, SH = root.SH, P = root.GLX.Program;
      this.pg = {
        sky: new P(gl, SH.skyVert, SH.skyFrag, 'sky'),
        terrain: new P(gl, SH.terrainVert, SH.terrainFrag, 'terrain'),
        tree: new P(gl, SH.treeVert, SH.treeFrag, 'tree'),
        impostor: new P(gl, SH.impostorVert, SH.impostorFrag, 'impostor'),
        water: new P(gl, SH.waterVert, SH.waterFrag, 'water'),
        prop: new P(gl, SH.propVert, SH.propFrag, 'prop'),
        grass: new P(gl, SH.grassVert, SH.grassFrag, 'grass'),
        shadow: new P(gl, SH.shadowVert, SH.shadowFrag, 'shadow'),
        shadowTree: new P(gl, SH.shadowTreeVert, SH.shadowFrag, 'shadowTree'),
        tracer: new P(gl, SH.tracerVert, SH.tracerFrag, 'tracer'),
        bright: new P(gl, SH.fsqVert, SH.brightFrag, 'bright'),
        blur: new P(gl, SH.fsqVert, SH.blurFrag, 'blur'),
        composite: new P(gl, SH.fsqVert, SH.compositeFrag, 'composite')
      };

      this.fsq = new root.GLX.Mesh(gl);
      this.fsq.attr(0, new Float32Array([-1, -1, 3, -1, -1, 3]), 2);
      this.fsq.count = 3;

      this.identity = M4.create();
      this.mView = M4.create();
      this.mProj = M4.create();
      this.mVP = M4.create();
      this.mInvVP = M4.create();
      this.mShadow = [M4.create(), M4.create()];
    },

    /* ------------------------------------------------------ world field */
    buildWorldField() {
      const C = this.course;
      let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
      for (const h of C.holes) for (const p of h.spine) {
        minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
        minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]);
      }
      this.courseCenter = [(minX + maxX) / 2, (minZ + maxZ) / 2];
      const span = Math.max(maxX - minX, maxZ - minZ);
      this.worldField = new root.Field(C, this.courseCenter[0], this.courseCenter[1],
        span + 900, 768);
      this.worldSize = span + 900;
    },

    buildTrees() {
      const gl = this.gl;
      this.treeMeshes = [0, 1, 2, 3].map(i => root.Foliage.buildTreeMesh(gl, i, 1000 + i * 137));
      this.trees = root.Foliage.scatterTrees(this.worldField, this.course,
        { spacing: 12.0, seed: 8123 });

      this.impostorMesh = new root.GLX.Mesh(gl);
      this.impostorMesh.attr(0, new Float32Array([
        -0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5
      ]), 2);
      this.impostorMesh.count = 6;

      this.bladeMesh = root.Foliage.bladeMesh(gl);
      this.treeInstA = [0, 1, 2, 3].map(() => gl.createBuffer());
      this.treeInstB = [0, 1, 2, 3].map(() => gl.createBuffer());
    },

    /* ------------------------------------------- static props: buildings */
    buildStaticProps() {
      const gl = this.gl;
      const B = root.Foliage.propBuilder();
      const R = rng(5150);
      const F = this.worldField;
      for (const ring of this.course.buildings) {
        if (ring.length < 4 || ring.length > 80) continue;
        let sx = 0, sz = 0;
        for (const p of ring) { sx += p[0]; sz += p[1]; }
        sx /= ring.length; sz /= ring.length;
        let area = 0;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          area += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
        }
        area = Math.abs(area) / 2;
        if (area < 40) continue;
        const y = F.height(sx, sz) - 0.4;
        const h = area > 900 ? 7.5 + R() * 3.5 : 4.2 + R() * 2.2;
        const tone = 0.62 + R() * 0.26;
        B.extrude(ring, y, h, [0.50 * tone, 0.46 * tone, 0.43 * tone]);
      }
      this.buildingsMesh = B.pos.length ? B.build(gl) : null;
    },

    /* ------------------------------------------------------- hole setup */
    /**
     * Rebuild everything that is specific to one hole, yielding to the browser
     * between phases so the page keeps painting while it works.
     */
    async loadHoleAsync(n, initial, onStep) {
      // A background tab never gets requestAnimationFrame, so race it against a
      // timer — otherwise opening the preview in a background tab hangs forever.
      const frame = () => new Promise(resolve => {
        let done = false;
        const fire = () => { if (!done) { done = true; resolve(); } };
        requestAnimationFrame(() => setTimeout(fire, 0));
        setTimeout(fire, 60);
      });
      this.loading = true;
      if (onStep) onStep('Shaping the ground');
      await frame();
      this.loadHole(n, initial, 'field');
      if (onStep) onStep('Building the corridor');
      await frame();
      this.loadHole(n, initial, 'rest');
      this.loading = false;
      if (onStep) onStep(null);
    },

    loadHole(n, initial, phase) {
      const gl = this.gl;
      const C = this.course;
      this.hole = clamp(n, 1, 18);
      const H = this.holeData = C.holes[this.hole - 1];

      const sp = H.spine;
      const mid = sp[Math.floor(sp.length / 2)];
      const tee = sp[0], grn = H.green.c;
      const cx = (tee[0] + grn[0] + mid[0] * 2) / 4;
      const cz = (tee[1] + grn[1] + mid[1] * 2) / 4;
      const len = Math.hypot(grn[0] - tee[0], grn[1] - tee[1]);
      this.focus = [cx, cz];

      const fieldSize = clamp(len * 1.9 + 240, 620, 880);
      // hand the previous hole's buffers back so the rebuild does not churn
      // ~30 MB of typed arrays every time the user clicks a new hole
      if (phase !== 'rest') {
        const recycle = this.field && this.field.res === 832 ? this.field : {};
        if (this.field) this.field.dispose();
        this.field = new root.Field(C, cx, cz, fieldSize, 832, { recycle: recycle });
        if (phase === 'field') return;
      }

      if (this.detailMesh) this.detailMesh.dispose();
      if (this.worldMesh) this.worldMesh.dispose();
      if (this.waterMesh) this.waterMesh.dispose();

      const dSize = fieldSize - 90;
      const dRes = this.quality === 'high' ? 384 : 288;
      this.detailBox = { x0: cx - dSize / 2, z0: cz - dSize / 2, x1: cx + dSize / 2, z1: cz + dSize / 2 };
      this.detailMesh = root.Terrain.buildGrid(gl, this.field, {
        x0: cx - dSize / 2, z0: cz - dSize / 2, size: dSize, res: dRes
      });

      const ws = this.worldSize;
      this.worldMesh = root.Terrain.buildGrid(gl, this.worldField, {
        x0: this.courseCenter[0] - ws / 2, z0: this.courseCenter[1] - ws / 2,
        size: ws, res: 256, skip: this.detailBox
      });

      this.waterMesh = root.Terrain.buildWater(gl, this.worldField);

      // trees, packed near/far around this hole
      const pack = root.Foliage.packTrees(gl, this.trees, H.spine,
        this.quality === 'high' ? 165 : 110, 1050);
      this.treePack = pack;
      for (let i = 0; i < 4; i++) {
        const p = pack.near[i];
        this.treeMeshes[i].mesh.instances = p.n;
        if (p.n) {
          gl.bindVertexArray(this.treeMeshes[i].mesh.vao);
          gl.bindBuffer(gl.ARRAY_BUFFER, this.treeInstA[i]);
          gl.bufferData(gl.ARRAY_BUFFER, p.a, gl.STATIC_DRAW);
          gl.vertexAttribPointer(3, 4, gl.FLOAT, false, 0, 0);
          gl.enableVertexAttribArray(3); gl.vertexAttribDivisor(3, 1);
          gl.bindBuffer(gl.ARRAY_BUFFER, this.treeInstB[i]);
          gl.bufferData(gl.ARRAY_BUFFER, p.b, gl.STATIC_DRAW);
          gl.vertexAttribPointer(4, 4, gl.FLOAT, false, 0, 0);
          gl.enableVertexAttribArray(4); gl.vertexAttribDivisor(4, 1);
          gl.bindVertexArray(null);
        }
      }
      if (!this.impA) { this.impA = gl.createBuffer(); this.impB = gl.createBuffer(); }
      this.impostorMesh.instances = pack.far.n;
      gl.bindVertexArray(this.impostorMesh.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.impA);
      gl.bufferData(gl.ARRAY_BUFFER, pack.far.a, gl.STATIC_DRAW);
      gl.vertexAttribPointer(3, 4, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(3); gl.vertexAttribDivisor(3, 1);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.impB);
      gl.bufferData(gl.ARRAY_BUFFER, pack.far.b, gl.STATIC_DRAW);
      gl.vertexAttribPointer(4, 4, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(4); gl.vertexAttribDivisor(4, 1);
      gl.bindVertexArray(null);

      this.buildHoleProps();
      this.grassAt = null;
      this.shot = null;
      this.ballPos = this.teePos();
      this.teeSet = clamp(this.teeSet, 0, H.tees.length - 1);
      this.aim = this.defaultAim();
      this.setCamera(initial ? 'tee' : this.camMode, true);
      this.updateGrass(true);
      if (root.UI) root.UI.onHoleChanged();
    },

    defaultAim() {
      const H = this.holeData;
      const t = this.teePos();
      const g = H.green.c;
      // aim at the widest point of the fairway for long holes, at the flag otherwise
      const sp = H.spine;
      const target = H.par >= 4 && H.yards > 300
        ? sp[Math.min(sp.length - 1, Math.round(sp.length * 0.55))]
        : [g[0], g[1]];
      return Math.atan2(target[1] - t[2], target[0] - t[0]);
    },

    teePos() {
      const H = this.holeData;
      const t = H.tees[clamp(this.teeSet, 0, H.tees.length - 1)] || { x: H.spine[0][0], z: H.spine[0][1] };
      return [t.x, this.field.height(t.x, t.z) + 0.06, t.z];
    },

    pinPos() {
      const H = this.holeData;
      const g = H.green.c;
      return [g[0], this.field.height(g[0], g[1]), g[1]];
    },

    /* ------------------------------------------------ per-hole furniture */
    buildHoleProps() {
      const gl = this.gl;
      const H = this.holeData;
      const F = this.field;
      const B = root.Foliage.propBuilder();
      const R = rng(3000 + this.hole);

      // flagstick + flag at the pin
      const pin = this.pinPos();
      this.pin = pin;
      B.cylinder(pin[0], pin[1], pin[2], 0.030, 0.024, 2.30, [0.96, 0.96, 0.94], 8);
      B.cylinder(pin[0], pin[1] + 0.55, pin[2], 0.032, 0.032, 0.30, [0.10, 0.10, 0.10], 8);
      const fdx = Math.cos(R() * 0.4 + 0.6), fdz = Math.sin(R() * 0.4 + 0.6);
      B.flag(pin[0] + 0.03, pin[1] + 1.92, pin[2], fdx, fdz, 0.62, 0.40, [0.88, 0.12, 0.12]);
      // cup
      B.cylinder(pin[0], pin[1] - 0.11, pin[2], 0.054, 0.054, 0.10, [0.10, 0.10, 0.09], 12);

      // tee markers on every tee box
      const TEE_COLORS = [
        [0.10, 0.10, 0.11], [0.66, 0.13, 0.13], [0.13, 0.28, 0.62],
        [0.90, 0.90, 0.88], [0.86, 0.70, 0.16], [0.78, 0.22, 0.36]
      ];
      H.tees.forEach((t, i) => {
        const a = this.aimAtTee(t);
        const nx = -Math.sin(a), nz = Math.cos(a);
        const col = TEE_COLORS[i % TEE_COLORS.length];
        for (const s of [-1, 1]) {
          const x = t.x + nx * s * 2.4, z = t.z + nz * s * 2.4;
          const y = F.height(x, z);
          B.ball(x, y + 0.075, z, 0.092, col, 10, 7);
          B.cylinder(x, y - 0.02, z, 0.042, 0.042, 0.08, [0.2, 0.2, 0.2], 8);
        }
      });

      // bunker rakes leaning on a few traps
      for (const ring of H.bunkers) {
        if (R() > 0.55) continue;
        let sx = 0, sz = 0;
        for (const p of ring) { sx += p[0]; sz += p[1]; }
        sx /= ring.length; sz /= ring.length;
        const ang = R() * Math.PI * 2;
        const px = sx + Math.cos(ang) * 4.5, pz = sz + Math.sin(ang) * 4.5;
        if (!F.contains(px, pz, 5)) continue;
        const y = F.height(px, pz);
        B.cylinder(px, y, pz, 0.018, 0.018, 1.55, [0.32, 0.24, 0.14], 6);
        B.box(px, y + 0.05, pz, 0.30, 0.03, 0.05, [0.20, 0.20, 0.22]);
      }

      // 150-yard stakes down the fairway
      const teeP = this.teePos();
      for (const yd of [150, 200, 250]) {
        const d = yd * Y2M;
        const p = this.pointAlongSpine(H.green.c, d);
        if (!p) continue;
        if (!F.contains(p[0], p[1], 12)) continue;
        const dToTee = Math.hypot(p[0] - teeP[0], p[1] - teeP[2]);
        if (dToTee < 60) continue;
        const off = this.spineNormalAt(p) ;
        const px = p[0] + off[0] * 26, pz = p[1] + off[1] * 26;
        if (!F.contains(px, pz, 6)) continue;
        const y = F.height(px, pz);
        const col = yd === 150 ? [0.92, 0.90, 0.86] : yd === 200 ? [0.30, 0.45, 0.80] : [0.85, 0.72, 0.20];
        B.cylinder(px, y, pz, 0.035, 0.030, 1.05, col, 7);
        B.ball(px, y + 1.10, pz, 0.055, col, 8, 6);
      }

      if (this.holePropsMesh) this.holePropsMesh.dispose();
      this.holePropsMesh = B.build(gl);

      // ball marker (rebuilt when a shot is played)
      const BB = root.Foliage.propBuilder();
      BB.ball(0, 0, 0, 0.0213, [0.98, 0.98, 0.96], 16, 11);
      if (!this.ballMesh) this.ballMesh = BB.build(gl);
    },

    aimAtTee(t) {
      const H = this.holeData;
      let best = null, bd = 1e9;
      for (let i = 0; i < H.spine.length; i++) {
        const d = Math.hypot(H.spine[i][0] - t.x, H.spine[i][1] - t.z);
        if (d < bd) { bd = d; best = i; }
      }
      const a = H.spine[Math.min(best + 3, H.spine.length - 1)];
      return Math.atan2(a[1] - t.z, a[0] - t.x);
    },

    /** Walk back from the green along the spine by d metres. */
    pointAlongSpine(from, d) {
      const sp = this.holeData.spine;
      let acc = 0;
      for (let i = sp.length - 1; i > 0; i--) {
        const a = sp[i], b = sp[i - 1];
        const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (acc + seg >= d) {
          const t = (d - acc) / seg;
          return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        }
        acc += seg;
      }
      return null;
    },

    spineNormalAt(p) {
      const sp = this.holeData.spine;
      let bi = 0, bd = 1e9;
      for (let i = 0; i < sp.length; i++) {
        const d = Math.hypot(sp[i][0] - p[0], sp[i][1] - p[1]);
        if (d < bd) { bd = d; bi = i; }
      }
      const a = sp[Math.max(0, bi - 1)], b = sp[Math.min(sp.length - 1, bi + 1)];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const l = Math.hypot(dx, dz) || 1;
      return [-dz / l, dx / l];
    },

    /* --------------------------------------------------------- camera */
    setCamera(mode, snap) {
      this.camMode = mode;
      const H = this.holeData;
      const F = this.field;
      const tee = this.teePos();
      const pin = this.pinPos();
      const sp = H.spine;
      const len = H.yards * Y2M;

      const dirTo = (a, b) => Math.atan2(b[2] !== undefined ? b[2] - a[2] : b[1] - a[1],
                                         b[0] - a[0]);

      let dist, yaw, pitch, fov;
      const ground = (x, z) => (F.contains(x, z, 2) ? F : this.worldField).height(x, z);
      /** Frame a drone shot: sit `back` metres short of `target`, `up` metres high. */
      const drone = (target, back, up, fovDeg) => {
        const from = this.pointAlongSpine(pin, back) || [tee[0], tee[2]];
        const ex = from[0], ez = from[1];
        const ey = ground(ex, ez) + up;
        const y2 = ground(target[0], target[1]);
        const yw = Math.atan2(target[1] - ez, target[0] - ex);
        const pt = Math.atan2(y2 - ey, Math.hypot(target[0] - ex, target[1] - ez));
        this.camFixed = { eye: [ex, ey, ez], yaw: yw, pitch: pt };
        return fovDeg;
      };

      if (mode === 'tee') {
        // look at where the tee shot is meant to finish, not at your feet
        const lookAhead = H.par === 3 ? len : Math.min(len * 0.72, 250 * Y2M);
        const aimPt = this.pointAlongSpine(pin, Math.max(len - lookAhead, 8)) || [pin[0], pin[2]];
        const ay = ground(aimPt[0], aimPt[1]);
        yaw = Math.atan2(aimPt[1] - tee[2], aimPt[0] - tee[0]);
        // stand back far enough that the ball at address is in shot, the way a
        // course guide frames a tee photograph
        const ex = tee[0] - Math.cos(yaw) * 5.4;
        const ez = tee[2] - Math.sin(yaw) * 5.4;
        const ey = ground(ex, ez) + 1.72;
        pitch = Math.atan2(ay + 1.0 - ey, Math.hypot(aimPt[0] - ex, aimPt[1] - ez));
        this.camFixed = { eye: [ex, ey, ez], yaw, pitch: clamp(pitch, -0.215, -0.055) };
        fov = 47;
      } else if (mode === 'approach') {
        // drone hovering over the landing zone, looking down the rest of the hole
        const back = clamp(len * 0.42, 110, 175);
        const tgt = this.pointAlongSpine(pin, back * 0.34) || [pin[0], pin[2]];
        fov = drone(tgt, back, 26, 42);
      } else if (mode === 'green') {
        // the green complex from short and above, the way a course book shows it
        fov = drone([pin[0], pin[2]], Math.min(72, len * 0.30), 30, 40);
      } else if (mode === 'aerial') {
        const cx = (tee[0] + pin[0]) / 2, cz = (tee[2] + pin[2]) / 2;
        this.orbit = {
          target: [cx, ground(cx, cz) + 6, cz],
          dist: len * 0.90 + 110,
          yaw: Math.atan2(pin[2] - tee[2], pin[0] - tee[0]) + Math.PI,
          pitch: -0.62
        };
        this.camFixed = null; fov = 42;
      } else if (mode === 'flyover') {
        this.flyT = 0;
        this.camFixed = null; fov = 46;
      } else {
        this.camFixed = null;
        fov = this.fov || 45;
        if (!this.orbit) {
          const cx = (tee[0] + pin[0]) / 2, cz = (tee[2] + pin[2]) / 2;
          this.orbit = {
            target: [cx, ground(cx, cz) + 4, cz], dist: len * 0.8 + 90,
            yaw: Math.atan2(pin[2] - tee[2], pin[0] - tee[0]) + Math.PI, pitch: -0.5
          };
        }
      }
      this.fovTarget = fov;
      if (snap) {
        this.fov = fov;
        this.camPos = null;
      }
      if (root.UI) root.UI.onCameraChanged();
    },

    /** Convert whatever the current mode wants into eye/target for this frame. */
    updateCamera(dt) {
      const F = this.field;
      const H = this.holeData;
      let eye, look;

      if (this.camMode === 'flyover') {
        const total = this.spineLength();
        // hold a roughly constant ground speed whatever the hole length
        this.flyT += dt * (this.flySpeed || 1) * (26 / Math.max(total, 60));
        if (this.flyT > 1) { this.flyT = 0; this.camPos = null; }
        const t = clamp(this.flyT, 0, 1);
        const d = t * total;
        const p = this.pointAtDist(d);
        // The look-ahead has to be long compared with the altitude, otherwise
        // the camera ends up staring at its own feet.
        const la = this.pointAtDist(d + 175);
        const climb = Math.sin(Math.PI * clamp(t, 0, 1));
        const hgt = 23 + 21 * climb;
        const gy = this.heightAt(p[0], p[1]);
        eye = [p[0], gy + hgt, p[1]];
        look = [la[0], this.heightAt(la[0], la[1]) + 5, la[1]];
      } else if (this.camFixed) {
        const c = this.camFixed;
        eye = c.eye.slice();
        look = [
          eye[0] + Math.cos(c.yaw) * Math.cos(c.pitch),
          eye[1] + Math.sin(c.pitch),
          eye[2] + Math.sin(c.yaw) * Math.cos(c.pitch)
        ];
      } else {
        const o = this.orbit;
        const cp = Math.cos(o.pitch), sp2 = Math.sin(o.pitch);
        eye = [
          o.target[0] - Math.cos(o.yaw) * cp * o.dist,
          o.target[1] - sp2 * o.dist,
          o.target[2] - Math.sin(o.yaw) * cp * o.dist
        ];
        const gy = F.height(eye[0], eye[2]) + 2.2;
        if (eye[1] < gy) eye[1] = gy;
        look = o.target.slice();
      }

      // smooth
      if (!this.camPos) { this.camPos = eye.slice(); this.camLook = look.slice(); }
      const k = 1 - Math.pow(0.0016, dt);
      for (let i = 0; i < 3; i++) {
        this.camPos[i] = lerp(this.camPos[i], eye[i], k);
        this.camLook[i] = lerp(this.camLook[i], look[i], k);
      }
      this.fov = lerp(this.fov || this.fovTarget, this.fovTarget, 1 - Math.pow(0.02, dt));
    },

    spineLength() {
      const sp = this.holeData.spine;
      let l = 0;
      for (let i = 1; i < sp.length; i++) l += Math.hypot(sp[i][0] - sp[i - 1][0], sp[i][1] - sp[i - 1][1]);
      return l;
    },

    /** Point on the hole spine `d` metres from the tee (clamped past the green). */
    pointAtDist(d) {
      const sp = this.holeData.spine;
      let acc = 0;
      for (let i = 1; i < sp.length; i++) {
        const seg = Math.hypot(sp[i][0] - sp[i - 1][0], sp[i][1] - sp[i - 1][1]);
        if (acc + seg >= d) {
          const u = (d - acc) / seg;
          return [lerp(sp[i - 1][0], sp[i][0], u), lerp(sp[i - 1][1], sp[i][1], u)];
        }
        acc += seg;
      }
      // extend past the green along the last segment so the look-ahead keeps working
      const a = sp[sp.length - 2], b = sp[sp.length - 1];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const l = Math.hypot(dx, dz) || 1;
      const over = d - acc;
      return [b[0] + dx / l * over, b[1] + dz / l * over];
    },

    pointAtT(t) {
      const sp = this.holeData.spine;
      const total = this.spineLength();
      let d = t * total, acc = 0;
      for (let i = 1; i < sp.length; i++) {
        const seg = Math.hypot(sp[i][0] - sp[i - 1][0], sp[i][1] - sp[i - 1][1]);
        if (acc + seg >= d) {
          const u = (d - acc) / seg;
          return [lerp(sp[i - 1][0], sp[i][0], u), lerp(sp[i - 1][1], sp[i][1], u)];
        }
        acc += seg;
      }
      return sp[sp.length - 1].slice();
    },

    /* ---------------------------------------------------------- grass */
    updateGrass(force) {
      if (!this.showGrass) { if (this.grass) this.grass.n = 0; return; }
      const c = this.camPos || [this.focus[0], 0, this.focus[1]];
      if (!force && this.grassAt &&
          Math.hypot(c[0] - this.grassAt[0], c[2] - this.grassAt[1]) < 5) return;
      const fx = c[0], fz = c[2];
      if (!this.field.contains(fx, fz, 20)) { if (this.grass) this.grass.n = 0; return; }
      const pack = root.Foliage.scatterGrass(this.field, fx, fz, 20,
        this.quality === 'high' ? 30000 : 12000, 4242);
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
    },

    /* --------------------------------------------------------- resize */
    resize() {
      const gl = this.gl;
      const dpr = Math.min(window.devicePixelRatio || 1, this.quality === 'high' ? 1.5 : 1.0);
      const w = Math.max(2, Math.round(this.canvas.clientWidth * dpr));
      const h = Math.max(2, Math.round(this.canvas.clientHeight * dpr));
      if (this.canvas.width === w && this.canvas.height === h && this.rt) return;
      this.canvas.width = w; this.canvas.height = h;
      if (this.rt) { this.rt.dispose(); this.bloomA.dispose(); this.bloomB.dispose(); }
      this.rt = new root.GLX.RenderTarget(gl, w, h, { float: true, depth: true });
      const bw = Math.max(2, w >> 2), bh = Math.max(2, h >> 2);
      this.bloomA = new root.GLX.RenderTarget(gl, bw, bh, { float: true, depth: false });
      this.bloomB = new root.GLX.RenderTarget(gl, bw, bh, { float: true, depth: false });
      if (!this.sm) {
        const S = 2048;
        this.sm = [
          new root.GLX.RenderTarget(gl, S, S, { color: false, depthTexture: true }),
          new root.GLX.RenderTarget(gl, S, S, { color: false, depthTexture: true })
        ];
        this.smSize = S;
      }
    },

    /* --------------------------------------------------- sun / lighting */
    sunDir() {
      const L = LIGHTING[this.lighting];
      const az = L.az * Math.PI / 180, el = L.el * Math.PI / 180;
      return [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)];
    },

    applyEnv(pg) {
      const L = LIGHTING[this.lighting];
      const s = this.sunDir();
      pg.v3('uSunDir', s[0], s[1], s[2]);
      pg.v3('uSunColor', L.sun[0], L.sun[1], L.sun[2]);
      pg.v3('uSkyZenith', L.zenith[0], L.zenith[1], L.zenith[2]);
      pg.v3('uSkyHorizon', L.horizon[0], L.horizon[1], L.horizon[2]);
      pg.v3('uGroundTint', L.ground[0], L.ground[1], L.ground[2]);
      pg.f('uTurbidity', L.turb);
      pg.f('uHaze', L.haze);
      pg.f('uCloudCover', L.cloud);
      pg.f('uTime', this.time);
      pg.f('uExposure', L.exposure);
      pg.f('uFogDensity', L.fog);
      pg.v3('uCamPos', this.camPos[0], this.camPos[1], this.camPos[2]);
      pg.f('uWind', 0.25 + this.wind.speed * 0.05);
    },

    applyShadowUniforms(pg) {
      pg.m4('uShadowVP0', this.mShadow[0]);
      pg.m4('uShadowVP1', this.mShadow[1]);
      pg.v2('uShadowTexel', 1 / this.smSize, 1 / this.smSize);
      pg.f('uCascadeSplit', this.cascadeSplit);
      pg.tex('uShadow0', this.sm[0].depth);
      pg.tex('uShadow1', this.sm[1].depth);
    },

    fieldRect(f) { return [f.x0, f.z0, f.size, 1 / f.size]; },

    /* ---------------------------------------------------- shadow setup */
    buildShadowMatrices() {
      const s = this.sunDir();
      const target = this.camLook;
      const spans = [Math.max(115, this.spineLength() * 0.22), Math.max(520, this.spineLength() * 1.15)];
      this.cascadeSplit = spans[0] * 0.92;
      for (let c = 0; c < 2; c++) {
        const span = spans[c];
        // centre the cascade a little ahead of the camera
        const cx = lerp(this.camPos[0], target[0], 0.55);
        const cz = lerp(this.camPos[2], target[2], 0.55);
        const cy = this.field.height(cx, cz);
        const texel = (span * 2) / this.smSize;
        const sx = Math.round(cx / texel) * texel;
        const sz = Math.round(cz / texel) * texel;
        const dist = span * 2.2 + 240;
        const eye = [sx + s[0] * dist, cy + s[1] * dist, sz + s[2] * dist];
        const view = M4.lookAt(M4.create(), eye, [sx, cy, sz], [0, 1, 0]);
        const proj = M4.ortho(M4.create(), -span, span, -span, span, 1, dist * 2 + span * 2);
        M4.mul(this.mShadow[c], proj, view);
      }
    },

    renderShadowPass() {
      const gl = this.gl;
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      // The terrain is an open sheet, so front-face culling (the usual bias
      // trick) would drop it from the map entirely. Render both sides and lean
      // on a depth-slope offset instead.
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(1.6, 3.5);
      for (let c = 0; c < 2; c++) {
        this.sm[c].bind();
        gl.clear(gl.DEPTH_BUFFER_BIT);
        const p = this.pg.shadow.use();
        p.m4('uViewProj', this.mShadow[c]).m4('uModel', this.identity);
        this.detailMesh.draw();
        if (c === 1) this.worldMesh.draw();
        if (this.buildingsMesh) this.buildingsMesh.draw();
        if (this.holePropsMesh) this.holePropsMesh.draw();

        const pt = this.pg.shadowTree.use();
        pt.m4('uViewProj', this.mShadow[c]);
        for (let i = 0; i < 4; i++) {
          const m = this.treeMeshes[i].mesh;
          if (m.instances) m.draw();
        }
      }
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    },

    /* ---------------------------------------------------------- render */
    render(dt) {
      if (!this.ready) return;
      const gl = this.gl;
      this.time += dt;
      this.resize();
      this.updateCamera(dt);
      this.updateGrass(false);

      const aspect = this.canvas.width / this.canvas.height;
      M4.perspective(this.mProj, this.fov * Math.PI / 180, aspect, 0.25, 6000);
      M4.lookAt(this.mView, this.camPos, this.camLook, [0, 1, 0]);
      M4.mul(this.mVP, this.mProj, this.mView);
      M4.invert(this.mInvVP, this.mVP);

      this.buildShadowMatrices();
      this.renderShadowPass();

      this.rt.bind();
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.enable(gl.CULL_FACE);
      gl.disable(gl.BLEND);

      /* sky */
      gl.depthMask(false);
      gl.disable(gl.CULL_FACE);
      {
        const p = this.pg.sky.use();
        this.applyEnv(p);
        p.m4('uInvViewProj', this.mInvVP);
        p.v3('uCamPos', this.camPos[0], this.camPos[1], this.camPos[2]);
        this.fsq.draw();
      }
      gl.depthMask(true);
      gl.enable(gl.CULL_FACE);

      /* terrain */
      {
        const p = this.pg.terrain.use();
        this.applyEnv(p);
        this.applyShadowUniforms(p);
        p.m4('uViewProj', this.mVP);
        const mow = this.mowDir();
        p.v2('uMowDir', mow[0], mow[1]);

        let r = this.fieldRect(this.worldField);
        p.v4('uFieldRect', r[0], r[1], r[2], r[3]);
        p.f('uDetail', 0);
        p.tex('uFieldA', this.worldField.texA).tex('uFieldB', this.worldField.texB);
        this.worldMesh.draw();

        const p2 = this.pg.terrain.use();
        this.applyEnv(p2);
        this.applyShadowUniforms(p2);
        p2.m4('uViewProj', this.mVP);
        p2.v2('uMowDir', mow[0], mow[1]);
        r = this.fieldRect(this.field);
        p2.v4('uFieldRect', r[0], r[1], r[2], r[3]);
        p2.f('uDetail', 1);
        p2.tex('uFieldA', this.field.texA).tex('uFieldB', this.field.texB);
        this.detailMesh.draw();
      }

      /* water */
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

      /* trees */
      {
        gl.disable(gl.CULL_FACE);
        const p = this.pg.tree.use();
        this.applyEnv(p);
        this.applyShadowUniforms(p);
        p.m4('uViewProj', this.mVP);
        p.f('uAlphaCut', 0.30);
        for (let i = 0; i < 4; i++) {
          const m = this.treeMeshes[i].mesh;
          if (m.instances) m.draw();
        }
        const q = this.pg.impostor.use();
        this.applyEnv(q);
        q.m4('uViewProj', this.mVP);
        q.v3('uCamPosB', this.camPos[0], this.camPos[1], this.camPos[2]);
        if (this.impostorMesh.instances) this.impostorMesh.draw();
        gl.enable(gl.CULL_FACE);
      }

      /* props */
      {
        const p = this.pg.prop.use();
        this.applyEnv(p);
        this.applyShadowUniforms(p);
        p.m4('uViewProj', this.mVP).m4('uModel', this.identity);
        p.f('uEmissive', 0).f('uRough', 0.75);
        p.f('uTimeP', this.time).f('uWindP', this.wind.speed * 0.06);
        gl.disable(gl.CULL_FACE);
        if (this.holePropsMesh) this.holePropsMesh.draw();
        gl.enable(gl.CULL_FACE);
        if (this.buildingsMesh) {
          p.f('uRough', 0.9);
          this.buildingsMesh.draw();
        }
        // ball
        if (this.ballPos) {
          const m = M4.identity(M4.create());
          m[12] = this.ballPos[0]; m[13] = this.ballPos[1] + 0.0213; m[14] = this.ballPos[2];
          p.m4('uModel', m).f('uRough', 0.28).f('uEmissive', 0.03);
          this.ballMesh.draw();
          p.m4('uModel', this.identity);
        }
      }

      /* grass */
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

      /* shot tracer */
      if (this.tracerMesh && this.shotAnim > 0) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
        gl.depthMask(false);
        gl.disable(gl.CULL_FACE);
        const p = this.pg.tracer.use();
        p.m4('uViewProj', this.mVP);
        p.v3('uCamPosT', this.camPos[0], this.camPos[1], this.camPos[2]);
        p.v3('uColor', 1.0, 0.93, 0.72);
        p.f('uWidth', 0.42).f('uProgress', clamp(this.shotAnim, 0, 1))
         .f('uExposure', LIGHTING[this.lighting].exposure);
        this.tracerMesh.draw();
        gl.depthMask(true);
        gl.disable(gl.BLEND);
        gl.enable(gl.CULL_FACE);
      }

      /* ------------------------------------------------------ post */
      const L = LIGHTING[this.lighting];
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);

      this.bloomA.bind();
      { const p = this.pg.bright.use(); p.tex('uTex', this.rt.color).f('uThreshold', 1.05); this.fsq.draw(); }
      this.bloomB.bind();
      { const p = this.pg.blur.use(); p.tex('uTex', this.bloomA.color).v2('uDir', 1 / this.bloomA.w, 0); this.fsq.draw(); }
      this.bloomA.bind();
      { const p = this.pg.blur.use(); p.tex('uTex', this.bloomB.color).v2('uDir', 0, 1 / this.bloomA.h); this.fsq.draw(); }
      this.bloomB.bind();
      { const p = this.pg.blur.use(); p.tex('uTex', this.bloomA.color).v2('uDir', 2.2 / this.bloomA.w, 0); this.fsq.draw(); }
      this.bloomA.bind();
      { const p = this.pg.blur.use(); p.tex('uTex', this.bloomB.color).v2('uDir', 0, 2.2 / this.bloomA.h); this.fsq.draw(); }

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      {
        const p = this.pg.composite.use();
        p.tex('uTex', this.rt.color).tex('uBloom', this.bloomA.color);
        p.v2('uTexel', 1 / this.canvas.width, 1 / this.canvas.height);
        p.f('uBloomAmt', L.bloom).f('uVignette', 0.28)
         .f('uSaturation', 1.09).f('uContrast', 1.06);
        this.fsq.draw();
      }
      gl.enable(gl.DEPTH_TEST);
    },

    mowDir() {
      const H = this.holeData;
      const sp = H.spine;
      const a = sp[0], b = sp[sp.length - 1];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const l = Math.hypot(dx, dz) || 1;
      return [dx / l, dz / l];
    },

    /* ------------------------------------------------------- picking */
    /** Ray from screen (0..1 ndc) to the terrain; returns [x,y,z] or null. */
    pick(ndcX, ndcY) {
      const p0 = new Float32Array(3), p1 = new Float32Array(3);
      M4.xformPoint(p0, this.mInvVP, [ndcX, ndcY, -1]);
      M4.xformPoint(p1, this.mInvVP, [ndcX, ndcY, 1]);
      const d = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
      const L = Math.hypot(d[0], d[1], d[2]) || 1;
      d[0] /= L; d[1] /= L; d[2] /= L;
      let t = 0, last = p0[1] - this.heightAt(p0[0], p0[2]);
      for (let i = 0; i < 620; i++) {
        const step = t < 120 ? 0.9 : t < 500 ? 3.5 : 12;
        t += step;
        if (t > 4200) break;
        const x = p0[0] + d[0] * t, y = p0[1] + d[1] * t, z = p0[2] + d[2] * t;
        const diff = y - this.heightAt(x, z);
        if (diff <= 0 && last > 0) {
          const f = last / (last - diff);
          const tt = t - step + step * f;
          const hx = p0[0] + d[0] * tt, hz = p0[2] + d[2] * tt;
          return [hx, this.heightAt(hx, hz), hz];
        }
        last = diff;
      }
      return null;
    },

    heightAt(x, z) {
      return this.field.contains(x, z, 1) ? this.field.height(x, z) : this.worldField.height(x, z);
    },

    /* --------------------------------------------------------- shots */
    playShot(opts) {
      if (this.loading) return null;
      const o = Object.assign({
        origin: this.ballPos || this.teePos(),
        aim: this.aim,
        club: this.club || 'D',
        profile: this.profile || 'tour',
        shape: this.shape || 0,
        power: this.power === undefined ? 1 : this.power,
        wind: this.windVec(),
        field: this.field
      }, opts || {});
      const res = root.Shot.simulate(o);
      this.shot = res;
      this.buildTracer(res);
      this.shotAnim = 0;
      this.ballPos = null;
      return res;
    },

    windVec() {
      const a = this.wind.dir * Math.PI / 180;
      return [Math.cos(a) * this.wind.speed, Math.sin(a) * this.wind.speed];
    },

    buildTracer(res) {
      const gl = this.gl;
      const pts = res.path.concat(res.roll);
      if (pts.length < 3) return;
      const pos = [], side = [], dir = [];
      const n = pts.length;
      for (let i = 0; i < n; i++) {
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
        const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
        const t = i / (n - 1);
        for (const s of [-1, 1]) {
          pos.push(pts[i][0], pts[i][1], pts[i][2]);
          side.push(s, t);
          dir.push(dx, dy, dz);
        }
      }
      const idx = [];
      for (let i = 0; i < n - 1; i++) {
        const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
        idx.push(a, c, b, b, c, d);
      }
      if (this.tracerMesh) this.tracerMesh.dispose();
      const m = new root.GLX.Mesh(gl);
      m.attr(0, new Float32Array(pos), 3);
      m.attr(1, new Float32Array(side), 2);
      m.attr(2, new Float32Array(dir), 3);
      m.index(new Uint32Array(idx));
      this.tracerMesh = m;
      this.tracerPoints = pts;
    },

    advanceShot(dt) {
      if (!this.shot) return;
      if (this.shotAnim < 1) {
        const dur = clamp(this.shot.stats.hangTime * 0.62 + 1.0, 1.4, 4.2);
        this.shotAnim = clamp(this.shotAnim + dt / dur, 0, 1);
        const pts = this.tracerPoints;
        if (pts) {
          const i = clamp(Math.floor(this.shotAnim * (pts.length - 1)), 0, pts.length - 1);
          this.ballPos = pts[i];
        }
        if (this.shotAnim >= 1) this.ballPos = this.shot.finalPoint;
        if (root.UI) root.UI.onShotProgress(this.shotAnim);
      }
    },

    clearShot() {
      this.shot = null;
      this.shotAnim = 0;
      this.ballPos = this.holeData ? this.teePos() : null;
      this.aimPoint = null;
      if (this.tracerMesh) { this.tracerMesh.dispose(); this.tracerMesh = null; }
    }
  };

  App.LIGHTING = LIGHTING;
  App.CAMERAS = CAMERAS;
  root.App = App;
})(window);
