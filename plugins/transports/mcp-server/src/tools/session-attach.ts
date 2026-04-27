/**
 * `rivetos.session.attach` — handshake tool every MCP client calls first.
 *
 * Phase 1.A.7' — claude-cli scope. The MCP server runs alongside (or
 * in-process with) the RivetOS runtime; clients are local processes
 * authenticated by bearer token (TCP) or filesystem permissions (unix socket).
 *
 * `session.attach` itself does NOT gate other tools — auth happens at the
 * transport layer. This tool exists so:
 *   - the server can record `{agent, runtimePid, clientName}` per session
 *     for observability and future rate-limiting / quotas
 *   - the client gets the canonical `{sessionId, serverVersion, capabilities}`
 *     payload it can log / use to pick which tools to call
 *
 * Tool registration is per-session — the closure binds the live session id
 * so the call site doesn't have to thread it through.
 */

import { z } from 'zod'

import type { ToolRegistration } from '../server.js'

export const sessionAttachInputSchema = {
  agent: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      'Logical agent identity dialing in (e.g. "opus", "grok", "claude-cli@laptop"). Recorded for observability.',
    ),
  runtimePid: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('OS pid of the calling process. Recorded for observability / debugging.'),
  clientName: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe('Free-form client identifier ("claude-cli/0.4.0", "mcp-inspector", etc.).'),
} satisfies z.ZodRawShape

export interface SessionState {
  sessionId: string
  attachedAt?: number
  agent?: string
  runtimePid?: number
  clientName?: string
}

export interface SessionAttachResult {
  sessionId: string
  serverName: string
  serverVersion: string
  capabilities: {
    tools: string[]
  }
  attachedAt: number
}

export interface CreateSessionAttachToolOptions {
  sessionId: string
  serverName: string
  serverVersion: string
  /** Snapshot of registered tool names — returned in `capabilities.tools`. */
  toolNames: () => string[]
  /** Called when the tool runs; lets the server record session state. */
  onAttach: (state: SessionState) => void
}

export function createSessionAttachTool(opts: CreateSessionAttachToolOptions): ToolRegistration {
  return {
    name: 'rivetos.session.attach',
    description:
      'Handshake tool every MCP client should call first. Records the calling agent / pid / client name for the lifetime of the session and returns the canonical session id, server version, and tool catalog. Optional but recommended.',
    inputSchema: sessionAttachInputSchema,
    execute(args) {
      const agent = typeof args.agent === 'string' ? args.agent : undefined
      const runtimePid = typeof args.runtimePid === 'number' ? args.runtimePid : undefined
      const clientName = typeof args.clientName === 'string' ? args.clientName : undefined
      const attachedAt = Date.now()

      opts.onAttach({
        sessionId: opts.sessionId,
        attachedAt,
        agent,
        runtimePid,
        clientName,
      })

      const result: SessionAttachResult = {
        sessionId: opts.sessionId,
        serverName: opts.serverName,
        serverVersion: opts.serverVersion,
        capabilities: { tools: opts.toolNames() },
        attachedAt,
      }
      return Promise.resolve(JSON.stringify(result))
    },
  }
}
