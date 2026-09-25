package io.rivethub.app.plane

enum class TokKind { Plain, Keyword, String, Comment, Number, Type, Punct }

data class CodeSpan(val start: Int, val end: Int, val kind: TokKind)

internal enum class CodeLanguage(val label: String, val extension: String, words: String) {
    Kotlin("Kotlin", "kt", "val var fun class object interface if else when for while do return break continue in is as null true false package import private public override suspend data sealed"),
    Java("Java", "java", "class interface enum extends implements new public private protected static final void int boolean if else switch case for while do return break continue null true false package import throw throws try catch"),
    TypeScript("TypeScript", "ts", "const let var function class interface type enum extends implements new export default import from async await return if else switch case for while break continue null undefined true false typeof instanceof throw try catch"),
    JavaScript("JavaScript", "js", "const let var function class extends new export default import from async await return if else switch case for while do break continue null undefined true false typeof instanceof throw try catch finally"),
    Python("Python", "py", "def class if elif else for while in is not and or return yield import from as with try except finally raise pass break continue lambda None True False async await global nonlocal del assert"),
    Shell("Shell", "sh", "if then else elif fi for while until do done case esac in function select time coproc return break continue export local readonly declare unset true false"),
    Json("JSON", "json", "true false null"),
    Yaml("YAML", "yaml", "true false null yes no on off"),
    Sql("SQL", "sql", "select from where insert into values update set delete create table drop alter join left right inner outer on as and or not null true false order by group having limit union distinct case when then else end"),
    Go("Go", "go", "package import func type struct interface map chan var const if else switch case default for range return break continue go defer select fallthrough nil true false"),
    Rust("Rust", "rs", "fn let mut const static pub use mod struct enum impl trait type where self Self super crate as if else match for while loop in return break continue move async await unsafe dyn true false"),
    ;

    val keywords = words.split(' ').toSet()
    val hasTypes get() = this in setOf(Kotlin, Java, TypeScript, Rust, Go)
    val hasBackticks get() = this in setOf(TypeScript, JavaScript, Shell, Go, Kotlin)
    val hashComment get() = this in setOf(Python, Shell, Yaml)
}

internal fun codeLanguage(lang: String): CodeLanguage? = when (lang.lowercase()) {
    "kotlin", "kt" -> CodeLanguage.Kotlin
    "java" -> CodeLanguage.Java
    "typescript", "ts", "tsx" -> CodeLanguage.TypeScript
    "javascript", "js", "jsx" -> CodeLanguage.JavaScript
    "python", "py" -> CodeLanguage.Python
    "bash", "sh", "shell", "zsh" -> CodeLanguage.Shell
    "json" -> CodeLanguage.Json
    "yaml", "yml" -> CodeLanguage.Yaml
    "sql" -> CodeLanguage.Sql
    "go" -> CodeLanguage.Go
    "rust", "rs" -> CodeLanguage.Rust
    else -> null
}

fun langLabel(lang: String): String = codeLanguage(lang)?.label ?: lang.ifBlank { "code" }

private val codeNumber = Regex("(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|[0-9][0-9_]*(?:\\.[0-9_]+)?(?:[eE][+-]?[0-9_]+)?)")

// Deliberately line-oriented: an unfinished string or comment never colours the next line.
fun highlightCode(lang: String, code: String): List<CodeSpan> {
    val language = codeLanguage(lang) ?: return listOf(CodeSpan(0, code.length, TokKind.Plain))
    if (code.isEmpty()) return listOf(CodeSpan(0, 0, TokKind.Plain))
    val spans = mutableListOf<CodeSpan>()
    var i = 0
    var lineStart = 0
    var lineEnd = -1
    val numberMatcher = codeNumber.toPattern().matcher(code)
    while (i < code.length) {
        val start = i
        val c = code[i]
        if (i > lineEnd) {
            lineStart = i
            lineEnd = code.indexOfAny(charArrayOf('\n', '\r'), i).let { if (it < 0) code.length else it }
        }
        val slashComments = !language.hashComment && language != CodeLanguage.Sql
        val lineComment = (language.hashComment && c == '#' && (i == lineStart || code[i - 1].isWhitespace())) ||
            (language == CodeLanguage.Sql && code.startsWith("--", i)) ||
            (slashComments && code.startsWith("//", i))
        val kind = when {
            lineComment -> {
                i = lineEnd
                TokKind.Comment
            }
            !language.hashComment && code.startsWith("/*", i) -> {
                var close = i + 2
                while (close + 1 < lineEnd && !code.regionMatches(close, "*/", 0, 2)) close++
                i = if (close + 1 < lineEnd) close + 2 else lineEnd
                TokKind.Comment
            }
            (c == '"' || c == '\'' || (c == '`' && language.hasBackticks)) &&
                (language != CodeLanguage.Rust || c != '\'' || rustCharStarts(code, i, lineEnd)) &&
                (language != CodeLanguage.Yaml || yamlValueStarts(code, i, lineStart)) -> {
                val escapes = !(language == CodeLanguage.Shell && c == '\'') &&
                    !(language == CodeLanguage.Go && c == '`')
                i++
                while (i < lineEnd) {
                    val next = code[i++]
                    if (escapes && next == '\\' && i < lineEnd) i++
                    else if (next == c) break
                }
                TokKind.String
            }
            c.isDigit() -> {
                numberMatcher.region(i, lineEnd)
                i = if (numberMatcher.lookingAt()) numberMatcher.end() else i + 1
                TokKind.Number
            }
            c.isLetter() || c == '_' || c == '$' -> {
                i++
                while (i < lineEnd && (code[i].isLetterOrDigit() || code[i] == '_' || code[i] == '$')) i++
                val word = code.substring(start, i)
                when {
                    (if (language == CodeLanguage.Sql) word.lowercase() else word) in language.keywords -> TokKind.Keyword
                    language.hasTypes && c.isUpperCase() -> TokKind.Type
                    else -> TokKind.Plain
                }
            }
            c == '\'' -> { i++; TokKind.Punct }
            c in "{}[]().,:;+-*/%=!<>?&|^~" -> { i++; TokKind.Punct }
            else -> { i++; TokKind.Plain }
        }
        val last = spans.lastOrNull()
        if (kind == TokKind.Plain && last?.kind == TokKind.Plain) {
            spans[spans.lastIndex] = last.copy(end = i)
        } else spans += CodeSpan(start, i, kind)
    }
    return spans
}

// A lifetime apostrophe is punctuation; only a short, closed char starts a string.
private fun rustCharStarts(code: String, start: Int, lineEnd: Int): Boolean {
    if (start + 2 >= lineEnd) return false
    if (code[start + 1] != '\\') {
        val end = start + 1 + Character.charCount(Character.codePointAt(code, start + 1))
        return end < lineEnd && code[end] == '\''
    }
    // Simple escapes, \xNN, and \u{NNNNNN}; the scan remains bounded.
    var end = start + 3
    val limit = minOf(lineEnd, start + 12)
    while (end < limit) {
        if (code[end] == '\'') return true
        end++
    }
    return false
}

private fun yamlValueStarts(code: String, start: Int, lineStart: Int): Boolean {
    var previous = start - 1
    while (previous >= lineStart && code[previous].isWhitespace()) previous--
    return previous < lineStart ||
        (previous < start - 1 && (code[previous] == ':' || code[previous] == '-'))
}
