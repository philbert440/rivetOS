import type { TermSpawnRequest } from '@rivetos/types'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { GatewayError } from '@rivetos/gateway-client'
import { describe, expect, it, vi } from 'vitest'
import {
  DELETED_PRESET_NOTICE,
  isDeletedAgentError,
  presetHasHarnessFlag,
  listedAgentIds,
  recoverDeletedAgentSpawn,
  recoverDeletedAgentSpawnUsingCache,
  spawnOnceWithCommandFallback,
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

  it('does not recover when the preset id is still in the agents cache', async () => {
    const onDeleted = vi.fn()
    const spawn = vi.fn().mockRejectedValue(missing)
    await expect(recoverDeletedAgentSpawn(spawn, body, onDeleted, [' reviewer '])).rejects.toBe(
      missing,
    )
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(onDeleted).not.toHaveBeenCalled()
  })

  it('still recovers when the cache lists other presets but not this id', async () => {
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
      ['other'],
    )
    expect(result).toEqual({ result: 'pty-1', droppedAgentId: true })
    expect(onDeleted).toHaveBeenCalledTimes(1)
    expect(calls[1]).not.toHaveProperty('agentId')
  })

  it('stays loud while the id is listed, then recovers once it is gone', async () => {
    const onDeleted = vi.fn()
    const spawn = vi
      .fn<(body: TermSpawnRequest) => Promise<string>>()
      .mockRejectedValueOnce(missing)
      .mockRejectedValueOnce(missing)
      .mockResolvedValueOnce('pty-1')
    await expect(recoverDeletedAgentSpawn(spawn, body, onDeleted, ['reviewer'])).rejects.toBe(
      missing,
    )
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(onDeleted).not.toHaveBeenCalled()
    const result = await recoverDeletedAgentSpawn(spawn, body, onDeleted, ['other'])
    expect(result).toEqual({ result: 'pty-1', droppedAgentId: true })
    expect(onDeleted).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledTimes(3)
    expect(spawn.mock.calls[2]?.[0]).not.toHaveProperty('agentId')
  })
})

describe('recoverDeletedAgentSpawnUsingCache', () => {
  const body: TermSpawnRequest = {
    session: 'sess-1',
    command: 'claude',
    model: 'haiku',
    effort: 'low',
    resume: 'sess-1',
    agentId: 'reviewer',
  }
  const missing = new GatewayError(404, 'agent not found', { error: 'agent not found' })
  const reviewer = {
    id: 'reviewer',
    name: 'Reviewer',
    color: '',
    model: '',
    harnessId: 'claude-code' as const,
  }
  const ghost = {
    id: 'ghost',
    name: 'Ghost',
    color: '',
    model: '',
    harnessId: 'claude-code' as const,
  }
  const other = {
    id: 'other',
    name: 'Other',
    color: '',
    model: '',
    harnessId: 'claude-code' as const,
  }

  function cache(): { client: QueryClient; unsubscribe: () => void } {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    })
    const activeKey = ['agents-all-nodes', 'https://live.example', 2]
    // An older roster key / transport epoch. No observer, so it stays inactive
    // and must not count even though it still lists the deleted id.
    client.setQueryData(activeKey, [{ baseUrl: 'https://live.example', agents: [reviewer] }])
    client.setQueryData(
      ['agents-all-nodes', 'https://old.example', 1],
      [{ baseUrl: 'https://old.example', agents: [reviewer, ghost] }],
    )
    const observer = new QueryObserver(client, {
      queryKey: activeKey,
      queryFn: () => [{ baseUrl: 'https://live.example', agents: [reviewer] }],
      staleTime: Infinity,
    })
    const unsubscribe = observer.subscribe(() => undefined)
    return { client, unsubscribe }
  }

  it('ignores an inactive entry, stays loud while the active list has the id, then recovers', async () => {
    const { client, unsubscribe } = cache()
    try {
      expect(listedAgentIds(client)).toEqual(['reviewer'])
      const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue()
      const onDeleted = vi.fn()
      const spawn = vi
        .fn<(body: TermSpawnRequest) => Promise<string>>()
        .mockRejectedValueOnce(missing)
        .mockRejectedValueOnce(missing)
        .mockResolvedValueOnce('pty-1')
      await expect(recoverDeletedAgentSpawnUsingCache(client, spawn, body, onDeleted)).rejects.toBe(
        missing,
      )
      expect(spawn).toHaveBeenCalledTimes(1)
      expect(onDeleted).not.toHaveBeenCalled()
      expect(invalidate).toHaveBeenCalledTimes(1)
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['agents-all-nodes'] })

      client.setQueryData(
        ['agents-all-nodes', 'https://live.example', 2],
        [{ baseUrl: 'https://live.example', agents: [other] }],
      )
      // The inactive snapshot still lists reviewer and ghost.
      expect(listedAgentIds(client)).toEqual(['other'])
      const result = await recoverDeletedAgentSpawnUsingCache(client, spawn, body, onDeleted)
      expect(result).toEqual({ result: 'pty-1', droppedAgentId: true })
      expect(onDeleted).toHaveBeenCalledTimes(1)
      expect(spawn).toHaveBeenCalledTimes(3)
      expect(spawn.mock.calls[2]?.[0]).not.toHaveProperty('agentId')
      expect(invalidate).toHaveBeenCalledTimes(1)
    } finally {
      unsubscribe()
      client.clear()
    }
  })
})

describe('termSpawnFallbackBody', () => {
  it('keeps session, agentId, model, and effort, trimmed, and drops command and resume', () => {
    expect(
      termSpawnFallbackBody({
        session: '  sess-1  ',
        command: 'claude',
        resume: 'sess-1',
        agentId: ' reviewer ',
        model: '  haiku  ',
        effort: ' low ',
      }),
    ).toEqual({
      session: 'sess-1',
      agentId: 'reviewer',
      model: 'haiku',
      effort: 'low',
    })
  })

  it('always sends session, and omits empty agentId, model, and effort', () => {
    expect(termSpawnFallbackBody({ session: 'sess-1' })).toEqual({ session: 'sess-1' })
    expect(
      termSpawnFallbackBody({
        session: '   ',
        agentId: '  ',
        model: '',
        effort: '  ',
      }),
    ).toEqual({ session: '' })
  })
})

describe('spawnOnceWithCommandFallback', () => {
  const body: TermSpawnRequest = {
    session: 'sess-1',
    command: 'claude',
    resume: 'sess-1',
    agentId: 'reviewer',
    model: '  haiku  ',
    effort: 'low',
  }
  const commandMissing = new GatewayError(404, 'command not found', {})

  it('retries a command 404 with no harness and keeps session, model, and effort', async () => {
    const calls: TermSpawnRequest[] = []
    const spawnOnce = (req: TermSpawnRequest) =>
      spawnOnceWithCommandFallback(
        (next) => {
          calls.push(next)
          if (calls.length === 1) return Promise.reject(commandMissing)
          return Promise.resolve('pty-1')
        },
        req,
        { command: 'claude' },
      )
    await expect(spawnOnce(body)).resolves.toBe('pty-1')
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual({
      session: 'sess-1',
      agentId: 'reviewer',
      model: 'haiku',
      effort: 'low',
    })
    expect(calls[1]).not.toHaveProperty('command')
    expect(calls[1]).not.toHaveProperty('resume')
  })

  it('does not fall back for agent not found, a harness, or a non-404', async () => {
    const missing = new GatewayError(404, 'agent not found', { error: 'agent not found' })
    const hosted = new GatewayError(409, 'hosted elsewhere', {})
    const cases: { err: GatewayError; harnessId?: string }[] = [
      { err: missing },
      { err: commandMissing, harnessId: 'claude-code' },
      { err: hosted },
    ]
    for (const { err, harnessId } of cases) {
      const spawn = vi.fn().mockRejectedValue(err)
      await expect(
        spawnOnceWithCommandFallback(spawn, body, { command: 'claude', harnessId }),
      ).rejects.toBe(err)
      expect(spawn).toHaveBeenCalledTimes(1)
    }
  })

  it('spawns once when there is no command', async () => {
    const spawn = vi.fn().mockResolvedValue('pty-1')
    await expect(
      spawnOnceWithCommandFallback(spawn, { session: 'sess-1', model: 'haiku' }, {}),
    ).resolves.toBe('pty-1')
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledWith({ session: 'sess-1', model: 'haiku' })
  })
})

describe('DELETED_PRESET_NOTICE', () => {
  it('does not claim the preset was deleted', () => {
    expect(DELETED_PRESET_NOTICE).toBe('Preset not found on this node; opened without it')
  })
})

describe('presetHasHarnessFlag', () => {
  it('leaves the flag unset when the thread has no preset', () => {
    expect(presetHasHarnessFlag(undefined)).toBeUndefined()
    expect(presetHasHarnessFlag({ agentId: '' })).toBeUndefined()
    expect(
      termSpawnBody({
        sessionId: 'sess-1',
        model: 'haiku',
        effort: 'low',
        presetHasHarness: presetHasHarnessFlag(undefined),
      }),
    ).toEqual({ session: 'sess-1', model: 'haiku', effort: 'low' })
  })

  it('is false for a preset with no harness, and the body omits agentId', () => {
    const settings = { agentId: 'reviewer' }
    expect(presetHasHarnessFlag(settings)).toBe(false)
    expect(
      termSpawnBody({
        sessionId: 'sess-1',
        agentId: settings.agentId,
        model: 'haiku',
        effort: 'low',
        presetHasHarness: presetHasHarnessFlag(settings),
      }),
    ).toEqual({ session: 'sess-1', model: 'haiku', effort: 'low' })
  })

  it('is true when the preset has a harness, and the body keeps agentId', () => {
    const settings = { agentId: 'reviewer', harnessId: 'claude-code' }
    expect(presetHasHarnessFlag(settings)).toBe(true)
    expect(
      termSpawnBody({
        sessionId: 'sess-1',
        agentId: settings.agentId,
        model: 'haiku',
        effort: 'low',
        presetHasHarness: presetHasHarnessFlag(settings),
      }).agentId,
    ).toBe('reviewer')
  })
})
