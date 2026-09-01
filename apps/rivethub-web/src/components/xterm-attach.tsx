import { useEffect, useRef, useState, type JSX } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import { SearchAddon } from '@xterm/addon-search'
import { ImageAddon } from '@xterm/addon-image'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import type { TermExitFrame, TermHelloFrame } from '@rivetos/types'
import { useConnection } from '../stores/connection.js'
import { resolvedThemeOf, useResolvedTheme, useTheme } from '../stores/theme.js'
import { resolveXtermTheme, useTerminalSettings } from '../stores/terminal-settings.js'
import { gatewayFor } from '../lib/agent-gateway.js'
import { isOscColorReport, stripOscColorQueries } from '../lib/osc-filter.js'
import { copyTextToClipboard, readTextFromClipboard } from '../lib/clipboard.js'
import { rivetShell } from '../lib/shell-bridge.js'
import { openExternal } from '../lib/open-external.js'

/**
 * Attach an xterm to a PTY over WS /api/terminal/ws. Framing per den-server
 * term/ws.ts: hello JSON, scrollback replay, live bytes, exit frame. Detach
 * on unmount — never kill; the manager's TTL owns the PTY (reattach replays).
 *
 * Two effects: the terminal instance lives per PTY; the socket lives per
 * PTY × transportEpoch, so enrolling mid-run (identity pipe appears, epoch
 * bumps) reattaches this pane onto the new transport instead of stranding it
 * on a dead socket. Reattach resets the terminal first — the server replays
 * scrollback, and appending a replay to the existing buffer doubles it.
 *
 * Color-query filtering (osc-filter.ts): harnesses emit OSC 11? on startup;
 * xterm answers with rgb:… (the live theme bg) via onData → PTY
 * stdin → visible garbage `]11;rgb:…` in the TUI. Strip queries on write and
 * drop report replies on onData.
 *
 * Settings (stores/terminal-settings.ts): the terminal is constructed from
 * the store and a third effect re-options it live on any settings/theme
 * change (font, cursor, scrollback, palette) — never a socket reattach.
 * Renderer switching swaps the WebGL addon in place; on addon throw or GPU
 * context loss we dispose it and carry on with the DOM renderer, flipping
 * the store's non-persisted `rendererActual` so Settings can say so.
 *
 * Addons: fit + web-links (as before), unicode11 (grapheme widths for modern
 * emoji/CJK), search (Ctrl/Cmd+Shift+F find bar), image (sixel + iTerm2 IIP,
 * capped), webgl (optional), and clipboard for OSC 52 — except in the
 * Electron shell, where navigator.clipboard may not exist (non-secure
 * origin), so OSC 52 writes go through our own handler onto the app
 * clipboard chain (rivetShell IPC).
 */

/** OSC 52 payload is `<selection>;<base64>` (`?` = clipboard query — refuse
 *  it; answering would leak clipboard contents to whatever holds the PTY).
 *  Returns the decoded write, or undefined to ignore the sequence. */
function decodeOsc52Text(data: string): string | undefined {
  const sep = data.indexOf(';')
  if (sep === -1) return undefined
  const payload = data.slice(sep + 1)
  if (!payload || payload === '?') return undefined
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)))
  } catch {
    return undefined
  }
}

/**
 * WebGL renderer with DOM fallback. The constructor or activate() throws
 * where GL is unavailable/blocked; onContextLoss fires when the GPU context
 * dies mid-session — the addon must then be disposed, and xterm carries on
 * with the DOM renderer. Both paths flip the store's `rendererActual` to
 * 'canvas' (the preference stays 'webgl'; the next pane tries again).
 */
function mountWebgl(
  term: Terminal,
  webglRef: { current: WebglAddon | undefined },
): WebglAddon | undefined {
  try {
    const addon = new WebglAddon()
    addon.onContextLoss(() => {
      if (webglRef.current !== addon) return // already swapped out
      webglRef.current = undefined
      addon.dispose()
      useTerminalSettings.getState().setRendererActual('canvas')
    })
    term.loadAddon(addon)
    return addon
  } catch {
    return undefined
  }
}

export function XtermAttach(props: {
  ptyId: string
  /** Node the PTY lives on when it is not the globally connected one —
   *  cross-node sessions attach over that node's own (pipe-routed) gateway. */
  base?: string
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | undefined>(undefined)
  const fitRef = useRef<FitAddon | undefined>(undefined)
  const searchRef = useRef<SearchAddon | undefined>(undefined)
  const webglRef = useRef<WebglAddon | undefined>(undefined)
  // Shared with the socket effect: it silences copy-on-select around
  // term.reset() (reset can fire onSelectionChange) and clears any pending
  // debounce so a pre-rebind selection can't copy mid-rebind.
  const selTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const selSuppressRef = useRef(false)
  const bellTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const transportEpoch = useConnection((s) => s.transportEpoch)
  const resolvedTheme = useResolvedTheme()
  const settings = useTerminalSettings()
  const [status, setStatus] = useState<'connecting' | 'attached' | 'exited' | 'closed'>(
    'connecting',
  )
  // Find bar state. findOpenRef mirrors it for the custom key handler, which
  // is registered once at terminal creation and must see the live value.
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const findOpenRef = useRef(false)

  const openFind = (): void => {
    findOpenRef.current = true
    setFindOpen(true)
  }
  const closeFind = (): void => {
    findOpenRef.current = false
    setFindOpen(false)
    setFindQuery('')
    searchRef.current?.clearDecorations()
    termRef.current?.focus()
  }
  const findNext = (): void => {
    if (findQuery) searchRef.current?.findNext(findQuery)
  }
  const findPrev = (): void => {
    if (findQuery) searchRef.current?.findPrevious(findQuery)
  }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const initial = useTerminalSettings.getState()
    const term = new Terminal({
      fontFamily: initial.fontFamily,
      fontSize: initial.fontSize,
      lineHeight: initial.lineHeight,
      letterSpacing: initial.letterSpacing,
      cursorStyle: initial.cursorStyle,
      cursorBlink: initial.cursorBlink,
      // Harness output is chatty — the 1000-line default loses the top of a
      // single long tool run. 5k lines is still trivial memory-wise.
      scrollback: initial.scrollback,
      theme: resolveXtermTheme(initial, resolvedThemeOf(useTheme.getState())),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    // Clickable URLs in TUI output (PR links, dashboards) — openExternal
    // routes through shell IPC where window.open is denied, and plain
    // window.open in browsers.
    term.loadAddon(new WebLinksAddon((_e, uri) => openExternal(uri)))
    // Unicode 11 grapheme widths — current emoji/CJK align in TUI output.
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    // Inline images: sixel + iTerm2 inline-images protocol, with conservative
    // size caps so a hostile/buggy stream can't eat unbounded memory.
    term.loadAddon(
      new ImageAddon({
        sixelSupport: true,
        sixelSizeLimit: 25_000_000,
        iipSupport: true,
        iipSizeLimit: 20_000_000,
        storageLimit: 128,
      }),
    )
    const search = new SearchAddon()
    term.loadAddon(search)
    // OSC 52 clipboard. The clipboard addon drives it through
    // navigator.clipboard, which the Electron shell may not have (custom
    // scheme / non-secure origin) — there we register our own OSC 52 write
    // handler onto the app clipboard chain (rivetShell IPC, lib/clipboard.ts).
    if (rivetShell()) {
      term.parser.registerOscHandler(52, (data) => {
        const text = decodeOsc52Text(data)
        if (text === undefined) return false
        void copyTextToClipboard(text).catch(() => undefined)
        return true
      })
    } else {
      term.loadAddon(new ClipboardAddon())
    }

    // Terminal-convention clipboard: select-to-copy (debounced — xterm keeps
    // its own selection model, so the browser's copy gestures and the shell's
    // context-menu Copy can't see terminal selections at all) when the
    // copyOnSelect setting is on, Ctrl+Shift+C copies explicitly,
    // Ctrl+Shift+V pastes (lib/clipboard.ts chain), and right-click pastes
    // when rightClickPaste is on. Plain Ctrl+C stays SIGINT and plain Ctrl+V
    // stays a native paste event into xterm's hidden textarea — neither is
    // intercepted here.
    let alive = true
    const selSub = term.onSelectionChange(() => {
      if (selSuppressRef.current) return
      if (!useTerminalSettings.getState().copyOnSelect) return
      if (selTimerRef.current) clearTimeout(selTimerRef.current)
      selTimerRef.current = setTimeout(() => {
        if (!alive) return
        const sel = term.getSelection()
        if (sel) void copyTextToClipboard(sel).catch(() => undefined)
      }, 150)
    })
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      // Find bar: Ctrl/Cmd+Shift+F opens it; Esc closes it — but only while
      // it is open. A closed bar must never steal Esc from the TUI.
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyF') {
        openFind()
        e.preventDefault()
        return false
      }
      if (findOpenRef.current && e.key === 'Escape') {
        closeFind()
        e.preventDefault()
        return false
      }
      if (!e.ctrlKey || !e.shiftKey) return true
      if (e.code === 'KeyC') {
        const sel = term.getSelection()
        if (!sel) return true // nothing selected — let the browser have it
        void copyTextToClipboard(sel).catch(() => undefined)
        e.preventDefault()
        return false
      }
      if (e.code === 'KeyV') {
        void readTextFromClipboard().then((text) => {
          if (text) term.paste(text)
        })
        e.preventDefault()
        return false
      }
      return true
    })

    const onContextMenu = (e: MouseEvent): void => {
      if (!useTerminalSettings.getState().rightClickPaste) return
      e.preventDefault()
      void readTextFromClipboard().then((text) => {
        if (text && alive) term.paste(text)
      })
    }
    host.addEventListener('contextmenu', onContextMenu)

    // Visual bell: brief outline flash on the container (theme.css).
    const bellSub = term.onBell(() => {
      if (useTerminalSettings.getState().bell !== 'visual') return
      host.classList.remove('term-bell-flash')
      // Force a reflow so re-adding the class restarts the animation.
      void host.offsetWidth
      host.classList.add('term-bell-flash')
      if (bellTimerRef.current) clearTimeout(bellTimerRef.current)
      bellTimerRef.current = setTimeout(() => host.classList.remove('term-bell-flash'), 300)
    })

    term.open(host)
    fit.fit()
    termRef.current = term
    fitRef.current = fit
    searchRef.current = search

    if (initial.renderer === 'webgl') {
      const addon = mountWebgl(term, webglRef)
      webglRef.current = addon
      useTerminalSettings.getState().setRendererActual(addon ? 'webgl' : 'canvas')
    } else {
      useTerminalSettings.getState().setRendererActual('canvas')
    }

    return () => {
      alive = false
      if (selTimerRef.current) clearTimeout(selTimerRef.current)
      if (bellTimerRef.current) clearTimeout(bellTimerRef.current)
      host.removeEventListener('contextmenu', onContextMenu)
      selSub.dispose()
      bellSub.dispose()
      webglRef.current = undefined
      termRef.current = undefined
      fitRef.current = undefined
      searchRef.current = undefined
      term.dispose()
    }
  }, [props.ptyId])

  // Live settings/theme application: re-option the running terminal (and swap
  // the renderer addon in place) without touching the socket. Runs after the
  // creation effect on mount, so the initial construction above only needs
  // the same values.
  useEffect(() => {
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    term.options.fontFamily = settings.fontFamily
    term.options.fontSize = settings.fontSize
    term.options.lineHeight = settings.lineHeight
    term.options.letterSpacing = settings.letterSpacing
    term.options.cursorStyle = settings.cursorStyle
    term.options.cursorBlink = settings.cursorBlink
    term.options.scrollback = settings.scrollback
    // Palette source: app tokens / built-in scheme / imported palette —
    // resolveXtermTheme owns the fallback chain.
    term.options.theme = resolveXtermTheme(settings, resolvedTheme)
    if (settings.renderer === 'webgl' && !webglRef.current) {
      const addon = mountWebgl(term, webglRef)
      webglRef.current = addon
      settings.setRendererActual(addon ? 'webgl' : 'canvas')
    } else if (settings.renderer === 'canvas' && webglRef.current) {
      webglRef.current.dispose()
      webglRef.current = undefined
      settings.setRendererActual('canvas')
    }
    fit.fit()
  }, [settings, resolvedTheme])

  useEffect(() => {
    const host = hostRef.current
    const term = termRef.current
    const fit = fitRef.current
    if (!host || !term || !fit) return

    setStatus('connecting')
    // Reattach (epoch rebind) replays scrollback — clear the buffer so the
    // replay doesn't append a second copy. First attach: no-op. Silence
    // copy-on-select for the reset: it clears the selection, and a leftover
    // non-empty selection must not be copied mid-rebind.
    selSuppressRef.current = true
    if (selTimerRef.current) clearTimeout(selTimerRef.current)
    term.reset()
    selSuppressRef.current = false

    // disposed guard: StrictMode dev runs mount→cleanup→mount; frames from
    // the first (closing) socket must never write into a disposed terminal.
    // Cross-node PTYs dial their own node's gateway; resolving the pipe base
    // is async, so the socket setup runs behind it with the same guard
    // covering the gap, and the teardown closes whatever the async body
    // managed to create before unmount.
    // holder, not a bare let: the async body reads it AFTER awaits, and TS
    // narrows a closed-over let to its initializer across those boundaries.
    const life = { disposed: false }
    // Filled once the async dial lands. Input/resize subscribe SYNCHRONOUSLY
    // against this ref — the home path used to subscribe before any await,
    // and a remote dial must not open a keystroke-dropping window beyond the
    // pre-open drop both paths always had (readyState !== 1 → ignored).
    const sockRef: { current: WebSocket | undefined } = { current: undefined }
    let resizeTimer: ReturnType<typeof setTimeout> | undefined

    const dataSub = term.onData((data) => {
      const sock = sockRef.current
      if (!sock || sock.readyState !== 1) return
      // Belt-and-suspenders: if a color report still fires (live query path),
      // do not forward it as PTY input — harnesses treat it as typed text.
      if (isOscColorReport(data)) return
      sock.send(new TextEncoder().encode(data))
    })
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        if (life.disposed) return
        fit.fit()
        const sock = sockRef.current
        if (sock && sock.readyState === 1)
          sock.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }, 150)
    })
    resizeObserver.observe(host)

    void (async () => {
      let gateway
      try {
        gateway = props.base ? await gatewayFor(props.base) : useConnection.getState().gateway
      } catch {
        if (!life.disposed) setStatus('closed')
        return
      }
      if (life.disposed) return
      const sock = new WebSocket(gateway.terminalWsUrl({ id: props.ptyId }))
      sockRef.current = sock
      sock.binaryType = 'arraybuffer'

      sock.onopen = () => {
        if (life.disposed) return
        setStatus('attached')
        // Always re-fit and declare our size on (re)attach — a rebind would
        // otherwise keep whatever PTY size the previous socket negotiated.
        fit.fit()
        sock.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }
      sock.onclose = () => {
        if (!life.disposed) setStatus((s) => (s === 'exited' ? s : 'closed'))
      }
      sock.onmessage = (event: MessageEvent) => {
        if (life.disposed) return
        if (typeof event.data === 'string') {
          const frame = JSON.parse(event.data) as TermHelloFrame | TermExitFrame
          if (frame.type === 'hello') {
            if (frame.cols !== term.cols || frame.rows !== term.rows)
              sock.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
            if (frame.state === 'exited') setStatus('exited')
          } else {
            setStatus('exited')
            term.write(`\r\n\x1b[2m[process exited ${String(frame.code)}]\x1b[0m\r\n`)
          }
          return
        }
        // Drop color queries so attach/scrollback replay doesn't generate
        // OSC rgb: replies that leak into the harness as fake keystrokes.
        term.write(stripOscColorQueries(new Uint8Array(event.data as ArrayBuffer)))
      }
    })()

    return () => {
      life.disposed = true
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeObserver.disconnect()
      try {
        dataSub.dispose()
      } catch {
        // terminal may already be disposed when the PTY itself changed
      }
      sockRef.current?.close()
    }
    // transportEpoch on the remote path too: the epoch tracks the shell's
    // mTLS pipe lifecycle, and gatewayFor(base) resolves THROUGH that pipe —
    // when it dies/reappears, remote sockets are as stranded as home ones.
    // A home-only reconnect costs a remote pane one reset+replay; a missed
    // pipe swap costs it the session. Rebind.
  }, [props.ptyId, transportEpoch, props.base])

  return (
    <div className="relative min-h-0 flex-1 p-2">
      <div
        ref={hostRef}
        className="h-full w-full"
        data-terminal-font={settings.fontFamily}
        // Ligatures are best-effort: xterm shapes glyphs itself, so CSS
        // font-feature-settings only has an effect with the DOM renderer.
        style={settings.ligatures ? { fontFeatureSettings: '"liga" 1, "calt" 1' } : undefined}
      />
      {findOpen && (
        <div className="absolute right-4 top-3 flex items-center gap-1 rounded border border-line bg-panel-2 px-2 py-1">
          <input
            autoFocus
            value={findQuery}
            onChange={(e) => setFindQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                if (e.shiftKey) findPrev()
                else findNext()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                closeFind()
              }
            }}
            placeholder="Find"
            aria-label="Find in terminal"
            className="w-44 rounded border border-line bg-panel px-2 py-0.5 font-mono text-xs outline-none focus:border-em"
          />
          <button
            onClick={findPrev}
            aria-label="previous match"
            className="rounded px-1.5 py-0.5 text-xs text-ink-dim hover:bg-panel hover:text-ink"
          >
            ↑
          </button>
          <button
            onClick={findNext}
            aria-label="next match"
            className="rounded px-1.5 py-0.5 text-xs text-ink-dim hover:bg-panel hover:text-ink"
          >
            ↓
          </button>
          <button
            onClick={closeFind}
            aria-label="close find"
            className="rounded px-1.5 py-0.5 text-xs text-ink-dim hover:bg-panel hover:text-ink"
          >
            ✕
          </button>
        </div>
      )}
      {status !== 'attached' && (
        <div className="absolute right-4 top-3 rounded bg-panel-2 px-2 py-1 font-mono text-[11px] text-ink-dim">
          {status}
        </div>
      )}
    </div>
  )
}
