/**
 * Keeps `project:<name>` memory tags on every session placed in a canvas
 * project (see project-tags.ts). One pass on mount, on every membership or
 * project-name change, and once a minute for sessions still waiting on
 * their first capture. Passes never overlap and run their requests one at a
 * time, so a backfill of many sessions trickles in instead of bursting.
 */

import { useEffect, useRef } from 'react'
import { useSpaces } from '../stores/spaces.js'
import { desiredProjectTags, loadLedger, saveLedger, syncProjectTags } from './project-tags.js'
import { useTagEndpoint } from './use-session-tags.js'

const TICK_MS = 60_000
/** Membership churns while a session is being placed; settle before a pass. */
const SETTLE_MS = 2_000

export function useProjectTagSync(): void {
  const endpoint = useTagEndpoint()
  const membership = useSpaces((s) => s.membership)
  const spaces = useSpaces((s) => s.spaces)
  const running = useRef(false)
  const latest = useRef({ endpoint, membership, spaces })
  latest.current = { endpoint, membership, spaces }

  useEffect(() => {
    const pass = async (): Promise<void> => {
      const { endpoint: ep, membership: rows, spaces: projects } = latest.current
      if (!ep || running.current) return
      running.current = true
      try {
        const desired = desiredProjectTags(rows, projects)
        saveLedger(await syncProjectTags(ep, loadLedger(), desired, Date.now()))
      } finally {
        running.current = false
      }
    }
    const settle = setTimeout(() => void pass(), SETTLE_MS)
    const tick = setInterval(() => void pass(), TICK_MS)
    return () => {
      clearTimeout(settle)
      clearInterval(tick)
    }
  }, [endpoint, membership, spaces])
}
