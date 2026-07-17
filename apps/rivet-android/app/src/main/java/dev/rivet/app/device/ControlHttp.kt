package dev.rivet.app.device

import org.json.JSONObject
import java.io.OutputStream
import java.net.URLDecoder
import java.nio.charset.StandardCharsets

/**
 * Binary-safe HTTP response for [ControlServer]. Pure helpers live here so JVM unit tests
 * can exercise them without the Android framework.
 */
data class HttpResponse(
    val code: Int,
    val contentType: String,
    val body: ByteArray,
    val headers: Map<String, String> = emptyMap(),
) {
    // ByteArray content equality (data class default is reference equality).
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is HttpResponse) return false
        return code == other.code &&
            contentType == other.contentType &&
            body.contentEquals(other.body) &&
            headers == other.headers
    }

    override fun hashCode(): Int {
        var result = code
        result = 31 * result + contentType.hashCode()
        result = 31 * result + body.contentHashCode()
        result = 31 * result + headers.hashCode()
        return result
    }
}

/** Reason phrase for the status codes Fidelity uses. Unknown codes → generic fallback. */
fun httpStatusText(code: Int): String = when (code) {
    200 -> "OK"
    400 -> "Bad Request"
    401 -> "Unauthorized"
    403 -> "Forbidden"
    404 -> "Not Found"
    429 -> "Too Many Requests"
    500 -> "Internal Server Error"
    501 -> "Not Implemented"
    503 -> "Service Unavailable"
    else -> "Unknown"
}

fun jsonResponse(code: Int, obj: JSONObject, pretty: Boolean = true): HttpResponse {
    val text = if (pretty) obj.toString(2) else obj.toString()
    return HttpResponse(
        code = code,
        contentType = "application/json; charset=utf-8",
        body = text.toByteArray(StandardCharsets.UTF_8),
    )
}

/**
 * Canonical error JSON: `{ok:false, error:<stable>, message:<human>, code:<int>}`.
 * Stable [error] strings for current endpoints: unauthorized, not_found, bad_request,
 * a11y_disconnected, internal_error.
 */
fun errorResponse(code: Int, error: String, message: String): HttpResponse {
    val obj = JSONObject()
        .put("ok", false)
        .put("error", error)
        .put("message", message)
        .put("code", code)
    return jsonResponse(code, obj)
}

/**
 * Write status line + Content-Type + Content-Length + extra headers + raw body bytes.
 * Uses [OutputStream] only — never PrintWriter — so binary bodies are byte-exact.
 */
fun writeResponse(out: OutputStream, res: HttpResponse) {
    val reason = httpStatusText(res.code)
    val header = buildString {
        append("HTTP/1.1 ").append(res.code).append(' ').append(reason).append("\r\n")
        append("Content-Type: ").append(res.contentType).append("\r\n")
        append("Content-Length: ").append(res.body.size).append("\r\n")
        for ((k, v) in res.headers) {
            append(k).append(": ").append(v).append("\r\n")
        }
        append("\r\n")
    }
    out.write(header.toByteArray(StandardCharsets.US_ASCII))
    out.write(res.body)
    out.flush()
}

/**
 * Split a request-target into path + decoded query params.
 * Percent-decodes, maps `+` → space, tolerates empty values and malformed input (never throws).
 */
fun parseUrl(requestTarget: String): Pair<String, Map<String, String>> {
    return try {
        val q = requestTarget.indexOf('?')
        if (q < 0) return requestTarget to emptyMap()
        val path = requestTarget.substring(0, q)
        val query = requestTarget.substring(q + 1)
        if (query.isEmpty()) return path to emptyMap()
        val params = LinkedHashMap<String, String>()
        for (part in query.split('&')) {
            if (part.isEmpty()) continue
            val eq = part.indexOf('=')
            val rawKey = if (eq < 0) part else part.substring(0, eq)
            val rawVal = if (eq < 0) "" else part.substring(eq + 1)
            val key = urlDecodeBestEffort(rawKey)
            if (key.isEmpty() && rawKey.isEmpty()) continue
            params[key] = urlDecodeBestEffort(rawVal)
        }
        path to params
    } catch (_: Exception) {
        val path = requestTarget.substringBefore('?')
        path to emptyMap()
    }
}

private fun urlDecodeBestEffort(s: String): String {
    return try {
        URLDecoder.decode(s, StandardCharsets.UTF_8.name())
    } catch (_: Exception) {
        s.replace('+', ' ')
    }
}
