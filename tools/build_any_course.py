"""Build a playable course file for any well-mapped course.

    python build_any_course.py <id> [<id> ...]      (ids from courses.json)

Generalises build_course.py, which was written for Cog Hill No. 4 alone:

  geometry   OpenStreetMap, via the Overpass API (ODbL — attribution is kept in
             the file's meta.source and shown in the game)
  terrain    USGS 3D Elevation Program (3DEP), via The National Map's elevation
             image service. 3DEP is the national airborne lidar survey; where it
             has flown, the service returns the 1 m lidar terrain model. The
             whole property comes down as one grid, and every green again as a
             fine patch (under a metre a sample), so the contours a putt rolls
             over are the surveyed ones.

The course is the set of golf=hole ways inside the course's own outline
(leisure=golf_course). Everything else — greens, tees, fairways, bunkers,
water — is assigned to the nearest hole, as in the original script.

Needs: numpy, tifffile (pip). Network: Overpass and elevation.nationalmap.gov.
"""
import io, json, math, os, re, sys, time, urllib.parse, urllib.request
from collections import defaultdict

import numpy as np
import tifffile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import osm_fetch

D = os.path.dirname(os.path.abspath(__file__))
OUT = os.environ.get('COURSE_OUT', os.path.join(D, '..', 'golf', 'courses'))
UA = {'User-Agent': 'dubsdread-course-builder (github.com/alkalman123/dubsdread-3d)'}
M2Y = 1.09361
R2 = lambda v: round(v, 2)

EPS = ['https://overpass-api.de/api/interpreter',
       'https://overpass.kumi.systems/api/interpreter',
       'https://overpass.private.coffee/api/interpreter']


def overpass(ql):
    last = None
    for attempt in range(4):
        for ep in EPS:
            try:
                req = urllib.request.Request(ep, data=urllib.parse.urlencode({'data': ql}).encode(), headers=UA)
                with urllib.request.urlopen(req, timeout=240) as r:
                    return json.load(r)['elements']
            except Exception as e:
                last = e
                print('   overpass retry', ep, e, flush=True)
                time.sleep(4 + attempt * 6)
    raise RuntimeError('overpass failed: %s' % last)


def rings(e):
    out = []
    if e['type'] == 'way' and 'geometry' in e:
        out.append([(p['lat'], p['lon']) for p in e['geometry']])
    elif e['type'] == 'relation':
        for m in e.get('members', []):
            if m.get('role') in ('outer', '') and 'geometry' in m:
                out.append([(p['lat'], p['lon']) for p in m['geometry']])
    return [r for r in out if len(r) >= 2]


def stitch(rs):
    """Join open outer-ring segments of a multipolygon into closed rings."""
    rs = [list(r) for r in rs]
    out = []
    while rs:
        cur = rs.pop(0)
        changed = True
        while changed and cur[0] != cur[-1]:
            changed = False
            for i, r in enumerate(rs):
                if r[0] == cur[-1]: cur += r[1:]
                elif r[-1] == cur[-1]: cur += r[::-1][1:]
                elif r[-1] == cur[0]: cur = r + cur[1:]
                elif r[0] == cur[0]: cur = r[::-1] + cur[1:]
                else: continue
                rs.pop(i); changed = True; break
        out.append(cur)
    return out


def pip(pt, ring):
    x, y = pt; inside = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / ((y2 - y1) or 1e-12) + x1:
            inside = not inside
    return inside


def plen(pl): return sum(math.dist(a, b) for a, b in zip(pl, pl[1:]))


def poly_area(r):
    a = 0.0
    for (x1, z1), (x2, z2) in zip(r, r[1:] + r[:1]): a += x1 * z2 - x2 * z1
    return abs(a) * 0.5


def seg_dist(p, a, b):
    ax, az = a; bx, bz = b; px, pz = p
    dx, dz = bx - ax, bz - az
    L2 = dx * dx + dz * dz
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (pz - az) * dz) / L2))
    return math.hypot(px - (ax + t * dx), pz - (az + t * dz)), t


def centroid(rs):
    pts = [p for r in rs for p in r]
    return (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))


def resample(pl, step=12.0):
    out = [pl[0]]
    for a, b in zip(pl, pl[1:]):
        k = max(1, int(math.dist(a, b) / step))
        for i in range(1, k + 1):
            out.append((a[0] + (b[0] - a[0]) * i / k, a[1] + (b[1] - a[1]) * i / k))
    for _ in range(3):
        sm = [out[0]]
        for a, b in zip(out, out[1:]):
            sm.append((a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25))
            sm.append((a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75))
        sm.append(out[-1])
        out = sm[::2] if len(sm) > 260 else sm
    return out


# ------------------------------------------------------------------ 3DEP
DEP = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage'


def dep_grid(lat0, lon0, lat1, lon1, nx, ny):
    """Elevation (m) on an ny x nx grid, row 0 = north. Lidar where flown."""
    q = dict(bbox='%f,%f,%f,%f' % (lon0, lat0, lon1, lat1), bboxSR=4326, imageSR=4326,
             size='%d,%d' % (nx, ny), format='tiff', pixelType='F32',
             noDataInterpretation='esriNoDataMatchAny', interpolation='RSP_BilinearInterpolation',
             f='image')
    url = DEP + '?' + urllib.parse.urlencode(q)
    for attempt in range(6):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=180) as r:
                data = r.read()
            a = tifffile.imread(io.BytesIO(data)).astype(np.float32)
            if a.ndim == 3: a = a[..., 0]
            bad = ~np.isfinite(a) | (a < -500) | (a > 9000)
            if bad.all(): raise RuntimeError('all nodata')
            if bad.any(): a[bad] = float(np.median(a[~bad]))
            return a
        except Exception as e:
            print('   3dep retry', e, flush=True); time.sleep(5 + attempt * 5)
    raise RuntimeError('3DEP failed')


# ------------------------------------------------------------------ build
def build(cfg):
    cid = cfg['id']
    print('==', cid, flush=True)
    if cfg.get('osm'):
        t, oid = cfg['osm'].split('/')
    else:
        hits = [h for h in osm_fetch.nominatim(cfg['query']) if h['type'] == 'golf_course'
                and h['osm_type'] in ('way', 'relation')]
        if not hits: raise RuntimeError('no golf_course found for "%s"' % cfg['query'])
        t, oid = hits[0]['osm_type'], hits[0]['osm_id']
        print('   found %s/%s %s' % (t, oid, hits[0]['display'][:90]), flush=True)
    bnd = osm_fetch.full(t, int(oid))
    outline = stitch([r for e in bnd for r in rings(e)])
    outline = [r for r in outline if len(r) > 3]
    if not outline: raise RuntimeError('no outline for ' + cfg['osm'])
    lats = [p[0] for r in outline for p in r]; lons = [p[1] for r in outline for p in r]
    pad = 0.0045
    bb = (min(lats) - pad, min(lons) - pad, max(lats) + pad, max(lons) + pad)
    bbs = '%f,%f,%f,%f' % bb

    allel = osm_fetch.area(*bb)
    print('   %d OSM elements in the box' % len(allel), flush=True)
    T = lambda e: e.get('tags', {})
    golf = [e for e in allel if 'golf' in T(e)]
    water = [e for e in allel if T(e).get('natural') == 'water' or T(e).get('waterway') in ('riverbank', 'pond')]
    woods = [e for e in allel if T(e).get('natural') in ('wood', 'scrub') or T(e).get('landuse') == 'forest']
    built = [e for e in allel if 'building' in T(e) or T(e).get('highway') in
             ('service', 'residential', 'unclassified', 'tertiary', 'secondary', 'primary')]

    inside = lambda ll: any(pip((ll[1], ll[0]), [(p[1], p[0]) for p in r]) for r in outline)

    # ---- the holes: numbered golf=hole ways inside this course's outline
    ref_re = re.compile(cfg.get('holeRef', r'^\s*(\d{1,2})\s*$'))
    holes_osm = {}
    dup = {}
    for e in golf:
        tg = e.get('tags', {})
        if tg.get('golf') != 'hole': continue
        rs = rings(e)
        if not rs: continue
        r0 = rs[0]
        mid = r0[len(r0) // 2]
        if not (inside(mid) or inside(r0[0]) or inside(r0[-1])): continue
        m = ref_re.match(tg.get('ref', ''))
        if not m: continue
        n = int(m.group(1))
        if 1 <= n <= 18:
            dup[n] = dup.get(n, 0) + 1
            if n not in holes_osm or plen(r0) > plen(rings(holes_osm[n])[0]):
                holes_osm[n] = e
    missing = [n for n in range(1, 19) if n not in holes_osm]
    if missing: raise RuntimeError('%s: holes missing %s' % (cid, missing))
    twice = [n for n, k in dup.items() if k > 1]
    if twice and not cfg.get('holeRef'):
        # two courses inside one outline, numbered alike: no safe way to tell them apart
        raise RuntimeError('%s: holes %s appear more than once (two courses in one outline?)' % (cid, twice))

    pts = [p for e in holes_osm.values() for p in rings(e)[0]]
    LAT0 = sum(p[0] for p in pts) / len(pts); LON0 = sum(p[1] for p in pts) / len(pts)
    MLAT = 111132.92 - 559.82 * math.cos(2 * math.radians(LAT0)) + 1.175 * math.cos(4 * math.radians(LAT0))
    MLON = 111412.84 * math.cos(math.radians(LAT0)) - 93.5 * math.cos(3 * math.radians(LAT0))
    xz = lambda p: ((p[1] - LON0) * MLON, -(p[0] - LAT0) * MLAT)
    ring_xz = lambda r: [xz(p) for p in r]

    center = {n: ring_xz(rings(e)[0]) for n, e in holes_osm.items()}
    greens_all = [(centroid([ring_xz(r) for r in rings(e)]), e) for e in golf
                  if e.get('tags', {}).get('golf') == 'green' and rings(e)]
    for n, pl in center.items():
        da = min(math.dist(pl[0], g) for g, _ in greens_all)
        db = min(math.dist(pl[-1], g) for g, _ in greens_all)
        if da < db: center[n] = pl[::-1]

    def nearest_hole(pt):
        best = (0, 1e18)
        for n, pl in center.items():
            for a, b in zip(pl, pl[1:]):
                d, _ = seg_dist(pt, a, b)
                if d < best[1]: best = (n, d)
        return best

    KEEP = {'green': 60, 'tee': 70, 'bunker': 90, 'fairway': 110,
            'water_hazard': 130, 'lateral_water_hazard': 130, 'cartpath': 90}
    feats = defaultdict(list); ctx = defaultdict(list)
    for e in golf:
        tg = e.get('tags', {}); k = tg.get('golf')
        if k not in KEEP: continue
        rs = [ring_xz(r) for r in rings(e)]
        if not rs: continue
        c = centroid(rs)
        n, d = nearest_hole(c)
        mine = d <= KEEP[k] and inside((LAT0 - c[1] / MLAT, LON0 + c[0] / MLON))
        if mine:
            feats[k].append(dict(hole=n, rings=rs, c=c, area=max(poly_area(r) for r in rs) if len(rs[0]) > 2 else 0))
        elif k in ('green', 'fairway', 'bunker'):
            ctx[k].extend(rs)

    greens = {}
    for n, pl in center.items():
        end = pl[-1]
        cand = [f for f in feats['green'] if math.dist(f['c'], end) < 70 and f['area'] > 150] or \
               [f for f in feats['green'] if math.dist(f['c'], end) < 120]
        if not cand: raise RuntimeError('%s: no green for hole %d' % (cid, n))
        greens[n] = min(cand, key=lambda f: math.dist(f['c'], end))
        pl[-1] = greens[n]['c']

    tees = defaultdict(list)
    for f in feats['tee']:
        if math.dist(f['c'], center[f['hole']][0]) <= 130 and f['area'] >= 15: tees[f['hole']].append(f)
    def per(k, minA):
        d = defaultdict(list)
        for f in feats[k]:
            if f['area'] >= minA: d[f['hole']].append(f)
        return d
    bunkers = per('bunker', 8); fairways = per('fairway', 400)
    waters = defaultdict(list)
    for k in ('water_hazard', 'lateral_water_hazard'):
        for f in feats[k]: waters[f['hole']].append(f)

    def collect(els, pred, minarea=0.0, closed=True):
        out = []
        for e in els:
            tg = e.get('tags', {})
            if not pred(tg): continue
            for r in rings(e):
                rr = ring_xz(r)
                if closed and (len(rr) < 4 or poly_area(rr) < minarea): continue
                if any(abs(x) < 1600 and abs(z) < 1600 for x, z in rr): out.append(rr)
        return out
    ponds = collect(water, lambda t: t.get('natural') == 'water' or t.get('waterway') in ('riverbank', 'pond'), 120)
    wood = collect(woods, lambda t: True, 300)
    buildings = collect(built, lambda t: 'building' in t, 40)
    roads = collect(built, lambda t: 'highway' in t, 0, closed=False)
    paths = [r for f in feats['cartpath'] for r in f['rings']]

    tee_names = cfg.get('tees', ['Championship', 'Back', 'Middle', 'Forward', 'Front', 'Junior'])
    published = {int(k): v for k, v in cfg.get('yards', {}).items()}
    holes = []
    for n in range(1, 19):
        tg = holes_osm[n]['tags']
        spine = resample(center[n])
        gc = greens[n]['c']

        def measured(pt):
            best = (1e18, 0, 0.0)
            for i, (a, b) in enumerate(zip(spine, spine[1:])):
                d, t = seg_dist(pt, a, b)
                if d < best[0]: best = (d, i, t)
            _, i, t = best
            a, b = spine[i], spine[i + 1]
            return (math.dist((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t), b) + plen(spine[i + 1:])) * M2Y
        tl = sorted(tees[n], key=lambda f: -math.dist(f['c'], gc))
        if not tl:   # no mapped tee: the hole line starts on one
            tl = [dict(c=spine[0], rings=[])]
        tee_out = [dict(name=tee_names[i] if i < len(tee_names) else 'Tee %d' % (i + 1),
                        x=R2(f['c'][0]), z=R2(f['c'][1]), yards=int(round(measured(f['c']))))
                   for i, f in enumerate(tl[:len(tee_names)])]
        yards = published.get(n) or tee_out[0]['yards']
        if published.get(n):
            s = published[n] / max(tee_out[0]['yards'], 1)
            for tt in tee_out: tt['yards'] = int(round(tt['yards'] * s))
            tee_out[0]['yards'] = published[n]
        par = int(re.sub(r'\D', '', tg.get('par', '')) or (3 if yards < 250 else 4 if yards < 470 else 5))
        hcp = int(re.sub(r'\D', '', tg.get('handicap', '')) or 0)
        ax, az = spine[0]; bx, bz = gc
        holes.append(dict(
            num=n, par=par, hcp=hcp, yards=yards,
            spine=[[R2(x), R2(z)] for x, z in spine],
            green=dict(c=[R2(gc[0]), R2(gc[1])], rings=[[[R2(x), R2(z)] for x, z in r] for r in greens[n]['rings']]),
            tees=tee_out,
            teeBoxes=[[[R2(x), R2(z)] for x, z in r] for f in tees[n] for r in f['rings']],
            fairways=[[[R2(x), R2(z)] for x, z in r] for f in fairways[n] for r in f['rings']],
            bunkers=[[[R2(x), R2(z)] for x, z in r] for f in bunkers[n] for r in f['rings']],
            waters=[[[R2(x), R2(z)] for x, z in r] for f in waters[n] for r in f['rings']],
            bearing=round(math.degrees(math.atan2(bx - ax, -(bz - az))), 1)))
    # stroke index: fill any the map is missing with the unused numbers, longest first
    used = {h['hcp'] for h in holes if h['hcp']}
    free = [i for i in range(1, 19) if i not in used]
    for h in sorted([h for h in holes if not h['hcp']], key=lambda h: -h['yards']):
        h['hcp'] = free.pop(0) if free else 18

    rr = lambda rs: [[[R2(x), R2(z)] for x, z in r] for r in rs]
    par = sum(h['par'] for h in holes)
    out = dict(
        meta=dict(club=cfg['club'], course=cfg['course'], city=cfg['city'],
                  architect=cfg.get('architect', ''), par=par, yards=sum(h['yards'] for h in holes),
                  outPar=sum(h['par'] for h in holes[:9]), inPar=sum(h['par'] for h in holes[9:]),
                  outYards=sum(h['yards'] for h in holes[:9]), inYards=sum(h['yards'] for h in holes[9:]),
                  rating=cfg.get('rating'), slope=cfg.get('slope'), tz=cfg.get('tz', -5),
                  source='Geometry: © OpenStreetMap contributors (ODbL). Terrain: USGS 3D Elevation Program (lidar).'),
        origin=dict(lat0=LAT0, lon0=LON0, mlat=MLAT, mlon=MLON),
        holes=holes, ponds=rr(ponds), woods=rr(wood), buildings=rr(buildings),
        roads=rr(roads), paths=rr(paths),
        ctx=dict(green=rr(ctx['green']), fairway=rr(ctx['fairway']), bunker=rr(ctx['bunker'])),
    )

    # ---- terrain: the property, then each green fine
    xs = [p[0] for h in holes for p in h['spine']]; zs = [p[1] for h in holes for p in h['spine']]
    m = 450
    X0, X1, Z0, Z1 = min(xs) - m, max(xs) + m, min(zs) - m, max(zs) + m
    lat_n, lat_s = LAT0 - Z0 / MLAT, LAT0 - Z1 / MLAT
    lon_w, lon_e = LON0 + X0 / MLON, LON0 + X1 / MLON
    N = 256
    g = dep_grid(lat_s, lon_w, lat_n, lon_e, N, N)
    base = float(g.min())
    out['dem'] = dict(n=N, x0=R2(X0), x1=R2(X1), z0=R2(Z0), z1=R2(Z1), base=round(base, 2),
                      h=[round(float(v), 2) for v in g.flatten()], rowsNorthUp=True, lidar=True)
    patches = []
    for h in holes:
        r = [p for ring in h['green']['rings'] for p in ring]
        gx0, gx1 = min(p[0] for p in r) - 8, max(p[0] for p in r) + 8
        gz0, gz1 = min(p[1] for p in r) - 8, max(p[1] for p in r) + 8
        nx = int(min(96, max(24, (gx1 - gx0) / 0.7))); nz = int(min(96, max(24, (gz1 - gz0) / 0.7)))
        pg = dep_grid(LAT0 - gz1 / MLAT, LON0 + gx0 / MLON, LAT0 - gz0 / MLAT, LON0 + gx1 / MLON, nx, nz)
        patches.append(dict(hole=h['num'], x0=R2(gx0), x1=R2(gx1), z0=R2(gz0), z1=R2(gz1), nx=nx, nz=nz,
                            h=[round(float(v), 3) for v in pg.flatten()]))
        time.sleep(0.5)
    out['dem']['patches'] = patches
    print('   terrain %.1f..%.1f m, %d green patches' % (g.min(), g.max(), len(patches)), flush=True)

    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, cid + '.js')
    with open(path, 'w', encoding='utf-8') as f:
        f.write('// %s — %s. Geometry © OpenStreetMap contributors (ODbL);\n' % (cfg['club'], cfg['course']))
        f.write('// terrain USGS 3DEP. Generated by tools/build_any_course.py; do not hand-edit.\n')
        f.write('window.COURSE = ')
        json.dump(out, f, separators=(',', ':'))
        f.write(';\n')
    print('   wrote %s (%d KB), par %d, %d yards' % (path, os.path.getsize(path) // 1024, par, out['meta']['yards']), flush=True)
    for h in holes:
        print('   %2d par %d hcp %2d %4d yd  tees %d bunkers %d fairways %d' % (
            h['num'], h['par'], h['hcp'], h['yards'], len(h['tees']), len(h['bunkers']), len(h['fairways'])))
    return dict(id=cid, file='courses/%s.js' % cid, club=cfg['club'], course=cfg['course'], city=cfg['city'],
                par=par, yards=out['meta']['yards'], holes=18, tz=cfg.get('tz', -5), blurb=cfg.get('blurb', ''))


if __name__ == '__main__':
    cfgs = {c['id']: c for c in json.load(open(os.path.join(D, 'courses.json')))}
    ids = sys.argv[1:] or list(cfgs)
    done = []
    for i in ids:
        try:
            done.append(build(cfgs[i]))
        except Exception as e:
            print('!! %s failed: %s' % (i, e), flush=True)
    json.dump(done, open(os.path.join(OUT, 'built.json'), 'w'), indent=1)
