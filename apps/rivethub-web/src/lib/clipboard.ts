/**
 * Clipboard for every Hub surface. Programmatic writes/reads
 * (`copyTextToClipboard` / `readTextFromClipboard`) try, in order:
 *
 * 0. rivetShell — the Electron shell's preload bridge (IPC to the main
 *    process clipboard, which is reliable everywhere Chromium runs).
 * 1. Tauri clipboard-manager — `__TAURI__.clipboardManager`, with a
 *    `__TAURI_INTERNALS__.invoke` fallback — the Android hub WebView shim
 *    (RivetHubBridge) exposes the same shape. Required because
 *    WebKitGTK-on-Wayland system clipboard is flaky and non-secure origins
 *    (http:// LAN / loopback in WebView) have no `navigator.clipboard`.
 * 2. navigator.clipboard — browsers on secure origins (https / localhost).
 * 3. execCommand('copy') — LAN http:// in a plain browser (write only).
 *
 * Reads have no execCommand fallback — on a plain-browser LAN origin, paste
 * still works through native paste events (composer textarea, xterm's
 * hidden textarea); readText() is only needed for explicit shortcuts.
 *
 * NATIVE copy gestures (Ctrl/Cmd+C, context-menu Copy) are claimed by
 * `installClipboardBridge()` ONLY on Tauri-shaped hosts without rivetShell
 * (WebKitGTK shell, Android WebView shim) — the hosts whose native clipboard
 * is actually broken. Everywhere Chromium owns the document — the Electron
 * shell included, secure context or not — the engine's own copy is the
 * reliable single writer, and claiming it (preventDefault + async IPC write)
 * both loses the app's rich payload and races consecutive copies.
 */

import { rivetShell } from './shell-bridge.js'

interface TauriClipboard {
  writeText(text: string): Promise<void>
  readText(): Promise<string>
}

interface TauriInternals {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>
}

function tauriClipboardManager(): TauriClipboard | undefined {
  const tauri = (globalThis as { __TAURI__?: { clipboardManager?: TauriClipboard } }).__TAURI__
  const cm = tauri?.clipboardManager
  if (cm && typeof cm.writeText === 'function' && typeof cm.readText === 'function') {
    return cm
  }
  return undefined
}

function tauriInternals(): TauriInternals | undefined {
  const internals = (globalThis as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__
  if (internals && typeof internals.invoke === 'function') return internals
  return undefined
}

/** True when a host IPC path can write/read the system clipboard. */
export function hasTauriClipboard(): boolean {
  return rivetShell() != null || tauriClipboardManager() != null || tauriInternals() != null
}

/**
 * Whether the document-level copy bridge should take over a native copy
 * gesture: only on a Tauri-shaped host with no rivetShell (WebKitGTK /
 * Android shim — the broken-native-clipboard cases). Chromium hosts keep
 * native copy: it works regardless of secure context, and it is the only
 * way to avoid a second writer racing the gesture. Exported for unit tests.
 */
export function shouldBridgeNativeCopy(
  opts: { hasShell: boolean; hasTauri: boolean } = {
    hasShell: rivetShell() != null,
    hasTauri: tauriClipboardManager() != null || tauriInternals() != null,
  },
): boolean {
  return !opts.hasShell && opts.hasTauri
}

async function writeViaTauri(text: string): Promise<boolean> {
  const shell = rivetShell()
  if (shell) {
    await shell.clipboardWriteText(text)
    return true
  }
  const cm = tauriClipboardManager()
  if (cm) {
    await cm.writeText(text)
    return true
  }
  const internals = tauriInternals()
  if (internals) {
    await internals.invoke('plugin:clipboard-manager|write_text', { text })
    return true
  }
  return false
}

async function readViaTauri(): Promise<string | undefined> {
  const shell = rivetShell()
  if (shell) {
    return await shell.clipboardReadText()
  }
  const cm = tauriClipboardManager()
  if (cm) {
    return await cm.readText()
  }
  const internals = tauriInternals()
  if (internals) {
    const text = await internals.invoke('plugin:clipboard-manager|read_text')
    return typeof text === 'string' ? text : undefined
  }
  return undefined
}

function issueWrite(text: string): Promise<void> {
  return writeViaTauri(text)
    .then((used) => {
      if (used) return
      const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
      if (clip && typeof clip.writeText === 'function') {
        return clip.writeText(text).catch(() => fallbackCopy(text))
      }
      return fallbackCopy(text)
    })
    .catch(() => {
      // Tauri path threw — try browser paths before giving up.
      const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
      if (clip && typeof clip.writeText === 'function') {
        return clip.writeText(text).catch(() => fallbackCopy(text))
      }
      return fallbackCopy(text)
    })
}

/**
 * Write serialization. The IPC chain is async, so two rapid copies could
 * otherwise complete out of order and copy N's late write would clobber
 * copy N+1 — the user-facing "paste gives the previous thing" bug. Every
 * request takes a monotonic generation; at most one write is in flight; a
 * queued write that is no longer the newest generation is dropped before it
 * is ever issued (clipboard state is last-write-wins — an intermediate
 * write is noise). A superseded caller resolves successfully: the clipboard
 * deliberately holds newer content.
 */
let writeGen = 0
let inFlight = false
let pendingWrite:
  { text: string; gen: number; resolve: () => void; reject: (e: unknown) => void } | undefined

/** One hung IPC must not deadlock every later copy: after this long the
 *  queue fails open (warn, treat as settled, issue the pending write). A
 *  hung write that completes even later can still land out of order — IPC
 *  is not cancellable — but a deadlocked clipboard is strictly worse. */
const WRITE_SETTLE_MS = 10_000

function withSettleTimeout(p: Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      console.warn('[clipboard] write did not settle within 10s — failing open')
      resolve()
    }, WRITE_SETTLE_MS)
    p.then(
      () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      },
      (e: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      },
    )
  })
}

function drainWrites(): void {
  inFlight = false
  const next = pendingWrite
  pendingWrite = undefined
  if (!next) return
  inFlight = true
  withSettleTimeout(issueWrite(next.text)).then(
    () => {
      next.resolve()
      drainWrites()
    },
    (e: unknown) => {
      next.reject(e)
      drainWrites()
    },
  )
}

export function copyTextToClipboard(text: string): Promise<void> {
  const gen = ++writeGen
  if (inFlight) {
    // Supersede any queued-but-unissued older write.
    if (pendingWrite && pendingWrite.gen < gen) pendingWrite.resolve()
    return new Promise<void>((resolve, reject) => {
      pendingWrite = { text, gen, resolve, reject }
    })
  }
  inFlight = true
  const p = withSettleTimeout(issueWrite(text))
  p.then(
    () => {
      drainWrites()
    },
    () => {
      drainWrites()
    },
  )
  return p
}

/** Resolves undefined when no readable clipboard source exists. */
export async function readTextFromClipboard(): Promise<string | undefined> {
  try {
    const viaTauri = await readViaTauri()
    if (viaTauri !== undefined) return viaTauri
  } catch {
    // fall through to the browser API
  }
  const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
  if (clip && typeof clip.readText === 'function') {
    try {
      return await clip.readText()
    } catch {
      return undefined // permission denied / focus lost
    }
  }
  return undefined
}

function fallbackCopy(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.left = '-9999px'
      document.body.appendChild(ta)
      ta.select()
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- intentional LAN fallback
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      if (ok) resolve()
      else reject(new Error('copy failed'))
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)))
    }
  })
}

/**
 * Handle one native `copy` event. Returns true when we claimed the gesture —
 * the caller then fires `copyTextToClipboard` as the ONE writer (no
 * clipboardData.setData leg: on the hosts that get here the native clipboard
 * is the broken path, and a second writer is how consecutive copies race).
 * Pure enough to unit test without a full DOM.
 */
export function claimNativeCopy(
  selection: string,
  preventDefault: () => void,
  opts?: { hasShell?: boolean; hasTauri?: boolean },
): boolean {
  if (!selection) return false
  if (
    !shouldBridgeNativeCopy({
      hasShell: opts?.hasShell ?? rivetShell() != null,
      hasTauri: opts?.hasTauri ?? (tauriClipboardManager() != null || tauriInternals() != null),
    })
  ) {
    return false
  }
  preventDefault()
  return true
}

/**
 * Route native selection copy (Ctrl/Cmd+C, context-menu Copy) through the
 * IPC chain on hosts whose native clipboard is broken (see module doc).
 * Idempotent — safe to call more than once. No-op wherever Chromium owns
 * the document (Electron shell, any plain browser).
 */
let bridgeInstalled = false

/** Text-like form fields whose selection range the bridge may read. Never
 *  password — a claimed copy would push the secret through IPC — and never
 *  the input types whose selectionStart access throws (number, date, …). */
const TEXT_LIKE_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email'])

interface SelectionField {
  value: string
  selectionStart: number | null
  selectionEnd: number | null
}

function textLikeField(el: { tagName?: string; type?: string } | null): SelectionField | undefined {
  if (!el?.tagName) return undefined
  if (el.tagName === 'TEXTAREA') return el as unknown as SelectionField
  if (el.tagName !== 'INPUT') return undefined
  if (!TEXT_LIKE_INPUT_TYPES.has((el.type ?? 'text').toLowerCase())) return undefined
  return el as unknown as SelectionField
}

/** The gesture's payload: DOM selection, falling back to the focused
 *  text-like field's selection range — WebKit often reports an empty
 *  `window.getSelection()` inside form fields, and bailing there would hand
 *  the composer back to the broken native path this bridge exists for. */
export function bridgeSelectionText(doc: Pick<Document, 'activeElement'> = document): string {
  const sel = typeof window !== 'undefined' ? (window.getSelection()?.toString() ?? '') : ''
  if (sel) return sel
  const field = textLikeField(doc.activeElement)
  if (!field) return ''
  try {
    const { selectionStart, selectionEnd, value } = field
    if (selectionStart != null && selectionEnd != null && selectionEnd > selectionStart) {
      return value.slice(selectionStart, selectionEnd)
    }
  } catch {
    // selectionStart access throws on some input types — treat as no selection
  }
  return ''
}

export function installClipboardBridge(): void {
  if (bridgeInstalled || typeof document === 'undefined') return
  bridgeInstalled = true

  document.addEventListener('copy', (e) => {
    const sel = bridgeSelectionText()
    if (
      !claimNativeCopy(sel, () => {
        e.preventDefault()
      })
    ) {
      return
    }
    // preventDefault already cancelled the UA write — a reject here means
    // the copy was lost, which must at least be visible in the console.
    void copyTextToClipboard(sel).catch((err: unknown) => {
      console.warn('[clipboard] bridged copy failed after claiming the gesture', err)
    })
  })
}
