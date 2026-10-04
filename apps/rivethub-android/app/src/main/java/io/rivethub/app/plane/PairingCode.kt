package io.rivethub.app.plane

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * The pairing QR `rivetos pair` shows (packages/cli/src/lib/pairing.ts).
 * The body is `{v:1, kind:"rivethub-pair", gateway, token, certSha256}`, wrapped in
 * `intent://pair?d=<base64url>#Intent;scheme=rivethub;end` so the system
 * QR scanner (which only launches http and intent URIs) opens this app.
 * `rivethub://pair?d=` and raw JSON from an older node still parse.
 * [certSha256] is the lowercase hex
 * SHA-256 of the gateway's TLS leaf — the phone has no CA yet, so it pins that
 * leaf for the one redeem call.
 */
data class PairingCode(val gateway: String, val token: String, val certSha256: String)

enum class PairingCodeError { NotPairing, Unsupported, Invalid }

sealed interface PairingParse {
    data class Ok(val code: PairingCode) : PairingParse
    data class Err(val error: PairingCodeError) : PairingParse
}

private const val KIND = "rivethub-pair"
private val HEX64 = Regex("^[0-9a-f]{64}$")
private val json = Json { ignoreUnknownKeys = true }

/** Cheap pre-check so the scanner keeps looking past unrelated QR codes. */
fun looksLikePairingCode(text: String): Boolean {
    val trimmed = text.trim()
    if (trimmed.startsWith("rivethub://pair", ignoreCase = true)) return true
    if (pairingLinkQuery(trimmed) != null) return true
    return trimmed.contains("\"$KIND\"")
}

fun parsePairingCode(text: String): PairingParse {
    val jsonText = pairingJsonText(text) ?: return PairingParse.Err(PairingCodeError.NotPairing)
    val obj = runCatching { json.parseToJsonElement(jsonText) as? JsonObject }.getOrNull()
        ?: return PairingParse.Err(PairingCodeError.NotPairing)
    fun str(key: String): String? = runCatching { obj[key]?.jsonPrimitive?.content }.getOrNull()
    if (str("kind") != KIND) return PairingParse.Err(PairingCodeError.NotPairing)
    val v = runCatching { obj["v"]?.jsonPrimitive?.intOrNull }.getOrNull()
    if (v != 1) return PairingParse.Err(PairingCodeError.Unsupported)
    val gateway = str("gateway")?.trim()?.trimEnd('/').orEmpty()
    val token = str("token").orEmpty()
    val pin = str("certSha256")?.lowercase().orEmpty()
    if (validateEntryUrl(gateway) != null || token.isBlank() || !HEX64.matches(pin)) {
        return PairingParse.Err(PairingCodeError.Invalid)
    }
    return PairingParse.Ok(PairingCode(gateway, token, pin))
}

/**
 * Raw JSON, or the JSON inside a `rivethub://pair?d=` link. Null when the
 * link is missing its payload or the payload is not base64url.
 */
/**
 * Query of a pairing link, or null when [text] is not one.
 * `intent://pair?d=…#Intent;scheme=rivethub;end` is what the system scanner
 * reads; after it launches us the activity data is `rivethub://pair?d=…`.
 */
private fun pairingLinkQuery(text: String): String? {
    val direct = Regex("^rivethub://pair\\?(.*)$", RegexOption.IGNORE_CASE).find(text)
    if (direct != null) return direct.groupValues[1]
    val intent = Regex("^intent://pair\\?([^#]+)#Intent;(.*)$", RegexOption.IGNORE_CASE).find(text)
        ?: return null
    val scheme = Regex("(?:^|;)scheme=([^;]+)", RegexOption.IGNORE_CASE)
        .find(intent.groupValues[2])?.groupValues?.get(1)
    if (!scheme.equals("rivethub", ignoreCase = true)) return null
    return intent.groupValues[1]
}

private fun pairingJsonText(text: String): String? {
    val trimmed = text.trim()
    val query = pairingLinkQuery(trimmed) ?: return if (
        trimmed.startsWith("rivethub://", ignoreCase = true) ||
        trimmed.startsWith("intent:", ignoreCase = true)
    ) null else trimmed
    val payload = query.split('&').firstNotNullOfOrNull { part ->
        val eq = part.indexOf('=')
        if (eq <= 0) null else if (part.substring(0, eq) == "d") part.substring(eq + 1) else null
    } ?: return null
    return decodeBase64Url(payload)
}

private fun decodeBase64Url(encoded: String): String? = runCatching {
    val pad = (4 - encoded.length % 4) % 4
    val bytes = java.util.Base64.getUrlDecoder().decode(encoded + "=".repeat(pad))
    String(bytes, Charsets.UTF_8)
}.getOrNull()

/**
 * Why a pairing redeem failed, for the Enroll screen. [Spent]: a retry after a
 * timeout was refused, so the first attempt most likely redeemed the code and
 * only its answer was lost.
 */
enum class PairingFailure { Expired, Spent, Gone, PinMismatch, Unreachable, Other }

/** Maps the gateway's redeem status (services/den-server/src/pairing.ts) to a failure. */
fun pairingFailureForStatus(status: Int): PairingFailure = when (status) {
    403 -> PairingFailure.Expired
    410 -> PairingFailure.Gone
    else -> PairingFailure.Other
}
