// Scripted demo session — a fake "fix the auth bug" run that exercises
// every station and state. Later this is replaced by a WebSocket feed
// from a real harness adapter.

import type { AgentEventBody } from '@rivetos/den-protocol'

export interface TimedEvent {
  at: number // ms from start
  ev: AgentEventBody
}

const THOUGHT =
  'The login failures started after the token refresh change... I should check how the session middleware validates expiry. Probably a timezone mismatch in the JWT exp claim. Let me look at the auth module first. '

function stream(text: string, from: number, cps = 30): TimedEvent[] {
  const out: TimedEvent[] = []
  const chunk = 3
  for (let i = 0; i < text.length; i += chunk) {
    out.push({
      at: from + ((i / chunk) * (1000 * chunk)) / cps,
      ev: { type: 'thinking.delta', text: text.slice(i, i + chunk) },
    })
  }
  return out
}

// terminal lines typed onto the desk monitor, one per beat
function term(lines: string[], from: number, gap = 700): TimedEvent[] {
  return lines.map((text, i) => ({ at: from + i * gap, ev: { type: 'term.line' as const, text } }))
}

export const demoScript: TimedEvent[] = [
  { at: 0, ev: { type: 'session.start', title: 'fix auth bug' } },
  {
    at: 200,
    ev: {
      type: 'message.user',
      text: 'the login page 500s since the deploy — can you take a look?',
    },
  },
  { at: 500, ev: { type: 'activity', activity: 'writing_plan' } },
  {
    at: 1800,
    ev: {
      type: 'task.plan',
      tasks: [
        'Reproduce the login failure',
        'Search for similar JWT issues',
        'Read auth middleware',
        'Patch token expiry check',
        'Run the test suite',
        'Report findings',
      ],
    },
  },

  ...stream(THOUGHT, 4500),
  { at: 11000, ev: { type: 'thinking.end' } },

  { at: 11500, ev: { type: 'activity', activity: 'running_command' } },
  { at: 15500, ev: { type: 'task.check', index: 0 } },

  { at: 16500, ev: { type: 'activity', activity: 'searching_web' } },
  { at: 22500, ev: { type: 'task.check', index: 1 } },

  { at: 23500, ev: { type: 'activity', activity: 'editing_code' } },
  ...term(['$ grep -rn verifyToken src/', 'src/auth/jwt.ts:41', '$ cat src/auth/jwt.ts'], 24500),
  { at: 28000, ev: { type: 'task.check', index: 2 } },
  ...stream(
    'Found it — exp claim compared against local time, not UTC. One-line fix in verifyToken(). ',
    29000,
  ),
  { at: 33500, ev: { type: 'thinking.end' } },
  { at: 34000, ev: { type: 'activity', activity: 'editing_code' } },
  ...term(['✎ src/auth/jwt.ts', '$ npm test', '· · ·', '✓ 42 passing (3.1s)'], 35000, 900),
  { at: 38500, ev: { type: 'task.check', index: 3 } },

  { at: 39500, ev: { type: 'activity', activity: 'running_command' } },
  { at: 45000, ev: { type: 'task.check', index: 4 } },

  {
    at: 46000,
    ev: {
      type: 'message.agent',
      text: 'Fixed! The JWT expiry check used local time instead of UTC. All 42 tests pass.',
    },
  },
  { at: 46200, ev: { type: 'task.check', index: 5 } },

  // epilogue so the loop shows EVERY animation: Phil interrupts (listening),
  // sends him to bed (sleeping + trailing Z's), then he wakes back to idle
  { at: 52000, ev: { type: 'speech.stt', active: true } },
  { at: 54500, ev: { type: 'speech.stt', active: false } },
  { at: 54600, ev: { type: 'message.user', text: 'nice work — take a nap, you earned it' } },
  {
    at: 55600,
    ev: { type: 'message.agent', text: 'Compacting memories. Wake me if prod catches fire.' },
  },
  { at: 58500, ev: { type: 'activity', activity: 'sleeping' } },
  { at: 70000, ev: { type: 'activity', activity: 'idle' } },
]

export const DEMO_LOOP_MS = 76000
