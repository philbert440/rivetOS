import type { CatalogAgent } from '@rivetos/types'
import { describe, expect, it, vi } from 'vitest'
import { GatewayError } from '@rivetos/gateway-client'
import {
  agentCreateBody,
  agentCreateBodyLegacy,
  agentUpdateBody,
  catalogNameClashes,
  createWithLegacyRetry,
  isLegacyNodeBaseUrlRequired,
} from './agent-form.js'

describe('agentCreateBody', () => {
  it('sends directory and sharedLink and does not send node or nodeBaseUrl', () => {
    const body = agentCreateBody({
      name: 'Reviewer',
      color: '#fff',
      harnessId: 'codex',
      model: 'gpt',
      effort: 'high',
      systemPrompt: 'be brief',
      directory: '  ~/agents/reviewer  ',
      sharedLink: false,
      nodeBaseUrl: 'https://den.example',
    })
    expect(body).toEqual({
      name: 'Reviewer',
      color: '#fff',
      harnessId: 'codex',
      model: 'gpt',
      effort: 'high',
      systemPrompt: 'be brief',
      directory: '~/agents/reviewer',
      sharedLink: false,
    })
    expect(body).not.toHaveProperty('node')
    expect(body).not.toHaveProperty('nodeBaseUrl')
  })

  it('omits an empty directory and defaults the shared link on', () => {
    const body = agentCreateBody({ name: 'Reviewer', directory: '   ' })
    expect(body.sharedLink).toBe(true)
    expect(body).not.toHaveProperty('directory')
  })

  it('retries once with nodeBaseUrl when an old den still requires it', () => {
    const legacy = agentCreateBodyLegacy(
      { name: 'Reviewer', directory: '/srv/reviewer', sharedLink: true },
      'https://old.example',
    )
    expect(legacy.nodeBaseUrl).toBe('https://old.example')
    expect(legacy.directory).toBe('/srv/reviewer')
    expect(
      isLegacyNodeBaseUrlRequired(
        new GatewayError(400, 'nodeBaseUrl is required', { error: 'nodeBaseUrl is required' }),
      ),
    ).toBe(true)
    expect(isLegacyNodeBaseUrlRequired(new GatewayError(400, 'bad name', {}))).toBe(false)
    expect(isLegacyNodeBaseUrlRequired(new GatewayError(500, 'nodeBaseUrl is required', {}))).toBe(
      false,
    )
  })
})

describe('createWithLegacyRetry', () => {
  const agent = { name: 'Reviewer', directory: '/srv/reviewer', sharedLink: true }
  const legacyErr = new GatewayError(400, 'nodeBaseUrl is required', {
    error: 'nodeBaseUrl is required',
  })

  it('posts the current-den body once when the den accepts it', async () => {
    const post = vi.fn().mockResolvedValue({ id: 'a' })
    await expect(createWithLegacyRetry(post, agent, 'https://old.example')).resolves.toEqual({
      id: 'a',
    })
    expect(post).toHaveBeenCalledTimes(1)
    expect(post.mock.calls[0]?.[0]).not.toHaveProperty('nodeBaseUrl')
  })

  it('retries once with nodeBaseUrl and does not retry again', async () => {
    const post = vi.fn().mockRejectedValueOnce(legacyErr).mockResolvedValueOnce({ id: 'a' })
    await expect(createWithLegacyRetry(post, agent, 'https://old.example')).resolves.toEqual({
      id: 'a',
    })
    expect(post).toHaveBeenCalledTimes(2)
    expect(post.mock.calls[1]?.[0]).toMatchObject({
      name: 'Reviewer',
      nodeBaseUrl: 'https://old.example',
      directory: '/srv/reviewer',
    })
  })

  it('surfaces the second failure and does not retry a different error', async () => {
    const second = new GatewayError(500, 'still down', {})
    const post = vi.fn().mockRejectedValueOnce(legacyErr).mockRejectedValueOnce(second)
    await expect(createWithLegacyRetry(post, agent, 'https://old.example')).rejects.toBe(second)
    expect(post).toHaveBeenCalledTimes(2)

    const other = new GatewayError(400, 'bad name', {})
    const once = vi.fn().mockRejectedValue(other)
    await expect(createWithLegacyRetry(once, agent, 'https://old.example')).rejects.toBe(other)
    expect(once).toHaveBeenCalledTimes(1)
  })
})

describe('catalogNameClashes', () => {
  const local: CatalogAgent = { id: 'reviewer', provider: 'claude', node: 'ct115', local: true }
  const remote: CatalogAgent = { id: 'reviewer', node: 'ct116', local: false }
  const preset: CatalogAgent = {
    kind: 'preset',
    id: 'reviewer',
    name: 'Reviewer',
    node: 'ct115',
    local: true,
  }

  it('warns only for a local config agent id, case-sensitively', () => {
    expect(catalogNameClashes('reviewer', [local])).toBe(true)
    expect(catalogNameClashes('Reviewer', [local])).toBe(false)
    expect(catalogNameClashes('reviewer', [remote])).toBe(false)
    expect(catalogNameClashes('reviewer', [preset])).toBe(false)
    expect(catalogNameClashes('  ', [local])).toBe(false)
    expect(catalogNameClashes('reviewer', [local], 'reviewer')).toBe(false)
  })
})

describe('agentUpdateBody', () => {
  const previous = { directory: '/srv/reviewer', sharedLink: true }

  it('sends directory and sharedLink only when they changed, never node or nodeBaseUrl', () => {
    const same = agentUpdateBody(previous, {
      name: 'Reviewer',
      directory: '/srv/reviewer',
      sharedLink: true,
      nodeBaseUrl: 'https://den.example',
    })
    expect(same).not.toHaveProperty('directory')
    expect(same).not.toHaveProperty('sharedLink')
    expect(same).not.toHaveProperty('node')
    expect(same).not.toHaveProperty('nodeBaseUrl')

    const next = agentUpdateBody(previous, {
      name: 'Reviewer',
      directory: '~/agents/reviewer',
      sharedLink: false,
    })
    expect(next.directory).toBe('~/agents/reviewer')
    expect(next.sharedLink).toBe(false)
    expect(next).not.toHaveProperty('nodeBaseUrl')
  })

  it('treats a missing sharedLink on the stored preset as on', () => {
    const body = agentUpdateBody(
      { directory: undefined, sharedLink: undefined },
      { name: 'Reviewer', directory: '', sharedLink: true },
    )
    expect(body).not.toHaveProperty('directory')
    expect(body).not.toHaveProperty('sharedLink')
  })
})
