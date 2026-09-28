# Grok Bot memory reflex

Query with memory_browse or memory_search. Write with memory_append or memory_ingest_session. Always pass role (user|assistant|system|tool) on memory_append. Pass persona on writes when relevant; agent comes from the launcher env (`RIVETOS_MEMORY_AGENT`, default `grokbot`) and should match the bot's discovered tag. Leave source unset so the launcher stamps grokbot. Do not use the Grok Build launcher.
