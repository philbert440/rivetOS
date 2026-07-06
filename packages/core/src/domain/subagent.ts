/**
 * Sub-agent tools — the 5-tool surface (spawn/status/send/list/kill) over a
 * SubagentManager. Since cutover g2a the only manager is the task-backed one
 * (task/subagent-task-manager.ts) — the legacy store/worker engine is gone;
 * sessions are ros_tasks rows.
 */

import type { SubagentManager, Tool } from '@rivetos/types'

// ---------------------------------------------------------------------------
// Sub-agent Tools — surface unchanged (still 5 tools) but execute() awaits.
// ---------------------------------------------------------------------------

export function createSubagentTools(manager: SubagentManager): Tool[] {
  const spawnTool: Tool = {
    name: 'subagent_spawn',
    description:
      'Spawn a sub-agent to handle a task. Returns immediately with a session ID — ' +
      'the agent runs in the background. Use subagent_status to check progress ' +
      'and collect results.',
    parameters: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          description: 'Agent ID to spawn (e.g., "grok", "opus", "local")',
        },
        task: {
          type: 'string',
          description: 'Task description for the sub-agent',
        },
        timeout_ms: {
          type: 'number',
          description: 'Optional timeout in milliseconds (default: no timeout — runs until done)',
        },
      },
      required: ['agent', 'task'],
    },
    execute: async (args) => {
      try {
        const session = await manager.spawn({
          agent: args.agent as string,
          task: args.task as string,
          timeoutMs: args.timeout_ms as number | undefined,
        })

        return JSON.stringify({
          sessionId: session.id,
          agent: session.childAgent,
          status: session.status,
          message: `Sub-agent ${session.childAgent} spawned. Use subagent_status("${session.id}") to check progress.`,
        })
      } catch (err: unknown) {
        return `Error spawning sub-agent: ${(err as Error).message}`
      }
    },
  }

  const statusTool: Tool = {
    name: 'subagent_status',
    description:
      'Check the status and progress of a sub-agent session. ' +
      'Returns elapsed time, iterations, tools used, and the response ' +
      '(partial if still running, final if completed).',
    parameters: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Sub-agent session ID (returned by subagent_spawn)',
        },
      },
      required: ['session_id'],
    },
    execute: async (args) => {
      try {
        const status = await manager.status(args.session_id as string)

        const lines: string[] = []
        lines.push(`**Status:** ${status.status}`)
        lines.push(`**Agent:** ${status.agent}`)
        lines.push(`**Elapsed:** ${formatDuration(status.elapsedMs)}`)
        lines.push(`**Iterations:** ${String(status.iterations)}`)
        if (status.toolsUsed.length > 0) {
          lines.push(`**Tools used:** ${status.toolsUsed.join(', ')}`)
        }
        if (status.usage) {
          lines.push(
            `**Tokens:** ${String(status.usage.promptTokens + status.usage.completionTokens)} (${String(status.usage.promptTokens)} prompt + ${String(status.usage.completionTokens)} completion)`,
          )
        }
        if (status.error) {
          lines.push(`**Error:** ${status.error}`)
        }
        if (status.lastResponse) {
          lines.push('')
          lines.push('**Response:**')
          lines.push(status.lastResponse)
        }

        return lines.join('\n')
      } catch (err: unknown) {
        return `Error: ${(err as Error).message}`
      }
    },
  }

  const sendTool: Tool = {
    name: 'subagent_send',
    description:
      'Send a follow-up message to a completed sub-agent session. ' +
      'Starts a new turn in the background — use subagent_status to check results.',
    parameters: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Sub-agent session ID (returned by subagent_spawn)',
        },
        message: {
          type: 'string',
          description: 'Message to send to the sub-agent',
        },
      },
      required: ['session_id', 'message'],
    },
    execute: async (args) => {
      try {
        await manager.send(args.session_id as string, args.message as string)
        return `Follow-up sent. Use subagent_status("${args.session_id as string}") to check progress.`
      } catch (err: unknown) {
        return `Error: ${(err as Error).message}`
      }
    },
  }

  const listTool: Tool = {
    name: 'subagent_list',
    description: 'List all sub-agent sessions (running, completed, and failed).',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async () => {
      const sessions = await manager.list()
      if (sessions.length === 0) {
        return 'No sub-agent sessions.'
      }
      return JSON.stringify(
        sessions.map((s) => ({
          id: s.id,
          agent: s.childAgent,
          status: s.status,
          elapsed: formatDuration(
            s.status === 'running' ? Date.now() - s.createdAt : (s.durationMs ?? 0),
          ),
          iterations: s.iterations ?? 0,
          messages: s.history.length,
        })),
        null,
        2,
      )
    },
  }

  const killTool: Tool = {
    name: 'subagent_kill',
    description: 'Kill (abort) a running sub-agent session.',
    parameters: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Sub-agent session ID to kill',
        },
      },
      required: ['session_id'],
    },
    execute: async (args) => {
      try {
        const sessionId = args.session_id as string
        await manager.kill(sessionId)
        return `Sub-agent session ${sessionId} killed.`
      } catch (err: unknown) {
        return `Error: ${(err as Error).message}`
      }
    },
  }

  return [spawnTool, statusTool, sendTool, listTool, killTool]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(ms)}ms`
  const secs = Math.floor(ms / 1000)
  if (secs < 60) return `${String(secs)}s`
  const mins = Math.floor(secs / 60)
  const remainingSecs = secs % 60
  return `${String(mins)}m ${String(remainingSecs)}s`
}
