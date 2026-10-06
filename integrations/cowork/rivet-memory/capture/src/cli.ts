#!/usr/bin/env node
/**
 * cowork-rivet-memory-capture
 *
 *   --mcp        stdio MCP server (Content-Length frames). The Desktop plugin
 *                calls memory_capture_event from mcp_tool hooks.
 *   --backfill   import host transcripts once. Not a poll loop.
 *
 * Posts to the den. RIVETOS_CAPTURE_URL wins; otherwise the den URL capture-core
 * already resolves. There is no capture toggle.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createCaptureWriter, resolveCaptureTransport } from '@rivetos/capture-core'
import {
  backfillTranscript,
  captureFromHook,
  defaultStatePath,
  deliverBatch,
  discoverTasks,
  emptyState,
  encodeFrame,
  handleMcp,
  pushFrames,
  type BackfillState,
  type HookInput,
} from './cowork-capture.js'

function rootsFromEnv(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME || env.USERPROFILE || ''
  const roots = [`${home}/Library/Application Support/Claude`, `${home}/.config/Claude`]
  const extra = env.CLAUDE_CONFIG_DIR?.trim()
  if (extra) roots.push(extra)
  return roots
}

function writerForEnv(env: NodeJS.ProcessEnv = process.env) {
  const override = env.RIVETOS_CAPTURE_URL?.trim()
  const transport = resolveCaptureTransport(env)
  // No den URL yet: still hand the batch to the writer. The post fails and
  // the writer spools it in the same per-user directory the other kits use.
  const denUrl = override || (transport.kind === 'den' ? transport.denUrl : 'http://127.0.0.1:9')
  return createCaptureWriter({
    denUrl,
    log: (line) => console.error(line),
  })
}

function loadState(file: string): BackfillState {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<BackfillState>
    return {
      offsets: parsed.offsets ?? {},
      pending: parsed.pending ?? {},
    }
  } catch {
    return emptyState()
  }
}

function saveState(stateFile: string, state: BackfillState): void {
  mkdirSync(dirname(stateFile), { recursive: true })
  writeFileSync(stateFile, JSON.stringify(state))
}

async function backfill(log: (line: string) => void = console.log): Promise<void> {
  const stateFile = process.env.RIVETOS_COWORK_STATE || defaultStatePath()
  const state = loadState(stateFile)
  const writer = writerForEnv()
  const tasks = discoverTasks(rootsFromEnv(process.env))
  let inserted = 0
  for (const task of tasks) {
    const batch = backfillTranscript(task, state)
    const counts = await deliverBatch(batch, writer)
    inserted += counts.inserted
    saveState(stateFile, state)
  }
  // Drain even when no transcript grew, so a batch spooled while the den
  // was down is delivered at startup.
  await writer.replay()
  if (tasks.length === 0) saveState(stateFile, state)
  log(`cowork backfill inserted ${String(inserted)}`)
}

async function onCapture(hook: HookInput): Promise<{ inserted: number; skipped: number }> {
  const stateFile = process.env.RIVETOS_COWORK_STATE || defaultStatePath()
  const state = loadState(stateFile)
  const batch = captureFromHook(hook, state)
  const counts = await deliverBatch(batch, writerForEnv())
  saveState(stateFile, state)
  return { inserted: counts.inserted, skipped: counts.skipped }
}

async function serveMcp(): Promise<void> {
  // Desktop spawns this at session start. One catch-up, then hooks.
  // Stderr only: stdout is the MCP frame stream.
  try {
    await backfill((line) => console.error(line))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
  }
  // `Buffer` defaults to ArrayBufferLike. `Buffer.alloc` infers ArrayBuffer,
  // which cannot be assigned the leftover from `pushFrames`.
  let buf: Buffer = Buffer.alloc(0)
  let chain = Promise.resolve()
  process.stdin.on('data', (chunk: Buffer) => {
    const fed = pushFrames(buf, chunk)
    buf = fed.buf
    for (const message of fed.messages) {
      chain = chain.then(async () => {
        const response = await handleMcp(message, { onCapture })
        if (response) process.stdout.write(encodeFrame(response))
      })
    }
  })
  await new Promise<void>((resolve) => {
    process.stdin.on('end', () => resolve())
  })
}

const mode = process.argv[2]
if (mode === '--mcp') {
  await serveMcp()
} else if (mode === '--backfill') {
  await backfill()
} else {
  console.error('usage: cowork-rivet-memory-capture --mcp | --backfill')
  process.exit(mode ? 1 : 0)
}
