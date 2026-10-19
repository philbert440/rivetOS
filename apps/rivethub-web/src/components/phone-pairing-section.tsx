// Settings → Pair a phone: mint a one-time pairing code on this node and show
// it as a QR for RivetHub Android's "Scan pairing QR". The node mints a
// one-time enrollment token from its certificate authority for a fresh device
// id, and the phone redeems it with its own key. The code carries that token for the
// phone's certificate, so it renders only on explicit click and goes away
// once used, expired or dismissed. Owner only: other users' devices and nodes
// without the device CA see nothing, or the reason pairing is unavailable.

import { useEffect, useRef, useState, type JSX } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import QRCode from 'qrcode'
import type { PhonePairingCode } from '@rivetos/types'
import { GatewayError } from '@rivetos/gateway-client'
import { useConnection } from '../stores/connection.js'
import { useGatewayReady } from './not-connected.js'

/** Same charset the node's CA accepts for a device name. */
const NAME = /^[A-Za-z0-9._-]{1,64}$/

/** `name` is what the owner typed; the node's device id is not a name on the RivetHub runtime. */
export function PairingCard(props: {
  code: PhonePairingCode
  name: string
  onDone: () => void
}): JSX.Element {
  const { code, name, onDone } = props
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [remaining, setRemaining] = useState(Math.max(0, code.expiresAt - Date.now()))

  const status = useQuery({
    queryKey: ['phone-pairing', code.deviceId, code.expiresAt],
    queryFn: ({ signal }) =>
      useConnection.getState().gateway.phonePairingStatus(code.deviceId, signal),
    // Watch for the phone redeeming the code; stop once it has, the code
    // lapsed, or the check failed (the Check again button retries).
    refetchInterval: (q) =>
      q.state.status === 'error' ||
      Date.now() >= code.expiresAt ||
      (q.state.data !== undefined && q.state.data.state !== 'pending')
        ? false
        : 2000,
    retry: false,
  })
  const state = remaining <= 0 && status.data?.state !== 'paired' ? 'expired' : status.data?.state

  useEffect(() => {
    if (canvasRef.current && state !== 'paired' && state !== 'expired') {
      void QRCode.toCanvas(canvasRef.current, code.qrText, {
        width: 280,
        margin: 2,
        errorCorrectionLevel: 'M',
        color: { dark: '#0d1117', light: '#ffffff' },
      })
    }
  }, [code.qrText, state])

  useEffect(() => {
    const t = setInterval(() => setRemaining(Math.max(0, code.expiresAt - Date.now())), 1000)
    return () => clearInterval(t)
  }, [code.expiresAt])

  const host = code.gateway.replace(/^https:\/\//, '')
  return (
    <div className="mt-4 border border-line bg-panel p-4 text-center">
      {state === 'paired' ? (
        <p className="py-8 text-sm text-em">
          Paired ✓ {name}. RivetHub on the phone is connecting.
        </p>
      ) : state === 'expired' ? (
        <p className="py-8 text-sm text-ink-dim">This code expired or was used. Show a new one.</p>
      ) : status.isError ? (
        <div className="py-8 text-sm text-ink-dim">
          <p>
            Could not check whether the phone used this code ({status.error.message}). It still
            works until it expires.
          </p>
          <button
            onClick={() => void status.refetch()}
            className="rounded-pill mt-3 border border-line px-3 py-1 text-xs hover:bg-ink/6 hover:text-em classic:hover:bg-transparent classic:hover:border-em"
          >
            Check again
          </button>
        </div>
      ) : (
        <>
          <canvas ref={canvasRef} className="mx-auto bg-white p-1" aria-label="Pairing QR code" />
          <p className="mt-3 text-sm text-ink">
            Scan it with the phone&apos;s camera — it opens RivetHub — or open RivetHub and tap{' '}
            <span className="text-em">Scan pairing QR</span>.
          </p>
          <p className="mt-1 text-xs text-ink-dim">
            {name} · reaches this computer at <span className="font-mono">{host}</span> · works once
            · expires in {Math.ceil(remaining / 60_000)}m
          </p>
          <p className="mt-1 text-xs text-ink-dim">
            The phone must be on the same network. If it cannot reach this computer, allow
            RivetHub&apos;s Nearby devices (local network) permission in Android settings.
          </p>
        </>
      )}
      <button
        onClick={onDone}
        className="rounded-pill mt-3 border border-line px-3 py-1 text-xs text-ink-dim hover:bg-ink/6 hover:text-em classic:hover:bg-transparent classic:hover:border-em"
      >
        {state === 'paired' || state === 'expired' ? 'Close' : 'Cancel'}
      </button>
    </div>
  )
}

export function PhonePairingSection(): JSX.Element | null {
  const connected = useGatewayReady()
  const [name, setName] = useState('')
  const [host, setHost] = useState('')
  const [code, setCode] = useState<{ code: PhonePairingCode; name: string } | null>(null)

  const info = useQuery({
    queryKey: ['phone-pairing-info'],
    queryFn: ({ signal }) => useConnection.getState().gateway.phonePairingInfo(signal),
    enabled: connected,
    retry: false,
  })

  const create = useMutation({
    mutationFn: (args: { name: string; host?: string }) =>
      useConnection.getState().gateway.phonePairingCreate(args.name, {
        host: args.host,
      }),
    onSuccess: (res, args) => {
      setCode({ code: res, name: args.name })
      setName('')
    },
  })

  if (!connected) return null
  // 403 = not the owner, 503/404 = pairing is off or this den predates it:
  // keep Settings uncluttered rather than showing a control that cannot work.
  if (info.isError) {
    const status = info.error instanceof GatewayError ? info.error.status : 0
    if (status === 403 || status === 404 || status === 503) return null
  }
  if (!info.data) return null

  const trimmed = name.trim()
  const hostTrimmed = host.trim()
  const valid = NAME.test(trimmed)
  const submit = (): void => {
    if (!valid || create.isPending) return
    create.mutate({ name: trimmed, host: hostTrimmed || undefined })
  }
  return (
    <section>
      <h2 className="mt-10 mb-3 border-t border-line/60 pt-6 text-base font-semibold text-ink classic:border-line classic:text-em classic:text-sm">
        Pair a phone
      </h2>
      {info.data.available ? (
        <>
          <p className="mb-4 text-xs text-ink-dim">
            Connect RivetHub for Android to this computer by scanning a code. The phone gets its own
            certificate, and nothing is copied or typed.
            {info.data.gateway && (
              <>
                {' '}
                The phone will dial <span className="font-mono">{info.data.gateway}</span>
                {hostTrimmed ? '' : ' (override below if that address is wrong)'}.
              </>
            )}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
              }}
              placeholder="phone name (e.g. pixel-8)"
              aria-label="Phone name"
              className="w-64 border border-line bg-panel px-3 py-2 text-sm outline-none focus:border-em"
            />
            <input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
              }}
              placeholder="gateway host (optional)"
              aria-label="Gateway host override"
              className="w-56 border border-line bg-panel px-3 py-2 text-sm outline-none focus:border-em"
            />
            <button
              onClick={submit}
              disabled={!valid || create.isPending}
              className="rounded-pill bg-em px-3 py-2 text-sm font-medium text-on-em hover:bg-em-dim disabled:opacity-50 classic:font-semibold classic:text-bg"
            >
              {create.isPending ? 'Preparing…' : 'Show pairing code'}
            </button>
          </div>
          {trimmed !== '' && !valid && (
            <p className="mt-2 text-xs text-warn">Use letters, digits, “.”, “_” and “-” only.</p>
          )}
          {create.isError && <p className="mt-2 text-sm text-red">{create.error.message}</p>}
          {code && <PairingCard code={code.code} name={code.name} onDone={() => setCode(null)} />}
        </>
      ) : (
        <p className="text-xs text-ink-dim">Pairing is unavailable here: {info.data.reason}.</p>
      )}
    </section>
  )
}
