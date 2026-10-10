/**
 * Rename a conversation in place — the canvas breadcrumb and Space tiles.
 * Same store and rules as the drawer's pencil (drawer-item): the name is
 * filed per node + session, Enter or blur saves, an empty name clears it
 * back to the derived title, Escape cancels.
 */

import { useRef, useState, type CSSProperties, type JSX } from 'react'
import type { ChatItem } from '../lib/harness-chat.js'
import { storageKey } from '../lib/session-rekey.js'
import { useConnection } from '../stores/connection.js'
import { useSessionNames } from '../stores/session-names.js'
import { persisted } from './drawer-item.js'

/** The title a conversation shows (custom name over derived) and its name key. */
export function useSessionTitle(item: Pick<ChatItem, 'key' | 'title' | 'pinNodeBaseUrl'>): {
  title: string
  nameKey: string
} {
  const hubBase = useConnection((s) => s.baseUrl)
  const base = item.pinNodeBaseUrl ?? hubBase
  const custom = useSessionNames((s) => persisted(s.byKey, base, item.key))
  return { title: custom ?? item.title, nameKey: storageKey(base, item.key) }
}

export function RenameInput(props: {
  nameKey: string
  /** Starting text — the title on screen. */
  initial: string
  onDone: () => void
  className?: string
  style?: CSSProperties
}): JSX.Element {
  const setName = useSessionNames((s) => s.set)
  const [draft, setDraft] = useState(props.initial)
  // A blur still fires as the input unmounts after Escape; never save then.
  const cancelled = useRef(false)
  const commit = (): void => {
    if (!cancelled.current) setName(props.nameKey, draft)
    props.onDone()
  }
  return (
    <form
      data-act=""
      onSubmit={(e) => {
        e.preventDefault()
        commit()
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      className="contents"
    >
      <input
        autoFocus
        aria-label="Conversation name"
        value={draft}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          // Canvas and app shortcuts stay out of the name being typed.
          e.stopPropagation()
          if (e.key === 'Escape') {
            cancelled.current = true
            props.onDone()
          }
        }}
        onBlur={commit}
        className={
          props.className ?? 'min-w-0 border border-em bg-panel-2 px-2 py-1 text-ink outline-none'
        }
        style={props.style}
      />
    </form>
  )
}
