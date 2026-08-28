/**
 * Settings → Updates — in-app update for the desktop shell.
 *
 * Thin by design (review, PR #562): the renderer never sees a manifest, a
 * URL, or a digest. It hands the shell the gateway base it is currently
 * connected to; the Electron MAIN process fetches and validates
 * `builds/rivethub/latest.json` over its own mTLS pipe, decides whether the
 * build is newer, and on install re-reads the manifest, downloads, verifies
 * the sha256 it read itself, launches the installer and quits the app.
 *
 * Renders nothing outside an Electron shell that carries the optional
 * update surface (feature-detected; older shells and browsers see nothing).
 */

import { useEffect, useState, type JSX } from 'react'
import { rivetShell } from '../lib/shell-bridge.js'
import { useConnection } from '../stores/connection.js'
import { useConfirmDialog } from './confirm-dialog.js'

type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'current'; version: string }
  | { kind: 'available'; version: string; sizeBytes?: number }
  | { kind: 'installing' }
  | { kind: 'error'; message: string }

export function UpdatesSection(): JSX.Element | null {
  const { baseUrl } = useConnection()
  const shell = rivetShell()
  const dialog = useConfirmDialog()
  const [appVersion, setAppVersion] = useState('')
  const [state, setState] = useState<UpdateState>({ kind: 'idle' })

  const supported = !!shell?.appVersion && !!shell.checkUpdate && !!shell.installUpdate

  useEffect(() => {
    if (!supported) return
    shell.appVersion?.().then(setAppVersion, () => setAppVersion(''))
  }, [supported, shell])

  if (!supported) return null

  const check = async (): Promise<void> => {
    setState({ kind: 'checking' })
    try {
      if (!baseUrl) throw new Error('no connected node')
      const result = await shell.checkUpdate!(baseUrl)
      setAppVersion(result.current)
      if (result.available) {
        setState({ kind: 'available', ...result.available })
      } else {
        setState({ kind: 'current', version: result.current })
      }
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  const install = async (version: string): Promise<void> => {
    if (!baseUrl) return
    const ok = await dialog.confirm(
      `Install RivetHub v${version}? The build is downloaded from the connected node (${baseUrl}), verified, and the installer is launched — RivetHub will QUIT and you reopen it when the install finishes.`,
      { confirmLabel: `Install v${version}` },
    )
    if (!ok) return
    setState({ kind: 'installing' })
    try {
      await shell.installUpdate!(baseUrl)
      // The shell quits itself once the installer is running; nothing to do.
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <>
      <h2 className="mt-10 mb-3 border-t border-line pt-6 font-mono text-sm font-semibold text-em">
        Updates
      </h2>
      <p className="mb-3 text-xs text-ink-dim">
        Checks <span className="font-mono">builds/rivethub/latest.json</span> on the connected
        node&apos;s shared filestore. The shell downloads, verifies, and installs — RivetHub quits
        during the install; reopen it when the installer finishes.
      </p>
      <div className="flex items-center gap-3">
        <button
          onClick={() => void check()}
          disabled={state.kind === 'checking' || state.kind === 'installing'}
          className="rounded bg-em-dim px-4 py-2 text-sm font-medium text-bg hover:bg-em disabled:opacity-50"
        >
          Check for updates
        </button>
        {state.kind === 'available' && (
          <button
            onClick={() => void install(state.version)}
            className="rounded bg-em px-4 py-2 text-sm font-medium text-bg hover:bg-em-dim"
          >
            Install v{state.version}
          </button>
        )}
        <span className="font-mono text-sm">
          {state.kind === 'checking' && <span className="text-ink-dim">checking…</span>}
          {state.kind === 'current' && (
            <span className="text-em">✓ up to date (v{state.version})</span>
          )}
          {state.kind === 'available' && (
            <span className="text-em">
              v{state.version} available
              {state.sizeBytes ? ` (${(state.sizeBytes / 1e6).toFixed(0)} MB)` : ''}
            </span>
          )}
          {state.kind === 'installing' && (
            <span className="text-ink-dim">downloading + verifying…</span>
          )}
          {state.kind === 'error' && <span className="text-red">✗ {state.message}</span>}
        </span>
      </div>
      {appVersion && (
        <div className="mt-2 font-mono text-[11px] text-ink-dim">shell v{appVersion}</div>
      )}
      {dialog.element}
    </>
  )
}
