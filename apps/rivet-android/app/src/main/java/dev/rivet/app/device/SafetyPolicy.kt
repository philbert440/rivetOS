package dev.rivet.app.device

import org.json.JSONObject

/**
 * Heuristic safety gate for control-plane actions (SMS / share / pay / installers).
 * Pure Kotlin — no Android framework types — so JVM unit tests can exercise every branch.
 *
 * Modes (parked/eyes/full) are enforced separately by [isEndpointAllowed]; this policy
 * only classifies action risk and applies the `confirm:true` override.
 *
 * Default strictness (Open Question 4): SMS / share / pay / install → [SafetyVerdict.NeedConfirm].
 * Phil can loosen later. Hard [SafetyVerdict.Deny] is reserved for destructive system intents
 * and is **never** overridable by `confirm`.
 */

// ---------------------------------------------------------------------------
// Descriptor + verdict
// ---------------------------------------------------------------------------

/**
 * Minimal action description for policy evaluation.
 * Built from the POST /action JSON body before dispatch.
 */
data class ActionDescriptor(
    /** Action type wire name: click, intent, launch, node_action, … */
    val type: String,
    /** Intent action string (intent) or node_action / global / clipboard op name. */
    val action: String? = null,
    /** Intent data URI (raw string; scheme extracted for heuristics). */
    val dataUri: String? = null,
    /** Target package (launch / intent / node_click filter). */
    val packageName: String? = null,
    /** MIME type if present on the request (`type` field for share intents is separate). */
    val mimeType: String? = null,
    /** True when the request claims an attachment stream (EXTRA_STREAM / file URI). */
    val hasAttachment: Boolean = false,
    /** Optional free-form target summary already redacted by the caller. */
    val targetHint: String? = null,
)

sealed class SafetyVerdict {
    /**
     * Action may proceed.
     * @param confirmed true when the request overrode a NeedConfirm with `confirm:true`
     * @param reason optional audit note (e.g. "tel dial")
     */
    data class Allow(
        val confirmed: Boolean = false,
        val reason: String? = null,
    ) : SafetyVerdict()

    /**
     * Dangerous surface — agent must re-issue with `"confirm": true`.
     * @param reason stable short tag for message / audit
     */
    data class NeedConfirm(val reason: String) : SafetyVerdict()

    /**
     * Hard block — not overridable by confirm.
     * @param reason stable short tag
     */
    data class Deny(val reason: String) : SafetyVerdict()
}

// ---------------------------------------------------------------------------
// Known dangerous constants (Android intent actions / schemes)
// ---------------------------------------------------------------------------

/** Intent actions that compose / share content. */
private val SHARE_ACTIONS = setOf(
    "android.intent.action.SEND",
    "android.intent.action.SEND_MULTIPLE",
    "android.intent.action.SENDTO",
)

/** Package-installer / package-management intents. */
private val INSTALLER_ACTIONS = setOf(
    "android.intent.action.INSTALL_PACKAGE",
    "android.intent.action.UNINSTALL_PACKAGE",
    "android.intent.action.DELETE", // often used to uninstall via package: URI
    "android.content.pm.action.CONFIRM_INSTALLATION",
    "android.content.pm.action.CONFIRM_PERMISSIONS",
)

/** Payment / wallet related intent actions (heuristic substrings checked separately). */
private val PAYMENT_ACTIONS = setOf(
    "android.intent.action.PAY",
    "com.google.android.gms.actions.PAY",
    "com.google.android.gms.wallet.ACTION_CHECKOUT",
    "org.chromium.intent.action.PAY",
)

/** Destructive system intents — hard Deny (never confirm-overridable). */
private val HARD_DENY_ACTIONS = setOf(
    "android.intent.action.FACTORY_RESET",
    "android.intent.action.MASTER_CLEAR",
    "android.intent.action.ACTION_SHUTDOWN",
)

private val SMS_SCHEMES = setOf("sms", "smsto", "mms", "mmsto")
private val PAYMENT_SCHEMES = setOf(
    "upi", "payment", "pay", "paypal", "bitcoin", "bitcoincash", "ethereum", "lightning",
)
private val INSTALLER_PACKAGES = setOf(
    "com.android.packageinstaller",
    "com.google.android.packageinstaller",
    "com.samsung.android.packageinstaller",
)

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

object SafetyPolicy {

    /**
     * Classify [desc] then apply [confirm] override.
     *
     * - [SafetyVerdict.Deny] is never overridable.
     * - [SafetyVerdict.NeedConfirm] + `confirm=true` → [SafetyVerdict.Allow] with `confirmed=true`.
     * - Everything else → [SafetyVerdict.Allow].
     */
    fun evaluate(desc: ActionDescriptor, confirm: Boolean = false): SafetyVerdict {
        val base = classify(desc)
        return applyConfirm(base, confirm)
    }

    /**
     * Apply `confirm:true` override rules. Exposed for unit tests of the Deny path
     * without requiring a production rule that currently hard-denies.
     */
    fun applyConfirm(base: SafetyVerdict, confirm: Boolean): SafetyVerdict = when (base) {
        is SafetyVerdict.Deny -> base
        is SafetyVerdict.NeedConfirm ->
            if (confirm) {
                SafetyVerdict.Allow(confirmed = true, reason = base.reason)
            } else {
                base
            }
        is SafetyVerdict.Allow -> base
    }

    /**
     * Build an [ActionDescriptor] from a POST /action JSON body.
     * Tolerates missing fields; never throws on ordinary shapes.
     */
    fun descriptorFromActionJson(req: JSONObject): ActionDescriptor {
        val type = req.optString("type", "").trim()
        val action = when {
            req.has("action") -> req.optString("action", "").takeIf { it.isNotBlank() }
            type == "clipboard" && req.has("op") -> req.optString("op", "").takeIf { it.isNotBlank() }
            else -> null
        }
        val dataUri = if (req.has("data")) req.optString("data", "").takeIf { it.isNotBlank() } else null
        val packageName = if (req.has("package")) {
            req.optString("package", "").takeIf { it.isNotBlank() }
        } else {
            null
        }
        val mimeType = when {
            req.has("mimeType") -> req.optString("mimeType", "").takeIf { it.isNotBlank() }
            req.has("mime") -> req.optString("mime", "").takeIf { it.isNotBlank() }
            else -> null
        }
        // Attachment signal: explicit flag or stream URI fields agents may pass through.
        val hasAttachment = when {
            req.optBoolean("hasAttachment", false) -> true
            req.has("stream") || req.has("EXTRA_STREAM") || req.has("attachment") -> true
            mimeType != null && mimeType != "text/plain" -> true
            else -> false
        }
        return ActionDescriptor(
            type = type,
            action = action,
            dataUri = dataUri,
            packageName = packageName,
            mimeType = mimeType,
            hasAttachment = hasAttachment,
        )
    }

    /**
     * HTTP envelope for NeedConfirm without `confirm:true`.
     * Stable error string: `needs_confirm`. HTTP 200 so agents branch on JSON.
     */
    fun needsConfirmResponse(reason: String): HttpResponse {
        val message = needsConfirmMessage(reason)
        return errorResponse(
            code = 200,
            error = "needs_confirm",
            message = message,
            extra = JSONObject()
                .put("requires_confirm", true)
                .put("reason", reason),
        )
    }

    /** HTTP 403 for hard Deny. */
    fun deniedResponse(reason: String): HttpResponse {
        return errorResponse(
            code = 403,
            error = "denied",
            message = deniedMessage(reason),
            extra = JSONObject().put("reason", reason),
        )
    }

    fun needsConfirmMessage(reason: String): String = when (reason) {
        "sms" -> "SMS/MMS intent requires confirm:true (re-send with confirm after user approval)"
        "share" -> "share/send intent requires confirm:true"
        "payment" -> "payment/wallet intent requires confirm:true"
        "installer" -> "package installer/uninstall intent requires confirm:true"
        else -> "action requires confirm:true ($reason)"
    }

    fun deniedMessage(reason: String): String = when (reason) {
        "factory_reset" -> "destructive system intent is denied"
        else -> "action denied by safety policy ($reason)"
    }

    // -----------------------------------------------------------------------
    // Classification (no confirm handling)
    // -----------------------------------------------------------------------

    /** Raw classification before confirm override. Visible for tests. */
    fun classify(desc: ActionDescriptor): SafetyVerdict {
        val type = desc.type.lowercase()
        // Click / swipe / text / node_* / global / clipboard — mode gate only; Allow here.
        // Launch any package remains Allow (MVP table) + audit at the HTTP layer.
        // Risk heuristics apply to `intent` (and intent-like data on launch if ever present).
        if (type != "intent" && type != "launch") {
            return SafetyVerdict.Allow()
        }

        val actionLower = desc.action?.lowercase()?.trim().orEmpty()
        val scheme = uriScheme(desc.dataUri)
        val pkgLower = desc.packageName?.lowercase()?.trim().orEmpty()
        val mimeLower = desc.mimeType?.lowercase()?.trim().orEmpty()

        // launch: only scheme-based risks if a data URI is ever supplied; package alone is Allow.
        if (type == "launch") {
            if (scheme != null && scheme in SMS_SCHEMES) {
                return SafetyVerdict.NeedConfirm("sms")
            }
            if (scheme == "tel") {
                return SafetyVerdict.Allow(reason = "tel")
            }
            return SafetyVerdict.Allow()
        }

        // --- intent only below ---

        // 1) Hard Deny — destructive system intents (never confirm-overridable)
        if (HARD_DENY_ACTIONS.any { it.equals(desc.action, ignoreCase = true) }) {
            return SafetyVerdict.Deny("factory_reset")
        }

        // 2) SMS / MMS schemes (NeedConfirm per OQ4 default)
        if (scheme != null && scheme in SMS_SCHEMES) {
            return SafetyVerdict.NeedConfirm("sms")
        }
        // SENDTO without scheme is commonly used for SMS
        if (actionLower == "android.intent.action.sendto" && scheme == null) {
            return SafetyVerdict.NeedConfirm("sms")
        }

        // 3) tel: dial — Allow (audited by caller); not NeedConfirm
        if (scheme == "tel") {
            return SafetyVerdict.Allow(reason = "tel")
        }

        // 4) Package installer
        if (isInstaller(actionLower, scheme, pkgLower, mimeLower, desc.dataUri)) {
            return SafetyVerdict.NeedConfirm("installer")
        }

        // 5) Payment / wallet
        if (isPayment(actionLower, scheme, pkgLower, desc.dataUri)) {
            return SafetyVerdict.NeedConfirm("payment")
        }

        // 6) Share / send
        if (isShare(actionLower, desc.hasAttachment)) {
            return SafetyVerdict.NeedConfirm("share")
        }

        return SafetyVerdict.Allow()
    }

    // -----------------------------------------------------------------------
    // Heuristic helpers
    // -----------------------------------------------------------------------

    /** Extract lowercase URI scheme, or null if missing/unparseable. */
    fun uriScheme(dataUri: String?): String? {
        if (dataUri.isNullOrBlank()) return null
        val trimmed = dataUri.trim()
        val colon = trimmed.indexOf(':')
        if (colon <= 0) return null
        val scheme = trimmed.substring(0, colon).lowercase()
        // Reject path-looking "schemes" with slashes
        if (scheme.any { it == '/' || it == '\\' || it.isWhitespace() }) return null
        return scheme
    }

    private fun isInstaller(
        actionLower: String,
        scheme: String?,
        pkgLower: String,
        mimeLower: String,
        dataUri: String?,
    ): Boolean {
        if (INSTALLER_ACTIONS.any { it.equals(actionLower, ignoreCase = true) || it.lowercase() == actionLower }) {
            return true
        }
        if (pkgLower in INSTALLER_PACKAGES) return true
        if (mimeLower == "application/vnd.android.package-archive") return true
        if (scheme == "package") return true
        // content/file URI ending in .apk
        val uri = dataUri?.lowercase().orEmpty()
        if (uri.endsWith(".apk") || uri.contains(".apk?")) return true
        return false
    }

    private fun isPayment(
        actionLower: String,
        scheme: String?,
        pkgLower: String,
        dataUri: String?,
    ): Boolean {
        if (PAYMENT_ACTIONS.any { it.lowercase() == actionLower }) return true
        if (scheme != null && scheme in PAYMENT_SCHEMES) return true
        // Action / package heuristic substrings
        if (actionLower.contains("payment") || actionLower.contains(".pay") ||
            actionLower.endsWith(".pay") || actionLower.contains("wallet") ||
            actionLower.contains("checkout")
        ) {
            return true
        }
        if (pkgLower.contains("wallet") || pkgLower.contains("payment") ||
            pkgLower.contains("paypal") || pkgLower.endsWith(".pay")
        ) {
            // Avoid over-blocking common apps: only when also intent-like package signal is strong
            // Launch of a wallet app alone is Allow; intent *into* wallet with pay action is covered above.
            // Package-only payment signal on intent type → NeedConfirm.
            return true
        }
        val uri = dataUri?.lowercase().orEmpty()
        if (uri.contains("://pay.") || uri.contains("/pay?") || uri.contains("checkout")) {
            return true
        }
        return false
    }

    private fun isShare(actionLower: String, hasAttachment: Boolean): Boolean {
        if (SHARE_ACTIONS.any { it.lowercase() == actionLower }) {
            // SEND / SEND_MULTIPLE always NeedConfirm; SENDTO already handled partly under SMS
            return true
        }
        // Generic "share" action names some OEMs use
        if (actionLower.contains("action.share") || actionLower.endsWith(".SHARE".lowercase())) {
            return true
        }
        // Explicit attachment without share action still suspicious for intent
        if (hasAttachment && actionLower == "android.intent.action.view") {
            return true
        }
        return false
    }
}

/** True when [verdict] allowed the action (possibly after confirm). */
fun SafetyVerdict.isAllowed(): Boolean = this is SafetyVerdict.Allow

/** Confirmed flag for audit (false when not Allow or not confirmed). */
fun SafetyVerdict.wasConfirmed(): Boolean =
    (this as? SafetyVerdict.Allow)?.confirmed == true
