import { describe, expect, it, vi } from 'vitest'
import { RivetGateway } from './client.js'
import { GatewayError } from './http.js'

describe('RivetGateway.waitTask', () => {
  it('encodes the task id and forwards timeout and caller signal', async () => {
    const response = { task: { id: 'task/id', status: 'completed' } }
    const fetch = vi.fn(async () => new Response(JSON.stringify(response)))
    const client = new RivetGateway({ baseUrl: 'https://den.invalid', fetch })
    const signal = new AbortController().signal
    expect(await client.waitTask('task/id', { timeoutMs: 5000, signal })).toEqual(response)
    expect(fetch).toHaveBeenCalledWith(
      'https://den.invalid/api/tasks/task%2Fid/wait?timeoutMs=5000',
      expect.objectContaining({ method: 'GET', signal }),
    )
  })

  it('onApproval=return is opt-in on the wait query', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ approval: { requestId: 'r' } })))
    const client = new RivetGateway({ baseUrl: 'https://den.invalid', fetch })
    await client.waitTask('task-1', { onApproval: true, timeoutMs: 1000 })
    expect(fetch).toHaveBeenCalledWith(
      'https://den.invalid/api/tasks/task-1/wait?timeoutMs=1000&onApproval=return',
      expect.anything(),
    )
  })

  it('preserves deadline bodies and abort errors', async () => {
    const body = { error: 'wait deadline exceeded' }
    const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 504 }))
    const client = new RivetGateway({ baseUrl: 'https://den.invalid', fetch })
    await expect(client.waitTask('t')).rejects.toEqual(new GatewayError(504, body.error, body))
    const abort = new DOMException('cancelled', 'AbortError')
    fetch.mockRejectedValueOnce(abort)
    await expect(client.waitTask('t')).rejects.toBe(abort)
  })
})
