/**
 * Clipboard for every Hub surface. The order matters:
 *
 * 1. Tauri clipboard-manager IPC — the desktop thin shell serves the UI from
 *    the node over LAN http://, a non-secure origin where the browser
 *    Clipboard API DOESN'T EXIST; the IPC path works regardless of origin
 *    (and regardless of Wayland/WebKitGTK clipboard quirks).
 * 2. navigator.clipboard — browsers on secure origins (https / localhost).
 * 3. execCommand('copy') — LAN http:// in a plain browser (write only).
 *
 * Reads have no execCommand fallback — on a plain-browser LAN origin, paste
 * still works through native paste events (composer textarea, xterm's
 * hidden textarea); readText() is only needed for explicit shortcuts.
 */

interface TauriClipboard {
  writeText(text: string): Promise<void>
  readText(): Promise<string>
}

function tauriClipboard(): TauriClipboard | undefined {
  const tauri = (globalThis as { __TAURI__?: { clipboardManager?: TauriClipboard } }).__TAURI__
  return tauri?.clipboardManager
}

export function copyTextToClipboard(text: string): Promise<void> {
  const ipc = tauriClipboard()
  if (ipc) return ipc.writeText(text).catch(() => fallbackCopy(text))
  const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
  if (clip && typeof clip.writeText === 'function') {
    return clip.writeText(text).catch(() => fallbackCopy(text))
  }
  return fallbackCopy(text)
}

/** Resolves undefined when no readable clipboard source exists. */
export async function readTextFromClipboard(): Promise<string | undefined> {
  const ipc = tauriClipboard()
  if (ipc) {
    try {
      return await ipc.readText()
    } catch {
      // fall through to the browser API
    }
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
