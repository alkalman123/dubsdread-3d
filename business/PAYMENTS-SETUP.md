# Accepting credit cards — what you actually need to do

## The short answer

1. Create a free Stripe account (~10 minutes, no cost until you're paid).
2. For each product, create a **Stripe Payment Link** (no code — a few
   clicks in the Stripe dashboard).
3. Paste each link into `crux-shop/js/store-data.js` under
   `SHOP.payment.productLinks`.
4. Every "Buy now" button on the site now sends the customer straight to
   Stripe's own hosted checkout page and takes a real card — **this is
   already wired up in the code**, waiting for those links.

Nothing else needs to change. The rest of this document is the "why" and
the exact steps, plus what to do about carts with more than one kind of
item in them.

## Step by step

### 1. Create a Stripe account

- Go to stripe.com and sign up. Free, no upfront cost.
- You'll need: your legal name/business name (sole proprietor is fine to
  start — see `LEGAL-AND-ENTITY-FORMATION.md`), a bank account to receive
  payouts, and your SSN or EIN for tax reporting (Stripe asks because
  it's legally required to report your payments to the IRS above a
  threshold, not because anything is wrong).
- Stripe will want to verify your identity/business before you can go
  live — this can take anywhere from minutes to a couple of days.
  Start this **before** you plan to launch, not the day of.

### 2. Know the fees before you price anything

Stripe's standard US rate is **2.9% + $0.30 per successful card charge**
(rates can differ slightly for certain card types, e.g. Amex, or for
international cards — check your dashboard for your actual rate). On a
$34 Rock Ring, that's about $1.29 — already reflected in the margin
table in `UNIT-ECONOMICS-AND-SCALING.md`. There's no monthly fee, no
setup fee — you only pay when you get paid.

### 3. Create a Payment Link per product

In the Stripe dashboard: **Payment Links → + New**.

- Product name: match the site (e.g. "The Rock Ring")
- Price: match the site exactly, including cents (e.g. $34.00) — Stripe
  and the site's displayed price should never disagree
- Turn on **"Allow customers to adjust quantity"** if you want them able
  to buy more than one in a single Stripe checkout
- Under **Payment page** → you can enable "Collect shipping address" so
  Stripe collects the delivery address for you (recommended — one less
  thing to chase down by email)
- Save, and copy the generated URL (looks like
  `https://buy.stripe.com/xxxxxxx`)

Repeat for each product you want to sell this way. You do **not** need
one per colorway — the color the customer picked is already shown on
your product page before they click "Buy now"; just make a note to check
which color they meant when you fulfill (Stripe's shipping-address step
also has an optional custom field you can add, e.g. "Color:", if you
want it captured automatically).

### 4. Wire the link into the site

Open `crux-shop/js/store-data.js`, find `SHOP.payment.productLinks`, and
paste the URL for the product you just created:

```js
productLinks: {
  'rock-ring': 'https://buy.stripe.com/your-real-link-here',
  'big-biner': '',
  'bottle-adapter': '',
  'gift-duo': '',
  'felt-pads': '',
},
```

Save, redeploy (see `RENDER-DEPLOYMENT.md`), done. A product with a blank
`''` keeps using the built-in cart + email-invoice checkout — so you can
turn this on one product at a time, whenever each is ready.

### 5. What happens with a mixed cart (Rock Ring + Gift Duo together, say)

"Add to cart" always uses the site's own cart and checkout — a single
Stripe Payment Link can't represent an arbitrary combination of items
without a backend server generating one on the fly, which this static
site intentionally doesn't have (keeps hosting free and simple). For
those orders, the built-in flow still works exactly as it does today:
the order is collected, and you follow up to collect payment — at which
point you can either send that customer a **Stripe Payment Link you
create on the spot for their exact total**, or use **Stripe Invoicing**
(Dashboard → Invoices → New), which is built for exactly this: a custom
one-off amount, emailed straight from Stripe, payable by card.

This isn't a workaround — plenty of small shops run exactly this hybrid
forever: instant card checkout for straightforward single-item orders,
a two-minute manual invoice for anything custom or combined.

### 6. If you outgrow this later

Once order volume is consistently high enough that manually invoicing
mixed carts is a real time cost, the next step up is a small backend
(a serverless function that creates a true dynamic **Stripe Checkout
Session** from the cart's actual contents) — a bigger engineering lift,
and one worth paying a developer for once revenue clearly justifies it.
Don't build for that on day one.

## Alternatives to Stripe, briefly

- **PayPal / PayPal.me** — similar no-code payment-link approach,
  slightly different fee structure, very widely trusted by buyers. Works
  the same way in this codebase: paste a PayPal.me link (or a PayPal
  "Buy Now" button link) into the same `productLinks` slot.
- **Square** — good if you also ever sell in person (craft fairs, gear
  swaps) since the same account covers both online and a physical card
  reader.

Stripe is the default recommendation here mainly because Payment Links
are genuinely no-code and the fee is standard/transparent — any of these
three will work with the exact mechanism already wired into the site.
