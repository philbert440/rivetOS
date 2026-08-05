/**
 * adaptRivetTool — wraps a RivetOS `Tool` (`@rivetos/types`) into the
 * `ToolRegistration` shape consumed by the v1/v2 MCP mounts.
 *
 * RivetOS tools execute with `(args, signal?, context?)` and may return either
 * a plain `string` or a `ContentPart[]` (multimodal). By default we preserve
 * multimodal results as StructuredToolResult content blocks; set
 * `flattenToString: true` for the legacy string-only path.
 *
 * The input schema must be supplied separately as a zod raw shape. We
 * deliberately do NOT auto-translate the JSON schema embedded in
 * `Tool.parameters` for the static path — that field's loose
 * `Record<string, unknown>` shape makes a faithful, type-safe round-trip
 * into zod impractical, and the MCP SDK uses zod to validate inputs at the
 * wire boundary. `adaptRivetToolDynamic` does the JSON-Schema → zod
 * conversion for the bridge / transport dynamic path.
 */

import type { Tool, ToolResult, ContentPart } from '@rivetos/types'
import { z } from 'zod'

import type {
  ToolAnnotations,
  ToolContentBlock,
  ToolRegistration,
  StructuredToolResult,
} from './registration.js'

export interface AdaptRivetToolOptions {
  /**
   * Override the wire name. By default the RivetOS tool's `name` is used as-is.
   * MCP convention namespaces tools (e.g. `memory_search`); when
   * adapting an existing in-process tool we typically prefix here.
   */
  name?: string
  /** Override the description shown to MCP clients. Defaults to the Rivet description. */
  description?: string
  /** Optional display title. */
  title?: string
  /** Optional MCP tool annotations (readOnlyHint, destructiveHint, …). */
  annotations?: ToolAnnotations
  /**
   * When true, coerce ContentPart[] results to a single text string
   * (legacy slice-1 behaviour). Default false — structured content is
   * preserved for multimodal clients.
   */
  flattenToString?: boolean
}

export function adaptRivetTool(
  tool: Tool,
  inputSchema: z.ZodRawShape,
  options: AdaptRivetToolOptions = {},
): ToolRegistration {
  const flatten = options.flattenToString === true
  return {
    name: options.name ?? tool.name,
    description: options.description ?? tool.description,
    title: options.title,
    annotations: options.annotations,
    inputSchema,
    async execute(args, ctx) {
      const result = await tool.execute(args, ctx?.signal)
      if (flatten) return toolResultToString(result)
      return toolResultToStructured(result)
    },
  }
}

/**
 * Coerce a `ToolResult` into a plain string for string-only consumers.
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

/** Coerce a RivetOS ToolResult into a StructuredToolResult for MCP wire. */
export function toolResultToStructured(result: ToolResult): StructuredToolResult {
  if (typeof result === 'string') {
    return { content: [{ type: 'text', text: result }] }
  }
  const content: ToolContentBlock[] = result.map((part: ContentPart) => {
    if (part.type === 'text') {
      return { type: 'text' as const, text: part.text }
    }
    if (part.type === 'image' && typeof part.data === 'string') {
      return {
        type: 'image' as const,
        data: part.data,
        mimeType: part.mimeType ?? 'image/png',
      }
    }
    if (part.type === 'image' && typeof part.url === 'string') {
      return { type: 'text' as const, text: `[image url: ${part.url}]` }
    }
    return { type: 'text' as const, text: `[non-text part: ${part.type}]` }
  })
  return { content }
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
