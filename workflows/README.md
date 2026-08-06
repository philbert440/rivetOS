# Workflow definitions

Real workflow recipes, deployed with the code — the default `defs_roots`
includes `<install>/workflows` alongside `/rivet-shared/workflows/defs`.

Each workflow is a directory: `workflow.yaml` (contract) + `run.ts`
(deterministic orchestration over the step SDK) + `agents/<name>.md`
(frontmatter config + prompt body) + optional `scripts/`.

## Authoring notes

- **Agent tool access**: workflow agent steps currently inherit the host
  agent's default tool filter — per-agent `tools:` frontmatter is NOT yet
  enforced by the chat-loop executor (tracked follow-up). Do not declare a
  `tools:` list until enforcement lands; it would be documentation-only.
- **Final output contract**: the task runner appends TASK_RESULT fence
  instructions to every agent goal. Agent prompts must direct the model to
  put the step's declared out-fields, JSON-encoded, into the TASK_RESULT
  `output` field (the executor also parses a raw trailing JSON object as a
  fallback).
- **Untrusted text** (inputs like titles/goals/focus, and anything read from
  a PR) is fenced as DATA in step prompts — keep that pattern.
- **Composition**: children called via `step.call` must not pause — v1
  sync-wait cannot suspend a child. `pr-review` models this with its
  `gated` input; parents pass `gated: false` and own the human gates.
- **Determinism**: `run.ts` must not use Date/random/IO outside `step.*`.
