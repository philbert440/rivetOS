import { useState, type FormEvent, type JSX } from 'react'
import {
  createLocalUser,
  listLocalUsers,
  saveSession,
  signInLocal,
  tryCreateLiveUser,
  tryRedeemLive,
  type TeamSession,
} from '../lib/users.js'

export function UserGate({ onReady }: { onReady: (session: TeamSession) => void }): JSX.Element {
  const existing = listLocalUsers()
  const [handle, setHandle] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const finish = (session: TeamSession): void => {
    saveSession(session)
    onReady(session)
  }

  const onCreate = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const live = await tryCreateLiveUser(handle, displayName)
      if (live) {
        finish(live)
        return
      }
      finish(signInLocal(createLocalUser(handle, displayName)))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const onRedeem = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const live = await tryRedeemLive(code)
      if (!live) throw new Error('pairing code not accepted (is den-server on this node?)')
      finish(live)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-bg px-4">
      <div className="w-full max-w-md rounded-2xl border border-line bg-panel p-6">
        <div className="font-mono text-sm font-semibold tracking-wide text-em">rivet-team</div>
        <h1 className="mt-2 text-xl font-medium text-ink">Who is this?</h1>
        <p className="mt-1 text-sm text-ink-dim">
          Each person has their own personas and memory. They do not share the
          lab corpus.
        </p>

        {existing.length > 0 && (
          <div className="mt-4 flex flex-col gap-2">
            {existing.map((u) => (
              <button
                key={u.id}
                type="button"
                className="rounded-lg border border-line px-3 py-2 text-left text-sm text-ink hover:bg-panel-2"
                onClick={() => finish(signInLocal(u))}
              >
                <span className="font-medium">{u.displayName}</span>
                <span className="ml-2 font-mono text-[11px] text-ink-dim">{u.handle}</span>
              </button>
            ))}
          </div>
        )}

        <form className="mt-5 flex flex-col gap-2" onSubmit={(e) => void onCreate(e)}>
          <div className="text-[11px] font-mono uppercase tracking-wide text-ink-dim">
            New person
          </div>
          <input
            className="rounded-lg border border-line bg-bg px-3 py-2 text-sm text-ink"
            placeholder="handle (alex)"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            required
          />
          <input
            className="rounded-lg border border-line bg-bg px-3 py-2 text-sm text-ink"
            placeholder="display name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-em/20 px-3 py-2 text-sm text-em"
          >
            Continue
          </button>
        </form>

        <form className="mt-5 flex flex-col gap-2" onSubmit={(e) => void onRedeem(e)}>
          <div className="text-[11px] font-mono uppercase tracking-wide text-ink-dim">
            I have a pairing code
          </div>
          <input
            className="rounded-lg border border-line bg-bg px-3 py-2 font-mono text-sm text-ink"
            placeholder="code from the other device"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <button
            type="submit"
            disabled={busy || !code.trim()}
            className="rounded-lg border border-line px-3 py-2 text-sm text-ink"
          >
            Redeem
          </button>
        </form>

        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      </div>
    </div>
  )
}
