import { useEffect, useState, type JSX } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { isValidGatewayUrl, useConnection } from '../stores/connection.js'
import { useTheme } from '../stores/theme.js'
import type { ThemePreference } from '../lib/theme.js'
import { gatewayFor } from '../lib/agent-gateway.js'
import { isValidWikiBase } from '../lib/wiki-base.js'
import { useWikiSettings } from '../stores/wiki-settings.js'
import { BUILD_INFO } from '../lib/build-info.js'
import { DevicesSection } from '../components/devices-section.js'
import { UpdatesSection } from '../components/updates-section.js'
import { TerminalSection } from '../components/terminal-section.js'

type ProbeState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok'; node: string; agents: number }
  | { kind: 'fail'; message: string }

/**
 * Saved-node roster editor: rename or repoint a node in place instead of
 * remove + re-add (which loses list position and, for the active node,
 * drops the connection first). Editing the active node's URL repoints live.
 */
function SavedNodesSection(): JSX.Element {
  const { baseUrl, roster, updateNode, removeNode } = useConnection()
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [draftNodeUrl, setDraftNodeUrl] = useState('')
  const [notice, setNotice] = useState('')

  const beginEdit = (name: string, url: string): void => {
    setEditing(url)
    setDraftName(name)
    setDraftNodeUrl(url)
    setNotice('')
  }

  const commitEdit = (): void => {
    if (editing === null) return
    const url = draftNodeUrl.trim().replace(/\/+$/, '')
    if (!isValidGatewayUrl(url)) {
      setNotice('✗ invalid gateway URL (http(s)://host[:port] only)')
      return
    }
    if (!draftName.trim()) {
      setNotice('✗ name required')
      return
    }
    const wasActive = editing === baseUrl
    updateNode(editing, { name: draftName.trim(), baseUrl: url })
    // Repointing the live connection invalidates every cached response.
    if (wasActive && url !== editing) void queryClient.invalidateQueries()
    setEditing(null)
    setNotice('✓ saved')
  }

  return (
    <>
      <h2 className="mt-10 mb-3 border-t border-line pt-6 font-mono text-sm font-semibold text-em">
        Saved nodes
      </h2>
      {roster.length === 0 && <p className="text-xs text-ink-dim">No saved nodes yet.</p>}
      {roster.map((n) =>
        editing === n.baseUrl ? (
          <div key={n.baseUrl} className="mb-2 rounded border border-line bg-panel p-2">
            <input
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              placeholder="Name"
              className="mb-1 w-full rounded border border-line bg-panel-2 px-2 py-1 font-mono text-xs outline-none focus:border-em"
            />
            <input
              value={draftNodeUrl}
              onChange={(e) => setDraftNodeUrl(e.target.value)}
              placeholder="https://node-host:5174"
              className="mb-2 w-full rounded border border-line bg-panel-2 px-2 py-1 font-mono text-xs outline-none focus:border-em"
            />
            <div className="flex gap-2">
              <button
                onClick={commitEdit}
                className="rounded bg-em-dim px-3 py-1 text-xs font-medium text-bg hover:bg-em"
              >
                Save
              </button>
              <button
                onClick={() => setEditing(null)}
                className="rounded border border-line px-3 py-1 text-xs hover:border-em"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div key={n.baseUrl} className="mb-1 flex items-center gap-2">
            <span className="flex-1 truncate font-mono text-xs" title={n.baseUrl}>
              {n.baseUrl === baseUrl ? '● ' : '○ '}
              {n.name}
              <span className="ml-2 text-ink-dim">{n.baseUrl}</span>
            </span>
            <button
              onClick={() => beginEdit(n.name, n.baseUrl)}
              className="rounded border border-line px-2 py-0.5 text-xs text-ink-dim hover:border-em hover:text-ink"
              aria-label={`edit ${n.name}`}
            >
              Edit
            </button>
            <button
              onClick={() => removeNode(n.baseUrl)}
              className="rounded border border-line px-2 py-0.5 text-xs text-ink-dim hover:border-em hover:text-red"
              aria-label={`remove ${n.name}`}
            >
              Remove
            </button>
          </div>
        ),
      )}
      {notice && <p className="mt-1 font-mono text-[10px] text-ink-dim">{notice}</p>}
    </>
  )
}

export function SettingsPage(): JSX.Element {
  const { baseUrl, setConnection } = useConnection()
  const themePreference = useTheme((s) => s.preference)
  const setThemePreference = useTheme((s) => s.setPreference)
  const omarchy = useTheme((s) => s.omarchy)
  const queryClient = useQueryClient()
  const [draftUrl, setDraftUrl] = useState(baseUrl)
  // The Saved Nodes editor below can repoint baseUrl from within this page —
  // without this sync, Save here would silently revert that edit.
  useEffect(() => {
    setDraftUrl(baseUrl)
  }, [baseUrl])
  const [probe, setProbe] = useState<ProbeState>({ kind: 'idle' })
  const { wikiBaseUrl, setWikiBaseUrl } = useWikiSettings()
  const [draftWiki, setDraftWiki] = useState(wikiBaseUrl)
  const [wikiNotice, setWikiNotice] = useState('')

  const test = async (): Promise<void> => {
    setProbe({ kind: 'testing' })
    try {
      // gatewayFor, not a raw RivetGateway on the typed URL: in a desktop
      // shell the page cannot present a client certificate, so a direct
      // https probe false-fails nodes that work fine after Save (the #554
      // transport rule). transportBase keys its pipe map on the base it is
      // GIVEN (per-target shell pipe, falling back to that same base), so
      // this always exercises the typed origin — never the saved node's
      // transport.
      const gw = await gatewayFor(draftUrl.trim().replace(/\/+$/, ''))
      if (!(await gw.health())) {
        setProbe({ kind: 'fail', message: 'unreachable (healthz failed)' })
        return
      }
      const sheet = await gw.catalog()
      setProbe({ kind: 'ok', node: sheet.node, agents: sheet.agents.length })
    } catch (err) {
      // Without this, a throw out of transport resolution would stick the
      // probe on 'testing' forever.
      setProbe({ kind: 'fail', message: (err as Error).message })
    }
  }

  const save = (): void => {
    const url = draftUrl.trim().replace(/\/+$/, '')
    if (!isValidGatewayUrl(url)) {
      setProbe({ kind: 'fail', message: 'invalid gateway URL (http(s)://host[:port] only)' })
      return
    }
    setConnection(url)
    // Saved endpoints join the switcher roster (name = host, editable later).
    useConnection.getState().addNode({ name: new URL(url).host, baseUrl: url })
    // Drop every cached response from the previous endpoint.
    void queryClient.invalidateQueries()
  }

  return (
    <div className="mx-auto max-w-xl px-6 py-8">
      <h1 className="mb-6 font-mono text-lg font-semibold text-em">Settings</h1>

      <label className="mb-1 block text-xs text-ink-dim">Gateway URL (origin only)</label>
      <input
        value={draftUrl}
        onChange={(e) => setDraftUrl(e.target.value)}
        placeholder="https://node-host:5174"
        className="mb-2 w-full rounded border border-line bg-panel px-3 py-2 font-mono text-sm outline-none focus:border-em"
      />
      <p className="mb-6 text-xs text-ink-dim">
        Auth is a Rivet CA <span className="font-mono">device:</span> client certificate installed
        on this browser/OS (see <span className="font-mono">docs/GATEWAY-MTLS.md</span>). Bearer
        tokens are no longer used.
      </p>

      <div className="flex items-center gap-3">
        <button
          onClick={() => void test()}
          className="rounded border border-line bg-panel-2 px-4 py-2 text-sm hover:border-em"
        >
          Test connection
        </button>
        <button
          onClick={save}
          className="rounded bg-em-dim px-4 py-2 text-sm font-medium text-bg hover:bg-em"
        >
          Save
        </button>
      </div>

      <div className="mt-4 min-h-6 font-mono text-sm">
        {probe.kind === 'testing' && <span className="text-ink-dim">probing…</span>}
        {probe.kind === 'ok' && (
          <span className="text-em">
            ✓ node “{probe.node}” — {probe.agents} agent{probe.agents === 1 ? '' : 's'}
          </span>
        )}
        {probe.kind === 'fail' && <span className="text-red">✗ {probe.message}</span>}
      </div>

      <h2 className="mt-10 mb-3 border-t border-line pt-6 font-mono text-sm font-semibold text-em">
        Appearance
      </h2>
      <div className="flex items-center gap-3">
        <div className="flex gap-2" role="group" aria-label="Theme">
          {(
            [
              ['light', 'Light'],
              ['dark', 'Dark'],
              ['system', 'System'],
              ['omarchy', 'Omarchy'],
            ] as [ThemePreference, string][]
          ).map(([value, label]) => {
            const disabled = value === 'omarchy' && omarchy === null
            return (
              <button
                key={value}
                type="button"
                aria-pressed={themePreference === value}
                disabled={disabled}
                title={disabled ? 'No Omarchy theme found — desktop only' : undefined}
                onClick={() => setThemePreference(value)}
                className={
                  themePreference === value
                    ? 'rounded bg-em-dim px-4 py-2 text-sm font-medium text-bg disabled:cursor-not-allowed disabled:opacity-50'
                    : 'rounded border border-line bg-panel-2 px-4 py-2 text-sm hover:border-em disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-line'
                }
              >
                {label}
              </button>
            )
          })}
        </div>
        {themePreference === 'omarchy' && omarchy?.name ? (
          <span className="text-xs text-ink-dim">{omarchy.name}</span>
        ) : null}
      </div>
      <p className="mt-2 text-xs text-ink-dim">System follows the OS light/dark setting.</p>

      <TerminalSection />

      <SavedNodesSection />

      <h2 className="mt-10 mb-3 border-t border-line pt-6 font-mono text-sm font-semibold text-em">
        Memory wiki (datahub)
      </h2>
      <p className="mb-3 text-xs text-ink-dim">
        Datahub holds memory Search, Browse, Stats, and the wiki. Hub reads{' '}
        <span className="font-mono">/api/memory</span> and{' '}
        <span className="font-mono">/api/wiki</span> on this origin. Blank = discover datahub from
        the mesh roster of the connected node.
      </p>
      <label className="mb-1 block text-xs text-ink-dim">
        Datahub gateway origin (http(s)://host[:port] only)
      </label>
      <input
        value={draftWiki}
        onChange={(e) => setDraftWiki(e.target.value)}
        placeholder="https://datahub-host:5174"
        className="mb-3 w-full rounded border border-line bg-panel px-3 py-2 font-mono text-sm outline-none focus:border-em"
      />
      <div className="flex items-center gap-3">
        <button
          onClick={() => {
            const raw = draftWiki.trim()
            if (raw && !isValidWikiBase(raw)) {
              setWikiNotice('✗ invalid origin (http(s)://host[:port] only; /wiki path is stripped)')
              return
            }
            setWikiBaseUrl(raw)
            const saved = useWikiSettings.getState().wikiBaseUrl
            setDraftWiki(saved)
            setWikiNotice(
              saved ? '✓ saved datahub origin' : '✓ cleared — will discover datahub from mesh',
            )
          }}
          className="rounded bg-em-dim px-4 py-2 text-sm font-medium text-bg hover:bg-em"
        >
          Save datahub URL
        </button>
        <span
          className={`font-mono text-sm ${wikiNotice.startsWith('✗') ? 'text-red' : 'text-em'}`}
        >
          {wikiNotice}
        </span>
      </div>

      <DevicesSection />

      <UpdatesSection />

      {/* Build stamp — the desktop shell bakes this dist in at build time, so
          this line is how you tell whether a binary has gone stale. */}
      <div className="mt-10 border-t border-line pt-3 font-mono text-[11px] text-ink-dim">
        RivetHub v{BUILD_INFO.version} · dist {BUILD_INFO.sha} · built {BUILD_INFO.builtAt}
      </div>
    </div>
  )
}
