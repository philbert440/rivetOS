/**
 * One way to raise an OS notification, gated on Settings → General.
 *
 * The desktop shell notifies from its main process (no permission
 * handshake). A plain browser uses the Web Notification API, only once the
 * user granted it — `requestBrowserNotifications` asks, from the Settings
 * toggle. The optional chime is synthesised (Web Audio), so no asset ships.
 */

import { rivetShell } from './shell-bridge.js'
import { usePreferences } from '../stores/preferences.js'

export interface OsNotice {
  title: string
  body: string
}

/** True when the window is visible and focused — the in-app view covers it. */
export function windowInFront(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus()
}

function browserNotifications(): typeof Notification | undefined {
  return typeof Notification === 'undefined' ? undefined : Notification
}

/** Whether a notification can be shown here at all (shell, or granted browser). */
export function canNotify(): boolean {
  if (rivetShell()) return true
  return browserNotifications()?.permission === 'granted'
}

/** Ask the browser for notification permission. True when granted. */
export async function requestBrowserNotifications(): Promise<boolean> {
  if (rivetShell()) return true
  const api = browserNotifications()
  if (!api) return false
  if (api.permission === 'granted') return true
  if (api.permission === 'denied') return false
  return (await api.requestPermission()) === 'granted'
}

let audio: AudioContext | undefined

/** Two soft rising notes, ~0.3s. Silently skipped where audio is blocked. */
export function playChime(): void {
  try {
    audio ??= new AudioContext()
    const ctx = audio
    const start = ctx.currentTime
    for (const [i, freq] of [660, 880].entries()) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      const t = start + i * 0.12
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, t)
      gain.gain.exponentialRampToValueAtTime(0.15, t + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18)
      osc.connect(gain).connect(ctx.destination)
      osc.start(t)
      osc.stop(t + 0.2)
    }
  } catch {
    /* no audio here */
  }
}

/** Show `notice` if desktop notifications are on. Never throws. */
export function osNotify(notice: OsNotice): void {
  const prefs = usePreferences.getState()
  if (!prefs.desktopNotifications) return
  const shell = rivetShell()
  if (shell) {
    void shell.sendNotification(notice).catch(() => undefined)
  } else {
    const api = browserNotifications()
    if (api?.permission !== 'granted') return
    try {
      new api(notice.title, { body: notice.body, silent: true })
    } catch {
      return
    }
  }
  if (prefs.notificationSound) playChime()
}
