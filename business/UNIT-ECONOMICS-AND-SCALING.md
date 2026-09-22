# Unit economics & print scaling

Everything here is a **framework with placeholder numbers**, not a guarantee.
The weights are computed from the actual STL files (see the math below);
the filament price, print times, and packaging costs are reasonable
market assumptions you should replace with your own once you've run a
real print. Where I'm confident, I say so. Where I'm estimating, I say
that too — don't take a number in this file as more precise than it is.

## Step zero: you don't need to buy anything yet

You said you're not printing until the first orders land — that's the
right call, and the site is built for it (checkout collects orders now,
production happens after). The only two things worth doing *before* an
order arrives:

1. **One benchmark print per product**, if you have access to any FDM
   printer (yours, a friend's, a local library makerspace, a maker space
   membership). This turns every estimate below into a real number —
   actual grams used and actual print time from your slicer. Twenty
   minutes of setup now saves you from pricing blind later.
2. **If you don't own a printer at all**, you don't need to buy one to
   take the first order. A local maker/print-farm operator, a campus or
   library makerspace, or a print-on-demand service (see "Scaling past
   one printer" below) can fulfill your first handful of orders for
   roughly the same per-part cost modeled here, with zero equipment
   spend. Buy a printer once you have proof the orders keep coming —
   that's the whole point of the make-to-order model you already have.

## Where the weights come from

Not guessed — computed from the actual STL geometry (mesh volume via the
divergence theorem, scaled by PLA's density of 1.24 g/cm³):

| Product | Solid volume | Weight at 100% infill | Weight at ~20–35% infill (typical) |
|---|---|---|---|
| Rock Ring | 644.6 cm³ | 799 g | **~160–210 g** |
| Big Biner | 87.1 cm³ | 108 g | **~70–100 g** |
| Bottle Adapter | 228.8 cm³ | 284 g | **~110–160 g** |
| Gift Duo (2× Rock Ring) | — | — | **~320–420 g** |
| Felt Base Pads | — (not printed; a bought-in commodity item) | — | — |

Print time is the one number I can't compute from geometry alone — it
depends on your printer's speed, nozzle, layer height, and slicer
settings. Don't trust a number here you haven't measured; the framework
below is built so you can drop your real number in once you have it.

## Cost-per-part framework

Fill in your own values for the bracketed placeholders. The formula:

```
Cost per part = (grams × $/gram filament)
              + packaging
              + payment processing fee
              + (optional) your hourly rate × print/pack hours
```

Illustrative numbers at **$22/kg filament** (a reasonable PLA+ street
price — check your actual supplier) and **Stripe's standard 2.9% + $0.30**
processing fee:

| Product | Price | Filament cost | Packaging (est.) | Processing fee | Materials-only COGS | Gross margin |
|---|---|---|---|---|---|---|
| Rock Ring | $34.00 | $3.74 (170g) | $1.50 | $1.29 | $6.53 | **$27.47 (81%)** |
| Big Biner | $29.00 | $1.87 (85g) | $2.00 (larger flat box) | $1.14 | $5.01 | **$23.99 (83%)** |
| Bottle Adapter | $14.00 | $2.97 (135g) | $1.20 | $0.71 | $4.88 | **$9.12 (65%)** |
| Gift Duo | $62.00 | $7.48 (340g) | $2.50 | $2.10 | $12.08 | **$49.92 (81%)** |
| Felt Base Pads | $5.00 | ~$0.75 (bought-in) | $0.75 | $0.45 | $1.95 | **$3.06 (61%)** |

Two things this table deliberately leaves out, on purpose:

- **Shipping.** The site charges $5.95 standard (free over $60) — verify
  that actually covers a real USPS/UPS/regional-carrier rate for your
  package's real weight and dimensions before you rely on it. A Rock Ring
  in a small box is light but bulky; get an actual quote.
- **Your time.** Materials margin looks great (65–83%) because it ignores
  the thing that's actually scarce in a one-printer operation: print
  hours and your own pack/ship time. That's the real constraint — see
  below.

## The real bottleneck is printer-hours, not materials

A print that costs $3.74 in filament but ties up your printer for 8–10
hours caps how many you can sell per week far more than materials cost
ever will. Before pricing decisions, figure out (from your benchmark
print) roughly how many hours each product takes, then:

```
Max units/week on one printer ≈ (printer-hours available per week) ÷ (hours per print)
```

Example: if a Rock Ring takes ~8 hours and you can run the printer
~12 hours/day (waking hours plus one overnight run), that's roughly
1.5 prints/day, or **~10 Rock Rings/week** from a single machine — call
it $340/week gross on that SKU alone, materials-only margin ~$275/week,
before your labor. That's a real, useful ceiling to know going in.

## Scaling past one printer (only once demand proves it)

Do this in order — each step should be paid for by revenue you've
already seen, not upfront investment:

1. **Batch the plate.** Most slicers can nest multiple copies (or
   multiple different products) on one build plate per print job —
   cuts changeover time, not total print time, but reduces your active
   labor per unit.
2. **Print overnight / unattended.** If your printer and filament setup
   are reliable, running it 16–20 hrs/day instead of 8 roughly doubles
   throughput for zero equipment cost.
3. **Add a second printer** once weekly demand consistently exceeds one
   printer's ceiling for two to three weeks running — not before. A
   second entry-to-mid FDM printer is commonly $200–$500, a real but
   modest step, and only makes sense once orders are already paying for
   it.
4. **Recruit a "print partner."** Some makerspaces and hobbyist 3D
   printer owners will run prints for a per-part fee (a cut of margin,
   or a flat $/hour) — lets you scale capacity without buying hardware.
5. **Outsource to a print-on-demand manufacturing service** (search
   terms: "on-demand FDM manufacturing," "3D print production service")
   once volume is consistent enough to justify their minimums — this
   trades margin for zero-printer-ownership scaling and is usually the
   right move only after step 3–4 stop keeping up.

Don't skip ahead in this list — every step past #2 costs real money or
margin, and the whole point of your make-to-order model is that you only
spend once you've already been paid.

## Sanity-check before you commit to these prices

- Print one of each on your own (or a borrowed) printer and log actual
  grams and hours.
- Get one real shipping quote for a packed box at the actual weight
  from USPS.com or your carrier of choice.
- Re-run the table above with your real numbers before your first sale.
