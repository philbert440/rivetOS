# Workflows IR v2 — nested graph validation rules

**Status:** normative for `validateWorkflowV2`  
**Ratified:** 2026-08-04 (`/rivet-shared/plans/workflows-ir-v2.md`)  
**Principle:** validation rules shape types; illegal wiring should be hard to represent and always rejectable with stable error codes. Codes in this index **must** match every `code:` literal emitted by `validate.ts` (enforced by unit test).

## Invariants (testable)

### I1 — DAG at every level
- **I1.a** Top-level `def.graph` is a DAG.
- **I1.b** Every composite body (`MapNode.body`, `LoopNode.body`) is itself a DAG.
- **I1.c** Cycles are encoded only by Loop/Map semantics, never as back-edges in a single level.

**Codes:** `graph.cycle`, `graph.cycle_in_body`

### I2 — No reach-through across subgraph boundaries
- **I2.a** Edge endpoints must both refer to nodes in the **same** graph level.
- **I2.b** `edge.cross_boundary` only when a missing endpoint id exists inside a **descendant body** (not for plain typos).
- **I2.c** Parent ↔ body data uses **boundary ports** + explicit **bodyPortMap** (`boundaryPortId` → `bodyNodeId.portId`).

**Codes:** `edge.unknown_node`, `edge.cross_boundary`, `composite.missing_body_port_map`, `composite.invalid_body_port_map`

### I3 — Ports exist and directions match
**Codes:** `edge.unknown_from_port`, `edge.unknown_to_port`, `edge.from_not_out`, `edge.to_not_in`, `edge.kind_mismatch`, `port.duplicate_id`, `port.direction_mismatch`

### I4 — MapNode
**Codes:** `map.missing_body`, `map.bad_join_policy`, `map.bad_quorum`, `map.quorum_exceeds_fanout`, `map.bad_concurrency`, `map.bad_items`, `map.bad_static_fanout`, `map.quorum_unbounded` (warning), plus composite bodyPortMap codes

### I5 — LoopNode
**Codes:** `loop.missing_max_iterations`, `loop.bad_max_iterations`, `loop.missing_condition`, `loop.ambiguous_condition`, `loop.bad_expression`, `loop.missing_body`, plus composite bodyPortMap codes

### I6 — GateNode
**Codes:** `gate.bad_predicate`, `gate.missing_branches` (warning)

### I7 — Agent / Approval / Tool / Subworkflow / Script (executable mode)
**Codes:** `agent.missing_prompt`, `agent.bad_capability`, `approval.missing_prompt`, `tool.missing_tool`, `subworkflow.missing_id`, `script.bad_dialect`, `script.missing_source`

### I8 — Identity
**Codes:** `node.missing_id`, `node.duplicate_id`, `edge.missing_id`, `edge.duplicate_id`, `port.duplicate_id`

### I9 — WorkflowDef shell
**Codes:** `def.missing_id`, `def.missing_name`, `def.bad_version`, `def.missing_graph`, `def.malformed`

### Expressions
**Codes:** `expr.unknown_dialect` (+ field-specific bad codes: `gate.bad_predicate`, `loop.bad_expression`, `map.bad_items`)

## Deferred (scheduler slice) — reserved, not enforced yet

| Code | Intent |
|------|--------|
| `def.port_map_missing` | Workflow-level port map (trigger payload → entry node ports), symmetry with `bodyPortMap` |
| `port.unwired_required` | Required node input must have an incoming edge (or def-level map binding) |

Def-level `WorkflowDefV2.inputs` / `outputs` currently do not auto-wire into the graph; prompt templates may reference `{{inputs.*}}` ambiently until the scheduler defines the binding contract.

## Stable error code index

| Code | Severity | Notes |
|------|----------|-------|
| `def.missing_id` | error | I9 |
| `def.missing_name` | error | I9 |
| `def.bad_version` | error | I9 |
| `def.missing_graph` | error | I9 |
| `def.malformed` | error | Untrusted JSON / throw catch-all |
| `graph.cycle` | error | I1.a |
| `graph.cycle_in_body` | error | I1.b |
| `node.missing_id` | error | I8 |
| `node.duplicate_id` | error | I8 |
| `edge.missing_id` | error | I8 |
| `edge.duplicate_id` | error | I8 |
| `port.duplicate_id` | error | I8 |
| `port.direction_mismatch` | error | I3 |
| `edge.unknown_node` | error | I2 |
| `edge.cross_boundary` | error | I2.b only when id is in a descendant body |
| `edge.unknown_from_port` | error | I3 |
| `edge.unknown_to_port` | error | I3 |
| `edge.from_not_out` | error | I3 |
| `edge.to_not_in` | error | I3 |
| `edge.kind_mismatch` | error | I3 |
| `map.missing_body` | error | I4 |
| `map.bad_join_policy` | error | I4 |
| `map.bad_quorum` | error | I4 |
| `map.quorum_exceeds_fanout` | error | I4 |
| `map.bad_concurrency` | error | I4 |
| `map.bad_items` | error | I4 |
| `map.bad_static_fanout` | error | I4 |
| `map.quorum_unbounded` | warning | I4 |
| `loop.missing_max_iterations` | error | I5 |
| `loop.bad_max_iterations` | error | I5 |
| `loop.missing_condition` | error | neither while nor until |
| `loop.ambiguous_condition` | error | both while and until |
| `loop.bad_expression` | error | I5 |
| `loop.missing_body` | error | I5 |
| `gate.bad_predicate` | error | I6 |
| `gate.missing_branches` | warning | I6 |
| `agent.missing_prompt` | error | I7 |
| `agent.bad_capability` | error | I7 |
| `approval.missing_prompt` | error | I7 |
| `tool.missing_tool` | error | I7 |
| `subworkflow.missing_id` | error | I7 |
| `script.bad_dialect` | error | I7 |
| `script.missing_source` | error | I7 |
| `expr.unknown_dialect` | error | expr |
| `composite.missing_body_port_map` | error | I2 |
| `composite.invalid_body_port_map` | error | I2 |

## Examples

### Legal Map wiring
Parent: `ingest.bundle → map.findings`, `map.ok → sink.in`  
Body: single agent `worker`  
`bodyPortMap.inputs.findings = worker.in`, `bodyPortMap.outputs.ok = worker.out`

### Illegal reach-through
Parent edge to `inner.in` where `inner` only exists inside `map.body` → `edge.unknown_node` + `edge.cross_boundary`.

### Illegal plain typo
Parent edge to `does_not_exist.in` → `edge.unknown_node` only (no cross_boundary).

## Non-goals for this validator

- Evaluating CEL/simple expressions  
- Runtime join/fan-out  
- Trigger scheduling  
- Migrating v1 localStorage catalog  
- Enforcing def-level port maps (deferred)  
