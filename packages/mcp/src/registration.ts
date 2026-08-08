/**
 * ToolRegistration — the SDK-agnostic tool shape the RivetOS MCP mounts
 * consume. The v2 mount (2026-07-28 final, @modelcontextprotocol/* 2.0)
 * registers these; the adapt layer produces them from RivetOS Tools.
 * Keeping the shape here keeps the core free of any @modelcontextprotocol
 * dependency.
 */

import type { z } from 'zod'

/**
 * MCP tool annotations (SEP / protocol ToolAnnotations). Hints only —
 * hosts treat them as untrusted unless the server is trusted.
 */
export interface ToolAnnotations {
  /** Human-readable title distinct from the wire name. */
  title?: string
  /** Tool does not modify its environment. */
  readOnlyHint?: boolean
  /** Tool may perform destructive updates (ignored if readOnlyHint). */
  destructiveHint?: boolean
  /** Repeated calls with the same args have no additional effect. */
  idempotentHint?: boolean
  /** Tool may interact with an open world (external systems, web, …). */
  openWorldHint?: boolean
}

/** Text content block for structured MCP tool results. */
export interface TextContentBlock {
  type: 'text'
  text: string
}

/** Image content block (base64 payload). */
export interface ImageContentBlock {
  type: 'image'
  data: string
  mimeType: string
}

export type ToolContentBlock =
  TextContentBlock | ImageContentBlock | { type: string; [k: string]: unknown }

/**
 * Structured tool result — mirrors the MCP CallToolResult shape closely
 * enough that mounts can pass it through without re-stringifying.
 */
export interface StructuredToolResult {
  content: ToolContentBlock[]
  isError?: boolean
  /** Optional machine-readable payload (MCP structuredContent). */
  structuredContent?: Record<string, unknown>
}

/**
 * MRTR (Multi Round-Trip Request) signal. When a tool needs mid-call
 * input (confirmation, missing param), it returns this and the v2 mount
 * maps it onto the SDK's `inputRequired` result. Clients retry with
 * `inputResponses` attached.
 *
 * Opaque to the core: the mount packages interpret `kind === 'input_required'`.
 */
export interface InputRequiredToolResult {
  kind: 'input_required'
  /**
   * Map of request-id → elicit/sample request descriptors. Mounts convert
   * these into the SDK's inputRequired builder form.
   */
  inputRequests: Record<
    string,
    {
      mode?: 'form' | 'url'
      message: string
      /** JSON-schema-ish form schema when mode is form. */
      requestedSchema?: Record<string, unknown>
      /** URL for URL-mode elicitation. */
      url?: string
    }
  >
}

export type ToolExecuteResult = string | StructuredToolResult | InputRequiredToolResult

/**
 * Per-call context the mount may supply. On v2 this carries MRTR
 * `inputResponses` from a retried tools/call; on v1 it is usually empty.
 */
export interface ToolExecuteContext {
  /** Responses to prior input_required requests (MRTR retry). */
  inputResponses?: Record<string, unknown>
  /** Optional abort signal from the transport. */
  signal?: AbortSignal
}

export interface ToolRegistration {
  name: string
  description: string
  inputSchema: z.ZodRawShape
  /** Optional display title (also storable under annotations.title). */
  title?: string
  /** Optional MCP tool annotations. */
  annotations?: ToolAnnotations
  /**
   * Execute the tool. Prefer returning StructuredToolResult for multimodal
   * / structured payloads; string is still accepted and coerced to a text
   * content block by the mounts.
   */
  execute: (args: Record<string, unknown>, ctx?: ToolExecuteContext) => Promise<ToolExecuteResult>
}

/** Type guard for MRTR input-required results. */
export function isInputRequiredResult(value: unknown): value is InputRequiredToolResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as InputRequiredToolResult).kind === 'input_required' &&
    typeof (value as InputRequiredToolResult).inputRequests === 'object'
  )
}

/** Type guard for structured (non-string) tool results. */
export function isStructuredToolResult(value: unknown): value is StructuredToolResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as StructuredToolResult).content) &&
    (value as InputRequiredToolResult).kind !== 'input_required'
  )
}

/**
 * Normalize any ToolExecuteResult into a StructuredToolResult.
 * Throws if the value is an InputRequiredToolResult (caller must handle MRTR).
 */
export function normalizeToolResult(result: ToolExecuteResult): StructuredToolResult {
  if (typeof result === 'string') {
    return { content: [{ type: 'text', text: result }] }
  }
  if (isInputRequiredResult(result)) {
    throw new Error('normalizeToolResult: input_required must be handled by the v2 mount')
  }
  return result
}
