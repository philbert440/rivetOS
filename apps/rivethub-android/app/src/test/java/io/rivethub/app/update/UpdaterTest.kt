package io.rivethub.app.update

import io.rivethub.app.gateway.HarnessGateway
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.buffer
import okio.source
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.io.InputStream
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

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
        """{"android":{"version":"0.${versionCode / 1000}.${versionCode % 1000}","versionCode":$versionCode,"file":"$file","sha256":"$sha256","sizeBytes":$sizeBytes}}"""

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

    @Test fun `download writes verified bytes and leaves sibling files`() = runBlocking {
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
                assertEquals(apkName, out.name)
                assertTrue(out.readBytes().contentEquals(payload))
                assertFalse(File(updates, "$apkName.part").exists())
                assertTrue(File(updates, "stale.apk").exists())
                assertEquals(1f, last)
            } finally {
                dir.deleteRecursively()
            }
        }
    }

    @Test fun `part file is deleted on failure and dest is never created`() = runBlocking {
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
                val updates = File(dir, Updater.UPDATES_DIR)
                assertFalse(File(updates, apkName).exists())
                assertFalse(File(updates, "$apkName.part").exists())
            } finally {
                dir.deleteRecursively()
            }
        }
    }

    @Test fun `concurrent downloads do not delete each other's completed file`() = runBlocking {
        withTimeout(5_000) {
            val dir = tempDir()
            try {
                val payloadB = "other-apk-bytes".toByteArray()
                val entryA = AndroidManifestEntry("0.5.22", 5022, "A.apk", payloadSha, payload.size.toLong())
                val entryB = AndroidManifestEntry("0.5.23", 5023, "B.apk", sha(payloadB), payloadB.size.toLong())
                val u1 = updater(dir)
                val u2 = updater(dir)
                val f1 = u1.download(gw { bytes(it, 200, payload) }, entryA)
                assertTrue(f1.isFile)
                try {
                    u2.download(
                        gw { bytes(it, 200, payloadB) },
                        entryB.copy(sha256 = "d".repeat(64)),
                    )
                    throw AssertionError("expected sha mismatch")
                } catch (e: Exception) {
                    assertTrue(e.message!!.contains("sha256 mismatch"))
                }
                assertTrue(f1.isFile)
                assertTrue(f1.readBytes().contentEquals(payload))
                assertFalse(File(File(dir, Updater.UPDATES_DIR), "B.apk").exists())
                assertFalse(File(File(dir, Updater.UPDATES_DIR), "B.apk.part").exists())
            } finally {
                dir.deleteRecursively()
            }
        }
    }

    @Test fun `cancellation unwinds a stalled fake stream`() = runBlocking {
        withTimeout(5_000) {
            val dir = tempDir()
            try {
                val started = CountDownLatch(1)
                val http = OkHttpClient.Builder().addInterceptor { chain ->
                    val req = chain.request()
                    val call = chain.call()
                    val src = object : InputStream() {
                        override fun read(): Int {
                            started.countDown()
                            while (!call.isCanceled()) {
                                try {
                                    Thread.sleep(20)
                                } catch (_: InterruptedException) {
                                    throw java.io.IOException("interrupted")
                                }
                            }
                            throw java.io.IOException("canceled")
                        }
                        override fun read(b: ByteArray, off: Int, len: Int): Int {
                            val v = read()
                            if (v < 0) return -1
                            b[off] = v.toByte()
                            return 1
                        }
                    }
                    Response.Builder()
                        .request(req)
                        .protocol(Protocol.HTTP_1_1)
                        .code(200)
                        .message("OK")
                        .body(object : ResponseBody() {
                            override fun contentType() = "application/octet-stream".toMediaType()
                            override fun contentLength() = 1_000_000L
                            override fun source() = src.source().buffer()
                        })
                        .build()
                }.build()
                val g = HarnessGateway(http, base)
                val u = updater(dir)
                val entry = AndroidManifestEntry("0.5.22", 5022, apkName, payloadSha, 1000)
                val job = launch(Dispatchers.IO) { u.download(g, entry) }
                assertTrue(started.await(2, TimeUnit.SECONDS))
                job.cancel()
                job.join()
                val updates = File(dir, Updater.UPDATES_DIR)
                assertFalse(File(updates, apkName).exists())
                assertFalse(File(updates, "$apkName.part").exists())
            } finally {
                dir.deleteRecursively()
            }
        }
    }

    @Test fun `digest is fresh on client failover retry`() = runBlocking {
        withTimeout(5_000) {
            val dir = tempDir()
            try {
                val poison = byteArrayOf(9, 9, 9, 9)
                val primary = client { req ->
                    val src = object : InputStream() {
                        var sent = false
                        override fun read(b: ByteArray, off: Int, len: Int): Int {
                            if (!sent) {
                                sent = true
                                poison.copyInto(b, off)
                                return poison.size
                            }
                            throw java.net.SocketTimeoutException("stalled")
                        }
                        override fun read(): Int = throw java.net.SocketTimeoutException("stalled")
                    }
                    Response.Builder()
                        .request(req)
                        .protocol(Protocol.HTTP_1_1)
                        .code(200)
                        .message("OK")
                        .body(object : ResponseBody() {
                            override fun contentType() = "application/vnd.android.package-archive".toMediaType()
                            override fun contentLength() = poison.size.toLong()
                            override fun source() = src.source().buffer()
                        })
                        .build()
                }
                val fallback = client { bytes(it, 200, payload) }
                val g = HarnessGateway(primary, base, fallback)
                val entry = AndroidManifestEntry("0.5.22", 5022, apkName, payloadSha, payload.size.toLong())
                val out = updater(dir).download(g, entry)
                assertTrue(out.isFile)
                assertTrue(out.readBytes().contentEquals(payload))
            } finally {
                dir.deleteRecursively()
            }
        }
    }

    @Test fun `re-fetch before install drops to UpToDate when entry is gone`() = runBlocking {
        withTimeout(5_000) {
            val dir = tempDir()
            try {
                val pending = AndroidManifestEntry("0.5.22", 5022, apkName, payloadSha, payload.size.toLong())
                val state = updater(dir).prepareInstall(
                    gw { json(it, 200, """{"linux":{"version":"0.5.22"}}""") },
                )
                assertEquals(UpdateState.UpToDate("0.5.0"), state)
                val older = updater(dir).prepareInstall(gw { json(it, 200, manifest(10)) })
                assertEquals(UpdateState.UpToDate("0.5.0"), older)
                val still = updater(dir, code = 5000).prepareInstall(gw { json(it, 200, manifest(5022)) })
                assertEquals(pending.version, (still as UpdateState.Available).entry.version)
            } finally {
                dir.deleteRecursively()
            }
        }
    }

    @Test fun `NeedsInstallPermission reuses the verified file`() = runBlocking {
        withTimeout(5_000) {
            val dir = tempDir()
            try {
                var downloads = 0
                val g = gw { req ->
                    downloads++
                    bytes(req, 200, payload)
                }
                val u = updater(dir)
                val entry = AndroidManifestEntry("0.5.22", 5022, apkName, payloadSha, payload.size.toLong())
                val file = u.download(g, entry)
                assertEquals(1, downloads)
                val reused = u.reuseVerified(file, entry)
                assertEquals(file.canonicalFile, reused.canonicalFile)
                assertTrue(reused.readBytes().contentEquals(payload))
                assertEquals(1, downloads)
                val needs = UpdateState.NeedsInstallPermission(file, entry)
                assertEquals(entry, needs.entry)
                assertTrue(needs.file.isFile)
            } finally {
                dir.deleteRecursively()
            }
        }
    }

    @Test fun `reuseVerified re-hashes the file — a tampered artifact is refused and deleted`() = runBlocking {
        val dir = tempDir()
        try {
            val updates = File(dir, Updater.UPDATES_DIR).apply { mkdirs() }
            val file = File(updates, apkName)
            file.writeBytes(payload + byteArrayOf(0x42))
            val entry = AndroidManifestEntry("0.5.22", 5022, apkName, payloadSha, payload.size.toLong())
            val err = runCatching { updater(dir).reuseVerified(file, entry) }.exceptionOrNull()
            assertTrue(err?.message?.contains("sha256 mismatch") == true)
            assertFalse(file.exists())
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test fun `reuseVerified fails when the verified file is gone`() = runBlocking {
        val dir = tempDir()
        try {
            val entry = AndroidManifestEntry("0.5.22", 5022, apkName, payloadSha, payload.size.toLong())
            val err = runCatching {
                updater(dir).reuseVerified(File(File(dir, Updater.UPDATES_DIR), apkName), entry)
            }.exceptionOrNull()
            assertTrue(err?.message?.contains("gone") == true)
        } finally {
            dir.deleteRecursively()
        }
    }
}
