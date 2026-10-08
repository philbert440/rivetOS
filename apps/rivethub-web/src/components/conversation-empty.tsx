/**
 * Shared empty pane: the chat column and the canvas when nothing is listed.
 * Copy stays the one the list has always shown.
 */

import type { JSX } from 'react'
import { RhMark } from './brand.js'

export function ConversationEmpty(props: { className?: string }): JSX.Element {
  return (
    <div
      data-empty-conversations=""
      className={props.className ?? 'flex flex-1 flex-col items-center justify-center gap-2'}
    >
      <RhMark className="text-5xl opacity-90" />
      <div className="text-sm text-ink-dim">Pick a conversation or start a new one.</div>
    </div>
  )
}
