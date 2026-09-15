/**
 * Fake `qwen` binaries for the executor tests.
 *
 * A shell script that records argv + env, optionally writes a qwen-shaped
 * session jsonl into a throwaway data dir (`home/projects/<enc>/chats/<id>.jsonl`),
 * prints canned stream-json on stdout and exits with a chosen code. The real
 * binary is never invoked, no provider tokens are spent, and nothing touches
 * the operator's `~/.qwen`.
 *
 * Lives under `src/test/` rather than a top-level `test/` so the package's
 * tsconfig picks it up as ordinary source — same placement as core's
 * `domain/task/test/executor-conformance.ts`. It is a fixture BUILDER, not a
 * suite, so it is not collected by vitest.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { encodeQwenCwd } from '../wire.js'

const INVOCATION_MARK = '--invocation--'

export interface FakeQwenOptions {
  /** stream-json lines printed on stdout (objects are JSON-stringified). */
  lines?: unknown[]
  /** Raw stdout lines, bypassing JSON encoding (malformed-stream tests). */
  raw?: string[]
  /** Exit code. Default 0. */
  exitCode?: number
  /** Text written to stderr before exiting. */
  stderr?: string
  /** Native session id the fake writes a session jsonl for. */
  sessionId?: string
  /** Per-request usage stamped on the on-disk assistant message (real keys). */
  usage?: Array<{
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    promptTokenCount?: number
    candidatesTokenCount?: number
    cachedContentTokenCount?: number
  }>
  /**
   * Behave differently when spawned with `--resume` (resume-rejection tests).
   * Prints the refuse string on stdout and exits 0 — matching real qwen.
   */
  onResume?: { stdout: string; exitCode?: number }
  /** Hang until signalled instead of doing anything else. */
  slow?: boolean
}

export interface FakeQwen {
  binary: string
  dir: string
  /** Throwaway data dir the fake writes session jsonl into (`~/.qwen` layout). */
  home: string
  /** Working directory to spawn in (a throwaway too). */
  cwd: string
  /** argv of the LAST invocation, one element per entry. */
  args: () => string[]
  /** argv of every invocation, oldest first. */
  invocations: () => string[][]
  /**
   * Raw recorded text per invocation, oldest first. The prompt is a MULTI-LINE
   * argv value, so the line-split `invocations()` view can only be trusted for
   * flags — assert prompt content against this.
   */
  invocationTexts: () => string[]
  /** env of the last invocation as a name→value map. */
  env: () => Record<string, string>
}

const tmpDirs: string[] = []

/** Remove every directory `makeFakeQwen` created. Call from `afterAll`. */
export function cleanupFakeQwen(): void {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
}

function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

export function makeFakeQwen(opts: FakeQwenOptions = {}): FakeQwen {
  const dir = mkTmp('fake-qwen-')
  const home = path.join(dir, 'qwen-home')
  const cwd = path.join(dir, 'work')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(cwd, { recursive: true })

  const binary = path.join(dir, 'qwen')
  const sessionId = opts.sessionId ?? '857b4b7d-3d13-4281-a648-11947cf530ed'
  const stdout = (opts.raw ?? (opts.lines ?? []).map((l) => JSON.stringify(l))).join('\n')
  fs.writeFileSync(path.join(dir, 'stdout.txt'), stdout === '' ? '' : stdout + '\n')

  const script: string[] = [
    '#!/usr/bin/env bash',
    // qwen appends stdin to the prompt and waits if the fd is an open pipe.
    'if [ -p /dev/stdin ]; then',
    "  printf '%s\\n' 'stdin was a pipe' >&2",
    '  exit 99',
    'fi',
    `printf '%s\\n' "${INVOCATION_MARK}" "$@" >> "${dir}/args.txt"`,
    `env > "${dir}/env.txt"`,
  ]

  if (opts.slow === true) {
    script.push('exec sleep 60')
  } else {
    if (opts.onResume) {
      script.push(
        'for a in "$@"; do',
        '  if [ "$a" = "--resume" ]; then',
        `    printf '%s\\n' ${shellQuote(opts.onResume.stdout)}`,
        `    exit ${String(opts.onResume.exitCode ?? 0)}`,
        '  fi',
        'done',
      )
    }
    const usage = opts.usage ?? [
      { promptTokenCount: 100, candidatesTokenCount: 25, cachedContentTokenCount: 10 },
    ]
    const enc = encodeQwenCwd(cwd)
    const chatsDir = path.join(home, 'projects', enc, 'chats')
    const wire = path.join(chatsDir, `${sessionId}.jsonl`)
    let promptTokenCount = 0
    let candidatesTokenCount = 0
    let cachedContentTokenCount = 0
    for (const u of usage) {
      promptTokenCount += u.promptTokenCount ?? u.input_tokens ?? 0
      candidatesTokenCount += u.candidatesTokenCount ?? u.output_tokens ?? 0
      cachedContentTokenCount += u.cachedContentTokenCount ?? u.cache_read_input_tokens ?? 0
    }
    const diskAssistant = {
      uuid: '8acca8ca-ac64-47a4-a889-848e35724829',
      sessionId,
      timestamp: '2026-09-15T20:21:45.793Z',
      type: 'assistant',
      provenance: 'assistant_output',
      cwd: '/home/example',
      version: '0.23.4',
      model: 'qwen-27b',
      message: {
        role: 'model',
        parts: [{ text: 'plan', thought: true }, { text: 'ok' }],
      },
      usageMetadata: {
        promptTokenCount,
        candidatesTokenCount,
        thoughtsTokenCount: 0,
        totalTokenCount: promptTokenCount + candidatesTokenCount,
        cachedContentTokenCount,
      },
      contextWindowSize: 262144,
    }
    script.push(
      `mkdir -p ${shellQuote(chatsDir)}`,
      `printf '%s\\n' ${shellQuote(JSON.stringify(diskAssistant))} >> ${shellQuote(wire)}`,
    )
    if (opts.stderr !== undefined) {
      script.push(`printf '%s\\n' ${shellQuote(opts.stderr)} >&2`)
    }
    script.push(`cat "${dir}/stdout.txt"`, `exit ${String(opts.exitCode ?? 0)}`)
  }

  fs.writeFileSync(binary, script.join('\n') + '\n', { mode: 0o755 })

  const readInvocations = (): string[][] => {
    let text: string
    try {
      text = fs.readFileSync(path.join(dir, 'args.txt'), 'utf8')
    } catch {
      return []
    }
    const out: string[][] = []
    for (const line of text.split('\n')) {
      if (line === INVOCATION_MARK) out.push([])
      else if (line !== '' && out.length > 0) out[out.length - 1].push(line)
    }
    return out
  }

  const readInvocationTexts = (): string[] => {
    let text: string
    try {
      text = fs.readFileSync(path.join(dir, 'args.txt'), 'utf8')
    } catch {
      return []
    }
    return text
      .split(`${INVOCATION_MARK}\n`)
      .slice(1)
      .map((chunk) => chunk.replace(/\n$/, ''))
  }

  return {
    binary,
    dir,
    home,
    cwd,
    invocations: readInvocations,
    invocationTexts: readInvocationTexts,
    args: () => {
      const all = readInvocations()
      return all.length > 0 ? all[all.length - 1] : []
    },
    env: () => {
      const out: Record<string, string> = {}
      let text: string
      try {
        text = fs.readFileSync(path.join(dir, 'env.txt'), 'utf8')
      } catch {
        return out
      }
      for (const line of text.split('\n')) {
        const idx = line.indexOf('=')
        if (idx > 0) out[line.slice(0, idx)] = line.slice(idx + 1)
      }
      return out
    },
  }
}

/** Default assistant usage on the runtime stream (real qwen keys). */
export const SUCCESS_USAGE = {
  input_tokens: 100,
  output_tokens: 25,
  cache_read_input_tokens: 10,
  total_tokens: 135,
}

/**
 * Runtime stream-json stdout for a healthy Qwen Code 0.23.4 turn — shape
 * copied from `samples/headless-stream-json-partial.ndjson` (system/init,
 * thinking_delta, assistant thinking block with zero usage, text_delta,
 * assistant text block with usage, result). cwd sanitized to `/home/example`.
 */
export function successLines(
  finalText: string,
  sessionId: string,
  usage: typeof SUCCESS_USAGE = SUCCESS_USAGE,
): unknown[] {
  const head = finalText.slice(0, 1)
  const rest = finalText.slice(1)
  const thinking = 'plan'
  const textDeltas: unknown[] = []
  if (head) {
    textDeltas.push({
      type: 'stream_event',
      uuid: '6a05e9cf-d29b-4bc4-8d7a-a64b5f8a8185',
      session_id: sessionId,
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: head } },
    })
  }
  if (rest) {
    textDeltas.push({
      type: 'stream_event',
      uuid: '0809a04e-49cc-4c3b-8366-dee2238f5369',
      session_id: sessionId,
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: rest } },
    })
  }
  return [
    {
      type: 'system',
      subtype: 'init',
      uuid: sessionId,
      session_id: sessionId,
      cwd: '/home/example',
      tools: ['read_file', 'write_file', 'run_shell_command'],
      mcp_servers: [],
      model: 'qwen-27b',
      permission_mode: 'yolo',
      qwen_code_version: '0.23.4',
    },
    {
      type: 'stream_event',
      uuid: 'dc8260a1-4daa-427f-a19a-bb92b5c45a3e',
      session_id: sessionId,
      parent_tool_use_id: null,
      event: {
        type: 'message_start',
        message: {
          id: '91bd39e1-0da1-42c1-a67d-0a86cb6741d9',
          role: 'assistant',
          model: 'qwen-27b',
          content: [],
        },
      },
    },
    {
      type: 'stream_event',
      uuid: '8eab0e7f-9a9a-4275-945a-f332aea8ef2c',
      session_id: sessionId,
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } },
    },
    {
      type: 'assistant',
      uuid: '91bd39e1-0da1-42c1-a67d-0a86cb6741d9',
      session_id: sessionId,
      parent_tool_use_id: null,
      message: {
        id: '91bd39e1-0da1-42c1-a67d-0a86cb6741d9',
        type: 'message',
        role: 'assistant',
        model: 'qwen-27b',
        content: [{ type: 'thinking', thinking, signature: '' }],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    },
    {
      type: 'stream_event',
      uuid: '16ba3b6a-df86-4583-93de-c9bc8043b529',
      session_id: sessionId,
      parent_tool_use_id: null,
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    },
    ...textDeltas,
    {
      type: 'assistant',
      uuid: '1323af5d-03d7-4986-8936-f4aa04df7f05',
      session_id: sessionId,
      parent_tool_use_id: null,
      message: {
        id: '1323af5d-03d7-4986-8936-f4aa04df7f05',
        type: 'message',
        role: 'assistant',
        model: 'qwen-27b',
        content: [{ type: 'text', text: finalText }],
        stop_reason: null,
        usage,
      },
    },
    {
      type: 'result',
      subtype: 'success',
      uuid: 'ca5a15ad-638b-4be8-becd-a268b0d266bd',
      session_id: sessionId,
      is_error: false,
      duration_ms: 49029,
      duration_api_ms: 30431,
      num_turns: 1,
      result: finalText,
      // Real qwen result.usage is the whole-run total (larger than the last
      // assistant line). Tests that need a distinct run-total use custom lines;
      // here we copy the assistant usage so a zero-usage stream stays zero.
      usage,
      permission_denials: [],
    },
  ]
}

/**
 * Runtime stream-json for a tool-using turn — shape copied from
 * `samples/headless-tool-turn-stream-json.ndjson` (sanitized cwd `/home/example`).
 */
export function toolTurnLines(sessionId: string, finalText = 'tool-sample-ok'): unknown[] {
  return [
    {
      type: 'system',
      subtype: 'init',
      uuid: sessionId,
      session_id: sessionId,
      cwd: '/home/example',
      tools: ['read_file', 'run_shell_command', 'tool_search'],
      mcp_servers: [],
      model: 'qwen-27b',
      permission_mode: 'yolo',
      qwen_code_version: '0.23.4',
    },
    {
      type: 'assistant',
      uuid: 'd5634782-c4cc-4e28-8903-7d02485ec728',
      session_id: sessionId,
      parent_tool_use_id: null,
      message: {
        id: 'd5634782-c4cc-4e28-8903-7d02485ec728',
        type: 'message',
        role: 'assistant',
        model: 'qwen-27b',
        content: [{ type: 'thinking', thinking: 'plan', signature: '' }],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    },
    {
      type: 'assistant',
      uuid: 'ac4e1e91-b4e5-4a25-b238-35b8071f0dfa',
      session_id: sessionId,
      parent_tool_use_id: null,
      message: {
        id: 'ac4e1e91-b4e5-4a25-b238-35b8071f0dfa',
        type: 'message',
        role: 'assistant',
        model: 'qwen-27b',
        content: [
          {
            type: 'tool_use',
            id: 'call_6ef8c237955540faabb31812',
            name: 'run_shell_command',
            input: {
              command: 'echo tool-sample-ok',
              description: 'Print a sample marker string to stdout',
            },
          },
        ],
        stop_reason: 'tool_use',
        usage: {
          input_tokens: 26222,
          output_tokens: 101,
          cache_read_input_tokens: 0,
          total_tokens: 26323,
        },
      },
    },
    {
      type: 'user',
      uuid: 'f4b72359-349a-4ba5-b7e3-3cf0967cb8cf',
      session_id: sessionId,
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_6ef8c237955540faabb31812',
            is_error: false,
            content: 'tool-sample-ok',
          },
        ],
      },
    },
    {
      type: 'stream_event',
      uuid: '6a05e9cf-d29b-4bc4-8d7a-a64b5f8a8185',
      session_id: sessionId,
      parent_tool_use_id: null,
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: finalText },
      },
    },
    {
      type: 'assistant',
      uuid: '384e2637-774e-45ed-991f-13f676f358db',
      session_id: sessionId,
      parent_tool_use_id: null,
      message: {
        id: '384e2637-774e-45ed-991f-13f676f358db',
        type: 'message',
        role: 'assistant',
        model: 'qwen-27b',
        content: [{ type: 'text', text: `\n\n${finalText}` }],
        stop_reason: null,
        usage: {
          input_tokens: 26388,
          output_tokens: 22,
          cache_read_input_tokens: 0,
          total_tokens: 26410,
        },
      },
    },
    {
      type: 'result',
      subtype: 'success',
      uuid: 'dd4b16a8-a444-4005-aab4-674978f71d81',
      session_id: sessionId,
      is_error: false,
      duration_ms: 48376,
      num_turns: 3,
      result: `\n\n${finalText}`,
      usage: {
        input_tokens: 76940,
        output_tokens: 360,
        cache_read_input_tokens: 0,
        total_tokens: 77300,
      },
      permission_denials: [],
    },
  ]
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}
