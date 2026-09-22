/* =============================================================================
   CRUX — checkout page: shipping, promo codes, validation, order placement
   ========================================================================== */

function getShippingMethod() {
  const checked = document.querySelector('input[name="shipping"]:checked');
  return checked ? checked.value : 'standard';
}

function getAppliedPromo() {
  const code = sessionStorage.getItem('crux_promo');
  return code && SHOP.promoCodes[code] ? code : null;
}

function computeTotals(cart) {
  const subtotal = cart.reduce((s, c) => s + c.qty * c.price, 0);
  const promoCode = getAppliedPromo();
  const promo = promoCode ? SHOP.promoCodes[promoCode] : null;
  const discount = promo ? subtotal * (promo.percentOff / 100) : 0;
  const method = getShippingMethod();
  const shipDef = SHOP.shipping[method] || SHOP.shipping.standard;
  const freeStandard = method === 'standard' && subtotal >= SHOP.freeShippingThreshold;
  const shippingCost = cart.length === 0 ? 0 : freeStandard ? 0 : shipDef.price;
  const total = Math.max(0, subtotal - discount + shippingCost);
  return { subtotal, promoCode, promo, discount, method, shipDef, freeStandard, shippingCost, total };
}

function onCheckoutSummaryRender(cart) {
  const list = document.getElementById('checkoutItems');
  const placeBtn = document.getElementById('placeOrderBtn');
  const emptyNote = document.getElementById('checkoutEmptyNote');
  if (!list) return;

  if (cart.length === 0) {
    list.innerHTML = '';
    if (emptyNote) emptyNote.style.display = 'block';
    if (placeBtn) placeBtn.disabled = true;
  } else {
    list.innerHTML = cart.map((item) => `
      <div class="summary-line" style="align-items:flex-start;">
        <span>${escapeHtml(item.name)}${item.variant ? ` <span class="muted">· ${escapeHtml(item.variant)}</span>` : ''} <span class="muted">×${item.qty}</span></span>
        <b class="num">${fmtMoney(item.price * item.qty)}</b>
      </div>`).join('');
    if (emptyNote) emptyNote.style.display = 'none';
    if (placeBtn) placeBtn.disabled = false;
  }

  const t = computeTotals(cart);
  setText('sumSubtotal', fmtMoney(t.subtotal));
  setText('sumShipping', cart.length === 0 ? '—' : t.shippingCost === 0 ? 'Free' : fmtMoney(t.shippingCost));
  setText('sumTotal', fmtMoney(t.total));

  const discountRow = document.getElementById('sumDiscountRow');
  if (discountRow) {
    if (t.discount > 0) {
      discountRow.style.display = 'flex';
      setText('sumDiscount', '−' + fmtMoney(t.discount));
      setText('sumPromoLabel', t.promo.label);
    } else {
      discountRow.style.display = 'none';
    }
  }
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function setFieldError(field, msg) {
  const wrap = field.closest('.field');
  if (!wrap) return;
  wrap.classList.add('error');
  const em = wrap.querySelector('.err-msg');
  if (em) em.textContent = msg;
}
function clearFieldError(field) {
  const wrap = field.closest('.field');
  if (!wrap) return;
  wrap.classList.remove('error');
}

function validateCheckoutForm(form) {
  let firstInvalid = null;
  const required = form.querySelectorAll('[required]');
  required.forEach((field) => {
    clearFieldError(field);
    const val = field.value.trim();
    let ok = val.length > 0;
    if (ok && field.type === 'email') {
      ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val);
    }
    if (!ok) {
      setFieldError(field, field.type === 'email' ? 'Enter a valid email address.' : 'This field is required.');
      if (!firstInvalid) firstInvalid = field;
    }
  });
  if (firstInvalid) {
    firstInvalid.focus();
    firstInvalid.closest('.field').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return false;
  }
  return true;
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('input[name="shipping"]').forEach((r) => {
    r.addEventListener('change', () => onCheckoutSummaryRender(readCart()));
  });

  const promoApply = document.getElementById('promoApply');
  if (promoApply) {
    promoApply.addEventListener('click', () => {
      const input = document.getElementById('promoInput');
      const msg = document.getElementById('promoMsg');
      const code = (input.value || '').trim().toUpperCase();
      if (!code) return;
      if (SHOP.promoCodes[code]) {
        sessionStorage.setItem('crux_promo', code);
        if (msg) { msg.textContent = `Applied: ${SHOP.promoCodes[code].label}`; msg.style.color = 'var(--success)'; }
      } else {
        sessionStorage.removeItem('crux_promo');
        if (msg) { msg.textContent = 'That code isn’t valid.'; msg.style.color = 'var(--error)'; }
      }
      onCheckoutSummaryRender(readCart());
    });
  }

  const form = document.getElementById('checkoutForm');
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const cart = readCart();
      if (cart.length === 0) return;
      if (!validateCheckoutForm(form)) return;

      const data = new FormData(form);
      const customer = Object.fromEntries(data.entries());
      const t = computeTotals(cart);
      const order = {
        id: generateOrderId(),
        date: new Date().toISOString(),
        items: cart,
        customer,
        shippingMethod: t.method,
        subtotal: t.subtotal,
        discount: t.discount,
        promoCode: t.promoCode,
        shippingCost: t.shippingCost,
        total: t.total,
      };
      saveOrder(order);
      cartClear();
      sessionStorage.removeItem('crux_promo');
      window.location.href = `order-confirmation.html?order=${encodeURIComponent(order.id)}`;
    });
  }
});
