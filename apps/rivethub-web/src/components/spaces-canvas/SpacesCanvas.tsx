/**
 * Desktop conversations canvas. One implicit region ("Unplaced") holds every
 * drawer row. Everything shows cards, Space shows live read-only minis, and
 * Thread mounts ActiveSession inside the focused tile only after the fly
 * lands. The mini stays mounted across that landing so the shared stream
 * lease does not drop to zero between the two views.
 */

import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import type { HarnessDescriptor } from '@rivetos/types'
import type { ChatItem } from '../../lib/harness-chat.js'
import { focusInForeignDialog, matchCanvasChord, matchCanvasNav } from '../../lib/hub-keys.js'
import {
  focusRect,
  layout,
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
import { tileStatus } from './tile-status.js'
import { useCamera } from './use-camera.js'

const REGION_ID = 'unplaced'

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
  const stageRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)
  const [altitude, setAltitude] = useState<Altitude>(activeId ? 'thread' : 'everything')
  const [selectedId, setSelectedId] = useState<string | undefined>(activeId ?? rows[0]?.key)
  const [openId, setOpenId] = useState<string | undefined>(activeId)
  const [threadMounted, setThreadMounted] = useState(false)
  const [miniReleased, setMiniReleased] = useState(false)
  const [navNonce, setNavNonce] = useState(0)
  const [trackedActive, setTrackedActive] = useState(activeId)
  const localOpen = useRef<string | undefined>(undefined)
  const navBridge = useRef(false)

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
        setMiniReleased(false)
        setNavNonce((n) => n + 1)
      }
    } else {
      navBridge.current = true
      setOpenId(activeId)
      setSelectedId(activeId)
      setAltitude('thread')
      setThreadMounted(false)
      setMiniReleased(false)
      setNavNonce((n) => n + 1)
    }
  }

  const altitudeRef = useRef(altitude)
  const selectedRef = useRef(selectedId)
  const tilesRef = useRef<NeighborTile[]>([])
  altitudeRef.current = altitude
  selectedRef.current = selectedId

  const framedId = altitude === 'thread' ? (openId ?? selectedId) : selectedId
  // Layout needs the viewport, and the viewport lives in the camera hook.
  // Frame with the last vp the hook reported; when it changes, restart the
  // render so the hook's effect commits against the matching rect.
  const framedVp = useRef<Viewport>({ w: 1280, h: 800 })
  const [vpTick, setVpTick] = useState(0)
  const framed = useMemo(() => {
    const view = framedVp.current
    const laid = layout([{ id: REGION_ID, name: 'Unplaced', count: rows.length }], view)
    const region = laid.regions[0]
    const tiles: NeighborTile[] = rows.map((row, index) => {
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
  }, [rows, altitude, framedId, navNonce, vpTick])

  const camera = useCamera({
    stageRef,
    worldRef,
    target: { key: framed.key, mode: altitude, rect: framed.rect },
    onLand: () => {
      if (altitudeRef.current === 'thread') setThreadMounted(true)
    },
    onHandAltitude: (next) => {
      setAltitude(next)
      setMiniReleased(false)
      if (next === 'everything') setThreadMounted(false)
    },
  })
  const { vp, cam, movedRef, navRef, detachedRef } = camera
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
    if (altitude === 'thread' && openId === id && threadMounted) return
    bump()
    setSelectedId(id)
    setOpenId(id)
    setAltitude('thread')
    setThreadMounted(false)
    setMiniReleased(false)
    if (id !== activeId) {
      localOpen.current = id
      onOpen(id)
    }
  }
  const leaveTo = (next: 'everything' | 'space'): void => {
    bump()
    setAltitude(next)
    setMiniReleased(false)
    if (next === 'everything') setThreadMounted(false)
  }
  const onActivate = (id: string): void => {
    if (movedRef.current) {
      movedRef.current = false
      return
    }
    if (id === selectedId) beginThread(id)
    else setSelectedId(id)
  }

  const actionsRef = useRef({
    open: beginThread,
    select: setSelectedId,
    go: leaveTo,
  })
  actionsRef.current = { open: beginThread, select: setSelectedId, go: leaveTo }

  useEffect(() => {
    if (altitude === 'thread' && threadMounted) {
      setMiniReleased(true)
      return
    }
    if (altitude !== 'thread' && threadMounted) setThreadMounted(false)
  }, [altitude, threadMounted])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.repeat) return
      if (focusInForeignDialog(document.activeElement)) return
      const chord = matchCanvasChord(event)
      const nav = matchCanvasNav(event)
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

  return (
    <div
      id="conversations-pane"
      data-altitude={altitude}
      className="relative h-full min-h-0 min-w-0 flex-1 overflow-hidden bg-bg font-mono text-ink"
    >
      <div
        ref={stageRef}
        className="absolute inset-0 cursor-grab touch-none overflow-hidden [.is-panning]:cursor-grabbing"
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
              <b className="text-base text-ink">Unplaced</b>
              <span>
                {activeCount} active · {waitingCount} waiting on you
              </span>
            </div>
          </div>
          {rows.map((row, index) => {
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
            const showMini =
              altitude === 'space' || (altitude === 'thread' && isOpen && !miniReleased)
            const showThread = altitude === 'thread' && isOpen && threadMounted
            return (
              <Tile
                key={row.key}
                item={row}
                altitude={altitude}
                selected={altitude === 'thread' ? isOpen : row.key === selectedId}
                blocked={blocked}
                geometry={geometry}
                showMini={showMini}
                showThread={showThread}
                descriptors={descriptors}
                renderThread={renderThread}
                onActivate={onActivate}
                onOpen={beginThread}
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
