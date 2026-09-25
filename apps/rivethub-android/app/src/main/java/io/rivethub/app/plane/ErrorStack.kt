package io.rivethub.app.plane

/**
 * Chat error stack (UX-SPEC §1.2): transport and turn errors are cards above
 * the composer, newest at the bottom, each dismissible, with "clear all" when
 * more than one shows. They never replace the transcript.
 *
 * Composer/attachment problems are not stack errors: they keep the one-line
 * strip over the composer because they clear on the next keystroke or send.
 */
data class ChatError(val id: Long, val text: String, val code: String? = null)

/** Default cap — older cards fall off the top. */
const val ERROR_STACK_MAX: Int = 5

const val ERR_CODE_UPLOADING = "uploading"
const val ERR_CODE_TOO_LARGE = "too_large"
const val ERR_CODE_FAILED_ATTACHMENT = "failed_attachment"
const val ERR_CODE_IMAGE_ONLY = "image_only"
const val ERR_CODE_IMAGE_UNSUPPORTED = "image_unsupported"

private val STRIP_ERROR_CODES = setOf(
    ERR_CODE_UPLOADING,
    ERR_CODE_TOO_LARGE,
    ERR_CODE_FAILED_ATTACHMENT,
    ERR_CODE_IMAGE_ONLY,
    ERR_CODE_IMAGE_UNSUPPORTED,
)

/** Appends at the bottom (newest last) and keeps the newest [max]. */
fun pushError(
    list: List<ChatError>,
    text: String,
    code: String?,
    id: Long,
    max: Int = ERROR_STACK_MAX,
): List<ChatError> {
    val next = list + ChatError(id = id, text = text, code = code)
    val cap = max.coerceAtLeast(1)
    return if (next.size > cap) next.takeLast(cap) else next
}

fun dismissError(list: List<ChatError>, id: Long): List<ChatError> = list.filter { it.id != id }

@Suppress("UNUSED_PARAMETER")
fun clearErrors(list: List<ChatError>): List<ChatError> = emptyList()

/** "Clear all" shows only when more than one card is up. */
fun showClearAll(list: List<ChatError>): Boolean = list.size > 1

/** The five composer/attachment codes stay on the strip; everything else stacks. */
fun isStripError(code: String?): Boolean = code != null && code in STRIP_ERROR_CODES

/**
 * De-duplicates an error source that republishes its current error on every
 * change (the terminal attach controller): each distinct text stacks once
 * per session, so repeated publishes add one card and a dismissed card does
 * not come back. A different text is a new failure and stacks; a new
 * [sessionId] starts over.
 */
data class RepeatErrorGate(val sessionId: String = "", val seen: Set<String> = emptySet())

/** Returns the next gate and whether [text] should become a card now. Null/blank never stacks. */
fun RepeatErrorGate.admit(sessionId: String, text: String?): Pair<RepeatErrorGate, Boolean> {
    val base = if (sessionId == this.sessionId) this else RepeatErrorGate(sessionId)
    if (text.isNullOrBlank()) return base to false
    if (text in base.seen) return base to false
    return base.copy(seen = base.seen + text) to true
}
