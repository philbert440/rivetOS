package dev.rivetos.bots.data

import okhttp3.OkHttpClient
import java.time.Duration
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLContext

/**
 * One OkHttp client per (identity generation, strict-hostnames) pair. mTLS
 * comes from the device p12; trust from its chain / the CA PEM. When no CA
 * material is available we fall back to the platform trust store (which will
 * reject a private Rivet CA — the UI surfaces that).
 */
class HttpFactory(private val identity: DeviceIdentityStore, private val lan: LanNetwork? = null) {
    @Volatile private var cached: OkHttpClient? = null
    @Volatile private var cachedKey: String = ""

    /**
     * Sign-out: drop the client (and the SSLContext/KeyManager it carries).
     * Idle connections are evicted; the dispatcher is left alone — callers
     * close their sockets first, and a Gateway that still holds this client
     * must not find a dead executor under it.
     */
    @Synchronized
    fun clear() { cached?.connectionPool?.evictAll(); cached = null; cachedKey = "" }

    /** Part of every cache key: identity generation, TLS posture, and which LAN network sockets bind to. */
    fun cacheKey(strictHostnames: Boolean): String =
        "${identity.generation()}:$strictHostnames:${lan?.generation() ?: -1}"

    fun client(strictHostnames: Boolean): OkHttpClient {
        val key = cacheKey(strictHostnames)
        cached?.let { if (cachedKey == key) return it }
        synchronized(this) {
            cached?.let { if (cachedKey == key) return it }
            val built = build(strictHostnames)
            cached = built
            cachedKey = key
            return built
        }
    }

    private fun build(strictHostnames: Boolean): OkHttpClient {
        val b = OkHttpClient.Builder()
            .connectTimeout(Duration.ofSeconds(6))
            .readTimeout(Duration.ofSeconds(30))
            .writeTimeout(Duration.ofSeconds(30))
            .pingInterval(Duration.ofSeconds(25))
            .retryOnConnectionFailure(true)
        // Mesh nodes are LAN addresses: bind to WiFi/Ethernet when present, so a
        // cellular default network (weak-WiFi demotion) can't black-hole them.
        lan?.network?.let { b.socketFactory(it.socketFactory) }
        val loaded = identity.load()
        if (loaded == null && identity.hasIdentity()) {
            throw IllegalStateException("device certificate failed to load: ${identity.lastError ?: "unknown"}")
        }
        if (loaded != null) {
            val ctx = SSLContext.getInstance("TLS")
            ctx.init(loaded.keyManagers, loaded.trustManager?.let { arrayOf(it) }, null)
            val tm = loaded.trustManager ?: platformTrustManager()
            b.sslSocketFactory(ctx.socketFactory, tm)
        }
        if (!strictHostnames) {
            b.hostnameVerifier(HostnameVerifier { _, _ -> true })
        }
        return b.build()
    }

    private fun platformTrustManager(): javax.net.ssl.X509TrustManager {
        val tmf = javax.net.ssl.TrustManagerFactory.getInstance(javax.net.ssl.TrustManagerFactory.getDefaultAlgorithm())
        tmf.init(null as java.security.KeyStore?)
        return tmf.trustManagers.filterIsInstance<javax.net.ssl.X509TrustManager>().first()
    }
}
