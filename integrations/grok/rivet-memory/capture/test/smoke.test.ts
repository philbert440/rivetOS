/**
 * Smoke test for grok-memory-capture.ts
 *
 * Run with: npx tsx capture/test/smoke.test.ts
 *
 * Verifies the hot-path behavior end-to-end without needing a Postgres:
 *   - `--hook` exits 0 on empty stdin (the hook contract — never block Grok).
 *   - `--hook` with a tool-event payload writes a single spool file whose
 *     contents decode back to the expected CaptureOp shape.
 *   - `--worker` on a missing spool file does not throw.
 *
 * The detached worker spawn is left to fail (we deliberately unset
 * RIVETOS_PG_URL and point RIVETOS_ENV_FILE at /dev/null) so the spool file
 * is not consumed before the test can inspect it.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Source is at capture/src/; the built artifact (when present) is at capture/dist/.
// Prefer the built version if it exists so the test mirrors the production hot path,
// otherwise fall back to tsx against the .ts source.
const SRC = path.join(__dirname, '..', 'src', 'grok-memory-capture.ts')
const DIST = path.join(__dirname, '..', 'dist', 'grok-memory-capture.js')
const SPOOL_DIR = path.join(os.tmpdir(), 'rivetos-grok-capture')

const childEnv: NodeJS.ProcessEnv = { ...process.env, RIVETOS_ENV_FILE: '/dev/null' }
delete childEnv.RIVETOS_PG_URL

function run(args: string[], stdin = ''): SpawnSyncReturns<string> {
  const useBuilt = fs.existsSync(DIST)
  const cmd = useBuilt ? process.execPath : 'npx'
  const argv = useBuilt
    ? [DIST, ...args]
    : ['--yes', 'tsx', SRC, ...args]
  return spawnSync(cmd, argv, {
    input: stdin,
    encoding: 'utf8',
    env: childEnv,
    timeout: 30000,
  })
}

function listSpool(): string[] {
  try {
    return fs.readdirSync(SPOOL_DIR).filter(f => f.endsWith('.json'))
  } catch {
    return []
  }
}

let failed = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`✓ ${name}`)
  } else {
    console.error(`✗ ${name}${detail ? ': ' + detail : ''}`)
    failed++
  }
}

console.log('Running Grok Memory Capture smoke tests...\n')

// 1. --hook returns 0 even with empty stdin (the never-block-Grok contract).
{
  const r = run(['--hook', 'PostToolUse'])
  check(
    '--hook exits 0 on empty input',
    r.status === 0,
    `status=${r.status} stderr=${(r.stderr || '').trim()}`,
  )
}

// 2. --hook with a tool payload spools exactly one CaptureOp file with the expected shape.
{
  const sessionId = 'smoke-test-' + Date.now()
  const before = new Set(listSpool())
  const payload = JSON.stringify({
    session_id: sessionId,
    tool_name: 'echo',
    tool_input: { x: 1 },
    tool_result: 'ok',
  })
  const r = run(['--hook', 'PostToolUse'], payload)
  check(
    '--hook with payload exits 0',
    r.status === 0,
    `status=${r.status} stderr=${(r.stderr || '').trim()}`,
  )
  const newFiles = listSpool().filter(f => !before.has(f))
  check(
    '--hook with payload writes exactly one spool file',
    newFiles.length === 1,
    `newFiles=${JSON.stringify(newFiles)}`,
  )
  if (newFiles.length === 1) {
    const spoolPath = path.join(SPOOL_DIR, newFiles[0])
    let parsed: { kind?: string; sessionKey?: string; payload?: Record<string, unknown> } | null = null
    try {
      parsed = JSON.parse(fs.readFileSync(spoolPath, 'utf8'))
    } catch {
      /* parsed stays null */
    }
    check('spool file is valid JSON', parsed !== null)
    check('spool op.kind === "tool" for PostToolUse', parsed?.kind === 'tool')
    check(
      `spool op.sessionKey === "grok-build:${sessionId}"`,
      parsed?.sessionKey === `grok-build:${sessionId}`,
    )
    check(
      'spool op.payload.tool_name preserved',
      parsed?.payload?.tool_name === 'echo',
    )
    try { fs.unlinkSync(spoolPath) } catch { /* best effort */ }
  }
}

// 3. --worker on a missing spool file does not throw and exits 0.
{
  const missing = path.join(os.tmpdir(), `nonexistent-spool-${Date.now()}.json`)
  const r = run(['--worker', missing])
  check(
    '--worker handles missing file',
    r.status === 0,
    `status=${r.status} stderr=${(r.stderr || '').trim()}`,
  )
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`)
  process.exit(1)
}
console.log('\nAll smoke tests passed.')
