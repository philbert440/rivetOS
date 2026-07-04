# Art pipeline — how default-pack@2 was made

The high-fi pack was authored with an image generator (Grok Imagine) plus the
three small tools in `tools/`. This file is the recipe; everything here was
proven end-to-end on default-pack@2.

Tools require Python 3 + Pillow. They are authoring-time helpers — nothing in
the runtime depends on them.

## The magenta studio

All sprites are generated on a solid magenta (`#ff00ff`) background. The key
metric is `min(r, b) - g > 32`, NOT a distance-to-color test — it also
catches the generator's drift toward pink and magenta-tinted shadow pixels.
Gray *dithered* shadows survive the key as disconnected speckles.
`process-strip.py` always drops everything but the largest connected
component; `union-crop.py` only does it with `--lcc`, because composite
poses legitimately contain disconnected pieces that the cleanup would
delete.

Packs ship **pre-keyed PNGs with real alpha**. The renderer detects alpha and
passes those sprites through untouched — this is what preserves multi-frame
canvas alignment, so never re-export a shipped frame through a keyer.

## Recipe 1 — simple pose (2-frame strip)

Ask the generator for one image, two side-by-side variants of the pose,
magenta background. Then:

    tools/process-strip.py strip.png POSE --pack <dir>

Keys, trims, normalizes both frames onto one bottom-center-anchored canvas
(no jitter), installs as `POSE_f0/f1.png`. `--single` installs one image as
both frames; `--footfix` mirrors the clean right foot over a notched left
one — opt-in, symmetric standing poses only (it corrupts walk cycles).

## Recipe 2 — animation series (3+ frames)

Generators hold scale and position within one generation series to ±1px.
Exploit it: generate all frames in one series, then

    tools/union-crop.py f1.jpg f2.jpg f3.jpg --pose POSE --out <pack>/sprites/char

Every frame is cropped to the UNION of the content bboxes, so the shipped
frames share a canvas and alignment is free. Do NOT trim frames
independently — that is exactly what re-introduces jitter. If frames come
back inconsistent (one huge, one shifted), don't fight it with per-frame
offsets: regenerate the series. A consistent series costs one prompt; an
inconsistent one costs an evening.

## Recipe 3 — composite pose (character + furniture in one art)

For poses where the character interacts with furniture (typing at the desk,
digging in the toolbox), the pose art *contains* the furniture
(`pose.replaces`), and the renderer swaps it in over the hidden real piece.

1. **Build a proportion-true reference**: composite the pack's actual
   sprites (furniture at its real placement scale, character at
   `character.height`) into one image. Give THAT to the generator to edit —
   it holds the proportions. Never let it invent the scene from a text
   prompt; you'll never match scale.
2. Generate the series on magenta, union-crop it (recipe 2).
3. **Solve the pin analytically** — never hand-measure (hand-measured
   anchors carry a systematic ~20-shell-unit bias):

       tools/parity-solve.py <pack>/sprites/char/POSE_f0.png FURN_ID --pack <dir> --palette

   It locates the furniture body in the composite, reads the placement, and
   prints the pose `height` + `attachments.anchor` that make the drawn
   furniture land on the standalone sprite's exact screen pixels. Detection
   modes: `--palette` (match the standalone sprite's colors), `--auto-dark`
   (largest dark cluster), or `--bbox X0,Y0,X1,Y1` (manual, exact — use this
   for multi-furniture composites, where auto modes over-grab).
4. Add `attachments.feet` (where the character stands to enter/exit) and,
   for poses that emit overlays, `attachments.head`.
5. `intro: N` marks climb-in/sit-down frames: they play once on entry and
   run REVERSED when leaving. The remaining frames loop.

Verify by screenshot: the furniture edge in the composite must sit on the
same pixel column as the standalone sprite (toggle the activity on and off —
any swap jump means the anchor is wrong; re-solve, don't nudge).

## Functional rects

`screen` / `textRect` (live terminal, whiteboard text) are measured in the
SHIPPED sprite's pixel coordinates — measure on the final PNG, after keying
and cropping, never on the generator's original.

## Grid

High-fi art uses `grid.pxPerUnit: 2` (one art pixel = 2 shell units). Match
the generator's native pixel pitch — resampling to a coarser grid quantizes
detail away.
