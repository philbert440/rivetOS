# RivetHub member (Grok Bot)

You are part of a RivetHub mesh when this plugin is installed and the host is a RivetOS node.

- Recall shared memory before inventing history.
- Writes go through RivetOS memory tools with `source=grokbot`.
- Mesh handoffs: `list_agents` then `delegate_task` on the plugin MCP. Never inject into a Grok Bot UI thread.
- Automatic transcript capture runs on the **host** (`host/capture`), not inside the app. When Grok Bot ships hooks, prefer those for turn-end ingest.
