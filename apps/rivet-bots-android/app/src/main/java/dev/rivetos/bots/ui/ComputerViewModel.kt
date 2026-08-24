package dev.rivetos.bots.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.rivetos.bots.AppContainer
import dev.rivetos.bots.data.DenFrame
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
class ComputerViewModel(private val c: AppContainer, val bot: Bot, private val sessionId: String) : ViewModel() {
    data class UiState(
        val room: RoomState? = null,
        val ws: WsStatus = WsStatus.CONNECTING,
        val loaded: Boolean = false,
    )

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()
    private var watch: Closeable? = null
    private var refetch: Job? = null

    init {
        val gw = c.gateways.get(bot.denUrl)
        viewModelScope.launch {
            val room = gw.denState(sessionId)
            _state.update { it.copy(room = room ?: it.room, loaded = true) }
        }
        watch = gw.watchDen(sessionId, onFrame = { f ->
            when (f) {
                is DenFrame.Snapshot -> {
                    val room = f.rooms[sessionId] ?: f.rooms.values.firstOrNull()
                    _state.update { it.copy(room = room ?: it.room, loaded = true) }
                }
                is DenFrame.Event -> {
                    // Events are cheap to coalesce: re-read the reduced state shortly after.
                    refetch?.cancel()
                    refetch = viewModelScope.launch {
                        delay(250)
                        gw.denState(sessionId)?.let { r -> _state.update { it.copy(room = r, loaded = true) } }
                    }
                }
            }
        }, onStatus = { s -> _state.update { it.copy(ws = s) } })
    }

    override fun onCleared() { watch?.close() }
}
