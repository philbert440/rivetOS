package io.rivethub.app.plane

/**
 * Sheet label for [model], else the id itself. Blank label or blank id is
 * null so the title can skip the model part.
 */
fun modelDisplayLabel(sheet: HarnessSheet?, model: String?): String? {
    val listed = sheet?.models?.find { it.id == model }?.label?.takeIf { it.isNotBlank() }
    return listed ?: model?.takeIf { it.isNotBlank() }
}

/**
 * Terminal-mode header title. A program title (OSC), when the emulator has
 * one, replaces the model/conversation line. Exited sessions gain " (ended)";
 * a session whose node is not the entry node gains " · remote".
 */
fun terminalTitle(
    modelLabel: String?,
    harnessLabel: String?,
    conversationTitle: String,
    programTitle: String?,
    status: TermStatus,
    remote: Boolean,
    untitled: String,
): String {
    val program = programTitle?.takeIf { it.isNotBlank() }
    val base = if (program != null) {
        program
    } else {
        val who = modelLabel?.takeIf { it.isNotBlank() }
            ?: harnessLabel?.takeIf { it.isNotBlank() }
        val conversation = conversationTitle.ifBlank { untitled }
        if (who == null) conversation else "$who · $conversation"
    }
    val ended = if (status == TermStatus.Exited) "$base (ended)" else base
    return if (remote) "$ended · remote" else ended
}

/**
 * True when this session's den is not the transport entry node.
 * Blank either side is "not remote" — there is nothing to compare.
 */
fun terminalNodeIsRemote(nodeDenUrl: String, entryUrl: String): Boolean {
    fun norm(s: String) = s.trim().trimEnd('/')
    val node = norm(nodeDenUrl)
    val entry = norm(entryUrl)
    if (node.isEmpty() || entry.isEmpty()) return false
    return !node.equals(entry, ignoreCase = true)
}
