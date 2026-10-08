/**
 * Desktop conversations canvas. One region per space, in store order, plus a
 * dashed "+ New space". The store always holds at least one space (General),
 * and unplaced threads stay in History. Thread
 * altitude freezes tile order so a recency update cannot move the focused
 * tile out from under the fly.
 */

import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Keyboard } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import type { HarnessDescriptor } from '@rivetos/types'
import type { ChatItem } from '../../lib/harness-chat.js'
import { discardDraft } from '../../lib/discard-session.js'
import {
  CANVAS_KEYS,
  focusInForeignDialog,
  matchCanvasAction,
  matchCanvasChord,
  matchCanvasNav,
  type CanvasAction,
} from '../../lib/hub-keys.js'
import { bindFocusedSpace, bindSpaceThreadStarter } from '../../lib/new-conversation.js'
import { useKeyLabel } from '../../lib/use-key-label.js'
import { storageKey } from '../../lib/session-rekey.js'
import { useRosterAgents } from '../../lib/use-agent-roster.js'
import { useArchived } from '../../stores/archived.js'
import { useChat } from '../../stores/chat.js'
import { useConnection } from '../../stores/connection.js'
import { useSidebarPrefs } from '../../stores/sidebar-prefs.js'
import { useSpaces } from '../../stores/spaces.js'
import { ConversationEmpty } from '../conversation-empty.js'
import { isRowArchived, rowMembershipKey } from '../drawer-item.js'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.js'
import {
  apply,
  focusRect,
  layout,
  LIVE_LO,
  tileSlot,
  type Altitude,
  type NeighborTile,
  type Rect,
  type Viewport,
} from './camera.js'
import {
  mruPreviewId,
  nextWaitingId,
  rankFindHits,
  reconcileNeedsEpisodes,
  rememberThread,
  removeSpaceMessage,
  type FindRow,
  type WaitingTile,
} from './canvas-commands.js'
import {
  canvasKeyClaims,
  performCanvasEffect,
  reduceCanvasCommand,
  type CanvasKeyState,
} from './canvas-input.js'
import { buildCanvasRegions, NEW_SPACE_ID, UNPLACED_ID } from './canvas-regions.js'
import {
  clientRectToWorld,
  clientToWorld,
  DRAG_START_PX,
  dropTarget,
  resolveDrop,
  type DropHit,
} from './drop-target.js'
import { HistoryPanel } from './HistoryPanel.js'
import { applyChooser, startThreadInSpace, takeOffRosterNotice } from './new-thread.js'
import { NewThreadDialog } from './NewThreadDialog.js'
import { SpaceDefaultsDialog } from './SpaceDefaultsDialog.js'
import { defaultAgentChip, startablePreset, startsInDirectory } from './space-defaults.js'
import { Tile } from './Tile.js'
import { tileStatus } from './tile-status.js'
import { holdTileLease, SelectedPrewarm, WarmLease } from './ThreadMini.js'
import { useCamera } from './use-camera.js'

const TOAST_MS = 7000

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
  // Same order, same array: keeps the regions memo stable at Thread.
  if (next.length === frozen.length && next.every((key, index) => key === frozen[index])) {
    return frozen as string[]
  }
  return next
}

function isBlocked(row: ChatItem, blockedIds: ReadonlySet<string> | undefined): boolean {
  if (blockedIds === undefined) return false
  if (row.sessionId !== undefined && blockedIds.has(row.sessionId)) return true
  return blockedIds.has(row.key)
}

function isNeeds(row: ChatItem, blockedIds: ReadonlySet<string> | undefined): boolean {
  return tileStatus(row.status, isBlocked(row, blockedIds)) === 'needs'
}

function isLive(row: ChatItem, blockedIds: ReadonlySet<string> | undefined): boolean {
  const status = tileStatus(row.status, isBlocked(row, blockedIds))
  return status === 'working' || status === 'needs'
}

function hitKey(hit: DropHit): string {
  return hit.kind === 'region' ? `region:${hit.id}` : hit.kind
}

interface DragState {
  source: 'tile' | 'history'
  memberKey: string
  originSpace: string | undefined
  title: string
  x: number
  y: number
  active: boolean
  hitKey: string
}

interface NeedsToast {
  id: string
  rowKey: string
  title: string
}

type NamePrompt = { mode: 'create' }

interface PickState {
  spaceId: string
  title: string
}

function plainEscape(event: KeyboardEvent): boolean {
  return (
    event.key === 'Escape' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
  )
}

function countLabel(active: number, waiting: number): JSX.Element {
  if (waiting > 0) {
    return (
      <span>
        {active} active · <span className="text-warn">{waiting} waiting on you</span>
      </span>
    )
  }
  return (
    <span>
      {active} active · {waiting} waiting on you
    </span>
  )
}

function threadsPhrase(count: number): string {
  return `${String(count)} ${count === 1 ? 'thread' : 'threads'}`
}

function waitingPhrase(count: number): string {
  return count === 1 ? '1 waiting on you' : `${String(count)} waiting on you`
}

/** Spoken altitude. "Space: Code, 4 threads, 1 waiting on you". */
export function altitudeLiveLabel(
  altitude: Altitude,
  spaceName: string | undefined,
  spaceThreads: number,
  spaceWaiting: number,
  placedCount: number,
  needsCount: number,
  threadTitle: string | undefined,
): string {
  if (altitude === 'thread') {
    return threadTitle ? `Thread: ${threadTitle}` : 'Thread'
  }
  if (altitude === 'space') {
    return `Space: ${spaceName ?? 'Space'}, ${threadsPhrase(spaceThreads)}, ${waitingPhrase(spaceWaiting)}`
  }
  return `Everything: ${threadsPhrase(placedCount)}, ${waitingPhrase(needsCount)}`
}

interface PaintedTile {
  row: ChatItem
  selected: boolean
  geometry: { x: number; y: number; w: number; h: number }
  showMini: boolean
  showThread: boolean
  spaceId: string | undefined
  faded: boolean
  /** Spoken name of the row. One row per tile so a move does not remount it. */
  rowLabel: string
}

export function SpacesCanvas(props: {
  rows: ChatItem[]
  activeId?: string
  /** Plane session ids whose summary is `blocked` (needs you). */
  blockedIds?: ReadonlySet<string>
  /** False until the plane query has settled. No prime and no toast before that. */
  blockedReady?: boolean
  descriptors?: HarnessDescriptor[]
  onOpen: (id: string) => void
  renderThread: (id: string) => ReactNode
}): JSX.Element {
  const { rows, activeId, onOpen, renderThread, descriptors, blockedReady } = props
  const blockedIds = props.blockedIds
  const spaces = useSpaces((s) => s.spaces)
  const membership = useSpaces((s) => s.membership)
  const baseUrl = useConnection((s) => s.baseUrl)
  const { agents: rosterAgents } = useRosterAgents()
  const rosterRef = useRef(rosterAgents)
  rosterRef.current = rosterAgents
  const archivedKeys = useArchived((s) => s.keys)
  const conversationsCollapsed = useSidebarPrefs((s) => s.conversationsCollapsed)

  const rootRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLElement | null>(null)
  const findInputRef = useRef<HTMLInputElement>(null)
  const [altitude, setAltitude] = useState<Altitude>(activeId ? 'thread' : 'everything')
  const [selectedId, setSelectedId] = useState<string | undefined>(activeId ?? rows[0]?.key)
  const [openId, setOpenId] = useState<string | undefined>(activeId)
  const [threadMounted, setThreadMounted] = useState(false)
  const [navNonce, setNavNonce] = useState(0)
  const [trackedActive, setTrackedActive] = useState(activeId)
  const [spaceFocus, setSpaceFocus] = useState<string | undefined>(undefined)
  const [historyWanted, setHistoryWanted] = useState(false)
  const [pick, setPick] = useState<PickState | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [namePrompt, setNamePrompt] = useState<NamePrompt | null>(null)
  const [editSpace, setEditSpace] = useState<string | null>(null)
  const [removePrompt, setRemovePrompt] = useState<string | null>(null)
  const [newThread, setNewThread] = useState<{ spaceId?: string } | null>(null)
  const [moveOpen, setMoveOpen] = useState(false)
  const [hover, setHover] = useState<DropHit | null>(null)
  const [ghost, setGhost] = useState<{ x: number; y: number; title: string } | null>(null)
  const [mru, setMru] = useState<string[]>([])
  const [mruStep, setMruStep] = useState(0)
  const [toasts, setToasts] = useState<NeedsToast[]>([])
  const [keysOpen, setKeysOpen] = useState(false)
  // The dock is tucked behind a corner toggle and opens as a column upward,
  // leaving the width to the thread. Find and Move live in it, so it shows
  // while either is open even when tucked.
  const [dockOpen, setDockOpen] = useState(false)
  const label = useKeyLabel()
  const [rosterNotice, setRosterNotice] = useState<string | undefined>()
  const localOpen = useRef<string | undefined>(undefined)
  const navBridge = useRef(false)
  const armRef = useRef<string | undefined>(undefined)
  const frozenKeys = useRef<string[] | null>(null)
  const openingHold = useRef<(() => void) | undefined>(undefined)
  /** Store/URL open. Applied in layout so the hold is not a render-phase store write. */
  const pendingOpenHold = useRef<string | undefined>(undefined)
  const queryClient = useQueryClient()
  // First id we rendered for an alias chain. A rekey changes row.key; the
  // React key must not, or Tile and ActiveSession remount under the user.
  const renderKeys = useRef(new Map<string, string>())
  const tileKeyRef = useRef<string[]>([])
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
  // Filled once per render (below) from the tiles on the canvas.
  const stableFor = new Map<string, string>()
  const renderThreadRef = useRef(renderThread)
  renderThreadRef.current = renderThread
  const stableForRef = useRef(stableFor)
  stableForRef.current = stableFor
  const renderKeyedThread = useCallback((id: string): ReactNode => {
    const node = renderThreadRef.current(id)
    if (!isValidElement(node)) return node
    // renderThread keys ActiveSession by the view id (chat.tsx). Override it
    // so a rekey updates the id without remounting.
    return cloneElement(node, { key: stableForRef.current.get(id) ?? id })
  }, [])
  const suppressGestureRef = useRef(false)
  const consumedClickRef = useRef(false)
  const dragRef = useRef<DragState | null>(null)
  const sinceRef = useRef(new Map<string, number>())
  const announcedRef = useRef(new Set<string>())
  const primedRef = useRef(false)
  const toastTimers = useRef<number[]>([])
  const collapsedWas = useRef(conversationsCollapsed)

  const visibleRows = useMemo(
    () => rows.filter((row) => !isRowArchived(row, archivedKeys, baseUrl)),
    [rows, archivedKeys, baseUrl],
  )

  // Capture order on the way into Thread; live order applies again on the
  // way out. Switching threads at Thread does not reshuffle. Project before
  // the memo so a rekey or a new row is visible on the same render that the
  // rows change.
  if (altitude === 'thread') {
    if (frozenKeys.current === null) frozenKeys.current = visibleRows.map((row) => row.key)
    frozenKeys.current = projectFrozen(frozenKeys.current, visibleRows)
  } else if (frozenKeys.current !== null) {
    frozenKeys.current = null
  }
  const frozen = altitude === 'thread' ? frozenKeys.current : null
  const regions = useMemo(
    () =>
      buildCanvasRegions({
        spaces,
        rows: visibleRows,
        membership,
        baseUrl,
        frozenKeys: frozen,
      }),
    [spaces, visibleRows, membership, baseUrl, frozen],
  )

  const canvasIds = regions.flatMap((region) => region.rows.map((row) => row.key))
  if (
    altitude !== 'thread' &&
    canvasIds.length > 0 &&
    (selectedId === undefined || !canvasIds.includes(selectedId))
  ) {
    setSelectedId(canvasIds[0])
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
      if (sameThread) {
        // The rekeyed id replaces the old one in recents.
        if (openId !== activeId) {
          setMru((list) => list.map((key) => (key === openId ? activeId : key)))
        }
      } else {
        // Same hold as a click, taken in layout (below) rather than here.
        // This commit unmounts every mini; without a ref the opening lease
        // can be the oldest idle one and get evicted before ActiveSession
        // acquires on landing. The mini defers dropping its frozen target
        // so this hold still sees it. Passive stream release is later.
        pendingOpenHold.current = activeId
        navBridge.current = true
        setAltitude('thread')
        setThreadMounted(false)
        setPick(null)
        setFindOpen(false)
        setFindQuery('')
        setMruStep(0)
        setMru((list) => rememberThread(list, activeId))
        setNavNonce((n) => n + 1)
      }
    }
  }

  const altitudeRef = useRef(altitude)
  const selectedRef = useRef(selectedId)
  const openRef = useRef(openId)
  const tilesRef = useRef<NeighborTile[]>([])
  const rowsRef = useRef(rows)
  const baseUrlRef = useRef(baseUrl)
  const membershipRef = useRef(membership)
  const modalRef = useRef(false)
  const spaceInFocusRef = useRef<() => string | undefined>(() => undefined)
  const pickRef = useRef(pick)
  const findOpenRef = useRef(findOpen)
  const keysOpenRef = useRef(keysOpen)
  const bestHitRef = useRef<string | undefined>(undefined)
  const regionRectsRef = useRef<{ id: string; rect: Rect }[]>([])
  const camScreenRef = useRef({ tx: 0, ty: 0, z: 1 })
  const mruRef = useRef(mru)
  const mruStepRef = useRef(mruStep)
  const waitingRef = useRef<WaitingTile[]>([])
  const beginThreadRef = useRef<(id: string) => void>(() => undefined)
  const runActionRef = useRef<(action: CanvasAction) => void>(() => undefined)
  altitudeRef.current = altitude
  selectedRef.current = selectedId
  openRef.current = openId
  rowsRef.current = rows
  baseUrlRef.current = baseUrl
  membershipRef.current = membership
  modalRef.current =
    namePrompt !== null ||
    removePrompt !== null ||
    newThread !== null ||
    editSpace !== null ||
    keysOpen
  pickRef.current = pick
  findOpenRef.current = findOpen
  keysOpenRef.current = keysOpen
  mruRef.current = mru
  mruStepRef.current = mruStep

  const spaceByRow = new Map<string, string>()
  for (const region of regions) {
    for (const row of region.rows) spaceByRow.set(row.key, region.id)
  }
  const focusRowId = altitude === 'thread' ? openId : selectedId
  let framedRegionId: string | undefined
  if (
    altitude === 'space' &&
    spaceFocus !== undefined &&
    regions.some((region) => region.id === spaceFocus)
  ) {
    framedRegionId = spaceFocus
  } else if (focusRowId !== undefined && spaceByRow.has(focusRowId)) {
    framedRegionId = spaceByRow.get(focusRowId)
  } else {
    framedRegionId = regions.find((region) => region.id !== UNPLACED_ID)?.id ?? regions[0]?.id
  }

  const framedVp = useRef<Viewport>({ w: 1280, h: 800 })
  const [vpTick, setVpTick] = useState(0)
  const view = framedVp.current
  const layoutItems = [
    ...regions.map((region) => ({
      id: region.id,
      name: region.name,
      count: region.rows.length,
    })),
    { id: NEW_SPACE_ID, name: 'New space', count: 0 },
  ]
  const laid = layout(layoutItems, view)
  const placed: { row: ChatItem; spaceId: string; slot: (typeof laid.slots)[number] }[] = []
  for (const region of regions) {
    const laidRegion = laid.regions.find((item) => item.id === region.id)
    if (!laidRegion) continue
    region.rows.forEach((row, index) => {
      const slot = laidRegion.slots[index]
      placed.push({ row, spaceId: region.id, slot })
    })
  }
  const openPlaced = placed.find((item) => item.row.key === openId)
  const focusSlot =
    openPlaced?.slot ??
    (altitude === 'thread' && openId !== undefined
      ? tileSlot('focus', { x: 0, y: 0 }, 0)
      : undefined)
  let rect: Rect = laid.allRect
  if (altitude === 'thread' && focusSlot) rect = focusRect(focusSlot, view)
  else if (altitude === 'space') {
    const framed = laid.regions.find((region) => region.id === framedRegionId)
    if (framed) rect = framed.rect
  }
  const frameKey = [
    navNonce,
    altitude,
    altitude === 'thread' ? (openId ?? '') : altitude === 'space' ? (framedRegionId ?? '') : '',
    rect.x,
    rect.y,
    rect.w,
    rect.h,
    vpTick,
  ].join(':')

  const filtering = findQuery.trim().length > 0
  const findRows: FindRow[] = placed.map((item) => ({
    id: item.row.key,
    needs: isNeeds(item.row, blockedIds),
    updatedAt: item.row.updatedAt,
    haystack: [
      item.row.agentName,
      item.row.title,
      item.row.command,
      regionName(regions, item.spaceId),
    ]
      .filter((part) => part !== undefined && part.length > 0)
      .join(' '),
  }))
  const hits = filtering ? rankFindHits(findRows, findQuery) : []
  const hitIds = new Set(hits.map((hit) => hit.id))
  bestHitRef.current = hits[0]?.id

  const waiting: WaitingTile[] = []
  let needsCount = 0
  for (const item of placed) {
    if (!isNeeds(item.row, blockedIds)) continue
    needsCount += 1
    const sessionSince =
      item.row.sessionId !== undefined ? sinceRef.current.get(item.row.sessionId) : undefined
    waiting.push({
      id: item.row.key,
      since: sessionSince ?? sinceRef.current.get(item.row.key) ?? item.row.updatedAt,
    })
  }
  waitingRef.current = waiting
  // At Thread the regions are opacity 0 and ignore pointers. Publishing their
  // rects let a History drop place into a region the user cannot see, which
  // also jumped the open tile between lists and remounted it.
  regionRectsRef.current =
    altitude === 'thread'
      ? []
      : laid.regions
          .filter((region) => region.id !== NEW_SPACE_ID && region.id !== UNPLACED_ID)
          .map((region) => ({ id: region.id, rect: region.rect }))

  const navSource =
    altitude === 'space' ? placed.filter((item) => item.spaceId === framedRegionId) : placed
  tilesRef.current = navSource.map((item) => ({
    id: item.row.key,
    x: item.slot.x,
    y: item.slot.y,
  }))

  const gestureRef = useRef<(id: string, kind: 'up' | 'double') => void>(() => undefined)
  const camera = useCamera({
    stageRef,
    worldRef,
    target: { key: frameKey, mode: altitude, rect },
    onLand: () => {
      if (altitudeRef.current === 'thread') setThreadMounted(true)
    },
    onHandAltitude: (next) => {
      setAltitude(next)
      if (next === 'everything') setThreadMounted(false)
    },
    onTileGesture: (id, kind) => gestureRef.current(id, kind),
    suppressGestureRef,
  })
  const { vp, cam, navRef, detachedRef } = camera
  if (vp.w !== framedVp.current.w || vp.h !== framedVp.current.h) {
    framedVp.current = vp
    setVpTick((n) => n + 1)
  }
  const screen = apply(cam, vp)
  camScreenRef.current = { tx: screen.tx, ty: screen.ty, z: screen.z }

  if (navBridge.current) {
    navRef.current = true
    detachedRef.current = false
    navBridge.current = false
  }

  const bump = (): void => {
    navRef.current = true
    detachedRef.current = false
    setNavNonce((n) => n + 1)
  }
  const holdOpening = (id: string): void => {
    let row = rowsRef.current.find((item) => item.key === id)
    if (!row && useChat.getState().drafts.includes(id)) {
      row = {
        key: id,
        kind: 'draft',
        title: 'new conversation',
        updatedAt: useChat.getState().draftCreatedAt[id] ?? 0,
      }
    }
    const next = row ? holdTileLease(row, descriptors, queryClient) : undefined
    const previous = openingHold.current
    openingHold.current = next
    if (previous) previous()
  }
  const spaceForSession = (id: string): string | undefined => {
    const state = useSpaces.getState()
    const row = rowsRef.current.find((item) => item.key === id)
    if (row) return state.spaceOf(rowMembershipKey(baseUrlRef.current, row, state.membership))
    if (useChat.getState().drafts.includes(id)) {
      return state.spaceOf(storageKey(baseUrlRef.current, id))
    }
    return undefined
  }
  const beginThread = (id: string): void => {
    setMruStep(0)
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
    setMru((list) => rememberThread(list, id))
    const spaceId = spaceForSession(id)
    if (spaceId) setSpaceFocus(spaceId)
    setPick(null)
    setFindOpen(false)
    setFindQuery('')
    setMoveOpen(false)
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
  beginThreadRef.current = beginThread
  const leaveTo = (next: 'everything' | 'space'): void => {
    bump()
    setAltitude(next)
    if (next === 'everything') setThreadMounted(false)
  }
  const selectTile = (id: string): void => {
    setSelectedId(id)
    const regionId = spaceByRow.get(id)
    if (
      regionId !== undefined &&
      regionId !== UNPLACED_ID &&
      spaces.some((space) => space.id === regionId)
    ) {
      setSpaceFocus(regionId)
    }
  }
  gestureRef.current = (id, kind) => {
    if (kind === 'double') {
      beginThread(id)
      return
    }
    if (altitudeRef.current === 'thread') {
      if (id !== openRef.current) beginThread(id)
      return
    }
    if (id === selectedRef.current) beginThread(id)
    else selectTile(id)
  }

  const realSpace = (regionId: string | undefined): string | undefined => {
    if (regionId === undefined || regionId === UNPLACED_ID) return undefined
    return spaces.some((space) => space.id === regionId) ? regionId : undefined
  }
  // Space altitude: the framed space, even when the selection sits in another
  // region. Everything has no framed space, so the chooser keeps its selector.
  // Thread (dock only — letters are not claimed) uses the open thread's space.
  const spaceYouAreIn = (): string | undefined => {
    if (altitude === 'space') return realSpace(framedRegionId)
    if (altitude === 'thread') {
      return realSpace(openId !== undefined ? spaceByRow.get(openId) : undefined)
    }
    return undefined
  }
  spaceInFocusRef.current = spaceYouAreIn
  const removeSelectedThread = (): void => {
    const id = selectedRef.current
    if (id === undefined) return
    const row = rowsRef.current.find((item) => item.key === id)
    if (!row) return
    const node = row.pinNodeBaseUrl ?? baseUrlRef.current
    if (row.kind === 'draft' && row.pin !== true) discardDraft(node, row.key)
    else useArchived.getState().archive(storageKey(node, row.key))
  }
  const runAction = (action: CanvasAction): void => {
    const handlers: Record<CanvasAction, () => void> = {
      'new-space': () => setNamePrompt({ mode: 'create' }),
      'rename-space': () => {
        const id = spaceYouAreIn()
        if (id === undefined) return
        if (!spaces.some((item) => item.id === id)) return
        setEditSpace(id)
      },
      'remove-space': () => {
        const id = spaceYouAreIn()
        if (id === undefined) return
        setRemovePrompt(id)
      },
      'new-thread': () => setNewThread({ spaceId: spaceYouAreIn() }),
      'remove-thread': () => removeSelectedThread(),
      move: () => {
        if (selectedRef.current !== undefined && canvasIds.includes(selectedRef.current)) {
          setMoveOpen((open) => !open)
        }
      },
      history: () => {
        if (pickRef.current) return
        setHistoryWanted((open) => !open)
      },
      find: () => setFindOpen(true),
      'next-waiting': () => {
        const id = nextWaitingId(
          waitingRef.current,
          openRef.current,
          altitudeRef.current === 'thread',
        )
        if (id !== undefined) beginThread(id)
      },
      mru: () => {
        if (mruRef.current.length === 0) return
        setMruStep((step) => step + 1)
      },
      keys: () => setKeysOpen((open) => !open),
    }
    handlers[action]()
  }
  runActionRef.current = runAction

  const actionsRef = useRef({
    open: beginThread,
    select: selectTile,
    go: leaveTo,
  })
  actionsRef.current = { open: beginThread, select: selectTile, go: leaveTo }

  const selectedPlaced = placed.find((item) => item.row.key === selectedId)
  if (moveOpen && selectedPlaced === undefined) setMoveOpen(false)

  useEffect(() => {
    if (altitude !== 'thread' && threadMounted) setThreadMounted(false)
  }, [altitude, threadMounted])

  // Store selection. bindSessionStream can write the chat store; doing that
  // during render warns if another subscriber is mounted. Layout is before
  // the minis' passive cleanups, so the ref is held before they release.
  const holdOpeningRef = useRef(holdOpening)
  holdOpeningRef.current = holdOpening
  useLayoutEffect(() => {
    const id = pendingOpenHold.current
    if (id === undefined) return
    pendingOpenHold.current = undefined
    holdOpeningRef.current(id)
  })

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

  const visibleKey = visibleRows.map((row) => row.key).join('\0')
  useEffect(() => {
    if (altitude !== 'thread' || openId === undefined) return
    if (visibleRows.some((row) => row.key === openId)) return
    if (useChat.getState().drafts.includes(openId)) return
    navRef.current = true
    detachedRef.current = false
    setNavNonce((n) => n + 1)
    setAltitude('space')
    setThreadMounted(false)
  }, [altitude, openId, visibleKey, visibleRows, navRef, detachedRef])

  useEffect(() => {
    const prev = collapsedWas.current
    collapsedWas.current = conversationsCollapsed
    if (!prev && conversationsCollapsed) {
      setHistoryWanted(false)
      setPick(null)
    }
  }, [conversationsCollapsed])

  useEffect(() => {
    if (findOpen) findInputRef.current?.focus()
  }, [findOpen])

  useEffect(() => {
    const active = document.activeElement
    if (!(active instanceof Element) || active.closest('[data-tile-hit]') === null) return
    if (selectedId === undefined) return
    const root = rootRef.current
    if (!root) return
    const next = root.querySelector(
      `[data-tile-hit="${selectedId.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`,
    )
    if (next instanceof HTMLElement && next !== active) next.focus()
  }, [selectedId])

  useEffect(() => {
    if (blockedReady !== true) return
    const ids = blockedIds ?? new Set<string>()
    const episode = reconcileNeedsEpisodes(
      sinceRef.current,
      announcedRef.current,
      ids,
      Date.now(),
      primedRef.current,
    )
    primedRef.current = episode.primed
    for (const id of episode.fresh) {
      const open = openRef.current
      const openRow = rowsRef.current.find((row) => row.key === open)
      if (open !== undefined && (open === id || openRow?.sessionId === id)) continue
      const row = rowsRef.current.find((item) => item.key === id || item.sessionId === id)
      const toast: NeedsToast = {
        id,
        rowKey: row?.key ?? id,
        title: row?.title ?? 'Session',
      }
      setToasts((prev) => [...prev, toast])
      const timer = window.setTimeout(() => {
        setToasts((prev) => prev.filter((item) => item.id !== id))
      }, TOAST_MS)
      toastTimers.current.push(timer)
    }
  }, [blockedIds, blockedReady])

  useEffect(() => {
    return () => {
      for (const timer of toastTimers.current) window.clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.repeat) return
      // The panel is a modal, so this has to run before that guard. `?` is
      // not claimed at Thread; the dock button opens it there, and `?` closes
      // it again. A field keeps the character.
      if (
        keysOpenRef.current &&
        event.key === '?' &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey
      ) {
        const active = document.activeElement
        const typing =
          active instanceof Element && active.closest('input, textarea, select') !== null
        if (!typing) {
          event.preventDefault()
          event.stopPropagation()
          setKeysOpen(false)
          return
        }
      }
      if (modalRef.current) return
      const findFocused = (): boolean => {
        const active = document.activeElement
        return active instanceof Element && active.getAttribute('data-dock') === 'find'
      }
      if (findOpenRef.current && findFocused() && plainEscape(event)) {
        event.preventDefault()
        event.stopPropagation()
        setFindOpen(false)
        setFindQuery('')
        return
      }
      if (
        findOpenRef.current &&
        findFocused() &&
        event.key === 'Enter' &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        !event.isComposing
      ) {
        event.preventDefault()
        event.stopPropagation()
        const id = bestHitRef.current
        setFindOpen(false)
        setFindQuery('')
        if (id !== undefined) beginThreadRef.current(id)
        return
      }
      if (pickRef.current && plainEscape(event) && altitudeRef.current !== 'thread') {
        const active = document.activeElement
        if (active instanceof Element && active.closest('input, textarea')) return
        const root = rootRef.current
        const inCanvas = active instanceof Node && root !== null && root.contains(active)
        const inHistory =
          active instanceof Element && active.closest('[data-history-panel]') !== null
        const onBody = active === document.body || active === document.documentElement
        if (!inCanvas && !inHistory && !onBody) return
        event.preventDefault()
        event.stopPropagation()
        setPick(null)
        return
      }
      const chord = matchCanvasChord(event)
      const nav = matchCanvasNav(event)
      const action = matchCanvasAction(event)
      if (chord || action === 'next-waiting' || action === 'mru') {
        if (focusInForeignDialog(document.activeElement)) return
      } else if (!navFocusAllowed(rootRef.current)) {
        return
      }
      const state: CanvasKeyState = {
        altitude: altitudeRef.current,
        selectedId: selectedRef.current,
      }
      if (!canvasKeyClaims(state.altitude, chord, nav, action)) return
      event.preventDefault()
      event.stopPropagation()
      if (action) {
        runActionRef.current(action)
        return
      }
      const effect = reduceCanvasCommand(
        state,
        { chord: chord ?? undefined, nav: nav ?? undefined },
        tilesRef.current,
      )
      performCanvasEffect(effect, actionsRef.current)
    }
    const commitMru = (): void => {
      const step = mruStepRef.current
      if (step <= 0) return
      const id = mruPreviewId(mruRef.current, step)
      setMruStep(0)
      if (id !== undefined) beginThreadRef.current(id)
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key === 'Control') commitMru()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('blur', commitMru)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', commitMru)
    }
  }, [])

  useEffect(() => {
    bindSpaceThreadStarter(() => {
      if (modalRef.current) return undefined
      if (!navFocusAllowed(rootRef.current)) return undefined
      const spaceId = spaceInFocusRef.current()
      if (!spaceId) return undefined
      const defaults = useSpaces.getState().spaces.find((space) => space.id === spaceId)?.defaults
      if (!defaults) return undefined
      const id = startThreadInSpace(spaceId, useConnection.getState().baseUrl, rosterRef.current)
      setRosterNotice(takeOffRosterNotice())
      return id
    })
    return () => bindSpaceThreadStarter(null)
  }, [])

  useEffect(() => {
    bindFocusedSpace(() => spaceInFocusRef.current())
    return () => bindFocusedSpace(null)
  }, [])

  useEffect(() => {
    const hitAt = (clientX: number, clientY: number): DropHit => {
      const stage = stageRef.current
      if (!stage) return { kind: 'none' }
      const bounds = stage.getBoundingClientRect()
      const camNow = camScreenRef.current
      const point = clientToWorld({ x: clientX, y: clientY }, bounds, camNow)
      const panel = panelRef.current
      const panelRect = panel
        ? clientRectToWorld(panel.getBoundingClientRect(), bounds, camNow)
        : null
      return dropTarget(point, regionRectsRef.current, panelRect)
    }
    const onDown = (event: PointerEvent): void => {
      if (modalRef.current) return
      if (event.button !== 0) return
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest('[data-thread-live]')) return
      if (target.closest('[data-act]')) return
      const tile = target.closest('[data-tile]')
      if (!tile) return
      const id = tile.getAttribute('data-tile')
      if (!id) return
      const row = rowsRef.current.find((item) => item.key === id)
      if (!row) return
      dragRef.current = {
        source: 'tile',
        memberKey: rowMembershipKey(baseUrlRef.current, row, membershipRef.current),
        originSpace: tile.getAttribute('data-space') ?? undefined,
        title: row.title,
        x: event.clientX,
        y: event.clientY,
        active: false,
        hitKey: '',
      }
    }
    const onMove = (event: PointerEvent): void => {
      const drag = dragRef.current
      if (!drag) return
      if (!drag.active) {
        const dx = event.clientX - drag.x
        const dy = event.clientY - drag.y
        if (Math.hypot(dx, dy) < DRAG_START_PX) return
        drag.active = true
        if (drag.source === 'tile') suppressGestureRef.current = true
        document.documentElement.style.cursor = 'grabbing'
      }
      const hit = hitAt(event.clientX, event.clientY)
      const key = hitKey(hit)
      if (drag.hitKey !== key) {
        drag.hitKey = key
        setHover(hit)
      }
      setGhost({ x: event.clientX, y: event.clientY, title: drag.title })
    }
    const endDrag = (event: PointerEvent, cancel: boolean): void => {
      const drag = dragRef.current
      if (!drag) return
      dragRef.current = null
      document.documentElement.style.cursor = ''
      if (!drag.active || cancel) {
        if (drag.active && drag.source === 'tile') suppressGestureRef.current = false
        if (drag.active) {
          setGhost(null)
          setHover(null)
        }
        return
      }
      const hit = hitAt(event.clientX, event.clientY)
      const action = resolveDrop({ source: drag.source, originSpace: drag.originSpace, hit })
      if (action === 'place' && hit.kind === 'region') {
        useSpaces.getState().place(drag.memberKey, hit.id)
      } else if (action === 'unplace') {
        useSpaces.getState().unplace(drag.memberKey)
      }
      if (drag.source === 'history') {
        // The click that follows pointerup is synchronous, so it still sees
        // the flag. A pointerup outside the window never fires that click;
        // the microtask clears the flag before the next real History click.
        consumedClickRef.current = true
        queueMicrotask(() => {
          consumedClickRef.current = false
        })
      }
      const stage = stageRef.current
      const target = event.target
      const inside = target instanceof Node && stage !== null && stage.contains(target)
      if (!inside) suppressGestureRef.current = false
      setGhost(null)
      setHover(null)
    }
    const onUp = (event: PointerEvent): void => {
      endDrag(event, false)
    }
    const onCancel = (event: PointerEvent): void => {
      endDrag(event, true)
    }
    const onClick = (event: MouseEvent): void => {
      if (!consumedClickRef.current) return
      consumedClickRef.current = false
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onCancel, true)
    window.addEventListener('click', onClick, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onCancel, true)
      window.removeEventListener('click', onClick, true)
      document.documentElement.style.cursor = ''
    }
  }, [])

  const framedRegion = regions.find((region) => region.id === framedRegionId)
  const crumbSpace = framedRegion?.name
  const framedRows = framedRegion?.rows ?? []
  const framedNeeds = framedRows.filter((row) => isNeeds(row, blockedIds)).length
  const crumbThread =
    rows.find((row) => row.key === (altitude === 'thread' ? openId : selectedId)) ??
    rows.find((row) => row.key === selectedId)
  const zoomPct = Math.round(cam.z * 100)
  const paintMini = altitude === 'space' && cam.z >= LIVE_LO
  const selectedCanvas = placed.find((item) => item.row.key === selectedId)
  const openRow = openId !== undefined ? visibleRows.find((row) => row.key === openId) : undefined
  const showSynthetic =
    altitude === 'thread' &&
    openRow !== undefined &&
    openPlaced === undefined &&
    focusSlot !== undefined
  const previewId = mruPreviewId(mru, mruStep)
  const mruHead = mru.slice(0, 5)
  const mruShown =
    previewId !== undefined && !mruHead.includes(previewId) ? [...mruHead, previewId] : mruHead
  const historyOpen = historyWanted || pick !== null
  const removeSpace = spaces.find((space) => space.id === removePrompt)
  const removeRows = regions.find((region) => region.id === removePrompt)?.rows ?? []
  const editing = editSpace ? spaces.find((space) => space.id === editSpace) : undefined
  const dockStartsIn = startsInDirectory(
    startablePreset(spaces.find((space) => space.id === spaceYouAreIn())?.defaults, rosterAgents)
      ?.directory,
  )

  const rowLabelFor = (spaceId: string | undefined): string => {
    if (!spaceId || spaceId === UNPLACED_ID) return 'History'
    return regionName(regions, spaceId) ?? 'Space'
  }
  const paintedTiles: PaintedTile[] = placed.map((item) => {
    const isOpen = item.row.key === openId
    const focused = altitude === 'thread' && isOpen
    const spaceId = item.spaceId === UNPLACED_ID ? undefined : item.spaceId
    return {
      row: item.row,
      selected: altitude === 'thread' ? isOpen : item.row.key === selectedId,
      geometry: focused
        ? focusRect(item.slot, vp)
        : { x: item.slot.x, y: item.slot.y, w: item.slot.w, h: item.slot.h },
      showMini: paintMini && item.spaceId === framedRegionId,
      showThread: altitude === 'thread' && isOpen && threadMounted,
      spaceId,
      faded: filtering && !hitIds.has(item.row.key),
      rowLabel: rowLabelFor(spaceId),
    }
  })
  // Same array as the placed tiles, so a placed ↔ History move keeps the
  // open thread's React parent and does not remount ActiveSession.
  if (showSynthetic && openRow && focusSlot) {
    paintedTiles.push({
      row: openRow,
      selected: true,
      geometry: focusRect(focusSlot, vp),
      showMini: false,
      showThread: threadMounted,
      spaceId: undefined,
      faded: false,
      rowLabel: 'History',
    })
  }
  const nothingSelected = !paintedTiles.some((item) => item.selected)
  const firstTileId = paintedTiles[0]?.row.key
  const tileRows = paintedTiles.map((item) => item.row)
  for (const row of tileRows) stableFor.set(row.key, stableKey(row.key))
  // Prune after commit. stableKey still writes during render so this pass
  // has a key; deleting here cannot drop a key the children are about to use.
  tileKeyRef.current = tileRows.map((row) => row.key)
  useLayoutEffect(() => {
    const resolve = useChat.getState().resolveSessionKey
    const keep = new Set<string>()
    for (const key of tileKeyRef.current) {
      keep.add(key)
      keep.add(resolve(key))
    }
    for (const key of renderKeys.current.keys()) {
      if (!keep.has(key)) renderKeys.current.delete(key)
    }
  })

  return (
    <div
      ref={rootRef}
      data-altitude={altitude}
      className="spaces-canvas relative h-full min-h-0 min-w-0 flex-1 overflow-hidden bg-bg font-mono text-ink"
    >
      {altitude === 'space' && !paintMini
        ? framedRows.map((row) => <WarmLease key={row.key} item={row} descriptors={descriptors} />)
        : null}
      {altitude === 'everything' && selectedCanvas ? (
        <SelectedPrewarm
          key={selectedCanvas.row.key}
          item={selectedCanvas.row}
          descriptors={descriptors}
        />
      ) : null}
      {rows.length === 0 ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <ConversationEmpty />
        </div>
      ) : null}
      <p className="sr-only" aria-live="polite" data-altitude-live="">
        {altitudeLiveLabel(
          altitude,
          crumbSpace,
          framedRows.length,
          framedNeeds,
          placed.length,
          needsCount,
          crumbThread?.title,
        )}
      </p>
      <div
        ref={stageRef}
        className="sc-ground absolute inset-0 cursor-grab touch-none overflow-hidden [&.is-panning]:cursor-grabbing"
      >
        <div
          id="world"
          ref={worldRef}
          role="grid"
          aria-label="Conversations"
          className="absolute top-0 left-0"
          style={{ transformOrigin: '0 0' }}
        >
          {laid.regions.map((region) => {
            const model = regions.find((item) => item.id === region.id)
            const isNew = region.id === NEW_SPACE_ID
            const dashed = isNew || region.id === UNPLACED_ID
            const hidden = altitude === 'thread'
            const faded = !hidden && filtering && isNew
            const active = model ? model.rows.filter((row) => isLive(row, blockedIds)).length : 0
            const waitingOn = model
              ? model.rows.filter((row) => isNeeds(row, blockedIds)).length
              : 0
            const real = !isNew && region.id !== UNPLACED_ID
            const regionSpace = real ? spaces.find((space) => space.id === region.id) : undefined
            const chip = regionSpace
              ? defaultAgentChip(regionSpace.defaults, rosterAgents)
              : undefined
            return (
              <div
                key={region.id}
                data-region={region.id}
                role="presentation"
                inert={hidden ? true : undefined}
                aria-hidden={hidden ? true : undefined}
                className={`sc-region absolute border border-line ${dashed ? 'border-dashed' : 'border-solid'}`}
                style={{
                  left: region.rect.x,
                  top: region.rect.y,
                  width: region.rect.w,
                  height: region.rect.h,
                  opacity: hidden ? 0 : faded ? 0.15 : 1,
                  pointerEvents: hidden ? 'none' : undefined,
                  borderWidth: 'calc(1.5px * var(--inv, 1))',
                  outline:
                    hover?.kind === 'region' && hover.id === region.id
                      ? '2px solid var(--color-em)'
                      : undefined,
                }}
              >
                {isNew ? (
                  <button
                    type="button"
                    data-act=""
                    data-add-space=""
                    className="absolute inset-0 text-sm text-ink-dim hover:text-em"
                    onClick={() => setNamePrompt({ mode: 'create' })}
                  >
                    + New space
                  </button>
                ) : (
                  <div
                    data-region-label=""
                    className="absolute bottom-full left-0 flex items-baseline gap-3 pb-3 text-sm text-ink-dim"
                    style={{ fontSize: 'calc(14px * var(--inv, 1))' }}
                  >
                    <b className="text-ink" style={{ fontSize: '1.35em' }}>
                      {model?.name ?? region.id}
                    </b>
                    {chip ? (
                      <span
                        data-space-default=""
                        className="border border-line px-1.5 text-ink-dim"
                      >
                        {chip.name}
                        {chip.directoryBase ? ` · ${chip.directoryBase}` : ''}
                      </span>
                    ) : null}
                    {countLabel(active, waitingOn)}
                    {real ? (
                      <>
                        <button
                          type="button"
                          data-act=""
                          aria-label={`Edit ${model?.name ?? 'space'}`}
                          className="hover:text-ink"
                          onClick={() => setEditSpace(region.id)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          data-act=""
                          aria-label={`Remove ${model?.name ?? 'space'}`}
                          className="hover:text-ink"
                          onClick={() => setRemovePrompt(region.id)}
                        >
                          ×
                        </button>
                      </>
                    ) : null}
                  </div>
                )}
              </div>
            )
          })}
          {paintedTiles.map((item) => {
            const concealRow = altitude === 'thread' && item.row.key !== openId
            return (
              <div
                key={stableFor.get(item.row.key) ?? item.row.key}
                role="row"
                aria-label={item.rowLabel}
                inert={concealRow ? true : undefined}
                aria-hidden={concealRow ? true : undefined}
              >
                <Tile
                  item={item.row}
                  altitude={altitude}
                  selected={item.selected}
                  blocked={isBlocked(item.row, blockedIds)}
                  geometry={item.geometry}
                  showMini={item.showMini}
                  showThread={item.showThread}
                  spaceId={item.spaceId}
                  faded={item.faded}
                  fallbackTab={nothingSelected && item.row.key === firstTileId}
                  descriptors={descriptors}
                  renderThread={renderKeyedThread}
                />
              </div>
            )
          })}
          {regions.map((region) => {
            if (region.id === UNPLACED_ID) return null
            const laidRegion = laid.regions.find((item) => item.id === region.id)
            if (!laidRegion) return null
            const empty = region.rows.length === 0
            const slot = tileSlot(region.id, laidRegion.rect, region.rows.length)
            const hidden = altitude === 'thread'
            const slotStartsIn = startsInDirectory(
              startablePreset(
                spaces.find((space) => space.id === region.id)?.defaults,
                rosterAgents,
              )?.directory,
            )
            return (
              <button
                key={`add-${region.id}`}
                type="button"
                data-act=""
                data-add-thread={region.id}
                data-empty-thread={empty ? '' : undefined}
                inert={hidden ? true : undefined}
                aria-hidden={hidden ? true : undefined}
                className={`absolute border border-dashed border-line text-sm text-ink-dim hover:border-em hover:text-em${
                  empty ? ' flex items-center justify-center' : ''
                }`}
                style={{
                  left: empty ? laidRegion.rect.x : slot.x,
                  top: empty ? laidRegion.rect.y : slot.y,
                  width: empty ? laidRegion.rect.w : slot.w,
                  height: empty ? laidRegion.rect.h : slot.h,
                  opacity: hidden ? 0 : filtering ? 0.15 : 1,
                  pointerEvents: hidden ? 'none' : undefined,
                  borderWidth: 'calc(1.5px * var(--inv, 1))',
                }}
                title={slotStartsIn}
                onClick={() => setNewThread({ spaceId: region.id })}
              >
                + New thread
              </button>
            )
          })}
        </div>
      </div>
      <HistoryPanel
        items={rows}
        active={openId}
        open={historyOpen}
        highlighted={hover?.kind === 'history'}
        panelRef={panelRef}
        pick={pick ? { title: pick.title, onCancel: () => setPick(null) } : undefined}
        onOpen={(id) => {
          if (consumedClickRef.current) {
            consumedClickRef.current = false
            return
          }
          const choosing = pickRef.current
          if (choosing) {
            const row = rowsRef.current.find((item) => item.key === id)
            if (!row) return
            applyChooser({
              type: 'history',
              rowKey: rowMembershipKey(baseUrlRef.current, row, membershipRef.current),
              spaceId: choosing.spaceId,
              sessionId: id,
              open: (sessionId) => beginThread(sessionId),
            })
            setPick(null)
            return
          }
          beginThread(id)
        }}
        onDragPointerDown={(event, item) => {
          if (pick || modalRef.current || event.button !== 0) return
          dragRef.current = {
            source: 'history',
            memberKey: rowMembershipKey(baseUrl, item, membership),
            originSpace: useSpaces.getState().spaceOf(rowMembershipKey(baseUrl, item, membership)),
            title: item.title,
            x: event.clientX,
            y: event.clientY,
            active: false,
            hitKey: '',
          }
        }}
      />
      {ghost ? (
        <div
          data-drag-ghost=""
          className="sc-ghost pointer-events-none fixed z-50 border border-em bg-panel px-3 py-2 font-mono text-sm text-ink"
          style={{ left: ghost.x + 12, top: ghost.y + 12 }}
        >
          {ghost.title}
        </div>
      ) : null}
      {/* z-20: #world is z-1 (above the breathing ground), so the HUD must sit
          above it or tiles paint over and take clicks from the ladder and dock. */}
      <div className="pointer-events-none absolute inset-0 z-20">
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
          {crumbSpace ? (
            <>
              <span aria-hidden="true">›</span>
              <button
                type="button"
                className="px-2 py-1 hover:text-ink"
                onClick={() => {
                  if (framedRegionId !== undefined) setSpaceFocus(framedRegionId)
                  leaveTo('space')
                }}
              >
                {crumbSpace}
              </button>
            </>
          ) : null}
          {crumbThread ? (
            <>
              <span aria-hidden="true">›</span>
              <button
                type="button"
                className="truncate px-2 py-1 text-ink hover:text-ink"
                onClick={() => beginThread(crumbThread.key)}
              >
                {crumbThread.title}
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
        <button
          type="button"
          data-hud=""
          data-dock-toggle=""
          aria-expanded={dockOpen}
          aria-label={dockOpen ? 'Hide shortcuts' : 'Show shortcuts'}
          title={dockOpen ? 'Hide shortcuts' : 'Show shortcuts'}
          className={`pointer-events-auto absolute right-2 bottom-2 flex items-center gap-1 border border-line bg-panel p-1.5 hover:bg-em/15 ${
            dockOpen ? 'text-em' : 'text-ink-dim hover:text-ink'
          }`}
          onClick={() => setDockOpen((open) => !open)}
        >
          <Keyboard aria-hidden="true" className="size-4" />
          {!dockOpen && needsCount > 0 ? (
            <span data-dock-needs="" className="text-xs text-warn">
              {needsCount}
            </span>
          ) : null}
        </button>
        {dockOpen || findOpen || moveOpen ? (
          <div
            data-hud=""
            data-dock-bar=""
            className="pointer-events-auto absolute right-2 bottom-11 flex max-h-[calc(100%-4rem)] flex-col items-stretch gap-0.5 overflow-y-auto border border-line bg-panel p-1 [&>button]:text-left"
          >
            <button
              type="button"
              data-dock="history"
              aria-pressed={historyWanted}
              className={`px-3 py-2 text-sm hover:bg-em/15 ${historyWanted ? 'text-em' : 'text-ink'}`}
              onClick={() => {
                if (pick) return
                setHistoryWanted((open) => !open)
              }}
            >
              History <kbd className="text-ink-dim">H</kbd>
            </button>
            <button
              type="button"
              data-dock="needs"
              className="px-3 py-2 text-sm text-ink hover:bg-em/15"
              onClick={() => {
                const id = nextWaitingId(waiting, openId, altitude === 'thread')
                if (id !== undefined) beginThread(id)
              }}
            >
              Needs you{' '}
              <span className={needsCount > 0 ? 'text-warn' : 'text-ink-dim'}>{needsCount}</span>
            </button>
            <button
              type="button"
              data-dock="recent"
              className="px-3 py-2 text-sm text-ink hover:bg-em/15 disabled:opacity-40"
              disabled={mru.length < 2}
              onClick={() => {
                // Previous thread — the way to step back at Thread, where Ctrl+` is
                // left to the terminal. mru[1], not the wrapping preview helper.
                const id = mru[1]
                if (id !== undefined) beginThread(id)
              }}
            >
              Recent
            </button>
            <button
              type="button"
              data-dock="thread"
              className="px-3 py-2 text-sm text-ink hover:bg-em/15"
              title={dockStartsIn}
              onClick={() => setNewThread({ spaceId: spaceYouAreIn() })}
            >
              + Thread <kbd className="text-ink-dim">T</kbd>
            </button>
            {moveOpen && selectedPlaced ? (
              <Popover
                open
                onOpenChange={(open) => {
                  if (!open) setMoveOpen(false)
                }}
              >
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    data-dock="move"
                    className="px-3 py-2 text-sm text-em hover:bg-em/15"
                  >
                    Move <kbd className="text-ink-dim">M</kbd>
                  </button>
                </PopoverTrigger>
                <PopoverContent align="center" className="w-56 p-1 font-mono">
                  <div className="px-3 py-2 text-xs text-ink-dim">Move to…</div>
                  {spaces.map((space) => (
                    <button
                      key={space.id}
                      type="button"
                      className="block w-full px-3 py-1.5 text-left text-sm text-ink hover:bg-em/15"
                      onClick={() => {
                        useSpaces
                          .getState()
                          .place(
                            rowMembershipKey(baseUrl, selectedPlaced.row, membership),
                            space.id,
                          )
                        setMoveOpen(false)
                      }}
                    >
                      {space.name}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="block w-full px-3 py-1.5 text-left text-sm text-ink hover:bg-em/15"
                    onClick={() => {
                      useSpaces
                        .getState()
                        .unplace(rowMembershipKey(baseUrl, selectedPlaced.row, membership))
                      setMoveOpen(false)
                    }}
                  >
                    History
                  </button>
                </PopoverContent>
              </Popover>
            ) : (
              <button
                type="button"
                data-dock="move"
                className="px-3 py-2 text-sm text-ink hover:bg-em/15"
                onClick={() => {
                  if (selectedPlaced) setMoveOpen(true)
                }}
              >
                Move <kbd className="text-ink-dim">M</kbd>
              </button>
            )}
            {findOpen ? (
              <input
                ref={findInputRef}
                data-dock="find"
                aria-label="Find an agent"
                placeholder="Agent, thread or space"
                value={findQuery}
                onChange={(event) => setFindQuery(event.target.value)}
                className="w-56 border border-line bg-bg px-2 py-1.5 text-sm text-ink outline-none placeholder:text-ink-dim"
              />
            ) : null}
            <button
              type="button"
              className="px-3 py-2 text-sm text-ink hover:bg-em/15"
              onClick={() => {
                const effect = reduceCanvasCommand(
                  { altitude, selectedId },
                  { chord: 'zoom-toggle' },
                  tilesRef.current,
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
            <button
              type="button"
              data-dock="keys"
              aria-pressed={keysOpen}
              aria-label="Keys"
              className={`px-3 py-2 text-sm hover:bg-em/15 ${keysOpen ? 'text-em' : 'text-ink'}`}
              onClick={() => setKeysOpen((open) => !open)}
            >
              ? <kbd className="text-ink-dim">Keys</kbd>
            </button>
          </div>
        ) : null}
        {rosterNotice ? (
          <p
            role="status"
            data-roster-notice=""
            className="absolute top-16 left-1/2 z-40 max-w-md -translate-x-1/2 border border-line bg-panel px-3 py-2 text-center font-mono text-sm text-ink-dim"
          >
            {rosterNotice}
          </p>
        ) : null}
        <div
          aria-live="polite"
          data-needs-toasts=""
          className="pointer-events-none absolute top-16 left-1/2 z-40 flex -translate-x-1/2 flex-col gap-1"
        >
          {toasts.map((toast) => (
            <button
              key={toast.id}
              type="button"
              className="sc-toast pointer-events-auto border border-warn bg-panel px-3 py-2 text-left text-sm text-ink"
              onClick={() => {
                setToasts((prev) => prev.filter((item) => item.id !== toast.id))
                beginThread(toast.rowKey)
              }}
            >
              {toast.title} needs you
            </button>
          ))}
        </div>
        {mruStep > 0 ? (
          <div
            data-mru=""
            className="pointer-events-none absolute top-16 right-4 flex max-w-sm gap-1 border border-line bg-panel p-1 text-xs"
          >
            {mruShown.map((id) => (
              <span
                key={id}
                className={
                  id === previewId
                    ? 'max-w-32 truncate bg-em/15 px-2 py-1 text-em'
                    : 'max-w-32 truncate px-2 py-1 text-ink-dim'
                }
              >
                {rows.find((row) => row.key === id)?.title ?? id}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      {namePrompt ? (
        <NameDialog
          title="New space"
          initial=""
          confirm="Create"
          onCancel={() => setNamePrompt(null)}
          onSubmit={(name) => {
            const id = useSpaces.getState().addSpace(name)
            setNamePrompt(null)
            if (!id) return
            setSpaceFocus(id)
            leaveTo('space')
          }}
        />
      ) : null}
      {keysOpen ? (
        <Dialog.Root
          open
          onOpenChange={(open) => {
            if (!open) setKeysOpen(false)
          }}
        >
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-50 bg-bg/70" />
            <Dialog.Content
              id="keys"
              data-keys-panel=""
              className="fixed top-1/2 left-1/2 z-50 max-h-[calc(100%-2rem)] w-[40rem] max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto border border-line bg-panel p-4 font-mono shadow-lg outline-none"
            >
              <Dialog.Title className="mb-1 text-sm text-ink">Keys</Dialog.Title>
              <Dialog.Description className="mb-3 text-xs text-ink-dim">
                Thread altitude leaves most of these to the session. The dock buttons still work.
              </Dialog.Description>
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="text-ink-dim">
                    <th className="py-1 pr-3 font-medium">Key</th>
                    <th className="py-1 pr-3 font-medium">Does</th>
                    <th className="py-1 font-medium">At Thread</th>
                  </tr>
                </thead>
                <tbody>
                  {CANVAS_KEYS.map((entry) => (
                    <tr key={entry.id} data-key-row={entry.id} className="align-top text-ink">
                      <td className="py-1 pr-3 whitespace-nowrap text-em">
                        {label(entry.id) || 'unbound'}
                      </td>
                      <td className="py-1 pr-3 text-ink-dim">{entry.summary}</td>
                      <td className="py-1 text-ink-dim">{entry.thread}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      ) : null}
      {removePrompt && removeSpace ? (
        <RemoveDialog
          message={removeSpaceMessage(
            removeSpace.name,
            removeRows.length,
            removeRows.filter((row) => isLive(row, blockedIds)).length,
          )}
          onCancel={() => setRemovePrompt(null)}
          onConfirm={() => {
            const id = removePrompt
            const leaving = altitude === 'space' && framedRegionId === id
            useSpaces.getState().removeSpace(id)
            setRemovePrompt(null)
            if (spaceFocus === id) setSpaceFocus(undefined)
            if (leaving) leaveTo('everything')
          }}
        />
      ) : null}
      {newThread ? (
        <NewThreadDialog
          spaceId={newThread.spaceId}
          spaces={spaces.map((space) => ({
            id: space.id,
            name: space.name,
            defaults: space.defaults,
          }))}
          descriptors={descriptors}
          onClose={() => setNewThread(null)}
          onStarted={(id) => {
            setNewThread(null)
            beginThread(id)
          }}
          onPickHistory={(spaceId) => {
            const name = spaces.find((space) => space.id === spaceId)?.name ?? 'space'
            setNewThread(null)
            setPick({ spaceId, title: `Add to ${name}` })
          }}
        />
      ) : null}
      {editing ? (
        <SpaceDefaultsDialog
          space={editing}
          descriptors={descriptors}
          onClose={() => setEditSpace(null)}
        />
      ) : null}
    </div>
  )
}

function regionName(regions: { id: string; name: string }[], id: string): string | undefined {
  return regions.find((region) => region.id === id)?.name
}

function NameDialog(props: {
  title: string
  initial: string
  confirm: string
  onCancel: () => void
  onSubmit: (name: string) => void
}): JSX.Element {
  const [value, setValue] = useState(props.initial)
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) props.onCancel()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-bg/70" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 w-80 max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 border border-line bg-panel p-4 font-mono shadow-lg outline-none">
          <Dialog.Title className="mb-3 text-sm text-ink">{props.title}</Dialog.Title>
          <Dialog.Description className="sr-only">{props.title}</Dialog.Description>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              const name = value.trim()
              if (!name) return
              props.onSubmit(name)
            }}
          >
            <input
              autoFocus
              aria-label="Space name"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="Space name"
              className="mb-3 w-full border border-line bg-bg px-2 py-1.5 text-sm text-ink outline-none"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={props.onCancel}
                className="border border-line px-3 py-1.5 text-xs text-ink-dim hover:text-ink"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!value.trim()}
                className="bg-em-dim px-3 py-1.5 text-xs font-medium text-bg hover:bg-em disabled:opacity-40"
              >
                {props.confirm}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function RemoveDialog(props: {
  message: string
  onCancel: () => void
  onConfirm: () => void
}): JSX.Element {
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) props.onCancel()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-bg/70" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 w-96 max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 border border-line bg-panel p-4 font-mono shadow-lg outline-none">
          <Dialog.Title className="mb-3 text-sm text-ink">Remove space</Dialog.Title>
          <Dialog.Description className="mb-4 text-sm text-ink-dim">
            {props.message}
          </Dialog.Description>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={props.onCancel}
              className="border border-line px-3 py-1.5 text-xs text-ink-dim hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={props.onConfirm}
              className="border border-red/40 px-3 py-1.5 text-xs text-red hover:border-red"
            >
              Remove
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
