/* The round on a phone.
 *
 * The desktop HUD is two columns of panels either side of the picture, and on
 * a phone those columns are the whole screen: nothing of the course shows. So
 * on a small screen the panels go away and two strips replace them — a status
 * rail across the top and a thumb bar along the bottom — and everything the
 * panels held is still there, a tap away, in a sheet.
 *
 * Nothing here plays golf. It reads the same Play state the panels do and
 * calls the same UI.act() the swing button does, so the two layouts cannot
 * drift apart.
 */
(function (root) {
  'use strict';

  const App = root.App, Play = root.Play;
  const UI = root.UI;
  const { clamp } = root.MM;
  const $ = id => document.getElementById(id);
  const M2Y = 1.09361;
  const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  const VIEWS = [['play', 'Behind'], ['green', 'Green'], ['aerial', 'Aerial'], ['flyover', 'Flyover']];

  const Phone = {
    on: false,

    isPhone() {
      return matchMedia('(max-width: 760px)').matches ||
             (matchMedia('(pointer: coarse)').matches && matchMedia('(max-height: 520px)').matches);
    },

    build() {
      const rail = document.createElement('div');
      rail.id = 'mRail';
      rail.innerHTML =
        '<div class="mc" id="mHoleC"><span class="k">Hole</span><span class="v"><b id="mHole">1</b> <small id="mPar">par 4</small></span></div>' +
        '<div class="mc"><span class="k">To pin</span><span class="v" id="mPin">—</span></div>' +
        '<div class="mc"><span class="k">Lie</span><span class="v" id="mLie">—</span></div>' +
        '<div class="mc"><span class="k">Stroke</span><span class="v" id="mStroke">1</span></div>' +
        '<div class="mc" id="mTotC"><span class="k">Round</span><span class="v" id="mTot">—</span></div>';
      document.body.appendChild(rail);

      const bar = document.createElement('div');
      bar.id = 'mBar';
      bar.innerHTML =
        '<div id="mClubs"></div>' +
        '<div id="mCad"></div>' +
        '<div id="mActs">' +
          '<button class="mAim" id="mAimL" aria-label="Aim left">&#9664;</button>' +
          '<button id="mGo">Swing</button>' +
          '<button class="mAim" id="mAimR" aria-label="Aim right">&#9654;</button>' +
        '</div>' +
        '<div id="mMore">' +
          '<button data-m="view">Behind</button>' +
          '<button data-m="map">Map</button>' +
          '<button data-m="zones">Zones</button>' +
          '<button data-m="card">Card</button>' +
          '<button data-m="menu">More</button>' +
        '</div>';
      document.body.appendChild(bar);

      const done = document.createElement('button');
      done.id = 'mSheetDone';
      done.textContent = 'Done';
      document.body.appendChild(done);

      // the hole strip lives in the sheet on a phone
      this.stripHome = $('strip').parentNode;
      this.stripSlot = document.createElement('div');
      this.stripSlot.id = 'mStripSlot';
      $('right').insertBefore(this.stripSlot, $('right').firstChild);

      this.buildClubs();
      this.bind();
    },

    buildClubs() {
      const wrap = $('mClubs');
      wrap.innerHTML = '';
      for (const c of root.Shot.CLUBS) {
        const b = document.createElement('button');
        b.className = 'mClub';
        b.dataset.club = c.id;
        b.textContent = c.name;
        b.onclick = () => {
          if (Play.state.phase !== 'idle') return;
          Play.club = c.id;
          $('club').value = c.id;
          Play.clearPatterns && Play.clearPatterns();
          Play.notify();
        };
        wrap.appendChild(b);
      }
      /* The bag has no putter — play.js changes to putting by itself on the
         green — so the putter is its own chip, and on the green it is the only
         one. */
      const p = document.createElement('button');
      p.className = 'mClub on';
      p.id = 'mPutter';
      p.textContent = 'Putter';
      wrap.appendChild(p);
    },

    bind() {
      // pointerdown, not click: click lands when the finger lifts, which on a
      // timing meter is late by however long the tap was
      $('mGo').addEventListener('pointerdown', e => { e.preventDefault(); UI.act(); });

      const hold = (id, dir) => {
        const el = $(id);
        let t = null;
        const nudge = big => {
          if (Play.state.phase !== 'idle' || Play.state.holed) return;
          const deg = Play.isPutting() ? 0.30 : 0.9;
          Play.nudgeAim(dir * deg * (big ? 2.5 : 1));
        };
        const stop = () => { clearInterval(t); t = null; };
        el.addEventListener('pointerdown', e => {
          e.preventDefault();
          stop();
          nudge(false);
          let n = 0;
          t = setInterval(() => nudge(++n > 8), 90);
        });
        ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => el.addEventListener(ev, stop));
      };
      hold('mAimL', -1);
      hold('mAimR', 1);

      document.querySelectorAll('#mMore button').forEach(b => {
        b.onclick = () => this.more(b.dataset.m, b);
      });
      $('mSheetDone').onclick = () => document.body.classList.remove('msheet');
    },

    more(what, btn) {
      const B = document.body.classList;
      if (what === 'view') {
        const base = Play.isPutting() ? 'putt' : 'play';
        const list = VIEWS.map(v => v[0] === 'play' ? base : v[0]);
        let i = list.indexOf(App.camMode);
        i = (i + 1) % list.length;
        App.setCamera(list[i], false);
      } else if (what === 'map') {
        B.toggle('mmap');
        btn.classList.toggle('on', B.contains('mmap'));
        UI.draw && UI.draw();
      } else if (what === 'zones') {
        $('zoneBtn').click();
      } else if (what === 'card') {
        UI.showScorecard();
      } else if (what === 'menu') {
        B.toggle('msheet');
      }
      this.sync();
    },

    /** Switch layouts when the screen changes size or turns. */
    apply() {
      const want = this.isPhone();
      if (want === this.on) return;
      this.on = want;
      document.body.classList.toggle('phone', want);
      if (!want) document.body.classList.remove('msheet', 'mmap');
      const strip = $('strip');
      if (want) this.stripSlot.appendChild(strip);
      else this.stripHome.appendChild(strip);
      UI.touch = want || matchMedia('(pointer: coarse)').matches;
      App.resize && App.resize();
      UI.draw && UI.draw();
      this.sync();
      UI.measureInsets();
    },

    measure() {
      const H = innerHeight;
      const r = $('mRail').getBoundingClientRect();
      const b = $('mBar').getBoundingClientRect();
      document.documentElement.style.setProperty('--mbar', Math.round(H - b.top) + 'px');
      document.documentElement.style.setProperty('--mrail', Math.round(r.bottom) + 'px');
      // keep room for the meter, which pops up above the bar mid-swing
      const meter = $('meter').classList.contains('on') ? 0 : 70;
      App.viewInset = { top: r.bottom, bottom: clamp(H - b.top + meter, 0, H * 0.6) };
    },

    sync() {
      if (!this.on) return;
      const st = Play.state, H = App.holeData;
      const putting = Play.isPutting() && !st.holed;

      $('mHole').textContent = H.num;
      $('mPar').textContent = 'par ' + H.par;
      const yd = Play.toPin() * M2Y;
      $('mPin').textContent = st.holed ? '—' : yd < 30 ? Math.round(yd * 3) + ' ft' : Math.round(yd) + ' yd';
      $('mLie').textContent = st.holed ? 'holed' : Play.lieInfo().name;
      $('mStroke').textContent = st.holed ? st.score : st.stroke + st.penalties + 1;
      $('mTot').textContent = Play.holesPlayed() ? Play.totalLabel() : '—';

      // clubs: the bag, or just the putter
      $('mClubs').classList.toggle('putting', putting);
      $('mPutter').style.display = putting ? '' : 'none';
      document.querySelectorAll('#mClubs .mClub[data-club]').forEach(b => {
        b.style.display = putting ? 'none' : '';
        const on = b.dataset.club === Play.club;
        b.classList.toggle('on', on);
        if (on && !putting && this._clubWas !== Play.club) {
          b.scrollIntoView({ block: 'nearest', inline: 'center' });
        }
      });
      this._clubWas = putting ? null : Play.club;

      // what the caddie says, in one line
      let cad = '';
      if (st.holed) {
        cad = Play.scoreName() + ' · ' + st.score;
      } else if (putting) {
        const r = Play.read();
        const d = Play.toPin();
        const cups = Math.abs(r.offsetDeg) * Math.PI / 180 * d / 0.108;
        cad = (d * 3.28084).toFixed(1) + ' ft · ' +
              (cups < 0.4 ? 'straight in' : 'aim ' + cups.toFixed(1) + ' cups ' + (r.offsetDeg > 0 ? 'right' : 'left')) +
              ' · stop on the green mark';
      } else {
        try {
          const c = Play.caddie();
          const pct = Math.round(c.power * 100);
          cad = '<b>' + esc(c.rec.name) + '</b>' + (pct < 97 ? ' ' + pct + '%' : '') +
                ' · ' + Math.round(c.pinYd) + ' yds' +
                (Math.abs(c.playsLikeYd - c.pinYd) >= 2 ? ' · plays ' + Math.round(c.playsLikeYd) : '') +
                ' · ' + esc(c.windText || 'calm');
        } catch (e) { cad = ''; }
      }
      $('mCad').innerHTML = cad;

      const ph = st.phase;
      $('mGo').textContent = st.holed ? (Play.nextHoleNumber() ? 'Next hole' : 'Card')
        : ph === 'power' ? (putting ? 'Putt' : 'Set power')
        : ph === 'strike' ? 'Set the face'
        : ph === 'flying' ? (Play.pending && Play.pending.kind === 'putt' ? 'Rolling…' : 'In the air…')
        : putting ? 'Putt' : 'Swing';
      $('mGo').classList.toggle('wait', ph === 'flying');

      const vb = document.querySelector('#mMore [data-m="view"]');
      const cur = VIEWS.find(v => v[0] === App.camMode);
      vb.textContent = App.camMode === 'putt' || App.camMode === 'play' ? 'Behind'
        : cur ? cur[1] : App.camMode === 'follow' ? 'Follow' : 'Free';
      document.querySelector('#mMore [data-m="zones"]').classList.toggle('on', !!UI.zones);
    }
  };

  /* ---------------------------------------------------------------- hooks */

  function start() {
    Phone.build();
    const onPlay = UI.onPlayChanged.bind(UI);
    UI.onPlayChanged = function () { onPlay(); Phone.sync(); };
    const onCam = UI.onCameraChanged.bind(UI);
    UI.onCameraChanged = function () { onCam(); Phone.sync(); };
    const meas = UI.measureInsets.bind(UI);
    UI.measureInsets = function () { if (Phone.on) Phone.measure(); else meas(); };
    // the meter changes phase without a notify, so keep the button honest
    const meter = UI.drawMeter.bind(UI);
    UI.drawMeter = function () {
      meter();
      const k = Play.state.phase;
      if (k !== Phone._ph) { Phone._ph = k; Phone.sync(); }
    };
    Phone.apply();
    addEventListener('resize', () => Phone.apply());
    addEventListener('orientationchange', () => setTimeout(() => { Phone.apply(); App.resize && App.resize(); }, 300));
    root.Phone = Phone;
  }

  // UI.boot is async; wait until the round exists before laying anything out
  const wait = () => {
    if (root.__ready && Play.state) start();
    else setTimeout(wait, 120);
  };
  wait();
})(window);
