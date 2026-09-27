# @rivetos/capture-core

Shared HTTP capture writer for short-lived harness hooks; the den owns database connections and transactional dedupe at `POST /api/capture`. `createCaptureWriter({ denUrl })` posts batches, drains up to 50 pending batches first, and spools network/5xx failures to private, atomically published JSON files in `~/.rivetos/capture-spool`; 4xx throws and replay moves rejected files to `dead/`. TLS trust is supplied by the launcher through `NODE_EXTRA_CA_CERTS`; `resolveDenUrl` returns the endpoint and CA path without changing TLS settings.

`write()` returns `CaptureResult` on success, `{ spooled: true, file: string }` after durable spooling, or `{ spooled: false, error: string }` if delivery and spooling both fail. Spool failures are logged and returned without throwing; only HTTP 4xx errors throw.

The helpers are not all drop-in copies of the Codex helpers: `capForStorage(text, { limit })` is the hard-cap API, returning `{ text, truncated, fullLength }` with no inline marker and no pointer argument. `loadEnvFile(path)` requires an explicit path and returns a record without touching `process.env`; callers must apply that record themselves. `isRecord`, `asString`, and `safeJson` are the Codex originals, including `safeJson`'s `String(v)` fallback.

`resolveDenUrl` returns `caPath` without checking whether the file exists; the launcher checks CA existence and disables den transport when it is missing.
