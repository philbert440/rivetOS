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

    /** Live watches keyed by "url|identityGen|strict" so a cert/TLS change retires the old sockets. */
    private val watches = HashMap<String, Closeable>()
    private var refreshAgain = false
    /** Bumped by shutdown(); a refresh that started before the bump must not publish. */
    @Volatile private var refreshGen = 0

    init {
        viewModelScope.launch {
            c.settings.prefs.collect { p ->
                c.setStrictHostnames(p.strictHostnames)
                _state.update { it.copy(prefs = p) }
                if (p.entryUrl.isBlank()) closeWatches()
            }
        }
    }

    fun sessionIdFor(bot: Bot, prefs: Prefs = _state.value.prefs): String =
        prefs.sessionOverrides[bot.id] ?: bot.defaultSessionId(c.identity.deviceTag())

    fun setQuery(q: String) = _state.update { it.copy(query = q) }

    fun refresh() {
        if (_state.value.loading) { refreshAgain = true; return }
        viewModelScope.launch {
            val gen = refreshGen
            _state.update { it.copy(loading = true, error = null) }
            try {
                val p = c.settings.snapshot() // never the empty default — prefs may not have emitted yet
                _state.update { it.copy(prefs = p) }
                if (p.entryUrl.isBlank()) throw BotRepository.DiscoveryFailed("No entry node configured.")
                if (!c.identity.hasIdentity()) throw BotRepository.DiscoveryFailed("No device certificate — sign in again.")
                if (c.identity.summary() == null) throw BotRepository.DiscoveryFailed("Device certificate didn't load: ${c.identity.lastError ?: "unknown error"}. Re-import it in Settings.")
                val bots = c.bots.discover(p.entryUrl, p.extraNodes)
                if (gen != refreshGen) return@launch // signed out mid-scan: publish nothing, open nothing
                _state.update { if (gen != refreshGen) it else it.copy(bots = bots, loadedOnce = true) }
                if (gen != refreshGen) return@launch
                openWatches(bots, p, gen)
                loadPreviews(bots, p, gen)
            } catch (e: Exception) {
                if (gen != refreshGen) return@launch
                _state.update { it.copy(error = e.message ?: BotRepository.friendly(e), loadedOnce = true) }
            } finally {
                if (gen == refreshGen) {
                    _state.update { it.copy(loading = false) }
                    if (refreshAgain) { refreshAgain = false; refresh() }
                } else refreshAgain = false
            }
        }
    }

    /** Re-read the thread tail for one bot (after a chat closes, a new conversation, …). */
    fun refreshPreview(bot: Bot) {
        viewModelScope.launch {
            val p = c.settings.snapshot()
            c.bots.preview(bot, sessionIdFor(bot, p))?.let { pv -> _state.update { it.copy(previews = it.previews + (bot.id to pv)) } }
        }
    }

    private suspend fun loadPreviews(bots: List<Bot>, p: Prefs, gen: Int) = coroutineScope {
        val found = bots.filter { it.online }.map { b ->
            async { c.bots.preview(b, sessionIdFor(b, p))?.let { b.id to it } }
        }.awaitAll().filterNotNull()
        _state.update { if (gen != refreshGen) it else it.copy(previews = it.previews + found) }
    }

    /** One all-sessions WS per online node keeps the list live without polling. */
    private fun openWatches(bots: List<Bot>, p: Prefs, gen: Int) {
        if (gen != refreshGen) return // signed out between the scan and here
        val wanted = bots.filter { it.online }.map { it.denUrl }.toSet()
            .associateBy { url -> "$url|${c.identity.generation()}|${p.strictHostnames}" }
        (watches.keys - wanted.keys).forEach { watches.remove(it)?.close() }
        for ((key, url) in wanted) {
            if (key in watches) continue
            watches[key] = c.gateways.get(url).watchSessions(null, onFrame = { f ->
                if (f is SessionFrame.Message) {
                    val m = f.message
                    val prefs = _state.value.prefs
                    val bot = _state.value.bots.firstOrNull { it.denUrl == url && sessionIdFor(it, prefs) == m.sessionId } ?: return@watchSessions
                    _state.update { it.copy(previews = it.previews + (bot.id to BotPreview(m.text, m.ts, m.role))) }
                }
            })
        }
    }

    private fun closeWatches() { watches.values.forEach { it.close() }; watches.clear() }

    /** Sign-out: drop sockets, roster, and pooled TLS clients built on the old identity. */
    fun shutdown() {
        refreshGen++
        closeWatches()
        c.gateways.clear()
        c.http.clear()
        _state.update { UiState(prefs = it.prefs) }
    }

    fun togglePin(bot: Bot) { viewModelScope.launch { c.settings.togglePin(bot.id) } }
    fun setHidden(bot: Bot, hidden: Boolean) { viewModelScope.launch { c.settings.setHidden(bot.id, hidden) } }
    fun unhideAll() { viewModelScope.launch { c.settings.unhideAll() } }
    fun addNode(url: String) { viewModelScope.launch { c.settings.addExtraNode(url); refresh() } }

    override fun onCleared() { closeWatches() }
}
