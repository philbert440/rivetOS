package dev.rivet.app.ui.pages.terminal

/**
 * Chat → Terminal handoff: map the active agent model + conversation onto a launch argv
 * that stays in sync with the chat session (local proot or remote den spawn).
 *
 * Seamless join key is the RivetHub conversation UUID (`x-rivet-conversation`). Den-server
 * pins harness native ids to that key (`--session-id` / `--resume`). Local grok is the
 * exception: the on-device bridge may map to a different native session id captured in
 * `grok-sessions.json`.
 *
 * Remote den `/v1` models are roster ids (`grok`, `claude`, `hermes`, …), not the local
 * `rivet-*` aliases — both shapes must resolve to the same harness command.
 */
object TerminalEscalate {

    /** Roster / den command key for a Rivet agent model id, or null if not a terminal harness. */
    fun rosterKeyForModel(modelId: String): String? {
        val id = modelId.trim().lowercase()
        return when {
            id == "rivet-claude" || id == "claude" -> "claude"
            id == "rivet-grok" || id == "grok" || id == "grok-fast" -> "grok"
            id == "rivet-hermes" || id == "hermes" -> "hermes"
            else -> null
        }
    }

    /**
     * @param modelId active chat model string (`rivet-grok`, `grok`, `claude`, …)
     * @param conversationId RivetHub conversation UUID (seamless join key)
     * @param hasTurns false → plain shell (new chat with no agent work yet)
     * @param isLocalNode true when active node is this device (proot path)
     * @param localGrokSessionId bridge-captured grok native id for [conversationId], if any
     */
    fun launchCommand(
        modelId: String,
        conversationId: String,
        hasTurns: Boolean,
        isLocalNode: Boolean,
        localGrokSessionId: String? = null,
    ): List<String> {
        if (!hasTurns) return listOf("/bin/bash", "-l")
        return when (rosterKeyForModel(modelId)) {
            "claude" ->
                listOf("claude", "--resume", conversationId, "--dangerously-skip-permissions")
            "grok" -> {
                // Local: prefer bridge-mapped native id; fall back to bare grok (fresh TUI).
                // Remote: conversation UUID is the den join key — always --resume it so the
                // harness reopens the same session chat already used (den may also decide via
                // sessionExists when only `session` is set; explicit resume matches `-r` UX).
                if (isLocalNode) {
                    localGrokSessionId
                        ?.takeIf { it.isNotBlank() }
                        ?.let { listOf("grok", "--resume", it) }
                        ?: listOf("grok")
                } else {
                    listOf("grok", "--resume", conversationId)
                }
            }
            "hermes" -> listOf("hermes", "--resume", conversationId)
            else -> listOf("/bin/bash", "-l")
        }
    }
}
