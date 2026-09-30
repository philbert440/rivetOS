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

  it('denyPending settles only the killed task, and a late allow does not record', async () => {
    const { store, id } = await taskId()
    const other = await store.create({
      goal: 'park',
      executor: 'harness-session',
      agentId: 'claude',
      origin: 'api',
    })
    const broker = new TaskPermissionBroker({ store, timeoutMs: 5_000 })
    const killed = broker.ask({
      taskId: id,
      requestId: 'r6',
      name: 'Bash',
      input: { command: 'echo parked' },
    })
    const sibling = broker.ask({
      taskId: id,
      requestId: 'r7',
      name: 'Edit',
      input: { file_path: 'a.ts' },
    })
    const kept = broker.ask({
      taskId: other.id,
      requestId: 'r8',
      name: 'Bash',
      input: { command: 'pwd' },
    })
    expect(broker.denyPending(id)).toBe(2)
    await expect(killed).resolves.toMatchObject({ behavior: 'deny', decision: 'deny' })
    await expect(sibling).resolves.toMatchObject({
      behavior: 'deny',
      message: 'spawn killed',
    })
    expect(broker.decide(id, 'r6', 'allow')).toBe(false)
    expect(broker.pendingFor(id)).toHaveLength(0)
    expect(broker.pendingFor(other.id)).toHaveLength(1)
    const row = await store.get(id)
    expect(row?.spec.permissionDecisions).toEqual([
      expect.objectContaining({ requestId: 'r6', decision: 'deny' }),
      expect.objectContaining({ requestId: 'r7', decision: 'deny' }),
    ])
    expect(broker.decide(other.id, 'r8', 'deny')).toBe(true)
    await kept
  })

  it('a slow or failed audit write does not delay or change the answer', async () => {
    const { store, id } = await taskId()
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const orig = store.appendPermissionDecision.bind(store)
    let calls = 0
    store.appendPermissionDecision = (rowId, decision) => {
      calls += 1
      if (calls === 1) return gate.then(() => orig(rowId, decision))
      return Promise.reject(new Error('audit disk full'))
    }
    const broker = new TaskPermissionBroker({ store, timeoutMs: 5_000 })
    const slow = broker.ask({
      taskId: id,
      requestId: 'slow',
      name: 'Bash',
      input: { command: 'ls' },
    })
    expect(broker.decide(id, 'slow', 'allow')).toBe(true)
    await expect(slow).resolves.toEqual({ behavior: 'allow', decision: 'allow' })
    expect((await store.get(id))?.spec.permissionDecisions).toBeUndefined()
    release()
    await gate
    expect((await store.get(id))?.spec.permissionDecisions).toEqual([
      expect.objectContaining({
        requestId: 'slow',
        tool: 'Bash',
        decision: 'allow',
      }),
    ])

    const failed = broker.ask({
      taskId: id,
      requestId: 'boom',
      name: 'Edit',
      input: {},
    })
    expect(broker.decide(id, 'boom', 'allow')).toBe(true)
    await expect(failed).resolves.toEqual({ behavior: 'allow', decision: 'allow' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const recorded = (await store.get(id))?.spec.permissionDecisions as
      | Array<{ requestId: string }>
      | undefined
    expect(recorded?.map((row) => row.requestId)).toEqual(['slow'])
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
