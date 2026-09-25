package io.rivethub.app.plane

data class TitleBlock(val line1: String, val line2: String)

fun titleBlock(
    title: String,
    draft: Boolean,
    agentName: String?,
    modelLabel: String?,
    harnessLabel: String?,
    context: ContextBarView?,
    newChatLabel: String,
): TitleBlock {
    val identity = listOf(agentName, modelLabel?.takeIf { it.isNotBlank() } ?: harnessLabel)
        .mapNotNull { it?.trim()?.takeIf(String::isNotEmpty) }
        .joinToString(" / ")
    return TitleBlock(
        line1 = if (draft || title.isBlank()) newChatLabel else title,
        line2 = listOfNotNull(identity.takeIf(String::isNotEmpty), context?.compactLabel())
            .joinToString(" · "),
    )
}

fun renameAllowed(draft: Boolean, turnCount: Int): Boolean = !draft && turnCount > 0
