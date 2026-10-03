# Regenerating course-data.js

These are the scripts that produced `../course-data.js`. They only need to be re-run
if the OpenStreetMap data changes or you want to model a different course.

Requires Python 3 and network access. No third-party packages.

## 1. Fetch the OSM geometry

Query the Overpass API for everything inside the club's bounding box and save the
responses next to these scripts as `golf_geom.json`, `water.json`, `woods.json` and
`built.json`. Cog Hill's bbox is `41.6640,-87.9680,41.6890,-87.9360`:

    [out:json][timeout:180];
    nwr["golf"](41.6640,-87.9680,41.6890,-87.9360);
    out geom;

(and the equivalent for `natural=water` / `waterway`, `natural=wood` /
`landuse=forest`, and `building` / `highway`).

Public Overpass instances rate-limit and time out under load; the mirror at
`overpass.kumi.systems` was the reliable one during this build.

## 2. Fetch the elevation grid

    python dem.py

Pulls a 128 x 128 grid of USGS 3DEP 10 m samples from opentopodata.org and writes
`dem.json`. It rate-limits itself to one request per second and resumes from a
partial file, so it takes about four minutes.

## 3. Build the model

    COURSE_OUT=..  python build_course.py

Isolates Course No. 4, projects everything into local metres, assembles the 18-hole
record and writes `course-data.js`. It prints the per-hole table so you can sanity
check the yardages against the published card before shipping.

## Adapting to another course

`build_course.py` keys off `golf=hole` ways whose `ref` looks like `"<n> No.4"`.
For a single-course club the refs are usually just `"1"`, `"2"`, … so `HOLE_RE` and
the `courses` grouping need adjusting, and `PUBLISHED` should be replaced with that
club's scorecard. Everything downstream is course-agnostic.

# Building other courses (any well-mapped U.S. course)

`build_any_course.py` generalises the steps above. List the course in
`courses.json` — by search name (`query`), by location (`near` + `nameRe`), or by
OSM id (`osm`: `"way/123"`) — then:

    pip install numpy tifffile imagecodecs pillow
    python build_any_course.py <id> [<id> ...]     # writes ../golf/courses/<id>.js
    python course_thumb.py ../golf/courses/<id>.js # the picker's map thumbnail
    python update_index.py                         # adds it to golf/courses/index.js

What it does:

- Finds the course outline (`leisure=golf_course`) with Nominatim, and pulls
  everything around it from the OSM API (`osm_fetch.py`) — no Overpass needed.
- Keeps the `golf=hole` ways inside the outline whose `ref` is a number
  (`holeRef` overrides the pattern), needs all 18, and refuses a property where
  two courses inside one outline share hole numbers.
- Pulls USGS 3DEP elevation from The National Map's image service: one grid over
  the property, plus a sub-metre patch over every green. 3DEP is lidar-derived
  wherever it has been flown, so the greens carry their surveyed contours and the
  game uses them as-is (see `Field.demSample` and `buildHeight`).
- Leaves `natural=scrub` out of the woods: on a links it is fescue and dune.

Courses that would not build from the public data at the time of writing:
Bethpage Black, TPC Sawgrass and Pacific Dunes (no separately named outline),
Pinehurst No. 2 (holes without numbers), Bandon Dunes and TPC Harding Park
(two courses inside one outline).
