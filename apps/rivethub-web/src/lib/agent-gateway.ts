import { RivetGateway } from '@rivetos/gateway-client'
import { transportBase } from './mtls-proxy.js'

/**
 * Gateway for an arbitrary node URL, routed through the desktop mTLS pipe
 * (#491) when one exists. Components must never build a RivetGateway from a
 * raw https base — WebKitGTK cannot present a client certificate, so direct
 * calls fail the handshake and every request silently errors.
 */
export async function gatewayFor(baseUrl: string): Promise<RivetGateway> {
  const base = await transportBase(baseUrl.replace(/\/+$/, ''))
  return new RivetGateway({ baseUrl: base, authMode: 'mtls' })
}
