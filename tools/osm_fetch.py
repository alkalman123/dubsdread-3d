"""OpenStreetMap without Overpass.

Overpass is the convenient way to query OSM, and the public instances throttle
hard — from a CI runner, often to nothing. These use the two services OSM runs
itself instead:

  Nominatim    find a course by name -> its OSM id and bounding box
  API v0.6     everything inside a small bounding box, in one request

and return elements in the same shape Overpass's `out geom` does (ways carry a
`geometry` list of {lat, lon}; relations carry members with geometry), so the
course builder does not care where they came from.
"""
import json, time, urllib.parse, urllib.request
import xml.etree.ElementTree as ET

UA = {'User-Agent': 'dubsdread-course-builder/1.0 (github.com/alkalman123/dubsdread-3d)'}


def _get(url, timeout=120, tries=4):
    last = None
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
                return r.read()
        except Exception as e:
            last = e
            time.sleep(3 + i * 5)
    raise RuntimeError('%s: %s' % (url[:120], last))


def nominatim(q, limit=8):
    """Search by name. Returns [{osm_type, osm_id, bbox:(s,w,n,e), name, cls, type}]."""
    url = 'https://nominatim.openstreetmap.org/search?' + urllib.parse.urlencode(
        dict(q=q, format='jsonv2', limit=limit, countrycodes='us'))
    time.sleep(1.1)                      # Nominatim's usage policy: one request a second
    out = []
    for r in json.loads(_get(url)):
        bb = r.get('boundingbox')
        out.append(dict(osm_type=r.get('osm_type'), osm_id=int(r.get('osm_id')), name=r.get('name'),
                        display=r.get('display_name'), cls=r.get('category') or r.get('class'),
                        type=r.get('type'),
                        bbox=(float(bb[0]), float(bb[2]), float(bb[1]), float(bb[3])) if bb else None))
    return out


def _parse(xml):
    root = ET.fromstring(xml)
    nodes = {}
    ways = {}
    rels = []
    for n in root.iter('node'):
        nodes[n.get('id')] = (float(n.get('lat')), float(n.get('lon')))
    for w in root.iter('way'):
        tags = {t.get('k'): t.get('v') for t in w.iter('tag')}
        refs = [nd.get('ref') for nd in w.iter('nd')]
        geom = [dict(lat=nodes[r][0], lon=nodes[r][1]) for r in refs if r in nodes]
        ways[w.get('id')] = dict(type='way', id=int(w.get('id')), tags=tags, geometry=geom)
    for r in root.iter('relation'):
        tags = {t.get('k'): t.get('v') for t in r.iter('tag')}
        mem = []
        for m in r.iter('member'):
            if m.get('type') == 'way' and m.get('ref') in ways:
                mem.append(dict(type='way', ref=int(m.get('ref')), role=m.get('role'),
                                geometry=ways[m.get('ref')]['geometry']))
        rels.append(dict(type='relation', id=int(r.get('id')), tags=tags, members=mem))
    return list(ways.values()) + rels


def full(osm_type, osm_id):
    """One way or relation with everything it needs for its geometry."""
    t = {'W': 'way', 'R': 'relation', 'way': 'way', 'relation': 'relation'}[osm_type]
    els = _parse(_get('https://api.openstreetmap.org/api/0.6/%s/%d/full' % (t, osm_id)))
    return [e for e in els if e['type'] == t and e['id'] == osm_id]


def _merge(chunks):
    """Union of several responses. Ways are complete in every response (the API
    returns all nodes of any way it includes); a relation that straddles boxes
    arrives with different members in each, so merge its members."""
    out, idx = [], {}
    for els in chunks:
        for el in els:
            k = (el['type'], el['id'])
            if k not in idx:
                idx[k] = el; out.append(el)
            elif el['type'] == 'relation':
                have = {m['ref'] for m in idx[k]['members']}
                idx[k]['members'] += [m for m in el['members'] if m['ref'] not in have]
    return out


def area(s, w, n, e, depth=0):
    """Everything in a bounding box (south, west, north, east).

    The API refuses boxes over 0.25 square degrees or 50,000 nodes; a golf
    course is far smaller than the first, but a course in a town can pass the
    second. Big boxes are split up front, and a refused one is split again."""
    big = (n - s) * (e - w) > 0.0009
    if not big:
        url = 'https://api.openstreetmap.org/api/0.6/map?bbox=%f,%f,%f,%f' % (w, s, e, n)
        try:
            return _parse(_get(url, timeout=180, tries=2 if depth < 3 else 4))
        except RuntimeError:
            if depth >= 3: raise
    ml, mo = (s + n) / 2, (w + e) / 2
    return _merge([area(*b, depth=depth + 1) for b in
                   ((s, w, ml, mo), (s, mo, ml, e), (ml, w, n, mo), (ml, mo, n, e))])
