// WindowManager: the multi-window session grid. Owns one RoomInstance per
// session (first-seen order) plus the focus model — the focused window wears
// the focus ring and drives the editor + push-to-talk preview (main.ts wires
// that through onFocusChange). Also owns the screen layout: best-fit grid on
// desktop, single camera-followed window + tab strip on mobile, and the
// DomAnchor mechanism that pins fixed-position DOM elements to frame-local
// points (mobile pan re-syncs them every frame; C4's drawer anchors here).

import type { Container } from 'pixi.js'
import { anchorCss, cellPos, computeGrid } from './grid.js'
import { MARGIN, type RoomInstance } from './room.js'

const TOP_STACK = 10 // breathing room above the grid
// bottom reserve (PTT pill strip) — also keeps the n=1 letterbox identical
// to the pre-grid layout, which reserved this space for the DOM caption
const UI_STACK = 48 + 26 + 8
const TAB_STRIP_H = 36 // mobile tab strip reserve, in ui-scaled px

/** A fixed-position DOM element pinned to a point in a window's frame-local
 *  coordinate space. syncDom() re-derives its CSS rect from the room root's
 *  transform on every relayout (and every mobile camera pan). */
export interface DomAnchor {
  el: HTMLElement
  room: RoomInstance
  x?: number
  y?: number
  w?: number
  h?: number
  /** When present, re-evaluated on every syncDom in place of x/y/w/h — for
   *  rects that depend on mutable room state (furniture placements). */
  rect?(): { x: number; y: number; w?: number; h?: number }
}

export interface WindowManagerDeps {
  stage: Container
  frameW: number
  frameH: number
  /** Build a den window for a session — windows.ts stays asset-agnostic. */
  makeRoom(id: string): RoomInstance
  /** Display name for the mobile tab strip. */
  getName(id: string): string
  /** Focus moved. Fired after the ring/visibility update — and, when the
   *  focused window is being closed, BEFORE its room is destroyed, so the
   *  editor can detach from a still-live world. */
  onFocusChange(id: string | null): void
  /** Local windows (idle placeholder, demo) survive snapshot reconcile. */
  isLocal(id: string): boolean
  tabStrip: HTMLElement
}

export interface WindowManager {
  /** Create the window (added to the stage + relayout) if missing. */
  ensure(id: string): RoomInstance
  get(id: string): RoomInstance | undefined
  has(id: string): boolean
  /** Session ids in first-seen (grid) order. */
  ids(): string[]
  /** Destroy a window + relayout; focus moves to the next remaining one. */
  remove(id: string): void
  /** Destroy every non-local window not in `live` (snapshot reconcile). */
  reconcile(live: Set<string>): void
  focusedId(): string | null
  focus(id: string): void
  isMobile(): boolean
  layout(): void
  /** One ticker step: update all visible rooms + the mobile camera. */
  update(dtMS: number): void
  addAnchor(a: DomAnchor): () => void
  syncDom(): void
}

export function createWindowManager(deps: WindowManagerDeps): WindowManager {
  const { frameW, frameH, tabStrip } = deps
  const windows = new Map<string, RoomInstance>() // insertion = first-seen order
  let focused: string | null = null
  let mobileMode = false
  let camS = 1 // mobile camera scale (window fills avail height, pans in x)
  const anchors = new Set<DomAnchor>()

  const clampCamX = (x: number) => Math.min(0, Math.max(window.innerWidth - frameW * camS, x))

  function syncDom() {
    for (const a of anchors) {
      const root = a.room.root
      if (root.destroyed || !root.visible) {
        a.el.style.display = 'none'
        continue
      }
      const p = a.rect?.() ?? { x: a.x ?? 0, y: a.y ?? 0, w: a.w, h: a.h }
      const r = anchorCss(root.position.x, root.position.y, root.scale.x, p)
      a.el.style.display = ''
      a.el.style.left = `${r.left}px`
      a.el.style.top = `${r.top}px`
      if (r.width !== undefined) a.el.style.width = `${r.width}px`
      if (r.height !== undefined) a.el.style.height = `${r.height}px`
    }
  }

  function renderTabs(on: boolean) {
    if (!on) {
      tabStrip.replaceChildren()
      return
    }
    tabStrip.replaceChildren(
      ...[...windows.keys()].map((id) => {
        const b = document.createElement('button')
        b.textContent = deps.getName(id)
        if (id === focused) b.classList.add('sel')
        b.onclick = () => focus(id)
        return b
      }),
    )
  }

  function layout() {
    const winW = window.innerWidth
    const winH = window.innerHeight
    const ui = Math.max(0.6, Math.min(1.25, Math.min(winW, winH) / 760))
    document.documentElement.style.setProperty('--ui', String(ui))
    // mobile = one window at avail height would overflow the width (same
    // aspect test as the pre-grid single-window layout)
    const availH0 = Math.max(160, winH - TOP_STACK * ui - UI_STACK * ui)
    mobileMode = winW / availH0 < frameW / frameH
    const tabsOn = mobileMode && windows.size > 1
    tabStrip.classList.toggle('show', tabsOn)
    const top = TOP_STACK * ui + (tabsOn ? TAB_STRIP_H * ui : 0)
    const availH = Math.max(160, winH - top - UI_STACK * ui)
    if (mobileMode) {
      // one visible window (the focused one), camera-following the character
      camS = availH / frameH
      for (const [id, room] of windows) {
        room.root.visible = id === focused
        if (id !== focused) continue
        room.root.scale.set(camS)
        room.root.position.set(clampCamX(winW / 2 - camS * (MARGIN + room.charX())), top)
      }
    } else {
      const pad = 12 * ui
      const gap = 12 * ui
      const availW = winW - pad * 2
      const g = computeGrid(Math.max(1, windows.size), availW, availH, frameW, frameH, gap)
      let i = 0
      for (const room of windows.values()) {
        room.root.visible = true
        const p = cellPos(i++, windows.size, g, pad, top, availW, availH, frameW, frameH, gap)
        room.root.scale.set(g.s)
        room.root.position.set(p.x, p.y)
      }
    }
    renderTabs(tabsOn)
    syncDom()
  }
  window.addEventListener('resize', layout)

  function focus(id: string) {
    if (id === focused || !windows.has(id)) return
    const prev = focused
    focused = id
    if (prev) windows.get(prev)?.setFocused(false)
    windows.get(id)!.setFocused(true)
    layout() // mobile flips visibility; desktop just refreshes (cheap)
    deps.onFocusChange(id)
  }

  function ensure(id: string): RoomInstance {
    const existing = windows.get(id)
    if (existing) return existing
    const room = deps.makeRoom(id)
    room.root.eventMode = 'static'
    room.root.on('pointerdown', () => focus(id))
    windows.set(id, room)
    deps.stage.addChild(room.root)
    layout()
    if (!focused) focus(id) // default focus = first window
    return room
  }

  function remove(id: string) {
    const room = windows.get(id)
    if (!room) return
    if (focused === id) {
      // refocus BEFORE destroying: onFocusChange lets the editor detach from
      // the dying room's world while it is still alive
      const next = [...windows.keys()].find((k) => k !== id) ?? null
      focused = null
      if (next) focus(next)
      else deps.onFocusChange(null)
    }
    windows.delete(id)
    room.destroy()
    layout()
  }

  return {
    ensure,
    get: (id) => windows.get(id),
    has: (id) => windows.has(id),
    ids: () => [...windows.keys()],
    remove,
    reconcile(live) {
      for (const id of [...windows.keys()]) {
        if (!deps.isLocal(id) && !live.has(id)) remove(id)
      }
    },
    focusedId: () => focused,
    focus,
    isMobile: () => mobileMode,
    layout,
    update(dtMS) {
      for (const room of windows.values()) {
        if (room.root.visible) room.update(dtMS)
      }
      if (!mobileMode || !focused) return
      const room = windows.get(focused)
      if (!room) return
      const want = clampCamX(window.innerWidth / 2 - camS * (MARGIN + room.charX()))
      room.root.position.x += (want - room.root.position.x) * Math.min(1, dtMS / 350)
      syncDom()
    },
    addAnchor(a) {
      anchors.add(a)
      syncDom()
      return () => anchors.delete(a)
    },
    syncDom,
  }
}
