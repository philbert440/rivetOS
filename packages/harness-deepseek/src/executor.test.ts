import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  DeepSeekHarnessExecutor,
  DEEPSEEK_HARNESS_ID,
  canonicalDeepseekSessionId,
} from './executor.js'

const NAT = 'session-86ffe759-cd7b-49a7-955d-c282631a935d'

describe('canonicalDeepseekSessionId', () => {
  it('adopts a CLI-minted native id onto deepseek-harness:<native>', () => {
    expect(canonicalDeepseekSessionId(NAT)).toBe(`${DEEPSEEK_HARNESS_ID}:${NAT}`)
  })

  it('passes an already-canonical id through', () => {
    const sid = `${DEEPSEEK_HARNESS_ID}:${NAT}`
    expect(canonicalDeepseekSessionId(sid)).toBe(sid)
  })

  it('returns undefined for empty / missing', () => {
    expect(canonicalDeepseekSessionId(undefined)).toBeUndefined()
    expect(canonicalDeepseekSessionId('')).toBeUndefined()
  })

  it('passes a codec-rejected id through rather than dropping it', () => {
    // Surrounding whitespace makes formatSessionId throw (the composed
    // SessionId would not trim-equal itself). A breadcrumb beats none.
    expect(canonicalDeepseekSessionId('  spaced  ')).toBe('  spaced  ')
  })
})

describe('DeepSeekHarnessExecutor', () => {
  it('registers under the deepseek-harness id', () => {
    const exe = new DeepSeekHarnessExecutor({ binary: 'dsh' })
    expect(exe.name).toBe('deepseek-harness')
    expect(DEEPSEEK_HARNESS_ID).toBe('deepseek-harness')
  })

  it('fresh spawn is --profile tui; resume adds --resume after it', () => {
    const binary = fakeScript('#!/usr/bin/env bash\nexit 0\n')
    const exe = new DeepSeekHarnessExecutor({ binary, killGraceMs: 50 })
    const fresh = exe.spawnFresh()
    expect(fresh.spawned.args).toEqual(['--profile', 'tui'])
    const resumed = exe.resume(NAT)
    expect(resumed.args).toEqual(['--profile', 'tui', '--resume', NAT])
    fresh.spawned.kill()
    resumed.kill()
  })

  it('adopts the single new session dir the CLI minted', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home-'))
    scriptDirs.push(home)
    const binary = fakeScript('#!/usr/bin/env bash\nexit 0\n')
    const exe = new DeepSeekHarnessExecutor({ binary, dshHome: home })
    const before = new Set<string>()
    const dir = path.join(home, 'sessions', 'home-rivet-workspace', NAT)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'session.jsonl.zstd'), '')
    expect(exe.adoptMintedId(before)).toBe(NAT)
    expect(canonicalDeepseekSessionId(exe.adoptMintedId(before))).toBe(
      `deepseek-harness:${NAT}`,
    )
  })

  it('refuses to guess when zero or two new ids appeared', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home-'))
    scriptDirs.push(home)
    const exe = new DeepSeekHarnessExecutor({ binary: 'dsh', dshHome: home })
    expect(exe.adoptMintedId(new Set())).toBeUndefined()
    for (const id of [
      'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ]) {
      fs.mkdirSync(path.join(home, 'sessions', 'wd', id), { recursive: true })
    }
    expect(exe.adoptMintedId(new Set())).toBeUndefined()
  })
})

const scriptDirs: string[] = []
afterAll(() => {
  for (const dir of scriptDirs) fs.rmSync(dir, { recursive: true, force: true })
})

function fakeScript(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-exe-'))
  scriptDirs.push(dir)
  const file = path.join(dir, 'dsh')
  fs.writeFileSync(file, body, { mode: 0o755 })
  return file
}
