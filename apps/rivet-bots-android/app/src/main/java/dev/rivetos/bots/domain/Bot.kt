package dev.rivetos.bots.domain

import java.util.Locale

/**
 * One bot = one agent on one mesh node. The id is stable across rescans so
 * pins, hides, and per-bot sessions survive a roster refresh.
 */
data class Bot(
    val agent: String,
    val nodeId: String,
    val nodeName: String,
    val denUrl: String,
    val online: Boolean,
    val provider: String? = null,
    val model: String? = null,
    val local: Boolean = false,
    val nodeSessions: Int? = null,
) {
    val id: String get() = "$nodeId/$agent"

    val displayName: String get() = if (agent == DEFAULT_AGENT) "Agent" else prettyAgent(agent)

    /** `agent` for POST /api/sessions — null lets the node pick its default. */
    val sendAgent: String? get() = agent.takeUnless { it == DEFAULT_AGENT }

    /** Short host label for chips: "ct115" or the host part of the gateway URL. */
    val nodeLabel: String get() = nodeName.ifBlank { nodeId }

    /** Default per-bot session id; deterministic so a reinstall picks the same thread back up. */
    fun defaultSessionId(deviceTag: String): String =
        "rivetbots-$deviceTag-${slug(nodeId)}-${slug(agent)}"

    companion object {
        /** Placeholder for a node that serves chat but advertises no agent catalog. */
        const val DEFAULT_AGENT = "__default__"

        fun prettyAgent(agent: String): String = when (agent.lowercase(Locale.US)) {
            "claude" -> "Claude"
            "grok" -> "Grok"
            "hermes" -> "Hermes"
            "kimi" -> "Kimi"
            "deepseek" -> "DeepSeek"
            "local" -> "Local"
            "opus" -> "Opus"
            "gemini" -> "Gemini"
            else -> agent.replaceFirstChar { if (it.isLowerCase()) it.titlecase(Locale.US) else it.toString() }
        }

        private fun slug(s: String): String = s.lowercase(Locale.US).replace(Regex("[^a-z0-9]+"), "-").trim('-')
    }
}

/** The latest line in a bot's thread, for the home list. */
data class BotPreview(
    val text: String,
    val ts: Long,
    val role: String,
)

enum class BlobShape {
    CIRCLE, DROP, TRIANGLE, HEX, SQUIRCLE, EGG, ARCH, CLOUD;

    companion object {
        /** Shapes the editor offers. Identity looks may still use TRIANGLE / ARCH. */
        val editable: List<BlobShape> = listOf(EGG, SQUIRCLE, CIRCLE, HEX, DROP, CLOUD)

        fun fromName(raw: String?): BlobShape? =
            raw?.let { v -> entries.find { it.name.equals(v, ignoreCase = true) } }
    }
}

/** Colour + silhouette for a bot's face. Keyed by agent so the same agent looks the same on every node. */
data class BotLook(val color: Long, val shape: BlobShape)

object BotLooks {
    private val palette = listOf(
        BotLook(0xFF7C5CFF, BlobShape.CIRCLE),   // purple
        BotLook(0xFF2F8CFF, BlobShape.DROP),     // blue
        BotLook(0xFF3DD68C, BlobShape.CLOUD),    // green
        BotLook(0xFF2BB5A0, BlobShape.HEX),      // teal
        BotLook(0xFFF5822B, BlobShape.EGG),      // orange
        BotLook(0xFFE5484D, BlobShape.SQUIRCLE), // red
        BotLook(0xFFF04E98, BlobShape.TRIANGLE), // pink
        BotLook(0xFFF2C531, BlobShape.ARCH),     // yellow
        BotLook(0xFF6E4B3A, BlobShape.CIRCLE),   // brown
    )

    fun forAgent(agent: String): BotLook = when (agent.lowercase(Locale.US)) {
        "claude" -> BotLook(0xFFF5822B, BlobShape.EGG)
        "grok" -> BotLook(0xFF2B2F36, BlobShape.SQUIRCLE)
        "hermes" -> BotLook(0xFF7C5CFF, BlobShape.CIRCLE)
        "kimi" -> BotLook(0xFF2BB5A0, BlobShape.HEX)
        "deepseek" -> BotLook(0xFF2F8CFF, BlobShape.DROP)
        "local" -> BotLook(0xFF3DD68C, BlobShape.CLOUD)
        "opus" -> BotLook(0xFFE5484D, BlobShape.ARCH)
        else -> palette[Math.floorMod(agent.hashCode(), palette.size)]
    }
}
