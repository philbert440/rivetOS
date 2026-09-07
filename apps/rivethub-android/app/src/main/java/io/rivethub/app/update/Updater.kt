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
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File
import java.security.MessageDigest
import kotlin.math.ceil

sealed class UpdateState {
    data object Checking : UpdateState()
    data class UpToDate(val current: String) : UpdateState()
    data class Available(val entry: AndroidManifestEntry) : UpdateState()
    data object NoAndroidBuild : UpdateState()
    data class Error(val message: String) : UpdateState()
}

/**
 * Mesh-feed updater. Fetches `builds/rivethub/latest.json` through the
 * connected gateway, streams the APK to cacheDir/updates, verifies sha256,
 * then hands the file to the system installer.
 */
class Updater(
    private val cacheDir: File,
    private val currentCode: Int,
    private val currentName: String,
) {
    private val flight = Mutex()

    suspend fun check(gateway: HarnessGateway): UpdateState = flight.withLock {
        try {
            val body = gateway.filesDownload(MANIFEST_PATH) { res ->
                readCapped(res.body.byteStream(), MANIFEST_MAX_BYTES)
            }
            val entry = parseAndroidEntry(body) ?: return@withLock UpdateState.NoAndroidBuild
            if (isNewer(entry, currentCode, currentName)) UpdateState.Available(entry)
            else UpdateState.UpToDate(currentName.removeSuffix("-debug"))
        } catch (e: CancellationException) {
            throw e
        } catch (e: GatewayException) {
            UpdateState.Error("no update manifest on this node (${e.status})")
        } catch (e: Exception) {
            UpdateState.Error(e.message ?: e.javaClass.simpleName)
        }
    }

    /**
     * Stream [entry.file] to `cacheDir/updates/`, deleting stale files first.
     * Byte cap is min(sizeBytes*1.05, 512 MiB). sha256 mismatch deletes the file.
     */
    suspend fun download(
        gateway: HarnessGateway,
        entry: AndroidManifestEntry,
        onProgress: suspend (Float) -> Unit = {},
    ): File = flight.withLock {
        withContext(Dispatchers.IO) {
            val dir = File(cacheDir, UPDATES_DIR).apply { mkdirs() }
            dir.listFiles()?.forEach { it.delete() }
            val dest = File(dir, entry.file)
            val cap = minOf(
                ceil(entry.sizeBytes * 1.05).toLong().coerceAtLeast(1L),
                HARD_MAX_BYTES,
            )
            val digest = MessageDigest.getInstance("SHA-256")
            try {
                gateway.filesDownload("$BUILDS_PREFIX/${entry.file}") { res ->
                    val src = res.body.byteStream()
                    val buf = ByteArray(64 * 1024)
                    var received = 0L
                    dest.outputStream().use { out ->
                        while (true) {
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
                }
            } catch (e: CancellationException) {
                dest.delete()
                throw e
            } catch (e: Exception) {
                dest.delete()
                throw e
            }
            val hex = hexLower(digest.digest())
            if (hex != entry.sha256) {
                dest.delete()
                error("sha256 mismatch — refusing to run the artifact")
            }
            dest
        }
    }

    /**
     * Launch the system package installer. Returns false when unknown-sources
     * permission is missing (and the settings screen has been opened).
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

        fun readCapped(src: java.io.InputStream, max: Int): String {
            val buf = ByteArray(8 * 1024)
            val out = java.io.ByteArrayOutputStream()
            var n = 0
            while (true) {
                val r = src.read(buf)
                if (r < 0) break
                n += r
                if (n > max) error("update manifest is implausibly large")
                out.write(buf, 0, r)
            }
            return out.toString(Charsets.UTF_8)
        }
    }
}
