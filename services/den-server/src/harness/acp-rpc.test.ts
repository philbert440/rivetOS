// AcpClient against a scripted agent in a real child process: newline JSON-RPC
// over stdio, initialize, agent → client requests, and exit handling.

import { afterEach, describe, expect, it } from 'vitest'
import { AcpClient, type AcpFrame } from './acp-rpc.js'

/**
 * `echo` answers with its params, `ask` makes a request to the client and
 * answers with the client's reply, `die` exits, `hang` never answers. The
 * agent prints a banner line first, as some real agents do.
 */
const AGENT = String.raw`
const rl = require('node:readline').createInterface({ input: process.stdin })
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
const waiting = new Map()
process.stdout.write('starting fake agent\n')
rl.on('line', (line) => {
  const m = JSON.parse(line)
  if (m.method === 'initialize')
    return send({ id: m.id, result: { protocolVersion: Number(process.env.PROTO || 1), agentCapabilities: { loadSession: true } } })
  if (m.method === 'echo') {
    send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'note' } } })
    return send({ id: m.id, result: m.params })
  }
  if (m.method === 'ask') {
    waiting.set('p1', m.id)
    return send({ id: 'p1', method: 'session/request_permission', params: { sessionId: 's1' } })
  }
  if (m.method === 'fail') return send({ id: m.id, error: { code: -32603, message: 'Internal error', data: { details: 'no provider' } } })
  if (m.method === 'die') process.exit(3)
  if (m.id === 'p1' && waiting.has('p1')) return send({ id: waiting.get('p1'), result: { client: m.result } })
})
`

const clients: AcpClient[] = []
function client(env: NodeJS.ProcessEnv = {}): AcpClient {
  const c = new AcpClient({
    argv: [process.execPath, '-e', AGENT],
    env: { ...process.env, ...env },
    timeoutMs: 5_000,
  })
  clients.push(c)
  return c
}

afterEach(() => {
  for (const c of clients.splice(0)) c.close()
})

describe('AcpClient', () => {
  it('initializes on the first request and returns results', async () => {
    const c = client()
    await expect(c.request('echo', { a: 1 })).resolves.toEqual({ a: 1 })
    expect(c.generation).toBe(1)
    expect(c.agent?.agentCapabilities).toEqual({ loadSession: true })
  })

  it('delivers notifications and answers agent requests', async () => {
    const c = client()
    const frames: AcpFrame[] = []
    c.subscribe((f) => {
      frames.push(f)
      if (f.method === 'session/request_permission' && f.id !== undefined)
        c.respond(f.id, { outcome: 'ok' })
    })
    await c.request('echo', {})
    expect(frames.map((f) => f.method)).toEqual(['$connected', 'session/update'])
    await expect(c.request('ask', {})).resolves.toEqual({ client: { outcome: 'ok' } })
  })

  it('carries error details into the rejection', async () => {
    await expect(client().request('fail', {})).rejects.toThrow('Internal error: no provider')
  })

  it('rejects in-flight requests when the agent exits, then restarts on the next request', async () => {
    const c = client()
    const frames: string[] = []
    c.subscribe((f) => frames.push(f.method))
    await c.request('echo', {})
    await expect(c.request('die', {})).rejects.toThrow(/outcome may be unknown/)
    expect(frames).toContain('$disconnected')
    await expect(c.request('echo', { again: true })).resolves.toEqual({ again: true })
    expect(c.generation).toBe(2)
  })

  it('refuses an agent that speaks another protocol version', async () => {
    await expect(client({ PROTO: '2' }).request('echo', {})).rejects.toThrow(/protocol 2/)
  })

  it('refuses requests after close', async () => {
    const c = client()
    c.close()
    await expect(c.request('echo', {})).rejects.toThrow(/closed/)
  })
})
