package dev.rivetos.bots.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.rivetos.bots.AppContainer
import dev.rivetos.bots.data.BotRepository
import dev.rivetos.bots.data.Prefs
import dev.rivetos.bots.data.SessionFrame
import dev.rivetos.bots.domain.Bot
import dev.rivetos.bots.domain.BotPreview
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.Closeable

class HomeViewModel(private val c: AppContainer) : ViewModel() {
    data class UiState(
        val bots: List<Bot> = emptyList(),
        val previews: Map<String, BotPreview> = emptyMap(),
        val loading: Boolean = false,
        val loadedOnce: Boolean = false,
        val error: String? = null,
        val prefs: Prefs = Prefs(),
        val query: String = "",
    ) {
        val visible: List<Bot> get() = bots.filter { it.id !in prefs.hidden }.filter { b ->
            query.isBlank() || b.displayName.contains(query, true) || b.nodeLabel.contains(query, true) ||
                (previews[b.id]?.text?.contains(query, true) ?: false)
        }
        val pinned: List<Bot> get() = visible.filter { it.id in prefs.pinned }
        /** Most recent thread first, then online before offline, then by name. */
        val ordered: List<Bot> get() = visible.sortedWith(
            compareByDescending<Bot> { previews[it.id]?.ts ?: 0L }.thenByDescending { it.online }
                .thenBy { it.displayName }.thenBy { it.nodeLabel },
        )
        fun unread(b: Bot): Boolean {
            val p = previews[b.id] ?: return false
            return p.role == "assistant" && p.ts > (prefs.lastSeen[b.id] ?: 0L)
        }
    }

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    private val watches = HashMap<String, Closeable>()

    init {
        viewModelScope.launch {
            c.settings.prefs.collect { p ->
                c.setStrictHostnames(p.strictHostnames)
                _state.update { it.copy(prefs = p) }
            }
        }
        refresh()
    }

    fun sessionIdFor(bot: Bot): String =
        _state.value.prefs.sessionOverrides[bot.id] ?: bot.defaultSessionId(c.identity.deviceTag())

    fun setQuery(q: String) = _state.update { it.copy(query = q) }

    fun refresh() {
        if (_state.value.loading) return
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
            try {
                val p = c.settings.snapshot()
                if (p.entryUrl.isBlank()) throw BotRepository.DiscoveryFailed("No entry node configured.")
                val bots = c.bots.discover(p.entryUrl, p.extraNodes)
                _state.update { it.copy(bots = bots, loadedOnce = true) }
                openWatches(bots)
                loadPreviews(bots)
            } catch (e: Exception) {
                _state.update { it.copy(error = e.message ?: BotRepository.friendly(e), loadedOnce = true) }
            } finally {
                _state.update { it.copy(loading = false) }
            }
        }
    }

    /** Re-read the thread tail for one bot (after a chat closes, a new conversation, …). */
    fun refreshPreview(bot: Bot) {
        viewModelScope.launch {
            c.bots.preview(bot, sessionIdFor(bot))?.let { p -> _state.update { it.copy(previews = it.previews + (bot.id to p)) } }
        }
    }

    private suspend fun loadPreviews(bots: List<Bot>) = coroutineScope {
        val found = bots.filter { it.online }.map { b ->
            async { c.bots.preview(b, sessionIdFor(b))?.let { b.id to it } }
        }.awaitAll().filterNotNull()
        _state.update { it.copy(previews = it.previews + found) }
    }

    /** One all-sessions WS per online node keeps the list live without polling. */
    private fun openWatches(bots: List<Bot>) {
        val urls = bots.filter { it.online }.map { it.denUrl }.toSet()
        (watches.keys - urls).forEach { watches.remove(it)?.close() }
        for (url in urls - watches.keys) {
            watches[url] = c.gateways.get(url).watchSessions(null, onFrame = { f ->
                if (f is SessionFrame.Message) {
                    val m = f.message
                    val bot = _state.value.bots.firstOrNull { it.denUrl == url && sessionIdFor(it) == m.sessionId } ?: return@watchSessions
                    _state.update { it.copy(previews = it.previews + (bot.id to BotPreview(m.text, m.ts, m.role))) }
                }
            })
        }
    }

    fun togglePin(bot: Bot) { viewModelScope.launch { c.settings.togglePin(bot.id) } }
    fun setHidden(bot: Bot, hidden: Boolean) { viewModelScope.launch { c.settings.setHidden(bot.id, hidden) } }
    fun unhideAll() { viewModelScope.launch { c.settings.unhideAll() } }
    fun addNode(url: String) { viewModelScope.launch { c.settings.addExtraNode(url); refresh() } }
    fun markSeen(bot: Bot, ts: Long) { viewModelScope.launch { c.settings.markSeen(bot.id, ts) } }

    override fun onCleared() { watches.values.forEach { it.close() }; watches.clear() }
}
