// Edit mode: select/drag/resize furniture, swap pack art variants, persist.
// The room is pack data; this is the tool that lets you sculpt your copy.
// Layouts persist to den-server (/layout) — the server copy is canonical and
// shared across browsers; localStorage is just the local cache.

import { Container, FederatedPointerEvent, Graphics, Sprite } from 'pixi.js'
import type { Station } from '@rivetos/den-packs'
import { serverHttp, withToken } from './net.js'

/** Runtime placement — pack layout plus the active art choice. */
export interface RuntimePlacement {
  id: string
  src: string
  x: number
  y: number
  h: number
  flip?: boolean
}

export interface EditorHooks {
  world: Container
  items: Record<string, { sprite: Sprite; placement: RuntimePlacement }>
  stations: Record<string, Station>
  stationPos: (s: Station) => { x: number; y: number }
  /** Art variants per furniture id (pack-relative URLs already resolved). */
  variants: Record<string, string[]>
  previewActivity: (activity: string) => void
  onEditingChange: (on: boolean) => void
  swapItemArt: (id: string, src: string) => Promise<void>
  applyScale: (id: string) => void
  onLayoutChange: () => void
}

export interface SavedLayout {
  placements: Record<string, { x: number; y: number; h: number; src?: string; flip?: boolean }>
  stations?: Record<string, { dx?: number; dy?: number; x?: number; y?: number }>
}

// draggable animation spots exposed in EDIT mode (chip label -> activity)
const STATION_CHIPS: Record<string, string> = {
  'phone-spot': 'searching_web',
  'sleep-spot': 'sleeping',
  'dig-spot': 'running_command',
}

// Layouts are keyed per pack — coordinates only make sense against one shell.
// The den-server copy is the ONLY source of truth: every browser pointed at
// this node sees the same room. No layout (or no server) = pack defaults.
let packKey = 'default'
export function setLayoutPack(pack: string): void {
  packKey = pack.replace(/[^\w.-]/g, '_')
}
const layoutUrl = () => `${serverHttp}/layout?viewer=default.${packKey}`

export function pushLayout(layout: SavedLayout): void {
  fetch(withToken(layoutUrl()), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(layout, null, 2),
  }).catch(() => {
    /* server down — edit is lost on reload, room falls back to pack defaults */
  })
}

export async function loadLayout(): Promise<SavedLayout | null> {
  try {
    const r = await fetch(withToken(layoutUrl()))
    return r.ok ? ((await r.json()) as SavedLayout) : null
  } catch {
    return null
  }
}

export interface EditorDom {
  btn: HTMLElement
  panel: HTMLElement
  chips: HTMLElement
  thumbs: HTMLElement
}

export interface Editor {
  /** Point the editor at a room's live objects (world, sprites, stations). */
  setTarget(hooks: EditorHooks, initial: SavedLayout | null): void
  /** Unhook from the current target (per-sprite + world listeners). */
  detach(): void
  /** True while EDIT mode is on. */
  isActive(): boolean
  /** Toggle EDIT mode programmatically (same path as the EDIT button) —
   *  focus changes exit edit BEFORE re-targeting, never mid-edit. */
  setEditing(on: boolean): void
}

export function createEditor(dom: EditorDom): Editor {
  let hooks: EditorHooks | null = null
  let saved: SavedLayout = { placements: {} }

  let editing = false
  let selected: string | null = null // furniture id or a station chip
  let highlight: Graphics | null = null

  function persist(): void {
    if (!hooks) return
    for (const [id, it] of Object.entries(hooks.items)) {
      saved.placements[id] = {
        ...saved.placements[id],
        x: it.placement.x,
        y: it.placement.y,
        h: it.placement.h,
        flip: it.placement.flip,
      }
    }
    pushLayout(saved)
    hooks.onLayoutChange()
  }

  const selectedStation = (): string | null => (selected && STATION_CHIPS[selected]) || null

  function drawHighlight(): void {
    if (!hooks || !highlight) return
    highlight.clear()
    const act = selectedStation()
    if (editing && act && hooks.stations[act]) {
      // station marker: crosshair ring where the robot's feet will go
      const p = hooks.stationPos(hooks.stations[act])
      highlight.visible = true
      highlight.position.set(0, 0)
      highlight.scale.set(1, 1)
      highlight.circle(p.x, p.y, 16).stroke({ width: 3, color: 0xd6a53c })
      highlight
        .moveTo(p.x - 26, p.y)
        .lineTo(p.x + 26, p.y)
        .stroke({ width: 2, color: 0xd6a53c })
      highlight
        .moveTo(p.x, p.y - 26)
        .lineTo(p.x, p.y + 26)
        .stroke({ width: 2, color: 0xd6a53c })
      return
    }
    if (!editing || !selected || !hooks.items[selected]) {
      highlight.visible = false
      return
    }
    const sp = hooks.items[selected].sprite
    const b = sp.getLocalBounds()
    highlight.visible = true
    highlight.position.set(sp.x, sp.y)
    highlight.scale.set(sp.scale.x, sp.scale.y)
    highlight
      .rect(b.x, b.y, b.width, b.height)
      .stroke({ width: 3 / Math.abs(sp.scale.x || 1), color: 0x34d399 })
  }

  function renderThumbs(): void {
    dom.thumbs.innerHTML = ''
    ;(hooks && selected ? (hooks.variants[selected] ?? []) : []).forEach((src) => {
      const img = document.createElement('img')
      img.src = src
      img.onclick = async () => {
        if (!hooks || !selected || !hooks.items[selected]) return
        // new art always lands un-mirrored, exactly as the thumbnail shows
        hooks.items[selected].placement.flip = false
        saved.placements[selected] = { ...saved.placements[selected], src, flip: false }
        await hooks.swapItemArt(selected, src)
        persist()
        ;[...dom.thumbs.children].forEach((c) => c.classList.remove('sel'))
        img.classList.add('sel')
        drawHighlight()
      }
      dom.thumbs.appendChild(img)
    })
  }

  function renderChips(): void {
    if (!hooks) return
    dom.chips.innerHTML = ''
    const ids = [...Object.keys(hooks.items), ...Object.keys(STATION_CHIPS)]
    ids.forEach((id) => {
      const b = document.createElement('button')
      b.textContent = id
      if (id === selected) b.classList.add('sel')
      b.onclick = () => {
        selected = id
        renderChips()
        renderThumbs()
        drawHighlight()
        // selecting a spot sends the robot there so you can see the pose live
        const act = STATION_CHIPS[id]
        if (act) hooks?.previewActivity(act)
      }
      dom.chips.appendChild(b)
    })
    const flip = document.createElement('button')
    flip.textContent = 'FLIP'
    flip.onclick = () => {
      if (!hooks || !selected || !hooks.items[selected]) return
      const it = hooks.items[selected]
      it.placement.flip = !it.placement.flip
      hooks.applyScale(selected)
      persist()
      drawHighlight()
    }
    dom.chips.appendChild(flip)
    const exp = document.createElement('button')
    exp.textContent = 'EXPORT'
    exp.style.float = 'right'
    exp.onclick = () => {
      const blob = new Blob([JSON.stringify(saved, null, 2)], { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = 'layout.json'
      a.click()
    }
    dom.chips.appendChild(exp)
  }

  // ---- drag + resize ----
  let dragId: string | null = null
  let dragStation: string | null = null // activity being repositioned
  let dragOff = { x: 0, y: 0 }

  function moveStation(act: string, px: number, py: number): void {
    if (!hooks) return
    const s = hooks.stations[act]
    if (s.furn && hooks.items[s.furn]) {
      const a = hooks.items[s.furn].placement
      s.dx = Math.round(px - a.x)
      s.dy = Math.round(py - a.y)
      saved.stations = { ...saved.stations, [act]: { dx: s.dx, dy: s.dy } }
    } else {
      s.x = Math.round(px)
      s.y = Math.round(py)
      saved.stations = { ...saved.stations, [act]: { x: s.x, y: s.y } }
    }
  }

  // handler fn refs are stored so detach() can unhook them without leaks
  const spriteHandlers: { sprite: Sprite; fn: (e: FederatedPointerEvent) => void }[] = []
  const onWorldDown = (e: FederatedPointerEvent): void => {
    if (!hooks) return
    // with a spot chip selected, grabbing anywhere repositions that spot
    const act = selectedStation()
    if (!editing || !act) return
    dragStation = act
    const p = hooks.world.toLocal(e.global)
    moveStation(act, p.x, p.y)
    drawHighlight()
  }
  const onWorldMove = (e: FederatedPointerEvent): void => {
    if (!hooks || !editing) return
    if (dragStation) {
      const p = hooks.world.toLocal(e.global)
      moveStation(dragStation, p.x, p.y)
      drawHighlight()
      return
    }
    if (!dragId) return
    const it = hooks.items[dragId]
    const p = hooks.world.toLocal(e.global)
    it.placement.x = Math.round(p.x - dragOff.x)
    it.placement.y = Math.round(p.y - dragOff.y)
    it.sprite.position.set(it.placement.x, it.placement.y)
    hooks.applyScale(dragId) // keeps zIndex in sync with y
    drawHighlight()
  }
  const endDrag = (): void => {
    if (dragId || dragStation) {
      dragId = null
      dragStation = null
      persist()
    }
  }

  // window-level listeners: registered ONCE, gated on the current target
  window.addEventListener(
    'wheel',
    (e) => {
      if (!hooks || !editing || !selected || !hooks.items[selected]) return
      const it = hooks.items[selected]
      it.placement.h = Math.max(24, Math.round(it.placement.h * (e.deltaY < 0 ? 1.05 : 0.95)))
      hooks.applyScale(selected)
      persist()
      drawHighlight()
    },
    { passive: true },
  )

  function setEditing(on: boolean): void {
    if (!hooks || editing === on) return
    editing = on
    dom.btn.classList.toggle('on', editing)
    dom.panel.classList.toggle('on', editing)
    if (!editing) {
      selected = null
      dragId = null
      dragStation = null
    }
    drawHighlight()
    if (editing) {
      renderChips()
      renderThumbs()
    }
    hooks.onEditingChange(editing)
  }

  dom.btn.addEventListener('click', () => setEditing(!editing))

  function setTarget(next: EditorHooks, initial: SavedLayout | null): void {
    detach()
    hooks = next
    saved = initial ?? { placements: {} }
    highlight = new Graphics()
    highlight.visible = false
    highlight.zIndex = 9500
    next.world.addChild(highlight)
    for (const [id, it] of Object.entries(next.items)) {
      it.sprite.eventMode = 'static'
      const fn = (e: FederatedPointerEvent): void => {
        if (!editing) return
        selected = id
        dragId = id
        const p = next.world.toLocal(e.global)
        dragOff = { x: p.x - it.placement.x, y: p.y - it.placement.y }
        renderChips()
        renderThumbs()
        drawHighlight()
      }
      it.sprite.on('pointerdown', fn)
      spriteHandlers.push({ sprite: it.sprite, fn })
    }
    next.world.eventMode = 'static'
    next.world.on('pointerdown', onWorldDown)
    next.world.on('globalpointermove', onWorldMove)
    next.world.on('pointerup', endDrag)
    next.world.on('pointerupoutside', endDrag)
  }

  function detach(): void {
    if (!hooks) return
    for (const { sprite, fn } of spriteHandlers) sprite.off('pointerdown', fn)
    spriteHandlers.length = 0
    hooks.world.off('pointerdown', onWorldDown)
    hooks.world.off('globalpointermove', onWorldMove)
    hooks.world.off('pointerup', endDrag)
    hooks.world.off('pointerupoutside', endDrag)
    highlight?.destroy()
    highlight = null
    selected = null
    dragId = null
    dragStation = null
    hooks = null
  }

  return { setTarget, detach, isActive: () => editing, setEditing }
}
