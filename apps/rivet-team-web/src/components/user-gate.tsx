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
    <div className="flex h-full items-center justify-center bg-app px-5">
      <div className="w-full max-w-md">
        <div className="text-[13px] font-semibold tracking-wide text-em">rivet-team</div>
        <h1 className="mt-2 text-[28px] font-semibold text-ink">Who is this?</h1>
        <p className="mt-2 text-[15px] text-ink-secondary">
          Each person has their own chats and notes. They do not share a corpus.
        </p>

        {existing.length > 0 && (
          <div className="mt-6 flex flex-col gap-2">
            {existing.map((u) => (
              <button
                key={u.id}
                type="button"
                className="flex items-center justify-between rounded-2xl bg-card px-4 py-3.5 text-left"
                onClick={() => finish(signInLocal(u))}
              >
                <span>
                  <span className="block text-[16px] font-semibold text-ink">{u.displayName}</span>
                  <span className="font-mono text-[12px] text-ink-secondary">@{u.handle}</span>
                </span>
                <span className="text-[14px] font-medium text-em">Continue</span>
              </button>
            ))}
          </div>
        )}

        <form className="mt-6 flex flex-col gap-2" onSubmit={(e) => void onCreate(e)}>
          <div className="text-[11px] font-mono uppercase tracking-wide text-ink-secondary">
            New person
          </div>
          <input
            className="rounded-xl border border-hairline bg-inset px-3 py-2.5 text-sm text-ink outline-none"
            placeholder="handle (alex)"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            required
          />
          <input
            className="rounded-xl border border-hairline bg-inset px-3 py-2.5 text-sm text-ink outline-none"
            placeholder="display name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded-xl bg-accent px-3 py-2.5 text-sm font-medium text-white disabled:opacity-50"
          >
            Continue
          </button>
        </form>

        <form className="mt-5 flex flex-col gap-2" onSubmit={(e) => void onRedeem(e)}>
          <div className="text-[11px] font-mono uppercase tracking-wide text-ink-secondary">
            I have a pairing code
          </div>
          <input
            className="rounded-xl border border-hairline bg-inset px-3 py-2.5 font-mono text-sm text-ink outline-none"
            placeholder="code from the other device"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <button
            type="submit"
            disabled={busy || !code.trim()}
            className="rounded-xl border border-hairline px-3 py-2.5 text-sm text-ink"
          >
            Redeem
          </button>
        </form>

        {error && <p className="mt-3 text-sm text-danger">{error}</p>}
      </div>
    </div>
  )
}
