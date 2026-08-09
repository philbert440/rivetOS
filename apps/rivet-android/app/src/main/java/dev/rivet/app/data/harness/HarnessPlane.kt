package dev.rivet.app.data.harness

import dev.rivet.app.data.node.NodeAuthOutcome
import dev.rivet.app.ui.pages.terminal.DenHarnessClient

/**
 * Per-session plane selection — the Kotlin twin of
 * `apps/rivethub-web/src/lib/harness-chat.ts`.
 *
 * The drawer used to be one list: the node's on-disk harness stores, read
 * through the legacy `/api/terminal/harness-sessions` scan. The control plane
 * replaces it, but only for harnesses that actually have a registered driver.
 * The legacy scan still reads every roster harness, so dropping it now would
 * delete those conversations from the drawer.
 *
 * So the two are unioned, keyed by bare native session id, with the control
 * plane winning: a driver-owned row carries a canonical SessionId, a harness
 * badge and a real status, and the app then talks to it through
 * the `/api/harness-sessions` family instead of `/v1`. Rows the plane
 * does not claim keep the legacy binding verbatim until their driver lands —
 * no user-facing toggle, no legacy mode to pick.
 *
 * The chat key stays the BARE NATIVE id: on Android it is also the Room
 * conversation UUID, the den PTY join key and the Terminal escalate key. The
 * canonical id rides alongside on the row and is what every control-plane call
 * uses.
 */

/** How one chat row is driven. */
enum class ChatRowKind {
    /** Claimed by a registered driver: control-plane send / stream / resync. */
    HARNESS,

    /** On disk but no driver owns it yet — legacy binding, unchanged. */
    LEGACY,
}

/** One drawer row, whichever plane produced it. */
data class HarnessChatRow(
    /** Den join key = bare native session id. */
    val key: String,
    val kind: ChatRowKind,
    val title: String,
    /** Canonical `<harness-id>:<native>` — set for [ChatRowKind.HARNESS] only. */
    val sessionId: String? = null,
    val harnessId: String? = null,
    /** Den roster command ('claude', 'grok', …) — PTY spawn + accent color. */
    val command: String? = null,
    val status: HarnessStatus? = null,
    /** epoch ms, for ordering */
    val updatedAt: Long = 0L,
)

/** What the UI may offer for a row; every field is a driver capability flag. */
data class HarnessGate(
    /** Driver-owned: turns go through the control plane, not `/v1`. */
    val bound: Boolean = false,
    /** Tail the session socket + hard-resync instead of the 15s poll. */
    val stream: Boolean = false,
    val canInterrupt: Boolean = false,
    val canApprove: Boolean = false,
    val canResume: Boolean = false,
) {
    companion object {
        val CLOSED = HarnessGate()
    }
}

object HarnessPlane {

    /**
     * Merge control-plane sessions with legacy store rows into one list,
     * newest first. A malformed canonical id is the node's bug, not a row —
     * it is skipped rather than shown under a key nothing else can join on.
     */
    fun rows(
        harnessSessions: List<HarnessSessionSummary>,
        legacySessions: List<DenHarnessClient.Session>,
    ): List<HarnessChatRow> {
        val legacyByKey = legacySessions.associateBy { it.id }
        val merged = LinkedHashMap<String, HarnessChatRow>()

        for (summary in harnessSessions) {
            val key = summary.nativeSessionId ?: continue
            val legacy = legacyByKey[key]
            merged[key] = HarnessChatRow(
                key = key,
                kind = ChatRowKind.HARNESS,
                title = summary.title ?: legacy?.title ?: key,
                sessionId = summary.sessionId,
                harnessId = summary.harnessId,
                command = legacy?.command ?: HarnessIds.rosterCommand(summary.harnessId),
                status = summary.status,
                updatedAt = parseIsoMillis(summary.updatedAt) ?: legacy?.updatedAt ?: 0L,
            )
        }

        for (row in legacySessions) {
            if (merged.containsKey(row.id)) continue // the control plane owns this one
            merged[row.id] = HarnessChatRow(
                key = row.id,
                kind = ChatRowKind.LEGACY,
                title = row.title,
                command = row.command,
                updatedAt = row.updatedAt,
            )
        }

        return merged.values.sortedByDescending { it.updatedAt }
    }

    /**
     * Resolve a row against the node's registry sheet.
     *
     * `liveStream = false` keeps the row on the legacy transcript sync while
     * turns still go through the control plane — the send path needs no stream.
     */
    fun gate(row: HarnessChatRow?, descriptors: List<HarnessDescriptor>?): HarnessGate {
        if (row == null || row.kind != ChatRowKind.HARNESS) return HarnessGate.CLOSED
        val harnessId = row.harnessId ?: return HarnessGate.CLOSED
        if (row.sessionId == null) return HarnessGate.CLOSED
        val caps = descriptors?.firstOrNull { it.harnessId == harnessId }?.capabilities
            ?: return HarnessGate.CLOSED
        return HarnessGate(
            bound = true,
            stream = caps.liveStream,
            canInterrupt = caps.interrupt,
            canApprove = caps.approvals,
            canResume = caps.resume,
        )
    }

    /** Harnesses whose sessions are worth asking for (`listSessions` gated). */
    fun listable(descriptors: List<HarnessDescriptor>?): List<String> =
        descriptors.orEmpty().filter { it.capabilities.listSessions }.map { it.harnessId }

    /**
     * `turn_in_flight` — the driver is mid-turn. v1 drivers MUST NOT silently
     * queue, so this is the caller's cue to keep the turn queued and retry, not
     * to fail it. Matched on the typed wire code: HTTP 409 alone also covers
     * `session_id_collision`.
     */
    fun isTurnInFlight(err: Throwable?): Boolean {
        val e = err as? HarnessHttpException ?: return false
        return e.status == 409 && e.code == "turn_in_flight"
    }

    /**
     * Codes that will never succeed on retry: the session is gone, malformed,
     * or the driver has no such capability. Anything else (a node restarting, a
     * transient 5xx) is worth reconnecting for.
     */
    fun isFatal(err: Throwable?): Boolean {
        val e = err as? HarnessHttpException ?: return false
        return e.status in FATAL_STATUS || (e.code != null && e.code in FATAL_CODES)
    }

    /** Also the codes a terminal `error` frame can carry on the socket. */
    private val FATAL_CODES = setOf("invalid_session_id", "capability_unsupported")

    /**
     * What one control-plane read says about this client's credential.
     *
     * Only an explicit refusal counts as an auth answer. A 404 is a node with no
     * control plane, an exhausted socket is a phone on a bad radio — neither is
     * evidence about a bearer, so both stay [NodeAuthOutcome.INDETERMINATE] and
     * leave whatever the last real answer was in place.
     */
    fun authOutcome(err: Throwable?): NodeAuthOutcome {
        if (err == null) return NodeAuthOutcome.AUTHORIZED
        val status = (err as? HarnessHttpException)?.status
            ?: return NodeAuthOutcome.INDETERMINATE
        return if (status in AUTH_STATUS) {
            NodeAuthOutcome.UNAUTHORIZED
        } else {
            NodeAuthOutcome.INDETERMINATE
        }
    }

    private val AUTH_STATUS = setOf(401, 403)

    /**
     * Gone (404), malformed (400), unsupported (501) — and refused (401/403).
     *
     * Auth belongs here rather than in the retry bucket: a bearer that is wrong
     * now is wrong on the next attempt too, and treating it as transient turns
     * a misconfigured node into a silent background poll that never surfaces
     * why nothing is arriving.
     */
    private val FATAL_STATUS = setOf(400, 401, 403, 404, 501)

    /**
     * Epoch millis from an ISO-8601 instant, or null when it is absent or
     * unparseable. `updatedAt` only orders the drawer, so a bad value must not
     * throw a row away.
     */
    fun parseIsoMillis(iso: String?): Long? {
        if (iso.isNullOrBlank()) return null
        return runCatching { java.time.Instant.parse(iso).toEpochMilli() }.getOrNull()
    }
}
