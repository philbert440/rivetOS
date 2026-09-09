# Hooks (Reserved)

This directory is reserved for future Grok Bot lifecycle hooks.

Grok Bot (the desktop app) does not currently expose a hook surface. When hooks 
become available, they will call the same ingest path as the transcript watcher 
(door 1) — not a third capture path.

Until then, the transcript watcher remains the only door for Grok Bot agent 
capture. Grok Build hooks (door 2) use the separate grok-memory-hook.sh in 
the sibling `integrations/grok/` package.
