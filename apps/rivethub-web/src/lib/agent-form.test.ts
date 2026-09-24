import { describe, expect, it } from 'vitest'
import { GatewayError } from '@rivetos/gateway-client'
import {
  agentCreateBody,
  agentCreateBodyLegacy,
  agentUpdateBody,
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
