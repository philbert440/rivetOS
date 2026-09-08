# Memory health visibility

The existing Memory page shows measured embedding availability, pipeline counts,
worker queues, and the observation time. Its summary distinguishes degraded checks,
stale observations, and partial coverage. A configured embedding URL alone does not
establish availability.

The authenticated health endpoint probes the configured embedding service with a
fixed synthetic input. It sends no conversation content. Each search engine
coalesces and caches probes for 60 seconds, bypassing the search vector cache;
the request timeout is capped at five seconds. `embeddings.checkedAt` identifies
the probe observation separately from the response's `observedAt` time.

The Memory page refreshes health and statistics every 120 seconds while active.
Observations older than 180 seconds, missing timestamps, and failed refreshes cannot
establish current health. Older servers remain compatible, with unmeasured fields
shown as unknown.

## Pipeline interpretation

- Pending embeddings include eligible message text, tool results, and summaries.
  Permanently failed and deliberately unembeddable rows are counted separately.
- Compaction counts use the same eligibility buckets as `memory_stats`: eligible
  work, active conversation tails, and inputs below the current compaction floor.
- Worker diagnostics distinguish due pending, running, scheduled, and exhausted
  jobs. Oldest pending age measures waiting time; it does not prove a worker stalled.
- Pending work alone does not make health degraded. An unavailable embedding
  service, failed embedding rows created within the last 7 days, or exhausted worker
  jobs created within the last 24 hours does (strict `created_at > now() - interval`).
  Older failures remain in the displayed historical totals without degrading health.
- Capture progress is explicitly unknown until durable capture observations exist.
  Capture is shown as grey “not measured”; unknown or restricted coverage does not
  downgrade successful observed checks.

The MCP statistics tool and HTTP endpoints share diagnostic queries. HTTP counts
use the authenticated user's routed memory pool. Graphile worker diagnostics are
queried only for the node owner; other users see restricted coverage. The HTTP
response omits raw worker errors.

## Recovery and follow-up

This change adds no mutation endpoint or automatic retry behavior. Use the existing
`rivetos doctor` and memory CLI diagnostics and recovery commands to investigate
failed work. Durable capture observations and any UI recovery actions are separate
follow-up work; the page does not imply that capture is currently verified.

HTTP embedding, compaction, and worker counts are cached separately per pool for
60 seconds after completion, with single-flight coalescing even across concurrent
health/stats requests. Failed queries are evicted immediately. Worker queries remain
owner-only, including when a routed pool aliases the owner pool. Statistics only
request embedding counts; they do not initiate compaction or worker queries.
