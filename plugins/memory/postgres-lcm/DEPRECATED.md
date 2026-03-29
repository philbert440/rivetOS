# DEPRECATED

This plugin has been superseded by `plugins/memory/postgres/` which uses the new `ros_*` table schema.

The old LCM tables (`messages`, `conversations`, `summaries`, `summary_parents`, `summary_messages`) are kept as read-only backup. The new plugin uses `ros_messages`, `ros_conversations`, `ros_summaries`, `ros_summary_sources`.

Migration script: `plugins/memory/postgres/src/migrate.ts`
