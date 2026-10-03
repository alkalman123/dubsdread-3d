"""Scout OpenStreetMap for courses mapped well enough to play.

For each candidate name: find its leisure=golf_course outline, then count the
golf=hole ways inside it and how many carry a ref and a par. A course needs all
eighteen to be built without guesswork.
"""
import json, sys, time, urllib.request, urllib.parse

EPS = ['https://overpass-api.de/api/interpreter',
       'https://overpass.kumi.systems/api/interpreter',
       'https://overpass.private.coffee/api/interpreter']

def q(ql):
    for ep in EPS:
        for _ in range(3):
            try:
                req = urllib.request.Request(ep, data=urllib.parse.urlencode({'data': ql}).encode(),
                                             headers={'User-Agent': 'dubsdread-course-scout'})
                with urllib.request.urlopen(req, timeout=200) as r:
                    return json.load(r)
            except Exception as e:
                print('  retry', ep, e, file=sys.stderr); time.sleep(5)
    raise RuntimeError('overpass failed')

CANDS = sys.argv[1:] or [
    'Pebble Beach Golf Links', 'Spyglass Hill', 'Torrey Pines', 'TPC Sawgrass', 'Stadium Course',
    'Bethpage', 'Chambers Bay', 'Whistling Straits', 'Pinehurst', 'Harbour Town', 'Kiawah',
    'Bandon Dunes', 'Pacific Dunes', 'Erin Hills', 'Augusta National', 'Medinah', 'Harding Park',
    'Pasatiempo', 'Streamsong', 'Black Course', 'Ocean Course', 'Cog Hill',
]
out = []
for name in CANDS:
    try:
        r = q('[out:json][timeout:120];nwr["leisure"="golf_course"]["name"~"%s",i];out tags bb;' % name)
    except Exception as e:
        print(name, 'FAILED', e); continue
    for e in r['elements']:
        b = e.get('bounds')
        if not b: continue
        t = e.get('tags', {})
        bbox = (b['minlat'], b['minlon'], b['maxlat'], b['maxlon'])
        if (bbox[2] - bbox[0]) > 0.06 or (bbox[3] - bbox[1]) > 0.08:
            continue
        h = q('[out:json][timeout:120];way["golf"="hole"](%f,%f,%f,%f);out tags;' % bbox)
        hs = [x.get('tags', {}) for x in h['elements']]
        refs = sorted({x.get('ref', '?') for x in hs})
        rec = dict(query=name, id=f"{e['type']}/{e['id']}", name=t.get('name'), bbox=bbox,
                   holes=len(hs), withPar=sum(1 for x in hs if x.get('par')),
                   refs=refs[:60], website=t.get('website'), city=t.get('addr:city'),
                   state=t.get('addr:state'))
        print(json.dumps(rec)); out.append(rec)
        time.sleep(2)
    time.sleep(2)
json.dump(out, open('course-scout.json', 'w'), indent=1)
