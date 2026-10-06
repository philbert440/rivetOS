import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findCoworkTask, listCoworkTasks, readCoworkTurns, setCoworkRootsForTest } from './cowork-store.js'

describe('cowork store', () => {
  afterEach(() => {
    setCoworkRootsForTest(undefined)
  })

  it('lists a task from metadata and reads the sibling transcript', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cowork-store-'))
    const sessions = join(root, 'local-agent-mode-sessions')
    const id = '22222222-2222-2222-2222-222222222222'
    const taskDir = join(sessions, 'local_task')
    const projects = join(taskDir, '.claude', 'projects', 'slug')
    mkdirSync(projects, { recursive: true })
    writeFileSync(
      join(sessions, 'local_task.json'),
      JSON.stringify({
        cliSessionId: id,
        title: 'Crate',
        cwd: `${taskDir}/outputs`,
        createdAt: 1_700_000_000_000,
        lastActivityAt: 1_700_000_050_000,
      }),
    )
    writeFileSync(
      join(projects, `${id}.jsonl`),
      [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'pack it' } }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'packed' } }),
        '',
      ].join('\n'),
    )
    setCoworkRootsForTest([root])
    const tasks = await listCoworkTasks()
    expect(tasks.map((t) => t.cliSessionId)).toEqual([id])
    expect(tasks[0]?.title).toBe('Crate')
    expect(tasks[0]?.cwd).toContain('/outputs')
    const turns = await readCoworkTurns(id)
    expect(turns.map((t) => t.text)).toEqual(['pack it', 'packed'])
    expect(await findCoworkTask('../etc')).toBeUndefined()
  })

  it('reads the Desktop 2.19675.1 task directory and isArchived', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cowork-store-'))
    const org = join(root, 'local-agent-mode-sessions', 'acct', 'org')
    const taskUuid = 'af1d0ad3-ab84-4a4d-8c7e-d344b9e7ee17'
    const id = '44444444-4444-4444-4444-444444444444'
    const taskDir = join(org, taskUuid.slice(0, 8))
    const projects = join(taskDir, '.claude', 'projects', 'session')
    mkdirSync(projects, { recursive: true })
    writeFileSync(
      join(org, `local_${taskUuid}.json`),
      JSON.stringify({
        sessionId: `local_${taskUuid}`,
        cliSessionId: id,
        title: 'Real layout',
        cwd: `${taskDir}/outputs`,
        isArchived: true,
        createdAt: 1_700_000_000_000,
        lastActivityAt: 1_700_000_050_000,
      }),
    )
    writeFileSync(
      join(projects, `${id}.jsonl`),
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'from desktop' } })}\n`,
    )
    setCoworkRootsForTest([root])
    const tasks = await listCoworkTasks()
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.archived).toBe(true)
    expect(tasks[0]?.transcriptPath).toBe(join(projects, `${id}.jsonl`))
    expect((await readCoworkTurns(id)).map((turn) => turn.text)).toEqual(['from desktop'])
  })

  it('keeps the newest metadata when the same session is listed twice', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cowork-store-'))
    const sessions = join(root, 'local-agent-mode-sessions')
    mkdirSync(sessions, { recursive: true })
    const id = '33333333-3333-3333-3333-333333333333'
    writeFileSync(
      join(sessions, 'local_old.json'),
      JSON.stringify({ cliSessionId: id, title: 'old', createdAt: 1_000, lastActivityAt: 1_000 }),
    )
    writeFileSync(
      join(sessions, 'local_new.json'),
      JSON.stringify({ cliSessionId: id, title: 'new', createdAt: 1_000, lastActivityAt: 5_000 }),
    )
    setCoworkRootsForTest([root])
    const tasks = await listCoworkTasks()
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.title).toBe('new')
    expect(await readCoworkTurns(id)).toEqual([])
  })
})
