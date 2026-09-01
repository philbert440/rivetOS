package dev.rivet.app.data.harness

import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.util.Base64

/**
 * SessionId codec for the harness control plane — the Kotlin twin of
 * `packages/types/src/harness-session-id.ts`.
 *
 * Canonical identity is `<harness-id>:<native-session-id>`; the native half is
 * opaque and may itself contain `:` (and `/`, for Claude's path-derived legacy
 * keys), so only the FIRST colon is structural. Path params carry
 * `enc(SessionId)` = unpadded base64url of the UTF-8 id, because a
 * percent-encoded `/` inside a path segment is unreliable across routers.
 *
 * Pure string work — no Android framework, no logging — so it unit-tests on the
 * plain JVM classpath.
 *
 * Source of truth: docs/ARCHITECTURE.md § Session identity.
 */

/** Thrown for anything the contract calls `invalid_session_id`. */
class InvalidSessionIdException(message: String) : IllegalArgumentException(message)

/** Left half of a SessionId. Fixed product tokens — never nicknames. */
object HarnessIds {
    const val CLAUDE_CODE = "claude-code"
    const val GROK_BUILD = "grok-build"
    const val KIMI_CODE = "kimi-code"
    const val HERMES = "hermes"

    /** Declaration order matches the contract's enum. */
    val ALL: List<String> = listOf(CLAUDE_CODE, GROK_BUILD, KIMI_CODE, HERMES)

    fun isHarnessId(value: String): Boolean = ALL.contains(value)

    /**
     * Den roster command for a harness id — a UI/spawn label only, never key
     * material. Falls back to the harness id itself for anything unknown.
     */
    fun rosterCommand(harnessId: String): String = when (harnessId) {
        CLAUDE_CODE -> "claude"
        GROK_BUILD -> "grok"
        KIMI_CODE -> "kimi"
        HERMES -> "hermes"
        else -> harnessId
    }
}

/** Result of splitting a canonical SessionId on its first colon. */
data class ParsedSessionId(
    val harnessId: String,
    val nativeSessionId: String,
)

object HarnessSessionIds {

    private val BASE64URL = Regex("^[A-Za-z0-9_-]+$")

    /**
     * Split a canonical `<harness-id>:<native-session-id>` on the FIRST colon.
     *
     * Validation is as-is: surrounding whitespace is rejected, never trimmed,
     * so a stray space cannot silently alias two capture keys onto one session.
     */
    fun parse(id: String): ParsedSessionId {
        if (id != id.trim()) invalid("SessionId has leading/trailing whitespace", id)
        val i = id.indexOf(':')
        if (i <= 0) invalid("SessionId is missing a harness-id prefix", id)
        if (i == id.length - 1) invalid("SessionId has an empty native session id", id)
        val harnessId = id.substring(0, i)
        if (!HarnessIds.isHarnessId(harnessId)) invalid("unknown harness id: $harnessId", id)
        return ParsedSessionId(harnessId, id.substring(i + 1))
    }

    fun parseOrNull(id: String): ParsedSessionId? =
        try {
            parse(id)
        } catch (_: InvalidSessionIdException) {
            null
        }

    /** True when [id] is a well-formed canonical SessionId. */
    fun isSessionId(id: String): Boolean = parseOrNull(id) != null

    /** Compose a canonical SessionId; validates, so the result round-trips. */
    fun format(harnessId: String, nativeSessionId: String): String {
        val id = "$harnessId:$nativeSessionId"
        parse(id)
        return id
    }

    /** Native half of a canonical id, or null when it does not parse. */
    fun nativeIdOf(sessionId: String): String? = parseOrNull(sessionId)?.nativeSessionId

    /**
     * `enc(SessionId)` — one URL/path-safe segment: unpadded base64url of the
     * UTF-8 bytes. Only canonical ids are encodable, so the input is validated
     * first.
     */
    fun encodeSegment(sessionId: String): String {
        parse(sessionId)
        return Base64.getUrlEncoder().withoutPadding()
            .encodeToString(sessionId.toByteArray(Charsets.UTF_8))
    }

    /**
     * `dec(segment)` — inverse of [encodeSegment]. Rejects padded, whitespaced
     * or non-base64url input, invalid UTF-8, and anything that does not decode
     * to a canonical SessionId.
     */
    fun decodeSegment(segment: String): String {
        if (!BASE64URL.matches(segment)) {
            invalid("session id segment is not unpadded base64url", segment)
        }
        val bytes = try {
            Base64.getUrlDecoder().decode(segment)
        } catch (e: IllegalArgumentException) {
            invalid("session id segment failed base64url decode: ${e.message}", segment)
        }
        val decoded = try {
            Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes))
                .toString()
        } catch (_: CharacterCodingException) {
            invalid("session id segment is not valid UTF-8", segment)
        }
        parse(decoded)
        return decoded
    }

    /**
     * Path/query segment for a control-plane call.
     *
     * A canonical id is base64url-encoded; a bare native id (the documented
     * legacy shape the registry probes) has no harness prefix to encode and
     * rides through as a plain percent-encoded segment, exactly as
     * `@rivetos/gateway-client` does.
     */
    fun segmentFor(sessionId: String): String =
        if (isSessionId(sessionId)) encodeSegment(sessionId) else urlEncode(sessionId)

    /**
     * Percent-encode one path/query component. `URLEncoder` is
     * form-encoding, so its `+` for space has to be fixed up — a `+` in a path
     * segment is a literal plus, not a space.
     */
    fun urlEncode(value: String): String =
        java.net.URLEncoder.encode(value, Charsets.UTF_8.name())
            .replace("+", "%20")

    private fun invalid(message: String, id: String): Nothing =
        throw InvalidSessionIdException("$message: '$id'")
}
