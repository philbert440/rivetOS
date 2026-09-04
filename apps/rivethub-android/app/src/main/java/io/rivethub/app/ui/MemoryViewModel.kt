package io.rivethub.app.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.rivethub.app.AppContainer
import io.rivethub.app.gateway.Gateway
import io.rivethub.app.gateway.GatewayException
import io.rivethub.app.gateway.WikiIndexEntry
import io.rivethub.app.gateway.WikiPageResponse
import io.rivethub.app.plane.MemoryTab
import io.rivethub.app.plane.datahubNode
import io.rivethub.app.transport.NodeRef
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Web MemoryPage debounces the search box 200 ms. */
private const val SEARCH_DEBOUNCE_MS = 200L

/**
 * The native Memory hub (web MemoryHubPage + pages/memory.tsx): topic index
 * and search over datahub's `GET /api/wiki`, plus the open topic page. One
 * activity-scoped instance — the hub and the topic screen share it, and a
 * topic is only ever pushed over the hub.
 *
 * Datahub resolution mirrors the web useWikiEndpoint: the mesh node named
 * datahub when the roster lists one, else the entry node (Android enrolls at
 * datahub — NodeTransport.entry()). A failure to load is the "Point RivetHub
 * at datahub" pointer state, never a spinner.
 */
class MemoryViewModel(private val c: AppContainer) : ViewModel() {

    data class UiState(
        val tab: MemoryTab = MemoryTab.Search,
        val query: String = "",
        val topics: List<WikiIndexEntry> = emptyList(),
        val total: Int = 0,
        val loading: Boolean = false,
        /** True after the first load attempt settled (error included). */
        val loaded: Boolean = false,
        val error: String? = null,
    )

    data class TopicState(
        val slug: String = "",
        val page: WikiPageResponse? = null,
        val loading: Boolean = false,
        val error: String? = null,
        /** 404 — the web red-link state. */
        val notFound: Boolean = false,
    )

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    private val _topic = MutableStateFlow(TopicState())
    val topic: StateFlow<TopicState> = _topic.asStateFlow()

    private var gateway: Gateway? = null
    private var loadGen = 0
    private var searchJob: Job? = null

    /** (Re)bind the wiki gateway from the mesh roster; kicks the first load. */
    fun bind(nodes: List<NodeRef>) {
        val g = datahubNode(nodes)?.let { c.transport.gateway(it) } ?: c.transport.entry()
        if (g === gateway && _state.value.loaded) return
        val first = gateway == null
        gateway = g
        if (first || !_state.value.loaded) load()
    }

    fun setTab(tab: MemoryTab) {
        if (_state.value.tab == tab) return
        searchJob?.cancel()
        // Web hub-view change clears the search box.
        _state.update { it.copy(tab = tab, query = "") }
        load()
    }

    fun setQuery(q: String) {
        _state.update { it.copy(query = q) }
        searchJob?.cancel()
        searchJob = viewModelScope.launch {
            delay(SEARCH_DEBOUNCE_MS)
            load()
        }
    }

    fun refresh() = load()

    private fun load() {
        val g = gateway ?: return
        val gen = ++loadGen
        val q = _state.value.query.trim()
        _state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            try {
                // Web: search { q, limit: 50 }; index { limit: 500 }.
                val res = if (q.isNotEmpty()) g.wikiSearch(q, 50) else g.wikiPages(500)
                if (gen != loadGen) return@launch
                _state.update {
                    it.copy(topics = res.topics, total = res.total, loading = false, loaded = true, error = null)
                }
            } catch (e: Exception) {
                if (gen != loadGen) return@launch
                _state.update {
                    it.copy(topics = emptyList(), total = 0, loading = false, loaded = true, error = e.message ?: "unreachable")
                }
            }
        }
    }

    fun openTopic(slug: String) {
        val cur = _topic.value
        if (cur.slug == slug && (cur.page != null || cur.loading)) return
        val g = gateway ?: run {
            _topic.value = TopicState(slug = slug, error = "unreachable")
            return
        }
        _topic.value = TopicState(slug = slug, loading = true)
        viewModelScope.launch {
            try {
                val page = g.wikiTopic(slug)
                if (_topic.value.slug == slug) _topic.value = TopicState(slug = slug, page = page)
            } catch (e: Exception) {
                if (_topic.value.slug == slug) {
                    _topic.value = TopicState(
                        slug = slug,
                        error = e.message ?: "unreachable",
                        notFound = (e as? GatewayException)?.status == 404,
                    )
                }
            }
        }
    }
}
