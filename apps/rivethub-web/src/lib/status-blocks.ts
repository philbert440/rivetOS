/**
 * `blocked` carried only by `status` frames on the registry stream. ACP
 * drivers (grok / opencode) report a permission wait as `status: 'blocked'`
 * and never set it on the summary or `session-updated`, so the plane list
 * alone never shows those sessions as needing you.
 *
 * Tracked per frame `source`: one session can hear several (herdr,
 * transcript, protocol), and a transcript `working` frame mid-permission must
 * not clear a protocol block. A session stays blocked until every source that
 * said `blocked` has moved on. A rekey moves the blocks; `ended` drops them.
 * The registry stream has no replay, so the owner clears everything when the
 * socket reopens and lets the refetched summaries re-derive.
 *
 * Desktop twin of rivethub-android `plane/NeedsYou.kt` StatusBlocks.
 */

import { useCallback, useRef, useState } from 'react'
import type { HarnessEvent, HarnessSessionSummary } from '@rivetos/types'

export class StatusBlocks {
  private readonly bySession = new Map<string, Set<string>>()

  /** Record a `status` frame; true when the session's blocked state changed. */
  onStatus(sessionId: string, status: string, source: string | undefined): boolean {
    if (!sessionId) return false
    const was = this.isBlocked(sessionId)
    const key = source ?? ''
    if (status === 'blocked') {
      let set = this.bySession.get(sessionId)
      if (!set) {
        set = new Set()
        this.bySession.set(sessionId, set)
      }
      set.add(key)
    } else {
      const set = this.bySession.get(sessionId)
      if (set) {
        set.delete(key)
        if (set.size === 0) this.bySession.delete(sessionId)
      }
    }
    return was !== this.isBlocked(sessionId)
  }

  /** A rekey moves the old id's blocks; an ended session drops them. True on change. */
  onSessionUpdated(
    sessionId: string,
    status: string | undefined,
    previousSessionId?: string,
  ): boolean {
    let changed = false
    if (previousSessionId !== undefined && previousSessionId !== sessionId) {
      const moved = this.bySession.get(previousSessionId)
      if (moved) {
        this.bySession.delete(previousSessionId)
        const into = this.bySession.get(sessionId) ?? new Set<string>()
        for (const src of moved) into.add(src)
        this.bySession.set(sessionId, into)
        changed = true
      }
    }
    if (status === 'ended' && this.bySession.delete(sessionId)) changed = true
    return changed
  }

  /** Fold one registry frame in; true when any session's blocked state changed. */
  observe(event: HarnessEvent): boolean {
    if (event.type === 'status') return this.onStatus(event.sessionId, event.status, event.source)
    if (event.type === 'session-updated') {
      return this.onSessionUpdated(event.sessionId, event.status, event.previousSessionId)
    }
    return false
  }

  isBlocked(sessionId: string): boolean {
    return (this.bySession.get(sessionId)?.size ?? 0) > 0
  }

  get isEmpty(): boolean {
    return this.bySession.size === 0
  }

  /** True when anything was dropped. */
  clear(): boolean {
    if (this.bySession.size === 0) return false
    this.bySession.clear()
    return true
  }
}

/** Overlay `blocks` onto plane summaries: a status-blocked session reads as
 *  blocked unless it ended. Returns `summaries` itself when nothing changes. */
export function withStatusBlocks<T extends HarnessSessionSummary[] | undefined>(
  summaries: T,
  blocks: StatusBlocks | undefined,
): T {
  if (!summaries || !blocks || blocks.isEmpty) return summaries
  let changed = false
  const out = summaries.map((s) => {
    if (s.blocked || s.status === 'ended' || !blocks.isBlocked(s.sessionId)) return s
    changed = true
    return { ...s, blocked: true }
  })
  return (changed ? out : summaries) as T
}

export interface StatusBlocksHandle {
  blocks: StatusBlocks
  /** Bumps whenever the blocked set changes — a memo dependency. */
  version: number
  observe: (event: HarnessEvent) => void
  /** Registry socket reopened / rebound: no replay, so drop every block. */
  reset: () => void
}

export function useStatusBlocks(): StatusBlocksHandle {
  const blocks = useRef(new StatusBlocks()).current
  const [version, setVersion] = useState(0)
  const observe = useCallback(
    (event: HarnessEvent): void => {
      if (blocks.observe(event)) setVersion((v) => v + 1)
    },
    [blocks],
  )
  const reset = useCallback((): void => {
    if (blocks.clear()) setVersion((v) => v + 1)
  }, [blocks])
  return { blocks, version, observe, reset }
}
