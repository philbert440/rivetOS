# rivet-den — watch your agent work

A live pixel-art diorama of an agent session. Lifecycle hooks translate what
the agent is doing — prompts, tool calls, plans, thinking, compaction — into
a small event protocol; a tiny server reduces those events into room state;
a Pixi viewer renders the room: whiteboard plans get written, the terminal
shows real commands, the robot walks to the desk to code, and context
compaction is a nap in the bed.

![rivet-den demo loop](den-demo.gif)

## Quickstart

```bash
npm install
npm run build -w @rivetos/den-protocol -w @rivetos/den-packs \
              -w @rivetos/den-server   -w @rivetos/den-app

RIVETOS_DEN_STATIC_DIR=apps/den/dist \
RIVETOS_DEN_PACKS_DIR=packages/den-packs/packs \
node services/den-server/dist/index.js
# → http://127.0.0.1:5174/demo  (built-in demo loop, no agent needed)
```

To stream a real session, install an adapter:

- **Claude Code** — add the `rivet-den` plugin from the rivetos marketplace
  (`integrations/claude-code/rivet-den/`); set `RIVET_DEN_URL` if the server
  isn't on localhost. [Plugin README](../integrations/claude-code/rivet-den/README.md)
  — read its "What the den shows" section before pointing it at a shared server.
- **Grok Build** — hook set in `integrations/grok/rivet-den/`.

The server binds `127.0.0.1` by default; set `RIVETOS_DEN_HOST=0.0.0.0` (and
ideally `RIVETOS_DEN_TOKEN`) to serve a LAN. Multiple viewers, multiple
sessions, one server — the picker chooses which room drives the den.

## The moving parts

| Doc | What it covers |
|-----|----------------|
| [PROTOCOL.md](../packages/den-protocol/PROTOCOL.md) | The v1 event schema and reducer semantics — the frozen contract everything else builds on |
| [PACK.md](../packages/den-packs/PACK.md) | SpritePack spec: poses, furniture, stations, composite art, functional rects, `viewer{}` tuning |
| [ART-PIPELINE.md](../packages/den-packs/ART-PIPELINE.md) | How default-pack@2's art was made with an image generator — the magenta studio, union-crop alignment, analytic anchor solving. Start here if you want to author a pack; it's the fun one |
| [den-server](../services/den-server/src/server.ts) | Ingest (`POST /events` ordered batches), WS fanout, snapshots, eviction |

Default pack weighs ~8.6MB of pre-keyed PNGs served once and cached;
`grid.pxPerUnit: 2` keeps textures small and the render cheap.

## Mesh view

One den-server runs per node; `GET /mesh.json` (auth-gated like every other
endpoint) is how a viewer sees them all. The server reads the mesh roster —
`RIVETOS_DEN_MESH_FILE` if set, else `/rivet-shared/mesh.json`, else
`~/.rivetos/mesh.json` — projects the den-enabled nodes, probes each one's
den `/healthz` in parallel (1.5s budget per peer), and answers:

```json
{
  "updatedAt": 1751600000000,
  "nodes": [
    { "id": "rivet-claude", "name": "rivet-claude",
      "denUrl": "http://192.0.2.10:5174", "online": true, "sessions": 2,
      "latest": { "activity": "coding", "title": "wiring the mesh view" } }
  ]
}
```

The whole result is cached for `RIVETOS_DEN_MESH_CACHE_MS` (default 10s).
`latest` appears only on the entry that is this process — `RIVETOS_DEN_NODE_ID`
(else the machine hostname) matched against roster node ids; when nothing
matches, no entry carries a `latest`, which is fine. The endpoint is `/mesh.json`
*with* the extension on purpose: the extensionless `/mesh` stays free for the
viewer SPA's route.

A node is den-enabled when its roster entry has `'den'` in `capabilities`, a
`metadata.denPort`, or a full `metadata.denUrl` (http/https only — anything
else is ignored with a warning). The entry's top-level `port` is the agent
channel, **not** the den, which is why the den port lives in metadata:

```json
"rivet-claude": {
  "capabilities": ["den"],
  "metadata": { "denPort": 5174 }
}
```

**Warning — the runtime clobbers hand-edits.** As of this writing,
`FileMeshRegistry.register()` (`packages/core/src/domain/mesh.ts`) replaces a
node's whole entry (`data.nodes[node.id] = node`), and every RivetOS runtime
startup re-registers its own entry via `buildLocalNode()`
(`packages/boot/src/registrars/agents.ts`), which builds it with empty
`capabilities` and no `metadata`. Den tags hand-added to an agent node's entry
are therefore wiped whenever that node's runtime restarts, and must be
re-applied. (`rivetos mesh join` does not overwrite the named entry — it
registers a fresh empty-capability entry under a newly generated UUID id,
which is its own kind of roster noise.) Entries the runtime doesn't own —
infra roles, hand-maintained nodes — keep their tags.

## Mobile & performance

The viewer runs fine on phones (it camera-follows the character in portrait).
Two honest notes: Pixi renders every animation frame, so a den left open in
the foreground will use battery like a game would — background tabs throttle
to nothing. On weak GPUs prefer the day shell (`?tod=day`) and one session
per tab. There is no reduced-motion mode yet.

## Accessibility

The chat stream and narration panel are DOM text (screen-reader reachable);
the room itself — whiteboard, terminal, activity — is canvas and currently
invisible to assistive tech. Future polish: mirror whiteboard/terminal state
into an `aria-live` region and honor `prefers-reduced-motion`.

## Roadmap

- **rivetos-native emitters** — events straight from the runtime's hook
  pipeline (no CC/Grok adapter needed); next PR after this stack lands.
- **Visual regression on packs** — render each pose/station headlessly and
  diff against goldens, so art and anchor changes surface in review.
- **Hosted den tier** — the CC plugin is deliberately self-contained (plain
  Node, no rivetos install) so a hosted server + token is a copy-paste onboard.
- **Pack marketplace** — `den-pack validate` is already the gatekeeper;
  spec v1 is frozen; PACK.md is the authoring contract.
