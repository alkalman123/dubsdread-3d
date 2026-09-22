/* =============================================================================
   RACKHOUSE — store configuration & product catalog
   Single source of truth for pricing, shipping and product data.

   LAUNCH CHECKLIST — replace before taking real orders:
   1. SHOP.email   → a real inbox you check (currently a safe RFC 2606 .example
                      placeholder that cannot deliver mail).
   2. SHOP.payment.productLinks → paste a Stripe Payment Link URL per product
                      (see business/PAYMENTS-SETUP.md) once you have a Stripe
                      account, and every "Buy now" button on that product
                      instantly starts taking real cards — no other code
                      changes needed. Left blank, "Buy now" falls back to the
                      built-in cart + email-invoice checkout, which needs no
                      account at all. Multi-item carts ("Add to cart") always
                      use the built-in checkout, since one Payment Link can't
                      represent an arbitrary mixed cart without a backend.
   3. Swap SHOP.social if/when real social accounts exist (none are linked yet).
   ========================================================================== */

const SHOP = {
  name: 'Rackhouse',
  legalName: 'Rackhouse Supply Co.',
  tagline: 'Small-batch 3D-printed gear storage for climbers.',
  email: 'hello@rackhousesupply.example',
  phone: '',
  address: 'Chicago, IL · ships from a home studio, not a storefront',
  currency: '$',
  freeShippingThreshold: 60,
  shipping: {
    standard: { label: 'Standard', price: 5.95, eta: '3–6 business days' },
    expedited: { label: 'Expedited', price: 14.95, eta: '2 business days' },
  },
  promoCodes: {
    'FIRSTSEND10': { percentOff: 10, label: '10% off your first send' },
  },
  payment: {
    // One Stripe Payment Link per product (optional). When a product's
    // link is set, its "Buy now" button skips the internal checkout and
    // sends the customer straight to Stripe's own hosted, card-accepting
    // checkout page for that item. Leave a value blank/'' to keep using
    // the built-in email-invoice checkout for that product. See
    // business/PAYMENTS-SETUP.md for exactly how to create these.
    productLinks: {
      'big-biner': '',
      'rock-ring': '',
      'cup-cradle': '',
      'gift-duo': '',
      'felt-pads': '',
    },
  },
  social: {
    instagram: '',
  },
};

const COLORWAYS = [
  { key: 'rock',  name: 'Rock',  hex: '#63707c', note: 'cool slate grey' },
  { key: 'moss',  name: 'Moss',  hex: '#55805a', note: 'forest green' },
  { key: 'ice',   name: 'Ice',   hex: '#4a90c2', note: 'glacier blue' },
  { key: 'sand',  name: 'Sand',  hex: '#c9a86a', note: 'warm tan' },
  { key: 'ink',   name: 'Ink',   hex: '#202326', note: 'matte black' },
  { key: 'ember', name: 'Ember', hex: '#d85c2a', note: 'signature orange' },
];

function colorway(key) {
  return COLORWAYS.find((c) => c.key === key) || COLORWAYS[0];
}

function rockRingImages(colorKey) {
  return {
    hero: `img/rockring-${colorKey}-hero.jpg`,
    front: `img/rockring-${colorKey}-front.jpg`,
    profile: `img/rockring-${colorKey}-profile.jpg`,
    detail: `img/rockring-${colorKey}-detail.jpg`,
  };
}

function bigBinerImages(colorKey) {
  return {
    hero: `img/bigbiner-${colorKey}-hero.jpg`,
    front: `img/bigbiner-${colorKey}-front.jpg`,
    detail: `img/bigbiner-${colorKey}-detail.jpg`,
  };
}

function cupCradleImages(colorKey) {
  return {
    hero: `img/cupcradle-${colorKey}-hero.jpg`,
    top: `img/cupcradle-${colorKey}-top.jpg`,
    profile: `img/cupcradle-${colorKey}-profile.jpg`,
  };
}

const PRODUCTS = {
  'big-biner': {
    id: 'big-biner',
    name: 'The Big Biner',
    tagline: 'Gear organizer & helmet holder — V2.2',
    price: 29.0,
    slug: 'product-big-biner.html',
    badge: 'Flagship',
    hasColor: true,
    defaultColor: 'rock',
    short: 'An oversized carabiner-shaped rack with more than a dozen holes — hang a full trad rack, your helmet, and everything else that usually ends up loose in the trunk, all off one point. "NOT FOR CLIMBING" is printed right into the plastic, because it is genuinely not a rated carabiner.',
  },
  'rock-ring': {
    id: 'rock-ring',
    name: 'The Rock Ring',
    tagline: 'Desktop mini fingerboard — V1',
    price: 34.0,
    slug: 'product-rock-ring.html',
    badge: 'Original',
    hasColor: true,
    defaultColor: 'rock',
    short: 'A dome-topped block that sits on its own base, with two open ports sized to hook two or three fingers into — a mini fingerboard for finger curls and isometric holds at your desk. Between sessions, the same two ports corral chalk, keys and sunglasses.',
  },
  'cup-cradle': {
    id: 'cup-cradle',
    name: 'The Cup Cradle',
    tagline: 'Nalgene-to-cupholder adapter',
    price: 16.0,
    slug: 'product-cup-cradle.html',
    badge: 'New',
    hasColor: true,
    defaultColor: 'ice',
    short: 'A stem sized for a standard car console cupholder flares up into a wide, scalloped cradle that cups a full-size wide-mouth Nalgene so it rides upright instead of sliding around on the next turn.',
  },
  'gift-duo': {
    id: 'gift-duo',
    name: 'Rock Ring — Gift Duo',
    tagline: 'Two Rock Rings, any two colors',
    price: 62.0,
    compareAt: 68.0,
    slug: 'product-gift-duo.html',
    badge: 'Bundle',
    hasColor: false,
    image: rockRingImages('rock').hero,
    short: 'Two full-size Rock Rings in the colorways of your choice, boxed together — the easy answer to "what do you get a climber."',
  },
  'felt-pads': {
    id: 'felt-pads',
    name: 'Felt Base Pad Set',
    tagline: 'Self-adhesive felt, 4-pack',
    price: 5.0,
    slug: 'product-felt-pads.html',
    badge: 'Add-on',
    hasColor: false,
    image: rockRingImages('sand').profile,
    short: 'Four self-adhesive felt pads sized for the Rock Ring’s base, so it sits quietly on a desk, shelf or van console without scuffing the finish.',
  },
};

const CATALOG_ORDER = ['big-biner', 'rock-ring', 'cup-cradle', 'gift-duo', 'felt-pads'];

const COMING_SOON = [
  { name: 'Crimp Tray', note: 'A shallow dish for rings, coins and hold-shaped clutter.' },
  { name: 'Chalk Bucket Base', note: 'A weighted foot so your bucket stops tipping at the boulders.' },
];
