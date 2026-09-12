/**
 * Setup merge tests for Codex native hooks.
 *
 * Spawns bin/merge-requirements.py and bin/merge-hooks-json.{py,js} against
 * fixture inputs (empty, foreign, mixed, invalid, path-with-spaces).
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.join(__dirname, '../../bin')
const MERGE_TOML = path.join(BIN, 'merge-requirements.py')
const MERGE_JSON_PY = path.join(BIN, 'merge-hooks-json.py')
const MERGE_JSON_JS = path.join(BIN, 'merge-hooks-json.cjs')
const FRAGMENT = path.join(__dirname, '../../hooks/hooks.json')

let failed = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`✓ ${name}`)
  else {
    console.error(`✗ ${name}${detail ? ': ' + detail : ''}`)
    failed++
  }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`)
}

function run(
  command: string,
  args: string[],
  opts: { input?: string } = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    input: opts.input,
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function commandOf(doc: unknown, event: string, group = 0, hook = 0): string {
  const hooks = (doc as { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> })
    .hooks
  return hooks?.[event]?.[group]?.hooks?.[hook]?.command ?? ''
}

function isOurs(command: string): boolean {
  return command.includes('codex-memory-capture.sh') && command.includes('--hook')
}

console.log('Running Codex setup merge tests...\n')

const python3 = run('python3', [
  '-c',
  'import tomllib, sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)',
])
check('python3 tomllib is available', python3.status === 0, python3.stderr)

const dir = mkdtempSync(path.join(tmpdir(), 'codex-setup-'))
const spaceRoot = mkdtempSync(path.join(tmpdir(), 'Rivet OS '))
const pluginPath = path.join(spaceRoot, 'integrations', 'codex', 'rivet-memory')
mkdirSync(path.join(pluginPath, 'bin'), { recursive: true })
const pluginBin = path.join(pluginPath, 'bin')

try {
  // ===========================================================================
  // TOML: apply on empty
  // ===========================================================================
  console.log('— merge-requirements.py apply on empty —')
  {
    const out = path.join(dir, 'empty.toml')
    const result = run('python3', [
      MERGE_TOML,
      'apply',
      '--plugin-bin',
      pluginBin,
      '--stdin',
      '--out',
      out,
    ])
    eq('empty apply exit 0', result.status, 0)
    const text = readFileSync(out, 'utf8')
    check('empty apply writes [hooks]', text.includes('[hooks]'))
    check('empty apply sets managed_dir', text.includes('managed_dir'))
    check(
      'empty apply command is bash-quoted and contains both markers',
      text.includes('codex-memory-capture.sh') && text.includes('--hook') && text.includes('bash '),
    )
    check(
      'quoted path with space survived JSON/TOML encoding',
      text.includes('Rivet OS') && text.includes("bash '"),
    )
    const round = run('python3', ['-c', 'import tomllib,sys; tomllib.loads(sys.stdin.read())'], {
      input: text,
    })
    eq('empty apply re-parses as TOML', round.status, 0)
  }

  // ===========================================================================
  // TOML: apply on existing-foreign with managed_dir → skip (exit 2)
  // ===========================================================================
  console.log('\n— merge-requirements.py foreign managed_dir —')
  {
    const existing = path.join(dir, 'foreign-managed.toml')
    const out = path.join(dir, 'foreign-managed.out.toml')
    writeFileSync(
      existing,
      [
        '[network]',
        'proxy = "http://example.invalid"',
        '',
        '[hooks]',
        'managed_dir = "/opt/company/codex-hooks"',
        'windows_managed_dir = "C:\\\\company\\\\hooks"',
        '',
        '[[hooks.Stop]]',
        'command = "company-audit.sh"',
        'timeout = 10',
        '',
      ].join('\n'),
    )
    const result = run('python3', [
      MERGE_TOML,
      'apply',
      '--plugin-bin',
      pluginBin,
      '--existing',
      existing,
      '--out',
      out,
    ])
    eq('foreign managed_dir exit 2', result.status, 2)
    check('stderr explains user hooks.json', result.stderr.includes('hooks.json'))
    let wrote = true
    try {
      readFileSync(out)
    } catch {
      wrote = false
    }
    check('foreign managed_dir did not write --out', wrote === false)
    const original = readFileSync(existing, 'utf8')
    check('foreign file bytes unchanged', original.includes('company-audit.sh'))
    check('foreign managed_dir preserved in source', original.includes('/opt/company/codex-hooks'))
  }

  // ===========================================================================
  // TOML: apply on existing-foreign without managed_dir; re-apply; remove
  // ===========================================================================
  console.log('\n— merge-requirements.py foreign entries without managed_dir —')
  {
    const existing = path.join(dir, 'foreign-entries.toml')
    writeFileSync(
      existing,
      [
        '[network]',
        'proxy = "http://example.invalid"',
        '',
        '[[hooks.Stop]]',
        'command = "company-audit.sh"',
        'timeout = 10',
        '',
      ].join('\n'),
    )
    const first = run('python3', [
      MERGE_TOML,
      'apply',
      '--plugin-bin',
      pluginBin,
      '--existing',
      existing,
      '--out',
      existing,
    ])
    eq('foreign-entries apply exit 0', first.status, 0)
    const afterApply = readFileSync(existing, 'utf8')
    check('foreign Stop command survived apply', afterApply.includes('company-audit.sh'))
    check('network table survived apply', afterApply.includes('example.invalid'))
    check('our Stop command was added', afterApply.includes('codex-memory-capture.sh'))
    check('did not invent managed_dir over foreign entries', !afterApply.includes('managed_dir'))

    const second = run('python3', [
      MERGE_TOML,
      'apply',
      '--plugin-bin',
      pluginBin,
      '--existing',
      existing,
      '--out',
      existing,
    ])
    eq('re-apply exit 0', second.status, 0)
    const oursCount = afterApply.split('codex-memory-capture.sh').length - 1
    const afterRe = readFileSync(existing, 'utf8')
    const oursCountRe = afterRe.split('codex-memory-capture.sh').length - 1
    eq('re-apply is idempotent (same marker count)', oursCountRe, oursCount)

    const removed = run('python3', [
      MERGE_TOML,
      'remove',
      '--plugin-bin',
      pluginBin,
      '--existing',
      existing,
      '--out',
      existing,
    ])
    eq('remove exit 0', removed.status, 0)
    const afterRemove = readFileSync(existing, 'utf8')
    check('foreign Stop survived remove', afterRemove.includes('company-audit.sh'))
    check('network table survived remove', afterRemove.includes('example.invalid'))
    check('our commands gone after remove', !afterRemove.includes('codex-memory-capture.sh'))
  }

  // ===========================================================================
  // TOML: invalid existing → exit 3, no write
  // ===========================================================================
  console.log('\n— merge-requirements.py invalid TOML —')
  {
    const existing = path.join(dir, 'bad.toml')
    const out = path.join(dir, 'bad.out.toml')
    const bytes = 'this is not toml [[[\n'
    writeFileSync(existing, bytes)
    const result = run('python3', [
      MERGE_TOML,
      'apply',
      '--plugin-bin',
      pluginBin,
      '--existing',
      existing,
      '--out',
      out,
    ])
    eq('invalid TOML exit 3', result.status, 3)
    check('invalid TOML source unchanged', readFileSync(existing, 'utf8') === bytes)
  }

  // ===========================================================================
  // TOML: nested HookHandlerConfig shape, quoted keys, upgrade from an old
  // unquoted registration (the shapes Codex 0.154 actually loads)
  // ===========================================================================
  console.log('\n— merge-requirements.py shape / quoted keys / upgrade —')
  {
    const existing = path.join(dir, 'shape.toml')
    writeFileSync(
      existing,
      [
        '[mcp_servers."audit.prod".identity]',
        'name = "x"',
        '',
        '[[hooks.Stop]]',
        'matcher = "^Bash$"',
        '[[hooks.Stop.hooks]]',
        'type = "command"',
        'command = "company-audit.sh"',
        '',
        '[[hooks.UserPromptSubmit]]',
        `command = "bash ${pluginBin}/codex-memory-capture.sh --hook"`,
        'timeout = 20',
        '',
      ].join('\n'),
    )
    const r = run('python3', [
      MERGE_TOML,
      'apply',
      '--plugin-bin',
      pluginBin,
      '--existing',
      existing,
      '--out',
      existing,
    ])
    eq('shape apply exit 0', r.status, 0)
    const probe = run('python3', [
      '-c',
      [
        'import tomllib,json,sys',
        `d=tomllib.load(open(${JSON.stringify(existing)},'rb'))`,
        'h=d["hooks"]',
        'ours=lambda g: any("codex-memory-capture.sh" in (x.get("command") or "") for x in g.get("hooks",[]))',
        'out={',
        ' "audit_kept": "audit.prod" in d.get("mcp_servers",{}),',
        ' "stop_foreign": any(any(x.get("command")=="company-audit.sh" for x in g.get("hooks",[])) for g in h["Stop"]),',
        ' "stop_ours_nested": any(ours(g) and all(x.get("type")=="command" for x in g["hooks"]) for g in h["Stop"]),',
        ' "ups_flat_left": any("command" in g for g in h["UserPromptSubmit"]),',
        ' "ups_ours_quoted": any(ours(g) and any(x["command"].startswith("bash \'") for x in g["hooks"]) for g in h["UserPromptSubmit"]),',
        ' "ups_count": sum(1 for g in h["UserPromptSubmit"] if ours(g)),',
        ' "sessionend": any(ours(g) for g in h.get("SessionEnd",[])),',
        '}',
        'print(json.dumps(out))',
      ].join('\n'),
    ])
    eq('shape probe exit 0', probe.status, 0)
    const got = JSON.parse(probe.stdout.trim() || '{}') as Record<string, unknown>
    check('quoted dotted key kept its identity', got.audit_kept === true)
    check('foreign nested Stop handler survived', got.stop_foreign === true)
    check(
      'our Stop entry is nested [[hooks.Stop.hooks]] type=command',
      got.stop_ours_nested === true,
    )
    check('old flat unquoted registration was removed on apply', got.ups_flat_left === false)
    check(
      'our UserPromptSubmit command is the fresh shell-quoted form',
      got.ups_ours_quoted === true,
    )
    eq('exactly one Rivet UserPromptSubmit group after upgrade', got.ups_count, 1)
    check('SessionEnd registered', got.sessionend === true)
  }

  // ===========================================================================
  // TOML: upgrade from the FLAT (pre-fix) managed shape — must be rebuilt nested
  // ===========================================================================
  console.log('\n— merge-requirements.py upgrade from flat managed shape —')
  {
    const existing = path.join(dir, 'flat.toml')
    const quoted = `bash '${pluginBin}/codex-memory-capture.sh' --hook`
    writeFileSync(
      existing,
      [
        '[hooks]',
        `managed_dir = ${JSON.stringify(pluginBin)}`,
        '',
        ...['UserPromptSubmit', 'Stop', 'SessionEnd'].flatMap((ev) => [
          `[[hooks.${ev}]]`,
          `command = ${JSON.stringify(quoted)}`,
          'timeout = 20',
          '',
        ]),
      ].join('\n'),
    )
    const r = run('python3', [
      MERGE_TOML,
      'apply',
      '--plugin-bin',
      pluginBin,
      '--existing',
      existing,
      '--out',
      existing,
    ])
    eq('flat-upgrade apply exit 0', r.status, 0)
    check('flat-upgrade reported merged (not already)', /merged rivet-memory/.test(r.stderr))
    const probe = run('python3', [
      '-c',
      [
        'import tomllib,json,sys',
        `d=tomllib.load(open(${JSON.stringify(existing)},'rb'))`,
        'h=d["hooks"]',
        'flat=sum(1 for ev in ("UserPromptSubmit","Stop","SessionEnd") for g in h[ev] if "command" in g)',
        'nested=sum(1 for ev in ("UserPromptSubmit","Stop","SessionEnd") for g in h[ev] if any(x.get("type")=="command" and "codex-memory-capture.sh" in x.get("command","") for x in g.get("hooks",[])))',
        'print(json.dumps({"flat":flat,"nested":nested,"groups":sum(len(h[ev]) for ev in ("UserPromptSubmit","Stop","SessionEnd"))}))',
      ].join('\n'),
    ])
    const got = JSON.parse(probe.stdout.trim() || '{}') as Record<string, number>
    eq('no flat Rivet groups remain', got.flat, 0)
    eq('every event has one nested Rivet handler', got.nested, 3)
    eq('exactly three groups total (no duplicates)', got.groups, 3)
  }

  // ===========================================================================
  // JSON merge: python + node, empty / mixed / invalid / spaces
  // ===========================================================================
  const jsonTools: Array<{ name: string; cmd: string; args: string[] }> = [
    { name: 'python3', cmd: 'python3', args: [MERGE_JSON_PY] },
    { name: 'node', cmd: 'node', args: [MERGE_JSON_JS] },
  ]

  for (const tool of jsonTools) {
    console.log(`\n— merge-hooks-json ${tool.name} —`)
    const dest = path.join(dir, `hooks-${tool.name}.json`)

    const apply1 = run(tool.cmd, [...tool.args, 'apply', dest, FRAGMENT, pluginPath])
    eq(`${tool.name} apply on missing dest exit 0`, apply1.status, 0)
    const doc1 = readJson(dest)
    const stopCmd = commandOf(doc1, 'Stop')
    check(`${tool.name} Stop command is ours`, isOurs(stopCmd))
    check(`${tool.name} command uses bash quoting`, stopCmd.startsWith('bash '))
    check(`${tool.name} quoted path contains space`, stopCmd.includes('Rivet OS'))
    check(
      `${tool.name} did not leave <PLUGIN_PATH> in the command`,
      !stopCmd.includes('<PLUGIN_PATH>'),
    )
    check(
      `${tool.name} JSON parse kept the space (not raw substitution)`,
      stopCmd.includes(path.join(pluginPath, 'bin', 'codex-memory-capture.sh')),
    )

    const apply2 = run(tool.cmd, [...tool.args, 'apply', dest, FRAGMENT, pluginPath])
    eq(`${tool.name} re-apply exit 0`, apply2.status, 0)
    const doc2 = readJson(dest) as { hooks?: Record<string, unknown[]> }
    eq(`${tool.name} re-apply still one Stop group`, (doc2.hooks?.Stop ?? []).length, 1)

    const mixed = path.join(dir, `mixed-${tool.name}.json`)
    writeFileSync(
      mixed,
      JSON.stringify(
        {
          hooks: {
            Stop: [
              {
                hooks: [
                  { type: 'command', command: 'foreign-audit.sh', timeout: 5 },
                  {
                    type: 'command',
                    command: `bash '${path.join(pluginPath, 'bin', 'codex-memory-capture.sh')}' --hook`,
                    timeout: 20,
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ) + '\n',
    )
    const unmerge = run(tool.cmd, [...tool.args, 'remove', mixed, pluginPath])
    eq(`${tool.name} mixed remove exit 0`, unmerge.status, 0)
    const mixedDoc = readJson(mixed) as {
      hooks?: { Stop?: Array<{ hooks?: Array<{ command?: string }> }> }
    }
    const inner = mixedDoc.hooks?.Stop?.[0]?.hooks ?? []
    eq(`${tool.name} mixed group kept one command`, inner.length, 1)
    eq(`${tool.name} mixed group kept the foreign command`, inner[0]?.command, 'foreign-audit.sh')
    check(`${tool.name} mixed group dropped ours`, !inner.some((h) => isOurs(h.command ?? '')))

    const bad = path.join(dir, `bad-${tool.name}.json`)
    const badBytes = '{ not json at all\n'
    writeFileSync(bad, badBytes)
    const badApply = run(tool.cmd, [...tool.args, 'apply', bad, FRAGMENT, pluginPath])
    check(`${tool.name} invalid JSON apply exits non-zero`, (badApply.status ?? 0) !== 0)
    eq(`${tool.name} invalid JSON bytes untouched`, readFileSync(bad, 'utf8'), badBytes)
    check(
      `${tool.name} invalid JSON error is repairable`,
      badApply.stderr.includes('not valid JSON') && badApply.stderr.includes('untouched'),
    )

    const badRemove = run(tool.cmd, [...tool.args, 'remove', bad, pluginPath])
    check(`${tool.name} invalid JSON remove exits non-zero`, (badRemove.status ?? 0) !== 0)
    eq(
      `${tool.name} invalid JSON still untouched after remove`,
      readFileSync(bad, 'utf8'),
      badBytes,
    )

    const shape = path.join(dir, `shape-${tool.name}.json`)
    const shapeBytes = '{"hooks": []}\n'
    writeFileSync(shape, shapeBytes)
    const shapeApply = run(tool.cmd, [...tool.args, 'apply', shape, FRAGMENT, pluginPath])
    check(`${tool.name} bad hooks shape apply exits non-zero`, (shapeApply.status ?? 0) !== 0)
    eq(`${tool.name} bad hooks shape bytes untouched`, readFileSync(shape, 'utf8'), shapeBytes)
  }

  // ===========================================================================
  // Register-once: managed ok → user entries removed; managed unavailable → apply
  // ===========================================================================
  console.log('\n— sync_user_hooks (managed ok → user entries removed) —')
  for (const tool of jsonTools) {
    const dest = path.join(dir, `sync-${tool.name}.json`)
    writeFileSync(
      dest,
      JSON.stringify(
        {
          hooks: {
            Stop: [
              {
                hooks: [
                  { type: 'command', command: 'foreign-audit.sh', timeout: 5 },
                  {
                    type: 'command',
                    command: `bash '${path.join(pluginPath, 'bin', 'codex-memory-capture.sh')}' --hook`,
                    timeout: 20,
                  },
                ],
              },
            ],
            UserPromptSubmit: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: `bash '${path.join(pluginPath, 'bin', 'codex-memory-capture.sh')}' --hook`,
                    timeout: 20,
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ) + '\n',
    )
    const managed = run(tool.cmd, [...tool.args, 'sync', dest, FRAGMENT, pluginPath, 'managed'])
    eq(`${tool.name} sync managed exit 0`, managed.status, 0)
    check(
      `${tool.name} sync managed prints registration: managed`,
      managed.stdout.includes('registration: managed'),
    )
    const afterManaged = readJson(dest) as {
      hooks?: {
        Stop?: Array<{ hooks?: Array<{ command?: string }> }>
        UserPromptSubmit?: unknown
      }
    }
    const stopInner = afterManaged.hooks?.Stop?.[0]?.hooks ?? []
    eq(`${tool.name} managed-ok kept one Stop command`, stopInner.length, 1)
    eq(
      `${tool.name} managed-ok kept the foreign command`,
      stopInner[0]?.command,
      'foreign-audit.sh',
    )
    check(
      `${tool.name} managed-ok dropped our Stop command`,
      !stopInner.some((h) => isOurs(h.command ?? '')),
    )
    check(
      `${tool.name} managed-ok dropped our UserPromptSubmit group`,
      afterManaged.hooks?.UserPromptSubmit == null,
    )

    const userDest = path.join(dir, `sync-user-${tool.name}.json`)
    const user = run(tool.cmd, [...tool.args, 'sync', userDest, FRAGMENT, pluginPath, 'user'])
    eq(`${tool.name} sync user exit 0`, user.status, 0)
    check(
      `${tool.name} sync user prints registration: user`,
      user.stdout.includes('registration: user'),
    )
    const afterUser = readJson(userDest)
    check(`${tool.name} sync user registered Stop`, isOurs(commandOf(afterUser, 'Stop')))
    check(
      `${tool.name} sync user registered SessionEnd`,
      isOurs(commandOf(afterUser, 'SessionEnd')),
    )
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
  rmSync(spaceRoot, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`\n${String(failed)} setup test(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nAll Codex setup merge tests passed.')
}
