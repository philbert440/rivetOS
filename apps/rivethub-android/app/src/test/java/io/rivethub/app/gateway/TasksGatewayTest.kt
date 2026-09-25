package io.rivethub.app.gateway

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.junit.Assert.*
import org.junit.Test

class TasksGatewayTest {
    private val id = "12345678-1234-4234-8234-123456789abc"
    private fun gateway(handler: (Request) -> Pair<Int, String>): Gateway {
        val client = OkHttpClient.Builder().addInterceptor { chain ->
            val request = chain.request()
            val (code, body) = handler(request)
            Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(code).message("fixture")
                .body(body.toResponseBody("application/json".toMediaType())).build()
        }.build()
        return Gateway(client, "https://den.example/rivet")
    }

    @Test fun `invalid task ids never reach the transport`() = runBlocking {
        var calls = 0
        val gateway = gateway { calls++; 200 to "{}" }
        val actions: List<suspend (String) -> Unit> = listOf(
            { gateway.task(it); Unit }, { gateway.taskWait(it, 2000); Unit },
            { gateway.taskSteer(it, "Continue"); Unit }, { gateway.taskKill(it); Unit },
        )
        for (invalid in listOf("", "not-a-uuid", "$id/steer", "$id?wait=1", "$id\n")) {
            for (action in actions) {
                try {
                    action(invalid)
                    fail("Invalid task id must be rejected")
                } catch (_: IllegalArgumentException) { }
            }
        }
        assertEquals(0, calls)
    }

    @Test fun `task list preserves base path and encodes optional filters`() = runBlocking {
        var calls = 0
        val gateway = gateway { request ->
            calls++
            assertEquals("GET", request.method)
            assertEquals("/rivet/api/tasks", request.url.encodedPath)
            assertEquals("awaiting-input", request.url.queryParameter("status"))
            assertEquals("agent & helper", request.url.queryParameter("agentId"))
            assertEquals("25", request.url.queryParameter("limit"))
            200 to """{"tasks":[]}"""
        }
        assertTrue(gateway.tasks("awaiting-input", "agent & helper", 25).tasks.isEmpty())
        assertEquals(1, calls)
    }

    @Test fun `default list omits optional filters`() = runBlocking {
        gateway { request ->
            assertNull(request.url.queryParameter("status"))
            assertNull(request.url.queryParameter("agentId"))
            assertEquals("100", request.url.queryParameter("limit"))
            200 to """{"tasks":[]}"""
        }.tasks()
        Unit
    }

    @Test fun `create steer kill and detail use task routes and request bodies`() = runBlocking {
        val seen = mutableListOf<String>()
        val gateway = gateway { request ->
            val path = request.url.encodedPath
            seen += "${request.method} $path"
            assertNull(request.url.queryParameter("wait"))
            val body = request.body?.let { Buffer().also(it::writeTo).readUtf8() }
            when {
                path.endsWith("/steer") -> {
                    assertEquals("Continue", wireJson.parseToJsonElement(body!!).jsonObject["message"]!!.jsonPrimitive.content)
                    200 to """{"ok":true}"""
                }
                path.endsWith("/kill") -> 200 to """{"ok":true,"prior":"running"}"""
                request.method == "POST" -> {
                    val json = wireJson.parseToJsonElement(body!!).jsonObject
                    assertEquals("rivethub", json["requestedBy"]!!.jsonPrimitive.content)
                    assertEquals("reviewer", json["agentId"]!!.jsonPrimitive.content)
                    assertFalse(json.containsKey("executor"))
                    201 to """{"task":{"id":"$id"}}"""
                }
                else -> 200 to """{"task":{"id":"$id","status":"running"}}"""
            }
        }
        assertEquals(id, gateway.taskCreate(TaskCreateRequest("Review", "reviewer")).task.id)
        assertEquals("running", gateway.task(id).task.status)
        gateway.taskSteer(id, "Continue")
        assertEquals("running", gateway.taskKill(id).prior)
        assertEquals(listOf("POST /rivet/api/tasks", "GET /rivet/api/tasks/$id", "POST /rivet/api/tasks/$id/steer", "POST /rivet/api/tasks/$id/kill"), seen)
    }

    @Test fun `wait is one call and maps only 504 to null`() = runBlocking {
        var calls = 0
        var code = 504
        val gateway = gateway { request ->
            calls++
            assertEquals("/rivet/api/tasks/$id/wait", request.url.encodedPath)
            assertEquals("2000", request.url.queryParameter("timeoutMs"))
            code to if (code == 200) """{"task":{"id":"$id","status":"completed"}}""" else """{"error":"fixture"}"""
        }
        assertNull(gateway.taskWait(id, 2000))
        assertEquals(1, calls)
        code = 200
        assertEquals("completed", gateway.taskWait(id, 2000)!!.task.status)
        assertEquals(2, calls)
        code = 404
        try {
            gateway.taskWait(id, 2000)
            fail("404 must propagate")
        } catch (e: GatewayException) { assertEquals(404, e.status) }
        assertEquals(3, calls)
    }
}
