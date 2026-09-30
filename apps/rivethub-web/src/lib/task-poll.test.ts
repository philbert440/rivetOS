import { describe, expect, it } from 'vitest'
import { GatewayError } from '@rivetos/gateway-client'
import { taskDetailRefetchInterval } from './task-poll.js'

describe('taskDetailRefetchInterval', () => {
  it('polls at 2s only while a non-terminal task has a parked approval', () => {
    expect(
      taskDetailRefetchInterval({
        error: null,
        task: { status: 'running', pendingApprovals: [{ requestId: 'r1' }] },
      }),
    ).toBe(2_000)
    expect(
      taskDetailRefetchInterval({
        error: null,
        task: { status: 'awaiting-input', pendingApprovals: [{ requestId: 'r1' }] },
      }),
    ).toBe(2_000)
  })

  it('stays at 10s when nothing is parked, or the row is already terminal', () => {
    expect(taskDetailRefetchInterval({ error: null })).toBe(10_000)
    expect(taskDetailRefetchInterval({ error: null, task: { status: 'running' } })).toBe(10_000)
    expect(
      taskDetailRefetchInterval({
        error: null,
        task: { status: 'running', pendingApprovals: [] },
      }),
    ).toBe(10_000)
    for (const status of ['completed', 'failed', 'killed', 'timeout']) {
      expect(
        taskDetailRefetchInterval({
          error: null,
          task: { status, pendingApprovals: [{ requestId: 'r1' }] },
        }),
      ).toBe(10_000)
    }
  })

  it('stops on 400 and 404, and keeps polling through other errors', () => {
    expect(
      taskDetailRefetchInterval({ error: new GatewayError(404, 'missing', {}), task: undefined }),
    ).toBe(false)
    expect(
      taskDetailRefetchInterval({ error: new GatewayError(400, 'bad id', {}), task: undefined }),
    ).toBe(false)
    expect(
      taskDetailRefetchInterval({
        error: new GatewayError(500, 'boom', {}),
        task: { status: 'running', pendingApprovals: [{ requestId: 'r1' }] },
      }),
    ).toBe(2_000)
  })
})
