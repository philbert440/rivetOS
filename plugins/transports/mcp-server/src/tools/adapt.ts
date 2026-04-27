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
   * MCP convention namespaces tools (e.g. `memory_search`); when
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

// ---------------------------------------------------------------------------
// JSON Schema → Zod raw shape (for the embedded bridge use case)
// ---------------------------------------------------------------------------

/**
 * Translate a RivetOS `Tool.parameters` (JSON-Schema-ish `Record<string, unknown>`)
 * into a `z.ZodRawShape` that the MCP SDK can validate inputs against.
 *
 * Used by the embedded MCP server (claude-cli bridge) to dynamically wrap
 * the host runtime's live `Tool[]` without per-tool hand-written schemas.
 *
 * Coverage: top-level `{type: 'object', properties, required}`.
 * - string / number / boolean / null → matching zod primitives
 * - array → z.array(<itemType>) with recursive item handling
 * - object → z.object(...) with recursive property handling
 * - enum → z.enum() over the listed values
 * - anything unrecognized → z.unknown() (passthrough — the in-process
 *   tool's own runtime validation catches malformed inputs)
 *
 * Field descriptions are preserved via `.describe(...)` so MCP clients
 * see the same hints in-process tools see.
 */
export function jsonSchemaToZodShape(params: Record<string, unknown>): z.ZodRawShape {
  const properties = (params.properties as Record<string, unknown> | undefined) ?? {}
  const required = (params.required as string[] | undefined) ?? []
  const mutableShape: Record<string, z.ZodType> = {}
  for (const [key, prop] of Object.entries(properties)) {
    const isRequired = required.includes(key)
    let zodType = jsonSchemaToZod(prop)
    if (!isRequired) zodType = zodType.optional()
    mutableShape[key] = zodType
  }
  return mutableShape
}

function jsonSchemaToZod(node: unknown): z.ZodType {
  if (node === null || typeof node !== 'object') return z.unknown()
  const obj = node as Record<string, unknown>

  const description = typeof obj.description === 'string' ? obj.description : undefined

  // enum first — type may also be set but enum constrains the value space
  if (Array.isArray(obj.enum) && obj.enum.length > 0) {
    const values = obj.enum.filter((v): v is string => typeof v === 'string')
    if (values.length === obj.enum.length) {
      const literals = values.map((v) => z.literal(v))
      let zt: z.ZodType
      if (literals.length === 1) {
        zt = literals[0]
      } else {
        // z.union requires [a, b, ...rest]
        zt = z.union(literals as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]])
      }
      return description ? zt.describe(description) : zt
    }
  }

  let zt: z.ZodType
  switch (obj.type) {
    case 'string':
      zt = z.string()
      break
    case 'number':
    case 'integer':
      zt = z.number()
      break
    case 'boolean':
      zt = z.boolean()
      break
    case 'null':
      zt = z.null()
      break
    case 'array': {
      const items = jsonSchemaToZod(obj.items)
      zt = z.array(items)
      break
    }
    case 'object': {
      const inner = jsonSchemaToZodShape(obj)
      zt = z.object(inner)
      break
    }
    default:
      zt = z.unknown()
  }
  return description ? zt.describe(description) : zt
}

/**
 * Adapt an arbitrary RivetOS `Tool` for the MCP wire, deriving the input
 * schema from `tool.parameters` instead of requiring a hand-written zod
 * shape.
 *
 * This is the dynamic counterpart to `adaptRivetTool`. The static path
 * (hand-mapped zod) gives better wire descriptions and stays in the
 * standalone CLI; the dynamic path is used by the per-spawn embedded MCP
 * server in the claude-cli bridge, where we want every runtime tool
 * available without a hard-coded list.
 */
export function adaptRivetToolDynamic(
  tool: Tool,
  options: AdaptRivetToolOptions = {},
): ToolRegistration {
  const inputSchema = jsonSchemaToZodShape(tool.parameters)
  return adaptRivetTool(tool, inputSchema, options)
}
