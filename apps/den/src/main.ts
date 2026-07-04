// Boot + orchestration: Pixi app, pack/font/asset loading, ONE room instance
// (C3 turns this into a grid — one den window per session), session store
// wiring, DOM chrome (picker, gear menu, push-to-talk, edit panel), and the
// screen-space layout that scales the room's frame to the viewport.

import { Application } from 'pixi.js'
import {
  initialRoomState,
  reduceRoom,
  type Activity,
  type AgentEvent,
  type AgentEventBody,
  type RoomState,
} from '@rivetos/den-protocol'
import { configureAssets, loadAsset, pixelTexture, type PixelFrame } from './assets.js'
import { loadPack } from './pack.js'
import { loadPackFonts } from './fonts.js'
import { createEditor, loadLayout, setLayoutPack } from './editor.js'
import { createLayoutModel } from './layout-model.js'
import { createRoom, MARGIN, TITLEBAR } from './room.js'
import { createSessionStore, LOCAL_SESSIONS } from './sessions.js'
import { serverHttp } from './net.js'

async function boot() {
  const app = new Application()
  await app.init({ background: 0x141a26, resizeTo: window, antialias: false })
  document.getElementById('stage')!.appendChild(app.canvas)

  // ---- load the SpritePack: every art constant comes from the manifest ----
  const packName = new URLSearchParams(location.search).get('pack') ?? 'default'
  const pack = await loadPack(`${serverHttp}/packs/${packName}`)
  const fonts = await loadPackFonts(pack)
  const m = pack.manifest
  configureAssets({
    pxPerUnit: m.grid.pxPerUnit,
    chromaColor: m.chroma.color,
    chromaThreshold: m.chroma.threshold,
  })

  // ---- layout: pack default, overridden by the node's canonical copy ----
  // Server-first, keyed per pack; localStorage is only the offline cache.
  setLayoutPack(packName)
  const saved = await loadLayout()
  const layoutModel = createLayoutModel(m, pack, saved)

  // ---- shared art: one KeyedAsset per sprite, reused by every room ----
  const [shell, ...furnAssets] = await Promise.all([
    loadAsset(pack.url(m.shell.src), false),
    ...layoutModel.placements.map((f) => loadAsset(f.src)),
  ])
  const furnitureAssets = Object.fromEntries(
    layoutModel.placements.map((f, i) => [f.id, furnAssets[i]]),
  )

  // ---- character poses, straight from the pack manifest ----
  const CHAR_HEIGHT = m.character.height
  const poses: Record<string, PixelFrame[]> = {}
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

  // side-view chair art for the swivel, when the pack ships one
  const chairSideSrc = m.furniture.find((f) => f.id === 'chair')?.sideSrc
  const chairSideAsset = chairSideSrc
    ? await loadAsset(pack.url(chairSideSrc)).catch(() => null)
    : null

  const caption = document.getElementById('caption')!
  const pttLive = document.getElementById('ptt-live')!

  // ---- the one den window ----
  const room = createRoom({
    id: 'den',
    pack,
    fonts,
    layout: layoutModel,
    shell,
    furnitureAssets,
    chairSideAsset,
    poses,
    poseImgSize,
    captionEl: caption,
  })
  app.stage.addChild(room.root)

  // ---- layout / resize ----
  let mobileMode = false
  let camS = 1
  const clampCamX = (x: number) => Math.min(0, Math.max(window.innerWidth - room.frameW * camS, x))
  const UI_STACK = 48 + 26 + 8 // caption bottom + caption height + gap
  const TOP_STACK = 10 // narration lives in-room now; just breathing room
  // dock the session picker + gear onto the den window's title bar; called on
  // layout() and whenever the camera pans the frame (mobile mode)
  const pickerEl = document.getElementById('session-picker')!
  const sessionXEl = document.getElementById('session-x')!
  const gearEl = document.getElementById('gear')!
  const gearMenuEl = document.getElementById('gear-menu')!
  function positionChrome() {
    const s = room.root.scale.x
    const fx = room.root.position.x,
      fy = room.root.position.y
    const cy = fy + (10 + (TITLEBAR - 14) / 2) * s // title-bar strip center
    pickerEl.style.left = `${fx + 190 * s}px`
    pickerEl.style.top = `${cy}px`
    sessionXEl.style.left = `${fx + 190 * s + pickerEl.offsetWidth + 8}px`
    sessionXEl.style.top = `${cy}px`
    gearEl.style.left = `${fx + (room.frameW - 18) * s}px`
    gearEl.style.top = `${cy}px`
    gearMenuEl.style.left = `${fx + (room.frameW - 18) * s}px`
    gearMenuEl.style.top = `${fy + (TITLEBAR + 2) * s}px`
  }
  function layout() {
    const winW = window.innerWidth,
      winH = window.innerHeight
    const ui = Math.max(0.6, Math.min(1.25, Math.min(winW, winH) / 760))
    document.documentElement.style.setProperty('--ui', String(ui))
    const top = TOP_STACK * ui
    const availH = Math.max(160, winH - top - UI_STACK * ui)
    mobileMode = winW / availH < room.frameW / room.frameH
    if (mobileMode) {
      camS = availH / room.frameH
      room.root.scale.set(camS)
      room.root.position.set(clampCamX(winW / 2 - camS * (MARGIN + room.charX())), top)
    } else {
      const pad = 12 * ui
      const s = Math.min((winW - pad * 2) / room.frameW, availH / room.frameH)
      room.root.scale.set(s)
      room.root.position.set((winW - room.frameW * s) / 2, top + (availH - room.frameH * s) / 2)
    }
    positionChrome()
  }
  layout()
  window.addEventListener('resize', layout)

  // ---- session selection: the picker chooses which session drives the den ----
  let selectedSession: string | null = null
  const picker = document.getElementById('session-picker')! as HTMLSelectElement
  function renderPicker() {
    const ids = Object.keys(store.rooms).filter((id) => !LOCAL_SESSIONS.has(id))
    picker.style.display = ids.length > 1 ? '' : 'none'
    sessionXEl.style.display = picker.style.display
    picker.innerHTML = ''
    for (const id of ids) {
      const opt = document.createElement('option')
      opt.value = id
      const name = store.sessionNames[id] ?? id.slice(0, 12)
      opt.textContent = store.rooms[id]?.ended ? `${name} (ended)` : name
      opt.selected = id === selectedSession
      picker.appendChild(opt)
    }
    positionChrome() // the ✕ hangs off the picker's rendered width
  }
  const selectedState = () =>
    (selectedSession ? store.rooms[selectedSession] : undefined) ?? initialRoomState
  // push the selected session's state at the room — unless a preview owns the
  // stage right now (exitPreview re-pushes when the preview ends)
  const applySelected = () => {
    if (!previewing) room.setState(selectedState())
  }
  const selectFallback = () => {
    const ids = Object.keys(store.rooms).filter((id) => !LOCAL_SESSIONS.has(id))
    selectedSession = ids[0] ?? null
    applySelected()
    renderPicker()
  }
  sessionXEl.addEventListener('click', () => {
    const id = picker.value || selectedSession
    if (!id) return
    store.delete(id)
    if (selectedSession === id) {
      selectedSession = Object.keys(store.rooms).filter((r) => r !== 'demo')[0] ?? null
      applySelected()
    }
    renderPicker()
  })
  picker.addEventListener('change', () => {
    selectedSession = picker.value
    applySelected()
  })

  // ---- preview: local events act on a scratch copy of the current room ----
  // Reducing editor/PTT preview events into a real session's state would
  // leave permanent lies (activity, log lines) that survive after the
  // preview ends. While a preview owns the stage the store keeps reducing
  // live events into its map — nothing is buffered or lost — and exiting
  // simply re-pushes the store's current state at the room.
  let previewing = false
  let previewState: RoomState = initialRoomState
  function enterPreview() {
    if (previewing) return
    previewing = true
    previewState = { ...selectedState() }
  }
  function exitPreview() {
    if (!previewing) return
    previewing = false
    // the selected session may have been evicted while the preview owned the
    // stage — fall back exactly as the live handler would have
    if (selectedSession && !LOCAL_SESSIONS.has(selectedSession) && !store.rooms[selectedSession])
      selectFallback()
    else room.setState(selectedState())
  }
  // local events (demo loop, editor pose preview, push-to-talk) run through
  // the same reducer as live ones
  const applyLocal = (ev: AgentEventBody) => {
    const local = editorActive || pttActive
    if (local) {
      enterPreview()
      const full: AgentEvent = { v: 1, session: 'preview', ...ev }
      previewState = reduceRoom(previewState, full)
      room.setState(previewState)
      room.onEvent(full)
    } else {
      store.ingest({ v: 1, session: selectedSession ?? 'demo', ...ev })
    }
  }

  // ---- session store: live den-server feed, demo as fallback ----
  const wantLive = location.hash !== '#demo' && location.pathname !== '/demo'
  const store = createSessionStore({
    wantLive,
    addTick: (fn) => app.ticker.add(fn),
    onSessionUpsert: (id, s, pickerDirty) => {
      if (!selectedSession) selectedSession = id
      if (pickerDirty) renderPicker()
      if (id !== selectedSession || previewing) return
      room.setState(s)
    },
    onEvent: (ev) => {
      if (ev.session !== selectedSession || previewing) return
      room.onEvent(ev)
    },
    onSessionRemoved: (id) => {
      if (id === selectedSession) selectFallback()
      else renderPicker()
    },
    onSnapshot: (ids) => {
      // a real session always wins over the boot placeholder; server
      // recency order picks the replacement
      if ((!selectedSession || selectedSession === 'demo') && ids.length) selectedSession = ids[0]
      if (selectedSession && !store.rooms[selectedSession] && !previewing) {
        selectFallback()
        return
      }
      if (selectedSession && store.rooms[selectedSession]) applySelected()
      renderPicker()
    },
    onDemoStart: () => {
      selectedSession ??= 'demo'
    },
    onDemoEvent: (ev) => {
      if (!pttActive && !editorActive) applyLocal(ev)
    },
  })

  app.ticker.add((tk) => {
    room.update(tk.deltaMS)
    if (mobileMode) {
      const want = clampCamX(window.innerWidth / 2 - camS * (MARGIN + room.charX()))
      room.root.position.x += (want - room.root.position.x) * Math.min(1, tk.deltaMS / 350)
      positionChrome()
    }
  })

  // ---- edit mode ----
  let editorActive = false
  const editor = createEditor({
    btn: document.getElementById('edit-btn')!,
    panel: document.getElementById('edit-panel')!,
    chips: document.getElementById('edit-chips')!,
    thumbs: document.getElementById('edit-thumbs')!,
  })
  editor.setTarget(
    {
      ...room.editorHooks(),
      previewActivity: (a) => applyLocal({ type: 'activity', activity: a as Activity }),
      onEditingChange: (on) => {
        editorActive = on
        if (!on && !pttActive) exitPreview()
      },
      onLayoutChange: () => layoutModel.notifyChange(),
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
  store.start()
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
