package io.rivethub.app.plane

import io.rivethub.app.gateway.TermOwner
import io.rivethub.app.gateway.TermOwnerFrame

/**
 * Terminal ownership (den #681): one device owns a session's terminal; only
 * the owner's resize reaches the shared PTY. Twin of rivethub-web
 * `lib/owner-banner.ts`. The attach tracks the owner from the hello `owner`
 * and the `{type:'owner'}` broadcast; a non-owner sees the "session is
 * active on <device>" overlay with "Use terminal here" (`{type:'claim'}`).
 */

/**
 * Owner state from an `{type:'owner'}` broadcast: `device` null clears it
 * (nobody owns the PTY); otherwise the frame fully determines the new owner.
 */
fun ownerFromFrame(frame: TermOwnerFrame): TermOwner? =
    frame.device?.let { TermOwner(device = it, self = frame.self) }

data class OwnerOverlay(val show: Boolean, val label: String)

/**
 * Overlay for a non-owner viewer. Hidden while this device owns the terminal
 * (`self`) or nobody does (sole viewer / pre-claim); a won claim clears it
 * via the `{type:'owner', self:true}` broadcast.
 */
fun ownerOverlay(owner: TermOwner?): OwnerOverlay {
    if (owner == null || owner.self) return OwnerOverlay(show = false, label = "")
    return OwnerOverlay(show = true, label = "This terminal is active on ${owner.device}.")
}
