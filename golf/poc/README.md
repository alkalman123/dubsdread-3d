# Realism &amp; play proof of concept

A proof of concept for two things the existing Dubsdread preview could become:
**a render that stops reading as a video game**, and **a course you can actually
play**. All eighteen holes, as a round, with a card.

Open **`../round.html`**. Same deal as the original: no build step, no server, no
downloads. `deploy/` (built by `tools/build_poc_site.py`) is the same thing
packaged for a static host. (`hole1.html` is a stub that redirects here — it was
the entry point when this covered one hole.)

## How it is put together

Nothing in `js/` was modified. The POC is an **overlay**: it loads the existing
engine and then replaces the pieces it is making a claim about, which keeps the
diff honest and lets both versions run off one copy of the course data.

```
poc/sky-model.js     solar position + a single-scattering atmosphere (plain JS)
poc/foliage-poc.js   leaf-card canopies and the procedural leaf atlas
poc/shaders-poc.js   all GLSL, rewritten — the file to read for the render work
poc/render-poc.js    frame graph: SSAO, cloud shadows, DOF, shafts, scar layer
poc/shot-poc.js      lies, strike quality, tree collision, wind profile, putting
poc/play.js          stroke play, caddie, cameras, scoring
poc/ui-poc.js        HUD, hole map, green book
poc/_smoke.html      dev harness: boots the renderer with no UI (not shipped)
```

`hole1.html` loads `js/*` first, then `poc/*`. It does **not** load `js/ui.js` —
`poc/ui-poc.js` takes that role, because the thing being driven is a round of
golf rather than a hole chooser.

---

## Rendering

### One atmosphere instead of five presets

The shipping preview lights the course from five hand-picked presets: an
azimuth, an elevation, and three colours chosen by eye. They look pleasant, but
they are not physical — two of them put the sun in the **northern** sky, which
cannot happen at 41°N — and because the sun colour, the sky gradient, the
ambient fill and the exposure are independent numbers, changing one means
re-balancing the other three by hand.

This replaces all of it with one model:

- **Sun position** from the NOAA/Meeus solar algorithm at the course's real
  latitude and longitude (41.6816, −87.9500 — straight out of `course-data.js`),
  including atmospheric refraction, which is the whole difference between "set"
  and "not set". June solstice noon comes out at 71.8° elevation, December at
  24.9°, and the sunrise/sunset times on the HUD are computed, not typed.
- **Sky radiance** from single-scattering Rayleigh + Mie with per-channel
  optical depth, ozone in the Chappuis band, a Kasten–Young air mass, and one
  multiple-scattering term. Blue saturates first because its extinction is
  larger; the sky reddens at a low sun because the *beam* has already lost its
  blue before it reaches the air you are looking at. Nobody authored the sunset.
- **Direct sun colour** is the same beam transmittance the sky is built from, so
  the light on the turf and the light in the sky cannot drift apart.
- **Exposure** is metered off a mid-grey card lit by beam plus sky, and **white
  balance** pulls a warm scene part of the way to neutral — never all the way,
  which is exactly why a photograph of golden hour still looks golden.

The same equations run in JS (`sky-model.js`) and GLSL (`shaders-poc.js`). The JS
side is what drives the exposure, the readout and the air density.

Two calibration constants earn their keep: `MIE_G = 0.50` and `MIE_SSA = 0.86`.
The usual 0.75–0.80 asymmetry puts far too much spectrally flat light within 20°
of the sun — which is where most of a golf scene's sky sits — and leaving the
single-scattering albedo at 1.0 is what turns a clear midday zenith grey.

### Clouds that cast shadows

The cloud field is defined on a **world-space plane** at 1500 m, not on a dome.
The sky shader and the ground shader each evaluate it where their own ray crosses
that plane, so a cloud you can see overhead is the cloud whose shadow is crossing
the fairway. Three taps spread over ~13 m give the sun's half-degree penumbra.

This is the single biggest change to how the scene reads. A golf hole under a
broken sky has light drifting across it; a uniformly lit fairway is the strongest
tell that you are looking at a render.

The deck is also treated as a **light source** — whatever it intercepts comes
back down as a broad grey glow. Without that, cloud-shadowed turf is lit by
clear-sky blue alone and reads cold and dead.

### Ambient occlusion

Twelve-tap hemisphere occlusion from the depth buffer at half resolution, blurred
depth-aware, applied to the **ambient term only**. It runs off the *previous*
frame's depth, which costs one texture read per sample instead of a second pass
over every triangle in the scene — a term this soft does not care about a frame
of latency. Contact darkening at trunk bases, in bunkers, around the collar of a
raised green, and under the ball.

### Depth of field, on real camera geometry

Circle of confusion from the thin-lens equation with a 24 mm sensor height, so
focal length and field of view are the same control, as they are on a camera.
f/2.8 on a long lens throws the background out; f/2.8 on a wide one barely does.
The half-resolution blur is composited back over the sharp image weighted by CoC,
so the in-focus band stays at full resolution. Focus follows the ball.

### Bunkers

Sand is raked in passes that follow the shape of the bunker, so the ripples run
parallel to its edge. The signed distance field *is* that shape, which makes a
sine of the distance the right ripple for free — and it is why they curve
correctly around every lobe of an eight-bunker complex instead of being a
straight-line pattern laid over the top.

On top of that: a crisp cut edge (a bunker is edged, and half a metre of
gradient read as sand fading into grass), a flashed face where sand thrown up
the far wall is brighter than the floor it came off, and a hard little lip
shadow where the turf overhangs — which is the strongest single cue that a
bunker is a hole in the ground rather than a light patch painted on one.

### Turf

- **Blade-scale grain** within a few metres: a high-frequency height field whose
  gradient tilts the normal, faded by pixel footprint so it never aliases. Mown
  turf used to be a smooth surface with a noise bump; at 2 m what the eye
  actually reads is the shading of individual clumps.
- **Grass on mown surfaces.** The original put blades only in the native areas
  outside the mown corridor, on the argument that mown turf is the shader's job.
  From a tee box that leaves the entire foreground — the part of the frame the
  eye is closest to and judges hardest — a flat green wash. Blades now go
  everywhere, at the real height of cut: 10 mm on greens, 26 on fairways, 85 in
  the first cut, knee-high in the fescue. Blade *width* scales with cut height,
  because a constant-width 2 cm blade is as wide as it is tall and renders as
  grit.
- **Two-lobe anisotropic sheen**: one tight lobe for the glint down a mowing
  stripe, one broad one for the sheen of the sward.
- **Poa patches** — a yellower, coarser grass invading the bent — so the surface
  varies in *hue*, not just brightness. A monoculture is what makes CG turf read
  as felt.
- **Dew** at dawn, burning off within an hour of the sun getting up.
- Double-cut greens, and a cart path at asphalt albedo rather than concrete.

### Trees — leaf cards

The blob canopy was the last thing holding the render back once the lighting was
right, and no amount of shading fixes it: a sphere shades as a sphere, so a crown
reads as one smooth mass with a bright top and a dark underside rather than as
thousands of leaves each catching the light at their own angle.

`foliage-poc.js` replaces the spheres with **cards**. The same lobe structure the
blobs described is kept — that shape was right — but each lobe is now covered in
quads laid tangent to its surface, each carrying a cluster of leaves in an alpha
texture. The texture is four variants drawn procedurally into a canvas at
startup (roughly 1,500 leaf paths in three size passes), so nothing is downloaded
and the page still runs off the filesystem. A tree is 100–175 cards.

Two details do most of the work:

- **Cards are lit by the lobe's outward normal, not the quad's.** A card lit by
  its own flat normal looks like what it is. Lit by the volume it sits on, a
  hundred of them integrate into something that reads as a crown. This is the
  whole trick behind card foliage.
- **The alpha cutoff loosens with distance.** Alpha-tested foliage sparkles once
  a leaf is smaller than a pixel — the test flips between frames and the canopy
  boils. Letting far crowns close into a solid mass is both stabler and closer to
  what a tree a hundred metres away looks like.

The shadow pass runs the same alpha test, because a solid quad casting a solid
shadow is worse than no cards at all: it puts hard rectangles on the fairway. The
distant impostors sample the same atlas, so a tree does not change species as it
crosses the impostor boundary.

Species colour is four distinct greens rather than one dark-to-light ramp,
because the variance between trees is what makes a wood read as a wood, and the
texture's own yellowing channel turns a scattering of leaves within each cluster.

### Two bugs the low-sun tests found

**Shadow cascades were centred past the player.** The original centres each
cascade at `lerp(camPos, camLook, 0.55)`. Looking down a hole that target is
250 m away, so the near cascade — 115 m across — ends up centred 140 m ahead, and
everything within about twenty metres of the camera falls outside the map. `pcf`
returns 1.0 off the edge, so the entire foreground was unconditionally lit: no
tree shadows anywhere near the player, which is exactly where they sell the
scene. Now centred on the camera and pushed forward by a fraction of the
cascade's own span.

**Aerial views turned to milk.** Using `skyRadiance()` as the haze colour is the
obvious thing and it is wrong for any ray not looking at the horizon: that
function already integrates the whole atmosphere, so multiplying it by a short
path's `1 - transmittance` double-counts. Looking down from a drone the view
direction is forced below the horizon, the air mass goes to fifty, and a
saturated horizon radiance is added on top of ground that is barely hazy. The
haze now uses the same source term the sky is built from — two phase functions
weighted by their scattering coefficients, lit by what is left of the beam —
scaled by the path actually travelled. At long range it converges to the sky, so
a distant tree line still dissolves into the horizon correctly.

### Sun shafts, and AgX

Crepuscular rays are a radial gather toward the sun's screen position, gated by
the depth buffer so only sky pixels emit, and weighted to fade out when the sun
is overhead or behind the camera.

Tonemapping is **AgX** rather than ACES. ACES's RRT skews saturated greens toward
yellow as they brighten, which is precisely the range a sunlit fairway occupies —
a large part of why the original reads as a game. The **Hold to compare** button
puts the original tonemap and grade back alongside every other feature off, so
the difference is one button rather than an argument.

> Note for anyone porting this: AgX's sigmoid lands in *display* space, so its
> result must not be gamma-encoded again afterwards. Doing so is what turns a
> correctly exposed frame into a pale, milky one.

### The scar layer

A 512² paint layer over the detail field that the **game** writes into: the club
takes a divot where it entered, a shot landing steeply on the green leaves a
pitch mark, a bunker shot leaves a scuff. The terrain shader reads it for albedo
(soil showing through), for a normal dent, and for wear. Cheap — one canvas,
re-uploaded only when something is added — and it means the hole carries a record
of how you played it.

---

## Playing the hole

The shipping preview has a shot *visualiser*: pick a club, click a target, watch
a tour-average shot fly. It demonstrates the ball-flight model well and it is not
a game. There is no skill input, the lie the ball finished in has no effect on
the next strike, the tree line the whole hole is framed by is not solid, and
there is no way to finish the hole because there is no putting.

### The swing

Two timed stages. A power needle sweeps to 112% and back — past 100% is an
overswing, available but it costs contact, which is the trade every golfer
actually makes. Then a face needle sweeps across a green band; an 8% dead zone
counts as flush, so timing is rewarded. Contact quality drives smash factor,
launch, spin (thin adds, fat kills) and start line; face error adds gear-effect
curvature on top. **Auto swing** restores the original deterministic behaviour
for anyone who just wants the visualiser.

On top of what the player controls there is dispersion they do not, scaled by
handicap: 0.85° of start-line scatter for a tour player, 3.1° for a senior.

### Lies

Each surface now has a strike model, not just a bounce model — ball-speed and
spin multipliers, added launch, a dispersion multiplier, and a **flyer** chance.
Light rough at 30% flyer risk is the classic reason a good player fears it: the
grass slides between face and ball, spin collapses, and the shot comes out hot.
A lofted club escapes a bad lie better than a long one, because it gets under
the ball — so a 5 iron out of the native area is the mistake it should be.

### Trees and the flagstick are solid

Trees near the hole are turned into an ellipsoid canopy plus a trunk cylinder in
a 24 m uniform grid; the flight integrator tests only the cell the ball is in. A
trunk is a rebound that goes almost anywhere; branches take most of the speed and
drop the ball. The flagstick has a 47 mm collision radius, so you can rattle it.
This is what makes the corridor — the thing the whole hole is framed by — matter.

### Wind and air

The number on the HUD is the wind at 10 m, where it is measured. A power-law
boundary-layer profile means a wedge held up into a breeze is hurt far more than
a punch under it, which is the most useful thing wind does to golf strategy. Air
density comes from temperature and the course's 180 m elevation, so the ball
carries further on a hot day. Each shot gets its own gust, so the same swing
twice is not the same shot.

### Putting

Stimpmeter physics. The USGA device releases a ball at 1.83 m/s and the green
speed in feet is how far it then rolls on the level, which fixes the rolling
deceleration exactly — a green speed is a measurement, not a feel setting.
Gravity along the surface carries the 5/7 factor for a sphere rolling without
slipping. The cup captures below a critical speed that falls off with entry
offset, and lips out just above it.

The ball rolls on the **real** green: the same sculpted height field the renderer
draws. Which means the **green book** is a measurement of the model, not an
illustration of it — contours at three-inch intervals by marching squares over
the height grid, arrows down the fall line, and a read solved by searching aim
and pace over the actual roll.

### Landing zones

Before you swing, the same flight model is run twenty-odd times for each of the
four skill levels, and the finishes are drawn on the hole map and broken down by
what they found. Because it is the *same* model the shot itself will use, the
trees, the wind profile, the lie and the roll-out are all already in it: the
pattern is the hole's own answer rather than an ellipse drawn on top of one.

A player misses in three ways at once — contact, effort and face angle — so all
three are sampled. Sampling only the start direction gives a pencil-thin pattern
that is long every time, which is not what a scorecard looks like.

It immediately says something true about the 1st that no yardage book does: from
the back tee a tour player's driver **runs through** the fairway into the bunkers
at 300-320, so only about a quarter of that pattern is in play, while a mid
handicap's 270 sits on it every time. The long hitter's problem here is not the
carry, it is that the fairway runs out.

Dispersion is calibrated against published shot-pattern data rather than picked
by feel: offline standard deviation is roughly 5-6% of carry for a tour player
and 9-11% for a mid handicap, which is 3 to 6 degrees once curvature is added.
The first values here were a third of that, which made every level's zone about
ten yards wide and quietly deleted the entire question of whether you can hold a
fairway.

### The caddie

Distance to the pin and to the front and back of the green along the line of
play. Recommended club. Carry needed to clear each bunker that is actually on
the line — the number a course guide exists to give you. And what the wind and
the elevation are worth, measured by **running the ball-flight model twice**
rather than by a rule of thumb, so a wedge into a breeze loses more than a driver
does and that falls out of the physics.

### The round

Eighteen holes of stroke play. Each hole ends with a card showing the shots and
the running total, then walks to the next tee; the strip along the bottom doubles
as the card at a glance, colouring each hole against par as it is played. The
full scorecard (`S`) is laid out the way a real one is — nine out, nine in,
totals — and the tee set is chosen once for the round rather than per hole.

Nothing in the play code is hole-specific: `Play` reads `App.holeData`, so the
lies, the tree colliders, the caddie and the green book all rebuild for whatever
hole is loaded. The hole description in the card panel is generated from the
geometry — dogleg direction from the centreline, elevation from the height field,
bunker count from the polygons — rather than written out.

### Hole transitions

The original hole change has a data race, and it is visible. `js/app.js` hands
the **live** `Field` in as the recycle target for the next one:

```js
const recycle = this.field && this.field.res === 832 ? this.field : {};
if (this.field) this.field.dispose();
this.field = new root.Field(C, cx, cz, fieldSize, 832, { recycle: recycle });
```

`Field.build()` then writes the new hole's signed-distance fields straight into
those arrays. Between the rebuild's two phases the renderer and the ball physics
are still reading `this.field`, so for a frame or more the ground is half one
hole and half the next — while `holeData` has already been swapped and
`detailMesh` still holds the previous hole's geometry. You get the old terrain
under the new hole's pin, with the surface classification changing underfoot.

`render-poc.js` double-buffers instead. The next field is built into a retired
`Field` that nothing is reading, and then hole number, hole data, field, meshes,
tree instances, props, scar layer and camera all swap inside one synchronous
block. The two buffers alternate, so the memory churn the recycling existed to
avoid is still avoided. On top of that the transition is covered by a short fade,
because the rebuild is a few hundred milliseconds of frozen frame and a
deliberate cut reads as walking to the next tee where an uncovered one reads as a
hang.

### Camera work

`Play` sits behind the ball down the line, `Follow` chases it along its actual
velocity — pulling back as apex grows — and `Putt` drops to eye level behind the
ball looking at the hole. The game switches between them on its own.

---

## What this is not

- Still a **visual preview, not a survey document**. Green contours, bunker
  depths and rough lines remain plausible reconstructions driven by real
  outlines and real terrain. The putting model is honest about the surface it is
  given; the surface is not measured.
- The clock is fixed to CDT (UTC−5). A shipped version would want a real
  timezone database, or to read the visitor's clock.
- Card foliage is a large step up from blobs but it is still a lobe of quads:
  there is no branch structure inside the crown, so looking up through a tree
  from beneath does not hold up. Real work here means growing branches and
  hanging the cards off them.
- The card count roughly quadrupled the canopy's alpha-tested pixel cost. On a
  GPU that is nothing; on a phone it wants a lower-density mesh at the low
  quality tier.
- SSAO uses the previous frame's depth, so a hard camera cut shows one frame of
  stale occlusion.
- A hole change still costs a few hundred milliseconds of frozen main thread —
  seven signed-distance transforms over an 832&sup2; grid plus a 384&sup2; terrain
  mesh. The fade covers it; moving the field build to a worker would remove it.
- Auto swing plays a flush strike every time and putts on the solved read, so it
  shoots well under par. That is the visualiser behaviour, not the game — the
  timed swing is the game.
- Long irons from bad lies are genuinely wild, which is realistic, but the
  variance is doing a lot of work that a real short game would otherwise absorb:
  there is no punch shot, no bump and run, no deliberate lay-up.

## Controls

| | |
|---|---|
| `Space` | swing — once for power, again for the face |
| `A` `D` / `←` `→` | aim |
| `[` `]` | club down / up |
| `C` | cycle camera |
| `P` | on the green: putt on the caddie's read |
| `R` | restart this hole from the tee |
| `N` / `↓` | next hole |
| `↑` | previous hole |
| `S` | scorecard |
| click | aim at a point, and pick the club that gets there |
| drag / scroll | orbit and zoom |
