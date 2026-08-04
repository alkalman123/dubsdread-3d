"""Fetch a real DEM grid over the Dubsdread footprint from opentopodata (USGS NED 10m)."""
import json, os, sys, time, urllib.request, urllib.error

D = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(D, 'dem.json')

# footprint (padded a little beyond the Dubsdread routing)
LAT_MIN, LAT_MAX = 41.6640, 41.6900
LON_MIN, LON_MAX = -87.9680, -87.9370
N = 128                                   # grid resolution per axis

lats = [LAT_MIN + (LAT_MAX - LAT_MIN) * i / (N - 1) for i in range(N)]
lons = [LON_MIN + (LON_MAX - LON_MIN) * j / (N - 1) for j in range(N)]

pts = [(la, lo) for la in lats for lo in lons]
print(f'{len(pts)} points, {len(pts)//100 + 1} requests', flush=True)

done = {}
if os.path.exists(OUT + '.partial'):
    done = {int(k): v for k, v in json.load(open(OUT + '.partial')).items()}
    print('resuming with', len(done), 'points', flush=True)

CHUNK = 100
URL = 'https://api.opentopodata.org/v1/ned10m?locations={}'

i = 0
while i < len(pts):
    idxs = [k for k in range(i, min(i + CHUNK, len(pts))) if k not in done]
    if not idxs:
        i += CHUNK
        continue
    loc = '|'.join(f'{pts[k][0]:.6f},{pts[k][1]:.6f}' for k in idxs)
    for attempt in range(6):
        try:
            with urllib.request.urlopen(URL.format(loc), timeout=60) as r:
                res = json.load(r)
            if res.get('status') != 'OK':
                raise RuntimeError(res.get('error', res.get('status')))
            for k, item in zip(idxs, res['results']):
                done[k] = item['elevation']
            break
        except Exception as ex:
            wait = 2 + attempt * 3
            print(f'  retry {attempt} at {i}: {ex} (sleep {wait})', flush=True)
            time.sleep(wait)
    else:
        print('GIVING UP at', i, flush=True)
        break
    i += CHUNK
    if (i // CHUNK) % 10 == 0:
        json.dump({str(k): v for k, v in done.items()}, open(OUT + '.partial', 'w'))
        print(f'  {len(done)}/{len(pts)}', flush=True)
    time.sleep(1.05)

grid = [[done.get(r * N + c) for c in range(N)] for r in range(N)]
missing = sum(1 for row in grid for v in row if v is None)
vals = [v for row in grid for v in row if v is not None]
print(f'done. missing={missing}  min={min(vals):.1f} max={max(vals):.1f} m', flush=True)
json.dump(dict(n=N, latMin=LAT_MIN, latMax=LAT_MAX, lonMin=LON_MIN, lonMax=LON_MAX,
               grid=grid), open(OUT, 'w'))
print('wrote', OUT, flush=True)
