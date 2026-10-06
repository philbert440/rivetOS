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
import type { CaptureBatch } from '@rivetos/capture-core'
import {
  backfillTranscript,
  defaultStatePath,
  discoverTasks,
  emptyState,
  encodeFrame,
  handleMcp,
  hookBatch,
  pushFrames,
  type BackfillState,
  type HookInput,
} from './cowork-capture.js'

function rootsFromEnv(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME || env.USERPROFILE || ''
  const roots = [
    `${home}/Library/Application Support/Claude`,
    `${home}/.config/Claude`,
  ]
  const extra = env.CLAUDE_CONFIG_DIR?.trim()
  if (extra) roots.push(extra)
  return roots
}

async function postBatch(batch: CaptureBatch | undefined): Promise<{ inserted: number; skipped: number }> {
  if (!batch) return { inserted: 0, skipped: 0 }
  const transport = resolveCaptureTransport(process.env)
  const override = process.env.RIVETOS_CAPTURE_URL?.trim()
  if (transport.kind !== 'den' && !override) {
    throw new Error(transport.kind === 'none' ? transport.reason : 'cowork capture posts to the den')
  }
  const denUrl = override || (transport.kind === 'den' ? transport.denUrl : '')
  const writer = createCaptureWriter({
    denUrl,
    log: (line) => console.error(line),
  })
  const result = await writer.write(batch)
  if ('inserted' in result) return { inserted: result.inserted, skipped: result.skipped }
  if ('error' in result) throw new Error(result.error)
  return { inserted: 0, skipped: 0 }
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

async function backfill(): Promise<void> {
  const stateFile = process.env.RIVETOS_COWORK_STATE || defaultStatePath()
  const state = loadState(stateFile)
  const tasks = discoverTasks(rootsFromEnv(process.env))
  let inserted = 0
  for (const task of tasks) {
    const batch = backfillTranscript(task, state)
    const counts = await postBatch(batch)
    inserted += counts.inserted
  }
  mkdirSync(dirname(stateFile), { recursive: true })
  writeFileSync(stateFile, JSON.stringify(state))
  console.log(`cowork backfill inserted ${String(inserted)}`)
}

async function serveMcp(): Promise<void> {
  let buf = Buffer.alloc(0)
  process.stdin.on('data', (chunk: Buffer) => {
    const fed = pushFrames(buf, chunk)
    buf = fed.buf
    for (const message of fed.messages) {
      void handleMcp(message, {
        onCapture: async (hook: HookInput) => postBatch(hookBatch(hook)),
      }).then((response) => {
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
