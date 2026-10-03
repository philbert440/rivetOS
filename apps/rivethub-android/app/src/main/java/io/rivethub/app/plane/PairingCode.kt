package io.rivethub.app.plane

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * The pairing QR `rivetos local --device <id>` shows (packages/cli/src/lib/pairing.ts):
 * `{v:1, kind:"rivethub-pair", gateway, token, certSha256}`. [certSha256] is the
 * lowercase hex SHA-256 of the gateway's TLS leaf — the phone has no CA yet, so it
 * pins that leaf for the one redeem call.
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
fun looksLikePairingCode(text: String): Boolean = text.contains("\"$KIND\"")

fun parsePairingCode(text: String): PairingParse {
    val obj = runCatching { json.parseToJsonElement(text.trim()) as? JsonObject }.getOrNull()
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
