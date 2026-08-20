# MicBridge: host mic as a native node input

**Status:** design + Phase 0 spike + Phase 1 scaffold (2026-07-27)  
**Goal:** the RivetHub host microphone appears as a normal default capture
device on any connected node so tools like **Grok Build voice** (`Ctrl+Space`
/ `pw-record`) work unchanged inside remote PTYs.

Related: [DEN.md](./DEN.md) (den-server), terminal `WS /term` (binary attach).

---

## Why

Grok Build (and many CLIs) capture audio **on the machine running the
process** via `pw-record` / `parec` / `arecord`. RivetOS nodes are typically
headless CTs with no `/dev/snd`. RivetHub runs where the human and the mic
are. Text inject (client STT → `termInject`) is useful, but it bypasses
native voice UIs. MicBridge makes the host mic look **local** on the node.

```
┌─────────────────────────────┐         auth WS PCM          ┌──────────────────────────────┐
│ RivetHub host (web/Tauri)   │  s16le mono 16–48 kHz        │ Node den-server              │
│ getUserMedia / native mic   │ ───────────────────────────▶ │  MicBridge                   │
│ Ctrl+Space arms stream      │                              │    │                         │
└─────────────────────────────┘                              │    ▼                         │
                                                             │  FIFO / ring + shim recorder │
                                                             │  "RivetHub Mic"              │
                                                             │    │                         │
                                                             │    ▼                         │
                                                             │  Grok: pw-record on PATH     │
                                                             │  → cloud STT as usual        │
                                                             └──────────────────────────────┘
```

---

## Design principles

1. **Sibling of `/term`**, not a mesh task: same den bearer gate, node
   switcher repoints `baseUrl`, exclusive single publisher.
2. **Software-only capture**: no kernel sound, no USB passthrough. LXC
   nodes without `/dev/snd` are first-class.
3. **Stream only while armed** (push-to-talk / voice session) for privacy
   and bandwidth.
4. **Two sink backends** (same protocol):
   - **Path A (recommended for CTs):** FIFO + drop-in `pw-record` shim that
     reads MicBridge and writes PCM to stdout. Zero apt deps if Node is
     present; satisfies Grok's recorder probe.
   - **Path B (optional):** real PipeWire/Pulse `module-pipe-source` (or
     equivalent) named `RivetHub Mic` when the stack is installed.

---

## Protocol

### HTTP

| Method | Path | Meaning |
|--------|------|---------|
| `GET` | `/audio` or `/api/audio` | Status: enabled, armed, publisher, sampleRate, device, backend |
| `GET` | `/audio/health` | Liveness of runtime dir + FIFO/socket |

### WebSocket

```
WS /audio/mic          (alias /api/audio/mic)
```

Auth: same as `/term`: `Authorization: Bearer …` or `?token=` **before**
the handshake completes.

#### Client → server (JSON text frames)

```json
{ "type": "hello", "v": 1, "sampleRate": 16000, "channels": 1, "format": "s16le" }
{ "type": "start" }
{ "type": "stop" }
```

#### Client → server (binary frames)

Raw PCM matching the negotiated format (default **s16le mono 16 kHz**).

#### Server → client (JSON text frames)

```json
{ "type": "ready", "device": "RivetHub Mic", "sampleRate": 16000, "format": "s16le", "backend": "fifo-shim" }
{ "type": "error", "code": "busy" | "disabled" | "bad-hello" | "no-runtime", "message": "…" }
{ "type": "stopped" }
```

#### Rules

- One exclusive publisher per node; second client gets `busy` (steal is a
  later opt-in).
- Binary frames before a successful `hello`/`ready` are ignored.
- WS close → release lock, stop writing, audit "disarmed".
- Max buffered PCM: drop oldest if the sink cannot keep up (never stall the
  Hub event loop unboundedly).

---

## Node runtime (Path A: shim)

```
$stateDir/audio/
  mic.pcm          # FIFO (or Unix socket in a later revision)
  audit.log        # arm/disarm lines
```

**`rivet-mic-record`** (installed ahead of real tools as `pw-record` and/or
`parec` on `PATH` for the den/service user):

1. Open the MicBridge FIFO (or connect to the local sink).
2. Write raw PCM to stdout until EOF / SIGTERM.
3. If no publisher yet, emit silence (zeros) so capture tools do not exit
   immediately; Grok treats "exited immediately" as failure.

Grok's doctor probes for a recorder on `PATH`; once the shim exists,
`voice.no-input-device` should clear. Dictation then reads live frames when
Hub is armed.

### Path B: PipeWire/Pulse (optional)

```bash
sudo apt install pipewire pipewire-pulse pipewire-bin pulseaudio-utils
# module-pipe-source file=$FIFO format=s16le rate=16000 channels=1
# set as default source while armed
```

Not required for Phase 0–1 if the shim is on `PATH`.

---

## RivetHub client (Phase 2+)

1. Capture host mic (`getUserMedia` + AudioWorklet → s16le).
2. Open `gateway.audioMicWsUrl()` on the **active node**.
3. Global `Ctrl+Space` / `F8` **arms** the stream (and optionally injects
   Grok's voice key into the focused PTY so one gesture starts both).
4. On node switch while armed: stop old WS, open new, re-arm or require
   re-press (prefer re-press for safety).

Do **not** fan-out live mic to every mesh peer.

---

## Security

Same bar as terminals, with extra care for ambient audio:

| Control | Behavior |
|---------|----------|
| Master switch | `RIVETOS_DEN_AUDIO=1` (default off) |
| Open mode | `RIVETOS_DEN_AUDIO_OPEN=1` only on trusted LANs without token |
| Auth | Bearer / `?token=` before WS upgrade |
| Exclusive lock | One Hub publisher per node |
| Audit | Arm/disarm with remote address + duration |
| Idle | No continuous capture when WS closed |

---

## Config (env)

| Env | Default | Meaning |
|-----|---------|---------|
| `RIVETOS_DEN_AUDIO` | off | Enable MicBridge routes |
| `RIVETOS_DEN_AUDIO_OPEN` | off | Allow tokenless off-loopback (loud) |
| `RIVETOS_DEN_AUDIO_RATE` | `16000` | Sample rate Hz |
| `RIVETOS_DEN_AUDIO_DEVICE` | `RivetHub Mic` | Logical device name |
| `RIVETOS_DEN_AUDIO_DIR` | `$stateDir/audio` | Runtime dir (FIFO, audit) |

---

## Phased delivery

| Phase | Deliverable | Native Grok? |
|-------|-------------|--------------|
| **0** | Node spike: shim + FIFO + `grok doctor` sees a mic | Probe yes |
| **1** | den-server `audio/*`, types, gateway-client URL helper | Yes if client streams |
| **2** | RivetHub capture + stream + mic indicator | Yes |
| **3** | Global chord + optional PTY voice-key inject | One gesture |
| **4** | Opus, steal policy, Android Hub, PipeWire backend polish | Yes |

---

## Non-goals

- Kernel ALSA/`snd-aloop` passthrough into every CT  
- Always-on mesh-wide mic multicast  
- Replacing Grok STT (cloud stays; we only supply PCM)  
- Browser talking PulseAudio natively over the LAN  

---

## Code map

| Path | Role |
|------|------|
| `services/den-server/src/audio/bridge.ts` | Exclusive lock, FIFO, PCM write |
| `services/den-server/src/audio/ws.ts` | `WS /audio/mic` protocol |
| `services/den-server/src/audio/http.ts` | `GET /audio` status |
| `services/den-server/scripts/micbridge-phase0/` | Rootless spike + `pw-record` shim |
| `packages/types` / `gateway-client` | Wire DTOs + `audioMicWsUrl()` |

---

## Manual Phase 0 checklist

```bash
# on a node (no root required for Path A)
./services/den-server/scripts/micbridge-phase0/setup.sh
export PATH="$HOME/.local/bin:$PATH"
grok doctor   # Voice → should not say "no microphone recorder found on PATH"

# optional: feed silence while testing capture
./services/den-server/scripts/micbridge-phase0/feed-silence.sh &
pw-record --rate=16000 /tmp/test.raw   # or let Grok dictation pull
```

With den-server audio enabled (Phase 1):

```bash
RIVETOS_DEN_AUDIO=1 RIVETOS_DEN_HOST=127.0.0.1 node services/den-server/dist/index.js
# Hub (later) streams PCM to ws://127.0.0.1:5174/audio/mic?token=…
```
