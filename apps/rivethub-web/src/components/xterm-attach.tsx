import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { SearchAddon } from '@xterm/addon-search'
import { ImageAddon } from '@xterm/addon-image'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import type { TermExitFrame, TermHelloFrame } from '@rivetos/types'
import { useConnection } from '../stores/connection.js'
import { resolvedThemeOf, useResolvedTheme, useTheme } from '../stores/theme.js'
import { resolveXtermTheme, useTerminalSettings } from '../stores/terminal-settings.js'
import { gatewayFor } from '../lib/agent-gateway.js'
import { buildTerminalOptions } from '../lib/terminal-options.js'
import { isOscColorReport, stripOscColorQueries } from '../lib/osc-filter.js'
import { copyTextToClipboard, hasTauriClipboard, readTextFromClipboard } from '../lib/clipboard.js'
import { openExternal } from '../lib/open-external.js'
import { expiresInLabel, filesFrom, pathsToPasteText, stageFiles } from '../lib/stage-files.js'

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
 * context loss we latch `webglFailedRef`, dispose the addon, and carry on
 * with the DOM renderer, flipping the store's non-persisted `rendererActual`
 * so Settings can say so. The latch releases when the user re-selects the
 * renderer or a new PTY pane is created.
 *
 * Addons: fit + web-links (as before), unicode11 (grapheme widths for modern
 * emoji/CJK), search (Ctrl/Cmd+Shift+F find bar), image (sixel + iTerm2 IIP,
 * capped), and webgl (optional). OSC 52 clipboard is one write-only handler
 * on every host — never the clipboard addon, whose default provider answers
 * clipboard READS; writes go through the app clipboard chain
 * (lib/clipboard.ts) so hosts without navigator.clipboard (Electron shell,
 * Android WebView shim) still work.
 */

/** Base64 payloads from a PTY are capped — an unbounded OSC 52 write would
 *  let whatever holds the terminal stream arbitrary data through atob and
 *  the clipboard IPC chain. */
const OSC52_MAX_B64 = 256 * 1024

/** OSC 52 payload is `<selection>;<base64>` (`?` = clipboard query — refuse
 *  it; answering would leak clipboard contents to whatever holds the PTY).
 *  Returns the decoded write, or undefined to ignore the sequence. */
function decodeOsc52Write(data: string): string | undefined {
  const sep = data.indexOf(';')
  if (sep === -1) return undefined
  const payload = data.slice(sep + 1).replace(/\s+/g, '')
  if (!payload || payload === '?' || payload.length > OSC52_MAX_B64) return undefined
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)))
  } catch {
    return undefined
  }
}

/** True when any clipboard write path exists (host IPC or the web API). */
function hasAnyClipboard(): boolean {
  if (hasTauriClipboard()) return true
  const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
  return clip != null && typeof clip.writeText === 'function'
}

/**
 * WebGL renderer with DOM fallback. The constructor or activate() throws
 * where GL is unavailable/blocked; onContextLoss fires when the GPU context
 * dies mid-session — the addon must then be disposed, and xterm carries on
 * with the DOM renderer. Every failure latches `webglFailedRef` so the
 * settings effect cannot remount WebGL in a loop; both paths flip the
 * store's `rendererActual` to 'canvas' (the preference stays 'webgl' — the
 * latch releases when the user re-selects the renderer or a new PTY pane
 * is created).
 */
function mountWebgl(
  term: Terminal,
  webglRef: { current: WebglAddon | undefined },
  webglFailedRef: { current: boolean },
): WebglAddon | undefined {
  try {
    const addon = new WebglAddon()
    addon.onContextLoss(() => {
      if (webglRef.current !== addon) return // already swapped out
      // Null the ref BEFORE dispose: if dispose synchronously re-fires
      // context loss, the guard above must already see the swap.
      webglRef.current = undefined
      webglFailedRef.current = true
      addon.dispose()
      useTerminalSettings.getState().setRendererActual('canvas')
    })
    try {
      term.loadAddon(addon)
    } catch (e) {
      // loadAddon (activate) is where headless/blocked GL throws — dispose
      // the half-mounted addon before it leaks listeners into the terminal.
      addon.dispose()
      throw e
    }
    return addon
  } catch {
    webglFailedRef.current = true
    return undefined
  }
}

export function XtermAttach(props: {
  ptyId: string
  /** Node the PTY lives on when it is not the globally connected one —
   *  cross-node sessions attach over that node's own (pipe-routed) gateway. */
  base?: string
  /** Fired when the PTY process exits (hello state or exit frame). */
  onExit?: () => void
}): JSX.Element {
  const onExitRef = useRef(props.onExit)
  onExitRef.current = props.onExit
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | undefined>(undefined)
  const fitRef = useRef<FitAddon | undefined>(undefined)
  const searchRef = useRef<SearchAddon | undefined>(undefined)
  const webglRef = useRef<WebglAddon | undefined>(undefined)
  // Latched by mountWebgl on constructor throw / loadAddon failure / GPU
  // context loss; cleared only on a renderer re-selection or a new PTY pane.
  const webglFailedRef = useRef(false)
  // Shared with the socket effect: it silences copy-on-select around
  // term.reset() (reset can fire onSelectionChange) and clears any pending
  // debounce so a pre-rebind selection can't copy mid-rebind.
  const selTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const selSuppressRef = useRef(false)
  const bellTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const bellLiveRef = useRef<HTMLDivElement>(null)
  const transportEpoch = useConnection((s) => s.transportEpoch)
  const resolvedTheme = useResolvedTheme()
  // Select the primitives the settings effect needs — subscribing to the
  // whole store would re-run the effect (and re-fit / rebuild the theme) on
  // `rendererActual` writes and unrelated keys.
  const fontFamily = useTerminalSettings((s) => s.fontFamily)
  const fontSize = useTerminalSettings((s) => s.fontSize)
  const lineHeight = useTerminalSettings((s) => s.lineHeight)
  const letterSpacing = useTerminalSettings((s) => s.letterSpacing)
  const cursorStyle = useTerminalSettings((s) => s.cursorStyle)
  const cursorBlink = useTerminalSettings((s) => s.cursorBlink)
  const scrollback = useTerminalSettings((s) => s.scrollback)
  const renderer = useTerminalSettings((s) => s.renderer)
  const themeSource = useTerminalSettings((s) => s.themeSource)
  const scheme = useTerminalSettings((s) => s.scheme)
  const imported = useTerminalSettings((s) => s.imported)
  const themePreference = useTheme((s) => s.preference)
  const omarchyAnsi = useTheme((s) => s.omarchy?.colors.ansi)
  const xtermTheme = useMemo(
    () =>
      resolveXtermTheme(
        { themeSource, scheme, imported },
        resolvedTheme,
        themePreference === 'omarchy' ? omarchyAnsi : undefined,
      ),
    [themeSource, scheme, imported, resolvedTheme, themePreference, omarchyAnsi],
  )
  const [status, setStatus] = useState<'connecting' | 'attached' | 'exited' | 'closed'>(
    'connecting',
  )
  const statusRef = useRef(status)
  statusRef.current = status
  const [stageHint, setStageHint] = useState<
    { kind: 'staging' | 'ok' | 'err'; text: string } | undefined
  >(undefined)
  // Set when `new Terminal` / addon load throws — the pane must not stay on
  // 'connecting' with only a console warning.
  const [constructError, setConstructError] = useState<string | undefined>(undefined)
  // Find bar state. findOpenRef mirrors it for the custom key handler, which
  // is registered once at terminal creation and must see the live value.
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const findOpenRef = useRef(false)
  // Esc is stolen from the TUI only while the find INPUT is focused — an
  // open bar the user clicked away from must give Esc back to the terminal.
  const findFocusedRef = useRef(false)

  const openFind = (): void => {
    findOpenRef.current = true
    setFindOpen(true)
  }
  const closeFind = (): void => {
    findOpenRef.current = false
    findFocusedRef.current = false
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

  /** Same resolution the socket effect uses — pane `base` or the connected gateway. */
  const resolveGateway = () =>
    props.base ? gatewayFor(props.base) : Promise.resolve(useConnection.getState().gateway)
  const resolveGatewayRef = useRef(resolveGateway)
  resolveGatewayRef.current = resolveGateway

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    // New pane, new GPU hope: the WebGL failure latch is per-PTY, so a fresh
    // terminal retries the preferred renderer.
    webglFailedRef.current = false
    setConstructError(undefined)

    const initial = useTerminalSettings.getState()
    // Construction is exception-safe: if the constructor (a bad persisted
    // option) or any addon/handler throws, disposePartial runs so the
    // exception never escapes the effect and nothing half-wired leaks.
    let term: Terminal | undefined
    let alive = true
    let constructed = false
    let selSub: { dispose: () => void } | undefined
    let bellSub: { dispose: () => void } | undefined
    let fit: FitAddon | undefined
    let search: SearchAddon | undefined
    const onContextMenu = (e: MouseEvent): void => {
      if (!term || !useTerminalSettings.getState().rightClickPaste) return
      // A live selection keeps the native context menu (Copy) — right-click
      // paste only replaces the menu when there is nothing to copy.
      if (term.getSelection()) return
      e.preventDefault()
      void readTextFromClipboard().then((text) => {
        if (text && alive) term?.paste(text)
      })
    }
    let hintTimer: ReturnType<typeof setTimeout> | undefined
    const showHint = (
      next: { kind: 'staging' | 'ok' | 'err'; text: string },
      persistMs?: number,
    ): void => {
      if (hintTimer) {
        clearTimeout(hintTimer)
        hintTimer = undefined
      }
      if (!alive) return
      setStageHint(next)
      if (persistMs !== undefined) {
        hintTimer = setTimeout(() => {
          if (alive) setStageHint(undefined)
        }, persistMs)
      }
    }
    const stageAndPaste = (files: File[]): void => {
      if (files.length === 0 || statusRef.current === 'exited') return
      void (async () => {
        const n = files.length
        showHint({
          kind: 'staging',
          text: `staging ${String(n)} file${n === 1 ? '' : 's'}…`,
        })
        let gw
        try {
          gw = await resolveGatewayRef.current()
        } catch {
          showHint(
            { kind: 'err', text: `upload failed: ${files[0]?.name || 'pasted-image.png'}` },
            4000,
          )
          return
        }
        const { staged, failed } = await stageFiles(gw, files)
        if (!alive) return
        if (staged.length > 0 && failed.length > 0) {
          term?.paste(pathsToPasteText(staged.map((s) => s.uri)))
          showHint(
            {
              kind: 'err',
              text: `staged ${String(staged.length)} → ${staged[0].uri} · failed: ${failed[0]}`,
            },
            4000,
          )
        } else if (staged.length > 0) {
          term?.paste(pathsToPasteText(staged.map((s) => s.uri)))
          showHint(
            {
              kind: 'ok',
              text: `staged → ${staged[0].uri} (expires in ${expiresInLabel(staged[0].expiresAt)})`,
            },
            4000,
          )
        } else {
          showHint({ kind: 'err', text: `upload failed: ${failed[0] ?? 'file'}` }, 4000)
        }
      })()
    }
    // Capture-phase paste: file/image clipboard items must not reach xterm's
    // text paste. Stage via the gateway and insert the node path instead.
    const onPaste = (e: ClipboardEvent): void => {
      const files = filesFrom(e.clipboardData)
      if (files.length === 0) return
      if (statusRef.current === 'exited') return
      e.preventDefault()
      e.stopPropagation()
      stageAndPaste(files)
    }
    const dragHasFiles = (e: DragEvent): boolean => {
      const types = e.dataTransfer?.types
      if (!types) return false
      return Array.from(types).includes('Files')
    }
    const onDragOver = (e: DragEvent): void => {
      if (statusRef.current === 'exited' || !dragHasFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      host.setAttribute('data-drop-active', '')
    }
    const onDragEnter = (e: DragEvent): void => {
      if (statusRef.current === 'exited' || !dragHasFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      host.setAttribute('data-drop-active', '')
    }
    const onDragLeave = (e: DragEvent): void => {
      const related = e.relatedTarget
      if (related instanceof Node && host.contains(related)) return
      host.removeAttribute('data-drop-active')
    }
    const onDrop = (e: DragEvent): void => {
      e.preventDefault()
      host.removeAttribute('data-drop-active')
      if (statusRef.current === 'exited') return
      stageAndPaste(filesFrom(e.dataTransfer))
    }
    const onBellAnimationEnd = (e: AnimationEvent): void => {
      // xterm animations bubble from descendants; only the host's own bell
      // flash should clear the class.
      if (e.target !== host) return
      host.classList.remove('term-bell-flash')
    }
    const unbindHost = (): void => {
      host.removeEventListener('contextmenu', onContextMenu)
      host.removeEventListener('paste', onPaste, true)
      host.removeEventListener('dragover', onDragOver)
      host.removeEventListener('dragenter', onDragEnter)
      host.removeEventListener('dragleave', onDragLeave)
      host.removeEventListener('drop', onDrop)
      host.removeEventListener('animationend', onBellAnimationEnd)
      host.removeAttribute('data-drop-active')
    }
    const disposePartial = (): void => {
      alive = false
      if (selTimerRef.current) clearTimeout(selTimerRef.current)
      if (bellTimerRef.current) clearTimeout(bellTimerRef.current)
      if (hintTimer) clearTimeout(hintTimer)
      setStageHint(undefined)
      unbindHost()
      selSub?.dispose()
      bellSub?.dispose()
      webglRef.current = undefined
      termRef.current = undefined
      fitRef.current = undefined
      searchRef.current = undefined
      term?.dispose()
    }
    try {
      const themeState = useTheme.getState()
      const instance = new Terminal({
        ...buildTerminalOptions(initial),
        theme: resolveXtermTheme(
          initial,
          resolvedThemeOf(themeState),
          themeState.preference === 'omarchy' ? themeState.omarchy?.colors.ansi : undefined,
        ),
      })
      term = instance
      fit = new FitAddon()
      instance.loadAddon(fit)
      // Clickable URLs in TUI output (PR links, dashboards) — openExternal
      // routes through shell IPC where window.open is denied, and plain
      // window.open in browsers.
      instance.loadAddon(new WebLinksAddon((_e, uri) => openExternal(uri)))
      // Unicode 11 grapheme widths — current emoji/CJK align in TUI output.
      instance.loadAddon(new Unicode11Addon())
      instance.unicode.activeVersion = '11'
      // Inline images: sixel + iTerm2 inline-images protocol, with conservative
      // size caps so a hostile/buggy stream can't eat unbounded memory.
      instance.loadAddon(
        new ImageAddon({
          sixelSupport: true,
          sixelSizeLimit: 25_000_000,
          iipSupport: true,
          iipSizeLimit: 20_000_000,
          storageLimit: 128,
        }),
      )
      search = new SearchAddon()
      instance.loadAddon(search)
      // OSC 52 clipboard: ONE write-only handler on every host. Reads (`?`),
      // empty, and malformed payloads are claimed and ignored — answering a
      // read would leak the clipboard to whatever holds the PTY, and
      // returning false would let another handler answer. Writes go through
      // the app clipboard chain (lib/clipboard.ts: rivetShell IPC → Tauri
      // shim → navigator.clipboard → execCommand) when the host actually has
      // a clipboard — some WebView hosts have none at all.
      instance.parser.registerOscHandler(52, (data) => {
        const text = decodeOsc52Write(data)
        if (text !== undefined && hasAnyClipboard()) {
          void copyTextToClipboard(text).catch(() => undefined)
        }
        return true
      })

      // Terminal-convention clipboard: select-to-copy (debounced — xterm keeps
      // its own selection model, so the browser's copy gestures and the shell's
      // context-menu Copy can't see terminal selections at all) when the
      // copyOnSelect setting is on, Ctrl+Shift+C copies explicitly,
      // Ctrl+Shift+V pastes (lib/clipboard.ts chain), and right-click pastes
      // when rightClickPaste is on. Plain Ctrl+C stays SIGINT and plain Ctrl+V
      // stays a native paste event into xterm's hidden textarea — neither is
      // intercepted here.
      selSub = instance.onSelectionChange(() => {
        if (selSuppressRef.current) return
        if (!useTerminalSettings.getState().copyOnSelect) return
        if (selTimerRef.current) clearTimeout(selTimerRef.current)
        selTimerRef.current = setTimeout(() => {
          if (!alive) return
          const sel = instance.getSelection()
          if (sel) void copyTextToClipboard(sel).catch(() => undefined)
        }, 150)
      })
      instance.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown') return true
        // Find bar: Ctrl/Cmd+Shift+F opens it; Esc closes it — but only
        // while its input is focused. Once the user refocuses the terminal,
        // Esc belongs to the TUI again.
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyF') {
          openFind()
          e.preventDefault()
          return false
        }
        if (findOpenRef.current && findFocusedRef.current && e.key === 'Escape') {
          closeFind()
          e.preventDefault()
          return false
        }
        if (!e.ctrlKey || !e.shiftKey) return true
        if (e.code === 'KeyC') {
          const sel = instance.getSelection()
          if (!sel) return true // nothing selected — let the browser have it
          void copyTextToClipboard(sel).catch(() => undefined)
          e.preventDefault()
          return false
        }
        if (e.code === 'KeyV') {
          void readTextFromClipboard().then((text) => {
            if (text) instance.paste(text)
          })
          e.preventDefault()
          return false
        }
        return true
      })

      host.addEventListener('contextmenu', onContextMenu)
      host.addEventListener('paste', onPaste, true)
      host.addEventListener('dragover', onDragOver)
      host.addEventListener('dragenter', onDragEnter)
      host.addEventListener('dragleave', onDragLeave)
      host.addEventListener('drop', onDrop)

      // Visual bell: brief outline flash on the container (theme.css).
      // animationend removes the class so a second BEL retriggers; the
      // timeout is the fallback for prefers-reduced-motion, where the
      // animation is disabled and animationend may never fire.
      host.addEventListener('animationend', onBellAnimationEnd)
      bellSub = instance.onBell(() => {
        if (useTerminalSettings.getState().bell !== 'visual') return
        host.classList.remove('term-bell-flash')
        // Force a reflow so re-adding the class restarts the animation.
        void host.offsetWidth
        host.classList.add('term-bell-flash')
        const live = bellLiveRef.current
        if (live) {
          // Identical text does not retrigger aria-live; clear first.
          live.textContent = ''
          live.textContent = 'Terminal bell'
        }
        if (bellTimerRef.current) clearTimeout(bellTimerRef.current)
        bellTimerRef.current = setTimeout(() => {
          host.classList.remove('term-bell-flash')
          if (bellLiveRef.current) bellLiveRef.current.textContent = ''
        }, 300)
      })

      instance.open(host)
      termRef.current = instance
      fitRef.current = fit
      searchRef.current = search

      if (initial.renderer === 'webgl') {
        const addon = mountWebgl(instance, webglRef, webglFailedRef)
        webglRef.current = addon
        useTerminalSettings.getState().setRendererActual(addon ? 'webgl' : 'canvas')
      } else {
        useTerminalSettings.getState().setRendererActual('canvas')
      }
      // Fit AFTER the renderer is in place — the addon swap changes the
      // canvas metrics, and fitting before it would ship a stale geometry.
      fit.fit()
      constructed = true
    } catch (e) {
      // A half-constructed terminal must not leak its addons/listeners, and
      // the pane must not sit on 'connecting' with only a console warning.
      console.warn('[xterm] terminal construction failed', e)
      disposePartial()
      setConstructError(e instanceof Error ? e.message : String(e))
      setStatus('closed')
    }
    if (!constructed) return

    return () => {
      alive = false
      if (selTimerRef.current) clearTimeout(selTimerRef.current)
      if (bellTimerRef.current) clearTimeout(bellTimerRef.current)
      if (hintTimer) clearTimeout(hintTimer)
      setStageHint(undefined)
      unbindHost()
      selSub?.dispose()
      bellSub?.dispose()
      webglRef.current = undefined
      termRef.current = undefined
      fitRef.current = undefined
      searchRef.current = undefined
      term?.dispose()
    }
  }, [props.ptyId])

  // Previous renderer / geometry-metric values, so the settings effect can
  // tell a user renderer re-selection (clears the WebGL latch) from a
  // rendererActual flip, and only re-fit when geometry actually changed.
  const prevRendererRef = useRef<'webgl' | 'canvas' | undefined>(undefined)
  const prevMetricsRef = useRef<
    | {
        fontFamily: string
        fontSize: number
        lineHeight: number
        letterSpacing: number
        renderer: 'webgl' | 'canvas'
      }
    | undefined
  >(undefined)

  // Live settings/theme application: re-option the running terminal (and swap
  // the renderer addon in place) without touching the socket. Runs after the
  // creation effect on mount, so the initial construction above only needs
  // the same values. Depends on the selected primitives only — never the
  // whole store object.
  useEffect(() => {
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    // xterm's option validators throw on values their own normalizer admitted
    // (e.g. out-of-range lineHeight) — a bad settings write must never throw
    // out of this effect and take the live pane down.
    try {
      term.options.fontFamily = fontFamily
      term.options.fontSize = fontSize
      term.options.lineHeight = lineHeight
      term.options.letterSpacing = letterSpacing
      term.options.cursorStyle = cursorStyle
      term.options.cursorBlink = cursorBlink
      term.options.scrollback = scrollback
      // Palette source: app tokens / built-in scheme / imported palette —
      // resolveXtermTheme owns the fallback chain.
      term.options.theme = xtermTheme
    } catch {
      // keep the last working options
    }

    // A user renderer re-selection clears the WebGL failure latch — the
    // latch exists to stop THIS effect remounting WebGL after a failure, not
    // to override an explicit fresh choice.
    if (prevRendererRef.current !== undefined && prevRendererRef.current !== renderer) {
      webglFailedRef.current = false
    }
    prevRendererRef.current = renderer
    if (renderer === 'webgl' && !webglRef.current && !webglFailedRef.current) {
      const addon = mountWebgl(term, webglRef, webglFailedRef)
      webglRef.current = addon
      useTerminalSettings.getState().setRendererActual(addon ? 'webgl' : 'canvas')
    } else if (renderer === 'canvas' && webglRef.current) {
      const addon = webglRef.current
      // Null the ref BEFORE dispose: a synchronous onContextLoss during
      // dispose must not see this addon as current and double-dispose.
      webglRef.current = undefined
      addon.dispose()
      useTerminalSettings.getState().setRendererActual('canvas')
    }

    // Fit only when a geometry-affecting option (font metrics, renderer)
    // changed: a fit on a hidden pane ships a 0×0 resize to the PTY, so
    // theme/cursor/scrollback/rendererActual writes must not trigger one.
    // The fit itself fires term.onResize → the socket effect's resize frame.
    const prev = prevMetricsRef.current
    const metricsChanged =
      !prev ||
      prev.fontFamily !== fontFamily ||
      prev.fontSize !== fontSize ||
      prev.lineHeight !== lineHeight ||
      prev.letterSpacing !== letterSpacing ||
      prev.renderer !== renderer
    prevMetricsRef.current = { fontFamily, fontSize, lineHeight, letterSpacing, renderer }
    if (metricsChanged) fit.fit()
  }, [
    fontFamily,
    fontSize,
    lineHeight,
    letterSpacing,
    cursorStyle,
    cursorBlink,
    scrollback,
    renderer,
    xtermTheme,
  ])

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
    // ANY geometry change reaches the PTY: container resizes via the observer
    // below, font/metric/renderer changes via the settings effect's fit —
    // both end in term.onResize. Without this, a font change left the PTY
    // on the old geometry until the user manually resized the window.
    const resizeSub = term.onResize(({ cols, rows }) => {
      const sock = sockRef.current
      if (sock && sock.readyState === 1) sock.send(JSON.stringify({ type: 'resize', cols, rows }))
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
        gateway = await resolveGateway()
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
            if (frame.state === 'exited') {
              setStatus('exited')
              onExitRef.current?.()
            }
          } else {
            setStatus('exited')
            onExitRef.current?.()
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
        resizeSub.dispose()
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
      <div ref={hostRef} className="h-full w-full" data-term-host data-terminal-font={fontFamily} />
      {/* Screen-reader announcement for the visual bell (the flash itself is
          purely visual — theme.css `.term-bell-flash`). */}
      <div ref={bellLiveRef} role="status" aria-live="polite" className="sr-only" />
      {stageHint && (
        <div
          role="status"
          className={`absolute bottom-3 right-4 rounded border border-line bg-panel-2 px-2 py-1 font-mono text-[11px] ${
            stageHint.kind === 'err' ? 'text-red' : 'text-ink-dim'
          }`}
        >
          {stageHint.text}
        </div>
      )}
      {findOpen && (
        <div className="absolute right-4 top-3 flex items-center gap-1 rounded border border-line bg-panel-2 px-2 py-1">
          <input
            autoFocus
            value={findQuery}
            onChange={(e) => {
              const q = e.target.value
              setFindQuery(q)
              // An emptied query leaves stale match highlights behind.
              if (!q) searchRef.current?.clearDecorations()
            }}
            onFocus={() => {
              findFocusedRef.current = true
            }}
            onBlur={() => {
              findFocusedRef.current = false
            }}
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
        <div className="absolute left-4 top-3 rounded bg-panel-2 px-2 py-1 font-mono text-[11px] text-ink-dim">
          {constructError ? `[terminal failed: ${constructError}]` : status}
        </div>
      )}
    </div>
  )
}
