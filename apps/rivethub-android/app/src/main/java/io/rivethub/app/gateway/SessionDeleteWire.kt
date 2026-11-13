package io.rivethub.app.gateway

import kotlinx.serialization.Serializable

// Session delete + trash (`@rivetos/types` gateway-api.ts, rh CONTRACT note 26).
// Delete removes a session's conversation from the node's memory and drops it
// from the session lists; the harness's own transcript on disk is kept. A live
// session is refused (409 `session is live`) and never stopped.

/** `POST /api/sessions/delete` body: 1..=200 canonical ids. */
@Serializable
data class SessionsDeleteRequest(val sessions: List<String>)

/**
 * One per-session result. `ok=false` carries [error]: `session is live`,
 * `not found` or `delete failed` today.
 */
@Serializable
data class SessionDeleteResult(
    val session: String,
    val ok: Boolean,
    val error: String? = null,
    val conversations: Int = 0,
    val messages: Int = 0,
    val summaries: Int = 0,
)

@Serializable
data class SessionsDeleteResponse(val results: List<SessionDeleteResult> = emptyList())

/** `GET /api/sessions/trash` row — a review candidate only; nothing is deleted. */
@Serializable
data class SessionTrashCandidate(
    val session: String = "",
    val harness: String = "",
    val title: String? = null,
    /** RFC 3339. */
    val updatedAt: String = "",
    /** `empty` | `one-word-reply`. */
    val reason: String = "",
    val userTurns: Int = 0,
    /** Assistant reply, at most 80 chars, or null. */
    val reply: String? = null,
)

@Serializable
data class SessionTrashResponse(val candidates: List<SessionTrashCandidate>? = null)

/** The gateway predates the delete routes (404 / 405 / 501, or a body that is not the trash shape). */
class SessionDeleteUnsupported(status: Int) : GatewayException(status, "not supported by this gateway")

/** Bulk endpoint cap per request. */
const val SESSION_DELETE_BATCH_MAX = 200

/** Statuses that mean the route does not exist on this gateway. */
val UNSUPPORTED_ROUTE_STATUS: Set<Int> = setOf(404, 405, 501)
