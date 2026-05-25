/**
 * Smoke + unit tests for grok-memory-capture.
 *
 * Two layers:
 *   1. Pure parser tests against a real captured updates.jsonl fixture
 *      (fixtures/session-updates.jsonl, 76 ACP events from rivet-grok on
 *      2026-05-25). No DB required — verifies parseUpdates() mapping logic.
 *   2. End-to-end --hook spool test — runs the script via tsx (or the built
 *      dist/ artifact when present), confirms it spools an ingest CaptureOp
 *      without spawning the detached worker (GROK_CAPTURE_NO_WORKER=1).
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

import { parseUpdates, readSessionSummary, findSessionDir } from '../src/grok-memory-capture.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(__dirname, '..', 'src', 'grok-memory-capture.ts')
const DIST = path.join(__dirname, '..', 'dist', 'grok-memory-capture.js')
const FIXTURE_DIR = path.join(__dirname, 'fixtures')
const SAMPLE_SESSION_DIR = path.join(FIXTURE_DIR, 'sample-session')
const SPOOL_DIR = path.join(os.tmpdir(), 'rivetos-grok-capture')

const childEnv: NodeJS.ProcessEnv = { ...process.env, GROK_CAPTURE_NO_WORKER: '1' }

function run(args: string[], stdin = ''): SpawnSyncReturns<string> {
  const useBuilt = fs.existsSync(DIST)
  const cmd = useBuilt ? process.execPath : 'npx'
  const argv = useBuilt ? [DIST, ...args] : ['--yes', 'tsx', SRC, ...args]
  return spawnSync(cmd, argv, { input: stdin, encoding: 'utf8', env: childEnv, timeout: 30000 })
}

function listSpool(): string[] {
  try { return fs.readdirSync(SPOOL_DIR).filter(f => f.endsWith('.json')) }
  catch { return [] }
}

let failed = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`✓ ${name}`)
  else { console.error(`✗ ${name}${detail ? ': ' + detail : ''}`); failed++ }
}

console.log('Running Grok Memory Capture tests...\n')

// =============================================================================
// Layer 1: pure parser tests (no DB, no subprocess)
// =============================================================================
console.log('— parser tests against fixtures/session-updates.jsonl —')
{
  const jsonl = fs.readFileSync(path.join(SAMPLE_SESSION_DIR, 'updates.jsonl'), 'utf8')
  const parsed = parseUpdates(jsonl)

  // Expected from the real session: 3 user prompts, 3 assistant replies,
  // 8 thoughts, 10 tool calls completed, 2 memory_flush markers. The hook
  // chatter (hook_execution, available_commands_update, in-progress
  // tool_call_update) should be filtered out.
  const byRole: Record<string, number> = {}
  let thoughts = 0
  let memoryMarkers = 0
  for (const m of parsed) {
    byRole[m.role] = (byRole[m.role] ?? 0) + 1
    if (m.content.startsWith('[thinking] ')) thoughts++
    if (m.content.startsWith('[grok.memory_flush')) memoryMarkers++
  }

  check('parsed >= 26 messages from 76-line file', parsed.length >= 26, `got ${parsed.length}`)
  check('3 user prompts captured', byRole.user === 3, `got ${byRole.user}`)
  check('3 assistant replies captured (the bug that motivated this PR)', byRole.assistant !== undefined && byRole.assistant >= 3,
    `got ${byRole.assistant}`)
  check('agent_thought_chunk captured as [thinking] prefix', thoughts >= 1, `got ${thoughts}`)
  check('10 tool rows captured', byRole.tool === 10, `got ${byRole.tool}`)
  check('memory_flush markers captured as system rows', memoryMarkers === 2, `got ${memoryMarkers}`)
  check('no hook_execution leaked through', !parsed.some(m => JSON.stringify(m.extra ?? {}).includes('hook_execution')))
  check('no available_commands leaked through', !parsed.some(m => JSON.stringify(m.extra ?? {}).includes('available_commands')))

  // Ordering: the first user prompt must precede the first assistant reply.
  const firstUser = parsed.findIndex(m => m.role === 'user')
  const firstAssistant = parsed.findIndex(m => m.role === 'assistant' && !m.content.startsWith('[thinking] '))
  check('user precedes assistant in parsed order', firstUser >= 0 && firstAssistant > firstUser,
    `user@${firstUser}, assistant@${firstAssistant}`)

  // Tool rows must carry both toolName and toolResult populated from rawOutput.
  const firstTool = parsed.find(m => m.role === 'tool')
  check('tool row has toolName populated', !!firstTool?.toolName, `firstTool=${JSON.stringify(firstTool)}`)
  check('tool row has toolResult populated (not just {"status":"completed"})',
    !!firstTool?.toolResult && !/^{?"status":\s*"completed"}?$/.test(firstTool.toolResult),
    `toolResult=${firstTool?.toolResult?.slice(0, 80)}`)

  // EventId is best-effort — Grok includes _meta.eventId on most session/update
  // events but not all (e.g. memory_flush, hook_execution, and some early
  // SessionStart fixtures lack it). We assert "most messages carry an eventId,"
  // not "every," because the eventId is decorative metadata for traceability
  // and dedup; slice-by-count idempotency does not depend on it.
  const withEventId = parsed.filter(m => m.eventId)
  check('most parsed messages carry an eventId (>=80%)',
    withEventId.length >= Math.floor(parsed.length * 0.8),
    `${withEventId.length}/${parsed.length} have eventId`)

  // Idempotency invariant: re-parsing produces the same list.
  const reparsed = parseUpdates(jsonl)
  check('parser is deterministic across runs (idempotency precondition)',
    JSON.stringify(reparsed) === JSON.stringify(parsed))

  // Append-safety: parsing a prefix and then the whole file shows monotonic growth.
  const halfText = jsonl.split('\n').slice(0, 40).join('\n') + '\n'
  const half = parseUpdates(halfText)
  check('parsing a prefix yields a non-empty proper prefix (slice-by-count is safe)',
    half.length > 0 && half.length <= parsed.length &&
    JSON.stringify(parsed.slice(0, half.length)) === JSON.stringify(half),
    `half=${half.length} full=${parsed.length}`)

  // Tool result readability (fix 1): byte arrays must not leak through as
  // decimal numbers; Bash/MCP/etc. should surface their human-readable fields.
  const bashTool = parsed.find(m => m.toolResult?.includes('exit_code='))
  check('a Bash-type tool row was found and uses output_for_prompt',
    !!bashTool && !/^\[\d+,\d+/.test(bashTool.toolResult!),
    `bashTool.toolResult=${bashTool?.toolResult?.slice(0, 80)}`)
  const mcpTool = parsed.find(m => m.toolResult?.startsWith('[mcp '))
  check('an MCP-type tool row carries a readable [mcp server/tool] header',
    !!mcpTool, `mcpTool=${mcpTool?.toolResult?.slice(0, 80)}`)
  // Defence-in-depth: no raw decimal byte array should leak even in unknown types.
  const leaked = parsed.find(m =>
    m.toolResult && /\[\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,/.test(m.toolResult)
  )
  check('no decimal byte array leaked into any tool_result', !leaked,
    leaked ? `leaked=${leaked.toolResult?.slice(0, 80)}` : '')

  // Ordinal (fix 2): every emitted row has an ordinal, ordinals are stable
  // across re-parses, and when sorted by ordinal the user prompt for a turn
  // precedes the agent thoughts/tools for that same turn.
  const allHaveOrdinal = parsed.every(m => typeof m.ordinal === 'number')
  check('every parsed row carries an ordinal', allHaveOrdinal)
  check('ordinals are stable across re-parses',
    JSON.stringify(parsed.map(m => m.ordinal)) === JSON.stringify(reparsed.map(m => m.ordinal)))

  // Logical turn ordering: within each turn (ordinal / 1_000_000), the user
  // prompt must precede any other event for that turn.
  const TURN_STRIDE = 1_000_000
  const turnSeen = new Map<number, { sawUser: boolean; firstNonUserOrdinal: number | null }>()
  let outOfOrder = 0
  for (const m of [...parsed].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0))) {
    if (typeof m.ordinal !== 'number') continue
    const turn = Math.floor(m.ordinal / TURN_STRIDE)
    const state = turnSeen.get(turn) ?? { sawUser: false, firstNonUserOrdinal: null }
    if (m.role === 'user' && m.extra && (m.extra as any).sessionUpdate === 'user_message_chunk') {
      if (state.firstNonUserOrdinal !== null) outOfOrder++
      state.sawUser = true
    } else if (!state.sawUser && state.firstNonUserOrdinal === null) {
      state.firstNonUserOrdinal = m.ordinal
    }
    turnSeen.set(turn, state)
  }
  check('sorting by ordinal puts user prompts ahead of their turn\'s agent events',
    outOfOrder === 0, `outOfOrder=${outOfOrder}`)

  // Disk-pointer metadata (so truncated rows stay recoverable from
  // updates.jsonl on disk): every parsed row carries a lineIndex pointing
  // back to its source line in the JSONL.
  const allHaveLineIndex = parsed.every(m => typeof m.lineIndex === 'number')
  check('every parsed row carries a lineIndex', allHaveLineIndex)
  // lineIndex must monotonically non-decrease across the parsed list
  // (different rows from the same line — e.g. tool_call followed by tool_call_update —
  //  can share an index, but later events never go backwards).
  let lastLine = -1
  let backwards = 0
  for (const m of parsed) {
    if (typeof m.lineIndex !== 'number') continue
    if (m.lineIndex < lastLine) backwards++
    lastLine = m.lineIndex
  }
  check('lineIndex is monotonic non-decreasing across parsed rows',
    backwards === 0, `backwards=${backwards}`)

  // The full (un-truncated) content/toolResult is carried on PendingMessage;
  // insertMessage applies the MAX_CONTENT cap at DB write time. Verify the
  // raw text is at least as long as what would be stored — i.e. parseUpdates
  // does NOT itself truncate (regression guard for the trunc-moved refactor).
  const longestToolResult = parsed
    .filter(m => typeof m.toolResult === 'string')
    .reduce((max, m) => Math.max(max, (m.toolResult as string).length), 0)
  check('parser preserves full tool_result length (no premature truncation)',
    !parsed.some(m =>
      typeof m.toolResult === 'string' &&
      m.toolResult.endsWith('\n…[truncated]')
    ),
    `longestToolResult=${longestToolResult}`)
}

// =============================================================================
// Layer 2: summary.json reader
// =============================================================================
console.log('\n— summary.json reader —')
{
  const summary = readSessionSummary(SAMPLE_SESSION_DIR)
  check('reads generated_title from summary.json', !!summary.title)
  check('reads current_model_id', summary.modelId === 'grok-build')
  check('reads agent_name', summary.agentName === 'grok-build-plan')
}

// =============================================================================
// Layer 3: session dir resolver
// =============================================================================
console.log('\n— findSessionDir resolver —')
{
  // Made-up id should not resolve to anything real.
  const phantom = findSessionDir('00000000-0000-0000-0000-000000000000')
  check('returns null for unknown session id', phantom === null)
}

// =============================================================================
// Layer 4: --hook spool path (subprocess, no DB)
// =============================================================================
console.log('\n— --hook spool e2e —')
{
  const r = run(['--hook', 'SessionStart'])
  check('--hook exits 0 on empty input', r.status === 0,
    `status=${r.status} stderr=${(r.stderr || '').trim()}`)
}
{
  const sessionId = 'smoke-session-' + Date.now()
  const before = new Set(listSpool())
  const payload = JSON.stringify({ hookEventName: 'stop', sessionId, reason: 'end_turn' })
  const r = run(['--hook', 'Stop'], payload)
  check('--hook Stop exits 0', r.status === 0, `status=${r.status}`)
  const newFiles = listSpool().filter(f => !before.has(f))
  check('writes exactly one spool file', newFiles.length === 1, `newFiles=${JSON.stringify(newFiles)}`)
  if (newFiles.length === 1) {
    const spoolPath = path.join(SPOOL_DIR, newFiles[0])
    let parsed: any = null
    try { parsed = JSON.parse(fs.readFileSync(spoolPath, 'utf8')) } catch {}
    check('spool op.kind === "ingest"', parsed?.kind === 'ingest')
    check('spool op.sessionId === payload.sessionId', parsed?.sessionId === sessionId)
    check('spool op.sourceEvent === "Stop"', parsed?.sourceEvent === 'Stop')
    check('spool op.finalize is falsy for Stop', !parsed?.finalize)
    try { fs.unlinkSync(spoolPath) } catch {}
  }
}
{
  const sessionId = 'smoke-end-' + Date.now()
  const before = new Set(listSpool())
  const payload = JSON.stringify({ hookEventName: 'session_end', sessionId })
  const r = run(['--hook', 'SessionEnd'], payload)
  check('--hook SessionEnd exits 0', r.status === 0)
  const newFiles = listSpool().filter(f => !before.has(f))
  if (newFiles.length === 1) {
    const spoolPath = path.join(SPOOL_DIR, newFiles[0])
    let parsed: any = null
    try { parsed = JSON.parse(fs.readFileSync(spoolPath, 'utf8')) } catch {}
    check('SessionEnd sets finalize=true', parsed?.finalize === true)
    try { fs.unlinkSync(spoolPath) } catch {}
  } else {
    check('SessionEnd writes a spool file', false, `newFiles=${JSON.stringify(newFiles)}`)
  }
}
{
  const missing = path.join(os.tmpdir(), `nonexistent-spool-${Date.now()}.json`)
  const r = run(['--worker', missing])
  check('--worker handles missing file', r.status === 0, `status=${r.status}`)
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`)
  process.exit(1)
}
console.log('\nAll tests passed.')
