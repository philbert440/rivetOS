#!/usr/bin/env python3
"""Analytic parity solver for composite poses.

A composite pose (pose.replaces) draws art that contains the character AND a
furniture piece; the renderer hides the real furniture and pins the pose to
its placement via attachments.anchor. For the swap to be invisible, the
furniture body drawn INSIDE the pose art must land on exactly the same screen
pixels as the standalone sprite it replaces.

Hand-measuring the anchor carries a systematic ~20-shell-unit bias (you
measure to the visual edge, the renderer scales to the alpha edge). This tool
solves it analytically instead:

  1. locate the furniture body's pixel bbox in the composite frame
  2. read the placement (x, y, h) from the pack layout
  3. solve pose height so the body's on-screen width matches the standalone
     sprite's on-screen width, and emit the anchor point (body bottom-center
     in frame-image coordinates)

Paste the printed height/attachments into the pose entry. Verified to
0.06 shell units on the desk composite (same screen pixel column).

Body detection modes (pick whichever isolates the furniture in YOUR art):
  --bbox X0,Y0,X1,Y1   you measured it (any tool; exact, always works)
  --auto-dark          largest connected dark cluster (worked for the toolbox)
  --palette            pixels matching the standalone sprite's palette
                       (tolerance --tol, default 28)

Usage:
  parity-solve.py COMPOSITE_FRAME.png FURN_ID --pack DIR [mode]
"""
import sys, json, argparse
from collections import deque
from pathlib import Path
from PIL import Image

def content(im):
    """RGBA content pixels: real alpha if present, else magenta-keyed."""
    im = im.convert('RGBA')
    if im.getextrema()[3][0] < 250:  # already keyed
        return im
    px = im.load(); w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, _ = px[x, y]
            if min(r, b) - g > 32:
                px[x, y] = (0, 0, 0, 0)
    return im

def largest_cluster(mask, w, h):
    seen = set(); best = None
    for start in mask:
        if start in seen:
            continue
        q = deque([start]); seen.add(start); cells = []
        while q:
            cx, cy = q.popleft(); cells.append((cx, cy))
            for n in ((cx+1,cy),(cx-1,cy),(cx,cy+1),(cx,cy-1)):
                if n in mask and n not in seen:
                    seen.add(n); q.append(n)
        if best is None or len(cells) > len(best):
            best = cells
    if not best:
        sys.exit('no body pixels matched — try a different detection mode')
    xs = [c[0] for c in best]; ys = [c[1] for c in best]
    return min(xs), min(ys), max(xs), max(ys)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('composite'); ap.add_argument('furn_id')
    ap.add_argument('--pack', required=True)
    ap.add_argument('--bbox', help='X0,Y0,X1,Y1 of the furniture body in the composite')
    ap.add_argument('--auto-dark', action='store_true')
    ap.add_argument('--palette', action='store_true')
    ap.add_argument('--tol', type=int, default=28)
    a = ap.parse_args()

    pack = Path(a.pack)
    m = json.loads((pack / 'pack.json').read_text())
    spec = next((f for f in m['furniture'] if f['id'] == a.furn_id), None)
    if not spec:
        sys.exit(f'furniture {a.furn_id} not in pack')
    pl = m['layout'][a.furn_id]

    comp = content(Image.open(a.composite))
    W, H = comp.size

    # ---- 1. furniture body bbox in the composite frame ----
    if a.bbox:
        bx0, by0, bx1, by1 = (int(v) for v in a.bbox.split(','))
    else:
        px = comp.load()
        mask = set()
        if a.palette:
            furn = content(Image.open(pack / spec['src']))
            fpx = furn.load()
            pal = set()
            for y in range(0, furn.height, 2):
                for x in range(0, furn.width, 2):
                    r, g, b, al = fpx[x, y]
                    if al:
                        pal.add((r // a.tol, g // a.tol, b // a.tol))
            for y in range(H):
                for x in range(W):
                    r, g, b, al = px[x, y]
                    if al and (r // a.tol, g // a.tol, b // a.tol) in pal:
                        mask.add((x, y))
        else:  # --auto-dark (default)
            for y in range(H):
                for x in range(W):
                    r, g, b, al = px[x, y]
                    if al and max(r, g, b) < 90:
                        mask.add((x, y))
        bx0, by0, bx1, by1 = largest_cluster(mask, W, H)
    body_w = bx1 - bx0 + 1

    # ---- 2. standalone sprite's on-screen geometry ----
    furn = content(Image.open(pack / spec['src']))
    fb = furn.getbbox()
    fw, fh = fb[2] - fb[0], fb[3] - fb[1]
    screen_w = fw * (pl['h'] / fh)  # shell units

    # ---- 3. solve ----
    pose_h = screen_w * H / body_w
    anchor = {'x': round((bx0 + bx1 + 1) / 2, 1), 'y': by1 + 1}
    print(f'furniture body in composite: ({bx0},{by0})..({bx1},{by1})  {body_w}px wide')
    print(f'placement {a.furn_id}: x={pl["x"]} y={pl["y"]} h={pl["h"]} (on-screen width {screen_w:.1f})')
    print()
    print(f'  "height": {round(pose_h, 1)},')
    print(f'  "attachments": {{ "anchor": {{ "x": {anchor["x"]}, "y": {anchor["y"]} }} }},')
    print(f'  "replaces": "{a.furn_id}"')

if __name__ == '__main__':
    main()
