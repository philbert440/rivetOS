/**
 * Sidecar shim. The write implementation lives in `@rivetos/memory-postgres`;
 * this module keeps the existing MCP registrations compiling. `adaptRivetTool`
 * stays here because the adapter must not import `@rivetos/mcp` (scope:transport).
 * The next slice deletes this file and switches the sidecar to HTTP.
 */

import type { ToolRegistration } from '@rivetos/mcp'
import { adaptRivetTool } from '@rivetos/mcp'
import type { PostgresMemory } from '@rivetos/memory-postgres'
import {
  appendEventId,
  createMemoryWriteTools as createWriteTools,
  ingestEventId,
  ingestSession,
  memoryAppendInputSchema,
  memoryIngestSessionInputSchema,
  resolveMemoryWriteTags,
  truncateContent,
} from '@rivetos/memory-postgres'

export {
  appendEventId,
  ingestEventId,
  ingestSession,
  memoryAppendInputSchema,
  memoryIngestSessionInputSchema,
  resolveMemoryWriteTags,
  truncateContent,
}
export type { IngestMessage, IngestSessionInput, MemoryWriteTags } from '@rivetos/memory-postgres'

export function createMemoryWriteTools(memory: PostgresMemory, prefix = ''): ToolRegistration[] {
  const tools = createWriteTools(memory)
  const append = tools.find((tool) => tool.name === 'memory_append')
  const ingest = tools.find((tool) => tool.name === 'memory_ingest_session')
  if (!append || !ingest) {
    throw new Error('createMemoryWriteTools: write tools missing from @rivetos/memory-postgres')
  }
  return [
    adaptRivetTool(append, memoryAppendInputSchema, {
      name: `${prefix}memory_append`,
      annotations: { readOnlyHint: false, idempotentHint: true },
    }),
    adaptRivetTool(ingest, memoryIngestSessionInputSchema, {
      name: `${prefix}memory_ingest_session`,
      annotations: { readOnlyHint: false, idempotentHint: true },
    }),
  ]
}
