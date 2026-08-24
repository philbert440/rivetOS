package dev.rivetos.bots.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.rivetos.bots.AppContainer
import dev.rivetos.bots.data.BotRepository
import dev.rivetos.bots.data.DenFrame
import dev.rivetos.bots.data.GatewayException
import dev.rivetos.bots.data.RoomState
import dev.rivetos.bots.data.WsStatus
import dev.rivetos.bots.domain.Bot
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.Closeable

/** The bot's "computer": its den RoomState for this thread, live over /api/events/ws. */
class ComputerViewModel(private val c: AppContainer, val bot: Bot, val sessionId: String) : ViewModel() {
    data class UiState(
        val room: RoomState? = null,
        val ws: WsStatus = WsStatus.CONNECTING,
        val loaded: Boolean = false,
        val error: String? = null,
    )

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()
    private var watch: Closeable? = null
    private var refetch: Job? = null

    init {
        val gw = c.gateways.get(bot.denUrl)
        load()
        watch = gw.watchDen(sessionId, onFrame = { f ->
            when (f) {
                // Only this thread's room — never another session's screen.
                is DenFrame.Snapshot -> _state.update { val r = f.rooms[sessionId]; it.copy(room = r ?: it.room, loaded = true, error = if (r != null) null else it.error) }
                is DenFrame.Event -> {
                    if (f.session.isNotBlank() && f.session != sessionId) return@watchDen
                    // Events are cheap to coalesce: re-read the reduced state shortly after.
                    refetch?.cancel()
                    refetch = viewModelScope.launch { delay(250); load() }
                }
            }
        }, onStatus = { s -> _state.update { it.copy(ws = s) } })
    }

    private fun load() {
        viewModelScope.launch {
            try {
                val room = c.gateways.get(bot.denUrl).denState(sessionId)
                _state.update { it.copy(room = room ?: it.room, loaded = true, error = null) }
            } catch (e: GatewayException) {
                if (e.status == 404) _state.update { it.copy(loaded = true, error = null) } // no room yet — not an error
                else _state.update { it.copy(loaded = true, error = BotRepository.friendly(e)) }
            } catch (e: Exception) {
                _state.update { it.copy(loaded = true, error = BotRepository.friendly(e)) }
            }
        }
    }

    override fun onCleared() { watch?.close() }
}
