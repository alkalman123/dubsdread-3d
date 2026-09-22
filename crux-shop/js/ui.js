/* =============================================================================
   RACKHOUSE — site chrome: header, mobile nav, cart drawer, reveals, misc
   ========================================================================== */

function openCartDrawer() {
  const root = document.getElementById('cartDrawerRoot');
  if (!root) return;
  root.classList.add('open');
  document.body.classList.add('no-scroll');
  root.setAttribute('aria-hidden', 'false');
}
function closeCartDrawer() {
  const root = document.getElementById('cartDrawerRoot');
  if (!root) return;
  root.classList.remove('open');
  document.body.classList.remove('no-scroll');
  root.setAttribute('aria-hidden', 'true');
}

function openMobileNav() {
  const nav = document.getElementById('mobileNav');
  if (!nav) return;
  nav.classList.add('open');
  document.body.classList.add('no-scroll');
}
function closeMobileNav() {
  const nav = document.getElementById('mobileNav');
  if (!nav) return;
  nav.classList.remove('open');
  document.body.classList.remove('no-scroll');
}

function initQtyStepper(root, { min = 1, max = 10, onChange } = {}) {
  if (!root) return { get: () => min, set: () => {} };
  const input = root.querySelector('input');
  const dec = root.querySelector('[data-step="dec"]');
  const inc = root.querySelector('[data-step="inc"]');
  function clamp(v) { return Math.max(min, Math.min(max, v)); }
  function set(v) {
    v = clamp(parseInt(v, 10) || min);
    input.value = v;
    if (dec) dec.disabled = v <= min;
    if (inc) inc.disabled = v >= max;
    if (onChange) onChange(v);
  }
  if (dec) dec.addEventListener('click', () => set((parseInt(input.value, 10) || min) - 1));
  if (inc) inc.addEventListener('click', () => set((parseInt(input.value, 10) || min) + 1));
  input.addEventListener('change', () => set(input.value));
  set(input.value || min);
  return { get: () => parseInt(input.value, 10) || min, set };
}

function wireMailtoForm(form, { toEmail, subject }) {
  if (!form) return;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const lines = [];
    for (const [k, v] of data.entries()) {
      if (String(v).trim()) lines.push(`${k}: ${v}`);
    }
    const body = encodeURIComponent(lines.join('\n'));
    const subj = encodeURIComponent(subject || `Message from ${SHOP.name} site`);
    window.location.href = `mailto:${toEmail}?subject=${subj}&body=${body}`;
    const note = form.querySelector('[data-form-note]');
    if (note) {
      note.textContent = 'Opening your email app with this pre-filled… if nothing opens, email us directly instead.';
      note.style.display = 'block';
    }
  });
}

function initRevealObserver() {
  const els = document.querySelectorAll('.reveal');
  if (!els.length) return;

  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion || !('IntersectionObserver' in window)) {
    els.forEach((el) => el.classList.add('in'));
    return;
  }

  // Elements are only ever hidden once JS both arms them and is ready to
  // reveal them — never rely on scroll actually happening. Whatever the
  // IntersectionObserver misses (a tool that renders the page without a
  // real scroll, a jump-to-bottom, etc.), this timeout still reveals.
  els.forEach((el) => el.classList.add('reveal-armed'));
  const revealAll = () => els.forEach((el) => el.classList.add('in'));
  const safetyTimer = setTimeout(revealAll, 1000);

  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          io.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
  );
  els.forEach((el) => io.observe(el));

  window.addEventListener('pagehide', () => clearTimeout(safetyTimer), { once: true });
}

document.addEventListener('DOMContentLoaded', () => {
  const header = document.querySelector('.site-header');
  if (header) {
    const onScroll = () => header.classList.toggle('scrolled', window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  const menuToggle = document.getElementById('menuToggle');
  if (menuToggle) menuToggle.addEventListener('click', openMobileNav);
  const mobileNavClose = document.getElementById('mobileNavClose');
  if (mobileNavClose) mobileNavClose.addEventListener('click', closeMobileNav);
  const mobileNavBackdrop = document.querySelector('#mobileNav .backdrop');
  if (mobileNavBackdrop) mobileNavBackdrop.addEventListener('click', closeMobileNav);

  const cartToggleBtns = document.querySelectorAll('[data-cart-open]');
  cartToggleBtns.forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); openCartDrawer(); }));
  const cartCloseBtn = document.getElementById('cartDrawerClose');
  if (cartCloseBtn) cartCloseBtn.addEventListener('click', closeCartDrawer);
  const cartBackdrop = document.querySelector('#cartDrawerRoot .backdrop');
  if (cartBackdrop) cartBackdrop.addEventListener('click', closeCartDrawer);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeCartDrawer();
      closeMobileNav();
    }
  });

  document.querySelectorAll('[data-year]').forEach((el) => { el.textContent = new Date().getFullYear(); });

  document.querySelectorAll('[data-mailto-form]').forEach((form) => {
    wireMailtoForm(form, { toEmail: SHOP.email, subject: form.getAttribute('data-mailto-subject') || undefined });
  });

  initRevealObserver();
});
