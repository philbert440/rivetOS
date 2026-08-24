import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  messagesFromSessionEvent,
  contentHashEventId,
  contentText,
  deriveSessionKey,
  parseSessionJsonl,
  eventIdFromEvent,
  capForStorage,
  findEventLineIndex,
  applyToolNamePairing,
  CAPTURE_AGENT,
  CAPTURE_CHANNEL,
} from '../deepseek-memory-capture.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = name =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'))

test('identity constants', () => {
  assert.equal(CAPTURE_AGENT, 'rivet-deepseek')
  assert.equal(CAPTURE_CHANNEL, 'dsh')
  assert.equal(deriveSessionKey('abc'), 'dsh:abc')
})

test('contentText joins text parts and prefixes thinking', () => {
  assert.equal(contentText('  hello  '), 'hello')
  assert.equal(
    contentText([{ type: 'text', text: 'dsh ok' }]),
    'dsh ok',
  )
  assert.equal(
    contentText([{ type: 'think', text: 'hmm' }, { type: 'text', text: 'done' }]),
    '[thinking] hmm\ndone',
  )
})

test('user/message from fixture uses dsh event uuid', () => {
  const ev = FIXTURE('user-message.json')
  const msgs = messagesFromSessionEvent('sess-1', ev)
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0].role, 'user')
  assert.match(msgs[0].content, /dsh ok/)
  assert.equal(msgs[0].eventId, 'dsh:sess-1:31f87573-b8d6-4a8a-900d-994b313afc44')
  assert.equal(msgs[0].extra.dsh_event_uuid, '31f87573-b8d6-4a8a-900d-994b313afc44')
})

test('plugin-injected user/message is skipped', () => {
  const ev = FIXTURE('plugin-user-message.json')
  const msgs = messagesFromSessionEvent('sess-1', ev)
  assert.equal(msgs.length, 0)
})

test('assistant/message from fixture', () => {
  const ev = FIXTURE('assistant-message.json')
  const msgs = messagesFromSessionEvent('sess-1', ev)
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0].role, 'assistant')
  assert.equal(msgs[0].content, 'dsh ok')
  assert.equal(msgs[0].extra.model, 'deepseek-v4-pro')
})

test('content-hash is stable and changes with content', () => {
  const a = contentHashEventId({ sessionId: 's', role: 'user', content: 'x', sourceEvent: 'user/message:7' })
  const b = contentHashEventId({ sessionId: 's', role: 'user', content: 'x', sourceEvent: 'user/message:7' })
  const c = contentHashEventId({ sessionId: 's', role: 'user', content: 'y', sourceEvent: 'user/message:7' })
  assert.equal(a, b)
  assert.notEqual(a, c)
})

test('parseSessionJsonl extracts user+assistant and skips plugin snapshot', () => {
  const header = JSON.stringify({ type: 'session', id: 'session-abc', cwd: '/tmp/x' })
  const user = JSON.stringify(FIXTURE('user-message.json'))
  const plugin = JSON.stringify(FIXTURE('plugin-user-message.json'))
  const assistant = JSON.stringify(FIXTURE('assistant-message.json'))
  const parsed = parseSessionJsonl([header, user, plugin, assistant].join('\n'))
  assert.equal(parsed.sessionId, 'session-abc')
  assert.equal(parsed.cwd, '/tmp/x')
  assert.equal(parsed.messages.length, 2)
  assert.deepEqual(
    parsed.messages.map(m => m.role),
    ['user', 'assistant'],
  )
})

test('same event twice produces identical event_id', () => {
  const ev = FIXTURE('user-message.json')
  const a = messagesFromSessionEvent('sess-1', ev)
  const b = messagesFromSessionEvent('sess-1', ev)
  assert.equal(a[0].eventId, b[0].eventId)
})

test('repeated identical content keeps distinct event ids (#525)', () => {
  const first = FIXTURE('user-message.json')
  const second = structuredClone(first)
  second.seq = 99
  second.data.id = '22222222-2222-2222-2222-222222222222'
  const a = messagesFromSessionEvent('sess-1', first)
  const b = messagesFromSessionEvent('sess-1', second)
  assert.equal(a[0].content, b[0].content)
  assert.notEqual(a[0].eventId, b[0].eventId)
})

test('eventIdFromEvent falls back to session+seq when no uuid', () => {
  const id = eventIdFromEvent('s', { type: 'turn/end', seq: 23, data: { reason: { kind: 'completed' } } })
  assert.equal(id, 'dsh:s:seq:23')
})

test('tool/call and tool/result map to role=tool', () => {
  const call = messagesFromSessionEvent('sess-1', FIXTURE('tool-call.json'))
  const result = messagesFromSessionEvent('sess-1', FIXTURE('tool-result.json'))
  assert.equal(call.length, 1)
  assert.equal(call[0].role, 'tool')
  assert.equal(call[0].toolName, 'bash')
  assert.match(call[0].toolArgs, /rivet-tool-probe/)
  assert.equal(call[0].eventId, 'dsh:sess-1:call-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
  assert.equal(result.length, 1)
  assert.equal(result[0].role, 'tool')
  assert.match(result[0].toolResult, /Created file/)
  assert.equal(result[0].eventId, 'dsh:sess-1:02bb524e-220e-4d3c-a8ea-1899030c8499')
  applyToolNamePairing([...call, ...result])
  assert.equal(result[0].toolName, 'bash')
  assert.match(result[0].content, /\[tool-result\] bash/)
})

test('capForStorage never silent-truncates without a pointer', () => {
  const big = 'x'.repeat(20000)
  const noPtr = capForStorage(big, null)
  assert.equal(noPtr.truncated, false)
  assert.equal(noPtr.stored, big)
  assert.equal(noPtr.uncapped, true)
  const withPtr = capForStorage(big, { sessionJsonlPath: '/tmp/session.jsonl.zstd', lineIndex: 4 })
  assert.equal(withPtr.truncated, true)
  assert.match(withPtr.stored, /truncated/)
  assert.ok(withPtr.stored.length < big.length)
})

test('parseSessionJsonl records absolute path + line offset', () => {
  const header = JSON.stringify({ type: 'session', id: 'session-abc', cwd: '/tmp/x' })
  const user = JSON.stringify(FIXTURE('user-message.json'))
  const plugin = JSON.stringify(FIXTURE('plugin-user-message.json'))
  const assistant = JSON.stringify(FIXTURE('assistant-message.json'))
  const text = [header, user, plugin, assistant].join('\n')
  const parsed = parseSessionJsonl(text, null, '/home/rivet/.dsh/sessions/ws/session-abc/session.jsonl.zstd')
  assert.equal(parsed.messages.length, 2)
  assert.equal(parsed.messages[0].extra.session_jsonl_path, '/home/rivet/.dsh/sessions/ws/session-abc/session.jsonl.zstd')
  assert.equal(parsed.messages[0].extra.session_jsonl_line, 1)
  assert.equal(parsed.messages[1].extra.session_jsonl_line, 3)
  assert.equal(findEventLineIndex(text, FIXTURE('user-message.json')), 1)
})
