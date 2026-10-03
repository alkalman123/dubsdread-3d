/* Pick the course and load its data before anything else runs.
 *
 * ?course=<id> chooses; otherwise the last course played; otherwise the first
 * in courses/index.js. The data file is written in with document.write so it
 * is in place, synchronously, before the engine's own scripts run — the same
 * guarantee the single hard-coded <script src="course-data.js"> used to give.
 */
(function () {
  'use strict';
  var list = window.COURSES || [];
  var q = new URLSearchParams(location.search);
  var id = q.get('course');
  try { if (!id) id = localStorage.getItem('dubsdread.course'); } catch (e) { /* private mode */ }
  var c = null;
  for (var i = 0; i < list.length; i++) if (list[i].id === id) c = list[i];
  c = c || list[0];
  if (!c) return;
  window.COURSE_ID = c.id;
  window.COURSE_INFO = c;
  try { localStorage.setItem('dubsdread.course', c.id); } catch (e) { /* ignore */ }
  document.write('<script src="' + c.file + '"><\/script>');
})();
