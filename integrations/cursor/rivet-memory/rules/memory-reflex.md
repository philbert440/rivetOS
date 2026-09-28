# Cursor memory reflex

When you lack context, **query RivetOS memory first** -- see MEMORY.md for which tool/shelf to use.

- Status / in-flight -> `memory_browse(window="last_24h")`
- Time-bounded -> `memory_browse` with `window=` first
- Topic lookup -> multi-angle `memory_search`, then `mode="trigram"` if thin
- Standing facts -> `wiki_search` / `wiki_read`

AGENT.md decision gate step 0 requires memory + `/rivet-shared` before re-deriving.
Do not invent history. Cross-agent hits (`rivet-claude`, `rivet-grok`, `rivet-grokbot`, ...) are equally valid.
Cursor turns are in the same store as agent `rivet-cursor`, channel `cursor`.
