import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

describe('node capture scripts', () => {
  it('pull-bridge convert_cmd passes --session so event ids match ingest', () => {
    const src = readFileSync(join(ROOT, 'pull-bridge.py'), 'utf8')
    expect(src).toContain('extra.extend(["--session", session])')
    expect(src).toContain('convert_cmd(tmp_page, spool, aid, session)')
  })

  it('convert-transcript node_bin falls back to node, not python', () => {
    const src = readFileSync(join(ROOT, 'convert-transcript.py'), 'utf8')
    expect(src).toContain('shutil.which("node")')
    expect(src).not.toMatch(/sys\.executable/)
    expect(src).toContain('node not found')
  })

  it('watch refreshes the roster on an unknown id', () => {
    const src = readFileSync(join(ROOT, 'watch.mjs'), 'utf8')
    expect(src).toContain("who.agent === 'rivet-grokbot-run'")
    expect(src).toContain('makeIdentityLookup()')
    expect(src).toContain('shouldIngest')
  })
})
