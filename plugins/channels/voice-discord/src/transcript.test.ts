import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { TranscriptLogger } from './transcript.js'

describe('TranscriptLogger', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('writes a transcript file with header and messages', () => {
    const logger = new TranscriptLogger('sess-1', tmpDir, 'aria')
    logger.addMessage('Phil', 'hello')
    logger.addMessage('rivet', 'hi back')
    logger.finalize()

    const dateDir = fs.readdirSync(tmpDir)
    expect(dateDir).toHaveLength(1)
    const files = fs.readdirSync(path.join(tmpDir, dateDir[0]))
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^\d{2}-\d{2}-\d{2}-sess-1\.md$/)

    const content = fs.readFileSync(path.join(tmpDir, dateDir[0], files[0]), 'utf8')
    expect(content).toContain('# Voice Session')
    expect(content).toContain('**Voice:** aria')
    expect(content).toContain('**Phil:** hello')
    expect(content).toContain('**rivet:** hi back')
    expect(content).toMatch(/\*\*Duration:\*\* \d+ minutes(?! \(in progress\))/)
  })

  it('marks duration as in-progress before finalize', () => {
    const logger = new TranscriptLogger('sess-2', tmpDir, 'sol')
    logger.addMessage('Phil', 'mid-session')

    const dateDir = fs.readdirSync(tmpDir)[0]
    const file = fs.readdirSync(path.join(tmpDir, dateDir))[0]
    const content = fs.readFileSync(path.join(tmpDir, dateDir, file), 'utf8')
    expect(content).toContain('(in progress)')
  })

  it('always includes Phil in participants even with no messages from him', () => {
    const logger = new TranscriptLogger('sess-3', tmpDir, 'aria')
    logger.addMessage('rivet', 'solo')
    logger.finalize()

    const dateDir = fs.readdirSync(tmpDir)[0]
    const file = fs.readdirSync(path.join(tmpDir, dateDir))[0]
    const content = fs.readFileSync(path.join(tmpDir, dateDir, file), 'utf8')
    expect(content).toMatch(/\*\*Participants:\*\*[^\n]*Phil/)
    expect(content).toMatch(/\*\*Participants:\*\*[^\n]*rivet/)
  })
})
