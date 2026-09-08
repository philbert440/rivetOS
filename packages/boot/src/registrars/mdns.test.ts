import { EventEmitter } from 'node:events'
import { hostname } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RivetConfig } from '../config.js'
import { registerMdnsAdvertiser } from './mdns.js'

const mocks = vi.hoisted(() => {
  const publish = vi.fn(
    (opts: { name: string; type: string; port: number; txt?: Record<string, string> }) => {
      const name = String(opts.name).split('.').join('-')
      return {
        name,
        on: (event: string, listener: () => void): void => {
          if (event === 'up') queueMicrotask(listener)
        },
      }
    },
  )
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
  vi.useRealTimers()
})

function denConfig(advertise_mdns?: boolean): RivetConfig {
  return {
    runtime: { workspace: '~/.rivetos/workspace', default_agent: 'opus' },
    agents: {},
    den: advertise_mdns === undefined ? { enabled: true } : { enabled: true, advertise_mdns },
  } as RivetConfig
}

describe('registerMdnsAdvertiser', () => {
  it('does not import or publish when advertise_mdns is unset', async () => {
    const load = vi.fn(async () => {
      throw new Error('bonjour-service should not load')
    })
    await expect(registerMdnsAdvertiser(denConfig(), 5174, true, load)).resolves.toBeUndefined()
    expect(load).not.toHaveBeenCalled()
    expect(mocks.publish).not.toHaveBeenCalled()
  })

  it('does not import or publish when advertise_mdns is false', async () => {
    const load = vi.fn(async () => {
      throw new Error('bonjour-service should not load')
    })
    await expect(
      registerMdnsAdvertiser(denConfig(false), 5174, true, load),
    ).resolves.toBeUndefined()
    expect(load).not.toHaveBeenCalled()
    expect(mocks.publish).not.toHaveBeenCalled()
  })

  it('publishes hostname, type rivethub, port, and txt when enabled', async () => {
    const stop = await registerMdnsAdvertiser(denConfig(true), 5174, true)
    expect(stop).toEqual(expect.any(Function))
    expect(mocks.publish).toHaveBeenCalledTimes(1)
    expect(mocks.publish).toHaveBeenCalledWith({
      name: hostname(),
      type: 'rivethub',
      port: 5174,
      txt: { tls: '1', v: '1' },
    })
    await stop?.()
  })

  it('sets txt.tls to 0 when TLS is not configured', async () => {
    const stop = await registerMdnsAdvertiser(denConfig(true), 5174, false)
    expect(mocks.publish).toHaveBeenCalledWith({
      name: hostname(),
      type: 'rivethub',
      port: 5174,
      txt: { tls: '0', v: '1' },
    })
    await stop?.()
  })

  it('unpublishes and destroys on stop (destroy only after unpublish callback)', async () => {
    const stop = await registerMdnsAdvertiser(denConfig(true), 5174, true)
    expect(stop).toEqual(expect.any(Function))

    let finishUnpublish: (() => void) | undefined
    mocks.unpublishAll.mockImplementation((cb?: () => void) => {
      finishUnpublish = cb
    })

    const done = stop!()
    expect(mocks.unpublishAll).toHaveBeenCalledTimes(1)
    expect(mocks.destroy).not.toHaveBeenCalled()
    finishUnpublish?.()
    await done
    expect(mocks.destroy).toHaveBeenCalledTimes(1)
  })

  it('warns and does not throw when bonjour-service is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const err = Object.assign(new Error("Cannot find module 'bonjour-service'"), {
      code: 'ERR_MODULE_NOT_FOUND',
    })
    await expect(
      registerMdnsAdvertiser(denConfig(true), 5174, true, () => Promise.reject(err)),
    ).resolves.toBeUndefined()
    expect(mocks.publish).not.toHaveBeenCalled()
    expect(warn.mock.calls.some((call) => String(call[0]).includes('bonjour-service'))).toBe(true)
    warn.mockRestore()
  })

  it('warns on multicast-dns error and does not throw', async () => {
    const mdns = new EventEmitter()
    const service = Object.assign(new EventEmitter(), { name: 'test-host' })
    class Bonjour {
      server = { mdns }
      publish = vi.fn(() => service)
      unpublishAll = vi.fn((cb?: () => void) => {
        cb?.()
      })
      destroy = vi.fn()
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const stop = await registerMdnsAdvertiser(denConfig(true), 5174, true, async () => ({
      Bonjour,
    }))
    expect(() => {
      mdns.emit('error', new Error('bind EADDRINUSE 0.0.0.0:5353'))
    }).not.toThrow()
    expect(warn.mock.calls.some((call) => String(call[0]).includes('mDNS'))).toBe(true)
    await stop?.()
    warn.mockRestore()
  })

  it('logs advertised instance name on up (dots become dashes)', async () => {
    const service = Object.assign(new EventEmitter(), { name: 'ct115-lan' })
    class Bonjour {
      publish = vi.fn(() => service)
      unpublishAll = vi.fn((cb?: () => void) => {
        cb?.()
      })
      destroy = vi.fn()
    }
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const stop = await registerMdnsAdvertiser(denConfig(true), 5174, true, async () => ({
      Bonjour,
    }))
    expect(info.mock.calls.some((call) => String(call[0]).includes('mDNS advertised'))).toBe(false)
    service.emit('up')
    expect(
      info.mock.calls.some(
        (call) =>
          String(call[0]).includes('mDNS advertised ct115-lan') &&
          String(call[0]).includes('rivethub'),
      ),
    ).toBe(true)
    await stop?.()
    info.mockRestore()
  })

  it('warns when the service never comes up (name conflict swallowed by the lib)', async () => {
    vi.useFakeTimers()
    const service = Object.assign(new EventEmitter(), { name: 'busy-host' })
    class Bonjour {
      publish = vi.fn(() => service)
      unpublishAll = vi.fn((cb?: () => void) => {
        cb?.()
      })
      destroy = vi.fn()
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const stop = await registerMdnsAdvertiser(denConfig(true), 5174, true, async () => ({
      Bonjour,
    }))
    expect(warn.mock.calls.some((call) => String(call[0]).includes('not advertised'))).toBe(false)
    await vi.advanceTimersByTimeAsync(2000)
    expect(
      warn.mock.calls.some(
        (call) =>
          String(call[0]).includes('not advertised') && String(call[0]).includes('busy-host'),
      ),
    ).toBe(true)
    await stop?.()
    warn.mockRestore()
  })
})
