package io.rivethub.app.data

import io.rivethub.app.plane.PairingCode
import io.rivethub.app.plane.PairingFailure
import io.rivethub.app.plane.pairingFailureForStatus
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.time.Duration
import java.util.Base64
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLException
import javax.net.ssl.X509TrustManager

/**
 * Redeems a scanned pairing QR at POST /api/devices/pair for the device PKCS#12 and
 * its passphrase. The phone has no CA yet, so this one call trusts exactly the leaf
 * whose SHA-256 the QR carries (the pin stands in for hostname verification too).
 * Blocking network — call off the main thread.
 */
class PairingClient(private val lan: LanNetwork?) {
    class Redeemed(val deviceId: String, val p12: ByteArray, val passphrase: String)

    class PairingException(val failure: PairingFailure, message: String? = null) : IOException(message)

    @Serializable
    private data class RedeemRequest(val token: String)

    @Serializable
    private data class Response(val deviceId: String = "", val p12: String = "", val passphrase: String = "")

    private val json = Json { ignoreUnknownKeys = true }

    fun redeem(code: PairingCode): Redeemed = try {
        call(code, bindLan = false)
    } catch (e: SocketTimeoutException) {
        // Android 16 local-network protection can black-hole default routing to the LAN.
        if (lan == null) throw PairingException(PairingFailure.Unreachable, e.message)
        try {
            call(code, bindLan = true)
        } catch (e2: SocketTimeoutException) {
            throw PairingException(PairingFailure.Unreachable, e2.message)
        }
    }

    private fun call(code: PairingCode, bindLan: Boolean): Redeemed {
        val pinned = PinnedLeafTrustManager(code.certSha256)
        val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(pinned), null) }
        val b = OkHttpClient.Builder()
            .connectTimeout(Duration.ofSeconds(10))
            .callTimeout(Duration.ofSeconds(30))
            .sslSocketFactory(ssl.socketFactory, pinned)
            .hostnameVerifier(HostnameVerifier { _, _ -> true })
        if (bindLan && lan != null) b.socketFactory(LiveLanSocketFactory(lan))
        val body = json.encodeToString(RedeemRequest.serializer(), RedeemRequest(code.token))
            .toRequestBody("application/json".toMediaType())
        val req = Request.Builder().url("${code.gateway}/api/devices/pair").post(body).build()
        try {
            b.build().newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) throw PairingException(pairingFailureForStatus(resp.code), "HTTP ${resp.code}")
                val parsed = json.decodeFromString(Response.serializer(), resp.body.string())
                val p12 = runCatching { Base64.getDecoder().decode(parsed.p12) }.getOrNull()
                if (p12 == null || p12.isEmpty() || parsed.passphrase.isEmpty()) {
                    throw PairingException(PairingFailure.Other, "malformed pairing response")
                }
                return Redeemed(parsed.deviceId, p12, parsed.passphrase)
            }
        } catch (e: SSLException) {
            if (pinned.mismatch) throw PairingException(PairingFailure.PinMismatch, e.message)
            throw e
        } catch (e: UnknownHostException) {
            throw PairingException(PairingFailure.Unreachable, e.message)
        }
    }
}

/** Trusts only a server leaf whose DER SHA-256 is [pinHex]. */
private class PinnedLeafTrustManager(private val pinHex: String) : X509TrustManager {
    @Volatile var mismatch = false
        private set

    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        val leaf = chain?.firstOrNull() ?: throw CertificateException("no server certificate")
        val digest = MessageDigest.getInstance("SHA-256").digest(leaf.encoded)
        val hex = digest.joinToString("") { "%02x".format(it) }
        if (!MessageDigest.isEqual(hex.toByteArray(), pinHex.toByteArray())) {
            mismatch = true
            throw CertificateException("gateway certificate does not match the pairing code")
        }
    }

    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) =
        throw CertificateException("client certificates are not accepted here")

    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}
