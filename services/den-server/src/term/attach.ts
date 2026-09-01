/**
 * HTTP-layer attach descriptor. The manager exposes socket + session only;
 * this module composes host / sshUser / local and never puts argv or env
 * on the wire.
 */

import type { TermAttachInfo } from '@rivetos/types'
import type { PtyInfo } from './manager.js'

export type AttachIdentity = { host: string; sshUser: string }

/** Present only when the row is tmux-backed with a socket + session. */
export function composeTermAttach(
  row: Pick<PtyInfo, 'mux' | 'socket' | 'session'>,
  identity: AttachIdentity,
  local: boolean,
): TermAttachInfo | undefined {
  if (row.mux !== 'tmux' || !row.socket || !row.session) return undefined
  return {
    socket: row.socket,
    session: row.session,
    host: identity.host,
    sshUser: identity.sshUser,
    local,
  }
}

/** Strip manager-only socket/session and stamp `attach` for the HTTP surface. */
export function wirePtyInfo(
  row: PtyInfo,
  identity: AttachIdentity,
  local: boolean,
): Omit<PtyInfo, 'socket' | 'session'> & { attach?: TermAttachInfo } {
  const { socket: _socket, session: _session, ...rest } = row
  const attach = composeTermAttach(row, identity, local)
  return attach ? { ...rest, attach } : rest
}
