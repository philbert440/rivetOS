# Workflow definitions

This directory ships only the `hello-world` example. Real workflow recipes
live outside the code repo, in a defs root private to each deployment — the
default `defs_roots` resolves `/rivet-shared/workflows/defs` ahead of
`<install>/workflows`, so recipes there shadow anything shipped here. Recipes
carry agent prompts and deployment-specific references that do not belong in
a public repo; keep them in your defs root (back it with a private git repo).

Each workflow is a directory: `workflow.yaml` (contract) + `run.ts`
(deterministic orchestration over the step SDK) + `agents/<name>.md`
(frontmatter config + prompt body) + optional `scripts/`. Copy `hello-world`
as a starting point, or use the scaffold command.

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
- **Untrusted text** (inputs like titles/goals, and anything read from
  external sources) is fenced as DATA in step prompts — keep that pattern.
- **Composition**: children called via `step.call` must not pause — v1
  sync-wait cannot suspend a child. Give a child that has a human gate a
  `gated` input; parents pass `gated: false` and own the human gates.
- **Determinism**: `run.ts` must not use Date/random/IO outside `step.*`.
