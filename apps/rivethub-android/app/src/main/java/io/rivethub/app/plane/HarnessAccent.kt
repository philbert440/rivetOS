package io.rivethub.app.plane

private fun isOpencodeAgent(agentId: String, provider: String?): Boolean {
    val agent = agentId.lowercase()
    val prov = provider.orEmpty().lowercase()
    return agent == "opencode" ||
        agent == "opencode-cli" ||
        agent.startsWith("opencode:") ||
        prov == "opencode" ||
        prov == "opencode-cli"
}

fun harnessIdForAgent(agentId: String, provider: String? = null): String? {
    if (isOpencodeAgent(agentId, provider)) return "opencode"
    val s = "$agentId ${provider.orEmpty()}".lowercase()
    return when {
        "claude" in s -> "claude-code"
        "grok" in s -> "grok-build"
        "kimi" in s -> "kimi-code"
        "hermes" in s -> "hermes"
        "deepseek" in s || "dsh" in s -> "deepseek-harness"
        "codex" in s -> "codex"
        else -> null
    }
}
