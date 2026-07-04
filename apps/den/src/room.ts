// One den window: everything that draws or animates a single room — window
// frame + chrome (title, subtitle, LED, per-window ✕, `>_` terminal toggle,
// focus ring), furniture, character + poses, bubbles, whiteboard/terminal
// overlays, sleep Z's. Created per session by the WindowManager (windows.ts).
// Rooms share the canonical LayoutModel and the pack's KeyedAssets/pose
// frames; each instance owns its sprites, its render clones of the
// placements, and all per-room animation state. (The old in-room chat panel
// is gone — narration lives in the speech bubble, whiteboard and titlebar
// subtitle; the terminal drawer (drawer.ts) took the chat panel's job.)

import { Container, Graphics, Sprite, Text, TextStyle } from 'pixi.js'
import {
  initialRoomState,
  type Activity,
  type AgentEvent,
  type RoomState,
} from '@rivetos/den-protocol'
import type { Station } from '@rivetos/den-packs'
import { loadAsset, pixelTexture, PX, type KeyedAsset, type PixelFrame } from './assets.js'
import { resolvePose, type LoadedPack } from './pack.js'
import type { FontMap } from './fonts.js'
import type { EditorHooks, RuntimePlacement } from './editor.js'
import type { LayoutModel } from './layout-model.js'

export const MARGIN = 26
export const TITLEBAR = 48

// exported for the mesh overview (mesh.ts): cards speak the same
// activity→label / activity→LED-color language as the window chrome
export const ACTIVITY_LABEL: Record<Activity, string> = {
  idle: 'idle — puttering around the den',
  thinking: 'thinking…',
  writing_plan: 'writing the plan on the whiteboard',
  searching_web: 'searching the web',
  editing_code: 'editing code',
  running_command: 'digging for the right tool',
  listening: 'listening…',
  speaking: 'speaking',
  sleeping: 'sleeping — compacting memories',
}

export const LED_COLOR: Record<Activity, number> = {
  idle: 0x5a6675,
  thinking: 0xd6a53c,
  writing_plan: 0x34d399,
  searching_web: 0x34d399,
  editing_code: 0x34d399,
  running_command: 0x34d399,
  listening: 0x3b82f6,
  speaking: 0x34d399,
  sleeping: 0x8b5cf6,
}

function bubble(maxWidth: number, color: number, fontFamily: string) {
  const g = new Graphics()
  const style = new TextStyle({
    fontFamily,
    fontSize: 16,
    fill: 0x22303f,
    wordWrap: true,
    wordWrapWidth: maxWidth - 20,
    lineHeight: 18,
  })
  const txt = new Text({ text: '', style, resolution: 2 })
  txt.position.set(10, 8)
  const c = new Container()
  c.addChild(g, txt)
  c.visible = false
  return {
    container: c,
    set(text: string) {
      txt.text = text
      const w = Math.min(maxWidth, txt.width + 20),
        h = txt.height + 16
      g.clear()
        .roundRect(0, 0, w, h, 10)
        .fill({ color: 0xffffff, alpha: 0.96 })
        .roundRect(0, 0, w, h, 10)
        .stroke({ width: 2, color })
        .circle(w / 2 - 30, h + 8, 5)
        .fill({ color: 0xffffff, alpha: 0.96 })
        .circle(w / 2 - 38, h + 17, 3)
        .fill({ color: 0xffffff, alpha: 0.96 })
      c.pivot.set(w / 2, h)
    },
  }
}

/** Editor hooks a room can supply by itself — main.ts merges in the
 *  app-level callbacks (previewActivity, onEditingChange, onLayoutChange). */
export type RoomEditorHooks = Omit<
  EditorHooks,
  'previewActivity' | 'onEditingChange' | 'onLayoutChange'
>

/** Terminal chrome hooks — present only while the session has a den-server
 *  PTY linked to it (the `pty` decoration). The room draws the `>_` toggle
 *  and upgrades ✕ to a two-click terminate; the drawer itself lives outside
 *  the Pixi scene (drawer.ts) and is the owner's concern. */
export interface RoomTermHooks {
  /** `>_` clicked — open/collapse the drawer. */
  onToggle(): void
  /** Armed ✕ confirmed (second click within 3s) — terminate the PTY. */
  onKill(): void
}

export interface RoomDeps {
  id: string
  pack: LoadedPack
  fonts: FontMap
  /** Canonical layout shared by all rooms — this room subscribes to it. */
  layout: LayoutModel
  /** Shared keyed shell art (not chroma-keyed). */
  shell: KeyedAsset
  /** Shared KeyedAssets for the layout's placements, keyed by furniture id. */
  furnitureAssets: Record<string, KeyedAsset>
  /** Side-view chair art for the swivel, when the pack ships one. */
  chairSideAsset: KeyedAsset | null
  /** Shared pose frame sets, pre-rasterized by main.ts. */
  poses: Record<string, PixelFrame[]>
  poseImgSize: Record<string, { w: number; h: number }>
  /** Close (✕) handler — when absent (local windows) no ✕ is rendered. */
  onClose?: () => void
}

export interface RoomInstance {
  id: string
  /** The window-frame container — main.ts adds it to the stage + scales it. */
  root: Container
  frameW: number
  frameH: number
  /** Point the room at a (new) RoomState and re-render everything from it. */
  setState(s: RoomState): void
  /** Title-bar text: 'rivet-den · <name>' (grayed out when ended). */
  setTitle(name: string, ended: boolean): void
  /** Focus ring on/off — a slightly brighter chrome outer stroke. */
  setFocused(on: boolean): void
  /** Per-event side effects (speech bubble trigger) — call AFTER setState. */
  onEvent(ev: AgentEvent): void
  /** Show (hooks) or remove (null) the terminal chrome: the `>_` toggle and
   *  the armed-✕ terminate behavior. Idempotent; safe to call on updates. */
  setTerm(hooks: RoomTermHooks | null): void
  /** Reflect the drawer's open state on the `>_` toggle. */
  setTermOpen(open: boolean): void
  /** One ticker step. */
  update(dtMS: number): void
  applyTimeOfDay(): Promise<void>
  /** Character x in room coordinates — for the mobile camera-follow. */
  charX(): number
  /** Live refs the editor needs to sculpt this room. */
  editorHooks(): RoomEditorHooks
  destroy(): void
}

export function createRoom(deps: RoomDeps): RoomInstance {
  const { pack, fonts, layout, poses, poseImgSize, chairSideAsset } = deps
  const m = pack.manifest
  const SHELL = { w: m.shell.w, h: m.shell.h }
  const FRAME_W = SHELL.w + MARGIN * 2
  const FRAME_H = SHELL.h + MARGIN * 2 + TITLEBAR
  const CHAR_HEIGHT = m.character.height
  const stations = layout.stations

  const poseHeight = (name: string): number => m.character.poses[name]?.height ?? CHAR_HEIGHT
  let poseStartT = 0 // set on pose change; drives intro (play-once) frames
  function poseFrame(name: string, t: number): number {
    const frames = poses[name] ?? poses.idle
    if (frames.length < 2) return 0
    const spec = m.character.poses[name]
    const frameMs = spec?.frameMs ?? 400
    if (frameMs === 0) return t % 3400 < 160 ? 1 : 0 // static pose: occasional blink
    const intro = spec?.intro ?? 0
    if (intro > 0) {
      const el = t - poseStartT
      if (el < intro * frameMs) return Math.floor(el / frameMs)
      return intro + (Math.floor((el - intro * frameMs) / frameMs) % (frames.length - intro))
    }
    return Math.floor(t / frameMs) % frames.length
  }

  // ---- window-frame chrome ----
  const frame = new Container()
  const chrome = new Graphics()
  function drawChrome(focused: boolean) {
    chrome.clear().roundRect(0, 0, FRAME_W, FRAME_H, 18).fill(0x8b93a1)
    // focus ring: a slightly brighter stroke riding the outer bezel
    if (focused)
      chrome.roundRect(1.5, 1.5, FRAME_W - 3, FRAME_H - 3, 17).stroke({
        width: 3,
        color: 0xd3dbe6,
      })
    chrome
      .roundRect(4, 4, FRAME_W - 8, FRAME_H - 8, 14)
      .fill(0xb7bec9)
      .roundRect(MARGIN - 6, TITLEBAR + MARGIN - 6, SHELL.w + 12, SHELL.h + 12, 6)
      .fill(0x30394a)
      .roundRect(12, 10, FRAME_W - 24, TITLEBAR - 14, 8)
      .fill(0xe8ebef)
  }
  drawChrome(false)
  frame.addChild(chrome)
  const led = new Graphics()
  frame.addChild(led)
  const titleText = new Text({
    text: 'rivet-den',
    resolution: 2,
    style: new TextStyle({
      fontFamily: '"Courier New", monospace',
      fontSize: 18,
      fontWeight: '700',
      fill: 0x30394a,
    }),
  })
  titleText.position.set(58, TITLEBAR / 2 - 10)
  frame.addChild(titleText)
  // per-window activity subtitle — replaces the old DOM caption strip
  const subtitle = new Text({
    text: '',
    resolution: 2,
    style: new TextStyle({
      fontFamily: '"Courier New", monospace',
      fontSize: 14,
      fontWeight: '700',
      fill: 0x8b93a1,
    }),
  })
  subtitle.position.set(0, TITLEBAR / 2 - 8)
  frame.addChild(subtitle)

  // OS-style per-window close button — the old #session-x, relocated onto
  // each window's title bar. While the session has a PTY linked (setTerm),
  // ✕ means TERMINATE and takes two clicks: the first arms it (red + a
  // "sure?" chip for 3s), the second kills the PTY server-side. Without a
  // PTY it keeps the C3 single-click dismiss.
  const X_SIZE = 26
  const closeX = FRAME_W - 40
  let termHooks: RoomTermHooks | null = null
  let termOpen = false
  let killArmed = false
  let disarmKill = () => {}
  if (deps.onClose) {
    const closeBtn = new Container()
    const xBg = new Graphics()
    const xGlyph = new Text({
      text: '✕',
      resolution: 2,
      style: new TextStyle({
        fontFamily: '"Courier New", monospace',
        fontSize: 16,
        fontWeight: '700',
        fill: 0x8b5a5a,
      }),
    })
    xGlyph.anchor.set(0.5)
    const drawX = (hover: boolean) => {
      xBg
        .clear()
        .roundRect(-X_SIZE / 2, -X_SIZE / 2, X_SIZE, X_SIZE, 6)
        .fill(killArmed ? 0xc0504e : hover ? 0xd9dee5 : 0xe8ebef)
        .roundRect(-X_SIZE / 2, -X_SIZE / 2, X_SIZE, X_SIZE, 6)
        .stroke({ width: 2, color: killArmed ? 0x7f2d2b : hover ? 0xb44e4e : 0x8b93a1 })
      xGlyph.style.fill = killArmed ? 0xffffff : 0x8b5a5a
    }
    drawX(false)
    closeBtn.addChild(xBg, xGlyph)
    closeBtn.position.set(closeX, TITLEBAR / 2 + 3)
    closeBtn.eventMode = 'static'
    closeBtn.cursor = 'pointer'
    closeBtn.on('pointerover', () => drawX(true))
    closeBtn.on('pointerout', () => drawX(false))
    // closing must not first re-focus the dying window through the frame
    closeBtn.on('pointerdown', (e) => e.stopPropagation())
    // "sure?" chip: rides just below the armed ✕ on the frame's face strip
    const armChip = new Container()
    const chipTxt = new Text({
      text: 'sure?',
      resolution: 2,
      style: new TextStyle({
        fontFamily: '"Courier New", monospace',
        fontSize: 12,
        fontWeight: '700',
        fill: 0xffffff,
      }),
    })
    chipTxt.anchor.set(0.5)
    const chipW = chipTxt.width + 16
    const chipBg = new Graphics().roundRect(-chipW / 2, -10, chipW, 20, 6).fill(0xc0504e)
    armChip.addChild(chipBg, chipTxt)
    armChip.position.set(closeX, TITLEBAR + 9)
    armChip.visible = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    disarmKill = () => {
      if (killTimer) clearTimeout(killTimer)
      killTimer = undefined
      if (!killArmed) return
      killArmed = false
      armChip.visible = false
      drawX(false)
    }
    closeBtn.on('pointertap', () => {
      if (!termHooks) {
        deps.onClose!()
        return
      }
      if (!killArmed) {
        killArmed = true
        armChip.visible = true
        drawX(true)
        killTimer = setTimeout(disarmKill, 3000)
        return
      }
      disarmKill()
      termHooks.onKill()
    })
    frame.addChild(closeBtn, armChip)
  }

  // ---- `>_` terminal toggle (left of ✕) — PTY-linked sessions only ----
  const termX = closeX - X_SIZE - 10
  let termBtn: Container | null = null
  let drawTermBtn = (_hover: boolean) => {}
  function ensureTermBtn() {
    if (termBtn) return
    const btn = new Container()
    const tBg = new Graphics()
    const tGlyph = new Text({
      text: '>_',
      resolution: 2,
      style: new TextStyle({
        fontFamily: '"Courier New", monospace',
        fontSize: 13,
        fontWeight: '700',
        fill: 0x30394a,
      }),
    })
    tGlyph.anchor.set(0.5)
    drawTermBtn = (hover: boolean) => {
      tBg
        .clear()
        .roundRect(-X_SIZE / 2, -X_SIZE / 2, X_SIZE, X_SIZE, 6)
        .fill(termOpen ? 0x30394a : hover ? 0xd9dee5 : 0xe8ebef)
        .roundRect(-X_SIZE / 2, -X_SIZE / 2, X_SIZE, X_SIZE, 6)
        .stroke({ width: 2, color: termOpen || hover ? 0x2f9e63 : 0x8b93a1 })
      tGlyph.style.fill = termOpen ? 0x6ee7a8 : 0x30394a
    }
    drawTermBtn(false)
    btn.addChild(tBg, tGlyph)
    btn.position.set(termX, TITLEBAR / 2 + 3)
    btn.eventMode = 'static'
    btn.cursor = 'pointer'
    btn.on('pointerover', () => drawTermBtn(true))
    btn.on('pointerout', () => drawTermBtn(false))
    btn.on('pointertap', () => termHooks?.onToggle())
    frame.addChild(btn)
    termBtn = btn
  }
  function setTerm(hooks: RoomTermHooks | null) {
    termHooks = hooks
    if (hooks) ensureTermBtn()
    if (termBtn) termBtn.visible = !!hooks
    if (!hooks) {
      disarmKill()
      termOpen = false
    }
    drawTermBtn(false)
    layoutTitlebar()
  }
  function setTermOpen(open: boolean) {
    if (open === termOpen) return
    termOpen = open
    drawTermBtn(false)
  }

  // ---- title + subtitle layout: truncate to stay clear of ✕ (and `>_`) ----
  const titleEndX = () => (termBtn?.visible ? termX : closeX) - X_SIZE / 2 - 10
  function fitText(t: Text, full: string, maxW: number) {
    t.text = full
    let keep = full.length
    while (keep > 0 && t.width > maxW) {
      keep--
      t.text = full.slice(0, keep) + '…'
    }
  }
  let titleName = ''
  let titleEnded = false
  let subtitleFull = ''
  function layoutTitlebar() {
    titleText.style.fill = titleEnded ? 0x8b93a1 : 0x30394a
    fitText(
      titleText,
      titleName ? `rivet-den · ${titleName}` : 'rivet-den',
      titleEndX() - titleText.x,
    )
    subtitle.x = titleText.x + titleText.width + 14
    fitText(subtitle, subtitleFull, titleEndX() - subtitle.x)
  }
  function setTitle(name: string, ended: boolean) {
    if (name === titleName && ended === titleEnded) return
    titleName = name
    titleEnded = ended
    layoutTitlebar()
  }

  // ---- room ----
  const world = new Container()
  world.sortableChildren = true // depth = y, so the robot can stand behind furniture
  world.position.set(MARGIN, TITLEBAR + MARGIN)
  frame.addChild(world)
  const roomMask = new Graphics().rect(0, 0, SHELL.w, SHELL.h).fill(0xffffff)
  roomMask.position.set(MARGIN, TITLEBAR + MARGIN)
  frame.addChild(roomMask)
  world.mask = roomMask
  const shellSprite = new Sprite(pixelTexture(deps.shell, SHELL.h).texture)
  shellSprite.scale.set(PX)
  shellSprite.zIndex = -10000
  world.addChild(shellSprite)

  // furniture renders from a per-instance CLONE of the canonical placement:
  // day/night swaps mutate the clone (one sleeping room dims only itself),
  // while the editor mutates the canonical object and the room re-syncs
  interface FurnItem {
    sprite: Sprite
    asset: KeyedAsset
    placement: RuntimePlacement // render clone — day/night may diverge it
    canonical: RuntimePlacement // shared layout-model placement (editor writes here)
    canonicalSrc: string // last canonical src adopted — day/night divergence guard
  }
  const furniture: Record<string, FurnItem> = {}
  // set by destroy(): async art loads (day/night swap, editor variant) must
  // not touch sprites after the window closed — grids destroy rooms routinely
  let dead = false
  // functional rects live on the pack furniture entries, in coordinates of
  // their shipped art — they only apply while that art is up
  const furnSpec = (id: string) => m.furniture.find((f) => f.id === id)
  function applyScale(it: { sprite: Sprite; asset: KeyedAsset; placement: RuntimePlacement }) {
    if (dead) return
    it.sprite.texture = pixelTexture(it.asset, it.placement.h).texture
    it.sprite.scale.set(it.placement.flip ? -PX : PX, PX)
    // snap to the global pixel grid so all sprites share one raster
    it.sprite.position.set(
      Math.round(it.placement.x / PX) * PX,
      Math.round(it.placement.y / PX) * PX,
    )
    // floor-layer pieces (rugs) draw under everything and never occlude
    it.sprite.zIndex =
      furnSpec(it.placement.id)?.layer === 'floor' ? -9000 + it.placement.y : it.placement.y
  }
  layout.placements.forEach((f) => {
    const a = deps.furnitureAssets[f.id]
    const sp = new Sprite() // texture set by applyScale below
    sp.anchor.set(0.5, 1)
    world.addChild(sp)
    furniture[f.id] = {
      sprite: sp,
      asset: a,
      placement: { ...f },
      canonical: f,
      canonicalSrc: f.src,
    }
    applyScale(furniture[f.id])
  })
  // pull x/y/h/flip (and, on variant swaps, src) from the canonical placement
  // back into this room's render clone
  function syncFromCanonical(it: FurnItem) {
    it.placement.x = it.canonical.x
    it.placement.y = it.canonical.y
    it.placement.h = it.canonical.h
    it.placement.flip = it.canonical.flip
    if (it.canonicalSrc !== it.canonical.src) {
      // the canonical ART changed (variant swap) — adopt it. Day/night swaps
      // diverge the clone from an UNCHANGED canonical; those are left alone.
      it.canonicalSrc = it.canonical.src
      it.placement.src = it.canonical.src
      void loadAsset(it.placement.src).then((a) => {
        if (dead) return
        it.asset = a
        applyScale(it)
      })
    }
    applyScale(it)
  }

  // ---- day/night art: `nightSrc` swaps in between 19:00 and 07:00 local ----
  // (?tod=day|night forces it for testing). Only art still on its pack
  // default is swapped — EDIT-mode variant choices are left alone.
  const todOverride = new URLSearchParams(location.search).get('tod')
  let sleepNight = false // sleeping forces night — the room dims for the nap
  const isNight = () => {
    if (sleepNight) return true
    if (todOverride) return todOverride === 'night'
    const hour = new Date().getHours()
    return hour < 7 || hour >= 19
  }
  let nightApplied: boolean | null = null
  async function applyTimeOfDay() {
    const night = isNight()
    if (night === nightApplied) return
    nightApplied = night
    if (m.shell.nightSrc) {
      const src = night ? m.shell.nightSrc : m.shell.src
      const a = await loadAsset(pack.url(src), false)
      if (dead) return
      shellSprite.texture = pixelTexture(a, SHELL.h).texture
    }
    for (const f of m.furniture) {
      if (!f.nightSrc) continue
      const it = furniture[f.id]
      if (!it) continue
      const day = pack.url(f.src)
      const nite = pack.url(f.nightSrc)
      if (it.placement.src !== day && it.placement.src !== nite) continue // EDIT override wins
      const want = night ? nite : day
      if (it.placement.src === want) continue
      it.asset = await loadAsset(want)
      if (dead) return
      it.placement.src = want
      applyScale(it)
    }
    if (dead) return
    refreshBoardOverlay()
    refreshTermOverlay()
  }
  const todTimer = setInterval(() => void applyTimeOfDay(), 60_000)

  // ---- whiteboard text overlay ----
  let boardWrapW = 300 // writable width in world px — set by refreshBoardOverlay
  const boardTitle = new Text({
    text: '',
    resolution: 2,
    style: new TextStyle({
      fontFamily: fonts.fontFor('board'),
      fontSize: 16,
      fontWeight: '700',
      fill: 0x2b6cb0,
      wordWrap: true,
      wordWrapWidth: 300,
    }),
  })
  const boardList = new Container()
  world.addChild(boardTitle, boardList)
  function refreshBoardOverlay() {
    const bd = furniture['board']
    if (!bd) return
    const s = bd.placement.h / bd.asset.bh
    const bx = bd.sprite.x - (bd.asset.bw / 2) * s
    const by = bd.sprite.y - bd.asset.bh * s
    const spec = furnSpec('board')
    const rect = spec?.textRect && bd.placement.src === pack.url(spec.src) ? spec.textRect : null
    const tlx = rect ? bx + (rect.x - bd.asset.ox) * s : bx + bd.asset.bw * s * 0.12
    const tly = rect ? by + (rect.y - bd.asset.oy) * s : by + bd.asset.bh * s * 0.12
    boardWrapW = Math.max(60, (rect ? rect.w : bd.asset.bw * 0.76) * s)
    boardTitle.style.wordWrapWidth = boardWrapW
    boardTitle.position.set(tlx, tly)
    boardList.position.set(tlx, tly + 26)
    boardTitle.zIndex = bd.placement.y + 1
    boardList.zIndex = bd.placement.y + 1
    // re-wrap existing content after moves/resizes. Guarded: renderBoard reads
    // `state`, which doesn't exist during the init-time call — and the board
    // only ever has content once state does (renderBoard is its sole writer)
    if (boardTitle.text || boardList.children.length) renderBoard()
  }
  refreshBoardOverlay()

  // ---- desk monitor terminal overlay ----
  const termText = new Text({
    text: '',
    resolution: 3,
    style: new TextStyle({
      fontFamily: '"Courier New", monospace',
      fontSize: 9,
      lineHeight: 11.5,
      fill: 0x6ee7a8,
    }),
  })
  world.addChild(termText)
  const termCols = m.viewer?.termCols ?? 17 // fewer, larger glyphs — small monitors stay legible
  let termRows = 3 // how many lines fit the glass — set by refreshTermOverlay
  function refreshTermOverlay() {
    const dk = furniture['desk']
    if (!dk) {
      termText.visible = false
      return
    }
    const s = dk.placement.h / dk.asset.bh
    const bx = dk.sprite.x - (dk.asset.bw / 2) * s
    const by = dk.sprite.y - dk.asset.bh * s
    const spec = furnSpec('desk')
    const rect = spec?.screen && dk.placement.src === pack.url(spec.src) ? spec.screen : null
    const tx = rect ? bx + (rect.x - dk.asset.ox) * s : bx + dk.asset.bw * s * 0.3
    const ty = rect ? by + (rect.y - dk.asset.oy) * s : by + dk.asset.bh * s * 0.1
    const tw = (rect ? rect.w : dk.asset.bw * 0.4) * s
    termText.position.set(tx, ty)
    termText.zIndex = dk.placement.y + 1
    // scale the 9px face so ~termCols columns span the screen width
    const termScale = tw / (termCols * 5.5)
    termText.scale.set(termScale)
    // clamp to the glass: lines that don't fit scroll off the TOP, not the desk
    const th = (rect ? rect.h : dk.asset.bh * 0.25) * s
    termRows = Math.max(1, Math.floor(th / (11.5 * termScale)))
    if (termText.text) renderTerm() // re-clamp after moves/resizes (state exists by then)
  }
  function renderTerm() {
    termText.text = state.term
      .slice(-termRows)
      .map((l) => (l.length > termCols ? l.slice(0, termCols - 1) + '…' : l))
      .join('\n')
  }
  refreshTermOverlay()
  void applyTimeOfDay()

  // ---- character ----
  const char = new Container()
  const shadow = new Graphics().ellipse(0, 0, 30, 8).fill({ color: 0x000000, alpha: 0.28 })
  const charSprite = new Sprite(poses.idle[0].texture)
  charSprite.anchor.set(0.5, 1)
  char.addChild(shadow, charSprite)
  // spawn at the idle station, not the room origin
  char.position.set(stations.idle.x ?? SHELL.w / 2, stations.idle.y ?? SHELL.h - 60)
  world.addChild(char)
  let poseName = 'idle'
  let poseFlip = false
  let squash = 1 // x-squash used to fake the chair swivel rotation
  function setPose(name: string, flip = false) {
    if (name !== poseName) poseStartT = t
    poseName = name
    poseFlip = flip
  }
  let frameOverride: number | null = null // outro playback pins the frame
  function renderPose(t: number) {
    const frames = poses[poseName] ?? poses.idle
    const idx = frameOverride ?? poseFrame(poseName, t)
    charSprite.texture = frames[Math.min(idx, frames.length - 1)].texture
    charSprite.scale.set((poseFlip ? -PX : PX) * squash, PX)
  }
  setPose('idle')

  // side-view chair art for the swivel, when the pack ships one
  function setChairView(view: 'back' | 'side', sq = 1) {
    const it = furniture['chair']
    if (!it) return
    const asset = view === 'side' && chairSideAsset ? chairSideAsset : it.asset
    it.sprite.texture = pixelTexture(asset, it.placement.h).texture
    it.sprite.scale.set((it.placement.flip ? -PX : PX) * sq, PX)
  }

  // ---- sleeping Z's: spawn above the head, drift up-right, grow + fade ----
  const zzz = new Container()
  zzz.zIndex = 8500
  world.addChild(zzz)
  interface ZParticle {
    t: Text
    age: number
    life: number
    x0: number
    y0: number
  }
  const zParticles: ZParticle[] = []
  let zClock = 9999 // spawn the first z immediately on falling asleep
  function spawnZ(x: number, y: number) {
    const t = new Text({
      text: 'z',
      resolution: 2,
      style: new TextStyle({
        fontFamily: fonts.fontFor('zzz'),
        fontSize: 22,
        fontWeight: '700',
        fill: 0xffffff,
        stroke: { color: 0x30394a, width: 3 },
      }),
    })
    t.anchor.set(0.5)
    zzz.addChild(t)
    zParticles.push({ t, age: 0, life: 2600, x0: x, y0: y })
  }
  function tickZs(dt: number, sleeping: boolean, hx: number, hy: number) {
    zClock += dt
    if (sleeping && zClock > 900) {
      zClock = 0
      spawnZ(hx, hy)
    }
    for (let i = zParticles.length - 1; i >= 0; i--) {
      const p = zParticles[i]
      p.age += dt
      const q = p.age / p.life
      if (q >= 1) {
        p.t.destroy()
        zParticles.splice(i, 1)
        continue
      }
      const x = p.x0 + p.age * 0.016 + Math.sin(p.age / 320) * 6
      const y = p.y0 - p.age * 0.028
      p.t.position.set(Math.round(x / PX) * PX, Math.round(y / PX) * PX)
      p.t.scale.set(0.6 + q * 1.1)
      p.t.alpha = q < 0.6 ? 1 : 1 - (q - 0.6) / 0.4
    }
  }

  const thought = bubble(260, 0x8aa1b8, fonts.fontFor('bubble'))
  // live-ticking spinner meta: parsed from "✳ Word… (28s · ↓ 4.8k tokens)"
  let thoughtSpin: { pre: string; secs: number; suf: string; at: number } | null = null
  let thoughtSpinShown = -1
  const speech = bubble(280, 0x34d399, fonts.fontFor('bubble'))
  thought.container.zIndex = 9000
  speech.container.zIndex = 9001
  world.addChild(thought.container, speech.container)

  // (The RPG narration chat panel that used to fill the upper-right wall is
  // gone — the terminal drawer replaced it. RoomState.log still arrives via
  // the protocol; it just isn't rendered. Narration is carried by the speech
  // bubble, the whiteboard and the titlebar subtitle.)

  // ---- state: whatever main.ts last pushed via setState() ----
  let state: RoomState = initialRoomState
  let speechTimer = 0

  function renderBoard() {
    boardTitle.text = state.title ? `◤ ${state.title.toUpperCase()}` : ''
    // list starts below the title, however many lines it wrapped to
    boardList.y = boardTitle.y + (boardTitle.text ? Math.max(26, boardTitle.height + 6) : 0)
    boardList.removeChildren()
    let rowY = 0
    for (const t of state.tasks) {
      const row = new Container()
      const box = new Graphics()
        .rect(0, 3, 12, 12)
        .stroke({ width: 2, color: t.done ? 0x2f9e63 : 0x556575 })
      if (t.done) box.moveTo(2, 9).lineTo(5, 13).lineTo(11, 3).stroke({ width: 2, color: 0x2f9e63 })
      const label = new Text({
        text: t.label,
        resolution: 2,
        style: new TextStyle({
          fontFamily: fonts.fontFor('board'),
          fontSize: 16,
          fill: t.done ? 0x8fa3b5 : 0x22303f,
          wordWrap: true,
          wordWrapWidth: Math.max(40, boardWrapW - 20),
        }),
      })
      label.position.set(20, 0)
      row.addChild(box, label)
      row.y = rowY
      boardList.addChild(row)
      rowY += Math.max(24, label.height + 8)
    }
  }

  function renderLed() {
    const color = LED_COLOR[state.activity]
    led
      .clear()
      .circle(26, TITLEBAR / 2 + 2, 7)
      .fill(color)
      .circle(26, TITLEBAR / 2 + 2, 7)
      .stroke({ width: 2, color: 0x30394a, alpha: 0.4 })
  }

  function setState(s: RoomState) {
    state = s
    const wantSleepNight = state.activity === 'sleeping'
    if (wantSleepNight !== sleepNight) {
      sleepNight = wantSleepNight
      void applyTimeOfDay()
    }
    renderBoard()
    renderLed()
    renderTerm()
    subtitleFull = state.tool
      ? `${ACTIVITY_LABEL[state.activity]} · ${state.tool}`
      : ACTIVITY_LABEL[state.activity]
    layoutTitlebar()
    thought.container.visible = !!state.thought
    if (state.thought) {
      thought.set(state.thought)
      // spinner status line → tick the elapsed time locally between hooks
      const m = state.thought.match(/^(.* \()(?:(\d+)m )?(\d+)s( · .*\))$/)
      thoughtSpin = m
        ? {
            pre: m[1],
            secs: Number(m[2] ?? 0) * 60 + Number(m[3]),
            suf: m[4],
            at: performance.now(),
          }
        : null
    } else {
      thoughtSpin = null
    }
  }

  // per-event side effects — the reducer already updated the state; this is
  // just the transient presentation (speech bubble trigger)
  function onEvent(ev: AgentEvent) {
    if (ev.type === 'message.agent') {
      const msg = state.lastMessage
      speech.set(msg.length > 180 ? msg.slice(0, 177) + '…' : msg)
      speech.container.visible = true
      speechTimer = 6000
    }
  }

  // ---- movement + animation ----
  const fallbackStation = m.viewer?.fallbackStation ?? { x: SHELL.w / 2, y: SHELL.h * 0.9 }
  const floorTop = m.viewer?.floorTop ?? 0.755
  function stationPos(s: Station): { x: number; y: number } {
    let x = s.x ?? fallbackStation.x,
      y = s.y ?? fallbackStation.y
    if (s.furn && furniture[s.furn]) {
      const p = furniture[s.furn].placement
      x = p.x + (s.dx ?? 0)
      y = p.y + (s.dy ?? 0)
    }
    // stations must stay on the visible floor even when their anchor furniture
    // bleeds off-frame (e.g. the bed) — otherwise the robot walks off-screen
    return {
      x: Math.min(SHELL.w - 40, Math.max(40, x)),
      y: Math.min(SHELL.h - 12, Math.max(SHELL.h * floorTop, y)),
    }
  }
  let t = 0
  let stickyActivity: Activity = 'idle' // last activity with a place of its own
  type ChairPhase = 'hop_on' | 'swivel_in' | 'type' | 'swivel_out' | 'hop_off'
  let chairSeq: { phase: ChairPhase; t: number } | null = null
  let hiddenFurn: string[] | null = null // furniture currently replaced by composite art
  // outro: poses with intro frames play them REVERSED when leaving (climb
  // back out of bed, put the phone away) before the character moves on
  let settledPose: string | null = null
  let outro: { pose: string; start: number; x: number; y: number; flip: boolean } | null = null
  let lastCompositeFeet: { x: number; y: number } | null = null
  const HOP_MS = 340,
    SWIVEL_MS = 320
  const lerp = (a: number, b: number, p: number) => a + (b - a) * p

  function update(dtMS: number) {
    t += dtMS
    // thinking/listening happen wherever you already are — the robot keeps
    // its spot (desk, board, toolbox) and just shows the bubble/pose instead
    // of trotting to a dedicated corner between every tool call
    if (state.activity !== 'thinking' && state.activity !== 'listening')
      stickyActivity = state.activity
    const station = stations[stickyActivity] ?? stations.idle
    const targetPose = resolvePose(m, state.activity, state.tool)
    // seat choreography kicks in when the activity's station is the chair
    const wantsChair = station.furn === 'chair' && !!furniture['chair']
    // composite pose: art contains character + furniture; walk to the
    // furniture anchor itself, then swap in the composite and hide the piece
    const rawReplaces = m.character.poses[targetPose]?.replaces
    const replaceIds = rawReplaces ? (Array.isArray(rawReplaces) ? rawReplaces : [rawReplaces]) : []
    // anchored to the FIRST replaced id; all listed pieces hide during the pose
    const composite =
      replaceIds.length > 0 && replaceIds.every((id) => furniture[id]) ? replaceIds : null
    // the walk target IS the final (anchored + wall-clamped) composite spot,
    // otherwise the clamp leaves him "not there yet" and walk/pose flicker
    const compositeTarget = () => {
      const fp = furniture[composite![0]].placement
      const poseSpec = m.character.poses[targetPose]
      const anchor = poseSpec.attachments?.anchor
      const feet = poseSpec.attachments?.feet
      const frame0 = poses[targetPose][0]
      const imgW = poseImgSize[targetPose]?.w
      const fFlip = !!fp.flip
      const imgH = poseImgSize[targetPose]?.h
      const dispW = frame0.cols * PX
      const dispH = frame0.rows * PX
      let x = fp.x
      if (anchor && imgW) x = fp.x + (fFlip ? -1 : 1) * dispW * (0.5 - anchor.x / imgW)
      // no wall clamp: composites clip at the room edge exactly like the
      // furniture they replace, so the box never shifts on the swap
      const settleX = x
      // pin the anchor's y to the furniture baseline too (composite art may
      // extend below it — e.g. feet under a wall-mounted board)
      const settleY = anchor && imgH ? fp.y + dispH * (1 - anchor.y / imgH) : fp.y
      // walk to where the character's FEET are inside the art, not the box —
      // x AND y, so standing behind the furniture reads correctly
      const walkX =
        feet && imgW ? settleX + (fFlip ? -1 : 1) * dispW * (feet.x / imgW - 0.5) : settleX
      const walkY = feet && imgH ? settleY + dispH * (feet.y / imgH - 1) : settleY
      return { x: walkX, y: walkY, flip: fFlip, settleX, settleY }
    }
    const tp = composite ? compositeTarget() : stationPos(station)
    const dx = tp.x - char.x,
      dy = tp.y - char.y
    const dist = Math.hypot(dx, dy)
    const chairIt = furniture['chair']
    let behindChair = false // seated = tucked in behind the chair back
    let activeComposite: string[] | null = null // set when settled into composite art

    // leaving a settled pose that has intro frames → play them in reverse first
    if (!outro && settledPose && settledPose !== targetPose) {
      const oSpec = m.character.poses[settledPose]
      if (oSpec?.intro && oSpec.frameMs > 0) {
        outro = { pose: settledPose, start: t, x: char.x, y: char.y, flip: poseFlip }
      }
      settledPose = null
    }
    let inOutro = false
    if (outro) {
      const oSpec = m.character.poses[outro.pose]
      const el = t - outro.start
      const dur = (oSpec.intro ?? 1) * oSpec.frameMs
      if (el < dur) {
        inOutro = true
        char.x = outro.x
        char.y = outro.y
        poseName = outro.pose
        poseFlip = outro.flip
        frameOverride = (oSpec.intro ?? 1) - 1 - Math.floor(el / oSpec.frameMs)
        charSprite.y = 0
        charSprite.rotation = 0
        const oRepl = oSpec.replaces
          ? Array.isArray(oSpec.replaces)
            ? oSpec.replaces
            : [oSpec.replaces]
          : []
        if (oRepl.length > 0 && oRepl.every((id) => furniture[id])) activeComposite = oRepl
      } else {
        outro = null
        frameOverride = null
      }
    }
    if (!inOutro) frameOverride = null

    if (inOutro) {
      // holding position while the outro plays — no movement this tick
    } else if (chairSeq && chairIt) {
      chairSeq.t += dtMS
      const side = stationPos(stations.editing_code ?? station)
      const seat = {
        x: chairIt.placement.x,
        y: chairIt.placement.y - Math.round(chairIt.placement.h * 0.32),
      }
      const dur =
        chairSeq.phase === 'swivel_in' || chairSeq.phase === 'swivel_out' ? SWIVEL_MS : HOP_MS
      const p = Math.min(1, chairSeq.t / dur)
      charSprite.rotation = 0
      squash = 1
      switch (chairSeq.phase) {
        case 'hop_on':
          setPose('sitside', false)
          char.x = lerp(side.x, seat.x, p)
          char.y = lerp(side.y, seat.y, p)
          charSprite.y = -Math.sin(p * Math.PI) * 26
          if (p >= 1) chairSeq = { phase: 'swivel_in', t: 0 }
          break
        case 'swivel_in':
          char.x = seat.x
          char.y = seat.y
          charSprite.y = 0
          squash = Math.abs(Math.cos(p * Math.PI))
          behindChair = p >= 0.5 // the swivel carries him behind the chair back
          if (p < 0.5) {
            setPose('sitside', false)
            setChairView('side', squash)
          } else {
            setPose(targetPose, false)
            setChairView('back', squash)
          }
          if (p >= 1) {
            squash = 1
            setChairView('back', 1)
            chairSeq = { phase: 'type', t: 0 }
          }
          break
        case 'type':
          char.x = seat.x
          char.y = seat.y
          behindChair = true
          setPose(wantsChair ? targetPose : poseName, false)
          // grid-aligned typing bounce (loops for as long as the work continues)
          charSprite.y = Math.floor(t / 220) % 2 ? -PX : 0
          if (!wantsChair) chairSeq = { phase: 'swivel_out', t: 0 }
          break
        case 'swivel_out':
          char.x = seat.x
          char.y = seat.y
          charSprite.y = 0
          squash = Math.abs(Math.cos(p * Math.PI))
          behindChair = p < 0.5 // ...and the swivel-out brings him back in front
          if (p < 0.5) {
            setChairView('back', squash)
          } else {
            setPose('sitside', false)
            setChairView('side', squash)
          }
          if (p >= 1) {
            squash = 1
            setChairView('side', 1)
            chairSeq = { phase: 'hop_off', t: 0 }
          }
          break
        case 'hop_off':
          setPose('sitside', false)
          char.x = lerp(seat.x, side.x, p)
          char.y = lerp(seat.y, side.y, p)
          charSprite.y = -Math.sin(p * Math.PI) * 26
          if (p >= 1) {
            chairSeq = null
            setChairView('back', 1)
          }
          break
      }
    } else if (composite && (hiddenFurn?.join() === composite.join() || dist <= 4)) {
      // settled in (latched once the swap happens): the composite art IS
      // character + furniture together, anchored + clamped by
      // compositeTarget(); flip follows the furniture placement
      char.x = 'settleX' in tp && typeof tp.settleX === 'number' ? tp.settleX : tp.x
      char.y = 'settleY' in tp && typeof tp.settleY === 'number' ? tp.settleY : tp.y
      setPose(targetPose, 'flip' in tp && tp.flip === true)
      charSprite.y = 0
      charSprite.rotation = 0
      activeComposite = composite
      settledPose = targetPose
      lastCompositeFeet = { x: tp.x, y: tp.y } // exit resumes from the feet spot
    } else if (dist > 4) {
      const step = Math.min(dist, 0.32 * dtMS)
      char.x += (dx / dist) * step
      char.y += (dy / dist) * step
      setPose('walk', dx > 0) // walk sprite faces left; flip when heading right
      charSprite.y = Math.abs(Math.sin(t / 110)) * -7
      charSprite.rotation = 0
    } else if (wantsChair) {
      chairSeq = { phase: 'hop_on', t: 0 } // arrived at the chair-side mark
    } else if (targetPose === 'dig') {
      // rummaging behind the toolbox: quick bob + rock, occasional pop-up.
      const boxRight = (furniture[station.furn ?? 'toolbox']?.placement.x ?? 0) > char.x
      setPose('dig', boxRight)
      const cycle = (t % 2600) / 2600
      if (cycle > 0.86) {
        setPose('idle')
        charSprite.y = -10
        charSprite.rotation = 0
      } else {
        charSprite.y = Math.abs(Math.sin(t / 130)) * -5
        charSprite.rotation = Math.sin(t / 190) * 0.06
      }
    } else {
      setPose(targetPose)
      charSprite.rotation = 0
      settledPose = targetPose
      // working poses sit still except for their frame animation; others breathe
      const still = m.character.poses[targetPose]?.frameMs !== 0 && targetPose !== 'idle'
      charSprite.y = still ? 0 : Math.sin(t / 550) * 3
    }
    renderPose(t)
    // composite art stands in for its furniture — hide/restore on transition
    if ((hiddenFurn?.join() ?? '') !== (activeComposite?.join() ?? '')) {
      for (const id of hiddenFurn ?? []) {
        if (furniture[id]) furniture[id].sprite.visible = true
      }
      // step out of the composite at the feet spot, then walk from there
      if (hiddenFurn && lastCompositeFeet) {
        char.x = lastCompositeFeet.x
        char.y = lastCompositeFeet.y
        lastCompositeFeet = null
      }
      for (const id of activeComposite ?? []) furniture[id].sprite.visible = false
      hiddenFurn = activeComposite
    }
    // head point from the pose's head attachment, when defined
    let headPt: { x: number; y: number } | null = null
    {
      const hSpec = m.character.poses[poseName]
      const head = hSpec?.attachments?.head
      const img = poseImgSize[poseName]
      if (head && img) {
        const f0 = poses[poseName][0]
        headPt = {
          x: char.x + (poseFlip ? -1 : 1) * f0.cols * PX * (head.x / img.w - 0.5),
          y: char.y - f0.rows * PX + head.y * ((f0.rows * PX) / img.h),
        }
      }
    }
    {
      // Z's drift up from ABOVE the head, not out of his forehead
      const hx = headPt ? headPt.x : char.x - 62
      const hy = headPt ? headPt.y - 34 : char.y - poseHeight('sleep') - 12
      // spawn Z's the whole time he's settled asleep (composite settle keeps
      // dist>0 by design — gate on the settled latch, not distance), and only
      // once the climb-in intro has finished
      const introMs =
        (m.character.poses[poseName]?.intro ?? 0) * (m.character.poses[poseName]?.frameMs ?? 0)
      const asleep =
        state.activity === 'sleeping' &&
        (activeComposite !== null || dist <= 4) &&
        !inOutro &&
        !chairSeq &&
        t - poseStartT > introMs
      tickZs(dtMS, asleep, hx, hy)
    }
    char.zIndex = activeComposite
      ? Math.max(...activeComposite.map((id) => furniture[id].placement.y)) + 2 // in front of all replaced pieces + their text overlays
      : behindChair && chairIt
        ? chairIt.placement.y - 1
        : composite
          ? char.y // approaching/leaving a composite: depth-sort so he can pass behind it
          : 8000
    // the terminal must stay visible on the desk composite's monitor — his
    // head is below the screen by construction, so it can safely top him
    termText.zIndex = hiddenFurn?.includes('desk')
      ? char.zIndex + 1
      : (furniture['desk']?.placement.y ?? 0) + 1
    // bubble bottom (tail dots hang below the anchor) must clear his face
    const bubbleX = headPt ? headPt.x + 26 : char.x + 34
    const bubbleY = headPt ? headPt.y - 58 : char.y - CHAR_HEIGHT - 16
    thought.container.position.set(bubbleX, bubbleY)
    speech.container.position.set(bubbleX, bubbleY)
    if (speechTimer > 0) {
      speechTimer -= dtMS
      if (speechTimer <= 0) speech.container.visible = false
    }
    if (thought.container.visible && thoughtSpin) {
      const total = thoughtSpin.secs + Math.floor((performance.now() - thoughtSpin.at) / 1000)
      if (total !== thoughtSpinShown) {
        thoughtSpinShown = total
        const dur = total < 60 ? `${total}s` : `${Math.floor(total / 60)}m ${total % 60}s`
        thought.set(thoughtSpin.pre + dur + thoughtSpin.suf)
      }
    }
  }

  // the editor works on the CANONICAL placements (shared across rooms) but
  // grabs/highlights THIS room's sprites
  const editorItems = Object.fromEntries(
    Object.entries(furniture).map(([id, it]) => [
      id,
      { sprite: it.sprite, placement: it.canonical },
    ]),
  )
  function editorHooks(): RoomEditorHooks {
    return {
      world,
      items: editorItems,
      stations,
      stationPos,
      variants: Object.fromEntries(
        m.furniture.map((f) => [f.id, [f.src, ...(f.variants ?? [])].map((v) => pack.url(v))]),
      ),
      swapItemArt: async (id, src) => {
        const it = furniture[id]
        it.canonical.src = src
        it.canonicalSrc = src
        const asset = await loadAsset(src)
        if (dead) return
        it.asset = asset
        it.placement.src = src
        it.placement.flip = it.canonical.flip // editor resets flip before swapping
        applyScale(it)
        if (id === 'board') refreshBoardOverlay()
        if (id === 'desk') refreshTermOverlay()
      },
      applyScale: (id) => {
        const it = furniture[id]
        if (it) syncFromCanonical(it)
      },
    }
  }

  // the editor (or, in C3, another room's editor pass) changed the canonical
  // layout — pull it into this room and re-derive the dependent overlays
  const offLayoutChange = layout.onChange(() => {
    for (const it of Object.values(furniture)) syncFromCanonical(it)
    refreshBoardOverlay()
    refreshTermOverlay()
  })

  return {
    id: deps.id,
    root: frame,
    frameW: FRAME_W,
    frameH: FRAME_H,
    setState,
    setTitle,
    setFocused: drawChrome,
    onEvent,
    setTerm,
    setTermOpen,
    update,
    applyTimeOfDay,
    charX: () => char.x,
    editorHooks,
    destroy: () => {
      dead = true
      disarmKill()
      clearInterval(todTimer)
      offLayoutChange()
      frame.destroy({ children: true })
    },
  }
}
