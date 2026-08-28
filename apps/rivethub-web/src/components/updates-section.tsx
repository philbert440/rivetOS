/**
 * Settings → Updates — in-app update for the desktop shell.
 *
 * The mesh filestore carries `builds/rivethub/latest.json` (published from
 * the build host next to the artifacts). This section reads it through the
 * connected gateway's /api/files surface — the same mTLS loopback pipe every
 * other request rides — compares against the shell's own version, and hands
 * the shell a download URL + sha256 to verify and launch (updater.ts in the
 * electron app).
 *
 * Renders nothing outside an Electron shell that carries the optional
 * update surface (feature-detected; older shells and browsers see nothing).
 */

import { useEffect, useState, type JSX } from 'react'
import { rivetShell } from '../lib/shell-bridge.js'
import { transportBase } from '../lib/mtls-proxy.js'
import { useConnection } from '../stores/connection.js'

interface ManifestEntry {
  version: string
  file: string
  sha256: string
  sizeBytes?: number
}

type Manifest = Partial<Record<string, ManifestEntry>>

type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'current'; version: string }
  | { kind: 'available'; entry: ManifestEntry; base: string }
  | { kind: 'installing' }
  | { kind: 'error'; message: string }

/** Plain-semver compare: newer(a, b) — true when a > b. Non-semver = false. */
function newer(a: string, b: string): boolean {
  const pa = a.split('-')[0].split('.').map(Number)
  const pb = b.split('-')[0].split('.').map(Number)
  if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return false
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
  }
  return false
}

const MANIFEST_PATH = 'builds/rivethub/latest.json'

export function UpdatesSection(): JSX.Element | null {
  const { baseUrl } = useConnection()
  const shell = rivetShell()
  const [appVersion, setAppVersion] = useState('')
  const [state, setState] = useState<UpdateState>({ kind: 'idle' })

  const supported = !!shell?.appVersion && !!shell.installUpdate && !!shell.platform

  useEffect(() => {
    if (!supported) return
    shell.appVersion?.().then(setAppVersion, () => setAppVersion(''))
  }, [supported, shell])

  if (!supported) return null

  const check = async (): Promise<void> => {
    setState({ kind: 'checking' })
    try {
      if (!baseUrl) throw new Error('no connected node')
      const base = await transportBase(baseUrl.replace(/\/+$/, ''))
      const res = await fetch(
        `${base}/api/files/download?path=${encodeURIComponent(MANIFEST_PATH)}`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(`no update manifest on this node (${res.status})`)
      const manifest = (await res.json()) as Manifest
      const entry = manifest[shell.platform ?? '']
      if (!entry?.version || !entry.file || !entry.sha256)
        throw new Error(`manifest has no build for ${shell.platform ?? 'this platform'}`)
      const current = await shell.appVersion!()
      setAppVersion(current)
      if (newer(entry.version, current)) setState({ kind: 'available', entry, base })
      else setState({ kind: 'current', version: current })
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  const install = async (entry: ManifestEntry, base: string): Promise<void> => {
    setState({ kind: 'installing' })
    try {
      const url = `${base}/api/files/download?path=${encodeURIComponent(
        `builds/rivethub/${entry.file}`,
      )}`
      await shell.installUpdate!({ url, version: entry.version, sha256: entry.sha256 })
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
        Checks <span className="font-mono">{MANIFEST_PATH}</span> on the connected node&apos;s
        shared filestore. Installing downloads the new build, verifies it, launches the installer,
        and quits — reopen RivetHub when it finishes.
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
            onClick={() => void install(state.entry, state.base)}
            className="rounded bg-em px-4 py-2 text-sm font-medium text-bg hover:bg-em-dim"
          >
            Install v{state.entry.version}
          </button>
        )}
        <span className="font-mono text-sm">
          {state.kind === 'checking' && <span className="text-ink-dim">checking…</span>}
          {state.kind === 'current' && (
            <span className="text-em">✓ up to date (v{state.version})</span>
          )}
          {state.kind === 'available' && (
            <span className="text-em">v{state.entry.version} available</span>
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
    </>
  )
}
