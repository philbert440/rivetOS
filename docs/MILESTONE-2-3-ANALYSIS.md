# Milestone 2 & 3 — Research & Planning Analysis

**Date:** April 3, 2026  
**Author:** Rivet Opus  
**Purpose:** Research-informed analysis before committing to M2/M3 architecture decisions.

---

## The Landscape (April 2026)

### What We Researched

| Framework/Tool | Key Insight |
|---|---|
| **Anthropic "Building Effective Agents"** | The most successful agent implementations use simple, composable patterns — not complex frameworks. Five workflow patterns: prompt chaining, routing, parallelization, orchestrator-workers, evaluator-optimizer. |
| **Claude Code / Agent SDK** | Agent loop = message → LLM → tools → response, in a loop. Skills = filesystem-based progressive disclosure (metadata always loaded, instructions on trigger, resources on demand). MCP for tool ecosystem. Custom tools as in-process MCP servers. |
| **Claude Agent Skills** | Three-tier loading: L1 metadata (~100 tokens, always), L2 instructions (<5k tokens, on trigger), L3 resources (unlimited, on demand via bash). Skills are directories on a VM filesystem. |
| **Microsoft AutoGen** | Multi-agent orchestration via `AgentTool` — wraps agents as tools for other agents. MCP-native. Being superseded by "Microsoft Agent Framework." |
| **Google A2A (Agent2Agent) Protocol** | Open protocol for inter-agent communication. Agent Cards for discovery. JSON-RPC 2.0 over HTTP(S). SSE streaming. Agents are opaque — don't expose internal state. |
| **CrewAI** | Two modes: Crews (autonomous agent teams) and Flows (event-driven workflows with precise control). Built from scratch, no LangChain dependency. "Flow" mode is their production architecture. |
| **AWS Strands Agents** | Model-driven approach. Hot reloading tools from `./tools/` directory. Native MCP support. Multiple model providers. Python decorators for tool definitions. |
| **NousResearch Hermes** | Function calling via special tokens (`<tool_call>`, `<tool_response>`). Recursive depth-limited function calling. JSON schema validation of tool outputs. Pydantic model integration. |

---

## Key Patterns We Should Support (Without Boxing Ourselves In)

### 1. Workflow Patterns (Anthropic's taxonomy)

Our current architecture handles the basic **agent loop** (message → LLM → tools → response → loop). But Anthropic identifies five workflow patterns that production systems need:

| Pattern | Our Status | Gap |
|---|---|---|
| **Prompt chaining** (step A → step B → step C) | ❌ No first-class support | Hooks could chain, but no data passing between steps |
| **Routing** (classify → dispatch to specialist) | ✅ Static routing exists | Need dynamic routing based on content |
| **Parallelization** (fan-out → fan-in) | ⚠️ Subagent spawn exists | No orchestrated fan-out/fan-in, no result aggregation |
| **Orchestrator-workers** (LLM decomposes → workers execute) | ⚠️ Delegation exists | No structured task decomposition protocol |
| **Evaluator-optimizer** (generate → evaluate → refine loop) | ❌ No support | coding_pipeline does this manually, not generalized |

**Recommendation:** M2 hooks should be designed so these patterns can be composed from hooks + tools, not baked into the core. The hook system is the right abstraction layer.

### 2. MCP (Model Context Protocol)

MCP is becoming the de facto standard for tool distribution. Every major framework now supports it. RivetOS should too.

**What MCP gives us:**
- Tool ecosystem — thousands of pre-built MCP servers
- Standard protocol for tool discovery, invocation, and result handling
- In-process SDK MCP servers (Claude Agent SDK pattern) — tools defined as functions, exposed via MCP
- Remote MCP servers — HTTP-based, run anywhere

**What we need to add (not in current roadmap):**
- **MCP client** in the runtime — can connect to MCP servers and register their tools
- **MCP server mode** — RivetOS can expose its tools as an MCP server for other clients
- This should be a plugin, not core

### 3. A2A (Agent-to-Agent Protocol)

Google's A2A is for inter-agent communication across trust boundaries. Our delegation system is currently intra-process. A2A would be relevant for:
- Our mesh networking vision (M6.6)
- Agents on different nodes communicating
- Third-party agents interacting with RivetOS agents

**Recommendation:** Our mesh registry (M6.6.4) should be designed A2A-compatible from day one. Agent Cards map well to our mesh entries. But building full A2A support is M6+ territory.

### 4. Progressive Skill Loading (Claude's three-tier model)

Claude's Agent Skills architecture is very close to what we already have, but more sophisticated:

| Their Tier | Our Equivalent | Gap |
|---|---|---|
| L1: Metadata (always loaded, ~100 tokens) | ✅ `skill_list` tool returns name + description | We load all descriptions at startup |
| L2: Instructions (loaded on trigger) | ⚠️ Agent can `shell cat SKILL.md` | No automatic trigger-based loading |
| L3: Resources (loaded as needed) | ⚠️ Agent can read any file | No progressive disclosure, no bundled scripts |

**Recommendation:** Our skill system is already close. For M2, we should:
- Add a `skill_read` tool that loads a skill's SKILL.md content on demand
- Support skills with bundled scripts (the agent can execute them via `shell`)
- Keep the `skill_list` tool as the L1 discovery mechanism
- Let hooks handle auto-triggering skills based on message content

### 5. Event-Driven Workflows (CrewAI Flows pattern)

CrewAI's "Flows" are event-driven DAGs with state management. This is essentially what our hook system (M2) could become if designed right.

**Key design principle:** Hooks should be composable into flows. A hook's output should be able to trigger another hook. This means hooks need:
- Data passing (not just "event happened" but "event happened with this data")
- Conditional execution (run hook B only if hook A's output matches condition)
- State management (accumulate results across a chain of hooks)

### 6. Tool Hot-Reloading (Strands pattern)

Strands watches a `./tools/` directory and hot-reloads tools. This is a developer experience win that should be in our roadmap (currently only mentioned as "Open Question #9" in ARCHITECTURE.md).

**Recommendation:** Add to M5 (Developer Experience) — file watcher on skill directories + tool plugin directories.

---

## What This Means for M2 (Hooks & Lifecycle)

### Current M2 Plan

The current M2 is solid but narrow. It defines hooks as fire-and-forget lifecycle events. Here's what needs to change to avoid boxing ourselves in:

### Proposed M2 Enhancements

#### 2.1 — Hook System Architecture (EXPAND)

Current plan defines hook types as `shell`, `http`, `internal`. Add:

- **`tool`** handler type — invoke a registered tool as a hook action
- **Data passing** — hooks receive an event payload and can return data
- **Hook chains** — a hook's output can feed into the next hook's input
- **Async hooks** — hooks that run in the background without blocking the turn
- **Priority** — hooks at the same lifecycle point run in priority order

This turns hooks from "event listeners" into a **composable pipeline** that can express all of Anthropic's workflow patterns.

#### 2.2 — Safety Hooks (KEEP as-is)
Already well-defined. Maps to PreToolUse.

#### 2.3 — Auto-Actions (KEEP as-is)
PostToolUse auto-formatting etc.

#### 2.4 — Session Hooks (KEEP as-is)
SessionStart/SessionEnd etc.

#### 2.5 — MCP Client Plugin (NEW)

- RivetOS runtime can connect to MCP servers (stdio or HTTP)
- MCP tools are registered as regular RivetOS tools
- Config-driven: list MCP servers in config, they're available to all agents
- This is a plugin, not core — `@rivetos/plugin-mcp`
- Opens the entire MCP tool ecosystem to RivetOS agents

#### 2.6 — Skill Enhancements (NEW)

- `skill_read` tool — LLM can read a skill's full SKILL.md on demand
- Skill resources — skills can bundle scripts, templates, reference docs
- `skill_run` tool — execute a skill's bundled script and return output
- This implements Claude's three-tier progressive disclosure model

---

## What This Means for M3 (Agent Capabilities)

### Current M3 Plan

Plan mode, git worktrees, batch mode, delegation improvements.

### Proposed M3 Adjustments

#### 3.1 — Plan Mode (KEEP — critical)
Read-only exploration → structured plan → user approval → execute. This is table stakes for trusted agent behavior.

#### 3.2 — Git Worktree Isolation (KEEP — important)
Enables safe parallel code changes. No changes needed.

#### 3.3 — Batch Mode (REFINE)

The current spec is fine, but it should be built on top of M2 hooks + M3.2 worktrees. The "coordinator" is just an orchestrator-worker pattern:
- Coordinator agent decomposes task (using `todo` tool for tracking)
- Each subtask spawns a subagent in its own worktree
- Results merge back
- Hooks handle pre/post merge

#### 3.4 — Delegation Improvements (EXPAND)

Current plan covers `fromAgent` context and delegation chains. Add:

- **Capability-based delegation** — delegate by capability tag, not just agent name
- **Result streaming** — stream delegation results back to caller (not just final response)
- **Delegation as tool composition** — AutoGen's `AgentTool` pattern. An agent can appear as a tool to another agent.

#### 3.5 — Dynamic Routing (NEW)

Move beyond static channel→agent bindings:
- Content-based routing (query classification → specialist agent)
- Load-based routing (if primary agent's provider is rate-limited, route to fallback)
- Cost-based routing (simple queries → cheap model, complex → expensive)
- This builds on the Router domain object — extend, don't replace

#### 3.6 — Evaluator-Optimizer Pattern (NEW)

Generic build → evaluate → refine loop:
- Takes a generator agent + evaluator agent (or evaluator function)
- Generator produces output, evaluator scores it
- Loop until evaluator approves or max iterations
- `coding_pipeline` becomes an instance of this pattern
- Useful for: code review, document generation, data extraction

---

## Architecture Implications

### What Must NOT Change

1. **Clean Architecture layers** — Plugins depend on types, domain on types, application composes. No plugin imports in domain.
2. **Provider interface** — `chatStream(messages, options)` handles everything. Models are interchangeable.
3. **Tool interface** — `execute(args, signal, context)` returning `string`. Universal.
4. **Message format** — Already supports multimodal content (`ContentPart[]`). Good.

### What Must Be Extensible

1. **Hook system** — Design it as a pipeline, not just event listeners. Data flows through.
2. **Routing** — Static bindings are the base case. Dynamic routing is an overlay, not a replacement.
3. **Delegation** — Today it's intra-process. Tomorrow it's cross-node (mesh). The interface should work for both.
4. **Skill discovery** — Today it's filesystem scanning. Tomorrow it could be a registry/marketplace.
5. **Tool registration** — Today it's `registerTool()`. MCP adds dynamic tool discovery at runtime.

### What We Should Defer

1. **Full A2A protocol** — Interesting but premature. Our mesh networking in M6 is the right time.
2. **MCP server mode** — Exposing RivetOS as an MCP server. Nice to have, not blocking.
3. **Workflow DSL** — CrewAI has Flows, LangGraph has graphs. We should NOT build a DSL. Hooks + tools + delegation compose into workflows without a custom language.
4. **Hot-reload** — Developer convenience, not architectural. M5 is the right home.

---

## Revised Milestone Summary

### Milestone 2: Hooks, Lifecycle & Extensibility (v0.2.0)

| # | Item | Status |
|---|---|---|
| 2.1 | Hook system architecture (with data passing, chains, priorities) | Expanded |
| 2.2 | Safety hooks (PreToolUse) | Unchanged |
| 2.3 | Auto-actions (PostToolUse) | Unchanged |
| 2.4 | Session hooks | Unchanged |
| 2.5 | MCP client plugin | **NEW** |
| 2.6 | Skill enhancements (skill_read, skill_run, resources) | **NEW** |

### Milestone 3: Agent Capabilities (v0.3.0)

| # | Item | Status |
|---|---|---|
| 3.1 | Plan mode | Unchanged |
| 3.2 | Git worktree isolation | Unchanged |
| 3.3 | Batch mode (built on hooks + worktrees) | Refined |
| 3.4 | Delegation improvements (+ capability routing, agent-as-tool) | Expanded |
| 3.5 | Dynamic routing (content/load/cost-based) | **NEW** |
| 3.6 | Evaluator-optimizer pattern | **NEW** |

---

## Key Design Decisions Needed from Phil

1. **MCP in M2 or later?** — It's the biggest new item. Do we want it now or defer to M4/M5?
2. **Hook data passing** — Should hooks be simple event listeners (current plan) or composable pipelines (proposed)? Pipelines are more powerful but more complex to implement.
3. **Dynamic routing priority** — Is this a real need for you right now, or is static routing fine for the foreseeable future?
4. **Workflow DSL — confirm we're NOT building one.** Composable primitives (hooks + tools + delegation) should be enough. Agree?
5. **Multimodal images PR** — I have a spec ready from before the rate limit. The types and runtime already support it (I was surprised to find `ContentPart`, `ImagePart`, `ResolvedAttachment`, and `channel.resolveAttachment()` already defined). The gap is in the actual channel plugins (Telegram/Discord) implementing `resolveAttachment()` and the providers serializing image content. Should this be a separate PR or fold into M2?

---

## Summary

The good news: **RivetOS's architecture is already well-positioned.** The clean architecture layers, multi-model provider interface, and plugin system mean we don't need to rearchitect anything. The main additions are:

1. **Richer hooks** — data passing turns event listeners into composable workflows
2. **MCP client** — opens the tool ecosystem without reinventing it
3. **Skill progressive loading** — we're 80% there, just need `skill_read`/`skill_run`
4. **Dynamic routing** — extends Router, doesn't replace it
5. **Evaluator-optimizer** — generalizes coding_pipeline into a reusable pattern

None of these require breaking changes to existing interfaces. They're all additive. That's the sign of good architecture.
