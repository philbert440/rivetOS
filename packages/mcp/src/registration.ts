/**
 * ToolRegistration — the SDK-agnostic tool shape the RivetOS MCP mounts
 * consume. The v1 mount (packages/mcp-v1, SDK 1.29 — the bridge/Claude Code
 * world) and the v2 mount (2026-07-28 RC betas, PR 2) both register these;
 * the adapt layer produces them from RivetOS Tools. Keeping the shape here
 * keeps the core free of any @modelcontextprotocol dependency.
 */

import type { z } from 'zod'

export interface ToolRegistration {
  name: string
  description: string
  inputSchema: z.ZodRawShape
  execute: (args: Record<string, unknown>) => Promise<string>
}
