// Boot + orchestration: Pixi app, pack/font/asset loading, the window grid
// (one complete den window per active session, via the WindowManager),
// session store wiring, and the global DOM chrome (header strip with + NEW
// and the gear menu, push-to-talk, edit panel, mobile tab strip, per-window
// terminal drawers). Per-window chrome (title, subtitle, LED, ✕, `>_`) lives
// in room.ts; grid layout + focus live in windows.ts; the drawer itself in
// drawer.ts.

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
import { createSessionStore, IDLE_SESSION, LOCAL_SESSIONS } from './sessions.js'
import { createWindowManager } from './windows.js'
import { createDrawer, type Drawer } from './drawer.js'
import { createHeader } from './header.js'
import { renderMesh } from './mesh.js'
import { serverHttp, withToken } from './net.js'

async function boot() {
  // /mesh is a plain DOM route — no Pixi, no packs, no session feed. Every
  // other path (incl. a direct node visit) is the session grid, as always.
  if (location.pathname === '/mesh') return renderMesh(document.body)

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

  const pttLive = document.getElementById('ptt-live')!

  // ---- edit mode (target follows window focus — wired in onFocusChange) ----
  let editorActive = false
  const editor = createEditor({
    btn: document.getElementById('edit-btn')!,
    panel: document.getElementById('edit-panel')!,
    chips: document.getElementById('edit-chips')!,
    thumbs: document.getElementById('edit-thumbs')!,
  })

  // ---- the window grid: one complete den window per session ----
  const IDLE_STATE: RoomState = { ...initialRoomState, activity: 'sleeping' }
  const stateFor = (id: string): RoomState =>
    id === IDLE_SESSION ? IDLE_STATE : (store.rooms[id] ?? initialRoomState)
  const nameFor = (id: string): string =>
    id === IDLE_SESSION ? '' : (store.sessionNames[id] ?? id.slice(0, 12))

  function closeSession(id: string) {
    // exactly the old #session-x semantics, relocated per-window:
    // DELETE /session server-side, drop locally, and reflow the grid
    // (den-server also kills any PTY still linked to the session)
    dropDrawer(id)
    store.delete(id)
    wm.remove(id)
    syncIdleWindow()
  }

  const wm = createWindowManager({
    stage: app.stage,
    frameW: m.shell.w + MARGIN * 2,
    frameH: m.shell.h + MARGIN * 2 + TITLEBAR,
    isLocal: (id) => LOCAL_SESSIONS.has(id),
    tabStrip: document.getElementById('tab-strip')!,
    getName: (id) => nameFor(id) || id,
    makeRoom: (id) =>
      createRoom({
        id,
        pack,
        fonts,
        layout: layoutModel,
        shell,
        furnitureAssets,
        chairSideAsset,
        poses,
        poseImgSize,
        onClose: LOCAL_SESSIONS.has(id) ? undefined : () => closeSession(id),
      }),
    onFocusChange: (id) => {
      // never hot-swap the editor mid-edit: exit EDIT first (which also ends
      // its preview via onEditingChange), then re-point at the new window
      if (editor.isActive()) editor.setEditing(false)
      if (previewing) exitPreview() // a held PTT re-enters on the new focus
      editor.detach()
      const room = id ? wm.get(id) : undefined
      if (!room) return
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
    },
  })
  // furniture edits move the drawer footprint (room.drawerRect) — re-derive
  // every anchored DOM rect, same as the in-room board overlay resync
  layoutModel.onChange(() => wm.syncDom())

  // zero sessions → one local window with the character asleep in bed; the
  // first real session replaces it (and it returns when the last one closes)
  function syncIdleWindow() {
    const hasReal = wm.ids().some((id) => id !== IDLE_SESSION)
    if (!hasReal && !wm.has(IDLE_SESSION)) {
      const room = wm.ensure(IDLE_SESSION)
      room.setTitle('', false)
      room.setState(IDLE_STATE)
    } else if (hasReal && wm.has(IDLE_SESSION)) {
      wm.remove(IDLE_SESSION)
    }
    syncWakeChip()
  }

  // wake affordance on the sleeping idle window: a chip that spawns the
  // server's default harness (only rendered when terminals are enabled)
  let wakeChip: { el: HTMLElement; off: () => void } | null = null
  function syncWakeChip() {
    const idleRoom = wm.get(IDLE_SESSION)
    const want = !!idleRoom && header.enabled()
    if (want && !wakeChip) {
      const el = document.createElement('button')
      el.className = 'wake-chip'
      el.textContent = '>_ start a session'
      el.title = 'spawn the default harness'
      el.addEventListener('click', () => header.spawnDefault())
      document.body.appendChild(el)
      const off = wm.addAnchor({
        el,
        room: idleRoom,
        x: MARGIN + m.shell.w / 2,
        y: TITLEBAR + MARGIN + m.shell.h * 0.72, // over the floor, clear of the whiteboard
      })
      wakeChip = { el, off }
    } else if (!want && wakeChip) {
      wakeChip.off()
      wakeChip.el.remove()
      wakeChip = null
    }
  }

  // ---- preview: local events act on a scratch copy of the FOCUSED room ----
  // Reducing editor/PTT preview events into a real session's state would
  // leave permanent lies (activity, log lines) that survive after the
  // preview ends. While a preview owns a window the store keeps reducing
  // live events into its map — nothing is buffered or lost — and exiting
  // simply re-pushes the store's current state at the room.
  let previewing = false
  let previewRoomId: string | null = null
  let previewState: RoomState = initialRoomState
  function enterPreview() {
    if (previewing) return
    const id = wm.focusedId()
    if (!id) return
    previewing = true
    previewRoomId = id
    previewState = { ...stateFor(id) }
  }
  function exitPreview() {
    if (!previewing) return
    previewing = false
    const id = previewRoomId
    previewRoomId = null
    // the window may have been closed/evicted while the preview owned it
    if (id) wm.get(id)?.setState(stateFor(id))
  }
  // local events (demo loop, editor pose preview, push-to-talk) run through
  // the same reducer as live ones
  function applyLocal(ev: AgentEventBody) {
    if (editorActive || pttActive) {
      enterPreview()
      if (!previewRoomId) return
      const full: AgentEvent = { v: 1, session: 'preview', ...ev }
      previewState = reduceRoom(previewState, full)
      const room = wm.get(previewRoomId)
      room?.setState(previewState)
      room?.onEvent(full)
    } else {
      store.ingest({ v: 1, session: 'demo', ...ev })
    }
  }

  // ---- session store: live den-server feed (demo only on explicit #demo) ----
  const wantLive = location.hash !== '#demo' && location.pathname !== '/demo'
  const store = createSessionStore({
    wantLive,
    addTick: (fn) => app.ticker.add(fn),
    onSessionUpsert: (id, s) => {
      const room = wm.ensure(id)
      room.setTitle(nameFor(id), s.ended) // late-arriving names update here too
      if (!(previewing && id === previewRoomId)) room.setState(s)
      syncTermChrome(id)
      adoptSpawn(id)
      syncIdleWindow()
    },
    onEvent: (ev) => {
      if (previewing && ev.session === previewRoomId) return
      wm.get(ev.session)?.onEvent(ev)
    },
    onSessionRemoved: (id) => {
      dropDrawer(id)
      wm.remove(id)
      syncIdleWindow()
    },
    onSnapshot: () => {
      // the snapshot is authoritative on EVERY reconnect: create missing
      // windows, destroy evicted ones — local windows (idle/demo) survive
      wm.reconcile(new Set(Object.keys(store.rooms)))
      for (const [id, s] of Object.entries(store.rooms)) {
        if (LOCAL_SESSIONS.has(id)) continue
        const room = wm.ensure(id)
        room.setTitle(nameFor(id), s.ended)
        if (!(previewing && id === previewRoomId)) room.setState(s)
        syncTermChrome(id)
      }
      // drawers whose windows the reconcile destroyed
      for (const id of [...drawers.keys()]) if (!wm.has(id)) dropDrawer(id)
      syncIdleWindow()
    },
    onPty: (id) => {
      // PTY link learned late (throttled /sessions refresh or a + NEW spawn)
      syncTermChrome(id)
      adoptSpawn(id)
    },
    onDemoEvent: (ev) => {
      if (!pttActive && !editorActive) applyLocal(ev)
    },
  })

  // ---- per-window terminal drawers (sessions with a linked PTY only) ----
  const drawers = new Map<string, Drawer>()
  function syncTermChrome(id: string) {
    if (LOCAL_SESSIONS.has(id)) return
    const room = wm.get(id)
    if (!room) return
    const ptyId = store.sessionPtys[id]
    if (ptyId && !drawers.has(id)) {
      const drawer = createDrawer(room, id, {
        wm,
        onOpenChange: (open) => room.setTermOpen(open),
      })
      drawers.set(id, drawer)
      room.setTerm({
        onToggle: () => drawer.toggle(),
        onKill: () => {
          // end the PTY explicitly, then leave through the normal dismiss
          // (DELETE /session) so the window goes away for every viewer —
          // session eviction alone would keep it around for the evict TTL
          const pid = store.sessionPtys[id]
          if (pid)
            void fetch(withToken(`${serverHttp}/term?id=${encodeURIComponent(pid)}`), {
              method: 'DELETE',
            }).catch(() => {})
          closeSession(id)
        },
      })
    } else if (!ptyId && drawers.has(id)) {
      // the PTY vanished server-side (reaped) — back to a plain observer
      dropDrawer(id)
      room.setTerm(null)
    }
  }
  function dropDrawer(id: string) {
    const d = drawers.get(id)
    if (!d) return
    d.destroy()
    drawers.delete(id)
  }

  // ---- global header strip: [+ NEW ▾][⚙] ----
  // + NEW spawns a harness via POST /term; when the harness's den session
  // shows up on the event stream we focus its window and drop its drawer
  // open. Correlation is by denSession, with a 15s expiry.
  const SPAWN_CORRELATE_MS = 15_000
  const pendingSpawn = new Map<string, ReturnType<typeof setTimeout>>()
  function adoptSpawn(id: string) {
    const timer = pendingSpawn.get(id)
    if (timer === undefined) return
    clearTimeout(timer)
    pendingSpawn.delete(id)
    wm.focus(id)
    drawers.get(id)?.setOpen(true)
  }
  const header = createHeader({
    onSpawned: (denSession, ptyId) => {
      store.setPty(denSession, ptyId)
      const old = pendingSpawn.get(denSession)
      if (old) clearTimeout(old)
      pendingSpawn.set(
        denSession,
        setTimeout(() => pendingSpawn.delete(denSession), SPAWN_CORRELATE_MS),
      )
      if (wm.has(denSession)) adoptSpawn(denSession) // window already up
    },
  })
  void header.ready.then(() => syncWakeChip()) // idle chip needs enabled()

  syncIdleWindow() // boot state: one sleeping window until the feed speaks

  // single ticker: every visible room animates its own session
  app.ticker.add((tk) => wm.update(tk.deltaMS))

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

  // ---- push-to-talk: hold the bound key to talk (previews the focused room) ----
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

  // headless-verification / debugging handle (?debug)
  if (new URLSearchParams(location.search).has('debug'))
    Object.assign(window, { __den: { wm, store, drawers, header } })

  // ---- debug: freeze a single activity via URL hash (#test-editing_code) ----
  const testActivity = /^#test-(\w+)$/.exec(location.hash)?.[1]
  if (testActivity) {
    applyLocal({ type: 'session.start', title: 'test' })
    applyLocal({ type: 'activity', activity: testActivity as Activity })
    return
  }

  // ---- live den-server feed (or the #demo loop) ----
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
