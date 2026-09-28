import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { coalesceDashArgs } from '../src/argv.js'
import { BOB_ID } from './ids.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const BOB = BOB_ID

function ensureDist() {
  if (existsSync(join(ROOT, 'dist', 'cli.js'))) return
  execFileSync('npx', ['tsc', '-p', 'tsconfig.json'], { cwd: ROOT, encoding: 'utf8' })
}

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
  beforeAll(() => {
    ensureDist()
  })

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
    expect(lines[0]).toBe(BOB)
    const [a, b, total, n] = lines[1].split(' ').map(Number)
    expect(n).toBe(b - a + 1)
    expect(total).toBeGreaterThan(0)
    expect(lines[2]).toContain('parse-page')
  })

  it('ingest.mjs no longer exposes search/browse/stats', () => {
    const src = readFileSync(join(ROOT, 'ingest.mjs'), 'utf8')
    expect(src).toContain('was removed')
    expect(src).toContain("cmd === 'search' || cmd === 'browse' || cmd === 'stats'")
    expect(src).not.toContain('memory.search(')
    expect(src).not.toContain('getSessionHistory')
  })

  it('discover-models.mjs is a thin wrapper over dist/identity.js', () => {
    const src = readFileSync(join(ROOT, 'discover-models.mjs'), 'utf8')
    expect(src).toContain('dist/identity.js')
    expect(src).not.toContain('DEFAULT_EXCLUDE_NAMES')
    expect(src).not.toContain('readdirSync(AGENTS)')
  })

  it('watcher matches store.db-wal on the same agent debounce key', async () => {
    const { STORE_WATCH_RE } = await import('../live-state.mjs')
    const id = BOB
    expect(`${id}/store.db`.match(STORE_WATCH_RE)?.[1]).toBe(id)
    expect(`${id}/store.db-wal`.match(STORE_WATCH_RE)?.[1]).toBe(id)
    expect(`${id}/store.db-shm`.match(STORE_WATCH_RE)).toBeNull()
    const src = readFileSync(join(ROOT, 'watch.mjs'), 'utf8')
    expect(src).toContain('STORE_WATCH_RE')
    expect(src).toContain('`store:${sm[1]}`')
    expect(src).toContain('`--session-suffix=${SESSION_SUFFIX}`')
    expect(src).toContain('`--after-seq=${after}`')
    expect(src).toMatch(/build the capture package first/i)
  })

  it('run-once.sh and convert-transcript.py use the = form for dash values', () => {
    const runOnce = readFileSync(join(ROOT, 'run-once.sh'), 'utf8')
    expect(runOnce).toContain('--after-seq="${after_seq}"')
    expect(runOnce).not.toMatch(/--after-seq "\$\{after_seq\}"/)
    const py = readFileSync(join(ROOT, 'convert-transcript.py'), 'utf8')
    expect(py).toContain('--session-suffix={session_suffix}')
    expect(py).not.toContain('["--session-suffix", session_suffix]')
  })

  it('run-once.sh and watch.mjs derive store/voice suffixes from GROKBOT_SESSION_SUFFIX', () => {
    const runOnce = readFileSync(join(ROOT, 'run-once.sh'), 'utf8')
    expect(runOnce).toContain('${SESSION_SUFFIX}-store')
    expect(runOnce).toContain('${SESSION_SUFFIX}-voice-')
    expect(runOnce).not.toContain('${session_id%-v3}-v3-store')
    expect(runOnce).not.toContain('${session_id%-v3}-v3-voice-')
    expect(runOnce).toContain('SESSION_SUFFIX}" == "-v3"')
    const watch = readFileSync(join(ROOT, 'watch.mjs'), 'utf8')
    expect(watch).toContain('`${SESSION_SUFFIX}-store`')
    expect(watch).toContain('`${SESSION_SUFFIX}-voice`')
    expect(watch).toContain('grokbot-capture-state${SESSION_SUFFIX}')
    expect(watch).not.toContain("const STORE_SUFFIX = '-v3-store'")
    expect(runOnce).toContain('unmappedTranscripts')
  })

  it('ingest.mjs is a wrapper over bin/ingest-session.mjs', () => {
    const src = readFileSync(join(ROOT, 'ingest.mjs'), 'utf8')
    expect(src).toContain("from '../bin/ingest-session.mjs'")
    expect(src).toContain('runIngest')
    const bin = readFileSync(join(ROOT, '..', 'bin', 'ingest-session.mjs'), 'utf8')
    expect(bin).toContain('export async function runIngest')
  })

  it('coalesceDashArgs rewrites space-form -v3 and -1 for parseArgs', () => {
    expect(coalesceDashArgs(['--session-suffix', '-v3', 'src', 'dst'])).toEqual([
      '--session-suffix=-v3',
      'src',
      'dst',
    ])
    expect(coalesceDashArgs(['--after-seq', '-1'])).toEqual(['--after-seq=-1'])
    expect(coalesceDashArgs(['--after-seq=-1'])).toEqual(['--after-seq=-1'])
  })

  it('parse_convert_args accepts both space and = forms', () => {
    const out = loadPyFn(
      join(ROOT, 'convert-transcript.py'),
      [
        'a,s,x,r = mod.parse_convert_args(["in.jsonl","out.jsonl","--agent-id=id1","--session=sess1","--session-suffix=-v3"])',
        'print(a, s, x, len(r))',
        'a,s,x,r = mod.parse_convert_args(["in.jsonl","out.jsonl","--agent-id","id2","--session","sess2","--session-suffix","-v3"])',
        'print(a, s, x, len(r))',
      ].join('\n'),
    )
    const lines = out.trim().split('\n')
    expect(lines[0]).toBe('id1 sess1 -v3 2')
    expect(lines[1]).toBe('id2 sess2 -v3 2')
  })

  it("runs the watcher's exact argv through convert-transcript.py with GROKBOT_SESSION_SUFFIX=-v3", () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-watch-argv-'))
    const src = join(dir, 'in.jsonl')
    const dst = join(dir, 'out.jsonl')
    writeFileSync(
      src,
      `${JSON.stringify({
        role: 'user',
        message: {
          content: [
            {
              type: 'text',
              text: '<timestamp>Sunday, Sep 20, 2026, 3:04 PM (UTC-05:00)</timestamp>\n<user_query>\nwatch argv\n</user_query>',
            },
          ],
        },
      })}\n`,
    )
    const out = execFileSync(
      'python3',
      [
        join(ROOT, 'convert-transcript.py'),
        src,
        dst,
        '--agent-id',
        BOB,
        '--session',
        'grokbot-bob-v3',
        '--session-suffix=-v3',
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, GROKBOT_SESSION_SUFFIX: '-v3' },
      },
    )
    const info = JSON.parse(out.trim().split('\n').pop() ?? '{}') as {
      session?: string
      out?: number
    }
    expect(info.session).toBe('grokbot-bob-v3')
    expect(info.out).toBeGreaterThan(0)
    expect(readFileSync(dst, 'utf8')).toContain('watch argv')
  })

  it('convert-transcript.py and pull-bridge fail closed when dist is missing', () => {
    const py = readFileSync(join(ROOT, 'convert-transcript.py'), 'utf8')
    const bridge = readFileSync(join(ROOT, 'pull-bridge.py'), 'utf8')
    expect(py).toContain('Build the capture package first')
    expect(py).not.toContain('--import')
    expect(py).not.toContain('tsx')
    expect(bridge).toContain('Build the capture package first')
    expect(bridge).not.toContain('--import')
    expect(bridge).not.toContain('tsx')
  })

  it('pull-bridge ingest calls require_dist before identities and exits 2 when dist is missing', () => {
    const out = execFileSync(
      'python3',
      [
        '-c',
        [
          'import importlib.util, io, pathlib, sys',
          'p = sys.argv[1]',
          'spec = importlib.util.spec_from_file_location("mod", p)',
          'mod = importlib.util.module_from_spec(spec)',
          'spec.loader.exec_module(mod)',
          'mod.CLI_JS = pathlib.Path("/tmp/missing-grokbot-cli.js")',
          'called = []',
          'def boom():',
          '    called.append(1)',
          '    raise RuntimeError("identities should not run")',
          'mod.identities = boom',
          'stderr = io.StringIO()',
          'old = sys.stderr',
          'sys.stderr = stderr',
          'code = 0',
          'try:',
          '    mod.cmd_ingest([], True, "-v3")',
          '    print("NO_EXIT")',
          'except SystemExit as e:',
          '    code = e.code',
          'finally:',
          '    sys.stderr = old',
          'err = stderr.getvalue()',
          'print(code)',
          'print(len(called))',
          'print("BUILD" if "Build the capture package first" in err else err[-200:])',
        ].join('\n'),
        join(ROOT, 'pull-bridge.py'),
      ],
      { encoding: 'utf8' },
    )
    const lines = out.trim().split('\n')
    expect(lines[0]).toBe('2')
    expect(lines[1]).toBe('0')
    expect(lines[2]).toBe('BUILD')
  })

  it('runs the real converter with GROKBOT_SESSION_SUFFIX=-v4', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-conv-v4-'))
    const src = join(dir, 'in.jsonl')
    const dst = join(dir, 'out.jsonl')
    writeFileSync(
      src,
      `${JSON.stringify({
        role: 'user',
        message: {
          content: [
            {
              type: 'text',
              text: '<timestamp>Sunday, Sep 20, 2026, 3:04 PM (UTC-05:00)</timestamp>\n<user_query>\nhello v4\n</user_query>',
            },
          ],
        },
      })}\n`,
    )
    const out = execFileSync('python3', [join(ROOT, 'convert-transcript.py'), src, dst], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GROKBOT_SESSION_SUFFIX: '-v4',
        GROKBOT_AGENT_ID: BOB,
      },
    })
    const info = JSON.parse(out.trim().split('\n').pop() ?? '{}') as {
      session?: string
      out?: number
    }
    expect(info.session).toBe('grokbot-bob-v4')
    expect(info.out).toBeGreaterThan(0)
    const rows = readFileSync(dst, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { content?: string; createdAt?: string })
    expect(rows.every((r) => Boolean(r.createdAt))).toBe(true)
    expect(rows.some((r) => r.content?.includes('hello v4'))).toBe(true)
  })

  it('runs the real converter with GROKBOT_SESSION_SUFFIX=-v3', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-conv-'))
    const src = join(dir, 'in.jsonl')
    const dst = join(dir, 'out.jsonl')
    writeFileSync(
      src,
      `${JSON.stringify({
        role: 'user',
        message: {
          content: [
            {
              type: 'text',
              text: '<timestamp>Sunday, Sep 20, 2026, 3:04 PM (UTC-05:00)</timestamp>\n<user_query>\nhello suffix\n</user_query>',
            },
          ],
        },
      })}\n`,
    )
    const listed = loadPyFn(
      join(ROOT, 'convert-transcript.py'),
      'print(" ".join(mod.convert_cmd("/tmp/in.jsonl", "/tmp/out.jsonl", "id", None, "-v3")))',
    )
    expect(listed).toContain('--session-suffix=-v3')
    const out = execFileSync('python3', [join(ROOT, 'convert-transcript.py'), src, dst], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GROKBOT_SESSION_SUFFIX: '-v3',
        GROKBOT_AGENT_ID: BOB,
      },
    })
    const info = JSON.parse(out.trim().split('\n').pop() ?? '{}') as {
      session?: string
      out?: number
    }
    expect(info.session).toBe('grokbot-bob-v3')
    expect(info.out).toBeGreaterThan(0)
    const rows = readFileSync(dst, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { content?: string })
    expect(rows.some((r) => r.content?.includes('hello suffix'))).toBe(true)
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
