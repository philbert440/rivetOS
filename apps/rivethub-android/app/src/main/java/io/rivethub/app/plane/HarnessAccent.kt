package io.rivethub.app.plane

/** Token names matching RivetColors — UI maps these onto the theme. */
enum class AccentToken { Em, Link, Warn, Red, InkDim }

/**
 * Phone harness-color mapping (design brief, not desktop clay/grey):
 * claude em, grok link, kimi warn, hermes red, others inkDim.
 */
fun harnessAccentToken(harnessId: String?, command: String? = null): AccentToken {
    val s = "${harnessId.orEmpty()} ${command.orEmpty()}".lowercase()
    return when {
        "claude" in s -> AccentToken.Em
        "grok" in s -> AccentToken.Link
        "kimi" in s -> AccentToken.Warn
        "hermes" in s -> AccentToken.Red
        else -> AccentToken.InkDim
    }
}

fun harnessIdForAgent(agentId: String, provider: String? = null): String? {
    val s = "$agentId ${provider.orEmpty()}".lowercase()
    return when {
        "claude" in s -> "claude-code"
        "grok" in s -> "grok-build"
        "kimi" in s -> "kimi-code"
        "hermes" in s -> "hermes"
        "deepseek" in s || "dsh" in s -> "deepseek-harness"
        else -> null
    }
}
