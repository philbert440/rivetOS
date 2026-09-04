package io.rivethub.app.plane

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

data class AskOption(val label: String, val description: String? = null)

data class AskQuestion(
    val question: String? = null,
    val header: String? = null,
    val multiSelect: Boolean = false,
    val options: List<AskOption> = emptyList(),
)

data class AskUserCard(val questions: List<AskQuestion>)

data class LiveTool(val name: String, val args: JsonElement? = null, val status: String = "running")

private val ASK_JSON = Json { ignoreUnknownKeys = true; isLenient = true }

private val ASK_TOOL_NAMES = setOf("ask_user", "ask_user_question", "askuserquestion")

fun normalizeToolName(raw: String): String {
    val t = raw.trim().trimStart { !it.isLetter() && !it.isDigit() && it != '_' }.trim()
    return t.ifEmpty { raw.trim().ifEmpty { "tool" } }
}

fun isAskUserTool(name: String): Boolean {
    val n = normalizeToolName(name).lowercase().replace(Regex("\\s+"), "_")
    return n in ASK_TOOL_NAMES
}

private fun labelFromOption(opt: JsonElement): String? {
    if (opt is JsonPrimitive && opt.contentOrNull?.trim()?.isNotEmpty() == true) return opt.content.trim()
    if (opt is JsonObject) {
        val label = opt.str("label") ?: opt.str("value") ?: opt.str("text")
        if (label != null) return label
    }
    return null
}

private fun optionFrom(opt: JsonElement): AskOption? {
    val label = labelFromOption(opt) ?: return null
    if (opt is JsonObject) {
        val d = opt.str("description")
        if (d != null) return AskOption(label, d)
    }
    return AskOption(label)
}

private fun optionsFromArray(arr: JsonElement?): List<AskOption> {
    if (arr !is JsonArray) return emptyList()
    val seen = HashSet<String>()
    val out = ArrayList<AskOption>()
    for (item in arr) {
        val o = optionFrom(item) ?: continue
        if (!seen.add(o.label)) continue
        out += o
        if (out.size >= 20) break
    }
    return out
}

private fun questionFrom(q: JsonElement): AskQuestion? {
    if (q !is JsonObject) return null
    val options = optionsFromArray(q["options"]) + optionsFromArray(q["choices"])
    if (options.isEmpty()) return null
    return AskQuestion(
        question = q.str("question"),
        header = q.str("header"),
        multiSelect = (q["multiSelect"] as? JsonPrimitive)?.booleanOrNull == true,
        options = options,
    )
}

/** Parse tool args into structured ask questions. Empty on anything unusable. */
fun extractAskUserQuestions(args: Any?): List<AskQuestion> {
    val root = toJson(args) ?: return emptyList()
    if (root !is JsonObject) return emptyList()
    val nested = root["questions"]
    if (nested is JsonArray) {
        val qs = nested.mapNotNull { questionFrom(it) }
        if (qs.isNotEmpty()) return qs.take(4)
    }
    questionFrom(root)?.let { return listOf(it) }
    if (root.str("type") == "yes_no") {
        return listOf(
            AskQuestion(
                question = root.str("question"),
                multiSelect = false,
                options = listOf(AskOption("Yes"), AskOption("No")),
            ),
        )
    }
    return emptyList()
}

fun questionsFromLiveTools(tools: List<LiveTool>): List<AskQuestion> {
    for (i in tools.indices.reversed()) {
        val t = tools[i]
        if (!isAskUserTool(t.name)) continue
        val qs = extractAskUserQuestions(t.args)
        if (qs.isNotEmpty()) return qs
    }
    return emptyList()
}

fun cardFromLiveTools(tools: List<LiveTool>): AskUserCard? {
    val qs = questionsFromLiveTools(tools)
    return if (qs.isEmpty()) null else AskUserCard(qs)
}

/**
 * Compose the outgoing answer from option picks (keyed by question index)
 * and free text. Multi-question picks are prefixed so the agent can match
 * them up. Empty when there is nothing to send.
 */
fun composeAskAnswer(
    questions: List<AskQuestion>,
    picked: Map<Int, List<String>>,
    own: String,
): String {
    val answered = questions.mapIndexed { qi, q -> q to (picked[qi] ?: emptyList()) }
        .filter { it.second.isNotEmpty() }
    val parts = ArrayList<String>()
    if (answered.isNotEmpty()) {
        parts += if (questions.size == 1) {
            answered[0].second.joinToString(", ")
        } else {
            answered.joinToString("\n") { (q, labels) ->
                val prefix = q.header ?: q.question
                if (prefix != null) "$prefix: ${labels.joinToString(", ")}" else labels.joinToString(", ")
            }
        }
    }
    val free = own.trim()
    if (free.isNotEmpty()) parts += free
    return parts.joinToString("\n")
}

private fun toJson(args: Any?): JsonElement? {
    if (args == null) return null
    if (args is JsonElement) return args
    if (args is String) {
        return runCatching { ASK_JSON.parseToJsonElement(args) }.getOrNull()
    }
    return null
}

private fun JsonObject.str(key: String): String? =
    (this[key] as? JsonPrimitive)?.contentOrNull?.trim()?.takeIf { it.isNotEmpty() }
