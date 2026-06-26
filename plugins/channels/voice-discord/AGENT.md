# voice-discord — local provider (Rivet Local by voice)

Goal: in a Discord **voice** channel, Rivet Local auto-joins when an allowed user
joins, and holds a spoken conversation powered entirely by the local GERTY stack
(no cloud). Text chat is handled separately by the normal Discord text channel.

This is the "Her live loop" the Telegram async bridge doc deferred — but turn-based,
because the local models are request/response, not duplex like xAI Realtime.

## Two paths in this plugin
- **Cloud realtime** (existing): `VoiceSession` → `XAIRealtimeClient` / `GeminiLiveProvider`.
  Duplex PCM streaming; the cloud does VAD + STT + LLM + TTS in one socket. Untouched.
- **Local turn-based** (new, `provider: 'local'`): `LocalVoiceSession`. We do our own
  silence-VAD on the inbound PCM, then STT → **the real `local` agent** → TTS → playback.

## Why "through the real agent"
Phil's call (2026-06-26): voice turns must hit the actual `local` RivetOS agent so they
get full memory, tools, identity — same brain as text/Telegram. The clean way to do that
without touching the turn handler: the plugin registers itself as a **`Channel`**
(`ctx.registerChannel`). A finished transcript is emitted as a normal `InboundMessage`;
the agent's reply comes back via `Channel.send()`, where we synthesize and play it.

```
user speaks in VC
  → @discordjs/voice receiver → prism Opus decode → PCM 24kHz mono 16-bit
  → Endpointer (RMS silence VAD, silenceDurationMs) buffers the utterance
  → on end-of-speech: resample 24k→16k → POST :9000 qwen3-asr → transcript
  → channel.messageHandler(InboundMessage{ text: transcript })   ← runtime turn pipeline
  → local agent runs (memory/tools/persona, qwen-27b @ :8003)
  → reply text → channel.send({ text })
  → POST :9001 qwen3-tts (VoiceDesign, Rivet's warm-male instruct) → WAV 24kHz mono 16-bit
  → strip WAV header → AudioPlayer.playAudio(pcm) → resample 24k→48k stereo → VC
```

## GERTY endpoints (verified live 2026-06-26, on $GERTY_HOST)
- LLM  `:8003` `qwen-27b` (aggressive-w4a16-awq-nomtp) — the local agent's model.
- STT  `:9000` `qwen3-asr` — `POST /v1/chat/completions`, input_audio (wav base64).
- TTS  `:9001` `qwen3-tts` — `POST /v1/audio/speech`, VoiceDesign (task_type+instructions).
  Returns **WAV PCM 16-bit mono 24000 Hz** = AudioPlayer's native input. No resample needed.

## Key facts / contracts
- `AudioPlayer.playAudio(pcm)` wants **24kHz mono 16-bit LE PCM**; `endResponse()` ends a turn.
- The Discord receiver subscribes with `EndBehaviorType.Manual` (never auto-ends on silence)
  — so the **Endpointer must do its own VAD**. xAI relied on server VAD; local can't.
- `RegistrationContext.registerChannel(channel)` exists → no core changes required.
- Reply goes back per-(channelId:userId) queue → turnHandler → `channel.send`. One active
  VC session at a time (VoicePlugin.session), so send() targets that session.

## Voice
Rivet Local's own self-chosen voice (VoiceDesign instruct) — see
`/rivet-shared/bin/rivet-local-voice.v2.md`. Warm, natural male; calm; a little texture.

## Build / deploy
- Dev in this worktree (branch `feat/voice-discord-local-provider`, off `main`).
- Deploy target: **CT114** (the live `local` node). Additive only — no casual restarts.
  Add a `channels.voice` block to CT114 config with the **new** "Rivet Local Voice" bot
  token (separate app from the text bot — one bot per gateway). Build, deliberate restart,
  test live in the VC.

## ⚠️ BLOCKER — GERTY qwen3-tts caps output at a fixed ~2.16s
Verified 2026-06-26: every TTS request returns exactly 103724 bytes (2.16s) regardless of
input length (21→93 chars all identical). Short replies render fully + trailing silence;
anything longer is hard-truncated mid-word. STT (qwen3-asr) is fine.

Root cause (high confidence): the TTS serve command uses `--generation-config vllm`, which
forces vLLM's default generation settings instead of the model's `generation_config.json`
(low default max output tokens). Request-level `max_tokens`/`max_completion_tokens` do NOT
override it. Serve cmd on pve3:
  vllm-omni serve /opt/vllm/models/qwen3-tts-voicedesign-w4a16 \
    --deploy-config /opt/quant-work/voice-gpu-stack/qwen3_tts_split.yaml --omni \
    --served-model-name qwen3-tts ... --generation-config vllm
Fix (Phil's lab box — needs his ok, restart of :9001): try `--generation-config auto` (use the
model's own config), or set a high max output-token budget in the deploy-config / generation
config, then re-test with the length sweep. Chunking in the plugin mitigates but the cap is too
low (~2s) for natural speech, so the server fix is the real unblock.

## Status
- [x] local-voice.ts (STT/TTS/Endpointer/chunking, ASR parse) — typechecks, builds
- [x] LocalVoiceSession + VoicePlugin-as-Channel — typechecks, builds
- [x] provider switch + config (index.ts manifest, validate/types.ts) — typechecks
- [x] STT verified end-to-end against live GERTY (parse fix confirmed)
- [ ] BLOCKED: TTS truncation (server-side, see above) — must lift before voice is usable
- [ ] deploy + test on CT114 (needs Phil's bot token + the TTS fix)
- Waiting on Phil: (1) fix/greenlight the qwen3-tts output cap on pve3; (2) fresh Discord server
  (guild/VC/text IDs), "Rivet Local Voice" bot token (Guilds + GuildVoiceStates intents),
  invites, confirm Discord user ID for allowlist.
