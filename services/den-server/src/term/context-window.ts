/**
 * Session context-window stamping for RivetHub's fill bar.
 *
 * Claude Code's advertised window is 200k by default and 1M only for the
 * `[1m]` model variant (a request-side flag, not a transcript model id).
 * Forced compaction fires earlier than the window: a 1M session on this host
 * auto-compacted at 964,285 tokens (≈ window − 35k). The 200k threshold is
 * the same reserve, provisional until a session self-calibrates.
 */

import { denSessionRef } from '../harness/session-key.js'

/**
 * Tokens held back from the advertised window before Claude Code force-compacts.
 * Measured on a 1M session (compacted at 964,285 ≈ window − 35k). The 200k
 * threshold is provisional (same reserve) until a 200k session self-calibrates.
 */
export const COMPACT_RESERVE = 35_000

export type ContextSource = 'spawn' | 'observed' | 'default'

export interface SessionContextStamp {
  contextWindow: number
  compactAt: number
  contextSource: ContextSource
}

/** compactAt = window − COMPACT_RESERVE, floored at 1. */
export function compactAtFor(window: number, reserve = COMPACT_RESERVE): number {
  if (!Number.isFinite(window) || window <= 0) return 1
  return Math.max(1, window - reserve)
}

/**
 * Max context tokens for a spawn model option / transcript model id / roster
 * command. Claude is 200k unless the id carries `[1m]` / `-1m` (then 1M).
 */
export function contextWindowFromModel(model: string | undefined, command?: string): number {
  const id = (model ?? '').trim()
  const cmd = (command ?? '').trim().toLowerCase()
  const claudeCmd = cmd === 'claude' || cmd === 'claude-code'
  const grokCmd = cmd === 'grok' || cmd === 'grok-build'
  const localCmd =
    cmd === 'hermes' ||
    cmd === 'kimi' ||
    cmd === 'kimi-code' ||
    cmd === 'dsh' ||
    cmd === 'deepseek-harness' ||
    cmd === 'pi' ||
    cmd === 'local'

  // 1M is a request-side flag, not a model family. Only this substring.
  if (/\[1m\]|-1m/i.test(id)) return 1_000_000
  if (claudeCmd || /claude|anthropic|opus|sonnet|haiku|fable/i.test(id)) return 200_000
  if (grokCmd || /grok/i.test(id)) return 500_000
  if (localCmd || /local|vllm|llama-server|llama_server/i.test(id)) return 262_144
  return 262_144
}

export function stampFromSpawn(model: string | undefined, command: string): SessionContextStamp {
  const contextWindow = contextWindowFromModel(model, command)
  return { contextWindow, compactAt: compactAtFor(contextWindow), contextSource: 'spawn' }
}

export function stampDefault(model: string | undefined, command?: string): SessionContextStamp {
  const contextWindow = contextWindowFromModel(model, command)
  return { contextWindow, compactAt: compactAtFor(contextWindow), contextSource: 'default' }
}

/**
 * A 200k session cannot exceed 200k observed prompt tokens — promote to 1M.
 * compactAt resets to the provisional 1M reserve unless a learned value exists.
 */
export function promoteIfExceeded(
  stamp: SessionContextStamp,
  promptTokens: number,
): SessionContextStamp {
  if (!Number.isFinite(promptTokens) || promptTokens <= stamp.contextWindow) return stamp
  const contextWindow = 1_000_000
  const learned = learnedCompactAt.get(contextWindow)
  return {
    contextWindow,
    compactAt: learned ?? compactAtFor(contextWindow),
    contextSource: 'observed',
  }
}

/**
 * Post-compaction signature: context dropped by more than 50% between
 * consecutive assistant turns. Returns the pre-drop size as the learned
 * compactAt for `window`, or undefined when the signature does not match.
 */
export function learnCompactAt(prev: number, next: number, window: number): number | undefined {
  if (!Number.isFinite(prev) || !Number.isFinite(next) || !Number.isFinite(window)) return undefined
  if (prev <= 0 || next < 0 || window <= 0) return undefined
  if (next >= prev) return undefined
  if (next >= prev * 0.5) return undefined
  return prev
}

interface SessionContextRecord extends SessionContextStamp {
  lastPromptTokens?: number
}

/** Per-session stamp. Survives client reconnects for the life of this den process. */
const bySession = new Map<string, SessionContextRecord>()
/** Learned compactAt keyed by contextWindow size (shared across sessions). */
const learnedCompactAt = new Map<number, number>()

function allKeys(id: string): string[] {
  const keys = new Set<string>([id])
  const ref = denSessionRef(id)
  if (ref.native) keys.add(ref.native)
  return [...keys]
}

export function sessionContext(id: string): SessionContextStamp | undefined {
  const rec = bySession.get(id)
  if (rec) return rec
  const ref = denSessionRef(id)
  if (ref.native && ref.native !== id) return bySession.get(ref.native)
  return undefined
}

export function rememberSessionContext(
  id: string,
  stamp: SessionContextStamp,
): SessionContextStamp {
  const rec: SessionContextRecord = { ...stamp }
  for (const k of allKeys(id)) bySession.set(k, rec)
  return rec
}

function applyLearned(stamp: SessionContextStamp): SessionContextStamp {
  const learned = learnedCompactAt.get(stamp.contextWindow)
  if (learned === undefined || learned === stamp.compactAt) return stamp
  return { ...stamp, compactAt: learned, contextSource: 'observed' }
}

function applyObservedTurns(
  stamp: SessionContextStamp,
  turns: ReadonlyArray<{
    role?: string
    usage?: { promptTokens?: number }
    model?: string
  }>,
): SessionContextStamp {
  let next = applyLearned(stamp)
  let prev: number | undefined
  for (const t of turns) {
    if (t.role !== undefined && t.role !== 'assistant') continue
    const p = t.usage?.promptTokens
    if (typeof p !== 'number' || !Number.isFinite(p) || p <= 0) continue
    next = promoteIfExceeded(next, p)
    if (prev !== undefined) {
      const learned = learnCompactAt(prev, p, next.contextWindow)
      if (learned !== undefined) {
        learnedCompactAt.set(next.contextWindow, learned)
        next = {
          contextWindow: next.contextWindow,
          compactAt: learned,
          contextSource: 'observed',
        }
      }
    }
    prev = p
  }
  return applyLearned(next)
}

/**
 * Resolve the stamp for a transcript response: spawn record if we have one,
 * else a command/model default, then auto-promote and self-calibrate from
 * observed promptTokens.
 */
export function overlaySessionContext(
  id: string,
  turns: ReadonlyArray<{
    role?: string
    usage?: { promptTokens?: number }
    model?: string
  }>,
  command?: string,
): SessionContextStamp {
  let model: string | undefined
  for (let i = turns.length - 1; i >= 0; i--) {
    const m = turns[i]?.model
    if (typeof m === 'string' && m.trim()) {
      model = m.trim()
      break
    }
  }
  const existing = sessionContext(id)
  const stamp = applyObservedTurns(existing ?? stampDefault(model, command), turns)
  rememberSessionContext(id, stamp)
  return stamp
}

/** Test seam — the maps are process-lifetime otherwise. */
export function resetSessionContextForTest(): void {
  bySession.clear()
  learnedCompactAt.clear()
}
