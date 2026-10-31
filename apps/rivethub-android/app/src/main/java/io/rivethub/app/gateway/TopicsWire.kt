package io.rivethub.app.gateway

import kotlinx.serialization.Serializable

// Topics (rh contract notes 17, 36, 37, 40, 70; `wire::gateway::topics`).
// A topic is a themed group of sessions kept on the memory database, so every
// node on one datahub answers the same topics. A session has at most one
// placement. The phone reads work topics only: types and entities are the
// wiki's, and sessions cannot be filed under them.

/** `GET /api/topics` row: a `TopicRecord` flattened with its counts. Times are epoch ms. */
@Serializable
data class TopicSummary(
    val id: String,
    val kind: String = "work",
    val slug: String = "",
    val name: String,
    val parent: String? = null,
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
    /** Set while the topic is closed; a session active after it reopens it on screen. */
    val closedAt: Long? = null,
    val sessionCount: Long = 0,
    val lastActive: Long? = null,
)

@Serializable
data class TopicList(val topics: List<TopicSummary> = emptyList())

/** `POST /api/topics` body (the server refuses unknown fields). */
@Serializable
data class TopicCreateRequest(val name: String, val parent: String? = null)

/** `PATCH /api/topics/{id}` body: only the name changes from the phone. */
@Serializable
data class TopicRename(val name: String)

/** `PUT /api/sessions/{session}/placement` body. */
@Serializable
data class PlacementRequest(val topicId: String)

/** One filed session in `GET /api/topics/filing`. */
@Serializable
data class TopicSession(
    val sessionId: String,
    val topicId: String,
    /** `you` or `categorizer`. */
    val by: String = "",
    val at: Long = 0,
    val title: String? = null,
    val lastActive: Long? = null,
    val node: String? = null,
)

/** `GET /api/topics/filing`: every filing in one read. */
@Serializable
data class TopicFiling(val sessions: List<TopicSession> = emptyList())

/** The gateway predates topics (404 / 405 / 501 on the list route). */
class TopicsUnsupported(status: Int) : GatewayException(status, "topics not supported by this gateway")
