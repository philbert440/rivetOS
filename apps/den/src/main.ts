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
import {
  initEditor,
  loadSaved,
  pushLayout,
  fetchServerLayout,
  type RuntimePlacement,
} from './editor.js'
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

  // ---- layout: pack default, overridden by the saved/server copy ----
  const local = loadSaved()
  const saved = local ?? (await fetchServerLayout())
  if (local) pushLayout(local)
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
  await Promise.all(
    Object.entries(m.character.poses).map(async ([name, pose]) => {
      const h = pose.height ?? CHAR_HEIGHT
      poses[name] = await Promise.all(
        pose.frames.map(async (f) => pixelTexture(await loadAsset(pack.url(f)), h)),
      )
    }),
  )
  const poseHeight = (name: string): number => m.character.poses[name]?.height ?? CHAR_HEIGHT
  function poseFrame(name: string, t: number): number {
    const frames = poses[name] ?? poses.idle
    if (frames.length < 2) return 0
    const frameMs = m.character.poses[name]?.frameMs ?? 400
    if (frameMs === 0) return t % 3400 < 160 ? 1 : 0 // static pose: occasional blink
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
  function applyScale(it: { sprite: Sprite; asset: KeyedAsset; placement: RuntimePlacement }) {
    it.sprite.texture = pixelTexture(it.asset, it.placement.h).texture
    it.sprite.scale.set(it.placement.flip ? -PX : PX, PX)
    // snap to the global pixel grid so all sprites share one raster
    it.sprite.position.set(
      Math.round(it.placement.x / PX) * PX,
      Math.round(it.placement.y / PX) * PX,
    )
    it.sprite.zIndex = it.placement.y
  }
  placements.forEach((f, i) => {
    const a = furnAssets[i]
    const sp = new Sprite() // texture set by applyScale below
    sp.anchor.set(0.5, 1)
    world.addChild(sp)
    furniture[f.id] = { sprite: sp, asset: a, placement: f }
    applyScale(furniture[f.id])
  })

  // functional rects live on the pack furniture entries, in ORIGINAL image
  // coordinates of their default art — they only apply while that art is up
  const furnSpec = (id: string) => m.furniture.find((f) => f.id === id)

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
  const termCols = 24
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
    termText.scale.set(tw / (termCols * 5.5))
  }
  function renderTerm() {
    termText.text = state.term
      .map((l) => (l.length > termCols ? l.slice(0, termCols - 1) + '…' : l))
      .join('\n')
  }
  refreshTermOverlay()

  // ---- character ----
  const char = new Container()
  const shadow = new Graphics().ellipse(0, 0, 30, 8).fill({ color: 0x000000, alpha: 0.28 })
  const charSprite = new Sprite(poses.idle[0].texture)
  charSprite.anchor.set(0.5, 1)
  char.addChild(shadow, charSprite)
  world.addChild(char)
  let poseName = 'idle'
  let poseFlip = false
  let squash = 1 // x-squash used to fake the chair swivel rotation
  function setPose(name: string, flip = false) {
    poseName = name
    poseFlip = flip
  }
  function renderPose(t: number) {
    const frames = poses[poseName] ?? poses.idle
    charSprite.texture = frames[Math.min(poseFrame(poseName, t), frames.length - 1)].texture
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
  const speech = bubble(280, 0x34d399)
  thought.container.zIndex = 9000
  speech.container.zIndex = 9001
  world.addChild(thought.container, speech.container)

  const caption = document.getElementById('caption')!
  const ptt = document.getElementById('ptt')! as HTMLButtonElement

  // ---- RPG narration panel ----
  const narration = document.getElementById('narration')!
  let narrLen = 0
  let typer: { el: HTMLElement; cur: HTMLElement; full: string; i: number } | null = null
  function renderNarration() {
    if (state.log.length === narrLen) return
    narrLen = state.log.length
    typer = null // a new message finishes the previous reveal instantly
    narration.innerHTML = ''
    const entries = state.log.slice(-3)
    entries.forEach((e, i) => {
      const last = i === entries.length - 1
      const line = document.createElement('div')
      line.className = 'line' + (last ? '' : ' old')
      const who = document.createElement('span')
      who.className = e.who === 'user' ? 'who-user' : 'who-agent'
      who.textContent = (e.who === 'user' ? 'YOU' : 'RIVET') + ' ▸ '
      const body = document.createElement('span')
      line.append(who, body)
      narration.appendChild(line)
      if (last) {
        const cur = document.createElement('span')
        cur.className = 'cursor'
        cur.textContent = '▌'
        line.appendChild(cur)
        typer = { el: body, cur, full: e.text, i: 0 }
      } else {
        body.textContent = e.text
      }
    })
  }

  // ---- layout / resize ----
  let mobileMode = false
  let camS = 1
  const clampCamX = (x: number) => Math.min(0, Math.max(window.innerWidth - FRAME_W * camS, x))
  const UI_STACK = 20 + 84 + 10 + 26 + 8
  const TOP_STACK = 10 + 66 + 8
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
  }
  layout()
  window.addEventListener('resize', layout)

  // ---- state: one room per session, picker chooses which drives the den ----
  const rooms: Record<string, RoomState> = {}
  const sessionNames: Record<string, string> = {}
  let selectedSession: string | null = null
  let state: RoomState = initialRoomState
  let speechTimer = 0

  const picker = document.getElementById('session-picker')! as HTMLSelectElement
  function renderPicker() {
    const ids = Object.keys(rooms).filter((id) => id !== 'demo')
    picker.style.display = ids.length > 1 ? '' : 'none'
    picker.innerHTML = ''
    for (const id of ids) {
      const opt = document.createElement('option')
      opt.value = id
      opt.textContent = sessionNames[id] ?? id.slice(0, 12)
      opt.selected = id === selectedSession
      picker.appendChild(opt)
    }
  }
  picker.addEventListener('change', () => {
    selectedSession = picker.value
    state = rooms[selectedSession] ?? initialRoomState
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
    renderBoard()
    renderLed()
    narrLen = -1
    renderNarration()
    renderTerm()
    caption.textContent = state.tool
      ? `${ACTIVITY_LABEL[state.activity]} · ${state.tool}`
      : ACTIVITY_LABEL[state.activity]
    thought.container.visible = !!state.thought
    if (state.thought) thought.set(state.thought)
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

  // local events (demo loop, push-to-talk preview) run through the same path
  const applyLocal = (ev: AgentEventBody) =>
    ingest({ v: 1, session: selectedSession ?? 'demo', ...ev })

  // ---- movement + animation ----
  function stationPos(s: Station): { x: number; y: number } {
    let x = s.x ?? 520,
      y = s.y ?? 745
    if (s.furn && furniture[s.furn]) {
      const p = furniture[s.furn].placement
      x = p.x + (s.dx ?? 0)
      y = p.y + (s.dy ?? 0)
    }
    // stations must stay on the visible floor even when their anchor furniture
    // bleeds off-frame (e.g. the bed) — otherwise the robot walks off-screen
    return {
      x: Math.min(SHELL.w - 40, Math.max(40, x)),
      y: Math.min(SHELL.h - 12, Math.max(SHELL.h * 0.755, y)),
    }
  }
  let t = 0
  type ChairPhase = 'hop_on' | 'swivel_in' | 'type' | 'swivel_out' | 'hop_off'
  let chairSeq: { phase: ChairPhase; t: number } | null = null
  const HOP_MS = 340,
    SWIVEL_MS = 320
  const lerp = (a: number, b: number, p: number) => a + (b - a) * p

  app.ticker.add((tk) => {
    t += tk.deltaMS
    const station = stations[state.activity] ?? stations.idle
    const targetPose = resolvePose(m, state.activity, state.tool)
    // seat choreography kicks in when the activity's station is the chair
    const wantsChair = station.furn === 'chair' && !!furniture['chair']
    const tp = stationPos(station)
    const dx = tp.x - char.x,
      dy = tp.y - char.y
    const dist = Math.hypot(dx, dy)
    const chairIt = furniture['chair']
    let behindChair = false // seated = tucked in behind the chair back

    if (chairSeq && chairIt) {
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
      // working poses sit still except for their frame animation; others breathe
      const still = m.character.poses[targetPose]?.frameMs !== 0 && targetPose !== 'idle'
      charSprite.y = still ? 0 : Math.sin(t / 550) * 3
    }
    renderPose(t)
    tickZs(
      tk.deltaMS,
      state.activity === 'sleeping' && dist <= 4 && !chairSeq,
      char.x - 62,
      char.y - poseHeight('sleep') - 12,
    )
    char.zIndex = behindChair && chairIt ? chairIt.placement.y - 1 : 8000
    thought.container.position.set(char.x + 34, char.y - CHAR_HEIGHT - 16)
    speech.container.position.set(char.x + 34, char.y - CHAR_HEIGHT - 16)
    if (speechTimer > 0) {
      speechTimer -= tk.deltaMS
      if (speechTimer <= 0) speech.container.visible = false
    }
    if (typer) {
      typer.i += tk.deltaMS / 16
      const n = Math.floor(typer.i)
      if (n >= typer.full.length) {
        typer.el.textContent = typer.full
        typer.cur.remove()
        typer = null
      } else {
        typer.el.textContent = typer.full.slice(0, n)
      }
    }
    if (mobileMode) {
      const want = clampCamX(window.innerWidth / 2 - camS * (MARGIN + char.x))
      frame.position.x += (want - frame.position.x) * Math.min(1, tk.deltaMS / 350)
    }
  })

  // ---- edit mode ----
  let editorActive = false
  initEditor({
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
    },
    swapItemArt: async (id, src) => {
      const it = furniture[id]
      it.asset = await loadAsset(src)
      it.placement.src = src
      applyScale(it)
      if (id === 'board') refreshBoardOverlay()
      if (id === 'desk') refreshTermOverlay()
    },
    applyScale: (id) => {
      if (furniture[id]) applyScale(furniture[id])
    },
    onLayoutChange: () => {
      refreshBoardOverlay()
      refreshTermOverlay()
    },
  })

  // ---- push-to-talk ----
  const down = () => {
    ptt.classList.add('active')
    applyLocal({ type: 'speech.stt', active: true })
  }
  const up = () => {
    ptt.classList.remove('active')
    applyLocal({ type: 'speech.stt', active: false })
  }
  ptt.addEventListener('pointerdown', down)
  ptt.addEventListener('pointerup', up)
  ptt.addEventListener('pointerleave', () => ptt.classList.contains('active') && up())

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
          if (!ptt.classList.contains('active') && !editorActive) applyLocal(te.ev)
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
        // pause the live feed while editing so spot previews aren't overridden
        if (demoStarted || editorActive || ptt.classList.contains('active')) return
        try {
          const data = JSON.parse(mev.data as string) as Record<string, unknown>
          if (data.type === 'snapshot') {
            // seed every room + the session registry from the server state
            for (const s of (data.sessions ?? []) as { id: string; name: string }[])
              sessionNames[s.id] = s.name
            for (const [id, room] of Object.entries(
              (data.rooms ?? {}) as Record<string, RoomState>,
            )) {
              rooms[id] = room
            }
            const ids = Object.keys(rooms).filter((id) => id !== 'demo')
            // a real session always wins over the boot placeholder
            if ((!selectedSession || selectedSession === 'demo') && ids.length)
              selectedSession = ids[0]
            if (selectedSession && rooms[selectedSession]) {
              state = rooms[selectedSession]
              refreshAll()
            }
            renderPicker()
          } else {
            ingest(data as unknown as AgentEvent)
          }
        } catch {
          /* ignore malformed */
        }
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

void boot()
