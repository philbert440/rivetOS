/**
 * toAiSdkTools — translates RivetOS Tool definitions into an AI SDK ToolSet
 * that fires the tool:before / tool:after HookPipeline events the same way
 * the legacy `loop.ts` does.
 *
 * Lifecycle inside each tool's `execute`:
 *   1. Build ToolBeforeContext (with a shallow copy of `args` so hooks may
 *      reassign without touching the AI SDK input).
 *   2. Run `tool:before`. If a hook sets `ctx.blocked`, return the block
 *      reason as a plain text result — matches the legacy "Blocked: …"
 *      string the loop emits today, so the LLM sees the same shape.
 *   3. Hook reassignments to `ctx.args` are honored when calling the
 *      underlying `Tool.execute(args, signal, ToolContext)`.
 *   4. Catch any thrown error and turn it into "Error: <msg>" text. The
 *      legacy loop has the same try/catch around `tool.execute`, so behavior
 *      matches: errors surface to the LLM, not to the AI SDK loop.
 *   5. Build ToolAfterContext, run `tool:after`. Return value never affects
 *      the result — observation only.
 *   6. Return the raw `ToolResult` (string | ContentPart[]); the
 *      `toModelOutput` below converts it to AI SDK's `ToolResultOutput`.
 *
 * Multimodal results (ContentPart[] with image parts) are passed through
 * AI SDK 5's `content` ToolResultOutput so models that support image inputs
 * see them natively. Plain string results become `text` outputs.
 *
 * Hook contract reminder: `tool:before` may set `ctx.blocked` /
 * `ctx.blockReason` and reassign `ctx.args`. It must not mutate the args
 * object in place — that's the same "reassign, don't mutate" contract the
 * provider hooks were pinned to in step 3b.
 */

import type {
  HookPipeline,
  StreamHandler,
  Tool as RivetosTool,
  ToolAfterContext,
  ToolBeforeContext,
  ToolResult,
} from '@rivetos/types'
import {
  buildLocalSessionContext,
  getToolResultImages,
  getToolResultText,
  toolResultHasImages,
} from '@rivetos/types'
import { jsonSchema, type ToolSet } from 'ai'
import type { ToolResultOutput } from '@ai-sdk/provider-utils'

// ---------------------------------------------------------------------------
// Binding — the per-call context the loop passes when it builds the toolset
// ---------------------------------------------------------------------------

export interface ToolMiddlewareBinding {
  /** Agent invoking the tools — passed to hook ctx and to the tool itself. */
  agentId?: string
  /** Conversation/session id for hook ctx + SessionContext.conversationId. */
  sessionId?: string
  /** Working directory for filesystem-scoped tools. */
  workingDir?: string
  /** Node id for the SessionContext (defaults to RIVETOS_NODE_ID env or 'local'). */
  nodeId?: string
  /** User id for the SessionContext (defaults to RIVETOS_USER_ID env or 'phil'). */
  userId?: string
  /** Optional pipeline — if absent, hooks are skipped entirely. */
  hooks?: HookPipeline
  /** Optional stream-event emitter. When set, each tool's execute fires
   *  `tool_start` before invocation and `tool_result` after, mirroring the
   *  legacy loop's stream-event surface. */
  onStreamEvent?: StreamHandler
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export function toAiSdkTools(tools: RivetosTool[], binding: ToolMiddlewareBinding = {}): ToolSet {
  const set: ToolSet = {}
  for (const def of tools) {
    set[def.name] = buildAiSdkTool(def, binding)
  }
  return set
}

// ---------------------------------------------------------------------------
// Per-tool builder
// ---------------------------------------------------------------------------

function buildAiSdkTool(def: RivetosTool, binding: ToolMiddlewareBinding): ToolSet[string] {
  return {
    description: def.description,
    inputSchema: jsonSchema(def.parameters),
    async execute(input, options) {
      const args =
        input && typeof input === 'object' && !Array.isArray(input)
          ? { ...(input as Record<string, unknown>) }
          : ({ value: input } as Record<string, unknown>)

      // ---- tool:before -----------------------------------------------
      let effectiveArgs = args
      if (binding.hooks) {
        const before: ToolBeforeContext = {
          event: 'tool:before',
          toolName: def.name,
          args,
          agentId: binding.agentId,
          sessionId: binding.sessionId,
          timestamp: Date.now(),
          metadata: {},
        }
        await binding.hooks.run(before)

        if (before.blocked) {
          // Match legacy loop: return a plain text result; do not throw.
          // The LLM sees the block reason in the next turn.
          return `Blocked: ${before.blockReason ?? 'Blocked by safety hook'}`
        }
        effectiveArgs = before.args
      }

      // ---- tool:start stream event (matches legacy loop surface) -----
      if (binding.onStreamEvent) {
        binding.onStreamEvent({
          type: 'tool_start',
          content: `🔧 ${def.name}`,
          metadata: { tool: def.name, args: summarizeArgs(effectiveArgs) },
        })
      }

      // ---- tool execution --------------------------------------------
      const session = buildLocalSessionContext({
        agentId: binding.agentId ?? 'unknown',
        nodeId: binding.nodeId ?? process.env.RIVETOS_NODE_ID ?? 'local',
        conversationId: binding.sessionId ?? 'ad-hoc',
        userId: binding.userId ?? process.env.RIVETOS_USER_ID ?? 'phil',
        workingDir: binding.workingDir,
        traceId: binding.sessionId,
      })

      const startedAt = Date.now()
      let raw: ToolResult
      try {
        raw = await def.execute(effectiveArgs, options.abortSignal, {
          agentId: binding.agentId,
          workingDir: binding.workingDir,
          signal: options.abortSignal,
          session,
        })
      } catch (err) {
        raw = `Error: ${err instanceof Error ? err.message : String(err)}`
      }

      // ---- tool:result stream event (matches legacy loop surface) ----
      if (binding.onStreamEvent) {
        const text = getToolResultText(raw)
        const isError = text.startsWith('Error')
        binding.onStreamEvent({
          type: 'tool_result',
          content: `${isError ? '❌' : '✅'} ${def.name}: ${text.slice(0, 200)}`,
          metadata: { tool: def.name },
        })
      }

      // ---- tool:after ------------------------------------------------
      if (binding.hooks) {
        const after: ToolAfterContext = {
          event: 'tool:after',
          toolName: def.name,
          args: effectiveArgs,
          result: raw,
          durationMs: Date.now() - startedAt,
          isError: getToolResultText(raw).startsWith('Error'),
          agentId: binding.agentId,
          sessionId: binding.sessionId,
          timestamp: Date.now(),
          metadata: {},
        }
        await binding.hooks.run(after)
      }

      return raw
    },
    toModelOutput(args: { output: unknown }) {
      return toToolResultOutput(args.output as ToolResult)
    },
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function summarizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && value.length > 200) {
      summary[key] = value.slice(0, 200) + '…'
    } else {
      summary[key] = value
    }
  }
  return summary
}

// ---------------------------------------------------------------------------
// ToolResult → AI SDK ToolResultOutput
// ---------------------------------------------------------------------------

function toToolResultOutput(result: ToolResult): ToolResultOutput {
  if (typeof result === 'string') {
    return { type: 'text', value: result }
  }

  if (!toolResultHasImages(result)) {
    return { type: 'text', value: getToolResultText(result) }
  }

  const text = getToolResultText(result)
  const images = getToolResultImages(result)
  const value: Array<
    | { type: 'text'; text: string }
    | { type: 'image-data'; data: string; mediaType: string }
    | { type: 'image-url'; url: string }
  > = []
  if (text) value.push({ type: 'text', text })
  for (const img of images) {
    if (img.data) {
      value.push({
        type: 'image-data',
        data: img.data,
        mediaType: img.mimeType ?? 'image/jpeg',
      })
    } else if (img.url) {
      value.push({ type: 'image-url', url: img.url })
    }
  }
  return { type: 'content', value }
}
