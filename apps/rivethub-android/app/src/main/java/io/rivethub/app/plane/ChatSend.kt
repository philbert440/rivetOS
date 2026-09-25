package io.rivethub.app.plane

import io.rivethub.app.gateway.HarnessTranscriptTurn

import io.rivethub.app.gateway.WsStatus

/**
 * Raised when a preset spawn stops the attempt loop. A recorded directory
 * asks before retrying with force. Hosted-elsewhere and a missing directory
 * stop with the den text already on the error strip and nothing to confirm.
 * Not a failed send: callers must not replace that strip.
 */
class SpawnNeedsConfirm : Exception()

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
    /** Preset id for the first attempt. Null on the explicit and bare fallbacks. */
    val agentId: String? = null,
    /** True only after the user confirms a recorded-directory resume. */
    val force: Boolean = false,
)

/** Why a preset spawn came back 409. Null unless the status is 409. */
enum class SpawnConflict { HostedElsewhere, NoDirectory, RecordedDir, Other }

/**
 * Map a spawn failure. Only HTTP 409 is a conflict; the den's `error` text
 * picks the case. Anything else 409 is [SpawnConflict.Other].
 */
fun spawnConflict(status: Int, errorText: String?): SpawnConflict? {
    if (status != 409) return null
    val text = errorText.orEmpty()
    return when {
        text.contains("hosted on") -> SpawnConflict.HostedElsewhere
        text.contains("has no directory") -> SpawnConflict.NoDirectory
        text.contains("session runs in") -> SpawnConflict.RecordedDir
        else -> SpawnConflict.Other
    }
}

/** Same attempt, with force set. Never called automatically. */
fun forcedRetry(attempt: SpawnAttempt): SpawnAttempt = attempt.copy(force = true)

/**
 * True when this 409 ends the attempt list. [SpawnConflict.Other] is the
 * only kind that may fall through. Hosted-elsewhere and a missing directory
 * have already understood `agentId`; a later explicit spawn would open the
 * wrong place.
 */
fun spawnConflictStops(conflict: SpawnConflict): Boolean = when (conflict) {
    SpawnConflict.RecordedDir,
    SpawnConflict.HostedElsewhere,
    SpawnConflict.NoDirectory -> true
    SpawnConflict.Other -> false
}

/**
 * Error strip when the loop stops. Hosted-elsewhere and a missing directory
 * keep [denText] (the success path must not clear it — there is no later
 * attempt). A recorded directory uses the confirm dialog, not this strip.
 */
fun spawnStopError(conflict: SpawnConflict, denText: String?, status: Int): String? = when (conflict) {
    SpawnConflict.HostedElsewhere, SpawnConflict.NoDirectory -> denText ?: "HTTP $status"
    SpawnConflict.RecordedDir, SpawnConflict.Other -> null
}

/**
 * Strip text for a failed `agentId` attempt that does not stop the loop.
 * 404 stays silent so the explicit fallback can run. Any other continued
 * failure (400 harness or model/effort, 500 directory, a non-stopping 409)
 * is the den text, shown before the next attempt.
 */
fun agentAttemptFallbackError(status: Int, denText: String?): String? {
    val conflict = spawnConflict(status, denText)
    if (conflict != null && spawnConflictStops(conflict)) return null
    if (status == 404) return null
    return denText ?: "HTTP $status"
}

/**
 * Strip text after a spawn attempt succeeds. A non-stopping agentId failure
 * (503 registry, 500 directory, 409 [SpawnConflict.Other]) has already put
 * the den text on the strip. The agentId-less fallback can still open a
 * session, in the den's default cwd, and that success must not clear the
 * text — [surfaced] is not a reason to erase [current]. The next send
 * clears the strip via [composerOnSendAttempt].
 */
fun spawnSuccessError(current: String?, surfaced: String?): String? = current

/**
 * Preset-opened spawn. A non-blank [agentId] tries the preset first with
 * the roster [command] and no model or effort — the den fills those and the
 * cwd, and the command keeps a pre-registry den on that harness — then the
 * explicit command (dropped when [command] is blank), then a session-only
 * spawn. The later attempts run only after a failure that does not stop.
 * A blank [agentId] is today's commanded fallback.
 */
fun spawnAttempts(
    session: String,
    command: String?,
    model: String?,
    effort: String?,
    agentId: String?,
): List<SpawnAttempt> {
    val id = agentId?.trim()?.takeIf { it.isNotEmpty() }
        ?: return spawnAttempts(session, command, model, effort)
    val cmd = command?.takeIf { it.isNotBlank() }
    val first = SpawnAttempt(session = session, command = cmd, agentId = id)
    if (cmd == null) return listOf(first, SpawnAttempt(session))
    return listOf(
        first,
        SpawnAttempt(session, cmd, model, effort),
        SpawnAttempt(session),
    )
}

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
