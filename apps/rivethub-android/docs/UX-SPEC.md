# RivetHub Android — chat & terminal UX spec

_Behavioural specification. Written by Rivet (orchestrator) on 2026-09-24 from observing the retired
RikkaHub-derived client and from Phil's feedback. This document describes what the user sees and can do.
It contains no code, identifiers, string resources or drawables from any other codebase; the numeric
thresholds in it are observed behaviour, restated. Builders implement from this document plus the design tokens already in `ui/theme/`; they do
not consult other apps' source. Reviewers enforce that (see "Clean-room" in AGENT.md)._

Plan of record: `/rivet-shared/plans/rivethub-android-rikkahub-ux-2026-09-24.md`.

## 0. Principles

1. **One session, two views.** A conversation is a harness session on a mesh node. Chat and Terminal are
   two renderings of the same PTY-backed session; switching never interrupts a turn, and returning to
   Chat shows whatever happened in the terminal meanwhile.
2. **Frame-driven, never polled.** Every refresh is caused by a socket frame, a user action, or the app
   coming to the foreground. No timers that fetch.
3. **Logic in `plane/`, screens thin.** Every rule below that can be expressed as a pure function lives in
   `plane/` with a JVM test; Compose only renders state.
4. **Desktop tokens, phone shapes.** Colours, type and icons come from the existing theme tokens. Shape
   language is soft: pill-shaped rows, a rounded composer card, message bubbles, generous corner radii.

## 1. Chat screen

### 1.1 Top bar (one row, 48dp)

Left to right:

- **Menu** button: opens the left drawer.
- **Title block** (takes remaining width, single tap → rename sheet):
  - line 1: the conversation title, or "New chat" for an untitled/draft session;
  - line 2, small and dim: `<agent name> / <model display name> · <used>k/<pct>%`. The model name is the
    human label from the harness sheet when known, else the harness label. The context part is the
    existing context meter (used tokens in thousands and percentage of the window); omitted until the
    first turn completes. Rename is only offered once the conversation has at least one turn; on a
    draft the tap shows a short toast instead (wording is the builder's; none is prescribed).
- **Terminal** chip: a small outlined chip with a code icon and the word "Terminal". Tapping switches to
  Terminal view for this same session (see §5). Chat and Terminal share one PTY, so switching mid-turn
  simply shows the live terminal output; nothing is interrupted and no wait state is needed.
- **Search** toggle (magnifier; becomes ✕ while active): reveals a rounded search field under the bar and
  puts the transcript into *results mode*. Matching is case-insensitive over message text only (not
  reasoning, tool output or attachments): each matching message is a one-line snippet starting at the
  first match, with the match highlighted. Tapping a snippet leaves results mode and scrolls the
  transcript to that message. Empty query = no results rows, transcript hidden behind an empty hint.
- **New chat** button (+): mints a new draft for the current agent (existing behaviour).

The Stop control is no longer in the header; it lives on the send button (§4). The old "Terminal | Chat"
segmented control is replaced by the chip (chat view) and the back arrow (terminal view).

### 1.2 Transcript list

- Sticks to the bottom while a turn streams unless the user has scrolled up; the existing pin logic.
- While a turn is in flight the last row shows the loading animation plus a dim status text: the
  current tool's human title when one is running, else "Thinking…" or "Working…".
- After the user scrolls, a small **message jumper** appears at the trailing edge for about three
  seconds: four stacked round buttons — top, previous message, next message, bottom. It hides when
  idle. Not a setting.
- **Error stack**: errors are cards stacked above the composer, newest at the bottom, each dismissible
  with ✕, plus a "clear all" affordance when more than one is showing. Errors never replace the
  transcript.

### 1.3 Message rendering

**Header row** for every message: a small avatar (agent colour disc with initial for the assistant,
neutral disc for the user) and the display name.

**User message**: right-aligned bubble in the accent-tinted surface. Tapping the bubble starts **edit**
(the action row for user messages is revealed by long-press instead):
the composer is pre-filled with the text, an "Editing ✕" banner appears above the composer, and Send
submits the edited text as a new turn (the original stays in history — the den has no replace route).
✕ cancels.

**Assistant message**: plain markdown on the page surface (no bubble), text selectable.

**Chain-of-thought timeline** (shown above the assistant text when the turn had reasoning or tools):
- a vertical timeline of steps; collapsed by default to the **last two steps** plus a "N more" toggle
  that expands the rest; "collapse" folds it back;
- **reasoning step**: lightbulb icon + "Reasoned for X.Xs". The duration is measured on the phone from
  the first reasoning delta to the first assistant-text delta of that turn, else the first tool call,
  else turn-complete, ticking live while it runs.
  While live, a fixed-height preview (about six lines) auto-scrolls the reasoning text with faded top
  and bottom edges; when reasoning ends the step auto-collapses to the one-line label. Tapping toggles
  the full text;
- **tool step**: tool icon + the existing human title ("Ran: …", "Read x", "Edited x", "Searched: …") and
  a status glyph (running / done / failed). Tapping opens a **tool detail sheet**: the tool name, the
  arguments pretty-printed, and the result text (scrollable, monospace). Steps whose tool is still
  running show a spinner;
- **approval** and **ask-user** cards stay as they are today, rendered in the timeline position where the
  request occurred.

**Attachments**: `[attached: <uri>]` lines in a user turn are not shown as text; they render as chips
under the bubble — image thumbnails (tap to view full-screen) for image types, a file pill with an icon
and the file name for everything else.

**Action row** under each completed message, revealed on tap (assistant) / long-press (user) or shown
always (setting): Copy · Regenerate (assistant
messages: resend the preceding user text as a new turn; asks for confirmation) · More. The **More** sheet
offers: Select & copy (a selectable full-text view), Edit (user messages), Share (system share sheet with
the message text). Fork and Delete are not offered in this version.

**Stats line** (setting, off by default) under assistant messages: input tokens (with cached count when
present) and output tokens. Rate and duration are shown only when the wire carries timings.

### 1.4 Markdown and code

- Headings, emphasis, lists, quotes, links, tables and inline code render as today.
- **Code blocks** have a header row: language label (or "code"), **Copy** and **Save** (system file
  picker, default name from the language). Blocks longer than ten lines are collapsed to a preview with
  an "N lines — expand" row; expanding is remembered for the session. Settings: line numbers on/off,
  word wrap on/off.
- Syntax colouring for common languages (Kotlin, TypeScript/JavaScript, Python, shell, JSON, YAML, SQL)
  with a plain fallback; colours come from the theme's code palette.
- LaTeX is out of scope for this version.

## 2. Left drawer

Width about 300dp; opens from the menu button or an edge swipe. There is no right drawer.

Top to bottom:

1. **Node status strip**: three labelled dots — `agent` (the active node's den is healthy and the chat
   socket is open), `mesh` (the mesh registry socket is open), `hub` (the entry/DataHub node answers).
   Filled accent dot = up, red dot = down, hollow grey = unknown. The strip derives from state the app
   already holds (socket status, last health result); tapping it triggers one refresh. It never polls.
2. **Conversation list** (replaces the right history drawer):
   - sections in order: **Pinned**, **Today**, **Yesterday**, then one section per calendar day in the
     device's local time zone (with the year when not the current year); a conversation whose timestamp
     is missing or unparsable sorts under Today; archived conversations remain in their existing
     collapsible block at the end;
   - rows are single-line pills: title (or the draft placeholder), a small pulsing accent dot while that
     session has a turn in flight, a pin glyph on pinned rows; the current conversation is highlighted
     and scrolled into view when the drawer opens;
   - the existing filter field appears above the list past the same row-count threshold as today;
   - **long-press menu**: Pin / Unpin · Rename · Move to agent (sheet listing agents; re-points that
     agent's pointer at this session) · Archive / Unarchive · Hide (removes the row locally; the session
     itself is untouched because the den has no delete) · Discard draft (drafts only).
3. **Node switcher** chip (current node name; existing sheet).
4. **Footer**: round icon buttons — **Agents** (opens the agents picker sheet: one row per agent preset
   with colour, name, node and directory basename; tap opens a new conversation for that agent; long-press
   keeps today's Start over / Edit / Go to node actions), **Tasks**, **Memory**, **Settings**.

## 3. Agents

An **agent** is a preset from the DataHub registry: name, colour, harness, model, effort, system prompt,
hosting node and working directory. The phone shows all of these read-only in the picker and lets the
user edit name, colour, model, effort, system prompt, directory and the "link shared directory" toggle;
the node is fixed where the agent was created. Opening an agent asks the den to start the session *for
that agent* so the den chooses the directory, command, model and effort. If the den answers that the
session already runs in a different directory, the app offers "Resume here anyway" and only then retries
with force. Against a node whose den predates the agent registry the app falls back to today's explicit
spawn (command, model, effort) so the agent still opens, just in the node's default directory (slice D1
owns this compatibility path).

## 4. Composer

A rounded card with a hairline outline, sitting above the keyboard.

- Attachment chips (thumbnail or file pill, ✕ to remove) sit in a row above the text field.
- An **"Editing ✕"** banner appears at the top of the card while editing (§1.3).
- Text field grows to a few lines then scrolls.
- **Bottom row**: **Model** pill (opens a sheet: search field, a Favourites group first, then models
  grouped by provider/harness; long-press a row to favourite) · **Effort** pill (harness sheet levels) ·
  **+** button (panel: Photo from library, Camera, File, Compress context — sends the harness's compact
  command through the normal inject path when the harness has one, otherwise hidden) · **Delegate…**
  (visible when the field has text: opens the delegate sheet, §6) · mic placeholder (disabled; phase 2) ·
  **Send** (up arrow). While a turn is in flight Send turns red and becomes **Stop** if the driver
  supports interrupt; long-press Send while in flight queues the text (existing queue strip).
- Sending is refused while an attachment is still uploading.

## 5. Terminal view

Reached by the Terminal chip; the same session, same PTY.

- **Header**: back arrow (returns to Chat and triggers a transcript resync so new turns appear) · title
  `<model display> · <conversation title>`; the running program may replace the title; the app appends
  " (ended)" when the session has exited and " · remote" when the session's node is not the entry node.
- Screen stays on while the terminal is visible. Tapping the grid focuses it and raises the keyboard;
  the grid rides above the keyboard.
- Scrollback of at least 4000 lines; one-finger scroll with fling (existing).
- **Key row** (horizontally scrollable): CTRL, ALT, ESC, TAB, ↑, ↓, ←, →, then the existing extras.
  CTRL and ALT are **sticky**: tap to arm (highlighted), the next key or typed character is sent with
  that modifier, then it clears. ALT sends the ESC-prefixed form. Long-press behaviours already present
  are kept.
- **Ended state**: a bar at the bottom reading "Session ended." with **Restart** (drops and re-attaches
  the PTY for this session) and **Back to chat**.
- **Remote error state**: message plus **Retry** and **Back**.
- Leaving the view never kills the session (existing rule).
- System Back in Terminal view returns to Chat.

## 6. Tasks and delegation

- **Tasks** screen (drawer footer): a list of tasks with status filter, each row showing goal, agent,
  executor/target and time; tap opens the task detail (goal, status, agent and node, result or error,
  a steer field, and Kill behind a confirm). **New task** opens a sheet: goal, agent picker (local agents,
  then mesh agents, then presets labelled "name (agent · harness @ node)"; presets the node cannot run
  headlessly are disabled with the reason as helper text), optional acceptance criteria one per line.
- **Delegate…** from the composer pre-fills the goal with the composer text, offers the same agent picker,
  and on Create clears the composer and opens the task detail. Send itself never delegates.
- **Inbox** (bell in the drawer): filled by the notifications socket — task completed, escalation,
  workflow gate. Tapping a task item opens its detail. When the app is backgrounded, task completion also
  posts a system notification (behind a Settings toggle).

## 7. Settings additions

Show message stats · Show action row always · Code: line numbers · Code: word wrap · Font scale ·
Task notifications (system) · existing items unchanged.

## 8. Out of scope for this program

Multi-provider configuration, translation, a phone-hosted web server, web-search providers, backup/restore,
image generation, favourites of messages, text-to-speech auto-play, additional locales, LaTeX rendering,
fork and delete of messages, conversation delete (no den route), regenerate-title (no den route).
