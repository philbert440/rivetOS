package dev.rivet.app.data.ai

import android.content.Context
import android.util.Log
import dev.rivet.ai.core.MessageRole
import dev.rivet.app.runtime.RivetRuntime
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** One user/assistant turn pulled from an on-device agent session transcript. */
data class SessionTurn(val role: MessageRole, val text: String)

/**
 * Reads the on-device agent session transcripts (Claude / Grok) from inside the rootfs and
 * returns the clean ordered user/assistant text turns. This is the shared foundation for both
 * the chat-thread mirror (import turns done in the CLI) and Part C (capture sessions to the
 * datahub) — one reader, two sinks. Pure + side-effect-free; callers decide what to do.
 */
object SessionTranscript {
    private const val TAG = "SessionTranscript"

    // ---- Claude: ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl --------------------
    // Claude encodes the cwd by replacing every non-alphanumeric char with '-' (so
    // /home/rivet -> -home-rivet). sessionId == the RivetHub conversationId.

    fun claudeFile(context: Context, conversationId: String, cwd: String = "/home/rivet"): File {
        val encoded = cwd.replace(Regex("[^A-Za-z0-9]"), "-")
        return File(RivetRuntime.rootfsDir(context), "home/rivet/.claude/projects/$encoded/$conversationId.jsonl")
    }

    fun claudeTranscript(context: Context, conversationId: String): List<SessionTurn> {
        val f = claudeFile(context, conversationId)
        if (!f.exists()) return emptyList()
        return parseJsonl(f) { obj ->
            if (obj.optBoolean("isSidechain", false)) return@parseJsonl null
            val type = obj.optString("type")
            if (type != "user" && type != "assistant") return@parseJsonl null
            val msg = obj.optJSONObject("message") ?: return@parseJsonl null
            val role = if (type == "user") MessageRole.USER else MessageRole.ASSISTANT
            extractText(msg.opt("content"), role)?.let { SessionTurn(role, it) }
        }
    }

    // ---- Grok: ~/.grok/sessions/<url-encoded-cwd>/<sessionId>/chat_history.jsonl -------
    // Grok URL-encodes the *cwd it ran in* into the dir name (/home/rivet -> %2Fhome%2Frivet),
    // and the bridge actually launches grok from /root/rivet-bridge (-> %2Froot%2Frivet-bridge),
    // not /home/rivet. So we can't assume the cwd. The sessionId is a unique UUID (captured by
    // the bridge into grok-sessions.json), so locate the session by id across EVERY cwd dir.

    fun grokFile(context: Context, grokSessionId: String): File? {
        val sessionsDir = File(RivetRuntime.rootfsDir(context), "home/rivet/.grok/sessions")
        // A session id can appear under more than one cwd dir (the bridge runs grok from one cwd,
        // a terminal escalation may resume from another). Take the most recently modified
        // chat_history so we read wherever the latest turns actually landed.
        return sessionsDir.listFiles()
            ?.filter { it.isDirectory }
            ?.map { File(it, "$grokSessionId/chat_history.jsonl") }
            ?.filter { it.exists() }
            ?.maxByOrNull { it.lastModified() }
    }

    fun grokTranscript(context: Context, grokSessionId: String): List<SessionTurn> {
        val f = grokFile(context, grokSessionId) ?: return emptyList()
        return parseJsonl(f) { obj ->
            val type = obj.optString("type", obj.optString("role"))
            if (type != "user" && type != "assistant") return@parseJsonl null // skip system/tool
            val role = if (type == "user") MessageRole.USER else MessageRole.ASSISTANT
            extractText(obj.opt("content"), role)?.let { SessionTurn(role, it) }
        }
    }

    // ---- shared parsing ---------------------------------------------------------------

    private inline fun parseJsonl(file: File, transform: (JSONObject) -> SessionTurn?): List<SessionTurn> {
        val out = ArrayList<SessionTurn>()
        try {
            file.bufferedReader().useLines { lines ->
                lines.forEach { raw ->
                    val line = raw.trim()
                    if (line.isEmpty() || line[0] != '{') return@forEach
                    val obj = try { JSONObject(line) } catch (_: Throwable) { return@forEach }
                    transform(obj)?.let { out.add(it) }
                }
            }
        } catch (t: Throwable) {
            Log.e(TAG, "parse ${file.name} failed", t)
        }
        return out
    }

    /**
     * Pull display text out of a message content value (String, or array of content blocks).
     * Keeps `text` blocks; drops thinking / tool_use / tool_result. Returns null for turns with
     * no human-visible text (e.g. a user turn that's only a tool_result), so they're skipped.
     */
    private fun extractText(content: Any?, role: MessageRole): String? {
        var text = when (content) {
            is String -> content
            is JSONArray -> buildString {
                for (i in 0 until content.length()) {
                    val b = content.optJSONObject(i) ?: continue
                    if (b.optString("type") == "text") {
                        if (isNotEmpty()) append('\n')
                        append(b.optString("text"))
                    }
                }
            }
            else -> ""
        }.trim()
        if (text.isEmpty()) return null
        // Skip harness-injected wrapper turns that aren't real conversational content: Claude's
        // command/system-reminder noise, and grok's `<user_info>` environment preamble (a distinct
        // first user turn). The offset-aligned merge already steps past these for a non-empty
        // thread; skipping here also keeps them out when escalating into an empty chat.
        if (role == MessageRole.USER &&
            (text.startsWith("<command-") || text.startsWith("<local-command") ||
                text.startsWith("<system-reminder") || text.startsWith("<user_info") ||
                text.startsWith("Caveat:"))
        ) return null
        // grok wraps the actual user message in <user_query>…</user_query> — show the inner text.
        if (role == MessageRole.USER && text.startsWith("<user_query>")) {
            text = text.removePrefix("<user_query>").substringBefore("</user_query>").trim()
            if (text.isEmpty()) return null
        }
        return text
    }
}
