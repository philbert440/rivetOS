---
name: rivethub-mesh-delegate
description: >-
  Use when handing work to another Rivet mesh agent from Grok Bot. Discover
  peers with list_agents and hand off with delegate_task on the plugin MCP.
---
# RivetHub mesh delegation (Grok Bot)

The plugin MCP (`rivetos-memory`) already registers `list_agents` and
`delegate_task`. Those tools talk to the den task API. There is no other
handoff path in this kit.

## When

Hand off work that needs another mesh agent — another node, another harness,
or a specialist — instead of doing it here or asking the user to switch
contexts.

## Practice

1. Call `list_agents`. Pick one peer from that live roster. Do not hard-code
   names, ids, or hosts.
2. Ask before sending work to more than one peer.
3. Call `delegate_task` with:
   - `to_agent` — a name or id from `list_agents` (`agent@node` only when
     the roster shows the same id on more than one node)
   - `task` — the goal, plus acceptance criteria when they matter
   - `context` — optional extra lines (who asked, budget, constraints)
   - `timeout_ms` — optional wait (default 20 minutes, max 30)
4. Wait for the tool result. `delegate_task` waits until the task finishes
   or the timeout elapses. Do not poll HTTP, do not open a shell to the den,
   and do not restart RivetOS to delegate.

## What does not

- Injecting into or resuming a **Grok Bot chat thread** from mesh. No public
  app API for that yet.
- Treating Grok Bot sidebar bots as RivetOS harness executors.
