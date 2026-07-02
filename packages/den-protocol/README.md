# @rivetos/den-protocol

Event protocol + pure room-state reducer for **rivet-den**, the live pixel-art
diorama of an agent session. Zero dependencies, renderer-agnostic: adapters
emit `AgentEvent`s, `reduceDen` folds them into per-session `RoomState`, any
renderer draws it.

See [PROTOCOL.md](./PROTOCOL.md) for the full contract.

```ts
import { initialDenState, reduceDen, parseEvent } from '@rivetos/den-protocol';

let den = initialDenState;
const ev = parseEvent(JSON.parse(body)); // null if malformed
if (ev) den = reduceDen(den, ev);
den.rooms[ev.session]; // → RoomState for the renderer
```
