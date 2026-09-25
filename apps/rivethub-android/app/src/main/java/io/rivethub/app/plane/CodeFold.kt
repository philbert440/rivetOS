package io.rivethub.app.plane

const val CODE_FOLD_AFTER_LINES = 10

data class CodeView(val lines: List<String>, val folded: Boolean, val hiddenLines: Int)

fun codeView(code: String, expanded: Boolean): CodeView {
    val lines = code.replace("\r\n", "\n").trimEnd('\n').split('\n')
    val folded = !expanded && lines.size > CODE_FOLD_AFTER_LINES
    return CodeView(
        lines = if (folded) lines.take(CODE_FOLD_AFTER_LINES) else lines,
        folded = folded,
        hiddenLines = if (folded) lines.size - CODE_FOLD_AFTER_LINES else 0,
    )
}

fun saveFileName(lang: String, index: Int): String =
    "snippet-$index.${codeLanguage(lang)?.extension ?: "txt"}"

@Suppress("UNUSED_PARAMETER")
fun saveMime(lang: String): String = "text/plain"
