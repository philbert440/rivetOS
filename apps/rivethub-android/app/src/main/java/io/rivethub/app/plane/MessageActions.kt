package io.rivethub.app.plane

import io.rivethub.app.gateway.HarnessTranscriptTurn

/**
 * Message actions (UX-SPEC §1.3). The den has no message ids and no
 * replace, fork or delete routes, so: Edit pre-fills the composer and sends
 * the result as a NEW turn; Regenerate re-sends the preceding user text as a
 * new turn (after a confirm); Fork and Delete are not offered.
 */
enum class MessageAction { Copy, Regenerate, SelectCopy, Edit, Share }

/**
 * The actions a completed message offers. User: Copy · Edit · SelectCopy ·
 * Share. Assistant: Copy · Regenerate (only with a preceding user turn and
 * no turn in flight) · SelectCopy · Share.
 *
 * [hasBody] false is a turn with no text of its own. A user turn that is only
 * attachments keeps Copy · SelectCopy · Share (over [userActionText], the
 * attachment names) but has nothing to Edit. An assistant turn that is only
 * tool calls offers just Regenerate when allowed, else nothing.
 */
fun messageActions(
    role: String,
    inFlight: Boolean,
    hasPrecedingUser: Boolean,
    hasBody: Boolean = true,
): List<MessageAction> =
    if (role == "user") {
        if (hasBody) {
            listOf(MessageAction.Copy, MessageAction.Edit, MessageAction.SelectCopy, MessageAction.Share)
        } else {
            listOf(MessageAction.Copy, MessageAction.SelectCopy, MessageAction.Share)
        }
    } else {
        buildList {
            if (hasBody) add(MessageAction.Copy)
            if (hasPrecedingUser && !inFlight) add(MessageAction.Regenerate)
            if (hasBody) {
                add(MessageAction.SelectCopy)
                add(MessageAction.Share)
            }
        }
    }

/**
 * The text a user turn's Copy / Select & copy / Share act on: the body, or
 * for an attachment-only turn the attachment names, one per line.
 */
fun userActionText(body: String, refs: List<AttachedRef>): String =
    body.takeIf { it.isNotBlank() } ?: refs.joinToString("\n") { it.name }

/**
 * Whether a completed turn shows its action row: revealed (or the "always"
 * setting on) and at least one action to show.
 */
fun actionRowShown(always: Boolean, revealed: Boolean, actions: List<MessageAction>): Boolean =
    (always || revealed) && actions.isNotEmpty()

/** The actions shown inline in the row (the rest live behind More). */
fun inlineActions(actions: List<MessageAction>): List<MessageAction> =
    actions.filter { it == MessageAction.Copy || it == MessageAction.Regenerate }

/** The More sheet, in its fixed order: Select & copy, Edit, Share. */
fun sheetActions(actions: List<MessageAction>): List<MessageAction> =
    listOf(MessageAction.SelectCopy, MessageAction.Edit, MessageAction.Share).filter { it in actions }

/**
 * The text Regenerate re-sends for the assistant turn at [index]: the nearest
 * preceding user turn's body with its attachment lines stripped. Null when
 * [index] is not an assistant turn, there is no earlier user turn, or that
 * body is blank.
 */
fun regenerateSource(turns: List<HarnessTranscriptTurn>, index: Int): String? {
    if (index !in turns.indices || turns[index].role == "user") return null
    for (i in index - 1 downTo 0) {
        if (turns[i].role == "user") {
            return splitAttachedLines(turns[i].text).first.trim().takeIf { it.isNotEmpty() }
        }
    }
    return null
}

/** The composer pre-fill for editing the user turn at [index] (attachment lines stripped). */
fun editSource(turns: List<HarnessTranscriptTurn>, index: Int): String? {
    val turn = turns.getOrNull(index) ?: return null
    if (turn.role != "user") return null
    return splitAttachedLines(turn.text).first.trim().takeIf { it.isNotEmpty() }
}
