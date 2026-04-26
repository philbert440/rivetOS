/**
 * adaptRivetTool — wraps a RivetOS `Tool` (`@rivetos/types`) into the
 * `ToolRegistration` shape consumed by `createMcpServer`.
 *
 * RivetOS tools execute with `(args, signal?, context?)` and may return either
 * a plain `string` or a `ContentPart[]` (multimodal). MCP `ToolRegistration`
 * — at this slice — expects a `Promise<string>` from `execute`. We coerce
 * any `ContentPart[]` result to its concatenated text. Slice 3 (when real
 * multimodal tool surfaces land) will widen `ToolRegistration` to mirror the
 * MCP content-array shape directly; until then, the string fallback is fine.
 *
 * The input schema must be supplied separately as a zod raw shape. We
 * deliberately do NOT auto-translate the JSON schema embedded in
 * `Tool.parameters` — that field's loose `Record<string, unknown>` shape
 * makes a faithful, type-safe round-trip into zod impractical, and the
 * MCP SDK uses zod to validate inputs at the wire boundary. Each adapted
 * tool gets a hand-written zod schema that matches its JSON schema, which
 * also gives us a chance to tighten descriptions for the MCP audience.
 */

import type { Tool, ToolResult } from '@rivetos/types'
import { z } from 'zod'

import type { ToolRegistration } from '../server.js'

export interface AdaptRivetToolOptions {
  /**
   * Override the wire name. By default the RivetOS tool's `name` is used as-is.
   * MCP convention namespaces tools (e.g. `rivetos.memory_search`); when
   * adapting an existing in-process tool we typically prefix here.
   */
  name?: string
  /** Override the description shown to MCP clients. Defaults to the Rivet description. */
  description?: string
}

export function adaptRivetTool(
  tool: Tool,
  inputSchema: z.ZodRawShape,
  options: AdaptRivetToolOptions = {},
): ToolRegistration {
  return {
    name: options.name ?? tool.name,
    description: options.description ?? tool.description,
    inputSchema,
    async execute(args) {
      const result = await tool.execute(args)
      return toolResultToString(result)
    },
  }
}

/**
 * Coerce a `ToolResult` into a plain string for the slice-1 MCP wire.
 *
 * - `string` → returned verbatim
 * - `ContentPart[]` → text parts joined with newlines, non-text parts
 *   stripped (with a brief placeholder so the omission is visible).
 */
export function toolResultToString(result: ToolResult): string {
  if (typeof result === 'string') return result

  const chunks: string[] = []
  for (const part of result) {
    if (part.type === 'text') {
      chunks.push(part.text)
    } else {
      chunks.push(`[non-text part: ${part.type}]`)
    }
  }
  return chunks.join('\n')
}
