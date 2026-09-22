/* =============================================================================
   CRUX — cart engine (localStorage-backed, shared across every page)
   ========================================================================== */

const CART_KEY = 'crux_cart_v1';

function readCart() {
  try {
    const raw = localStorage.getItem(CART_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function writeCart(items) {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(items));
  } catch (e) {
    /* storage unavailable (private mode / quota) — cart still works in-memory for this page load */
  }
  document.dispatchEvent(new CustomEvent('cart:updated', { detail: { cart: items } }));
}

function cartAdd(item) {
  const cart = readCart();
  const existing = cart.find((c) => c.key === item.key);
  if (existing) {
    existing.qty += item.qty;
  } else {
    cart.push(item);
  }
  writeCart(cart);
  return cart;
}

function cartSetQty(key, qty) {
  let cart = readCart();
  if (qty <= 0) {
    cart = cart.filter((c) => c.key !== key);
  } else {
    const it = cart.find((c) => c.key === key);
    if (it) it.qty = Math.min(qty, 20);
  }
  writeCart(cart);
}

function cartRemove(key) {
  writeCart(readCart().filter((c) => c.key !== key));
}

function cartClear() {
  writeCart([]);
}

function cartCount() {
  return readCart().reduce((s, c) => s + c.qty, 0);
}

function cartSubtotal() {
  return readCart().reduce((s, c) => s + c.qty * c.price, 0);
}

function fmtMoney(n) {
  return SHOP.currency + n.toFixed(2);
}

/* ---- optional per-product Stripe Payment Link (see store-data.js) --------*/

function getStripeLink(productId) {
  const links = (SHOP.payment && SHOP.payment.productLinks) || {};
  const url = links[productId];
  return url && url.trim() ? url.trim() : null;
}

/* ---- rendering ---------------------------------------------------------- */

function iconSvg(name) {
  const icons = {
    bag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8h12l1 13H5L6 8z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3m-8 0 1 13h10l1-13"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>',
  };
  return icons[name] || '';
}

function renderCartUI() {
  const cart = readCart();
  const count = cart.reduce((s, c) => s + c.qty, 0);
  const subtotal = cart.reduce((s, c) => s + c.qty * c.price, 0);

  document.querySelectorAll('[data-cart-count]').forEach((el) => {
    el.textContent = String(count);
    el.style.display = count > 0 ? '' : 'none';
  });

  const itemsWrap = document.getElementById('cartDrawerItems');
  const foot = document.getElementById('cartDrawerFoot');
  if (itemsWrap) {
    if (cart.length === 0) {
      itemsWrap.innerHTML = `
        <div class="cart-empty">
          ${iconSvg('bag')}
          <p>Your cart is empty.</p>
          <a href="shop.html" class="btn btn-outline btn-sm" style="margin-top:14px;">Browse the shop</a>
        </div>`;
      if (foot) foot.style.display = 'none';
    } else {
      itemsWrap.innerHTML = cart.map(cartLineHTML).join('');
      if (foot) foot.style.display = '';
    }
  }

  const subtotalEl = document.getElementById('cartDrawerSubtotal');
  if (subtotalEl) subtotalEl.textContent = fmtMoney(subtotal);

  const shipNote = document.getElementById('cartShipNote');
  if (shipNote) {
    if (subtotal >= SHOP.freeShippingThreshold) {
      shipNote.textContent = 'Free standard shipping unlocked.';
    } else if (subtotal > 0) {
      const remaining = SHOP.freeShippingThreshold - subtotal;
      shipNote.textContent = `Add ${fmtMoney(remaining)} more for free standard shipping.`;
    } else {
      shipNote.textContent = '';
    }
  }

  wireCartLineControls();

  if (typeof onCartPageRender === 'function') onCartPageRender(cart);
  if (typeof onCheckoutSummaryRender === 'function') onCheckoutSummaryRender(cart);
}

function cartLineHTML(item) {
  return `
    <div class="cart-line" data-key="${escapeAttr(item.key)}">
      <div class="thumb"><img src="${escapeAttr(item.image)}" alt="${escapeAttr(item.name)}" loading="lazy"></div>
      <div class="info">
        <div class="name">${escapeHtml(item.name)}</div>
        ${item.variant ? `<div class="variant">${escapeHtml(item.variant)}</div>` : ''}
        ${item.note ? `<div class="variant">Note: ${escapeHtml(item.note)}</div>` : ''}
        <div class="row-bottom">
          <div class="qty-stepper sm" data-key="${escapeAttr(item.key)}">
            <button type="button" data-step="dec" aria-label="Decrease quantity">−</button>
            <input type="text" inputmode="numeric" value="${item.qty}" readonly aria-label="Quantity">
            <button type="button" data-step="inc" aria-label="Increase quantity">+</button>
          </div>
          <div class="price num">${fmtMoney(item.price * item.qty)}</div>
        </div>
        <a href="#" class="remove" data-remove="${escapeAttr(item.key)}">Remove</a>
      </div>
    </div>`;
}

function wireCartLineControls() {
  document.querySelectorAll('.qty-stepper[data-key]').forEach((stepper) => {
    const key = stepper.getAttribute('data-key');
    const input = stepper.querySelector('input');
    stepper.querySelectorAll('button[data-step]').forEach((btn) => {
      btn.onclick = () => {
        const cur = parseInt(input.value, 10) || 1;
        const next = btn.getAttribute('data-step') === 'inc' ? cur + 1 : cur - 1;
        cartSetQty(key, next);
      };
    });
  });
  document.querySelectorAll('[data-remove]').forEach((a) => {
    a.onclick = (e) => {
      e.preventDefault();
      cartRemove(a.getAttribute('data-remove'));
    };
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

/* ---- toast ---------------------------------------------------------------*/

function showToast({ title, subtitle, image }) {
  let stack = document.querySelector('.toast-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.className = 'toast-stack';
    document.body.appendChild(stack);
  }
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `
    ${image ? `<img src="${escapeAttr(image)}" alt="">` : ''}
    <div class="msg"><b>${escapeHtml(title)}</b>${subtitle ? `<span>${escapeHtml(subtitle)}</span>` : ''}</div>
  `;
  stack.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 400);
  }, 3200);
}

/* ---- add-to-cart convenience ---------------------------------------------*/

function addToCartAndNotify(item, opts) {
  opts = opts || {};
  cartAdd(item);
  showToast({ title: 'Added to cart', subtitle: `${item.name}${item.variant ? ' · ' + item.variant : ''}`, image: item.image });
  if (opts.openDrawer !== false) openCartDrawer();
}

document.addEventListener('DOMContentLoaded', renderCartUI);
document.addEventListener('cart:updated', renderCartUI);
window.addEventListener('storage', (e) => { if (e.key === CART_KEY) renderCartUI(); });

/* ---- orders (client-side order history, used by checkout + confirmation) -*/

const ORDERS_KEY = 'crux_orders_v1';

function generateOrderId() {
  const t = Date.now().toString(36).toUpperCase();
  const r = Math.random().toString(36).slice(2, 5).toUpperCase();
  return `RR-${t}-${r}`;
}

function saveOrder(order) {
  let orders = [];
  try { orders = JSON.parse(localStorage.getItem(ORDERS_KEY)) || []; } catch (e) { orders = []; }
  orders.unshift(order);
  orders = orders.slice(0, 50);
  try { localStorage.setItem(ORDERS_KEY, JSON.stringify(orders)); } catch (e) { /* ignore */ }
  return order;
}

function getOrder(id) {
  let orders = [];
  try { orders = JSON.parse(localStorage.getItem(ORDERS_KEY)) || []; } catch (e) { orders = []; }
  return orders.find((o) => o.id === id) || null;
}
