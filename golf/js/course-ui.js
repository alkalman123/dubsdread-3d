/* Put the chosen course's name everywhere the page shows one: the tab, the
   loading screen, the brand panel, the scorecard. Runs as soon as the course
   data is in, before the engine boots. */
(function () {
  'use strict';
  var C = window.COURSE;
  if (!C) return;
  var M = C.meta || {}, I = window.COURSE_INFO || {};
  var name = I.name || M.course || 'Golf';
  var sub = I.sub || M.club || '';
  var esc = function (s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); };
  document.title = name + (sub ? ' — ' + sub : '');
  var set = function (sel, html) { var el = document.querySelector(sel); if (el) el.innerHTML = html; };
  set('#lTitle', esc(sub) + ' · <em>' + esc(name) + '</em>');
  set('#brand .t', esc(sub) + ' · <em>' + esc(name) + '</em>');
  set('#cardBox .sub', esc(sub) + ' · ' + esc(name));
  var crest = document.getElementById('crest');
  if (crest) {
    var w = (I.club || M.club || name).replace(/[^A-Za-z ]/g, '').split(/\s+/).filter(function (x) {
      return x && !/^(the|golf|club|country|links|course|resort|and|of|at|state|park)$/i.test(x);
    });
    crest.textContent = ((w[0] || 'G')[0] + ((w[1] || '')[0] || '')).toUpperCase();
  }
})();
