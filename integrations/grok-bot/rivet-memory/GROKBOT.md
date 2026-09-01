# Grok Bot memory reflex

Query with memory_browse or memory_search. Write with memory_append or memory_ingest_session. Always pass role (user|assistant|system|tool) on memory_append.

The grokbot node runs multiple agents with distinct agent keys (rivet-grokbot, rivet-bob, rivet-gary, rivet-maggie, rivet-frank, rivet-eggbot). Each bot's launcher sets its own agent key via env. Leave source unset so the launcher stamps grokbot.

Do not use the Grok Build launcher.
