# MEMORY.md — where answers live

One spine per shelf. Pick the one that matches the question, query it, then act.

- **`memory_search`** — semantic + lexical search over every past conversation; the default first move for "what did we decide / have we done X / why is Y like this".
- **`memory_browse`** — chronological browse; for when you know roughly *when* something happened ("what did we do Tuesday").
- **`memory_stats`** — health of the memory system itself; for "is capture/embedding working".
- **`/rivet-shared/wiki/topics/`** — durable per-subject articles distilled from memory; for "give me the current state of <service/host/project>".
- **`/rivet-shared/*.md` and project kits** — proven runbooks, recipes, and build logs (quant kits, deploy runbooks); for "how do we do <infra/model task>" — the working script is usually already on disk.
- **`/rivet-shared/plans/`** — approved plans and session-state handoffs; for "what's the plan / where did the last session leave off".
- **`users/profiles.json` and `users/<id>.md`** — who a routed user is; for resolving display names and per-user context.
- **`config.yaml`** — this node's own wiring (provider, mesh, den); for "what am I running on".

If two shelves disagree, memory wins over workspace files — update the file.

## ⚠️ Critical context

_(per-node gotchas that must stay top of mind — keep this list short)_
