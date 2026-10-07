/**
 * One conversation on the canvas. Three faces: a card (everything), a live
 * mini (space), and the focused thread (mounted by the parent after the
 * fly lands). Click selects; click on the selection opens.
 */

import type { JSX, ReactNode } from 'react'
import type { HarnessDescriptor, SessionMessage } from '@rivetos/types'
import { accentFor } from '../../lib/agent-accent.js'
import { denRoomKey, type ChatItem } from '../../lib/harness-chat.js'
import { storageKey } from '../../lib/session-rekey.js'
import { useChat } from '../../stores/chat.js'
import { useConnection } from '../../stores/connection.js'
import { useSessionNames } from '../../stores/session-names.js'
import { ThreadMini } from './ThreadMini.js'
import { tilePill, tileStatus, type TileStatus } from './tile-status.js'
import type { Altitude } from './camera.js'

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 180 ? `${flat.slice(0, 179)}…` : flat
}

function persistedName(
  byKey: Record<string, string | undefined>,
  baseUrl: string,
  key: string,
): string | undefined {
  const own = byKey[storageKey(baseUrl, key)]
  if (own !== undefined) return own
  const native = denRoomKey(key)
  return native === key ? undefined : byKey[storageKey(baseUrl, native)]
}

export function Tile(props: {
  item: ChatItem
  altitude: Altitude
  selected: boolean
  blocked: boolean
  geometry: { x: number; y: number; w: number; h: number }
  /** Space altitude, or the focused tile holding the stream across the fly. */
  showMini: boolean
  showThread: boolean
  descriptors?: HarnessDescriptor[]
  renderThread: (id: string) => ReactNode
  onActivate: (id: string) => void
  onOpen: (id: string) => void
}): JSX.Element {
  const id = props.item.key
  const status: TileStatus = tileStatus(props.item.status, props.blocked)
  const baseUrl = useConnection((s) => s.baseUrl)
  const nameBase = props.item.pinNodeBaseUrl ?? baseUrl
  const customName = useSessionNames((s) => persistedName(s.byKey, nameBase, id))
  const title = customName ?? props.item.title
  const last = useChat((s) => {
    const key = s.resolveSessionKey(id)
    const liveText = s.live[key]?.text
    if (liveText) return oneLine(liveText)
    const msgs: SessionMessage[] | undefined = s.messages[key]
    const text = msgs && msgs.length > 0 ? msgs[msgs.length - 1]?.text : undefined
    return text ? oneLine(text) : ''
  })
  const accent = accentFor({
    presetColor: props.item.accent,
    harnessId: props.item.harnessId,
    command: props.item.command,
  })
  const chip =
    props.item.agentName?.trim() || props.item.command || props.item.harnessId || 'session'
  const focused = props.altitude === 'thread' && props.selected
  const dimmed = props.altitude === 'thread' && !props.selected
  const outlined = props.selected && props.altitude !== 'thread'
  const emphasize = focused || status === 'needs'

  return (
    <div
      data-tile={id}
      data-status={status}
      data-selected={props.selected ? 'true' : 'false'}
      className={`st-${status} absolute flex min-h-0 flex-col border border-line bg-panel${
        focused ? ' focus' : ''
      }`}
      style={{
        left: props.geometry.x,
        top: props.geometry.y,
        width: props.geometry.w,
        height: props.geometry.h,
        zIndex: focused ? 5 : 1,
        opacity: dimmed ? 0.12 : status === 'done' ? 0.7 : undefined,
        borderColor: focused
          ? 'var(--color-em)'
          : status === 'needs'
            ? 'var(--color-warn)'
            : undefined,
        borderWidth: emphasize ? 'calc(2px * min(var(--inv, 1), 4))' : undefined,
        outline: outlined ? 'calc(2.5px * var(--inv, 1)) solid var(--color-em)' : undefined,
        outlineOffset: outlined ? 'calc(7px * var(--inv, 1))' : undefined,
        transition: 'opacity .28s, left .32s, top .32s, width .32s, height .32s',
      }}
    >
      <button
        type="button"
        data-tile-hit={id}
        onClick={() => props.onActivate(id)}
        onDoubleClick={() => props.onOpen(id)}
        className={`absolute inset-0 z-[1] cursor-pointer bg-transparent${
          props.showThread ? ' pointer-events-none' : ''
        }`}
        tabIndex={props.showThread ? -1 : 0}
        aria-pressed={props.selected}
        aria-label={title}
      />
      <div
        className="pointer-events-none absolute bottom-full left-4 z-[2] mb-2 flex max-w-[90%] items-center gap-2 rounded-full border border-line bg-panel px-2 py-1 font-mono text-xs"
        style={{ opacity: props.altitude === 'thread' ? 0 : 'var(--live, 0)' }}
      >
        <span
          className="size-1.5 shrink-0 rounded-full"
          style={{ background: accent }}
          aria-hidden
        />
        <b className="truncate">{chip}</b>
        <span className="truncate text-ink-dim">{title}</span>
      </div>
      <div
        data-face="card"
        className="pointer-events-none absolute inset-0 flex flex-col justify-center gap-2 px-6 py-4"
        style={{ opacity: 'calc(1 - var(--live, 0))' }}
      >
        <div className="flex items-center gap-2 font-mono text-lg text-ink">
          <span
            className="size-2 shrink-0 rounded-full"
            style={{ background: accent }}
            aria-hidden
          />
          <span className="truncate">{chip}</span>
        </div>
        <div className="truncate text-sm text-ink-dim">{title}</div>
        <span
          className={`self-start rounded-full px-2 py-1 font-mono text-[10px] tracking-wide uppercase ${
            status === 'needs'
              ? 'bg-warn text-bg'
              : status === 'working'
                ? 'bg-em/15 text-em'
                : status === 'done'
                  ? 'text-em'
                  : 'bg-panel-2 text-ink-dim'
          }`}
        >
          {tilePill(status)}
        </span>
        {last ? <div className="truncate text-xs text-ink-dim">{last}</div> : null}
      </div>
      {props.showMini ? <ThreadMini item={props.item} descriptors={props.descriptors} /> : null}
      {props.showThread ? (
        <div
          data-thread-live=""
          className="absolute inset-0 z-[3] flex min-h-0 flex-col overflow-hidden bg-bg"
        >
          {props.renderThread(id)}
        </div>
      ) : null}
    </div>
  )
}
