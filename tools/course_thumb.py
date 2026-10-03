"""Course map thumbnail for the course picker: the routing drawn top-down."""
import json, sys, os
from PIL import Image, ImageDraw, ImageFilter

def load(path):
    s = open(path, encoding='utf-8').read()
    return json.loads(s[s.index('{'):s.rindex('}') + 1])

def thumb(src, dst, W=720, H=440):
    C = load(src)
    pts = [p for h in C['holes'] for p in h['spine']]
    for h in C['holes']:
        for r in h['green']['rings'] + h['fairways']: pts += r
    x0 = min(p[0] for p in pts); x1 = max(p[0] for p in pts)
    z0 = min(p[1] for p in pts); z1 = max(p[1] for p in pts)
    pad = 40
    s = min((W - 2 * pad) / (x1 - x0), (H - 2 * pad) / (z1 - z0))
    ox = (W - (x1 - x0) * s) / 2 - x0 * s; oz = (H - (z1 - z0) * s) / 2 - z0 * s
    T = lambda p: (p[0] * s + ox, p[1] * s + oz)
    S = 3                                  # supersample
    im = Image.new('RGB', (W * S, H * S), (20, 30, 23))
    d = ImageDraw.Draw(im)
    TT = lambda p: (T(p)[0] * S, T(p)[1] * S)
    poly = lambda r, c: len(r) > 2 and d.polygon([TT(p) for p in r], fill=c)
    for r in C.get('woods', []): poly(r, (31, 58, 36))
    for r in C.get('ponds', []): poly(r, (52, 96, 122))
    for h in C['holes']:
        d.line([TT(p) for p in h['spine']], fill=(54, 86, 46), width=max(2, int(34 * s * S)), joint='curve')   # rough corridor
    for h in C['holes']:
        for r in h['fairways']: poly(r, (96, 150, 70))
        for r in h['teeBoxes']: poly(r, (104, 160, 76))
        for r in h['waters']: poly(r, (60, 110, 140))
    for h in C['holes']:
        for r in h['bunkers']: poly(r, (226, 210, 168))
        for r in h['green']['rings']: poly(r, (132, 196, 96))
    im = im.resize((W, H), Image.LANCZOS)
    d = ImageDraw.Draw(im)
    for h in C['holes']:
        g = T(h['green']['c'])
        d.ellipse([g[0] - 2.5, g[1] - 2.5, g[0] + 2.5, g[1] + 2.5], fill=(220, 60, 50))
    # soft vignette
    v = Image.new('L', (W, H), 0); vd = ImageDraw.Draw(v)
    vd.rectangle([30, 30, W - 30, H - 30], fill=255)
    v = v.filter(ImageFilter.GaussianBlur(40))
    im = Image.composite(im, Image.new('RGB', (W, H), (10, 15, 12)), v)
    im.save(dst, quality=82, optimize=True, progressive=True)
    print('thumb', dst)

if __name__ == '__main__':
    for src in sys.argv[1:]:
        thumb(src, os.path.splitext(src)[0] + '.jpg')
