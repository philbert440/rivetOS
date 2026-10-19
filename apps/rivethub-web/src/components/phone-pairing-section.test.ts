import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { expect, it, vi } from 'vitest'
import type { PhonePairingCode, PhonePairingStatus } from '@rivetos/types'
import { PairingCard } from './phone-pairing-section.js'

// The card only reaches the gateway from its status query, which a server
// render never runs; the real store needs browser storage at import.
vi.mock('../stores/connection.js', () => ({ useConnection: { getState: () => ({}) } }))

// The RivetHub runtime mints a random device id ("d" + 32 hex) for each code;
// the card names the phone by what the owner typed, not by that id.
const code: PhonePairingCode = {
  deviceId: 'd00112233445566778899aabbccddeeff',
  gateway: 'https://192.0.2.10:5174',
  expiresAt: Date.now() + 600_000,
  qrText: 'one-time-token',
  reshown: false,
  addedToUsers: false,
}

function render(status?: PhonePairingStatus): string {
  const client = new QueryClient()
  if (status) client.setQueryData(['phone-pairing', code.deviceId, code.expiresAt], status)
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(PairingCard, { code, name: 'pixel-8', onDone: () => {} }),
    ),
  )
}

it('names the phone being paired, not the node-issued device id', () => {
  const html = render()
  expect(html).toContain('pixel-8 · reaches this computer at')
  expect(html).not.toContain(code.deviceId)
})

it('names the phone once it has paired', () => {
  const html = render({ state: 'paired' })
  expect(html).toContain('Paired ✓ pixel-8.')
  expect(html).not.toContain(code.deviceId)
})
