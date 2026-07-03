#!/usr/bin/env python3
"""Union-crop a same-series frame set.

Image generators hold scale and position within one generation series to
about ±1px, so per-frame alignment is unnecessary AND harmful (independent
trims destroy it). Instead: chroma-key every frame, compute the UNION of all
content bboxes, and crop every frame to that one box. The shipped frames
share a canvas, so animation alignment is free.

Frames are written as <pose>_f0.png … in --out (or in place of the inputs'
directory). Inputs may be JPG straight from the generator.

Usage:
  union-crop.py FRAME1 FRAME2 [...] --pose NAME --out DIR
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

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('frames', nargs='+')
    ap.add_argument('--pose', required=True)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()

    keyed = []
    for f in a.frames:
        im = key_image(Image.open(f).convert('RGB'))
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
