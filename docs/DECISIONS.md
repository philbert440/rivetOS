# Design Decisions

Last updated: April 2026. All foundational decisions are now implemented.

## 1. Config format → YAML ✅
YAML over TOML. More familiar, more expressive for nested config like channel bindings and hook definitions. Env var resolution via `${VAR_NAME}` syntax.

## 2. Heartbeat/cron → Core domain ✅
Heartbeat is a domain concern — `HeartbeatRunner` lives in `packages/core/src/domain/heartbeat.ts`. It's a periodic scheduler that triggers configurable prompts at set intervals. Cron is separate (exact-time scheduling with isolated execution context).

## 3. Multi-instance → Configurable ✅
Support both modes:
- **Single process** (default): one process, multiple agents. Simpler deployment.
- **Multi-process**: one process per agent. For when resource isolation matters.

Config flag to choose. Currently running single process.

## 4. Streaming → Yes, required ✅
Stream LLM responses to channels in real-time. Provider returns `AsyncIterable<StreamEvent>`. StreamManager in `packages/core/src/runtime/streaming.ts` delivers chunks to channels via `edit()`. Channels handle platform limits (message length, typing indicators) internally.

## 5. Plugin discovery → Auto-discover ✅
Scan `plugins/` directory structure. Convention over configuration:
- `plugins/channels/*/` → channel plugins
- `plugins/providers/*/` → provider plugins
- `plugins/memory/*/` → memory plugins
- `plugins/tools/*/` → tool plugins

Each plugin exports a factory function. Config file references plugin by directory name.
If a plugin directory exists but isn't referenced in config, it's ignored (not auto-loaded).

Discovery is automatic, activation is explicit. Best of both worlds.

## 6. Existing data → Migration complete ✅
66K+ messages + summaries migrated from LCM to RivetOS schema (ros_* tables). Migration script at `plugins/memory/postgres/src/migrate.ts`. Old tables kept as read-only archive.

## 7. Voice → Same process, wired into workspace ✅
Voice plugin runs in the same process as text channels. The xAI Realtime API client gets access to the same workspace files and memory, so voice has the same context as text. Same agent, different interface.

## 8. Web dashboard → Later
Not in scope until M5+. Focus on the runtime. Dashboard is a separate concern that can be added as a plugin later.

## 9. Workspace file reloading → On restart or /new ✅
Workspace files are loaded on startup and cached. They refresh on:
- Process restart
- `/new` command (clears session, reloads workspace)

No file watching currently. If you edit SOUL.md, `/new` picks it up. File watching may be added later as an enhancement.

## 10. Session persistence → Yes, survives restarts ✅
Conversation history persists in postgres. On restart, the active session resumes where it left off (loads recent history from transcript store).

`/new` is the explicit "forget everything and start fresh" command.
Restart is just "I went away and came back."

## 11. Runtime decomposition → Thin compositor ✅ (added April 2026)
Runtime is a thin compositor (~296 lines). Turn processing, media handling, streaming, sessions, and commands are each their own module in `packages/core/src/runtime/`. The runtime registers things and routes messages — it doesn't process them.

## 12. Platform concerns in plugins → Always ✅ (added April 2026)
Message splitting, typing indicators, API format differences, and other platform-specific behavior live in channel/provider plugins, never in the runtime. The runtime is platform-agnostic. Examples:
- Discord splits at 2000 chars, Telegram at 4096 — each channel's `edit()`/`send()` handles this internally
- Typing indicators are channel-managed (Telegram: 4s refresh, Discord: 8s refresh)
- Providers convert attachments to their own API format (base64, URL, etc.)

## 13. Boot as composition root → Package ✅ (added April 2026)
`packages/boot/` owns all wiring. Registrar functions are pure: `(runtime, config) → void`. Each registrar handles one concern (providers, channels, hooks, tools, memory, agents). The runtime never imports concrete plugin types — boot does that.

## 14. Type safety enforcement → Strict ✅ (added April 2026)
Every package has a `typecheck` target that runs `tsc --noEmit`. All 21 packages must typecheck clean. This is enforced via `npx nx run-many -t typecheck` in CI. No new type errors are accepted.

## 15. Memory-quality pipeline → v5 (local, thinking, faithful) ✅ (added April 2026)

After a 10-pick side-by-side probe across cloud (Grok, Claude) and local (Gemma-E2B) summarizers, the v5 pipeline replaces v4 with:

- **Local-first summarization on CPU** — Gemma-4-E2B with thinking mode on, 128k context, no truncation, 7k/14k/20k token budgets. Summaries stay on-box (no cloud dependency, no context leakage).
- **Rich message formatting** — ISO-minute timestamps, agent attribution, conversation preamble (id/channel/title/span). Addresses recency discrimination (same-day iterations look different) and multi-agent attribution.
- **Exhaustiveness + system-messages-first-class** in the prompts — cloud models were prone to topic-narrowing (picking one theme and dropping others) and collapsing dense system-message state into prose. Explicit rules preserve both.
- **Async tool-call content synthesis** — new `ros_tool_synth_queue` + compaction-worker drain + CLI backfill. Previously-empty assistant rows (tool_name + tool_args only) now get a natural-language sentence so they can be FTS/vector searched.
- **Hardened undici client** — no headersTimeout/bodyTimeout (summarization of 60k-token prompts was hitting Node's default 300s header timeout mid-processing). AbortSignal is the only stop condition; 3 retries with 5/10/15s backoff.

**Why CPU, not GPU:** A separate investigation measured systematic quality degradation on V100 via llama.cpp's CUDA kernels (~50% output density reduction vs. CPU, regardless of flash-attn on/off, q8_0/f16 KV cache, or model size). See daily notes 2026-04-18 for the full write-up. End state: summarization + tool-synth stay on CPU; GPUs stay reserved for larger-model inference, embeddings, and training.

**Validation methodology:** pick 10 representative summaries spanning size and model era, regenerate with each prompt variant, spot-check every identifier against source. Ship when zero hallucinations + exhaustiveness holds. Artifacts: `/rivet-shared/summary-refine/results-v4-cpu/`.
