# @rivetos/token-command

Leaf helper for minting short-lived bearer tokens from an argv command (no shell),
with a TTL cache and invalidate-on-401. Also exports embeddings wire-shape and
model-catalog floor helpers used by OpenAI-compatible providers and the embed
worker.

Plugins may depend on this package; they must not depend on `@rivetos/core`.

Package shape matches other dual-consume leaves (`@rivetos/types`, `@rivetos/aisdk`):
no `"type": "module"`, so both ESM and CommonJS-compiled workspaces can import it
under `module: Node16`.

`createModelCatalog` / provider `listModels()` are a building block — the merged
endpoint listing is not yet read by den-server harness model-sheets or the web
roster. `EMBEDDING_COLUMN_DIMS` (1024) is the memory `halfvec` width;
`embed_expected_dims` must equal it when set.
