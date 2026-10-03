/* Sound.
 *
 * Everything here is synthesised with Web Audio rather than played from
 * recordings: nothing to download, nothing to license, and every strike can be
 * a little different. Each sound is built from the two things real ones are
 * made of — a burst of filtered noise for the contact, and a few decaying tones
 * for whatever rings afterwards (a titanium driver head, a plastic cup liner).
 *
 * Phones only allow audio after a touch, so the context is created on the
 * first tap or key press. A speaker button turns it all off, and remembers.
 */
(function (root) {
  'use strict';

  const App = root.App, Play = root.Play;
  const { clamp } = root.MM;
  const R = Math.random;

  const Snd = {
    ctx: null,
    on: true,

    init() {
      try { this.on = localStorage.getItem('dubsdread.sound') !== 'off'; } catch (e) { /* private mode */ }
      const unlock = () => {
        if (!this.ctx) this.start();
        else if (this.ctx.state === 'suspended') this.ctx.resume();
      };
      addEventListener('pointerdown', unlock, true);
      addEventListener('keydown', unlock, true);
      document.addEventListener('visibilitychange', () => {
        if (!this.ctx) return;
        if (document.hidden) this.ctx.suspend(); else if (this.on) this.ctx.resume();
      });
      this.button();
    },

    start() {
      const AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return;
      const c = this.ctx = new AC();
      this.master = c.createGain();
      this.master.gain.value = this.on ? 0.9 : 0;
      // a gentle limiter, so a driver and an applause on top of it never clip
      const comp = c.createDynamicsCompressor();
      comp.threshold.value = -10; comp.ratio.value = 6;
      this.master.connect(comp).connect(c.destination);
      const n = c.sampleRate * 2;
      this.noise = c.createBuffer(1, n, c.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = R() * 2 - 1;
      this.ambience();
    },

    setOn(v) {
      this.on = v;
      try { localStorage.setItem('dubsdread.sound', v ? 'on' : 'off'); } catch (e) { /* ignore */ }
      if (this.master) this.master.gain.setTargetAtTime(v ? 0.9 : 0, this.ctx.currentTime, 0.05);
      if (v && this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
      this.sync();
    },

    button() {
      const b = document.createElement('button');
      b.id = 'sndBtn';
      b.setAttribute('aria-label', 'Sound');
      b.onclick = e => { e.stopPropagation(); this.setOn(!this.on); };
      document.body.appendChild(b);
      this.btn = b;
      this.sync();
    },
    sync() { if (this.btn) { this.btn.textContent = this.on ? '\u{1F50A}' : '\u{1F507}'; this.btn.classList.toggle('off', !this.on); } },

    /* ---------------------------------------------------------- building blocks */

    t() { return this.ctx.currentTime; },

    /** Filtered noise with an attack/decay envelope. */
    burst(o) {
      const c = this.ctx; if (!c) return;
      const t0 = this.t() + (o.at || 0);
      const src = c.createBufferSource();
      src.buffer = this.noise;
      const f = c.createBiquadFilter();
      f.type = o.type || 'bandpass';
      f.frequency.setValueAtTime(o.f || 1000, t0);
      if (o.f2) f.frequency.exponentialRampToValueAtTime(o.f2, t0 + (o.sweep || o.d || 0.2));
      f.Q.value = o.q || 0.8;
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.g || 0.3), t0 + (o.a || 0.002));
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + (o.a || 0.002) + (o.d || 0.1));
      let out = g;
      if (o.pan !== undefined && c.createStereoPanner) {
        const p = c.createStereoPanner(); p.pan.value = o.pan; g.connect(p); out = p;
      }
      src.connect(f).connect(g);
      out.connect(o.dest || this.master);
      src.start(t0, R() * 1.5);
      src.stop(t0 + (o.a || 0.002) + (o.d || 0.1) + 0.05);
    },

    /** A decaying tone, optionally gliding. */
    tone(o) {
      const c = this.ctx; if (!c) return;
      const t0 = this.t() + (o.at || 0);
      const osc = c.createOscillator();
      osc.type = o.type || 'sine';
      osc.frequency.setValueAtTime(o.f, t0);
      if (o.f2) osc.frequency.exponentialRampToValueAtTime(o.f2, t0 + (o.glide || o.d || 0.1));
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.g || 0.2), t0 + (o.a || 0.002));
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + (o.a || 0.002) + (o.d || 0.1));
      let out = g;
      if (o.pan !== undefined && c.createStereoPanner) {
        const p = c.createStereoPanner(); p.pan.value = o.pan; g.connect(p); out = p;
      }
      osc.connect(g); out.connect(o.dest || this.master);
      osc.start(t0); osc.stop(t0 + (o.a || 0.002) + (o.d || 0.1) + 0.05);
    },

    /* ---------------------------------------------------------------- golf */

    swing(club, quality, power) {
      if (!this.ctx) return;
      const q = clamp(quality === undefined ? 1 : quality, 0, 1);
      const p = clamp(power || 1, 0.2, 1.15);
      // the swish of the club coming through, peaking at impact
      this.burst({ type: 'bandpass', f: 500, f2: 2600, sweep: 0.11, q: 1.2, g: 0.10 * p, a: 0.09, d: 0.07 });
      const at = 0.10;
      const wood = club === 'D' || /^\dw$/i.test(club);
      const wedge = /^(PW|GW|SW|LW)$/.test(club);
      if (wood) {
        // a titanium head: a bright ring over a sharp crack
        this.burst({ at, type: 'bandpass', f: 4800, q: 0.7, g: 0.55 * p, d: 0.045 });
        this.tone({ at, f: 2850 + R() * 160, g: 0.20 * q * p, d: 0.16 });
        this.tone({ at, f: 4150 + R() * 200, g: 0.09 * q * p, d: 0.09 });
        this.tone({ at, f: 145, g: 0.30 * p, d: 0.07 });
      } else {
        // forged iron: a dense click, a thump, and turf taken after the ball
        this.burst({ at, type: 'highpass', f: 2400, q: 0.6, g: 0.60 * p, d: 0.032 });
        this.tone({ at, f: 1750 + R() * 120, g: 0.12 * q, d: 0.03 });
        this.tone({ at, f: 115, g: 0.36 * p, d: 0.05 });
        this.burst({ at: at + 0.012, type: 'bandpass', f: 1100, q: 0.9, g: (wedge ? 0.16 : 0.12) * p, d: 0.16 });
      }
      if (q < 0.6) {
        // off the toe or thin: duller, with a buzz in the hands
        this.burst({ at, type: 'lowpass', f: 700, q: 0.5, g: 0.25, d: 0.08 });
        this.tone({ at, f: 230, type: 'triangle', g: 0.08, d: 0.15 });
      }
    },

    putt(power) {
      if (!this.ctx) return;
      const p = clamp(power || 1, 0.2, 1.2);
      this.tone({ f: 1050 + R() * 60, g: 0.16 * p, d: 0.035 });
      this.tone({ f: 2150, g: 0.05 * p, d: 0.018 });
      this.burst({ type: 'highpass', f: 3200, g: 0.10 * p, d: 0.012 });
    },

    land(surface, speed) {
      if (!this.ctx) return;
      const v = clamp(speed || 1, 0.2, 1.4);
      const pan = (R() - 0.5) * 0.3;
      if (surface === 'water') {
        this.burst({ type: 'bandpass', f: 700, f2: 2600, sweep: 0.25, q: 0.8, g: 0.45, a: 0.004, d: 0.55, pan });
        for (let i = 0; i < 5; i++) this.tone({ at: 0.05 + i * 0.05 + R() * 0.04, f: 500 + R() * 600, f2: 900 + R() * 900, g: 0.04, d: 0.05, pan });
      } else if (surface === 'sand') {
        this.burst({ type: 'bandpass', f: 1800, q: 0.9, g: 0.30 * v, a: 0.004, d: 0.22, pan });
        this.tone({ f: 90, g: 0.10 * v, d: 0.06, pan });
      } else if (surface === 'path') {
        this.tone({ f: 950, g: 0.18 * v, d: 0.045, pan });
        this.burst({ type: 'highpass', f: 2200, g: 0.25 * v, d: 0.03, pan });
      } else if (surface === 'green' || surface === 'fringe') {
        this.burst({ type: 'lowpass', f: 380, g: 0.28 * v, d: 0.09, pan });
        this.tone({ f: 95, g: 0.18 * v, d: 0.07, pan });
      } else {
        this.burst({ type: 'lowpass', f: 450, g: 0.34 * v, d: 0.12, pan });
        this.tone({ f: 80, g: 0.20 * v, d: 0.09, pan });
        this.burst({ type: 'bandpass', f: 1400, q: 0.8, g: 0.06 * v, d: 0.12, pan });
      }
    },

    tree() {
      if (!this.ctx) return;
      this.tone({ f: 620 + R() * 120, g: 0.18, d: 0.08 });
      this.burst({ type: 'bandpass', f: 3000, q: 0.5, g: 0.18, a: 0.01, d: 0.35 });   // leaves
    },

    cup() {
      if (!this.ctx) return;
      [0, 0.06, 0.10, 0.13].forEach((at, i) => {
        this.tone({ at, f: 2500 - i * 260 + R() * 80, g: 0.10 - i * 0.015, d: 0.022 });
        this.burst({ at, type: 'highpass', f: 2800, g: 0.07, d: 0.012 });
      });
      this.tone({ at: 0.18, f: 320, g: 0.18, d: 0.09 });
    },

    /** Applause, scaled to the moment: polite for a par, a roar for an eagle. */
    applause(level) {
      if (!this.ctx || level <= 0) return;
      const dur = 1.6 + level * 1.4, n = Math.round(90 + level * 260);
      for (let i = 0; i < n; i++) {
        const u = R();
        const at = 0.25 + u * dur;
        // claps thicken quickly and tail off
        const env = Math.min(1, u * 6) * (1 - u * 0.75);
        this.burst({ at, type: 'bandpass', f: 1300 + R() * 1500, q: 1.4, g: (0.03 + R() * 0.06) * env * (0.6 + level * 0.4),
                     d: 0.018 + R() * 0.02, pan: (R() - 0.5) * 1.6 });
      }
      if (level >= 2) {
        // a cheer under it
        this.burst({ at: 0.2, type: 'bandpass', f: 600, f2: 900, sweep: 1.2, q: 0.7, g: 0.07 * level, a: 0.3, d: 1.6 });
      }
    },

    /** Wind in the trees and birds in them — quiet, always there. */
    ambience() {
      const c = this.ctx;
      const src = c.createBufferSource();
      src.buffer = this.noise; src.loop = true;
      const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 420;
      const g = c.createGain(); g.gain.value = 0.022;
      const lfo = c.createOscillator(); lfo.frequency.value = 0.07;
      const lg = c.createGain(); lg.gain.value = 0.012;
      lfo.connect(lg).connect(g.gain);
      src.connect(f).connect(g).connect(this.master);
      src.start(); lfo.start();
      this.windGain = g;
      const bird = () => {
        if (this.ctx && this.on && !document.hidden) {
          const base = 2600 + R() * 2600, pan = (R() - 0.5) * 1.6, notes = 2 + ((R() * 5) | 0);
          for (let i = 0; i < notes; i++) {
            const at = i * (0.09 + R() * 0.07);
            this.tone({ at, f: base * (0.85 + R() * 0.3), f2: base * (1.1 + R() * 0.4), glide: 0.07,
                        g: 0.018 + R() * 0.02, a: 0.01, d: 0.07 + R() * 0.05, pan });
          }
        }
        setTimeout(bird, 2500 + R() * 7000);
      };
      setTimeout(bird, 1500);
    }
  };

  /* ---------------------------------------------------------------- hooks */

  const strike = Play.strike.bind(Play);
  Play.strike = function (sw) {
    const putting = this.isPutting();
    const r = strike(sw);
    if (!putting && r) Snd.swing(this.club, sw && sw.strike, sw && sw.power);
    return r;
  };
  const putt = Play.putt.bind(Play);
  Play.putt = function (sw) {
    const r = putt(sw);
    Snd.putt(sw && sw.power);
    return r;
  };
  const finish = Play.finish.bind(Play);
  Play.finish = function () {
    finish();
    Snd.cup();
    const d = this.state.toPar;
    setTimeout(() => Snd.applause(d <= -2 ? 3 : d === -1 ? 2 : d === 0 ? 1 : 0.4), 350);
  };

  /* The landing, by watching the ball: the first frame it is back on the
     ground after having been properly in the air. */
  const adv = App.advanceShot.bind(App);
  App.advanceShot = function (dt) {
    const S = this.shot;
    if (S && S !== Snd._shot) { Snd._shot = S; Snd._air = 0; Snd._landed = false; }
    adv(dt);
    const b = this.ballPos;
    if (!S || !b || S.putt || Snd._landed || !this.field) return;
    const gy = this.field.height(b[0], b[2]);
    const air = b[1] - gy;
    Snd._air = Math.max(Snd._air, air);
    if (Snd._air > 1.0 && air < 0.15) {
      Snd._landed = true;
      if (S.hitTree) Snd.tree();
      Snd.land(this.field.surfaceAt(b[0], b[2]), clamp((S.stats && S.stats.apexM || 20) / 25, 0.3, 1.3));
    }
  };

  root.Sound = Snd;
  Snd.init();
})(window);
