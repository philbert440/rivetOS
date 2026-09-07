package io.rivethub.app.update

import io.rivethub.app.gateway.HarnessGateway
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.security.MessageDigest

class UpdaterTest {
    private val base = "https://192.0.2.10:5174"
    private val apkName = "RivetHub-0.5.22.apk"
    private val payload = "apk-bytes-for-test".toByteArray()
    private val payloadSha = sha(payload)

    private fun client(handler: (Request) -> Response): OkHttpClient =
        OkHttpClient.Builder().addInterceptor { chain -> handler(chain.request()) }.build()

    private fun json(req: Request, code: Int, body: String): Response =
        Response.Builder()
            .request(req)
            .protocol(Protocol.HTTP_1_1)
            .code(code)
            .message(if (code in 200..299) "OK" else "ERR")
            .body(body.toResponseBody("application/json".toMediaType()))
            .build()

    private fun bytes(req: Request, code: Int, body: ByteArray): Response =
        Response.Builder()
            .request(req)
            .protocol(Protocol.HTTP_1_1)
            .code(code)
            .message(if (code in 200..299) "OK" else "ERR")
            .body(body.toResponseBody("application/vnd.android.package-archive".toMediaType()))
            .build()

    private fun sha(bytes: ByteArray): String = Updater.hexLower(MessageDigest.getInstance("SHA-256").digest(bytes))

    private fun manifest(versionCode: Int, sha256: String = payloadSha, sizeBytes: Long = payload.size.toLong(), file: String = apkName): String =
        """{"android":{"version":"0.5.22","versionCode":$versionCode,"file":"$file","sha256":"$sha256","sizeBytes":$sizeBytes}}"""

    private fun gw(handler: (Request) -> Response) = HarnessGateway(client(handler), base)

    private fun tempDir(): File = java.nio.file.Files.createTempDirectory("rivet-upd-").toFile()

    private fun updater(dir: File, code: Int = 5000, name: String = "0.5.0") = Updater(dir, code, name)

    @Test fun `newer android build is Available`() = runBlocking {
        withTimeout(5_000) {
            val seen = mutableListOf<String?>()
            val dir = tempDir()
            try {
                val state = updater(dir).check(
                    gw { req ->
                        seen += req.url.queryParameter("path")
                        json(req, 200, manifest(5022))
                    },
                )
                val avail = state as UpdateState.Available
                assertEquals("0.5.22", avail.entry.version)
                assertEquals(5022, avail.entry.versionCode)
                assertEquals(listOf(MANIFEST_PATH), seen)
            } finally {
                dir.deleteRecursively()
            }
        }
    }

    @Test fun `same versionCode is UpToDate`() = runBlocking {
        withTimeout(5_000) {
            val dir = tempDir()
            try {
                val state = updater(dir, code = 5022, name = "0.5.22-debug").check(gw { json(it, 200, manifest(5022)) })
                assertEquals(UpdateState.UpToDate("0.5.22"), state)
            } finally {
                dir.deleteRecursively()
            }
        }
    }

    @Test fun `older versionCode is UpToDate`() = runBlocking {
        withTimeout(5_000) {
            val dir = tempDir()
            try {
                val state = updater(dir, code = 5022, name = "0.5.22").check(gw { json(it, 200, manifest(5010)) })
                assertEquals(UpdateState.UpToDate("0.5.22"), state)
            } finally {
                dir.deleteRecursively()
            }
        }
    }

    @Test fun `missing android key is NoAndroidBuild`() = runBlocking {
        withTimeout(5_000) {
            val dir = tempDir()
            try {
                val state = updater(dir).check(gw { json(it, 200, """{"linux":{"version":"0.5.22"}}""") })
                assertEquals(UpdateState.NoAndroidBuild, state)
            } finally {
                dir.deleteRecursively()
            }
        }
    }

    @Test fun `sha mismatch deletes the file`() = runBlocking {
        withTimeout(5_000) {
            val dir = tempDir()
            try {
                val u = updater(dir)
                val entry = AndroidManifestEntry("0.5.22", 5022, apkName, "c".repeat(64), payload.size.toLong())
                try {
                    u.download(gw { bytes(it, 200, payload) }, entry)
                    throw AssertionError("expected sha mismatch")
                } catch (e: Exception) {
                    assertTrue(e.message!!.contains("sha256 mismatch"))
                }
                val dest = File(File(dir, Updater.UPDATES_DIR), apkName)
                assertFalse(dest.exists())
            } finally {
                dir.deleteRecursively()
            }
        }
    }

    @Test fun `byte cap deletes the file`() = runBlocking {
        withTimeout(5_000) {
            val dir = tempDir()
            try {
                val u = updater(dir)
                val entry = AndroidManifestEntry("0.5.22", 5022, apkName, payloadSha, sizeBytes = 10)
                val big = ByteArray(1000) { 1 }
                try {
                    u.download(gw { bytes(it, 200, big) }, entry)
                    throw AssertionError("expected byte cap")
                } catch (e: Exception) {
                    assertTrue(e.message!!.contains("exceeded"))
                }
                val dest = File(File(dir, Updater.UPDATES_DIR), apkName)
                assertFalse(dest.exists())
            } finally {
                dir.deleteRecursively()
            }
        }
    }

    @Test fun `download writes verified bytes and clears stale files`() = runBlocking {
        withTimeout(5_000) {
            val dir = tempDir()
            try {
                val updates = File(dir, Updater.UPDATES_DIR).apply { mkdirs() }
                File(updates, "stale.apk").writeText("old")
                val u = updater(dir)
                val entry = AndroidManifestEntry("0.5.22", 5022, apkName, payloadSha, payload.size.toLong())
                var last = 0f
                val seen = mutableListOf<String?>()
                val out = u.download(
                    gw { req ->
                        seen += req.url.queryParameter("path")
                        bytes(req, 200, payload)
                    },
                    entry,
                ) { last = it }
                assertEquals("$BUILDS_PREFIX/$apkName", seen.single())
                assertTrue(out.isFile)
                assertTrue(out.readBytes().contentEquals(payload))
                assertFalse(File(updates, "stale.apk").exists())
                assertEquals(1f, last)
            } finally {
                dir.deleteRecursively()
            }
        }
    }
}
