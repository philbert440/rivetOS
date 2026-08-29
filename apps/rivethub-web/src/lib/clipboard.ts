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

export function copyTextToClipboard(text: string): Promise<void> {
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

export function installClipboardBridge(): void {
  if (bridgeInstalled || typeof document === 'undefined') return
  bridgeInstalled = true

  document.addEventListener('copy', (e) => {
    const sel = typeof window !== 'undefined' ? (window.getSelection()?.toString() ?? '') : ''
    if (
      !claimNativeCopy(sel, () => {
        e.preventDefault()
      })
    ) {
      return
    }
    void copyTextToClipboard(sel).catch(() => undefined)
  })
}
