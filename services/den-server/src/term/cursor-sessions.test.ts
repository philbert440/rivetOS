import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cursorProjectSlug,
  describeCursorSession,
  harnessSessionExists,
  listHarnessSessions,
  newestCursorSessionAfter,
  readCursorTranscript,
  readHarnessTranscript,
  resolveHarnessStore,
  setCursorHomeForTest,
} from './harness-sessions.js'

const ID = 'a1b2c3d4-1111-4222-8333-444455556666'
const dirs: string[] = []

afterEach(() => {
  setCursorHomeForTest()
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

function writeChat(home: string, slug: string, id: string, lines: string, mtimeMs: number): string {
  const dir = join(home, 'projects', slug, 'agent-transcripts', id)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${id}.jsonl`)
  writeFileSync(file, lines.endsWith('\n') ? lines : `${lines}\n`)
  const sec = mtimeMs / 1000
  utimesSync(file, sec, sec)
  return file
}

describe('cursor transcripts', () => {
  it('slugs a workspace path the way Cursor names project dirs', () => {
    expect(cursorProjectSlug('/home/phil/Work')).toBe('home-phil-Work')
  })

  it('lists a chat, describes it, and folds the transcript', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cursor-store-'))
    dirs.push(home)
    setCursorHomeForTest(home)
    const file = writeChat(
      home,
      'home-phil-Work',
      ID,
      JSON.stringify({
        role: 'user',
        message: { content: [{ type: 'text', text: 'show cursor in rivethub' }] },
      }),
      1_700_000_100_000,
    )
    const listed = await listHarnessSessions(['cursor'])
    expect(listed.map((s) => s.id)).toEqual([ID])
    expect(listed[0]).toMatchObject({
      command: 'cursor',
      title: 'show cursor in rivethub',
    })
    expect(await describeCursorSession(ID)).toMatchObject({ id: ID, command: 'cursor' })
    expect(harnessSessionExists('cursor', ID)).toBe(true)
    expect(harnessSessionExists('cursor', '../x')).toBe(false)
    const transcript = await readCursorTranscript(ID)
    expect(transcript.command).toBe('cursor')
    expect(transcript.turns[0]?.text).toBe('show cursor in rivethub')
    expect((await readHarnessTranscript(`cursor:${ID}`)).command).toBe('cursor')
    expect(await resolveHarnessStore(`cursor:${ID}`)).toEqual({ command: 'cursor', path: file })
  })

  it('picks the newest transcript in a workspace modified after a cutoff', () => {
    const home = mkdtempSync(join(tmpdir(), 'cursor-newest-'))
    dirs.push(home)
    setCursorHomeForTest(home)
    const older = 'bbbbbbbb-1111-4222-8333-444455556666'
    writeChat(home, 'home-phil-Work', older, '{"role":"user","message":{"content":[]}}', 1_000)
    writeChat(home, 'home-phil-Work', ID, '{"role":"user","message":{"content":[]}}', 5_000)
    expect(newestCursorSessionAfter('/home/phil/Work', 2_000)).toBe(ID)
    expect(newestCursorSessionAfter('/home/phil/Work', 9_000)).toBeUndefined()
    expect(newestCursorSessionAfter('/other', 0)).toBeUndefined()
  })
})
