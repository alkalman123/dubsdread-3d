"""Drop polygon rings that do not close.

A water or wood area mapped as a multipolygon arrives as several open member
ways. Filled one by one, each is closed with a straight line from its last
point back to its first — across whatever land lies between — so a lake
becomes a triangle covering half a course. The builder now stitches members
together; this cleans files built before it did, by keeping only rings whose
ends meet.
"""
import json, math, sys

def load(path):
    s = open(path, encoding='utf-8').read()
    i = s.index('window.COURSE = ')
    return s[:i], json.loads(s[s.index('{', i):s.rindex('}') + 1])

def closed(r):
    return len(r) >= 4 and math.dist(r[0], r[-1]) < 1.0

for path in sys.argv[1:]:
    head, C = load(path)
    n0 = sum(len(C.get(k, [])) for k in ('ponds', 'woods'))
    for k in ('ponds', 'woods', 'buildings'):
        C[k] = [r for r in C.get(k, []) if closed(r)]
    for h in C['holes']:
        for k in ('waters', 'bunkers', 'fairways', 'teeBoxes'):
            h[k] = [r for r in h[k] if closed(r)]
        rings = [r for r in h['green']['rings'] if closed(r)]
        if rings: h['green']['rings'] = rings
    n1 = sum(len(C.get(k, [])) for k in ('ponds', 'woods'))
    with open(path, 'w', encoding='utf-8') as f:
        f.write(head + 'window.COURSE = ')
        json.dump(C, f, separators=(',', ':'))
        f.write(';\n')
    print('%s: ponds+woods %d -> %d' % (path, n0, n1))
