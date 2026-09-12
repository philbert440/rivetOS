import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LanguageModelV3Prompt, LanguageModelV3StreamPart } from '@ai-sdk/provider'
import type { Provider, RegistrationContext } from '@rivetos/types'
import {
  HermesCliModel,
  HermesCliProvider,
  buildArgs,
  loadSessionMap,
  manifest,
  promptFromV3,
  saveSessionMap,
  sessionIdFromStderr,
} from './index.js'

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-cli-'))
}
function fakeScript(body: string): string {
  const file = path.join(tmp(), 'hermes')
  fs.writeFileSync(file, body, { mode: 0o755 })
  return file
}
const prompt: LanguageModelV3Prompt = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: [{ type: 'text', text: 'first' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
  { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'there' }] },
]
async function collect(model: HermesCliModel, p: LanguageModelV3Prompt): Promise<LanguageModelV3StreamPart[]> {
  const { stream } = await model.doStream({ prompt: p })
  const parts: LanguageModelV3StreamPart[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
  }
  return parts
}
function model(
  binary: string,
  mapPath: string,
  conversationId = 'conv-1',
  hermesDbPath?: string,
): HermesCliModel {
  return new HermesCliModel({
    providerId: 'hermes-cli',
    modelId: 'qwen-27b',
    binary,
    cwd: undefined,
    conversationId,
    sessionMapPath: mapPath,
    hermesDbPath,
  })
}

describe('helpers', () => {
  it('promptFromV3 takes the newest user message, text parts joined', () => {
    expect(promptFromV3(prompt)).toBe('hello\nthere')
    expect(promptFromV3([])).toBe('')
  })
  it('buildArgs: quiet chat with model, cwd and resume', () => {
    expect(buildArgs({ binary: 'h' }, 'q')).toEqual(['chat', '-q', 'q', '-Q', '--yolo', '--cli'])
    expect(buildArgs({ binary: 'h', modelId: 'm', cwd: '/w', sessionId: 's1' }, '')).toEqual([
      'chat', '-q', '(empty)', '-Q', '--yolo', '--cli', '-m', 'm', '--in', '/w', '--resume', 's1',
    ])
  })
  it('sessionIdFromStderr', () => {
    expect(sessionIdFromStderr('noise\nsession_id: abc-123\n')).toBe('abc-123')
    expect(sessionIdFromStderr('nothing')).toBeUndefined()
  })
  it('session map round-trips and tolerates garbage', () => {
    const p = path.join(tmp(), 'map.json')
    expect(loadSessionMap(p)).toEqual({})
    saveSessionMap(p, { a: '1' })
    expect(loadSessionMap(p)).toEqual({ a: '1' })
    fs.writeFileSync(p, '{not json')
    expect(loadSessionMap(p)).toEqual({})
    fs.writeFileSync(p, JSON.stringify({ a: 1, b: 'ok' }))
    expect(loadSessionMap(p)).toEqual({ b: 'ok' })
  })
})

describe('HermesCliModel.doStream', () => {
  it('streams stdout as text and remembers the session id from stderr', async () => {
    const bin = fakeScript('#!/usr/bin/env bash\necho "session_id: sess-9" >&2\nprintf "PONG"\n')
    const mapPath = path.join(tmp(), 'map.json')
    const parts = await collect(model(bin, mapPath), prompt)
    expect(parts.map((p) => p.type)).toEqual(['stream-start', 'text-start', 'text-delta', 'text-end', 'finish'])
    const fin = parts.find((p) => p.type === 'finish')
    expect(fin && fin.type === 'finish' ? fin.finishReason.unified : '').toBe('stop')
    expect(loadSessionMap(mapPath)).toEqual({ 'conv-1': 'sess-9' })
  })
  it('passes --resume when the conversation already has a session', async () => {
    const bin = fakeScript('#!/usr/bin/env bash\nprintf "%s" "$*"\n')
    const mapPath = path.join(tmp(), 'map.json')
    saveSessionMap(mapPath, { 'conv-1': 'old-7' })
    const parts = await collect(model(bin, mapPath), prompt)
    const text = parts.filter((p) => p.type === 'text-delta').map((p) => ('delta' in p ? p.delta : '')).join('')
    expect(text).toContain('--resume old-7')
    expect(text).toContain('-q hello')
  })
  it('missing binary → error + finish(error)', async () => {
    const parts = await collect(model('/nonexistent/hermes', path.join(tmp(), 'm.json')), prompt)
    expect(parts.map((p) => p.type)).toEqual(['stream-start', 'error', 'finish'])
  })
  it('non-zero exit without output surfaces a bridge error line', async () => {
    const bin = fakeScript('#!/usr/bin/env bash\necho boom >&2\nexit 3\n')
    const parts = await collect(model(bin, path.join(tmp(), 'm.json')), prompt)
    const text = parts.filter((p) => p.type === 'text-delta').map((p) => ('delta' in p ? p.delta : '')).join('')
    expect(text).toContain('bridge error')
    expect(text).toContain('boom')
    const fin = parts.find((p) => p.type === 'finish')
    expect(fin && fin.type === 'finish' ? fin.finishReason.unified : '').toBe('error')
  })
  it('doGenerate accumulates text', async () => {
    const bin = fakeScript('#!/usr/bin/env bash\nprintf "a"; printf "b"\n')
    const r = await model(bin, path.join(tmp(), 'm.json')).doGenerate({ prompt })
    expect(r.content).toEqual([{ type: 'text', text: 'ab' }])
  })

  it('finish.usage is empty when state.db is missing (does not throw)', async () => {
    const bin = fakeScript('#!/usr/bin/env bash\necho "session_id: sess-9" >&2\nprintf "PONG"\n')
    const parts = await collect(
      model(bin, path.join(tmp(), 'map.json'), 'conv-1', path.join(tmp(), 'state.db')),
      prompt,
    )
    const fin = parts.find((p) => p.type === 'finish')
    expect(fin && fin.type === 'finish' ? fin.usage.inputTokens.total : 'missing').toBeUndefined()
    expect(fin && fin.type === 'finish' ? fin.usage.outputTokens.total : 'missing').toBeUndefined()
  })

  it('finish.usage reads session totals from state.db after exit', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const dbFile = path.join(tmp(), 'state.db')
    const db = new DatabaseSync(dbFile)
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, started_at INTEGER, ended_at INTEGER,
        input_tokens INTEGER, output_tokens INTEGER
      );
      INSERT INTO sessions VALUES ('sess-9', 1000, 2000, 42, 7);
    `)
    db.close()
    const bin = fakeScript('#!/usr/bin/env bash\necho "session_id: sess-9" >&2\nprintf "PONG"\n')
    const parts = await collect(model(bin, path.join(tmp(), 'map.json'), 'conv-1', dbFile), prompt)
    const fin = parts.find((p) => p.type === 'finish')
    expect(fin && fin.type === 'finish' ? fin.usage.inputTokens.total : undefined).toBe(42)
    expect(fin && fin.type === 'finish' ? fin.usage.outputTokens.total : undefined).toBe(7)
    expect(fin && fin.type === 'finish' ? fin.usage.inputTokens.noCache : 'missing').toBeUndefined()
  })

  it('doGenerate usage matches the stream finish usage', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const dbFile = path.join(tmp(), 'state.db')
    const db = new DatabaseSync(dbFile)
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, started_at INTEGER, ended_at INTEGER,
        input_tokens INTEGER, output_tokens INTEGER
      );
      INSERT INTO sessions VALUES ('sess-g', 1, 2, 9, 3);
    `)
    db.close()
    const bin = fakeScript('#!/usr/bin/env bash\necho "session_id: sess-g" >&2\nprintf "ok"\n')
    const r = await model(bin, path.join(tmp(), 'm.json'), 'conv-1', dbFile).doGenerate({ prompt })
    expect(r.usage.inputTokens.total).toBe(9)
    expect(r.usage.outputTokens.total).toBe(3)
  })

  it('resume with decreasing message counts reports the new message as-is (not a delta)', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const dir = tmp()
    const dbFile = path.join(dir, 'state.db')
    const db = new DatabaseSync(dbFile)
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at INTEGER, ended_at INTEGER);
      CREATE TABLE messages (
        session_id TEXT, role TEXT, content TEXT, timestamp INTEGER,
        input_tokens INTEGER, output_tokens INTEGER
      );
      INSERT INTO sessions VALUES ('sess-m', 1000, 2000);
      INSERT INTO messages VALUES ('sess-m','assistant','a',1001,100,20);
    `)
    db.close()
    const update = path.join(dir, 'update.mjs')
    fs.writeFileSync(
      update,
      `import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(${JSON.stringify(dbFile)});
db.exec("INSERT INTO messages VALUES ('sess-m','assistant','b',1002,60,10)");
db.close();
`,
    )
    const bin = fakeScript(
      `#!/usr/bin/env bash\nnode ${JSON.stringify(update)}\necho "session_id: sess-m" >&2\nprintf "PONG"\n`,
    )
    const mapPath = path.join(dir, 'map.json')
    saveSessionMap(mapPath, { 'conv-1': 'sess-m' })
    const parts = await collect(model(bin, mapPath, 'conv-1', dbFile), prompt)
    const fin = parts.find((p) => p.type === 'finish')
    expect(fin && fin.type === 'finish' ? fin.usage.inputTokens.total : undefined).toBe(60)
    expect(fin && fin.type === 'finish' ? fin.usage.outputTokens.total : undefined).toBe(10)
  })

  it('resume whose pre-spawn db read fails reports empty usage (not lifetime totals)', async () => {
    await import('node:sqlite')
    const dir = tmp()
    const dbFile = path.join(dir, 'state.db')
    const update = path.join(dir, 'create.mjs')
    fs.writeFileSync(
      update,
      `import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(${JSON.stringify(dbFile)});
db.exec(\`
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, started_at INTEGER, ended_at INTEGER,
    input_tokens INTEGER, output_tokens INTEGER
  );
  INSERT INTO sessions VALUES ('sess-r', 1, 2, 100100, 10010);
\`);
db.close();
`,
    )
    const bin = fakeScript(
      `#!/usr/bin/env bash\nnode ${JSON.stringify(update)}\necho "session_id: sess-r" >&2\nprintf "PONG"\n`,
    )
    const mapPath = path.join(dir, 'map.json')
    saveSessionMap(mapPath, { 'conv-1': 'sess-r' })
    const parts = await collect(model(bin, mapPath, 'conv-1', dbFile), prompt)
    expect(fs.existsSync(dbFile)).toBe(true)
    const fin = parts.find((p) => p.type === 'finish')
    expect(fin && fin.type === 'finish' ? fin.usage.inputTokens.total : 'missing').toBeUndefined()
    expect(fin && fin.type === 'finish' ? fin.usage.outputTokens.total : 'missing').toBeUndefined()
  })

  it('resume session-total subtracts the pre-spawn baseline', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const dir = tmp()
    const dbFile = path.join(dir, 'state.db')
    const db = new DatabaseSync(dbFile)
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, started_at INTEGER, ended_at INTEGER,
        input_tokens INTEGER, output_tokens INTEGER
      );
      INSERT INTO sessions VALUES ('sess-d', 1, 2, 100, 10);
    `)
    db.close()
    const update = path.join(dir, 'bump.mjs')
    fs.writeFileSync(
      update,
      `import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(${JSON.stringify(dbFile)});
db.exec("UPDATE sessions SET input_tokens = 150, output_tokens = 40 WHERE id = 'sess-d'");
db.close();
`,
    )
    const bin = fakeScript(
      `#!/usr/bin/env bash\nnode ${JSON.stringify(update)}\necho "session_id: sess-d" >&2\nprintf "PONG"\n`,
    )
    const mapPath = path.join(dir, 'map.json')
    saveSessionMap(mapPath, { 'conv-1': 'sess-d' })
    const parts = await collect(model(bin, mapPath, 'conv-1', dbFile), prompt)
    const fin = parts.find((p) => p.type === 'finish')
    expect(fin && fin.type === 'finish' ? fin.usage.inputTokens.total : undefined).toBe(50)
    expect(fin && fin.type === 'finish' ? fin.usage.outputTokens.total : undefined).toBe(30)
  })

  it('falls back to the saved session map when stderr is trimmed past session_id', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const dir = tmp()
    const dbFile = path.join(dir, 'state.db')
    const db = new DatabaseSync(dbFile)
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, started_at INTEGER, ended_at INTEGER,
        input_tokens INTEGER, output_tokens INTEGER
      );
      INSERT INTO sessions VALUES ('sess-trim', 1, 2, 5, 1);
    `)
    db.close()
    const bin = fakeScript(
      `#!/usr/bin/env bash
echo "session_id: sess-trim" >&2
node -e "process.stderr.write('n'.repeat(70000))"
printf "PONG"
`,
    )
    const mapPath = path.join(dir, 'map.json')
    const parts = await collect(model(bin, mapPath, 'conv-1', dbFile), prompt)
    expect(loadSessionMap(mapPath)).toEqual({ 'conv-1': 'sess-trim' })
    const fin = parts.find((p) => p.type === 'finish')
    expect(fin && fin.type === 'finish' ? fin.usage.inputTokens.total : undefined).toBe(5)
    expect(fin && fin.type === 'finish' ? fin.usage.outputTokens.total : undefined).toBe(1)
  })
})

describe('provider + manifest', () => {
  it('defaults and bridge', async () => {
    const p = new HermesCliProvider({ binary: '/nonexistent/hermes' })
    expect(p.id).toBe('hermes-cli')
    expect(p.getModel()).toBe('qwen-27b')
    expect(p.getContextWindow()).toBe(262_144)
    expect(await p.isAvailable()).toBe(false)
    const m = p.aiSdkBridge().getModel({ modelOverride: 'x', conversationId: 'c' }) as unknown as { modelId: string; provider: string }
    expect(m.modelId).toBe('x')
    expect(m.provider).toBe('hermes-cli')
    expect(p.aiSdkBridge().buildProviderOptions([], undefined)).toBeUndefined()
  })

  it('isAvailable is true when hermes --version exits 0, and the verdict is cached', async () => {
    const dir = tmp()
    const stamp = path.join(dir, 'probes')
    const bin = path.join(dir, 'hermes')
    fs.writeFileSync(
      bin,
      `#!/usr/bin/env bash\necho probed >> ${JSON.stringify(stamp)}\necho "Hermes Agent v0.20.0 (2026.8.3)"\nexit 0\n`,
      { mode: 0o755 },
    )
    const p = new HermesCliProvider({ binary: bin })
    expect(await p.isAvailable()).toBe(true)
    expect(await p.isAvailable()).toBe(true)
    expect(fs.readFileSync(stamp, 'utf8').trim().split('\n')).toEqual(['probed'])
  })

  it('isAvailable is false when --version exits non-zero (cached)', async () => {
    const bin = fakeScript('#!/usr/bin/env bash\nexit 3\n')
    const p = new HermesCliProvider({ binary: bin })
    expect(await p.isAvailable()).toBe(false)
    expect(await p.isAvailable()).toBe(false)
  })
  it('manifest registers from snake_case config', () => {
    let registered: Provider | undefined
    const ctx = {
      pluginConfig: { model: 'custom/qwen-27b', binary: '/x/hermes', context_window: '262144', max_output_tokens: 'nope' },
      registerProvider: (p: Provider) => {
        registered = p
      },
    } as unknown as RegistrationContext
    void manifest.register(ctx)
    expect(manifest.name).toBe('hermes-cli')
    expect(registered?.getModel()).toBe('custom/qwen-27b')
    expect(registered?.getContextWindow()).toBe(262_144)
    expect(registered?.getMaxOutputTokens()).toBe(81_920)
  })
})
