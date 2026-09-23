# Rackhouse — a small-batch 3D-printed gear storefront

A self-contained e-commerce site for **Rackhouse Supply Co.**, selling
three 3D-printed pieces built from real STL geometry, plus two
print-on-demand merch items:

- **The Gatekeeper** (flagship) — an oversized carabiner-shaped gear
  organizer and helmet holder, built from a supplied STL.
- **The Rock Ring** — a freestanding desktop mini fingerboard, built
  from `Rock_Ring_V1.STL`.
- **The Cup Cradle** — a car-cupholder adapter that cradles a
  wide-mouth Nalgene, built from a supplied STL.
- **Rock Ring — Gift Duo** and **Felt Base Pad Set** — real, buildable
  add-ons on top of the Rock Ring.
- **Rackhouse Tee** and **Sticker Pack** — logo merch, fulfilled by a
  print-on-demand partner rather than printed in-house (see
  `business/ORDER-INTAKE-AND-FULFILLMENT.md`).

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
| **17 pages** | Home, shop, seven product pages, cart, checkout, order confirmation, about, FAQ, shipping & returns, contact, 404. |
| **A real cart** | `localStorage`-backed, shared across every page via `js/cart.js`, with a slide-out drawer and a full cart page. |
| **A real checkout** | Address form with validation, two shipping speeds, a working promo code (`FIRSTSEND10`), live order-summary math. |
| **Order capture** | Placing an order saves it (client-side) and shows a confirmation with an order ID — see **What still needs you** below for the one piece this can't do on its own. |
| **Interactive 3D viewers** | The Gatekeeper, Rock Ring, and Cup Cradle each have a drag-to-rotate, live-recolored WebGL viewer (Three.js, vendored — no CDN) loading the actual STL, alongside rendered photography. |
| **86 images** | Rendered directly from the three products' actual STL geometry (six colorways × multiple angles each) plus dark hero shots, "in use" illustrations, and the merch mockups — not stock photography. |

## Where the numbers come from

Nothing about any product's spec was guessed. Each STL (`rock-ring.stl`,
`gatekeeper.stl`, `cup-cradle.stl` in `models/`) was parsed directly
(binary STL format) to get:

- **Bounding boxes and feature dimensions** (ports, holes, stem/basket
  diameters) from the mesh's actual extent and by isolating relevant
  triangles, confirmed by eye against rendered orthographic views.
- **Weight estimates** from the mesh's solid volume (via the divergence
  theorem over its triangles) scaled to a typical FDM infill — an
  estimate, labelled as one everywhere it appears.
- **The product photos** are the actual mesh, custom-shaded (a two-light
  Lambertian model, no external renderer) and composited onto designed
  backdrops with Python (`matplotlib` + `Pillow`) — see the render
  scripts' logic if you want to regenerate them for a new model.
- **The interactive 3D viewers** load the same STL files directly in the
  browser via Three.js's `STLLoader`, so what you can drag-rotate on the
  product page is the exact geometry the photos were rendered from.

Two things the geometry corrected along the way: an earlier draft of
this shop sold a "wall-mount hardware kit" for the Rock Ring's shape —
the mesh is symmetric front-to-back, meaning it's freestanding, not
wall-mountable, so that product became a felt base-pad set instead.
Separately, the Rock Ring's two ports turned out sized for hooking
fingers into (not just gear storage), which is why it's positioned as a
desktop mini fingerboard.

## What still needs you

This is a fully working storefront *front-end*. Two things need a real
business behind them before it can take real money:

1. **`SHOP.email`** in `js/store-data.js` is `hello@rackhousesupply.example`
   — `.example` is a domain IANA reserves so it can never resolve, which
   means it's a safe placeholder rather than a guess at a real inbox that
   might belong to someone else. Swap it for an inbox you actually check.
2. **`SHOP.payment.productLinks`** (same file) is empty for every
   product. Nothing here can create a Stripe/PayPal account on your
   behalf, so checkout currently collects the order, shows it on the
   confirmation page, and tells the customer you'll follow up with a
   secure payment link — the honest version of "no payment is collected
   yet." Drop in real Stripe Payment Links (see
   `business/PAYMENTS-SETUP.md`) to take that step live.

Everything else — the newsletter box, the contact form — submits via a
`mailto:` draft to `SHOP.email` for the same reason: it works with zero
setup and zero accounts, and it'll start actually delivering the moment
you swap in a real address.

## Honest limits

- **No reviews.** There are no star ratings or testimonials anywhere on
  the site. The shop is new and has none yet, so none were invented.
- **Not climbing safety equipment**, and every relevant product page and
  the FAQ say so — it's gear storage, not a rated anchor point.
- **The tee and sticker mockups are web-resolution design mockups**, not
  print-ready files — see `business/ORDER-INTAKE-AND-FULFILLMENT.md` for
  what's needed to actually produce them through a print-on-demand
  partner.
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
js/model-viewer.js  Mounts the interactive Three.js STL viewer used
                    on the Gatekeeper, Rock Ring, and Cup Cradle pages.
js/vendor/          Three.js, STLLoader, OrbitControls — vendored
                    locally, no CDN dependency at runtime.

models/             The actual STL files the 3D viewers and product
                    photography were both built from.

img/                Rendered product photography, "in use" illustrations,
                    merch mockups, and favicons.
```

One deliberate robustness choice: the scroll-triggered fade-in
(`.reveal`) on the home and about pages is **visible by default in CSS**;
JavaScript is what hides an element right before animating it in, and a
one-second timer force-reveals anything the scroll observer misses. A
no-JS visitor, a JS error, or a tool that renders the page without a real
scroll all still see full content — nothing on this site depends on
JavaScript succeeding to be readable.

## Credits

Geometry from the supplied `Rock_Ring_V1.STL`, and the STL files behind
the Gatekeeper and the Cup Cradle. Not affiliated with any climbing-gear
manufacturer, Nalgene, or any safety-equipment standard.
