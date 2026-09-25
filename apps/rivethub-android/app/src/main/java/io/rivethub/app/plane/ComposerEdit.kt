package io.rivethub.app.plane

/**
 * Composer editing mode (UX-SPEC §1.3/§4): a user bubble was picked for
 * editing, its text is back in the composer, and the card shows an
 * "Editing ✕" banner. Bubble-tap wiring arrives separately; this is the state.
 */
data class EditState(val originalText: String)

fun beginEdit(text: String): EditState = EditState(text)

fun editBannerVisible(edit: EditState?): Boolean = edit != null

/**
 * Editing after [outcome] settled (or did not settle) queued item [itemId],
 * whose [OutboundItem.editing] is the edit active when it was sent. Local
 * enqueue is not acceptance: the banner stays while the item is queued.
 *
 * - An outcome for another item, [PumpOutcome.Deferred], a 409
 *   ([RejectReason.TURN_IN_FLIGHT]) or [PumpOutcome.Idle] → [current], unchanged.
 * - [PumpOutcome.Dispatched] → the banner goes, unless the user already began
 *   a different edit ([current] is not the item's edit).
 * - [RejectReason.FAILED] (the caller puts the text back in the composer) →
 *   the item's edit comes back with it ([restoredEdit]).
 */
fun editAfterOutcome(current: EditState?, itemId: String, outcome: PumpOutcome): EditState? {
    if (outcome.itemId != itemId) return current
    return when (outcome) {
        is PumpOutcome.Dispatched -> if (current === outcome.item.editing) null else current
        is PumpOutcome.Rejected ->
            if (outcome.reason == RejectReason.FAILED) restoredEdit(current, outcome.item) else current
        is PumpOutcome.Deferred, PumpOutcome.Idle -> current
    }
}

/** [item]'s text is going back into the composer (hard failure, cancel): its edit comes back too. */
fun restoredEdit(current: EditState?, item: OutboundItem): EditState? = current ?: item.editing

/**
 * The edit a new outbound item carries: [current], unless an item already
 * queued carries it (the banner is still up for that one) — a second message
 * typed meanwhile is new text, not the same edit again.
 */
fun editForEnqueue(current: EditState?, queued: List<OutboundItem>): EditState? =
    current?.takeIf { e -> queued.none { it.editing === e } }
