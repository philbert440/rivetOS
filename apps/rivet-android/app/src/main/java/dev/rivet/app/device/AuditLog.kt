package dev.rivet.app.device

import org.json.JSONArray
import org.json.JSONObject
import java.util.ArrayDeque

/**
 * In-memory ring buffer of the last [capacity] **actions** (not screenshots, not pixels).
 * Pure Kotlin — inject [clockMs] for deterministic JVM tests.
 *
 * Privacy rules:
 * - No screenshot bytes / paths that imply pixel content
 * - No clipboard or typed text contents — length only when relevant
 * - Target is a short redacted summary (package / uri scheme / nodeId / coords)
 */

const val AUDIT_RING_CAPACITY = 200

data class AuditEntry(
    val timestamp: Long,
    /** Action type: click, intent, launch, node_action, … */
    val type: String,
    /** Sub-action when present (intent action, node_action name, clipboard op, global name). */
    val action: String?,
    /** Redacted target summary — never raw SMS body / clipboard text / pixels. */
    val target: String?,
    /** Outcome tag: ok | error | needs_confirm | denied | rate_limited | busy | … */
    val outcome: String,
    /** Control mode wire name at request time. */
    val mode: String,
    /** True when the request carried confirm:true and overrode NeedConfirm. */
    val confirmed: Boolean,
) {
    fun toJson(): JSONObject {
        val o = JSONObject()
            .put("timestamp", timestamp)
            .put("type", type)
            .put("outcome", outcome)
            .put("mode", mode)
            .put("confirmed", confirmed)
        if (action != null) o.put("action", action) else o.put("action", JSONObject.NULL)
        if (target != null) o.put("target", target) else o.put("target", JSONObject.NULL)
        return o
    }
}

class AuditLog(
    private val capacity: Int = AUDIT_RING_CAPACITY,
    private val clockMs: () -> Long = { System.currentTimeMillis() },
) {
    private val lock = Any()
    private val ring = ArrayDeque<AuditEntry>(capacity.coerceAtLeast(1))

    val size: Int
        get() = synchronized(lock) { ring.size }

    /**
     * Record one action. Evicts oldest when at capacity.
     * Callers must not pass pixel data or raw private text in [target].
     */
    fun record(
        type: String,
        action: String? = null,
        target: String? = null,
        outcome: String,
        mode: String,
        confirmed: Boolean = false,
        timestamp: Long = clockMs(),
    ) {
        val entry = AuditEntry(
            timestamp = timestamp,
            type = type,
            action = action,
            target = target?.let { redactTarget(it) },
            outcome = outcome,
            mode = mode,
            confirmed = confirmed,
        )
        synchronized(lock) {
            while (ring.size >= capacity) {
                ring.removeFirst()
            }
            ring.addLast(entry)
        }
    }

    /** Newest-first snapshot. */
    fun snapshot(): List<AuditEntry> = synchronized(lock) {
        ring.toList().asReversed()
    }

    /** Newest-first JSON array for GET /audit. */
    fun toJsonArray(): JSONArray {
        val arr = JSONArray()
        for (e in snapshot()) {
            arr.put(e.toJson())
        }
        return arr
    }

    /** Test helper: clear all entries. */
    fun clear() = synchronized(lock) { ring.clear() }

    /**
     * Invariant helper for tests: no entry target/action looks like raw base64 JPEG
     * or multi-kilobyte clipboard dump.
     */
    fun assertNoPixelPayloads(): Boolean {
        for (e in snapshot()) {
            val t = e.target.orEmpty()
            if (t.startsWith("/9j/") || t.startsWith("iVBOR")) return false // jpeg/png b64
            if (t.length > 512) return false
            if (e.action != null && e.action.length > 512) return false
        }
        return true
    }
}

/**
 * Build a redacted target summary from an action request.
 * Never includes typed text or clipboard contents — only length / scheme / ids / coords.
 */
fun auditTargetSummary(req: JSONObject, type: String): String? {
    return when (type) {
        "launch" -> req.optString("package", "").takeIf { it.isNotBlank() }?.let { "package=$it" }
        "intent" -> {
            val parts = mutableListOf<String>()
            val scheme = SafetyPolicy.uriScheme(
                if (req.has("data")) req.optString("data") else null,
            )
            if (scheme != null) parts.add("scheme=$scheme")
            if (req.has("package")) {
                val p = req.optString("package", "")
                if (p.isNotBlank()) parts.add("package=$p")
            }
            if (req.has("action")) {
                val a = req.optString("action", "")
                if (a.isNotBlank()) parts.add("intent_action=${shorten(a, 80)}")
            }
            parts.joinToString(" ").takeIf { it.isNotEmpty() }
        }
        "node_action", "node_click" -> {
            val parts = mutableListOf<String>()
            val nodeId = req.optString("nodeId", "").trim()
            if (nodeId.isNotEmpty()) parts.add("nodeId=$nodeId")
            if (type == "node_click" && req.has("text")) {
                // Length only — not the matched substring content in full if long
                val t = req.optString("text", "")
                parts.add("text_len=${t.length}")
            }
            if (type == "node_action" && req.has("text")) {
                parts.add("text_len=${req.optString("text", "").length}")
            }
            parts.joinToString(" ").takeIf { it.isNotEmpty() }
        }
        "click", "long_press", "double_tap" -> {
            val nodeId = req.optString("nodeId", "").trim()
            if (nodeId.isNotEmpty()) {
                "nodeId=$nodeId"
            } else if (req.has("x") && req.has("y")) {
                "coords=${req.optInt("x")},${req.optInt("y")}"
            } else {
                null
            }
        }
        "swipe", "drag" -> {
            if (req.has("x1")) {
                "coords=${req.optInt("x1")},${req.optInt("y1")}->${req.optInt("x2")},${req.optInt("y2")}"
            } else {
                null
            }
        }
        "scroll" -> {
            val parts = mutableListOf<String>()
            if (req.has("direction")) parts.add("dir=${req.optString("direction")}")
            val nodeId = req.optString("nodeId", "").trim()
            if (nodeId.isNotEmpty()) parts.add("nodeId=$nodeId")
            parts.joinToString(" ").takeIf { it.isNotEmpty() }
        }
        "text" -> {
            val len = req.optString("text", "").length
            val mode = req.optString("mode", "replace")
            "text_len=$len mode=$mode"
        }
        "clipboard" -> {
            val op = req.optString("op", "")
            val len = if (req.has("text")) req.optString("text", "").length else null
            if (len != null) "op=$op text_len=$len" else "op=$op"
        }
        "global" -> req.optString("action", "").takeIf { it.isNotBlank() }?.let { "global=$it" }
        else -> null
    }
}

/** Outcome string from an [HttpResponse] body for audit. */
fun auditOutcomeFromHttp(res: HttpResponse): String {
    return try {
        val body = JSONObject(String(res.body, Charsets.UTF_8))
        when {
            body.optBoolean("ok", false) -> "ok"
            body.has("error") -> body.optString("error", "error")
            res.code == 429 -> "rate_limited"
            res.code == 403 -> "denied"
            else -> "error"
        }
    } catch (_: Exception) {
        when (res.code) {
            200 -> "ok"
            429 -> "rate_limited"
            403 -> "denied"
            else -> "error"
        }
    }
}

private fun redactTarget(raw: String): String {
    val t = raw.trim()
    if (t.length <= 256) return t
    return t.take(253) + "..."
}

private fun shorten(s: String, max: Int): String =
    if (s.length <= max) s else s.take(max - 3) + "..."
