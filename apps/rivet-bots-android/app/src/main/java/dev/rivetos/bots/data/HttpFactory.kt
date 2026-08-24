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
    private val cache = HashMap<String, OkHttpClient>()

    /**
     * Sign-out: drop the clients (and the SSLContext/KeyManager they carry).
     * Idle connections are evicted; dispatchers are left alone — callers
     * close their sockets first, and a Gateway that still holds a client
     * must not find a dead executor under it.
     */
    @Synchronized
    fun clear() { cache.values.forEach { it.connectionPool.evictAll() }; cache.clear() }

    /** Part of every cache key: identity generation, TLS posture, and which LAN network sockets bind to. */
    fun cacheKey(strictHostnames: Boolean): String =
        "${identity.generation()}:$strictHostnames:${lan?.generation() ?: -1}"

    /**
     * [bindLan] false = default-network client (Android's own routing, incl. an
     * active VPN/WG path); true = sockets bound to the WiFi/Ethernet network
     * (reaches LAN nodes when a weak WiFi was demoted off default). Callers
     * try default first and fall back to the bound client on a connect
     * timeout — field debugging showed EITHER can be the only working path.
     */
    @Synchronized
    fun client(strictHostnames: Boolean, bindLan: Boolean = false): OkHttpClient {
        val key = "${cacheKey(strictHostnames)}:$bindLan"
        cache[key]?.let { return it }
        if (cache.size > 8) cache.clear() // generations move on; drop stale clients
        val built = build(strictHostnames, bindLan)
        cache[key] = built
        return built
    }

    /** The wifi-bound fallback, or null when it would be identical to the primary. */
    fun fallbackClient(strictHostnames: Boolean): OkHttpClient? =
        if (lan?.current() == null) null else client(strictHostnames, bindLan = true)

    private fun build(strictHostnames: Boolean, bindLan: Boolean): OkHttpClient {
        val b = OkHttpClient.Builder()
            .connectTimeout(Duration.ofSeconds(6))
            .readTimeout(Duration.ofSeconds(30))
            .writeTimeout(Duration.ofSeconds(30))
            .pingInterval(Duration.ofSeconds(25))
            .retryOnConnectionFailure(true)
        if (bindLan) lan?.current()?.let { b.socketFactory(it.socketFactory) }
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
