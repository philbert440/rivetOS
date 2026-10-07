/**
 * Desktop conversations canvas. One implicit region ("Unplaced") holds every
 * drawer row. Everything shows cards, Space shows live read-only minis, and
 * Thread mounts ActiveSession inside the focused tile only after the fly
 * lands. Tile order freezes for the whole time altitude is Thread so a
 * recency update cannot move the focused tile out from under the fly.
 */

import {
  cloneElement,
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { HarnessDescriptor } from '@rivetos/types'
import type { ChatItem } from '../../lib/harness-chat.js'
import { focusInForeignDialog, matchCanvasChord, matchCanvasNav } from '../../lib/hub-keys.js'
import { useChat } from '../../stores/chat.js'
import {
  focusRect,
  layout,
  LIVE_LO,
  type Altitude,
  type NeighborTile,
  type Rect,
  type Viewport,
} from './camera.js'
import {
  canvasKeyClaims,
  performCanvasEffect,
  reduceCanvasCommand,
  type CanvasKeyState,
} from './canvas-input.js'
import { Tile } from './Tile.js'
import { holdTileLease, SelectedPrewarm, WarmLease } from './ThreadMini.js'
import { tileStatus } from './tile-status.js'
import { useCamera } from './use-camera.js'

const REGION_ID = 'unplaced'

/** Buttons, fields, and popup roles keep their own keys. */
const FOCUS_SINK =
  'button, a, input, textarea, select, [contenteditable], [role="menu"], [role="listbox"], [role="dialog"]'

function navFocusAllowed(root: HTMLElement | null): boolean {
  const active = document.activeElement
  if (!(active instanceof Element)) return false
  // A pointer click focuses the tile's hit button. That button is the
  // canvas's own selection, not a sink that should swallow arrows.
  if (active.closest('[data-tile-hit]')) return true
  if (active.closest(FOCUS_SINK)) return false
  if (active === document.body) return true
  return root !== null && root.contains(active)
}

/**
 * Frozen order keeps the relative positions the fly started with, follows a
 * rekey in place, and appends rows that appeared after the snapshot.
 */
function projectFrozen(frozen: readonly string[], rows: readonly ChatItem[]): string[] {
  const live = new Set(rows.map((row) => row.key))
  const resolve = useChat.getState().resolveSessionKey
  const used = new Set<string>()
  const next: string[] = []
  for (const key of frozen) {
    const mapped = live.has(key) ? key : resolve(key)
    if (!live.has(mapped) || used.has(mapped)) continue
    used.add(mapped)
    next.push(mapped)
  }
  for (const row of rows) {
    if (used.has(row.key)) continue
    used.add(row.key)
    next.push(row.key)
  }
  return next
}

export function SpacesCanvas(props: {
  rows: ChatItem[]
  activeId?: string
  /** Plane session ids whose summary is `blocked` (needs you). */
  blockedIds?: ReadonlySet<string>
  descriptors?: HarnessDescriptor[]
  onOpen: (id: string) => void
  renderThread: (id: string) => ReactNode
}): JSX.Element {
  const { rows, activeId, onOpen, renderThread, descriptors } = props
  const blockedIds = props.blockedIds
  const rootRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)
  const [altitude, setAltitude] = useState<Altitude>(activeId ? 'thread' : 'everything')
  const [selectedId, setSelectedId] = useState<string | undefined>(activeId ?? rows[0]?.key)
  const [openId, setOpenId] = useState<string | undefined>(activeId)
  const [threadMounted, setThreadMounted] = useState(false)
  const [navNonce, setNavNonce] = useState(0)
  const [trackedActive, setTrackedActive] = useState(activeId)
  const localOpen = useRef<string | undefined>(undefined)
  const navBridge = useRef(false)
  const armRef = useRef<string | undefined>(undefined)
  const frozenKeys = useRef<string[] | null>(null)
  const openingHold = useRef<(() => void) | undefined>(undefined)
  const queryClient = useQueryClient()
  // First id we rendered for an alias chain. A rekey changes row.key; the
  // React key must not, or Tile and ActiveSession remount under the user.
  const renderKeys = useRef(new Map<string, string>())
  const stableKey = (rowKey: string): string => {
    const resolve = useChat.getState().resolveSessionKey
    const resolved = resolve(rowKey)
    const known = renderKeys.current.get(resolved)
    if (known !== undefined) return known
    for (const [previous, stable] of renderKeys.current) {
      if (resolve(previous) === resolved) {
        renderKeys.current.set(resolved, stable)
        return stable
      }
    }
    renderKeys.current.set(resolved, rowKey)
    return rowKey
  }
  const holdOpening = (id: string): void => {
    const row = rows.find((item) => item.key === id)
    const next = row ? holdTileLease(row, descriptors, queryClient) : undefined
    const previous = openingHold.current
    openingHold.current = next
    if (previous) previous()
  }

  if (
    rows.length > 0 &&
    (selectedId === undefined || !rows.some((row) => row.key === selectedId))
  ) {
    setSelectedId(rows[0].key)
  }

  // URL / store selection changed outside a canvas open. Adjust during render
  // so the camera effect sees navRef on the committed pass (it runs before
  // this component's own effects).
  if (activeId !== trackedActive) {
    setTrackedActive(activeId)
    if (localOpen.current === activeId) {
      localOpen.current = undefined
    } else if (activeId === undefined) {
      if (altitude === 'thread') {
        navBridge.current = true
        setAltitude('everything')
        setThreadMounted(false)
        setNavNonce((n) => n + 1)
      }
    } else {
      const resolvedOpen =
        openId !== undefined ? useChat.getState().resolveSessionKey(openId) : undefined
      // A draft's first send rekeys the same thread. Keep the mounted
      // session; restarting the fly would unmount it out from under the user.
      const sameThread =
        altitude === 'thread' &&
        openId !== undefined &&
        (openId === activeId || resolvedOpen === activeId)
      setOpenId(activeId)
      setSelectedId(activeId)
      if (!sameThread) {
        // Same hold as a click. This commit unmounts every mini; without a
        // ref the opening lease can be the oldest idle one and get evicted
        // before ActiveSession acquires on landing.
        holdOpening(activeId)
        navBridge.current = true
        setAltitude('thread')
        setThreadMounted(false)
        setNavNonce((n) => n + 1)
      }
    }
  }

  const altitudeRef = useRef(altitude)
  const selectedRef = useRef(selectedId)
  const openRef = useRef(openId)
  const tilesRef = useRef<NeighborTile[]>([])
  altitudeRef.current = altitude
  selectedRef.current = selectedId
  openRef.current = openId

  // Capture order on the way into Thread; live order applies again on the
  // way out. Project before the memo so a rekey or a new row is visible
  // on the same render that the rows change.
  if (altitude === 'thread') {
    if (frozenKeys.current === null) frozenKeys.current = rows.map((row) => row.key)
    frozenKeys.current = projectFrozen(frozenKeys.current, rows)
  } else if (frozenKeys.current !== null) {
    frozenKeys.current = null
  }
  const displayRows = useMemo(() => {
    const keys = altitude === 'thread' ? frozenKeys.current : null
    if (keys === null) return rows
    const byKey = new Map(rows.map((row) => [row.key, row]))
    const ordered: ChatItem[] = []
    for (const key of keys) {
      const row = byKey.get(key)
      if (row) ordered.push(row)
    }
    return ordered
  }, [rows, altitude])

  const framedId = altitude === 'thread' ? (openId ?? selectedId) : selectedId
  // Layout needs the viewport, and the viewport lives in the camera hook.
  // Frame with the last vp the hook reported; when it changes, restart the
  // render so the hook's effect commits against the matching rect.
  const framedVp = useRef<Viewport>({ w: 1280, h: 800 })
  const [vpTick, setVpTick] = useState(0)
  const framed = useMemo(() => {
    const view = framedVp.current
    const laid = layout([{ id: REGION_ID, name: 'Unplaced', count: displayRows.length }], view)
    const region = laid.regions[0]
    const tiles: NeighborTile[] = displayRows.map((row, index) => {
      const slot = laid.slots[index]
      return { id: row.key, x: slot.x, y: slot.y }
    })
    const slot = framedId ? tiles.find((tile) => tile.id === framedId) : undefined
    let rect: Rect = laid.allRect
    if (altitude === 'thread' && slot) rect = focusRect(slot, view)
    else if (altitude === 'space') rect = region.rect
    const key = [
      navNonce,
      altitude,
      altitude === 'thread' ? (framedId ?? '') : '',
      rect.x,
      rect.y,
      rect.w,
      rect.h,
    ].join(':')
    return { laid, region, tiles, rect, key }
  }, [displayRows, altitude, framedId, navNonce, vpTick])

  const gestureRef = useRef<(id: string, kind: 'up' | 'double') => void>(() => undefined)
  const camera = useCamera({
    stageRef,
    worldRef,
    target: { key: framed.key, mode: altitude, rect: framed.rect },
    onLand: () => {
      if (altitudeRef.current === 'thread') setThreadMounted(true)
    },
    onHandAltitude: (next) => {
      setAltitude(next)
      if (next === 'everything') setThreadMounted(false)
    },
    onTileGesture: (id, kind) => gestureRef.current(id, kind),
  })
  const { vp, cam, navRef, detachedRef } = camera
  if (vp.w !== framedVp.current.w || vp.h !== framedVp.current.h) {
    framedVp.current = vp
    setVpTick((n) => n + 1)
  }

  if (navBridge.current) {
    navRef.current = true
    detachedRef.current = false
    navBridge.current = false
  }
  tilesRef.current = framed.tiles

  const bump = (): void => {
    navRef.current = true
    detachedRef.current = false
    setNavNonce((n) => n + 1)
  }
  const beginThread = (id: string): void => {
    // Already opening or open: a second click must not restart the fly.
    // The arm ref is cleared on a microtask, before a dblclick arrives.
    if (openId === id && altitude === 'thread') return
    if (armRef.current === id) return
    armRef.current = id
    queueMicrotask(() => {
      if (armRef.current === id) armRef.current = undefined
    })
    // Hold before setState. Entering Thread unmounts every mini in the same
    // commit; without this ref the opening lease can be the oldest idle one
    // and LRU-evicted before ActiveSession acquires on landing.
    holdOpening(id)
    bump()
    setSelectedId(id)
    setOpenId(id)
    setAltitude('thread')
    setThreadMounted(false)
    if (id !== activeId && localOpen.current !== id) {
      localOpen.current = id
      onOpen(id)
    }
  }
  const leaveTo = (next: 'everything' | 'space'): void => {
    bump()
    setAltitude(next)
    if (next === 'everything') setThreadMounted(false)
  }
  gestureRef.current = (id, kind) => {
    if (kind === 'double') {
      beginThread(id)
      return
    }
    // At Thread a click on another tile opens it; the open tile is a no-op.
    if (altitudeRef.current === 'thread') {
      if (id !== openRef.current) beginThread(id)
      return
    }
    if (id === selectedRef.current) beginThread(id)
    else setSelectedId(id)
  }

  const actionsRef = useRef({
    open: beginThread,
    select: setSelectedId,
    go: leaveTo,
  })
  actionsRef.current = { open: beginThread, select: setSelectedId, go: leaveTo }

  useEffect(() => {
    if (altitude !== 'thread' && threadMounted) setThreadMounted(false)
  }, [altitude, threadMounted])

  // Release only after the focused session has acquired. Child effects run
  // before this one, so ActiveSession's bind is already held.
  useEffect(() => {
    if (!openingHold.current) return
    if (threadMounted || altitude !== 'thread') {
      const release = openingHold.current
      openingHold.current = undefined
      release()
    }
  }, [threadMounted, altitude])

  useEffect(() => {
    return () => {
      const release = openingHold.current
      openingHold.current = undefined
      release?.()
    }
  }, [])

  useEffect(() => {
    if (altitude !== 'thread' || openId === undefined) return
    if (rows.some((row) => row.key === openId)) return
    navRef.current = true
    detachedRef.current = false
    setNavNonce((n) => n + 1)
    setAltitude('space')
    setThreadMounted(false)
  }, [altitude, openId, rows, navRef, detachedRef])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.repeat) return
      const chord = matchCanvasChord(event)
      const nav = matchCanvasNav(event)
      if (chord) {
        if (focusInForeignDialog(document.activeElement)) return
      } else if (!navFocusAllowed(rootRef.current)) {
        return
      }
      const state: CanvasKeyState = {
        altitude: altitudeRef.current,
        selectedId: selectedRef.current,
      }
      if (!canvasKeyClaims(state.altitude, chord, nav)) return
      event.preventDefault()
      event.stopPropagation()
      const effect = reduceCanvasCommand(
        state,
        { chord: chord ?? undefined, nav: nav ?? undefined },
        tilesRef.current,
      )
      performCanvasEffect(effect, actionsRef.current)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  let activeCount = 0
  let waitingCount = 0
  for (const row of rows) {
    const blocked =
      blockedIds !== undefined &&
      ((row.sessionId !== undefined && blockedIds.has(row.sessionId)) || blockedIds.has(row.key))
    const status = tileStatus(row.status, blocked)
    if (status === 'working' || status === 'needs') activeCount += 1
    if (status === 'needs') waitingCount += 1
  }
  const selectedRow = rows.find((row) => row.key === selectedId)
  const region = framed.region
  const zoomPct = Math.round(cam.z * 100)
  const paintMini = altitude === 'space' && cam.z >= LIVE_LO

  return (
    <div
      ref={rootRef}
      data-altitude={altitude}
      className="relative h-full min-h-0 min-w-0 flex-1 overflow-hidden bg-bg font-mono text-ink"
    >
      {altitude === 'space' && !paintMini
        ? displayRows.map((row) => <WarmLease key={row.key} item={row} descriptors={descriptors} />)
        : null}
      {altitude === 'everything' && selectedRow ? (
        <SelectedPrewarm key={selectedRow.key} item={selectedRow} descriptors={descriptors} />
      ) : null}
      <div
        ref={stageRef}
        className="absolute inset-0 cursor-grab touch-none overflow-hidden [&.is-panning]:cursor-grabbing"
        style={{
          backgroundImage:
            'radial-gradient(circle, color-mix(in srgb, var(--color-line) calc(var(--dot-a, 0) * 100%), transparent) 1px, transparent 1.6px)',
        }}
      >
        <div
          id="world"
          ref={worldRef}
          className="absolute top-0 left-0"
          style={{ transformOrigin: '0 0' }}
        >
          <div
            data-region="unplaced"
            className="absolute border border-dashed border-line"
            style={{
              left: region.rect.x,
              top: region.rect.y,
              width: region.rect.w,
              height: region.rect.h,
              opacity: altitude === 'thread' ? 0 : 1,
              borderWidth: 'calc(1.5px * var(--inv, 1))',
            }}
          >
            <div
              data-region-label=""
              className="absolute bottom-full left-0 flex items-baseline gap-3 pb-3 text-sm text-ink-dim"
              style={{ fontSize: 'calc(14px * var(--inv, 1))' }}
            >
              <b className="text-ink" style={{ fontSize: '1.35em' }}>
                Unplaced
              </b>
              <span>
                {activeCount} active · {waitingCount} waiting on you
              </span>
            </div>
          </div>
          {displayRows.map((row, index) => {
            const slot = framed.laid.slots[index]
            const isOpen = row.key === openId
            const focused = altitude === 'thread' && isOpen
            const geometry = focused
              ? focusRect(slot, vp)
              : { x: slot.x, y: slot.y, w: slot.w, h: slot.h }
            const blocked =
              blockedIds !== undefined &&
              ((row.sessionId !== undefined && blockedIds.has(row.sessionId)) ||
                blockedIds.has(row.key))
            const showThread = altitude === 'thread' && isOpen && threadMounted
            return (
              <Tile
                key={stableKey(row.key)}
                item={row}
                altitude={altitude}
                selected={altitude === 'thread' ? isOpen : row.key === selectedId}
                blocked={blocked}
                geometry={geometry}
                showMini={paintMini}
                showThread={showThread}
                descriptors={descriptors}
                renderThread={(id) => {
                  const node = renderThread(id)
                  if (!isValidElement(node)) return node
                  // renderThread keys ActiveSession by the view id (chat.tsx).
                  // Override it so a rekey updates the id without remounting.
                  return cloneElement(node, { key: stableKey(id) })
                }}
              />
            )
          })}
        </div>
      </div>
      <div className="pointer-events-none absolute inset-0">
        <nav
          data-hud=""
          aria-label="Location"
          className="pointer-events-auto absolute top-4 left-4 flex max-w-[60%] items-center gap-1 border border-line bg-panel px-1 py-1 text-sm text-ink-dim"
        >
          <button
            type="button"
            className="px-2 py-1 hover:text-ink"
            onClick={() => leaveTo('everything')}
          >
            Everything
          </button>
          <span aria-hidden="true">›</span>
          <button
            type="button"
            className="px-2 py-1 hover:text-ink"
            onClick={() => leaveTo('space')}
          >
            Unplaced
          </button>
          {selectedRow ? (
            <>
              <span aria-hidden="true">›</span>
              <button
                type="button"
                className="truncate px-2 py-1 text-ink hover:text-ink"
                onClick={() => beginThread(selectedRow.key)}
              >
                {selectedRow.title}
              </button>
            </>
          ) : null}
        </nav>
        <nav
          data-hud=""
          aria-label="Zoom level"
          className="pointer-events-auto absolute top-1/2 right-4 flex -translate-y-1/2 flex-col gap-0.5 border border-line bg-panel p-1"
        >
          {(
            [
              ['thread', 'Thread', 'one agent'],
              ['space', 'Space', 'one part of life'],
              ['everything', 'Everything', 'all agents'],
            ] as const
          ).map(([value, label, hint]) => (
            <button
              key={value}
              type="button"
              data-alt={value}
              aria-pressed={altitude === value}
              className={`flex flex-col items-start px-3 py-2 text-left ${
                altitude === value ? 'bg-em/15 text-em' : 'text-ink-dim hover:text-ink'
              }`}
              onClick={() => {
                if (value === 'thread') {
                  if (selectedId) beginThread(selectedId)
                  return
                }
                leaveTo(value)
              }}
            >
              {label}
              <small className="text-[10px] text-ink-dim">{hint}</small>
            </button>
          ))}
          <div className="border-t border-line px-2 py-1 text-center text-[11px] text-ink-dim">
            {zoomPct}%
          </div>
        </nav>
        <div
          data-hud=""
          className="pointer-events-auto absolute bottom-4 left-1/2 flex -translate-x-1/2 gap-1 border border-line bg-panel p-1"
        >
          <button
            type="button"
            className="px-3 py-2 text-sm text-ink hover:bg-em/15"
            onClick={() => {
              const effect = reduceCanvasCommand(
                { altitude, selectedId },
                { chord: 'zoom-toggle' },
                framed.tiles,
              )
              performCanvasEffect(effect, actionsRef.current)
            }}
          >
            {altitude === 'thread' ? 'Zoom out' : 'Zoom in'}{' '}
            <kbd className="text-ink-dim">Ctrl Space</kbd>
          </button>
          <button
            type="button"
            className="px-3 py-2 text-sm text-ink hover:bg-em/15"
            onClick={() => leaveTo('everything')}
          >
            Everything <kbd className="text-ink-dim">Ctrl 0</kbd>
          </button>
        </div>
      </div>
    </div>
  )
}
