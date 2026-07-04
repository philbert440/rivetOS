// Global header strip (top right): [+ NEW ▾][MESH][⚙]. The gear button/menu
// moved in here from their old fixed cluster; MESH navigates to the /mesh
// overview route (mesh.ts); + NEW spawns harness sessions through
// den-server's opt-in terminal API:
//
//   /term/config (once at boot) → enabled? roster labels for the ▾ dropdown
//   + NEW                       → POST /term  (no body = server default)
//   ▾ menu entry                → POST /term {command:<roster key>}
//
// When terminals are disabled (older server, RIVETOS_DEN_TERM unset, or the
// security gate tripped) the + NEW cluster never renders — zero UI change.
// The POST response's {denSession, id} pair goes to onSpawned so main.ts can
// pre-register the PTY link and auto-open the drawer when the session's
// window shows up on the event stream.

import { serverHttp, viewerHref, withToken } from './net.js'

export interface Header {
  /** Resolves once /term/config answered — true when terminals are usable. */
  ready: Promise<boolean>
  enabled(): boolean
  /** POST /term for the server's default roster command (the + NEW click,
   *  and the sleeping idle window's wake affordance). */
  spawnDefault(): void
}

export interface HeaderOpts {
  /** A PTY spawn succeeded — correlate the den session that will appear. */
  onSpawned(denSession: string, ptyId: string): void
}

interface TermConfig {
  enabled: boolean
  default: string
  commands: { id: string; label: string; room: boolean }[]
}

export function createHeader(opts: HeaderOpts): Header {
  const wrap = document.getElementById('new-wrap')!
  const newBtn = document.getElementById('new-session')!
  const menuBtn = document.getElementById('new-menu-btn')!
  const menu = document.getElementById('new-menu')!
  const gear = document.getElementById('gear')!
  const gearMenu = document.getElementById('gear-menu')!

  // [MESH] → the mesh overview route. Always rendered (a node with no mesh
  // file just gets the friendly empty state); ?server=/?token= ride along.
  document.getElementById('mesh-btn')!.addEventListener('click', () => {
    location.href = viewerHref('/mesh')
  })

  let enabled = false

  function spawn(command?: string) {
    void fetch(withToken(`${serverHttp}/term`), {
      method: 'POST',
      ...(command
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command }) }
        : {}),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`POST /term → ${r.status}`)
        return (await r.json()) as { id: string; denSession: string }
      })
      .then((pty) => opts.onSpawned(pty.denSession, pty.id))
      .catch((e: unknown) => console.warn('[den] terminal spawn failed:', e))
  }

  const closeMenu = () => menu.classList.remove('open')
  newBtn.addEventListener('click', () => {
    closeMenu()
    spawn()
  })
  menuBtn.addEventListener('click', () => {
    // one dropdown at a time — mirror the gear menu's behavior
    gear.classList.remove('on')
    gearMenu.classList.remove('open')
    menu.classList.toggle('open')
  })
  gear.addEventListener('click', closeMenu)

  const ready = (async () => {
    try {
      const r = await fetch(withToken(`${serverHttp}/term/config`))
      if (!r.ok) return false
      const cfg = (await r.json()) as TermConfig
      if (!cfg.enabled || !Array.isArray(cfg.commands) || cfg.commands.length === 0) return false
      menu.replaceChildren(
        ...cfg.commands.map((c) => {
          const b = document.createElement('button')
          b.textContent = c.id === cfg.default ? `${c.label} ★` : c.label
          b.title = c.id
          b.addEventListener('click', () => {
            closeMenu()
            spawn(c.id)
          })
          return b
        }),
      )
      enabled = true
      wrap.classList.add('on')
      // widen the mobile tab strip's right reserve to clear the wider strip
      document.body.classList.add('term-on')
      return true
    } catch {
      return false // unreachable server — the live feed will complain
    }
  })()

  return {
    ready,
    enabled: () => enabled,
    spawnDefault: () => {
      if (enabled) spawn()
    },
  }
}
