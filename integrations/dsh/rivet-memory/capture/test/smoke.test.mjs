#!/usr/bin/env node
/**
 * Smoke tests for the dsh capture worker.
 *
 * These pin the three regressions that made dsh capture under-perform
 * claude-code and grok-build: transcript discovery, event extraction, and
 * dedup-key stability. No database or network is touched.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  findSessionFiles,
  messagesFromSessionEvent,
  eventIdFromEvent,
  deriveSessionKey,
  foldToolResultsInto,
} from '../deepseek-memory-capture.mjs'

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-capture-test-'))
}

test('findSessionFiles accepts versioned transcripts', () => {
  const root = tempRoot()
  const ws = path.join(root, '--home-phil--')
  for (const name of ['session.v4.jsonl.zstd', 'session.jsonl.zstd', 'session.v5.jsonl']) {
    fs.mkdirSync(path.join(ws, name.replace(/\.jsonl.*$/, '-dir')), { recursive: true })
    fs.writeFileSync(path.join(ws, name.replace(/\.jsonl.*$/, '-dir'), name), '')
  }
  const found = findSessionFiles(root).map(f => path.basename(f)).sort()
  assert.deepEqual(found, ['session.jsonl.zstd', 'session.v4.jsonl.zstd', 'session.v5.jsonl'])
})

test('findSessionFiles ignores unrelated names', () => {
  const root = tempRoot()
  fs.mkdirSync(path.join(root, 'session-x'), { recursive: true })
  for (const name of ['session.lock', 'notes.jsonl', 'session.v4.jsonl.zstd.bak']) {
    fs.writeFileSync(path.join(root, 'session-x', name), '')
  }
  assert.equal(findSessionFiles(root).length, 0)
})

test('user/message with a non-user source is skipped', () => {
  const event = { type: 'user/message', seq: 1, data: { source: { kind: 'subagent' }, content: 'hi' } }
  assert.equal(messagesFromSessionEvent('s1', event, {}).length, 0)
})

test('assistant/message and turn/end extract one row each', () => {
  const assistant = {
    type: 'assistant/message',
    seq: 2,
    data: { message: { content: [{ type: 'text', text: 'PROFILE OK' }] } },
  }
  const turnEnd = { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } }
  assert.deepEqual(
    messagesFromSessionEvent('s1', assistant, {}).map(m => m.role),
    ['assistant'],
  )
  assert.deepEqual(
    messagesFromSessionEvent('s1', turnEnd, {}).map(m => m.role),
    ['system'],
  )
})

test('event ids are stable per uuid and namespaced per session', () => {
  const event = { type: 'user/message', seq: 1, id: 'uuid-1', data: { content: 'hi' } }
  assert.equal(eventIdFromEvent('s1', event), 'dsh:s1:uuid-1')
  assert.equal(eventIdFromEvent('s2', event), 'dsh:s2:uuid-1')
  // Same content, different seq -> different ids, so repeats do not collapse.
  const repeatA = { type: 'user/message', seq: 4, data: { content: 'ok' } }
  const repeatB = { type: 'user/message', seq: 9, data: { content: 'ok' } }
  assert.notEqual(eventIdFromEvent('s1', repeatA), eventIdFromEvent('s1', repeatB))
})

test('session key is namespaced to the dsh channel', () => {
  assert.equal(deriveSessionKey('session-abc'), 'dsh:session-abc')
})

test('foldToolResultsInto merges a result into its call row', () => {
  const messages = [
    {
      role: 'tool', content: '[tool] read', eventId: 'a', toolName: 'read',
      toolArgs: { path: 'x' }, extra: { sourceEvent: 'tool/call', callId: 'c1', lineIndex: 10 },
    },
    {
      role: 'tool', content: 'file body', eventId: 'b', toolName: 'read',
      extra: { sourceEvent: 'tool/result', callId: 'c1', lineIndex: 11 },
    },
  ]
  const out = foldToolResultsInto(messages)
  assert.equal(out.length, 1)
  assert.deepEqual(out[0].toolArgs, { path: 'x' })
  assert.equal(out[0].toolResult, 'file body')
  assert.equal(out[0].eventId, 'a')
  // The result's own line stays reachable for disk-backed recovery.
  assert.equal(out[0].extra.resultLineIndex, 11)
})

test('foldToolResultsInto keeps an unpaired result', () => {
  const messages = [
    { role: 'tool', content: 'orphan', eventId: 'c', toolName: 'grep', extra: { sourceEvent: 'tool/result', callId: 'c2' } },
  ]
  assert.equal(foldToolResultsInto(messages).length, 1)
})
