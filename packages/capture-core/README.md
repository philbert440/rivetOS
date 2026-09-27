# @rivetos/capture-core

Shared HTTP capture writer for short-lived harness hooks; the den owns database connections and transactional dedupe at `POST /api/capture`. `createCaptureWriter({ denUrl })` posts batches, drains up to 50 pending batches first, and spools network/5xx failures to private, atomically published JSON files in `~/.rivetos/capture-spool`; 4xx throws and replay moves rejected files to `dead/`. TLS trust is supplied by the launcher through `NODE_EXTRA_CA_CERTS`; `resolveDenUrl` returns the endpoint and CA path without changing TLS settings.

`write()` returns `CaptureResult` on success, `{ spooled: true, file: string }` after durable spooling, or `{ spooled: false, error: string }` if delivery and spooling both fail. Spool failures are logged and returned without throwing; only HTTP 4xx errors throw.

The helpers are not all drop-in copies of the Codex helpers: `capForStorage(text, { limit })` is the hard-cap API, returning `{ text, truncated, fullLength }` with no inline marker and no pointer argument. `loadEnvFile(path)` requires an explicit path and returns a record without touching `process.env`; callers must apply that record themselves. `isRecord`, `asString`, and `safeJson` are the Codex originals, including `safeJson`'s `String(v)` fallback.

`resolveDenUrl` returns `caPath` without checking whether the file exists; the launcher checks CA existence and disables den transport when it is missing.

`resolveCaptureTransport(env)` picks `den`, `pg`, or `none`. `RIVETOS_CAPTURE_TRANSPORT=den|pg` forces; the default is `den` when `resolveDenUrl` resolves and `RIVETOS_USER_ID` is empty, else `pg` when `RIVETOS_PG_URL` is set. A routed user id never selects `den`. A launcher that found no CA file unsets `RIVET_DEN_URL` and leaves `RIVET_DEN_CA`, which selects `pg` instead of the default URL. `withFileLock(dir, fn)` is the cross-process state lock (`mkdir`, stale takeover, `LockTimeout`). `eventIdFromContent` is the SHA-256 id for messages that have no native id.
