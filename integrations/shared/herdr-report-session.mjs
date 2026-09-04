#!/usr/bin/env node
// herdr-report-session — report the harness session to the herdr pane that
// owns this process. Replaces `herdr integration install <agent>` (which we
// deliberately do NOT run — it rewrites harness settings.json).
//
// Silent no-op unless herdr injected HERDR_PANE_ID + HERDR_SOCKET_PATH into
// the pane env. Reads the harness hook payload on stdin and POSTs
// pane.report_agent_session (newline-JSON) over the session socket with the
// harness session id + transcript path. Usage: herdr-report-session.mjs <agent>
// Never exits non-zero — capture must not disrupt the session.
import net from 'node:net'

const pane = process.env.HERDR_PANE_ID
const sock = process.env.HERDR_SOCKET_PATH
// Same gate as herdr's own integration hook (herdr-agent-state.sh v8).
if (process.env.HERDR_ENV !== '1' || !pane || !sock) process.exit(0)

process.stdin.setEncoding('utf8')
let raw = ''
for await (const chunk of process.stdin) raw += chunk
let p = {}
try {
  p = JSON.parse(raw)
} catch {
  /* payload optional */
}

// Mirror herdr's hook: subagent payloads and SubagentStop never (re)report —
// a completion event must not revive an idle pane; a subagent isn't the pane's session.
if (p.agent_id || p.hook_event_name === 'SubagentStop') process.exit(0)
const sessionId = p.session_id ?? p.sessionId
if (typeof sessionId !== 'string' || !sessionId) process.exit(0)
const params = {
  pane_id: pane,
  source: 'rivet-memory-hook',
  agent: process.argv[2] ?? 'unknown',
  // schema: seq is uint64|null. herdr's own hooks send time.time_ns() and herdr
  // drops superseded reports, so ours MUST be in the same unit (ns since epoch);
  // a double at 1e18 loses sub-µs precision, which is irrelevant for ordering.
  seq: Date.now() * 1_000_000,
  agent_session_id: sessionId,
}
const path = p.transcript_path ?? p.transcriptPath
if (typeof path === 'string' && path) params.agent_session_path = path

const c = net.createConnection(sock)
c.on('error', () => process.exit(0))
c.on('connect', () =>
  c.end(
    JSON.stringify({ id: 'rivet-memory-1', method: 'pane.report_agent_session', params }) + '\n',
  ),
)
setTimeout(() => process.exit(0), 2000).unref()
