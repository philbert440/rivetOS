/**
 * One conversation on the canvas. Three faces: a card (everything), a live
 * mini (space), and the focused thread (mounted by the parent after the
 * fly lands). The stage owns pointer selection; this hit target only
 * exposes the name.
 */

import { memo, useEffect, type CSSProperties, type JSX, type ReactNode } from 'react'
import type { HarnessDescriptor, SessionMessage } from '@rivetos/types'
import { harnessAccentKey } from '../../lib/agent-accent.js'
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

/** Custom props are not in CSSProperties' closed index. */
function withVars(vars: Record<`--${string}`, string>, style: CSSProperties): CSSProperties {
  return { ...style, ...vars }
}

/** Test hook. Unset in production. Called from an effect, never conditionally. */
let tileCommitProbe: ((id: string) => void) | undefined

export function setTileCommitProbe(probe: ((id: string) => void) | undefined): void {
  tileCommitProbe = probe
}

function sameTile(prev: TileProps, next: TileProps): boolean {
  return (
    prev.item === next.item &&
    prev.altitude === next.altitude &&
    prev.selected === next.selected &&
    prev.blocked === next.blocked &&
    prev.geometry.x === next.geometry.x &&
    prev.geometry.y === next.geometry.y &&
    prev.geometry.w === next.geometry.w &&
    prev.geometry.h === next.geometry.h &&
    prev.showMini === next.showMini &&
    prev.showThread === next.showThread &&
    prev.spaceId === next.spaceId &&
    prev.faded === next.faded &&
    prev.descriptors === next.descriptors &&
    prev.renderThread === next.renderThread &&
    prev.fallbackTab === next.fallbackTab
  )
}

/** Roving tabindex. Thread leaves Tab with the session. Otherwise the
 *  selected tile, or the first tile when nothing is selected. */
export function tileHitTabIndex(altitude: Altitude, selected: boolean, fallback: boolean): 0 | -1 {
  if (altitude === 'thread') return -1
  return selected || fallback ? 0 : -1
}

interface TileProps {
  item: ChatItem
  altitude: Altitude
  selected: boolean
  blocked: boolean
  geometry: { x: number; y: number; w: number; h: number }
  /** Space altitude and zoomed in far enough to paint the mini. */
  showMini: boolean
  showThread: boolean
  /** Membership space. Stays on the element so a move does not remount. */
  spaceId?: string
  /** Find miss. Non-hits fade; the open thread's own dim wins. */
  faded?: boolean
  /** True for the first tile when no tile is selected. */
  fallbackTab?: boolean
  descriptors?: HarnessDescriptor[]
  renderThread: (id: string) => ReactNode
}

export const Tile = memo(function Tile(props: TileProps): JSX.Element {
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
  const harness = harnessAccentKey({
    harnessId: props.item.harnessId,
    command: props.item.command,
  })
  useEffect(() => {
    tileCommitProbe?.(id)
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
      data-space={props.spaceId}
      data-find-hit={props.faded ? 'false' : 'true'}
      data-status={status}
      data-selected={props.selected ? 'true' : 'false'}
      role="gridcell"
      className={`st-${status} absolute flex min-h-0 flex-col border border-line bg-panel${
        focused ? ' focus' : ''
      }`}
      style={{
        left: props.geometry.x,
        top: props.geometry.y,
        width: props.geometry.w,
        height: props.geometry.h,
        zIndex: focused ? 5 : 1,
        opacity: dimmed ? 0.12 : props.faded ? 0.15 : status === 'done' ? 0.7 : undefined,
        borderColor: focused
          ? 'var(--color-em)'
          : status === 'needs'
            ? 'var(--color-warn)'
            : undefined,
        borderWidth: emphasize ? 'calc(2px * min(var(--inv, 1), 4))' : undefined,
        outline: outlined ? 'calc(2.5px * var(--inv, 1)) solid var(--color-em)' : undefined,
        outlineOffset: outlined ? 'calc(7px * var(--inv, 1))' : undefined,
      }}
    >
      <button
        type="button"
        data-tile-hit={id}
        className={`absolute inset-0 z-[1] cursor-pointer bg-transparent${
          props.showThread ? ' pointer-events-none' : ''
        }`}
        tabIndex={tileHitTabIndex(props.altitude, props.selected, props.fallbackTab === true)}
        aria-pressed={props.selected}
        aria-label={`${chip}, ${title}, ${tilePill(status)}`}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute bottom-full z-[2] flex max-w-[90%] items-center rounded-full border border-line bg-panel font-mono"
        style={withVars(
          { '--ch': 'min(var(--inv, 1), 2.2)' },
          {
            left: 'calc(16px * var(--ch, 1))',
            marginBottom: 'calc(9px * var(--ch, 1))',
            fontSize: 'calc(12.5px * var(--ch, 1))',
            gap: '0.55em',
            padding: '0.32em 0.9em 0.32em 0.75em',
            borderWidth: 'calc(1px * var(--ch, 1))',
            opacity: props.altitude === 'thread' ? 0 : 'var(--live, 0)',
          },
        )}
      >
        <span
          className="sc-accent shrink-0 rounded-full"
          data-harness={harness}
          style={{ width: '0.62em', height: '0.62em' }}
        />
        <b className="truncate">{chip}</b>
        <span className="truncate text-ink-dim">{title}</span>
      </div>
      <div
        data-face="card"
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 flex min-w-0 flex-col justify-center"
        style={withVars(
          { '--cs': 'min(var(--inv, 1), 4.4)' },
          {
            opacity: 'calc(1 - var(--live, 0))',
            gap: 'calc(8px * var(--cs, 1))',
            padding: 'calc(18px * var(--cs, 1)) calc(24px * var(--cs, 1))',
          },
        )}
      >
        <div
          className="flex items-center font-mono text-ink"
          style={{ fontSize: 'calc(24px * var(--cs, 1))', gap: '0.4em' }}
        >
          <span
            className="sc-accent shrink-0 rounded-full"
            data-harness={harness}
            style={{ width: '0.62em', height: '0.62em' }}
          />
          <span className="truncate">{chip}</span>
        </div>
        <div className="truncate text-ink-dim" style={{ fontSize: 'calc(13px * var(--cs, 1))' }}>
          {title}
        </div>
        <span
          className={`self-start rounded-full font-mono uppercase ${
            status === 'needs'
              ? 'bg-warn text-bg'
              : status === 'working'
                ? 'bg-em/15 text-em'
                : status === 'done'
                  ? 'text-em'
                  : 'bg-panel-2 text-ink-dim'
          }`}
          style={{
            fontSize: 'calc(10px * var(--cs, 1))',
            letterSpacing: '0.06em',
            padding: '0.45em 0.8em',
          }}
        >
          {tilePill(status)}
        </span>
        {last ? (
          <div
            className="truncate text-ink-dim"
            style={{ fontSize: 'calc(11.5px * var(--cs, 1))', lineHeight: 1.3 }}
          >
            {last}
          </div>
        ) : null}
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
}, sameTile)
