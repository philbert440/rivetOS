import { useEffect, useRef, useState } from 'react'
import { KeyRound, Monitor, User, Volume2, X } from 'lucide-react'
import { useStore, type AppSettingsSection } from '@/state/store'
import { Card } from './SettingsPrimitives'
import { cn } from '@/lib/cn'
import { getGateway } from '../../lib/gateway.js'
import { saveSession } from '../../lib/users.js'
import { useTeam } from '../../stores/team.js'
import { loadTeamAppSettings, saveTeamAppSettings } from '@/lib/team-settings'
import { voiceStackReady } from '@/lib/tts'

const SECTIONS: Array<{ id: AppSettingsSection; label: string; icon: typeof User }> = [
  { id: 'general', label: 'General', icon: User },
  { id: 'connections', label: 'Connections', icon: KeyRound },
  { id: 'computer', label: 'Node', icon: Monitor },
  { id: 'voice', label: 'Voice', icon: Volume2 },
]

export function SettingsModal() {
  const { state, dispatch } = useStore()
  const section = state.appSettingsSection
  const dialogRef = useRef<HTMLDivElement>(null)
  const userName = useTeam((s) => s.userName)
  const userHandle = useTeam((s) => s.userHandle)
  const live = useTeam((s) => s.live)
  const [saved, setSaved] = useState(() => loadTeamAppSettings())
  const denDefault = getGateway().config.baseUrl

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialog = dialogRef.current
    dialog?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        dispatch({ type: 'toggleAppSettings', open: false })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      previousFocus?.focus()
    }
  }, [dispatch])

  const persist = (patch: Partial<typeof saved>) => {
    const next = { ...saved, ...patch }
    setSaved(next)
    saveTeamAppSettings(next)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onMouseDown={(e) => e.target === e.currentTarget && dispatch({ type: 'toggleAppSettings', open: false })}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-settings-title"
        tabIndex={-1}
        className="flex h-[560px] w-full max-w-[860px] overflow-hidden rounded-2xl border border-hairline/50 bg-panel shadow-2xl outline-none"
      >
        <nav className="flex w-[190px] shrink-0 flex-col gap-0.5 border-r border-hairline/40 p-3">
          <div id="app-settings-title" className="px-2 pt-1 pb-2 text-[15px] font-semibold text-ink">
            Settings
          </div>
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => dispatch({ type: 'toggleAppSettings', open: true, section: id })}
              aria-current={section === id ? 'page' : undefined}
              className={cn(
                'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[14px]',
                section === id ? 'bg-raised text-ink' : 'text-ink-secondary hover:bg-raised/50 hover:text-ink',
              )}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between px-5 py-3">
            <span className="text-[15px] font-semibold text-ink">
              {SECTIONS.find((s) => s.id === section)?.label}
            </span>
            <button
              onClick={() => dispatch({ type: 'toggleAppSettings', open: false })}
              aria-label="Close settings"
              className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
            >
              <X size={18} />
            </button>
          </div>

          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 pb-5">
            {section === 'general' && (
              <Card title="This person" subtitle="Household identity. Chats and notes stay on this person.">
                <div className="text-[15px] text-ink">
                  {userName} <span className="text-ink-secondary">@{userHandle}</span>
                </div>
                <div className="mt-1 text-[13px] text-ink-secondary">{live ? 'store live' : 'stub · local only'}</div>
                <button
                  type="button"
                  className="mt-3 text-[14px] font-medium text-accent"
                  onClick={() => {
                    saveSession(null)
                    window.location.reload()
                  }}
                >
                  Switch person
                </button>
              </Card>
            )}

            {section === 'connections' && (
              <>
                <Card title="Den / node" subtitle="Gateway this client uses for computer and live store.">
                  <input
                    className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink"
                    value={saved.denUrl || denDefault}
                    onChange={(e) => persist({ denUrl: e.target.value })}
                    placeholder="http://127.0.0.1:5174"
                  />
                </Card>
                <Card title="Datahub / wiki" subtitle="Used by the Memory panel. Blank = same origin as den.">
                  <input
                    className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink"
                    value={saved.wikiUrl}
                    onChange={(e) => persist({ wikiUrl: e.target.value })}
                    placeholder="https://datahub-host:5174"
                  />
                </Card>
              </>
            )}

            {section === 'computer' && (
              <Card
                title="Node computer"
                subtitle="Each persona is bound to a Rivet node. The computer panel talks to that den's /api/terminal — not a cloud box."
              >
                <p className="text-[13px] text-ink-secondary">
                  Open a chat, then the monitor icon, to probe that persona's node.
                </p>
              </Card>
            )}

            {section === 'voice' && (
              <Card
                title="Rivet voice"
                subtitle="Speak uses den /api/tts/speak when present, then this device's voice stack. Not ElevenLabs."
              >
                <p className="text-[14px] text-ink">
                  {voiceStackReady() || state.config?.tts?.ready ? 'Ready — hover a reply and tap speak.' : 'No voice stack on this client.'}
                </p>
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
