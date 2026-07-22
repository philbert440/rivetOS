/**
 * Clipboard for every Hub surface. The order matters:
 *
 * 1. Tauri clipboard-manager — desktop shell (withGlobalTauri exposes
 *    `__TAURI__.clipboardManager`; we also fall back to
 *    `__TAURI_INTERNALS__.invoke` when the property is missing) and the
 *    Android hub WebView shim (RivetHubBridge → same shape). Required because
 *    WebKitGTK-on-Wayland system clipboard is flaky and non-secure origins
 *    (http:// LAN / loopback in WebView) have no `navigator.clipboard`.
 * 2. navigator.clipboard — browsers on secure origins (https / localhost).
 * 3. execCommand('copy') — LAN http:// in a plain browser (write only).
 *
 * Reads have no execCommand fallback — on a plain-browser LAN origin, paste
 * still works through native paste events (composer textarea, xterm's
 * hidden textarea); readText() is only needed for explicit shortcuts.
 *
 * Selection copy (Ctrl/Cmd+C, context menu) is NOT automatic in the Tauri /
 * Android shells — native WebView clipboard is the broken path. Call
 * `installClipboardBridge()` once at boot so those gestures also ride IPC.
 */

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
  return tauriClipboardManager() != null || tauriInternals() != null
}

/**
 * Whether the document-level copy bridge should take over a native copy
 * gesture. Exported for unit tests.
 */
export function shouldBridgeNativeCopy(
  opts: { hasTauri: boolean; secureContext: boolean } = {
    hasTauri: hasTauriClipboard(),
    secureContext: typeof window !== 'undefined' ? window.isSecureContext : true,
  },
): boolean {
  return opts.hasTauri || !opts.secureContext
}

async function writeViaTauri(text: string): Promise<boolean> {
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
 * Handle one native `copy` event. Returns true when we claimed the gesture
 * (caller should still fire async `copyTextToClipboard`). Pure enough to unit
 * test without a full DOM.
 */
export function claimNativeCopy(
  selection: string,
  clipboardData: { setData(type: string, data: string): void } | null | undefined,
  preventDefault: () => void,
  opts?: { hasTauri?: boolean; secureContext?: boolean },
): boolean {
  if (!selection) return false
  if (
    !shouldBridgeNativeCopy({
      hasTauri: opts?.hasTauri ?? hasTauriClipboard(),
      secureContext:
        opts?.secureContext ?? (typeof window !== 'undefined' ? window.isSecureContext : true),
    })
  ) {
    return false
  }
  try {
    clipboardData?.setData('text/plain', selection)
    preventDefault()
  } catch {
    // Some hosts throw on setData; still claim so the async IPC path runs.
  }
  return true
}

/**
 * Route native selection copy (Ctrl/Cmd+C, context-menu Copy) through the
 * same fallback chain as the code-block button. Without this, those gestures
 * only touch the WebView's broken clipboard and never reach the system.
 *
 * Idempotent — safe to call more than once. No-op when neither Tauri IPC nor
 * a non-secure context needs help (secure browser keeps native behavior).
 */
let bridgeInstalled = false

export function installClipboardBridge(): void {
  if (bridgeInstalled || typeof document === 'undefined') return
  bridgeInstalled = true

  document.addEventListener('copy', (e) => {
    const sel = typeof window !== 'undefined' ? (window.getSelection()?.toString() ?? '') : ''
    if (
      !claimNativeCopy(sel, e.clipboardData, () => {
        e.preventDefault()
      })
    ) {
      return
    }
    void copyTextToClipboard(sel).catch(() => undefined)
  })
}
