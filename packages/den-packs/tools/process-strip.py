#!/usr/bin/env python3
"""rivet-den pose-strip processor.

Takes a generated 2-frame strip (frame 1 on the left half, frame 2 on the
right), chroma-keys the magenta studio, trims, normalizes both frames to a
shared bottom-center-anchored canvas (so the animation doesn't jitter),
optionally mirrors the clean right foot over a notch artifact, and installs
the frames into a pack.

Requires Pillow. See ART-PIPELINE.md for the full authoring recipe.

Usage:
  process-strip.py STRIP.png POSE --pack DIR [--single] [--footfix]

  --single    image is one frame, not a strip (installed as f0 AND f1)
  --footfix   mirror the right foot over a notched left one (bottom 20%).
              OPT-IN: it assumes a symmetric standing pose — on walk cycles
              or any asymmetric pose it silently corrupts the feet.
"""
import sys, json, argparse
from pathlib import Path
from PIL import Image

def key_image(im):
    """Magenta-family chroma key: min(r,b)-g catches the studio color, pink
    generator drift, AND magenta-tinted shadow pixels."""
    px = im.load(); w, h = im.size
    out = Image.new('RGBA', (w, h), (0, 0, 0, 0)); op = out.load()
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y][:3]
            if min(r, b) - g <= 32:
                op[x, y] = (r, g, b, 255)
    return out

def largest_component(im):
    """Drop disconnected speckles (dithered shadow survivors)."""
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

def footfix(im):
    """Mirror the clean right foot over the notched left one (bottom 20%)."""
    fl = im.transpose(Image.FLIP_LEFT_RIGHT)
    px, fx = im.load(), fl.load()
    W, H = im.size
    for y in range(int(H * 0.80), H):
        for x in range(W // 2):
            px[x, y] = fx[x, y]
    return im

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('strip'); ap.add_argument('pose')
    ap.add_argument('--pack', required=True, help='pack directory (contains pack.json)')
    ap.add_argument('--single', action='store_true')
    ap.add_argument('--footfix', action='store_true',
                    help='mirror right foot over notched left (symmetric poses only)')
    a = ap.parse_args()

    im = Image.open(a.strip).convert('RGB')
    halves = [im] if a.single else [
        im.crop((0, 0, im.width // 2, im.height)),
        im.crop((im.width // 2, 0, im.width, im.height)),
    ]
    frames = []
    for h in halves:
        f = largest_component(key_image(h))
        bb = f.getbbox()
        if not bb:
            sys.exit('frame keyed to nothing — wrong chroma?')
        f = f.crop(bb)
        if a.footfix:
            f = footfix(f)
        frames.append(f)
    if a.single:
        frames = [frames[0], frames[0].copy()]

    # normalize onto one canvas, bottom-center anchored, so frames don't jitter
    W = max(f.width for f in frames); H = max(f.height for f in frames)
    out = []
    for f in frames:
        c = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        c.alpha_composite(f, ((W - f.width) // 2, H - f.height))
        out.append(c)

    pack = Path(a.pack)
    (pack / 'sprites' / 'char').mkdir(parents=True, exist_ok=True)
    for i, f in enumerate(out):
        dest = pack / 'sprites' / 'char' / f'{a.pose}_f{i}.png'
        f.save(dest)
        print(f'installed {dest.name} {f.size[0]}x{f.size[1]}')
    m = json.loads((pack / 'pack.json').read_text())
    if a.pose not in m['character']['poses']:
        print(f'NOTE: pose "{a.pose}" not in manifest — add frames/frameMs entry')

if __name__ == '__main__':
    main()
