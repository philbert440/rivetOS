package dev.rivet.app.data.tls

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.io.File
import java.net.Socket
import java.security.Principal
import java.security.PrivateKey
import java.security.cert.X509Certificate
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngine
import javax.net.ssl.X509ExtendedKeyManager
import javax.net.ssl.X509ExtendedTrustManager
import javax.net.ssl.X509KeyManager
import javax.net.ssl.X509TrustManager
import javax.net.ssl.SSLSocketFactory

/**
 * App-private device client certificate store for gateway mTLS.
 *
 * Admin hands the phone a PKCS#12 (from `rivet-ca.sh issue-client <id>` + export).
 * Bytes land in [filesDir]/[P12_FILE]; the passphrase sits in
 * EncryptedSharedPreferences (Android Keystore–backed MasterKey). The Rivet CA
 * chain is taken from the same p12 at import — nothing is baked into the APK.
 *
 * Excluded from cloud backup / device transfer so the credential cannot ride
 * off the handset it was enrolled on.
 */
class DeviceIdentityStore(context: Context) {
    private val appContext = context.applicationContext
    private val p12File: File = File(appContext.filesDir, P12_FILE)
    private val vault: SharedPreferences = openVault(appContext)

    private val lock = Any()

    @Volatile
    private var cached: DeviceIdentityMaterials? = null

    /** Bumped on import/clear so composed managers rebuild once, not every handshake. */
    private val generation = AtomicInteger(0)

    /** Generation for which materials() already failed (avoid re-parse forever). */
    @Volatile
    private var failedGeneration: Int = -1

    @Volatile
    private var composedKeyManager: X509KeyManager? = null

    @Volatile
    private var composedTrustManager: X509TrustManager? = null

    @Volatile
    private var composedGeneration: Int = -1

    private val listeners = CopyOnWriteArrayList<() -> Unit>()

    /** True when a device p12 is present on disk. */
    fun hasIdentity(): Boolean = synchronized(lock) {
        p12File.isFile && p12File.length() > 0L && !vault.getString(KEY_PASSPHRASE, null).isNullOrEmpty()
    }

    /** Leaf CN + expiry when imported; null otherwise. */
    fun summary(): DeviceCertSummary? = materials()?.summary

    /**
     * Import a PKCS#12 from the SAF picker. Replaces any previous identity.
     * @return summary of the new leaf.
     * @throws IllegalArgumentException on bad passphrase / missing key.
     * @throws IllegalStateException when the passphrase vault commit fails.
     */
    fun importPkcs12(bytes: ByteArray, passphrase: String): DeviceCertSummary {
        val password = passphrase.toCharArray()
        val materials = try {
            DeviceIdentityCrypto.parsePkcs12(bytes, password)
        } finally {
            password.fill('\u0000')
        }
        synchronized(lock) {
            p12File.outputStream().use { it.write(bytes) }
            val committed = vault.edit().putString(KEY_PASSPHRASE, passphrase).commit()
            if (!committed) {
                // Roll back the bag so hasIdentity() stays consistent with the vault.
                p12File.delete()
                throw IllegalStateException("Failed to persist device identity passphrase")
            }
            cached?.password?.fill('\u0000')
            cached = materials
            invalidateComposedLocked()
        }
        notifyChanged()
        return materials.summary
    }

    /** Wipe the on-device identity. Safe to call when none is present. */
    fun clear() {
        synchronized(lock) {
            cached?.password?.fill('\u0000')
            cached = null
            if (p12File.exists()) p12File.delete()
            vault.edit().remove(KEY_PASSPHRASE).commit()
            invalidateComposedLocked()
        }
        notifyChanged()
    }

    /**
     * Loaded materials, or null when nothing is imported / the bag cannot be
     * unlocked (corrupt file, etc.).
     */
    fun materials(): DeviceIdentityMaterials? {
        synchronized(lock) {
            cached?.let { return it }
            val gen = generation.get()
            if (failedGeneration == gen) return null
            if (!p12File.isFile || p12File.length() == 0L) return null
            val pass = vault.getString(KEY_PASSPHRASE, null) ?: return null
            val bytes = runCatching { p12File.readBytes() }.getOrElse {
                Log.w(TAG, "failed to read device.p12")
                failedGeneration = gen
                return null
            }
            val password = pass.toCharArray()
            return try {
                DeviceIdentityCrypto.parsePkcs12(bytes, password).also { cached = it }
            } catch (e: Exception) {
                Log.w(TAG, "failed to unlock device.p12: ${e.message}")
                failedGeneration = gen
                null
            } finally {
                // parsePkcs12 copies the char array into materials; zero our local copy.
                password.fill('\u0000')
            }
        }
    }

    /**
     * Dynamic SSL materials for OkHttp. Always returns a usable pair:
     * - no identity → system trust only, empty client-cert selection
     * - with identity → Rivet CA + system trust, device client key
     *
     * Callers can install this once; identity import/remove is reflected on the
     * next handshake without rebuilding the [okhttp3.OkHttpClient].
     */
    fun sslSocketFactoryAndTrustManager(): Pair<SSLSocketFactory, X509TrustManager> {
        val trustManager = dynamicTrustManager
        val ctx = SSLContext.getInstance("TLS")
        ctx.init(arrayOf(dynamicKeyManager), arrayOf(trustManager), null)
        return ctx.socketFactory to trustManager
    }

    fun addChangeListener(listener: () -> Unit) {
        listeners.add(listener)
    }

    fun removeChangeListener(listener: () -> Unit) {
        listeners.remove(listener)
    }

    private fun notifyChanged() {
        listeners.forEach { runCatching { it.invoke() } }
    }

    private fun invalidateComposedLocked() {
        generation.incrementAndGet()
        failedGeneration = -1
        composedKeyManager = null
        composedTrustManager = null
        composedGeneration = -1
    }

    /**
     * Only offer the device client cert when the peer's CertificateRequest lists
     * an acceptable issuer that matches our imported Rivet CA. Empty issuer lists
     * (common "any client cert" servers) → do not present.
     */
    private fun shouldPresentClientCert(issuers: Array<out Principal>?): Boolean {
        val mats = materials() ?: return false
        return DeviceIdentityCrypto.shouldPresentClientCert(
            issuers,
            DeviceIdentityCrypto.rivetCaIssuerNames(mats),
        )
    }

    private fun keyManagerDelegate(): X509KeyManager? {
        val gen = generation.get()
        if (composedGeneration == gen && composedKeyManager != null) {
            return composedKeyManager
        }
        synchronized(lock) {
            if (composedGeneration == gen && composedKeyManager != null) {
                return composedKeyManager
            }
            val mats = materials()
            val km = mats?.keyManagers()?.filterIsInstance<X509KeyManager>()?.firstOrNull()
            ensureTrustComposedLocked(mats)
            composedKeyManager = km
            composedGeneration = gen
            return km
        }
    }

    private fun trustManagerDelegate(): X509TrustManager {
        val gen = generation.get()
        composedTrustManager?.let { if (composedGeneration == gen) return it }
        synchronized(lock) {
            if (composedGeneration == gen) {
                composedTrustManager?.let { return it }
            }
            val mats = materials()
            val tm = ensureTrustComposedLocked(mats)
            composedKeyManager = mats?.keyManagers()?.filterIsInstance<X509KeyManager>()?.firstOrNull()
            composedGeneration = gen
            return tm
        }
    }

    private fun ensureTrustComposedLocked(mats: DeviceIdentityMaterials?): X509TrustManager {
        val extra = mats?.caCertificates.orEmpty()
        val tm = DeviceIdentityCrypto.systemPlusExtraTrustManager(extra)
        composedTrustManager = tm
        return tm
    }

    /**
     * KeyManager that presents the imported device leaf only when the peer's
     * CertificateRequest acceptable-issuers include the Rivet CA. Otherwise
     * offers nothing (unenrolled path / non-gateway TLS peers).
     */
    private val dynamicKeyManager: X509ExtendedKeyManager = object : X509ExtendedKeyManager() {
        private fun delegate(): X509KeyManager? = keyManagerDelegate()

        override fun getClientAliases(keyType: String?, issuers: Array<out Principal>?): Array<String>? {
            if (!shouldPresentClientCert(issuers)) return null
            return delegate()?.getClientAliases(keyType, issuers)
        }

        override fun chooseClientAlias(
            keyType: Array<out String>?,
            issuers: Array<out Principal>?,
            socket: Socket?,
        ): String? {
            if (!shouldPresentClientCert(issuers)) return null
            return delegate()?.chooseClientAlias(keyType, issuers, socket)
        }

        override fun getServerAliases(keyType: String?, issuers: Array<out Principal>?): Array<String>? =
            delegate()?.getServerAliases(keyType, issuers)

        override fun chooseServerAlias(
            keyType: String?,
            issuers: Array<out Principal>?,
            socket: Socket?,
        ): String? = delegate()?.chooseServerAlias(keyType, issuers, socket)

        override fun getCertificateChain(alias: String?): Array<X509Certificate>? =
            delegate()?.getCertificateChain(alias)

        override fun getPrivateKey(alias: String?): PrivateKey? =
            delegate()?.getPrivateKey(alias)

        override fun chooseEngineClientAlias(
            keyType: Array<out String>?,
            issuers: Array<out Principal>?,
            engine: SSLEngine?,
        ): String? {
            if (!shouldPresentClientCert(issuers)) return null
            val d = delegate()
            return if (d is X509ExtendedKeyManager) {
                d.chooseEngineClientAlias(keyType, issuers, engine)
            } else {
                d?.chooseClientAlias(keyType, issuers, null)
            }
        }

        override fun chooseEngineServerAlias(
            keyType: String?,
            issuers: Array<out Principal>?,
            engine: SSLEngine?,
        ): String? {
            val d = delegate()
            return if (d is X509ExtendedKeyManager) {
                d.chooseEngineServerAlias(keyType, issuers, engine)
            } else {
                d?.chooseServerAlias(keyType, issuers, null)
            }
        }
    }

    /**
     * Extended trust wrapper so OkHttp/Conscrypt keep session-aware checks,
     * CT enforcement, and Network Security Config behavior on the unenrolled path.
     */
    private val dynamicTrustManager: X509ExtendedTrustManager = object : X509ExtendedTrustManager() {
        private fun current(): X509TrustManager = trustManagerDelegate()

        override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {
            current().checkClientTrusted(chain, authType)
        }

        override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
            current().checkServerTrusted(chain, authType)
        }

        override fun checkClientTrusted(
            chain: Array<X509Certificate>,
            authType: String,
            socket: Socket,
        ) {
            when (val tm = current()) {
                is X509ExtendedTrustManager -> tm.checkClientTrusted(chain, authType, socket)
                else -> tm.checkClientTrusted(chain, authType)
            }
        }

        override fun checkServerTrusted(
            chain: Array<X509Certificate>,
            authType: String,
            socket: Socket,
        ) {
            when (val tm = current()) {
                is X509ExtendedTrustManager -> tm.checkServerTrusted(chain, authType, socket)
                else -> tm.checkServerTrusted(chain, authType)
            }
        }

        override fun checkClientTrusted(
            chain: Array<X509Certificate>,
            authType: String,
            engine: SSLEngine,
        ) {
            when (val tm = current()) {
                is X509ExtendedTrustManager -> tm.checkClientTrusted(chain, authType, engine)
                else -> tm.checkClientTrusted(chain, authType)
            }
        }

        override fun checkServerTrusted(
            chain: Array<X509Certificate>,
            authType: String,
            engine: SSLEngine,
        ) {
            when (val tm = current()) {
                is X509ExtendedTrustManager -> tm.checkServerTrusted(chain, authType, engine)
                else -> tm.checkServerTrusted(chain, authType)
            }
        }

        override fun getAcceptedIssuers(): Array<X509Certificate> = current().acceptedIssuers
    }

    companion object {
        private const val TAG = "DeviceIdentityStore"

        /** On-disk bag under [Context.getFilesDir]. */
        const val P12_FILE = "device.p12"

        /** EncryptedSharedPreferences file (also excluded from backup). */
        const val VAULT_FILE = "rivet_device_identity"

        private const val KEY_PASSPHRASE = "p12_passphrase"

        /**
         * Tink keyset SharedPreferences files used by EncryptedSharedPreferences.
         * Hardware-bound MasterKey never restores; leftover keysets crash create().
         */
        private val TINK_KEYSET_PREFS = listOf(
            "__androidx_security_crypto_encrypted_prefs_key_keyset__",
            "__androidx_security_crypto_encrypted_prefs_value_keyset__",
        )

        private fun openVault(context: Context): SharedPreferences {
            return try {
                createVault(context)
            } catch (e: Exception) {
                // Classic restore pitfall: keysets restored, MasterKey not. Also
                // covers Keystore eviction after lockscreen removal.
                Log.w(TAG, "vault open failed; wipe-and-recreate: ${e.message}")
                wipeVaultState(context)
                createVault(context)
            }
        }

        private fun createVault(context: Context): SharedPreferences {
            val masterKey = MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            return EncryptedSharedPreferences.create(
                context,
                VAULT_FILE,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
        }

        private fun wipeVaultState(context: Context) {
            runCatching { context.deleteSharedPreferences(VAULT_FILE) }
            TINK_KEYSET_PREFS.forEach { name ->
                runCatching { context.deleteSharedPreferences(name) }
            }
            // Passphrase is gone; orphaned bag would only confuse hasIdentity().
            runCatching { File(context.filesDir, P12_FILE).delete() }
        }
    }
}
