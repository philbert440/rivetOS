package dev.rivet.app.data.tls

import okhttp3.OkHttpClient

/**
 * Shared gateway mTLS hook for every OkHttp client that talks to a den.
 *
 * When a [DeviceIdentityStore] is bound and has an imported PKCS#12, builders
 * get an SSLContext that presents the device client cert and trusts the Rivet
 * CA chain (plus platform roots). When nothing is imported the dynamic
 * managers still install but select no client cert and trust system roots
 * only — plain `http://` dens keep working and public HTTPS is unchanged.
 *
 * All gateway-facing sites must call [applyRivetTls] rather than hand-rolling
 * sslSocketFactory setup.
 */
object RivetTls {
    @Volatile
    private var store: DeviceIdentityStore? = null

    /** Bind the process-level store (called from DI on first client build). */
    fun bind(identityStore: DeviceIdentityStore) {
        store = identityStore
    }

    fun boundStore(): DeviceIdentityStore? = store

    /**
     * Install Rivet device mTLS on this builder from the bound store.
     * No-op when no store has been bound yet (unit tests, early init).
     */
    fun OkHttpClient.Builder.applyRivetTls(): OkHttpClient.Builder {
        val s = store ?: return this
        return applyRivetTls(s)
    }

    /**
     * Install Rivet device mTLS from an explicit store (and bind it so
     * process-level shared clients pick the same identity).
     */
    fun OkHttpClient.Builder.applyRivetTls(identityStore: DeviceIdentityStore): OkHttpClient.Builder {
        bind(identityStore)
        val (socketFactory, trustManager) = identityStore.sslSocketFactoryAndTrustManager()
        return sslSocketFactory(socketFactory, trustManager)
    }
}
