package io.rivethub.app.plane

fun harnessIdForAgent(agentId: String, provider: String? = null): String? {
    val s = "$agentId ${provider.orEmpty()}".lowercase()
    return when {
        "claude" in s -> "claude-code"
        "grok" in s -> "grok-build"
        "kimi" in s -> "kimi-code"
        "hermes" in s -> "hermes"
        "codex" in s -> "codex"
        else -> null
    }
}
