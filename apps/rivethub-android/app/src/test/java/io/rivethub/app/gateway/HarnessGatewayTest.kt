package io.rivethub.app.gateway

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
import java.util.concurrent.CopyOnWriteArrayList

class HarnessGatewayTest {
    private val sid = "claude-code:a1b2c3d4-1111-4222-8333-444455556666"
    private val enc = sessionKeyEnc(sid)
    private val base = "https://192.0.2.10:5174"

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

    @Test fun `listHarnesses hits GET api harnesses`() = runBlocking {
        withTimeout(2_000) {
            val seen = CopyOnWriteArrayList<String>()
            val gw = HarnessGateway(
                client { req ->
                    seen += req.url.encodedPath
                    json(req, 200, """{"harnesses":[{"harnessId":"claude-code","capabilities":{"interrupt":true,"resume":true,"approvals":false,"liveStream":true,"listSessions":true}}]}""")
                },
                base,
            )
            val rows = gw.listHarnesses()
            assertEquals("claude-code", rows.single().harnessId)
            assertTrue(rows.single().capabilities.listSessions)
            assertTrue(seen.single().endsWith("/api/harnesses"))
        }
    }

    @Test fun `listSessions gated on capabilities does not hit the node`() = runBlocking {
        withTimeout(2_000) {
            var hits = 0
            val gw = HarnessGateway(client { req -> hits++; json(req, 500, """{"error":"no"}""") }, base)
            val caps = HarnessCapabilities(listSessions = false)
            assertEquals(emptyList<HarnessSessionSummary>(), gw.listSessions("claude-code", caps))
            assertEquals(0, hits)
        }
    }

    @Test fun `listSessions fetches when listSessions is true`() = runBlocking {
        withTimeout(2_000) {
            val seen = CopyOnWriteArrayList<String>()
            val gw = HarnessGateway(
                client { req ->
                    seen += req.url.encodedPath
                    json(req, 200, """{"sessions":[{"sessionId":"$sid","harnessId":"claude-code","createdAt":"2026-08-08T00:00:00.000Z","updatedAt":"2026-08-08T00:05:00.000Z","status":"idle"}]}""")
                },
                base,
            )
            val rows = gw.listSessions("claude-code", HarnessCapabilities(listSessions = true))
            assertEquals(sid, rows.single().sessionId)
            assertTrue(seen.single().endsWith("/api/harnesses/claude-code/sessions"))
        }
    }

    @Test fun `legacySessions hits the terminal scan`() = runBlocking {
        withTimeout(2_000) {
            val seen = CopyOnWriteArrayList<String>()
            val gw = HarnessGateway(
                client { req ->
                    seen += req.url.encodedPath
                    json(req, 200, """{"sessions":[{"id":"abc","command":"grok","title":"stored","updatedAt":9}]}""")
                },
                base,
            )
            assertEquals("abc", gw.legacySessions().single().id)
            assertTrue(seen.single().endsWith("/api/terminal/harness-sessions"))
        }
    }

    @Test fun `sendTurn posts UserTurn under the enc path`() = runBlocking {
        withTimeout(2_000) {
            val seen = CopyOnWriteArrayList<String>()
            val gw = HarnessGateway(
                client { req ->
                    seen += "${req.method} ${req.url.encodedPath}"
                    val body = req.body?.let { reqBody ->
                        val buffer = okio.Buffer()
                        reqBody.writeTo(buffer)
                        buffer.readUtf8()
                    } ?: ""
                    assertFalse(body.contains("attachments"))
                    json(req, 202, """{"ok":true,"sessionId":"$sid"}""")
                },
                base,
            )
            val accepted = gw.sendTurn(enc, UserTurn("hello"))
            assertTrue(accepted.ok)
            assertTrue(seen.single().startsWith("POST "))
            assertTrue(seen.single().contains("/api/harness-sessions/"))
            assertTrue(seen.single().endsWith("/turns"))
            assertTrue(seen.single().contains(enc))
        }
    }

    @Test fun `sendTurn 409 turn_in_flight is typed`() = runBlocking {
        withTimeout(2_000) {
            val gw = HarnessGateway(
                client { req -> json(req, 409, """{"error":"claude-code is mid-turn","code":"turn_in_flight"}""") },
                base,
            )
            try {
                gw.sendTurn(enc, UserTurn("hello"))
                org.junit.Assert.fail("expected TurnInFlight")
            } catch (e: TurnInFlight) {
                assertEquals(409, e.status)
            }
        }
    }

    @Test fun `sendTurn 409 other code is a plain GatewayException`() = runBlocking {
        withTimeout(2_000) {
            val gw = HarnessGateway(
                client { req -> json(req, 409, """{"error":"collision","code":"session_id_collision"}""") },
                base,
            )
            try {
                gw.sendTurn(enc, UserTurn("hello"))
                org.junit.Assert.fail("expected GatewayException")
            } catch (e: TurnInFlight) {
                org.junit.Assert.fail("must not be TurnInFlight")
            } catch (e: GatewayException) {
                assertEquals(409, e.status)
            }
        }
    }

    @Test fun `stageUpload posts bytes to api uploads on this node`() = runBlocking {
        withTimeout(2_000) {
            val seen = CopyOnWriteArrayList<String>()
            val gw = HarnessGateway(
                client { req ->
                    seen += "${req.method} ${req.url.encodedPath}?${req.url.query}"
                    json(req, 200, """{"uri":"/tmp/uploads/shot.png","name":"shot.png","mime":"image/png","size":4,"expiresAt":1}""")
                },
                base,
            )
            val staged = gw.stageUpload(byteArrayOf(1, 2, 3, 4), "shot.png")
            assertEquals("/tmp/uploads/shot.png", staged.uri)
            assertTrue(seen.single().startsWith("POST "))
            assertTrue(seen.single().contains("/api/uploads"))
            assertTrue(seen.single().contains("name=shot.png"))
        }
    }

    @Test fun `watch URLs carry the enc and registry path`() {
        val gw = HarnessGateway(client { error("no net") }, base)
        assertTrue(gw.sessionWatchUrl(enc).contains("/api/harness-sessions/ws"))
        assertTrue(gw.sessionWatchUrl(enc).contains("session=$enc") || gw.sessionWatchUrl(enc).contains(enc))
        assertTrue(gw.registryWatchUrl().contains("/api/harnesses/ws"))
        assertFalse(gw.registryWatchUrl().contains("startSession"))
    }

    @Test fun `enc of an id containing colon is used as the path segment`() {
        assertTrue(":" in sid)
        val pathEnc = sessionKeyEnc(sid)
        assertFalse(pathEnc.contains(":"))
        val gw = HarnessGateway(client { error("no") }, base)
        assertTrue(gw.sessionWatchUrl(pathEnc).contains(pathEnc))
    }
}
