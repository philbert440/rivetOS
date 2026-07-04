import { Application, Container, Graphics, Sprite, Text, TextStyle } from 'pixi.js'
import {
  initialRoomState,
  reduceRoom,
  type Activity,
  type AgentEvent,
  type AgentEventBody,
  type RoomState,
} from '@rivetos/den-protocol'
import type { Station } from '@rivetos/den-packs'
import { demoScript, DEMO_LOOP_MS } from './demo.js'
import { configureAssets, loadAsset, pixelTexture, PX, type KeyedAsset } from './assets.js'
import { loadPack, resolvePose } from './pack.js'
import { initEditor, loadLayout, setLayoutPack, type RuntimePlacement } from './editor.js'
import { serverHttp, serverWs, withToken } from './net.js'

const MARGIN = 26
const TITLEBAR = 48

const ACTIVITY_LABEL: Record<Activity, string> = {
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

const LED_COLOR: Record<Activity, number> = {
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

function bubble(maxWidth: number, color: number) {
  const g = new Graphics()
  const style = new TextStyle({
    fontFamily: '"Courier New", monospace',
    fontSize: 14,
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

async function boot() {
  const app = new Application()
  await app.init({ background: 0x141a26, resizeTo: window, antialias: false })
  document.getElementById('stage')!.appendChild(app.canvas)

  // ---- load the SpritePack: every art constant comes from the manifest ----
  const packName = new URLSearchParams(location.search).get('pack') ?? 'default'
  const pack = await loadPack(`${serverHttp}/packs/${packName}`)
  const m = pack.manifest
  configureAssets({
    pxPerUnit: m.grid.pxPerUnit,
    chromaColor: m.chroma.color,
    chromaThreshold: m.chroma.threshold,
  })
  const SHELL = { w: m.shell.w, h: m.shell.h }
  const FRAME_W = SHELL.w + MARGIN * 2
  const FRAME_H = SHELL.h + MARGIN * 2 + TITLEBAR
  const CHAR_HEIGHT = m.character.height

  // ---- layout: pack default, overridden by the node's canonical copy ----
  // Server-first, keyed per pack; localStorage is only the offline cache.
  setLayoutPack(packName)
  const saved = await loadLayout()
  const placements: RuntimePlacement[] = m.furniture
    .filter((f) => m.layout[f.id])
    .map((f) => {
      const d = m.layout[f.id]
      const o = saved?.placements?.[f.id]
      return {
        id: f.id,
        src: o?.src ?? pack.url(f.src),
        x: o?.x ?? d.x,
        y: o?.y ?? d.y,
        h: o?.h ?? d.h,
        flip: o?.flip ?? d.flip,
      }
    })
  const stations: Record<string, Station> = Object.fromEntries(
    Object.entries(m.stations).map(([k, v]) => [k, { ...v }]),
  )
  for (const [act, o] of Object.entries(saved?.stations ?? {})) {
    if (stations[act]) Object.assign(stations[act], o)
  }

  const [shell, ...furnAssets] = await Promise.all([
    loadAsset(pack.url(m.shell.src), false),
    ...placements.map((f) => loadAsset(f.src)),
  ])

  // ---- character poses, straight from the pack manifest ----
  type Frame = ReturnType<typeof pixelTexture>
  const poses: Record<string, Frame[]> = {}
  const poseImgSize: Record<string, { w: number; h: number }> = {}
  await Promise.all(
    Object.entries(m.character.poses).map(async ([name, pose]) => {
      const h = pose.height ?? CHAR_HEIGHT
      poses[name] = await Promise.all(
        pose.frames.map(async (f) => {
          const asset = await loadAsset(pack.url(f))
          poseImgSize[name] ??= { w: asset.bw, h: asset.bh }
          return pixelTexture(asset, h)
        }),
      )
    }),
  )
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
  app.stage.addChild(frame)
  const chrome = new Graphics()
    .roundRect(0, 0, FRAME_W, FRAME_H, 18)
    .fill(0x8b93a1)
    .roundRect(4, 4, FRAME_W - 8, FRAME_H - 8, 14)
    .fill(0xb7bec9)
    .roundRect(MARGIN - 6, TITLEBAR + MARGIN - 6, SHELL.w + 12, SHELL.h + 12, 6)
    .fill(0x30394a)
    .roundRect(12, 10, FRAME_W - 24, TITLEBAR - 14, 8)
    .fill(0xe8ebef)
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

  // ---- room ----
  const world = new Container()
  world.sortableChildren = true // depth = y, so the robot can stand behind furniture
  world.position.set(MARGIN, TITLEBAR + MARGIN)
  frame.addChild(world)
  const roomMask = new Graphics().rect(0, 0, SHELL.w, SHELL.h).fill(0xffffff)
  roomMask.position.set(MARGIN, TITLEBAR + MARGIN)
  frame.addChild(roomMask)
  world.mask = roomMask
  const shellSprite = new Sprite(pixelTexture(shell, SHELL.h).texture)
  shellSprite.scale.set(PX)
  shellSprite.zIndex = -10000
  world.addChild(shellSprite)

  const furniture: Record<
    string,
    { sprite: Sprite; asset: KeyedAsset; placement: RuntimePlacement }
  > = {}
  // functional rects live on the pack furniture entries, in coordinates of
  // their shipped art — they only apply while that art is up
  const furnSpec = (id: string) => m.furniture.find((f) => f.id === id)
  function applyScale(it: { sprite: Sprite; asset: KeyedAsset; placement: RuntimePlacement }) {
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
  placements.forEach((f, i) => {
    const a = furnAssets[i]
    const sp = new Sprite() // texture set by applyScale below
    sp.anchor.set(0.5, 1)
    world.addChild(sp)
    furniture[f.id] = { sprite: sp, asset: a, placement: f }
    applyScale(furniture[f.id])
  })

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
      it.placement.src = want
      applyScale(it)
    }
    refreshBoardOverlay()
    refreshTermOverlay()
  }
  setInterval(() => void applyTimeOfDay(), 60_000)

  // ---- whiteboard text overlay ----
  const boardTitle = new Text({
    text: '',
    resolution: 2,
    style: new TextStyle({
      fontFamily: '"Courier New", monospace',
      fontSize: 15,
      fontWeight: '700',
      fill: 0x2b6cb0,
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
    boardTitle.position.set(tlx, tly)
    boardList.position.set(tlx, tly + 26)
    boardTitle.zIndex = bd.placement.y + 1
    boardList.zIndex = bd.placement.y + 1
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
  const chairSideSrc = furnSpec('chair')?.sideSrc
  const chairSideAsset = chairSideSrc
    ? await loadAsset(pack.url(chairSideSrc)).catch(() => null)
    : null
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
  type ZParticle = { t: Text; age: number; life: number; x0: number; y0: number }
  const zParticles: ZParticle[] = []
  let zClock = 9999 // spawn the first z immediately on falling asleep
  function spawnZ(x: number, y: number) {
    const t = new Text({
      text: 'z',
      resolution: 2,
      style: new TextStyle({
        fontFamily: '"Courier New", monospace',
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

  const thought = bubble(260, 0x8aa1b8)
  // live-ticking spinner meta: parsed from "✳ Word… (28s · ↓ 4.8k tokens)"
  let thoughtSpin: { pre: string; secs: number; suf: string; at: number } | null = null
  let thoughtSpinShown = -1
  const speech = bubble(280, 0x34d399)
  thought.container.zIndex = 9000
  speech.container.zIndex = 9001
  world.addChild(thought.container, speech.container)

  const caption = document.getElementById('caption')!
  const pttLive = document.getElementById('ptt-live')!

  // ---- RPG narration panel ----
  // Lives IN the room, filling the empty wall in the upper right — left edge
  // aligned with the whiteboard, right edge at the wall, bottom just above
  // the whiteboard/shelf tops. The rect is computed from the live furniture
  // placements (rebuildChatPanel), so it follows pack/layout changes.
  const CHAT_PAD = 12,
    CHAT_FS = 14,
    CHAT_GAP = 6 // vertical gap between messages
  let chatW = 640
  let chatH = 120
  const chat = new Container()
  chat.zIndex = 9100
  chat.visible = false
  const chatBg = new Graphics()
  chat.addChild(chatBg)
  const chatMask = new Graphics()
  chat.addChild(chatMask)
  const chatContent = new Container()
  chatContent.mask = chatMask
  chat.addChild(chatContent)
  world.addChild(chat)
  const chatStyle = (fill: number, bold = false) =>
    new TextStyle({
      fontFamily: '"Courier New", monospace',
      fontSize: CHAT_FS,
      fontWeight: bold ? '700' : '400',
      fill,
    })
  const chatEntries: { who: Text; body: Text }[] = []
  // scroll offset in px up from the bottom (0 = pinned to the newest message)
  let chatScroll = 0
  function layoutChatContent() {
    let y = 0
    for (const en of chatEntries) {
      en.who.y = en.body.y = y
      y += Math.max(en.body.height, en.who.height) + CHAT_GAP
    }
    const contentH = y - CHAT_GAP
    const innerH = chatH - CHAT_PAD * 2
    const maxScroll = Math.max(0, contentH - innerH)
    chatScroll = Math.min(chatScroll, maxScroll)
    chatContent.y = CHAT_PAD + Math.min(0, innerH - contentH) + chatScroll
  }
  chat.eventMode = 'static'
  chat.on('wheel', (e) => {
    // one text line per wheel tick, regardless of the device's deltaY scale
    chatScroll -= Math.sign(e.deltaY) * CHAT_FS * 1.45
    if (chatScroll < 0) chatScroll = 0
    layoutChatContent()
    e.preventDefault()
  })
  const furnTop = (id: string) => {
    const it = furniture[id]
    return it ? it.sprite.y - it.placement.h : Infinity
  }
  const furnLeft = (id: string) => {
    const it = furniture[id]
    if (!it) return Infinity
    return it.sprite.x - (it.asset.bw / 2) * (it.placement.h / it.asset.bh)
  }
  function rebuildChatPanel() {
    const top = 14
    // flush with the whiteboard's FRAME (the tray sticks out ~18px past it),
    // which also leaves window↔chat breathing room to match the top padding
    const left = Math.min(furnLeft('board') + 18, SHELL.w - 14 - 640)
    const bottom = Math.max(
      top + CHAT_PAD * 2 + 22,
      Math.min(furnTop('board'), furnTop('shelf'), SHELL.h * 0.45) - 16,
    )
    chatW = SHELL.w - 14 - left
    chatH = bottom - top
    chat.position.set(left, top)
    chatBg
      .clear()
      .roundRect(0, 0, chatW, chatH, 10)
      .fill({ color: 0x0e1622, alpha: 0.92 })
      .roundRect(0, 0, chatW, chatH, 10)
      .stroke({ width: 2, color: 0x3a4a5e })
    chatMask
      .clear()
      .roundRect(2, CHAT_PAD, chatW - 4, chatH - CHAT_PAD * 2, 6)
      .fill(0xffffff)
    chatContent.x = CHAT_PAD
    narrLen = -1 // re-render into the new geometry
    renderNarration()
  }
  let narrLen = 0
  // the typewriter appends a blinking ▌ into the text itself — with word wrap
  // there's no single cursor x/y to park a separate glyph at
  let typer: { body: Text; full: string; i: number } | null = null
  function renderNarration() {
    if (state.log.length === narrLen) return
    narrLen = state.log.length
    typer = null // a new message finishes the previous reveal instantly
    for (const en of chatEntries) {
      en.who.destroy()
      en.body.destroy()
    }
    chatEntries.length = 0
    chat.visible = state.log.length > 0
    state.log.forEach((e, i) => {
      const last = i === state.log.length - 1
      const who = new Text({
        text: (e.who === 'user' ? 'YOU' : 'RIVET') + ' ▸ ',
        resolution: 2,
        style: chatStyle(e.who === 'user' ? 0x60a5fa : 0x34d399, true),
      })
      const style = chatStyle(0xc5d2e0)
      style.wordWrap = true
      style.wordWrapWidth = Math.max(80, chatW - CHAT_PAD * 2 - who.width)
      style.lineHeight = CHAT_FS * 1.45
      const body = new Text({ text: e.text, resolution: 2, style })
      body.x = who.width
      who.alpha = body.alpha = last ? 1 : 0.55
      chatContent.addChild(who, body)
      chatEntries.push({ who, body })
      if (last) {
        body.text = ''
        typer = { body, full: e.text, i: 0 }
      }
    })
    chatScroll = 0 // a new message pins the view back to the bottom
    layoutChatContent()
  }

  // ---- layout / resize ----
  let mobileMode = false
  let camS = 1
  const clampCamX = (x: number) => Math.min(0, Math.max(window.innerWidth - FRAME_W * camS, x))
  const UI_STACK = 48 + 26 + 8 // caption bottom + caption height + gap
  const TOP_STACK = 10 // narration lives in-room now; just breathing room
  // dock the session picker + gear onto the den window's title bar; called on
  // layout() and whenever the camera pans the frame (mobile mode)
  const pickerEl = document.getElementById('session-picker')!
  const sessionXEl = document.getElementById('session-x')!
  const gearEl = document.getElementById('gear')!
  const gearMenuEl = document.getElementById('gear-menu')!
  function positionChrome() {
    const s = frame.scale.x
    const fx = frame.position.x,
      fy = frame.position.y
    const cy = fy + (10 + (TITLEBAR - 14) / 2) * s // title-bar strip center
    pickerEl.style.left = `${fx + 190 * s}px`
    pickerEl.style.top = `${cy}px`
    sessionXEl.style.left = `${fx + 190 * s + pickerEl.offsetWidth + 8}px`
    sessionXEl.style.top = `${cy}px`
    gearEl.style.left = `${fx + (FRAME_W - 18) * s}px`
    gearEl.style.top = `${cy}px`
    gearMenuEl.style.left = `${fx + (FRAME_W - 18) * s}px`
    gearMenuEl.style.top = `${fy + (TITLEBAR + 2) * s}px`
  }
  function layout() {
    const winW = window.innerWidth,
      winH = window.innerHeight
    const ui = Math.max(0.6, Math.min(1.25, Math.min(winW, winH) / 760))
    document.documentElement.style.setProperty('--ui', String(ui))
    const top = TOP_STACK * ui
    const availH = Math.max(160, winH - top - UI_STACK * ui)
    mobileMode = winW / availH < FRAME_W / FRAME_H
    if (mobileMode) {
      camS = availH / FRAME_H
      frame.scale.set(camS)
      frame.position.set(clampCamX(winW / 2 - camS * (MARGIN + char.x)), top)
    } else {
      const pad = 12 * ui
      const s = Math.min((winW - pad * 2) / FRAME_W, availH / FRAME_H)
      frame.scale.set(s)
      frame.position.set((winW - FRAME_W * s) / 2, top + (availH - FRAME_H * s) / 2)
    }
    positionChrome()
  }
  layout()
  window.addEventListener('resize', layout)

  // ---- state: one room per session, picker chooses which drives the den ----
  const rooms: Record<string, RoomState> = {}
  const sessionNames: Record<string, string> = {}
  let selectedSession: string | null = null
  let state: RoomState = initialRoomState
  let speechTimer = 0
  let flushWs: () => void = () => {} // assigned by the live-feed branch
  function dropSession(id: string) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete rooms[id]
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete sessionNames[id]
  }
  rebuildChatPanel() // needs `state` — must run after it exists

  const picker = document.getElementById('session-picker')! as HTMLSelectElement
  const LOCAL_SESSIONS = new Set(['demo', 'preview'])
  function renderPicker() {
    const ids = Object.keys(rooms).filter((id) => !LOCAL_SESSIONS.has(id))
    picker.style.display = ids.length > 1 ? '' : 'none'
    sessionXEl.style.display = picker.style.display
    picker.innerHTML = ''
    for (const id of ids) {
      const opt = document.createElement('option')
      opt.value = id
      const name = sessionNames[id] ?? id.slice(0, 12)
      opt.textContent = rooms[id]?.ended ? `${name} (ended)` : name
      opt.selected = id === selectedSession
      picker.appendChild(opt)
    }
    positionChrome() // the ✕ hangs off the picker's rendered width
  }
  sessionXEl.addEventListener('click', () => {
    const id = picker.value || selectedSession
    if (!id) return
    void fetch(withToken(`${serverHttp}/session?session=${encodeURIComponent(id)}`), {
      method: 'DELETE',
    }).catch(() => {})
    dropSession(id)
    if (selectedSession === id) {
      selectedSession = Object.keys(rooms).filter((r) => r !== 'demo')[0] ?? null
      state = (selectedSession && rooms[selectedSession]) || initialRoomState
      narrLen = -1
      refreshAll()
    }
    renderPicker()
  })
  picker.addEventListener('change', () => {
    selectedSession = picker.value
    state = rooms[selectedSession] ?? initialRoomState
    narrLen = -1 // force the chat panel to re-render for the new room
    refreshAll()
  })

  function renderBoard() {
    boardTitle.text = state.title ? `◤ ${state.title.toUpperCase()}` : ''
    boardList.removeChildren()
    state.tasks.forEach((t, i) => {
      const row = new Container()
      const box = new Graphics()
        .rect(0, 3, 12, 12)
        .stroke({ width: 2, color: t.done ? 0x2f9e63 : 0x556575 })
      if (t.done) box.moveTo(2, 9).lineTo(5, 13).lineTo(11, 3).stroke({ width: 2, color: 0x2f9e63 })
      const label = new Text({
        text: t.label,
        resolution: 2,
        style: new TextStyle({
          fontFamily: '"Courier New", monospace',
          fontSize: 14,
          fill: t.done ? 0x8fa3b5 : 0x22303f,
        }),
      })
      label.position.set(20, 0)
      row.addChild(box, label)
      row.y = i * 24
      boardList.addChild(row)
    })
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

  function refreshAll() {
    const wantSleepNight = state.activity === 'sleeping'
    if (wantSleepNight !== sleepNight) {
      sleepNight = wantSleepNight
      void applyTimeOfDay()
    }
    renderBoard()
    renderLed()
    narrLen = -1
    renderNarration()
    renderTerm()
    caption.textContent = state.tool
      ? `${ACTIVITY_LABEL[state.activity]} · ${state.tool}`
      : ACTIVITY_LABEL[state.activity]
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

  function ingest(ev: AgentEvent) {
    const isNew = !(ev.session in rooms)
    rooms[ev.session] = reduceRoom(rooms[ev.session] ?? initialRoomState, ev)
    if (ev.name) sessionNames[ev.session] = ev.name
    if (!selectedSession) selectedSession = ev.session
    if (isNew || ev.name) renderPicker()
    if (ev.session !== selectedSession) return
    state = rooms[ev.session]
    refreshAll()
    if (ev.type === 'message.agent') {
      const msg = state.lastMessage
      speech.set(msg.length > 180 ? msg.slice(0, 177) + '…' : msg)
      speech.container.visible = true
      speechTimer = 6000
    }
  }

  // local events (demo loop, push-to-talk preview) run through the same path.
  // Editor/PTT previews act on a scratch copy of the current room — reducing
  // them into a real session's state would leave permanent lies (activity,
  // log lines) that survive after the preview ends.
  let previewReturnTo: string | null = null
  function enterPreview() {
    if (previewReturnTo !== null) return
    previewReturnTo = selectedSession ?? 'demo'
    rooms['preview'] = { ...(rooms[previewReturnTo] ?? state) }
    selectedSession = 'preview'
    state = rooms['preview']
  }
  function exitPreview() {
    if (previewReturnTo === null) return
    delete rooms['preview']
    selectedSession = previewReturnTo
    previewReturnTo = null
    state = rooms[selectedSession] ?? initialRoomState
    refreshAll()
    flushWs()
  }
  const applyLocal = (ev: AgentEventBody) => {
    const local = editorActive || pttActive
    if (local) enterPreview()
    ingest({ v: 1, session: local ? 'preview' : (selectedSession ?? 'demo'), ...ev })
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

  app.ticker.add((tk) => {
    t += tk.deltaMS
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
      chairSeq.t += tk.deltaMS
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
      const step = Math.min(dist, 0.32 * tk.deltaMS)
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
      tickZs(tk.deltaMS, asleep, hx, hy)
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
      speechTimer -= tk.deltaMS
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
    if (typer) {
      typer.i += tk.deltaMS / 16
      const n = Math.floor(typer.i)
      const blink = Math.floor(t / 400) % 2 ? '' : '▌'
      if (n >= typer.full.length) {
        typer.body.text = typer.full
        typer = null
      } else {
        typer.body.text = typer.full.slice(0, n) + blink
      }
      layoutChatContent() // wrapped height grows as it types; stay pinned
    }
    if (mobileMode) {
      const want = clampCamX(window.innerWidth / 2 - camS * (MARGIN + char.x))
      frame.position.x += (want - frame.position.x) * Math.min(1, tk.deltaMS / 350)
      positionChrome()
    }
  })

  // ---- edit mode ----
  let editorActive = false
  initEditor(
    {
      world,
      items: furniture,
      stations,
      stationPos,
      variants: Object.fromEntries(
        m.furniture.map((f) => [f.id, [f.src, ...(f.variants ?? [])].map((v) => pack.url(v))]),
      ),
      previewActivity: (a) => applyLocal({ type: 'activity', activity: a as Activity }),
      onEditingChange: (on) => {
        editorActive = on
        if (!on && !pttActive) exitPreview()
      },
      swapItemArt: async (id, src) => {
        const it = furniture[id]
        it.asset = await loadAsset(src)
        it.placement.src = src
        applyScale(it)
        if (id === 'board') refreshBoardOverlay()
        if (id === 'desk') refreshTermOverlay()
        if (id === 'board' || id === 'shelf') rebuildChatPanel()
      },
      applyScale: (id) => {
        if (furniture[id]) applyScale(furniture[id])
      },
      onLayoutChange: () => {
        refreshBoardOverlay()
        refreshTermOverlay()
        rebuildChatPanel()
      },
    },
    saved,
  )

  // ---- gear menu (EDIT toggle + push-to-talk key binding) ----
  const gear = document.getElementById('gear')!
  const gearMenu = document.getElementById('gear-menu')!
  const pttKeyBtn = document.getElementById('ptt-key')!
  gear.addEventListener('click', () => {
    gear.classList.toggle('on')
    gearMenu.classList.toggle('open')
  })
  document.getElementById('edit-btn')!.addEventListener('click', () => {
    gear.classList.remove('on')
    gearMenu.classList.remove('open')
  })

  // ---- push-to-talk: hold the bound key to talk ----
  const keyLabel = (code: string) => code.replace(/^(Key|Digit)/, '').toUpperCase()
  let pttCode = localStorage.getItem('den.pttKey') ?? 'Space' // device pref, not room state
  let pttArming = false // next keypress becomes the binding
  let pttActive = false
  pttKeyBtn.textContent = `TALK KEY: ${keyLabel(pttCode)}`
  pttKeyBtn.addEventListener('click', () => {
    pttArming = true
    pttKeyBtn.classList.add('arming')
    pttKeyBtn.textContent = 'PRESS A KEY…'
  })
  const down = () => {
    pttActive = true
    pttLive.classList.add('active')
    applyLocal({ type: 'speech.stt', active: true })
  }
  const up = () => {
    pttLive.classList.remove('active')
    // send the release while still in preview mode, THEN drop the flag —
    // otherwise the stt-false event lands in the real session's state
    applyLocal({ type: 'speech.stt', active: false })
    pttActive = false
    if (!editorActive) exitPreview()
  }
  window.addEventListener('keydown', (e) => {
    const tag = (document.activeElement as HTMLElement | null)?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
    if (pttArming) {
      pttArming = false
      pttCode = e.code
      localStorage.setItem('den.pttKey', pttCode)
      pttKeyBtn.classList.remove('arming')
      pttKeyBtn.textContent = `TALK KEY: ${keyLabel(pttCode)}`
      e.preventDefault()
      return
    }
    if (e.code !== pttCode || e.repeat) {
      if (e.code === pttCode) e.preventDefault()
      return
    }
    e.preventDefault()
    down()
  })
  window.addEventListener('keyup', (e) => {
    if (e.code === pttCode && pttActive) up()
  })
  window.addEventListener('blur', () => pttActive && up())

  // ---- debug: freeze a single activity via URL hash (#test-editing_code) ----
  const testActivity = /^#test-(\w+)$/.exec(location.hash)?.[1]
  if (testActivity) {
    applyLocal({ type: 'session.start', title: 'test' })
    applyLocal({ type: 'activity', activity: testActivity as Activity })
    return
  }

  // ---- live den-server feed, demo as fallback ----
  function startDemo() {
    selectedSession ??= 'demo'
    const start = performance.now()
    const fired = new Set<number>()
    app.ticker.add(() => {
      const el = (performance.now() - start) % DEMO_LOOP_MS
      const cycle = Math.floor((performance.now() - start) / DEMO_LOOP_MS)
      demoScript.forEach((te, i) => {
        const key = cycle * 10000 + i
        if (el >= te.at && !fired.has(key)) {
          fired.add(key)
          if (!pttActive && !editorActive) applyLocal(te.ev)
        }
      })
    })
  }

  const wantLive = location.hash !== '#demo' && location.pathname !== '/demo'
  let demoStarted = false
  const startDemoOnce = () => {
    if (!demoStarted) {
      demoStarted = true
      startDemo()
    }
  }

  if (!wantLive) {
    startDemoOnce()
  } else {
    // live feed with silent reconnect — NEVER reload the page
    let everConnected = false

    const selectFallback = () => {
      const ids = Object.keys(rooms).filter((id) => !LOCAL_SESSIONS.has(id))
      selectedSession = ids[0] ?? null
      state = selectedSession ? rooms[selectedSession] : initialRoomState
      refreshAll()
      renderPicker()
    }

    const handleWs = (raw: string) => {
      try {
        const data = JSON.parse(raw) as Record<string, unknown>
        if (data.type === 'snapshot') {
          // the snapshot is authoritative: reconcile, don't just merge —
          // sessions evicted while we were disconnected must disappear
          const snapRooms = (data.rooms ?? {}) as Record<string, RoomState>
          for (const s of (data.sessions ?? []) as { id: string; name: string }[])
            sessionNames[s.id] = s.name
          for (const id of Object.keys(rooms)) {
            if (!LOCAL_SESSIONS.has(id) && !(id in snapRooms)) dropSession(id)
          }
          Object.assign(rooms, snapRooms)
          const ids = ((data.sessions ?? []) as { id: string }[]).map((s) => s.id)
          // a real session always wins over the boot placeholder; server
          // recency order picks the replacement
          if ((!selectedSession || selectedSession === 'demo') && ids.length)
            selectedSession = ids[0]
          if (selectedSession && !rooms[selectedSession] && previewReturnTo === null) {
            selectFallback()
            return
          }
          if (selectedSession && rooms[selectedSession]) {
            state = rooms[selectedSession]
            refreshAll()
          }
          renderPicker()
        } else if (data.type === 'session.removed') {
          const id = data.session as string
          dropSession(id)
          if (id === selectedSession) selectFallback()
          else renderPicker()
        } else {
          ingest(data as unknown as AgentEvent)
        }
      } catch {
        /* ignore malformed */
      }
    }

    // while editing / push-to-talk the preview owns the stage — buffer the
    // live feed instead of dropping it, and replay on exit so no event that
    // arrived meanwhile is lost (dropped events used to desync rooms until
    // the next reconnect)
    const wsBuffer: string[] = []
    const WS_BUFFER_MAX = 2000
    flushWs = () => {
      while (wsBuffer.length) handleWs(wsBuffer.shift()!)
    }

    const connect = () => {
      let ws: WebSocket
      try {
        ws = new WebSocket(withToken(serverWs))
      } catch {
        startDemoOnce()
        return
      }
      const failTimer = setTimeout(() => {
        try {
          ws.close()
        } catch {
          /* noop */
        }
      }, 2000)
      ws.onopen = () => clearTimeout(failTimer)
      ws.onmessage = (mev) => {
        everConnected = true
        if (demoStarted) return
        if (editorActive || pttActive) {
          wsBuffer.push(mev.data as string)
          // overflow: drop the backlog and force a reconnect — the fresh
          // snapshot on reconnect re-syncs cheaper than an unbounded buffer
          if (wsBuffer.length > WS_BUFFER_MAX) {
            wsBuffer.length = 0
            ws.close()
          }
          return
        }
        handleWs(mev.data as string)
      }
      ws.onclose = () => {
        clearTimeout(failTimer)
        if (everConnected) setTimeout(connect, 3000)
        else startDemoOnce()
      }
    }
    connect()
  }
}

void boot().catch((err: unknown) => {
  // a failed boot (server down, missing pack, bad manifest) must say so —
  // a silent black canvas reads as a GPU bug and hides the real cause
  const el = document.createElement('div')
  el.style.cssText =
    'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
    'background:#141a26;color:#e8ebef;font-family:"Courier New",monospace;' +
    'font-size:16px;padding:32px;text-align:center;white-space:pre-wrap;z-index:9999'
  const msg = err instanceof Error ? err.message : String(err)
  el.textContent = `den failed to start\n\n${msg}\n\n(check that den-server is running and the pack exists)`
  document.body.appendChild(el)
  console.error('den boot failed:', err)
})
