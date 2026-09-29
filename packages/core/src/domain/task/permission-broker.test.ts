import { describe, expect, it } from 'vitest'
import { InMemoryTaskStore } from './store.js'
import { TaskPermissionBroker } from './permission-broker.js'

async function taskId(): Promise<{ store: InMemoryTaskStore; id: string }> {
  const store = new InMemoryTaskStore()
  const row = await store.create({
    goal: 'park',
    executor: 'harness-session',
    agentId: 'claude',
    origin: 'api',
  })
  return { store, id: row.id }
}

describe('TaskPermissionBroker', () => {
  it('allow settles the park and records it on the row', async () => {
    const { store, id } = await taskId()
    const broker = new TaskPermissionBroker({ store, timeoutMs: 5_000 })
    const pending = broker.ask({
      taskId: id,
      requestId: 'r1',
      name: 'Bash',
      input: { command: 'ls' },
    })
    expect(broker.pendingFor(id)).toHaveLength(1)
    expect(broker.decide(id, 'r1', 'allow')).toBe(true)
    await expect(pending).resolves.toEqual({ behavior: 'allow', decision: 'allow' })
    expect(broker.decide(id, 'r1', 'deny')).toBe(false)
    const row = await store.get(id)
    expect(row?.spec.permissionDecisions).toEqual([
      expect.objectContaining({ requestId: 'r1', tool: 'Bash', decision: 'allow' }),
    ])
    expect(row?.spec.permissionDecisions).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ input: expect.anything() })]),
    )
  })

  it('denies when nobody answers, and records timeout', async () => {
    const { store, id } = await taskId()
    const broker = new TaskPermissionBroker({ store, timeoutMs: 20 })
    const answer = await broker.ask({
      taskId: id,
      requestId: 'r2',
      name: 'Edit',
      input: {},
    })
    expect(answer.behavior).toBe('deny')
    expect(answer.decision).toBe('timeout')
    expect(broker.decide(id, 'r2', 'allow')).toBe(false)
    const row = await store.get(id)
    expect(row?.spec.permissionDecisions).toEqual([
      expect.objectContaining({ requestId: 'r2', decision: 'timeout' }),
    ])
  })

  it('abort denies and does not allow a late decide', async () => {
    const { store, id } = await taskId()
    const broker = new TaskPermissionBroker({ store, timeoutMs: 5_000 })
    const ac = new AbortController()
    const pending = broker.ask({
      taskId: id,
      requestId: 'r3',
      name: 'Write',
      input: {},
      signal: ac.signal,
    })
    ac.abort()
    await expect(pending).resolves.toMatchObject({ behavior: 'deny', decision: 'deny' })
    expect(broker.decide(id, 'r3', 'allow')).toBe(false)
  })

  it('strips a forged decision log on create', async () => {
    const store = new InMemoryTaskStore()
    const row = await store.create({
      goal: 'park',
      executor: 'harness-session',
      agentId: 'claude',
      origin: 'api',
      spec: { permissionDecisions: [{ decision: 'allow' }], keep: true },
    })
    expect(row.spec).toEqual({ keep: true })
  })

  it('next() sees a prompt that is already parked', async () => {
    const { store, id } = await taskId()
    const broker = new TaskPermissionBroker({ store, timeoutMs: 5_000 })
    const pending = broker.ask({
      taskId: id,
      requestId: 'r4',
      name: 'Bash',
      input: { command: 'pwd' },
    })
    await expect(broker.next(id)).resolves.toMatchObject({ requestId: 'r4', name: 'Bash' })
    expect(broker.decide(id, 'r4', 'deny')).toBe(true)
    await pending
  })

  it('next() resolves when the prompt parks after the wait has started', async () => {
    const { store, id } = await taskId()
    const broker = new TaskPermissionBroker({ store, timeoutMs: 5_000 })
    const waiting = broker.next(id)
    const pending = broker.ask({ taskId: id, requestId: 'r5', name: 'Bash', input: {} })
    await expect(waiting).resolves.toMatchObject({ requestId: 'r5', name: 'Bash' })
    expect(broker.decide(id, 'r5', 'deny')).toBe(true)
    await pending
  })
})
