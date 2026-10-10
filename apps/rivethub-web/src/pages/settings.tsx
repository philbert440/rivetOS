import { useEffect, useState, type JSX } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { isValidGatewayUrl, useConnection } from '../stores/connection.js'
import { useTheme } from '../stores/theme.js'
import { useConversationView } from '../stores/conversation-view.js'
import type { ThemePreference } from '../lib/theme.js'
import { gatewayFor } from '../lib/agent-gateway.js'
import { isValidWikiBase } from '../lib/wiki-base.js'
import { useWikiSettings } from '../stores/wiki-settings.js'
import { BUILD_INFO } from '../lib/build-info.js'
import { DevicesSection } from '../components/devices-section.js'
import { PhonePairingSection } from '../components/phone-pairing-section.js'
import { UpdatesSection } from '../components/updates-section.js'
import { TerminalSection } from '../components/terminal-section.js'
import { Toggle } from '../components/ui/toggle.js'
import { Select } from '../components/select.js'
import { KeyBindingsSection } from '../components/key-bindings-section.js'
import { DEFAULT_OMARCHY_PRESET, OMARCHY_PRESETS } from '../lib/omarchy-presets.js'
import { useExperimental } from '../stores/experimental.js'
import { usePreferences } from '../stores/preferences.js'
import { useRosterAgents } from '../lib/use-agent-roster.js'
import { canNotify, playChime, requestBrowserNotifications } from '../lib/os-notify.js'
import { rivetShell } from '../lib/shell-bridge.js'
import type { ThinkingLevel } from '@rivetos/types'
import { SETTINGS_TABS, settingsTab } from '../lib/settings-tabs.js'
import { cn } from '../lib/utils.js'

/** Section heading; a tab's first one drops the rule above it. */
const H2 = 'mt-10 mb-3 border-t border-line pt-6 font-mono text-sm font-semibold text-em'

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
      <h2 className={H2}>Saved nodes</h2>
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

/** Read-only registry facts for the connected node (`GET /api/agents`). */
function AgentsSettingsBlock(): JSX.Element {
  const baseUrl = useConnection((s) => s.baseUrl)
  const transportEpoch = useConnection((s) => s.transportEpoch)
  const agents = useQuery({
    queryKey: ['settings-agents', baseUrl, transportEpoch],
    enabled: Boolean(baseUrl),
    staleTime: 30_000,
    retry: false,
    queryFn: async ({ signal }) => (await gatewayFor(baseUrl)).agentsList(signal),
  })
  const row = (label: string, value: string | undefined): JSX.Element => (
    <div className="mb-1 flex gap-2 text-xs">
      <span className="w-32 shrink-0 text-ink-dim">{label}</span>
      <span className="min-w-0 break-all font-mono text-ink">{value || '—'}</span>
    </div>
  )
  return (
    <>
      <h2 className={H2}>Agents</h2>
      <p className="mb-3 text-xs text-ink-dim">
        The shared directory comes from <span className="font-mono">RIVETOS_SHARED_DIR</span> /{' '}
        <span className="font-mono">mesh.storage_dir</span> on the node.
      </p>
      {agents.isLoading && <p className="text-xs text-ink-dim">loading…</p>}
      {agents.isError && <p className="text-xs text-red">Could not read agents on this node.</p>}
      {agents.data && (
        <>
          {row('Backend', agents.data.backend)}
          {row('Node', agents.data.node)}
          {row('Directory root', agents.data.directoryRoot)}
          {row('Shared directory', agents.data.sharedDir)}
        </>
      )}
    </>
  )
}

export function SettingsPage(): JSX.Element {
  const tab = settingsTab(useParams({ strict: false }).tab)
  return (
    <div className="mx-auto max-w-4xl px-4 py-8 md:px-6">
      <h1 className="mb-6 font-mono text-lg font-semibold text-em">Settings</h1>
      <div className="flex flex-col gap-6 md:flex-row md:gap-10">
        <nav
          aria-label="Settings"
          className="-mx-4 flex shrink-0 gap-1 overflow-x-auto px-4 md:mx-0 md:w-40 md:flex-col md:overflow-visible md:px-0"
        >
          {SETTINGS_TABS.map((t) => (
            <Link
              key={t.id}
              to="/settings/$tab"
              params={{ tab: t.id }}
              aria-current={t.id === tab ? 'page' : undefined}
              className={cn(
                'shrink-0 rounded px-3 py-1.5 text-sm whitespace-nowrap',
                t.id === tab
                  ? 'bg-panel-2 font-medium text-em'
                  : 'text-ink-dim hover:bg-panel-2 hover:text-ink',
              )}
            >
              {t.label}
            </Link>
          ))}
        </nav>
        {/* The first heading of a tab sits at the top: no rule above it. */}
        <div
          data-settings-tab={tab}
          className="min-w-0 max-w-xl flex-1 [&>h2:first-child]:mt-0 [&>h2:first-child]:border-t-0 [&>h2:first-child]:pt-0"
        >
          {tab === 'general' && (
            <>
              <NewConversationSection />
              <ConversationsSection />
              <NotificationsSection />
            </>
          )}
          {tab === 'appearance' && (
            <>
              <AppearanceSection />
              <TerminalSection />
            </>
          )}
          {tab === 'keyboard' && <KeyBindingsSection />}
          {tab === 'node' && (
            <>
              <GatewaySection />
              <SavedNodesSection />
              <AgentsSettingsBlock />
              <DatahubSection />
            </>
          )}
          {tab === 'devices' && (
            <>
              <PhonePairingSection />
              <DevicesSection />
            </>
          )}
          {tab === 'advanced' && (
            <>
              <ExperimentalSection />
              <UpdatesSection />
              {/* Build stamp — the desktop shell bakes this dist in at build time, so
                  this line is how you tell whether a binary has gone stale. */}
              <div className="mt-10 border-t border-line pt-3 font-mono text-[11px] text-ink-dim">
                RivetHub v{BUILD_INFO.version} · dist {BUILD_INFO.sha} · built {BUILD_INFO.builtAt}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** The connected node's gateway: type an origin, probe it, save it. */
function GatewaySection(): JSX.Element {
  const { baseUrl, setConnection } = useConnection()
  const queryClient = useQueryClient()
  const [draftUrl, setDraftUrl] = useState(baseUrl)
  // The Saved Nodes editor below can repoint baseUrl from within this page —
  // without this sync, Save here would silently revert that edit.
  useEffect(() => {
    setDraftUrl(baseUrl)
  }, [baseUrl])
  const [probe, setProbe] = useState<ProbeState>({ kind: 'idle' })

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
    <>
      <h2 className={H2}>Gateway</h2>
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
    </>
  )
}

function AppearanceSection(): JSX.Element {
  const themePreference = useTheme((s) => s.preference)
  const setThemePreference = useTheme((s) => s.setPreference)
  const omarchy = useTheme((s) => s.omarchy)
  const applyPreset = useTheme((s) => s.applyPreset)
  const liveOmarchy = omarchy?.source === 'live'
  const presetId =
    OMARCHY_PRESETS.find((p) => p.name === omarchy?.name)?.id ?? DEFAULT_OMARCHY_PRESET
  return (
    <>
      <h2 className={H2}>Theme</h2>
      <div className="flex items-center gap-3">
        <div className="flex gap-2" role="group" aria-label="Theme">
          {(
            [
              ['light', 'Light'],
              ['dark', 'Dark'],
              ['system', 'System'],
              ['omarchy', 'Omarchy'],
            ] as [ThemePreference, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={themePreference === value}
              onClick={() => {
                // No palette yet (browser, Android, a desktop without
                // Omarchy): Omarchy starts on the default preset.
                if (value === 'omarchy' && omarchy === null) applyPreset(DEFAULT_OMARCHY_PRESET)
                else setThemePreference(value)
              }}
              className={
                themePreference === value
                  ? 'rounded bg-em-dim px-4 py-2 text-sm font-medium text-bg'
                  : 'rounded border border-line bg-panel-2 px-4 py-2 text-sm hover:border-em'
              }
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {themePreference === 'omarchy' &&
        (liveOmarchy ? (
          <p className="mt-3 text-xs text-ink-dim">
            Following your Omarchy theme{omarchy.name ? ` — ${omarchy.name}` : ''}. Switch themes in
            Omarchy and RivetHub restyles right away.
          </p>
        ) : (
          <div className="mt-3 flex items-center gap-3">
            <label htmlFor="omarchy-preset" className="text-xs text-ink-dim">
              Omarchy palette
            </label>
            <Select
              id="omarchy-preset"
              aria-label="Omarchy palette"
              value={presetId}
              options={OMARCHY_PRESETS.map((p) => ({ value: p.id, label: p.name }))}
              onChange={(id) => applyPreset(id)}
            />
          </div>
        ))}
      <p className="mt-2 text-xs text-ink-dim">
        System follows the OS light/dark setting. Omarchy follows your live Omarchy theme on the
        desktop app, or a built-in Omarchy palette anywhere else. With no choice made, RivetHub
        follows Omarchy whenever it finds it.
      </p>
    </>
  )
}

/** Unfinished features, off until turned on here. */
function ExperimentalSection(): JSX.Element {
  const experimental = useExperimental((s) => s.experimental)
  const setFiles = useExperimental((s) => s.setFiles)
  const setTasks = useExperimental((s) => s.setTasks)
  const setWorkflows = useExperimental((s) => s.setWorkflows)
  const canvasEnabled = useConversationView((s) => s.canvasEnabled)
  const setCanvasEnabled = useConversationView((s) => s.setCanvasEnabled)
  return (
    <>
      <h2 className={H2}>Experimental features</h2>
      <p className="mb-3 text-xs text-ink-dim">These are unfinished — turn them on to try them.</p>
      {(
        [
          [
            'spaces-canvas',
            'Spaces canvas — on a wide screen, conversations open on a zoomable canvas instead of the list',
            canvasEnabled,
            setCanvasEnabled,
          ],
          ['exp-files', 'Files', experimental.files, setFiles],
          ['exp-tasks', 'Tasks', experimental.tasks, setTasks],
          ['exp-workflows', 'Workflows', experimental.workflows, setWorkflows],
        ] as const
      ).map(([id, label, value, onChange]) => (
        <div key={id} className="mb-2 flex items-center justify-between gap-3">
          <label htmlFor={id} className="text-xs text-ink-dim">
            {label}
          </label>
          <Toggle id={id} value={value} onChange={onChange} />
        </div>
      ))}
    </>
  )
}

/** Where memory Search / Browse / Stats / wiki are read from. */
function DatahubSection(): JSX.Element {
  const { wikiBaseUrl, setWikiBaseUrl } = useWikiSettings()
  const [draftWiki, setDraftWiki] = useState(wikiBaseUrl)
  const [wikiNotice, setWikiNotice] = useState('')
  return (
    <>
      <h2 className={H2}>Memory wiki (datahub)</h2>
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
    </>
  )
}

/** Which view a conversation opens on — new ones and old ones never switched. */
function ConversationsSection(): JSX.Element {
  const defaultView = useConversationView((s) => s.defaultView)
  const setDefaultView = useConversationView((s) => s.setDefaultView)
  const autoScroll = usePreferences((s) => s.autoScroll)
  const setPrefs = usePreferences((s) => s.set)
  return (
    <>
      <h2 className={H2}>Conversations</h2>
      <div className="flex items-center gap-3">
        <span className="text-xs text-ink-dim">Default view</span>
        <div className="flex gap-2" role="group" aria-label="Default view">
          {(
            [
              ['terminal', 'Terminal'],
              ['chat', 'Chat'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={defaultView === value}
              onClick={() => setDefaultView(value)}
              className={
                defaultView === value
                  ? 'rounded bg-em-dim px-4 py-2 text-sm font-medium text-bg'
                  : 'rounded border border-line bg-panel-2 px-4 py-2 text-sm hover:border-em'
              }
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-2 text-xs text-ink-dim">
        Where a conversation opens: new ones, and older ones you have not switched. Switching
        between Terminal and Chat inside a conversation is remembered for that conversation.
        Sessions that only run in a terminal always open there.
      </p>
      <ToggleRow
        id="pref-autoscroll"
        label="Jump to the newest message"
        value={autoScroll}
        onChange={(on) => setPrefs({ autoScroll: on })}
        hint="When a reply arrives or the agent finishes, Chat scrolls to it even if you scrolled up. Off: Chat only follows while you are already at the bottom."
      />
    </>
  )
}

function ToggleRow(props: {
  id: string
  label: string
  value: boolean
  onChange: (on: boolean) => void
  hint?: string
  disabled?: boolean
}): JSX.Element {
  return (
    <div className="mt-4">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={props.id} className="text-xs text-ink-dim">
          {props.label}
        </label>
        <Toggle
          id={props.id}
          value={props.value}
          onChange={props.onChange}
          disabled={props.disabled}
        />
      </div>
      {props.hint ? <p className="mt-1 text-xs text-ink-dim">{props.hint}</p> : null}
    </div>
  )
}

const EFFORT_OPTIONS: { value: ThinkingLevel | ''; label: string }[] = [
  { value: '', label: "Agent's default" },
  { value: 'off', label: 'Off' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'X-High' },
]

/** What a new conversation starts with, outside a space that has defaults. */
function NewConversationSection(): JSX.Element {
  const newChat = usePreferences((s) => s.newChat)
  const setNewChat = usePreferences((s) => s.setNewChat)
  const { agents: roster, isLoading } = useRosterAgents()
  const agents = roster.filter((row) => row.sourceNodeBaseUrl.length > 0)
  const missing =
    !isLoading && newChat.agentId !== undefined && !agents.some((a) => a.id === newChat.agentId)
  return (
    <>
      <h2 className={H2}>New conversations</h2>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor="pref-agent" className="text-xs text-ink-dim">
          Agent
        </label>
        <Select
          id="pref-agent"
          aria-label="Default agent"
          value={missing ? '' : (newChat.agentId ?? '')}
          options={[
            { value: '', label: 'None (plain chat)' },
            ...agents.map((row) => ({ value: row.id, label: row.name })),
          ]}
          onChange={(id) =>
            setNewChat({
              agentId: id,
              harnessId: agents.find((row) => row.id === id)?.harnessId,
            })
          }
        />
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <label htmlFor="pref-effort" className="text-xs text-ink-dim">
          Thinking level
        </label>
        <Select
          id="pref-effort"
          aria-label="Default thinking level"
          value={newChat.effort ?? ''}
          options={EFFORT_OPTIONS}
          onChange={(value) => setNewChat({ effort: (value || undefined) as ThinkingLevel })}
        />
      </div>
      <p className="mt-2 text-xs text-ink-dim">
        Used by + new and Ctrl+T. An agent picked in the sidebar, or a canvas space with its own
        defaults, takes precedence.
        {missing ? ' The saved agent is not on any connected node, so new chats start plain.' : ''}
      </p>
    </>
  )
}

function NotificationsSection(): JSX.Element {
  const desktop = usePreferences((s) => s.desktopNotifications)
  const finished = usePreferences((s) => s.notifyAgentFinished)
  const sound = usePreferences((s) => s.notificationSound)
  const setPrefs = usePreferences((s) => s.set)
  const [allowed, setAllowed] = useState(canNotify)
  const browser = !rivetShell()
  const turnOn = async (on: boolean): Promise<void> => {
    if (on && browser) setAllowed(await requestBrowserNotifications())
    setPrefs({ desktopNotifications: on })
  }
  return (
    <>
      <h2 className={H2}>Notifications</h2>
      <ToggleRow
        id="pref-notify"
        label="Desktop notifications"
        value={desktop}
        onChange={(on) => void turnOn(on)}
        hint={
          browser && desktop && !allowed
            ? 'This browser has not allowed notifications. Allow them for this site, or use the desktop app.'
            : 'Escalations, workflow gates and the alerts below, while RivetHub is in the background. In-app toasts always show.'
        }
      />
      <ToggleRow
        id="pref-notify-finished"
        label="When an agent finishes a reply"
        value={finished}
        disabled={!desktop}
        onChange={(on) => setPrefs({ notifyAgentFinished: on })}
        hint="Not for the conversation you are looking at."
      />
      <ToggleRow
        id="pref-notify-sound"
        label="Play a sound"
        value={sound}
        disabled={!desktop}
        onChange={(on) => {
          setPrefs({ notificationSound: on })
          if (on) playChime()
        }}
      />
    </>
  )
}
