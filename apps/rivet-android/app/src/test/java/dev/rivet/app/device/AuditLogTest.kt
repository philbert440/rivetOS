package dev.rivet.app.device

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.atomic.AtomicLong

class AuditLogTest {

    @Test
    fun `ring evicts oldest at capacity 200`() {
        val t = AtomicLong(1_000L)
        val log = AuditLog(capacity = 200, clockMs = { t.get() })
        repeat(200) { i ->
            log.record(
                type = "click",
                target = "coords=$i,0",
                outcome = "ok",
                mode = "full",
            )
            t.addAndGet(1)
        }
        assertEquals(200, log.size)
        // one more — drops first
        log.record(type = "swipe", target = "new", outcome = "ok", mode = "full")
        assertEquals(200, log.size)
        val snap = log.snapshot() // newest first
        assertEquals("swipe", snap.first().type)
        assertEquals("new", snap.first().target)
        // oldest remaining should be the former index 1 (coords=1), not coords=0
        assertEquals("click", snap.last().type)
        assertEquals("coords=1,0", snap.last().target)
    }

    @Test
    fun `snapshot is newest first`() {
        val t = AtomicLong(100L)
        val log = AuditLog(capacity = 10, clockMs = { t.get() })
        log.record(type = "a", outcome = "ok", mode = "full")
        t.addAndGet(10)
        log.record(type = "b", outcome = "ok", mode = "full")
        t.addAndGet(10)
        log.record(type = "c", outcome = "ok", mode = "full")
        val types = log.snapshot().map { it.type }
        assertEquals(listOf("c", "b", "a"), types)
    }

    @Test
    fun `confirmed flag recorded`() {
        val log = AuditLog(capacity = 5)
        log.record(
            type = "intent",
            action = "android.intent.action.VIEW",
            target = "scheme=sms",
            outcome = "ok",
            mode = "full",
            confirmed = true,
        )
        val e = log.snapshot().first()
        assertTrue(e.confirmed)
        val json = e.toJson()
        assertTrue(json.getBoolean("confirmed"))
        assertEquals("intent", json.getString("type"))
        assertEquals("scheme=sms", json.getString("target"))
    }

    @Test
    fun `no pixel invariant on normal entries`() {
        val log = AuditLog(capacity = 10)
        log.record(
            type = "click",
            target = "coords=10,20",
            outcome = "ok",
            mode = "full",
        )
        log.record(
            type = "text",
            target = "text_len=42 mode=replace",
            outcome = "ok",
            mode = "full",
        )
        log.record(
            type = "clipboard",
            target = "op=get text_len=100",
            outcome = "ok",
            mode = "full",
        )
        assertTrue(log.assertNoPixelPayloads())
    }

    @Test
    fun `assertNoPixelPayloads rejects jpeg base64 prefix`() {
        val log = AuditLog(capacity = 5)
        log.record(
            type = "screenshot",
            target = "/9j/4AAQSkZJRg==",
            outcome = "ok",
            mode = "full",
        )
        assertFalse(log.assertNoPixelPayloads())
    }

    @Test
    fun `auditTargetSummary redacts text to length`() {
        val req = JSONObject()
            .put("type", "text")
            .put("text", "secret password here")
            .put("mode", "replace")
        val s = auditTargetSummary(req, "text")
        assertTrue(s!!.contains("text_len="))
        assertFalse(s.contains("secret"))
        assertFalse(s.contains("password"))
    }

    @Test
    fun `auditTargetSummary intent uses scheme not full body`() {
        val req = JSONObject()
            .put("type", "intent")
            .put("action", "android.intent.action.VIEW")
            .put("data", "sms:5551234?body=do%20not%20log%20this")
        val s = auditTargetSummary(req, "intent")!!
        assertTrue(s.contains("scheme=sms"))
        assertFalse(s.contains("do%20not"))
        assertFalse(s.contains("body="))
    }

    @Test
    fun `auditTargetSummary clipboard length only`() {
        val req = JSONObject()
            .put("op", "set")
            .put("text", "clipboard secret")
        val s = auditTargetSummary(req, "clipboard")!!
        assertTrue(s.contains("op=set"))
        assertTrue(s.contains("text_len="))
        assertFalse(s.contains("secret"))
    }

    @Test
    fun `toJsonArray newest first matches snapshot`() {
        val log = AuditLog(capacity = 5)
        log.record(type = "one", outcome = "ok", mode = "eyes")
        log.record(type = "two", outcome = "needs_confirm", mode = "full")
        val arr = log.toJsonArray()
        assertEquals(2, arr.length())
        assertEquals("two", arr.getJSONObject(0).getString("type"))
        assertEquals("needs_confirm", arr.getJSONObject(0).getString("outcome"))
        assertEquals("one", arr.getJSONObject(1).getString("type"))
    }

    @Test
    fun `auditOutcomeFromHttp reads error and ok`() {
        val ok = jsonResponse(200, JSONObject().put("ok", true).put("type", "click"))
        assertEquals("ok", auditOutcomeFromHttp(ok))
        val nc = SafetyPolicy.needsConfirmResponse("sms")
        assertEquals("needs_confirm", auditOutcomeFromHttp(nc))
        val den = SafetyPolicy.deniedResponse("factory_reset")
        assertEquals("denied", auditOutcomeFromHttp(den))
    }
}
