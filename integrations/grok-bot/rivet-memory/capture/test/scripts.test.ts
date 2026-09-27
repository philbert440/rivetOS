import { execFileSync } from 'node:child_process'
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
