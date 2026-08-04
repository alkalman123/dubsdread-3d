"""Build the Dubsdread course model consumed by the 3D viewer.

Coordinate system: metres, X = east, Z = -north  (so a top-down view with +X
right and -Z up has north up).  Origin = centroid of the No.4 routing.
"""
import json, math, os, re
from collections import defaultdict, Counter

D = os.path.dirname(os.path.abspath(__file__))
OUTDIR = os.environ.get('COURSE_OUT', D)
load = lambda n: json.load(open(os.path.join(D, n), encoding='utf-8'))['elements']

golf = load('golf_geom.json')
waterel = load('water.json')
woodel = load('woods.json')
builtel = load('built.json')

# ---------------------------------------------------------------- projection
HOLE_RE = re.compile(r'^\s*(\d+)\s+No\.(\d)\s*$')

def rings(e):
    out = []
    if e['type'] == 'way' and 'geometry' in e:
        out.append([(p['lat'], p['lon']) for p in e['geometry']])
    elif e['type'] == 'relation':
        for m in e.get('members', []):
            if m.get('role') in ('outer', '') and 'geometry' in m:
                out.append([(p['lat'], p['lon']) for p in m['geometry']])
    return [r for r in out if len(r) >= 2]

courses = defaultdict(dict)
for e in golf:
    t = e.get('tags', {})
    if t.get('golf') != 'hole':
        continue
    m = HOLE_RE.match(t.get('ref', ''))
    if m:
        courses[m.group(2)][int(m.group(1))] = e

dubs = courses['4']
allpts = [p for h in dubs.values() for p in rings(h)[0]]
LAT0 = sum(p[0] for p in allpts) / len(allpts)
LON0 = sum(p[1] for p in allpts) / len(allpts)
MLAT = 111132.92 - 559.82 * math.cos(2 * math.radians(LAT0)) + 1.175 * math.cos(4 * math.radians(LAT0))
MLON = 111412.84 * math.cos(math.radians(LAT0)) - 93.5 * math.cos(3 * math.radians(LAT0))
R2 = lambda v: round(v, 2)

def xz(p):                       # (lat,lon) -> (x east, z = -north)
    return ((p[1] - LON0) * MLON, -(p[0] - LAT0) * MLAT)

def ring_xz(r):
    return [xz(p) for p in r]

def centroid(rs):
    n = 0; sx = 0.0; sz = 0.0
    for r in rs:
        for p in r:
            sx += p[0]; sz += p[1]; n += 1
    return (sx / n, sz / n)

def plen(pl):
    return sum(math.dist(a, b) for a, b in zip(pl, pl[1:]))

def poly_area(r):
    a = 0.0
    for (x1, z1), (x2, z2) in zip(r, r[1:] + r[:1]):
        a += x1 * z2 - x2 * z1
    return abs(a) * 0.5

def seg_dist(p, a, b):
    ax, az = a; bx, bz = b; px, pz = p
    dx, dz = bx - ax, bz - az
    L2 = dx * dx + dz * dz
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (pz - az) * dz) / L2))
    return math.hypot(px - (ax + t * dx), pz - (az + t * dz)), t

def poly_dist(p, pl):
    return min(seg_dist(p, a, b)[0] for a, b in zip(pl, pl[1:]))

# ---------------------------------------------------------------- centerlines
centers = {}
for c, hs in courses.items():
    centers[c] = {n: ring_xz(rings(e)[0]) for n, e in hs.items()}
D4 = centers['4']

# Orient each centreline tee -> green using the nearest green polygon.
greens_all = [e for e in golf if e.get('tags', {}).get('golf') == 'green' and rings(e)]
green_cxz = [(centroid([ring_xz(r) for r in rings(e)]), e) for e in greens_all]

for n, pl in D4.items():
    a, b = pl[0], pl[-1]
    da = min(math.dist(a, gc) for gc, _ in green_cxz)
    db = min(math.dist(b, gc) for gc, _ in green_cxz)
    if da < db:
        D4[n] = pl[::-1]

def nearest_course(pt):
    best = ('?', 0, 1e18, 0.0)
    for c, hs in centers.items():
        for n, pl in hs.items():
            L = max(plen(pl), 1e-6); acc = 0.0
            for a, b in zip(pl, pl[1:]):
                d, t = seg_dist(pt, a, b)
                if d < best[2]:
                    best = (c, n, d, (acc + t * math.dist(a, b)) / L)
                acc += math.dist(a, b)
    return best

# ---------------------------------------------------------------- classify features
KEEP = {'green': 60, 'tee': 70, 'bunker': 90, 'fairway': 110,
        'water_hazard': 130, 'lateral_water_hazard': 130, 'cartpath': 90}
feats = defaultdict(list)
for e in golf:
    t = e.get('tags', {})
    k = t.get('golf')
    if k not in KEEP:
        continue
    rs = [ring_xz(r) for r in rings(e)]
    if not rs:
        continue
    c = centroid(rs)
    course, hole, dist, param = nearest_course(c)
    if course != '4' or dist > KEEP[k]:
        continue
    feats[k].append(dict(hole=hole, dist=dist, param=param, rings=rs, c=c,
                         area=max(poly_area(r) for r in rs), tags=t))

# --- greens: exactly one per hole, the one nearest the centreline's green end
greens = {}
for n, pl in D4.items():
    end = pl[-1]
    cand = [f for f in feats['green'] if math.dist(f['c'], end) < 70 and f['area'] > 250]
    if not cand:
        cand = [f for f in feats['green'] if math.dist(f['c'], end) < 120]
    greens[n] = min(cand, key=lambda f: math.dist(f['c'], end))

# Re-anchor the centreline's last point on the true green centre.
for n, pl in D4.items():
    pl[-1] = greens[n]['c']

# --- tees: near the start of the centreline, measured back along the hole
tees = defaultdict(list)
for f in feats['tee']:
    n = f['hole']
    start = D4[n][0]
    if math.dist(f['c'], start) > 130 or f['area'] < 25:
        continue
    tees[n].append(f)

# --- everything else keyed by hole
bunkers = defaultdict(list)
for f in feats['bunker']:
    if f['area'] < 12:
        continue
    bunkers[f['hole']].append(f)

fairways = defaultdict(list)
for f in feats['fairway']:
    if f['area'] < 600:
        continue
    fairways[f['hole']].append(f)

waters = defaultdict(list)
for k in ('water_hazard', 'lateral_water_hazard'):
    for f in feats[k]:
        waters[f['hole']].append(f)

paths = [f for f in feats['cartpath']]

# ---------------------------------------------------------------- ponds / woods / buildings
def collect(elements, pred, minarea=0.0, closed=True):
    out = []
    for e in elements:
        t = e.get('tags', {})
        if not pred(t):
            continue
        for r in rings(e):
            rr = ring_xz(r)
            if closed and len(rr) < 4:
                continue
            if poly_area(rr) < minarea:
                continue
            out.append(rr)
    return out

BOUND = 1400.0   # keep everything within 1.4 km of the routing centre
def inbounds(r):
    return any(abs(x) < BOUND and abs(z) < BOUND for x, z in r)

ponds = [r for r in collect(waterel, lambda t: t.get('natural') == 'water', 150) if inbounds(r)]
woods = [r for r in collect(woodel, lambda t: t.get('natural') in ('wood', 'scrub') or t.get('landuse') == 'forest', 400) if inbounds(r)]
buildings = [r for r in collect(builtel, lambda t: 'building' in t, 60) if inbounds(r)]
roads = [r for r in collect(builtel, lambda t: t.get('highway') in ('service', 'residential', 'unclassified', 'tertiary', 'secondary'), 0, closed=False) if inbounds(r)]

# other courses' playing surfaces, for background context
ctx_green, ctx_fw, ctx_bunker = [], [], []
for e in golf:
    t = e.get('tags', {})
    k = t.get('golf')
    if k not in ('green', 'fairway', 'bunker'):
        continue
    rs = [ring_xz(r) for r in rings(e)]
    if not rs:
        continue
    c = centroid(rs)
    course, hole, dist, _ = nearest_course(c)
    if course == '4' and dist <= KEEP[k]:
        continue
    if not inbounds(rs[0]):
        continue
    (ctx_green if k == 'green' else ctx_fw if k == 'fairway' else ctx_bunker).extend(rs)

# ---------------------------------------------------------------- per-hole records
PUBLISHED = {   # black/championship yardages, allgolfholes + club scorecard
    1: 458, 2: 224, 3: 443, 4: 462, 5: 498, 6: 240, 7: 396, 8: 379, 9: 613,
    10: 383, 11: 607, 12: 216, 13: 480, 14: 215, 15: 523, 16: 418, 17: 423, 18: 494,
}
HCP = {n: int(dubs[n]['tags']['handicap']) for n in dubs if dubs[n]['tags'].get('handicap')}
HCP[18] = 8      # the one value missing from OSM; 8 is the unused index
PAR = {n: int(dubs[n]['tags']['par']) for n in dubs if dubs[n]['tags'].get('par')}
PAR[18] = 4

TEE_SETS = ['Dubsdread', 'Championship', 'Blue', 'White', 'Gold', 'Red']
M2Y = 1.09361

def resample(pl, step=12.0):
    """Densify + smooth a centreline into a clean spine."""
    out = [pl[0]]
    for a, b in zip(pl, pl[1:]):
        d = math.dist(a, b)
        k = max(1, int(d / step))
        for i in range(1, k + 1):
            out.append((a[0] + (b[0] - a[0]) * i / k, a[1] + (b[1] - a[1]) * i / k))
    # chaikin smoothing, endpoints pinned
    for _ in range(3):
        sm = [out[0]]
        for a, b in zip(out, out[1:]):
            sm.append((a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25))
            sm.append((a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75))
        sm.append(out[-1])
        out = sm[::2] if len(sm) > 260 else sm
    return out

holes = []
for n in range(1, 19):
    spine = resample(D4[n])
    g = greens[n]
    gc = g['c']
    tlist = sorted(tees[n], key=lambda f: -math.dist(f['c'], gc))
    # measured yardage: tee centre -> green centre along the spine
    def measured(pt):
        # project tee onto spine, then walk the remaining spine length
        best = (1e18, 0, 0.0)
        for i, (a, b) in enumerate(zip(spine, spine[1:])):
            d, t = seg_dist(pt, a, b)
            if d < best[0]:
                best = (d, i, t)
        _, i, t = best
        a, b = spine[i], spine[i + 1]
        rest = math.dist((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t), b)
        rest += plen(spine[i + 1:])
        return (rest + best[0] * 0.0) * M2Y
    tee_out = []
    for i, f in enumerate(tlist[:len(TEE_SETS)]):
        tee_out.append(dict(name=TEE_SETS[i] if i < len(TEE_SETS) else f'Tee {i+1}',
                            x=R2(f['c'][0]), z=R2(f['c'][1]),
                            yards=int(round(measured(f['c'])))))
    # scale the back tee to the published championship number, keep relative spacing
    if tee_out:
        scale = PUBLISHED[n] / max(tee_out[0]['yards'], 1)
        for t in tee_out:
            t['yards'] = int(round(t['yards'] * scale))
        tee_out[0]['yards'] = PUBLISHED[n]

    ax, az = spine[0]
    bx, bz = gc
    holes.append(dict(
        num=n, par=PAR[n], hcp=HCP[n], yards=PUBLISHED[n],
        spine=[[R2(x), R2(z)] for x, z in spine],
        green=dict(c=[R2(gc[0]), R2(gc[1])], rings=[[[R2(x), R2(z)] for x, z in r] for r in g['rings']]),
        tees=tee_out,
        teeBoxes=[[[R2(x), R2(z)] for x, z in r] for f in tees[n] for r in f['rings']],
        fairways=[[[R2(x), R2(z)] for x, z in r] for f in fairways[n] for r in f['rings']],
        bunkers=[[[R2(x), R2(z)] for x, z in r] for f in bunkers[n] for r in f['rings']],
        waters=[[[R2(x), R2(z)] for x, z in r] for f in waters[n] for r in f['rings']],
        bearing=round(math.degrees(math.atan2(bx - ax, -(bz - az))), 1),
    ))

xs = [p[0] for h in holes for p in h['spine']]
zs = [p[1] for h in holes for p in h['spine']]
print('routing extent  X %.0f..%.0f  Z %.0f..%.0f' % (min(xs), max(xs), min(zs), max(zs)))

def rr(rs):
    return [[[R2(x), R2(z)] for x, z in r] for r in rs]

out = dict(
    meta=dict(
        club='Cog Hill Golf & Country Club',
        course='No. 4 — Dubsdread',
        city='Lemont, Illinois',
        architect='Dick Wilson & Joe Lee (1964) · restored by Rees Jones (2008)',
        par=sum(PAR[n] for n in range(1, 19)),
        yards=sum(PUBLISHED.values()),
        outPar=sum(PAR[n] for n in range(1, 10)),
        inPar=sum(PAR[n] for n in range(10, 19)),
        outYards=sum(PUBLISHED[n] for n in range(1, 10)),
        inYards=sum(PUBLISHED[n] for n in range(10, 19)),
        rating=76.6, slope=151,
        source='Geometry: OpenStreetMap (ODbL). Terrain: USGS 3DEP 10 m DEM.',
    ),
    origin=dict(lat0=LAT0, lon0=LON0, mlat=MLAT, mlon=MLON),
    holes=holes,
    ponds=rr(ponds), woods=rr(woods), buildings=rr(buildings),
    roads=rr(roads), paths=rr([r for f in paths for r in f['rings']]),
    ctx=dict(green=rr(ctx_green), fairway=rr(ctx_fw), bunker=rr(ctx_bunker)),
)

# --- attach DEM if present
dem_path = os.path.join(D, 'dem.json')
if os.path.exists(dem_path):
    dem = json.load(open(dem_path))
    N = dem['n']
    g = dem['grid']
    vals = [v for row in g for v in row if v is not None]
    fill = sum(vals) / len(vals)
    flat = [round((v if v is not None else fill), 2) for row in g for v in row]
    x0, z0 = xz((dem['latMin'], dem['lonMin']))
    x1, z1 = xz((dem['latMax'], dem['lonMax']))
    out['dem'] = dict(n=N, x0=R2(min(x0, x1)), x1=R2(max(x0, x1)),
                      z0=R2(min(z0, z1)), z1=R2(max(z0, z1)),
                      base=round(min(vals), 2), h=flat,
                      rowsNorthUp=True)
    print(f'DEM attached: {N}x{N}, {min(vals):.1f}..{max(vals):.1f} m')
else:
    print('!! no dem.json yet')

path = os.path.join(OUTDIR, 'course-data.js')
with open(path, 'w', encoding='utf-8') as f:
    f.write('// Cog Hill No.4 "Dubsdread" — geometry derived from OpenStreetMap (ODbL)\n')
    f.write('// and USGS 3DEP elevation. Generated file; do not hand-edit.\n')
    f.write('window.COURSE = ')
    json.dump(out, f, separators=(',', ':'))
    f.write(';\n')
print('wrote', path, os.path.getsize(path) // 1024, 'KB')

print('\n hole par hcp  yds  tees                       bunkers fw water')
for h in holes:
    ts = ' '.join(f"{t['name'][:4]}:{t['yards']}" for t in h['tees'])
    print(f"  {h['num']:>2}   {h['par']}  {h['hcp']:>2} {h['yards']:>4}  {ts:<40} {len(h['bunkers']):>2} {len(h['fairways']):>2} {len(h['waters']):>2}")
