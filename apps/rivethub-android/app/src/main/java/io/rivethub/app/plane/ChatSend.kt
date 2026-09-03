package io.rivethub.app.plane

import io.rivethub.app.gateway.HarnessTranscriptTurn

import io.rivethub.app.gateway.WsStatus

/**
 * Draft first-send mirrors rivethub-web `injectOne`: a draft injects into
 * the PTY (after spawn); an adopted session uses the harness control plane.
 * A fresh spawn waits for TUI readiness before inject (see [PtyReadyGate]);
 * do not wait for `session-created` before sending — claude's store row is
 * created by the first turn. After inject, poll listSessions / bare-submit.
 */
sealed interface ChatSendAction {
    data class Inject(val sessionId: String, val text: String, val interrupt: Boolean = false) : ChatSendAction
    data class SendTurn(val sessionId: String, val text: String) : ChatSendAction
}

fun chatSendAction(draft: Boolean, sessionId: String, text: String, interrupt: Boolean = false): ChatSendAction =
    if (draft) ChatSendAction.Inject(sessionId, text, interrupt)
    else ChatSendAction.SendTurn(sessionId, text)

data class SpawnAttempt(
    val session: String,
    val command: String? = null,
    val model: String? = null,
    val effort: String? = null,
)

/**
 * API-only agents have no roster command. Try the commanded spawn, then
 * fall back to `{ session }` so a 404 on an unknown command still pins
 * the join key (desktop `chat.tsx` `spawnPty`).
 */
fun spawnAttempts(
    session: String,
    command: String?,
    model: String? = null,
    effort: String? = null,
): List<SpawnAttempt> {
    if (command.isNullOrBlank()) {
        return listOf(SpawnAttempt(session))
    }
    return listOf(
        SpawnAttempt(session, command, model, effort),
        SpawnAttempt(session),
    )
}

/** LRU-evicted PTY: drop the ref and retry inject once, without Esc. */
enum class InjectTry { First, RetryAfterEviction }

fun nextInjectTry(failed: Boolean, alreadyRetried: Boolean): InjectTry? {
    if (!failed) return null
    if (alreadyRetried) return null
    return InjectTry.RetryAfterEviction
}

/**
 * Composer stays usable after a transient error. Only a closed socket
 * bricks send/attach; [error] is advisory and is not part of the gate.
 */
fun composerIsEnabled(ws: WsStatus, error: String?): Boolean = ws != WsStatus.CLOSED

data class ComposerInput(val value: String, val error: String?)

/** Next keystroke drops a transient error so the field cannot brick. */
fun composerOnInput(value: String): ComposerInput = ComposerInput(value, error = null)

/** Next send attempt also drops a transient error (same exit as input). */
fun composerOnSendAttempt(): String? = null

fun chatItemForGate(
    sessionId: String,
    draft: Boolean,
    harnessId: String?,
    title: String,
): ChatItem = ChatItem(
    key = sessionId,
    kind = if (draft) ChatItemKind.DRAFT else ChatItemKind.HARNESS,
    title = title,
    sessionId = sessionId.takeIf { !draft },
    harnessId = harnessId,
)

/**
 * A 409 `turn_in_flight` is stale when the transcript already ends with the assistant's
 * answer to our previous turn — the den still holds the turn only because its hook events
 * never arrived. The desktop's legacy path for that is the PTY inject; so is ours.
 */
fun serverInFlightIsStale(transcript: List<HarnessTranscriptTurn>): Boolean {
    // Our own not-yet-delivered (optimistic) user turns sit at the tail; look past them.
    val settled = transcript.dropLastWhile { it.role == "user" }
    return settled.lastOrNull()?.role == "assistant"
}
