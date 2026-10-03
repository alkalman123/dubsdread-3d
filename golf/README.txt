Dubsdread — Cog Hill No. 4
==========================

Static site. No build step, no server, nothing fetched at runtime.

  index.html     the round, in full 3D (WebGL 2) — desktop and phone layouts
  flat.html      the same round drawn in software, for browsers without WebGL 2;
                 index.html sends those browsers here by itself
  webgl.html     old address; forwards to index.html
  check.html     what this browser can do, probe by probe
  preview.html   the original 18-hole preview, unchanged, for comparison

Where it lives
--------------
https://alkalman123.github.io/dubsdread-3d/

GitHub Pages, published by .github/workflows/deploy-crux-pages.yml whenever
this folder changes on master. Add ?hole=2 (or any 1-18) to start on that hole,
and ?tee=1 for a forward tee.

On an iPhone
------------
Open the link in Safari, then Share -> Add to Home Screen. It opens full
screen from the icon like an app. On a phone the side panels give way to a
status rail across the top and a thumb bar along the bottom: pick a club from
the row of chips, aim with the arrows either side of the big button (or tap
the spot on the course you want), and tap the big button to start and stop
the needle. On the green it becomes the putter: one tap starts the needle, the
second stops it, and the green mark is the pace the caddie reads. View, Map,
Zones and Card are underneath; More opens everything else — every hole, the
conditions, the rendering settings — as a sheet.

Graphics pick themselves: a phone gets a tier built for it (shadows, HDR light
and bloom at 1.5x resolution), a computer starts at "fast", and either one
steps down by itself if it cannot hold about 24 frames a second.

If it says WebGL 2 is required
------------------------------
There is a build that does not need a GPU at all: flat.html, and the home
page sends you there automatically. It draws the course in perspective from behind the ball
— projected, shaded and depth-sorted in JavaScript onto a 2D canvas, with no
WebGL anywhere. Same course, same ball flight, caddie, dispersion zones and
putting. Press V, or use the View buttons, to swap between the down-the-line
view and the top-down hole map.

It sizes its own grid to hold a frame rate, so it stays playable on whatever
it finds itself on. If your browser cannot do WebGL 2, play that one; nothing
below is required.

To fix the 3D build instead:
Usually the browser can do it and is refusing, not missing it. The page now
asks for the context four different ways before giving up — a machine that
refuses only the "high performance GPU" request now gets one on the second
try — and if all four fail it tells you which of the two cases you are in and
what to change. The usual fix is one switch:

  Chrome / Edge   chrome://settings/system -> graphics acceleration ON, restart
  blocklisted GPU chrome://flags/#ignore-gpu-blocklist -> Enabled, restart
  Firefox         about:config -> webgl.force-enabled = true, restart
  Brave           Shields -> Fingerprinting -> Standard for this site

chrome://gpu shows what the browser thinks it can do; the WebGL2 row there
says hardware, software, or disabled.

If the 3D area is blank or white
--------------------------------
The renderer wants floating-point render targets, and not every GPU or browser
exposes them. It now detects that and falls back automatically, telling you on
screen which features it dropped.

It also checks its own output: a moment after the first frames it reads back
what actually reached the screen, and if the picture came out empty it drops to
the simplest render path by itself. Anything that goes wrong inside the frame —
a driver fault, a pass the GPU refuses — is reported in a panel at the top of
the screen instead of failing silently, which is what a blank canvas under a
working HUD used to mean.

If something still will not draw, add ?safe=1 to the URL for the simplest path
any WebGL2 device can run:

  index.html?safe=1

If you get a message at the top of the screen, send it along — it names the
exact thing that failed.

If it renders and then freezes, or goes black
--------------------------------------------
That is the graphics driver being reset, not the page crashing. Windows resets
a GPU that has not answered for about two seconds, and a heavy frame on an
integrated chip can reach that. It never looks like "too slow" — it looks like
a frozen picture, or a black canvas with a HUD that still responds.

There are four quality tiers now, not two, and the bottom two are far lighter
than anything that shipped before:

  high   full: shadows at 2048 in two cascades, occlusion, depth of field,
         sun shafts, ~37,000 grass blades
  fast   as high without depth of field, ~13,000 blades
  low    one 1024 shadow cascade, no occlusion, no depth of field, no shafts,
         ~3,800 blades, rendered at 80% and upscaled
  mobile phones: one 1024 shadow cascade, HDR and bloom, no occlusion, depth
         of field or shafts, 1.5x resolution, ~5,000 blades
  min    no shadows, no grass, no post-processing, rendered at 65%

The tier is chosen from what the driver reports. Only hardware known to take it
starts higher than "low", so an integrated Intel part, or a browser that hides
its renderer, starts low by default. Force one with ?q=low, ?q=min, ?q=fast or
?q=high, or use the Min/Low/Fast/High buttons in the Rendering panel.

Two things happen automatically: a run of frames over 120 ms steps the tier
down before the driver gets anywhere near giving up, and if the context is lost
anyway the page reloads one tier lower rather than asking you to reload it
yourself.

Sharing it
----------
Send the plain URL and people land on the 1st tee, at whatever tier their
machine can hold.

To send someone a specific shot, use the deep links below — the address bar keeps
the hole you are on, so you can just copy it.

Locally, opening index.html by double-clicking works too: every texture is
generated procedurally and the canvas stays origin-clean, so it runs off the
filesystem. If your browser blocks local files, serve the folder:
  python3 -m http.server 8099

Controls
--------
  Space         swing — once to set the power, again to set the face
  A / D         aim
  [ / ]         club down / up
  C             cycle camera
  P             on the green, putt on the caddie's read
  N / down      next hole          up   previous hole
  S             scorecard          R    restart this hole from the tee
  click         aim at a point; the club that reaches it is selected
  drag, scroll  orbit and zoom

Worth trying
------------
  Rendering -> "Hold to compare"   the original shading, for one button press
  Conditions -> Time               05:00 to 22:00, real solar position
  Conditions -> Cloud              watch the shadows cross the fairway
  Rendering -> Aperture            f/1.8 to f/22
  Green book tab                   contours off the surface the ball rolls on

Deep links
----------
  index.html?hole=7&t=1190&cover=30&wind=6&q=fast&cam=play&f=2.8

  hole   1-18                tee   0 (back) upward
  t      local time in minutes (1190 = 19:50)
  cover  cloud cover, 0-100
  haze   turbidity x10, 10-70
  wind   mph at 10 m, 0-16    wdir  degrees
  f      aperture             q     min | low | fast | high
  cam    play | follow | putt | green | flyover | aerial | free

See poc/README.md for what changed and why.
