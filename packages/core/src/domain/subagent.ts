/**
 * Sub-agent Manager — orchestrates child agent sessions.
 *
 * Supports two modes:
 * - 'run': one-shot delegation. Spawns a child AgentLoop, waits for
 *   completion, returns the result. Session is cleaned up automatically.
 * - 'session': persistent interactive session. Spawns a child AgentLoop
 *   for the initial task, keeps the session alive for follow-up messages
 *   via send().
 *
 * Pure domain logic. Depends only on interfaces from @rivetos/types
 * plus the internal Router and WorkspaceLoader.
 */

import { randomUUID } from 'node:crypto';
import type {
  SubagentSession,
  SubagentSpawnRequest,
  SubagentManager,
  Tool,
  Message,
} from '@rivetos/types';
import { getTextContent } from '@rivetos/types';
import { AgentLoop } from './loop.js';
import type { Router } from './router.js';
import type { WorkspaceLoader } from './workspace.js';
import { logger } from '../logger.js';

const log = logger('SubagentManager');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SubagentManagerConfig {
  router: Router;
  workspace: WorkspaceLoader;
  tools: Tool[];
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** Internal session state — extends the public SubagentSession with private fields */
interface InternalSession extends SubagentSession {
  abort: AbortController;
  /** Promise that resolves when a 'run' mode session completes */
  completion?: Promise<string>;
}

export class SubagentManagerImpl implements SubagentManager {
  private config: SubagentManagerConfig;
  private sessions: Map<string, InternalSession> = new Map();

  constructor(config: SubagentManagerConfig) {
    this.config = config;
  }

  async spawn(request: SubagentSpawnRequest): Promise<SubagentSession> {
    const { router, workspace, tools } = this.config;

    // Resolve the child agent and its provider
    const agents = router.getAgents();
    const agent = agents.find((a) => a.id === request.agent);
    if (!agent) {
      throw new Error(
        `Unknown agent: "${request.agent}". Available: ${agents.map((a) => a.id).join(', ')}`,
      );
    }

    const providers = router.getProviders();
    const provider = providers.find((p) => p.id === agent.provider);
    if (!provider) {
      throw new Error(
        `Provider "${agent.provider}" not available for agent "${request.agent}"`,
      );
    }

    // Build system prompt for the child
    const systemPrompt = await workspace.buildSystemPrompt(agent.id);
    const enrichedPrompt =
      systemPrompt +
      '\n\n## Sub-agent Context\n' +
      `You are running as a sub-agent. Mode: ${request.mode}.\n` +
      `Complete your assigned task thoroughly.`;

    const sessionId = randomUUID();
    const abort = new AbortController();

    // Apply timeout if specified
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (request.timeoutMs) {
      timeoutHandle = setTimeout(() => {
        abort.abort(`Sub-agent timeout after ${request.timeoutMs}ms`);
      }, request.timeoutMs);
    }

    const session: InternalSession = {
      id: sessionId,
      parentAgent: 'parent', // Will be set by the tool's context
      childAgent: request.agent,
      provider: agent.provider,
      status: 'running',
      history: [],
      createdAt: Date.now(),
      abort,
    };

    this.sessions.set(sessionId, session);

    if (request.mode === 'run') {
      // One-shot: run the task, wait for completion, return result
      const completion = this.runOneShot(session, enrichedPrompt, provider, tools, request.task, abort, timeoutHandle);
      session.completion = completion;

      try {
        const response = await completion;
        session.status = 'completed';
        session.history.push(
          { role: 'user', content: request.task },
          { role: 'assistant', content: response },
        );
        return this.toPublicSession(session);
      } catch (err: any) {
        session.status = 'failed';
        log.error(`Sub-agent ${sessionId} failed: ${err.message}`);
        throw err;
      }
    } else {
      // Session mode: run initial task, keep session alive for follow-ups
      try {
        const response = await this.runTurn(session, enrichedPrompt, provider, tools, request.task, abort.signal);
        session.history.push(
          { role: 'user', content: request.task },
          { role: 'assistant', content: response },
        );
        // Keep session alive — don't mark completed
        if (timeoutHandle) clearTimeout(timeoutHandle);
        return this.toPublicSession(session);
      } catch (err: any) {
        session.status = 'failed';
        if (timeoutHandle) clearTimeout(timeoutHandle);
        log.error(`Sub-agent ${sessionId} failed on initial turn: ${err.message}`);
        throw err;
      }
    }
  }

  async send(sessionId: string, message: string): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Sub-agent session not found: ${sessionId}`);
    }
    if (session.status !== 'running' && session.status !== 'yielded') {
      throw new Error(
        `Sub-agent session ${sessionId} is ${session.status} — cannot send messages`,
      );
    }

    const { router, workspace, tools } = this.config;

    const agent = router.getAgents().find((a) => a.id === session.childAgent);
    if (!agent) {
      throw new Error(`Agent "${session.childAgent}" no longer registered`);
    }

    const provider = router.getProviders().find((p) => p.id === agent.provider);
    if (!provider) {
      throw new Error(`Provider "${agent.provider}" not available`);
    }

    const systemPrompt = await workspace.buildSystemPrompt(agent.id);
    const enrichedPrompt =
      systemPrompt +
      '\n\n## Sub-agent Context\n' +
      'You are running as a persistent sub-agent session. Continue the conversation.';

    session.status = 'running';

    try {
      const response = await this.runTurn(session, enrichedPrompt, provider, tools, message, session.abort.signal);
      session.history.push(
        { role: 'user', content: message },
        { role: 'assistant', content: response },
      );
      return response;
    } catch (err: any) {
      session.status = 'failed';
      throw err;
    }
  }

  yield(sessionId: string, message?: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Sub-agent session not found: ${sessionId}`);
    }
    session.status = 'yielded';
    if (message) {
      log.info(`Sub-agent ${sessionId} yielded with message: ${message.slice(0, 100)}`);
    }
  }

  list(): SubagentSession[] {
    return [...this.sessions.values()]
      .filter((s) => s.status === 'running' || s.status === 'yielded')
      .map((s) => this.toPublicSession(s));
  }

  kill(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Sub-agent session not found: ${sessionId}`);
    }
    session.abort.abort('Killed by parent');
    session.status = 'failed';
    this.sessions.delete(sessionId);
    log.info(`Sub-agent ${sessionId} killed`);
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private async runOneShot(
    session: InternalSession,
    systemPrompt: string,
    provider: any,
    tools: Tool[],
    task: string,
    abort: AbortController,
    timeoutHandle?: ReturnType<typeof setTimeout>,
  ): Promise<string> {
    try {
      const response = await this.runTurn(session, systemPrompt, provider, tools, task, abort.signal);
      return response;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      this.sessions.delete(session.id);
    }
  }

  private async runTurn(
    session: InternalSession,
    systemPrompt: string,
    provider: any,
    tools: Tool[],
    userMessage: string,
    signal: AbortSignal,
  ): Promise<string> {
    const loop = new AgentLoop({
      systemPrompt,
      provider,
      tools,
      agentId: session.childAgent,
    });

    const result = await loop.run(userMessage, session.history, signal);

    if (result.aborted) {
      throw new Error('Sub-agent was aborted');
    }

    return result.response;
  }

  private toPublicSession(session: InternalSession): SubagentSession {
    return {
      id: session.id,
      parentAgent: session.parentAgent,
      childAgent: session.childAgent,
      provider: session.provider,
      status: session.status,
      history: [...session.history],
      createdAt: session.createdAt,
    };
  }
}

// ---------------------------------------------------------------------------
// Sub-agent Tools — tools that agents can invoke
// ---------------------------------------------------------------------------

export function createSubagentTools(manager: SubagentManager): Tool[] {
  const spawnTool: Tool = {
    name: 'subagent_spawn',
    description:
      'Spawn a sub-agent to handle a task. Use mode "run" for one-shot tasks ' +
      '(returns the result directly) or "session" for interactive multi-turn ' +
      'conversations with the sub-agent.',
    parameters: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          description: 'Agent ID to spawn (e.g., "grok", "opus", "local")',
        },
        task: {
          type: 'string',
          description: 'Task description or initial message for the sub-agent',
        },
        mode: {
          type: 'string',
          enum: ['run', 'session'],
          description: '"run" = one-shot (returns result), "session" = persistent (stays alive for follow-ups)',
        },
        timeout_ms: {
          type: 'number',
          description: 'Optional timeout in milliseconds (default: none)',
        },
      },
      required: ['agent', 'task', 'mode'],
    },
    execute: async (args, signal, context) => {
      try {
        const session = await manager.spawn({
          agent: args.agent as string,
          task: args.task as string,
          mode: args.mode as 'run' | 'session',
          timeoutMs: args.timeout_ms as number | undefined,
        });

        if (args.mode === 'run') {
          // One-shot: return the last assistant message
          const lastMsg = session.history.find((m) => m.role === 'assistant');
          return lastMsg ? getTextContent(lastMsg.content) : '[No response from sub-agent]';
        } else {
          // Session mode: return session ID + initial response
          const lastMsg = session.history.find((m) => m.role === 'assistant');
          return JSON.stringify({
            sessionId: session.id,
            agent: session.childAgent,
            status: session.status,
            response: lastMsg ? getTextContent(lastMsg.content) : '[No initial response]',
          });
        }
      } catch (err: any) {
        return `Error spawning sub-agent: ${err.message}`;
      }
    },
  };

  const sendTool: Tool = {
    name: 'subagent_send',
    description:
      'Send a message to a persistent sub-agent session. ' +
      'Only works with sessions spawned in "session" mode.',
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
        const response = await manager.send(
          args.session_id as string,
          args.message as string,
        );
        return response;
      } catch (err: any) {
        return `Error: ${err.message}`;
      }
    },
  };

  const listTool: Tool = {
    name: 'subagent_list',
    description: 'List all active sub-agent sessions.',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async () => {
      const sessions = manager.list();
      if (sessions.length === 0) {
        return 'No active sub-agent sessions.';
      }
      return JSON.stringify(
        sessions.map((s) => ({
          id: s.id,
          agent: s.childAgent,
          status: s.status,
          messages: s.history.length,
          createdAt: new Date(s.createdAt).toISOString(),
        })),
        null,
        2,
      );
    },
  };

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
        manager.kill(args.session_id as string);
        return `Sub-agent session ${args.session_id} killed.`;
      } catch (err: any) {
        return `Error: ${err.message}`;
      }
    },
  };

  return [spawnTool, sendTool, listTool, killTool];
}
