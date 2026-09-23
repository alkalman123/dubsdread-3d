# Deploying the shop to Render

**Not the active deployment.** The live site actually runs on GitHub
Pages today — see the live link if you don't already have it. This
document is kept as a documented alternative (Render gives you a
custom-domain-friendly host outside GitHub), not a step you still need
to do.

This needs your own Render account — I can prepare everything on the
code side, but connecting your GitHub repo to Render's hosting has to
happen from inside your own Render dashboard (it's your account, your
billing, your call). Here's the fastest reliable path, plus a shortcut
that might save you a step.

## The reliable path — Render dashboard, manual setup (~5 minutes)

1. Go to **render.com**, sign up or log in (GitHub sign-in makes the next
   step easier).
2. **New +** → **Static Site**.
3. Connect your GitHub account if you haven't, then pick this repository
   (`dubsdread-3d`).
4. Fill in:
   - **Name:** `crux-shop` (or whatever you'd like the URL to include)
   - **Branch:** whichever branch has this work merged (ask if unsure —
     the branch it was built on is `claude/eager-einstein-wx26nc`; if
     you've since merged that into your main branch, use that instead)
   - **Root Directory:** `crux-shop`
   - **Build Command:** leave blank, or `echo "no build needed"` — it's
     a static site, nothing to compile
   - **Publish Directory:** `.` (a single period — means "the root
     directory above")
5. Click **Create Static Site**. Render builds and deploys — first
   deploy usually takes under a minute for a site this size.
6. You'll get a free `https://crux-shop.onrender.com`-style URL
   immediately. Test the whole flow on it: browse, add to cart, run
   through checkout with a fake order, confirm the order-confirmation
   page works.

That's a fully live, real URL you can put in your social media bio today,
on Render's free tier, with no payment method required to get started.

## The shortcut — Blueprint (render.yaml)

This repo includes a `render.yaml` at its root that describes a
`crux-shop` static-site service (alongside the existing garmin-viewer
service). In the Render dashboard: **New +** → **Blueprint** → pick this
repo → **Apply**. If Render accepts it, it sets up the same thing as the
manual steps above in one click.

**Caveat, stated plainly:** this session's network access to render.com
was blocked while building this, so the exact blueprint syntax for a
static site (`runtime: static` vs. an older `env: static` key) could not
be verified against Render's live docs. If Apply fails or errors on the
`crux-shop` service specifically, don't fight it — just use the manual
steps above, which don't depend on getting that syntax exactly right and
take about the same five minutes.

## A custom domain (optional, later)

Render's free `onrender.com` subdomain is a completely legitimate URL to
launch and take real orders on — plenty of small shops never bother with
a custom domain. If you want one later (e.g. `rackhousesupply.com`):

1. Buy the domain from any registrar (Namecheap, Google Domains'
   successor Squarespace Domains, Cloudflare Registrar — doesn't matter
   which).
2. In Render: your service → **Settings** → **Custom Domains** → add it,
   follow the DNS instructions Render gives you (usually a CNAME record).
3. Render issues a free SSL certificate automatically — no extra step.

## After you deploy: the checklist that actually matters

Deploying is the easy part. Before telling anyone the link:

- [ ] Swap `SHOP.email` in `crux-shop/js/store-data.js` for a real inbox
      (see `crux-shop/README.md`'s launch checklist).
- [ ] Decide on payment (see `PAYMENTS-SETUP.md`) — Stripe links or the
      built-in email-invoice flow are both legitimate ways to start.
- [ ] Place one real test order yourself, start to finish, on the live
      URL — this catches anything that only shows up once it's not
      `localhost` anymore (broken image paths, etc.).
- [ ] Re-deploy after every future edit — Render auto-deploys on every
      push to the connected branch by default, so `git push` is usually
      all you need going forward.
