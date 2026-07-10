import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionWsFrame, TranscriptWsFrame } from '@rivetos/types'
import { createTranscriptWatcher, type TranscriptWatcher } from './transcript-watch.js'

const dirs: string[] = []
let watcher: TranscriptWatcher | undefined
afterEach(() => {
  watcher?.close()
  watcher = undefined
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.GROK_HOME
  delete process.env.HERMES_HOME
})

const FAST = { debounceMs: 25, resolvePollMs: 50, safetyPollMs: 100, sessionsDirtyMs: 25 }

function claudeStore(): { base: string; dir: string } {
  const base = mkdtempSync(join(tmpdir(), 'tw-claude-'))
  dirs.push(base)
  const dir = join(base, 'projects', '-home-rivet')
  mkdirSync(dir, { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = base
  // keep grok/hermes probes away from the real home dir
  process.env.GROK_HOME = join(base, 'no-grok')
  process.env.HERMES_HOME = join(base, 'no-hermes')
  return { base, dir }
}

function userLine(text: string): string {
  return JSON.stringify({ type: 'user', message: { content: text } }) + '\n'
}

function assistantLine(text: string): string {
  return (
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n'
  )
}

async function until<T>(probe: () => T | undefined, ms = 3_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = probe()
    if (v !== undefined) return v
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 20))
  }
}

const transcripts = (frames: SessionWsFrame[]): TranscriptWsFrame[] =>
  frames.filter((f): f is TranscriptWsFrame => f.kind === 'transcript')

describe('createTranscriptWatcher', () => {
  it('emits a full snapshot on watch, then deltas as the store grows', async () => {
    const { dir } = claudeStore()
    const id = 'aaaaaaaa-0000-0000-0000-000000000001'
    const file = join(dir, `${id}.jsonl`)
    writeFileSync(file, userLine('hello') + assistantLine('hi'))

    const frames: SessionWsFrame[] = []
    watcher = createTranscriptWatcher((f) => frames.push(f), FAST)
    watcher.watch(id)

    const snap = await until(() => transcripts(frames).find((f) => f.from === 0))
    expect(snap.command).toBe('claude')
    expect(snap.total).toBe(2)
    expect(snap.turns.map((t) => t.text)).toEqual(['hello', 'hi'])

    // Store grows (a new turn lands) → a delta frame covering just the tail.
    appendFileSync(file, userLine('second question'))
    const delta = await until(() =>
      transcripts(frames).find((f) => f.rev === snap.rev + 1),
    )
    expect(delta.from).toBe(2)
    expect(delta.turns.map((t) => t.text)).toEqual(['second question'])
    expect(delta.total).toBe(3)
  })

  it('mid-turn growth restates the in-flight assistant turn, not the prefix', async () => {
    const { dir } = claudeStore()
    const id = 'aaaaaaaa-0000-0000-0000-000000000002'
    const file = join(dir, `${id}.jsonl`)
    writeFileSync(file, userLine('do a thing') + assistantLine('working on it'))

    const frames: SessionWsFrame[] = []
    watcher = createTranscriptWatcher((f) => frames.push(f), FAST)
    watcher.watch(id)
    const snap = await until(() => transcripts(frames).find((f) => f.from === 0))

    // The same logical turn gains a second text block → the assistant turn at
    // index 1 CHANGES (text grows), so the delta starts there.
    appendFileSync(file, assistantLine('done, here is the result'))
    const delta = await until(() => transcripts(frames).find((f) => f.rev === snap.rev + 1))
    expect(delta.from).toBe(1)
    expect(delta.turns).toHaveLength(1)
    expect(delta.turns[0].text).toBe('working on it\n\ndone, here is the result')
  })

  it('fresh session: empty snapshot first, real snapshot once the store file appears', async () => {
    const { dir } = claudeStore()
    const id = 'aaaaaaaa-0000-0000-0000-000000000003'

    const frames: SessionWsFrame[] = []
    watcher = createTranscriptWatcher((f) => frames.push(f), FAST)
    watcher.watch(id)

    // no store yet → explicit empty snapshot (client falls back to ring/memory)
    const empty = await until(() => transcripts(frames).find((f) => f.command === ''))
    expect(empty.total).toBe(0)

    // first turn lands → the resolve poll finds the file and pushes it
    writeFileSync(join(dir, `${id}.jsonl`), userLine('first ever turn'))
    const real = await until(() => transcripts(frames).find((f) => f.command === 'claude'))
    expect(real.turns.map((t) => t.text)).toEqual(['first ever turn'])
  })

  it('sync() re-emits a full snapshot; unwatch stops the flow', async () => {
    const { dir } = claudeStore()
    const id = 'aaaaaaaa-0000-0000-0000-000000000004'
    const file = join(dir, `${id}.jsonl`)
    writeFileSync(file, userLine('hello'))

    const frames: SessionWsFrame[] = []
    watcher = createTranscriptWatcher((f) => frames.push(f), FAST)
    watcher.watch(id)
    const snap = await until(() => transcripts(frames).find((f) => f.from === 0))

    watcher.sync(id)
    const resnap = await until(() =>
      transcripts(frames).find((f) => f.rev > snap.rev && f.from === 0),
    )
    expect(resnap.turns.map((t) => t.text)).toEqual(['hello'])

    watcher.unwatch(id)
    const count = transcripts(frames).length
    appendFileSync(file, userLine('into the void'))
    await new Promise((r) => setTimeout(r, 300))
    expect(transcripts(frames).length).toBe(count) // no new frames after unwatch
  })

  it('recovers a deleted-then-recreated store via re-resolution (rotation)', async () => {
    const { dir } = claudeStore()
    const id = 'aaaaaaaa-0000-0000-0000-000000000006'
    const file = join(dir, `${id}.jsonl`)
    writeFileSync(file, userLine('before rotation'))

    const frames: SessionWsFrame[] = []
    watcher = createTranscriptWatcher((f) => frames.push(f), FAST)
    watcher.watch(id)
    const snap = await until(() => transcripts(frames).find((f) => f.command === 'claude'))

    // Rotate: delete the store, then recreate it with new content. The fs
    // watcher errors / the safety poll ENOENTs — both must land back on the
    // resolve poll (grok review: the error path used to orphan the session).
    rmSync(file)
    await new Promise((r) => setTimeout(r, 250))
    writeFileSync(file, userLine('after rotation') + assistantLine('recovered'))
    const recovered = await until(
      () =>
        transcripts(frames).find(
          (f) => f.rev > snap.rev && f.turns.some((t) => t.text === 'recovered'),
        ),
      5_000,
    )
    expect(recovered.turns.some((t) => t.text === 'after rotation' || t.text === 'recovered')).toBe(
      true,
    )
  })

  it('store-dir changes emit a debounced sessions-dirty for the drawer', async () => {
    const { dir } = claudeStore()
    const frames: SessionWsFrame[] = []
    watcher = createTranscriptWatcher((f) => frames.push(f), FAST)
    writeFileSync(join(dir, 'bbbbbbbb-0000-0000-0000-000000000005.jsonl'), userLine('new session'))
    await until(() => frames.find((f) => f.kind === 'sessions-dirty'))
  })
})
