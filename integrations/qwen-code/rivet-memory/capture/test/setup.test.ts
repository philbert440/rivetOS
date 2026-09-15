/**
 * Setup merge / staging rewrite tests for Qwen Code rivet-memory.
 *
 * Spawns bin/merge-settings-hooks.cjs against fixture inputs (empty, foreign,
 * mixed, invalid, path-with-spaces) and stages extension/ rewriting
 * <PLUGIN_PATH>.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.join(__dirname, '../../bin')
const MERGE = path.join(BIN, 'merge-settings-hooks.cjs')
const FRAGMENT = path.join(__dirname, '../../extension/hooks/hooks.json')
const EXT_SRC = path.join(__dirname, '../../extension')

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

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('node', [MERGE, ...args], { encoding: 'utf8' })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

function commandOf(doc: unknown, event: string, group = 0, hook = 0): string {
  const hooks = (doc as { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> })
    .hooks
  return hooks?.[event]?.[group]?.hooks?.[hook]?.command ?? ''
}

console.log('Running Qwen Code setup merge tests...\n')

const dir = mkdtempSync(path.join(tmpdir(), 'qwen-setup-'))
const spaceRoot = mkdtempSync(path.join(tmpdir(), 'Rivet OS '))
const pluginPath = path.join(spaceRoot, 'integrations', 'qwen-code', 'rivet-memory')
mkdirSync(path.join(pluginPath, 'bin'), { recursive: true })

try {
  console.log('— apply on empty settings.json —')
  {
    const dest = path.join(dir, 'empty-settings.json')
    const result = run(['apply', dest, FRAGMENT, pluginPath])
    eq('empty apply exit 0', result.status, 0)
    const doc = JSON.parse(readFileSync(dest, 'utf8')) as Record<string, unknown>
    const stop = commandOf(doc, 'Stop')
    check('Stop command contains marker script', stop.includes('qwen-memory-capture.sh'))
    check('Stop command contains --hook', stop.includes('--hook'))
    check('Stop command is bash-quoted', stop.includes("bash '"))
    check('quoted path with space survived', stop.includes('Rivet OS'))
    check('no leftover <PLUGIN_PATH>', !stop.includes('<PLUGIN_PATH>'))
    check('UserPromptSubmit present', Boolean(commandOf(doc, 'UserPromptSubmit')))
    check('SessionEnd present', Boolean(commandOf(doc, 'SessionEnd')))
  }

  console.log('\n— apply is idempotent and preserves foreign keys —')
  {
    const dest = path.join(dir, 'mixed-settings.json')
    writeFileSync(
      dest,
      JSON.stringify(
        {
          model: { name: 'qwen-27b' },
          hooks: {
            Stop: [
              {
                hooks: [{ type: 'command', command: 'echo foreign', timeout: 5, name: 'other' }],
              },
            ],
          },
        },
        null,
        2,
      ),
    )
    const first = run(['apply', dest, FRAGMENT, pluginPath])
    eq('mixed apply exit 0', first.status, 0)
    const second = run(['apply', dest, FRAGMENT, pluginPath])
    eq('second apply exit 0', second.status, 0)
    const doc = JSON.parse(readFileSync(dest, 'utf8')) as {
      model?: { name?: string }
      hooks?: { Stop?: Array<{ hooks?: Array<{ command?: string }> }> }
    }
    eq('model.name preserved', doc.model?.name, 'qwen-27b')
    const stopCmds = (doc.hooks?.Stop ?? []).flatMap((g) => (g.hooks ?? []).map((h) => h.command))
    check('foreign echo survived', stopCmds.includes('echo foreign'))
    check(
      'exactly one of our Stop commands',
      stopCmds.filter((c) => (c ?? '').includes('qwen-memory-capture.sh')).length === 1,
    )
  }

  console.log('\n— remove strips only our marker —')
  {
    const dest = path.join(dir, 'remove-settings.json')
    writeFileSync(dest, JSON.stringify({ model: { name: 'keep-me' }, extra: true }, null, 2))
    run(['apply', dest, FRAGMENT, pluginPath])
    const result = run(['remove', dest, pluginPath])
    eq('remove exit 0', result.status, 0)
    const doc = JSON.parse(readFileSync(dest, 'utf8')) as {
      model?: { name?: string }
      extra?: boolean
      hooks?: Record<string, unknown>
    }
    eq('model.name still there', doc.model?.name, 'keep-me')
    eq('extra still there', doc.extra, true)
    const stop = commandOf(doc, 'Stop')
    check('our Stop command gone', !stop.includes('qwen-memory-capture.sh'))
  }

  console.log('\n— invalid JSON leaves dest untouched —')
  {
    const dest = path.join(dir, 'bad.json')
    writeFileSync(dest, '{not json')
    const before = readFileSync(dest, 'utf8')
    const result = run(['apply', dest, FRAGMENT, pluginPath])
    check('invalid apply is non-zero', (result.status ?? 0) !== 0)
    eq('bytes unchanged', readFileSync(dest, 'utf8'), before)
  }

  console.log('\n— stage rewrites <PLUGIN_PATH> —')
  {
    const staged = path.join(dir, 'staged-ext')
    const result = run(['stage', EXT_SRC, staged, pluginPath])
    eq('stage exit 0', result.status, 0)
    const hooks = JSON.parse(readFileSync(path.join(staged, 'hooks', 'hooks.json'), 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>
    }
    const cmd = hooks.hooks.Stop?.[0]?.hooks?.[0]?.command ?? ''
    check('staged Stop has absolute plugin path', cmd.includes(pluginPath))
    check('staged Stop has no placeholder', !cmd.includes('<PLUGIN_PATH>'))
    const ext = JSON.parse(readFileSync(path.join(staged, 'qwen-extension.json'), 'utf8')) as {
      mcpServers: { rivetos: { command: string } }
    }
    check(
      'staged mcp command rewritten',
      ext.mcpServers.rivetos.command === `${pluginPath}/bin/rivet-memory-mcp.sh`,
    )
  }

  console.log('\n— disable-auto-memory —')
  {
    const dest = path.join(dir, 'auto-mem.json')
    writeFileSync(dest, JSON.stringify({ model: { name: 'qwen-27b' } }, null, 2))
    const result = run(['disable-auto-memory', dest])
    eq('disable-auto-memory exit 0', result.status, 0)
    const doc = JSON.parse(readFileSync(dest, 'utf8')) as {
      model?: { name?: string }
      memory?: { enableManagedAutoMemory?: boolean }
    }
    eq('model preserved', doc.model?.name, 'qwen-27b')
    eq('flag is false', doc.memory?.enableManagedAutoMemory, false)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
  rmSync(spaceRoot, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`\n${String(failed)} setup test(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nAll Qwen Code setup tests passed.')
}
