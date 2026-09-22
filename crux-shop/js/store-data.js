/* =============================================================================
   CRUX — store configuration & product catalog
   Single source of truth for pricing, shipping and product data.

   LAUNCH CHECKLIST — replace before taking real orders:
   1. SHOP.email   → a real inbox you check (currently a safe RFC 2606 .example
                      placeholder that cannot deliver mail).
   2. SHOP.payment.paymentLinkUrl → a real Stripe Payment Link / PayPal.me /
                      Snipcart checkout URL once you have a payment processor
                      connected. Until then, checkout collects orders and the
                      shop follows up by email to take payment manually.
   3. Swap SHOP.social if/when real social accounts exist (none are linked yet).
   ========================================================================== */

const SHOP = {
  name: 'Crux',
  legalName: 'Crux Supply Co.',
  tagline: 'Small-batch gear storage for climbers.',
  email: 'hello@cruxsupply.example',
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
    // Drop a real Stripe Payment Link / PayPal.me URL here to accept live
    // card payments at checkout. Left blank on purpose — see checklist above.
    paymentLinkUrl: '',
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

const PRODUCTS = {
  'rock-ring': {
    id: 'rock-ring',
    name: 'The Rock Ring',
    tagline: 'Freestanding gear valet — V1',
    price: 34.0,
    slug: 'product-rock-ring.html',
    badge: 'Best seller',
    hasColor: true,
    defaultColor: 'rock',
    short: 'A dome-topped block that sits on its own base, with two open ports running straight through it to corral chalk, keys, sunglasses and the rest of your pocket clutter.',
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

const CATALOG_ORDER = ['rock-ring', 'gift-duo', 'felt-pads'];

const COMING_SOON = [
  { name: 'Crimp Tray', note: 'A shallow dish for rings, coins and hold-shaped clutter.' },
  { name: 'Chalk Bucket Base', note: 'A weighted foot so your bucket stops tipping at the boulders.' },
];
