package dev.rivet.app.device

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SafetyPolicyTest {

    private fun intent(
        action: String? = "android.intent.action.VIEW",
        data: String? = null,
        packageName: String? = null,
        mimeType: String? = null,
        hasAttachment: Boolean = false,
    ) = ActionDescriptor(
        type = "intent",
        action = action,
        dataUri = data,
        packageName = packageName,
        mimeType = mimeType,
        hasAttachment = hasAttachment,
    )

    // ---- SMS / MMS → NeedConfirm ------------------------------------------------

    @Test
    fun `sms scheme needs confirm`() {
        val v = SafetyPolicy.evaluate(intent(data = "sms:5551234"))
        assertTrue(v is SafetyVerdict.NeedConfirm)
        assertEquals("sms", (v as SafetyVerdict.NeedConfirm).reason)
    }

    @Test
    fun `smsto scheme needs confirm`() {
        val v = SafetyPolicy.evaluate(intent(data = "smsto:+15551212?body=hi"))
        assertTrue(v is SafetyVerdict.NeedConfirm)
        assertEquals("sms", (v as SafetyVerdict.NeedConfirm).reason)
    }

    @Test
    fun `mms and mmsto need confirm`() {
        assertTrue(SafetyPolicy.evaluate(intent(data = "mms:1")) is SafetyVerdict.NeedConfirm)
        assertTrue(SafetyPolicy.evaluate(intent(data = "mmsto:1")) is SafetyVerdict.NeedConfirm)
    }

    @Test
    fun `SENDTO without scheme needs confirm`() {
        val v = SafetyPolicy.evaluate(
            intent(action = "android.intent.action.SENDTO", data = null),
        )
        assertTrue(v is SafetyVerdict.NeedConfirm)
    }

    // ---- tel → Allow ------------------------------------------------------------

    @Test
    fun `tel dial is allow with reason`() {
        val v = SafetyPolicy.evaluate(intent(data = "tel:+15551212"))
        assertTrue(v is SafetyVerdict.Allow)
        assertEquals("tel", (v as SafetyVerdict.Allow).reason)
        assertFalse(v.confirmed)
    }

    // ---- share / install / pay → NeedConfirm ------------------------------------

    @Test
    fun `ACTION_SEND needs confirm`() {
        val v = SafetyPolicy.evaluate(
            intent(action = "android.intent.action.SEND", hasAttachment = true),
        )
        assertTrue(v is SafetyVerdict.NeedConfirm)
        assertEquals("share", (v as SafetyVerdict.NeedConfirm).reason)
    }

    @Test
    fun `ACTION_SEND_MULTIPLE needs confirm`() {
        val v = SafetyPolicy.evaluate(
            intent(action = "android.intent.action.SEND_MULTIPLE"),
        )
        assertTrue(v is SafetyVerdict.NeedConfirm)
        assertEquals("share", (v as SafetyVerdict.NeedConfirm).reason)
    }

    @Test
    fun `INSTALL_PACKAGE needs confirm`() {
        val v = SafetyPolicy.evaluate(
            intent(action = "android.intent.action.INSTALL_PACKAGE"),
        )
        assertTrue(v is SafetyVerdict.NeedConfirm)
        assertEquals("installer", (v as SafetyVerdict.NeedConfirm).reason)
    }

    @Test
    fun `apk mime and package scheme need confirm`() {
        assertEquals(
            "installer",
            (SafetyPolicy.evaluate(
                intent(mimeType = "application/vnd.android.package-archive"),
            ) as SafetyVerdict.NeedConfirm).reason,
        )
        assertEquals(
            "installer",
            (SafetyPolicy.evaluate(
                intent(data = "package:com.example.app"),
            ) as SafetyVerdict.NeedConfirm).reason,
        )
    }

    @Test
    fun `payment schemes and actions need confirm`() {
        assertEquals(
            "payment",
            (SafetyPolicy.evaluate(intent(data = "upi://pay?pa=x")) as SafetyVerdict.NeedConfirm).reason,
        )
        assertEquals(
            "payment",
            (SafetyPolicy.evaluate(
                intent(action = "com.google.android.gms.actions.PAY"),
            ) as SafetyVerdict.NeedConfirm).reason,
        )
    }

    // ---- confirm override -------------------------------------------------------

    @Test
    fun `confirm true overrides NeedConfirm to Allow confirmed`() {
        val v = SafetyPolicy.evaluate(
            intent(data = "sms:555"),
            confirm = true,
        )
        assertTrue(v is SafetyVerdict.Allow)
        assertTrue((v as SafetyVerdict.Allow).confirmed)
        assertEquals("sms", v.reason)
    }

    @Test
    fun `confirm false leaves NeedConfirm`() {
        val v = SafetyPolicy.evaluate(intent(data = "smsto:1"), confirm = false)
        assertTrue(v is SafetyVerdict.NeedConfirm)
    }

    @Test
    fun `Deny is never overridable by confirm`() {
        val deny = SafetyVerdict.Deny("factory_reset")
        val still = SafetyPolicy.applyConfirm(deny, confirm = true)
        assertTrue(still is SafetyVerdict.Deny)
        assertEquals("factory_reset", (still as SafetyVerdict.Deny).reason)
    }

    @Test
    fun `FACTORY_RESET is hard deny even with confirm`() {
        val v = SafetyPolicy.evaluate(
            intent(action = "android.intent.action.FACTORY_RESET"),
            confirm = true,
        )
        assertTrue(v is SafetyVerdict.Deny)
    }

    // ---- benign / launch --------------------------------------------------------

    @Test
    fun `https VIEW is allow`() {
        val v = SafetyPolicy.evaluate(
            intent(data = "https://example.com"),
        )
        assertTrue(v is SafetyVerdict.Allow)
        assertFalse((v as SafetyVerdict.Allow).confirmed)
    }

    @Test
    fun `launch package is allow`() {
        val v = SafetyPolicy.evaluate(
            ActionDescriptor(type = "launch", packageName = "com.android.settings"),
        )
        assertTrue(v is SafetyVerdict.Allow)
    }

    @Test
    fun `click and node_action are allow`() {
        assertTrue(
            SafetyPolicy.evaluate(ActionDescriptor(type = "click")) is SafetyVerdict.Allow,
        )
        assertTrue(
            SafetyPolicy.evaluate(
                ActionDescriptor(type = "node_action", action = "click"),
            ) is SafetyVerdict.Allow,
        )
    }

    // ---- HTTP envelopes ---------------------------------------------------------

    @Test
    fun `needsConfirmResponse shape`() {
        val res = SafetyPolicy.needsConfirmResponse("sms")
        assertEquals(200, res.code)
        val body = JSONObject(String(res.body, Charsets.UTF_8))
        assertFalse(body.getBoolean("ok"))
        assertEquals("needs_confirm", body.getString("error"))
        assertTrue(body.getBoolean("requires_confirm"))
        assertEquals("sms", body.getString("reason"))
    }

    @Test
    fun `deniedResponse is 403`() {
        val res = SafetyPolicy.deniedResponse("factory_reset")
        assertEquals(403, res.code)
        val body = JSONObject(String(res.body, Charsets.UTF_8))
        assertEquals("denied", body.getString("error"))
    }

    @Test
    fun `descriptorFromActionJson reads fields`() {
        val req = JSONObject()
            .put("type", "intent")
            .put("action", "android.intent.action.VIEW")
            .put("data", "sms:1")
            .put("package", "com.android.mms")
            .put("confirm", true)
        val d = SafetyPolicy.descriptorFromActionJson(req)
        assertEquals("intent", d.type)
        assertEquals("sms:1", d.dataUri)
        assertEquals("com.android.mms", d.packageName)
        val v = SafetyPolicy.evaluate(d, confirm = req.optBoolean("confirm"))
        assertTrue(v is SafetyVerdict.Allow)
        assertTrue((v as SafetyVerdict.Allow).confirmed)
    }

    @Test
    fun `uriScheme extracts lowercase scheme`() {
        assertEquals("sms", SafetyPolicy.uriScheme("SMS:555"))
        assertEquals("https", SafetyPolicy.uriScheme("https://x"))
        assertEquals(null, SafetyPolicy.uriScheme(null))
        assertEquals(null, SafetyPolicy.uriScheme("no-scheme"))
    }
}
