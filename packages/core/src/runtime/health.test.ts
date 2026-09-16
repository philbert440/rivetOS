import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { HealthServer, resolveHealthBind } from './health.js'

function healthHandlers() {
  return {
    getAgents: () => [] as string[],
    checkProviders: async () => ({}),
    getChannelStatus: () => ({}),
    getMemoryStatus: () => true,
  }
}

async function freeLoopbackPort(): Promise<number> {
  const tmp = createServer()
  await new Promise<void>((resolve, reject) => {
    tmp.once('error', reject)
    tmp.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = tmp.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  await new Promise<void>((resolve, reject) => {
    tmp.close((err) => (err ? reject(err) : resolve()))
  })
  return port
}

describe('resolveHealthBind', () => {
  it('defaults fleet nodes to all interfaces :3100', () => {
    expect(resolveHealthBind({})).toEqual({ host: '0.0.0.0', port: 3100 })
  })

  it('binds loopback when RIVETOS_MODE is workspace', () => {
    expect(resolveHealthBind({ RIVETOS_MODE: 'workspace' })).toEqual({
      host: '127.0.0.1',
      port: 3100,
    })
  })

  it('reads host and port from env', () => {
    expect(
      resolveHealthBind({ RIVETOS_HEALTH_HOST: '192.0.2.10', RIVETOS_HEALTH_PORT: '4100' }),
    ).toEqual({
      host: '192.0.2.10',
      port: 4100,
    })
  })

  it('lets an explicit host win over local mode', () => {
    expect(
      resolveHealthBind({ RIVETOS_MODE: 'workspace', RIVETOS_HEALTH_HOST: '0.0.0.0' }).host,
    ).toBe('0.0.0.0')
  })

  it('treats blank host as unset (fleet all-interfaces)', () => {
    expect(resolveHealthBind({ RIVETOS_HEALTH_HOST: '   ' }).host).toBe('0.0.0.0')
  })

  it('treats blank host in local mode as loopback', () => {
    expect(resolveHealthBind({ RIVETOS_MODE: 'workspace', RIVETOS_HEALTH_HOST: '   ' }).host).toBe(
      '127.0.0.1',
    )
  })
})

describe('HealthServer', () => {
  let server: HealthServer | undefined

  afterEach(async () => {
    await server?.stop()
    server = undefined
  })

  it('serves /health/live on the configured loopback port', async () => {
    const port = await freeLoopbackPort()
    server = new HealthServer({ port, host: '127.0.0.1', ...healthHandlers() })
    await server.start()
    const res = await fetch(`http://127.0.0.1:${String(port)}/health/live`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })
})
