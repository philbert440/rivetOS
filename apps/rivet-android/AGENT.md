# AGENT.md — RivetHub

> Continuity doc for any agent (future Rivet, any model) picking up this project.
> Live-update this as you go. Companion deep-dive: `RIVET-AGENT-RUNTIME-PLAN.md`.

## What this is

RivetHub is Phil's fork of **RikkaHub** (native Kotlin / Jetpack Compose, multi-LLM
Android chat app) being built into a **self-contained on-phone Rivet node**: deep device
access + mesh membership + on-device agents, all in one APK. The point (vs. a stock chat
client) is embodiment — Rivet that can *see and drive the phone* and run *real agents*
on-device, not just chat.

- Project root (on **phildesk**, Windows side): `<project-root>` (on the Windows side of the build machine)
- Edits happen **over SSH**: `ssh rivet@<phildesk-host> '<cmd>'` (file tools run on rivet-claude, not phildesk). Pipe through `grep -v "preserving permissions"` to mute drvfs chmod noise.
- Native Kotlin/Compose, Gradle 9.4.1, KSP/Room, Koin. minSdk 26, **targetSdk 37**.
  `applicationId dev.rivet.app` (`.debug`), namespace `dev.rivet.*`. AGPL-v3 (personal-use free tier).

## Update (2026-07-11) — Phase 1: imported into the RivetOS monorepo

`apps/rivet-android` is now **vendored source in the monorepo** (was a git submodule),
carrying all the Phase 0 sanitization. Key points for anyone working here:

- **Build tool is Gradle, not npm/nx.** The `package.json` exists ONLY to register the
  project in the nx graph with DDD tags (`scope:app`, `type:app`, `domain:interfaces`)
  and boundary enforcement. Real targets are `apk` / `apk-release` / `check` / `verify`
  (gradle wrappers) — deliberately NOT named `build`/`test`/`lint`, so CI's Android-SDK-less
  nx sweeps skip the project. Same "builds live where an SDK lives" posture as the Tauri
  desktop shell. CI needs zero android changes.
- **Headless build host**: pve3 `/root/rivethub-monorepo-build` (JDK 21, SDK
  `/opt/android-sdk`) — rsync `apps/rivet-android/` over, `./gradlew :app:assemblePhilDebug`.
  phildesk lost its Android toolchain in the CachyOS reinstall.
- `material3/material-color-utilities/` is now **vendored source** (was a nested git
  submodule); `material3/build.gradle.kts` adds `material-color-utilities/kotlin` as a
  srcDir. Don't re-add it as a submodule.
- Signing keystore stays OUT of the tree (kept on the build host, copied to its `~/.android/`).
- The standalone `rivet-android` GitHub repo is being archived; the monorepo is canonical.

## Update (2026-07-11) — Phase 0: config-first sanitization (branch `phase0-sanitize`)

Part of the full-node parity plan (`/rivet-shared/plans/android-node-parity-plan.md`).
The repo is being prepared for monorepo import: NOTHING environment-specific or private
may exist in the tree or in any build.

- **Firebase REMOVED entirely** (analytics/crashlytics/remote-config + google-services
  plugin). No more google-services.json requirement. remote_config_defaults.xml (which
  shipped upstream's base64 SiliconCloud API key!) deleted.
- **UpdateChecker/UpdateCard REMOVED** — pointed at updates.rivet-ai.com, a domain we do
  NOT own (blind rikka→rivet rename of upstream's update host = supply-chain hole). Same
  for the dead RivetHubAPI/Retrofit client (api.rivet-ai.com) — deleted, retrofit deps dropped.
- **All RIVET_* BuildConfig fields REMOVED.** Mesh/datahub/WG coordinates now live in a
  user-editable `MeshConfig` (PreferencesStore) with a Settings → Node & Mesh page
  (SettingMeshPage.kt); `MeshRuntimeConfig` (net/) is the @Volatile snapshot for
  non-Compose consumers, seeded by RivetHubApp collecting settingsFlow. RivetVpn,
  RivetRuntime.baseEnv, NodeStatusStrip all read it. local.properties now only carries
  sdk.dir + signing.
- **rivet-shared overlay rev 3**: wrapper takes RIVET_SHARED_HOST/EXPORT from env
  (exported by baseEnv from settings); errors clearly if unset — no baked default host.
- Upstream leftovers purged: web-ui/, FUNDING.yml, ZH READMEs, fork-era plan docs,
  AGENTS.md, donate QR, sponsor README. README rewritten as RivetHub. Only surviving
  "rikka/rerere" strings = JitPack dep coordinates + imports + license attribution (by
  design — see the plan's import bar).
- **Existing installs must re-enter mesh config in Settings → Node & Mesh after this
  update** (BuildConfig values are gone; probe/VPN/memory stay off until configured).
- **Canonical remote is now GitHub `philbert440/rivet-android`** (branch `rivet`) — the
  phildesk-hosted repo died with the CachyOS reinstall. Headless build host: pve3
  `/root/rivethub-build` (JDK 21 system, SDK at /opt/android-sdk) — phildesk currently
  has NO Android toolchain.

## Current state (2026-06-09)

- **Rebrand done** — RikkaHub→RivetHub, `me.rerere`→`dev.rivet` across all modules, emerald-on-dark theme (default), hex-nut icon. Builds + deploys.
- **Device access LIVE** — `dev.rivet.app.device`: an Accessibility service (eyes+hands: tap/swipe/type/global-nav/UI-tree) hosting a loopback control server on `127.0.0.1:9876` (token-guarded; `GET /status` open, `GET /ui` + `POST /action`). Token is written to `/sdcard/rivet/control.json` (needs All-Files-Access) so an on-device agent under another uid can read it. Verified end-to-end.
- **LLM bridge** — on-device Claude/Grok CLIs fronted by an OpenAI-compatible localhost server on `:8765` (models `rivet-claude`/`rivet-grok`). Currently runs in **Termux** (tmux session `bridge`). Chat works in-app via the "Rivet" provider.
- **Exec wall BEATEN** — a bundled **static busybox** (`jniLibs/<abi>/libbusybox.so` + `useLegacyPackaging=true`) runs **under RivetHub's own uid** at targetSdk 37 (verified: `id` → RivetHub uid, `sh` applet works). This is the unlock that makes the in-app runtime real. Spike code: `DeviceControl.execTest()` (strip later).
- **OOTB providers cleaned** — `DefaultProviders.kt` rewritten to ship ONE "Rivet" provider (Claude + Grok via the bridge), no third-party gateways.
- **proot BYPASSES W^X — PROVEN under RivetHub (2026-06-09).** Decisive 5-test matrix via the new
  loopback `POST /exec` diag endpoint: W^X is real (app-data busybox direct exec → `EACCES`), but
  the SAME app-data busybox runs fine **launched via proot** (exit 0, uid `u0_a478`, targetSdk 37).
  proot's loader maps guest ELFs in userspace, so the kernel never `execve`s an `app_data_file`.
  **→ Architecture decided: full Linux rootfs in app-data via proot. No per-binary `.so` repackaging.**
  Gotcha beaten: Termux's proot HARDCODES its loader path to Termux's private `applib/` (no
  `PROOT_LOADER` env support) — unreadable by RivetHub's uid. Fixed by binary-patching the path
  string in `libproot.so` to `/data/data/dev.rivet.app.debug/files/pl.so` and symlinking that
  (in `setupRuntimeScaffold`) to the real loader in the executable nativeLibDir.
  Bundled jniLibs now: `libproot.so` (patched), `libproot-loader.so`, `libtalloc.so` (+ busybox).

## Update (2026-06-11f) — grok parity (bridge v2.5) + agent-model status line

- **`7ca73089`/`191561da` status line shows the BACKING model** ("Fable 5"), not the bridge
  slot: bridge forwards claude's assistant-event `message.model` as `rivet_model` on the
  final SSE chunk (ignoring `<synthetic>` from error turns); app threads it through
  `MessageChunk`/`UIMessage.agentModel`; `prettyAgentModel()` in ChatPage.kt formats it.
- **`62e01820` grok parity.** EMPIRICAL (grok 0.2.45): `--output-format streaming-json`
  emits ONLY `thought`/`text`/`end` — no tool, usage, or model events; `json` is equally
  bare. But the session's `chat_history.jsonl` gets structured `assistant.tool_calls` /
  `tool_result` entries as the turn runs, and its system entry names the model ("You are
  Grok 4.3 …"). Bridge v2.5 tails that file (700ms poll from the spawn offset) during
  resume turns and scans once at close for create turns → same `rivet_tools`/`rivet_model`
  SSE shape as claude. Verified live on a scratch :8767 bridge (tools arrived mid-turn on
  resume). **grok records NO token usage anywhere** → no context meter for grok turns.
  App: human titles for grok tool names; `ask_user_question` feeds suggestion chips
  (claude shape + flat options/choices fallback — grok's actual schema is undocumented).
- **xAI imggen key**: entered via device-control UI automation into the imggen settings
  sheet (datastore `xai_image_api_key`) and saved to Rivet's 1Password ("xAI API Key
  (RivetHub imggen)", Private vault). BUT api.x.ai rejects it (400 incorrect API key,
  tested directly) — waiting on Phil to re-check/regenerate at console.x.ai.
- UI-automation gotcha: the drawer "Menu" popup's Image Generation entry — tap its text
  bounds while the popup is FRESH; a stale tap lands on the chat list / terminal beneath.


## Update (2026-06-11g) — the mid-turn-send wedge fix (`d95e7330`)

(`d95e7330` also re-landed grok parity byte-identical to `62e01820` — a parallel context
raced the commit; HEAD is correct, see 11f below for the parity details.)

- **Mid-turn send wedge** (found in the field — it broke the dev conversation): sending a GUI
  message while a bridge turn streamed used to `previousJob.cancel()` → GUI stream dies, CLI
  keeps running, an EMPTY assistant node persists, and from then on transcript-sync prefix
  alignment fails forever (the empty node never matches the real reply in the session file).
  Fix: bridge conversations queue the new send behind the in-flight job
  (`ConversationSession.setJob(cancelPrevious=false)` + completion handler only clears its own
  job); plus `handleMessageComplete.onCompletion` drops an all-empty trailing assistant node
  (NonCancellable save). Unwedging an ALREADY-broken thread is manual: delete the divergent
  messages in the GUI (empty bubble + unanswered tail), reopen → sync re-imports as text.
- Diagnosing this required reading the app DB from inside the rootfs: ControlServer `/exec`
  (app uid) can `cp /data/data/dev.rivet.app.debug/databases/rivet_hub*` into the rootfs, then
  node's built-in `node:sqlite` (node 22) reads it. message_node table = one row per node.
## Update (2026-06-11e) — Phil's feedback round 1 (four fixes, built from the phone node)

Phil ran the Phase 1–3 build and gave four cleanups; all landed (`75ef2145`…`1d374038`):
- **`6ae6cebe` chat↔terminal handoff no longer loses turns.** Root cause was TWO-sided:
  (a) terminal→chat: `--resume` terminal sessions were killed on navigation away (the old
  stale-state guard), so an agent turn running in the TUI died mid-flight; (b) chat→terminal:
  escalating mid-turn resumed a disk snapshot WITHOUT the in-flight turn, which forked on
  first input. Now: ALL terminal sessions persist across navigation; staleness is handled
  surgically — `ChatService.handleMessageComplete` calls
  `TerminalSessionStore.dropForConversation(conv)` the moment a GUI bridge turn starts, so
  the next escalate re-resumes from disk with the new turns. And `TerminalPage` knows its
  `conversationId` (threaded through `Screen.Terminal`), watches
  `ChatService.getGenerationJobStateFlow`, and defers the resume spawn until an in-flight
  GUI turn completes ("attaches when it finishes" note). TRUE realtime mirroring of an
  in-flight terminal turn into the chat list (tail-follow of the session jsonl) remains the
  Phase-3 "agentic turn rendering" follow-up.
- **`89b56b38` rabbit spinner → Rivet nut.** rikkahub's bunny AVD deleted; new
  `rivet_loading.xml`: face-on hex nut ratcheting one flat (60°) per 900ms tick (keyframes:
  hold → overshoot to 67° → settle on 60°; hex symmetry makes the loop seamless).
  `RabbitLoadingIndicator` → `RivetLoadingIndicator` (RivetLoading.kt).
- **`75ef2145` a11y dot is now reactive.** Was a 20s drawer-gated HTTP poll of :9876/status;
  toggling the accessibility service didn't move it. The ControlServer lives in-process, so
  `RivetAccessibilityService` now exposes a `connected: StateFlow<Boolean>` (set in
  onServiceConnected/onUnbind) and NodeStatusStrip collects it — instant, no polling.
- **`51959653` context meter + bridge v2.4.** Bridge captures the claude `result` event's
  `usage` and emits it OpenAI-shaped on the final SSE chunk (`prompt_tokens` folds in cache
  read+creation, so it ≈ the session's real context size). App already merged chunk usage
  into the last assistant message; the chat TopBar subtitle now appends ` · 87k/43%` from the
  latest assistant usage vs. per-model windows (claude 200k / grok 256k, `contextWindowOf`
  in ChatPage.kt). Grok usage not wired (its streaming-json shape differs — follow-up).
  Bridge ships via APK (`installBridge` overwrites unconditionally on launch — no manual copy).
- Gotcha for future greps: TerminalPage.kt contains a NUL byte (the session-store key
  separator in `joinToString`) — plain grep treats the file as binary; use `grep -a`.

## Update (2026-06-11d) — Phase 3 finished: status strip, Terminal chip, agent accents (compiled green, NOT on-device)

Built from the phone node; UI-REFRESH-PLAN Phase 3 is now complete (items 2/tool-rendering
+ chips landed earlier as 2026-06-11b). Three commits:
- **`2ca407ca` node status strip**: `NodeStatusStrip.kt` atop the drawer's RivetNodeControls.
  Four dots: **agent** (bridge `GET :8765/health`, the bridge's only unauthenticated endpoint —
  doubles as the runtime check because RivetRuntimeService exposes NO process-alive state; we
  deliberately folded rather than invent service IPC), **a11y** (`:9876/status` →
  `"accessibility_connected":true` substring — org.json emits no spaces), **mesh** (RivetVpn
  StateFlow directly, zero polling; home-WiFi auto-idle renders as hollow-primary "mesh·home"),
  **hub** (TCP connect <datahub-host>:5432). 20s ticker gated on `drawerState.isOpen` (threaded
  ChatPage→ChatDrawerContent as `drawerOpen`; permanent big-screen drawer = always active);
  tap re-polls. Probes on Dispatchers.IO, 1.5s timeouts, HttpURLConnection (no OkHttp dep).
- **`a77af038` Terminal chip**: ChatPage TopBar escalate action is now a labeled AssistChip
  ("Terminal" + Code icon), same resume/navigation logic, still bridge-chats-only.
- **`72e31d6a` agent accents**: assistant author label tinted per agent — `rivet-claude` →
  colorScheme.primary, `rivet-grok` → tertiary (in `ChatMessageAvatar.kt`). No plumbing needed:
  ChatList already resolves per-message modelId → Model and passes it down. Display-only.
**Untested on device**: strip dot truthfulness (esp. mesh·home state + drawer-open gating),
chip layout width in the TopBar, accent visibility in dark theme. Phase 3 item 5 (StatsPage
repurpose) remains unscheduled.

## Update (2026-06-11c) — UI refresh Phase 2 SHIPPED to repo (compiled green, NOT yet on-device)

Three commits from the phone node, one per plan item:
- **`9e6cc76c` imggen → xAI-only**: ImgGenPage/VM hardwired to `api.x.ai` + `grok-2-image` via an
  on-the-fly `ProviderSetting.OpenAI` (no provider/model pickers). xAI rejects OpenAI's
  `size`/`quality`/`style` → `OpenAIProvider.generateImage` omits `size` for `api.x.ai`; no
  `/images/edits` there → reference-image/edit flow + aspect-ratio UI deleted. Key = single field
  in the imggen settings sheet, stored as standalone datastore string `xai_image_api_key`
  (no xAI slot existed; least-invasive source). `imageGenerationModelId` pref now unused by imggen.
- **`1c2b3281` speech slim-down**: deleted Gemini/Groq/Qwen/MiMo/MiniMax/xAI TTS +
  Volcengine/DashScope ASR (files, sealed subtypes, manager branches, configure UIs, MiMo tests).
  Kept SystemTTS + OpenAI-compat TTS, OpenAI Realtime ASR, AsrButton waveform. **Datastore
  migration**: PreferencesStore filters stored ttsProviders/asrProviders JSON to known `type`
  discriminators BEFORE polymorphic decode (else kotlinx throws and the whole settings read dies);
  unknown selectedTTSProviderId → system TTS. Default OpenAI TTS slot re-pointed AiHubMix→
  api.openai.com (same id). NOTE: no volume-key push-to-talk exists in the code (plan said "keep"
  but there's nothing — the volume-key listener is chat scroll); no PTT toggle added.
- **`c745c030` settings IA**: hub regrouped Node (web server) / Chat (model, TTS, MCP, color
  mode, preferences) / Data (backup, files, request logs) / About. Headers hardcoded English.

All compiled green on phildesk (`:app:assembleDebug`; one Windows file-lock flake on
`:ai:bundleLibCompileToJarDebug` — fix: `gradlew --stop` + delete the intermediates dir).
**Needs on-device check**: imggen end-to-end with a real xAI key; speech page after upgrade with
old stored providers (the decode fallback); settings hub layout.

## Update (2026-06-11b) — Phase 3 chat-sync: tool-call rendering + question chips (compiled green, NOT yet on-device)

Built from the phone node. Two commits: `88be3ea5` (bridge v2.3) + `be76caa2` (Kotlin).
- **Tool-call rendering (claude)**: bridge forwards stream-json `assistant`/`user` tool events
  as a custom SSE delta `rivet_tools: [{id,name,arguments}|{id,output}]`. App parses these in
  `ChatCompletionsAPI.parseMessage` into **executed** `UIMessagePart.Tool` parts (display-only)
  → existing ChainOfThought tool-step UI renders collapsible blocks. **Never** emit OpenAI
  `tool_calls` from the bridge: `GenerationHandler` would try to execute them ("tool not found"
  error output) and then loop an extra generation turn. Bridge flushes an output for every
  started tool by stream close so no turn ends with an unexecuted tool (same loop hazard).
  Human titles for claude tool names (Ran/Edited/Read/…) in `ChatMessageTools`. Grok tool
  events: follow-up (different stream shapes).
- **Question chips**: EMPIRICAL — headless `claude -p` DOES fire AskUserQuestion (full
  structured questions/options in the tool_use input) but the CLI **instantly auto-cancels** it
  (tool_result `is_error:true`, "Answer questions?"); it never blocks, and the model continues
  with "dialog was cancelled" text. So: the tool part reaches the app like any other tool;
  `ChatService.generateSuggestion` extracts option labels → `chatSuggestions` → existing chips
  row; `ChatPage` chip tap now **submits directly** (falls back to filling input while
  generating). The tapped answer is just the next plain `--resume` user turn — no dangling
  tool_use to satisfy.
- Bridge tested end-to-end on a scratch :8767 instance (one-shot turns only; live :8765 +
  session maps untouched). Kotlin compiled green on phildesk. **Untested on device**: real GUI
  chat turn with tools, chip tap→submit, suggestion persistence. Deployed bridge copy at
  `~/rivet-bridge/rivet-bridge-server-v2.js` NOT updated — ships via APK (RivetRuntime copies
  assets on launch) or copy manually + restart the bridge.

## Update (2026-06-11) — UI refresh Phase 1 + new icon SHIPPED (on-device, Phil-approved)

Driven from the **phone node itself** (Rivet-Claude in-app; repo cloned `~/projects/rivet-android`,
gh authed as rivetphilbot — phone now has gh/op/gws creds mirroring CT115). **`UI-REFRESH-PLAN.md`
is the plan doc** (Phil's keep/cut calls recorded: imggen→xAI-only, voice→minimal TTS+PTT,
search→cut, assistants→two fixed agents; future track: clean-room realtime zh⇄en translator).
- **Phase 1 deletions** (`cb24c12a`…`e07b7cba`, −6.8k lines): donate+nag, translator, About
  de-RikkaHub'd (Source→github), extensions hub (5 pages), web-search UI (module orphaned, not
  removed), provider mgmt → DeveloperPage-only, assistant gallery unreachable (model + routes kept
  — picker still works), backup local-only. Compiled green first try. `enableWebSearch`/
  `sponsorAlertDismissedAt` datastore fields remain (surgery deferred).
- **New launcher icon** (`eaa7d83c`): outlined 🔩 bolt + solid nut at 45°, flat
  philtompkins.com style; keyline gap via clip-path; monochrome layer for Material You.
  Legacy mipmap PNGs NOT regenerated (minSdk 26 → adaptive XML is what renders; regen before
  any store listing).
- **Delivery that worked**: phildesk build (`app-arm64-v8a-debug.apk` — NOTE: ABI splits, there
  is no `app-debug.apk`) → wireless adb died twice (bedtime mode kills WiFi xfers) → final path:
  scp → `/rivet-shared` → `rivet-shared get` into rootfs → ControlServer `/exec` (`{"cmd":
  ["sh","-c",…]}` JSON-array form) cp to `/sdcard/Download/` → Phil tap-installed.
- Phase 2 (imggen/speech strip-down, settings IA) + Phase 3 (node status strip, tool-call
  rendering, escalation promotion) NOT started — see the plan doc.

## Update (2026-06-10)

Self-contained runtime is live (rootfs bundled in-APK; both agents + terminal + chat mirror work).
Today's shipped builds (HTTP-served at `http://<rivet-claude-host>:8088/`, filename = git SHA):

- **Grok chat mirror FIXED** (`5b0309d`). Root cause: grok runs from `/root/rivet-bridge`, not
  `/home/rivet`, so its sessions live under `sessions/%2Froot%2Frivet-bridge/<id>/` while the
  reader assumed `%2Fhome%2Frivet`. Fix: `SessionTranscript.grokFile()` locates the session by
  its unique id across **all** cwd-encoded dirs (freshest wins); `ChatService.mergeTranscriptTurns()`
  now finds the **alignment offset** so grok's injected `<user_info>` preamble turn is skipped to
  where the real conversation lines up. grok's `chat_history.jsonl` = `{type, content}`, content a
  string or `[{type:text,text}]` — the existing parser handles it. (Pending Phil's on-device check.)
- **Eastern time** (`5b0309d`): rootfs defaulted to UTC; pinned `TZ=America/New_York` in `baseEnv`
  so all proot procs (agents + terminal) report local time.
- **Track B — sidebar SSH toggle SHIPPED** (`1669659`/`eb7e642`). Dropbear baked into the rootfs
  (Ubuntu noble arm64, `dpkg-deb -x`; full lib closure verified) + shipped as a **608KB overlay
  asset** (`rivet-dropbear.bin`, committed) that `ensureDropbear()` drops into an existing rootfs on
  launch — because the full rootfs only re-extracts on a *wiped* install, so an app update alone
  never adds new rootfs files. Key-only (`~/.ssh/authorized_keys` = rivet-claude key). Drawer
  toggle → `RivetRuntimeService` supervises it + `PARTIAL_WAKE_LOCK` (survives doze).
  **✅ SSH WORKING 2026-06-10 (`ad5ba3c`)** on Pixel 10 Pro / Android 16. Diagnosed via adb logcat
  (wireless adb — `adb pair`/mDNS auto-connect). Two real causes (the seccomp/`set_robust_list`
  guess was WRONG; the /proc-entropy SELinux denials were red herrings):
  1. **proot can't `execveat()` by fd** (termux/proot-distro#595). dropbear's per-connection child
     re-execs itself via `fexecve` → `proot error: execveat() with non-AT_FDCWD fd not supported`
     → child dies before banner. **Fix**: cross-compiled dropbear 2024.86 arm64 with
     `DROPBEAR_REEXEC=0` (toolchain `gcc-aarch64-linux-gnu`; also password-auth off → bundled
     libtom, needs only libc; **drop the `-s` flag** — compiled out).
  2. **proot can't chown/chmod a system pts** as the non-root app uid → `pty_setowner` did
     `dropbear_exit`. **Fix**: patched `sshpty.c` to warn-not-exit on chown/chmod failure.
  Also: `sshCommand` uses proot **`--kill-on-exit`** so toggling SSH off kills dropbear instead of
  orphaning it (was → "Address already in use" loop). `ensureDropbear` now re-extracts on
  `DROPBEAR_OVERLAY_REV` change (now **rev 3**) so updates replace the old binary.
  **✅ FULL-PTY DONE 2026-06-10 (`c70a3d5`)** — `ssh -t rivet@<phone>:8022` → `/dev/pts/0`, TERM,
  inside the rootfs as `uid=1000(rivet)`, termios live. Replaced the proot-wrapped in-rootfs
  dropbear with a **native (bionic/NDK r27c) dropbear running OUTSIDE proot** (the Termux way):
  shipped as `libdropbear.so`/`libdropbearkey.so` jniLibs; `sshCommand()` launches it native with a
  forced command that `exec`s `proot … /bin/bash -l` per session, so the pty is allocated host-side
  and each session inherits a real ctty. `ensureNativeSsh()` gens a persistent ed25519 host key
  (dropbearkey jniLib) + stages authorized_keys into an owner-only (0700/0600) home. The whole
  rootfs-overlay path (`ensureDropbear`, `rivet-dropbear.bin`, `DROPBEAR_OVERLAY_REV`) is retired.
  **6 source fixes** (all in `native/dropbear/android.patch`), each found by on-device bisection:
  getpwnam-from-env shim, `/etc/shells` skip, Termux `pty_make_controlling_tty` rewrite (no
  `TIOCSCTTY`), the 3 `svr-chansession.c` pty fixes (reopen-slave-before-close-master / ignore
  SIGHUP across the close / skip utmp), `MULTIUSER 0` (the app-uid seccomp fix — see below) +
  the `common-session.c` non-multiuser-kernel guard removal. Build DYNAMIC not `-static`.
  **App-uid seccomp gotcha**: validating native daemons via `adb shell` (the looser `shell` domain)
  HIDES the bug — as `untrusted_app`, dropbear's `setegid`→`setresgid` (syscall 149) for reading
  authorized_keys is SIGSYS-killed; `MULTIUSER 0` compiles out all privilege-drops. Always test as
  the app uid. Full recipe + the gotcha are in **`native/dropbear/README.md`** (+ `prebuilt/`).
- **Track C — sidebar Terminal launcher** (`d900796`): standalone root `Terminal` (proot bash, not
  tied to a conversation) above the SSH toggle in `RivetNodeControls`. Drawer cleanup: Stats label
  zh→en. **Build-id**: git short SHA stamped into the `[dev <sha>]` banner (`BuildConfig.GIT_SHA`).

**Build/deliver**: commit on rivet-claude → push GitHub → phildesk pulls (`git.exe`) + builds
(`setsid … gradlew.bat :app:assembleDebug`) → scp APK to `/tmp/apkserve/rivethub-<sha>.apk` on
rivet-claude → Phil downloads from phone browser. **GOTCHA**: when the STORED rootfs asset
*changes*, do `gradlew clean` (incremental packaging leaves ~259MB of dead slack → 597MB APK).
**Phone**: `<phone-ip>`; Termux sshd as a debug beachhead needs a non-8022 port (dropbear squats
8022) and `$(command -v sshd)` absolute path; Termux is uid-isolated from RivetHub's sandbox/files
but CAN reach its loopback control server (`127.0.0.1:9876`, token in `RIVET_BRIDGE_TOKEN`).

**Emulator (phildesk, for UI checks only — Phil's call 2026-06-10)**: AVD `rivet_test` (x86_64,
android-34 google_apis). Drive via `adb.exe` (Windows binary — **pass it Windows paths**, not
`/mnt/c/...`). Boot headless: `emulator.exe -avd rivet_test -no-window -no-audio`. The **UI/Compose
layer runs fine via the image's arm64 translation** (validated Track C drawer + `[dev <sha>]`
banner), BUT the **arm64 runtime can't run** — busybox SIGSEGVs (exit 139) under translation, so the
rootfs never extracts; proot/node/dropbear would too. **No arm64 system image is offered for this
x86 Windows host**, so a faithful runtime test would need a separately-built **x86_64 rootfs**
(Phil deferred that). ⇒ emulator = UI/navigation validation only; runtime bits (grok mirror,
terminal shell, dropbear) still need the phone.

Queued: dropbear crash (needs on-device error), Track D mesh-node status (WireGuard + rivet-memory
plugin in rootfs → datahub `ros_messages`), Track E productionization (strip `/exec` devToken,
reassemble asset to fold in prepare() patches, bake git into rootfs).

## The vision (confirmed by Phil, 2026-06-09)

A self-contained app where:
- It ships with **only Rivet's provider**, preconfigured. No setup beyond logging in.
- The in-app **terminal is a first-class environment** (run anything), not just a login box.
- **Headline feature — chat⇄CLI session escalation:** while chatting with Claude/Grok in
  the GUI, a **button drops you into `claude-code` / `grok-build` in the in-app terminal,
  resuming the *same* conversation** (and back). GUI = casual surface; CLI/TUI = full agent;
  one continuous session.

**Mechanism (the crux):** GUI chat and CLI session are the **same session**. The bridge
stops stateless one-shots and drives the real CLI with a **resumable session keyed to the
RivetHub conversation**: `conversationId ↔ CLI session-id`. Each GUI message →
`claude -p --resume <convId> "<msg>"`; the button → terminal at `claude --resume <convId>`
(full interactive TUI, same history + tools). **Both Claude Code and grok-build support
`--resume` + session-ids** → design the escalation **once**, swap the binary, works for both.

_Design lean (Phil's call still open):_ routing GUI turns through `claude -p --resume`
makes each chat message a real agent turn (tools/file-edit/commands), not just text.
Lean = embrace it; the GUI *is* the agent, the button just hands over the terminal.

## Build sequence

1. ✅ **Clean OOTB providers** — done (`DefaultProviders.kt`).
2. ⏭️ **In-app runtime** — terminal + `claude-code`/`grok-build` running under RivetHub's
   uid. **The long pole.** Exec wall already beaten; next spike below.
3. **Session-aware bridge (v2)** — conversation↔session mapping, `--resume`, streaming.
4. **Chat-screen escalation button** — deep-link into the terminal at the right `--resume`.

## ✅ DONE: node runs via proot under RivetHub (full Ubuntu+node userland)

`node v22.22.3 arm64` runs inside a RivetHub-app-data Ubuntu 24.04 rootfs via proot — crypto/OpenSSL
+ fs working, no env hacks. proot 5.1.0 handles glibc 2.39 fine (not too old). Foundation proven.

**Rootfs assembly recipe** (all on rivet-claude — pure file assembly, no arm64 emulation):
1. Ubuntu base: `cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/ubuntu-base-24.04.4-base-arm64.tar.gz`.
2. Node arm64 glibc from `nodejs.org/dist/<v22.x>/node-<v>-linux-arm64.tar.xz` → untar into `rootfs/usr/local`.
3. Add a minimal `etc/ssl/openssl.cnf` (ubuntu-base lacks it; node's OpenSSL init fopens it).
4. **`tar --hard-dereference -czf`** (REQUIRED — busybox tar aborts on hardlinks otherwise).
5. `scp` tar → phone `/sdcard/rivet/`; extract under RivetHub uid via `POST /exec` + busybox:
   `libbusybox.so tar -xzf /sdcard/rivet/rivetfs.tar.gz -C <filesDir>/rootfs`.
6. Run: `libproot.so -r <filesDir>/rootfs -b /dev -b /proc -b /sys -0 /usr/local/bin/node …`
   env: `LD_LIBRARY_PATH=<filesDir/lib>:<NLD>`, `PROOT_NO_SECCOMP=1`, `PROOT_TMP_DIR=<filesDir/tmp>`.

## ✅ DONE: Claude Code runs in-app via proot

`npm i -g @anthropic-ai/claude-code` succeeded inside the rootfs (network via proot works), and
`claude --version` → **2.1.170 (Claude Code)** runs via proot under RivetHub's uid. Endgame validated.

**proot run gotchas (critical):**
- **NEVER set `PROOT_NO_SECCOMP=1`** — ptrace-only mode makes `getcwd` return ENOSYS → node
  `process.cwd()` throws `ENOSYS: uv_cwd` → npm/claude die. Use seccomp mode (proot default).
- Invocation: `libproot.so -r <rootfs> -b /dev -b /proc -b /sys -0 -w /root <cmd>`, env
  `LD_LIBRARY_PATH=<filesDir/lib>:<NLD>`, `PROOT_TMP_DIR=<filesDir/tmp>`, `HOME=/root`,
  `PATH=/usr/local/bin:/usr/bin:/bin`, and **launch host-cwd inside the rootfs**.
- Write `/etc/resolv.conf` (`nameserver 1.1.1.1`) before any network — ubuntu-base has none.

## ✅ DONE: both CLIs run in-app as a non-root `rivet` user, with auth

`claude -p` returns real answers (copied Phil's subscription creds), `grok 0.2.33` runs (xAI's
self-contained static aarch64 binary under `~/.grok`, copied — not npm).

**REQUIREMENT (Phil): claude must run as a non-root `rivet` sudo user**, because Claude Code rejects
`--dangerously-skip-permissions` when `getuid()==0`. Fix: run claude with **`proot -i 1000:1000`**
(`--change-id` → guest sees uid 1000; real syscalls still run as the app uid, which owns the rootfs).
Created `rivet` by appending to `/etc/passwd`+`group`+`shadow` (useradd fails under proot:
`/etc/passwd.lock` missing), added to `sudo` + NOPASSWD sudoers, creds/grok under `/home/rivet`.
Verified `whoami`=rivet and `claude -p --dangerously-skip-permissions` → BYPASS_OK. The bridge must
run claude as rivet via `-i 1000:1000 -w /home/rivet`, env `HOME=/home/rivet USER=rivet` (NOT `-0`).

## ✅ DONE: Bridge v2.2 — session-aware (claude + grok) + REAL streaming, proven end-to-end
`app/src/main/assets/rivet-bridge-server-v2.js`. OpenAI-compatible, runs INSIDE the rootfs as rivet
(`proot -i 1000:1000`). Keys each RivetHub conversation to a CLI session:
- **Sessioning is GATED on the `x-rivet-conversation` header.** Header present → session; absent →
  stateless one-shot. RivetHub's internal title/translate calls won't carry the header, so they
  never spawn/pollute sessions. (Verified: no-header `2+2`→`4`, `rivet_conversation:null`.)
- **claude**: conversationId IS the session id — `--session-id <conv>` (create) / `--resume <conv>`
  (later turns, latest msg only) + `--dangerously-skip-permissions`. Bidirectional create/resume
  reconcile. Optional `-n <title>` from `x-rivet-title` header.
- **grok** (0.2.33 has no `--session-id`): create → capture grok's `sessionId` from JSON → map
  `conv→grokSid` (grok-sessions.json) → `-r <grokSid>` + `--always-approve`. (grok works WITHOUT git
  — git apt-install fails under proot/dpkg broken-pipe; bake git into the rootfs at build time later.)
- **per-conversation lock** serializes turns on a session. JSON parser handles both shapes
  (claude `result`/`session_id`, grok `text`/`sessionId`).
- `/v1/session` (body `{model}`, header conv) → resume info for the escalation button
  (`claude --resume <conv>` or `grok -r <grokSid>`).
- **REAL streaming (v2.2):** `stream:true` pipes CLI token deltas straight to OpenAI SSE. claude
  `--output-format stream-json --include-partial-messages --verbose` → parse `stream_event` →
  `event.delta.text`; grok `--output-format streaming-json` → `{type:"text",data:<chunk>}` (skip
  `type:"thought"`), final `{type:"end",sessionId}`. `streamOnce()` line-buffers stdout, `streamAgent()`
  mirrors the session logic. Sessions persist in stream mode too. Non-stream path keeps buffered JSON.
- Verified: claude 2-turn (COBALT) + grok 2-turn (EMERALD) continuity; claude+grok real streaming
  (grok 15 deltas); no-header one-shot. Ran on :8766 (v1 still on :8765).
- TODO (v2.3 polish): model select (`-m`), per-assistant system-prompt propagation
  (`--append-system-prompt`/grok `--system-prompt-override`), usage/token reporting, cancellation on
  client disconnect, git baked into the rootfs at build time.

## ⏭️ NEXT: Part B (app-side Kotlin) + Part C (session capture) — SEE `PART-B-PLAN.md`
**`PART-B-PLAN.md` is the grounded plan** (real file:line touchpoints from a codebase Explore pass).
Summary; full detail in that doc:
- **B1 ✅ DONE** (commit `aee7abc`): inject `x-rivet-conversation` (+ `x-rivet-title`) header on chat
  requests, gated to the Rivet bridge provider + real conversations only (title/translate stay
  header-less one-shots). Threaded `conversationId`/title `ChatService.handleMessageComplete` →
  `GenerationHandler.generateText/generateInternal` → `customHeaders`. Bridge already consumes both.
- **B4a ✅ DONE** (commit `1a02079`): `RivetRuntimeService` (specialUse foreground service, modeled on
  `WebServerService`) auto-launches the proot+node bridge on :8765 and keeps it alive (backoff,
  output→logcat). `RivetRuntime` holds the idempotent host scaffold (filesDir symlinks, tmp/lib,
  resolv.conf, rivet user, bundled bridge JS + token into the rootfs) + the canonical launch recipe.
  Started from `RivetHubApp.onCreate` (gated on POST_NOTIFICATIONS). Token/port extracted as
  `RIVET_BRIDGE_TOKEN`/`RIVET_BRIDGE_PORT` consts. **Replaces the manual `/exec` assembly.** Reads the
  rootfs from `<filesDir>/rootfs` (already present on the dev device). NEEDS a phildesk build + on-device
  test: install → grant notifications → confirm the bridge auto-starts (logcat tag `RivetBridge`) and
  in-app chat works with NO Termux/tmux bridge running (stop the old :8765 first — port conflict).
- **B4b** (needs the phone): rootfs delivery = **BUNDLED APK ASSET** (Phil's call 2026-06-09; offline-first,
  self-contained). Produce a canonical `rootfs.tar.gz` from the device rootfs, bundle at
  `app/src/main/assets/`, extract into `<filesDir>/rootfs` on first run when absent (busybox `tar` jniLib).
  Decide git-LFS vs direct commit for the ~84MB asset.
- **B3 ✅ DONE** (commits `17bc99c`+`f76a829`): in-app Terminal tab. NOT vendored — used the JitPack
  artifact `com.termux.termux-app:terminal-view:0.118.0` (brings terminal-emulator + prebuilt
  `libtermux.so` forkpty for all ABIs, **no NDK build**; JitPack repo was already configured).
  `TerminalPage` (`ui/pages/terminal/`) hosts `TerminalView` via Compose `AndroidView`, backed by a
  `TerminalSession` whose forkpty execs `libproot.so` (same W^X bypass as the bridge). One combined
  `RivetTerminalClient` implements both `TerminalSessionClient` + `TerminalViewClient`; ESC/TAB/
  CTRL-C/CTRL-D/arrows keycap row; tap→soft-keyboard. `RivetRuntime.terminalCommand()` = PTY-shaped
  proot launch (shares invariants with `bridgeCommand` via extracted helpers). `Screen.Terminal(title,
  launchCommand)` route + entry in `RouteActivity`.
- **B2 ✅ DONE** (commit `690d0d4`): escalate-to-terminal button (`HugeIcons.Code`) in `ChatPage`
  `TopBar` actions, shown only for Rivet-bridge convs. claude + has-messages → `claude --resume <conv>`;
  else interactive shell. (Grok sid-resume via the bridge `/v1/session` is a follow-up; falls back to bash.)
- **Whole Part B stack compiles green** (B1+B4a+B3+B2). B4b (rootfs asset) still pending.
- **B1/B4a VERIFIED on-device** (Phil, 2026-06-09): bridge auto-launches, chat works. One bug found:
  switching models mid-conversation muddled context (claude read grok's prior turns as its own).
- **Cross-agent attribution fix** (commit `1d75da3`): app emits OpenAI `name` per assistant message
  (modelId resolved from the message's model Uuid via `providerSetting.models`, in `ChatCompletionsAPI`);
  bridge `flatten` labels each prior turn by author ("rivet-grok"→"Rivet-Grok") and ends the create-seed
  with the CURRENT model's label. So a joining agent sees the other agent's turns attributed, not as its
  own. Per Phil's call: keep full cross-agent context, clearly attributed. Only affects the session-create
  seed; resumes/same-agent chats unchanged.
- **Combined APK delivered** (`/sdcard/Download/rivethub-partB.apk`, 85MB, B1+B4a+B3+B2+attribution-fix)
  for Phil to test the muddle fix + the headline chat⇄terminal escalation. B4a copies the asset bridge on
  launch so the fix goes live on first open of the new build.
## ▶️ NEXT SESSION (post-compaction) — see `PART-B-PLAN.md` "POST-COMPACTION PLAN" section
Polish since validation (all delivered via HTTP download, builds `aee7abc`→`50b1684`): session
threading, auto-launch bridge, terminal + escalation, attribution fix, agent context + device
control, **B4b self-contained rootfs**, claude/grok native fixes, PATH, terminal argv[0] + env +
keys-above-keyboard + sticky CTRL/ALT + session-ended overlay, **grok/claude session resume**,
**persistent shells / re-resume agents in sync**, **per-conversation model memory**,
**chat⇄CLI mirror** (`SessionTranscript` reader → thread). Remaining (in the plan): grok back-sync,
**app-managed dropbear SSH toggle** (retire Termux), **sidebar terminal-session toggle + cleanup**,
**full mesh-node status** (WireGuard, rivet-memory plugin in rootfs → datahub `ros_messages` +
offline outbox = Part C, register as `rivet-phone`), and productionization (strip devToken backdoor,
reassemble asset, SHA in `[dev]` banner). Build/deliver infra + `/exec` debug recipe are in the plan.

## ✅ B4b DONE + in-app CLI VALIDATED 2026-06-10 — both agents on RivetHub's own runtime
The app is now self-contained: bundled rootfs, app-owned bridge, no Termux. **Claude AND Grok both
answer in-app chat through RivetHub's own `:8765` bridge.** Hard-won; the saga + gotchas:
- **Why B4b became urgent:** an *uninstall* (not update) wiped the app's private `filesDir/rootfs`
  (the hand-assembled spike rootfs). The app couldn't self-heal (no bundle), so chat silently fell back
  to the leftover Termux `tmux bridge` on :8765 while the app's own bridge never came up and the terminal
  said "runtime not installed". **Lesson: app-private rootfs dies on uninstall → MUST bundle.**
- **Off-device rootfs assembly** (`/tmp/rootfs-build/` on rivet-claude): pulled the staged tarballs off
  the phone's `/sdcard/rivet/` (rivetfs base+node, grok-home, claude-creds — all SCP-able, no token), added
  the claude arm64 binary via `npm install --os=linux --cpu=arm64 --ignore-scripts @anthropic-ai/claude-code`,
  trimmed grok's 2 stale binary versions, tarred (259MB gz / 777MB extracted).
- **GOTCHA — AGP auto-gunzips `.gz` assets at build time:** a `rivet-rootfs.tar.gz` asset got silently
  gunzipped+renamed to `rivet-rootfs.tar` (794MB) and DEFLATED in the APK → `assets.open()` threw
  FileNotFoundException (wrong name) + too big to open compressed. **Fix: neutral `.bin` extension (no
  auto-gunzip) + `androidResources { noCompress += "bin" }` so it's STORED/mmap-openable.** Verify with
  `python3 zipfile`: entry must be `assets/rivet-rootfs.bin` compress=STORED.
- **GOTCHA — proot guest needs `PATH`:** baseEnv set HOME/USER/LD_LIBRARY_PATH but not PATH → bridge's
  `spawn claude` hit Android's /system/bin → ENOENT. **Fix: `PATH=/usr/local/bin:/usr/bin:/bin...` in baseEnv.**
- **GOTCHA — claude-code native binary:** `--ignore-scripts` skipped install.cjs, so `bin/claude.exe`
  stayed the 500-byte placeholder stub that just echoes "claude native binary not installed". **Fix
  (Phil's call — switch method): skip the node launcher entirely, point `/usr/local/bin/claude` straight
  at the standalone native binary `…/claude-code-linux-arm64/claude` (self-contained, like grok).** Done in
  `RivetRuntime.ensureClaudeNativeBinary()` (runtime patch in prepare(); the asset itself is still staged wrong).
- **Delivery: HTTP, not scp.** 337MB scp to the phone kept dying (exit 137) + Termux sshd keeps dropping on
  screen-off. Serve the APK from rivet-claude (`python3 -m http.server 8088` in `/tmp/apkserve/`, mesh IP
  <rivet-claude-host>) → phone browser downloads `http://<rivet-claude-host>:8088/rivethub-<sha>.apk` (resumable, no sshd).
  Stamp builds with the git short-SHA in the filename so Phil knows which is latest.
- **Debug `/exec` backdoor (commit ed6ccd3):** ControlServer accepts `RIVET_BRIDGE_TOKEN` in DEBUG builds so
  remote `/exec` doesn't depend on the per-install control token reaching `/sdcard` (needs All-Files-Access,
  which kept being revoked by uninstalls). **STRIP before any non-debug ship.**
- **Commits:** `2e7de5b` B4b bundle+extract, `8568682` .bin/noCompress fix, `ed6ccd3` PATH+devToken,
  `e206445` claude-native-direct. Asset (`rivet-rootfs.bin`, 259MB, gitignored) staged on phildesk.

### Still open (post-validation)
- **Terminal** still errors `proot error: '<rootfs>' is not a regular file` — bridge proot (ProcessBuilder)
  works, terminal proot (Termux TerminalSession PTY) doesn't → likely a TerminalSession arg/env/cwd
  difference (env REPLACE vs ProcessBuilder MERGE is the lead). Debug via `/exec` once Termux is stable.
- Stamp the build SHA into the in-app `[dev]` banner. Strip the devToken backdoor. Reassemble the asset
  correctly (so ensureClaudeNativeBinary isn't needed). Retire the Termux bridge for good.

## ✅ Agent self-context + device control wired (commit `f5ce231`, APK `rivethub-agentctx.apk`)
The
  escalated agents didn't know they're on the phone, and COULDN'T reach the control API (proot binds only
  /dev,/proc,/sys → the app's `/sdcard/rivet/control.json` is invisible in the rootfs). Fix: ship
  `CLAUDE.md`+`GROK.md` as assets (agent bearings + correct device-control how-to from `ControlServer.kt`:
  127.0.0.1:9876 `/status` `/ui` `/action{click,swipe,text,global,node_click,launch,intent}`, X-Rivet-Token,
  UI-driving gotchas); `RivetRuntime.installAgentContext()` writes the .md into `/home/rivet` (write-IF-ABSENT
  so agent memory edits persist) + writes the control token+port to `~/.rivet/control.json` INSIDE the rootfs
  (refreshed each launch; same token `DeviceControl.getControlToken` that ControlServer validates). Device
  control needs the RivetHub a11y service enabled (`/ui`/`/action` → 503 otherwise; `/status` always works).
- **Part C** (Phil 2026-06-09): capture every agent turn → RivetOS datahub (`<datahub-host>`) as searchable
  memory, **offline-tolerant** (mobile device often off-mesh). REUSE the rivet-memory capture hook
  (fires for bridge `-p` AND terminal turns); add a local durable **outbox** + a **mesh-aware sync worker**
  (WireGuard+datahub reachable → flush, idempotent record UUIDs, confirmed-ingest-only). Confirm the
  datahub ingest interface/schema; prefer token-auth HTTP ingest over PG creds in the APK.
- Stay on **Ubuntu**. (A lightweight "RivetOS Linux" rootfs is OUT OF SCOPE — a whole separate future
  project, not this roadmap. Just keep the rootfs base loosely swappable so it *could* drop in later.)

## On-device state to resume from (after compaction)
- Phone `<phone-ip>` (IP drifts), ssh `-p 8022 u0_a470@<ip>` from rivet-claude (its key only).
- RivetHub debug build installed; rootfs assembled at `<filesDir>/rootfs` (Ubuntu24.04+Node22, rivet
  user uid 1000, claude+grok+creds in `/home/rivet`). NLD =
  `/data/app/~~2AMN_e6B8WD9lpcBldV8Gg==/dev.rivet.app.debug-T-FHP4bGtyn23GhJNwCgBQ==/lib/arm64`
  (re-read from `GET /scaffold` after any reinstall — it changes). Bridge token persisted at
  `<rootfs>/home/rivet/rivet-bridge/token` = `wmpPrPAYbhB8UaEfFC61uR`.
- Bridge **v2.2 running on :8766** (test); Phil's **v1 still on :8765** (the in-app provider points here).
- Repo cloned for exploration at rivet-claude `~/rivet-android` (shallow). Canonical working tree +
  builds = phildesk `/mnt/c/Users/philb/Desktop/rivet-control-center` (commit via the Windows
  `git.exe`; push with `gh auth token` piped over stdin).

### Spike scaffolding (strip before ship)
`DeviceControl.execTest/runExec/setupRuntimeScaffold`, ControlServer `POST /exec` + `GET /scaffold`,
the app-data busybox copy. Keep for now — `/exec` is the workhorse driving the assembly phase.
Driver on phone: `~/exec-probe.py` (env `KEY=VAL` before `--`, argv after). Reads token from
`/sdcard/rivet/control.json`, POSTs `/exec` (supports `__CWD=path` pseudo-env → host launch dir).
proot run env: `LD_LIBRARY_PATH=<filesDir/lib>:<NLD>`, `PROOT_TMP_DIR=<filesDir/tmp>` (loader path baked
into the patched binary). **NEVER set `PROOT_NO_SECCOMP=1`** — it breaks `getcwd` → node `process.cwd()`
ENOSYS. Run claude/node as rivet: `-i 1000:1000 -w /home/rivet`, env `HOME=/home/rivet USER=rivet`,
and launch host-cwd inside the rootfs.

## Practical runbook

**Build (detached — phildesk OOM-kills heavy foreground SSH jobs):**
```
ssh rivet@<phildesk-host> 'cd /mnt/c/Users/philb/Desktop/rivet-control-center && \
  setsid bash -c "/mnt/c/Windows/System32/cmd.exe /c gradlew.bat :app:assembleDebug \
  --console=plain > build.log 2>&1; echo EXIT=\$? >> build.log" < /dev/null >/dev/null 2>&1 &'
```
Must use the **full path** to cmd.exe (bare `cmd.exe` loses WSL-interop PATH → exit 127).
Poll `build.log` for `BUILD SUCCESSFUL` / `EXIT=`.

**Deploy:** pull arm64 APK to rivet-claude `/tmp` → scp to phone `/sdcard/Download/` →
`termux-open`. Updates keep the signature (same debug keystore).

**Phone access:** reach the phone **directly from rivet-claude** (only its key is authorized):
`ssh -p 8022 u0_a470@<phone-ip>`. The mesh IP **drifts** (was `.211`, now `.215`); if
unreachable, get the current one with `ip -4 addr` in Termux, and ensure WireGuard + `sshd`
(`$PREFIX/bin/sshd`) are up.

**Device control:** read token from `/sdcard/rivet/control.json`, then curl `127.0.0.1:9876`.
UI-automation helper: `/tmp/dev.sh` on rivet-claude (tap/text/global/swipe/dump → parses `/ui`).

**Bridge restart:** `tmux new-session -d -s bridge "~/bin/ubuntu \"export TMPDIR=/root/.tmp; node /data/data/com.termux/files/home/rivet-bridge-server.js\""` (token `1fi9y47WZqA64RjU8L9ROWzL`).

## Gotchas (the expensive-to-relearn ones)

- **Android package-visibility:** `pm`/`dumpsys`/`logcat` from Termux can't see other apps —
  don't trust them to confirm install/version; the running app or `/status` is ground truth.
  Termux can't read RivetHub's logcat (no READ_LOGS) → surface results via `/sdcard/rivet/`.
- **Sideloaded a11y:** Android 14+ blocks enabling Accessibility until
  Settings→Apps→RivetHub→⋮→"Allow restricted settings". MANAGE_EXTERNAL_STORAGE lives under
  Settings→Apps→Special app access→All files access (not the normal Permissions list).
- **UI automation on Compose:** controls are mostly unlabeled (find by `clickable` bounds);
  the soft keyboard reflows coordinates every keystroke (fill one field, re-dump, never batch
  on stale coords); dismiss keyboard with one BACK before tapping a covered button; first list
  row clips under sticky search headers (filter to surface it). **A screenshot endpoint
  (`takeScreenshot`) is the missing piece that makes UI automation reliable** — worth building.
- **PreferencesStore provider merge** only re-adds *missing* defaults + refreshes
  builtIn/description; it does NOT overwrite baseUrl/apiKey/models on existing installs →
  clear app-data / fresh-install to see the OOTB provider config.

## Track D — rivet-phone mesh node: SCOPED + DE-RISKED 2026-06-10 (HYBRID, Phil's call)
Memory = HYBRID: rivet-memory plugin in rootfs for recall + capture; app/replay for offline resilience.
**De-risking done (foundations proven):**
- **Phone reaches datahub PG directly** on home WiFi (`<datahub-host>:5432` OPEN from the rootfs). So
  recall+capture are buildable/testable NOW; WireGuard is only the off-WiFi layer → DEFER.
- **rivet-memory plugin is pure Node.js** (rootfs already has node), does BOTH recall (MCP server
  `plugins/transports/mcp-server/dist/cli.js --stdio`) AND capture (async non-blocking hooks:
  UserPromptSubmit/PostToolUse/Stop/SubagentStop/SessionEnd → `providers/claude-cli/dist/hooks.js`
  → PG). Both read `RIVETOS_PG_URL` (+ optional `RIVETOS_EMBED_URL=http://<embed-host>:9402`) from
  env or `~/.rivetos/.env`. Capture is **idempotent by session_key + advisory lock** (no double
  ingest) → the "offline outbox" is just a REPLAY (re-run capture when back on-mesh; dedup is free).
- **Write path = direct PG INSERT** into `ros_messages`/`ros_conversations` (adapter.ts); a PG
  trigger auto-enqueues embedding. **No HTTP ingest API exists.** Schema confirmed (see memory).
- **THE WRINKLE**: shipped `dist/cli.js`+`hooks.js` are tiny tsc transpiles, NOT self-contained —
  they import the whole `/opt/rivetos` workspace + node_modules. → must **esbuild-bundle** them into
  2 standalone files (pg inlined) to ship into the rootfs, not drag node_modules.
**Go-forward (in order):**
1. esbuild-bundle MCP server + hooks → 2 standalone .js; write rootfs `~/.rivetos/.env` (PG+embed
   URL from rivet-claude's `~/.rivetos/.env`); register plugin in rootfs `~/.claude`+`~/.grok`
   (plugin dir at `/opt/rivetos/integrations/{claude-code,grok}/rivet-memory/`). Bake into
   `prepare()`/rootfs asset for persistence. → on-device memory_search recall + auto-capture.
2. Replay layer (network-regained → re-run capture over recent transcripts; idempotent).
3. WireGuard auto-up (off-WiFi); register `rivet-phone` in mesh.json; phone `rivetos update` path.

## Track E — productionization: E1/E4 DONE 2026-06-10 (`add4c49`)
- E1 (/exec devToken) already `BuildConfig.DEBUG`-gated → R8 strips it from release; comment fixed.
- E4: removed DeviceControl.execTest + setupRuntimeScaffold + GET /scaffold + isSymlink (dead spike;
  prepare()/relink already makes the symlinks). Kept runExec + POST /exec. Built+installed+smoke-OK.
- **E2/E3 STILL OPEN** (polish, not blocking): rebake the 259MB rootfs asset with the prepare()
  patches (claude symlink, .claude.json trust, rivet user, PATH) + `git` installed, so prepare()
  patches become no-ops. Needs qemu-aarch64-static on the build host to apt into the arm64 rootfs.

## Track D — MEMORY LIVE ON-DEVICE 2026-06-10 (both agents are mesh nodes)
**✅ Recall + capture working on the phone for BOTH agents, verified end-to-end to the datahub.**
- **Recall**: esbuild-bundled the RivetOS MCP server (`mcp-server/dist/cli.js`) into a standalone
  15MB `.mjs` (createRequire banner for ESM dynamic-require; `--external:pg-native`; pure node, no
  python). On-device `claude` + `grok` both call `memory_search`/`browse`/`stats` over it against
  the shared datahub (`<datahub-host>`). MCP runs in `--stdio` mode (logs→stderr, JSON-RPC→stdout).
- **Capture**: claude via the rivet-memory hooks bundle (5 events); grok via its own
  `grok-memory-capture` bundle (7 events). Both write directly to `ros_messages`/`ros_conversations`
  (PG trigger auto-embeds). Idempotent by session_key (advisory lock) → re-runs dedup.
- **Identity (Phil): per-agent.** Each agent's hook launcher exports its own `RIVETOS_CAPTURE_AGENT`:
  `rivet-phone-claude`, `rivet-phone-grok` (and eventually **`rivet-phone-local`** for the on-device
  local model). CAPTURE_AGENT is hardcoded in the RivetOS source, so the bundles are patched to
  `process.env.RIVETOS_CAPTURE_AGENT || '<default>'`.
- **Install (live, in the running rootfs)**: claude plugin at `/opt/rivet-memory/`, grok at
  `/opt/rivet-memory-grok/`; `~/.rivetos/.env` holds `RIVETOS_PG_URL`+`RIVETOS_EMBED_URL`
  (`<embed-host>:9402`); claude registered via `~/.claude.json` mcpServers + `~/.claude/settings.json`
  hooks; grok via `~/.grok/config.toml [mcp_servers.rivetos]` + `~/.grok/hooks/rivet-memory.json`.
- **Artifacts stashed** at `/rivet-shared/rivet-phone/memory-plugin/` (bundles + plugin dirs +
  env template) for the persistence bake. Bundle recipe: `esbuild <dist/cli.js|hooks.js|grok cap>
  --bundle --platform=node --format=esm --banner:js="<createRequire>" --external:pg-native`.
- **GOTCHAS** (each cost a debug cycle):
  - grok rejects a hook file with ANY top-level key besides `hooks` → STRIP the `description`
    field from `~/.grok/hooks/rivet-memory.json` or grok silently skips it.
  - MCP server defaults to TCP `:5700`; the plugin launcher passes `--stdio` (required).
  - esbuild normalizes string quotes — patch the bundle for `CAPTURE_AGENT` matching the BUNDLED
    quote style (`"rivet-grok"`, not the source's `'rivet-grok'`).
  - grok runs as the `rivet` user, HOME=/home/rivet (NOT /root); config at `~/.grok`.
  - grok wants `git` (not in rootfs yet → noisy but non-fatal `git_cli` errors) — see E3.
**REMAINING D**: (1) persistence — bake the install into `prepare()`/rootfs asset (ship the 3
bundles as APK assets + an `ensureMemoryPlugin()` like `ensureNativeSsh`); currently survives app
updates but NOT a wiped reinstall. (2) offline replay (re-run capture when back on-mesh; idempotent).
(3) WireGuard auto-up (the SSH/WiFi drops mid-session are the doze issue) + register `rivet-phone`
in mesh.json + phone `rivetos update`. (4) future `rivet-phone-local`.

## Track E (E2/E3) — ROOTFS REBAKED 2026-06-10 (git + TZ-fix + plugin baked; validated on-device)
Rebaked the rootfs asset (259MB→275MB) on rivet-claude and validated the exact mechanism live:
- **TZ WAS NEVER ACTUALLY FIXED** (Phil's catch): the rootfs had no `tzdata`/zoneinfo, so
  `TZ=America/New_York` silently fell back to UTC (`date` showed UTC labeled "America", `%Z`=America).
  Fixed: installed `tzdata` + symlinked `/etc/localtime`→America/New_York. Now `date` → **EDT**,
  verified on the live phone (`14:12 EDT` vs the old `18:12 UTC`).
- **git 2.43.0** added (stops grok's noisy `git_cli` errors). Validated running on the phone.
- **HOW (apt-under-qemu hangs)**: `apt` deadlocks under proot+qemu ("Reading package lists…" → 0% CPU,
  even with `APT::Sandbox::User=root`). rivet-claude (unprivileged LXC) also can't register binfmt.
  → **download the arm64 `.deb`s + `dpkg-deb -x`** them into the rootfs (no qemu execution; resolve
  Filenames from the rootfs's `var/lib/apt/lists/*_main_*Packages`, base `ports.ubuntu.com/ubuntu-ports`).
  git deps: libpcre2-8-0, liberror-perl, libcurl3t64-gnutls, git-man (+ libc/zlib already present).
- **Baked**: the memory plugin (`/opt/rivet-memory{,-grok}` + bundles), claude `.claude.json`
  mcpServers+trust + `.claude/settings.json` hooks, grok `config.toml [mcp_servers.rivetos]` +
  `.grok/hooks/rivet-memory.json` (description-stripped), the prepare() patches (rivet user, claude
  native symlink). Secret PG/embed URLs are NOT baked — injected via `baseEnv` from BuildConfig
  (`local.properties`: `rivetPgUrl`/`rivetEmbedUrl`, gitignored).
- **Asset**: re-tarred `tar czf` (gzip), staged on phildesk `app/src/main/assets/rivet-rootfs.bin`
  (gitignored). MUST `gradlew clean` (STORED-asset slack → 615MB APK otherwise).
- **Rebake env on rivet-claude**: `/tmp/rootfs-rebake/` (proot+qemu-user-static; will be wiped).
  Bundles + plugin stash durable at `/rivet-shared/rivet-phone/memory-plugin/`.
- **REMAINING validation**: fresh-install test (`pm clear` → rootfs re-extracts the baked asset →
  SSH self-provisions from baked authorized_keys + host-key regen; recall/capture via baseEnv creds;
  git/TZ from the asset). Destructive (resets POST_NOTIFICATIONS, accessibility, the SSH toggle pref)
  → needs UI re-grant + SSH-toggle, so it's a Phil-driven step. git+TZ already validated live via the
  same debs; plugin already validated live; asset round-trips md5-identical.

## Track D — /rivet-shared access: DESIGN DECISION 2026-06-10 (libnfs helper, agent-mediated)
**Decision (Phil): the agent IS the interface to /rivet-shared — no transparent mount.**
- `/rivet-shared` is an NFS4 export from the datahub (`<datahub-host>:/rivet-shared`, ~49G). Every
  mesh node kernel-mounts it; the phone CAN'T (unrooted Android + proot = no `mount`/`CAP_SYS_ADMIN`,
  no unprivileged user-ns, no FUSE — even Termux needs root for FUSE; WireGuard's only carve-out is
  the `VpnService` TUN API, which has no filesystem equivalent).
- **How unrooted Android NAS apps do it**: userspace protocol libs (`libnfs` for NFS, `libsmb2`/jcifs
  for SMB) — they're the *client*, no mount; expose to other apps via SAF/`DocumentsProvider`
  (`content://` URIs, not POSIX paths). Real mounts (CifsManager etc.) need root.
- **Our approach**: a **`libnfs`-based helper baked into the rootfs** (`nfs-ls`/`nfs-cp`-style or a
  thin `rivet-shared get/put/ls` wrapper) that reads/writes the share **directly over WireGuard** —
  no root, no mount, no sync-staleness (live protocol access), just not a transparent dir. The
  on-device agents call it; **Phil drops files in by telling grok/claude to** ("put this in
  rivet-shared/plans") — the agent has device access + the helper, so it's the natural UX.
- **Gated on WireGuard** for remote (on home WiFi the NFS port `:2049` is already reachable —
  verified). Fold the libnfs helper into the WireGuard work. (`libnfs` is portable C, arm64 —
  deb-extract `libnfs14` + build/grab the `utils` tools, same pattern as git.)
- Alternative if ever rooted: real `mount -t nfs … over WG` + symlink. Root is the ONLY path to a
  true live mount; not planned.

## ▶ NEXT SESSION (post-compaction pickup) — updated 2026-06-11
LIVE + committed (HEAD `a45267e`+, branch `rivet`, 0 unpushed). Build/deploy + debug recipe unchanged
(see "Practical runbook"). **All the 06-11 loose ends are DONE+verified** (/rivet-shared, offline replay,
terminal-already-fixed, mesh.json registration, doze-survival). Only Phil's `pm clear` fresh-install
confirm + future `rivet-phone-local` remain. The `## /rivet-shared PLAN` below is kept as the executed record.

### ✅ DONE (2026-06-10 → 06-11)
- **Offline capture replay — DONE + verified on-device (`a45267e`).** The bundled capture's spool is
  ephemeral (its detached worker deletes the spool file even on PG-write failure) → captures made off-mesh
  were lost. Added `/opt/rivet-memory-offline.sh` (sourced by both hook launchers): persists every payload
  + argv to a durable outbox (`~/.rivetos/offline-spool/{claude,grok}`) and replays the backlog — idempotent
  by session_key, original event preserved per entry — once a TCP probe shows datahub PG reachable. Detached
  drain (hook still returns in ms). `MEMORY_OVERLAY_REV` 1→2. Scripts tracked in `overlay-src/rivet-memory/`.
  Verified on-device: offline→1 entry persisted (not drained); online→backlog drained to 0. **Test gotcha:**
  the launcher re-sources `~/.rivetos/.env` (`set -a`) which OVERRIDES a test's `RIVETOS_PG_URL` env prefix
  with the real reachable URL — to fake offline, also set `RIVETOS_ENV_FILE=/nonexistent`.
- **Terminal proot — ALREADY FIXED (`2ce70c7` env-inherit + `7ab2c53` argv[0], 06-10).** The AGENT.md
  "REMAINING" note predated the fix (like the grok-escalation item); 7 follow-on terminal-feature commits +
  the identical proot path working via dropbear this session corroborate it. `terminalCommand()` merges
  `System.getenv()` (ANDROID_ROOT/ANDROID_DATA) + baseEnv. No GUI re-render this session (a11y was disabled
  by reinstalls — orthogonal).
- **mesh.json registration — DONE (durable, in `/rivet-shared/mesh.json`, NOT repo).** Added a `rivet-phone`
  node: `role:agent`, `status:offline`, host `<device-mesh-ip>:8022`, agents `[rivet-phone-claude,rivet-phone-grok]`,
  metadata marks it non-deployable. **Safe:** `update --mesh` eligibility = `status==='online' || (role &&
  role!=='agent')`, so an offline agent is SKIPPED (verified: eligible=phildesk,ct114; skipped=rivet-phone);
  `prune()` only flips stale agents to offline and NEVER deletes (and skips already-offline) → the entry is
  permanent. Backup `/rivet-shared/mesh.json.bak-*`.
- **Battery-opt / doze survival — VERIFIED.** App is in the deviceidle whitelist (`user,dev.rivet.app.debug`
  — persistent), `RUN_ANY_IN_BACKGROUND: allow`, holds a `RivetHub:ssh` wakelock, `RivetRuntimeService
  isForeground=true` (SYSTEM_ALLOW_LISTED). Forced deep IDLE: stayed whitelisted, service foreground,
  wakelock held (`isFrozen=false`), **dropbear reachable through doze**. Restored ACTIVE clean.
- **`/rivet-shared` mesh drive — DONE + verified end-to-end (`5182e2e`/`395ca21`).** On-device agents
  read+write the mesh `/rivet-shared` via a userspace libnfs client (no kernel mount) wrapped as
  `rivet-shared ls|cat|get|put`. Baked as `rivet-shared-overlay.bin` (arm64 nfs-ls/cat/cp/stat +
  libnfs.so.14 + the wrapper + a /usr/local/bin PATH symlink) → `ensureRivetShared()` rev-gated
  busybox-tar extract (no proot register — symlink baked in). Source tracked in `overlay-src/rivet-shared/`
  (wrapper + `build-overlay.sh`). Agent context (CLAUDE.md/GROK.md) documents it. **Verified:** non-root
  libnfs v4 de-risk → on-WiFi proot round-trip → off-WiFi round-trip through the relay (tun0 `<device-mesh-ip>`)
  → on-device `claude -p` discovered + used it from natural language; file landed **uid 2000, mesh-readable**.
  **INFRA CHANGES MADE (not in repo — durable, see memory):** datahub `/etc/exports` += `insecure` on
  `<lan-subnet>` and a new `<mesh-subnet>(...,insecure,all_squash,anonuid=2000)` line (`exportfs -ra`;
  backups `/etc/exports.bak-*`); rivet-prod relay `ufw route allow <device-mesh-ip> -> <datahub-host>:2049`.
  **uid gotcha (fixed in rev 2):** home-WiFi export is `no_all_squash`, so the proot guest (uid 1000) wrote
  files owned 1000 (mesh rivet 2000 couldn't read) — wrapper now claims `?uid=2000&gid=2000` (libnfs honors
  it) → 2000 on both paths.
- **`/rivet-shared` mesh drive — DONE + verified end-to-end (`5182e2e`/`395ca21`).** On-device agents
  read+write the mesh `/rivet-shared` via a userspace libnfs client (no kernel mount) wrapped as
  `rivet-shared ls|cat|get|put`. Baked as `rivet-shared-overlay.bin` (arm64 nfs-ls/cat/cp/stat +
  libnfs.so.14 + the wrapper + a /usr/local/bin PATH symlink) → `ensureRivetShared()` rev-gated
  busybox-tar extract (no proot register — symlink baked in). Source tracked in `overlay-src/rivet-shared/`
  (wrapper + `build-overlay.sh`). Agent context (CLAUDE.md/GROK.md) documents it. **Verified:** non-root
  libnfs v4 de-risk → on-WiFi proot round-trip → off-WiFi round-trip through the relay (tun0 `<device-mesh-ip>`)
  → on-device `claude -p` discovered + used it from natural language; file landed **uid 2000, mesh-readable**.
  **INFRA CHANGES MADE (not in repo — durable, see memory):** datahub `/etc/exports` += `insecure` on
  `<lan-subnet>` and a new `<mesh-subnet>(...,insecure,all_squash,anonuid=2000)` line (`exportfs -ra`;
  backups `/etc/exports.bak-*`); rivet-prod relay `ufw route allow <device-mesh-ip> -> <datahub-host>:2049`.
  **uid gotcha (fixed in rev 2):** home-WiFi export is `no_all_squash`, so the proot guest (uid 1000) wrote
  files owned 1000 (mesh rivet 2000 couldn't read) — wrapper now claims `?uid=2000&gid=2000` (libnfs honors
  it) → 2000 on both paths.
- **WireGuard mesh VPN** — in-app `VpnService` (wireguard-android GoBackend) → **rivet-prod Azure relay**
  (static `<relay-endpoint>`, peer `<relay-pubkey>`) → home mesh. **Auto-OFF on the home subnet**
  (`RIVET_HOME_SUBNET=<home-subnet-prefix>`), UP when away (NetworkCallback reconcile in `RivetRuntimeService`).
  Verified on+off wifi end-to-end. Root cause of the hunt = **Azure NSG silently dropped inbound UDP**
  → fixed with NSG rule `Allow-WireGuard-33050` on `AdapifyProd2nsg839`. Relay does SNAT(→`<peer-mesh-ip>`)
  + least-priv ufw route (datahub:5432 + pve3:9402 ONLY — verified blocks other mesh hosts). datahub
  pg_hba += `<mesh-subnet> md5` (off-wifi PG source is the SNAT id). Commits `fa4afcd`/`3151fec`/`117d1af`.
  Full design in memory `rivet-conduit-android-app.md` "MESH VPN DONE".
- **Security hardening** (`09035fa`): `/exec` route DEBUG-only; DebugPage long-press entry DEBUG-gated;
  control token no longer logcat-logged in release; `/sdcard` control.json export DEBUG-only (in-app
  agents read the rootfs `~/.rivet/control.json`); `runExec` timeout(2m)+output(512KB) caps. Plus
  `reconcileVpn` surfaces up()-failure / down()-mismatch in the notification; WG-key corruption logs
  loudly + preserves the bad file (no silent peer-orphaning).
- **Memory plugin BAKED — self-provisions on a FRESH install** (`ensureMemoryPlugin`, `5f07259`/`740f60d`/
  `b323050`). Ships `/opt/rivet-memory{,grok}` + `register-memory.sh` as an APK asset overlay
  (`rivet-memory-overlay.bin`, 5.2MB, **tracked in git**), extracts via busybox tar, then runs an
  idempotent `register-memory.sh` inside proot reproducing the verified-live config (claude
  `~/.claude.json` mcpServers + `~/.claude/settings.json` hooks; grok `config.toml` mcp + `~/.grok/hooks/
  rivet-memory.json`). Rev-marker gated (`MEMORY_OVERLAY_REV`). VERIFIED on-device: wiped `/opt` → the
  build re-provisioned everything. **Definitive pm-clear fresh-install test still Phil's to run.**
- **Hygiene**: [[host-inventory]] has `rivet-phone`(`<device-mesh-ip>`); `[dev <sha>]` banner confirmed wired to
  `gitSha()`; dead `ProviderConfigure` debug block removed. **#4 grok-escalation sid-resume = ALREADY
  done** (ChatPage.kt:534 `grok --resume <sid>`; the audit flag was a stale AGENT.md note).

### Judgment calls (documented, not skipped)
- **Encrypt-at-rest = accepted-risk.** Control token (SharedPrefs) + WG key (filesDir 0600) are both
  app-private (unreadable without root/backup extraction); the real leak vectors (logcat + /sdcard) are
  now closed; `EncryptedSharedPreferences` is Google-deprecated. Closing the leaks > a deprecated dep.
- **ProGuard obfuscation = deferred (gated).** `-dontobfuscate` removal is a one-liner but changes the
  RELEASE build (can break serialization/reflection) → needs a signed release build + smoke test we don't
  ship yet. Flipping it blind risks a broken APK.
- **mesh.json registration = DONE 2026-06-11** (the old "a hand-edit gets overwritten" worry was wrong:
  `prune()` never deletes and skips already-offline nodes, so a pre-`offline` agent entry is permanent;
  `update --mesh` skips offline agents). See ✅ DONE.

### REMAINING
1. ~~`/rivet-shared` libnfs helper~~ — **DONE 2026-06-11** (see ✅; plan kept below as the record).
2. ~~Offline capture replay~~ — **DONE 2026-06-11** (`a45267e`; durable outbox + replay-on-reconnect).
3. ~~Terminal proot fix~~ — **ALREADY FIXED** (`2ce70c7`+`7ab2c53`, 06-10; the note was stale).
4. ~~mesh.json registration~~ — **DONE 2026-06-11** (rivet-phone offline-agent entry; safely skipped by update).
5. ~~Battery-opt doze durability~~ — **VERIFIED 2026-06-11** (whitelisted + foreground + reachable through doze).
6. **Phil's `pm clear` fresh-install confirm** — the one acceptance test that's HIS to run: `pm clear
   dev.rivet.app.debug` (or reinstall), reopen, confirm rootfs + memory plugin + rivet-shared + offline
   outbox all self-provision from scratch (rev markers gate them; verified piecemeal, not via a full wipe).
7. Future: **`rivet-phone-local`** (third on-device agent; gated on local-model work — see
   [[rivet-local-agentic-tuning]]).

### ⚠️ SESSION GOTCHAS (each cost real time — DON'T relearn)
- **Stale-build trap.** phildesk `git pull --ff-only` SILENTLY fails if an untracked file (e.g. an
  `scp`'d asset) would be overwritten by an incoming *tracked* file → it builds the WRONG commit and you
  chase phantom on-device bugs. NEVER redirect the pull output to /dev/null; ALWAYS verify
  `git rev-parse --short HEAD` == the pushed SHA **and** grep the new symbol in the built source before
  trusting a build. (Remove the untracked file, then re-pull.)
- **Kotlin nests block comments.** A `/*` inside a KDoc (e.g. a `~/.grok/hooks/*.json` path) opens a
  NESTED comment, so the KDoc's `*/` closes *that* → the whole file after is commented out
  (`Missing '}'` + `Unclosed comment` at EOF). Avoid `/*` in comments.
- **USB adb reads flake** when the phone LOCKS (inactivity) or you MOVE the tether: `adb shell svc power
  stayon true` + keep it still. TRUST `logcat` over `run-as` reads. Nested `$(...)` through
  ssh→adb→run-as→sh-c returns EMPTY (quoting) — use plain direct reads. `run-as` CANNOT read `/data/app`
  (the installed APK) — invalid for asset checks.
- **az CLI** is installed on rivet-claude, logged in as `support@adapify` (device-code; no creds in op).
  Azure: VM `AdapifyProd2` / RG `ADAPIFY` / NSG `AdapifyProd2nsg839`, sub Pay-As-You-Go. NSG rules are
  FREE (Phil's cost concern). `az network nsg rule create -g Adapify --nsg-name AdapifyProd2nsg839 ...`.
- **libnfs non-root needs `insecure` export + can claim any uid/gid.** A non-root client binds a high
  source port → the default `secure` export rejects it (`NFS4ERR_PERM`); add `insecure`. AUTH_SYS uid/gid
  are client-asserted, so `nfs://…?version=4&uid=2000&gid=2000` makes writes land as 2000 regardless of
  local uid (verified). libnfs-utils has **no rm** (ls/cat/cp/stat only) — delete mesh-side.
- **Off-WiFi in-proot testing (WiFi-off kills the WiFi dropbear).** Drive it from phildesk over USB:
  `adb forward tcp:8022 tcp:8022` + `svc wifi disable` (VPN auto-ons tun0 in ~2s) + `ssh -p 8022 rivet@localhost`.
  Use **agent-forwarding** (`ssh -A` rivet-claude→phildesk, `-A` again →phone) so rivet-claude's already-
  authorized key reaches dropbear — no new key on Phil's phone. ALWAYS re-enable WiFi in an EXIT trap.
- **heredoc-over-ssh truncates.** `ssh … 'bash -s' <<'EOF'` ran only the first few lines then EOF'd (the
  trap fired but the body never ran). Write the script to a file, `scp` it, run `ssh … 'bash /tmp/x.sh'`.

## /rivet-shared PLAN — ✅ EXECUTED 2026-06-11 (kept as the record; see ✅ DONE above for outcome)
> All steps below were carried out and verified. Deviations from plan: (a) added `&uid=2000&gid=2000` to
> the wrapper URL (the no_all_squash home export otherwise recorded writes as the proot guest uid 1000);
> (b) overlay source is tracked at `overlay-src/rivet-shared/` (build via `build-overlay.sh`), not folded
> into the rootfs rebake; (c) v4 worked cleanly — no v3 fallback needed.

### (original plan — detailed, built 2026-06-11 from live discovery)
**Goal:** on-device agents (claude/grok) read+write the mesh `/rivet-shared` share. **Design (Phil's call):
the agent IS the interface — no transparent mount.** Phone is unrooted + proot → can't kernel-mount (no
`CAP_SYS_ADMIN`/user-ns/FUSE). So: a **userspace `libnfs` client baked into the rootfs**, wrapped as a
`rivet-shared ls|get|put|cat` command the agents call. Phil drops files by telling grok/claude ("put this
in rivet-shared/plans"). Estimated ~½–1 session.

### Discovered facts (live, 2026-06-11)
- **Export:** `nfs://<datahub-host>/rivet-shared`, **NFSv4.2** active, 49G (22G free), port **2049**. Mesh
  nodes kernel-mount `vers=4.2,proto=tcp,sec=sys`.
- **datahub `/etc/exports` ACL:** `<phildesk-host>` (host, all_squash anonuid/gid=2000) + `<lan-subnet>`
  (no_root_squash). **Does NOT include `<mesh-subnet>`** (the relay SNAT identity) and **has no `insecure`**.
- **libnfs:** Ubuntu noble arm64 `libnfs14` + `libnfs-utils` `5.0.2-1build1`, glibc-only (deb-extract-safe,
  same pattern as git/tzdata). Tools: `nfs-ls`, `nfs-cat`, `nfs-cp`. URL: `nfs://<datahub-host>/rivet-shared/
  path?version=4`. Debs: `http://ports.ubuntu.com/pool/main/libn/libnfs/libnfs14_5.0.2-1build1_arm64.deb`
  + `libnfs-utils_5.0.2-1build1_arm64.deb`.
- **Two real gotchas the plan MUST handle:**
  1. **Non-root source port.** A non-root libnfs client (phone = app uid / proot uid 1000) binds a
     **high (>1024) source port**; the default-`secure` export **rejects** it. → the export needs the
     **`insecure`** option for the phone's client(s). (Applies even on home WiFi.)
  2. **NFS version ⇄ firewall.** **NFSv4 needs ONLY port 2049** (no rpcbind/mountd) → clean for the
     least-priv relay. **NFSv3 needs 111 + mountd (random) + 2049** → messy through the relay. libnfs v4
     is *less mature* than v3, BUT the single-port win makes **`?version=4` the choice** (the export is
     v4.2 server-side, so it should serve us). Fallback only if v4 proves too flaky in libnfs: v3 +
     open 111/mountd (set mountd to a static port).

### Required infra changes
- **datahub `/etc/exports`** (ssh `rivet@<datahub-host>`, has sudo): add `insecure` to the phone's reach,
  and add the relay identity for off-WiFi. Add a line (or amend the subnet line):
  `/rivet-shared <mesh-subnet>(rw,sync,no_subtree_check,insecure,all_squash,anonuid=2000,anongid=2000)`
  and add `insecure` to the existing `<lan-subnet>(...)` entry (so the phone works on home WiFi too).
  Then `sudo exportfs -ra`. (all_squash→2000 means the phone writes as the rivet/2000 identity — fine.)
- **rivet-prod relay ufw** (off-WiFi only): `sudo ufw route allow proto tcp from <device-mesh-ip> to
  <datahub-host> port 2049` (mirror the 5432/9402 least-priv pattern). On home WiFi the VPN is auto-off and
  the phone hits datahub directly (no relay) — only needs the `insecure` export change.

### Rootfs / app work
1. **Bake libnfs** — deb-extract `libnfs14` + `libnfs-utils` arm64 into the rootfs (`dpkg-deb -x`, NOT apt;
   extract libnfs14 first). Either fold into the **rootfs asset rebake** OR ship as a small overlay +
   `ensureXxx` (mirror `ensureMemoryPlugin`: a `rivet-shared-overlay.bin` + an `ensureRivetShared()`).
   The latter is lighter + decoupled — preferred. Verify `LD_LIBRARY_PATH` resolves `libnfs.so.14`.
2. **`rivet-shared` wrapper** (`/opt/rivet-shared/bin/rivet-shared`, in the overlay): thin sh over
   `nfs-ls/nfs-cat/nfs-cp` against `nfs://<datahub-host>/rivet-shared/...?version=4`. Subcommands:
   `ls <path>` → nfs-ls; `cat <path>` → nfs-cat; `get <remote> <local>` → nfs-cp nfs://… <local>;
   `put <local> <remote>` → nfs-cp <local> nfs://…. Symlink into `/usr/local/bin`.
3. **Agent context** — add a short "rivet-shared" how-to to the rootfs `CLAUDE.md`/`GROK.md` (installAgentContext)
   so the agents know the command exists + when to use it ("when Phil says put X in rivet-shared").
4. (Optional) expose as MCP tools later so recall/skills can reference shared files.

### Implementation order + verification
1. datahub export `insecure` (+ test from a mesh node that a NON-root libnfs client can `nfs-ls`).
2. Bake libnfs + the wrapper; `ensureRivetShared()`; build + install.
3. **On home WiFi** (direct): `rivet-shared ls plans` then `put`/`get` round-trip → confirm read+write
   (write lands as uid 2000). Drive via USB adb (screen stayon).
4. Add relay ufw 2049 + export `<mesh-subnet>`; **off WiFi** (cellular): repeat the round-trip through the
   relay. Confirm least-priv still blocks everything else.
5. Agent end-to-end: tell on-device claude "put a test note in rivet-shared/plans" → verify it appears.

### Risks / open
- libnfs **NFSv4 maturity** — if `nfs-cp`/`nfs-ls` misbehave on v4 (the 5.0.2 caveat), fall back to v3 +
  static mountd port + open 111/mountd through the relay (messier). Test v4 early (step 1).
- `all_squash`→2000 means no per-agent identity on writes (everything = rivet). Acceptable for a shared drop.
- No TLS/Kerberos (sec=sys) — fine inside the WG tunnel / on the trusted mesh LAN.
- Keep the relay least-priv tight: only `<datahub-host>:2049`, nothing else new.

## Update (2026-06-11g) — bridge v2.6: grok over ACP (supersedes the v2.5 session-file tail)

NOTE: commit `d95e7330`'s message describes the v2.5 chat_history tail, but its CONTENT is
v2.6 — two Rivet instances were working the same repo in parallel (GUI conversations "Android
cleanup" and "Check memory") and the second commit swept up the first's staged work. The tree
is correct; trust the file, not that message.

- **grok turns now run over ACP** (`grok agent stdio`, JSON-RPC): Phil pushed back on the
  "grok emits nothing" finding and was right — the xAI docs' headless page demos the ACP
  `session/update` shape. ACP streams live `tool_call`/`tool_call_update`, thought chunks,
  and the prompt response `_meta` carries REAL usage (input/output/cachedRead tokens) →
  **grok gets the context meter** after all. `grokAcpTurn()` replaces the file tail:
  initialize → `session/load` (resume; failure → caller's recreate-with-history path) or
  `session/new` → `session/prompt`; load-replay updates gated off; permission requests
  auto-approved (first allow option). Same grok session ids as before (terminal `--resume`
  compatible). Model name still parsed from the session file ("Grok 4.3").
- **Reasoning streams for BOTH agents**: claude `thinking_delta` + grok thought chunks →
  `reasoning_content` SSE deltas → the app's existing collapsible reasoning UI.
- **Mid-turn send fix** (from the parallel instance, hit in the field): bridge conversations
  QUEUE a new send behind the in-flight job instead of cancelling it (cancel only killed the
  GUI stream while the CLI kept running → empty assistant bubble → transcript-sync prefix
  alignment permanently wedged). `setJob(cancelPrevious=false)` + empty-node drop guard.
- xAI imggen key from Phil tested directly against api.x.ai → 400 incorrect key; awaiting a
  regenerated key (the imggen settings field + 1Password hold the rejected one meanwhile).

## Note (2026-06-11) — claude reasoning display is IMPOSSIBLE (encrypted), grok's works

Phil asked for streamed reasoning in chat. Investigated end-to-end; plumbing was already
complete (bridge v2.6 forwards `reasoning_content`; app parses, merges, renders). Findings:
- **grok**: thought chunks stream and render today — grok thinks visibly on every turn.
- **claude (fable-5)**: the thinking CONTENT is encrypted provider-side. Every layer shows
  `"thinking":""` + an encrypted `signature` (+ `estimated_tokens` on deltas) — stream-json
  events, assistant events, and even the session transcript itself. The text never exists
  client-side, so no bridge/app change can display it. NOT a bug; verified by instrumenting
  a scratch bridge (events arrive, content empty) after a long false trail through env vars
  (CLAUDE_EFFORT etc. — irrelevant; toy prompts think nondeterministically, beware).
- Possible nicety: forward the deltas' `estimated_tokens` as a "thinking… ~N tok" status
  pulse so claude turns show deliberation without content. Not built.
