# AGENT.md — rivethub-android

Live state for whoever picks this up next (any model). Keep short; no session diaries.

## What this is

**RivetHub for Android** (`io.rivethub.app`, Apache-2.0, Kotlin/Compose): the desktop RivetHub app,
phone-shaped — same look/feel, same den backend, same harness-session model, device mTLS only, nothing
runs on the phone. Off-LAN via the stock Tailscale app. The plan of record is
`/rivet-shared/plans/rivethub-android-2026-09-02.md` (v2, reviewed); read it before changing anything.

M3b replaced the Grok-Bot UI. M4 attaches Terminal mode to the session PTY. D1a is desktop-parity
chrome (drawer · conversations · settings · enroll). D1b is desktop-parity chat (header ·
transcript · composer · terminal chrome). D2 is visual parity with the responsive web at phone
width (MobileTopBar chrome, flat conversation rows, drawer/status-bar insets fixed,
no spinners, light-theme audit). The session-header slice adds the phone session chrome:
ONE chat header row (☰ · title block · Stop · Terminal chip · search · +, no TopBar/no back), the left
drawer shared with the session (☰ or edge swipe everywhere), a right history drawer hosting the
conversations pane, transcript pinned to the bottom, chat-first launch. 2026-09-04: **the
conversations list is not an app screen** — the home is the chat surface (a session), the list
lives only in the right history drawer. `MainActivity.App()` instant-resumes the persisted last
session (nav starts on `Screen.Chat`) or starts on `Screen.Hub`, whose Conversations tab is the
launch surface (`ChatLaunchScreen` skeleton) until the pick/new resolution opens a session; Hub
keeps Settings + the drawer. `ConversationsScreen.kt` is emptied (delete list); `ConversationsPane`
lives in `ui/screens/ConversationsPane.kt`, hosted by `HistoryDrawer`. Grok-Bot screens/VMs are gone from the tree
(removed in the M3b commit).

## Clean-room (UX program 2026-09-24)

This app rebuilds the RikkaHub-era chat/terminal UX from `docs/UX-SPEC.md` only. The retired
`apps/rivet-android` tree is AGPL and is a behavioural reference for the orchestrator, never for
builders. `NoAgplLineageTest` is the guard.

**Builder rules**

- Never open `apps/rivet-android`, nor any `com.github.rikkahub`, `hugeicons`, `jlatexmath`, or
  `me.rerere` source.
- Only permissive dependencies (Apache-2.0 / MIT / BSD / OFL). Allowed additions in this program:
  `org.jetbrains:markdown`, Coil, Termux `terminal-view` / `terminal-emulator` (Apache-2.0) if ever
  needed.
- Forbidden: any `com.github.rikkahub:*`, `hugeicons-compose`, the jlatexmath fork.
- Every PR body states "built from docs/UX-SPEC.md only".
- Never name a resource, colour or symbol `highlight_*` (it is a lineage token).

**Reviewer checklist**

- `NoAgplLineageTest` green.
- Lineage grep of the diff for the token list is empty outside `NoAgplLineageTest`, this section and the
  provenance header of `docs/UX-SPEC.md` (they name the markers they forbid). Product sources and Gradle
  coordinates must not contain them.
- No new Gradle coordinate outside the allowed licences.
- New user-visible strings are original wording (reviewer may compare against the retired tree,
  builder may not).

**Plan pointer**: `/rivet-shared/plans/rivethub-android-rikkahub-ux-2026-09-24.md`. The slice table
lives there.

## Where this tree came from (slice M1a, 2026-09-03)

`git mv` of `apps/rivet-bots-android` (the Grok-Bot-style client, package `dev.rivetos.bots`) with the
package renamed to `io.rivethub.app`, label "RivetHub", DataStore file "rivethub".

What survives into the real app (plan §2): `data/DeviceIdentity.kt` (p12 vault), `data/HttpFactory.kt`
+ `data/LanNetwork.kt` + `LiveLanSocketFactory` (dual-path networking, `ACCESS_LOCAL_NETWORK`),
`gateway/Gateway.kt` (reconnecting WS), `gateway/TermWs.kt`, `gateway/GatewayClients.kt` (injected
OkHttp split), `gateway/Wire.kt` (gateway twins — not reused by the plane), `gateway/HarnessWire.kt`
+ `gateway/HarnessGateway.kt` (M3a), `plane/` (M3a + M3b reducers), `transport/NodeTransport` +
`DirectTransport` (screens obtain gateways only through this seam), `HermesReasoning.kt`,
`ui/term/AnsiTerminal.kt` + `ui/term/TerminalPane.kt` + the OSC colour-query / OSC 52 filter,
`ui/theme` + `ui/components` (M1.5).

## Slices (plan §6)

M1a rename + M6 CI ✔ → M1b `NodeTransport` seam + android-free `gateway/transport` + nx
`project.json` ✔ → M2a p12 import in Settings ✔ (folded into M3b Settings) → M1.5 design system ✔
(`ui/theme` + `ui/components`, gallery behind Settings-title long-press) → M3a pure-Kotlin plane
layer (tests only) ✔ → M3b Compose conversations + chat ✔ → **M4 terminal mode ✔ (this)** → M5a nodes
filter polish → M5b turn-complete notification → M7 cutover.

## Screens

Hand-rolled `Nav` back stack. Start: Enroll if no identity / blank entry URL / not onboarded;
else a persisted last session resumes straight onto `Screen.Chat` (instant resume); else Hub,
whose Conversations tab is the launch surface until the pick/new resolution opens a session.

| Screen | File | ViewModel | Notes |
|---|---|---|---|
| Enroll | `ui/screens/EnrollScreen.kt` | none (container) | TopBar (decorative DenBot, no ☰ — no drawer exists pre-onboarding) + p12 + entry URL; 401 → cert refused; `https://` only |
| Hub | `ui/screens/HubScreen.kt` | `HubViewModel` (activity-scoped `key=hub`) | Content only; hosted by `HubDrawer` (same file) — the ONE left ModalNavigationDrawer shared with Chat; Forget calls `shutdown()` on the same instance. Conversations tab = `ChatLaunchScreen` (launch/loading surface, NOT a list); Settings tab = Settings |
| ~~Conversations~~ | `ui/screens/ConversationsScreen.kt` | — | DELETED 2026-09-04 (emptied file, delete list) — the list is not an app screen; `ConversationsPane` moved to `ui/screens/ConversationsPane.kt` and is hosted only by the right history drawer |
| Chat launch | `ui/screens/ChatLaunchScreen.kt` | HubViewModel | TopBar (☰ + wordmark) + centered DenBot with "Loading most recent conversation…" and a New-conversation button (web `ChatLaunchLoading`) while the launch resolution (instant resume / pick / new draft) lands — never the list, never a blank, no spinner |
| Settings | `ui/screens/SettingsScreen.kt` | HubViewModel + container | TopBar (☰ + `Settings` title) + desktop settings chrome; identity, theme, terminal font, mesh-feed Updates; title long-press → gallery |
| Chat | `ui/screens/HarnessChatScreen.kt` | `HarnessChatViewModel` via `ScreenStores` | ONE 48dp chat header row owns the status inset (☰ · title block · Stop · Terminal chip · search · +); title tap = rename after a turn, long-press title = history drawer until U2b; search replaces the transcript with message hits and tap jumps to the turn; full-width 1dp context track — no TopBar, no back; `HistoryDrawer` (right, same file as HubDrawer, state lifted to MainActivity) = ConversationsPane; BOTH drawers `gesturesEnabled = false` — ONE unified edge-swipe layer on HubDrawer's root (decision `plane/DrawerSwipe.kt`, web edge-swipe.ts semantics: 20dp zone / 40dp travel / horizontal-dominant) opens AND closes each drawer; transcript pinned to bottom + `↓ latest` pill; Terminal chip selects the same session; Terminal header retains its segment until U6 (`ModePager swipe = false`); VT attach |
| Memory | `ui/screens/MemoryScreen.kt` | `MemoryViewModel` (activity-scoped `key=memory`) | NATIVE wiki hub over datahub `GET /api/wiki` (mirror of the merged responsive web Memory hub: MemoryHubPage + pages/memory.tsx): TopBar (☰ + `Memory`) + Search/Wiki/Browse/Stats tab row + search field + compact topic rows (title + staleness badge). Pure layer `plane/MemoryWiki.kt` (tabs, rows, stats, TOC, staleness, datahub-node pick) mirrors web `lib/memory-hub.ts` + `lib/wiki-base.ts`; wire shapes in `gateway/Wire.kt`, calls `Gateway.wikiPages/wikiSearch/wikiTopic`. Datahub = mesh node named datahub, else `transport.entry()`; load failure = the web "Point RivetHub at datahub" pointer copy, never a spinner |
| Memory topic | `ui/screens/MemoryTopicScreen.kt` | same `MemoryViewModel` | Pushed over Memory (its slug in `Screen.MemoryTopic`); header = Back + title (session-row vocabulary, no TopBar); lead + `MarkdownBody` body (`wikiBody` = currentState else full file), collapsible full-width Contents from the parsed ##/### headings; 404 = the web red-link state. Back pops to the hub list |
| Gallery | `ui/components/ComponentGallery.kt` | none | D1a chrome + D1b chat + D2 top bar/rows/settings rhythm (dark + light) |

Conversation list v2 (slice U2a, UX-SPEC §2 item 2; still hosted by the RIGHT history drawer
until U2b moves it left): `ConversationsPane` sections the live rows with
`plane/ConversationSections.kt sectionRows` — Pinned (only when non-empty), Today, Yesterday,
then one section per local calendar day, newest first, with the year when it is not the current
year. A row files under `updatedAt`, else `createdAt` (`ChatItem.createdAt`, from the wire
summary), else today; a future stamp also counts as today. The pane samples clock and zone in
composition and keys its cached sections on `DayKey` (local date + zone); the drawer opening and
ON_RESUME recompose it, so sections roll over midnight or a zone change with no timer. Headers are `SectionHeader` (mono 11sp
caps, inkDim). Rows are pills (`ConversationRowChrome(pill = true)`: `Radius.full`, 36dp, 14dp
side padding, one ellipsised line; swipe-to-archive unchanged), the in-flight status dot pulses,
pinned rows carry a trailing `lucide_pin` (archived rows too). Host contract:
`ConversationsPane(currentSessionKey, openTick)` — `HistoryDrawer` passes the open
`Screen.Chat.sessionKey` (MainActivity) and bumps `openTick` whenever the drawer state targets
Open. The open row (`activeRowIn`: live first, then archived; native↔canonical, drafts included)
is filled `panel2` and scrolled into view on every open (`activeIndexIn` counts the empty-state
line, headers, and the archived rows after the sections); an archived open row expands the
archived block. Long-press menu = `plane/ConversationMenu.kt conversationActions`
(draft → Discard draft only, where a draft is `plane/ConversationIdentity.kt isDraftRow` — a DRAFT
row or an agent pointer row on a bare id; else Pin|Unpin · Rename · Move to agent when >1 agent ·
Archive|Unarchive · Hide). **Pin and Hide are local-only** (prefs `pinned` / `hidden`, matched on
key or canonical session id, and carried to the new id by `rekeyIdSet` / `migrateLocalPrefs` →
`Settings.migrateKeys` (one edit) wherever the VM rekeys a session: adopt, session-updated
`previousSessionId`, `adoptChatPointer`) — the den has no delete, hidden rows are just filtered out by
`filterConversations(hidden = …)` and there is no unhide UI yet. Move to agent =
`moveSessionToAgent` (chosen agent's pointer → this session on the row's node, any other agent
pointing at it lets go) → `HubViewModel.moveToAgent` → `Settings.setAgentPointers`; no den call.
When the moved row is the open conversation, `currentAgentId` follows it (so `+ new` does).
Rename is still the pane's inline sheet (a shared `RenameSheet` is U1's).

Agents live in the drawer (tap / long-press ↺ / + pointer semantics; 2026-09-04 long-press
also has Edit — `AgentEditSheet` name/color/model/effort/prompt/directory/shared link via `PATCH
/api/agents/{id}`; the node is read-only — and Go to node, guarded so it never toggles the filter off).
A dim second line shows `node · basename(directory)` when that subtitle is non-blank. Nodes live in the
drawer footer sheet (view filter only; never rebinds an open chat; error badge is
timeout/5xx only — 404 harness = plane-less, no badge). The drawer Memory row is ENABLED
(2026-09-04, native wiki hub): `drawerDestEnabled(Memory) = true`, routed by
`plane/DrawerNav.kt drawerOpensMemoryScreen` (its own `Screen.Memory`, never a `HubTab`) through
`HubDrawer.onOpenMemory` to MainActivity's `openMemory()` (pops back to an existing Memory
entry, else pushes; Back returns to whatever is below).

Prefs keys (DataStore `rivethub`): `entryUrl`, `strictHostnames`, `onboarded`, `themeMode`
(`system`\|`light`\|`dark`), `sessionModes` (sessionId → `chat`\|`terminal`), `archived`,
`titleOverrides`, `agentPointers` (`sessionId\tnodeBaseUrl`), `terminalFontSp`, `viewNodeId`,
`currentAgentId`, `agentsCollapsed`, `lastSessionKey` + `lastSessionNode` (instant-resume
pointer, written on every chat open; drafts never written), `expFiles` / `expTasks` /
`expWorkflows` (experimental drawer sections, default false), `pinned` / `hidden` (U2a local
pin/hide sets; `Settings.pin/unpin/hide/unhide/migrateKeys`). Leftover Grok-Bot keys (`handle`,
`sessionOverrides`, `lastSeen`, `desktopUrl`) are still decoded so a wipe is not required; their
setters are gone.
`expWorkflows` (experimental drawer sections, default false), `favouriteModels` (string set of
model ids — the composer model sheet's Favourites group, U5). Leftover Grok-Bot keys (`handle`,
`pinned`, `hidden`, `sessionOverrides`, `lastSeen`, `desktopUrl`) are still decoded so a wipe is
not required; their setters are gone.

## Design system

U4 fenced code (built from `docs/UX-SPEC.md` only): `Radius.sm` block with a `panel`
header (mono 11sp language, Copy, Lucide download/Save; 1dp `line` bottom), then
`codeBg` code and a fold/expand footer. `plane/CodeHighlight.kt` supplies contiguous
syntax spans: Keyword → `em`, String → `warn`, Comment → `inkDim`, Number → `link`,
Type → bold `ink`, Plain/Punct → `ink`. No syntax dependency; unknown languages stay
plain. `CODE_FOLD_AFTER_LINES = 10` in `plane/CodeFold.kt`; expansion is remembered
for the block's composition lifetime. DataStore `codeLineNumbers` / `codeWrap`
(default false) control the right-aligned mono gutter and wrap vs horizontal scroll,
including live chat. Wiki topics (`MemoryTopicScreen`) and the gallery render code
blocks with default prefs (line numbers and wrap off). Copy and Save always use the full original code; Save uses
CreateDocument and UTF-8 output on IO, with success/failure toast.

Every visual decision traces to a desktop file under `apps/rivethub-web` (`theme.css`,
`sidebar.tsx`, `agents-section.tsx`, `node-switcher.tsx`, `pages/chat.tsx` ConversationsPane,
`pages/settings.tsx`, `components/ui/button.tsx`, `segmented-control.tsx`, `den-bot.tsx`).
Do not invent Material chrome.

Tailwind → Compose: `text-lg` 18sp semibold · `text-sm` 14sp · `text-xs` 13sp · mono
`text-[11px]`/`[10px]`/`[9px]` 11/10/9sp. Sans = `RivetFonts.Sans` (DM Sans), mono =
`RivetFonts.Mono` (JetBrains Mono). Spacing: 1 Tailwind unit = 4dp. Radius: `rounded` 4 /
`rounded-md` 6 / `rounded-lg` 8 / `rounded-xl` 12 / `rounded-full` 999. Icons: `size-4` 16dp
· `size-3` 12dp · `size-7` 28dp. Lucide drawables only (`R.drawable.lucide_*`) in D1a/D1b
surfaces — no `Icons.*`. App root is `bg` + `Modifier.blueprintGrid()` (1dp `--grid-line`
rects every 32dp — a 1px `drawLine` stroke anti-aliases to half coverage and reads too dim). Touch targets: keep desktop paddings for the look, add 44dp hit areas.

Phone shape tokens (`ui/theme/Dimens.kt`): `Shape.row = Radius.full` for Pill,
HarnessChip, toggle tracks, both segmented-control layers and selected NavRow (40dp);
`Shape.card = Radius.xl` (12dp) for sheets, composer cards and cards;
`Shape.bubble = Radius.xxl` (14dp) for message bubbles (U3b adopts it in Transcript);
`Shape.control = Radius.md` (6dp) for buttons, fields and select triggers;
`Shape.tight = Radius.sm` (4dp) for code, tool rows and tags. Buttons retain their
variants and `Dimens.touchTarget` (44dp) minimum outer height. Fields use panel fill
and a 1dp border (em while focused, line otherwise). NavRow has a growing 40dp visual
row inside a minimum 44dp hit area. Modal sheets have card top corners, a centred 32×4dp line
handle and 16dp side padding. SectionHeader uses uppercase 11sp inkDim, tracking 0.6sp.

UI text size is `Prefs.fontScale` (float DataStore key `fontScale`, default 1.0).
`plane/FontScale.kt` snaps writes to 0.9/1.0/1.1/1.25 (S/M/L/XL). Settings Appearance
uses ThemeGroup; MainActivity passes the preference to RivetTheme. The theme multiplies
LocalDensity's existing fontScale using a plain `Density` at S/L/XL; Android 14+
non-linear system scaling applies only at M, which keeps the platform density object
(accepted limit). One composition path preserves remembered app state across size changes.
The theme exposes the cumulative
UI multiplier through LocalUiFontScale. TerminalPane divides its terminal text size by
that multiplier in both the text style and fallback cell measurement: terminalFontSp
(10–22) remains independent.
ComponentGallery shows Shapes and Font scale in both themes; sample scales cancel the
inherited UI multiplier first so previews show each step exactly once.

Chat mapping (phone session view ← rivethub-web):

| desktop | phone file |
|---|---|
| `pages/chat.tsx` ActiveSession header | `ui/components/ChatHeader.kt` + `HarnessChatScreen` |
| `components/context-bar.tsx` | `ui/components/ContextBar.kt` (`plane/ContextWindow.kt`, `plane/ChatChrome.kt`) — pct is toward FORCED COMPACTION (`compactAt` = window − 35k reserve; wire `contextWindow`/`compactAt`/`contextSource` preferred over `contextWindowFor(model)`, claude default 200k / 1M only on an explicit `[1m]`/`-1m` variant): Chat uses a mono 11sp `usedk/pct%` title subtitle after a completed turn and a full-width 1dp track; Terminal keeps the `{pct}%` pill and 2dp track. Track fill uses `fraction` (em → warn → red, `animateFloatAsState`) |
| `components/segmented-control.tsx` Terminal \| Chat | existing `SegmentedControl` |
| `components/transcript.tsx` | `ui/components/Transcript.kt` |
| `components/markdown.tsx` | `ui/components/MarkdownBody.kt` (`plane/Markdown.kt`) |
| `components/ask-user-card.tsx` | `ui/components/AskUserCard.kt` |
| `components/composer.tsx` + pickers | `ui/components/Composer.kt` (+ `ModelSheet.kt`, `PlusPanel.kt`, U5) |
| `components/xterm-attach.tsx` chrome | `ui/term/TerminalPane.kt` host + `KeyToolbar.kt` |

Chat VM is keyed `chat:<nodeDenUrl>:<sessionKey>` and torn down when that back-stack entry leaves.

D2 phone chrome (responsive rivethub-web ← sidebar.tsx MobileTopBar + chat.tsx SessionDrawer):

| web (phone) | phone file |
|---|---|
| `sidebar.tsx:126` MobileTopBar (`h-12 border-b line bg-panel/80`, ☰ `size-5` in 44dp hit "Open menu", DenBot `size-7` decorative, `hubPageTitle` mono `text-sm em`) | `ui/components/TopBar.kt` on every non-session screen — the bar OWNS `statusBarsPadding` (panel/80 extends under the status bar); title rule `plane/HubChrome.kt topBarTitle` (wordmark on home, page title on Settings); NOT shown in a session (lib/session-header.ts showMobileTopBar) |
| `chat.tsx:1645` narrow session row (`h-12 flex-nowrap gap-2 border-b line bg-panel/40 px-2`: ☰ `size-5`/44px · id mono `text-xs inkDim` truncate flex-1 · ctx % · Stop · Terminal\|Chat · history `size-5`/44px "Conversations"; no back chevron) | `ui/components/ChatHeader.kt` — ONE `Row` `height(Dimens.pageHeader)` owning `statusBarsPadding`, Chat items from `plane/ChatChrome.kt headerItemsV2` (☰ · title block · Stop · Terminal chip · search · +), title long-press opens history until U2b; Terminal keeps `narrowHeaderItems`; the session screen calls no TopBar. Right history drawer (chat.tsx:585-626, `w-64 border-l line bg-panel`, bg/70 scrim) = `HistoryDrawer` hosting `ConversationsPane`; chat-first launch = `plane/LaunchSession.kt pickLaunchSession`, latched in MainActivity (chat.tsx:463-475); transcript pin = `plane/TranscriptPin.kt` (transcript.tsx:385-480, 120dp, `↓ latest` pill mono 11sp em on panel, em-dim/50 border) |
| `chat.tsx:631` flat row (`mb-1 rounded`, `px-3 py-2 text-xs`, idle `text-ink-dim`, active `text-em bg-panel-2`, chip mono 9sp `bg-panel-2`) | `ui/components/ConversationRow.kt` — 36dp rows, no cards, no 44dp row floor (source density wins over hit area here); the `SwipeToDismissBox` panel2 reveal paints ONLY while `dismissDirection == EndToStart` (an always-on backgroundContent shows through the transparent idle row as a card) |
| `chat.tsx:833` flat list, no node/agent group rows | `paneRows` in `plane/HubChrome.kt` (pin rows titled by agent name are desktop parity, chat.tsx:378-388) |
| `chat.tsx:808` `+ new` raw button (`rounded border line px-2 py-1 text-xs inkDim`) | `NewConversationButton` in ConversationsPane.kt (NOT RivetButton) |
| `sidebar.tsx:189` phone drawer `w-64` | `Dimens.drawerWidth` 256dp (`drawerWidthDp` rule, 85% under 360dp); drawer runs edge-to-edge: header owns status inset, footer owns nav inset |
| `settings.tsx:189` auth helper, h2 `mt-10 border-t pt-6 mb-3 mono sm semibold em` | `ui/components/SettingsChrome.kt` (`SettingsH2` / `FieldLabel`); entry field follows the h1 directly (no lead section h2); the h2 text must be `fillMaxWidth` or the `drawBehind` border-t only spans the glyphs |
| no spinners anywhere; pull-to-refresh only answers a user pull | discovery progress is the mono `discovering… n/m` line (`discoveringLineVisible`) |
| system bars | `MainActivity` sets `isAppearanceLight*StatusBars` from `ThemeMode`; bottom-most content owns `navigationBarsPadding` (composer / key bar / list block / scroll column), nothing else does |
Registry watches live in HubViewModel (one unlimited Channel, sequential consumer). SessionAttach
lives in the chat VM; WS frames are marshalled onto one Channel per attach (never `launch` per
frame). Turn-complete settle is deferred so it does not block frame intake. Network stays on
`Dispatchers.IO`. Identity `generation()` is sampled at start; a bump drops cached clients.
Refresh publishes the mesh roster as soon as `discover()` returns, then merges each per-node
bundle as it completes (`healthz` first, `withTimeout(8s)`). A "discovering… n/m" line tracks
pending bundles so an offline peer cannot hide the healthy ones.

Composer v2 (U5, UX-SPEC §4): bottom row = pickers · spacer · mic placeholder (disabled,
"Voice input (coming soon)", hidden on a compact row — `composerShowsMic`) · **+** · Send/Stop
(Stop tints `red`). The **+** replaces the paperclip and opens `PlusPanel` (a `RivetModalSheet`, not a
popover — keeps 44dp rows; items from `plane/ChatChrome.kt plusPanelItems`). The Model pill is
`ComposerModelPicker` → `ModelSheet` (autofocused `RivetField` search, `SectionHeader` groups from
`plane/ModelPicker.kt`, check on the current row, dim id under the label, long-press = favourite
star `lucide_star` in `warn`); Effort keeps `ComposerPicker`. `ComposerPickerPill` is the shared
trigger. "Editing ✕" banner (`panel2` row, pencil + `em` mono label, ✕ "Cancel edit") sits at the
top of the card while `editing`.

## Core packages

`gateway/`, `transport/`, and `plane/` stay free of `android.*` / `androidx.*` /
`com.android.*` imports (and fully-qualified `android.` / `androidx.` refs) so an iOS port can
share them behind a later Ktor swap. Enforced by `CorePackagesAreAndroidFreeTest`. `domain/` is
gone — its types live in `gateway/` + `plane/`. Screens talk to nodes only through `NodeTransport`
(`DirectTransport` today; `IngressTransport` is a later drop-in). Harness HTTP/WS is
`AppContainer.harness(denUrl)` (same OkHttp generation as Gateway). No KMP now.

## Harness plane (M3a + M3b)

U1 chat header: `plane/ChatChrome.kt` selects `headerItemsV2` for Chat and keeps
`narrowHeaderItems` for Terminal. New `plane/TitleBlock.kt` formats title/identity/context
and gates rename; `plane/MessageSearch.kt` selects first text matches and snippet highlight
ranges. Each has JVM coverage. `ui/components/RenameSheet.kt` is shared-ready; U2a will
switch the conversations pane to it.

Pure Kotlin under `gateway/HarnessWire.kt`, `gateway/HarnessGateway.kt`, and `plane/`. Desktop
semantics copied from `apps/rivethub-web` `harness-*.ts` + `ask-user.ts` + `attachments.ts` +
`outbound-pump.ts` + `agent-session.ts`. `+ new` is a bare UUID draft; never call startSession.
First send on a draft: `ensurePty` (`termSpawn` joined to the draft id) then `termInject`
(`POST /api/terminal/inject`; server appends `\r` via `submit` default true). A **fresh** spawn
attaches `watchTerm` and waits until output has started and been quiet ≥ 1.5s (bounded 8s) before
inject; a reused/reattached PTY injects immediately. Do **not** wait for registry `session-created`
before sending — claude's store row is created by the first turn. After inject, poll
`listSessions` every 3s (≤ 30s) and adopt by native id; if still a draft at 15s, one-shot bare
submit (`text:""`, `submit:true`). After adopt, `sendTurn`. LRU-evicted PTY: drop the pty ref,
respawn, wait-ready, inject once more. API-only agent: commanded spawn then `{ session }` fallback.
A preset-opened session (`Screen.Chat.agentId`) spawns in three attempts:
`{ session, agentId, command }` (cols and rows go on every body; model and
effort are omitted — the den fills those and the cwd from the preset, while
the command keeps a pre-registry den on that harness), then
`{ session, command, model, effort }`, then `{ session }`. The later attempts
run only after a failure that is not a stopping 409. A blank command drops
the middle attempt and is left off the first. A blank agentId keeps the
two-attempt commanded fallback. A 409 whose error contains `session runs in`
stops the loop and asks "Resume here anyway" — that retries the same attempt
with `force=true`, and only after the user confirms. Never auto-force.
Confirming does not send the pending composer text; the message stays in the
composer. A live codex app-server thread still answers `session runs in`
when `force` is true (den `server.ts` app-server resume branch, ~1690) —
resume cannot chdir that thread — and the raw den text is shown on the
error strip. A 409 containing `hosted on` or `has no directory` also stops:
the den text is the error, nothing is spawned, and there is no force offer.
Any other 409 surfaces the den text and continues. A non-409 on the agentId
attempt surfaces the den text and continues, except 404, which stays silent
and falls through. A later attempt that succeeds does not clear that text
(the fallback's cwd is the den default, and the hub does not render it).
The next send clears the strip. ct114 and ct117 are pre-deploy dens: they ignore
`agentId` and return no `cwd`. The command on the first attempt is what
starts the right harness there.

A pinned id without `:` is still a draft (do not `startAttach`). PTY-driven sessions often
deliver no live-tail frames: optimistic user turn on send, registry `SessionUpdated`
idle/ended (or `updatedAt` change) fetches the transcript but does **not** end the turn
unless an assistant is on disk after the pending user (spawn-time idle is not complete),
and a 5s silent poll (armed after inject ok and after sendTurn accepted, not cancelled by a
premature resync or a status/accepted/`session-updated` frame, bounded to the 3 min idle deadline) fetches
until an assistant turn appears, a content session frame (assistant-delta, reasoning-delta,
tool-use, turn-complete, error) arrives, or the idle deadline. A 409 `turn_in_flight` marks
the send pending-on-server (`injectCompleted` true, poll stays armed, retry on the 15 s tick);
a later transcript with our assistant ends the turn and drops the queued retry. Resync fetches
carry the session id and are discarded if the open session changed mid-fetch. `sendTurn`
`redirectedTo`/`sessionId` adopts only when `sessionMatchesNative`. Same-id adopt (redirectedTo
echo) is a no-op. Composer v2 (U5): **"+" panel** = Photo (`PickVisualMedia` ImageOnly) · Camera (`TakePicture`
into `cacheDir/camera/`, FileProvider `cache-path camera/`, staged via `stageUri` with the file's
size so the upload streams on IO) · File (the existing `OpenDocument` launcher) · Compress
context. Photo, Camera and File are ALWAYS offered — every harness takes an upload (PTY ones as an
`[attached: uri]` line); `HarnessSheet.imageAttachments` means protocol-native attachments only and
is not a panel gate. Compress is hidden on a draft. Camera files are held in the VM's
`CaptureRegistry` (`plane/CameraCaptures.kt`) from launch until their upload finishes
(`vm.captureStarted` / `captureAbandoned` / `stageCapture`); unheld captures older than 1 h are swept
only after a capture staged successfully, never ahead of a new capture. Launchers are registered by the screen via
`rememberComposerMediaLaunchers` (a launcher inside the sheet would die with it). **Compaction**:
`plane/CompactCommand.kt` — `/compact` for claude-code only (ids normalised through
`harnessIdForAgent`), `canCompact` never in flight; `vm.compactContext()` (confirm dialog first)
types it into the PTY exactly like the stale-409 fallback (`ensurePty(native)` → wait-ready if
fresh → `termInject`), never on a draft. The PTY setup suspends, so the inject runs under
`OutboundPump.withSendLock` and re-checks `compactMayDispatch` there (turn in flight, queued/sending
item, draft or changed session → dropped with `ERR_COMPACT_BUSY`, also when confirm lands after the
idle snapshot went stale); no pump send starts in between. **Long-press Send** while in flight = `vm.enqueueSend()`:
same validation/`[attached: …]` text as `send()` (shared `prepareOutbound`), `pump.tryEnqueue`
WITHOUT pumping — the queue drains on idle/turn-complete and shows in `QueuedStrip`; refused while
uploading (`ERR_UPLOADING`). **Edit banner API**: `UiState.editing: EditState?`,
`vm.beginEdit(text)` / `vm.cancelEdit()` (empties the composer). The edit rides on the queued item
(`OutboundItem.editing`, set once via `editForEnqueue`) for both `send()` and `enqueueSend()` — local
enqueue is not acceptance. Every pump pass reports a `PumpOutcome` (`Dispatched` / `Deferred` /
`Rejected(TURN_IN_FLIGHT | FAILED)` / `Idle`) to `OutboundPump(onOutcome)` from any entry point
(pump, inject, onIdle, onTurnComplete; `acknowledgePending` reports `Dispatched`); the VM's
`onPumpOutcome` applies `editAfterOutcome`: the banner clears only on that item's `Dispatched`, a
deferred / 409-queued item keeps it, and `FAILED` puts the item's text, chips and edit back
(`restoredEdit`) with the error — so a hard failure after a 409 retry no longer drops the edit.
Cancelling a queued item also restores its edit. Bubble-tap → `beginEdit` arrives in U3b. **Favourites**:
`Prefs.favouriteModels` via `vm.toggleFavouriteModel(id)` → `Settings.toggleFavouriteModel(id)`,
which applies `toggleFavourite` inside ONE `ds.edit` (overlapping long-presses serialise) and
returns the committed set. Order is the string-set's insertion order — not contractually kept by
DataStore; verify across restart on device.
Attachments are `[attached: uri]` lines after streaming
`POST /api/uploads` on the session's node (1 GiB cap, den-server), except
protocol-owned Codex sessions (`transport: protocol` + `imageAttachments`):
those send staged PNG/JPEG/WebP/GIF as `UserTurn.attachments` with the
catalog model/effort on the turn body. Native Model/Effort sit above the
composer (web `chat.tsx` nativeModels row) and hide the spawn-flag pickers.
A failed attachment chip blocks send on **every** session, PTY included
(parity with web `composer.tsx`); remove the chip to retry. Gallery pick
and share (`ACTION_SEND` / `ACTION_SEND_MULTIPLE` `image/*`) land on the
exported `singleTask` activity via `onNewIntent` → `pendingShare`. Bound
prompts keep option buttons when present; `freeText` adds a per-question
text field, and a missing/`null` options list is text-entry-only. Answers
map index → labels/`other`. Approvals stay bound to
`requestId`. Canonical ids contain `:`; path
params are unpadded base64url (`sessionKeyEnc`). Hermes display/live strip stays
`data/HermesReasoning.kt`.

**Assistant turn chrome (UX slice U3a, UX-SPEC §1.2/§1.3).** Every assistant turn renders a
chain-of-thought timeline above its markdown (`ui/components/CotTimeline.kt`): steps come from
`plane/CotTimeline.kt cotSteps` — stored turns = reasoning from `thinking` (Hermes: the
`splitHermesReasoning` reasoning) then `tools` in order; the live turn = `liveReasoning` +
`liveTools`. **Fold rule** (`foldSteps`): collapsed by default to the LAST 2 steps plus an
"N more" row; expanded shows all plus "Collapse" (`showCollapse`). Expansion is
`UiState.cotExpanded` (turn index; live turn = -1), toggled by `toggleCot`. Rail dots map status →
token via `stepDotColorKey` (running em pulse · error red · else inkDim). Tool tap opens
`ToolDetailSheet` (name, pretty `args ?: input`, result = stored `resultText` or the live
bounded preview with a "preview only" note; "(no result yet)" while running). The open sheet is
held by identity, not position (`plane/ToolSheet.kt`: `ToolSheetTarget` = turn, live-turn
generation `UiState.liveTurn`, toolCallId, per-turn tool position; `resolveToolSheet`): it
refreshes only on proof — same live generation + sequence + call, or `toolCallId` (which also
follows a live call onto its committed turn); an id-less call outside its live generation (any
stored id-less tap) never re-resolves and keeps its tap-time snapshot, since the wire has no turn
ids and equal content is not ownership. **Reasoning clock**
(`plane/ReasoningClock.kt`): the wire has no per-turn timestamps, so the phone measures it —
span opens on the first reasoning (a `reasoning-delta` frame, or `advanceReasoning` seeing
live reasoning on a transcript-sourced store) and closes on the first text delta / ToolUse /
turn-complete (or the turn leaving flight). Live label ticks via a 1 s `LaunchedEffect`
in the composable (UI-only, never in the VM); an ended span auto-collapses the 6-line live
preview to "Reasoned for X.Xs". Finished measurements land in `UiState.reasoningDurations`
(stored turn index → ms, via `reasoningOwnerIndex`) — **in memory only**; reloaded/older turns
show the fold with a plain "Reasoning" label. VM clock is the injectable `clock` ctor param
(`vm.clockMs` also drives the label ticker). The VM holds a `ReasoningLedger`: every turn start
(`startTurn`, incl. a queued send fired straight out of turn-complete) FILES the previous span
first, and turn-complete files before `pump.onTurnComplete()`; finished measurements wait in
`pending` keyed by their turn start and `settle` hands them out oldest first, one assistant run
(up to the next user turn) each, only once that run is closed. `LiveTool` keeps NO raw result
JSON: `resultPreview` is rendered once at ingestion and capped at `LIVE_RESULT_PREVIEW_MAX`
(4096 chars) with `resultTruncated`; the full text is the committed turn's `resultText`.
`applyToolResult` is replay-safe: a known id completes its call once (a repeat is ignored); an
unknown id only goes to the oldest running id-less call of that name and is bound onto it; a
blank id falls back to the oldest running call of that name. Loading row = pulsing
em dot + `loadingLabel` (newest running tool title, else `agentStatusText`, else "Working…").
**Error stack vs strip** (`plane/ErrorStack.kt`): free-text transport/turn errors (send,
inject, answer, approval, upload failure, boot, attach fatal) go to `UiState.errors`
(`pushError`, cap 5, newest last) and render as dismissible cards above the composer
(`ChatErrorStack`, "Clear all" when > 1). The five composer/attachment codes
(`isStripError`: uploading, too_large, failed_attachment, image_only, image_unsupported) keep
`error`/`errorCode` and the one-line strip (the screen shows the strip ONLY for those codes).
Terminal attach errors (`TermAttachController` publish) set `UiState.termError` for
`TerminalRetryState`, and each distinct text is stacked once per session via
`RepeatErrorGate.admit` — the controller republishes on every change, so repeats add nothing and
a dismissed card does not come back.

## Terminal mode (M4)

Attach protocol (den-server `term/ws.ts`, rivethub-web `xterm-attach.tsx`):

1. `POST /api/terminal` spawn-or-get joined to the chat's canonical/native session id. The PTY
   is the same one chat already spawns via `ensurePty` — Terminal does not open a second PTY.
   A draft Terminal tab goes through `spawnAndAdopt()` (`ensurePty` + wait for the
   registry watch to adopt) before attach, never a second unsynchronised spawn.
2. WS `/api/terminal/ws?id=` — hello JSON, one binary ring frame, live binary, exit JSON.
3. The server replays the ring unconditionally after hello (`term/ws.ts` attach), including
   `mux:'tmux'`. Reset the local VT on hello / reconnect, then write every binary frame. An empty
   ring writes nothing. Never skip replay.
4. Client sends binary keystrokes and JSON `{type:resize,cols,rows}` / `{type:detach}`.
5. **Never send `{type:kill}`.** Leave, background, and the Detach menu send detach then close.
   The manager TTL owns the PTY; reattach replays.
6. OSC 10/11/12 colour queries are stripped and never answered. OSC 52 writes go to the clipboard
   (flagged sensitive on API 33+); OSC 52 reads (`?`) are refused.
7. "Open in your terminal" copies `ssh <sshUser>@<host> -t tmux -L <socket> attach -t <session>`
   rendered from the server `attach` descriptor. Hidden when `attach` is absent — never guess a
   socket name.
8. Terminal ownership (den #681, 2026-09-04): hello carries `owner?: {device, self}`; the server
   broadcasts `{type:'owner', device|null, self, since?}` on every change; `{type:'claim',cols?,rows?}`
   takes ownership. Wire shapes in `gateway/Wire.kt` (`TermOwner`/`TermOwnerFrame`/`TermClaimFrame`,
   `TermFrame.Owner`), pure helpers in `plane/TermOwner.kt` (`ownerOverlay`, `ownerFromFrame`),
   `termClaimJson` next to `termResizeJson` in `plane/TermPty.kt`. A non-owner sees a centered
   overlay (DenBot + "This terminal is active on {device}." + "Use terminal here") in
   `TerminalPane` — the Canvas stays mounted behind the scrim; chat is untouched.

Attach lives in `TermAttachController` (driven by `HarnessChatViewModel`) so Chat↔Terminal swipe
does not drop the socket. Inbound PTY frames share one `Channel` consumer (hello → ring order is
structural). Session WS stays on the existing per-attach Channel (M3b). Detach only when leaving
the screen (VM cleared) or the app backgrounds (`ON_STOP`); reattach on return if Terminal was
wanted. Identity `generation()` bump drops the attach. Font size is Settings Small/Medium/Large →
11/13/16 sp; cols/rows use a measured "M" and `fontScale`. Ctrl is one-shot (long-press locks).
ALT is one-shot too: an ESC prefix (`TermKeys.alt`), sticky highlight, cleared after the next
key. It has no lock. Ctrl+ALT is ESC followed by the ctrl byte. An arrow is already `ESC [ A`,
so ALT+arrow is `ESC ESC [ A` (meta sends ESC). Paste with CTRL armed is sent literally — a
multi-character paste is not a ctrl letter — and paste with ALT armed gets one ESC prefix.
Scrollback cap is
`AnsiScreen.SCROLLBACK_LINES` (5000 lines; the spec floor is 4000).
Two-finger scroll is local `AnsiScreen` scrollback, pinned to an absolute line while scrolled
back; tmux copy-mode history paging is out of scope. DECCKM (`CSI ?1 h/l`) selects SS3 vs CSI
arrows. `{type:detach}` is ahead of `@rivetos/types` and a no-op on today's server — the close
is the detach. Restart invalidates the cached PTY id (`PtyAttachCache` / `restartSessionPty`)
and then `drop()` + `ensure()` — detach, never kill — so spawn-or-get runs again instead of
rewatching an exited or reaped id. The server decides reattach versus a new client. An exited
PTY replaces the key row with an ended bar (Restart, Back to chat).
Back to chat (header arrow, system Back, or that button) returns to Chat and resyncs the
transcript. A snapshot never cancels or completes a send; every send this phone makes gets
exactly one retry `SYNC_REARM_MS` (3 s) later, unless a newer send from this phone happened
in between, and that newer send carries its own retry. Request B at t_B ≤ t_T (T is the
send that covers B) still arrives: if the 2 s throttle drops T, T's retry is at t_T + 3 s,
outside that window, and if the retry is itself throttled the sync that throttled it ran
after t_B and re-snapshotted every sink, so this phone already holds a snapshot captured
after B. Either way B's state arrives, and a user request is at most two writes because
requests inside a pending window are coalesced. Correlating a snapshot to the send that
caused it needs a server-side `syncId` echoed in the snapshot; that is a fleet follow-up,
not this client.
In Terminal mode the header is that back arrow, the title (program title, else
model or harness · conversation, plus " (ended)" and " · remote"), and Stop when the turn is
interruptible — the segmented control and the history button are not shown. Detach-never-kill
is unchanged: leave, background, and the Detach menu still send detach only.

## Build / test / install

- Build host: the fleet's Android build box (JDK 21 + SDK 37 + warm Gradle cache) — host names and
  paths are ops notes in Rivet's memory, not here. `./gradlew :app:assembleDebug :app:testDebugUnitTest`.
  Full-suite test counts only — a `--tests` filter can match nothing and still print green; CI
  (`.github/workflows/android.yml`) enforces a floor of 572 (ux-u0: +2 `@Test` on the 571-test tree;
  FLOOR = real count − 1).
- CI `FLOOR` in `.github/workflows/android.yml` = real full-suite count − 1; bump it in every PR that adds tests.
- Nx targets in `project.json`: `check` → `:app:testDebugUnitTest`, `apk` → `:app:assembleDebug`,
  `verify` → dependsOn check+apk (command `true`), `lint-android` → `:app:lintDebug`. There are no
  nx `build` / `test` / `lint` targets on purpose — Gradle owns those, and the SDK-less monorepo
  sweeps would run a target named `lint`.
- Emulator smoke (API 36, swiftshader) and wireless-adb install from the adb host: ops notes live in
  Rivet's memory, not here. The emulator does NOT enforce Android 16 Local Network Protection — device
  smoke is mandatory for anything touching networking.
- New app id ⇒ fresh `filesDir`: the phone re-imports its device p12 once on first install.

## Contract facts (verified 2026-09-03, main `0c9abd3f`; D1 roster facts 2026-09-24, main `7e236c20`)

- `GET /healthz` is `{ok, sessions, name, node}`. `node` is the mesh node name (`ct115`). Older dens omit it — decode as `""`.
- `POST /api/terminal` accepts `agentId` and `force` in addition to command/session/model/effort. Explicit command, model, and effort win; `agentId` fills whatever the client left out and sets the cwd to the preset directory. The hub's first preset attempt sends `agentId` and `command` and omits model and effort, so the den fills model, effort, and cwd. The response may include `cwd` (absent on older dens).
- Spawn errors: `404` `agent not found` (the hub stays silent and falls through); `400` (`agent has no harness and no command was given`, or `model must be a 1-64 token` / `effort must be a 1-64 token`) and `500` `could not create agent directory` are shown, then the next attempt runs; `409` `agent "<name>" is hosted on <node>` and `409` `agent "<name>" has no directory` stop the loop, show that text, and do not spawn again or offer force; `503` `agent registry unavailable` is shown and the next attempt runs. A `409` whose error contains `session is running in` (live PTY, cannot move) is not a stop: the text is shown and the next attempt runs. A success on that later attempt does not clear the text already on the strip. The next send does. A session recorded in a different cwd is a `409` whose error contains `session runs in` — the hub asks before retrying with `force:true`. That force resumes a movable PTY into the preset directory. A live codex app-server thread still returns the same `session runs in` text when `force` is true (den `server.ts` ~1690), and the hub shows that raw text. Do not auto-force. "Resume here anyway" does not resend; the pending message stays in the composer.
- ct114 and ct117 are pre-deploy dens (no `healthz.node`; unknown body fields ignored). The first attempt still carries the roster command, so those dens start that command instead of only the default.
- A non-blank preset `node` that matches no discovered hint (`meshNode`, id, or name) is an offline row named after that node (`denUrl` empty). The drawer and both new-conversation pickers dim it and do not open it. `openAgentRow` returns null before any draft or pointer write, so it cannot become a chat destination with an empty URL. Edit is omitted while the row is offline (`agentSheetActions(online)`), so Save is not sent at that empty URL. Legacy `nodeBaseUrl` applies only when `node` is blank.
- `POST /api/devices/enroll` is WireGuard pairing only (requires a WG `publicKey`, returns mesh config,
  issues NO cert). v1 enrollment = p12 import; QR-to-cert is a separate den+CA program.
- Desktop `+ new` = bare UUID draft, adopted to `harness:uuid` via the registry stream. Never call
  `startHarnessSession` on new (hermes/kimi/codex refuse it).
- Attachments = `[attached: <uri>]` lines in turn text after `POST /api/uploads` on the session's node;
  `UserTurn.attachments` is rejected by every PTY driver.
- Two `SessionSummary` types: gateway (`id`, epoch-ms) vs `HarnessSessionSummary` (`sessionId`, ISO).
  Canonical ids contain `:`; harness routes take unpadded base64url of the canonical id.
- `/api/notifications/ws` = escalations/gates; turn-complete arrives on the harness-session WS.
- "Open in your terminal" renders the server's `attach` descriptor; never compose the tmux command.

## Gotchas

- U1 transcript pin is recreated on session-id changes (history navigation and draft adoption).
  Keep ChatTranscript's scroll collector keyed on `pin` and `jumpToTurn`, and its local
  pinned state in `remember(pin)`, so scroll events reach the current session's pin.
- U1 header + resolves session agent, then current agent, against the roster via
  `newConversationAction`; either resolved agent uses `AgentAction.Plus` without replacing
  the back stack or moving the pinned thread. Only when neither resolves does the host use
  the existing launch fallback (currently no-op without a roster-backed current agent).
- Deferred from M1.5 (recorded here, not only in the fix notes): snackbar/toast host, `SelectOption.group` for grouped selects, `RivetSelect` `sheetState.hide()` before dismiss, `lint-android` not yet run in CI.
- `usesCleartextTraffic=false` (manifest). Enroll and Settings refuse non-`https://` entry URLs. A mesh
  node advertising `http://` still fails; that maps to `EnrollErrorKind.Cleartext`.
- Debug builds are `io.rivethub.app.debug`; release is `io.rivethub.app`. Both are fresh ids on the
  Pixel — import the device p12 once per build type. Note the session ring is keyed by the cert CN
  (`deviceTag()` = SHA-256 of the CN), so two installs sharing one p12 share one gateway session ring;
  give the debug install its own device cert if you need them independent.
- Assistant bodies render through `MarkdownBody` (ATX headings, bold/italic, blockquote, pipe tables, nested lists, inline/fenced code, http(s) links). Not a full GFM port.
- Drafts are in-memory only (`HubViewModel` drafts list). A background-killed app loses unsent drafts
  and composer text. `+ new` is cheap; composer `rememberSaveable` is still open.
- Never cache a `Network` handle into anything long-lived; never freeze `Network.socketFactory` onto a client.
- No private IPs anywhere in this tree (CI secret-scan + private-net rule); placeholders use 192.0.2.x.
- `EncryptedSharedPreferences` is deprecated upstream; keep it until a Keystore-wrapped blob exists.
- In-app update is Settings → Updates (manual Check only, like desktop). Manifest is
  `GET /api/files/download?path=builds/rivethub/latest.json` on the connected entry node;
  APK lands in `cacheDir/updates/<file>.part`, sha256 is verified, then renameTo `<file>`;
  installed via FileProvider `${applicationId}.fileprovider` + `REQUEST_INSTALL_PACKAGES`.
  Version comes from `apps/rivethub-android/version.properties`.
  `VERSION_CODE = major*1_000_000 + minor*1_000 + patch` (0.5.22 → 5022); the code is
  monotonic and never reused. `app/build.gradle.kts` errors at configuration time if
  VERSION_CODE disagrees with VERSION_NAME. Fallback if the file is missing: 0.1.0 / 1.
  One `Updater` per process (`AppContainer`). Install re-fetches the manifest. Unknown-sources
  keeps the verified file (`NeedsInstallPermission`) and reuses it.
- Never send `{type:kill}` on terminal leave — detach only. `ui/term/AnsiTerminal.kt`,
  `ui/term/TerminalPane.kt`, `gateway/TermWs.kt`, `data/TermClient.kt`, `ui/components/KeyToolbar.kt`
  are the attach surface. `DesktopView.kt` (noVNC) was a plan §1 non-goal; correct to stay deleted.
- ComponentGallery has `systemBarsPadding()` (M1.5 emulator pass, fixed in D1); gallery TopBar samples pass `padStatusBar = false` so they show the true 48dp bar mid-scroll.
- `archived` / `sessionModes` / `titleOverrides` / `agentPointers` maps are not pruned when a session
  ends. Do not GC them on a partial discover.
