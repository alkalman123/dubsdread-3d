# Rackhouse — a storefront for The Rock Ring

A self-contained e-commerce site for **Rackhouse**, a small-batch 3D-printing
studio, selling **The Rock Ring** — a freestanding gear valet for climbers —
built from the supplied `Rock_Ring_V1.STL` model.

## Running it

Double-click **`index.html`**. That's the whole install — a static site,
no build step, no npm, nothing downloaded at runtime. If your browser
blocks local files from loading each other, serve the folder instead:

```
python3 -m http.server 8099
```

## What's in the box

| | |
|---|---|
| **13 pages** | Home, shop, three product pages, cart, checkout, order confirmation, about, FAQ, shipping & returns, contact, 404. |
| **A real cart** | `localStorage`-backed, shared across every page via `js/cart.js`, with a slide-out drawer and a full cart page. |
| **A real checkout** | Address form with validation, two shipping speeds, a working promo code (`FIRSTSEND10`), live order-summary math. |
| **Order capture** | Placing an order saves it (client-side) and shows a confirmation with an order ID — see **What still needs you** below for the one piece this can't do on its own. |
| **34 product photos** | Rendered directly from `Rock_Ring_V1.STL` — six colorways × four angles, plus a dimension diagram and a dark hero shot — not stock photography. |

## Where the numbers come from

Nothing about the product spec was guessed. `Rock_Ring_V1.STL` was parsed
directly (binary STL, ~4,500 triangles) to get:

- **Bounding box** — 127 × 114.3 × 63.5 mm — is the mesh's actual extent.
- **The two ports** — a lower one (~92 × 27 mm) and an upper one (~60 × 24
  mm), both open straight through the 63.5 mm depth — were located by
  isolating interior-facing triangles and measuring their extents, then
  confirmed by eye against rendered orthographic views.
- **The ~180 g weight** is the mesh's solid volume (via the divergence
  theorem over its triangles) scaled to a typical FDM infill — an estimate,
  labelled as one everywhere it appears.
- **The product photos** are the actual mesh, custom-shaded (a two-light
  Lambertian model, no external renderer) and composited onto designed
  backdrops with Python (`matplotlib` + `Pillow`) — see the render scripts'
  logic if you want to regenerate them for a V2 model.

The one thing the geometry ruled out: an earlier draft of this shop sold a
"wall-mount hardware kit." The mesh is symmetric front-to-back (both faces
show open ports, neither is flat), which means the piece is freestanding,
not designed to hang on a wall — so that product was replaced with a felt
base-pad set instead, before it ever shipped in this repo's history.

## What still needs you

This is a fully working storefront *front-end*. Two things need a real
business behind them before it can take real money:

1. **`SHOP.email`** in `js/store-data.js` is `hello@rackhousesupply.example` —
   `.example` is a domain IANA reserves so it can never resolve, which
   means it's a safe placeholder rather than a guess at a real inbox that
   might belong to someone else. Swap it for an inbox you actually check.
2. **`SHOP.payment.paymentLinkUrl`** (same file) is empty. Nothing here can
   create a Stripe/PayPal account on your behalf, so checkout currently
   collects the order, shows it on the confirmation page, and tells the
   customer you'll follow up with a secure payment link — the honest
   version of "no payment is collected yet." Drop in a real Stripe Payment
   Link, PayPal.me link, or Snipcart integration to take that step live.

Everything else — the newsletter box, the contact form — submits via a
`mailto:` draft to `SHOP.email` for the same reason: it works with zero
setup and zero accounts, and it'll start actually delivering the moment
you swap in a real address.

## Honest limits

- **One real design.** The Rock Ring is the only 3D model here. The Gift
  Duo (two Rings) and Felt Base Pads (generic adhesive pads) are real,
  buildable SKUs on top of it; "Crimp Tray" and "Chalk Bucket Base" on the
  shop page are marked **Coming soon** and are not purchasable — they're
  not pretending to be.
- **No reviews.** There are no star ratings or testimonials anywhere on
  the site. The shop is new and has none yet, so none were invented.
- **Not climbing safety equipment**, and the product page and FAQ say so —
  it's gear storage, not a rated anchor point.
- **Orders live in the visitor's browser.** `localStorage` is per-browser,
  per-device — there's no server-side order database. That's what the
  email hand-off above is for.

## How it's put together

```
index.html, shop.html,             Every page: static HTML, shared
product-*.html, cart.html,         header/footer/cart-drawer markup,
checkout.html, order-              no templating step.
confirmation.html, about.html,
faq.html, shipping-returns.html,
contact.html, 404.html

css/style.css      Design tokens + every component (buttons, cards,
                    drawer, forms, accordion, etc.)

js/store-data.js    Product catalog, prices, shipping rates, promo
                    codes — the one file to edit for a price change.
js/cart.js          Cart + order storage (localStorage), shared
                    rendering for the drawer, badges, toasts.
js/ui.js            Header, mobile nav, cart drawer wiring, scroll
                    reveals (see note below), mailto forms.
js/checkout.js      Checkout page: shipping/promo math, validation,
                    order placement.

img/                Rendered product photography + favicons.
```

One deliberate robustness choice: the scroll-triggered fade-in
(`.reveal`) on the home and about pages is **visible by default in CSS**;
JavaScript is what hides an element right before animating it in, and a
one-second timer force-reveals anything the scroll observer misses. A
no-JS visitor, a JS error, or a tool that renders the page without a real
scroll all still see full content — nothing on this site depends on
JavaScript succeeding to be readable.

## Credits

Geometry from the supplied `Rock_Ring_V1.STL`. Not affiliated with any
climbing-gear manufacturer or safety-equipment standard.
