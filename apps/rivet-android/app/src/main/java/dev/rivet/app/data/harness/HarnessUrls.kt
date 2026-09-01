package dev.rivet.app.data.harness

/**
 * Every URL the control plane speaks, built from a den base — pure, so the
 * path shapes are unit-testable without a socket.
 *
 * Two deviations from the contract's sketch, both because den dispatches HTTP
 * by literal path prefix and mounts upgrades by exact path:
 *
 * - the session family is `/api/harness-sessions`, not `/api/sessions`
 *   (that prefix is owned by the gateway chat channel);
 * - WS resources ride the query string, since there is no dynamic segment for
 *   a router to match.
 *
 * See docs/ARCHITECTURE.md § Gateway surface (as built).
 */
class HarnessUrls(denBaseUrl: String) {

    /** Origin with no trailing slash — gateway paths are absolute. */
    val base: String = denBaseUrl.trim().trimEnd('/')

    private val wsBase: String = when {
        base.startsWith("https://") -> "wss://" + base.removePrefix("https://")
        base.startsWith("http://") -> "ws://" + base.removePrefix("http://")
        else -> "ws://$base"
    }

    fun harnesses(): String = "$base/api/harnesses"

    fun harness(harnessId: String): String =
        "$base/api/harnesses/${HarnessSessionIds.urlEncode(harnessId)}"

    fun harnessSessions(harnessId: String): String = "${harness(harnessId)}/sessions"

    fun session(sessionId: String): String = "$base/api/harness-sessions/${seg(sessionId)}"

    fun resume(sessionId: String): String = "${session(sessionId)}/resume"

    fun turns(sessionId: String): String = "${session(sessionId)}/turns"

    fun interrupt(sessionId: String): String = "${session(sessionId)}/interrupt"

    fun approval(sessionId: String, requestId: String): String =
        "${session(sessionId)}/approvals/${HarnessSessionIds.urlEncode(requestId)}"

    fun transcript(sessionId: String): String = "${session(sessionId)}/transcript"

    fun upload(name: String, mime: String?): String {
        val q = StringBuilder("$base/api/uploads?name=").append(HarnessSessionIds.urlEncode(name))
        if (!mime.isNullOrBlank()) q.append("&mime=").append(HarnessSessionIds.urlEncode(mime))
        return q.toString()
    }

    /**
     * `WS /api/harness-sessions/ws?session=<enc>`.
     *
     * No credential in the URL. den accepts `?token=` on an upgrade because a
     * browser's `WebSocket` constructor cannot set headers; OkHttp can, so the
     * bearer goes on the handshake request ([ReconnectingSocket.over]) and stays
     * out of anything that logs URLs.
     */
    fun sessionWs(sessionId: String): String =
        "$wsBase/api/harness-sessions/ws?session=${seg(sessionId)}"

    /** `WS /api/harnesses/ws[?harness=<id>]` — omit the id to watch them all. */
    fun harnessesWs(harnessId: String?): String {
        val url = StringBuilder("$wsBase/api/harnesses/ws")
        if (!harnessId.isNullOrBlank()) {
            url.append("?harness=").append(HarnessSessionIds.urlEncode(harnessId))
        }
        return url.toString()
    }

    private fun seg(sessionId: String): String = HarnessSessionIds.segmentFor(sessionId)
}
