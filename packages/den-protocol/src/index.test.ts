import { describe, expect, it } from 'vitest';
import {
  initialDenState,
  initialRoomState,
  listSessions,
  parseEvent,
  reduceDen,
  reduceRoom,
  toolActivity,
  type AgentEvent,
  type AgentEventBody,
} from './index.js';

const ev = (session: string, body: AgentEventBody, extra?: Partial<AgentEvent>): AgentEvent =>
  ({ v: 1, session, ...body, ...extra }) as AgentEvent;

const run = (events: AgentEvent[]) => events.reduce(reduceDen, initialDenState);

describe('parseEvent', () => {
  it('accepts valid v1 events', () => {
    expect(parseEvent({ v: 1, session: 's1', type: 'session.start', title: 'hi' })).not.toBeNull();
    expect(parseEvent({ v: 1, session: 's1', type: 'tool.start', tool: 'Bash' })).not.toBeNull();
    expect(parseEvent({ v: 1, session: 's1', type: 'tool.end' })).not.toBeNull();
    expect(parseEvent({ v: 1, session: 's1', type: 'speech.stt', active: true })).not.toBeNull();
    expect(parseEvent({ v: 1, session: 's1', type: 'task.plan', tasks: ['a', 'b'] })).not.toBeNull();
    expect(parseEvent({ v: 1, session: 's1', type: 'turn.end' })).not.toBeNull();
  });

  it('rejects malformed events', () => {
    expect(parseEvent(null)).toBeNull();
    expect(parseEvent('x')).toBeNull();
    expect(parseEvent({ session: 's1', type: 'session.end' })).toBeNull(); // no v
    expect(parseEvent({ v: 2, session: 's1', type: 'session.end' })).toBeNull(); // wrong v
    expect(parseEvent({ v: 1, type: 'session.end' })).toBeNull(); // no session
    expect(parseEvent({ v: 1, session: 's1', type: 'nope' })).toBeNull();
    expect(parseEvent({ v: 1, session: 's1', type: 'tool.start' })).toBeNull(); // no name
    expect(parseEvent({ v: 1, session: 's1', type: 'activity', activity: 'dancing' })).toBeNull();
    expect(parseEvent({ v: 1, session: 's1', type: 'task.check', index: -1 })).toBeNull();
    expect(parseEvent({ v: 1, session: 's1', type: 'task.plan', tasks: ['a', 3] })).toBeNull();
  });

  it('rejects wrong-typed envelope optionals', () => {
    expect(parseEvent({ v: 1, session: 's1', type: 'session.end', ts: 'abc' })).toBeNull();
    expect(parseEvent({ v: 1, session: 's1', type: 'session.end', ts: NaN })).toBeNull();
    expect(parseEvent({ v: 1, session: 's1', type: 'session.end', name: 42 })).toBeNull();
    expect(parseEvent({ v: 1, session: 's1', type: 'session.end', harness: {} })).toBeNull();
    expect(parseEvent({ v: 1, session: 's1', type: 'session.end', ts: 5, name: 'n' })).not.toBeNull();
  });

  it('accepts message.agent turn stats and preserves them', () => {
    const ev = parseEvent({
      v: 1,
      session: 's1',
      type: 'message.agent',
      text: 'done',
      usage: { promptTokens: 100, completionTokens: 20, cachedTokens: 80 },
      model: 'claude-opus-4-8',
      durationMs: 1500,
    });
    expect(ev).not.toBeNull();
    // parseEvent returns the raw object — extra fields must survive for the bridge
    expect((ev as { usage?: unknown }).usage).toEqual({
      promptTokens: 100,
      completionTokens: 20,
      cachedTokens: 80,
    });
    expect((ev as { model?: unknown }).model).toBe('claude-opus-4-8');
    // a plain message.agent (no stats) is still valid
    expect(parseEvent({ v: 1, session: 's1', type: 'message.agent', text: 'hi' })).not.toBeNull();
  });

  it('rejects malformed message.agent turn stats', () => {
    const base = { v: 1, session: 's1', type: 'message.agent', text: 'x' } as const;
    expect(parseEvent({ ...base, model: 42 })).toBeNull();
    expect(parseEvent({ ...base, durationMs: 'slow' })).toBeNull();
    expect(parseEvent({ ...base, durationMs: -5 })).toBeNull();
    expect(parseEvent({ ...base, usage: { promptTokens: 1, completionTokens: 2 } })).toBeNull(); // missing cachedTokens
    expect(parseEvent({ ...base, usage: { promptTokens: -1, completionTokens: 2, cachedTokens: 0 } })).toBeNull();
    expect(parseEvent({ ...base, usage: 'lots' })).toBeNull();
  });
});

describe('toolActivity fallback mapping', () => {
  it('maps well-known tools', () => {
    expect(toolActivity('WebSearch')).toBe('searching_web');
    expect(toolActivity('mcp:rivetos:internet_search')).toBe('searching_web');
    expect(toolActivity('Edit')).toBe('editing_code');
    expect(toolActivity('Write')).toBe('editing_code');
    expect(toolActivity('Read')).toBe('thinking');
    expect(toolActivity('TaskCreate')).toBe('writing_plan');
  });
  it('maps shell tools to the computer, unknown tools to the toolbox', () => {
    expect(toolActivity('Bash')).toBe('editing_code');
    expect(toolActivity('run_terminal_cmd')).toBe('editing_code');
    expect(toolActivity('mcp:whatever:frobnicate')).toBe('running_command');
  });
});

describe('reduceRoom', () => {
  it('tool.start sets tool + derived activity; tool.end clears back to thinking', () => {
    let s = reduceRoom(initialRoomState, ev('s', { type: 'tool.start', tool: 'Bash' }));
    expect(s.tool).toBe('Bash');
    expect(s.activity).toBe('editing_code');
    s = reduceRoom(s, ev('s', { type: 'tool.end' }));
    expect(s.tool).toBeNull();
    expect(s.activity).toBe('thinking');
  });

  it('adapter-supplied activity wins over the derived one', () => {
    const s = reduceRoom(
      initialRoomState,
      ev('s', { type: 'tool.start', tool: 'CustomTool', activity: 'searching_web' }),
    );
    expect(s.activity).toBe('searching_web');
  });

  it('log survives session.start; the rest resets', () => {
    let s = reduceRoom(initialRoomState, ev('s', { type: 'message.user', text: 'hi' }));
    s = reduceRoom(s, ev('s', { type: 'session.start', title: 'round 2' }));
    expect(s.log).toHaveLength(1);
    expect(s.title).toBe('round 2');
    expect(s.tasks).toHaveLength(0);
  });

  it('thinking window trims to a word boundary when full', () => {
    // variable-length words so slice(-220) cannot accidentally land on a
    // boundary — a fixed 5-char delta made this test pass with the trim removed
    const words = ['a', 'bb', 'ccc', 'dddd', 'eeeeeee', 'ffffffffff', 'ggggg'];
    let s = initialRoomState;
    for (let i = 0; i < 120; i++)
      s = reduceRoom(s, ev('s', { type: 'thinking.delta', text: `${words[i % words.length]} ` }));
    expect(s.thought.length).toBeLessThanOrEqual(220);
    // every chunk in the window must be one of the source words — no leading
    // partial word cut mid-stream
    for (const w of s.thought.trimEnd().split(' ')) expect(words).toContain(w);
  });

  it('turn.end settles the room to idle without ending it', () => {
    let s = reduceRoom(initialRoomState, ev('s', { type: 'message.agent', text: 'done!' }));
    expect(s.activity).toBe('speaking');
    s = reduceRoom(s, ev('s', { type: 'turn.end' }));
    expect(s.activity).toBe('idle');
    expect(s.ended).toBe(false);
    expect(s.log).toHaveLength(1); // the reply stays in the log
    // a new turn still lands normally
    s = reduceRoom(s, ev('s', { type: 'message.user', text: 'next' }));
    expect(s.log).toHaveLength(2);
  });

  it('ignores unknown event types (additive-within-v1)', () => {
    let s = reduceRoom(initialRoomState, ev('s', { type: 'tool.start', tool: 'Bash' }));
    const next = reduceRoom(s, { v: 1, session: 's', type: 'confetti.burst' } as unknown as AgentEvent);
    expect(next).toEqual(s);
  });

  it('an ended room ignores everything but session.start', () => {
    let s = reduceRoom(initialRoomState, ev('s', { type: 'session.end' }));
    expect(s.ended).toBe(true);
    s = reduceRoom(s, ev('s', { type: 'tool.end' }));
    s = reduceRoom(s, ev('s', { type: 'speech.stt', active: false }));
    expect(s.activity).toBe('sleeping');
    expect(s.ended).toBe(true);
    s = reduceRoom(s, ev('s', { type: 'session.start', title: 'back' }));
    expect(s.ended).toBe(false);
    expect(s.title).toBe('back');
  });
});

describe('reduceDen (multi-session)', () => {
  it('keeps one room per session', () => {
    const den = run([
      ev('a', { type: 'session.start', title: 'A' }, { name: 'alpha', ts: 100 }),
      ev('b', { type: 'session.start', title: 'B' }, { ts: 200 }),
      ev('a', { type: 'tool.start', tool: 'Bash' }, { ts: 300 }),
    ]);
    expect(Object.keys(den.rooms)).toEqual(['a', 'b']);
    expect(den.rooms.a.activity).toBe('editing_code');
    expect(den.rooms.b.activity).toBe('idle');
  });

  it('session list is recency-ordered, keeps names and harness', () => {
    const den = run([
      ev('a', { type: 'session.start', title: 'A' }, { name: 'alpha', harness: 'claude-code', ts: 100 }),
      ev('b', { type: 'session.start', title: 'B' }, { ts: 200 }),
      ev('a', { type: 'thinking.end' }, { ts: 300 }),
    ]);
    const list = listSessions(den);
    expect(list.map((s) => s.id)).toEqual(['a', 'b']);
    expect(list[0].name).toBe('alpha'); // sticky across later events without name
    expect(list[0].harness).toBe('claude-code');
    expect(list[1].name).toBe('b'); // falls back to id
  });

  it('lastEventTs is monotonic under out-of-order delivery', () => {
    const den = run([
      ev('a', { type: 'session.start', title: 'A' }, { ts: 100 }),
      ev('b', { type: 'session.start', title: 'B' }, { ts: 200 }),
      ev('a', { type: 'thinking.end' }, { ts: 300 }),
      ev('a', { type: 'tool.end' }, { ts: 150 }), // stale retry
    ]);
    expect(den.sessions.a.lastEventTs).toBe(300);
    expect(listSessions(den).map((s) => s.id)).toEqual(['a', 'b']);
  });
});

// Golden-file tests: recorded event streams → full RoomState snapshots
// (stored under __snapshots__/). If a reducer change alters these on purpose,
// review the diff and update with `vitest -u`.
describe('golden streams', () => {
  it('typical coding session', () => {
    const den = run([
      ev('s1', { type: 'session.start', title: 'fix the flaky test' }, { name: 'rivet-claude', harness: 'claude-code', ts: 1 }),
      ev('s1', { type: 'message.user', text: 'fix the flaky test in ci' }, { ts: 2 }),
      ev('s1', { type: 'thinking.delta', text: 'Looking at the CI logs first… ' }, { ts: 3 }),
      ev('s1', { type: 'task.plan', tasks: ['find flaky test', 'fix it', 'verify'] }, { ts: 4 }),
      ev('s1', { type: 'tool.start', tool: 'Grep' }, { ts: 5 }),
      ev('s1', { type: 'tool.end', tool: 'Grep' }, { ts: 6 }),
      ev('s1', { type: 'task.check', index: 0 }, { ts: 7 }),
      ev('s1', { type: 'tool.start', tool: 'Edit' }, { ts: 8 }),
      ev('s1', { type: 'tool.end', tool: 'Edit' }, { ts: 9 }),
      ev('s1', { type: 'task.check', index: 1 }, { ts: 10 }),
      ev('s1', { type: 'tool.start', tool: 'Bash' }, { ts: 11 }),
      ev('s1', { type: 'term.line', text: '$ npm test' }, { ts: 12 }),
      ev('s1', { type: 'term.line', text: '42 passing' }, { ts: 13 }),
      ev('s1', { type: 'tool.end', tool: 'Bash' }, { ts: 14 }),
      ev('s1', { type: 'task.check', index: 2 }, { ts: 15 }),
      ev('s1', { type: 'message.agent', text: 'Fixed — all 42 tests pass.' }, { ts: 16 }),
    ]);
    expect(den).toMatchSnapshot();
  });

  it('voice interruption and sleep', () => {
    const den = run([
      ev('s2', { type: 'session.start', title: 'chatting' }, { ts: 1 }),
      ev('s2', { type: 'speech.stt', active: true }, { ts: 2 }),
      ev('s2', { type: 'speech.stt', active: false }, { ts: 3 }),
      ev('s2', { type: 'message.agent', text: 'On it.' }, { ts: 4 }),
      ev('s2', { type: 'session.end' }, { ts: 5 }),
    ]);
    expect(den).toMatchSnapshot();
    expect(den.rooms.s2.activity).toBe('sleeping');
    expect(den.rooms.s2.ended).toBe(true);
  });
});
