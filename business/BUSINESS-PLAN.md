# Rackhouse Supply Co. — Business Plan

*Working draft. Written to get you from "I have three 3D-printed designs
and a climbing following" to a running, profitable small business with
close to zero upfront cash — not to be a static document you file away.
Update the numbers in here as real ones replace the estimates.*

## 1. What this is

Rackhouse sells small-batch, 3D-printed goods for climbers, made to
order, plus two print-on-demand merch items:

| Product | Price | What it is |
|---|---|---|
| The Gatekeeper | $20 | Flagship — oversized carabiner-shaped gear organizer and helmet holder, hangs a full trad rack off one point, explicitly marked "NOT FOR CLIMBING" |
| The Rock Ring | $34 | Desktop mini fingerboard — two open ports for finger curls, doubles as storage for chalk bag, keys, sunglasses |
| The Cup Cradle | $16 | Car-cupholder adapter that cradles a wide-mouth Nalgene upright |
| Rock Ring — Gift Duo | $62 | Two Rock Rings, any two colors |
| Felt Base Pad Set | $5 | Bought-in accessory for the Rock Ring's base |
| Rackhouse Tee | $26 | Logo tee, print-on-demand, S–XXL |
| Sticker Pack | $8 | Four die-cut vinyl stickers, print-on-demand |

Full specs, photography, and the live cart/checkout are in `crux-shop/`.
Cost basis for every price above is in `UNIT-ECONOMICS-AND-SCALING.md`.

## 2. The unfair advantage: you already have an audience

Most new print-shop businesses spend their first six months and most of
their budget just finding buyers. You said your climbing social media is
already popular — that's the single biggest asset in this plan, and it
changes the whole shape of the launch:

- **Customer acquisition cost starts near $0.** A normal e-commerce
  launch budgets real money for ads to find its first hundred buyers.
  You post to people who already climb, already follow you, and already
  trust your taste.
- **It de-risks the "don't print until orders land" plan.** A cold
  audience takes weeks to convert; a warm one can generate your first
  five to ten orders within days of the first post, which is exactly
  the signal you need before spending on filament.
- **It's the thing to protect.** Don't burn that trust with a hard sell.
  See `SOCIAL-MEDIA-KIT.md` for posts written to read like you sharing
  something you made, not an ad.

## 3. Go-to-market plan

**Phase 0 — before the first post (this week):**
- [ ] Deploy the site (see `RENDER-DEPLOYMENT.md`)
- [ ] Connect a payment processor (see `PAYMENTS-SETUP.md`) — or launch
      with the email/manual-invoice flow already built and add Stripe
      once the first order proves demand. Either is a legitimate
      starting point; Stripe just removes a manual step for you.
- [ ] Swap the placeholder contact email (`hello@rackhousesupply.example`) for
      a real inbox you check — see `crux-shop/README.md`.
- [ ] Print (or have printed) **one of each product** as a photo/video
      prop and to get real cost numbers (see `UNIT-ECONOMICS-AND-SCALING.md`).

**Phase 1 — launch week:**
- [ ] Post the launch sequence in `SOCIAL-MEDIA-KIT.md` (3–5 posts across
      the week, not all at once).
- [ ] Pin the shop link in your bio / link-in-bio tool.
- [ ] Reply to every comment and DM — at this stage, engagement matters
      more than reach.

**Phase 2 — first orders (as they land):**
- [ ] Fulfill in the order promised (2–4 business days) — a fast first
      fulfillment from a small account is disproportionately good for
      word of mouth.
- [ ] Ask happy buyers if you can repost their photo (with credit) —
      this is your first real social proof, and the site currently has
      none by design (see `crux-shop/README.md` — no fake reviews were
      added).
- [ ] Log actual per-order numbers (time, filament, shipping cost paid)
      against the estimates in `UNIT-ECONOMICS-AND-SCALING.md` and
      correct the model.

**Phase 3 — steady state (once orders are a weekly habit):**
- [ ] Revisit pricing/shipping rates against your now-real cost data.
- [ ] Decide, using the printer-hours math in `UNIT-ECONOMICS-AND-SCALING.md`,
      whether you're capacity-constrained — if so, that's your "scale"
      signal, not a calendar date.
- [ ] Revisit the LLC question in `LEGAL-AND-ENTITY-FORMATION.md` — the
      honest trigger points are in there, not a fixed timeline.

## 4. Financial snapshot (illustrative — replace with your real numbers)

Assuming the illustrative margins from `UNIT-ECONOMICS-AND-SCALING.md`
and a **modest first month** driven entirely by your existing audience:

| | Conservative | Solid launch |
|---|---|---|
| Orders in month 1 | 8 | 25 |
| Average order value | ~$28 (mostly single Gatekeepers/Rock Rings, some merch add-ons) | ~$32 |
| Gross revenue | $224 | $800 |
| Materials-only COGS (~20% of revenue, blended with lower-margin merch) | $45 | $160 |
| Payment processing (~3.3%) | $7 | $26 |
| **Gross profit before your labor & one-time costs** | **~$172** | **~$614** |

One-time startup costs to weigh against that, all optional depending on
what you already have:

| Item | Cost | Required? |
|---|---|---|
| Domain name (optional — see `RENDER-DEPLOYMENT.md`) | $10–15/yr | No, Render's free subdomain works |
| Render hosting | $0 (free tier) | No, unless you outgrow it |
| Stripe account | $0 to open | No cost until you're paid, then per-transaction only |
| First spool of PLA+ filament (if you don't have one) | $20–28 | Only if you don't already print |
| FDM printer (if you don't own one) | $200–500 | Only if you can't borrow/access one — see step 2 in `UNIT-ECONOMICS-AND-SCALING.md` |
| LLC formation (if/when you form one) | $50–500 depending on state | Only once triggers in `LEGAL-AND-ENTITY-FORMATION.md` are met |

**Read on this:** if you already have access to a printer, your realistic
cash outlay to take and fulfill the first ten orders is **under $50** —
one spool of filament and some packaging tape. Even the conservative
scenario above pays that back inside the first two or three orders. That
is the "quick ROI, low upfront investment" plan you asked for; the site
and this plan are built around it rather than around a bigger, slower
version of the business.

## 5. Risks and how the plan already handles them

| Risk | Mitigation already in place |
|---|---|
| Overprinting before demand is proven | Make-to-order model, zero pre-built inventory |
| Money spent before payment is collected | Checkout confirms orders by email before any print starts |
| Liability from climbing-adjacent branding | Explicit "not climbing protection" disclaimers on every relevant product page and in the FAQ; the Gatekeeper has "NOT FOR CLIMBING" molded into the part itself |
| Trademark exposure (Nalgene name, on the Cup Cradle) | Product page carries an explicit non-affiliation disclaimer; see `LEGAL-AND-ENTITY-FORMATION.md` |
| Lower margin / vendor dependency on merch | Tee and stickers are print-on-demand by design — zero upfront inventory risk, in exchange for a thinner margin than the 3D-printed line; see `UNIT-ECONOMICS-AND-SCALING.md` |
| Fake social proof eroding trust | None added — no fabricated reviews, ratings, or testimonials anywhere on the site |
| One-printer capacity ceiling | Modeled explicitly in `UNIT-ECONOMICS-AND-SCALING.md`, with a scaling ladder that only spends money once volume justifies it |

## 6. What "done" looks like for this plan

Not a revenue target — a set of working systems:

1. Site is live and takes real orders (Render deployed).
2. A customer can actually pay you (Stripe or another processor connected).
3. You've fulfilled at least one real order end-to-end and corrected the
   cost model with real numbers.
4. You have a documented answer for "am I still a sole proprietor or do
   I need an LLC yet" (see `LEGAL-AND-ENTITY-FORMATION.md`) that you
   actually revisit, not just read once.

Everything past that is optimization, not launch.
