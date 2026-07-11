package dev.rivet.app.net

import android.util.Base64
import com.wireguard.crypto.KeyPair
import dev.rivet.app.data.datastore.MeshConfig
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/**
 * Scan-to-join: parse the desktop's enrollment QR, apply its mesh config, and
 * redeem the one-time token against the gateway with THIS device's WireGuard
 * public key (generated on-device by [RivetVpn], private half never leaves).
 * The gateway registers the peer on the relay and returns the final config.
 */
object MeshEnroll {
    private val json = Json { ignoreUnknownKeys = true }
    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .callTimeout(30, TimeUnit.SECONDS)
        .build()

    @Serializable
    private data class QrPayload(
        val v: Int = 0,
        val kind: String = "",
        val gateway: String = "",
        val token: String = "",
        val config: QrConfig = QrConfig(),
    )

    @Serializable
    private data class QrConfig(
        val sharedHost: String = "",
        val sharedExport: String = "/rivet-shared",
        val pgUrl: String = "",
        val embedUrl: String = "",
        val wgEndpoint: String = "",
        val wgPeerPublicKey: String = "",
        val wgAddress: String = "",
        val wgAllowedIps: String = "",
        val homeSubnet: String = "",
    )

    @Serializable
    private data class EnrollRequest(val token: String, val publicKey: String, val name: String)

    @Serializable
    private data class EnrollResponse(
        val ok: Boolean = false,
        val device: Device = Device(),
        val config: QrConfig = QrConfig(),
    )

    @Serializable
    private data class Device(
        val id: String = "",
        val name: String = "",
        val address: String = "",
    )

    sealed interface Result {
        data class Joined(val address: String, val config: MeshConfig) : Result
        data class Error(val message: String) : Result
    }

    /** True if [text] looks like our enrollment QR (cheap pre-check for the scanner). */
    fun looksLikeEnroll(text: String): Boolean =
        text.contains("\"kind\"") && text.contains("rivet-mesh-enroll")

    private fun QrConfig.toMeshConfig(address: String) = MeshConfig(
        pgUrl = pgUrl,
        embedUrl = embedUrl,
        sharedHost = sharedHost,
        sharedExport = sharedExport.ifBlank { "/rivet-shared" },
        wgEndpoint = wgEndpoint,
        wgPeerPublicKey = wgPeerPublicKey,
        wgAddress = address.ifBlank { wgAddress },
        wgAllowedIps = wgAllowedIps,
        homeSubnet = homeSubnet,
    )

    /**
     * Parse + redeem. Blocking network — call off the main thread.
     * @param devicePublicKey base64 WG public key from [RivetVpn.publicKeyBase64].
     * @param deviceName label shown in the desktop device list.
     */
    fun enroll(qrText: String, devicePublicKey: String, deviceName: String): Result {
        val payload = try {
            json.decodeFromString<QrPayload>(qrText)
        } catch (e: Exception) {
            return Result.Error("Not a RivetHub enrollment code")
        }
        if (payload.kind != "rivet-mesh-enroll" || payload.v != 1)
            return Result.Error("Unsupported enrollment code (v${payload.v})")
        val gateway = payload.gateway.trimEnd('/')
        if (gateway.isBlank() || payload.token.isBlank())
            return Result.Error("Enrollment code missing gateway/token")

        val reqBody = json.encodeToString(
            EnrollRequest(token = payload.token, publicKey = devicePublicKey, name = deviceName),
        ).toRequestBody("application/json".toMediaType())
        val request = Request.Builder().url("$gateway/api/devices/enroll").post(reqBody).build()

        return try {
            http.newCall(request).execute().use { resp ->
                val body = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) {
                    val msg = runCatching { json.decodeFromString<Map<String, String>>(body)["error"] }
                        .getOrNull() ?: "HTTP ${resp.code}"
                    return Result.Error("Enrollment refused: $msg")
                }
                val parsed = json.decodeFromString<EnrollResponse>(body)
                // Prefer the server's echoed config (authoritative address), fall
                // back to the QR's if the response was thin.
                val address = parsed.device.address.ifBlank { payload.config.wgAddress }
                val cfg = (if (parsed.ok) parsed.config else payload.config)
                    .toMeshConfig(if (address.contains("/")) address else "$address/32")
                Result.Joined(address = address, config = cfg)
            }
        } catch (e: Exception) {
            Result.Error("Couldn't reach the node: ${e.message}")
        }
    }
}
