# @rivetos/workflows

Workflows v1 engine — **document model**, **step SDK**, **journal-replay**, **start API**.

Product SoT: `/rivet-shared/plans/workflows-product-v1.md` (rev 4).

## Thesis

A **workflow** is a versioned, durable process that advances a **case** through agents, scripts, humans, and child workflows. Runs are **state, not processes** — a human gate can park for days at zero cost.

- **Workflows** own structure: case, journal, gates, composition.
- **Work units** own execution: opaque, run-to-completion.
- **`step.call`** is the universal joint (native children + namespaced foreign resolvers).

## Directory convention

```text
workflows/<name>/
  workflow.yaml              # manifest: id, version, input/output, budgets, outline
  run.ts                     # orchestration (code-first step SDK)
  agents/<name>.md           # YAML frontmatter (tools/model/maxTurns) + prompt body
  scripts/                   # optional step.run shell scripts (cwd = caseDir)
```

Agent files use the same frontmatter-plus-prompt shape as Claude Code agent definitions.

### Example recipe (repo root)

The monorepo top-level `workflows/` directory ships `hello-world`, a minimal
example of the convention (script step → agent step → human gate → done).
Real recipes live outside the code repo in a deployment's defs root — the
gateway workflow API defaults to `/rivet-shared/workflows/defs`, which
shadows shipped definitions. This package itself takes explicit
`workflowsRoots` / `workflowDirs`; only `caseDirRoot` has a built-in default.

Fixture coverage: `src/recipes.fixture.test.ts`.

## Step SDK

```ts
export default async function run(step: Step, ctx: RunScriptContext) {
  const pr = await step.run('load-pr', { script: 'scripts/load_pr.sh', in: {...} })
  let attempt = 0, verdict
  while (!verdict?.approved && attempt++ < 5) {
    const findings = await step.agent('reviewer', { agent: 'reviewer', prompt: '...', out: ['findings'] })
    verdict = await step.human('review-gate', { prompt: '...', fields: ['approved'] })
  }
  await step.done({ verdict })
}
```

| Step | Role |
|------|------|
| `step.agent` | Dispatch agent work unit (backend via `ExecutorRegistry`) |
| `step.run` | Script / skill / API work unit |
| `step.human` | Human gate — **always suspends** (see below) |
| `step.call` | Child workflow or namespaced foreign unit |
| `step.done` | Finish with output fields |
| `step.parallel` | Concurrent branches (see below) |

### Journal-replay

Every step call is journaled with `(label, seq)` as the stable id (`label#seq`). On resume the engine re-executes `run.ts` from the top; journaled calls return cached results; execution continues live past the suspension point.

### Human gates — `WorkflowSuspension`

`step.human` **never** resolves inline:

1. Writes `gate_opened` to `journal.jsonl`
2. Sets run status `paused_human`
3. Throws `WorkflowSuspension` (control-flow exception, not a failure)

The engine catches it and returns `{ suspended: true }`. `resumeRun(runId, { gateResponse })` appends `gate_resolved`, merges fields into `case.json`, and re-executes.

### Determinism rule

Orchestration code (`run.ts`) **must** be deterministic between replays:

- No `Date.now()` / `new Date()` / `Math.random()`
- No I/O outside `step.*` calls
- All nondeterminism lives **inside** steps (journaled)

Use `checkRunScriptDeterminism(source)` for a best-effort static scan. Prefer a real eslint rule later.

### Budgets (manifest `budgets`)

Optional caps in `workflow.yaml`:

```yaml
budgets:
  maxTokens: 100000        # total tokens across the run (all agent/run steps)
  maxCost: 2.50            # total USD cost
  maxConcurrentRuns: 3     # non-terminal runs of this workflowId (incl. nested children)
```

- **Absent / zero-ish fields** — that dimension is unlimited.
- **Token/cost** — the step runtime accumulates usage reported by executors via an optional `reportUsage` callback on `AgentExecuteOpts` / `RunExecuteOpts`. Each `step_finished` may carry a `usage: { tokens?, costUsd? }` field. Before every step begins, if accumulated spend **exceeds** the cap, the engine throws `BudgetExceededError` and the run ends **failed** with a message naming the budget and the spend. On resume/continue, journaled usage is re-accumulated so the spent total is preserved.
- **maxConcurrentRuns** — enforced at `startRun` by scanning `caseDirRoot` (including nested child runs). At/over the cap → `MaxConcurrentRunsError`. The workflow API maps this to **HTTP 429**. Mid-run budget kills are ordinary run failures (status `failed`), not 429.
- Host agent executor (`createTaskAgentExecutor`) reports `totalTokens` / `costUsd` from the terminal task row when present. If the task engine leaves usage empty, the callback is still wired — that step simply contributes zero (plumbing lands regardless).

### `step.parallel`

```ts
const results = await step.parallel('fan-out', [
  async (s) => s.agent('left', { out: ['x'] }),
  async (s) => s.run('right', { script: 'scripts/other.sh' }),
])
// results is T[] in **branch-index order** (not completion order)
```

Semantics:

| Rule | Detail |
|------|--------|
| Journaled parent | kind `parallel`, stable id `label#seq`; fully journaled → replay returns cached `T[]` without re-running branches |
| Branch Step | each branch `i` gets a scoped Step; inner labels are namespaced `` `${parallelStepId}/b${i}:` + label `` and share the **same** `journal.jsonl` |
| Journal writes | appends are **serialized** (promise chain per journal path) so concurrent branches never interleave partial JSONL lines |
| Working dirs | `caseDir/<parallelStepId>/b<i>/` — passed as `caseDir` to that branch's agent/run executors so artifacts don't collide |
| **No case.json merge from branches** | agent out-fields from branch steps are **not** merged into `case.json` (conflict hazard). Branch results flow only through the returned `T[]`, which is journaled as the parallel step's result |
| Failure | `Promise.all` semantics — one branch rejection fails the whole parallel (journaled `step_failed`). Sibling in-flight executor work is **not** cancelled (AbortSignal is a tracked follow-up) |
| Restrictions | no `step.human`, no nested `step.parallel`, no `step.done` inside a branch (clear errors) |
| Budgets | shared accumulation with the parent run; budget checks apply between branch steps too |
| Crash/replay | branch fns re-run; completed inner steps replay from the kind-aware journal cache |

## Engine API

```ts
import {
  WorkflowEngine,
  MockExecutorRegistry,
  loadWorkflowDir,
} from '@rivetos/workflows'

const engine = new WorkflowEngine({
  caseDirRoot: '/var/rivetos/workflow-runs', // config — never hardcode in call sites
  executors: new MockExecutorRegistry(),    // or LocalExecutorRegistry (stubs until wired)
  workflowsRoots: ['/path/to/workflows'],
})

const started = await engine.startRun('hello-world', { name: 'Ada' }, { type: 'human', id: 'phil' })
if (started.suspended) {
  // notify human; later:
  await engine.resumeRun(started.run.id, { gateResponse: { approved: true } })
}
```

### Config keys

| Key | Default | Notes |
|-----|---------|-------|
| `caseDirRoot` | `/rivet-shared/workflows/runs` | Override in tests with a temp dir |
| `defaultStepTimeoutMs` | 30 min | Passed to executors; full AbortSignal enforcement TODO |
| `maxRunRuntimeMs` | 24 h | Engine races the run script against this deadline |
| `executors` | required | `agent` + `run` backends |
| `callRegistry` | native only | Register foreign namespaces (`ext:` etc.) as needed |
| `workflowDirs` | — | Explicit id → dir map (tests) |
| `workflowsRoots` | — | Search roots for bare refs |

### Timeouts — where enforced

| Layer | Status |
|-------|--------|
| Run max-runtime | Enforced in engine via Promise race |
| Step timeout | Passed as `timeoutMs` to executors; **real AbortSignal kill is TODO** when ros_task executor lands |
| Child kill cascade | `killRun` writes `KILLED` file; flag checked between steps |

## Executors

Backend-neutral. Ship:

- **`MockExecutorRegistry`** — fixture tests
- **`LocalExecutorRegistry`** — stubs that throw until reviewer wires ros_task / script backends

```ts
interface ExecutorRegistry {
  agent: { execute(opts: AgentExecuteOpts): Promise<Record<string, unknown>> }
  run:   { execute(opts: RunExecuteOpts): Promise<unknown> }
}
// opts may include reportUsage?: (usage: { tokens?: number; costUsd?: number }) => void
```

## Call registry

- Bare ref → native child workflow (nested caseDir, sync wait, fail/kill cascade)
- `namespace:name` → registered resolver
- Unknown namespace → error listing known namespaces

## Scaffold

```ts
import { scaffoldWorkflow } from '@rivetos/workflows'
await scaffoldWorkflow('my-flow', { dir: './workflows' })
```

CLI: `rivetos workflow new <name>` (see `packages/cli`).

## Run directory layout

```text
<caseDirRoot>/<run-id>/
  case.json        # run metadata + field bag
  journal.jsonl    # append-only step journal
  KILLED           # optional kill flag
  <child-...>/     # nested child runs from step.call
  <parallelStepId>/b0/   # branch working dirs (artifacts only — not case.json)
  <parallelStepId>/b1/
```

**No secrets in run state.** Run dirs may sync mesh-wide.

## Loading `run.ts`

- Production: compile workflow dirs or run the host with `tsx` so dynamic `import()` of `run.ts` works.
- Tests: pass `runScript` into `startRun` / `resumeRun` (skips disk load).
- Resolution order in a workflow dir: `run.js` → `run.mjs` → `run.ts`.

## Non-goals (v1)

Expression languages · graph IDE · fire-and-forget calls · secrets in case state · building on old RivetHub canvas code · cancelling sibling parallel branches via AbortSignal (tracked follow-up).
