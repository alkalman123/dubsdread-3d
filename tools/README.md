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
