package dev.rivet.app.data.ai.mcp

enum class McpAgent {
    Claude,
    Grok,
}

enum class AgentMcpTransport {
    Stdio,
    Url,
    Sse,
    StreamableHttp,
}

data class AgentMcpConfig(
    val name: String,
    val agent: McpAgent,
    val transport: AgentMcpTransport,
    val command: String? = null,
    val url: String? = null,
    val args: List<String> = emptyList(),
    val enabled: Boolean = true,
) {
    val endpoint: String?
        get() = when (transport) {
            AgentMcpTransport.Stdio -> {
                val cmd = command ?: return null
                buildString {
                    append(cmd)
                    if (args.isNotEmpty()) {
                        append(' ')
                        append(args.joinToString(" "))
                    }
                }
            }
            else -> url
        }
}
