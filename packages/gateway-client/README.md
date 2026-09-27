# Gateway client

`RivetGateway` is an isomorphic, dependency-free client using native fetch.

## Memory tools

`memoryTool(name, args, signal?)` posts MCP arguments to
`/api/memory/tool/<name>` and returns the unwrapped `ToolResult` (a string or
content parts). Arguments are selected by the tool name. Typed convenience
methods are `memorySearchTool`, `memoryBrowseTool`, `memoryStatsTool`,
`memoryGetFull`, `memoryAppend`, and `memoryIngestSession`.

```ts
import { RivetGateway } from '@rivetos/gateway-client'

const gateway = new RivetGateway({ baseUrl: 'https://localhost:5174' })
const result = await gateway.memorySearchTool({ query: 'deployment', window: 'today' })
```

Errors remain `GatewayError`; `status === 404` can indicate that a write tool
is not mounted. The existing memory GET methods remain available.

## Wiki suggestions

`wikiRead(slug, signal?)` returns `{ kind: 'hit', markdown }` or
`{ kind: 'miss', suggestions: [{ slug, title }] }`. Suggestions may be empty.
Only a well-formed 404 wiki response becomes a miss; other failures throw.
`wikiRaw` and `wikiPage` keep their existing behavior.

## Custom fetch

Pass `fetch` in `GatewayClientConfig` to inject a transport for every HTTP
method, including uploads, downloads, voice, and health probes. It must have
`typeof globalThis.fetch`'s signature. Node callers needing a private CA or a
client certificate can pass a fetch bound to an undici Agent supplied by their
application. This package does not import undici or consume the `tls` PEM
configuration itself. Browsers leave `fetch` unset to use `globalThis.fetch`.
