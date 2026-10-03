/* Rounds that survive closing the app.
 *
 * A phone browser throws pages away the moment you switch to another app, so a
 * round has to live somewhere other than memory. After every hole the card,
 * the hole you are on, the course and the tees are written to this device's
 * storage; the home page offers to pick the round up where it stopped, and a
 * finished round goes into a history the home page shows.
 *
 * Storage keys (all on this device only):
 *   dubsdread.round     the round in progress
 *   dubsdread.history   finished rounds, newest first, at most 60
 *   dubsdread.profile   the player standard to play as
 *   dubsdread.quality   'auto' or a graphics tier
 */
(function (root) {
  'use strict';

  const App = root.App, Play = root.Play;
  const get = k => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
  const put = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* full or private */ } };

  // read before the engine boots: starting the engine starts a fresh round
  const SAVED = get('dubsdread.round');

  const Save = {
    get, put,
    booted: false,

    snapshot() {
      if (!this.booted || !Play.round || !root.COURSE_ID) return;
      const card = Play.round.card.map(e => e ? { score: e.score, par: e.par, penalties: e.penalties || 0 } : null);
      const thru = card.filter(Boolean).length;
      if (!thru && App.hole === 1) { this.clear(); return; }
      const next = Play.state && Play.state.holed && Play.nextHoleNumber ? Play.nextHoleNumber() : App.hole;
      put('dubsdread.round', {
        course: root.COURSE_ID, tee: App.teeSet || 0, profile: App.profile || 'tour',
        card, hole: next || App.hole, started: Play.round.started, updated: Date.now(),
        label: Play.totalLabel()
      });
      if (thru === 18) this.finishRound(card);
    },

    clear() { try { localStorage.removeItem('dubsdread.round'); } catch (e) { /* ignore */ } },

    finishRound(card) {
      const h = get('dubsdread.history') || [];
      if (h.some(r => r.started === Play.round.started && r.course === root.COURSE_ID)) return;
      const T = Play.roundTotals();
      const info = root.COURSE_INFO || {};
      h.unshift({ course: root.COURSE_ID, name: info.name || (App.course.meta || {}).course,
                  started: Play.round.started, finished: Date.now(), gross: T.gross, par: T.par,
                  toPar: T.toPar, tee: App.teeSet || 0, profile: App.profile || 'tour',
                  scores: card.map(e => e && e.score) });
      put('dubsdread.history', h.slice(0, 60));
      this.clear();
    },

    /** After Play.init: load the saved card if this page was opened to resume. */
    afterInit() {
      this.booted = true;
      const q = new URLSearchParams(location.search);
      if (q.get('resume') !== '1') return;
      const s = SAVED;
      if (!s || s.course !== root.COURSE_ID || !Play.round) return;
      Play.round.card = s.card.map((e, i) => e ? Object.assign({ shots: [] }, e, { par: App.course.holes[i].par }) : null);
      if (s.started) Play.round.started = s.started;
    },

    /** Settings chosen on the home page. */
    settings() {
      return { profile: get('dubsdread.profile') || 'tour', quality: get('dubsdread.quality') || 'auto' };
    }
  };

  /* Save after each hole is scored and whenever a new hole starts. */
  const finish = Play.finish.bind(Play);
  Play.finish = function () { finish(); Save.snapshot(); };
  const newHole = Play.newHole.bind(Play);
  Play.newHole = function (n, quiet) { newHole(n, quiet); if (this.round) Save.snapshot(); };
  const newRound = Play.newRound.bind(Play);
  Play.newRound = function () { newRound(); if (Save.booted) Save.clear(); };

  root.Save = Save;
})(window);
