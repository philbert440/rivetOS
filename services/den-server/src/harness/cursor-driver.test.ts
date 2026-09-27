import { describe, expect, it } from 'vitest'
import { HarnessError, type SessionId } from '@rivetos/types'
import type { HarnessSession } from '../term/harness-sessions.js'
import { CursorDriver, type CursorPtyHost, type CursorStoreHost } from './cursor-driver.js'

const NAT = 'a1b2c3d4-1111-4222-8333-444455556666'
const SID = `cursor:${NAT}` as SessionId

function makeDriver(rows: HarnessSession[] = []) {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const sessions = new Set(rows.map((r) => r.id))
  const spawns: { key?: string; session?: string; resume?: string }[] = []
  const live = new Map<string, string>()
  const pty: CursorPtyHost = {
    spawn: (key, _cols, _rows, _remote, session, resume) => {
      spawns.push({ key, session, resume })
      const id = `pty-${String(spawns.length)}`
      if (session) live.set(session, id)
      return { id, denSession: session ?? id }
    },
    ptyForSession: (denSession) => live.get(denSession),
    inject: () => true,
  }
  const store: CursorStoreHost = {
    list: () => Promise.resolve([...byId.values()]),
    describe: (id) => Promise.resolve(byId.get(id)),
    exists: (id) => sessions.has(id),
    transcript: () => Promise.resolve({ turns: [] }),
  }
  const driver = new CursorDriver({ store, pty: () => Promise.resolve(pty) })
  return { driver, spawns }
}

describe('CursorDriver', () => {
  it('refuses startSession because agent cannot pin a new chat id', async () => {
    const { driver } = makeDriver()
    await expect(driver.startSession()).rejects.toBeInstanceOf(HarnessError)
    await expect(driver.startSession()).rejects.toMatchObject({
      code: 'capability_unsupported',
    })
  })

  it('resumes with the native id in a room of that name', async () => {
    const { driver, spawns } = makeDriver([
      { id: NAT, command: 'cursor', title: 't', updatedAt: 1 },
    ])
    const summary = await driver.resumeSession(SID)
    expect(summary.sessionId).toBe(SID)
    expect(spawns).toEqual([{ key: 'cursor', session: NAT, resume: NAT }])
  })

  it('rejects a chat the store has never heard of', async () => {
    const { driver } = makeDriver()
    await expect(driver.resumeSession(SID)).rejects.toMatchObject({
      code: 'invalid_session_id',
    })
  })

  it('formats cursor:<uuid>', () => {
    expect(CursorDriver.sessionId(NAT)).toBe(SID)
  })
})
