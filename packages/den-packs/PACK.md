# SpritePack format — spec v1

A SpritePack is everything the den renderer needs to draw a room: character
animations, furniture art and geometry, the room shell, a default layout, and
where the character stands per activity. Packs are data — the renderer has no
hardcoded art constants, so swapping a pack reskins the whole den, and a pack
can ship per-tool animations without engine changes.

A pack is a directory (distributed as a zip) containing `pack.json` plus PNG
sprites at pack-relative paths. `den-pack validate <dir>` is the gatekeeper:
it must pass before a pack is served, published, or accepted into a registry.

## pack.json

```jsonc
{
  "spec": 1,                     // pack spec version
  "name": "default",
  "version": "1.0.0",            // semver
  "author": "Rivet & Phil",
  "license": "Apache-2.0",       // required — enforced at publish time
  "grid": { "pxPerUnit": 4 },    // size of one art-pixel in shell units
  "chroma": { "color": "#ff00ff", "threshold": 32 },
  "shell": { "src": "sprites/shell.png", "w": 1344, "h": 768 },
  "character": { ... },
  "furniture": [ ... ],
  "layout": { ... },
  "stations": { ... }
}
```

### Coordinate spaces

- **Shell units** — the room coordinate system, defined by `shell.w/h`.
  Layout placements, stations, and content heights use shell units.
- **Original image coordinates** — pixel coordinates in a sprite's source PNG
  before keying/trimming. Functional rects (`screen`, `textRect`) and pose
  `attachments` use these, so they survive re-rasterization.
- **The grid** — `grid.pxPerUnit` is how many shell units one art-pixel spans.
  The renderer resamples every sprite onto this global grid so mixed-fidelity
  art still reads as one drawing. Higher-fidelity packs simply ship a smaller
  `pxPerUnit`.

### Chroma key

Sprites are drawn on a solid `chroma.color` background (the "magenta studio").
The renderer keys that color to transparency with `threshold` tolerance and
trims to content. The shell is drawn unkeyed.

### character

```jsonc
{
  "height": 142,                  // default content height, shell units
  "poses": {
    "idle": { "frames": ["sprites/char/idle_f0.png", "sprites/char/idle_f1.png"], "frameMs": 0 },
    "sleep": { "frames": [...], "frameMs": 1100, "height": 114 }  // lying down
  },
  "activities": {                 // REQUIRED: all nine protocol activities
    "idle": "idle", "thinking": "idle", "searching_web": "phone",
    "editing_code": "type", "running_command": "dig", "writing_plan": "write",
    "listening": "idle", "speaking": "idle", "sleeping": "sleep"
  },
  "tools": { "Bash": "dig" }      // optional per-tool overrides, raw tool names
}
```

- A **pose** is an ordered frame list plus `frameMs` (0 = static). All frames
  of a pose must be PNGs with identical dimensions.
- Pose resolution follows the protocol fallback chain: **tool override →
  activity pose → `idle`**. New tools can never break a pack.
- `walk` is a reserved pose name used for locomotion between stations
  (warning if absent — the character teleports).
- Optional `attachments` per pose give named anchor points (`head`, `hands`)
  in original image coordinates for Z's, thought bubbles, and props.

### furniture

```jsonc
{
  "id": "desk",
  "src": "sprites/furniture/desk.png",
  "variants": ["sprites/furniture/desk_alt.png"],   // EDIT-mode swaps
  "screen": { "x": 385, "y": 177, "w": 220, "h": 128 },  // monitor glass
  "textRect": { ... },                              // writable surface (board)
  "sideSrc": "sprites/furniture/chair_side.png"     // seat-sequence side view
}
```

All furniture is bottom-center anchored. Functional rects are in original
image coordinates of `src`.

### layout & stations

`layout` is the default arrangement: `{ "<furnitureId>": { x, y, h, flip? } }`
in shell units (x = bottom-center, y = base). Viewers may override layouts at
runtime (den-server stores per-viewer copies); the pack layout is the
fallback.

`stations` place the character's feet per activity — either
furniture-anchored (`{ "furn": "board", "dx": -110, "dy": 45 }`, so
rearranging the room moves the station too) or absolute (`{ "x": 520, "y":
745 }`). All nine activities are required.

## Validation

`den-pack validate <dir>` checks:

- manifest parses, `spec` is supported, name/version/author/license present
- every referenced file exists inside the pack (no `..` escapes)
- all nine activities map to existing poses; tool overrides too
- pose frames are PNGs of consistent size, `frameMs >= 0`
- layout and stations only reference declared furniture

Exit code 0 with a summary line on success; 1 with per-problem errors.

## Versioning

`spec` bumps only on breaking manifest changes; additive optional fields are
allowed within a spec version. Pack `version` is semver and owned by the pack
author. Content-hash of the zip identifies a build for distribution.
