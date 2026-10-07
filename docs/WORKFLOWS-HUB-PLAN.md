# Workflows hub & editor — UX plan

_Status: in progress (2026-10-07). Workflows stays behind Settings → Experimental
for the whole of this plan._

## Why

The Workflows tab works but is hard to use:

- The hub is two flat lists (definitions, last 50 runs). There is no create,
  no search, no per-workflow health, and runs are identified only by a UUID.
- There is no API to create a workflow; the only way in is writing files.
- The workflow page mixes concerns: **Run** mode is where the editable canvas
  lives, while **Edit** mode is a separate file tree + YAML editor.
- The custom canvas has pan / drag / wire, but no zoom, undo, auto-layout, or
  on-node diagnostics.

## Decisions

- **Keep the custom `<canvas>` renderer** (`flows-canvas.tsx`). No React Flow.
  Missing features are added on top of it (step 4).
- **Create-from-prompt runs as a RivetOS agent task** (`/api/tasks`), not a
  bare provider call — steering, tools, and memory come for free.
- **The generator emits a `FlowAuthorGraph`, never files.** The UI validates it
  with the existing graph helpers and opens it as an unsaved draft;
  `compileFlow` + the create endpoint write files only on Save. Everything a
  prompt produces is therefore canvas-editable and DAG-valid by construction.
- **Run labels live in a sidecar `run-meta.json`** in the case dir, not in
  `case.json`. `case.json` is engine state and is immutable once a run is
  terminal (`updateCase` drops the write), but renaming a finished run is the
  main use case — and a separate file can't race the engine's own writes.

## Steps

### 1. Run labels, homescreen, search — done

Engine / API

- `workflow.yaml` gains optional `runLabel`, a template over input fields:
  `runLabel: "{{repo}}#{{pr}}"`. Unknown keys render empty; result is trimmed
  and capped.
- `POST /api/workflows/:id/runs` accepts an optional `label` control key.
  Precedence: explicit `label` → rendered `runLabel` → none (UI falls back to
  the workflow name).
- `PATCH /api/workflow-runs/:id` `{ label }` renames (empty string clears).
- `RunSummary` / `WorkflowRunSummary` carry `label`.
- `GET /api/workflow-runs` takes `workflowId`, `status` (comma list) and `q`
  (substring over label / id / workflowId), filtered before the limit.
- `GET /api/workflows` adds per-def `stats`: last run (id, status, time),
  runs in the last 7 days, failed in the last 7 days, runs waiting on a gate.

Hub UI

- Header: search box (`/` focuses) — filters cards and runs.
- **Needs you** strip: runs in `paused_human`, linking straight to the gate.
- Workflow **cards** grid: name, description, last-run status + relative time,
  7-day run / failure counts, waiting count; **Run** and **Edit** actions.
- **Runs** table: label (or workflow name), workflow, status, started,
  duration; status and workflow filters.
- Trigger form: optional **Run name** field, placeholder previews `runLabel`.
- Run detail: label as the title, click to rename.

### 2. Create workflow (scratch / duplicate) — done

- `POST /api/workflows` `{ id, name, description?, root?, from? }`
  (`createWorkflowDef` in packages/workflows). Blank = the smallest def that
  loads (`step.done({})`), so the canvas starts from Start; `from` copies a
  def dir and rewrites id / name / description in place, keeping comments.
  Built in a staging dir and renamed into place, only after it loads. Only
  under a defs root inside the files root (so the result is editable);
  `GET /api/workflows` lists those as `createRoots`.
- Hub **New workflow** dialog: _From scratch_ / _Duplicate_ (and, in step 5,
  _From prompt_). Lands in the editor.

### 3. Workflow page restructure — done

- `pages/workflow-page.tsx`: tabs **Overview** (description, health tiles,
  input/output contract, `runLabel`, this workflow's runs with a status
  filter) · **Canvas** (flows editor) · **Files** (file tree + workflow.yaml
  form, unchanged). The tab is `?view=canvas|files` — not `tab`, which the
  Memory page owns and route search types merge.
- **Run** opens a right-hand sheet (run name + contract form) from any tab;
  starting navigates to the live run page. The sheet is local state, not a
  URL change, so opening it never trips the unsaved-edits blocker.
- Hand-written `run.ts` defs show a notice on the canvas that saving
  replaces run.ts with generated code (the save-time confirm still applies).
- Deviation from the original sketch: Files stays a tab rather than a
  drawer, and there is no separate Settings tab — the contract / `runLabel` /
  budgets are edited through the Files tab's workflow.yaml form. Revisit if
  that form proves too buried.

### 4. Canvas

In dependency order:

1. View transform (zoom/pan as one matrix; all hit-testing through it),
   cursor-anchored wheel / pinch zoom, fit-to-view.
2. Undo / redo — history stack over `FlowAuthorGraph` (edits are already pure).
3. Diagnostics badges on nodes; clicking a diagnostic selects its node.
4. "+" affordance at wire ends; drag from palette onto canvas.
5. Auto-layout button (reuse `flow-layout.ts`).
6. Keyboard: delete, duplicate, ⌘S, ⌘Z; an off-screen node list mirroring
   selection for screen readers and tests.
7. Save shows a diff of generated files (`run.ts`, `agents/*`).
8. Test-run from the editor using the existing `statusById` overlay.

### 5. Create from prompt

- _From prompt_ tab creates an agent task whose system prompt documents the
  `FlowAuthorGraph` schema and node kinds, with one or two existing graphs as
  examples. The task's final output is graph JSON.
- UI validates (DAG, reachable from Start), opens an unsaved draft in the
  editor, and shows a chat strip that steers the task (`steerTask`); each
  reply replaces the draft (undo-able).
- Later: "prompt to modify" an existing workflow — same loop seeded with the
  current graph.
