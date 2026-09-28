# Grok Bot memory reflex

Query with memory_browse or memory_search. Write with memory_append or memory_ingest_session. Always pass role (user|assistant|system|tool) on memory_append.

The grokbot node runs one agent tag per discovered profile (`<prefix>-<slug>`). Each bot's launcher should set its own `RIVETOS_MEMORY_AGENT`. Leave source unset so the launcher stamps grokbot.

Do not use the Grok Build launcher.
