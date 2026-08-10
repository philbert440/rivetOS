package dev.rivet.app.data.tls

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.io.File
import java.security.Principal
import java.security.PrivateKey
import java.security.cert.X509Certificate
import java.util.concurrent.CopyOnWriteArrayList
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngine
import javax.net.ssl.X509ExtendedKeyManager
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
            vault.edit().putString(KEY_PASSPHRASE, passphrase).commit()
            cached = materials
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
            if (!p12File.isFile || p12File.length() == 0L) return null
            val pass = vault.getString(KEY_PASSPHRASE, null) ?: return null
            val bytes = runCatching { p12File.readBytes() }.getOrElse {
                Log.w(TAG, "failed to read device.p12")
                return null
            }
            val password = pass.toCharArray()
            return try {
                DeviceIdentityCrypto.parsePkcs12(bytes, password).also { cached = it }
            } catch (e: Exception) {
                Log.w(TAG, "failed to unlock device.p12: ${e.message}")
                null
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

    /**
     * KeyManager that presents the imported device leaf when present, and
     * otherwise offers nothing (platform default: no client cert).
     */
    private val dynamicKeyManager: X509ExtendedKeyManager = object : X509ExtendedKeyManager() {
        private fun delegate(): X509KeyManager? {
            val mats = materials() ?: return null
            return mats.keyManagers()
                .filterIsInstance<X509KeyManager>()
                .firstOrNull()
        }

        override fun getClientAliases(keyType: String?, issuers: Array<out Principal>?): Array<String>? =
            delegate()?.getClientAliases(keyType, issuers)

        override fun chooseClientAlias(
            keyType: Array<out String>?,
            issuers: Array<out Principal>?,
            socket: java.net.Socket?,
        ): String? = delegate()?.chooseClientAlias(keyType, issuers, socket)

        override fun getServerAliases(keyType: String?, issuers: Array<out Principal>?): Array<String>? =
            delegate()?.getServerAliases(keyType, issuers)

        override fun chooseServerAlias(
            keyType: String?,
            issuers: Array<out Principal>?,
            socket: java.net.Socket?,
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

    private val dynamicTrustManager: X509TrustManager = object : X509TrustManager {
        private fun current(): X509TrustManager {
            val extra = materials()?.caCertificates.orEmpty()
            return DeviceIdentityCrypto.systemPlusExtraTrustManager(extra)
        }

        override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {
            current().checkClientTrusted(chain, authType)
        }

        override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
            current().checkServerTrusted(chain, authType)
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

        private fun openVault(context: Context): SharedPreferences {
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
    }
}
