import { useState, type JSX } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { isValidGatewayUrl, useConnection } from '../stores/connection.js'
import { RivetGateway } from '@rivetos/gateway-client'
import { isValidWikiUrl, useWikiSettings } from '../stores/wiki-settings.js'
import { BUILD_INFO } from '../lib/build-info.js'
import { DevicesSection } from '../components/devices-section.js'

type ProbeState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok'; node: string; agents: number }
  | { kind: 'fail'; message: string }

export function SettingsPage(): JSX.Element {
  const { baseUrl, token, setConnection } = useConnection()
  const queryClient = useQueryClient()
  const [draftUrl, setDraftUrl] = useState(baseUrl)
  const [draftToken, setDraftToken] = useState(token ?? '')
  const [probe, setProbe] = useState<ProbeState>({ kind: 'idle' })
  const { wikiUrl, setWikiUrl } = useWikiSettings()
  const [draftWiki, setDraftWiki] = useState(wikiUrl)
  const [wikiNotice, setWikiNotice] = useState('')

  const test = async (): Promise<void> => {
    setProbe({ kind: 'testing' })
    const gw = new RivetGateway({
      baseUrl: draftUrl.trim().replace(/\/+$/, ''),
      token: draftToken.trim() || undefined,
    })
    if (!(await gw.health())) {
      setProbe({ kind: 'fail', message: 'unreachable (healthz failed)' })
      return
    }
    try {
      const sheet = await gw.catalog()
      setProbe({ kind: 'ok', node: sheet.node, agents: sheet.agents.length })
    } catch (err) {
      setProbe({ kind: 'fail', message: (err as Error).message })
    }
  }

  const save = (): void => {
    const url = draftUrl.trim().replace(/\/+$/, '')
    if (!isValidGatewayUrl(url)) {
      setProbe({ kind: 'fail', message: 'invalid gateway URL (http(s)://host[:port] only)' })
      return
    }
    setConnection(url, draftToken.trim() || undefined)
    // Saved endpoints join the switcher roster (name = host, editable later).
    useConnection.getState().addNode({ name: new URL(url).host, baseUrl: url })
    // Drop every cached response from the previous endpoint/credential.
    void queryClient.invalidateQueries()
  }

  return (
    <div className="mx-auto max-w-xl px-6 py-8">
      <h1 className="mb-6 font-mono text-lg font-semibold text-em">Settings</h1>

      <label className="mb-1 block text-xs text-ink-dim">Gateway URL (origin only)</label>
      <input
        value={draftUrl}
        onChange={(e) => setDraftUrl(e.target.value)}
        placeholder="http://node-host:5174"
        className="mb-4 w-full rounded border border-line bg-panel px-3 py-2 font-mono text-sm outline-none focus:border-em"
      />

      <label className="mb-1 block text-xs text-ink-dim">
        Bearer token (only if the node gates its gateway)
      </label>
      <input
        value={draftToken}
        onChange={(e) => setDraftToken(e.target.value)}
        type="password"
        autoComplete="off"
        className="mb-6 w-full rounded border border-line bg-panel px-3 py-2 font-mono text-sm outline-none focus:border-em"
      />

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
        Memory wiki
      </h2>
      <label className="mb-1 block text-xs text-ink-dim">
        Wiki URL (the node that serves /wiki for the mesh; blank = this node's /wiki)
      </label>
      <input
        value={draftWiki}
        onChange={(e) => setDraftWiki(e.target.value)}
        placeholder="http://datahub-host/wiki"
        className="mb-3 w-full rounded border border-line bg-panel px-3 py-2 font-mono text-sm outline-none focus:border-em"
      />
      <div className="flex items-center gap-3">
        <button
          onClick={() => {
            const url = draftWiki.trim().replace(/\/+$/, '')
            if (url && !isValidWikiUrl(url)) {
              setWikiNotice('✗ invalid wiki URL (http(s) only)')
              return
            }
            setWikiUrl(url)
            setDraftWiki(url)
            setWikiNotice(url ? '✓ saved' : '✓ cleared — using this node’s /wiki')
          }}
          className="rounded bg-em-dim px-4 py-2 text-sm font-medium text-bg hover:bg-em"
        >
          Save wiki URL
        </button>
        <span
          className={`font-mono text-sm ${wikiNotice.startsWith('✗') ? 'text-red' : 'text-em'}`}
        >
          {wikiNotice}
        </span>
      </div>

      <DevicesSection />

      {/* Build stamp — the desktop shell bakes this dist in at build time, so
          this line is how you tell whether a binary has gone stale. */}
      <div className="mt-10 border-t border-line pt-3 font-mono text-[11px] text-ink-dim">
        RivetHub v{BUILD_INFO.version} · dist {BUILD_INFO.sha} · built {BUILD_INFO.builtAt}
      </div>
    </div>
  )
}
