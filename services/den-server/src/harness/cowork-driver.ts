/**
 * `cowork` — capture-only HarnessDriver for Claude Desktop Cowork.
 *
 * Sessions are listed from host task metadata. A transcript is served when
 * the sandbox left a Claude JSONL next to that metadata. Nothing here starts,
 * resumes, or drives a turn: Cowork has no pin flag and the full-VM sandbox
 * is not a PTY the den can attach.
 */

import {
  HarnessError,
  formatSessionId,
  parseSessionId,
  type ApprovalDecision,
  type HarnessCapabilities,
  type HarnessDriver,
  type HarnessEvent,
  type SendUserTurnResult,
  type SessionId,
  type SessionSummary,
  type StartSessionOpts,
  type UserTurn,
} from '@rivetos/types'
import { findCoworkTask, listCoworkTasks, readCoworkTurns, type CoworkTaskMeta } from './cowork-store.js'

export const COWORK_HARNESS_ID = 'cowork' as const

const CAPABILITIES: HarnessCapabilities = {
  interrupt: false,
  resume: false,
  approvals: false,
  liveStream: false,
  listSessions: true,
  drive: false,
}

function unsupported(op: string): HarnessError {
  return new HarnessError(
    'capability_unsupported',
    `cowork is capture-only and cannot ${op}`,
    { harnessId: COWORK_HARNESS_ID },
  )
}

function summary(task: CoworkTaskMeta): SessionSummary {
  return {
    sessionId: formatSessionId(COWORK_HARNESS_ID, task.cliSessionId),
    harnessId: COWORK_HARNESS_ID,
    ...(task.title ? { title: task.title } : {}),
    ...(task.cwd ? { cwd: task.cwd } : {}),
    createdAt: new Date(task.createdAtMs).toISOString(),
    updatedAt: new Date(task.updatedAtMs).toISOString(),
    status: task.archived ? 'ended' : 'idle',
  }
}

export class CoworkDriver implements HarnessDriver {
  readonly harnessId = COWORK_HARNESS_ID
  readonly capabilities = CAPABILITIES

  startSession(_opts?: StartSessionOpts): Promise<SessionSummary> {
    return Promise.reject(unsupported('start a session'))
  }

  resumeSession(_sessionId: SessionId): Promise<SessionSummary> {
    return Promise.reject(unsupported('resume a session'))
  }

  interrupt(_sessionId: SessionId): Promise<void> {
    return Promise.reject(unsupported('interrupt'))
  }

  sendUserTurn(_sessionId: SessionId, _turn: UserTurn): Promise<SendUserTurnResult | undefined> {
    return Promise.reject(unsupported('accept a turn'))
  }

  resolveApproval(
    _sessionId: SessionId,
    _requestId: string,
    _decision: ApprovalDecision,
  ): Promise<void> {
    return Promise.reject(unsupported('resolve an approval'))
  }

  subscribe(_sessionId: SessionId, _sink: (e: HarnessEvent) => void): () => void {
    return () => {}
  }

  subscribeEvents(_sink: (e: HarnessEvent) => void): () => void {
    return () => {}
  }

  close(): void {}

  async listSessions(): Promise<SessionSummary[]> {
    const tasks = await listCoworkTasks()
    return tasks.map(summary)
  }

  async getSession(sessionId: SessionId): Promise<SessionSummary | null> {
    const { harnessId, nativeSessionId } = parseSessionId(sessionId)
    if (harnessId !== COWORK_HARNESS_ID) return null
    const task = await findCoworkTask(nativeSessionId)
    return task ? summary(task) : null
  }

  /** Hard-resync source for `GET /api/harness-sessions/:id/transcript`. */
  async transcript(sessionId: SessionId): Promise<{ turns: Awaited<ReturnType<typeof readCoworkTurns>> }> {
    const { harnessId, nativeSessionId } = parseSessionId(sessionId)
    if (harnessId !== COWORK_HARNESS_ID) return { turns: [] }
    return { turns: await readCoworkTurns(nativeSessionId) }
  }
}
