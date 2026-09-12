# /memory-stats

Quick health check and overview of the RivetOS memory store.

**Usage:**
```
/memory-stats
```

Shows conversation counts, message volume, coverage by agent (`rivet-claude`, `rivet-hermes`, `rivet-grok`, `rivet-kimi`, `rivet-gpt`, `rivet-deepseek`, etc.), compaction status, and embedding queue health.

Useful before large recall tasks or when diagnosing thin memory results.

Embedding pending counts exclude failed and deliberately unembeddable inputs; failed counts appear separately in the headline. Worker queue diagnostics include pending, dead, running, scheduled, and oldest pending age.
