import { useEffect, useState } from 'react'
import type { HarnessDescriptor } from '@rivetos/types'
import {
  sessionOpensOnTerminal,
  type ChatItem,
  type HarnessRegistryStatus,
} from './harness-chat.js'
import {
  getSessionMode,
  hasSessionMode,
  setSessionMode,
  type SessionViewMode,
} from './session-mode.js'

/** Choose once per node/thread. An unresolved legacy default never mounts a
 * terminal or composer; a saved/manual choice is usable even while offline. */
export function useSessionView(
  key: string,
  item: Pick<ChatItem, 'kind' | 'command' | 'harnessId'> | undefined,
  descriptors: HarnessDescriptor[] | undefined,
  status: HarnessRegistryStatus,
): { mode: SessionViewMode | undefined; setMode: (mode: SessionViewMode) => void } {
  const [selection, setSelection] = useState<{ key: string; mode: SessionViewMode }>()
  const saved = hasSessionMode(key) ? getSessionMode(key) : undefined
  const waiting = !item || (item.kind === 'legacy' && status === 'pending')
  const fallback = waiting
    ? undefined
    : sessionOpensOnTerminal(item, descriptors, status)
      ? 'terminal'
      : 'chat'
  const mode = (selection?.key === key ? selection.mode : undefined) ?? saved ?? fallback

  useEffect(() => {
    if (mode === undefined) return
    // Persist automatic choices too: reload/back/forward and draft adoption
    // must not reinterpret an already-opened thread as the registry changes.
    setSessionMode(key, mode)
    setSelection((prev) => (prev?.key === key && prev.mode === mode ? prev : { key, mode }))
  }, [key, mode])

  return {
    mode,
    setMode: (next) => {
      setSelection({ key, mode: next })
      setSessionMode(key, next)
    },
  }
}
