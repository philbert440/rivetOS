package dev.rivetos.bots.data

/**
 * Hermes TUI paints a `┌─ Reasoning ──┐` box into assistant text.
 * Keep in sync with packages/types/src/hermes-reasoning.ts.
 */
data class HermesSplit(val reasoning: String, val text: String)

private val ANSI = Regex("""\u001B\[[0-9;?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)""")
private val HEADER = Regex("""^[\s]*[┌╭][─━\s]*\b(Reasoning|Thought|Thinking)\b""", RegexOption.IGNORE_CASE)
private val FOOTER = Regex("""^[\s]*[└╰][─━\s]+[┘╯][\s]*$""")
private val BODY = Regex("""^[\s]*[│┃├┤]""")
private val BODY_PREFIX = Regex("""^[\s]*[│┃├┤]\s?""")

fun stripAnsi(s: String): String = ANSI.replace(s, "")

fun splitHermesReasoning(input: String): HermesSplit {
    if (input.isEmpty()) return HermesSplit("", "")
    val lines = input.split(Regex("""\r?\n"""))
    val reasoning = ArrayList<String>()
    val text = ArrayList<String>()
    var i = 0
    while (i < lines.size) {
        val vis = stripAnsi(lines[i])
        if (!HEADER.containsMatchIn(vis)) {
            text.add(lines[i])
            i++
            continue
        }
        val headerIdx = i
        i++
        var sawBox = false
        var hasTerminator = false
        while (i < lines.size) {
            val v = stripAnsi(lines[i])
            if (FOOTER.matches(v)) {
                hasTerminator = true
                i++
                break
            }
            if (BODY.containsMatchIn(v)) {
                sawBox = true
                reasoning.add(BODY_PREFIX.replaceFirst(v, ""))
                i++
                continue
            }
            if (sawBox) {
                reasoning.add(v)
                i++
                continue
            }
            if (v.isBlank()) {
                hasTerminator = true
                i++
                break
            }
            reasoning.add(v)
            i++
        }
        if (!sawBox && !hasTerminator) {
            text.add(lines[headerIdx])
            text.addAll(reasoning)
            reasoning.clear()
        }
    }
    return HermesSplit(reasoning.joinToString("\n").trim(), text.joinToString("\n").trim())
}

fun visibleAssistantText(text: String): String = splitHermesReasoning(text).text
