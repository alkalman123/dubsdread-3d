# Crux — business docs

Everything here supports one goal: take real orders with real payment,
funded by revenue rather than upfront investment, without printing
anything until an order is actually in hand.

## Start here — this week's checklist

1. **Deploy the site** → `RENDER-DEPLOYMENT.md` (~5 minutes, free)
2. **Decide on payment** → `PAYMENTS-SETUP.md` (Stripe Payment Links are
   already wired into the code — just paste in URLs — or launch with the
   built-in email-invoice flow and add Stripe later)
3. **Swap the placeholder contact email** for a real one you check — see
   the launch checklist at the top of `crux-shop/js/store-data.js`
4. **Print one of each product**, or get one printed, to (a) have a real
   photo/video and (b) get real cost numbers → `UNIT-ECONOMICS-AND-SCALING.md`
5. **Post the launch sequence** → `SOCIAL-MEDIA-KIT.md`
6. **Fulfill the first order fast** when it lands, and log the real
   numbers back into the cost model

## The documents

| Document | What's in it |
|---|---|
| `BUSINESS-PLAN.md` | The whole plan in one place — go-to-market using your existing audience, phased rollout, illustrative financials, risks and how the build already handles them |
| `UNIT-ECONOMICS-AND-SCALING.md` | Real weights computed from the STL files, a cost-per-part framework, and how to scale printing without spending ahead of demand |
| `LEGAL-AND-ENTITY-FORMATION.md` | Sole prop vs. LLC, when to actually form one, product-liability and trademark considerations specific to these products — general education, not legal advice |
| `PAYMENTS-SETUP.md` | Exact steps to accept credit cards via Stripe, and how it plugs into the code that's already built for it |
| `RENDER-DEPLOYMENT.md` | Exact steps to put the site on a real, live URL |
| `SOCIAL-MEDIA-KIT.md` | Ready-to-edit launch posts and an evergreen content list |

## What I could and couldn't do myself

I built, tested, and can edit anything in the codebase — the storefront,
the cart/checkout logic, the Stripe Payment Link hook, all of it. What I
can't do is act as you on services that need your own identity and
banking: creating your Render account, your Stripe account, or an LLC
all require your own sign-up, your own bank account, and in the LLC's
case your own state filing. Every doc above tells you exactly what to
click; none of it requires waiting on me again to move forward.

## If something in here turns out wrong

The cost estimates in `UNIT-ECONOMICS-AND-SCALING.md` are computed from
real geometry but assumed filament prices and print times — replace them
with your own numbers the moment you have a real print. Everything in
`LEGAL-AND-ENTITY-FORMATION.md` is general education, not advice for your
specific situation — a real lawyer or accountant beats this document
every time money or a dispute is actually on the line.
