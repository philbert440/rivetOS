import type { TermExitFrame, TermHelloFrame, TermOwnerFrame } from '@rivetos/types'

/**
 * Terminal ownership (den #681): one device owns a session's terminal; only
 * the owner's resize reaches the shared PTY. The client tracks the owner from
 * the hello frame's `owner` and the `{type:'owner'}` broadcast, shows a
 * "session is active on <device>" banner to non-owners, and lets them claim
 * the terminal with `{type:'claim'}` ("Use terminal here").
 */

/** Who owns the shared PTY right now. `self` is per-recipient. */
export interface TermOwner {
  device: string
  self: boolean
}

/**
 * Owner state after a hello or owner frame. Hello carries `owner` only when
 * the session already has one (absent → nobody owns it yet); an owner frame
 * with `device: null` clears the state (ownership released). Both frames
 * fully determine the next state, so the previous `_state` is kept only for
 * the reducer contract.
 */
export function reduceOwner(
  _state: TermOwner | undefined,
  frame: TermHelloFrame | TermOwnerFrame,
): TermOwner | undefined {
  if (frame.type === 'hello') return frame.owner
  if (frame.device === null) return undefined
  return { device: frame.device, self: frame.self }
}

/**
 * Banner for a non-owner viewer. Hidden while this device owns the terminal
 * (`self`) or nobody does (sole viewer / pre-claim); a won claim clears it
 * via the `{type:'owner', self:true}` broadcast.
 */
export function ownerBanner(owner: TermOwner | undefined): { show: boolean; label: string } {
  if (!owner || owner.self) return { show: false, label: '' }
  return { show: true, label: `This terminal is active on ${owner.device}.` }
}

/**
 * "Use terminal here" → `{type:'claim'}`. Optional geometry is applied
 * (clamped like resize); omitted → the den reuses this client's last
 * `{type:'resize'}`, or no PTY resize if it never sent one.
 */
export function buildClaimFrame(cols?: number, rows?: number): string {
  if (cols !== undefined && rows !== undefined) return JSON.stringify({ type: 'claim', cols, rows })
  return JSON.stringify({ type: 'claim' })
}

/**
 * Send `{type:'claim'}` on a live socket. Returns false when there is no OPEN
 * socket — the banner button used to swallow that as a silent no-op.
 */
export function sendClaim(
  ws: { readyState: number; send: (data: string) => void } | undefined,
  cols?: number,
  rows?: number,
): boolean {
  if (!ws || ws.readyState !== 1) return false
  ws.send(buildClaimFrame(cols, rows))
  return true
}

/** JSON hello/owner/exit, whether the browser delivered a text frame or (after
 *  binaryType=arraybuffer / a proxy) the same payload as an ArrayBuffer. */
export function parseTermControlFrame(
  data: unknown,
): TermHelloFrame | TermExitFrame | TermOwnerFrame | undefined {
  let text: string | undefined
  if (typeof data === 'string') text = data
  else if (data instanceof ArrayBuffer) {
    const u8 = new Uint8Array(data)
    if (u8.length === 0 || u8[0] !== 0x7b /* '{' */) return undefined
    text = new TextDecoder().decode(u8)
  } else return undefined
  try {
    const raw = JSON.parse(text) as { type?: unknown }
    if (raw?.type === 'hello' || raw?.type === 'owner' || raw?.type === 'exit') {
      return raw as TermHelloFrame | TermExitFrame | TermOwnerFrame
    }
  } catch {
    return undefined
  }
  return undefined
}
