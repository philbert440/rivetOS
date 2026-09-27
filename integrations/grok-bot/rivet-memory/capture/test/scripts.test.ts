import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

function loadPyFn(file: string, snippet: string): string {
  return execFileSync(
    'python3',
    [
      '-c',
      [
        'import importlib.util, sys',
        'p = sys.argv[1]',
        'spec = importlib.util.spec_from_file_location("mod", p)',
        'mod = importlib.util.module_from_spec(spec)',
        'spec.loader.exec_module(mod)',
        snippet,
      ].join('\n'),
      file,
    ],
    { encoding: 'utf8' },
  )
}

describe('node capture scripts', () => {
  it('pull-bridge convert_cmd passes --session so event ids match ingest', () => {
    const out = loadPyFn(
      join(ROOT, 'pull-bridge.py'),
      'print(" ".join(mod.convert_cmd("/tmp/page.txt", "/tmp/out.jsonl", "agent-id", "grokbot-bob-v3")))',
    )
    expect(out).toContain('--session')
    expect(out).toContain('grokbot-bob-v3')
    expect(out).toContain('convert')
  })

  it('pull-bridge parse_page calls the CLI parser and returns header + records', () => {
    const page = join(HERE, 'fixtures', 'page-bob-4110-4148.txt')
    const viaEnv = execFileSync(
      'python3',
      [
        '-c',
        [
          'import importlib.util, pathlib, sys',
          'p = sys.argv[1]',
          'page = sys.argv[2]',
          'spec = importlib.util.spec_from_file_location("mod", p)',
          'mod = importlib.util.module_from_spec(spec)',
          'spec.loader.exec_module(mod)',
          'hdr, a, b, total, recs, _ = mod.parse_page(pathlib.Path(page).read_text())',
          'print(hdr.get("id"))',
          'print(a, b, total, len(recs))',
          'print(" ".join(mod.parse_cmd()))',
        ].join('\n'),
        join(ROOT, 'pull-bridge.py'),
        page,
      ],
      { encoding: 'utf8' },
    )
    const lines = viaEnv.trim().split('\n')
    expect(lines[0]).toBe('00df02ea-4f5f-4d3e-945a-864e1c9c78dc')
    const [a, b, total, n] = lines[1].split(' ').map(Number)
    expect(n).toBe(b - a + 1)
    expect(total).toBeGreaterThan(0)
    expect(lines[2]).toContain('parse-page')
  })

  it('ingest.mjs no longer exposes search/browse/stats', () => {
    const src = readFileSync(join(ROOT, 'ingest.mjs'), 'utf8')
    expect(src).toContain('was removed')
    expect(src).not.toContain('memory.search')
    expect(src).not.toContain('getSessionHistory')
    expect(src).not.toContain('cmd === \'stats\'')
  })

  it('discover-models.mjs is a thin wrapper over dist/identity.js', () => {
    const src = readFileSync(join(ROOT, 'discover-models.mjs'), 'utf8')
    expect(src).toContain('dist/identity.js')
    expect(src).not.toContain('DEFAULT_EXCLUDE_NAMES')
    expect(src).not.toContain('readdirSync(AGENTS)')
  })

  it('convert-transcript node_bin falls back to node, not python', () => {
    const out = loadPyFn(
      join(ROOT, 'convert-transcript.py'),
      [
        'print(mod.node_bin())',
        'print(" ".join(mod.convert_cmd("/tmp/in.jsonl", "/tmp/out.jsonl", "id", "sess")))',
      ].join('\n'),
    )
    const [nodeBin] = out.trim().split('\n')
    expect(nodeBin).not.toMatch(/python/)
    expect(out).toContain('--session')
    expect(out).toContain('sess')
  })
})
