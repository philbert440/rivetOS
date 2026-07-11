package dev.rivet.app.data.ai.mcp

import android.content.Context
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import dev.rivet.app.runtime.RivetRuntime
import java.io.File

class AgentMcpReader(
    private val context: Context,
) {
    fun loadAll(): List<AgentMcpConfig> {
        val rootfs = RivetRuntime.rootfsDir(context)
        return buildList {
            addAll(readClaudeServers(File(rootfs, "home/rivet/.claude.json")))
            addAll(readGrokServers(File(rootfs, "home/rivet/.grok/config.toml")))
        }.sortedWith(compareBy({ it.agent }, { it.name }))
    }

    private fun readClaudeServers(file: File): List<AgentMcpConfig> {
        if (!file.exists()) return emptyList()
        return runCatching {
            val root = Json.parseToJsonElement(file.readText()).jsonObject
            val mcpServers = root["mcpServers"]?.jsonObject ?: return emptyList()
            mcpServers.entries.mapNotNull { (name, element) ->
                val obj = element.jsonObject
                val type = obj["type"]?.jsonPrimitive?.contentOrNull
                val command = obj["command"]?.jsonPrimitive?.contentOrNull
                val url = obj["url"]?.jsonPrimitive?.contentOrNull
                val args = obj["args"]?.jsonArray?.mapNotNull { it.jsonPrimitive.contentOrNull } ?: emptyList()
                val transport = when {
                    command != null || type == "stdio" -> AgentMcpTransport.Stdio
                    type == "sse" || url?.contains("/sse") == true -> AgentMcpTransport.Sse
                    url != null -> AgentMcpTransport.StreamableHttp
                    else -> return@mapNotNull null
                }
                AgentMcpConfig(
                    name = name,
                    agent = McpAgent.Claude,
                    transport = transport,
                    command = command,
                    url = url,
                    args = args,
                )
            }
        }.getOrElse { emptyList() }
    }

    private fun readGrokServers(file: File): List<AgentMcpConfig> {
        if (!file.exists()) return emptyList()
        return runCatching {
            parseGrokMcpSections(file.readText())
        }.getOrElse { emptyList() }
    }

    private fun parseGrokMcpSections(text: String): List<AgentMcpConfig> {
        val servers = mutableListOf<AgentMcpConfig>()
        var currentName: String? = null
        var command: String? = null
        var url: String? = null
        var enabled = true
        var args = emptyList<String>()

        fun flush() {
            val name = currentName ?: return
            val transport = when {
                command != null -> AgentMcpTransport.Stdio
                url != null -> AgentMcpTransport.Url
                else -> return
            }
            servers += AgentMcpConfig(
                name = name,
                agent = McpAgent.Grok,
                transport = transport,
                command = command,
                url = url,
                args = args,
                enabled = enabled,
            )
        }

        for (rawLine in text.lineSequence()) {
            val line = rawLine.trim()
            if (line.isEmpty() || line.startsWith('#')) continue

            val section = SECTION_REGEX.matchEntire(line)
            if (section != null) {
                flush()
                currentName = section.groupValues[1]
                command = null
                url = null
                enabled = true
                args = emptyList()
                continue
            }

            if (currentName == null) continue
            val kv = KV_REGEX.matchEntire(line) ?: continue
            when (kv.groupValues[1]) {
                "command" -> command = unquote(kv.groupValues[2])
                "url" -> url = unquote(kv.groupValues[2])
                "enabled" -> enabled = kv.groupValues[2].lowercase() != "false"
                "args" -> args = parseTomlInlineArray(kv.groupValues[2])
            }
        }
        flush()
        return servers
    }

    private fun unquote(value: String): String {
        val trimmed = value.trim()
        if (trimmed.length >= 2 && trimmed.first() == '"' && trimmed.last() == '"') {
            return trimmed.substring(1, trimmed.length - 1)
        }
        return trimmed
    }

    private fun parseTomlInlineArray(value: String): List<String> {
        val trimmed = value.trim()
        if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return emptyList()
        return trimmed
            .removePrefix("[")
            .removeSuffix("]")
            .split(',')
            .map { unquote(it.trim()) }
            .filter { it.isNotEmpty() }
    }

    companion object {
        private val SECTION_REGEX = Regex("""\[mcp_servers\.([^\]]+)]""")
        private val KV_REGEX = Regex("""^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$""")
    }
}
