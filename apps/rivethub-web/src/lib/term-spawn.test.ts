import type { TermSpawnRequest } from '@rivetos/types'
import { GatewayError } from '@rivetos/gateway-client'
import { describe, expect, it, vi } from 'vitest'
import {
  isDeletedAgentError,
  presetSpawnFields,
  recoverDeletedAgentSpawn,
  termSpawnBody,
  termSpawnFallbackBody,
} from './term-spawn.js'

describe('termSpawnBody', () => {
  it('includes agentId together with the thread model and effort', () => {
    expect(
      termSpawnBody({
        sessionId: 'sess-1',
        command: 'claude',
        resumeSessionId: 'sess-1',
        agentId: 'reviewer',
        model: 'haiku',
        effort: 'low',
      }),
    ).toEqual({
      session: 'sess-1',
      command: 'claude',
      resume: 'sess-1',
      agentId: 'reviewer',
      model: 'haiku',
      effort: 'low',
    })
  })

  it('sends both model and effort when each is set, even if one matches a preset', () => {
    expect(
      termSpawnBody({
        sessionId: 'sess-1',
        agentId: 'reviewer',
        model: 'opus',
        effort: 'low',
      }),
    ).toEqual({ session: 'sess-1', agentId: 'reviewer', model: 'opus', effort: 'low' })
    expect(
      termSpawnBody({
        sessionId: 'sess-1',
        agentId: 'reviewer',
        model: 'haiku',
        effort: 'max',
      }),
    ).toEqual({ session: 'sess-1', agentId: 'reviewer', model: 'haiku', effort: 'max' })
  })

  it('sends stored model and effort when the preset is not loaded', () => {
    expect(
      termSpawnBody({
        sessionId: 'sess-1',
        agentId: 'reviewer',
        model: 'haiku',
        effort: 'low',
      }),
    ).toEqual({ session: 'sess-1', agentId: 'reviewer', model: 'haiku', effort: 'low' })
  })

  it('does not drop model or effort for a thread with no agentId', () => {
    expect(
      termSpawnBody({
        sessionId: 'sess-1',
        command: 'claude',
        model: 'haiku',
        effort: 'low',
      }),
    ).toEqual({ session: 'sess-1', command: 'claude', model: 'haiku', effort: 'low' })
  })

  it('omits agentId when the preset has no harness, and still sends model and effort', () => {
    expect(
      termSpawnBody({
        sessionId: 'sess-1',
        agentId: 'reviewer',
        model: 'haiku',
        effort: 'low',
        presetHasHarness: false,
      }),
    ).toEqual({ session: 'sess-1', model: 'haiku', effort: 'low' })
    expect(
      termSpawnBody({
        sessionId: 'sess-1',
        agentId: 'reviewer',
        model: 'haiku',
        effort: 'low',
        presetHasHarness: true,
      }).agentId,
    ).toBe('reviewer')
  })
})

describe('recoverDeletedAgentSpawn', () => {
  const body: TermSpawnRequest = {
    session: 'sess-1',
    command: 'claude',
    model: 'haiku',
    effort: 'low',
    resume: 'sess-1',
    agentId: 'reviewer',
  }
  const missing = new GatewayError(404, 'agent not found', { error: 'agent not found' })

  it('retries once without agentId and keeps model, effort, command, and resume', async () => {
    const calls: TermSpawnRequest[] = []
    const onDeleted = vi.fn()
    const result = await recoverDeletedAgentSpawn(
      (req) => {
        calls.push(req)
        if (calls.length === 1) return Promise.reject(missing)
        return Promise.resolve('pty-1')
      },
      body,
      onDeleted,
    )
    expect(result).toEqual({ result: 'pty-1', droppedAgentId: true })
    expect(onDeleted).toHaveBeenCalledTimes(1)
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual({
      session: 'sess-1',
      command: 'claude',
      model: 'haiku',
      effort: 'low',
      resume: 'sess-1',
    })
    expect(calls[1]).not.toHaveProperty('agentId')
  })

  it('surfaces the second failure after clearing the preset id', async () => {
    const onDeleted = vi.fn()
    const spawn = vi
      .fn<(body: TermSpawnRequest) => Promise<string>>()
      .mockRejectedValueOnce(missing)
      .mockRejectedValueOnce(new GatewayError(500, 'still dead', {}))
    await expect(recoverDeletedAgentSpawn(spawn, body, onDeleted)).rejects.toThrow('still dead')
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(onDeleted).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[1]?.[0]).not.toHaveProperty('agentId')
  })

  it('does not retry a 409, a different 404, or a 404 when agentId was not sent', async () => {
    const hosted = new GatewayError(409, 'agent "reviewer" is hosted on other', {})
    const command = new GatewayError(404, 'command not found', {})
    const longer = new GatewayError(404, 'agent not found on node', {})
    for (const err of [hosted, command, longer]) {
      const spawn = vi.fn().mockRejectedValue(err)
      await expect(recoverDeletedAgentSpawn(spawn, body)).rejects.toBe(err)
      expect(spawn).toHaveBeenCalledTimes(1)
    }
    const { agentId: _agentId, ...without } = body
    const spawn = vi.fn().mockRejectedValue(missing)
    await expect(recoverDeletedAgentSpawn(spawn, without)).rejects.toBe(missing)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(isDeletedAgentError(missing)).toBe(true)
    expect(isDeletedAgentError(longer)).toBe(false)
  })
})

describe('termSpawnFallbackBody', () => {
  it('keeps agentId on the 404 fallback', () => {
    expect(termSpawnFallbackBody('sess-1', 'reviewer')).toEqual({
      session: 'sess-1',
      agentId: 'reviewer',
    })
  })

  it('is session-only when there is no preset', () => {
    expect(termSpawnFallbackBody('sess-1')).toEqual({ session: 'sess-1' })
    expect(termSpawnFallbackBody('sess-1', '  ')).toEqual({ session: 'sess-1' })
  })
})

describe('presetSpawnFields', () => {
  it('reads the first cached list that has the preset', () => {
    expect(
      presetSpawnFields('reviewer', [undefined, [{ id: 'other', model: 'x', effort: 'y' }]]),
    ).toBeUndefined()
    expect(
      presetSpawnFields('reviewer', [
        [{ id: 'reviewer', model: 'haiku', effort: 'low' }],
        [{ id: 'reviewer', model: 'opus', effort: 'high' }],
      ]),
    ).toEqual({ model: 'haiku', effort: 'low' })
  })
})
