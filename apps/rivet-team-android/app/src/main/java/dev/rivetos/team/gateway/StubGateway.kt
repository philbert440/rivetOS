package dev.rivetos.team.gateway

import android.os.Handler
import android.os.Looper
import dev.rivetos.team.domain.LOCAL_USER_ID
import dev.rivetos.team.domain.Persona
import dev.rivetos.team.domain.SAMPLE_PERSONAS
import dev.rivetos.team.domain.TeamMessage
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList

class StubGateway(
    override val baseUrl: String = "http://127.0.0.1:5174",
) : TeamGateway {
    private val threads = mutableMapOf<String, MutableList<TeamMessage>>()
    private val watchers = mutableMapOf<String, CopyOnWriteArrayList<(GatewayEvent) -> Unit>>()
    private val memory = mutableListOf<String>()
    private val main = Handler(Looper.getMainLooper())

    override fun listPersonas(userId: String): List<Persona> = SAMPLE_PERSONAS

    override fun sessionMessages(sessionId: String): List<TeamMessage> =
        threads[sessionId]?.toList() ?: emptyList()

    override fun postMessage(sessionId: String, text: String, userId: String) {
        val persona = SAMPLE_PERSONAS.firstOrNull { it.threadId == sessionId }
        val user = TeamMessage(
            id = UUID.randomUUID().toString(),
            sessionId = sessionId,
            userId = userId,
            personaId = persona?.id ?: sessionId,
            nodeId = persona?.nodeId ?: "local-node",
            role = "user",
            text = text,
            ts = System.currentTimeMillis(),
        )
        threads.getOrPut(sessionId) { mutableListOf() }.add(user)
        emit(sessionId, GatewayEvent.Message(user))
        emit(sessionId, GatewayEvent.Working("${persona?.name ?: "Persona"} is working…"))
        main.postDelayed({
            val reply = TeamMessage(
                id = UUID.randomUUID().toString(),
                sessionId = sessionId,
                userId = userId,
                personaId = persona?.id ?: sessionId,
                nodeId = persona?.nodeId ?: "local-node",
                role = "assistant",
                text = stubReply(persona?.name ?: "Persona", text),
                ts = System.currentTimeMillis(),
            )
            threads.getOrPut(sessionId) { mutableListOf() }.add(reply)
            memory.add("${persona?.name}: ${text.take(160)}")
            emit(sessionId, GatewayEvent.Done)
            emit(sessionId, GatewayEvent.Message(reply))
        }, 450)
    }

    override fun watch(sessionId: String, onEvent: (GatewayEvent) -> Unit): () -> Unit {
        val list = watchers.getOrPut(sessionId) { CopyOnWriteArrayList() }
        list.add(onEvent)
        return { list.remove(onEvent) }
    }

    override fun memorySearch(userId: String, q: String): List<String> {
        val needle = q.lowercase()
        if (needle.isBlank()) return emptyList()
        return memory.filter { it.lowercase().contains(needle) }
    }

    private fun emit(sessionId: String, event: GatewayEvent) {
        watchers[sessionId]?.forEach { it(event) }
    }

    private fun stubReply(name: String, userText: String): String {
        val clipped = userText.trim().replace(Regex("\\s+"), " ").take(220)
        return when (name) {
            "Summarizer" -> "Brief: $clipped\n\n• Point taken.\n• Next: wire the live gateway."
            "Informatics" -> "facts:\n- input: \"$clipped\"\n- status: captured (stub)"
            else -> "I would look into “$clipped”. Stub gateway — same contract as Hub, no live model yet."
        }
    }

    companion object {
        val shared = StubGateway()
        const val USER = LOCAL_USER_ID
    }
}
