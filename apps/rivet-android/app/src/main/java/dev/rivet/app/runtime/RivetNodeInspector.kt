package dev.rivet.app.runtime

import android.content.Context
import dev.rivet.app.data.ai.mcp.AgentMcpReader
import dev.rivet.app.data.ai.mcp.McpAgent
import java.io.File

data class RivetNodeStatus(
    val rootfsReady: Boolean,
    val memoryPluginRev: String?,
    val rivetSharedRev: String?,
    val netToolsRev: String?,
    val claudeMcpServers: Int,
    val grokMcpServers: Int,
    val rootfsPath: String,
)

class RivetNodeInspector(
    private val context: Context,
    private val agentMcpReader: AgentMcpReader,
) {
    fun inspect(): RivetNodeStatus {
        val rootfs = RivetRuntime.rootfsDir(context)
        val agentServers = agentMcpReader.loadAll()
        return RivetNodeStatus(
            rootfsReady = RivetRuntime.isRootfsReady(context),
            memoryPluginRev = readRev(rootfs, "opt/.rivet-memory-rev"),
            rivetSharedRev = readRev(rootfs, "opt/.rivet-shared-rev"),
            netToolsRev = readRev(rootfs, "opt/.rivet-net-tools-rev"),
            claudeMcpServers = agentServers.count { it.agent == McpAgent.Claude },
            grokMcpServers = agentServers.count { it.agent == McpAgent.Grok },
            rootfsPath = rootfs.absolutePath,
        )
    }

    private fun readRev(rootfs: File, relative: String): String? {
        val file = File(rootfs, relative)
        if (!file.exists()) return null
        return runCatching { file.readText().trim() }.getOrNull()?.takeIf { it.isNotEmpty() }
    }
}