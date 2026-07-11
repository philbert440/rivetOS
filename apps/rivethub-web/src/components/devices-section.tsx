// Settings → Devices: enrolled mesh devices (list + revoke) and the
// Add-device flow — mint an enrollment on the node, render the returned
// payload as a QR, and let the phone's "Scan from desktop" camera take it
// from there. The QR carries mesh credentials (PG URL), so it renders only
// on explicit click and disappears when dismissed or expired.

import { useEffect, useRef, useState, type JSX } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import QRCode from 'qrcode'
import type { DeviceOpenResponse } from '@rivetos/types'
import { useConnection } from '../stores/connection.js'
import { useGatewayReady } from './not-connected.js'

function fmtHandshake(ms: number | null): string {
  if (!ms) return 'never'
  const ago = Date.now() - ms
  if (ago < 90_000) return 'just now'
  if (ago < 3_600_000) return `${Math.round(ago / 60_000)}m ago`
  if (ago < 86_400_000) return `${Math.round(ago / 3_600_000)}h ago`
  return `${Math.round(ago / 86_400_000)}d ago`
}

function QrCard({ open, onDone }: { open: DeviceOpenResponse; onDone: () => void }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [remaining, setRemaining] = useState(Math.max(0, open.expiresAt - Date.now()))

  useEffect(() => {
    // If the node wasn't configured with an external URL, substitute the
    // origin THIS client reached it at — same network vantage as the phone.
    const payload = {
      ...open.qr,
      gateway: open.qr.gateway || useConnection.getState().baseUrl,
    }
    if (canvasRef.current)
      void QRCode.toCanvas(canvasRef.current, JSON.stringify(payload), {
        width: 280,
        margin: 2,
        color: { dark: '#0d1117', light: '#ffffff' },
      })
  }, [open])

  useEffect(() => {
    const t = setInterval(() => setRemaining(Math.max(0, open.expiresAt - Date.now())), 1000)
    return () => clearInterval(t)
  }, [open.expiresAt])

  const expired = remaining <= 0
  return (
    <div className="mt-4 rounded border border-line bg-panel p-4 text-center">
      {expired ? (
        <p className="py-8 text-sm text-ink-dim">Enrollment expired — mint a new one.</p>
      ) : (
        <>
          <canvas ref={canvasRef} className="mx-auto rounded bg-white p-1" />
          <p className="mt-3 text-sm text-ink">
            Scan with RivetHub on the phone:{' '}
            <span className="font-mono">Settings → Node &amp; Mesh → Scan from desktop</span>
          </p>
          <p className="mt-1 text-xs text-ink-dim">
            {open.name} · will get <span className="font-mono">{open.address}</span> · expires in{' '}
            {Math.ceil(remaining / 60_000)}m · contains mesh credentials — keep it on your screen
            only
          </p>
        </>
      )}
      <button
        onClick={onDone}
        className="mt-3 rounded border border-line px-3 py-1 text-xs text-ink-dim hover:border-em hover:text-em"
      >
        {expired ? 'Close' : 'Done'}
      </button>
    </div>
  )
}

export function DevicesSection(): JSX.Element | null {
  const connected = useGatewayReady()
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [openEnroll, setOpenEnroll] = useState<DeviceOpenResponse | null>(null)

  const list = useQuery({
    queryKey: ['devices'],
    queryFn: ({ signal }) => useConnection.getState().gateway.devicesList(signal),
    enabled: connected,
    refetchInterval: openEnroll ? 3000 : 30_000, // watch for the phone landing
  })

  const add = useMutation({
    mutationFn: (n: string) => useConnection.getState().gateway.deviceAdd(n),
    onSuccess: (res) => {
      setOpenEnroll(res)
      setName('')
      void queryClient.invalidateQueries({ queryKey: ['devices'] })
    },
  })

  const revoke = useMutation({
    mutationFn: (id: string) => useConnection.getState().gateway.deviceRevoke(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['devices'] }),
  })

  // Enrollment landed (pending → devices) — retire the QR automatically.
  useEffect(() => {
    if (!openEnroll || !list.data) return
    if (list.data.devices.some((d) => d.id === openEnroll.id)) setOpenEnroll(null)
  }, [list.data, openEnroll])

  if (!connected) return null
  // 503 = enrollment not enabled on this node — keep Settings uncluttered.
  if (list.isError && /disabled/.test(list.error.message)) return null

  const devices = list.data?.devices ?? []
  const pending = list.data?.pending ?? []

  return (
    <section className="mt-10">
      <h2 className="mb-1 font-mono text-base font-semibold text-em">Devices</h2>
      <p className="mb-4 text-xs text-ink-dim">
        Phones and other devices enrolled on the mesh through this node.
        {list.data && !list.data.relayConfigured && (
          <span className="text-amber-400">
            {' '}
            Relay driver not configured — enrollments record here, but the WireGuard peer must be
            added by hand.
          </span>
        )}
      </p>

      {list.isLoading && <p className="text-sm text-ink-dim">Loading…</p>}
      {list.isError && !/disabled/.test(list.error.message) && (
        <p className="text-sm text-red-400">{list.error.message}</p>
      )}

      {devices.length > 0 && (
        <ul className="divide-y divide-line rounded border border-line">
          {devices.map((d) => (
            <li key={d.id} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-ink">{d.name}</div>
                <div className="truncate font-mono text-xs text-ink-dim">
                  {d.address} · {d.publicKey.slice(0, 12)}… · handshake{' '}
                  {fmtHandshake(d.lastHandshake)}
                </div>
              </div>
              <button
                onClick={() => {
                  if (window.confirm(`Revoke "${d.name}"? It loses mesh access immediately.`))
                    revoke.mutate(d.id)
                }}
                disabled={revoke.isPending}
                className="rounded border border-line px-2 py-1 text-xs text-red-400 hover:border-red-400 disabled:opacity-50"
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
      {devices.length === 0 && !list.isLoading && !list.isError && (
        <p className="text-sm text-ink-dim">No devices enrolled yet.</p>
      )}

      {pending.length > 0 && (
        <p className="mt-2 text-xs text-ink-dim">
          Pending: {pending.map((p) => `${p.name} (${p.address})`).join(', ')}
        </p>
      )}

      <div className="mt-4 flex items-center gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="device name (e.g. Phil's phone)"
          className="w-64 rounded border border-line bg-panel px-3 py-2 text-sm outline-none focus:border-em"
        />
        <button
          onClick={() => add.mutate(name.trim() || 'device')}
          disabled={add.isPending}
          className="rounded bg-em px-3 py-2 text-sm font-semibold text-black hover:opacity-90 disabled:opacity-50"
        >
          {add.isPending ? 'Minting…' : 'Add device'}
        </button>
      </div>
      {add.isError && <p className="mt-2 text-sm text-red-400">{add.error.message}</p>}

      {openEnroll && <QrCard open={openEnroll} onDone={() => setOpenEnroll(null)} />}
    </section>
  )
}
