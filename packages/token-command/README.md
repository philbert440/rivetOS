# @rivetos/token-command

Leaf helper for minting short-lived bearer tokens from an argv command (no shell),
with a TTL cache and invalidate-on-401. Also exports embeddings wire-shape and
model-catalog floor helpers used by OpenAI-compatible providers and the embed
worker.

Plugins may depend on this package; they must not depend on `@rivetos/core`.
