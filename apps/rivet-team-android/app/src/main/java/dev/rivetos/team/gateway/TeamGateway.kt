package dev.rivetos.team.gateway

import dev.rivetos.team.domain.Persona
import dev.rivetos.team.domain.TeamMessage

/**
 * Session + memory surface matching `@rivetos/gateway-client` RivetGateway
 * (HTTP /api/sessions, WS /api/sessions/ws, GET /api/memory/search).
 * This slice is stubbed; keep method names stable for a live client later.
 */
interface TeamGateway {
    val baseUrl: String
    fun listPersonas(userId: String): List<Persona>
    fun sessionMessages(sessionId: String): List<TeamMessage>
    fun postMessage(sessionId: String, text: String, userId: String)
    fun watch(sessionId: String, onEvent: (GatewayEvent) -> Unit): () -> Unit
    fun memorySearch(userId: String, q: String): List<String>
}

sealed class GatewayEvent {
    data class Message(val message: TeamMessage) : GatewayEvent()
    data class Working(val label: String) : GatewayEvent()
    data object Done : GatewayEvent()
}
