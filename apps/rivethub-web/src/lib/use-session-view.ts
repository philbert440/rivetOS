import { useState } from 'react'
import type { HarnessDescriptor } from '@rivetos/types'
import {
  sessionOpensOnTerminal,
  type ChatItem,
  type HarnessRegistryStatus,
} from './harness-chat.js'
import { getSessionMode, setSessionMode, type SessionViewMode } from './session-mode.js'

/** Only explicit choices are remembered. Automatic views follow the current
 * row and registry; pending/error use a temporary, usable terminal fallback. */
export function useSessionView(
  key: string,
  item: Pick<ChatItem, 'kind' | 'command' | 'harnessId'> | undefined,
  descriptors: HarnessDescriptor[] | undefined,
  status: HarnessRegistryStatus,
): { mode: SessionViewMode; setMode: (mode: SessionViewMode) => void } {
  const [selection, setSelection] = useState<{ key: string; mode: SessionViewMode }>()
  const fallback = !item || sessionOpensOnTerminal(item, descriptors, status) ? 'terminal' : 'chat'
  const mode =
    (selection?.key === key ? selection.mode : undefined) ?? getSessionMode(key, fallback)

  return {
    mode,
    setMode: (next) => {
      setSelection({ key, mode: next })
      setSessionMode(key, next)
    },
  }
}
