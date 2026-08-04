# Workflows IR v2 — nested graph validation rules

**Status:** normative for `validateWorkflowV2`  
**Ratified:** 2026-08-04 (`/rivet-shared/plans/workflows-ir-v2.md`)  
**Principle:** validation rules shape types; illegal wiring should be hard to represent and always rejectable with stable error codes.

## Invariants (testable)

### I1 — DAG at every level
- **I1.a** Top-level `def.graph` is a directed acyclic graph (edges are data/control between nodes in that graph only).
- **I1.b** Every composite body (`MapNode.body`, `LoopNode.body`) is itself a DAG.
- **I1.c** A cycle may only be *encoded* by Loop/Map semantics, never as a back-edge inside a single graph level.

**Error codes:** `graph.cycle`, `graph.cycle_in_body`

### I2 — No reach-through across subgraph boundaries
- **I2.a** An edge’s `from.nodeId` and `to.nodeId` must both refer to nodes in the **same** graph level (top-level or one body).
- **I2.b** Edges must not connect a parent-graph node to a body-internal node id.
- **I2.c** Parent ↔ body data movement uses **boundary ports** on the composite node plus an explicit **bodyPortMap** (composite boundary port id → body node port ref), never ambient lexical scope.

**Error codes:** `edge.unknown_node`, `edge.cross_boundary`, `composite.missing_body_port_map`, `composite.invalid_body_port_map`

### I3 — Ports exist and directions match
- **I3.a** Edge endpoints reference existing ports on the endpoint nodes.
- **I3.b** Source port is an **out** port; target port is an **in** port.
- **I3.c** Optional: when both ports declare `schema` or `kind`, kinds should match (`edge.kind_mismatch`).

**Error codes:** `edge.unknown_from_port`, `edge.unknown_to_port`, `edge.from_not_out`, `edge.to_not_in`, `edge.kind_mismatch`

### I4 — MapNode
- **I4.a** `body` graph present (may be empty only if join is trivial — still require object).
- **I4.b** `join.policy` ∈ `all | any | quorum`.
- **I4.c** If policy is `quorum`, `join.n` is integer `>= 1`.
- **I4.d** If `itemsPath` / static fan-out length `F` is known and policy is quorum, require `n <= F` when `F` is a finite constant; otherwise emit **warning** `map.quorum_unbounded` (runtime enforces).
- **I4.e** `concurrency` if set is integer `>= 1`.
- **I4.f** Body boundary: every key in `bodyPortMap.inputs` / `bodyPortMap.outputs` names a boundary port on the Map node; every value names `bodyNodeId.portId` inside the body.

**Error codes:** `map.missing_body`, `map.bad_join_policy`, `map.bad_quorum`, `map.quorum_exceeds_fanout`, `map.bad_concurrency`, `map.bad_port_map`

### I5 — LoopNode
- **I5.a** `maxIterations` required, integer `>= 1`.
- **I5.b** Exactly one of `while` or `until` expression present (or both forbidden — we require **exactly one**).
- **I5.c** Expression is tagged `{ dialect, expr }` with `dialect ∈ simple | cel` and non-empty `expr`.
- **I5.d** Body present; bodyPortMap valid (same as Map boundary rules).

**Error codes:** `loop.missing_max_iterations`, `loop.bad_max_iterations`, `loop.missing_condition`, `loop.bad_expression`, `loop.missing_body`, `loop.bad_port_map`

### I6 — GateNode
- **I6.a** `predicate` is a tagged expression (I5.c).
- **I6.b** Gate is not an agent (no prompt/exec on gate).
- **I6.c** At least one control out-port (or explicit branches list). Soft warning if fewer than two branches.

**Error codes:** `gate.bad_predicate`, `gate.missing_branches` (warning)

### I7 — AgentStep (executable profile)
When validating with `mode: 'executable'` (default for v2 full validate):
- **I7.a** Non-empty `prompt` (or `promptRef` if we add later — v2 requires `prompt` string non-empty after trim).
- **I7.b** `exec.capability` present and valid enum.

**Error codes:** `agent.missing_prompt`, `agent.bad_capability`

### I8 — Identity
- Unique node ids within a graph level (body ids may reuse names only inside their body — uniqueness is **per graph**, not global across nestings).
- Unique edge ids within a graph level.
- Unique port ids within a node.

**Error codes:** `node.duplicate_id`, `edge.duplicate_id`, `port.duplicate_id`

### I9 — WorkflowDef shell
- Non-empty `id`, `name`; `version >= 1`.
- `graph` present.
- Workflow-level `inputs`/`outputs` are port lists (may be empty).

**Error codes:** `def.missing_id`, `def.missing_name`, `def.bad_version`, `def.missing_graph`

## Expression dialect (`simple` MVP)

Allowed forms (validator may only check structure; evaluation is scheduler’s job):
- Non-empty string `expr`
- `dialect: 'simple' | 'cel'`

Unknown dialect → `expr.unknown_dialect`.

## Examples

### Legal Map wiring
Parent: `source.out → map.items`, `map.results → sink.in`  
Map body: `bodyIn → agent → bodyOut`  
`bodyPortMap.inputs.items = bodyIn.in`, `bodyPortMap.outputs.results = agent.out`

### Illegal reach-through
Parent edge `source.out → bodyAgent.in` where `bodyAgent` lives only inside `map.body` → `edge.cross_boundary` / `edge.unknown_node` at parent level.

## Stable error code index

| Code | Severity | Invariant |
|------|----------|-----------|
| `def.missing_id` | error | I9 |
| `def.missing_name` | error | I9 |
| `def.bad_version` | error | I9 |
| `def.missing_graph` | error | I9 |
| `graph.cycle` | error | I1.a |
| `graph.cycle_in_body` | error | I1.b |
| `node.duplicate_id` | error | I8 |
| `edge.duplicate_id` | error | I8 |
| `port.duplicate_id` | error | I8 |
| `edge.unknown_node` | error | I2 |
| `edge.cross_boundary` | error | I2.b |
| `edge.unknown_from_port` | error | I3 |
| `edge.unknown_to_port` | error | I3 |
| `edge.from_not_out` | error | I3 |
| `edge.to_not_in` | error | I3 |
| `edge.kind_mismatch` | error | I3.c |
| `map.missing_body` | error | I4 |
| `map.bad_join_policy` | error | I4 |
| `map.bad_quorum` | error | I4 |
| `map.quorum_exceeds_fanout` | error | I4 |
| `map.bad_concurrency` | error | I4 |
| `map.bad_port_map` | error | I4 |
| `map.quorum_unbounded` | warning | I4 |
| `loop.missing_max_iterations` | error | I5 |
| `loop.bad_max_iterations` | error | I5 |
| `loop.missing_condition` | error | I5 |
| `loop.bad_expression` | error | I5 |
| `loop.missing_body` | error | I5 |
| `loop.bad_port_map` | error | I5 |
| `gate.bad_predicate` | error | I6 |
| `gate.missing_branches` | warning | I6 |
| `agent.missing_prompt` | error | I7 |
| `agent.bad_capability` | error | I7 |
| `expr.unknown_dialect` | error | expr |
| `composite.invalid_body_port_map` | error | I2 |

## Non-goals for this validator

- Evaluating CEL/simple expressions  
- Runtime join/fan-out  
- Trigger scheduling  
- Migrating v1 localStorage catalog  
