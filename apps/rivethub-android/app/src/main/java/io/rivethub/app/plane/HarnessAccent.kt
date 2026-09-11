package io.rivethub.app.plane

private val PI_TOKEN = Regex("""(?:^|[^a-z0-9])pi(?:-cli)?(?:[^a-z0-9]|$)""")

fun harnessIdForAgent(agentId: String, provider: String? = null): String? {
    val s = "$agentId ${provider.orEmpty()}".lowercase()
    return when {
        "claude" in s -> "claude-code"
        "grok" in s -> "grok-build"
        "kimi" in s -> "kimi-code"
        "hermes" in s -> "hermes"
        "deepseek" in s || "dsh" in s -> "deepseek-harness"
        "codex" in s -> "codex"
        PI_TOKEN.containsMatchIn(s) -> "pi"
        else -> null
    }
}
