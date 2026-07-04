#!/usr/bin/env python3
"""Union-crop a same-series frame set.

Image generators hold scale and position within one generation series to
about ±1px, so per-frame alignment is unnecessary AND harmful (independent
trims destroy it). Instead: chroma-key every frame, compute the UNION of all
content bboxes, and crop every frame to that one box. The shipped frames
share a canvas, so animation alignment is free.

Frames are written as <pose>_f0.png … in --out (or in place of the inputs'
directory). Inputs may be JPG straight from the generator.

--lcc drops everything but the largest connected component per frame
(dithered-shadow speckle cleanup, same as process-strip.py). It is OPT-IN
here because composite poses legitimately contain disconnected pieces
(character apart from furniture, floating Z's) that LCC would delete —
check the output when you use it.

Usage:
  union-crop.py FRAME1 FRAME2 [...] --pose NAME --out DIR [--lcc]
"""
import sys, argparse
from pathlib import Path
from PIL import Image

# same key metric as process-strip.py — keep in sync
def key_image(im):
    px = im.load(); w, h = im.size
    out = Image.new('RGBA', (w, h), (0, 0, 0, 0)); op = out.load()
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y][:3]
            if min(r, b) - g <= 32:
                op[x, y] = (r, g, b, 255)
    return out

# same speckle cleanup as process-strip.py — keep in sync
def largest_component(im):
    from collections import deque
    w, h = im.size; px = im.load()
    seen = [[False] * w for _ in range(h)]
    best = None
    for y in range(h):
        for x in range(w):
            if px[x, y][3] and not seen[y][x]:
                q = deque([(x, y)]); seen[y][x] = True; cells = []
                while q:
                    cx, cy = q.popleft(); cells.append((cx, cy))
                    for nx, ny in ((cx+1,cy),(cx-1,cy),(cx,cy+1),(cx,cy-1)):
                        if 0 <= nx < w and 0 <= ny < h and px[nx, ny][3] and not seen[ny][nx]:
                            seen[ny][nx] = True; q.append((nx, ny))
                if best is None or len(cells) > len(best):
                    best = cells
    keep = set(best or [])
    for y in range(h):
        for x in range(w):
            if px[x, y][3] and (x, y) not in keep:
                px[x, y] = (0, 0, 0, 0)
    return im

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('frames', nargs='+')
    ap.add_argument('--pose', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--lcc', action='store_true',
                    help='keep only the largest connected component per frame (speckle cleanup)')
    a = ap.parse_args()

    keyed = []
    for f in a.frames:
        im = key_image(Image.open(f).convert('RGB'))
        if a.lcc:
            im = largest_component(im)
        bb = im.getbbox()
        if not bb:
            sys.exit(f'{f}: keyed to nothing — wrong chroma?')
        keyed.append((im, bb))

    sizes = {im.size for im, _ in keyed}
    if len(sizes) > 1:
        sys.exit(f'frames are different sizes {sizes} — not one series, union-crop would misalign')

    x0 = min(bb[0] for _, bb in keyed); y0 = min(bb[1] for _, bb in keyed)
    x1 = max(bb[2] for _, bb in keyed); y1 = max(bb[3] for _, bb in keyed)

    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    for i, (im, _) in enumerate(keyed):
        dest = out / f'{a.pose}_f{i}.png'
        im.crop((x0, y0, x1, y1)).save(dest)
        print(f'wrote {dest} {x1 - x0}x{y1 - y0}')

if __name__ == '__main__':
    main()
