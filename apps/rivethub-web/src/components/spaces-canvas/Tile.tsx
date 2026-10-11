/**
 * One conversation on the canvas. Three faces: a card (everything), a live
 * mini (space), and the focused thread (mounted by the parent after the
 * fly lands). The stage owns pointer selection; this hit target only
 * exposes the name.
 */

import { memo, useEffect, useState, type CSSProperties, type JSX, type ReactNode } from 'react'
import type { HarnessDescriptor, SessionMessage } from '@rivetos/types'
import { Pencil, X } from 'lucide-react'
import { harnessAccentKey } from '../../lib/agent-accent.js'
import type { ChatItem } from '../../lib/harness-chat.js'
import { useChat } from '../../stores/chat.js'
import { useConnection } from '../../stores/connection.js'
import { useSpaces } from '../../stores/spaces.js'
import { rowMembershipKey } from '../drawer-item.js'
import { RenameInput, useSessionTitle } from '../session-rename.js'
import { ThreadMini } from './ThreadMini.js'
import { tileChip, type ModelNames } from './tile-label.js'
import { tilePill, tileStatus, type TileStatus } from './tile-status.js'
import type { Altitude } from './camera.js'

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 180 ? `${flat.slice(0, 179)}…` : flat
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
    prev.fallbackTab === next.fallbackTab &&
    prev.modelNames === next.modelNames
  )
}

/** Roving tabindex. Thread leaves Tab with the session. Otherwise the
 *  selected tile, or the first tile when nothing is selected. */
export function tileHitTabIndex(altitude: Altitude, selected: boolean, fallback: boolean): 0 | -1 {
  if (altitude === 'thread') return -1
  return selected || fallback ? 0 : -1
}

interface TileProps {
  /** Model id → roster agent name, for the tile's leading label. */
  modelNames: ModelNames
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
  const { title, nameKey } = useSessionTitle(props.item)
  const [renaming, setRenaming] = useState(false)
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
  // Leads with the model (as its roster agent's name), not the harness.
  const chip = tileChip(props.item, props.modelNames)
  const everything = props.altitude === 'everything'
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
      className={`st-${status} group absolute flex min-h-0 flex-col border border-line bg-panel material:rounded-2xl material:border-line/50${
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
      {/* Above the box: the label pill, with the rename pencil beside it. The
          pencil shows on the selected tile and on hover; renaming swaps the
          pill for the name box in the same spot. Hidden at Thread. */}
      <div
        data-tile-label=""
        className="pointer-events-none absolute bottom-full z-[2] flex items-center"
        style={withVars(
          { '--ch': 'min(var(--inv, 1), 2.2)' },
          {
            left: 'calc(16px * var(--ch, 1))',
            // Leave the right edge to the rename / back-to-History buttons
            // (two 1.8em buttons, a gap and their inset, in the same --ch).
            maxWidth: 'calc(100% - 6.5em)',
            marginBottom: 'calc(9px * var(--ch, 1))',
            fontSize: 'calc(12.5px * var(--ch, 1))',
            gap: '0.4em',
            display: props.altitude === 'thread' ? 'none' : undefined,
          },
        )}
      >
        {renaming ? (
          <span className="pointer-events-auto min-w-0" style={{ width: '22em' }}>
            <RenameInput
              nameKey={nameKey}
              initial={title}
              onDone={() => setRenaming(false)}
              className="w-full min-w-0 rounded-full border border-em bg-panel-2 text-ink outline-none"
              style={{ padding: '0.32em 0.9em', borderWidth: 'calc(1px * var(--ch, 1))' }}
            />
          </span>
        ) : (
          <>
            <div
              aria-hidden="true"
              className="flex min-w-0 items-center rounded-full border border-line bg-panel"
              style={{
                gap: '0.55em',
                padding: '0.32em 0.9em 0.32em 0.75em',
                borderWidth: 'calc(1px * var(--ch, 1))',
                opacity: 'var(--live, 0)',
              }}
            >
              <span
                className="sc-accent shrink-0 rounded-full"
                data-harness={harness}
                style={{ width: '0.62em', height: '0.62em' }}
              />
              <b className="truncate">{title}</b>
              <span className="truncate text-ink-dim">{chip}</span>
            </div>
          </>
        )}
      </div>
      {/* Rename and back-to-History, on the right. At Everything the tile is
          small on screen, so they move inside its top-right corner and scale
          up with the camera (--ca); elsewhere they sit above the tile's right
          edge. Hidden at Thread and while renaming. */}
      <div
        data-tile-actions=""
        className="pointer-events-none absolute z-[2] flex items-center"
        style={withVars(
          { '--ca': everything ? 'min(var(--inv, 1), 4.4)' : 'min(var(--inv, 1), 2.2)' },
          {
            fontSize: 'calc(12.5px * var(--ca, 1))',
            gap: '0.4em',
            right: 'calc(12px * var(--ca, 1))',
            ...(everything
              ? { top: 'calc(10px * var(--ca, 1))' }
              : { bottom: '100%', marginBottom: 'calc(9px * var(--ca, 1))' }),
            display: props.altitude === 'thread' || renaming ? 'none' : undefined,
          },
        )}
      >
        <button
          type="button"
          data-act=""
          data-tile-rename=""
          aria-label={`Rename ${title}`}
          title="Rename"
          onClick={() => setRenaming(true)}
          className={`pointer-events-auto shrink-0 rounded-full border border-line bg-panel text-ink-dim hover:border-em hover:text-em focus:opacity-100 ${
            props.selected ? '' : 'opacity-0 group-hover:opacity-100'
          }`}
          style={{ padding: '0.4em', borderWidth: 'calc(1px * var(--ca, 1))' }}
        >
          <Pencil style={{ width: '1em', height: '1em' }} />
        </button>
        <button
          type="button"
          data-act=""
          data-tile-unplace=""
          aria-label={`Move ${title} back to History`}
          title="Back to History"
          onClick={() => {
            // Same as Move → History: the thread leaves the space, the
            // conversation itself is untouched.
            const membership = useSpaces.getState().membership
            const base = useConnection.getState().baseUrl
            useSpaces.getState().unplace(rowMembershipKey(base, props.item, membership))
          }}
          className={`pointer-events-auto shrink-0 rounded-full border border-line bg-panel text-ink-dim hover:border-red hover:text-red focus:opacity-100 ${
            props.selected ? '' : 'opacity-0 group-hover:opacity-100'
          }`}
          style={{ padding: '0.4em', borderWidth: 'calc(1px * var(--ca, 1))' }}
        >
          <X style={{ width: '1em', height: '1em' }} />
        </button>
      </div>
      {/* The card face counter-scales its type (--cs) so it stays legible as
          the camera pulls out. Far out that would outgrow the tile and clip
          every line, so the face is a size container and each size is capped
          by the tile's own height (cqh): the content always fits. At
          Everything the last-message line drops (theme.css) to give the
          title, model and status the room. The session title leads; the
          model sits under it, a step smaller. */}
      <div
        data-face="card"
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 [container-type:size]"
        style={withVars(
          { '--cs': 'min(var(--inv, 1), 4.4)' },
          { opacity: 'calc(1 - var(--live, 0))' },
        )}
      >
        <div
          data-face-body=""
          className="flex h-full min-w-0 flex-col justify-center overflow-hidden"
          style={{
            gap: 'min(calc(8px * var(--cs, 1)), 4cqh)',
            padding: 'min(calc(18px * var(--cs, 1)), 9cqh) min(calc(24px * var(--cs, 1)), 7cqw)',
          }}
        >
          <div
            className="shrink-0 truncate text-ink"
            style={{
              fontSize: 'min(calc(22px * var(--cs, 1)), var(--face-title-cap, 15cqh))',
              lineHeight: 1.25,
              // Clear the corner actions, which sit inside the tile here.
              paddingRight: everything ? 'min(calc(44px * var(--cs, 1)), 30cqw)' : undefined,
            }}
          >
            {title}
          </div>
          <div
            className="flex shrink-0 items-center text-ink-dim"
            style={{
              fontSize: 'min(calc(16px * var(--cs, 1)), var(--face-name-cap, 10cqh))',
              lineHeight: 1.3,
              gap: '0.45em',
            }}
          >
            <span
              className="sc-accent shrink-0 rounded-full"
              data-harness={harness}
              style={{ width: '0.62em', height: '0.62em' }}
            />
            <span className="truncate">{chip}</span>
          </div>
          <span
            className={`shrink-0 self-start rounded-full font-mono leading-none uppercase ${
              status === 'needs'
                ? 'bg-warn text-bg'
                : status === 'working'
                  ? 'bg-em/15 text-em'
                  : status === 'done'
                    ? 'text-em'
                    : 'bg-panel-2 text-ink-dim'
            }`}
            style={{
              fontSize: 'min(calc(10px * var(--cs, 1)), var(--face-pill-cap, 7cqh))',
              letterSpacing: '0.06em',
              padding: '0.45em 0.8em',
            }}
          >
            {tilePill(status)}
          </span>
          {last ? (
            <div
              data-face-last=""
              className="shrink-0 truncate text-ink-dim"
              style={{ fontSize: 'min(calc(11.5px * var(--cs, 1)), 8cqh)', lineHeight: 1.3 }}
            >
              {last}
            </div>
          ) : null}
        </div>
      </div>
      {props.showMini ? <ThreadMini item={props.item} descriptors={props.descriptors} /> : null}
      {props.showThread ? (
        <div
          data-thread-live=""
          className="absolute inset-0 z-[3] flex min-h-0 flex-col overflow-hidden bg-bg material:rounded-2xl material:bg-surface"
        >
          {props.renderThread(id)}
        </div>
      ) : null}
    </div>
  )
}, sameTile)
