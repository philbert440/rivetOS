package io.rivethub.app.plane

fun harnessIdForAgent(agentId: String, provider: String? = null): String? {
    val s = "$agentId ${provider.orEmpty()}".lowercase()
    return when {
        "claude" in s -> "claude-code"
        "grok" in s -> "grok-build"
        "kimi" in s -> "kimi-code"
        "opencode" in s -> "opencode"
        "hermes" in s -> "hermes"
        "deepseek" in s || "dsh" in s -> "deepseek-harness"
        "codex" in s -> "codex"
        else -> null
    }
}
