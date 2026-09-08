import { hostname } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Runtime } from '@rivetos/core'
import type { RivetConfig } from '../config.js'
import { registerMdnsAdvertiser } from './mdns.js'

const mocks = vi.hoisted(() => {
  const publish = vi.fn()
  const unpublishAll = vi.fn((cb?: () => void) => {
    cb?.()
  })
  const destroy = vi.fn()
  class Bonjour {
    publish = publish
    unpublishAll = unpublishAll
    destroy = destroy
  }
  return { publish, unpublishAll, destroy, Bonjour }
})

vi.mock('bonjour-service', () => ({
  default: mocks.Bonjour,
  Bonjour: mocks.Bonjour,
}))

afterEach(() => {
  vi.clearAllMocks()
})

function fakeRuntime(): { runtime: Runtime; hooks: Array<() => Promise<void>> } {
  const hooks: Array<() => Promise<void>> = []
  const runtime = {
    addShutdownHook: (hook: () => Promise<void>): void => {
      hooks.push(hook)
    },
  } as Runtime
  return { runtime, hooks }
}

function denConfig(advertise_mdns?: boolean): RivetConfig {
  return {
    runtime: { workspace: '~/.rivetos/workspace', default_agent: 'opus' },
    agents: {},
    den: advertise_mdns === undefined ? { enabled: true } : { enabled: true, advertise_mdns },
  } as RivetConfig
}

describe('registerMdnsAdvertiser', () => {
  it('does not import or publish when advertise_mdns is unset', async () => {
    const { runtime } = fakeRuntime()
    const load = vi.fn(async () => {
      throw new Error('bonjour-service should not load')
    })
    await registerMdnsAdvertiser(runtime, denConfig(), 5174, true, load)
    expect(load).not.toHaveBeenCalled()
    expect(mocks.publish).not.toHaveBeenCalled()
  })

  it('does not import or publish when advertise_mdns is false', async () => {
    const { runtime } = fakeRuntime()
    const load = vi.fn(async () => {
      throw new Error('bonjour-service should not load')
    })
    await registerMdnsAdvertiser(runtime, denConfig(false), 5174, true, load)
    expect(load).not.toHaveBeenCalled()
    expect(mocks.publish).not.toHaveBeenCalled()
  })

  it('publishes hostname, type rivethub, port, and txt when enabled', async () => {
    const { runtime } = fakeRuntime()
    await registerMdnsAdvertiser(runtime, denConfig(true), 5174, true)
    expect(mocks.publish).toHaveBeenCalledTimes(1)
    expect(mocks.publish).toHaveBeenCalledWith({
      name: hostname(),
      type: 'rivethub',
      port: 5174,
      txt: { tls: '1', v: '1' },
    })
  })

  it('sets txt.tls to 0 when TLS is not configured', async () => {
    const { runtime } = fakeRuntime()
    await registerMdnsAdvertiser(runtime, denConfig(true), 5174, false)
    expect(mocks.publish).toHaveBeenCalledWith({
      name: hostname(),
      type: 'rivethub',
      port: 5174,
      txt: { tls: '0', v: '1' },
    })
  })

  it('unpublishes and destroys on shutdown', async () => {
    const { runtime, hooks } = fakeRuntime()
    await registerMdnsAdvertiser(runtime, denConfig(true), 5174, true)
    expect(hooks).toHaveLength(1)

    let finishUnpublish: (() => void) | undefined
    mocks.unpublishAll.mockImplementation((cb?: () => void) => {
      finishUnpublish = cb
    })

    const done = hooks[0]!()
    expect(mocks.unpublishAll).toHaveBeenCalledTimes(1)
    expect(mocks.destroy).not.toHaveBeenCalled()
    finishUnpublish?.()
    await done
    expect(mocks.destroy).toHaveBeenCalledTimes(1)
  })

  it('warns and does not throw when bonjour-service is missing', async () => {
    const { runtime } = fakeRuntime()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const err = Object.assign(new Error("Cannot find module 'bonjour-service'"), {
      code: 'ERR_MODULE_NOT_FOUND',
    })
    await expect(
      registerMdnsAdvertiser(runtime, denConfig(true), 5174, true, () => Promise.reject(err)),
    ).resolves.toBeUndefined()
    expect(mocks.publish).not.toHaveBeenCalled()
    expect(warn.mock.calls.some((call) => String(call[0]).includes('bonjour-service'))).toBe(true)
    warn.mockRestore()
  })
})
