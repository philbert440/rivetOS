package dev.rivetos.team.domain

/** User-specific persona: name + system prompt + one thread + node binding. */
data class Persona(
    val id: String,
    val name: String,
    val systemPrompt: String,
    val threadId: String,
    val nodeId: String,
    val sample: Boolean = false,
)

data class TeamMessage(
    val id: String,
    val sessionId: String,
    val userId: String,
    val personaId: String,
    val nodeId: String,
    val role: String,
    val text: String,
    val ts: Long,
)

data class StreamCard(
    val id: String,
    val kind: String,
    val label: String,
)

const val LOCAL_USER_ID = "local-user"
const val LOCAL_NODE_ID = "local-node"

data class TeamUser(
    val id: String,
    val handle: String,
    val displayName: String,
)

fun samplePersonasFor(userId: String): List<Persona> {
    val tag = userId.take(8)
    return listOf(
        Persona(
            id = "$tag-persona-research",
            name = "Research assistant",
            systemPrompt = "You help the user investigate questions. Prefer primary sources, flag uncertainty, and keep open threads visible.",
            threadId = "$tag-session-research",
            nodeId = LOCAL_NODE_ID,
            sample = true,
        ),
        Persona(
            id = "$tag-persona-summarizer",
            name = "Summarizer",
            systemPrompt = "You condense long material into tight briefs. Lead with the answer, then bullets, then action items.",
            threadId = "$tag-session-summarizer",
            nodeId = LOCAL_NODE_ID,
            sample = true,
        ),
        Persona(
            id = "$tag-persona-informatics",
            name = "Informatics",
            systemPrompt = "You turn messy notes and logs into structured facts the user can reuse. Prefer tables, named entities, and stable ids.",
            threadId = "$tag-session-informatics",
            nodeId = LOCAL_NODE_ID,
            sample = true,
        ),
    )
}

val SAMPLE_PERSONAS = samplePersonasFor(LOCAL_USER_ID)

val SAMPLE_USERS = listOf(
    TeamUser(id = "user-local", handle = "you", displayName = "You"),
    TeamUser(id = "user-guest", handle = "guest", displayName = "Guest"),
)
