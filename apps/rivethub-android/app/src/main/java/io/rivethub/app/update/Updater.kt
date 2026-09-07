package io.rivethub.app.update

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.core.content.FileProvider
import io.rivethub.app.gateway.GatewayException
import io.rivethub.app.gateway.HarnessGateway
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlin.coroutines.coroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.yield
import java.io.File
import java.security.MessageDigest
import kotlin.math.ceil

sealed class UpdateState {
    data object Checking : UpdateState()
    data class UpToDate(val current: String) : UpdateState()
    data class Available(val entry: AndroidManifestEntry) : UpdateState()
    data object NoAndroidBuild : UpdateState()
    data class Error(val message: String) : UpdateState()
    /** Verified APK is on disk; unknown-sources permission is still missing. */
    data class NeedsInstallPermission(val file: File, val entry: AndroidManifestEntry) : UpdateState()
}

/**
 * Mesh-feed updater. Fetches `builds/rivethub/latest.json` through the
 * connected gateway, streams the APK to cacheDir/updates/<file>.part,
 * verifies sha256 over the bytes written, then renameTo(<file>) and
 * hands that file to the system installer.
 *
 * One instance per process (constructed in AppContainer): the Mutex and
 * the cache dir are owned here, not per Settings composition.
 */
class Updater(
    private val cacheDir: File,
    private val currentCode: Int,
    private val currentName: String,
) {
    private val flight = Mutex()

    private fun currentLabel(): String = currentName.removeSuffix("-debug")

    suspend fun check(gateway: HarnessGateway): UpdateState = flight.withLock {
        try {
            val body = gateway.filesDownload(MANIFEST_PATH) { res ->
                readCapped(res.body.byteStream(), MANIFEST_MAX_BYTES)
            }
            val entry = parseAndroidEntry(body) ?: return@withLock UpdateState.NoAndroidBuild
            if (isNewer(entry, currentCode, currentName)) UpdateState.Available(entry)
            else UpdateState.UpToDate(currentLabel())
        } catch (e: CancellationException) {
            throw e
        } catch (e: GatewayException) {
            UpdateState.Error("no update manifest on this node (${e.status})")
        } catch (e: Exception) {
            UpdateState.Error(e.message ?: e.javaClass.simpleName)
        }
    }

    /**
     * Re-fetch the manifest at install time (no stale check-time state).
     * A missing `android` entry is UpToDate — the published build is gone.
     */
    suspend fun prepareInstall(gateway: HarnessGateway): UpdateState {
        val latest = check(gateway)
        return when (latest) {
            is UpdateState.NoAndroidBuild -> UpdateState.UpToDate(currentLabel())
            else -> latest
        }
    }

    /**
     * Stream [entry.file] to `cacheDir/updates/<file>.part`. Digest is created
     * inside the download lambda so a client-failover retry starts clean.
     * renameTo(<file>) only after the sha matches. Failure deletes the owned
     * `.part` File, never a completed sibling `<file>`.
     * Byte cap is min(sizeBytes*1.05, 512 MiB).
     */
    suspend fun download(
        gateway: HarnessGateway,
        entry: AndroidManifestEntry,
        onProgress: suspend (Float) -> Unit = {},
    ): File = flight.withLock {
        withContext(Dispatchers.IO) {
            val dir = File(cacheDir, UPDATES_DIR).apply { mkdirs() }
            val dest = File(dir, entry.file)
            val cap = minOf(
                ceil(entry.sizeBytes * 1.05).toLong().coerceAtLeast(1L),
                HARD_MAX_BYTES,
            )
            var ownedPart: File? = null
            try {
                gateway.filesDownload("$BUILDS_PREFIX/${entry.file}") { res ->
                    val digest = MessageDigest.getInstance("SHA-256")
                    val part = File(dir, "${entry.file}.part")
                    ownedPart = part
                    val src = res.body.byteStream()
                    val buf = ByteArray(64 * 1024)
                    var received = 0L
                    part.outputStream().use { out ->
                        while (true) {
                            coroutineContext.ensureActive()
                            val n = src.read(buf)
                            if (n < 0) break
                            received += n
                            if (received > cap) {
                                error("download exceeded $cap bytes — refusing")
                            }
                            digest.update(buf, 0, n)
                            out.write(buf, 0, n)
                            onProgress(progress(received, entry.sizeBytes))
                        }
                    }
                    val hex = hexLower(digest.digest())
                    if (hex != entry.sha256) {
                        error("sha256 mismatch — refusing to run the artifact")
                    }
                    if (!part.renameTo(dest)) {
                        error("could not promote verified update")
                    }
                    dest
                }
            } catch (e: CancellationException) {
                ownedPart?.delete()
                throw e
            } catch (e: Exception) {
                ownedPart?.delete()
                // OkHttp reports a cancelled call as IOException("canceled");
                // once our coroutine is cancelled that is cancellation, not failure.
                if (!coroutineContext.isActive) {
                    throw CancellationException("update download cancelled").apply { initCause(e) }
                }
                throw e
            }
        }
    }

    /**
     * Re-hash [file] and return it only when the digest matches [entry].
     * Used to reuse a verified APK after the user grants unknown-sources.
     */
    suspend fun reuseVerified(file: File, entry: AndroidManifestEntry): File = flight.withLock {
        withContext(Dispatchers.IO) {
            if (!file.isFile) error("verified update is gone")
            val digest = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { ins ->
                val buf = ByteArray(64 * 1024)
                while (true) {
                    val n = ins.read(buf)
                    if (n < 0) break
                    digest.update(buf, 0, n)
                }
            }
            val hex = hexLower(digest.digest())
            if (hex != entry.sha256) {
                file.delete()
                error("sha256 mismatch — refusing to run the artifact")
            }
            file
        }
    }

    /**
     * Launch the system package installer. Returns false when unknown-sources
     * permission is missing (settings page opened; caller must keep [file]).
     * true means startActivity was accepted, not that the system installer
     * completed (signature mismatch / downgrade refusal is a residual).
     */
    fun install(context: Context, file: File): Boolean {
        if (!context.packageManager.canRequestPackageInstalls()) {
            context.startActivity(
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
                    .setData(Uri.parse("package:${context.packageName}"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            return false
        }
        val uri = FileProvider.getUriForFile(
            context,
            "${context.packageName}.fileprovider",
            file,
        )
        context.startActivity(
            Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK),
        )
        return true
    }

    companion object {
        const val UPDATES_DIR = "updates"
        private const val MANIFEST_MAX_BYTES = 1024 * 1024
        private const val HARD_MAX_BYTES = 512L * 1024L * 1024L
        private const val HEX = "0123456789abcdef"

        fun progress(received: Long, total: Long): Float =
            if (total <= 0L) 0f else (received.toFloat() / total.toFloat()).coerceIn(0f, 1f)

        fun hexLower(bytes: ByteArray): String {
            val out = CharArray(bytes.size * 2)
            var i = 0
            for (b in bytes) {
                val v = b.toInt() and 0xff
                out[i++] = HEX[v ushr 4]
                out[i++] = HEX[v and 0x0f]
            }
            return String(out)
        }

        suspend fun readCapped(src: java.io.InputStream, max: Int): String {
            val buf = ByteArray(8 * 1024)
            val out = java.io.ByteArrayOutputStream()
            var n = 0
            while (true) {
                coroutineContext.ensureActive()
                val r = src.read(buf)
                if (r < 0) break
                n += r
                if (n > max) error("update manifest is implausibly large")
                out.write(buf, 0, r)
                yield()
            }
            return out.toString(Charsets.UTF_8)
        }
    }
}
