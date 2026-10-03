/**
 * parseTranscript: the session cwd comes from ordinary transcript entries
 * (not only pr-link), first seen wins, and is null when no entry has one.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseTranscript } from './transcript-capture.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function transcript(lines: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ros-cc-cwd-'))
  dirs.push(dir)
  const file = join(dir, 's.jsonl')
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return file
}

const user = (cwd: string | undefined, text: string) => ({
  type: 'user',
  sessionId: 'sess-1',
  uuid: `u-${text}`,
  timestamp: '2026-10-02T12:00:00.000Z',
  ...(cwd === undefined ? {} : { cwd }),
  message: { role: 'user', content: text },
})

describe('parseTranscript cwd', () => {
  it('reads cwd from user/assistant entries with no pr-link present', () => {
    const parsed = parseTranscript(transcript([user('/srv/code/rivetos', 'hello')]))
    expect(parsed.cwd).toBe('/srv/code/rivetos')
    expect(parsed.prUrl).toBeNull()
  })

  it('first seen wins when the session changes directory', () => {
    const parsed = parseTranscript(
      transcript([user('/srv/code/a', 'one'), user('/srv/code/b', 'two')]),
    )
    expect(parsed.cwd).toBe('/srv/code/a')
  })

  it('an empty-string cwd on the first entry does not suppress a later real one', () => {
    const parsed = parseTranscript(transcript([user('', 'one'), user('/srv/code/b', 'two')]))
    expect(parsed.cwd).toBe('/srv/code/b')
    const spaces = parseTranscript(transcript([user('   ', 'one'), user('/srv/code/c', 'two')]))
    expect(spaces.cwd).toBe('/srv/code/c')
  })

  it('is null when no entry carries a cwd', () => {
    expect(parseTranscript(transcript([user(undefined, 'hello')])).cwd).toBeNull()
  })

  it('still takes the PR url from pr-link entries', () => {
    const parsed = parseTranscript(
      transcript([
        { type: 'pr-link', prUrl: 'https://example.com/pr/1', cwd: '/srv/code/x' },
        user('/srv/code/y', 'hi'),
      ]),
    )
    expect(parsed.prUrl).toBe('https://example.com/pr/1')
    expect(parsed.cwd).toBe('/srv/code/x')
  })
})
