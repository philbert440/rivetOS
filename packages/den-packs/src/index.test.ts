import { mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { validatePack, pngSize } from './index.js'

const here = dirname(fileURLToPath(import.meta.url))
const DEFAULT_PACK = join(here, '..', 'packs', 'default')

// minimal valid 1x1 transparent PNG
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

const tmp: string[] = []
afterAll(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })))

/** Copy the default pack to a temp dir and mutate its manifest. */
function brokenPack(mutate: (m: Record<string, unknown>) => void): string {
  const dir = mkdtempSync(join(tmpdir(), 'den-pack-'))
  tmp.push(dir)
  cpSync(DEFAULT_PACK, dir, { recursive: true })
  const manifestPath = join(dir, 'pack.json')
  const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  mutate(m)
  writeFileSync(manifestPath, JSON.stringify(m))
  return dir
}

describe('default pack', () => {
  it('validates clean', () => {
    const res = validatePack(DEFAULT_PACK)
    expect(res.errors).toEqual([])
    expect(res.ok).toBe(true)
    expect(res.manifest?.name).toBe('default')
  })
})

describe('pngSize', () => {
  it('reads IHDR dimensions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'den-png-'))
    tmp.push(dir)
    writeFileSync(join(dir, 'p.png'), PNG_1X1)
    expect(pngSize(join(dir, 'p.png'))).toEqual({ w: 1, h: 1 })
    writeFileSync(join(dir, 'notpng.png'), 'hello')
    expect(pngSize(join(dir, 'notpng.png'))).toBeNull()
  })
})

describe('validatePack failures', () => {
  it('rejects a missing directory / manifest', () => {
    const res = validatePack('/nonexistent-den-pack')
    expect(res.ok).toBe(false)
    expect(res.errors[0]).toMatch(/pack.json not found/)
  })

  it('rejects wrong spec version', () => {
    const res = validatePack(brokenPack((m) => (m.spec = 2)))
    expect(res.errors.join()).toMatch(/spec must be 1/)
  })

  it('rejects uncovered activities', () => {
    const res = validatePack(
      brokenPack((m) => {
        const c = m.character as { activities: Record<string, string> }
        delete c.activities.sleeping
      }),
    )
    expect(res.errors.join()).toMatch(/activity not covered: sleeping/)
  })

  it('rejects activity mapped to unknown pose', () => {
    const res = validatePack(
      brokenPack((m) => {
        ;(m.character as { activities: Record<string, string> }).activities.idle = 'moonwalk'
      }),
    )
    expect(res.errors.join()).toMatch(/maps to unknown pose: moonwalk/)
  })

  it('rejects missing frame files', () => {
    const res = validatePack(
      brokenPack((m) => {
        ;(m.character as { poses: Record<string, { frames: string[] }> }).poses.idle.frames.push(
          'sprites/char/idle_f9.png',
        )
      }),
    )
    expect(res.errors.join()).toMatch(/file not found: sprites\/char\/idle_f9.png/)
  })

  it('rejects frame size mismatches', () => {
    const dir = brokenPack(() => {})
    writeFileSync(join(dir, 'sprites', 'char', 'idle_f1.png'), PNG_1X1)
    const res = validatePack(dir)
    expect(res.errors.join()).toMatch(/frame size mismatch/)
  })

  it('rejects path escapes', () => {
    const res = validatePack(
      brokenPack((m) => {
        ;(m.furniture as { src: string }[])[0].src = '../../etc/passwd'
      }),
    )
    expect(res.errors.join()).toMatch(/escapes the pack directory/)
  })

  it('rejects layout entries for unknown furniture', () => {
    const res = validatePack(
      brokenPack((m) => {
        ;(m.layout as Record<string, unknown>).jacuzzi = { x: 1, y: 2, h: 3 }
      }),
    )
    expect(res.errors.join()).toMatch(/layout places unknown furniture: jacuzzi/)
  })

  it('rejects stations anchored to unknown furniture and missing stations', () => {
    const res = validatePack(
      brokenPack((m) => {
        const st = m.stations as Record<string, unknown>
        st.sleeping = { furn: 'hammock' }
        delete st.idle
      }),
    )
    expect(res.errors.join()).toMatch(/unknown furniture anchor: hammock/)
    expect(res.errors.join()).toMatch(/station not defined for activity: idle/)
  })

  it('returns errors (never throws) on structurally malformed manifests', () => {
    const cases: ((m: Record<string, unknown>) => void)[] = [
      (m) => ((m.character as { poses: Record<string, unknown> }).poses.idle = null),
      (m) => ((m.character as { poses: Record<string, unknown> }).poses.idle = { frames: [42], frameMs: 0 }),
      (m) => ((m.stations as Record<string, unknown>).idle = null),
      (m) => ((m.layout as Record<string, unknown>).desk = null),
      (m) => (m.furniture = {}),
      (m) => (m.furniture = [null, 7]),
      (m) => (m.character = 'nope'),
    ]
    for (const mutate of cases) {
      const res = validatePack(brokenPack(mutate))
      expect(res.ok).toBe(false)
      expect(res.errors.length).toBeGreaterThan(0)
    }
  })

  it('rejects out-of-bounds and degenerate functional rects', () => {
    const oob = validatePack(
      brokenPack((m) => {
        const f = (m.furniture as { id: string; screen?: unknown }[]).find((x) => x.screen)!
        f.screen = { x: 99999, y: 99999, w: 5, h: 5 }
      }),
    )
    expect(oob.errors.join()).toMatch(/outside image/)
    const neg = validatePack(
      brokenPack((m) => {
        const f = (m.furniture as { id: string; screen?: unknown }[]).find((x) => x.screen)!
        f.screen = { x: -10, y: 0, w: -220, h: 5 }
      }),
    )
    expect(neg.errors.join()).toMatch(/x,y >= 0 and w,h > 0/)
  })

  it('rejects non-PNG furniture art', () => {
    const dir = brokenPack(() => {})
    const m = JSON.parse(readFileSync(join(dir, 'pack.json'), 'utf8')) as {
      furniture: { src: string }[]
    }
    writeFileSync(join(dir, m.furniture[0].src), 'not a png')
    const res = validatePack(dir)
    expect(res.errors.join()).toMatch(/not a PNG/)
  })

  it('rejects attachments outside the frame image', () => {
    const res = validatePack(
      brokenPack((m) => {
        const poses = (m.character as { poses: Record<string, { attachments?: unknown }> }).poses
        poses[Object.keys(poses)[0]].attachments = { zzz: { x: 100000, y: 5 } }
      }),
    )
    expect(res.errors.join()).toMatch(/outside frame/)
  })

  it('rejects tool overrides to unknown poses', () => {
    const res = validatePack(
      brokenPack((m) => {
        ;(m.character as { tools: Record<string, string> }).tools = { Bash: 'jackhammer' }
      }),
    )
    expect(res.errors.join()).toMatch(/tool override Bash maps to unknown pose/)
  })
})

describe('fonts validation', () => {
  type FontEntry = { family: string; src: string; roles: string[]; license?: string }
  const fontsOf = (m: Record<string, unknown>): FontEntry[] => m.fonts as FontEntry[]

  it('accepts the default pack fonts entry', () => {
    const res = validatePack(DEFAULT_PACK)
    expect(res.ok).toBe(true)
    expect(res.warnings).toEqual([])
    expect(res.manifest?.fonts?.[0]?.family).toBe('Emoticomic')
  })

  it('rejects a non-font file extension', () => {
    const res = validatePack(
      brokenPack((m) => {
        fontsOf(m)[0].src = 'pack.json' // exists, but not a font
      }),
    )
    expect(res.errors.join()).toMatch(/not a font file .+: pack.json/)
  })

  it('rejects a missing font file', () => {
    const res = validatePack(
      brokenPack((m) => {
        fontsOf(m)[0].src = 'fonts/ghost.woff2'
      }),
    )
    expect(res.errors.join()).toMatch(/font Emoticomic: file not found: fonts\/ghost.woff2/)
  })

  it('rejects empty or missing roles', () => {
    const res = validatePack(
      brokenPack((m) => {
        fontsOf(m)[0].roles = []
      }),
    )
    expect(res.errors.join()).toMatch(/font Emoticomic: roles must be a non-empty array/)
  })

  it('warns (not errors) on unknown roles — forward compat', () => {
    const res = validatePack(
      brokenPack((m) => {
        fontsOf(m)[0].roles = ['board', 'marquee']
      }),
    )
    expect(res.ok).toBe(true)
    expect(res.warnings.join()).toMatch(/font Emoticomic: unknown role: marquee/)
  })

  it('warns on a missing license file reference and on omitted license', () => {
    const missing = validatePack(
      brokenPack((m) => {
        fontsOf(m)[0].license = 'fonts/ghost-LICENSE.txt'
      }),
    )
    expect(missing.errors.join()).toMatch(/font Emoticomic license: file not found/)
    const omitted = validatePack(
      brokenPack((m) => {
        delete fontsOf(m)[0].license
      }),
    )
    expect(omitted.ok).toBe(true)
    expect(omitted.warnings.join()).toMatch(/font Emoticomic: no license file/)
  })

  it('rejects duplicate font families', () => {
    const res = validatePack(
      brokenPack((m) => {
        const fonts = fontsOf(m)
        fonts.push({ ...fonts[0] })
      }),
    )
    expect(res.errors.join()).toMatch(/duplicate font family: Emoticomic/)
  })
})

// Golden: the default pack manifest is itself the reference fixture — lock its
// shape so accidental edits to pack.json surface in review.
describe('golden manifest', () => {
  it('default pack manifest snapshot', () => {
    const res = validatePack(DEFAULT_PACK)
    expect(res.manifest).toMatchSnapshot()
  })
})
