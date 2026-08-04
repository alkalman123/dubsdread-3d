# Dubsdread — Interactive Course Preview

A self-contained 3D preview of **Cog Hill Golf & Country Club, Course No. 4 ("Dubsdread")**
in Lemont, Illinois — built to sit on a golf club's website and show a prospective
customer far more than a scorecard or a satellite photo can.

## Running it

Double-click **`index.html`**. That is the whole install. There is no build step,
no server, no npm, and nothing is downloaded at runtime — the page is a handful of
plain `.js` files and every texture is generated procedurally in the browser.

If your browser is locked down to block local files, run **`serve.cmd`** instead;
it starts a local Python web server on port 8099 and opens the page.

Requires a browser with WebGL 2 (Chrome, Edge, Firefox, Safari 15+).

## What it does

| | |
|---|---|
| **18 holes** | Every hole modelled from its real routing, greens, bunkers, tees and hazards. |
| **Six camera modes** | Tee, Approach, Green, Flyover (animated), Aerial, and free orbit. |
| **Shot visualiser** | Click the ground to aim; the app picks a club, flies the ball with real aerodynamics, then bounces and rolls it out on whatever surface it lands on. |
| **Play the hole** | Each shot starts from where the last one finished, so you can play a hole out. |
| **Five tee sets** | Championship down to forward, with the yardage measured off the model. |
| **Player profiles** | Tour, low, mid and senior swing speeds. |
| **Conditions** | Five lighting presets and adjustable wind. |
| **Hole card** | Par, stroke index, yardage, green size, elevation change, a rotated plan-view map, and a description generated from the geometry. |

Keyboard: `←` `→` change hole, `1`–`9` jump to a hole, `C` cycles cameras, `Space` hits a shot.
On a phone: drag to look, pinch to zoom, and use the compact bar above the hole strip.

## Putting it on a club's website

**Re-skin it.** Everything club-specific lives in **`branding.js`** — name, crest,
location, accent colour, the call-to-action button, the attribution line, and the
default view a visitor lands on. Nothing else needs touching. Pair it with a
`course-data.js` generated for that club (see `tools/`) and the same engine ships
as their product.

**Link to any view.** The URL carries the state, so "look at our 7th" is a link:

```
index.html?hole=7&cam=flyover&tee=1&light=golden
```

| Parameter | Values |
|---|---|
| `hole` | `1`–`18` |
| `cam` | `tee` `approach` `green` `flyover` `aerial` `free` |
| `tee` | `0` (back) upward |
| `light` | `morning` `midday` `afternoon` `golden` `overcast` |
| `quality` | `high` `fast` `auto` (default — picks `fast` on phones) |
| `embed` | `1` — strips the brand block for iframe use |
| `tour` | `1` — hands-free flyover of all 18, for a clubhouse screen |

The **Share view** button copies the current link to the clipboard.

**Embed it in a page.** It detects being framed automatically, but passing
`embed=1` is clearer:

```html
<iframe src="https://your-host/preview/index.html?embed=1&hole=1&cam=flyover"
        style="width:100%;aspect-ratio:16/9;border:0" loading="lazy"
        title="Interactive course preview"></iframe>
```

**Host it.** The whole thing is static — about 800 KB. Drag the folder onto
Netlify Drop, or push it to GitHub Pages or Cloudflare Pages. No server-side
anything.

## Where the model comes from

This is built on real data, not artistic impression.

**Routing and features — OpenStreetMap (ODbL).** Cog Hill's four courses are fully
surveyed in OSM. Course No. 4 was isolated by matching each `golf=hole` way tagged
`No.4`, then assigning every green, tee, bunker, fairway and hazard polygon to the
nearest No.4 centreline (and only when that centreline was closer than any of the
other three courses'). Par and stroke index come from the OSM tags.

**How closely it matches.** Ten of the eighteen modelled centrelines land within
two yards of the published card:

| Hole | Modelled | Card |
|---|---|---|
| 2 | 224 | 224 |
| 9 | 613 | 613 |
| 17 | 423 | 423 |
| 6 | 239 | 240 |
| 12 | 218 | 216 |
| 18 | 493 | 494 |

Two holes are meaningfully longer than their card yardage — the 7th (433 vs 396)
and the 16th (457 vs 418). Both are doglegs, and a centreline that follows the
corridor around a corner is legitimately longer than a yardage measured along the
intended line of play. The card in the app always shows the published number, so
this affects the 3D routing only.

**One open item.** The per-hole championship yardages used here total **7,472**,
which is what the app's scorecard shows. Cog Hill's championship total is commonly
quoted as 7,554. The 82-yard gap could not be reconciled without the club's own
card — worth confirming with them, and a good excuse to make contact.

The shorter tee sets are measured off the model and scaled so the back tee matches
the published figure.

**Terrain — USGS 3DEP.** A 128 × 128 grid of real 10 m elevation samples over the
property, roughly 175–225 m above sea level. On top of that the app sculpts the
things a DEM cannot see: built green pads with a crown and a slight tilt, dug
bunkers with a flashed lip, level tee pads, and pond basins.

**Ball flight.** Drag and Magnus lift integrated at 600 Hz using spin-ratio
coefficient fits, then an impulse-based bounce (normal restitution plus a
tangential friction impulse) and a rolling phase that follows the ground slope.
Launch conditions are Trackman PGA Tour averages. Carry distances come out within
a few yards across the bag:

| Club | Modelled carry | Trackman tour avg |
|---|---|---|
| Driver | 281 | 275 |
| 7 iron | 178 | 172 |
| 9 iron | 152 | 148 |
| Pitching wedge | 138 | 136 |

## How it is put together

Everything is hand-written; there is no 3D engine underneath.

```
index.html        UI shell, styling, and the whole HUD
course-data.js    generated — the 18-hole model (see "regenerating" below)
js/math.js        vectors, matrices, frustum, deterministic PRNG
js/gl.js          WebGL2 helpers: programs, meshes, textures, render targets
js/shaders.js     all GLSL — sky, turf, trees, water, grass, post-processing
js/field.js       surface classification + heightfield sculpting
js/terrain.js     terrain mesh generation
js/foliage.js     procedural trees, grass and course furniture
js/shot.js        ball flight, bounce and roll
js/app.js         renderer, scene assembly, cameras
js/ui.js          DOM wiring, hole map, labels, input
```

The interesting part is `field.js`. Course polygons are rasterised with Canvas2D
(free anti-aliasing, and canvas pixels stay origin-clean so the page works straight
off the filesystem), then each surface class is turned into a signed distance field
with an 8SSEDT transform. The renderer classifies every ground pixel from those
distances, which is what gives crisp fairway edges, green collars, bunker lips and
mowing stripes without a single image file.

Rendering is a shadow pass into two cascades, a main pass into an HDR buffer, then
bloom, ACES tonemapping and FXAA. Turf uses wrapped diffuse, an anisotropic sheen
along the mowing direction, and forward scattering so it glows when you look into
the sun. Detail noise is faded using screen-space derivatives, the same way a mip
chain would, so nothing aliases at distance.

## Regenerating the course data

`course-data.js` is generated, not hand-edited. The scripts that built it are in
**`tools/`** — see `tools/README.md`. They query the Overpass API and opentopodata
and need nothing but Python 3. The same pipeline will model any other course whose
holes are mapped in OSM.

## Honest limits

- This is a **visual preview, not a survey document**. Green contours, bunker
  depths, mounding and rough lines are plausible reconstructions driven by the real
  outlines and real terrain — they are not measured.
- Tree positions are procedurally scattered into the areas that are genuinely
  outside the mown corridor. They are the right species mix and density for a
  parkland course, but they are not individually surveyed trees.
- Clubhouse and outbuildings are extruded OSM footprints at estimated heights.
- Pin positions are green centres, not daily hole locations.

## Credits

Geometry © OpenStreetMap contributors, licensed ODbL. Elevation from the USGS
3D Elevation Program (public domain). Cog Hill Golf & Country Club is not
affiliated with this preview.
